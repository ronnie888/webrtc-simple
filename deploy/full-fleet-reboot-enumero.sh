#!/usr/bin/env bash
# Full-fleet reboot — run ON THE ORIGIN (node-74). Reboots origin + ALL relays.
# Frees the per-pipeline Kurento RSS leak + rebuilds all media pipelines.
# Drops the live stream ~15-30s; OBS auto-reconnects, viewers reload.
#
# v2 (2026-08-12) — 4 changes over v1:
#   1. PRE-CHECK: refuses to run when OBS is not pushing. Rebooting against a
#      dead source builds every pipeline on nothing, and the fleet then sits
#      broken until someone restarts each relay by hand. Skip with FORCE=1.
#   2. ORIGIN restarts nginx between Kurento and signaling, clearing the stale
#      <publishing/> marker that otherwise rejects OBS's reconnect with
#      "Could not access the specified channel or stream key".
#   3. VERIFY greps each relay's Kurento log for the stale-PlayerEndpoint
#      errors, which are silent in /stat but mean that relay serves no video.
#   4. bw_video reads take the MAX, not the first match: /stat has several
#      blocks and `head -1` can report 0 while the stream is fine.
set -uo pipefail

RELAYS="10.0.9.14 10.0.9.203 10.0.9.78 10.0.9.43"          # node-76 node-77 node-78 node-79 (PRIVATE)
ORIGIN_UNIT="${ORIGIN_UNIT:-webrtc-simple}"
RELAY_UNIT="${RELAY_UNIT:-webrtc-simple}"
AUTH="${AUTH:-admin:$(sudo grep -ohP 'FLEET_AUTH=admin:\K\S+' /etc/systemd/system/webrtc-swc-admin.service.d/fleet.conf 2>/dev/null)}"
# MAX across blocks — `head -1` reads whichever block came first and lies.
BW_CMD='curl -sk https://localhost/stat | grep -oE "<bw_video>[0-9]+" | grep -oE "[0-9]+" | sort -rn | head -1'
SSH='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'

wait_bw_local(){ for t in $(seq 1 40); do bw=$(eval "$BW_CMD"); echo "  ORIGIN bw_video: ${bw:-0}"; [ "${bw:-0}" -gt 0 ] 2>/dev/null && return 0; sleep 3; done; return 1; }
wait_bw_remote(){ for t in $(seq 1 40); do bw=$($SSH ubuntu@$1 "$BW_CMD"); echo "  $1 bw_video: ${bw:-0}"; [ "${bw:-0}" -gt 0 ] 2>/dev/null && return 0; sleep 3; done; return 1; }

# ---- PRE-CHECK: is OBS actually pushing? -----------------------------------
# A reboot with no source leaves every node's pipeline built against nothing.
# Recovering that is a manual per-relay job, so refuse up front instead.
BW_NOW=$(eval "$BW_CMD")
if [ "${BW_NOW:-0}" -lt 1000 ] 2>/dev/null; then
  echo "############ ABORTED — NO SOURCE ############"
  echo "origin bw_video = ${BW_NOW:-0} (needs >= 1000)."
  echo "OBS is not pushing. Rebooting now would build every pipeline against a"
  echo "dead source and leave the fleet needing a manual restart per relay."
  echo
  echo "  1. Start OBS and confirm bw_video goes nonzero:"
  echo "     curl -sk https://localhost/stat | grep -oE '<bw_video>[0-9]+' | grep -oE '[0-9]+' | sort -rn | head -1"
  echo "  2. OBS refuses to connect ('Could not access the specified channel or"
  echo "     stream key')? A stale publish marker is holding the name:"
  echo "     bash ~/fix-obs-stuck.sh    # or: sudo systemctl restart nginx"
  echo
  echo "Really reboot with no source (rebuilding a dead fleet)? FORCE=1 bash ~/full-fleet-reboot.sh"
  [ "${FORCE:-0}" = "1" ] || exit 1
  echo ">> FORCE=1 set — continuing without a source."
fi

echo "############ FULL FLEET REBOOT (origin + $(echo $RELAYS|wc -w) relays) ############"
echo "Source OK (bw_video=$BW_NOW). Stream + viewers drop now; OBS reconnects, viewers reload."

# ---- ORIGIN (local, first — relays re-pull from a healthy source) ----
echo "== [ORIGIN node-74] restart 4 Kurento =="
for i in 0 1 2 3; do sudo docker restart kurento-$i >/dev/null; done
for t in $(seq 1 20); do n=$(sudo docker ps --filter health=healthy --format '{{.Names}}'|grep -c '^kurento-'); echo "  healthy: $n/4"; [ "$n" = 4 ] && break; sleep 3; done
# nginx BEFORE signaling: clears the stale <publishing/> so OBS's reconnect is
# not rejected as a duplicate publisher. nginx-rtmp allows only one publisher
# per stream name, and the marker outlives the disconnected session.
echo "== [ORIGIN] restart nginx (clear stale publish marker for OBS reconnect) =="
sudo systemctl restart nginx; sleep 3
echo -n "  nginx masters (must be 1): "; ps -C nginx -o cmd= | grep -c master
echo "== [ORIGIN] restart signaling + collector =="
sudo systemctl restart "$ORIGIN_UNIT"; sudo systemctl restart webrtc-swc-admin
echo "== [ORIGIN] wait for source (OBS reconnect) =="
wait_bw_local || echo "  !! ORIGIN source did not return — start OBS, then re-run the relay half."

# ---- each RELAY over ssh ----
for R in $RELAYS; do
  echo "== [RELAY $R] restart 4 Kurento =="
  $SSH ubuntu@$R 'for i in 0 1 2 3; do sudo docker restart kurento-$i >/dev/null; done; echo restarted'
  $SSH ubuntu@$R 'for t in $(seq 1 20); do n=$(sudo docker ps --filter health=healthy --format "{{.Names}}"|grep -c "^kurento-"); echo "  healthy: $n/4"; [ "$n" = 4 ] && break; sleep 3; done'
  echo "== [RELAY $R] restart nginx (re-arm pull) + signaling + collector =="
  $SSH ubuntu@$R "sudo systemctl restart nginx; sleep 3; sudo systemctl restart $RELAY_UNIT; sudo systemctl restart webrtc-swc-admin; echo -n 'nginx masters: '; ps -C nginx -o cmd=|grep -c master"
  echo "== [RELAY $R] wait for relay bytes =="
  wait_bw_remote $R || echo "  !! $R pulled nothing — ssh ubuntu@$R && sudo systemctl restart nginx"
done

# ---- verify ----
echo "############ VERIFY ############"
curl -sk -u "$AUTH" https://localhost/admin/api/fleet | python3 -c 'import sys,json;d=json.load(sys.stdin);print("total viewers:",d["totalViewers"]);[print(" ",n["name"],n.get("role"),n["source"],"bw="+str(n.get("bwVideo")),n["status"]) for n in d["nodes"]]'

# A relay can report healthy Kurento and still serve nothing: the PlayerEndpoint
# holds a dead upstream from before the restart. That only shows in the logs.
echo
echo "-- per-relay Kurento stale-upstream check --"
for R in $RELAYS; do
  hits=$($SSH ubuntu@$R "sudo docker logs --tail 40 kurento-0 2>&1 | grep -icE 'RTMPSrc Failed|Already in state stop|RTMP_ReadPacket failed'" 2>/dev/null)
  if [ "${hits:-0}" -gt 0 ] 2>/dev/null; then
    echo "  !! $R: $hits stale-upstream error(s) — that relay is serving NO video."
    echo "     fix: ssh ubuntu@$R 'for i in 0 1 2 3; do sudo docker restart kurento-\$i; done; sudo systemctl restart $RELAY_UNIT'"
  else
    echo "  ok $R: no stale-upstream errors"
  fi
done
echo; echo "DONE. Source OFFLINE -> start OBS. RELAY bw 0 w/ ORIGIN live -> ssh relay && sudo systemctl restart nginx"
