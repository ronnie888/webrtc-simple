# webrtc-swc Fleet Deployment Runbook

**Replicate the node-63/64 fleet onto a new 2-node fleet (e.g. node-62 origin + node-65 relay).**

This is the complete A-to-Z. Everything that was hand-fixed live on node-63/64 is captured here
as repeatable steps + the exact gotchas that bit us. Follow top to bottom.

---

## 0. What you're building

```
                 OBS (locked IP)
                     │ RTMP push
                     ▼
   ┌─────────────────────────────┐        ┌─────────────────────────────┐
   │ node-62  ORIGIN             │  RTMP  │ node-65  RELAY              │
   │ 4 Kurento (passthrough)     │◀───────│ 4 Kurento (passthrough)     │
   │ nginx-rtmp + TURN + signal  │  pull  │ pulls node-62's stream      │
   │ /admin dashboard            │        │ /admin dashboard            │
   └──────────────┬──────────────┘        └──────────────┬──────────────┘
                  │  viewers (WebRTC)                     │
                  └───────────────┬───────────────────────┘
                                  ▼
                       DNS round-robin (both A records)
                          yourdomain.com → viewers ~50/50
```

Per node: **48 vCPU / 31 GB**, 4 Kurento in **passthrough** (no transcode, no watermark),
one Node signaling process, coturn, nginx-rtmp, admin collector.

**Capacity** (measured, passthrough): ~0.15 core/viewer → plan **~900 viewers/node** (~1,800 for 2).
See the capacity estimate for tiers.

---

## 1. Prerequisites (fill these in FIRST)

| Item | node-63/64 example | node-62/65 fleet |
|---|---|---|
| Origin node public IP | 138.2.88.192 (node-63) | **node-62 = 161.118.215.36** (priv 10.0.9.123) |
| Origin SSH hostkey | `SHA256:BVZ/iaG…` | **`SHA256:9TXo2NnWRDwRstvcvHWT7mvs8IEgyMAB2KoweGbtOLU`** |
| Relay node public IP | 134.185.89.40 (node-64) | node-65 = `______` (fill from `curl ifconfig.me`) |
| Relay SSH hostkey | `SHA256:DjYX3…` | `______` (capture on first plink) |
| Domain | sabongflix.com | `______` (node-62 currently serves `mystreamingserver.live`) |
| SSH key | `D:\ppk\vprivateprod.ppk` | same: `D:\ppk\vprivateprod.ppk` |
| OBS source IP (publish-lock) | 103.60.170.61 | `______` |
| TURN password | swc-turn-8x2k | pick one: `______` |
| Admin basic-auth pass | f28mFXpNHM3dx8efPa | generated in §6 |
| Partner embed domains | 37 partners | space-separated list |
| Let's Encrypt email | — | `______` |

> **node-62 is NOT a fresh box** — it already runs the base webrtc-simple stack (48-core, 4 Kurento,
> signaling active, serves `mystreamingserver.live`). So on node-62 you **SKIP §2-3** (code + setup.sh
> already done) and only add the NEW features: re-deploy the latest code (§2 rsync only), then
> §6 admin, §7 fleet, §8 allowlist. **node-65 is fresh** → full §2-3 bootstrap.
> Decide first: keep `mystreamingserver.live` or use a new domain for the 62/65 fleet.

**Both VPS must be:** Ubuntu 24.04, sudo-capable `ubuntu` user, reachable on SSH.
Fresh OCI boxes have **no Docker** — `setup.sh` installs it.

**⚠️ OCI/cloud firewall:** host `iptables` is NOT enough. In the cloud console (OCI Security List /
NSG) open ingress: **80, 443, 1935, 3478 (tcp+udp), 49152-65535/udp (TURN relay), 5000-65535/udp
(Kurento media)**. Miss this → black video / no TURN, and it looks like a code bug.

---

## 2. Get the code onto both nodes

From your Windows box (has the repo + ppk). Repeat for BOTH node IPs.

```bash
cd D:/SecurityProjects/kurento-gstreamer/webrtc-simple
# tar without node_modules/.git (setup.sh installs deps on the box)
tar --exclude=node_modules --exclude=.git --exclude=test -czf /tmp/wswc.tgz .

# push (fresh box: plink will prompt to cache hostkey — capture the SHA256 fingerprint,
# then re-run with -hostkey "SHA256:..." to avoid the interactive hang in batch mode)
pscp -batch -hostkey "SHA256:<node-fp>" -i "D:\ppk\vprivateprod.ppk" /tmp/wswc.tgz ubuntu@<NODE_IP>:/tmp/wswc.tgz
plink -batch -hostkey "SHA256:<node-fp>" -i "D:\ppk\vprivateprod.ppk" ubuntu@<NODE_IP> "mkdir -p ~/webrtc-swc && tar -xzf /tmp/wswc.tgz -C ~/webrtc-swc && ls ~/webrtc-swc/deploy"
```

> **Fresh-box hostkey trick:** first `plink` to a new box hangs in `-batch` mode waiting to cache
> the key. Run once WITHOUT `-batch` to see `The server's ssh-ed25519 key fingerprint is: SHA256:...`,
> copy that, then always pass `-hostkey "SHA256:..."`.

---

## 3. Bootstrap BOTH nodes (setup.sh)

Installs packages, Docker, 4 Kurento, nginx-rtmp, coturn, signaling service, kernel tuning.
Run on **each** node. Long (~3-5 min: apt + docker pull) — background it.

```bash
# ON each node (via plink or SSH):
cd ~/webrtc-swc
PUBLIC_IP=<THIS_NODE_IP> TURN_USER=webrtc TURN_PASS=<YOUR_TURN_PASS> KURENTO_INSTANCES=4 \
  bash deploy/setup.sh
```

Verify after each:
```bash
sudo docker ps --format '{{.Names}} {{.Status}}' | grep kurento   # 4 healthy
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8888/kurento   # 426
systemctl is-active webrtc-simple                                 # active
ps -C nginx -o cmd | grep -c master                               # exactly 1
```

**Gotchas:**
- Fresh OCI = no Docker → setup.sh installs it (that's the slow part).
- `worker_processes 1` in nginx-rtmp.conf is **required** — RTMP streams aren't shared across
  workers; `auto` on a 48-core box isolated the publish to 1/48 → `nclients=0`.
- kurento-client postinstall aborts npm on some tarballs → setup.sh uses `npm i --ignore-scripts`.

---

## 4. DNS + HTTPS + partner whitelist

### 4a. Point DNS at BOTH nodes (round-robin)
In your DNS panel (node-63/64 used DigitalOcean), add **two A records**, same hostname:
```
A   yourdomain.com   → <ORIGIN_IP>   TTL 300
A   yourdomain.com   → <RELAY_IP>    TTL 300
```
Keep TTL **300** so you can pull a bad node fast. Verify authoritative:
```bash
dig +short yourdomain.com @ns1.digitalocean.com   # should list BOTH IPs
```

### 4b. Issue cert + whitelist on the ORIGIN (node-62)
Run AFTER DNS resolves. setup-ssl.sh issues a Let's Encrypt cert (HTTP-01) and builds the
referer/origin/CSP partner maps:
```bash
# ON node-62:
cd ~/webrtc-swc
DOMAIN=yourdomain.com EMAIL=you@example.com \
  PARTNERS="gamesabong.com sabongmax.net ...all partner domains..." \
  bash deploy/setup-ssl.sh
```
Verify:
```bash
curl -sI https://yourdomain.com/ -H 'Referer: https://gamesabong.com/' | head -1   # 200
curl -sI https://yourdomain.com/ | head -1                                          # 403 (no referer)
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost/embed                   # 200
```

### 4c. Cert on the RELAY (node-65) — copy, don't re-issue
The relay answers the SAME domain via round-robin, so it needs the same cert. Two options:

**Option A — copy from origin (fast):**
```bash
# ON node-62: tar the cert (deref symlinks with -h!)
sudo tar -czhf /tmp/cert.tgz -C /etc/letsencrypt/live/yourdomain.com .
sudo chown ubuntu /tmp/cert.tgz
# also copy node-62's finished nginx.conf (has the whitelist+CSP) to adapt on node-65
sudo cp /etc/nginx/nginx.conf /tmp/nginx.conf && sudo chown ubuntu /tmp/nginx.conf

# pull to Windows, push to node-65, place:
# (pscp both files, then on node-65:)
sudo mkdir -p /etc/letsencrypt/live/yourdomain.com /var/www/certbot
sudo tar -xzf /tmp/cert.tgz -C /etc/letsencrypt/live/yourdomain.com
sudo cp /tmp/nginx.conf /etc/nginx/nginx.conf     # then step 5 swaps its RTMP block to relay-pull
```
> ⚠️ A copied cert goes stale in ~90 days (origin auto-renews, the copy doesn't). Either re-copy on
> renewal, OR run `certbot certonly --webroot` on node-65 too (it answers the domain via RR).

**Option B — issue independently on node-65:** run the same setup-ssl.sh on node-65 (DNS RR lets it
pass HTTP-01). Cleaner for renewal, slightly slower.

---

## 5. Convert the RELAY (node-65) to pull from the origin

node-65 has no OBS. Point its nginx-rtmp at node-62's stream:
```bash
# ON node-65:
cd ~/webrtc-swc
ORIGIN_IP=<node-62-IP> bash deploy/setup-relay-node.sh
```
This swaps the `application live` publish block for
`pull rtmp://<ORIGIN_IP>/live/stream name=stream static live=1;`, sets `NODE_ROLE=relay` for the
admin, and restarts nginx.

**Gotchas:**
- **`static pull` arms at nginx MASTER START, not reload.** If the pull connected while the origin
  had no live source, it stays idle (0 bytes). Once OBS is live on the origin,
  `sudo systemctl restart nginx` on the relay to re-arm. Confirm with `curl -sk https://localhost/stat | grep bw_video` (>0).
- Verify the pull: `sudo ss -tnp | grep '<ORIGIN_IP>:1935'` → ESTAB.

---

## 6. Admin dashboard on BOTH nodes

```bash
# ON each node:
cd ~/webrtc-swc
bash deploy/setup-admin.sh          # prints a random admin password if none exists — SAVE IT
```
This installs the collector (`src/admin-collector.js`, systemd `webrtc-swc-admin` on :3002), adds
the `ubuntu` user to the `docker` group, creates `/etc/nginx/.htpasswd-admin`, and inserts the
`/admin` + `/admin/api/` nginx locations under basic-auth.

**Use the SAME admin password on both nodes** (fleet view + replication need matching creds). To
force a specific password: `bash deploy/setup-admin.sh 'YourChosenPass'`.

**Gotchas:**
- nginx workers run as `nobody:nogroup` — the htpasswd file must be `chown root:nogroup, chmod 640`,
  else the worker gets `permission denied` reading it → **500** (looks like an alias bug, it's not).
  setup-admin.sh sets this; verify: `sudo ls -l /etc/nginx/.htpasswd-admin`.
- Collector needs Docker access → `ubuntu` in `docker` group + unit `SupplementaryGroups=docker`
  (group change needs a fresh session; the systemd unit handles it).

Verify each node:
```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost/admin                        # 401 (no auth)
curl -sk -u admin:<PASS> -o /dev/null -w '%{http_code}\n' https://localhost/admin        # 200
curl -sk -u admin:<PASS> https://localhost/admin/api/stats | head -c 80                   # JSON
```

---

## 7. Fleet view (both nodes on one dashboard)

Each collector polls the OTHER node's API server-side so `/admin` shows the whole fleet regardless
of which node DNS RR sent you to. Set `FLEET_PEERS` + `FLEET_AUTH` on **both** nodes:

```bash
# ON node-62 (origin) — peer is node-65:
sudo mkdir -p /etc/systemd/system/webrtc-swc-admin.service.d
printf '[Service]\nEnvironment=FLEET_PEERS=node-65=https://<node-65-IP>/admin/api/stats\nEnvironment=FLEET_AUTH=admin:<PASS>\n' \
  | sudo tee /etc/systemd/system/webrtc-swc-admin.service.d/fleet.conf
sudo systemctl daemon-reload && sudo systemctl restart webrtc-swc-admin

# ON node-65 (relay) — peer is node-62, AND set role=relay:
sudo mkdir -p /etc/systemd/system/webrtc-swc-admin.service.d
printf '[Service]\nEnvironment=FLEET_PEERS=node-62=https://<node-62-IP>/admin/api/stats\nEnvironment=FLEET_AUTH=admin:<PASS>\nEnvironment=NODE_ROLE=relay\n' \
  | sudo tee /etc/systemd/system/webrtc-swc-admin.service.d/fleet.conf
sudo systemctl daemon-reload && sudo systemctl restart webrtc-swc-admin
```
Verify: `curl -sk -u admin:<PASS> https://localhost/admin/api/fleet` → both node names.

> **NODE_ROLE matters:** an origin reports `publishing+bw=0` as **DEAD** (local OBS crashed); a relay
> reports it as **OFFLINE** (upstream just idle — no local OBS to die). Without `NODE_ROLE=relay`
> the relay shows false DEAD/DEGRADED when OBS is off.

---

## 8. Publisher IP allowlist (which OBS IPs may push)

Managed from the admin UI, enforced by nginx-rtmp `on_publish`.

### 8a. Seed the allowlist file on BOTH nodes
```bash
# ON each node:
printf '[\n  "<OBS_IP>",\n  "<backup_IP>"\n]\n' | sudo tee /opt/webrtc-simple/publishers.json
sudo chown ubuntu /opt/webrtc-simple/publishers.json
sudo systemctl restart webrtc-swc-admin
```
Empty file / `[]` = OPEN (any IP can push). Non-empty = only listed IPs.

### 8b. Wire on_publish on the ORIGIN (node-62 — the box OBS hits)
```bash
# ON node-62: swap the static allow-publish block for the on_publish gate
sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak.onpublish
# edit application live: replace `allow publish ...; deny publish all;` with:
#     on_publish http://127.0.0.1:3002/publish/check;
#     allow play all;
sudo nginx -t && sudo systemctl reload nginx
```
> ⚠️ The reload **drops the current publish** → OBS reconnects (a few seconds). Not zero-downtime —
> do it before an event, not mid-stream. on_publish only gates NEW publishes.

After this, add/remove publisher IPs live from `/admin` — changes apply instantly (no reload) and
**replicate across the fleet** (via FLEET_PEERS). The replicated write passes the IP in the URL
query (`?ip=`), because nginx `proxy_pass` drops DELETE bodies.

Verify:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d 'addr=<OBS_IP>' http://127.0.0.1:3002/publish/check  # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d 'addr=8.8.8.8'  http://127.0.0.1:3002/publish/check  # 403
```

---

## 9. One-command fleet reboot (origin → relay SSH)

Give the origin SSH access to the relay so one command reboots both:
```bash
# ON node-62 (origin): make a key
test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C 'origin-to-fleet'
cat ~/.ssh/id_ed25519.pub    # copy this

# ON node-65 (relay): authorize it
echo '<paste origin pubkey>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys

# back ON node-62: verify + deploy the reboot script
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ubuntu@<node-65-IP> hostname   # should print node-65
# copy deploy/full-fleet-reboot-onnode.sh to ~/full-fleet-reboot.sh, edit N64=ubuntu@<node-65-IP>
# and the unit names / hostkey if needed, then:
chmod +x ~/full-fleet-reboot.sh
```
Run any time to free the Kurento RSS leak + rebuild pipelines:
```bash
bash ~/full-fleet-reboot.sh
```
Origin-first ordering (relay re-pulls from a healthy source). Drops stream ~15-30s; OBS reconnects.

---

## 10. End-to-end verification (before going live)

1. **Start OBS** → `rtmp://<node-62-IP>:1935/live`, key `stream`, from an allowlisted IP.
2. **Origin source:** `curl -sk https://localhost/stat | grep bw_video` on node-62 → nonzero.
3. **Relay source:** same on node-65 → nonzero. If 0, `sudo systemctl restart nginx` on node-65
   (arms the static pull now the origin is live).
4. **Both dashboards LIVE:** `/admin` shows FLEET HEALTHY, both nodes LIVE.
5. **Real browser plays:** open `https://yourdomain.com/embed`. To force-test a specific node, launch
   Chrome with `--host-resolver-rules="MAP yourdomain.com <NODE_IP>" --ignore-certificate-errors`
   and confirm video: `video.readyState===4`, `videoWidth>0`, `currentTime` advancing.
6. **Viewer split:** load a few times; `/count` on each node shows viewers on both.

---

## 11. The gotchas that WILL bite (learned the hard way on 63/64)

| Symptom | Cause | Fix |
|---|---|---|
| Black video, `ws` stuck 101/Pending | Stale Kurento pipeline (`MEDIA_OBJECT_NOT_FOUND`) after an OBS drop | Restart signaling (`webrtc-swc`/`webrtc-simple`) → rebuilds pipelines. Or full-fleet-reboot. |
| Relay `/stat` bw_video=0 while origin LIVE | static pull armed before origin had a source | `sudo systemctl restart nginx` on the relay |
| Admin `/admin` returns 500 | nginx worker (`nobody`) can't read htpasswd | `chown root:nogroup`, `chmod 640` the htpasswd |
| Admin panel STALE, "fetch … credentials" error | you opened `https://user:pass@host/admin` | use the plain URL + the basic-auth prompt |
| `/embed` bare `/` → 403 "refused to connect" | strict-origin strips Referer on bare `/` | partner/admin iframes MUST use `/embed`, not bare `/` |
| bw_video=0, `nclients=0`, dup nginx masters on :1935 | RTMP publish isolated to one of many workers | `worker_processes 1`; verify `ps -C nginx|grep -c master`==1 |
| OBS "disconnected" immediately | publishing IP not in allowlist | add its IP in `/admin` (or the publishers.json) |
| Relay shows DEAD when OBS off | missing `NODE_ROLE=relay` | set it in the admin unit drop-in |
| Publisher DELETE doesn't replicate | nginx proxy drops DELETE body | already fixed — replication passes IP in `?ip=` query |
| Everything looks broken after `setup-ssl.sh` re-run | regen WIPES hand edits (on_publish, /admin block, publish-lock) | re-run `setup-admin.sh` + re-apply on_publish + reseed publishers.json (backups: `nginx.conf.bak.*`) |

**Golden rules:**
- nginx **reload**, never **restart** for config — restart can spawn dup :1935 masters. Verify
  `ps -C nginx | grep -c master == 1` after every reload.
- After any `scp` of a script to a node: `sed -i 's/\r$//'` (strip CRLF) before running.
- Trust the **`bw_video` on `/stat`** and the **`playing`/`/count`** number over your eyes — a
  `<video>` shows the last frame frozen after the connection dies.
- Only a **Kurento container restart** frees the per-pipeline RSS leak (cache-clear does nothing) —
  run the full-fleet-reboot before big events.

---

## 12. File / port reference

| Thing | Path / value |
|---|---|
| App code | `/opt/webrtc-simple/` |
| Repo clone | `~/webrtc-swc/` |
| Static webroot | `/var/www/webrtc-simple/` (viewer.html, embed.html, admin.html) |
| nginx config | `/etc/nginx/nginx.conf` (backups `.bak.*`) |
| Publisher allowlist | `/opt/webrtc-simple/publishers.json` |
| htpasswd | `/etc/nginx/.htpasswd-admin` (root:nogroup 640) |
| Signaling unit | `webrtc-swc` (renamed) or `webrtc-simple` (default) |
| Admin collector unit | `webrtc-swc-admin` (:3002) |
| Ports | 1935 RTMP · 443 HTTPS · 80 HTTP/acme · 3478 TURN · 8888-8891 Kurento WS · 3000 signaling · 3001 /count · 3002 admin |
| Kurento containers | `kurento-0..3` (`--network host`, WS 8888-8891) |
| Deploy scripts | `deploy/setup.sh`, `setup-ssl.sh`, `setup-relay-node.sh`, `setup-admin.sh`, `full-fleet-reboot-onnode.sh` |

---

## 13. Quick sequence (copy-paste order)

```
BOTH nodes:   push code (§2) → setup.sh (§3)
DNS:          two A records → yourdomain.com (§4a)
node-62:      setup-ssl.sh (§4b)  → setup-admin.sh (§6) → seed publishers.json (§8a) → wire on_publish (§8b)
node-65:      copy cert (§4c) → setup-relay-node.sh (§5) → setup-admin.sh (§6) → seed publishers.json (§8a)
BOTH:         FLEET_PEERS drop-in (§7)  [node-65 also NODE_ROLE=relay]
node-62:      origin→relay SSH key + reboot script (§9)
FINALLY:      OBS on → verify end-to-end (§10)
```
