import Stripe from 'stripe';
import { notifyMember, notifyAllStaff } from '../../../../notificationService';
import { broadcastBillingUpdate } from '../../../../websocket';
import { logSystemAction } from '../../../../auditLog';
import { logger } from '../../../../logger';
import type { PoolClient } from 'pg';
import type { DeferredAction } from '../../types';
import { getErrorMessage } from '../../../../../utils/errorUtils';
import { sendPassUpdateForMemberByEmail } from '../../../../../walletPass/apnPushService';

export async function handleSubscriptionResumed(client: PoolClient, subscription: Stripe.Subscription): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const subscriptionPeriodEnd = subscription.items?.data?.[0]?.current_period_end
      ? new Date(subscription.items.data[0].current_period_end * 1000)
      : null;

    const userResult = await client.query(
      'SELECT id, email, first_name, last_name, billing_provider FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId} (subscription.resumed)`);
      return deferredActions;
    }

    const { id: userId, email, first_name, last_name } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    const userBillingProvider = userResult.rows[0].billing_provider;
    if (userBillingProvider && userBillingProvider !== 'stripe') {
      logger.info(`[Stripe Webhook] Skipping subscription resumed for ${email} — billing_provider is '${userBillingProvider}', not 'stripe'`);
      return deferredActions;
    }

    const resumeResult = await client.query(
      `UPDATE users SET membership_status = 'active', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END, billing_provider = 'stripe', stripe_current_period_end = COALESCE($2, stripe_current_period_end), archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = $1 AND (membership_status IS NULL OR membership_status IN ('frozen', 'suspended', 'past_due', 'paused', 'inactive', 'non-member', 'trialing'))`,
      [userId, subscriptionPeriodEnd]
    );
    if (resumeResult.rowCount === 0) {
      logger.warn(`[Stripe Webhook] Skipping resume-to-active transition for ${email} — current status is terminal or incompatible`, { extra: { userId } });
      return deferredActions;
    }
    logger.info(`[Stripe Webhook] Subscription resumed: ${email} membership_status set to active`);

    const deferredEmail = email;
    const deferredMemberName = memberName;

    deferredActions.push(async () => {
      try {
        const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
        await syncMemberToHubSpot({ email: deferredEmail, status: 'active', billingProvider: 'stripe', billingGroupRole: 'Primary' });
        logger.info(`[Stripe Webhook] Synced ${deferredEmail} status=active to HubSpot`);
      } catch (hubspotError: unknown) {
        logger.error('[Stripe Webhook] HubSpot sync failed for status active:', { extra: { detail: getErrorMessage(hubspotError) } });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyMember({
          userEmail: deferredEmail,
          title: 'Membership Resumed',
          message: 'Your membership has been resumed. Welcome back!',
          type: 'membership_renewed',
        });
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { extra: { detail: getErrorMessage(notifyErr) } });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Membership Resumed',
          `${deferredMemberName} (${deferredEmail}) membership has been resumed.`,
          'member_status_change',
          { sendPush: true, sendWebSocket: true }
        );
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { extra: { detail: getErrorMessage(notifyErr) } });
      }
    });

    deferredActions.push(async () => {
      try {
        await sendPassUpdateForMemberByEmail(deferredEmail);
      } catch (pushErr: unknown) {
        logger.warn('[Stripe Webhook] Wallet pass push failed for resumed subscription (non-fatal):', { extra: { email: deferredEmail, error: getErrorMessage(pushErr) } });
      }
    });

    broadcastBillingUpdate({
      action: 'subscription_updated',
      memberEmail: email,
      memberName,
      status: 'active'
    });

    deferredActions.push(async () => {
      await logSystemAction({
        action: 'subscription_resumed' as 'subscription_created',
        resourceType: 'subscription',
        resourceId: subscription.id,
        resourceName: `${memberName} (${email})`,
        details: {
          source: 'stripe_webhook',
          member_email: email,
          stripe_subscription_id: subscription.id,
          new_status: 'active'
        }
      });
    });

    logger.info(`[Stripe Webhook] Subscription resumed processed for ${memberName} (${email})`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling subscription resumed:', { extra: { detail: getErrorMessage(error) } });
    throw error;
  }
  return deferredActions;
}
