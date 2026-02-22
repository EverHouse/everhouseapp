import { Router } from 'express';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logAndRespond, createErrorResponse } from '../core/logger';
import { isAuthenticated, isAdminEmail } from '../core/middleware';
import { getSessionUser } from '../types/session';

const router = Router();

function getSessionEmail(req: any): string | null {
  return getSessionUser(req)?.email?.toLowerCase() || null;
}

async function isStaffUser(email: string): Promise<boolean> {
  try {
    const isAdmin = await isAdminEmail(email);
    if (isAdmin) return true;
    
    const result = await db.execute(
      sql`SELECT id FROM staff_users WHERE LOWER(email) = LOWER(${email}) AND is_active = true`
    );
    return result.rows.length > 0;
  } catch (error: unknown) {
    return false;
  }
}

async function getEffectiveEmail(req: Request, requestedEmail?: string): Promise<{ email: string; isStaff: boolean } | null> {
  const sessionEmail = getSessionEmail(req);
  if (!sessionEmail) return null;
  
  const isStaff = await isStaffUser(sessionEmail);
  
  if (isStaff && requestedEmail) {
    return { email: requestedEmail.toLowerCase(), isStaff: true };
  }
  
  return { email: sessionEmail, isStaff };
}

router.get('/api/notifications', isAuthenticated, async (req, res) => {
  try {
    const { user_email: rawEmail, unread_only } = req.query;
    
    const requestedEmail = rawEmail ? decodeURIComponent(rawEmail as string) : undefined;
    const effective = await getEffectiveEmail(req as any, requestedEmail);
    
    if (!effective) {
      return res.status(401).json(createErrorResponse(req, 'Authentication required', 'UNAUTHORIZED'));
    }
    
    const result = unread_only === 'true'
      ? await db.execute(sql`SELECT * FROM notifications WHERE LOWER(user_email) = LOWER(${effective.email}) AND is_read = false ORDER BY created_at DESC LIMIT 50`)
      : await db.execute(sql`SELECT * FROM notifications WHERE LOWER(user_email) = LOWER(${effective.email}) ORDER BY created_at DESC LIMIT 50`);
    
    // Convert timestamps to proper ISO format for UTC interpretation
    // Database stores 'timestamp without time zone' in UTC, but pg driver returns it without 'Z' suffix
    const notifications = result.rows.map((row: Record<string, unknown>) => {
      if (!row.created_at) return row;
      
      const createdAtStr = String(row.created_at);
      // If already has timezone info (ISO format with Z or offset), use as-is
      if (createdAtStr.includes('Z') || /[+-]\d{2}:\d{2}$/.test(createdAtStr)) {
        return { ...row, created_at: new Date(createdAtStr).toISOString() };
      }
      // Otherwise, assume UTC and append 'Z' before parsing
      return { ...row, created_at: new Date(createdAtStr + 'Z').toISOString() };
    });
    
    res.json(notifications);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch notifications', error, 'NOTIFICATIONS_FETCH_ERROR');
  }
});

router.get('/api/notifications/count', isAuthenticated, async (req, res) => {
  try {
    const { user_email: rawEmail } = req.query;
    
    const requestedEmail = rawEmail ? decodeURIComponent(rawEmail as string) : undefined;
    const effective = await getEffectiveEmail(req as any, requestedEmail);
    
    if (!effective) {
      return res.status(401).json(createErrorResponse(req, 'Authentication required', 'UNAUTHORIZED'));
    }
    
    const result = await db.execute(
      sql`SELECT COUNT(*) as count FROM notifications WHERE LOWER(user_email) = LOWER(${effective.email}) AND is_read = false`
    );
    
    res.json({ count: parseInt(result.rows[0].count as string) });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch notification count', error, 'NOTIFICATION_COUNT_ERROR');
  }
});

router.put('/api/notifications/:id/read', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const user_email = req.body?.user_email;
    
    const effective = await getEffectiveEmail(req as any, user_email);
    
    if (!effective) {
      return res.status(401).json(createErrorResponse(req, 'Authentication required', 'UNAUTHORIZED'));
    }
    
    const result = await db.execute(
      sql`UPDATE notifications SET is_read = true WHERE id = ${id} AND LOWER(user_email) = LOWER(${effective.email}) RETURNING *`
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json(createErrorResponse(req, 'Notification not found or access denied', 'NOT_FOUND'));
    }
    
    res.json(result.rows[0]);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to update notification', error, 'NOTIFICATION_UPDATE_ERROR');
  }
});

router.put('/api/notifications/mark-all-read', isAuthenticated, async (req, res) => {
  try {
    const { user_email } = req.body;
    
    const effective = await getEffectiveEmail(req as any, user_email);
    
    if (!effective) {
      return res.status(401).json(createErrorResponse(req, 'Authentication required', 'UNAUTHORIZED'));
    }
    
    await db.execute(
      sql`UPDATE notifications SET is_read = true WHERE LOWER(user_email) = LOWER(${effective.email}) AND is_read = false`
    );
    
    res.json({ success: true });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to mark notifications as read', error, 'MARK_ALL_READ_ERROR');
  }
});

router.delete('/api/notifications/dismiss-all', isAuthenticated, async (req, res) => {
  try {
    const { user_email } = req.body;
    
    const effective = await getEffectiveEmail(req as any, user_email);
    
    if (!effective) {
      return res.status(401).json(createErrorResponse(req, 'Authentication required', 'UNAUTHORIZED'));
    }
    
    const result = await db.execute(
      sql`DELETE FROM notifications WHERE LOWER(user_email) = LOWER(${effective.email})`
    );
    
    res.json({ success: true, deletedCount: result.rowCount });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to dismiss all notifications', error, 'DISMISS_ALL_ERROR');
  }
});

router.delete('/api/notifications/:id', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const { user_email } = req.body;
    
    // Allow staff to delete notifications for any user (consistent with dismiss-all)
    const effective = await getEffectiveEmail(req as any, user_email);
    
    if (!effective) {
      return res.status(401).json(createErrorResponse(req, 'Authentication required', 'UNAUTHORIZED'));
    }
    
    const result = await db.execute(
      sql`DELETE FROM notifications WHERE id = ${id} AND LOWER(user_email) = LOWER(${effective.email}) RETURNING id`
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json(createErrorResponse(req, 'Notification not found or access denied', 'NOT_FOUND'));
    }
    
    res.json({ success: true, deletedId: parseInt(id as string) });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to delete notification', error, 'NOTIFICATION_DELETE_ERROR');
  }
});

export default router;
