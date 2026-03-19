import Stripe from 'stripe';
import { getStripeClient } from '../../client';
import { queueTierSync } from '../../../hubspot';
import { notifyMember, notifyAllStaff } from '../../../notificationService';
import { broadcastBillingUpdate } from '../../../websocket';
import { logSystemAction } from '../../../auditLog';
import { handlePrimarySubscriptionCancelled } from '../../groupBilling';
import { pool, safeRelease } from '../../../db';
import { logger } from '../../../logger';
import { sendTrialWelcomeWithQrEmail } from '../../../../emails/trialWelcomeEmail';
import type { PoolClient } from 'pg';
import type { DeferredAction, SubscriptionPreviousAttributes } from '../types';
import { getErrorMessage } from '../../../../utils/errorUtils';
import { normalizeTierName } from '../../../../utils/tierUtils';
import { sendPassUpdateForMemberByEmail } from '../../../../walletPass/apnPushService';

export async function handleSubscriptionCreated(client: PoolClient, subscription: Stripe.Subscription): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const priceId = subscription.items?.data?.[0]?.price?.id;
    const planName = subscription.items?.data?.[0]?.price?.nickname || 
                     subscription.items?.data?.[0]?.plan?.nickname || 
                     'Membership';
    const subscriptionPeriodEnd = subscription.items?.data?.[0]?.current_period_end 
      ? new Date(subscription.items.data[0].current_period_end * 1000) 
      : null;

    let userResult = await client.query(
      'SELECT email, first_name, last_name, tier, membership_status, billing_provider, migration_status FROM users WHERE stripe_customer_id = $1 LIMIT 1',
      [customerId]
    );
    
    const purchaserEmail = subscription.metadata?.purchaser_email?.toLowerCase();
    if (userResult.rows.length === 0 && purchaserEmail) {
      logger.info(`[Stripe Webhook] No user found by customer ID, trying by email from metadata: ${purchaserEmail}`);
      userResult = await client.query(
        'SELECT email, first_name, last_name, tier, membership_status, billing_provider FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [purchaserEmail]
      );
    }

    let email: string;
    let first_name: string | null;
    let last_name: string | null;
    let currentTier: string | null;
    let currentStatus: string | null;

    if (userResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] No user found for Stripe customer ${customerId}, creating user from Stripe data`);
      
      const stripe = await getStripeClient();
      const customer = await Promise.race([
        stripe.customers.retrieve(String(customerId)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Stripe customer retrieve timed out after 5s')), 5000))
      ]) as Stripe.Customer | Stripe.DeletedCustomer;
      
      if (!customer || (customer as Stripe.DeletedCustomer).deleted) {
        logger.error(`[Stripe Webhook] Customer ${customerId} not found or deleted`);
        return deferredActions;
      }
      
      const customerEmail = (customer as Stripe.Customer).email?.toLowerCase();
      if (!customerEmail) {
        logger.error(`[Stripe Webhook] No email found for Stripe customer ${customerId}`);
        return deferredActions;
      }
      
      const metadataFirstName = subscription.metadata?.first_name;
      const metadataLastName = subscription.metadata?.last_name;
      const metadataPhone = subscription.metadata?.phone;
      
      let firstName: string;
      let lastName: string;
      
      if (metadataFirstName || metadataLastName) {
        firstName = metadataFirstName || '';
        lastName = metadataLastName || '';
        logger.info(`[Stripe Webhook] Using name from subscription metadata: ${firstName} ${lastName}`);
      } else {
        const customerName = (customer as Stripe.Customer).name || '';
        const nameParts = customerName.split(' ');
        firstName = nameParts[0] || '';
        lastName = nameParts.slice(1).join(' ') || '';
        logger.info(`[Stripe Webhook] Using name from customer object: ${firstName} ${lastName}`);
      }
      
      let tierSlug: string | null = null;
      let tierName: string | null = null;
      
      const metadataTierSlug = subscription.metadata?.tier_slug || subscription.metadata?.tierSlug;
      const metadataTierName = subscription.metadata?.tier_name || subscription.metadata?.tier;
      
      if (metadataTierSlug) {
        const tierResult = await client.query(
          'SELECT slug, name FROM membership_tiers WHERE slug = $1',
          [metadataTierSlug]
        );
        if (tierResult.rows.length > 0) {
          tierSlug = tierResult.rows[0].slug;
          tierName = tierResult.rows[0].name;
          logger.info(`[Stripe Webhook] Found tier from subscription metadata: ${tierSlug} (${tierName})`);
        } else if (metadataTierName) {
          tierSlug = metadataTierSlug;
          tierName = normalizeTierName(metadataTierName);
          logger.info(`[Stripe Webhook] Using tier from metadata (no DB match): ${tierSlug} (${tierName})`);
        }
      }
      
      if (!tierSlug && priceId) {
        const tierResult = await client.query(
          'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
          [priceId]
        );
        if (tierResult.rows.length > 0) {
          tierSlug = tierResult.rows[0].slug;
          tierName = tierResult.rows[0].name;
          logger.info(`[Stripe Webhook] Found tier from price ID: ${tierSlug} (${tierName})`);
        }
      }
      
      const statusMap: Record<string, string> = {
        'active': 'active',
        'trialing': 'trialing',
        'past_due': 'past_due',
        'incomplete': 'pending',
        'incomplete_expired': 'inactive',
        'canceled': 'cancelled',
        'unpaid': 'past_due',
        'paused': 'frozen'
      };
      const actualStatus = statusMap[subscription.status] || 'pending';
      if (subscription.status === 'incomplete') {
        logger.info(`[Stripe Webhook] Subscription ${subscription.id} has status 'incomplete' - member will stay pending until payment completes`);
      }
      if (subscription.status === 'incomplete_expired') {
        logger.info(`[Stripe Webhook] Subscription ${subscription.id} has terminal status 'incomplete_expired' - member set to inactive`);
      }
      
      const { resolveUserByEmail: resolveSubEmail } = await import('../../customers');
      const resolvedSub = await resolveSubEmail(customerEmail);
      if (resolvedSub && resolvedSub.matchType !== 'direct') {
        logger.info(`[Stripe Webhook] Email ${customerEmail} resolved to existing user ${resolvedSub.primaryEmail} via ${resolvedSub.matchType}`);
        await client.query(
          `UPDATE users SET 
            stripe_customer_id = $1, stripe_subscription_id = $2, membership_status = $3,
            membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM $3 THEN NOW() ELSE membership_status_changed_at END,
            billing_provider = 'stripe', stripe_current_period_end = COALESCE($4, stripe_current_period_end),
            tier = COALESCE($5, tier), join_date = COALESCE(join_date, NOW()),
            archived_at = NULL, archived_by = NULL, updated_at = NOW()
           WHERE id = $6`,
          [customerId, subscription.id, actualStatus, subscriptionPeriodEnd, tierName, resolvedSub.userId]
        );
        logger.info(`[Stripe Webhook] Updated existing user ${resolvedSub.primaryEmail} via linked email with tier ${tierName || 'none'}, subscription ${subscription.id}`);
      } else {
        const exclusionCheck = await client.query('SELECT 1 FROM sync_exclusions WHERE email = $1', [customerEmail.toLowerCase()]);
        if (exclusionCheck.rows.length > 0) {
          logger.info(`[Stripe Webhook] Skipping user creation for ${customerEmail} — permanently deleted (sync_exclusions)`);
        } else {
          const existingUser = await client.query(
            'SELECT id, stripe_customer_id, billing_provider, membership_status FROM users WHERE LOWER(email) = LOWER($1)',
            [customerEmail]
          );
          
          if (existingUser.rows.length > 0 && existingUser.rows[0].stripe_customer_id && existingUser.rows[0].stripe_customer_id !== String(customerId)) {
            logger.warn(`[Stripe Webhook] subscription.created: user ${customerEmail} already has stripe_customer_id=${existingUser.rows[0].stripe_customer_id}, incoming=${customerId}. Skipping overwrite — flagging for review.`);
            deferredActions.push(async () => {
              try {
                await notifyAllStaff(
                  'Stripe Customer Conflict',
                  `Subscription ${subscription.id} created for ${customerEmail}, but this user already has a different Stripe customer ID (${existingUser.rows[0].stripe_customer_id} vs ${customerId}). Please verify manually.`,
                  'billing_alert',
                  { sendPush: true }
                );
              } catch (err: unknown) {
                logger.error('[Stripe Webhook] Failed to send customer conflict alert:', { error: getErrorMessage(err) });
              }
            });
          } else {
            await client.query(
              `INSERT INTO users (email, first_name, last_name, phone, tier, membership_status, stripe_customer_id, stripe_subscription_id, billing_provider, stripe_current_period_end, join_date, created_at, updated_at)
               VALUES ($1, $2, $3, $8, $4, $7, $5, $6, 'stripe', $9, NOW(), NOW(), NOW())
               ON CONFLICT (email) DO UPDATE SET 
                 stripe_customer_id = EXCLUDED.stripe_customer_id,
                 stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                 membership_status = CASE WHEN users.billing_provider IS NULL OR users.billing_provider = '' OR users.billing_provider = 'stripe' THEN $7 ELSE users.membership_status END,
                 membership_status_changed_at = CASE WHEN (users.billing_provider IS NULL OR users.billing_provider = '' OR users.billing_provider = 'stripe') AND users.membership_status IS DISTINCT FROM $7 THEN NOW() ELSE users.membership_status_changed_at END,
                 billing_provider = CASE WHEN users.billing_provider IS NULL OR users.billing_provider = '' OR users.billing_provider = 'stripe' THEN 'stripe' ELSE users.billing_provider END,
                 stripe_current_period_end = COALESCE($9, users.stripe_current_period_end),
                 tier = COALESCE(EXCLUDED.tier, users.tier),
                 role = CASE WHEN users.role IN ('admin', 'staff') THEN users.role ELSE 'member' END,
                 archived_at = NULL,
                 archived_by = NULL,
                 join_date = COALESCE(users.join_date, NOW()),
                 first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), users.first_name),
                 last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), users.last_name),
                 phone = COALESCE(NULLIF(EXCLUDED.phone, ''), users.phone),
                 updated_at = NOW()`,
              [customerEmail, firstName, lastName, tierName, customerId, subscription.id, actualStatus, metadataPhone || '', subscriptionPeriodEnd]
            );
            
            logger.info(`[Stripe Webhook] Created user ${customerEmail} with tier ${tierName || 'none'}, phone ${metadataPhone || 'none'}, subscription ${subscription.id}`);
          }
        }
      }
      
      if (subscription.metadata?.migration === 'true') {
        await client.query(
          `UPDATE users SET migration_status = 'completed', updated_at = NOW()
           WHERE LOWER(email) = LOWER($1) AND (migration_status = 'pending' OR migration_status IS NULL)`,
          [customerEmail]
        );
        logger.info(`[Stripe Webhook] Migration subscription detected for ${customerEmail} — migration_status set to completed`);
      }

      email = customerEmail;
      first_name = firstName;
      last_name = lastName;
      currentTier = tierSlug;
      currentStatus = 'active';

      const deferredCustomerEmail = email;
      const deferredFirstName = first_name;
      const deferredLastName = last_name;
      const deferredMetadataPhone = metadataPhone || undefined;
      const deferredTierName = tierName;
      const deferredActualStatus = actualStatus;
      const deferredCustomerId = String(customerId);
      const deferredPricingInterval = subscription.items?.data?.[0]?.price?.recurring?.interval || undefined;

      deferredActions.push(async () => {
        try {
          const { findOrCreateHubSpotContact } = await import('../../../hubspot/members');
          const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
          const contactResult = await findOrCreateHubSpotContact(
            deferredCustomerEmail,
            deferredFirstName,
            deferredLastName,
            deferredMetadataPhone,
            deferredTierName || undefined
          );
          
          if (contactResult?.contactId) {
            const existingUserResult = await pool.query(
              'SELECT join_date FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
              [deferredCustomerEmail]
            );
            const existingJoinDate = existingUserResult.rows[0]?.join_date;
            await syncMemberToHubSpot({
              email: deferredCustomerEmail,
              status: deferredActualStatus,
              billingProvider: 'stripe',
              tier: deferredTierName || undefined,
              ...(existingJoinDate ? {} : { memberSince: new Date() }),
              stripeCustomerId: deferredCustomerId,
              stripePricingInterval: deferredPricingInterval,
              billingGroupRole: 'Primary',
            });
            logger.info(`[Stripe Webhook] Synced ${deferredCustomerEmail} to HubSpot contact: status=${deferredActualStatus}, tier=${deferredTierName}, billing=stripe, preservedExistingJoinDate=${!!existingJoinDate}`);
            
            if (deferredTierName) {
              await queueTierSync({
                email: deferredCustomerEmail,
                newTier: deferredTierName,
                oldTier: 'None',
                changedBy: 'stripe-webhook',
                changedByName: 'Stripe Subscription'
              });
              logger.info(`[Stripe Webhook] Queued HubSpot tier sync for ${deferredCustomerEmail} tier=${deferredTierName}`);
            }
          }
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for subscription user creation:', { extra: { detail: getErrorMessage(hubspotError) } });
          if (deferredTierName) {
            try {
              await queueTierSync({
                email: deferredCustomerEmail,
                newTier: deferredTierName,
                oldTier: 'None',
                changedBy: 'stripe-webhook',
                changedByName: 'Stripe Subscription'
              });
            } catch (queueErr: unknown) {
              logger.error('[Stripe Webhook] Failed to queue tier sync retry:', { error: getErrorMessage(queueErr) });
            }
          }
        }
      });
    } else {
      email = userResult.rows[0].email;
      first_name = userResult.rows[0].first_name;
      last_name = userResult.rows[0].last_name;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      currentTier = userResult.rows[0].tier;
      currentStatus = userResult.rows[0].membership_status;

      const existingBillingProvider = userResult.rows[0].billing_provider;
      if (existingBillingProvider && existingBillingProvider !== 'stripe') {
        logger.info(`[Stripe Webhook] Skipping subscription created for ${email} — billing_provider is '${existingBillingProvider}', not 'stripe'`);
        return deferredActions;
      }

      const statusMap: Record<string, string> = {
        'active': 'active',
        'trialing': 'trialing',
        'past_due': 'past_due',
        'incomplete': 'pending',
        'incomplete_expired': 'inactive',
        'canceled': 'cancelled',
        'unpaid': 'past_due',
        'paused': 'frozen'
      };
      const mappedStatus = statusMap[subscription.status] || 'pending';
      const shouldActivate = ['pending', 'inactive', 'non-member', null].includes(currentStatus) && 
                              (subscription.status === 'active' || subscription.status === 'trialing');

      await client.query(
        `UPDATE users SET 
          stripe_subscription_id = $1,
          stripe_customer_id = COALESCE(stripe_customer_id, $5),
          stripe_current_period_end = COALESCE($2, stripe_current_period_end),
          billing_provider = 'stripe',
          membership_status = CASE 
            WHEN membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member', 'terminated', 'cancelled', 'expired', 'former_member', 'deleted', 'suspended', 'frozen', 'froze', 'declined', 'churned') THEN $3
            ELSE membership_status 
          END,
          membership_status_changed_at = CASE
            WHEN membership_status IS DISTINCT FROM $3 AND (membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member', 'terminated', 'cancelled', 'expired', 'former_member', 'deleted', 'suspended', 'frozen', 'froze', 'declined', 'churned')) THEN NOW()
            ELSE membership_status_changed_at
          END,
          archived_at = NULL,
          archived_by = NULL,
          join_date = CASE WHEN join_date IS NULL AND $3 = 'active' THEN NOW() ELSE join_date END,
          updated_at = NOW()
        WHERE LOWER(email) = LOWER($4)`,
        [subscription.id, subscriptionPeriodEnd, mappedStatus, email, customerId]
      );
      logger.info(`[Stripe Webhook] Updated existing user ${email}: subscription=${subscription.id}, customerId=${customerId}, status=${mappedStatus} (stripe: ${subscription.status}), shouldActivate=${shouldActivate}`);

      if (subscription.metadata?.migration === 'true') {
        await client.query(
          `UPDATE users SET migration_status = 'completed', updated_at = NOW()
           WHERE LOWER(email) = LOWER($1) AND (migration_status = 'pending' OR migration_status IS NULL)`,
          [email]
        );
        logger.info(`[Stripe Webhook] Migration subscription detected for ${email} — migration_status set to completed`);
      }
    }

    try {
      const subDiscounts = subscription.discounts?.filter((d): d is Stripe.Discount => typeof d !== 'string');
      let subCoupon: Stripe.Coupon | string | undefined = subDiscounts?.[0]?.source?.coupon ?? undefined;
      if (!subCoupon) {
        for (const item of (subscription.items?.data || [])) {
          const itemDiscounts = item.discounts?.filter((d): d is Stripe.Discount => typeof d !== 'string');
          const itemCoupon = itemDiscounts?.[0]?.source?.coupon;
          if (itemCoupon) {
            subCoupon = itemCoupon;
            break;
          }
        }
      }
      if (subCoupon) {
        const couponName = typeof subCoupon === 'string' ? subCoupon : (subCoupon.name || subCoupon.id);
        await client.query(
          'UPDATE users SET discount_code = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2)',
          [couponName, email]
        );
        logger.info(`[Stripe Webhook] Set discount_code="${couponName}" for new subscription user ${email}`);
      }
    } catch (discountErr: unknown) {
      logger.warn('[Stripe Webhook] Failed to set discount_code from subscription coupon', { extra: { error: getErrorMessage(discountErr) } });
    }

    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    const deferredNotifyEmail = email;
    const deferredNotifyMemberName = memberName;
    const deferredPlanName = planName;

    const isActivated = subscription.status === 'active' || subscription.status === 'trialing';

    if (isActivated) {
      deferredActions.push(async () => {
        try {
          await notifyMember({
            userEmail: deferredNotifyEmail,
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
            `${deferredNotifyMemberName} (${deferredNotifyEmail}) has subscribed to ${deferredPlanName}.`,
            'new_member',
            { sendPush: true, url: '/admin/members' }
          );
        } catch (notifyErr: unknown) {
          logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
        }
      });

      broadcastBillingUpdate({
        action: 'subscription_created',
        memberEmail: email,
        memberName,
        planName
      });
    } else {
      logger.info(`[Stripe Webhook] Subscription ${subscription.id} status is '${subscription.status}' — deferring activation notifications until payment completes`);
    }

    let activationTierSlug: string | null = null;
    let activationTierName: string | null = null;
    
    const metadataTierSlug = subscription.metadata?.tier_slug || subscription.metadata?.tierSlug;
    const metadataTierName = subscription.metadata?.tier_name || subscription.metadata?.tier;
    
    if (metadataTierSlug) {
      const tierResult = await client.query(
        'SELECT slug, name FROM membership_tiers WHERE slug = $1',
        [metadataTierSlug]
      );
      if (tierResult.rows.length > 0) {
        activationTierSlug = tierResult.rows[0].slug;
        activationTierName = tierResult.rows[0].name;
        logger.info(`[Stripe Webhook] Found activation tier from subscription metadata: ${activationTierSlug} (${activationTierName})`);
      } else if (metadataTierName) {
        activationTierSlug = metadataTierSlug;
        activationTierName = metadataTierName;
        logger.info(`[Stripe Webhook] Using activation tier from metadata (no DB match): ${activationTierSlug} (${activationTierName})`);
      }
    }
    
    if (!activationTierSlug && priceId) {
      const tierResult = await client.query(
        'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
        [priceId]
      );
      if (tierResult.rows.length > 0) {
        activationTierSlug = tierResult.rows[0].slug;
        activationTierName = tierResult.rows[0].name;
        logger.info(`[Stripe Webhook] Found activation tier from price ID: ${activationTierSlug} (${activationTierName})`);
      }
    }
    
    if (activationTierSlug) {
      try {
        const tierSlug = activationTierSlug;
        const tierName = activationTierName;
          
        const updateResult = await client.query(
          `UPDATE users SET 
            tier = $1, 
            billing_provider = 'stripe',
            stripe_customer_id = COALESCE(stripe_customer_id, $3),
            stripe_subscription_id = COALESCE(stripe_subscription_id, $4),
            stripe_current_period_end = COALESCE($5, stripe_current_period_end),
            membership_status = CASE 
              WHEN membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member', 'terminated', 'cancelled', 'expired', 'former_member', 'deleted', 'suspended', 'frozen', 'froze', 'declined', 'churned') THEN $6
              ELSE membership_status 
            END,
            membership_status_changed_at = CASE
              WHEN membership_status IS DISTINCT FROM $6 AND (membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member', 'terminated', 'cancelled', 'expired', 'former_member', 'deleted', 'suspended', 'frozen', 'froze', 'declined', 'churned')) THEN NOW()
              ELSE membership_status_changed_at
            END,
            archived_at = NULL, archived_by = NULL,
            updated_at = NOW() 
          WHERE LOWER(email) = LOWER($2) 
          RETURNING id`,
          [tierName || tierSlug, email, customerId, subscription.id, subscriptionPeriodEnd, (subscription.status === 'active' || subscription.status === 'trialing') ? 'active' : 'pending']
        );
          
          if (updateResult.rowCount && updateResult.rowCount > 0) {
            logger.info(`[Stripe Webhook] User activation: ${email} tier updated to ${tierSlug}, membership_status conditionally set to ${(subscription.status === 'active' || subscription.status === 'trialing') ? 'active' : 'pending'} (subscription status: ${subscription.status})`);
            
            const deferredActivationEmail = email;
            const deferredActivationTierName = tierName;
            const deferredActivationStatus = (subscription.status === 'active' || subscription.status === 'trialing') ? 'active' : 'pending';
            const deferredActivationCustomerId = String(customerId);
            const deferredActivationInterval = subscription.items?.data?.[0]?.price?.recurring?.interval || undefined;

            deferredActions.push(async () => {
              try {
                const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
                const existingUserResult = await pool.query(
                  'SELECT join_date FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
                  [deferredActivationEmail]
                );
                const existingJoinDate = existingUserResult.rows[0]?.join_date;
                await syncMemberToHubSpot({
                  email: deferredActivationEmail,
                  status: deferredActivationStatus,
                  billingProvider: 'stripe',
                  tier: deferredActivationTierName ?? undefined,
                  ...(existingJoinDate ? {} : { memberSince: new Date() }),
                  stripeCustomerId: deferredActivationCustomerId,
                  stripePricingInterval: deferredActivationInterval,
                  billingGroupRole: 'Primary',
                });
                logger.info(`[Stripe Webhook] Synced existing user ${deferredActivationEmail} to HubSpot: tier=${deferredActivationTierName}, status=${deferredActivationStatus}, billing=stripe, preservedExistingJoinDate=${!!existingJoinDate}`);
              } catch (hubspotError: unknown) {
                logger.error('[Stripe Webhook] HubSpot sync failed for existing user subscription:', { error: getErrorMessage(hubspotError) });
              }
            });
            
            const quantity = subscription.items?.data?.[0]?.quantity || 1;
            const companyName = subscription.metadata?.company_name;
            const tierType = subscription.metadata?.tier_type;
            
            if (tierType === 'corporate' && quantity > 1 && companyName) {
              try {
                const { createCorporateBillingGroupFromSubscription } = await import('../../groupBilling');
                const groupResult = await createCorporateBillingGroupFromSubscription({
                  primaryEmail: email,
                  companyName: companyName,
                  quantity: quantity,
                  stripeCustomerId: String(customerId),
                  stripeSubscriptionId: subscription.id,
                });
                if (groupResult.success) {
                  logger.info(`[Stripe Webhook] Auto-created corporate billing group for ${email}: ${companyName} with ${quantity} seats`);
                } else {
                  logger.warn(`[Stripe Webhook] Failed to auto-create corporate billing group: ${groupResult.error}`);
                }
              } catch (groupError: unknown) {
                logger.error('[Stripe Webhook] Error auto-creating corporate billing group:', { error: getErrorMessage(groupError) });
              }
            }
          } else {
            logger.info(`[Stripe Webhook] User activation: ${email} - no update performed`);
          }

          try {
            const dealUpdateResult = await client.query(
              `UPDATE hubspot_deals SET last_payment_status = 'current', last_payment_check = NOW() WHERE LOWER(member_email) = LOWER($1) RETURNING id`,
              [email]
            );
            
            if (dealUpdateResult.rowCount && dealUpdateResult.rowCount > 0) {
              logger.info(`[Stripe Webhook] User activation: ${email} HubSpot deal updated to current payment status`);
            }
          } catch (hubspotError: unknown) {
            logger.error('[Stripe Webhook] Error updating HubSpot deal:', { error: getErrorMessage(hubspotError) });
          }
      } catch (tierActivationError: unknown) {
        logger.error('[Stripe Webhook] Error during tier activation:', { error: getErrorMessage(tierActivationError) });
      }
    } else {
      const productId = subscription.items?.data?.[0]?.price?.product;
      if (productId) {
        const deferredEmail = email;
        const deferredProductId = typeof productId === 'string' ? productId : productId.id;
        const deferredSubscriptionPeriodEnd = subscriptionPeriodEnd;
        const deferredSubscriptionStatus = subscription.status;
        deferredActions.push(async () => {
          try {
            const stripe = await getStripeClient();
            const product = await stripe.products.retrieve(deferredProductId);
            const productName = product.name?.toLowerCase() || '';

            const tierKeywords = ['vip', 'premium', 'corporate', 'core', 'social'];
            for (const keyword of tierKeywords) {
              if (productName.includes(keyword)) {
                const deferredClient = await pool.connect();
                try {
                  const keywordTierResult = await deferredClient.query(
                    'SELECT slug, name FROM membership_tiers WHERE LOWER(slug) = $1 OR LOWER(name) = $1',
                    [keyword]
                  );
                  if (keywordTierResult.rows.length > 0) {
                    const { name: tierName } = keywordTierResult.rows[0];

                    const updateResult = await deferredClient.query(
                      `UPDATE users SET 
                        tier = $1, 
                        membership_status = CASE 
                          WHEN membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member', 'terminated', 'cancelled', 'expired', 'former_member', 'deleted', 'suspended', 'frozen', 'froze', 'declined', 'churned') THEN $4
                          ELSE membership_status 
                        END,
                        membership_status_changed_at = CASE
                          WHEN membership_status IS DISTINCT FROM $4 AND (membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member', 'terminated', 'cancelled', 'expired', 'former_member', 'deleted', 'suspended', 'frozen', 'froze', 'declined', 'churned')) THEN NOW()
                          ELSE membership_status_changed_at
                        END,
                        billing_provider = 'stripe',
                        stripe_current_period_end = COALESCE($3, stripe_current_period_end),
                        updated_at = NOW() 
                      WHERE email = $2 
                      RETURNING id`,
                      [tierName, deferredEmail, deferredSubscriptionPeriodEnd, (deferredSubscriptionStatus === 'active' || deferredSubscriptionStatus === 'trialing') ? 'active' : 'pending']
                    );

                    if (updateResult.rowCount && updateResult.rowCount > 0) {
                      logger.info(`[Stripe Webhook] User activation (product name match): ${deferredEmail} tier updated to ${tierName} from product "${product.name}"`);

                      try {
                        const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
                        const mappedHubSpotStatus = (deferredSubscriptionStatus === 'active' || deferredSubscriptionStatus === 'trialing') ? 'active' : 'pending';
                        const existingUserResult = await pool.query(
                          'SELECT join_date FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
                          [deferredEmail]
                        );
                        const existingJoinDate = existingUserResult.rows[0]?.join_date;
                        await syncMemberToHubSpot({
                          email: deferredEmail,
                          status: mappedHubSpotStatus,
                          billingProvider: 'stripe',
                          tier: tierName,
                          ...(existingJoinDate ? {} : { memberSince: new Date() }),
                          billingGroupRole: 'Primary',
                        });
                        logger.info(`[Stripe Webhook] Synced ${deferredEmail} to HubSpot: tier=${tierName}, status=${mappedHubSpotStatus}, billing=stripe, preservedExistingJoinDate=${!!existingJoinDate}`);
                      } catch (hubspotError: unknown) {
                        logger.error('[Stripe Webhook] HubSpot sync failed for product name match:', { error: getErrorMessage(hubspotError) });
                      }
                    }
                    break;
                  }
                } finally {
                  safeRelease(deferredClient);
                }
              }
            }
          } catch (productError: unknown) {
            logger.error('[Stripe Webhook] Error fetching product for name match:', { error: getErrorMessage(productError) });
          }
        });
      } else {
        logger.warn(`[Stripe Webhook] No tier found for price ID ${priceId}`);
      }
    }

    try {
      let restoreTierClause = '';
      let queryParams: (string | number | null)[] = [email];
      
      if (priceId) {
        const tierResult = await client.query(
          'SELECT slug FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
          [priceId]
        );
        if (tierResult.rows.length > 0) {
          restoreTierClause = ', tier = COALESCE(tier, $2)';
          queryParams = [email, tierResult.rows[0].slug];
        }
      }
      
      await client.query(
        `UPDATE users SET 
          grace_period_start = NULL,
          grace_period_email_count = 0,
          billing_provider = 'stripe'${restoreTierClause},
          updated_at = NOW()
        WHERE LOWER(email) = LOWER($1)`,
        queryParams
      );
      logger.info(`[Stripe Webhook] Cleared grace period and set billing_provider for ${email}`);
    } catch (gracePeriodError: unknown) {
      logger.error('[Stripe Webhook] Error clearing grace period:', { error: getErrorMessage(gracePeriodError) });
    }

    if (subscription.status === 'trialing') {
      const userIdResult = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (userIdResult.rows.length > 0) {
        const userId = userIdResult.rows[0].id;
        const trialEndDate = subscription.trial_end 
          ? new Date(subscription.trial_end * 1000) 
          : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const couponCode = subscription.discounts?.[0] && typeof subscription.discounts[0] !== 'string' ? ((subscription.discounts[0] as unknown as { coupon?: { id: string } }).coupon?.id) : subscription.metadata?.coupon_code || undefined;

        deferredActions.push(async () => {
          try {
            await sendTrialWelcomeWithQrEmail(email, {
              firstName: first_name || undefined,
              userId,
              trialEndDate,
              couponCode
            });
            logger.info(`[Stripe Webhook] Trial welcome QR email sent to ${email}`);
          } catch (emailError: unknown) {
            logger.error(`[Stripe Webhook] Failed to send trial welcome email to ${email}:`, { error: getErrorMessage(emailError) });
          }
        });
      }
    }

    logger.info(`[Stripe Webhook] New subscription created for ${memberName} (${email}): ${planName}`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling subscription created:', { error: getErrorMessage(error) });
    throw error;
  }
  return deferredActions;
}

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
      const { handleSubscriptionItemsChanged } = await import('../../groupBilling');
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
                const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
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
          const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
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
                const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
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
          const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
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
                const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
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
          const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
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
        const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
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
        const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
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
          const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
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
        membership_status = 'cancelled',
        membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'cancelled' THEN NOW() ELSE membership_status_changed_at END,
        billing_provider = 'stripe',
        stripe_subscription_id = NULL,
        grace_period_start = NULL,
        grace_period_email_count = 0,
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
        const { getTodayPacific, formatTimePacific } = await import('../../../../utils/dateUtils');
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
          const { BookingStateService } = await import('../../../bookingService/bookingStateService');
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
        const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
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
