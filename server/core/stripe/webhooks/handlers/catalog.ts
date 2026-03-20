import Stripe from 'stripe';
import { pullTierFeaturesFromStripe } from '../../products';
import { clearTierCache } from '../../../tierService';
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

    logger.info(`[Stripe Webhook] Product updated: ${product.id} (${product.name})`);

    const tierMatch = await client.query(
      'SELECT id, name FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [product.id]
    );

    if (tierMatch.rows.length > 0) {
      const tierId = tierMatch.rows[0].id;
      const tierName = tierMatch.rows[0].name;
      logger.info(`[Stripe Webhook] Product ${product.id} matches tier "${tierName}", deferring feature pull`);

      const tierUpdateParts: string[] = ['updated_at = NOW()'];
      const tierUpdateValues: unknown[] = [];
      let paramIdx = 1;

      if (product.name) {
        const displayName = product.name.replace(/ Membership$/, '');
        if (displayName !== tierName) {
          tierUpdateParts.push(`name = $${paramIdx++}`);
          tierUpdateValues.push(displayName);
        }
      }
      if (product.description !== undefined) {
        tierUpdateParts.push(`description = $${paramIdx++}`);
        tierUpdateValues.push(product.description || null);
      }

      if (Array.isArray(product.marketing_features) && product.marketing_features.length > 0) {
        const featureNames = product.marketing_features
          .map((f: { name: string }) => f.name)
          .filter((n: string) => n && n.trim());
        if (featureNames.length > 0) {
          tierUpdateParts.push(`highlighted_features = $${paramIdx++}`);
          tierUpdateValues.push(JSON.stringify(featureNames));
          logger.info(`[Stripe Webhook] Updated highlighted features for "${tierName}" from ${featureNames.length} marketing features`);
        }
      }

      const meta = product.metadata || {};
      const isSubscriptionProduct = meta.product_type === 'subscription' || (!meta.product_type && !['one_time', 'fee', 'config'].includes(meta.product_type || ''));

      if (isSubscriptionProduct) {
        const privilegeFields: Array<{ metaKey: string; dbCol: string; type: 'int' | 'bool' }> = [
          { metaKey: 'privilege_daily_sim_minutes', dbCol: 'daily_sim_minutes', type: 'int' },
          { metaKey: 'privilege_guest_passes', dbCol: 'guest_passes_per_year', type: 'int' },
          { metaKey: 'privilege_booking_window_days', dbCol: 'booking_window_days', type: 'int' },
          { metaKey: 'privilege_conf_room_minutes', dbCol: 'daily_conf_room_minutes', type: 'int' },
          { metaKey: 'privilege_unlimited_access', dbCol: 'unlimited_access', type: 'bool' },
          { metaKey: 'privilege_can_book_simulators', dbCol: 'can_book_simulators', type: 'bool' },
          { metaKey: 'privilege_can_book_conference', dbCol: 'can_book_conference', type: 'bool' },
          { metaKey: 'privilege_can_book_wellness', dbCol: 'can_book_wellness', type: 'bool' },
          { metaKey: 'privilege_group_lessons', dbCol: 'has_group_lessons', type: 'bool' },
          { metaKey: 'privilege_private_lesson', dbCol: 'has_private_lesson', type: 'bool' },
          { metaKey: 'privilege_sim_guest_passes', dbCol: 'has_simulator_guest_passes', type: 'bool' },
          { metaKey: 'privilege_discounted_merch', dbCol: 'has_discounted_merch', type: 'bool' },
        ];

        let hasPrivilegeMetadata = false;
        for (const pf of privilegeFields) {
          if (meta[pf.metaKey] !== undefined) {
            hasPrivilegeMetadata = true;
            break;
          }
        }

        if (hasPrivilegeMetadata) {
          for (const pf of privilegeFields) {
            if (meta[pf.metaKey] !== undefined) {
              if (pf.type === 'bool') {
                tierUpdateParts.push(`${pf.dbCol} = $${paramIdx++}`);
                tierUpdateValues.push(meta[pf.metaKey] === 'true');
              } else {
                const numVal = parseInt(meta[pf.metaKey], 10);
                if (!isNaN(numVal)) {
                  tierUpdateParts.push(`${pf.dbCol} = $${paramIdx++}`);
                  tierUpdateValues.push(numVal);
                }
              }
            } else {
              tierUpdateParts.push(`${pf.dbCol} = $${paramIdx++}`);
              tierUpdateValues.push(pf.type === 'bool' ? false : (pf.dbCol === 'booking_window_days' ? 7 : 0));
            }
          }
          logger.info(`[Stripe Webhook] Syncing privilege metadata for tier "${tierName}" from Stripe product (missing keys reset to defaults)`);
        }
      }

      if (tierUpdateValues.length > 0) {
        tierUpdateValues.push(tierId);
        await client.query(
          `UPDATE membership_tiers SET ${tierUpdateParts.join(', ')} WHERE id = $${paramIdx}`,
          tierUpdateValues
        );
        logger.info(`[Stripe Webhook] Updated tier "${tierName}" fields from Stripe product`);
      }

      deferredActions.push(async () => {
        await pullTierFeaturesFromStripe();
      });
      clearTierCache();
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
    if (isAppOriginated(price.id)) {
      logger.info(`[Stripe Webhook] Skipping app-originated price change for ${price.id}`);
      return deferredActions;
    }

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
      `UPDATE membership_tiers SET price_cents = $1, stripe_price_id = $2, price_string = $3, updated_at = NOW()
       WHERE stripe_product_id = $4
       RETURNING id, name, slug`,
      [priceCents, price.id, `$${priceDecimal}`, productId]
    );

    if (tierResult.rowCount && tierResult.rowCount > 0) {
      for (const row of tierResult.rows) {
        logger.info(`[Stripe Webhook] Updated tier "${row.name}" price to ${priceCents} cents ($${priceDecimal})`);
        if (row.slug === 'simulator-overage-30min') {
          updateOverageRate(priceCents);
        } else if (row.slug === 'guest-pass') {
          updateGuestFee(priceCents);
        }
      }
      clearTierCache();
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling price change:', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
  }

  return deferredActions;
}
