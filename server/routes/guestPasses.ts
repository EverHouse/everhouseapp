import { Router } from 'express';
import { eq, sql, and, lt } from 'drizzle-orm';
import { db } from '../db';
import { guestPasses, notifications } from '../../shared/schema';
import { getTierLimits } from '../core/tierService';
import { sendPushNotification } from './push';
import { logAndRespond } from '../core/logger';
import { withRetry } from '../core/retry';

const router = Router();

router.get('/api/guest-passes/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const { tier } = req.query;
    
    const tierLimits = tier ? await getTierLimits(tier as string) : null;
    const passesTotal = tierLimits?.guest_passes_per_month ?? 0;
    
    let result = await withRetry(() => 
      db.select()
        .from(guestPasses)
        .where(eq(guestPasses.memberEmail, email))
    );
    
    if (result.length === 0) {
      await withRetry(() =>
        db.insert(guestPasses)
          .values({
            memberEmail: email,
            passesUsed: 0,
            passesTotal: passesTotal
          })
      );
      result = await withRetry(() =>
        db.select()
          .from(guestPasses)
          .where(eq(guestPasses.memberEmail, email))
      );
    } else if (result[0].passesTotal !== passesTotal) {
      await withRetry(() =>
        db.update(guestPasses)
          .set({ passesTotal: passesTotal })
          .where(eq(guestPasses.memberEmail, email))
      );
      result[0].passesTotal = passesTotal;
    }
    
    const data = result[0];
    res.json({
      passes_used: data.passesUsed,
      passes_total: data.passesTotal,
      passes_remaining: data.passesTotal - data.passesUsed
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch guest passes', error, 'GUEST_PASSES_FETCH_ERROR');
  }
});

router.post('/api/guest-passes/:email/use', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const { guest_name } = req.body;
    
    const result = await db.update(guestPasses)
      .set({ passesUsed: sql`${guestPasses.passesUsed} + 1` })
      .where(and(
        eq(guestPasses.memberEmail, email),
        lt(guestPasses.passesUsed, guestPasses.passesTotal)
      ))
      .returning();
    
    if (result.length === 0) {
      return res.status(400).json({ error: 'No guest passes remaining' });
    }
    
    const data = result[0];
    const remaining = data.passesTotal - data.passesUsed;
    const message = guest_name 
      ? `Guest pass used for ${guest_name}. You have ${remaining} pass${remaining !== 1 ? 'es' : ''} remaining this month.`
      : `Guest pass used. You have ${remaining} pass${remaining !== 1 ? 'es' : ''} remaining this month.`;
    
    await db.insert(notifications).values({
      userEmail: email,
      title: 'Guest Pass Used',
      message: message,
      type: 'guest_pass',
      relatedType: 'guest_pass'
    });
    
    sendPushNotification(email, {
      title: 'Guest Pass Used',
      body: message,
      url: '/#/profile'
    }).catch(err => console.error('Push notification failed:', err));
    
    res.json({
      passes_used: data.passesUsed,
      passes_total: data.passesTotal,
      passes_remaining: remaining
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to use guest pass', error, 'GUEST_PASS_USE_ERROR');
  }
});

router.put('/api/guest-passes/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const { passes_total } = req.body;
    
    const result = await db.update(guestPasses)
      .set({ passesTotal: passes_total })
      .where(eq(guestPasses.memberEmail, email))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const data = result[0];
    res.json({
      passes_used: data.passesUsed,
      passes_total: data.passesTotal,
      passes_remaining: data.passesTotal - data.passesUsed
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to update guest passes', error, 'GUEST_PASS_UPDATE_ERROR');
  }
});

export default router;
