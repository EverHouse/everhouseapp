import { Pool, PoolClient, QueryResult } from 'pg';
import { getErrorMessage, getErrorCode, getErrorDetail } from '../utils/errorUtils';

import { logger } from './logger';
export const isProduction = process.env.NODE_ENV === 'production';

const poolerUrl = process.env.DATABASE_POOLER_URL;
const directUrl = process.env.DATABASE_URL;
const poolerEnabled = process.env.ENABLE_PGBOUNCER === 'true';
export const usingPooler = poolerEnabled && !!poolerUrl;

const sslConfig = { rejectUnauthorized: false };
const needsSsl = isProduction || usingPooler;

const basePool = new Pool({
  connectionString: usingPooler ? poolerUrl : directUrl,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  ssl: needsSsl ? sslConfig : undefined,
});

export const pool = basePool;

export const directPool = usingPooler
  ? new Pool({
      connectionString: directUrl,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 5,
      ssl: isProduction ? sslConfig : undefined,
    })
  : pool;

pool.on('error', (err) => {
  logger.error('[Database] Pool error:', { extra: { detail: err.message } });
});

pool.on('connect', () => {
  logger.info(`[Database] New client connected via ${usingPooler ? 'session pooler' : 'direct connection'}`);
});

if (usingPooler && directPool !== pool) {
  directPool.on('error', (err) => {
    logger.error('[Database] Direct pool error:', { extra: { detail: err.message } });
  });
}

const RETRYABLE_ERRORS = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'connection terminated unexpectedly',
  'Connection terminated unexpectedly',
  'timeout expired',
  'sorry, too many clients already',
  'Connection terminated due to connection timeout',
  'connection terminated due to connection timeout',
];

function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  const message = getErrorMessage(error);
  const code = getErrorCode(error);
  return RETRYABLE_ERRORS.some(e => message.includes(e) || code === e);
}

export function isConstraintError(error: unknown): { type: 'unique' | 'foreign_key' | null, detail?: string } {
  const code = getErrorCode(error);
  const detail = getErrorDetail(error);
  if (code === '23505') return { type: 'unique', detail };
  if (code === '23503') return { type: 'foreign_key', detail };
  return { type: null };
}

export async function queryWithRetry<T = Record<string, unknown>>(
  queryText: string,
  params?: unknown[],
  maxRetries: number = 3
): Promise<QueryResult<T>> {
  let lastError: unknown = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await pool.query(queryText, params);
    } catch (error: unknown) {
      lastError = error;
      
      if (!isRetryableError(error) || attempt === maxRetries) {
        throw error;
      }
      
      const delay = Math.min(100 * Math.pow(2, attempt - 1), 2000);
      if (!isProduction) {
        logger.info(`[Database] Retrying query (attempt ${attempt}/${maxRetries}) after ${delay}ms...`);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

export function getPoolStatus() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount
  };
}
