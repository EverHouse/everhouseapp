import { db } from '../db';
import { users } from '../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { logger } from './logger';
import { normalizeEmail } from './utils/emailNormalization';
import { getStripeClient } from './stripe/client';
import { getHubSpotClient } from './integrations';
import { toTextArrayLiteral } from '../utils/sqlArrayLiteral';

export interface MergePreview {
  primaryUser: {
    id: string;
    email: string;
    name: string;
    tier: string | null;
    membershipStatus: string | null;
    lifetimeVisits: number;
    joinDate: string | null;
    stripeCustomerId: string | null;
    hubspotId: string | null;
  };
  secondaryUser: {
    id: string;
    email: string;
    name: string;
    tier: string | null;
    membershipStatus: string | null;
    lifetimeVisits: number;
    joinDate: string | null;
    stripeCustomerId: string | null;
    hubspotId: string | null;
  };
  recordsToMerge: {
    bookings: number;
    visits: number;
    wellnessBookings: number;
    eventRsvps: number;
    notifications: number;
    memberNotes: number;
    guestCheckIns: number;
    usageLedger: number;
    bookingParticipants: number;
    dayPassPurchases: number;
    legacyPurchases: number;
    groupMembers: number;
    pushSubscriptions: number;
    dismissedNotices: number;
    billingGroups: number;
    bugReports: number;
    dataExportRequests: number;
    hubspotDeals: number;
    stripePaymentIntents: number;
  };
  conflicts: string[];
  recommendations: string[];
}

export interface MergeResult {
  success: boolean;
  primaryUserId: string;
  secondaryUserId: string;
  recordsMerged: {
    bookings: number;
    visits: number;
    wellnessBookings: number;
    eventRsvps: number;
    notifications: number;
    memberNotes: number;
    guestCheckIns: number;
    usageLedger: number;
    bookingParticipants: number;
    dayPassPurchases: number;
    legacyPurchases: number;
    groupMembers: number;
    pushSubscriptions: number;
    dismissedNotices: number;
    billingGroups: number;
    bugReports: number;
    dataExportRequests: number;
    hubspotDeals: number;
    stripePaymentIntents: number;
    linkedEmails: number;
    guests: number;
  };
  mergedLifetimeVisits: number;
  secondaryArchived: boolean;
}

export async function previewMerge(primaryUserId: string, secondaryUserId: string): Promise<MergePreview> {
  const [primaryUser] = await db.select().from(users).where(eq(users.id, primaryUserId));
  const [secondaryUser] = await db.select().from(users).where(eq(users.id, secondaryUserId));
  
  if (!primaryUser) throw new Error('Primary user not found');
  if (!secondaryUser) throw new Error('Secondary user not found');
  
  if (primaryUserId === secondaryUserId) {
    throw new Error('Cannot merge a user with themselves');
  }
  
  const secondaryEmail = normalizeEmail(secondaryUser.email);
  
  // Count bookings (all booking requests for this user)
  const bookingsResult = await db.execute(sql`SELECT COUNT(*) as count FROM booking_requests WHERE LOWER(user_email) = ${secondaryEmail} OR user_id = ${secondaryUserId}`);
  const bookingsCount = parseInt((bookingsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count attended visits (booking requests with attended status)
  const visitsResult = await db.execute(sql`SELECT COUNT(*) as count FROM booking_requests 
     WHERE (LOWER(user_email) = ${secondaryEmail} OR user_id = ${secondaryUserId}) 
     AND status = 'attended'`);
  const visitsCount = parseInt((visitsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count wellness enrollments
  const wellnessResult = await db.execute(sql`SELECT COUNT(*) as count FROM wellness_enrollments WHERE LOWER(user_email) = ${secondaryEmail}`);
  const wellnessCount = parseInt((wellnessResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count event RSVPs (uses user_email column)
  const eventRsvpsResult = await db.execute(sql`SELECT COUNT(*) as count FROM event_rsvps WHERE LOWER(user_email) = ${secondaryEmail}`);
  const eventRsvpsCount = parseInt((eventRsvpsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count notifications (uses user_email column)
  const notificationsResult = await db.execute(sql`SELECT COUNT(*) as count FROM notifications WHERE LOWER(user_email) = ${secondaryEmail}`);
  const notificationsCount = parseInt((notificationsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count member notes
  const memberNotesResult = await db.execute(sql`SELECT COUNT(*) as count FROM member_notes WHERE LOWER(member_email) = ${secondaryEmail}`);
  const memberNotesCount = parseInt((memberNotesResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count guest check-ins (uses member_email column)
  const guestCheckInsResult = await db.execute(sql`SELECT COUNT(*) as count FROM guest_check_ins WHERE LOWER(member_email) = ${secondaryEmail}`);
  const guestCheckInsCount = parseInt((guestCheckInsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count usage ledger entries (uses member_id column)
  const usageLedgerResult = await db.execute(sql`SELECT COUNT(*) as count FROM usage_ledger WHERE member_id = ${secondaryUserId}`);
  const usageLedgerCount = parseInt((usageLedgerResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count booking participants (uses user_id column)
  const bookingParticipantsResult = await db.execute(sql`SELECT COUNT(*) as count FROM booking_participants WHERE user_id = ${secondaryUserId}`);
  const bookingParticipantsCount = parseInt((bookingParticipantsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count day pass purchases (uses user_id and purchaser_email columns)
  const dayPassResult = await db.execute(sql`SELECT COUNT(*) as count FROM day_pass_purchases WHERE user_id = ${secondaryUserId} OR LOWER(purchaser_email) = ${secondaryEmail}`);
  const dayPassCount = parseInt((dayPassResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count legacy purchases (uses user_id and member_email columns)
  const legacyPurchasesResult = await db.execute(sql`SELECT COUNT(*) as count FROM legacy_purchases WHERE user_id = ${secondaryUserId} OR LOWER(member_email) = ${secondaryEmail}`);
  const legacyPurchasesCount = parseInt((legacyPurchasesResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count group members (uses member_email column)
  const groupMembersResult = await db.execute(sql`SELECT COUNT(*) as count FROM group_members WHERE LOWER(member_email) = ${secondaryEmail}`);
  const groupMembersCount = parseInt((groupMembersResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count push subscriptions (uses user_email column)
  const pushSubscriptionsResult = await db.execute(sql`SELECT COUNT(*) as count FROM push_subscriptions WHERE LOWER(user_email) = ${secondaryEmail}`);
  const pushSubscriptionsCount = parseInt((pushSubscriptionsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count dismissed notices (uses user_email column)
  const dismissedNoticesResult = await db.execute(sql`SELECT COUNT(*) as count FROM user_dismissed_notices WHERE LOWER(user_email) = ${secondaryEmail}`);
  const dismissedNoticesCount = parseInt((dismissedNoticesResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count billing groups where user is primary payer (uses primary_email column)
  const billingGroupsResult = await db.execute(sql`SELECT COUNT(*) as count FROM billing_groups WHERE LOWER(primary_email) = ${secondaryEmail}`);
  const billingGroupsCount = parseInt((billingGroupsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count bug reports (uses user_email column)
  const bugReportsResult = await db.execute(sql`SELECT COUNT(*) as count FROM bug_reports WHERE LOWER(user_email) = ${secondaryEmail}`);
  const bugReportsCount = parseInt((bugReportsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count data export requests (uses user_email column)
  const dataExportResult = await db.execute(sql`SELECT COUNT(*) as count FROM data_export_requests WHERE LOWER(user_email) = ${secondaryEmail}`);
  const dataExportCount = parseInt((dataExportResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count HubSpot deals (uses member_email column)
  const hubspotDealsResult = await db.execute(sql`SELECT COUNT(*) as count FROM hubspot_deals WHERE LOWER(member_email) = ${secondaryEmail}`);
  const hubspotDealsCount = parseInt((hubspotDealsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  // Count Stripe payment intents (uses user_id column)
  const stripePaymentIntentsResult = await db.execute(sql`SELECT COUNT(*) as count FROM stripe_payment_intents WHERE user_id = ${secondaryUserId}`);
  const stripePaymentIntentsCount = parseInt((stripePaymentIntentsResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
  
  const conflicts: string[] = [];
  const recommendations: string[] = [];
  
  if (primaryUser.stripeCustomerId && secondaryUser.stripeCustomerId) {
    conflicts.push(`Both users have Stripe customers. Primary: ${primaryUser.stripeCustomerId}, Secondary: ${secondaryUser.stripeCustomerId}`);
    recommendations.push('Secondary Stripe customer will be noted but primary will be kept');
  }
  
  if (primaryUser.stripeSubscriptionId && secondaryUser.stripeSubscriptionId) {
    conflicts.push('Both users have active Stripe subscriptions');
    recommendations.push('Verify secondary subscription is cancelled before merging');
  }
  
  if (primaryUser.hubspotId && secondaryUser.hubspotId && primaryUser.hubspotId !== secondaryUser.hubspotId) {
    conflicts.push('Users have different HubSpot contact IDs');
    recommendations.push('Consider merging contacts in HubSpot as well');
  }
  
  const primaryActive = primaryUser.membershipStatus === 'active';
  const secondaryActive = secondaryUser.membershipStatus === 'active';
  if (!primaryActive && secondaryActive) {
    recommendations.push('Secondary user is active while primary is not. Consider swapping primary/secondary.');
  }
  
  return {
    primaryUser: {
      id: primaryUser.id,
      email: primaryUser.email || '',
      name: `${primaryUser.firstName || ''} ${primaryUser.lastName || ''}`.trim(),
      tier: primaryUser.tier,
      membershipStatus: primaryUser.membershipStatus,
      lifetimeVisits: primaryUser.lifetimeVisits || 0,
      joinDate: primaryUser.joinDate?.toString() || null,
      stripeCustomerId: primaryUser.stripeCustomerId,
      hubspotId: primaryUser.hubspotId,
    },
    secondaryUser: {
      id: secondaryUser.id,
      email: secondaryUser.email || '',
      name: `${secondaryUser.firstName || ''} ${secondaryUser.lastName || ''}`.trim(),
      tier: secondaryUser.tier,
      membershipStatus: secondaryUser.membershipStatus,
      lifetimeVisits: secondaryUser.lifetimeVisits || 0,
      joinDate: secondaryUser.joinDate?.toString() || null,
      stripeCustomerId: secondaryUser.stripeCustomerId,
      hubspotId: secondaryUser.hubspotId,
    },
    recordsToMerge: {
      bookings: bookingsCount,
      visits: visitsCount,
      wellnessBookings: wellnessCount,
      eventRsvps: eventRsvpsCount,
      notifications: notificationsCount,
      memberNotes: memberNotesCount,
      guestCheckIns: guestCheckInsCount,
      usageLedger: usageLedgerCount,
      bookingParticipants: bookingParticipantsCount,
      dayPassPurchases: dayPassCount,
      legacyPurchases: legacyPurchasesCount,
      groupMembers: groupMembersCount,
      pushSubscriptions: pushSubscriptionsCount,
      dismissedNotices: dismissedNoticesCount,
      billingGroups: billingGroupsCount,
      bugReports: bugReportsCount,
      dataExportRequests: dataExportCount,
      hubspotDeals: hubspotDealsCount,
      stripePaymentIntents: stripePaymentIntentsCount,
    },
    conflicts,
    recommendations,
  };
}

export async function executeMerge(
  primaryUserId: string, 
  secondaryUserId: string, 
  performedBy: string
): Promise<MergeResult> {
  const [primaryUser] = await db.select().from(users).where(eq(users.id, primaryUserId));
  const [secondaryUser] = await db.select().from(users).where(eq(users.id, secondaryUserId));
  
  if (!primaryUser) throw new Error('Primary user not found');
  if (!secondaryUser) throw new Error('Secondary user not found');
  if (primaryUserId === secondaryUserId) throw new Error('Cannot merge a user with themselves');
  
  const primaryEmail = normalizeEmail(primaryUser.email);
  const secondaryEmail = normalizeEmail(secondaryUser.email);
  
  const recordsMerged = {
    bookings: 0,
    visits: 0,
    wellnessBookings: 0,
    eventRsvps: 0,
    notifications: 0,
    memberNotes: 0,
    guestCheckIns: 0,
    usageLedger: 0,
    bookingParticipants: 0,
    dayPassPurchases: 0,
    legacyPurchases: 0,
    groupMembers: 0,
    pushSubscriptions: 0,
    dismissedNotices: 0,
    billingGroups: 0,
    bugReports: 0,
    dataExportRequests: 0,
    hubspotDeals: 0,
    stripePaymentIntents: 0,
    linkedEmails: 0,
    guests: 0,
  };
  
  let stripeCustomerToUpdateId: string | null = null;
  let stripeOrphanedIdForMetadata: string | null = null;

  // Check for active sessions (cannot merge user who is currently playing)
  const activeSession = await db.execute(sql`
      SELECT bp.session_id, bs.session_date, bs.start_time
      FROM booking_participants bp
      JOIN booking_sessions bs ON bp.session_id = bs.id
      WHERE bp.user_id = ${secondaryUserId}
        AND bs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
        AND bs.start_time <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::time
        AND bs.end_time > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::time
    `);

  if ((activeSession.rows as Array<Record<string, unknown>>).length > 0) {
    throw new Error(`Cannot merge: Secondary user has ${(activeSession.rows as Array<Record<string, unknown>>).length} active session(s). Wait until session ends.`);
  }
  
  await db.transaction(async (tx) => {
    const bookingsResult = await tx.execute(sql`UPDATE booking_requests 
       SET user_email = ${primaryEmail}, user_id = ${primaryUserId}, updated_at = NOW(),
           staff_notes = COALESCE(staff_notes, '') || ' [Merged from ' || ${secondaryEmail} || ']'
       WHERE (LOWER(user_email) = ${secondaryEmail} OR user_id = ${secondaryUserId})`);
    recordsMerged.bookings = (bookingsResult as any).rowCount || 0;
    
    // Visits are tracked via booking_requests status - no separate table to update
    // Just count how many attended bookings were transferred
    const attendedResult = await tx.execute(sql`SELECT COUNT(*) as count FROM booking_requests 
       WHERE (LOWER(user_email) = ${primaryEmail} OR user_id = ${primaryUserId}) AND status = 'attended'`);
    recordsMerged.visits = parseInt((attendedResult.rows as Array<Record<string, unknown>>)[0]?.count as string || '0');
    
    // Update wellness enrollments
    const wellnessResult = await tx.execute(sql`UPDATE wellness_enrollments SET user_email = ${primaryEmail} WHERE LOWER(user_email) = ${secondaryEmail}`);
    recordsMerged.wellnessBookings = (wellnessResult as any).rowCount || 0;
    
    // Update event RSVPs (uses user_email column)
    const eventRsvpsResult = await tx.execute(sql`UPDATE event_rsvps SET user_email = ${primaryEmail} WHERE LOWER(user_email) = ${secondaryEmail}`);
    recordsMerged.eventRsvps = (eventRsvpsResult as any).rowCount || 0;
    
    // Update notifications (uses user_email column)
    const notificationsResult = await tx.execute(sql`UPDATE notifications SET user_email = ${primaryEmail} WHERE LOWER(user_email) = ${secondaryEmail}`);
    recordsMerged.notifications = (notificationsResult as any).rowCount || 0;
    
    const memberNotesResult = await tx.execute(sql`UPDATE member_notes SET member_email = ${primaryEmail}, updated_at = NOW() WHERE LOWER(member_email) = ${secondaryEmail}`);
    recordsMerged.memberNotes = (memberNotesResult as any).rowCount || 0;
    
    // Update guest check-ins (uses member_email column)
    const guestCheckInsResult = await tx.execute(sql`UPDATE guest_check_ins SET member_email = ${primaryEmail} WHERE LOWER(member_email) = ${secondaryEmail}`);
    recordsMerged.guestCheckIns = (guestCheckInsResult as any).rowCount || 0;
    
    // Update usage ledger (uses member_id column)
    const usageLedgerResult = await tx.execute(sql`UPDATE usage_ledger SET member_id = ${primaryUserId} WHERE member_id = ${secondaryUserId}`);
    recordsMerged.usageLedger = (usageLedgerResult as any).rowCount || 0;
    
    await tx.execute(sql`UPDATE communication_logs SET member_email = ${primaryEmail}, updated_at = NOW() WHERE LOWER(member_email) = ${secondaryEmail}`);
    
    const primaryGuestPass = await tx.execute(sql`SELECT id, passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = ${primaryEmail} LIMIT 1`);
    const secondaryGuestPass = await tx.execute(sql`SELECT id, passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = ${secondaryEmail} LIMIT 1`);
    if (primaryGuestPass.rows.length > 0 && secondaryGuestPass.rows.length > 0) {
      const pRow = primaryGuestPass.rows[0] as { id: number; passes_used: number; passes_total: number };
      const sRow = secondaryGuestPass.rows[0] as { id: number; passes_used: number; passes_total: number };
      const mergedUsed = Math.min(pRow.passes_used + sRow.passes_used, Math.max(pRow.passes_total, sRow.passes_total));
      await tx.execute(sql`UPDATE guest_passes SET passes_used = ${mergedUsed}, passes_total = GREATEST(passes_total, ${sRow.passes_total}) WHERE id = ${pRow.id}`);
      await tx.execute(sql`DELETE FROM guest_passes WHERE id = ${sRow.id}`);
    } else if (secondaryGuestPass.rows.length > 0) {
      await tx.execute(sql`UPDATE guest_passes SET member_email = ${primaryEmail} WHERE LOWER(member_email) = ${secondaryEmail}`);
    }
    
    // Update guests created by secondary user
    const guestsResult = await tx.execute(sql`UPDATE guests SET created_by_member_id = ${primaryUserId} WHERE created_by_member_id = ${secondaryUserId}`);
    recordsMerged.guests = (guestsResult as any).rowCount || 0;
    
    // Update booking participants (uses user_id column)
    // DEDUPLICATE: If primary user is already in a session, remove secondary user's duplicate record
    await tx.execute(sql`DELETE FROM booking_participants 
       WHERE user_id = ${secondaryUserId} 
       AND session_id IN (SELECT session_id FROM booking_participants WHERE user_id = ${primaryUserId})`);
    
    const bookingParticipantsResult = await tx.execute(sql`UPDATE booking_participants SET user_id = ${primaryUserId} WHERE user_id = ${secondaryUserId}`);
    recordsMerged.bookingParticipants = (bookingParticipantsResult as any).rowCount || 0;
    
    // Update day pass purchases (uses user_id and purchaser_email columns)
    const dayPassResult = await tx.execute(sql`UPDATE day_pass_purchases SET user_id = ${primaryUserId}, purchaser_email = ${primaryEmail} 
       WHERE user_id = ${secondaryUserId} OR LOWER(purchaser_email) = ${secondaryEmail}`);
    recordsMerged.dayPassPurchases = (dayPassResult as any).rowCount || 0;
    
    // Update legacy purchases (uses user_id and member_email columns)
    const legacyPurchasesResult = await tx.execute(sql`UPDATE legacy_purchases SET user_id = ${primaryUserId}, member_email = ${primaryEmail} 
       WHERE user_id = ${secondaryUserId} OR LOWER(member_email) = ${secondaryEmail}`);
    recordsMerged.legacyPurchases = (legacyPurchasesResult as any).rowCount || 0;
    
    // Update group members (uses member_email column)
    // DEDUPLICATE: If primary email is already in a group, remove secondary email's duplicate record
    await tx.execute(sql`DELETE FROM group_members 
       WHERE LOWER(member_email) = ${secondaryEmail} 
       AND billing_group_id IN (SELECT billing_group_id FROM group_members WHERE LOWER(member_email) = ${primaryEmail})`);
    
    const groupMembersResult = await tx.execute(sql`UPDATE group_members SET member_email = ${primaryEmail} WHERE LOWER(member_email) = ${secondaryEmail}`);
    recordsMerged.groupMembers = (groupMembersResult as any).rowCount || 0;
    
    // Update push subscriptions (uses user_email column)
    // DEDUPLICATE: If same endpoint exists for primary, remove secondary's duplicate subscription
    await tx.execute(sql`DELETE FROM push_subscriptions
       WHERE LOWER(user_email) = ${secondaryEmail}
       AND endpoint IN (SELECT endpoint FROM push_subscriptions WHERE LOWER(user_email) = ${primaryEmail})`);
    
    const pushSubscriptionsResult = await tx.execute(sql`UPDATE push_subscriptions SET user_email = ${primaryEmail} WHERE LOWER(user_email) = ${secondaryEmail}`);
    recordsMerged.pushSubscriptions = (pushSubscriptionsResult as any).rowCount || 0;
    
    await tx.execute(sql`DELETE FROM user_dismissed_notices 
       WHERE LOWER(user_email) = ${secondaryEmail}
       AND (notice_type, notice_id) IN (SELECT notice_type, notice_id FROM user_dismissed_notices WHERE LOWER(user_email) = ${primaryEmail})`);
    const dismissedNoticesResult = await tx.execute(sql`UPDATE user_dismissed_notices SET user_email = ${primaryEmail} WHERE LOWER(user_email) = ${secondaryEmail}`);
    recordsMerged.dismissedNotices = (dismissedNoticesResult as any).rowCount || 0;
    
    // Update billing groups where user is primary payer (uses primary_email column)
    const billingGroupsResult = await tx.execute(sql`UPDATE billing_groups SET primary_email = ${primaryEmail} WHERE LOWER(primary_email) = ${secondaryEmail}`);
    recordsMerged.billingGroups = (billingGroupsResult as any).rowCount || 0;
    
    // Update bug reports (uses user_email column)
    const bugReportsResult = await tx.execute(sql`UPDATE bug_reports SET user_email = ${primaryEmail} WHERE LOWER(user_email) = ${secondaryEmail}`);
    recordsMerged.bugReports = (bugReportsResult as any).rowCount || 0;
    
    // Update data export requests (uses user_email column)
    const dataExportResult = await tx.execute(sql`UPDATE data_export_requests SET user_email = ${primaryEmail} WHERE LOWER(user_email) = ${secondaryEmail}`);
    recordsMerged.dataExportRequests = (dataExportResult as any).rowCount || 0;
    
    // Update HubSpot deals (uses member_email column)
    const hubspotDealsResult = await tx.execute(sql`UPDATE hubspot_deals SET member_email = ${primaryEmail} WHERE LOWER(member_email) = ${secondaryEmail}`);
    recordsMerged.hubspotDeals = (hubspotDealsResult as any).rowCount || 0;
    
    // Update Stripe payment intents (uses user_id column)
    const stripePaymentIntentsResult = await tx.execute(sql`UPDATE stripe_payment_intents SET user_id = ${primaryUserId} WHERE user_id = ${secondaryUserId}`);
    recordsMerged.stripePaymentIntents = (stripePaymentIntentsResult as any).rowCount || 0;
    
    // Update user_linked_emails (uses primary_email column, not user_id)
    await tx.execute(sql`UPDATE user_linked_emails SET primary_email = ${primaryEmail} WHERE LOWER(primary_email) = ${secondaryEmail}`);
    
    // Add secondary email as a linked email for the primary user
    if (secondaryEmail && secondaryEmail !== primaryEmail) {
      const existingLink = await tx.execute(sql`SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = ${secondaryEmail}`);
      
      if ((existingLink.rows as Array<Record<string, unknown>>).length === 0) {
        await tx.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_at)
           VALUES (${primaryEmail}, ${secondaryEmail}, 'user_merge', NOW())
           ON CONFLICT (linked_email) DO NOTHING`);
        recordsMerged.linkedEmails++;
      }
    }
    
    const combinedVisits = (primaryUser.lifetimeVisits || 0) + (secondaryUser.lifetimeVisits || 0);
    
    const earlierJoinDate = primaryUser.joinDate && secondaryUser.joinDate
      ? (new Date(primaryUser.joinDate) < new Date(secondaryUser.joinDate) ? primaryUser.joinDate : secondaryUser.joinDate)
      : primaryUser.joinDate || secondaryUser.joinDate;
    
    const newerWaiver = primaryUser.waiverSignedAt && secondaryUser.waiverSignedAt
      ? (new Date(primaryUser.waiverSignedAt) > new Date(secondaryUser.waiverSignedAt) 
          ? { version: primaryUser.waiverVersion, signedAt: primaryUser.waiverSignedAt }
          : { version: secondaryUser.waiverVersion, signedAt: secondaryUser.waiverSignedAt })
      : primaryUser.waiverSignedAt 
        ? { version: primaryUser.waiverVersion, signedAt: primaryUser.waiverSignedAt }
        : { version: secondaryUser.waiverVersion, signedAt: secondaryUser.waiverSignedAt };
    
    const mergeInfo: Record<string, unknown> = {
      mergedFrom: secondaryUserId,
      mergedFromEmail: secondaryEmail,
      mergedFromName: `${secondaryUser.firstName || ''} ${secondaryUser.lastName || ''}`.trim(),
      mergedAt: new Date().toISOString(),
      mergedBy: performedBy,
      secondaryStripeCustomerId: secondaryUser.stripeCustomerId,
      secondaryHubspotId: secondaryUser.hubspotId,
    };
    
    const currentTags = (primaryUser.tags as unknown[]) || [];
    
    // FIX: Transfer external IDs (Stripe/HubSpot) from secondary to primary if primary is missing them
    // This prevents losing billing history when merging a fresh duplicate into the active payer
    const transferStripeId = !primaryUser.stripeCustomerId && secondaryUser.stripeCustomerId;
    const transferHubspotId = !primaryUser.hubspotId && secondaryUser.hubspotId;
    
    let resolvedStripeCustomerId: string | null = null;
    let orphanedStripeCustomerId: string | null = null;
    
    if (transferStripeId) {
      resolvedStripeCustomerId = secondaryUser.stripeCustomerId;
      logger.info('[UserMerge] Transferring Stripe Customer from secondary to primary', {
        extra: { stripeCustomerId: secondaryUser.stripeCustomerId, primaryUserId, secondaryUserId }
      });
    } else if (primaryUser.stripeCustomerId && secondaryUser.stripeCustomerId) {
      const primaryHasSub = !!primaryUser.stripeSubscriptionId;
      const secondaryHasSub = !!secondaryUser.stripeSubscriptionId;
      
      if (secondaryHasSub && !primaryHasSub) {
        resolvedStripeCustomerId = secondaryUser.stripeCustomerId;
        orphanedStripeCustomerId = primaryUser.stripeCustomerId;
        logger.info('[UserMerge] Secondary has active subscription - using secondary Stripe customer', {
          extra: { kept: secondaryUser.stripeCustomerId, orphaned: primaryUser.stripeCustomerId, primaryUserId, secondaryUserId }
        });
      } else {
        orphanedStripeCustomerId = secondaryUser.stripeCustomerId;
        logger.info('[UserMerge] Keeping primary Stripe customer', {
          extra: { kept: primaryUser.stripeCustomerId, orphaned: secondaryUser.stripeCustomerId, reason: primaryHasSub ? 'primary_has_subscription' : 'default_keep_primary', primaryUserId, secondaryUserId }
        });
      }
      
      stripeCustomerToUpdateId = resolvedStripeCustomerId || primaryUser.stripeCustomerId || null;
      stripeOrphanedIdForMetadata = orphanedStripeCustomerId;
    }
    
    if (orphanedStripeCustomerId) {
      mergeInfo.orphanedStripeCustomerId = orphanedStripeCustomerId;
    }
    
    if (transferHubspotId) {
      logger.info('[UserMerge] Transferring HubSpot ID from secondary to primary', {
        extra: { hubspotId: secondaryUser.hubspotId, primaryUserId, secondaryUserId }
      });
    }
    
    const finalTags = [...currentTags, { type: 'merge_record', ...mergeInfo }];
    
    const finalStripeId = resolvedStripeCustomerId || (transferStripeId ? secondaryUser.stripeCustomerId : null);
    const finalHubspotId = transferHubspotId ? secondaryUser.hubspotId : null;
    
    await tx.execute(sql`UPDATE users SET
         lifetime_visits = ${combinedVisits},
         join_date = ${earlierJoinDate},
         waiver_version = ${newerWaiver.version},
         waiver_signed_at = ${newerWaiver.signedAt},
         tags = ${JSON.stringify(finalTags)},
         stripe_customer_id = COALESCE(${finalStripeId}, stripe_customer_id),
         hubspot_id = COALESCE(${finalHubspotId}, hubspot_id),
         updated_at = NOW()
       WHERE id = ${primaryUserId}`);
    
    const secondaryTags = (secondaryUser.tags as unknown[]) || [];
    const archiveTags = [...secondaryTags, { 
      type: 'merged_into', 
      primaryUserId, 
      primaryEmail,
      originalEmail: secondaryEmail, // Preserve original email in tags for history
      mergedAt: new Date().toISOString(),
      mergedBy: performedBy
    }];
    
    // FIX: "Email Hostage" bug - release the email address by appending .merged.{timestamp}
    // This allows the email to be re-used for new signups or HubSpot sync
    const archivedEmail = `${secondaryEmail}.merged.${Date.now()}`;
    
    logger.info('[UserMerge] Releasing email address from archived user', {
      extra: { originalEmail: secondaryEmail, archivedEmail, secondaryUserId }
    });
    
    await tx.execute(sql`UPDATE users SET
         archived_at = NOW(),
         archived_by = ${performedBy},
         membership_status = 'merged',
         email = ${archivedEmail},
         stripe_customer_id = NULL,
         stripe_subscription_id = NULL,
         hubspot_id = NULL,
         tags = ${JSON.stringify(archiveTags)},
         updated_at = NOW()
       WHERE id = ${secondaryUserId}`);
  });

  if (stripeCustomerToUpdateId) {
    try {
      const stripe = await getStripeClient();
      await stripe.customers.update(stripeCustomerToUpdateId, {
        metadata: {
          mergedFromEmail: secondaryEmail,
          mergedFromUserId: secondaryUserId,
          mergedAt: new Date().toISOString(),
          orphanedStripeCustomerId: stripeOrphanedIdForMetadata || ''
        }
      });
    } catch (stripeErr: unknown) {
      logger.error('[UserMerge] Failed to update Stripe customer metadata after merge', {
        extra: { error: stripeErr, primaryUserId, secondaryUserId }
      });
    }
  }
    
  logger.info('[UserMerge] Successfully merged users', {
    extra: { primaryUserId, secondaryUserId, performedBy, recordsMerged }
  });
  
  const primaryHubspotId = primaryUser.hubspotId || (transferHubspotId ? secondaryUser.hubspotId : null);
  const secondaryHubspotId = transferHubspotId ? null : secondaryUser.hubspotId;
  
  if (primaryHubspotId && secondaryHubspotId && primaryHubspotId !== secondaryHubspotId) {
    try {
      const hubspot = await getHubSpotClient();
      if (hubspot) {
        await hubspot.apiRequest({
          method: 'POST',
          path: '/crm/v3/objects/contacts/merge',
          body: {
            primaryObjectId: primaryHubspotId,
            objectIdToMerge: secondaryHubspotId
          }
        });
        logger.info('[UserMerge] HubSpot contacts merged automatically', {
          extra: { primaryHubspotId, secondaryHubspotId }
        });
      }
    } catch (hubspotErr: unknown) {
      logger.warn('[UserMerge] Failed to merge HubSpot contacts (merge them manually in HubSpot)', {
        extra: { error: hubspotErr, primaryHubspotId, secondaryHubspotId }
      });
    }
  }
  
  return {
    success: true,
    primaryUserId,
    secondaryUserId,
    recordsMerged,
    mergedLifetimeVisits: combinedVisits,
    secondaryArchived: true,
  };
}

export async function findPotentialDuplicates(userId: string): Promise<Array<{
  id: string;
  email: string;
  name: string;
  tier: string | null;
  membershipStatus: string | null;
  matchReason: string;
}>> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return [];
  
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim().toLowerCase();
  const duplicates: Array<{
    id: string;
    email: string;
    name: string;
    tier: string | null;
    membershipStatus: string | null;
    matchReason: string;
  }> = [];
  
  if (fullName) {
    const nameMatches = await db.execute(sql`SELECT id, email, first_name, last_name, tier, membership_status
       FROM users 
       WHERE id != ${userId} 
         AND archived_at IS NULL
         AND LOWER(CONCAT(first_name, ' ', last_name)) = ${fullName}
       LIMIT 10`);
    
    for (const row of (nameMatches.rows as Array<Record<string, unknown>>)) {
      duplicates.push({
        id: row.id as string,
        email: (row.email as string) || '',
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        tier: row.tier as string | null,
        membershipStatus: row.membership_status as string | null,
        matchReason: 'Same name',
      });
    }
  }
  
  if (user.phone) {
    const phoneMatches = await db.execute(sql`SELECT id, email, first_name, last_name, tier, membership_status
       FROM users 
       WHERE id != ${userId} 
         AND archived_at IS NULL
         AND phone = ${user.phone}
         AND id NOT IN (SELECT unnest(${toTextArrayLiteral(duplicates.map(d => d.id))}::text[]))
       LIMIT 5`);
    
    for (const row of (phoneMatches.rows as Array<Record<string, unknown>>)) {
      duplicates.push({
        id: row.id as string,
        email: (row.email as string) || '',
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        tier: row.tier as string | null,
        membershipStatus: row.membership_status as string | null,
        matchReason: 'Same phone number',
      });
    }
  }
  
  if (user.mindbodyClientId) {
    const mbMatches = await db.execute(sql`SELECT id, email, first_name, last_name, tier, membership_status
       FROM users 
       WHERE id != ${userId} 
         AND archived_at IS NULL
         AND mindbody_client_id = ${user.mindbodyClientId}
         AND id NOT IN (SELECT unnest(${toTextArrayLiteral(duplicates.map(d => d.id))}::text[]))
       LIMIT 5`);
    
    for (const row of (mbMatches.rows as Array<Record<string, unknown>>)) {
      duplicates.push({
        id: row.id as string,
        email: (row.email as string) || '',
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        tier: row.tier as string | null,
        membershipStatus: row.membership_status as string | null,
        matchReason: 'Same MindBody ID',
      });
    }
  }
  
  if (user.hubspotId) {
    const hsMatches = await db.execute(sql`SELECT id, email, first_name, last_name, tier, membership_status
       FROM users 
       WHERE id != ${userId} 
         AND archived_at IS NULL
         AND hubspot_id = ${user.hubspotId}
         AND id NOT IN (SELECT unnest(${toTextArrayLiteral(duplicates.map(d => d.id))}::text[]))
       LIMIT 5`);
    
    for (const row of (hsMatches.rows as Array<Record<string, unknown>>)) {
      duplicates.push({
        id: row.id as string,
        email: (row.email as string) || '',
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        tier: row.tier as string | null,
        membershipStatus: row.membership_status as string | null,
        matchReason: 'Same HubSpot ID',
      });
    }
  }
  
  return duplicates;
}

export async function consolidateStripeCustomers(
  primaryUserId: string,
  secondaryUserId: string
): Promise<{ keptCustomerId: string; orphanedCustomerId: string; reason: string }> {
  const primaryResult = await db.execute(sql`SELECT stripe_customer_id, stripe_subscription_id, email FROM users WHERE id = ${primaryUserId}`);
  const secondaryResult = await db.execute(sql`SELECT stripe_customer_id, stripe_subscription_id, email FROM users WHERE id = ${secondaryUserId}`);
  
  const primary = (primaryResult.rows as Array<Record<string, unknown>>)[0];
  const secondary = (secondaryResult.rows as Array<Record<string, unknown>>)[0];
  
  if (!primary?.stripe_customer_id || !secondary?.stripe_customer_id) {
    throw new Error('Both users must have Stripe customer IDs to consolidate');
  }
  
  const primaryHasSub = !!primary.stripe_subscription_id;
  const secondaryHasSub = !!secondary.stripe_subscription_id;
  
  let keptCustomerId: string;
  let orphanedCustomerId: string;
  let reason: string;
  
  if (secondaryHasSub && !primaryHasSub) {
    keptCustomerId = secondary.stripe_customer_id;
    orphanedCustomerId = primary.stripe_customer_id;
    reason = 'secondary_has_active_subscription';
  } else if (primaryHasSub && !secondaryHasSub) {
    keptCustomerId = primary.stripe_customer_id;
    orphanedCustomerId = secondary.stripe_customer_id;
    reason = 'primary_has_active_subscription';
  } else {
    keptCustomerId = primary.stripe_customer_id;
    orphanedCustomerId = secondary.stripe_customer_id;
    reason = primaryHasSub && secondaryHasSub ? 'both_have_subscriptions_kept_primary' : 'neither_has_subscription_kept_primary';
  }
  
  await db.execute(sql`UPDATE users SET stripe_customer_id = ${keptCustomerId}, updated_at = NOW() WHERE id = ${primaryUserId}`);
  
  try {
    const stripe = await getStripeClient();
    await stripe.customers.update(keptCustomerId, {
      metadata: {
        mergedFromEmail: secondary.email,
        mergedFromUserId: secondaryUserId,
        consolidatedAt: new Date().toISOString(),
        orphanedStripeCustomerId: orphanedCustomerId
      }
    });
  } catch (stripeErr: unknown) {
    logger.error('[UserMerge] Failed to update Stripe metadata during consolidation', {
      extra: { error: stripeErr, keptCustomerId, orphanedCustomerId }
    });
  }
  
  logger.info('[UserMerge] Consolidated Stripe customers', {
    extra: { primaryUserId, secondaryUserId, keptCustomerId, orphanedCustomerId, reason }
  });
  
  return { keptCustomerId, orphanedCustomerId, reason };
}
