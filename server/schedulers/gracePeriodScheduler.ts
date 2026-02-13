import { schedulerTracker } from '../core/schedulerTracker';
import { pool } from '../core/db';
import { getPacificHour, getTodayPacific, CLUB_TIMEZONE } from '../utils/dateUtils';
import { sendGracePeriodReminderEmail } from '../emails/membershipEmails';
import { notifyAllStaff } from '../core/notificationService';
import { getStripeClient } from '../core/stripe/client';

const GRACE_PERIOD_HOUR = 10;
const GRACE_PERIOD_DAYS = 3;

function getDaysSinceStartPacific(graceStartDate: Date): number {
  const now = new Date();
  const nowPacific = new Date(now.toLocaleString('en-US', { timeZone: CLUB_TIMEZONE }));
  const startPacific = new Date(graceStartDate.toLocaleString('en-US', { timeZone: CLUB_TIMEZONE }));
  
  nowPacific.setHours(0, 0, 0, 0);
  startPacific.setHours(0, 0, 0, 0);
  
  return Math.floor((nowPacific.getTime() - startPacific.getTime()) / (1000 * 60 * 60 * 24));
}

async function getReactivationLink(stripeCustomerId: string | null): Promise<string> {
  const fallbackLink = 'https://everclub.app/billing';
  
  if (!stripeCustomerId) {
    return fallbackLink;
  }
  
  try {
    const stripe = await getStripeClient();
    const returnUrl = process.env.NODE_ENV === 'production' 
      ? 'https://everclub.app'
      : (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'https://everclub.app');

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
      flow_data: {
        type: 'payment_method_update',
      },
    });
    return session.url;
  } catch (error) {
    console.warn('[Grace Period] Could not create billing portal session, using fallback link');
    return fallbackLink;
  }
}

async function processGracePeriodMembers(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    
    if (currentHour !== GRACE_PERIOD_HOUR) {
      return;
    }
    
    console.log('[Grace Period] Starting daily grace period check...');
    
    const membersResult = await pool.query(
      `SELECT id, email, first_name, last_name, tier, grace_period_start, grace_period_email_count, stripe_customer_id
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
      const { id, email, first_name, last_name, tier, grace_period_start, grace_period_email_count, stripe_customer_id } = member;
      const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;
      const newEmailCount = (grace_period_email_count || 0) + 1;
      
      try {
        const reactivationLink = await getReactivationLink(stripe_customer_id);
        
        await sendGracePeriodReminderEmail(email, {
          memberName,
          currentDay: newEmailCount,
          totalDays: GRACE_PERIOD_DAYS,
          reactivationLink
        });
        
        await pool.query(
          `UPDATE users SET grace_period_email_count = $1, updated_at = NOW() WHERE id = $2`,
          [newEmailCount, id]
        );
        
        console.log(`[Grace Period] Sent day ${newEmailCount} email to ${email}`);
        
        if (newEmailCount >= GRACE_PERIOD_DAYS) {
          const daysSinceStart = getDaysSinceStartPacific(new Date(grace_period_start));
          
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
            
            // Sync terminated status to HubSpot
            try {
              const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
              await syncMemberToHubSpot({ email, status: 'terminated' });
              console.log(`[Grace Period] Synced ${email} status=terminated to HubSpot`);
              schedulerTracker.recordRun('Grace Period', true);
            } catch (hubspotError) {
              console.error('[Grace Period] HubSpot sync failed:', hubspotError);
              schedulerTracker.recordRun('Grace Period', false, String(hubspotError));
            }
            
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
        schedulerTracker.recordRun('Grace Period', false, String(error));
      }
    }
    
    console.log('[Grace Period] Daily check complete');
    schedulerTracker.recordRun('Grace Period', true);
  } catch (error) {
    console.error('[Grace Period] Scheduler error:', error);
    schedulerTracker.recordRun('Grace Period', false, String(error));
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
      schedulerTracker.recordRun('Grace Period', false, String(err));
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
