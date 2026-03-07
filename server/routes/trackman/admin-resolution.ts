import { logger } from '../../core/logger';
import { Router } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { pool, safeRelease } from '../../core/db';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getMemberTierByEmail } from '../../core/tierService';
import { computeFeeBreakdown, recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { logFromRequest } from '../../core/auditLog';
import { getStripeClient } from '../../core/stripe/client';
import { listCustomerPaymentMethods } from '../../core/stripe/customers';

import { recordUsage, ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { updateVisitorTypeByUserId } from '../../core/visitors';
import { getErrorMessage, safeErrorDetail } from '../../utils/errorUtils';
import { getTodayPacific } from '../../utils/dateUtils';

function pacificNow(): string {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
}

interface DbRow {
  [key: string]: unknown;
}

const router = Router();

router.get('/api/admin/trackman/unmatched', isStaffOrAdmin, async (req, res) => {
  try {
    const { limit = '50', offset = '0', search = '', resolved = 'false', category = '' } = req.query;
    const limitNum = Math.min(parseInt(limit as string) || 50, 100);
    const offsetNum = parseInt(offset as string) || 0;
    const categoryFilter = (category as string).toLowerCase();
    
    const sqlConditions: ReturnType<typeof sql>[] = [sql`br.is_unmatched = true`];
    
    if (resolved === 'false') {
      sqlConditions.push(sql`(br.user_email IS NULL OR br.user_email = '' OR br.user_email LIKE 'unmatched-%@%' OR br.user_email LIKE '%@trackman.local')`);
    }
    
    if (search) {
      const searchPattern = `%${search}%`;
      sqlConditions.push(sql`(
        br.staff_notes ILIKE ${searchPattern} OR 
        br.trackman_customer_notes ILIKE ${searchPattern} OR
        br.trackman_booking_id::text ILIKE ${searchPattern}
      )`);
    }
    
    if (categoryFilter === 'matchable') {
      sqlConditions.push(sql`EXISTS (
        SELECT 1 FROM users u 
        WHERE LOWER(u.email) = LOWER(REGEXP_REPLACE(br.trackman_customer_notes, '.*Original email:\\s*([^,\\s]+).*', '\\1'))
      )`);
    } else if (categoryFilter === 'events') {
      sqlConditions.push(sql`(
        br.user_name ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
        OR br.trackman_customer_notes ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
      )`);
    } else if (categoryFilter === 'visitors') {
      sqlConditions.push(sql`NOT EXISTS (
        SELECT 1 FROM users u 
        WHERE LOWER(u.email) = LOWER(REGEXP_REPLACE(br.trackman_customer_notes, '.*Original email:\\s*([^,\\s]+).*', '\\1'))
      ) AND NOT (
        br.user_name ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
        OR br.trackman_customer_notes ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
      )`);
    }
    
    const whereFragment = sql.join(sqlConditions, sql` AND `);
    
    const countResult = await db.execute(sql`SELECT COUNT(*) FROM booking_requests br WHERE ${whereFragment}`);
    const totalCount = parseInt((countResult.rows[0] as DbRow).count as string);
    
    const result = await db.execute(sql`SELECT 
        br.id,
        br.trackman_booking_id,
        br.request_date as booking_date,
        br.start_time,
        br.end_time,
        br.resource_id,
        br.user_name as raw_user_name,
        r.name as bay_name,
        br.staff_notes,
        br.trackman_customer_notes as notes,
        br.trackman_player_count as player_count,
        br.created_at,
        br.updated_at,
        EXISTS (
          SELECT 1 FROM users u 
          WHERE LOWER(u.email) = LOWER(REGEXP_REPLACE(br.trackman_customer_notes, '.*Original email:\\s*([^,\\s]+).*', '\\1'))
        ) as is_matchable,
        (
          br.user_name ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
          OR br.trackman_customer_notes ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
        ) as is_event
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE ${whereFragment}
      ORDER BY br.request_date DESC, br.start_time DESC
      LIMIT ${limitNum} OFFSET ${offsetNum}`);
    
    const parsedResults = result.rows.map((row: DbRow) => {
      let userName = 'Unknown';
      let originalEmail = '';
      let matchAttemptReason = '';
      
      if (row.notes) {
        const nameMatch = String(row.notes).match(/Original name:\s*([^,]+)/i);
        const emailMatch = String(row.notes).match(/Original email:\s*([^,\s]+)/i);
        if (nameMatch) userName = nameMatch[1].trim();
        if (emailMatch) originalEmail = emailMatch[1].trim();
        matchAttemptReason = 'No matching member found in system';
      }
      
      if (userName === 'Unknown' && row.raw_user_name) {
        userName = row.raw_user_name as string;
      }
      
      const bayNumber = row.bay_name ? String(row.bay_name).replace(/Bay\s*/i, '') : row.resource_id;
      
      let bookingCategory: 'matchable' | 'events' | 'visitors' = 'visitors';
      if (row.is_matchable) {
        bookingCategory = 'matchable';
      } else if (row.is_event) {
        bookingCategory = 'events';
      }
      
      return {
        id: row.id,
        trackman_booking_id: row.trackman_booking_id,
        booking_date: row.booking_date,
        start_time: row.start_time,
        end_time: row.end_time,
        bay_number: bayNumber,
        bay_name: row.bay_name,
        user_name: userName,
        original_email: originalEmail,
        match_attempt_reason: matchAttemptReason,
        notes: row.notes,
        player_count: row.player_count,
        created_at: row.created_at,
        category: bookingCategory
      };
    });
    
    res.json({
      data: parsedResults,
      totalCount,
      page: Math.floor(offsetNum / limitNum) + 1,
      totalPages: Math.ceil(totalCount / limitNum)
    });
  } catch (error: unknown) {
    logger.error('Error fetching unmatched bookings', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch unmatched bookings' });
  }
});

router.post('/api/admin/trackman/unmatched/auto-resolve', isStaffOrAdmin, async (req, res) => {
  try {
    const staffEmail = req.session?.user?.email || 'admin';
    
    const matchableResult = await db.execute(sql`SELECT 
        br.id as booking_id,
        br.trackman_booking_id,
        br.trackman_customer_notes,
        br.request_date,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.resource_id,
        u.id as user_id,
        u.email as user_email,
        u.first_name,
        u.last_name,
        u.role
      FROM booking_requests br
      INNER JOIN users u ON LOWER(u.email) = LOWER(REGEXP_REPLACE(br.trackman_customer_notes, '.*Original email:\\s*([^,\\s]+).*', '\\1'))
      WHERE br.is_unmatched = true
        AND (br.user_email IS NULL OR br.user_email = '' OR br.user_email LIKE 'unmatched-%@%' OR br.user_email LIKE '%@trackman.local')
      ORDER BY br.request_date DESC
      LIMIT 100`);
    
    if (matchableResult.rows.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No matchable bookings found',
        resolved: 0 
      });
    }
    
    let resolvedCount = 0;
    const errors: string[] = [];
    
    for (const row of matchableResult.rows as DbRow[]) {
      try {
        const autoResolveName = `${row.first_name} ${row.last_name}`.trim();
        await db.execute(sql`UPDATE booking_requests 
           SET user_id = ${row.user_id}, 
               user_email = ${row.user_email}, 
               user_name = ${autoResolveName},
               is_unmatched = false,
               staff_notes = COALESCE(staff_notes, '') || ${` [Auto-resolved by ${staffEmail} on ${pacificNow()}]`},
               updated_at = NOW()
           WHERE id = ${row.booking_id}`);
        
        const sessionForAutoResolve = await db.execute(sql`SELECT session_id FROM booking_requests WHERE id = ${row.booking_id}`);
        const autoSessionId = (sessionForAutoResolve.rows[0] as DbRow)?.session_id;
        if (autoSessionId) {
          await db.execute(sql`UPDATE booking_participants 
             SET user_id = ${row.user_id}, display_name = ${autoResolveName}
             WHERE session_id = ${autoSessionId} AND participant_type = 'owner'`);
        }
        
        resolvedCount++;
      } catch (err: unknown) {
        errors.push(`Booking ${row.trackman_booking_id}: ${getErrorMessage(err)}`);
      }
    }
    
    await logFromRequest(req, {
      action: 'bulk_action',
      resourceType: 'trackman',
      resourceId: 'auto-resolve',
      resourceName: 'Auto-resolve matchable bookings',
      details: { 
        resolvedCount,
        totalFound: matchableResult.rows.length,
        errors: errors.length > 0 ? errors : undefined
      }
    });
    
    res.json({ 
      success: true, 
      message: `Auto-resolved ${resolvedCount} matchable booking(s)`,
      resolved: resolvedCount,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error: unknown) {
    logger.error('Error auto-resolving matchable bookings', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to auto-resolve matchable bookings' });
  }
});

router.post('/api/admin/trackman/unmatched/bulk-dismiss', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingIds, reason = 'external_booking' } = req.body;
    const staffEmail = req.session?.user?.email || 'admin';
    
    if (!bookingIds || !Array.isArray(bookingIds) || bookingIds.length === 0) {
      return res.status(400).json({ error: 'bookingIds array is required' });
    }
    
    if (bookingIds.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 bookings can be dismissed at once' });
    }
    
    const validReasons = ['external_booking', 'visitor', 'event', 'duplicate', 'test_data', 'other'];
    const dismissReason = validReasons.includes(reason) ? reason : 'external_booking';
    
    const result = await db.execute(sql`UPDATE booking_requests 
       SET is_unmatched = false,
           staff_notes = COALESCE(staff_notes, '') || ${` [Dismissed as ${dismissReason} by ${staffEmail} on ${pacificNow()}]`},
           updated_at = NOW()
       WHERE id IN (${sql.join(bookingIds.map((id: number) => sql`${id}`), sql`, `)})
         AND is_unmatched = true
       RETURNING id, trackman_booking_id`);
    
    const dismissedCount = result.rowCount || 0;
    
    await logFromRequest(req, {
      action: 'bulk_action',
      resourceType: 'trackman',
      resourceId: 'bulk-dismiss',
      resourceName: 'Bulk dismiss unmatched bookings',
      details: { 
        dismissedCount,
        reason: dismissReason,
        bookingIds: result.rows.map((r: DbRow) => r.trackman_booking_id || r.id)
      }
    });
    
    res.json({ 
      success: true, 
      message: `Dismissed ${dismissedCount} booking(s) as ${dismissReason}`,
      dismissed: dismissedCount
    });
  } catch (error: unknown) {
    logger.error('Error bulk dismissing bookings', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to dismiss bookings' });
  }
});

router.put('/api/admin/trackman/unmatched/:id/resolve', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const numericId = parseInt(id as string);
    if (isNaN(numericId)) return res.status(400).json({ error: 'Invalid booking ID' });
    const { email: rawEmail, memberEmail: rawMemberEmail, rememberEmail, additional_players } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();
    const resolveEmail = memberEmail || email;
    
    if (!resolveEmail) {
      return res.status(400).json({ error: 'Email is required (memberEmail or email)' });
    }
    
    const memberResult = await db.execute(sql`SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.stripe_customer_id, u.tier, u.archived_at,
              su.role as staff_role, su.is_active as is_staff_active
       FROM users u
       LEFT JOIN staff_users su ON LOWER(su.email) = LOWER(u.email) AND su.is_active = true
       WHERE LOWER(u.email) = LOWER(${resolveEmail.toLowerCase()})`);
    
    if (memberResult.rows.length === 0) {
      const staffCheck = await db.execute(sql`SELECT id, email, first_name, last_name, role FROM staff_users WHERE LOWER(email) = LOWER(${resolveEmail.toLowerCase()}) AND is_active = true`);
      
      if (staffCheck.rows.length > 0) {
        return res.status(404).json({ 
          error: 'This is a staff email but no user profile exists. Please ask an admin to set up this staff member in the system first.',
          isStaffEmail: true
        });
      }
      
      return res.status(404).json({ error: 'Member not found with that email. Make sure they exist in the member directory.' });
    }
    
    const member = memberResult.rows[0] as DbRow;
    
    if (member.archived_at) {
      return res.status(400).json({ error: 'Cannot assign booking to an archived member. Please reactivate the member first.' });
    }
    
    const isVisitor = member.role === 'visitor' && !member.staff_role;
    const staffEmail = req.session?.user?.email || 'admin';
    
    let bookingResult = await db.execute(sql`SELECT id, trackman_booking_id, staff_notes, trackman_customer_notes, request_date, start_time, end_time, 
              duration_minutes, resource_id, session_id
       FROM booking_requests WHERE id = ${numericId}`);
    
    let booking = bookingResult.rows[0] as DbRow;
    let fromLegacyTable = false;
    
    if (!booking) {
      const legacyResult = await db.execute(sql`SELECT id, trackman_booking_id, user_name, original_email, booking_date, 
                start_time, end_time, duration_minutes, bay_number, notes
         FROM trackman_unmatched_bookings WHERE id = ${numericId} AND resolved_at IS NULL`);
      
      if (legacyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Booking not found in either booking requests or unmatched bookings' });
      }
      
      const legacy = legacyResult.rows[0] as DbRow;
      fromLegacyTable = true;
      
      let resourceId = 1;
      if (legacy.bay_number) {
        const bayNum = parseInt(String(legacy.bay_number).replace(/\D/g, ''));
        if (bayNum >= 1 && bayNum <= 4) resourceId = bayNum;
      }
      
      const createResult = await db.execute(sql`INSERT INTO booking_requests (
          user_id, user_email, user_name, resource_id, request_date, start_time, end_time,
          duration_minutes, status, trackman_booking_id, is_unmatched, staff_notes, created_at, updated_at
        ) VALUES (${member.id}, ${member.email}, ${`${member.first_name} ${member.last_name}`}, ${resourceId}, ${legacy.booking_date}, ${legacy.start_time}, ${legacy.end_time}, ${legacy.duration_minutes || 60}, 'approved', ${legacy.trackman_booking_id}, false, ${`[Resolved from legacy unmatched by ${staffEmail}] ${legacy.notes || ''}`}, NOW(), NOW())
        ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
          user_id = EXCLUDED.user_id,
          user_email = EXCLUDED.user_email,
          user_name = EXCLUDED.user_name,
          is_unmatched = false,
          staff_notes = booking_requests.staff_notes || ' ' || EXCLUDED.staff_notes,
          updated_at = NOW()
        RETURNING id, trackman_booking_id, staff_notes, request_date, start_time, end_time, duration_minutes, resource_id`);
      
      booking = createResult.rows[0] as DbRow;
      
      await db.execute(sql`UPDATE trackman_unmatched_bookings SET resolved_at = NOW(), resolved_email = ${member.email} WHERE id = ${numericId}`);
    } else {
      await db.execute(sql`UPDATE booking_requests 
         SET user_id = ${member.id}, 
             user_email = ${member.email}, 
             user_name = ${`${member.first_name} ${member.last_name}`.trim()},
             is_unmatched = false,
             staff_notes = COALESCE(staff_notes, '') || ${` [Resolved by ${staffEmail} on ${pacificNow()}]`},
             updated_at = NOW()
         WHERE id = ${numericId}`);
    }
    
    const memberFullName = `${member.first_name} ${member.last_name}`.trim();
    
    if (Array.isArray(additional_players) && additional_players.length > 0) {
      const rpEntries = additional_players.map((p: { type: string; email?: string; name?: string; userId?: string; guest_name?: string }) => {
        if (p.type === 'guest_placeholder') {
          return { type: 'guest', name: p.guest_name || p.name || 'Guest' };
        }
        return { type: p.type === 'visitor' ? 'visitor' : 'member', email: p.email, name: p.name, userId: p.userId };
      });
      await db.execute(sql`UPDATE booking_requests 
         SET request_participants = ${JSON.stringify(rpEntries)}::jsonb,
             updated_at = NOW()
         WHERE id = ${booking.id}`);
      logger.info('[Trackman Resolve] Saved additional players to request_participants', {
        extra: { bookingId: booking.id, playerCount: rpEntries.length }
      });
    }
    
    if (booking.session_id) {
      const sessionExists = await db.execute(sql`SELECT id FROM booking_sessions WHERE id = ${booking.session_id} LIMIT 1`);
      if (sessionExists.rows.length === 0) {
        logger.warn('[Trackman Resolve] Booking has orphaned session_id — session does not exist, clearing', { extra: { bookingId: booking.id, orphanedSessionId: booking.session_id } });
        await db.execute(sql`UPDATE booking_requests SET session_id = NULL WHERE id = ${booking.id}`);
        booking.session_id = null;
      } else {
        await db.execute(sql`UPDATE booking_participants 
           SET user_id = ${member.id},
               display_name = ${memberFullName}
           WHERE session_id = ${booking.session_id} 
             AND participant_type = 'owner'`);
        logger.info('[Trackman Resolve] Updated owner participant display_name and user_id', { 
          extra: { sessionId: booking.session_id, memberName: memberFullName, memberId: member.id } 
        });
      }
    }
    
    let originalEmailForLearning: string | null = null;
    if (fromLegacyTable) {
      const legacyData = await db.execute(sql`SELECT original_email FROM trackman_unmatched_bookings WHERE id = ${id}`);
      if ((legacyData.rows[0] as DbRow)?.original_email) {
        originalEmailForLearning = String((legacyData.rows[0] as DbRow).original_email).toLowerCase().trim();
      }
    } else if (booking.trackman_customer_notes) {
      const emailMatch = String(booking.trackman_customer_notes).match(/Original email:\s*([^\s,]+)/i);
      if (emailMatch && emailMatch[1]) {
        originalEmailForLearning = emailMatch[1].toLowerCase().trim();
      }
    }
    
    const PLACEHOLDER_EMAILS = [
      'anonymous@yourgolfbooking.com',
      'booking@evenhouse.club',
      'bookings@evenhouse.club',
      'tccmembership@evenhouse.club'
    ];
    const isPlaceholderEmail = (email: string): boolean => {
      const normalizedEmail = email.toLowerCase().trim();
      if (PLACEHOLDER_EMAILS.includes(normalizedEmail)) return true;
      if (normalizedEmail.endsWith('@evenhouse.club') && normalizedEmail.length < 25) {
        const localPart = normalizedEmail.split('@')[0];
        if (/^[a-z]{3,12}$/.test(localPart) && !/\d/.test(localPart)) {
          return true;
        }
      }
      if (normalizedEmail.endsWith('@trackman.local') || normalizedEmail.startsWith('unmatched-')) return true;
      return false;
    };
    
    let emailLearningMessage = '';
    if (rememberEmail && originalEmailForLearning && originalEmailForLearning.includes('@')) {
      if (originalEmailForLearning.toLowerCase() !== String(member.email).toLowerCase() && 
          !isPlaceholderEmail(originalEmailForLearning)) {
        try {
          const existingLink = await db.execute(sql`SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = LOWER(${originalEmailForLearning})`);
          
          if (existingLink.rows.length === 0) {
            await db.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_by)
               VALUES (${String(member.email).toLowerCase()}, ${originalEmailForLearning}, ${'staff_resolution'}, ${staffEmail})`);
            logger.info('[Email Learning] Linked -> by', { extra: { originalEmailForLearning, memberEmail: member.email, staffEmail } });
            
            const otherUnresolvedResult = await db.execute(sql`SELECT id, trackman_booking_id 
               FROM booking_requests 
               WHERE is_unmatched = true 
               AND id != ${id}
               AND (
                 trackman_customer_notes ILIKE ${`%${originalEmailForLearning}%`}
                 OR user_email ILIKE ${`%${originalEmailForLearning.split('@')[0]}%`}
               )`);
            
            let autoResolvedCount = 0;
            for (const otherBooking of otherUnresolvedResult.rows as DbRow[]) {
              try {
                await db.execute(sql`UPDATE booking_requests 
                   SET user_id = ${member.id}, 
                       user_email = ${member.email}, 
                       user_name = ${memberFullName},
                       is_unmatched = false,
                       staff_notes = COALESCE(staff_notes, '') || ${` [Auto-resolved via linked email by ${staffEmail} on ${pacificNow()}]`},
                       updated_at = NOW()
                   WHERE id = ${otherBooking.id}`);
                
                const otherBookingDetails = await db.execute(sql`SELECT session_id, request_date, start_time, end_time, duration_minutes, resource_id, trackman_booking_id FROM booking_requests WHERE id = ${otherBooking.id}`);
                const otherBD = otherBookingDetails.rows[0] as DbRow;
                let otherSessionId = otherBD?.session_id;
                
                if (otherSessionId) {
                  const sessionCheck = await db.execute(sql`SELECT id FROM booking_sessions WHERE id = ${otherSessionId} LIMIT 1`);
                  if (sessionCheck.rows.length === 0) {
                    logger.warn('[Email Learning] Orphaned session_id on booking, clearing', { extra: { bookingId: otherBooking.id, orphanedSessionId: otherSessionId } });
                    await db.execute(sql`UPDATE booking_requests SET session_id = NULL WHERE id = ${otherBooking.id}`);
                    otherSessionId = null;
                  }
                }
                
                if (!otherSessionId && otherBD && otherBD.resource_id) {
                  const otherDateStr = typeof otherBD.request_date === 'string' ? otherBD.request_date :
                    new Date(otherBD.request_date as string | number | Date).toISOString().split('T')[0];
                  const otherSessionResult = await ensureSessionForBooking({
                    bookingId: otherBooking.id as number,
                    resourceId: otherBD.resource_id as number,
                    sessionDate: otherDateStr,
                    startTime: otherBD.start_time as string,
                    endTime: otherBD.end_time as string,
                    ownerEmail: (member.email as string) || '',
                    ownerName: memberFullName,
                    ownerUserId: member.id?.toString(),
                    trackmanBookingId: otherBD.trackman_booking_id as string,
                    source: 'trackman_import',
                    createdBy: 'staff_auto_resolve'
                  });
                  otherSessionId = otherSessionResult.sessionId || null;
                  if (otherSessionId) {
                    const todayPacific = getTodayPacific();
                    const isPastBooking = otherDateStr < todayPacific;
                    if (isPastBooking) {
                      await db.execute(sql`UPDATE booking_participants SET payment_status = 'paid', paid_at = NOW() WHERE session_id = ${otherSessionId} AND payment_status = 'pending'`);
                    }
                    await recordUsage(otherSessionId as number, {
                      memberId: (member.email as string).toLowerCase(),
                      minutesCharged: Number(otherBD.duration_minutes) || 60,
                    });
                    try {
                      await recalculateSessionFees(otherSessionId as number, 'checkin');
                    } catch (feeErr: unknown) {
                      logger.warn('[Email Learning] Failed to recalculate fees for auto-resolved session', { extra: { sessionId: otherSessionId, feeErr } });
                    }
                    logger.info('[Email Learning] Created session for auto-resolved booking', { extra: { bookingId: otherBooking.id, sessionId: otherSessionId } });
                  }
                }
                
                if (otherSessionId) {
                  await db.execute(sql`UPDATE booking_participants 
                     SET user_id = ${member.id}, display_name = ${memberFullName}
                     WHERE session_id = ${otherSessionId} AND participant_type = 'owner'`);
                }
                
                autoResolvedCount++;
              } catch (autoErr: unknown) {
                logger.error('[Email Learning] Failed to auto-resolve booking', { extra: { id: otherBooking.id, error: getErrorMessage(autoErr) } });
              }
            }
            
            if (autoResolvedCount > 0) {
              emailLearningMessage = ` Email ${originalEmailForLearning} learned and ${autoResolvedCount} other booking(s) auto-resolved.`;
              logger.info('[Email Learning] Auto-resolved other bookings for', { extra: { autoResolvedCount, originalEmailForLearning } });
            } else {
              emailLearningMessage = ` Email ${originalEmailForLearning} learned for future auto-matching.`;
            }
          }
        } catch (linkError: unknown) {
          logger.error('[Email Learning] Failed to save email link', { extra: { linkError: getErrorMessage(linkError) } });
        }
      }
    }
    
    let billingMessage = '';
    
    if (isVisitor) {
      try {
        const bookingDate = booking.request_date;
        const bookingDateStr = typeof bookingDate === 'string' ? bookingDate : 
          new Date(bookingDate as string | number | Date).toISOString().split('T')[0];
        
        const existingDayPass = await db.execute(sql`SELECT id, stripe_payment_intent_id FROM day_pass_purchases 
           WHERE user_id = ${member.id} 
           AND product_type = 'day-pass-golf-sim'
           AND (
             (booking_date = ${bookingDateStr}::date OR (booking_date IS NULL AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') = ${bookingDateStr}::date))
             OR trackman_booking_id = ${booking.trackman_booking_id}
           )
           AND (status IS NULL OR status != 'cancelled')`);
        
        if (existingDayPass.rows.length === 0) {
          const dayPassResult = await db.execute(sql`SELECT price_cents, stripe_price_id, name FROM membership_tiers 
             WHERE slug = 'day-pass-golf-sim' AND is_active = true`);
          
          if (dayPassResult.rows.length > 0) {
            const dayPass = dayPassResult.rows[0] as DbRow;
            const amountCents = dayPass.price_cents;
            if (!amountCents || Number(amountCents) <= 0) {
              logger.error('[Trackman Resolve] Day pass price_cents is missing or zero for slug \'day-pass-golf-sim\' — cannot bill');
              billingMessage = ' Day pass billing skipped: price not configured in membership_tiers.';
              await db.execute(sql`INSERT INTO day_pass_purchases 
                 (user_id, product_type, quantity, amount_cents, booking_date, status, trackman_booking_id, created_at)
                 VALUES (${member.id}, ${'day-pass-golf-sim'}, 1, 0, ${bookingDateStr}, ${'pending_price'}, ${booking.trackman_booking_id}, NOW())`);
            } else {
            const customerId = member.stripe_customer_id as string;
            if (!customerId) {
              logger.info('[Trackman Resolve] Skipping day pass billing for visitor - no Stripe customer', { extra: { memberEmail: member.email } });
              billingMessage = ' Day pass record created (no Stripe customer for billing).';
              await db.execute(sql`INSERT INTO day_pass_purchases 
                 (user_id, product_type, quantity, amount_cents, booking_date, status, trackman_booking_id, created_at)
                 VALUES (${member.id}, ${'day-pass-golf-sim'}, 1, ${amountCents}, ${bookingDateStr}, ${'pending'}, ${booking.trackman_booking_id}, NOW())`);
            } else {
            
            const stripe = await getStripeClient();
            
            const paymentMethods = await listCustomerPaymentMethods(customerId);
            
            let paymentStatus = 'pending';
            let paymentIntentId = '';
            
            if (paymentMethods.length > 0) {
              const paymentIntent = await stripe.paymentIntents.create({
                amount: amountCents as number,
                currency: 'usd',
                customer: customerId,
                payment_method: paymentMethods[0].id,
                confirm: true,
                off_session: true,
                description: `Day Pass - Golf Simulator (${bookingDateStr})`,
                metadata: {
                  type: 'day_pass',
                  purpose: 'day_pass_purchase',
                  source: 'trackman_resolve',
                  product_slug: 'day-pass-golf-sim',
                  booking_id: String(booking.id),
                  booking_date: bookingDateStr,
                  visitor_email: member.email as string,
                  created_via: 'trackman_resolve'
                }
              }, {
                idempotencyKey: `trackman_daypass_${booking.id}_${customerId}`
              });
              
              paymentIntentId = paymentIntent.id;
              paymentStatus = paymentIntent.status === 'succeeded' ? 'paid' : 'pending';
              
              if (paymentIntent.status === 'succeeded') {
                billingMessage = ` Day pass charged: $${(Number(amountCents)/ 100).toFixed(2)}.`;
                logger.info('[Trackman Resolve] Day pass charged for visitor : $', { extra: { memberEmail: member.email, amountCents_100_ToFixed_2: (Number(amountCents)/ 100).toFixed(2) } });
              } else {
                billingMessage = ` Day pass payment initiated ($${(Number(amountCents)/ 100).toFixed(2)}).`;
              }
            } else {
              const invoice = await stripe.invoices.create({
                customer: customerId,
                auto_advance: true,
                collection_method: 'send_invoice',
                days_until_due: 1,
                metadata: {
                  type: 'day_pass',
                  purpose: 'day_pass_purchase',
                  source: 'trackman_resolve',
                  product_slug: 'day-pass-golf-sim',
                  booking_id: booking.id.toString(),
                  booking_date: bookingDateStr,
                  visitor_email: member.email as string,
                  created_via: 'trackman_resolve'
                }
              }, {
                idempotencyKey: `inv_trackman_${customerId}_${booking.id}`
              });
              
              await stripe.invoiceItems.create({
                customer: customerId,
                invoice: invoice.id,
                amount: amountCents as number,
                currency: 'usd',
                description: `Day Pass - Golf Simulator (${bookingDateStr})`
              }, {
                idempotencyKey: `invitem_trackman_${customerId}_${invoice.id}_${amountCents}`
              });
              
              await stripe.invoices.finalizeInvoice(invoice.id);
              await stripe.invoices.sendInvoice(invoice.id);
              
              paymentIntentId = invoice.id;
              billingMessage = ` Day pass invoice sent ($${(Number(amountCents)/ 100).toFixed(2)}).`;
              logger.info('[Trackman Resolve] Day pass invoice sent for visitor : $', { extra: { memberEmail: member.email, amountCents_100_ToFixed_2: (Number(amountCents)/ 100).toFixed(2) } });
            }
            
            await db.execute(sql`INSERT INTO day_pass_purchases 
               (user_id, product_type, quantity, amount_cents, stripe_payment_intent_id, booking_date, status, trackman_booking_id, created_at)
               VALUES (${member.id}, ${'day-pass-golf-sim'}, 1, ${amountCents}, ${paymentIntentId}, ${bookingDateStr}, ${paymentStatus}, ${booking.trackman_booking_id}, NOW())`);
            
            updateVisitorTypeByUserId(member.id as number, 'day_pass', 'day_pass_purchase', new Date(bookingDateStr))
              .catch(err => logger.error('[VisitorType] Failed to update day_pass type:', { extra: { err } }));
            }
            }
          }
        } else {
          billingMessage = ' (Day pass already purchased for this date)';
        }
        
        let sessionId = booking.session_id;
        if (!sessionId) {
          if (!booking.resource_id) {
            logger.warn('[Trackman Resolve] Cannot create session for visitor — booking has no resource_id (bay)', { extra: { bookingId: booking.id } });
            billingMessage += ' (No bay assigned — session could not be created. Please set the bay and use Data Integrity to create the session.)';
          } else {
            const sessionResult = await ensureSessionForBooking({
              bookingId: booking.id as number,
              resourceId: booking.resource_id as number,
              sessionDate: bookingDateStr,
              startTime: booking.start_time as string,
              endTime: booking.end_time as string,
              ownerEmail: (member.email as string) || '',
              ownerName: memberFullName,
              ownerUserId: member.id?.toString(),
              trackmanBookingId: booking.trackman_booking_id as string,
              source: 'trackman_import',
              createdBy: 'staff_resolve'
            });
            sessionId = sessionResult.sessionId || null;
            if (!sessionId && sessionResult.error) {
              logger.error('[Trackman Resolve] ensureSessionForBooking failed for visitor', { extra: { bookingId: booking.id, error: sessionResult.error } });
              billingMessage += ' (Session creation failed — please use Data Integrity to create the session.)';
            }
          }
        }
        
        if (sessionId) {
          await db.execute(sql`UPDATE booking_participants 
             SET user_id = ${member.id}, display_name = ${memberFullName}
             WHERE session_id = ${sessionId} AND participant_type = 'owner'`);
          
          const todayPacific = getTodayPacific();
          const isPastBooking = bookingDateStr < todayPacific;
          if (isPastBooking) {
            await db.execute(sql`UPDATE booking_participants SET payment_status = 'paid', paid_at = NOW() WHERE session_id = ${sessionId} AND payment_status = 'pending'`);
          }
          
          await recordUsage(sessionId as number, {
            memberId: (member.email as string).toLowerCase(),
            minutesCharged: Number(booking.duration_minutes) || 60,
          });
        }
      } catch (billingError: unknown) {
        logger.error('[Trackman Resolve] Billing error for visitor', { extra: { billingError } });
        billingMessage = ' (Billing setup failed - manual follow-up needed)';
      }
    }
    
    if (!isVisitor) {
      try {
        const bookingDateStr = typeof booking.request_date === 'string' ? booking.request_date : 
          new Date(booking.request_date as string | number | Date).toISOString().split('T')[0];
        
        let sessionId = booking.session_id;
        if (!sessionId) {
          if (!booking.resource_id) {
            logger.warn('[Trackman Resolve] Cannot create session — booking has no resource_id (bay)', { extra: { bookingId: booking.id } });
            billingMessage += ' (No bay assigned — session could not be created. Please set the bay and use Data Integrity to create the session.)';
          } else {
            const sessionResult = await ensureSessionForBooking({
              bookingId: booking.id as number,
              resourceId: booking.resource_id as number,
              sessionDate: bookingDateStr,
              startTime: booking.start_time as string,
              endTime: booking.end_time as string,
              ownerEmail: (member.email as string) || '',
              ownerName: memberFullName,
              ownerUserId: member.id?.toString(),
              trackmanBookingId: booking.trackman_booking_id as string,
              source: 'trackman_import',
              createdBy: 'staff_resolve'
            });
            sessionId = sessionResult.sessionId || null;
            if (!sessionId && sessionResult.error) {
              logger.error('[Trackman Resolve] ensureSessionForBooking failed', { extra: { bookingId: booking.id, error: sessionResult.error } });
              billingMessage += ' (Session creation failed — please use Data Integrity to create the session.)';
            }
          }
        }
        
        if (sessionId) {
          await db.execute(sql`UPDATE booking_participants 
             SET user_id = ${member.id}, display_name = ${memberFullName}
             WHERE session_id = ${sessionId} AND participant_type = 'owner'`);
          
          try {
            await recalculateSessionFees(sessionId as number, 'checkin');
            logger.info('[Trackman Resolve] Recalculated fees for session', { extra: { sessionId } });
            const { syncBookingInvoice } = await import('../../core/billing/bookingInvoiceService');
            await syncBookingInvoice(booking.id as number, sessionId as number);
          } catch (feeErr: unknown) {
            logger.warn('[Trackman Resolve] Failed to recalculate/sync fees for session', { extra: { sessionId, feeErr } });
          }
          
          const todayPacific = getTodayPacific();
          const isPastBooking = bookingDateStr < todayPacific;
          if (isPastBooking) {
            await db.execute(sql`UPDATE booking_participants SET payment_status = 'paid', paid_at = NOW() WHERE session_id = ${sessionId} AND payment_status = 'pending'`);
          }
          
          const existingUsage = await db.execute(sql`SELECT id, member_id FROM usage_ledger WHERE session_id = ${sessionId} AND (guest_fee IS NULL OR guest_fee = 0) AND source = 'trackman_import' LIMIT 1`);
          
          if (existingUsage.rows.length === 0) {
            await recordUsage(sessionId as number, {
              memberId: (member.email as string).toLowerCase(),
              minutesCharged: Number(booking.duration_minutes) || 60,
            });
            logger.info('[Trackman Resolve] Created session and usage ledger for member, booking #', { extra: { memberEmail: member.email, bookingId: booking.id } });
          } else {
            const existingMemberId = (existingUsage.rows[0] as DbRow).member_id;
            const memberEmailLower = (member.email as string).toLowerCase();
            if (existingMemberId !== memberEmailLower) {
              await db.execute(sql`UPDATE usage_ledger SET member_id = ${memberEmailLower} WHERE session_id = ${sessionId} AND (guest_fee IS NULL OR guest_fee = 0) AND source = 'trackman_import'`);
              logger.info('[Trackman Resolve] Corrected usage ownership for session', { extra: { existingMemberId, newMemberId: memberEmailLower, sessionId } });
            } else {
              logger.info('[Trackman Resolve] Session already has correct usage ledger, skipping', { extra: { sessionId } });
            }
          }
        }
      } catch (sessionError: unknown) {
        logger.error('[Trackman Resolve] Session creation error for member', { extra: { sessionError } });
        billingMessage += ' (Session setup may need manual review)';
      }
    }

    await logFromRequest(req, {
      action: 'link_trackman_to_member',
      resourceType: 'booking',
      resourceId: id as string,
      resourceName: `Trackman ${booking.trackman_booking_id || id}`,
      details: { 
        linkedEmail: member.email, 
        memberName: `${member.first_name} ${member.last_name}`,
        trackmanId: booking.trackman_booking_id,
        isVisitor,
        billingApplied: billingMessage.length > 0
      }
    });
    
    res.json({ 
      success: true, 
      message: `Booking linked to ${member.first_name} ${member.last_name}${billingMessage}${emailLearningMessage}`,
      emailLearned: emailLearningMessage.length > 0 ? originalEmailForLearning : null
    });
  } catch (error: unknown) {
    logger.error('Error resolving unmatched booking', { error: error instanceof Error ? error : new Error(String(error)) });
    const errorMessage = (error as Error)?.message || 'Unknown error';
    if (errorMessage.includes('Stripe') || errorMessage.includes('stripe')) {
      return res.status(500).json({ error: `Billing error: ${errorMessage}` });
    }
    if (errorMessage.includes('constraint') || errorMessage.includes('duplicate')) {
      return res.status(400).json({ error: 'This booking may already be assigned to a member' });
    }
    res.status(500).json({ error: `Failed to resolve booking: ${errorMessage}` });
  }
});

router.post('/api/admin/trackman/auto-resolve-same-email', isStaffOrAdmin, async (req, res) => {
  try {
    const { originalEmail, memberEmail: rawMemberEmail, excludeTrackmanId } = req.body;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();
    
    if (!originalEmail) {
      return res.status(400).json({ error: 'originalEmail is required' });
    }
    
    const resolveToEmail = memberEmail || null;
    const staffEmail = req.session?.user?.email || 'admin';
    
    let bookingRequestsResolved = 0;
    if (resolveToEmail) {
      const memberResult = await db.execute(sql`SELECT id, email, first_name, last_name, role FROM users WHERE LOWER(email) = LOWER(${resolveToEmail})`);
      
      if (memberResult.rows.length > 0) {
        const member = memberResult.rows[0] as DbRow;
        
        const bookingRequestsResult = await db.execute(sql`SELECT id, trackman_booking_id 
           FROM booking_requests 
           WHERE is_unmatched = true 
           AND (${excludeTrackmanId || null}::text IS NULL OR trackman_booking_id != ${excludeTrackmanId || null})
           AND (
             trackman_customer_notes ILIKE ${`%${originalEmail}%`}
             OR staff_notes ILIKE ${`%${originalEmail}%`}
           )`);
        
        for (const booking of bookingRequestsResult.rows as DbRow[]) {
          try {
            if (member.role === 'golf_instructor' || 
                (await db.execute(sql`SELECT 1 FROM staff_users WHERE LOWER(email) = LOWER(${member.email}) AND role = 'golf_instructor' AND is_active = true`)).rows.length > 0) {
              continue;
            }
            
            const sameEmailName = `${member.first_name} ${member.last_name}`.trim();
            await db.execute(sql`UPDATE booking_requests 
                 SET user_id = ${member.id}, 
                     user_email = ${member.email}, 
                     user_name = ${sameEmailName},
                     is_unmatched = false,
                     staff_notes = COALESCE(staff_notes, '') || ${` [Auto-resolved via same email by ${staffEmail} on ${pacificNow()}]`},
                     updated_at = NOW()
                 WHERE id = ${booking.id}`);
            
            const sameEmailDetails = await db.execute(sql`SELECT session_id, request_date, start_time, end_time, duration_minutes, resource_id, trackman_booking_id FROM booking_requests WHERE id = ${booking.id}`);
            const sameEmailBD = sameEmailDetails.rows[0] as DbRow;
            let sameEmailSessionId = sameEmailBD?.session_id;
            
            if (sameEmailSessionId) {
              const sessionCheck = await db.execute(sql`SELECT id FROM booking_sessions WHERE id = ${sameEmailSessionId} LIMIT 1`);
              if (sessionCheck.rows.length === 0) {
                logger.warn('[Auto-resolve] Orphaned session_id on booking, clearing', { extra: { bookingId: booking.id, orphanedSessionId: sameEmailSessionId } });
                await db.execute(sql`UPDATE booking_requests SET session_id = NULL WHERE id = ${booking.id}`);
                sameEmailSessionId = null;
              }
            }
            
            if (!sameEmailSessionId && sameEmailBD && sameEmailBD.resource_id) {
              const sameEmailDateStr = typeof sameEmailBD.request_date === 'string' ? sameEmailBD.request_date :
                new Date(sameEmailBD.request_date as string | number | Date).toISOString().split('T')[0];
              const sameEmailSessionResult = await ensureSessionForBooking({
                bookingId: booking.id as number,
                resourceId: sameEmailBD.resource_id as number,
                sessionDate: sameEmailDateStr,
                startTime: sameEmailBD.start_time as string,
                endTime: sameEmailBD.end_time as string,
                ownerEmail: (member.email as string) || '',
                ownerName: sameEmailName,
                ownerUserId: member.id?.toString(),
                trackmanBookingId: sameEmailBD.trackman_booking_id as string,
                source: 'trackman_import',
                createdBy: 'staff_auto_resolve'
              });
              sameEmailSessionId = sameEmailSessionResult.sessionId || null;
              if (sameEmailSessionId) {
                const todayPacific = getTodayPacific();
                const isPastBooking = sameEmailDateStr < todayPacific;
                if (isPastBooking) {
                  await db.execute(sql`UPDATE booking_participants SET payment_status = 'paid', paid_at = NOW() WHERE session_id = ${sameEmailSessionId} AND payment_status = 'pending'`);
                }
                await recordUsage(sameEmailSessionId as number, {
                  memberId: (member.email as string).toLowerCase(),
                  minutesCharged: Number(sameEmailBD.duration_minutes) || 60,
                });
                try {
                  await recalculateSessionFees(sameEmailSessionId as number, 'checkin');
                } catch (feeErr: unknown) {
                  logger.warn('[Auto-resolve] Failed to recalculate fees for auto-resolved session', { extra: { sessionId: sameEmailSessionId, feeErr } });
                }
                logger.info('[Auto-resolve] Created session for auto-resolved booking', { extra: { bookingId: booking.id, sessionId: sameEmailSessionId } });
              }
            }
            
            if (sameEmailSessionId) {
              await db.execute(sql`UPDATE booking_participants 
                   SET user_id = ${member.id}, display_name = ${sameEmailName}
                   WHERE session_id = ${sameEmailSessionId} AND participant_type = 'owner'`);
            }
            bookingRequestsResolved++;
          } catch (err: unknown) {
            logger.error('[Auto-resolve] Failed to resolve booking', { extra: { id: booking.id, error: getErrorMessage(err) } });
          }
        }
        
        if (bookingRequestsResolved > 0) {
          logger.info('[Auto-resolve] Resolved bookings from booking_requests for', { extra: { bookingRequestsResolved, originalEmail } });
        }
      }
    }
    
    const unmatchedResult = await db.execute(sql`SELECT id, trackman_booking_id, user_name, original_email, booking_date, 
              start_time, end_time, duration_minutes, bay_number, notes
       FROM trackman_unmatched_bookings 
       WHERE LOWER(TRIM(original_email)) = LOWER(TRIM(${originalEmail})) 
         AND resolved_at IS NULL
         AND (${excludeTrackmanId || null}::text IS NULL OR trackman_booking_id != ${excludeTrackmanId || null})`);
    
    if (unmatchedResult.rows.length === 0 && bookingRequestsResolved === 0) {
      return res.json({ success: true, autoResolved: 0, message: 'No additional bookings to auto-resolve' });
    }
    
    if (unmatchedResult.rows.length === 0) {
      return res.json({ success: true, autoResolved: bookingRequestsResolved, message: `Auto-resolved ${bookingRequestsResolved} booking(s)` });
    }
    
    let autoResolved = 0;
    const errors: string[] = [];
    
    for (const booking of unmatchedResult.rows as DbRow[]) {
      try {
        let targetEmail = resolveToEmail;
        
        if (!targetEmail) {
          const emailMappingResult = await db.execute(sql`SELECT ule.primary_email as email FROM user_linked_emails ule
             WHERE LOWER(ule.linked_email) = LOWER(${originalEmail})
             LIMIT 1`);
          
          if (emailMappingResult.rows.length > 0) {
            targetEmail = (emailMappingResult.rows[0] as DbRow).email;
          }
        }
        
        if (!targetEmail) continue;
        
        const memberResult = await db.execute(sql`SELECT id, email, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${targetEmail})`);
        
        if (memberResult.rows.length === 0) continue;
        
        const member = memberResult.rows[0] as DbRow;
        let resourceId = 1;
        if (booking.bay_number) {
          const bayNum = parseInt(String(booking.bay_number).replace(/\D/g, ''));
          if (bayNum >= 1 && bayNum <= 4) resourceId = bayNum;
        }
        
        await db.execute(sql`INSERT INTO booking_requests (
            user_id, user_email, user_name, resource_id, request_date, start_time, end_time,
            duration_minutes, status, trackman_booking_id, is_unmatched, staff_notes, created_at, updated_at
          ) VALUES (${member.id}, ${member.email}, ${`${member.first_name} ${member.last_name}`}, ${resourceId}, ${booking.booking_date}, ${booking.start_time}, ${booking.end_time}, ${booking.duration_minutes || 60}, 'approved', ${booking.trackman_booking_id}, false, ${`[Auto-resolved from same email by ${staffEmail}] ${booking.notes || ''}`}, NOW(), NOW())
          ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
            user_id = EXCLUDED.user_id,
            user_email = EXCLUDED.user_email,
            user_name = EXCLUDED.user_name,
            is_unmatched = false,
            staff_notes = booking_requests.staff_notes || ' ' || EXCLUDED.staff_notes,
            updated_at = NOW()
          RETURNING id`);
        
        await db.execute(sql`UPDATE trackman_unmatched_bookings SET resolved_at = NOW(), resolved_email = ${member.email}, resolved_by = ${staffEmail} WHERE id = ${booking.id}`);
        
        autoResolved++;
      } catch (bookingErr: unknown) {
        errors.push(`Booking ${booking.id}: ${getErrorMessage(bookingErr)}`);
      }
    }
    
    const totalResolved = autoResolved + bookingRequestsResolved;
    
    if (totalResolved > 0) {
      await logFromRequest(req, {
        action: 'import_trackman',
        resourceType: 'booking',
        resourceName: `Auto-resolved ${totalResolved} bookings`,
        details: { originalEmail, autoResolved: totalResolved, legacyResolved: autoResolved, bookingRequestsResolved, errors: errors.length > 0 ? errors : undefined }
      });
    }
    
    res.json({ 
      success: true, 
      autoResolved: totalResolved,
      message: totalResolved > 0 
        ? `Auto-resolved ${totalResolved} additional booking(s) with same email`
        : 'No additional bookings to auto-resolve'
    });
  } catch (error: unknown) {
    logger.error('Error auto-resolving bookings', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to auto-resolve bookings', details: safeErrorDetail(error) });
  }
});

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
      sql`br.status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')`,
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
             staff_notes = COALESCE(staff_notes, '') || ${` [Unmatched from ${normalizedEmail} by ${unmatchedBy} on ${pacificNow()}]`}
         WHERE id = ${booking.id}`);
      affectedCount++;
    }
    
    if (affectedCount > 0) {
      logFromRequest(req, 'unmatch_booking', 'booking', undefined, normalizedEmail, {
        email: normalizedEmail,
        affectedCount,
        unmatchedAt: pacificNow()
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
           AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
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

export default router;
