import crypto from 'crypto';
import forge from 'node-forge';
import archiver from 'archiver';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

interface PassData {
  memberId: string;
  firstName: string;
  lastName: string;
  memberEmail: string;
  tier: string;
  memberSince: string;
  dailySimulatorMinutes: number | null;
  dailyConfRoomMinutes: number | null;
  guestPassesRemaining: number | null;
  guestPassesTotal: number | null;
  authenticationToken?: string;
  webServiceURL?: string;
  clubLatitude?: number;
  clubLongitude?: number;
}

interface TierColors {
  bg: string;
  foreground: string;
  label: string;
}

interface WalletConfig {
  passTypeId: string;
  teamId: string;
  certPem: string;
  keyPem: string;
}

const DEFAULT_TIER_COLORS: Record<string, TierColors> = {
  VIP: { bg: '#E5E4E2', foreground: '#374151', label: '#6B7280' },
  Premium: { bg: '#D4AF37', foreground: '#1a1a1a', label: '#4a4a4a' },
  Corporate: { bg: '#374151', foreground: '#FFFFFF', label: '#D1D5DB' },
  Core: { bg: '#293515', foreground: '#FFFFFF', label: '#D1D5DB' },
  Social: { bg: '#CCB8E4', foreground: '#293515', label: '#4a4a4a' },
};

function isLightBackground(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

const WWDR_PEM = `-----BEGIN CERTIFICATE-----
MIIEVTCCAz2gAwIBAgIUE9x3lVJx5T3GMujM/+Uh88zFztIwDQYJKoZIhvcNAQEL
BQAwYjELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsT
HUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBS
b290IENBMB4XDTIwMTIxNjE5MzYwNFoXDTMwMTIxMDAwMDAwMFowdTFEMEIGA1UE
Aww7QXBwbGUgV29ybGR3aWRlIERldmVsb3BlciBSZWxhdGlvbnMgQ2VydGlmaWNh
dGlvbiBBdXRob3JpdHkxCzAJBgNVBAsMAkc0MRMwEQYDVQQKDApBcHBsZSBJbmMu
MQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANAf
eKp6JzKwRl/nF3bYoJ0OKY6tPTKlxGs3yeRBkWq3eXFdDDQEYHX3rkOPR8SGHgjo
v9Y5Ui8eZ/xx8YJtPH4GUnadLLzVQ+mxtLxAOnhRXVGhJeG+bJGdayFZGEHVD41t
QSo5SiHgkJ9OE0/QjJoyuNdqkh4laqQyziIZhQVg3AJK8lrrd3kCfcCXVGySjnYB
5kaP5eYq+6KwrRitbTOFOCOL6oqW7Z+uZk+jDEAnbZXQYojZQykn/e2kv1MukBVl
PNkuYmQzHWxq3Y4hqqRfFcYw7V/mjDaSlLfcOQIA+2SM1AyB8j/VNJeHdSbCb64D
YyEMe9QbsWLFApy9/a8CAwEAAaOB7zCB7DASBgNVHRMBAf8ECDAGAQH/AgEAMB8G
A1UdIwQYMBaAFCvQaUeUdgn+9GuNLkCm90dNfwheMEQGCCsGAQUFBwEBBDgwNjA0
BggrBgEFBQcwAYYoaHR0cDovL29jc3AuYXBwbGUuY29tL29jc3AwMy1hcHBsZXJv
b3RjYTAuBgNVHR8EJzAlMCOgIaAfhh1odHRwOi8vY3JsLmFwcGxlLmNvbS9yb290
LmNybDAdBgNVHQ4EFgQUW9n6HeeaGgujmXYiUIY+kchbd6gwDgYDVR0PAQH/BAQD
AgEGMBAGCiqGSIb3Y2QGAgEEAgUAMA0GCSqGSIb3DQEBCwUAA4IBAQA/Vj2e5bbD
eeZFIGi9v3OLLBKeAuOugCKMBB7DUshwgKj7zqew1UJEggOCTwb8O0kU+9h0UoWv
p50h5wESA5/NQFjQAde/MoMrU1goPO6cn1R2PWQnxn6NHThNLa6B5rmluJyJlPef
x4elUWY0GzlxOSTjh2fvpbFoe4zuPfeutnvi0v/fYcZqdUmVIkSoBPyUuAsuORFJ
EtHlgepZAE9bPFo22noicwkJac3AfOriJP6YRLj477JxPxpd1F1+M02cHSS+APCQ
A1iZQT0xWmJArzmoUUOSqwSonMJNsUvSq3xKX+udO7xPiEAGE/+QF4oIRynoYpgp
pU8RBWk6z/Kf
-----END CERTIFICATE-----`;

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function resolveTierColors(tier: string, dbColors?: TierColors | null): TierColors {
  const defaults = DEFAULT_TIER_COLORS[tier] || DEFAULT_TIER_COLORS.Social;
  if (!dbColors) return defaults;
  return {
    bg: dbColors.bg || defaults.bg,
    foreground: dbColors.foreground || defaults.foreground,
    label: dbColors.label || defaults.label,
  };
}

function buildPassJson(data: PassData, config: WalletConfig, colors: TierColors): Record<string, unknown> {
  const backFields: Array<{ key: string; label: string; value: string }> = [];

  if (data.dailySimulatorMinutes !== null && data.dailySimulatorMinutes > 0) {
    backFields.push({
      key: 'dailySimMinutes',
      label: 'Daily Simulator Minutes',
      value: data.dailySimulatorMinutes >= 999 ? 'Unlimited' : `${data.dailySimulatorMinutes} min`,
    });
  }

  if (data.dailyConfRoomMinutes !== null && data.dailyConfRoomMinutes > 0) {
    backFields.push({
      key: 'dailyConfMinutes',
      label: 'Daily Conference Room Minutes',
      value: data.dailyConfRoomMinutes >= 999 ? 'Unlimited' : `${data.dailyConfRoomMinutes} min`,
    });
  }

  if (data.guestPassesRemaining !== null && data.guestPassesTotal !== null) {
    backFields.push({
      key: 'guestPasses',
      label: 'Guest Passes',
      value: `${data.guestPassesRemaining} / ${data.guestPassesTotal} remaining`,
    });
  }

  backFields.push({
    key: 'tierName',
    label: 'Membership Tier',
    value: data.tier,
  });

  const portalUrl = process.env.APP_URL || 'https://everclub.app';
  backFields.push({
    key: 'memberPortal',
    label: 'Member Portal',
    value: portalUrl,
    attributedValue: `<a href="${portalUrl}">Open Member Portal</a>`,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const headerFields: Array<{ key: string; label: string; value: string; textAlignment?: string }> = [];
  if (data.memberSince) {
    headerFields.push({
      key: 'memberSince',
      label: 'MEMBER SINCE',
      value: data.memberSince,
      textAlignment: 'PKTextAlignmentRight',
    });
  }

  const memberName = [data.firstName, data.lastName].filter(Boolean).join(' ');
  const secondaryFields: Array<{ key: string; label: string; value: string }> = [
    {
      key: 'memberName',
      label: 'MEMBER',
      value: memberName || 'Member',
    },
    {
      key: 'tier',
      label: 'TIER',
      value: data.tier,
    },
  ];

  const auxiliaryFields: Array<{ key: string; label: string; value: string }> = [];
  if (data.memberEmail) {
    auxiliaryFields.push({
      key: 'email',
      label: 'EMAIL',
      value: data.memberEmail,
    });
  }

  const passJson: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeId,
    serialNumber: `EVERCLUB-${data.memberId}`,
    teamIdentifier: config.teamId,
    organizationName: 'Ever Club',
    description: `Ever Club ${data.tier} Membership - ${data.firstName} ${data.lastName}`,
    foregroundColor: hexToRgb(colors.foreground),
    backgroundColor: hexToRgb(colors.bg),
    labelColor: hexToRgb(colors.label),
  };

  if (data.webServiceURL && data.authenticationToken) {
    passJson.webServiceURL = data.webServiceURL;
    passJson.authenticationToken = data.authenticationToken;
  }

  passJson.storeCard = {
    headerFields,
    secondaryFields,
    auxiliaryFields,
    backFields,
  };

  passJson.barcode = {
    message: `MEMBER:${data.memberId}`,
    format: 'PKBarcodeFormatQR',
    messageEncoding: 'iso-8859-1',
  };

  passJson.barcodes = [
    {
      message: `MEMBER:${data.memberId}`,
      format: 'PKBarcodeFormatQR',
      messageEncoding: 'iso-8859-1',
    },
  ];

  if (
    data.clubLatitude != null && data.clubLongitude != null &&
    isFinite(data.clubLatitude) && isFinite(data.clubLongitude) &&
    data.clubLatitude >= -90 && data.clubLatitude <= 90 &&
    data.clubLongitude >= -180 && data.clubLongitude <= 180
  ) {
    passJson.locations = [
      {
        latitude: data.clubLatitude,
        longitude: data.clubLongitude,
        relevantText: 'Welcome to Ever Club',
      },
    ];
  }

  return passJson;
}

function selectLogoSource(colors: TierColors): string {
  const useDarkLogo = isLightBackground(colors.bg);

  const darkLogoPath = path.join(process.cwd(), 'public', 'images', 'everclub-logo-dark.png');
  const lightLogoPath = path.join(process.cwd(), 'public', 'images', 'everclub-logo-light.webp');

  if (useDarkLogo && fs.existsSync(darkLogoPath)) {
    return darkLogoPath;
  }
  if (!useDarkLogo && fs.existsSync(lightLogoPath)) {
    return lightLogoPath;
  }
  if (fs.existsSync(darkLogoPath)) {
    return darkLogoPath;
  }
  if (fs.existsSync(lightLogoPath)) {
    return lightLogoPath;
  }
  throw new Error('No Ever Club logo found');
}

interface PassImages {
  'icon.png': Buffer;
  'icon@2x.png': Buffer;
  'icon@3x.png': Buffer;
  'logo.png': Buffer;
  'logo@2x.png': Buffer;
  'logo@3x.png': Buffer;
  'strip.png': Buffer;
  'strip@2x.png': Buffer;
  'strip@3x.png': Buffer;
}

async function generatePassImages(colors: TierColors): Promise<PassImages> {
  const logoSource = selectLogoSource(colors);
  const stripSource = path.join(process.cwd(), 'public', 'images', 'hero-lounge-optimized.webp');
  const transparentBg = { r: 0, g: 0, b: 0, alpha: 0 };

  const hasStrip = fs.existsSync(stripSource);

  const promises: Promise<Buffer>[] = [
    sharp(logoSource).resize(29, 29, { fit: 'contain', background: transparentBg }).png().toBuffer(),
    sharp(logoSource).resize(58, 58, { fit: 'contain', background: transparentBg }).png().toBuffer(),
    sharp(logoSource).resize(87, 87, { fit: 'contain', background: transparentBg }).png().toBuffer(),
    sharp(logoSource).resize(220, 70, { fit: 'contain', background: transparentBg }).png().toBuffer(),
    sharp(logoSource).resize(440, 140, { fit: 'contain', background: transparentBg }).png().toBuffer(),
    sharp(logoSource).resize(660, 210, { fit: 'contain', background: transparentBg }).png().toBuffer(),
  ];

  if (hasStrip) {
    promises.push(
      sharp(stripSource).resize(375, 123, { fit: 'cover', position: 'centre' }).png().toBuffer(),
      sharp(stripSource).resize(750, 246, { fit: 'cover', position: 'centre' }).png().toBuffer(),
      sharp(stripSource).resize(1125, 369, { fit: 'cover', position: 'centre' }).png().toBuffer(),
    );
  }

  const results = await Promise.all(promises);

  const images: PassImages = {
    'icon.png': results[0],
    'icon@2x.png': results[1],
    'icon@3x.png': results[2],
    'logo.png': results[3],
    'logo@2x.png': results[4],
    'logo@3x.png': results[5],
    'strip.png': hasStrip ? results[6] : results[0],
    'strip@2x.png': hasStrip ? results[7] : results[1],
    'strip@3x.png': hasStrip ? results[8] : results[2],
  };

  return images;
}

function computeSha1(data: Buffer | string): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function signManifest(manifestJson: string, config: WalletConfig): Buffer {
  let cert: forge.pki.Certificate;
  let key: forge.pki.PrivateKey;
  let wwdr: forge.pki.Certificate;

  try {
    cert = forge.pki.certificateFromPem(config.certPem);
  } catch (e) {
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Failed to parse pass certificate PEM: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    key = forge.pki.privateKeyFromPem(config.keyPem);
  } catch (e) {
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Failed to parse pass private key PEM: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    wwdr = forge.pki.certificateFromPem(WWDR_PEM);
  } catch (e) {
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Failed to parse WWDR intermediate certificate: ${e instanceof Error ? e.message : String(e)}`);
  }

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestJson, 'utf8');
  p7.addCertificate(cert);
  p7.addCertificate(wwdr);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      {
        type: forge.pki.oids.contentType,
        value: forge.pki.oids.data,
      },
      {
        type: forge.pki.oids.messageDigest,
      },
      {
        type: forge.pki.oids.signingTime,
        value: new Date() as unknown as Date & string,
      },
    ],
  });

  p7.sign({ detached: true });

  const asn1 = p7.toAsn1();
  const derBytes = forge.asn1.toDer(asn1);
  return Buffer.from(derBytes.getBytes(), 'binary');
}

export async function generatePkPass(data: PassData, config: WalletConfig, dbColors?: TierColors | null): Promise<Buffer> {
  const colors = resolveTierColors(data.tier, dbColors);
  const passJson = buildPassJson(data, config, colors);
  const passJsonStr = JSON.stringify(passJson, null, 2);

  const images = await generatePassImages(colors);

  const files: Record<string, Buffer | string> = {
    'pass.json': passJsonStr,
    ...images,
  };

  const manifest: Record<string, string> = {};
  for (const [filename, content] of Object.entries(files)) {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    manifest[filename] = computeSha1(buffer);
  }
  const manifestJson = JSON.stringify(manifest);
  files['manifest.json'] = manifestJson;

  const signature = signManifest(manifestJson, config);
  files['signature'] = signature;

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 0 } });
    const chunks: Buffer[] = [];

    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', (err: Error) => reject(err));

    for (const [filename, content] of Object.entries(files)) {
      const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
      archive.append(buffer, { name: filename });
    }

    archive.finalize();
  });
}

export interface BookingPassData {
  bookingId: number;
  memberId: string;
  memberName: string;
  memberEmail: string;
  bayName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  playerCount: number;
  serialNumber: string;
  authenticationToken: string;
  webServiceURL?: string;
  clubLatitude?: number;
  clubLongitude?: number;
  clubAddress?: string;
  expirationDate: string;
  voided?: boolean;
}

function buildBookingPassJson(data: BookingPassData, config: WalletConfig): Record<string, unknown> {
  const formattedDate = new Date(data.bookingDate + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const formatTime = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  const formattedStart = formatTime(data.startTime);
  const formattedEnd = formatTime(data.endTime);

  const colors = {
    bg: '#293515',
    foreground: '#FFFFFF',
    label: '#D1D5DB',
  };

  const backFields: Array<{ key: string; label: string; value: string }> = [
    { key: 'bookingId', label: 'Booking ID', value: `#${data.bookingId}` },
    { key: 'memberName', label: 'Member', value: data.memberName },
    { key: 'memberEmail', label: 'Email', value: data.memberEmail },
  ];

  if (data.clubAddress) {
    backFields.push({ key: 'clubAddress', label: 'Club Address', value: data.clubAddress });
  }

  const passJson: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeId,
    serialNumber: data.serialNumber,
    teamIdentifier: config.teamId,
    organizationName: 'Ever Club',
    description: `Ever Club Booking - ${data.bayName} on ${formattedDate}`,
    foregroundColor: hexToRgb(colors.foreground),
    backgroundColor: hexToRgb(colors.bg),
    labelColor: hexToRgb(colors.label),
    expirationDate: data.expirationDate,
  };

  if (data.voided) {
    (passJson as Record<string, unknown>).voided = true;
  }

  if (data.webServiceURL && data.authenticationToken) {
    passJson.webServiceURL = data.webServiceURL;
    passJson.authenticationToken = data.authenticationToken;
  }

  passJson.eventTicket = {
    primaryFields: [
      {
        key: 'eventDate',
        label: 'DATE',
        value: formattedDate,
      },
      {
        key: 'eventTime',
        label: 'TIME',
        value: `${formattedStart} – ${formattedEnd}`,
      },
    ],
    secondaryFields: [
      {
        key: 'bayName',
        label: 'BAY',
        value: data.bayName,
      },
      {
        key: 'duration',
        label: 'DURATION',
        value: `${data.durationMinutes} min`,
      },
    ],
    auxiliaryFields: [
      {
        key: 'playerCount',
        label: 'PLAYERS',
        value: `${data.playerCount}`,
      },
    ],
    backFields,
  };

  passJson.barcode = {
    message: `BOOKING:${data.bookingId}`,
    format: 'PKBarcodeFormatQR',
    messageEncoding: 'iso-8859-1',
  };

  passJson.barcodes = [
    {
      message: `BOOKING:${data.bookingId}`,
      format: 'PKBarcodeFormatQR',
      messageEncoding: 'iso-8859-1',
    },
  ];

  if (
    data.clubLatitude != null && data.clubLongitude != null &&
    isFinite(data.clubLatitude) && isFinite(data.clubLongitude) &&
    data.clubLatitude >= -90 && data.clubLatitude <= 90 &&
    data.clubLongitude >= -180 && data.clubLongitude <= 180
  ) {
    passJson.locations = [
      {
        latitude: data.clubLatitude,
        longitude: data.clubLongitude,
        relevantText: `Your booking at ${data.bayName} starts at ${formattedStart}`,
      },
    ];
  }

  const startDateTime = new Date(`${data.bookingDate}T${data.startTime}`);
  passJson.relevantDate = startDateTime.toISOString();

  return passJson;
}

export async function generateBookingPkPass(data: BookingPassData, config: WalletConfig): Promise<Buffer> {
  const passJson = buildBookingPassJson(data, config);
  const passJsonStr = JSON.stringify(passJson, null, 2);

  const colors: TierColors = {
    bg: '#293515',
    foreground: '#FFFFFF',
    label: '#D1D5DB',
  };

  const images = await generatePassImages(colors);

  const files: Record<string, Buffer | string> = {
    'pass.json': passJsonStr,
    ...images,
  };

  const manifest: Record<string, string> = {};
  for (const [filename, content] of Object.entries(files)) {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    manifest[filename] = computeSha1(buffer);
  }
  const manifestJson = JSON.stringify(manifest);
  files['manifest.json'] = manifestJson;

  const signature = signManifest(manifestJson, config);
  files['signature'] = signature;

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 0 } });
    const chunks: Buffer[] = [];

    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', (err: Error) => reject(err));

    for (const [filename, content] of Object.entries(files)) {
      const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
      archive.append(buffer, { name: filename });
    }

    archive.finalize();
  });
}

export { DEFAULT_TIER_COLORS };
export type { PassData, WalletConfig, TierColors };
