import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../core/db';
import { logger } from '../core/logger';
import { isStaffOrAdmin, isAdmin } from '../core/middleware';
import { sendNotificationToUser, broadcastToStaff } from '../core/websocket';
// Removed sendBookingConfirmationEmail import - email notifications disabled per user preference, push only for now
import { notifyAllStaff } from '../core/staffNotifications';
import { notifyMember } from '../core/notificationService';
import { formatDatePacific, formatTimePacific } from '../utils/dateUtils';
import { refundGuestPass } from './guestPasses';

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

// V2 Trackman webhook format - nested venue/booking structure
interface TrackmanV2BayOption {
  id: number;
  name: string;
  duration?: number;
  subtitle?: string | null;
}

interface TrackmanV2PlayerOption {
  id: number;
  name: string;
  quantity: number;
  subtitle?: string | null;
}

interface TrackmanV2Booking {
  id: number;
  bay?: {
    id: number;
    ref: string;
  };
  start: string;  // ISO 8601 UTC format: "2026-01-23T17:15:00.000Z"
  end: string;    // ISO 8601 UTC format: "2026-01-23T18:45:00.000Z"
  type?: string;
  range?: {
    id: number;
  };
  status: string;  // "attended", "confirmed", "cancelled", etc.
  bayOption?: TrackmanV2BayOption;
  created_at?: string;
  playerOptions?: TrackmanV2PlayerOption[];
  externalBookingId?: string;  // Our system's booking UUID sent to Trackman
  externalBookingProvider?: string;
}

interface TrackmanV2Venue {
  id: number;
  name: string;
  slug: string;
}

interface TrackmanV2WebhookPayload {
  venue?: TrackmanV2Venue;
  booking?: TrackmanV2Booking;
}

interface TrackmanWebhookPayload {
  event_type?: string;
  eventType?: string;
  data?: TrackmanBookingPayload;
  booking?: TrackmanBookingPayload | TrackmanV2Booking;
  user?: any;
  purchase?: any;
  timestamp?: string;
  venue?: TrackmanV2Venue;  // V2 format includes venue
}

function validateTrackmanWebhookSignature(req: Request): boolean {
  const webhookSecret = process.env.TRACKMAN_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    // Trackman doesn't provide webhook secrets, so allow without validation
    logger.info('[Trackman Webhook] No TRACKMAN_WEBHOOK_SECRET configured - allowing request (Trackman does not provide secrets)');
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
  return payload.data || payload.booking as TrackmanBookingPayload || null;
}

// Detect if webhook is in V2 format (nested venue/booking with ISO timestamps)
function isTrackmanV2Payload(payload: any): payload is TrackmanV2WebhookPayload {
  return payload?.booking?.start && 
         payload?.booking?.end && 
         typeof payload?.booking?.id === 'number' &&
         (payload?.venue || payload?.booking?.bay?.ref);
}

// Convert ISO 8601 UTC timestamp to Pacific timezone date/time
function parseISOToPacific(isoStr: string): { date: string; time: string } {
  const dt = new Date(isoStr);
  if (isNaN(dt.getTime())) {
    throw new Error(`Invalid ISO date: ${isoStr}`);
  }
  return {
    date: formatDatePacific(dt),
    time: formatTimePacific(dt).substring(0, 5), // HH:MM from HH:MM:SS
  };
}

// Infer event type from V2 booking status
function inferEventTypeFromStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === 'cancelled' || s === 'canceled' || s === 'deleted') {
    return 'booking.cancelled';
  }
  if (s === 'attended' || s === 'confirmed' || s === 'booked') {
    return 'booking.created';
  }
  return 'booking_update';
}

// Parse V2 payload and return normalized booking data
function parseTrackmanV2Payload(payload: TrackmanV2WebhookPayload): {
  normalized: ReturnType<typeof normalizeBookingFields>;
  eventType: string;
  externalBookingId: string | undefined;
  bayRef: string | undefined;
} {
  const booking = payload.booking!;
  
  // Parse start/end times from ISO 8601 UTC to Pacific
  const startParsed = parseISOToPacific(booking.start);
  const endParsed = parseISOToPacific(booking.end);
  
  // Calculate player count from playerOptions
  const playerCount = booking.playerOptions?.reduce((sum, opt) => sum + opt.quantity, 0) || 1;
  
  // Create normalized structure
  const normalized = {
    trackmanBookingId: String(booking.id),
    bayId: booking.bay?.ref,
    bayName: booking.bay?.ref ? `Bay ${booking.bay.ref}` : undefined,
    baySerial: undefined,
    startTime: `${startParsed.date}T${startParsed.time}:00`,
    endTime: `${endParsed.date}T${endParsed.time}:00`,
    date: startParsed.date,
    customerEmail: undefined, // V2 doesn't include customer email
    customerName: undefined,  // V2 doesn't include customer name
    customerPhone: undefined,
    customerId: undefined,
    playerCount,
    status: booking.status,
    // Parsed Pacific times for direct use
    parsedDate: startParsed.date,
    parsedStartTime: startParsed.time,
    parsedEndTime: endParsed.time,
  };
  
  return {
    normalized,
    eventType: inferEventTypeFromStatus(booking.status),
    externalBookingId: booking.externalBookingId,
    bayRef: booking.bay?.ref,
  };
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
    // For V1 format, parsed times come from parseDateTime
    parsedDate: undefined as string | undefined,
    parsedStartTime: undefined as string | undefined,
    parsedEndTime: undefined as string | undefined,
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
  baySerial?: string,
  bayRef?: string  // V2 format bay.ref field
): number | null {
  // Check bay.ref first (V2 format) - most direct mapping
  if (bayRef) {
    const refNum = parseInt(bayRef.trim(), 10);
    if (refNum >= 1 && refNum <= 4) {
      logger.info('[Trackman Webhook] Matched bay by ref', {
        extra: { bayRef, resourceId: refNum }
      });
      return refNum;
    }
  }
  
  // Check serial number - reliable for V1 format
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

// Link booking by external booking ID (UUID sent to Trackman when booking was created)
async function linkByExternalBookingId(
  externalBookingId: string,
  trackmanBookingId: string,
  slotDate: string,
  startTime: string,
  endTime: string,
  resourceId: number | null,
  status: string,
  playerCount: number
): Promise<{ matched: boolean; bookingId?: number; memberEmail?: string; memberName?: string }> {
  try {
    // Find booking request by external booking ID (stored as UUID in calendar_event_id or similar)
    // The externalBookingId is our system's UUID that was sent to Trackman
    const result = await pool.query(
      `SELECT id, user_email, user_name, user_id, status as current_status, resource_id
       FROM booking_requests 
       WHERE calendar_event_id = $1
         OR id::text = $1
       LIMIT 1`,
      [externalBookingId]
    );
    
    if (result.rows.length === 0) {
      // Try matching by UUID pattern in staff_notes (for pending trackman sync)
      const pendingResult = await pool.query(
        `SELECT id, user_email, user_name, user_id, status as current_status, resource_id
         FROM booking_requests 
         WHERE staff_notes LIKE $1
           AND trackman_booking_id IS NULL
         LIMIT 1`,
        [`%${externalBookingId}%`]
      );
      
      if (pendingResult.rows.length === 0) {
        logger.info('[Trackman Webhook] No booking found for externalBookingId', {
          extra: { externalBookingId }
        });
        return { matched: false };
      }
      
      result.rows = pendingResult.rows;
    }
    
    const booking = result.rows[0];
    const bookingId = booking.id;
    const memberEmail = booking.user_email;
    const memberName = booking.user_name;
    
    // Determine new status based on Trackman status
    const normalizedStatus = status.toLowerCase();
    let newStatus = booking.current_status;
    if (normalizedStatus === 'attended') {
      newStatus = 'attended';
    } else if (normalizedStatus === 'confirmed' || normalizedStatus === 'booked') {
      newStatus = 'approved';
    } else if (normalizedStatus === 'cancelled' || normalizedStatus === 'canceled') {
      newStatus = 'cancelled';
    }
    
    // Calculate duration
    const startParts = startTime.split(':').map(Number);
    const endParts = endTime.split(':').map(Number);
    const startMinutes = startParts[0] * 60 + startParts[1];
    const endMinutes = endParts[0] * 60 + endParts[1];
    const durationMinutes = endMinutes > startMinutes ? endMinutes - startMinutes : 60;
    
    // Update booking with Trackman info
    await pool.query(
      `UPDATE booking_requests 
       SET trackman_booking_id = $1,
           trackman_player_count = $2,
           status = $3,
           start_time = $4,
           end_time = $5,
           duration_minutes = $6,
           resource_id = COALESCE($7, resource_id),
           reviewed_by = COALESCE(reviewed_by, 'trackman_webhook'),
           reviewed_at = COALESCE(reviewed_at, NOW()),
           staff_notes = COALESCE(staff_notes, '') || ' [Linked via Trackman webhook - externalBookingId match]',
           updated_at = NOW()
       WHERE id = $8`,
      [
        trackmanBookingId,
        playerCount,
        newStatus,
        startTime,
        endTime,
        durationMinutes,
        resourceId,
        bookingId
      ]
    );
    
    logger.info('[Trackman Webhook] Linked booking via externalBookingId', {
      extra: { 
        bookingId, 
        trackmanBookingId, 
        externalBookingId, 
        memberEmail,
        oldStatus: booking.current_status,
        newStatus
      }
    });
    
    return { matched: true, bookingId, memberEmail, memberName };
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to link by externalBookingId', { error: e as Error });
    return { matched: false };
  }
}

function parseDateTime(dateTimeStr: string | undefined, dateStr: string | undefined): { date: string; time: string } | null {
  if (!dateTimeStr && !dateStr) return null;
  
  try {
    if (dateTimeStr) {
      const dt = new Date(dateTimeStr);
      if (!isNaN(dt.getTime())) {
        // Use centralized Pacific timezone utilities for consistent handling
        return {
          date: formatDatePacific(dt),
          time: formatTimePacific(dt).substring(0, 5), // HH:MM from HH:MM:SS
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

function redactPII(payload: any): any {
  if (!payload || typeof payload !== 'object') return payload;
  
  const redacted = Array.isArray(payload) ? [...payload] : { ...payload };
  const sensitiveFields = ['email', 'phone', 'phoneNumber', 'mobile', 'customer_email', 'customerEmail'];
  
  for (const key of Object.keys(redacted)) {
    if (sensitiveFields.some(f => key.toLowerCase().includes(f.toLowerCase()))) {
      if (typeof redacted[key] === 'string' && redacted[key].includes('@')) {
        // Redact email but keep domain for debugging
        const parts = redacted[key].split('@');
        redacted[key] = `${parts[0].substring(0, 2)}***@${parts[1]}`;
      } else if (typeof redacted[key] === 'string') {
        // Redact phone numbers
        redacted[key] = redacted[key].replace(/\d/g, '*').substring(0, 6) + '...';
      }
    } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactPII(redacted[key]);
    }
  }
  
  return redacted;
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
    // Redact PII before storing in logs
    const redactedPayload = redactPII(payload);
    
    const result = await pool.query(
      `INSERT INTO trackman_webhook_events 
       (event_type, payload, trackman_booking_id, trackman_user_id, matched_booking_id, matched_user_id, processed_at, processing_error)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       RETURNING id`,
      [eventType, JSON.stringify(redactedPayload), trackmanBookingId, trackmanUserId, matchedBookingId, matchedUserId, error]
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
           was_auto_linked = true,
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
    // IDEMPOTENCY CHECK: Prevent duplicate bookings from webhook retries
    // Guard against null/undefined trackmanBookingId to avoid false positives
    if (!trackmanBookingId) {
      logger.error('[Trackman Webhook] createBookingForMember called without trackmanBookingId', {
        extra: { email: member.email }
      });
      return { success: false };
    }
    
    const existing = await pool.query(
      `SELECT id FROM booking_requests WHERE trackman_booking_id = $1`,
      [trackmanBookingId]
    );
    
    if (existing.rows.length > 0) {
      logger.info('[Trackman Webhook] Booking already exists, skipping creation (idempotency)', { 
        extra: { trackmanBookingId, existingBookingId: existing.rows[0].id } 
      });
      return { success: true, bookingId: existing.rows[0].id };
    }
    
    // AUTO-LINK CHECK: Look for pending Trackman sync bookings that match by member/date/time
    // These are bookings created via "Create in Trackman" button, waiting for webhook to link
    // Use ±15 minute time tolerance (900 seconds) to handle staff booking at slightly different times
    // Also check for 'pending' status bookings that can be auto-approved and linked
    const pendingSync = await pool.query(
      `SELECT id, staff_notes, start_time, end_time, status FROM booking_requests 
       WHERE LOWER(user_email) = LOWER($1)
       AND request_date = $2
       AND ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 900
       AND status IN ('approved', 'pending')
       AND trackman_booking_id IS NULL
       AND (staff_notes LIKE '%[PENDING_TRACKMAN_SYNC]%' OR status = 'pending')
       ORDER BY 
         CASE WHEN staff_notes LIKE '%[PENDING_TRACKMAN_SYNC]%' THEN 0 ELSE 1 END,
         ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))),
         created_at DESC
       LIMIT 1`,
      [member.email, slotDate, startTime]
    );
    
    if (pendingSync.rows.length > 0) {
      const pendingBookingId = pendingSync.rows[0].id;
      const originalStartTime = pendingSync.rows[0].start_time;
      const originalEndTime = pendingSync.rows[0].end_time;
      const originalStatus = pendingSync.rows[0].status;
      const wasTimeTolerance = originalStartTime !== startTime;
      const wasPending = originalStatus === 'pending';
      
      // Log time tolerance match details
      if (wasTimeTolerance) {
        logger.info('[Trackman Webhook] Time tolerance match - updating booking times to match Trackman', {
          extra: {
            bookingId: pendingBookingId,
            originalStartTime,
            trackmanStartTime: startTime,
            originalEndTime,
            trackmanEndTime: endTime,
            timeDifferenceSeconds: Math.abs(
              (parseInt(originalStartTime.split(':')[0]) * 60 + parseInt(originalStartTime.split(':')[1])) -
              (parseInt(startTime.split(':')[0]) * 60 + parseInt(startTime.split(':')[1]))
            ) * 60
          }
        });
      }
      
      // Remove the pending sync marker and link the Trackman booking ID
      let updatedNotes = (pendingSync.rows[0].staff_notes || '')
        .replace('[PENDING_TRACKMAN_SYNC]', '[Linked via Trackman webhook]')
        .trim();
      
      // Add note about time adjustment if times were different
      if (wasTimeTolerance) {
        updatedNotes += ` [Time adjusted: ${originalStartTime} → ${startTime}]`;
      }
      
      // Add note about auto-approval if was pending
      if (wasPending) {
        updatedNotes += ' [Auto-approved via Trackman webhook]';
      }
      
      // Calculate new duration based on Trackman times
      const startParts = startTime.split(':').map(Number);
      const endParts = endTime.split(':').map(Number);
      const startMinutesCalc = startParts[0] * 60 + startParts[1];
      const endMinutesCalc = endParts[0] * 60 + endParts[1];
      const newDurationMinutes = endMinutesCalc > startMinutesCalc ? endMinutesCalc - startMinutesCalc : 60;
      
      // Update booking with Trackman times, link the ID, and auto-approve if pending
      await pool.query(
        `UPDATE booking_requests 
         SET trackman_booking_id = $1, 
             trackman_player_count = $2,
             staff_notes = $3,
             start_time = $4,
             end_time = $5,
             duration_minutes = $6,
             status = 'approved',
             was_auto_linked = true,
             reviewed_by = COALESCE(reviewed_by, 'trackman_webhook'),
             reviewed_at = COALESCE(reviewed_at, NOW()),
             updated_at = NOW()
         WHERE id = $7`,
        [trackmanBookingId, playerCount, updatedNotes, startTime, endTime, newDurationMinutes, pendingBookingId]
      );
      
      const memberName = customerName || 
        [member.firstName, member.lastName].filter(Boolean).join(' ') || 
        member.email;
      
      logger.info('[Trackman Webhook] Auto-linked existing booking', {
        extra: { 
          bookingId: pendingBookingId, 
          trackmanBookingId, 
          email: member.email, 
          date: slotDate, 
          originalTime: originalStartTime,
          trackmanTime: startTime,
          wasTimeTolerance,
          wasPending,
          wasAutoApproved: wasPending
        }
      });
      
      const bayNameForNotification = `Bay ${resourceId}`;
      broadcastToStaff({
        type: 'booking_auto_confirmed',
        title: 'Booking Auto-Confirmed',
        message: `${memberName}'s booking for ${slotDate} at ${startTime} (${bayNameForNotification}) was auto-linked via Trackman.`,
        data: {
          bookingId: pendingBookingId,
          memberName,
          memberEmail: member.email,
          date: slotDate,
          time: startTime,
          bay: bayNameForNotification,
          wasAutoApproved: wasPending
        }
      });
      
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type, link, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          member.id,
          'Booking Confirmed',
          `Your simulator booking for ${slotDate} at ${startTime} (${bayNameForNotification}) has been confirmed.`,
          'booking',
          '/bookings'
        ]
      );
      
      sendNotificationToUser(member.email, {
        type: 'booking_confirmed',
        title: 'Booking Confirmed',
        message: `Your simulator booking for ${slotDate} at ${startTime} (${bayNameForNotification}) has been confirmed.`,
        data: { bookingId: pendingBookingId },
      });
      
      return { success: true, bookingId: pendingBookingId };
    }
    
    // Note: Cancelled booking check is handled in handleBookingUpdate before calling this function
    // The main flow checks for cancelled bookings after tryAutoApproveBooking fails
    
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
        reviewed_by, reviewed_at, staff_notes, was_auto_linked, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved', $9, $10, 'trackman_webhook', NOW(), 
               '[Auto-created via Trackman webhook - staff booking]', true, NOW(), NOW())
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
      const bookingId = result.rows[0].id;
      const bayNameForNotification = `Bay ${resourceId}`;
      const logLevel = resourceId ? 'info' : 'warn';
      const logMethod = resourceId ? logger.info.bind(logger) : logger.warn.bind(logger);
      logMethod(`[Trackman Webhook] Auto-created booking for member${resourceId ? '' : ' (no resource_id - bay unmapped)'}`, {
        extra: { 
          bookingId, 
          email: member.email, 
          date: slotDate, 
          time: startTime,
          resourceId: resourceId || null,
          trackmanBookingId 
        }
      });
      
      broadcastToStaff({
        type: 'booking_auto_confirmed',
        title: 'Booking Auto-Confirmed',
        message: `${memberName}'s booking for ${slotDate} at ${startTime} (${bayNameForNotification}) was auto-created via Trackman.`,
        data: {
          bookingId,
          memberName,
          memberEmail: member.email,
          date: slotDate,
          time: startTime,
          bay: bayNameForNotification
        }
      });
      
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type, link, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          member.id,
          'Booking Confirmed',
          `Your simulator booking for ${slotDate} at ${startTime} (${bayNameForNotification}) has been confirmed.`,
          'booking',
          '/bookings'
        ]
      );
      
      sendNotificationToUser(member.email, {
        type: 'booking_confirmed',
        title: 'Booking Confirmed',
        message: `Your simulator booking for ${slotDate} at ${startTime} (${bayNameForNotification}) has been confirmed.`,
        data: { bookingId },
      });
      
      return { success: true, bookingId };
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

async function createUnmatchedBookingRequest(
  trackmanBookingId: string,
  externalBookingId: string | undefined,
  slotDate: string,
  startTime: string,
  endTime: string,
  resourceId: number | null,
  customerEmail?: string,
  customerName?: string,
  playerCount?: number,
  customerNotes?: string
): Promise<{ created: boolean; bookingId?: number }> {
  try {
    const startParts = startTime.split(':').map(Number);
    const endParts = endTime.split(':').map(Number);
    const startMinutes = startParts[0] * 60 + startParts[1];
    const endMinutes = endParts[0] * 60 + endParts[1];
    const durationMinutes = endMinutes > startMinutes ? endMinutes - startMinutes : 60;
    
    const result = await pool.query(
      `INSERT INTO booking_requests 
       (request_date, start_time, end_time, duration_minutes, resource_id,
        user_email, user_name, status, trackman_booking_id, trackman_external_id,
        trackman_customer_notes, is_unmatched, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, $9, $10, true, NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        slotDate,
        startTime,
        endTime,
        durationMinutes,
        resourceId,
        customerEmail || 'unmatched@trackman.import',
        customerName || 'Unknown (Trackman)',
        trackmanBookingId,
        externalBookingId || null,
        customerNotes || null
      ]
    );
    
    if (result.rows.length > 0) {
      const bookingId = result.rows[0].id;
      
      logger.info('[Trackman Webhook] Created unmatched booking request', {
        extra: { bookingId, trackmanBookingId, date: slotDate, resourceId }
      });
      
      broadcastToStaff({
        type: 'trackman_unmatched',
        bookingId,
        trackmanBookingId,
        date: slotDate,
        startTime,
        resourceId,
        message: 'New unmatched Trackman booking requires staff attention'
      });
      
      await notifyAllStaff(
        'Unmatched Trackman Booking',
        `A booking in Trackman could not be matched to a member and requires manual assignment.`,
        '/staff/simulator',
        'booking'
      );
      
      return { created: true, bookingId };
    }
    
    return { created: false };
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to create unmatched booking request', { error: e as Error });
    return { created: false };
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

async function refundGuestPassesForCancelledBooking(bookingId: number, memberEmail: string): Promise<number> {
  try {
    const sessionResult = await pool.query(
      `SELECT session_id FROM booking_requests WHERE id = $1`,
      [bookingId]
    );
    
    if (!sessionResult.rows[0]?.session_id) {
      return 0;
    }
    
    const sessionId = sessionResult.rows[0].session_id;
    
    const guestParticipants = await pool.query(
      `SELECT id, display_name FROM booking_participants 
       WHERE session_id = $1 AND participant_type = 'guest'`,
      [sessionId]
    );
    
    let refundedCount = 0;
    for (const guest of guestParticipants.rows) {
      const result = await refundGuestPass(memberEmail, guest.display_name || undefined, false);
      if (result.success) {
        refundedCount++;
      }
    }
    
    if (refundedCount > 0) {
      logger.info('[Trackman Webhook] Refunded guest passes for cancelled booking', {
        extra: { bookingId, memberEmail, refundedCount }
      });
    }
    
    return refundedCount;
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to refund guest passes for cancelled booking', { error: e as Error });
    return 0;
  }
}

async function tryLinkCancelledBooking(
  customerEmail: string,
  slotDate: string,
  startTime: string,
  trackmanBookingId: string
): Promise<{ matched: boolean; bookingId?: number; refundedPasses?: number }> {
  try {
    const result = await pool.query(
      `SELECT id, user_email, staff_notes, session_id FROM booking_requests 
       WHERE LOWER(user_email) = LOWER($1)
         AND request_date = $2
         AND ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 900
         AND status = 'cancelled'
         AND updated_at >= NOW() - INTERVAL '24 hours'
         AND trackman_booking_id IS NULL
       ORDER BY ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))), updated_at DESC
       LIMIT 1`,
      [customerEmail, slotDate, startTime]
    );
    
    if (result.rows.length === 0) {
      return { matched: false };
    }
    
    const cancelledBooking = result.rows[0];
    const bookingId = cancelledBooking.id;
    const memberEmail = cancelledBooking.user_email;
    
    const updatedNotes = (cancelledBooking.staff_notes || '') + 
      ' [Trackman booking linked - request was cancelled, manual Trackman cancellation may be needed]';
    
    await pool.query(
      `UPDATE booking_requests 
       SET trackman_booking_id = $1, 
           staff_notes = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [trackmanBookingId, updatedNotes, bookingId]
    );
    
    logger.info('[Trackman Webhook] Linked Trackman booking to cancelled request', {
      extra: { bookingId, trackmanBookingId, email: customerEmail, date: slotDate, time: startTime }
    });
    
    const refundedPasses = await refundGuestPassesForCancelledBooking(bookingId, memberEmail);
    
    return { matched: true, bookingId, refundedPasses };
  } catch (e) {
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
      bookingId,
      'trackman_booking'
    );
    
    logger.info('[Trackman Webhook] Notified staff about cancelled booking link', { 
      extra: { memberName, memberEmail, date: slotDate, bookingId, refundedPasses } 
    });
  } catch (e) {
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
          // Email notifications disabled per user preference - push only for now
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
  
  // Check for cancelled bookings that match by email, date, and time (±15 min tolerance)
  // This handles the edge case where a booking was cancelled after it was created
  const cancelledLinkResult = await tryLinkCancelledBooking(
    emailForLookup,
    startParsed.date,
    startParsed.time,
    normalized.trackmanBookingId
  );
  
  if (cancelledLinkResult.matched && cancelledLinkResult.bookingId) {
    matchedBookingId = cancelledLinkResult.bookingId;
    
    // Notify staff about this edge case - Trackman booking was created for a cancelled request
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
      
      // ALSO create a booking_request to block the time slot on the calendar
      const unmatchedResult = await createUnmatchedBookingRequest(
        normalized.trackmanBookingId,
        normalized.externalBookingId,
        startParsed.date,
        startParsed.time,
        endParsed?.time || startParsed.time,
        null, // no resource_id since bay couldn't be mapped
        normalized.customerEmail,
        normalized.customerName,
        normalized.playerCount
      );
      
      if (unmatchedResult.created) {
        matchedBookingId = unmatchedResult.bookingId;
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
  
  // ALSO create a booking_request to block the time slot on the calendar
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
  
  if (unmatchedResult.created) {
    matchedBookingId = unmatchedResult.bookingId;
  }
  
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
      bodyKeys: Object.keys(req.body || {}),
      hasVenue: !!req.body?.venue,
      hasBookingStart: !!req.body?.booking?.start,
      isV2Format: isTrackmanV2Payload(req.body)
    }
  });
  
  if (!validateTrackmanWebhookSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  const payload: TrackmanWebhookPayload = req.body;
  
  // Respond immediately - process asynchronously
  res.status(200).json({ received: true });
  
  try {
    let trackmanBookingId: string | undefined;
    let trackmanUserId: string | undefined;
    let matchedBookingId: number | undefined;
    let matchedUserId: string | undefined;
    let processingError: string | undefined;
    let eventType: string;
    
    // Check if this is V2 format (nested venue/booking with ISO timestamps)
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
      
      // Map bay.ref to resource_id
      const resourceId = mapBayNameToResourceId(
        v2Result.normalized.bayName,
        v2Result.normalized.bayId,
        v2Result.normalized.baySerial,
        v2Result.bayRef
      );
      
      // Try to link by externalBookingId first (our UUID sent to Trackman)
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
          
          // Update bay slot cache for availability blocking
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
          
          // Send real-time notifications to both staff and member
          const bayName = resourceId ? `Bay ${resourceId}` : undefined;
          
          // Notify member their booking is confirmed
          if (linkResult.memberEmail) {
            await notifyMemberBookingConfirmed(
              linkResult.memberEmail,
              linkResult.bookingId,
              v2Result.normalized.parsedDate!,
              v2Result.normalized.parsedStartTime!,
              bayName
            );
          }
          
          // Notify staff about the confirmed booking via WebSocket
          broadcastToStaff({
            type: 'trackman_booking_confirmed',
            title: 'Trackman Booking Confirmed',
            message: `${linkResult.memberName || linkResult.memberEmail}'s booking for ${v2Result.normalized.parsedDate} at ${v2Result.normalized.parsedStartTime}${bayName ? ` (${bayName})` : ''} has been confirmed via Trackman.`,
            data: {
              bookingId: linkResult.bookingId,
              memberEmail: linkResult.memberEmail,
              memberName: linkResult.memberName,
              date: v2Result.normalized.parsedDate,
              time: v2Result.normalized.parsedStartTime,
              bay: bayName,
              trackmanBookingId: v2Result.normalized.trackmanBookingId,
              status: v2Result.normalized.status
            }
          });
          
          logger.info('[Trackman Webhook V2] Successfully linked booking via externalBookingId', {
            extra: { 
              bookingId: linkResult.bookingId, 
              trackmanBookingId: v2Result.normalized.trackmanBookingId,
              externalBookingId: v2Result.externalBookingId,
              memberEmail: linkResult.memberEmail,
              date: v2Result.normalized.parsedDate,
              time: v2Result.normalized.parsedStartTime
            }
          });
        } else {
          // externalBookingId didn't match - log for debugging
          logger.warn('[Trackman Webhook V2] externalBookingId did not match any booking', {
            extra: { 
              externalBookingId: v2Result.externalBookingId,
              trackmanBookingId: v2Result.normalized.trackmanBookingId
            }
          });
          
          // Create unmatched booking request for staff to assign member
          const unmatchedResult = await createUnmatchedBookingRequest(
            v2Result.normalized.trackmanBookingId!,
            v2Result.externalBookingId,
            v2Result.normalized.parsedDate!,
            v2Result.normalized.parsedStartTime!,
            v2Result.normalized.parsedEndTime!,
            resourceId,
            v2Result.normalized.customerEmail,
            v2Result.normalized.customerName,
            v2Result.normalized.playerCount
          );
          
          if (unmatchedResult.created) {
            matchedBookingId = unmatchedResult.bookingId;
          }
        }
      } else {
        // No externalBookingId - create unmatched booking request
        logger.warn('[Trackman Webhook V2] No externalBookingId in payload', {
          extra: { trackmanBookingId: v2Result.normalized.trackmanBookingId }
        });
        
        const unmatchedResult = await createUnmatchedBookingRequest(
          v2Result.normalized.trackmanBookingId!,
          undefined,
          v2Result.normalized.parsedDate!,
          v2Result.normalized.parsedStartTime!,
          v2Result.normalized.parsedEndTime!,
          resourceId,
          v2Result.normalized.customerEmail,
          v2Result.normalized.customerName,
          v2Result.normalized.playerCount
        );
        
        if (unmatchedResult.created) {
          matchedBookingId = unmatchedResult.bookingId;
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
      
      return; // V2 processing complete
    }
    
    // V1 format processing (original logic)
    eventType = payload.event_type || payload.eventType || 'unknown';
    
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
        logger.info('[Trackman Webhook] Unknown event type (V1)', { extra: { eventType, payload } });
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
        twe.id,
        twe.event_type,
        twe.trackman_booking_id,
        twe.trackman_user_id,
        twe.matched_booking_id,
        twe.matched_user_id,
        twe.processing_error,
        twe.processed_at,
        twe.created_at AT TIME ZONE 'UTC' AS created_at,
        twe.payload,
        br.user_name as linked_member_name,
        br.user_email as linked_member_email,
        br.is_unmatched as linked_booking_unmatched,
        br.was_auto_linked as was_auto_linked
       FROM trackman_webhook_events twe
       LEFT JOIN booking_requests br ON twe.matched_booking_id = br.id
       ${whereClause.replace('WHERE 1=1', 'WHERE twe.id IS NOT NULL')}
       ORDER BY twe.created_at DESC
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
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND br.was_auto_linked = true AND (br.is_unmatched IS NULL OR br.is_unmatched = false)) as auto_confirmed,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND (br.was_auto_linked IS NULL OR br.was_auto_linked = false) AND (br.is_unmatched IS NULL OR br.is_unmatched = false)) as manually_linked,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND br.is_unmatched = true) as unmatched,
        COUNT(*) FILTER (WHERE br.status = 'cancelled') as cancelled,
        MAX(twe.created_at) as last_event_at
      FROM trackman_webhook_events twe
      LEFT JOIN booking_requests br ON twe.matched_booking_id = br.id
      WHERE twe.created_at >= NOW() - INTERVAL '30 days'
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

// Get failed webhook events for admin review
router.get('/api/admin/trackman-webhook/failed', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT 
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
       LIMIT 50`
    );
    
    res.json(result.rows);
  } catch (error: any) {
    logger.error('[Trackman Webhook] Failed to fetch failed events', { error });
    res.status(500).json({ error: 'Failed to fetch failed events' });
  }
});

// Retry a failed webhook event
router.post('/api/admin/trackman-webhook/:eventId/retry', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const eventId = parseInt(req.params.eventId);
    
    if (isNaN(eventId)) {
      return res.status(400).json({ error: 'Invalid event ID' });
    }
    
    // Fetch the original event
    const eventResult = await pool.query(
      `SELECT id, event_type, payload, trackman_booking_id, retry_count
       FROM trackman_webhook_events 
       WHERE id = $1`,
      [eventId]
    );
    
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = eventResult.rows[0];
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    
    // Mark retry attempt
    await pool.query(
      `UPDATE trackman_webhook_events 
       SET retry_count = COALESCE(retry_count, 0) + 1, 
           last_retry_at = NOW()
       WHERE id = $1`,
      [eventId]
    );
    
    // Log the retry
    logger.info('[Trackman Webhook] Admin triggered retry', {
      extra: { eventId, eventType: event.event_type, retryCount: (event.retry_count || 0) + 1 }
    });
    
    // Re-process based on event type - actually call the processing function
    let success = false;
    let message = '';
    let matchedBookingId: number | undefined;
    
    if (event.event_type === 'booking.created' || event.event_type === 'booking.updated') {
      try {
        // Actually re-process the webhook using the same handler
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
    
    // Only clear error if retry was actually successful
    if (success) {
      await pool.query(
        `UPDATE trackman_webhook_events 
         SET processing_error = NULL
         WHERE id = $1`,
        [eventId]
      );
    } else {
      // Update the error message if retry failed
      await pool.query(
        `UPDATE trackman_webhook_events 
         SET processing_error = $2
         WHERE id = $1`,
        [eventId, message]
      );
    }
    
    res.json({ success, message, matchedBookingId });
  } catch (error: any) {
    logger.error('[Trackman Webhook] Failed to retry event', { error });
    res.status(500).json({ error: 'Failed to retry event' });
  }
});

// Cleanup old webhook logs (called by scheduler)
export async function cleanupOldWebhookLogs(): Promise<{ deleted: number }> {
  try {
    const result = await pool.query(
      `DELETE FROM trackman_webhook_events 
       WHERE processed_at < NOW() - INTERVAL '30 days'
       RETURNING id`
    );
    
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

// Manual cleanup endpoint for admins
router.post('/api/admin/trackman-webhook/cleanup', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await cleanupOldWebhookLogs();
    res.json({ success: true, deleted: result.deleted });
  } catch (error: any) {
    logger.error('[Trackman Webhook] Manual cleanup failed', { error });
    res.status(500).json({ error: 'Failed to cleanup logs' });
  }
});

// Dev-only: Manual booking confirmation (simulates Trackman webhook)
router.post('/api/admin/bookings/:id/simulate-confirm', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    // Get the pending booking
    const bookingResult = await pool.query(
      `SELECT br.*, u.stripe_customer_id, u.tier
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
       WHERE br.id = $1`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    
    if (booking.status !== 'pending' && booking.status !== 'pending_approval') {
      return res.status(400).json({ error: `Booking is already ${booking.status}` });
    }

    // Generate a fake Trackman booking ID
    const fakeTrackmanId = `SIM-${Date.now()}`;

    // Update the booking to approved status
    await pool.query(
      `UPDATE booking_requests 
       SET status = 'approved', 
           trackman_booking_id = $1,
           notes = COALESCE(notes, '') || E'\n[Simulated confirmation for testing]',
           updated_at = NOW()
       WHERE id = $2`,
      [fakeTrackmanId, bookingId]
    );

    // Create payment intent for overage fee if applicable
    if (booking.overage_fee_cents > 0 && booking.stripe_customer_id) {
      try {
        const { createPaymentIntent } = await import('../core/stripe/payments');
        const paymentResult = await createPaymentIntent({
          userId: booking.user_id || booking.user_email,
          email: booking.user_email,
          memberName: booking.user_name,
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
        
        if (paymentResult.success) {
          await pool.query(
            `UPDATE booking_requests SET overage_paid = false WHERE id = $1`,
            [bookingId]
          );
          logger.info('[Simulate Confirm] Created overage payment intent', {
            bookingId,
            paymentIntentId: paymentResult.paymentIntentId,
            amount: booking.overage_fee_cents
          });
        }
      } catch (paymentError: any) {
        logger.error('[Simulate Confirm] Failed to create payment intent', { error: paymentError });
      }
    }

    // Send notifications
    try {
      await notifyMember(booking.user_email, {
        title: 'Booking Confirmed',
        body: `Your simulator booking for ${formatDatePacific(booking.request_date)} at ${formatTimePacific(booking.start_time)} has been confirmed.`,
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

    logger.info('[Simulate Confirm] Booking manually confirmed', {
      bookingId,
      userEmail: booking.user_email,
      trackmanId: fakeTrackmanId
    });

    res.json({ 
      success: true, 
      message: 'Booking confirmed (simulated)',
      trackmanId: fakeTrackmanId,
      overageFeeCents: booking.overage_fee_cents
    });
  } catch (error: any) {
    logger.error('[Simulate Confirm] Error', { error });
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});

// Backfill endpoint: Create booking_requests from past trackman_webhook_events
router.post('/api/admin/trackman-webhooks/backfill', isAdmin, async (req, res) => {
  try {
    logger.info('[Trackman Backfill] Starting backfill of past webhook events');
    
    // Get all webhook events that don't have a matched_booking_id
    const unmatchedEvents = await pool.query(`
      SELECT 
        id, trackman_booking_id, payload, created_at
      FROM trackman_webhook_events 
      WHERE matched_booking_id IS NULL 
        AND payload IS NOT NULL
      ORDER BY created_at DESC
    `);
    
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
        
        // Extract booking data from payload (V2 format)
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
        
        // Parse times - handle both ISO and other formats
        const startDate = new Date(startStr.includes('T') ? startStr : startStr.replace(' ', 'T') + 'Z');
        const endDate = new Date(endStr.includes('T') ? endStr : endStr.replace(' ', 'T') + 'Z');
        
        // Convert to Pacific time for date/time strings
        const requestDate = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const startTime = startDate.toLocaleTimeString('en-US', { 
          hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
        }) + ':00';
        const endTime = endDate.toLocaleTimeString('en-US', { 
          hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
        }) + ':00';
        
        // Calculate resource_id from bay ref
        let resourceId: number | null = null;
        if (bayRef) {
          const bayNum = parseInt(bayRef);
          if (bayNum >= 1 && bayNum <= 4) {
            resourceId = bayNum;
          }
        }
        
        // Calculate duration
        const startParts = startTime.split(':').map(Number);
        const endParts = endTime.split(':').map(Number);
        const startMinutes = startParts[0] * 60 + startParts[1];
        const endMinutes = endParts[0] * 60 + endParts[1];
        const durationMinutes = endMinutes > startMinutes ? endMinutes - startMinutes : 60;
        
        // First, check if a booking_request already exists with this trackman_booking_id
        const existingByTrackman = await pool.query(
          `SELECT id FROM booking_requests WHERE trackman_booking_id = $1`,
          [event.trackman_booking_id]
        );
        
        if (existingByTrackman.rows.length > 0) {
          // Already linked
          await pool.query(
            `UPDATE trackman_webhook_events SET matched_booking_id = $1 WHERE id = $2`,
            [existingByTrackman.rows[0].id, event.id]
          );
          results.skipped++;
          results.details.push({ 
            trackmanId: event.trackman_booking_id, 
            status: 'skipped', 
            reason: 'Already has linked booking_request' 
          });
          continue;
        }
        
        // Try to find an existing booking by matching date, time, and bay
        const matchingBooking = await pool.query(`
          SELECT id, user_email, user_name, trackman_booking_id
          FROM booking_requests 
          WHERE request_date = $1 
            AND start_time = $2
            AND (resource_id = $3 OR $3 IS NULL)
            AND trackman_booking_id IS NULL
            AND status NOT IN ('cancelled', 'declined')
          LIMIT 1
        `, [requestDate, startTime, resourceId]);
        
        if (matchingBooking.rows.length > 0) {
          // Found a match - link them together
          const existingBooking = matchingBooking.rows[0];
          
          await pool.query(`
            UPDATE booking_requests 
            SET trackman_booking_id = $1,
                trackman_player_count = $2,
                trackman_external_id = $3,
                is_unmatched = false,
                staff_notes = COALESCE(staff_notes, '') || ' [Linked via backfill]',
                updated_at = NOW()
            WHERE id = $4
          `, [event.trackman_booking_id, playerCount, externalBookingId, existingBooking.id]);
          
          // Update the webhook event with matched_booking_id
          await pool.query(
            `UPDATE trackman_webhook_events SET matched_booking_id = $1 WHERE id = $2`,
            [existingBooking.id, event.id]
          );
          
          results.linked++;
          results.details.push({ 
            trackmanId: event.trackman_booking_id, 
            status: 'linked', 
            bookingId: existingBooking.id,
            member: existingBooking.user_email || existingBooking.user_name
          });
        } else {
          // No match found - create an unmatched booking_request
          const newBooking = await pool.query(`
            INSERT INTO booking_requests 
            (request_date, start_time, end_time, duration_minutes, resource_id,
             user_email, user_name, status, trackman_booking_id, trackman_external_id,
             trackman_player_count, is_unmatched, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, $9, $10, true, NOW(), NOW())
            RETURNING id
          `, [
            requestDate,
            startTime,
            endTime,
            durationMinutes,
            resourceId,
            customerEmail || 'unmatched@trackman.import',
            customerName,
            event.trackman_booking_id,
            externalBookingId || null,
            playerCount
          ]);
          
          if (newBooking.rows.length > 0) {
            // Update the webhook event with matched_booking_id
            await pool.query(
              `UPDATE trackman_webhook_events SET matched_booking_id = $1 WHERE id = $2`,
              [newBooking.rows[0].id, event.id]
            );
            
            results.created++;
            results.details.push({ 
              trackmanId: event.trackman_booking_id, 
              status: 'created', 
              bookingId: newBooking.rows[0].id,
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
    
    // Broadcast to staff that bookings may have been updated
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

export default router;
