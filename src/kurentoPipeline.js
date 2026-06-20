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
  }

  // Idempotent: build pipeline+player+passthrough once, reuse forever.
  async ensurePlayer() {
    if (this.pipeline && this.player && this.passthrough) return;
    this.pipeline = await this.client.create('MediaPipeline');
    this.player = await this.pipeline.create('PlayerEndpoint', { uri: this.rtmpSource });
    this.passthrough = await this.pipeline.create('PassThrough');
    await this.player.connect(this.passthrough);
    await this.player.play();
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
