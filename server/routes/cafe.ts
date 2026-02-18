import { Router } from 'express';
import { pool, isProduction } from '../core/db';
import { isAdmin, isStaffOrAdmin } from '../core/middleware';
import { broadcastCafeMenuUpdate } from '../core/websocket';
import { logFromRequest } from '../core/auditLog';
import { logger } from '../core/logger';

const router = Router();

router.get('/api/cafe-menu', async (req, res) => {
  try {
    const { category, include_inactive } = req.query;
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    
    if (include_inactive !== 'true') {
      conditions.push('is_active = true');
    }
    
    if (category) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    
    let query = 'SELECT * FROM cafe_items';
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY sort_order, category, name';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Cafe menu error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch cafe menu' });
  }
});

router.post('/api/cafe-menu', isStaffOrAdmin, async (req, res) => {
  try {
    const { category, name, price, description, icon, image_url, is_active, sort_order } = req.body;
    
    if (!name || !category) {
      return res.status(400).json({ error: 'Name and category are required' });
    }
    
    const result = await pool.query(
      `INSERT INTO cafe_items (category, name, price, description, icon, image_url, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [category, name, price || 0, description || '', icon || '', image_url || '', is_active !== false, sort_order || 0]
    );
    
    broadcastCafeMenuUpdate('created');
    logFromRequest(req, 'create_cafe_item', 'cafe', String(result.rows[0].id), result.rows[0].name || name, {});
    res.status(201).json(result.rows[0]);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Cafe item creation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create cafe item' });
  }
});

router.put('/api/cafe-menu/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { category, name, price, description, icon, image_url, is_active, sort_order } = req.body;
    
    const existing = await pool.query('SELECT stripe_product_id FROM cafe_items WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Cafe item not found' });
    }
    
    let result;
    if (existing.rows[0].stripe_product_id) {
      result = await pool.query(
        `UPDATE cafe_items 
         SET description = COALESCE($1, description),
             icon = COALESCE($2, icon),
             image_url = COALESCE($3, image_url),
             sort_order = COALESCE($4, sort_order)
         WHERE id = $5 RETURNING *`,
        [description, icon, image_url, sort_order, id]
      );
    } else {
      result = await pool.query(
        `UPDATE cafe_items 
         SET category = COALESCE($1, category),
             name = COALESCE($2, name),
             price = COALESCE($3, price),
             description = COALESCE($4, description),
             icon = COALESCE($5, icon),
             image_url = COALESCE($6, image_url),
             is_active = COALESCE($7, is_active),
             sort_order = COALESCE($8, sort_order)
         WHERE id = $9 RETURNING *`,
        [category, name, price, description, icon, image_url, is_active, sort_order, id]
      );
    }
    
    broadcastCafeMenuUpdate('updated');
    logFromRequest(req, 'update_cafe_item', 'cafe', String(id), name, {});
    res.json(result.rows[0]);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Cafe item update error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update cafe item' });
  }
});

router.delete('/api/cafe-menu/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await pool.query('SELECT stripe_product_id FROM cafe_items WHERE id = $1', [id]);
    if (existing.rows.length > 0 && existing.rows[0].stripe_product_id) {
      return res.status(400).json({ error: 'Cannot delete Stripe-managed items. Archive in Stripe Dashboard instead.' });
    }
    
    await pool.query('DELETE FROM cafe_items WHERE id = $1', [id]);
    broadcastCafeMenuUpdate('deleted');
    logFromRequest(req, 'delete_cafe_item', 'cafe', String(id), undefined, {});
    res.json({ success: true });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Cafe item delete error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete cafe item' });
  }
});

// Admin-protected seed endpoint for production
router.post('/api/admin/seed-cafe', isAdmin, async (req, res) => {
  try {
    // Check current count - only seed if table is empty
    const countResult = await pool.query('SELECT COUNT(*) as count FROM cafe_items');
    const existingCount = parseInt(countResult.rows[0].count);
    
    if (existingCount > 0) {
      return res.json({ 
        success: true, 
        message: 'Cafe menu already has items - skipping seed',
        existingBefore: existingCount,
        totalAfter: existingCount
      });
    }
    
    // Seed cafe items (only when table is empty)
    const cafeItems = [
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
    
    const categories = cafeItems.map(i => i.category);
    const names = cafeItems.map(i => i.name);
    const prices = cafeItems.map(i => i.price);
    const descriptions = cafeItems.map(i => i.description);
    const icons = cafeItems.map(i => i.icon);
    const sortOrders = cafeItems.map(i => i.sort_order);

    const insertResult = await pool.query(
      `INSERT INTO cafe_items (category, name, price, description, icon, is_active, sort_order)
       SELECT category, name, price, description, icon, true, sort_order
       FROM unnest($1::text[], $2::text[], $3::numeric[], $4::text[], $5::text[], $6::int[])
       AS t(category, name, price, description, icon, sort_order)`,
      [categories, names, prices, descriptions, icons, sortOrders]
    );
    const inserted = insertResult.rowCount || 0;
    
    logFromRequest(req, 'seed_cafe', 'cafe', undefined, 'Cafe Menu Seed', {});
    res.json({ 
      success: true, 
      message: `Cafe menu seeded: ${inserted} new items added`,
      existingBefore: existingCount,
      totalAfter: existingCount + inserted
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Cafe seed error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to seed cafe menu' });
  }
});

export default router;
