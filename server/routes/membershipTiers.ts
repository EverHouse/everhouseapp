import { logger } from '../core/logger';
import { Router } from 'express';
import { isProduction } from '../core/db';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { isAdmin, isStaffOrAdmin } from '../core/middleware';
import { invalidateTierCache, clearTierCache } from '../core/tierService';
import { syncMembershipTiersToStripe, getTierSyncStatus, cleanupOrphanStripeProducts, syncTierFeaturesToStripe, syncCafeItemsToStripe, pullTierFeaturesFromStripe, pullCafeItemsFromStripe } from '../core/stripe/products';
import { logFromRequest } from '../core/auditLog';
import { getErrorMessage, getErrorCode, safeErrorDetail } from '../utils/errorUtils';
import { getCached, setCache, invalidateCache as invalidateQueryCache } from '../core/queryCache';

const TIERS_CACHE_KEY = 'membership_tiers';
const TIERS_CACHE_TTL = 120_000;

const router = Router();

router.get('/api/membership-tiers', async (req, res) => {
  try {
    const { active } = req.query;
    const cacheKey = active === 'true' ? `${TIERS_CACHE_KEY}_active` : `${TIERS_CACHE_KEY}_all`;

    const cached = getCached<any[]>(cacheKey);
    if (cached) return res.json(cached);

    const result = active === 'true'
      ? await db.execute(sql`SELECT * FROM membership_tiers WHERE is_active = true ORDER BY sort_order ASC, id ASC`)
      : await db.execute(sql`SELECT * FROM membership_tiers ORDER BY sort_order ASC, id ASC`);

    setCache(cacheKey, result.rows, TIERS_CACHE_TTL);
    res.json(result.rows);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Membership tiers fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch membership tiers' });
  }
});

router.get('/api/membership-tiers/limits/:tierName', async (req, res) => {
  try {
    const { tierName } = req.params;
    const result = await db.execute(sql`SELECT 
        name, slug,
        daily_sim_minutes, guest_passes_per_month, booking_window_days,
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
        guest_passes_per_month: 0,
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
    if (!isProduction) logger.error('Membership tier limits fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch tier limits' });
  }
});

router.get('/api/membership-tiers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.execute(sql`SELECT * FROM membership_tiers WHERE id = ${id}`);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tier not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Membership tier fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch membership tier' });
  }
});

router.put('/api/membership-tiers/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, slug, price_string, description, button_text, sort_order,
      is_active, is_popular, show_in_comparison, show_on_membership_page, highlighted_features, all_features,
      daily_sim_minutes, guest_passes_per_month, booking_window_days,
      daily_conf_room_minutes, can_book_simulators, can_book_conference,
      can_book_wellness, has_group_lessons, has_extended_sessions,
      has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
      unlimited_access,
      stripe_price_id, stripe_product_id, price_cents
    } = req.body;
    
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
        guest_passes_per_month = COALESCE(${guest_passes_per_month}, guest_passes_per_month),
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
        stripe_price_id = ${stripe_price_id || null},
        stripe_product_id = ${stripe_product_id || null},
        price_cents = ${price_cents || null},
        show_on_membership_page = COALESCE(${show_on_membership_page}, show_on_membership_page),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tier not found' });
    }
    
    const updatedTier = result.rows[0];
    if (updatedTier.name) invalidateTierCache(updatedTier.name);
    if (updatedTier.slug) invalidateTierCache(updatedTier.slug);
    invalidateQueryCache(TIERS_CACHE_KEY);
    
    res.json(updatedTier);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Membership tier update error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update membership tier' });
  }
});

router.post('/api/membership-tiers', isAdmin, async (req, res) => {
  try {
    const {
      name, slug, price_string, description, button_text, sort_order,
      is_active, is_popular, show_in_comparison, show_on_membership_page, highlighted_features, all_features,
      daily_sim_minutes, guest_passes_per_month, booking_window_days,
      daily_conf_room_minutes, can_book_simulators, can_book_conference,
      can_book_wellness, has_group_lessons, has_extended_sessions,
      has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
      unlimited_access
    } = req.body;
    
    if (!name || !slug || !price_string) {
      return res.status(400).json({ error: 'Name, slug, and price are required' });
    }
    
    const result = await db.execute(sql`
      INSERT INTO membership_tiers (
        name, slug, price_string, description, button_text, sort_order,
        is_active, is_popular, show_in_comparison, show_on_membership_page, highlighted_features, all_features,
        daily_sim_minutes, guest_passes_per_month, booking_window_days,
        daily_conf_room_minutes, can_book_simulators, can_book_conference,
        can_book_wellness, has_group_lessons, has_extended_sessions,
        has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
        unlimited_access
      ) VALUES (${name}, ${slug}, ${price_string}, ${description || null}, ${button_text || 'Apply Now'}, ${sort_order || 0},
        ${is_active ?? true}, ${is_popular ?? false}, ${show_in_comparison ?? true}, ${show_on_membership_page ?? true},
        ${JSON.stringify(highlighted_features || [])},
        ${JSON.stringify(all_features || {})},
        ${daily_sim_minutes || 0}, ${guest_passes_per_month || 0}, ${booking_window_days || 7},
        ${daily_conf_room_minutes || 0}, ${can_book_simulators ?? false}, ${can_book_conference ?? false},
        ${can_book_wellness ?? true}, ${has_group_lessons ?? false}, ${has_extended_sessions ?? false},
        ${has_private_lesson ?? false}, ${has_simulator_guest_passes ?? false}, ${has_discounted_merch ?? false},
        ${unlimited_access ?? false})
      RETURNING *
    `);
    
    const newTier = result.rows[0];
    if (newTier.name) invalidateTierCache(newTier.name);
    if (newTier.slug) invalidateTierCache(newTier.slug);
    invalidateQueryCache(TIERS_CACHE_KEY);
    
    res.status(201).json(result.rows[0]);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Membership tier create error', { error: error instanceof Error ? error : new Error(String(error)) });
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
    });
  } catch (error: unknown) {
    logger.error('[Admin] Stripe sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync products to Stripe', details: safeErrorDetail(error) });
  }
});

// Get sync status for all tiers
router.get('/api/admin/stripe/sync-status', isStaffOrAdmin, async (req, res) => {
  try {
    const status = await getTierSyncStatus();
    res.json({ tiers: status });
  } catch (error: unknown) {
    logger.error('[Admin] Error getting sync status', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get sync status' });
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

    res.json({
      success: tierResult.success && cafeResult.success,
      tiers: tierResult,
      cafe: cafeResult,
    });
  } catch (error: unknown) {
    logger.error('[Admin] Pull from Stripe error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to pull from Stripe', details: safeErrorDetail(error) });
  }
});

export default router;
