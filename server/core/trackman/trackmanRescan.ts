import { db } from '../../db';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';
import { users, bookingRequests, trackmanUnmatchedBookings, trackmanImportRuns, bookingSessions, availabilityBlocks } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { getTodayPacific, formatNotificationDateTime } from '../../utils/dateUtils';
import { ensureSessionForBooking } from '../bookingService/sessionManager';
import { recalculateSessionFees } from '../billing/unifiedFeeService';
import { voidBookingInvoice } from '../billing/bookingInvoiceService';
import { useGuestPass } from '../../routes/guestPasses';
import { cancelPendingPaymentIntentsForBooking, refundSucceededPaymentIntentsForBooking } from '../billing/paymentIntentCleanup';
import { alertOnTrackmanImportIssues } from '../dataAlerts';
import { logger } from '../logger';
import { isSyntheticEmail, notifyMember } from '../notificationService';
import { refreshBookingPass, voidBookingPass } from '../../walletPass/bookingPassService';

import type { TrackmanRow, PaidCheckRow } from './constants';
import { isPlaceholderEmail, normalizeStatus, isFutureBooking, isTimeWithinTolerance } from './constants';
import { parseCSVWithMultilineSupport, extractTime, extractDate, parseNotesForPlayers } from './parser';
import { getGolfInstructorEmails, getAllHubSpotMembers, loadEmailMapping, resolveEmail, isConvertedToPrivateEventBlock, isEmailLinkedToUser } from './matching';
import { createTrackmanSessionAndParticipants, transferRequestParticipantsToSession } from './sessionMapper';

export async function rescanUnmatchedBookings(performedBy: string = 'system'): Promise<{
  scanned: number;
  matched: number;
  lessonsConverted: number;
  resolved: { trackmanId: string; memberEmail: string; matchReason: string }[];
  errors: string[];
}> {
  const resolved: { trackmanId: string; memberEmail: string; matchReason: string }[] = [];
  const errors: string[] = [];
  let lessonsConverted = 0;
  
  const unmatchedBookings = await db.select()
    .from(trackmanUnmatchedBookings)
    .where(sql`resolved_at IS NULL`);
  
  if (unmatchedBookings.length === 0) {
    return { scanned: 0, matched: 0, lessonsConverted: 0, resolved: [], errors: [] };
  }
  
  logger.info(`[Trackman Rescan] Starting rescan of ${unmatchedBookings.length} unmatched bookings`);
  
  const instructorEmails = await getGolfInstructorEmails();
  logger.info(`[Trackman Rescan] Loaded ${instructorEmails.length} golf instructor emails for lesson detection`);
  
  const hubSpotMembers = await getAllHubSpotMembers();
  
  if (hubSpotMembers.length === 0) {
    return { 
      scanned: unmatchedBookings.length, 
      matched: 0, 
      lessonsConverted: 0,
      resolved: [], 
      errors: ['HubSpot unavailable - cannot fetch members for matching'] 
    };
  }
  
  const membersByEmail = new Map<string, string>();
  
  for (const member of hubSpotMembers) {
    if (member.email) {
      membersByEmail.set(member.email.toLowerCase(), member.email);
    }
  }
  
  logger.info(`[Trackman Rescan] Loaded ${membersByEmail.size} members for matching`);
  
  const emailMapping = await loadEmailMapping();
  
  const trackmanEmailMapping = new Map<string, string>();
  try {
    const usersWithTrackmanEmail = await db.select({
      email: users.email,
      trackmanEmail: users.trackmanEmail
    })
    .from(users)
    .where(sql`trackman_email IS NOT NULL AND trackman_email != ''`);
    
    for (const user of usersWithTrackmanEmail) {
      if (user.email && user.trackmanEmail) {
        trackmanEmailMapping.set(user.trackmanEmail.toLowerCase().trim(), user.email.toLowerCase());
      }
    }
  } catch (err: unknown) {
    logger.error(`[Trackman Rescan] Error loading trackman_email mappings: ${getErrorMessage(err)}`);
  }
  
  let matchedCount = 0;
  
  for (const booking of unmatchedBookings) {
    try {
      const originalEmail = booking.originalEmail || '';
      const userName = booking.userName || '';
      const notes = booking.notes || '';
      
      const rawEmailLower = originalEmail.toLowerCase().trim();
      const resolvedEmailValue = emailMapping.get(rawEmailLower) || 
                       trackmanEmailMapping.get(rawEmailLower) || 
                       rawEmailLower;
      
      const isInstructorEmail = resolvedEmailValue && (
        instructorEmails.includes(resolvedEmailValue.toLowerCase()) ||
        instructorEmails.includes(rawEmailLower)
      );
      const containsLessonKeyword = userName.toLowerCase().includes('lesson') || notes.toLowerCase().includes('lesson');
      
      if (isInstructorEmail || containsLessonKeyword) {
        const resourceId = parseInt(booking.bayNumber || '', 10) || null;
        const bookingDate = booking.bookingDate ? 
          ((booking.bookingDate as string | Date) instanceof Date ? (booking.bookingDate as unknown as Date).toISOString().split('T')[0] : booking.bookingDate) : null;
        const startTime = booking.startTime?.toString() || null;
        const endTime = booking.endTime?.toString() || startTime;
        
        if (resourceId && resourceId > 0 && bookingDate && startTime) {
          const existingBlock = await db.execute(sql`
            SELECT ab.id FROM availability_blocks ab
            WHERE ab.resource_id = ${resourceId}
              AND ab.block_date = ${bookingDate}
              AND ab.start_time < ${endTime}::time
              AND ab.end_time > ${startTime}::time
            LIMIT 1
          `);
          
          if (existingBlock.rows.length === 0) {
            await db.execute(sql`
              INSERT INTO availability_blocks 
                (resource_id, block_date, start_time, end_time, block_type, notes, created_by)
              VALUES (${resourceId}, ${bookingDate}, ${startTime}, ${endTime}, 'blocked', ${`Lesson - ${userName || 'Unknown'}`}, ${performedBy})
              ON CONFLICT DO NOTHING
            `);
            
            logger.info(`[Trackman Rescan] Created availability block for lesson: ${userName} on ${bookingDate} ${startTime}-${endTime}`);
          } else {
            logger.info(`[Trackman Rescan] Block already exists for lesson: ${userName} on ${bookingDate} ${startTime}-${endTime}`);
          }
          
          await db.update(trackmanUnmatchedBookings)
            .set({
              resolvedAt: new Date(),
              resolvedBy: performedBy,
              matchAttemptReason: 'Converted to Availability Block (Lesson)'
            })
            .where(eq(trackmanUnmatchedBookings.id, booking.id));
          
          lessonsConverted++;
          logger.info(`[Trackman Rescan] Converted lesson booking: ${userName} (${originalEmail || 'no email'}) -> Availability Block`);
        } else {
          logger.info(`[Trackman Rescan] Skipping lesson ${booking.trackmanBookingId}: missing resource/date/time (bay=${resourceId}, date=${bookingDate}, time=${startTime})`);
        }
        
        continue;
      }
      
      let matchedEmail: string | null = null;
      let matchReason = '';
      
      if (originalEmail) {
        const mappedEmail = emailMapping.get(originalEmail.toLowerCase().trim());
        if (mappedEmail) {
          const existingMember = membersByEmail.get(mappedEmail.toLowerCase());
          if (existingMember) {
            matchedEmail = existingMember;
            matchReason = 'Matched via email mapping';
          }
        }
      }
      
      if (!matchedEmail && originalEmail && originalEmail.includes('@')) {
        const existingMember = membersByEmail.get(originalEmail.toLowerCase());
        if (existingMember) {
          matchedEmail = existingMember;
          matchReason = 'Matched by email';
        }
      }
      
      if (!matchedEmail && originalEmail && originalEmail.includes('@')) {
        const trackmanMatch = trackmanEmailMapping.get(originalEmail.toLowerCase().trim());
        if (trackmanMatch) {
          const existingMember = membersByEmail.get(trackmanMatch.toLowerCase());
          if (existingMember) {
            matchedEmail = existingMember;
            matchReason = 'Matched by trackman_email';
          }
        }
      }

      if (matchedEmail) {
        let matchedUserId: string | null = null;
        const uidResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${matchedEmail}) AND archived_at IS NULL LIMIT 1`);
        if (uidResult.rows.length > 0) {
          matchedUserId = (uidResult.rows[0] as { id: string }).id;
        }

        await db.update(trackmanUnmatchedBookings)
          .set({
            resolvedEmail: matchedEmail,
            resolvedAt: new Date(),
            resolvedBy: performedBy,
            matchAttemptReason: matchReason
          })
          .where(eq(trackmanUnmatchedBookings.id, booking.id));
        
        resolved.push({
          trackmanId: booking.trackmanBookingId || '',
          memberEmail: matchedEmail,
          matchReason
        });
        
        matchedCount++;
        logger.info(`[Trackman Rescan] Resolved: ${booking.userName} (${originalEmail}) -> ${matchedEmail} (${matchReason})`);
        
        try {
          const bookingDate = booking.bookingDate ? new Date(booking.bookingDate).toISOString().split('T')[0] : '';
          const startTime = booking.startTime?.toString() || '';
          const endTime = booking.endTime?.toString() || '';
          const bayId = parseInt(booking.bayNumber || '', 10) || null;
          
          if (bookingDate && startTime) {
            const existingBooking = await db.select({ id: bookingRequests.id })
              .from(bookingRequests)
              .where(sql`trackman_booking_id = ${booking.trackmanBookingId}`)
              .limit(1);
            
            if (existingBooking.length === 0) {
              try {
                await db.execute(sql`INSERT INTO booking_requests (
                    user_id, user_email, user_name, request_date, start_time, end_time,
                    duration_minutes, resource_id, status, trackman_booking_id,
                    notes, trackman_player_count, created_at, updated_at
                  ) VALUES (${matchedUserId}, ${matchedEmail}, ${booking.userName || ''}, ${bookingDate}, ${startTime}, ${endTime}, ${booking.durationMinutes || 60}, ${bayId}, 'approved', ${booking.trackmanBookingId}, ${`[Trackman Import ID:${booking.trackmanBookingId}] ${booking.notes || ''}`.trim()}, ${booking.playerCount || 1}, NOW(), NOW())
                  ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO NOTHING`);
                logger.info(`[Trackman Rescan] Created booking for ${matchedEmail} (Trackman ID: ${booking.trackmanBookingId})`);
              } catch (insertErr: unknown) {
                const errCode = getErrorCode(insertErr);
                const errMessage = getErrorMessage(insertErr) || '';
                const causeCode = (insertErr as { cause?: { code?: string } })?.cause?.code;
                if (errMessage.includes('duplicate key') || errCode === '23505' || causeCode === '23505') {
                  logger.info(`[Trackman Rescan] Booking ${booking.trackmanBookingId} already exists - skipping`);
                } else if (errCode === '23P01' || causeCode === '23P01' || errMessage.includes('booking_requests_no_overlap') || errMessage.includes('23P01')) {
                  await db.transaction(async (tx) => {
                    const conflicting = await tx.execute(sql`
                      SELECT id FROM booking_requests
                      WHERE resource_id = ${bayId}
                        AND request_date = ${bookingDate}
                        AND status IN ('pending', 'approved', 'confirmed')
                        AND start_time < ${endTime}
                        AND end_time > ${startTime}
                        AND (trackman_booking_id IS NULL OR trackman_booking_id != ${booking.trackmanBookingId})
                      FOR UPDATE`);
                    const conflictIds = (conflicting.rows as { id: number }[]).map(r => r.id);
                    if (conflictIds.length > 0) {
                      await tx.execute(sql`
                        UPDATE booking_requests SET status = 'cancelled', updated_at = NOW(),
                          staff_notes = COALESCE(staff_notes, '') || ${`\n[Auto-cancelled: superseded by Trackman rescan import ${booking.trackmanBookingId}]`}
                        WHERE id = ANY(${sql.raw(`ARRAY[${conflictIds.join(',')}]::int[]`)})`);
                    }
                    await tx.execute(sql`INSERT INTO booking_requests (
                        user_id, user_email, user_name, request_date, start_time, end_time,
                        duration_minutes, resource_id, status, trackman_booking_id,
                        notes, trackman_player_count, created_at, updated_at
                      ) VALUES (${matchedUserId}, ${matchedEmail}, ${booking.userName || ''}, ${bookingDate}, ${startTime}, ${endTime}, ${booking.durationMinutes || 60}, ${bayId}, 'approved', ${booking.trackmanBookingId}, ${`[Trackman Import ID:${booking.trackmanBookingId}] ${booking.notes || ''}`.trim()}, ${booking.playerCount || 1}, NOW(), NOW())
                      ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO NOTHING`);
                  });
                  logger.info(`[Trackman Rescan] Created booking for ${matchedEmail} after clearing overlap (Trackman ID: ${booking.trackmanBookingId})`);
                } else {
                  throw insertErr;
                }
              }
            }
          }
        } catch (bookingError: unknown) {
          logger.error(`[Trackman Rescan] Error creating booking: ${getErrorMessage(bookingError)}`);
        }
      }
    } catch (err: unknown) {
      errors.push(`Error processing booking ${booking.trackmanBookingId}: ${(err instanceof Error && err.cause instanceof Error ? err.cause.message : null) || getErrorMessage(err)}`);
    }
  }
  
  logger.info(`[Trackman Rescan] Completed: scanned ${unmatchedBookings.length}, matched ${matchedCount}, lessons converted ${lessonsConverted}`);
  
  return {
    scanned: unmatchedBookings.length,
    matched: matchedCount,
    lessonsConverted,
    resolved,
    errors
  };
}

