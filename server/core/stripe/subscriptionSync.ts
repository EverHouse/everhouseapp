import { getStripeClient } from './client';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { normalizeTierName } from '../../utils/tierUtils';
import { findOrCreateHubSpotContact } from '../hubspot/members';
import Stripe from 'stripe';
import { getErrorMessage } from '../../utils/errorUtils';

import { logger } from '../logger';
export interface SubscriptionSyncResult {
  success: boolean;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  details: Array<{
    email: string;
    action: 'created' | 'updated' | 'skipped' | 'error';
    tier?: string;
    reason?: string;
  }>;
}

function extractTierFromProduct(product: Stripe.Product): string {
  if (product.metadata?.tier) {
    return normalizeTierName(product.metadata.tier);
  }
  
  const productName = product.name || '';
  return normalizeTierName(productName);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function syncActiveSubscriptionsFromStripe(): Promise<SubscriptionSyncResult> {
  const result: SubscriptionSyncResult = {
    success: true,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    details: [],
  };

  try {
    const stripe = await getStripeClient();
    
    try {
      const account = await stripe.accounts.retrieve();
      logger.info(`[Stripe Sync] Connected to Stripe account: ${account.id}, mode: ${account.settings?.dashboard?.display_name || 'unknown'}`);
    } catch (e: unknown) {
      logger.info('[Stripe Sync] Could not retrieve account info:', { extra: { detail: getErrorMessage(e) } });
    }
    
    logger.info('[Stripe Sync] Starting subscription sync from Stripe (active, trialing, past_due)...');
    
    const subscriptions: Stripe.Subscription[] = [];
    
    for (const status of ['active', 'trialing', 'past_due'] as const) {
      let hasMore = true;
      let startingAfter: string | undefined;

      while (hasMore) {
        const listParams: Stripe.SubscriptionListParams = {
          status,
          limit: 100,
          expand: ['data.customer', 'data.items.data.price'],
        };
        if (startingAfter) {
          listParams.starting_after = startingAfter;
        }

        const page = await stripe.subscriptions.list(listParams);
        subscriptions.push(...page.data);
        hasMore = page.has_more;
        if (page.data.length > 0) {
          startingAfter = page.data[page.data.length - 1].id;
        }
      }
    }

    logger.info(`[Stripe Sync] Found ${subscriptions.length} subscriptions (active/trialing/past_due) from global list`);
    
    if (subscriptions.length === 0) {
      logger.info('[Stripe Sync] No subscriptions from global list - checking per-customer for test clock support...');
      
      let hasMoreCustomers = true;
      let customerStartingAfter: string | undefined;
      let customerCount = 0;
      
      while (hasMoreCustomers) {
        const customerParams: Stripe.CustomerListParams = { limit: 100 };
        if (customerStartingAfter) {
          customerParams.starting_after = customerStartingAfter;
        }
        
        const customersPage = await stripe.customers.list(customerParams);
        customerCount += customersPage.data.length;
        
        for (const cust of customersPage.data) {
          try {
            for (const status of ['active', 'trialing', 'past_due'] as const) {
              const custSubs = await stripe.subscriptions.list({ 
                customer: cust.id, 
                status,
                limit: 100,
                expand: ['data.items.data.price']
              });
              for (const sub of custSubs.data) {
                (sub as unknown as Record<string, unknown>).customer = cust;
                subscriptions.push(sub);
              }
            }
          } catch (e: unknown) {
            logger.info(`[Stripe Sync] Error fetching subs for ${cust.email}: ${getErrorMessage(e)}`);
          }
        }
        
        hasMoreCustomers = customersPage.has_more;
        if (customersPage.data.length > 0) {
          customerStartingAfter = customersPage.data[customersPage.data.length - 1].id;
        }
        
        if (customerCount >= 1000) {
          logger.info('[Stripe Sync] Reached customer limit (1000)');
          break;
        }
      }
      
      logger.info(`[Stripe Sync] Scanned ${customerCount} customers, found ${subscriptions.length} subscriptions via per-customer fetch`);
    }

    const productIdsToFetch = new Set<string>();
    for (const sub of subscriptions) {
      const item = sub.items.data[0];
      const productRef = item?.price?.product;
      if (productRef && typeof productRef === 'string') {
        productIdsToFetch.add(productRef);
      }
    }
    
    const productMap = new Map<string, Stripe.Product>();
    if (productIdsToFetch.size > 0) {
      const productIds = Array.from(productIdsToFetch);
      for (let i = 0; i < productIds.length; i += 100) {
        const batch = productIds.slice(i, i + 100);
        const products = await stripe.products.list({ ids: batch, limit: 100 });
        for (const product of products.data) {
          productMap.set(product.id, product);
        }
      }
      logger.info(`[Stripe Sync] Fetched ${productMap.size} product details`);
    }

    const batchSize = 10;
    for (let i = 0; i < subscriptions.length; i += batchSize) {
      const batch = subscriptions.slice(i, i + batchSize);
      
      for (const subscription of batch) {
        try {
          const customer = subscription.customer as Stripe.Customer;
          if (!customer || typeof customer === 'string' || customer.deleted) {
            result.skipped++;
            result.details.push({
              email: 'unknown',
              action: 'skipped',
              reason: 'Customer data not available or deleted',
            });
            continue;
          }

          const email = customer.email?.toLowerCase();
          if (!email) {
            result.skipped++;
            result.details.push({
              email: 'unknown',
              action: 'skipped',
              reason: 'Customer has no email',
            });
            continue;
          }

          const item = subscription.items.data[0];
          const price = item?.price;
          const productRef = price?.product;
          
          let product: Stripe.Product | undefined;
          if (productRef && typeof productRef === 'string') {
            product = productMap.get(productRef);
          } else if (productRef && typeof productRef === 'object' && !('deleted' in productRef)) {
            product = productRef as Stripe.Product;
          }
          
          if (!product) {
            result.skipped++;
            result.details.push({
              email,
              action: 'skipped',
              reason: 'Product data not available',
            });
            continue;
          }

          const tier = extractTierFromProduct(product);
          const customerName = customer.name || '';
          const nameParts = customerName.split(' ');
          const firstName = nameParts[0] || null;
          const lastName = nameParts.slice(1).join(' ') || null;
          const stripeCustomerId = customer.id;
          const stripeSubscriptionId = subscription.id;

          const existingUser = await db.execute(sql`SELECT id, tier, stripe_customer_id, stripe_subscription_id, hubspot_id, first_name, last_name, updated_at FROM users WHERE LOWER(email) = ${email}`);

          if (existingUser.rows.length > 0) {
            const user = existingUser.rows[0] as Record<string, unknown>;
            const needsUpdate = 
              user.stripe_customer_id !== stripeCustomerId ||
              user.stripe_subscription_id !== stripeSubscriptionId ||
              user.tier !== tier ||
              !user.hubspot_id;

            if (needsUpdate) {
              if (user.updated_at && (Date.now() - new Date(user.updated_at as string).getTime()) < 5 * 60 * 1000) {
                result.skipped++;
                result.details.push({ email, action: 'skipped', reason: 'Recently updated (within 5 min), skipping to avoid webhook race' });
                continue;
              }

              let hubspotId = user.hubspot_id as string | null;
              if (!hubspotId) {
                try {
                  const hubspotResult = await findOrCreateHubSpotContact(
                    email,
                    firstName || (user.first_name as string) || '',
                    lastName || (user.last_name as string) || '',
                    undefined,
                    tier
                  );
                  hubspotId = hubspotResult.contactId;
                  logger.info(`[Stripe Sync] Created/found HubSpot contact ${hubspotId} for existing user ${email}`);
                } catch (hubspotErr: unknown) {
                  logger.warn(`[Stripe Sync] Failed to create HubSpot contact for ${email}:`, { extra: { detail: getErrorMessage(hubspotErr) } });
                }
              }

              await db.execute(sql`UPDATE users 
                 SET stripe_customer_id = ${stripeCustomerId}, 
                     stripe_subscription_id = ${stripeSubscriptionId}, 
                     tier = ${tier},
                     membership_status = 'active',
                     billing_provider = CASE WHEN billing_provider IN ('mindbody', 'manual', 'comped') THEN billing_provider ELSE 'stripe' END,
                     hubspot_id = COALESCE(${hubspotId}, hubspot_id),
                     grace_period_start = NULL,
                     grace_period_email_count = 0,
                     updated_at = NOW()
                 WHERE id = ${user.id}
                 AND (updated_at IS NULL OR updated_at < NOW() - INTERVAL '5 minutes')`);
              logger.info(`[Stripe Sync] Cleared grace period for migrated member ${email}`);
              
              try {
                const { syncMemberToHubSpot } = await import('../hubspot/stages');
                await syncMemberToHubSpot({ email, status: 'active', tier, billingProvider: 'stripe' });
              } catch (e: unknown) {
                logger.warn(`[Stripe Sync] Failed to sync to HubSpot for ${email}:`, { extra: { detail: getErrorMessage(e) } });
              }
              
              result.updated++;
              result.details.push({
                email,
                action: 'updated',
                tier,
              });
              logger.info(`[Stripe Sync] Updated user ${email} with tier ${tier}`);
            } else {
              result.skipped++;
              result.details.push({
                email,
                action: 'skipped',
                reason: 'No changes needed',
              });
            }
          } else {
            let hubspotId: string | null = null;
            try {
              const hubspotResult = await findOrCreateHubSpotContact(
                email,
                firstName || '',
                lastName || '',
                undefined,
                tier
              );
              hubspotId = hubspotResult.contactId;
              logger.info(`[Stripe Sync] Created/found HubSpot contact ${hubspotId} for ${email}`);
            } catch (hubspotErr: unknown) {
              logger.warn(`[Stripe Sync] Failed to create HubSpot contact for ${email}:`, { extra: { detail: getErrorMessage(hubspotErr) } });
            }

            const { resolveUserByEmail } = await import('./customers');
            const resolved = await resolveUserByEmail(email);
            if (resolved) {
              await db.execute(sql`UPDATE users SET stripe_customer_id = ${stripeCustomerId}, stripe_subscription_id = ${stripeSubscriptionId}, 
                 membership_status = 'active',
                 billing_provider = CASE WHEN billing_provider IN ('mindbody', 'manual', 'comped') THEN billing_provider ELSE 'stripe' END,
                 data_source = 'stripe_sync',
                 tier = COALESCE(${tier}, tier), hubspot_id = COALESCE(${hubspotId}, hubspot_id),
                 grace_period_start = NULL, grace_period_email_count = 0, updated_at = NOW()
                 WHERE id = ${resolved.userId}`);
              logger.info(`[Stripe Sync] Cleared grace period for migrated member ${email}`);
              result.updated++;
              result.details.push({ email, action: 'updated', tier, reason: `Matched via ${resolved.matchType}` });
              logger.info(`[Stripe Sync] Updated existing user ${resolved.primaryEmail} (matched ${email} via ${resolved.matchType}) with tier ${tier}`);
            } else {
            const exclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${email.toLowerCase()}`);
            if (exclusionCheck.rows.length > 0) {
              logger.info(`[Stripe Sync] Skipping user creation for ${email} — permanently deleted (sync_exclusions)`);
              result.details.push({ email, action: 'skipped', tier, reason: 'sync_exclusions' });
            } else {
            await db.execute(sql`INSERT INTO users (
                 email, first_name, last_name, role, tier, 
                 stripe_customer_id, stripe_subscription_id, 
                 membership_status, billing_provider, data_source,
                 hubspot_id, created_at, updated_at
               ) VALUES (${email}, ${firstName}, ${lastName}, ${'member'}, ${tier}, ${stripeCustomerId}, ${stripeSubscriptionId}, ${'active'}, ${'stripe'}, ${'stripe_sync'}, ${hubspotId}, NOW(), NOW())`);
            
            try {
              await findOrCreateHubSpotContact(email, firstName, lastName);
              const { syncMemberToHubSpot } = await import('../hubspot/stages');
              await syncMemberToHubSpot({ email, status: 'active', tier, billingProvider: 'stripe', memberSince: new Date() });
            } catch (e: unknown) {
              logger.warn(`[Stripe Sync] Failed to sync new user to HubSpot for ${email}:`, { extra: { detail: getErrorMessage(e) } });
            }
            
            result.created++;
            result.details.push({
              email,
              action: 'created',
              tier,
            });
            logger.info(`[Stripe Sync] Created user ${email} with tier ${tier}`);
            }
            }
          }
        } catch (err: unknown) {
          const errorEmail = (subscription.customer as Stripe.Customer)?.email || 'unknown';
          result.errors.push(`Error processing ${errorEmail}: ${getErrorMessage(err)}`);
          result.details.push({
            email: errorEmail,
            action: 'error',
            reason: getErrorMessage(err),
          });
          logger.error(`[Stripe Sync] Error processing subscription:`, { error: err });
        }
      }

      if (i + batchSize < subscriptions.length) {
        await sleep(100);
      }
    }

    logger.info(`[Stripe Sync] Completed: created=${result.created}, updated=${result.updated}, skipped=${result.skipped}, errors=${result.errors.length}`);
    
    return result;
  } catch (error: unknown) {
    logger.error('[Stripe Sync] Fatal error during sync:', { error: error });
    result.success = false;
    result.errors.push(`Fatal error: ${getErrorMessage(error)}`);
    return result;
  }
}
