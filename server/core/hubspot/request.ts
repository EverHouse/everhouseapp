import pRetry, { AbortError } from 'p-retry';
import { isProduction } from '../db';

import { logger } from '../logger';
import { getErrorMessage } from '../../utils/errorUtils';
interface HubSpotErrorObject {
  response?: { statusCode?: number };
  status?: number;
  code?: number;
}

export function isRateLimitError(error: unknown): boolean {
  const errorMsg = getErrorMessage(error);
  const errObj = error as HubSpotErrorObject;
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
        throw new AbortError(getErrorMessage(error));
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
