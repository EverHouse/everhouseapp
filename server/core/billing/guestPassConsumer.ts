import { pool } from '../db';
import { getErrorMessage } from '../../utils/errorUtils';

import { logger } from '../logger';
export interface GuestPassConsumptionResult {
  success: boolean;
  error?: string;
  passesRemaining?: number;
  purchaseId?: number;
}

export async function consumeGuestPassForParticipant(
  participantId: number,
  ownerEmail: string,
  guestName: string,
  sessionId: number,
  sessionDate: Date,
  staffEmail?: string
): Promise<GuestPassConsumptionResult> {
  const isPlaceholderGuest = /^Guest \d+$/i.test(guestName || '');
  if (isPlaceholderGuest) {
    return {
      success: false,
      error: `Cannot use guest pass for placeholder slot "${guestName}". Please assign a real guest first.`
    };
  }
  
  const client = await pool.connect();
  const ownerEmailLower = ownerEmail.toLowerCase().trim();
  
  try {
    await client.query('BEGIN');
    
    const alreadyUsed = await client.query(
      `SELECT id, used_guest_pass, guest_id FROM booking_participants WHERE id = $1`,
      [participantId]
    );
    
    if (alreadyUsed.rows[0]?.used_guest_pass === true) {
      await client.query('ROLLBACK');
      logger.info(`[GuestPassConsumer] Guest pass already consumed for participant ${participantId}, skipping (idempotency)`);
      return {
        success: true,
        passesRemaining: undefined
      };
    }
    
    const ownerResult = await client.query(
      `SELECT id FROM users WHERE LOWER(email) = $1`,
      [ownerEmailLower]
    );
    const ownerId = ownerResult.rows[0]?.id;
    
    const tierResult = await client.query(
      `SELECT mt.guest_passes_per_month 
       FROM users u 
       JOIN membership_tiers mt ON LOWER(u.tier) = LOWER(mt.name)
       WHERE LOWER(u.email) = $1`,
      [ownerEmailLower]
    );
    const tierGuestPasses = tierResult.rows[0]?.guest_passes_per_month ?? 4;
    
    const existingPass = await client.query(
      `SELECT id, passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = $1 FOR UPDATE`,
      [ownerEmailLower]
    );
    
    let passesRemaining: number;
    
    if (existingPass.rows.length === 0) {
      const insertResult = await client.query(
        `INSERT INTO guest_passes (member_email, passes_used, passes_total)
         VALUES ($1, 1, $2)
         RETURNING passes_total - passes_used as remaining`,
        [ownerEmailLower, tierGuestPasses]
      );
      passesRemaining = insertResult.rows[0]?.remaining ?? (tierGuestPasses - 1);
    } else {
      let { passes_used, passes_total } = existingPass.rows[0];
      if (tierGuestPasses > passes_total) {
        await client.query(
          `UPDATE guest_passes SET passes_total = $1 WHERE LOWER(member_email) = $2`,
          [tierGuestPasses, ownerEmailLower]
        );
        passes_total = tierGuestPasses;
      }
      if (passes_used >= passes_total) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: `No guest passes remaining. ${ownerEmailLower} has 0/${passes_total} passes available.`
        };
      }
      
      const updateResult = await client.query(
        `UPDATE guest_passes 
         SET passes_used = passes_used + 1
         WHERE LOWER(member_email) = $1
         RETURNING passes_total - passes_used as remaining`,
        [ownerEmailLower]
      );
      passesRemaining = updateResult.rows[0]?.remaining ?? 0;
    }
    
    if (ownerId) {
      const existingLedger = await client.query(
        `SELECT id FROM usage_ledger 
         WHERE session_id = $1 AND member_id = $2`,
        [sessionId, ownerId]
      );
      
      if (existingLedger.rows.length > 0) {
        await client.query(
          `UPDATE usage_ledger 
           SET guest_fee = 0,
               payment_method = 'guest_pass'
           WHERE session_id = $1 AND member_id = $2`,
          [sessionId, ownerId]
        );
      }
    }
    
    await client.query(
      `UPDATE booking_participants 
       SET payment_status = 'waived', 
           cached_fee_cents = 0,
           used_guest_pass = TRUE
       WHERE id = $1`,
      [participantId]
    );
    
    const purchaseResult = await client.query(
      `INSERT INTO legacy_purchases 
        (user_id, member_email, item_name, item_category, item_price_cents, quantity, subtotal_cents, 
         discount_percent, discount_amount_cents, tax_cents, item_total_cents, 
         payment_method, sale_date, linked_booking_session_id, is_comp, is_synced, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
       RETURNING id`,
      [
        ownerId,
        ownerEmailLower,
        `Guest Pass - ${guestName}`,
        'guest_pass',
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        'guest_pass',
        sessionDate,
        sessionId,
        true,
        false
      ]
    );
    
    const purchaseId = purchaseResult.rows[0]?.id;
    
    await client.query(
      `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        ownerEmailLower,
        'Guest Pass Used',
        `Guest pass used for ${guestName}. You have ${passesRemaining} pass${passesRemaining !== 1 ? 'es' : ''} remaining this month.`,
        'guest_pass',
        'guest_pass'
      ]
    );
    
    await client.query('COMMIT');
    
    try {
      const bookingResult = await pool.query(
        `SELECT id FROM booking_requests WHERE session_id = $1 LIMIT 1`,
        [sessionId]
      );
      if (bookingResult.rows.length > 0) {
        const bookingId = bookingResult.rows[0].id;
        await pool.query(
          `DELETE FROM guest_pass_holds 
           WHERE booking_id = $1 AND LOWER(member_email) = $2 AND passes_held <= 1;
           UPDATE guest_pass_holds 
           SET passes_held = passes_held - 1
           WHERE booking_id = $1 AND LOWER(member_email) = $2 AND passes_held > 1`,
          [bookingId, ownerEmailLower]
        );
      }
    } catch (holdErr: unknown) {
      logger.info(`[GuestPassConsumer] Hold cleanup failed (non-blocking):`, { extra: { detail: holdErr } });
    }
    
    logger.info(`[GuestPassConsumer] Pass consumed for ${guestName} by ${ownerEmailLower}, ${passesRemaining} remaining`);
    
    return {
      success: true,
      passesRemaining,
      purchaseId
    };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    logger.error('[GuestPassConsumer] Error consuming guest pass:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error) || 'Failed to consume guest pass'
    };
  } finally {
    client.release();
  }
}

export async function canUseGuestPass(ownerEmail: string): Promise<{
  canUse: boolean;
  remaining: number;
  total: number;
}> {
  const ownerEmailLower = ownerEmail.toLowerCase().trim();
  
  try {
    const tierResult = await pool.query(
      `SELECT mt.guest_passes_per_month 
       FROM users u 
       JOIN membership_tiers mt ON LOWER(u.tier) = LOWER(mt.name)
       WHERE LOWER(u.email) = $1`,
      [ownerEmailLower]
    );
    const tierGuestPasses = tierResult.rows[0]?.guest_passes_per_month ?? 4;
    
    const result = await pool.query(
      `SELECT passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = $1`,
      [ownerEmailLower]
    );
    
    if (result.rows.length === 0) {
      return { canUse: tierGuestPasses > 0, remaining: tierGuestPasses, total: tierGuestPasses };
    }
    
    const { passes_used, passes_total } = result.rows[0];
    const remaining = Math.max(0, passes_total - passes_used);
    
    return {
      canUse: remaining > 0,
      remaining,
      total: passes_total
    };
  } catch (error: unknown) {
    logger.error('[GuestPassConsumer] Error checking guest pass availability:', { error: error });
    return { canUse: false, remaining: 0, total: 0 };
  }
}

export async function refundGuestPassForParticipant(
  participantId: number,
  ownerEmail: string,
  guestName: string
): Promise<{ success: boolean; error?: string; passesRemaining?: number }> {
  const client = await pool.connect();
  const ownerEmailLower = ownerEmail.toLowerCase().trim();
  
  try {
    await client.query('BEGIN');
    
    const participantCheck = await client.query(
      `SELECT id, used_guest_pass FROM booking_participants WHERE id = $1`,
      [participantId]
    );
    
    if (participantCheck.rows[0]?.used_guest_pass !== true) {
      await client.query('ROLLBACK');
      logger.info(`[GuestPassConsumer] Guest pass not used for participant ${participantId}, nothing to refund`);
      return { success: true, passesRemaining: undefined };
    }
    
    await client.query(
      `UPDATE guest_passes 
       SET passes_used = GREATEST(0, passes_used - 1)
       WHERE LOWER(member_email) = $1`,
      [ownerEmailLower]
    );
    
    const passResult = await client.query(
      `SELECT passes_total - passes_used as remaining FROM guest_passes WHERE LOWER(member_email) = $1`,
      [ownerEmailLower]
    );
    
    // Look up guest fee from the Guest Pass Stripe product price
    const { PRICING } = await import('./pricingConfig');
    let guestFeeCents = PRICING.GUEST_FEE_CENTS; // Default fallback
    try {
      const priceResult = await client.query(
        `SELECT stripe_price_id FROM membership_tiers WHERE LOWER(name) = 'guest pass' AND stripe_price_id IS NOT NULL`
      );
      if (priceResult.rows[0]?.stripe_price_id) {
        const { getStripeClient } = await import('../stripe/client');
        const stripe = await getStripeClient();
        const price = await stripe.prices.retrieve(priceResult.rows[0].stripe_price_id);
        if (price.unit_amount) {
          guestFeeCents = price.unit_amount;
        }
      }
    } catch (err: unknown) {
      logger.warn(`[GuestPassConsumer] Failed to fetch Stripe guest fee price, using default $${PRICING.GUEST_FEE_DOLLARS}:`, { error: err });
    }
    
    await client.query(
      `UPDATE booking_participants 
       SET payment_status = 'pending', 
           cached_fee_cents = $2,
           used_guest_pass = FALSE
       WHERE id = $1`,
      [participantId, guestFeeCents]
    );
    
    await client.query(
      `DELETE FROM legacy_purchases 
       WHERE LOWER(member_email) = $1 
         AND item_category = 'guest_pass'
         AND item_name LIKE $2
         AND item_total_cents = 0
         AND id = (
           SELECT id FROM legacy_purchases 
           WHERE LOWER(member_email) = $1 
             AND item_category = 'guest_pass'
             AND item_name LIKE $2
             AND item_total_cents = 0
           ORDER BY created_at DESC
           LIMIT 1
         )`,
      [ownerEmailLower, `Guest Pass - ${guestName}%`]
    );
    
    await client.query('COMMIT');
    
    const remaining = passResult.rows[0]?.remaining ?? 0;
    logger.info(`[GuestPassConsumer] Pass refunded for ${guestName}, ${ownerEmailLower} now has ${remaining} remaining`);
    
    return {
      success: true,
      passesRemaining: remaining
    };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    logger.error('[GuestPassConsumer] Error refunding guest pass:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error) || 'Failed to refund guest pass'
    };
  } finally {
    client.release();
  }
}
