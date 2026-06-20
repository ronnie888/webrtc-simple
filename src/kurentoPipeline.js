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

  async addViewer(id) {
    await this.ensurePlayer();
    const endpoint = await this.pipeline.create('WebRtcEndpoint');
    await this.passthrough.connect(endpoint);
    this.viewers.set(id, endpoint);
    return endpoint;
  }

  async removeViewer(id) {
    const ep = this.viewers.get(id);
    if (!ep) return;
    this.viewers.delete(id);
    await ep.release();
  }
}

module.exports = { KurentoPipeline };
