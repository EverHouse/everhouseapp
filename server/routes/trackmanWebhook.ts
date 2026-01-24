import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../core/db';
import { logger } from '../core/logger';
import { isStaffOrAdmin, isAdmin } from '../core/middleware';
import { sendNotificationToUser, broadcastToStaff } from '../core/websocket';
import { notifyAllStaff } from '../core/staffNotifications';
import { notifyMember } from '../core/notificationService';
import { formatDatePacific, formatTimePacific } from '../utils/dateUtils';
import { refundGuestPass } from './guestPasses';
import { calculateFullSessionBilling, recalculateSessionFees } from '../core/bookingService/usageCalculator';
import { recordUsage } from '../core/bookingService/sessionManager';
import { getMemberTierByEmail } from '../core/tierService';

const router = Router();

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Calculate duration in minutes between start and end times, handling cross-midnight sessions.
 * If end_time < start_time, it assumes the session spans midnight and adds 24 hours.
 * @param startTime - Time string in HH:MM or HH:MM:SS format
 * @param endTime - Time string in HH:MM or HH:MM:SS format
 * @returns Duration in minutes
 */
function calculateDurationMinutes(startTime: string, endTime: string): number {
  const startParts = startTime.split(':').map(Number);
  const endParts = endTime.split(':').map(Number);
  const startMinutes = startParts[0] * 60 + startParts[1];
  let endMinutes = endParts[0] * 60 + endParts[1];
  
  // Handle equal start/end times - return reasonable default and log warning
  if (endMinutes === startMinutes) {
    logger.warn('[Trackman Webhook] Equal start and end times detected, defaulting to 60 minutes', {
      extra: { startTime, endTime }
    });
    return 60;
  }
  
  // Handle cross-midnight: if end_time < start_time, add 24 hours to end
  if (endMinutes < startMinutes) {
    endMinutes += 24 * 60; // Add 24 hours worth of minutes
  }
  
  return endMinutes - startMinutes;
}

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
      `SELECT id, user_email, user_name, user_id, status as current_status, resource_id, session_id, duration_minutes
       FROM booking_requests 
       WHERE calendar_event_id = $1
         OR id::text = $1
       LIMIT 1`,
      [externalBookingId]
    );
    
    if (result.rows.length === 0) {
      // Try matching by UUID pattern in staff_notes (for pending trackman sync)
      const pendingResult = await pool.query(
        `SELECT id, user_email, user_name, user_id, status as current_status, resource_id, session_id, duration_minutes
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
    
    // Calculate duration (handles cross-midnight sessions)
    const durationMinutes = calculateDurationMinutes(startTime, endTime);
    
    // Check if times/duration changed before updating
    const originalDuration = booking.duration_minutes;
    const timeChanged = originalDuration !== durationMinutes;
    
    // Update booking with Trackman info and sync tracking
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
           last_sync_source = 'trackman_webhook',
           last_trackman_sync_at = NOW(),
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
    
    // Recalculate fees if times changed
    if (timeChanged && booking.session_id) {
      try {
        await pool.query(
          'UPDATE booking_sessions SET start_time = $1, end_time = $2 WHERE id = $3',
          [startTime, endTime, booking.session_id]
        );
        await recalculateSessionFees(booking.session_id);
        logger.info('[Trackman Webhook] Recalculated fees after externalBookingId link', {
          extra: { bookingId, sessionId: booking.session_id, originalDuration, newDuration: durationMinutes }
        });
      } catch (recalcErr) {
        logger.warn('[Trackman Webhook] Failed to recalculate fees for externalBookingId link', { 
          extra: { bookingId, error: recalcErr } 
        });
      }
    }
    
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
    
    // DEDUPLICATION: Check for duplicate events within 2 minutes
    // Trackman sometimes sends the same webhook multiple times in quick succession
    // Use a shorter window (2 min) to avoid blocking legitimate updates
    // Compare key fields from both V1 (start_time/end_time) and V2 (start/end) payloads
    if (trackmanBookingId) {
      // Extract key fields from payload for comparison (support both V1 and V2 formats)
      const bookingData = payload?.data || payload?.booking || {};
      // V2 uses 'start'/'end', V1 uses 'start_time'/'end_time'
      const startTime = bookingData?.start || bookingData?.start_time || payload?.start_time || '';
      const endTime = bookingData?.end || bookingData?.end_time || payload?.end_time || '';
      const status = bookingData?.status || payload?.status || eventType;
      
      const recentDupe = await pool.query(
        `SELECT id, payload FROM trackman_webhook_events 
         WHERE trackman_booking_id = $1 
           AND event_type = $2
           AND created_at >= NOW() - INTERVAL '2 minutes'
         ORDER BY created_at DESC
         LIMIT 1`,
        [trackmanBookingId, eventType]
      );
      
      if (recentDupe.rows.length > 0) {
        // Compare key fields to determine if truly duplicate
        const existingPayload = typeof recentDupe.rows[0].payload === 'string' 
          ? JSON.parse(recentDupe.rows[0].payload) 
          : recentDupe.rows[0].payload;
        const existingBookingData = existingPayload?.data || existingPayload?.booking || {};
        // Support both V1 and V2 formats for existing payload too
        const existingStart = existingBookingData?.start || existingBookingData?.start_time || existingPayload?.start_time || '';
        const existingEnd = existingBookingData?.end || existingBookingData?.end_time || existingPayload?.end_time || '';
        const existingStatus = existingBookingData?.status || existingPayload?.status || '';
        
        // Only skip if start, end, and status are identical (both non-empty)
        const fieldsMatch = startTime === existingStart && endTime === existingEnd && status === existingStatus;
        const hasValidFields = startTime !== '' || endTime !== ''; // At least one time field must exist
        
        if (fieldsMatch && hasValidFields) {
          logger.info('[Trackman Webhook] Skipping duplicate event', {
            extra: { trackmanBookingId, eventType, existingId: recentDupe.rows[0].id }
          });
          return recentDupe.rows[0].id; // Return existing event ID
        }
      }
    }
    
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
           last_sync_source = 'trackman_webhook',
           last_trackman_sync_at = NOW(),
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
           last_sync_source = 'trackman_webhook',
           last_trackman_sync_at = NOW(),
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
      `SELECT id, duration_minutes, session_id, start_time, end_time FROM booking_requests WHERE trackman_booking_id = $1`,
      [trackmanBookingId]
    );
    
    if (existing.rows.length > 0) {
      const existingBooking = existing.rows[0];
      
      // Calculate new duration from the webhook payload (handles cross-midnight sessions)
      const newDurationMinutes = calculateDurationMinutes(startTime, endTime);
      
      // Check if duration changed significantly (>5 min tolerance to avoid noise)
      const oldDuration = existingBooking.duration_minutes || 60;
      if (Math.abs(oldDuration - newDurationMinutes) > 5) {
        logger.info('[Trackman Webhook] Duration changed for existing booking, updating billing...', { 
          extra: { trackmanBookingId, oldDuration, newDuration: newDurationMinutes, bookingId: existingBooking.id } 
        });
        
        // Update booking request with new end time and duration
        await pool.query(
          `UPDATE booking_requests 
           SET end_time = $1, duration_minutes = $2, updated_at = NOW() 
           WHERE id = $3`,
          [endTime, newDurationMinutes, existingBooking.id]
        );
        
        // Update session and recalculate fees if session exists
        if (existingBooking.session_id) {
          await pool.query(
            `UPDATE booking_sessions SET end_time = $1 WHERE id = $2`,
            [endTime, existingBooking.session_id]
          );
          
          // Recalculate session fees for the extended duration
          try {
            const { recalculateSessionFees } = await import('../core/bookingService/usageCalculator');
            const recalcResult = await recalculateSessionFees(existingBooking.session_id);
            logger.info('[Trackman Webhook] Session fees recalculated for extension', {
              extra: { sessionId: existingBooking.session_id, newDuration: newDurationMinutes, totalFees: recalcResult.billingResult.totalFees }
            });
            
            // Calculate DELTA billing: only charge the difference between new total and previously billed amounts
            // This prevents double-billing on session extensions
            if (recalcResult.billingResult.totalFees > 0) {
              try {
                // Query for previously billed/paid amounts for this session from stripe_payment_intents
                const previousBilledResult = await pool.query(
                  `SELECT COALESCE(SUM(amount_cents), 0) as total_billed_cents
                   FROM stripe_payment_intents
                   WHERE session_id = $1
                     AND status IN ('succeeded', 'pending', 'processing', 'requires_capture')
                     AND purpose IN ('overage_fee', 'session_fee')`,
                  [existingBooking.session_id]
                );
                
                const previouslyBilledCents = parseInt(previousBilledResult.rows[0]?.total_billed_cents || '0', 10);
                const newTotalFeeCents = Math.round(recalcResult.billingResult.totalFees * 100);
                const deltaFeeCents = newTotalFeeCents - previouslyBilledCents;
                
                logger.info('[Trackman Webhook] Delta billing calculation for extension', {
                  extra: {
                    sessionId: existingBooking.session_id,
                    bookingId: existingBooking.id,
                    newTotalFeeCents,
                    previouslyBilledCents,
                    deltaFeeCents,
                    extensionMinutes: newDurationMinutes - oldDuration
                  }
                });
                
                // Explicit delta guard: Only create payment intent if there's a strictly positive delta to charge
                if (deltaFeeCents <= 0) {
                  logger.info('[Trackman Webhook] Skipping payment intent creation - delta is not positive', {
                    extra: {
                      sessionId: existingBooking.session_id,
                      bookingId: existingBooking.id,
                      deltaFeeCents,
                      previouslyBilledCents,
                      newTotalFeeCents,
                      reason: deltaFeeCents === 0 ? 'zero_delta' : 'negative_delta'
                    }
                  });
                } else {
                  // deltaFeeCents > 0: Proceed to create payment intent
                  // Idempotency check: Prevent duplicate charges from webhook retries
                  // Look for a recent payment intent for this session with this extension source
                  const existingPaymentCheck = await pool.query(
                    `SELECT id, stripe_payment_intent_id, status, amount_cents
                     FROM stripe_payment_intents
                     WHERE session_id = $1
                       AND purpose = 'overage_fee'
                       AND description LIKE '%extension%'
                       AND created_at > NOW() - INTERVAL '5 minutes'
                       AND status NOT IN ('failed', 'canceled')
                     ORDER BY created_at DESC
                     LIMIT 1`,
                    [existingBooking.session_id]
                  );
                  
                  if (existingPaymentCheck.rows.length > 0) {
                    const recentPayment = existingPaymentCheck.rows[0];
                    logger.info('[Trackman Webhook] Duplicate webhook detected - payment intent already exists for this extension', {
                      extra: {
                        sessionId: existingBooking.session_id,
                        existingPaymentIntentId: recentPayment.stripe_payment_intent_id,
                        existingAmountCents: recentPayment.amount_cents,
                        requestedDeltaCents: deltaFeeCents
                      }
                    });
                  } else {
                    // Get the member email and Stripe customer ID from the booking
                    const memberResult = await pool.query(
                      `SELECT br.user_email, br.user_id, u.stripe_customer_id, u.first_name, u.last_name
                       FROM booking_requests br
                       LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
                       WHERE br.id = $1`,
                      [existingBooking.id]
                    );
                    
                    if (memberResult.rows.length > 0) {
                      const memberData = memberResult.rows[0];
                      const memberEmail = memberData.user_email;
                      const stripeCustomerId = memberData.stripe_customer_id;
                      const memberName = [memberData.first_name, memberData.last_name].filter(Boolean).join(' ') || memberEmail.split('@')[0];
                      
                      if (stripeCustomerId) {
                        const { createPaymentIntent } = await import('../core/stripe/payments');
                        
                        const paymentResult = await createPaymentIntent({
                          userId: memberData.user_id || memberEmail,
                          email: memberEmail,
                          memberName: memberName,
                          amountCents: deltaFeeCents,
                          purpose: 'overage_fee',
                          bookingId: existingBooking.id,
                          sessionId: existingBooking.session_id,
                          description: `Simulator extension overage fee - ${newDurationMinutes - oldDuration} additional minutes (delta: $${(deltaFeeCents / 100).toFixed(2)})`,
                          stripeCustomerId: stripeCustomerId,
                          metadata: {
                            bookingId: existingBooking.id.toString(),
                            sessionId: existingBooking.session_id.toString(),
                            extensionMinutes: (newDurationMinutes - oldDuration).toString(),
                            previouslyBilledCents: previouslyBilledCents.toString(),
                            newTotalCents: newTotalFeeCents.toString(),
                            deltaCents: deltaFeeCents.toString(),
                            source: 'trackman_extension_webhook'
                          }
                        });
                        
                        // Update ledger entries to link payment intent and mark as pending
                        // This links the ledger rows to the payment intent for proper tracking
                        await pool.query(
                          `UPDATE usage_ledger 
                           SET stripe_payment_intent_id = $1,
                               payment_method = 'pending'
                           WHERE session_id = $2 
                             AND payment_method IN ('pending', 'unpaid')
                             AND stripe_payment_intent_id IS NULL
                             AND (overage_fee > 0 OR guest_fee > 0)`,
                          [paymentResult.paymentIntentId, existingBooking.session_id]
                        );
                        
                        logger.info('[Trackman Webhook] Created payment intent for extension delta', {
                          extra: {
                            sessionId: existingBooking.session_id,
                            bookingId: existingBooking.id,
                            paymentIntentId: paymentResult.paymentIntentId,
                            deltaAmountCents: deltaFeeCents,
                            previouslyBilledCents,
                            newTotalCents: newTotalFeeCents,
                            memberEmail: memberEmail
                          }
                        });
                      } else {
                        logger.warn('[Trackman Webhook] Member has no Stripe customer ID, cannot charge for extension', {
                          extra: { memberEmail, bookingId: existingBooking.id }
                        });
                      }
                    }
                  }
                }
              } catch (paymentError) {
                // Log but don't fail the webhook - the fees are recorded in ledger as unpaid
                logger.error('[Trackman Webhook] Failed to create payment intent for extension (non-blocking)', {
                  error: paymentError as Error,
                  extra: { sessionId: existingBooking.session_id, bookingId: existingBooking.id }
                });
              }
            }
          } catch (feeError) {
            logger.error('[Trackman Webhook] Failed to recalculate fees for extension', {
              error: feeError as Error,
              extra: { sessionId: existingBooking.session_id }
            });
          }
        }
        
        return { success: true, bookingId: existingBooking.id, updated: true };
      }
      
      logger.info('[Trackman Webhook] Booking already exists and duration unchanged, skipping', { 
        extra: { trackmanBookingId, existingBookingId: existingBooking.id, duration: oldDuration } 
      });
      return { success: true, bookingId: existingBooking.id };
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
             last_sync_source = 'trackman_webhook',
             last_trackman_sync_at = NOW(),
             updated_at = NOW()
         WHERE id = $7`,
        [trackmanBookingId, playerCount, updatedNotes, startTime, endTime, newDurationMinutes, pendingBookingId]
      );
      
      // Recalculate fees if duration/times changed
      if (wasTimeTolerance) {
        const sessionCheck = await pool.query(
          'SELECT session_id FROM booking_requests WHERE id = $1',
          [pendingBookingId]
        );
        if (sessionCheck.rows[0]?.session_id) {
          try {
            // Update session times first
            await pool.query(
              'UPDATE booking_sessions SET start_time = $1, end_time = $2 WHERE id = $3',
              [startTime, endTime, sessionCheck.rows[0].session_id]
            );
            // Recalculate fees
            await recalculateSessionFees(sessionCheck.rows[0].session_id);
            logger.info('[Trackman Webhook] Recalculated fees after time change', {
              extra: { bookingId: pendingBookingId, sessionId: sessionCheck.rows[0].session_id }
            });
          } catch (recalcErr) {
            logger.warn('[Trackman Webhook] Failed to recalculate fees', { extra: { bookingId: pendingBookingId, error: recalcErr } });
          }
        }
      }
      
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
    
    // Calculate duration (handles cross-midnight sessions)
    const durationMinutes = calculateDurationMinutes(startTime, endTime);
    
    const memberName = customerName || 
      [member.firstName, member.lastName].filter(Boolean).join(' ') || 
      member.email;
    
    const result = await pool.query(
      `INSERT INTO booking_requests 
       (user_id, user_email, user_name, resource_id, request_date, start_time, end_time, 
        duration_minutes, status, trackman_booking_id, trackman_player_count, 
        reviewed_by, reviewed_at, staff_notes, was_auto_linked, 
        origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved', $9, $10, 'trackman_webhook', NOW(), 
               '[Auto-created via Trackman webhook - staff booking]', true,
               'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
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
      
      // Create billing session for this Trackman booking WITH usage tracking
      try {
        const sessionResult = await pool.query(`
          INSERT INTO booking_sessions (resource_id, session_date, start_time, end_time, trackman_booking_id, source, created_by)
          VALUES ($1, $2, $3, $4, $5, 'trackman', 'trackman_webhook')
          RETURNING id
        `, [resourceId, slotDate, startTime, endTime, trackmanBookingId]);
        
        if (sessionResult.rows.length > 0) {
          const sessionId = sessionResult.rows[0].id;
          await pool.query(`UPDATE booking_requests SET session_id = $1 WHERE id = $2`, [sessionId, bookingId]);
          
          // Calculate and record billing for this Trackman booking
          try {
            const ownerTier = await getMemberTierByEmail(member.email, { allowInactive: true });
            
            // Build participants array - owner + guests
            const participants = [
              { email: member.email, participantType: 'owner' as const, displayName: memberName }
            ];
            
            // Add guest slots based on playerCount
            for (let i = 1; i < playerCount; i++) {
              participants.push({
                email: undefined as any,
                participantType: 'guest' as const,
                displayName: `Guest ${i + 1}`
              });
            }
            
            // Calculate fees using the billing engine
            const billingResult = await calculateFullSessionBilling(
              slotDate,
              durationMinutes,
              participants,
              member.email
            );
            
            // Record usage ledger entries
            for (const billing of billingResult.billingBreakdown) {
              if (billing.participantType === 'guest') {
                if (billing.guestFee > 0) {
                  await recordUsage(sessionId, {
                    memberId: member.email,
                    minutesCharged: 0,
                    overageFee: 0,
                    guestFee: billing.guestFee,
                    tierAtBooking: ownerTier || undefined,
                    paymentMethod: 'unpaid'
                  }, 'trackman_webhook');
                }
              } else {
                await recordUsage(sessionId, {
                  memberId: billing.email || member.email,
                  minutesCharged: billing.minutesAllocated,
                  overageFee: billing.overageFee,
                  guestFee: 0,
                  tierAtBooking: billing.tierName || ownerTier || undefined,
                  paymentMethod: 'unpaid'
                }, 'trackman_webhook');
              }
            }
            
            logger.info('[Trackman Webhook] Billing calculated for Trackman booking', {
              extra: {
                bookingId,
                sessionId,
                totalOverageFees: billingResult.totalOverageFees,
                totalGuestFees: billingResult.totalGuestFees,
                playerCount
              }
            });
          } catch (billingErr) {
            logger.warn('[Trackman Webhook] Failed to calculate billing (session created)', { 
              extra: { bookingId, sessionId, error: billingErr } 
            });
          }
        }
      } catch (sessionErr) {
        logger.warn('[Trackman Webhook] Failed to create billing session', { extra: { bookingId, error: sessionErr } });
      }
      
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
    // Calculate duration (handles cross-midnight sessions)
    const durationMinutes = calculateDurationMinutes(startTime, endTime);
    
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
    // DEDUPLICATION: Check if a booking with this trackman_booking_id already exists
    const existingBooking = await pool.query(
      `SELECT id FROM booking_requests WHERE trackman_booking_id = $1 LIMIT 1`,
      [trackmanBookingId]
    );
    
    if (existingBooking.rows.length > 0) {
      // Booking already exists, return the existing ID without creating a duplicate
      logger.info('[Trackman Webhook] Booking already exists for trackman_booking_id, skipping duplicate', {
        extra: { trackmanBookingId, existingBookingId: existingBooking.rows[0].id }
      });
      return { created: false, bookingId: existingBooking.rows[0].id };
    }
    
    // Calculate duration (handles cross-midnight sessions)
    const durationMinutes = calculateDurationMinutes(startTime, endTime);
    
    const result = await pool.query(
      `INSERT INTO booking_requests 
       (request_date, start_time, end_time, duration_minutes, resource_id,
        user_email, user_name, status, trackman_booking_id, trackman_external_id,
        trackman_customer_notes, is_unmatched, 
        origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, $9, $10, true,
               'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
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
      
      // Create billing session for this unmatched Trackman booking
      try {
        const sessionResult = await pool.query(`
          INSERT INTO booking_sessions (resource_id, session_date, start_time, end_time, trackman_booking_id, source, created_by)
          VALUES ($1, $2, $3, $4, $5, 'trackman', 'trackman_webhook')
          RETURNING id
        `, [resourceId, slotDate, startTime, endTime, trackmanBookingId]);
        
        if (sessionResult.rows.length > 0) {
          await pool.query(`UPDATE booking_requests SET session_id = $1 WHERE id = $2`, [sessionResult.rows[0].id, bookingId]);
        }
      } catch (sessionErr) {
        logger.warn('[Trackman Webhook] Failed to create billing session for unmatched booking', { extra: { bookingId, error: sessionErr } });
      }
      
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
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NULL OR (twe.matched_booking_id IS NOT NULL AND br.is_unmatched = true)) as needs_linking,
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

// Auto-match an unlinked webhook event to existing booking_requests by bay + date + time overlap
router.post('/api/admin/trackman-webhook/:eventId/auto-match', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const eventId = parseInt(req.params.eventId);
    
    if (isNaN(eventId)) {
      return res.status(400).json({ error: 'Invalid event ID' });
    }
    
    // Fetch the webhook event
    const eventResult = await pool.query(
      `SELECT id, event_type, payload, trackman_booking_id, matched_booking_id
       FROM trackman_webhook_events 
       WHERE id = $1`,
      [eventId]
    );
    
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = eventResult.rows[0];
    
    // Check if already matched
    if (event.matched_booking_id) {
      // Check if the matched booking is actually linked to a member (not unmatched)
      const matchedBooking = await pool.query(
        `SELECT id, user_email, is_unmatched FROM booking_requests WHERE id = $1`,
        [event.matched_booking_id]
      );
      
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
    
    // Validate trackman_booking_id exists
    if (!trackmanBookingId) {
      return res.status(400).json({ error: 'Event has no Trackman booking ID to link' });
    }
    
    // Extract booking data from payload
    const bookingData = payload?.data || payload?.booking || {};
    const bookingStart = bookingData?.start;
    const bookingEnd = bookingData?.end;
    
    if (!bookingStart) {
      return res.status(400).json({ error: 'Cannot determine booking date/time from event' });
    }
    
    // Parse the booking time
    const startDate = new Date(bookingStart);
    const endDate = bookingEnd ? new Date(bookingEnd) : startDate;
    
    // Get Pacific date and times
    const pacificDate = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const pacificStartTime = startDate.toLocaleTimeString('en-US', { 
      timeZone: 'America/Los_Angeles', 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    const pacificEndTime = endDate.toLocaleTimeString('en-US', { 
      timeZone: 'America/Los_Angeles', 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    // Determine bay/resource from payload
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
      extra: { eventId, trackmanBookingId, date: pacificDate, start: pacificStartTime, end: pacificEndTime, bay: resourceId }
    });
    
    // Search for matching pending booking requests by bay + date + time overlap
    // Allow 30 minute tolerance for start time
    const matchResult = await pool.query(
      `SELECT 
        id, user_email, status, start_time, end_time, request_date, resource_id,
        (SELECT CONCAT(first_name, ' ', last_name) FROM users WHERE LOWER(email) = LOWER(br.user_email) LIMIT 1) as member_name
       FROM booking_requests br
       WHERE resource_id = $1
         AND request_date = $2
         AND trackman_booking_id IS NULL
         AND status = 'pending'
         AND ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 1800
       ORDER BY ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) ASC
       LIMIT 5`,
      [resourceId, pacificDate, pacificStartTime]
    );
    
    if (matchResult.rows.length === 0) {
      // Also try to find approved bookings without trackman_booking_id
      const approvedMatchResult = await pool.query(
        `SELECT 
          id, user_email, status, start_time, end_time, request_date, resource_id,
          (SELECT CONCAT(first_name, ' ', last_name) FROM users WHERE LOWER(email) = LOWER(br.user_email) LIMIT 1) as member_name
         FROM booking_requests br
         WHERE resource_id = $1
           AND request_date = $2
           AND trackman_booking_id IS NULL
           AND status = 'approved'
           AND ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 1800
         ORDER BY ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) ASC
         LIMIT 5`,
        [resourceId, pacificDate, pacificStartTime]
      );
      
      if (approvedMatchResult.rows.length === 0) {
        return res.json({
          success: false,
          message: 'No matching booking requests found for this bay, date, and time',
          searched: { date: pacificDate, startTime: pacificStartTime, bay: resourceId }
        });
      }
      
      // Found an approved booking match
      const match = approvedMatchResult.rows[0];
      
      // Link the trackman booking ID to the existing booking with race condition guard
      const updateResult = await pool.query(
        `UPDATE booking_requests 
         SET trackman_booking_id = $1,
             last_sync_source = 'staff_auto_match',
             last_trackman_sync_at = NOW(),
             was_auto_linked = true,
             staff_notes = COALESCE(staff_notes, '') || ' [Linked via Auto-Match]',
             updated_at = NOW()
         WHERE id = $2 AND trackman_booking_id IS NULL
         RETURNING id`,
        [trackmanBookingId, match.id]
      );
      
      if (updateResult.rowCount === 0) {
        return res.json({
          success: false,
          message: 'Booking was already linked by another process',
          conflict: true
        });
      }
      
      // Update the webhook event to reference this booking with race condition guard
      await pool.query(
        `UPDATE trackman_webhook_events 
         SET matched_booking_id = $1
         WHERE id = $2 AND (matched_booking_id IS NULL OR matched_booking_id = $3)`,
        [match.id, eventId, event.matched_booking_id]
      );
      
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
    
    // Found a pending booking match - approve it
    const match = matchResult.rows[0];
    
    // Auto-approve the pending request and link the trackman booking ID with race condition guard
    const pendingUpdateResult = await pool.query(
      `UPDATE booking_requests 
       SET status = 'approved',
           trackman_booking_id = $1,
           reviewed_at = NOW(),
           reviewed_by = 'staff_auto_match',
           last_sync_source = 'staff_auto_match',
           last_trackman_sync_at = NOW(),
           was_auto_linked = true,
           staff_notes = COALESCE(staff_notes, '') || ' [Auto-approved via Staff Auto-Match]',
           updated_at = NOW()
       WHERE id = $2 AND trackman_booking_id IS NULL AND status = 'pending'
       RETURNING id`,
      [trackmanBookingId, match.id]
    );
    
    if (pendingUpdateResult.rowCount === 0) {
      return res.json({
        success: false,
        message: 'Booking was already linked or approved by another process',
        conflict: true
      });
    }
    
    // Update the webhook event to reference this booking with race condition guard
    await pool.query(
      `UPDATE trackman_webhook_events 
       SET matched_booking_id = $1
       WHERE id = $2 AND (matched_booking_id IS NULL OR matched_booking_id = $3)`,
      [match.id, eventId, event.matched_booking_id]
    );
    
    // Notify member their booking is confirmed
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
        
        // Calculate duration (handles cross-midnight sessions)
        const durationMinutes = calculateDurationMinutes(startTime, endTime);
        
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
                last_sync_source = 'trackman_webhook',
                last_trackman_sync_at = NOW(),
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
             trackman_player_count, is_unmatched, 
             origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, $9, $10, true,
                    'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
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
            const bookingId = newBooking.rows[0].id;
            
            // Update the webhook event with matched_booking_id
            await pool.query(
              `UPDATE trackman_webhook_events SET matched_booking_id = $1 WHERE id = $2`,
              [bookingId, event.id]
            );
            
            // Create billing session for this reprocessed Trackman booking
            try {
              const sessionResult = await pool.query(`
                INSERT INTO booking_sessions (resource_id, session_date, start_time, end_time, trackman_booking_id, source, created_by)
                VALUES ($1, $2, $3, $4, $5, 'trackman', 'trackman_reprocess')
                RETURNING id
              `, [resourceId, requestDate, startTime, endTime, event.trackman_booking_id]);
              
              if (sessionResult.rows.length > 0) {
                await pool.query(`UPDATE booking_requests SET session_id = $1 WHERE id = $2`, [sessionResult.rows[0].id, bookingId]);
              }
            } catch (sessionErr) {
              // Non-fatal: continue even if billing session creation fails
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
