import { db } from '../../db';
import { bookingRequests, bookingParticipants, guests as guestsTable, participantTypeEnum, users } from '../../../shared/schema';
import { eq, sql, inArray } from 'drizzle-orm';
import { getErrorMessage } from '../../utils/errorUtils';
import { getTodayPacific } from '../../utils/dateUtils';
import { getMemberTierByEmail } from '../tierService';
import { ensureSessionForBooking, createSession, recordUsage, ParticipantInput, createOrFindGuest } from '../bookingService/sessionManager';
import { calculateFullSessionBilling, Participant } from '../bookingService/usageCalculator';
import { recalculateSessionFees } from '../billing/unifiedFeeService';
import { upsertVisitor } from '../visitors/matchingService';
import { logger } from '../logger';
import type { SessionCreationInput } from './constants';
import { resolveEmail, getUserIdByEmail, isEmailLinkedToUser } from './matching';

export async function transferRequestParticipantsToSession(
  sessionId: number,
  requestParticipants: unknown,
  ownerEmail: string,
  logContext: string
): Promise<number> {
  const rpArray = Array.isArray(requestParticipants)
    ? requestParticipants as Array<{ type: string; email?: string; name?: string; userId?: string }>
    : [];
  if (rpArray.length === 0) return 0;

  const existingParts = await db.execute(sql`SELECT bp.user_id, u.email AS user_email, bp.display_name, bp.participant_type FROM booking_participants bp LEFT JOIN users u ON bp.user_id = u.id WHERE bp.session_id = ${sessionId}`);
  const existingRows = existingParts.rows as Array<{ user_id: string | null; user_email: string | null; display_name: string | null; participant_type: string }>;
  const existingUserIds = new Set(existingRows.filter(r => r.user_id).map(r => r.user_id!));
  const existingEmails = new Set(existingRows.filter(r => r.user_email).map(r => r.user_email!.toLowerCase()));
  const existingGuestNames = new Set(existingRows.filter(r => r.participant_type === 'guest' && r.display_name).map(r => r.display_name!.toLowerCase()));
  const ownerEmailLower = ownerEmail.toLowerCase();
  existingEmails.add(ownerEmailLower);

  let participantsAdded = 0;
  for (const rp of rpArray) {
    if (!rp || typeof rp !== 'object') continue;

    if (rp.type === 'guest') {
      const guestName = rp.name || 'Guest';
      if (!existingGuestNames.has(guestName.toLowerCase())) {
        let guestId: number | null = null;
        if (rp.email) {
          try {
            guestId = await createOrFindGuest(guestName, rp.email, undefined, ownerEmail);
          } catch (guestErr) {
            logger.error('[Participant Transfer] Non-blocking guest record creation failed', {
              extra: { email: rp.email, error: getErrorMessage(guestErr) }
            });
          }
          const nameParts = guestName.trim().split(/\s+/);
          const firstName = nameParts[0] || undefined;
          const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;
          upsertVisitor({ email: rp.email.toLowerCase().trim(), firstName, lastName }, false)
            .then(v => logger.info('[Participant Transfer] Visitor record ensured for guest', { extra: { email: rp.email, visitorUserId: v.id, sessionId } }))
            .catch(err => logger.error('[Participant Transfer] Non-blocking visitor upsert failed', { extra: { email: rp.email, error: getErrorMessage(err) } }));
        }
        const guestPaymentStatus = guestId ? 'pending' : 'waived';
        await db.execute(sql`INSERT INTO booking_participants 
           (session_id, guest_id, display_name, participant_type, payment_status, created_at)
           VALUES (${sessionId}, ${guestId}, ${guestName}, 'guest', ${guestPaymentStatus}, NOW())`);
        if (guestId) {
          logger.info('[Participant Transfer] Auto-linked real guest participant set to pending for fee calculation', {
            extra: { sessionId, guestId, guestName, context: logContext }
          });
        }
        existingGuestNames.add(guestName.toLowerCase());
        participantsAdded++;
      }
    } else {
      const rpEmail = rp.email?.toLowerCase()?.trim() || '';
      if (rpEmail && rpEmail === ownerEmailLower) continue;

      let rpUserRow: { id: string; email: string; first_name: string; last_name: string } | undefined;
      if (rp.email) {
        const rpUser = await db.execute(sql`SELECT id, email, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${rp.email}) LIMIT 1`);
        rpUserRow = rpUser.rows[0] as typeof rpUserRow;
      } else if (rp.userId) {
        const rpUser = await db.execute(sql`SELECT id, email, first_name, last_name FROM users WHERE id = ${rp.userId} LIMIT 1`);
        rpUserRow = rpUser.rows[0] as typeof rpUserRow;
      }

      if (rpUserRow) {
        if (existingUserIds.has(rpUserRow.id)) continue;
        if (existingEmails.has(rpUserRow.email.toLowerCase())) continue;

        const rpDisplayName = [rpUserRow.first_name, rpUserRow.last_name].filter(Boolean).join(' ') || rpUserRow.email;
        await db.execute(sql`INSERT INTO booking_participants 
           (session_id, user_id, display_name, participant_type, payment_status, created_at)
           VALUES (${sessionId}, ${rpUserRow.id}, ${rpDisplayName}, 'member', 'pending', NOW())`);
        logger.info('[Participant Transfer] Auto-linked real member participant set to pending for fee calculation', {
          extra: { sessionId, userId: rpUserRow.id, displayName: rpDisplayName, context: logContext }
        });
        existingUserIds.add(rpUserRow.id);
        existingEmails.add(rpUserRow.email.toLowerCase());
        participantsAdded++;
      }
    }
  }

  if (participantsAdded > 0) {
    logger.info(`[Participant Transfer] Transferred request_participants to session`, {
      extra: { sessionId, participantsAdded, totalRequested: rpArray.length, context: logContext }
    });
  }
  return participantsAdded;
}

export async function createTrackmanSessionAndParticipants(input: SessionCreationInput): Promise<void> {
  try {
    let resolvedOwnerName = input.ownerName;
    try {
    const participantInputs: ParticipantInput[] = [];
    const memberData: { userId: string; tier: string | null; email?: string }[] = [];
    
    const ownerUserId = await getUserIdByEmail(input.ownerEmail);
    const ownerTier = await getMemberTierByEmail(input.ownerEmail) || null;
    
    resolvedOwnerName = input.ownerName;
    if ((!resolvedOwnerName || resolvedOwnerName.includes('@')) && ownerUserId) {
      const ownerNameResult = await db.select({ firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, ownerUserId))
        .limit(1);
      if (ownerNameResult.length > 0) {
        const dbName = [ownerNameResult[0].firstName, ownerNameResult[0].lastName].filter(Boolean).join(' ').trim();
        if (dbName) resolvedOwnerName = dbName;
      }
    }
    
    const ownerEmailNormalized = resolveEmail(input.ownerEmail, input.membersByEmail, input.trackmanEmailMapping);
    
    const uniqueMemberCount = input.parsedPlayers.filter(p => {
      if (p.type !== 'member' || !p.email) return false;
      const resolved = resolveEmail(p.email, input.membersByEmail, input.trackmanEmailMapping);
      return resolved !== ownerEmailNormalized;
    }).length;
    const guestCount = input.parsedPlayers.filter(p => p.type === 'guest').length;
    const totalParticipants = 1 + uniqueMemberCount + guestCount;
    const perParticipantMinutes = totalParticipants > 0 
      ? Math.floor(input.durationMinutes / totalParticipants) 
      : input.durationMinutes;
    
    participantInputs.push({
      userId: ownerUserId || undefined,
      participantType: 'owner',
      displayName: resolvedOwnerName || input.ownerEmail,
      slotDuration: perParticipantMinutes
    });
    
    if (ownerUserId) {
      memberData.push({ userId: ownerUserId, tier: ownerTier });
    }
    
    const memberPlayers = input.parsedPlayers.filter(p => p.type === 'member' && p.email);
    for (const member of memberPlayers) {
      if (member.email) {
        const normalizedMemberEmail = resolveEmail(member.email, input.membersByEmail, input.trackmanEmailMapping);
        
        if (normalizedMemberEmail === ownerEmailNormalized) {
          continue;
        }
        
        const memberUserId = await getUserIdByEmail(normalizedMemberEmail);
        
        if (memberUserId && ownerUserId && memberUserId === ownerUserId) {
          continue;
        }
        
        const isLinkedToOwner = await isEmailLinkedToUser(member.email, input.ownerEmail);
        if (isLinkedToOwner) {
          continue;
        }
        
        if (!memberUserId && member.email) {
          logger.info('[TrackmanImport] Participant has no user match, adding as guest-type', { extra: { name: member.name, email: member.email } });
        }
        
        if (!memberUserId) {
          let guestId: number | undefined;
          const guestName = member.name || normalizedMemberEmail;
          const existingGuest = await db.select()
            .from(guestsTable)
            .where(sql`LOWER(name) = LOWER(${guestName})`)
            .limit(1);
          
          if (existingGuest.length > 0) {
            guestId = existingGuest[0].id;
          } else {
            const [newGuest] = await db.insert(guestsTable).values({
              name: guestName,
              email: member.email,
              createdByMemberId: input.ownerEmail
            }).returning();
            guestId = newGuest?.id;
          }
          
          participantInputs.push({
            guestId,
            participantType: 'guest',
            displayName: guestName,
            slotDuration: perParticipantMinutes
          });
          logger.info('[TrackmanImport] Unmatched member treated as guest', { extra: { name: guestName, email: member.email } });
          continue;
        }
        
        const memberTier = await getMemberTierByEmail(normalizedMemberEmail) || null;
        
        let memberDisplayName = member.name;
        if ((!memberDisplayName || memberDisplayName.includes('@')) && memberUserId) {
          const mNameResult = await db.select({ firstName: users.firstName, lastName: users.lastName })
            .from(users)
            .where(eq(users.id, memberUserId))
            .limit(1);
          if (mNameResult.length > 0) {
            const dbName = [mNameResult[0].firstName, mNameResult[0].lastName].filter(Boolean).join(' ').trim();
            if (dbName) memberDisplayName = dbName;
          }
        }
        participantInputs.push({
          userId: memberUserId,
          participantType: 'member',
          displayName: memberDisplayName || normalizedMemberEmail,
          slotDuration: perParticipantMinutes
        });
        
        memberData.push({ userId: memberUserId, tier: memberTier, email: normalizedMemberEmail });
      }
    }
    
    const guestPlayers = input.parsedPlayers.filter(p => p.type === 'guest');
    for (const guest of guestPlayers) {
      const ownerDisplayName = (input.ownerName || input.ownerEmail).toLowerCase().trim();
      const guestDisplayName = (guest.name || '').toLowerCase().trim();
      if (guestDisplayName && (
        guestDisplayName === ownerDisplayName ||
        ownerDisplayName.includes(guestDisplayName) ||
        guestDisplayName.includes(ownerDisplayName.split(' ')[0])
      )) {
        logger.info('[TrackmanImport] Skipping guest matching owner name', { extra: { guestName: guest.name, ownerName: input.ownerName || input.ownerEmail } });
        continue;
      }
      
      if (guest.email) {
        const memberByEmail = await getUserIdByEmail(guest.email);
        if (memberByEmail) {
          if (memberByEmail === ownerUserId) {
            logger.info('[TrackmanImport] Skipping guest, email resolves to owner', { extra: { guestName: guest.name } });
            continue;
          }
          
          const memberTier = await getMemberTierByEmail(guest.email) || null;
          let guestAsMemberName = guest.name;
          if ((!guestAsMemberName || guestAsMemberName.includes('@')) && memberByEmail) {
            const gmNameResult = await db.select({ firstName: users.firstName, lastName: users.lastName })
              .from(users)
              .where(eq(users.id, memberByEmail))
              .limit(1);
            if (gmNameResult.length > 0) {
              const dbName = [gmNameResult[0].firstName, gmNameResult[0].lastName].filter(Boolean).join(' ').trim();
              if (dbName) guestAsMemberName = dbName;
            }
          }
          participantInputs.push({
            userId: memberByEmail,
            participantType: 'member',
            displayName: guestAsMemberName || guest.email,
            slotDuration: perParticipantMinutes
          });
          memberData.push({ userId: memberByEmail, tier: memberTier, email: guest.email });
          logger.info('[TrackmanImport] Guest has member email, adding as member', { extra: { guestName: guest.name, email: guest.email } });
          continue;
        }
      }
      
      if (!guest.email) {
        logger.warn('[TrackmanImport] Guest has no email, slot unfilled until email added', { extra: { guestName: guest.name } });
      }
      
      let guestId: number | undefined;
      if (guest.name) {
        const existingGuest = await db.select()
          .from(guestsTable)
          .where(sql`LOWER(name) = LOWER(${guest.name})`)
          .limit(1);
        
        if (existingGuest.length > 0) {
          guestId = existingGuest[0].id;
          if (guest.email && !existingGuest[0].email) {
            await db.update(guestsTable)
              .set({ email: guest.email.toLowerCase() })
              .where(eq(guestsTable.id, existingGuest[0].id));
            logger.info('[TrackmanImport] Updated guest with email', { extra: { guestName: guest.name, email: guest.email } });
          }
        } else {
          const [newGuest] = await db.insert(guestsTable).values({
            name: guest.name,
            email: guest.email,
            createdByMemberId: input.ownerEmail
          }).returning();
          guestId = newGuest?.id;
        }
      }
      
      participantInputs.push({
        guestId,
        participantType: 'guest',
        displayName: guest.name || 'Guest',
        slotDuration: perParticipantMinutes
      });
    }
    
    const sessionResult = await ensureSessionForBooking({
      bookingId: input.bookingId,
      resourceId: input.resourceId,
      sessionDate: input.sessionDate,
      startTime: input.startTime,
      endTime: input.endTime,
      ownerEmail: input.ownerEmail,
      ownerName: input.ownerName,
      ownerUserId: ownerUserId || undefined,
      trackmanBookingId: input.trackmanBookingId,
      source: 'trackman_import',
      createdBy: 'trackman_import'
    });

    if (sessionResult.error) {
      throw new Error(`ensureSessionForBooking failed: ${sessionResult.error}`);
    }

    const sessionId = sessionResult.sessionId;

    const nonOwnerParticipants = participantInputs.filter(p => p.participantType !== 'owner');
    let participants: { id: number; participantType: string; userId?: string | null; guestId?: number | null; displayName?: string }[] = [];

    const existingParticipants = await db.execute(sql`SELECT id, participant_type, user_id, guest_id, display_name FROM booking_participants WHERE session_id = ${sessionId}`);
    participants = existingParticipants.rows.map(r => ({ id: r.id as number, participantType: r.participant_type as string, userId: r.user_id as string | null, guestId: r.guest_id as number | null, displayName: r.display_name as string }));

    for (const p of nonOwnerParticipants) {
      const alreadyExists = participants.some(ep =>
        (p.userId && ep.userId === p.userId) ||
        (p.guestId && ep.guestId === p.guestId)
      );
      if (!alreadyExists) {
        const [newP] = await db.insert(bookingParticipants).values({
          sessionId,
          userId: p.userId || null,
          guestId: p.guestId || null,
          participantType: p.participantType as typeof participantTypeEnum.enumValues[number],
          displayName: p.displayName || 'Unknown',
          slotDuration: p.slotDuration || null
        }).returning();
        participants.push({ id: newP.id, participantType: newP.participantType, userId: newP.userId, guestId: newP.guestId, displayName: newP.displayName || undefined });
      }
    }

    const session = { id: sessionId };

    await db.update(bookingRequests)
      .set({ sessionId: session.id })
      .where(eq(bookingRequests.id, input.bookingId));

    if (participants.length > 0) {
      const ghostIds = participants.filter(p => !p.userId && !p.guestId).map(p => p.id);
      const realIds = participants.filter(p => p.userId || p.guestId).map(p => p.id);
      if (ghostIds.length > 0) {
        await db.execute(sql`
          UPDATE booking_participants 
          SET payment_status = 'waived'
          WHERE id IN (${sql.join(ghostIds.map(id => sql`${id}`), sql`, `)})
        `);
      }
      if (realIds.length > 0) {
        await db.execute(sql`
          UPDATE booking_participants 
          SET payment_status = 'pending'
          WHERE id IN (${sql.join(realIds.map(id => sql`${id}`), sql`, `)})
        `);
        logger.info('[TrackmanImport] Real member/guest participants set to pending for fee collection', {
          extra: { sessionId: session.id, realParticipantCount: realIds.length, ghostCount: ghostIds.length }
        });
      }
    }

    const billingParticipants: Participant[] = [];
    
    const allBillingUserIds = [ownerUserId, ...memberData.map(md => md.userId)].filter(Boolean) as string[];
    const billingNameMap = new Map<string, string>();
    if (allBillingUserIds.length > 0) {
      const nameResults = await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(inArray(users.id, allBillingUserIds));
      for (const row of nameResults) {
        const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
        if (fullName) billingNameMap.set(row.id, fullName);
      }
    }
    
    const ownerDisplayName = (input.ownerName && !input.ownerName.includes('@'))
      ? input.ownerName
      : (ownerUserId && billingNameMap.get(ownerUserId)) || input.ownerName || input.ownerEmail;
    billingParticipants.push({
      userId: ownerUserId || undefined,
      email: input.ownerEmail,
      participantType: 'owner',
      displayName: ownerDisplayName
    });
    
    for (const md of memberData) {
      const memberParticipant = participantInputs.find(p => p.userId === md.userId);
      const resolvedName = billingNameMap.get(md.userId);
      billingParticipants.push({
        userId: md.userId,
        email: md.email || '',
        participantType: 'member',
        displayName: (memberParticipant?.displayName && !memberParticipant.displayName.includes('@'))
          ? memberParticipant.displayName
          : resolvedName || md.email || ''
      });
    }
    
    const guestInputs = participantInputs.filter(p => p.participantType === 'guest');
    for (const g of guestInputs) {
      billingParticipants.push({
        guestId: g.guestId,
        participantType: 'guest',
        displayName: g.displayName
      });
    }
    
    const billingResult = await calculateFullSessionBilling(
      input.sessionDate,
      input.durationMinutes,
      billingParticipants,
      input.ownerEmail
    );

    for (const md of memberData) {
      const memberBilling = billingResult.billingBreakdown.find(
        b => b.userId === md.userId || (md.email && b.email?.toLowerCase() === md.email.toLowerCase())
      );
      
      await recordUsage(
        session.id,
        {
          memberId: md.userId,
          minutesCharged: memberBilling?.minutesAllocated ?? perParticipantMinutes,
          overageFee: memberBilling?.overageFee ?? 0,
          guestFee: 0,
          tierAtBooking: md.tier,
          paymentMethod: input.isPast ? 'credit_card' : 'unpaid'
        },
        'trackman_import'
      );
    }
    
    if (ownerUserId) {
      const ownerBilling = billingResult.billingBreakdown.find(b => b.participantType === 'owner');
      await recordUsage(
        session.id,
        {
          memberId: ownerUserId,
          minutesCharged: ownerBilling?.minutesAllocated ?? perParticipantMinutes,
          overageFee: ownerBilling?.overageFee ?? 0,
          guestFee: billingResult.totalGuestFees,
          tierAtBooking: ownerTier,
          paymentMethod: input.isPast ? 'credit_card' : 'unpaid'
        },
        'trackman_import'
      );
    }

    for (const billing of billingResult.billingBreakdown) {
      const matchingParticipant = participants.find(p => {
        if (billing.userId && p.userId === billing.userId) return true;
        if (billing.guestId && p.guestId === billing.guestId) return true;
        if (billing.participantType === 'owner' && p.participantType === 'owner') return true;
        return false;
      });
      if (matchingParticipant) {
        const feeCents = Math.round(billing.totalFee * 100);
        await db.execute(sql`
          UPDATE booking_participants 
          SET cached_fee_cents = ${feeCents}
          WHERE id = ${matchingParticipant.id}
        `);
      }
    }
    
    if (billingResult.totalFees > 0) {
      logger.info('[TrackmanImport] Session billing computed', { extra: { sessionId: session.id, overageFees: billingResult.totalOverageFees, guestFees: billingResult.totalGuestFees } });
    }

    logger.info('[TrackmanImport] Created session with participants', { extra: { sessionId: session.id, participantCount: participants.length, trackmanBookingId: input.trackmanBookingId } });
    } catch (innerError: unknown) {
      logger.error('[TrackmanImport] Full session creation failed, falling back to owner-only', { extra: { bookingId: input.bookingId }, error: getErrorMessage(innerError) });

      try {
        const fallbackOwnerUserId = await getUserIdByEmail(input.ownerEmail);

        const { session: fallbackSession } = await createSession(
          {
            resourceId: input.resourceId,
            sessionDate: input.sessionDate,
            startTime: input.startTime,
            endTime: input.endTime,
            trackmanBookingId: input.trackmanBookingId,
            createdBy: 'trackman_import_fallback'
          },
          [{
            userId: fallbackOwnerUserId || undefined,
            participantType: 'owner',
            displayName: resolvedOwnerName || input.ownerEmail,
            slotDuration: input.durationMinutes
          }],
          'trackman_import'
        );

        await db.update(bookingRequests)
          .set({ sessionId: fallbackSession.id })
          .where(eq(bookingRequests.id, input.bookingId));

        await db.execute(sql`UPDATE booking_participants SET payment_status = 'waived' WHERE session_id = ${fallbackSession.id} AND user_id IS NULL AND guest_id IS NULL`);
        await db.execute(sql`UPDATE booking_participants SET payment_status = 'pending' WHERE session_id = ${fallbackSession.id} AND (user_id IS NOT NULL OR guest_id IS NOT NULL)`);
        logger.info('[TrackmanImport] Fallback session: real participants set to pending, ghosts waived', {
          extra: { sessionId: fallbackSession.id, bookingId: input.bookingId }
        });
        try {
          await recalculateSessionFees(fallbackSession.id, 'trackman_import');
        } catch (feeErr: unknown) {
          logger.error('[TrackmanImport] Failed to recalculate fees for fallback session', {
            extra: { sessionId: fallbackSession.id, bookingId: input.bookingId },
            error: getErrorMessage(feeErr)
          });
        }

        const [bookingForNote] = await db.select({ staffNotes: bookingRequests.staffNotes })
          .from(bookingRequests)
          .where(eq(bookingRequests.id, input.bookingId));
        const existingNotes = bookingForNote?.staffNotes || '';
        const failureNote = `[SESSION_PARTIAL] Owner-only session created (${getTodayPacific()}). Additional participants may need to be added manually.`;
        const updatedNotes = existingNotes ? `${existingNotes}\n${failureNote}` : failureNote;
        await db.update(bookingRequests)
          .set({ staffNotes: updatedNotes })
          .where(eq(bookingRequests.id, input.bookingId));

        logger.info('[TrackmanImport] Fallback owner-only session created', { extra: { sessionId: fallbackSession.id, bookingId: input.bookingId } });
      } catch (fallbackError: unknown) {
        logger.error('[TrackmanImport] CRITICAL: Fallback session creation also failed', { extra: { bookingId: input.bookingId }, error: getErrorMessage(fallbackError) });
        try {
          const [bookingForCriticalNote] = await db.select({ staffNotes: bookingRequests.staffNotes })
            .from(bookingRequests)
            .where(eq(bookingRequests.id, input.bookingId));
          const existingCriticalNotes = bookingForCriticalNote?.staffNotes || '';
          const criticalNote = `[SESSION_CREATION_FAILED] Auto session failed (${getTodayPacific()}). Please create a session manually.`;
          const updatedCriticalNotes = existingCriticalNotes ? `${existingCriticalNotes}\n${criticalNote}` : criticalNote;
          await db.update(bookingRequests)
            .set({ staffNotes: updatedCriticalNotes })
            .where(eq(bookingRequests.id, input.bookingId));
        } catch (noteErr: unknown) { logger.warn('[TrackmanImport] Failed to save session creation failure note:', { error: getErrorMessage(noteErr) || noteErr }); }
      }
    }
  } catch (outerError: unknown) {
    logger.error('[TrackmanImport] Unexpected error in session creation', { extra: { bookingId: input.bookingId }, error: getErrorMessage(outerError) });
  }
}
