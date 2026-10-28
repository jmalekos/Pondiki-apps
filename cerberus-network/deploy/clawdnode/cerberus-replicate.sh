#!/bin/bash
# Pull the Cerberus rollup snapshot and publish it atomically for the dashboard.
# Runs on clawdnode via systemd timer (hourly).
set -euo pipefail

KEY=/home/cretan/.ssh/cerberus_cretan_ed25519
CERB_HOST=100.75.144.126
CERB_DIR=/srv/cerberus-data/cerberus-net
LOCAL_DIR=/home/cretan/cerberus-rollups
STAGE_DB="$LOCAL_DIR/rollups.db.stage"
STAGE_SHA="$LOCAL_DIR/rollups.db.sha256.stage"
LIVE_DB="$LOCAL_DIR/rollups.db"
LIVE_SHA="$LOCAL_DIR/rollups.db.sha256"

SSH="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15"
mkdir -p "$LOCAL_DIR"

# Copy snapshot + checksum to staging paths.
rsync -az --checksum -e "$SSH" "cretan@$CERB_HOST:$CERB_DIR/rollups-export.db" "$STAGE_DB"
rsync -az --checksum -e "$SSH" "cretan@$CERB_HOST:$CERB_DIR/rollups-export.db.sha256" "$STAGE_SHA"

# Verify integrity before publishing.
EXPECTED=$(awk '{print $1}' "$STAGE_SHA")
ACTUAL=$(sha256sum "$STAGE_DB" | awk '{print $1}')
if [[ -z "$EXPECTED" || "$EXPECTED" != "$ACTUAL" ]]; then
  echo "checksum mismatch: expected=$EXPECTED actual=$ACTUAL" >&2
  exit 1
fi

# Retain the previous valid generation for rollback, then atomic publish.
if [[ -f "$LIVE_DB" ]]; then
  mv -f "$LIVE_DB" "$LIVE_DB.prev"
  mv -f "$LIVE_SHA" "$LIVE_SHA.prev" 2>/dev/null || true
fi
mv -f "$STAGE_DB" "$LIVE_DB"
mv -f "$STAGE_SHA" "$LIVE_SHA"
echo "published $LIVE_DB ($(stat -c%s "$LIVE_DB") bytes, sha256 $ACTUAL; prev retained)"
