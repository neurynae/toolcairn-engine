#!/bin/bash
# Sync cron scripts from repo to VPS.
# Run locally after changing any cron script.
#
# Usage: bash scripts/cron/sync-to-vps.sh
set -euo pipefail

VPS_KEY="${VPS_KEY:-/c/Temp/toolcairn-prod.pem}"
VPS_HOST="${VPS_HOST:-ubuntu@3.111.95.28}"
REMOTE_DIR="/opt/toolcairn/scripts"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Syncing cron scripts to VPS..."

# Copy all .sh scripts
for f in "$SCRIPT_DIR"/*.sh; do
  [ "$(basename "$f")" = "sync-to-vps.sh" ] && continue
  echo "  → $(basename "$f")"
  scp -i "$VPS_KEY" -o StrictHostKeyChecking=no "$f" "$VPS_HOST:$REMOTE_DIR/$(basename "$f")"
done

# Make executable
ssh -i "$VPS_KEY" -o StrictHostKeyChecking=no "$VPS_HOST" "chmod +x $REMOTE_DIR/*.sh"

# Install crontab
echo "  → crontab"
scp -i "$VPS_KEY" -o StrictHostKeyChecking=no "$SCRIPT_DIR/crontab" "$VPS_HOST:/tmp/toolcairn-crontab"
ssh -i "$VPS_KEY" -o StrictHostKeyChecking=no "$VPS_HOST" "crontab /tmp/toolcairn-crontab && rm /tmp/toolcairn-crontab"

echo "Done. Current VPS crontab:"
ssh -i "$VPS_KEY" -o StrictHostKeyChecking=no "$VPS_HOST" "crontab -l"
