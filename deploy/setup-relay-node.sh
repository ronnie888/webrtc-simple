#!/usr/bin/env bash
# Turn a node built by setup.sh into a RELAY node that pulls its source from
# an origin node (the box OBS pushes to) instead of accepting OBS locally.
# Used to scale viewers horizontally: origin serves OBS; each relay node pulls
# the origin's RTMP and serves its own Kurento/WebRTC. Viewers split across all
# nodes via DNS round-robin (add each node's IP as an A record on the domain).
#
# Usage (on the relay node, after setup.sh + setup-ssl.sh have run):
#   ORIGIN_IP=138.2.88.192 bash deploy/setup-relay-node.sh
#
# Idempotent. Edits the RTMP `application live` block in /etc/nginx/nginx.conf:
# swaps the OBS publish-lock for a `static pull` from the origin.
set -euo pipefail

ORIGIN_IP="${ORIGIN_IP:?set ORIGIN_IP to the origin node public IP (the box OBS pushes to)}"
NGINX_CONF=/etc/nginx/nginx.conf

sudo cp "$NGINX_CONF" "$NGINX_CONF.bak.prerelay"

sudo python3 - "$NGINX_CONF" "$ORIGIN_IP" <<'PYEOF'
import sys, re
p, origin = sys.argv[1], sys.argv[2]
s = open(p).read()
if f'pull rtmp://{origin}' in s:
    print('relay pull already present'); sys.exit(0)
# Match the whole `application live { ... }` body and rewrite the publish/pull
# lines while keeping the low-latency tuning (wait_key/wait_video/sync).
m = re.search(r'(application live \{\n(?:.*\n)*?)(\s*)(allow publish[^\n]*\n(\s*allow publish[^\n]*\n)*)?(\s*)(deny publish[^\n]*\n)?(\s*allow play all;)', s)
assert m, 'could not find application live block'
head = m.group(1)
pull = (f'            # RELAY node: no local OBS. Continuously pull the origin\'s\n'
        f'            # stream into local live/stream so this box\'s Kurento pulls\n'
        f'            # localhost, same as the origin. static = keep alive + reconnect.\n'
        f'            pull rtmp://{origin}/live/stream name=stream static live=1;\n'
        f'            deny publish all;\n'
        f'            allow play all;')
new_block = head + pull
s = s[:m.start()] + new_block + s[m.end():]
open(p, 'w').write(s)
print(f'rewrote application live -> static pull from {origin}')
PYEOF

sudo nginx -t
# static pull inits at MASTER START, not on reload — must restart to arm it.
# Safe here: worker_processes 1, so no dup-:1935-master risk on this box.
sudo systemctl restart nginx
sleep 3
masters=$(ps -C nginx -o cmd | grep -c master || true)
echo "nginx masters: $masters (must be 1)"
echo "relay pull ESTAB to origin:"
sudo ss -tnp 2>/dev/null | grep "${ORIGIN_IP}:1935" | head -1 || echo "  (not yet — origin may have no live source)"
echo "Done. When the origin's OBS is live, this node's /stat bw_video goes nonzero."
echo "NOTE: if the pull connected while the origin had NO source, restart nginx"
echo "      again once the origin is live to re-arm the pull."
