import { Router } from 'express';
import { isAuthenticated } from '../core/middleware';
import { db } from '../db';
import { userDismissedNotices } from '../../shared/schema';
import { eq, and } from 'drizzle-orm';
import { logAndRespond } from '../core/logger';
import { getSessionUser } from '../types/session';

const router = Router();

router.get('/api/notices/dismissed', isAuthenticated, async (req, res) => {
  try {
    const userEmail = getSessionUser(req)?.email;
    if (!userEmail) {
      return res.status(401).json({ error: 'User email not found' });
    }

    const dismissed = await db
      .select({
        noticeType: userDismissedNotices.noticeType,
        noticeId: userDismissedNotices.noticeId
      })
      .from(userDismissedNotices)
      .where(eq(userDismissedNotices.userEmail, userEmail));

    res.json(dismissed);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch dismissed notices', error, 'NOTICES_FETCH_ERROR');
  }
});

router.post('/api/notices/dismiss', isAuthenticated, async (req, res) => {
  try {
    const userEmail = getSessionUser(req)?.email;
    if (!userEmail) {
      return res.status(401).json({ error: 'User email not found' });
    }

    const { noticeType, noticeId } = req.body;

    if (!noticeType || noticeId === undefined) {
      return res.status(400).json({ error: 'noticeType and noticeId are required' });
    }

    if (!['announcement', 'closure'].includes(noticeType)) {
      return res.status(400).json({ error: 'Invalid notice type' });
    }

    const parsedNoticeId = parseInt(noticeId, 10);
    if (!Number.isFinite(parsedNoticeId) || parsedNoticeId < 0) {
      return res.status(400).json({ error: 'Invalid noticeId' });
    }

    await db
      .insert(userDismissedNotices)
      .values({
        userEmail,
        noticeType,
        noticeId: parsedNoticeId
      })
      .onConflictDoNothing();

    res.json({ success: true });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to dismiss notice', error, 'NOTICE_DISMISS_ERROR');
  }
});

router.post('/api/notices/dismiss-all', isAuthenticated, async (req, res) => {
  try {
    const userEmail = getSessionUser(req)?.email;
    if (!userEmail) {
      return res.status(401).json({ error: 'User email not found' });
    }

    const { notices } = req.body;

    if (!Array.isArray(notices) || notices.length === 0) {
      return res.status(400).json({ error: 'notices array is required' });
    }

    for (const notice of notices) {
      if (!['announcement', 'closure'].includes(notice.noticeType)) continue;
      
      const parsedNoticeId = parseInt(notice.noticeId, 10);
      if (!Number.isFinite(parsedNoticeId) || parsedNoticeId < 0) continue;
      
      await db
        .insert(userDismissedNotices)
        .values({
          userEmail,
          noticeType: notice.noticeType,
          noticeId: parsedNoticeId
        })
        .onConflictDoNothing();
    }

    res.json({ success: true });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to dismiss all notices', error, 'NOTICES_DISMISS_ALL_ERROR');
  }
});

export default router;
