#!/usr/bin/env bash
# Re-apply the node-63 admin dashboard (collector + nginx /admin block + auth).
# Idempotent. Run after a fresh setup or after setup-ssl.sh regenerates nginx.conf
# (which wipes hand edits — same class as the publish-lock / admin.peryago re-apply).
#
# Usage (on node-63, as ubuntu):
#   bash deploy/setup-admin.sh [ADMIN_PASSWORD]
# If no password given and no htpasswd exists yet, one is generated and printed.
set -euo pipefail

NGINX_CONF=/etc/nginx/nginx.conf
HTPASSWD=/etc/nginx/.htpasswd-admin
WEBROOT=/var/www/webrtc-simple
SRC=/opt/webrtc-simple/src

# 1. Stage the collector + admin page FROM THE REPO CLONE into the running dirs.
# (setup.sh copies these on a fresh box, but re-running this after a code update
# must refresh them too — so copy from the repo, don't assume they're current.)
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
sudo mkdir -p "$SRC" "$WEBROOT"
sudo cp "$REPO_DIR/src/admin-collector.js" "$SRC/admin-collector.js"
sudo cp "$REPO_DIR/public/admin.html" "$WEBROOT/admin.html"

# 2. docker group for the collector user
sudo usermod -aG docker ubuntu || true

# 3. systemd unit
sudo cp "$(dirname "$0")/webrtc-swc-admin.service" /etc/systemd/system/webrtc-swc-admin.service
# Fleet view (optional): set FLEET_PEERS to the OTHER nodes' admin APIs so this
# node's /admin shows the whole fleet. Symmetric — set it on every node with the
# others as peers. FLEET_AUTH = the shared basic-auth creds to reach a peer.
#   FLEET_PEERS="node-64=https://134.185.89.40/admin/api/stats" \
#   FLEET_AUTH="admin:PASS" bash deploy/setup-admin.sh
if [ -n "${FLEET_PEERS:-}" ]; then
  sudo mkdir -p /etc/systemd/system/webrtc-swc-admin.service.d
  printf '[Service]\nEnvironment=FLEET_PEERS=%s\nEnvironment=FLEET_AUTH=%s\n' \
    "$FLEET_PEERS" "${FLEET_AUTH:-}" | sudo tee /etc/systemd/system/webrtc-swc-admin.service.d/fleet.conf >/dev/null
  # Holds the admin password in cleartext — must not be world-readable.
  sudo chmod 600 /etc/systemd/system/webrtc-swc-admin.service.d/fleet.conf
fi
sudo systemctl daemon-reload
sudo systemctl enable --now webrtc-swc-admin
sudo systemctl restart webrtc-swc-admin
systemctl is-active webrtc-swc-admin

# 4. basic-auth file (apr1 via openssl; nginx-compatible, no apache2-utils needed).
#    Perms: readable by the nginx worker user (nobody:nogroup).
# If a password arg is given, always (re)set it — even on a re-run. Otherwise
# generate one only when no htpasswd exists yet (preserve it across re-runs).
if [ -n "${1:-}" ] || [ ! -f "$HTPASSWD" ]; then
  PW="${1:-$(openssl rand -base64 15 | tr -d '/+=' | cut -c1-18)}"
  printf 'admin:%s\n' "$(openssl passwd -apr1 "$PW")" | sudo tee "$HTPASSWD" >/dev/null
  echo "ADMIN_PASSWORD=$PW   (user: admin)"
fi
sudo chown root:nogroup "$HTPASSWD"
sudo chmod 640 "$HTPASSWD"

# 5. insert nginx /admin block after the /stat location (idempotent)
sudo python3 - "$NGINX_CONF" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
if '/admin/api/' in s:
    print('nginx /admin block already present'); sys.exit(0)
anchor='''        location /stat {
            allow 127.0.0.1;
            deny all;
            rtmp_stat all;
        }'''
block='''

        # Single-node admin dashboard (basic-auth). Static page + aggregated
        # localhost-only metrics via the collector on 127.0.0.1:3002.
        location = /admin {
            auth_basic "node-63 admin";
            auth_basic_user_file /etc/nginx/.htpasswd-admin;
            default_type text/html;
            alias /var/www/webrtc-simple/admin.html;
        }
        location /admin/api/ {
            auth_basic "node-63 admin";
            auth_basic_user_file /etc/nginx/.htpasswd-admin;
            proxy_pass http://127.0.0.1:3002/api/;
            proxy_read_timeout 10s;
        }'''
assert anchor in s, 'anchor (location /stat) not found — nginx.conf layout changed'
open(p,'w').write(s.replace(anchor, anchor+block, 1))
print('inserted nginx /admin block')
PYEOF

# 6. validate + reload (NEVER restart — restart can spawn dup :1935 masters,
#    making the RTMP source invisible). Confirm exactly one master survives.
sudo nginx -t
sudo systemctl reload nginx
sleep 1
masters=$(ps -C nginx -o cmd | grep -c master || true)
echo "nginx masters: $masters (must be 1)"
[ "$masters" = "1" ] || echo "WARNING: expected 1 nginx master, got $masters — check for dup :1935"
echo "admin dashboard ready at https://sabongflix.com/admin"
