import { schedulerTracker } from '../core/schedulerTracker';
import { logger } from '../core/logger';
import { isSupabaseConfigured, getSupabaseAdmin } from '../core/supabase/client';

let intervalId: NodeJS.Timeout | null = null;

const HEARTBEAT_INTERVAL = 6 * 60 * 60 * 1000; // Every 6 hours

async function runHeartbeat(): Promise<void> {
  if (!isSupabaseConfigured()) {
    logger.debug('[Supabase Heartbeat] Skipped - Supabase not configured');
    return;
  }

  const supabase = getSupabaseAdmin();

  const { count, error } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true });

  if (error) {
    throw new Error(`Supabase heartbeat query failed: ${error.message}`);
  }

  logger.info(`[Supabase Heartbeat] Ping successful - ${count ?? 0} users in Supabase`);
}

export function startSupabaseHeartbeatScheduler(): void {
  logger.info('[Startup] Supabase heartbeat scheduler enabled (runs every 6 hours)');

  setTimeout(async () => {
    try {
      await runHeartbeat();
      schedulerTracker.recordRun('Supabase Heartbeat', true);
    } catch (err: unknown) {
      logger.error('[Supabase Heartbeat] Initial run error:', { error: err as Error });
      schedulerTracker.recordRun('Supabase Heartbeat', false, String(err));
    }
  }, 30 * 1000);

  intervalId = setInterval(async () => {
    try {
      await runHeartbeat();
      schedulerTracker.recordRun('Supabase Heartbeat', true);
    } catch (err: unknown) {
      logger.error('[Supabase Heartbeat] Scheduler error:', { error: err as Error });
      schedulerTracker.recordRun('Supabase Heartbeat', false, String(err));
    }
  }, HEARTBEAT_INTERVAL);
}

export function stopSupabaseHeartbeatScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
