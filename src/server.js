// src/server.js
const kurento = require('kurento-client');
const { WebSocketServer } = require('ws');
const config = require('../config');
const { KurentoPipeline } = require('./kurentoPipeline');
const { handleConnection } = require('./signaling');

const iceServers = [
  { urls: config.stun },
  { urls: config.turn.url, username: config.turn.username, credential: config.turn.credential },
];

async function main() {
  const client = await kurento(config.kurentoWsUri);
  const pipeline = new KurentoPipeline({ client, rtmpSource: config.rtmpSource });
  // Build the source eagerly so the first viewer is fast; tolerate source-not-ready.
  try { await pipeline.ensurePlayer(); } catch (e) { console.error('ensurePlayer (will retry on viewer):', e.message); }

  const wss = new WebSocketServer({ port: config.signalingPort });
  wss.on('connection', (ws) => handleConnection(ws, { pipeline, iceServers }));

  console.log(`signaling on :${config.signalingPort}, kurento ${config.kurentoWsUri}, source ${config.rtmpSource}`);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
