import crypto from 'crypto';
import { Request } from 'express';
import { logger } from '../../core/logger';
import { pool } from '../../core/db';
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
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Signature validation error', { error: e as Error });
    return !isProduction;
  }
}

export async function logWebhookEvent(
  eventType: string,
  payload: any,
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
    
    const result = await pool.query(
      `INSERT INTO trackman_webhook_events 
       (event_type, payload, trackman_booking_id, trackman_user_id, matched_booking_id, matched_user_id, processed_at, processing_error)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       RETURNING id`,
      [eventType, JSON.stringify(redactedPayload), trackmanBookingId, trackmanUserId, matchedBookingId, matchedUserId, error]
    );
    return result.rows[0]?.id;
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to log webhook event', { error: e as Error });
    return 0;
  }
}

export async function resolveLinkedEmail(email: string): Promise<string> {
  try {
    const linkResult = await pool.query(
      `SELECT primary_email FROM user_linked_emails WHERE LOWER(linked_email) = LOWER($1) LIMIT 1`,
      [email]
    );
    
    if (linkResult.rows.length > 0) {
      return linkResult.rows[0].primary_email;
    }
    
    const manualLinkResult = await pool.query(
      `SELECT email FROM users 
       WHERE manually_linked_emails @> to_jsonb($1::text)
       LIMIT 1`,
      [email.toLowerCase()]
    );
    
    if (manualLinkResult.rows.length > 0) {
      return manualLinkResult.rows[0].email;
    }
    
    const trackmanEmailResult = await pool.query(
      `SELECT email FROM users WHERE LOWER(trackman_email) = LOWER($1) LIMIT 1`,
      [email]
    );
    
    if (trackmanEmailResult.rows.length > 0) {
      return trackmanEmailResult.rows[0].email;
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
    const result = await pool.query(
      `SELECT id, email, first_name, last_name FROM users 
       WHERE LOWER(email) = LOWER($1) 
         AND (membership_status IS NOT NULL OR role = 'visitor')
       LIMIT 1`,
      [email]
    );
    
    if (result.rows.length > 0) {
      return {
        id: result.rows[0].id,
        email: result.rows[0].email,
        firstName: result.rows[0].first_name,
        lastName: result.rows[0].last_name,
      };
    }
    
    return null;
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to find member by email', { error: e as Error });
    return null;
  }
}
