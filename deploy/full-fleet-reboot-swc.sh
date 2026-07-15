#!/usr/bin/env bash
# Full-fleet reboot for the webrtc-swc fleet (node-63 origin + node-64 relay).
#
# Frees the per-pipeline Kurento RSS leak (only a container restart frees it —
# cache-clear does nothing) AND rebuilds all media pipelines fresh. Run before
# a big event, or when a node's memory is climbing, or to clear a keyframe/
# MEDIA_OBJECT_NOT_FOUND stall after an OBS drop.
#
# ⚠️ DROPS the live stream + all viewers for ~15-30s. OBS auto-reconnects
#    (its IP must be in the publisher allowlist); viewers must reload the page.
#
# Order matters: node-63 is the ORIGIN (OBS pushes here). node-64 RELAYS from
# node-63, so bring node-63 back FIRST, then re-pull node-64 from a healthy
# origin. Run this from the Windows box (has the ppk + hostkeys) OR adapt the
# plink calls to ssh.
#
# Usage (Git Bash / WSL with plink on PATH):
#   bash deploy/full-fleet-reboot-swc.sh
set -uo pipefail

KEY='D:\ppk\vprivateprod.ppk'
N63='ubuntu@138.2.88.192'; HK63='SHA256:BVZ/iaGoIec8uHq96kt5ZlZhQJUKzUof9lqTXCMDM8o'; UNIT63='webrtc-swc'
N64='ubuntu@134.185.89.40'; HK64='SHA256:DjYX3mamweedpgwiIcPtcWgi+gDdj0GwDi2KT7i/KPI'; UNIT64='webrtc-simple'
ORIGIN_IP='138.2.88.192'

ssh63(){ plink -batch -hostkey "$HK63" -i "$KEY" "$N63" "$1"; }
ssh64(){ plink -batch -hostkey "$HK64" -i "$KEY" "$N64" "$1"; }

reboot_node(){ # $1=label  $2=ssh-fn  $3=signaling-unit  $4=is_relay(0/1)
  local L="$1" S="$2" UNIT="$3" RELAY="$4"
  echo "== [$L] restart 4 Kurento (frees RSS leak) =="
  $S "for i in 0 1 2 3; do sudo docker restart kurento-\$i >/dev/null; done; echo kurento-restarted"
  echo "== [$L] wait for Kurento healthy =="
  for t in $(seq 1 20); do
    n=$($S "sudo docker ps --filter health=healthy --format '{{.Names}}' | grep -c '^kurento-'")
    echo "  healthy kurento: $n/4"; [ "$n" = "4" ] && break; sleep 3
  done
  if [ "$RELAY" = "1" ]; then
    echo "== [$L] restart nginx (re-arm relay static pull from origin) =="
    $S "sudo systemctl restart nginx; sleep 3; echo -n 'nginx masters: '; ps -C nginx -o cmd | grep -c master"
  fi
  echo "== [$L] restart signaling (rebuild pipelines) =="
  $S "sudo systemctl restart $UNIT; sleep 3; systemctl is-active $UNIT"
  echo "== [$L] restart admin collector =="
  $S "sudo systemctl restart webrtc-swc-admin; sleep 1; systemctl is-active webrtc-swc-admin"
}

echo "############ FULL FLEET REBOOT — webrtc-swc ############"
echo "NOTE: stream + viewers drop now. OBS must reconnect; viewers reload."

# 1) ORIGIN first so the source is back before the relay re-pulls.
reboot_node "node-63 ORIGIN" ssh63 "$UNIT63" 0

echo "== waiting for node-63 source to come back (OBS reconnect) =="
for t in $(seq 1 40); do
  bw=$(ssh63 "curl -sk https://localhost/stat | grep -oE '<bw_video>[0-9]+' | grep -oE '[0-9]+' | sort -rn | head -1")
  echo "  node-63 bw_video: ${bw:-0}"; [ "${bw:-0}" -gt 0 ] 2>/dev/null && break; sleep 3
done

# 2) RELAY second, now that the origin is serving.
reboot_node "node-64 RELAY" ssh64 "$UNIT64" 1

echo "== waiting for node-64 relay to pull bytes =="
for t in $(seq 1 40); do
  bw=$(ssh64 "curl -sk https://localhost/stat | grep -oE '<bw_video>[0-9]+' | grep -oE '[0-9]+' | sort -rn | head -1")
  echo "  node-64 bw_video: ${bw:-0}"; [ "${bw:-0}" -gt 0 ] 2>/dev/null && break; sleep 3
done

echo "############ VERIFY ############"
echo "-- fleet health (via node-63 admin) --"
ssh63 "curl -sk -u admin:f28mFXpNHM3dx8efPa https://localhost/admin/api/fleet | python3 -c 'import sys,json;d=json.load(sys.stdin);print(\"total viewers:\",d[\"totalViewers\"]);[print(\" \",n[\"name\"],n.get(\"role\"),n[\"source\"],\"bw=\"+str(n.get(\"bwVideo\")),n[\"status\"]) for n in d[\"nodes\"]]'"
echo
echo "DONE. If a source shows OFFLINE/0, OBS has not reconnected — start it."
echo "If node-64 bw stays 0 with node-63 LIVE, re-run: restart nginx on node-64"
echo "(static pull arms at master start — see setup-relay-node.sh notes)."
