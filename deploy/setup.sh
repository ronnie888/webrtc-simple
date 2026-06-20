#!/usr/bin/env bash
# One-shot VPS bootstrap. Run as a sudo-capable user on a fresh Ubuntu VPS.
# Usage: PUBLIC_IP=x.x.x.x TURN_PASS=secret bash deploy/setup.sh
set -euo pipefail

PUBLIC_IP="${PUBLIC_IP:?set PUBLIC_IP to the VPS public IP}"
TURN_USER="${TURN_USER:-webrtc}"
TURN_PASS="${TURN_PASS:-changeme}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "== 1. system packages =="
sudo apt-get update
sudo apt-get install -y nginx libnginx-mod-rtmp coturn nodejs npm curl

echo "== 2. docker + kurento =="
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sudo sh; fi
sudo docker rm -f kurento-media-server 2>/dev/null || true
sudo docker run -d --name kurento-media-server --network host --restart always \
  --ulimit nofile=65536:65536 --log-opt max-size=50m --log-opt max-file=5 \
  -e KMS_STUN_IP=stun.l.google.com -e KMS_STUN_PORT=19302 \
  -e KMS_EXTERNAL_IP="${PUBLIC_IP}" \
  kurento/kurento-media-server:7.0
sudo iptables -I INPUT -p tcp --dport 8888 -j ACCEPT || true
sudo iptables -I INPUT -p udp --dport 5000:65535 -j ACCEPT || true

echo "== 3. node app =="
sudo mkdir -p /opt/webrtc-simple
sudo cp -r "$REPO_DIR"/src "$REPO_DIR"/config.js "$REPO_DIR"/package.json /opt/webrtc-simple/
( cd /opt/webrtc-simple && sudo npm install --omit=dev )
sudo mkdir -p /var/www/webrtc-simple
sudo cp "$REPO_DIR/public/viewer.html" /var/www/webrtc-simple/

echo "== 4. nginx (RTMP) =="
sudo cp "$REPO_DIR/deploy/nginx-rtmp.conf" /etc/nginx/nginx.conf
sudo nginx -t
sudo systemctl restart nginx

echo "== 5. coturn =="
sudo cp "$REPO_DIR/deploy/turnserver.conf" /etc/turnserver.conf
sudo sed -i "s/PUBLIC_IP_PLACEHOLDER/${PUBLIC_IP}/" /etc/turnserver.conf
sudo sed -i "s/^user=.*/user=${TURN_USER}:${TURN_PASS}/" /etc/turnserver.conf
echo 'TURNSERVER_ENABLED=1' | sudo tee /etc/default/coturn
sudo systemctl restart coturn

echo "== 6. signaling service =="
sudo cp "$REPO_DIR/deploy/webrtc-simple.service" /etc/systemd/system/
sudo mkdir -p /etc/systemd/system/webrtc-simple.service.d
sudo tee /etc/systemd/system/webrtc-simple.service.d/env.conf >/dev/null <<EOF
[Service]
Environment=PUBLIC_IP=${PUBLIC_IP}
Environment=TURN_URL=turn:${PUBLIC_IP}:3478
Environment=TURN_USER=${TURN_USER}
Environment=TURN_PASS=${TURN_PASS}
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now webrtc-simple

echo "== done =="
echo "OBS push to:  rtmp://${PUBLIC_IP}:1935/live  stream key: stream"
echo "Viewers open: http://${PUBLIC_IP}/"
echo "Kurento check: curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8888/kurento  (expect 426)"
