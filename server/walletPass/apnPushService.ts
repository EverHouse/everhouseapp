import http2 from 'http2';
import crypto from 'crypto';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { walletPassDeviceRegistrations, walletPassAuthTokens } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../core/logger';
import { getSettingValue } from '../core/settingsHelper';

const APN_HOST = 'https://api.push.apple.com';

async function sendApnPush(pushToken: string, passTypeId: string): Promise<boolean> {
  const certPem = process.env.APPLE_WALLET_CERT_PEM || '';
  const keyPem = process.env.APPLE_WALLET_KEY_PEM || '';

  if (!certPem || !keyPem) {
    logger.warn('[WalletPass APN] Missing certificate or key PEM for APN push');
    return false;
  }

  return new Promise((resolve) => {
    try {
      const client = http2.connect(APN_HOST, {
        cert: certPem,
        key: keyPem,
      });

      client.on('error', (err) => {
        logger.error('[WalletPass APN] HTTP/2 connection error', { error: err });
        client.close();
        resolve(false);
      });

      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${pushToken}`,
        'apns-topic': passTypeId,
        'apns-push-type': 'background',
        'apns-priority': '5',
      };

      const req = client.request(headers);
      req.setEncoding('utf8');

      let responseStatus = 0;
      req.on('response', (responseHeaders) => {
        responseStatus = responseHeaders[':status'] as number;
      });

      let responseBody = '';
      req.on('data', (chunk) => {
        responseBody += chunk;
      });

      req.on('end', () => {
        client.close();
        if (responseStatus === 200) {
          resolve(true);
        } else {
          logger.warn('[WalletPass APN] Push failed', {
            extra: { status: responseStatus, body: responseBody, pushToken: pushToken.substring(0, 8) + '...' }
          });
          resolve(false);
        }
      });

      req.on('error', (err) => {
        logger.error('[WalletPass APN] Request error', { error: err });
        client.close();
        resolve(false);
      });

      req.end(JSON.stringify({}));

      setTimeout(() => {
        try { client.close(); } catch {}
        resolve(false);
      }, 10000);
    } catch (err) {
      logger.error('[WalletPass APN] Failed to send push', { error: err instanceof Error ? err : new Error(String(err)) });
      resolve(false);
    }
  });
}

export async function sendPassUpdatePush(serialNumber: string): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };

  try {
    const registrations = await db.select({
      pushToken: walletPassDeviceRegistrations.pushToken,
      passTypeId: walletPassDeviceRegistrations.passTypeId,
    })
      .from(walletPassDeviceRegistrations)
      .where(eq(walletPassDeviceRegistrations.serialNumber, serialNumber));

    if (registrations.length === 0) {
      logger.info('[WalletPass APN] No device registrations for serial', { extra: { serialNumber } });
      return result;
    }

    logger.info(`[WalletPass APN] Sending push to ${registrations.length} device(s) for ${serialNumber}`);

    for (const reg of registrations) {
      const success = await sendApnPush(reg.pushToken, reg.passTypeId);
      if (success) {
        result.sent++;
      } else {
        result.failed++;
      }
    }

    logger.info(`[WalletPass APN] Push complete for ${serialNumber}: sent=${result.sent}, failed=${result.failed}`);
  } catch (err) {
    logger.error('[WalletPass APN] Error sending pass update push', {
      error: err instanceof Error ? err : new Error(String(err)),
      extra: { serialNumber }
    });
  }

  return result;
}

export async function sendPassUpdateForMember(memberId: string): Promise<void> {
  const serialNumber = `EVERCLUB-${memberId}`;
  await sendPassUpdatePush(serialNumber);
}

export async function sendPassUpdateForMemberByEmail(email: string): Promise<void> {
  try {
    const userResult = await db.execute(
      sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${email}) LIMIT 1`
    );

    if (userResult.rows.length === 0) {
      logger.info('[WalletPass APN] No user found for email, skipping push', { extra: { email } });
      return;
    }

    const memberId = (userResult.rows[0] as { id: string }).id;
    await sendPassUpdateForMember(memberId);
  } catch (err) {
    logger.error('[WalletPass APN] Error looking up member for push', {
      error: err instanceof Error ? err : new Error(String(err)),
      extra: { email }
    });
  }
}

export async function sendPassUpdateToAllRegistrations(): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };

  try {
    const registrations = await db.select({
      pushToken: walletPassDeviceRegistrations.pushToken,
      passTypeId: walletPassDeviceRegistrations.passTypeId,
      serialNumber: walletPassDeviceRegistrations.serialNumber,
    })
      .from(walletPassDeviceRegistrations);

    if (registrations.length === 0) {
      logger.info('[WalletPass APN] No device registrations found for bulk push');
      return result;
    }

    logger.info(`[WalletPass APN] Sending bulk push to ${registrations.length} device(s)`);

    for (const reg of registrations) {
      const success = await sendApnPush(reg.pushToken, reg.passTypeId);
      if (success) {
        result.sent++;
      } else {
        result.failed++;
      }
    }

    logger.info(`[WalletPass APN] Bulk push complete: sent=${result.sent}, failed=${result.failed}`);
  } catch (err) {
    logger.error('[WalletPass APN] Error sending bulk pass update push', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }

  return result;
}

export async function getOrCreateAuthToken(serialNumber: string, memberId: string): Promise<string> {
  const existing = await db.select({ authToken: walletPassAuthTokens.authToken })
    .from(walletPassAuthTokens)
    .where(eq(walletPassAuthTokens.serialNumber, serialNumber))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].authToken;
  }

  const authToken = crypto.randomBytes(32).toString('hex');

  await db.insert(walletPassAuthTokens).values({
    serialNumber,
    authToken,
    memberId,
  }).onConflictDoUpdate({
    target: walletPassAuthTokens.serialNumber,
    set: { authToken, memberId, updatedAt: new Date() },
  });

  return authToken;
}

export async function validateAuthToken(serialNumber: string, authToken: string): Promise<boolean> {
  const result = await db.select({ id: walletPassAuthTokens.id })
    .from(walletPassAuthTokens)
    .where(sql`${walletPassAuthTokens.serialNumber} = ${serialNumber} AND ${walletPassAuthTokens.authToken} = ${authToken}`)
    .limit(1);

  return result.length > 0;
}
