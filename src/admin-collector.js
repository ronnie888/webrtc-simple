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
const { execFile } = require('child_process');

const PORT = parseInt(process.env.ADMIN_PORT || '3002', 10);
const COUNT_URL = process.env.COUNT_URL || 'http://127.0.0.1:3001/count';
const STAT_URL = process.env.STAT_URL || 'https://127.0.0.1/stat';
// WM-armed CPU ceiling per node (project memory: 7/container x 12... but this
// stack runs 4 Kurento; ceiling is a display heuristic, tune via env).
const NODE_CEILING = parseInt(process.env.NODE_CEILING || '84', 10);

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
function deriveHealth({ stat, count, kurento, host }) {
  const viewers = count && typeof count.viewers === 'number' ? count.viewers : 0;
  const publishing = stat.publishers > 0;
  // Dead-OBS: nginx says publishing but no video bytes flowing (project memory:
  // check bw_video FIRST for black video).
  const sourceDead = publishing && stat.bwVideo === 0;
  const sourceLive = publishing && stat.bwVideo > 0;
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
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
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

module.exports = { parseStat, parseDockerStats, deriveHealth, collect, start };

if (require.main === module) start();
