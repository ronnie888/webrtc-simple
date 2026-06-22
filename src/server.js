// src/server.js
const http = require('http');
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
  wss.on('connection', (ws, req) => {
    let token = null;
    try {
      const u = new URL(req.url, 'http://localhost');
      token = u.searchParams.get('lt');
    } catch { /* no token */ }
    handleConnection(ws, { pipeline, iceServers, token, tokens: config.embedTokens });
  });

  // Lightweight metrics endpoint (localhost) for load testing: exact live
  // viewer count = WebRtcEndpoints in the pipeline. GET /count -> JSON.
  http.createServer((req, res) => {
    if (req.url === '/count') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ viewers: pipeline.viewers.size, playerDead: pipeline.playerDead }));
    } else {
      res.writeHead(404); res.end();
    }
  }).listen(config.metricsPort, '127.0.0.1', () => {
    console.log(`metrics on 127.0.0.1:${config.metricsPort}/count`);
  });

  console.log(`signaling on :${config.signalingPort}, kurento ${config.kurentoWsUri}, source ${config.rtmpSource}`);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
