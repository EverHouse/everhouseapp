import { Router } from 'express';
import { logger } from '../core/logger';
import { isAuthenticated } from '../core/middleware';
import { db } from '../db';
import { users, membershipTiers, guestPasses, bookingRequests } from '../../shared/schema';
import { sql, eq } from 'drizzle-orm';
import { normalizeTierName } from '../../shared/constants/tiers';
import { generatePkPass, type PassData, type WalletConfig, type TierColors } from '../walletPass/passGenerator';
import { getOrCreateAuthToken, sendPassUpdateToAllRegistrations } from '../walletPass/apnPushService';
import { getWebServiceURL } from '../walletPass/passService';
import { generateBookingPass } from '../walletPass/bookingPassService';
import { getSessionUser } from '../types/session';
import { getSettingValue, getSettingBoolean } from '../core/settingsHelper';
import { isStaffOrAdmin } from '../core/middleware';

const router = Router();

router.get('/api/member/wallet-pass/status', isAuthenticated, async (req, res) => {
  try {
    const isEnabled = await getSettingBoolean('apple_wallet.enabled', false);
    if (!isEnabled) {
      return res.json({ available: false });
    }
    const [passTypeId, teamId] = await Promise.all([
      getSettingValue('apple_wallet.pass_type_id', ''),
      getSettingValue('apple_wallet.team_id', ''),
    ]);
    const certPem = process.env.APPLE_WALLET_CERT_PEM || '';
    const keyPem = process.env.APPLE_WALLET_KEY_PEM || '';

    if (!passTypeId || !teamId || !certPem || !keyPem) {
      return res.json({ available: false });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.json({ available: false });
    }

    const userResult = await db.select({
      role: users.role,
      membershipStatus: users.membershipStatus,
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${sessionUser.email})`)
      .limit(1);

    if (userResult.length === 0) {
      return res.json({ available: false });
    }

    const user = userResult[0];
    if (user.role === 'admin' || user.role === 'staff') {
      return res.json({ available: false });
    }
    if (user.membershipStatus === 'expired' || user.membershipStatus === 'cancelled') {
      return res.json({ available: false });
    }

    return res.json({ available: true });
  } catch (error) {
    logger.error('[WalletPass] Status check failed', { error: error instanceof Error ? error : new Error(String(error)) });
    return res.json({ available: false });
  }
});

router.get('/api/member/wallet-pass', isAuthenticated, async (req, res) => {
  try {
    const isEnabled = await getSettingBoolean('apple_wallet.enabled', false);
    if (!isEnabled) {
      return res.status(404).json({ error: 'Apple Wallet passes are not enabled' });
    }

    const [passTypeId, teamId] = await Promise.all([
      getSettingValue('apple_wallet.pass_type_id', ''),
      getSettingValue('apple_wallet.team_id', ''),
    ]);

    const certPem = process.env.APPLE_WALLET_CERT_PEM || '';
    const keyPem = process.env.APPLE_WALLET_KEY_PEM || '';

    if (!passTypeId || !teamId || !certPem || !keyPem) {
      return res.status(503).json({ error: 'Apple Wallet is not fully configured yet. Pass Type ID and Team ID must be set in Settings, and certificates must be added as environment secrets.' });
    }

    const walletConfig: WalletConfig = { passTypeId, teamId, certPem, keyPem };

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userResult = await db.select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      tier: users.tier,
      membershipStatus: users.membershipStatus,
      joinDate: users.joinDate,
      role: users.role,
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${sessionUser.email})`)
      .limit(1);

    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult[0];

    if (user.role === 'admin' || user.role === 'staff') {
      return res.status(403).json({ error: 'Wallet pass is only available for members' });
    }

    if (user.membershipStatus === 'expired' || user.membershipStatus === 'cancelled') {
      return res.status(403).json({ error: 'Your membership is not active' });
    }

    const tier = normalizeTierName(user.tier);

    const [tierResult, guestPassResult] = await Promise.all([
      db.select({
        dailySimMinutes: membershipTiers.dailySimMinutes,
        dailyConfRoomMinutes: membershipTiers.dailyConfRoomMinutes,
        guestPassesPerMonth: membershipTiers.guestPassesPerMonth,
        walletPassBgColor: membershipTiers.walletPassBgColor,
        walletPassForegroundColor: membershipTiers.walletPassForegroundColor,
        walletPassLabelColor: membershipTiers.walletPassLabelColor,
      })
        .from(membershipTiers)
        .where(sql`LOWER(${membershipTiers.name}) = LOWER(${tier})`)
        .limit(1),
      db.select({
        passesUsed: guestPasses.passesUsed,
        passesTotal: guestPasses.passesTotal,
      })
        .from(guestPasses)
        .where(sql`LOWER(${guestPasses.memberEmail}) = LOWER(${user.email})`)
        .limit(1),
    ]);

    const tierData = tierResult.length > 0 ? tierResult[0] : null;

    let dbColors: TierColors | null = null;
    if (tierData?.walletPassBgColor || tierData?.walletPassForegroundColor || tierData?.walletPassLabelColor) {
      dbColors = {
        bg: tierData.walletPassBgColor || '',
        foreground: tierData.walletPassForegroundColor || '',
        label: tierData.walletPassLabelColor || '',
      };
    }
    const guestPassData = guestPassResult.length > 0 ? guestPassResult[0] : null;

    let memberSince = '';
    if (user.joinDate) {
      const date = new Date(user.joinDate);
      memberSince = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    }

    const serialNumber = `EVERCLUB-${user.id}`;
    const authToken = await getOrCreateAuthToken(serialNumber, user.id);
    const webServiceURL = await getWebServiceURL();

    const [clubLat, clubLng] = await Promise.all([
      getSettingValue('club.latitude', '33.713744'),
      getSettingValue('club.longitude', '-117.836476'),
    ]);

    const passData: PassData = {
      memberId: user.id,
      firstName: user.firstName || sessionUser.name || 'Member',
      lastName: user.lastName || '',
      memberEmail: user.email || '',
      tier,
      membershipStatus: user.membershipStatus || 'Active',
      memberSince,
      dailySimulatorMinutes: tierData?.dailySimMinutes ?? null,
      dailyConfRoomMinutes: tierData?.dailyConfRoomMinutes ?? null,
      guestPassesRemaining: guestPassData ? (guestPassData.passesTotal - guestPassData.passesUsed) : null,
      guestPassesTotal: guestPassData?.passesTotal ?? null,
      authenticationToken: authToken,
      webServiceURL: webServiceURL || undefined,
      clubLatitude: clubLat && !isNaN(parseFloat(clubLat)) ? parseFloat(clubLat) : undefined,
      clubLongitude: clubLng && !isNaN(parseFloat(clubLng)) ? parseFloat(clubLng) : undefined,
    };

    const pkpassBuffer = await generatePkPass(passData, walletConfig, dbColors);

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': `inline; filename="EverClub-${tier}-Pass.pkpass"`,
      'Content-Length': pkpassBuffer.length.toString(),
    });

    res.send(pkpassBuffer);
  } catch (error) {
    logger.error('[WalletPass] Failed to generate wallet pass', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to generate wallet pass' });
  }
});

router.get('/api/member/booking-wallet-pass/:bookingId', isAuthenticated, async (req, res) => {
  try {
    const isEnabled = await getSettingBoolean('apple_wallet.enabled', false);
    if (!isEnabled) {
      return res.status(404).json({ error: 'Apple Wallet passes are not enabled' });
    }

    const bookingId = parseInt(req.params.bookingId, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const [user] = await db.select({ id: users.id })
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${sessionUser.email})`)
      .limit(1);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [booking] = await db.select({
      userId: bookingRequests.userId,
      userEmail: bookingRequests.userEmail,
      status: bookingRequests.status,
    })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId))
      .limit(1);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const isOwner = booking.userId === user.id ||
      (booking.userEmail && booking.userEmail.toLowerCase() === sessionUser.email.toLowerCase());
    if (!isOwner) {
      return res.status(403).json({ error: 'You do not own this booking' });
    }

    const allowedStatuses = ['approved', 'confirmed', 'attended', 'checked_in'];
    if (!allowedStatuses.includes(booking.status || '')) {
      return res.status(400).json({ error: 'Wallet pass is only available for approved bookings' });
    }

    const pkpassBuffer = await generateBookingPass(bookingId, user.id);
    if (!pkpassBuffer) {
      return res.status(500).json({ error: 'Failed to generate booking wallet pass' });
    }

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': `inline; filename="EverClub-Booking-${bookingId}.pkpass"`,
      'Content-Length': pkpassBuffer.length.toString(),
    });

    res.send(pkpassBuffer);
  } catch (error) {
    logger.error('[WalletPass] Failed to generate booking wallet pass', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to generate booking wallet pass' });
  }
});

router.post('/api/admin/wallet-pass/push-update-all', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await sendPassUpdateToAllRegistrations();
    logger.info('[WalletPass] Bulk push update triggered by admin', {
      extra: { sent: result.sent, failed: result.failed }
    });
    res.json({ success: true, sent: result.sent, failed: result.failed });
  } catch (error) {
    logger.error('[WalletPass] Bulk push update failed', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to send bulk push update' });
  }
});

export default router;
