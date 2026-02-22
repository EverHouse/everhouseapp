import { logger } from '../core/logger';
import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { isProduction } from '../core/db';
import {
  getMemberDealWithLineItems,
  getAllProductMappings,
  getAllDiscountRules,
  updateDiscountRule,
  addLineItemToDeal,
  removeLineItemFromDeal,
  getBillingAuditLog,
  calculateTotalDiscount,
  syncDealStageFromMindbodyStatus,
  updateDealStage
} from '../core/hubspotDeals';
import { syncAllMembersFromHubSpot, syncRelevantMembersFromHubSpot, syncCommunicationLogsFromHubSpot, getLastMemberSyncTime, setLastMemberSyncTime } from '../core/memberSync';
import { db } from '../db';
import { hubspotProductMappings, discountRules, hubspotDeals } from '../../shared/schema';
import { eq, and, ne, sql } from 'drizzle-orm';
import { MINDBODY_TO_STAGE_MAP, HUBSPOT_STAGE_IDS } from '../core/hubspot/constants';
import { getSessionUser } from '../types/session';
import pLimit from 'p-limit';
import { getErrorMessage } from '../utils/errorUtils';

const router = Router();

router.get('/api/hubspot/deals/member/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const deal = await getMemberDealWithLineItems(email as string);
    
    if (!deal) {
      return res.json({ deal: null, message: 'No deal found for this member' });
    }
    
    res.json({ deal });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error fetching member deal', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch member deal' });
  }
});

router.get('/api/hubspot/products', isStaffOrAdmin, async (req, res) => {
  try {
    const products = await getAllProductMappings();
    res.json({ products });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error fetching products', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

router.put('/api/hubspot/products/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { unitPrice, isActive, description } = req.body;
    
    await db.update(hubspotProductMappings)
      .set({
        ...(unitPrice !== undefined && { unitPrice: String(unitPrice) }),
        ...(isActive !== undefined && { isActive }),
        ...(description !== undefined && { description }),
        updatedAt: new Date()
      })
      .where(eq(hubspotProductMappings.id, parseInt(id as string)));
    
    res.json({ success: true });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error updating product', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.get('/api/hubspot/discount-rules', isStaffOrAdmin, async (req, res) => {
  try {
    const rules = await getAllDiscountRules();
    res.json({ rules });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error fetching discount rules', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch discount rules' });
  }
});

router.put('/api/hubspot/discount-rules/:tag', isStaffOrAdmin, async (req, res) => {
  try {
    const { tag } = req.params;
    const { discountPercent, description, isActive } = req.body;
    
    await db.update(discountRules)
      .set({
        ...(discountPercent !== undefined && { discountPercent }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
        updatedAt: new Date()
      })
      .where(eq(discountRules.discountTag, decodeURIComponent(tag as string)));
    
    res.json({ success: true });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error updating discount rule', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update discount rule' });
  }
});

router.post('/api/hubspot/deals/:dealId/line-items', isStaffOrAdmin, async (req, res) => {
  try {
    const { dealId } = req.params;
    const { productId, quantity, discountPercent, discountReason } = req.body;
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'system';
    const staffName = sessionUser?.name || 'System';
    
    if (!productId) {
      return res.status(400).json({ error: 'Product ID is required' });
    }
    
    const result = await addLineItemToDeal(
      dealId as string,
      productId,
      quantity || 1,
      discountPercent || 0,
      discountReason,
      staffEmail,
      staffName
    );
    
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to add line item' });
    }
    
    res.json({ success: true, lineItemId: result.lineItemId });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error adding line item', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to add line item' });
  }
});

router.delete('/api/hubspot/line-items/:lineItemId', isStaffOrAdmin, async (req, res) => {
  try {
    const { lineItemId } = req.params;
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'system';
    const staffName = sessionUser?.name || 'System';
    
    const success = await removeLineItemFromDeal(lineItemId as string, staffEmail, staffName);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to remove line item' });
    }
    
    res.json({ success: true });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error removing line item', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to remove line item' });
  }
});

router.get('/api/hubspot/billing-audit/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    
    const auditLog = await getBillingAuditLog(email as string, limit);
    res.json({ auditLog });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error fetching billing audit log', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch billing audit log' });
  }
});

router.get('/api/hubspot/member-discount/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const tagsParam = req.query.tags as string;
    
    if (!tagsParam) {
      return res.json({ totalPercent: 0, appliedRules: [] });
    }
    
    const tags = tagsParam.split(',').map(t => t.trim());
    const discount = await calculateTotalDiscount(tags);
    
    res.json(discount);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error calculating discount', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to calculate discount' });
  }
});

router.post('/api/hubspot/sync-deal-stage', isStaffOrAdmin, async (req, res) => {
  try {
    const { memberEmail, mindbodyStatus } = req.body;
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'system';
    const staffName = sessionUser?.name || 'System';
    
    if (!memberEmail || !mindbodyStatus) {
      return res.status(400).json({ error: 'Member email and Mindbody status are required' });
    }
    
    const result = await syncDealStageFromMindbodyStatus(
      memberEmail,
      mindbodyStatus,
      staffEmail,
      staffName
    );
    
    res.json(result);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error syncing deal stage', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync deal stage' });
  }
});

// Get last sync status
router.get('/api/hubspot/sync-status', isStaffOrAdmin, async (req, res) => {
  try {
    const lastSync = getLastMemberSyncTime();
    res.json({ 
      lastSyncTime: lastSync > 0 ? new Date(lastSync).toISOString() : null,
      lastSyncTimestamp: lastSync
    });
  } catch (error: unknown) {
    logger.error('Failed to fetch sync status', { error: error instanceof Error ? error : new Error(String(error)) });
    return res.status(500).json({ error: 'Failed to fetch sync status' });
  }
});

// Manual trigger for full member sync (creates deals for all active members)
router.post('/api/hubspot/sync-all-members', isStaffOrAdmin, async (req, res) => {
  try {
    logger.info('[HubSpotDeals] Manual member sync triggered (focused)');
    const result = await syncRelevantMembersFromHubSpot();
    await setLastMemberSyncTime(Date.now());
    logger.info('[HubSpotDeals] Manual focused sync complete - Synced: , Errors', { extra: { resultSynced: result.synced, resultErrors: result.errors } });
    res.json({ success: true, ...result });
  } catch (error: unknown) {
    logger.error('Error during manual member sync', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync members' });
  }
});

// Manual trigger for communication logs sync (calls, SMS from HubSpot)
router.post('/api/hubspot/sync-communication-logs', isStaffOrAdmin, async (req, res) => {
  try {
    logger.info('[HubSpotDeals] Manual communication logs sync triggered');
    const result = await syncCommunicationLogsFromHubSpot();
    logger.info('[HubSpotDeals] Comm logs sync complete - Synced: , Errors', { extra: { resultSynced: result.synced, resultErrors: result.errors } });
    res.json({ success: true, ...result });
  } catch (error: unknown) {
    logger.error('Error during communication logs sync', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync communication logs' });
  }
});

// Push member data (tier, billing_provider, status, lifecycle) TO HubSpot for all relevant members
router.post('/api/hubspot/push-members-to-hubspot', isStaffOrAdmin, async (req, res) => {
  try {
    logger.info('[HubSpotDeals] Push members to HubSpot triggered');
    const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
    
    const membersResult = await db.execute(sql`
      SELECT id, email, tier, billing_provider, membership_status, hubspot_id
      FROM users
      WHERE role = 'member'
        AND membership_status IN ('active', 'trialing', 'past_due', 'frozen', 'froze', 'suspended', 'declined')
    `);
    
    const members = membersResult.rows;
    logger.info('[HubSpotDeals] Found members to push to HubSpot', { extra: { membersLength: members.length } });
    
    let synced = 0;
    let errors = 0;
    let hubspotIdsBackfilled = 0;
    const errorDetails: string[] = [];
    const BATCH_SIZE = 5;
    
    for (let i = 0; i < members.length; i += BATCH_SIZE) {
      const batch = members.slice(i, i + BATCH_SIZE);
      
      await Promise.all(
        batch.map(async (member) => {
          try {
            const result = await syncMemberToHubSpot({
              email: member.email as string,
              status: member.membership_status as string,
              tier: member.tier as string,
              billingProvider: member.billing_provider as string
            });
            synced++;
            
            if (result.success && result.contactId && !member.hubspot_id) {
              try {
                await db.execute(sql`UPDATE users SET hubspot_id = ${result.contactId}, updated_at = NOW() WHERE id = ${member.id} AND (hubspot_id IS NULL OR hubspot_id = '')`);
                hubspotIdsBackfilled++;
              } catch (err) { logger.warn('[HubSpot] Non-critical HubSpot ID backfill failed:', err); }
            }
          } catch (error: unknown) {
            errors++;
            errorDetails.push(`${member.email}: ${getErrorMessage(error)}`);
            logger.error('[HubSpotDeals] Error syncing', { extra: { email: member.email, error: getErrorMessage(error) } });
          }
        })
      );
      
      if (i + BATCH_SIZE < members.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    logger.info('[HubSpotDeals] Push complete - Synced: , Errors: , HubSpot IDs backfilled', { extra: { synced, errors, hubspotIdsBackfilled } });
    res.json({ success: true, total: members.length, synced, errors, hubspotIdsBackfilled, errorDetails: errorDetails.slice(0, 10) });
  } catch (error: unknown) {
    logger.error('Error pushing members to HubSpot', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to push members to HubSpot' });
  }
});

router.post('/api/hubspot/remediate-deal-stages', isStaffOrAdmin, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'system';
    const staffName = sessionUser?.name || 'Remediation Script';
    const dryRun = req.body.dryRun === true;
    
    logger.info('[HubSpotDeals] Deal stage remediation started (dryRun: )', { extra: { dryRun } });
    
    const membersResult = await db.execute(sql`
      SELECT u.email, u.membership_status, hd.hubspot_deal_id, hd.pipeline_stage
      FROM users u
      JOIN hubspot_deals hd ON LOWER(u.email) = LOWER(hd.member_email)
      WHERE u.role = 'member'
    `);
    
    const members = membersResult.rows;
    logger.info('[HubSpotDeals] Found members with deals to check', { extra: { membersLength: members.length } });
    
    const remediationPlan: {
      email: string;
      currentStage: string;
      targetStage: string;
      membershipStatus: string;
    }[] = [];
    
    for (const member of members) {
      const normalizedStatus = ((member.membership_status as string) || 'non-member').toLowerCase().replace(/[^a-z-]/g, '');
      const targetStage = MINDBODY_TO_STAGE_MAP[normalizedStatus] || HUBSPOT_STAGE_IDS.CLOSED_LOST;
      
      if (member.pipeline_stage !== targetStage) {
        remediationPlan.push({
          email: member.email as string,
          currentStage: member.pipeline_stage as string,
          targetStage,
          membershipStatus: normalizedStatus
        });
      }
    }
    
    logger.info('[HubSpotDeals] deals need stage updates', { extra: { remediationPlanLength: remediationPlan.length } });
    
    const summary = {
      toActive: remediationPlan.filter(r => r.targetStage === HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE).length,
      toPaymentDeclined: remediationPlan.filter(r => r.targetStage === HUBSPOT_STAGE_IDS.PAYMENT_DECLINED).length,
      toClosedLost: remediationPlan.filter(r => r.targetStage === HUBSPOT_STAGE_IDS.CLOSED_LOST).length
    };
    
    logger.info('[HubSpotDeals] Remediation summary - Active: , Payment Declined: , Closed Lost', { extra: { summaryToActive: summary.toActive, summaryToPaymentDeclined: summary.toPaymentDeclined, summaryToClosedLost: summary.toClosedLost } });
    
    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        totalDeals: members.length,
        dealsNeedingUpdate: remediationPlan.length,
        summary,
        sampleChanges: remediationPlan.slice(0, 20)
      });
    }
    
    let updated = 0;
    let errors = 0;
    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 2000;
    const limit = pLimit(BATCH_SIZE);
    
    for (let i = 0; i < remediationPlan.length; i += BATCH_SIZE) {
      const batch = remediationPlan.slice(i, i + BATCH_SIZE);
      
      const results = await Promise.allSettled(
        batch.map(item => limit(async () => {
          const result = await syncDealStageFromMindbodyStatus(
            item.email,
            item.membershipStatus,
            staffEmail,
            staffName
          );
          return { email: item.email, ...result };
        }))
      );
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.success) {
          updated++;
        } else {
          errors++;
          logger.error('[HubSpotDeals] Remediation error:', { extra: { result_status_rejected_result_reason_result_value: result.status === 'rejected' ? result.reason : result.value } });
        }
      }
      
      if (i + BATCH_SIZE < remediationPlan.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
      
      if ((i + BATCH_SIZE) % 50 === 0) {
        logger.info('[HubSpotDeals] Remediation progress: /', { extra: { MathMin_i_BATCH_SIZE_remediationPlanLength: Math.min(i + BATCH_SIZE, remediationPlan.length), remediationPlanLength: remediationPlan.length } });
      }
    }
    
    logger.info('[HubSpotDeals] Remediation complete - Updated: , Errors', { extra: { updated, errors } });
    
    res.json({
      success: true,
      dryRun: false,
      totalDeals: members.length,
      dealsNeedingUpdate: remediationPlan.length,
      updated,
      errors,
      summary
    });
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Remediation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to remediate deal stages' });
  }
});

router.get('/api/hubspot/deal-stage-summary', isStaffOrAdmin, async (req, res) => {
  try {
    const stagesResult = await db.execute(sql`
      SELECT 
        hd.pipeline_stage,
        COUNT(*) as count,
        u.membership_status
      FROM hubspot_deals hd
      JOIN users u ON LOWER(u.email) = LOWER(hd.member_email)
      GROUP BY hd.pipeline_stage, u.membership_status
      ORDER BY hd.pipeline_stage, count DESC
    `);
    
    // Include trialing and past_due as active - they still have membership access
    const activeMembers = await db.execute(sql`
      SELECT COUNT(*) as count FROM users WHERE role = 'member' AND (membership_status IN ('active', 'trialing', 'past_due') OR stripe_subscription_id IS NOT NULL)
    `);
    
    const activeDeals = await db.execute(sql`
      SELECT COUNT(*) as count FROM hubspot_deals WHERE pipeline_stage = 'closedwon'
    `);
    
    res.json({
      stageBreakdown: stagesResult.rows,
      activeMemberCount: parseInt(activeMembers.rows[0].count as string),
      activeStageDealsCount: parseInt(activeDeals.rows[0].count as string),
      discrepancy: parseInt(activeDeals.rows[0].count as string) - parseInt(activeMembers.rows[0].count as string)
    });
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error fetching stage summary', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch stage summary' });
  }
});

router.post('/api/admin/hubspot/deals/batch-delete', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const { getHubSpotClient } = await import('../core/integrations');
    const hubspot = await getHubSpotClient();
    
    const allDeals = await db.execute(sql`SELECT id, hubspot_deal_id, member_email, deal_name FROM hubspot_deals ORDER BY id`);
    const deals = allDeals.rows;
    
    let deleted = 0;
    let failed = 0;
    const errors: string[] = [];
    
    for (const deal of deals) {
      try {
        await hubspot.crm.deals.basicApi.archive(deal.hubspot_deal_id);
        deleted++;
      } catch (err: unknown) {
        if ((err as Record<string, unknown>)?.code === 404 || (err as Record<string, unknown>)?.statusCode === 404 || (err as Error)?.message?.includes('NOT_FOUND')) {
          deleted++;
        } else {
          failed++;
          if (errors.length < 10) errors.push(`${deal.hubspot_deal_id}: ${getErrorMessage(err)}`);
        }
      }
      
      if (deleted % 50 === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    await db.execute(sql`DELETE FROM hubspot_line_items`);
    await db.execute(sql`DELETE FROM hubspot_deals`);
    
    const { logFromRequest } = await import('../core/auditLog');
    logFromRequest(req, 'bulk_action', 'system', 'all',
      `Batch deleted ${deleted} deals`, { deleted, failed, total: deals.length });
    
    logger.info('[HubSpot] Batch deleted deals from HubSpot, failures, cleared local tables', { extra: { deleted, failed } });
    
    res.json({ success: true, deleted, failed, total: deals.length, errors: errors.length > 0 ? errors : undefined });
  } catch (error: unknown) {
    logger.error('[HubSpot] Batch delete failed', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Batch delete failed' });
  }
});

export default router;
