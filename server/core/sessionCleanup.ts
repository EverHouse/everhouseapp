import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from './logger';

export async function cleanupExpiredSessions(): Promise<number> {
  try {
    const result = await db.execute(sql`
      DELETE FROM session 
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
  } catch (error) {
    if ((error as any)?.code === '42P01') {
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
      FROM session
    `);
    
    const row = result.rows[0] as any;
    
    return {
      total: parseInt(row.total) || 0,
      active: parseInt(row.active) || 0,
      expired: parseInt(row.expired) || 0,
      oldestActive: row.oldest_active ? new Date(row.oldest_active) : null,
      newestActive: row.newest_active ? new Date(row.newest_active) : null,
    };
  } catch (error) {
    if ((error as any)?.code === '42P01') {
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
  } catch (error) {
    logger.error('[SessionCleanup] Scheduled cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'session.cleanup_failed' }
    });
  }
}
