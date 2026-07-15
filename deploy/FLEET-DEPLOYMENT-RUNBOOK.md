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
| Admin basic-auth pass | `<generated in §6 — never commit>` | generated in §6 |
| Partner embed domains | 37 partners | space-separated list |
| Let's Encrypt email | — | `______` |

> **⚠️ Signaling unit name.** On every box built by `setup.sh` (node-62, node-65, and any fresh
> box) the signaling unit is **`webrtc-simple`**. `webrtc-swc` was a one-off hand-rename on node-63
> ONLY. **All commands in this runbook use `webrtc-simple`.** When unsure on a box:
> `systemctl list-units 'webrtc-s*' --type=service`. (The admin *collector* unit is
> `webrtc-swc-admin` on every box — that name is correct everywhere, don't rename it.)

> **node-62 is NOT a fresh box** — it already runs the base webrtc-simple stack (48-core, 4 Kurento,
> signaling `webrtc-simple` active, serves `mystreamingserver.live`). On node-62 you SKIP the Docker/
> Kurento/coturn install (§3), but you MUST still push the latest code AND copy it into the running
> dirs, or the new admin/fleet/allowlist features never land. Exact node-62 upgrade path:
> ```bash
> # after §2 pushes the repo to ~/webrtc-swc on node-62:
> sudo cp -r ~/webrtc-swc/src/* /opt/webrtc-simple/src/            # refresh the app code
> sudo cp ~/webrtc-swc/public/admin.html /var/www/webrtc-simple/   # place the dashboard page
> sudo systemctl restart webrtc-simple                             # node-62's signaling unit
> ```
> Then run §6 (admin) → §7 (fleet) → §8 (allowlist). **Back up node-62's live config first:**
> `sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak.preadmin` — setup-admin.sh edits the
> production config that serves `mystreamingserver.live`; verify `grep -n 'location /stat'` shows the
> `allow 127.0.0.1; deny all;` form and that `nginx -t` passes before any reload.
> **node-65 is fresh** → full §2-3 bootstrap.
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
- `TURN_PASS` has **no default** (setup.sh requires it) — a missing password used to ship coturn
  with `changeme` = open relay abuse. Verify: `sudo grep '^user=' /etc/turnserver.conf` must NOT show
  `changeme`.
- Fresh OCI = no Docker → setup.sh installs it (that's the slow part).
- `worker_processes 1` in nginx-rtmp.conf is **required** — RTMP streams aren't shared across
  workers; `auto` on a 48-core box isolated the publish to 1/48 → `nclients=0`.
- kurento-client postinstall aborts npm on some tarballs → setup.sh uses `npm i --ignore-scripts`.
- setup.sh does `systemctl restart nginx` (not reload) — that's fine here: it's the initial install
  and `worker_processes 1` makes the dup-master problem impossible. The "never restart" golden rule
  (§11) applies only to later config edits on a LIVE box.
- ⚠️ **Publishing is wide OPEN** (`allow publish all`) from this step until you wire on_publish (§8b).
  Do not expose :1935 to the internet before then, OR seed the allowlist + wire on_publish first.

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

### 4c. Cert on the RELAY (node-65)
The relay answers the SAME domain via round-robin, so it needs a valid cert for it.

> **Recommended: Option B (self-issue).** It gets its own auto-renewing cert and never moves a
> private key between boxes. Option A (copy) is faster but the copied cert silently expires in ~90
> days and involves shipping the TLS private key around — only use it if you'll track renewal.

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
# SECURITY: the tarball contains the TLS PRIVATE KEY — shred the copies after placing it:
sudo shred -u /tmp/cert.tgz          # on BOTH node-62 and node-65
sudo chmod 600 /etc/letsencrypt/live/yourdomain.com/privkey.pem
# also delete the Windows-side copy you pscp'd through.
```
> ⚠️ A copied cert goes stale in ~90 days (origin auto-renews, the copy doesn't). Monitor it:
> `openssl x509 -enddate -noout -in /etc/letsencrypt/live/yourdomain.com/fullchain.pem`.

**Option B — issue independently on node-65 (recommended):** run the same setup-ssl.sh on node-65
(DNS RR lets HTTP-01 pass) — it gets its own auto-renew timer, no private-key handling:
```bash
# ON node-65:
DOMAIN=yourdomain.com EMAIL=you@example.com \
  PARTNERS="...same partner list as the origin..." bash deploy/setup-ssl.sh
```

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

> **Precondition: run `setup-ssl.sh` (§4b/§4c) FIRST.** `setup-admin.sh` inserts the `/admin` block
> by anchoring on the HTTPS `/stat` block (`allow 127.0.0.1; deny all; rtmp_stat all;`), which only
> exists after SSL. On a plain setup.sh box it aborts "anchor not found". Verify first:
> `grep -n 'location /stat' /etc/nginx/nginx.conf` shows the `allow 127.0.0.1; deny all;` form.

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

> **Secure the drop-in:** `fleet.conf` holds the admin password in cleartext — `sudo chmod 600
> /etc/systemd/system/webrtc-swc-admin.service.d/fleet.conf` on both nodes (setup-admin.sh does this
> when it writes it, but the manual printf above doesn't). Peer polling uses `rejectUnauthorized:false`
> over the peer's public IP — only wire FLEET_PEERS when the two nodes share a **trusted network path**
> (same VPC/region); across the open internet an on-path attacker can capture FLEET_AUTH. Prefer the
> private `10.0.9.x` interface if the nodes are co-located.

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
⚠️ **FAIL-OPEN:** an empty **OR malformed** publishers.json = **ANY IP can publish** (stream
hijack). A typo, a truncated write, or a bad chown silently reopens publishing with no error in
`/admin`. After seeding, the negative test in §8b (8.8.8.8 → 403) is a **mandatory gate** before
go-live. This gate is **ORIGIN-ONLY** — the relay's `deny publish all` means it never accepts a
publish, so its publishers.json is only for fleet-view display / failover.

### 8b. Wire on_publish on the ORIGIN (node-62 — the box OBS hits)
```bash
# ON node-62: swap the allow-publish line for the on_publish gate.
sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak.onpublish
# In `application live`, the stock config has ONLY `allow publish all;` (there is NO
# `deny publish all;` line). Replace that one line with:
#     on_publish http://127.0.0.1:3002/publish/check;
# and KEEP `allow play all;`.
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

# ON node-65 (relay): authorize it (create ~/.ssh first — a fresh box may lack it)
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '<paste origin pubkey>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys

# back ON node-62: verify
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ubuntu@<node-65-IP> hostname   # should print node-65
```
Then copy `deploy/full-fleet-reboot-onnode.sh` to `~/full-fleet-reboot.sh` and edit the labelled
block at the top:

1. `RELAY='ubuntu@<node-65-IP>'`
2. `ORIGIN_UNIT` / `RELAY_UNIT` — leave as `webrtc-simple` for a fresh 62/65 fleet (setup.sh
   default). Only set to `webrtc-swc` if you are literally on node-63.
3. `AUTH` — reads the admin password from the fleet.conf drop-in automatically; override with
   `AUTH='admin:<pass>'` env only if that lookup fails.

(No hostkey to edit — this script authenticates the relay via the origin's own SSH key + accept-new,
set up above. The hostkey-pinned variant is `full-fleet-reboot-swc.sh`, which runs from Windows via
plink instead.)

```bash
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
7. **TURN actually works** (Chrome-desktop uses a DIRECT candidate and MASKS a broken relay — the
   exact failure that black-screens Telegram/iOS/UDP-blocked mobile viewers). Force a relay-only
   test: `turnutils_uclient -v -u webrtc -w <TURN_PASS> <NODE_IP>` must return a relay candidate; or
   a Trickle-ICE test with `iceTransportPolicy:'relay'` must still play. **Desktop success does NOT
   prove TURN.**
8. **Load-test before the event** — point the repo's load harness (or a `/count` ramp) at each node's
   OWN `/embed` and confirm it holds your target viewers. Per project experience: **≤30 tabs/box**,
   stagger connects, use anti-occlusion Chrome flags; add more boxes, not more tabs. Going live having
   proven exactly one browser is how you discover the ceiling during the event.

---

## 11. The gotchas that WILL bite (learned the hard way on 63/64)

| Symptom | Cause | Fix |
|---|---|---|
| Black video, `ws` stuck 101/Pending | Stale Kurento pipeline (`MEDIA_OBJECT_NOT_FOUND`) after an OBS drop | Usually self-heals on the next viewer connect (addViewer detects + rebuilds). If it doesn't, restart signaling (`webrtc-simple`) → rebuilds pipelines. Or full-fleet-reboot. |
| Admin shows source OFFLINE / bw=0 while OBS is live | collector fetches `/stat` over HTTPS; that node isn't on the SSL nginx.conf yet (`:80` only) | Run `setup-ssl.sh` first, or set `STAT_URL=http://127.0.0.1/stat` on a pre-SSL node |
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
- Signaling unit is **`webrtc-simple`** on every setup.sh box (62/64/65). `webrtc-swc` exists only on
  the hand-renamed node-63. Unsure? `systemctl list-units 'webrtc-s*' --type=service`.
- Prefer nginx **reload** for config edits. **RESTART is required and safe** to (re)arm the relay
  static pull (§5/§10.3) — `worker_processes 1` means no dup-:1935-master risk; that danger only
  exists with `worker_processes auto`. Always verify `ps -C nginx | grep -c master == 1` after either.
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
| Signaling unit | **`webrtc-simple`** on this fleet (setup.sh default — never renames). `webrtc-swc` = legacy node-63-only hand-rename. |
| Admin collector unit | `webrtc-swc-admin` (:3002) |
| Ports | 1935 RTMP · 443 HTTPS · 80 HTTP/acme · 3478 TURN · 8888-8891 Kurento WS · 3000 signaling · 3001 /count · 3002 admin |
| Kurento containers | `kurento-0..3` (`--network host`, WS 8888-8891) |
| Deploy scripts | `deploy/setup.sh`, `setup-ssl.sh`, `setup-relay-node.sh`, `setup-admin.sh`, `full-fleet-reboot-onnode.sh` |

---

## 13. Quick sequence (copy-paste order)

```
node-65 fresh:  push code (§2) → setup.sh (§3, needs TURN_PASS)
node-62 exists: push code (§2) → copy src→/opt + admin.html→webroot + restart webrtc-simple (see §1 note)
DNS:            two A records → yourdomain.com (§4a), wait for both to resolve
node-62:        setup-ssl.sh (§4b) → setup-admin.sh (§6) → seed+verify publishers.json (§8a) → wire on_publish (§8b)
node-65:        setup-ssl.sh self-issue (§4c Option B) → setup-admin.sh (§6) → setup-relay-node.sh (§5) → seed publishers.json (§8a)
BOTH:           FLEET_PEERS drop-in (§7)  [node-65 also gets NODE_ROLE=relay from setup-relay-node.sh]
node-62:        origin→relay SSH key + reboot script (§9)
FINALLY:        OBS on → verify end-to-end incl. TURN + load test (§10)
```
> Relay order: **SSL (§4c) → admin (§6) → relay-convert (§5)**. setup-admin.sh anchors on the SSL
> `/stat` block, so SSL must precede it. setup-relay-node.sh writes the `NODE_ROLE=relay` drop-in
> unconditionally, so it's safe to run after admin.

---

## 14. Operate the event

Building the fleet ≠ running the show. Before and during a live event:

- **Backup the allowlist before any `setup-ssl.sh` re-run** — regen wipes hand edits:
  `sudo cp /opt/webrtc-simple/publishers.json{,.bak}` then restore after.
- **Monitor** — the dashboard is pull-only (someone must watch). For paging, cron a check that curls
  the fleet API and alerts on trouble:
  ```bash
  # */1 * * * * — alert if any node not HEALTHY or no source live
  curl -sk -u admin:$PASS https://localhost/admin/api/fleet \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);import sys;sys.exit(0 if d["anyLive"] and all(n.get("status")=="HEALTHY" for n in d["nodes"]) else 1)' \
    || your-telegram-or-webhook-alert "FLEET DEGRADED"
  ```
- **Rollback a bad node** — remove that node's A record in the DNS panel; TTL 300 ≈ ~5 min drain.
  Keep the good node's record. (This is why TTL is 300.)
- **Dynamic OBS source IP** — the allowlist is per-IP. If the venue's OBS IP is DHCP/changes, its
  reconnect silently 403s. Either add the current IP live from `/admin` at event start, or (behind a
  trusted firewall) leave `publishers.json` = `[]` (open). Watch `/admin` for the source flipping
  OFFLINE mid-event.
- **How viewers get the stream** — partners embed `<iframe src="https://yourdomain.com/embed">` (real
  iframe WS carries partner Origin → allowed). A shared-token gate is available via `?lt=TOKEN`
  (`EMBED_TOKENS` env). Bare `/` is partner-**referer**-gated and 403s without it — always give
  people `/embed`, never bare `/`.
- **Free the RSS leak before the event** — `bash ~/full-fleet-reboot.sh` (§9). Only a Kurento
  container restart frees it.
