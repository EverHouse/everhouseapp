import { pool } from '../db';
import { PoolClient } from 'pg';
import { getErrorMessage } from '../../utils/errorUtils';
import { logPaymentAudit } from '../auditLog';

import { logger } from '../logger';
export interface PaymentStatusUpdate {
  paymentIntentId: string;
  bookingId?: number;
  sessionId?: number;
  feeSnapshotId?: number;
  staffEmail?: string;
  staffName?: string;
  amountCents?: number;
  refundId?: string;
}

export interface PaymentStatusResult {
  success: boolean;
  error?: string;
  participantsUpdated?: number;
  snapshotsUpdated?: number;
}

/**
 * Centralized service for updating payment statuses across all related tables.
 * All payment status changes should flow through this service to ensure consistency.
 */
export class PaymentStatusService {
  
  /**
   * Mark a payment as succeeded and update all related records atomically.
   */
  static async markPaymentSucceeded(params: PaymentStatusUpdate): Promise<PaymentStatusResult> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const { paymentIntentId, staffEmail, staffName } = params;
      
      // Find the fee snapshot for this payment intent
      const snapshotResult = await client.query(
        `SELECT bfs.id, bfs.session_id, bfs.booking_id, bfs.participant_fees, bfs.total_cents, bfs.status
         FROM booking_fee_snapshots bfs
         WHERE bfs.stripe_payment_intent_id = $1
         FOR UPDATE`,
        [paymentIntentId]
      );
      
      if (snapshotResult.rows.length === 0) {
        await client.query(
          `UPDATE stripe_payment_intents SET status = 'succeeded', updated_at = NOW() 
           WHERE stripe_payment_intent_id = $1`,
          [paymentIntentId]
        );

        const piLookup = await client.query(
          `SELECT booking_id, session_id, amount_cents FROM stripe_payment_intents WHERE stripe_payment_intent_id = $1`,
          [paymentIntentId]
        );

        if (piLookup.rows.length > 0 && piLookup.rows[0].booking_id) {
          const piRow = piLookup.rows[0];
          const resolvedSessionId = piRow.session_id || (
            await client.query(`SELECT session_id FROM booking_requests WHERE id = $1`, [piRow.booking_id])
          ).rows[0]?.session_id;

          if (resolvedSessionId) {
            const pendingResult = await client.query(
              `SELECT id, cached_fee_cents FROM booking_participants
               WHERE session_id = $1 AND payment_status = 'pending' AND cached_fee_cents > 0
               AND stripe_payment_intent_id IS NULL
               FOR UPDATE`,
              [resolvedSessionId]
            );

            if (pendingResult.rows.length > 0) {
              const totalPendingCents = pendingResult.rows.reduce((sum: number, row: { cached_fee_cents: number }) => sum + (row.cached_fee_cents || 0), 0);
              const tolerance = 50;
              
              if (Math.abs(totalPendingCents - piRow.amount_cents) > tolerance) {
                logger.warn(`[PaymentStatusService] No-snapshot fallback: amount mismatch for booking ${piRow.booking_id} (pending=${totalPendingCents}, paid=${piRow.amount_cents}) - skipping update`);
                await client.query('COMMIT');
                return { success: true, participantsUpdated: 0, snapshotsUpdated: 0 };
              }

              const pendingIds = pendingResult.rows.map((r: { id: number }) => r.id);
              await client.query(
                `UPDATE booking_participants
                 SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $2, cached_fee_cents = 0
                 WHERE id = ANY($1::int[])`,
                [pendingIds, paymentIntentId]
              );

              for (const row of pendingResult.rows) {
                await logPaymentAudit({
                  bookingId: piRow.booking_id,
                  sessionId: resolvedSessionId,
                  participantId: row.id,
                  action: 'payment_succeeded',
                  staffEmail: staffEmail || 'system',
                  staffName: staffName || 'Auto-sync',
                  amountAffected: row.cached_fee_cents || 0,
                  previousStatus: 'pending',
                  newStatus: 'paid',
                  paymentMethod: 'stripe',
                  metadata: { stripePaymentIntentId: paymentIntentId },
                });
              }

              logger.info(`[PaymentStatusService] No-snapshot fallback: updated ${pendingIds.length} participant(s) for booking ${piRow.booking_id}`);
              await client.query('COMMIT');
              return { success: true, participantsUpdated: pendingIds.length, snapshotsUpdated: 0 };
            }
          }
        }

        await client.query('COMMIT');
        return { success: true, participantsUpdated: 0, snapshotsUpdated: 0 };
      }
      
      const snapshot = snapshotResult.rows[0];
      
      // Always update stripe_payment_intents table, even if snapshot already processed
      await client.query(
        `UPDATE stripe_payment_intents SET status = 'succeeded', updated_at = NOW() 
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId]
      );
      
      if (snapshot.status === 'completed' || snapshot.status === 'paid') {
        // Already processed - stripe_payment_intents was updated above
        await client.query('COMMIT');
        return { success: true, participantsUpdated: 0, snapshotsUpdated: 0 };
      }
      
      // Update fee snapshot status to 'completed' to match webhook behavior
      await client.query(
        `UPDATE booking_fee_snapshots SET status = 'completed', used_at = NOW() WHERE id = $1`,
        [snapshot.id]
      );
      
      // Parse participant fees and update each participant's payment status
      // Match webhook behavior: set paid_at, stripe_payment_intent_id, cached_fee_cents=0
      let participantsUpdated = 0;
      const participantFees = snapshot.participant_fees;
      
      if (participantFees && Array.isArray(participantFees)) {
        const participantIds = participantFees.map((f: { id?: number; amountCents?: number }) => f.id).filter(Boolean);
        
        if (participantIds.length > 0) {
          // Bulk update all participants to match webhook behavior
          await client.query(
            `UPDATE booking_participants 
             SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $2, cached_fee_cents = 0 
             WHERE id = ANY($1::int[]) AND payment_status = 'pending'`,
            [participantIds, paymentIntentId]
          );
          participantsUpdated = participantIds.length;
          
          for (const fee of participantFees) {
            const participantId = fee.id;
            if (participantId) {
              await logPaymentAudit({
                bookingId: snapshot.booking_id,
                sessionId: snapshot.session_id,
                participantId,
                action: 'payment_succeeded',
                staffEmail: staffEmail || 'system',
                staffName: staffName || 'Auto-sync',
                amountAffected: fee.amountCents || 0,
                previousStatus: 'pending',
                newStatus: 'paid',
                paymentMethod: 'stripe',
                metadata: { stripePaymentIntentId: paymentIntentId },
              });
            }
          }
        }
      }
      
      await client.query('COMMIT');
      logger.info(`[PaymentStatusService] Marked payment ${paymentIntentId} as succeeded, updated ${participantsUpdated} participants`);
      
      return { success: true, participantsUpdated, snapshotsUpdated: 1 };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      logger.error('[PaymentStatusService] Error marking payment succeeded:', { error: error });
      return { success: false, error: getErrorMessage(error) };
    } finally {
      client.release();
    }
  }
  
  /**
   * Mark a payment as refunded and update all related records atomically.
   */
  static async markPaymentRefunded(params: PaymentStatusUpdate): Promise<PaymentStatusResult> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const { paymentIntentId, refundId, staffEmail, staffName, amountCents } = params;
      
      // Find the fee snapshot for this payment intent
      const snapshotResult = await client.query(
        `SELECT bfs.id, bfs.session_id, bfs.booking_id, bfs.participant_fees, bfs.total_cents, bfs.status
         FROM booking_fee_snapshots bfs
         WHERE bfs.stripe_payment_intent_id = $1
         FOR UPDATE`,
        [paymentIntentId]
      );
      
      // Always update stripe_payment_intents table
      await client.query(
        `UPDATE stripe_payment_intents SET status = 'refunded', updated_at = NOW() 
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId]
      );
      
      // Update fee snapshot status
      if (snapshotResult.rows.length > 0) {
        const snapshot = snapshotResult.rows[0];
        
        await client.query(
          `UPDATE booking_fee_snapshots SET status = 'refunded' WHERE id = $1`,
          [snapshot.id]
        );
        
        // Update participant payment statuses with refunded_at timestamp
        const participantFees = snapshot.participant_fees;
        if (participantFees && Array.isArray(participantFees)) {
          const participantIds = participantFees.map((f: { id?: number; amountCents?: number }) => f.id).filter(Boolean);
          
          if (participantIds.length > 0) {
            // Bulk update all participants
            await client.query(
              `UPDATE booking_participants 
               SET payment_status = 'refunded'
               WHERE id = ANY($1::int[])`,
              [participantIds]
            );
            
            for (const fee of participantFees) {
              const participantId = fee.id;
              if (participantId) {
                await logPaymentAudit({
                  bookingId: snapshot.booking_id,
                  sessionId: snapshot.session_id,
                  participantId,
                  action: 'payment_refunded',
                  staffEmail: staffEmail || 'system',
                  staffName: staffName || 'Refund',
                  amountAffected: fee.amountCents || 0,
                  previousStatus: 'paid',
                  newStatus: 'refunded',
                  paymentMethod: 'stripe',
                  metadata: { stripePaymentIntentId: paymentIntentId },
                });
              }
            }
          }
        }
      }
      
      await client.query('COMMIT');
      logger.info(`[PaymentStatusService] Marked payment ${paymentIntentId} as refunded`);
      
      return { success: true, snapshotsUpdated: snapshotResult.rows.length };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      logger.error('[PaymentStatusService] Error marking payment refunded:', { error: error });
      return { success: false, error: getErrorMessage(error) };
    } finally {
      client.release();
    }
  }
  
  /**
   * Mark a payment as cancelled and update all related records atomically.
   */
  static async markPaymentCancelled(params: PaymentStatusUpdate): Promise<PaymentStatusResult> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const { paymentIntentId } = params;
      
      // Find the fee snapshot for this payment intent
      const snapshotResult = await client.query(
        `SELECT bfs.id FROM booking_fee_snapshots bfs
         WHERE bfs.stripe_payment_intent_id = $1
         FOR UPDATE`,
        [paymentIntentId]
      );
      
      // Update fee snapshot status
      if (snapshotResult.rows.length > 0) {
        await client.query(
          `UPDATE booking_fee_snapshots SET status = 'cancelled' 
           WHERE stripe_payment_intent_id = $1`,
          [paymentIntentId]
        );
      }
      
      // Update stripe_payment_intents table
      await client.query(
        `UPDATE stripe_payment_intents SET status = 'canceled', updated_at = NOW() 
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId]
      );
      
      await client.query('COMMIT');
      logger.info(`[PaymentStatusService] Marked payment ${paymentIntentId} as cancelled`);
      
      return { success: true, snapshotsUpdated: snapshotResult.rows.length };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      logger.error('[PaymentStatusService] Error marking payment cancelled:', { error: error });
      return { success: false, error: getErrorMessage(error) };
    } finally {
      client.release();
    }
  }
  
  /**
   * Sync payment status from Stripe to database for a specific payment intent.
   * Used by reconciliation job and manual sync.
   */
  static async syncFromStripe(paymentIntentId: string, stripeStatus: string, staffEmail: string = 'system'): Promise<PaymentStatusResult> {
    if (stripeStatus === 'succeeded') {
      return this.markPaymentSucceeded({ paymentIntentId, staffEmail, staffName: 'Stripe Sync' });
    } else if (stripeStatus === 'canceled') {
      return this.markPaymentCancelled({ paymentIntentId });
    }
    // For other statuses (requires_payment_method, etc.), just update the stripe_payment_intents table
    await pool.query(
      `UPDATE stripe_payment_intents SET status = $1, updated_at = NOW() WHERE stripe_payment_intent_id = $2`,
      [stripeStatus, paymentIntentId]
    );
    return { success: true };
  }
}

// Export convenience functions
export const markPaymentSucceeded = PaymentStatusService.markPaymentSucceeded.bind(PaymentStatusService);
export const markPaymentRefunded = PaymentStatusService.markPaymentRefunded.bind(PaymentStatusService);
export const markPaymentCancelled = PaymentStatusService.markPaymentCancelled.bind(PaymentStatusService);
export const syncPaymentFromStripe = PaymentStatusService.syncFromStripe.bind(PaymentStatusService);
