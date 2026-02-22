import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getStripeClient } from './client';
import { confirmPaymentSuccess } from './payments';
import { findOrCreateHubSpotContact } from '../hubspot/members';
import { updateContactMembershipStatus } from '../hubspot/stages';
import Stripe from 'stripe';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';

import { logger } from '../logger';
export async function reconcileDailyPayments() {
  logger.info('[Reconcile] Starting daily payment reconciliation...');
  
  try {
    const stripe = await getStripeClient();
    
    const yesterday = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    
    let hasMore = true;
    let startingAfter: string | undefined;
    let totalChecked = 0;
    let missingPayments = 0;
    let statusMismatches = 0;

    while (hasMore) {
      const params: Record<string, unknown> = {
        created: { gte: yesterday },
        limit: 100,
      };
      if (startingAfter) {
        params.starting_after = startingAfter;
      }

      const paymentIntents = await stripe.paymentIntents.list(params);
      
      for (const pi of paymentIntents.data) {
        totalChecked++;
        
        if (pi.status === 'succeeded') {
          const result = await db.execute(sql`SELECT status FROM stripe_payment_intents WHERE stripe_payment_intent_id = ${pi.id}`);

          if (result.rows.length === 0 || (result.rows[0] as Record<string, unknown>).status !== 'succeeded') {
            logger.warn(`[Reconcile] Healing payment: ${pi.id} (${(pi.amount / 100).toFixed(2)} ${pi.currency})`);
            
            const userId = pi.metadata?.userId || pi.metadata?.email || 'unknown';
            const purpose = pi.metadata?.purpose || 'reconciled';
            await db.execute(sql`INSERT INTO stripe_payment_intents (
                stripe_payment_intent_id, user_id, amount_cents, status, purpose, created_at, updated_at
              ) VALUES (${pi.id}, ${userId}, ${pi.amount}, ${'succeeded'}, ${purpose}, NOW(), NOW())
              ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = ${'succeeded'}, updated_at = NOW()`);

            await confirmPaymentSuccess(pi.id, 'system', 'System Reconciler');
            
            if (result.rows.length === 0) missingPayments++;
            else statusMismatches++;
          }
        }
      }

      hasMore = paymentIntents.has_more;
      if (hasMore && paymentIntents.data.length > 0) {
        startingAfter = paymentIntents.data[paymentIntents.data.length - 1].id;
      }
    }

    logger.info(`[Reconcile] Complete - Checked: ${totalChecked}, Missing: ${missingPayments}, Status mismatches fixed: ${statusMismatches}`);
    
    return {
      totalChecked,
      missingPayments,
      statusMismatches
    };
  } catch (error: unknown) {
    logger.error('[Reconcile] Error during reconciliation:', { error: error });
    throw error;
  }
}

export async function reconcileSubscriptions() {
  logger.info('[Reconcile] Starting subscription reconciliation...');
  
  try {
    const stripe = await getStripeClient();
    
    const activeMembers = await db.execute(sql`SELECT stripe_customer_id, email, tier, membership_status 
       FROM users 
       WHERE stripe_customer_id IS NOT NULL 
       AND (membership_status IN ('active', 'trialing', 'past_due') OR stripe_subscription_id IS NOT NULL)`);

    let mismatches = 0;
    
    for (const member of (activeMembers.rows as Array<Record<string, unknown>>)) {
      if (!member.stripe_customer_id) continue;
      
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: member.stripe_customer_id as string,
          limit: 10
        });
        
        const hasActiveSubscription = subscriptions.data.some(s => 
          ['active', 'trialing', 'past_due'].includes(s.status)
        );

        if (!hasActiveSubscription) {
          logger.warn(`[Reconcile] Member ${member.email} (status: ${member.membership_status}) has no active Stripe subscription`);
          mismatches++;
        }
      } catch (err: unknown) {
        if (getErrorCode(err) !== 'resource_missing') {
          logger.error(`[Reconcile] Error checking subscription for ${member.email}:`, { extra: { detail: getErrorMessage(err) } });
        }
      }
    }

    logger.info(`[Reconcile] Phase 1 complete - ${activeMembers.rows.length} members checked, ${mismatches} mismatches found`);
    
    logger.info('[Reconcile] Phase 2: Checking for Stripe subscriptions missing DB users...');
    
    let subscriptionsChecked = 0;
    let usersCreated = 0;
    let hasMore = true;
    let startingAfter: string | undefined;
    
    for (const status of ['active', 'trialing', 'past_due'] as const) {
    hasMore = true;
    startingAfter = undefined;
    
    while (hasMore) {
      const params: Stripe.SubscriptionListParams = {
        status,
        limit: 100,
        expand: ['data.customer']
      };
      if (startingAfter) {
        params.starting_after = startingAfter;
      }
      
      const subscriptions = await stripe.subscriptions.list(params);
      
      for (const subscription of subscriptions.data) {
        subscriptionsChecked++;
        
        try {
          let customer: Stripe.Customer;
          
          if (typeof subscription.customer === 'string') {
            try {
              const fetchedCustomer = await stripe.customers.retrieve(subscription.customer);
              if (!fetchedCustomer || (fetchedCustomer as Stripe.DeletedCustomer).deleted) {
                logger.warn(`[Reconcile] Subscription ${subscription.id} has deleted customer - skipping`);
                continue;
              }
              customer = fetchedCustomer as Stripe.Customer;
            } catch (fetchErr: unknown) {
              logger.warn(`[Reconcile] Failed to fetch customer for subscription ${subscription.id}: ${getErrorMessage(fetchErr)}`);
              continue;
            }
          } else {
            customer = subscription.customer as Stripe.Customer;
            
            if (!customer || customer.deleted) {
              logger.warn(`[Reconcile] Subscription ${subscription.id} has deleted/missing customer - skipping`);
              continue;
            }
          }
          
          const customerEmail = customer.email?.toLowerCase();
          if (!customerEmail) {
            logger.warn(`[Reconcile] Subscription ${subscription.id} customer ${customer.id} has no email - skipping`);
            continue;
          }
          
          const existingUser = await db.execute(sql`SELECT id, email, stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${customerEmail})`);
          
          if (existingUser.rows.length > 0) {
            if (!(existingUser.rows[0] as Record<string, unknown>).stripe_customer_id) {
              await db.execute(sql`UPDATE users SET stripe_customer_id = ${customer.id}, updated_at = NOW() WHERE id = ${(existingUser.rows[0] as Record<string, unknown>).id}`);
              logger.info(`[Reconcile] Updated missing stripe_customer_id for ${customerEmail}`);
            }
            continue;
          }
          
          logger.warn(`[Reconcile] MISSING USER: Stripe subscription ${subscription.id} for ${customerEmail} has no DB user - checking linked emails...`);
          
          const customerName = customer.name || '';
          const nameParts = customerName.split(' ');
          const firstName = nameParts[0] || '';
          const lastName = nameParts.slice(1).join(' ') || '';
          
          let tierSlug: string | null = null;
          let tierName: string | null = null;
          
          const subscriptionItem = subscription.items?.data?.[0];
          const priceId = subscriptionItem?.price?.id;
          
          if (priceId) {
            const tierResult = await db.execute(sql`SELECT slug, name FROM membership_tiers WHERE stripe_price_id = ${priceId} OR founding_price_id = ${priceId}`);
            if (tierResult.rows.length > 0) {
              tierSlug = (tierResult.rows[0] as Record<string, unknown>).slug as string;
              tierName = (tierResult.rows[0] as Record<string, unknown>).name as string;
            }
          }
          
          const { resolveUserByEmail } = await import('./customers');
          const resolved = await resolveUserByEmail(customerEmail);
          if (resolved && resolved.matchType !== 'direct') {
            await db.execute(sql`UPDATE users SET stripe_customer_id = ${customer.id}, stripe_subscription_id = ${subscription.id},
               membership_status = 'active',
               billing_provider = CASE WHEN billing_provider IN ('mindbody', 'manual', 'comped') THEN billing_provider ELSE 'stripe' END,
               tier = COALESCE(${tierSlug}, tier), updated_at = NOW()
               WHERE id = ${resolved.userId}`);
            logger.info(`[Reconcile] Updated existing user ${resolved.primaryEmail} (matched ${customerEmail} via ${resolved.matchType})`);
            usersCreated++;
          } else {
          const exclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${customerEmail.toLowerCase()}`);
          if (exclusionCheck.rows.length > 0) {
            logger.info(`[Reconcile] Skipping user creation for ${customerEmail} — permanently deleted (sync_exclusions)`);
          } else {
          await db.execute(sql`INSERT INTO users (email, first_name, last_name, tier, membership_status, billing_provider, stripe_customer_id, stripe_subscription_id, join_date, created_at, updated_at)
             VALUES (${customerEmail}, ${firstName}, ${lastName}, ${tierSlug}, 'active', 'stripe', ${customer.id}, ${subscription.id}, NOW(), NOW(), NOW())
             ON CONFLICT (email) DO UPDATE SET 
               stripe_customer_id = EXCLUDED.stripe_customer_id,
               stripe_subscription_id = EXCLUDED.stripe_subscription_id,
               membership_status = 'active',
               billing_provider = CASE WHEN users.billing_provider IN ('mindbody', 'manual', 'comped') THEN users.billing_provider ELSE 'stripe' END,
               tier = COALESCE(EXCLUDED.tier, users.tier),
               updated_at = NOW()`);
          
          logger.info(`[Reconcile] Created user ${customerEmail} with tier ${tierSlug || 'none'}, subscription ${subscription.id}`);
          usersCreated++;
          }
          }
          
          try {
            const { findOrCreateHubSpotContact } = await import('../hubspot/members');
            await findOrCreateHubSpotContact(customerEmail, firstName, lastName);
            const { syncMemberToHubSpot } = await import('../hubspot/stages');
            await syncMemberToHubSpot({
              email: customerEmail,
              status: 'active',
              billingProvider: 'stripe',
              tier: tierName || undefined,
              memberSince: new Date()
            });
            logger.info(`[Reconcile] Synced ${customerEmail} to HubSpot: status=active, tier=${tierName}, billing=stripe`);
          } catch (hubspotError: unknown) {
            logger.error(`[Reconcile] HubSpot sync failed for ${customerEmail}:`, { error: hubspotError });
          }
          
        } catch (err: unknown) {
          logger.error(`[Reconcile] Error processing subscription ${subscription.id}:`, { extra: { detail: getErrorMessage(err) } });
        }
      }
      
      hasMore = subscriptions.has_more;
      if (hasMore && subscriptions.data.length > 0) {
        startingAfter = subscriptions.data[subscriptions.data.length - 1].id;
      }
    }
    } // end for loop over statuses
    
    logger.info(`[Reconcile] Phase 2 complete - ${subscriptionsChecked} subscriptions checked, ${usersCreated} users created`);
    logger.info(`[Reconcile] Subscription reconciliation complete`);
    
    return { 
      membersChecked: activeMembers.rows.length, 
      mismatches,
      subscriptionsChecked,
      usersCreated
    };
  } catch (error: unknown) {
    logger.error('[Reconcile] Error during subscription reconciliation:', { error: error });
    throw error;
  }
}
