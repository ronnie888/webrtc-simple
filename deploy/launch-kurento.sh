#!/usr/bin/env bash
# Launch ONE Kurento Media Server instance on a distinct WS port.
# Multiple instances on --network host parallelize connect setup (each Kurento
# serializes internally, so N instances = N× parallel ICE/DTLS handling).
#
# Usage: bash launch-kurento.sh <index> <public_ip>
#   index 0 -> container kurento-0 on WS port 8888
#   index 1 -> container kurento-1 on WS port 8889  ... etc.
#
# Mechanism (verified): the Kurento 7.0 image has NO WS-port env var; the port
# lives in /etc/kurento/kurento.conf.json. We sed it before the entrypoint.
set -euo pipefail

IDX="${1:?usage: launch-kurento.sh <index> <public_ip>}"
PUBLIC_IP="${2:?usage: launch-kurento.sh <index> <public_ip>}"
PORT=$((8888 + IDX))
NAME="kurento-${IDX}"

sudo docker rm -f "$NAME" 2>/dev/null || true
sudo docker run -d --name "$NAME" --network host --restart always \
  --ulimit nofile=65536:65536 --log-opt max-size=50m --log-opt max-file=5 \
  -e KMS_STUN_IP=stun.l.google.com -e KMS_STUN_PORT=19302 \
  -e KMS_EXTERNAL_IP="${PUBLIC_IP}" \
  --entrypoint bash \
  kurento/kurento-media-server:7.0 \
  -c "sed -i 's/\"port\": 8888/\"port\": ${PORT}/' /etc/kurento/kurento.conf.json && exec /entrypoint.sh"

echo "launched ${NAME} (WS port ${PORT})"
