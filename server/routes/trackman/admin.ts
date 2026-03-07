import { logger } from '../../core/logger';
import { Router } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { pool, safeRelease } from '../../core/db';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { logFromRequest } from '../../core/auditLog';
import { getStripeClient } from '../../core/stripe/client';

import { getErrorMessage } from '../../utils/errorUtils';

import adminResolutionRouter from './admin-resolution';
import adminRosterRouter from './admin-roster';
import adminMaintenanceRouter from './admin-maintenance';

interface DbRow {
  [key: string]: unknown;
}

const router = Router();

router.use(adminResolutionRouter);
router.use(adminRosterRouter);
router.use(adminMaintenanceRouter);

router.delete('/api/admin/trackman/linked-email', isStaffOrAdmin, async (req, res) => {
  try {
    const { memberEmail: rawMemberEmail, linkedEmail: rawLinkedEmail } = req.body;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();
    const linkedEmail = rawLinkedEmail?.trim()?.toLowerCase();
    
    if (!memberEmail || !linkedEmail) {
      return res.status(400).json({ error: 'memberEmail and linkedEmail are required' });
    }
    
    const result = await db.execute(sql`UPDATE users 
       SET manually_linked_emails = (
         SELECT COALESCE(jsonb_agg(to_jsonb(elem)), '[]'::jsonb)
         FROM jsonb_array_elements_text(COALESCE(manually_linked_emails, '[]'::jsonb)) elem
         WHERE elem != ${linkedEmail}
       )
       WHERE LOWER(email) = LOWER(${memberEmail})
       RETURNING manually_linked_emails`);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    res.json({ 
      success: true, 
      manuallyLinkedEmails: (result.rows[0] as DbRow).manually_linked_emails || []
    });
  } catch (error: unknown) {
    logger.error('Remove linked email error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to remove linked email' });
  }
});

router.get('/api/admin/trackman/matched', isStaffOrAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string || '').trim().toLowerCase();
    
    const matchedConditions: ReturnType<typeof sql>[] = [
      sql`(br.trackman_booking_id IS NOT NULL OR br.notes LIKE '%[Trackman Import ID:%')`,
      sql`br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')`,
      sql`(
        COALESCE(br.trackman_player_count, 1) = 1
        OR (
          br.session_id IS NOT NULL
          AND (SELECT COUNT(*) FROM booking_participants bp WHERE bp.session_id = br.session_id) >= COALESCE(br.trackman_player_count, 1)
        )
      )`
    ];
    
    if (search) {
      const searchPattern = `%${search}%`;
      matchedConditions.push(sql`(LOWER(br.user_name) LIKE ${searchPattern} OR LOWER(br.user_email) LIKE ${searchPattern} OR LOWER(u.first_name || ' ' || u.last_name) LIKE ${searchPattern})`);
    }
    
    const matchedWhere = sql.join(matchedConditions, sql` AND `);
    
    const countResult = await db.execute(sql`SELECT COUNT(*) as total FROM booking_requests br LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email) WHERE ${matchedWhere}`);
    const totalCount = parseInt((countResult.rows[0] as DbRow).total as string, 10);
    
    const result = await db.execute(sql`SELECT 
        br.id,
        br.user_email,
        br.user_name,
        br.resource_id,
        TO_CHAR(br.request_date, 'YYYY-MM-DD') as request_date,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.status,
        br.notes,
        br.trackman_booking_id,
        br.trackman_player_count,
        br.created_at,
        br.session_id,
        u.first_name as member_first_name,
        u.last_name as member_last_name,
        u.email as member_email,
        COALESCE(br.trackman_player_count, 1) as total_slots,
        CASE 
          WHEN br.session_id IS NOT NULL THEN
            COALESCE((
              SELECT COUNT(*) FROM booking_participants bp 
              LEFT JOIN guests g ON g.id = bp.guest_id
              WHERE bp.session_id = br.session_id
                AND (bp.participant_type != 'guest' OR (bp.participant_type = 'guest' AND g.email IS NOT NULL AND g.email != ''))
            ), 0)
          ELSE
            CASE 
              WHEN br.user_email IS NOT NULL 
                   AND br.user_email NOT LIKE 'unmatched-%@%' 
                   AND br.user_email NOT LIKE '%unmatched@%'
              THEN 1
              ELSE 0
            END + COALESCE((SELECT COUNT(*) FROM booking_participants bp2 INNER JOIN booking_requests br2 ON br2.session_id = bp2.session_id WHERE br2.id = br.id AND bp2.user_id IS NOT NULL AND bp2.participant_type = 'member'), 0)
        END as filled_slots
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
       WHERE ${matchedWhere}
       ORDER BY br.request_date DESC, br.start_time DESC
       LIMIT ${limit} OFFSET ${offset}`);
    
    const data = result.rows.map((row: DbRow) => {
      const totalSlots = parseInt(row.total_slots as string) || 1;
      const filledSlots = parseInt(row.filled_slots as string) || 0;
      return {
        id: row.id,
        userEmail: row.user_email,
        userName: row.user_name,
        resourceId: row.resource_id,
        requestDate: row.request_date,
        startTime: row.start_time,
        endTime: row.end_time,
        durationMinutes: row.duration_minutes,
        status: row.status,
        notes: row.notes,
        trackmanBookingId: row.trackman_booking_id,
        trackmanPlayerCount: row.trackman_player_count,
        createdAt: row.created_at,
        member: row.member_email ? {
          email: row.member_email,
          firstName: row.member_first_name,
          lastName: row.member_last_name,
          fullName: [row.member_first_name, row.member_last_name].filter(Boolean).join(' ')
        } : null,
        totalSlots,
        filledSlots,
        assignedCount: filledSlots,
        playerCount: totalSlots,
        isSolo: totalSlots === 1,
        isFullyResolved: totalSlots === 1 || filledSlots >= totalSlots,
        slotInfo: {
          totalSlots,
          filledSlots,
          isSolo: totalSlots === 1,
          isFullyResolved: totalSlots === 1 || filledSlots >= totalSlots
        }
      };
    });
    
    res.json({ data, totalCount });
  } catch (error: unknown) {
    logger.error('Fetch matched bookings error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch matched bookings' });
  }
});

router.put('/api/admin/trackman/matched/:id/reassign', isStaffOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { newMemberEmail: rawNewMemberEmail } = req.body;
    const newMemberEmail = rawNewMemberEmail?.trim()?.toLowerCase();
    
    if (!newMemberEmail) {
      return res.status(400).json({ error: 'newMemberEmail is required' });
    }
    
    await client.query('BEGIN');
    
    const bookingResult = await client.query(
      `SELECT user_email, notes, session_id FROM booking_requests WHERE id = $1`,
      [id]
    );
    
    if (bookingResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const oldEmail = (bookingResult.rows[0] as DbRow).user_email;
    const notes = (bookingResult.rows[0] as DbRow).notes || '';
    const sessionId = (bookingResult.rows[0] as DbRow).session_id;
    
    const newMemberResult = await client.query(
      `SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)`,
      [newMemberEmail]
    );
    
    if (newMemberResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'New member not found' });
    }
    
    const newMember = newMemberResult.rows[0] as DbRow;
    const newMemberName = `${newMember.first_name} ${newMember.last_name}`.trim();
    
    let placeholderEmail: string | null = null;
    const trackmanMatch = String(notes).match(/\[Trackman Import ID:[^\]]+\]\s*Original email:\s*([^\s\]]+)/i);
    if (trackmanMatch) {
      placeholderEmail = trackmanMatch[1].toLowerCase().trim();
    } else {
      const emailMatch = String(notes).match(/original\s*email[:\s]+([^\s,\]]+)/i);
      if (emailMatch) {
        placeholderEmail = emailMatch[1].toLowerCase().trim();
      }
    }
    
    await client.query(
      `UPDATE booking_requests SET user_id = $1, user_email = $2, user_name = $3, updated_at = NOW() WHERE id = $4`,
      [newMember.id, newMemberEmail.toLowerCase(), newMemberName, id]
    );
    
    if (sessionId) {
      const oldOwnerResult = await client.query(
        `SELECT user_id FROM booking_participants WHERE session_id = $1 AND participant_type = 'owner'`,
        [sessionId]
      );
      const oldOwnerId = (oldOwnerResult.rows[0] as DbRow)?.user_id;
      
      await client.query(
        `UPDATE booking_participants 
         SET user_id = $1, display_name = $2
         WHERE session_id = $3 AND participant_type = 'owner'`,
        [newMember.id, newMemberName, sessionId]
      );
      
      if (oldOwnerId) {
        await client.query(
          `UPDATE usage_ledger 
           SET member_id = $1
           WHERE session_id = $2 AND member_id = $3`,
          [newMember.id, sessionId, oldOwnerId]
        );
      } else {
        logger.warn('[Reassign] No old owner found in participants, skipping usage_ledger update', { extra: { sessionId } });
      }
    }
    
    if (placeholderEmail) {
      await client.query(
        `UPDATE users 
         SET manually_linked_emails = (
           SELECT COALESCE(jsonb_agg(to_jsonb(elem)), '[]'::jsonb)
           FROM jsonb_array_elements_text(COALESCE(manually_linked_emails, '[]'::jsonb)) elem
           WHERE elem != $1
         )
         WHERE LOWER(email) = LOWER($2)`,
        [placeholderEmail, oldEmail]
      );
      
      await client.query(
        `UPDATE users 
         SET manually_linked_emails = COALESCE(manually_linked_emails, '[]'::jsonb) || to_jsonb($1::text)
         WHERE LOWER(email) = LOWER($2)
           AND NOT (COALESCE(manually_linked_emails, '[]'::jsonb) @> to_jsonb($1::text))`,
        [placeholderEmail, newMemberEmail]
      );
    }
    
    await client.query('COMMIT');
    
    if (sessionId) {
      try {
        await recalculateSessionFees(sessionId as number, 'roster_update');
      } catch (feeErr: unknown) {
        logger.warn('[Reassign] Fee recalculation failed', { extra: { sessionId, feeErr } });
      }
      try {
        const { syncBookingInvoice } = await import('../../core/billing/bookingInvoiceService');
        await syncBookingInvoice(parseInt(id as string), sessionId as number);
      } catch (invoiceErr: unknown) {
        logger.warn('[Reassign] Invoice sync failed after fee recalculation', { extra: { sessionId, bookingId: id, invoiceErr } });
      }
    }

    await logFromRequest(req, {
      action: 'reassign_booking',
      resourceType: 'booking',
      resourceId: id as string,
      resourceName: `Reassigned booking to ${newMemberName}`,
      details: {
        oldEmail,
        newEmail: newMemberEmail.toLowerCase(),
        placeholderEmail,
        sessionId,
        updatedParticipants: !!sessionId,
        updatedLedger: !!sessionId
      }
    });
    
    res.json({ 
      success: true, 
      message: 'Booking reassigned completely (including billing records)',
      oldEmail,
      newEmail: newMemberEmail.toLowerCase(),
      placeholderEmail
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    logger.error('Reassign matched booking error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to reassign booking' });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/admin/trackman/unmatch-member', isStaffOrAdmin, async (req, res) => {
  try {
    const { email: rawEmail } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    const unmatchedBy = req.session?.user?.email || 'admin';
    
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    if (normalizedEmail.includes('unmatched@') || 
        normalizedEmail.includes('unmatched-') || 
        normalizedEmail.includes('@trackman.local') ||
        normalizedEmail.includes('anonymous@') ||
        normalizedEmail.includes('booking@everclub')) {
      return res.json({ 
        success: true, 
        affectedCount: 0,
        email: normalizedEmail,
        message: 'This booking is already unmatched'
      });
    }
    
    const bookingsResult = await db.execute(sql`SELECT id, notes, user_name 
       FROM booking_requests 
       WHERE LOWER(user_email) = ${normalizedEmail}
         AND (notes LIKE '%[Trackman Import ID:%' OR trackman_booking_id IS NOT NULL)
         AND status IN ('approved', 'pending', 'attended', 'no_show')`);
    
    if (bookingsResult.rowCount === 0) {
      return res.json({ 
        success: true, 
        affectedCount: 0,
        email: normalizedEmail,
        message: 'No bookings found to unmatch'
      });
    }
    
    let affectedCount = 0;
    for (const booking of bookingsResult.rows as DbRow[]) {
      const notesMatch = String(booking.notes || '').match(/\[Trackman Import ID:\d+\]\s*([^\[]+)/);
      const originalName = notesMatch ? notesMatch[1].trim() : booking.user_name || 'Unknown';
      
      const trackmanIdMatch = String(booking.notes || '').match(/\[Trackman Import ID:(\d+)\]/);
      const trackmanId = trackmanIdMatch ? trackmanIdMatch[1] : booking.id;
      
      await db.execute(sql`UPDATE booking_requests 
         SET user_email = NULL,
             user_name = ${originalName},
             is_unmatched = true,
             staff_notes = COALESCE(staff_notes, '') || ${` [Unmatched from ${normalizedEmail} by ${unmatchedBy} on ${new Date().toISOString()}]`}
         WHERE id = ${booking.id}`);
      affectedCount++;
    }
    
    if (affectedCount > 0) {
      logFromRequest(req, 'unmatch_booking', 'booking', undefined, normalizedEmail, {
        email: normalizedEmail,
        affectedCount,
        unmatchedAt: new Date().toISOString()
      });
    }
    
    res.json({ 
      success: true, 
      affectedCount,
      email: normalizedEmail,
      message: affectedCount > 0 
        ? `Unmatched ${affectedCount} booking(s) for ${normalizedEmail}`
        : 'No bookings found to unmatch'
    });
  } catch (error: unknown) {
    logger.error('Unmatch member error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to unmatch member bookings' });
  }
});

router.get('/api/admin/trackman/potential-matches', isStaffOrAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    
    const unmatchedResult = await db.execute(sql`SELECT 
        tub.id, tub.trackman_booking_id, tub.user_name, tub.original_email, 
        TO_CHAR(tub.booking_date, 'YYYY-MM-DD') as booking_date,
        tub.start_time, tub.end_time, tub.bay_number, tub.player_count, tub.status, tub.notes, tub.created_at
       FROM trackman_unmatched_bookings tub
       WHERE tub.resolved_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM booking_requests br 
           WHERE br.trackman_booking_id = tub.trackman_booking_id::text
         )
       ORDER BY tub.booking_date DESC, tub.start_time DESC
       LIMIT ${limit} OFFSET ${offset}`);
    
    const potentialMatches: Record<string, unknown>[] = [];
    
    for (const unmatched of unmatchedResult.rows as DbRow[]) {
      const matchingBookings = await db.execute(sql`SELECT br.id, br.user_email, br.user_name, br.start_time, br.end_time, br.status,
                u.first_name, u.last_name
         FROM booking_requests br
         LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
         WHERE br.request_date = ${unmatched.booking_date}
           AND ABS(EXTRACT(EPOCH FROM (br.start_time::time - ${unmatched.start_time}::time))) <= 1800
           AND br.trackman_booking_id IS NULL
           AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
         LIMIT 5`);
      
      if (matchingBookings.rows.length > 0) {
        potentialMatches.push({
          unmatchedBooking: {
            id: unmatched.id,
            trackmanBookingId: unmatched.trackman_booking_id,
            userName: unmatched.user_name,
            originalEmail: unmatched.original_email,
            bookingDate: unmatched.booking_date,
            startTime: unmatched.start_time,
            endTime: unmatched.end_time,
            bayNumber: unmatched.bay_number,
            playerCount: unmatched.player_count,
            status: unmatched.status,
            notes: unmatched.notes,
            createdAt: unmatched.created_at
          },
          potentialAppBookings: matchingBookings.rows.map((b: DbRow) => ({
            id: b.id,
            userEmail: b.user_email,
            userName: b.user_name,
            startTime: b.start_time,
            endTime: b.end_time,
            status: b.status,
            memberName: [b.first_name, b.last_name].filter(Boolean).join(' ') || b.user_name
          }))
        });
      }
    }
    
    const totalCount = potentialMatches.length;
    
    res.json({ data: potentialMatches, totalCount });
  } catch (error: unknown) {
    logger.error('Fetch potential-matches error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch potential matches' });
  }
});

router.get('/api/admin/trackman/requires-review', isStaffOrAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    
    const result = await db.execute(sql`SELECT 
        tub.id,
        tub.trackman_booking_id as "trackmanBookingId",
        tub.user_name as "userName",
        tub.original_email as "originalEmail",
        TO_CHAR(tub.booking_date, 'YYYY-MM-DD') as "bookingDate",
        tub.start_time as "startTime",
        tub.end_time as "endTime",
        tub.bay_number as "bayNumber",
        tub.player_count as "playerCount",
        tub.notes,
        tub.match_attempt_reason as "matchAttemptReason",
        tub.created_at as "createdAt"
       FROM trackman_unmatched_bookings tub
       WHERE tub.resolved_at IS NULL
         AND tub.match_attempt_reason LIKE '%REQUIRES_REVIEW%'
         AND NOT EXISTS (
           SELECT 1 FROM booking_requests br 
           WHERE br.trackman_booking_id = tub.trackman_booking_id::text
         )
       ORDER BY tub.booking_date DESC, tub.start_time DESC
       LIMIT ${limit} OFFSET ${offset}`);
    
    const countResult = await db.execute(sql`SELECT COUNT(*) as total 
       FROM trackman_unmatched_bookings tub
       WHERE tub.resolved_at IS NULL 
         AND tub.match_attempt_reason LIKE '%REQUIRES_REVIEW%'
         AND NOT EXISTS (
           SELECT 1 FROM booking_requests br 
           WHERE br.trackman_booking_id = tub.trackman_booking_id::text
         )`);
    
    res.json({ 
      data: result.rows,
      totalCount: parseInt((countResult.rows[0] as DbRow).total as string)
    });
  } catch (error: unknown) {
    logger.error('Fetch requires-review error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch bookings requiring review' });
  }
});

router.post('/api/admin/trackman/auto-match-visitors', isStaffOrAdmin, async (req, res) => {
  try {
    const sessionUser = req.session?.user?.email || 'system';
    
    const { autoMatchAllUnmatchedBookings } = await import('../../core/visitors/autoMatchService');
    
    const results = await autoMatchAllUnmatchedBookings(sessionUser);
    
    logFromRequest(
      req,
      'bulk_action',
      'booking',
      undefined,
      'Auto-Match Visitors',
      { 
        matched: results.matched, 
        failed: results.failed,
        matchTypes: results.results.reduce((acc, r) => {
          acc[r.matchType] = (acc[r.matchType] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      }
    );
    
    res.json({
      success: true,
      matched: results.matched,
      failed: results.failed,
      results: results.results.slice(0, 50),
      message: `Auto-matched ${results.matched} booking(s), ${results.failed} could not be matched`
    });
  } catch (error: unknown) {
    logger.error('[Trackman Auto-Match] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ 
      error: 'Failed to auto-match visitors: ' + (getErrorMessage(error) || 'Unknown error') 
    });
  }
});

router.post('/api/trackman/admin/cleanup-lessons', isStaffOrAdmin, async (req, res) => {
  try {
    const dryRun = req.query.dryRun === 'true';
    const sessionUser = req.session?.user?.email || 'system';
    const logs: string[] = [];
    const log = (msg: string) => {
      logger.info('log data', { extra: { data: msg } });
      logs.push(msg);
    };

    log(`[Lesson Cleanup] Starting cleanup run (Dry Run: ${dryRun})...`);

    const INSTRUCTOR_EMAILS = [
      'tim@evenhouse.club',
      'rebecca@evenhouse.club',
      'instructors@evenhouse.club'
    ];

    let convertedBookings = 0;
    let resolvedUnmatched = 0;

    if (INSTRUCTOR_EMAILS.length === 0) {
      return res.json({ success: true, convertedBookings: 0, resolvedUnmatched: 0, blocksCreated: 0 });
    }
    const lessonBookings = await db.execute(sql`SELECT 
        br.id,
        br.user_name,
        br.user_email,
        br.resource_id,
        br.request_date,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.notes,
        br.trackman_booking_id
      FROM booking_requests br
      WHERE br.status NOT IN ('cancelled', 'cancellation_pending')
        AND (
          LOWER(br.user_email) IN (${sql.join(INSTRUCTOR_EMAILS.map((e: string) => sql`${e}`), sql`, `)})
          OR LOWER(br.user_name) LIKE '%lesson%'
          OR LOWER(br.notes) LIKE '%lesson%'
          OR (LOWER(br.user_name) LIKE '%rebecca%' AND LOWER(br.user_name) LIKE '%lee%')
          OR (LOWER(br.user_name) LIKE '%tim%' AND LOWER(br.user_name) LIKE '%silverman%')
        )
      ORDER BY br.request_date DESC
      LIMIT 500`);

    log(`[Lesson Cleanup] Found ${lessonBookings.rows.length} lesson bookings to process.`);

    for (const booking of lessonBookings.rows as DbRow[]) {
      if (!booking.resource_id || !booking.request_date || !booking.start_time) continue;

      const bookingDate = booking.request_date instanceof Date 
        ? booking.request_date.toISOString().split('T')[0]
        : booking.request_date;
      const endTime = booking.end_time || booking.start_time;

      const existingBlock = await db.execute(sql`SELECT ab.id FROM availability_blocks ab
        WHERE ab.resource_id = ${booking.resource_id}
          AND ab.block_date = ${bookingDate}
          AND ab.start_time < ${endTime}::time
          AND ab.end_time > ${booking.start_time}::time
        LIMIT 1`);

      const blockAlreadyExists = existingBlock.rows.length > 0;

      if (!dryRun) {
        if (!blockAlreadyExists) {
          await db.execute(sql`INSERT INTO availability_blocks 
              (resource_id, block_date, start_time, end_time, block_type, notes, created_by)
            VALUES (${booking.resource_id}, ${bookingDate}, ${booking.start_time}, ${endTime}, 'blocked', ${`Lesson - ${booking.user_name}`}, 'system_cleanup')`);
        }

        await db.execute(sql`UPDATE booking_requests 
          SET status = 'cancelled',
              staff_notes = COALESCE(staff_notes, '') || ${` [Converted to Availability Block by ${sessionUser}]`},
              updated_at = NOW()
          WHERE id = ${booking.id}`);

        await db.execute(sql`DELETE FROM booking_participants WHERE session_id IN (
          SELECT id FROM booking_sessions WHERE trackman_booking_id = ${booking.trackman_booking_id}
        )`);

        await db.execute(sql`DELETE FROM usage_ledger WHERE booking_id = ${booking.id}`);

        const pendingIntents = await db.execute(sql`SELECT stripe_payment_intent_id FROM stripe_payment_intents 
          WHERE booking_id = ${booking.id} AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')`);
        
        for (const intent of pendingIntents.rows as DbRow[]) {
          try {
            const stripe = await getStripeClient();
            await stripe.paymentIntents.cancel(intent.stripe_payment_intent_id as string);
          } catch (err: unknown) {
            log(`[Lesson Cleanup] Could not cancel payment intent ${intent.stripe_payment_intent_id}: ${getErrorMessage(err)}`);
          }
        }

        await db.execute(sql`DELETE FROM booking_sessions WHERE trackman_booking_id = ${booking.trackman_booking_id}`);
      }

      log(`[Lesson Cleanup] ${blockAlreadyExists ? 'Block exists, cleaned up booking' : 'Converted Booking'} #${booking.id} (${booking.user_name}).`);
      convertedBookings++;
    }

    const unmatchedLessons = await db.execute(sql`SELECT id, user_name, booking_date, start_time, end_time, bay_number, notes, trackman_booking_id
      FROM trackman_unmatched_bookings
      WHERE resolved_at IS NULL
        AND (
          LOWER(user_name) LIKE '%lesson%'
          OR LOWER(notes) LIKE '%lesson%'
          OR (LOWER(user_name) LIKE '%rebecca%')
          OR (LOWER(user_name) LIKE '%tim%' AND LOWER(user_name) LIKE '%silverman%')
        )
      LIMIT 500`);

    log(`[Lesson Cleanup] Found ${unmatchedLessons.rows.length} unmatched lesson entries to resolve.`);

    for (const item of unmatchedLessons.rows as DbRow[]) {
      const resourceId = parseInt(item.bay_number as string) || null;
      
      if (resourceId && item.booking_date && item.start_time) {
        if (!dryRun) {
          const bookingDate = item.booking_date instanceof Date 
            ? item.booking_date.toISOString().split('T')[0]
            : item.booking_date;

          const existingBlock = await db.execute(sql`SELECT ab.id FROM availability_blocks ab
            WHERE ab.resource_id = ${resourceId}
              AND ab.block_date = ${bookingDate}
              AND ab.start_time < ${item.end_time || item.start_time}::time
              AND ab.end_time > ${item.start_time}::time
            LIMIT 1`);

          if (existingBlock.rows.length === 0) {
            await db.execute(sql`INSERT INTO availability_blocks 
                (resource_id, block_date, start_time, end_time, block_type, notes, created_by)
              VALUES (${resourceId}, ${bookingDate}, ${item.start_time}, ${item.end_time || item.start_time}, 'blocked', ${`Lesson - ${item.user_name}`}, 'system_cleanup')`);
          }

          await db.execute(sql`UPDATE trackman_unmatched_bookings
            SET resolved_at = NOW(),
                resolved_by = ${sessionUser},
                match_attempt_reason = 'Converted to Availability Block (Lesson Cleanup)'
            WHERE id = ${item.id}`);
        }

        log(`[Lesson Cleanup] Resolved unmatched lesson #${item.id} (${item.user_name}).`);
        resolvedUnmatched++;
      }
    }

    logFromRequest(
      req,
      'bulk_action',
      'booking',
      undefined,
      'Lesson Cleanup',
      { 
        dryRun,
        convertedBookings,
        resolvedUnmatched
      }
    );

    res.json({
      success: true,
      dryRun,
      convertedBookings,
      resolvedUnmatched,
      logs
    });
  } catch (error: unknown) {
    logger.error('[Lesson Cleanup] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ 
      error: 'Failed to cleanup lessons: ' + (getErrorMessage(error) || 'Unknown error') 
    });
  }
});

export default router;
