import { Router } from 'express';
import { pool, queryWithRetry } from '../core/db';
import { logAndRespond, createErrorResponse } from '../core/logger';
import { isAuthenticated, isAdminEmail } from '../core/middleware';
import { getSessionUser } from '../types/session';

const router = Router();

function getSessionEmail(req: any): string | null {
  return getSessionUser(req)?.email?.toLowerCase() || null;
}

async function isAuthorizedForEmail(req: any, targetEmail: string): Promise<boolean> {
  const sessionEmail = getSessionEmail(req);
  if (!sessionEmail) return false;
  
  // User can access their own notifications
  if (sessionEmail === targetEmail.toLowerCase()) return true;
  
  // Staff/admins can view any user's notifications
  const isAdmin = await isAdminEmail(sessionEmail);
  if (isAdmin) return true;
  
  // Check if user is staff
  try {
    const result = await queryWithRetry(
      'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [sessionEmail]
    );
    if (result.rows.length > 0) return true;
  } catch (error) {
    // If staff check fails, fall back to owner-only access
  }
  
  return false;
}

router.get('/api/notifications', isAuthenticated, async (req, res) => {
  try {
    const { user_email: rawEmail, unread_only } = req.query;
    
    if (!rawEmail) {
      return res.status(400).json(createErrorResponse(req, 'user_email is required', 'MISSING_EMAIL'));
    }
    
    const user_email = decodeURIComponent(rawEmail as string);
    
    const authorized = await isAuthorizedForEmail(req, user_email);
    if (!authorized) {
      return res.status(403).json(createErrorResponse(req, 'You can only access your own notifications', 'FORBIDDEN'));
    }
    
    let query = 'SELECT * FROM notifications WHERE user_email = $1';
    const params: any[] = [user_email];
    
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
    
    if (!rawEmail) {
      return res.status(400).json(createErrorResponse(req, 'user_email is required', 'MISSING_EMAIL'));
    }
    
    const user_email = decodeURIComponent(rawEmail as string);
    
    const authorized = await isAuthorizedForEmail(req, user_email);
    if (!authorized) {
      return res.status(403).json(createErrorResponse(req, 'You can only access your own notifications', 'FORBIDDEN'));
    }
    
    const result = await queryWithRetry(
      'SELECT COUNT(*) as count FROM notifications WHERE user_email = $1 AND is_read = false',
      [user_email]
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
    
    if (!user_email) {
      return res.status(400).json(createErrorResponse(req, 'user_email is required', 'MISSING_EMAIL'));
    }
    
    const authorized = await isAuthorizedForEmail(req, user_email);
    if (!authorized) {
      return res.status(403).json(createErrorResponse(req, 'You can only modify your own notifications', 'FORBIDDEN'));
    }
    
    await pool.query(
      'UPDATE notifications SET is_read = true WHERE user_email = $1 AND is_read = false',
      [user_email]
    );
    
    res.json({ success: true });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to mark notifications as read', error, 'MARK_ALL_READ_ERROR');
  }
});

router.delete('/api/notifications/dismiss-all', isAuthenticated, async (req, res) => {
  try {
    const { user_email } = req.body;
    
    if (!user_email) {
      return res.status(400).json(createErrorResponse(req, 'user_email is required', 'MISSING_EMAIL'));
    }
    
    const authorized = await isAuthorizedForEmail(req, user_email);
    if (!authorized) {
      return res.status(403).json(createErrorResponse(req, 'You can only delete your own notifications', 'FORBIDDEN'));
    }
    
    const result = await pool.query(
      'DELETE FROM notifications WHERE user_email = $1',
      [user_email]
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
