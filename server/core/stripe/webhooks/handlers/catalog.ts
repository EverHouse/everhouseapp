import Stripe from 'stripe';
import { pullTierFeaturesFromStripe } from '../../products';
import { clearTierCache } from '../../../tierService';
import { updateOverageRate, updateGuestFee } from '../../../billing/pricingConfig';
import { logger } from '../../../logger';
import { getErrorMessage } from '../../../../utils/errorUtils';
import type { PoolClient } from 'pg';
import type { DeferredAction, StripeProductWithMarketingFeatures } from '../types';

export async function handleProductUpdated(client: PoolClient, product: StripeProductWithMarketingFeatures): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    logger.info(`[Stripe Webhook] Product updated: ${product.id} (${product.name})`);

    const tierMatch = await client.query(
      'SELECT id, name FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [product.id]
    );

    if (tierMatch.rows.length > 0) {
      const tierId = tierMatch.rows[0].id;
      const tierName = tierMatch.rows[0].name;
      logger.info(`[Stripe Webhook] Product ${product.id} matches tier "${tierName}", deferring feature pull`);

      if (Array.isArray(product.marketing_features) && product.marketing_features.length > 0) {
        const featureNames = product.marketing_features
          .map((f: { name: string }) => f.name)
          .filter((n: string) => n && n.trim());
        if (featureNames.length > 0) {
          await client.query(
            'UPDATE membership_tiers SET highlighted_features = $1, updated_at = NOW() WHERE id = $2',
            [JSON.stringify(featureNames), tierId]
          );
          logger.info(`[Stripe Webhook] Updated highlighted features for "${tierName}" from ${featureNames.length} marketing features`);
        } else {
          logger.info(`[Stripe Webhook] Skipping highlighted_features update for "${tierName}" — marketing_features present but all empty names`);
        }
      } else {
        logger.info(`[Stripe Webhook] Skipping highlighted_features update for "${tierName}" — no marketing_features in webhook payload`);
      }

      deferredActions.push(async () => {
        await pullTierFeaturesFromStripe();
      });
      return deferredActions;
    }

    if (product.metadata?.config_type === 'corporate_volume_pricing') {
      const { pullCorporateVolumePricingFromStripe } = await import('../../products');
      deferredActions.push(async () => {
        await pullCorporateVolumePricingFromStripe();
      });
    }

    if (product.metadata?.cafe_item_id) {
      const cafeItemId = parseInt(product.metadata.cafe_item_id, 10) || -1;
      const imageUrl = product.images?.[0] || null;
      const category = product.metadata?.category || undefined;

      await client.query(
        `UPDATE cafe_items SET
          name = $1, description = $2,
          image_url = COALESCE($3, image_url),
          category = COALESCE($4, category)
        WHERE stripe_product_id = $5 OR id = $6`,
        [product.name, product.description || null, imageUrl, category, product.id, cafeItemId]
      );
      logger.info(`[Stripe Webhook] Updated cafe item from product ${product.id}`);
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.updated:', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
  }

  return deferredActions;
}

export async function handleProductCreated(client: PoolClient, product: Stripe.Product): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    logger.info(`[Stripe Webhook] Product created: ${product.id} (${product.name})`);

    if (product.metadata?.source === 'ever_house_app') {
      logger.info(`[Stripe Webhook] Skipping app-created product ${product.id}`);
      return deferredActions;
    }

    const tierMatch = await client.query(
      'SELECT id, name FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [product.id]
    );

    if (tierMatch.rows.length > 0) {
      logger.info(`[Stripe Webhook] New product ${product.id} matches tier "${tierMatch.rows[0].name}", deferring feature pull`);
      deferredActions.push(async () => {
        await pullTierFeaturesFromStripe();
      });
    } else {
      logger.info(`[Stripe Webhook] New product ${product.id} created in Stripe. Use "Pull from Stripe" button to import if needed.`);
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.created:', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
  }

  return deferredActions;
}

export async function handleProductDeleted(client: PoolClient, product: Stripe.Product): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    logger.info(`[Stripe Webhook] Product deleted: ${product.id} (${product.name})`);

    const tierMatch = await client.query(
      'SELECT id, name FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [product.id]
    );

    if (tierMatch.rows.length > 0) {
      logger.warn(`[Stripe Webhook] WARNING: Tier product deleted in Stripe for tier "${tierMatch.rows[0].name}" (${product.id}). Tier data preserved in app.`);
      await client.query(
        'UPDATE membership_tiers SET stripe_product_id = NULL, stripe_price_id = NULL WHERE id = $1',
        [tierMatch.rows[0].id]
      );
      logger.info(`[Stripe Webhook] Cleared Stripe references for tier "${tierMatch.rows[0].name}" after product deletion`);
      clearTierCache();
      return deferredActions;
    }

    const cafeResult = await client.query(
      'UPDATE cafe_items SET is_active = false WHERE stripe_product_id = $1 AND is_active = true RETURNING id, name',
      [product.id]
    );

    if (cafeResult.rowCount && cafeResult.rowCount > 0) {
      for (const row of cafeResult.rows) {
        logger.info(`[Stripe Webhook] Deactivated cafe item "${row.name}" (id: ${row.id}) due to Stripe product deletion`);
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.deleted:', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
  }

  return deferredActions;
}

export async function handlePriceChange(client: PoolClient, price: Stripe.Price): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const productId = typeof price.product === 'string' ? price.product : price.product?.id;
    if (!productId) return deferredActions;

    logger.info(`[Stripe Webhook] Price changed: ${price.id} for product ${productId}`);

    const priceCents = price.unit_amount || 0;
    const priceDecimal = (priceCents / 100).toFixed(2);

    const result = await client.query(
      `UPDATE cafe_items SET price = $1, stripe_price_id = $2
       WHERE stripe_product_id = $3
       RETURNING id, name`,
      [priceDecimal, price.id, productId]
    );

    if (result.rowCount && result.rowCount > 0) {
      for (const row of result.rows) {
        logger.info(`[Stripe Webhook] Updated price for cafe item "${row.name}" to $${priceDecimal}`);
      }
    }

    const tierResult = await client.query(
      `UPDATE membership_tiers SET price_cents = $1, stripe_price_id = $2
       WHERE stripe_product_id = $3
       RETURNING id, name`,
      [priceCents, price.id, productId]
    );

    if (tierResult.rowCount && tierResult.rowCount > 0) {
      for (const row of tierResult.rows) {
        logger.info(`[Stripe Webhook] Updated tier "${row.name}" price to ${priceCents} cents ($${priceDecimal})`);
      }
      clearTierCache();

      const slugResult = await client.query(
        `SELECT slug FROM membership_tiers WHERE stripe_product_id = $1`, [productId]
      );
      const slug = slugResult.rows[0]?.slug;
      if (slug === 'simulator-overage-30min') {
        updateOverageRate(priceCents);
      } else if (slug === 'guest-pass') {
        updateGuestFee(priceCents);
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling price change:', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
  }

  return deferredActions;
}
