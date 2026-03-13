import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../db';
import { resources, users, facilityClosures, bookingRequests, availabilityBlocks, trackmanUnmatchedBookings, userLinkedEmails } from '../../../shared/schema';
import { logger } from '../logger';
import { parseTimeToMinutes } from '../bookingValidation';
import { recalculateSessionFees } from '../billing/unifiedFeeService';
import { ensureSessionForBooking } from '../bookingService/sessionManager';
import { AppError } from '../errors';

interface DrizzleExecuteResult<T = Record<string, unknown>> {
  rows?: T[];
  rowCount?: number;
}

interface TrackmanWebhookRow {
  payload: string | Record<string, unknown>;
  trackman_booking_id: string;
}

interface TrackmanPayloadData {
  start?: string;
  end?: string;
  bay?: { ref?: string; name?: string };
  [key: string]: unknown;
}

interface MemberLookupRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

interface LinkedEmailIdRow {
  id: number;
}

export async function resolveOwnerEmail(ownerEmail: string) {
  let resolvedOwnerEmail = ownerEmail.toLowerCase().trim();
  
  const [linkedEmailRecord] = await db.select({ primaryEmail: userLinkedEmails.primaryEmail })
    .from(userLinkedEmails)
    .where(sql`LOWER(${userLinkedEmails.linkedEmail}) = ${resolvedOwnerEmail}`);
  
  if (linkedEmailRecord?.primaryEmail) {
    resolvedOwnerEmail = linkedEmailRecord.primaryEmail.toLowerCase();
    logger.info('[link-trackman-to-member] Resolved email alias via user_linked_emails', {
      extra: { original: ownerEmail, resolved: resolvedOwnerEmail }
    });
  }
  
  if (resolvedOwnerEmail === ownerEmail.toLowerCase().trim()) {
    const usersWithAlias = await db.select({ email: users.email, manuallyLinkedEmails: users.manuallyLinkedEmails })
      .from(users)
      .where(sql`${users.manuallyLinkedEmails} IS NOT NULL`);
    
    for (const user of usersWithAlias) {
      if (user.manuallyLinkedEmails && user.email) {
        const linkedList = typeof user.manuallyLinkedEmails === 'string' 
          ? user.manuallyLinkedEmails.split(',').map(e => e.trim().toLowerCase())
          : [];
        if (linkedList.includes(ownerEmail.toLowerCase().trim())) {
          resolvedOwnerEmail = user.email.toLowerCase();
          logger.info('[link-trackman-to-member] Resolved email alias via manuallyLinkedEmails', {
            extra: { original: ownerEmail, resolved: resolvedOwnerEmail }
          });
          break;
        }
      }
    }
  }
  
  return resolvedOwnerEmail;
}

export async function checkIsInstructor(email: string) {
  const { staffUsers } = await import('../../../shared/schema');
  const instructorCheck = await db.select({
    id: staffUsers.id,
    email: staffUsers.email,
    role: staffUsers.role,
    isActive: staffUsers.isActive,
    name: staffUsers.name
  })
    .from(staffUsers)
    .where(and(
      sql`LOWER(${staffUsers.email}) = ${email}`,
      eq(staffUsers.role, 'golf_instructor'),
      eq(staffUsers.isActive, true)
    ))
    .limit(1);
  
  return instructorCheck.length > 0;
}

export async function getBookingDataForTrackman(trackmanBookingId: string) {
  let bookingData: { resourceId: number | null; requestDate: string; startTime: string; endTime: string | null } | null = null;
  
  const [existingBooking] = await db.select({
    id: bookingRequests.id,
    resourceId: bookingRequests.resourceId,
    requestDate: bookingRequests.requestDate,
    startTime: bookingRequests.startTime,
    endTime: bookingRequests.endTime
  })
    .from(bookingRequests)
    .where(eq(bookingRequests.trackmanBookingId, trackmanBookingId));
  
  if (existingBooking) {
    bookingData = {
      resourceId: existingBooking.resourceId,
      requestDate: existingBooking.requestDate,
      startTime: existingBooking.startTime,
      endTime: existingBooking.endTime
    };
    return { bookingData, existingBooking };
  }
  
  const [unmatchedBooking] = await db.select({
    id: trackmanUnmatchedBookings.id,
    bayNumber: trackmanUnmatchedBookings.bayNumber,
    bookingDate: trackmanUnmatchedBookings.bookingDate,
    startTime: trackmanUnmatchedBookings.startTime,
    endTime: trackmanUnmatchedBookings.endTime
  })
    .from(trackmanUnmatchedBookings)
    .where(eq(trackmanUnmatchedBookings.trackmanBookingId, trackmanBookingId));
  
  if (unmatchedBooking) {
    let resourceId: number | null = null;
    if (unmatchedBooking.bayNumber) {
      const [resource] = await db.select({ id: resources.id })
        .from(resources)
        .where(eq(resources.name, `Bay ${unmatchedBooking.bayNumber}`));
      resourceId = resource?.id ?? null;
    }
    bookingData = {
      resourceId,
      requestDate: unmatchedBooking.bookingDate,
      startTime: unmatchedBooking.startTime,
      endTime: unmatchedBooking.endTime
    };
    return { bookingData, existingBooking: null };
  }
  
  const webhookResult = await db.execute(sql`SELECT payload FROM trackman_webhook_events WHERE trackman_booking_id = ${trackmanBookingId} ORDER BY created_at DESC LIMIT 1`);
  
  if ((webhookResult.rows as unknown as TrackmanWebhookRow[]).length > 0) {
    let payload: TrackmanPayloadData;
    try {
      const webhookRow = (webhookResult.rows as unknown as TrackmanWebhookRow[])[0];
      payload = typeof webhookRow.payload === 'string' 
        ? JSON.parse(webhookRow.payload) 
        : webhookRow.payload as unknown as TrackmanPayloadData;
    } catch (parseErr) {
      logger.error('[resourceService] Failed to parse trackman webhook payload', { error: parseErr instanceof Error ? parseErr : new Error(String(parseErr)), extra: { trackmanBookingId } });
      payload = {};
    }
    const data = ((payload?.data || payload?.booking || {}) as unknown as TrackmanPayloadData);
    
    const startStr = data?.start;
    const endStr = data?.end;
    const bayRef = data?.bay?.ref;
    
    if (startStr && endStr) {
      const startDate = new Date(startStr.includes('T') ? startStr : startStr.replace(' ', 'T') + 'Z');
      const endDate = new Date(endStr.includes('T') ? endStr : endStr.replace(' ', 'T') + 'Z');
      
      const requestDate = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const startTime = startDate.toLocaleTimeString('en-US', { 
        hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
      }) + ':00';
      const endTime = endDate.toLocaleTimeString('en-US', { 
        hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
      }) + ':00';
      
      let resourceId = 1;
      if (bayRef) {
        const bayNum = parseInt(bayRef);
        if (bayNum >= 1 && bayNum <= 4) resourceId = bayNum;
      }
      
      bookingData = { resourceId, requestDate, startTime, endTime };
    }
  }
  
  return { bookingData, existingBooking: null };
}

export async function convertToInstructorBlock(
  trackmanBookingId: string,
  ownerName: string,
  ownerEmail: string,
  bookingData: { resourceId: number | null; requestDate: string; startTime: string; endTime: string | null },
  existingBooking: { id: number } | null,
  staffEmail: string
) {
  const endTime = bookingData.endTime || bookingData.startTime;
  
  if (bookingData.resourceId) {
    const { findCoveringBlock } = await import('../availabilityBlockService');
    const existingCovering = await findCoveringBlock(
      bookingData.resourceId,
      bookingData.requestDate,
      bookingData.startTime,
      endTime,
    );
    if (existingCovering) {
      logger.info(`[Trackman] Instructor block for ${ownerName} absorbed by existing block #${existingCovering.id} (${existingCovering.block_type})`);
      if (existingBooking) {
        await db.delete(bookingRequests).where(eq(bookingRequests.id, existingBooking.id));
      }
      return;
    }
  }
  
  const result = await db.insert(availabilityBlocks).values({
    resourceId: bookingData.resourceId,
    blockDate: bookingData.requestDate,
    startTime: bookingData.startTime,
    endTime,
    blockType: 'blocked',
    notes: `Lesson - ${ownerName}`,
    createdBy: staffEmail
  }).onConflictDoNothing().returning();
  
  if (result.length === 0) {
    logger.debug(`[Trackman] Skipped duplicate instructor block for ${ownerName} on ${bookingData.requestDate}`);
    return;
  }
  const block = result[0];
  
  if (existingBooking) {
    await db.delete(bookingRequests).where(eq(bookingRequests.id, existingBooking.id));
    logger.info('[link-trackman-to-member] Deleted existing booking after converting to availability block', {
      extra: { bookingId: existingBooking.id, trackman_booking_id: trackmanBookingId }
    });
  }
  
  await db.delete(trackmanUnmatchedBookings)
    .where(eq(trackmanUnmatchedBookings.trackmanBookingId, trackmanBookingId));
  
  await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = NULL, processed_at = NOW() WHERE trackman_booking_id = ${trackmanBookingId}`);
  
  const { broadcastToStaff } = await import('../websocket');
  broadcastToStaff({
    type: 'availability_block_created',
    blockId: block.id,
    instructorEmail: ownerEmail,
    instructorName: ownerName
  });
  
  return block;
}

export async function linkTrackmanToMember(
  trackmanBookingId: string,
  ownerEmail: string,
  ownerName: string,
  ownerId: string | null,
  additionalPlayers: Array<{ type: 'member' | 'guest_placeholder'; member_id?: string | null; email?: string; name?: string; guest_name?: string }>,
  totalPlayerCount: number,
  guestCount: number,
  staffEmail: string
) {
  let resolvedOwnerId = ownerId ? String(ownerId) : null;
  if (!resolvedOwnerId && ownerEmail) {
    const [userRow] = await db.select({ id: users.id })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${ownerEmail.toLowerCase()}`)
      .limit(1);
    if (userRow) {
      resolvedOwnerId = userRow.id;
    }
  }

  const result = await db.transaction(async (tx) => {
    const [existingBooking] = await tx.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.trackmanBookingId, trackmanBookingId));
    
    let booking;
    let created = false;
    
    const participantsJson = additionalPlayers.map(p => {
      if (p.type === 'guest_placeholder') {
        return { type: 'guest' as const, name: p.guest_name || 'Guest (info pending)' };
      }
      return { type: 'member' as const, email: p.email, name: p.name, userId: p.member_id };
    });

    if (existingBooking) {
      const staffNoteSuffix = ` [Linked to member via staff: ${ownerName} with ${totalPlayerCount} players]`;
      const newStaffNotes = (existingBooking.staffNotes || '') + staffNoteSuffix;
      const [updated] = await tx.update(bookingRequests)
        .set({
          userEmail: ownerEmail.toLowerCase(),
          userName: ownerName,
          userId: resolvedOwnerId,
          isUnmatched: false,
          status: 'approved',
          declaredPlayerCount: totalPlayerCount,
          guestCount: guestCount,
          requestParticipants: participantsJson.length > 0 ? participantsJson : undefined,
          staffNotes: newStaffNotes,
          updatedAt: new Date()
        })
        .where(eq(bookingRequests.id, existingBooking.id))
        .returning();
      booking = updated;
    } else {
      const webhookResult = await tx.execute(sql`
        SELECT payload, trackman_booking_id 
        FROM trackman_webhook_events 
        WHERE trackman_booking_id = ${trackmanBookingId}
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const webhookLog = (webhookResult as unknown as DrizzleExecuteResult<TrackmanWebhookRow>).rows?.[0];
      
      if (!webhookLog) {
        throw new AppError(404, 'Trackman booking not found in webhook logs');
      }
      
      let payload: Record<string, unknown>;
      try {
        payload = typeof webhookLog.payload === 'string' 
          ? JSON.parse(webhookLog.payload) 
          : webhookLog.payload as unknown as TrackmanPayloadData;
      } catch (parseErr) {
        logger.error('[resourceService] Failed to parse trackman webhook payload', { error: parseErr instanceof Error ? parseErr : new Error(String(parseErr)), extra: { trackmanBookingId } });
        throw new AppError(500, 'Failed to parse webhook payload data');
      }
      const bookingData = ((payload?.data || payload?.booking || {}) as unknown as TrackmanPayloadData);
      
      const startStr = bookingData?.start;
      const endStr = bookingData?.end;
      const bayRef = bookingData?.bay?.ref;
      
      if (!startStr || !endStr) {
        throw new AppError(400, 'Cannot extract booking time from webhook data');
      }
      
      const startDate = new Date(startStr.includes('T') ? startStr : startStr.replace(' ', 'T') + 'Z');
      const endDate = new Date(endStr.includes('T') ? endStr : endStr.replace(' ', 'T') + 'Z');
      
      const requestDate = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const startTime = startDate.toLocaleTimeString('en-US', { 
        hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
      }) + ':00';
      const endTime = endDate.toLocaleTimeString('en-US', { 
        hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
      }) + ':00';
      
      let resourceId = 1;
      if (bayRef) {
        const bayNum = parseInt(bayRef);
        if (bayNum >= 1 && bayNum <= 4) {
          resourceId = bayNum;
        }
      }
      
      const [newBooking] = await tx.insert(bookingRequests)
        .values({
          userEmail: ownerEmail.toLowerCase(),
          userName: ownerName,
          userId: resolvedOwnerId,
          resourceId,
          requestDate,
          startTime,
          endTime,
          status: 'approved',
          trackmanBookingId: trackmanBookingId,
          isUnmatched: false,
          declaredPlayerCount: totalPlayerCount,
          guestCount: guestCount,
          requestParticipants: participantsJson.length > 0 ? participantsJson : undefined,
          staffNotes: `[Linked from Trackman webhook by staff: ${ownerName} with ${totalPlayerCount} players]`,
          createdAt: new Date(),
          updatedAt: new Date()
        } as typeof bookingRequests.$inferInsert)
        .returning();
      booking = newBooking;
      created = true;
      
      await tx.execute(sql`
        UPDATE trackman_webhook_events 
        SET matched_booking_id = ${booking.id}
        WHERE trackman_booking_id = ${trackmanBookingId}
      `);
    }
    
    const sessionId = existingBooking?.sessionId || null;
    return { booking, created, sessionId };
  });
  
  let finalSessionId: number | null = result.sessionId || null;

  if (result.sessionId) {
    try {
      await db.execute(sql`UPDATE booking_participants
        SET user_id = ${resolvedOwnerId || null},
            display_name = ${ownerName}
        WHERE session_id = ${result.sessionId} AND participant_type = 'owner'`);
    } catch (ownerUpdateErr: unknown) {
      logger.warn('[link-trackman-to-member] Failed to update session owner participant', {
        extra: { bookingId: result.booking.id, sessionId: result.sessionId, error: ownerUpdateErr }
      });
    }
    logger.info('[link-trackman-to-member] Using existing session, updated owner participant', {
      extra: { bookingId: result.booking.id, sessionId: result.sessionId }
    });
  } else {
    try {
      const booking = result.booking;
      const sessionResult = await ensureSessionForBooking({
        bookingId: booking.id,
        resourceId: booking.resourceId!,
        sessionDate: typeof booking.requestDate === 'string' ? booking.requestDate : (booking.requestDate as Date).toISOString().split('T')[0],
        startTime: booking.startTime || '',
        endTime: booking.endTime || '',
        ownerEmail: ownerEmail,
        ownerName: ownerName,
        trackmanBookingId: trackmanBookingId,
        source: 'trackman_webhook',
        createdBy: staffEmail
      });
      if (sessionResult.sessionId) {
        finalSessionId = sessionResult.sessionId;
        await db.execute(sql`UPDATE booking_participants SET payment_status = 'waived' WHERE session_id = ${sessionResult.sessionId} AND (payment_status = 'pending' OR payment_status IS NULL)`);
        await db.update(bookingRequests).set({ sessionId: sessionResult.sessionId }).where(eq(bookingRequests.id, booking.id));
        logger.info('[link-trackman-to-member] Created new session after member assignment', {
          extra: { bookingId: booking.id, sessionId: sessionResult.sessionId, ownerEmail, ownerName }
        });
      }
    } catch (sessionErr: unknown) {
      logger.warn('[link-trackman-to-member] Failed to create session after member assignment', {
        extra: { bookingId: result.booking.id, error: sessionErr }
      });
    }
  }

  if (finalSessionId && additionalPlayers.length > 0) {
    try {
      const durationMinutes = result.booking.durationMinutes || 60;
      const slotDuration = Math.floor(durationMinutes / Math.max(totalPlayerCount, 1));

      for (const player of additionalPlayers) {
        if (player.type === 'guest_placeholder') {
          await db.execute(sql`INSERT INTO booking_participants (session_id, participant_type, display_name, slot_duration, payment_status, used_guest_pass, created_at)
             VALUES (${finalSessionId}, 'guest', ${player.guest_name || 'Guest (info pending)'}, ${slotDuration}, 'pending', false, NOW())`);
        } else if (player.type === 'member' && player.email) {
          const memberLookup = await db.execute(sql`SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${player.email}) LIMIT 1`);
          const memberRow = (memberLookup.rows as unknown as MemberLookupRow[])[0];
          const displayName = memberRow ? [memberRow.first_name, memberRow.last_name].filter(Boolean).join(' ') || player.email : player.email;
          await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, slot_duration, payment_status, created_at)
             VALUES (${finalSessionId}, ${memberRow?.id || null}, 'member', ${displayName}, ${slotDuration}, 'pending', NOW())`);
        }
      }

      logger.info('[link-trackman-to-member] Added additional player participants', {
        extra: { bookingId: result.booking.id, sessionId: finalSessionId, additionalCount: additionalPlayers.length }
      });
    } catch (partErr: unknown) {
      logger.warn('[link-trackman-to-member] Failed to add additional player participants', {
        extra: { bookingId: result.booking.id, sessionId: finalSessionId, error: partErr }
      });
    }
  }

  if (finalSessionId) {
    try {
      await recalculateSessionFees(finalSessionId, 'approval');
      logger.info('[link-trackman-to-member] Recalculated fees after member assignment', {
        extra: { bookingId: result.booking.id, sessionId: finalSessionId, newOwner: ownerEmail }
      });
    } catch (recalcErr: unknown) {
      logger.warn('[link-trackman-to-member] Failed to recalculate fees after assignment', {
        extra: { bookingId: result.booking.id, sessionId: finalSessionId, error: recalcErr }
      });
    }
  }

  const { broadcastToStaff } = await import('../websocket');
  broadcastToStaff({
    type: 'booking_updated',
    bookingId: result.booking.id,
    action: 'trackman_linked',
    memberEmail: ownerEmail,
    memberName: ownerName,
    totalPlayers: totalPlayerCount
  });
  
  return result;
}

export async function linkEmailToMember(ownerEmail: string, originalEmail: string) {
  try {
    const existingLink = await db.execute(sql`SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = LOWER(${originalEmail})`);
    
    if ((existingLink.rows as unknown as LinkedEmailIdRow[]).length === 0 && ownerEmail.toLowerCase() !== originalEmail.toLowerCase()) {
      const [member] = await db.select().from(users).where(eq(users.email, ownerEmail.toLowerCase())).limit(1);
      if (member) {
        await db.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_at) 
           VALUES (${member.email}, ${originalEmail.toLowerCase()}, ${'staff_assignment'}, NOW())
           ON CONFLICT (linked_email) DO NOTHING`);
        logger.info('[resourceService] Linked email to member', {
          extra: { memberEmail: ownerEmail, linkedEmail: originalEmail, memberId: member.id }
        });
        return true;
      }
    }
  } catch (linkErr: unknown) {
    logger.warn('[resourceService] Failed to link email', { extra: { error: linkErr } });
  }
  return false;
}

export async function markBookingAsEvent(params: {
  bookingId?: number;
  trackmanBookingId?: string;
  existingClosureId?: number;
  staffEmail: string;
  eventTitle?: string;
}) {
  let primaryBooking: typeof bookingRequests.$inferSelect | undefined;
  let isFromUnmatched = false;
  
  if (params.bookingId) {
    const [booking] = await db.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.id, params.bookingId));
    primaryBooking = booking;
  } else if (params.trackmanBookingId) {
    const [booking] = await db.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.trackmanBookingId, params.trackmanBookingId));
    primaryBooking = booking;
  }
  
  if (!primaryBooking && params.trackmanBookingId) {
    const { trackmanUnmatchedBookings } = await import('../../../shared/models/scheduling');
    const [unmatchedBooking] = await db.select()
      .from(trackmanUnmatchedBookings)
      .where(eq(trackmanUnmatchedBookings.trackmanBookingId, params.trackmanBookingId));
    
    if (unmatchedBooking) {
      let resourceId: number | null = null;
      if (unmatchedBooking.bayNumber) {
        const [resource] = await db.select()
          .from(resources)
          .where(eq(resources.name, `Bay ${unmatchedBooking.bayNumber}`));
        resourceId = resource?.id ?? null;
      }
      
      primaryBooking = {
        id: unmatchedBooking.id,
        userName: unmatchedBooking.userName,
        requestDate: unmatchedBooking.bookingDate,
        startTime: unmatchedBooking.startTime,
        endTime: unmatchedBooking.endTime,
        durationMinutes: unmatchedBooking.durationMinutes,
        resourceId: resourceId,
        trackmanBookingId: unmatchedBooking.trackmanBookingId,
        isUnmatched: true,
      } as unknown as typeof bookingRequests.$inferSelect;
      isFromUnmatched = true;
    }
  }
  
  if (!primaryBooking) {
    throw new AppError(404, 'Booking not found');
  }
  
  const lessonPrefixes = ['lesson', 'private lesson', 'kids lesson', 'group lesson', 'beginner group lesson'];
  const bookingNameLower = (primaryBooking.userName || '').toLowerCase().trim();
  const titleLower = (params.eventTitle || '').toLowerCase().trim();
  if (lessonPrefixes.some(prefix => bookingNameLower.startsWith(prefix)) || lessonPrefixes.some(prefix => titleLower.startsWith(prefix))) {
    throw new AppError(400, 'Lesson bookings should not be marked as private events. Use "Assign to Staff" to convert to an instructor availability block instead.');
  }
  
  const userName = primaryBooking.userName?.toLowerCase()?.trim();
  const bookingDate = primaryBooking.requestDate;
  const startTime = primaryBooking.startTime;
  let endTime = primaryBooking.endTime;
  if (!endTime && primaryBooking.durationMinutes && startTime) {
    const startMinutes = parseTimeToMinutes(startTime);
    const endMinutes = startMinutes + primaryBooking.durationMinutes;
    const endHours = Math.floor(endMinutes / 60);
    const endMins = endMinutes % 60;
    endTime = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}:00`;
  }
  if (!endTime && startTime) {
    const startMinutes = parseTimeToMinutes(startTime);
    const endMinutes = startMinutes + 60;
    const endHours = Math.floor(endMinutes / 60);
    const endMins = endMinutes % 60;
    endTime = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}:00`;
  }
  
  let relatedBookings: (typeof bookingRequests.$inferSelect)[] = [];
  let relatedUnmatchedIds: number[] = [];
  
  if (userName && bookingDate && startTime) {
    relatedBookings = await db.select()
      .from(bookingRequests)
      .where(and(
        sql`LOWER(TRIM(${bookingRequests.userName})) = ${userName}`,
        eq(bookingRequests.requestDate, bookingDate),
        eq(bookingRequests.startTime, startTime),
        eq(bookingRequests.isUnmatched, true)
      ));
    
    if (isFromUnmatched) {
      const { trackmanUnmatchedBookings } = await import('../../../shared/models/scheduling');
      const relatedUnmatched = await db.select()
        .from(trackmanUnmatchedBookings)
        .where(and(
          sql`LOWER(TRIM(${trackmanUnmatchedBookings.userName})) = ${userName}`,
          eq(trackmanUnmatchedBookings.bookingDate, bookingDate),
          eq(trackmanUnmatchedBookings.startTime, startTime),
          sql`${trackmanUnmatchedBookings.resolvedAt} IS NULL`
        ));
      relatedUnmatchedIds = relatedUnmatched.map(u => u.id);
      
      for (const unmatched of relatedUnmatched) {
        if (unmatched.bayNumber) {
          const [resource] = await db.select()
            .from(resources)
            .where(eq(resources.name, `Bay ${unmatched.bayNumber}`));
          if (resource) {
            relatedBookings.push({
              ...unmatched,
              resourceId: resource.id,
              requestDate: unmatched.bookingDate,
              isUnmatched: true
            } as unknown as typeof bookingRequests.$inferSelect);
          }
        }
      }
    }
  }
  
  if (relatedBookings.length === 0) {
    relatedBookings = [primaryBooking];
    if (isFromUnmatched && !relatedUnmatchedIds.includes(primaryBooking.id)) {
      relatedUnmatchedIds = [primaryBooking.id];
    }
  }
  
  const resourceIds = [...new Set(relatedBookings.map(b => b.resourceId).filter(Boolean))] as number[];
  const bookingIds = relatedBookings.map(b => b.id);
  
  const eventTitle = params.eventTitle || 'Private Event';
  
  const result = await db.transaction(async (tx) => {
    let closure: typeof facilityClosures.$inferSelect | null = null;
    let linkedToExisting = false;
    
    if (params.existingClosureId) {
      const [existingClosure] = await tx.select()
        .from(facilityClosures)
        .where(and(
          eq(facilityClosures.id, params.existingClosureId),
          eq(facilityClosures.isActive, true)
        ));
      
      if (existingClosure) {
        closure = existingClosure;
        linkedToExisting = true;
      }
    }
    
    if (!closure) {
      const existingClosures = await tx.select()
        .from(facilityClosures)
        .where(and(
          eq(facilityClosures.startDate, bookingDate),
          eq(facilityClosures.startTime, startTime),
          eq(facilityClosures.endTime, endTime),
          eq(facilityClosures.noticeType, 'private_event'),
          eq(facilityClosures.isActive, true)
        ));
      
      closure = existingClosures[0];
      if (closure) linkedToExisting = true;
    }
    
    const existingBlocks = resourceIds.length > 0 ? await tx.select()
      .from(availabilityBlocks)
      .where(and(
        eq(availabilityBlocks.blockDate, bookingDate),
        sql`${availabilityBlocks.resourceId} IN (${sql.join(resourceIds.map(id => sql`${id}`), sql`, `)})`,
        sql`${availabilityBlocks.startTime} < ${endTime}`,
        sql`${availabilityBlocks.endTime} > ${startTime}`
      )) : [];
    
    const blockedResourceIds = new Set(existingBlocks.map(b => b.resourceId));
    const unblockResourceIds = resourceIds.filter(id => !blockedResourceIds.has(id));
    
    if (!closure) {
      const [newClosure] = await tx.insert(facilityClosures).values({
        title: eventTitle,
        reason: 'Private Event',
        noticeType: 'private_event',
        startDate: bookingDate,
        startTime: startTime,
        endDate: bookingDate,
        endTime: endTime,
        affectedAreas: resourceIds.map(id => `bay_${id}`).join(','),
        visibility: 'Private',
        isActive: true,
        createdBy: params.staffEmail
      }).returning();
      closure = newClosure;
    }
    
    if (unblockResourceIds.length > 0 && closure) {
      const blockValues = unblockResourceIds.map(resourceId => ({
        resourceId,
        blockDate: bookingDate,
        startTime: startTime,
        endTime: endTime,
        blockType: 'blocked',
        notes: `Private Event: ${eventTitle}`,
        closureId: closure.id,
        createdBy: params.staffEmail
      }));
      
      await tx.insert(availabilityBlocks).values(blockValues).onConflictDoNothing();
    }
    
    const unmatchedInBookingRequests = bookingIds.filter(id => {
      const booking = relatedBookings.find(b => b.id === id);
      return booking?.isUnmatched === true || 
             !booking?.userEmail ||
             (booking?.userEmail && (booking.userEmail.includes('unmatched-') || booking.userEmail.includes('@trackman.local')));
    });
    const regularBookingIds = bookingIds.filter(id => !relatedUnmatchedIds.includes(id) && !unmatchedInBookingRequests.includes(id));
    
    if (unmatchedInBookingRequests.length > 0) {
      await tx.update(bookingRequests)
        .set({
          isUnmatched: false,
          userEmail: 'private-event@resolved',
          notes: sql`COALESCE(${bookingRequests.notes}, '') || ' [Converted to Private Event]'`,
          status: 'attended',
          closureId: closure?.id || null
        })
        .where(sql`id IN (${sql.join(unmatchedInBookingRequests.map(id => sql`${id}`), sql`, `)})`);
    }
    
    if (regularBookingIds.length > 0) {
      await tx.delete(bookingRequests).where(sql`id IN (${sql.join(regularBookingIds.map(id => sql`${id}`), sql`, `)})`);
    }
    
    if (relatedUnmatchedIds.length > 0) {
      const { trackmanUnmatchedBookings } = await import('../../../shared/models/scheduling');
      await tx.update(trackmanUnmatchedBookings)
        .set({
          resolvedAt: new Date(),
          resolvedBy: params.staffEmail,
          resolvedEmail: 'PRIVATE_EVENT',
        })
        .where(sql`id IN (${sql.join(relatedUnmatchedIds.map(id => sql`${id}`), sql`, `)})`);
    }
    
    return { closure, bookingIds, resourceIds, linkedToExisting, newBlocksCreated: unblockResourceIds.length, resolvedUnmatchedCount: relatedUnmatchedIds.length };
  });
  
  const { broadcastToStaff, broadcastClosureUpdate } = await import('../websocket');
  broadcastToStaff({
    type: 'booking_updated',
    action: 'converted_to_private_event',
    bookingIds: result.bookingIds,
    closureId: result.closure?.id
  });
  
  if (result.closure) {
    broadcastClosureUpdate('created', result.closure.id);
  }
  
  let message = `Converted ${result.bookingIds.length} booking(s) to private event`;
  if (result.linkedToExisting) {
    message += ' (linked to existing notice)';
  }
  if (result.newBlocksCreated === 0) {
    message += ' - all blocks already existed';
  } else if (result.newBlocksCreated < result.resourceIds.length) {
    message += ` - created ${result.newBlocksCreated} new block(s)`;
  }
  
  return { 
    primaryBooking,
    eventTitle,
    message,
    closureId: result.closure?.id,
    convertedBookingIds: result.bookingIds,
    resourceIds: result.resourceIds,
    linkedToExisting: result.linkedToExisting,
    newBlocksCreated: result.newBlocksCreated
  };
}
