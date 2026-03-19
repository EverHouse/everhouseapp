import Stripe from 'stripe';
import { getStripeClient } from '../../../client';
import { queueTierSync } from '../../../../hubspot';
import { notifyMember, notifyAllStaff } from '../../../../notificationService';
import { broadcastBillingUpdate } from '../../../../websocket';
import { logSystemAction } from '../../../../auditLog';
import { handlePrimarySubscriptionCancelled } from '../../../groupBilling';
import { pool, safeRelease } from '../../../../db';
import { logger } from '../../../../logger';
import { sendTrialWelcomeWithQrEmail } from '../../../../../emails/trialWelcomeEmail';
import type { PoolClient } from 'pg';
import type { DeferredAction, SubscriptionPreviousAttributes } from '../../types';
import { getErrorMessage } from '../../../../../utils/errorUtils';
import { normalizeTierName } from '../../../../../utils/tierUtils';
import { sendPassUpdateForMemberByEmail } from '../../../../../walletPass/apnPushService';

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
        'unpaid': 'suspended',
        'paused': 'frozen'
      };
      const actualStatus = statusMap[subscription.status] || 'pending';
      if (subscription.status === 'incomplete') {
        logger.info(`[Stripe Webhook] Subscription ${subscription.id} has status 'incomplete' - member will stay pending until payment completes`);
      }
      if (subscription.status === 'incomplete_expired') {
        logger.info(`[Stripe Webhook] Subscription ${subscription.id} has terminal status 'incomplete_expired' - member set to inactive`);
      }
      
      const { resolveUserByEmail: resolveSubEmail } = await import('../../../customers');
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
          const { findOrCreateHubSpotContact } = await import('../../../../hubspot/members');
          const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
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
        'unpaid': 'suspended',
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
                const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
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
                const { createCorporateBillingGroupFromSubscription } = await import('../../../groupBilling');
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
                        const { syncMemberToHubSpot } = await import('../../../../hubspot/stages');
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

