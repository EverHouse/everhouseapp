import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql, eq, and } from 'drizzle-orm';
import { logger } from '../../core/logger';
import { sendNotificationToUser, broadcastToStaff, broadcastAvailabilityUpdate } from '../../core/websocket';
import { notifyMember } from '../../core/notificationService';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { linkAndNotifyParticipants } from '../../core/bookingEvents';
import { formatDatePacific, formatTimePacific } from '../../utils/dateUtils';
import { validateQuery } from '../../middleware/validate';
import { z } from 'zod';
import {
  TrackmanWebhookPayload,
  TrackmanV2WebhookPayload,
  TrackmanV2Booking,
  TrackmanBookingPayload,
  isProduction,
  isTrackmanV2Payload,
  parseTrackmanV2Payload,
  mapBayNameToResourceId,
  calculateDurationMinutes,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  redactPII,
} from './webhook-helpers';
import { validateTrackmanWebhookSignature, logWebhookEvent, findMemberByEmail } from './webhook-validation';
import { 
  handleBookingUpdate, 
  handleBookingModification,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tryAutoApproveBooking, 
  cancelBookingByTrackmanId,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  saveToUnmatchedBookings,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createUnmatchedBookingRequest,
} from './webhook-handlers';
import type { ExistingBookingData } from './webhook-handlers';
import { availabilityBlocks } from '../../../shared/models/scheduling';
import { createStandaloneBlock } from '../../core/availabilityBlockService';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { transferRequestParticipantsToSession } from '../../core/trackmanImport';
import { voidBookingPass } from '../../walletPass/bookingPassService';
import { cancelPendingPaymentIntentsForBooking, refundSucceededPaymentIntentsForBooking } from '../../core/billing/paymentIntentCleanup';
function runReprocessConflictSideEffects(bookingId: number, userEmail: string, reason: string): void {
  (async () => {
    try {
      await cancelPendingPaymentIntentsForBooking(bookingId);
    } catch (err: unknown) {
      logger.error('[Trackman Reprocess] Failed to cancel pending PIs for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } });
    }

    try {
      await refundSucceededPaymentIntentsForBooking(bookingId);
    } catch (err: unknown) {
      logger.error('[Trackman Reprocess] Failed to refund succeeded PIs for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } });
    }

    try {
      const { voidBookingInvoice } = await import('../../core/billing/bookingInvoiceService');
      await voidBookingInvoice(bookingId);
    } catch (err: unknown) {
      logger.error('[Trackman Reprocess] Failed to void invoice for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } });
    }

    voidBookingPass(bookingId).catch(err => logger.error('[Trackman Reprocess] Failed to void wallet pass for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } }));

    if (userEmail && !userEmail.endsWith('@trackman.local')) {
      notifyMember({
        userEmail,
        title: 'Booking Cancelled',
        message: `Your booking has been automatically cancelled: ${reason}. Please contact staff if you have questions.`,
        type: 'booking_cancelled',
        relatedId: bookingId,
        relatedType: 'booking_request',
        url: '/my-bookings'
      }).catch(err => logger.error('[Trackman Reprocess] Failed to notify member about conflict cancellation', { extra: { bookingId, userEmail, error: getErrorMessage(err) } }));
    }
  })().catch(err => logger.error('[Trackman Reprocess] Conflict cancellation side effects failed', { extra: { bookingId, error: getErrorMessage(err) } }));
}

interface TotalCountRow {
  total: string;
}

interface BookingMatchRow {
  id: number;
  user_email: string;
  user_name: string;
  resource_id: number | null;
  start_time: string;
  end_time: string;
  request_date: string;
  duration_minutes: number | null;
  session_id: number | null;
  status: string;
  declared_player_count: number | null;
}

interface BookingDataRow {
  id: string;
  booking_id: string;
}

interface LinkedEmailRow {
  primary_email: string;
  linked_email: string;
  source: string;
  created_by: string | null;
  created_at: string;
}

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

interface SimulateBookingRow {
  id: number;
  user_email: string;
  user_name: string | null;
  resource_id: number | null;
  start_time: string;
  end_time: string;
  request_date: string | Date;
  duration_minutes: number | null;
  declared_player_count: number | null;
  session_id: number | null;
  status: string;
  stripe_customer_id: string | null;
  tier: string | null;
  calculatedTotalFeeCents?: number;
  notes: string | null;
}

interface ResourceNameRow {
  id: number;
  name: string;
}

interface InsertedIdRow {
  id: number;
}

interface UserIdRow {
  id: number;
}

interface UnmatchedWebhookEventRow {
  id: number;
  trackman_booking_id: string;
  payload: string | Record<string, unknown>;
  created_at: string;
}

interface ExistingBookingIdRow {
  id: number;
}

interface ExistingBookingLinkRow {
  id: number;
  user_email: string;
  user_name: string;
  trackman_booking_id: string | null;
}

interface NewBookingRow {
  id: number;
  was_inserted: boolean;
}

interface BackfillDetailItem {
  trackmanId: string | unknown;
  status: string;
  reason?: string;
  bookingId?: number | unknown;
  member?: string | unknown;
  date?: string;
  time?: string;
  bay?: string;
}

import {
  updateBaySlotCache, 
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      const _user = userResult.rows[0];
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
function extractTrackmanBookingId(payload: TrackmanWebhookPayload | TrackmanV2WebhookPayload): string | undefined {
  const p = payload as unknown as TrackmanWebhookPayload;
  const booking = p.booking as unknown as TrackmanBookingPayload | TrackmanV2Booking | undefined;
  const data = p.data as unknown as TrackmanBookingPayload | undefined;

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
      extra: { trackmanBookingId, error: getErrorMessage(error) }
    });
    return true;
  }
}

function buildContentSignature(payload: TrackmanWebhookPayload): string | undefined {
  const parts: string[] = [];

  const booking = payload?.booking as unknown as TrackmanV2Booking | undefined;
  if (booking) {
    if (booking.start) parts.push(`s:${booking.start}`);
    if (booking.end) parts.push(`e:${booking.end}`);
    if (booking.bay?.ref) parts.push(`b:${booking.bay.ref}`);
    if (booking.status) parts.push(`st:${booking.status}`);
  }

  const data = payload?.data as unknown as TrackmanBookingPayload | undefined;
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
      isV2Format: isTrackmanV2Payload(req.body),
      eventType: req.body?.event_type || req.body?.eventType || 'unknown'
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
  
  const rawPl = payload as Record<string, unknown>;
  const incomingEventType = payload.event_type || payload.eventType || '';
  const isNonBookingEvent = incomingEventType.includes('user') || incomingEventType.includes('purchase') ||
    (rawPl.user && typeof rawPl.user === 'object' && !rawPl.booking && !rawPl.data) ||
    (rawPl.purchase && typeof rawPl.purchase === 'object' && !rawPl.booking);
  
  // Check for duplicate webhook using idempotency guard BEFORE processing
  // Include status + content signature in dedup key so modifications with changed bay/time get through
  // Skip dedup for non-booking events (user_update, purchase) since they don't have stable booking IDs
  if (!isNonBookingEvent) {
    const trackmanBookingIdFromPayload = extractTrackmanBookingId(payload);
    const pBooking = payload.booking;
    const pData = payload.data;
    const webhookStatus = pBooking?.status || pData?.status || payload.event_type || '';
    const contentSig = buildContentSignature(payload);
    if (trackmanBookingIdFromPayload) {
      const isNewWebhook = await checkWebhookIdempotency(trackmanBookingIdFromPayload, webhookStatus, contentSig);
      if (!isNewWebhook) {
        logger.info('[Trackman Webhook] Duplicate webhook detected - returning early', {
          extra: { trackmanBookingId: trackmanBookingIdFromPayload, status: webhookStatus }
        });
        return res.status(200).json({ received: true, duplicate: true });
      }
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
          bookingId: (payload.booking as unknown as TrackmanV2Booking)?.id,
          status: (payload.booking as unknown as TrackmanV2Booking)?.status,
          externalBookingId: (payload.booking as unknown as TrackmanV2Booking)?.externalBookingId
        }
      });
      
      const v2Result = parseTrackmanV2Payload(payload as unknown as TrackmanV2WebhookPayload);
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
          matchedBookingId = (directMatch.rows[0] as unknown as BookingMatchRow).id;
          matchedUserId = (directMatch.rows[0] as unknown as BookingMatchRow).user_email;
          
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
          v2Result.normalized.playerCount,
          v2Result.normalized.parsedEndTime
        );
        
        if (bayTimeResult.matched && bayTimeResult.bookingId) {
          matchedBookingId = bayTimeResult.bookingId;
          matchedUserId = bayTimeResult.memberEmail;
          isNewlyLinked = true;
          
          broadcastAvailabilityUpdate({
            resourceId,
            date: v2Result.normalized.parsedDate!,
            action: 'booked',
          });

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
      
      // Detect Trackman "Blocked" bay option early — used in cancellation and creation steps
      const v2Booking = payload.booking as unknown as TrackmanV2Booking;
      const bayOptionName = v2Booking?.bayOption?.name?.toLowerCase();
      const isBlockedBayOption = bayOptionName === 'blocked';
      
      // Step 5: Handle cancellations — for blocked bay options, remove the availability block; for bookings, cancel via trackman ID
      if (isCancelledStatus) {
        if (isBlockedBayOption && resourceId && v2Result.normalized.parsedDate && v2Result.normalized.parsedStartTime) {
          const endTime = v2Result.normalized.parsedEndTime || v2Result.normalized.parsedStartTime;
          await db.delete(availabilityBlocks).where(
            and(
              eq(availabilityBlocks.resourceId, resourceId),
              eq(availabilityBlocks.blockDate, v2Result.normalized.parsedDate),
              eq(availabilityBlocks.startTime, v2Result.normalized.parsedStartTime),
              eq(availabilityBlocks.endTime, endTime),
              eq(availabilityBlocks.createdBy, 'trackman_webhook'),
            )
          );
          eventType = 'booking.block_cancelled';
          logger.info('[Trackman Webhook] V2: Removed availability block from Trackman block cancellation', {
            extra: {
              trackmanBookingId: v2Result.normalized.trackmanBookingId,
              resourceId,
              blockDate: v2Result.normalized.parsedDate,
              startTime: v2Result.normalized.parsedStartTime,
              endTime,
            }
          });
        } else {
          const cancelResult = await cancelBookingByTrackmanId(v2Result.normalized.trackmanBookingId!);
          if (cancelResult.cancelled) {
            matchedBookingId = matchedBookingId || cancelResult.bookingId;
            logger.info('[Trackman Webhook] V2: Cancelled booking via Trackman webhook', {
              extra: { bookingId: matchedBookingId, trackmanBookingId: v2Result.normalized.trackmanBookingId }
            });
          }
        }
      }
      
      // Step 6: For Trackman "Blocked" bay options, create an availability block instead of a booking
      if (!matchedBookingId && !isCancelledStatus && isBlockedBayOption) {
        if (resourceId && v2Result.normalized.parsedDate && v2Result.normalized.parsedStartTime) {
          const blockDate = v2Result.normalized.parsedDate;
          const startTime = v2Result.normalized.parsedStartTime;
          const endTime = v2Result.normalized.parsedEndTime || startTime;
          
          const blockResult = await createStandaloneBlock({
            resourceId,
            blockDate,
            startTime,
            endTime,
            blockType: 'blocked',
            notes: `Trackman Block - Bay ${resourceId}`,
            createdBy: 'trackman_webhook',
            source: 'Trackman Webhook',
          });
          
          eventType = 'booking.block';
          
          if (blockResult.absorbed) {
            logger.info('[Trackman Webhook] V2: Blocked bay option absorbed by existing availability block', {
              extra: {
                trackmanBookingId: v2Result.normalized.trackmanBookingId,
                resourceId,
                blockDate,
                startTime,
                endTime,
                existingBlockId: blockResult.existingBlock?.id,
                existingBlockType: blockResult.existingBlock?.block_type,
              }
            });
          } else {
            logger.info('[Trackman Webhook] V2: Created availability block from Trackman blocked bay option', {
              extra: {
                trackmanBookingId: v2Result.normalized.trackmanBookingId,
                resourceId,
                blockDate,
                startTime,
                endTime,
              }
            });
          }
        } else {
          eventType = 'booking.block';
          processingError = `Blocked bay option could not be mapped to a resource (bay ref: ${v2Result.bayRef || 'unknown'})`;
          logger.warn('[Trackman Webhook] V2: Blocked bay option received but resource could not be resolved', {
            extra: {
              trackmanBookingId: v2Result.normalized.trackmanBookingId,
              bayRef: v2Result.bayRef,
              parsedDate: v2Result.normalized.parsedDate,
            }
          });
        }
      }
      // Step 7: Fall through to V1 processing for unmatched, non-cancelled bookings (creates booking requests, auto-approves, etc.)
      else if (!matchedBookingId && !isCancelledStatus && v2Result.normalized.parsedDate && v2Result.normalized.parsedStartTime) {
        logger.info('[Trackman Webhook] V2: No direct match, falling through to standard processing', {
          extra: { 
            trackmanBookingId: v2Result.normalized.trackmanBookingId,
            date: v2Result.normalized.parsedDate,
            time: v2Result.normalized.parsedStartTime
          }
        });
        
        const result = await handleBookingUpdate(payload);
        matchedBookingId = result.matchedBookingId;
      }
    } else {
      const rawPayload = payload as Record<string, unknown>;
      const hasUserKey = rawPayload.user && typeof rawPayload.user === 'object' && !rawPayload.booking && !rawPayload.data;
      const hasPurchaseKey = rawPayload.purchase && typeof rawPayload.purchase === 'object' && !rawPayload.booking;
      
      eventType = payload.event_type || payload.eventType || 
        (hasUserKey ? 'user_update' : hasPurchaseKey ? 'purchase_update' : 'booking_update');
      
      const isUserUpdateEvent = eventType.includes('user_update') || eventType.includes('user.');
      const isPurchaseEvent = eventType.includes('purchase');
      
      if (isUserUpdateEvent) {
        const userData = (payload as Record<string, unknown>).user || (payload as Record<string, unknown>).data || payload;
        const uData = userData as Record<string, unknown>;
        trackmanUserId = String(uData.id || uData.userId || '');
        const userName = [uData.firstName || uData.first_name, uData.lastName || uData.last_name].filter(Boolean).join(' ');
        const userEmail = (uData.email as string) || '';
        
        logger.info('[Trackman Webhook] Processing user_update event', {
          extra: { 
            trackmanUserId,
            userName: userName || undefined,
            userEmail: userEmail || undefined,
            eventType
          }
        });

        if (userEmail) {
          const member = await findMemberByEmail(userEmail);
          if (member) {
            matchedUserId = member.email;
            logger.info('[Trackman Webhook] user_update matched to member', {
              extra: { trackmanUserId, memberEmail: member.email, memberName: [member.firstName, member.lastName].filter(Boolean).join(' ') || undefined }
            });
          }
        }
      } else if (isPurchaseEvent) {
        const purchaseData = (payload as Record<string, unknown>).purchase || (payload as Record<string, unknown>).data || payload;
        const pData = purchaseData as Record<string, unknown>;
        
        logger.info('[Trackman Webhook] Processing purchase event', {
          extra: { 
            purchaseId: pData.id,
            status: pData.status,
            eventType
          }
        });
      } else if (eventType.includes('booking') || eventType.includes('created') || eventType.includes('updated') || eventType.includes('cancel')) {
        const result = await handleBookingUpdate(payload);
        matchedBookingId = result.matchedBookingId;
        
        const bookingData = payload.data || payload.booking;
        if (bookingData) {
          trackmanBookingId = (bookingData as unknown as BookingDataRow).id || (bookingData as unknown as BookingDataRow).booking_id;
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
    
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Processing error', { error: error instanceof Error ? error : new Error(String(error)) });
    
    await logWebhookEvent(
      'error',
      payload,
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

const webhookPaginationSchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
}).passthrough();

router.get('/api/admin/trackman-webhooks', isStaffOrAdmin, validateQuery(webhookPaginationSchema), async (req: Request, res: Response) => {
  try {
    const vq = (req as Request & { validatedQuery: z.infer<typeof webhookPaginationSchema> }).validatedQuery;
    const limit = Math.min(parseInt(vq.limit || '') || 50, 100);
    const offset = parseInt(vq.offset || '') || 0;
    
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
    
    const totalCount = parseInt((countResult.rows[0] as unknown as TotalCountRow).total);
    res.json({
      events: result.rows,
      total: totalCount,
      totalCount,
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
        COUNT(*) as total_events,
        COUNT(*) FILTER (WHERE matched_booking_id IS NOT NULL) as matched,
        COUNT(*) FILTER (WHERE matched_booking_id IS NULL AND processing_error IS NULL) as unmatched,
        COUNT(*) FILTER (WHERE processing_error IS NOT NULL) as errors,
        COUNT(*) FILTER (WHERE twe.event_type::text ILIKE '%created%' OR twe.event_type::text ILIKE '%create%') as created,
        COUNT(*) FILTER (WHERE twe.event_type::text ILIKE '%cancelled%' OR twe.event_type::text ILIKE '%cancel%' OR twe.event_type::text ILIKE '%deleted%') as cancelled,
        COUNT(*) FILTER (WHERE (twe.event_type::text ILIKE '%modified%' OR twe.event_type::text ILIKE '%update%') AND twe.event_type::text NOT ILIKE '%user%' AND twe.event_type::text NOT ILIKE '%purchase%') as modified,
        COUNT(*) FILTER (WHERE twe.event_type::text ILIKE '%user%') as user_updates,
        COUNT(*) FILTER (WHERE twe.event_type::text ILIKE '%purchase%') as purchase_events,
        COUNT(*) FILTER (WHERE twe.event_type::text ILIKE '%block%') as blocks,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND br.was_auto_linked = true AND br.is_unmatched = false) as auto_confirmed,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND (br.was_auto_linked = false OR br.was_auto_linked IS NULL) AND br.is_unmatched = false) as manually_linked,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND br.is_unmatched = true) as needs_linking,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NULL AND processing_error IS NULL AND NOT (twe.event_type::text ILIKE '%cancelled%' OR twe.event_type::text ILIKE '%cancel%' OR twe.event_type::text ILIKE '%deleted%') AND twe.event_type::text NOT ILIKE '%user%' AND twe.event_type::text NOT ILIKE '%purchase%' AND twe.event_type::text NOT ILIKE '%block%') as needs_linking_unmatched,
        MAX(twe.created_at) as last_event_at
      FROM trackman_webhook_events twe
      LEFT JOIN booking_requests br ON twe.matched_booking_id = br.id
      WHERE twe.created_at >= NOW() - INTERVAL '30 days'`);
    
    const row = stats.rows[0] as Record<string, string>;
    const autoConfirmed = parseInt(row?.auto_confirmed || '0');
    const manuallyLinked = parseInt(row?.manually_linked || '0');
    const needsLinking = parseInt(row?.needs_linking || '0') + parseInt(row?.needs_linking_unmatched || '0');
    
    const slotStats = await db.execute(sql`SELECT 
        COUNT(*) as total_slots,
        COUNT(*) FILTER (WHERE status = 'booked') as booked,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE slot_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date) as upcoming
      FROM trackman_bay_slots`);
    
    res.json({
      webhookStats: {
        ...row,
        auto_confirmed: autoConfirmed,
        manually_linked: manuallyLinked,
        needs_linking: needsLinking,
      },
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
        COUNT(*) FILTER (WHERE event_type::text ILIKE '%user%') as user_updates,
        COUNT(*) FILTER (WHERE event_type::text ILIKE '%purchase%') as purchase_events,
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
    
    const createdBy = req.session?.user?.email || 'unknown';
    
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
      linkedTo: asLinked.rows.length > 0 ? (asLinked.rows[0] as unknown as LinkedEmailRow).primary_email : null,
      linkedEmails: (asPrimary.rows as unknown as LinkedEmailRow[]).map((r) => ({
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

router.get('/api/availability/trackman-cache', isStaffOrAdmin, async (req: Request, res: Response) => {
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
    
    const event = eventResult.rows[0] as unknown as WebhookEventAutoMatchRow;
    
    if (event.matched_booking_id) {
      const matchedBooking = await db.execute(sql`SELECT id, user_email, is_unmatched FROM booking_requests WHERE id = ${event.matched_booking_id}`);
      
      if (matchedBooking.rows.length > 0 && !(matchedBooking.rows[0] as unknown as BookingUnmatchedCheckRow).is_unmatched) {
        return res.json({ 
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
        return res.json({
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

    const booking = bookingResult.rows[0] as unknown as SimulateBookingRow;
    
    if (booking.status !== 'pending' && booking.status !== 'pending_approval') {
      return res.status(400).json({ error: `Booking is already ${booking.status}` });
    }

    const fakeTrackmanId = `SIM-${Date.now()}`;
    
    const resourceResult = await db.execute(sql`SELECT id, name FROM resources WHERE id = ${booking.resource_id}`);
    const resource = resourceResult.rows[0] as unknown as ResourceNameRow;
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
      webhookEventId: (webhookEventResult.rows[0] as unknown as InsertedIdRow)?.id
    });

    let sessionId = booking.session_id;
    if (!sessionId && booking.resource_id) {
      try {
        const userResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${booking.user_email})`);
        const userId = (userResult.rows[0] as unknown as UserIdRow)?.id || null;

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

          let transferredCount = 0;
          try {
            const rpResult = await db.execute(sql`SELECT request_participants FROM booking_requests WHERE id = ${bookingId}`);
            const rpData = (rpResult.rows[0] as { request_participants: unknown })?.request_participants;
            if (rpData && Array.isArray(rpData) && rpData.length > 0) {
              transferredCount = await transferRequestParticipantsToSession(
                sessionId as number, rpData, (booking.user_email as string) || '', `simulate confirm booking #${bookingId}`
              );
            }
          } catch (rpErr: unknown) {
            logger.warn('[Simulate Confirm] Non-blocking: Failed to transfer request_participants', {
              extra: { bookingId, sessionId, error: getErrorMessage(rpErr) }
            });
          }

          const remainingSlots = Math.max(0, (Number(playerCount) - 1) - transferredCount);
          for (let i = 0; i < remainingSlots; i++) {
            await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              VALUES (${sessionId}, ${null}, ${'guest'}, ${`Guest ${transferredCount + i + 2}`}, ${'pending'}, ${sessionDuration})`);
          }

          if (transferredCount > 0 || remainingSlots > 0) {
            logger.info('[Simulate Confirm] Created participants', {
              bookingId,
              sessionId,
              playerCount: Number(playerCount),
              transferredFromRequest: transferredCount,
              genericGuestSlots: remainingSlots,
              sessionDuration
            });
          }

          try {
            const feeResult = await recalculateSessionFees(sessionId as number, 'approval');
            if (feeResult?.totals?.totalCents != null) {
              booking.calculatedTotalFeeCents = feeResult.totals.totalCents;
            }
            logger.info('[Simulate Confirm] Calculated fees for session', {
              sessionId,
              feeResult: feeResult?.totals?.totalCents || 0
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
      const dateStr = typeof booking.request_date === 'string' ? booking.request_date : formatDatePacific(new Date(booking.request_date));
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

    const totalFeeCents = booking.calculatedTotalFeeCents || 0;
    
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
      details: [] as BackfillDetailItem[]
    };
    
    for (const event of unmatchedEvents.rows as unknown as UnmatchedWebhookEventRow[]) {
      try {
        const payload = typeof event.payload === 'string' 
          ? JSON.parse(event.payload) 
          : event.payload;
        
        const bookingData = (payload?.booking || payload?.data || {}) as Record<string, unknown>;
        const startStr = bookingData?.start;
        const endStr = bookingData?.end;
        const bayRef = (bookingData?.bay as Record<string, unknown>)?.ref;
        const customerEmail = undefined;
        const customerName = 'Unknown (Trackman)';
        const rawPlayerOptions = bookingData?.playerOptions;
        const playerOptionsArr = Array.isArray(rawPlayerOptions)
          ? rawPlayerOptions
          : rawPlayerOptions
            ? Object.values(rawPlayerOptions)
            : [];
        const playerCount = playerOptionsArr.reduce((sum: number, opt: Record<string, unknown>) => sum + (Number(opt?.quantity) || 0), 0) || 1;
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
        
        const startStrVal = String(startStr);
        const endStrVal = String(endStr);
        const startDate = new Date(startStrVal.includes('T') ? startStrVal : startStrVal.replace(' ', 'T') + 'Z');
        const endDate = new Date(endStrVal.includes('T') ? endStrVal : endStrVal.replace(' ', 'T') + 'Z');
        
        const requestDate = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const startTime = startDate.toLocaleTimeString('en-US', { 
          hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
        }) + ':00';
        const endTime = endDate.toLocaleTimeString('en-US', { 
          hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
        }) + ':00';
        
        let resourceId: number | null = null;
        if (bayRef) {
          const bayNum = parseInt(String(bayRef));
          if (bayNum >= 1 && bayNum <= 4) {
            resourceId = bayNum;
          }
        }
        
        const durationMinutes = calculateDurationMinutes(startTime, endTime);
        
        const existingByTrackman = await db.execute(sql`SELECT id FROM booking_requests WHERE trackman_booking_id = ${event.trackman_booking_id}`);
        
        if (existingByTrackman.rows.length > 0) {
          await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = ${(existingByTrackman.rows[0] as unknown as ExistingBookingIdRow).id} WHERE id = ${event.id}`);
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
            AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
          LIMIT 1`);
        
        if (matchingBooking.rows.length > 0) {
          const existingBooking = matchingBooking.rows[0] as unknown as ExistingBookingLinkRow;
          
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
          let newBooking;
          try {
            newBooking = await db.execute(sql`INSERT INTO booking_requests 
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
          } catch (insertErr: unknown) {
            const errMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
            const cause = (insertErr as { cause?: { code?: string } })?.cause;
            if (cause?.code === '23P01' || errMsg.includes('booking_requests_no_overlap') || errMsg.includes('23P01')) {
              const txResult = await db.transaction(async (tx) => {
                const conflicting = await tx.execute(sql`
                  SELECT id, user_email, status FROM booking_requests
                  WHERE resource_id = ${resourceId}
                    AND request_date = ${requestDate}
                    AND status IN ('pending', 'approved', 'confirmed')
                    AND start_time < ${endTime}
                    AND end_time > ${startTime}
                    AND (trackman_booking_id IS NULL OR trackman_booking_id != ${event.trackman_booking_id})
                  FOR UPDATE`);
                const conflictRows = conflicting.rows as { id: number; user_email: string; status: string }[];
                const conflictIds = conflictRows.map(r => r.id);
                const reprocessConflicts: { id: number; userEmail: string }[] = [];
                if (conflictIds.length > 0) {
                  await tx.execute(sql`
                    UPDATE booking_requests SET status = 'cancelled', updated_at = NOW(),
                      staff_notes = COALESCE(staff_notes, '') || ${`\n[Auto-cancelled: superseded by Trackman reprocess ${event.trackman_booking_id}]`}
                    WHERE id = ANY(${sql.raw(`ARRAY[${conflictIds.join(',')}]::int[]`)})`);
                  logger.info('[Trackman Reprocess] Cancelled overlapping bookings', { extra: { trackmanBookingId: event.trackman_booking_id, cancelledIds: conflictIds } });

                  for (const conflictRow of conflictRows) {
                    if (['approved', 'confirmed'].includes(conflictRow.status)) {
                      reprocessConflicts.push({ id: conflictRow.id, userEmail: conflictRow.user_email });
                    }
                  }
                }
                const insertResult = await tx.execute(sql`INSERT INTO booking_requests 
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
                return { insertResult, reprocessConflicts };
              });

              for (const conflict of txResult.reprocessConflicts) {
                runReprocessConflictSideEffects(conflict.id, conflict.userEmail, `superseded by Trackman reprocess ${event.trackman_booking_id}`);
              }

              newBooking = txResult.insertResult;
            } else {
              throw insertErr;
            }
          }
          
          if (newBooking.rows.length > 0 && resourceId != null) {
            const bookingId = (newBooking.rows[0] as unknown as NewBookingRow).id;
            
            await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = ${bookingId} WHERE id = ${event.id}`);
            
            const reprocessSession = await ensureSessionForBooking({
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
            if (reprocessSession.error) {
              logger.error('[Trackman Reprocess] Session creation failed', { extra: { bookingId, trackmanBookingId: event.trackman_booking_id, error: reprocessSession.error } });
            }
            
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
    
    for (const event of events.rows as unknown as UnmatchedWebhookEventRow[]) {
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
