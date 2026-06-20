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

Open these in the cloud firewall (OCI security list / NSG):
- TCP 80 (viewer page), 1935 (RTMP ingest), 3478 (TURN), 8888 (Kurento, local only — optional)
- UDP 3478 (TURN), 5000-65535 (Kurento media), 49152-65535 (TURN relay)

## OBS settings

- Service: **Custom**
- Server: `rtmp://<vps-public-ip>:1935/live`
- Stream Key: `stream`

## Watch

Open `http://<vps-public-ip>/` in Chrome. Status overlay shows `ws open` → `ice: connected` → `playing`.

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
