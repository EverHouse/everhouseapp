import { Router } from 'express';
import { eq, sql, and, lt, inArray } from 'drizzle-orm';
import { db } from '../db';
import { guestPasses, notifications, staffUsers, bookingRequests } from '../../shared/schema';
import { getTierLimits } from '../core/tierService';
import { sendPushNotification } from './push';
import { sendNotificationToUser } from '../core/websocket';
import { logAndRespond } from '../core/logger';
import { withRetry } from '../core/retry';
import { getSessionUser } from '../types/session';

const router = Router();

async function isStaffOrAdminCheck(email: string): Promise<boolean> {
  const [staff] = await db.select({ id: staffUsers.id })
    .from(staffUsers)
    .where(and(
      eq(staffUsers.email, email.toLowerCase()),
      eq(staffUsers.isActive, true)
    ))
    .limit(1);
  return !!staff;
}

router.get('/api/guest-passes/:email', async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const email = decodeURIComponent(req.params.email);
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const requestedEmail = email.toLowerCase();
    
    const isStaff = await isStaffOrAdminCheck(sessionEmail);
    
    if (sessionEmail !== requestedEmail) {
      if (!isStaff) {
        return res.status(403).json({ error: 'You can only view your own guest passes' });
      }
    }
    
    // Get the member's actual tier from the database - don't trust client-provided tier
    // Staff can optionally override with query param, but members must use their actual tier
    let actualTier: string | null = null;
    const { tier: clientTier } = req.query;
    
    if (isStaff && clientTier) {
      // Staff can specify a tier for testing/override purposes
      actualTier = clientTier as string;
    } else {
      // Look up the member's actual tier from the users table - don't trust client input
      const userResult = await withRetry(() =>
        db.execute(sql`SELECT tier FROM users WHERE LOWER(email) = LOWER(${requestedEmail}) LIMIT 1`)
      );
      actualTier = (userResult as any).rows?.[0]?.tier || null;
    }
    
    const tierLimits = actualTier ? await getTierLimits(actualTier) : null;
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
    } else if (result[0].passesTotal < passesTotal) {
      await withRetry(() =>
        db.update(guestPasses)
          .set({ passesTotal: passesTotal })
          .where(eq(guestPasses.memberEmail, email))
      );
      result[0].passesTotal = passesTotal;
    }
    
    const data = result[0];
    
    // Count guests in pending/approved booking requests (not yet attended/completed)
    // These represent "reserved" guest passes that haven't been officially consumed yet
    let pendingGuestCount = 0;
    try {
      const pendingBookings = await db.select({
        requestParticipants: bookingRequests.requestParticipants
      })
        .from(bookingRequests)
        .where(and(
          eq(sql`LOWER(${bookingRequests.userEmail})`, requestedEmail),
          inArray(bookingRequests.status, ['pending', 'pending_approval', 'approved', 'confirmed'])
        ));
      
      for (const booking of pendingBookings) {
        const participants = booking.requestParticipants;
        if (Array.isArray(participants)) {
          // Count guests that have either email OR userId (directory-selected guests)
          pendingGuestCount += participants.filter((p: any) => 
            p.type === 'guest' && (p.email || p.userId)
          ).length;
        }
      }
    } catch (err) {
      console.error('[GuestPasses] Error counting pending guests:', err);
    }
    
    const passesRemaining = data.passesTotal - data.passesUsed;
    const conservativeRemaining = Math.max(0, passesRemaining - pendingGuestCount);
    
    res.json({
      passes_used: data.passesUsed,
      passes_total: data.passesTotal,
      passes_remaining: passesRemaining,
      passes_pending: pendingGuestCount,
      passes_remaining_conservative: conservativeRemaining
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch guest passes', error, 'GUEST_PASSES_FETCH_ERROR');
  }
});

router.post('/api/guest-passes/:email/use', async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const email = decodeURIComponent(req.params.email);
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const requestedEmail = email.toLowerCase();
    
    if (sessionEmail !== requestedEmail) {
      const hasStaffAccess = await isStaffOrAdminCheck(sessionEmail);
      if (!hasStaffAccess) {
        return res.status(403).json({ error: 'You can only use your own guest passes' });
      }
    }
    
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
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const hasStaffAccess = await isStaffOrAdminCheck(sessionEmail);
    if (!hasStaffAccess) {
      return res.status(403).json({ error: 'Staff access required to modify guest passes' });
    }
    
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

export async function useGuestPass(
  memberEmail: string, 
  guestName?: string,
  sendNotification: boolean = true
): Promise<{ success: boolean; error?: string; remaining?: number }> {
  try {
    const result = await db.update(guestPasses)
      .set({ passesUsed: sql`${guestPasses.passesUsed} + 1` })
      .where(and(
        eq(guestPasses.memberEmail, memberEmail),
        lt(guestPasses.passesUsed, guestPasses.passesTotal)
      ))
      .returning();
    
    if (result.length === 0) {
      return { success: false, error: 'No guest passes remaining' };
    }
    
    const data = result[0];
    const remaining = data.passesTotal - data.passesUsed;
    
    if (sendNotification) {
      const message = guestName 
        ? `Guest pass used for ${guestName}. You have ${remaining} pass${remaining !== 1 ? 'es' : ''} remaining this month.`
        : `Guest pass used. You have ${remaining} pass${remaining !== 1 ? 'es' : ''} remaining this month.`;
      
      await db.insert(notifications).values({
        userEmail: memberEmail,
        title: 'Guest Pass Used',
        message: message,
        type: 'guest_pass',
        relatedType: 'guest_pass'
      });
      
      sendPushNotification(memberEmail, {
        title: 'Guest Pass Used',
        body: message,
        url: '/#/profile'
      }).catch(err => console.error('Push notification failed:', err));
    }
    
    return { success: true, remaining };
  } catch (error) {
    console.error('[useGuestPass] Error:', error);
    return { success: false, error: 'Failed to use guest pass' };
  }
}

export async function refundGuestPass(
  memberEmail: string,
  guestName?: string,
  sendNotification: boolean = true
): Promise<{ success: boolean; error?: string; remaining?: number }> {
  try {
    const result = await db.update(guestPasses)
      .set({ passesUsed: sql`GREATEST(0, ${guestPasses.passesUsed} - 1)` })
      .where(eq(guestPasses.memberEmail, memberEmail))
      .returning();
    
    if (result.length === 0) {
      return { success: false, error: 'Member guest pass record not found' };
    }
    
    const data = result[0];
    const remaining = data.passesTotal - data.passesUsed;
    
    if (sendNotification) {
      const message = guestName 
        ? `Guest pass refunded for ${guestName}. You now have ${remaining} pass${remaining !== 1 ? 'es' : ''} remaining this month.`
        : `Guest pass refunded. You now have ${remaining} pass${remaining !== 1 ? 'es' : ''} remaining this month.`;
      
      await db.insert(notifications).values({
        userEmail: memberEmail,
        title: 'Guest Pass Refunded',
        message: message,
        type: 'guest_pass',
        relatedType: 'guest_pass'
      });
      
      // Send push notification
      sendPushNotification(memberEmail, {
        title: 'Guest Pass Refunded',
        body: message,
        url: '/#/profile'
      }).catch(err => console.error('Push notification failed:', err));
      
      // Send WebSocket notification
      sendNotificationToUser(memberEmail, {
        type: 'guest_pass',
        title: 'Guest Pass Refunded',
        message: message
      });
    }
    
    return { success: true, remaining };
  } catch (error) {
    console.error('[refundGuestPass] Error:', error);
    return { success: false, error: 'Failed to refund guest pass' };
  }
}

export async function getGuestPassesRemaining(memberEmail: string, tier?: string): Promise<number> {
  try {
    const result = await db.select()
      .from(guestPasses)
      .where(eq(guestPasses.memberEmail, memberEmail));
    
    if (result.length === 0) {
      const tierLimits = tier ? await getTierLimits(tier) : null;
      return tierLimits?.guest_passes_per_month ?? 0;
    }
    
    return Math.max(0, result[0].passesTotal - result[0].passesUsed);
  } catch (error) {
    console.error('[getGuestPassesRemaining] Error:', error);
    return 0;
  }
}

export async function ensureGuestPassRecord(memberEmail: string, tier?: string): Promise<void> {
  try {
    const tierLimits = tier ? await getTierLimits(tier) : null;
    const passesTotal = tierLimits?.guest_passes_per_month ?? 0;
    
    const existing = await db.select()
      .from(guestPasses)
      .where(eq(guestPasses.memberEmail, memberEmail));
    
    if (existing.length === 0) {
      await db.insert(guestPasses)
        .values({
          memberEmail,
          passesUsed: 0,
          passesTotal
        });
    }
  } catch (error) {
    console.error('[ensureGuestPassRecord] Error:', error);
  }
}

export default router;
