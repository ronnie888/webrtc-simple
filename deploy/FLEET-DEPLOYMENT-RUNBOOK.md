# webrtc-simple Fleet Deployment Runbook

**Build a 2-node fleet (origin + relay) on a new domain — the shape node-63/64 and node-62/65 run.**

Complete A-to-Z. Everything hand-fixed live on 63/64 **and 62/65** is captured here as repeatable
steps plus the exact gotchas that bit us. Follow top to bottom.

> **Two fleets exist already** — see §0b for what they look like. **§15 is the distilled experience:
> read it before you start**, not after something breaks.

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

**Capacity** (measured on node-65, passthrough): **~0.038 core/viewer** → plan **~900 viewers/node**
(~1,800 for a 2-node fleet). Setup RATE, not viewer count, is what spikes load. Details + how it was
measured: §0b. Real event traffic has since confirmed it — 455 viewers/node ran at ~35% host load.

---

## 0b. Reference builds (what already exists)

Two fleets run this stack. Copy their shape; don't re-derive it.

| | **sabongflix.com** | **mystreamingserver.live** |
|---|---|---|
| Origin (OBS ingest) | node-63 · 138.2.88.192 | node-62 · 161.118.215.36 (priv 10.0.9.123) |
| Relay | node-64 · 134.185.89.40 | node-65 · 161.118.240.86 (priv 10.0.9.150) |
| Signaling unit | `webrtc-swc` (node-63 ONLY — hand-renamed) / `webrtc-simple` (node-64) | `webrtc-simple` (both) |
| Relay cert | copy of origin's | copy of origin's + renew-hook (§4c) |
| Built | 2026-07-13→15 | 2026-07-15 |

Both: Ubuntu 24.04, 48 vCPU / 31 GB, 4 Kurento (passthrough), DNS round-robin on DigitalOcean
(TTL 300), same 36-partner whitelist, admin dashboard + fleet view, publisher allowlist.

**Measured capacity** (werift load-gen, passthrough, no client decode): **~0.038 core/viewer**.
A 48-core node saturates around **400-440** with the load-gen CO-LOCATED (a conservative floor);
budget **~900/node** realistically, i.e. **~1,800 for a 2-node fleet**. Steady-state serving is cheap —
**connection setup rate** (DTLS bursts) is what spikes load, so gradual ramps hold far more than a
fast one. For a true hard number, run the harness from an EXTERNAL box, never on the node under test.

**These are LIVE PROD.** Never point a new fleet's config, `FLEET_PEERS`, or relay `ORIGIN_IP` at
them — `grep` each generated file for their IPs before running it.

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

> **⚠️ USE OPTION A (copy) + the renew-hook. Option B does NOT work once DNS RR is live.**
> This was learned the hard way on the 62/65 build (2026-07-15): `setup-ssl.sh` on the relay
> FAILED with
> ```
> Detail: <ORIGIN_IP>: Invalid response from http://yourdomain.com/.well-known/acme-challenge/…: 404
> ```
> Round-robin resolved the domain to the **origin**, so Let's Encrypt fetched the challenge from the
> WRONG box — the token only exists on the relay's webroot. HTTP-01 + round-robin is a coin flip and
> the origin can never serve the relay's challenge.
>
> Your options, in order of preference:
> 1. **Option A + renew-hook (below)** — copy the origin's cert, and have the origin PUSH each
>    renewal to the relay. Solves the "copy goes stale" problem. This is what 62/65 runs.
> 2. **DNS-01** — certbot proves via a TXT record instead of HTTP, so RR is irrelevant and the relay
>    self-renews. Cleanest, but needs a DNS-provider API token + plugin
>    (e.g. `certbot-dns-digitalocean`). Do this if you want zero private-key movement.
> 3. **Option B (HTTP-01 self-issue)** — ONLY viable BEFORE you add the relay's A record (issue the
>    cert while the domain still resolves to one box), or if you temporarily pull the origin's A
>    record (disrupts live viewers — don't do this on a live origin).

**Option A — copy from origin (what 62/65 runs):**
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
> ⚠️ A copied cert goes stale in ~90 days (the origin auto-renews, the copy does NOT). Fix that with
> the renew-hook below — do not rely on remembering. Check any time with:
> `openssl x509 -enddate -noout -in /etc/letsencrypt/live/yourdomain.com/fullchain.pem`.

**Then: make the copy self-maintaining (renew-hook on the ORIGIN).**
The origin already auto-renews; this makes it push each fresh cert to the relay. Requires the
origin→relay SSH key from §9 (set that up first, or re-run this after).

```bash
# ON node-62 (origin) — replaces the stock reload-only hook:
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null <<'HOOK'
#!/bin/sh
# Reload local nginx, then push the renewed cert to the relay, whose cert is a
# COPY (DNS round-robin makes HTTP-01 self-issue impossible on the relay).
systemctl reload nginx
RELAY=10.0.9.150            # relay PRIVATE ip
DOM=yourdomain.com
# Root reads the privkey and tars; ubuntu (owns the fleet SSH key) transports.
tar -czhf /tmp/cert-renew.tgz -C /etc/letsencrypt/live/$DOM . || exit 0
chown ubuntu /tmp/cert-renew.tgz
sudo -u ubuntu scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new /tmp/cert-renew.tgz ubuntu@$RELAY:/tmp/cert-renew.tgz && \
sudo -u ubuntu ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ubuntu@$RELAY \
  "sudo tar -xzf /tmp/cert-renew.tgz -C /etc/letsencrypt/live/$DOM && sudo chmod 600 /etc/letsencrypt/live/$DOM/privkey.pem && sudo systemctl reload nginx && shred -u /tmp/cert-renew.tgz"
shred -u /tmp/cert-renew.tgz 2>/dev/null
HOOK
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# TEST IT NOW (idempotent — just re-pushes the current cert):
sudo /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh && echo 'hook OK'
# then on the relay, confirm the date matches the origin's:
# sudo openssl x509 -enddate -noout -in /etc/letsencrypt/live/yourdomain.com/fullchain.pem
```
> Why the root/ubuntu split: the hook runs as **root** (certbot), but the fleet SSH key belongs to
> **ubuntu**. Root must do the `tar` (only root can read `privkey.pem`), then hand the tarball to
> ubuntu for transport. A hook that tries `sudo -u ubuntu tar …` silently produces nothing.

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
6b. **AUDIO** (this shipped broken once — always check it):
   - Source carries audio: `sudo curl -sk https://localhost/stat | grep -oE '<audio>.*</audio>'`
     → expect e.g. `<codec>AAC</codec><channels>2</channels>`, and `bw_audio` > 0.
     If absent, it's **OBS-side** (mixer muted / no audio track on the encoder) — fix there first.
   - Viewer actually gets sound: open `/embed`, confirm the centre **"Tap for sound"** pill, tap it,
     and hear audio. Programmatic proof (paste in devtools):
     ```js
     const v=document.querySelector('video'), at=v.srcObject.getAudioTracks()[0];
     const ctx=new AudioContext(); await ctx.resume();        // MUST resume, else false 0
     const an=ctx.createAnalyser(); ctx.createMediaStreamSource(new MediaStream([at])).connect(an);
     const b=new Uint8Array(an.frequencyBinCount); let peak=0;
     setInterval(()=>{an.getByteFrequencyData(b);peak=Math.max(peak,...b);console.log('peak',peak)},300);
     // peak > 0 = real sound on the track. 0 with a suspended ctx means nothing.
     ```
   - `Cache-Control: no-store` on `/embed`, else viewers keep an old player:
     `curl -skI https://localhost/embed -H 'Referer: https://<partner>/' | grep -i cache-control`
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
| **NO AUDIO** (video fine) | `embed.html` `<video>` is `muted` AND has `pointer-events:none`, so nothing can unmute it | Already fixed: `#soundBtn` (centre pill). If it regresses, check the served page has `soundBtn`. **Diagnose in this order:** `/stat` `<audio>` block + `bw_audio` (is OBS even sending?) → Kurento `SdpEndpoint.conf.json` (`numAudioMedias:1`, `opus/48000/2`) → client `muted`. Do NOT just delete `muted` — autoplay-with-sound is blocked, you'd lose video too. |
| Viewer reports a client bug you CANNOT reproduce (no pill, no audio) on a device you can't inspect | **They are on a stale build.** `no-store` does not evict a copy the webview already holds | **Check delivery before theorising:** `sudo grep '<their-ip>' /var/log/nginx/access.log \| grep 'GET /embed'` — the number after `200` is the bytes served; compare to `stat -c %s /var/www/webrtc-simple/embed.html`. Force a fresh copy with any new query string: `/embed?v=2`. Use `/embed?diag=1` for an on-screen readout. This exact trap burned four rounds of CSS "fixes" for a phantom. |
| A code/page change "didn't deploy" — viewers still see the old player | `/embed` had **no `Cache-Control`** (only ETag/Last-Modified) → browsers cache the viewer client | `location = /embed` must send `Cache-Control: no-store, no-cache, must-revalidate`. Verify: `curl -skI https://localhost/embed -H 'Referer: https://<partner>/' \| grep -i cache-control`. Without it you will chase phantom bugs on a page the viewer never received. |
| **nginx RELOAD on the ORIGIN kills the source** (`bw_video=0`, `nclients=0`) while OBS TCP is still ESTAB | nginx-rtmp does NOT migrate a publish to the new worker; OBS stays pinned to a `worker process is shutting down` | `sudo systemctl restart nginx` (safe: `worker_processes 1` = no dup-master). OBS reconnects in ~15-60s. **On an origin, prefer restart over reload, and batch config edits PRE-EVENT.** Check for the stranding: `ps -C nginx -o cmd \| grep -c 'shutting down'` must be 0. |
| **OBS "Failed to connect / check your stream key"** with the allowlist on | The lock matches the **NAT exit IP**, not the LAN IP the operator sees | `journalctl -u webrtc-swc-admin \| grep on_publish` prints the REAL arriving IP (`… -> DENY`). Add THAT. Confirm from the OBS box itself: `curl ifconfig.me`. (On 62/65 the operator's "OBS IP" was a LAN address; the real one was completely different.) |
| Partner iframe "refused to connect" although their domain IS whitelisted | It's a **subdomain** (e.g. `admin.partner.com`); `(www\.)?partner\.com` does NOT match it — a subdomain is a distinct origin | Add the exact host to ALL THREE: referer map, origin map (gates `/ws`), CSP `frame-ancestors`. Verify: WS with that Origin → **400** (passed the gate, hit the handler) vs **403** (still blocked). |
| Measuring audio shows `energy: 0` / "silent" but audio is actually fine | A fresh `AudioContext` starts **suspended** under autoplay policy → the analyser reads nothing | `await ctx.resume()` before measuring; only trust readings when `ctx.state === 'running'`. |
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
- **On an ORIGIN, use `restart`, not `reload`.** A reload strands the live OBS publish on a draining
  worker → the source goes invisible (`bw_video=0`) while OBS still shows connected. `restart` is safe
  (`worker_processes 1` = no dup-:1935-master; that danger only exists with `worker_processes auto`).
  Restart is also what (re)arms a relay's static pull (§5/§10.3). After either, verify BOTH:
  `ps -C nginx -o cmd | grep -c master` == 1 **and** `ps -C nginx -o cmd | grep -c 'shutting down'` == 0.
- **Every origin nginx change costs an OBS reconnect.** Batch them and do them **before** an event,
  never mid-stream. Expect 15-60s for OBS to come back; sometimes it needs a manual Start Streaming.
- **`/embed` must be `no-store`.** It is the viewer client — a cached copy pins viewers to an old
  player and you will debug a page they never loaded.
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
| Viewer client | `public/embed.html` → `/var/www/webrtc-simple/embed.html`. **Must be served `no-store`.** Contains the `#soundBtn` unmute pill — a change here reaches viewers only if no-store is set. |
| Audio path | OBS **AAC-LC stereo 44.1k** → RTMP → Kurento transcodes → **Opus 48k** → WebRTC. Codecs live in the container: `/etc/kurento/modules/kurento/SdpEndpoint.conf.json` (`numAudioMedias:1`). `passthrough.connect(endpoint)` with no media-type arg = audio **and** video. |
| nginx backups | `nginx.conf.bak.*` — one per hand-edit (`.onpublish`, `.admindash`, `.adminperyago`, `.embednostore`, `.premute` for embed.html). `setup-ssl.sh` regen WIPES all hand edits; these are how you put them back. |

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

---

## 15. Hard-won lessons — read before building the NEXT fleet

Everything below cost real debugging time on 62/65 (and 63/64). None of it is obvious from the
happy path.

### The three that will waste your afternoon

1. **The operator's "OBS IP" is usually wrong.** They report the machine's LAN address; the server
   only ever sees the **NAT exit IP**. The publish-lock matches the exit IP, so OBS gets a 403 that
   surfaces as *"Failed to connect — check your stream key"* (nothing to do with the key).
   **Ground truth:** `journalctl -u webrtc-swc-admin | grep on_publish` → `<real-ip> -> DENY`.
   Never seed `publishers.json` from a number someone recites; take it from that log, or run
   `curl ifconfig.me` **on the OBS box**.

2. **Every nginx reload on the ORIGIN silently kills the stream.** The publish stays pinned to a
   `worker process is shutting down`, so `/stat` (served by the NEW worker) reports `bw_video=0`
   and `nclients=0` while OBS still shows a healthy TCP connection. It looks exactly like a dead
   encoder. Fix is `systemctl restart nginx`; the real fix is **don't touch origin nginx during an
   event**. Batch every config edit (whitelist, on_publish, admin block, cache headers) into ONE
   pre-event restart.

3. **A viewer bug you cannot reproduce is probably a cached page — PROVE DELIVERY FIRST.**
   `/embed` shipped with no `Cache-Control`, so viewers held an old client indefinitely. This cost
   hours twice: an audio fix was deployed and verified server-side while the operator still had a
   player with no unmute button, and later "no pill on Android/iOS/Telegram" survived four rounds of
   CSS fixes — because every report came from a **stale build**, not from the code being tested.

   nginx's own log answers it in one command — it records the **bytes served** per request:
   ```bash
   # what did THAT device actually receive?
   sudo grep '<their-ip>' /var/log/nginx/access.log | grep 'GET /embed' | tail
   # are mobiles on the current build at all?
   sudo grep 'GET /embed' /var/log/nginx/access.log | tail -150 \
     | grep -iE 'android|iphone' | grep -oE '" 200 [0-9]+' | sort | uniq -c
   ```
   Every row must show the CURRENT `stat -c %s /var/www/webrtc-simple/embed.html`. Anything smaller
   is a stale client, and your fix is not the thing being tested.

   ⚠️ **`no-store` only affects FUTURE fetches — it cannot evict a copy a webview already holds.**
   To force one device: add any new query string (`/embed?v=2`). That single trick ended a
   multi-hour hunt: the pill appeared instantly, on all three platforms, including through a real
   partner iframe.

   `/embed?diag=1` paints an on-screen readout (build id, viewport, video readyState, audio track
   state, pill class/display/rect) for devices with no devtools — ask for a screenshot.

### Verification that actually proves something

- **`bw_video` / `bw_audio` on `/stat` beat your eyes.** A `<video>` holds its last frame forever
  after the connection dies; "I can see it" proves nothing.
- **Pin the browser per node** — `--host-resolver-rules="MAP yourdomain.com <NODE_IP>"` — or DNS RR
  will hand you the same node twice and you'll call the fleet verified.
- **Desktop success does NOT prove TURN.** Chrome picks a direct candidate and masks a broken relay;
  the mobile/Telegram/UDP-blocked viewers are the ones who suffer. Force
  `iceTransportPolicy:'relay'` and require a `typ relay` candidate.
- **`turnutils_uclient` false-fails** when coturn has `allowed-peer-ip` hardening: the test peer 403s
  ("channel bind: Forbidden IP") even though TURN is fine. Use the browser relay-only test instead.
- **Audio measurement lies if the AudioContext is suspended** (`peak: 0` = "silent"). `await
  ctx.resume()` first, and only trust `ctx.state === 'running'`.
- **A dead source makes everything downstream look broken.** Before blaming code: is `bw_video > 0`?

### Design facts worth knowing up front

- **TURN passwords may differ per node and that is FINE** — each client fetches creds from the node
  that served it. What matters is that a node's coturn `user=` matches ITS OWN signaling `TURN_PASS`.
  (On 62/65 they differ: node-62 kept its original password because it was upgraded in place.)
- **Upgrading an existing box ≠ a fresh build.** `diff -rq` the repo `src/` against `/opt/...` first.
  On node-62 the only difference was one NEW file (the admin collector), which the signaling unit
  doesn't even load — so the "required" `systemctl restart webrtc-simple` was skipped entirely and
  live viewers were never dropped. Check before you disrupt.
- **Subdomains are separate origins.** `partner.com` in the whitelist does NOT admit
  `admin.partner.com`. Add the exact host to referer map + origin map + CSP.
- **Only add domains from the authoritative partner list.** Real traffic will show plenty of
  lookalike domains (alt-TLDs of real partners, unknown re-embedders). They are 403ing correctly.
  Adding one because "it appears in the logs" grants embed rights to a pirate.
- **`setup-ssl.sh` overwrites `/etc/nginx/nginx.conf` wholesale** (it `cp`s the template, twice).
  Every hand edit dies: on_publish, `/admin`, subdomain whitelist entries, cache headers. Back up
  first, and re-apply after. A **reboot does NOT wipe them** — only an ssl regen does.
