import crypto from 'crypto';
import forge from 'node-forge';
import archiver from 'archiver';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { logger } from '../core/logger';

interface PassData {
  memberId: string;
  memberName: string;
  memberEmail: string;
  tier: string;
  memberSince: string;
  dailySimulatorMinutes: number | null;
  dailyConfRoomMinutes: number | null;
  guestPassesRemaining: number | null;
  guestPassesTotal: number | null;
  authenticationToken?: string;
  webServiceURL?: string;
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
  VIP: { bg: '#555555', foreground: '#FFFFFF', label: '#7CB342' },
  Premium: { bg: '#555555', foreground: '#FFFFFF', label: '#7CB342' },
  Corporate: { bg: '#555555', foreground: '#FFFFFF', label: '#7CB342' },
  Core: { bg: '#555555', foreground: '#FFFFFF', label: '#7CB342' },
  Social: { bg: '#555555', foreground: '#FFFFFF', label: '#7CB342' },
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

  const auxiliaryFields: Array<{ key: string; label: string; value: string }> = [];
  if (data.memberSince) {
    auxiliaryFields.push({
      key: 'memberSince',
      label: 'MEMBER SINCE',
      value: data.memberSince,
    });
  }

  const passJson: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeId,
    serialNumber: `EVERCLUB-${data.memberId}`,
    teamIdentifier: config.teamId,
    organizationName: 'Ever Club',
    description: `Ever Club ${data.tier} Membership`,
    logoText: 'Ever Club',
    foregroundColor: hexToRgb(colors.foreground),
    backgroundColor: hexToRgb(colors.bg),
    labelColor: hexToRgb(colors.label),
  };

  if (data.webServiceURL && data.authenticationToken) {
    passJson.webServiceURL = data.webServiceURL;
    passJson.authenticationToken = data.authenticationToken;
  }

  passJson.generic = {
    primaryFields: [
      {
        key: 'memberName',
        label: 'MEMBER',
        value: data.memberName,
      },
    ],
    secondaryFields: [
      {
        key: 'tier',
        label: 'TIER',
        value: data.tier,
      },
    ],
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
}

async function generatePassImages(colors: TierColors): Promise<PassImages> {
  const logoSource = selectLogoSource(colors);

  const [icon, icon2x, icon3x, logo, logo2x, logo3x] = await Promise.all([
    sharp(logoSource).resize(29, 29, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    sharp(logoSource).resize(58, 58, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    sharp(logoSource).resize(87, 87, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    sharp(logoSource).resize(220, 70, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    sharp(logoSource).resize(440, 140, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    sharp(logoSource).resize(660, 210, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
  ]);

  return {
    'icon.png': icon,
    'icon@2x.png': icon2x,
    'icon@3x.png': icon3x,
    'logo.png': logo,
    'logo@2x.png': logo2x,
    'logo@3x.png': logo3x,
  };
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
    throw new Error(`Failed to parse pass certificate PEM: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    key = forge.pki.privateKeyFromPem(config.keyPem);
  } catch (e) {
    throw new Error(`Failed to parse pass private key PEM: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    wwdr = forge.pki.certificateFromPem(WWDR_PEM);
  } catch (e) {
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

export { DEFAULT_TIER_COLORS };
export type { PassData, WalletConfig, TierColors };
