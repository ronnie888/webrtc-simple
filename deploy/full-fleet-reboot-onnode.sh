#!/usr/bin/env bash
# Full-fleet reboot for webrtc-swc — run on node-63, reboots BOTH nodes.
# node-63 = ORIGIN (OBS pushes here). node-64 = RELAY (pulls from node-63).
# Reboots origin first so the relay re-pulls from a healthy source.
#
# Frees the per-pipeline Kurento RSS leak + rebuilds all media pipelines.
# ⚠️ Drops the live stream + viewers ~15-30s. OBS auto-reconnects (its IP must
#    be in the publisher allowlist); viewers reload.
#
#   bash ~/full-fleet-reboot.sh
set -uo pipefail

N64='ubuntu@134.185.89.40'
SSH64="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new $N64"
AUTH='admin:f28mFXpNHM3dx8efPa'

wait_bw(){ # $1=label  $2=cmd-prefix ("" local, or ssh64)
  for t in $(seq 1 40); do
    bw=$($2 bash -c "curl -sk https://localhost/stat | grep -oE '<bw_video>[0-9]+' | grep -oE '[0-9]+' | head -1")
    echo "  $1 bw_video: ${bw:-0}"
    [ "${bw:-0}" -gt 0 ] 2>/dev/null && return 0
    sleep 3
  done
}

echo "############ FULL FLEET REBOOT — webrtc-swc ############"
echo "Stream + viewers drop now. OBS reconnects; viewers reload."

# ---- node-63 ORIGIN (local) ----
echo "== [node-63 ORIGIN] restart 4 Kurento (frees RSS) =="
for i in 0 1 2 3; do sudo docker restart kurento-$i >/dev/null; done
echo "== [node-63] wait Kurento healthy =="
for t in $(seq 1 20); do
  n=$(sudo docker ps --filter health=healthy --format '{{.Names}}' | grep -c '^kurento-')
  echo "  healthy: $n/4"; [ "$n" = "4" ] && break; sleep 3
done
echo "== [node-63] restart signaling + collector =="
sudo systemctl restart webrtc-swc
sudo systemctl restart webrtc-swc-admin
echo "== [node-63] wait for source (OBS reconnect) =="
wait_bw "node-63" ""

# ---- node-64 RELAY (over ssh) ----
echo "== [node-64 RELAY] restart 4 Kurento (frees RSS) =="
$SSH64 'for i in 0 1 2 3; do sudo docker restart kurento-$i >/dev/null; done; echo restarted'
echo "== [node-64] wait Kurento healthy =="
$SSH64 'for t in $(seq 1 20); do n=$(sudo docker ps --filter health=healthy --format "{{.Names}}" | grep -c "^kurento-"); echo "  healthy: $n/4"; [ "$n" = "4" ] && break; sleep 3; done'
echo "== [node-64] restart nginx (re-arm relay pull) + signaling + collector =="
$SSH64 'sudo systemctl restart nginx; sleep 3; sudo systemctl restart webrtc-simple; sudo systemctl restart webrtc-swc-admin; echo -n "nginx masters: "; ps -C nginx -o cmd | grep -c master'
echo "== [node-64] wait for relay bytes =="
wait_bw "node-64" "$SSH64"

# ---- verify ----
echo "############ VERIFY ############"
curl -sk -u "$AUTH" https://localhost/admin/api/fleet | python3 -c 'import sys,json;d=json.load(sys.stdin);print("total viewers:",d["totalViewers"]);[print(" ",n["name"],n.get("role"),n["source"],"bw="+str(n.get("bwVideo")),n["status"]) for n in d["nodes"]]'
echo
echo "DONE. If a source shows OFFLINE/0 -> OBS not reconnected, start it."
echo "If node-64 bw stays 0 with node-63 LIVE -> ssh node-64 && sudo systemctl restart nginx"
