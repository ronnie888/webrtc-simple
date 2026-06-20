// test/signaling.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { handleConnection } = require('../src/signaling');

// Fake ws: records sent messages, lets test push incoming ones.
function makeFakeWs() {
  const sent = [];
  const handlers = {};
  return {
    sent,
    send: (str) => sent.push(JSON.parse(str)),
    on: (evt, cb) => { handlers[evt] = cb; },
    emit: (evt, data) => handlers[evt] && handlers[evt](data),
    close: () => handlers.close && handlers.close(),
  };
}

// Fake pipeline matching KurentoPipeline's surface used by signaling.
function makeFakePipeline() {
  const endpoint = {
    processOffer: async () => 'ANSWER_SDP',
    gatherCandidates: async () => {},
    addIceCandidate: async () => { endpoint.addedIce = true; },
    on: (evt, cb) => { endpoint.onIce = cb; }, // OnIceCandidate
  };
  const removed = [];
  return {
    endpoint,
    removed,
    addViewer: async () => endpoint,
    removeViewer: async (id) => { removed.push(id); },
  };
}

test('on watch: sends iceServers then answer for an offer', async () => {
  const ws = makeFakeWs();
  const pipeline = makeFakePipeline();
  handleConnection(ws, { pipeline, iceServers: [{ urls: 'stun:x' }] });

  ws.emit('message', JSON.stringify({ id: 'watch' }));
  await new Promise((r) => setImmediate(r));
  ws.emit('message', JSON.stringify({ id: 'offer', sdp: 'OFFER_SDP' }));
  await new Promise((r) => setImmediate(r));

  const ids = ws.sent.map((m) => m.id);
  assert.ok(ids.includes('iceServers'), 'should send iceServers');
  const answer = ws.sent.find((m) => m.id === 'answer');
  assert.strictEqual(answer.sdp, 'ANSWER_SDP');
});

test('on ice from viewer: forwards candidate to endpoint', async () => {
  const ws = makeFakeWs();
  const pipeline = makeFakePipeline();
  handleConnection(ws, { pipeline, iceServers: [] });

  ws.emit('message', JSON.stringify({ id: 'watch' }));
  await new Promise((r) => setImmediate(r));
  ws.emit('message', JSON.stringify({ id: 'offer', sdp: 'OFFER_SDP' }));
  await new Promise((r) => setImmediate(r));
  ws.emit('message', JSON.stringify({ id: 'ice', candidate: { candidate: 'x' } }));
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(pipeline.endpoint.addedIce, true);
});

test('on close: releases the viewer', async () => {
  const ws = makeFakeWs();
  const pipeline = makeFakePipeline();
  handleConnection(ws, { pipeline, iceServers: [] });

  ws.emit('message', JSON.stringify({ id: 'watch' }));
  await new Promise((r) => setImmediate(r));
  ws.close();
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(pipeline.removed.length, 1, 'one viewer released on close');
});
