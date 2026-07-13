#!/usr/bin/env bash
# One-shot VPS bootstrap. Run as a sudo-capable user on a fresh Ubuntu VPS.
# Usage: PUBLIC_IP=x.x.x.x TURN_PASS=secret bash deploy/setup.sh
set -euo pipefail

PUBLIC_IP="${PUBLIC_IP:?set PUBLIC_IP to the VPS public IP}"
TURN_USER="${TURN_USER:-webrtc}"
TURN_PASS="${TURN_PASS:-changeme}"
KURENTO_INSTANCES="${KURENTO_INSTANCES:-4}"   # N Kurento on ports 8888..8888+N-1
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "== 1. system packages =="
sudo apt-get update
sudo apt-get install -y nginx libnginx-mod-rtmp coturn nodejs npm curl

echo "== 2. docker + kurento (N instances) =="
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sudo sh; fi
# Remove any legacy single-instance container, then launch N instances on
# ports 8888..8888+N-1 (each Kurento serializes connect setup; N = N× parallel).
sudo docker rm -f kurento-media-server 2>/dev/null || true
KURENTO_URIS=""
for i in $(seq 0 $((KURENTO_INSTANCES - 1))); do
  bash "$REPO_DIR/deploy/launch-kurento.sh" "$i" "$PUBLIC_IP"
  KURENTO_URIS="${KURENTO_URIS}ws://localhost:$((8888 + i))/kurento,"
done
KURENTO_URIS="${KURENTO_URIS%,}"   # strip trailing comma
echo "KURENTO_URIS=${KURENTO_URIS}"
echo "== 2b. firewall (host iptables) =="
# Open every port the stack needs. NOTE: on OCI/cloud VPSes you must ALSO add
# matching ingress rules in the cloud Security List / NSG (web console) — host
# iptables alone is not enough behind a cloud firewall.
sudo iptables -I INPUT -p tcp --dport 8888 -j ACCEPT || true          # Kurento WS (local use)
sudo iptables -I INPUT -p udp --dport 5000:65535 -j ACCEPT || true    # Kurento media
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT || true            # viewer page / acme
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true           # HTTPS (after setup-ssl.sh)
sudo iptables -I INPUT -p tcp --dport 1935 -j ACCEPT || true          # OBS RTMP ingest
sudo iptables -I INPUT -p tcp --dport 3478 -j ACCEPT || true          # TURN
sudo iptables -I INPUT -p udp --dport 3478 -j ACCEPT || true          # TURN
sudo iptables -I INPUT -p udp --dport 49152:65535 -j ACCEPT || true   # TURN relay
sudo apt-get install -y iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save >/dev/null 2>&1 || true

echo "== 2c. kernel/network tuning for viewer surges (persisted) =="
# Bigger accept queue + wide ephemeral port range so the box absorbs bursts of
# new viewers without dropping/500ing connections. Persisted so it survives reboot.
sudo tee /etc/sysctl.d/99-webrtc.conf >/dev/null <<'SYSCTL'
net.core.somaxconn=65535
net.ipv4.tcp_max_syn_backlog=65535
net.ipv4.ip_local_port_range=1024 65535
SYSCTL
sudo sysctl -p /etc/sysctl.d/99-webrtc.conf >/dev/null 2>&1 || true

echo "== 3. node app =="
sudo mkdir -p /opt/webrtc-simple
sudo cp -r "$REPO_DIR"/src "$REPO_DIR"/config.js "$REPO_DIR"/package.json /opt/webrtc-simple/
# kurento-client ships a postinstall (scripts/install-kurento.js) that is absent
# in some published tarballs and aborts npm with exit 127. It is not needed at
# runtime (pure JS), so skip lifecycle scripts.
( cd /opt/webrtc-simple && sudo npm install --omit=dev --ignore-scripts )
sudo mkdir -p /var/www/webrtc-simple
sudo cp "$REPO_DIR/public/viewer.html" "$REPO_DIR/public/embed.html" /var/www/webrtc-simple/

echo "== 4. nginx (RTMP) =="
sudo cp "$REPO_DIR/deploy/nginx-rtmp.conf" /etc/nginx/nginx.conf
sudo nginx -t
sudo systemctl restart nginx

echo "== 5. coturn =="
# Private IP of the NIC carrying media (where Kurento lives) — for the relay
# allow-list that prevents the "403 Forbidden IP" black-video bug.
PRIVATE_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
PRIVATE_IP="${PRIVATE_IP:-$PUBLIC_IP}"
sudo cp "$REPO_DIR/deploy/turnserver.conf" /etc/turnserver.conf
sudo sed -i "s/PUBLIC_IP_PLACEHOLDER/${PUBLIC_IP}/g" /etc/turnserver.conf   # g: external-ip + allowed-peer-ip
sudo sed -i "s/PRIVATE_IP_PLACEHOLDER/${PRIVATE_IP}/g" /etc/turnserver.conf
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
Environment=EMBED_TOKENS=${EMBED_TOKENS:-}
Environment=KURENTO_URIS=${KURENTO_URIS}
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now webrtc-simple

echo "== done =="
echo "1) Start OBS push FIRST:  rtmp://${PUBLIC_IP}:1935/live   stream key: stream"
echo "2) Then open viewers:     http://${PUBLIC_IP}/"
echo "Kurento check: curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8888/kurento  (expect 426)"
echo "Source check:  curl -s http://localhost/stat | grep bw_video   (nonzero once OBS pushes)"
echo "NOTE: if signaling started before OBS, the player rebuilds automatically on the"
echo "      next viewer connect (dead-source detection). If video still blank, restart:"
echo "      sudo systemctl restart webrtc-simple"
echo "For HTTPS + iframe whitelist, after DNS points here run deploy/setup-ssl.sh"
