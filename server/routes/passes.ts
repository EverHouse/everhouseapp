import { Router, Request, Response } from 'express';
import { db } from '../db';
import { dayPassPurchases, passRedemptionLogs } from '../../shared/schema';
import { eq, and, gt, ilike, sql, desc } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';
import { sendRedemptionConfirmationEmail } from '../emails/passEmails';

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

    // Atomic update: decrement only if remaining_uses > 0 and status is active
    // This prevents race conditions where concurrent requests could double-redeem
    const updateResult = await db
      .update(dayPassPurchases)
      .set({
        remainingUses: sql`${dayPassPurchases.remainingUses} - 1`,
        status: sql`CASE WHEN ${dayPassPurchases.remainingUses} - 1 = 0 THEN 'exhausted' ELSE 'active' END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dayPassPurchases.id, id),
          eq(dayPassPurchases.status, 'active'),
          gt(dayPassPurchases.remainingUses, 0)
        )
      )
      .returning({
        remainingUses: dayPassPurchases.remainingUses,
        status: dayPassPurchases.status,
      });

    if (updateResult.length === 0) {
      // No rows updated - pass doesn't exist, is not active, or has no uses
      const [pass] = await db
        .select({ 
          status: dayPassPurchases.status, 
          remainingUses: dayPassPurchases.remainingUses,
          quantity: dayPassPurchases.quantity,
          purchaserEmail: dayPassPurchases.purchaserEmail,
          purchaserFirstName: dayPassPurchases.purchaserFirstName,
          purchaserLastName: dayPassPurchases.purchaserLastName,
          productType: dayPassPurchases.productType
        })
        .from(dayPassPurchases)
        .where(eq(dayPassPurchases.id, id))
        .limit(1);

      if (!pass) {
        return res.status(404).json({ 
          error: 'Pass not found',
          errorCode: 'PASS_NOT_FOUND'
        });
      }
      
      // Get redemption history for this pass
      const logs = await db
        .select({
          redeemedAt: passRedemptionLogs.redeemedAt,
          redeemedBy: passRedemptionLogs.redeemedBy,
          location: passRedemptionLogs.location,
        })
        .from(passRedemptionLogs)
        .where(eq(passRedemptionLogs.purchaseId, id))
        .orderBy(desc(passRedemptionLogs.redeemedAt))
        .limit(10);

      // Check if already redeemed today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const redeemedToday = logs.find(log => new Date(log.redeemedAt) >= today);
      
      if (pass.status !== 'active') {
        return res.status(400).json({ 
          error: 'Pass is not active',
          errorCode: 'PASS_NOT_ACTIVE',
          passDetails: {
            email: pass.purchaserEmail,
            name: [pass.purchaserFirstName, pass.purchaserLastName].filter(Boolean).join(' '),
            productType: pass.productType,
            totalUses: pass.quantity,
            usedCount: (pass.quantity ?? 1) - (pass.remainingUses ?? 0)
          }
        });
      }
      if ((pass.remainingUses ?? 0) <= 0) {
        return res.status(409).json({ 
          error: 'Pass has no remaining uses',
          errorCode: 'PASS_EXHAUSTED',
          passDetails: {
            email: pass.purchaserEmail,
            name: [pass.purchaserFirstName, pass.purchaserLastName].filter(Boolean).join(' '),
            productType: pass.productType,
            totalUses: pass.quantity,
            usedCount: (pass.quantity ?? 1) - (pass.remainingUses ?? 0),
            lastRedemption: logs[0] ? logs[0].redeemedAt : null,
            history: logs
          }
        });
      }
      
      // Check if already redeemed today
      if (redeemedToday) {
        return res.status(409).json({ 
          error: 'Already redeemed today',
          errorCode: 'ALREADY_REDEEMED_TODAY',
          passDetails: {
            email: pass.purchaserEmail,
            name: [pass.purchaserFirstName, pass.purchaserLastName].filter(Boolean).join(' '),
            productType: pass.productType,
            remainingUses: pass.remainingUses,
            redeemedTodayAt: redeemedToday.redeemedAt
          }
        });
      }
      
      return res.status(409).json({ error: 'Pass could not be redeemed', errorCode: 'REDEMPTION_FAILED' });
    }

    const { remainingUses, status } = updateResult[0];

    await db.insert(passRedemptionLogs).values({
      purchaseId: id,
      redeemedBy: staffEmail,
      location: location || 'front_desk',
    });

    const [passDetails] = await db
      .select({
        purchaserEmail: dayPassPurchases.purchaserEmail,
        purchaserFirstName: dayPassPurchases.purchaserFirstName,
        purchaserLastName: dayPassPurchases.purchaserLastName,
        productType: dayPassPurchases.productType,
        quantity: dayPassPurchases.quantity,
      })
      .from(dayPassPurchases)
      .where(eq(dayPassPurchases.id, id))
      .limit(1);

    const guestName = [passDetails?.purchaserFirstName, passDetails?.purchaserLastName]
      .filter(Boolean)
      .join(' ') || 'Guest';

    console.log(`[Passes] Pass ${id} redeemed by ${staffEmail}. Remaining uses: ${remainingUses}`);

    if (passDetails?.purchaserEmail) {
      sendRedemptionConfirmationEmail(passDetails.purchaserEmail, {
        guestName,
        passType: passDetails.productType,
        remainingUses: remainingUses ?? 0,
        redeemedAt: new Date(),
      }).catch(err => console.error('[Passes] Email send failed:', err));
    }

    res.json({
      success: true,
      remainingUses,
      status,
      passHolder: {
        email: passDetails?.purchaserEmail || '',
        name: guestName,
        firstName: passDetails?.purchaserFirstName || '',
        lastName: passDetails?.purchaserLastName || '',
        productType: passDetails?.productType || '',
        totalUses: passDetails?.quantity || 1,
      },
      redeemedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[Passes] Error redeeming pass:', error);
    res.status(500).json({ error: 'Failed to redeem pass' });
  }
});

router.get('/api/staff/passes/:passId/history', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { passId } = req.params;

    const logs = await db
      .select({
        redeemedAt: passRedemptionLogs.redeemedAt,
        redeemedBy: passRedemptionLogs.redeemedBy,
        location: passRedemptionLogs.location,
      })
      .from(passRedemptionLogs)
      .where(eq(passRedemptionLogs.purchaseId, passId))
      .orderBy(desc(passRedemptionLogs.redeemedAt))
      .limit(5);

    res.json({ logs });
  } catch (error: any) {
    console.error('[Passes] Error fetching pass history:', error);
    res.status(500).json({ error: 'Failed to fetch pass history' });
  }
});

export default router;
