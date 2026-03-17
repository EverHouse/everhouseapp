import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logger } from '../../core/logger';
import { sendNotificationToUser, broadcastToStaff } from '../../core/websocket';
import { notifyMember } from '../../core/notificationService';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { linkAndNotifyParticipants } from '../../core/bookingEvents';
import { formatDatePacific, formatTimePacific } from '../../utils/dateUtils';
import { calculateDurationMinutes } from './webhook-helpers';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { transferRequestParticipantsToSession } from '../../core/trackmanImport';
import { voidBookingPass } from '../../walletPass/bookingPassService';
import { cancelPendingPaymentIntentsForBooking, refundSucceededPaymentIntentsForBooking } from '../../core/billing/paymentIntentCleanup';
import { getErrorMessage, safeErrorDetail } from '../../utils/errorUtils';

function runReprocessConflictSideEffects(bookingId: number, userEmail: string, reason: string): void {
  (async () => {
    try {
      await cancelPendingPaymentIntentsForBooking(bookingId);
    } catch (err: unknown) {
      logger.error('[Trackman Reprocess] Failed to cancel pending PIs for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } });
    }

    try {
      await refundSucceededPaymentIntentsForBooking(bookingId);
    } catch (err: unknown) {
      logger.error('[Trackman Reprocess] Failed to refund succeeded PIs for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } });
    }

    try {
      const { voidBookingInvoice } = await import('../../core/billing/bookingInvoiceService');
      await voidBookingInvoice(bookingId);
    } catch (err: unknown) {
      logger.error('[Trackman Reprocess] Failed to void invoice for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } });
    }

    voidBookingPass(bookingId).catch(err => logger.error('[Trackman Reprocess] Failed to void wallet pass for conflict-cancelled booking', { extra: { bookingId, error: getErrorMessage(err) } }));

    if (userEmail && !userEmail.endsWith('@trackman.local')) {
      notifyMember({
        userEmail,
        title: 'Booking Cancelled',
        message: `Your booking has been automatically cancelled: ${reason}. Please contact staff if you have questions.`,
        type: 'booking_cancelled',
        relatedId: bookingId,
        relatedType: 'booking_request',
        url: '/my-bookings'
      }).catch(err => logger.error('[Trackman Reprocess] Failed to notify member about conflict cancellation', { extra: { bookingId, userEmail, error: getErrorMessage(err) } }));
    }
  })().catch(err => logger.error('[Trackman Reprocess] Conflict cancellation side effects failed', { extra: { bookingId, error: getErrorMessage(err) } }));
}

interface SimulateBookingRow {
  id: number;
  user_email: string;
  user_name: string | null;
  resource_id: number | null;
  start_time: string;
  end_time: string;
  request_date: string | Date;
  duration_minutes: number | null;
  declared_player_count: number | null;
  session_id: number | null;
  status: string;
  stripe_customer_id: string | null;
  tier: string | null;
  calculatedTotalFeeCents?: number;
  notes: string | null;
}

interface ResourceNameRow {
  id: number;
  name: string;
}

interface InsertedIdRow {
  id: number;
}

interface UserIdRow {
  id: number;
}

interface UnmatchedWebhookEventRow {
  id: number;
  trackman_booking_id: string;
  payload: string | Record<string, unknown>;
  created_at: string;
}

interface ExistingBookingIdRow {
  id: number;
}

interface ExistingBookingLinkRow {
  id: number;
  user_email: string;
  user_name: string;
  trackman_booking_id: string | null;
}

interface NewBookingRow {
  id: number;
  was_inserted: boolean;
}

interface BackfillDetailItem {
  trackmanId: string | unknown;
  status: string;
  reason?: string;
  bookingId?: number | unknown;
  member?: string | unknown;
  date?: string;
  time?: string;
  bay?: string;
}

const router = Router();

router.post('/api/admin/bookings/:id/simulate-confirm', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.id as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const bookingResult = await db.execute(sql`SELECT br.*, u.stripe_customer_id, u.tier
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
       WHERE br.id = ${bookingId}`);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0] as unknown as SimulateBookingRow;
    
    if (booking.status !== 'pending' && booking.status !== 'pending_approval') {
      return res.status(400).json({ error: `Booking is already ${booking.status}` });
    }

    const fakeTrackmanId = `SIM-${Date.now()}`;
    
    const resourceResult = await db.execute(sql`SELECT id, name FROM resources WHERE id = ${booking.resource_id}`);
    const resource = resourceResult.rows[0] as unknown as ResourceNameRow;
    const bayRef = String(resource?.name || '').match(/\d+/)?.[0] || '1';
    const bayIdMap: Record<string, number> = { '1': 7410, '2': 7411, '3': 7412, '4': 7413 };
    const trackmanBayId = bayIdMap[bayRef] || 7410;
    
    const bookingDate = typeof booking.request_date === 'string' 
      ? booking.request_date 
      : new Date(booking.request_date as string | number | Date).toISOString().split('T')[0];
    const startISO = `${bookingDate}T${booking.start_time}.000Z`;
    const endISO = `${bookingDate}T${booking.end_time}.000Z`;
    
    const realisticPayload = {
      venue: {
        id: 941,
        name: "Ever Club",
        slug: "even-house"
      },
      booking: {
        id: parseInt(fakeTrackmanId.replace('SIM-', ''), 10),
        bay: {
          id: trackmanBayId,
          ref: bayRef
        },
        end: endISO,
        type: "bay",
        range: { id: 947 },
        start: startISO,
        status: "confirmed",
        bayOption: {
          id: 16727,
          name: "Member Option",
          duration: Math.floor((Number(booking.duration_minutes) || 60) / 60),
          subtitle: null
        },
        created_at: new Date().toISOString(),
        playerOptions: [{
          id: 5854,
          name: "Member",
          quantity: booking.declared_player_count || 1,
          subtitle: null
        }],
        customers: [{
          email: booking.user_email,
          first_name: String(booking.user_name || '').split(' ')[0] || 'Member',
          last_name: String(booking.user_name || '').split(' ').slice(1).join(' ') || ''
        }]
      },
      _simulated: true,
      _simulatedBy: 'staff',
      _originalBookingId: bookingId
    };
    
    const webhookEventResult = await db.execute(sql`INSERT INTO trackman_webhook_events (
        event_type, 
        trackman_booking_id, 
        matched_booking_id,
        payload, 
        processed_at
      )
      VALUES (${'booking.confirmed'}, ${fakeTrackmanId}, ${bookingId}, ${JSON.stringify(realisticPayload)}, NOW())
      RETURNING id`);
    
    logger.info('[Simulate Confirm] Created webhook event record', {
      bookingId,
      trackmanId: fakeTrackmanId,
      webhookEventId: (webhookEventResult.rows[0] as unknown as InsertedIdRow)?.id
    });

    let sessionId = booking.session_id;
    if (!sessionId && booking.resource_id) {
      try {
        const userResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${booking.user_email})`);
        const userId = (userResult.rows[0] as unknown as UserIdRow)?.id || null;

        const sessionResult = await ensureSessionForBooking({
          bookingId,
          resourceId: booking.resource_id as number,
          sessionDate: booking.request_date as string,
          startTime: booking.start_time as string,
          endTime: booking.end_time as string,
          ownerEmail: (booking.user_email as string) || '',
          ownerName: booking.user_name as string,
          ownerUserId: userId?.toString() || undefined,
          trackmanBookingId: fakeTrackmanId,
          source: 'staff_manual',
          createdBy: 'simulate_confirm'
        });
        sessionId = sessionResult.sessionId || null;

        if (sessionId) {
          const playerCount = booking.declared_player_count || 1;
          const sessionDuration = Math.round(
            (new Date(`2000-01-01T${booking.end_time}`).getTime() - 
             new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000
          );

          let transferredCount = 0;
          try {
            const rpResult = await db.execute(sql`SELECT request_participants FROM booking_requests WHERE id = ${bookingId}`);
            const rpData = (rpResult.rows[0] as { request_participants: unknown })?.request_participants;
            if (rpData && Array.isArray(rpData) && rpData.length > 0) {
              transferredCount = await transferRequestParticipantsToSession(
                sessionId as number, rpData, (booking.user_email as string) || '', `simulate confirm booking #${bookingId}`
              );
            }
          } catch (rpErr: unknown) {
            logger.warn('[Simulate Confirm] Non-blocking: Failed to transfer request_participants', {
              extra: { bookingId, sessionId, error: getErrorMessage(rpErr) }
            });
          }

          const remainingSlots = Math.max(0, (Number(playerCount) - 1) - transferredCount);
          for (let i = 0; i < remainingSlots; i++) {
            await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              VALUES (${sessionId}, ${null}, ${'guest'}, ${`Guest ${transferredCount + i + 2}`}, ${'pending'}, ${sessionDuration})`);
          }

          if (transferredCount > 0 || remainingSlots > 0) {
            logger.info('[Simulate Confirm] Created participants', {
              bookingId,
              sessionId,
              playerCount: Number(playerCount),
              transferredFromRequest: transferredCount,
              genericGuestSlots: remainingSlots,
              sessionDuration
            });
          }

          try {
            const feeResult = await recalculateSessionFees(sessionId as number, 'approval');
            if (feeResult?.totals?.totalCents != null) {
              booking.calculatedTotalFeeCents = feeResult.totals.totalCents;
            }
            logger.info('[Simulate Confirm] Calculated fees for session', {
              sessionId,
              feeResult: feeResult?.totals?.totalCents || 0
            });
          } catch (feeError: unknown) {
            logger.warn('[Simulate Confirm] Failed to calculate fees (non-blocking)', { error: feeError instanceof Error ? feeError : new Error(String(feeError)) });
          }
        }
      } catch (sessionError: unknown) {
        logger.error('[Simulate Confirm] Failed to create session (non-blocking)', { error: sessionError instanceof Error ? sessionError : new Error(String(sessionError)) });
      }
    }

    await db.execute(sql`UPDATE booking_requests 
       SET status = 'approved', 
           trackman_booking_id = ${fakeTrackmanId},
           session_id = COALESCE(session_id, ${sessionId}),
           notes = COALESCE(notes, '') || E'\n[Simulated confirmation for testing]',
           updated_at = NOW()
       WHERE id = ${bookingId}`);

    try {
      const dateStr = typeof booking.request_date === 'string' ? booking.request_date : formatDatePacific(new Date(booking.request_date));
      const timeStr = typeof booking.start_time === 'string' 
        ? booking.start_time.substring(0, 5) 
        : formatTimePacific(new Date(booking.start_time as string | number));
      
      await notifyMember({
        userEmail: booking.user_email as string,
        title: 'Booking Confirmed',
        message: `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.`,
        type: 'booking_confirmed' as const,
        relatedId: bookingId,
        relatedType: 'booking',
        url: '/bookings'
      });

      sendNotificationToUser(booking.user_email as string, {
        type: 'booking_approved',
        title: 'Booking Confirmed',
        message: 'Your booking has been confirmed',
      });
    } catch (notifyError: unknown) {
      logger.error('[Simulate Confirm] Notification error (non-blocking)', { error: notifyError instanceof Error ? notifyError : new Error(String(notifyError)) });
    }
    
    linkAndNotifyParticipants(bookingId, {
      trackmanBookingId: fakeTrackmanId,
      linkedBy: 'simulate_confirm',
      bayName: booking.resource_id ? `Bay ${booking.resource_id}` : 'Bay'
    }).catch(err => {
      logger.warn('[Simulate Confirm] Failed to link request participants', { extra: { bookingId, error: err } });
    });

    logger.info('[Simulate Confirm] Booking manually confirmed', {
      bookingId,
      userEmail: booking.user_email as string,
      trackmanId: fakeTrackmanId
    });

    broadcastToStaff({
      type: 'booking_confirmed',
      data: {
        bookingId,
        status: 'approved',
        userEmail: booking.user_email,
        trackmanBookingId: fakeTrackmanId,
        message: 'Booking has been confirmed',
      }
    });

    const totalFeeCents = booking.calculatedTotalFeeCents || 0;
    
    res.json({ 
      success: true, 
      message: 'Booking confirmed (simulated)',
      trackmanId: fakeTrackmanId,
      totalFeeCents
    });
  } catch (error: unknown) {
    logger.error('[Simulate Confirm] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});

router.post('/api/admin/trackman-webhooks/backfill', isAdmin, async (req, res) => {
  try {
    logger.info('[Trackman Backfill] Starting backfill of past webhook events');
    
    const unmatchedEvents = await db.execute(sql`SELECT 
        id, trackman_booking_id, payload, created_at
      FROM trackman_webhook_events 
      WHERE matched_booking_id IS NULL 
        AND payload IS NOT NULL
      ORDER BY created_at DESC`);
    
    const results = {
      total: unmatchedEvents.rows.length,
      linked: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      details: [] as BackfillDetailItem[]
    };
    
    for (const event of unmatchedEvents.rows as unknown as UnmatchedWebhookEventRow[]) {
      try {
        const payload = typeof event.payload === 'string' 
          ? JSON.parse(event.payload) 
          : event.payload;
        
        const bookingData = (payload?.booking || payload?.data || {}) as Record<string, unknown>;
        const startStr = bookingData?.start;
        const endStr = bookingData?.end;
        const bayRef = (bookingData?.bay as Record<string, unknown>)?.ref;
        const customerEmail = undefined;
        const customerName = 'Unknown (Trackman)';
        const rawPlayerOptions = bookingData?.playerOptions;
        const playerOptionsArr = Array.isArray(rawPlayerOptions)
          ? rawPlayerOptions
          : rawPlayerOptions
            ? Object.values(rawPlayerOptions)
            : [];
        const playerCount = playerOptionsArr.reduce((sum: number, opt: Record<string, unknown>) => sum + (Number(opt?.quantity) || 0), 0) || 1;
        const externalBookingId = bookingData?.externalBookingId;
        
        if (!startStr || !endStr) {
          results.skipped++;
          results.details.push({ 
            trackmanId: event.trackman_booking_id, 
            status: 'skipped', 
            reason: 'Missing start/end time in payload' 
          });
          continue;
        }
        
        const startStrVal = String(startStr);
        const endStrVal = String(endStr);
        const startDate = new Date(startStrVal.includes('T') ? startStrVal : startStrVal.replace(' ', 'T') + 'Z');
        const endDate = new Date(endStrVal.includes('T') ? endStrVal : endStrVal.replace(' ', 'T') + 'Z');
        
        const requestDate = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const startTime = startDate.toLocaleTimeString('en-US', { 
          hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
        }) + ':00';
        const endTime = endDate.toLocaleTimeString('en-US', { 
          hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
        }) + ':00';
        
        let resourceId: number | null = null;
        if (bayRef) {
          const bayNum = parseInt(String(bayRef), 10);
          if (bayNum >= 1 && bayNum <= 4) {
            resourceId = bayNum;
          }
        }
        
        const durationMinutes = calculateDurationMinutes(startTime, endTime);
        
        const existingByTrackman = await db.execute(sql`SELECT id FROM booking_requests WHERE trackman_booking_id = ${event.trackman_booking_id}`);
        
        if (existingByTrackman.rows.length > 0) {
          await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = ${(existingByTrackman.rows[0] as unknown as ExistingBookingIdRow).id} WHERE id = ${event.id}`);
          results.skipped++;
          results.details.push({ 
            trackmanId: event.trackman_booking_id, 
            status: 'skipped', 
            reason: 'Already has linked booking_request' 
          });
          continue;
        }
        
        const matchingBooking = await db.execute(sql`SELECT id, user_email, user_name, trackman_booking_id
          FROM booking_requests 
          WHERE request_date = ${requestDate} 
            AND start_time = ${startTime}
            AND (resource_id = ${resourceId} OR ${resourceId} IS NULL)
            AND trackman_booking_id IS NULL
            AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
          LIMIT 1`);
        
        if (matchingBooking.rows.length > 0) {
          const existingBooking = matchingBooking.rows[0] as unknown as ExistingBookingLinkRow;
          
          await db.execute(sql`UPDATE booking_requests 
            SET trackman_booking_id = ${event.trackman_booking_id},
                trackman_player_count = ${playerCount},
                trackman_external_id = ${externalBookingId},
                is_unmatched = false,
                staff_notes = COALESCE(staff_notes, '') || ' [Linked via backfill]',
                last_sync_source = 'trackman_webhook',
                last_trackman_sync_at = NOW(),
                updated_at = NOW()
            WHERE id = ${existingBooking.id}`);
          
          await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = ${existingBooking.id} WHERE id = ${event.id}`);
          
          results.linked++;
          results.details.push({ 
            trackmanId: event.trackman_booking_id, 
            status: 'linked', 
            bookingId: existingBooking.id,
            member: existingBooking.user_email || existingBooking.user_name
          });
        } else {
          let newBooking;
          try {
            newBooking = await db.execute(sql`INSERT INTO booking_requests 
              (request_date, start_time, end_time, duration_minutes, resource_id,
               user_email, user_name, status, trackman_booking_id, trackman_external_id,
               trackman_player_count, is_unmatched, 
               origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
              VALUES (${requestDate}, ${startTime}, ${endTime}, ${durationMinutes}, ${resourceId}, ${customerEmail || ''}, ${customerName}, 'approved', ${event.trackman_booking_id}, ${externalBookingId || null}, ${playerCount}, true,
                      'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
              ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
                last_trackman_sync_at = NOW(),
                updated_at = NOW()
              RETURNING id, (xmax = 0) AS was_inserted`);
          } catch (insertErr: unknown) {
            const errMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
            const cause = (insertErr as { cause?: { code?: string } })?.cause;
            if (cause?.code === '23P01' || errMsg.includes('booking_requests_no_overlap') || errMsg.includes('23P01')) {
              const txResult = await db.transaction(async (tx) => {
                const conflicting = await tx.execute(sql`
                  SELECT id, user_email, status FROM booking_requests
                  WHERE resource_id = ${resourceId}
                    AND request_date = ${requestDate}
                    AND status IN ('pending', 'approved', 'confirmed')
                    AND start_time < ${endTime}
                    AND end_time > ${startTime}
                    AND (trackman_booking_id IS NULL OR trackman_booking_id != ${event.trackman_booking_id})
                  FOR UPDATE`);
                const conflictRows = conflicting.rows as { id: number; user_email: string; status: string }[];
                const conflictIds = conflictRows.map(r => r.id);
                const reprocessConflicts: { id: number; userEmail: string }[] = [];
                if (conflictIds.length > 0) {
                  await tx.execute(sql`
                    UPDATE booking_requests SET status = 'cancelled', updated_at = NOW(),
                      staff_notes = COALESCE(staff_notes, '') || ${`\n[Auto-cancelled: superseded by Trackman reprocess ${event.trackman_booking_id}]`}
                    WHERE id = ANY(${sql.raw(`ARRAY[${conflictIds.join(',')}]::int[]`)})`);
                  logger.info('[Trackman Reprocess] Cancelled overlapping bookings', { extra: { trackmanBookingId: event.trackman_booking_id, cancelledIds: conflictIds } });

                  for (const conflictRow of conflictRows) {
                    if (['approved', 'confirmed'].includes(conflictRow.status)) {
                      reprocessConflicts.push({ id: conflictRow.id, userEmail: conflictRow.user_email });
                    }
                  }
                }
                const insertResult = await tx.execute(sql`INSERT INTO booking_requests 
                  (request_date, start_time, end_time, duration_minutes, resource_id,
                   user_email, user_name, status, trackman_booking_id, trackman_external_id,
                   trackman_player_count, is_unmatched, 
                   origin, last_sync_source, last_trackman_sync_at, created_at, updated_at)
                  VALUES (${requestDate}, ${startTime}, ${endTime}, ${durationMinutes}, ${resourceId}, ${customerEmail || ''}, ${customerName}, 'approved', ${event.trackman_booking_id}, ${externalBookingId || null}, ${playerCount}, true,
                          'trackman_webhook', 'trackman_webhook', NOW(), NOW(), NOW())
                  ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
                    last_trackman_sync_at = NOW(),
                    updated_at = NOW()
                  RETURNING id, (xmax = 0) AS was_inserted`);
                return { insertResult, reprocessConflicts };
              });

              for (const conflict of txResult.reprocessConflicts) {
                runReprocessConflictSideEffects(conflict.id, conflict.userEmail, `superseded by Trackman reprocess ${event.trackman_booking_id}`);
              }

              newBooking = txResult.insertResult;
            } else {
              throw insertErr;
            }
          }
          
          if (newBooking.rows.length > 0 && resourceId != null) {
            const bookingId = (newBooking.rows[0] as unknown as NewBookingRow).id;
            
            await db.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = ${bookingId} WHERE id = ${event.id}`);
            
            const reprocessSession = await ensureSessionForBooking({
              bookingId: bookingId as number,
              resourceId,
              sessionDate: requestDate,
              startTime,
              endTime,
              ownerEmail: customerEmail || '',
              ownerName: customerName,
              trackmanBookingId: event.trackman_booking_id as string,
              source: 'trackman_webhook',
              createdBy: 'trackman_reprocess'
            });
            if (reprocessSession.error) {
              logger.error('[Trackman Reprocess] Session creation failed', { extra: { bookingId, trackmanBookingId: event.trackman_booking_id, error: reprocessSession.error } });
            }
            
            results.created++;
            results.details.push({ 
              trackmanId: event.trackman_booking_id, 
              status: 'created', 
              bookingId,
              date: requestDate,
              time: startTime,
              bay: resourceId ? `Bay ${resourceId}` : 'Unknown'
            });
          }
        }
      } catch (eventError: unknown) {
        results.errors++;
        results.details.push({ 
          trackmanId: event.trackman_booking_id, 
          status: 'error', 
          reason: getErrorMessage(eventError) 
        });
        logger.error('[Trackman Backfill] Error processing event', { 
          error: eventError instanceof Error ? eventError : new Error(String(eventError)), 
          trackmanBookingId: event.trackman_booking_id 
        });
      }
    }
    
    logger.info('[Trackman Backfill] Backfill complete', { 
      extra: { 
        total: results.total, 
        linked: results.linked, 
        created: results.created, 
        skipped: results.skipped, 
        errors: results.errors 
      }
    });
    
    broadcastToStaff({
      type: 'bookings_updated',
      action: 'trackman_backfill',
      message: `Backfill complete: ${results.linked} linked, ${results.created} created`
    });
    
    res.json({
      success: true,
      message: `Processed ${results.total} webhook events`,
      results
    });
  } catch (error: unknown) {
    logger.error('[Trackman Backfill] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to run backfill', details: safeErrorDetail(error) });
  }
});

router.post('/api/trackman/replay-webhooks-to-dev', isAdmin, async (req, res) => {
  try {
    const { dev_url, limit = 100 } = req.body;
    
    if (!dev_url) {
      return res.status(400).json({ error: 'dev_url is required' });
    }
    
    try {
      new URL(dev_url);
    } catch (err) {
      logger.debug('Invalid dev_url format for replay', { error: err });
      return res.status(400).json({ error: 'Invalid dev_url format' });
    }
    
    logger.info('[Trackman Replay] Starting replay to dev', { dev_url, limit });
    
    const events = await db.execute(sql`SELECT id, trackman_booking_id, payload, created_at
      FROM trackman_webhook_events
      WHERE payload IS NOT NULL
      ORDER BY created_at ASC
      LIMIT ${limit}`);
    
    if (events.rows.length === 0) {
      return res.json({ success: true, message: 'No webhook events to replay', sent: 0 });
    }
    
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    
    for (const event of events.rows as unknown as UnmatchedWebhookEventRow[]) {
      try {
        const payload = typeof event.payload === 'string' 
          ? JSON.parse(event.payload) 
          : event.payload;
        
        const response = await fetch(dev_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-From': 'production',
            'X-Replay-Event-Id': String(event.id),
            'X-Original-Received-At': event.created_at ? String(event.created_at) : ''
          },
          body: JSON.stringify(payload)
        });
        
        if (response.ok) {
          sent++;
        } else {
          failed++;
          errors.push(`Event ${event.id}: ${response.status} ${response.statusText}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (err: unknown) {
        failed++;
        errors.push(`Event ${event.id}: ${getErrorMessage(err)}`);
      }
    }
    
    logger.info('[Trackman Replay] Completed', { sent, failed, total: events.rows.length });
    
    res.json({
      success: true,
      message: `Replayed ${sent} of ${events.rows.length} webhook events to dev`,
      sent,
      failed,
      total: events.rows.length,
      errors: errors.slice(0, 10)
    });
  } catch (error: unknown) {
    logger.error('[Trackman Replay] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to replay webhooks', details: safeErrorDetail(error) });
  }
});

export default router;
