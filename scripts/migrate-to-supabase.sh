#!/bin/bash
set -euo pipefail

REPLIT_HOST="helium"
REPLIT_USER="postgres"
REPLIT_DB="heliumdb"

SUPABASE_URL="${DATABASE_POOLER_URL}"

if [ -z "$SUPABASE_URL" ]; then
  SUPABASE_URL="${SUPABASE_DIRECT_URL}"
fi

if [ -z "$SUPABASE_URL" ]; then
  echo "ERROR: Neither DATABASE_POOLER_URL nor SUPABASE_DIRECT_URL is set"
  exit 1
fi

BACKUP_DIR="/home/runner/workspace/migration_backup"
mkdir -p "$BACKUP_DIR"

echo "============================================"
echo "  Replit → Supabase Data Migration"
echo "============================================"
echo ""
echo "Source: Replit PostgreSQL (helium)"
echo "Target: Supabase"
echo ""

echo "[Step 1/6] Exporting data from Replit database..."
pg_dump -h "$REPLIT_HOST" -U "$REPLIT_USER" -d "$REPLIT_DB" \
  --data-only \
  --no-owner \
  --no-privileges \
  --disable-triggers \
  --inserts \
  --no-comments \
  --schema=public \
  > "$BACKUP_DIR/replit_data.sql" 2>"$BACKUP_DIR/dump_errors.log"

DUMP_LINES=$(wc -l < "$BACKUP_DIR/replit_data.sql")
echo "   Exported $DUMP_LINES lines of data"

if [ "$DUMP_LINES" -lt 100 ]; then
  echo "ERROR: Export seems too small ($DUMP_LINES lines). Aborting."
  exit 1
fi

echo ""
echo "[Step 2/6] Counting source records for verification..."
SOURCE_COUNTS="$BACKUP_DIR/source_counts.txt"
psql -h "$REPLIT_HOST" -U "$REPLIT_USER" -d "$REPLIT_DB" -t -c "
SELECT table_name, 
  (xpath('/row/count/text()', 
    query_to_xml('SELECT count(*) FROM public.' || quote_ident(table_name), false, true, ''))
  )[1]::text::int AS row_count
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
" > "$SOURCE_COUNTS"
echo "   Source counts saved"

echo ""
echo "[Step 3/6] Clearing Supabase tables..."

ALL_TABLES=$(psql -h "$REPLIT_HOST" -U "$REPLIT_USER" -d "$REPLIT_DB" -t -c "
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' AND table_type = 'BASE TABLE' 
ORDER BY table_name;
" | tr -d ' ' | grep -v '^$')

SUPABASE_TABLES=$(psql "$SUPABASE_URL" -t -c "
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' AND table_type = 'BASE TABLE' 
ORDER BY table_name;
" | tr -d ' ' | grep -v '^$')

TRUNCATE_SQL="SET session_replication_role = 'replica';"
for TABLE in $SUPABASE_TABLES; do
  TRUNCATE_SQL="${TRUNCATE_SQL} TRUNCATE TABLE public.\"${TABLE}\" CASCADE;"
done
TRUNCATE_SQL="${TRUNCATE_SQL} SET session_replication_role = 'origin';"

psql "$SUPABASE_URL" -c "$TRUNCATE_SQL" 2>"$BACKUP_DIR/truncate_errors.log"
echo "   Supabase tables cleared ($(echo "$SUPABASE_TABLES" | wc -l) tables)"

echo ""
echo "[Step 4/6] Importing data into Supabase..."

IMPORT_SQL_FILE="$BACKUP_DIR/import_ready.sql"

SUPABASE_TABLE_LIST=$(echo "$SUPABASE_TABLES" | tr '\n' '|' | sed 's/|$//')

{
  echo "SET session_replication_role = 'replica';"
  echo "SET client_min_messages = warning;"
  grep -v '\\\\restrict' "$BACKUP_DIR/replit_data.sql" | \
    grep -v '^--' | \
    grep -v '^$' | \
    grep -v '^SET ' | \
    grep -v '^SELECT pg_catalog' | \
    grep -v 'drizzle\.' | \
    grep -v '__drizzle_migrations' | \
    grep -E "^INSERT INTO public\.(${SUPABASE_TABLE_LIST}) "
  echo "SET session_replication_role = 'origin';"
} > "$IMPORT_SQL_FILE"

IMPORT_LINES=$(wc -l < "$IMPORT_SQL_FILE")
echo "   Prepared $IMPORT_LINES lines for import"

psql "$SUPABASE_URL" -f "$IMPORT_SQL_FILE" \
  --set ON_ERROR_STOP=off \
  2>"$BACKUP_DIR/import_errors.log" \
  >"$BACKUP_DIR/import_output.log"

IMPORT_ERRORS=$(grep -c "ERROR:" "$BACKUP_DIR/import_errors.log" 2>/dev/null || echo "0")
echo "   Import complete ($IMPORT_ERRORS errors logged)"

if [ "$IMPORT_ERRORS" -gt "0" ]; then
  echo "   First few errors:"
  grep "ERROR:" "$BACKUP_DIR/import_errors.log" | head -5 | sed 's/^/     /'
fi

echo ""
echo "[Step 5/6] Resetting sequences..."

SUPABASE_SEQS=$(psql "$SUPABASE_URL" -t -c "
SELECT sequence_name FROM information_schema.sequences 
WHERE sequence_schema = 'public';
" | tr -d ' ' | grep -v '^$')

SEQUENCES=$(psql -h "$REPLIT_HOST" -U "$REPLIT_USER" -d "$REPLIT_DB" -t -c "
SELECT s.sequence_name, ps.last_value
FROM information_schema.sequences s
JOIN pg_sequences ps ON s.sequence_name = ps.sequencename
WHERE s.sequence_schema = 'public' AND ps.last_value IS NOT NULL
ORDER BY s.sequence_name;
")

SEQ_COUNT=0
SEQ_SKIP=0
: > "$BACKUP_DIR/sequence_errors.log"

while IFS='|' read -r SEQ_NAME LAST_VAL; do
  SEQ_NAME=$(echo "$SEQ_NAME" | tr -d ' ')
  LAST_VAL=$(echo "$LAST_VAL" | tr -d ' ')
  if [ -z "$SEQ_NAME" ] || [ -z "$LAST_VAL" ]; then continue; fi
  
  if echo "$SUPABASE_SEQS" | grep -q "^${SEQ_NAME}$"; then
    psql "$SUPABASE_URL" -c "SELECT setval('public.\"${SEQ_NAME}\"', ${LAST_VAL}, true);" 2>>"$BACKUP_DIR/sequence_errors.log" >/dev/null
    SEQ_COUNT=$((SEQ_COUNT + 1))
  else
    SEQ_SKIP=$((SEQ_SKIP + 1))
  fi
done <<< "$SEQUENCES"

SEQ_ERRORS=$(grep -c "ERROR:" "$BACKUP_DIR/sequence_errors.log" 2>/dev/null || echo "0")
echo "   Reset $SEQ_COUNT sequences (skipped $SEQ_SKIP not in Supabase, $SEQ_ERRORS errors)"
if [ "$SEQ_ERRORS" -gt "0" ]; then
  echo "   Sequence errors:"
  grep "ERROR:" "$BACKUP_DIR/sequence_errors.log" | head -5 | sed 's/^/     /'
fi

echo ""
echo "[Step 6/6] Verifying migration..."

TARGET_COUNTS="$BACKUP_DIR/target_counts.txt"
psql "$SUPABASE_URL" -t -c "
SELECT table_name, 
  (xpath('/row/count/text()', 
    query_to_xml('SELECT count(*) FROM public.' || quote_ident(table_name), false, true, ''))
  )[1]::text::int AS row_count
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
" > "$TARGET_COUNTS"

echo ""
echo "============================================"
echo "  VERIFICATION: Row count comparison"
echo "============================================"
echo ""
printf "%-45s %10s %10s %8s\n" "TABLE" "REPLIT" "SUPABASE" "STATUS"
printf "%-45s %10s %10s %8s\n" "-----" "------" "--------" "------"

MISMATCHES=0
while IFS='|' read -r TABLE COUNT; do
  TABLE=$(echo "$TABLE" | tr -d ' ')
  COUNT=$(echo "$COUNT" | tr -d ' ')
  if [ -z "$TABLE" ]; then continue; fi
  
  TARGET_COUNT=$(grep " ${TABLE} " "$TARGET_COUNTS" 2>/dev/null | awk -F'|' '{print $2}' | tr -d ' ')
  if [ -z "$TARGET_COUNT" ]; then
    TARGET_COUNT=$(grep "^${TABLE}" "$TARGET_COUNTS" 2>/dev/null | awk -F'|' '{print $2}' | tr -d ' ')
  fi
  if [ -z "$TARGET_COUNT" ]; then TARGET_COUNT="0"; fi
  
  if [ "$COUNT" = "$TARGET_COUNT" ]; then
    STATUS="OK"
  else
    STATUS="MISMATCH"
    MISMATCHES=$((MISMATCHES + 1))
  fi
  
  if [ "$COUNT" != "0" ] || [ "$TARGET_COUNT" != "0" ]; then
    printf "%-45s %10s %10s %8s\n" "$TABLE" "$COUNT" "$TARGET_COUNT" "$STATUS"
  fi
done < "$SOURCE_COUNTS"

echo ""
if [ "$MISMATCHES" -eq 0 ]; then
  echo "ALL TABLES MATCH - Migration successful!"
else
  echo "WARNING: $MISMATCHES table(s) have mismatched counts."
  echo "Check $BACKUP_DIR/import_errors.log for details."
fi

echo ""
echo "============================================"
echo "  Migration complete!"
echo "============================================"
echo ""
echo "Backup files saved in: $BACKUP_DIR/"
echo "  - replit_data.sql      (full data export)"
echo "  - source_counts.txt    (Replit row counts)"
echo "  - target_counts.txt    (Supabase row counts)"
echo "  - import_errors.log    (any import errors)"
echo "  - sequence_errors.log  (any sequence errors)"
echo ""
echo "NEXT STEPS:"
echo "  1. Review the verification results above"
echo "  2. If all looks good, update production DATABASE_URL to Supabase"
echo "  3. Deploy the app"
echo ""
