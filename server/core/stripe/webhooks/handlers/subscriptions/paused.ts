import Stripe from 'stripe';
import { notifyMember, notifyAllStaff } from '../../../../notificationService';
import { broadcastBillingUpdate } from '../../../../websocket';
import { logSystemAction } from '../../../../auditLog';
import { logger } from '../../../../logger';
import type { PoolClient } from 'pg';
import type { DeferredAction } from '../../types';
import { getErrorMessage } from '../../../../../utils/errorUtils';

export async function handleSubscriptionPaused(client: PoolClient, subscription: Stripe.Subscription): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

    const userResult = await client.query(
      'SELECT id, email, first_name, last_name, billing_provider FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId} (subscription.paused)`);
      return deferredActions;
    }

    const { id: userId, email, first_name, last_name } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    const userBillingProvider = userResult.rows[0].billing_provider;
    if (userBillingProvider && userBillingProvider !== 'stripe') {
      logger.info(`[Stripe Webhook] Skipping subscription paused for ${email} — billing_provider is '${userBillingProvider}', not 'stripe'`);
      return deferredActions;
    }

    const frozenResult = await client.query(
      `UPDATE users SET membership_status = 'frozen', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'frozen' THEN NOW() ELSE membership_status_changed_at END, billing_provider = 'stripe', updated_at = NOW() WHERE id = $1 AND (membership_status IS NULL OR membership_status IN ('active', 'trialing', 'past_due', 'suspended', 'frozen'))`,
      [userId]
    );
    if (frozenResult.rowCount === 0) {
      logger.warn(`[Stripe Webhook] Skipping frozen transition for ${email} — current status is terminal or incompatible`, { extra: { userId } });
      return deferredActions;
    }
    logger.info(`[Stripe Webhook] Subscription paused: ${email} membership_status set to frozen`);

    const deferredEmail = email;
    const deferredMemberName = memberName;

    deferredActions.push(async () => {
      try {
        const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
        await syncMemberToHubSpot({ email: deferredEmail, status: 'frozen', billingProvider: 'stripe', billingGroupRole: 'Primary' });
        logger.info(`[Stripe Webhook] Synced ${deferredEmail} status=frozen to HubSpot`);
      } catch (hubspotError: unknown) {
        logger.error('[Stripe Webhook] HubSpot sync failed for status frozen:', { extra: { detail: getErrorMessage(hubspotError) } });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyMember({
          userEmail: deferredEmail,
          title: 'Membership Paused',
          message: 'Your membership has been paused. You can resume anytime to restore full access.',
          type: 'member_status_change',
        });
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { extra: { detail: getErrorMessage(notifyErr) } });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Membership Paused',
          `${deferredMemberName} (${deferredEmail}) membership has been paused (frozen).`,
          'member_status_change',
          { sendPush: true, sendWebSocket: true }
        );
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { extra: { detail: getErrorMessage(notifyErr) } });
      }
    });

    broadcastBillingUpdate({
      action: 'subscription_updated',
      memberEmail: email,
      memberName,
      status: 'frozen'
    });

    deferredActions.push(async () => {
      await logSystemAction({
        action: 'subscription_paused' as 'subscription_created',
        resourceType: 'subscription',
        resourceId: subscription.id,
        resourceName: `${memberName} (${email})`,
        details: {
          source: 'stripe_webhook',
          member_email: email,
          stripe_subscription_id: subscription.id,
          new_status: 'frozen'
        }
      });
    });

    logger.info(`[Stripe Webhook] Subscription paused processed for ${memberName} (${email})`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling subscription paused:', { extra: { detail: getErrorMessage(error) } });
    throw error;
  }
  return deferredActions;
}
