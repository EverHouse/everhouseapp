import { Router } from 'express';
import { eq, and, or, sql, desc, asc, ne } from 'drizzle-orm';
import { db } from '../db';
import { pool } from '../core/db';
import { bookingRateLimiter } from '../middleware/rateLimiting';
import { resources, users, facilityClosures, notifications, bookingRequests, bookingParticipants, bookingMembers, bookingGuests, staffUsers, availabilityBlocks, trackmanUnmatchedBookings, userLinkedEmails } from '../../shared/schema';
import { isAuthorizedForMemberBooking } from '../core/bookingAuth';
import { isStaffOrAdmin } from '../core/middleware';
import { createCalendarEventOnCalendar, getCalendarIdByName, deleteCalendarEvent, CALENDAR_CONFIG } from '../core/calendar/index';
import { logAndRespond, logger } from '../core/logger';
import { sendPushNotification } from './push';
import { DEFAULT_TIER } from '../../shared/constants/tiers';
import { withRetry } from '../core/retry';
import { checkDailyBookingLimit } from '../core/tierService';
import { bookingEvents } from '../core/bookingEvents';
import { sendNotificationToUser, broadcastAvailabilityUpdate } from '../core/websocket';
import { checkAllConflicts, parseTimeToMinutes } from '../core/bookingValidation';
import { getSessionUser } from '../types/session';
import { notifyMember, notifyAllStaff } from '../core/notificationService';
import { refundGuestPass } from './guestPasses';
import { createPacificDate, formatDateDisplayWithDay, formatTime12Hour } from '../utils/dateUtils';
import { logFromRequest, logMemberAction } from '../core/auditLog';
import { recalculateSessionFees } from '../core/billing/unifiedFeeService';
import { cancelPaymentIntent, getStripeClient } from '../core/stripe';
import { createPrepaymentIntent } from '../core/billing/prepaymentService';
import { ensureSessionForBooking } from '../core/bookingService/sessionManager';
import { getErrorMessage, getErrorCode, getErrorStatusCode } from '../utils/errorUtils';

interface CancellationCascadeResult {
  participantsNotified: number;
  guestPassesRefunded: number;
  bookingMembersRemoved: number;
  prepaymentRefunds: number;
  errors: string[];
}

async function handleCancellationCascade(
  bookingId: number,
  sessionId: number | null,
  ownerEmail: string,
  ownerName: string | null,
  requestDate: string,
  startTime: string,
  resourceName?: string
): Promise<CancellationCascadeResult> {
  const result: CancellationCascadeResult = {
    participantsNotified: 0,
    guestPassesRefunded: 0,
    bookingMembersRemoved: 0,
    prepaymentRefunds: 0,
    errors: []
  };

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const bookingStartTime = createPacificDate(requestDate, startTime);
    const now = new Date();
    const hoursUntilStart = (bookingStartTime.getTime() - now.getTime()) / (1000 * 60 * 60);
    const shouldRefundGuestPasses = hoursUntilStart > 24;

    logger.info('[cancellation-cascade] Starting cascade', {
      extra: {
        bookingId,
        sessionId,
        hoursUntilStart: hoursUntilStart.toFixed(1),
        shouldRefundGuestPasses
      }
    });

    const formattedDate = formatDateDisplayWithDay(requestDate);
    const formattedTime = formatTime12Hour(startTime);
    const displayOwner = ownerName || ownerEmail;
    const displayResource = resourceName || 'simulator';

    const membersToNotify: { email: string; participantId: number }[] = [];
    const guestsToRefund: { displayName: string; participantId: number }[] = [];

    if (sessionId) {
      const participantsResult = await client.query(
        `SELECT id, user_id, guest_id, participant_type, display_name 
         FROM booking_participants WHERE session_id = $1`,
        [sessionId]
      );
      const participants = participantsResult.rows;

      for (const participant of participants) {
        if (participant.participant_type === 'member' && participant.user_id) {
          const userResult = await client.query(
            `SELECT email FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`,
            [participant.user_id]
          );
          if (userResult.rows.length > 0) {
            membersToNotify.push({
              email: userResult.rows[0].email,
              participantId: participant.id
            });
          }
        }

        if (participant.participant_type === 'guest' && shouldRefundGuestPasses) {
          guestsToRefund.push({
            displayName: participant.display_name || 'Guest',
            participantId: participant.id
          });
        }
      }

      await client.query(
        `UPDATE booking_participants SET invite_status = 'cancelled' WHERE session_id = $1`,
        [sessionId]
      );
      
      logger.info('[cancellation-cascade] Updated participant invite statuses', {
        extra: { bookingId, sessionId, count: participants.length }
      });
    }

    const deleteResult = await client.query(
      `DELETE FROM booking_members WHERE booking_id = $1 RETURNING id`,
      [bookingId]
    );
    result.bookingMembersRemoved = deleteResult.rows.length;
    
    if (deleteResult.rows.length > 0) {
      logger.info('[cancellation-cascade] Removed booking members', {
        extra: { bookingId, count: deleteResult.rows.length }
      });
    }

    // Cancel pending payment intents for this booking
    const pendingIntents = await client.query(
      `SELECT stripe_payment_intent_id 
       FROM stripe_payment_intents 
       WHERE booking_id = $1 AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')`,
      [bookingId]
    );

    await client.query('COMMIT');
    
    // Cancel payment intents after commit (external API call)
    for (const row of pendingIntents.rows) {
      try {
        await cancelPaymentIntent(row.stripe_payment_intent_id);
        logger.info('[cancellation-cascade] Cancelled payment intent', {
          extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
        });
      } catch (cancelErr: unknown) {
        const errorMsg = `Failed to cancel payment intent ${row.stripe_payment_intent_id}: ${getErrorMessage(cancelErr)}`;
        result.errors.push(errorMsg);
        logger.warn('[cancellation-cascade] ' + errorMsg);
      }
    }

    // Refund succeeded prepayment intents
    const succeededIntents = await pool.query(
      `SELECT spi.stripe_payment_intent_id, spi.amount_cents, spi.stripe_customer_id, spi.user_id
       FROM stripe_payment_intents spi
       WHERE spi.booking_id = $1 AND spi.purpose = 'prepayment' AND spi.status = 'succeeded'`,
      [bookingId]
    );

    for (const row of succeededIntents.rows) {
      try {
        // Atomically claim this intent for refunding (prevents duplicates)
        const claimResult = await pool.query(
          `UPDATE stripe_payment_intents 
           SET status = 'refunding', updated_at = NOW() 
           WHERE stripe_payment_intent_id = $1 AND status = 'succeeded'
           RETURNING stripe_payment_intent_id`,
          [row.stripe_payment_intent_id]
        );
        
        if (claimResult.rowCount === 0) {
          // Already being processed or already refunded, skip
          logger.info('[cancellation-cascade] Prepayment already claimed or refunded, skipping', {
            extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
          });
          continue;
        }
        
        const stripe = await getStripeClient();
        
        // Handle credit-based prepayments (balance-xxx IDs) vs card-based (pi_xxx IDs)
        if (row.stripe_payment_intent_id.startsWith('balance-')) {
          // Credit-based payment: add credit back to customer's balance
          if (row.stripe_customer_id) {
            const balanceTransaction = await stripe.customers.createBalanceTransaction(
              row.stripe_customer_id,
              {
                amount: -row.amount_cents, // Negative = add credit
                currency: 'usd',
                description: `Refund for cancelled booking #${bookingId}`,
              }
            );
            
            await pool.query(
              `UPDATE stripe_payment_intents 
               SET status = 'refunded', updated_at = NOW() 
               WHERE stripe_payment_intent_id = $1`,
              [row.stripe_payment_intent_id]
            );
            
            result.prepaymentRefunds++;
            logger.info('[cancellation-cascade] Credited balance for cancelled prepayment', {
              extra: { 
                bookingId, 
                paymentIntentId: row.stripe_payment_intent_id,
                balanceTransactionId: balanceTransaction.id,
                amountCents: row.amount_cents
              }
            });
          } else {
            logger.warn('[cancellation-cascade] Cannot refund balance - no customer ID', {
              extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
            });
          }
        } else {
          // Card-based payment: refund via Stripe
          const paymentIntent = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
          
          if (paymentIntent.status === 'succeeded' && paymentIntent.latest_charge) {
            // Use idempotency key to prevent Stripe-side duplicates
            const idempotencyKey = `refund-booking-${bookingId}-${row.stripe_payment_intent_id}`;
            
            const refund = await stripe.refunds.create({
              charge: typeof paymentIntent.latest_charge === 'string' 
                ? paymentIntent.latest_charge 
                : paymentIntent.latest_charge.id,
              reason: 'requested_by_customer',
              metadata: {
                reason: 'booking_cancellation',
                bookingId: bookingId.toString()
              }
            }, {
              idempotencyKey
            });
            
            // Update local record to refunded
            await pool.query(
              `UPDATE stripe_payment_intents 
               SET status = 'refunded', updated_at = NOW() 
               WHERE stripe_payment_intent_id = $1`,
              [row.stripe_payment_intent_id]
            );
            
            result.prepaymentRefunds++;
            logger.info('[cancellation-cascade] Refunded prepayment', {
              extra: { 
                bookingId, 
                paymentIntentId: row.stripe_payment_intent_id,
                refundId: refund.id,
                amountCents: row.amount_cents
              }
            });
          } else {
            // Payment intent not in expected state, revert claim
            await pool.query(
              `UPDATE stripe_payment_intents 
               SET status = 'succeeded', updated_at = NOW() 
               WHERE stripe_payment_intent_id = $1`,
              [row.stripe_payment_intent_id]
            );
          }
        }
      } catch (refundErr: unknown) {
        // On error, revert status if it was claimed
        await pool.query(
          `UPDATE stripe_payment_intents 
           SET status = 'succeeded', updated_at = NOW() 
           WHERE stripe_payment_intent_id = $1 AND status = 'refunding'`,
          [row.stripe_payment_intent_id]
        ).catch(() => {}); // Ignore revert errors
        
        const errorMsg = `Failed to refund prepayment ${row.stripe_payment_intent_id}: ${getErrorMessage(refundErr)}`;
        result.errors.push(errorMsg);
        logger.warn('[cancellation-cascade] ' + errorMsg);
      }
    }

    for (const member of membersToNotify) {
      try {
        await notifyMember({
          userEmail: member.email,
          title: 'Booking Cancelled',
          message: `${displayOwner}'s ${displayResource} booking on ${formattedDate} at ${formattedTime} has been cancelled.`,
          type: 'booking_cancelled',
          relatedId: bookingId,
          relatedType: 'booking_request'
        });
        result.participantsNotified++;
        logger.info('[cancellation-cascade] Notified member participant', {
          extra: { bookingId, memberEmail: member.email, participantId: member.participantId }
        });
      } catch (notifyError: unknown) {
        const errorMsg = `Failed to notify participant ${member.email}: ${(notifyError as Error).message}`;
        result.errors.push(errorMsg);
        logger.warn('[cancellation-cascade] ' + errorMsg, { error: notifyError as Error });
      }
    }

    const refundedGuests = new Set<number>();
    for (const guest of guestsToRefund) {
      if (refundedGuests.has(guest.participantId)) {
        continue;
      }
      try {
        const refundResult = await refundGuestPass(
          ownerEmail,
          guest.displayName,
          false
        );
        
        if (refundResult.success) {
          result.guestPassesRefunded++;
          refundedGuests.add(guest.participantId);
          logger.info('[cancellation-cascade] Guest pass refunded', {
            extra: {
              bookingId,
              ownerEmail,
              guestName: guest.displayName,
              remainingPasses: refundResult.remaining
            }
          });
        } else {
          result.errors.push(`Failed to refund guest pass for ${guest.displayName}: ${refundResult.error}`);
        }
      } catch (refundError: unknown) {
        const errorMsg = `Failed to refund guest pass for ${guest.displayName}: ${(refundError as Error).message}`;
        result.errors.push(errorMsg);
        logger.warn('[cancellation-cascade] ' + errorMsg, { error: refundError as Error });
      }
    }

    if (result.guestPassesRefunded > 0) {
      try {
        await notifyMember({
          userEmail: ownerEmail,
          title: 'Guest Passes Refunded',
          message: `${result.guestPassesRefunded} guest pass${result.guestPassesRefunded > 1 ? 'es have' : ' has'} been refunded due to your booking cancellation (cancelled more than 24 hours in advance).`,
          type: 'guest_pass',
          relatedId: bookingId,
          relatedType: 'booking_request'
        });
      } catch (notifyError: unknown) {
        logger.warn('[cancellation-cascade] Failed to notify owner about guest pass refund', { error: notifyError as Error });
      }
    }

    logger.info('[cancellation-cascade] Cascade complete', {
      extra: {
        bookingId,
        ...result,
        errorCount: result.errors.length
      }
    });

  } catch (error: unknown) {
    await client.query('ROLLBACK');
    const errorMsg = `Cascade error: ${(error as Error).message}`;
    result.errors.push(errorMsg);
    logger.error('[cancellation-cascade] Fatal error during cascade', { error: error as Error });
  } finally {
    client.release();
  }

  return result;
}

const router = Router();

router.get('/api/resources', async (req, res) => {
  try {
    const result = await withRetry(() =>
      db.select()
        .from(resources)
        .orderBy(asc(resources.type), asc(resources.name))
    );
    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch resources', error, 'RESOURCES_FETCH_ERROR');
  }
});

router.get('/api/bookings/check-existing', async (req, res) => {
  try {
    const userEmail = getSessionUser(req)?.email?.toLowerCase();
    if (!userEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { date, resource_type } = req.query;
    
    if (!date || typeof date !== 'string') {
      return res.status(400).json({ error: 'Date parameter required' });
    }
    
    const resourceTypeFilter = resource_type && typeof resource_type === 'string' ? resource_type : 'simulator';
    
    const existingBookings = await db.select({
      id: bookingRequests.id,
      resourceId: bookingRequests.resourceId,
      resourceName: resources.name,
      resourceType: resources.type,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      endTime: bookingRequests.endTime,
      status: bookingRequests.status,
      reviewedBy: bookingRequests.reviewedBy
    })
      .from(bookingRequests)
      .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(and(
        eq(bookingRequests.userEmail, userEmail),
        sql`${bookingRequests.requestDate} = ${date}`,
        or(
          eq(resources.type, resourceTypeFilter),
          sql`${resources.type} IS NULL`
        ),
        or(
          eq(bookingRequests.status, 'confirmed'),
          eq(bookingRequests.status, 'pending'),
          eq(bookingRequests.status, 'pending_approval'),
          eq(bookingRequests.status, 'approved')
        )
      ));
    
    const hasExisting = existingBookings.length > 0;
    const staffCreated = existingBookings.some(b => b.reviewedBy !== null && b.status === 'approved');
    
    res.json({
      hasExisting,
      bookings: existingBookings.map(b => ({
        id: b.id,
        resourceName: b.resourceName,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status,
        isStaffCreated: b.reviewedBy !== null && b.status === 'approved'
      })),
      staffCreated
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to check existing bookings', error, 'CHECK_EXISTING_ERROR');
  }
});

router.get('/api/bookings/check-existing-staff', isStaffOrAdmin, async (req, res) => {
  try {
    const { member_email, date, resource_type } = req.query;
    
    if (!member_email || !date || !resource_type) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const existingBookings = await db.select({
      id: bookingRequests.id,
      resourceType: resources.type
    })
      .from(bookingRequests)
      .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(and(
        eq(bookingRequests.userEmail, (member_email as string).toLowerCase()),
        sql`${bookingRequests.requestDate} = ${date}`,
        eq(resources.type, resource_type as string),
        or(
          eq(bookingRequests.status, 'confirmed'),
          eq(bookingRequests.status, 'pending'),
          eq(bookingRequests.status, 'pending_approval'),
          eq(bookingRequests.status, 'approved')
        )
      ));
    
    res.json({ 
      hasExisting: existingBookings.length > 0,
      count: existingBookings.length
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to check existing bookings', error, 'CHECK_EXISTING_ERROR');
  }
});

router.get('/api/bookings', async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { user_email: rawEmail, date, resource_id, status } = req.query;
    
    const user_email = rawEmail ? decodeURIComponent(rawEmail as string) : null;
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    
    if (user_email && user_email.toLowerCase() !== sessionEmail) {
      const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../replit_integrations/auth/replitAuth');
      const isAdmin = await isAdminEmail(sessionEmail);
      if (!isAdmin) {
        const pool = getAuthPool();
        let isStaff = false;
        if (pool) {
          try {
            const result = await queryWithRetry(
              pool,
              'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
              [sessionEmail]
            );
            isStaff = result.rows.length > 0;
          } catch (e: unknown) {
            logger.warn('[resources] Staff check query failed:', e);
          }
        }
        if (!isStaff) {
          return res.status(403).json({ error: 'You can only view your own bookings' });
        }
      }
    }
    
    const { include_all, include_archived } = req.query;
    
    let conditions: any[] = [];
    
    // Filter archived records by default unless include_archived=true
    if (include_archived !== 'true') {
      conditions.push(sql`${bookingRequests.archivedAt} IS NULL`);
    }
    
    if (status) {
      conditions.push(eq(bookingRequests.status, status as string));
    } else if (include_all === 'true') {
    } else {
      conditions.push(or(
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'pending_approval'),
        eq(bookingRequests.status, 'pending'),
        eq(bookingRequests.status, 'attended')
      ));
    }
    
    const userEmail = user_email?.toLowerCase();
    if (userEmail) {
      // Include bookings where user is primary OR linked as additional player
      conditions.push(or(
        eq(bookingRequests.userEmail, userEmail),
        sql`${bookingRequests.id} IN (SELECT booking_id FROM booking_members WHERE LOWER(user_email) = ${userEmail})`
      ));
    }
    if (date) {
      conditions.push(sql`${bookingRequests.requestDate} = ${date}`);
    }
    if (resource_id) {
      conditions.push(eq(bookingRequests.resourceId, parseInt(resource_id as string)));
    }
    
    const result = await withRetry(() =>
      db.select({
        id: bookingRequests.id,
        resource_id: bookingRequests.resourceId,
        user_email: bookingRequests.userEmail,
        booking_date: bookingRequests.requestDate,
        start_time: bookingRequests.startTime,
        end_time: bookingRequests.endTime,
        status: bookingRequests.status,
        notes: bookingRequests.notes,
        created_at: bookingRequests.createdAt,
        resource_name: resources.name,
        resource_type: resources.type,
        declared_player_count: bookingRequests.declaredPlayerCount
      })
        .from(bookingRequests)
        .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
        .where(and(...conditions))
        .orderBy(asc(bookingRequests.requestDate), asc(bookingRequests.startTime))
    );
    
    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch bookings', error, 'BOOKINGS_FETCH_ERROR');
  }
});

router.get('/api/pending-bookings', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await withRetry(() =>
      db.select({
        id: bookingRequests.id,
        resource_id: bookingRequests.resourceId,
        user_email: bookingRequests.userEmail,
        booking_date: bookingRequests.requestDate,
        start_time: bookingRequests.startTime,
        end_time: bookingRequests.endTime,
        status: bookingRequests.status,
        notes: bookingRequests.notes,
        created_at: bookingRequests.createdAt,
        resource_name: resources.name,
        resource_type: resources.type,
        first_name: users.firstName,
        last_name: users.lastName,
      })
        .from(bookingRequests)
        .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
        .leftJoin(users, eq(bookingRequests.userEmail, users.email))
        .where(and(
          eq(bookingRequests.status, 'pending_approval'),
          or(
            eq(bookingRequests.isUnmatched, false),
            sql`${bookingRequests.isUnmatched} IS NULL`
          )
        ))
        .orderBy(desc(bookingRequests.createdAt))
    );
    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch pending bookings', error, 'PENDING_BOOKINGS_ERROR');
  }
});

router.put('/api/bookings/:id/approve', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    
    const result = await db.transaction(async (tx) => {
      const [booking] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
      
      if (!booking) {
        throw { statusCode: 404, error: 'Booking not found' };
      }
      
      // Check all conflicts: closures, availability blocks, and existing bookings
      const conflictCheck = await checkAllConflicts(
        booking.resourceId!,
        booking.requestDate,
        booking.startTime,
        booking.endTime,
        bookingId  // Exclude this booking from the check
      );
      
      if (conflictCheck.hasConflict) {
        if (conflictCheck.conflictType === 'closure') {
          throw { 
            statusCode: 409, 
            error: 'Cannot approve booking during closure',
            message: `This time slot conflicts with "${conflictCheck.conflictTitle}". Please decline this request or wait until the closure ends.`
          };
        } else if (conflictCheck.conflictType === 'availability_block') {
          throw { 
            statusCode: 409, 
            error: 'Cannot approve booking during event block',
            message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}. Please decline this request or reschedule.`
          };
        }
        // Note: booking conflicts handled by the existing query below for more detailed messaging
      }
      
      const existingConflicts = await tx.select()
        .from(bookingRequests)
        .where(and(
          eq(bookingRequests.resourceId, booking.resourceId!),
          sql`${bookingRequests.requestDate} = ${booking.requestDate}`,
          or(
            eq(bookingRequests.status, 'confirmed'),
            eq(bookingRequests.status, 'approved'),
            eq(bookingRequests.status, 'pending_approval')
          ),
          ne(bookingRequests.id, bookingId),
          or(
            and(
              sql`${bookingRequests.startTime} < ${booking.endTime}`,
              sql`${bookingRequests.endTime} > ${booking.startTime}`
            )
          )
        ));
      
      if (existingConflicts.length > 0) {
        throw { 
          statusCode: 409, 
          error: 'Time slot already booked',
          message: 'Another booking has already been approved for this time slot. Please decline this request or suggest an alternative time.'
        };
      }
      
      const [updated] = await tx.update(bookingRequests)
        .set({ status: 'confirmed' })
        .where(eq(bookingRequests.id, bookingId))
        .returning();
      
      // Ensure session exists for confirmed booking
      if (updated.resourceId) {
        try {
          const dateStr = typeof updated.requestDate === 'string'
            ? updated.requestDate
            : (updated.requestDate as any) instanceof Date
              ? (updated.requestDate as any).toISOString().split('T')[0]
              : '';
          await ensureSessionForBooking({
            bookingId: updated.id,
            resourceId: updated.resourceId,
            sessionDate: dateStr,
            startTime: updated.startTime || '',
            endTime: updated.endTime || '',
            ownerEmail: updated.userEmail || '',
            ownerName: updated.userName || undefined,
            trackmanBookingId: updated.trackmanBookingId || undefined,
            source: 'member_request',
            createdBy: 'resource_confirmation'
          });
        } catch (sessionErr: unknown) {
          console.error('[Resource Confirmation] Failed to ensure session:', sessionErr);
        }
      }

      return updated;
    });
    
    // Broadcast availability update for real-time availability refresh
    broadcastAvailabilityUpdate({
      resourceId: result.resourceId || undefined,
      date: result.requestDate,
      action: 'booked'
    });
    
    // Notify member that their booking was approved
    sendNotificationToUser(result.userEmail, {
      type: 'booking_update',
      title: 'Booking Confirmed',
      message: `Your booking for ${result.requestDate} at ${result.startTime?.substring(0, 5) || ''} has been approved.`,
      data: { bookingId, status: 'confirmed' }
    });
    
    logFromRequest(req, 'approve_booking', 'booking', id as string, result.userEmail, {
      bay: result.resourceId,
      time: result.startTime
    });
    
    res.json(result);
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ 
        error: (error as any).error, 
        message: getErrorMessage(error) 
      });
    }
    logAndRespond(req, res, 500, 'Failed to approve booking', error, 'APPROVE_BOOKING_ERROR');
  }
});

router.put('/api/bookings/:id/decline', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
      
      if (!existing) {
        throw { statusCode: 404, error: 'Booking not found' };
      }
      
      const [updated] = await tx.update(bookingRequests)
        .set({ 
          status: 'declined',
          trackmanExternalId: null  // Clear so ID can be reused
        })
        .where(eq(bookingRequests.id, bookingId))
        .returning();
      
      return updated;
    });
    
    // Clean up any corresponding Trackman bay slot cache entry
    if (result.resourceId && result.requestDate && result.startTime) {
      try {
        await pool.query(
          `DELETE FROM trackman_bay_slots 
           WHERE resource_id = $1 AND slot_date = $2 AND start_time = $3`,
          [result.resourceId, result.requestDate, result.startTime]
        );
      } catch (err: unknown) {
        logger.warn('[Staff Decline] Failed to clean up trackman_bay_slots', { 
          bookingId, 
          resourceId: result.resourceId,
          error: (err as Error).message 
        });
      }
    }
    
    logFromRequest(req, 'decline_booking', 'booking', id as string, result.userEmail, {
      member_email: result.userEmail,
      reason: req.body.reason || 'Not specified'
    });
    
    sendNotificationToUser(result.userEmail, {
      type: 'booking_update',
      title: 'Booking Declined',
      message: 'Your booking request has been declined.',
      data: { bookingId, status: 'declined' }
    });
    
    res.json(result);
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as any).error });
    }
    logAndRespond(req, res, 500, 'Failed to decline booking', error, 'DECLINE_BOOKING_ERROR');
  }
});

router.post('/api/bookings/:id/assign-member', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    const { member_email, member_name, member_id } = req.body;
    
    if (!member_email || !member_name) {
      return res.status(400).json({ error: 'Missing required fields: member_email, member_name' });
    }
    
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
      
      if (!existing) {
        throw { statusCode: 404, error: 'Booking not found' };
      }
      
      if (!existing.isUnmatched) {
        throw { statusCode: 400, error: 'Booking is not an unmatched booking' };
      }
      
      const [updated] = await tx.update(bookingRequests)
        .set({
          userEmail: member_email.toLowerCase(),
          userName: member_name,
          userId: member_id || null,
          isUnmatched: false,
          status: 'approved',
          staffNotes: sql`COALESCE(${bookingRequests.staffNotes}, '') || ' [Member assigned by staff: ' || ${member_name} || ']'`,
          updatedAt: new Date()
        })
        .where(eq(bookingRequests.id, bookingId))
        .returning();
      
      return updated;
    });
    
    const { broadcastToStaff } = await import('../core/websocket');
    broadcastToStaff({
      type: 'booking_updated',
      bookingId,
      action: 'member_assigned',
      memberEmail: member_email,
      memberName: member_name
    } as any);
    
    const formattedDate = result.requestDate ? new Date(result.requestDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    const formattedTime = result.startTime || '';
    
    if (member_email) {
      await pool.query(
        `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          member_email.toLowerCase(),
          'Booking Confirmed',
          `Your simulator booking for ${formattedDate} at ${formattedTime} has been confirmed.`,
          'booking',
          'booking'
        ]
      );
    }
    
    sendNotificationToUser(member_email, {
      type: 'booking_confirmed',
      title: 'Booking Confirmed',
      message: `Your simulator booking for ${formattedDate} at ${formattedTime} has been confirmed.`,
      data: { bookingId },
    });
    
    logFromRequest(req, 'assign_member_to_booking', 'booking', id as string, member_email, {
      member_email,
      member_name,
      was_unmatched: true
    });
    
    res.json(result);
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as any).error });
    }
    logAndRespond(req, res, 500, 'Failed to assign member to booking', error, 'ASSIGN_MEMBER_ERROR');
  }
});

router.post('/api/bookings/link-trackman-to-member', isStaffOrAdmin, async (req, res) => {
  try {
    const { trackman_booking_id, owner, additional_players, member_email, member_name, member_id, rememberEmail, originalEmail } = req.body;
    
    if (!trackman_booking_id) {
      return res.status(400).json({ error: 'Missing required field: trackman_booking_id' });
    }
    
    const ownerEmail = owner?.email || member_email;
    const ownerName = owner?.name || member_name;
    const ownerId = owner?.member_id || member_id;
    
    if (!ownerEmail || !ownerName) {
      return res.status(400).json({ error: 'Missing required owner fields: email, name' });
    }
    
    const additionalPlayers: Array<{ type: 'member' | 'guest_placeholder'; member_id?: string; email?: string; name?: string; guest_name?: string }> = additional_players || [];
    const totalPlayerCount = 1 + additionalPlayers.filter(p => p.type === 'member' || p.type === 'guest_placeholder').length;
    const guestCount = additionalPlayers.filter(p => p.type === 'guest_placeholder').length;
    
    // Resolve email aliases before instructor check
    // Check user_linked_emails table and users.manuallyLinkedEmails for alias mappings
    let resolvedOwnerEmail = ownerEmail.toLowerCase().trim();
    
    // Check user_linked_emails table
    const [linkedEmailRecord] = await db.select({ primaryEmail: userLinkedEmails.primaryEmail })
      .from(userLinkedEmails)
      .where(sql`LOWER(${userLinkedEmails.linkedEmail}) = ${resolvedOwnerEmail}`);
    
    if (linkedEmailRecord?.primaryEmail) {
      resolvedOwnerEmail = linkedEmailRecord.primaryEmail.toLowerCase();
      logger.info('[link-trackman-to-member] Resolved email alias via user_linked_emails', {
        extra: { original: ownerEmail, resolved: resolvedOwnerEmail }
      });
    }
    
    // Also check manuallyLinkedEmails in users table
    if (resolvedOwnerEmail === ownerEmail.toLowerCase().trim()) {
      const usersWithAlias = await db.select({ email: users.email, manuallyLinkedEmails: users.manuallyLinkedEmails })
        .from(users)
        .where(sql`${users.manuallyLinkedEmails} IS NOT NULL`);
      
      for (const user of usersWithAlias) {
        if (user.manuallyLinkedEmails && user.email) {
          const linkedList = typeof user.manuallyLinkedEmails === 'string' 
            ? user.manuallyLinkedEmails.split(',').map(e => e.trim().toLowerCase())
            : [];
          if (linkedList.includes(ownerEmail.toLowerCase().trim())) {
            resolvedOwnerEmail = user.email.toLowerCase();
            logger.info('[link-trackman-to-member] Resolved email alias via manuallyLinkedEmails', {
              extra: { original: ownerEmail, resolved: resolvedOwnerEmail }
            });
            break;
          }
        }
      }
    }
    
    // Check if the owner is a golf instructor (using resolved email)
    const instructorCheck = await db.select({
      id: staffUsers.id,
      email: staffUsers.email,
      role: staffUsers.role,
      isActive: staffUsers.isActive,
      name: staffUsers.name
    })
      .from(staffUsers)
      .where(and(
        sql`LOWER(${staffUsers.email}) = ${resolvedOwnerEmail}`,
        eq(staffUsers.role, 'golf_instructor'),
        eq(staffUsers.isActive, true)
      ))
      .limit(1);
    
    const isInstructor = instructorCheck.length > 0;
    
    // If instructor, convert to availability block instead of member booking
    if (isInstructor) {
      logger.info('[link-trackman-to-member] Detected golf instructor, converting to availability block', {
        extra: { trackman_booking_id, ownerEmail, ownerName }
      });
      
      // Get the booking data from either existing booking or webhook logs
      let bookingData: { resourceId: number | null; requestDate: string; startTime: string; endTime: string | null } | null = null;
      
      // Check existing booking in booking_requests
      const [existingBooking] = await db.select({
        id: bookingRequests.id,
        resourceId: bookingRequests.resourceId,
        requestDate: bookingRequests.requestDate,
        startTime: bookingRequests.startTime,
        endTime: bookingRequests.endTime
      })
        .from(bookingRequests)
        .where(eq(bookingRequests.trackmanBookingId, trackman_booking_id));
      
      if (existingBooking) {
        bookingData = {
          resourceId: existingBooking.resourceId,
          requestDate: existingBooking.requestDate,
          startTime: existingBooking.startTime,
          endTime: existingBooking.endTime
        };
      } else {
        // Check unmatched bookings
        const [unmatchedBooking] = await db.select({
          id: trackmanUnmatchedBookings.id,
          bayNumber: trackmanUnmatchedBookings.bayNumber,
          bookingDate: trackmanUnmatchedBookings.bookingDate,
          startTime: trackmanUnmatchedBookings.startTime,
          endTime: trackmanUnmatchedBookings.endTime
        })
          .from(trackmanUnmatchedBookings)
          .where(eq(trackmanUnmatchedBookings.trackmanBookingId, trackman_booking_id));
        
        if (unmatchedBooking) {
          let resourceId: number | null = null;
          if (unmatchedBooking.bayNumber) {
            const [resource] = await db.select({ id: resources.id })
              .from(resources)
              .where(eq(resources.name, `Bay ${unmatchedBooking.bayNumber}`));
            resourceId = resource?.id ?? null;
          }
          bookingData = {
            resourceId,
            requestDate: unmatchedBooking.bookingDate,
            startTime: unmatchedBooking.startTime,
            endTime: unmatchedBooking.endTime
          };
        } else {
          // Try webhook logs
          const webhookResult = await pool.query(
            `SELECT payload FROM trackman_webhook_events WHERE trackman_booking_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [trackman_booking_id]
          );
          
          if (webhookResult.rows.length > 0) {
            const payload = typeof webhookResult.rows[0].payload === 'string' 
              ? JSON.parse(webhookResult.rows[0].payload) 
              : webhookResult.rows[0].payload;
            const data = payload?.data || payload?.booking || {};
            
            const startStr = data?.start;
            const endStr = data?.end;
            const bayRef = data?.bay?.ref;
            
            if (startStr && endStr) {
              const startDate = new Date(startStr.includes('T') ? startStr : startStr.replace(' ', 'T') + 'Z');
              const endDate = new Date(endStr.includes('T') ? endStr : endStr.replace(' ', 'T') + 'Z');
              
              const requestDate = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
              const startTime = startDate.toLocaleTimeString('en-US', { 
                hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
              }) + ':00';
              const endTime = endDate.toLocaleTimeString('en-US', { 
                hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
              }) + ':00';
              
              let resourceId = 1;
              if (bayRef) {
                const bayNum = parseInt(bayRef);
                if (bayNum >= 1 && bayNum <= 4) resourceId = bayNum;
              }
              
              bookingData = { resourceId, requestDate, startTime, endTime };
            }
          }
        }
      }
      
      if (!bookingData || !bookingData.resourceId || !bookingData.requestDate || !bookingData.startTime) {
        return res.status(400).json({ error: 'Cannot find booking data to create availability block' });
      }
      
      // Create facility closure and availability block (same pattern as trackmanImport.ts)
      const [closure] = await db.insert(facilityClosures).values({
        title: `Lesson: ${ownerName}`,
        resourceId: bookingData.resourceId,
        startDate: bookingData.requestDate,
        endDate: bookingData.requestDate,
        startTime: bookingData.startTime,
        endTime: bookingData.endTime || bookingData.startTime,
        reason: `Lesson: ${ownerName}`,
        noticeType: 'private_event',
        isActive: true,
        createdBy: getSessionUser(req)?.email || 'staff_link'
      } as any).returning();
      
      await db.insert(availabilityBlocks).values({
        closureId: closure.id,
        resourceId: bookingData.resourceId,
        blockDate: bookingData.requestDate,
        startTime: bookingData.startTime,
        endTime: bookingData.endTime || bookingData.startTime,
        blockType: 'blocked',
        notes: `Lesson - ${ownerName}`,
        createdBy: getSessionUser(req)?.email || 'staff_link'
      });
      
      // Delete the existing booking if it exists
      if (existingBooking) {
        await db.delete(bookingRequests).where(eq(bookingRequests.id, existingBooking.id));
        logger.info('[link-trackman-to-member] Deleted existing booking after converting to availability block', {
          extra: { bookingId: existingBooking.id, trackman_booking_id }
        });
      }
      
      // Delete from unmatched bookings table if exists
      await db.delete(trackmanUnmatchedBookings)
        .where(eq(trackmanUnmatchedBookings.trackmanBookingId, trackman_booking_id));
      
      // Update webhook event to mark as processed (no booking, converted to availability block)
      await pool.query(
        `UPDATE trackman_webhook_events SET matched_booking_id = NULL, processed_at = NOW() WHERE trackman_booking_id = $1`,
        [trackman_booking_id]
      );
      
      const { broadcastToStaff } = await import('../core/websocket');
      broadcastToStaff({
        type: 'availability_block_created',
        closureId: closure.id,
        instructorEmail: ownerEmail,
        instructorName: ownerName
      } as any);
      
      logFromRequest(req, 'create_closure' as any, 'closure', closure.id.toString(), ownerName, {
        trackman_booking_id,
        instructor_email: ownerEmail,
        instructor_name: ownerName,
        resource_id: bookingData.resourceId,
        date: bookingData.requestDate,
        start_time: bookingData.startTime,
        end_time: bookingData.endTime
      });
      
      return res.json({
        success: true,
        convertedToAvailabilityBlock: true,
        closureId: closure.id,
        instructorName: ownerName,
        message: `Converted to lesson block for instructor ${ownerName}`
      });
    }
    
    const result = await db.transaction(async (tx) => {
      const [existingBooking] = await tx.select()
        .from(bookingRequests)
        .where(eq(bookingRequests.trackmanBookingId, trackman_booking_id));
      
      let booking;
      let created = false;
      
      if (existingBooking) {
        const staffNoteSuffix = ` [Linked to member via staff: ${ownerName} with ${totalPlayerCount} players]`;
        const newStaffNotes = (existingBooking.staffNotes || '') + staffNoteSuffix;
        const [updated] = await tx.update(bookingRequests)
          .set({
            userEmail: ownerEmail.toLowerCase(),
            userName: ownerName,
            userId: ownerId ? String(ownerId) : null,
            isUnmatched: false,
            status: 'approved',
            declaredPlayerCount: totalPlayerCount,
            guestCount: guestCount,
            staffNotes: newStaffNotes,
            updatedAt: new Date()
          })
          .where(eq(bookingRequests.id, existingBooking.id))
          .returning();
        booking = updated;
      } else {
        const webhookResult = await tx.execute(sql`
          SELECT payload, trackman_booking_id 
          FROM trackman_webhook_events 
          WHERE trackman_booking_id = ${trackman_booking_id}
          ORDER BY created_at DESC
          LIMIT 1
        `);
        const webhookLog = (webhookResult as any).rows?.[0] ?? (webhookResult as any)[0];
        
        if (!webhookLog) {
          throw { statusCode: 404, error: 'Trackman booking not found in webhook logs' };
        }
        
        const payload = typeof webhookLog.payload === 'string' 
          ? JSON.parse(webhookLog.payload) 
          : webhookLog.payload;
        const bookingData = payload?.data || payload?.booking || {};
        
        const startStr = bookingData?.start;
        const endStr = bookingData?.end;
        const bayRef = bookingData?.bay?.ref;
        
        if (!startStr || !endStr) {
          throw { statusCode: 400, error: 'Cannot extract booking time from webhook data' };
        }
        
        const startDate = new Date(startStr.includes('T') ? startStr : startStr.replace(' ', 'T') + 'Z');
        const endDate = new Date(endStr.includes('T') ? endStr : endStr.replace(' ', 'T') + 'Z');
        
        const requestDate = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const startTime = startDate.toLocaleTimeString('en-US', { 
          hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
        }) + ':00';
        const endTime = endDate.toLocaleTimeString('en-US', { 
          hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' 
        }) + ':00';
        
        let resourceId = 1;
        if (bayRef) {
          const bayNum = parseInt(bayRef);
          if (bayNum >= 1 && bayNum <= 4) {
            resourceId = bayNum;
          }
        }
        
        const [newBooking] = await tx.insert(bookingRequests)
          .values({
            userEmail: ownerEmail.toLowerCase(),
            userName: ownerName,
            userId: ownerId ? String(ownerId) : null,
            resourceId,
            requestDate,
            startTime,
            endTime,
            status: 'approved',
            trackmanBookingId: trackman_booking_id,
            isUnmatched: false,
            declaredPlayerCount: totalPlayerCount,
            guestCount: guestCount,
            staffNotes: `[Linked from Trackman webhook by staff: ${ownerName} with ${totalPlayerCount} players]`,
            createdAt: new Date(),
            updatedAt: new Date()
          } as any)
          .returning();
        booking = newBooking;
        created = true;
        
        await tx.execute(sql`
          UPDATE trackman_webhook_events 
          SET matched_booking_id = ${booking.id}
          WHERE trackman_booking_id = ${trackman_booking_id}
        `);
      }
      
      await tx.delete(bookingMembers).where(eq(bookingMembers.bookingId, booking.id));
      await tx.delete(bookingGuests).where(eq(bookingGuests.bookingId, booking.id));
      
      await tx.insert(bookingMembers).values({
        bookingId: booking.id,
        userEmail: ownerEmail.toLowerCase(),
        slotNumber: 1,
        isPrimary: true,
        trackmanBookingId: trackman_booking_id,
        linkedAt: new Date(),
        linkedBy: getSessionUser(req)?.email || 'staff'
      });
      
      let slotNumber = 2;
      for (const player of additionalPlayers) {
        if (player.type === 'member') {
          await tx.insert(bookingMembers).values({
            bookingId: booking.id,
            userEmail: player.email?.toLowerCase(),
            slotNumber,
            isPrimary: false,
            trackmanBookingId: trackman_booking_id,
            linkedAt: new Date(),
            linkedBy: getSessionUser(req)?.email || 'staff'
          });
        } else if (player.type === 'guest_placeholder') {
          await tx.insert(bookingGuests).values({
            bookingId: booking.id,
            guestName: player.guest_name || 'Guest (info pending)',
            slotNumber,
            trackmanBookingId: trackman_booking_id
          });
        }
        slotNumber++;
      }
      
      const sessionId = existingBooking?.sessionId || null;
      return { booking, created, sessionId };
    });
    
    if (result.sessionId) {
      try {
        await recalculateSessionFees(result.sessionId, 'approval' as any);
        logger.info('[link-trackman-to-member] Recalculated fees after member assignment', {
          extra: { bookingId: result.booking.id, sessionId: result.sessionId, newOwner: ownerEmail }
        });
      } catch (recalcErr: unknown) {
        logger.warn('[link-trackman-to-member] Failed to recalculate fees after assignment', {
          extra: { bookingId: result.booking.id, sessionId: result.sessionId, error: recalcErr }
        });
      }
    }
    
    const { broadcastToStaff } = await import('../core/websocket');
    broadcastToStaff({
      type: 'booking_updated',
      bookingId: result.booking.id,
      action: 'trackman_linked',
      memberEmail: ownerEmail,
      memberName: ownerName,
      totalPlayers: totalPlayerCount
    } as any);
    
    let emailLinked = false;
    if (rememberEmail && originalEmail && originalEmail.toLowerCase() !== ownerEmail.toLowerCase()) {
      try {
        const existingLink = await pool.query(
          `SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = LOWER($1)`,
          [originalEmail]
        );
        
        if (existingLink.rows.length === 0) {
          const [member] = await db.select().from(users).where(eq(users.email, ownerEmail.toLowerCase())).limit(1);
          if (member) {
            await pool.query(
              `INSERT INTO user_linked_emails (primary_email, linked_email, source, created_at) 
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (LOWER(linked_email)) DO NOTHING`,
              [member.email, originalEmail.toLowerCase(), 'staff_assignment']
            );
            emailLinked = true;
            logger.info('[link-trackman-to-member] Linked email to member', {
              extra: { memberEmail: ownerEmail, linkedEmail: originalEmail, memberId: member.id }
            });
          }
        }
      } catch (linkErr: unknown) {
        logger.warn('[link-trackman-to-member] Failed to link email', { extra: { error: linkErr } });
      }
    }
    
    logFromRequest(req, 'link_trackman_to_member', 'booking', result.booking.id.toString(), ownerEmail, {
      trackman_booking_id,
      owner_email: ownerEmail,
      owner_name: ownerName,
      total_players: totalPlayerCount,
      guest_count: guestCount,
      was_created: result.created,
      fees_recalculated: !!result.sessionId,
      email_linked: emailLinked ? originalEmail : null
    });
    
    res.json({ 
      success: true, 
      booking: result.booking, 
      created: result.created,
      totalPlayers: totalPlayerCount,
      guestCount,
      feesRecalculated: !!result.sessionId,
      emailLinked
    });
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as any).error });
    }
    logAndRespond(req, res, 500, 'Failed to link Trackman booking to member', error, 'LINK_TRACKMAN_ERROR');
  }
});

// Get overlapping facility closures/notices for a given time range
// Used to allow linking to existing notices instead of creating duplicates
router.get('/api/resources/overlapping-notices', isStaffOrAdmin, async (req, res) => {
  try {
    const { startDate, endDate, startTime, endTime, resourceId, sameDayOnly } = req.query;
    
    if (!startDate || !startTime || !endTime) {
      return res.status(400).json({ error: 'Missing required parameters: startDate, startTime, endTime' });
    }
    
    const queryDate = startDate as string;
    const queryEndDate = (endDate as string) || queryDate;
    const queryStartTime = startTime as string;
    const queryEndTime = endTime as string;
    const isSameDayOnly = sameDayOnly === 'true';
    
    const timeOverlapCondition = isSameDayOnly
      ? ''
      : `AND (
          (fc.start_time IS NULL AND fc.end_time IS NULL)
          OR (fc.start_time < $4 AND fc.end_time > $3)
        )`;
    
    const params = isSameDayOnly
      ? [queryDate, queryEndDate]
      : [queryDate, queryEndDate, queryStartTime, queryEndTime];
    
    const result = await pool.query(`
      SELECT 
        fc.id,
        fc.title,
        fc.reason,
        fc.notice_type,
        fc.start_date,
        fc.end_date,
        fc.start_time,
        fc.end_time,
        fc.affected_areas,
        fc.google_calendar_id,
        fc.created_at,
        fc.created_by,
        CASE 
          WHEN fc.google_calendar_id IS NOT NULL THEN 'Google Calendar'
          WHEN fc.created_by = 'system_cleanup' THEN 'Auto-generated'
          ELSE 'Manual'
        END as source
      FROM facility_closures fc
      WHERE fc.is_active = true
        AND fc.start_date <= $2
        AND fc.end_date >= $1
        ${timeOverlapCondition}
      ORDER BY fc.start_date, fc.start_time
      LIMIT 20
    `, params);
    
    res.json(result.rows);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch overlapping notices', error, 'OVERLAPPING_NOTICES_ERROR');
  }
});

router.post('/api/bookings/mark-as-event', isStaffOrAdmin, async (req, res) => {
  try {
    const { booking_id, trackman_booking_id, existingClosureId } = req.body;
    
    if (!booking_id && !trackman_booking_id) {
      return res.status(400).json({ error: 'Missing required field: booking_id or trackman_booking_id' });
    }
    
    // Get the primary booking
    let primaryBooking: any;
    let isFromUnmatched = false;
    
    if (booking_id) {
      const [booking] = await db.select()
        .from(bookingRequests)
        .where(eq(bookingRequests.id, booking_id));
      primaryBooking = booking;
    } else if (trackman_booking_id) {
      const [booking] = await db.select()
        .from(bookingRequests)
        .where(eq(bookingRequests.trackmanBookingId, trackman_booking_id));
      primaryBooking = booking;
    }
    
    // If not found in bookingRequests and we have a trackman_booking_id, check unmatched bookings
    if (!primaryBooking && trackman_booking_id) {
      const { trackmanUnmatchedBookings } = await import('../../shared/models/scheduling');
      const [unmatchedBooking] = await db.select()
        .from(trackmanUnmatchedBookings)
        .where(eq(trackmanUnmatchedBookings.trackmanBookingId, trackman_booking_id));
      
      if (unmatchedBooking) {
        // Look up resource ID from bay number
        let resourceId: number | null = null;
        if (unmatchedBooking.bayNumber) {
          const [resource] = await db.select()
            .from(resources)
            .where(eq(resources.name, `Bay ${unmatchedBooking.bayNumber}`));
          resourceId = resource?.id ?? null;
        }
        
        // Map unmatched booking fields to expected format
        primaryBooking = {
          id: unmatchedBooking.id,
          userName: unmatchedBooking.userName,
          requestDate: unmatchedBooking.bookingDate,
          startTime: unmatchedBooking.startTime,
          endTime: unmatchedBooking.endTime,
          durationMinutes: unmatchedBooking.durationMinutes,
          resourceId: resourceId,
          trackmanBookingId: unmatchedBooking.trackmanBookingId,
          isUnmatched: true,
        };
        isFromUnmatched = true;
      }
    }
    
    if (!primaryBooking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    // Auto-group: Find all bookings with same name + date + start_time across different bays
    const userName = primaryBooking.userName?.toLowerCase()?.trim();
    const bookingDate = primaryBooking.requestDate;
    const startTime = primaryBooking.startTime;
    // Calculate end time - use booking endTime or compute from duration if not available
    let endTime = primaryBooking.endTime;
    if (!endTime && primaryBooking.durationMinutes && startTime) {
      const startMinutes = parseTimeToMinutes(startTime);
      const endMinutes = startMinutes + primaryBooking.durationMinutes;
      const endHours = Math.floor(endMinutes / 60);
      const endMins = endMinutes % 60;
      endTime = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}:00`;
    }
    // Fallback: if still no endTime, default to 1 hour after start
    if (!endTime && startTime) {
      const startMinutes = parseTimeToMinutes(startTime);
      const endMinutes = startMinutes + 60;
      const endHours = Math.floor(endMinutes / 60);
      const endMins = endMinutes % 60;
      endTime = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}:00`;
    }
    
    let relatedBookings: any[] = [];
    let relatedUnmatchedIds: number[] = [];
    
    if (userName && bookingDate && startTime) {
      relatedBookings = await db.select()
        .from(bookingRequests)
        .where(and(
          sql`LOWER(TRIM(${bookingRequests.userName})) = ${userName}`,
          eq(bookingRequests.requestDate, bookingDate),
          eq(bookingRequests.startTime, startTime),
          eq(bookingRequests.isUnmatched, true)
        ));
      
      // Also find related unmatched bookings if coming from unmatched table
      if (isFromUnmatched) {
        const { trackmanUnmatchedBookings } = await import('../../shared/models/scheduling');
        const relatedUnmatched = await db.select()
          .from(trackmanUnmatchedBookings)
          .where(and(
            sql`LOWER(TRIM(${trackmanUnmatchedBookings.userName})) = ${userName}`,
            eq(trackmanUnmatchedBookings.bookingDate, bookingDate),
            eq(trackmanUnmatchedBookings.startTime, startTime),
            sql`${trackmanUnmatchedBookings.resolvedAt} IS NULL`
          ));
        relatedUnmatchedIds = relatedUnmatched.map(u => u.id);
        
        // Look up resource IDs from bay numbers for unmatched bookings
        for (const unmatched of relatedUnmatched) {
          if (unmatched.bayNumber) {
            const [resource] = await db.select()
              .from(resources)
              .where(eq(resources.name, `Bay ${unmatched.bayNumber}`));
            if (resource) {
              relatedBookings.push({
                ...unmatched,
                resourceId: resource.id,
                requestDate: unmatched.bookingDate,
                isUnmatched: true
              });
            }
          }
        }
      }
    }
    
    // If no related bookings found, just include the primary one
    if (relatedBookings.length === 0) {
      relatedBookings = [primaryBooking];
      if (isFromUnmatched && !relatedUnmatchedIds.includes(primaryBooking.id)) {
        relatedUnmatchedIds = [primaryBooking.id];
      }
    }
    
    // Collect all unique resource IDs (bays) from related bookings
    const resourceIds = [...new Set(relatedBookings.map(b => b.resourceId).filter(Boolean))] as number[];
    const bookingIds = relatedBookings.map(b => b.id);
    
    // Create a facility closure for the private event
    const eventTitle = primaryBooking.userName || 'Private Event';
    const { availabilityBlocks } = await import('../../shared/schema');
    const staffEmail = req.session?.user?.email || 'staff';
    
    // Use transaction to ensure atomicity and prevent race conditions
    // All duplicate detection happens inside the transaction
    const result = await db.transaction(async (tx) => {
      let closure: any = null;
      let linkedToExisting = false;
      
      // If existingClosureId provided, link to that existing closure instead of creating new
      if (existingClosureId) {
        const [existingClosure] = await tx.select()
          .from(facilityClosures)
          .where(and(
            eq(facilityClosures.id, existingClosureId),
            eq(facilityClosures.isActive, true)
          ));
        
        if (existingClosure) {
          closure = existingClosure;
          linkedToExisting = true;
        }
      }
      
      // If no existing closure linked, check for exact time match or create new
      if (!closure) {
        // Check for existing private_event closures with EXACT time match (inside transaction for safety)
        const existingClosures = await tx.select()
          .from(facilityClosures)
          .where(and(
            eq(facilityClosures.startDate, bookingDate),
            eq(facilityClosures.startTime, startTime),
            eq(facilityClosures.endTime, endTime),
            eq(facilityClosures.noticeType, 'private_event'),
            eq(facilityClosures.isActive, true)
          ));
        
        closure = existingClosures[0]; // Use existing closure only if exact match
        if (closure) linkedToExisting = true;
      }
      
      // Check for existing blocks on these resources with overlapping times
      const existingBlocks = resourceIds.length > 0 ? await tx.select()
        .from(availabilityBlocks)
        .where(and(
          eq(availabilityBlocks.blockDate, bookingDate),
          sql`${availabilityBlocks.resourceId} IN (${sql.join(resourceIds.map(id => sql`${id}`), sql`, `)})`,
          sql`${availabilityBlocks.startTime} < ${endTime}`,
          sql`${availabilityBlocks.endTime} > ${startTime}`
        )) : [];
      
      // Determine which resources already have blocks covering this time
      const blockedResourceIds = new Set(existingBlocks.map(b => b.resourceId));
      const unblockResourceIds = resourceIds.filter(id => !blockedResourceIds.has(id));
      
      // Only create new closure if none exists with exact time/type match and no existing closure linked
      if (!closure) {
        const [newClosure] = await tx.insert(facilityClosures).values({
          title: eventTitle,
          reason: 'Private Event',
          noticeType: 'private_event',
          startDate: bookingDate,
          startTime: startTime,
          endDate: bookingDate,
          endTime: endTime,
          affectedAreas: JSON.stringify(resourceIds.map(id => `bay_${id}`)),
          isActive: true,
          createdBy: staffEmail
        }).returning();
        closure = newClosure;
      }
      
      // Only create blocks for resources that don't already have overlapping blocks
      if (unblockResourceIds.length > 0 && closure) {
        const blockValues = unblockResourceIds.map(resourceId => ({
          resourceId,
          blockDate: bookingDate,
          startTime: startTime,
          endTime: endTime,
          blockType: 'blocked',
          notes: `Private Event: ${eventTitle}`,
          closureId: closure.id,
          createdBy: staffEmail
        }));
        
        await tx.insert(availabilityBlocks).values(blockValues);
      }
      
      // Handle booking cleanup: Archive unmatched bookings and delete matched ones
      // For unmatched bookings (placeholder emails), update them to mark as resolved
      // For regular bookings, delete them since they're now represented as blocks
      const unmatchedInBookingRequests = bookingIds.filter(id => {
        const booking = relatedBookings.find(b => b.id === id);
        return booking?.isUnmatched === true || 
               !booking?.userEmail ||
               (booking?.userEmail && (booking.userEmail.includes('unmatched-') || booking.userEmail.includes('@trackman.local')));
      });
      const regularBookingIds = bookingIds.filter(id => !relatedUnmatchedIds.includes(id) && !unmatchedInBookingRequests.includes(id));
      
      // Mark unmatched bookings in booking_requests as resolved (no longer needs assignment)
      // Also set closure_id to link the booking to the closure
      if (unmatchedInBookingRequests.length > 0) {
        await tx.update(bookingRequests)
          .set({
            isUnmatched: false,
            userEmail: 'private-event@resolved',
            notes: sql`COALESCE(${bookingRequests.notes}, '') || ' [Converted to Private Event]'`,
            status: 'attended',
            closureId: closure?.id || null
          })
          .where(sql`id IN (${sql.join(unmatchedInBookingRequests.map(id => sql`${id}`), sql`, `)})`);
      }
      
      // Delete regular (matched) bookings from the queue
      if (regularBookingIds.length > 0) {
        await tx.delete(bookingMembers).where(sql`booking_id IN (${sql.join(regularBookingIds.map(id => sql`${id}`), sql`, `)})`);
        await tx.delete(bookingGuests).where(sql`booking_id IN (${sql.join(regularBookingIds.map(id => sql`${id}`), sql`, `)})`);
        await tx.delete(bookingRequests).where(sql`id IN (${sql.join(regularBookingIds.map(id => sql`${id}`), sql`, `)})`);
      }
      
      // Mark unmatched bookings as resolved (converted to private event)
      if (relatedUnmatchedIds.length > 0) {
        const { trackmanUnmatchedBookings } = await import('../../shared/models/scheduling');
        await tx.update(trackmanUnmatchedBookings)
          .set({
            resolvedAt: new Date(),
            resolvedBy: staffEmail,
            resolvedEmail: 'PRIVATE_EVENT',
          })
          .where(sql`id IN (${sql.join(relatedUnmatchedIds.map(id => sql`${id}`), sql`, `)})`);
      }
      
      return { closure, bookingIds, resourceIds, linkedToExisting, newBlocksCreated: unblockResourceIds.length, resolvedUnmatchedCount: relatedUnmatchedIds.length };
    });
    
    // Broadcast updates after successful transaction
    const { broadcastToStaff, broadcastClosureUpdate } = await import('../core/websocket');
    broadcastToStaff({
      type: 'booking_updated',
      action: 'converted_to_private_event',
      bookingIds: result.bookingIds,
      closureId: result.closure?.id
    } as any);
    
    if (result.closure) {
      broadcastClosureUpdate({
        type: 'closure_created',
        closureId: result.closure.id
      } as any);
    }
    
    logFromRequest(req, 'update_booking' as any, 'booking', primaryBooking.id.toString(), `Private Event: ${eventTitle}`, {
      booking_id: primaryBooking.id,
      trackman_booking_id,
      grouped_booking_count: result.bookingIds.length,
      resource_ids: result.resourceIds,
      closure_id: result.closure?.id,
      linked_to_existing: result.linkedToExisting,
      new_blocks_created: result.newBlocksCreated
    });
    
    // Build response message based on what happened
    let message = `Converted ${result.bookingIds.length} booking(s) to private event`;
    if (result.linkedToExisting) {
      message += ' (linked to existing notice)';
    }
    if (result.newBlocksCreated === 0) {
      message += ' - all blocks already existed';
    } else if (result.newBlocksCreated < result.resourceIds.length) {
      message += ` - created ${result.newBlocksCreated} new block(s)`;
    }
    
    res.json({ 
      success: true, 
      message,
      closureId: result.closure?.id,
      convertedBookingIds: result.bookingIds,
      resourceIds: result.resourceIds,
      linkedToExisting: result.linkedToExisting,
      newBlocksCreated: result.newBlocksCreated
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to mark booking as event', error, 'MARK_EVENT_ERROR');
  }
});

router.put('/api/bookings/:id/assign-with-players', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string);
    const { owner, additional_players, rememberEmail, originalEmail } = req.body;
    
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    
    if (!owner?.email || !owner?.name) {
      return res.status(400).json({ error: 'Missing required owner fields: email, name' });
    }
    
    const additionalPlayers: Array<{ type: 'member' | 'guest_placeholder'; member_id?: string; email?: string; name?: string; guest_name?: string }> = additional_players || [];
    const totalPlayerCount = 1 + additionalPlayers.filter(p => p.type === 'member' || p.type === 'guest_placeholder').length;
    const guestCount = additionalPlayers.filter(p => p.type === 'guest_placeholder').length;
    
    const result = await db.transaction(async (tx) => {
      const [existingBooking] = await tx.select()
        .from(bookingRequests)
        .where(eq(bookingRequests.id, bookingId));
      
      if (!existingBooking) {
        throw { statusCode: 404, error: 'Booking not found' };
      }
      
      // Build the note to append
      const newNote = ` [Assigned by staff: ${owner.name} with ${totalPlayerCount} players]`;
      
      const [updated] = await tx.update(bookingRequests)
        .set({
          userEmail: owner.email.toLowerCase(),
          userName: owner.name,
          userId: owner.member_id || null,
          isUnmatched: false,
          status: 'approved',
          declaredPlayerCount: totalPlayerCount,
          guestCount: guestCount,
          // Use atomic SQL append to avoid overwriting concurrent changes
          staffNotes: sql`COALESCE(${bookingRequests.staffNotes}, '') || ${newNote}`,
          updatedAt: new Date()
        })
        .where(eq(bookingRequests.id, bookingId))
        .returning();
      
      await tx.delete(bookingMembers).where(eq(bookingMembers.bookingId, bookingId));
      await tx.delete(bookingGuests).where(eq(bookingGuests.bookingId, bookingId));
      
      await tx.insert(bookingMembers).values({
        bookingId: bookingId,
        userEmail: owner.email.toLowerCase(),
        slotNumber: 1,
        isPrimary: true,
        trackmanBookingId: existingBooking.trackmanBookingId,
        linkedAt: new Date(),
        linkedBy: getSessionUser(req)?.email || 'staff'
      });
      
      let slotNumber = 2;
      for (const player of additionalPlayers) {
        if (player.type === 'member') {
          await tx.insert(bookingMembers).values({
            bookingId: bookingId,
            userEmail: player.email?.toLowerCase(),
            slotNumber,
            isPrimary: false,
            trackmanBookingId: existingBooking.trackmanBookingId,
            linkedAt: new Date(),
            linkedBy: getSessionUser(req)?.email || 'staff'
          });
        } else if (player.type === 'guest_placeholder') {
          await tx.insert(bookingGuests).values({
            bookingId: bookingId,
            guestName: player.guest_name || 'Guest (info pending)',
            slotNumber,
            trackmanBookingId: existingBooking.trackmanBookingId
          });
        }
        slotNumber++;
      }
      
      return { booking: updated, sessionId: existingBooking.sessionId };
    });
    
    if (result.sessionId) {
      try {
        await recalculateSessionFees(result.sessionId, 'approval' as any);
        logger.info('[assign-with-players] Recalculated fees after member assignment', {
          extra: { bookingId, sessionId: result.sessionId, newOwner: owner.email }
        });
      } catch (recalcErr: unknown) {
        logger.warn('[assign-with-players] Failed to recalculate fees after assignment', {
          extra: { bookingId, sessionId: result.sessionId, error: recalcErr }
        });
      }
    }
    
    if (result.sessionId) {
      try {
        const feeResult = await pool.query(`
          SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents,
                 SUM(CASE WHEN participant_type = 'owner' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as overage_cents,
                 SUM(CASE WHEN participant_type = 'guest' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as guest_cents
          FROM booking_participants
          WHERE session_id = $1
        `, [result.sessionId]);
        
        const totalCents = parseInt(feeResult.rows[0]?.total_cents || '0');
        const overageCents = parseInt(feeResult.rows[0]?.overage_cents || '0');
        const guestCents = parseInt(feeResult.rows[0]?.guest_cents || '0');
        
        if (totalCents > 0) {
          const prepayResult = await createPrepaymentIntent({
            sessionId: result.sessionId,
            bookingId: bookingId,
            userId: owner.member_id || null,
            userEmail: owner.email,
            userName: owner.name,
            totalFeeCents: totalCents,
            feeBreakdown: { overageCents, guestCents }
          });
          
          if (prepayResult?.paidInFull) {
            await pool.query(
              `UPDATE booking_participants SET payment_status = 'paid' WHERE session_id = $1 AND payment_status = 'pending'`,
              [result.sessionId]
            );
            logger.info('[assign-with-players] Prepayment fully covered by credit', {
              extra: { bookingId, sessionId: result.sessionId, totalCents }
            });
          } else {
            logger.info('[assign-with-players] Created prepayment intent', {
              extra: { bookingId, sessionId: result.sessionId, totalCents }
            });
          }
        }
      } catch (prepayErr: unknown) {
        logger.warn('[assign-with-players] Failed to create prepayment intent', {
          extra: { bookingId, sessionId: result.sessionId, error: prepayErr }
        });
      }
    }
    
    const { broadcastToStaff } = await import('../core/websocket');
    broadcastToStaff({
      type: 'booking_updated',
      bookingId: result.booking.id,
      action: 'players_assigned',
      memberEmail: owner.email,
      memberName: owner.name,
      totalPlayers: totalPlayerCount
    } as any);
    
    if (owner.member_id) {
      try {
        const feeResult = await pool.query(`
          SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents
          FROM booking_participants
          WHERE session_id = $1
        `, [result.sessionId]);
        
        const totalCents = parseInt(feeResult.rows[0]?.total_cents || '0');
        const feeMessage = totalCents > 0 
          ? ` Estimated fees: $${(totalCents / 100).toFixed(2)}. You can pay now from your dashboard.`
          : '';
        
        const dateStr = result.booking.requestDate 
          ? new Date(result.booking.requestDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
          : '';
        const timeStr = result.booking.startTime || '';
        
        await pool.query(
          `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            owner.email.toLowerCase(),
            'Booking Confirmed',
            `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.${feeMessage}`,
            'booking',
            'booking'
          ]
        );
        
        sendNotificationToUser(owner.email, {
          type: 'booking_confirmed',
          title: 'Booking Confirmed',
          message: `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.${feeMessage}`,
          data: { bookingId, feeCents: totalCents },
        });
      } catch (notifyErr: unknown) {
        logger.warn('[assign-with-players] Failed to notify member', {
          extra: { bookingId, error: notifyErr }
        });
      }
    }
    
    let emailLinked = false;
    if (rememberEmail && originalEmail && originalEmail.toLowerCase() !== owner.email.toLowerCase()) {
      try {
        const existingLink = await pool.query(
          `SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = LOWER($1)`,
          [originalEmail]
        );
        
        if (existingLink.rows.length === 0) {
          const [member] = await db.select().from(users).where(eq(users.email, owner.email.toLowerCase())).limit(1);
          if (member) {
            await pool.query(
              `INSERT INTO user_linked_emails (primary_email, linked_email, source, created_at) 
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (LOWER(linked_email)) DO NOTHING`,
              [member.email, originalEmail.toLowerCase(), 'staff_assignment']
            );
            emailLinked = true;
            logger.info('[assign-with-players] Linked email to member', {
              extra: { memberEmail: owner.email, linkedEmail: originalEmail, memberId: member.id }
            });
          }
        }
      } catch (linkErr: unknown) {
        logger.warn('[assign-with-players] Failed to link email', { extra: { error: linkErr } });
      }
    }
    
    logFromRequest(req, 'assign_member_to_booking' as any, 'booking', bookingId.toString(), owner.email, {
      owner_email: owner.email,
      owner_name: owner.name,
      total_players: totalPlayerCount,
      guest_count: guestCount,
      fees_recalculated: !!result.sessionId,
      email_linked: emailLinked ? originalEmail : null
    });
    
    res.json({ 
      success: true, 
      booking: result.booking,
      totalPlayers: totalPlayerCount,
      guestCount,
      feesRecalculated: !!result.sessionId,
      emailLinked
    });
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as any).error });
    }
    logger.error('[assign-with-players] Database error details', {
      extra: {
        bookingId: req.params.id,
        owner: req.body.owner,
        errorMessage: getErrorMessage(error),
        errorCode: getErrorCode(error),
        errorDetail: (error as any).detail,
        errorConstraint: (error as any).constraint,
        errorStack: (error as any).stack?.split('\n').slice(0, 5).join('\n')
      }
    });
    logAndRespond(req, res, 500, 'Failed to assign players to booking', error, 'ASSIGN_PLAYERS_ERROR');
  }
});

router.put('/api/bookings/:id/change-owner', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string);
    const { new_email, new_name, member_id } = req.body;
    
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    
    if (!new_email || !new_name) {
      return res.status(400).json({ error: 'Missing required fields: new_email, new_name' });
    }
    
    const [existingBooking] = await db.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));
    
    if (!existingBooking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const previousOwner = existingBooking.userName || existingBooking.userEmail;
    
    const [updated] = await db.update(bookingRequests)
      .set({
        userEmail: new_email.toLowerCase(),
        userName: new_name,
        userId: member_id || null,
        isUnmatched: false,
        status: 'approved',
        staffNotes: sql`COALESCE(${bookingRequests.staffNotes}, '') || ' [Owner changed from ' || ${previousOwner} || ' to ' || ${new_name} || ' by staff]'`,
        updatedAt: new Date()
      })
      .where(eq(bookingRequests.id, bookingId))
      .returning();
    
    const { broadcastToStaff } = await import('../core/websocket');
    broadcastToStaff({
      type: 'booking_updated',
      bookingId: updated.id,
      action: 'owner_changed',
      previousOwner,
      newOwnerEmail: new_email,
      newOwnerName: new_name
    } as any);
    
    logFromRequest(req, 'change_booking_owner', 'booking', bookingId.toString(), new_email, {
      previous_owner: previousOwner,
      new_email,
      new_name
    });
    
    res.json({ 
      success: true, 
      booking: updated
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to change booking owner', error, 'CHANGE_OWNER_ERROR');
  }
});

router.post('/api/bookings', bookingRateLimiter, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { resource_id, user_email, booking_date, start_time, end_time, notes } = req.body;
    
    if (!resource_id || !user_email || !booking_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'Missing required fields: resource_id, user_email, booking_date, start_time, end_time' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const requestEmail = user_email.toLowerCase();
    
    if (sessionEmail !== requestEmail) {
      const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../replit_integrations/auth/replitAuth');
      const isAdmin = await isAdminEmail(sessionEmail);
      if (!isAdmin) {
        const pool = getAuthPool();
        let isStaff = false;
        if (pool) {
          try {
            const result = await queryWithRetry(
              pool,
              'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
              [sessionEmail]
            );
            isStaff = result.rows.length > 0;
          } catch (e: unknown) {
            logger.warn('[resources] Staff check query failed:', e);
          }
        }
        if (!isStaff) {
          return res.status(403).json({ error: 'You can only create bookings for yourself' });
        }
      }
    }
    
    const userResult = await db.select({
      id: users.id,
      tier: users.tier,
      tags: users.tags,
      firstName: users.firstName,
      lastName: users.lastName
    })
      .from(users)
      .where(eq(users.email, user_email));
    
    const user = userResult[0];
    const userTier = user?.tier || DEFAULT_TIER;
    let userTags: string[] = [];
    try {
      if (user?.tags) {
        userTags = typeof user.tags === 'string' ? JSON.parse(user.tags) : (Array.isArray(user.tags) ? user.tags : []);
      }
    } catch (parseError: unknown) {
      console.warn('[POST /api/bookings] Failed to parse user tags for', user_email, parseError);
      userTags = [];
    }
    
    const isMemberAuthorized = await isAuthorizedForMemberBooking(userTier, userTags);
    
    if (!isMemberAuthorized) {
      return res.status(402).json({ 
        error: 'Membership upgrade required',
        bookingType: 'upgrade_required',
        message: 'Simulator booking is available for Core, Premium, VIP, and Corporate members'
      });
    }
    
    const startParts = start_time.split(':').map(Number);
    const endParts = end_time.split(':').map(Number);
    const durationMinutes = (endParts[0] * 60 + endParts[1]) - (startParts[0] * 60 + startParts[1]);
    
    // Get resource type to pass to limit checking
    let resourceType = 'simulator';
    if (resource_id) {
      const resourceResult = await pool.query(
        `SELECT type FROM resources WHERE id = $1`,
        [resource_id]
      );
      resourceType = resourceResult.rows[0]?.type || 'simulator';
    }
    
    const limitCheck = await checkDailyBookingLimit(user_email, booking_date, durationMinutes, userTier, resourceType);
    if (!limitCheck.allowed) {
      return res.status(403).json({ 
        error: limitCheck.reason,
        remainingMinutes: limitCheck.remainingMinutes
      });
    }
    
    const existingResult = await db.select()
      .from(bookingRequests)
      .where(and(
        eq(bookingRequests.resourceId, resource_id),
        sql`${bookingRequests.requestDate} = ${booking_date}`,
        or(
          eq(bookingRequests.status, 'confirmed'),
          eq(bookingRequests.status, 'approved'),
          eq(bookingRequests.status, 'pending_approval')
        ),
        or(
          and(
            sql`${bookingRequests.startTime} <= ${start_time}`,
            sql`${bookingRequests.endTime} > ${start_time}`
          ),
          and(
            sql`${bookingRequests.startTime} < ${end_time}`,
            sql`${bookingRequests.endTime} >= ${end_time}`
          ),
          and(
            sql`${bookingRequests.startTime} >= ${start_time}`,
            sql`${bookingRequests.endTime} <= ${end_time}`
          )
        )
      ));
    
    if (existingResult.length > 0) {
      return res.status(409).json({ error: 'This time slot is already requested or booked' });
    }
    
    // Check all conflicts using unified function
    const conflictCheck = await checkAllConflicts(resource_id, booking_date, start_time, end_time);
    if (conflictCheck.hasConflict) {
      if (conflictCheck.conflictType === 'closure') {
        return res.status(409).json({ 
          error: 'Time slot conflicts with a facility closure',
          message: `This time slot conflicts with "${conflictCheck.conflictTitle}".`
        });
      } else if (conflictCheck.conflictType === 'availability_block') {
        return res.status(409).json({ 
          error: 'Time slot is blocked for an event',
          message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}.`
        });
      } else {
        return res.status(409).json({ 
          error: 'Time slot already booked',
          message: 'Another booking already exists for this time slot.'
        });
      }
    }
    
    const userName = user?.firstName && user?.lastName 
      ? `${user.firstName} ${user.lastName}` 
      : user_email;
    
    const result = await db.insert(bookingRequests)
      .values({
        resourceId: resource_id,
        userEmail: user_email.toLowerCase(),
        userName: userName,
        requestDate: booking_date,
        startTime: start_time,
        endTime: end_time,
        durationMinutes: durationMinutes,
        notes: notes || null,
        status: 'pending_approval'
      })
      .returning();
    
    res.status(201).json({
      ...result[0],
      message: 'Request sent! Concierge will confirm shortly.'
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to submit booking request', error, 'BOOKING_REQUEST_ERROR');
  }
});

router.get('/api/bookings/:id/cascade-preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    
    const [booking] = await db.select({
      id: bookingRequests.id,
      sessionId: bookingRequests.sessionId
    })
    .from(bookingRequests)
    .where(eq(bookingRequests.id, bookingId));
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    let participantsCount = 0;
    let membersCount = 0;
    
    if (booking.sessionId) {
      const participantsResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(bookingParticipants)
        .where(eq(bookingParticipants.sessionId, booking.sessionId));
      participantsCount = participantsResult[0]?.count || 0;
    }
    
    const membersResult = await db.select({ count: sql<number>`count(*)::int` })
      .from(bookingMembers)
      .where(eq(bookingMembers.bookingId, bookingId));
    membersCount = membersResult[0]?.count || 0;
    
    res.json({
      bookingId,
      relatedData: {
        participants: participantsCount,
        linkedMembers: membersCount
      },
      hasRelatedData: participantsCount > 0 || membersCount > 0
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch cascade preview', error, 'CASCADE_PREVIEW_ERROR');
  }
});

router.delete('/api/bookings/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    const sessionUser = getSessionUser(req);
    const archivedBy = sessionUser?.email || 'unknown';
    const hardDelete = req.query.hard_delete === 'true';
    
    const [booking] = await db.select({
      calendarEventId: bookingRequests.calendarEventId,
      resourceId: bookingRequests.resourceId,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      sessionId: bookingRequests.sessionId,
      archivedAt: bookingRequests.archivedAt,
      trackmanBookingId: bookingRequests.trackmanBookingId
    })
    .from(bookingRequests)
    .where(eq(bookingRequests.id, bookingId));
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    if (!hardDelete && booking.archivedAt) {
      return res.status(400).json({ error: 'Booking is already archived' });
    }
    
    let resourceName: string | undefined;
    if (booking.resourceId) {
      const [resource] = await db.select({ name: resources.name, type: resources.type })
        .from(resources)
        .where(eq(resources.id, booking.resourceId));
      resourceName = resource?.name;
    }
    
    if (hardDelete) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        if (booking.sessionId) {
          await client.query(`DELETE FROM booking_participants WHERE session_id = $1`, [booking.sessionId]);
          await client.query(`DELETE FROM booking_sessions WHERE id = $1`, [booking.sessionId]);
        }
        
        await client.query(`DELETE FROM booking_members WHERE booking_id = $1`, [bookingId]);
        await client.query(`DELETE FROM booking_guests WHERE booking_id = $1`, [bookingId]);
        
        if (booking.trackmanBookingId) {
          await client.query(
            `DELETE FROM trackman_bay_slots WHERE trackman_booking_id = $1`,
            [booking.trackmanBookingId]
          );
          await client.query(
            `UPDATE trackman_webhook_events SET matched_booking_id = NULL WHERE trackman_booking_id = $1`,
            [booking.trackmanBookingId]
          );
          await client.query(
            `DELETE FROM trackman_unmatched_bookings WHERE trackman_booking_id = $1`,
            [booking.trackmanBookingId]
          );
        }
        
        await client.query(
          `DELETE FROM stripe_payment_intents WHERE booking_id = $1`,
          [bookingId]
        );
        
        await client.query(
          `DELETE FROM booking_fee_snapshots WHERE booking_id = $1`,
          [bookingId]
        );
        
        await client.query(`DELETE FROM booking_requests WHERE id = $1`, [bookingId]);
        
        await client.query('COMMIT');
        
        logger.info('[DELETE /api/bookings] Hard delete complete', {
          extra: {
            bookingId,
            deletedBy: archivedBy,
            trackmanBookingId: booking.trackmanBookingId,
            sessionId: booking.sessionId
          }
        });
      } catch (txErr: unknown) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
    } else {
      await db.update(bookingRequests)
        .set({ 
          status: 'cancelled',
          archivedAt: new Date(),
          archivedBy: archivedBy
        })
        .where(eq(bookingRequests.id, bookingId));
      
      const cascadeResult = await handleCancellationCascade(
        bookingId,
        booking.sessionId,
        booking.userEmail || '',
        booking.userName || null,
        booking.requestDate,
        booking.startTime || '',
        resourceName
      );
      
      logger.info('[DELETE /api/bookings] Soft delete complete', {
        extra: {
          bookingId,
          archivedBy,
          participantsNotified: cascadeResult.participantsNotified,
          guestPassesRefunded: cascadeResult.guestPassesRefunded,
          bookingMembersRemoved: cascadeResult.bookingMembersRemoved,
          prepaymentRefunds: cascadeResult.prepaymentRefunds,
          cascadeErrors: cascadeResult.errors.length
        }
      });
    }
    
    broadcastAvailabilityUpdate({
      resourceId: booking?.resourceId || undefined,
      date: booking.requestDate,
      action: 'cancelled'
    });
    
    if (booking?.calendarEventId && booking.resourceId) {
      try {
        const [resource] = await db.select({ type: resources.type })
          .from(resources)
          .where(eq(resources.id, booking.resourceId));
        
        if (resource?.type === 'conference_room') {
          const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
          if (calendarId) {
            await deleteCalendarEvent(booking.calendarEventId, calendarId);
          }
        }
      } catch (calError: unknown) {
        console.error('Failed to delete calendar event (non-blocking):', calError);
      }
    }
    
    res.json({ 
      success: true,
      hardDeleted: hardDelete,
      archived: !hardDelete,
      archivedBy
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to delete booking', error, 'BOOKING_DELETE_ERROR');
  }
});

router.put('/api/bookings/:id/member-cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const rawSessionEmail = getSessionUser(req)?.email;
    const sessionUserRole = getSessionUser(req)?.role;
    const userEmail = rawSessionEmail?.toLowerCase();
    
    const actingAsEmail = req.body?.acting_as_email?.toLowerCase();
    const isAdminViewingAs = (sessionUserRole === 'admin' || sessionUserRole === 'staff') && actingAsEmail;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const bookingId = parseInt(id as string);
    
    const [existing] = await db.select({
      id: bookingRequests.id,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      status: bookingRequests.status,
      calendarEventId: bookingRequests.calendarEventId,
      resourceId: bookingRequests.resourceId,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      sessionId: bookingRequests.sessionId,
      trackmanBookingId: bookingRequests.trackmanBookingId,
    })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));
    
    if (!existing) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const bookingEmail = existing.userEmail?.toLowerCase();
    
    const isOwnBooking = bookingEmail === userEmail;
    const isValidViewAs = isAdminViewingAs && bookingEmail === actingAsEmail;
    
    if (!isOwnBooking && !isValidViewAs) {
      logger.warn('Member cancel email mismatch', { 
        bookingId, 
        bookingEmail: existing.userEmail, 
        sessionEmail: rawSessionEmail,
        actingAsEmail: actingAsEmail || 'none',
        normalizedBookingEmail: bookingEmail,
        normalizedSessionEmail: userEmail,
        requestId: req.requestId 
      });
      return res.status(403).json({ error: 'You can only cancel your own bookings' });
    }
    
    if (existing.status === 'cancelled') {
      return res.status(400).json({ error: 'Booking is already cancelled' });
    }
    if (existing.status === 'cancellation_pending') {
      return res.status(400).json({ error: 'Cancellation is already in progress' });
    }
    
    const wasApproved = existing.status === 'approved';
    const isTrackmanLinked = !!existing.trackmanBookingId;
    const needsPendingCancel = wasApproved && isTrackmanLinked;
    
    if (needsPendingCancel) {
      await db.update(bookingRequests)
        .set({
          status: 'cancellation_pending',
          cancellationPendingAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(bookingRequests.id, bookingId));
      
      logFromRequest(req, 'cancellation_requested', 'booking', id, undefined, {
        member_email: existing.userEmail,
        trackman_booking_id: existing.trackmanBookingId
      });
      
      const memberName = existing.userName || existing.userEmail;
      const bookingDate = existing.requestDate;
      const bookingTime = existing.startTime?.substring(0, 5) || '';
      
      let bayName = 'Simulator';
      if (existing.resourceId) {
        const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
        if (resource?.name) bayName = resource.name;
      }
      
      const staffMessage = `${memberName} wants to cancel their booking on ${bookingDate} at ${bookingTime} (${bayName}). Please cancel in Trackman to complete the cancellation.`;
      
      notifyAllStaff(
        'Cancellation Request - Cancel in Trackman',
        staffMessage,
        'cancellation_pending',
        {
          relatedId: bookingId,
          relatedType: 'booking_request',
          url: '/admin/bookings'
        }
      ).catch(err => console.error('Staff cancellation notification failed:', err));
      
      await db.insert(notifications).values({
        userEmail: existing.userEmail || '',
        title: 'Cancellation Request Submitted',
        message: `Your cancellation request for ${bookingDate} at ${bookingTime} has been submitted. You'll be notified once it's fully processed.`,
        type: 'cancellation_pending',
        relatedId: bookingId,
        relatedType: 'booking_request'
      });
      
      return res.json({ 
        success: true, 
        status: 'cancellation_pending',
        message: 'Cancellation request submitted. You will be notified once it is fully processed.'
      });
    }
    
    let resourceName: string | undefined;
    if (existing.resourceId) {
      const [resource] = await db.select({ name: resources.name, type: resources.type })
        .from(resources)
        .where(eq(resources.id, existing.resourceId));
      resourceName = resource?.name;
    }
    
    await db.update(bookingRequests)
      .set({ 
        status: 'cancelled',
        trackmanExternalId: null  // Clear so ID can be reused
      })
      .where(eq(bookingRequests.id, bookingId));
    
    // Clean up any corresponding Trackman bay slot cache entry
    if (existing.resourceId && existing.requestDate && existing.startTime) {
      try {
        await pool.query(
          `DELETE FROM trackman_bay_slots 
           WHERE resource_id = $1 AND slot_date = $2 AND start_time = $3`,
          [existing.resourceId, existing.requestDate, existing.startTime]
        );
      } catch (err: unknown) {
        logger.warn('[Member Cancel] Failed to clean up trackman_bay_slots', { 
          bookingId, 
          resourceId: existing.resourceId,
          error: (err as Error).message 
        });
      }
    }
    
    const cascadeResult = await handleCancellationCascade(
      bookingId,
      existing.sessionId,
      existing.userEmail || '',
      existing.userName || null,
      existing.requestDate,
      existing.startTime || '',
      resourceName
    );
    
    logger.info('[PUT /api/bookings/member-cancel] Cancellation cascade complete', {
      extra: {
        bookingId,
        participantsNotified: cascadeResult.participantsNotified,
        guestPassesRefunded: cascadeResult.guestPassesRefunded,
        bookingMembersRemoved: cascadeResult.bookingMembersRemoved,
        prepaymentRefunds: cascadeResult.prepaymentRefunds,
        cascadeErrors: cascadeResult.errors.length
      }
    });
    
    broadcastAvailabilityUpdate({
      resourceId: existing.resourceId || undefined,
      date: existing.requestDate,
      action: 'cancelled'
    });
    
    const friendlyDate = existing.requestDate;
    const friendlyTime = existing.startTime?.substring(0, 5) || '';
    const cancelMessage = `Booking for ${friendlyDate} at ${friendlyTime} was cancelled by member.`;
    
    try {
      await notifyAllStaff(
        'Member Cancelled Booking',
        cancelMessage,
        'booking_cancelled',
        {
          relatedId: bookingId,
          relatedType: 'booking_request'
        }
      );
    } catch (staffNotifyErr: unknown) {
      console.error('Staff notification failed:', staffNotifyErr);
    }
    
    if (existing.calendarEventId && existing.resourceId) {
      try {
        const [resource] = await db.select({ type: resources.type })
          .from(resources)
          .where(eq(resources.id, existing.resourceId));
        
        if (resource?.type === 'conference_room') {
          const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
          if (calendarId) {
            await deleteCalendarEvent(existing.calendarEventId, calendarId);
          }
        }
      } catch (calError: unknown) {
        console.error('Failed to delete calendar event (non-blocking):', calError);
      }
    }
    
    logMemberAction({ action: 'booking_cancelled_member', resourceType: 'booking', resourceId: bookingId.toString(), memberEmail: existing.userEmail || '', details: {
      member_email: existing.userEmail,
      member_name: existing.userName,
      booking_date: existing.requestDate,
      booking_time: existing.startTime,
      bay_name: resourceName,
      refunded_passes: cascadeResult.guestPassesRefunded,
      prepayment_refunds: cascadeResult.prepaymentRefunds
    }});
    
    res.json({ 
      success: true, 
      message: 'Booking cancelled successfully',
      cascade: {
        participantsNotified: cascadeResult.participantsNotified,
        guestPassesRefunded: cascadeResult.guestPassesRefunded,
        prepaymentRefunds: cascadeResult.prepaymentRefunds
      }
    });

    bookingEvents.publish('booking_cancelled', {
      bookingId,
      memberEmail: existing.userEmail || '',
      bookingDate: existing.requestDate,
      startTime: existing.startTime || '',
      resourceId: existing.resourceId || undefined,
      status: 'cancelled',
      actionBy: 'member'
    }, { 
      notifyMember: true, 
      notifyStaff: true, 
      cleanupNotifications: true 
    }).catch(err => console.error('Booking event publish failed:', err));
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to cancel booking', error, 'BOOKING_CANCEL_ERROR');
  }
});

router.post('/api/bookings/:id/checkin', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    const staffEmail = getSessionUser(req)?.email;
    
    const unpaidCheck = await pool.query(`
      SELECT bp.id, bp.display_name, bp.payment_status,
             COALESCE(bp.overage_fee_cents, 0) + COALESCE(bp.guest_fee_cents, 0) as total_fee_cents
      FROM booking_participants bp
      JOIN booking_sessions bs ON bp.session_id = bs.id
      JOIN booking_requests br ON br.session_id = bs.id
      WHERE br.id = $1 
        AND bp.payment_status NOT IN ('paid', 'waived')
        AND (COALESCE(bp.overage_fee_cents, 0) + COALESCE(bp.guest_fee_cents, 0)) > 0
    `, [bookingId]);
    
    if (unpaidCheck.rows.length > 0) {
      const unpaidNames = unpaidCheck.rows.map((r: any) => r.display_name).join(', ');
      return res.status(402).json({ 
        error: 'OUTSTANDING_BALANCE',
        message: `Cannot check in - outstanding fees for: ${unpaidNames}. Please collect payment first.`,
        unpaidParticipants: unpaidCheck.rows.map((r: any) => ({
          id: r.id,
          name: r.display_name,
          status: r.payment_status,
          feeCents: r.total_fee_cents
        }))
      });
    }
    
    const result = await db.update(bookingRequests)
      .set({ status: 'checked_in' })
      .where(eq(bookingRequests.id, bookingId))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const booking = result[0];
    res.json({ success: true, booking });

    // Publish booking event for real-time updates
    bookingEvents.publish('booking_checked_in', {
      bookingId,
      memberEmail: booking.userEmail || '',
      bookingDate: booking.requestDate,
      startTime: booking.startTime || '',
      endTime: booking.endTime || '',
      resourceId: booking.resourceId || undefined,
      status: 'checked_in',
      actionBy: 'staff',
      staffEmail: staffEmail
    }, { 
      notifyMember: true, 
      notifyStaff: true,
      cleanupNotifications: true,
      memberNotification: {
        title: 'Checked In',
        message: 'You have been checked in for your booking',
        type: 'booking_checked_in'
      }
    }).catch(err => console.error('Booking event publish failed:', err));
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to check in', error, 'CHECKIN_ERROR');
  }
});

router.post('/api/staff/bookings/manual', isStaffOrAdmin, async (req, res) => {
  try {
    const { 
      member_email, 
      resource_id, 
      booking_date, 
      start_time, 
      duration_minutes, 
      guest_count = 0, 
      booking_source, 
      notes,
      staff_notes,
      reschedule_from_id,
      trackman_booking_id
    } = req.body;

    const staffEmail = getSessionUser(req)?.email;
    if (!staffEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!member_email || !resource_id || !booking_date || !start_time || !duration_minutes || !booking_source) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const validSources = ['Trackman', 'YGB', 'Mindbody', 'Texted Concierge', 'Called', 'Other'];
    if (!validSources.includes(booking_source)) {
      return res.status(400).json({ error: 'Invalid booking source' });
    }

    const validDurations = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360];
    if (!validDurations.includes(duration_minutes)) {
      return res.status(400).json({ error: 'Invalid duration. Must be between 30 and 360 minutes in 30-minute increments.' });
    }

    const [member] = await db.select()
      .from(users)
      .where(eq(users.email, member_email));

    if (!member) {
      return res.status(404).json({ error: 'Member not found with that email' });
    }

    const [resource] = await db.select()
      .from(resources)
      .where(eq(resources.id, resource_id));

    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    let oldBookingRequest: typeof bookingRequests.$inferSelect | null = null;
    if (reschedule_from_id) {
      const [found] = await db.select()
        .from(bookingRequests)
        .where(eq(bookingRequests.id, reschedule_from_id));
      oldBookingRequest = found || null;
    }

    if (!reschedule_from_id) {
      const existingBookings = await db.select({
        id: bookingRequests.id,
        resourceType: resources.type
      })
        .from(bookingRequests)
        .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
        .where(and(
          eq(bookingRequests.userEmail, member_email.toLowerCase()),
          sql`${bookingRequests.requestDate} = ${booking_date}`,
          eq(resources.type, resource.type),
          or(
            eq(bookingRequests.status, 'confirmed'),
            eq(bookingRequests.status, 'pending'),
            eq(bookingRequests.status, 'pending_approval'),
            eq(bookingRequests.status, 'approved')
          )
        ));
      
      if (existingBookings.length > 0) {
        const resourceTypeLabel = resource.type === 'conference_room' ? 'conference room' : 'bay';
        return res.status(409).json({ 
          error: 'Member already has a booking',
          message: `This member already has a ${resourceTypeLabel} booking on ${booking_date}. Only one ${resourceTypeLabel} booking per day is allowed.`
        });
      }
    }

    const startParts = start_time.split(':').map(Number);
    const startMinutes = startParts[0] * 60 + (startParts[1] || 0);
    const endMinutes = startMinutes + duration_minutes;
    const endHour = Math.floor(endMinutes / 60);
    const endMin = endMinutes % 60;
    const end_time = `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`;

    // Check all conflicts: closures, availability blocks, and existing bookings
    const conflictCheck = await checkAllConflicts(resource_id, booking_date, start_time, end_time);
    if (conflictCheck.hasConflict) {
      if (conflictCheck.conflictType === 'closure') {
        return res.status(409).json({ 
          error: 'Time slot conflicts with a facility closure',
          message: `This time slot conflicts with "${conflictCheck.conflictTitle}".`
        });
      } else if (conflictCheck.conflictType === 'availability_block') {
        return res.status(409).json({ 
          error: 'Time slot is blocked for an event',
          message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}.`
        });
      } else {
        return res.status(409).json({ 
          error: 'Time slot already booked',
          message: 'Another booking already exists for this time slot.'
        });
      }
    }

    // Only create calendar events for conference rooms - golf/simulators no longer sync to calendar
    let calendarEventId: string | null = null;
    if (resource.type === 'conference_room') {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
        
        if (calendarId) {
          const memberName = member.firstName && member.lastName 
            ? `${member.firstName} ${member.lastName}` 
            : member_email;
          
          const summary = `Booking: ${memberName}`;
          const descriptionLines = [
            `Area: ${resource.name}`,
            `Member: ${member_email}`,
            `Guests: ${guest_count}`,
            `Source: ${booking_source}`,
            `Created by: ${staffEmail}`
          ];
          if (notes) {
            descriptionLines.push(`Notes: ${notes}`);
          }
          const description = descriptionLines.join('\n');
          
          calendarEventId = await createCalendarEventOnCalendar(
            calendarId,
            summary,
            description,
            booking_date,
            start_time,
            end_time
          );
        }
      } catch (calErr: unknown) {
        logger.error('Calendar event creation error', { error: calErr as Error, requestId: req.requestId });
      }
    }

    const memberName = member.firstName && member.lastName 
      ? `${member.firstName} ${member.lastName}` 
      : member_email;
    
    const bookingNotes = notes 
      ? `${notes}\n[Source: ${booking_source}]` 
      : `[Source: ${booking_source}]`;
    
    const [newBooking] = await db.insert(bookingRequests)
      .values({
        resourceId: resource_id,
        userEmail: member_email,
        userName: memberName,
        resourcePreference: resource.name,
        requestDate: booking_date,
        startTime: start_time,
        endTime: end_time,
        durationMinutes: duration_minutes,
        notes: bookingNotes,
        staffNotes: staff_notes || null,
        status: 'approved',
        guestCount: guest_count,
        reviewedBy: staffEmail,
        reviewedAt: new Date(),
        calendarEventId: calendarEventId,
        trackmanBookingId: trackman_booking_id || null
      })
      .returning();

    if (oldBookingRequest) {
      await db.update(bookingRequests)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(bookingRequests.id, reschedule_from_id as number));
      
      // Cancel pending payment intents for the old booking
      try {
        const pendingIntents = await pool.query(
          `SELECT stripe_payment_intent_id 
           FROM stripe_payment_intents 
           WHERE booking_id = $1 AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')`,
          [reschedule_from_id]
        );
        for (const row of pendingIntents.rows) {
          try {
            await cancelPaymentIntent(row.stripe_payment_intent_id);
            logger.info('[Reschedule] Cancelled payment intent for old booking', {
              extra: { oldBookingId: reschedule_from_id, paymentIntentId: row.stripe_payment_intent_id }
            });
          } catch (cancelErr: unknown) {
            logger.warn('[Reschedule] Failed to cancel payment intent', { 
              extra: { paymentIntentId: row.stripe_payment_intent_id, error: getErrorMessage(cancelErr) }
            });
          }
        }
      } catch (cancelIntentsErr: unknown) {
        logger.warn('[Reschedule] Failed to cancel pending payment intents', { error: cancelIntentsErr as Error });
      }
      
      // Only delete calendar events for conference room bookings
      if (oldBookingRequest.calendarEventId && oldBookingRequest.resourceId) {
        try {
          const [oldResource] = await db.select({ type: resources.type })
            .from(resources)
            .where(eq(resources.id, oldBookingRequest.resourceId));
          
          if (oldResource?.type === 'conference_room') {
            const oldCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
            if (oldCalendarId) {
              await deleteCalendarEvent(oldBookingRequest.calendarEventId, oldCalendarId);
            }
          }
        } catch (calErr: unknown) {
          logger.warn('Failed to delete old calendar event during reschedule', { error: calErr as Error, requestId: req.requestId });
        }
      }
      
      logger.info('Rescheduled booking - cancelled old, created new', { 
        oldBookingId: reschedule_from_id, 
        newBookingId: newBooking.id,
        memberEmail: member_email,
        requestId: req.requestId 
      });

      // Clean up notifications for the cancelled original booking
      bookingEvents.cleanupNotificationsForBooking(reschedule_from_id as number, { delete: true })
        .catch(err => console.error('Failed to cleanup old booking notifications:', err));
    }

    try {
      const formattedDate = new Date(booking_date + 'T00:00:00').toLocaleDateString('en-US', { 
        weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles'
      });
      const formatTime = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hour12 = h % 12 || 12;
        return `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`;
      };
      const notifTitle = 'Booking Confirmed';
      const notifMessage = `Your ${resource.type === 'simulator' ? 'golf simulator' : 'conference room'} booking for ${formattedDate} at ${formatTime(start_time)} has been confirmed.`;
      
      await db.insert(notifications).values({
        userEmail: member_email,
        title: notifTitle,
        message: notifMessage,
        type: 'booking_approved',
        relatedId: newBooking.id,
        relatedType: 'booking'
      });
      
      await sendPushNotification(member_email, {
        title: notifTitle,
        body: notifMessage,
        url: '/dashboard'
      });
      
      // Send WebSocket notification to member (DB notification already inserted above)
      sendNotificationToUser(member_email, {
        type: 'notification',
        title: notifTitle,
        message: notifMessage,
        data: { bookingId: newBooking.id, eventType: 'booking_approved' }
      }, { action: 'manual_booking', bookingId: newBooking.id, resourceType: resource.type, triggerSource: 'resources.ts' });
    } catch (notifErr: unknown) {
      logger.error('Failed to send manual booking notification', { error: notifErr as Error, requestId: req.requestId });
    }

    // Publish booking event for real-time updates
    bookingEvents.publish('booking_approved', {
      bookingId: newBooking.id,
      memberEmail: member_email,
      memberName: memberName,
      resourceId: resource_id,
      resourceName: resource.name,
      resourceType: resource.type,
      bookingDate: booking_date,
      startTime: start_time,
      endTime: end_time,
      status: 'approved',
      actionBy: 'staff',
      staffEmail: staffEmail,
      isManualBooking: true
    }, { notifyMember: true, notifyStaff: true }).catch(err => console.error('Booking event publish failed:', err));

    res.status(201).json({
      success: true,
      booking: {
        ...newBooking,
        resource_name: resource.name,
        resource_type: resource.type,
        member_name: member.firstName && member.lastName 
          ? `${member.firstName} ${member.lastName}` 
          : null
      },
      message: 'Booking created successfully'
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to create manual booking', error, 'MANUAL_BOOKING_ERROR');
  }
});

export default router;
