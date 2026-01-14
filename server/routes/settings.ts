import { Router } from 'express';
import { isAuthenticated, isAdmin } from '../core/middleware';
import { db } from '../db';
import { appSettings } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { logAndRespond } from '../core/logger';
import { getSessionUser } from '../types/session';

const router = Router();

const DEFAULT_SETTINGS: Record<string, { value: string; category: string }> = {
  'app.club_name': { value: 'Ever House', category: 'display' },
  'app.support_email': { value: 'support@everhouse.com', category: 'display' },
  'app.timezone_display': { value: 'America/Los_Angeles', category: 'display' },
  'category.guest_pass': { value: 'Guest Pass', category: 'categories' },
  'category.guest_sim_fee': { value: 'Guest Sim Fee', category: 'categories' },
  'category.sim_walk_in': { value: 'Sim Walk-In', category: 'categories' },
  'category.membership': { value: 'Membership', category: 'categories' },
  'category.cafe': { value: 'Cafe', category: 'categories' },
  'category.retail': { value: 'Retail', category: 'categories' },
  'category.other': { value: 'Other', category: 'categories' },
  'notifications.data_integrity_alerts': { value: 'true', category: 'notifications' },
  'notifications.sync_failure_alerts': { value: 'true', category: 'notifications' },
};

router.get('/api/settings', isAuthenticated, async (req, res) => {
  try {
    const settings = await db.select().from(appSettings);
    
    const settingsMap: Record<string, { value: string | null; category: string; updatedAt: Date }> = {};
    
    for (const [key, defaultVal] of Object.entries(DEFAULT_SETTINGS)) {
      const existing = settings.find(s => s.key === key);
      if (existing) {
        settingsMap[key] = {
          value: existing.value,
          category: existing.category,
          updatedAt: existing.updatedAt
        };
      } else {
        settingsMap[key] = {
          value: defaultVal.value,
          category: defaultVal.category,
          updatedAt: new Date()
        };
      }
    }
    
    res.json(settingsMap);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch settings', error, 'SETTINGS_FETCH_ERROR');
  }
});

router.get('/api/settings/:key', isAuthenticated, async (req, res) => {
  try {
    const { key } = req.params;
    
    const [setting] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    
    if (setting) {
      res.json(setting);
    } else if (DEFAULT_SETTINGS[key]) {
      res.json({
        key,
        value: DEFAULT_SETTINGS[key].value,
        category: DEFAULT_SETTINGS[key].category,
        updatedAt: new Date()
      });
    } else {
      res.status(404).json({ error: 'Setting not found' });
    }
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch setting', error, 'SETTING_FETCH_ERROR');
  }
});

router.put('/api/admin/settings/:key', isAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    const userEmail = getSessionUser(req)?.email;
    
    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }
    
    const category = DEFAULT_SETTINGS[key]?.category || 'general';
    
    const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    
    if (existing) {
      const [updated] = await db
        .update(appSettings)
        .set({
          value: String(value),
          updatedAt: new Date(),
          updatedBy: userEmail
        })
        .where(eq(appSettings.key, key))
        .returning();
      
      res.json(updated);
    } else {
      const [created] = await db
        .insert(appSettings)
        .values({
          key,
          value: String(value),
          category,
          updatedBy: userEmail
        })
        .returning();
      
      res.json(created);
    }
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to update setting', error, 'SETTING_UPDATE_ERROR');
  }
});

router.put('/api/admin/settings', isAdmin, async (req, res) => {
  try {
    const { settings } = req.body;
    const userEmail = getSessionUser(req)?.email;
    
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Settings object is required' });
    }
    
    const results: any[] = [];
    
    for (const [key, value] of Object.entries(settings)) {
      const category = DEFAULT_SETTINGS[key]?.category || 'general';
      
      const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, key));
      
      if (existing) {
        const [updated] = await db
          .update(appSettings)
          .set({
            value: String(value),
            updatedAt: new Date(),
            updatedBy: userEmail
          })
          .where(eq(appSettings.key, key))
          .returning();
        results.push(updated);
      } else {
        const [created] = await db
          .insert(appSettings)
          .values({
            key,
            value: String(value),
            category,
            updatedBy: userEmail
          })
          .returning();
        results.push(created);
      }
    }
    
    res.json({ success: true, updated: results.length });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to update settings', error, 'SETTINGS_BULK_UPDATE_ERROR');
  }
});

export default router;
