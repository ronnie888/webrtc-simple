# webrtc-simple

Minimal Kurento WebRTC. OBS pushes RTMP; browsers watch via WebRTC. Single VPS, no security.

## Architecture

```
OBS ──RTMP──> nginx-RTMP(:1935) ──> Kurento PlayerEndpoint ──> PassThrough
                                                                   │
                                          ┌────────────────────────┤ (one source pull)
                                          ▼            ▼            ▼
                                    WebRtcEndpoint  WebRtcEndpoint  ...   ──> browsers
                                          ▲
              Node signaling(:3000) ──WS SDP/ICE──> viewer.html ; coturn relays media
```

## Deploy (fresh Ubuntu VPS)

```bash
git clone <repo> webrtc-simple && cd webrtc-simple
PUBLIC_IP=<vps-public-ip> TURN_PASS=<pick-a-secret> bash deploy/setup.sh
```

`setup.sh` opens the host iptables ports for you. On a cloud VPS you must ALSO
add matching ingress rules in the **cloud firewall** (OCI Security List / NSG) —
host iptables alone is not enough behind a cloud edge:
- TCP 80 (viewer/acme), 443 (HTTPS), 1935 (RTMP ingest), 3478 (TURN)
- UDP 3478 (TURN), 5000-65535 (Kurento media), 49152-65535 (TURN relay)

## OBS settings

- Service: **Custom**
- Server: `rtmp://<vps-public-ip>:1935/live`
- Stream Key: `stream`

**Push OBS first, then open viewers.** If signaling started before the source
was live, the player auto-rebuilds on the next viewer connect (dead-source
detection). If video is still blank: `sudo systemctl restart webrtc-simple`.

## HTTPS + iframe embed whitelist (optional)

After DNS for your domain points at the VPS:

```bash
DOMAIN=yourdomain.com EMAIL=you@example.com \
  PARTNERS="partner1.com partner2.net" bash deploy/setup-ssl.sh
```

Issues a Let's Encrypt cert (auto-renewing) and locks the viewer so it only
loads inside an `<iframe>` on a whitelisted partner domain (referer gate + CSP
`frame-ancestors`). Direct URL hits and non-partner embeds get 403. Add a
partner later by re-running with the new `PARTNERS` list. WSS is automatic on
HTTPS (viewer.html picks `wss://`).

## Admin dashboard (optional)

Single-node health panel at `https://<domain>/admin` (basic-auth): source
LIVE/OFFLINE, live viewers, per-Kurento spread, 4× Kurento CPU/mem/health, host
load/mem, and a capacity-vs-peak tile. A small collector (`src/admin-collector.js`,
systemd unit `webrtc-swc-admin`, localhost:3002) aggregates the localhost-only
`/stat` + `/count` + `docker stats`; nginx proxies it under `/admin/api/`.

```bash
bash deploy/setup-admin.sh [ADMIN_PASSWORD]   # idempotent; prints a random pass if none given
```

> ⚠️ `setup-ssl.sh` regenerates `nginx.conf` and wipes hand edits — re-run
> `setup-admin.sh` after it (same re-apply class as the publish-lock /
> admin.peryago blocks). Backup of the pre-`/admin` config is
> `nginx.conf.bak.admindash`.

**Publisher allowlist (which OBS IPs may push):** the admin has a "Publisher
allowlist" panel. IPs are stored in `/opt/webrtc-simple/publishers.json` and
enforced by nginx-rtmp `on_publish http://127.0.0.1:3002/publish/check` — the
collector 200/403s each publish attempt against the list. Empty list = OPEN
(any IP). Edits apply instantly (no nginx reload) and **replicate across the
fleet** (FLEET_PEERS), so it doesn't matter which node DNS round-robin sent you
to. To enable on the origin: add `on_publish http://127.0.0.1:3002/publish/check;`
to the `application live` block (replacing static `allow publish` lines) — note
that reload drops the *current* publish, so OBS reconnects (a few seconds).

## Scale out (multiple nodes, DNS round-robin)

One box has a soft ceiling (~84 viewers with watermark armed; far more passthrough).
To add capacity, add **relay nodes** that pull the source from the origin (the box
OBS pushes to) and serve their own Kurento/WebRTC. Viewers split across all nodes
via DNS round-robin.

Per relay node:
```bash
# 1. same bootstrap as the origin
PUBLIC_IP=<relay-ip> TURN_PASS=<same-as-origin> bash deploy/setup.sh
# 2. copy the origin's cert (same domain) + its whitelisted nginx.conf, then:
ORIGIN_IP=<origin-ip> bash deploy/setup-relay-node.sh   # swaps OBS-lock -> static pull
bash deploy/setup-admin.sh                              # optional per-node dashboard
# 3. add the relay's IP as an extra A record on the domain (TTL 300)
```

Notes / gotchas:
- **nginx-RTMP `static pull` inits at master START, not on reload** — after the
  origin's source goes live, `systemctl restart nginx` on the relay to (re)arm the
  pull if it connected while the origin was idle. `bw_video` on the relay's `/stat`
  confirms bytes.
- Cert is shared across nodes (same domain via round-robin). The origin auto-renews;
  a copied cert on a relay goes stale in ~90d — either run certbot on the relay too
  (it answers the domain via RR) or add a renew-hook that rsyncs the cert.
- DNS round-robin is crude (~even split, no health-check). If a relay dies, RR still
  hands out its IP → those viewers fail (visible on the dashboard). Fine for a few
  nodes; add an LB (least_conn) at 4+.
- Relay depends on the origin's RTMP: origin down = all down (the origin is the OBS
  ingest anyway).

## Watch

Open `http://<vps-public-ip>/` (or `https://<domain>/` after setup-ssl.sh) in
Chrome. Status overlay shows `ws open` → `ice: connected` → `playing`.

## Verify

- Kurento up: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8888/kurento` → `426`
- OBS publishing: open `http://<vps-public-ip>/stat` — `live` app shows a publisher
- Signaling logs: `journalctl -u webrtc-simple -f`

## Develop

```bash
npm install
npm test        # node built-in test runner (pipeline + signaling units)
```

## Files

| Path | Responsibility |
|------|----------------|
| `config.js` | All tunables (ports, IPs, TURN creds, RTMP source) |
| `src/kurentoPipeline.js` | One shared pipeline; ensure-only player; per-viewer endpoint lifecycle |
| `src/signaling.js` | WS JSON ↔ pipeline (watch/offer/ice/close) |
| `src/server.js` | Wires kurento-client + ws, starts listening |
| `public/viewer.html` | Browser viewer (`<video>` + WS client) |
| `deploy/nginx-rtmp.conf` | RTMP ingest + static + /ws proxy |
| `deploy/turnserver.conf` | coturn TURN relay |
| `deploy/webrtc-simple.service` | systemd unit for signaling |
| `deploy/setup.sh` | One-shot VPS bootstrap |

## Out of scope (by design)

No watermark, admin UI, partner whitelist, anti-piracy, Redis/Postgres, PM2 cluster, multi-node fan-out. Scale-later hook: add a node-picker in signaling.
