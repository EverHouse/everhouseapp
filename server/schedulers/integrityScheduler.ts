import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { queryWithRetry } from '../core/db';
import { runAllIntegrityChecks, autoFixMissingTiers } from '../core/dataIntegrity';
import { sendIntegrityAlertEmail } from '../emails/integrityAlertEmail';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { alertOnScheduledTaskFailure } from '../core/dataAlerts';
import { schedulerTracker } from '../core/schedulerTracker';
import { logger } from '../core/logger';
import { getSettingBoolean } from '../core/settingsHelper';
import { getErrorMessage } from '../utils/errorUtils';
import { withRetry } from '../core/retry';

const INTEGRITY_CHECK_HOUR = 0;
const INTEGRITY_SETTING_KEY = 'last_integrity_check_date';

const STALE_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

async function tryClaimIntegritySlot(todayStr: string): Promise<boolean> {
  try {
    const result = await withRetry(
      async () => {
        const runningValue = `running:${todayStr}`;
        const completedValue = `completed:${todayStr}`;
        const staleThreshold = new Date(Date.now() - STALE_RUNNING_TIMEOUT_MS);
        return db
          .insert(systemSettings)
          .values({
            key: INTEGRITY_SETTING_KEY,
            value: runningValue,
            category: 'scheduler',
            updatedBy: 'system',
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: {
              value: runningValue,
              updatedAt: new Date(),
            },
            where: sql`${systemSettings.value} IS DISTINCT FROM ${completedValue} AND ${systemSettings.value} IS DISTINCT FROM ${todayStr} AND (${systemSettings.value} IS DISTINCT FROM ${runningValue} OR ${systemSettings.updatedAt} < ${staleThreshold})`,
          })
          .returning({ key: systemSettings.key });
      },
      {
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        onRetry: (attempt, error) => {
          logger.warn(`[Integrity Check] Retrying slot claim (attempt ${attempt}/3) after connection error`, {
            extra: { errorMessage: getErrorMessage(error) },
          });
        },
      }
    );
    
    return result.length > 0;
  } catch (err: unknown) {
    logger.error('[Integrity Check] Database error claiming slot after retries:', { error: err as Error });
    alertOnScheduledTaskFailure(
      'Daily Integrity Check',
      err instanceof Error ? err : new Error(getErrorMessage(err)),
      { context: 'Failed to claim daily integrity slot' }
    ).catch((alertErr: unknown) => {
      logger.error('[Integrity Check] Failed to send staff alert:', { error: alertErr as Error });
    });
    return false;
  }
}

async function markIntegritySlotCompleted(todayStr: string): Promise<void> {
  try {
    await withRetry(
      () => db
        .update(systemSettings)
        .set({ value: `completed:${todayStr}`, updatedAt: new Date() })
        .where(sql`${systemSettings.key} = ${INTEGRITY_SETTING_KEY}`),
      {
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        onRetry: (attempt, error) => {
          logger.warn(`[Integrity Check] Retrying mark-completed (attempt ${attempt}/3)`, {
            extra: { errorMessage: getErrorMessage(error) },
          });
        },
      }
    );
  } catch (err: unknown) {
    logger.error('[Integrity Check] Failed to mark slot as completed:', { error: err as Error });
  }
}

async function markIntegritySlotFailed(todayStr: string): Promise<void> {
  try {
    await withRetry(
      () => db
        .update(systemSettings)
        .set({ value: `failed:${todayStr}`, updatedAt: new Date() })
        .where(sql`${systemSettings.key} = ${INTEGRITY_SETTING_KEY}`),
      {
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        onRetry: (attempt, error) => {
          logger.warn(`[Integrity Check] Retrying mark-failed (attempt ${attempt}/3)`, {
            extra: { errorMessage: getErrorMessage(error) },
          });
        },
      }
    );
  } catch (err: unknown) {
    logger.error('[Integrity Check] Failed to mark slot as failed:', { error: err as Error });
  }
}

let integrityRunning = false;
let autoFixRunning = false;
let cleanupRunning = false;

async function guardedIntegrityCheck(): Promise<void> {
  if (integrityRunning) {
    logger.info('[Integrity Check] Skipping run — previous run still in progress');
    return;
  }
  integrityRunning = true;
  try {
    await checkAndRunIntegrityCheck();
  } finally {
    integrityRunning = false;
  }
}

async function guardedAutoFix(): Promise<void> {
  if (autoFixRunning) {
    logger.info('[Auto-Fix] Skipping run — previous run still in progress');
    return;
  }
  autoFixRunning = true;
  try {
    await runPeriodicAutoFix();
  } finally {
    autoFixRunning = false;
  }
}

async function guardedCleanup(): Promise<void> {
  if (cleanupRunning) {
    logger.info('[Auto-Cleanup] Skipping run — previous run still in progress');
    return;
  }
  cleanupRunning = true;
  try {
    await cleanupAbandonedPendingUsers();
  } finally {
    cleanupRunning = false;
  }
}

async function checkAndRunIntegrityCheck(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    if (currentHour >= INTEGRITY_CHECK_HOUR && currentHour <= 6) {
      const claimed = await tryClaimIntegritySlot(todayStr);
      
      if (claimed) {
        logger.info('[Integrity Check] Starting scheduled integrity check...');
        
        try {
          const { runDataCleanup } = await import('../core/dataIntegrity');
          try {
            const cleanupResult = await runDataCleanup();
            if (cleanupResult.orphanedNotifications > 0 || cleanupResult.orphanedBookings > 0) {
              logger.info(`[Integrity Check] Pre-check cleanup: ${cleanupResult.orphanedNotifications} orphaned notifications removed, ${cleanupResult.orphanedBookings} orphaned bookings marked`);
            }
          } catch (cleanupErr: unknown) {
            logger.error('[Integrity Check] Pre-check cleanup failed (continuing with checks):', { error: cleanupErr as Error });
          }

          const results = await runAllIntegrityChecks('scheduled');
          
          const totalIssues = results.reduce((sum, r) => sum + r.issueCount, 0);
          const errorCount = results.reduce((sum, r) => 
            sum + r.issues.filter(i => i.severity === 'error').length, 0
          );
          const warningCount = results.reduce((sum, r) => 
            sum + r.issues.filter(i => i.severity === 'warning').length, 0
          );
          
          logger.info(`[Integrity Check] Completed: ${totalIssues} issues found (${errorCount} errors, ${warningCount} warnings)`);
          
          if (errorCount > 0 || warningCount > 0) {
            const alertsEnabled = await getSettingBoolean('notifications.data_integrity_alerts', true);
            if (!alertsEnabled) {
              logger.info('[Integrity Check] Data integrity alerts disabled via settings, skipping email and in-app alerts');
            } else {
              const adminEmail = process.env.ADMIN_ALERT_EMAIL;
              
              if (adminEmail) {
                const emailResult = await sendIntegrityAlertEmail(results, adminEmail);
                if (emailResult.success) {
                  logger.info(`[Integrity Check] Alert email sent to ${adminEmail}`);
                } else {
                  logger.error(`[Integrity Check] Failed to send alert email: ${emailResult.error}`);
                }
              } else {
                logger.info('[Integrity Check] No ADMIN_ALERT_EMAIL configured, skipping email alert');
              }
            }
          } else {
            logger.info('[Integrity Check] No critical issues found, no alert needed');
          }
          schedulerTracker.recordRun('Integrity Check', true);
          await markIntegritySlotCompleted(todayStr);
        } catch (err: unknown) {
          logger.error('[Integrity Check] Check failed:', { error: err as Error });
          schedulerTracker.recordRun('Integrity Check', false, getErrorMessage(err));
          await markIntegritySlotFailed(todayStr);
          
          alertOnScheduledTaskFailure(
            'Daily Integrity Check',
            err instanceof Error ? err : new Error(getErrorMessage(err)),
            { context: 'Scheduled check at midnight Pacific' }
          ).catch((alertErr: unknown) => {
            logger.error('[Integrity Check] Failed to send staff alert:', { error: alertErr as Error });
          });
        }
      }
    }
  } catch (err: unknown) {
    logger.error('[Integrity Check] Scheduler error:', { error: err as Error });
    schedulerTracker.recordRun('Integrity Check', false, getErrorMessage(err));
    
    alertOnScheduledTaskFailure(
      'Daily Integrity Check',
      err instanceof Error ? err : new Error(getErrorMessage(err)),
      { context: 'Scheduler loop error' }
    ).catch((alertErr: unknown) => {
      logger.error('[Integrity Check] Failed to send staff alert:', { error: alertErr as Error });
    });
  }
}

async function runPeriodicAutoFix(): Promise<void> {
  try {
    const result = await autoFixMissingTiers();
    if (result.fixedFromAlternateEmail > 0) {
      logger.info(`[Auto-Fix] Cleared tier/status for ${result.fixedFromAlternateEmail} linked user records (data belongs to primary)`);
    }
    schedulerTracker.recordRun('Auto-Fix Tiers', true);
  } catch (err: unknown) {
    logger.error('[Auto-Fix] Periodic tier fix failed:', { error: err as Error });
    schedulerTracker.recordRun('Auto-Fix Tiers', false, getErrorMessage(err));
  }
}

async function cleanupAbandonedPendingUsers(): Promise<void> {
  try {
    const pendingResult = await queryWithRetry(
      `SELECT id, email FROM users 
      WHERE membership_status = 'pending' 
        AND created_at < NOW() - INTERVAL '24 hours'
        AND stripe_subscription_id IS NULL`,
      [],
      3
    );
    
    if (!pendingResult.rows.length) return;
    
    let deletedCount = 0;
    
    for (const user of pendingResult.rows) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`DELETE FROM notifications WHERE LOWER(user_email) = LOWER(${user.email})`);
          await tx.execute(sql`DELETE FROM push_subscriptions WHERE LOWER(user_email) = LOWER(${user.email})`);
          await tx.execute(sql`DELETE FROM user_dismissed_notices WHERE LOWER(user_email) = LOWER(${user.email})`);
          await tx.execute(sql`DELETE FROM magic_links WHERE LOWER(email) = LOWER(${user.email})`);
          await tx.execute(sql`DELETE FROM booking_participants WHERE user_id = ${user.id}`);
          await tx.execute(sql`DELETE FROM booking_requests WHERE user_id = ${user.id}`);
          await tx.execute(sql`DELETE FROM event_rsvps WHERE LOWER(user_email) = LOWER(${user.email})`);
          await tx.execute(sql`DELETE FROM wellness_enrollments WHERE LOWER(user_email) = LOWER(${user.email})`);
          await tx.execute(sql`DELETE FROM member_notes WHERE LOWER(member_email) = LOWER(${user.email})`);
          await tx.execute(sql`DELETE FROM guest_passes WHERE LOWER(member_email) = LOWER(${user.email})`);
          
          const deleteResult = await tx.execute(
            sql`DELETE FROM users WHERE id = ${user.id} RETURNING email`
          );
          
          if (deleteResult.rowCount && deleteResult.rowCount > 0) {
            deletedCount++;
          }
        });
      } catch (err: unknown) {
        logger.error(`[Auto-Cleanup] Failed to cleanup user ${user.email}:`, { error: err as Error });
      }
    }
    
    if (deletedCount > 0) {
      const emails = pendingResult.rows.slice(0, deletedCount).map(r => r.email).join(', ');
      logger.info(`[Auto-Cleanup] Deleted ${deletedCount} abandoned pending users with all related records: ${emails}`);
    }
    schedulerTracker.recordRun('Abandoned Pending Cleanup', true);
  } catch (err: unknown) {
    logger.error('[Auto-Cleanup] Failed to cleanup abandoned pending users:', { error: err as Error });
    schedulerTracker.recordRun('Abandoned Pending Cleanup', false, getErrorMessage(err));
  }
}

let schedulerIntervals: NodeJS.Timeout[] = [];

export function startIntegrityScheduler(): NodeJS.Timeout[] {
  stopIntegrityScheduler();
  const id1 = setInterval(() => { guardedIntegrityCheck().catch((err) => { logger.error('[Integrity Check] Uncaught error:', { error: err as Error }); }); }, 30 * 60 * 1000);
  const id2 = setInterval(() => { guardedAutoFix().catch((err) => { logger.error('[Auto-Fix] Uncaught error:', { error: err as Error }); }); }, 24 * 60 * 60 * 1000);
  const id3 = setInterval(() => { guardedCleanup().catch((err) => { logger.error('[Auto-Cleanup] Uncaught error:', { error: err as Error }); }); }, 6 * 60 * 60 * 1000);
  setTimeout(() => guardedCleanup().catch((err) => { logger.warn('[Scheduler] Non-critical cleanup failed:', { extra: { error: getErrorMessage(err) } }); }), 60 * 1000);
  guardedAutoFix().catch((err) => { logger.warn('[Scheduler] Non-critical auto-fix failed:', { extra: { error: getErrorMessage(err) } }); });
  schedulerIntervals = [id1, id2, id3];
  logger.info('[Startup] Daily integrity check scheduler enabled (runs midnight–6am Pacific catch-up window)');
  logger.info('[Startup] Periodic auto-fix scheduler enabled (linked-email tier cleanup — email normalization, status case, billing provider, staff role, participant linking now handled by DB triggers/constraints)');
  return schedulerIntervals;
}

export function stopIntegrityScheduler(): void {
  for (const id of schedulerIntervals) {
    clearInterval(id);
  }
  schedulerIntervals = [];
}

export async function runManualIntegrityCheck(): Promise<{
  results: Awaited<ReturnType<typeof runAllIntegrityChecks>>;
  emailSent: boolean;
  emailError?: string;
}> {
  logger.info('[Integrity Check] Running manual integrity check...');
  
  const results = await runAllIntegrityChecks();
  
  const totalIssues = results.reduce((sum, r) => sum + r.issueCount, 0);
  const errorCount = results.reduce((sum, r) => 
    sum + r.issues.filter(i => i.severity === 'error').length, 0
  );
  
  logger.info(`[Integrity Check] Manual check completed: ${totalIssues} issues found (${errorCount} errors)`);
  
  let emailSent = false;
  let emailError: string | undefined;
  
  if (errorCount > 0) {
    const adminEmail = process.env.ADMIN_ALERT_EMAIL;
    
    if (adminEmail) {
      const emailResult = await sendIntegrityAlertEmail(results, adminEmail);
      emailSent = emailResult.success;
      emailError = emailResult.error;
    }
  }
  
  return { results, emailSent, emailError };
}
