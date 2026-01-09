import { Router } from 'express';
import { isProduction } from '../core/db';
import { isStaffOrAdmin } from '../core/middleware';
import { db } from '../db';
import { announcements } from '../../shared/schema';
import { eq, desc, sql, or, and, gte, lte, isNull, asc } from 'drizzle-orm';
import { formatDatePacific, createPacificDate, CLUB_TIMEZONE } from '../utils/dateUtils';
import { getSessionUser } from '../types/session';
import { sendPushNotificationToAllMembers } from './push';

const router = Router();

const PRIORITY_ORDER = sql`CASE 
  WHEN ${announcements.priority} = 'urgent' THEN 1 
  WHEN ${announcements.priority} = 'high' THEN 2 
  ELSE 3 
END`;

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
    
    const results = await query.orderBy(asc(PRIORITY_ORDER), desc(announcements.createdAt));
    
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
      showAsBanner: (a as any).show_as_banner || false
    }));
    
    res.json(formatted);
  } catch (error: any) {
    if (!isProduction) console.error('Announcements fetch error:', error);
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
      .orderBy(asc(PRIORITY_ORDER), desc(announcements.createdAt))
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
  } catch (error: any) {
    if (!isProduction) console.error('Banner announcement fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch banner announcement' });
  }
});

router.post('/api/announcements', isStaffOrAdmin, async (req, res) => {
  try {
    const { title, description, type, priority, startDate, endDate, linkType, linkTarget, notifyMembers, showAsBanner } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const userEmail = getSessionUser(req)?.email || 'system';
    const finalPriority = priority || 'normal';
    
    if (showAsBanner) {
      await db.execute(sql`UPDATE announcements SET show_as_banner = false WHERE show_as_banner = true`);
    }
    
    const result = await db.execute(sql`
      INSERT INTO announcements (title, message, priority, starts_at, ends_at, link_type, link_target, created_by, show_as_banner, is_active)
      VALUES (
        ${title},
        ${description || ''},
        ${finalPriority},
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
    const newAnnouncement = (result as any).rows?.[0] || (result as any)[0];
    
    if (notifyMembers) {
      try {
        await sendPushNotificationToAllMembers({
          title: title,
          body: description || title,
          url: '/updates?tab=announcements',
          tag: `announcement-${newAnnouncement.id}`
        });
      } catch (pushErr: any) {
        console.error('Failed to send push notifications for announcement:', pushErr.message);
      }
    }
    
    res.status(201).json({
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
    });
  } catch (error: any) {
    if (!isProduction) console.error('Announcement create error:', error);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

router.put('/api/announcements/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, type, priority, startDate, endDate, linkType, linkTarget, notifyMembers, showAsBanner } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const finalPriority = priority || 'normal';
    
    if (showAsBanner) {
      await db.execute(sql`UPDATE announcements SET show_as_banner = false WHERE show_as_banner = true AND id != ${parseInt(id)}`);
    }
    
    const results = await db.execute(sql`
      UPDATE announcements
      SET title = ${title},
          message = ${description || ''},
          priority = ${finalPriority},
          starts_at = ${startDate ? createPacificDate(startDate, '00:00:00') : null},
          ends_at = ${endDate ? createPacificDate(endDate, '23:59:59') : null},
          link_type = ${linkType || null},
          link_target = ${linkTarget || null},
          show_as_banner = ${showAsBanner || false}
      WHERE id = ${parseInt(id)}
      RETURNING *
    `);
    
    const updated = (results as any).rows?.[0] || (results as any)[0];
    
    if (!updated) {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    
    if (notifyMembers) {
      try {
        await sendPushNotificationToAllMembers({
          title: title,
          body: description || title,
          url: '/updates?tab=announcements',
          tag: `announcement-${updated.id}`
        });
      } catch (pushErr: any) {
        console.error('Failed to send push notifications for announcement:', pushErr.message);
      }
    }
    
    res.json({
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
    });
  } catch (error: any) {
    if (!isProduction) console.error('Announcement update error:', error);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

router.delete('/api/announcements/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [deleted] = await db.delete(announcements)
      .where(eq(announcements.id, parseInt(id)))
      .returning();
    
    if (!deleted) {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    
    res.json({ success: true, id });
  } catch (error: any) {
    if (!isProduction) console.error('Announcement delete error:', error);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

export default router;
