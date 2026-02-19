import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../core/middleware';
import { logAndRespond, logger } from '../core/logger';
import { getSessionUser } from '../types/session';
import { processWalkInCheckin } from '../core/walkInCheckinService';
import { db } from '../db';
import { sql } from 'drizzle-orm';

const router = Router();

router.post('/api/member/nfc-checkin', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const memberEmail = sessionUser.email;

    const memberResult = await db.execute(sql`
      SELECT id, membership_status FROM users WHERE LOWER(email) = LOWER(${memberEmail}) LIMIT 1
    `);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member account not found' });
    }

    const member = memberResult.rows[0];
    const memberId = member.id.toString();

    const status = member.membership_status?.toLowerCase() || '';
    const blockedStatuses = ['cancelled', 'suspended', 'terminated', 'inactive'];
    if (blockedStatuses.includes(status)) {
      return res.status(403).json({ error: 'Your membership is not active. Please speak to staff.' });
    }

    const result = await processWalkInCheckin({
      memberId,
      checkedInBy: memberEmail,
      checkedInByName: sessionUser.name || null,
      source: 'nfc'
    });

    if (result.alreadyCheckedIn) {
      return res.status(409).json({ error: result.error, alreadyCheckedIn: true });
    }

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    logger.info('[NFC Checkin] Self check-in via NFC', { extra: { memberEmail, memberName: result.memberName, lifetimeVisits: result.lifetimeVisits } });

    res.json({
      success: true,
      memberName: result.memberName,
      tier: result.tier,
      lifetimeVisits: result.lifetimeVisits,
      membershipStatus: result.membershipStatus
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to process NFC check-in', error);
  }
});

export default router;
