import { Router } from 'express';
import { isProduction } from '../core/db';
import { isStaffOrAdmin, isAdmin } from '../core/middleware';
import { broadcastCafeMenuUpdate } from '../core/websocket';
import { logFromRequest } from '../core/auditLog';
import { logger } from '../core/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { db } from '../db';
import { cafeItems } from '../../shared/schema';
import { sql, eq, and, asc } from 'drizzle-orm';
import { getCached, setCache, invalidateCache } from '../core/queryCache';

const CAFE_CACHE_KEY = 'cafe_menu';
const CAFE_CACHE_TTL = 60_000;

const router = Router();

router.get('/api/cafe-menu', async (req, res) => {
  try {
    const { category, include_inactive } = req.query;
    const sessionUser = (req.session as Record<string, unknown>)?.user as Record<string, unknown> | undefined;
    const userRole = sessionUser?.role as string | undefined;
    const isStaffOrAdminUser = userRole === 'admin' || userRole === 'staff';
    const showInactive = include_inactive === 'true' && isStaffOrAdminUser;

    if (!category && !showInactive) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cached = getCached<any[]>(CAFE_CACHE_KEY);
      if (cached) return res.json(cached);
    }

    const conditions = [];
    
    if (!showInactive) {
      conditions.push(eq(cafeItems.isActive, true));
    }
    
    if (category) {
      conditions.push(eq(cafeItems.category, category as string));
    }
    
    const result = await db.select().from(cafeItems)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(cafeItems.sortOrder), asc(cafeItems.category), asc(cafeItems.name));

    if (!category && !showInactive) {
      setCache(CAFE_CACHE_KEY, result, CAFE_CACHE_TTL);
    }

    res.json(result);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Cafe menu error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to fetch cafe menu' });
  }
});

router.post('/api/cafe-menu', isStaffOrAdmin, async (req, res) => {
  try {
    const { category, name, price, description, icon, image_url, is_active, sort_order } = req.body;
    
    if (!name || !category) {
      return res.status(400).json({ error: 'Name and category are required' });
    }
    
    const result = await db.insert(cafeItems).values({
      category,
      name,
      price: String(price || 0),
      description: description || '',
      icon: icon || '',
      imageUrl: image_url || '',
      isActive: is_active !== false,
      sortOrder: sort_order || 0,
    }).returning();
    
    invalidateCache(CAFE_CACHE_KEY);
    broadcastCafeMenuUpdate('created');
    logFromRequest(req, 'create_cafe_item', 'cafe', String(result[0].id), result[0].name || name, {});
    res.status(201).json(result[0]);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Cafe item creation error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to create cafe item' });
  }
});

router.put('/api/cafe-menu/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const numericId = Number(id);
    if (isNaN(numericId)) {
      return res.status(400).json({ error: 'Invalid cafe item ID: must be a number' });
    }
    const { category, name, price, description, icon, image_url, is_active, sort_order } = req.body;
    
    const existing = await db.select({ 
        stripeProductId: cafeItems.stripeProductId,
        name: cafeItems.name,
        price: cafeItems.price,
        category: cafeItems.category,
      })
      .from(cafeItems)
      .where(eq(cafeItems.id, numericId));
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Cafe item not found' });
    }
    
    let result;
    if (existing[0].stripeProductId) {
      const nameChanged = name !== undefined && name !== existing[0].name;
      const priceChanged = price !== undefined && String(price) !== String(existing[0].price);
      const categoryChanged = category !== undefined && category !== existing[0].category;
      if (nameChanged || priceChanged || categoryChanged) {
        return res.status(400).json({ 
          error: 'Cannot change name, price, or category for Stripe-linked items. Update these fields directly in Stripe and use "Pull from Stripe" to sync changes.' 
        });
      }
      result = await db.update(cafeItems).set({
        description: sql`COALESCE(${description}, ${cafeItems.description})`,
        icon: sql`COALESCE(${icon}, ${cafeItems.icon})`,
        imageUrl: sql`COALESCE(${image_url}, ${cafeItems.imageUrl})`,
        isActive: sql`COALESCE(${is_active}, ${cafeItems.isActive})`,
        sortOrder: sql`COALESCE(${sort_order}, ${cafeItems.sortOrder})`,
      }).where(eq(cafeItems.id, numericId)).returning();
    } else {
      result = await db.update(cafeItems).set({
        category: sql`COALESCE(${category}, ${cafeItems.category})`,
        name: sql`COALESCE(${name}, ${cafeItems.name})`,
        price: sql`COALESCE(${price}, ${cafeItems.price})`,
        description: sql`COALESCE(${description}, ${cafeItems.description})`,
        icon: sql`COALESCE(${icon}, ${cafeItems.icon})`,
        imageUrl: sql`COALESCE(${image_url}, ${cafeItems.imageUrl})`,
        isActive: sql`COALESCE(${is_active}, ${cafeItems.isActive})`,
        sortOrder: sql`COALESCE(${sort_order}, ${cafeItems.sortOrder})`,
      }).where(eq(cafeItems.id, numericId)).returning();
    }
    
    invalidateCache(CAFE_CACHE_KEY);
    broadcastCafeMenuUpdate('updated');
    logFromRequest(req, 'update_cafe_item', 'cafe', String(id), name, {});
    res.json(result[0]);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Cafe item update error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to update cafe item' });
  }
});

router.delete('/api/cafe-menu/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const numericId = Number(id);
    if (isNaN(numericId)) {
      return res.status(400).json({ error: 'Invalid cafe item ID: must be a number' });
    }
    
    const existing = await db.select({ stripeProductId: cafeItems.stripeProductId, name: cafeItems.name })
      .from(cafeItems)
      .where(eq(cafeItems.id, numericId));
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Cafe item not found' });
    }
    if (existing[0].stripeProductId) {
      try {
        const { getStripeClient } = await import('../core/stripe/client');
        const stripe = await getStripeClient();
        const product = await stripe.products.retrieve(existing[0].stripeProductId) as unknown as { active?: boolean; deleted?: boolean };
        if (product && !product.deleted && product.active) {
          await stripe.products.update(existing[0].stripeProductId, { active: false });
          logger.info(`[Cafe] Archived Stripe product ${existing[0].stripeProductId} for cafe item "${existing[0].name}"`);
        }
      } catch (stripeErr: unknown) {
        const isNotFound = stripeErr instanceof Error && 'statusCode' in stripeErr && (stripeErr as { statusCode: number }).statusCode === 404;
        if (!isNotFound) {
          logger.warn(`[Cafe] Failed to archive Stripe product ${existing[0].stripeProductId} during delete, proceeding with local delete`, { error: getErrorMessage(stripeErr) });
        }
      }
    }
    
    await db.update(cafeItems).set({ isActive: false }).where(eq(cafeItems.id, numericId));
    invalidateCache(CAFE_CACHE_KEY);
    broadcastCafeMenuUpdate('deleted');
    logFromRequest(req, 'delete_cafe_item', 'cafe', String(id), existing[0].name || undefined, {});
    res.json({ success: true });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Cafe item delete error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to delete cafe item' });
  }
});

router.post('/api/admin/seed-cafe', isAdmin, async (req, res) => {
  try {
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(cafeItems).where(eq(cafeItems.isActive, true));
    const existingCount = Number(countResult[0].count);
    
    if (existingCount > 0) {
      return res.json({ 
        success: true, 
        message: 'Cafe menu already has active items - skipping seed',
        existingBefore: existingCount,
        totalAfter: existingCount
      });
    }
    
    const cafeItemsData = [
      { category: 'Breakfast', name: 'Egg Toast', price: 14, description: 'Schaner Farm scrambled eggs, whipped ricotta, chives, micro greens, toasted country batard', icon: 'egg_alt', sort_order: 1 },
      { category: 'Breakfast', name: 'Avocado Toast', price: 16, description: 'Hass smashed avocado, radish, lemon, micro greens, dill, toasted country batard', icon: 'eco', sort_order: 2 },
      { category: 'Breakfast', name: 'Banana & Honey Toast', price: 14, description: 'Banana, whipped ricotta, Hapa Honey Farm local honey, toasted country batard', icon: 'bakery_dining', sort_order: 3 },
      { category: 'Breakfast', name: 'Smoked Salmon Toast', price: 20, description: 'Alaskan king smoked salmon, whipped cream cheese, dill, capers, lemon, micro greens, toasted country batard', icon: 'set_meal', sort_order: 4 },
      { category: 'Breakfast', name: 'Breakfast Croissant', price: 16, description: 'Schaner Farm eggs, New School american cheese, freshly baked croissant, choice of cured ham or applewood smoked bacon', icon: 'bakery_dining', sort_order: 5 },
      { category: 'Breakfast', name: 'French Omelette', price: 14, description: 'Schaner Farm eggs, cultured butter, fresh herbs, served with side of seasonal salad greens', icon: 'egg', sort_order: 6 },
      { category: 'Breakfast', name: 'Hanger Steak & Eggs', price: 24, description: 'Autonomy Farms Hanger steak, Schaner Farm eggs, cooked your way', icon: 'restaurant', sort_order: 7 },
      { category: 'Breakfast', name: 'Bacon & Eggs', price: 14, description: 'Applewood smoked bacon, Schaner Farm eggs, cooked your way', icon: 'egg_alt', sort_order: 8 },
      { category: 'Breakfast', name: 'Yogurt Parfait', price: 14, description: 'Yogurt, seasonal fruits, farmstead granola, Hapa Honey farm local honey', icon: 'icecream', sort_order: 9 },
      { category: 'Sides', name: 'Bacon, Two Slices', price: 6, description: 'Applewood smoked bacon', icon: 'restaurant', sort_order: 1 },
      { category: 'Sides', name: 'Eggs, Scrambled', price: 8, description: 'Schaner Farm scrambled eggs', icon: 'egg', sort_order: 2 },
      { category: 'Sides', name: 'Seasonal Fruit Bowl', price: 10, description: 'Fresh seasonal fruits', icon: 'nutrition', sort_order: 3 },
      { category: 'Sides', name: 'Smoked Salmon', price: 9, description: 'Alaskan king smoked salmon', icon: 'set_meal', sort_order: 4 },
      { category: 'Sides', name: 'Toast, Two Slices', price: 3, description: 'Toasted country batard', icon: 'bakery_dining', sort_order: 5 },
      { category: 'Sides', name: 'Sqirl Seasonal Jam', price: 3, description: 'Artisan seasonal jam', icon: 'local_florist', sort_order: 6 },
      { category: 'Sides', name: 'Pistachio Spread', price: 4, description: 'House-made pistachio spread', icon: 'spa', sort_order: 7 },
      { category: 'Lunch', name: 'Caesar Salad', price: 15, description: 'Romaine lettuce, homemade dressing, grated Reggiano. Add: roasted chicken $8, hanger steak 8oz $14', icon: 'local_florist', sort_order: 1 },
      { category: 'Lunch', name: 'Wedge Salad', price: 16, description: 'Iceberg lettuce, bacon, red onion, cherry tomatoes, Point Reyes bleu cheese, homemade dressing', icon: 'local_florist', sort_order: 2 },
      { category: 'Lunch', name: 'Chicken Salad Sandwich', price: 14, description: 'Autonomy Farms chicken, celery, toasted pan loaf, served with olive oil potato chips', icon: 'lunch_dining', sort_order: 3 },
      { category: 'Lunch', name: 'Tuna Salad Sandwich', price: 14, description: 'Wild, pole-caught albacore tuna, sprouts, club chimichurri, toasted pan loaf, served with olive oil potato chips', icon: 'set_meal', sort_order: 4 },
      { category: 'Lunch', name: 'Grilled Cheese', price: 12, description: 'New School american cheese, brioche pan loaf, served with olive oil potato chips. Add: short rib $6, roasted tomato soup cup $7', icon: 'lunch_dining', sort_order: 5 },
      { category: 'Lunch', name: 'Heirloom BLT', price: 18, description: 'Applewood smoked bacon, butter lettuce, heirloom tomatoes, olive oil mayo, toasted pan loaf, served with olive oil potato chips', icon: 'lunch_dining', sort_order: 6 },
      { category: 'Lunch', name: 'Bratwurst', price: 12, description: 'German bratwurst, sautéed onions & peppers, toasted brioche bun', icon: 'lunch_dining', sort_order: 7 },
      { category: 'Lunch', name: 'Bison Serrano Chili', price: 14, description: 'Pasture raised bison, serrano, anaheim, green bell peppers, mint, cilantro, cheddar cheese, sour cream, green onion, served with organic corn chips', icon: 'soup_kitchen', sort_order: 8 },
      { category: 'Kids', name: 'Kids Grilled Cheese', price: 6, description: 'Classic grilled cheese for little ones', icon: 'child_care', sort_order: 1 },
      { category: 'Kids', name: 'Kids Hot Dog', price: 8, description: 'All-beef hot dog', icon: 'child_care', sort_order: 2 },
      { category: 'Dessert', name: 'Vanilla Bean Gelato Sandwich', price: 6, description: 'Vanilla bean gelato with chocolate chip cookies', icon: 'icecream', sort_order: 1 },
      { category: 'Dessert', name: 'Sea Salt Caramel Gelato Sandwich', price: 6, description: 'Sea salt caramel gelato with snickerdoodle cookies', icon: 'icecream', sort_order: 2 },
      { category: 'Dessert', name: 'Seasonal Pie, Slice', price: 6, description: 'Daily seasonal pie with house made crème', icon: 'cake', sort_order: 3 },
      { category: 'Shareables', name: 'Club Charcuterie', price: 32, description: 'Selection of cured meats and artisan cheeses', icon: 'tapas', sort_order: 1 },
      { category: 'Shareables', name: 'Chips & Salsa', price: 10, description: 'House-made salsa with organic corn chips', icon: 'tapas', sort_order: 2 },
      { category: 'Shareables', name: 'Caviar Service', price: 0, description: 'Market price - ask your server', icon: 'dining', sort_order: 3 },
      { category: 'Shareables', name: 'Tinned Fish Tray', price: 47, description: 'Premium selection of tinned fish', icon: 'set_meal', sort_order: 4 },
    ];

    await db.insert(cafeItems).values(
      cafeItemsData.map(item => ({
        category: item.category,
        name: item.name,
        price: String(item.price),
        description: item.description,
        icon: item.icon,
        isActive: true,
        sortOrder: item.sort_order,
      }))
    );
    const inserted = cafeItemsData.length;
    
    logFromRequest(req, 'seed_cafe', 'cafe', undefined, 'Cafe Menu Seed', {});
    res.json({ 
      success: true, 
      message: `Cafe menu seeded: ${inserted} new items added`,
      existingBefore: existingCount,
      totalAfter: existingCount + inserted
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Cafe seed error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to seed cafe menu' });
  }
});

export default router;
