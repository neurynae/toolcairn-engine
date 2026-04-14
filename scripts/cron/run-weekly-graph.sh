#!/bin/bash
set -euo pipefail

IMAGE_TAG=$(docker inspect toolcairn-indexer-1 --format '{{.Config.Image}}' 2>/dev/null | awk -F: '{print $NF}')
export IMAGE_TAG

COMPOSE="docker compose -f /opt/toolcairn/docker-compose.prod.yml --env-file /opt/toolcairn/.env.prod --profile indexer"
RUN="$COMPOSE run --rm --no-deps --pull never indexer"
LOCK=/tmp/toolcairn-weekly.lock
WEEK=$(date +%G-W%V)
STATE=/tmp/toolcairn-weekly-${WEEK}.state
LOG=/var/log/toolcairn/weekly-graph.log
STATUS_DIR=/opt/toolcairn/cron-status
STATUS_FILE=$STATUS_DIR/weekly-graph.json
JOB_LOG=$STATUS_DIR/weekly-graph.log
TRIGGERED_BY="${TRIGGERED_BY:-cron}"

# Manual trigger always runs all steps fresh — clear the state file
[ "$TRIGGERED_BY" = "manual" ] && rm -f "$STATE" && echo "Manual trigger: cleared state file $STATE"

mkdir -p /var/log/toolcairn "$STATUS_DIR"
> "$JOB_LOG"

log() {
  local msg
  msg="$(date -u '+%Y-%m-%dT%H:%M:%SZ') [$WEEK] $*"
  echo "$msg" | tee -a "$LOG" >> "$JOB_LOG"
}
step_done() { grep -qF "step_$1:done" "$STATE" 2>/dev/null; }
mark_done() { echo "step_$1:done" >> "$STATE"; }

TOTAL_STEPS=5

if [ -f "$LOCK" ]; then
  PID=$(cat "$LOCK" 2>/dev/null)
  if kill -0 "$PID" 2>/dev/null; then
    log "Already running (PID $PID) — skipping"; exit 0
  fi
  log "Stale lock (PID $PID dead) — resuming from last checkpoint"
  rm -f "$LOCK"
fi

echo $$ > "$LOCK"
START_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
START_TS=$(date +%s)

write_status() {
  local status=$1 step=${2:-0} error=${3:-}
  local now_iso finish_ts duration
  now_iso=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  finish_ts=$(date +%s); duration=$((finish_ts - START_TS))
  if [ -n "$error" ]; then
    printf '{"status":"%s","startedAt":"%s","finishedAt":"%s","durationSec":%d,"triggeredBy":"%s","currentStep":%d,"totalSteps":%d,"error":"%s"}\n' \
      "$status" "$START_ISO" "$now_iso" "$duration" "$TRIGGERED_BY" "$step" "$TOTAL_STEPS" "$error" > "$STATUS_FILE"
  else
    printf '{"status":"%s","startedAt":"%s","finishedAt":"%s","durationSec":%d,"triggeredBy":"%s","currentStep":%d,"totalSteps":%d,"error":null}\n' \
      "$status" "$START_ISO" "$now_iso" "$duration" "$TRIGGERED_BY" "$step" "$TOTAL_STEPS" > "$STATUS_FILE"
  fi
}

trap 'CODE=$?; rm -f "$LOCK"; [ $CODE -ne 0 ] && write_status "error" 0 "exit code $CODE"; log "Exit ($CODE)"' EXIT

printf '{"status":"running","startedAt":"%s","finishedAt":null,"durationSec":null,"triggeredBy":"%s","currentStep":0,"totalSteps":%d,"error":null}\n' \
  "$START_ISO" "$TRIGGERED_BY" "$TOTAL_STEPS" > "$STATUS_FILE"

log "=== Weekly graph refresh started (IMAGE_TAG=$IMAGE_TAG, state: $STATE) ==="

if step_done 1; then log "Step 1/$TOTAL_STEPS: centrality — already done, skipping"
else
  log "Step 1/$TOTAL_STEPS: Computing inbound edge centrality"
  write_status "running" 1
  $RUN node apps/indexer/dist/compute-centrality.js 2>&1 | tee -a "$JOB_LOG" >> "$LOG"
  mark_done 1; log "Step 1/$TOTAL_STEPS done"
fi

if step_done 2; then log "Step 2/$TOTAL_STEPS: PageRank — already done, skipping"
else
  log "Step 2/$TOTAL_STEPS: Computing PageRank"
  write_status "running" 2
  $RUN node apps/indexer/dist/compute-pagerank.js 2>&1 | tee -a "$JOB_LOG" >> "$LOG"
  mark_done 2; log "Step 2/$TOTAL_STEPS done"
fi

if step_done 3; then log "Step 3/$TOTAL_STEPS: canonical flags — already done, skipping"
else
  log "Step 3/$TOTAL_STEPS: Setting canonical flags"
  write_status "running" 3
  $RUN node apps/indexer/dist/set-canonical-tools.js 2>&1 | tee -a "$JOB_LOG" >> "$LOG"
  mark_done 3; log "Step 3/$TOTAL_STEPS done"
fi

if step_done 4; then log "Step 4/$TOTAL_STEPS: cleanup — already done, skipping"
else
  log "Step 4/$TOTAL_STEPS: Personal repo cleanup"
  write_status "running" 4
  $RUN node apps/indexer/dist/cleanup-personal-repos.js --delete 2>&1 | tee -a "$JOB_LOG" >> "$LOG"
  mark_done 4; log "Step 4/$TOTAL_STEPS done"
fi

if step_done 5; then log "Step 5/$TOTAL_STEPS: download percentiles — already done, skipping"
else
  log "Step 5/$TOTAL_STEPS: Computing download percentiles and recalculating credibility"
  write_status "running" 5
  $RUN node apps/indexer/dist/compute-download-percentiles.js --write 2>&1 | tee -a "$JOB_LOG" >> "$LOG"
  mark_done 5; log "Step 5/$TOTAL_STEPS done"
fi

write_status "success" "$TOTAL_STEPS"
log "=== Weekly graph refresh complete ==="
