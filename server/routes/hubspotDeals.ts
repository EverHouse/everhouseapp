import { Router } from 'express';
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
  syncDealStageFromMindbodyStatus
} from '../core/hubspotDeals';
import { syncAllMembersFromHubSpot } from '../core/memberSync';
import { db } from '../db';
import { hubspotProductMappings, discountRules } from '../../shared/schema';
import { eq } from 'drizzle-orm';

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
    const staffEmail = (req as any).user?.email || 'system';
    const staffName = (req as any).user?.name || 'System';
    
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
    const staffEmail = (req as any).user?.email || 'system';
    const staffName = (req as any).user?.name || 'System';
    
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
    const staffEmail = (req as any).user?.email || 'system';
    const staffName = (req as any).user?.name || 'System';
    
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

// Manual trigger for full member sync (creates deals for all active members)
router.post('/api/hubspot/sync-all-members', isStaffOrAdmin, async (req, res) => {
  try {
    console.log('[HubSpotDeals] Manual member sync triggered');
    const result = await syncAllMembersFromHubSpot();
    console.log(`[HubSpotDeals] Manual sync complete - Synced: ${result.synced}, Errors: ${result.errors}`);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Error during manual member sync:', error);
    res.status(500).json({ error: 'Failed to sync members' });
  }
});

export default router;
