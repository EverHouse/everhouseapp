import { db } from '../../db';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';
import { users, bookingRequests, trackmanUnmatchedBookings, trackmanImportRuns, notifications, bookingSessions, availabilityBlocks } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { getTodayPacific, formatNotificationDateTime } from '../../utils/dateUtils';
import { sendPushNotification } from '../../routes/push';
import { ensureSessionForBooking } from '../bookingService/sessionManager';
import { recalculateSessionFees } from '../billing/unifiedFeeService';
import { voidBookingInvoice } from '../billing/bookingInvoiceService';
import { useGuestPass } from '../../routes/guestPasses';
import { cancelPendingPaymentIntentsForBooking, refundSucceededPaymentIntentsForBooking } from '../billing/paymentIntentCleanup';
import { alertOnTrackmanImportIssues } from '../dataAlerts';
import { logger } from '../logger';
import { isSyntheticEmail } from '../notificationService';
import { refreshBookingPass, voidBookingPass } from '../../walletPass/bookingPassService';

import type { TrackmanRow, PaidCheckRow } from './constants';
import { isPlaceholderEmail, normalizeStatus, isFutureBooking, isTimeWithinTolerance } from './constants';
import { parseCSVWithMultilineSupport, extractTime, extractDate, parseNotesForPlayers } from './parser';
import { getGolfInstructorEmails, getAllHubSpotMembers, loadEmailMapping, resolveEmail, isConvertedToPrivateEventBlock, isEmailLinkedToUser } from './matching';
import { createTrackmanSessionAndParticipants, transferRequestParticipantsToSession } from './sessionMapper';

export async function importTrackmanBookings(csvPath: string, importedBy?: string): Promise<{
  totalRows: number;
  matchedRows: number;
  linkedRows: number;
  unmatchedRows: number;
  skippedRows: number;
  skippedAsPrivateEventBlocks: number;
  removedFromUnmatched: number;
  cancelledBookings: number;
  updatedRows: number;
  errors: string[];
}> {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const parsedRows = parseCSVWithMultilineSupport(content);
  
  if (parsedRows.length < 2) {
    return { totalRows: 0, matchedRows: 0, linkedRows: 0, unmatchedRows: 0, skippedRows: 0, skippedAsPrivateEventBlocks: 0, removedFromUnmatched: 0, cancelledBookings: 0, updatedRows: 0, errors: ['Empty or invalid CSV'] };
  }

  const hubSpotMembers = await getAllHubSpotMembers();
  
  const membersByEmail = new Map<string, string>();
  
  if (hubSpotMembers.length === 0) {
    process.stderr.write(`[Trackman Import] ERROR: Cannot fetch members from HubSpot. Import aborted.\n`);
    return { 
      totalRows: parsedRows.length - 1, 
      matchedRows: 0, 
      linkedRows: 0,
      unmatchedRows: 0, 
      skippedRows: 0, 
      skippedAsPrivateEventBlocks: 0,
      removedFromUnmatched: 0,
      cancelledBookings: 0,
      updatedRows: 0,
      errors: ['HubSpot unavailable - cannot verify members. Please try again later or contact support.'] 
    };
  }
  
  for (const member of hubSpotMembers) {
    if (member.email) {
      membersByEmail.set(member.email.toLowerCase(), member.email);
    }
  }
  
  process.stderr.write(`[Trackman Import] Using ${membersByEmail.size} HubSpot members for matching (includes former members)\n`);

  try {
    const localUsers = await db.select({
      email: users.email,
    }).from(users).where(sql`email IS NOT NULL AND email != '' AND COALESCE(membership_status, '') != 'merged'`);
    
    let addedFromDb = 0;
    for (const user of localUsers) {
      if (user.email) {
        const lowerEmail = user.email.toLowerCase();
        if (!membersByEmail.has(lowerEmail)) {
          membersByEmail.set(lowerEmail, user.email);
          addedFromDb++;
        }
      }
    }
    process.stderr.write(`[Trackman Import] Added ${addedFromDb} additional users from local database to membersByEmail (total: ${membersByEmail.size})\n`);
  } catch (err: unknown) {
    process.stderr.write(`[Trackman Import] Error loading local users: ${getErrorMessage(err)}\n`);
  }

  const emailMapping = await loadEmailMapping();
  process.stderr.write(`[Trackman Import] Email mapping loaded with ${emailMapping.size} entries, membersByEmail has ${membersByEmail.size} entries\n`);

  const trackmanEmailMapping = new Map<string, string>();
  try {
    const usersWithTrackmanEmail = await db.select({
      email: users.email,
      trackmanEmail: users.trackmanEmail
    })
    .from(users)
    .where(sql`trackman_email IS NOT NULL AND trackman_email != '' AND COALESCE(membership_status, '') != 'merged'`);
    
    for (const user of usersWithTrackmanEmail) {
      if (user.email && user.trackmanEmail) {
        trackmanEmailMapping.set(user.trackmanEmail.toLowerCase().trim(), user.email.toLowerCase());
      }
    }
    process.stderr.write(`[Trackman Import] Loaded ${trackmanEmailMapping.size} trackman_email mappings from users table\n`);
  } catch (err: unknown) {
    process.stderr.write(`[Trackman Import] Error loading trackman_email mappings: ${getErrorMessage(err)}\n`);
  }

  const INSTRUCTOR_EMAILS = await getGolfInstructorEmails();
  process.stderr.write(`[Trackman Import] Loaded ${INSTRUCTOR_EMAILS.length} golf instructor emails: ${INSTRUCTOR_EMAILS.join(', ') || '(none)'}\n`);

  let matchedRows = 0;
  let unmatchedRows = 0;
  let skippedRows = 0;
  let linkedRows = 0;
  let removedFromUnmatched = 0;
  let cancelledBookings = 0;
  let updatedRows = 0;
  let skippedAsPrivateEventBlocks = 0;
  const errors: string[] = [];
  let mappingMatchCount = 0;
  let mappingFoundButNotInDb = 0;

  const importBookingIds = new Set<string>();
  for (let i = 1; i < parsedRows.length; i++) {
    const fields = parsedRows[i];
    if (fields.length >= 12) {
      const bookingId = fields[0];
      const status = fields[11];
      if (bookingId && status.toLowerCase() !== 'cancelled') {
        importBookingIds.add(bookingId);
      }
    }
  }
  process.stderr.write(`[Trackman Import] Found ${importBookingIds.size} valid booking IDs in import file\n`);

  let csvDateRange: { min: string; max: string } | null = null;
  const csvDates = new Set<string>();
  for (let i = 1; i < parsedRows.length; i++) {
    const fields = parsedRows[i];
    if (fields.length >= 9) {
      const startDate = fields[8];
      if (startDate) {
        const date = extractDate(startDate);
        if (date) {
          csvDates.add(date);
        }
      }
    }
  }
  
  if (csvDates.size > 0) {
    const sortedDates = Array.from(csvDates).sort();
    csvDateRange = {
      min: sortedDates[0],
      max: sortedDates[sortedDates.length - 1]
    };
    process.stderr.write(`[Trackman Import] CSV date range: ${csvDateRange.min} to ${csvDateRange.max}\n`);
  }

  for (let i = 1; i < parsedRows.length; i++) {
    try {
      const fields = parsedRows[i];
      if (fields.length < 12) {
        skippedRows++;
        continue;
      }

      const row: TrackmanRow = {
        bookingId: fields[0],
        userName: fields[5],
        userEmail: fields[6],
        bookedDate: fields[7],
        startDate: fields[8],
        endDate: fields[9],
        durationMins: parseInt(fields[10]) || 60,
        status: fields[11],
        bayNumber: fields[20] || '',
        playerCount: parseInt(fields[14]) || 1,
        notes: fields[16] || ''
      };

      const notesLower = (row.notes || '').toLowerCase();
      const userNameLower = (row.userName || '').toLowerCase();
      const userEmailLower = (row.userEmail || '').toLowerCase().trim();
      
      const resolvedEmailForLesson = emailMapping.get(userEmailLower) || 
                       trackmanEmailMapping.get(userEmailLower) || 
                       userEmailLower;
      
      const isStaffLesson = 
        INSTRUCTOR_EMAILS.includes(resolvedEmailForLesson.toLowerCase()) ||
        INSTRUCTOR_EMAILS.includes(userEmailLower) ||
        notesLower.includes('lesson') ||
        notesLower.includes('private instruction') ||
        userNameLower.includes('lesson');
      
      if (isStaffLesson && row.status.toLowerCase() !== 'cancelled' && row.status.toLowerCase() !== 'canceled') {
        const bookingDate = extractDate(row.startDate);
        const startTime = extractTime(row.startDate);
        const endTime = extractTime(row.endDate);
        const resourceId = parseInt(row.bayNumber) || null;
        
        if (resourceId && bookingDate && startTime) {
          const existingBlock = await isConvertedToPrivateEventBlock(
            resourceId,
            bookingDate,
            startTime,
            endTime
          );
          
          if (!existingBlock) {
            try {
              await db.insert(availabilityBlocks).values({
                resourceId,
                blockDate: bookingDate,
                startTime: startTime,
                endTime: endTime || startTime,
                blockType: 'blocked',
                notes: `Lesson - ${row.userName}`,
                createdBy: 'trackman_import'
              }).onConflictDoNothing();
              
              process.stderr.write(`[Trackman Import] Converted staff lesson to block: ${row.userEmail} -> "${row.userName}" on ${bookingDate}\n`);
            } catch (blockErr: unknown) {
              process.stderr.write(`[Trackman Import] Error creating lesson block for ${row.bookingId}: ${getErrorMessage(blockErr)}\n`);
            }
          }
          
          skippedAsPrivateEventBlocks++;
          continue;
        }
      }

      if (row.status.toLowerCase() === 'cancelled' || row.status.toLowerCase() === 'canceled') {
        const existingBookingToCancel = await db.select({ 
          id: bookingRequests.id,
          status: bookingRequests.status,
          sessionId: bookingRequests.sessionId,
          createdAt: bookingRequests.createdAt
        })
          .from(bookingRequests)
          .where(sql`trackman_booking_id = ${row.bookingId} OR notes LIKE ${'%[Trackman Import ID:' + row.bookingId + ']%'}`)
          .limit(1);
        
        if (existingBookingToCancel.length > 0) {
          const booking = existingBookingToCancel[0];
          
          let bookingDate: string | null = null;
          if (booking.sessionId) {
            try {
              const sessionResult = await db.select({ 
                sessionDate: bookingSessions.sessionDate
              })
                .from(bookingSessions)
                .where(eq(bookingSessions.id, booking.sessionId))
                .limit(1);
              
              if (sessionResult.length > 0) {
                bookingDate = sessionResult[0].sessionDate;
              }
            } catch (dateErr: unknown) {
              process.stderr.write(`[Trackman Import] Warning: Failed to fetch session date for booking #${booking.id}: ${getErrorMessage(dateErr)}\n`);
            }
          }
          
          if (!bookingDate && booking.createdAt) {
            const date = booking.createdAt instanceof Date ? booking.createdAt : new Date(booking.createdAt);
            bookingDate = date.toISOString().split('T')[0];
          }
          
          if (csvDateRange && bookingDate && (bookingDate < csvDateRange.min || bookingDate > csvDateRange.max)) {
            process.stderr.write(`[Trackman Import] Skipping out-of-range cancellation: Booking #${booking.id} (Trackman ID: ${row.bookingId}, date: ${bookingDate}) is outside CSV range [${csvDateRange.min} to ${csvDateRange.max}]\n`);
            skippedRows++;
            continue;
          }
          
          if (booking.status !== 'cancelled') {
            await cancelPendingPaymentIntentsForBooking(booking.id);
            
            try {
              await refundSucceededPaymentIntentsForBooking(booking.id);
            } catch (refundErr: unknown) {
              logger.error('[Trackman Import] Failed to refund succeeded PIs for booking', { extra: { bookingId: booking.id, error: getErrorMessage(refundErr) } });
            }

            try {
              await voidBookingInvoice(booking.id);
            } catch (voidErr: unknown) {
              logger.error('[Trackman Import] Failed to void invoice for booking', { extra: { bookingId: booking.id, error: getErrorMessage(voidErr) } });
            }

            voidBookingPass(booking.id).catch(err => logger.error('[Trackman Import] Failed to void booking wallet pass', { extra: { bookingId: booking.id, error: getErrorMessage(err) } }));

            await db.update(bookingRequests)
              .set({ 
                status: 'cancelled',
                updatedAt: new Date()
              })
              .where(eq(bookingRequests.id, booking.id));
            
            logger.info('[Trackman Import] Cancelled booking', { extra: { bookingId: booking.id, trackmanId: row.bookingId, date: bookingDate, previousStatus: booking.status } });
            cancelledBookings++;
          } else {
            skippedRows++;
          }
        } else {
          skippedRows++;
        }
        continue;
      }

      let matchedEmail: string | null = null;
      let matchReason = '';

      const mappedEmail = emailMapping.get(row.userEmail.toLowerCase().trim());
      if (mappedEmail) {
        const existingMember = membersByEmail.get(mappedEmail.toLowerCase());
        if (existingMember) {
          matchedEmail = existingMember;
          matchReason = 'Matched via email mapping';
          mappingMatchCount++;
          if (mappingMatchCount <= 3) {
            process.stderr.write(`[Trackman Import] Match: ${row.userEmail} -> ${mappedEmail} -> ${existingMember}\n`);
          }
        } else {
          mappingFoundButNotInDb++;
          if (mappingFoundButNotInDb <= 3) {
            process.stderr.write(`[Trackman Import] Mapped ${row.userEmail} -> ${mappedEmail} but NOT in membersByEmail\n`);
          }
        }
      }

      if (!matchedEmail && row.userEmail.includes('@')) {
        const existingMember = membersByEmail.get(row.userEmail.toLowerCase());
        if (existingMember) {
          matchedEmail = existingMember;
          matchReason = 'Matched by email';
        }
      }

      if (!matchedEmail && row.userEmail.includes('@')) {
        const trackmanEmailMatch = trackmanEmailMapping.get(row.userEmail.toLowerCase().trim());
        if (trackmanEmailMatch) {
          const existingMember = membersByEmail.get(trackmanEmailMatch.toLowerCase());
          if (existingMember) {
            matchedEmail = existingMember;
            matchReason = 'Matched by trackman_email';
            process.stderr.write(`[Trackman Import] Trackman email match: ${row.userEmail} -> ${existingMember}\n`);
          }
        }
      }

      const parsedPlayers = parseNotesForPlayers(row.notes);
      const memberEmailsFromNotes: string[] = [];
      const requiresReview: { name: string; reason: string }[] = [];
      
      for (const player of parsedPlayers) {
        if (player.type === 'member' && player.email) {
          const noteEmail = player.email.toLowerCase().trim();
          
          const trackmanMatch = trackmanEmailMapping.get(noteEmail);
          if (trackmanMatch) {
            memberEmailsFromNotes.push(trackmanMatch);
          } else if (membersByEmail.has(noteEmail)) {
            memberEmailsFromNotes.push(noteEmail);
          } else {
            requiresReview.push({ 
              name: player.name || noteEmail, 
              reason: `Email ${noteEmail} not found in member database` 
            });
          }
        } else if (player.type === 'member' && !player.email && player.name) {
          requiresReview.push({ 
            name: player.name, 
            reason: 'Partial name without email - requires manual matching' 
          });
        }
      }

      if (!matchedEmail && memberEmailsFromNotes.length > 0) {
        const noteEmail = memberEmailsFromNotes[0].toLowerCase();
        const existingMember = membersByEmail.get(noteEmail);
        if (existingMember) {
          matchedEmail = existingMember;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          matchReason = 'Matched via M: tag in notes';
          process.stderr.write(`[Trackman Import] Notes fallback match: ${noteEmail} -> ${existingMember} for "${row.userName}"\n`);
        }
      }

      const bookingDate = extractDate(row.startDate);
      const startTime = extractTime(row.startDate);
      const endTime = extractTime(row.endDate);
      const normalizedStatus = normalizeStatus(row.status, bookingDate, startTime);
      const isUpcoming = isFutureBooking(bookingDate, startTime);

      if (!normalizedStatus) {
        skippedRows++;
        errors.push(`Row ${i}: Unknown status "${row.status}"`);
        continue;
      }

      const existingUnmatched = await db.select({ 
        id: trackmanUnmatchedBookings.id,
        resolvedAt: trackmanUnmatchedBookings.resolvedAt
      })
        .from(trackmanUnmatchedBookings)
        .where(eq(trackmanUnmatchedBookings.trackmanBookingId, row.bookingId))
        .limit(1);
      
      const hasLegacyEntry = existingUnmatched.length > 0;
      const legacyIsUnresolved = hasLegacyEntry && !existingUnmatched[0].resolvedAt;

      const parsedBayId = parseInt(row.bayNumber) || null;

      const existingBooking = await db.select({ 
        id: bookingRequests.id,
        resourceId: bookingRequests.resourceId,
        startTime: bookingRequests.startTime,
        endTime: bookingRequests.endTime,
        durationMinutes: bookingRequests.durationMinutes,
        notes: bookingRequests.notes,
        trackmanPlayerCount: bookingRequests.trackmanPlayerCount,
        declaredPlayerCount: bookingRequests.declaredPlayerCount,
        guestCount: bookingRequests.guestCount,
        trackmanCustomerNotes: bookingRequests.trackmanCustomerNotes,
        staffNotes: bookingRequests.staffNotes,
        sessionId: bookingRequests.sessionId,
        userEmail: bookingRequests.userEmail,
        userName: bookingRequests.userName,
        origin: bookingRequests.origin,
        isUnmatched: bookingRequests.isUnmatched,
        status: bookingRequests.status
      })
        .from(bookingRequests)
        .where(eq(bookingRequests.trackmanBookingId, row.bookingId))
        .limit(1);
      
      let freedCancelledBooking = false;
      if (existingBooking.length > 0) {
        const existing = existingBooking[0];
        
        if (existing.userEmail === 'private-event@resolved' || existing.userEmail === 'private-event@club') {
          process.stderr.write(`[Trackman Import] Skipping booking ${row.bookingId} - already converted to private event\n`);
          skippedAsPrivateEventBlocks++;
          continue;
        }
        
        const isCancelledInApp = existing.status === 'cancelled';
        const isPendingCancel = existing.status === 'cancellation_pending';
        
        if (isPendingCancel && row.status.toLowerCase() !== 'cancelled' && row.status.toLowerCase() !== 'canceled') {
          process.stderr.write(`[Trackman Import] SKIPPED: Booking #${existing.id} (Trackman ID: ${row.bookingId}) is cancellation_pending — waiting for staff to cancel in Trackman\n`);
          continue;
        }
        
        if (isCancelledInApp && row.status.toLowerCase() !== 'cancelled' && row.status.toLowerCase() !== 'canceled') {
          let hasPaidFees = false;
          if (existing.sessionId) {
            try {
              const paidCheck = await db.execute(sql`SELECT EXISTS(
                  SELECT 1 FROM booking_fee_snapshots WHERE session_id = ${existing.sessionId} AND status IN ('completed', 'paid')
                ) AS has_paid,
                EXISTS(
                  SELECT 1 FROM booking_participants WHERE session_id = ${existing.sessionId} AND payment_status = 'paid'
                ) AS has_paid_participants`);
              hasPaidFees = Boolean((paidCheck.rows[0] as unknown as PaidCheckRow)?.has_paid) || Boolean((paidCheck.rows[0] as unknown as PaidCheckRow)?.has_paid_participants);
            } catch (err) { logger.debug('Failed to parse fee, assuming paid', { error: err }); hasPaidFees = true; }
          }
          if (hasPaidFees) {
            process.stderr.write(`[Trackman Import] SKIPPED free: Cancelled booking #${existing.id} (Trackman ID: ${row.bookingId}) has completed payments — not safe to create duplicate\n`);
          } else {
            await db.update(bookingRequests)
              .set({ trackmanBookingId: null })
              .where(eq(bookingRequests.id, existing.id));
            if (existing.sessionId) {
              await db.execute(sql`UPDATE booking_sessions SET trackman_booking_id = NULL WHERE id = ${existing.sessionId}`);
            }
            process.stderr.write(`[Trackman Import] FREED: Cleared trackman_booking_id from cancelled booking #${existing.id} (Trackman ID: ${row.bookingId}) — will create fresh booking with correct owner\n`);
            freedCancelledBooking = true;
          }
        }
        
        if (!freedCancelledBooking) {
        
        const isFinalized = ['attended', 'no_show'].includes(existing.status || '');
        let hasCompletedPayments = false;
        if (existing.sessionId) {
          try {
            const paymentCheck = await db.execute(sql`SELECT EXISTS(
                SELECT 1 FROM booking_fee_snapshots 
                WHERE session_id = ${existing.sessionId} AND status IN ('completed', 'paid')
              ) AS has_snapshot,
              EXISTS(
                SELECT 1 FROM booking_participants 
                WHERE session_id = ${existing.sessionId} AND payment_status = 'paid'
              ) AS has_paid_participants`);
            hasCompletedPayments = Boolean((paymentCheck.rows[0] as unknown as PaidCheckRow)?.has_snapshot) || Boolean((paymentCheck.rows[0] as unknown as PaidCheckRow)?.has_paid_participants);
          } catch (checkErr: unknown) {
            hasCompletedPayments = true;
            process.stderr.write(`[Trackman Import] FAIL-CLOSED: Could not check payment status for booking #${existing.id}, treating as frozen: ${getErrorMessage(checkErr)}\n`);
          }
        }
        const financiallyFrozen = isFinalized || hasCompletedPayments;
        
        const isWebhookCreated = existing.origin === 'trackman_webhook';
        
        const updateFields: Record<string, unknown> = {};
        let changes: string[] = [];
        
        if (parsedBayId && existing.resourceId !== parsedBayId) {
          updateFields.resourceId = parsedBayId;
          changes.push(`bay: ${existing.resourceId} -> ${parsedBayId}`);
        }
        
        if (existing.startTime !== startTime) {
          updateFields.startTime = startTime;
          changes.push(`start: ${existing.startTime} -> ${startTime}`);
        }
        
        if (existing.endTime !== endTime) {
          updateFields.endTime = endTime;
          changes.push(`end: ${existing.endTime} -> ${endTime}`);
        }
        
        if (existing.durationMinutes !== row.durationMins) {
          updateFields.durationMinutes = row.durationMins;
          changes.push(`duration: ${existing.durationMinutes} -> ${row.durationMins}`);
        }
        
        const trackmanIdPrefix = `[Trackman Import ID:${row.bookingId}]`;
        if (existing.notes && !existing.notes.includes(trackmanIdPrefix)) {
          updateFields.notes = `${trackmanIdPrefix} ${existing.notes}`;
          changes.push('notes: added Trackman ID prefix');
        } else if (!existing.notes && row.notes) {
          updateFields.notes = `${trackmanIdPrefix} ${row.notes}`;
          changes.push('notes: added from Trackman');
        }
        
        if (row.playerCount >= 1) {
          if (existing.trackmanPlayerCount !== row.playerCount) {
            updateFields.trackmanPlayerCount = row.playerCount;
            changes.push(`trackmanPlayerCount: ${existing.trackmanPlayerCount ?? 0} -> ${row.playerCount}`);
          }
          
          const requestDeclaredCount = existing.declaredPlayerCount;
          if (requestDeclaredCount === null || requestDeclaredCount === undefined || requestDeclaredCount === 0) {
            updateFields.declaredPlayerCount = row.playerCount;
            changes.push(`declaredPlayerCount (backfill): 0 -> ${row.playerCount}`);
          } else if (row.playerCount > requestDeclaredCount) {
            updateFields.playerCountMismatch = true;
            const warningNote = `[Warning: Trackman reports ${row.playerCount} players but app request only declared ${requestDeclaredCount}]`;
            const existingStaffNotes = existing.staffNotes || '';
            if (!existingStaffNotes.includes('[Warning: Trackman reports')) {
              updateFields.staffNotes = existingStaffNotes ? `${warningNote} ${existingStaffNotes}` : warningNote;
              changes.push(`mismatch: Trackman ${row.playerCount} > request ${requestDeclaredCount}`);
            }
            process.stderr.write(`[Trackman Import] MISMATCH: Booking #${existing.id} - Trackman reports ${row.playerCount} players but app request declared ${requestDeclaredCount}\n`);
          }
        }
        
        if (!existing.trackmanCustomerNotes && row.notes) {
          updateFields.trackmanCustomerNotes = row.notes;
          changes.push('trackmanNotes: added from import');
        }
        
        if (existing.isUnmatched && matchedEmail) {
          updateFields.userEmail = matchedEmail;
          updateFields.isUnmatched = false;
          changes.push(`member: linked ${matchedEmail}`);

          const unmatchedUserIdResult = await db.execute(sql`SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${matchedEmail}) LIMIT 1`);
          const unmatchedResolvedUser = (unmatchedUserIdResult.rows as Array<{ id: string; first_name: string | null; last_name: string | null }>)[0];
          const unmatchedResolvedUserId = unmatchedResolvedUser?.id;
          const resolvedMemberName = unmatchedResolvedUser
            ? [unmatchedResolvedUser.first_name, unmatchedResolvedUser.last_name].filter(Boolean).join(' ')
            : null;
          updateFields.userName = resolvedMemberName || row.userName;
          if (unmatchedResolvedUserId) {
            updateFields.userId = unmatchedResolvedUserId;
          }

          if (existing.sessionId) {
            try {
              const ownerResult = await db.execute(sql`
                SELECT bp.id, bp.user_id, u.email AS current_email
                FROM booking_participants bp
                LEFT JOIN users u ON bp.user_id = u.id
                WHERE bp.session_id = ${existing.sessionId} AND bp.participant_type = 'owner'
                LIMIT 1
              `);
              const currentOwner = (ownerResult.rows as Array<{ id: number; user_id: string | null; current_email: string | null }>)[0];
              const currentOwnerEmail = currentOwner?.current_email?.toLowerCase();
              if (currentOwner && currentOwnerEmail !== matchedEmail.toLowerCase()) {
                const newDisplayName = resolvedMemberName || row.userName || matchedEmail;
                await db.execute(sql`
                  UPDATE booking_participants
                  SET user_id = ${unmatchedResolvedUserId || null},
                      display_name = ${newDisplayName},
                      payment_status = 'waived'
                  WHERE id = ${currentOwner.id}
                `);
                process.stderr.write(`[Trackman Import] Updated session owner for unmatched→matched booking #${existing.id}: ${currentOwnerEmail || '(unknown)'} → ${matchedEmail}\n`);
              }
            } catch (ownerUpdateErr: unknown) {
              process.stderr.write(`[Trackman Import] Non-blocking: Failed to update session owner for booking #${existing.id}: ${getErrorMessage(ownerUpdateErr)}\n`);
            }
          }
          
          if (existing.status === 'pending' && normalizedStatus === 'approved') {
            updateFields.status = 'approved';
            changes.push('status: pending -> approved (member linked, confirmed on Trackman)');
          }
          
          const originalEmail = row.userEmail?.toLowerCase().trim();
          if (originalEmail && 
              originalEmail.includes('@') && 
              originalEmail !== matchedEmail.toLowerCase() &&
              !isPlaceholderEmail(originalEmail)) {
            try {
              const existingLink = await db.execute(sql`SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = ${originalEmail}`);
              
              if (existingLink.rows.length === 0) {
                await db.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_by)
                   VALUES (${matchedEmail.toLowerCase()}, ${originalEmail}, 'trackman_import_auto', 'system')`);
                process.stderr.write(`[Email Learning] Auto-linked ${originalEmail} -> ${matchedEmail} from import\n`);
              }
            } catch (linkErr: unknown) {
              if (!getErrorMessage(linkErr)?.includes('duplicate key')) {
                process.stderr.write(`[Email Learning] Error: ${getErrorMessage(linkErr)}\n`);
              }
            }
          }
        } else if (existing.isUnmatched && !matchedEmail) {
          if (row.userName && row.userName !== 'Unknown' && !existing.userName?.includes(row.userName)) {
            updateFields.userName = row.userName;
            changes.push(`name: "${existing.userName}" -> "${row.userName}" (still unmatched)`);
          }
          const csvEmail = row.userEmail?.toLowerCase().trim();
          if (csvEmail && csvEmail.includes('@')) {
            const noteText = `Original name: ${row.userName}, Original email: ${csvEmail}`;
            if (!existing.trackmanCustomerNotes || !existing.trackmanCustomerNotes.includes(csvEmail)) {
              updateFields.trackmanCustomerNotes = noteText;
              changes.push(`notes: stored CSV email ${csvEmail} for manual resolution`);
            }
          }
        }
        
        if (financiallyFrozen) {
          const frozenFields = ['resourceId', 'startTime', 'endTime', 'durationMinutes'];
          const strippedChanges: string[] = [];
          for (const field of frozenFields) {
            if (field in updateFields) {
              delete updateFields[field];
              strippedChanges.push(field);
            }
          }
          changes = changes.filter(c => !c.startsWith('bay:') && !c.startsWith('start:') && !c.startsWith('end:') && !c.startsWith('duration:'));
          if (strippedChanges.length > 0) {
            const reason = hasCompletedPayments ? 'has completed payments' : `status is ${existing.status}`;
            process.stderr.write(`[Trackman Import] FROZEN: Booking #${existing.id} ${reason} - skipped: ${strippedChanges.join(', ')}\n`);
          }
        }
        
        updateFields.lastSyncSource = 'trackman_import';
        updateFields.lastTrackmanSyncAt = new Date();
        updateFields.updatedAt = new Date();
        
        if (changes.length > 0) {
          try {
            await db.update(bookingRequests)
              .set(updateFields)
              .where(eq(bookingRequests.id, existing.id));
            
            process.stderr.write(`[Trackman Import] Updated booking #${existing.id} (Trackman ID: ${row.bookingId}): ${changes.join(', ')}${isWebhookCreated ? ' [webhook backfill]' : ''}\n`);
            updatedRows++;

            const hasTimeOrBayChange = changes.some(c => c.startsWith('start:') || c.startsWith('end:') || c.startsWith('duration:') || c.startsWith('bay:'));
            if (hasTimeOrBayChange) {
              refreshBookingPass(existing.id).catch(err => logger.error('[Trackman Import] Booking pass refresh failed', { extra: { bookingId: existing.id, error: getErrorMessage(err) } }));
            }
          } catch (updateErr: unknown) {
            const errMsg = (updateErr instanceof Error && updateErr.cause instanceof Error ? updateErr.cause.message : null) || getErrorMessage(updateErr) || '';
            if (errMsg.includes('booking_requests_no_overlap') || errMsg.includes('exclusion constraint')) {
              delete updateFields.startTime;
              delete updateFields.endTime;
              delete updateFields.durationMinutes;
              const timeChanges = changes.filter(c => c.startsWith('start:') || c.startsWith('end:') || c.startsWith('duration:'));
              const otherChanges = changes.filter(c => !c.startsWith('start:') && !c.startsWith('end:') && !c.startsWith('duration:'));
              
              if (Object.keys(updateFields).length > 0) {
                await db.update(bookingRequests)
                  .set(updateFields)
                  .where(eq(bookingRequests.id, existing.id));
              }
              
              process.stderr.write(`[Trackman Import] Booking #${existing.id}: skipped time update (${timeChanges.join(', ')}) - overlaps with another booking on the same bay${otherChanges.length > 0 ? `. Other updates applied: ${otherChanges.join(', ')}` : ''}\n`);
              updatedRows++;
            } else {
              throw updateErr;
            }
          }
        } else {
          try {
            await db.update(bookingRequests)
              .set(updateFields)
              .where(eq(bookingRequests.id, existing.id));
          } catch (updateErr: unknown) {
            const errMsg = (updateErr instanceof Error && updateErr.cause instanceof Error ? updateErr.cause.message : null) || getErrorMessage(updateErr) || '';
            if (errMsg.includes('booking_requests_no_overlap') || errMsg.includes('exclusion constraint')) {
              process.stderr.write(`[Trackman Import] Booking #${existing.id}: sync tracking update skipped due to overlap constraint\n`);
            } else {
              throw updateErr;
            }
          }
          matchedRows++;
        }
        
        if (isWebhookCreated && !existing.sessionId && parsedBayId && bookingDate && startTime) {
          const ownerEmail = matchedEmail || existing.userEmail;
          const ownerName = row.userName || existing.userName;
          
          if (ownerEmail && ownerEmail !== 'unmatched@trackman.import' && ownerEmail.includes('@')) {
            const backfillParsedPlayers = parseNotesForPlayers(row.notes);
            await createTrackmanSessionAndParticipants({
              bookingId: existing.id,
              trackmanBookingId: row.bookingId,
              resourceId: parsedBayId,
              sessionDate: bookingDate,
              startTime: startTime,
              endTime: endTime,
              durationMinutes: row.durationMins,
              ownerEmail: ownerEmail,
              ownerName: ownerName || 'Unknown',
              parsedPlayers: backfillParsedPlayers,
              membersByEmail: membersByEmail,
              trackmanEmailMapping: trackmanEmailMapping,
              isPast: !isUpcoming
            });
            process.stderr.write(`[Trackman Import] Backfilled session for webhook booking #${existing.id} (Trackman ID: ${row.bookingId})\n`);
          }
        } else if (isWebhookCreated && existing.sessionId && parsedBayId && matchedEmail && existing.isUnmatched) {
          if (!financiallyFrozen) {
            try {
              await recalculateSessionFees(existing.sessionId, 'approval');
              process.stderr.write(`[Trackman Import] Recalculated fees for webhook booking #${existing.id} after member match (session #${existing.sessionId})\n`);
            } catch (recalcErr: unknown) {
              process.stderr.write(`[Trackman Import] Failed to recalculate fees for session #${existing.sessionId}: ${getErrorMessage(recalcErr)}\n`);
            }
          } else {
            process.stderr.write(`[Trackman Import] FROZEN: Skipped fee recalculation for booking #${existing.id} (session #${existing.sessionId}) - ${hasCompletedPayments ? 'has completed payments' : `status is ${existing.status}`}\n`);
          }
          if (!isUpcoming && existing.sessionId && !hasCompletedPayments) {
            try {
              await db.execute(sql`
                UPDATE booking_participants SET payment_status = 'paid', paid_at = NOW()
                WHERE session_id = ${existing.sessionId} AND payment_status = 'pending'
              `);
            } catch (payErr: unknown) {
              process.stderr.write(`[Trackman Import] Failed to mark past session #${existing.sessionId} participants as paid: ${getErrorMessage(payErr)}\n`);
            }
          }
        }
        
        if (legacyIsUnresolved && existingUnmatched[0]) {
          try {
            await db.update(trackmanUnmatchedBookings)
              .set({ 
                resolvedAt: new Date(),
                resolvedBy: 'trackman_import_sync',
                notes: sql`COALESCE(notes, '') || ' [Auto-resolved: booking exists in booking_requests]'`
              })
              .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
            process.stderr.write(`[Trackman Import] Auto-resolved legacy entry for booking ${row.bookingId}\n`);
          } catch (resolveErr: unknown) {
            logger.warn('[Trackman Import] Failed to auto-resolve legacy unmatched entry', { extra: { bookingId: row.bookingId, error: String(resolveErr) } });
          }
        }
        
        continue;
      } // end if (!freedCancelledBooking)
      } // end if existingBooking.length > 0
      if ((!existingBooking.length || freedCancelledBooking) && parsedBayId && bookingDate && startTime) {
        const placeholderBooking = await db.execute(sql`SELECT id, user_email, user_name, status, session_id, trackman_booking_id, origin,
                  ABS(EXTRACT(EPOCH FROM (start_time::time - ${startTime}::time))) as time_diff_seconds
           FROM booking_requests
           WHERE resource_id = ${parsedBayId}
           AND request_date = ${bookingDate}
           AND ABS(EXTRACT(EPOCH FROM (start_time::time - ${startTime}::time))) <= 120
           AND trackman_booking_id IS NULL
           AND (is_unmatched = true 
                OR LOWER(user_name) LIKE '%unknown%' 
                OR LOWER(user_name) LIKE '%unassigned%'
                OR (user_email = '' AND user_name IS NOT NULL))
           AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
           ORDER BY ABS(EXTRACT(EPOCH FROM (start_time::time - ${startTime}::time))), created_at DESC`);
        
        if (placeholderBooking.rows.length > 1) {
          process.stderr.write(`[Trackman Import] Multiple placeholder candidates (${placeholderBooking.rows.length}) for Trackman ${row.bookingId} on bay ${parsedBayId} at ${startTime} - skipping auto-merge, requires manual resolution\n`);
        } else if (placeholderBooking.rows.length === 1) {
          const placeholder = placeholderBooking.rows[0];
          const mergeStatus = matchedEmail ? 'approved' : (normalizedStatus || 'approved');
          
          const updateFields: Record<string, unknown> = {
            trackman_booking_id: row.bookingId,
            user_name: row.userName || placeholder.user_name,
            start_time: startTime,
            end_time: endTime,
            duration_minutes: row.durationMins,
            trackman_player_count: row.playerCount,
            declared_player_count: row.playerCount,
            notes: `[Trackman Import ID:${row.bookingId}] ${row.notes}`,
            trackman_customer_notes: row.notes || null,
            is_unmatched: !matchedEmail,
            status: mergeStatus,
            last_sync_source: 'trackman_import',
            last_trackman_sync_at: new Date(),
            updated_at: new Date(),
            origin: 'trackman_import'
          };
          
          if (matchedEmail) {
            updateFields.user_email = matchedEmail;
            const mergeUserIdResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${matchedEmail}) LIMIT 1`);
            const mergeResolvedUserId = (mergeUserIdResult.rows as Array<{ id: string }>)[0]?.id;
            if (mergeResolvedUserId) {
              updateFields.user_id = mergeResolvedUserId;
            }
          }
          
          const ALLOWED_BOOKING_COLUMNS = new Set([
            'resource_id', 'start_time', 'end_time', 'duration_minutes',
            'request_date', 'user_email', 'user_name', 'user_id',
            'trackman_booking_id', 'trackman_player_count', 'declared_player_count',
            'guest_count', 'notes', 'trackman_customer_notes', 'staff_notes',
            'is_unmatched', 'status', 'last_sync_source', 'last_trackman_sync_at',
            'updated_at', 'origin', 'session_id',
          ]);
          const setFragments = Object.entries(updateFields).map(([key, value]) => {
            if (!ALLOWED_BOOKING_COLUMNS.has(key)) throw new Error(`Invalid column for booking_requests update: ${key}`);
            return sql`${sql.raw(key)} = ${value}`;
          });
          
          await db.execute(sql`UPDATE booking_requests SET ${sql.join(setFragments, sql`, `)} WHERE id = ${placeholder.id}`);
          
          process.stderr.write(`[Trackman Import] MERGED: CSV row ${row.bookingId} into placeholder booking #${placeholder.id} (was: "${placeholder.user_name}", now: "${row.userName}"${matchedEmail ? `, linked to ${matchedEmail}` : ''})\n`);
          
          if (matchedEmail && placeholder.session_id) {
            try {
              const ownerResult = await db.execute(sql`
                SELECT bp.id, bp.user_id, u.email AS current_email
                FROM booking_participants bp
                LEFT JOIN users u ON bp.user_id = u.id
                WHERE bp.session_id = ${placeholder.session_id} AND bp.participant_type = 'owner'
                LIMIT 1
              `);
              const currentOwner = (ownerResult.rows as Array<{ id: number; user_id: string | null; current_email: string | null }>)[0];
              const currentOwnerEmail = currentOwner?.current_email?.toLowerCase();
              if (currentOwner && currentOwnerEmail !== matchedEmail.toLowerCase()) {
                const mergeUserId = updateFields.user_id as string | undefined;
                const newOwnerUser = mergeUserId
                  ? (await db.execute(sql`SELECT first_name, last_name FROM users WHERE id = ${mergeUserId}`)).rows[0] as { first_name: string | null; last_name: string | null } | undefined
                  : undefined;
                const newDisplayName = newOwnerUser
                  ? [newOwnerUser.first_name, newOwnerUser.last_name].filter(Boolean).join(' ') || row.userName || matchedEmail
                  : row.userName || matchedEmail;
                await db.execute(sql`
                  UPDATE booking_participants
                  SET user_id = ${mergeUserId || null},
                      display_name = ${newDisplayName},
                      payment_status = 'waived'
                  WHERE id = ${currentOwner.id}
                `);
                process.stderr.write(`[Trackman Import] Updated session owner for merged placeholder #${placeholder.id}: ${currentOwnerEmail || '(unknown)'} → ${matchedEmail}\n`);
              }
            } catch (ownerUpdateErr: unknown) {
              process.stderr.write(`[Trackman Import] Non-blocking: Failed to update session owner for merged placeholder #${placeholder.id}: ${getErrorMessage(ownerUpdateErr)}\n`);
            }
          }
          
          if (matchedEmail && parsedBayId && !placeholder.session_id) {
            try {
              const mergeParsedPlayersForSession = parseNotesForPlayers(row.notes);
              await createTrackmanSessionAndParticipants({
                bookingId: Number(placeholder.id),
                trackmanBookingId: row.bookingId,
                resourceId: parsedBayId,
                sessionDate: bookingDate,
                startTime: startTime,
                endTime: endTime,
                durationMinutes: Number(row.durationMins),
                ownerEmail: matchedEmail,
                ownerName: row.userName || matchedEmail,
                parsedPlayers: mergeParsedPlayersForSession,
                membersByEmail: membersByEmail,
                trackmanEmailMapping: trackmanEmailMapping,
                isPast: !isUpcoming
              });
              process.stderr.write(`[Trackman Import] Auto-created billing session for merged booking #${placeholder.id} (${matchedEmail})\n`);
            } catch (sessionErr: unknown) {
              process.stderr.write(`[Trackman Import] Failed to create session for merged booking #${placeholder.id}: ${getErrorMessage(sessionErr)}\n`);
            }
          } else if (!matchedEmail || !parsedBayId) {
            process.stderr.write(`[Trackman Import] Merged booking #${placeholder.id} created without session - no matched email or resource\n`);
          }
          
          if (legacyIsUnresolved && existingUnmatched[0]) {
            try {
              await db.update(trackmanUnmatchedBookings)
                .set({ 
                  resolvedAt: new Date(),
                  resolvedBy: 'trackman_import_merge',
                  notes: sql`COALESCE(notes, '') || ' [Auto-resolved: merged with placeholder]'`
                })
                .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
            } catch (e: unknown) { logger.warn('[Trackman Import] Failed to auto-resolve unmatched entry on merge', { error: e instanceof Error ? e.message : String(e), unmatchedId: existingUnmatched[0].id }); }
          }
          
          updatedRows++;
          continue;
        }
      }
      if (!parsedBayId && row.bayNumber) {
        process.stderr.write(`[Trackman Import] Warning: Invalid bay number "${row.bayNumber}" for booking ${row.bookingId} (${row.userName})\n`);
      } else if (!row.bayNumber) {
        process.stderr.write(`[Trackman Import] Warning: Missing bay number for booking ${row.bookingId} (${row.userName}) on ${bookingDate}\n`);
      }

      if (matchedEmail) {
        try {
          if (parsedBayId && bookingDate && startTime) {
            const existingAppBooking = await db.select({ 
              id: bookingRequests.id,
              trackmanBookingId: bookingRequests.trackmanBookingId,
              status: bookingRequests.status,
              sessionId: bookingRequests.sessionId,
              declaredPlayerCount: bookingRequests.declaredPlayerCount,
              guestCount: bookingRequests.guestCount,
              staffNotes: bookingRequests.staffNotes
            })
              .from(bookingRequests)
              .where(sql`
                LOWER(user_email) = LOWER(${matchedEmail})
                AND request_date = ${bookingDate}
                AND start_time = ${startTime}
                AND resource_id = ${parsedBayId}
                AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
              `)
              .limit(1);

            if (existingAppBooking.length > 0) {
              const existing = existingAppBooking[0];
              if (!existing.trackmanBookingId) {
                const updateFields: Record<string, unknown> = { 
                  trackmanBookingId: row.bookingId,
                  trackmanPlayerCount: row.playerCount,
                  lastSyncSource: 'trackman_import',
                  lastTrackmanSyncAt: new Date(),
                  updatedAt: new Date()
                };
                
                const requestPlayerCount = existing.declaredPlayerCount || 0;
                if (requestPlayerCount > 0 && row.playerCount > requestPlayerCount) {
                  updateFields.playerCountMismatch = true;
                  const warningNote = `[Warning: Trackman reports ${row.playerCount} players but app request only declared ${requestPlayerCount}]`;
                  const existingStaffNotes = existing.staffNotes || '';
                  if (!existingStaffNotes.includes('[Warning: Trackman reports')) {
                    updateFields.staffNotes = existingStaffNotes ? `${warningNote} ${existingStaffNotes}` : warningNote;
                  }
                  process.stderr.write(`[Trackman Import] MISMATCH: Linking booking #${existing.id} - Trackman reports ${row.playerCount} players but app request declared ${requestPlayerCount}\n`);
                }
                
                await db.update(bookingRequests)
                  .set(updateFields)
                  .where(eq(bookingRequests.id, existing.id));
                
                const _targetPlayerCount = requestPlayerCount > 0 ? requestPlayerCount : row.playerCount;
                
                process.stderr.write(`[Trackman Import] Auto-linked Trackman ID ${row.bookingId} to existing app booking #${existing.id} (${matchedEmail}) - exact time match\n`);
                if (!existing.sessionId && parsedBayId) {
                  try {
                    const linkedParsedPlayersForSession = parseNotesForPlayers(row.notes);
                    await createTrackmanSessionAndParticipants({
                      bookingId: existing.id,
                      trackmanBookingId: row.bookingId,
                      resourceId: parsedBayId,
                      sessionDate: bookingDate,
                      startTime: startTime,
                      endTime: endTime,
                      durationMinutes: row.durationMins,
                      ownerEmail: matchedEmail,
                      ownerName: row.userName || matchedEmail,
                      parsedPlayers: linkedParsedPlayersForSession,
                      membersByEmail: membersByEmail,
                      trackmanEmailMapping: trackmanEmailMapping,
                      isPast: !isUpcoming
                    });
                    process.stderr.write(`[Trackman Import] Auto-created billing session for linked booking #${existing.id} (${matchedEmail})\n`);
                  } catch (sessionErr: unknown) {
                    process.stderr.write(`[Trackman Import] Failed to create session for linked booking #${existing.id}: ${getErrorMessage(sessionErr)}\n`);
                  }
                }
                
                if (legacyIsUnresolved && existingUnmatched[0]) {
                  try {
                    await db.update(trackmanUnmatchedBookings)
                      .set({ 
                        resolvedAt: new Date(),
                        resolvedBy: 'trackman_import_link',
                        notes: sql`COALESCE(notes, '') || ' [Auto-resolved: linked to app booking]'`
                      })
                      .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
                  } catch (e: unknown) { logger.warn('[Trackman Import] Failed to auto-resolve unmatched entry on link', { error: e instanceof Error ? e.message : String(e), unmatchedId: existingUnmatched[0].id }); }
                }
                
                linkedRows++;
                continue;
              } else if (existing.trackmanBookingId === row.bookingId) {
                if (!existing.sessionId) {
                  await db.update(bookingRequests)
                    .set({ 
                      trackmanPlayerCount: row.playerCount
                    })
                    .where(eq(bookingRequests.id, existing.id));
                  
                  if (matchedEmail && parsedBayId) {
                    try {
                      const matchedParsedPlayersForSession = parseNotesForPlayers(row.notes);
                      await createTrackmanSessionAndParticipants({
                        bookingId: existing.id,
                        trackmanBookingId: row.bookingId,
                        resourceId: parsedBayId,
                        sessionDate: bookingDate,
                        startTime: startTime,
                        endTime: endTime,
                        durationMinutes: row.durationMins,
                        ownerEmail: matchedEmail,
                        ownerName: row.userName || matchedEmail,
                        parsedPlayers: matchedParsedPlayersForSession,
                        membersByEmail: membersByEmail,
                        trackmanEmailMapping: trackmanEmailMapping,
                        isPast: !isUpcoming
                      });
                      process.stderr.write(`[Trackman Import] Auto-created billing session for matched booking #${existing.id} (Trackman ID: ${row.bookingId})\n`);
                    } catch (sessionErr: unknown) {
                      process.stderr.write(`[Trackman Import] Failed to create session for matched booking #${existing.id}: ${getErrorMessage(sessionErr)}\n`);
                    }
                  } else {
                    process.stderr.write(`[Trackman Import] Matched booking #${existing.id} has no session - no matched email or resource to create billing session\n`);
                  }
                }
                
                if (legacyIsUnresolved && existingUnmatched[0]) {
                  try {
                    await db.update(trackmanUnmatchedBookings)
                      .set({ 
                        resolvedAt: new Date(),
                        resolvedBy: 'trackman_import_existing',
                        notes: sql`COALESCE(notes, '') || ' [Auto-resolved: booking already exists]'`
                      })
                      .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
                  } catch (e: unknown) { logger.warn('[Trackman Import] Failed to auto-resolve unmatched entry on existing match', { error: e instanceof Error ? e.message : String(e), unmatchedId: existingUnmatched[0].id }); }
                }
                
                matchedRows++;
                continue;
              } else {
                process.stderr.write(`[Trackman Import] Conflict: Booking #${existing.id} already has Trackman ID ${existing.trackmanBookingId}, cannot link ${row.bookingId}\n`);
                skippedRows++;
                continue;
              }
            }
            
            const potentialMatches = await db.select({ 
              id: bookingRequests.id,
              trackmanBookingId: bookingRequests.trackmanBookingId,
              status: bookingRequests.status,
              sessionId: bookingRequests.sessionId,
              startTime: bookingRequests.startTime,
              declaredPlayerCount: bookingRequests.declaredPlayerCount,
              staffNotes: bookingRequests.staffNotes
            })
              .from(bookingRequests)
              .where(sql`
                LOWER(user_email) = LOWER(${matchedEmail})
                AND request_date = ${bookingDate}
                AND resource_id = ${parsedBayId}
                AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
                AND trackman_booking_id IS NULL
              `);
            
            const matchesWithinTolerance = potentialMatches.filter(m => 
              m.startTime && isTimeWithinTolerance(startTime, m.startTime, 5)
            );
            
            if (matchesWithinTolerance.length === 1) {
              const existing = matchesWithinTolerance[0];
              
              const updateFields: Record<string, unknown> = { 
                trackmanBookingId: row.bookingId,
                trackmanPlayerCount: row.playerCount,
                lastSyncSource: 'trackman_import',
                lastTrackmanSyncAt: new Date(),
                updatedAt: new Date()
              };
              
              const requestPlayerCount = existing.declaredPlayerCount || 0;
              if (requestPlayerCount > 0 && row.playerCount > requestPlayerCount) {
                updateFields.playerCountMismatch = true;
                const warningNote = `[Warning: Trackman reports ${row.playerCount} players but app request only declared ${requestPlayerCount}]`;
                const existingStaffNotes = existing.staffNotes || '';
                if (!existingStaffNotes.includes('[Warning: Trackman reports')) {
                  updateFields.staffNotes = existingStaffNotes ? `${warningNote} ${existingStaffNotes}` : warningNote;
                }
                process.stderr.write(`[Trackman Import] MISMATCH: Tolerance linking booking #${existing.id} - Trackman reports ${row.playerCount} players but app request declared ${requestPlayerCount}\n`);
              }
              
              await db.update(bookingRequests)
                .set(updateFields)
                .where(eq(bookingRequests.id, existing.id));
              
              const _targetPlayerCount = requestPlayerCount > 0 ? requestPlayerCount : row.playerCount;
              
              process.stderr.write(`[Trackman Import] Auto-linked Trackman ID ${row.bookingId} to existing app booking #${existing.id} (${matchedEmail}) - time tolerance match (${existing.startTime} vs ${startTime})\n`);
              if (!existing.sessionId && parsedBayId) {
                try {
                  const toleranceParsedPlayersForSession = parseNotesForPlayers(row.notes);
                  await createTrackmanSessionAndParticipants({
                    bookingId: existing.id,
                    trackmanBookingId: row.bookingId,
                    resourceId: parsedBayId,
                    sessionDate: bookingDate,
                    startTime: startTime,
                    endTime: endTime,
                    durationMinutes: row.durationMins,
                    ownerEmail: matchedEmail,
                    ownerName: row.userName || matchedEmail,
                    parsedPlayers: toleranceParsedPlayersForSession,
                    membersByEmail: membersByEmail,
                    trackmanEmailMapping: trackmanEmailMapping,
                    isPast: !isUpcoming
                  });
                  process.stderr.write(`[Trackman Import] Auto-created billing session for tolerance-linked booking #${existing.id} (${matchedEmail})\n`);
                } catch (sessionErr: unknown) {
                  process.stderr.write(`[Trackman Import] Failed to create session for tolerance-linked booking #${existing.id}: ${getErrorMessage(sessionErr)}\n`);
                }
              }
              
              if (legacyIsUnresolved && existingUnmatched[0]) {
                try {
                  await db.update(trackmanUnmatchedBookings)
                    .set({ 
                      resolvedAt: new Date(),
                      resolvedBy: 'trackman_import_link',
                      notes: sql`COALESCE(notes, '') || ' [Auto-resolved: linked to app booking]'`
                    })
                    .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
                } catch (e: unknown) { logger.warn('[Trackman Import] Failed to auto-resolve unmatched entry on tolerance link', { error: e instanceof Error ? e.message : String(e), unmatchedId: existingUnmatched[0].id }); }
              }
              
              linkedRows++;
              continue;
            } else if (matchesWithinTolerance.length > 1) {
              process.stderr.write(`[Trackman Import] Potential match - requires staff confirmation: Trackman ID ${row.bookingId} has ${matchesWithinTolerance.length} possible matches for ${matchedEmail} on ${bookingDate} at ${startTime}\n`);
            }
          }

          const existingByTrackmanId = await db.select({
            id: bookingRequests.id,
            trackmanBookingId: bookingRequests.trackmanBookingId,
            userEmail: bookingRequests.userEmail,
            status: bookingRequests.status,
            sessionId: bookingRequests.sessionId,
            isUnmatched: bookingRequests.isUnmatched,
          }).from(bookingRequests)
            .where(eq(bookingRequests.trackmanBookingId, row.bookingId))
            .limit(1);

          if (existingByTrackmanId.length > 0) {
            const existingGhost = existingByTrackmanId[0];
            const ghostUpdateStatus = matchedEmail ? 'approved' : (normalizedStatus || existingGhost.status);

            const ghostUpdateFields: Record<string, unknown> = {
              userName: row.userName || undefined,
              startTime: startTime,
              endTime: endTime,
              durationMinutes: row.durationMins,
              trackmanPlayerCount: row.playerCount,
              declaredPlayerCount: row.playerCount,
              notes: `[Trackman Import ID:${row.bookingId}] ${row.notes}`,
              trackmanCustomerNotes: row.notes || null,
              isUnmatched: !matchedEmail,
              status: ghostUpdateStatus,
              lastSyncSource: 'trackman_import',
              lastTrackmanSyncAt: new Date(),
              updatedAt: new Date(),
              origin: 'trackman_import',
            };

            if (matchedEmail) {
              ghostUpdateFields.userEmail = matchedEmail;
              const userIdResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${matchedEmail}) LIMIT 1`);
              const resolvedUserId = (userIdResult.rows as Array<{ id: string }>)[0]?.id;
              if (resolvedUserId) {
                ghostUpdateFields.userId = resolvedUserId;
              }
            }
            if (parsedBayId) {
              ghostUpdateFields.resourceId = parsedBayId;
            }
            if (bookingDate) {
              ghostUpdateFields.requestDate = bookingDate;
            }

            await db.update(bookingRequests)
              .set(ghostUpdateFields)
              .where(eq(bookingRequests.id, existingGhost.id));

            process.stderr.write(`[Trackman Import] UPDATED ghost booking #${existingGhost.id} (trackman_booking_id=${row.bookingId}) instead of creating duplicate${matchedEmail ? `, assigned to ${matchedEmail}` : ''}\n`);

            if (matchedEmail) {
              if (parsedBayId && bookingDate && startTime && !existingGhost.sessionId) {
                try {
                  const ghostParsedPlayersForSession = parseNotesForPlayers(row.notes);
                  await createTrackmanSessionAndParticipants({
                    bookingId: existingGhost.id,
                    trackmanBookingId: row.bookingId,
                    resourceId: parsedBayId,
                    sessionDate: bookingDate,
                    startTime: startTime,
                    endTime: endTime,
                    durationMinutes: row.durationMins,
                    ownerEmail: matchedEmail,
                    ownerName: row.userName || matchedEmail,
                    parsedPlayers: ghostParsedPlayersForSession,
                    membersByEmail: membersByEmail,
                    trackmanEmailMapping: trackmanEmailMapping,
                    isPast: !isUpcoming
                  });
                  process.stderr.write(`[Trackman Import] Auto-created billing session for ghost booking #${existingGhost.id} (${matchedEmail})\n`);
                } catch (sessionErr: unknown) {
                  process.stderr.write(`[Trackman Import] Failed to create session for ghost booking #${existingGhost.id}: ${getErrorMessage(sessionErr)}\n`);
                }
              } else if (existingGhost.sessionId) {
                try {
                  const ownerResult = await db.execute(sql`
                    SELECT bp.id, bp.user_id, u.email AS current_email
                    FROM booking_participants bp
                    LEFT JOIN users u ON bp.user_id = u.id
                    WHERE bp.session_id = ${existingGhost.sessionId} AND bp.participant_type = 'owner'
                    LIMIT 1
                  `);
                  const currentOwner = (ownerResult.rows as Array<{ id: number; user_id: string | null; current_email: string | null }>)[0];
                  const currentOwnerEmail = currentOwner?.current_email?.toLowerCase();
                  if (currentOwner && currentOwnerEmail !== matchedEmail.toLowerCase()) {
                    const newOwnerResult = await db.execute(sql`
                      SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${matchedEmail}) LIMIT 1
                    `);
                    const newOwnerUser = (newOwnerResult.rows as Array<{ id: string; first_name: string | null; last_name: string | null }>)[0];
                    const newDisplayName = newOwnerUser
                      ? [newOwnerUser.first_name, newOwnerUser.last_name].filter(Boolean).join(' ') || row.userName || matchedEmail
                      : row.userName || matchedEmail;
                    await db.execute(sql`
                      UPDATE booking_participants
                      SET user_id = ${newOwnerUser?.id || null},
                          display_name = ${newDisplayName},
                          payment_status = 'waived'
                      WHERE id = ${currentOwner.id}
                    `);
                    process.stderr.write(`[Trackman Import] Updated session owner for ghost booking #${existingGhost.id}: ${currentOwnerEmail || '(unknown)'} → ${matchedEmail}\n`);
                  }
                } catch (ownerUpdateErr: unknown) {
                  process.stderr.write(`[Trackman Import] Failed to update session owner for ghost booking #${existingGhost.id}: ${getErrorMessage(ownerUpdateErr)}\n`);
                }
              }
            }

            if (legacyIsUnresolved && existingUnmatched[0]) {
              try {
                await db.update(trackmanUnmatchedBookings)
                  .set({
                    resolvedAt: new Date(),
                    resolvedBy: 'trackman_import_ghost_update',
                    notes: sql`COALESCE(notes, '') || ' [Auto-resolved: ghost booking updated with member info]'`
                  })
                  .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
              } catch (e: unknown) { logger.warn('[Trackman Import] Failed to auto-resolve unmatched entry on ghost update', { error: e instanceof Error ? e.message : String(e), unmatchedId: existingUnmatched[0].id }); }
            }

            updatedRows++;
            continue;
          }

          if (parsedBayId && bookingDate && startTime) {
            const alreadyPrivateEvent = await isConvertedToPrivateEventBlock(
              parsedBayId,
              bookingDate,
              startTime,
              endTime
            );
            if (alreadyPrivateEvent) {
              process.stderr.write(`[Trackman Import] Skipping matched booking ${row.bookingId} (${matchedEmail}) - already converted to private event block\n`);
              skippedAsPrivateEventBlocks++;
              continue;
            }
          }
          
          const originalBookedDate = row.bookedDate ? new Date(row.bookedDate.replace(' ', 'T') + ':00') : null;
          
          const parsedPlayersForInsert = parseNotesForPlayers(row.notes);
          const actualGuestCount = parsedPlayersForInsert.filter(p => p.type === 'guest').length;
          if (parsedPlayersForInsert.length > 0) {
            process.stderr.write(`[Trackman Import] Parsed ${parsedPlayersForInsert.length} players from notes: ${parsedPlayersForInsert.map(p => `${p.type}:${p.name||p.email||'unknown'}`).join(', ')}\n`);
          }
          
          let insertUserId: string | null = null;
          if (matchedEmail) {
            const insertUserIdResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${matchedEmail}) LIMIT 1`);
            insertUserId = (insertUserIdResult.rows as Array<{ id: string }>)[0]?.id || null;
          }

          const insertResult = await db.insert(bookingRequests).values({
            userEmail: matchedEmail,
            userName: row.userName,
            userId: insertUserId,
            resourceId: parsedBayId,
            requestDate: bookingDate,
            startTime: startTime,
            durationMinutes: row.durationMins,
            endTime: endTime,
            notes: `[Trackman Import ID:${row.bookingId}] ${row.notes}`,
            status: matchedEmail ? 'approved' : normalizedStatus,
            createdAt: originalBookedDate || new Date(),
            trackmanBookingId: row.bookingId,
            guestCount: actualGuestCount,
            trackmanPlayerCount: row.playerCount,
            declaredPlayerCount: row.playerCount,
            origin: 'trackman_import',
            lastSyncSource: 'trackman_import',
            lastTrackmanSyncAt: new Date(),
          }).returning({ id: bookingRequests.id });

          if (insertResult[0] && row.playerCount >= 1) {
            const bookingId = insertResult[0].id;
            
            const _memberEmails = parsedPlayersForInsert
              .filter(p => p.type === 'member' && p.email)
              .map(p => p.email!.toLowerCase());
            
            const guests = parsedPlayersForInsert.filter(p => p.type === 'guest');
            
            let memberSlot = 2;
            const ownerResolvedEmail = resolveEmail(matchedEmail, membersByEmail, trackmanEmailMapping);
            
            const memberPlayers = parsedPlayersForInsert.filter(p => p.type === 'member' && p.email);
            
            for (const memberPlayer of memberPlayers) {
              const memberEmail = memberPlayer.email!.toLowerCase();
              
              const memberResolvedEmail = resolveEmail(memberEmail, membersByEmail, trackmanEmailMapping);
              
              if (memberResolvedEmail === ownerResolvedEmail) {
                continue;
              }
              
              const isLinkedToOwner = await isEmailLinkedToUser(memberEmail, matchedEmail);
              if (isLinkedToOwner) {
                process.stderr.write(`[Trackman Import] Skipping M: ${memberEmail} - linked to owner ${matchedEmail}\n`);
                continue;
              }
              
              const mappedMemberEmail = emailMapping.get(memberEmail);
              const memberExists = membersByEmail.get(memberEmail) || trackmanEmailMapping.get(memberEmail) || 
                (mappedMemberEmail ? membersByEmail.get(mappedMemberEmail.toLowerCase()) || mappedMemberEmail : undefined);
              
              const resolvedMemberEmail = memberExists;
              
              if (memberSlot <= row.playerCount) {
                if (resolvedMemberEmail && normalizedStatus === 'approved' && isUpcoming && !isSyntheticEmail(resolvedMemberEmail)) {
                  const linkedMessage = `You've been added to a simulator booking on ${formatNotificationDateTime(bookingDate, startTime)}.`;
                  await db.insert(notifications).values({
                    userEmail: resolvedMemberEmail,
                    title: 'Added to Booking',
                    message: linkedMessage,
                    type: 'booking_approved',
                    relatedId: bookingId,
                    relatedType: 'booking_request'
                  });
                  sendPushNotification(resolvedMemberEmail, {
                    title: 'Added to Booking',
                    body: linkedMessage,
                    url: '/sims',
                    tag: `booking-${bookingId}`
                  }).catch((err) => { logger.warn('[Trackman Import] Non-critical push notification failed:', err); });
                }
                
                if (resolvedMemberEmail && normalizedStatus === 'attended') {
                  await db.execute(sql`
                    UPDATE users 
                    SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
                    WHERE email = ${resolvedMemberEmail}
                  `);
                }
                
                memberSlot++;
              }
            }
            
            const ownerNameNormalized = (row.userName || matchedEmail).toLowerCase().trim();
            for (const guest of guests) {
              const guestNameNormalized = (guest.name || '').toLowerCase().trim();
              
              if (guestNameNormalized && (
                guestNameNormalized === ownerNameNormalized ||
                ownerNameNormalized.includes(guestNameNormalized) ||
                guestNameNormalized.includes(ownerNameNormalized.split(' ')[0])
              )) {
                process.stderr.write(`[Trackman Import] Skipping guest entry for "${guest.name}" - matches owner name "${row.userName || matchedEmail}"\n`);
                continue;
              }
              
              const hasGuestInfo = !!(guest.name?.trim() || guest.email?.trim());
              if (hasGuestInfo) {
                const guestPassResult = await useGuestPass(matchedEmail, guest.name || undefined, isUpcoming);
                if (!guestPassResult.success) {
                  process.stderr.write(`[Trackman Import] Guest pass deduction failed for ${matchedEmail} (guest: ${guest.name}): ${guestPassResult.error}\n`);
                } else {
                  process.stderr.write(`[Trackman Import] Deducted guest pass for ${matchedEmail} (guest: ${guest.name}), ${guestPassResult.remaining} remaining\n`);
                }
              } else {
                process.stderr.write(`[Trackman Import] Guest has no identifying info - skipping guest pass, fee will be charged for ${matchedEmail}\n`);
              }
            }
            
            
            if (parsedBayId) {
              try {
                await createTrackmanSessionAndParticipants({
                  bookingId: bookingId,
                  trackmanBookingId: row.bookingId,
                  resourceId: parsedBayId,
                  sessionDate: bookingDate,
                  startTime: startTime,
                  endTime: endTime,
                  durationMinutes: row.durationMins,
                  ownerEmail: matchedEmail,
                  ownerName: row.userName || matchedEmail,
                  parsedPlayers: parsedPlayers,
                  membersByEmail: membersByEmail,
                  trackmanEmailMapping: trackmanEmailMapping,
                  isPast: !isUpcoming
                });
                process.stderr.write(`[Trackman Import] Auto-created billing session for booking #${bookingId} (${matchedEmail})\n`);
              } catch (sessionErr: unknown) {
                process.stderr.write(`[Trackman Import] Failed to create session for booking #${bookingId}: ${getErrorMessage(sessionErr)}\n`);
              }
            } else {
              process.stderr.write(`[Trackman Import] Booking #${bookingId} created without session - no resource ID available\n`);
            }
          }

          if (normalizedStatus === 'attended') {
            await db.execute(sql`
              UPDATE users 
              SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
              WHERE email = ${matchedEmail}
            `);
          }

          if (normalizedStatus === 'approved' && isUpcoming && insertResult[0] && !isSyntheticEmail(matchedEmail)) {
            const approvalMessage = `Your simulator booking for ${formatNotificationDateTime(bookingDate, startTime)} has been approved.`;
            
            await db.insert(notifications).values({
              userEmail: matchedEmail,
              title: 'Booking Confirmed',
              message: approvalMessage,
              type: 'booking_approved',
              relatedId: insertResult[0].id,
              relatedType: 'booking_request'
            });
            
            sendPushNotification(matchedEmail, {
              title: 'Booking Confirmed!',
              body: approvalMessage,
              url: '/sims',
              tag: `booking-${insertResult[0].id}`
            }).catch(err => {
              process.stderr.write(`[Trackman Import] Push notification failed for ${matchedEmail}: ${getErrorMessage(err)}\n`);
            });
          }

          if (legacyIsUnresolved && existingUnmatched[0]) {
            try {
              await db.update(trackmanUnmatchedBookings)
                .set({ 
                  resolvedAt: new Date(),
                  resolvedBy: 'trackman_import_create',
                  resolvedEmail: matchedEmail,
                  notes: sql`COALESCE(notes, '') || ' [Auto-resolved: matched booking created]'`
                })
                .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
              process.stderr.write(`[Trackman Import] Auto-resolved legacy entry for booking ${row.bookingId} -> ${matchedEmail}\n`);
            } catch (e: unknown) { logger.warn('[Trackman Import] Failed to auto-resolve unmatched entry on create', { error: e instanceof Error ? e.message : String(e), unmatchedId: existingUnmatched[0].id }); }
          }

          matchedRows++;
        } catch (insertErr: unknown) {
          if (getErrorMessage(insertErr)?.includes('duplicate key') || getErrorCode(insertErr) === '23505') {
            process.stderr.write(`[Trackman Import] Booking ${row.bookingId} already exists (race with webhook) - skipping\n`);
            skippedRows++;
            continue;
          }
          const errDetails = (insertErr instanceof Error && insertErr.cause instanceof Error ? insertErr.cause.message : null) || getErrorCode(insertErr) || 'no details';
          process.stderr.write(`[Trackman Import] Insert error for ${row.bookingId}: ${getErrorMessage(insertErr)} | Details: ${errDetails}\n`);
          throw insertErr;
        }
      } else {
        let matchAttemptReason = isPlaceholderEmail(row.userEmail) 
          ? 'Placeholder email, name not found in members' 
          : 'Email not found in members database';
        
        const normalizedName = row.userName?.toLowerCase().trim() || '';
        if (normalizedName && normalizedName.includes(' ')) {
          matchAttemptReason = `REQUIRES_REVIEW: ${matchAttemptReason} - name "${row.userName}" may match existing member`;
        }
        
        if (requiresReview.length > 0) {
          const reviewItems = requiresReview.map(r => `${r.name}: ${r.reason}`).join('; ');
          matchAttemptReason += ` | Additional players need review: ${reviewItems}`;
        }
        
        const alreadyConvertedToBlock = await isConvertedToPrivateEventBlock(
          parsedBayId,
          bookingDate,
          startTime,
          endTime
        );
        
        if (alreadyConvertedToBlock) {
          process.stderr.write(`[Trackman Import] Skipping unmatched booking ${row.bookingId} - already converted to private event block\n`);
          continue;
        }
        
        try {
          const unmatchedInsertResult = await db.insert(bookingRequests).values({
            userEmail: '',
            userName: row.userName,
            resourceId: parsedBayId,
            requestDate: bookingDate,
            startTime: startTime,
            durationMinutes: row.durationMins,
            endTime: endTime,
            notes: `[Trackman Import ID:${row.bookingId}] [UNMATCHED - requires staff resolution] ${row.notes}`,
            status: normalizedStatus,
            createdAt: row.bookedDate ? new Date(row.bookedDate.replace(' ', 'T') + ':00') : new Date(),
            trackmanBookingId: row.bookingId,
            trackmanPlayerCount: row.playerCount,
            declaredPlayerCount: row.playerCount,
            isUnmatched: true,
            trackmanCustomerNotes: `Original name: ${row.userName}, Original email: ${row.userEmail}`,
            origin: 'trackman_import',
            lastSyncSource: 'trackman_import',
            lastTrackmanSyncAt: new Date(),
          }).returning({ id: bookingRequests.id });
          
          process.stderr.write(`[Trackman Import] Created unmatched booking #${unmatchedInsertResult[0]?.id} to block slot (Trackman ID: ${row.bookingId})\n`);
        } catch (unmatchedErr: unknown) {
          if (!getErrorMessage(unmatchedErr)?.includes('duplicate key')) {
            process.stderr.write(`[Trackman Import] Error creating unmatched booking for ${row.bookingId}: ${getErrorMessage(unmatchedErr)}\n`);
          }
        }
        
        if (!hasLegacyEntry) {
          try {
            await db.insert(trackmanUnmatchedBookings).values({
              trackmanBookingId: row.bookingId,
              userName: row.userName,
              originalEmail: row.userEmail,
              bookingDate: bookingDate,
              startTime: startTime,
              endTime: endTime,
              durationMinutes: row.durationMins,
              status: normalizedStatus,
              bayNumber: row.bayNumber,
              playerCount: row.playerCount,
              notes: row.notes,
              matchAttemptReason: matchAttemptReason
            });
          } catch (legacyErr: unknown) {
            if (!getErrorMessage(legacyErr)?.includes('duplicate key')) {
              process.stderr.write(`[Trackman Import] Error creating legacy unmatched entry: ${getErrorMessage(legacyErr)}\n`);
            }
          }
        }

        unmatchedRows++;
      }
    } catch (err: unknown) {
      const dbError = (err instanceof Error && err.cause instanceof Error ? err.cause.message : null) || getErrorMessage(err);
      errors.push(`Row ${i}: ${dbError}`);
      skippedRows++;
    }
  }

  process.stderr.write(`[Trackman Import] Summary: mappingMatchCount=${mappingMatchCount}, mappingFoundButNotInDb=${mappingFoundButNotInDb}, matchedRows=${matchedRows}, linkedRows=${linkedRows}, unmatchedRows=${unmatchedRows}, skipped=${skippedRows}, skippedAsPrivateEventBlocks=${skippedAsPrivateEventBlocks}\n`);

  const unmatchedToRemove = await db.select({ 
    id: trackmanUnmatchedBookings.id, 
    trackmanBookingId: trackmanUnmatchedBookings.trackmanBookingId,
    userName: trackmanUnmatchedBookings.userName 
  })
    .from(trackmanUnmatchedBookings)
    .where(sql`trackman_booking_id IS NOT NULL`);
  
  for (const booking of unmatchedToRemove) {
    if (booking.trackmanBookingId && !importBookingIds.has(booking.trackmanBookingId)) {
      await db.delete(trackmanUnmatchedBookings)
        .where(eq(trackmanUnmatchedBookings.id, booking.id));
      removedFromUnmatched++;
      process.stderr.write(`[Trackman Import] Removed unmatched booking ${booking.trackmanBookingId} (${booking.userName}) - no longer in Trackman\n`);
    }
  }

  const _todayStr = getTodayPacific();
  
  let csvMinDate: string | null = null;
  let csvMaxDate: string | null = null;
  for (let i = 1; i < parsedRows.length; i++) {
    const fields = parsedRows[i];
    if (fields.length >= 9) {
      const dateStr = extractDate(fields[8]);
      if (dateStr) {
        if (!csvMinDate || dateStr < csvMinDate) csvMinDate = dateStr;
        if (!csvMaxDate || dateStr > csvMaxDate) csvMaxDate = dateStr;
      }
    }
  }
  
  process.stderr.write(`[Trackman Import] CSV date range: ${csvMinDate || 'none'} to ${csvMaxDate || 'none'}\n`);
  
  const matchedToCancel = csvMinDate && csvMaxDate ? await db.select({ 
    id: bookingRequests.id, 
    trackmanBookingId: bookingRequests.trackmanBookingId,
    userName: bookingRequests.userName,
    userEmail: bookingRequests.userEmail,
    requestDate: bookingRequests.requestDate,
    startTime: bookingRequests.startTime,
    status: bookingRequests.status
  })
    .from(bookingRequests)
    .where(sql`
      trackman_booking_id IS NOT NULL 
      AND status NOT IN ('cancelled', 'attended', 'no_show', 'cancellation_pending', 'deleted')
      AND request_date >= ${csvMinDate}::date 
      AND request_date <= ${csvMaxDate}::date
    `) : [];
  
  for (const booking of matchedToCancel) {
    if (booking.trackmanBookingId && !importBookingIds.has(booking.trackmanBookingId)) {
      const bookingDateStr = typeof booking.requestDate === 'object' && booking.requestDate !== null
        ? (booking.requestDate as Date).toISOString().split('T')[0]
        : String(booking.requestDate);
      
      const isStillFuture = isFutureBooking(bookingDateStr, booking.startTime || '00:00');
      
      if (isStillFuture) {
        await cancelPendingPaymentIntentsForBooking(booking.id);
        
        try {
          await refundSucceededPaymentIntentsForBooking(booking.id);
        } catch (refundErr: unknown) {
          logger.error('[Trackman Import] Failed to refund succeeded PIs for stale booking', { extra: { bookingId: booking.id, error: getErrorMessage(refundErr) } });
        }

        try {
          await voidBookingInvoice(booking.id);
        } catch (voidErr: unknown) {
          logger.error('[Trackman Import] Failed to void invoice for stale booking', { extra: { bookingId: booking.id, error: getErrorMessage(voidErr) } });
        }

        voidBookingPass(booking.id).catch(err => logger.error('[Trackman Import] Failed to void booking wallet pass for stale booking', { extra: { bookingId: booking.id, error: getErrorMessage(err) } }));

        await db.update(bookingRequests)
          .set({ 
            status: 'cancelled',
            isUnmatched: false,
            notes: sql`COALESCE(notes, '') || ' [Auto-cancelled: Removed from Trackman]'`
          })
          .where(eq(bookingRequests.id, booking.id));
        
        cancelledBookings++;
        logger.info('[Trackman Import] Cancelled stale booking', { extra: { bookingId: booking.id, trackmanBookingId: booking.trackmanBookingId, userName: booking.userName, date: bookingDateStr } });
        
        if (booking.userEmail && !isSyntheticEmail(booking.userEmail)) {
          const cancelMessage = `Your simulator booking for ${formatNotificationDateTime(bookingDateStr, booking.startTime || '')} has been cancelled as it was removed from the booking system.`;
          
          await db.insert(notifications).values({
            userEmail: booking.userEmail,
            title: 'Booking Cancelled',
            message: cancelMessage,
            type: 'booking_cancelled',
            relatedId: booking.id,
            relatedType: 'booking_request'
          });
          
          sendPushNotification(booking.userEmail, {
            title: 'Booking Cancelled',
            body: cancelMessage,
            url: '/sims',
            tag: `booking-${booking.id}`
          }).catch(err => {
            process.stderr.write(`[Trackman Import] Push notification failed for cancellation ${booking.userEmail}: ${getErrorMessage(err)}\n`);
          });
        }
      }
    }
  }

  if (csvMinDate && csvMaxDate) {
    const pgArrayLiteral = `{${Array.from(importBookingIds).join(',')}}`;
    const staleUnmatched = await db.execute(sql`
      UPDATE booking_requests 
      SET is_unmatched = false, 
          status = CASE 
            WHEN status IN ('cancelled', 'declined', 'deleted', 'attended', 'no_show', 'cancellation_pending') THEN status 
            ELSE 'cancelled' 
          END,
          notes = CASE 
            WHEN status NOT IN ('cancelled', 'declined', 'deleted', 'attended', 'no_show', 'cancellation_pending') 
            THEN COALESCE(notes, '') || ' [Auto-cancelled: Removed from Trackman]'
            ELSE notes 
          END,
          updated_at = NOW()
      WHERE is_unmatched = true 
        AND trackman_booking_id IS NOT NULL
        AND request_date >= ${csvMinDate}::date 
        AND request_date <= ${csvMaxDate}::date
        AND trackman_booking_id <> ALL(${pgArrayLiteral}::text[])
      RETURNING id, trackman_booking_id
    `);
    const staleCount = staleUnmatched.rowCount || 0;
    if (staleCount > 0) {
      removedFromUnmatched += staleCount;
      process.stderr.write(`[Trackman Import] Cleared ${staleCount} stale unmatched bookings no longer in Trackman CSV\n`);
    }
  }

  if (removedFromUnmatched > 0 || cancelledBookings > 0 || updatedRows > 0) {
    process.stderr.write(`[Trackman Import] Cleanup: removed ${removedFromUnmatched} unmatched, cancelled ${cancelledBookings} matched bookings, updated ${updatedRows} existing bookings\n`);
  }

  try {
    const autoApproved = await db.execute(sql`UPDATE booking_requests 
       SET status = 'approved', updated_at = NOW(), staff_notes = COALESCE(staff_notes, '') || ' [Auto-approved by import: member linked]'
       WHERE origin IN ('trackman_import', 'trackman_webhook')
       AND status = 'pending'
       AND user_email IS NOT NULL 
       AND user_email != ''
       AND is_unmatched IS NOT TRUE
       AND last_trackman_sync_at >= NOW() - INTERVAL '1 hour'
       RETURNING id, user_email, user_name, resource_id, request_date, start_time, end_time, trackman_booking_id, session_id, request_participants, user_id`);
    
    if (autoApproved.rows.length > 0) {
      process.stderr.write(`[Trackman Import] Post-import cleanup: Auto-approved ${autoApproved.rows.length} pending member-linked bookings\n`);
      for (const approved of autoApproved.rows as Array<{
        id: number; user_email: string; user_name: string | null; resource_id: number | null;
        request_date: string; start_time: string; end_time: string; trackman_booking_id: string | null;
        session_id: number | null; request_participants: unknown; user_id: string | null;
      }>) {
        process.stderr.write(`[Trackman Import]   Auto-approved booking #${approved.id} for ${approved.user_name || approved.user_email}\n`);
        
        let targetSessionId = approved.session_id;
        
        if (!targetSessionId && approved.resource_id && approved.start_time && approved.end_time) {
          try {
            const sessionResult = await ensureSessionForBooking({
              bookingId: approved.id,
              resourceId: approved.resource_id,
              sessionDate: String(approved.request_date),
              startTime: String(approved.start_time),
              endTime: String(approved.end_time),
              ownerEmail: approved.user_email,
              ownerName: approved.user_name || undefined,
              ownerUserId: approved.user_id || undefined,
              trackmanBookingId: approved.trackman_booking_id || undefined,
              source: 'trackman_import',
              createdBy: 'trackman_import_cleanup'
            });
            if (sessionResult.sessionId) {
              targetSessionId = sessionResult.sessionId;
              await db.execute(sql`UPDATE booking_participants SET payment_status = 'waived' WHERE session_id = ${targetSessionId} AND (payment_status = 'pending' OR payment_status IS NULL)`);
              process.stderr.write(`[Trackman Import]   Created session #${targetSessionId} for auto-approved booking #${approved.id}\n`);
            }
          } catch (sessionErr: unknown) {
            process.stderr.write(`[Trackman Import]   Failed to create session for auto-approved booking #${approved.id}: ${getErrorMessage(sessionErr)}\n`);
          }
        }
        
        if (targetSessionId) {
          try {
            const transferred = await transferRequestParticipantsToSession(
              targetSessionId, approved.request_participants, approved.user_email, `booking #${approved.id}`
            );
            if (transferred > 0) {
              process.stderr.write(`[Trackman Import]   Transferred ${transferred} request_participants to session #${targetSessionId} for booking #${approved.id}\n`);
            }
          } catch (rpErr: unknown) {
            process.stderr.write(`[Trackman Import]   Failed to transfer participants for booking #${approved.id}: ${getErrorMessage(rpErr)}\n`);
          }
        }
      }
    }
  } catch (cleanupErr: unknown) {
    process.stderr.write(`[Trackman Import] Post-import cleanup error: ${getErrorMessage(cleanupErr)}\n`);
  }

  try {
    const pastPaidResult = await db.execute(sql`
      UPDATE booking_participants bp
      SET payment_status = 'paid', paid_at = NOW()
      FROM booking_sessions bs
      WHERE bp.session_id = bs.id
        AND bp.payment_status = 'pending'
        AND COALESCE(bp.cached_fee_cents, 0) > 0
        AND bs.session_date < CURRENT_DATE
        AND bp.user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM booking_fee_snapshots bfs 
          WHERE bfs.session_id = bs.id AND bfs.status IN ('completed', 'paid')
        )
        AND NOT EXISTS (
          SELECT 1 FROM stripe_payment_intents spi 
          JOIN booking_requests br2 ON br2.id = spi.booking_id
          JOIN booking_sessions bs2 ON bs2.trackman_booking_id = br2.trackman_booking_id
          WHERE bs2.id = bp.session_id AND spi.status = 'succeeded'
        )
    `);
    const ghostWaivedResult = await db.execute(sql`
      UPDATE booking_participants bp
      SET payment_status = 'waived'
      FROM booking_sessions bs
      WHERE bp.session_id = bs.id
        AND bp.payment_status = 'pending'
        AND COALESCE(bp.cached_fee_cents, 0) > 0
        AND bp.user_id IS NULL
        AND bp.display_name LIKE '%Unknown%'
    `);
    const pastPaidCount = pastPaidResult.rowCount || 0;
    const ghostWaivedCount = ghostWaivedResult.rowCount || 0;
    if (pastPaidCount > 0 || ghostWaivedCount > 0) {
      process.stderr.write(`[Trackman Import] Post-import fee cleanup: marked ${pastPaidCount} past participants as paid, waived ${ghostWaivedCount} ghost participants\n`);
    }
  } catch (feeCleanupErr: unknown) {
    process.stderr.write(`[Trackman Import] Post-import fee cleanup error: ${getErrorMessage(feeCleanupErr)}\n`);
  }

  await db.insert(trackmanImportRuns).values({
    filename: path.basename(csvPath),
    totalRows: parsedRows.length - 1,
    matchedRows,
    unmatchedRows,
    skippedRows,
    importedBy
  });

  await alertOnTrackmanImportIssues({
    totalRows: parsedRows.length - 1,
    matchedRows,
    unmatchedRows,
    skippedRows,
    errors
  });

  return {
    totalRows: parsedRows.length - 1,
    matchedRows,
    linkedRows,
    unmatchedRows,
    skippedRows,
    skippedAsPrivateEventBlocks,
    removedFromUnmatched,
    cancelledBookings,
    updatedRows,
    errors
  };
}

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
  
  process.stderr.write(`[Trackman Rescan] Starting rescan of ${unmatchedBookings.length} unmatched bookings\n`);
  
  const instructorEmails = await getGolfInstructorEmails();
  process.stderr.write(`[Trackman Rescan] Loaded ${instructorEmails.length} golf instructor emails for lesson detection\n`);
  
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
  
  process.stderr.write(`[Trackman Rescan] Loaded ${membersByEmail.size} members for matching\n`);
  
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
    process.stderr.write(`[Trackman Rescan] Error loading trackman_email mappings: ${getErrorMessage(err)}\n`);
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
        const resourceId = parseInt(booking.bayNumber || '') || null;
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
            
            process.stderr.write(`[Trackman Rescan] Created availability block for lesson: ${userName} on ${bookingDate} ${startTime}-${endTime}\n`);
          } else {
            process.stderr.write(`[Trackman Rescan] Block already exists for lesson: ${userName} on ${bookingDate} ${startTime}-${endTime}\n`);
          }
          
          await db.update(trackmanUnmatchedBookings)
            .set({
              resolvedAt: new Date(),
              resolvedBy: performedBy,
              matchAttemptReason: 'Converted to Availability Block (Lesson)'
            })
            .where(eq(trackmanUnmatchedBookings.id, booking.id));
          
          lessonsConverted++;
          process.stderr.write(`[Trackman Rescan] Converted lesson booking: ${userName} (${originalEmail || 'no email'}) -> Availability Block\n`);
        } else {
          process.stderr.write(`[Trackman Rescan] Skipping lesson ${booking.trackmanBookingId}: missing resource/date/time (bay=${resourceId}, date=${bookingDate}, time=${startTime})\n`);
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
        process.stderr.write(`[Trackman Rescan] Resolved: ${booking.userName} (${originalEmail}) -> ${matchedEmail} (${matchReason})\n`);
        
        try {
          const bookingDate = booking.bookingDate ? new Date(booking.bookingDate).toISOString().split('T')[0] : '';
          const startTime = booking.startTime?.toString() || '';
          const endTime = booking.endTime?.toString() || '';
          const bayId = parseInt(booking.bayNumber || '') || null;
          
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
                process.stderr.write(`[Trackman Rescan] Created booking for ${matchedEmail} (Trackman ID: ${booking.trackmanBookingId})\n`);
              } catch (insertErr: unknown) {
                const errCode = getErrorCode(insertErr);
                const errMessage = getErrorMessage(insertErr) || '';
                const causeCode = (insertErr as { cause?: { code?: string } })?.cause?.code;
                if (errMessage.includes('duplicate key') || errCode === '23505' || causeCode === '23505') {
                  process.stderr.write(`[Trackman Rescan] Booking ${booking.trackmanBookingId} already exists - skipping\n`);
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
                  process.stderr.write(`[Trackman Rescan] Created booking for ${matchedEmail} after clearing overlap (Trackman ID: ${booking.trackmanBookingId})\n`);
                } else {
                  throw insertErr;
                }
              }
            }
          }
        } catch (bookingError: unknown) {
          process.stderr.write(`[Trackman Rescan] Error creating booking: ${getErrorMessage(bookingError)}\n`);
        }
      }
    } catch (err: unknown) {
      errors.push(`Error processing booking ${booking.trackmanBookingId}: ${(err instanceof Error && err.cause instanceof Error ? err.cause.message : null) || getErrorMessage(err)}`);
    }
  }
  
  process.stderr.write(`[Trackman Rescan] Completed: scanned ${unmatchedBookings.length}, matched ${matchedCount}, lessons converted ${lessonsConverted}\n`);
  
  return {
    scanned: unmatchedBookings.length,
    matched: matchedCount,
    lessonsConverted,
    resolved,
    errors
  };
}
