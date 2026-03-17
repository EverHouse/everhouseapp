import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from './logger';

interface DatabaseError {
  code?: string;
  message?: string;
}

interface SessionStatsRow {
  total: string;
  active: string;
  expired: string;
  oldest_active: string | null;
  newest_active: string | null;
}

function isTableMissingError(error: unknown): boolean {
  const code = (error as unknown as DatabaseError)?.code;
  if (code === '42P01') return true;
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('42P01') || msg.includes('does not exist');
}

export async function cleanupExpiredSessions(): Promise<number> {
  try {
    const result = await db.execute(sql`
      DELETE FROM sessions 
      WHERE expire < NOW()
      RETURNING sid
    `);
    
    const deletedCount = result.rowCount || 0;
    
    if (deletedCount > 0) {
      logger.info(`[SessionCleanup] Removed ${deletedCount} expired sessions`, {
        extra: { event: 'session.cleanup', count: deletedCount }
      });
    }
    
    return deletedCount;
  } catch (error: unknown) {
    if (isTableMissingError(error)) {
      return 0;
    }
    logger.error('[SessionCleanup] Failed to cleanup sessions', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'session.cleanup_failed' }
    });
    return 0;
  }
}

export async function getSessionStats(): Promise<{
  total: number;
  active: number;
  expired: number;
  oldestActive: Date | null;
  newestActive: Date | null;
}> {
  try {
    const result = await db.execute(sql`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE expire > NOW()) as active,
        COUNT(*) FILTER (WHERE expire <= NOW()) as expired,
        MIN(expire) FILTER (WHERE expire > NOW()) as oldest_active,
        MAX(expire) FILTER (WHERE expire > NOW()) as newest_active
      FROM sessions
    `);
    
    const row = result.rows[0] as unknown as SessionStatsRow;
    
    return {
      total: parseInt(String(row.total), 10) || 0,
      active: parseInt(String(row.active), 10) || 0,
      expired: parseInt(String(row.expired), 10) || 0,
      oldestActive: row.oldest_active ? new Date(String(row.oldest_active)) : null,
      newestActive: row.newest_active ? new Date(String(row.newest_active)) : null,
    };
  } catch (error: unknown) {
    if (isTableMissingError(error)) {
      return { total: 0, active: 0, expired: 0, oldestActive: null, newestActive: null };
    }
    logger.error('[SessionCleanup] Failed to get session stats', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'session.stats_failed' }
    });
    return { total: 0, active: 0, expired: 0, oldestActive: null, newestActive: null };
  }
}

export async function runSessionCleanup(): Promise<void> {
  logger.info('[SessionCleanup] Starting scheduled session cleanup', {
    extra: { event: 'session.cleanup_start' }
  });
  
  try {
    const beforeStats = await getSessionStats();
    const deleted = await cleanupExpiredSessions();
    const afterStats = await getSessionStats();
    
    logger.info('[SessionCleanup] Session cleanup completed', {
      extra: { 
        event: 'session.cleanup_complete',
        deleted,
        beforeTotal: beforeStats.total,
        afterTotal: afterStats.total,
        activeRemaining: afterStats.active
      }
    });
  } catch (error: unknown) {
    logger.error('[SessionCleanup] Scheduled cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'session.cleanup_failed' }
    });
  }
}
