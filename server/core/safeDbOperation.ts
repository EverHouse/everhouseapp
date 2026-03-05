import { alertOnScheduledTaskFailure } from './dataAlerts';
import { db } from '../db';

import { logger } from './logger';
export async function safeDbOperation<T>(
  label: string,
  callback: () => Promise<T>,
  critical: boolean = true
): Promise<T> {
  try {
    return await callback();
  } catch (error: unknown) {
    logger.error(`[safeDbOperation] ${label}:`, { error: error });
    if (critical) {
      await alertOnScheduledTaskFailure(label, error instanceof Error ? error : String(error));
    }
    throw error;
  }
}

export async function safeDbTransaction<T>(
  label: string,
  callback: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  critical: boolean = true
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      return await callback(tx);
    });
  } catch (error: unknown) {
    logger.error(`[safeDbTransaction] ${label}:`, { error: error });
    if (critical) {
      await alertOnScheduledTaskFailure(label, error instanceof Error ? error : String(error));
    }
    throw error;
  }
}
