# Whitelist a partner across a webrtc-simple fleet — runbook

One script. Three fleets. `enumero`, `sabongflix`, `mystreamingserver`.

## TL;DR

```bash
cd D:/SecurityProjects/kurento-gstreamer/webrtc-simple/deploy
bash whitelist-fleet.sh <fleet> <anchor> <new_domain> [new_domain ...]
```

- **`<fleet>`** = `enumero` | `sabongflix` | `mystreamingserver`
- **`<anchor>`** = any partner already whitelisted on this fleet (used as insertion template)
- **`<new_domain>`** = one or more domains to add

The script twins the anchor for each new entry. Idempotent. Auto-backups. Bails on `nginx -t` fail.

## Example — add 3 new partners to enumero using `panaloclub.com` as template

```bash
bash whitelist-fleet.sh enumero panaloclub.com newpartner1.com newpartner2.net xyz.app
```

Expected end: `DONE. Verify partner iframe on any new domain.`

## Choosing the anchor

Any partner ALREADY present in all 3 layers on that fleet. Safe defaults:
- **enumero** → `panaloclub.com`
- **sabongflix** → `paldohere.net`
- **mystreamingserver** → `paldogames.app`

Confirm on the fleet if unsure:

```bash
plink -ssh -i "D:\ppk\vprivateprod.ppk" -batch ubuntu@<origin-IP> "sudo grep '<anchor>' /etc/nginx/nginx.conf | wc -l"
```

Should return **3** (embed_ok map + origin_ok map + CSP line).

## What gets patched (per node)

Each of origin + 4 relays:
1. `/etc/nginx/nginx.conf` — `$embed_ok` map (Referer gate)
2. `/etc/nginx/nginx.conf` — `$origin_ok` map (WebSocket Origin gate)
3. `/etc/nginx/nginx.conf` — CSP `frame-ancestors` line
4. `/var/www/webrtc-simple/embed.html` — JS `ALLOWED` array
5. Favicon 204 rule (if not present)

Then `nginx -t && systemctl reload nginx` per node.

Backups auto-created:
- `nginx.conf.bak-partners-<timestamp>` (origin)
- `embed.html.bak-partners-<timestamp>` (origin)
- `nginx.conf.bak-wl-<timestamp>` (relays)
- `embed.html.bak-wl-<timestamp>` (relays)

## Fleet routing table (baked into script)

| Fleet | Origin IP | Relay private IPs |
|-------|-----------|-------------------|
| enumero | 140.245.103.149 | 10.0.9.14 10.0.9.203 10.0.9.78 10.0.9.43 |
| sabongflix | 138.2.88.192 | 10.0.9.184 10.0.9.117 10.0.9.220 10.0.9.98 |
| mystreamingserver | 161.118.215.36 | 10.0.9.150 10.0.9.229 10.0.9.254 10.0.9.211 |

## Verify a new domain works

```bash
# L1b Referer gate (may 403 due to known PCRE last-entry quirk — see note below)
curl -sI -H "Referer: https://<new_domain>/" https://<fleet-domain>/embed | head -1

# L2 JS gate (real proof) — open in browser
# https://<partner-page>/... that iframes https://<fleet-domain>/embed
```

## Known quirk (harmless)

**L1b nginx PCRE regex-map may return 403 for the newest entry** on enumero + sabongflix even after `nginx -t` passes. Root: PCRE JIT flakiness at large map sizes (memory 2026-08-07). **User flow unaffected** — `/embed` bare path has no L1b gate, and L2 JS gate is the real defense.

## IP entries

Pass an IP as if it were a domain — script still works. It'll generate `https://www.<IP>` which is bogus but harmless. Example:

```bash
bash whitelist-fleet.sh enumero panaloclub.com 102.129.136.6
```

## Rollback (per fleet)

Restore latest backup on origin + fan out:

```bash
plink -ssh -i "D:\ppk\vprivateprod.ppk" -batch ubuntu@<origin-IP> "
sudo cp \$(ls -t /etc/nginx/nginx.conf.bak-partners-* | head -1) /etc/nginx/nginx.conf
sudo cp \$(ls -t /var/www/webrtc-simple/embed.html.bak-partners-* | head -1) /var/www/webrtc-simple/embed.html
sudo nginx -t && sudo systemctl reload nginx
"
```

Then re-run the fan-out portion manually to relays. (Not scripted for rollback — rare enough.)

## Prerequisites on your Windows box

- `plink` + `pscp` on PATH (comes with PuTTY)
- `D:\ppk\vprivateprod.ppk` = fleet SSH key
- Git Bash or WSL for running `.sh`

## Related

- `deploy/add-partner-domains.py` — the surgical per-node patcher this script wraps
- `memory/sabongflix_fleet_full_session_2026_08_07.md` — L1b PCRE quirk backstory
- `memory/enumero_fleet_and_kurento_race_2026_07_20.md` — enumero fleet build ref
