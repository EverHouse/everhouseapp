import { Router } from 'express';
import { db } from '../../db';
import { pool } from '../../core/db';
import { bookingRequests, resources, notifications, users, bookingMembers, bookingParticipants } from '../../../shared/schema';
import { eq, and, or, gt, lt, lte, gte, ne, sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../../core/middleware';
import { sendPushNotification, sendPushNotificationToStaff } from '../push';
import { formatNotificationDateTime, formatDateDisplayWithDay, formatTime12Hour } from '../../utils/dateUtils';
import { logAndRespond } from '../../core/logger';
import { checkClosureConflict, checkAvailabilityBlockConflict } from '../../core/bookingValidation';
import { bookingEvents } from '../../core/bookingEvents';
import { sendNotificationToUser, broadcastAvailabilityUpdate, broadcastMemberStatsUpdated, broadcastBillingUpdate } from '../../core/websocket';
import { getSessionUser } from '../../types/session';
import { refundGuestPass } from '../guestPasses';
import { updateHubSpotContactVisitCount } from '../../core/memberSync';
import { createSessionWithUsageTracking } from '../../core/bookingService/sessionManager';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants } from '../../core/billing/unifiedFeeService';
import { cancelPaymentIntent, getStripeClient } from '../../core/stripe';
import { getCalendarNameForBayAsync } from './helpers';
import { getCalendarIdByName, createCalendarEventOnCalendar, deleteCalendarEvent, CALENDAR_CONFIG } from '../../core/calendar/index';

const router = Router();

router.put('/api/booking-requests/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, staff_notes, suggested_time, reviewed_by, resource_id, trackman_booking_id, trackman_external_id, pending_trackman_sync } = req.body;
    
    const formatRow = (row: any) => ({
      id: row.id,
      user_email: row.userEmail,
      user_name: row.userName,
      resource_id: row.resourceId,
      resource_preference: row.resourcePreference,
      request_date: row.requestDate,
      start_time: row.startTime,
      duration_minutes: row.durationMinutes,
      end_time: row.endTime,
      notes: row.notes,
      status: row.status,
      staff_notes: row.staffNotes,
      suggested_time: row.suggestedTime,
      reviewed_by: row.reviewedBy,
      reviewed_at: row.reviewedAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      calendar_event_id: row.calendarEventId,
      reschedule_booking_id: row.rescheduleBookingId
    });
    
    if (status === 'approved') {
      const bookingId = parseInt(id, 10);
      
      const { updated, bayName, approvalMessage } = await db.transaction(async (tx) => {
        const [req_data] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
        
        if (!req_data) {
          throw { statusCode: 404, error: 'Request not found' };
        }
        
        const assignedBayId = resource_id || req_data.resourceId;
        
        if (!assignedBayId) {
          throw { statusCode: 400, error: 'Bay must be assigned before approval' };
        }
        
        const conflicts = await tx.select().from(bookingRequests).where(and(
          eq(bookingRequests.resourceId, assignedBayId),
          eq(bookingRequests.requestDate, req_data.requestDate),
          or(
            eq(bookingRequests.status, 'approved'),
            eq(bookingRequests.status, 'confirmed'),
            eq(bookingRequests.status, 'attended')
          ),
          ne(bookingRequests.id, bookingId),
          or(
            and(lte(bookingRequests.startTime, req_data.startTime), gt(bookingRequests.endTime, req_data.startTime)),
            and(lt(bookingRequests.startTime, req_data.endTime), gte(bookingRequests.endTime, req_data.endTime)),
            and(gte(bookingRequests.startTime, req_data.startTime), lte(bookingRequests.endTime, req_data.endTime))
          )
        ));
        
        if (conflicts.length > 0) {
          throw { statusCode: 409, error: 'Time slot conflicts with existing booking' };
        }
        
        const closureCheck = await checkClosureConflict(
          assignedBayId,
          req_data.requestDate,
          req_data.startTime,
          req_data.endTime
        );
        
        if (closureCheck.hasConflict) {
          throw { 
            statusCode: 409, 
            error: 'Cannot approve booking during closure',
            message: `This time slot conflicts with "${closureCheck.closureTitle}". Please decline this request or wait until the closure ends.`
          };
        }
        
        const blockCheck = await checkAvailabilityBlockConflict(
          assignedBayId,
          req_data.requestDate,
          req_data.startTime,
          req_data.endTime
        );
        
        if (blockCheck.hasConflict) {
          throw { 
            statusCode: 409, 
            error: 'Cannot approve booking during event block',
            message: `This time slot is blocked: ${blockCheck.blockType || 'Event block'}. Please decline this request or reschedule.`
          };
        }
        
        const bayResult = await tx.select({ name: resources.name, type: resources.type }).from(resources).where(eq(resources.id, assignedBayId));
        const bayName = bayResult[0]?.name || 'Simulator';
        const isConferenceRoom = bayResult[0]?.type === 'conference_room';
        
        let calendarEventId: string | null = req_data.calendarEventId || null;
        if (!calendarEventId) {
          try {
            const calendarName = await getCalendarNameForBayAsync(assignedBayId);
            if (calendarName) {
              const calendarId = await getCalendarIdByName(calendarName);
              if (calendarId) {
                const summary = `Booking: ${req_data.userName || req_data.userEmail}`;
                const description = `Area: ${bayName}\nMember: ${req_data.userEmail}\nDuration: ${req_data.durationMinutes} minutes${req_data.notes ? '\nNotes: ' + req_data.notes : ''}`;
                calendarEventId = await createCalendarEventOnCalendar(
                  calendarId,
                  summary,
                  description,
                  req_data.requestDate,
                  req_data.startTime,
                  req_data.endTime
                );
              }
            }
          } catch (calError) {
            console.error('Calendar sync failed (non-blocking):', calError);
          }
        }
        
        const finalStatus = isConferenceRoom ? 'attended' : status;
        
        let finalStaffNotes = staff_notes;
        if (pending_trackman_sync && !trackman_booking_id) {
          const syncMarker = '[PENDING_TRACKMAN_SYNC]';
          finalStaffNotes = staff_notes ? `${staff_notes} ${syncMarker}` : syncMarker;
        }
        
        const [updatedRow] = await tx.update(bookingRequests)
          .set({
            status: finalStatus,
            staffNotes: finalStaffNotes,
            suggestedTime: suggested_time,
            reviewedBy: reviewed_by,
            reviewedAt: new Date(),
            resourceId: assignedBayId,
            calendarEventId: calendarEventId,
            ...(trackman_booking_id !== undefined ? { trackmanBookingId: trackman_booking_id || null } : {}),
            ...(trackman_external_id !== undefined ? { trackmanExternalId: trackman_external_id || null } : {}),
            updatedAt: new Date()
          })
          .where(eq(bookingRequests.id, bookingId))
          .returning();
        
        let createdSessionId: number | null = null;
        let createdParticipantIds: number[] = [];
        if (!isConferenceRoom && !updatedRow.sessionId) {
          try {
            let ownerUserId = updatedRow.userId;
            if (!ownerUserId && updatedRow.userEmail) {
              const userResult = await tx.select({ id: users.id })
                .from(users)
                .where(eq(users.email, updatedRow.userEmail.toLowerCase()))
                .limit(1);
              if (userResult.length > 0) {
                ownerUserId = userResult[0].id;
                await tx.update(bookingRequests)
                  .set({ userId: ownerUserId })
                  .where(eq(bookingRequests.id, bookingId));
              }
            }
            
            const sessionResult = await createSessionWithUsageTracking(
              {
                ownerEmail: updatedRow.userEmail,
                resourceId: assignedBayId,
                sessionDate: updatedRow.requestDate,
                startTime: updatedRow.startTime,
                endTime: updatedRow.endTime,
                durationMinutes: updatedRow.durationMinutes,
                participants: [{
                  userId: ownerUserId || undefined,
                  participantType: 'owner',
                  displayName: updatedRow.userName || updatedRow.userEmail
                }],
                trackmanBookingId: updatedRow.trackmanBookingId || undefined
              },
              'member_request',
              tx
            );
            
            if (sessionResult.success && sessionResult.session) {
              createdSessionId = sessionResult.session.id;
              createdParticipantIds = sessionResult.participants?.map(p => p.id) || [];
              
              let overageMinutes = 0;
              let overageFeeCents = 0;
              try {
                const ledgerResult = await tx.execute(sql`
                  SELECT minutes_charged, overage_fee 
                  FROM usage_ledger 
                  WHERE session_id = ${createdSessionId} 
                    AND LOWER(member_id) = LOWER(${updatedRow.userEmail})
                  LIMIT 1
                `);
                if (ledgerResult.rows.length > 0) {
                  const ledger = ledgerResult.rows[0] as { minutes_charged?: number; overage_fee?: string };
                  const overageFeeDecimal = parseFloat(String(ledger.overage_fee || 0));
                  if (overageFeeDecimal > 0) {
                    overageFeeCents = Math.round(overageFeeDecimal * 100);
                    const overageBlocks = overageFeeDecimal / 25;
                    overageMinutes = Math.round(overageBlocks * 30);
                  }
                }
              } catch (ledgerError) {
                console.error('[Booking Approval] Failed to get overage info:', ledgerError);
              }
              
              await tx.update(bookingRequests)
                .set({ 
                  sessionId: createdSessionId,
                  overageMinutes,
                  overageFeeCents,
                  overagePaid: overageFeeCents === 0
                })
                .where(eq(bookingRequests.id, bookingId));
              
              console.log(`[Booking Approval] Created session ${createdSessionId} for booking ${bookingId} with ${createdParticipantIds.length} participants, ${sessionResult.usageLedgerEntries || 0} ledger entries${overageFeeCents > 0 ? `, overage $${(overageFeeCents/100).toFixed(2)}` : ''}`);
            } else {
              console.error(`[Booking Approval] Session creation failed: ${sessionResult.error}`);
            }
          } catch (sessionError) {
            console.error('[Booking Approval] Failed to create session (non-blocking):', sessionError);
          }
        }
        
        if (createdSessionId && createdParticipantIds.length > 0) {
          setImmediate(async () => {
            try {
              const breakdown = await computeFeeBreakdown({
                sessionId: createdSessionId!,
                declaredPlayerCount: createdParticipantIds.length,
                source: 'approval' as const
              });
              await applyFeeBreakdownToParticipants(createdSessionId!, breakdown);
              console.log(`[Booking Approval] Applied unified fees for session ${createdSessionId}: $${(breakdown.totals.totalCents/100).toFixed(2)}`);
            } catch (feeError) {
              console.error('[Booking Approval] Failed to compute/apply fees (non-blocking):', feeError);
            }
          });
        }
        
        const isReschedule = !!updatedRow.rescheduleBookingId;
        const approvalMessage = isReschedule
          ? `Reschedule approved - your booking is now ${formatNotificationDateTime(updatedRow.requestDate, updatedRow.startTime)}`
          : `Your simulator booking for ${formatNotificationDateTime(updatedRow.requestDate, updatedRow.startTime)} has been approved.`;
        
        await tx.insert(notifications).values({
          userEmail: updatedRow.userEmail,
          title: isReschedule ? 'Reschedule Approved' : 'Booking Request Approved',
          message: approvalMessage,
          type: 'booking_approved',
          relatedId: updatedRow.id,
          relatedType: 'booking_request'
        });
        
        await tx.update(notifications)
          .set({ isRead: true })
          .where(and(
            eq(notifications.relatedId, bookingId),
            eq(notifications.relatedType, 'booking_request'),
            eq(notifications.type, 'booking')
          ));
        
        return { updated: updatedRow, bayName, approvalMessage };
      });
      
      if (updated.rescheduleBookingId) {
        try {
          const [originalBooking] = await db.select({
            id: bookingRequests.id,
            calendarEventId: bookingRequests.calendarEventId,
            resourceId: bookingRequests.resourceId
          })
            .from(bookingRequests)
            .where(eq(bookingRequests.id, updated.rescheduleBookingId));
          
          if (originalBooking) {
            await db.update(bookingRequests)
              .set({ status: 'cancelled', updatedAt: new Date() })
              .where(eq(bookingRequests.id, originalBooking.id));
            
            if (originalBooking.calendarEventId) {
              try {
                const calendarName = await getCalendarNameForBayAsync(originalBooking.resourceId);
                if (calendarName) {
                  const calendarId = await getCalendarIdByName(calendarName);
                  if (calendarId) {
                    await deleteCalendarEvent(originalBooking.calendarEventId, calendarId);
                  }
                }
              } catch (calError) {
                console.error('Failed to delete original booking calendar event (non-blocking):', calError);
              }
            }
          }
        } catch (rescheduleError) {
          console.error('Failed to cancel original booking during reschedule approval:', rescheduleError);
        }
      }
      
      sendPushNotification(updated.userEmail, {
        title: updated.rescheduleBookingId ? 'Reschedule Approved!' : 'Booking Approved!',
        body: approvalMessage,
        url: '/#/sims'
      }).catch(err => console.error('Push notification failed:', err));
      
      (async () => {
        try {
          const linkedMembers = await db.select({ userEmail: bookingMembers.userEmail })
            .from(bookingMembers)
            .where(and(
              eq(bookingMembers.bookingId, parseInt(id, 10)),
              sql`${bookingMembers.userEmail} IS NOT NULL`,
              sql`${bookingMembers.isPrimary} IS NOT TRUE`
            ));
          
          for (const member of linkedMembers) {
            if (member.userEmail && member.userEmail.toLowerCase() !== updated.userEmail.toLowerCase()) {
              const linkedMessage = `A booking you're part of has been confirmed for ${formatNotificationDateTime(updated.requestDate, updated.startTime)}.`;
              
              await db.insert(notifications).values({
                userEmail: member.userEmail,
                title: 'Booking Confirmed',
                message: linkedMessage,
                type: 'booking_approved',
                relatedId: parseInt(id, 10),
                relatedType: 'booking_request'
              });
              
              sendPushNotification(member.userEmail, {
                title: 'Booking Confirmed',
                body: linkedMessage,
                tag: `booking-approved-linked-${id}`
              }).catch(() => {});
              
              sendNotificationToUser(member.userEmail, {
                type: 'notification',
                title: 'Booking Confirmed',
                message: linkedMessage,
                data: { bookingId: parseInt(id, 10), eventType: 'booking_approved' }
              }, { action: 'booking_approved_linked', bookingId: parseInt(id, 10), triggerSource: 'approval.ts' });
            }
          }
        } catch (err) {
          console.error('Failed to notify linked members:', err);
        }
      })();
      
      bookingEvents.publish('booking_approved', {
        bookingId: parseInt(id, 10),
        memberEmail: updated.userEmail,
        memberName: updated.userName || undefined,
        resourceId: updated.resourceId || undefined,
        resourceName: bayName,
        bookingDate: updated.requestDate,
        startTime: updated.startTime,
        endTime: updated.endTime,
        status: 'approved',
        actionBy: 'staff'
      }, { notifyMember: true, notifyStaff: true, cleanupNotifications: true }).catch(err => console.error('Booking event publish failed:', err));
      
      broadcastAvailabilityUpdate({
        resourceId: updated.resourceId || undefined,
        resourceType: 'simulator',
        date: updated.requestDate,
        action: 'booked'
      });
      
      sendNotificationToUser(updated.userEmail, {
        type: 'notification',
        title: updated.rescheduleBookingId ? 'Reschedule Approved' : 'Booking Approved',
        message: approvalMessage,
        data: { bookingId: parseInt(id, 10), eventType: 'booking_approved' }
      }, { action: 'booking_approved', bookingId: parseInt(id, 10), triggerSource: 'approval.ts' });
      
      return res.json(formatRow(updated));
    }
    
    if (status === 'declined') {
      const bookingId = parseInt(id, 10);
      
      const { updated, declineMessage, isReschedule } = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
        
        if (!existing) {
          throw { statusCode: 404, error: 'Booking request not found' };
        }
        
        const [updatedRow] = await tx.update(bookingRequests)
          .set({
            status: status,
            staffNotes: staff_notes,
            suggestedTime: suggested_time,
            reviewedBy: reviewed_by,
            reviewedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(bookingRequests.id, bookingId))
          .returning();
        
        const isReschedule = !!updatedRow.rescheduleBookingId;
        let declineMessage: string;
        let notificationTitle: string;
        
        if (isReschedule) {
          const [originalBooking] = await tx.select({
            requestDate: bookingRequests.requestDate,
            startTime: bookingRequests.startTime
          })
            .from(bookingRequests)
            .where(eq(bookingRequests.id, updatedRow.rescheduleBookingId!));
          
          if (originalBooking) {
            const origDateTime = formatNotificationDateTime(originalBooking.requestDate, originalBooking.startTime);
            declineMessage = `Reschedule declined - your original booking for ${origDateTime} remains active`;
          } else {
            declineMessage = `Reschedule declined - your original booking remains active`;
          }
          notificationTitle = 'Reschedule Declined';
        } else {
          declineMessage = suggested_time 
            ? `Your simulator booking request for ${formatDateDisplayWithDay(updatedRow.requestDate)} was declined. Suggested alternative: ${formatTime12Hour(suggested_time)}`
            : `Your simulator booking request for ${formatDateDisplayWithDay(updatedRow.requestDate)} was declined.`;
          notificationTitle = 'Booking Request Declined';
        }
        
        await tx.insert(notifications).values({
          userEmail: updatedRow.userEmail,
          title: notificationTitle,
          message: declineMessage,
          type: 'booking_declined',
          relatedId: updatedRow.id,
          relatedType: 'booking_request'
        });
        
        await tx.update(notifications)
          .set({ isRead: true })
          .where(and(
            eq(notifications.relatedId, bookingId),
            eq(notifications.relatedType, 'booking_request'),
            eq(notifications.type, 'booking')
          ));
        
        return { updated: updatedRow, declineMessage, isReschedule };
      });
      
      sendPushNotification(updated.userEmail, {
        title: isReschedule ? 'Reschedule Declined' : 'Booking Request Update',
        body: declineMessage,
        url: '/#/sims'
      }).catch(err => console.error('Push notification failed:', err));
      
      bookingEvents.publish('booking_declined', {
        bookingId: parseInt(id, 10),
        memberEmail: updated.userEmail,
        memberName: updated.userName || undefined,
        bookingDate: updated.requestDate,
        startTime: updated.startTime,
        status: 'declined',
        actionBy: 'staff'
      }, { notifyMember: true, notifyStaff: true, cleanupNotifications: true }).catch(err => console.error('Booking event publish failed:', err));
      
      sendNotificationToUser(updated.userEmail, {
        type: 'notification',
        title: isReschedule ? 'Reschedule Declined' : 'Booking Declined',
        message: declineMessage,
        data: { bookingId: parseInt(id, 10), eventType: 'booking_declined' }
      }, { action: 'booking_declined', bookingId: parseInt(id, 10), triggerSource: 'approval.ts' });
      
      return res.json(formatRow(updated));
    }
    
    if (status === 'cancelled') {
      const bookingId = parseInt(id, 10);
      const { cancelled_by } = req.body;
      
      const { updated, bookingData, pushInfo, overageRefundResult } = await db.transaction(async (tx) => {
        const [existing] = await tx.select({
          id: bookingRequests.id,
          calendarEventId: bookingRequests.calendarEventId,
          userEmail: bookingRequests.userEmail,
          userName: bookingRequests.userName,
          requestDate: bookingRequests.requestDate,
          startTime: bookingRequests.startTime,
          status: bookingRequests.status,
          resourceId: bookingRequests.resourceId,
          trackmanBookingId: bookingRequests.trackmanBookingId,
          overagePaymentIntentId: bookingRequests.overagePaymentIntentId,
          overagePaid: bookingRequests.overagePaid,
          overageFeeCents: bookingRequests.overageFeeCents
        })
          .from(bookingRequests)
          .where(eq(bookingRequests.id, bookingId));
        
        if (!existing) {
          throw { statusCode: 404, error: 'Booking request not found' };
        }
        
        let overageRefundResult: { cancelled?: boolean; refunded?: boolean; amount?: number; error?: string } = {};
        if (existing.overagePaymentIntentId) {
          try {
            if (existing.overagePaid) {
              const stripe = await getStripeClient();
              const paymentIntent = await stripe.paymentIntents.retrieve(existing.overagePaymentIntentId);
              if (paymentIntent.status === 'succeeded' && paymentIntent.latest_charge) {
                const refund = await stripe.refunds.create({
                  charge: paymentIntent.latest_charge as string,
                  reason: 'requested_by_customer'
                });
                console.log(`[Staff Cancel] Refunded overage payment ${existing.overagePaymentIntentId} for booking ${bookingId}, refund: ${refund.id}`);
                overageRefundResult = { refunded: true, amount: (existing.overageFeeCents || 0) / 100 };
              }
            } else {
              await cancelPaymentIntent(existing.overagePaymentIntentId);
              console.log(`[Staff Cancel] Cancelled overage payment intent ${existing.overagePaymentIntentId} for booking ${bookingId}`);
              overageRefundResult = { cancelled: true };
            }
            await tx.update(bookingRequests)
              .set({ overagePaymentIntentId: null, overageFeeCents: 0, overageMinutes: 0 })
              .where(eq(bookingRequests.id, bookingId));
          } catch (paymentErr: any) {
            console.error('[Staff Cancel] Failed to handle overage payment (non-blocking):', paymentErr);
            overageRefundResult = { error: paymentErr.message };
          }
        }
        
        // Cancel pending payment intents from stripe_payment_intents table
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
              console.log(`[Staff Cancel] Cancelled payment intent ${row.stripe_payment_intent_id} for booking ${bookingId}`);
            } catch (cancelErr: any) {
              console.error(`[Staff Cancel] Failed to cancel payment intent ${row.stripe_payment_intent_id}:`, cancelErr.message);
            }
          }
        } catch (cancelIntentsErr) {
          console.error('[Staff Cancel] Failed to cancel pending payment intents (non-blocking):', cancelIntentsErr);
        }
        
        let updatedStaffNotes = staff_notes || '';
        if (existing.trackmanBookingId) {
          const trackmanNote = '[Cancelled in app - needs Trackman cancellation]';
          updatedStaffNotes = updatedStaffNotes 
            ? `${updatedStaffNotes}\n${trackmanNote}` 
            : trackmanNote;
        }
        
        const [updatedRow] = await tx.update(bookingRequests)
          .set({
            status: status,
            staffNotes: updatedStaffNotes || undefined,
            updatedAt: new Date()
          })
          .where(eq(bookingRequests.id, bookingId))
          .returning();
        
        const sessionResult = await tx.select({ sessionId: bookingRequests.sessionId })
          .from(bookingRequests)
          .where(eq(bookingRequests.id, bookingId));
        
        if (sessionResult[0]?.sessionId) {
          const guestParticipants = await tx.select({ id: bookingParticipants.id, displayName: bookingParticipants.displayName })
            .from(bookingParticipants)
            .where(and(
              eq(bookingParticipants.sessionId, sessionResult[0].sessionId),
              eq(bookingParticipants.participantType, 'guest')
            ));
          
          for (const guest of guestParticipants) {
            await refundGuestPass(existing.userEmail, guest.displayName || undefined, false);
          }
          
          if (guestParticipants.length > 0) {
            console.log(`[bays] Refunded ${guestParticipants.length} guest pass(es) for cancelled booking ${bookingId}`);
          }
          
          // Refund participant payments (guest fees paid via Stripe)
          const paidParticipants = await pool.query(
            `SELECT id, stripe_payment_intent_id, cached_fee_cents, display_name
             FROM booking_participants 
             WHERE session_id = $1 
             AND payment_status = 'paid' 
             AND stripe_payment_intent_id IS NOT NULL 
             AND stripe_payment_intent_id != ''
             AND stripe_payment_intent_id NOT LIKE 'balance-%'`,
            [sessionResult[0].sessionId]
          );
          
          if (paidParticipants.rows.length > 0) {
            const stripe = await getStripeClient();
            for (const participant of paidParticipants.rows) {
              try {
                const pi = await stripe.paymentIntents.retrieve(participant.stripe_payment_intent_id);
                if (pi.status === 'succeeded' && pi.latest_charge) {
                  const refund = await stripe.refunds.create({
                    charge: pi.latest_charge as string,
                    reason: 'requested_by_customer',
                    metadata: {
                      type: 'booking_cancelled_by_staff',
                      bookingId: bookingId.toString(),
                      participantId: participant.id.toString()
                    }
                  });
                  console.log(`[Staff Cancel] Refunded guest fee for ${participant.display_name}: $${(participant.cached_fee_cents / 100).toFixed(2)}, refund: ${refund.id}`);
                }
              } catch (refundErr: any) {
                console.error(`[Staff Cancel] Failed to refund participant ${participant.id}:`, refundErr.message);
              }
            }
          }
        }
        
        let pushInfo: { type: 'staff' | 'member' | 'both'; email?: string; staffMessage?: string; memberMessage?: string; message: string } | null = null;
        
        const memberEmail = existing.userEmail;
        const memberName = existing.userName || memberEmail;
        const bookingDate = existing.requestDate;
        const memberCancelled = cancelled_by === memberEmail;
        const wasApproved = existing.status === 'approved';
        
        const friendlyDateTime = formatNotificationDateTime(bookingDate, existing.startTime || '00:00');
        const statusLabel = wasApproved ? 'booking' : 'booking request';
        
        if (memberCancelled) {
          const staffMessage = `${memberName} has cancelled their ${statusLabel} for ${friendlyDateTime}.`;
          const memberMessage = `Your ${statusLabel} for ${friendlyDateTime} has been cancelled.`;
          
          await tx.insert(notifications).values({
            userEmail: 'staff@evenhouse.app',
            title: 'Booking Cancelled by Member',
            message: staffMessage,
            type: 'booking_cancelled',
            relatedId: bookingId,
            relatedType: 'booking_request'
          });
          
          await tx.insert(notifications).values({
            userEmail: memberEmail,
            title: 'Booking Cancelled',
            message: memberMessage,
            type: 'booking_cancelled',
            relatedId: bookingId,
            relatedType: 'booking_request'
          });
          
          pushInfo = { type: 'both', email: memberEmail, staffMessage, memberMessage, message: staffMessage };
        } else {
          const memberMessage = `Your ${statusLabel} for ${friendlyDateTime} has been cancelled by staff.`;
          
          await tx.insert(notifications).values({
            userEmail: memberEmail,
            title: 'Booking Cancelled',
            message: memberMessage,
            type: 'booking_cancelled',
            relatedId: bookingId,
            relatedType: 'booking_request'
          });
          
          pushInfo = { type: 'member', email: memberEmail, message: memberMessage };
        }
        
        await tx.update(notifications)
          .set({ isRead: true })
          .where(and(
            eq(notifications.relatedId, bookingId),
            eq(notifications.relatedType, 'booking_request'),
            eq(notifications.type, 'booking')
          ));
        
        if (existing.trackmanBookingId) {
          let bayName = 'Bay';
          if (existing.resourceId) {
            const [resource] = await tx.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
            if (resource?.name) {
              bayName = resource.name;
            }
          }
          
          const trackmanReminderMessage = `Reminder: ${memberName}'s booking on ${friendlyDateTime} (${bayName}) was cancelled - please also cancel in Trackman`;
          
          await tx.insert(notifications).values({
            userEmail: 'staff@evenhouse.app',
            title: 'Trackman Cancellation Required',
            message: trackmanReminderMessage,
            type: 'booking_cancelled',
            relatedId: bookingId,
            relatedType: 'booking_request'
          });
        }
        
        return { updated: updatedRow, bookingData: existing, pushInfo, overageRefundResult };
      });
      
      if (bookingData?.calendarEventId) {
        try {
          const calendarName = await getCalendarNameForBayAsync(bookingData.resourceId);
          if (calendarName) {
            const calendarId = await getCalendarIdByName(calendarName);
            if (calendarId) {
              await deleteCalendarEvent(bookingData.calendarEventId, calendarId);
            }
          }
        } catch (calError) {
          console.error('Failed to delete calendar event (non-blocking):', calError);
        }
      }
      
      if (pushInfo) {
        if (pushInfo.type === 'both') {
          sendPushNotificationToStaff({
            title: 'Booking Cancelled',
            body: pushInfo.staffMessage || pushInfo.message,
            url: '/#/staff'
          }).catch(err => console.error('Staff push notification failed:', err));
          if (pushInfo.email) {
            sendPushNotification(pushInfo.email, {
              title: 'Booking Cancelled',
              body: pushInfo.memberMessage || pushInfo.message,
              url: '/#/sims'
            }).catch(err => console.error('Member push notification failed:', err));
          }
        } else if (pushInfo.type === 'staff') {
          sendPushNotificationToStaff({
            title: 'Booking Cancelled',
            body: pushInfo.message,
            url: '/#/staff'
          }).catch(err => console.error('Staff push notification failed:', err));
        } else if (pushInfo.email) {
          sendPushNotification(pushInfo.email, {
            title: 'Booking Cancelled',
            body: pushInfo.message,
            url: '/#/sims'
          }).catch(err => console.error('Member push notification failed:', err));
        }
      }
      
      const cancelledBy = pushInfo?.type === 'both' ? 'member' : 'staff';
      bookingEvents.publish('booking_cancelled', {
        bookingId: parseInt(id, 10),
        memberEmail: bookingData.userEmail,
        memberName: bookingData.userName || undefined,
        resourceId: bookingData.resourceId || undefined,
        bookingDate: bookingData.requestDate,
        startTime: bookingData.startTime,
        status: 'cancelled',
        actionBy: cancelledBy
      }, { notifyMember: false, notifyStaff: true, cleanupNotifications: false }).catch(err => console.error('Booking event publish failed:', err));
      
      broadcastAvailabilityUpdate({
        resourceId: bookingData.resourceId || undefined,
        resourceType: 'simulator',
        date: bookingData.requestDate,
        action: 'cancelled'
      });
      
      if (pushInfo?.email && (pushInfo.type === 'member' || pushInfo.type === 'both')) {
        sendNotificationToUser(pushInfo.email, {
          type: 'notification',
          title: 'Booking Cancelled',
          message: pushInfo.memberMessage || pushInfo.message,
          data: { bookingId: parseInt(id, 10), eventType: 'booking_cancelled' }
        }, { action: 'booking_cancelled', bookingId: parseInt(id, 10), triggerSource: 'approval.ts' });
      }
      
      return res.json(formatRow(updated));
    }
    
    const result = await db.update(bookingRequests)
      .set({
        status: status,
        staffNotes: staff_notes || undefined,
        updatedAt: new Date()
      })
      .where(eq(bookingRequests.id, parseInt(id, 10)))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Booking request not found' });
    }
    
    res.json(formatRow(result[0]));
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ 
        error: error.error, 
        message: error.message 
      });
    }
    logAndRespond(req, res, 500, 'Failed to update booking request', error);
  }
});

router.put('/api/bookings/:id/checkin', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status: targetStatus, confirmPayment, skipPaymentCheck } = req.body;
    const bookingId = parseInt(id, 10);
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'unknown';
    const staffName = sessionUser?.name || null;
    
    const validStatuses = ['attended', 'no_show'];
    const newStatus = validStatuses.includes(targetStatus) ? targetStatus : 'attended';
    
    const existingResult = await pool.query(`
      SELECT br.status, br.user_email, br.session_id
      FROM booking_requests br
      WHERE br.id = $1
    `, [bookingId]);
    
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const existing = existingResult.rows[0];
    const currentStatus = existing.status;
    
    if (currentStatus === newStatus) {
      return res.json({ success: true, message: `Already marked as ${newStatus}`, alreadyProcessed: true });
    }
    
    // Allow checking in cancelled bookings if they have a session (for overdue payment recovery)
    const hasSession = existing.session_id !== null;
    const allowedStatuses = ['approved', 'confirmed'];
    if (hasSession && currentStatus === 'cancelled') {
      // Allow recovery of cancelled bookings with sessions (overdue payment scenarios)
      allowedStatuses.push('cancelled');
    }
    
    if (!allowedStatuses.includes(currentStatus)) {
      return res.status(400).json({ error: `Cannot update booking with status: ${currentStatus}` });
    }
    
    const { skipRosterCheck } = req.body;
    if (newStatus === 'attended' && !skipRosterCheck) {
      const rosterResult = await pool.query(`
        SELECT 
          br.trackman_player_count,
          br.declared_player_count,
          (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id) as total_slots,
          (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id AND bm.user_email IS NULL) as empty_slots
        FROM booking_requests br
        WHERE br.id = $1
      `, [bookingId]);
      
      if (rosterResult.rows.length > 0) {
        const roster = rosterResult.rows[0];
        const declaredCount = roster.trackman_player_count || roster.declared_player_count || 1;
        const emptySlots = parseInt(roster.empty_slots) || 0;
        const totalSlots = parseInt(roster.total_slots) || 0;
        
        if (emptySlots > 0 && declaredCount > 1) {
          return res.status(402).json({
            error: 'Roster incomplete',
            requiresRoster: true,
            emptySlots,
            totalSlots,
            declaredPlayerCount: declaredCount,
            message: `${emptySlots} player slot${emptySlots > 1 ? 's' : ''} not assigned. Staff must link members or add guests before check-in to ensure proper billing.`
          });
        }
      }
    }
    
    const { skipOverageCheck } = req.body;
    if (newStatus === 'attended' && !skipOverageCheck) {
      const overageResult = await pool.query(`
        SELECT overage_minutes, overage_fee_cents, overage_paid
        FROM booking_requests
        WHERE id = $1
      `, [bookingId]);
      
      if (overageResult.rows.length > 0) {
        const overage = overageResult.rows[0];
        const overageFeeCents = overage.overage_fee_cents || 0;
        const overagePaid = overage.overage_paid ?? (overageFeeCents === 0);
        
        if (overageFeeCents > 0 && !overagePaid) {
          return res.status(402).json({
            error: 'Unpaid overage fee',
            requiresOveragePayment: true,
            overageMinutes: overage.overage_minutes,
            overageFeeCents: overageFeeCents,
            overageBlocks: Math.ceil(overage.overage_minutes / 30),
            message: `Member has an unpaid simulator overage fee of $${(overageFeeCents / 100).toFixed(2)} (${overage.overage_minutes} min over tier limit). Payment required before check-in.`
          });
        }
      }
    }
    
    if (newStatus === 'attended' && !existing.session_id && !skipPaymentCheck) {
      return res.status(400).json({
        error: 'Billing session not generated yet',
        requiresSync: true,
        message: 'Billing session not generated yet - Check Trackman Sync. The session may need to be synced from Trackman before check-in to ensure proper billing.'
      });
    }
    
    if (newStatus === 'attended' && existing.session_id && !skipPaymentCheck) {
      const balanceResult = await pool.query(`
        SELECT 
          bp.id as participant_id,
          bp.display_name,
          bp.participant_type,
          bp.payment_status,
          COALESCE(ul.overage_fee, 0)::numeric as overage_fee,
          COALESCE(ul.guest_fee, 0)::numeric as guest_fee
        FROM booking_participants bp
        LEFT JOIN users pu ON pu.id = bp.user_id
        LEFT JOIN booking_requests br ON br.session_id = bp.session_id
        LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
          AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email) OR LOWER(ul.member_id) = LOWER(br.user_email))
        WHERE bp.session_id = $1 AND bp.payment_status = 'pending'
      `, [existing.session_id]);
      
      let totalOutstanding = 0;
      const unpaidParticipants: Array<{ id: number; name: string; amount: number }> = [];
      
      for (const p of balanceResult.rows) {
        const amount = parseFloat(p.overage_fee) + parseFloat(p.guest_fee);
        if (amount > 0) {
          totalOutstanding += amount;
          unpaidParticipants.push({
            id: p.participant_id,
            name: p.display_name,
            amount
          });
        }
      }
      
      if (totalOutstanding > 0 && !confirmPayment) {
        await pool.query(`
          INSERT INTO booking_payment_audit 
            (booking_id, session_id, action, staff_email, staff_name, amount_affected, metadata)
          VALUES ($1, $2, 'checkin_guard_triggered', $3, $4, $5, $6)
        `, [
          bookingId,
          existing.session_id,
          staffEmail,
          staffName,
          totalOutstanding,
          JSON.stringify({ unpaidParticipants })
        ]);
        
        return res.status(402).json({ 
          error: 'Payment required',
          requiresPayment: true,
          totalOutstanding,
          unpaidParticipants,
          message: `Outstanding balance of $${totalOutstanding.toFixed(2)}. Has the member paid?`
        });
      }
      
      if (confirmPayment && totalOutstanding > 0) {
        for (const p of unpaidParticipants) {
          await pool.query(
            `UPDATE booking_participants SET payment_status = 'paid' WHERE id = $1`,
            [p.id]
          );
          
          await pool.query(`
            INSERT INTO booking_payment_audit 
              (booking_id, session_id, participant_id, action, staff_email, staff_name, amount_affected, previous_status, new_status)
            VALUES ($1, $2, $3, 'payment_confirmed', $4, $5, $6, 'pending', 'paid')
          `, [bookingId, existing.session_id, p.id, staffEmail, staffName, p.amount]);
        }
        
        broadcastBillingUpdate({
          action: 'booking_payment_updated',
          bookingId,
          sessionId: existing.session_id,
          memberEmail: existing.user_email,
          amount: totalOutstanding * 100
        });
      }
    }
    
    // Build status conditions matching allowedStatuses
    const statusConditions = allowedStatuses.map(s => eq(bookingRequests.status, s as any));
    
    const result = await db.update(bookingRequests)
      .set({
        status: newStatus,
        updatedAt: new Date()
      })
      .where(and(
        eq(bookingRequests.id, bookingId),
        or(...statusConditions)
      ))
      .returning();
    
    if (result.length === 0) {
      return res.status(400).json({ error: 'Booking status changed before update' });
    }
    
    const booking = result[0];
    if (newStatus === 'attended' && booking.userEmail) {
      const updateResult = await pool.query<{ lifetime_visits: number; hubspot_id: string | null }>(
        `UPDATE users 
         SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
         WHERE email = $1
         RETURNING lifetime_visits, hubspot_id`,
        [booking.userEmail]
      );
      
      const updatedUser = updateResult.rows[0];
      if (updatedUser?.hubspot_id && updatedUser.lifetime_visits) {
        updateHubSpotContactVisitCount(updatedUser.hubspot_id, updatedUser.lifetime_visits)
          .catch(err => console.error('[Bays] Failed to sync visit count to HubSpot:', err));
      }
      
      if (updatedUser?.lifetime_visits) {
        broadcastMemberStatsUpdated(booking.userEmail, {
          lifetimeVisits: updatedUser.lifetime_visits
        });
      }
      
      // Send check-in confirmation notification to member
      const dateStr = booking.requestDate instanceof Date 
        ? booking.requestDate.toISOString().split('T')[0] 
        : String(booking.requestDate).split('T')[0];
      const formattedDate = formatDateDisplayWithDay(dateStr);
      const formattedTime = formatTime12Hour(booking.startTime);
      
      await pool.query(
        `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [booking.userEmail, 'Check-In Complete', `Thanks for visiting! Your session on ${formattedDate} at ${formattedTime} has been checked in.`, 'booking', 'booking']
      );
      
      sendNotificationToUser(booking.userEmail, {
        type: 'notification',
        title: 'Check-In Complete',
        message: `Thanks for visiting! Your session on ${formattedDate} at ${formattedTime} has been checked in.`,
        data: { bookingId, eventType: 'booking_attended' }
      }, { action: 'booking_attended', bookingId, triggerSource: 'approval.ts' });
    }
    
    // Send no-show notification to member
    if (newStatus === 'no_show' && booking.userEmail) {
      const noShowDateStr = booking.requestDate instanceof Date 
        ? booking.requestDate.toISOString().split('T')[0] 
        : String(booking.requestDate).split('T')[0];
      const formattedDate = formatDateDisplayWithDay(noShowDateStr);
      const formattedTime = formatTime12Hour(booking.startTime);
      
      await pool.query(
        `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [booking.userEmail, 'Missed Booking', `You were marked as a no-show for your booking on ${formattedDate} at ${formattedTime}. If this was in error, please contact staff.`, 'booking', 'booking']
      );
      
      sendNotificationToUser(booking.userEmail, {
        type: 'notification',
        title: 'Missed Booking',
        message: `You were marked as a no-show for your booking on ${formattedDate} at ${formattedTime}. If this was in error, please contact staff.`,
        data: { bookingId, eventType: 'booking_no_show' }
      }, { action: 'booking_no_show', bookingId, triggerSource: 'approval.ts' });
    }
    
    res.json({ success: true, booking: result[0] });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to update booking status', error);
  }
});

export default router;
