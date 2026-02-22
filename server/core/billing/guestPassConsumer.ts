import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../../utils/errorUtils';
import { syncBookingInvoice } from './bookingInvoiceService';

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
  
  const ownerEmailLower = ownerEmail.toLowerCase().trim();
  
  try {
    let passesRemaining: number = 0;
    let purchaseId: number | undefined;
    
    await db.transaction(async (tx) => {
      const alreadyUsed = await tx.execute(sql`SELECT id, used_guest_pass, guest_id FROM booking_participants WHERE id = ${participantId}`);
      
      if ((alreadyUsed.rows[0] as Record<string, unknown>)?.used_guest_pass === true) {
        logger.info(`[GuestPassConsumer] Guest pass already consumed for participant ${participantId}, skipping (idempotency)`);
        passesRemaining = -1;
        return;
      }
      
      const ownerResult = await tx.execute(sql`SELECT id FROM users WHERE LOWER(email) = ${ownerEmailLower}`);
      const ownerId = (ownerResult.rows[0] as Record<string, unknown>)?.id;
      
      const tierResult = await tx.execute(sql`SELECT mt.guest_passes_per_month 
       FROM users u 
       JOIN membership_tiers mt ON LOWER(u.tier) = LOWER(mt.name)
       WHERE LOWER(u.email) = ${ownerEmailLower}`);
      const tierGuestPasses = (tierResult.rows[0] as Record<string, unknown>)?.guest_passes_per_month ?? 4;
      
      const existingPass = await tx.execute(sql`SELECT id, passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = ${ownerEmailLower} FOR UPDATE`);
      
      if (existingPass.rows.length === 0) {
        const insertResult = await tx.execute(sql`INSERT INTO guest_passes (member_email, passes_used, passes_total)
         VALUES (${ownerEmailLower}, ${1}, ${tierGuestPasses})
         RETURNING passes_total - passes_used as remaining`);
        passesRemaining = (insertResult.rows[0] as Record<string, unknown>)?.remaining as number ?? ((tierGuestPasses as number) - 1);
      } else {
        let { passes_used, passes_total } = existingPass.rows[0] as Record<string, unknown>;
        if ((tierGuestPasses as number) > (passes_total as number)) {
          await tx.execute(sql`UPDATE guest_passes SET passes_total = ${tierGuestPasses} WHERE LOWER(member_email) = ${ownerEmailLower}`);
          passes_total = tierGuestPasses;
        }
        if ((passes_used as number) >= (passes_total as number)) {
          throw new Error(`NO_PASSES_REMAINING:No guest passes remaining. ${ownerEmailLower} has 0/${passes_total} passes available.`);
        }
        
        const updateResult = await tx.execute(sql`UPDATE guest_passes 
         SET passes_used = passes_used + 1
         WHERE LOWER(member_email) = ${ownerEmailLower}
         RETURNING passes_total - passes_used as remaining`);
        passesRemaining = (updateResult.rows[0] as Record<string, unknown>)?.remaining as number ?? 0;
      }
      
      if (ownerId) {
        const existingLedger = await tx.execute(sql`SELECT id FROM usage_ledger 
         WHERE session_id = ${sessionId} AND member_id = ${ownerId}`);
        
        if (existingLedger.rows.length > 0) {
          await tx.execute(sql`UPDATE usage_ledger 
           SET guest_fee = 0,
               payment_method = 'guest_pass'
           WHERE session_id = ${sessionId} AND member_id = ${ownerId}`);
        }
      }
      
      await tx.execute(sql`UPDATE booking_participants 
       SET payment_status = 'waived', 
           cached_fee_cents = 0,
           used_guest_pass = TRUE
       WHERE id = ${participantId}`);
      
      const purchaseResult = await tx.execute(sql`INSERT INTO legacy_purchases 
        (user_id, member_email, item_name, item_category, item_price_cents, quantity, subtotal_cents, 
         discount_percent, discount_amount_cents, tax_cents, item_total_cents, 
         payment_method, sale_date, linked_booking_session_id, is_comp, is_synced, created_at)
       VALUES (${ownerId}, ${ownerEmailLower}, ${`Guest Pass - ${guestName}`}, ${'guest_pass'}, ${0}, ${1}, ${0}, ${0}, ${0}, ${0}, ${0}, ${'guest_pass'}, ${sessionDate}, ${sessionId}, ${true}, ${false}, NOW())
       RETURNING id`);
      
      purchaseId = (purchaseResult.rows[0] as Record<string, unknown>)?.id as number;
      
      await tx.execute(sql`INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
       VALUES (${ownerEmailLower}, ${'Guest Pass Used'}, ${`Guest pass used for ${guestName}. You have ${passesRemaining} pass${passesRemaining !== 1 ? 'es' : ''} remaining this month.`}, ${'guest_pass'}, ${'guest_pass'}, NOW())`);
    });
    
    if (passesRemaining === -1) {
      return {
        success: true,
        passesRemaining: undefined
      };
    }
    
    let resolvedBookingId: number | null = null;
    try {
      const bookingResult = await db.execute(sql`SELECT id FROM booking_requests WHERE session_id = ${sessionId} LIMIT 1`);
      if (bookingResult.rows.length > 0) {
        resolvedBookingId = (bookingResult.rows[0] as Record<string, unknown>).id as number;
        await db.execute(sql`DELETE FROM guest_pass_holds 
           WHERE booking_id = ${resolvedBookingId} AND LOWER(member_email) = ${ownerEmailLower} AND passes_held <= 1;
           UPDATE guest_pass_holds 
           SET passes_held = passes_held - 1
           WHERE booking_id = ${resolvedBookingId} AND LOWER(member_email) = ${ownerEmailLower} AND passes_held > 1`);
      }
    } catch (holdErr: unknown) {
      logger.info(`[GuestPassConsumer] Hold cleanup failed (non-blocking):`, { extra: { detail: holdErr } });
    }
    
    logger.info(`[GuestPassConsumer] Pass consumed for ${guestName} by ${ownerEmailLower}, ${passesRemaining} remaining`);
    
    if (resolvedBookingId) {
      syncBookingInvoice(resolvedBookingId, sessionId).catch(err => {
        logger.warn('[GuestPassConsumer] Non-blocking: draft invoice sync failed after pass consumption', { extra: { error: getErrorMessage(err), bookingId: resolvedBookingId, sessionId } });
      });
    }

    return {
      success: true,
      passesRemaining,
      purchaseId
    };
  } catch (error: unknown) {
    const errorMsg = getErrorMessage(error) || 'Failed to consume guest pass';
    if (errorMsg.startsWith('NO_PASSES_REMAINING:')) {
      return {
        success: false,
        error: errorMsg.replace('NO_PASSES_REMAINING:', '')
      };
    }
    logger.error('[GuestPassConsumer] Error consuming guest pass:', { error: error });
    return {
      success: false,
      error: errorMsg
    };
  }
}

export async function canUseGuestPass(ownerEmail: string): Promise<{
  canUse: boolean;
  remaining: number;
  total: number;
}> {
  const ownerEmailLower = ownerEmail.toLowerCase().trim();
  
  try {
    const tierResult = await db.execute(sql`SELECT mt.guest_passes_per_month 
       FROM users u 
       JOIN membership_tiers mt ON LOWER(u.tier) = LOWER(mt.name)
       WHERE LOWER(u.email) = ${ownerEmailLower}`);
    const tierGuestPasses = (tierResult.rows[0] as Record<string, unknown>)?.guest_passes_per_month ?? 4;
    
    const result = await db.execute(sql`SELECT passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = ${ownerEmailLower}`);
    
    if (result.rows.length === 0) {
      return { canUse: (tierGuestPasses as number) > 0, remaining: tierGuestPasses as number, total: tierGuestPasses as number };
    }
    
    const row = result.rows[0] as Record<string, unknown>;
    const { passes_used, passes_total } = row;
    const remaining = Math.max(0, (passes_total as number) - (passes_used as number));
    
    return {
      canUse: remaining > 0,
      remaining,
      total: passes_total as number
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
  const ownerEmailLower = ownerEmail.toLowerCase().trim();
  
  try {
    let remaining: number = 0;
    
    await db.transaction(async (tx) => {
      const participantCheck = await tx.execute(sql`SELECT id, used_guest_pass FROM booking_participants WHERE id = ${participantId}`);
      
      if ((participantCheck.rows[0] as Record<string, unknown>)?.used_guest_pass !== true) {
        logger.info(`[GuestPassConsumer] Guest pass not used for participant ${participantId}, nothing to refund`);
        remaining = -1;
        return;
      }
      
      await tx.execute(sql`UPDATE guest_passes 
       SET passes_used = GREATEST(0, passes_used - 1)
       WHERE LOWER(member_email) = ${ownerEmailLower}`);
      
      const passResult = await tx.execute(sql`SELECT passes_total - passes_used as remaining FROM guest_passes WHERE LOWER(member_email) = ${ownerEmailLower}`);
      
      const { PRICING } = await import('./pricingConfig');
      let guestFeeCents = PRICING.GUEST_FEE_CENTS;
      try {
        const priceResult = await tx.execute(sql`SELECT stripe_price_id FROM membership_tiers WHERE LOWER(name) = 'guest pass' AND stripe_price_id IS NOT NULL`);
        if ((priceResult.rows[0] as Record<string, unknown>)?.stripe_price_id) {
          const { getStripeClient } = await import('../stripe/client');
          const stripe = await getStripeClient();
          const price = await stripe.prices.retrieve((priceResult.rows[0] as Record<string, unknown>).stripe_price_id as string);
          if (price.unit_amount) {
            guestFeeCents = price.unit_amount;
          }
        }
      } catch (err: unknown) {
        logger.warn(`[GuestPassConsumer] Failed to fetch Stripe guest fee price, using default $${PRICING.GUEST_FEE_DOLLARS}:`, { error: err });
      }
      
      await tx.execute(sql`UPDATE booking_participants 
       SET payment_status = 'pending', 
           cached_fee_cents = ${guestFeeCents},
           used_guest_pass = FALSE
       WHERE id = ${participantId}`);
      
      await tx.execute(sql`DELETE FROM legacy_purchases 
       WHERE LOWER(member_email) = ${ownerEmailLower} 
         AND item_category = 'guest_pass'
         AND item_name LIKE ${`Guest Pass - ${guestName}%`}
         AND item_total_cents = 0
         AND id = (
           SELECT id FROM legacy_purchases 
           WHERE LOWER(member_email) = ${ownerEmailLower} 
             AND item_category = 'guest_pass'
             AND item_name LIKE ${`Guest Pass - ${guestName}%`}
             AND item_total_cents = 0
           ORDER BY created_at DESC
           LIMIT 1
         )`);
      
      remaining = (passResult.rows[0] as Record<string, unknown>)?.remaining as number ?? 0;
    });
    
    if (remaining === -1) {
      return { success: true, passesRemaining: undefined };
    }
    
    logger.info(`[GuestPassConsumer] Pass refunded for ${guestName}, ${ownerEmailLower} now has ${remaining} remaining`);
    
    try {
      const sessionResult = await db.execute(sql`SELECT bs.id as session_id, br.id as booking_id 
         FROM booking_participants bp 
         JOIN booking_sessions bs ON bp.session_id = bs.id
         JOIN booking_requests br ON br.session_id = bs.id
         WHERE bp.id = ${participantId} LIMIT 1`);
      if ((sessionResult.rows[0] as Record<string, unknown>)) {
        const row = sessionResult.rows[0] as Record<string, unknown>;
        syncBookingInvoice(row.booking_id as number, row.session_id as number).catch(err => {
          logger.warn('[GuestPassConsumer] Non-blocking: draft invoice sync failed after pass refund', { extra: { error: getErrorMessage(err) } });
        });
      }
    } catch (syncErr) {
      logger.warn('[GuestPassConsumer] Non-blocking: failed to sync invoice after pass refund');
    }

    return {
      success: true,
      passesRemaining: remaining
    };
  } catch (error: unknown) {
    logger.error('[GuestPassConsumer] Error refunding guest pass:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error) || 'Failed to refund guest pass'
    };
  }
}
