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

# 1. collector + static page in place (assumes repo already rsync'd to /opt/webrtc-simple)
sudo cp "$SRC/admin-collector.js" "$SRC/admin-collector.js" 2>/dev/null || true
[ -f "$WEBROOT/admin.html" ] || { echo "admin.html missing in $WEBROOT — rsync public/ first"; exit 1; }

# 2. docker group for the collector user
sudo usermod -aG docker ubuntu || true

# 3. systemd unit
sudo cp "$(dirname "$0")/webrtc-swc-admin.service" /etc/systemd/system/webrtc-swc-admin.service
sudo systemctl daemon-reload
sudo systemctl enable --now webrtc-swc-admin
systemctl is-active webrtc-swc-admin

# 4. basic-auth file (apr1 via openssl; nginx-compatible, no apache2-utils needed).
#    Perms: readable by the nginx worker user (nobody:nogroup).
if [ ! -f "$HTPASSWD" ]; then
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
