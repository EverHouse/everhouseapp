import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { runAllIntegrityChecks, autoFixMissingTiers } from '../core/dataIntegrity';
import { sendIntegrityAlertEmail } from '../emails/integrityAlertEmail';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { alertOnScheduledTaskFailure } from '../core/dataAlerts';
import { schedulerTracker } from '../core/schedulerTracker';

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
  } catch (err) {
    console.error('[Integrity Check] Database error:', err);
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
        console.log('[Integrity Check] Starting scheduled integrity check...');
        
        try {
          const { runDataCleanup } = await import('../core/dataIntegrity');
          try {
            const cleanupResult = await runDataCleanup();
            if (cleanupResult.orphanedNotifications > 0 || cleanupResult.orphanedBookings > 0 || cleanupResult.normalizedEmails > 0) {
              console.log(`[Integrity Check] Pre-check cleanup: ${cleanupResult.orphanedNotifications} orphaned notifications removed, ${cleanupResult.orphanedBookings} orphaned bookings marked, ${cleanupResult.normalizedEmails} emails normalized`);
            }
          } catch (cleanupErr) {
            console.error('[Integrity Check] Pre-check cleanup failed (continuing with checks):', cleanupErr);
          }

          const results = await runAllIntegrityChecks();
          
          const totalIssues = results.reduce((sum, r) => sum + r.issueCount, 0);
          const errorCount = results.reduce((sum, r) => 
            sum + r.issues.filter(i => i.severity === 'error').length, 0
          );
          const warningCount = results.reduce((sum, r) => 
            sum + r.issues.filter(i => i.severity === 'warning').length, 0
          );
          
          console.log(`[Integrity Check] Completed: ${totalIssues} issues found (${errorCount} errors, ${warningCount} warnings)`);
          
          if (errorCount > 0 || warningCount > 0) {
            const adminEmail = process.env.ADMIN_ALERT_EMAIL;
            
            if (adminEmail) {
              const emailResult = await sendIntegrityAlertEmail(results, adminEmail);
              if (emailResult.success) {
                console.log(`[Integrity Check] Alert email sent to ${adminEmail}`);
              } else {
                console.error(`[Integrity Check] Failed to send alert email: ${emailResult.error}`);
              }
            } else {
              console.log('[Integrity Check] No ADMIN_ALERT_EMAIL configured, skipping email alert');
            }
          } else {
            console.log('[Integrity Check] No critical issues found, no alert needed');
          }
          schedulerTracker.recordRun('Integrity Check', true);
        } catch (err) {
          console.error('[Integrity Check] Check failed:', err);
          schedulerTracker.recordRun('Integrity Check', false, String(err));
          
          alertOnScheduledTaskFailure(
            'Daily Integrity Check',
            err instanceof Error ? err : new Error(String(err)),
            { context: 'Scheduled check at midnight Pacific' }
          ).catch(alertErr => {
            console.error('[Integrity Check] Failed to send staff alert:', alertErr);
          });
        }
      }
    }
  } catch (err) {
    console.error('[Integrity Check] Scheduler error:', err);
    schedulerTracker.recordRun('Integrity Check', false, String(err));
    
    alertOnScheduledTaskFailure(
      'Daily Integrity Check',
      err instanceof Error ? err : new Error(String(err)),
      { context: 'Scheduler loop error' }
    ).catch(alertErr => {
      console.error('[Integrity Check] Failed to send staff alert:', alertErr);
    });
  }
}

async function runPeriodicAutoFix(): Promise<void> {
  try {
    const result = await autoFixMissingTiers();
    if (result.normalizedStatusCase > 0) {
      console.log(`[Auto-Fix] Normalized membership_status case for ${result.normalizedStatusCase} members`);
    }
    if (result.fixedBillingProvider > 0) {
      console.log(`[Auto-Fix] Set billing_provider='mindbody' for ${result.fixedBillingProvider} members with MindBody IDs`);
    }
    if (result.fixedFromAlternateEmail > 0) {
      console.log(`[Auto-Fix] Fixed ${result.fixedFromAlternateEmail} members, ${result.remainingWithoutTier} still without tier`);
    }
    if (result.syncedStaffRoles > 0) {
      console.log(`[Auto-Fix] Synced staff roles for ${result.syncedStaffRoles} users`);
    }
    schedulerTracker.recordRun('Auto-Fix Tiers', true);
  } catch (err) {
    console.error('[Auto-Fix] Periodic tier fix failed:', err);
    schedulerTracker.recordRun('Auto-Fix Tiers', false, String(err));
  }
}

async function cleanupAbandonedPendingUsers(): Promise<void> {
  try {
    const { pool } = await import('../core/db');
    
    if (!pool) {
      console.log('[Auto-Cleanup] Database pool not ready, skipping cleanup');
      return;
    }
    
    const pendingResult = await pool.query(`
      SELECT id, email FROM users 
      WHERE membership_status = 'pending' 
        AND created_at < NOW() - INTERVAL '24 hours'
        AND stripe_subscription_id IS NULL
    `);
    
    if (!pendingResult.rows.length) return;
    
    let deletedCount = 0;
    
    for (const user of pendingResult.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        await client.query('DELETE FROM notifications WHERE user_id = $1', [user.id]);
        await client.query('DELETE FROM booking_participants WHERE user_id = $1::text', [user.id]);
        await client.query('DELETE FROM booking_sessions WHERE user_id = $1', [user.id]);
        await client.query('DELETE FROM booking_requests WHERE user_id = $1', [user.id]);
        await client.query('DELETE FROM event_rsvps WHERE LOWER(user_email) = LOWER($1)', [user.email]);
        await client.query('DELETE FROM wellness_enrollments WHERE LOWER(user_email) = LOWER($1)', [user.email]);
        await client.query('DELETE FROM pending_fees WHERE user_id = $1', [user.id]);
        await client.query('DELETE FROM user_notes WHERE user_id = $1', [user.id]);
        await client.query('DELETE FROM guest_passes WHERE LOWER(member_email) = LOWER($1)', [user.email]);
        
        const deleteResult = await client.query(
          'DELETE FROM users WHERE id = $1 RETURNING email',
          [user.id]
        );
        
        await client.query('COMMIT');
        
        if (deleteResult.rowCount && deleteResult.rowCount > 0) {
          deletedCount++;
        }
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[Auto-Cleanup] Failed to cleanup user ${user.email}:`, err);
      } finally {
        client.release();
      }
    }
    
    if (deletedCount > 0) {
      const emails = pendingResult.rows.slice(0, deletedCount).map(r => r.email).join(', ');
      console.log(`[Auto-Cleanup] Deleted ${deletedCount} abandoned pending users with all related records: ${emails}`);
    }
    schedulerTracker.recordRun('Abandoned Pending Cleanup', true);
  } catch (err) {
    console.error('[Auto-Cleanup] Failed to cleanup abandoned pending users:', err);
    schedulerTracker.recordRun('Abandoned Pending Cleanup', false, String(err));
  }
}

export function startIntegrityScheduler(): void {
  setInterval(checkAndRunIntegrityCheck, 30 * 60 * 1000);
  setInterval(runPeriodicAutoFix, 4 * 60 * 60 * 1000);
  setInterval(cleanupAbandonedPendingUsers, 6 * 60 * 60 * 1000);
  setTimeout(() => cleanupAbandonedPendingUsers().catch(() => {}), 60 * 1000);
  runPeriodicAutoFix().catch(() => {});
  console.log('[Startup] Daily integrity check scheduler enabled (runs at midnight Pacific)');
  console.log('[Startup] Periodic auto-fix scheduler enabled (runs every 4 hours)');
}

export async function runManualIntegrityCheck(): Promise<{
  results: Awaited<ReturnType<typeof runAllIntegrityChecks>>;
  emailSent: boolean;
  emailError?: string;
}> {
  console.log('[Integrity Check] Running manual integrity check...');
  
  const results = await runAllIntegrityChecks();
  
  const totalIssues = results.reduce((sum, r) => sum + r.issueCount, 0);
  const errorCount = results.reduce((sum, r) => 
    sum + r.issues.filter(i => i.severity === 'error').length, 0
  );
  
  console.log(`[Integrity Check] Manual check completed: ${totalIssues} issues found (${errorCount} errors)`);
  
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
