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

// Backstop: never let a single async/endpoint error kill the whole server and
// disconnect every viewer. Log and keep serving. (Per-endpoint errors are also
// handled in signaling.js; this catches anything that slips through, e.g. a
// Kurento client timeout emitted outside a try/catch under heavy load.)
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (kept alive):', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection (kept alive):', reason && reason.message ? reason.message : reason);
});

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
