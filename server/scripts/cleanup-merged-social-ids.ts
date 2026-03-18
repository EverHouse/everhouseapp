import { pool } from '../core/db';
import { logger } from '../core/logger';

async function cleanupMergedSocialIds() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      UPDATE users
      SET apple_id = NULL,
          apple_email = NULL,
          apple_linked_at = NULL,
          google_id = NULL,
          google_email = NULL,
          google_linked_at = NULL,
          updated_at = NOW()
      WHERE archived_at IS NOT NULL
        AND membership_status = 'merged'
        AND (apple_id IS NOT NULL OR google_id IS NOT NULL)
    `);

    console.log(`Cleaned social auth IDs from ${result.rowCount} merged/archived users`);
    logger.info('[Cleanup] Cleared stale social IDs from merged users', {
      extra: { updatedCount: result.rowCount }
    });
  } catch (err) {
    console.error('Failed to clean up merged social IDs:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

cleanupMergedSocialIds();
