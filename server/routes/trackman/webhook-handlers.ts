import { pool } from '../../core/db';
import { logger } from '../../core/logger';
import { sendNotificationToUser, broadcastToStaff, broadcastAvailabilityUpdate } from '../../core/websocket';
import { notifyAllStaff } from '../../core/staffNotifications';
import { notifyMember } from '../../core/notificationService';
import { linkAndNotifyParticipants } from '../../core/bookingEvents';
import { formatDatePacific, formatTimePacific } from '../../utils/dateUtils';
import { checkUnifiedAvailability } from '../../core/bookingService/availabilityGuard';
import { cancelPaymentIntent, getStripeClient } from '../../core/stripe';
import {
  TrackmanWebhookPayload,
  TrackmanV2WebhookPayload,
  TrackmanV2Booking,
  NormalizedBookingFields,
  extractBookingData,
  isTrackmanV2Payload,
  normalizeBookingFields,
  parseDateTime,
  mapBayNameToResourceId,
  parseTrackmanV2Payload,
  calculateDurationMinutes,
} from './webhook-helpers';
import { resolveLinkedEmail, findMemberByEmail, logWebhookEvent } from './webhook-validation';
import { 
  updateBaySlotCache, 
  createBookingForMember, 
  linkByExternalBookingId,
  refundGuestPassesForCancelledBooking
} from './webhook-billing';
import { refundGuestPass } from '../guestPasses';
import { sendPushNotificationToStaff } from '../push';
import { createSessionWithUsageTracking } from '../../core/bookingService/sessionManager';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { logSystemAction } from '../../core/auditLog';
import { createPrepaymentIntent } from '../../core/billing/prepaymentService';

export async function tryAutoApproveBooking(
  customerEmail: string,
  slotDate: string,
  startTime: string,
  trackmanBookingId: string
): Promise<{ matched: boolean; bookingId?: number; resourceId?: number; sessionId?: number }> {
  try {
    const result = await pool.query(
      `SELECT br.id, br.user_email, br.user_name, br.staff_notes, br.resource_id, 
              br.start_time, br.end_time, br.duration_minutes, br.session_id,
              u.id as user_id
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
       WHERE LOWER(br.user_email) = LOWER($1)
         AND br.request_date = $2
         AND ABS(EXTRACT(EPOCH FROM (br.start_time::time - $3::time))) <= 600
         AND (
           (br.start_time < br.end_time AND $3::time < br.end_time)
           OR
           (br.start_time >= br.end_time AND ($3::time < br.end_time OR $3::time >= br.start_time))
         )
         AND br.status = 'pending'
         AND br.trackman_booking_id IS NULL
       ORDER BY ABS(EXTRACT(EPOCH FROM (br.start_time::time - $3::time))), br.created_at DESC
       LIMIT 1`,
      [customerEmail, slotDate, startTime]
    );
    
    if (result.rows.length === 0) {
      return { matched: false };
    }
    
    const pendingBooking = result.rows[0];
    const bookingId = pendingBooking.id;
    const resourceId = pendingBooking.resource_id;
    
    const updatedNotes = (pendingBooking.staff_notes || '') + ' [Auto-approved via Trackman webhook]';
    
    const updateResult = await pool.query(
      `UPDATE booking_requests 
       SET status = 'approved', 
           trackman_booking_id = $1, 
           staff_notes = $2,
           reviewed_by = 'trackman_webhook',
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $3 AND trackman_booking_id IS NULL
       RETURNING id`,
      [trackmanBookingId, updatedNotes, bookingId]
    );
    
    if (updateResult.rowCount === 0) {
      logger.warn('[Trackman Webhook] Pending booking was already linked by another process', {
        extra: { bookingId, trackmanBookingId, email: customerEmail, date: slotDate, time: startTime }
      });
      return { matched: false };
    }
    
    let createdSessionId: number | undefined;
    
    if (!pendingBooking.session_id && resourceId) {
      try {
        const sessionResult = await createSessionWithUsageTracking(
          {
            ownerEmail: pendingBooking.user_email,
            resourceId: resourceId,
            sessionDate: slotDate,
            startTime: pendingBooking.start_time,
            endTime: pendingBooking.end_time,
            durationMinutes: pendingBooking.duration_minutes || 60,
            participants: [{
              userId: pendingBooking.user_id || undefined,
              participantType: 'owner',
              displayName: pendingBooking.user_name || pendingBooking.user_email
            }],
            trackmanBookingId: trackmanBookingId
          },
          'trackman_webhook'
        );
        
        if (sessionResult.success && sessionResult.session) {
          createdSessionId = sessionResult.session.id;
          
          await pool.query(
            `UPDATE booking_requests SET session_id = $1 WHERE id = $2`,
            [createdSessionId, bookingId]
          );
          
          try {
            const breakdown = await recalculateSessionFees(createdSessionId, 'approval');
            logger.info('[Trackman Webhook] Applied unified fees for auto-approved session', {
              extra: { 
                sessionId: createdSessionId, 
                bookingId, 
                totalCents: breakdown.totals.totalCents 
              }
            });
            
            if (breakdown.totals.totalCents > 0) {
              try {
                await createPrepaymentIntent({
                  sessionId: createdSessionId,
                  bookingId,
                  userId: pendingBooking.user_id || null,
                  userEmail: pendingBooking.user_email,
                  userName: pendingBooking.user_name || pendingBooking.user_email,
                  totalFeeCents: breakdown.totals.totalCents,
                  feeBreakdown: { overageCents: breakdown.totals.overageCents, guestCents: breakdown.totals.guestCents }
                });
              } catch (prepayError) {
                logger.warn('[Trackman Webhook] Failed to create prepayment intent', {
                  extra: { sessionId: createdSessionId, error: prepayError }
                });
              }
            }
          } catch (feeError) {
            logger.warn('[Trackman Webhook] Failed to calculate fees for auto-approved session', {
              extra: { sessionId: createdSessionId, error: feeError }
            });
          }
          
          logger.info('[Trackman Webhook] Created session for auto-approved booking', {
            extra: { sessionId: createdSessionId, bookingId, trackmanBookingId }
          });
        } else {
          logger.warn('[Trackman Webhook] Session creation failed for auto-approved booking', {
            extra: { bookingId, error: sessionResult.error }
          });
        }
      } catch (sessionError) {
        logger.warn('[Trackman Webhook] Failed to create session for auto-approved booking', {
          extra: { bookingId, error: sessionError }
        });
      }
    }
    
    logger.info('[Trackman Webhook] Auto-approved pending booking', {
      extra: { bookingId, trackmanBookingId, email: customerEmail, date: slotDate, time: startTime, sessionId: createdSessionId }
    });
    
    return { matched: true, bookingId, resourceId, sessionId: createdSessionId };
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to auto-approve booking', { error: e as Error });
    return { matched: false };
  }
}

export async function cancelBookingByTrackmanId(
  trackmanBookingId: string
): Promise<{ cancelled: boolean; bookingId?: number; refundedPasses?: number }> {
  try {
    const result = await pool.query(
      `SELECT br.id, br.user_email, br.user_name, br.status, br.session_id, 
              br.request_date, br.start_time, br.resource_id,
              r.name as resource_name
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       WHERE br.trackman_booking_id = $1`,
      [trackmanBookingId]
    );
    
    if (result.rows.length === 0) {
      return { cancelled: false };
    }
    
    const booking = result.rows[0];
    const bookingId = booking.id;
    const memberEmail = booking.user_email;
    const memberName = booking.user_name || memberEmail || 'Unknown';
    const bookingDate = booking.request_date;
    const startTime = booking.start_time;
    const bayName = booking.resource_name;
    
    if (booking.status === 'cancelled') {
      return { cancelled: true, bookingId };
    }
    
    await pool.query(
      `UPDATE booking_requests 
       SET status = 'cancelled', 
           staff_notes = COALESCE(staff_notes, '') || ' [Cancelled via Trackman webhook]',
           updated_at = NOW()
       WHERE id = $1`,
      [bookingId]
    );
    
    // Clear any pending fees for this booking's session
    if (booking.session_id) {
      try {
        await pool.query(
          `UPDATE booking_participants 
           SET cached_fee_cents = 0, payment_status = 'waived'
           WHERE session_id = $1 
           AND payment_status = 'pending'`,
          [booking.session_id]
        );
        logger.info('[Trackman Webhook] Cleared pending fees for cancelled booking', {
          extra: { bookingId, sessionId: booking.session_id }
        });
      } catch (feeErr) {
        logger.warn('[Trackman Webhook] Failed to clear fees for cancelled booking', {
          extra: { bookingId, sessionId: booking.session_id, error: (feeErr as Error).message }
        });
      }
    }
    
    // Cancel pending payment intents for this booking
    try {
      const pendingIntents = await pool.query(
        `SELECT stripe_payment_intent_id 
         FROM stripe_payment_intents 
         WHERE booking_id = $1 AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')`,
        [bookingId]
      );
      for (const row of pendingIntents.rows) {
        try {
          await cancelPaymentIntent(row.stripe_payment_intent_id);
          logger.info('[Trackman Webhook] Cancelled payment intent', {
            extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
          });
        } catch (cancelErr: any) {
          logger.warn('[Trackman Webhook] Failed to cancel payment intent', {
            extra: { paymentIntentId: row.stripe_payment_intent_id, error: cancelErr.message }
          });
        }
      }
    } catch (cancelIntentsErr) {
      logger.warn('[Trackman Webhook] Failed to cancel pending payment intents', { error: cancelIntentsErr as Error });
    }
    
    // Refund already-paid participant fees
    if (booking.session_id) {
      try {
        const paidParticipants = await pool.query(
          `SELECT id, stripe_payment_intent_id, cached_fee_cents, display_name
           FROM booking_participants 
           WHERE session_id = $1 
           AND payment_status = 'paid' 
           AND stripe_payment_intent_id IS NOT NULL 
           AND stripe_payment_intent_id != ''
           AND stripe_payment_intent_id NOT LIKE 'balance-%'
           AND refunded_at IS NULL`,
          [booking.session_id]
        );
        
        if (paidParticipants.rows.length > 0) {
          const stripe = await getStripeClient();
          for (const participant of paidParticipants.rows) {
            try {
              const pi = await stripe.paymentIntents.retrieve(participant.stripe_payment_intent_id, {
                expand: ['latest_charge.refunds']
              });
              
              // Check if already refunded in Stripe to prevent double-refund
              const charge = pi.latest_charge as any;
              const alreadyRefunded = charge?.refunds?.data?.length > 0;
              
              if (alreadyRefunded) {
                logger.info('[Trackman Webhook] Payment already refunded in Stripe, marking participant', {
                  extra: { participantId: participant.id, paymentIntentId: participant.stripe_payment_intent_id }
                });
                // Update participant
                await pool.query(
                  `UPDATE booking_participants 
                   SET refunded_at = NOW(), payment_status = 'waived'
                   WHERE id = $1`,
                  [participant.id]
                );
                // Update stripe_payment_intents for consistency
                await pool.query(
                  `UPDATE stripe_payment_intents 
                   SET status = 'refunded', updated_at = NOW()
                   WHERE stripe_payment_intent_id = $1 AND status != 'refunded'`,
                  [participant.stripe_payment_intent_id]
                );
                // Update booking_fee_snapshots for consistency
                await pool.query(
                  `UPDATE booking_fee_snapshots 
                   SET status = 'refunded'
                   WHERE stripe_payment_intent_id = $1 AND status != 'refunded'`,
                  [participant.stripe_payment_intent_id]
                );
                continue;
              }
              
              if (pi.status === 'succeeded' && pi.latest_charge) {
                const refund = await stripe.refunds.create({
                  charge: typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id,
                  reason: 'requested_by_customer',
                  metadata: {
                    type: 'booking_cancelled_via_trackman',
                    bookingId: bookingId.toString(),
                    participantId: participant.id.toString()
                  }
                });
                
                // Mark participant as refunded
                await pool.query(
                  `UPDATE booking_participants 
                   SET refunded_at = NOW(), payment_status = 'waived'
                   WHERE id = $1`,
                  [participant.id]
                );
                
                // Update stripe_payment_intents status for consistency
                await pool.query(
                  `UPDATE stripe_payment_intents 
                   SET status = 'refunded', updated_at = NOW()
                   WHERE stripe_payment_intent_id = $1`,
                  [participant.stripe_payment_intent_id]
                );
                
                // Update booking_fee_snapshots status if exists
                await pool.query(
                  `UPDATE booking_fee_snapshots 
                   SET status = 'refunded'
                   WHERE stripe_payment_intent_id = $1`,
                  [participant.stripe_payment_intent_id]
                );
                
                logger.info('[Trackman Webhook] Refunded participant fee', {
                  extra: { 
                    bookingId, 
                    participantId: participant.id,
                    displayName: participant.display_name,
                    amount: participant.cached_fee_cents / 100,
                    refundId: refund.id
                  }
                });
              }
            } catch (refundErr: any) {
              logger.error('[Trackman Webhook] Failed to refund participant', {
                error: refundErr as Error,
                extra: { participantId: participant.id, paymentIntentId: participant.stripe_payment_intent_id }
              });
            }
          }
        }
      } catch (refundParticipantsErr) {
        logger.error('[Trackman Webhook] Failed to process participant refunds', { error: refundParticipantsErr as Error });
      }
    }
    
    const refundedPasses = await refundGuestPassesForCancelledBooking(bookingId, memberEmail);
    
    // Send real-time notifications to staff
    try {
      const formattedDate = bookingDate ? formatDatePacific(new Date(bookingDate)) : 'Unknown date';
      const formattedTime = startTime ? formatTimePacific(startTime) : 'Unknown time';
      const bayInfo = bayName ? ` (${bayName})` : '';
      const refundInfo = refundedPasses && refundedPasses > 0 
        ? `. Refunded: ${refundedPasses} guest pass${refundedPasses > 1 ? 'es' : ''}`
        : '';
      
      const notificationTitle = 'Booking Cancelled via TrackMan';
      const notificationMessage = `Booking cancelled via TrackMan: ${memberName}'s booking on ${formattedDate} at ${formattedTime}${bayInfo}${refundInfo}`;
      
      broadcastToStaff({
        type: 'booking_cancelled',
        title: notificationTitle,
        message: notificationMessage,
        data: {
          bookingId,
          memberEmail,
          memberName,
          date: bookingDate,
          time: startTime,
          bayName,
          refundedPasses,
          source: 'trackman_webhook'
        }
      });
      
      await sendPushNotificationToStaff({
        title: notificationTitle,
        body: notificationMessage,
        url: '/admin/bookings',
        tag: `booking-cancelled-${bookingId}`
      });
      
      logger.info('[Trackman Webhook] Sent staff notifications for cancelled booking', {
        extra: { bookingId, memberEmail, refundedPasses }
      });
    } catch (notifyErr) {
      logger.warn('[Trackman Webhook] Failed to send staff notifications for cancelled booking', {
        extra: { bookingId, error: (notifyErr as Error).message }
      });
    }
    
    // Log audit entry for the cancellation
    try {
      await logSystemAction({
        action: 'booking_cancelled_webhook',
        resourceType: 'booking',
        resourceId: String(bookingId),
        resourceName: `Booking for ${memberEmail}`,
        details: {
          source: 'trackman_webhook',
          trackman_booking_id: trackmanBookingId,
          member_email: memberEmail,
          refund_amount_cents: 0,
          refund_type: refundedPasses ? 'guest_pass' : 'none',
          refunded_passes: refundedPasses || 0,
          booking_date: bookingDate,
          booking_time: startTime,
          bay_name: bayName
        }
      });
    } catch (auditErr) {
      logger.warn('[Trackman Webhook] Failed to log audit entry for cancelled booking', {
        extra: { bookingId, error: (auditErr as Error).message }
      });
    }
    
    logger.info('[Trackman Webhook] Cancelled booking via Trackman ID', {
      extra: { bookingId, trackmanBookingId, refundedPasses }
    });
    
    return { cancelled: true, bookingId, refundedPasses };
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to cancel booking', { error: e as Error });
    return { cancelled: false };
  }
}

export async function saveToUnmatchedBookings(
  trackmanBookingId: string,
  slotDate: string,
  startTime: string,
  endTime: string,
  resourceId: number | null,
  customerEmail: string | undefined,
  customerName: string | undefined,
  playerCount: number,
  reason?: string
): Promise<{ success: boolean; id?: number }> {
  try {
    const existingResult = await pool.query(
      `SELECT id FROM trackman_unmatched_bookings WHERE trackman_booking_id = $1`,
      [trackmanBookingId]
    );
    
    if (existingResult.rows.length > 0) {
      await pool.query(
        `UPDATE trackman_unmatched_bookings 
         SET booking_date = $2, start_time = $3, end_time = $4, bay_number = $5,
             original_email = $6, user_name = $7, player_count = $8, 
             match_attempt_reason = COALESCE($9, match_attempt_reason),
             updated_at = NOW()
         WHERE trackman_booking_id = $1`,
        [trackmanBookingId, slotDate, startTime, endTime, resourceId, 
         customerEmail, customerName, playerCount, reason]
      );
      return { success: true, id: existingResult.rows[0].id };
    }
    
    const result = await pool.query(
      `INSERT INTO trackman_unmatched_bookings 
       (trackman_booking_id, booking_date, start_time, end_time, bay_number, 
        original_email, user_name, player_count, status, match_attempt_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, NOW())
       RETURNING id`,
      [trackmanBookingId, slotDate, startTime, endTime, resourceId, 
       customerEmail, customerName, playerCount, reason || 'no_member_match']
    );
    
    logger.info('[Trackman Webhook] Saved to unmatched bookings', {
      extra: { trackmanBookingId, email: customerEmail, name: customerName, date: slotDate }
    });
    
    return { success: true, id: result.rows[0]?.id };
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to save unmatched booking', { error: e as Error });
    return { success: false };
  }
}

export async function createUnmatchedBookingRequest(
  trackmanBookingId: string,
  externalBookingId: string | undefined,
  slotDate: string,
  startTime: string,
  endTime: string,
  resourceId: number | null,
  customerEmail: string | undefined,
  customerName: string | undefined,
  playerCount: number
): Promise<{ created: boolean; bookingId?: number }> {
  try {
    const durationMinutes = calculateDurationMinutes(startTime, endTime);
    
    // Pre-check availability before INSERT for better error logging
    // FIX: If conflict with Private Event, set status to 'pending' instead of 'approved'
    let bookingStatus = 'approved';
    let conflictNote = '';
    
    if (resourceId) {
      const availability = await checkUnifiedAvailability(resourceId, slotDate, startTime, endTime);
      if (!availability.available) {
        logger.warn('[Trackman Webhook] Conflict detected before creating unmatched booking', {
          extra: {
            trackmanBookingId,
            date: slotDate,
            time: startTime,
            endTime,
            resourceId,
            conflictType: availability.conflictType,
            conflictTitle: availability.conflictTitle,
            conflictDetails: availability.conflictDetails
          }
        });
        
        // If conflict is a Private Event block, downgrade to pending for staff review
        if (availability.conflictType === 'private_event' || availability.conflictType === 'availability_block') {
          bookingStatus = 'pending';
          conflictNote = ` [Pending: Conflicts with ${availability.conflictTitle || 'private event'}]`;
          logger.info('[Trackman Webhook] Downgrading to pending due to private event conflict', {
            extra: { trackmanBookingId, conflictType: availability.conflictType, conflictTitle: availability.conflictTitle }
          });
        }
        // Still attempt INSERT - DB trigger will prevent true double-booking
        // but log this clearly so staff can investigate
      }
    }
    
    // Use INSERT ... ON CONFLICT to atomically prevent duplicate trackman_booking_id
    // This prevents race conditions when multiple webhooks arrive simultaneously
    const result = await pool.query(
      `INSERT INTO booking_requests 
       (request_date, start_time, end_time, duration_minutes, resource_id,
        user_email, user_name, status, trackman_booking_id, trackman_external_id,
        trackman_player_count, is_unmatched, staff_notes,
        origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $11, $8, $9, $10, true, $12,
               'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
       ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
         last_trackman_sync_at = NOW(),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS was_inserted`,
      [
        slotDate,
        startTime,
        endTime,
        durationMinutes,
        resourceId,
        customerEmail || '',
        customerName || 'Unknown (Trackman)',
        trackmanBookingId,
        externalBookingId || null,
        playerCount,
        bookingStatus,
        conflictNote || null
      ]
    );
    
    if (result.rows.length > 0) {
      const bookingId = result.rows[0].id;
      const wasInserted = result.rows[0].was_inserted;
      
      // If this was a duplicate (ON CONFLICT triggered), just return the existing booking
      if (!wasInserted) {
        logger.info('[Trackman Webhook] Booking already exists for this Trackman ID (atomic dedup)', {
          extra: { trackmanBookingId, existingBookingId: bookingId }
        });
        return { created: false, bookingId };
      }
      
      // Only create session for newly inserted bookings
      try {
        const sessionResult = await pool.query(`
          INSERT INTO booking_sessions (resource_id, session_date, start_time, end_time, trackman_booking_id, source, created_by)
          VALUES ($1, $2, $3, $4, $5, 'trackman', 'trackman_webhook')
          RETURNING id
        `, [resourceId, slotDate, startTime, endTime, trackmanBookingId]);
        
        if (sessionResult.rows.length > 0) {
          await pool.query(`UPDATE booking_requests SET session_id = $1 WHERE id = $2`, 
            [sessionResult.rows[0].id, bookingId]);
        }
      } catch (sessionErr) {
        logger.warn('[Trackman Webhook] Failed to create billing session for unmatched booking', 
          { extra: { bookingId, error: sessionErr } });
      }
      
      logger.info('[Trackman Webhook] Created unmatched booking_request to block calendar', {
        extra: { bookingId, trackmanBookingId, date: slotDate, time: startTime }
      });
      
      return { created: true, bookingId };
    }
    
    return { created: false };
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to create unmatched booking_request', { error: e as Error });
    return { created: false };
  }
}

async function tryLinkCancelledBooking(
  customerEmail: string,
  slotDate: string,
  startTime: string,
  trackmanBookingId: string
): Promise<{ matched: boolean; bookingId?: number; refundedPasses?: number }> {
  try {
    // Match cancelled booking within 10-min tolerance (600 seconds)
    // Also require end_time > webhook start_time to prevent matching previous slot
    // Handle cross-midnight bookings: if start_time >= end_time, booking spans midnight
    const result = await pool.query(
      `SELECT id, user_email, staff_notes, session_id FROM booking_requests 
       WHERE LOWER(user_email) = LOWER($1)
         AND request_date = $2
         AND ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 600
         AND (
           (start_time < end_time AND $3::time < end_time)
           OR
           (start_time >= end_time AND ($3::time < end_time OR $3::time >= start_time))
         )
         AND status = 'cancelled'
         AND updated_at >= NOW() - INTERVAL '24 hours'
         AND trackman_booking_id IS NULL
       ORDER BY ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))), updated_at DESC
       LIMIT 1`,
      [customerEmail, slotDate, startTime]
    );
    
    if (result.rows.length === 0) {
      return { matched: false };
    }
    
    const cancelledBooking = result.rows[0];
    const bookingId = cancelledBooking.id;
    const memberEmail = cancelledBooking.user_email;
    
    const updatedNotes = (cancelledBooking.staff_notes || '') + 
      ' [Trackman booking linked - request was cancelled, manual Trackman cancellation may be needed]';
    
    const updateResult = await pool.query(
      `UPDATE booking_requests 
       SET trackman_booking_id = $1, 
           staff_notes = $2,
           updated_at = NOW()
       WHERE id = $3 AND trackman_booking_id IS NULL
       RETURNING id`,
      [trackmanBookingId, updatedNotes, bookingId]
    );
    
    if (updateResult.rowCount === 0) {
      logger.warn('[Trackman Webhook] Cancelled booking was already linked by another process', {
        extra: { bookingId, trackmanBookingId, email: customerEmail, date: slotDate, time: startTime }
      });
      return { matched: false };
    }
    
    logger.info('[Trackman Webhook] Linked Trackman booking to cancelled request', {
      extra: { bookingId, trackmanBookingId, email: customerEmail, date: slotDate, time: startTime }
    });
    
    const refundedPasses = await refundGuestPassesForCancelledBooking(bookingId, memberEmail);
    
    return { matched: true, bookingId, refundedPasses };
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to link cancelled booking', { error: e as Error });
    return { matched: false };
  }
}

async function notifyStaffCancelledBookingLinked(
  memberName: string,
  memberEmail: string,
  slotDate: string,
  startTime: string,
  bayName?: string,
  bookingId?: number,
  refundedPasses?: number
): Promise<void> {
  try {
    const passInfo = refundedPasses && refundedPasses > 0 
      ? ` (${refundedPasses} guest pass${refundedPasses > 1 ? 'es' : ''} refunded)` 
      : '';
    
    const title = 'Trackman Booking Linked to Cancelled Request';
    const message = `A Trackman booking for ${memberName} (${memberEmail || 'no email'}) on ${slotDate} at ${startTime}${bayName ? ` (${bayName})` : ''} was linked to a cancelled request.${passInfo} Manual Trackman cancellation may be needed.`;
    
    broadcastToStaff({
      type: 'trackman_cancelled_link',
      title,
      message,
      data: { 
        bookingId, 
        memberEmail, 
        date: slotDate,
        time: startTime,
        refundedPasses
      }
    });
    
    await notifyAllStaff(
      title,
      message,
      'trackman_cancelled_link',
      bookingId,
      'trackman_booking'
    );
    
    logger.info('[Trackman Webhook] Notified staff about cancelled booking link', { 
      extra: { memberName, memberEmail, date: slotDate, bookingId, refundedPasses } 
    });
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to notify staff about cancelled booking', { error: e as Error });
  }
}

async function notifyMemberBookingConfirmed(
  customerEmail: string,
  bookingId: number,
  slotDate: string,
  startTime: string,
  bayName?: string
): Promise<void> {
  try {
    const userResult = await pool.query(
      `SELECT id, first_name, last_name, email FROM users WHERE LOWER(email) = LOWER($1)`,
      [customerEmail]
    );
    
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const memberName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Member';
      const message = `Your simulator booking for ${slotDate} at ${startTime}${bayName ? ` (${bayName})` : ''} has been confirmed.`;
      
      const result = await notifyMember(
        {
          userEmail: customerEmail,
          title: 'Booking Confirmed',
          message,
          type: 'booking_approved',
          relatedId: bookingId,
          relatedType: 'booking',
          url: '/bookings'
        },
        {
          sendPush: true,
          sendWebSocket: true,
          sendEmail: false
        }
      );
      
      logger.info('[Trackman Webhook] Member notified via unified service', { 
        extra: { 
          email: customerEmail, 
          bookingId,
          channels: result.deliveryResults.map(r => ({ channel: r.channel, success: r.success }))
        } 
      });
    }
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to notify member', { error: e as Error });
  }
}

async function notifyStaffBookingCreated(
  action: 'auto_approved' | 'auto_created' | 'unmatched',
  memberName: string,
  memberEmail: string | undefined,
  slotDate: string,
  startTime: string,
  bayName?: string,
  bookingId?: number
): Promise<void> {
  try {
    let title: string;
    let message: string;
    let notificationType: string;
    
    switch (action) {
      case 'auto_approved':
        title = 'Booking Auto-Approved';
        message = `${memberName}'s pending request for ${slotDate} at ${startTime}${bayName ? ` (${bayName})` : ''} was auto-approved via Trackman.`;
        notificationType = 'trackman_booking';
        break;
      case 'auto_created':
        title = 'Booking Auto-Created';
        message = `A booking for ${memberName} on ${slotDate} at ${startTime}${bayName ? ` (${bayName})` : ''} was auto-created from Trackman.`;
        notificationType = 'trackman_booking';
        break;
      case 'unmatched':
        title = 'Unmatched Trackman Booking';
        message = `Booking for "${memberName}" (${memberEmail || 'no email'}) on ${slotDate} at ${startTime} needs staff review.`;
        notificationType = 'trackman_unmatched';
        break;
    }
    
    broadcastToStaff({
      type: notificationType,
      title,
      message,
      data: { 
        bookingId, 
        memberEmail, 
        action,
        date: slotDate,
        time: startTime
      }
    });
    
    if (action === 'unmatched') {
      await notifyAllStaff(
        title,
        message,
        notificationType,
        bookingId,
        'trackman_booking'
      );
    }
    
    logger.info('[Trackman Webhook] Notified staff', { 
      extra: { action, memberName, memberEmail, date: slotDate } 
    });
  } catch (e) {
    logger.error('[Trackman Webhook] Failed to notify staff', { error: e as Error });
  }
}

export async function handleBookingUpdate(payload: TrackmanWebhookPayload): Promise<{ success: boolean; matchedBookingId?: number }> {
  let normalized: NormalizedBookingFields;
  let bayRef: string | undefined;
  
  // Detect V2 format and use appropriate parser
  if (isTrackmanV2Payload(payload)) {
    const v2Result = parseTrackmanV2Payload(payload as TrackmanV2WebhookPayload);
    normalized = v2Result.normalized;
    bayRef = v2Result.bayRef;
    
    logger.info('[Trackman Webhook] handleBookingUpdate: Processing V2 payload', {
      extra: { 
        trackmanBookingId: normalized.trackmanBookingId,
        date: normalized.parsedDate,
        time: normalized.parsedStartTime,
        bayRef
      }
    });
  } else {
    const bookingData = extractBookingData(payload);
    if (!bookingData) {
      return { success: false };
    }
    normalized = normalizeBookingFields(bookingData);
  }
  
  if (!normalized.trackmanBookingId) {
    logger.warn('[Trackman Webhook] No booking ID in payload');
    return { success: false };
  }
  
  // For V2 payloads, parsedDate/parsedStartTime are pre-populated
  // For V1 payloads, we need to parse from startTime/date
  let startParsed: { date: string; time: string } | null = null;
  let endParsed: { time: string } | null = null;
  
  if (normalized.parsedDate && normalized.parsedStartTime) {
    startParsed = { date: normalized.parsedDate, time: normalized.parsedStartTime };
    endParsed = normalized.parsedEndTime ? { time: normalized.parsedEndTime } : null;
  } else {
    startParsed = parseDateTime(normalized.startTime, normalized.date);
    endParsed = parseDateTime(normalized.endTime, undefined);
  }
  
  if (!startParsed) {
    logger.warn('[Trackman Webhook] Could not parse start time', { extra: { startTime: normalized.startTime } });
    return { success: false };
  }
  
  const resourceId = mapBayNameToResourceId(normalized.bayName, normalized.bayId, normalized.baySerial, bayRef);
  
  if (!resourceId && (normalized.bayName || normalized.bayId || normalized.baySerial)) {
    logger.warn('[Trackman Webhook] Could not map bay to resource ID', {
      extra: { 
        trackmanBookingId: normalized.trackmanBookingId,
        bayName: normalized.bayName,
        bayId: normalized.bayId,
        baySerial: normalized.baySerial
      }
    });
  }
  
  const status = normalized.status?.toLowerCase();
  const isCancel = status === 'cancelled' || status === 'canceled' || status === 'deleted';
  const slotStatus: 'booked' | 'cancelled' | 'completed' = isCancel ? 'cancelled' : 
    (status === 'completed' || status === 'finished') ? 'completed' : 'booked';
  
  if (resourceId) {
    await updateBaySlotCache(
      normalized.trackmanBookingId,
      resourceId,
      startParsed.date,
      startParsed.time,
      endParsed?.time || startParsed.time,
      slotStatus,
      normalized.customerEmail,
      normalized.customerName,
      normalized.playerCount
    );
  }
  
  let matchedBookingId: number | undefined;
  
  if (isCancel) {
    const cancelResult = await cancelBookingByTrackmanId(normalized.trackmanBookingId);
    if (cancelResult.cancelled) {
      matchedBookingId = cancelResult.bookingId;
      
      // Broadcast availability update for real-time calendar refresh
      broadcastAvailabilityUpdate({
        resourceId,
        date: startParsed.date,
        action: 'cancelled',
        bookingId: cancelResult.bookingId
      });
      
      logger.info('[Trackman Webhook] Handled booking cancellation', {
        extra: { trackmanBookingId: normalized.trackmanBookingId, bookingId: cancelResult.bookingId }
      });
    }
    return { success: true, matchedBookingId };
  }
  
  if (!normalized.customerEmail) {
    logger.info('[Trackman Webhook] No customer email provided, creating unmatched booking request', {
      extra: { trackmanBookingId: normalized.trackmanBookingId }
    });
    
    // Also save to legacy unmatched table for backward compatibility
    await saveToUnmatchedBookings(
      normalized.trackmanBookingId,
      startParsed.date,
      startParsed.time,
      endParsed?.time || startParsed.time,
      resourceId,
      undefined,
      normalized.customerName,
      normalized.playerCount,
      'no_customer_email_in_webhook'
    );
    
    // Create a proper booking request so it appears on calendar and in assignment queue
    const unmatchedResult = await createUnmatchedBookingRequest(
      normalized.trackmanBookingId,
      normalized.externalBookingId,
      startParsed.date,
      startParsed.time,
      endParsed?.time || startParsed.time,
      resourceId,
      undefined,  // No customer email
      normalized.customerName,
      normalized.playerCount
    );
    
    // Broadcast availability update for real-time calendar refresh
    if (unmatchedResult.bookingId) {
      broadcastAvailabilityUpdate({
        resourceId,
        date: startParsed.date,
        action: 'created',
        bookingId: unmatchedResult.bookingId
      });
    }
    
    // Notify staff about unmatched booking (no customer email in webhook)
    await notifyStaffBookingCreated(
      'unmatched',
      normalized.customerName || 'Unknown',
      undefined,
      startParsed.date,
      startParsed.time,
      normalized.bayName,
      unmatchedResult.bookingId
    );
    
    return { success: true, matchedBookingId: unmatchedResult.bookingId };
  }
  
  const resolvedEmail = await resolveLinkedEmail(normalized.customerEmail);
  const emailForLookup = resolvedEmail;
  
  logger.info('[Trackman Webhook] Processing booking', {
    extra: { 
      originalEmail: normalized.customerEmail, 
      resolvedEmail: emailForLookup,
      wasLinked: emailForLookup !== normalized.customerEmail,
      date: startParsed.date,
      time: startParsed.time
    }
  });
  
  const autoApproveResult = await tryAutoApproveBooking(
    emailForLookup,
    startParsed.date,
    startParsed.time,
    normalized.trackmanBookingId
  );
  
  if (autoApproveResult.matched && autoApproveResult.bookingId) {
    matchedBookingId = autoApproveResult.bookingId;
    
    // Broadcast availability update for real-time calendar refresh
    broadcastAvailabilityUpdate({
      resourceId: autoApproveResult.resourceId || resourceId,
      date: startParsed.date,
      action: 'approved',
      bookingId: autoApproveResult.bookingId
    });
    
    await notifyMemberBookingConfirmed(
      emailForLookup,
      autoApproveResult.bookingId,
      startParsed.date,
      startParsed.time,
      normalized.bayName
    );
    
    await notifyStaffBookingCreated(
      'auto_approved',
      normalized.customerName || emailForLookup,
      emailForLookup,
      startParsed.date,
      startParsed.time,
      normalized.bayName,
      autoApproveResult.bookingId
    );
    
    linkAndNotifyParticipants(autoApproveResult.bookingId, {
      trackmanBookingId: normalized.trackmanBookingId,
      linkedBy: 'trackman_webhook',
      bayName: normalized.bayName
    }).catch(err => {
      logger.warn('[Trackman Webhook] Failed to link request participants', { extra: { bookingId: autoApproveResult.bookingId, error: err } });
    });
    
    logger.info('[Trackman Webhook] Auto-approved pending booking request', {
      extra: { bookingId: matchedBookingId, email: emailForLookup }
    });
    return { success: true, matchedBookingId };
  }
  
  const cancelledLinkResult = await tryLinkCancelledBooking(
    emailForLookup,
    startParsed.date,
    startParsed.time,
    normalized.trackmanBookingId
  );
  
  if (cancelledLinkResult.matched && cancelledLinkResult.bookingId) {
    matchedBookingId = cancelledLinkResult.bookingId;
    
    await notifyStaffCancelledBookingLinked(
      normalized.customerName || emailForLookup,
      emailForLookup,
      startParsed.date,
      startParsed.time,
      normalized.bayName,
      cancelledLinkResult.bookingId,
      cancelledLinkResult.refundedPasses
    );
    
    logger.info('[Trackman Webhook] Linked Trackman booking to cancelled request (main flow)', {
      extra: { 
        bookingId: matchedBookingId, 
        email: emailForLookup,
        refundedPasses: cancelledLinkResult.refundedPasses
      }
    });
    
    return { success: true, matchedBookingId };
  }
  
  const member = await findMemberByEmail(emailForLookup);
  
  if (member) {
    if (!resourceId) {
      logger.warn('[Trackman Webhook] Cannot auto-create booking - bay not mapped. Saving to unmatched for staff resolution.', {
        extra: { 
          email: member.email, 
          bayName: normalized.bayName, 
          bayId: normalized.bayId,
          trackmanBookingId: normalized.trackmanBookingId
        }
      });
      await saveToUnmatchedBookings(
        normalized.trackmanBookingId,
        startParsed.date,
        startParsed.time,
        endParsed?.time || startParsed.time,
        null,
        normalized.customerEmail,
        normalized.customerName,
        normalized.playerCount,
        'bay_unmapped'
      );
      
      const unmatchedResult = await createUnmatchedBookingRequest(
        normalized.trackmanBookingId,
        normalized.externalBookingId,
        startParsed.date,
        startParsed.time,
        endParsed?.time || startParsed.time,
        null,
        normalized.customerEmail,
        normalized.customerName,
        normalized.playerCount
      );
      
      if (unmatchedResult.created && unmatchedResult.bookingId) {
        matchedBookingId = unmatchedResult.bookingId;
        
        // Broadcast availability update for real-time calendar refresh
        broadcastAvailabilityUpdate({
          resourceId: undefined,
          date: startParsed.date,
          action: 'created',
          bookingId: unmatchedResult.bookingId
        });
        
        // Notify staff about unmatched booking (bay not mapped)
        await notifyStaffBookingCreated(
          'unmatched',
          normalized.customerName || 'Unknown',
          normalized.customerEmail,
          startParsed.date,
          startParsed.time,
          undefined,  // No bay name since bay wasn't mapped
          unmatchedResult.bookingId
        );
      }
      
      return { success: true, matchedBookingId };
    }
    
    const createResult = await createBookingForMember(
      member,
      normalized.trackmanBookingId,
      startParsed.date,
      startParsed.time,
      endParsed?.time || startParsed.time,
      resourceId,
      normalized.playerCount,
      normalized.customerName
    );
    
    if (createResult.success && createResult.bookingId) {
      matchedBookingId = createResult.bookingId;
      
      const memberName = [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;
      
      await notifyMemberBookingConfirmed(
        member.email,
        createResult.bookingId,
        startParsed.date,
        startParsed.time,
        normalized.bayName
      );
      
      await notifyStaffBookingCreated(
        'auto_created',
        memberName,
        member.email,
        startParsed.date,
        startParsed.time,
        normalized.bayName,
        createResult.bookingId
      );
      
      // Broadcast availability update for real-time calendar refresh
      broadcastAvailabilityUpdate({
        resourceId,
        date: startParsed.date,
        action: 'created',
        bookingId: createResult.bookingId
      });
      
      logger.info('[Trackman Webhook] Auto-created booking for known member (no pending request)', {
        extra: { bookingId: matchedBookingId, email: member.email, resourceId, memberName }
      });
    }
    
    return { success: true, matchedBookingId };
  }
  
  logger.info('[Trackman Webhook] No member found for email, saving to unmatched', {
    extra: { email: normalized.customerEmail, resolvedEmail: emailForLookup }
  });
  
  await saveToUnmatchedBookings(
    normalized.trackmanBookingId,
    startParsed.date,
    startParsed.time,
    endParsed?.time || startParsed.time,
    resourceId,
    normalized.customerEmail,
    normalized.customerName,
    normalized.playerCount
  );
  
  const unmatchedResult = await createUnmatchedBookingRequest(
    normalized.trackmanBookingId,
    normalized.externalBookingId,
    startParsed.date,
    startParsed.time,
    endParsed?.time || startParsed.time,
    resourceId,
    normalized.customerEmail,
    normalized.customerName,
    normalized.playerCount
  );
  
  if (unmatchedResult.created && unmatchedResult.bookingId) {
    matchedBookingId = unmatchedResult.bookingId;
    
    // Broadcast availability update for real-time calendar refresh
    broadcastAvailabilityUpdate({
      resourceId,
      date: startParsed.date,
      action: 'created',
      bookingId: unmatchedResult.bookingId
    });
  }
  
  await notifyStaffBookingCreated(
    'unmatched',
    normalized.customerName || 'Unknown',
    normalized.customerEmail,
    startParsed.date,
    startParsed.time,
    normalized.bayName
  );
  
  return { success: true, matchedBookingId };
}
