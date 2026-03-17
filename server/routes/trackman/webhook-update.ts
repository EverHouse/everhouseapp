import { logger } from '../../core/logger';
import { broadcastToStaff, broadcastAvailabilityUpdate } from '../../core/websocket';
import { notifyAllStaff, notifyMember } from '../../core/notificationService';
import { linkAndNotifyParticipants } from '../../core/bookingEvents';
import { bookingRequests } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { BOOKING_STATUS, PAYMENT_STATUS, PARTICIPANT_TYPE } from '../../../shared/constants/statuses';
import {
  TrackmanWebhookPayload,
  TrackmanV2WebhookPayload,
  NormalizedBookingFields,
  extractBookingData,
  isTrackmanV2Payload,
  normalizeBookingFields,
  parseDateTime,
  mapBayNameToResourceId,
  parseTrackmanV2Payload,
} from './webhook-helpers';
import { resolveLinkedEmail, findMemberByEmail } from './webhook-validation';
import {
  updateBaySlotCache,
  createBookingForMember
} from './webhook-billing';
import { getErrorMessage } from '../../utils/errorUtils';
import { tryAutoApproveBooking, cancelBookingByTrackmanId, saveToUnmatchedBookings, createUnmatchedBookingRequest } from './webhook-matching';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { syncBookingInvoice } from '../../core/billing/bookingInvoiceService';

interface CancelledBookingRow {
  id: number;
  user_email: string;
  staff_notes: string | null;
  session_id: number | null;
}

interface IdRow {
  id: number;
}

interface UserRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string;
}

async function tryLinkCancelledBooking(
  customerEmail: string,
  slotDate: string,
  startTime: string,
  trackmanBookingId: string
): Promise<{ matched: boolean; bookingId?: number; refundedPasses?: number }> {
  try {
    const result = await db.execute(sql`SELECT id, user_email, staff_notes, session_id FROM booking_requests 
       WHERE LOWER(user_email) = LOWER(${customerEmail})
         AND request_date = ${slotDate}
         AND ABS(EXTRACT(EPOCH FROM (start_time::time - ${startTime}::time))) <= 600
         AND (
           (start_time < end_time AND ${startTime}::time < end_time)
           OR
           (start_time >= end_time AND (${startTime}::time < end_time OR ${startTime}::time >= start_time))
         )
         AND status = 'cancelled'
         AND updated_at >= NOW() - INTERVAL '24 hours'
         AND trackman_booking_id IS NULL
       ORDER BY ABS(EXTRACT(EPOCH FROM (start_time::time - ${startTime}::time))), updated_at DESC
       LIMIT 1`);
    
    const cancelledRows = result.rows as unknown as CancelledBookingRow[];
    if (cancelledRows.length === 0) {
      return { matched: false };
    }
    
    const cancelledBooking = cancelledRows[0];
    const bookingId = cancelledBooking.id;
    const _memberEmail = cancelledBooking.user_email;
    
    const updatedNotes = (cancelledBooking.staff_notes || '') + 
      ' [Trackman booking linked - request was cancelled, manual Trackman cancellation may be needed]';
    
    const updateResult = await db.execute(sql`UPDATE booking_requests 
       SET trackman_booking_id = ${trackmanBookingId}, 
           staff_notes = ${updatedNotes},
           updated_at = NOW()
       WHERE id = ${bookingId} AND trackman_booking_id IS NULL
       RETURNING id`);
    
    const cancelUpdateRows = updateResult.rows as unknown as IdRow[];
    if (cancelUpdateRows.length === 0) {
      logger.warn('[Trackman Webhook] Cancelled booking was already linked by another process', {
        extra: { bookingId, trackmanBookingId, email: customerEmail, date: slotDate, time: startTime }
      });
      return { matched: false };
    }
    
    logger.info('[Trackman Webhook] Linked Trackman booking to cancelled request', {
      extra: { bookingId, trackmanBookingId, email: customerEmail, date: slotDate, time: startTime }
    });
    
    return { matched: true, bookingId, refundedPasses: 0 };
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to link cancelled booking', { error: e as Error });
    return { matched: false };
  }
}

async function notifyStaffCancelledBookingLinked(
  memberName: string,
  memberEmail: string,
  slotDate: string,
  startTime: string,
  bayName?: string,
  bookingId?: number,
  refundedPasses?: number
): Promise<void> {
  try {
    const passInfo = refundedPasses && refundedPasses > 0 
      ? ` (${refundedPasses} guest pass${refundedPasses > 1 ? 'es' : ''} refunded)` 
      : '';
    
    const title = 'Trackman Booking Linked to Cancelled Request';
    const message = `A Trackman booking for ${memberName} (${memberEmail || 'no email'}) on ${slotDate} at ${startTime}${bayName ? ` (${bayName})` : ''} was linked to a cancelled request.${passInfo} Manual Trackman cancellation may be needed.`;
    
    broadcastToStaff({
      type: 'trackman_cancelled_link',
      title,
      message,
      data: { 
        bookingId, 
        memberEmail, 
        date: slotDate,
        time: startTime,
        refundedPasses
      }
    });
    
    await notifyAllStaff(
      title,
      message,
      'trackman_cancelled_link',
      {
        relatedId: bookingId,
        relatedType: 'trackman_booking'
      }
    );
    
    logger.info('[Trackman Webhook] Notified staff about cancelled booking link', { 
      extra: { memberName, memberEmail, date: slotDate, bookingId, refundedPasses } 
    });
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to notify staff about cancelled booking', { error: e as Error });
  }
}

async function notifyMemberBookingConfirmed(
  customerEmail: string,
  bookingId: number,
  slotDate: string,
  startTime: string,
  bayName?: string
): Promise<void> {
  try {
    const userResult = await db.execute(sql`SELECT id, first_name, last_name, email FROM users WHERE LOWER(email) = LOWER(${customerEmail})`);
    
    const userRows = userResult.rows as unknown as UserRow[];
    if (userRows.length > 0) {
      const user = userRows[0];
      const _memberName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Member';
      const message = `Your simulator booking for ${slotDate} at ${startTime}${bayName ? ` (${bayName})` : ''} has been confirmed.`;
      
      const result = await notifyMember(
        {
          userEmail: customerEmail,
          title: 'Booking Confirmed',
          message,
          type: 'booking_approved',
          relatedId: bookingId,
          relatedType: 'booking',
          url: '/bookings'
        },
        {
          sendPush: true,
          sendWebSocket: true,
          sendEmail: false
        }
      );
      
      logger.info('[Trackman Webhook] Member notified via unified service', { 
        extra: { 
          email: customerEmail, 
          bookingId,
          channels: result.deliveryResults.map(r => ({ channel: r.channel, success: r.success }))
        } 
      });
    }
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to notify member', { error: e as Error });
  }
}

function formatNotifDateTime(slotDate: string, time24: string): string {
  try {
    const [year, month, day] = slotDate.split('-').map(Number);
    const [h, m] = time24.split(':').map(Number);
    const d = new Date(year, month - 1, day);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const timeStr = m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, '0')} ${period}`;
    return `${dayNames[d.getDay()]}, ${monthNames[month - 1]} ${day} at ${timeStr}`;
  } catch (err) {
    logger.debug('Failed to format friendly date/time, using raw values', { error: err });
    return `${slotDate} at ${time24}`;
  }
}

function calcDurationMin(startTime: string, endTime?: string): number | null {
  if (!endTime) return null;
  try {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const diff = (eh * 60 + em) - (sh * 60 + sm);
    return diff > 0 ? diff : null;
  } catch (err) {
    logger.debug('Failed to calculate duration from time strings', { error: err });
    return null;
  }
}

async function notifyStaffBookingCreated(
  action: 'auto_approved' | 'auto_created' | 'unmatched',
  memberName: string,
  memberEmail: string | undefined,
  slotDate: string,
  startTime: string,
  bayName?: string,
  bookingId?: number,
  endTime?: string
): Promise<void> {
  try {
    let title: string;
    let message: string;
    let notificationType: import('../../core/notificationService').NotificationType;
    
    const friendly = formatNotifDateTime(slotDate, startTime);
    const dur = calcDurationMin(startTime, endTime);
    const durStr = dur ? ` (${dur} min)` : '';
    const bayStr = bayName || 'Unknown bay';
    
    switch (action) {
      case 'auto_approved':
        title = 'Booking Auto-Approved';
        message = `${memberName}'s pending request for ${friendly}${durStr} — ${bayStr} — was auto-approved via Trackman.`;
        notificationType = 'trackman_booking';
        break;
      case 'auto_created':
        title = 'Booking Auto-Created';
        message = `Booking for ${memberName} on ${friendly}${durStr} — ${bayStr} — auto-created from Trackman.`;
        notificationType = 'trackman_booking';
        break;
      case 'unmatched':
        title = 'Unmatched Trackman Booking';
        message = `${bayStr} — ${friendly}${durStr} — ${memberEmail ? memberEmail : 'no member email'}, needs staff review.`;
        notificationType = 'trackman_unmatched';
        break;
    }
    
    broadcastToStaff({
      type: notificationType,
      title,
      message,
      data: { 
        bookingId, 
        memberEmail, 
        action,
        date: slotDate,
        time: startTime
      }
    });
    
    if (action !== 'unmatched') {
      await notifyAllStaff(
        title,
        message,
        notificationType,
        {
          relatedId: bookingId,
          relatedType: 'trackman_booking'
        }
      );
    }
    
    logger.info('[Trackman Webhook] Notified staff', { 
      extra: { action, memberName, memberEmail, date: slotDate } 
    });
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to notify staff', { error: e as Error });
  }
}

export async function handleBookingUpdate(payload: TrackmanWebhookPayload): Promise<{ success: boolean; matchedBookingId?: number }> {
  let normalized: NormalizedBookingFields;
  let bayRef: string | undefined;
  
  // Detect V2 format and use appropriate parser
  if (isTrackmanV2Payload(payload)) {
    const v2Result = parseTrackmanV2Payload(payload as TrackmanV2WebhookPayload);
    normalized = v2Result.normalized;
    bayRef = v2Result.bayRef;
    
    logger.info('[Trackman Webhook] handleBookingUpdate: Processing V2 payload', {
      extra: { 
        trackmanBookingId: normalized.trackmanBookingId,
        date: normalized.parsedDate,
        time: normalized.parsedStartTime,
        bayRef
      }
    });
  } else {
    const bookingData = extractBookingData(payload);
    if (!bookingData) {
      return { success: false };
    }
    normalized = normalizeBookingFields(bookingData);
  }
  
  if (!normalized.trackmanBookingId) {
    logger.warn('[Trackman Webhook] No booking ID in payload');
    return { success: false };
  }
  
  // For V2 payloads, parsedDate/parsedStartTime are pre-populated
  // For V1 payloads, we need to parse from startTime/date
  // eslint-disable-next-line no-useless-assignment
  let startParsed: { date: string; time: string } | null = null;
  // eslint-disable-next-line no-useless-assignment
  let endParsed: { time: string } | null = null;
  
  if (normalized.parsedDate && normalized.parsedStartTime) {
    startParsed = { date: normalized.parsedDate, time: normalized.parsedStartTime };
    endParsed = normalized.parsedEndTime ? { time: normalized.parsedEndTime } : null;
  } else {
    startParsed = parseDateTime(normalized.startTime, normalized.date);
    endParsed = parseDateTime(normalized.endTime, undefined);
  }
  
  if (!startParsed) {
    logger.warn('[Trackman Webhook] Could not parse start time', { extra: { startTime: normalized.startTime } });
    return { success: false };
  }
  
  const resourceId = mapBayNameToResourceId(normalized.bayName, normalized.bayId, normalized.baySerial, bayRef);
  
  if (!resourceId && (normalized.bayName || normalized.bayId || normalized.baySerial)) {
    logger.warn('[Trackman Webhook] Could not map bay to resource ID', {
      extra: { 
        trackmanBookingId: normalized.trackmanBookingId,
        bayName: normalized.bayName,
        bayId: normalized.bayId,
        baySerial: normalized.baySerial
      }
    });
  }
  
  const status = normalized.status?.toLowerCase();
  const isCancel = status === 'cancelled' || status === 'canceled' || status === 'deleted';
  const slotStatus: 'booked' | 'cancelled' | 'completed' = isCancel ? 'cancelled' : 
    (status === 'completed' || status === 'finished') ? 'completed' : 'booked';
  
  if (resourceId) {
    await updateBaySlotCache(
      normalized.trackmanBookingId,
      resourceId,
      startParsed.date,
      startParsed.time,
      endParsed?.time || startParsed.time,
      slotStatus,
      normalized.customerEmail,
      normalized.customerName,
      normalized.playerCount
    );
  }
  
  let matchedBookingId: number | undefined;
  
  if (isCancel) {
    // cancelBookingByTrackmanId handles availability broadcast, member notification, and staff notification internally
    const cancelResult = await cancelBookingByTrackmanId(normalized.trackmanBookingId);
    if (cancelResult.cancelled) {
      matchedBookingId = cancelResult.bookingId;
      
      logger.info('[Trackman Webhook] Handled booking cancellation', {
        extra: { trackmanBookingId: normalized.trackmanBookingId, bookingId: cancelResult.bookingId }
      });
    }
    return { success: true, matchedBookingId };
  }
  
  if (!normalized.customerEmail) {
    logger.info('[Trackman Webhook] No customer email provided, creating unmatched booking request', {
      extra: { trackmanBookingId: normalized.trackmanBookingId }
    });
    
    // Also save to legacy unmatched table for backward compatibility
    await saveToUnmatchedBookings(
      normalized.trackmanBookingId,
      startParsed.date,
      startParsed.time,
      endParsed?.time || startParsed.time,
      resourceId,
      undefined,
      normalized.customerName,
      normalized.playerCount,
      'no_customer_email_in_webhook'
    );
    
    // Create a proper booking request so it appears on calendar and in assignment queue
    const unmatchedResult = await createUnmatchedBookingRequest(
      normalized.trackmanBookingId,
      normalized.externalBookingId,
      startParsed.date,
      startParsed.time,
      endParsed?.time || startParsed.time,
      resourceId,
      undefined,  // No customer email
      normalized.customerName,
      normalized.playerCount
    );
    
    // Broadcast availability update for real-time calendar refresh
    if (unmatchedResult.bookingId) {
      broadcastAvailabilityUpdate({
        resourceId: resourceId ?? undefined,
        date: startParsed.date,
        action: 'booked',
      });
    }
    
    await notifyStaffBookingCreated(
      'unmatched',
      normalized.customerName || 'Unknown',
      undefined,
      startParsed.date,
      startParsed.time,
      normalized.bayName,
      unmatchedResult.bookingId,
      endParsed?.time
    );
    
    return { success: true, matchedBookingId: unmatchedResult.bookingId };
  }
  
  const resolvedEmail = await resolveLinkedEmail(normalized.customerEmail);
  const emailForLookup = resolvedEmail;
  
  logger.info('[Trackman Webhook] Processing booking', {
    extra: { 
      originalEmail: normalized.customerEmail, 
      resolvedEmail: emailForLookup,
      wasLinked: emailForLookup !== normalized.customerEmail,
      date: startParsed.date,
      time: startParsed.time
    }
  });
  
  const autoApproveResult = await tryAutoApproveBooking(
    emailForLookup,
    startParsed.date,
    startParsed.time,
    normalized.trackmanBookingId
  );
  
  if (autoApproveResult.matched && autoApproveResult.bookingId) {
    matchedBookingId = autoApproveResult.bookingId;
    
    // Broadcast availability update for real-time calendar refresh
    broadcastAvailabilityUpdate({
      resourceId: autoApproveResult.resourceId || (resourceId ?? undefined),
      date: startParsed.date,
      action: 'booked',
    });
    
    broadcastToStaff({
      type: 'booking_auto_confirmed',
      title: 'Booking Auto-Confirmed',
      message: `${normalized.customerName || emailForLookup}'s booking for ${startParsed.date} at ${startParsed.time} (${normalized.bayName || 'Unknown bay'}) was auto-approved via Trackman.`,
      data: {
        bookingId: autoApproveResult.bookingId,
        memberName: normalized.customerName || emailForLookup,
        memberEmail: emailForLookup,
        date: startParsed.date,
        time: startParsed.time,
        bay: normalized.bayName,
        wasAutoApproved: true,
        trackmanBookingId: normalized.trackmanBookingId
      }
    });
    
    await notifyMemberBookingConfirmed(
      emailForLookup,
      autoApproveResult.bookingId,
      startParsed.date,
      startParsed.time,
      normalized.bayName
    );
    
    await notifyStaffBookingCreated(
      'auto_approved',
      normalized.customerName || emailForLookup,
      emailForLookup,
      startParsed.date,
      startParsed.time,
      normalized.bayName,
      autoApproveResult.bookingId,
      endParsed?.time
    );
    
    if (autoApproveResult.sessionId && normalized.playerCount > 1) {
      try {
        const existingCount = await db.execute(sql`SELECT COUNT(*) as cnt FROM booking_participants WHERE session_id = ${autoApproveResult.sessionId}`);
        const currentParticipants = Number((existingCount.rows as Array<Record<string, unknown>>)[0]?.cnt || 0);
        const targetTotal = normalized.playerCount;
        const slotsToFill = Math.max(0, targetTotal - currentParticipants);
        if (slotsToFill > 0) {
          const timeResult = await db.execute(sql`SELECT start_time, end_time FROM booking_sessions WHERE id = ${autoApproveResult.sessionId}`);
          const sessionRow = (timeResult.rows as Array<Record<string, unknown>>)[0];
          const slotDuration = sessionRow?.start_time && sessionRow?.end_time
            ? Math.round((new Date(`2000-01-01T${sessionRow.end_time}`).getTime() - 
                         new Date(`2000-01-01T${sessionRow.start_time}`).getTime()) / 60000)
            : 60;
          for (let i = 0; i < slotsToFill; i++) {
            await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              VALUES (${autoApproveResult.sessionId}, NULL, ${PARTICIPANT_TYPE.GUEST}, ${`Guest ${currentParticipants + i + 1}`}, ${PAYMENT_STATUS.WAIVED}, ${slotDuration})`);
          }
          await recalculateSessionFees(autoApproveResult.sessionId, 'trackman_webhook');
          syncBookingInvoice(autoApproveResult.bookingId, autoApproveResult.sessionId).catch((syncErr: unknown) => {
            logger.warn('[Trackman Webhook] Invoice sync failed after guest backfill', { extra: { bookingId: autoApproveResult.bookingId, sessionId: autoApproveResult.sessionId, error: syncErr } });
          });
          logger.info('[Trackman Webhook] Backfilled generic guest slots after auto-approve', {
            extra: { bookingId: autoApproveResult.bookingId, sessionId: autoApproveResult.sessionId, slotsToFill, currentParticipants, targetTotal }
          });
        }
      } catch (backfillErr: unknown) {
        logger.warn('[Trackman Webhook] Non-blocking: Failed to backfill guest slots after auto-approve', {
          extra: { bookingId: autoApproveResult.bookingId, error: getErrorMessage(backfillErr) }
        });
      }
    }

    linkAndNotifyParticipants(autoApproveResult.bookingId, {
      trackmanBookingId: normalized.trackmanBookingId,
      linkedBy: 'trackman_webhook',
      bayName: normalized.bayName
    }).catch(err => {
      logger.warn('[Trackman Webhook] Failed to link request participants', { extra: { bookingId: autoApproveResult.bookingId, error: err } });
    });
    
    logger.info('[Trackman Webhook] Auto-approved pending booking request', {
      extra: { bookingId: matchedBookingId, email: emailForLookup }
    });
    return { success: true, matchedBookingId };
  }
  
  const cancelledLinkResult = await tryLinkCancelledBooking(
    emailForLookup,
    startParsed.date,
    startParsed.time,
    normalized.trackmanBookingId
  );
  
  if (cancelledLinkResult.matched && cancelledLinkResult.bookingId) {
    matchedBookingId = cancelledLinkResult.bookingId;
    
    await notifyStaffCancelledBookingLinked(
      normalized.customerName || emailForLookup,
      emailForLookup,
      startParsed.date,
      startParsed.time,
      normalized.bayName,
      cancelledLinkResult.bookingId,
      cancelledLinkResult.refundedPasses
    );
    
    logger.info('[Trackman Webhook] Linked Trackman booking to cancelled request (main flow)', {
      extra: { 
        bookingId: matchedBookingId, 
        email: emailForLookup,
        refundedPasses: cancelledLinkResult.refundedPasses
      }
    });
    
    return { success: true, matchedBookingId };
  }
  
  const member = await findMemberByEmail(emailForLookup);
  
  if (member) {
    if (!resourceId) {
      logger.warn('[Trackman Webhook] Cannot auto-create booking - bay not mapped. Saving to unmatched for staff resolution.', {
        extra: { 
          email: member.email, 
          bayName: normalized.bayName, 
          bayId: normalized.bayId,
          trackmanBookingId: normalized.trackmanBookingId
        }
      });
      await saveToUnmatchedBookings(
        normalized.trackmanBookingId,
        startParsed.date,
        startParsed.time,
        endParsed?.time || startParsed.time,
        null,
        normalized.customerEmail,
        normalized.customerName,
        normalized.playerCount,
        'bay_unmapped'
      );
      
      const unmatchedResult = await createUnmatchedBookingRequest(
        normalized.trackmanBookingId,
        normalized.externalBookingId,
        startParsed.date,
        startParsed.time,
        endParsed?.time || startParsed.time,
        null,
        normalized.customerEmail,
        normalized.customerName,
        normalized.playerCount
      );
      
      if (unmatchedResult.created && unmatchedResult.bookingId) {
        matchedBookingId = unmatchedResult.bookingId;
        
        // Broadcast availability update for real-time calendar refresh
        broadcastAvailabilityUpdate({
          resourceId: undefined,
          date: startParsed.date,
          action: 'booked',
        });
        
        await notifyStaffBookingCreated(
          'unmatched',
          normalized.customerName || 'Unknown',
          normalized.customerEmail,
          startParsed.date,
          startParsed.time,
          undefined,
          unmatchedResult.bookingId,
          endParsed?.time
        );
      }
      
      return { success: true, matchedBookingId };
    }
    
    const createResult = await createBookingForMember(
      member,
      normalized.trackmanBookingId,
      startParsed.date,
      startParsed.time,
      endParsed?.time || startParsed.time,
      resourceId,
      normalized.playerCount,
      normalized.customerName
    );
    
    if (createResult.success && createResult.bookingId) {
      matchedBookingId = createResult.bookingId;
      
      const memberName = [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;
      
      await notifyMemberBookingConfirmed(
        member.email,
        createResult.bookingId,
        startParsed.date,
        startParsed.time,
        normalized.bayName
      );
      
      await notifyStaffBookingCreated(
        'auto_created',
        memberName,
        member.email,
        startParsed.date,
        startParsed.time,
        normalized.bayName,
        createResult.bookingId,
        endParsed?.time
      );
      
      // Broadcast availability update for real-time calendar refresh
      broadcastAvailabilityUpdate({
        resourceId,
        date: startParsed.date,
        action: 'booked',
      });
      
      logger.info('[Trackman Webhook] Auto-created booking for known member (no pending request)', {
        extra: { bookingId: matchedBookingId, email: member.email, resourceId, memberName }
      });
    }
    
    return { success: true, matchedBookingId };
  }
  
  logger.info('[Trackman Webhook] No member found for email, saving to unmatched', {
    extra: { email: normalized.customerEmail, resolvedEmail: emailForLookup }
  });
  
  await saveToUnmatchedBookings(
    normalized.trackmanBookingId,
    startParsed.date,
    startParsed.time,
    endParsed?.time || startParsed.time,
    resourceId,
    normalized.customerEmail,
    normalized.customerName,
    normalized.playerCount
  );
  
  const unmatchedResult = await createUnmatchedBookingRequest(
    normalized.trackmanBookingId,
    normalized.externalBookingId,
    startParsed.date,
    startParsed.time,
    endParsed?.time || startParsed.time,
    resourceId,
    normalized.customerEmail,
    normalized.customerName,
    normalized.playerCount
  );
  
  if (unmatchedResult.created && unmatchedResult.bookingId) {
    matchedBookingId = unmatchedResult.bookingId;
    
    // Broadcast availability update for real-time calendar refresh
    broadcastAvailabilityUpdate({
      resourceId: resourceId ?? undefined,
      date: startParsed.date,
      action: 'booked',
    });
  }
  
  await notifyStaffBookingCreated(
    'unmatched',
    normalized.customerName || 'Unknown',
    normalized.customerEmail,
    startParsed.date,
    startParsed.time,
    normalized.bayName,
    unmatchedResult.bookingId,
    endParsed?.time
  );
  
  return { success: true, matchedBookingId };
}
