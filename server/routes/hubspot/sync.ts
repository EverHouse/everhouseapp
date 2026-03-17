import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { users } from '../../../shared/schema';
import { and, isNotNull, sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../../core/middleware';
import * as fs from 'fs';
import * as path from 'path';
import { invalidateCache } from '../../core/queryCache';
import { broadcastDirectoryUpdate } from '../../core/websocket';
import { getErrorMessage, safeErrorDetail } from '../../utils/errorUtils';
import { denormalizeTierForHubSpotAsync } from '../../utils/tierUtils';
import { syncRelevantMembersFromHubSpot, getLastMemberSyncTime, setLastMemberSyncTime } from '../../core/memberSync';
import { getHubSpotClient } from '../../core/integrations';
import {
  HubSpotApiObject,
  BillingProviderMemberRow,
  retryableHubSpotRequest,
  parseCSV,
  resetAllContactsCache,
} from './shared';

const router = Router();

router.post('/api/hubspot/sync-tiers', isStaffOrAdmin, async (req, res) => {
  try {
    const { dryRun = true } = req.body;
    const hubspot = await getHubSpotClient();
    
    const assetsDir = path.join(process.cwd(), 'uploads', 'trackman');
    const files = fs.readdirSync(assetsDir)
      .filter(f => f.startsWith('even_house_cleaned_member_data') && f.endsWith('.csv'))
      .sort()
      .reverse();
    
    if (files.length === 0) {
      return res.status(404).json({ error: 'No cleaned member data CSV found' });
    }
    
    const csvPath = path.join(assetsDir, files[0]);
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const csvRows = parseCSV(csvContent);
    
    logger.info('[Tier Sync] Loaded rows from', { extra: { csvRowsLength: csvRows.length, files_0: files[0] } });
    
    const csvByEmail = new Map<string, { tier: string; mindbodyId: string; name: string }>();
    for (const row of csvRows) {
      const email = (row.real_email || '').toLowerCase().trim();
      if (email) {
        csvByEmail.set(email, {
          tier: row.membership_tier || '',
          mindbodyId: row.mindbody_id || '',
          name: `${row.first_name || ''} ${row.last_name || ''}`.trim()
        });
      }
    }
    
    const properties = ['firstname', 'lastname', 'email', 'membership_tier', 'mindbody_client_id'];
    let allContacts: HubSpotApiObject[] = [];
    let after: string | undefined = undefined;
    
    do {
      const response = await retryableHubSpotRequest(() => 
        hubspot.crm.contacts.basicApi.getPage(100, after, properties)
      );
      allContacts = allContacts.concat(response.results as unknown as HubSpotApiObject[]);
      after = response.paging?.next?.after;
    } while (after);
    
    logger.info('[Tier Sync] Fetched contacts from HubSpot', { extra: { allContactsLength: allContacts.length } });
    
    const results = {
      matched: 0,
      updated: 0,
      skipped: 0,
      notFound: 0,
      errors: [] as string[],
      updates: [] as { email: string; name: string; oldTier: string; newTier: string }[]
    };
    
    const updateBatch: { id: string; properties: { membership_tier: string } }[] = [];
    
    for (const contact of allContacts) {
      const contactProps = contact.properties as Record<string, string>;
      const hubspotEmail = (contactProps.email || '').toLowerCase().trim();
      if (!hubspotEmail) continue;
      
      const csvData = csvByEmail.get(hubspotEmail);
      if (!csvData) {
        results.notFound++;
        continue;
      }
      
      results.matched++;
      const currentTier = contactProps.membership_tier || '';
      const newTier = csvData.tier;
      
      if (currentTier.toLowerCase() === newTier.toLowerCase()) {
        results.skipped++;
        continue;
      }
      
      results.updates.push({
        email: hubspotEmail,
        name: csvData.name,
        oldTier: currentTier || '(empty)',
        newTier: newTier
      });
      
      const hubspotTier = await denormalizeTierForHubSpotAsync(newTier);
      if (!hubspotTier) continue;
      
      updateBatch.push({
        id: contact.id as string,
        properties: { membership_tier: hubspotTier }
      });
    }
    
    if (!dryRun && updateBatch.length > 0) {
      const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('../../core/hubspot/readOnlyGuard');
      if (isHubSpotReadOnly()) {
        logHubSpotWriteSkipped('batch_tier_update', `${updateBatch.length} contacts`);
      } else {
        const batchSize = 100;
        for (let i = 0; i < updateBatch.length; i += batchSize) {
          const batch = updateBatch.slice(i, i + batchSize);
          try {
            await retryableHubSpotRequest(() => 
              hubspot.crm.contacts.batchApi.update({
                inputs: batch
              })
            );
            results.updated += batch.length;
            logger.info('[Tier Sync] Updated batch : contacts', { extra: { MathFloor_i_batchSize_1: Math.floor(i / batchSize) + 1, batchLength: batch.length } });
          } catch (err: unknown) {
            results.errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${getErrorMessage(err)}`);
            logger.error('[Tier Sync] Batch update error:', { extra: { err } });
          }
        }
      }
    } else if (dryRun) {
      results.updated = 0;
    }
    
    logger.info('[Tier Sync] Complete - Matched: , Updates: , Errors', { extra: { resultsMatched: results.matched, resultsUpdatesLength: results.updates.length, resultsErrorsLength: results.errors.length } });
    
    if (!dryRun && results.updated > 0) {
      invalidateCache('members_directory');
      broadcastDirectoryUpdate('synced');
    }
    
    res.json({
      success: true,
      dryRun,
      csvFile: files[0],
      csvRowCount: csvRows.length,
      hubspotContactCount: allContacts.length,
      matched: results.matched,
      toUpdate: results.updates.length,
      updated: results.updated,
      skipped: results.skipped,
      notFoundInCSV: results.notFound,
      errors: results.errors,
      updates: results.updates.slice(0, 50)
    });
  } catch (error: unknown) {
    logger.error('[Tier Sync] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Tier sync failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/hubspot/push-db-tiers', isStaffOrAdmin, async (req, res) => {
  try {
    const { dryRun = true } = req.body;
    const hubspot = await getHubSpotClient();
    
    const members = await db.select({
      email: users.email,
      tier: users.tier,
      hubspotId: users.hubspotId,
      firstName: users.firstName,
      lastName: users.lastName
    })
      .from(users)
      .where(and(
        isNotNull(users.hubspotId),
        sql`(${users.membershipStatus} IN ('active', 'trialing', 'past_due') OR ${users.stripeSubscriptionId} IS NOT NULL)`,
        sql`${users.archivedAt} IS NULL`
      ));
    
    logger.info('[DB Tier Push] Found members with HubSpot IDs', { extra: { membersLength: members.length } });
    
    const results = {
      total: members.length,
      toUpdate: 0,
      updated: 0,
      skipped: 0,
      errors: [] as string[],
      updates: [] as { email: string; name: string; tier: string; hubspotId: string }[]
    };
    
    const updateBatch: { id: string; properties: { membership_tier: string } }[] = [];
    
    for (const member of members) {
      if (!member.hubspotId || !member.tier) {
        results.skipped++;
        continue;
      }
      
      const name = [member.firstName, member.lastName].filter(Boolean).join(' ');
      
      results.updates.push({
        email: member.email || '',
        name,
        tier: member.tier,
        hubspotId: member.hubspotId
      });
      
      const hubspotTier = await denormalizeTierForHubSpotAsync(member.tier);
      if (!hubspotTier) continue;
      
      updateBatch.push({
        id: member.hubspotId,
        properties: { membership_tier: hubspotTier }
      });
    }
    
    results.toUpdate = updateBatch.length;
    
    if (!dryRun && updateBatch.length > 0) {
      const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('../../core/hubspot/readOnlyGuard');
      if (isHubSpotReadOnly()) {
        logHubSpotWriteSkipped('batch_billing_fix', `${updateBatch.length} contacts`);
      } else {
        const batchSize = 100;
        for (let i = 0; i < updateBatch.length; i += batchSize) {
          const batch = updateBatch.slice(i, i + batchSize);
          try {
            await retryableHubSpotRequest(() => 
              hubspot.crm.contacts.batchApi.update({ inputs: batch })
            );
            results.updated += batch.length;
            logger.info('[DB Tier Push] Updated batch : contacts', { extra: { MathFloor_i_batchSize_1: Math.floor(i / batchSize) + 1, batchLength: batch.length } });
          } catch (err: unknown) {
            results.errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${getErrorMessage(err)}`);
            logger.error('[DB Tier Push] Batch update error:', { extra: { err } });
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    if (!dryRun && results.updated > 0) {
      invalidateCache('members_directory');
      broadcastDirectoryUpdate('synced');
    }
    
    logger.info('[DB Tier Push] Complete - Total: , Updated: , Errors', { extra: { resultsTotal: results.total, resultsUpdated: results.updated, resultsErrorsLength: results.errors.length } });
    
    res.json({
      success: true,
      dryRun,
      total: results.total,
      toUpdate: results.toUpdate,
      updated: results.updated,
      skipped: results.skipped,
      errors: results.errors,
      sampleUpdates: results.updates.slice(0, 20)
    });
  } catch (error: unknown) {
    logger.error('[DB Tier Push] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'DB tier push failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/hubspot/sync-billing-providers', isStaffOrAdmin, async (req, res) => {
  try {
    const { dryRun = true } = req.body;
    const { syncMemberToHubSpot } = await import('../../core/hubspot/stages');
    
    const membersResult = await db.execute(sql`
      SELECT email, membership_status, billing_provider, tier, hubspot_id, first_name, last_name
      FROM users
      WHERE hubspot_id IS NOT NULL 
        AND archived_at IS NULL
        AND (membership_status IN ('active', 'trialing', 'past_due') OR stripe_subscription_id IS NOT NULL)
      ORDER BY email
    `);
    
    logger.info('[HubSpot Sync] Found members with HubSpot IDs to sync', { extra: { membersResultRowsLength: membersResult.rows.length } });
    
    const results = {
      total: membersResult.rows.length,
      synced: 0,
      skipped: 0,
      errors: 0,
      details: [] as Array<{ email: string; status: string; billingProvider: string; tier: string; result: string }>
    };
    
    for (const member of membersResult.rows) {
      const m = member as unknown as BillingProviderMemberRow;
      const email = m.email;
      const status = m.membership_status || 'active';
      const billingProvider = m.billing_provider || 'manual';
      const tier = m.tier || '';
      
      if (dryRun) {
        results.details.push({
          email,
          status,
          billingProvider,
          tier: tier || 'none',
          result: 'would sync'
        });
        results.synced++;
        continue;
      }
      
      try {
        const syncResult = await syncMemberToHubSpot({
          email,
          status,
          billingProvider,
          tier
        });
        
        if (syncResult.success) {
          results.synced++;
          results.details.push({
            email,
            status,
            billingProvider,
            tier: tier || 'none',
            result: 'synced'
          });
        } else {
          results.skipped++;
          results.details.push({
            email,
            status,
            billingProvider,
            tier: tier || 'none',
            result: `skipped: ${syncResult.error}`
          });
        }
      } catch (err: unknown) {
        results.errors++;
        results.details.push({
          email,
          status,
          billingProvider,
          tier: tier || 'none',
          result: `error: ${getErrorMessage(err)}`
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    logger.info('[HubSpot Sync] Completed: synced, skipped, errors', { extra: { resultsSynced: results.synced, resultsSkipped: results.skipped, resultsErrors: results.errors } });
    
    res.json({
      dryRun,
      total: results.total,
      synced: results.synced,
      skipped: results.skipped,
      errors: results.errors,
      sampleDetails: results.details.slice(0, 50)
    });
  } catch (error: unknown) {
    logger.error('[HubSpot Sync] Error syncing billing providers', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Sync failed', details: safeErrorDetail(error) });
  }
});

router.get('/api/hubspot/sync-status', isStaffOrAdmin, async (_req: Request, res: Response) => {
  try {
    const lastSync = getLastMemberSyncTime();
    res.json({ lastSyncTime: lastSync ? new Date(lastSync).toISOString() : null });
  } catch (error: unknown) {
    logger.error('[HubSpot] Failed to get sync status', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

router.post('/api/hubspot/sync-all-members', isStaffOrAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await syncRelevantMembersFromHubSpot();
    await setLastMemberSyncTime(Date.now());
    resetAllContactsCache();
    res.json({ synced: result.synced, errors: result.errors });
  } catch (error: unknown) {
    logger.error('[HubSpot] Failed to sync all members', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync members from HubSpot', details: safeErrorDetail(error) });
  }
});

router.post('/api/hubspot/push-members-to-hubspot', isStaffOrAdmin, async (_req: Request, res: Response) => {
  try {
    const membersResult = await db.execute(sql`
      SELECT email, membership_status, billing_provider, tier, hubspot_id, first_name, last_name
      FROM users
      WHERE membership_status IN ('active', 'trialing', 'past_due') AND email IS NOT NULL
      ORDER BY email
    `);
    const members = membersResult.rows as unknown as BillingProviderMemberRow[];

    let synced = 0;
    let errors = 0;
    const { syncMemberToHubSpot } = await import('../../core/hubspot/stages');

    for (const member of members) {
      try {
        await syncMemberToHubSpot({
          email: member.email,
          status: member.membership_status || undefined,
          tier: member.tier || undefined,
          billingProvider: member.billing_provider || undefined,
        });
        synced++;
      } catch (err: unknown) {
        errors++;
        logger.warn('[HubSpot Push] Failed to push member', { extra: { email: member.email, error: getErrorMessage(err) } });
      }
    }

    resetAllContactsCache();
    res.json({ synced, errors });
  } catch (error: unknown) {
    logger.error('[HubSpot] Failed to push members to HubSpot', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to push members to HubSpot', details: safeErrorDetail(error) });
  }
});

export default router;
