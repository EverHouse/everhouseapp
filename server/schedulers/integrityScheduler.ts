import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { runAllIntegrityChecks } from '../core/dataIntegrity';
import { sendIntegrityAlertEmail } from '../emails/integrityAlertEmail';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';

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
        } catch (err) {
          console.error('[Integrity Check] Check failed:', err);
        }
      }
    }
  } catch (err) {
    console.error('[Integrity Check] Scheduler error:', err);
  }
}

export function startIntegrityScheduler(): void {
  setInterval(checkAndRunIntegrityCheck, 30 * 60 * 1000);
  console.log('[Startup] Daily integrity check scheduler enabled (runs at midnight Pacific)');
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
