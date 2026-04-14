#!/bin/bash
set -euo pipefail

IMAGE_TAG=$(docker inspect toolcairn-indexer-1 --format '{{.Config.Image}}' 2>/dev/null | awk -F: '{print $NF}')
export IMAGE_TAG

STATUS_DIR=/opt/toolcairn/cron-status
STATUS_FILE=$STATUS_DIR/search-weights.json
JOB_LOG=$STATUS_DIR/search-weights.log
LOCK=/tmp/tc-weights.lock
LOG=/var/log/toolcairn/cron.log
COMPOSE="docker compose -f /opt/toolcairn/docker-compose.prod.yml --env-file /opt/toolcairn/.env.prod --profile indexer"
RUN="$COMPOSE run --rm --no-deps --pull never indexer"
TRIGGERED_BY="${TRIGGERED_BY:-cron}"

mkdir -p "$STATUS_DIR" "$(dirname "$LOG")"
> "$JOB_LOG"

log() {
  local msg
  msg="$(date -u '+%Y-%m-%dT%H:%M:%SZ') [search-weights] $*"
  echo "$msg" | tee -a "$LOG" >> "$JOB_LOG"
}

if [ -f "$LOCK" ]; then
  PID=$(cat "$LOCK" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    log "Already running (PID $PID) — skipping"; exit 0
  fi
  log "Stale lock (PID ${PID:-?} dead) — clearing"
  rm -f "$LOCK"
fi

echo $$ > "$LOCK"
START_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
START_TS=$(date +%s)

write_status() {
  local status=$1 error=${2:-}
  local now_iso finish_ts duration
  now_iso=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  finish_ts=$(date +%s); duration=$((finish_ts - START_TS))
  if [ -n "$error" ]; then
    printf '{"status":"%s","startedAt":"%s","finishedAt":"%s","durationSec":%d,"triggeredBy":"%s","error":"%s"}\n' \
      "$status" "$START_ISO" "$now_iso" "$duration" "$TRIGGERED_BY" "$error" > "$STATUS_FILE"
  else
    printf '{"status":"%s","startedAt":"%s","finishedAt":"%s","durationSec":%d,"triggeredBy":"%s","error":null}\n' \
      "$status" "$START_ISO" "$now_iso" "$duration" "$TRIGGERED_BY" > "$STATUS_FILE"
  fi
}

trap 'CODE=$?; rm -f "$LOCK"; [ $CODE -ne 0 ] && write_status "error" "exit code $CODE"; log "Exit ($CODE)"' EXIT

printf '{"status":"running","startedAt":"%s","finishedAt":null,"durationSec":null,"triggeredBy":"%s","error":null}\n' \
  "$START_ISO" "$TRIGGERED_BY" > "$STATUS_FILE"

log "=== Search weights update started (IMAGE_TAG=$IMAGE_TAG) ==="
$RUN node apps/indexer/dist/update-search-weights.js 2>&1 | tee -a "$JOB_LOG" >> "$LOG"

write_status "success"
log "=== Search weights update complete ==="
