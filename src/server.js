// src/server.js
const http = require('http');
const kurento = require('kurento-client');
const { WebSocketServer } = require('ws');
const config = require('../config');
const { KurentoPipeline } = require('./kurentoPipeline');
const { KurentoPool } = require('./kurentoPool');
const { handleConnection } = require('./signaling');

// Advertise TURN over BOTH UDP and TCP. Telegram/iOS in-app webviews and locked-
// down mobile networks often block UDP entirely, so without a TURN-TCP candidate
// ICE never forms a working pair → WS connects but video stays black. The TCP
// variant lets media relay over coturn's TCP listener (:3478).
const iceServers = [
  { urls: config.stun },
  { urls: config.turn.url, username: config.turn.username, credential: config.turn.credential },
  { urls: config.turn.url + '?transport=tcp', username: config.turn.username, credential: config.turn.credential },
];

async function main() {
  // One KurentoPipeline per Kurento instance (8888,8889,...), wrapped in a pool
  // that shards viewers least-loaded → connect setup parallelizes across them.
  const pipelines = [];
  for (const uri of config.kurentoUris) {
    const client = await kurento(uri);
    pipelines.push(new KurentoPipeline({ client, rtmpSource: config.rtmpSource }));
  }
  const pool = new KurentoPool({ pipelines });
  // Build each source eagerly so first viewers are fast; tolerate source-not-ready.
  try { await pool.ensureAll(); } catch (e) { console.error('ensureAll (will retry on viewer):', e.message); }

  const wss = new WebSocketServer({ port: config.signalingPort });
  wss.on('connection', (ws, req) => {
    let token = null;
    try {
      const u = new URL(req.url, 'http://localhost');
      token = u.searchParams.get('lt');
    } catch { /* no token */ }
    handleConnection(ws, { pool, iceServers, token, tokens: config.embedTokens });
  });

  // Lightweight metrics endpoint (localhost) for load testing. GET /count -> JSON
  // with the fleet total and the per-instance breakdown (to confirm even spread).
  http.createServer((req, res) => {
    if (req.url === '/count') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ viewers: pool.totalViewers(), perInstance: pool.perInstanceCounts() }));
    } else {
      res.writeHead(404); res.end();
    }
  }).listen(config.metricsPort, '127.0.0.1', () => {
    console.log(`metrics on 127.0.0.1:${config.metricsPort}/count`);
  });

  console.log(`signaling on :${config.signalingPort}, ${config.kurentoUris.length} kurento [${config.kurentoUris.join(', ')}], source ${config.rtmpSource}`);
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
