import { db } from '../../db';
import { bookingRequests, trackmanUnmatchedBookings, trackmanImportRuns } from '../../../shared/schema';
import { eq, or, ilike, and, sql } from 'drizzle-orm';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';
import { bookingEvents } from '../bookingEvents';
import { toTextArrayLiteral } from '../../utils/sqlArrayLiteral';
import { cancelPaymentIntent } from '../stripe';
import { logger } from '../logger';
import { useGuestPass } from '../../routes/guestPasses';
import type { SessionCheckRow, PaymentIntentRow } from './constants';
import { isPlaceholderEmail, isFutureBooking } from './constants';
import { parseNotesForPlayers } from './parser';
import { getGolfInstructorEmails } from './matching';
import { createTrackmanSessionAndParticipants } from './sessionMapper';

async function insertBookingIfNotExists(
  booking: typeof trackmanUnmatchedBookings.$inferSelect,
  memberEmail: string,
  resolvedBy?: string
): Promise<{ inserted: boolean; linked?: boolean; reason?: string; finalStatus?: string; bookingId?: number }> {
  const trackmanIdPattern = `[Trackman Import ID:${booking.trackmanBookingId}]`;
  
  const existingTrackman = await db.select({ id: bookingRequests.id })
    .from(bookingRequests)
    .where(sql`trackman_booking_id = ${booking.trackmanBookingId} OR notes LIKE ${`%${trackmanIdPattern}%`}`)
    .limit(1);

  if (existingTrackman.length > 0) {
    return { inserted: false, reason: 'Already imported (Trackman ID exists)' };
  }

  const resourceId = parseInt(booking.bayNumber || '') || null;
  if (booking.bookingDate && booking.startTime) {
    const existingWithFinalStatus = await db.select({ 
      id: bookingRequests.id, 
      status: bookingRequests.status,
      trackmanBookingId: bookingRequests.trackmanBookingId 
    })
      .from(bookingRequests)
      .where(sql`
        LOWER(user_email) = LOWER(${memberEmail})
        AND request_date = ${booking.bookingDate}
        AND start_time = ${booking.startTime}
        AND status IN ('attended', 'no_show')
      `)
      .limit(1);

    if (existingWithFinalStatus.length > 0) {
      const existing = existingWithFinalStatus[0];
      if (!existing.trackmanBookingId && booking.trackmanBookingId) {
        await db.update(bookingRequests)
          .set({ trackmanBookingId: booking.trackmanBookingId })
          .where(eq(bookingRequests.id, existing.id));
        process.stderr.write(`[Trackman Import] Linked Trackman ID ${booking.trackmanBookingId} to existing booking #${existing.id} (status: ${existing.status})\n`);
        return { inserted: false, linked: true, reason: `Linked Trackman ID to existing booking with status: ${existing.status}` };
      } else if (existing.trackmanBookingId === booking.trackmanBookingId) {
        return { inserted: false, reason: `Already linked (idempotent match)` };
      }
      return { inserted: false, reason: `Booking already exists with status: ${existing.status}` };
    }
  }

  if (resourceId && booking.bookingDate && booking.startTime) {
    const existingDuplicate = await db.select({ 
      id: bookingRequests.id,
      trackmanBookingId: bookingRequests.trackmanBookingId 
    })
      .from(bookingRequests)
      .where(sql`
        LOWER(user_email) = LOWER(${memberEmail})
        AND request_date = ${booking.bookingDate}
        AND start_time = ${booking.startTime}
        AND resource_id = ${resourceId}
        AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
      `)
      .limit(1);

    if (existingDuplicate.length > 0) {
      const existing = existingDuplicate[0];
      if (!existing.trackmanBookingId && booking.trackmanBookingId) {
        await db.update(bookingRequests)
          .set({ trackmanBookingId: booking.trackmanBookingId })
          .where(eq(bookingRequests.id, existing.id));
        process.stderr.write(`[Trackman Import] Linked Trackman ID ${booking.trackmanBookingId} to existing app booking #${existing.id}\n`);
        return { inserted: false, linked: true, reason: 'Linked Trackman ID to existing app booking' };
      } else if (existing.trackmanBookingId === booking.trackmanBookingId) {
        return { inserted: false, reason: 'Already linked (idempotent match)' };
      }
      return { inserted: false, reason: 'Duplicate booking exists (same member/date/time/bay)' };
    }
  }

  const isUpcoming = isFutureBooking(booking.bookingDate || '', booking.startTime || '');
  const originalStatus = booking.status || 'attended';
  let finalStatus: string;
  
  if (isUpcoming) {
    finalStatus = 'approved';
    if (originalStatus !== 'approved') {
      process.stderr.write(`[Trackman Import] Status recalculated: ${originalStatus} -> approved (future booking on ${booking.bookingDate})\n`);
    }
  } else {
    if (originalStatus === 'approved') {
      finalStatus = 'attended';
      process.stderr.write(`[Trackman Import] Status recalculated: approved -> attended (past booking on ${booking.bookingDate})\n`);
    } else {
      finalStatus = originalStatus;
    }
  }

  const parsedPlayers = parseNotesForPlayers(booking.notes || '');
  const actualGuestCount = parsedPlayers.filter(p => p.type === 'guest').length;

  let memberUserId: string | null = null;
  const userIdLookup = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${memberEmail}) AND archived_at IS NULL LIMIT 1`);
  if (userIdLookup.rows.length > 0) {
    memberUserId = (userIdLookup.rows[0] as { id: string }).id;
  }

  let insertResult;
  try {
    insertResult = await db.insert(bookingRequests).values({
      userEmail: memberEmail,
      userName: booking.userName,
      userId: memberUserId,
      resourceId: resourceId,
      requestDate: booking.bookingDate,
      startTime: booking.startTime,
      durationMinutes: booking.durationMinutes || 60,
      endTime: booking.endTime,
      notes: `[Trackman Import ID:${booking.trackmanBookingId}] ${booking.notes || ''}`,
      status: finalStatus,
      createdAt: booking.createdAt,
      trackmanBookingId: booking.trackmanBookingId,
      guestCount: actualGuestCount,
    }).returning({ id: bookingRequests.id });
  } catch (insertErr: unknown) {
    if (getErrorMessage(insertErr)?.includes('duplicate key') || getErrorCode(insertErr) === '23505') {
      process.stderr.write(`[Trackman Import] Booking ${booking.trackmanBookingId} already exists (race condition) - skipping\n`);
      return { inserted: false, reason: 'Already imported (race condition)' };
    }
    throw insertErr;
  }

  const bookingId = insertResult[0]?.id;

  if (bookingId && (booking.playerCount || 1) >= 1) {
    const guests = parsedPlayers.filter(p => p.type === 'guest');
    const ownerNameNormalized = (booking.userName || memberEmail).toLowerCase().trim();
    for (let i = 0; i < guests.length; i++) {
      const guestNameNormalized = (guests[i].name || '').toLowerCase().trim();
      
      if (guestNameNormalized && (
        guestNameNormalized === ownerNameNormalized ||
        ownerNameNormalized.includes(guestNameNormalized) ||
        guestNameNormalized.includes(ownerNameNormalized.split(' ')[0])
      )) {
        process.stderr.write(`[Trackman Import] Skipping guest entry for "${guests[i].name}" - matches owner name "${booking.userName || memberEmail}"\n`);
        continue;
      }
      
      const hasGuestInfo = !!(guests[i].name?.trim() || guests[i].email?.trim());
      if (hasGuestInfo) {
        const guestPassResult = await useGuestPass(memberEmail, guests[i].name || undefined, isUpcoming);
        if (!guestPassResult.success) {
          process.stderr.write(`[Trackman Import] Guest pass deduction failed for ${memberEmail} (guest: ${guests[i].name}): ${guestPassResult.error}\n`);
        } else {
          process.stderr.write(`[Trackman Import] Deducted guest pass for ${memberEmail} (guest: ${guests[i].name}), ${guestPassResult.remaining} remaining\n`);
        }
      } else {
        process.stderr.write(`[Trackman Import] Guest has no identifying info - skipping guest pass, fee will be charged for ${memberEmail}\n`);
      }
    }
  }

  if (finalStatus === 'approved') {
    const formattedDate = new Date(booking.bookingDate + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles'
    });
    const formatTime = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hour12 = h % 12 || 12;
      return `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`;
    };
    
    bookingEvents.publish('booking_approved', {
      bookingId: 0,
      memberEmail: memberEmail,
      memberName: booking.userName || undefined,
      resourceId: resourceId || undefined,
      bookingDate: booking.bookingDate || '',
      startTime: booking.startTime || '',
      endTime: booking.endTime || undefined,
      status: 'approved',
      isTrackmanImport: true
    }, {
      notifyMember: true,
      notifyStaff: true,
      memberNotification: {
        title: 'Booking Confirmed',
        message: `Your golf simulator booking for ${formattedDate} at ${formatTime(booking.startTime || '')} has been confirmed via Trackman.`,
        type: 'booking_approved'
      }
    }).catch(err => logger.error(`[Trackman] Booking event publish failed`, { error: err instanceof Error ? err : new Error(String(err)) }));
  }

  return { inserted: true, finalStatus, bookingId };
}

export async function resolveUnmatchedBooking(
  unmatchedId: number, 
  memberEmail: string, 
  resolvedBy: string
): Promise<{ success: boolean; resolved: number; autoResolved: number }> {
  const unmatched = await db.select()
    .from(trackmanUnmatchedBookings)
    .where(eq(trackmanUnmatchedBookings.id, unmatchedId));

  if (unmatched.length === 0) return { success: false, resolved: 0, autoResolved: 0 };

  const booking = unmatched[0];
  const originalEmail = booking.originalEmail?.toLowerCase().trim();

  const insertResult = await insertBookingIfNotExists(booking, memberEmail, resolvedBy);

  if (insertResult.inserted && insertResult.bookingId) {
    const existingSession = await db.execute(sql`
      SELECT session_id FROM booking_requests WHERE id = ${insertResult.bookingId} AND session_id IS NOT NULL
    `);
    
    if (existingSession.rows.length === 0 || !(existingSession.rows[0] as unknown as SessionCheckRow)?.session_id) {
      const bookingDate = booking.bookingDate ? new Date(booking.bookingDate).toISOString().split('T')[0] : '';
      const startTime = booking.startTime?.toString() || '';
      const endTime = booking.endTime?.toString() || '';
      
      const parsedPlayers = parseNotesForPlayers(booking.notes || '');
      const resourceId = parseInt(booking.bayNumber || '0') || 1;
      const isPast = insertResult.finalStatus === 'attended' || insertResult.finalStatus === 'completed';

      try {
        const stableTrackmanId = booking.trackmanBookingId || `booking-${insertResult.bookingId}`;
        
        await createTrackmanSessionAndParticipants({
          bookingId: insertResult.bookingId,
          trackmanBookingId: stableTrackmanId,
          resourceId,
          sessionDate: bookingDate,
          startTime,
          endTime,
          durationMinutes: booking.durationMinutes || 60,
          ownerEmail: memberEmail,
          ownerName: booking.userName || 'Unknown',
          parsedPlayers,
          membersByEmail: new Map(),
          trackmanEmailMapping: new Map(),
          isPast
        });
        process.stderr.write(`[Trackman Resolve] Created Session & Ledger for Booking #${insertResult.bookingId}\n`);
      } catch (sessionErr: unknown) {
        process.stderr.write(`[Trackman Resolve] Warning: Session creation failed for Booking #${insertResult.bookingId}: ${sessionErr}\n`);
      }
    } else {
      process.stderr.write(`[Trackman Resolve] Booking #${insertResult.bookingId} already has session, skipping creation\n`);
    }
  }

  if (insertResult.inserted && insertResult.finalStatus === 'attended') {
    await db.execute(sql`
      UPDATE users 
      SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
      WHERE email = ${memberEmail}
    `);
  }
  
  if (insertResult.linked) {
    process.stderr.write(`[Trackman Resolve] Linked existing booking for ${memberEmail}: ${insertResult.reason}\n`);
  }

  if (originalEmail && isPlaceholderEmail(originalEmail)) {
    const emailAsJsonb = JSON.stringify(originalEmail);
    await db.execute(sql`
      UPDATE users 
      SET manually_linked_emails = 
        CASE 
          WHEN COALESCE(manually_linked_emails, '[]'::jsonb) ? ${originalEmail}
          THEN manually_linked_emails
          ELSE COALESCE(manually_linked_emails, '[]'::jsonb) || ${emailAsJsonb}::jsonb
        END
      WHERE email = ${memberEmail}
    `);
    process.stderr.write(`[Trackman Resolve] Saved email mapping: ${originalEmail} -> ${memberEmail}\n`);
  }

  await db.update(trackmanUnmatchedBookings)
    .set({
      resolvedEmail: memberEmail,
      resolvedAt: new Date(),
      resolvedBy: resolvedBy
    })
    .where(eq(trackmanUnmatchedBookings.id, unmatchedId));

  if (insertResult.inserted && insertResult.finalStatus === 'approved') {
    bookingEvents.publish('booking_approved', {
      bookingId: 0,
      memberEmail: memberEmail,
      memberName: booking.userName || undefined,
      resourceId: parseInt(booking.bayNumber || '') || undefined,
      bookingDate: booking.bookingDate || '',
      startTime: booking.startTime || '',
      status: 'approved',
      isTrackmanImport: true
    }, {
      notifyMember: true,
      notifyStaff: true,
      memberNotification: {
        title: 'Booking Confirmed',
        message: `Your golf simulator booking has been confirmed.`,
        type: 'booking_approved'
      }
    }).catch(err => logger.error(`[Trackman Resolve] Booking event publish failed`, { error: err instanceof Error ? err : new Error(String(err)) }));
  }

  let autoResolved = 0;
  if (originalEmail) {
    const otherUnmatched = await db.select()
      .from(trackmanUnmatchedBookings)
      .where(sql`LOWER(TRIM(original_email)) = ${originalEmail} AND resolved_email IS NULL AND id != ${unmatchedId}`);

    for (const other of otherUnmatched) {
      const otherResult = await insertBookingIfNotExists(other, memberEmail, resolvedBy);

      if (otherResult.inserted && otherResult.bookingId) {
        const otherExistingSession = await db.execute(sql`
          SELECT session_id FROM booking_requests WHERE id = ${otherResult.bookingId} AND session_id IS NOT NULL
        `);
        
        if (otherExistingSession.rows.length === 0 || !(otherExistingSession.rows[0] as unknown as SessionCheckRow)?.session_id) {
          const otherBookingDate = other.bookingDate ? new Date(other.bookingDate).toISOString().split('T')[0] : '';
          const otherStartTime = other.startTime?.toString() || '';
          const otherEndTime = other.endTime?.toString() || '';
          const otherParsedPlayers = parseNotesForPlayers(other.notes || '');
          const otherResourceId = parseInt(other.bayNumber || '0') || 1;
          const otherIsPast = otherResult.finalStatus === 'attended' || otherResult.finalStatus === 'completed';

          try {
            const otherStableTrackmanId = other.trackmanBookingId || `booking-${otherResult.bookingId}`;
            
            await createTrackmanSessionAndParticipants({
              bookingId: otherResult.bookingId,
              trackmanBookingId: otherStableTrackmanId,
              resourceId: otherResourceId,
              sessionDate: otherBookingDate,
              startTime: otherStartTime,
              endTime: otherEndTime,
              durationMinutes: other.durationMinutes || 60,
              ownerEmail: memberEmail,
              ownerName: other.userName || 'Unknown',
              parsedPlayers: otherParsedPlayers,
              membersByEmail: new Map(),
              trackmanEmailMapping: new Map(),
              isPast: otherIsPast
            });
            process.stderr.write(`[Trackman Resolve] Created Session & Ledger for auto-resolved Booking #${otherResult.bookingId}\n`);
          } catch (sessionErr: unknown) {
            process.stderr.write(`[Trackman Resolve] Warning: Session creation failed for auto-resolved Booking #${otherResult.bookingId}: ${sessionErr}\n`);
          }
        } else {
          process.stderr.write(`[Trackman Resolve] Auto-resolved Booking #${otherResult.bookingId} already has session, skipping\n`);
        }
      }

      if (otherResult.inserted && otherResult.finalStatus === 'attended') {
        await db.execute(sql`
          UPDATE users 
          SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
          WHERE email = ${memberEmail}
        `);
      }

      if (otherResult.inserted && otherResult.finalStatus === 'approved') {
        bookingEvents.publish('booking_approved', {
          bookingId: 0,
          memberEmail: memberEmail,
          memberName: other.userName || undefined,
          resourceId: parseInt(other.bayNumber || '') || undefined,
          bookingDate: other.bookingDate || '',
          startTime: other.startTime || '',
          status: 'approved',
          isTrackmanImport: true
        }, {
          notifyMember: true,
          notifyStaff: false,
          memberNotification: {
            title: 'Booking Confirmed',
            message: `Your golf simulator booking has been confirmed.`,
            type: 'booking_approved'
          }
        }).catch(err => logger.error(`[Trackman Resolve] Auto-resolved booking notification failed`, { error: err instanceof Error ? err : new Error(String(err)) }));
      }

      await db.update(trackmanUnmatchedBookings)
        .set({
          resolvedEmail: memberEmail,
          resolvedAt: new Date(),
          resolvedBy: resolvedBy
        })
        .where(eq(trackmanUnmatchedBookings.id, other.id));

      autoResolved++;
    }

    if (autoResolved > 0) {
      process.stderr.write(`[Trackman Resolve] Auto-resolved ${autoResolved} additional bookings with same email: ${originalEmail}\n`);
    }
  }

  return { success: true, resolved: 1 + autoResolved, autoResolved };
}

export async function getUnmatchedBookings(options?: { 
  resolved?: boolean; 
  limit?: number; 
  offset?: number;
  search?: string;
}): Promise<{ data: Record<string, unknown>[]; totalCount: number }> {
  let whereCondition = sql`1=1`;
  
  if (options?.resolved === false) {
    whereCondition = sql`resolved_email IS NULL`;
  } else if (options?.resolved === true) {
    whereCondition = sql`resolved_email IS NOT NULL`;
  }

  if (options?.search && options.search.trim()) {
    const searchTerm = `%${options.search.trim().toLowerCase()}%`;
    whereCondition = sql`${whereCondition} AND (LOWER(user_name) LIKE ${searchTerm} OR LOWER(original_email) LIKE ${searchTerm})`;
  }

  const [data, countResult] = await Promise.all([
    db.select()
      .from(trackmanUnmatchedBookings)
      .where(whereCondition)
      .orderBy(sql`booking_date DESC`)
      .limit(options?.limit || 100)
      .offset(options?.offset || 0),
    db.select({ count: sql<number>`count(*)::int` })
      .from(trackmanUnmatchedBookings)
      .where(whereCondition)
  ]);

  return {
    data,
    totalCount: countResult[0]?.count || 0
  };
}

export async function getImportRuns() {
  return await db.select()
    .from(trackmanImportRuns)
    .orderBy(sql`created_at DESC`);
}

export async function cleanupHistoricalLessons(dryRun = false): Promise<{
  logs: string[];
  convertedBookings: number;
  resolvedUnmatched: number;
  skipped: number;
}> {
  const logs: string[] = [];
  const log = (msg: string) => { logger.info(msg); logs.push(msg); };

  log(`[Lesson Cleanup] Starting run (Dry Run: ${dryRun})...`);

  const INSTRUCTOR_EMAILS = await getGolfInstructorEmails();
  log(`[Lesson Cleanup] Found ${INSTRUCTOR_EMAILS.length} golf instructors: ${INSTRUCTOR_EMAILS.join(', ') || '(none)'}`);

  let convertedBookings = 0;
  let resolvedUnmatched = 0;
  let skipped = 0;

  const lessonBookingsResult = await db.execute(sql`
    SELECT 
      br.id,
      br.user_name,
      br.user_email,
      br.resource_id,
      br.request_date,
      br.start_time,
      br.end_time,
      br.duration_minutes,
      br.notes,
      br.trackman_booking_id,
      br.session_id
    FROM booking_requests br
    WHERE br.status NOT IN ('cancelled', 'cancellation_pending', 'deleted')
      AND br.archived_at IS NULL
      AND (
        LOWER(br.user_email) = ANY(${toTextArrayLiteral(INSTRUCTOR_EMAILS)}::text[])
        OR LOWER(br.user_name) LIKE '%lesson%'
        OR LOWER(br.notes) LIKE '%lesson%'
      )
    ORDER BY br.request_date DESC
    LIMIT 1000
  `);

  const lessonBookings = lessonBookingsResult.rows;
  log(`[Lesson Cleanup] Found ${lessonBookings.length} lesson bookings to process.`);

  for (const booking of lessonBookings) {
    if (!booking.resource_id || !booking.request_date || !booking.start_time) {
      skipped++;
      continue;
    }

    const bookingDate = booking.request_date instanceof Date 
      ? booking.request_date.toISOString().split('T')[0]
      : booking.request_date;
    const endTime = booking.end_time || booking.start_time;

    const existingBlock = await db.execute(sql`
      SELECT ab.id FROM availability_blocks ab
      WHERE ab.resource_id = ${booking.resource_id}
        AND ab.block_date = ${bookingDate}
        AND ab.start_time < ${endTime}::time
        AND ab.end_time > ${booking.start_time}::time
      LIMIT 1
    `);

    const blockAlreadyExists = existingBlock.rows.length > 0;

    if (!dryRun) {
      if (!blockAlreadyExists) {
        await db.execute(sql`
          INSERT INTO availability_blocks 
            (resource_id, block_date, start_time, end_time, block_type, notes, created_by)
          VALUES (${booking.resource_id}, ${bookingDate}, ${booking.start_time}, ${endTime}, 'blocked', ${`Lesson - ${booking.user_name || 'Unknown'}`}, 'system_cleanup')
        `);
      }

      await db.execute(sql`
        UPDATE booking_requests 
        SET status = 'cancelled',
            archived_at = NOW(),
            archived_by = 'system_cleanup',
            staff_notes = COALESCE(staff_notes, '') || ' [Converted to Availability Block by cleanupHistoricalLessons]',
            updated_at = NOW()
        WHERE id = ${booking.id}
      `);

      await db.execute(sql`DELETE FROM booking_participants WHERE session_id IN (
        SELECT id FROM booking_sessions WHERE trackman_booking_id = ${booking.trackman_booking_id}
      )`);

      await db.execute(sql`DELETE FROM usage_ledger WHERE booking_id = ${booking.id}`);

      const pendingIntents = await db.execute(sql`
        SELECT stripe_payment_intent_id FROM stripe_payment_intents 
        WHERE booking_id = ${booking.id} AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')
      `);
      
      for (const intent of pendingIntents.rows) {
        try {
          const stripe = await import('../stripe').then(m => m.getStripeClient());
          await stripe.paymentIntents.cancel((intent as unknown as PaymentIntentRow).stripe_payment_intent_id);
          log(`[Lesson Cleanup] Cancelled payment intent ${(intent as unknown as PaymentIntentRow).stripe_payment_intent_id}`);
        } catch (err: unknown) {
          log(`[Lesson Cleanup] Could not cancel payment intent ${(intent as unknown as PaymentIntentRow).stripe_payment_intent_id}: ${getErrorMessage(err)}`);
        }
      }

      if (booking.session_id) {
        await db.execute(sql`DELETE FROM booking_sessions WHERE id = ${booking.session_id}`);
      }
    }

    log(`[Lesson Cleanup] ${blockAlreadyExists ? 'Block exists, cleaned up booking' : 'Converted Booking'} #${booking.id} (${booking.user_name || 'Unknown'}).`);
    convertedBookings++;
  }

  const unmatchedRows = await db.select({
    id: trackmanUnmatchedBookings.id,
    userName: trackmanUnmatchedBookings.userName,
    bookingDate: trackmanUnmatchedBookings.bookingDate,
    startTime: trackmanUnmatchedBookings.startTime,
    endTime: trackmanUnmatchedBookings.endTime,
    bayNumber: trackmanUnmatchedBookings.bayNumber,
    notes: trackmanUnmatchedBookings.notes,
    trackmanBookingId: trackmanUnmatchedBookings.trackmanBookingId,
  })
    .from(trackmanUnmatchedBookings)
    .where(and(
      sql`${trackmanUnmatchedBookings.resolvedAt} IS NULL`,
      or(
        ilike(trackmanUnmatchedBookings.userName, '%lesson%'),
        ilike(trackmanUnmatchedBookings.notes, '%lesson%')
      )
    ))
    .limit(500);

  const unmatched = unmatchedRows;
  log(`[Lesson Cleanup] Found ${unmatched.length} unmatched lesson entries to resolve.`);

  for (const item of unmatched) {
    const resourceId = parseInt(item.bayNumber) || null;
    
    if (!resourceId || resourceId <= 0) {
      log(`[Lesson Cleanup] Skipping Unmatched Item #${item.id} - invalid bay number: ${item.bayNumber}`);
      skipped++;
      continue;
    }

    if (!item.bookingDate || !item.startTime) {
      skipped++;
      continue;
    }

    const bookingDate = (item.bookingDate as string | Date) instanceof Date 
      ? (item.bookingDate as unknown as Date).toISOString().split('T')[0]
      : item.bookingDate;

    if (!dryRun) {
      const existingBlock = await db.execute(sql`
        SELECT ab.id FROM availability_blocks ab
        WHERE ab.resource_id = ${resourceId}
          AND ab.block_date = ${bookingDate}
          AND ab.start_time < ${item.endTime || item.startTime}::time
          AND ab.end_time > ${item.startTime}::time
        LIMIT 1
      `);

      if (existingBlock.rows.length === 0) {
        await db.execute(sql`
          INSERT INTO availability_blocks 
            (resource_id, block_date, start_time, end_time, block_type, notes, created_by)
          VALUES (${resourceId}, ${bookingDate}, ${item.startTime}, ${item.endTime || item.startTime}, 'blocked', ${`Lesson - ${item.userName || 'Unknown'}`}, 'system_cleanup')
        `);
      }

      await db.execute(sql`
        UPDATE trackman_unmatched_bookings
        SET resolved_at = NOW(),
            resolved_by = 'system_cleanup',
            match_attempt_reason = 'Converted to Availability Block (Lesson Cleanup)'
        WHERE id = ${item.id}
      `);
    }

    log(`[Lesson Cleanup] Resolved unmatched lesson #${item.id} (${item.userName || 'Unknown'}).`);
    resolvedUnmatched++;
  }

  log(`[Lesson Cleanup] Completed. Converted: ${convertedBookings}, Resolved Unmatched: ${resolvedUnmatched}, Skipped: ${skipped}`);
  
  return {
    logs,
    convertedBookings,
    resolvedUnmatched,
    skipped
  };
}
