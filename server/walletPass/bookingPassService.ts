import crypto from 'crypto';
import { db } from '../db';
import { sql, eq, and } from 'drizzle-orm';
import { bookingRequests, bookingWalletPasses, resources, users, walletPassAuthTokens, walletPassDeviceRegistrations } from '../../shared/schema';
import { generateBookingPkPass, type BookingPassData, type WalletConfig } from './passGenerator';
import { getWalletConfig, getWebServiceURL } from './passService';
import { sendPassUpdatePush } from './apnPushService';
import { getSettingValue } from '../core/settingsHelper';
import { logger } from '../core/logger';

async function bumpSerialChangeTimestamp(serialNumber: string): Promise<void> {
  await db.update(walletPassDeviceRegistrations)
    .set({ updatedAt: new Date() })
    .where(eq(walletPassDeviceRegistrations.serialNumber, serialNumber));
}

function computeBookingExpirationDate(bookingDate: string, endTime: string): string {
  const [hours, minutes] = endTime.split(':').map(Number);
  const dt = new Date(bookingDate + 'T00:00:00');
  dt.setHours(hours, minutes, 0, 0);
  return dt.toISOString().replace('.000Z', 'Z');
}

async function getOrCreateBookingPassRecord(
  bookingId: number,
  memberId: string
): Promise<{ serialNumber: string; authenticationToken: string; isNew: boolean }> {
  const existing = await db.select({
    serialNumber: bookingWalletPasses.serialNumber,
    authenticationToken: bookingWalletPasses.authenticationToken,
    voidedAt: bookingWalletPasses.voidedAt,
  })
    .from(bookingWalletPasses)
    .where(eq(bookingWalletPasses.bookingId, bookingId))
    .limit(1);

  if (existing.length > 0) {
    return {
      serialNumber: existing[0].serialNumber,
      authenticationToken: existing[0].authenticationToken,
      isNew: false,
    };
  }

  const serialNumber = `EVERBOOKING-${bookingId}`;
  const authenticationToken = crypto.randomBytes(32).toString('hex');

  await db.insert(bookingWalletPasses).values({
    bookingId,
    serialNumber,
    authenticationToken,
    memberId,
  });

  await db.insert(walletPassAuthTokens).values({
    serialNumber,
    authToken: authenticationToken,
    memberId,
  }).onConflictDoUpdate({
    target: walletPassAuthTokens.serialNumber,
    set: { authToken: authenticationToken, memberId, updatedAt: new Date() },
  });

  return { serialNumber, authenticationToken, isNew: true };
}

export async function generateBookingPass(bookingId: number, requestingMemberId?: string): Promise<Buffer | null> {
  try {
    const walletConfig = await getWalletConfig();
    if (!walletConfig) return null;

    const [booking] = await db.select({
      id: bookingRequests.id,
      userId: bookingRequests.userId,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      resourceId: bookingRequests.resourceId,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      endTime: bookingRequests.endTime,
      durationMinutes: bookingRequests.durationMinutes,
      status: bookingRequests.status,
      declaredPlayerCount: bookingRequests.declaredPlayerCount,
    })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId))
      .limit(1);

    if (!booking) return null;

    const allowedStatuses = ['approved', 'confirmed', 'attended', 'checked_in'];
    const isCancelledOrVoided = ['cancelled', 'cancellation_pending'].includes(booking.status || '');
    const existingPassRecord = isCancelledOrVoided
      ? await db.select({ voidedAt: bookingWalletPasses.voidedAt })
          .from(bookingWalletPasses)
          .where(eq(bookingWalletPasses.bookingId, bookingId))
          .limit(1)
      : [];
    const hasVoidedPass = existingPassRecord.length > 0 && existingPassRecord[0].voidedAt !== null;

    if (!allowedStatuses.includes(booking.status || '') && !hasVoidedPass) return null;

    let memberId = booking.userId;
    if (!memberId && booking.userEmail) {
      const [user] = await db.select({ id: users.id })
        .from(users)
        .where(sql`LOWER(${users.email}) = LOWER(${booking.userEmail})`)
        .limit(1);
      memberId = user?.id || null;
    }

    if (!memberId) return null;

    if (requestingMemberId && requestingMemberId !== memberId) return null;

    let bayName = 'Simulator';
    if (booking.resourceId) {
      const [resource] = await db.select({ name: resources.name })
        .from(resources)
        .where(eq(resources.id, booking.resourceId))
        .limit(1);
      if (resource?.name) bayName = resource.name;
    }

    let memberName = booking.userName || booking.userEmail;
    if (memberId) {
      const [user] = await db.select({ firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, memberId))
        .limit(1);
      if (user) {
        const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
        if (fullName) memberName = fullName;
      }
    }

    const passRecord = await getOrCreateBookingPassRecord(bookingId, memberId);
    const webServiceURL = await getWebServiceURL();

    const [clubLat, clubLng, addressLine1, cityStateZip] = await Promise.all([
      getSettingValue('club.latitude', '33.713744'),
      getSettingValue('club.longitude', '-117.836476'),
      getSettingValue('contact.address_line1', '15771 Red Hill Ave, Ste 500'),
      getSettingValue('contact.city_state_zip', 'Tustin, CA 92780'),
    ]);

    const passData: BookingPassData = {
      bookingId: booking.id,
      memberId,
      memberName: memberName || 'Member',
      memberEmail: booking.userEmail,
      bayName,
      bookingDate: booking.requestDate,
      startTime: booking.startTime,
      endTime: booking.endTime,
      durationMinutes: booking.durationMinutes,
      playerCount: booking.declaredPlayerCount || 1,
      serialNumber: passRecord.serialNumber,
      authenticationToken: passRecord.authenticationToken,
      webServiceURL: webServiceURL || undefined,
      clubLatitude: clubLat && !isNaN(parseFloat(clubLat)) ? parseFloat(clubLat) : undefined,
      clubLongitude: clubLng && !isNaN(parseFloat(clubLng)) ? parseFloat(clubLng) : undefined,
      clubAddress: [addressLine1, cityStateZip].filter(Boolean).join(', '),
      expirationDate: computeBookingExpirationDate(booking.requestDate, booking.endTime),
    };

    if (hasVoidedPass || isCancelledOrVoided) {
      passData.voided = true;
    }

    return await generateBookingPkPass(passData, walletConfig);
  } catch (err) {
    logger.error('[BookingWalletPass] Failed to generate booking pass', {
      error: err instanceof Error ? err : new Error(String(err)),
      extra: { bookingId }
    });
    return null;
  }
}

export async function voidBookingPass(bookingId: number): Promise<void> {
  try {
    const [passRecord] = await db.select({
      serialNumber: bookingWalletPasses.serialNumber,
    })
      .from(bookingWalletPasses)
      .where(and(eq(bookingWalletPasses.bookingId, bookingId)))
      .limit(1);

    if (!passRecord) return;

    await db.update(bookingWalletPasses)
      .set({ voidedAt: new Date() })
      .where(eq(bookingWalletPasses.bookingId, bookingId));

    await bumpSerialChangeTimestamp(passRecord.serialNumber);
    await sendPassUpdatePush(passRecord.serialNumber);
    logger.info('[BookingWalletPass] Voided booking pass and sent push update', {
      extra: { bookingId, serialNumber: passRecord.serialNumber }
    });
  } catch (err) {
    logger.error('[BookingWalletPass] Failed to void booking pass', {
      error: err instanceof Error ? err : new Error(String(err)),
      extra: { bookingId }
    });
  }
}

export async function refreshBookingPass(bookingId: number): Promise<void> {
  try {
    const [passRecord] = await db.select({
      serialNumber: bookingWalletPasses.serialNumber,
    })
      .from(bookingWalletPasses)
      .where(eq(bookingWalletPasses.bookingId, bookingId))
      .limit(1);

    if (!passRecord) return;

    await bumpSerialChangeTimestamp(passRecord.serialNumber);
    await sendPassUpdatePush(passRecord.serialNumber);
    logger.info('[BookingWalletPass] Sent refresh push update for booking pass', {
      extra: { bookingId, serialNumber: passRecord.serialNumber }
    });
  } catch (err) {
    logger.error('[BookingWalletPass] Failed to refresh booking pass', {
      error: err instanceof Error ? err : new Error(String(err)),
      extra: { bookingId }
    });
  }
}

export async function generateBookingPassForWebService(serialNumber: string): Promise<Buffer | null> {
  try {
    const [passRecord] = await db.select({
      bookingId: bookingWalletPasses.bookingId,
      voidedAt: bookingWalletPasses.voidedAt,
    })
      .from(bookingWalletPasses)
      .where(eq(bookingWalletPasses.serialNumber, serialNumber))
      .limit(1);

    if (!passRecord) return null;

    return await generateBookingPass(passRecord.bookingId);
  } catch (err) {
    logger.error('[BookingWalletPass] Failed to generate pass for web service', {
      error: err instanceof Error ? err : new Error(String(err)),
      extra: { serialNumber }
    });
    return null;
  }
}
