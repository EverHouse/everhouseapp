import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { resources, users, notifications, bookingRequests } from '../../../shared/schema';
import { logger } from '../logger';
import { isSyntheticEmail } from '../notificationService';
import { sendPushNotification } from '../../routes/push';
import { sendNotificationToUser } from '../websocket';
import { checkAllConflicts } from '../bookingValidation';
import { bookingEvents } from '../bookingEvents';
import { recalculateSessionFees } from '../billing/unifiedFeeService';
import { createPrepaymentIntent } from '../billing/prepaymentService';
import { ensureSessionForBooking } from '../bookingService/sessionManager';
import { createCalendarEventOnCalendar, getCalendarIdByName, CALENDAR_CONFIG } from '../calendar/index';
import { AppError } from '../errors';
import { resolveUserByEmail } from '../stripe/customers';

interface MemberLookupRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

interface FeeSumRow {
  total_cents: string | null;
  overage_cents?: string | null;
  guest_cents?: string | null;
}

export async function assignMemberToBooking(bookingId: number, memberEmail: string, memberName: string, memberId?: string | null) {
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
    
    if (!existing) {
      throw new AppError(404, 'Booking not found');
    }
    
    if (!existing.isUnmatched) {
      throw new AppError(400, 'Booking is not an unmatched booking');
    }
    
    const [updated] = await tx.update(bookingRequests)
      .set({
        userEmail: memberEmail.toLowerCase(),
        userName: memberName,
        userId: memberId || null,
        isUnmatched: false,
        status: 'approved',
        staffNotes: sql`COALESCE(${bookingRequests.staffNotes}, '') || ' [Member assigned by staff: ' || ${memberName} || ']'`,
        updatedAt: new Date()
      })
      .where(eq(bookingRequests.id, bookingId))
      .returning();

    if (existing.sessionId) {
      await tx.execute(sql`UPDATE booking_participants
        SET user_id = ${memberId || null},
            display_name = ${memberName}
        WHERE session_id = ${existing.sessionId} AND participant_type = 'owner'`);
    }
    
    return updated;
  });
  
  const { broadcastToStaff } = await import('../websocket');
  broadcastToStaff({
    type: 'booking_updated',
    bookingId,
    action: 'member_assigned',
    memberEmail: memberEmail,
    memberName: memberName
  });
  
  const formattedDate = result.requestDate ? new Date(result.requestDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '';
  const formattedTime = result.startTime || '';
  
  if (memberEmail) {
    await db.execute(sql`INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
       VALUES (${memberEmail.toLowerCase()}, ${'Booking Confirmed'}, ${`Your simulator booking for ${formattedDate} at ${formattedTime} has been confirmed.`}, ${'booking'}, ${'booking'}, NOW())`);
  }
  
  sendNotificationToUser(memberEmail, {
    type: 'booking_confirmed',
    title: 'Booking Confirmed',
    message: `Your simulator booking for ${formattedDate} at ${formattedTime} has been confirmed.`,
    data: { bookingId },
  });
  
  return result;
}

export async function assignWithPlayers(
  bookingId: number,
  owner: { email: string; name: string; member_id?: string | null },
  additionalPlayers: Array<{ type: 'member' | 'guest_placeholder'; member_id?: string | null; email?: string; name?: string; guest_name?: string }>,
  staffEmail: string
) {
  const totalPlayerCount = 1 + additionalPlayers.filter(p => p.type === 'member' || p.type === 'guest_placeholder').length;
  const guestCount = additionalPlayers.filter(p => p.type === 'guest_placeholder').length;

  let resolvedOwnerId = owner.member_id || null;
  if (!resolvedOwnerId && owner.email) {
    const [userRow] = await db.select({ id: users.id })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${owner.email.toLowerCase()}`)
      .limit(1);
    if (userRow) {
      resolvedOwnerId = userRow.id;
    }
  }
  
  const result = await db.transaction(async (tx) => {
    const [existingBooking] = await tx.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));
    
    if (!existingBooking) {
      throw new AppError(404, 'Booking not found');
    }
    
    const newNote = ` [Assigned by staff: ${owner.name} with ${totalPlayerCount} players]`;
    
    const participantsJson = additionalPlayers.map(p => {
      if (p.type === 'guest_placeholder') {
        return { type: 'guest' as const, name: p.guest_name || 'Guest (info pending)' };
      }
      return { type: 'member' as const, email: p.email, name: p.name, userId: p.member_id };
    });

    const [updated] = await tx.update(bookingRequests)
      .set({
        userEmail: owner.email.toLowerCase(),
        userName: owner.name,
        userId: resolvedOwnerId,
        isUnmatched: false,
        status: 'approved',
        declaredPlayerCount: totalPlayerCount,
        guestCount: guestCount,
        requestParticipants: participantsJson.length > 0 ? participantsJson : undefined,
        staffNotes: sql`COALESCE(${bookingRequests.staffNotes}, '') || ${newNote}`,
        updatedAt: new Date()
      })
      .where(eq(bookingRequests.id, bookingId))
      .returning();
    
    return { booking: updated, sessionId: existingBooking.sessionId };
  });
  
  let sessionId = result.sessionId;

  if (sessionId) {
    try {
      await db.execute(sql`UPDATE booking_participants
        SET user_id = ${resolvedOwnerId || null},
            display_name = ${owner.name}
        WHERE session_id = ${sessionId} AND participant_type = 'owner'`);
    } catch (ownerUpdateErr: unknown) {
      logger.warn('[assign-with-players] Failed to update session owner participant', {
        extra: { bookingId, sessionId, error: ownerUpdateErr }
      });
    }
  }

  if (!sessionId && result.booking.resourceId && result.booking.requestDate && result.booking.startTime && result.booking.endTime) {
    try {
      const sessionResult = await ensureSessionForBooking({
        bookingId,
        resourceId: result.booking.resourceId,
        sessionDate: String(result.booking.requestDate),
        startTime: String(result.booking.startTime),
        endTime: String(result.booking.endTime),
        ownerEmail: owner.email,
        ownerName: owner.name,
        ownerUserId: resolvedOwnerId || undefined,
        trackmanBookingId: result.booking.trackmanBookingId || undefined,
        source: 'staff_manual',
        createdBy: staffEmail
      });
      sessionId = sessionResult.sessionId;
      logger.info('[assign-with-players] Created session for booking without one', {
        extra: { bookingId, sessionId, newOwner: owner.email }
      });
    } catch (sessErr: unknown) {
      logger.warn('[assign-with-players] Failed to create session for booking', {
        extra: { bookingId, error: sessErr }
      });
    }
  }

  if (sessionId && additionalPlayers.length > 0) {
    try {
      const durationMinutes = Number(result.booking.durationMinutes) || 60;
      const slotDuration = Math.floor(durationMinutes / Math.max(totalPlayerCount, 1));
      for (const player of additionalPlayers) {
        if (player.type === 'guest_placeholder') {
          await db.execute(sql`INSERT INTO booking_participants (session_id, participant_type, display_name, slot_duration, payment_status, used_guest_pass, created_at)
             VALUES (${sessionId}, 'guest', ${player.guest_name || 'Guest (info pending)'}, ${slotDuration}, 'pending', false, NOW())`);
        } else if (player.type === 'member' && player.email) {
          const memberLookup = await db.execute(sql`SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${player.email}) LIMIT 1`);
          const memberRow = (memberLookup.rows as unknown as MemberLookupRow[])[0];
          const displayName = memberRow
            ? `${memberRow.first_name || ''} ${memberRow.last_name || ''}`.trim() || player.name || player.email
            : player.name || player.email;
          if (!memberRow) {
            logger.warn('[assign-with-players] Member not found in system, participant created without user_id', {
              extra: { email: player.email, sessionId }
            });
          }
          await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, slot_duration, payment_status, created_at)
             VALUES (${sessionId}, ${memberRow?.id || null}, 'member', ${displayName}, ${slotDuration}, 'pending', NOW())`);
        }
      }
    } catch (partErr: unknown) {
      logger.warn('[assign-with-players] Failed to add participants to booking_participants', {
        extra: { bookingId, sessionId, error: partErr }
      });
    }
  }

  if (sessionId) {
    try {
      await recalculateSessionFees(sessionId, 'approval');
      logger.info('[assign-with-players] Recalculated fees after member assignment', {
        extra: { bookingId, sessionId, newOwner: owner.email }
      });
    } catch (recalcErr: unknown) {
      logger.warn('[assign-with-players] Failed to recalculate fees after assignment', {
        extra: { bookingId, sessionId, error: recalcErr }
      });
    }
  }
  
  if (sessionId) {
    try {
      const feeResult = await db.execute(sql`
        SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents,
               SUM(CASE WHEN participant_type = 'owner' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as overage_cents,
               SUM(CASE WHEN participant_type = 'guest' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as guest_cents
        FROM booking_participants
        WHERE session_id = ${sessionId}
      `);
      
      const feeRow = (feeResult.rows as unknown as FeeSumRow[])[0];
      const totalCents = parseInt(feeRow?.total_cents || '0');
      const overageCents = parseInt(feeRow?.overage_cents || '0');
      const guestCents = parseInt(feeRow?.guest_cents || '0');
      
      if (totalCents > 0) {
        const prepayResult = await createPrepaymentIntent({
          sessionId,
          bookingId: bookingId,
          userId: owner.member_id || null,
          userEmail: owner.email,
          userName: owner.name,
          totalFeeCents: totalCents,
          feeBreakdown: { overageCents, guestCents }
        });
        
        if (prepayResult?.paidInFull) {
          await db.execute(sql`UPDATE booking_participants SET payment_status = 'paid' WHERE session_id = ${sessionId} AND payment_status IN ('pending', 'unpaid')`);
          logger.info('[assign-with-players] Prepayment fully covered by credit', {
            extra: { bookingId, sessionId, totalCents }
          });
        } else {
          logger.info('[assign-with-players] Created prepayment intent', {
            extra: { bookingId, sessionId, totalCents }
          });
        }
      }
    } catch (prepayErr: unknown) {
      logger.warn('[assign-with-players] Failed to create prepayment intent', {
        extra: { bookingId, sessionId, error: prepayErr }
      });
    }
  }
  
  const { broadcastToStaff } = await import('../websocket');
  broadcastToStaff({
    type: 'booking_updated',
    bookingId: result.booking.id,
    action: 'players_assigned',
    memberEmail: owner.email,
    memberName: owner.name,
    totalPlayers: totalPlayerCount
  });
  
  if (owner.member_id) {
    try {
      const feeResult = await db.execute(sql`
        SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents
        FROM booking_participants
        WHERE session_id = ${sessionId}
      `);
      
      const totalCents = parseInt((feeResult.rows as unknown as FeeSumRow[])[0]?.total_cents || '0');
      const feeMessage = totalCents > 0 
        ? ` Estimated fees: $${(totalCents / 100).toFixed(2)}. You can pay now from your dashboard.`
        : '';
      
      const dateStr = result.booking.requestDate 
        ? new Date(result.booking.requestDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })
        : '';
      const timeStr = result.booking.startTime || '';
      
      await db.execute(sql`INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
         VALUES (${owner.email.toLowerCase()}, ${'Booking Confirmed'}, ${`Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.${feeMessage}`}, ${'booking'}, ${'booking'}, NOW())`);
      
      sendNotificationToUser(owner.email, {
        type: 'booking_confirmed',
        title: 'Booking Confirmed',
        message: `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.${feeMessage}`,
        data: { bookingId, feeCents: totalCents },
      });
    } catch (notifyErr: unknown) {
      logger.warn('[assign-with-players] Failed to notify member', {
        extra: { bookingId, error: notifyErr }
      });
    }
  }
  
  return { booking: result.booking, totalPlayerCount, guestCount, sessionId };
}

export async function changeBookingOwner(bookingId: number, newEmail: string, newName: string, memberId?: string | null) {
  const [existingBooking] = await db.select()
    .from(bookingRequests)
    .where(eq(bookingRequests.id, bookingId));
  
  if (!existingBooking) {
    throw new AppError(404, 'Booking not found');
  }
  
  const previousOwner = existingBooking.userName || existingBooking.userEmail;
  
  const [updated] = await db.update(bookingRequests)
    .set({
      userEmail: newEmail.toLowerCase(),
      userName: newName,
      userId: memberId || null,
      isUnmatched: false,
      status: 'approved',
      staffNotes: sql`COALESCE(${bookingRequests.staffNotes}, '') || ' [Owner changed from ' || ${previousOwner} || ' to ' || ${newName} || ' by staff]'`,
      updatedAt: new Date()
    })
    .where(eq(bookingRequests.id, bookingId))
    .returning();
  
  if (existingBooking.sessionId) {
    const resolvedUserId = memberId || null;
    let resolvedName = newName;
    let resolvedMemberId = resolvedUserId;

    if (!resolvedMemberId) {
      const userResult = await db.execute(sql`SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${newEmail}) LIMIT 1`);
      const userRow = (userResult.rows as Array<{ id: string; first_name: string | null; last_name: string | null }>)[0];
      if (userRow) {
        resolvedMemberId = userRow.id;
        const fullName = [userRow.first_name, userRow.last_name].filter(Boolean).join(' ');
        if (fullName) resolvedName = fullName;
      }
    }

    await db.execute(sql`
      UPDATE booking_participants
      SET user_id = ${resolvedMemberId},
          display_name = ${resolvedName}
      WHERE session_id = ${existingBooking.sessionId} AND participant_type = 'owner'
    `);
  }
  
  const { broadcastToStaff } = await import('../websocket');
  broadcastToStaff({
    type: 'booking_updated',
    bookingId: updated.id,
    action: 'owner_changed',
    previousOwner,
    newOwnerEmail: newEmail,
    newOwnerName: newName
  });
  
  return { booking: updated, previousOwner };
}

export async function createManualBooking(params: {
  memberEmail: string;
  resourceId: number;
  bookingDate: string;
  startTime: string;
  durationMinutes: number;
  guestCount: number;
  bookingSource: string;
  notes?: string;
  staffNotes?: string;
  trackmanBookingId?: string;
  staffEmail: string;
}) {
  const validSources = ['Trackman', 'YGB', 'Mindbody', 'Texted Concierge', 'Called', 'Other'];
  if (!validSources.includes(params.bookingSource)) {
    throw new AppError(400, 'Invalid booking source');
  }

  const validDurations = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360];
  if (!validDurations.includes(params.durationMinutes)) {
    throw new AppError(400, 'Invalid duration. Must be between 30 and 360 minutes in 30-minute increments.');
  }

  let resolvedMemberEmail = params.memberEmail.toLowerCase();
  let resolvedUserId: string | null = null;
  const resolved = await resolveUserByEmail(resolvedMemberEmail);
  if (resolved) {
    if (resolved.matchType !== 'direct') {
      logger.info('[StaffActions] Resolved linked email to primary', { extra: { originalEmail: resolvedMemberEmail, resolvedEmail: resolved.primaryEmail, matchType: resolved.matchType } });
      resolvedMemberEmail = resolved.primaryEmail.toLowerCase();
    }
    resolvedUserId = resolved.userId;
  }

  const [member] = await db.select()
    .from(users)
    .where(eq(users.email, resolvedMemberEmail));

  if (!member) {
    throw new AppError(404, 'Member not found with that email');
  }

  const [resource] = await db.select()
    .from(resources)
    .where(eq(resources.id, params.resourceId));

  if (!resource) {
    throw new AppError(404, 'Resource not found');
  }

  const startParts = params.startTime.split(':').map(Number);
  const startMinutes = startParts[0] * 60 + (startParts[1] || 0);
  const endMinutes = startMinutes + params.durationMinutes;
  const endHour = Math.floor(endMinutes / 60);
  const endMin = endMinutes % 60;
  const endTime = `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`;

  const conflictCheck = await checkAllConflicts(params.resourceId, params.bookingDate, params.startTime, endTime);
  if (conflictCheck.hasConflict) {
    if (conflictCheck.conflictType === 'closure') {
      throw new AppError(409, 'Time slot conflicts with a facility closure', {
        message: `This time slot conflicts with "${conflictCheck.conflictTitle}".`
      });
    } else if (conflictCheck.conflictType === 'availability_block') {
      throw new AppError(409, 'Time slot is blocked for an event', {
        message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}.`
      });
    } else {
      throw new AppError(409, 'Time slot already booked', {
        message: 'Another booking already exists for this time slot.'
      });
    }
  }

  let calendarEventId: string | null = null;
  if (resource.type === 'conference_room') {
    try {
      const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
      
      if (calendarId) {
        const memberName = member.firstName && member.lastName 
          ? `${member.firstName} ${member.lastName}` 
          : resolvedMemberEmail;
        
        const summary = `Booking: ${memberName}`;
        const descriptionLines = [
          `Area: ${resource.name}`,
          `Member: ${resolvedMemberEmail}`,
          `Guests: ${params.guestCount}`,
          `Source: ${params.bookingSource}`,
          `Created by: ${params.staffEmail}`
        ];
        if (params.notes) {
          descriptionLines.push(`Notes: ${params.notes}`);
        }
        const description = descriptionLines.join('\n');
        
        calendarEventId = await createCalendarEventOnCalendar(
          calendarId,
          summary,
          description,
          params.bookingDate,
          params.startTime,
          endTime
        );
      }
    } catch (calErr: unknown) {
      logger.error('Calendar event creation error', { error: calErr as Error });
    }
  }

  const memberName = member.firstName && member.lastName 
    ? `${member.firstName} ${member.lastName}` 
    : resolvedMemberEmail;
  
  const bookingNotes = params.notes 
    ? `${params.notes}\n[Source: ${params.bookingSource}]` 
    : `[Source: ${params.bookingSource}]`;
  
  const [newBooking] = await db.insert(bookingRequests)
    .values({
      resourceId: params.resourceId,
      userEmail: resolvedMemberEmail,
      userId: resolvedUserId,
      userName: memberName,
      resourcePreference: resource.name,
      requestDate: params.bookingDate,
      startTime: params.startTime,
      endTime: endTime,
      durationMinutes: params.durationMinutes,
      notes: bookingNotes,
      staffNotes: params.staffNotes || null,
      status: 'approved',
      guestCount: params.guestCount,
      reviewedBy: params.staffEmail,
      reviewedAt: new Date(),
      calendarEventId: calendarEventId,
      trackmanBookingId: params.trackmanBookingId || null
    })
    .returning();

  try {
    const formattedDate = new Date(params.bookingDate + 'T00:00:00').toLocaleDateString('en-US', { 
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles'
    });
    const formatTime = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hour12 = h % 12 || 12;
      return `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`;
    };
    const notifTitle = 'Booking Confirmed';
    const notifMessage = `Your ${resource.type === 'simulator' ? 'golf simulator' : 'conference room'} booking for ${formattedDate} at ${formatTime(params.startTime)} has been confirmed.`;
    
    if (!isSyntheticEmail(resolvedMemberEmail)) {
      await db.insert(notifications).values({
        userEmail: resolvedMemberEmail,
        title: notifTitle,
        message: notifMessage,
        type: 'booking_approved',
        relatedId: newBooking.id,
        relatedType: 'booking'
      });
    }
    
    await sendPushNotification(resolvedMemberEmail, {
      title: notifTitle,
      body: notifMessage,
      url: '/dashboard',
      tag: `booking-${newBooking.id}`
    });
    
    sendNotificationToUser(resolvedMemberEmail, {
      type: 'notification',
      title: notifTitle,
      message: notifMessage,
      data: { bookingId: newBooking.id, eventType: 'booking_approved' }
    }, { action: 'manual_booking', bookingId: newBooking.id, resourceType: resource.type, triggerSource: 'resourceService.ts' });
  } catch (notifErr: unknown) {
    logger.error('Failed to send manual booking notification', { error: notifErr as Error });
  }

  bookingEvents.publish('booking_approved', {
    bookingId: newBooking.id,
    memberEmail: resolvedMemberEmail,
    memberName: memberName,
    resourceId: params.resourceId,
    resourceName: resource.name,
    resourceType: resource.type,
    bookingDate: params.bookingDate,
    startTime: params.startTime,
    endTime: endTime,
    status: 'approved',
    actionBy: 'staff',
    staffEmail: params.staffEmail,
    isManualBooking: true
  }, { notifyMember: true, notifyStaff: true }).catch(err => logger.error('Booking event publish failed', { extra: { error: err } }));

  return {
    booking: {
      ...newBooking,
      resource_name: resource.name,
      resource_type: resource.type,
      member_name: member.firstName && member.lastName 
        ? `${member.firstName} ${member.lastName}` 
        : null
    }
  };
}
