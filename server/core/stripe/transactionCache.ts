import { logger } from '../logger';
export async function upsertTransactionCache(payload: unknown): Promise<void> {
  logger.info('[TransactionCache] upsertTransactionCache called (stub)', { extra: { detail: payload } });
}
