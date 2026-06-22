// src/kurentoPool.js
// Shards viewers across N KurentoPipeline instances (one per Kurento process)
// using least-loaded selection, so connect setup parallelizes across instances
// instead of serializing in one Kurento. Wraps the existing KurentoPipeline.
class KurentoPool {
  constructor({ pipelines }) {
    if (!pipelines || pipelines.length === 0) throw new Error('KurentoPool needs >=1 pipeline');
    this.pipelines = pipelines;
    this.owner = new Map(); // viewerId -> pipeline (so removeViewer routes correctly)
  }

  // The instance with the fewest current viewers. Ties -> first in order.
  pickLeastLoaded() {
    let best = this.pipelines[0];
    for (const p of this.pipelines) {
      if (p.viewers.size < best.viewers.size) best = p;
    }
    return best;
  }

  async ensureAll() {
    await Promise.all(this.pipelines.map((p) => p.ensurePlayer()));
  }

  async addViewer(id) {
    const pipeline = this.pickLeastLoaded();
    this.owner.set(id, pipeline);
    try {
      return await pipeline.addViewer(id);
    } catch (err) {
      this.owner.delete(id); // didn't actually attach
      throw err;
    }
  }

  async removeViewer(id) {
    const pipeline = this.owner.get(id);
    this.owner.delete(id);
    if (pipeline) await pipeline.removeViewer(id);
  }

  totalViewers() {
    return this.pipelines.reduce((s, p) => s + p.viewers.size, 0);
  }

  perInstanceCounts() {
    return this.pipelines.map((p) => p.viewers.size);
  }
}

module.exports = { KurentoPool };
