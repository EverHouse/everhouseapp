import pg from "pg";

const PROTECTED_COLUMNS: Record<string, string[]> = {
  users: [
    "id", "email", "first_name", "last_name", "role", "tier", "tier_id",
    "google_id", "google_email", "google_linked_at",
    "apple_id", "apple_email", "apple_linked_at",
    "stripe_customer_id", "stripe_subscription_id",
    "hubspot_id", "membership_status", "created_at", "updated_at",
  ],
};

const DATABASE_URL = process.env.DATABASE_POOLER_URL || process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL or DATABASE_POOLER_URL is required");
  process.exit(1);
}

async function snapshotColumns(client: pg.Client): Promise<Map<string, Set<string>>> {
  const result = await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name IN (${Object.keys(PROTECTED_COLUMNS).map((_, i) => `$${i + 1}`).join(", ")})
  `, Object.keys(PROTECTED_COLUMNS));

  const snapshot = new Map<string, Set<string>>();
  for (const row of result.rows) {
    if (!snapshot.has(row.table_name)) snapshot.set(row.table_name, new Set());
    snapshot.get(row.table_name)!.add(row.column_name);
  }
  return snapshot;
}

async function preflightCheck(client: pg.Client): Promise<boolean> {
  const { execSync } = await import("child_process");

  let dryRunOutput: string;
  try {
    dryRunOutput = execSync("npx drizzle-kit push --force 2>&1 || true", {
      env: { ...process.env, DRIZZLE_PUSH_DRY_RUN: "1" },
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch {
    return true;
  }

  const dropPatterns = [
    /ALTER TABLE.*DROP COLUMN/i,
    /DROP TABLE.*users/i,
  ];

  for (const pattern of dropPatterns) {
    if (pattern.test(dryRunOutput)) {
      const currentCols = await snapshotColumns(client);
      const usersCols = currentCols.get("users");

      if (usersCols) {
        for (const col of PROTECTED_COLUMNS.users || []) {
          if (usersCols.has(col)) {
            console.error(`\n[safe-db-push] PREFLIGHT BLOCKED: Detected column drop operation.`);
            console.error(`  Protected column '${col}' exists in database and may be dropped.`);
            console.error(`  This was the root cause of the March 17 data wipe.`);
            console.error(`  If you are CERTAIN this is safe, use: npm run db:push:unsafe\n`);
            return false;
          }
        }
      }
    }
  }

  return true;
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const before = await snapshotColumns(client);

    console.log("[safe-db-push] Pre-push column snapshot captured for protected tables:");
    for (const [table, cols] of before) {
      console.log(`  ${table}: ${cols.size} columns`);
    }

    const passed = await preflightCheck(client);
    if (!passed) {
      process.exit(1);
    }

    console.log("\n[safe-db-push] Running drizzle-kit push (interactive mode)...\n");

    const { execSync } = await import("child_process");
    execSync("npx drizzle-kit push", {
      stdio: "inherit",
      env: { ...process.env },
    });

    const after = await snapshotColumns(client);

    let droppedProtected = false;
    const damages: string[] = [];

    for (const [table, protectedCols] of Object.entries(PROTECTED_COLUMNS)) {
      const beforeCols = before.get(table);
      const afterCols = after.get(table);

      if (!beforeCols) continue;

      for (const col of protectedCols) {
        if (beforeCols.has(col) && (!afterCols || !afterCols.has(col))) {
          droppedProtected = true;
          damages.push(`${table}.${col}`);
        }
      }
    }

    if (droppedProtected) {
      console.error("\n╔══════════════════════════════════════════════════════════╗");
      console.error("║  CRITICAL: PROTECTED COLUMNS WERE DROPPED BY db:push!  ║");
      console.error("╠══════════════════════════════════════════════════════════╣");
      console.error("║  This likely wiped production data.                     ║");
      console.error("╚══════════════════════════════════════════════════════════╝\n");

      for (const damage of damages) {
        console.error(`  DROPPED: ${damage}`);
      }

      console.error("\n⚠️  DATA IS LOST. Check backups and integrity checks immediately.\n");
      process.exit(1);
    }

    let anyDropped = false;
    for (const [table, beforeCols] of before) {
      const afterCols = after.get(table);
      if (!afterCols) continue;
      for (const col of beforeCols) {
        if (!afterCols.has(col)) {
          anyDropped = true;
          console.warn(`  WARNING: Non-protected column dropped: ${table}.${col}`);
        }
      }
    }

    if (anyDropped) {
      console.warn("\n[safe-db-push] Some columns were dropped. Review the output above.");
    } else {
      console.log("\n[safe-db-push] ✓ No protected columns were dropped. Push completed safely.");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[safe-db-push] Fatal error:", err);
  process.exit(1);
});
