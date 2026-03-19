import { Router } from 'express';
import { cancelPaymentIntent } from '../../core/stripe/payments';
import { queueIntegrityFixSync } from '../../core/hubspot/queueHelpers';
import { logger, isAdmin, validateBody, db, sql, pool, safeRelease, logFromRequest, getSessionUser, getErrorMessage, sendFixError } from './shared';
import type { Request } from 'express';
import { unlinkHubspotSchema, mergeHubspotSchema, mergeStripeSchema, changeBillingProviderSchema, acceptTierSchema, userIdSchema, recordIdSchema, cancelOrphanedPiSchema, updateTourStatusSchema, clearStripeIdSchema, deleteOrphanByEmailSchema, bulkChangeBillingProviderSchema, linkStripeCustomerOnlySchema, reconnectStripeSubscriptionSchema, bulkReconnectStripeSchema } from '../../../shared/validators/dataIntegrity';

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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
       SET tier = $2, tier_id = COALESCE((SELECT id FROM membership_tiers WHERE LOWER(name) = LOWER($2) LIMIT 1), tier_id), updated_at = NOW(),
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
    sendFixError(res, error);
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
    sendFixError(res, error);
  }
});

router.post('/api/data-integrity/fix/clear-stripe-customer-id', isAdmin, validateBody(clearStripeIdSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [userId]);

    const userResult = await client.query(
      `SELECT id, email, first_name, last_name, stripe_customer_id FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = userResult.rows[0];
    const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;

    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    const customers = await stripe.customers.list({ email: (user.email || '').toLowerCase(), limit: 10 });
    const nonDeletedCustomers = customers.data.filter((c: { deleted?: boolean }) => !c.deleted);

    const matchingCustomer = nonDeletedCustomers.find((c: { metadata?: Record<string, string> }) => c.metadata?.userId === String(userId)) || nonDeletedCustomers[0];

    if (matchingCustomer) {
      let subscriptionId: string | null = null;
      const subscriptions = await stripe.subscriptions.list({ customer: matchingCustomer.id, limit: 10 });
      const activeSub = subscriptions.data.find((s: { status: string }) => ['active', 'past_due', 'trialing'].includes(s.status));
      if (activeSub) {
        subscriptionId = activeSub.id;
      }

      await client.query(
        `UPDATE users 
         SET stripe_customer_id = $2, 
             stripe_subscription_id = $3,
             billing_provider = CASE WHEN $3 IS NOT NULL THEN 'stripe' ELSE billing_provider END,
             updated_at = NOW(),
             last_manual_fix_at = NOW(), last_manual_fix_by = $4
         WHERE id = $1`,
        [userId, matchingCustomer.id, subscriptionId, staffEmail]
      );

      await client.query('COMMIT');

      const action = subscriptionId
        ? `Re-linked to Stripe customer ${matchingCustomer.id} with subscription ${subscriptionId}`
        : `Re-linked to Stripe customer ${matchingCustomer.id} (no active subscription found)`;
      logFromRequest(req, 'relink_stripe_customer', 'user', String(userId), `${action} for "${memberName}" via data integrity (was orphaned: ${user.stripe_customer_id})`, { userId, oldCustomerId: user.stripe_customer_id, newCustomerId: matchingCustomer.id, subscriptionId });

      res.json({ success: true, message: `${action} for "${memberName}"`, relinked: true, customerId: matchingCustomer.id, subscriptionId });
    } else {
      await client.query(
        `UPDATE users 
         SET stripe_customer_id = NULL, stripe_subscription_id = NULL, billing_provider = NULL, updated_at = NOW(),
             last_manual_fix_at = NOW(), last_manual_fix_by = $2
         WHERE id = $1`,
        [userId, staffEmail]
      );

      await client.query('COMMIT');

      logFromRequest(req, 'clear_stripe_customer_id', 'user', String(userId), `No matching Stripe customer found by email for "${memberName}" — cleared orphaned ID ${user.stripe_customer_id}`, { userId, oldCustomerId: user.stripe_customer_id });

      res.json({ success: true, message: `No matching Stripe customer found for "${memberName}" by email — cleared orphaned billing fields`, relinked: false });
    }
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Fix orphaned Stripe customer ID error', { extra: { error: getErrorMessage(error) } });
    sendFixError(res, error);
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/bulk-change-billing-provider', isAdmin, validateBody(bulkChangeBillingProviderSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userIds, newProvider } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');

    const results: { userId: string; email: string; success: boolean }[] = [];

    for (const userId of userIds) {
      const result = await client.query(
        `UPDATE users 
         SET billing_provider = $2, updated_at = NOW(),
             last_manual_fix_at = NOW(), last_manual_fix_by = $3
         WHERE id = $1
         RETURNING email, tier, membership_status`,
        [userId, newProvider, staffEmail]
      );

      if (result.rowCount && result.rowCount > 0) {
        const userEmail = result.rows[0]?.email;
        results.push({ userId, email: userEmail || '', success: true });

        if (userEmail) {
          queueIntegrityFixSync({ email: userEmail, billingProvider: newProvider, tier: result.rows[0]?.tier || '', status: result.rows[0]?.membership_status || '', fixAction: 'bulk_change_billing_provider', performedBy: staffEmail }).catch(err => logger.warn('[DataIntegrity] HubSpot sync queue failed', { extra: { error: getErrorMessage(err) } }));
        }
      } else {
        results.push({ userId, email: '', success: false });
      }
    }

    await client.query('COMMIT');

    const successCount = results.filter(r => r.success).length;

    logFromRequest(req, 'bulk_change_billing_provider', 'user', undefined, `Bulk changed billing provider to ${newProvider} for ${successCount}/${userIds.length} members`, {
      newProvider,
      userIds,
      successCount,
      results
    });

    res.json({ success: true, message: `Changed billing provider to ${newProvider} for ${successCount} member(s)`, results });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Bulk change billing provider error', { extra: { error: getErrorMessage(error) } });
    sendFixError(res, error);
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/link-stripe-customer-only', isAdmin, validateBody(linkStripeCustomerOnlySchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [userId]);

    const userResult = await client.query(
      `SELECT id, email, first_name, last_name, tier, stripe_customer_id FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = userResult.rows[0];

    if (user.stripe_customer_id) {
      await client.query('ROLLBACK');
      return res.json({ success: true, message: `Member already has Stripe customer ${user.stripe_customer_id}`, customerId: user.stripe_customer_id, alreadyLinked: true });
    }

    await client.query('COMMIT');

    const { getOrCreateStripeCustomer } = await import('../../core/stripe/customers');
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined;
    const custResult = await getOrCreateStripeCustomer(String(user.id), user.email, fullName as string, user.tier as string);

    logFromRequest(req, 'link_stripe_customer_only', 'user', String(userId), `Linked Stripe customer ${custResult.customerId} to "${fullName || user.email}" (${custResult.isNew ? 'created new' : 'found existing'}) — NO subscription created`, {
      userId,
      customerId: custResult.customerId,
      isNew: custResult.isNew,
      performedBy: staffEmail
    });

    res.json({
      success: true,
      message: `Linked Stripe customer ${custResult.customerId} to member (${custResult.isNew ? 'created new' : 'found existing'}). No subscription was created.`,
      customerId: custResult.customerId,
      isNew: custResult.isNew
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Link Stripe customer only error', { extra: { error: getErrorMessage(error) } });
    sendFixError(res, error);
  } finally {
    safeRelease(client);
  }
});

async function reconnectSingleMember(userId: string, staffEmail: string): Promise<{
  success: boolean;
  message: string;
  customerId?: string;
  subscriptionId?: string;
  subscriptionStatus?: string;
}> {
  const { getStripeClient } = await import('../../core/stripe/client');
  const stripe = await getStripeClient();

  const userResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, billing_provider,
           stripe_customer_id, stripe_subscription_id, membership_status
    FROM users WHERE id = ${userId}
  `);

  if (userResult.rows.length === 0) {
    return { success: false, message: 'User not found' };
  }

  const user = userResult.rows[0] as Record<string, string | null>;
  const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;

  if (user.stripe_subscription_id) {
    return { success: true, message: `"${memberName}" already has subscription ${user.stripe_subscription_id}`, subscriptionId: user.stripe_subscription_id };
  }

  const customers = await stripe.customers.list({ email: (user.email || '').toLowerCase(), limit: 10 });
  const nonDeletedCustomers = customers.data.filter(c => !c.deleted);

  if (nonDeletedCustomers.length === 0) {
    const { getOrCreateStripeCustomer } = await import('../../core/stripe/customers');
    try {
      const { customerId, isNew } = await getOrCreateStripeCustomer(userId, (user.email || '').toLowerCase(), memberName, user.tier || undefined);
      return {
        success: true,
        message: `${isNew ? 'Created' : 'Linked'} Stripe customer ${customerId} for "${memberName}" (${user.email}). No subscription found.`,
        customerId
      };
    } catch (createErr: unknown) {
      return { success: false, message: `Could not create Stripe customer for "${memberName}" (${user.email}): ${getErrorMessage(createErr)}` };
    }
  }

  if (nonDeletedCustomers.length > 1) {
    const metadataMatch = nonDeletedCustomers.find(c => c.metadata?.userId === String(userId));
    if (!metadataMatch) {
      return {
        success: false,
        message: `Found ${nonDeletedCustomers.length} Stripe customers for "${memberName}" (${user.email}): ${nonDeletedCustomers.map(c => c.id).join(', ')}. Cannot auto-reconnect — please link manually to avoid mis-matching.`
      };
    }
  }

  const matchingCustomer = nonDeletedCustomers.find(c => c.metadata?.userId === String(userId)) || nonDeletedCustomers[0];

  const subscriptions = await stripe.subscriptions.list({
    customer: matchingCustomer.id,
    limit: 10,
  });

  const activeSub = subscriptions.data.find(s => ['active', 'past_due', 'trialing'].includes(s.status));

  if (!activeSub) {
    await db.execute(sql`
      UPDATE users
      SET stripe_customer_id = ${matchingCustomer.id},
          updated_at = NOW()
      WHERE id = ${userId}
    `);
    if (user.billing_provider === 'mindbody') {
      return {
        success: true,
        message: `Customer ID restored for "${memberName}" (${matchingCustomer.id}) — member is MindBody-billed, no Stripe subscription needed.`,
        customerId: matchingCustomer.id
      };
    }
    return {
      success: true,
      message: `Customer ID restored for "${memberName}" (${matchingCustomer.id}). No active subscription found (${subscriptions.data.length} total, statuses: ${subscriptions.data.map(s => s.status).join(', ') || 'none'}). Member may need a new subscription or should be marked comped/manual.`,
      customerId: matchingCustomer.id
    };
  }

  await db.execute(sql`
    UPDATE users
    SET stripe_customer_id = ${matchingCustomer.id},
        stripe_subscription_id = ${activeSub.id},
        billing_provider = 'stripe',
        updated_at = NOW()
    WHERE id = ${userId}
  `);

  queueIntegrityFixSync({
    email: user.email || '',
    fixAction: 'reconnect_stripe_subscription',
    billingProvider: 'stripe',
    tier: user.tier || undefined,
    performedBy: staffEmail
  }).catch((err: unknown) => {
    logger.warn('[DataIntegrity] HubSpot sync after reconnect failed (non-blocking)', { extra: { error: getErrorMessage(err), userId } });
  });

  return {
    success: true,
    message: `Reconnected "${memberName}" — customer ${matchingCustomer.id}, subscription ${activeSub.id} (${activeSub.status})`,
    customerId: matchingCustomer.id,
    subscriptionId: activeSub.id,
    subscriptionStatus: activeSub.status
  };
}

router.post('/api/data-integrity/fix/reconnect-stripe-subscription', isAdmin, validateBody(reconnectStripeSubscriptionSchema), async (req: Request, res) => {
  try {
    const { userId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    const result = await reconnectSingleMember(userId, staffEmail);

    logFromRequest(req, 'reconnect_stripe_subscription', 'user', userId, result.message, {
      userId,
      customerId: result.customerId,
      subscriptionId: result.subscriptionId,
      subscriptionStatus: result.subscriptionStatus,
      performedBy: staffEmail
    });

    res.status(result.success ? 200 : 404).json(result);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Reconnect Stripe subscription error', { extra: { error: getErrorMessage(error) } });
    sendFixError(res, error);
  }
});

router.post('/api/data-integrity/fix/bulk-reconnect-stripe', isAdmin, validateBody(bulkReconnectStripeSchema), async (req: Request, res) => {
  try {
    const { userIds } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    const results: Array<{ userId: string; success: boolean; message: string; customerId?: string; subscriptionId?: string }> = [];

    for (const userId of userIds) {
      try {
        const result = await reconnectSingleMember(userId, staffEmail);
        results.push({ userId, ...result });
      } catch (err: unknown) {
        results.push({ userId, success: false, message: getErrorMessage(err) });
      }
    }

    const reconnected = results.filter(r => r.success && r.subscriptionId);
    const customerRestored = results.filter(r => r.success && !r.subscriptionId && r.customerId);
    const failed = results.filter(r => !r.success);

    logFromRequest(req, 'bulk_reconnect_stripe', 'user', `bulk:${userIds.length}`, `Bulk reconnect: ${reconnected.length} fully reconnected, ${customerRestored.length} customer ID restored, ${failed.length} not found`, {
      totalRequested: userIds.length,
      reconnectedCount: reconnected.length,
      customerRestoredCount: customerRestored.length,
      failedCount: failed.length,
      performedBy: staffEmail,
      userIds: userIds.join(',')
    });

    const totalLinked = reconnected.length + customerRestored.length;
    const parts: string[] = [];
    if (totalLinked > 0) parts.push(`${totalLinked}/${userIds.length} member(s) linked to Stripe`);
    if (reconnected.length > 0) parts.push(`${reconnected.length} with active subscription`);
    if (customerRestored.length > 0) parts.push(`${customerRestored.length} customer-only (no subscription)`);
    if (failed.length > 0) parts.push(`${failed.length} failed`);

    res.json({
      success: true,
      message: parts.join('. ') + '.',
      results,
      summary: {
        reconnected: totalLinked,
        customerRestored: customerRestored.length,
        failed: failed.length,
        total: userIds.length
      }
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Bulk reconnect Stripe error', { extra: { error: getErrorMessage(error) } });
    sendFixError(res, error);
  }
});

export default router;
