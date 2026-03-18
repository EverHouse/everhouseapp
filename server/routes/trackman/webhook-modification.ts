import { logger } from '../../core/logger';
import { transferRequestParticipantsToSession } from '../../core/trackmanImport';
import { broadcastToStaff, broadcastAvailabilityUpdate } from '../../core/websocket';
import { notifyAllStaff, notifyMember } from '../../core/notificationService';
import { linkAndNotifyParticipants } from '../../core/bookingEvents';
import { formatTime12Hour } from '../../utils/dateUtils';
import { bookingRequests } from '../../../shared/schema';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { BOOKING_STATUS, PAYMENT_STATUS, PARTICIPANT_TYPE, RESOURCE_TYPE } from '../../../shared/constants/statuses';
import {
  calculateDurationMinutes,
} from './webhook-helpers';
import {
  updateBaySlotCache,
} from './webhook-billing';
import { getErrorMessage } from '../../utils/errorUtils';
import { voidBookingPass } from '../../walletPass/bookingPassService';
import { cancelPendingPaymentIntentsForBooking, refundSucceededPaymentIntentsForBooking } from '../../core/billing/paymentIntentCleanup';
import { ensureSessionForBooking, createTxQueryClient } from '../../core/bookingService/sessionManager';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { syncBookingInvoice } from '../../core/billing/bookingInvoiceService';
import { checkUnifiedAvailability as checkAvailabilityForModification } from '../../core/bookingService/availabilityGuard';
import { refreshBookingPass } from '../../walletPass/bookingPassService';

export function runConflictCancellationSideEffects(bookingId: number, userEmail: string, reason: string): void {
  (async () => {
    try {
      await cancelPendingPaymentIntentsForBooking(bookingId);
    } catch (err: unknown) {
      logger.error('[Trackman Webhook] Failed to cancel pending PIs for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } });
    }

    try {
      await refundSucceededPaymentIntentsForBooking(bookingId);
    } catch (err: unknown) {
      logger.error('[Trackman Webhook] Failed to refund succeeded PIs for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } });
    }

    try {
      const { voidBookingInvoice } = await import('../../core/billing/bookingInvoiceService');
      await voidBookingInvoice(bookingId);
    } catch (err: unknown) {
      logger.error('[Trackman Webhook] Failed to void invoice for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } });
    }

    voidBookingPass(bookingId).catch(err => logger.error('[Trackman Webhook] Failed to void wallet pass for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } }));

    if (userEmail && !userEmail.endsWith('@trackman.local')) {
      notifyMember({
        userEmail,
        title: 'Booking Cancelled',
        message: `Your booking has been automatically cancelled: ${reason}. Please contact staff if you have questions.`,
        type: 'booking_cancelled',
        relatedId: bookingId,
        relatedType: 'booking_request',
        url: '/my-bookings'
      }).catch(err => logger.error('[Trackman Webhook] Failed to notify member about conflict cancellation', { extra: { bookingId, userEmail, error: getErrorMessage(err) } }));
    }
  })().catch(err => logger.error('[Trackman Webhook] Conflict cancellation side effects failed', { extra: { bookingId, error: getErrorMessage(err) } }));
}

export interface BookingModificationResult {
  modified: boolean;
  changes: string[];
  conflictWarning?: string;
}

export interface ExistingBookingData {
  id: number;
  userEmail: string;
  userName: string;
  resourceId: number | null;
  startTime: string | Date;
  endTime: string | Date;
  requestDate: string | Date;
  durationMinutes: number | null;
  sessionId: number | null;
  status: string;
  declaredPlayerCount: number | null;
}

export async function handleBookingModification(
  existing: ExistingBookingData,
  incoming: {
    resourceId: number | null;
    parsedDate: string;
    parsedStartTime: string;
    parsedEndTime: string | undefined;
    playerCount: number;
    trackmanBookingId: string;
  }
): Promise<BookingModificationResult> {
  const changes: string[] = [];
  const bookingId = existing.id;
  const sessionId = existing.sessionId;

  const terminalStatuses = ['cancelled', 'declined', 'cancellation_pending'];
  const needsReactivation = terminalStatuses.includes(existing.status);

  const existingStartTime = existing.startTime instanceof Date
    ? existing.startTime.toISOString().substring(11, 16)
    : typeof existing.startTime === 'string' ? existing.startTime.substring(0, 5) : '';
  const existingEndTime = existing.endTime instanceof Date
    ? existing.endTime.toISOString().substring(11, 16)
    : typeof existing.endTime === 'string' ? existing.endTime.substring(0, 5) : '';
  const existingDate = existing.requestDate instanceof Date
    ? existing.requestDate.toISOString().split('T')[0]
    : String(existing.requestDate);

  const bayChanged = incoming.resourceId != null && existing.resourceId != null
    ? incoming.resourceId !== existing.resourceId
    : incoming.resourceId != null && existing.resourceId == null;
  const timeChanged = incoming.parsedStartTime !== existingStartTime ||
    (incoming.parsedEndTime && incoming.parsedEndTime !== existingEndTime);
  const dateChanged = incoming.parsedDate !== existingDate;
  const playerCountIncreased = incoming.playerCount > 0 && existing.declaredPlayerCount != null
    && incoming.playerCount > existing.declaredPlayerCount;
  if (!bayChanged && !timeChanged && !dateChanged && !playerCountIncreased && !needsReactivation) {
    if (incoming.playerCount > 0 && existing.declaredPlayerCount != null && incoming.playerCount !== existing.declaredPlayerCount) {
      logger.info('[Trackman Webhook] Trackman player count differs but not higher than app declared count — skipping modification', {
        extra: { bookingId, trackmanBookingId: incoming.trackmanBookingId, trackmanCount: incoming.playerCount, appDeclaredCount: existing.declaredPlayerCount }
      });
    } else {
      logger.info('[Trackman Webhook] No modifications detected for linked booking', {
        extra: { bookingId, trackmanBookingId: incoming.trackmanBookingId }
      });
    }
    return { modified: false, changes: [] };
  }
  if (needsReactivation) {
    changes.push(`Reactivated from ${existing.status}`);
  }
  if (playerCountIncreased) {
    changes.push(`Player count changed: ${existing.declaredPlayerCount || 1} → ${incoming.playerCount}`);
  }

  const oldResourceId = existing.resourceId;
  const newResourceId = incoming.resourceId || existing.resourceId;
  const newStartTime = incoming.parsedStartTime;
  const newEndTime = incoming.parsedEndTime || existingEndTime;
  const newDate = incoming.parsedDate;
  const newDuration = calculateDurationMinutes(newStartTime, newEndTime);

  let conflictWarning: string | undefined;
  if ((bayChanged || timeChanged || dateChanged) && newResourceId) {
    try {
      const availability = await checkAvailabilityForModification(
        newResourceId, newDate, newStartTime, newEndTime, sessionId ?? undefined
      );
      if (!availability.available) {
        conflictWarning = `Conflict at new slot: ${availability.conflictTitle || availability.conflictType || 'schedule conflict'}`;
        logger.warn('[Trackman Webhook] Modification has conflict at new slot — applying anyway (Trackman is source of truth)', {
          extra: {
            bookingId,
            trackmanBookingId: incoming.trackmanBookingId,
            conflictType: availability.conflictType,
            conflictTitle: availability.conflictTitle,
            newResourceId,
            newDate,
            newStartTime,
            newEndTime
          }
        });
      }
    } catch (conflictCheckErr: unknown) {
      logger.warn('[Trackman Webhook] Failed to check conflicts for modification — proceeding anyway', {
        extra: { bookingId, error: getErrorMessage(conflictCheckErr) }
      });
    }
  }

  if (bayChanged) {
    changes.push(`Bay changed: ${oldResourceId} → ${newResourceId}`);
  }
  if (timeChanged) {
    changes.push(`Time changed: ${formatTime12Hour(existingStartTime)}-${formatTime12Hour(existingEndTime)} → ${formatTime12Hour(newStartTime)}-${formatTime12Hour(newEndTime)}`);
  }
  if (dateChanged) {
    changes.push(`Date changed: ${existingDate} → ${newDate}`);
  }

  try {
    const staffNoteAddition = ` [Modified via Trackman: ${changes.join(', ')}]`;
    let newSessionIdForFees: number | null = null;
    const cancelledConflicts: { id: number; userEmail: string; status: string }[] = [];

    await db.transaction(async (tx) => {
      if (bayChanged || timeChanged || dateChanged) {
        const conflicting = await tx.execute(sql`
          SELECT id, trackman_booking_id, user_email, status
          FROM booking_requests
          WHERE resource_id = ${newResourceId}
            AND request_date = ${newDate}
            AND status IN (${BOOKING_STATUS.PENDING}, ${BOOKING_STATUS.APPROVED}, ${BOOKING_STATUS.CONFIRMED})
            AND start_time < ${newEndTime}
            AND end_time > ${newStartTime}
            AND id != ${bookingId}`);
        const conflictingRows = conflicting.rows as { id: number; trackman_booking_id: string | null; user_email: string; status: string }[];
        if (conflictingRows.length > 0) {
          const conflictIds = conflictingRows.map(r => r.id);
          await tx.execute(sql`
            UPDATE booking_requests 
            SET status = 'cancelled', updated_at = NOW(),
                staff_notes = COALESCE(staff_notes, '') || ${`\n[Auto-cancelled: superseded by Trackman modification of booking ${incoming.trackmanBookingId}]`}
            WHERE id = ANY(${sql`ARRAY[${sql.join(conflictIds.map(id => sql`${id}`), sql`, `)}]::int[]`})`);
          logger.info('[Trackman Webhook] Cancelled conflicting bookings at destination slot for modification', {
            extra: { bookingId, trackmanBookingId: incoming.trackmanBookingId, cancelledBookingIds: conflictIds }
          });

          for (const conflictRow of conflictingRows) {
            if (conflictRow.status === BOOKING_STATUS.APPROVED || conflictRow.status === BOOKING_STATUS.CONFIRMED) {
              cancelledConflicts.push({ id: conflictRow.id, userEmail: conflictRow.user_email, status: conflictRow.status });
            }
          }
        }
      }

      const reactivationNote = needsReactivation ? ` [Reactivated via Trackman webhook — was ${existing.status}]` : '';
      await tx.execute(sql`UPDATE booking_requests
         SET start_time = ${newStartTime},
             end_time = ${newEndTime},
             request_date = ${newDate},
             duration_minutes = ${newDuration},
             resource_id = ${newResourceId},
             trackman_player_count = ${incoming.playerCount},
             status = CASE WHEN status IN (${BOOKING_STATUS.CANCELLED}, ${BOOKING_STATUS.DECLINED}, ${BOOKING_STATUS.CANCELLATION_PENDING}) THEN ${BOOKING_STATUS.APPROVED} ELSE status END,
             last_trackman_sync_at = NOW(),
             staff_notes = COALESCE(staff_notes, '') || ${reactivationNote + staffNoteAddition},
             updated_at = NOW()
         WHERE id = ${bookingId}`);

      if (sessionId) {
        if (bayChanged || timeChanged || dateChanged) {
          const otherActiveBookings = await tx.execute(sql`SELECT COUNT(*) as cnt
             FROM booking_requests
             WHERE session_id = ${sessionId}
               AND id != ${bookingId}
               AND status NOT IN ('cancelled', 'rejected', 'declined', 'deleted')`);
          const otherCount = parseInt((otherActiveBookings.rows[0] as { cnt: string }).cnt, 10) || 0;
          const isSharedSession = otherCount > 0;

          const conflictingSessions = await tx.execute(sql`SELECT bs.id, 
               (SELECT COUNT(*) FROM booking_requests br WHERE br.session_id = bs.id AND br.status NOT IN ('cancelled', 'rejected', 'deleted')) AS linked_bookings
             FROM booking_sessions bs
             WHERE bs.resource_id = ${newResourceId}
               AND bs.session_date = ${newDate}
               AND bs.id != ${sessionId}
               AND tsrange(
                 (bs.session_date + bs.start_time)::timestamp,
                 CASE WHEN bs.end_time <= bs.start_time
                   THEN (bs.session_date + bs.end_time + INTERVAL '1 day')::timestamp
                   ELSE (bs.session_date + bs.end_time)::timestamp
                 END, '[)'
               ) && tsrange(
                 (${newDate}::date + ${newStartTime}::time)::timestamp,
                 CASE WHEN ${newEndTime}::time <= ${newStartTime}::time
                   THEN (${newDate}::date + ${newEndTime}::time + INTERVAL '1 day')::timestamp
                   ELSE (${newDate}::date + ${newEndTime}::time)::timestamp
                 END, '[)'
               )`);
          if (conflictingSessions.rows.length > 0) {
            for (const row of conflictingSessions.rows) {
              const r = row as { id: number; linked_bookings: string };
              const linkedCount = parseInt(r.linked_bookings, 10) || 0;
              if (linkedCount === 0) {
                logger.warn('[Trackman Webhook] Deleting orphan overlapping session at destination slot', {
                  extra: { bookingId, sessionId, conflictSessionId: r.id, newResourceId, newDate, newStartTime, newEndTime }
                });
                await tx.execute(sql`DELETE FROM booking_sessions WHERE id = ${r.id}`);
              } else {
                conflictWarning = `Overlapping session #${r.id} with ${linkedCount} booking(s) exists at destination — coexisting (Trackman is source of truth)`;
                logger.warn('[Trackman Webhook] ' + conflictWarning, {
                  extra: { bookingId, sessionId, conflictSessionId: r.id, linkedCount, newResourceId, newDate, newStartTime, newEndTime }
                });
              }
            }
          }

          await tx.execute(sql`SET LOCAL app.bypass_overlap_check = 'true'`);
          if (isSharedSession) {
            logger.info('[Trackman Webhook] Session is shared with other bookings — detaching and creating new session', {
              extra: { bookingId, sessionId, otherActiveBookings: otherCount, newResourceId, newDate, newStartTime, newEndTime }
            });
            const newSessionResult = await tx.execute(sql`INSERT INTO booking_sessions
               (resource_id, session_date, start_time, end_time, trackman_booking_id, source, created_by, created_at, updated_at)
               VALUES (${newResourceId}, ${newDate}, ${newStartTime}, ${newEndTime}, ${incoming.trackmanBookingId}, 'trackman_webhook', 'trackman_webhook', NOW(), NOW())
               RETURNING id`);
            const newSessionId = (newSessionResult.rows[0] as { id: number }).id;
            await tx.execute(sql`UPDATE booking_requests SET session_id = ${newSessionId} WHERE id = ${bookingId}`);

            const userLookup = await tx.execute(sql`SELECT u.id as user_id
               FROM users u WHERE LOWER(u.email) = LOWER(${existing.userEmail}) LIMIT 1`);
            const userId = userLookup.rows.length > 0 ? (userLookup.rows[0] as { user_id: string }).user_id : null;
            await tx.execute(sql`INSERT INTO booking_participants
               (session_id, user_id, participant_type, display_name, payment_status, created_at)
               VALUES (${newSessionId}, ${userId}, ${PARTICIPANT_TYPE.OWNER}, ${existing.userName || existing.userEmail}, ${PAYMENT_STATUS.WAIVED}, NOW())`);

            const rpResult = await tx.execute(sql`SELECT request_participants FROM booking_requests WHERE id = ${bookingId}`);
            const rpData = (rpResult.rows as Array<Record<string, unknown>>)[0]?.request_participants;
            let transferredCount = 0;
            if (rpData) {
              try {
                transferredCount = await transferRequestParticipantsToSession(
                  newSessionId, rpData, existing.userEmail, `modification detach booking #${bookingId}`
                );
              } catch (rpErr: unknown) {
                logger.warn('[Trackman Webhook] Non-blocking: Failed to transfer request_participants during detach', {
                  extra: { bookingId, newSessionId, error: getErrorMessage(rpErr) }
                });
              }
            }

            newSessionIdForFees = newSessionId;
            logger.info('[Trackman Webhook] Created new session with owner + request_participants for detached booking', {
              extra: { bookingId, oldSessionId: sessionId, newSessionId, newResourceId, newDate, newStartTime, newEndTime, transferredFromRequest: transferredCount }
            });
          } else {
            await tx.execute(sql`UPDATE booking_sessions
               SET start_time = ${newStartTime},
                   end_time = ${newEndTime},
                   session_date = ${newDate},
                   resource_id = ${newResourceId},
                   trackman_booking_id = ${incoming.trackmanBookingId},
                   updated_at = NOW()
               WHERE id = ${sessionId}`);
          }
        }
      }
    });

    for (const conflict of cancelledConflicts) {
      runConflictCancellationSideEffects(conflict.id, conflict.userEmail, `superseded by Trackman modification of booking ${incoming.trackmanBookingId}`);
    }

    const effectiveSessionId = newSessionIdForFees || sessionId;
    if (effectiveSessionId && incoming.playerCount > 1) {
      try {
        const existingCount = await db.execute(sql`SELECT COUNT(*) as cnt FROM booking_participants WHERE session_id = ${effectiveSessionId}`);
        const currentParticipants = Number((existingCount.rows as Array<Record<string, unknown>>)[0]?.cnt || 0);
        const targetTotal = incoming.playerCount;
        const slotsToFill = Math.max(0, targetTotal - currentParticipants);
        if (slotsToFill > 0) {
          const slotDuration = newDuration || 60;
          for (let i = 0; i < slotsToFill; i++) {
            await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              VALUES (${effectiveSessionId}, NULL, ${PARTICIPANT_TYPE.GUEST}, ${`Guest ${currentParticipants + i + 1}`}, ${PAYMENT_STATUS.WAIVED}, ${slotDuration})`);
          }
          logger.info('[Trackman Webhook] Backfilled guest slots after modification', {
            extra: { bookingId, sessionId: effectiveSessionId, slotsToFill, currentParticipants, targetTotal }
          });
        }
      } catch (backfillErr: unknown) {
        logger.warn('[Trackman Webhook] Non-blocking: Failed to backfill guest slots after modification', {
          extra: { bookingId, sessionId: effectiveSessionId, error: getErrorMessage(backfillErr) }
        });
      }
    }

    if (effectiveSessionId) {
      try {
        await recalculateSessionFees(effectiveSessionId, 'trackman_modification');
        logger.info('[Trackman Webhook] Recalculated fees after modification', {
          extra: { bookingId, sessionId: effectiveSessionId, changes }
        });

        syncBookingInvoice(bookingId, effectiveSessionId).catch((syncErr: unknown) => {
          logger.warn('[Trackman Webhook] Non-blocking: Failed to sync invoice after modification', {
            extra: { bookingId, sessionId: effectiveSessionId, error: getErrorMessage(syncErr) }
          });
        });
      } catch (recalcErr: unknown) {
        logger.warn('[Trackman Webhook] Failed to recalculate fees after modification', {
          extra: { bookingId, sessionId: effectiveSessionId, error: getErrorMessage(recalcErr) }
        });
      }
    }

    if (bayChanged && oldResourceId) {
      try {
        await updateBaySlotCache(
          incoming.trackmanBookingId,
          oldResourceId,
          existingDate,
          existingStartTime,
          existingEndTime,
          'cancelled',
          existing.userEmail
        );
      } catch (cacheErr: unknown) {
        logger.warn('[Trackman Webhook] Non-blocking: Failed to clean up old bay slot cache', {
          extra: { bookingId, oldResourceId, error: getErrorMessage(cacheErr) }
        });
      }

      try {
        broadcastAvailabilityUpdate({
          resourceId: oldResourceId,
          resourceType: RESOURCE_TYPE.SIMULATOR,
          date: existingDate,
          action: 'cancelled'
        });
        broadcastAvailabilityUpdate({
          resourceId: newResourceId!,
          resourceType: RESOURCE_TYPE.SIMULATOR,
          date: newDate,
          action: 'booked'
        });
      } catch (broadcastErr: unknown) {
        logger.warn('[Trackman Webhook] Failed to broadcast availability after bay change', {
          extra: { bookingId, error: getErrorMessage(broadcastErr) }
        });
      }
    } else if (timeChanged || dateChanged) {
      try {
        broadcastAvailabilityUpdate({
          resourceId: newResourceId!,
          resourceType: RESOURCE_TYPE.SIMULATOR,
          date: newDate,
          action: 'booked'
        });
        if (dateChanged) {
          broadcastAvailabilityUpdate({
            resourceId: newResourceId!,
            resourceType: RESOURCE_TYPE.SIMULATOR,
            date: existingDate,
            action: 'cancelled'
          });
        }
      } catch (broadcastErr: unknown) {
        logger.warn('[Trackman Webhook] Failed to broadcast availability after time/date change', {
          extra: { bookingId, error: getErrorMessage(broadcastErr) }
        });
      }
    }

    const changesSummary = changes.join(', ');
    const memberName = existing.userName || existing.userEmail || 'Unknown';

    broadcastToStaff({
      type: 'trackman_booking_modified',
      title: 'Booking Modified via Trackman',
      message: `${memberName}'s booking on ${newDate} was modified: ${changesSummary}${conflictWarning ? ` ⚠️ ${conflictWarning}` : ''}`,
      data: {
        bookingId,
        memberName,
        memberEmail: existing.userEmail,
        date: newDate,
        changes,
        conflictWarning,
        trackmanBookingId: incoming.trackmanBookingId
      }
    });

    await notifyAllStaff(
      'Booking Modified via Trackman',
      `${memberName}'s booking was modified: ${changesSummary}${conflictWarning ? ` — ${conflictWarning}` : ''}`,
      'trackman_booking',
      {
        relatedId: bookingId,
        relatedType: 'trackman_booking'
      }
    );

    if (existing.userEmail && (bayChanged || timeChanged || dateChanged)) {
      try {
        const bayLabel = newResourceId ? `Bay ${newResourceId}` : '';
        const formattedStart = formatTime12Hour(newStartTime);
        const formattedEnd = formatTime12Hour(newEndTime);
        const modMessage = bayChanged
          ? `Your booking on ${newDate} has been moved to ${bayLabel} at ${formattedStart}.`
          : dateChanged
          ? `Your booking has been moved to ${newDate} at ${formattedStart}${bayLabel ? ` (${bayLabel})` : ''}.`
          : `Your booking on ${newDate} has been updated to ${formattedStart}-${formattedEnd}${bayLabel ? ` (${bayLabel})` : ''}.`;

        await notifyMember(
          {
            userEmail: existing.userEmail,
            title: 'Booking Updated',
            message: modMessage,
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
      } catch (memberNotifyErr: unknown) {
        logger.warn('[Trackman Webhook] Failed to notify member about modification', {
          extra: { bookingId, error: getErrorMessage(memberNotifyErr) }
        });
      }
    }

    if (effectiveSessionId) {
      linkAndNotifyParticipants(bookingId, {
        trackmanBookingId: incoming.trackmanBookingId,
        linkedBy: 'trackman_modification',
        bayName: newResourceId ? `Bay ${newResourceId}` : undefined
      }).catch(err => {
        logger.warn('[Trackman Webhook] Non-blocking: Failed to link/notify participants after modification', {
          extra: { bookingId, sessionId: effectiveSessionId, error: getErrorMessage(err) }
        });
      });
    }

    if (bayChanged || timeChanged || dateChanged) {
      refreshBookingPass(bookingId).catch(err =>
        logger.error('[Trackman Webhook] Wallet pass refresh failed after modification', { extra: { bookingId, error: getErrorMessage(err) } })
      );
    }

    logger.info('[Trackman Webhook] Successfully applied booking modification', {
      extra: { bookingId, sessionId: effectiveSessionId, trackmanBookingId: incoming.trackmanBookingId, changes, conflictWarning }
    });

    return { modified: true, changes, conflictWarning };
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to apply booking modification', {
      error: error as Error,
      extra: { bookingId, trackmanBookingId: incoming.trackmanBookingId, changes }
    });
    return { modified: false, changes: [] };
  }
}
