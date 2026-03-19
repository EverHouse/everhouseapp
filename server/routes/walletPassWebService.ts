import { Router } from 'express';
import { db } from '../db';
import { eq, and, gt } from 'drizzle-orm';
import { walletPassDeviceRegistrations, walletPassAuthTokens } from '../../shared/schema';
import { validateAuthToken } from '../walletPass/apnPushService';
import { logger } from '../core/logger';
import { validateQuery } from '../middleware/validate';
import { z } from 'zod';
import { getErrorMessage } from '../utils/errorUtils';

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
      logger.warn('[WalletPass WebService] Registration rejected: missing ApplePass auth header', {
        extra: { deviceLibraryId, passTypeId, serialNumber, isBookingPass: serialNumber.startsWith('EVERBOOKING-') }
      });
      return res.status(401).send('Unauthorized');
    }

    const isValid = await validateAuthToken(serialNumber, authToken);
    if (!isValid) {
      logger.warn('[WalletPass WebService] Registration rejected: auth token mismatch', {
        extra: { deviceLibraryId, passTypeId, serialNumber, isBookingPass: serialNumber.startsWith('EVERBOOKING-') }
      });
      return res.status(401).send('Unauthorized');
    }

    const pushToken = req.body?.pushToken;
    if (!pushToken) {
      logger.warn('[WalletPass WebService] Registration attempt missing pushToken', {
        extra: { deviceLibraryId, passTypeId, serialNumber }
      });
      return res.status(400).send('Missing pushToken');
    }

    logger.info('[WalletPass WebService] Device registration attempt', {
      extra: { deviceLibraryId, passTypeId, serialNumber, isBookingPass: serialNumber.startsWith('EVERBOOKING-') }
    });

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
        extra: { deviceLibraryId, serialNumber, isBookingPass: serialNumber.startsWith('EVERBOOKING-') }
      });
      return res.status(200).send('');
    }

    await db.insert(walletPassDeviceRegistrations).values({
      deviceLibraryId,
      pushToken,
      passTypeId,
      serialNumber,
    });

    logger.info('[WalletPass WebService] Device registered successfully', {
      extra: { deviceLibraryId, serialNumber, passTypeId, isBookingPass: serialNumber.startsWith('EVERBOOKING-') }
    });
    return res.status(201).send('');
  } catch (err) {
    logger.error('[WalletPass WebService] Device registration failed', {
      error: new Error(getErrorMessage(err))
    });
    return res.status(500).send('Internal Server Error');
  }
});

const passesQuerySchema = z.object({
  passesUpdatedSince: z.string().optional(),
}).passthrough();

// PUBLIC ROUTE - Apple Wallet device pass list; per PKPass spec may return 204 without auth
// if device has no registrations; validates auth token when registrations exist
router.get('/v1/devices/:deviceLibraryId/registrations/:passTypeId', validateQuery(passesQuerySchema), async (req, res) => {
  try {
    const deviceLibraryId = req.params.deviceLibraryId as string;
    const passTypeId = req.params.passTypeId as string;
    const vq = (req as unknown as { validatedQuery: z.infer<typeof passesQuerySchema> }).validatedQuery;
    const passesUpdatedSince = vq.passesUpdatedSince;

    const deviceRegistrations = await db.select({
      serialNumber: walletPassDeviceRegistrations.serialNumber,
    })
      .from(walletPassDeviceRegistrations)
      .where(and(
        eq(walletPassDeviceRegistrations.deviceLibraryId, deviceLibraryId),
        eq(walletPassDeviceRegistrations.passTypeId, passTypeId),
      ));

    if (deviceRegistrations.length === 0) {
      return res.status(204).send('');
    }

    const authToken = extractAuthToken(req.headers.authorization);
    if (!authToken) {
      return res.status(401).send('Unauthorized');
    }

    let authValid = false;
    for (const reg of deviceRegistrations) {
      const isValid = await validateAuthToken(reg.serialNumber, authToken);
      if (isValid) {
        authValid = true;
        break;
      }
    }
    if (!authValid) {
      logger.warn('[WalletPass WebService] Auth token does not match any registered serial for device', {
        extra: { deviceLibraryId, passTypeId, registeredSerials: deviceRegistrations.map(r => r.serialNumber) }
      });
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
      error: new Error(getErrorMessage(err))
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

    let pkpassBuffer: Buffer | null = null;

    if (serialNumber.startsWith('EVERBOOKING-')) {
      const { generateBookingPassForWebService } = await import('../walletPass/bookingPassService');
      pkpassBuffer = await generateBookingPassForWebService(serialNumber);
    } else {
      const { generatePassForMember } = await import('../walletPass/passService');
      pkpassBuffer = await generatePassForMember(tokenRecord[0].memberId);
    }

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
      error: new Error(getErrorMessage(err))
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
      error: new Error(getErrorMessage(err))
    });
    return res.status(500).send('Internal Server Error');
  }
});

// PUBLIC ROUTE - Apple Wallet device log endpoint (unauthenticated per Apple PKPass spec)
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
      error: new Error(getErrorMessage(err))
    });
    return res.status(200).send('');
  }
});

export default router;
