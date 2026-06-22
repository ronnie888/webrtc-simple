// src/kurentoPipeline.js
// Owns the single shared Kurento pipeline. No WebSocket knowledge here.
class KurentoPipeline {
  constructor({ client, rtmpSource }) {
    this.client = client;
    this.rtmpSource = rtmpSource;
    this.pipeline = null;
    this.player = null;
    this.passthrough = null;
    this.viewers = new Map(); // id -> WebRtcEndpoint
    this._initPromise = null;
    this.playerDead = false;
  }

  // Idempotent + concurrency-safe: build pipeline+player+passthrough once,
  // share one in-flight build among concurrent callers, reuse forever.
  async ensurePlayer() {
    if (this.pipeline && this.player && this.passthrough) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      const pipeline = await this.client.create('MediaPipeline');
      const player = await pipeline.create('PlayerEndpoint', { uri: this.rtmpSource });
      const passthrough = await pipeline.create('PassThrough');
      await player.connect(passthrough);
      await player.play();
      // Register lifecycle events so we know when the RTMP pull dies.
      player.on('Error', () => { this.playerDead = true; });
      player.on('EndOfStream', () => { this.playerDead = true; });
      // Commit only after every step succeeded.
      this.pipeline = pipeline;
      this.player = player;
      this.passthrough = passthrough;
    })();

    try {
      await this._initPromise;
    } catch (err) {
      this._initPromise = null; // allow retry on next call
      throw err;
    }
  }

  // Tear down the dead pipeline and rebuild so the next viewer gets a live feed.
  // NOTE: releasing the pipeline also invalidates any existing viewer WebRtcEndpoints
  // that were attached to it. For this single-source stack that is acceptable —
  // if the RTMP source was dead, those viewers were getting no video anyway.
  async rebuildPlayer() {
    const oldPipeline = this.pipeline;
    const oldPlayer = this.player;
    this.pipeline = null;
    this.player = null;
    this.passthrough = null;
    this._initPromise = null;
    this.playerDead = false;
    try { if (oldPlayer) await oldPlayer.release(); } catch { /* best effort */ }
    try { if (oldPipeline) await oldPipeline.release(); } catch { /* best effort */ }
    await this.ensurePlayer();
  }

  async addViewer(id) {
    // If the PlayerEndpoint signalled failure, rebuild before attaching the viewer
    // so the viewer gets a fresh pipeline with a live RTMP pull.
    if (this.playerDead) await this.rebuildPlayer();
    try {
      return await this._attachViewer(id);
    } catch (err) {
      // The shared MediaPipeline can vanish from Kurento (process restart, OOM,
      // GC) WITHOUT firing the PlayerEndpoint 'Error' event, so playerDead stays
      // false and the stale ref throws "MediaPipeline not found" / "MediaObject
      // not found". Detect that, rebuild once, and retry so viewers self-heal
      // instead of every connect failing forever.
      if (this._isStalePipeline(err)) {
        await this.rebuildPlayer();
        return await this._attachViewer(id);
      }
      throw err;
    }
  }

  async _attachViewer(id) {
    await this.ensurePlayer();
    const endpoint = await this.pipeline.create('WebRtcEndpoint');
    await this.passthrough.connect(endpoint);
    this.viewers.set(id, endpoint);
    return endpoint;
  }

  _isStalePipeline(err) {
    const m = String((err && err.message) || err || '');
    return /not found/i.test(m) || /MediaObject/i.test(m) || /MediaPipeline/i.test(m);
  }

  async removeViewer(id) {
    const ep = this.viewers.get(id);
    if (!ep) return;
    this.viewers.delete(id);
    await ep.release();
  }
}

module.exports = { KurentoPipeline };
