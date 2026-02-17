import { Router } from 'express';
import { db } from '../../db';
import { pool } from '../../core/db';
import { bookingRequests, resources, notifications, users, bookingMembers, bookingParticipants } from '../../../shared/schema';
import { eq, and, or, gt, lt, lte, gte, ne, sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../../core/middleware';
import { sendPushNotification } from '../push';
import { formatNotificationDateTime, formatDateDisplayWithDay, formatTime12Hour } from '../../utils/dateUtils';
import { logAndRespond } from '../../core/logger';
import { logFromRequest } from '../../core/auditLog';
import { notifyAllStaff } from '../../core/notificationService';
import { checkClosureConflict, checkAvailabilityBlockConflict } from '../../core/bookingValidation';
import { bookingEvents } from '../../core/bookingEvents';
import { sendNotificationToUser, broadcastAvailabilityUpdate, broadcastMemberStatsUpdated, broadcastBillingUpdate } from '../../core/websocket';
import { getSessionUser } from '../../types/session';
import { refundGuestPass } from '../guestPasses';
import { updateHubSpotContactVisitCount } from '../../core/memberSync';
import { createSessionWithUsageTracking, ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants, recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { PaymentStatusService } from '../../core/billing/PaymentStatusService';
import { cancelPaymentIntent, getStripeClient } from '../../core/stripe';
import { getCalendarNameForBayAsync } from './helpers';
import { getCalendarIdByName, createCalendarEventOnCalendar, deleteCalendarEvent, CALENDAR_CONFIG } from '../../core/calendar/index';
import { releaseGuestPassHold } from '../../core/billing/guestPassHoldService';
import { createPrepaymentIntent } from '../../core/billing/prepaymentService';
import { getErrorMessage, getErrorStatusCode } from '../../utils/errorUtils';

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
      const bookingId = parseInt(id as string, 10);
      
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
            
            // Build participants array starting with owner
            const sessionParticipants: Array<{
              userId?: string;
              guestId?: number;
              participantType: 'owner' | 'member' | 'guest';
              displayName: string;
            }> = [{
              userId: ownerUserId || undefined,
              participantType: 'owner',
              displayName: updatedRow.userName || updatedRow.userEmail
            }];
            
            // Convert request_participants to session participants
            const requestParticipants = updatedRow.requestParticipants as Array<{
              email?: string;
              type: 'member' | 'guest';
              userId?: string;
              name?: string;
            }> | null;
            
            // Track added participants to prevent duplicates
            const addedUserIds = new Set<string>();
            const addedEmails = new Set<string>();
            const ownerEmailNormalized = updatedRow.userEmail.toLowerCase();
            
            // Mark owner as already added
            if (ownerUserId) addedUserIds.add(ownerUserId);
            addedEmails.add(ownerEmailNormalized);
            
            if (requestParticipants && Array.isArray(requestParticipants)) {
              for (const rp of requestParticipants) {
                // Validate entry structure
                if (!rp || typeof rp !== 'object') {
                  console.warn('[Booking Approval] Skipping invalid request participant entry:', rp);
                  continue;
                }
                
                const rpEmailNormalized = rp.email?.toLowerCase()?.trim() || '';
                
                // Skip if this is the owner (by email or userId)
                if (rpEmailNormalized && rpEmailNormalized === ownerEmailNormalized) {
                  continue;
                }
                if (rp.userId && rp.userId === ownerUserId) {
                  continue;
                }
                
                // Skip if already added (duplicate detection)
                if (rp.userId && addedUserIds.has(rp.userId)) {
                  continue;
                }
                if (rpEmailNormalized && addedEmails.has(rpEmailNormalized)) {
                  continue;
                }
                
                // Determine if this is a member: check userId, or lookup by email
                let resolvedUserId = rp.userId;
                let resolvedName = rp.name;
                let isMember = rp.type === 'member';
                
                // If type is 'member' but no userId, try to resolve by email
                if (isMember && !resolvedUserId && rpEmailNormalized) {
                  const memberResult = await tx.select({ id: users.id, firstName: users.firstName })
                    .from(users)
                    .where(eq(sql`LOWER(${users.email})`, rpEmailNormalized))
                    .limit(1);
                  if (memberResult.length > 0) {
                    resolvedUserId = memberResult[0].id;
                    if (!resolvedName) resolvedName = memberResult[0].firstName || rpEmailNormalized;
                  }
                }
                
                // Also check if email matches an existing user (for guests who are actually members)
                if (!resolvedUserId && rpEmailNormalized) {
                  const memberResult = await tx.select({ id: users.id, firstName: users.firstName })
                    .from(users)
                    .where(eq(sql`LOWER(${users.email})`, rpEmailNormalized))
                    .limit(1);
                  if (memberResult.length > 0) {
                    // This "guest" is actually a member
                    resolvedUserId = memberResult[0].id;
                    isMember = true;
                    if (!resolvedName) resolvedName = memberResult[0].firstName || rpEmailNormalized;
                    console.log(`[Booking Approval] Converted guest to member: ${rpEmailNormalized}`);
                  }
                }
                
                // Get member name if we have userId but no name
                if (resolvedUserId && !resolvedName) {
                  const memberResult = await tx.select({ firstName: users.firstName, email: users.email })
                    .from(users)
                    .where(eq(users.id, resolvedUserId))
                    .limit(1);
                  if (memberResult.length > 0) {
                    resolvedName = memberResult[0].firstName || memberResult[0].email;
                  }
                }
                
                if (isMember && resolvedUserId) {
                  sessionParticipants.push({
                    userId: resolvedUserId,
                    participantType: 'member',
                    displayName: resolvedName || rpEmailNormalized || 'Member'
                  });
                  addedUserIds.add(resolvedUserId);
                  if (rpEmailNormalized) addedEmails.add(rpEmailNormalized);
                } else {
                  // True guest - no matching member found
                  sessionParticipants.push({
                    participantType: 'guest',
                    displayName: resolvedName || rp.name || rpEmailNormalized || 'Guest'
                  });
                  if (rpEmailNormalized) addedEmails.add(rpEmailNormalized);
                }
              }
              console.log(`[Booking Approval] Converted ${requestParticipants.length} request participants to ${sessionParticipants.length - 1} session participants (plus owner)`);
            }
            
            const sessionResult = await createSessionWithUsageTracking(
              {
                ownerEmail: updatedRow.userEmail,
                resourceId: assignedBayId,
                sessionDate: updatedRow.requestDate,
                startTime: updatedRow.startTime,
                endTime: updatedRow.endTime,
                durationMinutes: updatedRow.durationMinutes,
                participants: sessionParticipants,
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
          } catch (sessionError: unknown) {
            console.error('[Booking Approval] Failed to create session:', sessionError);
            throw { statusCode: 500, error: 'Failed to create booking session. Please try again.', details: getErrorMessage(sessionError) || sessionError };
          }
        }
        
        let breakdown: { totals: { totalCents: number; overageCents: number; guestCents: number } } | null = null;
        if (createdSessionId && createdParticipantIds.length > 0) {
          try {
            breakdown = await recalculateSessionFees(createdSessionId, 'approval');
            console.log(`[Booking Approval] Applied unified fees for session ${createdSessionId}: $${(breakdown.totals.totalCents/100).toFixed(2)}, overage: $${(breakdown.totals.overageCents/100).toFixed(2)}`);
            
            if (breakdown.totals.totalCents > 0) {
              try {
                let ownerUserId = updatedRow.userId;
                if (!ownerUserId && updatedRow.userEmail) {
                  const userResult = await tx.select({ id: users.id })
                    .from(users)
                    .where(eq(users.email, updatedRow.userEmail.toLowerCase()))
                    .limit(1);
                  if (userResult.length > 0) {
                    ownerUserId = userResult[0].id;
                  }
                }
                
                const prepayResult = await createPrepaymentIntent({
                  sessionId: createdSessionId,
                  bookingId: bookingId,
                  userId: ownerUserId || null,
                  userEmail: updatedRow.userEmail,
                  userName: updatedRow.userName || updatedRow.userEmail,
                  totalFeeCents: breakdown.totals.totalCents,
                  feeBreakdown: { overageCents: breakdown.totals.overageCents, guestCents: breakdown.totals.guestCents }
                });
                if (prepayResult?.paidInFull) {
                  await pool.query(
                    `UPDATE booking_participants SET payment_status = 'paid' WHERE session_id = $1 AND payment_status = 'pending'`,
                    [createdSessionId]
                  );
                  console.log(`[Booking Approval] Prepayment fully covered by credit for session ${createdSessionId}`);
                }
              } catch (prepayError) {
                console.error('[Booking Approval] Failed to create prepayment intent:', prepayError);
              }
            }
          } catch (feeError) {
            console.error('[Booking Approval] Failed to compute/apply fees:', feeError);
          }
        }
        
        const resourceTypeName = isConferenceRoom ? 'conference room' : 'simulator';
        const feeMessage = breakdown?.totals?.totalCents && breakdown.totals.totalCents > 0 
          ? ` Estimated fees: $${(breakdown.totals.totalCents / 100).toFixed(2)}.` 
          : '';
        const approvalMessage = `Your ${resourceTypeName} booking for ${formatNotificationDateTime(updatedRow.requestDate, updatedRow.startTime)} has been approved.${feeMessage}`;
        
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
      
      // Add request_participants to booking_members so they appear on dashboards (runs for ALL approved bookings)
      (async () => {
        try {
          const requestParticipants = updated.requestParticipants as Array<{
            email?: string;
            type: 'member' | 'guest';
            userId?: string;
            name?: string;
          }> | null;
          
          if (requestParticipants && Array.isArray(requestParticipants) && requestParticipants.length > 0) {
            const ownerUserId = updated.userId;
            const ownerEmailLower = updated.userEmail?.toLowerCase();
            
            for (let i = 0; i < requestParticipants.length; i++) {
              const rp = requestParticipants[i];
              if (!rp || typeof rp !== 'object') continue;
              
              // Slot number is index + 2 (owner is slot 1)
              const slotNumber = i + 2;
              
              // Resolve email from userId if not present
              let participantEmail = rp.email?.toLowerCase()?.trim() || '';
              if (!participantEmail && rp.userId) {
                const userResult = await db.select({ email: users.email })
                  .from(users)
                  .where(eq(users.id, rp.userId))
                  .limit(1);
                if (userResult.length > 0) {
                  participantEmail = userResult[0].email?.toLowerCase() || '';
                }
              }
              
              // Skip if this is the owner (check both email and userId)
              if (participantEmail && participantEmail === ownerEmailLower) {
                continue;
              }
              if (rp.userId && ownerUserId && rp.userId === ownerUserId) {
                continue;
              }
              
              // Only add if we have an email
              if (participantEmail) {
                try {
                  await db.insert(bookingMembers).values({
                    bookingId: parseInt(id as string, 10),
                    userEmail: participantEmail,
                    slotNumber: slotNumber,
                    isPrimary: false,
                    createdAt: new Date()
                  }).onConflictDoNothing();
                  console.log(`[Booking Approval] Added participant ${participantEmail} to booking_members for booking ${id} (slot ${slotNumber})`);
                } catch (memberError) {
                  console.error(`[Booking Approval] Failed to add participant to booking_members:`, memberError);
                }
              }
            }
          }
        } catch (err) {
          console.error('[Booking Approval] Failed to populate booking_members:', err);
        }
      })();
      
      (async () => {
        try {
          const linkedMembers = await db.select({ userEmail: bookingMembers.userEmail })
            .from(bookingMembers)
            .where(and(
              eq(bookingMembers.bookingId, parseInt(id as string, 10)),
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
                relatedId: parseInt(id as string, 10),
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
                data: { bookingId: parseInt(id as string, 10), eventType: 'booking_approved' }
              }, { action: 'booking_approved_linked', bookingId: parseInt(id as string, 10), triggerSource: 'approval.ts' });
            }
          }
        } catch (err) {
          console.error('Failed to notify linked members:', err);
        }
      })();
      
      bookingEvents.publish('booking_approved', {
        bookingId: parseInt(id as string, 10),
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
        data: { bookingId: parseInt(id as string, 10), eventType: 'booking_approved' }
      }, { action: 'booking_approved', bookingId: parseInt(id as string, 10), triggerSource: 'approval.ts' });
      
      // Notify participants (excluding owner) that they've been added to the approved booking
      // Use request_participants directly to avoid race condition with booking_members linking
      if (updated.userEmail) {
        (async () => {
          try {
            const requestParticipants = updated.requestParticipants as Array<{
              email?: string;
              type: 'member' | 'guest';
              userId?: string;
              name?: string;
            }> | null;
            
            if (!requestParticipants || !Array.isArray(requestParticipants) || requestParticipants.length === 0) {
              return; // No participants to notify
            }
            
            const ownerEmailLower = updated.userEmail?.toLowerCase();
            const ownerName = updated.userName || updated.userEmail?.split('@')[0] || 'A member';
            const formattedDate = formatDateDisplayWithDay(updated.requestDate);
            const formattedTime = formatTime12Hour(updated.startTime || '');
            const processedEmails = new Set<string>();
            
            for (const rp of requestParticipants) {
              if (!rp || typeof rp !== 'object') continue;
              if (rp.type !== 'member') continue; // Only notify members, not guests
              
              // Resolve email from userId if not present
              let participantEmail = rp.email?.toLowerCase()?.trim() || '';
              if (!participantEmail && rp.userId) {
                const userResult = await db.select({ email: users.email })
                  .from(users)
                  .where(eq(users.id, rp.userId))
                  .limit(1);
                if (userResult.length > 0) {
                  participantEmail = userResult[0].email?.toLowerCase() || '';
                }
              }
              
              if (!participantEmail) continue;
              if (participantEmail === ownerEmailLower) continue; // Skip owner
              if (processedEmails.has(participantEmail)) continue;
              processedEmails.add(participantEmail);
              
              const notificationMsg = `${ownerName} has added you to their simulator booking on ${formattedDate} at ${formattedTime}.`;
              
              await pool.query(
                `INSERT INTO notifications (user_email, title, message, type, related_type, related_id, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [participantEmail, 'Added to Booking', notificationMsg, 'booking', 'booking', bookingId]
              );
              
              sendNotificationToUser(participantEmail, {
                type: 'notification',
                title: 'Added to Booking',
                message: notificationMsg,
                data: { bookingId: bookingId.toString(), eventType: 'booking_participant_added' }
              }, { action: 'booking_participant_added', bookingId, triggerSource: 'approval.ts' });
              
              console.log(`[Approval] Sent 'Added to Booking' notification to ${participantEmail} for booking ${bookingId}`);
            }
          } catch (notifyErr) {
            console.error('[Approval] Failed to notify participants (non-blocking):', notifyErr);
          }
        })();
      }
      
      return res.json(formatRow(updated));
    }
    
    if (status === 'declined') {
      const bookingId = parseInt(id as string, 10);
      
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
        bookingId: parseInt(id as string, 10),
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
        data: { bookingId: parseInt(id as string, 10), eventType: 'booking_declined' }
      }, { action: 'booking_declined', bookingId: parseInt(id as string, 10), triggerSource: 'approval.ts' });
      
      return res.json(formatRow(updated));
    }
    
    if (status === 'cancelled') {
      const bookingId = parseInt(id as string, 10);
      const { cancelled_by } = req.body;
      
      const { updated, bookingData, pushInfo, overageRefundResult, isConferenceRoom: isConfRoom, isPendingCancel, alreadyPending } = await db.transaction(async (tx) => {
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
          sessionId: bookingRequests.sessionId,
          staffNotes: bookingRequests.staffNotes
        })
          .from(bookingRequests)
          .where(eq(bookingRequests.id, bookingId));
        
        if (!existing) {
          throw { statusCode: 404, error: 'Booking request not found' };
        }
        
        if (existing.status === 'cancellation_pending') {
          return {
            updated: existing as any,
            bookingData: existing,
            pushInfo: null as any,
            overageRefundResult: {},
            isConferenceRoom: false,
            isPendingCancel: true,
            alreadyPending: true
          };
        }
        
        const isTrackmanLinked = !!existing.trackmanBookingId;
        const wasApproved = existing.status === 'approved';
        const needsPendingCancel = isTrackmanLinked && wasApproved;
        
        if (needsPendingCancel) {
          const [updatedRow] = await tx.update(bookingRequests)
            .set({
              status: 'cancellation_pending',
              cancellationPendingAt: new Date(),
              staffNotes: (existing.staffNotes || '') + '\n[Staff initiated cancellation - awaiting Trackman cancellation]',
              updatedAt: new Date()
            })
            .where(eq(bookingRequests.id, bookingId))
            .returning();
          
          const memberName = existing.userName || existing.userEmail || 'Member';
          const bookingDate = existing.requestDate;
          const bookingTime = existing.startTime?.substring(0, 5) || '';
          let bayName = 'Bay';
          if (existing.resourceId) {
            const [resource] = await tx.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
            if (resource?.name) bayName = resource.name;
          }
          
          return {
            updated: updatedRow,
            bookingData: existing,
            pushInfo: { type: 'staff' as const, memberName, bookingDate, bookingTime, bayName },
            overageRefundResult: {},
            isConferenceRoom: false,
            isPendingCancel: true,
            alreadyPending: false
          };
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
          } catch (paymentErr: unknown) {
            console.error('[Staff Cancel] Failed to handle overage payment (non-blocking):', paymentErr);
            overageRefundResult = { error: getErrorMessage(paymentErr) };
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
            } catch (piErr: unknown) {
              console.error(`[Staff Cancel] Failed to handle payment ${snapshot.stripe_payment_intent_id}:`, getErrorMessage(piErr));
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
            } catch (cancelErr: unknown) {
              // Ignore errors for orphan intents
            }
          }
          
          // Update participant payment status for all participants in this session
          if (existing.sessionId) {
            // Mark paid participants as refunded
            await pool.query(
              `UPDATE booking_participants SET payment_status = 'refunded' 
               WHERE session_id = $1 AND payment_status = 'paid'`,
              [existing.sessionId]
            );
            
            // Mark pending participants as waived (booking cancelled before payment)
            await pool.query(
              `UPDATE booking_participants SET payment_status = 'waived' 
               WHERE session_id = $1 AND (payment_status = 'pending' OR payment_status IS NULL)`,
              [existing.sessionId]
            );
            console.log(`[Staff Cancel] Cleared pending fees for session ${existing.sessionId}`);
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
              } catch (refundErr: unknown) {
                console.error(`[Staff Cancel] Failed to refund participant ${participant.id}:`, getErrorMessage(refundErr));
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
        const existingWasApproved = existing.status === 'approved';
        
        const friendlyDateTime = formatNotificationDateTime(bookingDate, existing.startTime || '00:00');
        const statusLabel = existingWasApproved ? 'booking' : 'booking request';
        
        if (memberCancelled) {
          const staffMessage = `${memberName} has cancelled their ${statusLabel} for ${friendlyDateTime}.`;
          const memberMessage = `Your ${statusLabel} for ${friendlyDateTime} has been cancelled.`;
          
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
        
        return { updated: updatedRow, bookingData: existing, pushInfo, overageRefundResult, isConferenceRoom, isPendingCancel: false, alreadyPending: false };
      });
      
      if (isPendingCancel) {
        if (alreadyPending) {
          return res.json({ success: true, status: 'cancellation_pending' });
        }
        
        const { memberName, bookingDate, bookingTime, bayName } = pushInfo;
        
        const staffMessage = `Booking cancellation pending for ${memberName} on ${bookingDate} at ${bookingTime} (${bayName}). Please cancel in Trackman to complete.`;
        notifyAllStaff(
          'Cancel in Trackman Required',
          staffMessage,
          'booking_cancelled',
          {
            relatedId: bookingId,
            relatedType: 'booking_request',
            url: '/admin/bookings'
          }
        ).catch(err => console.error('Staff cancellation notification failed:', err));
        
        await db.insert(notifications).values({
          userEmail: bookingData.userEmail || '',
          title: 'Booking Cancellation in Progress',
          message: `Your booking for ${bookingDate} at ${bookingTime} is being cancelled. You'll be notified once it's fully processed.`,
          type: 'cancellation_pending',
          relatedId: bookingId,
          relatedType: 'booking_request'
        });
        
        if (bookingData.userEmail) {
          sendPushNotification(bookingData.userEmail, {
            title: 'Booking Cancellation in Progress',
            body: `Your booking for ${bookingDate} at ${bookingTime} is being cancelled. You'll be notified once it's fully processed.`,
            url: '/sims'
          }).catch(err => console.error('Member push notification failed:', err));
        }
        
        logFromRequest(req, 'cancellation_requested', 'booking', id.toString(), undefined, {
          member_email: bookingData.userEmail,
          trackman_booking_id: bookingData.trackmanBookingId,
          initiated_by: 'staff'
        });
        
        return res.json({ success: true, status: 'cancellation_pending' });
      }
      
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
          notifyAllStaff(
            'Booking Cancelled by Member',
            pushInfo.staffMessage || pushInfo.message,
            'booking_cancelled',
            {
              relatedId: bookingId,
              relatedType: 'booking_request',
              url: '/admin/bookings'
            }
          ).catch(err => console.error('Staff cancellation notification failed:', err));
          if (pushInfo.email) {
            sendPushNotification(pushInfo.email, {
              title: 'Booking Cancelled',
              body: pushInfo.memberMessage || pushInfo.message,
              url: '/sims'
            }).catch(err => console.error('Member push notification failed:', err));
          }
        } else if (pushInfo.type === 'staff') {
          notifyAllStaff(
            'Booking Cancelled by Staff',
            pushInfo.message,
            'booking_cancelled',
            {
              relatedId: bookingId,
              relatedType: 'booking_request',
              url: '/admin/bookings'
            }
          ).catch(err => console.error('Staff cancellation notification failed:', err));
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
        bookingId: parseInt(id as string, 10),
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
          data: { bookingId: parseInt(id as string, 10), eventType: 'booking_cancelled' }
        }, { action: 'booking_cancelled', bookingId: parseInt(id as string, 10), triggerSource: 'approval.ts' });
      }
      
      logFromRequest(req, 'cancel_booking', 'booking', id as string, undefined, {
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
      .where(eq(bookingRequests.id, parseInt(id as string, 10)))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Booking request not found' });
    }
    
    res.json(formatRow(result[0]));
  } catch (error: unknown) {
    const statusCode = getErrorStatusCode(error);
    if (statusCode) {
      return res.status(statusCode).json({ 
        error: error && typeof error === 'object' && 'error' in error ? (error as { error: unknown }).error : undefined, 
        message: getErrorMessage(error) 
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
    const bookingId = parseInt(id as string, 10);
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'unknown';
    const staffName = sessionUser?.name || null;
    
    const validStatuses = ['attended', 'no_show'];
    const newStatus = validStatuses.includes(targetStatus) ? targetStatus : 'attended';
    
    const existingResult = await pool.query(`
      SELECT br.status, br.user_email, br.session_id, br.resource_id, br.request_date, br.start_time, br.end_time, br.declared_player_count, br.user_name
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
    
    // Auto-fix: If session is missing, create it now so check-in can proceed
    if (newStatus === 'attended' && !existing.session_id && existing.resource_id) {
      try {
        const userResult = await pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [existing.user_email]);
        const userId = userResult.rows[0]?.id || null;

        const sessionResult = await ensureSessionForBooking({
          bookingId,
          resourceId: existing.resource_id,
          sessionDate: existing.request_date,
          startTime: existing.start_time,
          endTime: existing.end_time,
          ownerEmail: existing.user_email || existing.owner_email || '',
          ownerName: existing.user_name,
          ownerUserId: userId?.toString() || undefined,
          source: 'staff_manual',
          createdBy: staffEmail
        });
        if (sessionResult.sessionId) {
          existing.session_id = sessionResult.sessionId;
          await recalculateSessionFees(sessionResult.sessionId, 'checkin' as any);
        }
      } catch (err) {
        console.error('[Checkin] Failed to auto-create session:', err);
      }
    }
    
    // Allow checking in cancelled bookings if they have a session (for overdue payment recovery)
    const hasSession = existing.session_id !== null;
    const allowedStatuses = ['approved', 'confirmed'];
    if (hasSession && (currentStatus === 'cancelled' || currentStatus === 'cancellation_pending')) {
      allowedStatuses.push('cancelled', 'cancellation_pending');
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
      return res.status(400).json({
        error: 'Billing session not generated yet',
        requiresSync: true,
        message: 'Billing session not generated yet - Check Trackman Sync. The session may need to be synced from Trackman before check-in to ensure proper billing.'
      });
    }
    
    if (newStatus === 'attended' && existing.session_id) {
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
        if (skipPaymentCheck) {
          await pool.query(`
            INSERT INTO booking_payment_audit 
              (booking_id, session_id, action, staff_email, staff_name, amount_affected, metadata)
            VALUES ($1, $2, 'payment_check_bypassed', $3, $4, $5, $6)
          `, [
            bookingId,
            existing.session_id,
            staffEmail,
            staffName,
            totalOutstanding,
            JSON.stringify({ unpaidParticipants, bypassed: true, reason: 'skipPaymentCheck flag used' })
          ]);
          console.warn(`[Check-in Guard] AUDIT: Payment check bypassed by ${staffEmail} for booking ${bookingId}, outstanding: $${totalOutstanding.toFixed(2)}`);
        } else {
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
            error: 'Cannot complete check-in: All fees must be collected first',
            code: 'OUTSTANDING_BALANCE',
            requiresPayment: true,
            totalOutstanding,
            unpaidParticipants,
            pendingCount: unpaidParticipants.length,
            message: `Outstanding balance of $${totalOutstanding.toFixed(2)}. Has the member paid?`
          });
        }
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
        try { broadcastMemberStatsUpdated(booking.userEmail, { lifetimeVisits: updatedUser.lifetime_visits }); } catch (err: unknown) { console.error('[Broadcast] Stats update error:', err); }
      }
      
      // Send check-in confirmation notification to member
      const dateStr = (booking.requestDate as any) instanceof Date 
        ? (booking.requestDate as any).toISOString().split('T')[0] 
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
      const noShowDateStr = (booking.requestDate as any) instanceof Date 
        ? (booking.requestDate as any).toISOString().split('T')[0] 
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
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to update booking status', error);
  }
});

// Dev-only: Directly confirm a booking without webhook simulation
// Creates session, participants, calculates fees, and marks as approved
router.post('/api/admin/bookings/:id/dev-confirm', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const bookingResult = await pool.query(
      `SELECT br.*, u.id as user_id, u.stripe_customer_id, u.tier
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
       WHERE br.id = $1`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    
    if (booking.status !== 'pending' && booking.status !== 'pending_approval') {
      return res.status(400).json({ error: `Booking is already ${booking.status}` });
    }

    let sessionId = booking.session_id;
    let totalFeeCents = 0;
    
    // Create or find session using ensureSessionForBooking
    if (!sessionId && booking.resource_id) {
      const sessionResult = await ensureSessionForBooking({
        bookingId,
        resourceId: booking.resource_id,
        sessionDate: booking.request_date,
        startTime: booking.start_time,
        endTime: booking.end_time,
        ownerEmail: booking.user_email || booking.owner_email || '',
        ownerName: booking.user_name,
        ownerUserId: booking.user_id?.toString() || undefined,
        source: 'staff_manual',
        createdBy: 'dev_confirm'
      });
      sessionId = sessionResult.sessionId || null;
      
      if (sessionId) {
        const sessionDuration = Math.round(
          (new Date(`2000-01-01T${booking.end_time}`).getTime() - 
           new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000
        );
        const playerCount = booking.declared_player_count || 1;
        
        // Create participants from request_participants if available
        const requestParticipants = booking.request_participants as Array<{
          email?: string;
          type: 'member' | 'guest';
          userId?: string;
          name?: string;
        }> | null;
        
        let participantsCreated = 0;
        if (requestParticipants && Array.isArray(requestParticipants)) {
          for (const rp of requestParticipants) {
            if (!rp || typeof rp !== 'object') continue;
            
            let resolvedUserId = rp.userId || null;
            let resolvedName = rp.name || '';
            let participantType = rp.type === 'member' ? 'member' : 'guest';
            
            if (resolvedUserId && !resolvedName) {
              const userResult = await pool.query(
                `SELECT name, first_name, last_name, email FROM users WHERE id = $1`,
                [resolvedUserId]
              );
              if (userResult.rows.length > 0) {
                const u = userResult.rows[0];
                resolvedName = u.name || `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Member';
              }
            }
            
            if (!resolvedUserId && rp.email) {
              const userResult = await pool.query(
                `SELECT id, name, first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)`,
                [rp.email]
              );
              if (userResult.rows.length > 0) {
                resolvedUserId = userResult.rows[0].id;
                participantType = 'member';
                if (!resolvedName) {
                  const u = userResult.rows[0];
                  resolvedName = u.name || `${u.first_name || ''} ${u.last_name || ''}`.trim();
                }
              }
            }
            
            if (!resolvedName) {
              resolvedName = rp.email || `Player ${participantsCreated + 2}`;
            }
            
            await pool.query(`
              INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              VALUES ($1, $2, $3, $4, 'pending', $5)
            `, [sessionId, resolvedUserId, participantType, resolvedName, sessionDuration]);
            
            participantsCreated++;
          }
          console.log(`[Dev Confirm] Created ${participantsCreated} participants from request_participants`);
        }
        
        // If not enough participants from request_participants, create generic guests for remaining slots
        const remainingSlots = playerCount - 1 - participantsCreated;
        for (let i = 0; i < remainingSlots; i++) {
          await pool.query(`
            INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
            VALUES ($1, NULL, 'guest', $2, 'pending', $3)
          `, [sessionId, `Guest ${participantsCreated + i + 2}`, sessionDuration]);
        }
        
        // Add request_participants to booking_members so they appear on dashboards
        if (requestParticipants && Array.isArray(requestParticipants)) {
          let slotNumber = 2;
          for (const rp of requestParticipants) {
            if (!rp || typeof rp !== 'object') continue;
            
            let participantEmail = rp.email?.toLowerCase()?.trim() || '';
            if (!participantEmail && rp.userId) {
              const userResult = await pool.query(
                `SELECT email FROM users WHERE id = $1`,
                [rp.userId]
              );
              if (userResult.rows.length > 0) {
                participantEmail = userResult.rows[0].email?.toLowerCase() || '';
              }
            }
            
            if (participantEmail && participantEmail !== booking.user_email?.toLowerCase()) {
              try {
                await pool.query(`
                  INSERT INTO booking_members (booking_id, user_email, slot_number, is_primary, created_at)
                  VALUES ($1, $2, $3, false, NOW())
                  ON CONFLICT DO NOTHING
                `, [bookingId, participantEmail, slotNumber]);
                slotNumber++;
                console.log(`[Dev Confirm] Added participant ${participantEmail} to booking_members for booking ${bookingId}`);
              } catch (memberError) {
                console.error(`[Dev Confirm] Failed to add participant to booking_members:`, memberError);
              }
            }
          }
        }
        
        // Calculate fees
        try {
          const feeResult = await recalculateSessionFees(sessionId, 'approval');
          if (feeResult?.totalSessionFee) {
            totalFeeCents = feeResult.totalSessionFee;
          }
        } catch (feeError) {
          console.warn('[Dev Confirm] Failed to calculate fees:', feeError);
        }
      }
    }

    // Update booking to approved (no fake trackman ID needed)
    await pool.query(
      `UPDATE booking_requests 
       SET status = 'approved', 
           session_id = COALESCE(session_id, $2),
           notes = COALESCE(notes, '') || E'\n[Dev confirmed]',
           updated_at = NOW()
       WHERE id = $1`,
      [bookingId, sessionId]
    );

    // Log staff action
    await logFromRequest(req, {
      action: 'booking_dev_confirm',
      resourceType: 'booking',
      resourceId: bookingId.toString(),
      resourceName: `Booking #${bookingId}`,
      details: { sessionId, totalFeeCents }
    });

    // Send confirmation notification
    const dateStr = typeof booking.request_date === 'string' 
      ? booking.request_date 
      : booking.request_date.toISOString().split('T')[0];
    const timeStr = typeof booking.start_time === 'string' 
      ? booking.start_time.substring(0, 5) 
      : booking.start_time;
    
    await pool.query(
      `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        booking.user_email, 
        'Booking Confirmed', 
        `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.`,
        'booking',
        'booking'
      ]
    );
    
    sendNotificationToUser(booking.user_email, {
      type: 'notification',
      title: 'Booking Confirmed',
      message: `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.`,
      data: { bookingId: bookingId.toString(), eventType: 'booking_confirmed' }
    }, { action: 'booking_confirmed', bookingId, triggerSource: 'approval.ts' });

    // Notify participants (excluding owner) that they've been added to the booking
    if (booking.user_email) {
      try {
        const participantsResult = await pool.query(
          `SELECT bm.user_email, u.first_name, u.last_name 
           FROM booking_members bm
           LEFT JOIN users u ON LOWER(u.email) = LOWER(bm.user_email)
           WHERE bm.booking_id = $1 
             AND bm.user_email IS NOT NULL 
             AND bm.user_email != ''
             AND bm.is_primary = false
             AND LOWER(bm.user_email) != LOWER($2)`,
          [bookingId, booking.user_email]
        );
        
        const ownerName = booking.user_name || booking.user_email?.split('@')[0] || 'A member';
        const formattedDate = formatDateDisplayWithDay(dateStr);
        const formattedTime = formatTime12Hour(timeStr);
        
        for (const participant of participantsResult.rows) {
          const participantEmail = participant.user_email?.toLowerCase();
          if (!participantEmail) continue;
          
          const notificationMsg = `${ownerName} has added you to their simulator booking on ${formattedDate} at ${formattedTime}.`;
          
          await pool.query(
            `INSERT INTO notifications (user_email, title, message, type, related_type, related_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [participantEmail, 'Added to Booking', notificationMsg, 'booking', 'booking', bookingId]
          );
          
          sendNotificationToUser(participantEmail, {
            type: 'notification',
            title: 'Added to Booking',
            message: notificationMsg,
            data: { bookingId: bookingId.toString(), eventType: 'booking_participant_added' }
          }, { action: 'booking_participant_added', bookingId, triggerSource: 'approval.ts' });
          
          console.log(`[Dev Confirm] Sent 'Added to Booking' notification to ${participantEmail} for booking ${bookingId}`);
        }
      } catch (notifyErr) {
        console.error('[Dev Confirm] Failed to notify participants (non-blocking):', notifyErr);
      }
    }

    res.json({ 
      success: true, 
      bookingId,
      sessionId,
      totalFeeCents,
      message: 'Booking confirmed'
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to confirm booking', error);
  }
});

router.put('/api/booking-requests/:id/complete-cancellation', isStaffOrAdmin, async (req, res) => {
  try {
    const staffEmail = getSessionUser(req)?.email;
    if (!staffEmail) return res.status(401).json({ error: 'Authentication required' });
    
    const bookingId = parseInt(req.params.id as string, 10);
    
    const [existing] = await db.select({
      id: bookingRequests.id,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      endTime: bookingRequests.endTime,
      status: bookingRequests.status,
      resourceId: bookingRequests.resourceId,
      trackmanBookingId: bookingRequests.trackmanBookingId,
      sessionId: bookingRequests.sessionId,
      overagePaymentIntentId: bookingRequests.overagePaymentIntentId,
      overagePaid: bookingRequests.overagePaid,
      overageFeeCents: bookingRequests.overageFeeCents
    })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));
    
    if (!existing) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    if (existing.status !== 'cancellation_pending') {
      return res.status(400).json({ error: `Cannot complete cancellation — booking status is '${existing.status}', expected 'cancellation_pending'` });
    }
    
    // Track errors that occur during financial cleanup
    const errors: string[] = [];
    
    // 1. Handle overage payment refund/cancellation FIRST
    if (existing.overagePaymentIntentId) {
      try {
        const stripe = await getStripeClient();
        if (existing.overagePaid) {
          const paymentIntent = await stripe.paymentIntents.retrieve(existing.overagePaymentIntentId);
          if (paymentIntent.status === 'succeeded' && paymentIntent.latest_charge) {
            await stripe.refunds.create({
              charge: paymentIntent.latest_charge as string,
              reason: 'requested_by_customer'
            });
          }
        } else {
          await cancelPaymentIntent(existing.overagePaymentIntentId);
        }
      } catch (paymentErr: unknown) {
        errors.push(`Overage refund failed: ${getErrorMessage(paymentErr)}`);
        console.error('[Complete Cancellation] Failed to handle overage payment:', paymentErr);
      }
      
      // Always clear overage fields regardless of refund success
      try {
        await db.update(bookingRequests)
          .set({ overagePaymentIntentId: null, overageFeeCents: 0 })
          .where(eq(bookingRequests.id, bookingId));
      } catch (clearErr) {
        console.error('[Complete Cancellation] Failed to clear overage fields:', clearErr);
      }
    }
    
    // 2. Cancel pending payment intents
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
        } catch (cancelErr: unknown) {
          errors.push(`Failed to cancel payment intent ${row.stripe_payment_intent_id.substring(0, 8)}: ${getErrorMessage(cancelErr)}`);
          console.error(`[Complete Cancellation] Failed to cancel payment intent:`, getErrorMessage(cancelErr));
        }
      }
    } catch (err: unknown) {
      errors.push(`Failed to query pending intents: ${getErrorMessage(err)}`);
      console.error('[Complete Cancellation] Failed to query pending intents:', err);
    }
    
    // 3. Clear pending fees and refund paid participant fees
    if (existing.sessionId) {
      try {
        await pool.query(
          `UPDATE booking_participants 
           SET cached_fee_cents = 0, payment_status = 'waived'
           WHERE session_id = $1 AND payment_status = 'pending'`,
          [existing.sessionId]
        );
      } catch (clearErr) {
        errors.push(`Failed to clear pending fees: ${(clearErr as any).message}`);
        console.error('[Complete Cancellation] Failed to clear pending fees:', clearErr);
      }
      
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
          [existing.sessionId]
        );
        
        if (paidParticipants.rows.length > 0) {
          const stripe = await getStripeClient();
          for (const participant of paidParticipants.rows) {
            try {
              const pi = await stripe.paymentIntents.retrieve(participant.stripe_payment_intent_id);
              if (pi.status === 'succeeded' && pi.latest_charge) {
                const refund = await stripe.refunds.create({
                  charge: typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge as any).id,
                  reason: 'requested_by_customer',
                  metadata: {
                    type: 'cancellation_completed_by_staff',
                    bookingId: bookingId.toString(),
                    participantId: participant.id.toString()
                  }
                });
                await pool.query(
                  `UPDATE booking_participants SET refunded_at = NOW(), payment_status = 'waived' WHERE id = $1`,
                  [participant.id]
                );
                console.log(`[Complete Cancellation] Refunded ${participant.display_name}: $${(participant.cached_fee_cents / 100).toFixed(2)}`);
              }
            } catch (refundErr: unknown) {
              errors.push(`Failed to refund ${participant.display_name}: ${getErrorMessage(refundErr)}`);
              console.error(`[Complete Cancellation] Failed to refund participant ${participant.id}:`, getErrorMessage(refundErr));
            }
          }
        }
      } catch (feeErr: unknown) {
        errors.push(`Failed to handle participant refunds: ${getErrorMessage(feeErr)}`);
        console.error('[Complete Cancellation] Failed to handle fees:', feeErr);
      }
      
      // 4. Refund guest passes
      try {
        const guestParticipants = await pool.query(
          `SELECT id, display_name FROM booking_participants 
           WHERE session_id = $1 AND participant_type = 'guest'`,
          [existing.sessionId]
        );
        for (const guest of guestParticipants.rows) {
          try {
            await refundGuestPass(existing.userEmail || '', guest.display_name || undefined, false);
          } catch (guestErr: unknown) {
            errors.push(`Failed to refund guest pass for ${guest.display_name}: ${getErrorMessage(guestErr)}`);
            console.error('[Complete Cancellation] Failed to refund guest pass:', guestErr);
          }
        }
      } catch (err: unknown) {
        errors.push(`Failed to query guest participants: ${getErrorMessage(err)}`);
        console.error('[Complete Cancellation] Failed to query guest participants:', err);
      }
    }
    
    // 5. Release guest pass holds
    try {
      await releaseGuestPassHold(bookingId);
    } catch (err: unknown) {
      errors.push(`Failed to release guest pass holds: ${getErrorMessage(err)}`);
      console.error('[Complete Cancellation] Failed to release guest pass holds:', err);
    }
    
    // 6. NOW mark as cancelled with any error details in staff notes + notify member (in transaction)
    const errorNote = errors.length > 0 
      ? `\n[Cancellation completed with ${errors.length} error(s): ${errors.join('; ')}]`
      : '';
    
    const bookingDate = existing.requestDate;
    const bookingTime = existing.startTime?.substring(0, 5) || '';
    
    await db.transaction(async (tx) => {
      await tx.update(bookingRequests)
        .set({
          status: 'cancelled',
          staffNotes: sql`COALESCE(staff_notes, '') || ${'\n[Cancellation completed manually by ' + staffEmail + ']' + errorNote}`,
          updatedAt: new Date()
        })
        .where(eq(bookingRequests.id, bookingId));
      
      await tx.insert(notifications).values({
        userEmail: existing.userEmail || '',
        title: 'Booking Cancelled',
        message: `Your booking on ${bookingDate} at ${bookingTime} has been cancelled and any charges have been refunded.`,
        type: 'booking_cancelled',
        relatedId: bookingId,
        relatedType: 'booking_request'
      });
    });
    
    // 7. Broadcast availability, audit log (after status update)
    broadcastAvailabilityUpdate({
      resourceId: existing.resourceId || undefined,
      resourceType: 'simulator',
      date: existing.requestDate,
      action: 'cancelled'
    });
    
    const memberName = existing.userName || existing.userEmail || 'Member';
    
    logFromRequest(req, 'complete_cancellation' as any, 'booking', req.params.id as string, staffEmail, {
      member_email: existing.userEmail,
      trackman_booking_id: existing.trackmanBookingId,
      completed_manually: true,
      cleanup_errors: errors.length > 0 ? errors : undefined
    });
    
    bookingEvents.publish('booking_cancelled', {
      bookingId,
      memberEmail: existing.userEmail || '',
      resourceId: existing.resourceId || undefined,
      bookingDate: bookingDate,
      status: 'cancelled',
      actionBy: 'staff'
    } as any);
    
    console.log(`[Complete Cancellation] Staff ${staffEmail} manually completed cancellation of booking ${bookingId}${errors.length > 0 ? ` with ${errors.length} error(s)` : ''}`);
    
    return res.json({ 
      success: true, 
      status: 'cancelled',
      message: 'Cancellation completed successfully. Member has been notified.',
      cleanup_errors: errors.length > 0 ? errors : undefined
    });
  } catch (err: unknown) {
    console.error('[Complete Cancellation] Error:', err);
    return res.status(500).json({ error: 'Failed to complete cancellation' });
  }
});

export default router;
