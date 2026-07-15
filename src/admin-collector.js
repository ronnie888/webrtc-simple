// Single-node admin dashboard collector for node-63 (webrtc-swc).
//
// The data a browser dashboard needs is all localhost-only:
//   - RTMP /stat XML  (nginx `allow 127.0.0.1; deny all`)
//   - /count JSON     (bound 127.0.0.1:3001)
//   - docker stats    (docker socket)
//   - host /proc,os
// So this tiny http server runs ON the box, aggregates them into one JSON blob,
// and nginx proxies it under basic-auth at /admin/api/stats. No express, no xml
// dep — same grep-style parsing already used elsewhere in this repo.
//
// Pure parse/derive functions are exported for unit tests; IO is thin wrappers.

const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.ADMIN_PORT || '3002', 10);
const COUNT_URL = process.env.COUNT_URL || 'http://127.0.0.1:3001/count';
const STAT_URL = process.env.STAT_URL || 'https://127.0.0.1/stat';
// WM-armed CPU ceiling per node (project memory: 7/container x 12... but this
// stack runs 4 Kurento; ceiling is a display heuristic, tune via env).
const NODE_CEILING = parseInt(process.env.NODE_CEILING || '84', 10);
// 'origin' = OBS pushes here (publishing+bw=0 means OBS crashed → DEAD).
// 'relay'  = pulls from an origin (publishing+bw=0 just means upstream idle,
//            NOT a dead local OBS → OFFLINE, never DEAD).
const NODE_ROLE = process.env.NODE_ROLE || 'origin';

// Fleet peers: other nodes' admin APIs, polled server-side so the browser sees
// the whole fleet from one /admin (avoids per-node cert/CORS — the shared cert
// only covers the domain, not per-node names). Format: comma-list of
// name=url pairs, e.g. "node-64=https://134.185.89.40/admin/api/stats".
// Empty = single-node (no /api/fleet aggregation).
const FLEET_PEERS = (process.env.FLEET_PEERS || '').split(',').map((p) => p.trim()).filter(Boolean)
  .map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i), url: p.slice(i + 1) }; });
// Basic-auth creds to reach a peer's /admin/api (same creds across the fleet).
const FLEET_AUTH = process.env.FLEET_AUTH || '';   // "user:pass"

// Publisher IP allowlist — the IPs permitted to push RTMP (OBS). nginx-rtmp
// on_publish hits /publish/check with the client addr; we 200/403 against this
// JSON file. Editable live from the admin UI (no nginx reload). Empty file/list
// = allow ALL (open) so a fresh box isn't accidentally locked out.
const PUBLISHERS_FILE = process.env.PUBLISHERS_FILE || '/opt/webrtc-simple/publishers.json';
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function readPublishers() {
  try {
    const arr = JSON.parse(fs.readFileSync(PUBLISHERS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.filter((x) => IP_RE.test(x)) : [];
  } catch { return []; }   // missing/bad file = open (allow all)
}
function writePublishers(list) {
  const clean = [...new Set(list.filter((x) => IP_RE.test(x)))];
  fs.writeFileSync(PUBLISHERS_FILE, JSON.stringify(clean, null, 2));
  return clean;
}
// Empty list = open. Non-empty = IP must be in it.
function isPublisherAllowed(ip, list = readPublishers()) {
  return list.length === 0 || list.includes(ip);
}

// ---- pure parsers / derivers (unit-tested) --------------------------------

// Pull the <live> counters out of nginx-rtmp /stat XML. Returns publishers,
// bwVideo (kbps), nclients. bw_video lives inside a <stream> under <live>; a
// live source with an active publisher has publishing/>. When OBS is off there
// is no <stream>, so bwVideo=0 and publishers=0.
function parseStat(xml) {
  const num = (re) => { const m = xml.match(re); return m ? parseInt(m[1], 10) : 0; };
  const publishers = (xml.match(/<publishing\/>/g) || []).length;
  const bwVideo = num(/<bw_video>(\d+)<\/bw_video>/);
  const nclients = num(/<nclients>(\d+)<\/nclients>/);
  const uptime = num(/<uptime>(\d+)<\/uptime>/);
  const bytesIn = num(/<bytes_in>(\d+)<\/bytes_in>/);
  return { publishers, bwVideo, nclients, uptime, bytesIn };
}

// `docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"`
// -> [{name, cpu, mem}]. Only kurento-* rows are kept.
function parseDockerStats(out) {
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [name, cpu, mem] = l.split('|'); return { name, cpu, mem }; })
    .filter((r) => r.name && r.name.startsWith('kurento-'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Roll everything into the health verdict + capacity the dashboard renders.
function deriveHealth({ stat, count, kurento, host, role = NODE_ROLE }) {
  const viewers = count && typeof count.viewers === 'number' ? count.viewers : 0;
  const publishing = stat.publishers > 0;
  const sourceLive = publishing && stat.bwVideo > 0;
  // DEAD = publishing but zero video (black screen). Only meaningful on an
  // ORIGIN (local OBS crashed). On a RELAY there is no local OBS to die — a
  // stale <publishing/> with bw=0 just means the upstream is idle → OFFLINE.
  const sourceDead = role === 'origin' && publishing && stat.bwVideo === 0;
  const kurentoUnhealthy = kurento.filter((k) => k.unhealthy).length;
  const loadPct = host.cores ? (host.load1 / host.cores) * 100 : 0;
  const memPct = host.memTotal ? (host.memUsed / host.memTotal) * 100 : 0;
  const capacityPct = NODE_CEILING ? (viewers / NODE_CEILING) * 100 : 0;

  let status = 'HEALTHY';
  if (kurentoUnhealthy > 0 || sourceDead) status = 'DEGRADED';
  if (loadPct >= 90 || memPct >= 90) status = 'DEGRADED';
  if (kurento.length === 0) status = 'DOWN';

  return {
    status,
    role,
    source: sourceDead ? 'DEAD' : sourceLive ? 'LIVE' : 'OFFLINE',
    viewers,
    perInstance: (count && count.perInstance) || [],
    bwVideo: stat.bwVideo,
    nclients: stat.nclients,
    rtmpUptime: stat.uptime,
    kurento,
    kurentoUnhealthy,
    host: { ...host, loadPct: +loadPct.toFixed(1), memPct: +memPct.toFixed(1) },
    capacity: { viewers, ceiling: NODE_CEILING, pct: +capacityPct.toFixed(1), nearPeak: capacityPct >= 70 },
  };
}

// ---- thin IO wrappers -----------------------------------------------------

function fetchText(url, { insecure = false } = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = insecure ? { rejectUnauthorized: false } : {};
    const req = mod.get(url, opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(''));   // localhost-only; empty on failure
    req.setTimeout(2000, () => { req.destroy(); resolve(''); });
  });
}

function dockerStats() {
  return new Promise((resolve) => {
    execFile('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'],
      { timeout: 4000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// docker ps health, separate from stats (stats has no health column).
function dockerHealth() {
  return new Promise((resolve) => {
    execFile('docker', ['ps', '--format', '{{.Names}}|{{.Status}}'],
      { timeout: 4000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function collect() {
  const [statXml, countText, statsOut, healthOut] = await Promise.all([
    fetchText(STAT_URL, { insecure: true }),
    fetchText(COUNT_URL),
    dockerStats(),
    dockerHealth(),
  ]);

  const stat = parseStat(statXml);
  let count = null;
  try { count = JSON.parse(countText); } catch { /* count server down */ }

  const stats = parseDockerStats(statsOut);
  const healthMap = {};
  healthOut.split('\n').forEach((l) => {
    const [name, status] = l.split('|');
    if (name && name.startsWith('kurento-')) healthMap[name] = status || '';
  });
  const kurento = stats.map((k) => ({
    ...k,
    status: healthMap[k.name] || 'unknown',
    unhealthy: !/healthy|Up/.test(healthMap[k.name] || ''),
  }));

  const host = {
    hostname: os.hostname(),
    cores: os.cpus().length,
    load1: +os.loadavg()[0].toFixed(2),
    load5: +os.loadavg()[1].toFixed(2),
    load15: +os.loadavg()[2].toFixed(2),
    memTotal: os.totalmem(),
    memUsed: os.totalmem() - os.freemem(),
    uptime: Math.floor(os.uptime()),
  };

  return deriveHealth({ stat, count, kurento, host });
}

// ---- server ---------------------------------------------------------------

function start() {
  http.createServer(async (req, res) => {
    if (req.url === '/api/stats' || req.url === '/api/stats/') {
      try {
        const data = await collect();
        data.publishers = readPublishers();   // so the fleet view can show the origin's allowlist
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    } else if (req.url === '/api/fleet' || req.url === '/api/fleet/') {
      try {
        const data = await collectFleet();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    } else if (req.url === '/publish/check') {
      // nginx-rtmp on_publish callback (POST form-encoded, client IP in `addr`).
      // 2xx = allow the publish, non-2xx = reject. Localhost-only (from nginx).
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const ip = params.get('addr') || '';
      if (isPublisherAllowed(ip)) { res.writeHead(200); res.end('ok'); }
      else { res.writeHead(403); res.end('denied'); }
      console.log(`on_publish ${ip} -> ${isPublisherAllowed(ip) ? 'ALLOW' : 'DENY'}`);
    } else if (req.url === '/api/publishers' || req.url.startsWith('/api/publishers?')) {
      // GET list / POST {ip} add / DELETE {ip} remove. Auth enforced by nginx.
      // Writes replicate to peers so the allowlist is fleet-consistent regardless
      // of which node DNS round-robin sent the admin to. `?replicated=1` marks a
      // peer-originated write so it isn't re-replicated (no loop).
      try {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ publishers: readPublishers(), open: readPublishers().length === 0 }));
        } else if (req.method === 'POST' || req.method === 'DELETE') {
          // IP from query (replicated writes, survives proxy) or JSON body (UI).
          const q = new URLSearchParams(req.url.split('?')[1] || '');
          let ip = (q.get('ip') || '').trim();
          if (!ip) { const body = await readBody(req); try { ip = (JSON.parse(body || '{}').ip || '').trim(); } catch {} }
          if (!IP_RE.test(ip)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid IP' })); }
          let list = readPublishers();
          list = req.method === 'POST' ? [...list, ip] : list.filter((x) => x !== ip);
          const saved = writePublishers(list);
          if (!req.url.includes('replicated=1')) replicatePublisher(req.method, ip);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ publishers: saved, open: saved.length === 0 }));
        } else { res.writeHead(405); res.end(); }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    } else {
      res.writeHead(404); res.end();
    }
  }).listen(PORT, '127.0.0.1', () => {
    console.log(`admin collector on 127.0.0.1:${PORT}/api/stats`);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b));
  });
}

// Push a publisher add/remove to every peer so the allowlist stays consistent
// across the fleet. Fire-and-forget; a peer being down doesn't fail the write
// (peers also re-sync any time their own list is edited).
function replicatePublisher(method, ip) {
  FLEET_PEERS.forEach((peer) => {
    // peer.url is .../admin/api/stats -> .../admin/api/publishers?replicated=1&ip=...
    // IP goes in the QUERY, not the body: nginx proxy_pass can drop a DELETE
    // request body, which silently no-op'd remote deletes. Query always survives.
    const base = peer.url.replace(/\/stats\/?$/, '/publishers');
    const url = `${base}?replicated=1&ip=${encodeURIComponent(ip)}`;
    const u = new URL(url);
    const opts = { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      rejectUnauthorized: false, headers: { 'Content-Type': 'application/json' } };
    if (FLEET_AUTH) opts.headers.Authorization = 'Basic ' + Buffer.from(FLEET_AUTH).toString('base64');
    const r = https.request(opts, (res) => res.resume());
    r.on('error', () => {});
    r.end();
  });
}

// Fetch a peer node's already-aggregated stats (server-side, we control both
// nodes so ignore the cert-name mismatch on the direct-IP URL). Returns the
// peer's stats object tagged with its name, or an error stub if unreachable.
function fetchPeer(peer) {
  return new Promise((resolve) => {
    let req;
    const opts = { rejectUnauthorized: false, timeout: 3000 };
    if (FLEET_AUTH) opts.headers = { Authorization: 'Basic ' + Buffer.from(FLEET_AUTH).toString('base64') };
    req = https.get(peer.url, opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ name: peer.name, ...JSON.parse(d) }); }
        catch { resolve({ name: peer.name, status: 'STALE', error: 'bad response' }); }
      });
    });
    req.on('error', () => resolve({ name: peer.name, status: 'STALE', error: 'unreachable' }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ name: peer.name, status: 'STALE', error: 'timeout' }); });
  });
}

// Aggregate this node + all peers into one fleet payload the dashboard renders
// as columns. Self is tagged with its own hostname; total sums live viewers.
async function collectFleet() {
  const self = await collect();
  const selfNode = { name: self.host.hostname, ...self, publishers: readPublishers(), self: true };
  const peers = await Promise.all(FLEET_PEERS.map(fetchPeer));
  const nodes = [selfNode, ...peers];
  const totalViewers = nodes.reduce((n, x) => n + (x.viewers || 0), 0);
  const anyLive = nodes.some((x) => x.source === 'LIVE');
  return { nodes, totalViewers, anyLive, ceiling: NODE_CEILING * nodes.length };
}

module.exports = { parseStat, parseDockerStats, deriveHealth, collect, collectFleet, isPublisherAllowed, start };

if (require.main === module) start();
