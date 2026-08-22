#!/usr/bin/env bash
# whitelist-fleet.sh — add partner domain(s) to any of 3 webrtc-simple fleets.
# Wraps deploy/add-partner-domains.py (per-node patcher) with a fleet router
# + relay fan-out.
#
# Usage (from your local Windows Git Bash):
#   bash whitelist-fleet.sh <fleet> <anchor> <new_domain> [new_domain ...]
#
# Fleets:
#   enumero            (origin node-74  140.245.103.149)
#   sabongflix         (origin node-63  138.2.88.192)
#   mystreamingserver  (origin node-62  161.118.215.36)
#
# ANCHOR = any partner ALREADY present in all 3 layers (nginx maps + CSP + embed.html)
# on this fleet. Script twins the anchor for each new domain — matching the
# existing regex escape style + ALLOWED array indent automatically.
#
# Examples:
#   bash whitelist-fleet.sh enumero panaloclub.com newpartner.com another.net
#   bash whitelist-fleet.sh sabongflix paldohere.net xyz.app
#   bash whitelist-fleet.sh mystreamingserver paldogames.app newco.net
#
# What it does:
#   1. pscp add-partner-domains.py + script to origin /tmp
#   2. Runs the .py on origin (patches nginx.conf + embed.html surgically)
#   3. nginx -t + systemctl reload nginx on origin
#   4. Fans out patched nginx.conf + embed.html to each relay via origin SSH pivot
#   5. nginx -t + reload on each relay
#
# Safety:
#   - Uses existing add-partner-domains.py (idempotent, guards /admin, backups auto)
#   - Bails on nginx -t fail anywhere
#   - IP entries: pass as-is (works but adds bogus https://www.<IP> — harmless)

set -uo pipefail

PPK="D:\\ppk\\vprivateprod.ppk"
HERE="$(dirname "$0")"
PATCHER="$HERE/add-partner-domains.py"

if [ ! -f "$PATCHER" ]; then
    echo "ERROR: $PATCHER not found" >&2; exit 2
fi

case "${1:-}" in
    enumero)
        ORIGIN="140.245.103.149"
        HOSTKEY=""
        RELAYS="10.0.9.14 10.0.9.203 10.0.9.78 10.0.9.43"
        ;;
    sabongflix)
        ORIGIN="138.2.88.192"
        HOSTKEY="SHA256:BVZ/iaGoIec8uHq96kt5ZlZhQJUKzUof9lqTXCMDM8o"
        RELAYS="10.0.9.184 10.0.9.117 10.0.9.220 10.0.9.98"
        ;;
    mystreamingserver)
        ORIGIN="161.118.215.36"
        HOSTKEY="SHA256:9TXo2NnWRDwRstvcvHWT7mvs8IEgyMAB2KoweGbtOLU"
        RELAYS="10.0.9.150 10.0.9.229 10.0.9.254 10.0.9.211"
        ;;
    *)
        echo "usage: $0 <enumero|sabongflix|mystreamingserver> <anchor> <new_domain> [new_domain ...]" >&2
        exit 2
        ;;
esac
FLEET="$1"; shift

if [ $# -lt 2 ]; then
    echo "ERROR: need anchor + at least one new domain" >&2
    echo "usage: $0 $FLEET <anchor> <new_domain> [new_domain ...]" >&2
    exit 2
fi

# Assemble plink args honoring optional hostkey pin.
PLINK_HK=""
[ -n "$HOSTKEY" ] && PLINK_HK="-hostkey $HOSTKEY"

echo "==== $FLEET: origin $ORIGIN, relays: $RELAYS ===="

# 1. Ship patcher to origin
pscp -i "$PPK" -batch $PLINK_HK "$PATCHER" ubuntu@$ORIGIN:/tmp/add-partner-domains.py
plink -ssh -i "$PPK" -batch $PLINK_HK ubuntu@$ORIGIN "sed -i 's/\r\$//' /tmp/add-partner-domains.py"

# 2. Run patcher on origin (anchor + new domains as args)
echo "== ORIGIN patch =="
plink -ssh -i "$PPK" -batch $PLINK_HK ubuntu@$ORIGIN "sudo python3 /tmp/add-partner-domains.py $*"

# 3. nginx -t + reload origin
echo "== ORIGIN nginx reload =="
plink -ssh -i "$PPK" -batch $PLINK_HK ubuntu@$ORIGIN "sudo nginx -t && sudo systemctl reload nginx && echo ORIGIN-OK"

# 4. Fan out to relays via origin SSH pivot
echo "== SYNC to relays =="
plink -ssh -i "$PPK" -batch $PLINK_HK ubuntu@$ORIGIN "
STAMP=\$(date +%Y%m%d-%H%M%S)
for R in $RELAYS; do
    echo '-- '\$R' --'
    sudo cat /etc/nginx/nginx.conf | ssh -o BatchMode=yes -o StrictHostKeyChecking=no ubuntu@\$R \\
        \"sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-wl-\$STAMP && sudo tee /etc/nginx/nginx.conf >/dev/null && sudo nginx -t && sudo systemctl reload nginx && echo NGINX-OK\"
    sudo cat /var/www/webrtc-simple/embed.html | ssh -o BatchMode=yes -o StrictHostKeyChecking=no ubuntu@\$R \\
        \"sudo cp /var/www/webrtc-simple/embed.html /var/www/webrtc-simple/embed.html.bak-wl-\$STAMP && sudo tee /var/www/webrtc-simple/embed.html >/dev/null && echo EMBED-OK\"
done
"

echo ""
echo "======================================"
echo " DONE. Verify partner iframe on any"
echo " new domain."
echo "======================================"
