import { Router, Request, Response } from 'express';
import { db } from '../db';
import { dayPassPurchases, passRedemptionLogs } from '../../shared/schema';
import { eq, and, gt, ilike, sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';

const router = Router();

router.get('/api/staff/passes/search', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email } = req.query;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email query parameter is required' });
    }

    const passes = await db
      .select({
        id: dayPassPurchases.id,
        productType: dayPassPurchases.productType,
        quantity: dayPassPurchases.quantity,
        remainingUses: dayPassPurchases.remainingUses,
        purchaserEmail: dayPassPurchases.purchaserEmail,
        purchaserFirstName: dayPassPurchases.purchaserFirstName,
        purchaserLastName: dayPassPurchases.purchaserLastName,
        purchasedAt: dayPassPurchases.purchasedAt,
      })
      .from(dayPassPurchases)
      .where(
        and(
          ilike(dayPassPurchases.purchaserEmail, email.trim()),
          gt(dayPassPurchases.remainingUses, 0),
          eq(dayPassPurchases.status, 'active')
        )
      )
      .orderBy(dayPassPurchases.purchasedAt);

    res.json({ passes });
  } catch (error: any) {
    console.error('[Passes] Error searching passes:', error);
    res.status(500).json({ error: 'Failed to search passes' });
  }
});

router.post('/api/staff/passes/:id/redeem', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { location } = req.body;
    const staffEmail = req.session?.user?.email;

    if (!staffEmail) {
      return res.status(401).json({ error: 'Staff email not found in session' });
    }

    const [pass] = await db
      .select()
      .from(dayPassPurchases)
      .where(eq(dayPassPurchases.id, id))
      .limit(1);

    if (!pass) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    if (pass.status !== 'active') {
      return res.status(400).json({ error: 'Pass is not active' });
    }

    const currentUses = pass.remainingUses ?? 0;
    if (currentUses <= 0) {
      return res.status(400).json({ error: 'Pass has no remaining uses' });
    }

    const newRemainingUses = currentUses - 1;
    const newStatus = newRemainingUses === 0 ? 'exhausted' : 'active';

    await db
      .update(dayPassPurchases)
      .set({
        remainingUses: newRemainingUses,
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(dayPassPurchases.id, id));

    await db.insert(passRedemptionLogs).values({
      purchaseId: id,
      redeemedBy: staffEmail,
      location: location || 'front_desk',
    });

    console.log(`[Passes] Pass ${id} redeemed by ${staffEmail}. Remaining uses: ${newRemainingUses}`);

    res.json({
      success: true,
      remainingUses: newRemainingUses,
      status: newStatus,
    });
  } catch (error: any) {
    console.error('[Passes] Error redeeming pass:', error);
    res.status(500).json({ error: 'Failed to redeem pass' });
  }
});

export default router;
