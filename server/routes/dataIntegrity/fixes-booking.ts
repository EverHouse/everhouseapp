import { Router } from 'express';
import { logger, isAdmin, validateBody, db, sql, pool, safeRelease, logFromRequest, getSessionUser, getErrorMessage, safeErrorDetail } from './shared';
import type { ResourceType } from './shared';
import type { Request } from 'express';
import { recordIdSchema, dryRunSchema, reviewItemSchema, assignSessionOwnerSchema } from '../../../shared/validators/dataIntegrity';

const router = Router();

router.post('/api/data-integrity/fix/delete-guest-pass', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    
    await db.execute(sql`DELETE FROM guest_passes WHERE id = ${recordId}`);
    
    logFromRequest(req, 'delete_orphan_guest_pass', 'guest_passes', recordId, undefined, { deletedId: recordId });
    
    res.json({ success: true, message: `Deleted orphaned guest pass ${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete guest pass error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-fee-snapshot', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    
    await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE id = ${recordId}`);
    
    logFromRequest(req, 'delete_orphan_fee_snapshot', 'booking_fee_snapshots', recordId, undefined, { deletedId: recordId });
    
    res.json({ success: true, message: `Deleted orphaned fee snapshot ${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete fee snapshot error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/dismiss-trackman-unmatched', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    
    const staffEmail = getSessionUser(req)?.email || 'admin';
    
    await db.execute(sql`UPDATE trackman_unmatched_bookings SET resolved_at = NOW(), resolved_by = ${staffEmail} WHERE id = ${recordId} AND resolved_at IS NULL`);
    
    logFromRequest(req, 'dismiss', 'trackman_unmatched', undefined, 'Trackman unmatched #' + recordId, { action: 'dismiss_from_integrity' });
    
    res.json({ success: true, message: 'Unmatched booking dismissed' });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Dismiss trackman unmatched error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-booking-participant', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    
    await db.execute(sql`DELETE FROM booking_participants WHERE id = ${recordId}`);
    
    logFromRequest(req, 'delete_orphan_booking_participant', 'booking_participants', recordId, undefined, { deletedId: recordId });
    
    res.json({ success: true, message: `Deleted orphaned booking participant ${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete booking participant error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/fix-orphaned-participants', isAdmin, validateBody(dryRunSchema), async (req: Request, res) => {
  try {
    const { dryRun } = req.body;
    
    const invalidParticipants = await db.execute(sql`
      SELECT bp.id, bp.user_id, bp.display_name, bp.participant_type, bp.session_id
      FROM booking_participants bp
      LEFT JOIN users u ON bp.user_id = u.id
      WHERE bp.user_id IS NOT NULL AND bp.user_id != '' AND u.id IS NULL
    `);
    
    interface OrphanedParticipantRow { id: number; user_id: string; display_name: string; participant_type: string; session_id: number }
    const rows = invalidParticipants.rows as unknown as OrphanedParticipantRow[];
    
    if (rows.length === 0) {
      return res.json({ success: true, message: 'No orphaned participants found', relinked: 0, converted: 0, total: 0, dryRun });
    }
    
    const relinked: Array<{ id: number; displayName: string; oldUserId: string; newUserId: string; email: string }> = [];
    const toConvert: Array<{ id: number; displayName: string; userId: string }> = [];
    
    for (const row of rows) {
      const emailMatch = await db.execute(sql`
        SELECT id, email FROM users WHERE LOWER(email) = LOWER(${row.user_id}) LIMIT 1
      `);
      
      if (emailMatch.rows.length > 0) {
        const matchedUser = emailMatch.rows[0] as { id: string; email: string };
        relinked.push({
          id: row.id as number,
          displayName: row.display_name as string,
          oldUserId: row.user_id as string,
          newUserId: matchedUser.id as string,
          email: matchedUser.email as string
        });
      } else {
        toConvert.push({
          id: row.id as number,
          displayName: row.display_name as string,
          userId: row.user_id as string
        });
      }
    }
    
    if (!dryRun) {
      for (const item of relinked) {
        await db.execute(sql`
          UPDATE booking_participants 
          SET user_id = ${item.newUserId}
          WHERE id = ${item.id}
        `);
      }
      
      for (const item of toConvert) {
        await db.execute(sql`
          UPDATE booking_participants 
          SET user_id = NULL, participant_type = 'guest'
          WHERE id = ${item.id}
        `);
      }
      
      logFromRequest(req, 'fix_orphaned_participants', 'booking_participants', undefined, undefined, {
        relinkedCount: relinked.length,
        convertedCount: toConvert.length,
        totalFixed: rows.length,
        relinkedIds: relinked.map(r => r.id),
        convertedIds: toConvert.map(c => c.id)
      });
      
      logger.info('[DataIntegrity] Fixed orphaned participants', { extra: { relinked: relinked.length, converted: toConvert.length, total: rows.length } });
    }
    
    res.json({
      success: true,
      message: dryRun
        ? `Found ${rows.length} orphaned participants: ${relinked.length} can be re-linked to existing members, ${toConvert.length} will be converted to guests`
        : `Fixed ${rows.length} orphaned participants: ${relinked.length} re-linked, ${toConvert.length} converted to guests`,
      relinked: relinked.length,
      converted: toConvert.length,
      total: rows.length,
      dryRun,
      relinkedDetails: relinked.slice(0, 20),
      convertedDetails: toConvert.slice(0, 20)
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Fix orphaned participants error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/convert-participant-to-guest', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    
    await db.execute(sql`
      UPDATE booking_participants 
      SET user_id = NULL, participant_type = 'guest'
      WHERE id = ${recordId}
    `);
    
    logFromRequest(req, 'convert_participant_to_guest', 'booking_participants', recordId, undefined, { convertedId: recordId });
    
    res.json({ success: true, message: `Converted participant ${recordId} to guest` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Convert participant to guest error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/approve-review-item', isAdmin, validateBody(reviewItemSchema), async (req: Request, res) => {
  try {
    const { recordId, table } = req.body;
    
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    if (table === 'wellness_classes') {
      await db.execute(sql`UPDATE wellness_classes 
        SET needs_review = false, reviewed_by = ${reviewedBy}, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true, conflict_detected = false, locally_edited = true, app_last_modified_at = NOW()
        WHERE id = ${recordId}`);
    } else if (table === 'events') {
      await db.execute(sql`UPDATE events SET needs_review = false WHERE id = ${recordId}`);
    }
    
    logFromRequest(req, 'approve_review_item', table as ResourceType, recordId, undefined, { table, reviewedBy });
    
    res.json({ success: true, message: `Approved ${table === 'wellness_classes' ? 'wellness class' : 'event'} #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Approve review item error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-review-item', isAdmin, validateBody(reviewItemSchema), async (req: Request, res) => {
  try {
    const { recordId, table } = req.body;
    
    if (table === 'wellness_classes') {
      await db.execute(sql`UPDATE wellness_classes SET is_active = false, updated_at = NOW() WHERE id = ${recordId}`);
    } else if (table === 'events') {
      await db.execute(sql`DELETE FROM events WHERE id = ${recordId}`);
    }
    
    logFromRequest(req, 'delete_review_item', table as ResourceType, recordId, undefined, { table });
    
    res.json({ success: true, message: `Removed ${table === 'wellness_classes' ? 'wellness class' : 'event'} #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete review item error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/approve-all-review-items', isAdmin, validateBody(dryRunSchema), async (req: Request, res) => {
  try {
    const { dryRun } = req.body;
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    const wellnessCount = await db.execute(sql`SELECT COUNT(*)::int as count FROM wellness_classes WHERE needs_review = true AND is_active = true`);
    const eventCount = await db.execute(sql`SELECT COUNT(*)::int as count FROM events WHERE needs_review = true`);
    
    const wCount = (wellnessCount.rows[0] as { count: number })?.count || 0;
    const eCount = (eventCount.rows[0] as { count: number })?.count || 0;
    const total = Number(wCount) + Number(eCount);
    
    if (!dryRun) {
      if (Number(wCount) > 0) {
        await db.execute(sql`UPDATE wellness_classes 
          SET needs_review = false, reviewed_by = ${reviewedBy}, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true, conflict_detected = false, locally_edited = true, app_last_modified_at = NOW()
          WHERE needs_review = true AND is_active = true`);
      }
      if (Number(eCount) > 0) {
        await db.execute(sql`UPDATE events SET needs_review = false WHERE needs_review = true`);
      }
      
      logFromRequest(req, 'approve_all_review_items', 'wellness_classes', undefined, undefined, { wellnessApproved: wCount, eventsApproved: eCount, total, reviewedBy });
    }
    
    res.json({
      success: true,
      message: dryRun
        ? `Found ${total} items needing review: ${wCount} wellness classes, ${eCount} events`
        : `Approved ${total} items: ${wCount} wellness classes, ${eCount} events`,
      wellnessCount: wCount,
      eventCount: eCount,
      total,
      dryRun
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Approve all review items error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-empty-session', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { recordId } = req.body;

    await client.query('BEGIN');

    const sessionCheck = await client.query(
      'SELECT bs.id FROM booking_sessions bs LEFT JOIN booking_participants bp ON bp.session_id = bs.id WHERE bs.id = $1 GROUP BY bs.id HAVING COUNT(bp.id) = 0',
      [recordId]
    );

    if (sessionCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Session not found or has participants' });
    }

    await client.query('UPDATE booking_requests SET session_id = NULL WHERE session_id = $1', [recordId]);

    const deleteResult = await client.query('DELETE FROM booking_sessions WHERE id = $1', [recordId]);

    if (deleteResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Session not found or already deleted' });
    }

    await client.query('COMMIT');

    logFromRequest(req, 'delete', 'booking_session', recordId.toString(), 'Deleted empty session', {});

    res.json({ success: true, message: `Deleted empty session #${recordId}` });
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) { logger.warn('[DB] Rollback failed:', { error: rollbackErr }); }
    logger.error('[DataIntegrity] Delete empty session error', { error: getErrorMessage(error) } as Record<string, unknown>);
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/assign-session-owner', isAdmin, validateBody(assignSessionOwnerSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { sessionId, ownerEmail, additional_players } = req.body;

    const session = await client.query(
      `SELECT bs.id, bs.resource_id, bs.session_date, bs.start_time, bs.end_time, r.name as resource_name
       FROM booking_sessions bs
       LEFT JOIN resources r ON bs.resource_id = r.id
       WHERE bs.id = $1`,
      [sessionId]
    );
    if (!session.rows.length) return res.status(404).json({ success: false, message: 'Session not found' });

    const user = await client.query(
      `SELECT id, email, first_name, last_name, membership_tier FROM users WHERE LOWER(email) = LOWER($1)`,
      [ownerEmail]
    );
    if (!user.rows.length) return res.status(404).json({ success: false, message: 'Member not found' });

    const member = user.rows[0];
    const sess = session.rows[0];

    await client.query('BEGIN');

    const existingParticipant = await client.query(
      `SELECT id FROM booking_participants WHERE session_id = $1 AND user_id = $2`,
      [sessionId, member.id]
    );

    if (existingParticipant.rows.length === 0) {
      await client.query(
        `INSERT INTO booking_participants (session_id, user_id, display_name, participant_type, created_at)
         VALUES ($1, $2, $3, 'member', NOW())`,
        [sessionId, member.id, [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email]
      );
    }

    let bookingId: number | null = null;
    const linkedBooking = await client.query(
      `SELECT id FROM booking_requests WHERE session_id = $1 LIMIT 1`,
      [sessionId]
    );
    if (linkedBooking.rows.length > 0) {
      bookingId = linkedBooking.rows[0].id;
      await client.query(
        `UPDATE booking_requests SET user_id = $1, user_email = $2, user_name = $3 WHERE id = $4 AND (user_email IS NULL OR user_email = '')`,
        [member.id, member.email, [member.first_name, member.last_name].filter(Boolean).join(' '), bookingId]
      );
    }

    if (Array.isArray(additional_players) && additional_players.length > 0) {
      const rpEntries = additional_players.map((p: { type: string; email?: string; name?: string; userId?: string; guest_name?: string }) => {
        if (p.type === 'guest_placeholder') {
          return { type: 'guest', name: p.guest_name || p.name || 'Guest' };
        }
        return { type: p.type === 'visitor' ? 'visitor' : 'member', email: p.email, name: p.name, userId: p.userId };
      });

      for (const rp of rpEntries) {
        if (rp.type === 'guest') {
          await client.query(
            `INSERT INTO booking_participants (session_id, display_name, participant_type, created_at)
             VALUES ($1, $2, 'guest', NOW())`,
            [sessionId, rp.name || 'Guest']
          );
        } else if (rp.email) {
          const playerUser = await client.query(
            `SELECT id, email, first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)`,
            [rp.email]
          );
          if (playerUser.rows.length > 0) {
            const pu = playerUser.rows[0];
            await client.query(
              `INSERT INTO booking_participants (session_id, user_id, display_name, participant_type, created_at)
               VALUES ($1, $2, $3, 'member', NOW())
               ON CONFLICT DO NOTHING`,
              [sessionId, pu.id, [pu.first_name, pu.last_name].filter(Boolean).join(' ') || pu.email]
            );
          }
        }
      }

      if (bookingId) {
        await client.query(
          `UPDATE booking_requests SET request_participants = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(rpEntries), bookingId]
        );
      }

      logger.info('[DataIntegrity] Saved additional players for session owner assignment', {
        extra: { sessionId, bookingId, playerCount: rpEntries.length }
      });
    }

    await client.query('COMMIT');

    const displayName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;
    logFromRequest(req, 'assign_session', 'booking_session', String(sessionId),
      `Assigned ${displayName} as owner of session #${sessionId} on ${sess.session_date} (${sess.resource_name})`,
      { memberEmail: member.email, sessionDate: sess.session_date }
    );

    res.json({ success: true, message: `Assigned ${displayName} to session on ${sess.session_date} at ${sess.resource_name}` });
  } catch (error: unknown) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr: unknown) { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); }
    logger.error('[DataIntegrity] Assign session owner error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/complete-booking', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(sql`
      UPDATE booking_requests 
      SET status = 'attended', is_unmatched = false, updated_at = NOW() 
      WHERE id = ${recordId} AND status IN ('pending', 'approved', 'confirmed')
    `);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Booking not found or not in pending/approved/confirmed status' });
    }

    logFromRequest(req, 'complete_booking', 'booking_request', String(recordId), `Marked booking #${recordId} as attended via data integrity`, { bookingId: recordId });

    res.json({ success: true, message: `Booking #${recordId} marked as attended` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Complete booking error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/cancel-stale-booking', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(sql`
      UPDATE booking_requests 
      SET status = 'cancelled', cancellation_reason = 'Auto-cancelled: stale booking past start time', updated_at = NOW()
      WHERE id = ${recordId} AND status IN ('pending', 'approved')
      RETURNING stripe_invoice_id
    `);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Booking not found or not in pending/approved status' });
    }

    const invoiceId = (result.rows[0] as { stripe_invoice_id: string | null })?.stripe_invoice_id;
    if (invoiceId) {
      try {
        const { voidBookingInvoice } = await import('../../core/billing/bookingInvoiceService');
        await voidBookingInvoice(recordId);
      } catch (voidErr: unknown) {
        logger.warn('[DataIntegrity] Failed to void invoice for cancelled stale booking', {
          extra: { bookingId: recordId, invoiceId, error: getErrorMessage(voidErr) }
        });
      }
    }

    try {
      const { refundSucceededPaymentIntentsForBooking } = await import('../../core/billing/paymentIntentCleanup');
      await refundSucceededPaymentIntentsForBooking(recordId);
    } catch (refundErr: unknown) {
      logger.warn('[DataIntegrity] Failed to refund succeeded PIs for stale booking', { extra: { bookingId: recordId, error: getErrorMessage(refundErr) } });
    }

    try {
      const { voidBookingPass } = await import('../../walletPass/bookingPassService');
      voidBookingPass(recordId).catch(err => logger.warn('[DataIntegrity] Failed to void wallet pass for stale booking', { extra: { bookingId: recordId, error: getErrorMessage(err) } }));
    } catch (importErr: unknown) {
      logger.warn('[DataIntegrity] Failed to import voidBookingPass', { extra: { error: getErrorMessage(importErr) } });
    }

    try {
      await db.execute(sql`UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${recordId} AND status IN ('pending', 'requires_action')`);
    } catch (snapshotErr: unknown) {
      logger.warn('[DataIntegrity] Non-blocking: failed to cancel fee snapshots for stale booking', { extra: { bookingId: recordId, error: getErrorMessage(snapshotErr) } });
    }

    logFromRequest(req, 'cancel_stale_booking', 'booking_request', String(recordId), `Cancelled stale booking #${recordId} via data integrity`, { bookingId: recordId });

    res.json({ success: true, message: `Stale booking #${recordId} cancelled` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Cancel stale booking error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/bulk-cancel-stale-bookings', isAdmin, async (req: Request, res) => {
  try {
    const result = await db.execute(sql`
      UPDATE booking_requests
      SET status = 'cancelled', cancellation_reason = 'Bulk auto-cancelled: stale booking past start time', updated_at = NOW()
      WHERE status IN ('pending', 'approved')
        AND (request_date + start_time::time) < ((NOW() AT TIME ZONE 'America/Los_Angeles') - INTERVAL '24 hours')
        AND request_date >= CURRENT_DATE - INTERVAL '7 days'
        AND user_email NOT LIKE '%@trackman.local'
      RETURNING id, stripe_invoice_id
    `);

    const count = result.rowCount || 0;

    const invoiceRows = (result.rows as { id: number; stripe_invoice_id: string | null }[]).filter(r => r.stripe_invoice_id);

    logFromRequest(req, 'bulk_cancel_stale_bookings', 'booking_request', undefined, `Bulk cancelled ${count} stale bookings via data integrity`, { cancelledCount: count, invoicesToVoid: invoiceRows.length });

    const cancelledIds = (result.rows as { id: number }[]).map(r => r.id);
    if (cancelledIds.length > 0) {
      try {
        await db.execute(sql`UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ANY(${cancelledIds}::int[]) AND status IN ('pending', 'requires_action')`);
      } catch (snapshotErr: unknown) {
        logger.warn('[DataIntegrity] Non-blocking: failed to cancel fee snapshots for bulk stale cancel', { extra: { error: getErrorMessage(snapshotErr) } });
      }
    }

    res.json({ success: true, message: `Cancelled ${count} stale bookings (${invoiceRows.length} invoices voiding in background)`, cancelledCount: count });

    if (invoiceRows.length > 0) {
      const { voidBookingInvoice } = await import('../../core/billing/bookingInvoiceService');
      let voided = 0;
      for (const row of invoiceRows) {
        try {
          await voidBookingInvoice(row.id);
          voided++;
        } catch (voidErr: unknown) {
          logger.warn('[DataIntegrity] Failed to void invoice during bulk stale cancel', {
            extra: { bookingId: row.id, invoiceId: row.stripe_invoice_id, error: getErrorMessage(voidErr) }
          });
        }
      }
      logger.info(`[DataIntegrity] Bulk stale cancel invoice cleanup complete: ${voided}/${invoiceRows.length} voided`);
    }

    if (cancelledIds.length > 0) {
      const { refundSucceededPaymentIntentsForBooking } = await import('../../core/billing/paymentIntentCleanup');
      const { voidBookingPass } = await import('../../walletPass/bookingPassService');
      for (const id of cancelledIds) {
        try {
          await refundSucceededPaymentIntentsForBooking(id);
        } catch (refundErr: unknown) {
          logger.warn('[DataIntegrity] Failed to refund succeeded PIs during bulk stale cancel', { extra: { bookingId: id, error: getErrorMessage(refundErr) } });
        }
        voidBookingPass(id).catch(err => logger.warn('[DataIntegrity] Failed to void wallet pass during bulk stale cancel', { extra: { bookingId: id, error: getErrorMessage(err) } }));
      }
    }
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Bulk cancel stale bookings error', { extra: { error: getErrorMessage(error) } });
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
    }
  }
});

router.post('/api/data-integrity/fix/bulk-attend-stale-bookings', isAdmin, async (req: Request, res) => {
  try {
    const result = await db.execute(sql`
      UPDATE booking_requests
      SET status = 'attended', is_unmatched = false, updated_at = NOW()
      WHERE status IN ('pending', 'approved')
        AND (request_date + start_time::time) < ((NOW() AT TIME ZONE 'America/Los_Angeles') - INTERVAL '24 hours')
        AND request_date >= CURRENT_DATE - INTERVAL '7 days'
        AND user_email NOT LIKE '%@trackman.local'
      RETURNING id
    `);

    const count = result.rowCount || 0;

    logFromRequest(req, 'bulk_attend_stale_bookings', 'booking_request', undefined, `Bulk marked ${count} stale bookings as attended via data integrity`, { attendedCount: count });

    res.json({ success: true, message: `Marked ${count} stale bookings as attended`, attendedCount: count });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Bulk attend stale bookings error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

export default router;
