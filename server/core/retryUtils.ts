import pRetry, { AbortError, Options } from 'p-retry';
import { logger } from './logger';

export interface FailedAttemptError extends Error {
  attemptNumber: number;
  retriesLeft: number;
}

export interface RetryOptions {
  retries?: number;
  context?: string;
  onRetry?: (error: FailedAttemptError, attempt: number) => void;
}

function isRetryableError(error: any): boolean {
  const statusCode = error?.response?.status || error?.response?.statusCode || error?.status || error?.code;
  const errorMsg = error instanceof Error ? error.message : String(error);
  
  if (statusCode === 429) return true;
  if (typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600) return true;
  
  const networkPatterns = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'network',
    'socket hang up',
    'timeout',
    'rate limit',
    'too many requests',
    '429',
    '500',
    '502',
    '503',
    '504'
  ];
  
  const lowerMsg = errorMsg.toLowerCase();
  return networkPatterns.some(pattern => lowerMsg.includes(pattern.toLowerCase()));
}

function isNonRetryableClientError(error: any): boolean {
  const statusCode = error?.response?.status || error?.response?.statusCode || error?.status || error?.code;
  
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
    return true;
  }
  
  const errorMsg = error instanceof Error ? error.message : String(error);
  const lowerMsg = errorMsg.toLowerCase();
  const clientErrorPatterns = [
    'not found',
    'unauthorized',
    'forbidden',
    'bad request',
    'invalid',
    '400',
    '401',
    '403',
    '404'
  ];
  
  if (clientErrorPatterns.some(pattern => lowerMsg.includes(pattern)) && !isRetryableError(error)) {
    return true;
  }
  
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { retries = 3, context = 'API' } = options;
  
  const retryOptions: Options = {
    retries,
    minTimeout: 1000,
    maxTimeout: 30000,
    factor: 2,
    onFailedAttempt: (error) => {
      const err = error as unknown as FailedAttemptError;
      logger.warn(`[${context}] Retry attempt ${err.attemptNumber}/${retries + 1}`, {
        extra: {
          event: 'retry_attempt',
          context,
          attempt: err.attemptNumber,
          retriesLeft: err.retriesLeft,
          error: err.message
        }
      });
      
      if (options.onRetry) {
        options.onRetry(err, err.attemptNumber);
      }
    }
  };
  
  return pRetry(async () => {
    try {
      return await fn();
    } catch (error: any) {
      if (isNonRetryableClientError(error)) {
        throw new AbortError(error);
      }
      
      if (isRetryableError(error)) {
        throw error;
      }
      
      throw new AbortError(error);
    }
  }, retryOptions);
}

export async function withCalendarRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  retries: number = 3
): Promise<T> {
  return withRetry(fn, {
    retries,
    context: `Calendar:${operation}`
  });
}

export async function withResendRetry<T>(
  fn: () => Promise<T>,
  retries: number = 3
): Promise<T> {
  return withRetry(fn, {
    retries,
    context: 'Resend'
  });
}

export async function withHubSpotRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  retries: number = 3
): Promise<T> {
  return withRetry(fn, {
    retries,
    context: `HubSpot:${operation}`
  });
}

export async function withStripeRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  retries: number = 2
): Promise<T> {
  return withRetry(fn, {
    retries,
    context: `Stripe:${operation}`
  });
}

export async function withDatabaseRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  retries: number = 2
): Promise<T> {
  return withRetry(fn, {
    retries,
    context: `Database:${operation}`
  });
}

export { AbortError };
