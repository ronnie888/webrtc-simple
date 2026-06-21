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
