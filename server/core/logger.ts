import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getSessionUser } from '../types/session';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function generateRequestId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  req.requestId = generateRequestId();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

interface LogContext {
  requestId?: string;
  method?: string;
  path?: string;
  userEmail?: string;
  params?: Record<string, any>;
  query?: Record<string, any>;
  duration?: number;
  statusCode?: number;
  error?: Error | string;
  stack?: string;
  extra?: Record<string, any>;
  bookingId?: number;
  oldBookingId?: number;
  newBookingId?: number;
  memberEmail?: string;
  bookingEmail?: string | null;
  sessionEmail?: string;
  actingAsEmail?: string;
  normalizedBookingEmail?: string;
  normalizedSessionEmail?: string;
  dbErrorCode?: string;
  dbErrorDetail?: string;
  dbErrorTable?: string;
  dbErrorConstraint?: string;
  [key: string]: any;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function sanitize(obj: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!obj) return undefined;
  const sensitiveKeys = ['password', 'token', 'secret', 'authorization', 'cookie', 'apikey', 'api_key'];
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export const logger = {
  info(message: string, context?: LogContext) {
    const log = {
      level: 'INFO',
      timestamp: formatTimestamp(),
      message,
      ...context,
      params: sanitize(context?.params),
      query: sanitize(context?.query),
    };
    console.log(JSON.stringify(log));
  },

  warn(message: string, context?: LogContext) {
    const log = {
      level: 'WARN',
      timestamp: formatTimestamp(),
      message,
      ...context,
      params: sanitize(context?.params),
      query: sanitize(context?.query),
    };
    console.warn(JSON.stringify(log));
  },

  error(message: string, context?: LogContext) {
    const errorMsg = context?.error instanceof Error 
      ? context.error.message 
      : context?.error;
    const stack = context?.error instanceof Error 
      ? context.error.stack 
      : context?.stack;
    
    const log = {
      level: 'ERROR',
      timestamp: formatTimestamp(),
      message,
      ...context,
      error: errorMsg,
      stack,
      params: sanitize(context?.params),
      query: sanitize(context?.query),
    };
    console.error(JSON.stringify(log));
  },
};

export function logRequest(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const context = {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      userEmail: getSessionUser(req)?.email,
    };
    const message = `${req.method} ${req.path}`;
    
    if (res.statusCode >= 400) {
      logger.warn(message, context);
    } else {
      logger.info(message, context);
    }
  });
  
  next();
}

export interface ApiErrorResponse {
  error: string;
  code?: string;
  requestId?: string;
}

export function createErrorResponse(
  req: Request,
  message: string,
  code?: string
): ApiErrorResponse {
  return {
    error: message,
    code,
    requestId: req.requestId,
  };
}

export function logAndRespond(
  req: Request,
  res: Response,
  statusCode: number,
  message: string,
  error?: Error | unknown,
  code?: string
) {
  const err = error instanceof Error ? error : new Error(String(error));
  const errAny = error as any;
  
  const dbErrorCode = errAny?.code;
  const dbErrorDetail = errAny?.detail;
  const dbErrorTable = errAny?.table;
  const dbErrorConstraint = errAny?.constraint;
  
  logger.error(`[API Error] ${message}`, {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    params: req.params,
    query: req.query as Record<string, any>,
    error: err,
    dbErrorCode,
    dbErrorDetail,
    dbErrorTable,
    dbErrorConstraint,
    userEmail: getSessionUser(req)?.email,
  });
  
  if (statusCode >= 500) {
    import('./errorAlerts').then(({ alertOnServerError }) => {
      alertOnServerError(err, {
        path: req.path,
        method: req.method,
        userEmail: getSessionUser(req)?.email,
        requestId: req.requestId,
        dbErrorCode,
        dbErrorDetail,
        dbErrorTable,
        dbErrorConstraint
      }).catch(() => {});
    }).catch(() => {});
  }
  
  res.status(statusCode).json(createErrorResponse(req, message, code));
}
