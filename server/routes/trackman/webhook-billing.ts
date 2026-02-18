import { pool } from '../../core/db';
import { logger } from '../../core/logger';
import { sendNotificationToUser, broadcastToStaff } from '../../core/websocket';
import { notifyAllStaff, notifyMember } from '../../core/notificationService';
import { refundGuestPass } from '../guestPasses';
import { calculateFullSessionBilling, Participant } from '../../core/bookingService/usageCalculator';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { recordUsage, createSessionWithUsageTracking, ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { getMemberTierByEmail } from '../../core/tierService';
import { linkAndNotifyParticipants } from '../../core/bookingEvents';
import { calculateDurationMinutes, NormalizedBookingFields } from './webhook-helpers';
import { createPrepaymentIntent } from '../../core/billing/prepaymentService';

export async function updateBaySlotCache(
  trackmanBookingId: string,
  resourceId: number,
  slotDate: string,
  startTime: string,
  endTime: string,
  status: 'booked' | 'cancelled' | 'completed',
  customerEmail?: string,
  customerName?: string,
  playerCount?: number
): Promise<void> {
  try {
    if (status === 'cancelled') {
      await pool.query(
        `UPDATE trackman_bay_slots SET status = 'cancelled', updated_at = NOW()
         WHERE trackman_booking_id = $1`,
        [trackmanBookingId]
      );
      return;
    }
    
    await pool.query(
      `INSERT INTO trackman_bay_slots 
       (resource_id, slot_date, start_time, end_time, status, trackman_booking_id, customer_email, customer_name, player_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (resource_id, slot_date, start_time, trackman_booking_id) 
       DO UPDATE SET 
         end_time = EXCLUDED.end_time,
         status = EXCLUDED.status,
         customer_email = EXCLUDED.customer_email,
         customer_name = EXCLUDED.customer_name,
         player_count = EXCLUDED.player_count,
         updated_at = NOW()`,
      [resourceId, slotDate, startTime, endTime, status, trackmanBookingId, customerEmail, customerName, playerCount || 1]
    );
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to update bay slot cache', { error: e as Error });
  }
}

export async function createBookingForMember(
  member: { id: number; email: string; firstName?: string; lastName?: string },
  trackmanBookingId: string,
  slotDate: string,
  startTime: string,
  endTime: string,
  resourceId: number,
  playerCount: number,
  customerName?: string
): Promise<{ success: boolean; bookingId?: number; updated?: boolean }> {
  try {
    const existingBooking = await pool.query(
      `SELECT id, duration_minutes, session_id FROM booking_requests WHERE trackman_booking_id = $1`,
      [trackmanBookingId]
    );
    
    if (existingBooking.rows.length > 0) {
      const oldDuration = existingBooking.rows[0].duration_minutes;
      const newDuration = calculateDurationMinutes(startTime, endTime);
      
      if (oldDuration !== newDuration) {
        await pool.query(
          `UPDATE booking_requests 
           SET start_time = $1, end_time = $2, duration_minutes = $3, 
               trackman_player_count = $4, last_trackman_sync_at = NOW(), updated_at = NOW()
           WHERE id = $5`,
          [startTime, endTime, newDuration, playerCount, existingBooking.rows[0].id]
        );
        
        if (existingBooking.rows[0].session_id) {
          try {
            await pool.query(
              'UPDATE booking_sessions SET start_time = $1, end_time = $2 WHERE id = $3',
              [startTime, endTime, existingBooking.rows[0].session_id]
            );
            await recalculateSessionFees(existingBooking.rows[0].session_id, 'trackman_webhook');
            logger.info('[Trackman Webhook] Recalculated fees after duration change', {
              extra: { sessionId: existingBooking.rows[0].session_id }
            });
          } catch (recalcErr: unknown) {
            logger.warn('[Trackman Webhook] Failed to recalculate fees', { 
              extra: { sessionId: existingBooking.rows[0].session_id } 
            });
          }
        }
        
        return { success: true, bookingId: existingBooking.rows[0].id, updated: true };
      }
      
      logger.info('[Trackman Webhook] Booking already exists and duration unchanged, skipping', { 
        extra: { trackmanBookingId, existingBookingId: existingBooking.rows[0].id, duration: oldDuration } 
      });
      return { success: true, bookingId: existingBooking.rows[0].id };
    }
    
    // Match existing booking with same member, date, resource, and within 10-minute tolerance
    // Resource check prevents back-to-back bookings on different bays from mismatching
    // Uses COALESCE to handle edge case where resource_id might be null on old bookings
    const pendingSync = await pool.query(
      `SELECT id, staff_notes, start_time, end_time, status, resource_id FROM booking_requests 
       WHERE LOWER(user_email) = LOWER($1)
       AND request_date = $2
       AND (resource_id = $4 OR resource_id IS NULL)
       AND ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 600
       AND status IN ('approved', 'pending')
       AND trackman_booking_id IS NULL
       AND (staff_notes LIKE '%[PENDING_TRACKMAN_SYNC]%' OR status = 'pending')
       ORDER BY 
         CASE WHEN staff_notes LIKE '%[PENDING_TRACKMAN_SYNC]%' THEN 0 ELSE 1 END,
         CASE WHEN resource_id = $4 THEN 0 ELSE 1 END,
         ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))),
         created_at DESC
       LIMIT 1`,
      [member.email, slotDate, startTime, resourceId]
    );
    
    if (pendingSync.rows.length > 0) {
      const pendingBookingId = pendingSync.rows[0].id;
      const originalStartTime = pendingSync.rows[0].start_time;
      const originalEndTime = pendingSync.rows[0].end_time;
      const originalStatus = pendingSync.rows[0].status;
      const wasTimeTolerance = originalStartTime !== startTime;
      const wasPending = originalStatus === 'pending';
      
      if (wasTimeTolerance) {
        logger.info('[Trackman Webhook] Time tolerance match - updating booking times to match Trackman', {
          extra: {
            bookingId: pendingBookingId,
            originalStartTime,
            trackmanStartTime: startTime,
            originalEndTime,
            trackmanEndTime: endTime,
          }
        });
      }
      
      let updatedNotes = (pendingSync.rows[0].staff_notes || '')
        .replace('[PENDING_TRACKMAN_SYNC]', '[Linked via Trackman webhook]')
        .trim();
      
      if (wasTimeTolerance) {
        updatedNotes += ` [Time adjusted: ${originalStartTime} → ${startTime}]`;
      }
      
      if (wasPending) {
        updatedNotes += ' [Auto-approved via Trackman webhook]';
      }
      
      const startParts = startTime.split(':').map(Number);
      const endParts = endTime.split(':').map(Number);
      const startMinutesCalc = startParts[0] * 60 + startParts[1];
      const endMinutesCalc = endParts[0] * 60 + endParts[1];
      const newDurationMinutes = endMinutesCalc > startMinutesCalc ? endMinutesCalc - startMinutesCalc : 60;
      
      const pendingUpdateResult = await pool.query(
        `UPDATE booking_requests 
         SET trackman_booking_id = $1, 
             trackman_player_count = $2,
             staff_notes = $3,
             start_time = $4,
             end_time = $5,
             duration_minutes = $6,
             status = 'approved',
             was_auto_linked = true,
             reviewed_by = COALESCE(reviewed_by, 'trackman_webhook'),
             reviewed_at = COALESCE(reviewed_at, NOW()),
             last_sync_source = 'trackman_webhook',
             last_trackman_sync_at = NOW(),
             updated_at = NOW()
         WHERE id = $7 AND trackman_booking_id IS NULL
         RETURNING id`,
        [trackmanBookingId, playerCount, updatedNotes, startTime, endTime, newDurationMinutes, pendingBookingId]
      );
      
      if (pendingUpdateResult.rowCount === 0) {
        logger.warn('[Trackman Webhook] Pending booking was already linked by another process', {
          extra: { pendingBookingId, trackmanBookingId, email: member.email }
        });
        return { success: false };
      }
      
      const sessionCheck = await pool.query(
        'SELECT session_id FROM booking_requests WHERE id = $1',
        [pendingBookingId]
      );
      
      if (sessionCheck.rows[0]?.session_id) {
        if (wasTimeTolerance) {
          try {
            await pool.query(
              'UPDATE booking_sessions SET start_time = $1, end_time = $2 WHERE id = $3',
              [startTime, endTime, sessionCheck.rows[0].session_id]
            );
            await recalculateSessionFees(sessionCheck.rows[0].session_id, 'trackman_webhook');
          } catch (recalcErr: unknown) {
            logger.warn('[Trackman Webhook] Failed to recalculate fees', { extra: { bookingId: pendingBookingId, error: recalcErr } });
          }
        }
      } else {
        var newSessionId: number | null = null;
        try {
          const sessionResult = await ensureSessionForBooking({
            bookingId: pendingBookingId,
            resourceId,
            sessionDate: slotDate,
            startTime,
            endTime,
            ownerEmail: member.email,
            ownerName: customerName || [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email,
            trackmanBookingId,
            source: 'trackman_webhook',
            createdBy: 'trackman_webhook'
          });
          
          newSessionId = sessionResult.sessionId || null;
          
          if (newSessionId && !sessionResult.error) {
            const slotDuration = startTime && endTime
              ? Math.round((new Date(`2000-01-01T${endTime}`).getTime() - 
                           new Date(`2000-01-01T${startTime}`).getTime()) / 60000)
              : 60;
            
            for (let i = 1; i < playerCount; i++) {
              await pool.query(`
                INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
                VALUES ($1, NULL, 'guest', $2, 'pending', $3)
              `, [newSessionId, `Guest ${i + 1}`, slotDuration]);
            }
            
            const feeBreakdown = await recalculateSessionFees(newSessionId, 'trackman_webhook');
            logger.info('[Trackman Webhook] Created session and participants for linked booking', {
              extra: { bookingId: pendingBookingId, sessionId: newSessionId, playerCount, slotDuration }
            });
            
            if (feeBreakdown.totals.totalCents > 0) {
              try {
                const userResult = await pool.query(
                  `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
                  [member.email]
                );
                const userId = userResult.rows[0]?.id || null;
                const memberName = customerName || [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;
                
                const prepayResult = await createPrepaymentIntent({
                  sessionId: newSessionId,
                  bookingId: pendingBookingId,
                  userId: userId || null,
                  userEmail: member.email,
                  userName: memberName,
                  totalFeeCents: feeBreakdown.totals.totalCents,
                  feeBreakdown: { overageCents: feeBreakdown.totals.overageCents, guestCents: feeBreakdown.totals.guestCents }
                });
                if (prepayResult?.paidInFull) {
                  await pool.query(
                    `UPDATE booking_participants SET payment_status = 'paid' WHERE session_id = $1 AND payment_status = 'pending'`,
                    [newSessionId]
                  );
                  logger.info('[Trackman Webhook] Prepayment fully covered by credit', { extra: { sessionId: newSessionId, bookingId: pendingBookingId } });
                }
              } catch (prepayError: unknown) {
                logger.warn('[Trackman Webhook] Failed to create prepayment intent', { extra: { sessionId: newSessionId, error: prepayError } });
              }
            }
          }
        } catch (sessionErr: unknown) {
          logger.error('[Trackman Webhook] Failed to ensure session for linked booking', { extra: { bookingId: pendingBookingId, trackmanBookingId, error: sessionErr } });
        }
      }
      
      const memberName = customerName || 
        [member.firstName, member.lastName].filter(Boolean).join(' ') || 
        member.email;
      
      logger.info('[Trackman Webhook] Auto-linked existing booking', {
        extra: { 
          bookingId: pendingBookingId, 
          trackmanBookingId, 
          email: member.email, 
          date: slotDate, 
          wasTimeTolerance,
          wasPending,
        }
      });
      
      const bayNameForNotification = `Bay ${resourceId}`;
      
      let feeInfo = '';
      if (sessionCheck.rows[0]?.session_id || newSessionId) {
        try {
          const sessionIdToCheck = newSessionId || sessionCheck.rows[0]?.session_id;
          const participantFees = await pool.query(
            `SELECT COALESCE(SUM(cached_fee_cents), 0) as total_fees FROM booking_participants WHERE session_id = $1`,
            [sessionIdToCheck]
          );
          const totalFees = participantFees.rows[0]?.total_fees || 0;
          if (totalFees > 0) {
            feeInfo = ` Estimated fees: $${(totalFees / 100).toFixed(2)}.`;
          }
        } catch (e: unknown) {
          logger.error('[Trackman Webhook] Failed to fetch fee info for notification', { extra: { error: e } });
        }
      }
      
      broadcastToStaff({
        type: 'booking_auto_confirmed',
        title: 'Booking Auto-Confirmed',
        message: `${memberName}'s booking for ${slotDate} at ${startTime} (${bayNameForNotification}) was auto-linked via Trackman.`,
        data: {
          bookingId: pendingBookingId,
          memberName,
          memberEmail: member.email,
          date: slotDate,
          time: startTime,
          bay: bayNameForNotification,
          wasAutoApproved: wasPending
        }
      });
      
      const confirmMessage = `Your simulator booking for ${slotDate} at ${startTime} (${bayNameForNotification}) has been confirmed.${feeInfo}`;
      
      await pool.query(
        `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          member.email.toLowerCase(),
          'Booking Confirmed',
          confirmMessage,
          'booking',
          'booking'
        ]
      );
      
      sendNotificationToUser(member.email, {
        type: 'booking_confirmed',
        title: 'Booking Confirmed',
        message: confirmMessage,
        data: { bookingId: pendingBookingId },
      });
      
      linkAndNotifyParticipants(pendingBookingId, {
        trackmanBookingId,
        linkedBy: 'trackman_webhook',
        bayName: bayNameForNotification
      }).catch(err => {
        logger.warn('[Trackman Webhook] Failed to link request participants', { extra: { bookingId: pendingBookingId, error: err } });
      });
      
      return { success: true, bookingId: pendingBookingId };
    }
    
    const durationMinutes = calculateDurationMinutes(startTime, endTime);
    
    const memberName = customerName || 
      [member.firstName, member.lastName].filter(Boolean).join(' ') || 
      member.email;
    
    // Use INSERT ... ON CONFLICT to atomically prevent duplicate trackman_booking_id
    // This prevents race conditions when multiple webhooks arrive simultaneously
    const result = await pool.query(
      `INSERT INTO booking_requests 
       (user_id, user_email, user_name, resource_id, request_date, start_time, end_time, 
        duration_minutes, status, trackman_booking_id, trackman_player_count, 
        reviewed_by, reviewed_at, staff_notes, was_auto_linked, 
        origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved', $9, $10, 'trackman_webhook', NOW(), 
               '[Auto-created via Trackman webhook - staff booking]', true,
               'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
       ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
         last_trackman_sync_at = NOW(),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS was_inserted`,
      [
        member.id,
        member.email,
        memberName,
        resourceId,
        slotDate,
        startTime,
        endTime,
        durationMinutes,
        trackmanBookingId,
        playerCount
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
        return { success: true, bookingId };
      }
      
      let sessionId: number | null = null;
      
      try {
        const sessionResult = await ensureSessionForBooking({
          bookingId,
          resourceId,
          sessionDate: slotDate,
          startTime,
          endTime,
          ownerEmail: member.email,
          ownerName: memberName,
          trackmanBookingId,
          source: 'trackman_webhook',
          createdBy: 'trackman_webhook'
        });
        
        sessionId = sessionResult.sessionId || null;
        
        if (sessionId && !sessionResult.error) {
          try {
            const ownerTier = await getMemberTierByEmail(member.email, { allowInactive: true });
            
            const participants: Participant[] = [
              { email: member.email, participantType: 'owner', displayName: memberName }
            ];
            
            for (let i = 1; i < playerCount; i++) {
              participants.push({
                email: undefined,
                participantType: 'guest',
                displayName: `Guest ${i + 1}`
              });
            }
            
            const billingResult = await calculateFullSessionBilling(
              slotDate,
              durationMinutes,
              participants,
              member.email,
              playerCount
            );
            
            for (const billing of billingResult.billingBreakdown) {
              if (billing.participantType === 'guest') {
                if (billing.guestFee > 0) {
                  await recordUsage(sessionId, {
                    memberId: member.email,
                    minutesCharged: 0,
                    overageFee: 0,
                    guestFee: billing.guestFee,
                    tierAtBooking: ownerTier || undefined,
                    paymentMethod: 'unpaid'
                  }, 'trackman_webhook');
                }
              } else {
                await recordUsage(sessionId, {
                  memberId: billing.email || member.email,
                  minutesCharged: billing.minutesAllocated,
                  overageFee: billing.overageFee,
                  guestFee: 0,
                  tierAtBooking: billing.tierName || ownerTier || undefined,
                  paymentMethod: 'unpaid'
                }, 'trackman_webhook');
              }
            }
            
            logger.info('[Trackman Webhook] Billing calculated for Trackman booking', {
              extra: {
                bookingId,
                sessionId,
                totalOverageFees: billingResult.totalOverageFees,
                totalGuestFees: billingResult.totalGuestFees,
                playerCount
              }
            });
            
            try {
              const slotDuration = startTime && endTime
                ? Math.round((new Date(`2000-01-01T${endTime}`).getTime() - 
                             new Date(`2000-01-01T${startTime}`).getTime()) / 60000)
                : 60;
              
              for (let i = 1; i < playerCount; i++) {
                await pool.query(`
                  INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
                  VALUES ($1, NULL, 'guest', $2, 'pending', $3)
                `, [sessionId, `Guest ${i + 1}`, slotDuration]);
              }
              
              await recalculateSessionFees(sessionId, 'trackman_webhook');
              logger.info('[Trackman Webhook] Created guest participants and cached fees', {
                extra: { sessionId, playerCount, slotDuration }
              });
            } catch (participantErr: unknown) {
              logger.warn('[Trackman Webhook] Failed to create guest participants (non-blocking)', { 
                extra: { sessionId, error: participantErr } 
              });
            }
          } catch (billingErr: unknown) {
            logger.warn('[Trackman Webhook] Failed to calculate billing (session created)', { 
              extra: { bookingId, sessionId, error: billingErr } 
            });
          }
        }
      } catch (sessionErr: unknown) {
        logger.error('[Trackman Webhook] Failed to ensure session for booking', { extra: { bookingId, trackmanBookingId, error: sessionErr } });
      }
      
      const bayNameForNotification = `Bay ${resourceId}`;
      const logMethod = resourceId ? logger.info.bind(logger) : logger.warn.bind(logger);
      logMethod(`[Trackman Webhook] Auto-created booking for member${resourceId ? '' : ' (no resource_id - bay unmapped)'}`, {
        extra: { 
          bookingId, 
          email: member.email, 
          date: slotDate, 
          time: startTime,
          resourceId: resourceId || null,
          trackmanBookingId 
        }
      });
      
      broadcastToStaff({
        type: 'booking_auto_confirmed',
        title: 'Booking Auto-Confirmed',
        message: `${memberName}'s booking for ${slotDate} at ${startTime} (${bayNameForNotification}) was auto-created via Trackman.`,
        data: {
          bookingId,
          memberName,
          memberEmail: member.email,
          date: slotDate,
          time: startTime,
          bay: bayNameForNotification
        }
      });
      
      await pool.query(
        `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          member.email.toLowerCase(),
          'Booking Confirmed',
          `Your simulator booking for ${slotDate} at ${startTime} (${bayNameForNotification}) has been confirmed.`,
          'booking',
          'booking'
        ]
      );
      
      sendNotificationToUser(member.email, {
        type: 'booking_confirmed',
        title: 'Booking Confirmed',
        message: `Your simulator booking for ${slotDate} at ${startTime} (${bayNameForNotification}) has been confirmed.`,
        data: { bookingId },
      });
      
      return { success: true, bookingId };
    }
    
    return { success: false };
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to create booking for member', { error: e as Error });
    return { success: false };
  }
}

export async function linkByExternalBookingId(
  externalBookingId: string,
  trackmanBookingId: string,
  slotDate: string,
  startTime: string,
  endTime: string,
  resourceId: number | null,
  status: string,
  playerCount: number
): Promise<{ matched: boolean; bookingId?: number; memberEmail?: string; memberName?: string }> {
  try {
    // First check: trackman_external_id (staff-pasted ID), calendar_event_id, or booking ID
    const result = await pool.query(
      `SELECT id, user_email, user_name, user_id, status as current_status, resource_id, session_id, duration_minutes
       FROM booking_requests 
       WHERE trackman_external_id = $1
         OR calendar_event_id = $1
         OR id::text = $1
         OR trackman_booking_id = $1
       LIMIT 1`,
      [externalBookingId]
    );
    
    if (result.rows.length === 0) {
      // Fallback: check staff_notes for the ID
      const pendingResult = await pool.query(
        `SELECT id, user_email, user_name, user_id, status as current_status, resource_id, session_id, duration_minutes
         FROM booking_requests 
         WHERE staff_notes LIKE $1
           AND trackman_booking_id IS NULL
         LIMIT 1`,
        [`%${externalBookingId}%`]
      );
      
      if (pendingResult.rows.length === 0) {
        logger.info('[Trackman Webhook] No booking found for externalBookingId', {
          extra: { externalBookingId }
        });
        return { matched: false };
      }
      
      result.rows = pendingResult.rows;
    }
    
    const booking = result.rows[0];
    const bookingId = booking.id;
    const memberEmail = booking.user_email;
    const memberName = booking.user_name;
    
    const normalizedStatus = status.toLowerCase();
    let newStatus = booking.current_status;
    if (normalizedStatus === 'attended') {
      newStatus = 'attended';
    } else if (normalizedStatus === 'confirmed' || normalizedStatus === 'booked') {
      newStatus = 'approved';
    } else if (normalizedStatus === 'cancelled' || normalizedStatus === 'canceled') {
      newStatus = 'cancelled';
    }
    
    const durationMinutes = calculateDurationMinutes(startTime, endTime);
    
    const originalDuration = booking.duration_minutes;
    const timeChanged = originalDuration !== durationMinutes;
    
    const externalUpdateResult = await pool.query(
      `UPDATE booking_requests 
       SET trackman_booking_id = $1,
           trackman_player_count = $2,
           status = $3,
           start_time = $4,
           end_time = $5,
           duration_minutes = $6,
           resource_id = COALESCE($7, resource_id),
           reviewed_by = COALESCE(reviewed_by, 'trackman_webhook'),
           reviewed_at = COALESCE(reviewed_at, NOW()),
           staff_notes = COALESCE(staff_notes, '') || ' [Linked via Trackman webhook - externalBookingId match]',
           last_sync_source = 'trackman_webhook',
           last_trackman_sync_at = NOW(),
           updated_at = NOW()
       WHERE id = $8 AND trackman_booking_id IS NULL
       RETURNING id`,
      [
        trackmanBookingId,
        playerCount,
        newStatus,
        startTime,
        endTime,
        durationMinutes,
        resourceId,
        bookingId
      ]
    );
    
    if (externalUpdateResult.rowCount === 0) {
      logger.warn('[Trackman Webhook] Booking was already linked by another process (externalBookingId)', {
        extra: { bookingId, trackmanBookingId, externalBookingId }
      });
      return { matched: false };
    }
    
    if (timeChanged && booking.session_id) {
      try {
        await pool.query(
          'UPDATE booking_sessions SET start_time = $1, end_time = $2 WHERE id = $3',
          [startTime, endTime, booking.session_id]
        );
        await recalculateSessionFees(booking.session_id, 'trackman_webhook');
        logger.info('[Trackman Webhook] Recalculated fees after externalBookingId link', {
          extra: { bookingId, sessionId: booking.session_id, originalDuration, newDuration: durationMinutes }
        });
      } catch (recalcErr: unknown) {
        logger.warn('[Trackman Webhook] Failed to recalculate fees for externalBookingId link', { 
          extra: { bookingId, error: recalcErr } 
        });
      }
    }
    
    if (!booking.session_id && resourceId) {
      try {
        const sessionResult = await createSessionWithUsageTracking(
          {
            ownerEmail: memberEmail,
            resourceId: resourceId,
            sessionDate: slotDate,
            startTime: startTime,
            endTime: endTime,
            durationMinutes: durationMinutes,
            participants: [{
              userId: booking.user_id || undefined,
              participantType: 'owner',
              displayName: memberName || memberEmail
            }],
            trackmanBookingId: trackmanBookingId
          },
          'trackman_webhook'
        );
        
        if (sessionResult.success && sessionResult.session) {
          const createdSessionId = sessionResult.session.id;
          
          await pool.query(
            `UPDATE booking_requests SET session_id = $1 WHERE id = $2`,
            [createdSessionId, bookingId]
          );
          
          try {
            const breakdown = await recalculateSessionFees(createdSessionId, 'approval');
            logger.info('[Trackman Webhook] Created session and calculated fees for externalBookingId link', {
              extra: { 
                sessionId: createdSessionId, 
                bookingId, 
                totalCents: breakdown.totals.totalCents 
              }
            });
          } catch (feeError: unknown) {
            logger.warn('[Trackman Webhook] Failed to calculate fees for new session', {
              extra: { sessionId: createdSessionId, error: feeError }
            });
          }
        }
      } catch (sessionError: unknown) {
        logger.warn('[Trackman Webhook] Failed to create session for externalBookingId link', {
          extra: { bookingId, error: sessionError }
        });
      }
    }
    
    logger.info('[Trackman Webhook] Linked booking via externalBookingId', {
      extra: { 
        bookingId, 
        trackmanBookingId, 
        externalBookingId, 
        memberEmail,
        oldStatus: booking.current_status,
        newStatus
      }
    });
    
    return { matched: true, bookingId, memberEmail, memberName };
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to link by externalBookingId', { error: e as Error });
    return { matched: false };
  }
}

export async function tryMatchByBayDateTime(
  resourceId: number,
  slotDate: string,
  startTime: string,
  trackmanBookingId: string,
  playerCount: number
): Promise<{ matched: boolean; bookingId?: number; memberEmail?: string; memberName?: string }> {
  try {
    // Find pending or approved bookings at the same bay/date/time (within 10 min tolerance)
    const result = await pool.query(
      `SELECT id, user_email, user_name, status, start_time, end_time, duration_minutes, session_id
       FROM booking_requests 
       WHERE resource_id = $1
         AND request_date = $2
         AND trackman_booking_id IS NULL
         AND status IN ('pending', 'approved')
         AND ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 600
       ORDER BY 
         CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
         ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) ASC
       LIMIT 1`,
      [resourceId, slotDate, startTime]
    );
    
    if (result.rows.length === 0) {
      logger.info('[Trackman Webhook] No bay/date/time match found', {
        extra: { resourceId, slotDate, startTime }
      });
      return { matched: false };
    }
    
    const booking = result.rows[0];
    const bookingId = booking.id;
    const memberEmail = booking.user_email;
    const memberName = booking.user_name;
    const wasPending = booking.status === 'pending';
    
    // Link the booking to Trackman with concurrency guard
    const updateResult = await pool.query(
      `UPDATE booking_requests 
       SET trackman_booking_id = $1,
           trackman_player_count = $2,
           status = 'approved',
           reviewed_by = COALESCE(reviewed_by, 'trackman_auto_match'),
           reviewed_at = COALESCE(reviewed_at, NOW()),
           staff_notes = COALESCE(staff_notes, '') || ' [Auto-linked via bay/date/time match]',
           last_sync_source = 'trackman_auto_match',
           last_trackman_sync_at = NOW(),
           was_auto_linked = true,
           updated_at = NOW()
       WHERE id = $3 AND trackman_booking_id IS NULL
       RETURNING id`,
      [trackmanBookingId, playerCount, bookingId]
    );
    
    if (updateResult.rowCount === 0) {
      logger.warn('[Trackman Webhook] Bay/date/time match found but booking was already linked by another process', {
        extra: { bookingId, trackmanBookingId }
      });
      return { matched: false };
    }
    
    // Update webhook event record
    await pool.query(
      `UPDATE trackman_webhook_events 
       SET matched_booking_id = $1, matched_user_id = $2
       WHERE trackman_booking_id = $3`,
      [bookingId, memberEmail, trackmanBookingId]
    );
    
    logger.info('[Trackman Webhook] Auto-linked via bay/date/time match', {
      extra: { 
        bookingId, 
        trackmanBookingId, 
        resourceId, 
        slotDate, 
        startTime,
        wasPending,
        memberEmail
      }
    });
    
    // Ensure session exists for newly approved booking
    try {
      await ensureSessionForBooking({
        bookingId,
        resourceId,
        sessionDate: slotDate,
        startTime: booking.start_time,
        endTime: booking.end_time,
        ownerEmail: memberEmail,
        ownerName: memberName || undefined,
        trackmanBookingId,
        source: 'trackman_webhook',
        createdBy: 'trackman_auto_match'
      });
    } catch (sessionErr: unknown) {
      logger.warn('[Trackman Webhook] Failed to ensure session for bay/date/time match', { extra: { bookingId, error: sessionErr } });
    }

    return { matched: true, bookingId, memberEmail, memberName };
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to match by bay/date/time', { error: e as Error });
    return { matched: false };
  }
}

export async function refundGuestPassesForCancelledBooking(bookingId: number, memberEmail: string): Promise<number> {
  try {
    const sessionResult = await pool.query(
      `SELECT session_id FROM booking_requests WHERE id = $1`,
      [bookingId]
    );
    
    if (!sessionResult.rows[0]?.session_id) {
      return 0;
    }
    
    const sessionId = sessionResult.rows[0].session_id;
    
    const guestParticipants = await pool.query(
      `SELECT id, display_name FROM booking_participants 
       WHERE session_id = $1 AND participant_type = 'guest'`,
      [sessionId]
    );
    
    let refundedCount = 0;
    for (const guest of guestParticipants.rows) {
      const result = await refundGuestPass(memberEmail, guest.display_name || undefined, false);
      if (result.success) {
        refundedCount++;
      }
    }
    
    if (refundedCount > 0) {
      logger.info('[Trackman Webhook] Refunded guest passes for cancelled booking', {
        extra: { bookingId, memberEmail, refundedCount }
      });
    }
    
    return refundedCount;
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to refund guest passes for cancelled booking', { error: e as Error });
    return 0;
  }
}
