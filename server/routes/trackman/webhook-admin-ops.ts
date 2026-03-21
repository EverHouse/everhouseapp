import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logger } from '../../core/logger';
import { broadcastToStaff } from '../../core/websocket';
import { notifyMember } from '../../core/notificationService';
import { isStaffOrAdmin } from '../../core/middleware';
import { linkAndNotifyParticipants } from '../../core/bookingEvents';
import { handleBookingUpdate } from './webhook-handlers';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { transferRequestParticipantsToSession } from '../../core/trackmanImport';
import { getErrorMessage } from '../../utils/errorUtils';
import { formatTime12Hour } from '../../utils/dateUtils';

interface WebhookEventRetryRow {
  id: number;
  event_type: string;
  payload: string | Record<string, unknown>;
  trackman_booking_id: string | null;
  retry_count: number | null;
}

interface WebhookEventAutoMatchRow {
  id: number;
  event_type: string;
  payload: string | Record<string, unknown>;
  trackman_booking_id: string | null;
  matched_booking_id: number | null;
}

interface BookingUnmatchedCheckRow {
  id: number;
  user_email: string;
  is_unmatched: boolean;
}

interface ApprovedMatchRow {
  id: number;
  user_email: string;
  status: string;
  start_time: string;
  end_time: string;
  request_date: string;
  resource_id: number | null;
  member_name: string | null;
}

const router = Router();

export async function cleanupOldWebhookLogs(): Promise<{ deleted: number }> {
  try {
    const result = await db.execute(sql`DELETE FROM trackman_webhook_events 
       WHERE processed_at < NOW() - INTERVAL '30 days'
       RETURNING id`);
    
    const deleted = result.rowCount || 0;
    if (deleted > 0) {
      logger.info('[Trackman Webhook] Cleaned up old webhook logs', { 
        extra: { deletedCount: deleted } 
      });
    }
    
    return { deleted };
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to cleanup old logs', { error: error instanceof Error ? error : new Error(String(error)) });
    return { deleted: 0 };
  }
}

router.get('/api/admin/trackman-webhook/failed', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await db.execute(sql`SELECT 
        id,
        event_type,
        trackman_booking_id,
        processing_error,
        processed_at,
        retry_count,
        last_retry_at
       FROM trackman_webhook_events 
       WHERE processing_error IS NOT NULL
       ORDER BY processed_at DESC
       LIMIT 50`);
    
    res.json(result.rows);
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to fetch failed events', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch failed events' });
  }
});

router.post('/api/admin/trackman-webhook/:eventId/retry', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const eventId = parseInt(req.params.eventId as string, 10);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    
    if (isNaN(eventId)) {
      return res.status(400).json({ error: 'Invalid event ID' });
    }
    
    const eventResult = await db.execute(sql`SELECT id, event_type, payload, trackman_booking_id, retry_count
       FROM trackman_webhook_events 
       WHERE id = ${eventId}`);
    
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = eventResult.rows[0] as unknown as WebhookEventRetryRow;
    let payload: Record<string, unknown>;
    try {
      payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    } catch {
      return res.status(400).json({ error: 'Event has corrupted payload data' });
    }
    
    await db.execute(sql`UPDATE trackman_webhook_events 
       SET retry_count = COALESCE(retry_count, 0) + 1, 
           last_retry_at = NOW()
       WHERE id = ${eventId}`);
    
    logger.info('[Trackman Webhook] Admin triggered retry', {
      extra: { eventId, eventType: event.event_type, retryCount: Number((event.retry_count || 0)) + 1 }
    });
    
    let success = false;
    let message = '';
    let matchedBookingId: number | undefined;
    
    if (event.event_type === 'booking.created' || event.event_type === 'booking.updated') {
      try {
        const result = await handleBookingUpdate(payload);
        success = result.success;
        matchedBookingId = result.matchedBookingId;
        message = success 
          ? `Successfully reprocessed webhook${matchedBookingId ? ` (matched booking #${matchedBookingId})` : ''}`
          : 'Reprocessing completed but no booking was matched';
          
        logger.info('[Trackman Webhook] Retry processing completed', {
          extra: { eventId, success, matchedBookingId }
        });
      } catch (processError: unknown) {
        message = `Reprocessing failed: ${getErrorMessage(processError)}`;
        logger.error('[Trackman Webhook] Retry processing error', {
          error: processError instanceof Error ? processError : new Error(String(processError)),
          extra: { eventId }
        });
      }
    } else {
      message = 'Event type not supported for retry';
    }
    
    if (success) {
      await db.execute(sql`UPDATE trackman_webhook_events 
         SET processing_error = NULL,
             matched_booking_id = COALESCE(${matchedBookingId || null}, matched_booking_id)
         WHERE id = ${eventId}`);
    } else {
      await db.execute(sql`UPDATE trackman_webhook_events 
         SET processing_error = ${message}
         WHERE id = ${eventId}`);
    }
    
    res.json({ success, message, matchedBookingId });
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to retry event', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to retry event' });
  }
});

router.post('/api/admin/trackman-webhook/:eventId/auto-match', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const eventId = parseInt(req.params.eventId as string, 10);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    
    if (isNaN(eventId)) {
      return res.status(400).json({ error: 'Invalid event ID' });
    }
    
    const eventResult = await db.execute(sql`SELECT id, event_type, payload, trackman_booking_id, matched_booking_id
       FROM trackman_webhook_events 
       WHERE id = ${eventId}`);
    
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = eventResult.rows[0] as unknown as WebhookEventAutoMatchRow;
    
    if (event.matched_booking_id) {
      const matchedBooking = await db.execute(sql`SELECT id, user_email, is_unmatched FROM booking_requests WHERE id = ${event.matched_booking_id}`);
      
      if (matchedBooking.rows.length > 0 && !(matchedBooking.rows[0] as unknown as BookingUnmatchedCheckRow).is_unmatched) {
        return res.status(409).json({ 
          success: false, 
          message: 'This event is already linked to a member booking',
          alreadyLinked: true
        });
      }
    }
    
    let payload: Record<string, unknown>;
    try {
      payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    } catch {
      return res.status(400).json({ error: 'Event has corrupted payload data' });
    }
    const trackmanBookingId = event.trackman_booking_id;
    
    if (!trackmanBookingId) {
      return res.status(400).json({ error: 'Event has no Trackman booking ID to link' });
    }
    
    const bookingData = (payload?.data || payload?.booking || {}) as Record<string, unknown>;
    const bookingStart = bookingData?.start;
    
    if (!bookingStart) {
      return res.status(400).json({ error: 'Cannot determine booking date/time from event' });
    }
    
    const startDate = new Date(bookingStart as string | number);
    const pacificDate = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const pacificStartTime = startDate.toLocaleTimeString('en-US', { 
      timeZone: 'America/Los_Angeles', 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    let resourceId: number | null = null;
    const bayRef = (bookingData?.bay as Record<string, unknown>)?.ref;
    if (bayRef) {
      const refNum = parseInt(String(bayRef).trim(), 10);
      if (refNum >= 1 && refNum <= 4) {
        resourceId = refNum;
      }
    }
    
    if (!resourceId) {
      return res.status(400).json({ error: 'Cannot determine bay from event' });
    }
    
    logger.info('[Trackman Auto-Match] Searching for matching booking requests', {
      extra: { eventId, trackmanBookingId, date: pacificDate, start: pacificStartTime, bay: resourceId }
    });
    
    const matchResult = await db.execute(sql`SELECT 
        id, user_email, status, start_time, end_time, request_date, resource_id,
        (SELECT CONCAT(first_name, ' ', last_name) FROM users WHERE LOWER(email) = LOWER(br.user_email) LIMIT 1) as member_name
       FROM booking_requests br
       WHERE resource_id = ${resourceId}
         AND request_date = ${pacificDate}
         AND trackman_booking_id IS NULL
         AND status = 'pending'
         AND ABS(EXTRACT(EPOCH FROM (start_time::time - ${pacificStartTime}::time))) <= 1800
       ORDER BY ABS(EXTRACT(EPOCH FROM (start_time::time - ${pacificStartTime}::time))) ASC
       LIMIT 5`);
    
    if (matchResult.rows.length === 0) {
      const approvedMatchResult = await db.execute(sql`SELECT 
          id, user_email, status, start_time, end_time, request_date, resource_id,
          (SELECT CONCAT(first_name, ' ', last_name) FROM users WHERE LOWER(email) = LOWER(br.user_email) LIMIT 1) as member_name
         FROM booking_requests br
         WHERE resource_id = ${resourceId}
           AND request_date = ${pacificDate}
           AND trackman_booking_id IS NULL
           AND status = 'approved'
           AND ABS(EXTRACT(EPOCH FROM (start_time::time - ${pacificStartTime}::time))) <= 1800
         ORDER BY ABS(EXTRACT(EPOCH FROM (start_time::time - ${pacificStartTime}::time))) ASC
         LIMIT 5`);
      
      if (approvedMatchResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No matching booking requests found for this bay, date, and time',
          searched: { date: pacificDate, startTime: pacificStartTime, bay: resourceId }
        });
      }
      
      const match = approvedMatchResult.rows[0] as unknown as ApprovedMatchRow;
      
      const updateResult = await db.execute(sql`UPDATE booking_requests 
         SET trackman_booking_id = ${trackmanBookingId},
             last_sync_source = 'staff_auto_match',
             last_trackman_sync_at = NOW(),
             was_auto_linked = true,
             staff_notes = COALESCE(staff_notes, '') || ' [Linked via Auto-Match]',
             updated_at = NOW()
         WHERE id = ${match.id} AND trackman_booking_id IS NULL
         RETURNING id`);
      
      if (updateResult.rowCount === 0) {
        return res.status(409).json({
          success: false,
          message: 'Booking was already linked by another process',
          conflict: true
        });
      }
      
      await db.execute(sql`UPDATE trackman_webhook_events 
         SET matched_booking_id = ${match.id}
         WHERE id = ${eventId} AND (matched_booking_id IS NULL OR matched_booking_id = ${event.matched_booking_id})`);
      
      logger.info('[Trackman Auto-Match] Successfully linked to approved booking', {
        extra: { eventId, trackmanBookingId, bookingId: match.id, memberEmail: match.user_email }
      });
      
      return res.json({
        success: true,
        message: `Linked to ${match.member_name || match.user_email}'s approved booking`,
        bookingId: match.id,
        memberEmail: match.user_email,
        memberName: match.member_name
      });
    }
    
    const match = matchResult.rows[0] as unknown as ApprovedMatchRow;
    
    const pendingUpdateResult = await db.execute(sql`UPDATE booking_requests 
       SET status = 'approved',
           trackman_booking_id = ${trackmanBookingId},
           reviewed_at = NOW(),
           reviewed_by = 'staff_auto_match',
           last_sync_source = 'staff_auto_match',
           last_trackman_sync_at = NOW(),
           was_auto_linked = true,
           staff_notes = COALESCE(staff_notes, '') || ' [Auto-approved via Staff Auto-Match]',
           updated_at = NOW()
       WHERE id = ${match.id} AND trackman_booking_id IS NULL AND status = 'pending'
       RETURNING id`);
    
    if (pendingUpdateResult.rowCount === 0) {
      return res.status(409).json({
        success: false,
        message: 'Booking was already linked or approved by another process',
        conflict: true
      });
    }
    
    broadcastToStaff({
      type: 'booking_auto_confirmed',
      title: 'Booking Auto-Confirmed',
      message: `${match.member_name || match.user_email}'s booking for ${pacificDate} at ${formatTime12Hour(pacificStartTime)} was auto-approved via Staff Auto-Match.`,
      data: {
        bookingId: match.id,
        memberName: match.member_name || match.user_email,
        memberEmail: match.user_email,
        date: pacificDate,
        time: pacificStartTime,
        bay: `Bay ${resourceId}`,
        wasAutoApproved: true,
        trackmanBookingId
      }
    });
    
    await db.execute(sql`UPDATE trackman_webhook_events 
       SET matched_booking_id = ${match.id}
       WHERE id = ${eventId} AND (matched_booking_id IS NULL OR matched_booking_id = ${event.matched_booking_id})`);
    
    try {
      const sessionResult = await ensureSessionForBooking({
        bookingId: match.id as number,
        resourceId: resourceId as number,
        sessionDate: pacificDate,
        startTime: (match.start_time as string) || pacificStartTime,
        endTime: (match.end_time as string) || pacificStartTime,
        ownerEmail: match.user_email as string,
        ownerName: (match.member_name as string) || undefined,
        trackmanBookingId: trackmanBookingId as string,
        source: 'trackman_webhook',
        createdBy: 'staff_auto_match'
      });

      if (sessionResult.sessionId && !sessionResult.error) {
        let transferredCount = 0;
        try {
          const rpResult = await db.execute(sql`SELECT request_participants FROM booking_requests WHERE id = ${match.id}`);
          const rpData = (rpResult.rows[0] as { request_participants: unknown })?.request_participants;
          if (rpData && Array.isArray(rpData) && rpData.length > 0) {
            transferredCount = await transferRequestParticipantsToSession(
              sessionResult.sessionId, rpData, match.user_email as string, `staff auto-match booking #${match.id}`
            );
          }
        } catch (rpErr: unknown) {
          logger.warn('[Trackman Auto-Match] Non-blocking: Failed to transfer request_participants', {
            extra: { bookingId: match.id, sessionId: sessionResult.sessionId, error: getErrorMessage(rpErr) }
          });
        }

        const playerCount = Number((bookingData as Record<string, unknown>)?.playerCount || (bookingData as Record<string, unknown>)?.player_count || (bookingData as Record<string, unknown>)?.numberOfPlayers || 1);
        if (playerCount > 1) {
          const startTimeStr = (match.start_time as string) || pacificStartTime;
          const endTimeStr = (match.end_time as string) || pacificStartTime;
          const slotDuration = startTimeStr && endTimeStr
            ? Math.round((new Date(`2000-01-01T${endTimeStr}`).getTime() -
                         new Date(`2000-01-01T${startTimeStr}`).getTime()) / 60000)
            : 60;
          const remainingSlots = Math.max(0, (playerCount - 1) - transferredCount);
          for (let i = 0; i < remainingSlots; i++) {
            await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              VALUES (${sessionResult.sessionId}, NULL, 'guest', ${`Guest ${transferredCount + i + 2}`}, 'pending', ${slotDuration})`);
          }
          if (transferredCount > 0 || remainingSlots > 0) {
            await recalculateSessionFees(sessionResult.sessionId, 'staff_auto_match');
            const { syncBookingInvoice } = await import('../../core/billing/bookingInvoiceService');
            syncBookingInvoice(match.id as number, sessionResult.sessionId).catch((syncErr: unknown) => {
              logger.warn('[Trackman Auto-Match] Invoice sync failed after fee recalculation', { extra: { bookingId: match.id, sessionId: sessionResult.sessionId, error: syncErr } });
            });
            logger.info('[Trackman Auto-Match] Created participants for matched booking', {
              extra: { bookingId: match.id, sessionId: sessionResult.sessionId, playerCount, transferredFromRequest: transferredCount, genericGuestSlots: remainingSlots }
            });
          }
        }
      }
    } catch (sessionErr: unknown) {
      logger.warn('[Trackman Auto-Match] Failed to ensure session', { extra: { bookingId: match.id, error: sessionErr } });
    }

    try {
      const userResult = await db.execute(sql`SELECT id, first_name, last_name, email FROM users WHERE LOWER(email) = LOWER(${match.user_email})`);
      if (userResult.rows.length > 0) {
        const message = `Your simulator booking for ${pacificDate} at ${formatTime12Hour(pacificStartTime)} (Bay ${resourceId}) has been confirmed.`;
        await notifyMember(
          {
            userEmail: match.user_email as string,
            title: 'Booking Confirmed',
            message,
            type: 'booking_approved',
            relatedId: match.id as number,
            relatedType: 'booking',
            url: '/bookings'
          },
          {
            sendPush: true,
            sendWebSocket: true,
            sendEmail: false
          }
        );
      }
    } catch (notifyErr: unknown) {
      logger.warn('[Trackman Auto-Match] Failed to notify member', { error: notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)) });
    }
    
    linkAndNotifyParticipants(match.id as number, {
      trackmanBookingId: trackmanBookingId as string,
      linkedBy: 'staff_auto_match',
      bayName: `Bay ${resourceId}`
    }).catch(err => {
      logger.warn('[Trackman Auto-Match] Failed to link request participants', { extra: { bookingId: match.id, error: getErrorMessage(err) } });
    });
    
    logger.info('[Trackman Auto-Match] Successfully matched and approved booking', {
      extra: { eventId, trackmanBookingId, bookingId: match.id, memberEmail: match.user_email }
    });
    
    return res.json({
      success: true,
      message: `Matched and approved ${match.member_name || match.user_email}'s pending request`,
      bookingId: match.id,
      memberEmail: match.user_email,
      memberName: match.member_name,
      wasApproved: true
    });
    
  } catch (error: unknown) {
    logger.error('[Trackman Auto-Match] Failed to auto-match event', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to auto-match event' });
  }
});

router.post('/api/admin/trackman-webhook/cleanup', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await cleanupOldWebhookLogs();
    res.json({ success: true, deleted: result.deleted });
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Manual cleanup failed', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cleanup logs' });
  }
});

export default router;
