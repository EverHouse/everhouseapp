import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logger } from '../../core/logger';
import { sendNotificationToUser, broadcastToStaff, broadcastAvailabilityUpdate } from '../../core/websocket';
import { notifyAllStaff, notifyMember } from '../../core/notificationService';
import { refundGuestPass } from '../guestPasses';
import { calculateFullSessionBilling, Participant } from '../../core/bookingService/usageCalculator';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { recordUsage, createSessionWithUsageTracking, ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { getMemberTierByEmail } from '../../core/tierService';
import { linkAndNotifyParticipants } from '../../core/bookingEvents';
import { calculateDurationMinutes, NormalizedBookingFields } from './webhook-helpers';
import { createPrepaymentIntent } from '../../core/billing/prepaymentService';
import { syncBookingInvoice } from '../../core/billing/bookingInvoiceService';
import { transferRequestParticipantsToSession } from '../../core/trackmanImport';

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
      await db.execute(sql`UPDATE trackman_bay_slots SET status = 'cancelled', updated_at = NOW()
         WHERE trackman_booking_id = ${trackmanBookingId}`);
      return;
    }
    
    await db.execute(sql`INSERT INTO trackman_bay_slots 
       (resource_id, slot_date, start_time, end_time, status, trackman_booking_id, customer_email, customer_name, player_count)
       VALUES (${resourceId}, ${slotDate}, ${startTime}, ${endTime}, ${status}, ${trackmanBookingId}, ${customerEmail ?? null}, ${customerName ?? null}, ${playerCount || 1})
       ON CONFLICT (resource_id, slot_date, start_time, trackman_booking_id) 
       DO UPDATE SET 
         end_time = EXCLUDED.end_time,
         status = EXCLUDED.status,
         customer_email = EXCLUDED.customer_email,
         customer_name = EXCLUDED.customer_name,
         player_count = EXCLUDED.player_count,
         updated_at = NOW()`);
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
    const existingBooking = await db.execute(sql`SELECT id, duration_minutes, session_id, resource_id FROM booking_requests WHERE trackman_booking_id = ${trackmanBookingId}`);
    
    if ((existingBooking.rows as Array<Record<string, unknown>>).length > 0) {
      const oldDuration = (existingBooking.rows as Array<Record<string, unknown>>)[0].duration_minutes;
      const newDuration = calculateDurationMinutes(startTime, endTime);
      
      const oldResourceId = (existingBooking.rows as Array<Record<string, unknown>>)[0].resource_id;
      const bayChanged = resourceId && oldResourceId && resourceId !== oldResourceId;

      const cancelOverlappingBookings = async (targetResourceId: number, targetDate: string, targetStart: string, targetEnd: string, excludeBookingId: number) => {
        const conflicting = await db.execute(sql`
          SELECT id, trackman_booking_id, user_email
          FROM booking_requests
          WHERE resource_id = ${targetResourceId}
            AND request_date = ${targetDate}
            AND status IN ('pending', 'approved', 'confirmed')
            AND start_time < ${targetEnd}
            AND end_time > ${targetStart}
            AND id != ${excludeBookingId}
            AND (trackman_booking_id IS NULL OR trackman_booking_id != ${trackmanBookingId})`);
        const rows = conflicting.rows as { id: number; trackman_booking_id: string | null; user_email: string }[];
        if (rows.length > 0) {
          const ids = rows.map(r => r.id);
          await db.execute(sql`
            UPDATE booking_requests 
            SET status = 'cancelled', updated_at = NOW(),
                staff_notes = COALESCE(staff_notes, '') || ${`\n[Auto-cancelled: superseded by Trackman booking ${trackmanBookingId}]`}
            WHERE id = ANY(${ids})`);
          logger.info('[Trackman Webhook] createBookingForMember cancelled overlapping bookings before update', {
            extra: { trackmanBookingId, cancelledBookingIds: ids }
          });
        }
      };

      if (oldDuration !== newDuration) {
        const bookingId = (existingBooking.rows as Array<Record<string, unknown>>)[0].id as number;
        const sessionId = (existingBooking.rows as Array<Record<string, unknown>>)[0].session_id as number | null;
        
        await cancelOverlappingBookings(bayChanged ? resourceId : (oldResourceId as number), slotDate, startTime, endTime, bookingId);
        
        if (bayChanged) {
          await db.execute(sql`UPDATE booking_requests 
             SET start_time = ${startTime}, end_time = ${endTime}, duration_minutes = ${newDuration}, 
                 trackman_player_count = ${playerCount}, resource_id = ${resourceId}, last_trackman_sync_at = NOW(), updated_at = NOW()
             WHERE id = ${bookingId}`);
          if (sessionId) {
            await db.execute(sql`UPDATE booking_sessions SET start_time = ${startTime}, end_time = ${endTime}, resource_id = ${resourceId} WHERE id = ${sessionId}`);
          }
          try {
            broadcastAvailabilityUpdate({ resourceId: oldResourceId as number, resourceType: 'simulator', date: slotDate, action: 'cancelled' });
            broadcastAvailabilityUpdate({ resourceId: resourceId, resourceType: 'simulator', date: slotDate, action: 'booked' });
          } catch (broadcastErr: unknown) {
            logger.warn('[Trackman Webhook] Failed to broadcast bay change availability update', {
              extra: { bookingId, error: (broadcastErr as Error).message }
            });
          }
        } else {
          await db.execute(sql`UPDATE booking_requests 
             SET start_time = ${startTime}, end_time = ${endTime}, duration_minutes = ${newDuration}, 
                 trackman_player_count = ${playerCount}, last_trackman_sync_at = NOW(), updated_at = NOW()
             WHERE id = ${bookingId}`);
          if (sessionId) {
            await db.execute(sql`UPDATE booking_sessions SET start_time = ${startTime}, end_time = ${endTime} WHERE id = ${sessionId}`);
          }
        }
        
        if (sessionId) {
          try {
            await recalculateSessionFees(sessionId, 'trackman_webhook');
            logger.info('[Trackman Webhook] Recalculated fees after duration change', {
              extra: { sessionId, bayChanged }
            });
            syncBookingInvoice(bookingId, sessionId).catch((syncErr: unknown) => {
              logger.warn('[Trackman Webhook] Non-blocking: Failed to sync invoice after duration change', {
                extra: { bookingId, sessionId, error: (syncErr as Error).message }
              });
            });
          } catch (recalcErr: unknown) {
            logger.warn('[Trackman Webhook] Failed to recalculate fees', { 
              extra: { sessionId } 
            });
          }
        }
        
        return { success: true, bookingId, updated: true };
      }
      
      if (bayChanged) {
        const bookingId = (existingBooking.rows as Array<Record<string, unknown>>)[0].id as number;
        const sessionId = (existingBooking.rows as Array<Record<string, unknown>>)[0].session_id as number | null;
        
        await cancelOverlappingBookings(resourceId, slotDate, startTime, endTime, bookingId);
        
        await db.execute(sql`UPDATE booking_requests SET resource_id = ${resourceId}, updated_at = NOW() WHERE id = ${bookingId}`);
        
        if (sessionId) {
          await db.execute(sql`UPDATE booking_sessions SET resource_id = ${resourceId} WHERE id = ${sessionId}`);
        }
        
        logger.info('[Trackman Webhook] Bay change detected - updated resource_id', {
          extra: { 
            bookingId, 
            trackmanBookingId, 
            oldResourceId, 
            newResourceId: resourceId,
            sessionId 
          }
        });
        
        try {
          broadcastAvailabilityUpdate({
            resourceId: oldResourceId as number,
            resourceType: 'simulator',
            date: slotDate,
            action: 'cancelled'
          });
          broadcastAvailabilityUpdate({
            resourceId: resourceId,
            resourceType: 'simulator',
            date: slotDate,
            action: 'booked'
          });
        } catch (broadcastErr: unknown) {
          logger.warn('[Trackman Webhook] Failed to broadcast bay change availability update', {
            extra: { bookingId, error: (broadcastErr as Error).message }
          });
        }
        
        return { success: true, bookingId, updated: true };
      }
      
      logger.info('[Trackman Webhook] Booking already exists and duration unchanged, skipping', { 
        extra: { trackmanBookingId, existingBookingId: (existingBooking.rows as Array<Record<string, unknown>>)[0].id, duration: oldDuration } 
      });
      return { success: true, bookingId: (existingBooking.rows as Array<Record<string, unknown>>)[0].id as number };
    }
    
    const pendingSync = await db.execute(sql`SELECT id, staff_notes, start_time, end_time, status, resource_id FROM booking_requests 
       WHERE LOWER(user_email) = LOWER(${member.email})
       AND request_date = ${slotDate}
       AND (resource_id = ${resourceId} OR resource_id IS NULL)
       AND ABS(EXTRACT(EPOCH FROM (start_time::time - ${startTime}::time))) <= 600
       AND status IN ('approved', 'pending')
       AND trackman_booking_id IS NULL
       AND (staff_notes LIKE '%[PENDING_TRACKMAN_SYNC]%' OR status = 'pending')
       ORDER BY 
         CASE WHEN staff_notes LIKE '%[PENDING_TRACKMAN_SYNC]%' THEN 0 ELSE 1 END,
         CASE WHEN resource_id = ${resourceId} THEN 0 ELSE 1 END,
         ABS(EXTRACT(EPOCH FROM (start_time::time - ${startTime}::time))),
         created_at DESC
       LIMIT 1`);
    
    if ((pendingSync.rows as Array<Record<string, unknown>>).length > 0) {
      const pendingBookingId = (pendingSync.rows as Array<Record<string, unknown>>)[0].id as number;
      const originalStartTime = (pendingSync.rows as Array<Record<string, unknown>>)[0].start_time;
      const originalEndTime = (pendingSync.rows as Array<Record<string, unknown>>)[0].end_time;
      const originalStatus = (pendingSync.rows as Array<Record<string, unknown>>)[0].status;
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
      
      let updatedNotes = (((pendingSync.rows as Array<Record<string, unknown>>)[0].staff_notes as string) || '')
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
      
      const pendingUpdateResult = await db.execute(sql`UPDATE booking_requests 
         SET trackman_booking_id = ${trackmanBookingId}, 
             trackman_player_count = ${playerCount},
             staff_notes = ${updatedNotes},
             start_time = ${startTime},
             end_time = ${endTime},
             duration_minutes = ${newDurationMinutes},
             status = 'approved',
             was_auto_linked = true,
             reviewed_by = COALESCE(reviewed_by, 'trackman_webhook'),
             reviewed_at = COALESCE(reviewed_at, NOW()),
             last_sync_source = 'trackman_webhook',
             last_trackman_sync_at = NOW(),
             updated_at = NOW()
         WHERE id = ${pendingBookingId} AND trackman_booking_id IS NULL
         RETURNING id`);
      
      if ((pendingUpdateResult as unknown as { rowCount: number }).rowCount === 0) {
        logger.warn('[Trackman Webhook] Pending booking was already linked by another process', {
          extra: { pendingBookingId, trackmanBookingId, email: member.email }
        });
        return { success: false };
      }
      
      const sessionCheck = await db.execute(sql`SELECT session_id FROM booking_requests WHERE id = ${pendingBookingId}`);
      let newSessionId: number | null = null;
      
      if ((sessionCheck.rows as Array<Record<string, unknown>>)[0]?.session_id) {
        if (wasTimeTolerance) {
          try {
            await db.execute(sql`UPDATE booking_sessions SET start_time = ${startTime}, end_time = ${endTime} WHERE id = ${(sessionCheck.rows as Array<Record<string, unknown>>)[0].session_id}`);
            await recalculateSessionFees((sessionCheck.rows as Array<Record<string, unknown>>)[0].session_id as number, 'trackman_webhook');
          } catch (recalcErr: unknown) {
            logger.warn('[Trackman Webhook] Failed to recalculate fees', { extra: { bookingId: pendingBookingId, error: recalcErr } });
          }
        }
      } else {
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
            await db.execute(sql`UPDATE booking_participants SET payment_status = 'waived' WHERE session_id = ${newSessionId} AND (payment_status = 'pending' OR payment_status IS NULL)`);
            const slotDuration = startTime && endTime
              ? Math.round((new Date(`2000-01-01T${endTime}`).getTime() - 
                           new Date(`2000-01-01T${startTime}`).getTime()) / 60000)
              : 60;
            
            let transferredCount = 0;
            try {
              const rpResult = await db.execute(sql`SELECT request_participants FROM booking_requests WHERE id = ${pendingBookingId}`);
              const rpData = (rpResult.rows[0] as { request_participants: unknown })?.request_participants;
              if (rpData && Array.isArray(rpData) && rpData.length > 0) {
                transferredCount = await transferRequestParticipantsToSession(
                  newSessionId, rpData, member.email, `webhook auto-link booking #${pendingBookingId}`
                );
              }
            } catch (rpErr: unknown) {
              logger.warn('[Trackman Webhook] Non-blocking: Failed to transfer request_participants to session during auto-link', {
                extra: { bookingId: pendingBookingId, sessionId: newSessionId, error: (rpErr as Error).message }
              });
            }
            
            const remainingSlots = Math.max(0, (playerCount - 1) - transferredCount);
            for (let i = 0; i < remainingSlots; i++) {
              await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
                VALUES (${newSessionId}, NULL, 'guest', ${`Guest ${transferredCount + i + 2}`}, 'pending', ${slotDuration})`);
            }
            
            const feeBreakdown = await recalculateSessionFees(newSessionId, 'trackman_webhook');
            logger.info('[Trackman Webhook] Created session and participants for linked booking', {
              extra: { bookingId: pendingBookingId, sessionId: newSessionId, playerCount, slotDuration, transferredFromRequest: transferredCount, genericGuestSlots: remainingSlots }
            });
            
            if (feeBreakdown.totals.totalCents > 0) {
              try {
                const userResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${member.email})`);
                const userId = (userResult.rows as Array<Record<string, unknown>>)[0]?.id || null;
                const memberName = customerName || [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;
                
                const prepayResult = await createPrepaymentIntent({
                  sessionId: newSessionId,
                  bookingId: pendingBookingId,
                  userId: userId as string | null,
                  userEmail: member.email,
                  userName: memberName,
                  totalFeeCents: feeBreakdown.totals.totalCents,
                  feeBreakdown: { overageCents: feeBreakdown.totals.overageCents, guestCents: feeBreakdown.totals.guestCents }
                });
                if (prepayResult?.paidInFull) {
                  await db.execute(sql`UPDATE booking_participants SET payment_status = 'paid' WHERE session_id = ${newSessionId} AND payment_status = 'pending'`);
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
      if ((sessionCheck.rows as Array<Record<string, unknown>>)[0]?.session_id || newSessionId) {
        try {
          const sessionIdToCheck = newSessionId || (sessionCheck.rows as Array<Record<string, unknown>>)[0]?.session_id;
          const participantFees = await db.execute(sql`SELECT COALESCE(SUM(cached_fee_cents), 0) as total_fees FROM booking_participants WHERE session_id = ${sessionIdToCheck}`);
          const totalFees = (participantFees.rows as Array<Record<string, unknown>>)[0]?.total_fees || 0;
          if (Number(totalFees) > 0) {
            feeInfo = ` Estimated fees: $${(Number(totalFees) / 100).toFixed(2)}.`;
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
          wasAutoApproved: wasPending,
          trackmanBookingId
        }
      });
      
      const confirmMessage = `Your simulator booking for ${slotDate} at ${startTime} (${bayNameForNotification}) has been confirmed.${feeInfo}`;
      
      await db.execute(sql`INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
         VALUES (${member.email.toLowerCase()}, ${'Booking Confirmed'}, ${confirmMessage}, ${'booking'}, ${'booking'}, NOW())`);
      
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
    
    let result;
    try {
      result = await db.execute(sql`INSERT INTO booking_requests 
         (user_id, user_email, user_name, resource_id, request_date, start_time, end_time, 
          duration_minutes, status, trackman_booking_id, trackman_player_count, 
          reviewed_by, reviewed_at, staff_notes, was_auto_linked, 
          origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
         VALUES (${member.id}, ${member.email}, ${memberName}, ${resourceId}, ${slotDate}, ${startTime}, ${endTime}, ${durationMinutes}, 'approved', ${trackmanBookingId}, ${playerCount}, 'trackman_webhook', NOW(), 
                 '[Auto-created via Trackman webhook - staff booking]', true,
                 'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
         ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
           last_trackman_sync_at = NOW(),
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS was_inserted`);
    } catch (insertError: unknown) {
      const errMsg = insertError instanceof Error ? insertError.message : String(insertError);
      const cause = (insertError as { cause?: { code?: string } })?.cause;
      if (cause?.code === '23P01' || errMsg.includes('booking_requests_no_overlap') || errMsg.includes('23P01')) {
        logger.info('[Trackman Webhook] createBookingForMember overlap constraint — cancelling conflicting bookings (Trackman is authoritative)', {
          extra: { trackmanBookingId, date: slotDate, time: startTime, endTime, resourceId, memberEmail: member.email }
        });

        const conflicting = await db.execute(sql`
          SELECT id, trackman_booking_id, user_email
          FROM booking_requests
          WHERE resource_id = ${resourceId}
            AND request_date = ${slotDate}
            AND status IN ('pending', 'approved', 'confirmed')
            AND start_time < ${endTime}
            AND end_time > ${startTime}
            AND (trackman_booking_id IS NULL OR trackman_booking_id != ${trackmanBookingId})`);

        const conflictingRows = conflicting.rows as { id: number; trackman_booking_id: string | null; user_email: string }[];
        if (conflictingRows.length > 0) {
          const conflictIds = conflictingRows.map(r => r.id);
          await db.execute(sql`
            UPDATE booking_requests 
            SET status = 'cancelled', updated_at = NOW(),
                staff_notes = COALESCE(staff_notes, '') || ${`\n[Auto-cancelled: superseded by Trackman booking ${trackmanBookingId}]`}
            WHERE id = ANY(${conflictIds})`);
          logger.info('[Trackman Webhook] Cancelled conflicting bookings for member booking', {
            extra: { trackmanBookingId, cancelledBookingIds: conflictIds }
          });
        }

        result = await db.execute(sql`INSERT INTO booking_requests 
           (user_id, user_email, user_name, resource_id, request_date, start_time, end_time, 
            duration_minutes, status, trackman_booking_id, trackman_player_count, 
            reviewed_by, reviewed_at, staff_notes, was_auto_linked, 
            origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
           VALUES (${member.id}, ${member.email}, ${memberName}, ${resourceId}, ${slotDate}, ${startTime}, ${endTime}, ${durationMinutes}, 'approved', ${trackmanBookingId}, ${playerCount}, 'trackman_webhook', NOW(), 
                   '[Auto-created via Trackman webhook - staff booking, previous conflicting booking cancelled]', true,
                   'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
           ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
             last_trackman_sync_at = NOW(),
             updated_at = NOW()
           RETURNING id, (xmax = 0) AS was_inserted`);
      } else {
        throw insertError;
      }
    }
    
    if ((result.rows as Array<Record<string, unknown>>).length > 0) {
      const bookingId = (result.rows as Array<Record<string, unknown>>)[0].id as number;
      const wasInserted = (result.rows as Array<Record<string, unknown>>)[0].was_inserted;
      
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
          await db.execute(sql`UPDATE booking_participants SET payment_status = 'waived' WHERE session_id = ${sessionId} AND (payment_status = 'pending' OR payment_status IS NULL)`);
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
                await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
                  VALUES (${sessionId}, NULL, 'guest', ${`Guest ${i + 1}`}, 'pending', ${slotDuration})`);
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
          bay: bayNameForNotification,
          trackmanBookingId
        }
      });
      
      await db.execute(sql`INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
         VALUES (${member.email.toLowerCase()}, ${'Booking Confirmed'}, ${`Your simulator booking for ${slotDate} at ${startTime} (${bayNameForNotification}) has been confirmed.`}, ${'booking'}, ${'booking'}, NOW())`);
      
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

export async function tryMatchByBayDateTime(
  resourceId: number,
  slotDate: string,
  startTime: string,
  trackmanBookingId: string,
  playerCount: number,
  endTime?: string
): Promise<{ matched: boolean; bookingId?: number; memberEmail?: string; memberName?: string }> {
  try {
    const result = await db.execute(sql`SELECT id, user_email, user_name, status, start_time, end_time, duration_minutes, session_id
       FROM booking_requests 
       WHERE resource_id = ${resourceId}
         AND request_date = ${slotDate}
         AND trackman_booking_id IS NULL
         AND status IN ('pending', 'approved')
         AND ABS(EXTRACT(EPOCH FROM (start_time::time - ${startTime}::time))) <= 300
       ORDER BY 
         CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
         ABS(EXTRACT(EPOCH FROM (start_time::time - ${startTime}::time))) ASC`);
    
    const rows = result.rows as Array<Record<string, unknown>>;
    
    if (rows.length === 0) {
      logger.info('[Trackman Webhook] No bay/date/time match found', {
        extra: { resourceId, slotDate, startTime, endTime }
      });
      return { matched: false };
    }
    
    let candidates = rows;
    if (endTime && candidates.length > 1) {
      const withEndTimeMatch = candidates.filter(r => {
        const bookingEnd = r.end_time as string | null;
        if (!bookingEnd) return false;
        try {
          const diff = Math.abs(
            new Date(`2000-01-01T${bookingEnd}`).getTime() - new Date(`2000-01-01T${endTime}`).getTime()
          );
          return diff <= 300000;
        } catch { return false; }
      });
      if (withEndTimeMatch.length > 0) {
        candidates = withEndTimeMatch;
      }
    }
    
    if (candidates.length > 1) {
      logger.warn('[Trackman Webhook] Multiple bay/date/time matches found — skipping auto-link to avoid wrong match', {
        extra: { 
          resourceId, slotDate, startTime, endTime,
          candidateCount: candidates.length,
          candidateIds: candidates.map(c => c.id),
          candidateEmails: candidates.map(c => c.user_email)
        }
      });
      return { matched: false };
    }
    
    const booking = candidates[0];
    const bookingId = booking.id as number;
    const memberEmail = booking.user_email as string;
    const memberName = booking.user_name as string;
    const wasPending = booking.status === 'pending';
    
    const updateResult = await db.execute(sql`UPDATE booking_requests 
       SET trackman_booking_id = ${trackmanBookingId},
           trackman_player_count = ${playerCount},
           status = 'approved',
           reviewed_by = COALESCE(reviewed_by, 'trackman_auto_match'),
           reviewed_at = COALESCE(reviewed_at, NOW()),
           staff_notes = COALESCE(staff_notes, '') || ' [Auto-linked via bay/date/time match]',
           last_sync_source = 'trackman_auto_match',
           last_trackman_sync_at = NOW(),
           was_auto_linked = true,
           updated_at = NOW()
       WHERE id = ${bookingId} AND trackman_booking_id IS NULL
       RETURNING id`);
    
    if ((updateResult as unknown as { rowCount: number }).rowCount === 0) {
      logger.warn('[Trackman Webhook] Bay/date/time match found but booking was already linked by another process', {
        extra: { bookingId, trackmanBookingId }
      });
      return { matched: false };
    }
    
    await db.execute(sql`UPDATE trackman_webhook_events 
       SET matched_booking_id = ${bookingId}, matched_user_id = ${memberEmail}
       WHERE trackman_booking_id = ${trackmanBookingId}`);
    
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
    
    try {
      const sessionResult = await ensureSessionForBooking({
        bookingId,
        resourceId,
        sessionDate: slotDate,
        startTime: booking.start_time as string,
        endTime: booking.end_time as string,
        ownerEmail: memberEmail,
        ownerName: memberName || undefined,
        trackmanBookingId,
        source: 'trackman_webhook',
        createdBy: 'trackman_auto_match'
      });

      if (sessionResult.sessionId && !sessionResult.error) {
        await db.execute(sql`UPDATE booking_participants SET payment_status = 'waived' WHERE session_id = ${sessionResult.sessionId} AND (payment_status = 'pending' OR payment_status IS NULL)`);
        let transferredCount = 0;
        try {
          const rpResult = await db.execute(sql`SELECT request_participants FROM booking_requests WHERE id = ${bookingId}`);
          const rpData = (rpResult.rows[0] as { request_participants: unknown })?.request_participants;
          if (rpData && Array.isArray(rpData) && rpData.length > 0) {
            transferredCount = await transferRequestParticipantsToSession(
              sessionResult.sessionId, rpData, memberEmail, `bay/date/time auto-match booking #${bookingId}`
            );
          }
        } catch (rpErr: unknown) {
          logger.warn('[Trackman Webhook] Non-blocking: Failed to transfer request_participants during bay/date/time match', {
            extra: { bookingId, sessionId: sessionResult.sessionId, error: (rpErr as Error).message }
          });
        }

        const slotDuration = booking.start_time && booking.end_time
          ? Math.round((new Date(`2000-01-01T${booking.end_time}`).getTime() - 
                       new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000)
          : 60;
        const remainingSlots = Math.max(0, (playerCount - 1) - transferredCount);
        for (let i = 0; i < remainingSlots; i++) {
          await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
            VALUES (${sessionResult.sessionId}, NULL, 'guest', ${`Guest ${transferredCount + i + 2}`}, 'pending', ${slotDuration})`);
        }

        if (transferredCount > 0 || remainingSlots > 0) {
          await recalculateSessionFees(sessionResult.sessionId, 'trackman_auto_match');
          logger.info('[Trackman Webhook] Created participants for bay/date/time matched booking', {
            extra: { bookingId, sessionId: sessionResult.sessionId, playerCount, transferredFromRequest: transferredCount, genericGuestSlots: remainingSlots }
          });
        }
      }
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
    const sessionResult = await db.execute(sql`SELECT session_id FROM booking_requests WHERE id = ${bookingId}`);
    
    if (!(sessionResult.rows as Array<Record<string, unknown>>)[0]?.session_id) {
      return 0;
    }
    
    const sessionId = (sessionResult.rows as Array<Record<string, unknown>>)[0].session_id;
    
    const guestParticipants = await db.execute(sql`SELECT id, display_name FROM booking_participants 
       WHERE session_id = ${sessionId} AND participant_type = 'guest'`);
    
    let refundedCount = 0;
    for (const guest of (guestParticipants.rows as Array<Record<string, unknown>>)) {
      const result = await refundGuestPass(memberEmail, (guest.display_name as string) || undefined, false);
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
