import { Router } from 'express';
import { pool, queryWithRetry } from '../core/db';
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
    
    const result = await queryWithRetry(
      'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email]
    );
    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}

async function getEffectiveEmail(req: any, requestedEmail?: string): Promise<{ email: string; isStaff: boolean } | null> {
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
    const effective = await getEffectiveEmail(req, requestedEmail);
    
    if (!effective) {
      return res.status(401).json(createErrorResponse(req, 'Authentication required', 'UNAUTHORIZED'));
    }
    
    let query = 'SELECT * FROM notifications WHERE LOWER(user_email) = LOWER($1)';
    const params: any[] = [effective.email];
    
    if (unread_only === 'true') {
      query += ' AND is_read = false';
    }
    
    query += ' ORDER BY created_at DESC LIMIT 50';
    
    const result = await queryWithRetry(query, params);
    res.json(result.rows);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch notifications', error, 'NOTIFICATIONS_FETCH_ERROR');
  }
});

router.get('/api/notifications/count', isAuthenticated, async (req, res) => {
  try {
    const { user_email: rawEmail } = req.query;
    
    const requestedEmail = rawEmail ? decodeURIComponent(rawEmail as string) : undefined;
    const effective = await getEffectiveEmail(req, requestedEmail);
    
    if (!effective) {
      return res.status(401).json(createErrorResponse(req, 'Authentication required', 'UNAUTHORIZED'));
    }
    
    const result = await queryWithRetry(
      'SELECT COUNT(*) as count FROM notifications WHERE LOWER(user_email) = LOWER($1) AND is_read = false',
      [effective.email]
    );
    
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch notification count', error, 'NOTIFICATION_COUNT_ERROR');
  }
});

router.put('/api/notifications/:id/read', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const sessionEmail = getSessionEmail(req);
    
    const result = await pool.query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND LOWER(user_email) = $2 RETURNING *',
      [id, sessionEmail]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json(createErrorResponse(req, 'Notification not found or access denied', 'NOT_FOUND'));
    }
    
    res.json(result.rows[0]);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to update notification', error, 'NOTIFICATION_UPDATE_ERROR');
  }
});

router.put('/api/notifications/mark-all-read', isAuthenticated, async (req, res) => {
  try {
    const { user_email } = req.body;
    
    const effective = await getEffectiveEmail(req, user_email);
    
    if (!effective) {
      return res.status(401).json(createErrorResponse(req, 'Authentication required', 'UNAUTHORIZED'));
    }
    
    await pool.query(
      'UPDATE notifications SET is_read = true WHERE LOWER(user_email) = LOWER($1) AND is_read = false',
      [effective.email]
    );
    
    res.json({ success: true });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to mark notifications as read', error, 'MARK_ALL_READ_ERROR');
  }
});

router.delete('/api/notifications/dismiss-all', isAuthenticated, async (req, res) => {
  try {
    const { user_email } = req.body;
    
    const effective = await getEffectiveEmail(req, user_email);
    
    if (!effective) {
      return res.status(401).json(createErrorResponse(req, 'Authentication required', 'UNAUTHORIZED'));
    }
    
    const result = await pool.query(
      'DELETE FROM notifications WHERE LOWER(user_email) = LOWER($1)',
      [effective.email]
    );
    
    res.json({ success: true, deletedCount: result.rowCount });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to dismiss all notifications', error, 'DISMISS_ALL_ERROR');
  }
});

router.delete('/api/notifications/:id', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const sessionEmail = getSessionEmail(req);
    
    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND LOWER(user_email) = $2 RETURNING id',
      [id, sessionEmail]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json(createErrorResponse(req, 'Notification not found or access denied', 'NOT_FOUND'));
    }
    
    res.json({ success: true, deletedId: parseInt(id) });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to delete notification', error, 'NOTIFICATION_DELETE_ERROR');
  }
});

export default router;
