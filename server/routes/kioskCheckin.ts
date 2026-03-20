import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { isStaffOrAdmin } from '../core/middleware';
import { logAndRespond, logger } from '../core/logger';
import { getSessionUser } from '../types/session';
import { processWalkInCheckin } from '../core/walkInCheckinService';
import { checkinBooking } from '../core/bookingService/approvalCheckin';
import { logFromRequest } from '../core/auditLog';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../utils/errorUtils';
import { getSettingValue } from '../core/settingsHelper';
import { validateBody } from '../middleware/validate';

const kioskCheckinSchema = z.object({
  memberId: z.string().min(1, 'Member ID is required'),
});

const kioskPasscodeSchema = z.object({
  passcode: z.string().min(1, 'Passcode is required'),
});

const router = Router();

router.post('/api/kiosk/checkin', isStaffOrAdmin, validateBody(kioskCheckinSchema), async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { memberId } = req.body;

    const memberResult = await db.execute(sql`
      SELECT id, email, first_name, last_name, membership_status, tier, lifetime_visits
      FROM users WHERE id = ${memberId} LIMIT 1
    `);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found. Please ask staff for help.' });
    }

    const member = memberResult.rows[0] as {
      id: string;
      email: string;
      first_name: string | null;
      last_name: string | null;
      membership_status: string | null;
      tier: string | null;
      lifetime_visits: number | null;
    };
    const memberEmail = member.email;
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || memberEmail?.split('@')[0] || '';
    const status = String(member.membership_status || '').toLowerCase();
    const blockedStatuses = ['cancelled', 'suspended', 'terminated', 'inactive', 'archived'];
    if (blockedStatuses.includes(status)) {
      return res.status(403).json({ error: 'Membership is not active. Please speak to staff.' });
    }

    interface UpcomingBookingRow {
      booking_id: number;
      session_id: number | null;
      start_time: string;
      end_time: string;
      declared_player_count: number;
      owner_email: string;
      resource_name: string;
      resource_type: string;
      owner_name: string | null;
      unpaid_fee_cents: number;
    }

    let upcomingBooking: UpcomingBookingRow | null = null;
    try {
      const bookingResult = await db.execute(sql`
        SELECT 
          br.id as booking_id,
          br.session_id,
          br.start_time::text,
          br.end_time::text,
          br.declared_player_count,
          br.user_email as owner_email,
          r.name as resource_name,
          r.type as resource_type,
          COALESCE(
            NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
            br.user_name,
            br.user_email
          ) as owner_name,
          COALESCE(
            (SELECT SUM(bfs.cached_fee_cents)
             FROM booking_fee_snapshots bfs
             WHERE bfs.booking_id = br.id
               AND bfs.payment_status NOT IN ('paid', 'waived', 'cancelled')),
            0
          )::int as unpaid_fee_cents
        FROM booking_requests br
        JOIN resources r ON br.resource_id = r.id
        LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
        WHERE br.request_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND br.status IN ('confirmed', 'approved')
          AND br.end_time > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::time
          AND (
            LOWER(br.user_email) = LOWER(${memberEmail})
            OR br.user_id = ${String(member.id)}
            OR br.session_id IN (
              SELECT bp.session_id FROM booking_participants bp
              WHERE bp.user_id = ${String(member.id)}
            )
          )
        ORDER BY br.start_time ASC
        LIMIT 1
      `);

      if (bookingResult.rows.length > 0) {
        upcomingBooking = bookingResult.rows[0] as unknown as UpcomingBookingRow;
      }
    } catch (bookingErr: unknown) {
      logger.warn('[Kiosk] Failed to fetch upcoming booking for member', {
        error: bookingErr instanceof Error ? bookingErr : new Error(getErrorMessage(bookingErr))
      });
    }

    if (upcomingBooking) {
      const bookingId = Number(upcomingBooking.booking_id);

      const checkinResult = await checkinBooking({
        bookingId,
        targetStatus: 'attended',
        skipPaymentCheck: true,
        skipRosterCheck: true,
        staffEmail: `kiosk:${sessionUser.email}`,
        staffName: 'Kiosk Self-Service',
      });

      if (checkinResult.alreadyProcessed) {
        return res.status(409).json({
          error: 'Already checked in',
          alreadyCheckedIn: true,
          memberName,
          tier: member.tier
        });
      }

      if (checkinResult.error && !checkinResult.success) {
        logger.warn('[Kiosk] Booking check-in failed, falling back to walk-in', {
          extra: { bookingId, error: checkinResult.error, memberId: member.id }
        });
      } else {
        const freshVisits = await db.execute(sql`
          SELECT lifetime_visits FROM users WHERE id = ${member.id} LIMIT 1
        `);
        const lifetimeVisits = (freshVisits.rows[0] as { lifetime_visits: number | null })?.lifetime_visits || (member.lifetime_visits || 0);

        logFromRequest(req, 'kiosk_checkin', 'member', String(member.id), memberName, {
          memberEmail,
          tier: member.tier,
          lifetimeVisits,
          type: 'booking',
          bookingId,
          source: 'kiosk_qr',
          staffEmail: sessionUser.email
        });

        logger.info('[Kiosk] Booking check-in via kiosk QR scan', {
          extra: { memberEmail, memberName, bookingId, lifetimeVisits, staffEmail: sessionUser.email }
        });

        return res.json({
          success: true,
          memberName,
          tier: member.tier,
          lifetimeVisits,
          membershipStatus: member.membership_status,
          upcomingBooking: {
            bookingId,
            sessionId: upcomingBooking.session_id ? Number(upcomingBooking.session_id) : null,
            startTime: String(upcomingBooking.start_time),
            endTime: String(upcomingBooking.end_time),
            resourceName: String(upcomingBooking.resource_name),
            resourceType: String(upcomingBooking.resource_type),
            declaredPlayerCount: Number(upcomingBooking.declared_player_count || 1),
            ownerEmail: String(upcomingBooking.owner_email),
            ownerName: String(upcomingBooking.owner_name || ''),
            unpaidFeeCents: Number(upcomingBooking.unpaid_fee_cents || 0)
          }
        });
      }
    }

    const walkInResult = await processWalkInCheckin({
      memberId: String(member.id),
      checkedInBy: `kiosk:${sessionUser.email}`,
      checkedInByName: 'Kiosk Self-Service',
      source: 'kiosk'
    });

    if (walkInResult.alreadyCheckedIn) {
      return res.status(409).json({
        error: 'Already checked in',
        alreadyCheckedIn: true,
        memberName: walkInResult.memberName,
        tier: walkInResult.tier
      });
    }

    if (!walkInResult.success) {
      return res.status(500).json({ error: walkInResult.error });
    }

    logFromRequest(req, 'kiosk_checkin', 'member', String(member.id), walkInResult.memberName, {
      memberEmail: walkInResult.memberEmail,
      tier: walkInResult.tier,
      lifetimeVisits: walkInResult.lifetimeVisits,
      type: 'walk_in',
      source: 'kiosk_qr',
      staffEmail: sessionUser.email
    });

    logger.info('[Kiosk] Walk-in check-in via kiosk QR scan', {
      extra: {
        memberEmail: walkInResult.memberEmail,
        memberName: walkInResult.memberName,
        lifetimeVisits: walkInResult.lifetimeVisits,
        staffEmail: sessionUser.email
      }
    });

    res.json({
      success: true,
      memberName: walkInResult.memberName,
      tier: walkInResult.tier,
      lifetimeVisits: walkInResult.lifetimeVisits,
      membershipStatus: walkInResult.membershipStatus,
      upcomingBooking: null
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to process kiosk check-in', error);
  }
});

router.get('/api/kiosk/verify-staff', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ authenticated: false });
    }
    res.json({ authenticated: true, staffName: sessionUser.name || sessionUser.email });
  } catch (error: unknown) {
    res.status(500).json({ authenticated: false, error: getErrorMessage(error) });
  }
});

const passcodeAttempts = new Map<string, { count: number; lastAttempt: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of passcodeAttempts) {
    if (now - record.lastAttempt > LOCKOUT_MS * 5) {
      passcodeAttempts.delete(key);
    }
  }
}, LOCKOUT_MS * 5);

router.post('/api/kiosk/verify-passcode', isStaffOrAdmin, validateBody(kioskPasscodeSchema), async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const key = sessionUser?.email || req.ip || 'unknown';

    const record = passcodeAttempts.get(key);
    if (record && record.count >= MAX_ATTEMPTS) {
      const elapsed = Date.now() - record.lastAttempt;
      if (elapsed < LOCKOUT_MS) {
        return res.status(429).json({ valid: false, error: 'Too many attempts. Please wait 1 minute.' });
      }
      passcodeAttempts.delete(key);
    }

    const { passcode } = req.body;

    const storedPasscode = await getSettingValue('kiosk.exit_passcode');
    if (!storedPasscode) {
      logger.error('[Kiosk] No exit passcode configured in system settings');
      return res.status(503).json({ valid: false, error: 'Kiosk exit passcode not configured. Contact an administrator.' });
    }
    if (passcode === storedPasscode) {
      passcodeAttempts.delete(key);
      return res.json({ valid: true });
    }

    const current = passcodeAttempts.get(key) || { count: 0, lastAttempt: 0 };
    current.count += 1;
    current.lastAttempt = Date.now();
    passcodeAttempts.set(key, current);

    logger.warn('[Kiosk] Failed passcode attempt', { extra: { email: key, attempts: current.count } });
    return res.status(401).json({ valid: false, error: 'Invalid passcode' });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to verify kiosk passcode', error);
  }
});

export default router;
