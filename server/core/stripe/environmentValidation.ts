import Stripe from 'stripe';
import { getStripeClient, getStripeEnvironmentInfo } from './client';
import { upsertTransactionCache } from './webhooks';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';

import { logger } from '../logger';

async function backfillTransactionCacheInBackground(stripe: Stripe): Promise<void> {
  const daysBack = 180;
  const startDate = Math.floor((Date.now() - (daysBack * 24 * 60 * 60 * 1000)) / 1000);
  let processed = 0;

  logger.info(`[Stripe Env] Auto-backfilling transaction cache (${daysBack} days)...`);

  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const params: Stripe.PaymentIntentListParams = {
      limit: 100,
      created: { gte: startDate },
      expand: ['data.customer'],
    };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.paymentIntents.list(params);

    for (const pi of page.data) {
      if (pi.status !== 'succeeded' && pi.status !== 'requires_capture') continue;
      const customer = pi.customer as Stripe.Customer | null;
      await upsertTransactionCache({
        stripeId: pi.id,
        objectType: 'payment_intent',
        amountCents: pi.amount,
        currency: pi.currency || 'usd',
        status: pi.status,
        createdAt: new Date(pi.created * 1000),
        customerId: typeof pi.customer === 'string' ? pi.customer : customer?.id,
        customerEmail: customer?.email || pi.receipt_email || pi.metadata?.email,
        customerName: customer?.name || pi.metadata?.memberName,
        description: pi.description || pi.metadata?.productName || 'Stripe payment',
        metadata: pi.metadata,
        source: 'backfill',
        paymentIntentId: pi.id,
      });
      processed++;
    }

    hasMore = page.has_more;
    if (page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id;
    }
    if (hasMore) await new Promise(resolve => setTimeout(resolve, 100));
  }

  logger.info(`[Stripe Env] Auto-backfill complete: ${processed} payment intents cached`);
}

export async function validateStripeEnvironmentIds(): Promise<void> {
  try {
    const stripe = await getStripeClient();
    const { mode } = await getStripeEnvironmentInfo();

    logger.info(`[Stripe Env] Validating stored Stripe IDs against ${mode} environment...`);

    let tiersChecked = 0;
    let tiersCleared = 0;
    let clearedSubscriptionTierCount = 0;
    let cafeChecked = 0;
    let cafeCleared = 0;
    let subsChecked = 0;
    let subsCleared = 0;
    let transactionCacheCleared = false;

    // a) Validate membership_tiers Stripe IDs
    const tiersResult = await db.execute(
      sql`SELECT id, name, stripe_product_id, stripe_price_id, product_type FROM membership_tiers WHERE stripe_product_id IS NOT NULL`
    );
    const tiers = tiersResult.rows;
    tiersChecked = tiers.length;

    for (let i = 0; i < tiers.length; i += 5) {
      const batch = tiers.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(async (tier: Record<string, unknown>) => {
          try {
            await stripe.products.retrieve(tier.stripe_product_id as string);
          } catch (error: unknown) {
            if (getErrorCode(error) === 'resource_missing') {
              const oldId = tier.stripe_product_id;
              await db.execute(
                sql`UPDATE membership_tiers SET stripe_product_id = NULL, stripe_price_id = NULL WHERE id = ${tier.id}`
              );
              logger.info(`[Stripe Env] Cleared stale Stripe IDs for tier "${tier.name}" (product ${oldId} not found in ${mode} Stripe)`);
              tiersCleared++;
              if (tier.product_type === 'subscription') {
                clearedSubscriptionTierCount++;
              }
            } else {
              throw error;
            }
          }
        })
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn(`[Stripe Env] Error checking tier product:`, { extra: { detail: result.reason?.message || result.reason } });
        }
      }
    }

    // b) Validate cafe_items Stripe IDs
    const cafeResult = await db.execute(
      sql`SELECT id, name, stripe_product_id, stripe_price_id FROM cafe_items WHERE stripe_product_id IS NOT NULL`
    );
    const cafeItems = cafeResult.rows;
    cafeChecked = cafeItems.length;

    for (let i = 0; i < cafeItems.length; i += 10) {
      const batch = cafeItems.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (item: Record<string, unknown>) => {
          try {
            await stripe.products.retrieve(item.stripe_product_id as string);
          } catch (error: unknown) {
            if (getErrorCode(error) === 'resource_missing') {
              await db.execute(
                sql`UPDATE cafe_items SET stripe_product_id = NULL, stripe_price_id = NULL WHERE id = ${item.id}`
              );
              logger.info(`[Stripe Env] Cleared stale Stripe IDs for cafe item "${item.name}"`);
              cafeCleared++;
            } else {
              throw error;
            }
          }
        })
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn(`[Stripe Env] Error checking cafe item product:`, { extra: { detail: result.reason?.message || result.reason } });
        }
      }
    }

    // c) Validate users stripe_subscription_id
    const usersResult = await db.execute(
      sql`SELECT id, email, stripe_subscription_id FROM users WHERE stripe_subscription_id IS NOT NULL`
    );
    const usersWithSubs = usersResult.rows;
    subsChecked = usersWithSubs.length;

    for (let i = 0; i < usersWithSubs.length; i += 10) {
      const batch = usersWithSubs.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (user: Record<string, unknown>) => {
          try {
            await stripe.subscriptions.retrieve(user.stripe_subscription_id as string);
          } catch (error: unknown) {
            if (getErrorCode(error) === 'resource_missing') {
              await db.execute(
                sql`UPDATE users SET stripe_subscription_id = NULL WHERE id = ${user.id}`
              );
              logger.info(`[Stripe Env] Cleared stale subscription ID for user "${user.email}"`);
              subsCleared++;
            } else {
              throw error;
            }
          }
        })
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn(`[Stripe Env] Error checking user subscription:`, { extra: { detail: result.reason?.message || result.reason } });
        }
      }
    }

    // d) Clear stripe_transaction_cache if any IDs were cleared (environment change detected)
    const totalCleared = tiersCleared + cafeCleared + subsCleared;
    if (totalCleared > 0) {
      try {
        await db.execute(sql`TRUNCATE TABLE stripe_transaction_cache`);
        transactionCacheCleared = true;
        logger.info(`[Stripe Env] Cleared transaction cache (environment change detected)`);
        backfillTransactionCacheInBackground(stripe).catch((err: unknown) => {
          logger.error('[Stripe Env] Background cache backfill failed', { extra: { detail: getErrorMessage(err) } });
        });
      } catch (truncateErr: unknown) {
        logger.warn(`[Stripe Env] Could not clear transaction cache:`, { extra: { detail: getErrorMessage(truncateErr) } });
      }
    }

    // e) Log summary
    logger.info(`[Stripe Env] Environment validation complete (${mode} mode):
  - Tiers: ${tiersChecked} checked, ${tiersCleared} stale IDs cleared
  - Cafe items: ${cafeChecked} checked, ${cafeCleared} stale IDs cleared
  - User subscriptions: ${subsChecked} checked, ${subsCleared} stale IDs cleared${transactionCacheCleared ? '\n  - Transaction cache: cleared (backfill started)' : ''}`);

    if (clearedSubscriptionTierCount > 0) {
      logger.warn(`[STARTUP WARNING] ⚠️ ${clearedSubscriptionTierCount} subscription tiers lost their Stripe product links due to environment change. Run "Sync to Stripe" from Products & Pricing before member signups will work.`);
    }

    if (cafeCleared > 0) {
      logger.warn(`[STARTUP WARNING] ⚠️ ${cafeCleared} cafe items lost their Stripe product links. Run "Sync to Stripe" to restore.`);
    }
  } catch (error: unknown) {
    logger.error('[Stripe Env] Environment validation failed (non-blocking):', { extra: { detail: getErrorMessage(error) } });
  }
}
