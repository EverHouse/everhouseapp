import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../../../core/middleware';
import { db } from '../../../db';
import { sql } from 'drizzle-orm';
import { validateQuery } from '../../../middleware/validate';
import { z } from 'zod';
import { getSessionUser } from '../../../types/session';
import {
  createPaymentIntent,
  confirmPaymentSuccess,
  getOrCreateStripeCustomer,
  createBalanceAwarePayment,
} from '../../../core/stripe';
import { resolveUserByEmail } from '../../../core/stripe/customers';
import { computeFeeBreakdown } from '../../../core/billing/unifiedFeeService';
import { GUEST_FEE_CENTS } from '../helpers';
import { alertOnExternalServiceError } from '../../../core/errorAlerts';
import { getErrorMessage } from '../../../utils/errorUtils';
import { toIntArrayLiteral } from '../../../utils/sqlArrayLiteral';
import { logger } from '../../../core/logger';
import {
  BalanceParticipantRow,
  GuestBalanceRow,
  UncachedSessionRow,
  SessionDataRow,
  UnfilledRow,
  BalancePayParticipantRow,
  BalancePayGuestRow,
  SnapshotRow,
  IdRow,
} from './shared';

const router = Router();

const balanceQuerySchema = z.object({
  email: z.string().email().optional(),
}).passthrough();

router.get('/api/member/balance', isAuthenticated, validateQuery(balanceQuerySchema), async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let memberEmail = sessionUser.email.toLowerCase();
    const vq = (req as Request & { validatedQuery: z.infer<typeof balanceQuerySchema> }).validatedQuery;
    const queryEmail = vq.email;
    // Allow staff and admins to view another member's balance (for View As mode)
    const canViewOthers = sessionUser.isStaff || sessionUser.role === 'admin';
    if (queryEmail && canViewOthers) {
      memberEmail = queryEmail.trim().toLowerCase();
    }

    // Only show fees where there's a pending fee snapshot OR no snapshot at all (legacy)
    // Exclude sessions where all snapshots are cancelled/paid (orphaned cached_fee_cents)
    // Also exclude cancelled/declined bookings and sessions older than 90 days
    const result = await db.execute(sql`
      SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.participant_type,
        bp.display_name,
        bp.payment_status,
        bp.cached_fee_cents,
        bs.session_date,
        bs.start_time,
        bs.end_time,
        r.name as resource_name,
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
         AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email))
       WHERE LOWER(pu.email) = ${memberEmail}
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')
         AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
         AND bs.session_date >= CURRENT_DATE - INTERVAL '90 days'
         AND NOT EXISTS (
           SELECT 1 FROM booking_requests br2
           WHERE br2.session_id = bs.id
             AND br2.status IN ('cancelled', 'declined', 'cancellation_pending')
         )
         AND NOT EXISTS (
           SELECT 1 FROM booking_fee_snapshots bfs
           WHERE bfs.session_id = bp.session_id
             AND bfs.status IN ('completed', 'paid')
         )
       ORDER BY bs.session_date DESC, bs.start_time DESC
    `);

    const guestResult = await db.execute(sql`
      SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.participant_type,
        bp.display_name,
        bp.payment_status,
        bp.cached_fee_cents,
        bs.session_date,
        bs.start_time,
        bs.end_time,
        r.name as resource_name,
        owner_u.email as owner_email
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       JOIN booking_participants owner_bp ON owner_bp.session_id = bp.session_id 
         AND owner_bp.participant_type = 'owner'
       JOIN users owner_u ON owner_u.id = owner_bp.user_id
       WHERE bp.participant_type = 'guest'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND LOWER(owner_u.email) = ${memberEmail}
         AND bp.cached_fee_cents > 0
         AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
         AND bs.session_date >= CURRENT_DATE - INTERVAL '90 days'
         AND NOT EXISTS (
           SELECT 1 FROM booking_requests br2
           WHERE br2.session_id = bs.id
             AND br2.status IN ('cancelled', 'declined', 'cancellation_pending')
         )
         AND NOT EXISTS (
           SELECT 1 FROM booking_fee_snapshots bfs
           WHERE bfs.session_id = bp.session_id
             AND bfs.status IN ('completed', 'paid')
         )
       ORDER BY bs.session_date DESC, bs.start_time DESC
    `);

    const breakdown: Array<{
      id: number;
      sessionId: number;
      type: 'overage' | 'guest';
      description: string;
      date: string;
      amountCents: number;
    }> = [];

    for (const row of result.rows as unknown as BalanceParticipantRow[]) {
      let amountCents = 0;
      
      if (row.cached_fee_cents > 0) {
        amountCents = row.cached_fee_cents;
      } else if (parseFloat(row.ledger_fee) > 0) {
        amountCents = Math.round(parseFloat(row.ledger_fee) * 100);
      }
      
      if (amountCents > 0) {
        const dateStr = row.session_date ? new Date(row.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '';
        breakdown.push({
          id: row.participant_id,
          sessionId: row.session_id,
          type: 'overage',
          description: `${row.resource_name || 'Booking'} - ${dateStr}`,
          date: row.session_date,
          amountCents
        });
      }
    }

    for (const row of guestResult.rows as unknown as GuestBalanceRow[]) {
      const amountCents = row.cached_fee_cents || GUEST_FEE_CENTS;
      const dateStr = row.session_date ? new Date(row.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '';
      breakdown.push({
        id: row.participant_id,
        sessionId: row.session_id,
        type: 'guest',
        description: `Guest: ${row.display_name} - ${dateStr}`,
        date: row.session_date,
        amountCents
      });
    }

    const existingSessionIds = new Set(breakdown.map(b => b.sessionId));
    try {
      const uncachedResult = await db.execute(sql`
        SELECT DISTINCT bs.id as session_id
         FROM booking_participants bp
         JOIN booking_sessions bs ON bs.id = bp.session_id
         JOIN users pu ON pu.id = bp.user_id
         WHERE LOWER(pu.email) = ${memberEmail}
           AND bp.participant_type = 'owner'
           AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
           AND COALESCE(bp.cached_fee_cents, 0) = 0
           AND bs.session_date >= CURRENT_DATE - INTERVAL '90 days'
           AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
           AND NOT EXISTS (
             SELECT 1 FROM booking_requests br2
             WHERE br2.session_id = bs.id
               AND br2.status IN ('cancelled', 'declined', 'cancellation_pending')
           )
           AND NOT EXISTS (
             SELECT 1 FROM booking_fee_snapshots bfs
             WHERE bfs.session_id = bs.id
               AND bfs.status IN ('completed', 'paid')
           )
         LIMIT 20
      `);

      const uncachedSessions = (uncachedResult.rows as unknown as UncachedSessionRow[])
        .map(r => r.session_id)
        .filter(sid => !existingSessionIds.has(sid));

      if (uncachedSessions.length > 0) {
        logger.info('[Member Balance] Computing fees on-the-fly for sessions', { extra: { uncachedSessionsLength: uncachedSessions.length } });

        const allCacheUpdates: Array<{ id: number; cents: number }> = [];

        for (const sessionId of uncachedSessions) {
          try {
            const feeResult = await computeFeeBreakdown({ sessionId, source: 'stripe' as const });

            for (const p of feeResult.participants) {
              if (p.totalCents > 0 && p.participantId) {
                const sessionDataResult = await db.execute(sql`
                  SELECT bs.session_date, r.name as resource_name, bp.participant_type, bp.display_name
                   FROM booking_sessions bs
                   LEFT JOIN resources r ON r.id = bs.resource_id
                   LEFT JOIN booking_participants bp ON bp.id = ${p.participantId}
                   WHERE bs.id = ${sessionId}
                `);
                const sData = sessionDataResult.rows[0] as unknown as SessionDataRow | undefined;
                const dateStr = sData?.session_date ? new Date(sData.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '';

                const isGuest = sData?.participant_type === 'guest';
                breakdown.push({
                  id: p.participantId,
                  sessionId,
                  type: isGuest ? 'guest' : 'overage',
                  description: isGuest
                    ? `Guest: ${sData?.display_name || 'Guest'} - ${dateStr}`
                    : `${sData?.resource_name || 'Booking'} - ${dateStr}`,
                  date: sData?.session_date || dateStr,
                  amountCents: p.totalCents
                });

                allCacheUpdates.push({ id: p.participantId, cents: p.totalCents });
              }
            }
          } catch (sessionErr: unknown) {
            logger.error('[Member Balance] Failed to compute fees for session', { extra: { sessionId, sessionErr: getErrorMessage(sessionErr) } });
          }
        }

        if (allCacheUpdates.length > 0) {
          try {
            const ids = allCacheUpdates.map(u => u.id);
            const cents = allCacheUpdates.map(u => u.cents);
            await db.execute(sql`
              UPDATE booking_participants bp
               SET cached_fee_cents = updates.cents
               FROM (SELECT UNNEST(${toIntArrayLiteral(ids)}::int[]) as id, UNNEST(${toIntArrayLiteral(cents)}::int[]) as cents) as updates
               WHERE bp.id = updates.id
            `);
          } catch (cacheErr: unknown) {
            logger.error('[Member Balance] Failed to write-through cache', { extra: { cacheErr: getErrorMessage(cacheErr) } });
          }
        }
      }
    } catch (uncachedErr: unknown) {
      logger.error('[Member Balance] Error computing on-the-fly fees', { extra: { uncachedErr: getErrorMessage(uncachedErr) } });
    }

    const unfilledResult = await db.execute(sql`
      SELECT 
        bs.id as session_id,
        bs.session_date,
        bs.start_time,
        bs.end_time,
        r.name as resource_name,
        COALESCE(br.declared_player_count, 1) as declared_player_count,
        (SELECT COUNT(*) FROM booking_participants bp2 
         WHERE bp2.session_id = bs.id 
           AND bp2.participant_type != 'owner'
           AND bp2.payment_status IS NOT NULL) as non_owner_count
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       JOIN booking_requests br ON br.session_id = bs.id
       JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       WHERE LOWER(pu.email) = ${memberEmail}
         AND bp.participant_type = 'owner'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND COALESCE(br.declared_player_count, 1) > 1
         AND (bs.session_date AT TIME ZONE 'America/Los_Angeles')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
         AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
         AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
       GROUP BY bs.id, bs.session_date, bs.start_time, bs.end_time, r.name, br.declared_player_count, bp.user_id
    `);

    for (const row of unfilledResult.rows as unknown as UnfilledRow[]) {
      const declaredCount = parseInt(row.declared_player_count, 10) || 1;
      const nonOwnerCount = parseInt(row.non_owner_count, 10) || 0;
      const unfilledSlots = Math.max(0, declaredCount - 1 - nonOwnerCount);
      
      if (unfilledSlots > 0) {
        const dateStr = row.session_date ? new Date(row.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '';
        for (let i = 0; i < unfilledSlots; i++) {
          breakdown.push({
            id: -row.session_id * 1000 - i,
            sessionId: row.session_id,
            type: 'guest',
            description: `Guest fee (unfilled) - ${dateStr}`,
            date: row.session_date,
            amountCents: GUEST_FEE_CENTS
          });
        }
      }
    }

    const totalCents = breakdown.reduce((sum, item) => sum + item.amountCents, 0);

    res.json({
      totalCents,
      totalDollars: totalCents / 100,
      itemCount: breakdown.length,
      breakdown
    });
  } catch (error: unknown) {
    logger.error('[Member Balance] Error getting balance', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

router.post('/api/member/balance/pay', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let memberEmail = sessionUser.email.toLowerCase();
    const requestEmail = (req.body?.memberEmail as string | undefined)?.trim()?.toLowerCase();
    // Allow staff and admins to pay on behalf of another member (for View As mode)
    const canActForOthers = sessionUser.isStaff || sessionUser.role === 'admin';
    if (requestEmail && canActForOthers) {
      memberEmail = requestEmail.toLowerCase();
    }
    const applyCredit = req.body?.applyCredit !== false; // Default to true
    
    // Use email as the primary identifier for Stripe customer
    const memberName = memberEmail;

    // Only include fees where there's a pending fee snapshot OR no snapshot at all (legacy)
    const result = await db.execute(sql`
      SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id AND bfs.status = 'pending') as pending_snapshot_count,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id) as total_snapshot_count
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
         AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email))
       WHERE LOWER(pu.email) = ${memberEmail}
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')
         AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
    `);

    const guestResult = await db.execute(sql`
      SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id AND bfs.status = 'pending') as pending_snapshot_count,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id) as total_snapshot_count
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       JOIN booking_participants owner_bp ON owner_bp.session_id = bp.session_id 
         AND owner_bp.participant_type = 'owner'
       JOIN users owner_u ON owner_u.id = owner_bp.user_id
       WHERE bp.participant_type = 'guest'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND LOWER(owner_u.email) = ${memberEmail}
         AND bp.cached_fee_cents > 0
         AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
    `);

    const participantFees: Array<{id: number; amountCents: number}> = [];

    for (const row of result.rows as unknown as BalancePayParticipantRow[]) {
      let amountCents = 0;
      if (row.cached_fee_cents > 0) {
        amountCents = row.cached_fee_cents;
      } else if (parseFloat(row.ledger_fee) > 0) {
        amountCents = Math.round(parseFloat(row.ledger_fee) * 100);
      }
      if (amountCents > 0) {
        participantFees.push({ id: row.participant_id, amountCents });
      }
    }

    for (const row of guestResult.rows as unknown as BalancePayGuestRow[]) {
      const amountCents = row.cached_fee_cents || GUEST_FEE_CENTS;
      participantFees.push({ id: row.participant_id, amountCents });
    }

    const totalCents = participantFees.reduce((sum, f) => sum + f.amountCents, 0);

    if (totalCents < 50) {
      return res.status(400).json({ error: 'No outstanding balance to pay or amount too small' });
    }

    let snapshotId: number | null = null;
    let existingPaymentIntentId: string | null = null;

    await db.transaction(async (tx) => {
      // Check for existing pending snapshot (balance payment snapshots have null booking_id and session_id)
      const existingSnapshot = await tx.execute(sql`
        SELECT id, stripe_payment_intent_id, total_cents, participant_fees
         FROM booking_fee_snapshots 
         WHERE booking_id IS NULL AND session_id IS NULL AND status = 'pending' 
         AND created_at > NOW() - INTERVAL '1 hour'
         ORDER BY created_at DESC
         LIMIT 1
      `);
      
      if (existingSnapshot.rows.length > 0) {
        const existing = existingSnapshot.rows[0] as unknown as SnapshotRow;
        let parsedFees: Record<string, unknown>;
        try {
          parsedFees = typeof existing.participant_fees === 'string' ? JSON.parse(existing.participant_fees) : (existing.participant_fees || {});
        } catch {
          parsedFees = {};
        }
        const existingApplyCredit = parsedFees.applyCredit !== false;
        const existingParticipantIds = (Array.isArray(parsedFees.fees) ? parsedFees.fees : []).map((p: Record<string, unknown>) => p.id).sort().join(',');
        const newParticipantIds = participantFees.map(p => p.id).sort().join(',');
        const participantsMatch = existingParticipantIds === newParticipantIds;
        
        if (existing.stripe_payment_intent_id && 
            existing.total_cents === totalCents && 
            participantsMatch &&
            existingApplyCredit === applyCredit) {
          snapshotId = existing.id;
          existingPaymentIntentId = existing.stripe_payment_intent_id;
          logger.info('[Member Balance] Reusing existing pending snapshot', { extra: { snapshotId } });
        } else {
          // Expire stale snapshot (applyCredit changed or amounts/participants changed)
          await tx.execute(sql`
            UPDATE booking_fee_snapshots SET status = 'expired' WHERE id = ${existing.id}
          `);
          logger.info('[Member Balance] Expiring stale snapshot (applyCredit: -> , amountMatch: , participantsMatch: )', { extra: { existingId: existing.id, existingApplyCredit, applyCredit, existingTotal_cents_totalCents: existing.total_cents === totalCents, participantsMatch } });
        }
      }
      
      if (!snapshotId) {
        // Store applyCredit preference with the fees in the snapshot
        const snapshotData = {
          fees: participantFees,
          applyCredit
        };
        const snapshotResult = await tx.execute(sql`
          INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
           VALUES (NULL, NULL, ${JSON.stringify(snapshotData)}, ${totalCents}, 'pending') RETURNING id
        `);
        snapshotId = (snapshotResult.rows[0] as unknown as IdRow).id;
      }
    });
    
    // If we have an existing valid payment intent, return it
    if (existingPaymentIntentId) {
      try {
        const { getStripeClient } = await import('../../../core/stripe/client');
        const stripe = await getStripeClient();
        const existingIntent = await stripe.paymentIntents.retrieve(existingPaymentIntentId);
        if (existingIntent.status === 'requires_payment_method' || existingIntent.status === 'requires_confirmation') {
          logger.info('[Member Balance] Returning existing payment intent', { extra: { existingPaymentIntentId } });
          
          // Get customer balance for response
          const customer = await stripe.customers.retrieve((existingIntent.customer as string) || '');
          let availableCredit = 0;
          if (!('deleted' in customer) || !customer.deleted) {
            const customerBalance = ('balance' in customer ? (customer.balance as number) : 0) || 0;
            availableCredit = customerBalance < 0 ? Math.abs(customerBalance) : 0;
          }
          
          return res.json({
            paidInFull: false,
            clientSecret: existingIntent.client_secret,
            paymentIntentId: existingPaymentIntentId,
            totalCents,
            balanceApplied: 0,
            remainingCents: totalCents,
            availableCreditCents: availableCredit,
            itemCount: participantFees.length,
            participantFees,
            creditApplied: false
          });
        }
      } catch (_intentError: unknown) {
        logger.info('[Member Balance] Could not reuse intent , creating new one', { extra: { existingPaymentIntentId } });
      }
    }

    // Get or create Stripe customer for balance-aware payment
    const resolvedMember = await resolveUserByEmail(memberEmail);
    const resolvedMemberUserId = resolvedMember?.userId || memberEmail;
    const { customerId: stripeCustomerId } = await getOrCreateStripeCustomer(
      resolvedMemberUserId,
      memberEmail,
      memberName
    );

    // Get customer's available credit balance
    const { getStripeClient } = await import('../../../core/stripe/client');
    const stripe = await getStripeClient();
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    let availableCreditCents = 0;
    if (!('deleted' in customer) || !customer.deleted) {
      const customerBalance = ('balance' in customer ? (customer.balance as number) : 0) || 0;
      availableCreditCents = customerBalance < 0 ? Math.abs(customerBalance) : 0;
    }

    let paymentResult: {
      paidInFull: boolean;
      clientSecret?: string;
      paymentIntentId?: string;
      balanceTransactionId?: string;
      totalCents: number;
      balanceApplied: number;
      remainingCents: number;
      error?: string;
    };

    if (applyCredit && availableCreditCents > 0) {
      // Use balance-aware payment to apply account credits first
      paymentResult = await createBalanceAwarePayment({
        stripeCustomerId,
        userId: memberEmail,
        email: memberEmail,
        memberName,
        amountCents: totalCents,
        purpose: 'overage_fee',
        description: `Outstanding balance payment - ${participantFees.length} item(s)`,
        metadata: {
          feeSnapshotId: snapshotId!.toString(),
          participantCount: participantFees.length.toString(),
          participantIds: participantFees.map(f => f.id).join(',').substring(0, 490),
          balancePayment: 'true'
        }
      });
    } else {
      // Use standard payment without balance application
      const intentResult = await createPaymentIntent({
        userId: memberEmail,
        email: memberEmail,
        memberName,
        amountCents: totalCents,
        purpose: 'overage_fee',
        description: `Outstanding balance payment - ${participantFees.length} item(s)`,
        stripeCustomerId,
        metadata: {
          feeSnapshotId: snapshotId!.toString(),
          participantCount: participantFees.length.toString(),
          participantIds: participantFees.map(f => f.id).join(',').substring(0, 490),
          balancePayment: 'true'
        }
      });
      paymentResult = {
        paidInFull: false,
        clientSecret: intentResult.clientSecret,
        paymentIntentId: intentResult.paymentIntentId,
        totalCents,
        balanceApplied: 0,
        remainingCents: totalCents
      };
    }

    if (paymentResult.error) {
      await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE id = ${snapshotId}`);
      throw new Error(paymentResult.error);
    }

    const balancePaymentRef = paymentResult.paymentIntentId || paymentResult.balanceTransactionId || 'unknown';
    await db.execute(sql`
      UPDATE booking_fee_snapshots SET stripe_payment_intent_id = ${balancePaymentRef} WHERE id = ${snapshotId}
    `);

    // If fully paid by balance, mark participants as paid
    if (paymentResult.paidInFull) {
      const participantIds = participantFees.map(f => f.id);
      await db.execute(sql`
        UPDATE booking_participants 
         SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = ${balancePaymentRef}, cached_fee_cents = 0
         WHERE id = ANY(${toIntArrayLiteral(participantIds)}::int[])
      `);
      
      await db.execute(sql`
        UPDATE booking_fee_snapshots SET status = 'paid' WHERE id = ${snapshotId}
      `);
    }

    // Determine if credit was actually applied
    const creditApplied = applyCredit && availableCreditCents > 0 && paymentResult.balanceApplied > 0;

    logger.info('[Member Balance] Payment created: $ (balance: $, remaining: $, applyCredit: , creditApplied: )', { extra: { totalCents_100_ToFixed_2: (totalCents / 100).toFixed(2), paymentResultBalanceApplied_100_ToFixed_2: (paymentResult.balanceApplied / 100).toFixed(2), paymentResultRemainingCents_100_ToFixed_2: (paymentResult.remainingCents / 100).toFixed(2), applyCredit, creditApplied } });

    res.json({
      paidInFull: paymentResult.paidInFull,
      clientSecret: paymentResult.clientSecret,
      paymentIntentId: paymentResult.paymentIntentId,
      balanceTransactionId: paymentResult.balanceTransactionId,
      totalCents,
      balanceApplied: paymentResult.balanceApplied,
      remainingCents: paymentResult.remainingCents,
      availableCreditCents,
      itemCount: participantFees.length,
      participantFees,
      creditApplied,
      error: paymentResult.error
    });
  } catch (error: unknown) {
    logger.error('[Member Balance] Error creating payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'create balance payment');
    res.status(500).json({ 
      error: 'Payment processing failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/balance/confirm', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const result = await confirmPaymentSuccess(
      paymentIntentId,
      sessionUser.email,
      sessionUser.name || 'Member'
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Member Balance] Error confirming payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'confirm balance payment');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

export default router;
