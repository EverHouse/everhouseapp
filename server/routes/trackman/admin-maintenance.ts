import { logger } from '../../core/logger';
import { Router } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { pool, safeRelease } from '../../core/db';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logFromRequest } from '../../core/auditLog';

import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { getErrorMessage, safeErrorDetail } from '../../utils/errorUtils';

interface DbRow {
  [key: string]: unknown;
}

const router = Router();

router.get('/api/admin/trackman/needs-players', isStaffOrAdmin, async (req, res) => {
  try {
    const { limit = '20', offset = '0', search = '' } = req.query;
    const limitNum = Math.min(parseInt(limit as string) || 20, 100);
    const offsetNum = parseInt(offset as string) || 0;

    const sqlConditions: ReturnType<typeof sql>[] = [
      sql`br.status = 'approved'`,
      sql`bs.id IS NOT NULL`,
    ];

    if (search) {
      const searchPattern = `%${search}%`;
      sqlConditions.push(sql`(
        br.user_name ILIKE ${searchPattern} OR
        br.user_email ILIKE ${searchPattern}
      )`);
    }

    const whereFragment = sql.join(sqlConditions, sql` AND `);

    const countResult = await db.execute(sql`
      SELECT COUNT(*) FROM (
        SELECT br.id
        FROM booking_requests br
        INNER JOIN booking_sessions bs ON bs.id = br.session_id
        LEFT JOIN booking_participants bp ON bp.session_id = bs.id
        WHERE ${whereFragment}
        GROUP BY br.id, bs.id, br.declared_player_count, br.trackman_player_count
        HAVING COUNT(bp.id) < COALESCE(br.declared_player_count, br.trackman_player_count, 1)
      ) sub
    `);
    const totalCount = parseInt((countResult.rows[0] as DbRow).count as string);

    const result = await db.execute(sql`
      SELECT
        br.id,
        br.user_name,
        br.user_email,
        br.request_date,
        br.resource_id,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.notes,
        br.trackman_player_count,
        br.declared_player_count,
        COALESCE(br.declared_player_count, br.trackman_player_count, 1) as expected_player_count,
        COUNT(bp.id)::int as assigned_count
      FROM booking_requests br
      INNER JOIN booking_sessions bs ON bs.id = br.session_id
      LEFT JOIN booking_participants bp ON bp.session_id = bs.id
      WHERE ${whereFragment}
      GROUP BY br.id, bs.id, br.declared_player_count, br.trackman_player_count
      HAVING COUNT(bp.id) < COALESCE(br.declared_player_count, br.trackman_player_count, 1)
      ORDER BY br.request_date DESC
      LIMIT ${limitNum} OFFSET ${offsetNum}
    `);

    const data = result.rows.map((row: DbRow) => {
      const expectedPlayerCount = parseInt(row.expected_player_count as string) || 1;
      const assignedCount = parseInt(row.assigned_count as string) || 0;
      return {
        id: row.id,
        userName: row.user_name,
        userEmail: row.user_email,
        requestDate: row.request_date,
        resourceId: row.resource_id,
        startTime: row.start_time,
        endTime: row.end_time,
        durationMinutes: row.duration_minutes,
        notes: row.notes,
        trackmanPlayerCount: row.trackman_player_count,
        playerCount: row.trackman_player_count,
        assignedCount,
        slotInfo: {
          totalSlots: expectedPlayerCount,
          filledSlots: assignedCount,
          expectedPlayerCount,
        },
      };
    });

    res.json({ data, totalCount });
  } catch (error: unknown) {
    logger.error('Error fetching needs-players bookings', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch needs-players bookings' });
  }
});

router.delete('/api/admin/trackman/reset-data', isStaffOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = req.session?.user?.email || 'admin';
    
    await client.query('BEGIN');
    
    const bookingCount = await client.query(
      `SELECT COUNT(*) FROM booking_requests WHERE trackman_booking_id IS NOT NULL`
    );
    const sessionCount = await client.query(
      `SELECT COUNT(*) FROM booking_sessions WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL`
    );
    const unmatchedCount = await client.query(
      `SELECT COUNT(*) FROM trackman_unmatched_bookings`
    );
    
    await client.query(`
      DELETE FROM usage_ledger 
      WHERE session_id IN (
        SELECT id FROM booking_sessions 
        WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL
      )
    `);
    
    await client.query(`
      DELETE FROM admin_audit_log 
      WHERE resource_type = 'payment' 
      AND resource_id IN (
        SELECT id::text FROM booking_requests 
        WHERE trackman_booking_id IS NOT NULL
      )
    `);
    
    await client.query(`
      DELETE FROM booking_participants 
      WHERE session_id IN (
        SELECT id FROM booking_sessions 
        WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL
      )
    `);
    
    await client.query(`
      DELETE FROM booking_sessions 
      WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL
    `);
    
    await client.query(`
      DELETE FROM booking_requests 
      WHERE trackman_booking_id IS NOT NULL
    `);
    
    await client.query(`DELETE FROM trackman_unmatched_bookings`);
    
    await client.query(`DELETE FROM trackman_import_runs`);
    
    await client.query('COMMIT');
    
    logger.info('[Trackman Reset] Data wiped by : bookings, sessions, unmatched', { extra: { user, bookingCountRows_0_as_any_Count: (bookingCount.rows[0] as DbRow).count, sessionCountRows_0_as_any_Count: (sessionCount.rows[0] as DbRow).count, unmatchedCountRows_0_as_any_Count: (unmatchedCount.rows[0] as DbRow).count } });
    
    res.json({
      success: true,
      message: 'Trackman data reset complete',
      deleted: {
        bookings: parseInt((bookingCount.rows[0] as DbRow).count as string),
        sessions: parseInt((sessionCount.rows[0] as DbRow).count as string),
        unmatched: parseInt((unmatchedCount.rows[0] as DbRow).count as string)
      }
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    logger.error('Trackman reset error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to reset Trackman data', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.get('/api/admin/backfill-sessions/preview', isStaffOrAdmin, async (req, res) => {
  try {
    const countResult = await db.execute(sql`SELECT COUNT(*) as total
      FROM booking_requests br
      LEFT JOIN booking_sessions bs ON br.session_id = bs.id
      WHERE br.status IN ('attended', 'approved', 'confirmed')
        AND (br.session_id IS NULL OR bs.id IS NULL)
        AND br.resource_id IS NOT NULL
        AND (br.is_unmatched = false OR br.is_unmatched IS NULL)`);
    
    const totalCount = parseInt((countResult.rows[0] as DbRow).total as string);
    
    const samplesResult = await db.execute(sql`SELECT 
        br.id,
        br.user_email,
        br.user_name,
        br.resource_id,
        r.name as resource_name,
        TO_CHAR(br.request_date, 'YYYY-MM-DD') as request_date,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.status,
        br.trackman_booking_id,
        br.origin,
        br.created_at
      FROM booking_requests br
      LEFT JOIN booking_sessions bs ON br.session_id = bs.id
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE br.status IN ('attended', 'approved', 'confirmed')
        AND (br.session_id IS NULL OR bs.id IS NULL)
        AND br.resource_id IS NOT NULL
        AND (br.is_unmatched = false OR br.is_unmatched IS NULL)
      ORDER BY br.request_date DESC, br.start_time DESC
      LIMIT 10`);
    
    res.json({
      totalCount,
      sampleBookings: samplesResult.rows.map((row: DbRow) => ({
        id: row.id,
        userEmail: row.user_email,
        userName: row.user_name,
        resourceId: row.resource_id,
        resourceName: row.resource_name,
        requestDate: row.request_date,
        startTime: row.start_time,
        endTime: row.end_time,
        durationMinutes: row.duration_minutes,
        status: row.status,
        trackmanBookingId: row.trackman_booking_id,
        origin: row.origin,
        createdAt: row.created_at
      })),
      message: `Found ${totalCount} booking(s) without sessions that can be backfilled`
    });
  } catch (error: unknown) {
    logger.error('[Backfill Preview] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to preview backfill candidates' });
  }
});

router.post('/api/admin/backfill-sessions', isStaffOrAdmin, async (req, res) => {
  const client = await pool.connect();
  let clientReleased = false;
  
  try {
    await client.query('BEGIN');
    
    const staffEmail = req.session?.user?.email || 'admin';
    
    const bookingsResult = await client.query(`
      SELECT 
        br.id,
        br.user_id,
        br.user_email,
        br.user_name,
        br.resource_id,
        TO_CHAR(br.request_date, 'YYYY-MM-DD') as request_date,
        br.start_time,
        br.end_time,
        br.trackman_booking_id,
        br.session_id,
        CASE WHEN bs.id IS NOT NULL THEN true ELSE false END as session_exists,
        u.id as owner_user_id
      FROM booking_requests br
      LEFT JOIN booking_sessions bs ON br.session_id = bs.id
      LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
      WHERE br.status IN ('attended', 'approved', 'confirmed')
        AND (br.session_id IS NULL OR bs.id IS NULL)
        AND br.resource_id IS NOT NULL
        AND (br.is_unmatched = false OR br.is_unmatched IS NULL)
      ORDER BY br.request_date ASC
    `);
    
    const bookings = bookingsResult.rows;
    
    if (bookings.length === 0) {
      await client.query('ROLLBACK');
      return res.json({
        success: true,
        sessionsCreated: 0,
        message: 'No bookings found without sessions'
      });
    }
    
    let sessionsCreated = 0;
    let sessionsLinked = 0;
    const errors: Array<{ bookingId: number; error: string }> = [];
    const createdSessionIds: number[] = [];
    let savepointCounter = 0;
    
    for (const booking of bookings) {
      savepointCounter++;
      const savepointName = `sp_${savepointCounter}`;
      
      try {
        await client.query(`SAVEPOINT ${savepointName}`);
        
        if (booking.start_time >= booking.end_time) {
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
          errors.push({
            bookingId: booking.id,
            error: `Invalid time range: start_time (${booking.start_time}) >= end_time (${booking.end_time})`
          });
          logger.warn('[Backfill] Skipping booking with invalid time range', { extra: { bookingId: booking.id, startTime: booking.start_time, endTime: booking.end_time } });
          continue;
        }
        
        const displayName = booking.user_name || booking.user_email || 'Unknown';
        const userId = booking.owner_user_id || booking.user_id;
        
        if (booking.session_id && !booking.session_exists) {
          await client.query('UPDATE booking_requests SET session_id = NULL WHERE id = $1', [booking.id]);
        }
        
        let source = 'member_request';
        if (booking.trackman_booking_id) {
          source = 'trackman_import';
        }
        
        const sessionResult = await ensureSessionForBooking({
          bookingId: booking.id,
          resourceId: booking.resource_id,
          sessionDate: booking.request_date,
          startTime: booking.start_time,
          endTime: booking.end_time,
          ownerEmail: booking.user_email || '',
          ownerName: displayName,
          ownerUserId: userId?.toString(),
          trackmanBookingId: booking.trackman_booking_id,
          source: source as 'trackman_webhook' | 'member_request' | 'staff_manual' | 'trackman_import',
          createdBy: 'backfill_tool'
        }, client);
        
        if (sessionResult.sessionId === 0 && sessionResult.error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          errors.push({
            bookingId: booking.id,
            error: sessionResult.error
          });
          continue;
        }
        
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        
        if (sessionResult.sessionId > 0) {
          createdSessionIds.push(sessionResult.sessionId);
        }
        
        if (sessionResult.created) {
          sessionsCreated++;
        } else {
          sessionsLinked++;
        }
      } catch (bookingError: unknown) {
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        } catch (_rollbackError: unknown) {
          logger.error('[Backfill] Failed to rollback savepoint for booking', { extra: { bookingId: booking.id } });
        }
        
        logger.error('[Backfill] Error processing booking', { extra: { id: booking.id, error: getErrorMessage(bookingError) } });
        logger.warn('[Backfill] Failed to process booking', { extra: { bookingId: booking.id, error: getErrorMessage(bookingError) } });
        errors.push({
          bookingId: booking.id,
          error: getErrorMessage(bookingError) || 'Unknown error'
        });
      }
    }
    
    await client.query('COMMIT');
    safeRelease(client);
    clientReleased = true;
    
    let feesComputed = 0;
    let feeErrors = 0;
    for (const sessionId of createdSessionIds) {
      try {
        await recalculateSessionFees(sessionId, 'staff_action', { skipCascade: true });
        feesComputed++;
      } catch (feeErr: unknown) {
        feeErrors++;
        logger.warn('[Backfill] Fee calculation failed for session', { extra: { sessionId, error: getErrorMessage(feeErr) } });
      }
    }
    
    if (createdSessionIds.length > 0) {
      logger.info('[Backfill] Fee computation complete', { extra: { feesComputed, feeErrors, totalSessions: createdSessionIds.length } });
    }
    
    logFromRequest(req, 'bulk_action', 'booking', undefined, 'Session Backfill', {
      action: 'backfill_sessions',
      sessionsCreated,
      sessionsLinked,
      totalProcessed: bookings.length,
      feesComputed,
      feeErrors,
      errorsCount: errors.length,
      errors: errors.slice(0, 10)
    });
    
    const totalResolved = sessionsCreated + sessionsLinked;
    logger.info('[Backfill] Completed', { extra: { sessionsCreated, sessionsLinked, feesComputed, feeErrors, bookingsLength: bookings.length, staffEmail } });
    
    const messageParts = [];
    if (sessionsCreated > 0) messageParts.push(`${sessionsCreated} new sessions created`);
    if (sessionsLinked > 0) messageParts.push(`${sessionsLinked} linked to existing sessions`);
    if (feesComputed > 0) messageParts.push(`${feesComputed} sessions had fees computed`);
    if (feeErrors > 0) messageParts.push(`${feeErrors} fee calculation errors`);
    const message = messageParts.length > 0 
      ? `Successfully resolved ${totalResolved} bookings: ${messageParts.join(', ')}`
      : 'No bookings could be resolved';
    
    res.json({
      success: true,
      sessionsCreated,
      sessionsLinked,
      feesComputed,
      feeErrors,
      totalProcessed: bookings.length,
      errorsCount: errors.length,
      errors: errors.length > 0 ? errors.slice(0, 20) : undefined,
      message
    });
  } catch (error: unknown) {
    if (!clientReleased) {
      try { await client.query('ROLLBACK'); } catch (_) { /* rollback best-effort */ }
    }
    logger.error('[Backfill Sessions] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    
    logFromRequest(req, 'bulk_action', 'booking', undefined, 'Session Backfill Failed', {
      action: 'backfill_sessions',
      error: getErrorMessage(error)
    });
    
    res.status(500).json({ error: 'Failed to backfill sessions', details: safeErrorDetail(error) });
  } finally {
    if (!clientReleased) {
      safeRelease(client);
    }
  }
});

router.get('/api/admin/trackman/duplicate-bookings', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.execute(sql`SELECT 
        trackman_booking_id,
        COUNT(*) as duplicate_count,
        array_agg(id ORDER BY created_at) as booking_ids,
        array_agg(created_at ORDER BY created_at) as created_dates,
        array_agg(is_unmatched ORDER BY created_at) as is_unmatched_flags,
        array_agg(user_email ORDER BY created_at) as emails
      FROM booking_requests
      WHERE trackman_booking_id IS NOT NULL
      GROUP BY trackman_booking_id
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC`);

    res.json({
      duplicatesFound: result.rows.length,
      duplicates: result.rows.map((row: DbRow) => ({
        trackmanBookingId: row.trackman_booking_id,
        count: parseInt(row.duplicate_count as string),
        bookingIds: row.booking_ids,
        createdDates: row.created_dates,
        isUnmatchedFlags: row.is_unmatched_flags,
        emails: row.emails
      }))
    });
  } catch (error: unknown) {
    logger.error('[Trackman Duplicates] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check for duplicates' });
  }
});

router.post('/api/admin/trackman/cleanup-duplicates', isStaffOrAdmin, async (req, res) => {
  const { dryRun = true } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const duplicateResult = await client.query(`
      WITH ranked AS (
        SELECT 
          id,
          trackman_booking_id,
          ROW_NUMBER() OVER (PARTITION BY trackman_booking_id ORDER BY created_at ASC) as rn
        FROM booking_requests
        WHERE trackman_booking_id IS NOT NULL
      )
      SELECT id, trackman_booking_id
      FROM ranked
      WHERE rn > 1
    `);
    
    const idsToDelete = duplicateResult.rows.map((r: DbRow) => r.id);
    
    if (dryRun) {
      await client.query('ROLLBACK');
      res.json({
        dryRun: true,
        wouldDelete: idsToDelete.length,
        bookingIds: idsToDelete.slice(0, 50),
        message: `Would delete ${idsToDelete.length} duplicate booking(s). Set dryRun=false to execute.`
      });
      return;
    }
    
    if (idsToDelete.length > 0) {
      await client.query(
        `DELETE FROM admin_audit_log WHERE resource_type = 'payment' AND resource_id = ANY(SELECT id::text FROM unnest($1::int[]) AS id)`,
        [idsToDelete]
      );
      await client.query(
        `DELETE FROM booking_fee_snapshots WHERE booking_id = ANY($1)`,
        [idsToDelete]
      );
      await client.query(
        `DELETE FROM booking_requests WHERE id = ANY($1)`,
        [idsToDelete]
      );
    }
    
    await client.query('COMMIT');
    
    const _sessionUser = req.session?.user?.email || 'admin';
    const { logFromRequest } = await import('../../core/auditLog');
    await logFromRequest(req, {
      action: 'bulk_action',
      resourceType: 'booking',
      resourceId: undefined,
      resourceName: 'Duplicate Cleanup',
      details: { deletedCount: idsToDelete.length, bookingIds: idsToDelete }
    });
    
    res.json({
      success: true,
      deletedCount: idsToDelete.length,
      bookingIds: idsToDelete,
      message: `Successfully deleted ${idsToDelete.length} duplicate booking(s)`
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    logger.error('[Trackman Cleanup Duplicates] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cleanup duplicates', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/admin/repair-linked-email-bookings', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.execute(sql`
      UPDATE booking_requests br
      SET 
        user_email = u.email,
        user_id = u.id,
        updated_at = NOW()
      FROM user_linked_emails ule
      JOIN users u ON LOWER(u.email) = LOWER(ule.primary_email) AND u.archived_at IS NULL
      WHERE LOWER(br.user_email) = LOWER(ule.linked_email)
        AND LOWER(br.user_email) != LOWER(u.email)
      RETURNING br.id, br.user_email AS new_email, ule.linked_email AS old_email
    `);
    
    const manualResult = await db.execute(sql`
      UPDATE booking_requests br
      SET
        user_email = u.email,
        user_id = u.id,
        updated_at = NOW()
      FROM users u
      WHERE u.archived_at IS NULL
        AND u.manually_linked_emails IS NOT NULL
        AND u.manually_linked_emails @> to_jsonb(LOWER(br.user_email))
        AND LOWER(br.user_email) != LOWER(u.email)
      RETURNING br.id, br.user_email AS new_email
    `);

    const totalFixed = (result.rows?.length || 0) + (manualResult.rows?.length || 0);
    
    logFromRequest(req, {
      action: 'update_booking',
      resourceType: 'booking_request',
      details: { operation: 'repair_linked_email_bookings', totalFixed, linkedFixed: result.rows?.length || 0, manualFixed: manualResult.rows?.length || 0 }
    });

    logger.info('[Admin] Repaired linked email bookings', { extra: { linkedFixed: result.rows?.length || 0, manualFixed: manualResult.rows?.length || 0 } });
    
    res.json({ 
      success: true, 
      linkedFixed: result.rows?.length || 0,
      manualFixed: manualResult.rows?.length || 0,
      totalFixed,
      details: result.rows || []
    });
  } catch (error: unknown) {
    logger.error('[Admin] Failed to repair linked email bookings', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to repair linked email bookings', details: safeErrorDetail(error) });
  }
});

export default router;
