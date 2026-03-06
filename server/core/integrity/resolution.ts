import { db } from '../../db';
import { sql, eq, and, gt, desc } from 'drizzle-orm';
import { getErrorMessage, getErrorStatusCode } from '../../utils/errorUtils';
import { logger } from '../logger';
import {
  adminAuditLog,
  integrityIssuesTracking,
  integrityIgnores
} from '../../../shared/schema';
import { getHubSpotClient } from '../integrations';
import { syncCustomerMetadataToStripe } from '../stripe/customers';
import { getStripeClient } from '../stripe/client';
import { logIntegrityAudit } from '../auditLog';
import { denormalizeTierForHubSpotAsync } from '../../utils/tierUtils';
import { retryableHubSpotRequest } from '../hubspot/request';
import type {
  AuditLogDetailsRow,
  SyncPushUserRow,
  MemberRow,
  HubSpotBatchReadResult,
} from './core';
import { CHURNED_STATUSES, NO_TIER_STATUSES } from './core';

export interface ResolveIssueParams {
  issueKey: string;
  action: 'resolved' | 'ignored' | 'reopened';
  actionBy: string;
  resolutionMethod?: string;
  notes?: string;
}

export async function resolveIssue(params: ResolveIssueParams): Promise<{ auditLogId: number }> {
  const { issueKey, action, actionBy, resolutionMethod, notes } = params;

  const auditLogId = await logIntegrityAudit({
    issueKey,
    action,
    actionBy,
    resolutionMethod: resolutionMethod || null,
    notes: notes || null
  });

  if (action === 'resolved' || action === 'ignored') {
    await db.update(integrityIssuesTracking)
      .set({ resolvedAt: new Date() })
      .where(eq(integrityIssuesTracking.issueKey, issueKey));
  } else if (action === 'reopened') {
    await db.update(integrityIssuesTracking)
      .set({ resolvedAt: null })
      .where(eq(integrityIssuesTracking.issueKey, issueKey));
  }

  return { auditLogId };
}

export async function getAuditLog(limit: number = 10): Promise<Array<{
  id: number;
  issueKey: string;
  action: string;
  actionBy: string;
  actionAt: Date;
  resolutionMethod: string | null;
  notes: string | null;
}>> {
  const entries = await db.select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.resourceType, 'system'))
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(limit);

  return entries.map(entry => {
    const details = (entry.details || {}) as unknown as AuditLogDetailsRow;
    return {
      id: entry.id,
      issueKey: details.issueKey || entry.resourceId || '',
      action: entry.action,
      actionBy: entry.staffEmail,
      actionAt: entry.createdAt,
      resolutionMethod: details.resolutionMethod || null,
      notes: details.notes || null,
    };
  });
}

export interface SyncPushParams {
  issueKey: string;
  target: 'hubspot' | 'calendar' | 'stripe';
  userId?: number;
  hubspotContactId?: string;
  stripeCustomerId?: string;
}

export interface SyncPullParams {
  issueKey: string;
  target: 'hubspot' | 'calendar' | 'stripe';
  userId?: number;
  hubspotContactId?: string;
  stripeCustomerId?: string;
}

export async function syncPush(params: SyncPushParams): Promise<{ success: boolean; message: string }> {
  const { target, userId, hubspotContactId } = params;

  if (target === 'hubspot') {
    if (!userId || !hubspotContactId) {
      throw new Error('userId and hubspotContactId are required for HubSpot push');
    }

    const userResult = await db.execute(sql`
      SELECT first_name, last_name, email, membership_tier, tier, membership_status
      FROM users WHERE id = ${userId}
    `);

    if (userResult.rows.length === 0) {
      throw new Error(`User with id ${userId} not found`);
    }

    const user = userResult.rows[0] as unknown as SyncPushUserRow;

    const hubspot = await getHubSpotClient();

    const isChurned = ['terminated', 'cancelled', 'non-member', 'deleted', 'former_member', 'expired'].includes(String(user.membership_status || '').toLowerCase());
    const mappedTier = isChurned ? '' : (await denormalizeTierForHubSpotAsync(String(user.tier)) || '');

    await hubspot.crm.contacts.basicApi.update(hubspotContactId, {
      properties: {
        firstname: user.first_name || '',
        lastname: user.last_name || '',
        membership_tier: mappedTier
      }
    });

    return {
      success: true,
      message: `Pushed app data to HubSpot contact ${hubspotContactId}`
    };
  }

  if (target === 'stripe') {
    if (!userId) {
      throw new Error('userId is required for Stripe push');
    }

    const userResult = await db.execute(sql`
      SELECT email FROM users WHERE id = ${userId}
    `);

    if (userResult.rows.length === 0) {
      throw new Error(`User with id ${userId} not found`);
    }

    const user = userResult.rows[0] as unknown as { email: string };
    const result = await syncCustomerMetadataToStripe(user.email);

    if (!result.success) {
      throw new Error(result.error || 'Failed to sync to Stripe');
    }

    return {
      success: true,
      message: `Pushed app data to Stripe customer for ${user.email}`
    };
  }

  throw new Error(`Unsupported sync target: ${target}`);
}

export async function bulkPushToHubSpot(dryRun: boolean = true): Promise<{
  success: boolean;
  message: string;
  totalChecked: number;
  totalMismatched: number;
  totalSynced: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let totalChecked = 0;
  let totalMismatched = 0;
  let totalSynced = 0;

  const hubspot = await getHubSpotClient();

  const allMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, membership_tier, hubspot_id, tier, membership_status
    FROM users
    WHERE hubspot_id IS NOT NULL
    ORDER BY id
  `);
  const allMembers = allMembersResult.rows as unknown as MemberRow[];

  const batchSize = 100;

  for (let i = 0; i < allMembers.length; i += batchSize) {
    const batch = allMembers.slice(i, i + batchSize);
    totalChecked += batch.length;

    let hsContactMap: Record<string, Record<string, string>> = {};
    try {
      const readInput = {
        inputs: batch.map((m: MemberRow) => ({ id: m.hubspot_id as string })),
        properties: ['firstname', 'lastname', 'email', 'membership_tier']
      };
      const readResult = await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.batchApi.read(readInput as unknown as Parameters<typeof hubspot.crm.contacts.batchApi.read>[0])
      );
      for (const contact of ((readResult as unknown as HubSpotBatchReadResult).results || [])) {
        hsContactMap[contact.id] = contact.properties || {};
      }
    } catch (error: unknown) {
      const errMsg = getErrorMessage(error);
      if (errMsg.includes('404') || getErrorStatusCode(error) === 404) {
        for (const member of batch) {
          try {
            const singleRead = await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.getById(String(member.hubspot_id), ['firstname', 'lastname', 'email', 'membership_tier'])
            );
            hsContactMap[member.hubspot_id as string] = singleRead.properties || {};
          } catch (singleErr: unknown) {
            if (getErrorStatusCode(singleErr) === 404) {
              continue;
            }
            errors.push(`Read error for ${member.email}: ${getErrorMessage(singleErr)}`);
          }
        }
      } else {
        errors.push(`Batch read error: ${errMsg}`);
        continue;
      }
    }

    const updateInputs: Array<{ id: string; properties: Record<string, string> }> = [];

    for (const member of batch) {
      const hsProps = hsContactMap[member.hubspot_id as string];
      if (!hsProps) continue;

      const memberStatus = String(member.membership_status || '').toLowerCase();
      const isChurned = CHURNED_STATUSES.includes(memberStatus);
      const isNoTierStatus = NO_TIER_STATUSES.includes(memberStatus);
      const expectedTier = (isChurned || isNoTierStatus || !member.tier)
        ? ''
        : (await denormalizeTierForHubSpotAsync(String(member.tier)) || '');

      const appFirstName = String(member.first_name || '').trim().toLowerCase();
      const hsFirstName = (hsProps.firstname || '').trim().toLowerCase();
      const appLastName = String(member.last_name || '').trim().toLowerCase();
      const hsLastName = (hsProps.lastname || '').trim().toLowerCase();
      const expectedNorm = expectedTier.trim().toLowerCase();
      const hsNorm = (hsProps.membership_tier || '').trim().toLowerCase();

      let hasMismatch = false;
      if (appFirstName !== hsFirstName) hasMismatch = true;
      if (appLastName !== hsLastName) hasMismatch = true;
      if (expectedNorm !== hsNorm) {
        if (expectedNorm || hsNorm) {
          hasMismatch = true;
        }
      }

      if (hasMismatch) {
        totalMismatched++;
        updateInputs.push({
          id: member.hubspot_id as string,
          properties: {
            firstname: (member.first_name as string) || '',
            lastname: (member.last_name as string) || '',
            membership_tier: expectedTier
          }
        });
      }
    }

    if (!dryRun && updateInputs.length > 0) {
      for (let j = 0; j < updateInputs.length; j += batchSize) {
        const updateBatch = updateInputs.slice(j, j + batchSize);
        try {
          await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.batchApi.update({ inputs: updateBatch })
          );
          totalSynced += updateBatch.length;
        } catch (batchError: unknown) {
          logger.warn('[bulkPushToHubSpot] Batch update failed, falling back to individual pushes', {
            extra: { batchSize: updateBatch.length, batchError: getErrorMessage(batchError) }
          });
          for (const individual of updateBatch) {
            try {
              await retryableHubSpotRequest(() =>
                hubspot.crm.contacts.batchApi.update({ inputs: [individual] })
              );
              totalSynced += 1;
            } catch (individualError: unknown) {
              errors.push(`Individual sync failed for contact ${individual.id}: ${getErrorMessage(individualError)}`);
            }
          }
        }
      }
    }

    if (i + batchSize < allMembers.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  const message = dryRun
    ? `Dry run complete: checked ${totalChecked} members, found ${totalMismatched} mismatches`
    : `Pushed ${totalSynced} of ${totalMismatched} mismatched members to HubSpot (${totalChecked} total checked)`;

  return {
    success: true,
    message,
    totalChecked,
    totalMismatched,
    totalSynced,
    errors
  };
}

function hubspotTierToAppTier(hsTier: string | null): string | null {
  if (!hsTier) return null;
  const HUBSPOT_TO_APP_TIER: Record<string, string> = {
    'core membership': 'Core',
    'core membership founding members': 'Core',
    'premium membership': 'Premium',
    'premium membership founding members': 'Premium',
    'social membership': 'Social',
    'social membership founding members': 'Social',
    'vip membership': 'VIP',
    'corporate membership': 'Corporate',
    'group lessons membership': 'Group Lessons',
  };
  const match = HUBSPOT_TO_APP_TIER[hsTier.trim().toLowerCase()];
  return match || null;
}

export async function syncPull(params: SyncPullParams): Promise<{ success: boolean; message: string }> {
  const { target, userId, hubspotContactId } = params;

  if (target === 'hubspot') {
    if (!userId || !hubspotContactId) {
      throw new Error('userId and hubspotContactId are required for HubSpot pull');
    }

    const hubspot = await getHubSpotClient();

    const contact = await hubspot.crm.contacts.basicApi.getById(
      hubspotContactId,
      ['firstname', 'lastname', 'email', 'phone', 'membership_tier']
    );

    const props = contact.properties || {};
    const hsTierValue = props.membership_tier || null;
    const appTier = hubspotTierToAppTier(hsTierValue);

    const userResult = await db.execute(sql`
      SELECT email, billing_provider, last_manual_fix_at FROM users WHERE id = ${userId}
    `);
    const user = userResult.rows[0] as { email: string; billing_provider: string | null; last_manual_fix_at: Date | null } | undefined;
    const userEmail = user?.email;

    const recentlyFixed = user?.last_manual_fix_at &&
      (Date.now() - new Date(user.last_manual_fix_at).getTime()) < 60 * 60 * 1000;

    if (recentlyFixed) {
      logger.info(`[Integrity] Skipping syncPull tier/status for user ${userId} — manually fixed ${Math.round((Date.now() - new Date(user!.last_manual_fix_at!).getTime()) / 60000)} min ago`);
    }

    const isStripeProtected = user?.billing_provider === 'stripe';

    await db.execute(sql`
      UPDATE users SET
        first_name = COALESCE(${props.firstname ?? null}, first_name),
        last_name = COALESCE(${props.lastname ?? null}, last_name),
        phone = COALESCE(${props.phone ?? null}, phone),
        membership_tier = CASE WHEN ${recentlyFixed || isStripeProtected ? 'skip' : 'apply'} = 'apply' 
          THEN COALESCE(${appTier}, membership_tier) ELSE membership_tier END,
        tier = CASE WHEN ${recentlyFixed || isStripeProtected ? 'skip' : 'apply'} = 'apply' 
          THEN COALESCE(${appTier}, tier) ELSE tier END,
        updated_at = NOW()
      WHERE id = ${userId}
    `);

    if (userEmail && !recentlyFixed) {
      syncCustomerMetadataToStripe(String(userEmail)).catch((err) => { logger.error('[Integrity] Stripe metadata sync failed:', err); });
    }

    return {
      success: true,
      message: recentlyFixed
        ? `Pulled HubSpot profile data (name/phone) to app user ${userId} — tier protected by recent manual fix`
        : `Pulled HubSpot data to app user ${userId}`
    };
  }

  if (target === 'stripe') {
    if (!userId) {
      throw new Error('userId is required for Stripe pull');
    }

    const userResult = await db.execute(sql`
      SELECT email, stripe_customer_id, tier, membership_status FROM users WHERE id = ${userId}
    `);

    if (userResult.rows.length === 0) {
      throw new Error(`User with id ${userId} not found`);
    }

    const user = userResult.rows[0] as unknown as { email: string; stripe_customer_id: string | null; tier: string | null; membership_status: string | null };

    if (!user.stripe_customer_id) {
      throw new Error(`User ${userId} has no linked Stripe customer`);
    }

    const stripe = await getStripeClient();
    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripe_customer_id,
      status: 'all',
      limit: 1,
      expand: ['data.items.data.price.product'],
    });

    const activeSub = subscriptions.data.find(s => ['active', 'trialing', 'past_due'].includes(s.status));

    if (!activeSub) {
      return {
        success: true,
        message: `No active Stripe subscription found for user ${userId}. No changes made — review membership status manually.`
      };
    }

    const item = activeSub.items?.data?.[0];
    const productRef = item?.price?.product;
    const productName = (productRef && typeof productRef === 'object' && 'name' in productRef)
      ? (productRef as { name: string }).name
      : null;

    const updates: string[] = [];

    if (productName) {
      const stripeTier = productName.toLowerCase();
      const currentTier = (user.tier || '').toLowerCase();
      if (stripeTier !== currentTier) {
        await db.execute(sql`
          UPDATE users SET tier = ${productName.toLowerCase()}, membership_tier = ${productName.toLowerCase()}, updated_at = NOW()
          WHERE id = ${userId}
        `);
        updates.push(`tier: "${user.tier}" → "${productName.toLowerCase()}"`);
      }
    }

    return {
      success: true,
      message: updates.length > 0
        ? `Pulled Stripe data to app user ${userId}: ${updates.join(', ')}`
        : `Stripe data matches app for user ${userId} — no changes needed`
    };
  }

  throw new Error(`Unsupported sync target: ${target}`);
}

export interface CreateIgnoreParams {
  issueKey: string;
  duration: '24h' | '1w' | '30d';
  reason: string;
  ignoredBy: string;
}

export async function createIgnoreRule(params: CreateIgnoreParams): Promise<{
  id: number;
  issueKey: string;
  expiresAt: Date;
}> {
  const { issueKey, duration, reason, ignoredBy } = params;

  const now = new Date();
  let expiresAt: Date;

  switch (duration) {
    case '24h':
      expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      break;
    case '1w':
      expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      throw new Error(`Invalid duration: ${duration}`);
  }

  const existing = await db.select()
    .from(integrityIgnores)
    .where(eq(integrityIgnores.issueKey, issueKey))
    .limit(1);

  if (existing.length > 0) {
    const [updated] = await db.update(integrityIgnores)
      .set({
        ignoredBy,
        ignoredAt: now,
        expiresAt,
        reason,
        isActive: true
      })
      .where(eq(integrityIgnores.issueKey, issueKey))
      .returning({ id: integrityIgnores.id });

    return { id: updated.id, issueKey, expiresAt };
  }

  const [inserted] = await db.insert(integrityIgnores)
    .values({
      issueKey,
      ignoredBy,
      ignoredAt: now,
      expiresAt,
      reason,
      isActive: true
    })
    .returning({ id: integrityIgnores.id });

  return { id: inserted.id, issueKey, expiresAt };
}

export async function removeIgnoreRule(issueKey: string): Promise<{ removed: boolean }> {
  const result = await db.update(integrityIgnores)
    .set({ isActive: false })
    .where(eq(integrityIgnores.issueKey, issueKey));

  return { removed: true };
}

export interface CreateBulkIgnoreParams {
  issueKeys: string[];
  duration: '24h' | '1w' | '30d';
  reason: string;
  ignoredBy: string;
}

export async function createBulkIgnoreRules(params: CreateBulkIgnoreParams): Promise<{
  created: number;
  updated: number;
}> {
  const { issueKeys, duration, reason, ignoredBy } = params;

  if (issueKeys.length === 0) {
    return { created: 0, updated: 0 };
  }

  const now = new Date();
  let expiresAt: Date;

  switch (duration) {
    case '24h':
      expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      break;
    case '1w':
      expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      throw new Error(`Invalid duration: ${duration}`);
  }

  let created = 0;
  let updated = 0;

  const BATCH_SIZE = 50;
  for (let i = 0; i < issueKeys.length; i += BATCH_SIZE) {
    const batch = issueKeys.slice(i, i + BATCH_SIZE);

    for (const issueKey of batch) {
      const existing = await db.select()
        .from(integrityIgnores)
        .where(eq(integrityIgnores.issueKey, issueKey))
        .limit(1);

      if (existing.length > 0) {
        await db.update(integrityIgnores)
          .set({
            ignoredBy,
            ignoredAt: now,
            expiresAt,
            reason,
            isActive: true
          })
          .where(eq(integrityIgnores.issueKey, issueKey));
        updated++;
      } else {
        await db.insert(integrityIgnores)
          .values({
            issueKey,
            ignoredBy,
            ignoredAt: now,
            expiresAt,
            reason,
            isActive: true
          });
        created++;
      }
    }
  }

  return { created, updated };
}

export interface IgnoredIssue {
  id: number;
  issueKey: string;
  ignoredBy: string;
  ignoredAt: Date;
  expiresAt: Date;
  reason: string;
  isActive: boolean;
  isExpired: boolean;
}

export async function getIgnoredIssues(): Promise<IgnoredIssue[]> {
  const now = new Date();

  const ignores = await db.select()
    .from(integrityIgnores)
    .where(eq(integrityIgnores.isActive, true))
    .orderBy(desc(integrityIgnores.ignoredAt));

  return ignores.map(ignore => ({
    ...ignore,
    isExpired: ignore.expiresAt < now
  }));
}

export async function getActiveIgnoreKeys(): Promise<Set<string>> {
  const now = new Date();

  const activeIgnores = await db.select({ issueKey: integrityIgnores.issueKey })
    .from(integrityIgnores)
    .where(and(
      eq(integrityIgnores.isActive, true),
      gt(integrityIgnores.expiresAt, now)
    ));

  return new Set(activeIgnores.map(i => i.issueKey));
}
