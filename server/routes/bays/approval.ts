import { Router } from 'express';
import { db } from '../../db';
import { pool } from '../../core/db';
import { bookingRequests, resources, notifications, users, bookingMembers, bookingParticipants } from '../../../shared/schema';
import { eq, and, or, gt, lt, lte, gte, ne, sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../../core/middleware';
import { sendPushNotification, sendPushNotificationToStaff } from '../push';
import { formatNotificationDateTime, formatDateDisplayWithDay, formatTime12Hour } from '../../utils/dateUtils';
import { logAndRespond } from '../../core/logger';
import { logFromRequest } from '../../core/auditLog';
import { checkClosureConflict, checkAvailabilityBlockConflict } from '../../core/bookingValidation';
import { bookingEvents } from '../../core/bookingEvents';
import { sendNotificationToUser, broadcastAvailabilityUpdate, broadcastMemberStatsUpdated, broadcastBillingUpdate } from '../../core/websocket';
import { getSessionUser } from '../../types/session';
import { refundGuestPass } from '../guestPasses';
import { updateHubSpotContactVisitCount } from '../../core/memberSync';
import { createSessionWithUsageTracking, ensureBookingSession } from '../../core/bookingService/sessionManager';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants, recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { PaymentStatusService } from '../../core/billing/PaymentStatusService';
import { cancelPaymentIntent, getStripeClient } from '../../core/stripe';
import { getCalendarNameForBayAsync } from './helpers';
import { getCalendarIdByName, createCalendarEventOnCalendar, deleteCalendarEvent, CALENDAR_CONFIG } from '../../core/calendar/index';
import { releaseGuestPassHold } from '../../core/billing/guestPassHoldService';

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
      
      const { updated, bayName, approvalMessage, isConferenceRoom } = await db.transaction(async (tx) => {
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
        if (!updatedRow.sessionId) {
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
                trackmanBookingId: updatedRow.trackmanBookingId || undefined,
                declaredPlayerCount: updatedRow.declaredPlayerCount || undefined,
                bookingId: bookingId
              },
              'member_request',
              tx
            );
            
            if (sessionResult.success && sessionResult.session) {
              createdSessionId = sessionResult.session.id;
              createdParticipantIds = sessionResult.participants?.map(p => p.id) || [];
              
              await tx.update(bookingRequests)
                .set({ 
                  sessionId: createdSessionId
                })
                .where(eq(bookingRequests.id, bookingId));
              
              console.log(`[Booking Approval] Created session ${createdSessionId} for booking ${bookingId} with ${createdParticipantIds.length} participants, ${sessionResult.usageLedgerEntries || 0} ledger entries`);
            } else {
              console.error(`[Booking Approval] Session creation failed: ${sessionResult.error}`);
              throw { statusCode: 500, error: 'Failed to create booking session. Please try again.', details: sessionResult.error };
            }
          } catch (sessionError: any) {
            console.error('[Booking Approval] Failed to create session:', sessionError);
            throw { statusCode: 500, error: 'Failed to create booking session. Please try again.', details: sessionError.message || sessionError };
          }
        }
        
        if (createdSessionId && createdParticipantIds.length > 0) {
          try {
            const breakdown = await recalculateSessionFees(createdSessionId, 'approval');
            console.log(`[Booking Approval] Applied unified fees for session ${createdSessionId}: $${(breakdown.totals.totalCents/100).toFixed(2)}, overage: $${(breakdown.totals.overageCents/100).toFixed(2)}`);
          } catch (feeError) {
            console.error('[Booking Approval] Failed to compute/apply fees:', feeError);
          }
        }
        
        const resourceTypeName = isConferenceRoom ? 'conference room' : 'simulator';
        const approvalMessage = `Your ${resourceTypeName} booking for ${formatNotificationDateTime(updatedRow.requestDate, updatedRow.startTime)} has been approved.`;
        
        await tx.insert(notifications).values({
          userEmail: updatedRow.userEmail,
          title: 'Booking Request Approved',
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
        
        return { updated: updatedRow, bayName, approvalMessage, isConferenceRoom };
      });
      
      sendPushNotification(updated.userEmail, {
        title: 'Booking Approved!',
        body: approvalMessage,
        url: '/sims'
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
        resourceType: isConferenceRoom ? 'conference_room' : 'simulator',
        date: updated.requestDate,
        action: 'booked'
      });
      
      sendNotificationToUser(updated.userEmail, {
        type: 'notification',
        title: 'Booking Approved',
        message: approvalMessage,
        data: { bookingId: parseInt(id, 10), eventType: 'booking_approved' }
      }, { action: 'booking_approved', bookingId: parseInt(id, 10), triggerSource: 'approval.ts' });
      
      return res.json(formatRow(updated));
    }
    
    if (status === 'declined') {
      const bookingId = parseInt(id, 10);
      
      const { updated, declineMessage, resourceTypeName } = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
        
        if (!existing) {
          throw { statusCode: 404, error: 'Booking request not found' };
        }
        
        let resourceTypeName = 'simulator';
        if (existing.resourceId) {
          const [resource] = await tx.select({ type: resources.type }).from(resources).where(eq(resources.id, existing.resourceId));
          if (resource?.type === 'conference_room') {
            resourceTypeName = 'conference room';
          }
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
        
        const declineMessage = suggested_time 
          ? `Your ${resourceTypeName} booking request for ${formatDateDisplayWithDay(updatedRow.requestDate)} was declined. Suggested alternative: ${formatTime12Hour(suggested_time)}`
          : `Your ${resourceTypeName} booking request for ${formatDateDisplayWithDay(updatedRow.requestDate)} was declined.`;
        
        await tx.insert(notifications).values({
          userEmail: updatedRow.userEmail,
          title: 'Booking Request Declined',
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
        
        return { updated: updatedRow, declineMessage, resourceTypeName };
      });
      
      await releaseGuestPassHold(bookingId);
      
      sendPushNotification(updated.userEmail, {
        title: 'Booking Request Update',
        body: declineMessage,
        url: '/sims'
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
        title: 'Booking Declined',
        message: declineMessage,
        data: { bookingId: parseInt(id, 10), eventType: 'booking_declined' }
      }, { action: 'booking_declined', bookingId: parseInt(id, 10), triggerSource: 'approval.ts' });
      
      return res.json(formatRow(updated));
    }
    
    if (status === 'cancelled') {
      const bookingId = parseInt(id, 10);
      const { cancelled_by } = req.body;
      
      const { updated, bookingData, pushInfo, overageRefundResult, isConferenceRoom: isConfRoom } = await db.transaction(async (tx) => {
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
          overageFeeCents: bookingRequests.overageFeeCents,
          sessionId: bookingRequests.sessionId
        })
          .from(bookingRequests)
          .where(eq(bookingRequests.id, bookingId));
        
        if (!existing) {
          throw { statusCode: 404, error: 'Booking request not found' };
        }
        
        let isConferenceRoom = false;
        if (existing.resourceId) {
          const [resource] = await tx.select({ type: resources.type }).from(resources).where(eq(resources.id, existing.resourceId));
          isConferenceRoom = resource?.type === 'conference_room';
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
        
        // Handle all payment intents - refund succeeded ones, cancel pending ones
        try {
          const stripe = await getStripeClient();
          
          // Get ALL payment intents for this booking from fee snapshots
          const allSnapshots = await pool.query(
            `SELECT id, stripe_payment_intent_id, status as snapshot_status, total_cents
             FROM booking_fee_snapshots 
             WHERE booking_id = $1 AND stripe_payment_intent_id IS NOT NULL`,
            [bookingId]
          );
          
          for (const snapshot of allSnapshots.rows) {
            try {
              const pi = await stripe.paymentIntents.retrieve(snapshot.stripe_payment_intent_id);
              
              if (pi.status === 'succeeded') {
                // Refund succeeded payments
                const refund = await stripe.refunds.create({
                  payment_intent: snapshot.stripe_payment_intent_id,
                  reason: 'requested_by_customer'
                });
                console.log(`[Staff Cancel] Refunded payment ${snapshot.stripe_payment_intent_id} for booking ${bookingId}: $${(pi.amount / 100).toFixed(2)}, refund: ${refund.id}`);
                
                // Use centralized service to update all related records atomically
                await PaymentStatusService.markPaymentRefunded({
                  paymentIntentId: snapshot.stripe_payment_intent_id,
                  bookingId,
                  refundId: refund.id,
                  amountCents: pi.amount
                });
              } else if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status)) {
                // Cancel pending payments
                await stripe.paymentIntents.cancel(snapshot.stripe_payment_intent_id);
                console.log(`[Staff Cancel] Cancelled payment intent ${snapshot.stripe_payment_intent_id} for booking ${bookingId}`);
                
                await PaymentStatusService.markPaymentCancelled({
                  paymentIntentId: snapshot.stripe_payment_intent_id
                });
              } else if (pi.status === 'canceled') {
                // Already cancelled, just update snapshot via service
                await PaymentStatusService.markPaymentCancelled({
                  paymentIntentId: snapshot.stripe_payment_intent_id
                });
              }
            } catch (piErr: any) {
              console.error(`[Staff Cancel] Failed to handle payment ${snapshot.stripe_payment_intent_id}:`, piErr.message);
            }
          }
          
          // Also handle any payment intents in stripe_payment_intents not linked to snapshots
          const otherIntents = await pool.query(
            `SELECT stripe_payment_intent_id 
             FROM stripe_payment_intents 
             WHERE booking_id = $1 
             AND stripe_payment_intent_id NOT IN (
               SELECT stripe_payment_intent_id FROM booking_fee_snapshots 
               WHERE booking_id = $1 AND stripe_payment_intent_id IS NOT NULL
             )`,
            [bookingId]
          );
          
          for (const row of otherIntents.rows) {
            try {
              await cancelPaymentIntent(row.stripe_payment_intent_id);
              console.log(`[Staff Cancel] Cancelled orphan payment intent ${row.stripe_payment_intent_id} for booking ${bookingId}`);
            } catch (cancelErr: any) {
              // Ignore errors for orphan intents
            }
          }
          
          // Update participant payment status to refunded for any paid participants
          if (existing.sessionId) {
            await pool.query(
              `UPDATE booking_participants SET payment_status = 'refunded' 
               WHERE session_id = $1 AND payment_status = 'paid'`,
              [existing.sessionId]
            );
          }
        } catch (cancelIntentsErr) {
          console.error('[Staff Cancel] Failed to handle payment intents (non-blocking):', cancelIntentsErr);
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
          
          // Clear pending fees for cancelled booking
          try {
            await pool.query(
              `UPDATE booking_participants 
               SET cached_fee_cents = 0, payment_status = 'waived'
               WHERE session_id = $1 
               AND payment_status = 'pending'`,
              [sessionResult[0].sessionId]
            );
            console.log(`[Staff Cancel] Cleared pending fees for session ${sessionResult[0].sessionId}`);
          } catch (feeCleanupErr) {
            console.error('[Staff Cancel] Failed to clear pending fees (non-blocking):', feeCleanupErr);
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
        
        return { updated: updatedRow, bookingData: existing, pushInfo, overageRefundResult, isConferenceRoom };
      });
      
      await releaseGuestPassHold(bookingId);
      
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
            url: '/admin/bookings'
          }).catch(err => console.error('Staff push notification failed:', err));
          if (pushInfo.email) {
            sendPushNotification(pushInfo.email, {
              title: 'Booking Cancelled',
              body: pushInfo.memberMessage || pushInfo.message,
              url: '/sims'
            }).catch(err => console.error('Member push notification failed:', err));
          }
        } else if (pushInfo.type === 'staff') {
          sendPushNotificationToStaff({
            title: 'Booking Cancelled',
            body: pushInfo.message,
            url: '/admin/bookings'
          }).catch(err => console.error('Staff push notification failed:', err));
        } else if (pushInfo.email) {
          sendPushNotification(pushInfo.email, {
            title: 'Booking Cancelled',
            body: pushInfo.message,
            url: '/sims'
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
        resourceType: isConfRoom ? 'conference_room' : 'simulator',
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
      
      logFromRequest(req, 'cancel_booking', 'booking', id, {
        member_email: bookingData.userEmail,
        member_name: bookingData.userName,
        booking_date: bookingData.requestDate,
        start_time: bookingData.startTime,
        refund_result: overageRefundResult
      });
      
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
    const { isConstraintError } = await import('../../core/db');
    const constraint = isConstraintError(error);
    if (constraint.type === 'unique') {
      return res.status(409).json({ error: 'This booking may have already been processed. Please refresh and try again.' });
    }
    if (constraint.type === 'foreign_key') {
      return res.status(400).json({ error: 'Referenced record not found. Please refresh and try again.' });
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
      SELECT br.status, br.user_email, br.session_id, br.declared_player_count, br.trackman_player_count
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
        const declaredCount = roster.declared_player_count || roster.trackman_player_count || 1;
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
    
    if (newStatus === 'attended' && !existing.session_id && !skipPaymentCheck) {
      const sessionResult = await ensureBookingSession(bookingId, 'checkin_auto_create');
      
      if (sessionResult.sessionId) {
        existing.session_id = sessionResult.sessionId;
        console.log(`[Check-in] Auto-created session ${sessionResult.sessionId} for booking ${bookingId}`);
      } else {
        // Session creation failed - check if this booking has any fees that would require a session
        // For zero-fee bookings (solo member with no guests, no overage), allow check-in without session
        const declaredPlayers = existing.declared_player_count || existing.trackman_player_count || 1;
        const hasGuests = declaredPlayers > 1;
        
        if (!hasGuests) {
          // Solo booking with no guests - allow check-in without session for zero-fee scenarios
          console.log(`[Check-in] Session creation failed but allowing check-in for solo booking ${bookingId}: ${sessionResult.error}`);
        } else {
          // Has guests that might incur fees - require session
          return res.status(400).json({
            error: 'Billing session could not be generated',
            requiresSync: true,
            message: sessionResult.error || 'System attempted to generate a billing session but failed. Please contact support.'
          });
        }
      }
    }
    
    if (newStatus === 'attended' && existing.session_id && !skipPaymentCheck) {
      const nullFeesCheck = await pool.query(`
        SELECT COUNT(*) as null_count
        FROM booking_participants bp
        WHERE bp.session_id = $1 AND bp.payment_status = 'pending' AND bp.cached_fee_cents IS NULL
      `, [existing.session_id]);
      
      if (parseInt(nullFeesCheck.rows[0]?.null_count) > 0) {
        try {
          await recalculateSessionFees(existing.session_id, 'checkin');
          console.log(`[Check-in Guard] Recalculated fees for session ${existing.session_id} - some participants had NULL cached_fee_cents`);
        } catch (recalcError) {
          console.error(`[Check-in Guard] Failed to recalculate fees for session ${existing.session_id}:`, recalcError);
        }
      }
      
      const balanceResult = await pool.query(`
        SELECT 
          bp.id as participant_id,
          bp.display_name,
          bp.participant_type,
          bp.payment_status,
          COALESCE(bp.cached_fee_cents, 0)::numeric / 100.0 as fee_amount
        FROM booking_participants bp
        WHERE bp.session_id = $1 AND bp.payment_status = 'pending'
      `, [existing.session_id]);
      
      let totalOutstanding = 0;
      const unpaidParticipants: Array<{ id: number; name: string; amount: number }> = [];
      
      for (const p of balanceResult.rows) {
        const amount = parseFloat(p.fee_amount);
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
