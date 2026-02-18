import pRetry, { AbortError } from 'p-retry';
import { isProduction } from '../db';

import { logger } from '../logger';
export function isRateLimitError(error: unknown): boolean {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const errObj = error as Record<string, any>;
  const statusCode = errObj?.response?.statusCode || errObj?.status || errObj?.code;
  return (
    statusCode === 429 ||
    errorMsg.includes("429") ||
    errorMsg.includes("RATELIMIT_EXCEEDED") ||
    errorMsg.toLowerCase().includes("rate limit")
  );
}

export async function retryableHubSpotRequest<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (error: unknown) {
        if (isRateLimitError(error)) {
          if (!isProduction) logger.warn('HubSpot Rate Limit hit, retrying...');
          throw error;
        }
        throw new AbortError(error instanceof Error ? error : String(error));
      }
    },
    {
      retries: 5,
      minTimeout: 1000,
      maxTimeout: 30000,
      factor: 2
    }
  );
}
