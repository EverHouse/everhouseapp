import { Router } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { isProduction, pool } from '../core/db';
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
import { syncAllMembersFromHubSpot, syncCommunicationLogsFromHubSpot, getLastMemberSyncTime, setLastMemberSyncTime } from '../core/memberSync';
import { db } from '../db';
import { hubspotProductMappings, discountRules, hubspotDeals } from '../../shared/schema';
import { eq, and, ne } from 'drizzle-orm';
import { MINDBODY_TO_STAGE_MAP, HUBSPOT_STAGE_IDS } from '../core/hubspot/constants';
import { getSessionUser } from '../types/session';
import pLimit from 'p-limit';

const router = Router();

router.get('/api/hubspot/deals/member/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const deal = await getMemberDealWithLineItems(email);
    
    if (!deal) {
      return res.json({ deal: null, message: 'No deal found for this member' });
    }
    
    res.json({ deal });
  } catch (error: any) {
    if (!isProduction) console.error('Error fetching member deal:', error);
    res.status(500).json({ error: 'Failed to fetch member deal' });
  }
});

router.get('/api/hubspot/products', isStaffOrAdmin, async (req, res) => {
  try {
    const products = await getAllProductMappings();
    res.json({ products });
  } catch (error: any) {
    if (!isProduction) console.error('Error fetching products:', error);
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
      .where(eq(hubspotProductMappings.id, parseInt(id)));
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('Error updating product:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.get('/api/hubspot/discount-rules', isStaffOrAdmin, async (req, res) => {
  try {
    const rules = await getAllDiscountRules();
    res.json({ rules });
  } catch (error: any) {
    if (!isProduction) console.error('Error fetching discount rules:', error);
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
      .where(eq(discountRules.discountTag, decodeURIComponent(tag)));
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('Error updating discount rule:', error);
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
      dealId,
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
  } catch (error: any) {
    if (!isProduction) console.error('Error adding line item:', error);
    res.status(500).json({ error: 'Failed to add line item' });
  }
});

router.delete('/api/hubspot/line-items/:lineItemId', isStaffOrAdmin, async (req, res) => {
  try {
    const { lineItemId } = req.params;
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'system';
    const staffName = sessionUser?.name || 'System';
    
    const success = await removeLineItemFromDeal(lineItemId, staffEmail, staffName);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to remove line item' });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('Error removing line item:', error);
    res.status(500).json({ error: 'Failed to remove line item' });
  }
});

router.get('/api/hubspot/billing-audit/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    
    const auditLog = await getBillingAuditLog(email, limit);
    res.json({ auditLog });
  } catch (error: any) {
    if (!isProduction) console.error('Error fetching billing audit log:', error);
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
  } catch (error: any) {
    if (!isProduction) console.error('Error calculating discount:', error);
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
  } catch (error: any) {
    if (!isProduction) console.error('Error syncing deal stage:', error);
    res.status(500).json({ error: 'Failed to sync deal stage' });
  }
});

// Get last sync status
router.get('/api/hubspot/sync-status', isStaffOrAdmin, async (req, res) => {
  const lastSync = getLastMemberSyncTime();
  res.json({ 
    lastSyncTime: lastSync > 0 ? new Date(lastSync).toISOString() : null,
    lastSyncTimestamp: lastSync
  });
});

// Manual trigger for full member sync (creates deals for all active members)
router.post('/api/hubspot/sync-all-members', isStaffOrAdmin, async (req, res) => {
  try {
    console.log('[HubSpotDeals] Manual member sync triggered');
    const result = await syncAllMembersFromHubSpot();
    await setLastMemberSyncTime(Date.now());
    console.log(`[HubSpotDeals] Manual sync complete - Synced: ${result.synced}, Errors: ${result.errors}`);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Error during manual member sync:', error);
    res.status(500).json({ error: 'Failed to sync members' });
  }
});

// Manual trigger for communication logs sync (calls, SMS from HubSpot)
router.post('/api/hubspot/sync-communication-logs', isStaffOrAdmin, async (req, res) => {
  try {
    console.log('[HubSpotDeals] Manual communication logs sync triggered');
    const result = await syncCommunicationLogsFromHubSpot();
    console.log(`[HubSpotDeals] Comm logs sync complete - Synced: ${result.synced}, Errors: ${result.errors}`);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Error during communication logs sync:', error);
    res.status(500).json({ error: 'Failed to sync communication logs' });
  }
});

// Push member data (tier, billing_provider, lifecycle) TO HubSpot for all active members
router.post('/api/hubspot/push-members-to-hubspot', isStaffOrAdmin, async (req, res) => {
  try {
    console.log('[HubSpotDeals] Push members to HubSpot triggered');
    const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
    
    // Get all active members with HubSpot IDs
    const membersResult = await pool.query(`
      SELECT email, membership_tier, billing_provider, membership_status
      FROM users
      WHERE role = 'member'
        AND hubspot_id IS NOT NULL
        AND membership_status IN ('active', 'trialing', 'past_due')
    `);
    
    const members = membersResult.rows;
    console.log(`[HubSpotDeals] Found ${members.length} active members to sync to HubSpot`);
    
    let synced = 0;
    let errors = 0;
    const errorDetails: string[] = [];
    
    for (const member of members) {
      try {
        await syncMemberToHubSpot({
          email: member.email,
          status: member.membership_status,
          tier: member.membership_tier,
          billingProvider: member.billing_provider
        });
        synced++;
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error: any) {
        errors++;
        errorDetails.push(`${member.email}: ${error.message}`);
        console.error(`[HubSpotDeals] Error syncing ${member.email}:`, error.message);
      }
    }
    
    console.log(`[HubSpotDeals] Push complete - Synced: ${synced}, Errors: ${errors}`);
    res.json({ success: true, total: members.length, synced, errors, errorDetails: errorDetails.slice(0, 10) });
  } catch (error: any) {
    console.error('Error pushing members to HubSpot:', error);
    res.status(500).json({ error: 'Failed to push members to HubSpot' });
  }
});

router.post('/api/hubspot/remediate-deal-stages', isStaffOrAdmin, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'system';
    const staffName = sessionUser?.name || 'Remediation Script';
    const dryRun = req.body.dryRun === true;
    
    console.log(`[HubSpotDeals] Deal stage remediation started (dryRun: ${dryRun})`);
    
    const membersResult = await pool.query(`
      SELECT u.email, u.membership_status, hd.hubspot_deal_id, hd.pipeline_stage
      FROM users u
      JOIN hubspot_deals hd ON LOWER(u.email) = LOWER(hd.member_email)
      WHERE u.role = 'member'
    `);
    
    const members = membersResult.rows;
    console.log(`[HubSpotDeals] Found ${members.length} members with deals to check`);
    
    const remediationPlan: {
      email: string;
      currentStage: string;
      targetStage: string;
      membershipStatus: string;
    }[] = [];
    
    for (const member of members) {
      const normalizedStatus = (member.membership_status || 'non-member').toLowerCase().replace(/[^a-z-]/g, '');
      const targetStage = MINDBODY_TO_STAGE_MAP[normalizedStatus] || HUBSPOT_STAGE_IDS.CLOSED_LOST;
      
      if (member.pipeline_stage !== targetStage) {
        remediationPlan.push({
          email: member.email,
          currentStage: member.pipeline_stage,
          targetStage,
          membershipStatus: normalizedStatus
        });
      }
    }
    
    console.log(`[HubSpotDeals] ${remediationPlan.length} deals need stage updates`);
    
    const summary = {
      toActive: remediationPlan.filter(r => r.targetStage === HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE).length,
      toPaymentDeclined: remediationPlan.filter(r => r.targetStage === HUBSPOT_STAGE_IDS.PAYMENT_DECLINED).length,
      toClosedLost: remediationPlan.filter(r => r.targetStage === HUBSPOT_STAGE_IDS.CLOSED_LOST).length
    };
    
    console.log(`[HubSpotDeals] Remediation summary - Active: ${summary.toActive}, Payment Declined: ${summary.toPaymentDeclined}, Closed Lost: ${summary.toClosedLost}`);
    
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
          console.error(`[HubSpotDeals] Remediation error:`, result.status === 'rejected' ? result.reason : result.value);
        }
      }
      
      if (i + BATCH_SIZE < remediationPlan.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
      
      if ((i + BATCH_SIZE) % 50 === 0) {
        console.log(`[HubSpotDeals] Remediation progress: ${Math.min(i + BATCH_SIZE, remediationPlan.length)}/${remediationPlan.length}`);
      }
    }
    
    console.log(`[HubSpotDeals] Remediation complete - Updated: ${updated}, Errors: ${errors}`);
    
    res.json({
      success: true,
      dryRun: false,
      totalDeals: members.length,
      dealsNeedingUpdate: remediationPlan.length,
      updated,
      errors,
      summary
    });
  } catch (error: any) {
    console.error('[HubSpotDeals] Remediation error:', error);
    res.status(500).json({ error: 'Failed to remediate deal stages' });
  }
});

router.get('/api/hubspot/deal-stage-summary', isStaffOrAdmin, async (req, res) => {
  try {
    const stagesResult = await pool.query(`
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
    const activeMembers = await pool.query(`
      SELECT COUNT(*) as count FROM users WHERE role = 'member' AND (membership_status IN ('active', 'trialing', 'past_due') OR stripe_subscription_id IS NOT NULL)
    `);
    
    const activeDeals = await pool.query(`
      SELECT COUNT(*) as count FROM hubspot_deals WHERE pipeline_stage = 'closedwon'
    `);
    
    res.json({
      stageBreakdown: stagesResult.rows,
      activeMemberCount: parseInt(activeMembers.rows[0].count),
      activeStageDealsCount: parseInt(activeDeals.rows[0].count),
      discrepancy: parseInt(activeDeals.rows[0].count) - parseInt(activeMembers.rows[0].count)
    });
  } catch (error: any) {
    console.error('[HubSpotDeals] Error fetching stage summary:', error);
    res.status(500).json({ error: 'Failed to fetch stage summary' });
  }
});

export default router;
