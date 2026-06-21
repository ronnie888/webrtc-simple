#!/usr/bin/env bash
# Add Let's Encrypt HTTPS + iframe embed whitelist to a running webrtc-simple box.
# Run AFTER deploy/setup.sh, and AFTER DNS for $DOMAIN points at this VPS.
#
# Usage:
#   DOMAIN=mystreamingserver.live EMAIL=you@example.com \
#     PARTNERS="partner1.com partner2.net" bash deploy/setup-ssl.sh
#
# PARTNERS = space-separated bare domains allowed to iframe-embed the viewer.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN to the hostname pointing at this VPS}"
EMAIL="${EMAIL:?set EMAIL for the Lets Encrypt account}"
PARTNERS="${PARTNERS:?set PARTNERS to a space-separated list of embed domains}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "== 1. certbot + webroot =="
sudo apt-get update
sudo apt-get install -y certbot
sudo mkdir -p /var/www/certbot

echo "== 2. ensure HTTP bootstrap config is live (serves acme challenge on :80) =="
# nginx-rtmp.conf already has the acme-challenge location. Make sure it's the
# active config and reachable before requesting the cert.
sudo cp "$REPO_DIR/deploy/nginx-rtmp.conf" /etc/nginx/nginx.conf
sudo nginx -t
sudo systemctl reload nginx

echo "== 3. issue certificate (HTTP-01 webroot) =="
sudo certbot certonly --webroot -w /var/www/certbot \
  -d "$DOMAIN" --email "$EMAIL" --agree-tos -n --no-eff-email

echo "== 4. build referer map + CSP list from PARTNERS =="
# Write the nginx referer-map lines to a temp file (avoids embedding newlines
# in a shell variable). CSP_LIST is a single space-separated line, safe in a var.
REFERER_FILE="$(mktemp)"
CSP_LIST=""
for p in $PARTNERS; do
  esc="$(printf '%s' "$p" | sed 's/\./\\./g')"        # escape dots for nginx regex
  printf '        ~*^https?://(www\\.)?%s  1;\n' "$esc" >> "$REFERER_FILE"
  CSP_LIST="${CSP_LIST}https://${p} https://www.${p} "
done
CSP_LIST="$(printf '%s' "$CSP_LIST" | sed 's/ *$//')"

echo "== 5. render nginx-ssl.conf from template =="
TMP="$(mktemp)"
cp "$REPO_DIR/deploy/nginx-ssl.conf.template" "$TMP"
sed -i "s/__DOMAIN__/${DOMAIN}/g" "$TMP"
sed -i "s|__PARTNERS_CSP__|${CSP_LIST}|g" "$TMP"
# Replace the __PARTNERS_REFERER__ marker line with the file's contents.
awk 'NR==FNR { lines = lines $0 ORS; next }
     /__PARTNERS_REFERER__/ { printf "%s", lines; next }
     { print }' "$REFERER_FILE" "$TMP" | sudo tee /etc/nginx/nginx.conf >/dev/null
rm -f "$TMP" "$REFERER_FILE"

echo "== 6. test + reload =="
sudo nginx -t
sudo systemctl reload nginx

echo "== 7. cert auto-renew via certbot timer =="
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
echo -e '#!/bin/sh\nsystemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo systemctl enable --now certbot.timer 2>/dev/null || true

FIRST_PARTNER="${PARTNERS%% *}"   # first domain in the list
echo "== done =="
echo "HTTPS viewer:   https://${DOMAIN}/   (only embeddable from: ${PARTNERS})"
echo "Verify allowed: curl -sI https://${DOMAIN}/ -H 'Referer: https://${FIRST_PARTNER}/' | head -1   (expect 200)"
echo "Verify blocked: curl -sI https://${DOMAIN}/ | head -1   (expect 403)"
