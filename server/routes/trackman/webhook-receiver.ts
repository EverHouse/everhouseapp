import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql, eq, and } from 'drizzle-orm';
import { logger } from '../../core/logger';
import { broadcastToStaff, broadcastAvailabilityUpdate } from '../../core/websocket';
import { notifyMember, notifyAllStaff } from '../../core/notificationService';
import { linkAndNotifyParticipants } from '../../core/bookingEvents';
import { formatTime12Hour } from '../../utils/dateUtils';
import {
  TrackmanWebhookPayload,
  TrackmanV2WebhookPayload,
  TrackmanV2Booking,
  TrackmanBookingPayload,
  isProduction,
  isTrackmanV2Payload,
  parseTrackmanV2Payload,
  mapBayNameToResourceId,
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
import {
  updateBaySlotCache, 
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createBookingForMember,
  tryMatchByBayDateTime,
} from './webhook-billing';
import { getErrorMessage } from '../../utils/errorUtils';

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
      const message = `Your simulator booking for ${slotDate} at ${formatTime12Hour(startTime)}${bayName ? ` (${bayName})` : ''} has been confirmed.`;
      
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
    logger.error('[Trackman Webhook] Failed to notify member', { error: new Error(getErrorMessage(e)) });
  }
}

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
      logger.warn('[Trackman Webhook] Failed to forward to dev', { error: getErrorMessage(err) });
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
            message: `${bayTimeResult.memberName || bayTimeResult.memberEmail || 'Member'}'s booking for ${v2Result.normalized.parsedDate} at ${formatTime12Hour(v2Result.normalized.parsedStartTime)} was auto-linked via Trackman.`,
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
      
      const v2Booking = payload.booking as unknown as TrackmanV2Booking;
      const bayOptionName = v2Booking?.bayOption?.name?.toLowerCase();
      const isBlockedBayOption = bayOptionName === 'blocked';
      
      if (isCancelledStatus) {
        if (isBlockedBayOption && resourceId && v2Result.normalized.parsedDate && v2Result.normalized.parsedStartTime) {
          const endTime = v2Result.normalized.parsedEndTime || v2Result.normalized.parsedStartTime;
          const deletedRows = await db.delete(availabilityBlocks).where(
            and(
              eq(availabilityBlocks.resourceId, resourceId),
              eq(availabilityBlocks.blockDate, v2Result.normalized.parsedDate),
              eq(availabilityBlocks.startTime, v2Result.normalized.parsedStartTime),
              eq(availabilityBlocks.endTime, endTime),
              eq(availabilityBlocks.createdBy, 'trackman_webhook'),
            )
          ).returning({ id: availabilityBlocks.id });
          eventType = 'booking.block_cancelled';
          logger.info('[Trackman Webhook] V2: Removed availability block from Trackman block cancellation', {
            extra: {
              trackmanBookingId: v2Result.normalized.trackmanBookingId,
              resourceId,
              blockDate: v2Result.normalized.parsedDate,
              startTime: v2Result.normalized.parsedStartTime,
              endTime,
              rowsDeleted: deletedRows.length,
            }
          });
          if (deletedRows.length > 0) {
            await notifyAllStaff(
              'Bay Block Removed (Trackman)',
              `Bay ${resourceId} block removed for ${v2Result.normalized.parsedDate} ${v2Result.normalized.parsedStartTime}–${endTime}`,
              'trackman_booking',
              {}
            ).catch(err => logger.warn('[Trackman Webhook] Failed to notify staff of block removal', { extra: { error: getErrorMessage(err) } }));
          }
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
            await notifyAllStaff(
              'Bay Blocked (Trackman)',
              `Bay ${resourceId} blocked for ${blockDate} ${startTime}–${endTime}`,
              'trackman_booking',
              {}
            ).catch(err => logger.warn('[Trackman Webhook] Failed to notify staff of block creation', { extra: { error: getErrorMessage(err) } }));
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
    logger.error('[Trackman Webhook] Processing error', { error: new Error(getErrorMessage(error)) });
    
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
    logger.error('[Trackman Webhook] Unhandled error', { error: new Error(getErrorMessage(error)) });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
});

export default router;
