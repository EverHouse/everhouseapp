import crypto from 'crypto';
import { Request } from 'express';
import { logger } from '../../core/logger';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { isProduction, redactPII, TrackmanWebhookPayload, TrackmanBookingPayload } from './webhook-helpers';

interface WebhookEventIdRow {
  id: number;
  payload?: unknown;
}

interface EmailLookupRow {
  primary_email?: string;
  email?: string;
}

interface MemberRow {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
}

export function validateTrackmanWebhookSignature(req: Request): boolean {
  const webhookSecret = process.env.TRACKMAN_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    if (isProduction) {
      logger.error('[Trackman Webhook] No TRACKMAN_WEBHOOK_SECRET configured in production — rejecting request for security');
      return false;
    }
    logger.info('[Trackman Webhook] No TRACKMAN_WEBHOOK_SECRET configured - allowing request (development mode)');
    return true;
  }
  
  const signature = req.headers['x-trackman-signature'] || 
                    req.headers['x-webhook-signature'] ||
                    req.headers['x-signature'];
  
  if (!signature) {
    logger.warn('[Trackman Webhook] No signature header found');
    return !isProduction;
  }
  
  const rawBody = (req as Request & { rawBody?: string }).rawBody;
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
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Signature validation error', { error: e as Error });
    return !isProduction;
  }
}

export async function logWebhookEvent(
  eventType: string,
  payload: TrackmanWebhookPayload,
  trackmanBookingId?: string,
  trackmanUserId?: string,
  matchedBookingId?: number,
  matchedUserId?: string,
  error?: string
): Promise<number> {
  try {
    const redactedPayload = redactPII(payload);
    
    if (trackmanBookingId) {
      const bookingData = payload?.data || payload?.booking || {};
      const bd = bookingData as unknown as TrackmanBookingPayload;
      const startTime = (bd?.startTime as string) || (bd?.start_time as string) || (payload.start_time as string) || '';
      const endTime = (bd?.endTime as string) || (bd?.end_time as string) || (payload.end_time as string) || '';
      const status = (bd?.status as string) || (payload.status as string) || eventType;
      
      const recentDupe = await db.execute(sql`SELECT id, payload FROM trackman_webhook_events 
         WHERE trackman_booking_id = ${trackmanBookingId} 
           AND event_type = ${eventType}
           AND created_at >= NOW() - INTERVAL '2 minutes'
         ORDER BY created_at DESC
         LIMIT 1`);
      
      if (recentDupe.rows.length > 0) {
        let existingPayload: Record<string, unknown> = {};
        try {
          existingPayload = typeof recentDupe.rows[0].payload === 'string' 
            ? JSON.parse(recentDupe.rows[0].payload) 
            : recentDupe.rows[0].payload;
        } catch { existingPayload = {}; }
        const existingBookingData = (existingPayload?.data || existingPayload?.booking || {}) as Record<string, unknown>;
        const existingStart = existingBookingData?.start || existingBookingData?.start_time || existingPayload?.start_time || '';
        const existingEnd = existingBookingData?.end || existingBookingData?.end_time || existingPayload?.end_time || '';
        const existingStatus = existingBookingData?.status || existingPayload?.status || '';
        
        const fieldsMatch = startTime === existingStart && endTime === existingEnd && status === existingStatus;
        const hasValidFields = startTime !== '' || endTime !== '';
        
        if (fieldsMatch && hasValidFields) {
          logger.info('[Trackman Webhook] Skipping duplicate event', {
            extra: { trackmanBookingId, eventType, existingId: recentDupe.rows[0].id }
          });
          return (recentDupe.rows[0] as unknown as WebhookEventIdRow).id;
        }
      }
    }
    
    const sigParts: string[] = [];
    const v2Booking = payload.booking as unknown as TrackmanBookingPayload | undefined;
    const v1Data = payload.data as unknown as TrackmanBookingPayload | undefined;
    if (v2Booking?.startTime || v2Booking?.start_time) {
      const start = v2Booking.startTime || v2Booking.start_time;
      const end = v2Booking.endTime || v2Booking.end_time;
      if (start) sigParts.push(`s:${start}`);
      if (end) sigParts.push(`e:${end}`);
      if (v2Booking.bay_id || v2Booking.bayId) sigParts.push(`b:${v2Booking.bay_id || v2Booking.bayId}`);
      if (v2Booking.status) sigParts.push(`st:${v2Booking.status}`);
    } else if (v1Data) {
      if (v1Data.start_time) sigParts.push(`s:${v1Data.start_time}`);
      if (v1Data.end_time) sigParts.push(`e:${v1Data.end_time}`);
      if (v1Data.bay_name || v1Data.bay_id || v1Data.bay_serial) sigParts.push(`b:${v1Data.bay_name || v1Data.bay_id || v1Data.bay_serial}`);
      if (v1Data.status) sigParts.push(`st:${v1Data.status}`);
    }
    const contentSig = sigParts.length > 0 ? sigParts.join('|') : null;
    const dedupKey = trackmanBookingId
      ? contentSig
        ? `${trackmanBookingId}_${eventType.toLowerCase()}_${contentSig}`
        : `${trackmanBookingId}_${eventType.toLowerCase()}`
      : null;
    
    const result = dedupKey
      ? await db.execute(sql`INSERT INTO trackman_webhook_events 
         (event_type, payload, trackman_booking_id, trackman_user_id, matched_booking_id, matched_user_id, processed_at, processing_error, dedup_key)
         VALUES (${eventType}, ${JSON.stringify(redactedPayload)}, ${trackmanBookingId ?? null}, ${trackmanUserId ?? null}, ${matchedBookingId ?? null}, ${matchedUserId ?? null}, NOW(), ${error ?? null}, ${dedupKey})
         ON CONFLICT (dedup_key) DO NOTHING
         RETURNING id`)
      : await db.execute(sql`INSERT INTO trackman_webhook_events 
         (event_type, payload, trackman_booking_id, trackman_user_id, matched_booking_id, matched_user_id, processed_at, processing_error, dedup_key)
         VALUES (${eventType}, ${JSON.stringify(redactedPayload)}, ${trackmanBookingId ?? null}, ${trackmanUserId ?? null}, ${matchedBookingId ?? null}, ${matchedUserId ?? null}, NOW(), ${error ?? null}, ${dedupKey})
         RETURNING id`);
    return (result.rows[0] as unknown as WebhookEventIdRow)?.id as number ?? 0;
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to log webhook event', { error: e as Error });
    return 0;
  }
}

export async function resolveLinkedEmail(email: string): Promise<string> {
  try {
    const linkResult = await db.execute(sql`SELECT primary_email FROM user_linked_emails WHERE LOWER(linked_email) = LOWER(${email}) LIMIT 1`);
    
    if (linkResult.rows.length > 0) {
      return (linkResult.rows[0] as unknown as EmailLookupRow).primary_email as string;
    }
    
    const manualLinkResult = await db.execute(sql`SELECT email FROM users 
       WHERE manually_linked_emails @> to_jsonb(${email.toLowerCase()}::text)
       LIMIT 1`);
    
    if (manualLinkResult.rows.length > 0) {
      return (manualLinkResult.rows[0] as unknown as EmailLookupRow).email as string;
    }
    
    const trackmanEmailResult = await db.execute(sql`SELECT email FROM users WHERE LOWER(trackman_email) = LOWER(${email}) LIMIT 1`);
    
    if (trackmanEmailResult.rows.length > 0) {
      return (trackmanEmailResult.rows[0] as unknown as EmailLookupRow).email as string;
    }
    
    return email;
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to resolve linked email', { error: e as Error });
    return email;
  }
}

export async function findMemberByEmail(email: string): Promise<{
  id: number;
  email: string;
  firstName?: string;
  lastName?: string;
} | null> {
  try {
    const result = await db.execute(sql`SELECT id, email, first_name, last_name FROM users 
       WHERE LOWER(email) = LOWER(${email}) 
         AND (membership_status IS NOT NULL OR role = 'visitor')
       LIMIT 1`);
    
    if (result.rows.length > 0) {
      const row = result.rows[0] as unknown as MemberRow;
      return {
        id: row.id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
      };
    }
    
    return null;
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to find member by email', { error: e as Error });
    return null;
  }
}
