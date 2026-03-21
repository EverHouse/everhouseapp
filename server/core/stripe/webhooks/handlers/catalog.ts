import Stripe from 'stripe';
import { pullTierFeaturesFromStripe } from '../../products';
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
          { metaKey: 'privilege_guest_fee_cents', dbCol: 'guest_fee_cents', type: 'int' },
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
              tierUpdateValues.push(pf.type === 'bool' ? false : (pf.dbCol === 'booking_window_days' ? 7 : pf.dbCol === 'guest_fee_cents' ? 2500 : 0));
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
        await invalidateTierRegistry();
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
            await pullTierFeaturesFromStripe();
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

    logger.info(`[Stripe Webhook] New product ${product.id} created in Stripe — no matching local record found. Use "Pull from Stripe" to import if needed.`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.created:', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
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

    logger.info(`[Stripe Webhook] Product deleted: ${product.id} (${product.name})`);

    const tierMatch = await client.query(
      'SELECT id, name, product_type FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [product.id]
    );

    if (tierMatch.rows.length > 0) {
      const tier = tierMatch.rows[0];
      const isSubscription = !tier.product_type || tier.product_type === 'subscription';

      await client.query(
        'UPDATE membership_tiers SET stripe_product_id = NULL, stripe_price_id = NULL, is_active = false, updated_at = NOW() WHERE id = $1',
        [tier.id]
      );

      if (isSubscription) {
        logger.warn(`[Stripe Webhook] Subscription tier "${tier.name}" deactivated — Stripe product ${product.id} was deleted. Re-activate in the app to recreate the Stripe product.`);
      } else {
        logger.warn(`[Stripe Webhook] Fee/pass "${tier.name}" deactivated — Stripe product ${product.id} was deleted.`);
      }

      deferredActions.push(async () => {
        await invalidateTierRegistry();
      });
      return deferredActions;
    }

    const cafeResult = await client.query(
      'DELETE FROM cafe_items WHERE stripe_product_id = $1 RETURNING id, name',
      [product.id]
    );

    if (cafeResult.rowCount && cafeResult.rowCount > 0) {
      for (const row of cafeResult.rows) {
        logger.info(`[Stripe Webhook] Permanently deleted cafe item "${row.name}" (id: ${row.id}) — Stripe product ${product.id} was deleted`);
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.deleted:', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
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
        logger.warn(`[Stripe Webhook] Cleared stripe_price_id for tier "${row.name}" — price ${price.id} was deleted in Stripe`);
        if (row.slug === 'simulator-overage-30min' || row.slug === 'guest-pass') {
          logger.warn(`[Stripe Webhook] Fee product "${row.name}" lost its price — re-save fees or run "Sync to Stripe" to recreate`);
        }
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
        logger.warn(`[Stripe Webhook] Cleared stripe_price_id for cafe item "${row.name}" — price ${price.id} was deleted in Stripe`);
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling price.deleted:', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
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
      logger.info(`[Stripe Webhook] Ignoring inactive price ${price.id} for product ${productId} — only active prices update the app`);
      return deferredActions;
    }

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
      deferredActions.push(async () => {
        await invalidateTierRegistry();
      });
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling price change:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}
