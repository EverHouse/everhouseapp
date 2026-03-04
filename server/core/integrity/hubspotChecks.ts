import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { Client } from '@hubspot/api-client';
import { getErrorMessage, getErrorStatusCode } from '../../utils/errorUtils';
import { logger } from '../logger';
import { getHubSpotClient } from '../integrations';
import { isProduction } from '../db';
import { denormalizeTierForHubSpot } from '../../utils/tierUtils';
import type {
  IntegrityCheckResult,
  IntegrityIssue,
  SyncComparisonData,
  MemberRow,
  DealWithoutLineItemRow,
  DealStageDriftRow,
  HubSpotDuplicateRow,
  LinkedCountRow,
} from './core';
import { CHURNED_STATUSES, NO_TIER_STATUSES } from './core';

export async function checkHubSpotSyncMismatch(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  let hubspot: Client;
  try {
    hubspot = await getHubSpotClient();
  } catch (err: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] HubSpot API error:', { error: err });
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'hubspot_sync',
      recordId: 'hubspot_api',
      description: 'Unable to connect to HubSpot - API may be unavailable',
      suggestion: 'Check HubSpot integration connection'
    });

    return {
      checkName: 'HubSpot Sync Mismatch',
      status: 'warning',
      issueCount: issues.length,
      issues,
      lastRun: new Date()
    };
  }

  const appMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, membership_tier, hubspot_id, tier, membership_status
    FROM users 
    WHERE hubspot_id IS NOT NULL
      AND archived_at IS NULL
      AND membership_status != 'merged'
    ORDER BY RANDOM()
    LIMIT 100
  `);
  const appMembers = appMembersResult.rows as unknown as MemberRow[];

  for (const member of appMembers) {
    if (!member.hubspot_id) continue;

    try {
      const hubspotContact = await hubspot.crm.contacts.basicApi.getById(
        String(member.hubspot_id),
        ['firstname', 'lastname', 'email', 'membership_tier']
      );

      const props = hubspotContact.properties || {};
      const comparisons: SyncComparisonData[] = [];

      const appFirstName = String(member.first_name || '').trim().toLowerCase();
      const hsFirstName = (props.firstname || '').trim().toLowerCase();
      if (appFirstName !== hsFirstName) {
        comparisons.push({
          field: 'First Name',
          appValue: member.first_name || null,
          externalValue: props.firstname || null
        });
      }

      const appLastName = String(member.last_name || '').trim().toLowerCase();
      const hsLastName = (props.lastname || '').trim().toLowerCase();
      if (appLastName !== hsLastName) {
        comparisons.push({
          field: 'Last Name',
          appValue: member.last_name || null,
          externalValue: props.lastname || null
        });
      }

      const memberStatus = String(member.membership_status || '').toLowerCase();
      const isChurned = CHURNED_STATUSES.includes(memberStatus);
      const isNoTierStatus = NO_TIER_STATUSES.includes(memberStatus);
      const expectedHubSpotTier = (isChurned || isNoTierStatus || !member.tier)
        ? null
        : denormalizeTierForHubSpot(String(member.tier));
      const hsTierRaw = props.membership_tier || null;
      const expectedNorm = (expectedHubSpotTier || '').trim().toLowerCase();
      const hsNorm = (hsTierRaw || '').trim().toLowerCase();
      if (!expectedNorm && !hsNorm) {
      } else if (expectedNorm !== hsNorm) {
        comparisons.push({
          field: 'Membership Tier',
          appValue: expectedHubSpotTier || null,
          externalValue: hsTierRaw
        });
      }

      if (comparisons.length > 0) {
        const fieldList = comparisons.map(c => c.field).join(', ');
        issues.push({
          category: 'sync_mismatch',
          severity: 'warning',
          table: 'users',
          recordId: member.id as string | number,
          description: `Member "${member.first_name} ${member.last_name}" has mismatched data: ${fieldList}`,
          suggestion: 'Sync data between app and HubSpot',
          context: {
            memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim() || undefined,
            memberEmail: member.email || undefined,
            memberTier: member.tier || undefined,
            syncType: 'hubspot',
            syncComparison: comparisons,
            hubspotContactId: member.hubspot_id,
            userId: Number(member.id)
          }
        });
      }
    } catch (err: unknown) {
      if (getErrorStatusCode(err) === 404) {
        issues.push({
          category: 'sync_mismatch',
          severity: 'error',
          table: 'users',
          recordId: member.id as string | number,
          description: `Member "${member.first_name} ${member.last_name}" (hubspot_id: ${member.hubspot_id}) not found in HubSpot`,
          suggestion: 'Remove stale HubSpot ID or re-sync member',
          context: {
            memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim() || undefined,
            memberEmail: member.email || undefined,
            syncType: 'hubspot',
            hubspotContactId: member.hubspot_id,
            userId: Number(member.id)
          }
        });
      }
    }
  }

  const staleHubSpotIssues = issues.filter(i => i.description.includes('not found in HubSpot'));
  if (staleHubSpotIssues.length > 0) {
    for (const issue of staleHubSpotIssues) {
      const userId = issue.recordId;
      await db.execute(sql`UPDATE users SET hubspot_id = NULL, updated_at = NOW() WHERE id = ${userId}`);
      logger.info(`[AutoFix] Cleared stale HubSpot ID for user ${issue.context?.memberEmail}`);
    }
  }

  return {
    checkName: 'HubSpot Sync Mismatch',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'error') ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkDealsWithoutLineItems(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const dealsWithoutLineItems = await db.execute(sql`
    SELECT hd.id, hd.member_email, hd.hubspot_deal_id, hd.deal_name, hd.pipeline_stage
    FROM hubspot_deals hd
    LEFT JOIN hubspot_line_items hli ON hd.hubspot_deal_id = hli.hubspot_deal_id
    WHERE hli.id IS NULL
      AND hd.deal_name NOT LIKE '%(Legacy)%'
  `);

  for (const row of dealsWithoutLineItems.rows as unknown as DealWithoutLineItemRow[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'hubspot_deals',
      recordId: row.id,
      description: `Deal "${row.deal_name || 'Unnamed'}" for ${row.member_email} has no product line items`,
      suggestion: 'Add product line items to this deal in the billing section or HubSpot',
      context: {
        memberEmail: row.member_email || undefined
      }
    });
  }

  return {
    checkName: 'Deals Without Line Items',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkDealStageDrift(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const STAGE_MAPPING: Record<string, string> = {
    'active': 'closedwon',
    'pending': '2825519820',
    'declined': '2825519820',
    'suspended': '2825519820',
    'expired': '2825519820',
    'froze': '2825519820',
    'frozen': '2825519820',
    'past_due': '2825519820',
    'pastdue': '2825519820',
    'paymentfailed': '2825519820',
    'terminated': 'closedlost',
    'cancelled': 'closedlost',
    'non-member': 'closedlost',
    'nonmember': 'closedlost'
  };

  const STAGE_NAMES: Record<string, string> = {
    'closedwon': 'Active Members',
    '2825519820': 'Payment Declined',
    'closedlost': 'Closed Lost'
  };

  const driftingDeals = await db.execute(sql`
    SELECT 
      hd.id,
      hd.member_email,
      hd.hubspot_deal_id,
      hd.deal_name,
      hd.pipeline_stage as current_stage,
      u.membership_status,
      u.first_name,
      u.last_name,
      u.tier
    FROM hubspot_deals hd
    JOIN users u ON LOWER(u.email) = LOWER(hd.member_email)
    WHERE u.role = 'member'
      AND hd.pipeline_stage IS NOT NULL
      AND u.membership_status IS NOT NULL
  `);

  for (const row of driftingDeals.rows as unknown as DealStageDriftRow[]) {
    const membershipStatus = String(row.membership_status || 'non-member').toLowerCase();
    const expectedStage = STAGE_MAPPING[membershipStatus] || 'closedlost';
    const currentStage = row.current_stage;

    if (currentStage !== expectedStage) {
      const memberName = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown';
      const expectedStageName = STAGE_NAMES[expectedStage] || expectedStage;
      const currentStageName = STAGE_NAMES[currentStage] || currentStage;

      issues.push({
        category: 'sync_mismatch',
        severity: 'error',
        table: 'hubspot_deals',
        recordId: row.id,
        description: `Deal for ${row.member_email} is in "${currentStageName}" but membership status is "${membershipStatus}" (should be in "${expectedStageName}")`,
        suggestion: `Update deal stage to match membership status or correct membership status in HubSpot`,
        context: {
          memberName,
          memberEmail: row.member_email,
          memberTier: row.tier || undefined,
          syncType: 'hubspot',
          syncComparison: [
            { field: 'Deal Stage', appValue: currentStageName, externalValue: expectedStageName },
            { field: 'Membership Status', appValue: membershipStatus, externalValue: null }
          ]
        }
      });
    }
  }

  return {
    checkName: 'Deal Stage Drift',
    status: issues.length === 0 ? 'pass' : issues.length > 10 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkHubSpotIdDuplicates(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  try {
    const duplicatesResult = await db.execute(sql`
      SELECT 
        u.hubspot_id,
        ARRAY_AGG(u.email ORDER BY u.membership_status = 'active' DESC, u.lifetime_visits DESC) as emails,
        ARRAY_AGG(u.id ORDER BY u.membership_status = 'active' DESC, u.lifetime_visits DESC) as user_ids,
        ARRAY_AGG(COALESCE(u.membership_status, 'unknown') ORDER BY u.membership_status = 'active' DESC, u.lifetime_visits DESC) as statuses,
        ARRAY_AGG(COALESCE(u.tier, 'none') ORDER BY u.membership_status = 'active' DESC, u.lifetime_visits DESC) as tiers,
        COUNT(*) as user_count
      FROM users u
      WHERE u.hubspot_id IS NOT NULL
        AND u.archived_at IS NULL
        AND u.membership_status != 'merged'
      GROUP BY u.hubspot_id
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 50
    `);

    const duplicates = duplicatesResult.rows as unknown as HubSpotDuplicateRow[];

    for (const dup of duplicates) {
      const emails = dup.emails;
      const statuses = dup.statuses;
      const tiers = dup.tiers;

      const remainingEmails = emails.slice(1);
      let alreadyLinked = false;
      if (remainingEmails.length > 0) {
        const linkedCheck = await db.execute(sql`
          SELECT COUNT(*) as linked_count 
          FROM user_linked_emails 
          WHERE LOWER(primary_email) = LOWER(${emails[0]}) 
            AND LOWER(linked_email) IN (${sql.join(remainingEmails.map((e: string) => sql`${e.toLowerCase()}`), sql`, `)})
        `);
        alreadyLinked = parseInt((linkedCheck.rows[0] as unknown as LinkedCountRow)?.linked_count || '0') > 0;
      }

      const userDetails = emails.map((email: string, idx: number) =>
        `${email} (${statuses[idx]}, ${tiers[idx]})`
      ).join(', ');

      issues.push({
        category: 'data_quality',
        severity: alreadyLinked ? 'info' : 'warning',
        table: 'users',
        recordId: dup.hubspot_id,
        description: `HubSpot contact ${dup.hubspot_id} is shared by ${dup.user_count} users: ${userDetails}${alreadyLinked ? ' (emails already linked)' : ''}`,
        suggestion: alreadyLinked
          ? 'Emails are linked. Consider merging these users if they are the same person.'
          : 'Link these emails or merge users if they represent the same person.',
        context: {
          hubspotContactId: dup.hubspot_id,
          memberEmail: emails[0],
          duplicateUsers: emails.map((email: string, idx: number) => ({
            userId: dup.user_ids[idx],
            email,
            status: statuses[idx],
            tier: tiers[idx]
          }))
        }
      });
    }
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Error checking HubSpot ID duplicates:', { extra: { detail: getErrorMessage(error) } });
  }

  return {
    checkName: 'HubSpot ID Duplicates',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'warning') ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}
