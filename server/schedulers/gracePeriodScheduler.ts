import { pool } from '../core/db';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { sendGracePeriodReminderEmail } from '../emails/membershipEmails';
import { notifyAllStaff } from '../core/notificationService';

const GRACE_PERIOD_HOUR = 10;
const GRACE_PERIOD_DAYS = 3;
const REACTIVATION_LINK = 'https://everhouse.app/billing/reactivate';

async function processGracePeriodMembers(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    
    if (currentHour !== GRACE_PERIOD_HOUR) {
      return;
    }
    
    console.log('[Grace Period] Starting daily grace period check...');
    
    const membersResult = await pool.query(
      `SELECT id, email, first_name, last_name, tier, grace_period_start, grace_period_email_count
       FROM users
       WHERE grace_period_start IS NOT NULL 
         AND grace_period_email_count < $1
       ORDER BY grace_period_start ASC`,
      [GRACE_PERIOD_DAYS]
    );
    
    if (membersResult.rows.length === 0) {
      console.log('[Grace Period] No members in grace period requiring emails');
      return;
    }
    
    console.log(`[Grace Period] Found ${membersResult.rows.length} members in grace period`);
    
    for (const member of membersResult.rows) {
      const { id, email, first_name, last_name, tier, grace_period_start, grace_period_email_count } = member;
      const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;
      const newEmailCount = (grace_period_email_count || 0) + 1;
      
      try {
        await sendGracePeriodReminderEmail(email, {
          memberName,
          currentDay: newEmailCount,
          totalDays: GRACE_PERIOD_DAYS,
          reactivationLink: REACTIVATION_LINK
        });
        
        await pool.query(
          `UPDATE users SET grace_period_email_count = $1, updated_at = NOW() WHERE id = $2`,
          [newEmailCount, id]
        );
        
        console.log(`[Grace Period] Sent day ${newEmailCount} email to ${email}`);
        
        if (newEmailCount >= GRACE_PERIOD_DAYS) {
          const gracePeriodStartDate = new Date(grace_period_start);
          const now = new Date();
          const daysSinceStart = Math.floor((now.getTime() - gracePeriodStartDate.getTime()) / (1000 * 60 * 60 * 24));
          
          if (daysSinceStart >= GRACE_PERIOD_DAYS) {
            await pool.query(
              `UPDATE users SET 
                last_tier = tier,
                tier = NULL,
                membership_status = 'terminated',
                grace_period_start = NULL,
                grace_period_email_count = 0,
                updated_at = NOW()
              WHERE id = $1`,
              [id]
            );
            
            console.log(`[Grace Period] TERMINATED membership for ${email} (was tier: ${tier})`);
            
            await notifyAllStaff(
              'Membership Terminated',
              `${memberName} (${email}) membership has been terminated after ${GRACE_PERIOD_DAYS} days of failed payment. Previous tier: ${tier || 'unknown'}.`,
              'membership_terminated',
              { sendPush: true }
            );
          }
        }
      } catch (error) {
        console.error(`[Grace Period] Error processing member ${email}:`, error);
      }
    }
    
    console.log('[Grace Period] Daily check complete');
  } catch (error) {
    console.error('[Grace Period] Scheduler error:', error);
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startGracePeriodScheduler(): void {
  if (intervalId) {
    console.log('[Grace Period] Scheduler already running');
    return;
  }

  console.log(`[Startup] Grace period scheduler enabled (runs at 10am Pacific)`);
  
  intervalId = setInterval(() => {
    processGracePeriodMembers().catch(err => {
      console.error('[Grace Period] Uncaught error:', err);
    });
  }, 60 * 60 * 1000);
}

export function stopGracePeriodScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Grace Period] Scheduler stopped');
  }
}
