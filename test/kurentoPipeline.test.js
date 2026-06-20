// test/kurentoPipeline.test.js
const { test } = require('node:test');
const assert = require('node:assert');

// Minimal fake kurento-client. create(type) returns an object whose type we record.
function makeFakeKurento() {
  const created = [];
  const pipeline = {
    create: async (type) => {
      const obj = {
        type,
        connectedTo: [],
        released: false,
        connect: async (sink) => { obj.connectedTo.push(sink); },
        release: async () => { obj.released = true; },
        play: async () => {},
        // WebRtcEndpoint API used by signaling later (stubbed here)
        processOffer: async () => 'ANSWER_SDP',
        gatherCandidates: async () => {},
        on: () => {},
        addIceCandidate: async () => {},
      };
      created.push(obj);
      return obj;
    },
  };
  const client = {
    create: async (type) => {
      if (type === 'MediaPipeline') return pipeline;
      throw new Error('unexpected top-level create: ' + type);
    },
    _pipeline: pipeline,
    _created: created,
  };
  return client;
}

const { KurentoPipeline } = require('../src/kurentoPipeline');

test('ensurePlayer builds pipeline+player+passthrough exactly once', async () => {
  const client = makeFakeKurento();
  const kp = new KurentoPipeline({ client, rtmpSource: 'rtmp://localhost/live/stream' });

  await kp.ensurePlayer();
  await kp.ensurePlayer(); // second call must NOT rebuild

  const types = client._created.map((o) => o.type);
  assert.deepStrictEqual(types, ['PlayerEndpoint', 'PassThrough']);
});

test('addViewer creates a WebRtcEndpoint and connects passthrough to it', async () => {
  const client = makeFakeKurento();
  const kp = new KurentoPipeline({ client, rtmpSource: 'rtmp://localhost/live/stream' });
  await kp.ensurePlayer();

  const ep = await kp.addViewer('viewer-1');
  assert.strictEqual(ep.type, 'WebRtcEndpoint');

  const passthrough = client._created.find((o) => o.type === 'PassThrough');
  assert.ok(passthrough.connectedTo.includes(ep), 'passthrough should connect to the viewer endpoint');
});

test('removeViewer releases only that endpoint', async () => {
  const client = makeFakeKurento();
  const kp = new KurentoPipeline({ client, rtmpSource: 'rtmp://localhost/live/stream' });
  await kp.ensurePlayer();
  const ep = await kp.addViewer('viewer-1');

  await kp.removeViewer('viewer-1');
  assert.strictEqual(ep.released, true);

  const player = client._created.find((o) => o.type === 'PlayerEndpoint');
  assert.strictEqual(player.released, false, 'player must survive viewer removal');
});

test('concurrent ensurePlayer builds the pipeline only once', async () => {
  const client = makeFakeKurento();
  const kp = new KurentoPipeline({ client, rtmpSource: 'rtmp://localhost/live/stream' });

  // Fire many ensurePlayer calls on the same tick.
  await Promise.all(Array.from({ length: 5 }, () => kp.ensurePlayer()));

  const players = client._created.filter((o) => o.type === 'PlayerEndpoint');
  const passthroughs = client._created.filter((o) => o.type === 'PassThrough');
  assert.strictEqual(players.length, 1, 'exactly one PlayerEndpoint');
  assert.strictEqual(passthroughs.length, 1, 'exactly one PassThrough');
});
