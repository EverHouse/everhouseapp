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
  handleBookingModification,
  tryAutoApproveBooking, 
  cancelBookingByTrackmanId,
  saveToUnmatchedBookings,
  createUnmatchedBookingRequest,
} from './webhook-handlers';
import type { ExistingBookingData } from './webhook-handlers';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';

type DbRow = Record<string, unknown>;
import {
  updateBaySlotCache, 
  createBookingForMember,
  tryMatchByBayDateTime,
} from './webhook-billing';
import { getErrorMessage, safeErrorDetail } from '../../utils/errorUtils';

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
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to notify member', { error: e instanceof Error ? e : new Error(String(e)) });
  }
}

/**
 * Extract trackmanBookingId from webhook payload (handles both V1 and V2 formats)
 */
function extractTrackmanBookingId(payload: TrackmanWebhookPayload | TrackmanV2WebhookPayload | Record<string, unknown>): string | undefined {
  const p = payload as Record<string, unknown>;
  const booking = p.booking as Record<string, unknown> | undefined;
  const data = p.data as Record<string, unknown> | undefined;

  if (booking?.id !== undefined) {
    return String(booking.id);
  }
  
  if (data?.id !== undefined) {
    return String(data.id);
  }
  if (data?.booking_id !== undefined) {
    return String(data.booking_id);
  }
  
  if (p.id !== undefined) {
    return String(p.id);
  }
  if (booking !== undefined) {
    return String(booking);
  }
  
  return undefined;
}

/**
 * Check if webhook is a duplicate using idempotency guard
 * Uses trackmanBookingId + status + content signature as the dedup key so the same booking
 * can have different events processed (e.g. created then cancelled, or modifications).
 * Returns true if this is a NEW webhook (not a duplicate)
 * Returns false if this is a DUPLICATE webhook
 */
async function checkWebhookIdempotency(trackmanBookingId: string, status?: string, contentSignature?: string): Promise<boolean> {
  try {
    const dedupKey = contentSignature
      ? `${trackmanBookingId}_${(status || '').toLowerCase()}_${contentSignature}`
      : status ? `${trackmanBookingId}_${status.toLowerCase()}` : trackmanBookingId;
    const existing = await db.execute(sql`SELECT id FROM trackman_webhook_events WHERE dedup_key = ${dedupKey} LIMIT 1`);
    const isNewWebhook = existing.rows.length === 0;
    
    if (!isNewWebhook) {
      logger.info('[Trackman Webhook] Duplicate webhook ignored - idempotency guard triggered', {
        extra: { trackmanBookingId, status, dedupKey }
      });
    }
    
    return isNewWebhook;
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to check webhook idempotency', {
      extra: { trackmanBookingId, error: (error as Error).message }
    });
    return true;
  }
}

function buildContentSignature(payload: Record<string, unknown>): string | undefined {
  const parts: string[] = [];

  const booking = payload?.booking as Record<string, unknown> | undefined;
  if (booking) {
    if (booking.start) parts.push(`s:${booking.start}`);
    if (booking.end) parts.push(`e:${booking.end}`);
    const bay = booking.bay as Record<string, unknown> | undefined;
    if (bay?.ref) parts.push(`b:${bay.ref}`);
    if (booking.status) parts.push(`st:${booking.status}`);
  }

  const data = payload?.data as Record<string, unknown> | undefined;
  if (data && parts.length === 0) {
    if (data.start_time) parts.push(`s:${data.start_time}`);
    if (data.end_time) parts.push(`e:${data.end_time}`);
    if (data.bay_name || data.bay_id || data.bay_serial) parts.push(`b:${data.bay_name || data.bay_id || data.bay_serial}`);
    if (data.status) parts.push(`st:${data.status}`);
  }

  return parts.length > 0 ? parts.join('|') : undefined;
}

router.post('/api/webhooks/trackman', async (req: Request, res: Response) => {
  try {
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
  // Include status + content signature in dedup key so modifications with changed bay/time get through
  const trackmanBookingIdFromPayload = extractTrackmanBookingId(payload);
  const pRec = payload as unknown as Record<string, unknown>;
  const pBooking = pRec.booking as Record<string, unknown> | undefined;
  const pData = pRec.data as Record<string, unknown> | undefined;
  const webhookStatus = (pBooking?.status as string) || (pData?.status as string) || (pRec.event_type as string);
  const contentSig = buildContentSignature(payload as unknown as Record<string, unknown>);
  if (trackmanBookingIdFromPayload) {
    const isNewWebhook = await checkWebhookIdempotency(trackmanBookingIdFromPayload, webhookStatus, contentSig);
    if (!isNewWebhook) {
      logger.info('[Trackman Webhook] Duplicate webhook detected - returning early', {
        extra: { trackmanBookingId: trackmanBookingIdFromPayload, status: webhookStatus }
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
      
      const isCancelledStatus = v2Result.normalized.status?.toLowerCase() === 'cancelled' || v2Result.normalized.status?.toLowerCase() === 'canceled';
      let isNewlyLinked = false;
      
      // Step 1: Try direct match via trackman_booking_id (staff paste the Trackman booking ID number to confirm bookings)
      if (v2Result.normalized.trackmanBookingId) {
        const directMatch = await db.execute(
          sql`SELECT id, user_email, user_name, resource_id, start_time, end_time, request_date,
                     duration_minutes, session_id, status, declared_player_count
              FROM booking_requests WHERE trackman_booking_id = ${v2Result.normalized.trackmanBookingId} LIMIT 1`
        );
        if (directMatch.rows.length > 0) {
          matchedBookingId = (directMatch.rows[0] as Record<string, unknown>).id as number;
          matchedUserId = (directMatch.rows[0] as Record<string, unknown>).user_email as string;
          
          logger.info('[Trackman Webhook] V2: Matched via trackman_booking_id', {
            extra: { bookingId: matchedBookingId, trackmanBookingId, status: v2Result.normalized.status }
          });

          if (!isCancelledStatus) {
            const existingData: ExistingBookingData = {
              id: directMatch.rows[0].id as number,
              userEmail: directMatch.rows[0].user_email as string,
              userName: directMatch.rows[0].user_name as string,
              resourceId: directMatch.rows[0].resource_id as number | null,
              startTime: directMatch.rows[0].start_time as string,
              endTime: directMatch.rows[0].end_time as string,
              requestDate: directMatch.rows[0].request_date as string,
              durationMinutes: directMatch.rows[0].duration_minutes as number | null,
              sessionId: directMatch.rows[0].session_id as number | null,
              status: directMatch.rows[0].status as string,
              declaredPlayerCount: directMatch.rows[0].declared_player_count as number | null,
            };

            const modResult = await handleBookingModification(existingData, {
              resourceId,
              parsedDate: v2Result.normalized.parsedDate!,
              parsedStartTime: v2Result.normalized.parsedStartTime!,
              parsedEndTime: v2Result.normalized.parsedEndTime,
              playerCount: v2Result.normalized.playerCount,
              trackmanBookingId: v2Result.normalized.trackmanBookingId!,
            });

            if (modResult.modified) {
              eventType = 'booking.modified';
              logger.info('[Trackman Webhook] V2: Applied booking modification', {
                extra: { bookingId: matchedBookingId, changes: modResult.changes, conflictWarning: modResult.conflictWarning }
              });
            }
          }
        }
      }
      
      // Step 2: Try bay/date/time matching for unlinked bookings (webhook arrives before staff links)
      // This also links trackman_booking_id to the booking for future webhook matching
      if (!matchedBookingId && resourceId && v2Result.normalized.parsedDate && v2Result.normalized.parsedStartTime) {
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
          isNewlyLinked = true;
          
          broadcastToStaff({
            type: 'booking_auto_confirmed',
            title: 'Booking Auto-Confirmed',
            message: `${bayTimeResult.memberName || bayTimeResult.memberEmail || 'Member'}'s booking for ${v2Result.normalized.parsedDate} at ${v2Result.normalized.parsedStartTime} was auto-linked via Trackman.`,
            data: {
              bookingId: bayTimeResult.bookingId,
              memberName: bayTimeResult.memberName || bayTimeResult.memberEmail,
              memberEmail: bayTimeResult.memberEmail,
              date: v2Result.normalized.parsedDate,
              time: v2Result.normalized.parsedStartTime,
              bay: `Bay ${resourceId}`,
              wasAutoApproved: true,
              trackmanBookingId: v2Result.normalized.trackmanBookingId
            }
          });
          
          logger.info('[Trackman Webhook] V2: Matched via bay/date/time', {
            extra: { bookingId: matchedBookingId, trackmanBookingId, resourceId }
          });
        }
      }
      
      // Step 3: Update bay slot cache for matched bookings
      if (matchedBookingId && resourceId && v2Result.normalized.parsedDate && v2Result.normalized.parsedStartTime) {
        const slotStatus: 'booked' | 'cancelled' | 'completed' = 
          isCancelledStatus ? 'cancelled' :
          v2Result.normalized.status?.toLowerCase() === 'attended' ? 'completed' : 'booked';
        
        await updateBaySlotCache(
          v2Result.normalized.trackmanBookingId!,
          resourceId,
          v2Result.normalized.parsedDate,
          v2Result.normalized.parsedStartTime,
          v2Result.normalized.parsedEndTime || v2Result.normalized.parsedStartTime,
          slotStatus,
          matchedUserId,
          undefined,
          v2Result.normalized.playerCount
        );
      }
      
      // Step 4: Notify member only for NEWLY linked bookings (not already-linked ones to avoid duplicate notifications)
      // Members already got notified when staff confirmed the booking, so only notify on new auto-links
      if (isNewlyLinked && matchedBookingId && matchedUserId && !isCancelledStatus) {
        const bayName = resourceId ? `Bay ${resourceId}` : undefined;
        await notifyMemberBookingConfirmed(
          matchedUserId,
          matchedBookingId,
          v2Result.normalized.parsedDate!,
          v2Result.normalized.parsedStartTime!,
          bayName
        );
      }
      
      // Step 5: Handle cancellations — cancelBookingByTrackmanId handles notifications, refunds, and availability broadcasts
      if (isCancelledStatus) {
        const cancelResult = await cancelBookingByTrackmanId(v2Result.normalized.trackmanBookingId!);
        if (cancelResult.cancelled) {
          matchedBookingId = matchedBookingId || cancelResult.bookingId;
          logger.info('[Trackman Webhook] V2: Cancelled booking via Trackman webhook', {
            extra: { bookingId: matchedBookingId, trackmanBookingId: v2Result.normalized.trackmanBookingId }
          });
        }
      }
      
      // Step 6: Fall through to V1 processing for unmatched, non-cancelled bookings (creates booking requests, auto-approves, etc.)
      if (!matchedBookingId && !isCancelledStatus && v2Result.normalized.parsedDate && v2Result.normalized.parsedStartTime) {
        logger.info('[Trackman Webhook] V2: No direct match, falling through to standard processing', {
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
    } else {
      eventType = payload.event_type || payload.eventType || 'booking_update';
      
      if (eventType.includes('booking') || eventType.includes('created') || eventType.includes('updated') || eventType.includes('cancel')) {
        const result = await handleBookingUpdate(payload);
        matchedBookingId = result.matchedBookingId;
        
        const bookingData = payload.data || payload.booking;
        if (bookingData) {
          trackmanBookingId = (bookingData as Record<string, unknown>).id as string || (bookingData as Record<string, unknown>).booking_id as string;
        }
      }
    }
    
    await logWebhookEvent(
      eventType,
      payload as unknown as Record<string, unknown>,
      trackmanBookingId,
      trackmanUserId,
      matchedBookingId,
      matchedUserId,
      processingError
    );
    
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Processing error', { error: error instanceof Error ? error : new Error(String(error)) });
    
    await logWebhookEvent(
      'error',
      payload as unknown as Record<string, unknown>,
      undefined,
      undefined,
      undefined,
      undefined,
      getErrorMessage(error)
    );
  }
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Unhandled error', { error: error instanceof Error ? error : new Error(String(error)) });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
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
      total: parseInt((countResult.rows[0] as DbRow).total as string),
      limit,
      offset
    });
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to fetch webhook events', { error: error instanceof Error ? error : new Error(String(error)) });
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
        COUNT(*) FILTER (WHERE event_type = 'booking.modified') as modified,
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
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to fetch stats', { error: error instanceof Error ? error : new Error(String(error)) });
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
        COUNT(*) FILTER (WHERE event_type = 'booking.modified') as modified,
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
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to fetch stats', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.post('/api/admin/linked-emails', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { primaryEmail: rawPrimaryEmail, linkedEmail: rawLinkedEmail } = req.body;
    const primaryEmail = rawPrimaryEmail?.trim()?.toLowerCase();
    const linkedEmail = rawLinkedEmail?.trim()?.toLowerCase();
    
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
    
    const session = req.session as unknown as Record<string, unknown>;
    const createdBy = (session?.email as string) || 'unknown';
    
    await db.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_by)
       VALUES (${primaryEmail.toLowerCase()}, ${linkedEmail.toLowerCase()}, ${'trackman_resolution'}, ${createdBy})`);
    
    logger.info('[Linked Emails] Created email link', {
      extra: { primaryEmail, linkedEmail, createdBy }
    });
    
    res.json({ success: true, message: 'Email link created successfully' });
  } catch (error: unknown) {
    logger.error('[Linked Emails] Failed to create link', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create email link' });
  }
});

router.get('/api/admin/linked-emails/:email', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email: rawEmail } = req.params;
    
    if (!rawEmail) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const email = decodeURIComponent(rawEmail as string).trim().toLowerCase();
    
    const asLinked = await db.execute(sql`SELECT primary_email, linked_email, source, created_by, created_at
       FROM user_linked_emails 
       WHERE LOWER(linked_email) = LOWER(${email})`);
    
    const asPrimary = await db.execute(sql`SELECT primary_email, linked_email, source, created_by, created_at
       FROM user_linked_emails 
       WHERE LOWER(primary_email) = LOWER(${email})`);
    
    res.json({
      linkedTo: asLinked.rows.length > 0 ? (asLinked.rows[0] as DbRow).primary_email : null,
      linkedEmails: asPrimary.rows.map((r: DbRow) => ({
        linkedEmail: r.linked_email,
        source: r.source,
        createdBy: r.created_by,
        createdAt: r.created_at
      }))
    });
  } catch (error: unknown) {
    logger.error('[Linked Emails] Failed to fetch links', { error: error instanceof Error ? error : new Error(String(error)) });
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
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to fetch availability cache', { error: error instanceof Error ? error : new Error(String(error)) });
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
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to fetch failed events', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch failed events' });
  }
});

router.post('/api/admin/trackman-webhook/:eventId/retry', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const eventId = parseInt(req.params.eventId as string);
    
    if (isNaN(eventId)) {
      return res.status(400).json({ error: 'Invalid event ID' });
    }
    
    const eventResult = await db.execute(sql`SELECT id, event_type, payload, trackman_booking_id, retry_count
       FROM trackman_webhook_events 
       WHERE id = ${eventId}`);
    
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = eventResult.rows[0] as DbRow;
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    
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
    const eventId = parseInt(req.params.eventId as string);
    
    if (isNaN(eventId)) {
      return res.status(400).json({ error: 'Invalid event ID' });
    }
    
    const eventResult = await db.execute(sql`SELECT id, event_type, payload, trackman_booking_id, matched_booking_id
       FROM trackman_webhook_events 
       WHERE id = ${eventId}`);
    
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = eventResult.rows[0] as DbRow;
    
    if (event.matched_booking_id) {
      const matchedBooking = await db.execute(sql`SELECT id, user_email, is_unmatched FROM booking_requests WHERE id = ${event.matched_booking_id}`);
      
      if (matchedBooking.rows.length > 0 && !(matchedBooking.rows[0] as DbRow).is_unmatched) {
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
      
      const match = approvedMatchResult.rows[0] as DbRow;
      
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
    
    const match = matchResult.rows[0] as DbRow;
    
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
    
    broadcastToStaff({
      type: 'booking_auto_confirmed',
      title: 'Booking Auto-Confirmed',
      message: `${match.member_name || match.user_email}'s booking for ${pacificDate} at ${pacificStartTime} was auto-approved via Staff Auto-Match.`,
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
    
    // Ensure session exists for newly approved booking
    try {
      await ensureSessionForBooking({
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
    } catch (sessionErr: unknown) {
      logger.warn('[Trackman Auto-Match] Failed to ensure session', { extra: { bookingId: match.id, error: sessionErr } });
    }

    try {
      await notifyMemberBookingConfirmed(
        match.user_email as string,
        match.id as number,
        pacificDate,
        pacificStartTime,
        `Bay ${resourceId}`
      );
    } catch (notifyErr: unknown) {
      logger.warn('[Trackman Auto-Match] Failed to notify member', { error: notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)) });
    }
    
    linkAndNotifyParticipants(match.id as number, {
      trackmanBookingId: trackmanBookingId as string,
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
    
  } catch (error: unknown) {
    logger.error('[Trackman Auto-Match] Failed to auto-match event', { error: error instanceof Error ? error : new Error(String(error)) });
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
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to cleanup old logs', { error: error instanceof Error ? error : new Error(String(error)) });
    return { deleted: 0 };
  }
}

router.post('/api/admin/trackman-webhook/cleanup', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await cleanupOldWebhookLogs();
    res.json({ success: true, deleted: result.deleted });
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Manual cleanup failed', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cleanup logs' });
  }
});

router.post('/api/admin/bookings/:id/simulate-confirm', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.id as string, 10);
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

    const booking = bookingResult.rows[0] as DbRow;
    
    if (booking.status !== 'pending' && booking.status !== 'pending_approval') {
      return res.status(400).json({ error: `Booking is already ${booking.status}` });
    }

    const fakeTrackmanId = `SIM-${Date.now()}`;
    
    const resourceResult = await db.execute(sql`SELECT id, name FROM resources WHERE id = ${booking.resource_id}`);
    const resource = resourceResult.rows[0] as DbRow;
    const bayRef = String(resource?.name || '').match(/\d+/)?.[0] || '1';
    // Map bay number to Trackman bay ID (approximate mapping)
    const bayIdMap: Record<string, number> = { '1': 7410, '2': 7411, '3': 7412, '4': 7413 };
    const trackmanBayId = bayIdMap[bayRef] || 7410;
    
    // Build ISO timestamps from booking date and times
    const bookingDate = typeof booking.request_date === 'string' 
      ? booking.request_date 
      : new Date(booking.request_date as string | number | Date).toISOString().split('T')[0];
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
          duration: Math.floor((Number(booking.duration_minutes) || 60) / 60),
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
          first_name: String(booking.user_name || '').split(' ')[0] || 'Member',
          last_name: String(booking.user_name || '').split(' ').slice(1).join(' ') || ''
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
      webhookEventId: (webhookEventResult.rows[0] as DbRow)?.id
    });

    let sessionId = booking.session_id;
    if (!sessionId && booking.resource_id) {
      try {
        const userResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${booking.user_email})`);
        const userId = (userResult.rows[0] as DbRow)?.id || null;

        const sessionResult = await ensureSessionForBooking({
          bookingId,
          resourceId: booking.resource_id as number,
          sessionDate: booking.request_date as string,
          startTime: booking.start_time as string,
          endTime: booking.end_time as string,
          ownerEmail: (booking.user_email as string) || '',
          ownerName: booking.user_name as string,
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

          for (let i = 1; Number(i) < Number(playerCount); i++) {
            await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              VALUES (${sessionId}, ${null}, ${'guest'}, ${`Guest ${i + 1}`}, ${'pending'}, ${sessionDuration})`);
          }

          if (Number(playerCount) > 1) {
            logger.info('[Simulate Confirm] Created guest participants', {
              bookingId,
              sessionId,
              guestCount: Number(playerCount)- 1,
              sessionDuration
            });
          }

          try {
            const feeResult = await recalculateSessionFees(sessionId as number, 'approval');
            if (feeResult?.totalSessionFee) {
              (booking as DbRow).calculatedTotalFeeCents = feeResult.totalSessionFee;
            }
            logger.info('[Simulate Confirm] Calculated fees for session', {
              sessionId,
              feeResult: feeResult?.totalSessionFee || 0
            });
          } catch (feeError: unknown) {
            logger.warn('[Simulate Confirm] Failed to calculate fees (non-blocking)', { error: feeError instanceof Error ? feeError : new Error(String(feeError)) });
          }
        }
      } catch (sessionError: unknown) {
        logger.error('[Simulate Confirm] Failed to create session (non-blocking)', { error: sessionError instanceof Error ? sessionError : new Error(String(sessionError)) });
      }
    }

    await db.execute(sql`UPDATE booking_requests 
       SET status = 'approved', 
           trackman_booking_id = ${fakeTrackmanId},
           session_id = COALESCE(session_id, ${sessionId}),
           notes = COALESCE(notes, '') || E'\n[Simulated confirmation for testing]',
           updated_at = NOW()
       WHERE id = ${bookingId}`);

    try {
      const dateStr = typeof booking.request_date === 'string' ? booking.request_date : formatDatePacific(new Date(booking.request_date as string | number));
      const timeStr = typeof booking.start_time === 'string' 
        ? booking.start_time.substring(0, 5) 
        : formatTimePacific(new Date(booking.start_time as string | number));
      
      await notifyMember({
        userEmail: booking.user_email as string,
        title: 'Booking Confirmed',
        message: `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.`,
        type: 'booking_confirmed' as const,
        relatedId: bookingId,
        relatedType: 'booking',
        url: '/bookings'
      });

      sendNotificationToUser(booking.user_email as string, {
        type: 'booking_approved',
        title: 'Booking Confirmed',
        message: 'Your booking has been confirmed',
      });
    } catch (notifyError: unknown) {
      logger.error('[Simulate Confirm] Notification error (non-blocking)', { error: notifyError instanceof Error ? notifyError : new Error(String(notifyError)) });
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
      userEmail: booking.user_email as string,
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

    const totalFeeCents = (booking as DbRow).calculatedTotalFeeCents as number || 0;
    
    res.json({ 
      success: true, 
      message: 'Booking confirmed (simulated)',
      trackmanId: fakeTrackmanId,
      totalFeeCents
    });
  } catch (error: unknown) {
    logger.error('[Simulate Confirm] Error', { error: error instanceof Error ? error : new Error(String(error)) });
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
      details: [] as DbRow[]
    };
    
    for (const event of unmatchedEvents.rows as DbRow[]) {
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
          await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = ${(existingByTrackman.rows[0] as DbRow).id} WHERE id = ${event.id}`);
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
            AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
          LIMIT 1`);
        
        if (matchingBooking.rows.length > 0) {
          const existingBooking = matchingBooking.rows[0] as DbRow;
          
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
            const bookingId = (newBooking.rows[0] as DbRow).id;
            
            await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = ${bookingId} WHERE id = ${event.id}`);
            
            await ensureSessionForBooking({
              bookingId: bookingId as number,
              resourceId,
              sessionDate: requestDate,
              startTime,
              endTime,
              ownerEmail: customerEmail || '',
              ownerName: customerName,
              trackmanBookingId: event.trackman_booking_id as string,
              source: 'trackman_webhook',
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
      } catch (eventError: unknown) {
        results.errors++;
        results.details.push({ 
          trackmanId: event.trackman_booking_id, 
          status: 'error', 
          reason: getErrorMessage(eventError) 
        });
        logger.error('[Trackman Backfill] Error processing event', { 
          error: eventError instanceof Error ? eventError : new Error(String(eventError)), 
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
  } catch (error: unknown) {
    logger.error('[Trackman Backfill] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to run backfill', details: safeErrorDetail(error) });
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
    } catch (err) {
      logger.debug('Invalid dev_url format for replay', { error: err });
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
    
    for (const event of events.rows as DbRow[]) {
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
            'X-Original-Received-At': event.created_at ? String(event.created_at) : ''
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
      } catch (err: unknown) {
        failed++;
        errors.push(`Event ${event.id}: ${getErrorMessage(err)}`);
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
  } catch (error: unknown) {
    logger.error('[Trackman Replay] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to replay webhooks', details: safeErrorDetail(error) });
  }
});

export default router;
