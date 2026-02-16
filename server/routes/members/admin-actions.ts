import { Router } from 'express';
import { eq, sql, and } from 'drizzle-orm';
import { db } from '../../db';
import { users, membershipTiers, wellnessEnrollments, eventRsvps, staffUsers } from '../../../shared/schema';
import { isProduction, pool } from '../../core/db';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { getSessionUser } from '../../types/session';
import { TIER_NAMES } from '../../../shared/constants/tiers';
import { getTierRank } from './helpers';
import { createMemberLocally, queueMemberCreation, getAllDiscountRules, handleTierChange, queueTierSync } from '../../core/hubspot';
import { changeSubscriptionTier, pauseSubscription } from '../../core/stripe';
import { notifyMember } from '../../core/notificationService';
import { broadcastTierUpdate } from '../../core/websocket';
import { cascadeEmailChange, previewEmailChangeImpact } from '../../core/memberService/emailChangeService';
import { getAvailableTiersForChange, previewTierChange, commitTierChange } from '../../core/stripe/tierChanges';
import { logFromRequest } from '../../core/auditLog';
import { previewMerge, executeMerge, findPotentialDuplicates } from '../../core/userMerge';
import { getErrorMessage } from '../../utils/errorUtils';

const router = Router();

router.patch('/api/members/:email/tier', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { tier, immediate = false } = req.body;
    const sessionUser = getSessionUser(req);
    
    const normalizedTier = tier === '' || tier === null || tier === undefined ? null : tier;
    
    if (normalizedTier !== null && !TIER_NAMES.includes(normalizedTier as any)) {
      return res.status(400).json({ error: `Invalid tier. Must be one of: ${TIER_NAMES.join(', ')} or empty to clear` });
    }
    
    const normalizedEmail = decodeURIComponent(email as string).toLowerCase();
    
    const userResult = await db.select({
      id: users.id,
      email: users.email,
      tier: users.tier,
      firstName: users.firstName,
      lastName: users.lastName,
      billingProvider: users.billingProvider,
      stripeSubscriptionId: users.stripeSubscriptionId
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = userResult[0];
    const actualTier = member.tier;
    const oldTierDisplay = actualTier || null;
    const newTierDisplay = normalizedTier || null;
    
    if (actualTier === normalizedTier) {
      return res.json({ 
        success: true, 
        message: 'Member is already on this tier',
        member: { id: member.id, email: member.email, tier: normalizedTier }
      });
    }
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET tier = $1, updated_at = $2 WHERE LOWER(email) = $3',
        [normalizedTier, new Date(), normalizedEmail]
      );
      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }

    const performedBy = sessionUser?.email || 'unknown';
    const performedByName = sessionUser?.firstName 
      ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
      : sessionUser?.email?.split('@')[0] || 'Staff';

    let hubspotResult: any = { success: true, oldLineItemRemoved: false, newLineItemAdded: false };

    if (normalizedTier) {
      hubspotResult = await handleTierChange(
        normalizedEmail,
        oldTierDisplay || 'None',
        normalizedTier,
        performedBy,
        performedByName
      );

      if (!hubspotResult.success && hubspotResult.error) {
        console.warn(`[Members] HubSpot tier change failed for ${normalizedEmail}, queuing for retry: ${hubspotResult.error}`);
        await queueTierSync({
          email: normalizedEmail,
          newTier: normalizedTier,
          oldTier: oldTierDisplay || 'None',
          changedBy: performedBy,
          changedByName: performedByName
        });
      }
    } else {
      console.log(`[Members] Tier cleared for ${normalizedEmail}, skipping HubSpot sync (no product mapping for cleared tier)`);
    }

    let stripeSync = { success: true, warning: null as string | null };

    if (member.billingProvider === 'stripe' && member.stripeSubscriptionId && normalizedTier) {
      const tierRecord = await db.select()
        .from(membershipTiers)
        .where(eq(membershipTiers.name, normalizedTier))
        .limit(1);

      if (tierRecord.length > 0 && tierRecord[0].stripePriceId) {
        const isUpgrade = getTierRank(normalizedTier) > getTierRank(oldTierDisplay || '');
        const stripeResult = await changeSubscriptionTier(
          member.stripeSubscriptionId,
          tierRecord[0].stripePriceId,
          immediate || isUpgrade
        );

        if (!stripeResult.success) {
          stripeSync = { success: false, warning: `Stripe update failed: ${stripeResult.error}. Manual billing adjustment may be needed.` };
        }
      } else {
        stripeSync = { success: true, warning: 'Tier updated but Stripe price not configured. Billing unchanged.' };
      }
    } else if (member.billingProvider === 'mindbody') {
      stripeSync = { success: true, warning: 'Tier updated in App & HubSpot. PLEASE UPDATE MINDBODY BILLING MANUALLY.' };
    } else if (!normalizedTier) {
      stripeSync = { success: true, warning: null };
    }

    const isUpgrade = normalizedTier ? getTierRank(normalizedTier) > getTierRank(oldTierDisplay || '') : false;
    const isFirstTier = !oldTierDisplay && normalizedTier;
    const changeType = isFirstTier ? 'set' : (normalizedTier ? (isUpgrade ? 'upgraded' : 'changed') : 'cleared');
    await notifyMember({
      userEmail: normalizedEmail,
      title: isFirstTier ? 'Membership Tier Assigned' : (normalizedTier ? (isUpgrade ? 'Membership Upgraded' : 'Membership Updated') : 'Membership Cleared'),
      message: isFirstTier
        ? `Your membership tier has been set to ${newTierDisplay}`
        : (normalizedTier 
          ? `Your membership has been ${changeType} from ${oldTierDisplay} to ${newTierDisplay}`
          : `Your membership tier has been cleared (was ${oldTierDisplay})`),
      type: 'system',
      url: '/member/profile'
    });

    broadcastTierUpdate({
      action: normalizedTier ? 'updated' : 'removed',
      memberEmail: normalizedEmail,
      tier: normalizedTier || undefined,
      previousTier: actualTier,
      assignedBy: performedBy
    });

    await logFromRequest(req, {
      action: 'change_tier',
      resourceType: 'member',
      resourceId: member.id.toString(),
      resourceName: `${member.firstName || ''} ${member.lastName || ''}`.trim() || member.email || undefined,
      details: {
        memberEmail: normalizedEmail,
        previousTier: oldTierDisplay || 'None',
        newTier: newTierDisplay || 'None',
        billingProvider: member.billingProvider || 'unknown',
        hubspotSynced: hubspotResult.success,
        stripeSynced: stripeSync.success
      }
    });

    res.json({
      success: true,
      message: isFirstTier 
        ? `Member tier set to ${newTierDisplay}` 
        : `Member tier updated from ${oldTierDisplay || 'None'} to ${newTierDisplay || 'None'}`,
      member: {
        id: member.id,
        email: member.email,
        tier: normalizedTier,
        previousTier: oldTierDisplay
      },
      hubspotSync: {
        success: hubspotResult.success,
        oldLineItemRemoved: hubspotResult.oldLineItemRemoved,
        newLineItemAdded: hubspotResult.newLineItemAdded
      },
      stripeSync,
      warning: stripeSync.warning
    });
  } catch (error: unknown) {
    if (!isProduction) console.error('Member tier update error:', error);
    res.status(500).json({ error: 'Failed to update member tier' });
  }
});

router.post('/api/members/:id/suspend', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, durationDays, reason } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!startDate || !durationDays) {
      return res.status(400).json({ error: 'startDate and durationDays are required' });
    }
    
    const start = new Date(startDate);
    const now = new Date();
    const daysUntilStart = (start.getTime() - now.getTime()) / (1000 * 3600 * 24);
    
    if (daysUntilStart < 30) {
      return res.status(400).json({ 
        error: 'Suspension requests must be made at least 30 days in advance.' 
      });
    }
    
    const userResult = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      billingProvider: users.billingProvider,
      stripeSubscriptionId: users.stripeSubscriptionId,
      membershipStatus: users.membershipStatus
    })
      .from(users)
      .where(eq(users.id, id as string));
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = userResult[0];
    
    if (member.billingProvider === 'mindbody') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE users SET membership_status = $1, updated_at = $2 WHERE id = $3',
          ['suspended', new Date(), id]
        );
        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK');
        throw txError;
      } finally {
        client.release();
      }
      
      return res.json({ 
        success: true, 
        warning: 'Member marked suspended in App/HubSpot. PLEASE PAUSE BILLING IN MINDBODY MANUALLY.',
        member: { id: member.id, email: member.email, status: 'suspended' }
      });
    }
    
    if (member.billingProvider === 'stripe' && member.stripeSubscriptionId) {
      const result = await pauseSubscription(member.stripeSubscriptionId, parseInt(durationDays), start);
      
      if (!result.success) {
        return res.status(500).json({ error: result.error || 'Failed to pause subscription' });
      }
      
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE users SET membership_status = $1, updated_at = $2 WHERE id = $3',
          ['suspended', new Date(), id]
        );
        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK');
        throw txError;
      } finally {
        client.release();
      }

      await notifyMember({
        userEmail: member.email || '',
        title: 'Membership Paused',
        message: `Your membership has been paused for ${durationDays} days starting ${start.toLocaleDateString()}.`,
        type: 'system',
        url: '/member/profile'
      });
      
      return res.json({ 
        success: true, 
        message: `Billing suspended for ${durationDays} days starting ${startDate}`,
        resumeDate: result.resumeDate,
        member: { id: member.id, email: member.email, status: 'suspended' }
      });
    }
    
    return res.status(400).json({ error: 'No active billing found for this member.' });
  } catch (error: unknown) {
    if (!isProduction) console.error('Member suspend error:', error);
    res.status(500).json({ error: 'Failed to suspend member' });
  }
});

router.delete('/api/members/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email as string).toLowerCase();
    const sessionUser = getSessionUser(req);
    const archivedBy = sessionUser?.email || 'unknown';
    
    const userResult = await db.select({ 
      id: users.id, 
      email: users.email,
      archivedAt: users.archivedAt,
      stripeSubscriptionId: users.stripeSubscriptionId,
      stripeCustomerId: users.stripeCustomerId
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (userResult[0].archivedAt) {
      return res.status(400).json({ error: 'Member is already archived' });
    }
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE users SET archived_at = $1, archived_by = $2, membership_status = $3, id_image_url = $4, updated_at = $5 WHERE LOWER(email) = $6',
        [new Date(), archivedBy, 'archived', null, new Date(), normalizedEmail]
      );

      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }
    
    let subscriptionCancelled = false;
    const stripeSubscriptionId = userResult[0].stripeSubscriptionId;
    const stripeCustomerId = userResult[0].stripeCustomerId;
    const userEmail = userResult[0].email;

    if (stripeSubscriptionId || stripeCustomerId) {
      try {
        const { getStripeClient } = await import('../../core/stripe/client');
        const stripe = await getStripeClient();
        
        if (stripeSubscriptionId) {
          try {
            const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
            if (['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)) {
              await stripe.subscriptions.cancel(stripeSubscriptionId);
              subscriptionCancelled = true;
              console.log(`[Admin] Cancelled subscription ${stripeSubscriptionId} for archived member ${normalizedEmail}`);
            }
          } catch (subError: unknown) {
            console.error(`[Admin] Failed to cancel subscription ${stripeSubscriptionId}:`, getErrorMessage(subError));
          }
        }
        
        if (!subscriptionCancelled && stripeCustomerId) {
          try {
            let hasMore = true;
            let startingAfter: string | undefined;
            while (hasMore) {
              const params: any = { customer: stripeCustomerId, limit: 100 };
              if (startingAfter) params.starting_after = startingAfter;
              const subscriptions = await stripe.subscriptions.list(params);
              for (const sub of subscriptions.data) {
                if (['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)) {
                  await stripe.subscriptions.cancel(sub.id);
                  subscriptionCancelled = true;
                  console.log(`[Admin] Cancelled subscription ${sub.id} for archived member ${normalizedEmail}`);
                }
              }
              hasMore = subscriptions.has_more;
              if (subscriptions.data.length > 0) {
                startingAfter = subscriptions.data[subscriptions.data.length - 1].id;
              }
            }
          } catch (listError: unknown) {
            console.error(`[Admin] Failed to list/cancel subscriptions for customer ${stripeCustomerId}:`, getErrorMessage(listError));
          }
        }
      } catch (importError: unknown) {
        console.error(`[Admin] Failed to import Stripe client for subscription cancellation:`, getErrorMessage(importError));
      }
    }

    res.json({ 
      success: true, 
      archived: true,
      archivedBy,
      subscriptionCancelled,
      message: 'Member archived successfully'
    });
  } catch (error: unknown) {
    if (!isProduction) console.error('Member archive error:', error);
    res.status(500).json({ error: 'Failed to archive member' });
  }
});

router.delete('/api/members/:email/permanent', isAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { deleteFromHubSpot, deleteFromStripe } = req.query;
    const normalizedEmail = decodeURIComponent(email as string).toLowerCase();
    const sessionUser = getSessionUser(req);
    
    const userResult = await db.select({ 
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      stripeCustomerId: users.stripeCustomerId,
      hubspotId: users.hubspotId,
      idImageUrl: users.idImageUrl
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const userId = userResult[0].id;
    const memberName = `${userResult[0].firstName || ''} ${userResult[0].lastName || ''}`.trim();
    const stripeCustomerId = userResult[0].stripeCustomerId;
    const hubspotId = userResult[0].hubspotId;
    
    const deletionLog: string[] = [];
    const userIdStr = String(userId);
    
    if (userResult[0].idImageUrl) {
      try {
        await db.update(users).set({ idImageUrl: null }).where(eq(users.id, userId));
        deletionLog.push('id_image');
      } catch (idErr: unknown) {
        console.error(`[Admin] Failed to clear ID image for ${normalizedEmail}:`, getErrorMessage(idErr));
      }
    }
    
    await db.execute(sql`DELETE FROM member_notes WHERE LOWER(member_email) = ${normalizedEmail}`);
    deletionLog.push('member_notes');
    
    await db.execute(sql`DELETE FROM communication_logs WHERE LOWER(member_email) = ${normalizedEmail}`);
    deletionLog.push('communication_logs');
    
    await db.execute(sql`DELETE FROM guest_passes WHERE LOWER(member_email) = ${normalizedEmail}`);
    deletionLog.push('guest_passes');
    
    await db.execute(sql`DELETE FROM guest_check_ins WHERE LOWER(member_email) = ${normalizedEmail} OR LOWER(guest_email) = ${normalizedEmail}`);
    deletionLog.push('guest_check_ins');
    
    await db.execute(sql`UPDATE event_rsvps SET matched_user_id = NULL WHERE matched_user_id = ${userIdStr}`);
    await db.execute(sql`DELETE FROM event_rsvps WHERE LOWER(user_email) = ${normalizedEmail}`);
    deletionLog.push('event_rsvps');
    
    await db.execute(sql`DELETE FROM wellness_enrollments WHERE LOWER(user_email) = ${normalizedEmail}`);
    deletionLog.push('wellness_enrollments');
    
    const sessionIdsResult = await db.execute(sql`SELECT DISTINCT session_id FROM booking_requests WHERE (LOWER(user_email) = ${normalizedEmail} OR user_id = ${userId}) AND session_id IS NOT NULL`);
    const sessionIds = (sessionIdsResult.rows as any[]).map((r: any) => r.session_id);
    deletionLog.push(`booking_session_ids_found (${sessionIds.length})`);

    await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE booking_id IN (SELECT id FROM booking_requests WHERE LOWER(user_email) = ${normalizedEmail} OR user_id = ${userId})`);
    deletionLog.push('booking_fee_snapshots (by booking)');

    await db.execute(sql`DELETE FROM booking_participants WHERE user_id = ${userId}`);
    deletionLog.push('booking_participants (deleted)');

    if (sessionIds.length > 0) {
      const sessionIdList = sql.join(sessionIds.map(id => sql`${id}`), sql`, `);

      await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE session_id IN (SELECT bs.id FROM booking_sessions bs WHERE NOT EXISTS (SELECT 1 FROM booking_participants bp WHERE bp.session_id = bs.id) AND bs.id IN (${sessionIdList}))`);
      deletionLog.push('booking_fee_snapshots (empty sessions)');

      await db.execute(sql`UPDATE booking_requests SET session_id = NULL WHERE session_id IN (SELECT bs.id FROM booking_sessions bs WHERE NOT EXISTS (SELECT 1 FROM booking_participants bp WHERE bp.session_id = bs.id) AND bs.id IN (${sessionIdList}))`);
      deletionLog.push('booking_requests (unlinked from empty sessions)');

      await db.execute(sql`DELETE FROM usage_ledger WHERE session_id IN (SELECT bs.id FROM booking_sessions bs WHERE NOT EXISTS (SELECT 1 FROM booking_participants bp WHERE bp.session_id = bs.id) AND bs.id IN (${sessionIdList}))`);
      deletionLog.push('usage_ledger (empty sessions)');

      await db.execute(sql`DELETE FROM booking_sessions WHERE id IN (SELECT bs.id FROM booking_sessions bs WHERE NOT EXISTS (SELECT 1 FROM booking_participants bp WHERE bp.session_id = bs.id) AND bs.id IN (${sessionIdList}))`);
      deletionLog.push('booking_sessions (empty, deleted)');
    }

    await db.execute(sql`DELETE FROM booking_requests WHERE LOWER(user_email) = ${normalizedEmail} OR user_id = ${userId}`);
    deletionLog.push('booking_requests');

    await db.execute(sql`DELETE FROM booking_members WHERE LOWER(user_email) = ${normalizedEmail}`);
    deletionLog.push('booking_members');

    await db.execute(sql`UPDATE booking_sessions SET created_by = NULL WHERE LOWER(created_by) = ${normalizedEmail}`);
    deletionLog.push('booking_sessions (created_by unlinked)');
    
    await db.execute(sql`UPDATE guests SET created_by_member_id = NULL WHERE created_by_member_id = ${userIdStr}`);
    deletionLog.push('guests (unlinked)');
    
    await db.execute(sql`DELETE FROM sessions WHERE sess->'user'->>'email' = ${normalizedEmail}`);
    deletionLog.push('sessions');
    
    await db.execute(sql`DELETE FROM notifications WHERE LOWER(user_email) = ${normalizedEmail}`);
    deletionLog.push('notifications');
    
    await db.execute(sql`DELETE FROM magic_links WHERE LOWER(email) = ${normalizedEmail}`);
    deletionLog.push('magic_links');
    
    await db.execute(sql`DELETE FROM push_subscriptions WHERE LOWER(user_email) = ${normalizedEmail}`);
    deletionLog.push('push_subscriptions');
    
    await db.execute(sql`DELETE FROM user_dismissed_notices WHERE LOWER(user_email) = ${normalizedEmail}`);
    deletionLog.push('user_dismissed_notices');
    
    await db.execute(sql`DELETE FROM user_linked_emails WHERE LOWER(primary_email) = ${normalizedEmail}`);
    deletionLog.push('user_linked_emails (primary)');
    
    await db.execute(sql`DELETE FROM user_linked_emails WHERE LOWER(linked_email) = ${normalizedEmail}`);
    deletionLog.push('user_linked_emails (linked)');
    
    await db.execute(sql`DELETE FROM conference_prepayments WHERE LOWER(member_email) = ${normalizedEmail}`);
    deletionLog.push('conference_prepayments');
    
    await db.execute(sql`DELETE FROM guest_pass_holds WHERE LOWER(member_email) = ${normalizedEmail}`);
    deletionLog.push('guest_pass_holds');
    
    await db.execute(sql`DELETE FROM form_submissions WHERE LOWER(email) = ${normalizedEmail}`);
    deletionLog.push('form_submissions');
    
    await db.execute(sql`DELETE FROM data_export_requests WHERE LOWER(user_email) = ${normalizedEmail}`);
    deletionLog.push('data_export_requests');
    
    await db.execute(sql`DELETE FROM billing_audit_log WHERE LOWER(member_email) = ${normalizedEmail}`);
    deletionLog.push('billing_audit_log');
    
    await db.execute(sql`DELETE FROM bug_reports WHERE LOWER(user_email) = ${normalizedEmail}`);
    deletionLog.push('bug_reports');
    
    await db.execute(sql`DELETE FROM legacy_purchases WHERE LOWER(member_email) = ${normalizedEmail}`);
    deletionLog.push('legacy_purchases');
    
    await db.execute(sql`DELETE FROM booking_guests WHERE LOWER(guest_email) = ${normalizedEmail}`);
    deletionLog.push('booking_guests');
    
    await db.execute(sql`DELETE FROM group_members WHERE LOWER(member_email) = ${normalizedEmail}`);
    deletionLog.push('group_members');
    
    await db.execute(sql`DELETE FROM hubspot_sync_queue WHERE LOWER(payload->>'email') = ${normalizedEmail}`);
    deletionLog.push('hubspot_sync_queue');
    
    await db.execute(sql`DELETE FROM email_events WHERE LOWER(recipient_email) = ${normalizedEmail}`);
    deletionLog.push('email_events');
    
    await db.execute(sql`DELETE FROM hubspot_line_items WHERE hubspot_deal_id IN (SELECT hubspot_deal_id FROM hubspot_deals WHERE LOWER(member_email) = ${normalizedEmail})`);
    deletionLog.push('hubspot_line_items');
    
    await db.execute(sql`DELETE FROM hubspot_deals WHERE LOWER(member_email) = ${normalizedEmail}`);
    deletionLog.push('hubspot_deals');
    
    await db.execute(sql`DELETE FROM tours WHERE LOWER(guest_email) = ${normalizedEmail}`);
    deletionLog.push('tours');
    
    await db.execute(sql`DELETE FROM trackman_unmatched_bookings WHERE LOWER(original_email) = ${normalizedEmail} OR LOWER(resolved_email) = ${normalizedEmail}`);
    deletionLog.push('trackman_unmatched_bookings');
    
    await db.execute(sql`DELETE FROM trackman_bay_slots WHERE LOWER(customer_email) = ${normalizedEmail}`);
    deletionLog.push('trackman_bay_slots');
    
    await db.execute(sql`UPDATE trackman_webhook_events SET matched_user_id = NULL WHERE matched_user_id = ${userIdStr}`);
    deletionLog.push('trackman_webhook_events (unlinked)');
    
    await db.execute(sql`DELETE FROM terminal_payments WHERE user_id = ${userIdStr} OR LOWER(user_email) = ${normalizedEmail}`);
    deletionLog.push('terminal_payments');
    
    await db.execute(sql`DELETE FROM pass_redemption_logs WHERE purchase_id IN (SELECT id FROM day_pass_purchases WHERE user_id = ${userIdStr} OR LOWER(purchaser_email) = ${normalizedEmail})`);
    deletionLog.push('pass_redemption_logs');
    
    await db.execute(sql`DELETE FROM day_pass_purchases WHERE user_id = ${userIdStr} OR LOWER(purchaser_email) = ${normalizedEmail}`);
    deletionLog.push('day_pass_purchases');
    
    await db.execute(sql`DELETE FROM stripe_payment_intents WHERE user_id = ${userIdStr}`);
    deletionLog.push('stripe_payment_intents');
    
    try {
      await db.execute(sql`DELETE FROM account_deletion_requests WHERE user_id = ${userId}::text::integer`);
      deletionLog.push('account_deletion_requests');
    } catch {
      deletionLog.push('account_deletion_requests (skipped - type mismatch)');
    }
    
    await db.execute(sql`DELETE FROM usage_ledger WHERE member_id = ${userIdStr}`);
    deletionLog.push('usage_ledger');
    
    await db.execute(sql`DELETE FROM stripe_transaction_cache WHERE LOWER(customer_email) = ${normalizedEmail}`);
    deletionLog.push('stripe_transaction_cache (by email)');
    
    if (stripeCustomerId) {
      await db.execute(sql`DELETE FROM stripe_transaction_cache WHERE customer_id = ${stripeCustomerId}`);
      deletionLog.push('stripe_transaction_cache (by customer_id)');
      
      await db.execute(sql`DELETE FROM terminal_payments WHERE stripe_customer_id = ${stripeCustomerId}`);
      await db.execute(sql`DELETE FROM stripe_payment_intents WHERE stripe_customer_id = ${stripeCustomerId}`);
      
      await db.execute(sql`DELETE FROM webhook_processed_events WHERE resource_id = ${stripeCustomerId}`);
      deletionLog.push('webhook_processed_events');
    }
    
    await db.execute(sql`DELETE FROM admin_audit_log WHERE resource_id = ${userIdStr} AND resource_type = 'user'`);
    deletionLog.push('admin_audit_log');
    
    await db.execute(sql`UPDATE billing_groups SET is_active = false WHERE LOWER(primary_email) = ${normalizedEmail} AND is_active = true`);
    deletionLog.push('billing_groups (deactivated)');
    
    let subscriptionsCancelled = false;
    if (stripeCustomerId) {
      try {
        const { getStripe } = await import('../../core/stripe');
        const stripe = await getStripe();
        let hasMore = true;
        let startingAfter: string | undefined;
        while (hasMore) {
          const params: any = { customer: stripeCustomerId, limit: 100 };
          if (startingAfter) params.starting_after = startingAfter;
          const subscriptions = await stripe.subscriptions.list(params);
          for (const sub of subscriptions.data) {
            if (['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)) {
              await stripe.subscriptions.cancel(sub.id);
              deletionLog.push(`stripe_subscription_cancelled (${sub.id})`);
              subscriptionsCancelled = true;
            }
          }
          hasMore = subscriptions.has_more;
          if (subscriptions.data.length > 0) {
            startingAfter = subscriptions.data[subscriptions.data.length - 1].id;
          }
        }
      } catch (stripeSubError: unknown) {
        console.error(`[Admin] Failed to cancel subscriptions for ${stripeCustomerId}:`, getErrorMessage(stripeSubError));
      }
    }

    let stripeDeleted = false;
    if (deleteFromStripe === 'true' && stripeCustomerId) {
      try {
        const { getStripe } = await import('../../core/stripe');
        const stripe = await getStripe();
        await stripe.customers.del(stripeCustomerId);
        stripeDeleted = true;
        deletionLog.push('stripe_customer');
      } catch (stripeError: unknown) {
        console.error(`[Admin] Failed to delete Stripe customer ${stripeCustomerId}:`, getErrorMessage(stripeError));
      }
    }
    
    let hubspotArchived = false;
    if (deleteFromHubSpot === 'true' && hubspotId) {
      try {
        const { getHubSpotClient } = await import('../../core/integrations');
        const hubspot = await getHubSpotClient();
        await hubspot.crm.contacts.basicApi.archive(hubspotId);
        hubspotArchived = true;
        deletionLog.push('hubspot_contact (archived)');
      } catch (hubspotError: unknown) {
        console.error(`[Admin] Failed to archive HubSpot contact ${hubspotId}:`, getErrorMessage(hubspotError));
      }
    }
    
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    deletionLog.push('users');
    
    await logFromRequest(req, {
      action: 'delete_member',
      resourceType: 'user',
      resourceId: userIdStr,
      resourceName: memberName,
      details: {
        email: normalizedEmail,
        deletedRecords: deletionLog,
        stripeDeleted,
        hubspotArchived,
        deletedBy: sessionUser?.email
      }
    });
    
    console.log(`[Admin] Member permanently deleted: ${normalizedEmail} (${memberName}) by ${sessionUser?.email}. Records: ${deletionLog.join(', ')}`);
    
    res.json({ 
      success: true, 
      deleted: true,
      deletedBy: sessionUser?.email,
      deletedRecords: deletionLog,
      subscriptionsCancelled,
      stripeDeleted,
      hubspotArchived,
      message: `Member ${memberName || normalizedEmail} permanently deleted`
    });
  } catch (error: unknown) {
    console.error('Member permanent delete error:', (error as Error)?.message || error);
    res.status(500).json({ error: 'Failed to permanently delete member' });
  }
});

router.post('/api/members/:email/anonymize', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email as string).toLowerCase();
    const sessionUser = getSessionUser(req);
    const anonymizedBy = sessionUser?.email || 'unknown';
    
    const userResult = await db.select({ 
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      archivedAt: users.archivedAt 
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const userId = userResult[0].id;
    const anonymizedId = userId.slice(0, 8);
    const anonymizedEmail = `deleted_${anonymizedId}@anonymized.local`;
    const now = new Date();
    
    await db.update(users)
      .set({
        firstName: 'Deleted',
        lastName: 'Member',
        email: anonymizedEmail,
        phone: null,
        trackmanEmail: null,
        linkedEmails: sql`'[]'::jsonb`,
        manuallyLinkedEmails: sql`'[]'::jsonb`,
        emailOptIn: false,
        smsOptIn: false,
        doNotSellMyInfo: true,
        archivedAt: now,
        archivedBy: anonymizedBy,
        membershipStatus: 'deleted',
        idImageUrl: null,
        updatedAt: now
      })
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    await db.execute(sql`
      UPDATE booking_requests 
      SET user_name = 'Deleted Member', 
          user_email = ${anonymizedEmail}
      WHERE LOWER(user_email) = ${normalizedEmail}
    `);
    
    await db.execute(sql`
      UPDATE booking_members 
      SET user_name = 'Deleted Member',
          user_email = ${anonymizedEmail}
      WHERE LOWER(user_email) = ${normalizedEmail}
    `);
    
    // Clear user_id from booking_participants (marks them as guests)
    await db.execute(sql`
      UPDATE booking_participants 
      SET user_id = NULL
      WHERE user_id = ${userId}
    `);
    
    console.log(`[Privacy] Member ${normalizedEmail} anonymized by ${anonymizedBy} at ${now.toISOString()}`);
    
    logFromRequest(req, 'archive_member', 'member', normalizedEmail, 
      `${userResult[0].firstName} ${userResult[0].lastName}`.trim() || undefined,
      { action: 'anonymize', reason: 'CCPA compliance' });
    
    res.json({ 
      success: true, 
      anonymized: true,
      anonymizedBy,
      message: 'Member data anonymized successfully. Financial records preserved for compliance.'
    });
  } catch (error: unknown) {
    if (!isProduction) console.error('Member anonymize error:', error);
    res.status(500).json({ error: 'Failed to anonymize member data' });
  }
});

router.get('/api/members/add-options', isStaffOrAdmin, async (req, res) => {
  try {
    const discountRules = await getAllDiscountRules();
    
    const tiersResult = await db.execute(sql`
      SELECT id, name, slug, price_cents, billing_interval, stripe_price_id
       FROM membership_tiers 
       WHERE is_active = true 
         AND product_type = 'subscription'
         AND billing_interval IN ('month', 'year', 'week')
       ORDER BY sort_order ASC NULLS LAST, name ASC
    `);
    
    res.json({
      tiers: TIER_NAMES,
      tiersWithIds: tiersResult.rows.map((t: any) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        priceCents: t.price_cents,
        billingInterval: t.billing_interval,
        hasStripePrice: !!t.stripe_price_id
      })),
      discountReasons: discountRules
        .filter(r => r.isActive)
        .map(r => ({
          tag: r.discountTag,
          percent: r.discountPercent,
          description: r.description
        }))
    });
  } catch (error: unknown) {
    if (!isProduction) console.error('Add options error:', error);
    res.status(500).json({ error: 'Failed to fetch add member options' });
  }
});

router.post('/api/members', isStaffOrAdmin, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { firstName, lastName, email, phone, tier, startDate, discountReason } = req.body;
    
    if (!firstName || typeof firstName !== 'string' || firstName.trim().length === 0) {
      return res.status(400).json({ error: 'First name is required' });
    }
    if (!lastName || typeof lastName !== 'string' || lastName.trim().length === 0) {
      return res.status(400).json({ error: 'Last name is required' });
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!tier || !TIER_NAMES.includes(tier as any)) {
      return res.status(400).json({ error: `Invalid tier. Must be one of: ${TIER_NAMES.join(', ')}` });
    }
    
    if (startDate) {
      if (typeof startDate !== 'string') {
        return res.status(400).json({ error: 'Start date must be a string in YYYY-MM-DD format' });
      }
      
      const dateFormatRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateFormatRegex.test(startDate)) {
        return res.status(400).json({ error: 'Start date must be in YYYY-MM-DD format' });
      }
      
      const dateObj = new Date(`${startDate}T00:00:00Z`);
      if (isNaN(dateObj.getTime())) {
        return res.status(400).json({ error: 'Start date is not a valid date' });
      }
    }
    
    const memberInput = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone?.trim() || undefined,
      tier,
      startDate: startDate || undefined,
      discountReason: discountReason || undefined,
      createdBy: sessionUser.email,
      createdByName: sessionUser.name || `${sessionUser.firstName || ''} ${sessionUser.lastName || ''}`.trim()
    };
    
    const result = await createMemberLocally(memberInput);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to create member' });
    }
    
    let hubspotSyncQueued = false;
    try {
      await queueMemberCreation(memberInput);
      hubspotSyncQueued = true;
    } catch (queueError) {
      console.error('[CreateMember] Failed to queue HubSpot sync (member created locally):', queueError);
    }
    
    res.status(201).json({
      success: true,
      message: `Successfully created member ${firstName} ${lastName}`,
      member: {
        id: result.userId,
        email: email.toLowerCase(),
        firstName,
        lastName,
        tier
      },
      hubspotSyncQueued,
      hubspotSyncNote: hubspotSyncQueued 
        ? 'HubSpot sync will complete in the background' 
        : 'HubSpot sync failed to queue - member created locally only'
    });
  } catch (error: unknown) {
    console.error('Create member error:', error);
    res.status(500).json({ error: 'Failed to create member' });
  }
});

router.post('/api/members/admin/bulk-tier-update', isStaffOrAdmin, async (req, res) => {
  try {
    const { members, syncToHubspot = true, dryRun = false } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ error: 'Members array is required' });
    }
    
    const performedBy = sessionUser?.email || 'system';
    const performedByName = sessionUser?.firstName 
      ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
      : 'Bulk Update';
    
    const { normalizeTierName: normalizeTierNameUtil } = await import('../../utils/tierUtils');
    function normalizeCsvTier(csvTier: string): string | null {
      if (!csvTier) return null;
      return normalizeTierNameUtil(csvTier);
    }
    
    const tierIdMap: Record<string, number> = {
      'Social': 1,
      'Core': 2,
      'Premium': 3,
      'Corporate': 4,
      'VIP': 5
    };
    
    // Validation and data preparation phase (fast)
    const results: {
      updated: { email: string; name: string; oldTier: string; newTier: string }[];
      unchanged: { email: string; name: string; tier: string }[];
      notFound: { email: string; tier: string }[];
      errors: { email: string; error: string }[];
      queued: number;
      jobIds: number[];
    } = { updated: [], unchanged: [], notFound: [], errors: [], queued: 0, jobIds: [] };
    
    // For dry-run, do quick validation
    if (dryRun) {
      for (const member of members) {
        const { email, tier: csvTier } = member;
        
        if (!email) {
          results.errors.push({ email: 'unknown', error: 'Email missing' });
          continue;
        }
        
        const normalizedEmail = email.toLowerCase().trim();
        const normalizedTier = normalizeCsvTier(csvTier);
        
        if (!normalizedTier) {
          results.errors.push({ email: normalizedEmail, error: `Invalid tier: ${csvTier}` });
          continue;
        }
        
        try {
          const userResult = await db.select({
            id: users.id,
            email: users.email,
            tier: users.tier,
            firstName: users.firstName,
            lastName: users.lastName
          })
            .from(users)
            .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
          
          if (userResult.length === 0) {
            results.notFound.push({ email: normalizedEmail, tier: normalizedTier });
            continue;
          }
          
          const user = userResult[0];
          const actualTier = user.tier;
          const oldTierDisplay = actualTier || null;
          const memberName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || normalizedEmail;
          
          if (actualTier === normalizedTier) {
            results.unchanged.push({ email: normalizedEmail, name: memberName, tier: normalizedTier });
            continue;
          }
          
          results.updated.push({ 
            email: normalizedEmail, 
            name: memberName, 
            oldTier: oldTierDisplay || 'None',
            newTier: normalizedTier
          });
        } catch (error: unknown) {
          console.error(`[BulkTierUpdate] Error validating ${normalizedEmail}:`, error);
          results.errors.push({ email: normalizedEmail, error: getErrorMessage(error) });
        }
      }
      
      return res.json({
        success: true,
        dryRun: true,
        summary: {
          total: members.length,
          updated: results.updated.length,
          unchanged: results.unchanged.length,
          notFound: results.notFound.length,
          errors: results.errors.length
        },
        results
      });
    }
    
    // For non-dry-run: queue the updates as background jobs
    const { queueJobs } = await import('../../core/jobQueue');
    const jobsToQueue: Array<{ jobType: 'update_member_tier'; payload: any; options?: any }> = [];
    
    for (const member of members) {
      const { email, tier: csvTier } = member;
      
      if (!email) {
        results.errors.push({ email: 'unknown', error: 'Email missing' });
        continue;
      }
      
      const normalizedEmail = email.toLowerCase().trim();
      const normalizedTier = normalizeCsvTier(csvTier);
      
      if (!normalizedTier) {
        results.errors.push({ email: normalizedEmail, error: `Invalid tier: ${csvTier}` });
        continue;
      }
      
      try {
        const userResult = await db.select({
          id: users.id,
          email: users.email,
          tier: users.tier,
          firstName: users.firstName,
          lastName: users.lastName
        })
          .from(users)
          .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
        
        if (userResult.length === 0) {
          results.notFound.push({ email: normalizedEmail, tier: normalizedTier });
          continue;
        }
        
        const user = userResult[0];
        const actualTier = user.tier;
        const oldTierDisplay = actualTier || null;
        const memberName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || normalizedEmail;
        
        if (actualTier === normalizedTier) {
          results.unchanged.push({ email: normalizedEmail, name: memberName, tier: normalizedTier });
          continue;
        }
        
        // Queue this member's tier update
        const tierId = tierIdMap[normalizedTier];
        jobsToQueue.push({
          jobType: 'update_member_tier',
          payload: {
            email: normalizedEmail,
            newTier: normalizedTier,
            oldTier: oldTierDisplay,
            performedBy,
            performedByName,
            syncToHubspot,
            tierId,
            csvTier
          },
          options: {
            priority: 1,
            maxRetries: 3
          }
        });
        
        results.updated.push({ 
          email: normalizedEmail, 
          name: memberName, 
          oldTier: oldTierDisplay || 'None',
          newTier: normalizedTier
        });
      } catch (error: unknown) {
        console.error(`[BulkTierUpdate] Error processing ${email}:`, error);
        results.errors.push({ email: email?.toLowerCase().trim() || 'unknown', error: getErrorMessage(error) });
      }
    }
    
    // Queue all jobs at once
    let jobIds: number[] = [];
    if (jobsToQueue.length > 0) {
      jobIds = await queueJobs(jobsToQueue);
      results.queued = jobIds.length;
      results.jobIds = jobIds;
      console.log(`[BulkTierUpdate] Queued ${jobIds.length} member tier update jobs (IDs: ${jobIds.join(', ')})`);
    }
    
    res.json({
      success: true,
      dryRun: false,
      message: `Queued ${results.queued} member tier update${results.queued !== 1 ? 's' : ''} for background processing`,
      summary: {
        total: members.length,
        queued: results.queued,
        unchanged: results.unchanged.length,
        notFound: results.notFound.length,
        errors: results.errors.length
      },
      jobIds,
      results: {
        queued: results.updated,
        unchanged: results.unchanged,
        notFound: results.notFound,
        errors: results.errors
      }
    });
  } catch (error: unknown) {
    console.error('Bulk tier update error:', error);
    res.status(500).json({ error: 'Failed to process bulk tier update' });
  }
});

router.post('/api/admin/member/change-email', isStaffOrAdmin, async (req, res) => {
  try {
    const { oldEmail, newEmail } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!oldEmail || !newEmail) {
      return res.status(400).json({ error: 'Both oldEmail and newEmail are required' });
    }
    
    const performedBy = sessionUser?.email || 'unknown';
    const performedByName = sessionUser?.firstName 
      ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
      : sessionUser?.email?.split('@')[0] || 'Staff';
    
    const result = await cascadeEmailChange(oldEmail, newEmail, performedBy, performedByName);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({
      success: true,
      message: `Email changed from ${result.oldEmail} to ${result.newEmail}`,
      tablesUpdated: result.tablesUpdated
    });
  } catch (error: unknown) {
    console.error('[Email Change] Error:', error);
    res.status(500).json({ error: 'Failed to change email' });
  }
});

router.get('/api/admin/member/change-email/preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const impact = await previewEmailChangeImpact(email);
    res.json(impact);
  } catch (error: unknown) {
    console.error('[Email Change Preview] Error:', error);
    res.status(500).json({ error: 'Failed to preview email change impact' });
  }
});

router.get('/api/admin/tier-change/tiers', isStaffOrAdmin, async (req, res) => {
  try {
    const tiers = await getAvailableTiersForChange();
    res.json({ tiers });
  } catch (error: unknown) {
    console.error('[Tier Change] Error getting tiers:', error);
    res.status(500).json({ error: 'Failed to get tiers' });
  }
});

router.post('/api/admin/tier-change/preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { subscriptionId, newPriceId, immediate = true } = req.body;
    
    if (!subscriptionId || !newPriceId) {
      return res.status(400).json({ error: 'subscriptionId and newPriceId required' });
    }
    
    const result = await previewTierChange(subscriptionId, newPriceId, immediate);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({ preview: result.preview });
  } catch (error: unknown) {
    console.error('[Tier Change] Preview error:', error);
    res.status(500).json({ error: 'Failed to preview tier change' });
  }
});

router.post('/api/admin/tier-change/commit', isStaffOrAdmin, async (req, res) => {
  try {
    const { memberEmail, subscriptionId, newPriceId, immediate = true } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    if (!memberEmail || !subscriptionId || !newPriceId) {
      return res.status(400).json({ error: 'memberEmail, subscriptionId, and newPriceId required' });
    }
    
    const result = await commitTierChange(memberEmail, subscriptionId, newPriceId, immediate, staffEmail);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({ success: true });
  } catch (error: unknown) {
    console.error('[Tier Change] Commit error:', error);
    res.status(500).json({ error: 'Failed to change tier' });
  }
});

router.get('/api/members/:userId/duplicates', isStaffOrAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const duplicates = await findPotentialDuplicates(userId as string);
    res.json({ duplicates });
  } catch (error: unknown) {
    console.error('[Duplicates] Error finding duplicates:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to find duplicates' });
  }
});

router.post('/api/members/merge/preview', isAdmin, async (req, res) => {
  try {
    const { primaryUserId, secondaryUserId } = req.body;
    
    if (!primaryUserId || !secondaryUserId) {
      return res.status(400).json({ error: 'primaryUserId and secondaryUserId are required' });
    }
    
    const preview = await previewMerge(primaryUserId, secondaryUserId);
    res.json(preview);
  } catch (error: unknown) {
    console.error('[Merge Preview] Error:', error);
    res.status(400).json({ error: getErrorMessage(error) || 'Failed to preview merge' });
  }
});

router.post('/api/members/merge/execute', isAdmin, async (req, res) => {
  try {
    const { primaryUserId, secondaryUserId } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!primaryUserId || !secondaryUserId) {
      return res.status(400).json({ error: 'primaryUserId and secondaryUserId are required' });
    }
    
    const result = await executeMerge(primaryUserId, secondaryUserId, sessionUser?.email || 'admin');
    
    logFromRequest(req, 'merge_users' as any, 'user', primaryUserId, undefined, {
      secondary_user_id: secondaryUserId,
      records_merged: result.recordsMerged,
      merged_lifetime_visits: result.mergedLifetimeVisits
    });
    
    res.json(result);
  } catch (error: unknown) {
    console.error('[Merge Execute] Error:', error);
    res.status(400).json({ error: getErrorMessage(error) || 'Failed to merge users' });
  }
});

export default router;
