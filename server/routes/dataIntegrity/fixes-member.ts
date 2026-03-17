import { Router } from 'express';
import { cancelPaymentIntent } from '../../core/stripe/payments';
import { queueIntegrityFixSync } from '../../core/hubspot/queueHelpers';
import { logger, isAdmin, validateBody, db, sql, pool, safeRelease, logFromRequest, getSessionUser, getErrorMessage, safeErrorDetail } from './shared';
import type { Request } from 'express';
import { unlinkHubspotSchema, mergeHubspotSchema, mergeStripeSchema, changeBillingProviderSchema, acceptTierSchema, userIdSchema, recordIdSchema, cancelOrphanedPiSchema, updateTourStatusSchema, clearStripeIdSchema, deleteOrphanByEmailSchema } from '../../../shared/validators/dataIntegrity';

const router = Router();

router.post('/api/data-integrity/fix/unlink-hubspot', isAdmin, validateBody(unlinkHubspotSchema), async (req: Request, res) => {
  try {
    const { userId, hubspotContactId } = req.body;
    
    await db.execute(sql`UPDATE users SET hubspot_id = NULL, updated_at = NOW() WHERE id = ${userId}`);
    
    logFromRequest(req, 'unlink_hubspot_contact', 'user', userId, undefined, {
      hubspotContactId,
      unlinkedUserId: userId
    });
    
    res.json({ success: true, message: `Unlinked HubSpot contact from user ${userId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Unlink HubSpot error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/merge-hubspot-duplicates', isAdmin, validateBody(mergeHubspotSchema), async (req: Request, res) => {
  try {
    const { primaryUserId, secondaryUserId, hubspotContactId } = req.body;
    
    const sessionUser = getSessionUser(req);
    const { executeMerge } = await import('../../core/userMerge');
    
    const result = await executeMerge(primaryUserId, secondaryUserId, sessionUser?.email || 'admin');
    
    logFromRequest(req, 'merge_hubspot_duplicates', 'user', primaryUserId, undefined, {
      secondary_user_id: secondaryUserId,
      hubspot_contact_id: hubspotContactId,
      records_merged: result.recordsMerged,
      merged_lifetime_visits: result.mergedLifetimeVisits,
      trigger: 'hubspot_id_duplicate_fix'
    });
    
    res.json({ 
      success: true, 
      message: `Merged user into primary account. ${result.mergedLifetimeVisits} lifetime visits combined.`,
      result 
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Merge HubSpot duplicates error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/merge-stripe-customers', isAdmin, validateBody(mergeStripeSchema), async (req: Request, res) => {
  try {
    const { keepCustomerId, removeCustomerId } = req.body;
    const email = req.body.email.trim().toLowerCase();

    const result = await db.execute(sql`
      UPDATE users 
      SET stripe_customer_id = ${keepCustomerId}, updated_at = NOW() 
      WHERE LOWER(email) = LOWER(${email}) AND stripe_customer_id = ${removeCustomerId}
    `);

    logFromRequest(req, 'merge_stripe_customers', 'user', undefined, `Merged Stripe customers for ${email}`, {
      email,
      keepCustomerId,
      removeCustomerId,
      rowsUpdated: result.rowCount
    });

    res.json({ success: true, message: `Merged Stripe customer for ${email}: kept ${keepCustomerId}, removed ${removeCustomerId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Merge Stripe customers error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/deactivate-stale-member', isAdmin, validateBody(userIdSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [userId]);

    const result = await client.query(
      `UPDATE users 
       SET membership_status = 'inactive', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'inactive' THEN NOW() ELSE membership_status_changed_at END, updated_at = NOW(),
           last_manual_fix_at = NOW(), last_manual_fix_by = $2
       WHERE id = $1 AND billing_provider = 'mindbody'
       RETURNING email, tier`,
      [userId, staffEmail]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `User ${userId} not found or not a MindBody user` });
    }

    await client.query('COMMIT');

    const userEmail = result.rows[0]?.email;
    if (userEmail) {
      queueIntegrityFixSync({ email: userEmail, status: 'inactive', tier: result.rows[0]?.tier || '', fixAction: 'deactivate_stale', performedBy: staffEmail }).catch(err => logger.warn('[DataIntegrity] HubSpot sync queue failed', { extra: { error: getErrorMessage(err) } }));
    }

    logFromRequest(req, 'deactivate_stale_member', 'user', userId.toString(), 'Deactivated stale MindBody member', { userId });

    res.json({ success: true, message: `Deactivated MindBody member #${userId}` });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Deactivate stale member error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/change-billing-provider', isAdmin, validateBody(changeBillingProviderSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId, newProvider } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [userId]);

    const result = await client.query(
      `UPDATE users 
       SET billing_provider = $2, updated_at = NOW(),
           last_manual_fix_at = NOW(), last_manual_fix_by = $3
       WHERE id = $1
       RETURNING email, tier, membership_status`,
      [userId, newProvider, staffEmail]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `User ${userId} not found` });
    }

    await client.query('COMMIT');

    const userEmail = result.rows[0]?.email;
    if (userEmail) {
      queueIntegrityFixSync({ email: userEmail, billingProvider: newProvider, tier: result.rows[0]?.tier || '', status: result.rows[0]?.membership_status || '', fixAction: 'change_billing_provider', performedBy: staffEmail }).catch(err => logger.warn('[DataIntegrity] HubSpot sync queue failed', { extra: { error: getErrorMessage(err) } }));
    }

    logFromRequest(req, 'change_billing_provider', 'user', userId.toString(), `Changed billing provider to ${newProvider}`, { userId, newProvider });

    res.json({ success: true, message: `Changed billing provider to ${newProvider} for user #${userId}` });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Change billing provider error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/delete-member-no-email', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const member = await db.execute(sql`SELECT id, email, first_name, last_name FROM users WHERE id = ${recordId}`);
    if (!member.rows.length) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }
    const user = member.rows[0] as { id: string; email: string | null; first_name: string | null; last_name: string | null };
    if (user.email && String(user.email).trim() !== '') {
      return res.status(400).json({ success: false, message: 'This member has an email address. Cannot delete via this endpoint.' });
    }

    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';

    const cleanups = [
      sql`DELETE FROM booking_participants WHERE user_id = ${recordId}`,
      sql`DELETE FROM notifications WHERE user_id = ${recordId}`,
      sql`DELETE FROM guest_passes WHERE user_id = ${recordId}`,
      sql`UPDATE event_rsvps SET matched_user_id = NULL WHERE matched_user_id = ${recordId}`,
      sql`UPDATE booking_requests SET user_id = NULL WHERE user_id = ${recordId}`,
      sql`DELETE FROM wellness_enrollments WHERE user_id = ${recordId}`,
      sql`DELETE FROM booking_fee_snapshots WHERE user_id = ${recordId}`,
      sql`DELETE FROM day_pass_purchases WHERE user_id = ${recordId}`,
      sql`DELETE FROM terminal_payments WHERE user_id = ${recordId}`,
      sql`DELETE FROM push_subscriptions WHERE user_id = ${recordId}`,
      sql`DELETE FROM stripe_payment_intents WHERE user_id = ${recordId}`,
    ];

    for (const query of cleanups) {
      try { await db.execute(query); } catch (e) {
        logger.warn('[DataIntegrity] Non-critical cleanup step failed during member delete', { extra: { recordId, error: getErrorMessage(e) } });
      }
    }

    await db.execute(sql`DELETE FROM users WHERE id = ${recordId} AND (email IS NULL OR email = '')`);

    logFromRequest(req, 'delete_member', 'user', String(recordId), `Deleted member without email: "${name}" (id: ${recordId})`, { memberName: name });

    res.json({ success: true, message: `Deleted member "${name}" (id: ${recordId})` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete member without email error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/activate-stuck-member', isAdmin, validateBody(userIdSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [userId]);

    const result = await client.query(
      `UPDATE users 
       SET membership_status = 'active', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END, updated_at = NOW(),
           last_manual_fix_at = NOW(), last_manual_fix_by = $2
       WHERE id = $1 AND membership_status IN ('pending', 'non-member')
       RETURNING email, tier`,
      [userId, staffEmail]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found or not in pending/non-member status' });
    }

    await client.query('COMMIT');

    const userEmail = result.rows[0]?.email;
    if (userEmail) {
      queueIntegrityFixSync({ email: userEmail, status: 'active', tier: result.rows[0]?.tier || '', fixAction: 'activate_stuck', performedBy: staffEmail }).catch(err => logger.warn('[DataIntegrity] HubSpot sync queue failed', { extra: { error: getErrorMessage(err) } }));
    }

    logFromRequest(req, 'activate_stuck_member', 'user', String(userId), `Activated stuck member #${userId} via data integrity`, { userId });

    res.json({ success: true, message: `Activated stuck member #${userId}` });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Activate stuck member error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/recalculate-guest-passes', isAdmin, validateBody(userIdSchema), async (req: Request, res) => {
  try {
    const { userId } = req.body;

    await db.execute(sql`
      UPDATE guest_passes gp
      SET passes_used = COALESCE((
        SELECT COUNT(*)
        FROM booking_participants bp
        JOIN booking_sessions bs ON bp.session_id = bs.id
        JOIN booking_requests br ON br.session_id = bs.id
        WHERE bp.guest_pass_id = gp.id
          AND bp.used_guest_pass = true
          AND br.status NOT IN ('cancelled', 'rejected', 'deleted')
      ), 0)
      WHERE gp.user_id = ${userId}
    `);

    logFromRequest(req, 'recalculate_guest_passes', 'guest_pass', String(userId), `Recalculated guest passes for user #${userId} via data integrity`, { userId });

    res.json({ success: true, message: `Recalculated guest passes for user #${userId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Recalculate guest passes error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/release-guest-pass-hold', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(sql`DELETE FROM guest_pass_holds WHERE id = ${recordId}`);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Guest pass hold not found' });
    }

    logFromRequest(req, 'release_guest_pass_hold', 'guest_pass', String(recordId), `Released guest pass hold #${recordId} via data integrity`, { holdId: recordId });

    res.json({ success: true, message: `Released guest pass hold #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Release guest pass hold error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/cancel-orphaned-pi', isAdmin, validateBody(cancelOrphanedPiSchema), async (req: Request, res) => {
  try {
    const { paymentIntentId } = req.body;

    const cancelResult = await cancelPaymentIntent(paymentIntentId);
    if (!cancelResult.success) {
      const errMsg = cancelResult.error || '';
      if (errMsg.includes('already been canceled') || errMsg.includes('already_canceled') || errMsg.includes('already canceled')) {
        logFromRequest(req, 'cancel_orphaned_pi', 'payment_intent', paymentIntentId, `Payment intent ${paymentIntentId} was already cancelled`, { paymentIntentId, alreadyCancelled: true });
      } else {
        throw new Error(errMsg || 'Failed to cancel payment intent');
      }
    }

    const snapshotResult = await db.execute(sql`
      UPDATE booking_fee_snapshots 
      SET status = 'cancelled', updated_at = NOW()
      WHERE stripe_payment_intent_id = ${paymentIntentId}
        AND status IN ('pending', 'requires_action')
      RETURNING id
    `);
    const updatedCount = snapshotResult.rows.length;

    logFromRequest(req, 'cancel_orphaned_pi', 'payment_intent', paymentIntentId, `Cancelled orphaned payment intent ${paymentIntentId} and updated ${updatedCount} fee snapshot(s)`, { paymentIntentId, updatedSnapshots: updatedCount });

    res.json({ success: true, message: `Cancelled payment intent ${paymentIntentId} and updated ${updatedCount} fee snapshot(s)` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Cancel orphaned PI error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-orphan-enrollment', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(sql`DELETE FROM wellness_enrollments WHERE id = ${recordId}`);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Wellness enrollment not found' });
    }

    logFromRequest(req, 'delete_orphan_enrollment', 'wellness_enrollment', String(recordId), `Deleted orphaned wellness enrollment #${recordId} via data integrity`, { enrollmentId: recordId });

    res.json({ success: true, message: `Deleted orphaned wellness enrollment #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete orphan enrollment error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-orphan-rsvp', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(sql`DELETE FROM event_rsvps WHERE id = ${recordId}`);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Event RSVP not found' });
    }

    logFromRequest(req, 'delete_orphan_rsvp', 'event_rsvp', String(recordId), `Deleted orphaned event RSVP #${recordId} via data integrity`, { rsvpId: recordId });

    res.json({ success: true, message: `Deleted orphaned event RSVP #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete orphan RSVP error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-orphan-records-by-email', isAdmin, validateBody(deleteOrphanByEmailSchema), async (req: Request, res) => {
  try {
    const { table, email } = req.body;

    const deleteQueries: Record<string, ReturnType<typeof sql>> = {
      notifications: sql`DELETE FROM notifications WHERE LOWER(user_email) = LOWER(${email}) AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(${email}))`,
      push_subscriptions: sql`DELETE FROM push_subscriptions WHERE LOWER(user_email) = LOWER(${email}) AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(${email}))`,
      user_dismissed_notices: sql`DELETE FROM user_dismissed_notices WHERE LOWER(user_email) = LOWER(${email}) AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(${email}))`,
    };

    const query = deleteQueries[table];
    if (!query) {
      return res.status(400).json({ success: false, message: `Unsupported table: ${table}` });
    }

    const result = await db.execute(query);
    const deleted = (result as { rowCount?: number }).rowCount || 0;
    logFromRequest(req, 'delete_orphan_records', table, email, `Deleted ${deleted} orphaned ${table} records for email ${email} via data integrity`, { email, table, deleted });

    res.json({ success: true, message: `Deleted ${deleted} orphaned record(s) from ${table}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete orphan records by email error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/mark-waiver-signed', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(
      sql`UPDATE users SET waiver_signed_at = NOW(), waiver_version = 'staff_marked', updated_at = NOW() WHERE id = ${recordId} AND membership_status = 'active'`
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Active member not found' });
    }

    logFromRequest(req, 'mark_waiver_signed', 'user', String(recordId), `Marked waiver as signed for member ${recordId} via data integrity`, { userId: recordId });

    res.json({ success: true, message: 'Waiver marked as signed' });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Mark waiver signed error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/accept-tier', isAdmin, validateBody(acceptTierSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId, acceptedTier, source } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [userId]);

    const result = await client.query(
      `UPDATE users 
       SET tier = $2, updated_at = NOW(),
           last_manual_fix_at = NOW(), last_manual_fix_by = $3
       WHERE id = $1
       RETURNING email, membership_status`,
      [userId, acceptedTier, staffEmail]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await client.query('COMMIT');

    const userEmail = result.rows[0]?.email;
    if (userEmail) {
      queueIntegrityFixSync({ email: userEmail, tier: acceptedTier, status: result.rows[0]?.membership_status || '', fixAction: 'accept_tier', performedBy: staffEmail }).catch(err => logger.warn('[DataIntegrity] HubSpot sync queue failed', { extra: { error: getErrorMessage(err) } }));
    }

    logFromRequest(req, 'accept_tier', 'user', String(userId), `Accepted tier "${acceptedTier}" from ${source} for user #${userId} via data integrity`, { userId, acceptedTier, source });

    res.json({ success: true, message: `Accepted tier "${acceptedTier}" from ${source} for user #${userId}` });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Accept tier error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/update-tour-status', isAdmin, validateBody(updateTourStatusSchema), async (req: Request, res) => {
  try {
    const { recordId, newStatus } = req.body;
    const _staffEmail = getSessionUser(req)?.email || 'unknown';

    const result = await db.execute(sql`
      UPDATE tours 
      SET status = ${newStatus}, updated_at = NOW()
      WHERE id = ${Number(recordId)}
      RETURNING id, title, guest_name
    `);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Tour not found' });
    }

    const tour = result.rows[0] as { id: number; title: string; guest_name: string };
    logFromRequest(req, 'update_tour_status', 'tour', String(recordId), `Updated tour #${recordId} "${tour.title}" to "${newStatus}" via data integrity`, { recordId, newStatus });

    res.json({ success: true, message: `Tour "${tour.title}" marked as ${newStatus.replace('_', ' ')}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Update tour status error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/clear-stripe-customer-id', isAdmin, validateBody(clearStripeIdSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [userId]);

    const result = await client.query(
      `UPDATE users 
       SET stripe_customer_id = NULL, updated_at = NOW(),
           last_manual_fix_at = NOW(), last_manual_fix_by = $2
       WHERE id = $1
       RETURNING email, first_name, last_name`,
      [userId, staffEmail]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await client.query('COMMIT');

    const user = result.rows[0];
    const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
    logFromRequest(req, 'clear_stripe_customer_id', 'user', String(userId), `Cleared orphaned Stripe customer ID for "${memberName}" via data integrity`, { userId });

    res.json({ success: true, message: `Cleared Stripe customer ID for "${memberName}"` });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Clear Stripe customer ID error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

export default router;
