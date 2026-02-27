import { Router } from 'express';
import { isProduction } from '../core/db';
import { isStaffOrAdmin } from '../core/middleware';
import { db } from '../db';
import { announcements } from '../../shared/schema';
import { eq, desc, sql, or, and, gte, lte, isNull, asc } from 'drizzle-orm';
import { formatDatePacific, createPacificDate, CLUB_TIMEZONE } from '../utils/dateUtils';
import { getSessionUser } from '../types/session';
import { sendPushNotificationToAllMembers } from './push';
import { broadcastAnnouncementUpdate } from '../core/websocket';
import { logFromRequest } from '../core/auditLog';
import { logger } from '../core/logger';
import {
  createAnnouncementSheet,
  getLinkedSheetId,
  getSheetUrl,
  syncFromSheet,
  syncToSheet,
  pushSingleAnnouncement,
  deleteFromSheet
} from '../core/googleSheets/announcementSync';
import { systemSettings } from '../../shared/models/system';
import { safeErrorDetail, getErrorMessage } from '../utils/errorUtils';

interface AnnouncementRow {
  id: number;
  title: string;
  message: string | null;
  priority: string | null;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  link_type: string | null;
  link_target: string | null;
  show_as_banner: boolean;
  created_by: string | null;
  created_at: string | null;
}

const router = Router();

const BANNER_FIRST = sql`CASE WHEN show_as_banner = true THEN 0 ELSE 1 END`;

router.get('/api/announcements', async (req, res) => {
  try {
    const { active_only } = req.query;
    const now = new Date();
    
    let query = db.select().from(announcements);
    
    if (active_only === 'true') {
      query = query.where(
        and(
          eq(announcements.isActive, true),
          or(
            isNull(announcements.startsAt),
            lte(announcements.startsAt, now)
          ),
          or(
            isNull(announcements.endsAt),
            gte(announcements.endsAt, now)
          )
        )
      ) as typeof query;
    }
    
    const results = await query.orderBy(asc(BANNER_FIRST), desc(announcements.createdAt)).limit(100);
    
    const formatted = results.map(a => ({
      id: a.id.toString(),
      title: a.title,
      desc: a.message || '',
      type: 'announcement' as const,
      priority: (a.priority || 'normal') as 'normal' | 'high' | 'urgent',
      date: a.createdAt ? new Date(a.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: CLUB_TIMEZONE }) : 'Just now',
      createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : new Date().toISOString(),
      startDate: a.startsAt ? formatDatePacific(new Date(a.startsAt)) : undefined,
      endDate: a.endsAt ? formatDatePacific(new Date(a.endsAt)) : undefined,
      linkType: a.linkType || undefined,
      linkTarget: a.linkTarget || undefined,
      showAsBanner: (a as unknown as { show_as_banner: boolean }).show_as_banner === true
    }));
    
    res.json(formatted);
  } catch (error: unknown) {
    logger.error('Announcements fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

router.get('/api/announcements/banner', async (req, res) => {
  try {
    const now = new Date();
    
    const results = await db.select().from(announcements)
      .where(
        and(
          eq(announcements.isActive, true),
          sql`show_as_banner = true`,
          or(
            isNull(announcements.startsAt),
            lte(announcements.startsAt, now)
          ),
          or(
            isNull(announcements.endsAt),
            gte(announcements.endsAt, now)
          )
        )
      )
      .orderBy(desc(announcements.createdAt))
      .limit(1);
    
    if (results.length === 0) {
      return res.json(null);
    }
    
    const a = results[0];
    res.json({
      id: a.id.toString(),
      title: a.title,
      desc: a.message || '',
      type: 'announcement' as const,
      priority: (a.priority || 'normal') as 'normal' | 'high' | 'urgent',
      date: a.createdAt ? new Date(a.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: CLUB_TIMEZONE }) : 'Just now',
      linkType: a.linkType || undefined,
      linkTarget: a.linkTarget || undefined,
      showAsBanner: true
    });
  } catch (error: unknown) {
    logger.error('Banner announcement fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch banner announcement' });
  }
});

router.get('/api/announcements/export', isStaffOrAdmin, async (req, res) => {
  try {
    // Fetch all announcements
    const results = await db.select().from(announcements).orderBy(desc(announcements.createdAt));
    
    // Helper function to escape CSV values
    const escapeCsv = (value: unknown): string => {
      if (value === null || value === undefined) {
        return '';
      }
      const str = String(value);
      return `"${str.replace(/"/g, '""')}"`;
    };
    
    // Build CSV headers
    const headers = ['ID', 'Title', 'Description', 'Priority', 'Active', 'Start Date', 'End Date', 'Link Type', 'Link Target', 'Banner', 'Created By', 'Created At'];
    
    // Build CSV rows
    const rows = results.map(a => {
      const showBanner = (a as unknown as { show_as_banner: boolean }).show_as_banner === true ? 'Yes' : 'No';
      return [
        a.id,
        escapeCsv(a.title),
        escapeCsv(a.message),
        escapeCsv(a.priority || 'normal'),
        a.isActive ? 'Yes' : 'No',
        escapeCsv(a.startsAt ? formatDatePacific(new Date(a.startsAt)) : ''),
        escapeCsv(a.endsAt ? formatDatePacific(new Date(a.endsAt)) : ''),
        escapeCsv(a.linkType || ''),
        escapeCsv(a.linkTarget || ''),
        showBanner,
        escapeCsv(a.createdBy || ''),
        escapeCsv(a.createdAt ? formatDatePacific(new Date(a.createdAt)) : '')
      ].join(',');
    });
    
    // Combine headers and rows
    const csv = [headers.join(','), ...rows].join('\n');
    
    // Set response headers for file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="announcements_export.csv"');
    
    // Log audit trail
    logFromRequest(req, 'export_announcements', 'announcement', undefined, 'Announcements Export', {
      totalRecords: results.length
    });
    
    res.send(csv);
  } catch (error: unknown) {
    logger.error('Announcements export error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to export announcements' });
  }
});

router.post('/api/announcements', isStaffOrAdmin, async (req, res) => {
  try {
    const { title, description, startDate, endDate, linkType, linkTarget, notifyMembers, showAsBanner } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const userEmail = getSessionUser(req)?.email || 'system';
    
    if (showAsBanner) {
      await db.execute(sql`UPDATE announcements SET show_as_banner = false WHERE show_as_banner = true`);
    }
    
    const result = await db.execute(sql`
      INSERT INTO announcements (title, message, priority, starts_at, ends_at, link_type, link_target, created_by, show_as_banner, is_active)
      VALUES (
        ${title},
        ${description || ''},
        'normal',
        ${startDate ? createPacificDate(startDate, '00:00:00') : null},
        ${endDate ? createPacificDate(endDate, '23:59:59') : null},
        ${linkType || null},
        ${linkTarget || null},
        ${userEmail},
        ${showAsBanner || false},
        true
      )
      RETURNING *
    `);
    const resultRows = result.rows as unknown as AnnouncementRow[];
    const newAnnouncement = resultRows[0];
    
    const responseData = {
      id: newAnnouncement.id.toString(),
      title: newAnnouncement.title,
      desc: newAnnouncement.message || '',
      type: 'announcement' as const,
      priority: (newAnnouncement.priority || 'normal') as 'normal' | 'high' | 'urgent',
      date: 'Just now',
      createdAt: newAnnouncement.created_at ? new Date(newAnnouncement.created_at).toISOString() : new Date().toISOString(),
      startDate: newAnnouncement.starts_at ? formatDatePacific(new Date(newAnnouncement.starts_at)) : undefined,
      endDate: newAnnouncement.ends_at ? formatDatePacific(new Date(newAnnouncement.ends_at)) : undefined,
      linkType: newAnnouncement.link_type || undefined,
      linkTarget: newAnnouncement.link_target || undefined,
      showAsBanner: newAnnouncement.show_as_banner || false
    };
    
    // Broadcast real-time update to all connected clients
    broadcastAnnouncementUpdate('created', responseData);
    
    // Log audit trail
    logFromRequest(req, 'create_announcement', 'announcement', String(newAnnouncement.id), title, {
      message: description,
      priority: 'normal',
      startsAt: startDate,
      endsAt: endDate,
      linkType,
      linkTarget,
      showAsBanner
    });
    
    if (notifyMembers) {
      try {
        await sendPushNotificationToAllMembers({
          title: title,
          body: description || title,
          url: '/updates?tab=announcements',
          tag: `announcement-${String(newAnnouncement.id)}`
        });
      } catch (pushErr: unknown) {
        logger.error('Failed to send push notifications for announcement', { extra: { error: getErrorMessage(pushErr) } });
      }
    }
    
    getLinkedSheetId().then(sheetId => {
      if (sheetId) {
        pushSingleAnnouncement(sheetId, newAnnouncement as unknown as Record<string, unknown>).catch(err => {
          logger.error('Failed to sync new announcement to Google Sheet', { extra: { error: getErrorMessage(err) } });
        });
      }
    }).catch(err => logger.error('[Announcements] Sheet sync error', { extra: { error: getErrorMessage(err) } }));

    res.status(201).json(responseData);
  } catch (error: unknown) {
    logger.error('Announcement create error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

router.put('/api/announcements/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, startDate, endDate, linkType, linkTarget, notifyMembers, showAsBanner } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    if (showAsBanner) {
      await db.execute(sql`UPDATE announcements SET show_as_banner = false WHERE show_as_banner = true AND id != ${parseInt(id as string)}`);
    }
    
    const results = await db.execute(sql`
      UPDATE announcements
      SET title = ${title},
          message = ${description || ''},
          starts_at = ${startDate ? createPacificDate(startDate, '00:00:00') : null},
          ends_at = ${endDate ? createPacificDate(endDate, '23:59:59') : null},
          link_type = ${linkType || null},
          link_target = ${linkTarget || null},
          show_as_banner = ${showAsBanner || false}
      WHERE id = ${parseInt(id as string)}
      RETURNING *
    `);
    
    const resultsRows = results.rows as unknown as AnnouncementRow[];
    const updated = resultsRows[0];
    
    if (!updated) {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    
    const responseData = {
      id: updated.id.toString(),
      title: updated.title,
      desc: updated.message || '',
      type: 'announcement' as const,
      priority: (updated.priority || 'normal') as 'normal' | 'high' | 'urgent',
      date: updated.created_at ? new Date(updated.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: CLUB_TIMEZONE }) : 'Just now',
      createdAt: updated.created_at ? new Date(updated.created_at).toISOString() : new Date().toISOString(),
      startDate: updated.starts_at ? formatDatePacific(new Date(updated.starts_at)) : undefined,
      endDate: updated.ends_at ? formatDatePacific(new Date(updated.ends_at)) : undefined,
      linkType: updated.link_type || undefined,
      linkTarget: updated.link_target || undefined,
      showAsBanner: updated.show_as_banner || false
    };
    
    // Broadcast real-time update to all connected clients
    broadcastAnnouncementUpdate('updated', responseData);
    
    // Log audit trail
    logFromRequest(req, 'update_announcement', 'announcement', String(updated.id), title, {
      message: description,
      priority: updated.priority || 'normal',
      startsAt: startDate,
      endsAt: endDate,
      linkType,
      linkTarget,
      showAsBanner
    });
    
    if (notifyMembers) {
      try {
        await sendPushNotificationToAllMembers({
          title: title,
          body: description || title,
          url: '/updates?tab=announcements',
          tag: `announcement-${String(updated.id)}`
        });
      } catch (pushErr: unknown) {
        logger.error('Failed to send push notifications for announcement', { extra: { error: getErrorMessage(pushErr) } });
      }
    }
    
    getLinkedSheetId().then(sheetId => {
      if (sheetId) {
        pushSingleAnnouncement(sheetId, updated as unknown as Record<string, unknown>).catch(err => {
          logger.error('Failed to sync updated announcement to Google Sheet', { extra: { error: getErrorMessage(err) } });
        });
      }
    }).catch(err => logger.error('[Announcements] Sheet sync error', { extra: { error: getErrorMessage(err) } }));

    res.json(responseData);
  } catch (error: unknown) {
    logger.error('Announcement update error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

router.delete('/api/announcements/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [deleted] = await db.delete(announcements)
      .where(eq(announcements.id, parseInt(id as string)))
      .returning();
    
    if (!deleted) {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    
    // Broadcast real-time update to all connected clients
    broadcastAnnouncementUpdate('deleted', { id });
    
    // Log audit trail
    logFromRequest(req, 'delete_announcement', 'announcement', deleted.id.toString(), deleted.title, {
      message: deleted.message
    });
    
    getLinkedSheetId().then(sheetId => {
      if (sheetId) {
        deleteFromSheet(sheetId, id as string).catch(err => {
          logger.error('Failed to delete announcement from Google Sheet', { extra: { error: getErrorMessage(err) } });
        });
      }
    }).catch(err => logger.error('[Announcements] Sheet sync error', { extra: { error: getErrorMessage(err) } }));

    res.json({ success: true, id });
  } catch (error: unknown) {
    logger.error('Announcement delete error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

router.post('/api/announcements/sheets/connect', isStaffOrAdmin, async (req, res) => {
  try {
    const sheetId = await createAnnouncementSheet();
    const sheetUrl = getSheetUrl(sheetId);

    logFromRequest(req, 'update_settings', 'announcement', undefined, 'Google Sheets Connect', {
      sheetId,
      sheetUrl
    });

    res.json({ sheetId, sheetUrl });
  } catch (error: unknown) {
    logger.error('Google Sheets connect error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to connect Google Sheets' });
  }
});

router.get('/api/announcements/sheets/status', isStaffOrAdmin, async (req, res) => {
  try {
    const sheetId = await getLinkedSheetId();
    res.json({
      connected: !!sheetId,
      sheetId: sheetId || null,
      sheetUrl: sheetId ? getSheetUrl(sheetId) : null
    });
  } catch (error: unknown) {
    logger.error('Google Sheets status error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get Google Sheets status' });
  }
});

router.post('/api/announcements/sheets/sync-from', isStaffOrAdmin, async (req, res) => {
  try {
    const sheetId = await getLinkedSheetId();
    if (!sheetId) {
      return res.status(400).json({ error: 'No Google Sheet connected' });
    }

    const result = await syncFromSheet(sheetId);

    broadcastAnnouncementUpdate('updated', { action: 'bulk_sync' });

    logFromRequest(req, 'update_settings', 'announcement', undefined, 'Google Sheets Sync From', {
      created: result.created,
      updated: result.updated,
      errors: result.errors
    });

    res.json(result);
  } catch (error: unknown) {
    logger.error('Google Sheets sync-from error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync from Google Sheets' });
  }
});

router.post('/api/announcements/sheets/sync-to', isStaffOrAdmin, async (req, res) => {
  try {
    const sheetId = await getLinkedSheetId();
    if (!sheetId) {
      return res.status(400).json({ error: 'No Google Sheet connected' });
    }

    const result = await syncToSheet(sheetId);

    logFromRequest(req, 'update_settings', 'announcement', undefined, 'Google Sheets Sync To', {
      pushed: result.pushed
    });

    res.json(result);
  } catch (error: unknown) {
    logger.error('Google Sheets sync-to error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync to Google Sheets' });
  }
});

router.post('/api/announcements/sheets/disconnect', isStaffOrAdmin, async (req, res) => {
  try {
    await db.delete(systemSettings)
      .where(eq(systemSettings.key, 'announcements_google_sheet_id'));

    logFromRequest(req, 'update_settings', 'announcement', undefined, 'Google Sheets Disconnect', {});

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Google Sheets disconnect error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to disconnect Google Sheets' });
  }
});

export default router;
