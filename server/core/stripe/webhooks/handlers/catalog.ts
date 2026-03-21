import Stripe from 'stripe';
import { invalidateTierRegistry } from '../../../tierRegistry';
import { updateOverageRate, updateGuestFee } from '../../../billing/pricingConfig';
import { logger } from '../../../logger';
import { getErrorMessage } from '../../../../utils/errorUtils';
import { isAppOriginated } from '../../appOriginTracker';
import type { PoolClient } from 'pg';
import type { DeferredAction, StripeProductWithMarketingFeatures } from '../types';

export async function handleProductUpdated(client: PoolClient, product: StripeProductWithMarketingFeatures): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    if (isAppOriginated(product.id)) {
      logger.info(`[Stripe Webhook] Skipping app-originated product.updated for ${product.id} (${product.name})`);
      return deferredActions;
    }

    logger.info(`[Stripe Webhook] Product updated externally in Stripe: ${product.id} (${product.name})`);

    const tierMatch = await client.query(
      'SELECT id, name FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [product.id]
    );

    if (tierMatch.rows.length > 0) {
      const tierName = tierMatch.rows[0].name;
      logger.warn(`[Stripe Webhook] Ignoring external Stripe changes to tier "${tierName}" (product ${product.id}) — the app is the source of truth. Edit tiers in the admin panel, changes will sync to Stripe automatically.`);
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
      logger.warn(`[Stripe Webhook] Ignoring external Stripe changes to cafe item (id: ${cafeItemId}, product ${product.id}) — the app is the source of truth. Edit menu items in the admin panel.`);
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.updated:', { error: getErrorMessage(error) });
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
      logger.info(`[Stripe Webhook] Product ${product.id} already linked to tier "${tierMatch.rows[0].name}"`);
      return deferredActions;
    }

    const meta = product.metadata || {};
    if (meta.tier_id) {
      const tierId = parseInt(meta.tier_id, 10);
      if (!isNaN(tierId)) {
        const unlinkedTier = await client.query(
          'SELECT id, name FROM membership_tiers WHERE id = $1 AND stripe_product_id IS NULL LIMIT 1',
          [tierId]
        );
        if (unlinkedTier.rows.length > 0) {
          await client.query(
            'UPDATE membership_tiers SET stripe_product_id = $1, updated_at = NOW() WHERE id = $2',
            [product.id, tierId]
          );
          logger.info(`[Stripe Webhook] Linked new Stripe product ${product.id} to tier "${unlinkedTier.rows[0].name}" via tier_id metadata`);
          deferredActions.push(async () => {
            await invalidateTierRegistry();
          });
          return deferredActions;
        }
      }
    }

    if (meta.cafe_item_id) {
      const cafeId = parseInt(meta.cafe_item_id, 10);
      if (!isNaN(cafeId)) {
        const unlinkedCafe = await client.query(
          'SELECT id, name FROM cafe_items WHERE id = $1 AND stripe_product_id IS NULL LIMIT 1',
          [cafeId]
        );
        if (unlinkedCafe.rows.length > 0) {
          await client.query(
            'UPDATE cafe_items SET stripe_product_id = $1 WHERE id = $2',
            [product.id, cafeId]
          );
          logger.info(`[Stripe Webhook] Linked new Stripe product ${product.id} to cafe item "${unlinkedCafe.rows[0].name}" via cafe_item_id metadata`);
          return deferredActions;
        }
      }
    }

    logger.info(`[Stripe Webhook] New product ${product.id} created in Stripe — no matching local record found. Use "Sync to Stripe" in the admin panel to push app data.`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.created:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handleProductDeleted(client: PoolClient, product: Stripe.Product): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    if (isAppOriginated(product.id)) {
      logger.info(`[Stripe Webhook] Skipping app-originated product.deleted for ${product.id} (${product.name})`);
      return deferredActions;
    }

    logger.info(`[Stripe Webhook] Product deleted in Stripe: ${product.id} (${product.name})`);

    const tierMatch = await client.query(
      'SELECT id, name, product_type FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [product.id]
    );

    if (tierMatch.rows.length > 0) {
      const tier = tierMatch.rows[0];

      await client.query(
        'UPDATE membership_tiers SET stripe_product_id = NULL, stripe_price_id = NULL, updated_at = NOW() WHERE id = $1',
        [tier.id]
      );

      logger.warn(`[Stripe Webhook] Stripe product ${product.id} was deleted — cleared Stripe IDs for tier "${tier.name}". The tier remains active in the app. Use "Sync to Stripe" to recreate the product.`);

      deferredActions.push(async () => {
        await invalidateTierRegistry();
      });
      return deferredActions;
    }

    const cafeResult = await client.query(
      'UPDATE cafe_items SET stripe_product_id = NULL, stripe_price_id = NULL WHERE stripe_product_id = $1 RETURNING id, name',
      [product.id]
    );

    if (cafeResult.rowCount && cafeResult.rowCount > 0) {
      for (const row of cafeResult.rows) {
        logger.warn(`[Stripe Webhook] Stripe product ${product.id} was deleted — cleared Stripe IDs for cafe item "${row.name}". The item remains in the app. Use "Sync to Stripe" to recreate.`);
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.deleted:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handlePriceDeleted(client: PoolClient, price: Stripe.Price): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    if (isAppOriginated(price.id)) {
      logger.info(`[Stripe Webhook] Skipping app-originated price.deleted for ${price.id}`);
      return deferredActions;
    }

    const productId = typeof price.product === 'string' ? price.product : price.product?.id;
    logger.info(`[Stripe Webhook] Price deleted: ${price.id} for product ${productId || 'unknown'}`);

    const tierResult = await client.query(
      'UPDATE membership_tiers SET stripe_price_id = NULL, updated_at = NOW() WHERE stripe_price_id = $1 RETURNING id, name, slug',
      [price.id]
    );

    if (tierResult.rowCount && tierResult.rowCount > 0) {
      for (const row of tierResult.rows) {
        logger.warn(`[Stripe Webhook] Cleared stripe_price_id for tier "${row.name}" — price ${price.id} was deleted in Stripe. Use "Sync to Stripe" to recreate.`);
      }
      deferredActions.push(async () => {
        await invalidateTierRegistry();
      });
    }

    const cafeResult = await client.query(
      'UPDATE cafe_items SET stripe_price_id = NULL WHERE stripe_price_id = $1 RETURNING id, name',
      [price.id]
    );

    if (cafeResult.rowCount && cafeResult.rowCount > 0) {
      for (const row of cafeResult.rows) {
        logger.warn(`[Stripe Webhook] Cleared stripe_price_id for cafe item "${row.name}" — price ${price.id} was deleted in Stripe. Use "Sync to Stripe" to recreate.`);
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling price.deleted:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handlePriceChange(client: PoolClient, price: Stripe.Price): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    if (isAppOriginated(price.id)) {
      logger.info(`[Stripe Webhook] Skipping app-originated price change for ${price.id}`);
      return deferredActions;
    }

    const productId = typeof price.product === 'string' ? price.product : price.product?.id;
    if (!productId) return deferredActions;

    if (!price.active) {
      logger.info(`[Stripe Webhook] Ignoring inactive price ${price.id} for product ${productId}`);
      return deferredActions;
    }

    const priceCents = price.unit_amount || 0;
    const priceDecimal = (priceCents / 100).toFixed(2);

    logger.info(`[Stripe Webhook] Price changed externally in Stripe: ${price.id} for product ${productId} ($${priceDecimal})`);

    const tierResult = await client.query(
      'SELECT id, name, slug, price_cents FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [productId]
    );

    if (tierResult.rows.length > 0) {
      const tier = tierResult.rows[0];

      if (tier.slug === 'simulator-overage-30min') {
        await client.query(
          'UPDATE membership_tiers SET stripe_price_id = $1, price_cents = $2, price_string = $3, updated_at = NOW() WHERE id = $4',
          [price.id, priceCents, `$${priceDecimal}`, tier.id]
        );
        updateOverageRate(priceCents);
        logger.info(`[Stripe Webhook] Updated overage rate from Stripe price change: $${priceDecimal}`);
        deferredActions.push(async () => {
          await invalidateTierRegistry();
        });
      } else if (tier.slug === 'guest-pass') {
        await client.query(
          'UPDATE membership_tiers SET stripe_price_id = $1, price_cents = $2, price_string = $3, updated_at = NOW() WHERE id = $4',
          [price.id, priceCents, `$${priceDecimal}`, tier.id]
        );
        updateGuestFee(priceCents);
        logger.info(`[Stripe Webhook] Updated guest fee from Stripe price change: $${priceDecimal}`);
        deferredActions.push(async () => {
          await invalidateTierRegistry();
        });
      } else {
        logger.warn(`[Stripe Webhook] Ignoring external price change for tier "${tier.name}" (${price.id}, $${priceDecimal}) — the app is the source of truth. Edit pricing in the admin panel, changes will sync to Stripe automatically.`);
      }

      return deferredActions;
    }

    const cafeResult = await client.query(
      'SELECT id, name FROM cafe_items WHERE stripe_product_id = $1 LIMIT 1',
      [productId]
    );

    if (cafeResult.rows.length > 0) {
      const item = cafeResult.rows[0];
      logger.warn(`[Stripe Webhook] Ignoring external price change for cafe item "${item.name}" (${price.id}, $${priceDecimal}) — the app is the source of truth. Edit pricing in the admin panel.`);
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling price change:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}
