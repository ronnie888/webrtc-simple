const { test } = require('node:test');
const assert = require('node:assert');
const { parseStat, parseDockerStats, deriveHealth } = require('../src/admin-collector');

// Real /stat XML captured from node-63 with OBS OFF (no <stream>, nclients 0).
const STAT_OFFLINE = `<?xml version="1.0" encoding="utf-8" ?>
<rtmp><nginx_version>1.24.0</nginx_version><uptime>12751</uptime>
<bytes_in>46860269</bytes_in><bw_out>0</bw_out>
<server><application><name>live</name><live><nclients>0</nclients></live></application></server></rtmp>`;

// /stat with an active publisher pushing video (OBS ON).
const STAT_LIVE = `<?xml version="1.0" ?>
<rtmp><uptime>500</uptime><bytes_in>999</bytes_in>
<server><application><name>live</name><live><nclients>4</nclients>
<stream><name>stream</name><bw_video>2500</bw_video><publishing/><active/></stream>
</live></application></server></rtmp>`;

// Publisher present but bw_video 0 = dead OBS (black video) — must flag DEAD.
const STAT_DEAD = STAT_LIVE.replace('<bw_video>2500</bw_video>', '<bw_video>0</bw_video>');

test('parseStat: OBS off -> no publishers, zero video', () => {
  const s = parseStat(STAT_OFFLINE);
  assert.strictEqual(s.publishers, 0);
  assert.strictEqual(s.bwVideo, 0);
  assert.strictEqual(s.nclients, 0);
  assert.strictEqual(s.uptime, 12751);
});

test('parseStat: OBS live -> publisher + video bytes', () => {
  const s = parseStat(STAT_LIVE);
  assert.strictEqual(s.publishers, 1);
  assert.strictEqual(s.bwVideo, 2500);
  assert.strictEqual(s.nclients, 4);
});

test('parseDockerStats: keeps only kurento rows, sorted', () => {
  const out = 'kurento-3|0.01%|309MiB / 31GiB\nrtmp-relay|5%|10MiB\nkurento-0|0.02%|312MiB\nkurento-1|0.01%|320MiB';
  const rows = parseDockerStats(out);
  assert.deepStrictEqual(rows.map((r) => r.name), ['kurento-0', 'kurento-1', 'kurento-3']);
  assert.strictEqual(rows[0].cpu, '0.02%');
});

const K_HEALTHY = [0, 1, 2, 3].map((n) => ({ name: `kurento-${n}`, cpu: '0.01%', mem: '310MiB', status: 'Up 47 hours (healthy)', unhealthy: false }));
const HOST = { cores: 48, load1: 0.13, memTotal: 32e9, memUsed: 2.6e9 };

test('deriveHealth: idle box, OBS off -> HEALTHY / OFFLINE / not near peak', () => {
  const h = deriveHealth({ stat: parseStat(STAT_OFFLINE), count: { viewers: 0, perInstance: [0, 0, 0, 0] }, kurento: K_HEALTHY, host: HOST });
  assert.strictEqual(h.status, 'HEALTHY');
  assert.strictEqual(h.source, 'OFFLINE');
  assert.strictEqual(h.capacity.nearPeak, false);
});

test('deriveHealth: live source -> LIVE', () => {
  const h = deriveHealth({ stat: parseStat(STAT_LIVE), count: { viewers: 8, perInstance: [0, 3, 3, 2] }, kurento: K_HEALTHY, host: HOST });
  assert.strictEqual(h.source, 'LIVE');
  assert.strictEqual(h.viewers, 8);
});

test('deriveHealth: origin publishing but bw_video 0 -> DEAD + DEGRADED', () => {
  const h = deriveHealth({ stat: parseStat(STAT_DEAD), count: { viewers: 0 }, kurento: K_HEALTHY, host: HOST, role: 'origin' });
  assert.strictEqual(h.source, 'DEAD');
  assert.strictEqual(h.status, 'DEGRADED');
});

test('deriveHealth: RELAY with stale publishing+bw0 -> OFFLINE not DEAD (no local OBS to die)', () => {
  const h = deriveHealth({ stat: parseStat(STAT_DEAD), count: { viewers: 0 }, kurento: K_HEALTHY, host: HOST, role: 'relay' });
  assert.strictEqual(h.source, 'OFFLINE');
  assert.strictEqual(h.status, 'HEALTHY');
});

test('deriveHealth: near peak flags at >=70% ceiling', () => {
  const h = deriveHealth({ stat: parseStat(STAT_LIVE), count: { viewers: 60 }, kurento: K_HEALTHY, host: HOST });
  assert.ok(h.capacity.pct >= 70);
  assert.strictEqual(h.capacity.nearPeak, true);
});

test('deriveHealth: an unhealthy kurento -> DEGRADED', () => {
  const k = K_HEALTHY.map((x, i) => (i === 0 ? { ...x, unhealthy: true } : x));
  const h = deriveHealth({ stat: parseStat(STAT_LIVE), count: { viewers: 5 }, kurento: k, host: HOST });
  assert.strictEqual(h.status, 'DEGRADED');
  assert.strictEqual(h.kurentoUnhealthy, 1);
});

test('deriveHealth: no kurento containers -> DOWN', () => {
  const h = deriveHealth({ stat: parseStat(STAT_OFFLINE), count: { viewers: 0 }, kurento: [], host: HOST });
  assert.strictEqual(h.status, 'DOWN');
});
