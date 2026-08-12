#!/usr/bin/env bash
# fix-obs-stuck.sh — run ON THE ORIGIN (node-62 or node-63) when the fleet shows
# node DEAD / all relays OFFLINE (the "stuck stream" pattern).
#
# What it does:
#   1. Clears the stuck stream on THIS origin (restart nginx). Safe: if a stream
#      is genuinely stuck (bw_video=0, no external OBS), there is nothing to
#      strand. OBS auto-reconnects within seconds.
#   2. Waits for the origin source to come back (OBS reconnect).
#   3. Re-arms EVERY relay's pull (restart nginx on each — relays do not self-heal
#      after an origin blip).
#   4. Prints the fleet state.
#
# Usage:  bash ~/fix-obs-stuck.sh
#
# Reads the relay list from ~/full-fleet-reboot.sh (RELAYS="..."), so it works on
# whichever origin you run it on without editing.
set -uo pipefail

BW='curl -sk https://localhost/stat 2>/dev/null | grep -oE "<bw_video>[0-9]+</bw_video>" | grep -oE "[0-9]+" | sort -rn | head -1'
SSH='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'

RELAYS="$(grep -oP 'RELAYS="\K[^"]+' ~/full-fleet-reboot.sh 2>/dev/null)"
if [ -z "$RELAYS" ]; then
  echo "!! Could not read RELAYS from ~/full-fleet-reboot.sh — edit this line manually:"
  echo "   RELAYS=\"<space-separated relay PRIVATE IPs>\""
  exit 1
fi

echo "############ FIX OBS STUCK — origin=$(hostname) ############"
echo "relays: $RELAYS"

# 1) current state
bw="$(eval "$BW")"
echo "== origin source now: bw_video=${bw:-0} =="

# 2) clear the stuck stream on the origin (restart, NOT reload)
echo "== restart origin nginx (clears stuck stream) =="
sudo systemctl restart nginx

# 3) wait for OBS to reconnect (up to ~60s)
echo "== waiting for OBS to reconnect =="
for t in $(seq 1 20); do
  bw="$(eval "$BW")"
  echo "  origin bw_video: ${bw:-0}"
  [ "${bw:-0}" -gt 0 ] 2>/dev/null && { echo "  -> ORIGIN SOURCE LIVE"; break; }
  sleep 3
done
if [ "${bw:-0}" -eq 0 ] 2>/dev/null; then
  echo "!! origin still has NO source after 60s."
  echo "   OBS is not pushing. Check OBS:"
  echo "     - Server must be rtmp://<THIS-ORIGIN-PUBLIC-IP>:1935/live  key: stream"
  echo "     - Its exit IP must be in the publisher allowlist (admin dashboard)"
  echo "   Re-run this script once OBS is pushing again."
fi

# 4) re-arm every relay (they do NOT self-heal after an origin blip)
echo "== re-arm relays =="
for R in $RELAYS; do
  echo "  [relay $R] restart nginx"
  $SSH ubuntu@"$R" 'sudo systemctl restart nginx' </dev/null
done
echo "  waiting ~20s for relays to re-lock..."
sleep 20

# 5) verify each relay
echo "== relay sources =="
for R in $RELAYS; do
  rbw="$($SSH ubuntu@"$R" "$BW" </dev/null 2>/dev/null)"
  echo "  $R  bw_video=${rbw:-0}  $([ "${rbw:-0}" -gt 0 ] 2>/dev/null && echo LIVE || echo 'OFFLINE (re-run if OBS was late)')"
done

echo "############ DONE ############"
echo "If any relay is still OFFLINE and the origin IS live, re-run this script"
echo "(or just: ssh ubuntu@<relay> 'sudo systemctl restart nginx')."
