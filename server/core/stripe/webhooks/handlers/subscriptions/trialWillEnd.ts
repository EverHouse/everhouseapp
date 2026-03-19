import Stripe from 'stripe';
import { notifyMember, notifyAllStaff } from '../../../../notificationService';
import { logger } from '../../../../logger';
import type { PoolClient } from 'pg';
import type { DeferredAction } from '../../types';
import { getErrorMessage } from '../../../../../utils/errorUtils';

export async function handleTrialWillEnd(client: PoolClient, subscription: Stripe.Subscription): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    if (!customerId) return deferredActions;

    const trialEnd = subscription.trial_end;
    if (!trialEnd) return deferredActions;

    const trialEndDate = new Date(trialEnd * 1000);
    const daysLeft = Math.max(0, Math.ceil((trialEndDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

    const memberResult = await client.query(
      `SELECT id, email, first_name, last_name, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name, stripe_customer_id FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    if (memberResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] trial_will_end: no local user for customer ${customerId}`);
      return deferredActions;
    }

    const member = memberResult.rows[0];
    const memberName = member.display_name || `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;
    const memberEmail = member.email;
    const trialEndStr = trialEndDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });

    logger.info(`[Stripe Webhook] Trial ending in ${daysLeft} days for ${memberEmail} (${customerId})`);

    deferredActions.push(async () => {
      try {
        await notifyMember({
          userEmail: memberEmail,
          title: 'Trial Ending Soon',
          message: `Your trial membership ends on ${trialEndStr}. After that, your membership will automatically continue with regular billing. Visit your billing page to review your plan.`,
          type: 'trial_ending',
        }, { sendPush: true });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to send trial ending notification:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Member Trial Ending',
          `${memberName} (${memberEmail}) trial ends on ${trialEndStr} (${daysLeft} days).`,
          'trial_ending',
          { sendPush: false }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to send staff trial ending notification:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling trial_will_end:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}
