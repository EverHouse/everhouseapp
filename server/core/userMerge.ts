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
  
  const bookingsResult = await pool.query(
    `SELECT COUNT(*) as count FROM booking_requests WHERE LOWER(user_email) = $1 OR user_id = $2`,
    [secondaryEmail, secondaryUserId]
  );
  const bookingsCount = bookingsResult.rows[0];
  
  const visitsResult = await pool.query(
    `SELECT COUNT(*) as count FROM visits WHERE LOWER(member_email) = $1`,
    [secondaryEmail]
  );
  const visitsCount = visitsResult.rows[0];
  
  const wellnessResult = await pool.query(
    `SELECT COUNT(*) as count FROM wellness_bookings WHERE LOWER(member_email) = $1`,
    [secondaryEmail]
  );
  const wellnessCount = wellnessResult.rows[0];
  
  const eventRsvpsResult = await pool.query(
    `SELECT COUNT(*) as count FROM event_rsvps WHERE LOWER(member_email) = $1`,
    [secondaryEmail]
  );
  const eventRsvpsCount = eventRsvpsResult.rows[0];
  
  const notificationsResult = await pool.query(
    `SELECT COUNT(*) as count FROM notifications WHERE user_id = $1`,
    [secondaryUserId]
  );
  const notificationsCount = notificationsResult.rows[0];
  
  const memberNotesResult = await pool.query(
    `SELECT COUNT(*) as count FROM member_notes WHERE LOWER(member_email) = $1`,
    [secondaryEmail]
  );
  const memberNotesCount = memberNotesResult.rows[0];
  
  const guestCheckInsResult = await pool.query(
    `SELECT COUNT(*) as count FROM guest_check_ins WHERE LOWER(host_email) = $1`,
    [secondaryEmail]
  );
  const guestCheckInsCount = guestCheckInsResult.rows[0];
  
  const usageLedgerResult = await pool.query(
    `SELECT COUNT(*) as count FROM usage_ledger WHERE user_id = $1`,
    [secondaryUserId]
  );
  const usageLedgerCount = usageLedgerResult.rows[0];
  
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
      bookings: parseInt(bookingsCount.rows[0]?.count || '0'),
      visits: parseInt(visitsCount.rows[0]?.count || '0'),
      wellnessBookings: parseInt(wellnessCount.rows[0]?.count || '0'),
      eventRsvps: parseInt(eventRsvpsCount.rows[0]?.count || '0'),
      notifications: parseInt(notificationsCount.rows[0]?.count || '0'),
      memberNotes: parseInt(memberNotesCount.rows[0]?.count || '0'),
      guestCheckIns: parseInt(guestCheckInsCount.rows[0]?.count || '0'),
      usageLedger: parseInt(usageLedgerCount.rows[0]?.count || '0'),
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
    
    const visitsResult = await client.query(
      `UPDATE visits SET member_email = $1 WHERE LOWER(member_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.visits = visitsResult.rowCount || 0;
    
    const wellnessResult = await client.query(
      `UPDATE wellness_bookings SET member_email = $1, updated_at = NOW() WHERE LOWER(member_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.wellnessBookings = wellnessResult.rowCount || 0;
    
    const eventRsvpsResult = await client.query(
      `UPDATE event_rsvps SET member_email = $1 WHERE LOWER(member_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.eventRsvps = eventRsvpsResult.rowCount || 0;
    
    const notificationsResult = await client.query(
      `UPDATE notifications SET user_id = $1 WHERE user_id = $2`,
      [primaryUserId, secondaryUserId]
    );
    recordsMerged.notifications = notificationsResult.rowCount || 0;
    
    const memberNotesResult = await client.query(
      `UPDATE member_notes SET member_email = $1, updated_at = NOW() WHERE LOWER(member_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.memberNotes = memberNotesResult.rowCount || 0;
    
    const guestCheckInsResult = await client.query(
      `UPDATE guest_check_ins SET host_email = $1 WHERE LOWER(host_email) = $2`,
      [primaryEmail, secondaryEmail]
    );
    recordsMerged.guestCheckIns = guestCheckInsResult.rowCount || 0;
    
    const usageLedgerResult = await client.query(
      `UPDATE usage_ledger SET user_id = $1 WHERE user_id = $2`,
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
    
    await client.query(
      `UPDATE user_linked_emails SET user_id = $1 WHERE user_id = $2`,
      [primaryUserId, secondaryUserId]
    );
    
    if (secondaryEmail && secondaryEmail !== primaryEmail) {
      const existingLink = await client.query(
        `SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = $1`,
        [secondaryEmail]
      );
      
      if (existingLink.rows.length === 0) {
        await client.query(
          `INSERT INTO user_linked_emails (user_id, linked_email, source, created_at)
           VALUES ($1, $2, 'user_merge', NOW())
           ON CONFLICT (LOWER(linked_email)) DO NOTHING`,
          [primaryUserId, secondaryEmail]
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
