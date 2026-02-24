import { schedulerTracker } from '../core/schedulerTracker';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { notifyAllStaff } from '../core/notificationService';
import { alertOnScheduledTaskFailure } from '../core/dataAlerts';
import { logger } from '../core/logger';

interface StaleWaiver {
  id: number;
  display_name: string;
  session_id: number;
  created_at: Date;
  request_id: number;
  request_date: string;
  resource_name: string | null;
}

let lastCheckTime: Date | null = null;
const MIN_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;

export async function checkStaleWaivers(): Promise<{
  staleCount: number;
  notificationSent: boolean;
  waivers: StaleWaiver[];
}> {
  try {
    const result = await db.execute(sql`
      SELECT 
        bp.id,
        bp.display_name,
        bp.session_id,
        bp.created_at,
        br.id as request_id,
        br.request_date,
        r.name as resource_name
      FROM booking_participants bp
      JOIN booking_sessions bs ON bp.session_id = bs.id
      JOIN booking_requests br ON br.session_id = bs.id
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE bp.payment_status = 'waived'
        AND bp.waiver_reviewed_at IS NULL
        AND (bp.used_guest_pass IS NULL OR bp.used_guest_pass = FALSE)
        AND bp.created_at < NOW() - INTERVAL '12 hours'
    `);

    const staleWaivers: StaleWaiver[] = result.rows as unknown as StaleWaiver[];

    logger.info(`[Waiver Review] Found ${staleWaivers.length} stale waiver(s) pending review`);

    let notificationSent = false;

    if (staleWaivers.length > 0) {
      await notifyAllStaff(
        'Waivers Need Review',
        `${staleWaivers.length} waiver(s) pending review for more than 12 hours`,
        'system',
        { relatedType: 'waiver_review', sendPush: false }
      );
      notificationSent = true;
      logger.info(`[Waiver Review] Staff notification sent for ${staleWaivers.length} stale waiver(s)`);
    }

    return {
      staleCount: staleWaivers.length,
      notificationSent,
      waivers: staleWaivers
    };
  } catch (error: unknown) {
    logger.error('[Waiver Review] Error checking stale waivers:', { error: error as Error });
    schedulerTracker.recordRun('Waiver Review', false, String(error));
    throw error;
  }
}

async function scheduledCheck(): Promise<void> {
  try {
    const now = new Date();
    
    if (lastCheckTime && (now.getTime() - lastCheckTime.getTime()) < MIN_CHECK_INTERVAL_MS) {
      logger.info('[Waiver Review] Skipping check - too soon since last check');
      return;
    }

    lastCheckTime = now;
    await checkStaleWaivers();
  } catch (error: unknown) {
    logger.error('[Waiver Review] Scheduled check failed:', { error: error as Error });
    schedulerTracker.recordRun('Waiver Review', false, String(error));
    
    // Notify staff about waiver review scheduler failure
    alertOnScheduledTaskFailure(
      'Waiver Review Check',
      error instanceof Error ? error : new Error(String(error)),
      { context: 'Scheduled check for stale waivers' }
    ).catch((alertErr: unknown) => {
      logger.error('[Waiver Review] Failed to send staff alert:', { error: alertErr as Error });
      schedulerTracker.recordRun('Waiver Review', false, String(alertErr));
    });
  }
}

export function startWaiverReviewScheduler(): NodeJS.Timeout {
  const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
  
  const id = setInterval(scheduledCheck, CHECK_INTERVAL_MS);
  logger.info('[Startup] Waiver review scheduler enabled (checks every 4 hours for stale waivers)');
  return id;
}
