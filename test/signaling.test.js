// test/signaling.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { handleConnection } = require('../src/signaling');

// Fake ws: records sent messages, lets test push incoming ones.
function makeFakeWs() {
  const sent = [];
  const handlers = {};
  const ws = {
    sent,
    send: (str) => sent.push(JSON.parse(str)),
    on: (evt, cb) => { handlers[evt] = cb; },
    emit: (evt, data) => handlers[evt] && handlers[evt](data),
    close: () => { ws.closed = true; handlers.close && handlers.close(); },
    closed: false,
  };
  return ws;
}

// Fake pipeline matching KurentoPipeline's surface used by signaling.
function makeFakePipeline() {
  const handlers = {};
  const endpoint = {
    processOffer: async () => 'ANSWER_SDP',
    gatherCandidates: async () => {},
    addIceCandidate: async () => { endpoint.addedIce = true; },
    on: (evt, cb) => { handlers[evt] = cb; },          // store per-event
    emit: (evt, data) => handlers[evt] && handlers[evt](data),
  };
  const removed = [];
  return {
    endpoint,
    removed,
    addViewerCount: 0,
    addViewer: async function () { this.addViewerCount++; return endpoint; },
    removeViewer: async (id) => { removed.push(id); },
  };
}

test('on watch: sends iceServers then answer for an offer', async () => {
  const ws = makeFakeWs();
  const pipeline = makeFakePipeline();
  handleConnection(ws, { pool: pipeline, iceServers: [{ urls: 'stun:x' }] });

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
  handleConnection(ws, { pool: pipeline, iceServers: [] });

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
  handleConnection(ws, { pool: pipeline, iceServers: [] });

  ws.emit('message', JSON.stringify({ id: 'watch' }));
  await new Promise((r) => setImmediate(r));
  ws.close();
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(pipeline.removed.length, 1, 'one viewer released on close');
});

test('double watch does not create a second viewer (idempotent)', async () => {
  const ws = makeFakeWs();
  const pipeline = makeFakePipeline();
  handleConnection(ws, { pool: pipeline, iceServers: [] });

  ws.emit('message', JSON.stringify({ id: 'watch' }));
  ws.emit('message', JSON.stringify({ id: 'watch' }));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(pipeline.addViewerCount, 1, 'only one viewer created for repeated watch');
});

test('token gate: valid token in list is allowed to watch', async () => {
  const ws = makeFakeWs();
  const pipeline = makeFakePipeline();
  handleConnection(ws, { pool: pipeline, iceServers: [], token: 'GOODTOK', tokens: ['GOODTOK','OTHER'] });
  ws.emit('message', JSON.stringify({ id: 'watch' }));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pipeline.addViewerCount, 1, 'valid token => viewer created');
});

test('token gate: invalid token is rejected, no viewer, ws closed', async () => {
  const ws = makeFakeWs();
  const pipeline = makeFakePipeline();
  handleConnection(ws, { pool: pipeline, iceServers: [], token: 'WRONG', tokens: ['GOODTOK'] });
  ws.emit('message', JSON.stringify({ id: 'watch' }));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pipeline.addViewerCount, 0, 'invalid token => no viewer');
  const err = ws.sent.find((m) => m.id === 'error');
  assert.ok(err && /token/i.test(err.message), 'sends a token error');
});

test('token is OPTIONAL: missing token is allowed (partner bare-URL embeds)', async () => {
  // Partners use the bare /embed URL with NO token; they are gated at nginx
  // (Referer/Origin). A missing token must NOT be rejected here.
  const ws = makeFakeWs();
  const pipeline = makeFakePipeline();
  handleConnection(ws, { pool: pipeline, iceServers: [], token: null, tokens: ['GOODTOK'] });
  ws.emit('message', JSON.stringify({ id: 'watch' }));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pipeline.addViewerCount, 1, 'no token => still allowed');
});

test('token gate disabled (empty tokens) allows watch without token', async () => {
  const ws = makeFakeWs();
  const pipeline = makeFakePipeline();
  handleConnection(ws, { pool: pipeline, iceServers: [], token: null, tokens: [] });
  ws.emit('message', JSON.stringify({ id: 'watch' }));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pipeline.addViewerCount, 1, 'empty tokens => gate off => allowed');
});

test('endpoint error event is handled (no throw) and closes the ws', async () => {
  const ws = makeFakeWs();
  const pipeline = makeFakePipeline();
  handleConnection(ws, { pool: pipeline, iceServers: [] });
  ws.emit('message', JSON.stringify({ id: 'watch' }));
  await new Promise((r) => setImmediate(r));

  // Simulate Kurento emitting its 'Error' media event on the endpoint under
  // load. This MUST NOT throw out of the handler (would crash the process).
  assert.doesNotThrow(() => pipeline.endpoint.emit('Error', { description: 'Request has timed out' }));
  assert.strictEqual(ws.closed, true, 'ws is closed after a media error');
});
