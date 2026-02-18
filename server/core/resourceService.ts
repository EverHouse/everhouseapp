import { eq, and, or, sql, desc, asc, ne } from 'drizzle-orm';
import { db } from '../db';
import { pool } from './db';
import { resources, users, facilityClosures, notifications, bookingRequests, bookingParticipants, bookingMembers, bookingGuests, staffUsers, availabilityBlocks, trackmanUnmatchedBookings, userLinkedEmails } from '../../shared/schema';
import { isAuthorizedForMemberBooking } from './bookingAuth';
import { createCalendarEventOnCalendar, getCalendarIdByName, deleteCalendarEvent, CALENDAR_CONFIG } from './calendar/index';
import { logger } from './logger';
import { sendPushNotification } from '../routes/push';
import { DEFAULT_TIER } from '../../shared/constants/tiers';
import { withRetry } from './retry';
import { checkDailyBookingLimit } from './tierService';
import { bookingEvents } from './bookingEvents';
import { sendNotificationToUser, broadcastAvailabilityUpdate } from './websocket';
import { checkAllConflicts, parseTimeToMinutes } from './bookingValidation';
import { notifyMember, notifyAllStaff } from './notificationService';
import { refundGuestPass } from '../routes/guestPasses';
import { createPacificDate, formatDateDisplayWithDay, formatTime12Hour } from '../utils/dateUtils';
import { logMemberAction } from './auditLog';
import { recalculateSessionFees } from './billing/unifiedFeeService';
import { cancelPaymentIntent, getStripeClient } from './stripe';
import { createPrepaymentIntent } from './billing/prepaymentService';
import { ensureSessionForBooking } from './bookingService/sessionManager';
import { getErrorMessage, getErrorCode, getErrorStatusCode } from '../utils/errorUtils';
import { normalizeToISODate } from '../utils/dateNormalize';

export interface CancellationCascadeResult {
  participantsNotified: number;
  guestPassesRefunded: number;
  bookingMembersRemoved: number;
  prepaymentRefunds: number;
  errors: string[];
}

export async function handleCancellationCascade(
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

    const pendingIntents = await client.query(
      `SELECT stripe_payment_intent_id 
       FROM stripe_payment_intents 
       WHERE booking_id = $1 AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')`,
      [bookingId]
    );

    await client.query('COMMIT');
    
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

    const succeededIntents = await pool.query(
      `SELECT spi.stripe_payment_intent_id, spi.amount_cents, spi.stripe_customer_id, spi.user_id
       FROM stripe_payment_intents spi
       WHERE spi.booking_id = $1 AND spi.purpose = 'prepayment' AND spi.status = 'succeeded'`,
      [bookingId]
    );

    for (const row of succeededIntents.rows) {
      try {
        const claimResult = await pool.query(
          `UPDATE stripe_payment_intents 
           SET status = 'refunding', updated_at = NOW() 
           WHERE stripe_payment_intent_id = $1 AND status = 'succeeded'
           RETURNING stripe_payment_intent_id`,
          [row.stripe_payment_intent_id]
        );
        
        if (claimResult.rowCount === 0) {
          logger.info('[cancellation-cascade] Prepayment already claimed or refunded, skipping', {
            extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
          });
          continue;
        }
        
        const stripe = await getStripeClient();
        
        if (row.stripe_payment_intent_id.startsWith('balance-')) {
          if (row.stripe_customer_id) {
            const balanceTransaction = await stripe.customers.createBalanceTransaction(
              row.stripe_customer_id,
              {
                amount: -row.amount_cents,
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
          const paymentIntent = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
          
          if (paymentIntent.status === 'succeeded' && paymentIntent.latest_charge) {
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
            await pool.query(
              `UPDATE stripe_payment_intents 
               SET status = 'succeeded', updated_at = NOW() 
               WHERE stripe_payment_intent_id = $1`,
              [row.stripe_payment_intent_id]
            );
          }
        }
      } catch (refundErr: unknown) {
        await pool.query(
          `UPDATE stripe_payment_intents 
           SET status = 'succeeded', updated_at = NOW() 
           WHERE stripe_payment_intent_id = $1 AND status = 'refunding'`,
          [row.stripe_payment_intent_id]
        ).catch(() => {});
        
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

export async function fetchAllResources() {
  return withRetry(() =>
    db.select()
      .from(resources)
      .orderBy(asc(resources.type), asc(resources.name))
  );
}

export async function checkExistingBookings(userEmail: string, date: string, resourceType: string) {
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
        eq(resources.type, resourceType),
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
  
  return {
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
  };
}

export async function checkExistingBookingsForStaff(memberEmail: string, date: string, resourceType: string) {
  const existingBookings = await db.select({
    id: bookingRequests.id,
    resourceType: resources.type
  })
    .from(bookingRequests)
    .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
    .where(and(
      eq(bookingRequests.userEmail, memberEmail.toLowerCase()),
      sql`${bookingRequests.requestDate} = ${date}`,
      eq(resources.type, resourceType),
      or(
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'pending'),
        eq(bookingRequests.status, 'pending_approval'),
        eq(bookingRequests.status, 'approved')
      )
    ));
  
  return { 
    hasExisting: existingBookings.length > 0,
    count: existingBookings.length
  };
}

export async function fetchBookings(params: {
  userEmail?: string | null;
  date?: string | null;
  resourceId?: string | null;
  status?: string | null;
  includeAll?: boolean;
  includeArchived?: boolean;
}) {
  let conditions: ReturnType<typeof eq | typeof sql>[] = [];
  
  if (!params.includeArchived) {
    conditions.push(sql`${bookingRequests.archivedAt} IS NULL`);
  }
  
  if (params.status) {
    conditions.push(eq(bookingRequests.status, params.status));
  } else if (params.includeAll) {
  } else {
    conditions.push(or(
      eq(bookingRequests.status, 'confirmed'),
      eq(bookingRequests.status, 'approved'),
      eq(bookingRequests.status, 'pending_approval'),
      eq(bookingRequests.status, 'pending'),
      eq(bookingRequests.status, 'attended')
    ));
  }
  
  if (params.userEmail) {
    const userEmail = params.userEmail.toLowerCase();
    conditions.push(or(
      eq(bookingRequests.userEmail, userEmail),
      sql`${bookingRequests.id} IN (SELECT booking_id FROM booking_members WHERE LOWER(user_email) = ${userEmail})`
    ));
  }
  if (params.date) {
    conditions.push(sql`${bookingRequests.requestDate} = ${params.date}`);
  }
  if (params.resourceId) {
    conditions.push(eq(bookingRequests.resourceId, parseInt(params.resourceId)));
  }
  
  return withRetry(() =>
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
}

export async function fetchPendingBookings() {
  return withRetry(() =>
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
}

export async function approveBooking(bookingId: number) {
  const result = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
    
    if (!booking) {
      throw { statusCode: 404, error: 'Booking not found' };
    }
    
    const conflictCheck = await checkAllConflicts(
      booking.resourceId!,
      booking.requestDate,
      booking.startTime,
      booking.endTime,
      bookingId
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
    
    if (updated.resourceId) {
      try {
        const dateStr = typeof updated.requestDate === 'string'
          ? updated.requestDate
          : (updated.requestDate as unknown) instanceof Date
            ? (updated.requestDate as Date).toISOString().split('T')[0]
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
        logger.error('[Resource Confirmation] Failed to ensure session', { extra: { error: sessionErr } });
      }
    }

    return updated;
  });
  
  broadcastAvailabilityUpdate({
    resourceId: result.resourceId || undefined,
    date: result.requestDate,
    action: 'booked'
  });
  
  sendNotificationToUser(result.userEmail, {
    type: 'booking_update',
    title: 'Booking Confirmed',
    message: `Your booking for ${result.requestDate} at ${result.startTime?.substring(0, 5) || ''} has been approved.`,
    data: { bookingId, status: 'confirmed' }
  });
  
  return result;
}

export async function declineBooking(bookingId: number, reason?: string) {
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
    
    if (!existing) {
      throw { statusCode: 404, error: 'Booking not found' };
    }
    
    const [updated] = await tx.update(bookingRequests)
      .set({ 
        status: 'declined',
        trackmanExternalId: null
      })
      .where(eq(bookingRequests.id, bookingId))
      .returning();
    
    return updated;
  });
  
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
  
  sendNotificationToUser(result.userEmail, {
    type: 'booking_update',
    title: 'Booking Declined',
    message: 'Your booking request has been declined.',
    data: { bookingId, status: 'declined' }
  });
  
  return result;
}

export async function assignMemberToBooking(bookingId: number, memberEmail: string, memberName: string, memberId?: string) {
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
        userEmail: memberEmail.toLowerCase(),
        userName: memberName,
        userId: memberId || null,
        isUnmatched: false,
        status: 'approved',
        staffNotes: sql`COALESCE(${bookingRequests.staffNotes}, '') || ' [Member assigned by staff: ' || ${memberName} || ']'`,
        updatedAt: new Date()
      })
      .where(eq(bookingRequests.id, bookingId))
      .returning();
    
    return updated;
  });
  
  const { broadcastToStaff } = await import('./websocket');
  broadcastToStaff({
    type: 'booking_updated',
    bookingId,
    action: 'member_assigned',
    memberEmail: memberEmail,
    memberName: memberName
  });
  
  const formattedDate = result.requestDate ? new Date(result.requestDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
  const formattedTime = result.startTime || '';
  
  if (memberEmail) {
    await pool.query(
      `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        memberEmail.toLowerCase(),
        'Booking Confirmed',
        `Your simulator booking for ${formattedDate} at ${formattedTime} has been confirmed.`,
        'booking',
        'booking'
      ]
    );
  }
  
  sendNotificationToUser(memberEmail, {
    type: 'booking_confirmed',
    title: 'Booking Confirmed',
    message: `Your simulator booking for ${formattedDate} at ${formattedTime} has been confirmed.`,
    data: { bookingId },
  });
  
  return result;
}

export async function resolveOwnerEmail(ownerEmail: string) {
  let resolvedOwnerEmail = ownerEmail.toLowerCase().trim();
  
  const [linkedEmailRecord] = await db.select({ primaryEmail: userLinkedEmails.primaryEmail })
    .from(userLinkedEmails)
    .where(sql`LOWER(${userLinkedEmails.linkedEmail}) = ${resolvedOwnerEmail}`);
  
  if (linkedEmailRecord?.primaryEmail) {
    resolvedOwnerEmail = linkedEmailRecord.primaryEmail.toLowerCase();
    logger.info('[link-trackman-to-member] Resolved email alias via user_linked_emails', {
      extra: { original: ownerEmail, resolved: resolvedOwnerEmail }
    });
  }
  
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
  
  return resolvedOwnerEmail;
}

export async function checkIsInstructor(email: string) {
  const instructorCheck = await db.select({
    id: staffUsers.id,
    email: staffUsers.email,
    role: staffUsers.role,
    isActive: staffUsers.isActive,
    name: staffUsers.name
  })
    .from(staffUsers)
    .where(and(
      sql`LOWER(${staffUsers.email}) = ${email}`,
      eq(staffUsers.role, 'golf_instructor'),
      eq(staffUsers.isActive, true)
    ))
    .limit(1);
  
  return instructorCheck.length > 0;
}

export async function getBookingDataForTrackman(trackmanBookingId: string) {
  let bookingData: { resourceId: number | null; requestDate: string; startTime: string; endTime: string | null } | null = null;
  
  const [existingBooking] = await db.select({
    id: bookingRequests.id,
    resourceId: bookingRequests.resourceId,
    requestDate: bookingRequests.requestDate,
    startTime: bookingRequests.startTime,
    endTime: bookingRequests.endTime
  })
    .from(bookingRequests)
    .where(eq(bookingRequests.trackmanBookingId, trackmanBookingId));
  
  if (existingBooking) {
    bookingData = {
      resourceId: existingBooking.resourceId,
      requestDate: existingBooking.requestDate,
      startTime: existingBooking.startTime,
      endTime: existingBooking.endTime
    };
    return { bookingData, existingBooking };
  }
  
  const [unmatchedBooking] = await db.select({
    id: trackmanUnmatchedBookings.id,
    bayNumber: trackmanUnmatchedBookings.bayNumber,
    bookingDate: trackmanUnmatchedBookings.bookingDate,
    startTime: trackmanUnmatchedBookings.startTime,
    endTime: trackmanUnmatchedBookings.endTime
  })
    .from(trackmanUnmatchedBookings)
    .where(eq(trackmanUnmatchedBookings.trackmanBookingId, trackmanBookingId));
  
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
    return { bookingData, existingBooking: null };
  }
  
  const webhookResult = await pool.query(
    `SELECT payload FROM trackman_webhook_events WHERE trackman_booking_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [trackmanBookingId]
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
  
  return { bookingData, existingBooking: null };
}

export async function convertToInstructorBlock(
  trackmanBookingId: string,
  ownerName: string,
  ownerEmail: string,
  bookingData: { resourceId: number | null; requestDate: string; startTime: string; endTime: string | null },
  existingBooking: { id: number } | null,
  staffEmail: string
) {
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
    createdBy: staffEmail
  } as typeof facilityClosures.$inferInsert).returning();
  
  await db.insert(availabilityBlocks).values({
    closureId: closure.id,
    resourceId: bookingData.resourceId,
    blockDate: bookingData.requestDate,
    startTime: bookingData.startTime,
    endTime: bookingData.endTime || bookingData.startTime,
    blockType: 'blocked',
    notes: `Lesson - ${ownerName}`,
    createdBy: staffEmail
  });
  
  if (existingBooking) {
    await db.delete(bookingRequests).where(eq(bookingRequests.id, existingBooking.id));
    logger.info('[link-trackman-to-member] Deleted existing booking after converting to availability block', {
      extra: { bookingId: existingBooking.id, trackman_booking_id: trackmanBookingId }
    });
  }
  
  await db.delete(trackmanUnmatchedBookings)
    .where(eq(trackmanUnmatchedBookings.trackmanBookingId, trackmanBookingId));
  
  await pool.query(
    `UPDATE trackman_webhook_events SET matched_booking_id = NULL, processed_at = NOW() WHERE trackman_booking_id = $1`,
    [trackmanBookingId]
  );
  
  const { broadcastToStaff } = await import('./websocket');
  broadcastToStaff({
    type: 'availability_block_created',
    closureId: closure.id,
    instructorEmail: ownerEmail,
    instructorName: ownerName
  });
  
  return closure;
}

export async function linkTrackmanToMember(
  trackmanBookingId: string,
  ownerEmail: string,
  ownerName: string,
  ownerId: string | null,
  additionalPlayers: Array<{ type: 'member' | 'guest_placeholder'; member_id?: string; email?: string; name?: string; guest_name?: string }>,
  totalPlayerCount: number,
  guestCount: number,
  staffEmail: string
) {
  const result = await db.transaction(async (tx) => {
    const [existingBooking] = await tx.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.trackmanBookingId, trackmanBookingId));
    
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
        WHERE trackman_booking_id = ${trackmanBookingId}
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const webhookLog = (webhookResult as { rows?: Record<string, unknown>[] }).rows?.[0] ?? (webhookResult as Record<string, unknown>[])[0];
      
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
          trackmanBookingId: trackmanBookingId,
          isUnmatched: false,
          declaredPlayerCount: totalPlayerCount,
          guestCount: guestCount,
          staffNotes: `[Linked from Trackman webhook by staff: ${ownerName} with ${totalPlayerCount} players]`,
          createdAt: new Date(),
          updatedAt: new Date()
        } as typeof bookingRequests.$inferInsert)
        .returning();
      booking = newBooking;
      created = true;
      
      await tx.execute(sql`
        UPDATE trackman_webhook_events 
        SET matched_booking_id = ${booking.id}
        WHERE trackman_booking_id = ${trackmanBookingId}
      `);
    }
    
    await tx.delete(bookingMembers).where(eq(bookingMembers.bookingId, booking.id));
    await tx.delete(bookingGuests).where(eq(bookingGuests.bookingId, booking.id));
    
    await tx.insert(bookingMembers).values({
      bookingId: booking.id,
      userEmail: ownerEmail.toLowerCase(),
      slotNumber: 1,
      isPrimary: true,
      trackmanBookingId: trackmanBookingId,
      linkedAt: new Date(),
      linkedBy: staffEmail
    });
    
    let slotNumber = 2;
    for (const player of additionalPlayers) {
      if (player.type === 'member') {
        await tx.insert(bookingMembers).values({
          bookingId: booking.id,
          userEmail: player.email?.toLowerCase(),
          slotNumber,
          isPrimary: false,
          trackmanBookingId: trackmanBookingId,
          linkedAt: new Date(),
          linkedBy: staffEmail
        });
      } else if (player.type === 'guest_placeholder') {
        await tx.insert(bookingGuests).values({
          bookingId: booking.id,
          guestName: player.guest_name || 'Guest (info pending)',
          slotNumber,
          trackmanBookingId: trackmanBookingId
        });
      }
      slotNumber++;
    }
    
    const sessionId = existingBooking?.sessionId || null;
    return { booking, created, sessionId };
  });
  
  if (result.sessionId) {
    try {
      await recalculateSessionFees(result.sessionId, 'approval');
      logger.info('[link-trackman-to-member] Recalculated fees after member assignment', {
        extra: { bookingId: result.booking.id, sessionId: result.sessionId, newOwner: ownerEmail }
      });
    } catch (recalcErr: unknown) {
      logger.warn('[link-trackman-to-member] Failed to recalculate fees after assignment', {
        extra: { bookingId: result.booking.id, sessionId: result.sessionId, error: recalcErr }
      });
    }
  }
  
  const { broadcastToStaff } = await import('./websocket');
  broadcastToStaff({
    type: 'booking_updated',
    bookingId: result.booking.id,
    action: 'trackman_linked',
    memberEmail: ownerEmail,
    memberName: ownerName,
    totalPlayers: totalPlayerCount
  });
  
  return result;
}

export async function linkEmailToMember(ownerEmail: string, originalEmail: string) {
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
           ON CONFLICT (linked_email) DO NOTHING`,
          [member.email, originalEmail.toLowerCase(), 'staff_assignment']
        );
        logger.info('[resourceService] Linked email to member', {
          extra: { memberEmail: ownerEmail, linkedEmail: originalEmail, memberId: member.id }
        });
        return true;
      }
    }
  } catch (linkErr: unknown) {
    logger.warn('[resourceService] Failed to link email', { extra: { error: linkErr } });
  }
  return false;
}

export async function fetchOverlappingNotices(params: {
  startDate: string;
  endDate?: string;
  startTime: string;
  endTime: string;
  sameDayOnly: boolean;
}) {
  const queryDate = normalizeToISODate(params.startDate);
  const queryEndDate = normalizeToISODate(params.endDate || queryDate);
  const queryStartTime = params.startTime;
  const queryEndTime = params.endTime;
  
  const timeOverlapCondition = params.sameDayOnly
    ? ''
    : `AND (
        (fc.start_time IS NULL AND fc.end_time IS NULL)
        OR (fc.start_time < $4 AND fc.end_time > $3)
      )`;
  
  const sqlParams = params.sameDayOnly
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
  `, sqlParams);
  
  return result.rows;
}

export async function markBookingAsEvent(params: {
  bookingId?: number;
  trackmanBookingId?: string;
  existingClosureId?: number;
  staffEmail: string;
}) {
  let primaryBooking: typeof bookingRequests.$inferSelect | undefined;
  let isFromUnmatched = false;
  
  if (params.bookingId) {
    const [booking] = await db.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.id, params.bookingId));
    primaryBooking = booking;
  } else if (params.trackmanBookingId) {
    const [booking] = await db.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.trackmanBookingId, params.trackmanBookingId));
    primaryBooking = booking;
  }
  
  if (!primaryBooking && params.trackmanBookingId) {
    const { trackmanUnmatchedBookings } = await import('../../shared/models/scheduling');
    const [unmatchedBooking] = await db.select()
      .from(trackmanUnmatchedBookings)
      .where(eq(trackmanUnmatchedBookings.trackmanBookingId, params.trackmanBookingId));
    
    if (unmatchedBooking) {
      let resourceId: number | null = null;
      if (unmatchedBooking.bayNumber) {
        const [resource] = await db.select()
          .from(resources)
          .where(eq(resources.name, `Bay ${unmatchedBooking.bayNumber}`));
        resourceId = resource?.id ?? null;
      }
      
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
    throw { statusCode: 404, error: 'Booking not found' };
  }
  
  const userName = primaryBooking.userName?.toLowerCase()?.trim();
  const bookingDate = primaryBooking.requestDate;
  const startTime = primaryBooking.startTime;
  let endTime = primaryBooking.endTime;
  if (!endTime && primaryBooking.durationMinutes && startTime) {
    const startMinutes = parseTimeToMinutes(startTime);
    const endMinutes = startMinutes + primaryBooking.durationMinutes;
    const endHours = Math.floor(endMinutes / 60);
    const endMins = endMinutes % 60;
    endTime = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}:00`;
  }
  if (!endTime && startTime) {
    const startMinutes = parseTimeToMinutes(startTime);
    const endMinutes = startMinutes + 60;
    const endHours = Math.floor(endMinutes / 60);
    const endMins = endMinutes % 60;
    endTime = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}:00`;
  }
  
  let relatedBookings: (typeof bookingRequests.$inferSelect)[] = [];
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
  
  if (relatedBookings.length === 0) {
    relatedBookings = [primaryBooking];
    if (isFromUnmatched && !relatedUnmatchedIds.includes(primaryBooking.id)) {
      relatedUnmatchedIds = [primaryBooking.id];
    }
  }
  
  const resourceIds = [...new Set(relatedBookings.map(b => b.resourceId).filter(Boolean))] as number[];
  const bookingIds = relatedBookings.map(b => b.id);
  
  const eventTitle = primaryBooking.userName || 'Private Event';
  
  const result = await db.transaction(async (tx) => {
    let closure: typeof facilityClosures.$inferSelect | null = null;
    let linkedToExisting = false;
    
    if (params.existingClosureId) {
      const [existingClosure] = await tx.select()
        .from(facilityClosures)
        .where(and(
          eq(facilityClosures.id, params.existingClosureId),
          eq(facilityClosures.isActive, true)
        ));
      
      if (existingClosure) {
        closure = existingClosure;
        linkedToExisting = true;
      }
    }
    
    if (!closure) {
      const existingClosures = await tx.select()
        .from(facilityClosures)
        .where(and(
          eq(facilityClosures.startDate, bookingDate),
          eq(facilityClosures.startTime, startTime),
          eq(facilityClosures.endTime, endTime),
          eq(facilityClosures.noticeType, 'private_event'),
          eq(facilityClosures.isActive, true)
        ));
      
      closure = existingClosures[0];
      if (closure) linkedToExisting = true;
    }
    
    const existingBlocks = resourceIds.length > 0 ? await tx.select()
      .from(availabilityBlocks)
      .where(and(
        eq(availabilityBlocks.blockDate, bookingDate),
        sql`${availabilityBlocks.resourceId} IN (${sql.join(resourceIds.map(id => sql`${id}`), sql`, `)})`,
        sql`${availabilityBlocks.startTime} < ${endTime}`,
        sql`${availabilityBlocks.endTime} > ${startTime}`
      )) : [];
    
    const blockedResourceIds = new Set(existingBlocks.map(b => b.resourceId));
    const unblockResourceIds = resourceIds.filter(id => !blockedResourceIds.has(id));
    
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
        createdBy: params.staffEmail
      }).returning();
      closure = newClosure;
    }
    
    if (unblockResourceIds.length > 0 && closure) {
      const blockValues = unblockResourceIds.map(resourceId => ({
        resourceId,
        blockDate: bookingDate,
        startTime: startTime,
        endTime: endTime,
        blockType: 'blocked',
        notes: `Private Event: ${eventTitle}`,
        closureId: closure.id,
        createdBy: params.staffEmail
      }));
      
      await tx.insert(availabilityBlocks).values(blockValues);
    }
    
    const unmatchedInBookingRequests = bookingIds.filter(id => {
      const booking = relatedBookings.find(b => b.id === id);
      return booking?.isUnmatched === true || 
             !booking?.userEmail ||
             (booking?.userEmail && (booking.userEmail.includes('unmatched-') || booking.userEmail.includes('@trackman.local')));
    });
    const regularBookingIds = bookingIds.filter(id => !relatedUnmatchedIds.includes(id) && !unmatchedInBookingRequests.includes(id));
    
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
    
    if (regularBookingIds.length > 0) {
      await tx.delete(bookingMembers).where(sql`booking_id IN (${sql.join(regularBookingIds.map(id => sql`${id}`), sql`, `)})`);
      await tx.delete(bookingGuests).where(sql`booking_id IN (${sql.join(regularBookingIds.map(id => sql`${id}`), sql`, `)})`);
      await tx.delete(bookingRequests).where(sql`id IN (${sql.join(regularBookingIds.map(id => sql`${id}`), sql`, `)})`);
    }
    
    if (relatedUnmatchedIds.length > 0) {
      const { trackmanUnmatchedBookings } = await import('../../shared/models/scheduling');
      await tx.update(trackmanUnmatchedBookings)
        .set({
          resolvedAt: new Date(),
          resolvedBy: params.staffEmail,
          resolvedEmail: 'PRIVATE_EVENT',
        })
        .where(sql`id IN (${sql.join(relatedUnmatchedIds.map(id => sql`${id}`), sql`, `)})`);
    }
    
    return { closure, bookingIds, resourceIds, linkedToExisting, newBlocksCreated: unblockResourceIds.length, resolvedUnmatchedCount: relatedUnmatchedIds.length };
  });
  
  const { broadcastToStaff, broadcastClosureUpdate } = await import('./websocket');
  broadcastToStaff({
    type: 'booking_updated',
    action: 'converted_to_private_event',
    bookingIds: result.bookingIds,
    closureId: result.closure?.id
  });
  
  if (result.closure) {
    broadcastClosureUpdate('created', result.closure.id);
  }
  
  let message = `Converted ${result.bookingIds.length} booking(s) to private event`;
  if (result.linkedToExisting) {
    message += ' (linked to existing notice)';
  }
  if (result.newBlocksCreated === 0) {
    message += ' - all blocks already existed';
  } else if (result.newBlocksCreated < result.resourceIds.length) {
    message += ` - created ${result.newBlocksCreated} new block(s)`;
  }
  
  return { 
    primaryBooking,
    eventTitle,
    message,
    closureId: result.closure?.id,
    convertedBookingIds: result.bookingIds,
    resourceIds: result.resourceIds,
    linkedToExisting: result.linkedToExisting,
    newBlocksCreated: result.newBlocksCreated
  };
}

export async function assignWithPlayers(
  bookingId: number,
  owner: { email: string; name: string; member_id?: string },
  additionalPlayers: Array<{ type: 'member' | 'guest_placeholder'; member_id?: string; email?: string; name?: string; guest_name?: string }>,
  staffEmail: string
) {
  const totalPlayerCount = 1 + additionalPlayers.filter(p => p.type === 'member' || p.type === 'guest_placeholder').length;
  const guestCount = additionalPlayers.filter(p => p.type === 'guest_placeholder').length;
  
  const result = await db.transaction(async (tx) => {
    const [existingBooking] = await tx.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));
    
    if (!existingBooking) {
      throw { statusCode: 404, error: 'Booking not found' };
    }
    
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
      linkedBy: staffEmail
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
          linkedBy: staffEmail
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
      await recalculateSessionFees(result.sessionId, 'approval');
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
  
  const { broadcastToStaff } = await import('./websocket');
  broadcastToStaff({
    type: 'booking_updated',
    bookingId: result.booking.id,
    action: 'players_assigned',
    memberEmail: owner.email,
    memberName: owner.name,
    totalPlayers: totalPlayerCount
  });
  
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
  
  return { booking: result.booking, totalPlayerCount, guestCount, sessionId: result.sessionId };
}

export async function changeBookingOwner(bookingId: number, newEmail: string, newName: string, memberId?: string) {
  const [existingBooking] = await db.select()
    .from(bookingRequests)
    .where(eq(bookingRequests.id, bookingId));
  
  if (!existingBooking) {
    throw { statusCode: 404, error: 'Booking not found' };
  }
  
  const previousOwner = existingBooking.userName || existingBooking.userEmail;
  
  const [updated] = await db.update(bookingRequests)
    .set({
      userEmail: newEmail.toLowerCase(),
      userName: newName,
      userId: memberId || null,
      isUnmatched: false,
      status: 'approved',
      staffNotes: sql`COALESCE(${bookingRequests.staffNotes}, '') || ' [Owner changed from ' || ${previousOwner} || ' to ' || ${newName} || ' by staff]'`,
      updatedAt: new Date()
    })
    .where(eq(bookingRequests.id, bookingId))
    .returning();
  
  const { broadcastToStaff } = await import('./websocket');
  broadcastToStaff({
    type: 'booking_updated',
    bookingId: updated.id,
    action: 'owner_changed',
    previousOwner,
    newOwnerEmail: newEmail,
    newOwnerName: newName
  });
  
  return { booking: updated, previousOwner };
}

export async function createBookingRequest(params: {
  resourceId: number;
  userEmail: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  notes?: string;
}) {
  const userResult = await db.select({
    id: users.id,
    tier: users.tier,
    tags: users.tags,
    firstName: users.firstName,
    lastName: users.lastName
  })
    .from(users)
    .where(eq(users.email, params.userEmail));
  
  const user = userResult[0];
  const userTier = user?.tier || DEFAULT_TIER;
  
  const isMemberAuthorized = await isAuthorizedForMemberBooking(userTier);
  
  if (!isMemberAuthorized) {
    throw { 
      statusCode: 402,
      error: 'Membership upgrade required',
      bookingType: 'upgrade_required',
      message: 'Simulator booking is available for Core, Premium, VIP, and Corporate members'
    };
  }
  
  const startParts = params.startTime.split(':').map(Number);
  const endParts = params.endTime.split(':').map(Number);
  const durationMinutes = (endParts[0] * 60 + endParts[1]) - (startParts[0] * 60 + startParts[1]);
  
  let resourceType = 'simulator';
  if (params.resourceId) {
    const resourceResult = await pool.query(
      `SELECT type FROM resources WHERE id = $1`,
      [params.resourceId]
    );
    resourceType = resourceResult.rows[0]?.type || 'simulator';
  }
  
  const limitCheck = await checkDailyBookingLimit(params.userEmail, params.bookingDate, durationMinutes, userTier, resourceType);
  if (!limitCheck.allowed) {
    throw {
      statusCode: 403,
      error: limitCheck.reason,
      remainingMinutes: limitCheck.remainingMinutes
    };
  }
  
  const existingResult = await db.select()
    .from(bookingRequests)
    .where(and(
      eq(bookingRequests.resourceId, params.resourceId),
      sql`${bookingRequests.requestDate} = ${params.bookingDate}`,
      or(
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'pending_approval')
      ),
      or(
        and(
          sql`${bookingRequests.startTime} <= ${params.startTime}`,
          sql`${bookingRequests.endTime} > ${params.startTime}`
        ),
        and(
          sql`${bookingRequests.startTime} < ${params.endTime}`,
          sql`${bookingRequests.endTime} >= ${params.endTime}`
        ),
        and(
          sql`${bookingRequests.startTime} >= ${params.startTime}`,
          sql`${bookingRequests.endTime} <= ${params.endTime}`
        )
      )
    ));
  
  if (existingResult.length > 0) {
    throw { statusCode: 409, error: 'This time slot is already requested or booked' };
  }
  
  const conflictCheck = await checkAllConflicts(params.resourceId, params.bookingDate, params.startTime, params.endTime);
  if (conflictCheck.hasConflict) {
    if (conflictCheck.conflictType === 'closure') {
      throw { 
        statusCode: 409,
        error: 'Time slot conflicts with a facility closure',
        message: `This time slot conflicts with "${conflictCheck.conflictTitle}".`
      };
    } else if (conflictCheck.conflictType === 'availability_block') {
      throw { 
        statusCode: 409,
        error: 'Time slot is blocked for an event',
        message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}.`
      };
    } else {
      throw { 
        statusCode: 409,
        error: 'Time slot already booked',
        message: 'Another booking already exists for this time slot.'
      };
    }
  }
  
  const userName = user?.firstName && user?.lastName 
    ? `${user.firstName} ${user.lastName}` 
    : params.userEmail;
  
  const result = await db.insert(bookingRequests)
    .values({
      resourceId: params.resourceId,
      userEmail: params.userEmail.toLowerCase(),
      userName: userName,
      requestDate: params.bookingDate,
      startTime: params.startTime,
      endTime: params.endTime,
      durationMinutes: durationMinutes,
      notes: params.notes || null,
      status: 'pending_approval'
    })
    .returning();
  
  return result[0];
}

export async function getCascadePreview(bookingId: number) {
  const [booking] = await db.select({
    id: bookingRequests.id,
    sessionId: bookingRequests.sessionId
  })
  .from(bookingRequests)
  .where(eq(bookingRequests.id, bookingId));
  
  if (!booking) {
    throw { statusCode: 404, error: 'Booking not found' };
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
  
  return {
    bookingId,
    relatedData: {
      participants: participantsCount,
      linkedMembers: membersCount
    },
    hasRelatedData: participantsCount > 0 || membersCount > 0
  };
}

export async function deleteBooking(bookingId: number, archivedBy: string, hardDelete: boolean) {
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
    throw { statusCode: 404, error: 'Booking not found' };
  }
  
  if (!hardDelete && booking.archivedAt) {
    throw { statusCode: 400, error: 'Booking is already archived' };
  }
  
  let resourceName: string | undefined;
  if (booking.resourceId) {
    const [resource] = await db.select({ name: resources.name, type: resources.type })
      .from(resources)
      .where(eq(resources.id, booking.resourceId));
    resourceName = resource?.name;
  }
  
  let cascadeResult: CancellationCascadeResult | undefined;
  
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
    
    cascadeResult = await handleCancellationCascade(
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
      logger.error('Failed to delete calendar event (non-blocking)', { extra: { error: calError } });
    }
  }
  
  return { hardDeleted: hardDelete, archived: !hardDelete, archivedBy };
}

export async function memberCancelBooking(bookingId: number, userEmail: string, sessionUserRole: string | undefined, actingAsEmail?: string) {
  const isAdminViewingAs = (sessionUserRole === 'admin' || sessionUserRole === 'staff') && actingAsEmail;
  
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
    throw { statusCode: 404, error: 'Booking not found' };
  }
  
  const bookingEmail = existing.userEmail?.toLowerCase();
  
  const isOwnBooking = bookingEmail === userEmail;
  const isValidViewAs = isAdminViewingAs && bookingEmail === actingAsEmail;
  
  if (!isOwnBooking && !isValidViewAs) {
    throw { 
      statusCode: 403, 
      error: 'You can only cancel your own bookings',
      _logData: {
        bookingId,
        bookingEmail: existing.userEmail,
        sessionEmail: userEmail,
        actingAsEmail: actingAsEmail || 'none',
        normalizedBookingEmail: bookingEmail,
        normalizedSessionEmail: userEmail
      }
    };
  }
  
  if (existing.status === 'cancelled') {
    throw { statusCode: 400, error: 'Booking is already cancelled' };
  }
  if (existing.status === 'cancellation_pending') {
    throw { statusCode: 400, error: 'Cancellation is already in progress' };
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
    ).catch(err => logger.error('Staff cancellation notification failed', { extra: { error: err } }));
    
    await db.insert(notifications).values({
      userEmail: existing.userEmail || '',
      title: 'Cancellation Request Submitted',
      message: `Your cancellation request for ${bookingDate} at ${bookingTime} has been submitted. You'll be notified once it's fully processed.`,
      type: 'cancellation_pending',
      relatedId: bookingId,
      relatedType: 'booking_request'
    });
    
    return { 
      success: true, 
      status: 'cancellation_pending',
      message: 'Cancellation request submitted. You will be notified once it is fully processed.',
      existing,
      isPending: true
    };
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
      trackmanExternalId: null
    })
    .where(eq(bookingRequests.id, bookingId));
  
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
    logger.error('Staff notification failed', { extra: { error: staffNotifyErr } });
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
      logger.error('Failed to delete calendar event (non-blocking)', { extra: { error: calError } });
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
  }).catch(err => logger.error('Booking event publish failed', { extra: { error: err } }));
  
  return { 
    success: true,
    existing,
    cascadeResult,
    isPending: false,
    message: 'Booking cancelled successfully',
    cascade: {
      participantsNotified: cascadeResult.participantsNotified,
      guestPassesRefunded: cascadeResult.guestPassesRefunded,
      prepaymentRefunds: cascadeResult.prepaymentRefunds
    }
  };
}

export async function checkinBooking(bookingId: number, staffEmail: string | undefined) {
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
    const unpaidNames = unpaidCheck.rows.map((r: Record<string, unknown>) => r.display_name).join(', ');
    throw {
      statusCode: 402,
      error: 'OUTSTANDING_BALANCE',
      message: `Cannot check in - outstanding fees for: ${unpaidNames}. Please collect payment first.`,
      unpaidParticipants: unpaidCheck.rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        name: r.display_name,
        status: r.payment_status,
        feeCents: r.total_fee_cents
      }))
    };
  }
  
  const result = await db.update(bookingRequests)
    .set({ status: 'checked_in' })
    .where(eq(bookingRequests.id, bookingId))
    .returning();
  
  if (result.length === 0) {
    throw { statusCode: 404, error: 'Booking not found' };
  }
  
  const booking = result[0];
  
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
  }).catch(err => logger.error('Booking event publish failed', { extra: { error: err } }));
  
  return booking;
}

export async function createManualBooking(params: {
  memberEmail: string;
  resourceId: number;
  bookingDate: string;
  startTime: string;
  durationMinutes: number;
  guestCount: number;
  bookingSource: string;
  notes?: string;
  staffNotes?: string;
  rescheduleFromId?: number;
  trackmanBookingId?: string;
  staffEmail: string;
}) {
  const validSources = ['Trackman', 'YGB', 'Mindbody', 'Texted Concierge', 'Called', 'Other'];
  if (!validSources.includes(params.bookingSource)) {
    throw { statusCode: 400, error: 'Invalid booking source' };
  }

  const validDurations = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360];
  if (!validDurations.includes(params.durationMinutes)) {
    throw { statusCode: 400, error: 'Invalid duration. Must be between 30 and 360 minutes in 30-minute increments.' };
  }

  const [member] = await db.select()
    .from(users)
    .where(eq(users.email, params.memberEmail));

  if (!member) {
    throw { statusCode: 404, error: 'Member not found with that email' };
  }

  const [resource] = await db.select()
    .from(resources)
    .where(eq(resources.id, params.resourceId));

  if (!resource) {
    throw { statusCode: 404, error: 'Resource not found' };
  }

  let oldBookingRequest: typeof bookingRequests.$inferSelect | null = null;
  if (params.rescheduleFromId) {
    const [found] = await db.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.id, params.rescheduleFromId));
    oldBookingRequest = found || null;
  }

  if (!params.rescheduleFromId) {
    const existingBookings = await db.select({
      id: bookingRequests.id,
      resourceType: resources.type
    })
      .from(bookingRequests)
      .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(and(
        eq(bookingRequests.userEmail, params.memberEmail.toLowerCase()),
        sql`${bookingRequests.requestDate} = ${params.bookingDate}`,
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
      throw { 
        statusCode: 409,
        error: 'Member already has a booking',
        message: `This member already has a ${resourceTypeLabel} booking on ${params.bookingDate}. Only one ${resourceTypeLabel} booking per day is allowed.`
      };
    }
  }

  const startParts = params.startTime.split(':').map(Number);
  const startMinutes = startParts[0] * 60 + (startParts[1] || 0);
  const endMinutes = startMinutes + params.durationMinutes;
  const endHour = Math.floor(endMinutes / 60);
  const endMin = endMinutes % 60;
  const endTime = `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`;

  const conflictCheck = await checkAllConflicts(params.resourceId, params.bookingDate, params.startTime, endTime);
  if (conflictCheck.hasConflict) {
    if (conflictCheck.conflictType === 'closure') {
      throw { 
        statusCode: 409,
        error: 'Time slot conflicts with a facility closure',
        message: `This time slot conflicts with "${conflictCheck.conflictTitle}".`
      };
    } else if (conflictCheck.conflictType === 'availability_block') {
      throw { 
        statusCode: 409,
        error: 'Time slot is blocked for an event',
        message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}.`
      };
    } else {
      throw { 
        statusCode: 409,
        error: 'Time slot already booked',
        message: 'Another booking already exists for this time slot.'
      };
    }
  }

  let calendarEventId: string | null = null;
  if (resource.type === 'conference_room') {
    try {
      const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
      
      if (calendarId) {
        const memberName = member.firstName && member.lastName 
          ? `${member.firstName} ${member.lastName}` 
          : params.memberEmail;
        
        const summary = `Booking: ${memberName}`;
        const descriptionLines = [
          `Area: ${resource.name}`,
          `Member: ${params.memberEmail}`,
          `Guests: ${params.guestCount}`,
          `Source: ${params.bookingSource}`,
          `Created by: ${params.staffEmail}`
        ];
        if (params.notes) {
          descriptionLines.push(`Notes: ${params.notes}`);
        }
        const description = descriptionLines.join('\n');
        
        calendarEventId = await createCalendarEventOnCalendar(
          calendarId,
          summary,
          description,
          params.bookingDate,
          params.startTime,
          endTime
        );
      }
    } catch (calErr: unknown) {
      logger.error('Calendar event creation error', { error: calErr as Error });
    }
  }

  const memberName = member.firstName && member.lastName 
    ? `${member.firstName} ${member.lastName}` 
    : params.memberEmail;
  
  const bookingNotes = params.notes 
    ? `${params.notes}\n[Source: ${params.bookingSource}]` 
    : `[Source: ${params.bookingSource}]`;
  
  const [newBooking] = await db.insert(bookingRequests)
    .values({
      resourceId: params.resourceId,
      userEmail: params.memberEmail,
      userName: memberName,
      resourcePreference: resource.name,
      requestDate: params.bookingDate,
      startTime: params.startTime,
      endTime: endTime,
      durationMinutes: params.durationMinutes,
      notes: bookingNotes,
      staffNotes: params.staffNotes || null,
      status: 'approved',
      guestCount: params.guestCount,
      reviewedBy: params.staffEmail,
      reviewedAt: new Date(),
      calendarEventId: calendarEventId,
      trackmanBookingId: params.trackmanBookingId || null
    })
    .returning();

  if (oldBookingRequest) {
    await db.update(bookingRequests)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(bookingRequests.id, params.rescheduleFromId as number));
    
    try {
      const pendingIntents = await pool.query(
        `SELECT stripe_payment_intent_id 
         FROM stripe_payment_intents 
         WHERE booking_id = $1 AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')`,
        [params.rescheduleFromId]
      );
      for (const row of pendingIntents.rows) {
        try {
          await cancelPaymentIntent(row.stripe_payment_intent_id);
          logger.info('[Reschedule] Cancelled payment intent for old booking', {
            extra: { oldBookingId: params.rescheduleFromId, paymentIntentId: row.stripe_payment_intent_id }
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
        logger.warn('Failed to delete old calendar event during reschedule', { error: calErr as Error });
      }
    }
    
    logger.info('Rescheduled booking - cancelled old, created new', { 
      oldBookingId: params.rescheduleFromId, 
      newBookingId: newBooking.id,
      memberEmail: params.memberEmail
    });

    bookingEvents.cleanupNotificationsForBooking(params.rescheduleFromId as number, { delete: true })
      .catch(err => logger.error('Failed to cleanup old booking notifications', { extra: { error: err } }));
  }

  try {
    const formattedDate = new Date(params.bookingDate + 'T00:00:00').toLocaleDateString('en-US', { 
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles'
    });
    const formatTime = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hour12 = h % 12 || 12;
      return `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`;
    };
    const notifTitle = 'Booking Confirmed';
    const notifMessage = `Your ${resource.type === 'simulator' ? 'golf simulator' : 'conference room'} booking for ${formattedDate} at ${formatTime(params.startTime)} has been confirmed.`;
    
    await db.insert(notifications).values({
      userEmail: params.memberEmail,
      title: notifTitle,
      message: notifMessage,
      type: 'booking_approved',
      relatedId: newBooking.id,
      relatedType: 'booking'
    });
    
    await sendPushNotification(params.memberEmail, {
      title: notifTitle,
      body: notifMessage,
      url: '/dashboard'
    });
    
    sendNotificationToUser(params.memberEmail, {
      type: 'notification',
      title: notifTitle,
      message: notifMessage,
      data: { bookingId: newBooking.id, eventType: 'booking_approved' }
    }, { action: 'manual_booking', bookingId: newBooking.id, resourceType: resource.type, triggerSource: 'resourceService.ts' });
  } catch (notifErr: unknown) {
    logger.error('Failed to send manual booking notification', { error: notifErr as Error });
  }

  bookingEvents.publish('booking_approved', {
    bookingId: newBooking.id,
    memberEmail: params.memberEmail,
    memberName: memberName,
    resourceId: params.resourceId,
    resourceName: resource.name,
    resourceType: resource.type,
    bookingDate: params.bookingDate,
    startTime: params.startTime,
    endTime: endTime,
    status: 'approved',
    actionBy: 'staff',
    staffEmail: params.staffEmail,
    isManualBooking: true
  }, { notifyMember: true, notifyStaff: true }).catch(err => logger.error('Booking event publish failed', { extra: { error: err } }));

  return {
    booking: {
      ...newBooking,
      resource_name: resource.name,
      resource_type: resource.type,
      member_name: member.firstName && member.lastName 
        ? `${member.firstName} ${member.lastName}` 
        : null
    }
  };
}

export async function isStaffOrAdminEmail(sessionEmail: string): Promise<boolean> {
  const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../replit_integrations/auth/replitAuth');
  const isAdmin = await isAdminEmail(sessionEmail);
  if (isAdmin) return true;
  
  const authPool = getAuthPool();
  if (authPool) {
    try {
      const result = await queryWithRetry(
        authPool,
        'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
        [sessionEmail]
      );
      return result.rows.length > 0;
    } catch (e: unknown) {
      logger.warn('[resources] Staff check query failed:', e);
    }
  }
  return false;
}
