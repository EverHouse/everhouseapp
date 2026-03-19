import { db } from '../db';
import { sql } from 'drizzle-orm';

const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--apply');

async function main() {
  console.log(`\n=== Phantom Social Tier Cleanup ${DRY_RUN ? '(DRY RUN)' : '(APPLY MODE)'} ===\n`);

  const result = await db.execute(sql`
    SELECT id, email, tier, membership_status, stripe_subscription_id, billing_provider, role, created_at
    FROM users
    WHERE tier = 'Social'
      AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '')
      AND (billing_provider IS NULL OR billing_provider != 'mindbody')
      AND (role IS NULL OR role = 'member')
  `);

  const affectedUsers = result.rows as Array<{
    id: string;
    email: string;
    tier: string;
    membership_status: string | null;
    stripe_subscription_id: string | null;
    billing_provider: string | null;
    role: string | null;
    created_at: string;
  }>;

  console.log(`Found ${affectedUsers.length} users with Social tier but no Stripe subscription or MindBody billing:\n`);

  for (const user of affectedUsers) {
    console.log(`  - ${user.email} | status: ${user.membership_status || 'NULL'} | role: ${user.role || 'NULL'} | created: ${user.created_at}`);
  }

  if (affectedUsers.length === 0) {
    console.log('No users to clean up.');
    return;
  }

  if (DRY_RUN) {
    console.log(`\nDRY RUN: Would set tier to NULL for ${affectedUsers.length} users.`);
    console.log('Run with --apply to execute the cleanup.');
  } else {
    const userIds = affectedUsers.map(u => u.id);
    const updateResult = await db.execute(sql`
      UPDATE users
      SET tier = NULL, tier_id = NULL, updated_at = NOW()
      WHERE id = ANY(${userIds})
    `);
    console.log(`\nUpdated ${updateResult.rowCount} users: tier set to NULL.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Cleanup script failed:', err);
    process.exit(1);
  });
