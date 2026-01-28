import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';

const getClientKey = (req: Request): string => {
  const userId = req.session?.user?.id;
  if (userId) {
    return `user:${userId}`;
  }
  return req.ip || 'unknown';
};

export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey,
  validate: false,
  handler: (req: Request, res: Response) => {
    console.warn(`[RateLimit] Global limit exceeded for ${getClientKey(req)} on ${req.path}`);
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
  },
  skip: (req) => {
    return req.path === '/healthz' || req.path === '/api/health';
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
    console.warn(`[RateLimit] Payment limit exceeded for ${getClientKey(req)} on ${req.path}`);
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
    console.warn(`[RateLimit] Booking limit exceeded for ${getClientKey(req)} on ${req.path}`);
    res.status(429).json({ error: 'Too many booking requests. Please wait a moment.' });
  }
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = req.body?.email || 'unknown';
    return `auth:${email}:${req.ip || 'unknown'}`;
  },
  validate: false,
  handler: (req: Request, res: Response) => {
    console.warn(`[RateLimit] Auth limit exceeded for ${req.body?.email || 'unknown'}`);
    res.status(429).json({ error: 'Too many login attempts. Please try again in 15 minutes.' });
  }
});

export const sensitiveActionRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey,
  validate: false,
  handler: (req: Request, res: Response) => {
    console.warn(`[RateLimit] Sensitive action limit exceeded for ${getClientKey(req)} on ${req.path}`);
    res.status(429).json({ error: 'Too many requests for this action. Please wait.' });
  }
});

export const checkoutRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = req.body?.email || 'unknown';
    return `checkout:${email}:${req.ip || 'unknown'}`;
  },
  validate: false,
  handler: (req: Request, res: Response) => {
    console.warn(`[RateLimit] Checkout limit exceeded for ${req.body?.email || 'unknown'} on ${req.path}`);
    res.status(429).json({ error: 'Too many checkout attempts. Please wait a minute before trying again.' });
  }
});
