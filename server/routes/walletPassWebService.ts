import { Router } from 'express';
import { db } from '../db';
import { eq, and, sql, gt } from 'drizzle-orm';
import { walletPassDeviceRegistrations, walletPassAuthTokens } from '../../shared/schema';
import { validateAuthToken } from '../walletPass/apnPushService';
import { logger } from '../core/logger';
import { validateQuery } from '../middleware/validate';
import { z } from 'zod';

const router = Router();

function extractAuthToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^ApplePass\s+(.+)$/);
  return match ? match[1] : null;
}

router.post('/v1/devices/:deviceLibraryId/registrations/:passTypeId/:serialNumber', async (req, res) => {
  try {
    const { deviceLibraryId, passTypeId, serialNumber } = req.params;
    const authToken = extractAuthToken(req.headers.authorization);

    if (!authToken) {
      return res.status(401).send('Unauthorized');
    }

    const isValid = await validateAuthToken(serialNumber, authToken);
    if (!isValid) {
      return res.status(401).send('Unauthorized');
    }

    const pushToken = req.body?.pushToken;
    if (!pushToken) {
      return res.status(400).send('Missing pushToken');
    }

    const existing = await db.select({ id: walletPassDeviceRegistrations.id })
      .from(walletPassDeviceRegistrations)
      .where(and(
        eq(walletPassDeviceRegistrations.deviceLibraryId, deviceLibraryId),
        eq(walletPassDeviceRegistrations.passTypeId, passTypeId),
        eq(walletPassDeviceRegistrations.serialNumber, serialNumber),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(walletPassDeviceRegistrations)
        .set({ pushToken, updatedAt: new Date() })
        .where(eq(walletPassDeviceRegistrations.id, existing[0].id));

      logger.info('[WalletPass WebService] Device registration updated', {
        extra: { deviceLibraryId, serialNumber }
      });
      return res.status(200).send('');
    }

    await db.insert(walletPassDeviceRegistrations).values({
      deviceLibraryId,
      pushToken,
      passTypeId,
      serialNumber,
    });

    logger.info('[WalletPass WebService] Device registered', {
      extra: { deviceLibraryId, serialNumber }
    });
    return res.status(201).send('');
  } catch (err) {
    logger.error('[WalletPass WebService] Device registration failed', {
      error: err instanceof Error ? err : new Error(String(err))
    });
    return res.status(500).send('Internal Server Error');
  }
});

const passesQuerySchema = z.object({
  passesUpdatedSince: z.string().optional(),
}).passthrough();

router.get('/v1/devices/:deviceLibraryId/registrations/:passTypeId', validateQuery(passesQuerySchema), async (req, res) => {
  try {
    const deviceLibraryId = req.params.deviceLibraryId as string;
    const passTypeId = req.params.passTypeId as string;
    const passesUpdatedSince = req.query.passesUpdatedSince as string | undefined;

    const deviceRegistrations = await db.select({
      serialNumber: walletPassDeviceRegistrations.serialNumber,
    })
      .from(walletPassDeviceRegistrations)
      .where(and(
        eq(walletPassDeviceRegistrations.deviceLibraryId, deviceLibraryId),
        eq(walletPassDeviceRegistrations.passTypeId, passTypeId),
      ))
      .limit(1);

    if (deviceRegistrations.length === 0) {
      return res.status(204).send('');
    }

    const authToken = extractAuthToken(req.headers.authorization);
    if (!authToken) {
      return res.status(401).send('Unauthorized');
    }

    const isValid = await validateAuthToken(deviceRegistrations[0].serialNumber, authToken);
    if (!isValid) {
      return res.status(401).send('Unauthorized');
    }

    let query;
    if (passesUpdatedSince) {
      const sinceDate = new Date(passesUpdatedSince);
      query = db.select({
        serialNumber: walletPassDeviceRegistrations.serialNumber,
        updatedAt: walletPassDeviceRegistrations.updatedAt,
      })
        .from(walletPassDeviceRegistrations)
        .where(and(
          eq(walletPassDeviceRegistrations.deviceLibraryId, deviceLibraryId),
          eq(walletPassDeviceRegistrations.passTypeId, passTypeId),
          gt(walletPassDeviceRegistrations.updatedAt, sinceDate),
        ));
    } else {
      query = db.select({
        serialNumber: walletPassDeviceRegistrations.serialNumber,
        updatedAt: walletPassDeviceRegistrations.updatedAt,
      })
        .from(walletPassDeviceRegistrations)
        .where(and(
          eq(walletPassDeviceRegistrations.deviceLibraryId, deviceLibraryId),
          eq(walletPassDeviceRegistrations.passTypeId, passTypeId),
        ));
    }

    const registrations = await query;

    if (registrations.length === 0) {
      return res.status(204).send('');
    }

    const serialNumbers = registrations.map(r => r.serialNumber);
    const lastUpdated = registrations
      .map(r => r.updatedAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0];

    return res.json({
      serialNumbers,
      lastUpdated: lastUpdated ? lastUpdated.toISOString() : new Date().toISOString(),
    });
  } catch (err) {
    logger.error('[WalletPass WebService] List serials failed', {
      error: err instanceof Error ? err : new Error(String(err))
    });
    return res.status(500).send('Internal Server Error');
  }
});

router.get('/v1/passes/:passTypeId/:serialNumber', async (req, res) => {
  try {
    const { passTypeId, serialNumber } = req.params;
    const authToken = extractAuthToken(req.headers.authorization);

    if (!authToken) {
      return res.status(401).send('Unauthorized');
    }

    const isValid = await validateAuthToken(serialNumber, authToken);
    if (!isValid) {
      return res.status(401).send('Unauthorized');
    }

    const tokenRecord = await db.select({ memberId: walletPassAuthTokens.memberId })
      .from(walletPassAuthTokens)
      .where(eq(walletPassAuthTokens.serialNumber, serialNumber))
      .limit(1);

    if (tokenRecord.length === 0) {
      return res.status(404).send('Pass not found');
    }

    const { generatePassForMember } = await import('../walletPass/passService');
    const pkpassBuffer = await generatePassForMember(tokenRecord[0].memberId);

    if (!pkpassBuffer) {
      return res.status(404).send('Pass not found');
    }

    await db.update(walletPassDeviceRegistrations)
      .set({ updatedAt: new Date() })
      .where(and(
        eq(walletPassDeviceRegistrations.passTypeId, passTypeId),
        eq(walletPassDeviceRegistrations.serialNumber, serialNumber),
      ));

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Last-Modified': new Date().toUTCString(),
    });
    return res.send(pkpassBuffer);
  } catch (err) {
    logger.error('[WalletPass WebService] Fetch pass failed', {
      error: err instanceof Error ? err : new Error(String(err))
    });
    return res.status(500).send('Internal Server Error');
  }
});

router.delete('/v1/devices/:deviceLibraryId/registrations/:passTypeId/:serialNumber', async (req, res) => {
  try {
    const { deviceLibraryId, passTypeId, serialNumber } = req.params;
    const authToken = extractAuthToken(req.headers.authorization);

    if (!authToken) {
      return res.status(401).send('Unauthorized');
    }

    const isValid = await validateAuthToken(serialNumber, authToken);
    if (!isValid) {
      return res.status(401).send('Unauthorized');
    }

    await db.delete(walletPassDeviceRegistrations)
      .where(and(
        eq(walletPassDeviceRegistrations.deviceLibraryId, deviceLibraryId),
        eq(walletPassDeviceRegistrations.passTypeId, passTypeId),
        eq(walletPassDeviceRegistrations.serialNumber, serialNumber),
      ));

    logger.info('[WalletPass WebService] Device unregistered', {
      extra: { deviceLibraryId, serialNumber }
    });
    return res.status(200).send('');
  } catch (err) {
    logger.error('[WalletPass WebService] Device unregistration failed', {
      error: err instanceof Error ? err : new Error(String(err))
    });
    return res.status(500).send('Internal Server Error');
  }
});

router.post('/v1/log', async (req, res) => {
  try {
    const logs = req.body?.logs;
    if (Array.isArray(logs)) {
      for (const logEntry of logs) {
        logger.info('[WalletPass Device Log]', { extra: { deviceLog: logEntry } });
      }
    }
    return res.status(200).send('');
  } catch (err) {
    logger.error('[WalletPass WebService] Log endpoint failed', {
      error: err instanceof Error ? err : new Error(String(err))
    });
    return res.status(200).send('');
  }
});

export default router;
