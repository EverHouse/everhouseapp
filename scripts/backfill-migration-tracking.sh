#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -z "${DATABASE_URL:-}" ]; then
  echo -e "${RED}ERROR: DATABASE_URL is not set${NC}"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
JOURNAL="$PROJECT_DIR/drizzle/meta/_journal.json"

if [ ! -f "$JOURNAL" ]; then
  echo -e "${RED}ERROR: Journal file not found: $JOURNAL${NC}"
  exit 1
fi

psql "$DATABASE_URL" -c "CREATE SCHEMA IF NOT EXISTS drizzle;" 2>/dev/null || true
psql "$DATABASE_URL" -c "
  CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash TEXT NOT NULL,
    created_at BIGINT
  );
" 2>/dev/null || true

EXISTING=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM drizzle.__drizzle_migrations;")
JOURNAL_COUNT=$(python3 -c "import json; print(len(json.load(open('$JOURNAL'))['entries']))")

echo "Migration tracking: $EXISTING rows in DB, $JOURNAL_COUNT entries in journal"

if [ "$EXISTING" -ge "$JOURNAL_COUNT" ]; then
  echo -e "${GREEN}All $JOURNAL_COUNT migrations already tracked. Nothing to do.${NC}"
  exit 0
fi

echo -e "${YELLOW}Backfilling migration tracking table...${NC}"

python3 -c "
import json, hashlib, os, sys

journal = json.load(open('$JOURNAL'))
entries = journal['entries']
drizzle_dir = '$PROJECT_DIR/drizzle'

values = []
for entry in entries:
    tag = entry['tag']
    when = entry['when']
    sql_file = os.path.join(drizzle_dir, f'{tag}.sql')
    if not os.path.exists(sql_file):
        print(f'WARNING: {sql_file} not found, skipping', file=sys.stderr)
        continue
    with open(sql_file, 'r') as f:
        content = f.read()
    h = hashlib.md5(content.encode()).hexdigest()
    values.append(f\"('{h}', {when})\")

if values:
    sql = 'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES\n'
    sql += ',\n'.join(values)
    sql += '\nON CONFLICT DO NOTHING;'
    print(sql)
" | psql "$DATABASE_URL"

NEW_COUNT=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM drizzle.__drizzle_migrations;")
echo -e "${GREEN}Done. Migration tracking table now has $NEW_COUNT rows.${NC}"
