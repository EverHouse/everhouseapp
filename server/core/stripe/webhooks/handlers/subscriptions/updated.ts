import Stripe from 'stripe';
import { getStripeClient } from '../../../client';
import { queueTierSync } from '../../../../hubspot';
import { notifyMember, notifyAllStaff } from '../../../../notificationService';
import { broadcastBillingUpdate } from '../../../../websocket';
import { logSystemAction } from '../../../../auditLog';
import { handlePrimarySubscriptionCancelled } from '../../../groupBilling';
import { pool, safeRelease } from '../../../../db';
import { logger } from '../../../../logger';
import type { PoolClient } from 'pg';
import type { DeferredAction, SubscriptionPreviousAttributes } from '../../types';
import { getErrorMessage } from '../../../../../utils/errorUtils';
import { sendPassUpdateForMemberByEmail } from '../../../../../walletPass/apnPushService';

export async function handleSubscriptionUpdated(client: PoolClient, subscription: Stripe.Subscription, previousAttributes?: SubscriptionPreviousAttributes): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const status = subscription.status;
    const currentPriceId = subscription.items?.data?.[0]?.price?.id;
    if (subscription.items?.data?.length === 0) {
      logger.warn('[Stripe Webhook] subscription.updated has empty items array, tier update skipped', { extra: { subscriptionId: subscription.id, customerId: String(customerId) } });
    }
    const subscriptionPeriodEnd = subscription.items?.data?.[0]?.current_period_end 
      ? new Date(subscription.items.data[0].current_period_end * 1000) 
      : null;

    if (previousAttributes?.items?.data) {
      const { handleSubscriptionItemsChanged } = await import('../../../groupBilling');
      const currentItems = subscription.items?.data?.map((i: Stripe.SubscriptionItem) => ({
        id: i.id,
        metadata: i.metadata,
      })) || [];
      const previousItems = previousAttributes.items.data.map((i: { id: string; metadata?: Record<string, string> }) => ({
        id: i.id,
        metadata: i.metadata,
      }));
      
      try {
        await handleSubscriptionItemsChanged(
          subscription.id,
          currentItems,
          previousItems,
        );
      } catch (itemsErr: unknown) {
        logger.error('[Stripe Webhook] handleSubscriptionItemsChanged failed (non-fatal):', { error: getErrorMessage(itemsErr) });
      }
    }

    const userResult = await client.query(
      'SELECT id, email, first_name, last_name, tier, billing_provider FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId}`);
      return deferredActions;
    }

    const { id: userId, email, first_name, last_name, tier: currentTier } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    const userBillingProvider = userResult.rows[0].billing_provider;
    if (userBillingProvider && userBillingProvider !== 'stripe') {
      logger.info(`[Stripe Webhook] Skipping subscription updated for ${email} — billing_provider is '${userBillingProvider}', not 'stripe'`);
      return deferredActions;
    }

    if (currentPriceId) {
      const tierResult = await client.query(
        'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
        [currentPriceId]
      );
      
      let newTierName: string | null = null;
      let matchMethod = 'price_id';
      
      if (tierResult.rows.length > 0) {
        newTierName = tierResult.rows[0].name;
      } else {
        const productId = subscription.items?.data?.[0]?.price?.product;
        if (productId) {
          try {
            const stripe = await getStripeClient();
            const product = await Promise.race([
              stripe.products.retrieve(typeof productId === 'string' ? productId : productId.id),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Stripe product retrieve timed out after 5s')), 5000))
            ]) as Stripe.Product;
            const productName = product.name?.toLowerCase() || '';
            
            const tierKeywords = ['vip', 'premium', 'corporate', 'core', 'social'];
            for (const keyword of tierKeywords) {
              if (productName.includes(keyword)) {
                const keywordTierResult = await client.query(
                  'SELECT slug, name FROM membership_tiers WHERE LOWER(slug) = $1 OR LOWER(name) = $1',
                  [keyword]
                );
                if (keywordTierResult.rows.length > 0) {
                  newTierName = keywordTierResult.rows[0].name;
                  matchMethod = 'product_name';
                  logger.info(`[Stripe Webhook] Tier matched by product name "${product.name}" -> ${newTierName}`);
                  break;
                }
              }
            }
          } catch (productError: unknown) {
            logger.error('[Stripe Webhook] Error fetching product for name match:', { error: getErrorMessage(productError) });
          }
        }
      }
      
      if (newTierName && newTierName !== currentTier) {
        await client.query(
          'UPDATE users SET tier = $1, billing_provider = $3, stripe_current_period_end = COALESCE($4, stripe_current_period_end), updated_at = NOW() WHERE id = $2',
          [newTierName, userId, 'stripe', subscriptionPeriodEnd]
        );
        
        logger.info(`[Stripe Webhook] Tier updated via Stripe for ${email}: ${currentTier} -> ${newTierName} (matched by ${matchMethod})`);
        
        const deferredTierEmail = email;
        const deferredOldTier = currentTier || 'None';
        const deferredNewTierName = newTierName;

        deferredActions.push(async () => {
          try {
            await queueTierSync({
              email: deferredTierEmail,
              newTier: deferredNewTierName,
              oldTier: deferredOldTier,
              changedBy: 'stripe-webhook',
              changedByName: 'Stripe Subscription'
            });
            logger.info(`[Stripe Webhook] Queued HubSpot tier sync for ${deferredTierEmail} tier=${deferredNewTierName}`);
          } catch (queueErr: unknown) {
            logger.error('[Stripe Webhook] Failed to queue tier sync:', { error: getErrorMessage(queueErr) });
          }
        });
        
        deferredActions.push(async () => {
          try {
            await notifyMember({
              userEmail: deferredTierEmail,
              title: 'Membership Updated',
              message: `Your membership has been changed to ${deferredNewTierName}.`,
              type: 'membership_tier_change',
            });
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });

        deferredActions.push(async () => {
          try {
            await sendPassUpdateForMemberByEmail(deferredTierEmail);
          } catch (pushErr: unknown) {
            logger.warn('[Stripe Webhook] Wallet pass push failed (non-fatal):', { extra: { error: getErrorMessage(pushErr) } });
          }
        });
      }
    }

    if (status === 'active') {
      const isReactivation = previousAttributes?.status && ['past_due', 'unpaid', 'suspended'].includes(previousAttributes.status);
      const allowedStatuses = isReactivation
        ? ['pending', 'inactive', 'non-member', 'past_due', 'trialing', 'suspended']
        : ['pending', 'inactive', 'non-member', 'past_due', 'trialing'];

      const activeResult = await client.query(
        `UPDATE users SET membership_status = 'active', billing_provider = 'stripe', stripe_current_period_end = COALESCE($2, stripe_current_period_end),
         membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END,
         archived_at = NULL, archived_by = NULL, updated_at = NOW() 
         WHERE id = $1 
         AND (membership_status IS NULL OR membership_status IN (${allowedStatuses.map((_, i) => `$${i + 3}`).join(', ')}))`,
        [userId, subscriptionPeriodEnd, ...allowedStatuses]
      );
      if (activeResult.rowCount === 0) {
        logger.warn(`[Stripe Webhook] Skipping active transition for ${email} — current status is terminal or incompatible`, { extra: { userId, isReactivation } });
        return deferredActions;
      }
      logger.info(`[Stripe Webhook] Membership status set to active for ${email} (reactivation=${isReactivation})`);

      const activationStatuses = ['incomplete', 'incomplete_expired'];
      const reactivationStatuses = ['past_due', 'unpaid', 'suspended'];
      if (previousAttributes?.status && activationStatuses.includes(previousAttributes.status)) {
        const deferredActivationMemberName = memberName;
        const deferredActivationEmail = email;
        const planItem = subscription.items?.data?.[0];
        const planProduct = planItem?.price?.product;
        const deferredPlanName = typeof planProduct === 'object' && planProduct && 'name' in planProduct
          ? (planProduct as Stripe.Product).name
          : (subscription.metadata?.tier || 'Membership');

        deferredActions.push(async () => {
          try {
            await notifyMember({
              userEmail: deferredActivationEmail,
              title: 'Subscription Started',
              message: `Your ${deferredPlanName} subscription has been activated. Welcome!`,
              type: 'membership_renewed',
            });
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });

        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              '🎉 New Member Joined',
              `${deferredActivationMemberName} (${deferredActivationEmail}) has subscribed to ${deferredPlanName}.`,
              'new_member',
              { sendPush: true, url: '/admin/members' }
            );
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });

        broadcastBillingUpdate({
          action: 'subscription_created',
          memberEmail: deferredActivationEmail,
          memberName: deferredActivationMemberName,
          planName: deferredPlanName
        });

        logger.info(`[Stripe Webhook] Subscription ${subscription.id} activated (was ${previousAttributes.status}) — sending New Member Joined notification`);
      } else if (previousAttributes?.status && reactivationStatuses.includes(previousAttributes.status)) {
        const deferredReactivationMemberName = memberName;
        const deferredReactivationEmail = email;
        const deferredPreviousStatus = previousAttributes.status;

        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Member Reactivated',
              `${deferredReactivationMemberName} (${deferredReactivationEmail}) membership has been reactivated (was ${deferredPreviousStatus}).`,
              'member_status_change',
              { sendPush: true, url: '/admin/members' }
            );
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });
      }
      
      try {
        const groupResult = await client.query(
          `SELECT bg.id, bg.group_name, bg.type FROM billing_groups bg 
           WHERE LOWER(bg.primary_email) = LOWER($1) AND bg.is_active = true`,
          [email]
        );
        
        if (groupResult.rows.length > 0) {
          const group = groupResult.rows[0];
          
          const subMembersResult = await client.query(
            `UPDATE users u SET membership_status = 'active', billing_provider = 'stripe',
             membership_status_changed_at = CASE WHEN u.membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE u.membership_status_changed_at END,
             updated_at = NOW()
             FROM group_members gm
             WHERE gm.billing_group_id = $1 
             AND gm.is_active = true
             AND LOWER(u.email) = LOWER(gm.member_email)
             AND u.membership_status IN ('past_due', 'suspended', 'trialing')
             AND (u.billing_provider IS NULL OR u.billing_provider = '' OR u.billing_provider = 'stripe' OR u.billing_provider = 'family_addon')
             RETURNING u.email`,
            [group.id]
          );
          
          const affectedCount = subMembersResult.rows.length;
          if (affectedCount > 0) {
            logger.info(`[Stripe Webhook] Reactivated ${affectedCount} sub-members for group ${group.group_name}`);
            
            const deferredReactivatedSubEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                for (const subEmail of deferredReactivatedSubEmails) {
                  await notifyMember({
                    userEmail: subEmail,
                    title: 'Membership Restored',
                    message: 'Your membership access has been restored. Welcome back!',
                    type: 'member_status_change',
                  }, { sendPush: true });
                }
              } catch (notifyErr: unknown) {
                logger.error('[Stripe Webhook] Sub-member reactivation notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
              }
            });
            
            const reactivatedEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
                for (const subEmail of reactivatedEmails) {
                  await syncMemberToHubSpot({ email: subEmail, status: 'active', billingProvider: 'stripe', billingGroupRole: 'Sub-member' });
                }
                logger.info(`[Stripe Webhook] Synced ${reactivatedEmails.length} reactivated sub-members to HubSpot`);
              } catch (hubspotErr: unknown) {
                logger.error('[Stripe Webhook] HubSpot sync failed for reactivated sub-members:', { error: getErrorMessage(hubspotErr) });
              }
            });

            deferredActions.push(async () => {
              for (const subEmail of deferredReactivatedSubEmails) {
                try {
                  await sendPassUpdateForMemberByEmail(subEmail);
                } catch (pushErr: unknown) {
                  logger.warn('[Stripe Webhook] Wallet pass push failed for reactivated sub-member (non-fatal):', { extra: { email: subEmail, error: getErrorMessage(pushErr) } });
                }
              }
            });
          }
        }
      } catch (groupErr: unknown) {
        logger.error('[Stripe Webhook] Error reactivating sub-members:', { error: getErrorMessage(groupErr) });
      }
      
      const deferredActiveEmail = email;
      deferredActions.push(async () => {
        try {
          const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
          await syncMemberToHubSpot({ email: deferredActiveEmail, status: 'active', billingProvider: 'stripe', billingGroupRole: 'Primary' });
          logger.info(`[Stripe Webhook] Synced ${deferredActiveEmail} status=active to HubSpot`);
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for status active:', { error: getErrorMessage(hubspotError) });
        }
      });
    } else if (status === 'past_due') {
      const pastDueResult = await client.query(
        `UPDATE users SET membership_status = 'past_due', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'past_due' THEN NOW() ELSE membership_status_changed_at END, billing_provider = 'stripe', stripe_current_period_end = COALESCE($2, stripe_current_period_end), updated_at = NOW() WHERE id = $1 AND (membership_status IS NULL OR membership_status IN ('active', 'trialing', 'past_due'))`,
        [userId, subscriptionPeriodEnd]
      );
      if (pastDueResult.rowCount === 0) {
        logger.warn(`[Stripe Webhook] Skipping past_due transition for ${email} — current status is terminal or incompatible`, { extra: { userId } });
        return deferredActions;
      }

      const statusActuallyChanged = previousAttributes?.status && previousAttributes.status !== 'past_due';

      if (statusActuallyChanged) {
        const deferredPastDueEmail = email;
        const deferredPastDueMemberName = memberName;

        deferredActions.push(async () => {
          try {
            await notifyMember({
              userEmail: deferredPastDueEmail,
              title: 'Membership Past Due',
              message: 'Your membership payment is past due. Please update your payment method to avoid service interruption.',
              type: 'membership_past_due',
            }, { sendPush: true });
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });

        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Membership Past Due',
              `${deferredPastDueMemberName} (${deferredPastDueEmail}) subscription payment is past due.`,
              'membership_past_due',
              { sendPush: true, sendWebSocket: true }
            );
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });

        logger.info(`[Stripe Webhook] Past due notification deferred for ${email}`);
      } else {
        logger.info(`[Stripe Webhook] Skipping past_due notification for ${email} — status was already past_due`);
      }
      
      try {
        const groupResult = await client.query(
          `SELECT bg.id, bg.group_name, bg.type FROM billing_groups bg 
           WHERE LOWER(bg.primary_email) = LOWER($1) AND bg.is_active = true`,
          [email]
        );
        
        if (groupResult.rows.length > 0) {
          const group = groupResult.rows[0];
          
          const subMembersResult = await client.query(
            `UPDATE users u SET membership_status = 'past_due',
             membership_status_changed_at = CASE WHEN u.membership_status IS DISTINCT FROM 'past_due' THEN NOW() ELSE u.membership_status_changed_at END,
             updated_at = NOW()
             FROM group_members gm
             WHERE gm.billing_group_id = $1 
             AND gm.is_active = true
             AND LOWER(u.email) = LOWER(gm.member_email)
             AND u.membership_status NOT IN ('cancelled', 'terminated')
             AND (u.billing_provider IS NULL OR u.billing_provider = '' OR u.billing_provider = 'stripe' OR u.billing_provider = 'family_addon')
             RETURNING u.email`,
            [group.id]
          );
          
          const affectedCount = subMembersResult.rows.length;
          if (affectedCount > 0) {
            logger.info(`[Stripe Webhook] Set ${affectedCount} sub-members to past_due for group ${group.group_name}`);
            
            const deferredPastDueSubEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                for (const subEmail of deferredPastDueSubEmails) {
                  await notifyMember({
                    userEmail: subEmail,
                    title: 'Membership Payment Issue',
                    message: 'Your membership access may be affected by a billing issue with your group account.',
                    type: 'membership_past_due',
                  }, { sendPush: true });
                }
              } catch (notifyErr: unknown) {
                logger.error('[Stripe Webhook] Sub-member past_due notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
              }
            });
            
            const pastDueEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
                for (const subEmail of pastDueEmails) {
                  await syncMemberToHubSpot({ email: subEmail, status: 'past_due', billingProvider: 'stripe', billingGroupRole: 'Sub-member' });
                }
                logger.info(`[Stripe Webhook] Synced ${pastDueEmails.length} past_due sub-members to HubSpot`);
              } catch (hubspotErr: unknown) {
                logger.error('[Stripe Webhook] HubSpot sync failed for past_due sub-members:', { error: getErrorMessage(hubspotErr) });
              }
            });

            deferredActions.push(async () => {
              for (const subEmail of deferredPastDueSubEmails) {
                try {
                  await sendPassUpdateForMemberByEmail(subEmail);
                } catch (pushErr: unknown) {
                  logger.warn('[Stripe Webhook] Wallet pass push failed for past_due sub-member (non-fatal):', { extra: { email: subEmail, error: getErrorMessage(pushErr) } });
                }
              }
            });
          }
        }
      } catch (groupErr: unknown) {
        logger.error('[Stripe Webhook] Error propagating past_due to sub-members:', { error: getErrorMessage(groupErr) });
      }
      
      const deferredPastDueSyncEmail = email;
      deferredActions.push(async () => {
        try {
          const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
          await syncMemberToHubSpot({ email: deferredPastDueSyncEmail, status: 'past_due', billingProvider: 'stripe', billingGroupRole: 'Primary' });
          logger.info(`[Stripe Webhook] Synced ${deferredPastDueSyncEmail} status=past_due to HubSpot`);
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for status past_due:', { error: getErrorMessage(hubspotError) });
        }
      });

      deferredActions.push(async () => {
        try {
          await sendPassUpdateForMemberByEmail(deferredPastDueSyncEmail);
        } catch (pushErr: unknown) {
          logger.warn('[Stripe Webhook] Wallet pass push failed for past_due (non-fatal):', { extra: { error: getErrorMessage(pushErr) } });
        }
      });
    } else if (status === 'canceled') {
      logger.info(`[Stripe Webhook] Subscription canceled for ${email} - handled by subscription.deleted webhook`);
    } else if (status === 'unpaid') {
      const unpaidResult = await client.query(
        `UPDATE users SET membership_status = 'suspended', billing_provider = 'stripe', stripe_current_period_end = COALESCE($2, stripe_current_period_end), membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'suspended' THEN NOW() ELSE membership_status_changed_at END, updated_at = NOW() WHERE id = $1 AND (membership_status IS NULL OR membership_status IN ('active', 'trialing', 'past_due', 'suspended'))`,
        [userId, subscriptionPeriodEnd]
      );
      if (unpaidResult.rowCount === 0) {
        logger.warn(`[Stripe Webhook] Skipping suspended (unpaid) transition for ${email} — current status is terminal or incompatible`, { extra: { userId } });
        return deferredActions;
      }

      const deferredUnpaidEmail = email;
      const deferredUnpaidMemberName = memberName;

      deferredActions.push(async () => {
        try {
          await notifyMember({
            userEmail: deferredUnpaidEmail,
            title: 'Membership Unpaid',
            message: 'Your membership is unpaid. Please update your payment method to restore access.',
            type: 'membership_past_due',
          }, { sendPush: true });
        } catch (notifyErr: unknown) {
          logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
        }
      });

      deferredActions.push(async () => {
        try {
          await notifyAllStaff(
            'Membership Suspended - Unpaid',
            `${deferredUnpaidMemberName} (${deferredUnpaidEmail}) subscription is unpaid and has been suspended.`,
            'membership_past_due',
            { sendPush: true, sendWebSocket: true }
          );
        } catch (notifyErr: unknown) {
          logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
        }
      });

      deferredActions.push(async () => {
        try {
          await sendPassUpdateForMemberByEmail(deferredUnpaidEmail);
        } catch (pushErr: unknown) {
          logger.warn('[Stripe Webhook] Wallet pass push failed for unpaid/suspended (non-fatal):', { extra: { error: getErrorMessage(pushErr) } });
        }
      });

      logger.info(`[Stripe Webhook] Unpaid notifications deferred for ${email}`);
      
      try {
        const groupResult = await client.query(
          `SELECT bg.id, bg.group_name, bg.type FROM billing_groups bg 
           WHERE LOWER(bg.primary_email) = LOWER($1) AND bg.is_active = true`,
          [email]
        );
        
        if (groupResult.rows.length > 0) {
          const group = groupResult.rows[0];
          
          const subMembersResult = await client.query(
            `UPDATE users u SET membership_status = 'suspended',
             membership_status_changed_at = CASE WHEN u.membership_status IS DISTINCT FROM 'suspended' THEN NOW() ELSE u.membership_status_changed_at END,
             updated_at = NOW()
             FROM group_members gm
             WHERE gm.billing_group_id = $1 
             AND gm.is_active = true
             AND LOWER(u.email) = LOWER(gm.member_email)
             AND u.membership_status NOT IN ('cancelled', 'terminated')
             AND (u.billing_provider IS NULL OR u.billing_provider = '' OR u.billing_provider = 'stripe' OR u.billing_provider = 'family_addon')
             RETURNING u.email`,
            [group.id]
          );
          
          const affectedCount = subMembersResult.rows.length;
          if (affectedCount > 0) {
            logger.info(`[Stripe Webhook] Suspended ${affectedCount} sub-members for group ${group.group_name}`);
            
            const deferredSuspendedSubEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                for (const subEmail of deferredSuspendedSubEmails) {
                  await notifyMember({
                    userEmail: subEmail,
                    title: 'Membership Suspended',
                    message: 'Your membership has been suspended due to an unpaid balance on your group account.',
                    type: 'membership_past_due',
                  }, { sendPush: true });
                }
              } catch (notifyErr: unknown) {
                logger.error('[Stripe Webhook] Sub-member suspension notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
              }
            });
            
            const suspendedEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
                for (const subEmail of suspendedEmails) {
                  await syncMemberToHubSpot({ email: subEmail, status: 'suspended', billingProvider: 'stripe', billingGroupRole: 'Sub-member' });
                }
                logger.info(`[Stripe Webhook] Synced ${suspendedEmails.length} suspended sub-members to HubSpot`);
              } catch (hubspotErr: unknown) {
                logger.error('[Stripe Webhook] HubSpot sync failed for suspended sub-members:', { error: getErrorMessage(hubspotErr) });
              }
            });

            deferredActions.push(async () => {
              for (const subEmail of deferredSuspendedSubEmails) {
                try {
                  await sendPassUpdateForMemberByEmail(subEmail);
                } catch (pushErr: unknown) {
                  logger.warn('[Stripe Webhook] Wallet pass push failed for suspended sub-member (non-fatal):', { extra: { email: subEmail, error: getErrorMessage(pushErr) } });
                }
              }
            });
          }
        }
      } catch (groupErr: unknown) {
        logger.error('[Stripe Webhook] Error propagating suspension to sub-members:', { error: getErrorMessage(groupErr) });
      }
      
      const deferredSuspendedSyncEmail = email;
      deferredActions.push(async () => {
        try {
          const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
          await syncMemberToHubSpot({ email: deferredSuspendedSyncEmail, status: 'suspended', billingProvider: 'stripe', billingGroupRole: 'Primary' });
          logger.info(`[Stripe Webhook] Synced ${deferredSuspendedSyncEmail} status=suspended to HubSpot`);
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for status suspended:', { error: getErrorMessage(hubspotError) });
        }
      });
    }

    try {
      const updatedDiscounts = subscription.discounts?.filter((d): d is Stripe.Discount => typeof d !== 'string');
      let currentCoupon: Stripe.Coupon | string | undefined = updatedDiscounts?.[0]?.source?.coupon ?? undefined;
      if (!currentCoupon) {
        for (const item of (subscription.items?.data || [])) {
          const itemDiscounts = item.discounts?.filter((d): d is Stripe.Discount => typeof d !== 'string');
          const itemCoupon = itemDiscounts?.[0]?.source?.coupon;
          if (itemCoupon) {
            currentCoupon = itemCoupon;
            break;
          }
        }
      }
      const newDiscountCode = currentCoupon
        ? (typeof currentCoupon === 'string' ? currentCoupon : (currentCoupon.name || currentCoupon.id))
        : null;
      await client.query(
        'UPDATE users SET discount_code = $1, updated_at = NOW() WHERE id = $2',
        [newDiscountCode, userId]
      );
      if (newDiscountCode) {
        logger.info(`[Stripe Webhook] Synced discount_code="${newDiscountCode}" for ${email}`);
      }
    } catch (discountErr: unknown) {
      logger.warn('[Stripe Webhook] Failed to sync discount_code from subscription', { extra: { error: getErrorMessage(discountErr) } });
    }

    broadcastBillingUpdate({
      action: 'subscription_updated',
      memberEmail: email,
      memberName,
      status
    });

    logger.info(`[Stripe Webhook] Subscription status changed to '${status}' for ${memberName} (${email})`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling subscription updated:', { error: getErrorMessage(error) });
    throw error;
  }
  return deferredActions;
}

