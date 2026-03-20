import { logger } from '../core/logger';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { isAdmin, isStaffOrAdmin } from '../core/middleware';
import { invalidateTierCache } from '../core/tierService';
import { syncMembershipTiersToStripe, getTierSyncStatus, cleanupOrphanStripeProducts, syncTierFeaturesToStripe, syncCafeItemsToStripe, pullTierFeaturesFromStripe, pullCafeItemsFromStripe, archiveAllStalePrices } from '../core/stripe/products';
import { autoPushTierToStripe, autoPushFeeToStripe } from '../core/stripe/autoPush';
import { updateOverageRate, updateGuestFee } from '../core/billing/pricingConfig';
import { logFromRequest } from '../core/auditLog';
import { getErrorCode, safeErrorDetail, getErrorMessage } from '../utils/errorUtils';
import { getCached, setCache, invalidateCache as invalidateQueryCache } from '../core/queryCache';
import { broadcastCafeMenuUpdate } from '../core/websocket';
import { validateBody } from '../middleware/validate';

const tierBaseFields = {
  description: z.string().optional().nullable(),
  button_text: z.string().optional().nullable(),
  sort_order: z.number().int().optional().nullable(),
  is_active: z.boolean().optional(),
  is_popular: z.boolean().optional(),
  show_in_comparison: z.boolean().optional(),
  show_on_membership_page: z.boolean().optional(),
  highlighted_features: z.array(z.string()).optional().nullable(),
  all_features: z.record(z.string(), z.union([
    z.boolean(),
    z.object({
      label: z.string().optional(),
      value: z.union([z.string(), z.boolean()]).optional(),
      included: z.boolean().optional(),
    }),
  ])).optional().nullable(),
  daily_sim_minutes: z.number().int().optional().nullable(),
  guest_passes_per_year: z.number().int().optional().nullable(),
  booking_window_days: z.number().int().optional().nullable(),
  daily_conf_room_minutes: z.number().int().optional().nullable(),
  can_book_simulators: z.boolean().optional(),
  can_book_conference: z.boolean().optional(),
  can_book_wellness: z.boolean().optional(),
  has_group_lessons: z.boolean().optional(),
  has_extended_sessions: z.boolean().optional(),
  has_private_lesson: z.boolean().optional(),
  has_simulator_guest_passes: z.boolean().optional(),
  has_discounted_merch: z.boolean().optional(),
  unlimited_access: z.boolean().optional(),
  stripe_price_id: z.string().optional().nullable(),
  stripe_product_id: z.string().optional().nullable(),
  price_cents: z.number().int().optional().nullable(),
  wallet_pass_bg_color: z.string().optional().nullable(),
  wallet_pass_foreground_color: z.string().optional().nullable(),
  wallet_pass_label_color: z.string().optional().nullable(),
};

const createTierSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: z.string().min(1, 'Slug is required'),
  price_string: z.string().min(1, 'Price is required'),
  ...tierBaseFields,
});

const updateTierSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  price_string: z.string().min(1).optional(),
  ...tierBaseFields,
});

const TIERS_CACHE_KEY = 'membership_tiers';
const TIERS_CACHE_TTL = 120_000;

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
function sanitizePassColor(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value).trim();
  if (!HEX_COLOR_REGEX.test(str)) return null;
  return str;
}

const router = Router();

// PUBLIC ROUTE - membership tiers displayed on public website
router.get('/api/membership-tiers', async (req, res) => {
  try {
    const { active } = req.query;
    const cacheKey = active === 'true' ? `${TIERS_CACHE_KEY}_active` : `${TIERS_CACHE_KEY}_all`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cached = getCached<any[]>(cacheKey);
    if (cached) {
      res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
      return res.json(cached);
    }

    const result = active === 'true'
      ? await db.execute(sql`SELECT * FROM membership_tiers WHERE is_active = true ORDER BY sort_order ASC, id ASC`)
      : await db.execute(sql`SELECT * FROM membership_tiers ORDER BY sort_order ASC, id ASC`);

    setCache(cacheKey, result.rows, TIERS_CACHE_TTL);
    res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
    res.json(result.rows);
  } catch (error: unknown) {
    logger.error('Membership tiers fetch error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to fetch membership tiers' });
  }
});

// PUBLIC ROUTE - tier limits needed by booking UI
router.get('/api/membership-tiers/limits/:tierName', async (req, res) => {
  try {
    const { tierName } = req.params;
    const result = await db.execute(sql`SELECT 
        name, slug,
        daily_sim_minutes, guest_passes_per_year, booking_window_days,
        daily_conf_room_minutes, can_book_simulators, can_book_conference,
        can_book_wellness, has_group_lessons, has_extended_sessions,
        has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
        unlimited_access
      FROM membership_tiers 
      WHERE LOWER(name) = LOWER(${tierName}) OR LOWER(slug) = LOWER(${tierName})
      LIMIT 1`);
    
    if (result.rows.length === 0) {
      return res.json({
        name: 'Social',
        daily_sim_minutes: 0,
        guest_passes_per_year: 0,
        booking_window_days: 7,
        daily_conf_room_minutes: 0,
        can_book_simulators: false,
        can_book_conference: false,
        can_book_wellness: true,
        has_group_lessons: false,
        has_extended_sessions: false,
        has_private_lesson: false,
        has_simulator_guest_passes: false,
        has_discounted_merch: false,
        unlimited_access: false
      });
    }
    
    res.json(result.rows[0]);
  } catch (error: unknown) {
    logger.error('Membership tier limits fetch error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to fetch tier limits' });
  }
});

// PUBLIC ROUTE - individual tier details for public membership page
router.get('/api/membership-tiers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.execute(sql`SELECT id, name, slug, price_string, description, button_text, sort_order, is_active, is_popular, show_in_comparison, show_on_membership_page, highlighted_features, all_features, daily_sim_minutes, guest_passes_per_year, booking_window_days, daily_conf_room_minutes, can_book_simulators, can_book_conference, can_book_wellness, has_group_lessons, has_extended_sessions, has_private_lesson, has_simulator_guest_passes, has_discounted_merch, unlimited_access, guest_fee_cents, stripe_product_id, stripe_price_id, founding_price_id, price_cents, billing_interval, product_type, min_quantity, tier_type, wallet_pass_bg_color, wallet_pass_foreground_color, wallet_pass_label_color, created_at, updated_at FROM membership_tiers WHERE id = ${id}`);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tier not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error: unknown) {
    logger.error('Membership tier fetch error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to fetch membership tier' });
  }
});

router.put('/api/membership-tiers/:id', isAdmin, validateBody(updateTierSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, slug, price_string, description, button_text, sort_order,
      is_active, is_popular, show_in_comparison, show_on_membership_page, highlighted_features, all_features,
      daily_sim_minutes, guest_passes_per_year, booking_window_days,
      daily_conf_room_minutes, can_book_simulators, can_book_conference,
      can_book_wellness, has_group_lessons, has_extended_sessions,
      has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
      unlimited_access,
      stripe_price_id: _stripe_price_id, stripe_product_id: _stripe_product_id, price_cents,
      wallet_pass_bg_color, wallet_pass_foreground_color, wallet_pass_label_color
    } = req.body;

    void _stripe_price_id;
    void _stripe_product_id;
    
    const result = await db.execute(sql`
      UPDATE membership_tiers SET
        name = COALESCE(${name}, name),
        slug = COALESCE(${slug}, slug),
        price_string = COALESCE(${price_string}, price_string),
        description = COALESCE(${description}, description),
        button_text = COALESCE(${button_text}, button_text),
        sort_order = COALESCE(${sort_order}, sort_order),
        is_active = COALESCE(${is_active}, is_active),
        is_popular = COALESCE(${is_popular}, is_popular),
        show_in_comparison = COALESCE(${show_in_comparison}, show_in_comparison),
        highlighted_features = COALESCE(${highlighted_features ? JSON.stringify(highlighted_features) : null}, highlighted_features),
        all_features = COALESCE(${all_features ? JSON.stringify(all_features) : null}, all_features),
        daily_sim_minutes = COALESCE(${daily_sim_minutes}, daily_sim_minutes),
        guest_passes_per_year = COALESCE(${guest_passes_per_year}, guest_passes_per_year),
        booking_window_days = COALESCE(${booking_window_days}, booking_window_days),
        daily_conf_room_minutes = COALESCE(${daily_conf_room_minutes}, daily_conf_room_minutes),
        can_book_simulators = COALESCE(${can_book_simulators}, can_book_simulators),
        can_book_conference = COALESCE(${can_book_conference}, can_book_conference),
        can_book_wellness = COALESCE(${can_book_wellness}, can_book_wellness),
        has_group_lessons = COALESCE(${has_group_lessons}, has_group_lessons),
        has_extended_sessions = COALESCE(${has_extended_sessions}, has_extended_sessions),
        has_private_lesson = COALESCE(${has_private_lesson}, has_private_lesson),
        has_simulator_guest_passes = COALESCE(${has_simulator_guest_passes}, has_simulator_guest_passes),
        has_discounted_merch = COALESCE(${has_discounted_merch}, has_discounted_merch),
        unlimited_access = COALESCE(${unlimited_access}, unlimited_access),
        price_cents = COALESCE(${price_cents}, price_cents),
        show_on_membership_page = COALESCE(${show_on_membership_page}, show_on_membership_page),
        wallet_pass_bg_color = CASE WHEN ${wallet_pass_bg_color !== undefined} THEN ${sanitizePassColor(wallet_pass_bg_color)} ELSE wallet_pass_bg_color END,
        wallet_pass_foreground_color = CASE WHEN ${wallet_pass_foreground_color !== undefined} THEN ${sanitizePassColor(wallet_pass_foreground_color)} ELSE wallet_pass_foreground_color END,
        wallet_pass_label_color = CASE WHEN ${wallet_pass_label_color !== undefined} THEN ${sanitizePassColor(wallet_pass_label_color)} ELSE wallet_pass_label_color END,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tier not found' });
    }
    
    const updatedTier = result.rows[0];
    if (updatedTier.name) invalidateTierCache(String(updatedTier.name));
    if (updatedTier.slug) invalidateTierCache(String(updatedTier.slug));
    invalidateQueryCache(TIERS_CACHE_KEY);
    
    let synced = false;
    let syncError: string | undefined;
    try {
      const pushResult = await autoPushTierToStripe(updatedTier as Record<string, unknown> & { id: number; name: string; slug: string });
      synced = pushResult.success;
      if (!pushResult.success) {
        syncError = pushResult.error || 'Stripe sync failed';
        logger.error('[AutoPush] Tier push failed', { error: syncError });
      }
    } catch (err) {
      syncError = getErrorMessage(err);
      logger.error('[AutoPush] Tier push exception', { error: syncError });
    }

    res.json({ ...updatedTier, synced, syncError });
  } catch (error: unknown) {
    logger.error('Membership tier update error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to update membership tier' });
  }
});

router.post('/api/membership-tiers', isAdmin, validateBody(createTierSchema), async (req, res) => {
  try {
    const {
      name, slug, price_string, description, button_text, sort_order,
      is_active, is_popular, show_in_comparison, show_on_membership_page, highlighted_features, all_features,
      daily_sim_minutes, guest_passes_per_year, booking_window_days,
      daily_conf_room_minutes, can_book_simulators, can_book_conference,
      can_book_wellness, has_group_lessons, has_extended_sessions,
      has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
      unlimited_access,
      wallet_pass_bg_color, wallet_pass_foreground_color, wallet_pass_label_color
    } = req.body;
    
    const result = await db.execute(sql`
      INSERT INTO membership_tiers (
        name, slug, price_string, description, button_text, sort_order,
        is_active, is_popular, show_in_comparison, show_on_membership_page, highlighted_features, all_features,
        daily_sim_minutes, guest_passes_per_year, booking_window_days,
        daily_conf_room_minutes, can_book_simulators, can_book_conference,
        can_book_wellness, has_group_lessons, has_extended_sessions,
        has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
        unlimited_access,
        wallet_pass_bg_color, wallet_pass_foreground_color, wallet_pass_label_color
      ) VALUES (${name}, ${slug}, ${price_string}, ${description || null}, ${button_text || 'Apply Now'}, ${sort_order || 0},
        ${is_active ?? true}, ${is_popular ?? false}, ${show_in_comparison ?? true}, ${show_on_membership_page ?? true},
        ${JSON.stringify(highlighted_features || [])},
        ${JSON.stringify(all_features || {})},
        ${daily_sim_minutes || 0}, ${guest_passes_per_year || 0}, ${booking_window_days || 7},
        ${daily_conf_room_minutes || 0}, ${can_book_simulators ?? false}, ${can_book_conference ?? false},
        ${can_book_wellness ?? true}, ${has_group_lessons ?? false}, ${has_extended_sessions ?? false},
        ${has_private_lesson ?? false}, ${has_simulator_guest_passes ?? false}, ${has_discounted_merch ?? false},
        ${unlimited_access ?? false},
        ${sanitizePassColor(wallet_pass_bg_color)}, ${sanitizePassColor(wallet_pass_foreground_color)}, ${sanitizePassColor(wallet_pass_label_color)})
      RETURNING *
    `);
    
    const newTier = result.rows[0];
    if (newTier.name) invalidateTierCache(String(newTier.name));
    if (newTier.slug) invalidateTierCache(String(newTier.slug));
    invalidateQueryCache(TIERS_CACHE_KEY);
    
    let synced = false;
    let syncError: string | undefined;
    try {
      const pushResult = await autoPushTierToStripe(newTier as Record<string, unknown> & { id: number; name: string; slug: string });
      synced = pushResult.success;
      if (!pushResult.success) {
        syncError = pushResult.error || 'Stripe sync failed';
        logger.error('[AutoPush] Tier push failed', { error: syncError });
      }
    } catch (err) {
      syncError = getErrorMessage(err);
      logger.error('[AutoPush] Tier push exception', { error: syncError });
    }

    res.status(201).json({ ...result.rows[0], synced, syncError });
  } catch (error: unknown) {
    logger.error('Membership tier create error', { error: getErrorMessage(error) });
    if (getErrorCode(error) === '23505') {
      res.status(400).json({ error: 'A tier with this name or slug already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create membership tier' });
    }
  }
});

// Admin endpoint to sync all membership tiers to Stripe (two-way sync)
router.post('/api/admin/stripe/sync-products', isStaffOrAdmin, async (req, res) => {
  try {
    logger.info('[Admin] Starting Stripe product sync...');
    
    // Step 1: Push app products to Stripe
    const syncResult = await syncMembershipTiersToStripe();
    logger.info('[Admin] Stripe sync complete: synced, failed, skipped', { extra: { syncResultSynced: syncResult.synced, syncResultFailed: syncResult.failed, syncResultSkipped: syncResult.skipped } });
    
    // Step 2: Archive orphan Stripe products not in the app
    const cleanupResult = await cleanupOrphanStripeProducts();
    logger.info('[Admin] Stripe cleanup complete: archived, skipped', { extra: { cleanupResultArchived: cleanupResult.archived, cleanupResultSkipped: cleanupResult.skipped } });
    
    // Step 3: Sync tier features to Stripe entitlements
    const featureResult = await syncTierFeaturesToStripe();
    logger.info('[Admin] Feature sync complete: created, attached, removed', { extra: { featureResultFeaturesCreated: featureResult.featuresCreated, featureResultFeaturesAttached: featureResult.featuresAttached, featureResultFeaturesRemoved: featureResult.featuresRemoved } });
    
    // Step 4: Sync cafe items to Stripe
    const cafeResult = await syncCafeItemsToStripe();
    logger.info('[Admin] Cafe sync complete: synced, failed, skipped', { extra: { cafeResultSynced: cafeResult.synced, cafeResultFailed: cafeResult.failed, cafeResultSkipped: cafeResult.skipped } });

    // Step 5: Archive stale prices (duplicates) across all products
    const stalePriceResult = await archiveAllStalePrices();
    logger.info('[Admin] Stale price cleanup complete: archived, errors', { extra: { stalePricesArchived: stalePriceResult.totalArchived, stalePriceErrors: stalePriceResult.totalErrors } });
    
    invalidateQueryCache(TIERS_CACHE_KEY);

    res.json({ 
      success: syncResult.success && cleanupResult.success && featureResult.success && cafeResult.success, 
      synced: syncResult.synced,
      failed: syncResult.failed,
      skipped: syncResult.skipped,
      archived: cleanupResult.archived,
      cleanupSkipped: cleanupResult.skipped,
      cleanupErrors: cleanupResult.errors,
      details: syncResult.results,
      cleanupDetails: cleanupResult.results,
      featureSync: featureResult,
      cafeSync: cafeResult,
      stalePriceCleanup: stalePriceResult,
    });
  } catch (error: unknown) {
    logger.error('[Admin] Stripe sync error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to sync products to Stripe', details: safeErrorDetail(error) });
  }
});

// Get sync status for all tiers
router.get('/api/admin/stripe/sync-status', isStaffOrAdmin, async (req, res) => {
  try {
    const status = await getTierSyncStatus();
    res.json({ tiers: status });
  } catch (error: unknown) {
    logger.error('[Admin] Error getting sync status', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

const feeUpdateSchema = z.object({
  price_cents: z.number().int().min(0, 'Price must be non-negative'),
});

router.put('/api/admin/pricing/guest-fee', isAdmin, validateBody(feeUpdateSchema), async (req, res) => {
  try {
    const { price_cents } = req.body;

    const pushResult = await autoPushFeeToStripe('guest-pass', price_cents);
    if (pushResult.success) {
      updateGuestFee(price_cents);
      logFromRequest(req, {
        action: 'update_guest_fee',
        resourceType: 'pricing',
        resourceName: 'Guest Fee',
        details: { price_cents },
      });
    } else {
      logger.warn('[Admin] Guest fee Stripe push failed — in-memory value NOT updated', { extra: { error: pushResult.error } });
    }

    res.json({ success: true, price_cents, stripe_synced: pushResult.success });
  } catch (error: unknown) {
    logger.error('[Admin] Error updating guest fee', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to update guest fee' });
  }
});

router.put('/api/admin/pricing/overage-rate', isAdmin, validateBody(feeUpdateSchema), async (req, res) => {
  try {
    const { price_cents } = req.body;

    const pushResult = await autoPushFeeToStripe('simulator-overage-30min', price_cents);
    if (pushResult.success) {
      updateOverageRate(price_cents);
      logFromRequest(req, {
        action: 'update_overage_rate',
        resourceType: 'pricing',
        resourceName: 'Overage Rate',
        details: { price_cents },
      });
    } else {
      logger.warn('[Admin] Overage rate Stripe push failed — in-memory value NOT updated', { extra: { error: pushResult.error } });
    }

    res.json({ success: true, price_cents, stripe_synced: pushResult.success });
  } catch (error: unknown) {
    logger.error('[Admin] Error updating overage rate', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to update overage rate' });
  }
});

router.post('/api/admin/stripe/pull-from-stripe', isStaffOrAdmin, async (req, res) => {
  try {
    logger.info('[Admin] Starting pull from Stripe...');

    const [tierResult, cafeResult] = await Promise.all([
      pullTierFeaturesFromStripe(),
      pullCafeItemsFromStripe(),
    ]);

    logger.info('[Admin] Pull from Stripe complete: tiers updated, cafe items synced, created, deactivated', { extra: { tierResultTiersUpdated: tierResult.tiersUpdated, cafeResultSynced: cafeResult.synced, cafeResultCreated: cafeResult.created, cafeResultDeactivated: cafeResult.deactivated } });

    logFromRequest(req, {
      action: 'pull_from_stripe',
      resourceType: 'system',
      resourceName: 'Stripe Reverse Sync',
      details: {
        tiersUpdated: tierResult.tiersUpdated,
        tierErrors: tierResult.errors,
        cafeSynced: cafeResult.synced,
        cafeCreated: cafeResult.created,
        cafeDeactivated: cafeResult.deactivated,
        cafeErrors: cafeResult.errors,
      },
    });

    invalidateQueryCache(TIERS_CACHE_KEY);
    invalidateQueryCache('cafe_menu');
    if (cafeResult.synced > 0 || cafeResult.created > 0 || cafeResult.deactivated > 0) {
      broadcastCafeMenuUpdate('updated');
    }

    res.json({
      success: tierResult.success && cafeResult.success,
      tiers: tierResult,
      cafe: cafeResult,
    });
  } catch (error: unknown) {
    logger.error('[Admin] Pull from Stripe error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to pull from Stripe', details: safeErrorDetail(error) });
  }
});

export default router;
