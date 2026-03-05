import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { logger } from '../core/logger';
import { pool } from '../core/db';

const getClientKey = (req: Request): string => {
  const userId = req.session?.user?.id;
  if (userId) {
    return `user:${userId}`;
  }
  return req.ip || 'unknown';
};

export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req: Request) => {
    if (req.session?.user?.id) {
      return 600;
    }
    return 2000;
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey,
  validate: false,
  handler: (req: Request, res: Response) => {
    logger.warn(`[RateLimit] Global limit exceeded for ${getClientKey(req)} on ${req.path}`);
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
  },
  skip: (req) => {
    if (req.path === '/healthz' || req.path === '/api/health') {
      return true;
    }
    if (req.path === '/api/auth/session') {
      return true;
    }
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/api')) {
      return true;
    }
    return false;
  }
});

export const paymentRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey,
  validate: false,
  handler: (req: Request, res: Response) => {
    logger.warn(`[RateLimit] Payment limit exceeded for ${getClientKey(req)} on ${req.path}`);
    res.status(429).json({ error: 'Too many payment requests. Please wait a moment.' });
  }
});

export const bookingRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey,
  validate: false,
  handler: (req: Request, res: Response) => {
    logger.warn(`[RateLimit] Booking limit exceeded for ${getClientKey(req)} on ${req.path}`);
    res.status(429).json({ error: 'Too many booking requests. Please wait a moment.' });
  }
});

export const authRateLimiterByIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `auth-ip:${req.ip || 'unknown'}`,
  validate: false,
  handler: (req: Request, res: Response) => {
    logger.warn(`[RateLimit] Auth IP limit exceeded for ${req.ip}`);
    res.status(429).json({ error: 'Too many login attempts from this location. Please try again in 15 minutes.' });
  }
});

export const authRateLimiterByEmail = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `auth-email:${String(req.body?.email || 'unknown').toLowerCase()}`,
  validate: false,
  handler: (req: Request, res: Response) => {
    logger.warn(`[RateLimit] Auth email limit exceeded for ${req.body?.email || 'unknown'}`);
    res.status(429).json({ error: 'Too many login attempts for this account. Please try again in 15 minutes.' });
  }
});

export const authRateLimiter = [authRateLimiterByIp, authRateLimiterByEmail];

export const sensitiveActionRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey,
  validate: false,
  handler: (req: Request, res: Response) => {
    logger.warn(`[RateLimit] Sensitive action limit exceeded for ${getClientKey(req)} on ${req.path}`);
    res.status(429).json({ error: 'Too many requests for this action. Please wait.' });
  }
});

export const checkoutRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = req.body?.email;
    const sessionId = req.params?.sessionId;
    if (email) {
      return `checkout:${email}:${req.ip || 'unknown'}`;
    }
    if (sessionId) {
      return `checkout:session:${sessionId}`;
    }
    return `checkout:${req.ip || 'unknown'}`;
  },
  validate: false,
  handler: (req: Request, res: Response) => {
    logger.warn(`[RateLimit] Checkout limit exceeded for ${req.body?.email || 'unknown'} on ${req.path}`);
    res.status(429).json({ error: 'Too many checkout attempts. Please wait a minute before trying again.' });
  }
});

export const subscriptionCreationRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey,
  validate: false,
  handler: (req: Request, res: Response) => {
    logger.warn(`[RateLimit] Subscription creation limit exceeded for ${getClientKey(req)} on ${req.path}`);
    res.status(429).json({ error: 'Too many subscription creation attempts. Please wait a moment before trying again.' });
  }
});

const LOCK_TIMEOUT_MS = 120_000;

const subscriptionLocksMemory = new Map<string, number>();

let dbLocksInitialized = false;
async function ensureLocksTable(): Promise<boolean> {
  if (dbLocksInitialized) return true;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_locks (
        email TEXT PRIMARY KEY,
        locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_by TEXT
      )
    `);
    dbLocksInitialized = true;
    return true;
  } catch (err) {
    logger.warn('[SubscriptionLock] Failed to create locks table, falling back to memory', { extra: { error: String(err) } });
    return false;
  }
}

export async function acquireSubscriptionLock(email: string, lockedBy?: string): Promise<boolean> {
  const key = email.toLowerCase();
  const dbReady = await ensureLocksTable();

  if (dbReady) {
    try {
      const result = await pool.query(
        `INSERT INTO subscription_locks (email, locked_at, locked_by)
         VALUES ($1, NOW(), $2)
         ON CONFLICT (email) DO UPDATE
         SET locked_at = EXCLUDED.locked_at, locked_by = EXCLUDED.locked_by
         WHERE subscription_locks.locked_at < NOW() - INTERVAL '${LOCK_TIMEOUT_MS} milliseconds'
         RETURNING email`,
        [key, lockedBy || null]
      );
      return result.rowCount !== null && result.rowCount > 0;
    } catch (err) {
      logger.warn('[SubscriptionLock] DB lock failed, falling back to memory', { extra: { error: String(err) } });
    }
  }

  const existing = subscriptionLocksMemory.get(key);
  if (existing && Date.now() - existing < LOCK_TIMEOUT_MS) {
    return false;
  }
  subscriptionLocksMemory.set(key, Date.now());
  return true;
}

export async function releaseSubscriptionLock(email: string): Promise<void> {
  const key = email.toLowerCase();
  subscriptionLocksMemory.delete(key);

  if (dbLocksInitialized) {
    try {
      await pool.query('DELETE FROM subscription_locks WHERE email = $1', [key]);
    } catch (err) {
      logger.warn('[SubscriptionLock] DB lock release failed', { extra: { error: String(err) } });
    }
  }
}

export const memberLookupRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey,
  validate: false,
  handler: (req: Request, res: Response) => {
    logger.warn(`[RateLimit] Member lookup limit exceeded for ${getClientKey(req)} on ${req.path}`);
    res.status(429).json({ error: 'Too many member lookup requests. Please wait a moment.' });
  }
});
