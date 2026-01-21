import { getStripeClient } from './client';
import { pool } from '../db';
import { normalizeTierName } from '../../utils/tierUtils';
import { findOrCreateHubSpotContact } from '../hubspot/members';
import Stripe from 'stripe';

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
    
    console.log('[Stripe Sync] Starting active subscription sync from Stripe...');
    
    const subscriptions: Stripe.Subscription[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore) {
      const listParams: Stripe.SubscriptionListParams = {
        status: 'active',
        limit: 100,
        expand: ['data.customer', 'data.items.data.price.product'],
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

    console.log(`[Stripe Sync] Found ${subscriptions.length} active subscriptions`);

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
          const product = price?.product as Stripe.Product | undefined;
          
          if (!product || typeof product === 'string') {
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

          const existingUser = await pool.query(
            'SELECT id, tier, stripe_customer_id, stripe_subscription_id, hubspot_id, first_name, last_name FROM users WHERE LOWER(email) = $1',
            [email]
          );

          if (existingUser.rows.length > 0) {
            const user = existingUser.rows[0];
            const needsUpdate = 
              user.stripe_customer_id !== stripeCustomerId ||
              user.stripe_subscription_id !== stripeSubscriptionId ||
              user.tier !== tier ||
              !user.hubspot_id;

            if (needsUpdate) {
              let hubspotId = user.hubspot_id;
              if (!hubspotId) {
                try {
                  const hubspotResult = await findOrCreateHubSpotContact(
                    email,
                    firstName || user.first_name || '',
                    lastName || user.last_name || '',
                    undefined,
                    tier
                  );
                  hubspotId = hubspotResult.contactId;
                  console.log(`[Stripe Sync] Created/found HubSpot contact ${hubspotId} for existing user ${email}`);
                } catch (hubspotErr: any) {
                  console.warn(`[Stripe Sync] Failed to create HubSpot contact for ${email}:`, hubspotErr.message);
                }
              }

              await pool.query(
                `UPDATE users 
                 SET stripe_customer_id = $1, 
                     stripe_subscription_id = $2, 
                     tier = $3,
                     membership_status = 'active',
                     billing_provider = 'stripe',
                     hubspot_id = COALESCE($5, hubspot_id),
                     updated_at = NOW()
                 WHERE id = $4`,
                [stripeCustomerId, stripeSubscriptionId, tier, user.id, hubspotId]
              );
              result.updated++;
              result.details.push({
                email,
                action: 'updated',
                tier,
              });
              console.log(`[Stripe Sync] Updated user ${email} with tier ${tier}`);
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
              console.log(`[Stripe Sync] Created/found HubSpot contact ${hubspotId} for ${email}`);
            } catch (hubspotErr: any) {
              console.warn(`[Stripe Sync] Failed to create HubSpot contact for ${email}:`, hubspotErr.message);
            }

            await pool.query(
              `INSERT INTO users (
                 email, first_name, last_name, role, tier, 
                 stripe_customer_id, stripe_subscription_id, 
                 membership_status, billing_provider, data_source,
                 hubspot_id, created_at, updated_at
               ) VALUES ($1, $2, $3, 'member', $4, $5, $6, 'active', 'stripe', 'stripe_sync', $7, NOW(), NOW())`,
              [email, firstName, lastName, tier, stripeCustomerId, stripeSubscriptionId, hubspotId]
            );
            result.created++;
            result.details.push({
              email,
              action: 'created',
              tier,
            });
            console.log(`[Stripe Sync] Created user ${email} with tier ${tier}`);
          }
        } catch (err: any) {
          const errorEmail = (subscription.customer as Stripe.Customer)?.email || 'unknown';
          result.errors.push(`Error processing ${errorEmail}: ${err.message}`);
          result.details.push({
            email: errorEmail,
            action: 'error',
            reason: err.message,
          });
          console.error(`[Stripe Sync] Error processing subscription:`, err);
        }
      }

      if (i + batchSize < subscriptions.length) {
        await sleep(100);
      }
    }

    console.log(`[Stripe Sync] Completed: created=${result.created}, updated=${result.updated}, skipped=${result.skipped}, errors=${result.errors.length}`);
    
    return result;
  } catch (error: any) {
    console.error('[Stripe Sync] Fatal error during sync:', error);
    result.success = false;
    result.errors.push(`Fatal error: ${error.message}`);
    return result;
  }
}
