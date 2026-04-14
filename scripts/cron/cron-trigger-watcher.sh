#!/bin/bash
# Checks for trigger files written by the API container.
# Run every minute via cron. Trigger files are deleted before spawning to prevent double-runs.
TRIGGER_DIR=/opt/toolcairn/cron-status
LOG=/var/log/toolcairn/cron.log

mkdir -p "$TRIGGER_DIR" "$(dirname "$LOG")"
log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [trigger-watcher] $*" >> "$LOG"; }

for TRIGGER_FILE in "$TRIGGER_DIR"/*.trigger; do
  [ -f "$TRIGGER_FILE" ] || continue
  JOB=$(basename "$TRIGGER_FILE" .trigger)
  rm -f "$TRIGGER_FILE"
  log "Trigger received for: $JOB"
  case "$JOB" in
    daily-indexer)
      TRIGGERED_BY=manual nohup /opt/toolcairn/scripts/run-daily-indexer.sh >> "$LOG" 2>&1 &
      log "Spawned daily-indexer (PID $!)"
      ;;
    search-weights)
      TRIGGERED_BY=manual nohup /opt/toolcairn/scripts/run-search-weights.sh >> "$LOG" 2>&1 &
      log "Spawned search-weights (PID $!)"
      ;;
    weekly-graph)
      TRIGGERED_BY=manual nohup /opt/toolcairn/scripts/run-weekly-graph.sh >> "$LOG" 2>&1 &
      log "Spawned weekly-graph (PID $!)"
      ;;
    *)
      log "Unknown job: $JOB — ignoring"
      ;;
  esac
done
