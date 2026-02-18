import { pool } from '../core/db';
import { getStripeClient } from '../core/stripe/client';
import { getErrorMessage } from '../utils/errorUtils';
import { logger } from '../core/logger';

const PLACEHOLDER_EMAIL_PATTERNS = [
  '@visitors.evenhouse.club',
  '@trackman.local',
  'lesson-',
  'classpass-',
  'golfnow-',
  'unmatched-'
];

interface CleanupResult {
  safeToDelete: Array<{ id: string; email: string; name: string | null }>;
  hasData: Array<{ id: string; email: string; name: string | null; reason: string }>;
  skipped: Array<{ id: string; email: string; name: string | null; reason: string }>;
}

function isPlaceholderEmail(email: string | null): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return PLACEHOLDER_EMAIL_PATTERNS.some(pattern => lower.includes(pattern));
}

async function checkUserHasHistoricalData(userId: string): Promise<{ hasData: boolean; reason: string }> {
  const checks = [
    { table: 'booking_requests', column: 'user_id', name: 'bookings' },
    { table: 'booking_members', column: 'user_id', name: 'booking participations' },
    { table: 'booking_participants', column: 'user_id', name: 'booking roster entries' },
    { table: 'visits', column: 'user_id', name: 'visits' },
    { table: 'booking_fee_snapshots', column: 'user_id', name: 'fee records' },
    { table: 'stripe_transaction_cache', column: 'user_id', name: 'payment transactions' }
  ];
  
  const reasons: string[] = [];
  
  for (const check of checks) {
    try {
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM ${check.table} WHERE ${check.column} = $1`,
        [userId]
      );
      const count = parseInt(result.rows[0]?.count || '0');
      if (count > 0) {
        reasons.push(`${count} ${check.name}`);
      }
    } catch (e) {
      // Table might not exist or column mismatch, skip
    }
  }
  
  if (reasons.length > 0) {
    return { hasData: true, reason: reasons.join(', ') };
  }
  return { hasData: false, reason: '' };
}

async function findAndCategorizeCustomers(): Promise<CleanupResult> {
  const stripe = await getStripeClient();
  const result: CleanupResult = {
    safeToDelete: [],
    hasData: [],
    skipped: []
  };
  
  let hasMore = true;
  let startingAfter: string | undefined;
  let processed = 0;
  
  logger.info('Fetching Stripe customers...');
  
  while (hasMore) {
    const params: Record<string, unknown> = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    
    const customers = await stripe.customers.list(params);
    
    for (const customer of customers.data) {
      processed++;
      if (processed % 100 === 0) {
        logger.info(`  Processed ${processed} customers...`);
      }
      
      const email = customer.email?.toLowerCase() || '';
      const name = customer.name;
      const userId = customer.metadata?.userId;
      
      // Skip if not a placeholder email
      if (!isPlaceholderEmail(email)) {
        continue;
      }
      
      // If no userId in metadata, check database by email
      if (!userId) {
        const dbUser = await pool.query(
          'SELECT id FROM users WHERE stripe_customer_id = $1',
          [customer.id]
        );
        
        if (dbUser.rows.length === 0) {
          // Orphaned Stripe customer - safe to delete
          result.safeToDelete.push({ id: customer.id, email, name });
        } else {
          // Check if user has data
          const dataCheck = await checkUserHasHistoricalData(dbUser.rows[0].id);
          if (dataCheck.hasData) {
            result.hasData.push({ id: customer.id, email, name, reason: dataCheck.reason });
          } else {
            result.safeToDelete.push({ id: customer.id, email, name });
          }
        }
        continue;
      }
      
      // Check if user exists and has data
      const userResult = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      
      if (userResult.rows.length === 0) {
        // User doesn't exist in DB - orphaned Stripe customer
        result.safeToDelete.push({ id: customer.id, email, name });
        continue;
      }
      
      // Check for historical data
      const dataCheck = await checkUserHasHistoricalData(userId);
      if (dataCheck.hasData) {
        result.hasData.push({ id: customer.id, email, name, reason: dataCheck.reason });
      } else {
        result.safeToDelete.push({ id: customer.id, email, name });
      }
    }
    
    if (customers.has_more) {
      startingAfter = customers.data[customers.data.length - 1].id;
    } else {
      hasMore = false;
    }
  }
  
  logger.info(`  Total processed: ${processed} customers`);
  return result;
}

async function runDryRun(): Promise<void> {
  logger.info('\n========================================');
  logger.info('STRIPE CLEANUP - DRY RUN MODE');
  logger.info('========================================\n');
  
  const result = await findAndCategorizeCustomers();
  
  logger.info('\n--- SAFE TO DELETE (placeholder emails, no historical data) ---');
  logger.info(`Count: ${result.safeToDelete.length}`);
  if (result.safeToDelete.length > 0) {
    logger.info('Sample (first 20):');
    result.safeToDelete.slice(0, 20).forEach(c => {
      logger.info(`  ${c.id}: ${c.email} (${c.name || 'no name'})`);
    });
    if (result.safeToDelete.length > 20) {
      logger.info(`  ... and ${result.safeToDelete.length - 20} more`);
    }
  }
  
  logger.info('\n--- KEEP (has historical data) ---');
  logger.info(`Count: ${result.hasData.length}`);
  if (result.hasData.length > 0) {
    result.hasData.forEach(c => {
      logger.info(`  ${c.id}: ${c.email} - ${c.reason}`);
    });
  }
  
  logger.info('\n--- SUMMARY ---');
  logger.info(`Safe to delete: ${result.safeToDelete.length}`);
  logger.info(`Keeping (has data): ${result.hasData.length}`);
  logger.info(`\nTo execute deletion, run with --execute flag`);
}

async function executeCleanup(): Promise<void> {
  logger.info('\n========================================');
  logger.info('STRIPE CLEANUP - EXECUTE MODE');
  logger.info('========================================\n');
  
  const result = await findAndCategorizeCustomers();
  
  if (result.safeToDelete.length === 0) {
    logger.info('No customers to delete. Exiting.');
    return;
  }
  
  logger.info(`\nDeleting ${result.safeToDelete.length} orphaned placeholder customers...`);
  
  const stripe = await getStripeClient();
  let deleted = 0;
  let failed = 0;
  
  for (const customer of result.safeToDelete) {
    try {
      await stripe.customers.del(customer.id);
      deleted++;
      if (deleted % 50 === 0) {
        logger.info(`  Deleted ${deleted}/${result.safeToDelete.length}...`);
      }
    } catch (err: unknown) {
      logger.error(`  Failed to delete ${customer.email}: ${getErrorMessage(err)}`);
      failed++;
    }
  }
  
  logger.info('\n--- CLEANUP COMPLETE ---');
  logger.info(`Deleted: ${deleted}`);
  logger.info(`Failed: ${failed}`);
  logger.info(`Kept (has data): ${result.hasData.length}`);
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  
  if (execute) {
    await executeCleanup();
  } else {
    await runDryRun();
  }
  
  process.exit(0);
}

main().catch((err) => {
  logger.error('Cleanup failed:', { error: err as Error });
  process.exit(1);
});
