import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_POOLER_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log("[MigrationSync] No DATABASE_URL — skipping migration tracking sync");
  process.exit(0);
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

async function syncMigrationTracking() {
  const journalPath = join(process.cwd(), "drizzle", "meta", "_journal.json");
  const journal: { entries: JournalEntry[] } = JSON.parse(readFileSync(journalPath, "utf-8"));

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const appTableCheck = await client.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') AS has_users`
    );
    if (!appTableCheck.rows[0]?.has_users) {
      console.log("[MigrationSync] Fresh database (no 'users' table) — skipping backfill so migrations run normally");
      return;
    }

    await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS drizzle_migrations_hash_idx ON drizzle."__drizzle_migrations" (hash)`
    );

    const existing = await client.query<{ hash: string }>(
      `SELECT hash FROM drizzle."__drizzle_migrations"`
    );
    const existingHashes = new Set(existing.rows.map((r) => r.hash));

    let inserted = 0;
    let missing = 0;
    for (const entry of journal.entries) {
      const sqlPath = join(process.cwd(), "drizzle", `${entry.tag}.sql`);
      let content: string;
      try {
        content = readFileSync(sqlPath, "utf-8");
      } catch {
        console.error(`[MigrationSync] FATAL: Missing SQL file for journal entry: ${entry.tag}`);
        missing++;
        continue;
      }

      const hash = createHash("md5").update(content).digest("hex");

      if (existingHashes.has(hash)) {
        continue;
      }

      await client.query(
        `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [hash, entry.when]
      );
      existingHashes.add(hash);
      inserted++;
    }

    if (missing > 0) {
      throw new Error(`${missing} journal entries have no matching SQL file — build cannot continue`);
    }

    console.log(
      `[MigrationSync] Done: ${journal.entries.length} journal entries, ${existing.rows.length} already tracked, ${inserted} newly registered`
    );
  } finally {
    await client.end();
  }
}

syncMigrationTracking().catch((err) => {
  console.error("[MigrationSync] Failed:", err.message);
  process.exit(1);
});
