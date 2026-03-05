import { schedulerTracker } from '../core/schedulerTracker';
import { alertOnScheduledTaskFailure } from '../core/dataAlerts';
import { queryWithRetry } from '../core/db';
import { getPacificHour, getPacificDayOfMonth, getPacificDateParts } from '../utils/dateUtils';
import { logger } from '../core/logger';

const RESET_HOUR = 3;

async function tryClaimResetSlot(monthKey: string): Promise<boolean> {
  try {
    const result = await queryWithRetry(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('last_guest_pass_reset', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
       WHERE system_settings.value IS DISTINCT FROM $1
       RETURNING key`,
      [monthKey],
      3
    );
    return (result.rowCount || 0) > 0;
  } catch (err: unknown) {
    logger.error('[Guest Pass Reset] Failed to claim reset slot:', { error: err as Error });
    schedulerTracker.recordRun('Guest Pass Reset', false, String(err));
    alertOnScheduledTaskFailure(
      'Guest Pass Reset',
      err instanceof Error ? err : new Error(String(err)),
      { context: 'Failed to claim monthly reset slot' }
    ).catch((alertErr: unknown) => {
      logger.error('[Guest Pass Reset] Failed to send staff alert:', { error: alertErr as Error });
    });
    return false;
  }
}

async function resetGuestPasses(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const dayOfMonth = getPacificDayOfMonth();
    
    if (dayOfMonth !== 1 || currentHour < RESET_HOUR || currentHour > 8) {
      return;
    }
    
    const parts = getPacificDateParts();
    const monthKey = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
    
    if (!await tryClaimResetSlot(monthKey)) {
      logger.info('[Guest Pass Reset] Already ran this month, skipping');
      schedulerTracker.recordRun('Guest Pass Reset', true);
      return;
    }
    
    logger.info('[Guest Pass Reset] Starting monthly reset...');
    schedulerTracker.recordRun('Guest Pass Reset', true);
    
    const result = await queryWithRetry(
      `UPDATE guest_passes 
       SET passes_used = 0, 
           updated_at = NOW()
       WHERE passes_used > 0
       RETURNING member_email, passes_total`,
      [],
      3
    );
    
    if (result.rowCount === 0) {
      logger.info('[Guest Pass Reset] No passes needed resetting');
      schedulerTracker.recordRun('Guest Pass Reset', true);
      return;
    }
    
    logger.info(`[Guest Pass Reset] Reset ${result.rowCount} member(s) guest passes to 0`);
    schedulerTracker.recordRun('Guest Pass Reset', true);
    
    for (const row of result.rows) {
      logger.info(`[Guest Pass Reset] Reset ${row.member_email}: 0/${row.passes_total} passes used`);
      schedulerTracker.recordRun('Guest Pass Reset', true);
    }
    
  } catch (error: unknown) {
    logger.error('[Guest Pass Reset] Scheduler error:', { error: error as Error });
    schedulerTracker.recordRun('Guest Pass Reset', false, String(error));
  }
}

let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

async function guardedResetGuestPasses(): Promise<void> {
  if (isRunning) {
    logger.info('[Guest Pass Reset] Skipping run — previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    await resetGuestPasses();
  } finally {
    isRunning = false;
  }
}

export function startGuestPassResetScheduler(): void {
  if (intervalId) {
    logger.info('[Guest Pass Reset] Scheduler already running');
    schedulerTracker.recordRun('Guest Pass Reset', true);
    return;
  }

  logger.info('[Startup] Guest pass reset scheduler enabled (runs 1st of month, 3am–8am Pacific catch-up window)');
  schedulerTracker.recordRun('Guest Pass Reset', true);
  
  intervalId = setInterval(() => {
    guardedResetGuestPasses().catch((err: unknown) => {
      logger.error('[Guest Pass Reset] Uncaught error:', { error: err as Error });
      schedulerTracker.recordRun('Guest Pass Reset', false, String(err));
    });
  }, 60 * 60 * 1000);
}

export function stopGuestPassResetScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Guest Pass Reset] Scheduler stopped');
    schedulerTracker.recordRun('Guest Pass Reset', true);
  }
}
