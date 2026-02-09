import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logger } from '../../core/logger';
import { sendNotificationToUser, broadcastToStaff } from '../../core/websocket';
import { notifyMember } from '../../core/notificationService';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { linkAndNotifyParticipants } from '../../core/bookingEvents';
import { formatDatePacific, formatTimePacific } from '../../utils/dateUtils';
import {
  TrackmanWebhookPayload,
  TrackmanV2WebhookPayload,
  TrackmanV2Booking,
  isProduction,
  isTrackmanV2Payload,
  parseTrackmanV2Payload,
  mapBayNameToResourceId,
  calculateDurationMinutes,
  redactPII,
} from './webhook-helpers';
import { validateTrackmanWebhookSignature, logWebhookEvent, resolveLinkedEmail, findMemberByEmail } from './webhook-validation';
import { 
  handleBookingUpdate, 
  tryAutoApproveBooking, 
  cancelBookingByTrackmanId,
  saveToUnmatchedBookings,
  createUnmatchedBookingRequest,
} from './webhook-handlers';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { 
  updateBaySlotCache, 
  linkByExternalBookingId,
  createBookingForMember,
  tryMatchByBayDateTime,
} from './webhook-billing';

const router = Router();

async function notifyMemberBookingConfirmed(
  customerEmail: string,
  bookingId: number,
  slotDate: string,
  startTime: string,
  bayName?: string
): Promise<void> {
  try {
    const userResult = await db.execute(sql`SELECT id, first_name, last_name, email FROM users WHERE LOWER(email) = LOWER(${customerEmail})`);
    
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const message = `Your simulator booking for ${slotDate} at ${startTime}${bayName ? ` (${bayName})` : ''} has been confirmed.`;
      
      await notifyMember(
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
    }
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to notify member', { error: e as Error });
  }
}

/**
 * Extract trackmanBookingId from webhook payload (handles both V1 and V2 formats)
 */
function extractTrackmanBookingId(payload: any): string | undefined {
  // V2 format: payload.booking.id
  if (payload?.booking?.id !== undefined) {
    return String(payload.booking.id);
  }
  
  // V1 format: payload.data.id or payload.data.booking_id
  if (payload?.data?.id !== undefined) {
    return String(payload.data.id);
  }
  if (payload?.data?.booking_id !== undefined) {
    return String(payload.data.booking_id);
  }
  
  // Fallback: direct payload.id or payload.booking_id
  if (payload?.id !== undefined) {
    return String(payload.id);
  }
  if (payload?.booking_id !== undefined) {
    return String(payload.booking_id);
  }
  
  return undefined;
}

/**
 * Check if webhook is a duplicate using idempotency guard
 * Returns true if this is a NEW webhook (not a duplicate)
 * Returns false if this is a DUPLICATE webhook
 */
async function checkWebhookIdempotency(trackmanBookingId: string): Promise<boolean> {
  try {
    // Try to INSERT the webhook ID. If it already exists (CONFLICT), this will return no rows
    const dedupResult = await db.execute(sql`INSERT INTO trackman_webhook_dedup (trackman_booking_id, received_at)
       VALUES (${trackmanBookingId}, NOW())
       ON CONFLICT (trackman_booking_id) DO NOTHING
       RETURNING id`);
    
    const isNewWebhook = (dedupResult.rowCount || 0) > 0;
    
    if (!isNewWebhook) {
      logger.info('[Trackman Webhook] Duplicate webhook ignored - idempotency guard triggered', {
        extra: { trackmanBookingId }
      });
    }
    
    return isNewWebhook;
  } catch (error) {
    logger.error('[Trackman Webhook] Failed to check webhook idempotency', {
      extra: { trackmanBookingId, error: (error as Error).message }
    });
    // On error, allow processing to continue (fail open)
    return true;
  }
}

router.post('/api/webhooks/trackman', async (req: Request, res: Response) => {
  logger.info('[Trackman Webhook] Received webhook', {
    extra: { 
      headers: Object.keys(req.headers).filter(h => h.startsWith('x-')),
      bodyKeys: Object.keys(req.body || {}),
      hasVenue: !!req.body?.venue,
      hasBookingStart: !!req.body?.booking?.start,
      isV2Format: isTrackmanV2Payload(req.body)
    }
  });
  
  const devWebhookUrl = process.env.DEV_WEBHOOK_FORWARD_URL;
  if (devWebhookUrl && isProduction) {
    fetch(devWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-From': 'production',
        'X-Original-Signature': req.headers['x-trackman-signature'] as string || ''
      },
      body: JSON.stringify(req.body)
    }).then(() => {
      logger.info('[Trackman Webhook] Forwarded to dev environment');
    }).catch(err => {
      logger.warn('[Trackman Webhook] Failed to forward to dev', { error: err });
    });
  }
  
  const isForwardedFromProduction = req.headers['x-forwarded-from'] === 'production';
  if (isForwardedFromProduction && !isProduction) {
    logger.info('[Trackman Webhook] Processing forwarded webhook from production');
  } else if (!validateTrackmanWebhookSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  const payload: TrackmanWebhookPayload = req.body;
  
  // Check for duplicate webhook using idempotency guard BEFORE processing
  const trackmanBookingIdFromPayload = extractTrackmanBookingId(payload);
  if (trackmanBookingIdFromPayload) {
    const isNewWebhook = await checkWebhookIdempotency(trackmanBookingIdFromPayload);
    if (!isNewWebhook) {
      // Duplicate webhook - return success immediately without processing
      logger.info('[Trackman Webhook] Duplicate webhook detected - returning early', {
        extra: { trackmanBookingId: trackmanBookingIdFromPayload }
      });
      return res.status(200).json({ received: true, duplicate: true });
    }
  }
  
  res.status(200).json({ received: true });
  
  try {
    let trackmanBookingId: string | undefined;
    let trackmanUserId: string | undefined;
    let matchedBookingId: number | undefined;
    let matchedUserId: string | undefined;
    let processingError: string | undefined;
    let eventType: string;
    
    if (isTrackmanV2Payload(payload)) {
      logger.info('[Trackman Webhook] Processing V2 format payload', {
        extra: { 
          venue: payload.venue?.name,
          bookingId: (payload.booking as TrackmanV2Booking)?.id,
          status: (payload.booking as TrackmanV2Booking)?.status,
          externalBookingId: (payload.booking as TrackmanV2Booking)?.externalBookingId
        }
      });
      
      const v2Result = parseTrackmanV2Payload(payload as TrackmanV2WebhookPayload);
      trackmanBookingId = v2Result.normalized.trackmanBookingId;
      eventType = v2Result.eventType;
      
      const resourceId = mapBayNameToResourceId(
        v2Result.normalized.bayName,
        v2Result.normalized.bayId,
        v2Result.normalized.baySerial,
        v2Result.bayRef
      );
      
      if (v2Result.externalBookingId) {
        const linkResult = await linkByExternalBookingId(
          v2Result.externalBookingId,
          v2Result.normalized.trackmanBookingId!,
          v2Result.normalized.parsedDate!,
          v2Result.normalized.parsedStartTime!,
          v2Result.normalized.parsedEndTime!,
          resourceId,
          v2Result.normalized.status || 'confirmed',
          v2Result.normalized.playerCount
        );
        
        if (linkResult.matched && linkResult.bookingId) {
          matchedBookingId = linkResult.bookingId;
          matchedUserId = linkResult.memberEmail;
          
          if (resourceId) {
            const slotStatus: 'booked' | 'cancelled' | 'completed' = 
              v2Result.normalized.status?.toLowerCase() === 'cancelled' ? 'cancelled' :
              v2Result.normalized.status?.toLowerCase() === 'attended' ? 'completed' : 'booked';
            
            await updateBaySlotCache(
              v2Result.normalized.trackmanBookingId!,
              resourceId,
              v2Result.normalized.parsedDate!,
              v2Result.normalized.parsedStartTime!,
              v2Result.normalized.parsedEndTime!,
              slotStatus,
              linkResult.memberEmail,
              linkResult.memberName,
              v2Result.normalized.playerCount
            );
          }
          
          const bayName = resourceId ? `Bay ${resourceId}` : undefined;
          
          if (linkResult.memberEmail) {
            await notifyMemberBookingConfirmed(
              linkResult.memberEmail,
              linkResult.bookingId,
              v2Result.normalized.parsedDate!,
              v2Result.normalized.parsedStartTime!,
              bayName
            );
          }
          
          logger.info('[Trackman Webhook] V2: Linked via externalBookingId', {
            extra: { bookingId: matchedBookingId, trackmanBookingId, externalBookingId: v2Result.externalBookingId }
          });
        } else if (resourceId && v2Result.normalized.parsedDate && v2Result.normalized.parsedStartTime) {
          // externalBookingId didn't match - try bay/date/time matching (handles timing issue where webhook arrives before staff pastes ID)
          logger.info('[Trackman Webhook] V2: externalBookingId not matched, trying bay/date/time match', {
            extra: { externalBookingId: v2Result.externalBookingId, resourceId, date: v2Result.normalized.parsedDate, time: v2Result.normalized.parsedStartTime }
          });
          
          const bayTimeResult = await tryMatchByBayDateTime(
            resourceId,
            v2Result.normalized.parsedDate,
            v2Result.normalized.parsedStartTime,
            v2Result.normalized.trackmanBookingId!,
            v2Result.normalized.playerCount
          );
          
          if (bayTimeResult.matched && bayTimeResult.bookingId) {
            matchedBookingId = bayTimeResult.bookingId;
            matchedUserId = bayTimeResult.memberEmail;
            
            const slotStatus: 'booked' | 'cancelled' | 'completed' = 
              v2Result.normalized.status?.toLowerCase() === 'cancelled' ? 'cancelled' :
              v2Result.normalized.status?.toLowerCase() === 'attended' ? 'completed' : 'booked';
            
            await updateBaySlotCache(
              v2Result.normalized.trackmanBookingId!,
              resourceId,
              v2Result.normalized.parsedDate,
              v2Result.normalized.parsedStartTime,
              v2Result.normalized.parsedEndTime || v2Result.normalized.parsedStartTime,
              slotStatus,
              bayTimeResult.memberEmail,
              bayTimeResult.memberName,
              v2Result.normalized.playerCount
            );
            
            if (bayTimeResult.memberEmail) {
              await notifyMemberBookingConfirmed(
                bayTimeResult.memberEmail,
                bayTimeResult.bookingId,
                v2Result.normalized.parsedDate,
                v2Result.normalized.parsedStartTime,
                `Bay ${resourceId}`
              );
            }
            
            logger.info('[Trackman Webhook] V2: Linked via bay/date/time match (externalBookingId fallback)', {
              extra: { bookingId: matchedBookingId, trackmanBookingId, resourceId }
            });
          }
        }
      }
      
      // Also try bay/date/time matching when there's no externalBookingId at all
      if (!matchedBookingId && !v2Result.externalBookingId && resourceId && v2Result.normalized.parsedDate && v2Result.normalized.parsedStartTime) {
        const bayTimeResult = await tryMatchByBayDateTime(
          resourceId,
          v2Result.normalized.parsedDate,
          v2Result.normalized.parsedStartTime,
          v2Result.normalized.trackmanBookingId!,
          v2Result.normalized.playerCount
        );
        
        if (bayTimeResult.matched && bayTimeResult.bookingId) {
          matchedBookingId = bayTimeResult.bookingId;
          matchedUserId = bayTimeResult.memberEmail;
          
          const slotStatus: 'booked' | 'cancelled' | 'completed' = 
            v2Result.normalized.status?.toLowerCase() === 'cancelled' ? 'cancelled' :
            v2Result.normalized.status?.toLowerCase() === 'attended' ? 'completed' : 'booked';
          
          await updateBaySlotCache(
            v2Result.normalized.trackmanBookingId!,
            resourceId,
            v2Result.normalized.parsedDate,
            v2Result.normalized.parsedStartTime,
            v2Result.normalized.parsedEndTime || v2Result.normalized.parsedStartTime,
            slotStatus,
            bayTimeResult.memberEmail,
            bayTimeResult.memberName,
            v2Result.normalized.playerCount
          );
          
          if (bayTimeResult.memberEmail) {
            await notifyMemberBookingConfirmed(
              bayTimeResult.memberEmail,
              bayTimeResult.bookingId,
              v2Result.normalized.parsedDate,
              v2Result.normalized.parsedStartTime,
              `Bay ${resourceId}`
            );
          }
          
          logger.info('[Trackman Webhook] V2: Linked via bay/date/time match (no externalBookingId)', {
            extra: { bookingId: matchedBookingId, trackmanBookingId, resourceId }
          });
        }
      }
      
      if (!matchedBookingId && v2Result.normalized.parsedDate && v2Result.normalized.parsedStartTime) {
        if (v2Result.normalized.status?.toLowerCase() === 'cancelled') {
          const cancelResult = await cancelBookingByTrackmanId(v2Result.normalized.trackmanBookingId!);
          if (cancelResult.cancelled) {
            matchedBookingId = cancelResult.bookingId;
          }
        } else {
          // V2 webhook didn't match via externalBookingId - fall through to standard processing
          // This creates booking requests for new Trackman bookings, auto-approves pending requests, etc.
          logger.info('[Trackman Webhook] V2: No externalBookingId match, falling through to standard processing', {
            extra: { 
              trackmanBookingId: v2Result.normalized.trackmanBookingId,
              customerEmail: v2Result.normalized.customerEmail,
              date: v2Result.normalized.parsedDate,
              time: v2Result.normalized.parsedStartTime
            }
          });
          
          const result = await handleBookingUpdate(payload);
          matchedBookingId = result.matchedBookingId;
        }
      }
    } else {
      eventType = payload.event_type || payload.eventType || 'booking_update';
      
      if (eventType.includes('booking') || eventType.includes('created') || eventType.includes('updated') || eventType.includes('cancel')) {
        const result = await handleBookingUpdate(payload);
        matchedBookingId = result.matchedBookingId;
        
        const bookingData = payload.data || payload.booking;
        if (bookingData) {
          trackmanBookingId = (bookingData as any).id || (bookingData as any).booking_id;
        }
      }
    }
    
    await logWebhookEvent(
      eventType,
      payload,
      trackmanBookingId,
      trackmanUserId,
      matchedBookingId,
      matchedUserId,
      processingError
    );
    
  } catch (error: any) {
    logger.error('[Trackman Webhook] Processing error', { error });
    
    await logWebhookEvent(
      'error',
      payload,
      undefined,
      undefined,
      undefined,
      undefined,
      error.message
    );
  }
});

router.get('/api/admin/trackman-webhooks', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    
    const result = await db.execute(sql`SELECT 
        twe.id,
        twe.event_type,
        twe.trackman_booking_id,
        twe.matched_booking_id,
        twe.matched_user_id,
        twe.processing_error,
        twe.processed_at,
        twe.created_at,
        twe.retry_count,
        twe.last_retry_at,
        twe.payload,
        br.was_auto_linked,
        br.user_email as matched_user_email,
        br.request_date,
        br.start_time,
        br.end_time,
        br.resource_id,
        br.is_unmatched as linked_booking_unmatched,
        u.first_name || ' ' || u.last_name as linked_member_name,
        u.email as linked_member_email
      FROM trackman_webhook_events twe
      LEFT JOIN booking_requests br ON twe.matched_booking_id = br.id
      LEFT JOIN users u ON br.user_id = u.id
      ORDER BY twe.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`);
    
    const countResult = await db.execute(sql`SELECT COUNT(*) as total FROM trackman_webhook_events`);
    
    res.json({
      events: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset
    });
  } catch (error: any) {
    logger.error('[Trackman Webhook] Failed to fetch webhook events', { error });
    res.status(500).json({ error: 'Failed to fetch webhook events' });
  }
});

router.get('/api/admin/trackman-webhooks/stats', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stats = await db.execute(sql`SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE matched_booking_id IS NOT NULL) as matched,
        COUNT(*) FILTER (WHERE matched_booking_id IS NULL AND processing_error IS NULL) as unmatched,
        COUNT(*) FILTER (WHERE processing_error IS NOT NULL) as errors,
        COUNT(*) FILTER (WHERE event_type = 'booking.created') as created,
        COUNT(*) FILTER (WHERE event_type = 'booking.cancelled') as cancelled,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND br.is_unmatched = true) as matched_but_unlinked
      FROM trackman_webhook_events twe
      LEFT JOIN booking_requests br ON twe.matched_booking_id = br.id
      WHERE twe.created_at >= NOW() - INTERVAL '30 days'`);
    
    const slotStats = await db.execute(sql`SELECT 
        COUNT(*) as total_slots,
        COUNT(*) FILTER (WHERE status = 'booked') as booked,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE slot_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date) as upcoming
      FROM trackman_bay_slots`);
    
    res.json({
      webhookStats: stats.rows[0],
      slotStats: slotStats.rows[0],
    });
  } catch (error: any) {
    logger.error('[Trackman Webhook] Failed to fetch stats', { error });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.get('/api/admin/trackman-webhook/stats', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stats = await db.execute(sql`SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE matched_booking_id IS NOT NULL) as matched,
        COUNT(*) FILTER (WHERE matched_booking_id IS NULL AND processing_error IS NULL) as unmatched,
        COUNT(*) FILTER (WHERE processing_error IS NOT NULL) as errors,
        COUNT(*) FILTER (WHERE event_type = 'booking.created') as created,
        COUNT(*) FILTER (WHERE event_type = 'booking.cancelled') as cancelled,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND br.is_unmatched = true) as matched_but_unlinked
      FROM trackman_webhook_events twe
      LEFT JOIN booking_requests br ON twe.matched_booking_id = br.id
      WHERE twe.created_at >= NOW() - INTERVAL '30 days'`);
    
    const slotStats = await db.execute(sql`SELECT 
        COUNT(*) as total_slots,
        COUNT(*) FILTER (WHERE status = 'booked') as booked,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE slot_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date) as upcoming
      FROM trackman_bay_slots`);
    
    res.json({
      webhookStats: stats.rows[0],
      slotStats: slotStats.rows[0],
    });
  } catch (error: any) {
    logger.error('[Trackman Webhook] Failed to fetch stats', { error });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.post('/api/admin/linked-emails', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { primaryEmail, linkedEmail } = req.body;
    
    if (!primaryEmail || !linkedEmail) {
      return res.status(400).json({ error: 'primaryEmail and linkedEmail are required' });
    }
    
    if (primaryEmail.toLowerCase() === linkedEmail.toLowerCase()) {
      return res.status(400).json({ error: 'Primary email and linked email cannot be the same' });
    }
    
    const existingLink = await db.execute(sql`SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = LOWER(${linkedEmail})`);
    
    if (existingLink.rows.length > 0) {
      return res.status(409).json({ error: 'This email is already linked to a member' });
    }
    
    const session = (req as any).session;
    const createdBy = session?.email || 'unknown';
    
    await db.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_by)
       VALUES (${primaryEmail.toLowerCase()}, ${linkedEmail.toLowerCase()}, ${'trackman_resolution'}, ${createdBy})`);
    
    logger.info('[Linked Emails] Created email link', {
      extra: { primaryEmail, linkedEmail, createdBy }
    });
    
    res.json({ success: true, message: 'Email link created successfully' });
  } catch (error: any) {
    logger.error('[Linked Emails] Failed to create link', { error });
    res.status(500).json({ error: 'Failed to create email link' });
  }
});

router.get('/api/admin/linked-emails/:email', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email } = req.params;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const asLinked = await db.execute(sql`SELECT primary_email, linked_email, source, created_by, created_at
       FROM user_linked_emails 
       WHERE LOWER(linked_email) = LOWER(${email})`);
    
    const asPrimary = await db.execute(sql`SELECT primary_email, linked_email, source, created_by, created_at
       FROM user_linked_emails 
       WHERE LOWER(primary_email) = LOWER(${email})`);
    
    res.json({
      linkedTo: asLinked.rows.length > 0 ? asLinked.rows[0].primary_email : null,
      linkedEmails: asPrimary.rows.map(r => ({
        linkedEmail: r.linked_email,
        source: r.source,
        createdBy: r.created_by,
        createdAt: r.created_at
      }))
    });
  } catch (error: any) {
    logger.error('[Linked Emails] Failed to fetch links', { error });
    res.status(500).json({ error: 'Failed to fetch email links' });
  }
});

router.get('/api/availability/trackman-cache', async (req: Request, res: Response) => {
  try {
    const { start_date, end_date, resource_id } = req.query;
    
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }
    
    const sqlConditions: ReturnType<typeof sql>[] = [
      sql`slot_date >= ${start_date}`,
      sql`slot_date <= ${end_date}`,
      sql`status = 'booked'`
    ];
    
    if (resource_id) {
      sqlConditions.push(sql`resource_id = ${resource_id}`);
    }
    
    const result = await db.execute(sql`SELECT 
        id,
        resource_id,
        TO_CHAR(slot_date, 'YYYY-MM-DD') as slot_date,
        start_time,
        end_time,
        status,
        trackman_booking_id,
        customer_name,
        player_count
       FROM trackman_bay_slots
       WHERE ${sql.join(sqlConditions, sql` AND `)}
       ORDER BY slot_date, start_time`);
    
    res.json(result.rows);
  } catch (error: any) {
    logger.error('[Trackman Webhook] Failed to fetch availability cache', { error });
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

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
  } catch (error: any) {
    logger.error('[Trackman Webhook] Failed to fetch failed events', { error });
    res.status(500).json({ error: 'Failed to fetch failed events' });
  }
});

router.post('/api/admin/trackman-webhook/:eventId/retry', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const eventId = parseInt(req.params.eventId);
    
    if (isNaN(eventId)) {
      return res.status(400).json({ error: 'Invalid event ID' });
    }
    
    const eventResult = await db.execute(sql`SELECT id, event_type, payload, trackman_booking_id, retry_count
       FROM trackman_webhook_events 
       WHERE id = ${eventId}`);
    
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = eventResult.rows[0];
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    
    await db.execute(sql`UPDATE trackman_webhook_events 
       SET retry_count = COALESCE(retry_count, 0) + 1, 
           last_retry_at = NOW()
       WHERE id = ${eventId}`);
    
    logger.info('[Trackman Webhook] Admin triggered retry', {
      extra: { eventId, eventType: event.event_type, retryCount: (event.retry_count || 0) + 1 }
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
      } catch (processError: any) {
        message = `Reprocessing failed: ${processError.message}`;
        logger.error('[Trackman Webhook] Retry processing error', {
          error: processError,
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
  } catch (error: any) {
    logger.error('[Trackman Webhook] Failed to retry event', { error });
    res.status(500).json({ error: 'Failed to retry event' });
  }
});

router.post('/api/admin/trackman-webhook/:eventId/auto-match', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const eventId = parseInt(req.params.eventId);
    
    if (isNaN(eventId)) {
      return res.status(400).json({ error: 'Invalid event ID' });
    }
    
    const eventResult = await db.execute(sql`SELECT id, event_type, payload, trackman_booking_id, matched_booking_id
       FROM trackman_webhook_events 
       WHERE id = ${eventId}`);
    
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = eventResult.rows[0];
    
    if (event.matched_booking_id) {
      const matchedBooking = await db.execute(sql`SELECT id, user_email, is_unmatched FROM booking_requests WHERE id = ${event.matched_booking_id}`);
      
      if (matchedBooking.rows.length > 0 && !matchedBooking.rows[0].is_unmatched) {
        return res.json({ 
          success: false, 
          message: 'This event is already linked to a member booking',
          alreadyLinked: true
        });
      }
    }
    
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    const trackmanBookingId = event.trackman_booking_id;
    
    if (!trackmanBookingId) {
      return res.status(400).json({ error: 'Event has no Trackman booking ID to link' });
    }
    
    const bookingData = payload?.data || payload?.booking || {};
    const bookingStart = bookingData?.start;
    
    if (!bookingStart) {
      return res.status(400).json({ error: 'Cannot determine booking date/time from event' });
    }
    
    const startDate = new Date(bookingStart);
    const pacificDate = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const pacificStartTime = startDate.toLocaleTimeString('en-US', { 
      timeZone: 'America/Los_Angeles', 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    let resourceId: number | null = null;
    const bayRef = bookingData?.bay?.ref;
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
        return res.json({
          success: false,
          message: 'No matching booking requests found for this bay, date, and time',
          searched: { date: pacificDate, startTime: pacificStartTime, bay: resourceId }
        });
      }
      
      const match = approvedMatchResult.rows[0];
      
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
        return res.json({
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
    
    const match = matchResult.rows[0];
    
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
      return res.json({
        success: false,
        message: 'Booking was already linked or approved by another process',
        conflict: true
      });
    }
    
    await db.execute(sql`UPDATE trackman_webhook_events 
       SET matched_booking_id = ${match.id}
       WHERE id = ${eventId} AND (matched_booking_id IS NULL OR matched_booking_id = ${event.matched_booking_id})`);
    
    // Ensure session exists for newly approved booking
    try {
      await ensureSessionForBooking({
        bookingId: match.id,
        resourceId,
        sessionDate: pacificDate,
        startTime: match.start_time || pacificStartTime,
        endTime: match.end_time || pacificStartTime,
        ownerEmail: match.user_email,
        ownerName: match.member_name || undefined,
        trackmanBookingId,
        source: 'trackman',
        createdBy: 'staff_auto_match'
      });
    } catch (sessionErr) {
      logger.warn('[Trackman Auto-Match] Failed to ensure session', { extra: { bookingId: match.id, error: sessionErr } });
    }

    try {
      await notifyMemberBookingConfirmed(
        match.user_email,
        match.id,
        pacificDate,
        pacificStartTime,
        `Bay ${resourceId}`
      );
    } catch (notifyErr) {
      logger.warn('[Trackman Auto-Match] Failed to notify member', { error: notifyErr as Error });
    }
    
    linkAndNotifyParticipants(match.id, {
      trackmanBookingId,
      linkedBy: 'staff_auto_match',
      bayName: `Bay ${resourceId}`
    }).catch(err => {
      logger.warn('[Trackman Auto-Match] Failed to link request participants', { extra: { bookingId: match.id, error: err } });
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
    
  } catch (error: any) {
    logger.error('[Trackman Auto-Match] Failed to auto-match event', { error });
    res.status(500).json({ error: 'Failed to auto-match event' });
  }
});

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
  } catch (error) {
    logger.error('[Trackman Webhook] Failed to cleanup old logs', { error: error as Error });
    return { deleted: 0 };
  }
}

router.post('/api/admin/trackman-webhook/cleanup', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await cleanupOldWebhookLogs();
    res.json({ success: true, deleted: result.deleted });
  } catch (error: any) {
    logger.error('[Trackman Webhook] Manual cleanup failed', { error });
    res.status(500).json({ error: 'Failed to cleanup logs' });
  }
});

router.post('/api/admin/bookings/:id/simulate-confirm', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const bookingResult = await db.execute(sql`SELECT br.*, u.stripe_customer_id, u.tier
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
       WHERE br.id = ${bookingId}`);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    
    if (booking.status !== 'pending' && booking.status !== 'pending_approval') {
      return res.status(400).json({ error: `Booking is already ${booking.status}` });
    }

    const fakeTrackmanId = `SIM-${Date.now()}`;
    
    const resourceResult = await db.execute(sql`SELECT id, name FROM resources WHERE id = ${booking.resource_id}`);
    const resource = resourceResult.rows[0];
    const bayRef = resource?.name?.match(/\d+/)?.[0] || '1';
    // Map bay number to Trackman bay ID (approximate mapping)
    const bayIdMap: Record<string, number> = { '1': 7410, '2': 7411, '3': 7412, '4': 7413 };
    const trackmanBayId = bayIdMap[bayRef] || 7410;
    
    // Build ISO timestamps from booking date and times
    const bookingDate = typeof booking.request_date === 'string' 
      ? booking.request_date 
      : new Date(booking.request_date).toISOString().split('T')[0];
    const startISO = `${bookingDate}T${booking.start_time}.000Z`;
    const endISO = `${bookingDate}T${booking.end_time}.000Z`;
    
    // Create realistic webhook payload matching Trackman V2 format
    const realisticPayload = {
      venue: {
        id: 941,
        name: "Ever Club",
        slug: "even-house"
      },
      booking: {
        id: parseInt(fakeTrackmanId.replace('SIM-', '')),
        bay: {
          id: trackmanBayId,
          ref: bayRef
        },
        end: endISO,
        type: "bay",
        range: { id: 947 },
        start: startISO,
        status: "confirmed",
        bayOption: {
          id: 16727,
          name: "Member Option",
          duration: Math.floor((booking.duration_minutes || 60) / 60),
          subtitle: null
        },
        created_at: new Date().toISOString(),
        playerOptions: [{
          id: 5854,
          name: "Member",
          quantity: booking.declared_player_count || 1,
          subtitle: null
        }],
        customers: [{
          email: booking.user_email,
          first_name: booking.user_name?.split(' ')[0] || 'Member',
          last_name: booking.user_name?.split(' ').slice(1).join(' ') || ''
        }]
      },
      _simulated: true,
      _simulatedBy: 'staff',
      _originalBookingId: bookingId
    };
    
    // Create a webhook event record so it appears in Trackman Synced section
    const webhookEventResult = await db.execute(sql`INSERT INTO trackman_webhook_events (
        event_type, 
        trackman_booking_id, 
        matched_booking_id,
        payload, 
        processed_at
      )
      VALUES (${'booking.confirmed'}, ${fakeTrackmanId}, ${bookingId}, ${JSON.stringify(realisticPayload)}, NOW())
      RETURNING id`);
    
    logger.info('[Simulate Confirm] Created webhook event record', {
      bookingId,
      trackmanId: fakeTrackmanId,
      webhookEventId: webhookEventResult.rows[0]?.id
    });

    let sessionId = booking.session_id;
    if (!sessionId && booking.resource_id) {
      try {
        const userResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${booking.user_email})`);
        const userId = userResult.rows[0]?.id || null;

        const sessionResult = await ensureSessionForBooking({
          bookingId,
          resourceId: booking.resource_id,
          sessionDate: booking.request_date,
          startTime: booking.start_time,
          endTime: booking.end_time,
          ownerEmail: booking.user_email || '',
          ownerName: booking.user_name,
          ownerUserId: userId?.toString() || undefined,
          trackmanBookingId: fakeTrackmanId,
          source: 'staff_manual',
          createdBy: 'simulate_confirm'
        });
        sessionId = sessionResult.sessionId || null;

        if (sessionId) {
          const playerCount = booking.declared_player_count || 1;
          const sessionDuration = Math.round(
            (new Date(`2000-01-01T${booking.end_time}`).getTime() - 
             new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000
          );

          for (let i = 1; i < playerCount; i++) {
            await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              VALUES (${sessionId}, ${null}, ${'guest'}, ${`Guest ${i + 1}`}, ${'pending'}, ${sessionDuration})`);
          }

          if (playerCount > 1) {
            logger.info('[Simulate Confirm] Created guest participants', {
              bookingId,
              sessionId,
              guestCount: playerCount - 1,
              sessionDuration
            });
          }

          try {
            const feeResult = await recalculateSessionFees(sessionId);
            if (feeResult?.totalSessionFee) {
              (booking as any).calculatedTotalFeeCents = feeResult.totalSessionFee;
            }
            logger.info('[Simulate Confirm] Calculated fees for session', {
              sessionId,
              feeResult: feeResult?.totalSessionFee || 0
            });
          } catch (feeError) {
            logger.warn('[Simulate Confirm] Failed to calculate fees (non-blocking)', { error: feeError });
          }
        }
      } catch (sessionError) {
        logger.error('[Simulate Confirm] Failed to create session (non-blocking)', { error: sessionError });
      }
    }

    await db.execute(sql`UPDATE booking_requests 
       SET status = 'approved', 
           trackman_booking_id = ${fakeTrackmanId},
           session_id = COALESCE(session_id, ${sessionId}),
           notes = COALESCE(notes, '') || E'\n[Simulated confirmation for testing]',
           updated_at = NOW()
       WHERE id = ${bookingId}`);

    if (booking.overage_fee_cents > 0 && booking.stripe_customer_id) {
      try {
        const { chargeWithBalance } = await import('../../core/stripe/payments');
        const paymentResult = await chargeWithBalance({
          stripeCustomerId: booking.stripe_customer_id,
          email: booking.user_email,
          amountCents: booking.overage_fee_cents,
          purpose: 'overage_fee',
          bookingId: bookingId,
          description: `Simulator overage fee for ${booking.request_date}`,
          metadata: {
            bookingId: bookingId.toString(),
            bayId: booking.resource_id?.toString(),
            overageMinutes: booking.overage_minutes?.toString(),
          }
        });
        
        await db.execute(sql`UPDATE booking_requests SET overage_paid = ${paymentResult.success} WHERE id = ${bookingId}`);
        logger.info('[Simulate Confirm] Charged overage fee via invoice (uses customer balance)', {
          bookingId,
          invoiceId: paymentResult.invoiceId,
          amount: booking.overage_fee_cents,
          amountFromBalance: paymentResult.amountFromBalance,
          amountCharged: paymentResult.amountCharged,
          success: paymentResult.success
        });
      } catch (paymentError: any) {
        logger.error('[Simulate Confirm] Failed to charge overage fee', { error: paymentError });
      }
    }

    try {
      const dateStr = typeof booking.request_date === 'string' ? booking.request_date : formatDatePacific(booking.request_date);
      const timeStr = typeof booking.start_time === 'string' 
        ? booking.start_time.substring(0, 5) 
        : formatTimePacific(booking.start_time);
      
      await notifyMember(booking.user_email, {
        title: 'Booking Confirmed',
        body: `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.`,
        type: 'booking_confirmed',
        metadata: { bookingId: bookingId.toString() }
      });

      sendNotificationToUser(booking.user_email, {
        type: 'booking_approved',
        message: 'Your booking has been confirmed',
        bookingId: bookingId,
        timestamp: new Date().toISOString()
      });
    } catch (notifyError) {
      logger.error('[Simulate Confirm] Notification error (non-blocking)', { error: notifyError });
    }
    
    linkAndNotifyParticipants(bookingId, {
      trackmanBookingId: fakeTrackmanId,
      linkedBy: 'simulate_confirm',
      bayName: booking.resource_id ? `Bay ${booking.resource_id}` : 'Bay'
    }).catch(err => {
      logger.warn('[Simulate Confirm] Failed to link request participants', { extra: { bookingId, error: err } });
    });

    logger.info('[Simulate Confirm] Booking manually confirmed', {
      bookingId,
      userEmail: booking.user_email,
      trackmanId: fakeTrackmanId
    });

    broadcastToStaff({
      type: 'booking_confirmed',
      data: {
        bookingId,
        status: 'approved',
        userEmail: booking.user_email,
        trackmanBookingId: fakeTrackmanId,
        message: 'Booking has been confirmed',
      }
    });

    // Use the calculated total fee (includes guest fees) or fall back to overage
    const totalFeeCents = (booking as any).calculatedTotalFeeCents || booking.overage_fee_cents || 0;
    
    res.json({ 
      success: true, 
      message: 'Booking confirmed (simulated)',
      trackmanId: fakeTrackmanId,
      overageFeeCents: booking.overage_fee_cents,
      totalFeeCents
    });
  } catch (error: any) {
    logger.error('[Simulate Confirm] Error', { error });
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});

router.post('/api/admin/trackman-webhooks/backfill', isAdmin, async (req, res) => {
  try {
    logger.info('[Trackman Backfill] Starting backfill of past webhook events');
    
    const unmatchedEvents = await db.execute(sql`SELECT 
        id, trackman_booking_id, payload, created_at
      FROM trackman_webhook_events 
      WHERE matched_booking_id IS NULL 
        AND payload IS NOT NULL
      ORDER BY created_at DESC`);
    
    const results = {
      total: unmatchedEvents.rows.length,
      linked: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      details: [] as any[]
    };
    
    for (const event of unmatchedEvents.rows) {
      try {
        const payload = typeof event.payload === 'string' 
          ? JSON.parse(event.payload) 
          : event.payload;
        
        const bookingData = payload?.booking || payload?.data || {};
        const startStr = bookingData?.start;
        const endStr = bookingData?.end;
        const bayRef = bookingData?.bay?.ref;
        const customerEmail = bookingData?.customer?.email || payload?.customer?.email;
        const customerName = bookingData?.customer?.name || payload?.customer?.name || 'Unknown (Trackman)';
        const playerCount = bookingData?.playerOptions?.[0]?.quantity || 1;
        const externalBookingId = bookingData?.externalBookingId;
        
        if (!startStr || !endStr) {
          results.skipped++;
          results.details.push({ 
            trackmanId: event.trackman_booking_id, 
            status: 'skipped', 
            reason: 'Missing start/end time in payload' 
          });
          continue;
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
        
        let resourceId: number | null = null;
        if (bayRef) {
          const bayNum = parseInt(bayRef);
          if (bayNum >= 1 && bayNum <= 4) {
            resourceId = bayNum;
          }
        }
        
        const durationMinutes = calculateDurationMinutes(startTime, endTime);
        
        const existingByTrackman = await db.execute(sql`SELECT id FROM booking_requests WHERE trackman_booking_id = ${event.trackman_booking_id}`);
        
        if (existingByTrackman.rows.length > 0) {
          await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = ${existingByTrackman.rows[0].id} WHERE id = ${event.id}`);
          results.skipped++;
          results.details.push({ 
            trackmanId: event.trackman_booking_id, 
            status: 'skipped', 
            reason: 'Already has linked booking_request' 
          });
          continue;
        }
        
        const matchingBooking = await db.execute(sql`SELECT id, user_email, user_name, trackman_booking_id
          FROM booking_requests 
          WHERE request_date = ${requestDate} 
            AND start_time = ${startTime}
            AND (resource_id = ${resourceId} OR ${resourceId} IS NULL)
            AND trackman_booking_id IS NULL
            AND status NOT IN ('cancelled', 'declined')
          LIMIT 1`);
        
        if (matchingBooking.rows.length > 0) {
          const existingBooking = matchingBooking.rows[0];
          
          await db.execute(sql`UPDATE booking_requests 
            SET trackman_booking_id = ${event.trackman_booking_id},
                trackman_player_count = ${playerCount},
                trackman_external_id = ${externalBookingId},
                is_unmatched = false,
                staff_notes = COALESCE(staff_notes, '') || ' [Linked via backfill]',
                last_sync_source = 'trackman_webhook',
                last_trackman_sync_at = NOW(),
                updated_at = NOW()
            WHERE id = ${existingBooking.id}`);
          
          await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = ${existingBooking.id} WHERE id = ${event.id}`);
          
          results.linked++;
          results.details.push({ 
            trackmanId: event.trackman_booking_id, 
            status: 'linked', 
            bookingId: existingBooking.id,
            member: existingBooking.user_email || existingBooking.user_name
          });
        } else {
          // Use ON CONFLICT to handle race conditions with concurrent reprocess requests
          const newBooking = await db.execute(sql`INSERT INTO booking_requests 
            (request_date, start_time, end_time, duration_minutes, resource_id,
             user_email, user_name, status, trackman_booking_id, trackman_external_id,
             trackman_player_count, is_unmatched, 
             origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
            VALUES (${requestDate}, ${startTime}, ${endTime}, ${durationMinutes}, ${resourceId}, ${customerEmail || ''}, ${customerName}, 'approved', ${event.trackman_booking_id}, ${externalBookingId || null}, ${playerCount}, true,
                    'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
            ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
              last_trackman_sync_at = NOW(),
              updated_at = NOW()
            RETURNING id, (xmax = 0) AS was_inserted`);
          
          if (newBooking.rows.length > 0) {
            const bookingId = newBooking.rows[0].id;
            
            await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = ${bookingId} WHERE id = ${event.id}`);
            
            await ensureSessionForBooking({
              bookingId,
              resourceId,
              sessionDate: requestDate,
              startTime,
              endTime,
              ownerEmail: customerEmail || '',
              ownerName: customerName,
              trackmanBookingId: event.trackman_booking_id,
              source: 'trackman',
              createdBy: 'trackman_reprocess'
            });
            
            results.created++;
            results.details.push({ 
              trackmanId: event.trackman_booking_id, 
              status: 'created', 
              bookingId,
              date: requestDate,
              time: startTime,
              bay: resourceId ? `Bay ${resourceId}` : 'Unknown'
            });
          }
        }
      } catch (eventError: any) {
        results.errors++;
        results.details.push({ 
          trackmanId: event.trackman_booking_id, 
          status: 'error', 
          reason: eventError.message 
        });
        logger.error('[Trackman Backfill] Error processing event', { 
          error: eventError, 
          trackmanBookingId: event.trackman_booking_id 
        });
      }
    }
    
    logger.info('[Trackman Backfill] Backfill complete', { 
      extra: { 
        total: results.total, 
        linked: results.linked, 
        created: results.created, 
        skipped: results.skipped, 
        errors: results.errors 
      }
    });
    
    broadcastToStaff({
      type: 'bookings_updated',
      action: 'trackman_backfill',
      message: `Backfill complete: ${results.linked} linked, ${results.created} created`
    });
    
    res.json({
      success: true,
      message: `Processed ${results.total} webhook events`,
      results
    });
  } catch (error: any) {
    logger.error('[Trackman Backfill] Error', { error });
    res.status(500).json({ error: 'Failed to run backfill', details: error.message });
  }
});

router.post('/api/trackman/replay-webhooks-to-dev', isAdmin, async (req, res) => {
  try {
    const { dev_url, limit = 100 } = req.body;
    
    if (!dev_url) {
      return res.status(400).json({ error: 'dev_url is required' });
    }
    
    try {
      new URL(dev_url);
    } catch {
      return res.status(400).json({ error: 'Invalid dev_url format' });
    }
    
    logger.info('[Trackman Replay] Starting replay to dev', { dev_url, limit });
    
    const events = await db.execute(sql`SELECT id, trackman_booking_id, payload, created_at
      FROM trackman_webhook_events
      WHERE payload IS NOT NULL
      ORDER BY created_at ASC
      LIMIT ${limit}`);
    
    if (events.rows.length === 0) {
      return res.json({ success: true, message: 'No webhook events to replay', sent: 0 });
    }
    
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    
    for (const event of events.rows) {
      try {
        const payload = typeof event.payload === 'string' 
          ? JSON.parse(event.payload) 
          : event.payload;
        
        const response = await fetch(dev_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-From': 'production',
            'X-Replay-Event-Id': String(event.id),
            'X-Original-Received-At': event.created_at?.toISOString() || ''
          },
          body: JSON.stringify(payload)
        });
        
        if (response.ok) {
          sent++;
        } else {
          failed++;
          errors.push(`Event ${event.id}: ${response.status} ${response.statusText}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (err: any) {
        failed++;
        errors.push(`Event ${event.id}: ${err.message}`);
      }
    }
    
    logger.info('[Trackman Replay] Completed', { sent, failed, total: events.rows.length });
    
    res.json({
      success: true,
      message: `Replayed ${sent} of ${events.rows.length} webhook events to dev`,
      sent,
      failed,
      total: events.rows.length,
      errors: errors.slice(0, 10)
    });
  } catch (error: any) {
    logger.error('[Trackman Replay] Error', { error });
    res.status(500).json({ error: 'Failed to replay webhooks', details: error.message });
  }
});

export default router;
