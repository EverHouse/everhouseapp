import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { users, systemSettings } from '../../shared/schema';
import { isAuthenticated, isStaffOrAdmin } from '../core/middleware';
import { sensitiveActionRateLimiter } from '../middleware/rateLimiting';
import { getSessionUser } from '../types/session';
import { isProduction } from '../core/db';
import { logFromRequest } from '../core/auditLog';
import { logger } from '../core/logger';
import { safeSendEmail } from '../utils/resend';

const router = Router();

router.get('/api/waivers/status', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const currentVersionResult = await db.select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'current_waiver_version'))
      .limit(1);
    
    const currentVersion = currentVersionResult[0]?.value || '2.0';

    const userResult = await db.select({
      waiverVersion: users.waiverVersion,
      waiverSignedAt: users.waiverSignedAt,
      role: users.role,
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${sessionUser.email.toLowerCase()}`)
      .limit(1);

    const user = userResult[0];
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role === 'staff' || user.role === 'admin') {
      return res.json({
        needsWaiverUpdate: false,
        currentVersion,
        userVersion: user.waiverVersion,
        signedAt: user.waiverSignedAt,
      });
    }

    const needsWaiverUpdate = !user.waiverVersion || user.waiverVersion !== currentVersion;

    res.json({
      needsWaiverUpdate,
      currentVersion,
      userVersion: user.waiverVersion,
      signedAt: user.waiverSignedAt,
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error checking waiver status', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check agreement status' });
  }
});

router.post('/api/waivers/sign', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const currentVersionResult = await db.select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'current_waiver_version'))
      .limit(1);
    
    const currentVersion = currentVersionResult[0]?.value || '2.0';

    await db.update(users)
      .set({
        waiverVersion: currentVersion,
        waiverSignedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(sql`LOWER(${users.email}) = ${sessionUser.email.toLowerCase()}`);

    db.execute(sql`UPDATE users SET onboarding_completed_at = NOW(), updated_at = NOW() 
      WHERE LOWER(email) = ${sessionUser.email.toLowerCase()} 
      AND onboarding_completed_at IS NULL 
      AND first_name IS NOT NULL AND last_name IS NOT NULL AND phone IS NOT NULL
      AND first_booking_at IS NOT NULL AND app_installed_at IS NOT NULL`).catch((err) => logger.warn('[Waivers] Non-critical onboarding update failed:', err));

    res.json({
      success: true,
      version: currentVersion,
      signedAt: new Date(),
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error signing waiver', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sign agreement' });
  }
});

router.get('/api/waivers/current-version', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.select({ value: systemSettings.value, updatedAt: systemSettings.updatedAt })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'current_waiver_version'))
      .limit(1);
    
    res.json({
      version: result[0]?.value || '2.0',
      updatedAt: result[0]?.updatedAt,
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error fetching waiver version', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch agreement version' });
  }
});

router.post('/api/waivers/update-version', isStaffOrAdmin, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (sessionUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update agreement version' });
    }

    const { version } = req.body;
    
    if (!version || typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) {
      return res.status(400).json({ error: 'Invalid version format. Use format like "1.0", "2.0"' });
    }

    await db.insert(systemSettings)
      .values({
        key: 'current_waiver_version',
        value: version,
        category: 'waivers',
        updatedBy: sessionUser?.email || 'system',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: version,
          updatedAt: new Date(),
        },
      });

    // Include trialing and past_due as active - they still have membership access
    const affectedUsersResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM users 
      WHERE (membership_status IN ('active', 'trialing', 'past_due') OR stripe_subscription_id IS NOT NULL)
      AND archived_at IS NULL 
      AND role = 'member'
      AND (waiver_version IS NULL OR waiver_version != ${version})
    `);
    
    const affectedCount = Number((affectedUsersResult as { rows?: Array<{ count?: number }> }).rows?.[0]?.count || 0);

    logFromRequest(req, 'update_waiver_version', 'waiver', undefined, undefined, { version, affectedMembers: affectedCount });
    res.json({
      success: true,
      version,
      affectedMembers: affectedCount,
      message: `Membership Agreement version updated to ${version}. ${affectedCount} members will need to re-sign.`,
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error updating waiver version', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update agreement version' });
  }
});

router.post('/api/waivers/email-copy', sensitiveActionRateLimiter, isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userResult = await db.select({
      firstName: users.firstName,
      waiverVersion: users.waiverVersion,
      waiverSignedAt: users.waiverSignedAt,
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${sessionUser.email.toLowerCase()}`)
      .limit(1);

    const user = userResult[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentVersionResult = await db.select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'current_waiver_version'))
      .limit(1);

    const currentVersion = currentVersionResult[0]?.value || '2.0';
    const greeting = user.firstName ? `Dear ${user.firstName},` : 'Dear Member,';
    const signedInfo = user.waiverVersion === currentVersion && user.waiverSignedAt
      ? `<p style="margin: 0 0 16px; font-size: 14px; color: #4b5563;">You signed version ${currentVersion} on ${new Date(user.waiverSignedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.</p>`
      : '';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ever Members Club – Membership Agreement</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F2F2EC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #F2F2EC;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 640px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 40px;">
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <img src="https://everclub.app/images/everclub-logo-dark.png" alt="Ever Club" width="180" height="60" style="display: inline-block;">
            </td>
          </tr>
          <tr>
            <td style="text-align: center; padding-bottom: 24px;">
              <h1 style="margin: 0; font-family: Georgia, serif; font-size: 28px; font-weight: 400; color: #293515;">
                Membership Agreement
              </h1>
              <p style="margin: 8px 0 0; font-size: 13px; color: #6b7280;">Version ${currentVersion}</p>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom: 24px;">
              <p style="margin: 0 0 16px; font-size: 14px; color: #4b5563;">${greeting}</p>
              <p style="margin: 0 0 16px; font-size: 14px; color: #4b5563;">Here is your copy of the Ever Members Club Membership Agreement for your records.</p>
              ${signedInfo}
            </td>
          </tr>
          <tr>
            <td style="padding: 24px; background-color: #f9fafb; border-radius: 12px;">
              <h2 style="margin: 0 0 16px; font-size: 20px; color: #293515; font-family: Georgia, serif;">Ever Members Club – Membership Agreement</h2>

              <h3 style="margin: 24px 0 8px; font-size: 15px; color: #293515;">Section 1. Recurring Billing Authorization</h3>
              <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.6;">By signing this Agreement, you authorize Ever Members Club ("the Club") to charge your designated payment method on a recurring basis for your membership dues at the rate associated with your selected membership tier. You acknowledge that your membership dues will be billed automatically each billing cycle (monthly or annually, as applicable) until your membership is cancelled in accordance with Section 2. You are responsible for keeping your payment information current. If a payment fails, the Club reserves the right to suspend your membership privileges until payment is received. The Club may update pricing with at least 30 days' written notice before your next billing cycle.</p>

              <h3 style="margin: 24px 0 8px; font-size: 15px; color: #293515;">Section 2. Cancellation Policy</h3>
              <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.6;">You may cancel your membership at any time by submitting a cancellation request through the Ever Members Club app or by contacting Club staff in writing. Cancellation will take effect at the end of your current billing period – no partial-month refunds will be issued. If you cancel, you will retain access to Club facilities through the remainder of your paid billing cycle. Any promotional or discounted rates may not be available if you re-enroll after cancellation. The Club reserves the right to terminate your membership for cause (including but not limited to violation of Club rules, non-payment, or inappropriate behavior) with or without notice.</p>

              <h3 style="margin: 24px 0 8px; font-size: 15px; color: #293515;">Section 3. Guest Policy &amp; Guest Fees</h3>
              <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.6;">Members may bring guests to the Club subject to the guest policy applicable to their membership tier. Each membership tier includes a specified number of complimentary guest passes per year. Additional guest visits beyond the included passes will incur a guest fee, which will be charged to the member's payment method on file. Members are responsible for the conduct of their guests at all times. Guests must comply with all Club rules and policies. The Club reserves the right to refuse entry to any guest and to modify the guest policy or fees with reasonable notice.</p>

              <h3 style="margin: 24px 0 8px; font-size: 15px; color: #293515;">Section 4. Equipment &amp; Facility Damage</h3>
              <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.6;">Members and their guests are expected to treat all Club equipment, simulators, furnishings, and facilities with care. You agree to report any damage or malfunction immediately to Club staff. You will be held financially responsible for any damage to Club property caused by your intentional misconduct, gross negligence, or misuse of equipment. This includes but is not limited to damage to golf simulators, screens, projectors, clubs, furniture, and common areas. The Club will assess repair or replacement costs at its reasonable discretion, and such costs may be charged to your payment method on file.</p>

              <h3 style="margin: 24px 0 8px; font-size: 15px; color: #293515;">Section 6. Surveillance &amp; Recording Consent</h3>
              <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.6;">You acknowledge and consent to the use of video surveillance cameras and audio/video recording equipment throughout Club premises, including but not limited to common areas, simulator bays, and entry/exit points. These systems are used for security, safety, and operational purposes. By entering the Club, you consent to being recorded. The Club may use surveillance footage for security investigations, dispute resolution, and operational improvement. You agree not to tamper with, obstruct, or disable any surveillance equipment. Footage is retained in accordance with the Club's data retention policy.</p>

              <h3 style="margin: 24px 0 8px; font-size: 15px; color: #293515;">Section 7. SMS &amp; Communication Consent</h3>
              <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.6;">By providing your phone number, you consent to receive SMS text messages, push notifications, and other electronic communications from the Club related to your membership, bookings, billing, promotions, and Club operations. Message frequency varies. Message and data rates may apply. You may opt out of promotional messages at any time by replying STOP, but you acknowledge that transactional messages related to your membership (such as booking confirmations, payment receipts, and account alerts) are a necessary part of the membership service and cannot be individually opted out of while your membership is active.</p>

              <h3 style="margin: 24px 0 8px; font-size: 15px; color: #293515;">Section 8. Liability Waiver &amp; Assumption of Risk</h3>
              <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.6;">To the maximum extent allowed by law, you release Ever Members Club, its owners, partners, officers, employees, and agents from any and all liability, claims, demands, or causes of action for property damage, personal injury, illness, or death arising out of or relating to your membership, presence at the Club, or participation in Club activities. This waiver applies to injuries or damages occurring on Club premises or during Club-sponsored activities, whether caused by inherent risks (e.g., being struck by a golf ball, equipment malfunction) or by the negligence of the Club or its staff.</p>
              <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.6;">You understand and voluntarily accept all risks inherent in using the Club's facilities and services, including but not limited to: athletic injuries, repetitive motion injuries, equipment malfunctions, interactions with other members or guests, and risks associated with food and beverage consumption. You agree to use all facilities and equipment safely and within your personal physical limits.</p>
              <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.6;">You agree to indemnify, defend, and hold harmless Ever Members Club from any claims, damages, losses, or expenses (including reasonable legal fees) arising from your actions, omissions, or the actions of your guests at the Club.</p>

              <h3 style="margin: 24px 0 8px; font-size: 15px; color: #293515;">Section 9. Dispute Resolution &amp; Arbitration</h3>
              <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.6;">Any dispute, controversy, or claim arising out of or relating to this Agreement, your membership, or your use of Club facilities shall first be addressed through good-faith informal negotiation. If the dispute cannot be resolved informally within 30 days, it shall be resolved exclusively through binding arbitration administered in accordance with the rules of the American Arbitration Association (AAA). The arbitration shall take place in Dallas County, Texas. The arbitrator's decision shall be final and binding and may be entered as a judgment in any court of competent jurisdiction. You agree that any dispute resolution proceedings will be conducted on an individual basis and not as part of a class, consolidated, or representative action. Each party shall bear its own costs and attorney's fees unless the arbitrator determines otherwise.</p>
            </td>
          </tr>
          <tr>
            <td style="padding-top: 24px; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">This is an automated copy of your Membership Agreement sent at your request.</p>
              <p style="margin: 8px 0 0; font-size: 12px; color: #9ca3af;">&copy; ${new Date().getFullYear()} Ever Members Club. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const result = await safeSendEmail({
      to: sessionUser.email,
      subject: 'Your Ever Members Club Membership Agreement',
      html,
    });

    if (result.success) {
      res.json({ success: true, blocked: result.blocked });
    } else {
      res.status(500).json({ error: 'Failed to send email' });
    }
  } catch (error: unknown) {
    logger.error('Error sending agreement email', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to send agreement email' });
  }
});

export default router;
