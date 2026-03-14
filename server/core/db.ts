import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getErrorCode, getErrorDetail } from '../utils/errorUtils';
import { isRetryableError as _isRetryableError } from './retry';

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
const poolerEnabled = process.env.ENABLE_PGBOUNCER === 'true';

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

const basePool = new Pool({
  connectionString: usingPooler ? poolerUrl : directUrl,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  ssl: needsSsl ? sslConfig : undefined,
});

export const pool = basePool;

const directConnectionUrl = (forcePoolerRedirect && poolerUrl) ? poolerUrl : directUrl;

export const directPool = usingPooler
  ? new Pool({
      connectionString: directConnectionUrl,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 5,
      ssl: !isLocalDatabase(directConnectionUrl) ? sslConfig : undefined,
    })
  : pool;

pool.on('error', (err) => {
  logger.error('[Database] Pool error:', { extra: { detail: err.message } });
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
    logger.error('[Database] Direct pool error:', { extra: { detail: err.message } });
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

export async function queryWithRetry<T extends QueryResultRow = Record<string, unknown>>(
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

export function safeRelease(client: PoolClient): void {
  try {
    client.release();
  } catch {
    // Already released or pool destroyed — safe to ignore
  }
}
