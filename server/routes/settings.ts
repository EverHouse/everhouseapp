import { Router } from 'express';
import { isAuthenticated, isAdmin } from '../core/middleware';
import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { logAndRespond } from '../core/logger';
import { getSessionUser } from '../types/session';
import { logFromRequest } from '../core/auditLog';

const router = Router();

const DEFAULT_SETTINGS: Record<string, { value: string; category: string }> = {
  'app.club_name': { value: 'Ever Club', category: 'display' },
  'app.support_email': { value: 'support@everclub.com', category: 'display' },
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
    const settings = await db.select().from(systemSettings);
    
    const settingsMap: Record<string, { value: string | null; category: string | null; updatedAt: Date | null }> = {};
    
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
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch settings', error, 'SETTINGS_FETCH_ERROR');
  }
});

router.get('/api/settings/:key', isAuthenticated, async (req, res) => {
  try {
    const key = req.params.key as string;
    
    const [setting] = await db.select().from(systemSettings).where(eq(systemSettings.key, key as string));
    
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
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch setting', error, 'SETTING_FETCH_ERROR');
  }
});

router.put('/api/admin/settings/:key', isAdmin, async (req, res) => {
  try {
    const key = req.params.key as string;
    const { value } = req.body;
    const userEmail = getSessionUser(req)?.email;
    
    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }
    
    const category = DEFAULT_SETTINGS[key]?.category || 'general';
    
    const [result] = await db
      .insert(systemSettings)
      .values({
        key: key as string,
        value: String(value),
        category,
        updatedBy: userEmail,
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: String(value),
          category,
          updatedBy: userEmail,
          updatedAt: new Date()
        }
      })
      .returning();
    
    logFromRequest(req, 'update_setting', 'setting', req.params.key as string, req.params.key as string, { value: req.body.value });
    res.json(result);
  } catch (error: unknown) {
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
    
    const results: Array<typeof systemSettings.$inferSelect> = [];
    
    for (const [key, value] of Object.entries(settings)) {
      const category = DEFAULT_SETTINGS[key]?.category || 'general';
      
      const [result] = await db
        .insert(systemSettings)
        .values({
          key,
          value: String(value),
          category,
          updatedBy: userEmail,
          updatedAt: new Date()
        })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: {
            value: String(value),
            category,
            updatedBy: userEmail,
            updatedAt: new Date()
          }
        })
        .returning();
      results.push(result);
    }
    
    logFromRequest(req, 'update_settings_bulk', 'settings', '', 'bulk_update', { keys: Object.keys(settings) });
    res.json({ success: true, updated: results.length });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to update settings', error, 'SETTINGS_BULK_UPDATE_ERROR');
  }
});

export default router;
