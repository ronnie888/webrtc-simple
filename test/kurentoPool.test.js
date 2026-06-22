const { test } = require('node:test');
const assert = require('node:assert');
const { KurentoPool } = require('../src/kurentoPool');

// Fake pipeline matching KurentoPipeline's surface that the pool uses.
function makeFakePipeline(label) {
  const viewers = new Map();
  return {
    label,
    viewers,
    ensurePlayerCalls: 0,
    async ensurePlayer() { this.ensurePlayerCalls++; },
    async addViewer(id) { const ep = { id, label }; viewers.set(id, ep); return ep; },
    async removeViewer(id) { viewers.delete(id); },
  };
}

test('pickLeastLoaded returns the instance with fewest viewers', () => {
  const a = makeFakePipeline('a'), b = makeFakePipeline('b'), c = makeFakePipeline('c');
  a.viewers.set('x', {}); a.viewers.set('y', {}); // a=2
  c.viewers.set('z', {});                          // c=1, b=0
  const pool = new KurentoPool({ pipelines: [a, b, c] });
  assert.strictEqual(pool.pickLeastLoaded(), b, 'b has the fewest (0)');
});

test('addViewer puts viewer on least-loaded and returns endpoint', async () => {
  const a = makeFakePipeline('a'), b = makeFakePipeline('b');
  a.viewers.set('x', {}); // a=1, b=0
  const pool = new KurentoPool({ pipelines: [a, b] });
  const ep = await pool.addViewer('v1');
  assert.strictEqual(ep.label, 'b', 'went to least-loaded b');
  assert.strictEqual(b.viewers.size, 1);
});

test('addViewer spreads viewers roughly evenly across instances', async () => {
  const a = makeFakePipeline('a'), b = makeFakePipeline('b'), c = makeFakePipeline('c');
  const pool = new KurentoPool({ pipelines: [a, b, c] });
  for (let i = 0; i < 9; i++) await pool.addViewer('v' + i);
  assert.strictEqual(a.viewers.size, 3);
  assert.strictEqual(b.viewers.size, 3);
  assert.strictEqual(c.viewers.size, 3);
});

test('removeViewer routes to the instance that owns the viewer', async () => {
  const a = makeFakePipeline('a'), b = makeFakePipeline('b');
  a.viewers.set('x', {}); // a=1 so first add goes to b
  const pool = new KurentoPool({ pipelines: [a, b] });
  await pool.addViewer('v1');            // -> b
  assert.strictEqual(b.viewers.size, 1);
  await pool.removeViewer('v1');
  assert.strictEqual(b.viewers.size, 0, 'removed from the OWNING instance (b)');
});

test('totalViewers and perInstanceCounts report correctly', async () => {
  const a = makeFakePipeline('a'), b = makeFakePipeline('b');
  const pool = new KurentoPool({ pipelines: [a, b] });
  await pool.addViewer('v1'); await pool.addViewer('v2'); await pool.addViewer('v3');
  assert.strictEqual(pool.totalViewers(), 3);
  const counts = pool.perInstanceCounts();
  assert.strictEqual(counts.reduce((s, n) => s + n, 0), 3);
});

test('ensureAll calls ensurePlayer on every instance', async () => {
  const a = makeFakePipeline('a'), b = makeFakePipeline('b');
  const pool = new KurentoPool({ pipelines: [a, b] });
  await pool.ensureAll();
  assert.strictEqual(a.ensurePlayerCalls, 1);
  assert.strictEqual(b.ensurePlayerCalls, 1);
});
