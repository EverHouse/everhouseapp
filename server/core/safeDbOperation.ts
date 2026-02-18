import { pool } from './db';
import { alertOnScheduledTaskFailure } from './dataAlerts';
import { PoolClient } from 'pg';

import { logger } from './logger';
export async function safeDbOperation<T>(
  label: string,
  callback: () => Promise<T>,
  critical: boolean = true
): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    logger.error(`[safeDbOperation] ${label}:`, { error: error });
    if (critical) {
      await alertOnScheduledTaskFailure(label, error instanceof Error ? error : String(error));
    }
    throw error;
  }
}

export async function safeDbTransaction<T>(
  label: string,
  callback: (client: PoolClient) => Promise<T>,
  critical: boolean = true
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ROLLBACK failed, but we still want to report the original error
    }
    logger.error(`[safeDbTransaction] ${label}:`, { error: error });
    if (critical) {
      await alertOnScheduledTaskFailure(label, error instanceof Error ? error : String(error));
    }
    throw error;
  } finally {
    client.release();
  }
}
