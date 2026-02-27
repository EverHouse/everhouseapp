import crypto from 'crypto';
import { Request } from 'express';
import { logger } from '../../core/logger';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { isProduction, redactPII } from './webhook-helpers';

export function validateTrackmanWebhookSignature(req: Request): boolean {
  const webhookSecret = process.env.TRACKMAN_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
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
  payload: Record<string, unknown>,
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
      const startTime = (bookingData as any)?.start || (bookingData as any)?.start_time || (payload as any)?.start_time || '';
      const endTime = (bookingData as any)?.end || (bookingData as any)?.end_time || (payload as any)?.end_time || '';
      const status = (bookingData as any)?.status || (payload as any)?.status || eventType;
      
      const recentDupe = await db.execute(sql`SELECT id, payload FROM trackman_webhook_events 
         WHERE trackman_booking_id = ${trackmanBookingId} 
           AND event_type = ${eventType}
           AND created_at >= NOW() - INTERVAL '2 minutes'
         ORDER BY created_at DESC
         LIMIT 1`);
      
      if (recentDupe.rows.length > 0) {
        const existingPayload = typeof recentDupe.rows[0].payload === 'string' 
          ? JSON.parse(recentDupe.rows[0].payload) 
          : recentDupe.rows[0].payload;
        const existingBookingData = existingPayload?.data || existingPayload?.booking || {};
        const existingStart = existingBookingData?.start || existingBookingData?.start_time || existingPayload?.start_time || '';
        const existingEnd = existingBookingData?.end || existingBookingData?.end_time || existingPayload?.end_time || '';
        const existingStatus = existingBookingData?.status || existingPayload?.status || '';
        
        const fieldsMatch = startTime === existingStart && endTime === existingEnd && status === existingStatus;
        const hasValidFields = startTime !== '' || endTime !== '';
        
        if (fieldsMatch && hasValidFields) {
          logger.info('[Trackman Webhook] Skipping duplicate event', {
            extra: { trackmanBookingId, eventType, existingId: recentDupe.rows[0].id }
          });
          return recentDupe.rows[0].id;
        }
      }
    }
    
    const sigParts: string[] = [];
    const v2Booking = (payload as any)?.booking;
    const v1Data = (payload as any)?.data;
    if (v2Booking?.start) {
      if (v2Booking.start) sigParts.push(`s:${v2Booking.start}`);
      if (v2Booking.end) sigParts.push(`e:${v2Booking.end}`);
      if (v2Booking.bay?.ref) sigParts.push(`b:${v2Booking.bay.ref}`);
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
    
    const result = await db.execute(sql`INSERT INTO trackman_webhook_events 
       (event_type, payload, trackman_booking_id, trackman_user_id, matched_booking_id, matched_user_id, processed_at, processing_error, dedup_key)
       VALUES (${eventType}, ${JSON.stringify(redactedPayload)}, ${trackmanBookingId ?? null}, ${trackmanUserId ?? null}, ${matchedBookingId ?? null}, ${matchedUserId ?? null}, NOW(), ${error ?? null}, ${dedupKey})
       RETURNING id`);
    return result.rows[0]?.id;
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to log webhook event', { error: e as Error });
    return 0;
  }
}

export async function resolveLinkedEmail(email: string): Promise<string> {
  try {
    const linkResult = await db.execute(sql`SELECT primary_email FROM user_linked_emails WHERE LOWER(linked_email) = LOWER(${email}) LIMIT 1`);
    
    if (linkResult.rows.length > 0) {
      return (linkResult.rows[0] as Record<string, unknown>).primary_email as string;
    }
    
    const manualLinkResult = await db.execute(sql`SELECT email FROM users 
       WHERE manually_linked_emails @> to_jsonb(${email.toLowerCase()}::text)
       LIMIT 1`);
    
    if (manualLinkResult.rows.length > 0) {
      return (manualLinkResult.rows[0] as Record<string, unknown>).email as string;
    }
    
    const trackmanEmailResult = await db.execute(sql`SELECT email FROM users WHERE LOWER(trackman_email) = LOWER(${email}) LIMIT 1`);
    
    if (trackmanEmailResult.rows.length > 0) {
      return (trackmanEmailResult.rows[0] as Record<string, unknown>).email as string;
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
      const row = result.rows[0] as Record<string, unknown>;
      return {
        id: row.id as number,
        email: row.email as string,
        firstName: row.first_name as string,
        lastName: row.last_name as string,
      };
    }
    
    return null;
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to find member by email', { error: e as Error });
    return null;
  }
}
