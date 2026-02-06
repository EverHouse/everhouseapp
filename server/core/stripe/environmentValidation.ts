import { getStripeClient, getStripeEnvironmentInfo } from './client';
import { pool } from '../db';

export async function validateStripeEnvironmentIds(): Promise<void> {
  try {
    const stripe = await getStripeClient();
    const { mode } = await getStripeEnvironmentInfo();

    console.log(`[Stripe Env] Validating stored Stripe IDs against ${mode} environment...`);

    let tiersChecked = 0;
    let tiersCleared = 0;
    let clearedSubscriptionTierCount = 0;
    let cafeChecked = 0;
    let cafeCleared = 0;
    let subsChecked = 0;
    let subsCleared = 0;
    let transactionCacheCleared = false;

    // a) Validate membership_tiers Stripe IDs
    const tiersResult = await pool.query(
      `SELECT id, name, stripe_product_id, stripe_price_id, product_type FROM membership_tiers WHERE stripe_product_id IS NOT NULL`
    );
    const tiers = tiersResult.rows;
    tiersChecked = tiers.length;

    for (let i = 0; i < tiers.length; i += 5) {
      const batch = tiers.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(async (tier: any) => {
          try {
            await stripe.products.retrieve(tier.stripe_product_id);
          } catch (error: any) {
            if (error.code === 'resource_missing') {
              const oldId = tier.stripe_product_id;
              await pool.query(
                `UPDATE membership_tiers SET stripe_product_id = NULL, stripe_price_id = NULL WHERE id = $1`,
                [tier.id]
              );
              console.log(`[Stripe Env] Cleared stale Stripe IDs for tier "${tier.name}" (product ${oldId} not found in ${mode} Stripe)`);
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
          console.warn(`[Stripe Env] Error checking tier product:`, result.reason?.message || result.reason);
        }
      }
    }

    // b) Validate cafe_items Stripe IDs
    const cafeResult = await pool.query(
      `SELECT id, name, stripe_product_id, stripe_price_id FROM cafe_items WHERE stripe_product_id IS NOT NULL`
    );
    const cafeItems = cafeResult.rows;
    cafeChecked = cafeItems.length;

    for (let i = 0; i < cafeItems.length; i += 10) {
      const batch = cafeItems.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (item: any) => {
          try {
            await stripe.products.retrieve(item.stripe_product_id);
          } catch (error: any) {
            if (error.code === 'resource_missing') {
              await pool.query(
                `UPDATE cafe_items SET stripe_product_id = NULL, stripe_price_id = NULL WHERE id = $1`,
                [item.id]
              );
              console.log(`[Stripe Env] Cleared stale Stripe IDs for cafe item "${item.name}"`);
              cafeCleared++;
            } else {
              throw error;
            }
          }
        })
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn(`[Stripe Env] Error checking cafe item product:`, result.reason?.message || result.reason);
        }
      }
    }

    // c) Validate users stripe_subscription_id
    const usersResult = await pool.query(
      `SELECT id, email, stripe_subscription_id FROM users WHERE stripe_subscription_id IS NOT NULL`
    );
    const usersWithSubs = usersResult.rows;
    subsChecked = usersWithSubs.length;

    for (let i = 0; i < usersWithSubs.length; i += 10) {
      const batch = usersWithSubs.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (user: any) => {
          try {
            await stripe.subscriptions.retrieve(user.stripe_subscription_id);
          } catch (error: any) {
            if (error.code === 'resource_missing') {
              await pool.query(
                `UPDATE users SET stripe_subscription_id = NULL WHERE id = $1`,
                [user.id]
              );
              console.log(`[Stripe Env] Cleared stale subscription ID for user "${user.email}"`);
              subsCleared++;
            } else {
              throw error;
            }
          }
        })
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn(`[Stripe Env] Error checking user subscription:`, result.reason?.message || result.reason);
        }
      }
    }

    // d) Clear stripe_transaction_cache if any IDs were cleared (environment change detected)
    const totalCleared = tiersCleared + cafeCleared + subsCleared;
    if (totalCleared > 0) {
      try {
        await pool.query(`TRUNCATE TABLE stripe_transaction_cache`);
        transactionCacheCleared = true;
        console.log(`[Stripe Env] Cleared transaction cache (environment change detected)`);
      } catch (truncateErr: any) {
        console.warn(`[Stripe Env] Could not clear transaction cache:`, truncateErr.message);
      }
    }

    // e) Log summary
    console.log(`[Stripe Env] Environment validation complete (${mode} mode):
  - Tiers: ${tiersChecked} checked, ${tiersCleared} stale IDs cleared
  - Cafe items: ${cafeChecked} checked, ${cafeCleared} stale IDs cleared
  - User subscriptions: ${subsChecked} checked, ${subsCleared} stale IDs cleared${transactionCacheCleared ? '\n  - Transaction cache: cleared' : ''}`);

    if (clearedSubscriptionTierCount > 0) {
      console.warn(`[STARTUP WARNING] ⚠️ ${clearedSubscriptionTierCount} subscription tiers lost their Stripe product links due to environment change. Run "Sync to Stripe" from Products & Pricing before member signups will work.`);
    }

    if (cafeCleared > 0) {
      console.warn(`[STARTUP WARNING] ⚠️ ${cafeCleared} cafe items lost their Stripe product links. Run "Sync to Stripe" to restore.`);
    }
  } catch (error: any) {
    console.error('[Stripe Env] Environment validation failed (non-blocking):', error.message);
  }
}
