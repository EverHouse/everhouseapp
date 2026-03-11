import { logger } from '../../core/logger';
import { Router } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { sendPushNotification } from '../push';
import { getGuestPassesRemaining, useGuestPass, ensureGuestPassRecord } from '../guestPasses';
import { getMemberTierByEmail, getTierLimits } from '../../core/tierService';
import { computeFeeBreakdown, recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { logFromRequest } from '../../core/auditLog';

import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { PRICING, isPlaceholderGuestName } from '../../core/billing/pricingConfig';
import { refundGuestPassForParticipant } from '../../core/billing/guestPassConsumer';
import { getErrorMessage } from '../../utils/errorUtils';
import { createPacificDate } from '../../utils/dateUtils';
import { broadcastBookingRosterUpdate } from '../../core/websocket';

interface DbRow {
  [key: string]: unknown;
}

const router = Router();

router.get('/api/admin/booking/:id/members', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const bookingResult = await db.execute(sql`SELECT br.guest_count, br.trackman_player_count, br.declared_player_count, br.resource_id, br.user_email as owner_email,
              br.user_name as owner_name, br.duration_minutes, br.request_date, br.session_id, br.status,
              br.user_id as owner_user_id,
              br.notes, br.staff_notes, br.trackman_customer_notes,
              br.request_participants,
              r.capacity as resource_capacity,
              r.type as resource_type,
              EXTRACT(EPOCH FROM (bs.end_time - bs.start_time)) / 60 as session_duration_minutes
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       LEFT JOIN booking_sessions bs ON br.session_id = bs.id
       WHERE br.id = ${id}`);
    
    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const legacyGuestCount = (bookingResult.rows[0] as DbRow)?.guest_count || 0;
    const trackmanPlayerCount = (bookingResult.rows[0] as DbRow)?.trackman_player_count;
    const declaredPlayerCount = (bookingResult.rows[0] as DbRow)?.declared_player_count;
    const resourceCapacity = (bookingResult.rows[0] as DbRow)?.resource_capacity || null;
    const ownerEmail = (bookingResult.rows[0] as DbRow)?.owner_email;
    const ownerName = (bookingResult.rows[0] as DbRow)?.owner_name;
    const sessionId = (bookingResult.rows[0] as DbRow)?.session_id || null;
    const ownerUserId = (bookingResult.rows[0] as DbRow)?.owner_user_id || null;
    let resolvedOwnerUserId = ownerUserId;
    if (!resolvedOwnerUserId && ownerEmail && !String(ownerEmail).includes('unmatched') && !String(ownerEmail).includes('@trackman.import')) {
      const userLookup = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${ownerEmail}) LIMIT 1`);
      if (userLookup.rows.length > 0) {
        resolvedOwnerUserId = (userLookup.rows[0] as DbRow).id;
      }
    }
    const sessionDurationMinutes = (bookingResult.rows[0] as DbRow)?.session_duration_minutes;
    const bookingDuration = (bookingResult.rows[0] as DbRow)?.duration_minutes || 60;
    const durationMinutes = Math.max(bookingDuration as number, Number(sessionDurationMinutes) || 0);
    const requestDate = (bookingResult.rows[0] as DbRow)?.request_date;
    const bookingStatus = (bookingResult.rows[0] as DbRow)?.status;
    
    let ownerTier: string | null = null;
    let ownerTierLimits: Awaited<ReturnType<typeof getTierLimits>> | null = null;
    let ownerGuestPassesRemaining = 0;
    
    if (ownerEmail && !String(ownerEmail).includes('unmatched')) {
      ownerTier = await getMemberTierByEmail(ownerEmail as string);
      if (ownerTier) {
        ownerTierLimits = await getTierLimits(ownerTier);
      }
      ownerGuestPassesRemaining = await getGuestPassesRemaining(ownerEmail as string, ownerTier || undefined);
    }
    
    const targetPlayerCount = declaredPlayerCount || trackmanPlayerCount || 1;
    const isUnmatchedOwner = !ownerEmail || String(ownerEmail).includes('unmatched@') || String(ownerEmail).includes('@trackman.import');
    const bookingData = bookingResult.rows[0] as DbRow;
    const bookingId = parseInt(id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const staffEmailsResult = await db.execute(sql`SELECT LOWER(email) as email FROM staff_users WHERE is_active = true`);
    const staffEmailSet = new Set(staffEmailsResult.rows.map((r: DbRow) => r.email));

    type FeeBreakdownObj = {
      perPersonMins: number;
      dailyAllowance: number;
      usedToday: number;
      overageMinutes: number;
      fee: number;
      isUnlimited: boolean;
      isSocialTier: boolean;
    } | null;

    type MemberWithFees = {
      id: number;
      bookingId: number;
      userEmail: string | null;
      slotNumber: number;
      isPrimary: boolean;
      linkedAt: string | null;
      linkedBy: string | null;
      memberName: string;
      tier: string | null;
      fee: number;
      feeNote: string;
      feeBreakdown: FeeBreakdownObj;
      membershipStatus: string | null;
      isInactiveMember: boolean;
      isStaff: boolean;
      guestInfo: Record<string, unknown> | null;
      participantId?: number;
    };

    type GuestWithFees = {
      id: number;
      bookingId: number;
      guestName: string;
      guestEmail: string | null;
      slotNumber: number;
      fee: number;
      feeNote: string;
      usedGuestPass: boolean;
    };

    let membersWithFees: MemberWithFees[] = [];
    const guestsWithFees: GuestWithFees[] = [];
    let expectedPlayerCount: number;
    let totalMemberSlots: number;
    let filledMemberSlots: number;
    let effectiveGuestCount: number;
    let actualPlayerCount: number;
    let playerCountMismatch: boolean;
    let perPersonMins: number;
    let participantsCount = 0;
    let guestPassesUsedThisBooking = 0;
    let guestPassesRemainingAfterBooking = ownerGuestPassesRemaining;
    let feeBreakdownResult: Awaited<ReturnType<typeof computeFeeBreakdown>>;

    function generateFeeNote(lineItem: Awaited<ReturnType<typeof computeFeeBreakdown>>['participants'][0], membershipStatus: string | null, isPrimary: boolean): string {
      const fee = lineItem.totalCents / 100;
      const hasActiveMembership = membershipStatus && ['active', 'trialing', 'past_due'].includes(membershipStatus);

      if (lineItem.isStaff) return 'Staff — included';

      if (!hasActiveMembership) {
        const statusLabel = membershipStatus || 'non-member';
        return isPrimary
          ? `${statusLabel} — $${fee} (no membership benefits)`
          : `${statusLabel} — $${fee} charged to host`;
      }

      const dailyAllowance = lineItem.dailyAllowance || 0;
      const isUnlimited = dailyAllowance >= 999;
      const isSocialTier = lineItem.tierName?.toLowerCase() === 'social';

      if (isUnlimited) return 'Included in membership';
      if (isSocialTier) return fee > 0 ? `Social tier - $${fee} (${lineItem.minutesAllocated} min)` : 'Included';
      if (lineItem.tierName) {
        if (dailyAllowance > 0) return fee > 0 ? `${lineItem.tierName} - $${fee} (overage)` : 'Included in membership';
        return `Pay-as-you-go - $${fee}`;
      }
      return `No tier assigned — $${fee}`;
    }

    if (sessionId) {
      const bpResult = await db.execute(sql`SELECT bp.id, bp.participant_type, bp.display_name, bp.user_id, bp.guest_id,
               bp.payment_status, bp.cached_fee_cents, bp.used_guest_pass, bp.created_at, bp.slot_duration,
               u.first_name, u.last_name, u.email as user_email, u.tier as user_tier, u.membership_status,
               g.name as guest_name_from_table, g.email as guest_email_from_table, g.phone as guest_phone
        FROM booking_participants bp
        LEFT JOIN users u ON u.id = bp.user_id
        LEFT JOIN guests g ON g.id = bp.guest_id
        WHERE bp.session_id = ${sessionId}
        ORDER BY
          CASE bp.participant_type
            WHEN 'owner' THEN 0
            WHEN 'member' THEN 1
            WHEN 'guest' THEN 2
          END,
          bp.created_at`);

      participantsCount = bpResult.rows.length;

      const ownerParticipants = (bpResult.rows as DbRow[]).filter(r => r.participant_type === 'owner');
      const memberParticipants = (bpResult.rows as DbRow[]).filter(r => r.participant_type === 'member');
      const guestParticipants = (bpResult.rows as DbRow[]).filter(r => r.participant_type === 'guest');

      if (declaredPlayerCount && Number(declaredPlayerCount) > 0) {
        expectedPlayerCount = declaredPlayerCount as number;
      } else if (trackmanPlayerCount && Number(trackmanPlayerCount) > 0) {
        expectedPlayerCount = trackmanPlayerCount as number;
      } else if (participantsCount > 0) {
        expectedPlayerCount = participantsCount;
      } else {
        expectedPlayerCount = Math.max(Number(legacyGuestCount) + 1, 1);
      }

      if (resourceCapacity && Number(resourceCapacity) > 0) {
        expectedPlayerCount = Math.min(expectedPlayerCount, resourceCapacity as number);
      }

      try {
        feeBreakdownResult = await computeFeeBreakdown({
          sessionId: sessionId as number,
          bookingId,
          declaredPlayerCount: expectedPlayerCount,
          source: 'preview',
          isConferenceRoom: bookingData.resource_type === 'conference_room',
          excludeSessionFromUsage: true
        });
      } catch (feeErr) {
        logger.warn('computeFeeBreakdown failed for booking members, using fallback', { extra: { bookingId, sessionId, error: feeErr instanceof Error ? feeErr.message : String(feeErr) } });
        feeBreakdownResult = { totals: { totalCents: 0, overageCents: 0, guestCents: 0, guestPassesUsed: 0, guestPassesAvailable: 0 }, participants: [], metadata: { effectivePlayerCount: expectedPlayerCount, declaredPlayerCount: expectedPlayerCount, actualPlayerCount: 0, sessionDuration: durationMinutes as number, sessionDate: String(requestDate || ''), source: 'preview' } };
      }

      const feeByParticipantId = new Map<number, typeof feeBreakdownResult.participants[0]>();
      for (const li of feeBreakdownResult.participants) {
        if (li.participantId) feeByParticipantId.set(li.participantId, li);
      }
      const ownerFeeLineItems = feeBreakdownResult.participants.filter(li => li.participantType === 'owner');

      let slotNumber = 1;

      for (const row of ownerParticipants) {
        const email = row.user_email ? String(row.user_email).toLowerCase() : null;
        const isStaffUser = email ? staffEmailSet.has(email) : false;
        const membershipStatus = (row.membership_status as string) || null;
        const hasActiveMembership = membershipStatus && ['active', 'trialing', 'past_due'].includes(membershipStatus);

        let memberName = 'Empty Slot';
        if (row.first_name && row.last_name) {
          memberName = `${row.first_name} ${row.last_name}`;
        } else if (row.display_name && !String(row.display_name).includes('@')) {
          memberName = row.display_name as string;
        } else if (ownerName) {
          memberName = ownerName as string;
        } else if (email) {
          memberName = email;
        }

        let tier: string | null = null;
        let fee = 0;
        let feeNote = '';
        let feeBreakdownObj: FeeBreakdownObj = null;

        const lineItem = feeByParticipantId.get(row.id as number) || ownerFeeLineItems[0];
        if (lineItem) {
          fee = lineItem.totalCents / 100;
          tier = lineItem.isStaff ? 'Staff' : (lineItem.tierName || null);
          feeNote = generateFeeNote(lineItem, membershipStatus, true);
          const da = lineItem.dailyAllowance || 0;
          const om = lineItem.overageCents > 0
            ? Math.ceil((lineItem.overageCents / 100) / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES
            : 0;
          feeBreakdownObj = {
            perPersonMins: lineItem.minutesAllocated,
            dailyAllowance: da,
            usedToday: lineItem.usedMinutesToday || 0,
            overageMinutes: om,
            fee,
            isUnlimited: lineItem.isStaff ? true : da >= 999,
            isSocialTier: lineItem.tierName?.toLowerCase() === 'social'
          };
        }

        membersWithFees.push({
          id: row.id as number,
          bookingId,
          userEmail: email,
          slotNumber: slotNumber,
          isPrimary: true,
          linkedAt: null,
          linkedBy: null,
          memberName,
          tier,
          fee,
          feeNote,
          feeBreakdown: feeBreakdownObj,
          membershipStatus,
          isInactiveMember: false,
          isStaff: isStaffUser,
          guestInfo: null,
          participantId: row.id as number
        });
        slotNumber++;
      }

      if (ownerParticipants.length === 0) {
        slotNumber = 2;
      }

      for (const row of memberParticipants) {
        const email = row.user_email ? String(row.user_email).toLowerCase() : null;
        const isStaffUser = email ? staffEmailSet.has(email) : false;
        const membershipStatus = (row.membership_status as string) || null;
        const hasActiveMembership = membershipStatus && ['active', 'trialing', 'past_due'].includes(membershipStatus);

        let memberName = 'Empty Slot';
        if (row.first_name && row.last_name) {
          memberName = `${row.first_name} ${row.last_name}`;
        } else if (row.display_name && !String(row.display_name).includes('@')) {
          memberName = row.display_name as string;
        } else if (email) {
          memberName = email;
        }

        let tier: string | null = null;
        let fee = 0;
        let feeNote = '';
        let feeBreakdownObj: FeeBreakdownObj = null;

        const lineItem = feeByParticipantId.get(row.id as number);
        if (lineItem) {
          fee = lineItem.totalCents / 100;
          tier = lineItem.isStaff ? 'Staff' : (lineItem.tierName || null);
          feeNote = generateFeeNote(lineItem, membershipStatus, false);
          const da = lineItem.dailyAllowance || 0;
          const om = lineItem.overageCents > 0
            ? Math.ceil((lineItem.overageCents / 100) / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES
            : 0;
          feeBreakdownObj = {
            perPersonMins: lineItem.minutesAllocated,
            dailyAllowance: da,
            usedToday: lineItem.usedMinutesToday || 0,
            overageMinutes: om,
            fee,
            isUnlimited: lineItem.isStaff ? true : da >= 999,
            isSocialTier: lineItem.tierName?.toLowerCase() === 'social'
          };
        } else {
          fee = PRICING.GUEST_FEE_DOLLARS;
          feeNote = `Pending assignment - $${PRICING.GUEST_FEE_DOLLARS}`;
        }

        const isInactiveMember = !hasActiveMembership && !!email && !isStaffUser;

        membersWithFees.push({
          id: row.id as number,
          bookingId,
          userEmail: email,
          slotNumber: slotNumber,
          isPrimary: false,
          linkedAt: null,
          linkedBy: null,
          memberName,
          tier,
          fee,
          feeNote,
          feeBreakdown: feeBreakdownObj,
          membershipStatus,
          isInactiveMember,
          isStaff: isStaffUser,
          guestInfo: null,
          participantId: row.id as number
        });
        slotNumber++;
      }

      for (const row of guestParticipants) {
        const guestName = row.display_name
          ? (row.display_name as string)
          : (row.guest_name_from_table as string) || 'Guest';
        const guestEmail = (row.guest_email_from_table as string) || null;
        const lineItem = feeByParticipantId.get(row.id as number);
        const usedPass = (row.used_guest_pass as boolean) || false;

        let gFee = PRICING.GUEST_FEE_DOLLARS;
        let gFeeNote = `No passes - $${PRICING.GUEST_FEE_DOLLARS} due`;
        if (lineItem) {
          if (lineItem.guestPassUsed || usedPass) {
            gFee = 0;
            gFeeNote = 'Guest Pass Used';
          } else {
            gFee = lineItem.guestCents / 100;
            gFeeNote = gFee > 0 ? `No passes - $${gFee} due` : 'No charge';
          }
        } else if (usedPass) {
          gFee = 0;
          gFeeNote = 'Guest Pass Used';
        }

        const emptySlot = membersWithFees.find(m => !m.userEmail && !m.guestInfo);
        if (emptySlot) {
          emptySlot.guestInfo = {
            guestId: row.id,
            guestName,
            guestEmail,
            fee: gFee,
            feeNote: gFeeNote,
            usedGuestPass: usedPass
          };
          emptySlot.memberName = guestName;
          emptySlot.fee = gFee;
          emptySlot.feeNote = gFeeNote;
        } else if (slotNumber <= expectedPlayerCount) {
          membersWithFees.push({
            id: row.id as number,
            bookingId,
            userEmail: null,
            slotNumber: slotNumber,
            isPrimary: false,
            linkedAt: null,
            linkedBy: null,
            memberName: guestName,
            tier: null,
            fee: gFee,
            feeNote: gFeeNote,
            feeBreakdown: null,
            membershipStatus: null,
            isInactiveMember: false,
            isStaff: false,
            guestInfo: {
              guestId: row.id,
              guestName,
              guestEmail,
              fee: gFee,
              feeNote: gFeeNote,
              usedGuestPass: usedPass
            },
            participantId: row.id as number
          });
          slotNumber++;
        } else {
          guestsWithFees.push({
            id: row.id as number,
            bookingId,
            guestName,
            guestEmail,
            slotNumber: slotNumber,
            fee: gFee,
            feeNote: gFeeNote,
            usedGuestPass: usedPass
          });
          slotNumber++;
        }
      }

      let emptySlotId = -1;
      while (membersWithFees.length < expectedPlayerCount) {
        membersWithFees.push({
          id: emptySlotId,
          bookingId,
          userEmail: null,
          slotNumber: slotNumber,
          isPrimary: false,
          linkedAt: null,
          linkedBy: null,
          memberName: 'Empty Slot',
          tier: null,
          fee: PRICING.GUEST_FEE_DOLLARS,
          feeNote: `Pending assignment - $${PRICING.GUEST_FEE_DOLLARS}`,
          feeBreakdown: null,
          membershipStatus: null,
          isInactiveMember: false,
          isStaff: false,
          guestInfo: null
        });
        emptySlotId--;
        slotNumber++;
      }

      const nonGuestMembers = membersWithFees.filter(m => !m.guestInfo);
      filledMemberSlots = nonGuestMembers.filter(m => m.userEmail).length;
      const guestSlotCount = guestParticipants.length;
      effectiveGuestCount = guestSlotCount;
      totalMemberSlots = membersWithFees.length;
      actualPlayerCount = filledMemberSlots + Number(effectiveGuestCount);
      playerCountMismatch = actualPlayerCount !== expectedPlayerCount;
      perPersonMins = Math.floor(durationMinutes / expectedPlayerCount);
      guestPassesUsedThisBooking = feeBreakdownResult.totals.guestPassesUsed;
      guestPassesRemainingAfterBooking = ownerGuestPassesRemaining - guestPassesUsedThisBooking;

    } else {
      let membersResult = await db.execute(sql`SELECT bp.*, u.first_name, u.last_name, u.email as member_email, u.tier as user_tier, u.membership_status
         FROM booking_participants bp
         INNER JOIN booking_requests br2 ON br2.session_id = bp.session_id
         LEFT JOIN users u ON bp.user_id = u.id
         WHERE br2.id = ${id} AND bp.participant_type IN ('owner', 'member')
         ORDER BY bp.id`);


      const guestsResult = await db.execute(sql`SELECT bp.id, bp.display_name as guest_name, g.email as guest_email, bp.session_id
         FROM booking_participants bp
         INNER JOIN booking_requests br2 ON br2.session_id = bp.session_id
         LEFT JOIN guests g ON g.id = bp.guest_id
         WHERE br2.id = ${id} AND bp.participant_type = 'guest'
         ORDER BY bp.id`);

      const legacyTotalMemberSlots = membersResult.rows.length;
      const actualGuestCount = guestsResult.rows.length;

      if (declaredPlayerCount && Number(declaredPlayerCount) > 0) {
        expectedPlayerCount = declaredPlayerCount as number;
      } else if (trackmanPlayerCount && Number(trackmanPlayerCount) > 0) {
        expectedPlayerCount = trackmanPlayerCount as number;
      } else if (legacyTotalMemberSlots > 0) {
        expectedPlayerCount = legacyTotalMemberSlots + actualGuestCount;
      } else {
        expectedPlayerCount = Math.max(Number(legacyGuestCount) + 1, 1);
      }

      if (resourceCapacity && Number(resourceCapacity) > 0) {
        expectedPlayerCount = Math.min(expectedPlayerCount, resourceCapacity as number);
      }

      effectiveGuestCount = actualGuestCount > 0 ? actualGuestCount : (legacyGuestCount as number);
      filledMemberSlots = membersResult.rows.filter((row: DbRow) => row.user_id).length;
      totalMemberSlots = legacyTotalMemberSlots;
      actualPlayerCount = Number(filledMemberSlots) + Number(effectiveGuestCount);
      playerCountMismatch = actualPlayerCount !== expectedPlayerCount;
      perPersonMins = Math.floor(durationMinutes / expectedPlayerCount);

      const participantsArray: Array<{
        userId?: string;
        email?: string;
        displayName: string;
        participantType: 'owner' | 'member' | 'guest';
      }> = [];
      for (const row of membersResult.rows as DbRow[]) {
        if (row.user_email) {
          participantsArray.push({
            userId: row.user_email as string,
            email: row.user_email as string,
            displayName: row.first_name && row.last_name
              ? `${row.first_name} ${row.last_name}`
              : row.user_email as string,
            participantType: row.is_primary ? 'owner' : 'member'
          });
        }
      }
      for (const row of guestsResult.rows as DbRow[]) {
        participantsArray.push({
          email: (row.guest_email as string) || undefined,
          displayName: (row.guest_name as string) || 'Guest',
          participantType: 'guest'
        });
      }
      if (participantsArray.length === 0 && ownerEmail) {
        participantsArray.push({
          userId: ownerEmail as string,
          email: ownerEmail as string,
          displayName: (ownerName as string) || (ownerEmail as string),
          participantType: 'owner'
        });
      }

      feeBreakdownResult = await computeFeeBreakdown({
        sessionDate: requestDate as string,
        startTime: bookingData.start_time as string,
        sessionDuration: durationMinutes,
        declaredPlayerCount: expectedPlayerCount,
        hostEmail: (ownerEmail as string) || '',
        participants: participantsArray,
        source: 'preview',
        isConferenceRoom: bookingData.resource_type === 'conference_room',
        bookingId
      });

      const ownerLineItems = feeBreakdownResult.participants.filter(li => li.participantType === 'owner');
      const guestLineItems = feeBreakdownResult.participants.filter(li => li.participantType === 'guest');

      const lineItemEmailMap = new Map<string, typeof feeBreakdownResult.participants[0]>();
      for (const li of feeBreakdownResult.participants) {
        if (li.userId) lineItemEmailMap.set(li.userId.toLowerCase(), li);
      }

      function findLineItemForMember(row: DbRow): typeof feeBreakdownResult.participants[0] | undefined {
        const email = String((row.user_email || '')).toLowerCase();
        if (!email) return undefined;
        const mapped = lineItemEmailMap.get(email);
        if (mapped) return mapped;
        if (row.is_primary && ownerLineItems.length > 0) return ownerLineItems[0];
        return undefined;
      }

      membersWithFees = membersResult.rows.map((row: DbRow) => {
        const membershipStatus = row.membership_status || null;
        const hasActiveMembership = membershipStatus && ['active', 'trialing', 'past_due'].includes(membershipStatus as string);
        const isStaffUser = row.user_email ? staffEmailSet.has(String(row.user_email).toLowerCase()) : false;

        let tier: string | null = null;
        let fee = 0;
        let feeNote = '';
        let feeBreakdownObj: FeeBreakdownObj = null;

        if (row.user_email) {
          const lineItem = findLineItemForMember(row);
          if (lineItem) {
            fee = lineItem.totalCents / 100;
            tier = lineItem.isStaff ? 'Staff' : (lineItem.tierName || null);
            feeNote = generateFeeNote(lineItem, membershipStatus as string, row.is_primary as boolean);
            const dailyAllowance = lineItem.dailyAllowance || 0;
            const overageMinutes = lineItem.overageCents > 0
              ? Math.ceil((lineItem.overageCents / 100) / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES
              : 0;
            feeBreakdownObj = {
              perPersonMins: lineItem.minutesAllocated,
              dailyAllowance,
              usedToday: lineItem.usedMinutesToday || 0,
              overageMinutes,
              fee,
              isUnlimited: lineItem.isStaff ? true : dailyAllowance >= 999,
              isSocialTier: lineItem.tierName?.toLowerCase() === 'social'
            };
          } else {
            fee = PRICING.GUEST_FEE_DOLLARS;
            feeNote = `Pending assignment - $${PRICING.GUEST_FEE_DOLLARS}`;
          }
        } else {
          fee = PRICING.GUEST_FEE_DOLLARS;
          feeNote = `Pending assignment - $${PRICING.GUEST_FEE_DOLLARS}`;
        }

        const isInactiveMember = !hasActiveMembership && !!row.user_email && !row.is_primary && !isStaffUser;

        return {
          id: row.id as number,
          bookingId: row.booking_id as number,
          userEmail: row.user_email as string | null,
          slotNumber: row.slot_number as number,
          isPrimary: row.is_primary as boolean,
          linkedAt: row.linked_at as string | null,
          linkedBy: row.linked_by as string | null,
          memberName: row.first_name && row.last_name
            ? `${row.first_name} ${row.last_name}`
            : (row.user_email as string) || 'Empty Slot',
          tier,
          fee,
          feeNote,
          feeBreakdown: feeBreakdownObj,
          membershipStatus: membershipStatus as string | null,
          isInactiveMember: !!isInactiveMember,
          isStaff: isStaffUser,
          guestInfo: null as { name?: string; email?: string } | null
        };
      });

      if (membersWithFees.length === 0 && ownerEmail && !isUnmatchedOwner) {
        const ownerLineItem = feeBreakdownResult.participants.find(li => li.participantType === 'owner');
        const isStaffUser = staffEmailSet.has(String(ownerEmail).toLowerCase());
        let ownerMembershipStatus: string | null = null;
        const ownerUserLookup = await db.execute(sql`SELECT tier, membership_status, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${ownerEmail}) LIMIT 1`);
        let resolvedOwnerName = (ownerName as string) || (ownerEmail as string);
        if (ownerUserLookup.rows.length > 0) {
          const u = ownerUserLookup.rows[0] as DbRow;
          ownerMembershipStatus = (u.membership_status as string) || null;
          if (u.first_name && u.last_name) resolvedOwnerName = `${u.first_name} ${u.last_name}`;
        }

        let ownerFee = 0;
        let ownerFeeNote = '';
        let ownerFeeBreakdown: FeeBreakdownObj = null;
        if (ownerLineItem) {
          ownerFee = ownerLineItem.totalCents / 100;
          ownerFeeNote = generateFeeNote(ownerLineItem, ownerMembershipStatus, true);
          const da = ownerLineItem.dailyAllowance || 0;
          const om = ownerLineItem.overageCents > 0
            ? Math.ceil((ownerLineItem.overageCents / 100) / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES
            : 0;
          ownerFeeBreakdown = {
            perPersonMins: ownerLineItem.minutesAllocated,
            dailyAllowance: da,
            usedToday: ownerLineItem.usedMinutesToday || 0,
            overageMinutes: om,
            fee: ownerFee,
            isUnlimited: isStaffUser ? true : da >= 999,
            isSocialTier: ownerLineItem.tierName?.toLowerCase() === 'social'
          };
        }

        membersWithFees.push({
          id: -100,
          bookingId,
          userEmail: ownerEmail as string,
          slotNumber: 1,
          isPrimary: true,
          linkedAt: null,
          linkedBy: null,
          memberName: resolvedOwnerName,
          tier: isStaffUser ? 'Staff' : (ownerTier || null),
          fee: ownerFee,
          feeNote: ownerFeeNote,
          feeBreakdown: ownerFeeBreakdown,
          membershipStatus: ownerMembershipStatus,
          isInactiveMember: false,
          isStaff: isStaffUser,
          guestInfo: null
        });
      }

      const savedParticipants = (bookingResult.rows[0] as DbRow)?.request_participants;
      const rpArray = Array.isArray(savedParticipants) ? savedParticipants as Array<{ type: string; email?: string; name?: string; userId?: string }> : [];
      if (rpArray.length > 0) {
        let rpSlotNumber = membersWithFees.length > 0
          ? Math.max(...membersWithFees.map(m => m.slotNumber)) + 1
          : 2;
        let rpSlotId = -200;
        for (const rp of rpArray) {
          if (rpSlotNumber > expectedPlayerCount) break;
          if (rp.type === 'member' && rp.email) {
            const rpLookup = await db.execute(sql`SELECT id, first_name, last_name, tier, membership_status FROM users WHERE LOWER(email) = LOWER(${rp.email}) LIMIT 1`);
            const rpUser = (rpLookup.rows as DbRow[])[0];
            const rpName = rpUser
              ? `${rpUser.first_name || ''} ${rpUser.last_name || ''}`.trim() || rp.name || rp.email
              : rp.name || rp.email;
            const rpTier = rpUser ? (rpUser.tier as string || null) : null;
            const rpMembershipStatus = rpUser ? (rpUser.membership_status as string || null) : null;
            const rpIsStaff = staffEmailSet.has(rp.email.toLowerCase());
            membersWithFees.push({
              id: rpSlotId,
              bookingId,
              userEmail: rp.email,
              slotNumber: rpSlotNumber,
              isPrimary: false,
              linkedAt: null,
              linkedBy: null,
              memberName: rpName,
              tier: rpIsStaff ? 'Staff' : rpTier,
              fee: PRICING.GUEST_FEE_DOLLARS,
              feeNote: `$${PRICING.GUEST_FEE_DOLLARS} fee applies`,
              feeBreakdown: null,
              membershipStatus: rpMembershipStatus,
              isInactiveMember: false,
              isStaff: rpIsStaff,
              guestInfo: null
            });
          } else if (rp.type === 'guest') {
            membersWithFees.push({
              id: rpSlotId,
              bookingId,
              userEmail: null,
              slotNumber: rpSlotNumber,
              isPrimary: false,
              linkedAt: null,
              linkedBy: null,
              memberName: rp.name || 'Guest (info pending)',
              tier: null,
              fee: PRICING.GUEST_FEE_DOLLARS,
              feeNote: `$${PRICING.GUEST_FEE_DOLLARS} fee applies`,
              feeBreakdown: null,
              membershipStatus: null,
              isInactiveMember: false,
              isStaff: false,
              guestInfo: {
                guestId: rpSlotId,
                guestName: rp.name || 'Guest (info pending)',
                guestEmail: null,
                fee: PRICING.GUEST_FEE_DOLLARS,
                feeNote: `$${PRICING.GUEST_FEE_DOLLARS} fee applies`,
                usedGuestPass: false
              }
            });
          }
          rpSlotId--;
          rpSlotNumber++;
        }
      }

      let legacySlotNumber = membersWithFees.length > 0
        ? Math.max(...membersWithFees.map(m => m.slotNumber)) + 1
        : (membersWithFees.length === 0 ? 2 : 1);
      let legacyEmptySlotId = -1;
      while (membersWithFees.length < expectedPlayerCount) {
        membersWithFees.push({
          id: legacyEmptySlotId,
          bookingId,
          userEmail: null,
          slotNumber: legacySlotNumber,
          isPrimary: false,
          linkedAt: null,
          linkedBy: null,
          memberName: 'Empty Slot',
          tier: null,
          fee: PRICING.GUEST_FEE_DOLLARS,
          feeNote: `Pending assignment - $${PRICING.GUEST_FEE_DOLLARS}`,
          feeBreakdown: null,
          membershipStatus: null,
          isInactiveMember: false,
          isStaff: false,
          guestInfo: null
        });
        legacyEmptySlotId--;
        legacySlotNumber++;
      }

      filledMemberSlots = membersWithFees.filter(m => !!m.userEmail).length;
      totalMemberSlots = membersWithFees.length;
      actualPlayerCount = filledMemberSlots + Number(effectiveGuestCount);
      playerCountMismatch = actualPlayerCount !== expectedPlayerCount;

      guestPassesUsedThisBooking = feeBreakdownResult.totals.guestPassesUsed;
      guestPassesRemainingAfterBooking = ownerGuestPassesRemaining - guestPassesUsedThisBooking;

      const legacyGuestsWithFees = guestsResult.rows.map((row: DbRow, idx: number) => {
        const lineItem = guestLineItems[idx];
        let fee: number;
        let feeNote: string;
        let usedGuestPass = false;

        if (lineItem) {
          if (lineItem.guestPassUsed) {
            fee = 0;
            feeNote = 'Guest Pass Used';
            usedGuestPass = true;
          } else {
            fee = lineItem.guestCents / 100;
            feeNote = fee > 0 ? `No passes - $${fee} due` : 'No charge';
          }
        } else {
          fee = PRICING.GUEST_FEE_DOLLARS;
          feeNote = `No passes - $${PRICING.GUEST_FEE_DOLLARS} due`;
        }

        return {
          id: row.id as number,
          bookingId: row.booking_id as number,
          guestName: row.guest_name as string,
          guestEmail: row.guest_email as string | null,
          slotNumber: row.slot_number as number,
          fee,
          feeNote,
          usedGuestPass
        };
      });

      for (const g of legacyGuestsWithFees) {
        guestsWithFees.push(g);
      }

      const guestsToRemove: number[] = [];
      for (let i = 0; i < guestsWithFees.length; i++) {
        const guest = guestsWithFees[i];
        const emptySlot = (guest.slotNumber
          ? membersWithFees.find(m => !m.userEmail && !m.guestInfo && m.slotNumber === guest.slotNumber)
          : null) || membersWithFees.find(m => !m.userEmail && !m.guestInfo);
        if (emptySlot) {
          emptySlot.guestInfo = {
            guestId: guest.id,
            guestName: guest.guestName,
            guestEmail: guest.guestEmail,
            fee: guest.fee,
            feeNote: guest.feeNote,
            usedGuestPass: guest.usedGuestPass
          };
          emptySlot.memberName = guest.guestName;
          emptySlot.fee = guest.fee;
          emptySlot.feeNote = guest.feeNote;
          guestsToRemove.push(i);
        }
      }
      for (let i = guestsToRemove.length - 1; i >= 0; i--) {
        guestsWithFees.splice(guestsToRemove[i], 1);
      }
    }
    
    const dailyAllowance = ownerTierLimits?.daily_sim_minutes || 0;
    const isUnlimitedTier = dailyAllowance >= 999 || (ownerTierLimits?.unlimited_access ?? false);
    const allowanceText = isUnlimitedTier 
      ? 'Unlimited simulator access' 
      : dailyAllowance > 0 
        ? `${dailyAllowance} minutes/day included`
        : 'Pay-as-you-go';
    
    let ownerOverageFee = 0;
    let guestFeesWithoutPass = 0;
    let totalPlayersOwe = 0;
    let playerBreakdownFromSession: Array<{ name: string; tier: string | null; fee: number; feeNote: string; membershipStatus?: string | null }> = [];
    
    let hasCompletedFeeSnapshot = false;
    let snapshotTotalCents = 0;
    if (sessionId) {
      const snapshotCheck = await db.execute(sql`SELECT id, total_cents FROM booking_fee_snapshots WHERE session_id = ${sessionId} AND status IN ('completed', 'paid') ORDER BY created_at DESC LIMIT 1`);
      if (snapshotCheck.rows.length > 0) {
        hasCompletedFeeSnapshot = true;
        snapshotTotalCents = parseInt((snapshotCheck.rows[0] as DbRow).total_cents as string) || 0;
      }
    }

    const feeEligibleMembers = membersWithFees.filter(m => Number(m.slotNumber) <= expectedPlayerCount);
    
    if (sessionId) {
      const participantsResult = await db.execute(sql`SELECT 
          bp.id as participant_id,
          bp.display_name,
          bp.participant_type,
          bp.user_id,
          bp.used_guest_pass,
          bp.payment_status,
          bp.cached_fee_cents,
          u.tier as user_tier,
          u.email as user_email,
          u.membership_status
        FROM booking_participants bp
        LEFT JOIN users u ON u.id = bp.user_id
        WHERE bp.session_id = ${sessionId}
        ORDER BY bp.participant_type, bp.created_at`);
      
      if (participantsResult.rows.length > 0) {
        const allParticipantIds = participantsResult.rows.map((p: DbRow) => p.participant_id);
        let breakdown: Awaited<ReturnType<typeof recalculateSessionFees>>;
        try {
          breakdown = await recalculateSessionFees(sessionId as number, 'checkin');
        } catch (feeErr) {
          logger.warn('recalculateSessionFees failed, using cached fees', { extra: { sessionId, error: feeErr instanceof Error ? feeErr.message : String(feeErr) } });
          breakdown = { totals: { totalCents: 0, overageCents: 0, guestCents: 0, guestPassesUsed: 0, guestPassesAvailable: 0 }, participants: [], metadata: { effectivePlayerCount: 1, declaredPlayerCount: 1, actualPlayerCount: 0, sessionDuration: 60, sessionDate: '', source: 'checkin' } };
        }
        
        const feeMap = new Map<number, number>();
        const staffFlagMap = new Map<number, boolean>();
        for (const p of breakdown.participants) {
          if (p.participantId) {
            feeMap.set(p.participantId, p.totalCents / 100);
            if (p.isStaff) staffFlagMap.set(p.participantId, true);
          }
        }
        
        const emailToFeeMap = new Map<string, { fee: number; feeNote: string; isPaid?: boolean; isStaff?: boolean }>();
        
        for (const p of participantsResult.rows as DbRow[]) {
          const participantFee = feeMap.get(p.participant_id as number) || 0;
          const email = String(p.user_email || '').toLowerCase();
          const isPaid = p.payment_status === 'paid' || p.payment_status === 'waived';
          const paidLabel = p.payment_status === 'waived' ? 'Waived' : 'Paid';
          const participantIsStaff = staffFlagMap.get(p.participant_id as number) || false;
          
          if (p.participant_type === 'owner') {
            const ownerStatus = p.membership_status || null;
            const ownerIsInactive = ownerStatus && !['active', 'trialing', 'past_due'].includes(ownerStatus as string);
            ownerOverageFee = ((isPaid && !hasCompletedFeeSnapshot) || participantIsStaff) ? 0 : participantFee;
            if (email) {
              const ownerNote = participantIsStaff ? 'Staff — included'
                : ownerIsInactive ? `${ownerStatus} — $${participantFee} (no membership benefits)`
                : (isPaid ? paidLabel : (participantFee > 0 ? 'Overage fee' : 'Within daily allowance'));
              emailToFeeMap.set(email, {
                fee: participantIsStaff ? 0 : participantFee,
                feeNote: ownerNote,
                isPaid,
                isStaff: participantIsStaff
              });
            }
          } else if (p.participant_type === 'member') {
            const memberStatus = p.membership_status || null;
            const isInactive = !memberStatus || !['active', 'trialing', 'past_due'].includes(memberStatus as string);
            
            if (isInactive && !isPaid && !participantIsStaff && participantFee > 0) {
              ownerOverageFee += participantFee;
            } else if (!isPaid && !participantIsStaff) {
              totalPlayersOwe += participantFee;
            }
            playerBreakdownFromSession.push({
              name: (p.display_name as string) || 'Unknown Member',
              tier: participantIsStaff ? 'Staff' : ((p.user_tier as string) || null),
              fee: (isPaid || participantIsStaff || isInactive) ? 0 : participantFee,
              feeNote: isInactive ? `${memberStatus} — $${participantFee} charged to host` : (participantIsStaff ? 'Staff — included' : (isPaid ? paidLabel : (participantFee > 0 ? 'Overage fee' : 'Within allowance'))),
              membershipStatus: memberStatus as string
            });
            if (email) {
              emailToFeeMap.set(email, {
                fee: (isInactive || participantIsStaff) ? 0 : participantFee,
                feeNote: isInactive ? `${memberStatus} — $${participantFee} charged to host` : (participantIsStaff ? 'Staff — included' : (isPaid ? paidLabel : (participantFee > 0 ? 'Overage fee' : 'Within daily allowance'))),
                isPaid,
                isStaff: participantIsStaff
              });
            }
          } else if (p.participant_type === 'guest') {
            if (!p.user_id && !p.used_guest_pass && participantFee > 0 && !isPaid && !participantIsStaff) {
              guestFeesWithoutPass += participantFee;
            }
          }
        }
        
        for (const member of membersWithFees) {
          if (member.participantId && !member.guestInfo) {
            const recalcFee = feeMap.get(member.participantId);
            if (recalcFee !== undefined) {
              const sessionFeeData = emailToFeeMap.get(member.userEmail ? String(member.userEmail).toLowerCase() : '');
              if (sessionFeeData) {
                member.fee = sessionFeeData.fee;
                member.feeNote = sessionFeeData.feeNote;
              }
            }
          } else if (member.userEmail) {
            const sessionFeeData = emailToFeeMap.get(String(member.userEmail).toLowerCase());
            if (sessionFeeData) {
              member.fee = sessionFeeData.fee;
              member.feeNote = sessionFeeData.feeNote;
            }
          }
        }
        
        const guestParticipants: DbRow[] = participantsResult.rows.filter((p: DbRow) => p.participant_type === 'guest');

        const guestParticipantsByParticipantId = new Map<number, DbRow>();
        const guestParticipantsByGuestId = new Map<number, DbRow>();
        for (const gp of guestParticipants) {
          guestParticipantsByParticipantId.set(gp.participant_id as number, gp);
          if (gp.guest_id) guestParticipantsByGuestId.set(gp.guest_id as number, gp);
        }

        for (const member of membersWithFees) {
          if (member.guestInfo) {
            const gp = member.participantId
              ? guestParticipantsByParticipantId.get(member.participantId)
              : guestParticipantsByGuestId.get(member.guestInfo.guestId as number);
            if (gp) {
              const participantFee = feeMap.get(gp.participant_id as number) || 0;
              const passUsed = gp.used_guest_pass || false;
              const note = passUsed ? 'Guest Pass Used' : (participantFee > 0 ? `No passes - $${PRICING.GUEST_FEE_DOLLARS} due` : 'No charge');
              member.guestInfo.fee = participantFee;
              member.guestInfo.usedGuestPass = passUsed;
              member.guestInfo.feeNote = note;
              member.fee = participantFee;
              member.feeNote = note;
            }
          }
        }

        for (let i = 0; i < guestsWithFees.length && i < guestParticipants.length; i++) {
          const gp = guestParticipants[i];
          const participantFee = feeMap.get(gp.participant_id as number) || 0;
          guestsWithFees[i].fee = participantFee;
          guestsWithFees[i].usedGuestPass = (gp.used_guest_pass as boolean) || false;
          guestsWithFees[i].feeNote = gp.used_guest_pass ? 'Guest Pass Used' : (participantFee > 0 ? `No passes - $${PRICING.GUEST_FEE_DOLLARS} due` : 'No charge');
        }
        
        guestPassesUsedThisBooking = guestParticipants.filter(gp => gp.used_guest_pass).length;
        guestPassesRemainingAfterBooking = ownerGuestPassesRemaining - guestPassesUsedThisBooking;
        
        const emptyMemberSlots = feeEligibleMembers.filter(m => !m.userEmail && !m.guestInfo);
        const guestParticipantCount = participantsResult.rows.filter((p: DbRow) => p.participant_type === 'guest').length;
        const linkedGuestSlots = feeEligibleMembers.filter(m => m.guestInfo).length;
        const unlinkedGuestParticipants = Math.max(0, guestParticipantCount - linkedGuestSlots);
        const unaccountedEmptySlots = Math.max(0, emptyMemberSlots.length - unlinkedGuestParticipants);
        const emptySlotFees = unaccountedEmptySlots * PRICING.GUEST_FEE_DOLLARS;
        guestFeesWithoutPass += emptySlotFees;
      } else {
        const ownerMember = feeEligibleMembers.find(m => m.isPrimary);
        const nonOwnerMembers = feeEligibleMembers.filter(m => !m.isPrimary && m.userEmail);
        const emptySlots = feeEligibleMembers.filter(m => !m.userEmail && !m.guestInfo);
        const emptySlotFees = emptySlots.length * PRICING.GUEST_FEE_DOLLARS;
        guestFeesWithoutPass = guestsWithFees.filter(g => !g.usedGuestPass).reduce((sum, g) => sum + g.fee, 0) + emptySlotFees;
        ownerOverageFee = ownerMember?.fee || 0;
        
        const activeNonOwners = nonOwnerMembers.filter(m => !m.isInactiveMember);
        const inactiveNonOwners = nonOwnerMembers.filter(m => m.isInactiveMember);
        const inactiveFeeTotal = inactiveNonOwners.reduce((sum, m) => sum + m.fee, 0);
        ownerOverageFee += inactiveFeeTotal;
        
        totalPlayersOwe = activeNonOwners.reduce((sum, m) => sum + m.fee, 0);
        playerBreakdownFromSession = nonOwnerMembers.map(m => ({
          name: m.memberName,
          tier: m.tier,
          fee: m.isInactiveMember ? 0 : m.fee,
          feeNote: m.isInactiveMember ? `${m.membershipStatus} — $${m.fee} charged to host` : m.feeNote,
          membershipStatus: m.membershipStatus
        }));
      }
    } else {
      const ownerMember = feeEligibleMembers.find(m => m.isPrimary);
      const nonOwnerMembers = feeEligibleMembers.filter(m => !m.isPrimary && m.userEmail);
      const emptySlots = feeEligibleMembers.filter(m => !m.userEmail && !m.guestInfo);
      const emptySlotFees = emptySlots.length * PRICING.GUEST_FEE_DOLLARS;
      guestFeesWithoutPass = guestsWithFees.filter(g => !g.usedGuestPass).reduce((sum, g) => sum + g.fee, 0) + emptySlotFees;
      ownerOverageFee = ownerMember?.fee || 0;
      
      const activeNonOwners = nonOwnerMembers.filter(m => !m.isInactiveMember);
      const inactiveNonOwners = nonOwnerMembers.filter(m => m.isInactiveMember);
      const inactiveFeeTotal = inactiveNonOwners.reduce((sum, m) => sum + m.fee, 0);
      ownerOverageFee += inactiveFeeTotal;
      
      totalPlayersOwe = activeNonOwners.reduce((sum, m) => sum + m.fee, 0);
      playerBreakdownFromSession = nonOwnerMembers.map(m => ({
        name: m.memberName,
        tier: m.tier,
        fee: m.isInactiveMember ? 0 : m.fee,
        feeNote: m.isInactiveMember ? `${m.membershipStatus} — $${m.fee} charged to host` : m.feeNote,
        membershipStatus: m.membershipStatus
      }));
    }
    
    guestPassesRemainingAfterBooking = ownerGuestPassesRemaining - guestPassesUsedThisBooking;
    let grandTotal = ownerOverageFee + guestFeesWithoutPass + totalPlayersOwe;
    
    let hasPaidFees = false;
    let hasOriginalFees = false;
    let pendingFeeCount = 0;
    if (sessionId) {
      const paidCheck = await db.execute(sql`SELECT 
          COUNT(*) FILTER (WHERE payment_status IN ('paid', 'waived') AND cached_fee_cents > 0) as paid_count,
          COUNT(*) FILTER (WHERE cached_fee_cents > 0 OR payment_status IN ('paid', 'waived')) as total_with_fees,
          COUNT(*) FILTER (WHERE payment_status = 'pending' AND cached_fee_cents > 0) as pending_count
        FROM booking_participants 
        WHERE session_id = ${sessionId}`);
      hasPaidFees = parseInt(((paidCheck.rows[0] as DbRow)?.paid_count as string) || '0') > 0;
      hasOriginalFees = parseInt(((paidCheck.rows[0] as DbRow)?.total_with_fees as string) || '0') > 0;
      pendingFeeCount = parseInt(((paidCheck.rows[0] as DbRow)?.pending_count as string) || '0');
    }
    
    if (hasCompletedFeeSnapshot && snapshotTotalCents > 0 && pendingFeeCount === 0) {
      grandTotal = Math.max(grandTotal, snapshotTotalCents / 100);
    }
    
    const hasEmptySlots = actualPlayerCount < expectedPlayerCount;
    const allPaid = !hasEmptySlots && ((hasCompletedFeeSnapshot && pendingFeeCount === 0) || (pendingFeeCount === 0 && hasPaidFees));
    
    const isOwnerStaff = ownerEmail ? staffEmailSet.has(String(ownerEmail).toLowerCase()) : false;
    
    res.json({
      sessionId,
      ownerId: resolvedOwnerUserId,
      isOwnerStaff,
      ownerGuestPassesRemaining,
      bookingNotes: {
        notes: (bookingResult.rows[0] as DbRow)?.notes || null,
        staffNotes: (bookingResult.rows[0] as DbRow)?.staff_notes || null,
        trackmanNotes: (bookingResult.rows[0] as DbRow)?.trackman_customer_notes || null,
      },
      bookingInfo: {
        durationMinutes,
        perPersonMins,
        expectedPlayerCount
      },
      members: membersWithFees,
      guests: guestsWithFees,
      validation: {
        expectedPlayerCount,
        actualPlayerCount,
        totalMemberSlots,
        filledMemberSlots,
        guestCount: effectiveGuestCount,
        playerCountMismatch,
        emptySlots: feeEligibleMembers.filter(m => !m.userEmail && !m.guestInfo).length
      },
      tierLimits: ownerTierLimits ? {
        can_book_simulators: ownerTierLimits.can_book_simulators,
        daily_sim_minutes: ownerTierLimits.daily_sim_minutes,
        guest_passes_per_month: ownerTierLimits.guest_passes_per_month,
        unlimited_access: ownerTierLimits.unlimited_access
      } : null,
      tierContext: {
        ownerTier,
        allowanceText,
        isUnlimitedTier
      },
      guestPassContext: {
        passesBeforeBooking: ownerGuestPassesRemaining,
        passesUsedThisBooking: guestPassesUsedThisBooking,
        passesRemainingAfterBooking: guestPassesRemainingAfterBooking,
        guestsWithoutPasses: guestsWithFees.filter(g => !g.usedGuestPass).length
      },
      financialSummary: {
        ownerOverageFee,
        guestFeesWithoutPass,
        totalOwnerOwes: grandTotal,
        totalPlayersOwe,
        grandTotal,
        playerBreakdown: playerBreakdownFromSession,
        allPaid
      }
    });
  } catch (error: unknown) {
    logger.error('Get booking members error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get booking members' });
  }
});

router.post('/api/admin/booking/:id/guests', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    const { guestEmail: rawGuestEmail, guestPhone, slotId, forceAddAsGuest, quickAdd } = req.body;
    const guestEmail = rawGuestEmail?.trim()?.toLowerCase();
    let { guestName } = req.body;
    
    if (quickAdd && !guestName?.trim()) {
      guestName = 'Guest (info pending)';
    }
    
    if (!guestName?.trim()) {
      return res.status(400).json({ error: 'Guest name is required' });
    }
    
    if (!quickAdd && guestEmail && !forceAddAsGuest) {
      const memberMatch = await db.execute(sql`SELECT id, email, first_name, last_name, tier FROM users WHERE LOWER(email) = LOWER(${guestEmail.trim()})`);
      if (memberMatch.rowCount && memberMatch.rowCount > 0) {
        const member = memberMatch.rows[0] as DbRow;
        return res.status(409).json({
          error: 'Email belongs to an existing member',
          memberMatch: {
            id: member.id,
            email: member.email,
            name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email,
            tier: member.tier
          }
        });
      }
    }
    
    const bookingResult = await db.execute(sql`SELECT b.*, u.id as owner_id FROM booking_requests b 
       LEFT JOIN users u ON LOWER(u.email) = LOWER(b.user_email) 
       WHERE b.id = ${bookingId}`);
    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const booking = bookingResult.rows[0] as DbRow;
    const ownerEmail = booking.user_email;
    const sessionId = booking.session_id ? parseInt(booking.session_id as string) : null;

    if (sessionId) {
      const durationMinutes = booking.duration_minutes || 60;
      const declaredPlayerCount = booking.declared_player_count || 1;
      const slotDuration = Math.floor(Number(durationMinutes)/ Math.max(declaredPlayerCount as number, 1));
      const trimmedName = guestName.trim();
      const isPlaceholder = isPlaceholderGuestName(trimmedName);

      let passUsed = false;
      if (!isPlaceholder && ownerEmail) {
        try {
          const ownerTier = await getMemberTierByEmail(ownerEmail as string);
          if (ownerTier) {
            await ensureGuestPassRecord(ownerEmail as string, ownerTier);
          }
          const passResult = await useGuestPass(ownerEmail as string, trimmedName, true);
          if (passResult.success) {
            passUsed = true;
            logger.info('[AddGuest] Guest pass used for guest', { extra: { bookingId, ownerEmail, guestName: trimmedName, remaining: passResult.remaining } });
          }
        } catch (passErr: unknown) {
          logger.info('[AddGuest] No guest pass available, guest will be charged', { extra: { bookingId, ownerEmail, guestName: trimmedName, error: getErrorMessage(passErr) } });
        }
      }

      await db.execute(sql`INSERT INTO booking_participants (session_id, participant_type, display_name, payment_status, used_guest_pass, slot_duration)
         VALUES (${sessionId}, 'guest', ${trimmedName}, ${passUsed ? 'paid' : 'pending'}, ${passUsed}, ${slotDuration})`);
      logger.info('[AddGuest] Created booking_participant for guest in session', { extra: { bookingId, sessionId, guestName: trimmedName, guestPassUsed: passUsed } });

      if (req.body.deferFeeRecalc !== true) {
        await recalculateSessionFees(sessionId, 'roster_update');
      }

      await db.execute(sql`UPDATE booking_requests SET guest_count = COALESCE(guest_count, 0) + 1, updated_at = NOW() WHERE id = ${bookingId}`);
    } else {
      await db.execute(sql`UPDATE booking_requests SET guest_count = COALESCE(guest_count, 0) + 1, updated_at = NOW() WHERE id = ${bookingId}`);
    }

    let guestPassesRemaining = 0;
    if (ownerEmail) {
      const passesResult = await db.execute(sql`SELECT passes_total - passes_used as remaining FROM guest_passes WHERE LOWER(member_email) = LOWER(${ownerEmail})`);
      if (passesResult.rowCount && passesResult.rowCount > 0) {
        guestPassesRemaining = Number((passesResult.rows[0] as DbRow).remaining) || 0;
      }
    }

    await logFromRequest(req, {
      action: 'update_booking',
      resourceType: 'booking',
      resourceId: String(bookingId),
      resourceName: `Guest added: ${guestName.trim()}`,
      details: { guestName: guestName.trim(), guestEmail: guestEmail?.trim() || null, sessionId }
    });

    broadcastBookingRosterUpdate({
      bookingId,
      sessionId: sessionId as number,
      action: 'participant_added',
      memberEmail: ownerEmail as string,
    });
    
    res.json({
      success: true,
      guestPassesRemaining
    });
  } catch (error: unknown) {
    logger.error('Add guest error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to add guest' });
  }
});

router.delete('/api/admin/booking/:id/guests/:guestId', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    const guestId = parseInt(req.params.guestId as string);
    if (isNaN(guestId)) {
      return res.status(400).json({ error: 'Invalid guest ID' });
    }
    const staffEmail = req.session?.user?.email || 'admin';

    const bookingResult = await db.execute(sql`SELECT br.id, br.session_id, br.guest_count, br.user_email as owner_email
       FROM booking_requests br
       WHERE br.id = ${bookingId}`);

    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0] as DbRow;
    const sessionId = booking.session_id;

    let guestDisplayName = 'Unknown guest';
    let guestFound = false;

    if (sessionId) {
      const participantResult = await db.execute(sql`SELECT id, display_name, used_guest_pass FROM booking_participants WHERE id = ${guestId} AND session_id = ${sessionId} AND participant_type = 'guest'`);

      if (participantResult.rowCount && participantResult.rowCount > 0) {
        guestFound = true;
        const participant = participantResult.rows[0] as DbRow;
        guestDisplayName = (participant.display_name as string) || guestDisplayName;
        if (participant.used_guest_pass === true && booking.owner_email) {
          try {
            await refundGuestPassForParticipant(participant.id as number, booking.owner_email as string, guestDisplayName);
            logger.info('[RemoveGuest] Guest pass refunded for', { extra: { guestDisplayName } });
          } catch (err: unknown) {
            logger.error('[RemoveGuest] Failed to refund guest pass', { extra: { err } });
          }
        }
        await db.execute(sql`DELETE FROM booking_participants WHERE id = ${guestId}`);
      }
    }

    if (!guestFound) {
      return res.status(404).json({ error: 'Guest not found in booking_participants' });
    }

    if (booking.guest_count && Number(booking.guest_count) > 0) {
      await db.execute(sql`UPDATE booking_requests SET guest_count = GREATEST(0, guest_count - 1), updated_at = NOW() WHERE id = ${bookingId}`);
    }

    if (req.query.deferFeeRecalc !== 'true') {
      if (sessionId) {
        await recalculateSessionFees(sessionId as number, 'roster_update');
      }
    }

    await logFromRequest(req, {
      action: 'update_booking',
      resourceType: 'booking',
      resourceId: String(bookingId),
      resourceName: `Remove guest ${guestDisplayName}`,
      details: { guestId, guestDisplayName, staffEmail }
    });

    broadcastBookingRosterUpdate({
      bookingId,
      sessionId: sessionId as number,
      action: 'participant_removed',
      memberEmail: (booking.owner_email as string) || '',
    });

    res.json({
      success: true,
      message: `Guest ${guestDisplayName} removed successfully`
    });
  } catch (error: unknown) {
    logger.error('Remove guest error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to remove guest' });
  }
});

router.put('/api/admin/booking/:bookingId/members/:slotId/link', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingId, slotId } = req.params;
    const { memberEmail: rawMemberEmail } = req.body;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();
    const linkedBy = req.session?.user?.email || 'admin';
    
    if (!memberEmail) {
      return res.status(400).json({ error: 'memberEmail is required' });
    }
    
    const bookingResult = await db.execute(sql`SELECT request_date, start_time, end_time, status, session_id, resource_id, user_email, user_name, user_id, trackman_booking_id FROM booking_requests WHERE id = ${bookingId}`);
    let sessionId = (bookingResult.rows[0] as DbRow)?.session_id;
    
    if (!sessionId && bookingResult.rows[0]) {
      const bk = bookingResult.rows[0] as DbRow;
      if (bk.resource_id && bk.request_date && bk.start_time && bk.end_time) {
        try {
          const sessionResult = await ensureSessionForBooking({
            bookingId: parseInt(bookingId as string),
            resourceId: bk.resource_id as number,
            sessionDate: String(bk.request_date),
            startTime: String(bk.start_time),
            endTime: String(bk.end_time),
            ownerEmail: (bk.user_email as string) || memberEmail,
            ownerName: (bk.user_name as string) || undefined,
            ownerUserId: (bk.user_id as string) || undefined,
            trackmanBookingId: (bk.trackman_booking_id as string) || undefined,
            source: 'staff_manual',
            createdBy: linkedBy
          });
          sessionId = sessionResult.sessionId;
          await db.execute(sql`UPDATE booking_requests SET session_id = ${sessionId} WHERE id = ${bookingId}`);
          logger.info('[Link Member] Created session for booking without one', { extra: { bookingId, sessionId } });
        } catch (sessErr: unknown) {
          logger.error('[Link Member] Failed to create session', { error: sessErr instanceof Error ? sessErr : new Error(String(sessErr)) });
          return res.status(500).json({ error: 'Failed to create booking session' });
        }
      }
    }

    if (sessionId) {
      const booking = bookingResult.rows[0] as DbRow;
      
      const slotDuration = booking.start_time && booking.end_time
        ? Math.round((new Date(`2000-01-01T${booking.end_time}`).getTime() - 
                     new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000)
        : 60;
      
      const memberInfo = await db.execute(sql`SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);
      
      if (!(memberInfo.rows[0] as DbRow)?.id) {
        logger.warn('[Link Member] User not found for email', { extra: { memberEmail } });
        return res.status(404).json({ error: 'Member not found in system' });
      }
      
      const userId = (memberInfo.rows[0] as DbRow).id;
      const displayName = `${(memberInfo.rows[0] as DbRow).first_name || ''} ${(memberInfo.rows[0] as DbRow).last_name || ''}`.trim() || memberEmail;
      
      const targetSlot = await db.execute(sql`SELECT id, participant_type, user_id FROM booking_participants WHERE id = ${slotId} AND session_id = ${sessionId}`);
      if (targetSlot.rowCount && targetSlot.rowCount > 0) {
        const slot = (targetSlot.rows[0] as DbRow);
        if (!slot.user_id && (slot.participant_type === 'owner' || slot.participant_type === 'member')) {
          await db.execute(sql`UPDATE booking_participants SET user_id = ${userId}, display_name = ${displayName} WHERE id = ${slotId}`);
          
          await db.execute(sql`DELETE FROM booking_participants WHERE session_id = ${sessionId} AND user_id = ${userId} AND id != ${slotId}`);

          if (slot.participant_type === 'owner') {
            await db.execute(sql`UPDATE booking_requests SET user_id = ${userId}, user_email = ${memberEmail.toLowerCase()}, user_name = ${displayName}, updated_at = NOW() WHERE id = ${bookingId}`);
            logger.info('[Link Member] Updated booking_requests owner to match linked owner slot', { extra: { bookingId, userId, displayName, memberEmail } });
          }
          
          if (req.body.deferFeeRecalc !== true) {
            try {
              await recalculateSessionFees(sessionId as number, 'roster_update');
            } catch (feeErr: unknown) {
              logger.warn('[Link Member] Failed to recalculate fees for session', { extra: { sessionId, feeErr } });
            }
          }

          logger.info('[Link Member] Linked member to existing empty slot', { extra: { slotId, userId, displayName, sessionId, slotType: slot.participant_type } });

          if (bookingResult.rows[0]) {
            const bookingForNotif = bookingResult.rows[0] as DbRow;
            const bookingDate = bookingForNotif.request_date;
            const now = new Date();
            const bookingDateTime = createPacificDate(String(bookingDate), String(bookingForNotif.start_time));
            
            if (bookingDateTime > now && bookingForNotif.status === 'approved') {
              const notificationMessage = `You've been added to a simulator booking on ${new Date(bookingDate as string).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}.`;
              
              await db.execute(sql`INSERT INTO notifications (user_email, title, message, type, related_id, related_type)
                 VALUES (${memberEmail.toLowerCase()}, ${'Added to Booking'}, ${notificationMessage}, ${'booking_approved'}, ${bookingId}, ${'booking_request'})`);
              
              sendPushNotification(memberEmail.toLowerCase(), {
                title: 'Added to Booking',
                body: notificationMessage,
                tag: `booking-linked-${bookingId}`
              }).catch((err) => {
                logger.error('[trackman-admin] Failed to send push notification on empty slot link', {
                  error: err instanceof Error ? err : new Error(String(err))
                });
              });
            }
          }

          logFromRequest(req, 'link_member_to_booking', 'booking', String(bookingId), memberEmail.toLowerCase(), {
            slotId,
            memberEmail: memberEmail.toLowerCase(),
            linkedBy,
            slotType: slot.participant_type
          });

          broadcastBookingRosterUpdate({
            bookingId: parseInt(bookingId as string),
            sessionId: sessionId as number,
            action: 'participant_added',
            memberEmail: memberEmail.toLowerCase(),
          });

          return res.json({ 
            success: true, 
            message: `Member ${memberEmail} linked to ${slot.participant_type} slot` 
          });
        }
      }

      const existingParticipant = await db.execute(sql`SELECT id FROM booking_participants WHERE session_id = ${sessionId} AND user_id = ${userId}`);
      
      if (existingParticipant.rowCount === 0) {
        const matchingGuest = await db.execute(sql`SELECT bp.id, bp.display_name, g.email as guest_email
           FROM booking_participants bp
           LEFT JOIN guests g ON bp.guest_id = g.id
           WHERE bp.session_id = ${sessionId} 
             AND bp.participant_type = 'guest'
             AND (LOWER(bp.display_name) = LOWER(${displayName}) OR LOWER(g.email) = LOWER(${memberEmail}))`);
        
        if (matchingGuest.rowCount && matchingGuest.rowCount > 0) {
          const guestIds = matchingGuest.rows.map((r: DbRow) => r.id);
          if (guestIds.length > 0) {
            await db.execute(sql`DELETE FROM booking_participants WHERE id IN (${sql.join(guestIds.map((id: number) => sql`${id}`), sql`, `)})`);
            logger.info('[Link Member] Removed duplicate guest entries for member in session', { extra: { guestIdsLength: guestIds.length, memberEmail, sessionId } });
          }
        }
        
        await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
           VALUES (${sessionId}, ${userId}, 'member', ${displayName}, 'pending', ${slotDuration})`);
      }
      
      if (req.body.deferFeeRecalc !== true) {
        try {
          await recalculateSessionFees(sessionId as number, 'roster_update');
        } catch (feeErr: unknown) {
          logger.warn('[Link Member] Failed to recalculate fees for session', { extra: { sessionId, feeErr } });
        }
      }
    } else {
      logger.warn('[Link Member] No session found and could not create one', { extra: { bookingId, slotId } });
      return res.status(400).json({ error: 'No active session for this booking. Try reassigning the booking owner first.' });
    }
    
    if (bookingResult.rows[0]) {
      const booking = bookingResult.rows[0] as DbRow;
      const bookingDate = booking.request_date;
      const now = new Date();
      const bookingDateTime = createPacificDate(String(bookingDate), String(booking.start_time));
      
      if (bookingDateTime > now && booking.status === 'approved') {
        const notificationMessage = `You've been added to a simulator booking on ${new Date(bookingDate as string).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}.`;
        
        await db.execute(sql`INSERT INTO notifications (user_email, title, message, type, related_id, related_type)
           VALUES (${memberEmail.toLowerCase()}, ${'Added to Booking'}, ${notificationMessage}, ${'booking_approved'}, ${bookingId}, ${'booking_request'})`);
        
        sendPushNotification(memberEmail.toLowerCase(), {
          title: 'Added to Booking',
          body: notificationMessage,
          tag: `booking-linked-${bookingId}`
        }).catch((err) => {
          logger.error('[trackman-admin] Failed to send push notification on member link', {
            error: err instanceof Error ? err : new Error(String(err))
          });
        });
      }
    }
    
    logFromRequest(req, 'link_member_to_booking', 'booking', String(bookingId), memberEmail.toLowerCase(), {
      slotId,
      memberEmail: memberEmail.toLowerCase(),
      linkedBy
    });

    broadcastBookingRosterUpdate({
      bookingId: parseInt(bookingId as string),
      sessionId: sessionId as number,
      action: 'participant_added',
      memberEmail: memberEmail.toLowerCase(),
    });
    
    res.json({ 
      success: true, 
      message: `Member ${memberEmail} linked to slot` 
    });
  } catch (error: unknown) {
    logger.error('Link member error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to link member to slot' });
  }
});

router.put('/api/admin/booking/:bookingId/members/:slotId/unlink', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingId, slotId } = req.params;
    
    const bookingResult = await db.execute(sql`SELECT session_id FROM booking_requests WHERE id = ${bookingId}`);
    
    if (!(bookingResult.rows[0] as DbRow)?.session_id) {
      return res.status(404).json({ error: 'Booking has no session - cannot unlink participant' });
    }
    
    const sessionId = (bookingResult.rows[0] as DbRow).session_id;
    
    const participantResult = await db.execute(sql`SELECT bp.id, u.email as member_email FROM booking_participants bp LEFT JOIN users u ON bp.user_id = u.id WHERE bp.id = ${slotId} AND bp.session_id = ${sessionId} AND bp.participant_type = 'member'`);
    
    if (participantResult.rowCount === 0) {
      return res.status(404).json({ error: 'Slot not found' });
    }
    
    const slot = participantResult.rows[0] as DbRow;
    if (!slot.member_email) {
      return res.status(400).json({ error: 'Slot is already empty' });
    }
    
    const memberEmail = slot.member_email;
    
    await db.execute(sql`DELETE FROM booking_participants WHERE id = ${slotId} AND participant_type = 'member'`);
    
    if (req.query.deferFeeRecalc !== 'true') {
      try {
        const { recalculateSessionFees } = await import('../../core/billing/unifiedFeeService');
        await recalculateSessionFees(sessionId as number, 'roster_update');
      } catch (feeError: unknown) {
        logger.warn('[unlink] Failed to recalculate session fees (non-blocking)', { extra: { feeError } });
      }
    }
    
    logFromRequest(req, 'unlink_member_from_booking', 'booking', String(bookingId), String(memberEmail).toLowerCase(), {
      slotId
    });

    broadcastBookingRosterUpdate({
      bookingId: parseInt(bookingId as string),
      sessionId: sessionId as number,
      action: 'participant_removed',
      memberEmail: String(memberEmail).toLowerCase(),
    });
    
    res.json({ 
      success: true, 
      message: `Member ${memberEmail} unlinked from slot` 
    });
  } catch (error: unknown) {
    logger.error('Unlink member error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to unlink member from slot' });
  }
});

export default router;
