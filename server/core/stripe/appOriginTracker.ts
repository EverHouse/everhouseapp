import { logger } from '../logger';

const APP_ORIGIN_TTL_MS = 30_000;

const appOriginatedUpdates = new Map<string, number>();

export function markAppOriginated(stripeId: string): void {
  appOriginatedUpdates.set(stripeId, Date.now());
  logger.debug(`[AppOriginTracker] Marked ${stripeId} as app-originated`);
}

export function isAppOriginated(stripeId: string): boolean {
  const timestamp = appOriginatedUpdates.get(stripeId);
  if (!timestamp) return false;

  if (Date.now() - timestamp > APP_ORIGIN_TTL_MS) {
    appOriginatedUpdates.delete(stripeId);
    return false;
  }

  logger.info(`[AppOriginTracker] Detected app-originated update for ${stripeId}, will skip webhook processing`);
  return true;
}

export function cleanupExpiredEntries(): void {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, timestamp] of appOriginatedUpdates) {
    if (now - timestamp > APP_ORIGIN_TTL_MS) {
      appOriginatedUpdates.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug(`[AppOriginTracker] Cleaned up ${cleaned} expired entries`);
  }
}
