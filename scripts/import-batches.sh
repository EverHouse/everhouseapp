#!/bin/bash
set -uo pipefail

SUPABASE_URL="${DATABASE_POOLER_URL}"
BACKUP_DIR="/home/runner/workspace/migration_backup"
PROGRESS_FILE="$BACKUP_DIR/import_progress.log"

echo "Starting batch import at $(date)" > "$PROGRESS_FILE"

psql "$SUPABASE_URL" -c "SET session_replication_role = 'replica';" 2>/dev/null

TOTAL_BATCHES=$(ls "$BACKUP_DIR"/batch_* 2>/dev/null | wc -l)
CURRENT=0

for BATCH_FILE in "$BACKUP_DIR"/batch_*; do
  CURRENT=$((CURRENT + 1))
  BATCH_NAME=$(basename "$BATCH_FILE")
  BATCH_SIZE=$(wc -l < "$BATCH_FILE")
  
  echo "[$CURRENT/$TOTAL_BATCHES] Importing $BATCH_NAME ($BATCH_SIZE lines)..."
  echo "[$CURRENT/$TOTAL_BATCHES] $BATCH_NAME ($BATCH_SIZE lines) - started $(date)" >> "$PROGRESS_FILE"
  
  {
    echo "SET session_replication_role = 'replica';"
    echo "SET client_min_messages = warning;"
    cat "$BATCH_FILE"
  } | psql "$SUPABASE_URL" \
    --set ON_ERROR_STOP=off \
    2>>"$BACKUP_DIR/import_errors.log" \
    >/dev/null
  
  echo "  Done with $BATCH_NAME"
  echo "[$CURRENT/$TOTAL_BATCHES] $BATCH_NAME - done $(date)" >> "$PROGRESS_FILE"
done

psql "$SUPABASE_URL" -c "SET session_replication_role = 'origin';" 2>/dev/null

echo ""
echo "All batches imported!"
echo "Completed at $(date)" >> "$PROGRESS_FILE"

IMPORT_ERRORS=$(grep -c "ERROR:" "$BACKUP_DIR/import_errors.log" 2>/dev/null || echo "0")
echo "Total errors: $IMPORT_ERRORS"
if [ "$IMPORT_ERRORS" -gt "0" ]; then
  echo "First 10 errors:"
  grep "ERROR:" "$BACKUP_DIR/import_errors.log" | head -10
fi
