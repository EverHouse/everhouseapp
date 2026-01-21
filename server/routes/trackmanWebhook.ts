import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../core/db';
import { logger } from '../core/logger';
import { isStaffOrAdmin } from '../core/middleware';
import { sendNotificationToUser, broadcastToStaff } from '../core/websocket';
import { sendBookingConfirmationEmail } from '../emails/bookingEmails';
import { notifyAllStaff } from '../core/staffNotifications';
import { notifyMember } from '../core/notificationService';

const router = Router();

const isProduction = process.env.NODE_ENV === 'production';

interface TrackmanBookingPayload {
  id?: string;
  booking_id?: string;
  bookingId?: string;
  status?: string;
  bay_id?: string;
  bayId?: string;
  bay_name?: string;
  bayName?: string;
  bay_serial?: string;
  baySerial?: string;
  resource_serial?: string;
  resourceSerial?: string;
  start_time?: string;
  startTime?: string;
  end_time?: string;
  endTime?: string;
  date?: string;
  customer?: {
    email?: string;
    name?: string;
    phone?: string;
    id?: string;
  };
  user?: {
    email?: string;
    name?: string;
    phone?: string;
    id?: string;
  };
  player_count?: number;
  playerCount?: number;
  created_at?: string;
  updated_at?: string;
}

interface TrackmanWebhookPayload {
  event_type?: string;
  eventType?: string;
  data?: TrackmanBookingPayload;
  booking?: TrackmanBookingPayload;
  user?: any;
  purchase?: any;
  timestamp?: string;
}

function validateTrackmanWebhookSignature(req: Request): boolean {
  const webhookSecret = process.env.TRACKMAN_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    if (isProduction) {
      logger.warn('[Trackman Webhook] No TRACKMAN_WEBHOOK_SECRET configured - rejecting in production');
      return false;
    }
    logger.warn('[Trackman Webhook] No TRACKMAN_WEBHOOK_SECRET configured - allowing in development');
    return true;
  }
  
  const signature = req.headers['x-trackman-signature'] || 
                    req.headers['x-webhook-signature'] ||
                    req.headers['x-signature'];
  
  if (!signature) {
    logger.warn('[Trackman Webhook] No signature header found');
    return !isProduction;
  }
  
  const rawBody = (req as any).rawBody;
  if (!rawBody) {
    logger.warn('[Trackman Webhook] No raw body available for signature validation');
    return !isProduction;
  }
  
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
  
  const providedSig = Array.isArray(signature) ? signature[0] : signature;
  
  try {
    const providedBuffer = Buffer.from(providedSig || '');
    const expectedBuffer = Buffer.from(expectedSignature);
    
    if (providedBuffer.length !== expectedBuffer.length) {
      logger.warn('[Trackman Webhook] Signature length mismatch');
      return !isProduction;
    }
    
    const isValid = crypto.timingSafeEqual(providedBuffer, expectedBuffer);
    
    if (!isValid) {
      logger.warn('[Trackman Webhook] Signature validation failed');
    }
    
    return isValid || !isProduction;
  } catch (e) {
    logger.error('[Trackman Webhook] Signature validation error', { error: e as Error });
    return !isProduction;
  }
}

function extractBookingData(payload: TrackmanWebhookPayload): TrackmanBookingPayload | null {
  return payload.data || payload.booking || null;
}

function normalizeBookingFields(booking: TrackmanBookingPayload) {
  return {
    trackmanBookingId: booking.id || booking.booking_id || booking.bookingId,
    bayId: booking.bay_id || booking.bayId,
    bayName: booking.bay_name || booking.bayName,
    baySerial: booking.bay_serial || booking.baySerial || booking.resource_serial || booking.resourceSerial,
    startTime: booking.start_time || booking.startTime,
    endTime: booking.end_time || booking.endTime,
    date: booking.date,
    customerEmail: booking.customer?.email || booking.user?.email,
    customerName: booking.customer?.name || booking.user?.name,
    customerPhone: booking.customer?.phone || booking.user?.phone,
    customerId: booking.customer?.id || booking.user?.id,
    playerCount: booking.player_count || booking.playerCount || 1,
    status: booking.status,
  };
}

// Ever House bay serial number mapping (from Trackman configuration)
const BAY_SERIAL_TO_RESOURCE: Record<string, number> = {
  '24120062': 1, // Bay 1
  '23510044': 2, // Bay 2
  '24070104': 3, // Bay 3
  '24080064': 4, // Bay 4
};

function mapBayNameToResourceId(
  bayName: string | undefined, 
  bayId: string | undefined,
  baySerial?: string
): number | null {
  // Check serial number first - most reliable mapping
  if (baySerial) {
    const serialMatch = BAY_SERIAL_TO_RESOURCE[baySerial.trim()];
    if (serialMatch) {
      logger.info('[Trackman Webhook] Matched bay by serial number', {
        extra: { baySerial, resourceId: serialMatch }
      });
      return serialMatch;
    }
  }
  
  if (!bayName && !bayId) return null;
  
  const name = (bayName || bayId || '').toLowerCase().trim();
  
  // Extract bay number only from patterns that clearly indicate a bay/simulator
  // Pattern must include "bay", "sim", or "simulator" followed by a number
  const bayPatternMatch = name.match(/(?:bay|sim(?:ulator)?)\s*[-_]?\s*(\d+)/i);
  if (bayPatternMatch) {
    const bayNum = parseInt(bayPatternMatch[1], 10);
    if (bayNum >= 1 && bayNum <= 4) {
      return bayNum;
    }
  }
  
  // Also accept standalone numbers only if the name is very short (e.g., "1", "Bay1")
  if (name.length <= 5) {
    const standaloneMatch = name.match(/^(\d)$/);
    if (standaloneMatch) {
      const bayNum = parseInt(standaloneMatch[1], 10);
      if (bayNum >= 1 && bayNum <= 4) {
        return bayNum;
      }
    }
  }
  
  // Fallback to explicit patterns for edge cases
  if (name === 'bay1' || name === 'bay 1' || name === 'bay-1' || name === 'bay_1') return 1;
  if (name === 'bay2' || name === 'bay 2' || name === 'bay-2' || name === 'bay_2') return 2;
  if (name === 'bay3' || name === 'bay 3' || name === 'bay-3' || name === 'bay_3') return 3;
  if (name === 'bay4' || name === 'bay 4' || name === 'bay-4' || name === 'bay_4') return 4;
  
  // Handle word-based numbers as last resort
  if (name.includes('one') || name.includes('first')) return 1;
  if (name.includes('two') || name.includes('second')) return 2;
  if (name.includes('three') || name.includes('third')) return 3;
  if (name.includes('four') || name.includes('fourth')) return 4;
  
  return null;
}

function parseDateTime(dateTimeStr: string | undefined, dateStr: string | undefined): { date: string; time: string } | null {
  if (!dateTimeStr && !dateStr) return null;
  
  try {
    if (dateTimeStr) {
      const dt = new Date(dateTimeStr);
      if (!isNaN(dt.getTime())) {
        const pacificFormatter = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
        const timeFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Los_Angeles',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        
        return {
          date: pacificFormatter.format(dt),
          time: timeFormatter.format(dt).replace(/^24:/, '00:'),
        };
      }
    }
    
    if (dateStr) {
      return { date: dateStr, time: '00:00' };
    }
  } catch (e) {
    logger.warn('[Trackman Webhook] Failed to parse date/time', { extra: { dateTimeStr, dateStr } });
  }
  
  return null;
}

async function logWebhookEvent(
  eventType: string,
  payload: any,
  trackmanBookingId?: string,
  trackmanUserId?: string,
  matchedBookingId?: number,
  matchedUserId?: string,
  error?: string
): Promise<number> {
  try {
    const result = await pool.query(
      `INSERT INTO trackman_webhook_events 
       (event_type, payload, trackman_booking_id, trackman_user_id, matched_booking_id, matched_user_id, processed_at, processing_error)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       RETURNING id`,
      [eventType, JSON.stringify(payload), trackmanBookingId, trackmanUserId, matchedBookingId, matchedUserId, error]
    );
    return result.rows[0]?.id;
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to log webhook event', { error: e as Error });
    return 0;
  }
}

async function updateBaySlotCache(
  trackmanBookingId: string,
  resourceId: number,
  slotDate: string,
  startTime: string,
  endTime: string,
  status: 'booked' | 'cancelled' | 'completed',
  customerEmail?: string,
  customerName?: string,
  playerCount?: number
): Promise<void> {
  try {
    if (status === 'cancelled') {
      await pool.query(
        `UPDATE trackman_bay_slots 
         SET status = 'cancelled', updated_at = NOW()
         WHERE trackman_booking_id = $1`,
        [trackmanBookingId]
      );
    } else {
      await pool.query(
        `INSERT INTO trackman_bay_slots 
         (resource_id, slot_date, start_time, end_time, status, trackman_booking_id, customer_email, customer_name, player_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (resource_id, slot_date, start_time, trackman_booking_id)
         DO UPDATE SET 
           end_time = EXCLUDED.end_time,
           status = EXCLUDED.status,
           customer_email = EXCLUDED.customer_email,
           customer_name = EXCLUDED.customer_name,
           player_count = EXCLUDED.player_count,
           updated_at = NOW()`,
        [resourceId, slotDate, startTime, endTime, status, trackmanBookingId, customerEmail, customerName, playerCount || 1]
      );
    }
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to update bay slot cache', { error: e as Error });
  }
}

async function resolveLinkedEmail(email: string): Promise<string> {
  try {
    const result = await pool.query(
      `SELECT primary_email FROM user_linked_emails WHERE LOWER(linked_email) = LOWER($1)`,
      [email]
    );
    
    if (result.rows.length > 0) {
      const primaryEmail = result.rows[0].primary_email;
      logger.info('[Trackman Webhook] Resolved linked email to primary', {
        extra: { linkedEmail: email, primaryEmail }
      });
      return primaryEmail;
    }
    
    return email;
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to resolve linked email', { error: e as Error });
    return email;
  }
}

async function findMemberByEmail(email: string): Promise<{ id: string; email: string; firstName: string | null; lastName: string | null; tier: string | null } | null> {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, tier FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        id: row.id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        tier: row.tier
      };
    }
    
    return null;
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to find member by email', { error: e as Error });
    return null;
  }
}

async function tryAutoApproveBooking(
  customerEmail: string,
  slotDate: string,
  startTime: string,
  trackmanBookingId: string
): Promise<{ matched: boolean; bookingId?: number }> {
  try {
    const result = await pool.query(
      `UPDATE booking_requests 
       SET status = 'approved',
           trackman_booking_id = $1,
           reviewed_at = NOW(),
           reviewed_by = 'trackman_webhook',
           staff_notes = COALESCE(staff_notes, '') || ' [Auto-approved via Trackman webhook]',
           updated_at = NOW()
       WHERE LOWER(user_email) = LOWER($2)
         AND request_date = $3
         AND start_time = $4
         AND status = 'pending'
       RETURNING id`,
      [trackmanBookingId, customerEmail, slotDate, startTime]
    );
    
    if (result.rowCount && result.rowCount > 0) {
      logger.info('[Trackman Webhook] Auto-approved booking', {
        extra: { bookingId: result.rows[0].id, email: customerEmail, date: slotDate, time: startTime }
      });
      return { matched: true, bookingId: result.rows[0].id };
    }
    
    const fuzzyResult = await pool.query(
      `UPDATE booking_requests 
       SET status = 'approved',
           trackman_booking_id = $1,
           reviewed_at = NOW(),
           reviewed_by = 'trackman_webhook',
           staff_notes = COALESCE(staff_notes, '') || ' [Auto-approved via Trackman webhook - fuzzy time match]',
           updated_at = NOW()
       WHERE LOWER(user_email) = LOWER($2)
         AND request_date = $3
         AND ABS(EXTRACT(EPOCH FROM (start_time::time - $4::time))) <= 1800
         AND status = 'pending'
       RETURNING id`,
      [trackmanBookingId, customerEmail, slotDate, startTime]
    );
    
    if (fuzzyResult.rowCount && fuzzyResult.rowCount > 0) {
      logger.info('[Trackman Webhook] Auto-approved booking (fuzzy match)', {
        extra: { bookingId: fuzzyResult.rows[0].id, email: customerEmail, date: slotDate }
      });
      return { matched: true, bookingId: fuzzyResult.rows[0].id };
    }
    
    return { matched: false };
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to auto-approve booking', { error: e as Error });
    return { matched: false };
  }
}

async function createBookingForMember(
  member: { id: string; email: string; firstName: string | null; lastName: string | null },
  trackmanBookingId: string,
  slotDate: string,
  startTime: string,
  endTime: string,
  resourceId: number,
  playerCount: number,
  customerName?: string
): Promise<{ success: boolean; bookingId?: number }> {
  // Enforce non-null resource_id - bookings without a valid bay should go to unmatched queue
  if (!resourceId || resourceId < 1 || resourceId > 4) {
    logger.error('[Trackman Webhook] createBookingForMember called with invalid resourceId', {
      extra: { resourceId, email: member.email, trackmanBookingId }
    });
    return { success: false };
  }
  
  try {
    const startParts = startTime.split(':').map(Number);
    const endParts = endTime.split(':').map(Number);
    const startMinutes = startParts[0] * 60 + startParts[1];
    const endMinutes = endParts[0] * 60 + endParts[1];
    const durationMinutes = endMinutes > startMinutes ? endMinutes - startMinutes : 60;
    
    const memberName = customerName || 
      [member.firstName, member.lastName].filter(Boolean).join(' ') || 
      member.email;
    
    const result = await pool.query(
      `INSERT INTO booking_requests 
       (user_id, user_email, user_name, resource_id, request_date, start_time, end_time, 
        duration_minutes, status, trackman_booking_id, trackman_player_count, 
        reviewed_by, reviewed_at, staff_notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', $9, $10, 'trackman_webhook', NOW(), 
               '[Auto-created via Trackman webhook - staff booking]', NOW(), NOW())
       RETURNING id`,
      [
        member.id,
        member.email,
        memberName,
        resourceId,
        slotDate,
        startTime,
        endTime,
        durationMinutes,
        trackmanBookingId,
        playerCount
      ]
    );
    
    if (result.rows.length > 0) {
      const logLevel = resourceId ? 'info' : 'warn';
      const logMethod = resourceId ? logger.info.bind(logger) : logger.warn.bind(logger);
      logMethod(`[Trackman Webhook] Auto-created booking for member${resourceId ? '' : ' (no resource_id - bay unmapped)'}`, {
        extra: { 
          bookingId: result.rows[0].id, 
          email: member.email, 
          date: slotDate, 
          time: startTime,
          resourceId: resourceId || null,
          trackmanBookingId 
        }
      });
      return { success: true, bookingId: result.rows[0].id };
    }
    
    return { success: false };
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to create booking for member', { error: e as Error });
    return { success: false };
  }
}

async function saveToUnmatchedBookings(
  trackmanBookingId: string,
  slotDate: string,
  startTime: string,
  endTime: string,
  resourceId: number | null,
  customerEmail?: string,
  customerName?: string,
  playerCount?: number,
  reason?: string
): Promise<void> {
  try {
    const startParts = startTime.split(':').map(Number);
    const endParts = endTime.split(':').map(Number);
    const startMinutes = startParts[0] * 60 + startParts[1];
    const endMinutes = endParts[0] * 60 + endParts[1];
    const durationMinutes = endMinutes > startMinutes ? endMinutes - startMinutes : 60;
    
    // Determine the match attempt reason
    let matchAttemptReason = reason;
    if (!matchAttemptReason) {
      if (!customerEmail) {
        matchAttemptReason = 'No customer email provided';
      } else if (!resourceId) {
        matchAttemptReason = 'Bay could not be mapped to simulator';
      } else {
        matchAttemptReason = 'No member found with this email';
      }
    }
    
    await pool.query(
      `INSERT INTO trackman_unmatched_bookings 
       (trackman_booking_id, user_name, original_email, booking_date, start_time, end_time, 
        duration_minutes, bay_number, player_count, match_attempt_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT DO NOTHING`,
      [
        trackmanBookingId,
        customerName || 'Unknown',
        customerEmail || null,
        slotDate,
        startTime,
        endTime,
        durationMinutes,
        resourceId ? `Bay ${resourceId}` : null,
        playerCount || 1,
        matchAttemptReason
      ]
    );
    
    logger.info('[Trackman Webhook] Saved to unmatched bookings', {
      extra: { trackmanBookingId, email: customerEmail, date: slotDate }
    });
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to save unmatched booking', { error: e as Error });
  }
}

async function cancelBookingByTrackmanId(trackmanBookingId: string): Promise<{ cancelled: boolean; bookingId?: number }> {
  try {
    const result = await pool.query(
      `UPDATE booking_requests 
       SET status = 'cancelled',
           staff_notes = COALESCE(staff_notes, '') || ' [Cancelled via Trackman webhook]',
           updated_at = NOW()
       WHERE trackman_booking_id = $1
         AND status NOT IN ('cancelled', 'declined')
       RETURNING id, user_email`,
      [trackmanBookingId]
    );
    
    if (result.rowCount && result.rowCount > 0) {
      const { id: bookingId, user_email } = result.rows[0];
      
      logger.info('[Trackman Webhook] Cancelled booking via webhook', {
        extra: { bookingId, trackmanBookingId }
      });
      
      if (user_email) {
        const userResult = await pool.query(
          `SELECT id, email FROM users WHERE LOWER(email) = LOWER($1)`,
          [user_email]
        );
        
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0];
          
          await pool.query(
            `INSERT INTO notifications (user_id, title, message, type, link, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [
              user.id,
              'Booking Cancelled',
              'Your simulator booking has been cancelled.',
              'booking',
              '/bookings'
            ]
          );
          
          sendNotificationToUser(user.email, {
            type: 'booking_cancelled',
            title: 'Booking Cancelled',
            message: 'Your simulator booking has been cancelled.',
            data: { bookingId },
          });
        }
      }
      
      return { cancelled: true, bookingId };
    }
    
    return { cancelled: false };
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to cancel booking', { error: e as Error });
    return { cancelled: false };
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
    const userResult = await pool.query(
      `SELECT id, first_name, last_name, email FROM users WHERE LOWER(email) = LOWER($1)`,
      [customerEmail]
    );
    
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const memberName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Member';
      const message = `Your simulator booking for ${slotDate} at ${startTime}${bayName ? ` (${bayName})` : ''} has been confirmed.`;
      
      // Use unified notification service - sends to database, WebSocket, and push
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
          sendEmail: true,
          emailSubject: 'Your Booking is Confirmed - Ever House',
          emailHtml: `
            <h2>Booking Confirmed</h2>
            <p>Hi ${memberName},</p>
            <p>${message}</p>
            <p>We look forward to seeing you!</p>
          `
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
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to notify member', { error: e as Error });
  }
}

async function notifyStaffBookingCreated(
  action: 'auto_approved' | 'auto_created' | 'unmatched',
  memberName: string,
  memberEmail: string | undefined,
  slotDate: string,
  startTime: string,
  bayName?: string,
  bookingId?: number
): Promise<void> {
  try {
    let title: string;
    let message: string;
    let notificationType: string;
    
    switch (action) {
      case 'auto_approved':
        title = 'Booking Auto-Approved';
        message = `${memberName}'s pending request for ${slotDate} at ${startTime}${bayName ? ` (${bayName})` : ''} was auto-approved via Trackman.`;
        notificationType = 'trackman_booking';
        break;
      case 'auto_created':
        title = 'Booking Auto-Created';
        message = `A booking for ${memberName} on ${slotDate} at ${startTime}${bayName ? ` (${bayName})` : ''} was auto-created from Trackman.`;
        notificationType = 'trackman_booking';
        break;
      case 'unmatched':
        title = 'Unmatched Trackman Booking';
        message = `Booking for "${memberName}" (${memberEmail || 'no email'}) on ${slotDate} at ${startTime} needs staff review.`;
        notificationType = 'trackman_unmatched';
        break;
    }
    
    // Send real-time WebSocket notification to all connected staff
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
    
    // Also save to database for staff notification history (optional - only for unmatched)
    if (action === 'unmatched') {
      await notifyAllStaff(
        title,
        message,
        notificationType,
        bookingId,
        'trackman_booking'
      );
    }
    
    logger.info('[Trackman Webhook] Notified staff', { 
      extra: { action, memberName, memberEmail, date: slotDate } 
    });
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to notify staff', { error: e as Error });
  }
}

async function handleBookingUpdate(payload: TrackmanWebhookPayload): Promise<{ success: boolean; matchedBookingId?: number }> {
  const bookingData = extractBookingData(payload);
  if (!bookingData) {
    return { success: false };
  }
  
  const normalized = normalizeBookingFields(bookingData);
  
  if (!normalized.trackmanBookingId) {
    logger.warn('[Trackman Webhook] No booking ID in payload');
    return { success: false };
  }
  
  const startParsed = parseDateTime(normalized.startTime, normalized.date);
  const endParsed = parseDateTime(normalized.endTime, undefined);
  
  if (!startParsed) {
    logger.warn('[Trackman Webhook] Could not parse start time', { extra: { startTime: normalized.startTime } });
    return { success: false };
  }
  
  const resourceId = mapBayNameToResourceId(normalized.bayName, normalized.bayId, normalized.baySerial);
  
  // Log warning if we couldn't map bay to resource - this helps debug bay naming issues
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
    logger.info('[Trackman Webhook] No customer email provided, saving to unmatched', {
      extra: { trackmanBookingId: normalized.trackmanBookingId }
    });
    await saveToUnmatchedBookings(
      normalized.trackmanBookingId,
      startParsed.date,
      startParsed.time,
      endParsed?.time || startParsed.time,
      resourceId,
      undefined,
      normalized.customerName,
      normalized.playerCount
    );
    return { success: true };
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
    
    // Notify member their booking is confirmed
    await notifyMemberBookingConfirmed(
      emailForLookup,
      autoApproveResult.bookingId,
      startParsed.date,
      startParsed.time,
      normalized.bayName
    );
    
    // Notify staff about the auto-approval
    await notifyStaffBookingCreated(
      'auto_approved',
      normalized.customerName || emailForLookup,
      emailForLookup,
      startParsed.date,
      startParsed.time,
      normalized.bayName,
      autoApproveResult.bookingId
    );
    
    logger.info('[Trackman Webhook] Auto-approved pending booking request', {
      extra: { bookingId: matchedBookingId, email: emailForLookup }
    });
    return { success: true, matchedBookingId };
  }
  
  const member = await findMemberByEmail(emailForLookup);
  
  if (member) {
    // Only auto-create booking if we have a valid resource_id (bay mapping succeeded)
    // Otherwise, save to unmatched so staff can manually assign the bay
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
      
      // Notify member their booking is confirmed
      await notifyMemberBookingConfirmed(
        member.email,
        createResult.bookingId,
        startParsed.date,
        startParsed.time,
        normalized.bayName
      );
      
      // Notify staff about the auto-created booking
      await notifyStaffBookingCreated(
        'auto_created',
        memberName,
        member.email,
        startParsed.date,
        startParsed.time,
        normalized.bayName,
        createResult.bookingId
      );
      
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
  
  // Notify staff about the unmatched booking that needs review
  await notifyStaffBookingCreated(
    'unmatched',
    normalized.customerName || 'Unknown',
    normalized.customerEmail,
    startParsed.date,
    startParsed.time,
    normalized.bayName
  );
  
  return { success: true, matchedBookingId };
}

router.post('/api/webhooks/trackman', async (req: Request, res: Response) => {
  logger.info('[Trackman Webhook] Received webhook', {
    extra: { 
      headers: Object.keys(req.headers).filter(h => h.startsWith('x-')),
      bodyKeys: Object.keys(req.body || {})
    }
  });
  
  if (!validateTrackmanWebhookSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  const payload: TrackmanWebhookPayload = req.body;
  const eventType = payload.event_type || payload.eventType || 'unknown';
  
  res.status(200).json({ received: true });
  
  try {
    let trackmanBookingId: string | undefined;
    let trackmanUserId: string | undefined;
    let matchedBookingId: number | undefined;
    let matchedUserId: string | undefined;
    let processingError: string | undefined;
    
    const bookingData = extractBookingData(payload);
    if (bookingData) {
      const normalized = normalizeBookingFields(bookingData);
      trackmanBookingId = normalized.trackmanBookingId;
      matchedUserId = normalized.customerEmail;
    }
    
    if (payload.user?.id) {
      trackmanUserId = payload.user.id;
    }
    
    switch (eventType) {
      case 'booking_update':
      case 'Booking Update':
      case 'booking.update':
      case 'booking.created':
      case 'booking.cancelled':
        const result = await handleBookingUpdate(payload);
        matchedBookingId = result.matchedBookingId;
        if (!result.success) {
          processingError = 'Failed to process booking update';
        }
        break;
        
      case 'user_update':
      case 'User Update':
      case 'user.update':
        logger.info('[Trackman Webhook] User update received - logging only', { extra: { payload } });
        break;
        
      case 'purchase_update':
      case 'Purchase Update':
      case 'purchase.update':
        logger.info('[Trackman Webhook] Purchase update received - logging only', { extra: { payload } });
        break;
        
      case 'purchase_paid':
      case 'Purchase Paid':
      case 'purchase.paid':
        logger.info('[Trackman Webhook] Purchase paid received - logging only', { extra: { payload } });
        break;
        
      default:
        logger.info('[Trackman Webhook] Unknown event type', { extra: { eventType, payload } });
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
      payload.event_type || payload.eventType || 'unknown',
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
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const eventType = req.query.event_type as string;
    
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;
    
    if (eventType) {
      whereClause += ` AND event_type = $${paramIndex}`;
      params.push(eventType);
      paramIndex++;
    }
    
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM trackman_webhook_events ${whereClause}`,
      params
    );
    
    const result = await pool.query(
      `SELECT 
        id,
        event_type,
        trackman_booking_id,
        trackman_user_id,
        matched_booking_id,
        matched_user_id,
        processing_error,
        processed_at,
        created_at,
        payload
       FROM trackman_webhook_events
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );
    
    res.json({
      events: result.rows,
      totalCount: parseInt(countResult.rows[0].total),
      limit,
      offset,
    });
  } catch (error: any) {
    logger.error('[Trackman Webhook] Failed to fetch webhook events', { error });
    res.status(500).json({ error: 'Failed to fetch webhook events' });
  }
});

router.get('/api/admin/trackman-webhooks/stats', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_events,
        COUNT(*) FILTER (WHERE event_type = 'booking_update') as booking_updates,
        COUNT(*) FILTER (WHERE matched_booking_id IS NOT NULL) as auto_approved,
        COUNT(*) FILTER (WHERE processing_error IS NOT NULL) as errors,
        MAX(created_at) as last_event_at
      FROM trackman_webhook_events
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `);
    
    const slotStats = await pool.query(`
      SELECT 
        COUNT(*) as total_slots,
        COUNT(*) FILTER (WHERE status = 'booked') as booked,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE slot_date >= CURRENT_DATE) as upcoming
      FROM trackman_bay_slots
    `);
    
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
    
    const existingLink = await pool.query(
      `SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = LOWER($1)`,
      [linkedEmail]
    );
    
    if (existingLink.rows.length > 0) {
      return res.status(409).json({ error: 'This email is already linked to a member' });
    }
    
    const session = (req as any).session;
    const createdBy = session?.email || 'unknown';
    
    await pool.query(
      `INSERT INTO user_linked_emails (primary_email, linked_email, source, created_by)
       VALUES ($1, $2, 'trackman_resolution', $3)`,
      [primaryEmail.toLowerCase(), linkedEmail.toLowerCase(), createdBy]
    );
    
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
    
    const asLinked = await pool.query(
      `SELECT primary_email, linked_email, source, created_by, created_at
       FROM user_linked_emails 
       WHERE LOWER(linked_email) = LOWER($1)`,
      [email]
    );
    
    const asPrimary = await pool.query(
      `SELECT primary_email, linked_email, source, created_by, created_at
       FROM user_linked_emails 
       WHERE LOWER(primary_email) = LOWER($1)`,
      [email]
    );
    
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
    
    let whereClause = `WHERE slot_date >= $1 AND slot_date <= $2 AND status = 'booked'`;
    const params: any[] = [start_date, end_date];
    
    if (resource_id) {
      whereClause += ` AND resource_id = $3`;
      params.push(resource_id);
    }
    
    const result = await pool.query(
      `SELECT 
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
       ${whereClause}
       ORDER BY slot_date, start_time`,
      params
    );
    
    res.json(result.rows);
  } catch (error: any) {
    logger.error('[Trackman Webhook] Failed to fetch availability cache', { error });
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

export default router;
