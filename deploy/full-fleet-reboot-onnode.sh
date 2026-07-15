#!/usr/bin/env bash
# Full-fleet reboot for a webrtc-simple 2-node fleet — run ON THE ORIGIN, reboots BOTH.
# ORIGIN = OBS ingest. RELAY = pulls the origin (set RELAY=ubuntu@<relay-priv-ip> below).
# Reboots origin first so the relay re-pulls from a healthy source.
#
# Frees the per-pipeline Kurento RSS leak + rebuilds all media pipelines.
# ⚠️ Drops the live stream + viewers ~15-30s. OBS auto-reconnects (its IP must
#    be in the publisher allowlist); viewers reload.
#
#   bash ~/full-fleet-reboot.sh
set -uo pipefail

# ── EDIT THESE for your fleet ────────────────────────────────────────────────
RELAY='ubuntu@RELAY_IP'          # e.g. ubuntu@134.185.89.40
ORIGIN_UNIT="${ORIGIN_UNIT:-webrtc-simple}"   # signaling unit on THIS (origin) box
RELAY_UNIT="${RELAY_UNIT:-webrtc-simple}"     # signaling unit on the relay box
#   NOTE: setup.sh always installs the signaling unit as `webrtc-simple`.
#   Only node-63 was hand-renamed to `webrtc-swc` — set ORIGIN_UNIT=webrtc-swc
#   ONLY if you are on that specific box.
# AUTH is read from the admin unit's fleet.conf drop-in so no password is
# committed here. Falls back to a placeholder you can override with AUTH=... env.
AUTH="${AUTH:-admin:$(sudo grep -ohP 'FLEET_AUTH=admin:\K\S+' /etc/systemd/system/webrtc-swc-admin.service.d/fleet.conf 2>/dev/null)}"
# ─────────────────────────────────────────────────────────────────────────────
SSH64="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new $RELAY"

# Reads bw_video either locally ($2="local") or on the RELAY ($2="remote").
# The whole pipeline is a single-quoted string so ssh passes it intact.
BW_CMD='curl -sk https://localhost/stat | grep -oE "<bw_video>[0-9]+" | grep -oE "[0-9]+" | head -1'
wait_bw(){ # $1=label  $2=local|remote
  for t in $(seq 1 40); do
    if [ "$2" = "remote" ]; then bw=$($SSH64 "$BW_CMD"); else bw=$(eval "$BW_CMD"); fi
    echo "  $1 bw_video: ${bw:-0}"
    [ "${bw:-0}" -gt 0 ] 2>/dev/null && return 0
    sleep 3
  done
}

echo "############ FULL FLEET REBOOT — webrtc-swc ############"
echo "Stream + viewers drop now. OBS reconnects; viewers reload."

# ---- ORIGIN (local) ----
echo "== [ORIGIN] restart 4 Kurento (frees RSS) =="
for i in 0 1 2 3; do sudo docker restart kurento-$i >/dev/null; done
echo "== [ORIGIN] wait Kurento healthy =="
for t in $(seq 1 20); do
  n=$(sudo docker ps --filter health=healthy --format '{{.Names}}' | grep -c '^kurento-')
  echo "  healthy: $n/4"; [ "$n" = "4" ] && break; sleep 3
done
echo "== [ORIGIN] restart signaling + collector =="
sudo systemctl restart "$ORIGIN_UNIT"
sudo systemctl restart webrtc-swc-admin
echo "== [ORIGIN] wait for source (OBS reconnect) =="
wait_bw "ORIGIN" local

# ---- RELAY (over ssh) ----
echo "== [RELAY] restart 4 Kurento (frees RSS) =="
$SSH64 'for i in 0 1 2 3; do sudo docker restart kurento-$i >/dev/null; done; echo restarted'
echo "== [RELAY] wait Kurento healthy =="
$SSH64 'for t in $(seq 1 20); do n=$(sudo docker ps --filter health=healthy --format "{{.Names}}" | grep -c "^kurento-"); echo "  healthy: $n/4"; [ "$n" = "4" ] && break; sleep 3; done'
echo "== [RELAY] restart nginx (re-arm relay pull) + signaling + collector =="
$SSH64 "sudo systemctl restart nginx; sleep 3; sudo systemctl restart $RELAY_UNIT; sudo systemctl restart webrtc-swc-admin; echo -n 'nginx masters: '; ps -C nginx -o cmd | grep -c master"
echo "== [RELAY] wait for relay bytes =="
wait_bw "RELAY" remote

# ---- verify ----
echo "############ VERIFY ############"
curl -sk -u "$AUTH" https://localhost/admin/api/fleet | python3 -c 'import sys,json;d=json.load(sys.stdin);print("total viewers:",d["totalViewers"]);[print(" ",n["name"],n.get("role"),n["source"],"bw="+str(n.get("bwVideo")),n["status"]) for n in d["nodes"]]'
echo
echo "DONE. If a source shows OFFLINE/0 -> OBS not reconnected, start it."
echo "If RELAY bw stays 0 with ORIGIN LIVE -> ssh the relay && sudo systemctl restart nginx"
