import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE = 'csrf_token';
const TOKEN_LENGTH = 32;

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
  }
}

function generateToken(): string {
  return crypto.randomBytes(TOKEN_LENGTH).toString('hex');
}

export function csrfTokenMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.session) {
    return next();
  }

  if (!req.session.csrfToken) {
    req.session.csrfToken = generateToken();
  }

  res.cookie(CSRF_COOKIE, req.session.csrfToken, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });

  next();
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  const safeMethodsNoBody = ['GET', 'HEAD', 'OPTIONS'];
  
  if (safeMethodsNoBody.includes(req.method)) {
    return next();
  }

  if (!req.session?.csrfToken) {
    console.warn(`[CSRF] No session token for ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'CSRF token missing from session' });
  }

  const clientToken = req.headers[CSRF_HEADER] as string | undefined;
  
  if (!clientToken) {
    console.warn(`[CSRF] No client token header for ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'CSRF token required' });
  }

  if (!crypto.timingSafeEqual(
    Buffer.from(clientToken),
    Buffer.from(req.session.csrfToken)
  )) {
    console.warn(`[CSRF] Token mismatch for ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'CSRF token invalid' });
  }

  next();
}

export function csrfExempt(req: Request, res: Response, next: NextFunction) {
  (req as any).csrfExempt = true;
  next();
}

const EXEMPT_PATHS = [
  '/api/stripe/webhook',
  '/api/hubspot/webhooks',
  '/api/webhooks/trackman',
  '/api/public/',
  '/api/auth/otp',
  '/api/auth/magic-link',
  '/api/auth/verify-otp',
  '/api/checkout/',
  '/api/day-passes/checkout',
  '/healthz',
  '/api/health'
];

export function csrfProtectionWithExemptions(req: Request, res: Response, next: NextFunction) {
  const isExempt = EXEMPT_PATHS.some(path => req.path.startsWith(path));
  
  if (isExempt || (req as any).csrfExempt) {
    return next();
  }

  return csrfProtection(req, res, next);
}

export function getCsrfToken(req: Request): string | undefined {
  return req.session?.csrfToken;
}
