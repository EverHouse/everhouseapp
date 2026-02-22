import { schedulerTracker } from '../core/schedulerTracker';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getPacificHour, getTodayPacific, CLUB_TIMEZONE } from '../utils/dateUtils';
import { sendGracePeriodReminderEmail } from '../emails/membershipEmails';
import { notifyAllStaff } from '../core/notificationService';
import { getStripeClient } from '../core/stripe/client';
import { logger } from '../core/logger';

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
  } catch (error: unknown) {
    logger.warn('[Grace Period] Could not create billing portal session, using fallback link');
    return fallbackLink;
  }
}

async function processGracePeriodMembers(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    
    if (currentHour !== GRACE_PERIOD_HOUR) {
      return;
    }
    
    logger.info('[Grace Period] Starting daily grace period check...');
    
    const membersResult = await db.execute(
      sql`SELECT id, email, first_name, last_name, tier, grace_period_start, grace_period_email_count, stripe_customer_id
       FROM users
       WHERE grace_period_start IS NOT NULL 
         AND grace_period_email_count < ${GRACE_PERIOD_DAYS}
       ORDER BY grace_period_start ASC`
    );
    
    if (membersResult.rows.length === 0) {
      logger.info('[Grace Period] No members in grace period requiring emails');
      return;
    }
    
    logger.info(`[Grace Period] Found ${membersResult.rows.length} members in grace period`);
    
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
        
        await db.execute(
          sql`UPDATE users SET grace_period_email_count = ${newEmailCount}, updated_at = NOW() WHERE id = ${id}`
        );
        
        logger.info(`[Grace Period] Sent day ${newEmailCount} email to ${email}`);
        
        if (newEmailCount >= GRACE_PERIOD_DAYS) {
          const daysSinceStart = getDaysSinceStartPacific(new Date(grace_period_start));
          
          if (daysSinceStart >= GRACE_PERIOD_DAYS) {
            await db.execute(
              sql`UPDATE users SET 
                last_tier = tier,
                tier = NULL,
                membership_status = 'terminated',
                grace_period_start = NULL,
                grace_period_email_count = 0,
                updated_at = NOW()
              WHERE id = ${id}`
            );
            
            logger.info(`[Grace Period] TERMINATED membership for ${email} (was tier: ${tier})`);
            
            // Sync terminated status to HubSpot
            try {
              const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
              await syncMemberToHubSpot({ email, status: 'terminated', billingProvider: 'mindbody' });
              logger.info(`[Grace Period] Synced ${email} status=terminated to HubSpot`);
              schedulerTracker.recordRun('Grace Period', true);
            } catch (hubspotError: unknown) {
              logger.error('[Grace Period] HubSpot sync failed:', { error: hubspotError as Error });
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
      } catch (error: unknown) {
        logger.error(`[Grace Period] Error processing member ${email}:`, { error: error as Error });
        schedulerTracker.recordRun('Grace Period', false, String(error));
      }
    }
    
    logger.info('[Grace Period] Daily check complete');
    schedulerTracker.recordRun('Grace Period', true);
  } catch (error: unknown) {
    logger.error('[Grace Period] Scheduler error:', { error: error as Error });
    schedulerTracker.recordRun('Grace Period', false, String(error));
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startGracePeriodScheduler(): void {
  if (intervalId) {
    logger.info('[Grace Period] Scheduler already running');
    return;
  }

  logger.info(`[Startup] Grace period scheduler enabled (runs at 10am Pacific)`);
  
  intervalId = setInterval(() => {
    processGracePeriodMembers().catch((err: unknown) => {
      logger.error('[Grace Period] Uncaught error:', { error: err as Error });
      schedulerTracker.recordRun('Grace Period', false, String(err));
    });
  }, 60 * 60 * 1000);
}

export function stopGracePeriodScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Grace Period] Scheduler stopped');
  }
}
