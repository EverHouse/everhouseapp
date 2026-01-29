import { db } from '../db';
import { pool } from './db';
import { users } from '../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { logger } from './logger';

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
  
  if (secondaryUser.archivedAt) {
    throw new Error('Secondary user has already been archived/merged');
  }
  
  const secondaryEmail = secondaryUser.email?.toLowerCase() || '';
  
  // Count bookings (all booking requests for this user)
  const bookingsResult = await pool.query(
    `SELECT COUNT(*) as count FROM booking_requests WHERE LOWER(user_email) = $1 OR user_id = $2`,
    [secondaryEmail, secondaryUserId]
  );
  const bookingsCount = parseInt(bookingsResult.rows[0]?.count || '0');
  
  // Count attended visits (booking requests with attended status)
  const visitsResult = await pool.query(
    `SELECT COUNT(*) as count FROM booking_requests 
     WHERE (LOWER(user_email) = $1 OR user_id = $2) 
     AND status = 'attended'`,
    [secondaryEmail, secondaryUserId]
  );
  const visitsCount = parseInt(visitsResult.rows[0]?.count || '0');
  
  // Count wellness enrollments
  const wellnessResult = await pool.query(
    `SELECT COUNT(*) as count FROM wellness_enrollments WHERE LOWER(user_email) = $1`,
    [secondaryEmail]
  );
  const wellnessCount = parseInt(wellnessResult.rows[0]?.count || '0');
  
  // Count event RSVPs (uses user_email column)
  const eventRsvpsResult = await pool.query(
    `SELECT COUNT(*) as count FROM event_rsvps WHERE LOWER(user_email) = $1`,
    [secondaryEmail]
  );
  const eventRsvpsCount = parseInt(eventRsvpsResult.rows[0]?.count || '0');
  
  // Count notifications (uses user_email column)
  const notificationsResult = await pool.query(
    `SELECT COUNT(*) as count FROM notifications WHERE LOWER(user_email) = $1`,
    [secondaryEmail]
  );
  const notificationsCount = parseInt(notificationsResult.rows[0]?.count || '0');
  
  // Count member notes
  const memberNotesResult = await pool.query(
    `SELECT COUNT(*) as count FROM member_notes WHERE LOWER(member_email) = $1`,
    [secondaryEmail]
  );
  const memberNotesCount = parseInt(memberNotesResult.rows[0]?.count || '0');
  
  // Count guest check-ins (uses member_email column)
  const guestCheckInsResult = await pool.query(
    `SELECT COUNT(*) as count FROM guest_check_ins WHERE LOWER(member_email) = $1`,
    [secondaryEmail]
  );
  const guestCheckInsCount = parseInt(guestCheckInsResult.rows[0]?.count || '0');
  
  // Count usage ledger entries (uses member_id column)
  const usageLedgerResult = await pool.query(
    `SELECT COUNT(*) as count FROM usage_ledger WHERE member_id = $1`,
    [secondaryUserId]
  );
  const usageLedgerCount = parseInt(usageLedgerResult.rows[0]?.count || '0');
  
  // Count booking participants (uses user_id column)
  const bookingParticipantsResult = await pool.query(
    `SELECT COUNT(*) as count FROM booking_participants WHERE user_id = $1`,
    [secondaryUserId]
  );
  const bookingParticipantsCount = parseInt(bookingParticipantsResult.rows[0]?.count || '0');
  
  // Count day pass purchases (uses user_id and purchaser_email columns)
  const dayPassResult = await pool.query(
    `SELECT COUNT(*) as count FROM day_pass_purchases WHERE user_id = $1 OR LOWER(purchaser_email) = $2`,
    [secondaryUserId, secondaryEmail]
  );
  const dayPassCount = parseInt(dayPassResult.rows[0]?.count || '0');
  
  // Count legacy purchases (uses user_id and member_email columns)
  const legacyPurchasesResult = await pool.query(
    `SELECT COUNT(*) as count FROM legacy_purchases WHERE user_id = $1 OR LOWER(member_email) = $2`,
    [secondaryUserId, secondaryEmail]
  );
  const legacyPurchasesCount = parseInt(legacyPurchasesResult.rows[0]?.count || '0');
  
  // Count group members (uses member_email column)
  const groupMembersResult = await pool.query(
    `SELECT COUNT(*) as count FROM group_members WHERE LOWER(member_email) = $1`,
    [secondaryEmail]
  );
  const groupMembersCount = parseInt(groupMembersResult.rows[0]?.count || '0');
  
  // Count push subscriptions (uses user_email column)
  const pushSubscriptionsResult = await pool.query(
    `SELECT COUNT(*) as count FROM push_subscriptions WHERE LOWER(user_email) = $1`,
    [secondaryEmail]
  );
  const pushSubscriptionsCount = parseInt(pushSubscriptionsResult.rows[0]?.count || '0');
  
  // Count dismissed notices (uses user_email column)
  const dismissedNoticesResult = await pool.query(
    `SELECT COUNT(*) as count FROM user_dismissed_notices WHERE LOWER(user_email) = $1`,
    [secondaryEmail]
  );
  const dismissedNoticesCount = parseInt(dismissedNoticesResult.rows[0]?.count || '0');
  
  // Count billing groups where user is primary payer (uses primary_email column)
  const billingGroupsResult = await pool.query(
    `SELECT COUNT(*) as count FROM billing_groups WHERE LOWER(primary_email) = $1`,
    [secondaryEmail]
  );
  const billingGroupsCount = parseInt(billingGroupsResult.rows[0]?.count || '0');
  
  // Count bug reports (uses user_email column)
  const bugReportsResult = await pool.query(
    `SELECT COUNT(*) as count FROM bug_reports WHERE LOWER(user_email) = $1`,
    [secondaryEmail]
  );
  const bugReportsCount = parseInt(bugReportsResult.rows[0]?.count || '0');
  
  // Count data export requests (uses user_email column)
  const dataExportResult = await pool.query(
    `SELECT COUNT(*) as count FROM data_export_requests WHERE LOWER(user_email) = $1`,
    [secondaryEmail]
  );
  const dataExportCount = parseInt(dataExportResult.rows[0]?.count || '0');
  
  // Count HubSpot deals (uses member_email column)
  const hubspotDealsResult = await pool.query(
    `SELECT COUNT(*) as count FROM hubspot_deals WHERE LOWER(member_email) = $1`,
    [secondaryEmail]
  );
  const hubspotDealsCount = parseInt(hubspotDealsResult.rows[0]?.count || '0');
  
  // Count Stripe payment intents (uses user_id column)
  const stripePaymentIntentsResult = await pool.query(
    `SELECT COUNT(*) as count FROM stripe_payment_intents WHERE user_id = $1`,
    [secondaryUserId]
  );
  const stripePaymentIntentsCount = parseInt(stripePaymentIntentsResult.rows[0]?.count || '0');
  
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
  if (secondaryUser.archivedAt) throw new Error('Secondary user has already been archived/merged');
  
  const primaryEmail = primaryUser.email?.toLowerCase() || '';
  const secondaryEmail = secondaryUser.email?.toLowerCase() || '';
  
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
  };
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const bookingsResult = await client.query(
      `UPDATE booking_requests 
       SET user_email = $1, user_id = $2, updated_at = NOW(),
           staff_notes = COALESCE(staff_notes, '') || ' [Merged from ' || $3 || ']'
       WHERE (LOWER(user_email) = $3 OR user_id = $4)`,
      [primaryEmail, primaryUserId, secondaryEmail, secondaryUserId]
    );
    recordsMerged.bookings = bookingsResult.rowCount || 0;
    
    await client.query(
      `UPDATE booking_members SET user_email = $1 WHERE LOWER(user_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    
    // Visits are tracked via booking_requests status - no separate table to update
    // Just count how many attended bookings were transferred
    const attendedResult = await client.query(
      `SELECT COUNT(*) as count FROM booking_requests 
       WHERE (LOWER(user_email) = $1 OR user_id = $2) AND status = 'attended'`,
      [primaryEmail, primaryUserId]
    );
    recordsMerged.visits = parseInt(attendedResult.rows[0]?.count || '0');
    
    // Update wellness enrollments
    const wellnessResult = await client.query(
      `UPDATE wellness_enrollments SET user_email = $1 WHERE LOWER(user_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.wellnessBookings = wellnessResult.rowCount || 0;
    
    // Update event RSVPs (uses user_email column)
    const eventRsvpsResult = await client.query(
      `UPDATE event_rsvps SET user_email = $1 WHERE LOWER(user_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.eventRsvps = eventRsvpsResult.rowCount || 0;
    
    // Update notifications (uses user_email column)
    const notificationsResult = await client.query(
      `UPDATE notifications SET user_email = $1 WHERE LOWER(user_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.notifications = notificationsResult.rowCount || 0;
    
    const memberNotesResult = await client.query(
      `UPDATE member_notes SET member_email = $1, updated_at = NOW() WHERE LOWER(member_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.memberNotes = memberNotesResult.rowCount || 0;
    
    // Update guest check-ins (uses member_email column)
    const guestCheckInsResult = await client.query(
      `UPDATE guest_check_ins SET member_email = $1 WHERE LOWER(member_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.guestCheckIns = guestCheckInsResult.rowCount || 0;
    
    // Update usage ledger (uses member_id column)
    const usageLedgerResult = await client.query(
      `UPDATE usage_ledger SET member_id = $1 WHERE member_id = $2`,
      [primaryUserId, secondaryUserId]
    );
    recordsMerged.usageLedger = usageLedgerResult.rowCount || 0;
    
    await client.query(
      `UPDATE communication_logs SET member_email = $1, updated_at = NOW() WHERE LOWER(member_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    
    await client.query(
      `UPDATE guest_passes SET member_email = $1 WHERE LOWER(member_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    
    // Update booking participants (uses user_id column)
    // DEDUPLICATE: If primary user is already in a session, remove secondary user's duplicate record
    await client.query(
      `DELETE FROM booking_participants 
       WHERE user_id = $1 
       AND session_id IN (SELECT session_id FROM booking_participants WHERE user_id = $2)`,
      [secondaryUserId, primaryUserId]
    );
    
    const bookingParticipantsResult = await client.query(
      `UPDATE booking_participants SET user_id = $1 WHERE user_id = $2`,
      [primaryUserId, secondaryUserId]
    );
    recordsMerged.bookingParticipants = bookingParticipantsResult.rowCount || 0;
    
    // Update day pass purchases (uses user_id and purchaser_email columns)
    const dayPassResult = await client.query(
      `UPDATE day_pass_purchases SET user_id = $1, purchaser_email = $2 
       WHERE user_id = $3 OR LOWER(purchaser_email) = $4`,
      [primaryUserId, primaryEmail, secondaryUserId, secondaryEmail]
    );
    recordsMerged.dayPassPurchases = dayPassResult.rowCount || 0;
    
    // Update legacy purchases (uses user_id and member_email columns)
    const legacyPurchasesResult = await client.query(
      `UPDATE legacy_purchases SET user_id = $1, member_email = $2 
       WHERE user_id = $3 OR LOWER(member_email) = $4`,
      [primaryUserId, primaryEmail, secondaryUserId, secondaryEmail]
    );
    recordsMerged.legacyPurchases = legacyPurchasesResult.rowCount || 0;
    
    // Update group members (uses member_email column)
    // DEDUPLICATE: If primary email is already in a group, remove secondary email's duplicate record
    await client.query(
      `DELETE FROM group_members 
       WHERE LOWER(member_email) = $1 
       AND group_id IN (SELECT group_id FROM group_members WHERE LOWER(member_email) = $2)`,
      [secondaryEmail, primaryEmail]
    );
    
    const groupMembersResult = await client.query(
      `UPDATE group_members SET member_email = $1 WHERE LOWER(member_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.groupMembers = groupMembersResult.rowCount || 0;
    
    // Update push subscriptions (uses user_email column)
    // DEDUPLICATE: If same endpoint exists for primary, remove secondary's duplicate subscription
    await client.query(
      `DELETE FROM push_subscriptions
       WHERE LOWER(user_email) = $1
       AND endpoint IN (SELECT endpoint FROM push_subscriptions WHERE LOWER(user_email) = $2)`,
      [secondaryEmail, primaryEmail]
    );
    
    const pushSubscriptionsResult = await client.query(
      `UPDATE push_subscriptions SET user_email = $1 WHERE LOWER(user_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.pushSubscriptions = pushSubscriptionsResult.rowCount || 0;
    
    // Update dismissed notices (uses user_email column)
    const dismissedNoticesResult = await client.query(
      `UPDATE user_dismissed_notices SET user_email = $1 WHERE LOWER(user_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.dismissedNotices = dismissedNoticesResult.rowCount || 0;
    
    // Update billing groups where user is primary payer (uses primary_email column)
    const billingGroupsResult = await client.query(
      `UPDATE billing_groups SET primary_email = $1 WHERE LOWER(primary_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.billingGroups = billingGroupsResult.rowCount || 0;
    
    // Update bug reports (uses user_email column)
    const bugReportsResult = await client.query(
      `UPDATE bug_reports SET user_email = $1 WHERE LOWER(user_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.bugReports = bugReportsResult.rowCount || 0;
    
    // Update data export requests (uses user_email column)
    const dataExportResult = await client.query(
      `UPDATE data_export_requests SET user_email = $1 WHERE LOWER(user_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.dataExportRequests = dataExportResult.rowCount || 0;
    
    // Update HubSpot deals (uses member_email column)
    const hubspotDealsResult = await client.query(
      `UPDATE hubspot_deals SET member_email = $1 WHERE LOWER(member_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.hubspotDeals = hubspotDealsResult.rowCount || 0;
    
    // Update Stripe payment intents (uses user_id column)
    const stripePaymentIntentsResult = await client.query(
      `UPDATE stripe_payment_intents SET user_id = $1 WHERE user_id = $2`,
      [primaryUserId, secondaryUserId]
    );
    recordsMerged.stripePaymentIntents = stripePaymentIntentsResult.rowCount || 0;
    
    // Update user_linked_emails (uses primary_email column, not user_id)
    await client.query(
      `UPDATE user_linked_emails SET primary_email = $1 WHERE LOWER(primary_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    
    // Add secondary email as a linked email for the primary user
    if (secondaryEmail && secondaryEmail !== primaryEmail) {
      const existingLink = await client.query(
        `SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = $1`,
        [secondaryEmail]
      );
      
      if (existingLink.rows.length === 0) {
        await client.query(
          `INSERT INTO user_linked_emails (primary_email, linked_email, source, created_at)
           VALUES ($1, $2, 'user_merge', NOW())
           ON CONFLICT (linked_email) DO NOTHING`,
          [primaryEmail, secondaryEmail]
        );
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
    
    const mergeInfo = {
      mergedFrom: secondaryUserId,
      mergedFromEmail: secondaryEmail,
      mergedFromName: `${secondaryUser.firstName || ''} ${secondaryUser.lastName || ''}`.trim(),
      mergedAt: new Date().toISOString(),
      mergedBy: performedBy,
      secondaryStripeCustomerId: secondaryUser.stripeCustomerId,
      secondaryHubspotId: secondaryUser.hubspotId,
    };
    
    const currentTags = (primaryUser.tags as any[]) || [];
    const updatedTags = [...currentTags, { type: 'merge_record', ...mergeInfo }];
    
    await client.query(
      `UPDATE users SET
         lifetime_visits = $1,
         join_date = $2,
         waiver_version = $3,
         waiver_signed_at = $4,
         tags = $5,
         updated_at = NOW()
       WHERE id = $6`,
      [combinedVisits, earlierJoinDate, newerWaiver.version, newerWaiver.signedAt, JSON.stringify(updatedTags), primaryUserId]
    );
    
    const secondaryTags = (secondaryUser.tags as any[]) || [];
    const archiveTags = [...secondaryTags, { 
      type: 'merged_into', 
      primaryUserId, 
      primaryEmail,
      mergedAt: new Date().toISOString(),
      mergedBy: performedBy
    }];
    
    await client.query(
      `UPDATE users SET
         archived_at = NOW(),
         archived_by = $1,
         membership_status = 'merged',
         tags = $2,
         updated_at = NOW()
       WHERE id = $3`,
      [performedBy, JSON.stringify(archiveTags), secondaryUserId]
    );
    
    await client.query('COMMIT');
    
    logger.info('[UserMerge] Successfully merged users', {
      extra: { primaryUserId, secondaryUserId, performedBy, recordsMerged }
    });
    
    return {
      success: true,
      primaryUserId,
      secondaryUserId,
      recordsMerged,
      mergedLifetimeVisits: combinedVisits,
      secondaryArchived: true,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('[UserMerge] Failed to merge users', { extra: { primaryUserId, secondaryUserId, error } });
    throw error;
  } finally {
    client.release();
  }
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
    const nameMatches = await pool.query(
      `SELECT id, email, first_name, last_name, tier, membership_status
       FROM users 
       WHERE id != $1 
         AND archived_at IS NULL
         AND LOWER(CONCAT(first_name, ' ', last_name)) = $2
       LIMIT 10`,
      [userId, fullName]
    );
    
    for (const row of nameMatches.rows) {
      duplicates.push({
        id: row.id,
        email: row.email || '',
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        tier: row.tier,
        membershipStatus: row.membership_status,
        matchReason: 'Same name',
      });
    }
  }
  
  if (user.phone) {
    const phoneMatches = await pool.query(
      `SELECT id, email, first_name, last_name, tier, membership_status
       FROM users 
       WHERE id != $1 
         AND archived_at IS NULL
         AND phone = $2
         AND id NOT IN (SELECT unnest($3::text[]))
       LIMIT 5`,
      [userId, user.phone, duplicates.map(d => d.id)]
    );
    
    for (const row of phoneMatches.rows) {
      duplicates.push({
        id: row.id,
        email: row.email || '',
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        tier: row.tier,
        membershipStatus: row.membership_status,
        matchReason: 'Same phone number',
      });
    }
  }
  
  if (user.mindbodyClientId) {
    const mbMatches = await pool.query(
      `SELECT id, email, first_name, last_name, tier, membership_status
       FROM users 
       WHERE id != $1 
         AND archived_at IS NULL
         AND mindbody_client_id = $2
         AND id NOT IN (SELECT unnest($3::text[]))
       LIMIT 5`,
      [userId, user.mindbodyClientId, duplicates.map(d => d.id)]
    );
    
    for (const row of mbMatches.rows) {
      duplicates.push({
        id: row.id,
        email: row.email || '',
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        tier: row.tier,
        membershipStatus: row.membership_status,
        matchReason: 'Same MindBody ID',
      });
    }
  }
  
  if (user.hubspotId) {
    const hsMatches = await pool.query(
      `SELECT id, email, first_name, last_name, tier, membership_status
       FROM users 
       WHERE id != $1 
         AND archived_at IS NULL
         AND hubspot_id = $2
         AND id NOT IN (SELECT unnest($3::text[]))
       LIMIT 5`,
      [userId, user.hubspotId, duplicates.map(d => d.id)]
    );
    
    for (const row of hsMatches.rows) {
      duplicates.push({
        id: row.id,
        email: row.email || '',
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        tier: row.tier,
        membershipStatus: row.membership_status,
        matchReason: 'Same HubSpot ID',
      });
    }
  }
  
  return duplicates;
}
