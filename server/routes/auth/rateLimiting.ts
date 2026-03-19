import { logger } from '../../core/logger';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { rateLimits } from '../../../shared/schema';
import { getErrorMessage } from '../../utils/errorUtils';

export const OTP_REQUEST_LIMIT = 3;
export const OTP_REQUEST_WINDOW = 15 * 60 * 1000;
export const MAGIC_LINK_REQUEST_LIMIT = 3;
export const MAGIC_LINK_REQUEST_WINDOW = 15 * 60 * 1000;
export const OTP_VERIFY_MAX_ATTEMPTS = 5;
export const OTP_VERIFY_LOCKOUT = 15 * 60 * 1000;
export const OTP_VERIFY_EMAIL_MAX_ATTEMPTS = 20;
export const OTP_VERIFY_IP_MAX_ATTEMPTS = 15;

export const checkOtpRequestLimit = async (email: string, ip: string): Promise<{ allowed: boolean; retryAfter?: number }> => {
  const key = `otp_request:${email}:${ip}`;
  const now = new Date();
  const resetAt = new Date(now.getTime() + OTP_REQUEST_WINDOW);
  
  try {
    const result = await db.execute(sql`INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES (${key}, 'otp_request', 1, ${resetAt}, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE 
           WHEN rate_limits.reset_at < NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         reset_at = CASE 
           WHEN rate_limits.reset_at < NOW() THEN ${resetAt}
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count, reset_at`);
    
    const { count, reset_at } = result.rows[0] as { count: number; reset_at: Date };
    if (count > OTP_REQUEST_LIMIT) {
      const retryAfter = Math.ceil((new Date(reset_at).getTime() - now.getTime()) / 1000);
      return { allowed: false, retryAfter: Math.max(0, retryAfter) };
    }
    return { allowed: true };
  } catch (error: unknown) {
    logger.error('[RateLimit] Database error, denying request for safety', { error: getErrorMessage(error) });
    return { allowed: false, retryAfter: 60 };
  }
};

export const _checkMagicLinkRequestLimit = async (email: string, ip: string): Promise<{ allowed: boolean; retryAfter?: number }> => {
  const key = `magic_link:${email}:${ip}`;
  const now = new Date();
  const resetAt = new Date(now.getTime() + MAGIC_LINK_REQUEST_WINDOW);
  
  try {
    const result = await db.execute(sql`INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES (${key}, 'magic_link', 1, ${resetAt}, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE 
           WHEN rate_limits.reset_at < NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         reset_at = CASE 
           WHEN rate_limits.reset_at < NOW() THEN ${resetAt}
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count, reset_at`);
    
    const { count, reset_at } = result.rows[0] as { count: number; reset_at: Date };
    if (count > MAGIC_LINK_REQUEST_LIMIT) {
      const retryAfter = Math.ceil((new Date(reset_at).getTime() - now.getTime()) / 1000);
      return { allowed: false, retryAfter: Math.max(0, retryAfter) };
    }
    return { allowed: true };
  } catch (error: unknown) {
    logger.error('[RateLimit] Database error, denying request for safety', { error: getErrorMessage(error) });
    return { allowed: false, retryAfter: 60 };
  }
};

export const checkOtpVerifyAttempts = async (email: string, ip?: string): Promise<{ allowed: boolean; retryAfter?: number }> => {
  const effectiveIp = ip || 'unknown';
  const perIpKey = `otp_verify:${email}:${effectiveIp}`;
  const now = new Date();
  
  try {
    const result = await db.select({
      count: rateLimits.count,
      lockedUntil: rateLimits.lockedUntil,
    }).from(rateLimits).where(eq(rateLimits.key, perIpKey));
    
    if (result.length > 0) {
      const { lockedUntil: locked_until } = result[0];
      if (locked_until && new Date(locked_until) > now) {
        const retryAfter = Math.ceil((new Date(locked_until).getTime() - now.getTime()) / 1000);
        return { allowed: false, retryAfter: Math.max(0, retryAfter) };
      }
      
      if (locked_until && new Date(locked_until) <= now) {
        db.delete(rateLimits).where(eq(rateLimits.key, perIpKey)).catch((err) => logger.warn('[RateLimit] Non-critical expired lock cleanup failed', { key: perIpKey, error: err }));
      }
    }

    const ipKey = `otp_verify_ip:${effectiveIp}`;
    const ipResult = await db.select({
      count: rateLimits.count,
      lockedUntil: rateLimits.lockedUntil,
    }).from(rateLimits).where(eq(rateLimits.key, ipKey));
    
    if (ipResult.length > 0) {
      const { lockedUntil: ipLocked } = ipResult[0];
      if (ipLocked && new Date(ipLocked) > now) {
        const retryAfter = Math.ceil((new Date(ipLocked).getTime() - now.getTime()) / 1000);
        return { allowed: false, retryAfter: Math.max(0, retryAfter) };
      }
      if (ipLocked && new Date(ipLocked) <= now) {
        db.delete(rateLimits).where(eq(rateLimits.key, ipKey)).catch((err) => logger.warn('[RateLimit] Non-critical expired lock cleanup failed', { key: ipKey, error: err }));
      }
    }

    const emailKey = `otp_verify_email:${email}`;
    const emailResult = await db.select({
      count: rateLimits.count,
      lockedUntil: rateLimits.lockedUntil,
    }).from(rateLimits).where(eq(rateLimits.key, emailKey));
    
    if (emailResult.length > 0) {
      const { lockedUntil: emailLocked } = emailResult[0];
      if (emailLocked && new Date(emailLocked) > now) {
        const retryAfter = Math.ceil((new Date(emailLocked).getTime() - now.getTime()) / 1000);
        return { allowed: false, retryAfter: Math.max(0, retryAfter) };
      }
      if (emailLocked && new Date(emailLocked) <= now) {
        db.delete(rateLimits).where(eq(rateLimits.key, emailKey)).catch((err) => logger.warn('[RateLimit] Non-critical expired lock cleanup failed', { key: emailKey, error: err }));
      }
    }
    
    return { allowed: true };
  } catch (error: unknown) {
    logger.error('[RateLimit] Database error, denying request for safety', { error: getErrorMessage(error) });
    return { allowed: false, retryAfter: 60 };
  }
};

export const recordOtpVerifyFailure = async (email: string, ip?: string): Promise<void> => {
  const now = new Date();
  const resetAt = new Date(now.getTime() + OTP_VERIFY_LOCKOUT);
  const lockedUntil = new Date(now.getTime() + OTP_VERIFY_LOCKOUT);
  const effectiveIp = ip || 'unknown';
  
  try {
    const perIpKey = `otp_verify:${email}:${effectiveIp}`;
    await db.execute(sql`INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES (${perIpKey}, 'otp_verify', 1, ${resetAt}, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         locked_until = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN NULL
           WHEN CASE WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1 ELSE rate_limits.count + 1 END >= ${OTP_VERIFY_MAX_ATTEMPTS} THEN ${lockedUntil}
           ELSE rate_limits.locked_until
         END,
         reset_at = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN ${resetAt}
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count`);

    const ipKey = `otp_verify_ip:${effectiveIp}`;
    await db.execute(sql`INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES (${ipKey}, 'otp_verify_ip', 1, ${resetAt}, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         locked_until = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN NULL
           WHEN CASE WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1 ELSE rate_limits.count + 1 END >= ${OTP_VERIFY_IP_MAX_ATTEMPTS} THEN ${lockedUntil}
           ELSE rate_limits.locked_until
         END,
         reset_at = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN ${resetAt}
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count`);

    const emailKey = `otp_verify_email:${email}`;
    await db.execute(sql`INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES (${emailKey}, 'otp_verify_email', 1, ${resetAt}, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         locked_until = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN NULL
           WHEN CASE WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1 ELSE rate_limits.count + 1 END >= ${OTP_VERIFY_EMAIL_MAX_ATTEMPTS} THEN ${lockedUntil}
           ELSE rate_limits.locked_until
         END,
         reset_at = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN ${resetAt}
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count`);
  } catch (error: unknown) {
    logger.error('[RateLimit] Database error recording failure', { error: getErrorMessage(error) });
  }
};

export const clearOtpVerifyAttempts = async (email: string, ip?: string): Promise<void> => {
  const effectiveIp = ip || 'unknown';
  const perIpKey = `otp_verify:${email}:${effectiveIp}`;
  const emailKey = `otp_verify_email:${email}`;
  try {
    await db.delete(rateLimits).where(eq(rateLimits.key, perIpKey));
    await db.delete(rateLimits).where(eq(rateLimits.key, emailKey));
  } catch (error: unknown) {
    logger.error('[RateLimit] Database error clearing attempts', { error: getErrorMessage(error) });
  }
};
