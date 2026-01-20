import { Router } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import {
  syncFamilyAddOnProductsToStripe,
  getFamilyAddOnProducts,
  getFamilyGroupByPrimaryEmail,
  getFamilyGroupByMemberEmail,
  createFamilyGroup,
  addFamilyMember,
  removeFamilyMember,
  linkStripeSubscriptionToFamilyGroup,
  updateFamilyAddOnPricing,
  getAllFamilyGroups,
  reconcileFamilyBillingWithStripe,
} from '../core/stripe/familyBilling';

const router = Router();

router.get('/api/family-billing/products', isStaffOrAdmin, async (req, res) => {
  try {
    const products = await getFamilyAddOnProducts();
    res.json(products);
  } catch (error: any) {
    console.error('[FamilyBilling] Error getting products:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/family-billing/products/sync', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await syncFamilyAddOnProductsToStripe();
    res.json(result);
  } catch (error: any) {
    console.error('[FamilyBilling] Error syncing products:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/family-billing/products/:tierName', isStaffOrAdmin, async (req, res) => {
  try {
    const { tierName } = req.params;
    const { priceCents } = req.body;
    
    if (typeof priceCents !== 'number' || priceCents < 0) {
      return res.status(400).json({ error: 'Invalid price' });
    }
    
    const result = await updateFamilyAddOnPricing({ tierName, priceCents });
    
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error: any) {
    console.error('[FamilyBilling] Error updating pricing:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/family-billing/groups', isStaffOrAdmin, async (req, res) => {
  try {
    const groups = await getAllFamilyGroups();
    res.json(groups);
  } catch (error: any) {
    console.error('[FamilyBilling] Error getting all groups:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/family-billing/group/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const group = await getFamilyGroupByMemberEmail(email);
    
    if (!group) {
      return res.status(404).json({ error: 'Family group not found' });
    }
    
    res.json(group);
  } catch (error: any) {
    console.error('[FamilyBilling] Error getting group:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/family-billing/groups', isStaffOrAdmin, async (req, res) => {
  try {
    const { primaryEmail, groupName } = req.body;
    const user = req.user as any;
    
    if (!primaryEmail) {
      return res.status(400).json({ error: 'Primary email is required' });
    }
    
    const result = await createFamilyGroup({
      primaryEmail,
      groupName,
      createdBy: user?.email || 'staff',
      createdByName: user?.displayName || 'Staff Member',
    });
    
    if (result.success) {
      res.json({ success: true, groupId: result.groupId });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error: any) {
    console.error('[FamilyBilling] Error creating group:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/family-billing/groups/:groupId/members', isStaffOrAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { memberEmail, memberTier, relationship } = req.body;
    const user = req.user as any;
    
    if (!memberEmail || !memberTier) {
      return res.status(400).json({ error: 'Member email and tier are required' });
    }
    
    const result = await addFamilyMember({
      familyGroupId: parseInt(groupId, 10),
      memberEmail,
      memberTier,
      relationship,
      addedBy: user?.email || 'staff',
      addedByName: user?.displayName || 'Staff Member',
    });
    
    if (result.success) {
      res.json({ success: true, memberId: result.memberId });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error: any) {
    console.error('[FamilyBilling] Error adding member:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/api/family-billing/members/:memberId', isStaffOrAdmin, async (req, res) => {
  try {
    const { memberId } = req.params;
    const user = req.user as any;
    
    const result = await removeFamilyMember({
      memberId: parseInt(memberId, 10),
      removedBy: user?.email || 'staff',
    });
    
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error: any) {
    console.error('[FamilyBilling] Error removing member:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/family-billing/groups/:groupId/link-subscription', isStaffOrAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { stripeSubscriptionId } = req.body;
    
    if (!stripeSubscriptionId) {
      return res.status(400).json({ error: 'Stripe subscription ID is required' });
    }
    
    const result = await linkStripeSubscriptionToFamilyGroup({
      familyGroupId: parseInt(groupId, 10),
      stripeSubscriptionId,
    });
    
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error: any) {
    console.error('[FamilyBilling] Error linking subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/family-billing/reconcile', isStaffOrAdmin, async (req, res) => {
  try {
    console.log('[FamilyBilling] Starting reconciliation with Stripe...');
    const result = await reconcileFamilyBillingWithStripe();
    console.log(`[FamilyBilling] Reconciliation complete: ${result.groupsChecked} groups checked, ${result.membersDeactivated} deactivated, ${result.membersReactivated} reactivated, ${result.membersCreated} created, ${result.itemsRelinked} relinked`);
    res.json(result);
  } catch (error: any) {
    console.error('[FamilyBilling] Error during reconciliation:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
