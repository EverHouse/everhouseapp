import { Router } from 'express';
import { isAuthenticated, isAdmin } from '../core/middleware';
import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { logAndRespond } from '../core/logger';
import { getSessionUser } from '../types/session';
import { logFromRequest } from '../core/auditLog';
import { invalidateSettingsCache } from '../core/settingsHelper';

const router = Router();

const DEFAULT_SETTINGS: Record<string, { value: string; category: string }> = {
  'notifications.data_integrity_alerts': { value: 'true', category: 'notifications' },
  'notifications.sync_failure_alerts': { value: 'true', category: 'notifications' },

  'email.auth.enabled': { value: 'true', category: 'email' },
  'email.welcome.enabled': { value: 'true', category: 'email' },
  'email.booking.enabled': { value: 'true', category: 'email' },
  'email.passes.enabled': { value: 'true', category: 'email' },
  'email.payments.enabled': { value: 'false', category: 'email' },
  'email.membership.enabled': { value: 'false', category: 'email' },
  'email.onboarding.enabled': { value: 'true', category: 'email' },
  'email.system.enabled': { value: 'true', category: 'email' },

  'scheduler.Background_Sync.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Daily_Reminder.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Morning_Closure.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Weekly_Cleanup.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Integrity_Check.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Auto-Fix_Tiers.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Abandoned_Pending_Cleanup.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Waiver_Review.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Stripe_Reconciliation.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Fee_Snapshot_Reconciliation.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Grace_Period.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Booking_Expiry.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Booking_Auto-Complete.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Communication_Logs_Sync.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Webhook_Log_Cleanup.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Session_Cleanup.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Unresolved_Trackman.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.HubSpot_Queue.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.HubSpot_Form_Sync.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Member_Sync.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Duplicate_Cleanup.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Guest_Pass_Reset.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Relocation_Cleanup.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Stuck_Cancellation.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Pending_User_Cleanup.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Webhook_Event_Cleanup.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Onboarding_Nudge.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Job_Queue_Processor.enabled': { value: 'true', category: 'scheduler' },
  'scheduler.Invite_Expiry.enabled': { value: 'true', category: 'scheduler' },

  'push.enabled': { value: 'true', category: 'push' },
  'booking.auto_approve.conference_rooms': { value: 'true', category: 'booking' },
  'booking.auto_approve.trackman_imports': { value: 'true', category: 'booking' },

  'contact.phone': { value: '(949) 545-5855', category: 'contact' },
  'contact.email': { value: 'info@joinever.club', category: 'contact' },
  'contact.address_line1': { value: '15771 Red Hill Ave, Ste 500', category: 'contact' },
  'contact.address_line2': { value: '', category: 'contact' },
  'contact.city_state_zip': { value: 'Tustin, CA 92780', category: 'contact' },
  'contact.formerly_known_as': { value: 'Formerly Even House (evenhouse.club)', category: 'contact' },
  'contact.google_maps_url': { value: 'https://maps.app.goo.gl/Zp93EMzyp9EA3vqA6', category: 'contact' },
  'contact.apple_maps_url': { value: 'https://maps.apple.com/place?place-id=I2671995E78948F1F&address=15771+Red+Hill+Ave%2C+Ste+500%2C+Tustin%2C+CA++92780%2C+United+States&coordinate=33.713744%2C-117.836476&name=Even+House&_provider=9902', category: 'contact' },

  'social.instagram_url': { value: 'https://www.instagram.com/everclub/', category: 'social' },
  'social.tiktok_url': { value: 'https://www.tiktok.com/@everclub', category: 'social' },
  'social.linkedin_url': { value: 'https://www.linkedin.com/company/ever-club', category: 'social' },

  'apple_messages.enabled': { value: 'false', category: 'apple_messages' },
  'apple_messages.business_id': { value: '', category: 'apple_messages' },

  'apple_wallet.enabled': { value: 'false', category: 'apple_wallet' },
  'apple_wallet.pass_type_id': { value: '', category: 'apple_wallet' },
  'apple_wallet.team_id': { value: '', category: 'apple_wallet' },

  'hours.monday': { value: 'Closed', category: 'hours_display' },
  'hours.tuesday_thursday': { value: '8:30 AM – 8:00 PM', category: 'hours_display' },
  'hours.friday_saturday': { value: '8:30 AM – 10:00 PM', category: 'hours_display' },
  'hours.sunday': { value: '8:30 AM – 6:00 PM', category: 'hours_display' },

  'resource.golf.slot_duration': { value: '60', category: 'resource_hours' },
  'resource.conference.slot_duration': { value: '30', category: 'resource_hours' },
  'resource.tours.slot_duration': { value: '30', category: 'resource_hours' },


  'hubspot.tier.core': { value: 'Core Membership', category: 'hubspot_tiers' },
  'hubspot.tier.core-founding': { value: 'Core Membership Founding Members', category: 'hubspot_tiers' },
  'hubspot.tier.premium': { value: 'Premium Membership', category: 'hubspot_tiers' },
  'hubspot.tier.premium-founding': { value: 'Premium Membership Founding Members', category: 'hubspot_tiers' },
  'hubspot.tier.social': { value: 'Social Membership', category: 'hubspot_tiers' },
  'hubspot.tier.social-founding': { value: 'Social Membership Founding Members', category: 'hubspot_tiers' },
  'hubspot.tier.vip': { value: 'VIP Membership', category: 'hubspot_tiers' },
  'hubspot.tier.corporate': { value: 'Corporate Membership', category: 'hubspot_tiers' },
  'hubspot.tier.group-lessons': { value: 'Group Lessons Membership', category: 'hubspot_tiers' },

  'hubspot.status.active': { value: 'Active', category: 'hubspot_statuses' },
  'hubspot.status.trialing': { value: 'trialing', category: 'hubspot_statuses' },
  'hubspot.status.past_due': { value: 'past_due', category: 'hubspot_statuses' },
  'hubspot.status.inactive': { value: 'Suspended', category: 'hubspot_statuses' },
  'hubspot.status.cancelled': { value: 'Terminated', category: 'hubspot_statuses' },
  'hubspot.status.expired': { value: 'Expired', category: 'hubspot_statuses' },
  'hubspot.status.terminated': { value: 'Terminated', category: 'hubspot_statuses' },
  'hubspot.status.former_member': { value: 'Terminated', category: 'hubspot_statuses' },
  'hubspot.status.pending': { value: 'Pending', category: 'hubspot_statuses' },
  'hubspot.status.suspended': { value: 'Suspended', category: 'hubspot_statuses' },
  'hubspot.status.frozen': { value: 'Froze', category: 'hubspot_statuses' },
  'hubspot.status.non-member': { value: 'Non-Member', category: 'hubspot_statuses' },
  'hubspot.status.deleted': { value: 'Terminated', category: 'hubspot_statuses' },

  'scheduling.daily_reminder_hour': { value: '18', category: 'scheduling' },
  'scheduling.morning_closure_hour': { value: '8', category: 'scheduling' },
  'scheduling.onboarding_nudge_hour': { value: '10', category: 'scheduling' },
  'scheduling.grace_period_hour': { value: '10', category: 'scheduling' },
  'scheduling.max_onboarding_nudges': { value: '3', category: 'scheduling' },
  'scheduling.grace_period_days': { value: '3', category: 'scheduling' },
  'scheduling.trial_coupon_code': { value: 'ASTORIA7', category: 'scheduling' },
};

const PUBLIC_CATEGORIES = new Set(['contact', 'social', 'apple_messages', 'hours_display']);

router.get('/api/settings/public', async (req, res) => {
  try {
    const settings = await db.select().from(systemSettings);
    
    const settingsMap: Record<string, string> = {};
    
    for (const [key, defaultVal] of Object.entries(DEFAULT_SETTINGS)) {
      if (!PUBLIC_CATEGORIES.has(defaultVal.category)) continue;
      const existing = settings.find(s => s.key === key);
      settingsMap[key] = existing?.value ?? defaultVal.value;
    }
    
    res.json(settingsMap);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch public settings', error, 'PUBLIC_SETTINGS_FETCH_ERROR');
  }
});

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
    
    invalidateSettingsCache(key);
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
    
    invalidateSettingsCache();
    logFromRequest(req, 'update_settings_bulk', 'settings', '', 'bulk_update', { keys: Object.keys(settings) });
    res.json({ success: true, updated: results.length });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to update settings', error, 'SETTINGS_BULK_UPDATE_ERROR');
  }
});

export default router;
