import { Router } from 'express';
import { pool, isProduction } from '../core/db';
import { isAdmin, isStaffOrAdmin } from '../core/middleware';
import { invalidateTierCache, clearTierCache } from '../core/tierService';
import { syncMembershipTiersToStripe, getTierSyncStatus, cleanupOrphanStripeProducts, syncTierFeaturesToStripe, syncCafeItemsToStripe, pullTierFeaturesFromStripe, pullCafeItemsFromStripe } from '../core/stripe/products';
import { syncAllCustomerMetadata } from '../core/stripe/customers';
import { logFromRequest } from '../core/auditLog';

const router = Router();

router.get('/api/membership-tiers', async (req, res) => {
  try {
    const { active } = req.query;
    let query = 'SELECT * FROM membership_tiers';
    const params: any[] = [];
    
    if (active === 'true') {
      query += ' WHERE is_active = true';
    }
    
    query += ' ORDER BY sort_order ASC, id ASC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error: any) {
    if (!isProduction) console.error('Membership tiers fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch membership tiers' });
  }
});

router.get('/api/membership-tiers/limits/:tierName', async (req, res) => {
  try {
    const { tierName } = req.params;
    const result = await pool.query(
      `SELECT 
        name, slug,
        daily_sim_minutes, guest_passes_per_month, booking_window_days,
        daily_conf_room_minutes, can_book_simulators, can_book_conference,
        can_book_wellness, has_group_lessons, has_extended_sessions,
        has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
        unlimited_access
      FROM membership_tiers 
      WHERE LOWER(name) = LOWER($1) OR LOWER(slug) = LOWER($1)
      LIMIT 1`,
      [tierName]
    );
    
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
  } catch (error: any) {
    if (!isProduction) console.error('Membership tier limits fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch tier limits' });
  }
});

router.get('/api/membership-tiers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM membership_tiers WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tier not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error: any) {
    if (!isProduction) console.error('Membership tier fetch error:', error);
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
    
    const result = await pool.query(`
      UPDATE membership_tiers SET
        name = COALESCE($1, name),
        slug = COALESCE($2, slug),
        price_string = COALESCE($3, price_string),
        description = COALESCE($4, description),
        button_text = COALESCE($5, button_text),
        sort_order = COALESCE($6, sort_order),
        is_active = COALESCE($7, is_active),
        is_popular = COALESCE($8, is_popular),
        show_in_comparison = COALESCE($9, show_in_comparison),
        highlighted_features = COALESCE($10, highlighted_features),
        all_features = COALESCE($11, all_features),
        daily_sim_minutes = COALESCE($12, daily_sim_minutes),
        guest_passes_per_month = COALESCE($13, guest_passes_per_month),
        booking_window_days = COALESCE($14, booking_window_days),
        daily_conf_room_minutes = COALESCE($15, daily_conf_room_minutes),
        can_book_simulators = COALESCE($16, can_book_simulators),
        can_book_conference = COALESCE($17, can_book_conference),
        can_book_wellness = COALESCE($18, can_book_wellness),
        has_group_lessons = COALESCE($19, has_group_lessons),
        has_extended_sessions = COALESCE($20, has_extended_sessions),
        has_private_lesson = COALESCE($21, has_private_lesson),
        has_simulator_guest_passes = COALESCE($22, has_simulator_guest_passes),
        has_discounted_merch = COALESCE($23, has_discounted_merch),
        unlimited_access = COALESCE($24, unlimited_access),
        stripe_price_id = $26,
        stripe_product_id = $27,
        price_cents = $28,
        show_on_membership_page = COALESCE($29, show_on_membership_page),
        updated_at = NOW()
      WHERE id = $25
      RETURNING *
    `, [
      name, slug, price_string, description, button_text, sort_order,
      is_active, is_popular, show_in_comparison,
      highlighted_features ? JSON.stringify(highlighted_features) : null,
      all_features ? JSON.stringify(all_features) : null,
      daily_sim_minutes, guest_passes_per_month, booking_window_days,
      daily_conf_room_minutes, can_book_simulators, can_book_conference,
      can_book_wellness, has_group_lessons, has_extended_sessions,
      has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
      unlimited_access, id,
      stripe_price_id || null, stripe_product_id || null, price_cents || null,
      show_on_membership_page
    ]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tier not found' });
    }
    
    // Invalidate cache for this tier
    const updatedTier = result.rows[0];
    if (updatedTier.name) invalidateTierCache(updatedTier.name);
    if (updatedTier.slug) invalidateTierCache(updatedTier.slug);
    
    res.json(updatedTier);
  } catch (error: any) {
    if (!isProduction) console.error('Membership tier update error:', error);
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
    
    const result = await pool.query(`
      INSERT INTO membership_tiers (
        name, slug, price_string, description, button_text, sort_order,
        is_active, is_popular, show_in_comparison, show_on_membership_page, highlighted_features, all_features,
        daily_sim_minutes, guest_passes_per_month, booking_window_days,
        daily_conf_room_minutes, can_book_simulators, can_book_conference,
        can_book_wellness, has_group_lessons, has_extended_sessions,
        has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
        unlimited_access
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
      RETURNING *
    `, [
      name, slug, price_string, description || null, button_text || 'Apply Now', sort_order || 0,
      is_active ?? true, is_popular ?? false, show_in_comparison ?? true, show_on_membership_page ?? true,
      JSON.stringify(highlighted_features || []),
      JSON.stringify(all_features || {}),
      daily_sim_minutes || 0, guest_passes_per_month || 0, booking_window_days || 7,
      daily_conf_room_minutes || 0, can_book_simulators ?? false, can_book_conference ?? false,
      can_book_wellness ?? true, has_group_lessons ?? false, has_extended_sessions ?? false,
      has_private_lesson ?? false, has_simulator_guest_passes ?? false, has_discounted_merch ?? false,
      unlimited_access ?? false
    ]);
    
    // Invalidate tier cache for the new tier
    const newTier = result.rows[0];
    if (newTier.name) invalidateTierCache(newTier.name);
    if (newTier.slug) invalidateTierCache(newTier.slug);
    
    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    if (!isProduction) console.error('Membership tier create error:', error);
    if (error.code === '23505') {
      res.status(400).json({ error: 'A tier with this name or slug already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create membership tier' });
    }
  }
});

// Admin endpoint to sync all membership tiers to Stripe (two-way sync)
router.post('/api/admin/stripe/sync-products', isStaffOrAdmin, async (req, res) => {
  try {
    console.log('[Admin] Starting Stripe product sync...');
    
    // Step 1: Push app products to Stripe
    const syncResult = await syncMembershipTiersToStripe();
    console.log(`[Admin] Stripe sync complete: ${syncResult.synced} synced, ${syncResult.failed} failed, ${syncResult.skipped} skipped`);
    
    // Step 2: Archive orphan Stripe products not in the app
    const cleanupResult = await cleanupOrphanStripeProducts();
    console.log(`[Admin] Stripe cleanup complete: ${cleanupResult.archived} archived, ${cleanupResult.skipped} skipped`);
    
    // Step 3: Sync tier features to Stripe entitlements
    const featureResult = await syncTierFeaturesToStripe();
    console.log(`[Admin] Feature sync complete: ${featureResult.featuresCreated} created, ${featureResult.featuresAttached} attached, ${featureResult.featuresRemoved} removed`);
    
    // Step 4: Sync cafe items to Stripe
    const cafeResult = await syncCafeItemsToStripe();
    console.log(`[Admin] Cafe sync complete: ${cafeResult.synced} synced, ${cafeResult.failed} failed, ${cafeResult.skipped} skipped`);
    
    // Step 5: Sync customer metadata to Stripe
    let customerMetadataResult = { synced: 0, failed: 0 };
    try {
      customerMetadataResult = await syncAllCustomerMetadata();
      console.log(`[Admin] Customer metadata sync complete: ${customerMetadataResult.synced} synced, ${customerMetadataResult.failed} failed`);
    } catch (metaErr: any) {
      console.error('[Admin] Customer metadata sync error (non-fatal):', metaErr.message);
    }
    
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
      customerMetadata: customerMetadataResult
    });
  } catch (error: any) {
    console.error('[Admin] Stripe sync error:', error);
    res.status(500).json({ error: 'Failed to sync products to Stripe', message: error.message });
  }
});

// Get sync status for all tiers
router.get('/api/admin/stripe/sync-status', isStaffOrAdmin, async (req, res) => {
  try {
    const status = await getTierSyncStatus();
    res.json({ tiers: status });
  } catch (error: any) {
    console.error('[Admin] Error getting sync status:', error);
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

router.post('/api/admin/stripe/pull-from-stripe', isStaffOrAdmin, async (req, res) => {
  try {
    console.log('[Admin] Starting pull from Stripe...');

    const [tierResult, cafeResult] = await Promise.all([
      pullTierFeaturesFromStripe(),
      pullCafeItemsFromStripe(),
    ]);

    console.log(`[Admin] Pull from Stripe complete: ${tierResult.tiersUpdated} tiers updated, ${cafeResult.synced} cafe items synced, ${cafeResult.created} created, ${cafeResult.deactivated} deactivated`);

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

    res.json({
      success: tierResult.success && cafeResult.success,
      tiers: tierResult,
      cafe: cafeResult,
    });
  } catch (error: any) {
    console.error('[Admin] Pull from Stripe error:', error);
    res.status(500).json({ error: 'Failed to pull from Stripe', message: error.message });
  }
});

export default router;
