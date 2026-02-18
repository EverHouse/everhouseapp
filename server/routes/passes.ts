import { logger } from '../core/logger';
import { Router, Request, Response } from 'express';
import { db } from '../db';
import { dayPassPurchases, passRedemptionLogs } from '../../shared/schema';
import { eq, and, gt, ilike, sql, desc } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';
import { sendRedemptionConfirmationEmail } from '../emails/passEmails';
import { broadcastDayPassUpdate } from '../core/websocket';
import { getStripeClient } from '../core/stripe/client';
import { getErrorMessage } from '../utils/errorUtils';
import { getPacificMidnightUTC } from '../utils/dateUtils';
import { logFromRequest } from '../core/auditLog';

const router = Router();

router.get('/api/staff/passes/unredeemed', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
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
          gt(dayPassPurchases.remainingUses, 0),
          eq(dayPassPurchases.status, 'active')
        )
      )
      .orderBy(desc(dayPassPurchases.purchasedAt))
      .limit(50);

    res.json({ passes });
  } catch (error: unknown) {
    logger.error('[Passes] Error fetching unredeemed passes', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch unredeemed passes' });
  }
});

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
  } catch (error: unknown) {
    logger.error('[Passes] Error searching passes', { error: error instanceof Error ? error : new Error(String(error)) });
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
          eq(dayPassPurchases.id, id as string),
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
        .where(eq(dayPassPurchases.id, id as string))
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
        .where(eq(passRedemptionLogs.purchaseId, id as string))
        .orderBy(desc(passRedemptionLogs.redeemedAt))
        .limit(10);

      // Check if already redeemed today
      const todayMidnightPacific = getPacificMidnightUTC();
      const redeemedToday = logs.find(log => new Date(log.redeemedAt as Date) >= todayMidnightPacific);
      
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
      purchaseId: id as string,
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
      .where(eq(dayPassPurchases.id, id as string))
      .limit(1);

    const guestName = [passDetails?.purchaserFirstName, passDetails?.purchaserLastName]
      .filter(Boolean)
      .join(' ') || 'Guest';

    logger.info('[Passes] Pass redeemed by . Remaining uses', { extra: { id, staffEmail, remainingUses } });

    if (passDetails?.purchaserEmail) {
      sendRedemptionConfirmationEmail(passDetails.purchaserEmail, {
        guestName,
        passType: passDetails.productType,
        remainingUses: remainingUses ?? 0,
        redeemedAt: new Date(),
      }).catch(err => logger.error('[Passes] Email send failed:', { extra: { err } }));
    }

    broadcastDayPassUpdate({
      action: 'day_pass_redeemed',
      passId: id as string,
      purchaserEmail: passDetails?.purchaserEmail,
      purchaserName: guestName,
      productType: passDetails?.productType,
      remainingUses: remainingUses ?? 0,
      quantity: passDetails?.quantity || 1,
    });

    logFromRequest(req, 'redeem_pass', 'day_pass', id as string, guestName, {
      passType: passDetails?.productType,
      remainingUses: remainingUses ?? 0,
      location: location || 'front_desk',
    });

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
  } catch (error: unknown) {
    logger.error('[Passes] Error redeeming pass', { error: error instanceof Error ? error : new Error(String(error)) });
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
      .where(eq(passRedemptionLogs.purchaseId, passId as string))
      .orderBy(desc(passRedemptionLogs.redeemedAt))
      .limit(5);

    res.json({ logs });
  } catch (error: unknown) {
    logger.error('[Passes] Error fetching pass history', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch pass history' });
  }
});

router.post('/api/staff/passes/:passId/refund', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { passId } = req.params;
    const staffEmail = req.session?.user?.email;

    if (!staffEmail) {
      return res.status(401).json({ error: 'Staff email not found in session' });
    }

    const [pass] = await db
      .select({
        id: dayPassPurchases.id,
        status: dayPassPurchases.status,
        remainingUses: dayPassPurchases.remainingUses,
        purchaserEmail: dayPassPurchases.purchaserEmail,
        purchaserFirstName: dayPassPurchases.purchaserFirstName,
        purchaserLastName: dayPassPurchases.purchaserLastName,
        productType: dayPassPurchases.productType,
        quantity: dayPassPurchases.quantity,
        stripePaymentIntentId: dayPassPurchases.stripePaymentIntentId,
      })
      .from(dayPassPurchases)
      .where(eq(dayPassPurchases.id, passId as string))
      .limit(1);

    if (!pass) {
      return res.status(404).json({ error: 'Pass not found', errorCode: 'PASS_NOT_FOUND' });
    }

    if (pass.status !== 'active') {
      return res.status(400).json({ 
        error: 'Pass is not active and cannot be refunded', 
        errorCode: 'PASS_NOT_ACTIVE',
        currentStatus: pass.status
      });
    }

    // Process Stripe refund BEFORE updating database
    try {
      const stripe = await getStripeClient();
      const refund = await stripe.refunds.create({
        payment_intent: pass.stripePaymentIntentId,
        reason: 'requested_by_customer'
      }, {
        idempotencyKey: `refund_guest_pass_${passId}_${pass.stripePaymentIntentId}`
      });
      logger.info('[Passes] Stripe refund created for pass', { extra: { passId, refundId: refund.id } });
    } catch (stripeError: unknown) {
      logger.error('[Passes] Stripe refund failed for pass', { extra: { passId, error: getErrorMessage(stripeError) } });
      return res.status(400).json({ 
        error: 'Failed to process refund with payment processor',
        errorCode: 'STRIPE_REFUND_FAILED',
        details: getErrorMessage(stripeError)
      });
    }

    // Only update database status AFTER Stripe refund succeeds
    await db
      .update(dayPassPurchases)
      .set({
        status: 'refunded',
        updatedAt: new Date(),
      })
      .where(eq(dayPassPurchases.id, passId as string));

    const guestName = [pass.purchaserFirstName, pass.purchaserLastName]
      .filter(Boolean)
      .join(' ') || 'Guest';

    logger.info('[Passes] Pass refunded by . Previous remaining uses', { extra: { passId, staffEmail, passRemainingUses: pass.remainingUses } });

    broadcastDayPassUpdate({
      action: 'day_pass_refunded',
      passId: passId as string,
      purchaserEmail: pass.purchaserEmail,
      purchaserName: guestName,
      productType: pass.productType,
      remainingUses: 0,
      quantity: pass.quantity || 1,
    });

    logFromRequest(req, 'refund_pass', 'day_pass', passId as string, guestName, {
      passType: pass.productType,
      previousRemainingUses: pass.remainingUses,
      stripePaymentIntentId: pass.stripePaymentIntentId,
    });

    res.json({
      success: true,
      passId: passId,
      refundedBy: staffEmail,
    });
  } catch (error: unknown) {
    logger.error('[Passes] Error refunding pass', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to refund pass' });
  }
});

export default router;
