import { pool } from '../core/db';

async function cleanupOldWebhookEvents(): Promise<void> {
  try {
    const result = await pool.query(
      `DELETE FROM webhook_processed_events WHERE processed_at < NOW() - INTERVAL '7 days'`
    );

    console.log(`[Webhook Event Cleanup] Deleted ${result.rowCount} old webhook deduplication record(s)`);
  } catch (error) {
    console.error('[Webhook Event Cleanup] Scheduler error:', error);
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startWebhookEventCleanupScheduler(): void {
  if (intervalId) {
    console.log('[Webhook Event Cleanup] Scheduler already running');
    return;
  }

  console.log('[Startup] Webhook event cleanup scheduler enabled (runs every 24 hours)');

  intervalId = setInterval(() => {
    cleanupOldWebhookEvents().catch(err => {
      console.error('[Webhook Event Cleanup] Uncaught error:', err);
    });
  }, 24 * 60 * 60 * 1000);

  setTimeout(() => {
    cleanupOldWebhookEvents().catch(err => {
      console.error('[Webhook Event Cleanup] Initial run error:', err);
    });
  }, 5 * 60 * 1000);
}

export function stopWebhookEventCleanupScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Webhook Event Cleanup] Scheduler stopped');
  }
}
