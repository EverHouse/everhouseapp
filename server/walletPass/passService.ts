import { db } from '../db';
import { sql } from 'drizzle-orm';
import { users, membershipTiers, guestPasses } from '../../shared/schema';
import { normalizeTierName } from '../../shared/constants/tiers';
import { generatePkPass, type PassData, type WalletConfig, type TierColors } from './passGenerator';
import { getOrCreateAuthToken } from './apnPushService';
import { getSettingValue, getSettingBoolean } from '../core/settingsHelper';
import { logger } from '../core/logger';

export async function getWalletConfig(): Promise<WalletConfig | null> {
  const isEnabled = await getSettingBoolean('apple_wallet.enabled', false);
  if (!isEnabled) return null;

  const [passTypeId, teamId] = await Promise.all([
    getSettingValue('apple_wallet.pass_type_id', ''),
    getSettingValue('apple_wallet.team_id', ''),
  ]);
  const certPem = process.env.APPLE_WALLET_CERT_PEM || '';
  const keyPem = process.env.APPLE_WALLET_KEY_PEM || '';

  if (!passTypeId || !teamId || !certPem || !keyPem) return null;

  return { passTypeId, teamId, certPem, keyPem };
}

export async function getWebServiceURL(): Promise<string> {
  const customUrl = await getSettingValue('apple_wallet.web_service_url', '');
  if (customUrl) return customUrl;

  const appUrl = process.env.APP_URL || process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : '';
  return appUrl ? `${appUrl}/api/wallet` : '';
}

export async function generatePassForMember(memberId: string): Promise<Buffer | null> {
  try {
    const walletConfig = await getWalletConfig();
    if (!walletConfig) return null;

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
      .where(sql`${users.id} = ${memberId}`)
      .limit(1);

    if (userResult.length === 0) return null;

    const user = userResult[0];

    if (user.role === 'admin' || user.role === 'staff') return null;
    if (user.membershipStatus === 'expired' || user.membershipStatus === 'cancelled') return null;

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
      firstName: user.firstName || 'Member',
      lastName: user.lastName || '',
      memberEmail: user.email,
      tier,
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

    let dbColors: TierColors | null = null;
    if (tierData?.walletPassBgColor || tierData?.walletPassForegroundColor || tierData?.walletPassLabelColor) {
      dbColors = {
        bg: tierData.walletPassBgColor || '',
        foreground: tierData.walletPassForegroundColor || '',
        label: tierData.walletPassLabelColor || '',
      };
    }

    return await generatePkPass(passData, walletConfig, dbColors);
  } catch (err) {
    logger.error('[WalletPass] Failed to generate pass for member', {
      error: err instanceof Error ? err : new Error(String(err)),
      extra: { memberId }
    });
    return null;
  }
}
