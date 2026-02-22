import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { runAllIntegrityChecks, autoFixMissingTiers } from '../core/dataIntegrity';
import { sendIntegrityAlertEmail } from '../emails/integrityAlertEmail';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { alertOnScheduledTaskFailure } from '../core/dataAlerts';
import { schedulerTracker } from '../core/schedulerTracker';
import { logger } from '../core/logger';

const INTEGRITY_CHECK_HOUR = 0;
const INTEGRITY_SETTING_KEY = 'last_integrity_check_date';

async function tryClaimIntegritySlot(todayStr: string): Promise<boolean> {
  try {
    const result = await db
      .insert(systemSettings)
      .values({
        key: INTEGRITY_SETTING_KEY,
        value: todayStr,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: todayStr,
          updatedAt: new Date(),
        },
        where: sql`${systemSettings.value} IS DISTINCT FROM ${todayStr}`,
      })
      .returning({ key: systemSettings.key });
    
    return result.length > 0;
  } catch (err: unknown) {
    logger.error('[Integrity Check] Database error:', { error: err as Error });
    return false;
  }
}

async function checkAndRunIntegrityCheck(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    if (currentHour === INTEGRITY_CHECK_HOUR) {
      const claimed = await tryClaimIntegritySlot(todayStr);
      
      if (claimed) {
        logger.info('[Integrity Check] Starting scheduled integrity check...');
        
        try {
          const { runDataCleanup } = await import('../core/dataIntegrity');
          try {
            const cleanupResult = await runDataCleanup();
            if (cleanupResult.orphanedNotifications > 0 || cleanupResult.orphanedBookings > 0 || cleanupResult.normalizedEmails > 0) {
              logger.info(`[Integrity Check] Pre-check cleanup: ${cleanupResult.orphanedNotifications} orphaned notifications removed, ${cleanupResult.orphanedBookings} orphaned bookings marked, ${cleanupResult.normalizedEmails} emails normalized`);
            }
          } catch (cleanupErr: unknown) {
            logger.error('[Integrity Check] Pre-check cleanup failed (continuing with checks):', { error: cleanupErr as Error });
          }

          const results = await runAllIntegrityChecks();
          
          const totalIssues = results.reduce((sum, r) => sum + r.issueCount, 0);
          const errorCount = results.reduce((sum, r) => 
            sum + r.issues.filter(i => i.severity === 'error').length, 0
          );
          const warningCount = results.reduce((sum, r) => 
            sum + r.issues.filter(i => i.severity === 'warning').length, 0
          );
          
          logger.info(`[Integrity Check] Completed: ${totalIssues} issues found (${errorCount} errors, ${warningCount} warnings)`);
          
          if (errorCount > 0 || warningCount > 0) {
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
          } else {
            logger.info('[Integrity Check] No critical issues found, no alert needed');
          }
          schedulerTracker.recordRun('Integrity Check', true);
        } catch (err: unknown) {
          logger.error('[Integrity Check] Check failed:', { error: err as Error });
          schedulerTracker.recordRun('Integrity Check', false, String(err));
          
          alertOnScheduledTaskFailure(
            'Daily Integrity Check',
            err instanceof Error ? err : new Error(String(err)),
            { context: 'Scheduled check at midnight Pacific' }
          ).catch((alertErr: unknown) => {
            logger.error('[Integrity Check] Failed to send staff alert:', { error: alertErr as Error });
          });
        }
      }
    }
  } catch (err: unknown) {
    logger.error('[Integrity Check] Scheduler error:', { error: err as Error });
    schedulerTracker.recordRun('Integrity Check', false, String(err));
    
    alertOnScheduledTaskFailure(
      'Daily Integrity Check',
      err instanceof Error ? err : new Error(String(err)),
      { context: 'Scheduler loop error' }
    ).catch((alertErr: unknown) => {
      logger.error('[Integrity Check] Failed to send staff alert:', { error: alertErr as Error });
    });
  }
}

async function runPeriodicAutoFix(): Promise<void> {
  try {
    const result = await autoFixMissingTiers();
    if (result.normalizedStatusCase > 0) {
      logger.info(`[Auto-Fix] Normalized membership_status case for ${result.normalizedStatusCase} members`);
    }
    if (result.fixedBillingProvider > 0) {
      logger.info(`[Auto-Fix] Set billing_provider='mindbody' for ${result.fixedBillingProvider} members with MindBody IDs`);
    }
    if (result.fixedFromAlternateEmail > 0) {
      logger.info(`[Auto-Fix] Fixed ${result.fixedFromAlternateEmail} members, ${result.remainingWithoutTier} still without tier`);
    }
    if (result.syncedStaffRoles > 0) {
      logger.info(`[Auto-Fix] Synced staff roles for ${result.syncedStaffRoles} users`);
    }
    schedulerTracker.recordRun('Auto-Fix Tiers', true);
  } catch (err: unknown) {
    logger.error('[Auto-Fix] Periodic tier fix failed:', { error: err as Error });
    schedulerTracker.recordRun('Auto-Fix Tiers', false, String(err));
  }
}

async function cleanupAbandonedPendingUsers(): Promise<void> {
  try {
    const pendingResult = await db.execute(sql`
      SELECT id, email FROM users 
      WHERE membership_status = 'pending' 
        AND created_at < NOW() - INTERVAL '24 hours'
        AND stripe_subscription_id IS NULL
    `);
    
    if (!pendingResult.rows.length) return;
    
    let deletedCount = 0;
    
    for (const user of pendingResult.rows) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`DELETE FROM notifications WHERE user_id = ${user.id}`);
          await tx.execute(sql`DELETE FROM booking_participants WHERE user_id = ${user.id}::text`);
          await tx.execute(sql`DELETE FROM booking_sessions WHERE user_id = ${user.id}`);
          await tx.execute(sql`DELETE FROM booking_requests WHERE user_id = ${user.id}`);
          await tx.execute(sql`DELETE FROM event_rsvps WHERE LOWER(user_email) = LOWER(${user.email})`);
          await tx.execute(sql`DELETE FROM wellness_enrollments WHERE LOWER(user_email) = LOWER(${user.email})`);
          await tx.execute(sql`DELETE FROM pending_fees WHERE user_id = ${user.id}`);
          await tx.execute(sql`DELETE FROM user_notes WHERE user_id = ${user.id}`);
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
    schedulerTracker.recordRun('Abandoned Pending Cleanup', false, String(err));
  }
}

export function startIntegrityScheduler(): void {
  setInterval(checkAndRunIntegrityCheck, 30 * 60 * 1000);
  setInterval(runPeriodicAutoFix, 4 * 60 * 60 * 1000);
  setInterval(cleanupAbandonedPendingUsers, 6 * 60 * 60 * 1000);
  setTimeout(() => cleanupAbandonedPendingUsers().catch((err) => { logger.warn('[Scheduler] Non-critical cleanup failed:', err); }), 60 * 1000);
  runPeriodicAutoFix().catch((err) => { logger.warn('[Scheduler] Non-critical auto-fix failed:', err); });
  logger.info('[Startup] Daily integrity check scheduler enabled (runs at midnight Pacific)');
  logger.info('[Startup] Periodic auto-fix scheduler enabled (runs every 4 hours)');
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
