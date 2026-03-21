import Stripe from 'stripe';
import { notifyMember, notifyAllStaff } from '../../../../notificationService';
import { broadcastBillingUpdate } from '../../../../websocket';
import { logSystemAction } from '../../../../auditLog';
import { handlePrimarySubscriptionCancelled } from '../../../groupBilling';
import { pool, safeRelease } from '../../../../db';
import { logger } from '../../../../logger';
import type { PoolClient } from 'pg';
import type { DeferredAction } from '../../types';
import { getErrorMessage } from '../../../../../utils/errorUtils';
import { sendPassUpdateForMemberByEmail } from '../../../../../walletPass/apnPushService';

export async function handleSubscriptionDeleted(client: PoolClient, subscription: Stripe.Subscription): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const subscriptionId = subscription.id;

    try {
      await handlePrimarySubscriptionCancelled(subscriptionId);
    } catch (groupErr: unknown) {
      logger.error('[Stripe Webhook] Error in handlePrimarySubscriptionCancelled:', { error: getErrorMessage(groupErr) });
    }

    const userResult = await client.query(
      'SELECT email, first_name, last_name, membership_status, billing_provider FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId}`);
      return deferredActions;
    }

    const { email, first_name, last_name, membership_status: previousStatus } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    const userBillingProvider = userResult.rows[0].billing_provider;
    if (userBillingProvider && userBillingProvider !== 'stripe') {
      logger.info(`[Stripe Webhook] Skipping subscription deleted for ${email} — billing_provider is '${userBillingProvider}', not 'stripe'`);
      return deferredActions;
    }

    const wasTrialing = previousStatus === 'trialing';

    if (wasTrialing) {
      const pauseResult = await client.query(
        `UPDATE users SET 
          membership_status = 'paused',
          membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'paused' THEN NOW() ELSE membership_status_changed_at END,
          billing_provider = 'stripe',
          stripe_subscription_id = NULL,
          updated_at = NOW()
        WHERE LOWER(email) = LOWER($1) AND (stripe_subscription_id = $2 OR stripe_subscription_id IS NULL)`,
        [email, subscriptionId]
      );

      if (pauseResult.rowCount === 0) {
        logger.info(`[Stripe Webhook] Skipping pause for ${email} - subscription ${subscriptionId} is not their current subscription`);
        return deferredActions;
      }

      logger.info(`[Stripe Webhook] Trial ended for ${email} - membership paused (account preserved, booking blocked)`);

      const deferredEmail = email;
      const deferredMemberName = memberName;

      deferredActions.push(async () => {
        try {
          const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
          await syncMemberToHubSpot({ email: deferredEmail, status: 'paused', billingProvider: 'stripe', billingGroupRole: 'Primary' });
          logger.info(`[Stripe Webhook] Synced ${deferredEmail} status=paused to HubSpot`);
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for status paused:', { error: getErrorMessage(hubspotError) });
        }

        try {
          await notifyMember({
            userEmail: deferredEmail,
            title: 'Trial Ended',
            message: 'Your free trial has ended. Your account is still here - renew anytime to pick up where you left off!',
            type: 'membership_failed',
          });
        } catch (notifyErr: unknown) {
          logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
        }

        try {
          await notifyAllStaff(
            'Trial Expired',
            `${deferredMemberName} (${deferredEmail}) trial has ended. Membership paused (account preserved).`,
            'trial_expired',
            { sendPush: true, sendWebSocket: true }
          );
        } catch (notifyErr: unknown) {
          logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
        }
      });

      broadcastBillingUpdate({
        action: 'subscription_updated',
        memberEmail: email,
        memberName
      });

      return deferredActions;
    }

    const billingGroupResult = await client.query(
      `SELECT bg.id, bg.group_name, bg.is_active
       FROM billing_groups bg
       WHERE LOWER(bg.primary_email) = LOWER($1)`,
      [email]
    );

    if (billingGroupResult.rows.length > 0) {
      const billingGroup = billingGroupResult.rows[0];
      
      const deactivatedMembersResult = await client.query(
        `SELECT gm.member_email
         FROM group_members gm
         WHERE gm.billing_group_id = $1 AND gm.is_active = false 
         AND gm.removed_at >= NOW() - INTERVAL '1 minute'`,
        [billingGroup.id]
      );

      if (deactivatedMembersResult.rows.length > 0) {
        const orphanedEmails = (deactivatedMembersResult.rows as Array<{ member_email: string }>).map((m) => m.member_email);
        
        logger.warn(`[Stripe Webhook] ORPHAN BILLING WARNING: Primary member ${memberName} (${email}) ` +
          `subscription cancelled with ${orphanedEmails.length} group members deactivated: ${orphanedEmails.join(', ')}`);

        const deferredOrphanMemberName = memberName;
        const deferredOrphanEmail = email;
        const deferredOrphanedEmails = [...orphanedEmails];

        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Orphan Billing Alert',
              `Primary member ${deferredOrphanMemberName} (${deferredOrphanEmail}) subscription was cancelled. ` +
                `${deferredOrphanedEmails.length} group member(s) have been automatically deactivated: ${deferredOrphanedEmails.join(', ')}.`,
              'billing_alert',
              { sendPush: true }
            );
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });
      }

      if (billingGroup.is_active) {
        await client.query(
          `UPDATE billing_groups SET is_active = false, updated_at = NOW() WHERE id = $1`,
          [billingGroup.id]
        );
        logger.info(`[Stripe Webhook] Deactivated billing group ${billingGroup.id} for cancelled primary member`);
      }
    }

    const cancelResult = await client.query(
      `UPDATE users SET 
        last_tier = tier,
        tier = NULL,
        tier_id = NULL,
        membership_status = 'cancelled',
        membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'cancelled' THEN NOW() ELSE membership_status_changed_at END,
        billing_provider = 'stripe',
        stripe_subscription_id = NULL,
        grace_period_start = NULL,
        grace_period_email_count = 0,
        pending_tier_change = NULL,
        updated_at = NOW()
      WHERE LOWER(email) = LOWER($1) AND (stripe_subscription_id = $2 OR stripe_subscription_id IS NULL)`,
      [email, subscriptionId]
    );

    if (cancelResult.rowCount === 0) {
      logger.info(`[Stripe Webhook] Skipping cancellation for ${email} - subscription ${subscriptionId} is not their current subscription`);
      return deferredActions;
    }

    logger.info(`[Stripe Webhook] Updated ${email} membership_status to cancelled, tier cleared`);

    deferredActions.push(async () => {
      try {
        await sendPassUpdateForMemberByEmail(email);
      } catch (pushErr: unknown) {
        logger.warn('[Stripe Webhook] Wallet pass push failed for cancellation (non-fatal):', { extra: { error: getErrorMessage(pushErr) } });
      }
    });

    deferredActions.push(async () => {
      try {
        const { getTodayPacific, formatTimePacific } = await import('../../../../../utils/dateUtils');
        const todayStr = getTodayPacific();
        const nowTimePacific = formatTimePacific(new Date());
        const deferredClient = await pool.connect();
        let futureBookingsResult;
        try {
          futureBookingsResult = await deferredClient.query(
            `SELECT id, request_date, start_time, status FROM booking_requests 
             WHERE LOWER(user_email) = LOWER($1) 
             AND status IN ('pending', 'pending_approval', 'approved', 'confirmed', 'cancellation_pending')
             AND (request_date > $2 OR (request_date = $2 AND start_time > $3))`,
            [email, todayStr, nowTimePacific]
          );
        } finally {
          safeRelease(deferredClient);
        }

        if (futureBookingsResult.rows.length > 0) {
          const { BookingStateService } = await import('../../../../bookingService/bookingStateService');
          let cancelledCount = 0;
          const errors: string[] = [];

          for (const booking of futureBookingsResult.rows) {
            try {
              await BookingStateService.cancelBooking({
                bookingId: booking.id,
                source: 'system',
                staffNotes: 'Auto-cancelled: membership subscription ended',
              });
              cancelledCount++;
            } catch (cancelErr: unknown) {
              errors.push(`Booking #${booking.id}: ${getErrorMessage(cancelErr)}`);
            }
          }

          logger.info(`[Stripe Webhook] Auto-cancelled ${cancelledCount}/${futureBookingsResult.rows.length} future bookings for cancelled member ${email}`);

          if (cancelledCount > 0) {
            try {
              await notifyAllStaff(
                'Future Bookings Auto-Cancelled',
                `${cancelledCount} future booking(s) for ${memberName} (${email}) were automatically cancelled due to membership cancellation.`,
                'booking_cancelled',
                { sendPush: true }
              );
            } catch (notifyErr: unknown) {
              logger.warn('[Stripe Webhook] Failed to notify staff about auto-cancelled bookings:', { error: getErrorMessage(notifyErr) });
            }
          }

          if (errors.length > 0) {
            logger.error(`[Stripe Webhook] Failed to cancel ${errors.length} future bookings for ${email}:`, { extra: { errors } });
          }
        }
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Error auto-cancelling future bookings for cancelled member:', { error: getErrorMessage(err) });
      }
    });

    const deferredCancelEmail = email;
    const deferredCancelMemberName = memberName;

    deferredActions.push(async () => {
      try {
        const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
        await syncMemberToHubSpot({ email: deferredCancelEmail, status: 'cancelled', billingProvider: 'stripe', billingGroupRole: 'Primary' });
        logger.info(`[Stripe Webhook] Synced ${deferredCancelEmail} status=cancelled to HubSpot`);
      } catch (hubspotError: unknown) {
        logger.error('[Stripe Webhook] HubSpot sync failed for status cancelled:', { error: getErrorMessage(hubspotError) });
      }

      try {
        await notifyMember({
          userEmail: deferredCancelEmail,
          title: 'Membership Cancelled',
          message: 'Your membership has been cancelled. We hope to see you again soon.',
          type: 'membership_cancelled',
        });
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
      }

      try {
        await notifyAllStaff(
          'Membership Cancelled',
          `${deferredCancelMemberName} (${deferredCancelEmail}) has cancelled their membership.`,
          'membership_cancelled',
          { sendPush: true, sendWebSocket: true }
        );
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
      }
    });

    broadcastBillingUpdate({
      action: 'subscription_cancelled',
      memberEmail: email,
      memberName
    });

    logger.info(`[Stripe Webhook] Membership cancellation processed for ${memberName} (${email})`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling subscription deleted:', { error: getErrorMessage(error) });
    throw error;
  }
  return deferredActions;
}

