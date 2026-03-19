import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getErrorCode, getErrorDetail, getErrorMessage } from '../utils/errorUtils';
import { isRetryableError as _isRetryableError, RETRYABLE_ERRORS } from './retry';

import { logger } from './logger';
export const isProduction = process.env.NODE_ENV === 'production';

export function stripSslMode(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
  }
}

const poolerUrl = stripSslMode(process.env.DATABASE_POOLER_URL);
const rawDirectUrl = stripSslMode(process.env.DATABASE_URL);
const supabaseDirectUrl = stripSslMode(process.env.SUPABASE_DIRECT_URL);
const poolerEnabled = process.env.ENABLE_PGBOUNCER === 'true' || (!!poolerUrl && !isLocalDatabase(rawDirectUrl));

function isLocalDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return ['localhost', '127.0.0.1', 'helium'].includes(u.hostname);
  } catch {
    return false;
  }
}

const localDbDetected = isLocalDatabase(rawDirectUrl);
const forcePoolerRedirect = localDbDetected && process.env.FORCE_POOLER_REDIRECT === 'true';

if (forcePoolerRedirect && !poolerUrl) {
  const msg = '[Database] FATAL: FORCE_POOLER_REDIRECT=true but no DATABASE_POOLER_URL configured.';
  logger.error(msg);
  throw new Error(msg);
}

if (localDbDetected && !forcePoolerRedirect) {
  logger.info('[Database] Using local database (set FORCE_POOLER_REDIRECT=true to use Supabase pooler instead)');
}

const directUrl = (forcePoolerRedirect && supabaseDirectUrl) ? supabaseDirectUrl : rawDirectUrl;
export const usingPooler = !!poolerUrl && (poolerEnabled || forcePoolerRedirect) && (!localDbDetected || forcePoolerRedirect);

const effectiveConnectionString = usingPooler ? poolerUrl : directUrl;
if (!effectiveConnectionString) {
  const msg = '[Database] FATAL: No database connection string configured. Set DATABASE_URL or DATABASE_POOLER_URL + ENABLE_PGBOUNCER=true';
  logger.error(msg);
  throw new Error(msg);
}

if (forcePoolerRedirect && poolerUrl) {
  logger.info('[Database] FORCE_POOLER_REDIRECT active — using shared Supabase database via pooler');
}

const sslConfig = { rejectUnauthorized: false };
const needsSsl = !isLocalDatabase(effectiveConnectionString);

function appendSearchPath(connString: string | undefined): string | undefined {
  if (!connString || isLocalDatabase(connString)) return connString;
  try {
    const u = new URL(connString);
    const existing = u.searchParams.get('options') || '';
    if (!existing.includes('search_path')) {
      u.searchParams.set('options', (existing ? existing + ' ' : '') + '-c search_path=public');
    }
    return u.toString();
  } catch {
    const sep = connString.includes('?') ? '&' : '?';
    return connString + sep + 'options=-c%20search_path%3Dpublic';
  }
}

const mainConnString = appendSearchPath(usingPooler ? poolerUrl : directUrl);

const basePool = new Pool({
  connectionString: mainConnString,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
  max: parseInt(process.env.DB_POOL_MAX || '60', 10),
  ssl: needsSsl ? sslConfig : undefined,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  allowExitOnIdle: true,
});

if (needsSsl) {
  basePool.on('connect', (client) => {
    client.query("SET search_path TO public").catch((err) => {
      logger.warn('[Database] Failed to set search_path on new connection:', { extra: { errorMessage: getErrorMessage(err) } });
    });
  });
}

export const pool = basePool;

const directConnectionUrl = (forcePoolerRedirect && poolerUrl) ? poolerUrl : directUrl;
const directConnString = appendSearchPath(directConnectionUrl);

const directPoolInstance = usingPooler
  ? new Pool({
      connectionString: directConnString,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      max: 5,
      ssl: !isLocalDatabase(directConnectionUrl) ? sslConfig : undefined,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      allowExitOnIdle: true,
    })
  : pool;

if (usingPooler && directPoolInstance !== pool && !isLocalDatabase(directConnectionUrl)) {
  directPoolInstance.on('connect', (client) => {
    client.query("SET search_path TO public").catch((err) => {
      logger.warn('[Database] Failed to set search_path on direct pool connection:', { extra: { errorMessage: getErrorMessage(err) } });
    });
  });
}

export const directPool = directPoolInstance;

pool.on('error', (err) => {
  const isConnectionError = RETRYABLE_ERRORS.some(e => err.message.includes(e));
  logger.error('[Database] Pool error:', {
    extra: {
      detail: err.message,
      isConnectionError,
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
    },
  });
  if (isConnectionError) {
    logger.warn('[Database] Stale connection evicted from pool', {
      extra: { detail: err.message },
    });
  }
});

let poolConnectCount = 0;
pool.on('connect', () => {
  poolConnectCount++;
  if (poolConnectCount <= 5 || poolConnectCount % 100 === 0) {
    logger.info(`[Database] New client connected via ${usingPooler ? 'session pooler' : 'direct connection'} (total: ${poolConnectCount})`);
  }
});

if (usingPooler && directPool !== pool) {
  directPool.on('error', (err) => {
    const isConnError = RETRYABLE_ERRORS.some(e => err.message.includes(e));
    logger.error('[Database] Direct pool error:', {
      extra: {
        detail: err.message,
        isConnectionError: isConnError,
        poolTotal: directPool.totalCount,
        poolIdle: directPool.idleCount,
        poolWaiting: directPool.waitingCount,
      },
    });
    if (isConnError) {
      logger.warn('[Database] Stale connection evicted from direct pool', {
        extra: { detail: err.message },
      });
    }
  });
}

function isRetryableError(error: unknown): boolean {
  return _isRetryableError(error);
}

export function isConstraintError(error: unknown): { type: 'unique' | 'foreign_key' | null, detail?: string } {
  const code = getErrorCode(error);
  const detail = getErrorDetail(error);
  if (code === '23505') return { type: 'unique', detail };
  if (code === '23503') return { type: 'foreign_key', detail };
  return { type: null };
}

function isConnectionError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const connectionPatterns = [
    'Connection terminated',
    'connection terminated',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'socket hang up',
    'Connection refused',
  ];
  return connectionPatterns.some(p => message.includes(p));
}

export async function queryWithRetry<T extends QueryResultRow = Record<string, unknown>>(
  queryText: string,
  params?: unknown[],
  maxRetries: number = 3
): Promise<QueryResult<T>> {
  let lastError: unknown = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt === 1) {
        return await pool.query(queryText, params);
      }
      const client = await pool.connect();
      try {
        const result = await client.query<T>(queryText, params);
        client.release();
        return result;
      } catch (queryError: unknown) {
        client.release(isConnectionError(queryError));
        throw queryError;
      }
    } catch (error: unknown) {
      lastError = error;
      
      if (!isRetryableError(error) || attempt === maxRetries) {
        throw error;
      }
      
      const delay = Math.min(100 * Math.pow(2, attempt - 1), 2000);
      logger.warn(`[Database] Retrying query (attempt ${attempt}/${maxRetries}) after ${delay}ms`, {
        extra: {
          errorMessage: getErrorMessage(error),
          isConnectionError: isConnectionError(error),
        },
      });
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

export function safeRelease(client: PoolClient): void {
  try {
    client.release();
  } catch {
    // Already released or pool destroyed — safe to ignore
  }
}
