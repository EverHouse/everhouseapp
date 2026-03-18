import { logger } from '../../core/logger';
import { transferRequestParticipantsToSession } from '../../core/trackmanImport';
import { bookingRequests } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { BOOKING_STATUS, PAYMENT_STATUS, PARTICIPANT_TYPE, RESOURCE_TYPE } from '../../../shared/constants/statuses';
import type { ParticipantType } from '../../../shared/constants/statuses';
import {
  calculateDurationMinutes,
} from './webhook-helpers';
import { checkUnifiedAvailability } from '../../core/bookingService/availabilityGuard';
import { BookingStateService } from '../../core/bookingService';
import { getErrorMessage } from '../../utils/errorUtils';
import { ensureSessionForBooking, createTxQueryClient } from '../../core/bookingService/sessionManager';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { createDraftInvoiceForBooking, syncBookingInvoice } from '../../core/billing/bookingInvoiceService';
import { runConflictCancellationSideEffects } from './webhook-modification';

interface PendingBookingRow {
  id: number;
  user_email: string;
  user_name: string | null;
  staff_notes: string | null;
  resource_id: number | null;
  start_time: string;
  end_time: string;
  duration_minutes: number | null;
  session_id: number | null;
  user_id: number | null;
}

interface IdRow {
  id: number;
}

interface ResourceTypeRow {
  type: string;
}

interface ParticipantFeeRow {
  id: number;
  display_name: string | null;
  participant_type: string;
  cached_fee_cents: number;
}

interface StripeCustomerRow {
  stripe_customer_id: string | null;
}

interface InsertedBookingRow {
  id: number;
  was_inserted: boolean;
}

export async function tryAutoApproveBooking(
  customerEmail: string,
  slotDate: string,
  startTime: string,
  trackmanBookingId: string
): Promise<{ matched: boolean; bookingId?: number; resourceId?: number; sessionId?: number }> {
  let matchedBookingId: number | undefined;
  try {
    const result = await db.execute(sql`SELECT br.id, br.user_email, br.user_name, br.staff_notes, br.resource_id, 
              br.start_time, br.end_time, br.duration_minutes, br.session_id,
              u.id as user_id
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
       WHERE LOWER(br.user_email) = LOWER(${customerEmail})
         AND br.request_date = ${slotDate}
         AND ABS(EXTRACT(EPOCH FROM (br.start_time::time - ${startTime}::time))) <= 600
         AND (
           (br.start_time < br.end_time AND ${startTime}::time < br.end_time)
           OR
           (br.start_time >= br.end_time AND (${startTime}::time < br.end_time OR ${startTime}::time >= br.start_time))
         )
         AND br.status IN (${BOOKING_STATUS.PENDING}, ${BOOKING_STATUS.PENDING_APPROVAL})
         AND br.trackman_booking_id IS NULL
       ORDER BY ABS(EXTRACT(EPOCH FROM (br.start_time::time - ${startTime}::time))), br.created_at DESC
       LIMIT 1`);
    
    const pendingRows = result.rows as unknown as PendingBookingRow[];
    if (pendingRows.length === 0) {
      return { matched: false };
    }
    
    const pendingBooking = pendingRows[0];
    const bookingId = pendingBooking.id;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    matchedBookingId = bookingId;
    const resourceId = pendingBooking.resource_id;
    
    const updatedNotes = (pendingBooking.staff_notes || '') + ' [Auto-approved via Trackman webhook]';
    
    let createdSessionId: number | undefined;

    try {
      await db.transaction(async (tx) => {
        const updateResult = await tx.execute(sql`UPDATE booking_requests 
           SET status = ${BOOKING_STATUS.APPROVED}, 
               trackman_booking_id = ${trackmanBookingId}, 
               staff_notes = ${updatedNotes},
               reviewed_by = 'trackman_webhook',
               reviewed_at = NOW(),
               updated_at = NOW()
           WHERE id = ${bookingId} AND trackman_booking_id IS NULL
           RETURNING id`);
        
        const updateRows = updateResult.rows as unknown as IdRow[];
        if (updateRows.length === 0) {
          throw new Error('ALREADY_LINKED');
        }

        if (!pendingBooking.session_id && resourceId) {
          const sessionResult = await ensureSessionForBooking({
            bookingId,
            resourceId,
            sessionDate: slotDate,
            startTime: String(pendingBooking.start_time),
            endTime: String(pendingBooking.end_time),
            ownerEmail: String(pendingBooking.user_email),
            ownerName: pendingBooking.user_name ? String(pendingBooking.user_name) : undefined,
            ownerUserId: pendingBooking.user_id ? String(pendingBooking.user_id) : undefined,
            trackmanBookingId,
            source: 'trackman_webhook',
            createdBy: 'trackman_webhook'
          }, createTxQueryClient(tx));

          if (!sessionResult.sessionId) {
            throw new Error(`SESSION_FAILED: ${sessionResult.error}`);
          }
          
          createdSessionId = sessionResult.sessionId;
          await tx.execute(sql`UPDATE booking_participants SET payment_status = ${PAYMENT_STATUS.WAIVED} WHERE session_id = ${createdSessionId} AND (payment_status = ${PAYMENT_STATUS.PENDING} OR payment_status IS NULL)`);
        }
      });

      if (createdSessionId) {
        try {
          const rpResult = await db.execute(sql`SELECT request_participants FROM booking_requests WHERE id = ${bookingId}`);
          const rpData = (rpResult.rows[0] as { request_participants: unknown })?.request_participants;
          await transferRequestParticipantsToSession(
            createdSessionId, rpData, String(pendingBooking.user_email), `webhook auto-approve booking #${bookingId}`
          );
        } catch (rpErr: unknown) {
          logger.warn('[Trackman Webhook] Non-blocking: Failed to transfer request_participants to session', {
            extra: { bookingId, sessionId: createdSessionId, error: getErrorMessage(rpErr) }
          });
        }
      }

    } catch (txError: unknown) {
      const txMsg = txError instanceof Error ? txError.message : String(txError);
      if (txMsg === 'ALREADY_LINKED') {
        logger.warn('[Trackman Webhook] Pending booking was already linked by another process', {
          extra: { bookingId, trackmanBookingId, email: customerEmail }
        });
        return { matched: false };
      }
      
      logger.error('[Trackman Webhook] Auto-approve transaction failed — booking remains in pending state', {
        extra: { bookingId, trackmanBookingId, error: txMsg }
      });
      return { matched: false };
    }
    
    logger.info('[Trackman Webhook] Auto-approved pending booking', {
      extra: { bookingId, trackmanBookingId, email: customerEmail, date: slotDate, time: startTime, sessionId: createdSessionId }
    });
    
    // Create draft invoice for one-invoice-per-booking model (non-blocking)
    if (createdSessionId) {
      try {
        const resourceResult = await db.execute(sql`SELECT r.type FROM resources r JOIN booking_requests br ON br.resource_id = r.id WHERE br.id = ${bookingId}`);
        const resourceTypeRows = resourceResult.rows as unknown as ResourceTypeRow[];
        const resourceType = resourceTypeRows[0]?.type;
        if (resourceType !== RESOURCE_TYPE.CONFERENCE_ROOM) {
          const participantResult = await db.execute(sql`SELECT id, display_name, participant_type, cached_fee_cents
             FROM booking_participants
             WHERE session_id = ${createdSessionId} AND cached_fee_cents > 0`);
          const participantFeeRows = participantResult.rows as unknown as ParticipantFeeRow[];
          if (participantFeeRows.length > 0) {
            const userResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${customerEmail}) LIMIT 1`);
            const stripeRows = userResult.rows as unknown as StripeCustomerRow[];
            const stripeCustomerId = stripeRows[0]?.stripe_customer_id;
            if (stripeCustomerId) {
              const feeLineItems = participantFeeRows.map((row) => ({
                participantId: row.id,
                displayName: row.display_name || 'Unknown',
                participantType: row.participant_type as ParticipantType,
                overageCents: row.participant_type === PARTICIPANT_TYPE.GUEST ? 0 : row.cached_fee_cents,
                guestCents: row.participant_type === PARTICIPANT_TYPE.GUEST ? row.cached_fee_cents : 0,
                totalCents: row.cached_fee_cents,
              }));
              const trackmanBookingIdForInvoice = trackmanBookingId;
              await createDraftInvoiceForBooking({
                customerId: String(stripeCustomerId),
                bookingId,
                sessionId: createdSessionId,
                trackmanBookingId: trackmanBookingIdForInvoice,
                feeLineItems,
                purpose: 'booking_fee',
              });
              logger.info('[Trackman Webhook] Created draft invoice for auto-approved booking', { extra: { bookingId, sessionId: createdSessionId } });
            }
          }
        }
      } catch (invoiceErr: unknown) {
        logger.warn('[Trackman Webhook] Non-blocking: Failed to create draft invoice for auto-approved booking', {
          extra: { bookingId, error: getErrorMessage(invoiceErr) }
        });
      }
    }
    
    const resolvedSessionId = createdSessionId as unknown as number | undefined;
    return { matched: true, bookingId, resourceId: resourceId ?? undefined, sessionId: resolvedSessionId };
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Failed to auto-approve booking', { error: e as Error });
    return { matched: false };
  }
}

export async function cancelBookingByTrackmanId(
  trackmanBookingId: string
): Promise<{ cancelled: boolean; bookingId?: number; refundedPasses?: number; wasPendingCancellation?: boolean }> {
  try {
    const [booking] = await db.select({
      id: bookingRequests.id,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      status: bookingRequests.status,
      sessionId: bookingRequests.sessionId,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      resourceId: bookingRequests.resourceId,
      trackmanBookingId: bookingRequests.trackmanBookingId,
      isUnmatched: bookingRequests.isUnmatched
    }).from(bookingRequests).where(eq(bookingRequests.trackmanBookingId, trackmanBookingId));

    if (!booking) return { cancelled: false };
    if (booking.status === BOOKING_STATUS.CANCELLED) {
      if (booking.isUnmatched) {
        await db.update(bookingRequests).set({ isUnmatched: false }).where(eq(bookingRequests.id, booking.id));
      }
      return { cancelled: true, bookingId: booking.id };
    }

    const wasPendingCancellation = booking.status === BOOKING_STATUS.CANCELLATION_PENDING;

    let result;
    if (wasPendingCancellation) {
      result = await BookingStateService.completePendingCancellation({
        bookingId: booking.id,
        staffEmail: 'trackman-webhook@system',
        source: 'trackman_webhook'
      });
    } else {
      result = await BookingStateService.cancelBooking({
        bookingId: booking.id,
        source: 'trackman_webhook',
        staffNotes: '[Cancelled via Trackman webhook]'
      });
    }

    if (!result.success) {
      if (result.alreadyCancelled) {
        logger.warn('[Trackman Webhook] Booking already cancelled (idempotent)', {
          extra: { bookingId: booking.id }
        });
        return { cancelled: true, bookingId: booking.id };
      }
      logger.error('[Trackman Webhook] Failed to cancel booking', {
        extra: { bookingId: booking.id, error: result.error }
      });
      return { cancelled: false, bookingId: booking.id };
    }

    await db.update(bookingRequests).set({ isUnmatched: false }).where(eq(bookingRequests.id, booking.id));

    return { cancelled: true, bookingId: booking.id, wasPendingCancellation };
  } catch (e: unknown) {
    logger.error('[Trackman Webhook] Error in cancelBookingByTrackmanId', {
      error: e as Error, extra: { trackmanBookingId }
    });
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
    const existingResult = await db.execute(sql`SELECT id FROM trackman_unmatched_bookings WHERE trackman_booking_id = ${trackmanBookingId}`);
    const existingRows = existingResult.rows as unknown as IdRow[];
    
    if (existingRows.length > 0) {
      await db.execute(sql`UPDATE trackman_unmatched_bookings 
         SET booking_date = ${slotDate}, start_time = ${startTime}, end_time = ${endTime}, bay_number = ${resourceId ?? null},
             original_email = ${customerEmail ?? null}, user_name = ${customerName ?? null}, player_count = ${playerCount}, 
             match_attempt_reason = COALESCE(${reason ?? null}, match_attempt_reason),
             updated_at = NOW()
         WHERE trackman_booking_id = ${trackmanBookingId}`);
      return { success: true, id: existingRows[0].id };
    }
    
    const result = await db.execute(sql`INSERT INTO trackman_unmatched_bookings 
       (trackman_booking_id, booking_date, start_time, end_time, bay_number, 
        original_email, user_name, player_count, status, match_attempt_reason, created_at)
       VALUES (${trackmanBookingId}, ${slotDate}, ${startTime}, ${endTime}, ${resourceId ?? null}, ${customerEmail ?? null}, ${customerName ?? null}, ${playerCount}, ${BOOKING_STATUS.PENDING}, ${reason || 'no_member_match'}, NOW())
       RETURNING id`);
    const insertedRows = result.rows as unknown as IdRow[];
    
    logger.info('[Trackman Webhook] Saved to unmatched bookings', {
      extra: { trackmanBookingId, email: customerEmail, name: customerName, date: slotDate }
    });
    
    return { success: true, id: insertedRows[0]?.id };
  } catch (e: unknown) {
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
    
    const bookingStatus = BOOKING_STATUS.APPROVED;
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
        
        const conflictLabel = availability.conflictType === 'session'
          ? 'existing booking session'
          : (availability.conflictTitle || 'schedule conflict');
        conflictNote = `[Conflict: overlaps with ${conflictLabel} — Trackman booking is authoritative]`;
        logger.info('[Trackman Webhook] Conflict detected but keeping approved — Trackman is source of truth', {
          extra: { trackmanBookingId, conflictType: availability.conflictType, conflictTitle: availability.conflictTitle }
        });
      }
    }
    
    let result;
    try {
      result = await db.execute(sql`INSERT INTO booking_requests 
         (request_date, start_time, end_time, duration_minutes, resource_id,
          user_email, user_name, status, trackman_booking_id, trackman_external_id,
          trackman_player_count, is_unmatched, staff_notes,
          origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
         VALUES (${slotDate}, ${startTime}, ${endTime}, ${durationMinutes}, ${resourceId ?? null}, ${customerEmail || ''}, ${customerName || 'Unknown (Trackman)'}, ${bookingStatus}, ${trackmanBookingId}, ${externalBookingId || null}, ${playerCount}, true, ${conflictNote || null},
                 'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
         ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
           last_trackman_sync_at = NOW(),
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS was_inserted`);
    } catch (insertError: unknown) {
      const errMsg = insertError instanceof Error ? insertError.message : String(insertError);
      const cause = (insertError as { cause?: { code?: string } })?.cause;
      const isDeadlock = cause?.code === '40P01' || errMsg.includes('deadlock detected');
      if (isDeadlock) {
        logger.warn('[Trackman Webhook] Deadlock detected on insert — retrying after brief delay', {
          extra: { trackmanBookingId, date: slotDate, time: startTime }
        });
        await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
        try {
          result = await db.execute(sql`INSERT INTO booking_requests 
             (request_date, start_time, end_time, duration_minutes, resource_id,
              user_email, user_name, status, trackman_booking_id, trackman_external_id,
              trackman_player_count, is_unmatched, staff_notes,
              origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
             VALUES (${slotDate}, ${startTime}, ${endTime}, ${durationMinutes}, ${resourceId ?? null}, ${customerEmail || ''}, ${customerName || 'Unknown (Trackman)'}, ${bookingStatus}, ${trackmanBookingId}, ${externalBookingId || null}, ${playerCount}, true, ${conflictNote || null},
                     'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
             ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
               last_trackman_sync_at = NOW(),
               updated_at = NOW()
             RETURNING id, (xmax = 0) AS was_inserted`);
        } catch (retryError: unknown) {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
          const retryCause = (retryError as { cause?: { code?: string } })?.cause;
          const isOverlapAfterDeadlock = retryCause?.code === '23P01' || retryMsg.includes('booking_requests_no_overlap') || retryMsg.includes('23P01');
          if (!isOverlapAfterDeadlock) {
            logger.error('[Trackman Webhook] Insert failed even after deadlock retry', {
              error: retryError instanceof Error ? retryError : new Error(String(retryError)),
              extra: { trackmanBookingId, date: slotDate, time: startTime }
            });
            return { created: false };
          }
          logger.info('[Trackman Webhook] Deadlock retry hit overlap constraint — falling through to conflict resolution', {
            extra: { trackmanBookingId, date: slotDate, time: startTime }
          });
        }
      }
      const isOverlap = cause?.code === '23P01' || errMsg.includes('booking_requests_no_overlap') || errMsg.includes('23P01');
      if (!result && (isOverlap || isDeadlock)) {
        logger.info('[Trackman Webhook] Overlap constraint hit — cancelling conflicting bookings (Trackman is authoritative)', {
          extra: { trackmanBookingId, date: slotDate, time: startTime, endTime, resourceId }
        });

        try {
          const txResultWithConflicts = await db.transaction(async (tx) => {
            const conflicting = await tx.execute(sql`
              SELECT id, trackman_booking_id, user_email, status
              FROM booking_requests
              WHERE resource_id = ${resourceId}
                AND request_date = ${slotDate}
                AND status IN (${BOOKING_STATUS.PENDING}, ${BOOKING_STATUS.APPROVED}, ${BOOKING_STATUS.CONFIRMED})
                AND start_time < ${endTime}
                AND end_time > ${startTime}
                AND (trackman_booking_id IS NULL OR trackman_booking_id != ${trackmanBookingId})
              FOR UPDATE`);

            const conflictingRows = conflicting.rows as { id: number; trackman_booking_id: string | null; user_email: string; status: string }[];

            const newBookingConflicts: { id: number; userEmail: string }[] = [];

            if (conflictingRows.length > 0) {
              const conflictIds = conflictingRows.map(r => r.id);
              await tx.execute(sql`
                UPDATE booking_requests 
                SET status = 'cancelled', updated_at = NOW(),
                    staff_notes = COALESCE(staff_notes, '') || ${`\n[Auto-cancelled: superseded by Trackman booking ${trackmanBookingId}]`}
                WHERE id = ANY(${sql`ARRAY[${sql.join(conflictIds.map(id => sql`${id}`), sql`, `)}]::int[]`})`);

              logger.info('[Trackman Webhook] Cancelled conflicting bookings to make room for Trackman booking', {
                extra: { 
                  trackmanBookingId, 
                  cancelledBookingIds: conflictIds,
                  cancelledDetails: conflictingRows.map(r => ({ id: r.id, trackmanId: r.trackman_booking_id, email: r.user_email }))
                }
              });

              for (const conflictRow of conflictingRows) {
                if (conflictRow.status === BOOKING_STATUS.APPROVED || conflictRow.status === BOOKING_STATUS.CONFIRMED) {
                  newBookingConflicts.push({ id: conflictRow.id, userEmail: conflictRow.user_email });
                }
              }
            }

            const insertResult = await tx.execute(sql`INSERT INTO booking_requests 
               (request_date, start_time, end_time, duration_minutes, resource_id,
                user_email, user_name, status, trackman_booking_id, trackman_external_id,
                trackman_player_count, is_unmatched, staff_notes,
                origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
               VALUES (${slotDate}, ${startTime}, ${endTime}, ${durationMinutes}, ${resourceId}, ${customerEmail || ''}, ${customerName || 'Unknown (Trackman)'}, ${bookingStatus}, ${trackmanBookingId}, ${externalBookingId || null}, ${playerCount}, true, ${conflictNote || null},
                       'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
               ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
                 last_trackman_sync_at = NOW(),
                 updated_at = NOW()
               RETURNING id, (xmax = 0) AS was_inserted`);

            return { insertResult, newBookingConflicts };
          });

          for (const conflict of txResultWithConflicts.newBookingConflicts) {
            runConflictCancellationSideEffects(conflict.id, conflict.userEmail, `superseded by Trackman booking ${trackmanBookingId}`);
          }

          result = txResultWithConflicts.insertResult;
        } catch (retryError: unknown) {
          logger.error('[Trackman Webhook] Failed to create booking even after cancelling conflicts', {
            error: retryError instanceof Error ? retryError : new Error(String(retryError)),
            extra: { trackmanBookingId, date: slotDate, time: startTime }
          });
          return { created: false };
        }
      } else if (!result) {
        throw insertError;
      }
    }
    
    const insertedBookingRows = result.rows as unknown as InsertedBookingRow[];
    if (insertedBookingRows.length > 0) {
      const bookingId = insertedBookingRows[0].id;
      const wasInserted = insertedBookingRows[0].was_inserted;
      
      if (!wasInserted) {
        logger.info('[Trackman Webhook] Booking already exists for this Trackman ID (atomic dedup)', {
          extra: { trackmanBookingId, existingBookingId: bookingId }
        });
        return { created: false, bookingId };
      }
      
      if (bookingStatus === BOOKING_STATUS.APPROVED && customerEmail && customerEmail.includes('@')) {
        const sessionResult = await ensureSessionForBooking({
          bookingId,
          resourceId: resourceId!,
          sessionDate: slotDate,
          startTime,
          endTime,
          ownerEmail: customerEmail,
          ownerName: customerName || 'Unknown (Trackman)',
          trackmanBookingId,
          source: 'trackman_webhook',
          createdBy: 'trackman_webhook'
        });

        if (sessionResult.sessionId) {
          await db.execute(sql`UPDATE booking_participants SET payment_status = ${PAYMENT_STATUS.WAIVED} WHERE session_id = ${sessionResult.sessionId} AND (payment_status = ${PAYMENT_STATUS.PENDING} OR payment_status IS NULL)`);
        } else {
          logger.warn('[Trackman Webhook] Session creation failed for unmatched booking (keeping approved to block calendar)', {
            extra: { bookingId, trackmanBookingId, error: sessionResult.error }
          });
        }
      } else if (bookingStatus === BOOKING_STATUS.APPROVED) {
        logger.info('[Trackman Webhook] Session creation deferred until member assignment (no real customer email)', {
          extra: { bookingId, trackmanBookingId, customerEmail: customerEmail || '(empty)' }
        });
      }
      
      logger.info('[Trackman Webhook] Created unmatched booking_request to block calendar', {
        extra: { bookingId, trackmanBookingId, date: slotDate, time: startTime }
      });
      
      return { created: true, bookingId };
    }
    
    return { created: false };
  } catch (e: unknown) {
    const cause = (e as Error & { cause?: unknown })?.cause;
    const causeObj = cause && typeof cause === 'object' ? cause as { message?: string; code?: string; detail?: string } : undefined;
    logger.error('[Trackman Webhook] Failed to create unmatched booking_request', { 
      error: e as Error,
      extra: { cause: causeObj ? { message: causeObj.message, code: causeObj.code, detail: causeObj.detail } : undefined }
    });
    return { created: false };
  }
}
