import { db } from '../../db';
import { sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { Client } from '@hubspot/api-client';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../logger';
import { getHubSpotClientWithFallback } from '../integrations';
import { isProduction } from '../db';
import { getStripeClient } from '../stripe/client';
import { retryableHubSpotRequest } from '../hubspot/request';
import type {
  IntegrityCheckResult,
  IntegrityIssue,
  SyncComparisonData,
  MemberRow,
  NoEmailMemberRow,
  StuckMemberRow,
  StaleMindBodyRow,
  MindBodyMismatchRow,
  OrphanGuestPassRow,
  HubSpotBatchReadResult,
} from './core';

export async function checkMembersWithoutEmail(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const noEmailMembers = await db.execute(sql`
    SELECT id, first_name, last_name, hubspot_id, membership_tier
    FROM users
    WHERE email IS NULL OR email = ''
  `);

  for (const row of noEmailMembers.rows as unknown as NoEmailMemberRow[]) {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown';
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'users',
      recordId: row.id,
      description: `Member "${name}" (id: ${row.id}) has no email address`,
      suggestion: 'Add an email address for this member or merge with existing record',
      context: {
        memberName: name,
        memberTier: row.membership_tier || undefined
      }
    });
  }

  return {
    checkName: 'Members Without Email',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkStuckTransitionalMembers(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const stuckMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, stripe_subscription_id, stripe_customer_id, updated_at
    FROM users 
    WHERE stripe_subscription_id IS NOT NULL
      AND membership_status IN ('pending', 'non-member')
      AND updated_at < NOW() - INTERVAL '24 hours'
      AND role = 'member'
      AND (billing_provider IS NULL OR billing_provider NOT IN ('mindbody', 'family_addon', 'comped'))
    ORDER BY updated_at ASC
    LIMIT 50
  `);
  const stuckMembers = stuckMembersResult.rows as unknown as StuckMemberRow[];

  let stripe: Stripe | undefined;
  try {
    stripe = await getStripeClient();
  } catch {
    logger.debug('[DataIntegrity] Could not connect to Stripe for stuck member check');
  }

  for (const member of stuckMembers) {
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const subId = member.stripe_subscription_id;

    if (stripe && subId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        const deadStatuses = ['incomplete_expired', 'canceled'];
        if (deadStatuses.includes(sub.status)) {
          await db.execute(sql`
            UPDATE users 
            SET stripe_subscription_id = NULL, 
                membership_status = 'non-member',
                updated_at = NOW()
            WHERE id = ${member.id}
              AND stripe_subscription_id = ${subId}
          `);
          logger.info(`[DataIntegrity] Auto-cleaned dead subscription for "${memberName}" <${member.email}> (Stripe status: ${sub.status})`);
          continue;
        }
      } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        if (errMsg.includes('No such subscription') || errMsg.includes('resource_missing')) {
          await db.execute(sql`
            UPDATE users 
            SET stripe_subscription_id = NULL, 
                membership_status = 'non-member',
                updated_at = NOW()
            WHERE id = ${member.id}
              AND stripe_subscription_id = ${subId}
          `);
          logger.info(`[DataIntegrity] Auto-cleaned missing subscription for "${memberName}" <${member.email}> (subscription not found in Stripe)`);
          continue;
        }
        logger.debug(`[DataIntegrity] Could not verify subscription for "${memberName}": ${errMsg}`);
      }
    }

    const hoursStuck = Math.round((Date.now() - new Date(member.updated_at).getTime()) / (1000 * 60 * 60));

    issues.push({
      category: 'sync_mismatch',
      severity: 'error',
      table: 'users',
      recordId: member.id,
      description: `Member "${memberName}" has Stripe subscription but is stuck in '${member.membership_status}' status for ${hoursStuck} hours`,
      suggestion: 'Check Stripe webhook delivery or manually sync membership status',
      context: {
        memberName,
        memberEmail: member.email,
        memberTier: member.tier,
        stripeCustomerId: member.stripe_subscription_id,
        userId: Number(member.id)
      }
    });
  }

  return {
    checkName: 'Stuck Transitional Members',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkTierReconciliation(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  let stripe: Stripe;
  try {
    stripe = await getStripeClient();
  } catch (err: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Stripe API error for tier reconciliation:', { error: err });
    return {
      checkName: 'Tier Reconciliation',
      status: 'warning',
      issueCount: 0,
      issues: [{
        category: 'sync_mismatch',
        severity: 'info',
        table: 'stripe_sync',
        recordId: 'stripe_api',
        description: 'Unable to connect to Stripe for tier reconciliation',
        suggestion: 'Check Stripe integration connection'
      }],
      lastRun: new Date()
    };
  }

  let hubspot: Client | undefined;
  try {
    const hsResult = await getHubSpotClientWithFallback();
    hubspot = hsResult.client;
  } catch (err: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] HubSpot API error for tier reconciliation:', { error: err });
  }

  const appMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, stripe_customer_id, hubspot_id, billing_provider
    FROM users 
    WHERE stripe_customer_id IS NOT NULL
      AND role = 'member'
      AND (billing_provider IS NULL OR billing_provider NOT IN ('mindbody', 'family_addon', 'comped'))
    ORDER BY id
  `);
  const appMembers = appMembersResult.rows as unknown as MemberRow[];

  if (appMembers.length === 0) {
    return {
      checkName: 'Tier Reconciliation',
      status: 'pass',
      issueCount: 0,
      issues: [],
      lastRun: new Date()
    };
  }

  const productMap = new Map<string, { name: string; tier: string }>();

  const hubspotTierMap = new Map<string, string>();
  if (hubspot) {
    const membersWithHubspot = appMembers.filter((m: MemberRow) => m.hubspot_id);
    for (let h = 0; h < membersWithHubspot.length; h += 100) {
      const hsBatch = membersWithHubspot.slice(h, h + 100);
      try {
        const readResult = await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.batchApi.read({
            inputs: hsBatch.map((m: MemberRow) => ({ id: m.hubspot_id as string })),
            properties: ['membership_tier']
          } as unknown as Parameters<typeof hubspot.crm.contacts.batchApi.read>[0])
        );
        for (const contact of ((readResult as unknown as HubSpotBatchReadResult).results || [])) {
          hubspotTierMap.set(contact.id, (contact.properties?.membership_tier || '').toLowerCase().trim());
        }
      } catch (batchErr: unknown) {
        logger.warn('[DataIntegrity] HubSpot batch tier read failed:', { error: batchErr });
      }
    }
  }

  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 100;

  const processMember = async (member: MemberRow): Promise<void> => {
    const customerId = member.stripe_customer_id;
    if (!customerId) return;

    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const appTier = (member.tier || '').toLowerCase().trim();

    try {
      const customerSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 10,
        expand: ['data.items.data.price']
      });

      const activeSub = customerSubs.data?.find((s: Stripe.Subscription) =>
        ['active', 'trialing', 'past_due'].includes(s.status)
      );

      if (!activeSub) return;

      const item = activeSub.items?.data?.[0];
      const price = item?.price;
      const productId = typeof price?.product === 'string' ? price.product : price?.product?.id;

      if (!productId) return;

      let cached = productMap.get(productId);
      if (!cached) {
        const product = await stripe.products.retrieve(productId);
        cached = { name: product.name || '', tier: product.metadata?.tier || '' };
        productMap.set(productId, cached);
      }

      const stripeTier = (cached.tier).toLowerCase().trim();
      const productName = (cached.name).toLowerCase().trim();
      const stripeEffectiveTier = stripeTier || productName;

      let hubspotTier: string | null = null;
      if (member.hubspot_id && hubspotTierMap.has(member.hubspot_id)) {
        hubspotTier = hubspotTierMap.get(member.hubspot_id) || null;
      }

      const tierMismatches: SyncComparisonData[] = [];

      const tierMatches = (tier1: string, tier2: string): boolean => {
        if (!tier1 || !tier2) return true;
        return tier1.includes(tier2) || tier2.includes(tier1) || tier1 === tier2;
      };

      const appVsStripe = tierMatches(appTier, stripeEffectiveTier);
      const appVsHubspot = !hubspotTier || tierMatches(appTier, hubspotTier);
      const stripeVsHubspot = !hubspotTier || tierMatches(stripeEffectiveTier, hubspotTier);

      if (!appVsStripe) {
        tierMismatches.push({
          field: 'App Tier vs Stripe Product',
          appValue: member.tier || null,
          externalValue: cached.tier || cached.name || null
        });
      }

      if (!appVsHubspot && hubspotTier) {
        tierMismatches.push({
          field: 'App Tier vs HubSpot',
          appValue: member.tier || null,
          externalValue: hubspotTier
        });
      }

      if (!stripeVsHubspot && hubspotTier) {
        tierMismatches.push({
          field: 'Stripe Product vs HubSpot',
          appValue: cached.tier || cached.name || null,
          externalValue: hubspotTier
        });
      }

      if (tierMismatches.length > 0) {
        const mismatchDesc = tierMismatches.map(m => m.field).join(', ');
        issues.push({
          category: 'sync_mismatch',
          severity: 'warning',
          table: 'users',
          recordId: member.id,
          description: `Member "${memberName}" has tier mismatch: ${mismatchDesc}. App: "${member.tier || 'none'}", Stripe: "${cached.name || 'unknown'}", HubSpot: "${hubspotTier || 'not set'}"`,
          suggestion: 'Align tier across all systems using the Tier Change Wizard or manual sync',
          context: {
            memberName,
            memberEmail: member.email || undefined,
            memberTier: member.tier || undefined,
            syncType: 'stripe',
            stripeCustomerId: customerId,
            hubspotContactId: member.hubspot_id || undefined,
            userId: Number(member.id),
            syncComparison: tierMismatches
          }
        });
      }
    } catch (err: unknown) {
      if (!isProduction) logger.error(`[DataIntegrity] Error checking tier reconciliation for ${member.email}:`, { extra: { detail: getErrorMessage(err) } });
    }
  };

  for (let i = 0; i < appMembers.length; i += BATCH_SIZE) {
    const batch = appMembers.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(processMember));

    if (i + BATCH_SIZE < appMembers.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return {
    checkName: 'Tier Reconciliation',
    status: issues.length === 0 ? 'pass' : issues.length > 10 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkMindBodyStaleSyncMembers(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const staleSyncResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, updated_at, mindbody_client_id
    FROM users 
    WHERE billing_provider = 'mindbody'
      AND membership_status = 'active'
      AND role = 'member'
      AND updated_at < NOW() - INTERVAL '30 days'
    ORDER BY updated_at ASC
    LIMIT 50
  `);
  const staleMembers = staleSyncResult.rows as unknown as StaleMindBodyRow[];

  for (const member of staleMembers) {
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const lastUpdate = member.updated_at
      ? new Date(member.updated_at).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })
      : 'unknown';

    issues.push({
      category: 'sync_mismatch',
      severity: 'warning',
      table: 'users',
      recordId: member.id,
      description: `MindBody member "${memberName}" shows as active but record unchanged since ${lastUpdate}`,
      suggestion: 'Verify member is still active in MindBody or update their record',
      context: {
        memberName,
        memberEmail: member.email,
        memberTier: member.tier,
        lastUpdate: member.updated_at || undefined,
        mindbodyClientId: member.mindbody_client_id || undefined,
        userId: Number(member.id)
      }
    });
  }

  return {
    checkName: 'MindBody Stale Sync',
    status: issues.length === 0 ? 'pass' : issues.length > 10 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkMindBodyStatusMismatch(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const mismatchResult = await db.execute(sql`
    SELECT u.id, u.email, u.first_name, u.last_name, u.tier, u.membership_status, 
           u.billing_provider, u.mindbody_client_id
    FROM users u
    WHERE u.billing_provider = 'mindbody'
      AND u.role = 'member'
      AND (
        -- Active member without MindBody client ID
        (u.membership_status = 'active' AND (u.mindbody_client_id IS NULL OR u.mindbody_client_id = ''))
        OR
        -- Active member with MindBody ID but no tier (data incomplete)
        (u.membership_status = 'active' AND u.mindbody_client_id IS NOT NULL AND u.mindbody_client_id != '' AND (u.tier IS NULL OR u.tier = ''))
      )
    ORDER BY u.updated_at DESC
    LIMIT 50
  `);
  const mismatches = mismatchResult.rows as unknown as MindBodyMismatchRow[];

  for (const member of mismatches) {
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const hasMindBodyId = member.mindbody_client_id && member.mindbody_client_id !== '';

    let description: string;
    let suggestion: string;

    if (!hasMindBodyId && member.membership_status === 'active') {
      description = `MindBody member "${memberName}" is active but has no MindBody Client ID`;
      suggestion = 'Add MindBody Client ID or verify billing provider is correct';
    } else {
      description = `MindBody member "${memberName}" has MindBody ID but no tier assigned`;
      suggestion = 'Assign a membership tier to this member';
    }

    issues.push({
      category: 'data_quality',
      severity: 'warning',
      table: 'users',
      recordId: member.id,
      description,
      suggestion,
      context: {
        memberName,
        memberEmail: member.email,
        memberTier: member.tier || 'none',
        memberStatus: member.membership_status,
        mindbodyClientId: member.mindbody_client_id || 'none',
        userId: Number(member.id)
      }
    });
  }

  return {
    checkName: 'MindBody Data Quality',
    status: issues.length === 0 ? 'pass' : issues.length > 5 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkGuestPassesForNonExistentMembers(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const orphans = await db.execute(sql`
    SELECT gp.id, gp.member_email, gp.passes_used, gp.passes_total
    FROM guest_passes gp
    LEFT JOIN users u ON LOWER(gp.member_email) = LOWER(u.email)
    WHERE u.id IS NULL
    LIMIT 100
  `);

  for (const row of orphans.rows as unknown as OrphanGuestPassRow[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'warning',
      table: 'guest_passes',
      recordId: row.id,
      description: `Guest pass for "${row.member_email}" (${row.passes_used}/${row.passes_total} used) references a non-existent member`,
      suggestion: 'Delete orphaned guest pass record or verify the member email',
      context: {
        memberEmail: row.member_email || undefined
      }
    });
  }

  return {
    checkName: 'Guest Passes Without Members',
    status: issues.length === 0 ? 'pass' : issues.length > 5 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}
