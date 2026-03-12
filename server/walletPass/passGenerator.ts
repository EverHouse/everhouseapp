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
  tier: string;
  memberSince: string;
  dailySimulatorMinutes: number | null;
  dailyConfRoomMinutes: number | null;
  guestPassesRemaining: number | null;
  guestPassesTotal: number | null;
}

interface WalletConfig {
  passTypeId: string;
  teamId: string;
  certPem: string;
  keyPem: string;
}

const TIER_COLORS: Record<string, { bg: string; foreground: string; label: string }> = {
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
MIIEVTCCAz2gAwIBAgIUE9x3lVJx5T3GMujM6MUkvmMm8dIwDQYJKoZIhvcNAQEL
BQAwYjELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsT
HUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBS
b290IENBMB4XDTIwMTIxNjE5MzYwNFoXDTMwMTIxMDAwMDAwMFowdTEtMCsGA1UE
AwwkQXBwbGUgV29ybGR3aWRlIERldmVsb3BlciBSZWxhdGlvbnMxJjAkBgNVBAsM
HUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJ
bmMuMQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AJblobGPEbMHp0Cdoxrah0o4pHst31jHCMRUSTC+5FhMPdsYEsfWFJRjbAJlnP9F
T3LHXYXK72gPV7Rp9MzzLGqSfX4Ow1ELEQ0GBj9jZMJIMSLEzPVNMfYtOCm9cFl
j/TOLehMPM7k55pKqfJnm0eJergxIAGFgdPTMVsGPTnGPjBduLlYR31HJahKEo3v
g02fuvOF0Lmk+LuqbIZphQPB2sCzcfNmkQWN9RE0dIH+fB9IFcMaIR/o+jXFeNgj
sNmWCTkXMOFl8hMfNxhFSwCD3K2S6RbtsIrKVnF5r0MqfXlLWJJR2T/gDpgKlibz
8miH9JfehilIpGNL9LWN2QkCAwEAAaOB7zCB7DASBgNVHRMBAf8ECDAGAQH/AgEA
MB8GA1UdIwQYMBaAFCvQaUeUdgn+9GuNLkCm90dNfwheMEQGCCsGAQUFBwEBBDgw
NjA0BggrBgEFBQcwAYYoaHR0cDovL29jc3AuYXBwbGUuY29tL29jc3AwMy1hcHBs
ZXJvb3RjYTAuBgNVHR8EJzAlMCOgIaAfhh1odHRwOi8vY3JsLmFwcGxlLmNvbS9y
b290LmNybDAdBgNVHQ4EFgQUW9n6M6rFhFBFT8lNNKDBxEJ2FcIwDgYDVR0PAQH/
BAQDAgEGMBAGCiqGSIb3Y2QGAgEEAgUAMA0GCSqGSIb3DQEBCwUAA4IBAQA/i3Km
GAx/wGi/VG4L0KzwFxmr6AYF7RBk3GEKumXaVI6DQHCh97CQZo2LE0sWj9HW8OyS
FhiBfJjE8aLCjpJJi11443qJXCBe7XRMhJpz9sMI2GreyZOuyudpv8FmFulHcRm4
G9W5k4ms8R38i/pS1haVhW0mDp53mUAFIjOjhBIqJVUV5EoG7O1KPMajD/YLz6nv
j2VF9cbAmMP/oJpsMImMZ9aYwGE2cNl2C9O1nmJzXb2K1K5AJYO7giZzUFmYVDhx
UMl8/enKI0j1gkb6KnxGJaWXkjQ2gUVYBrlsmG3gHFKa2l0UMxGMFAuAWXWjhIwp
L97MiZpIRunQp/c9
-----END CERTIFICATE-----`;

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function buildPassJson(data: PassData, config: WalletConfig): Record<string, unknown> {
  const colors = TIER_COLORS[data.tier] || TIER_COLORS.Social;

  const backFields: Array<{ key: string; label: string; value: string }> = [];

  if (data.memberSince) {
    backFields.push({
      key: 'memberSince',
      label: 'Member Since',
      value: data.memberSince,
    });
  }

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

  return {
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
    generic: {
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
      backFields,
    },
    barcode: {
      message: `MEMBER:${data.memberId}`,
      format: 'PKBarcodeFormatQR',
      messageEncoding: 'iso-8859-1',
    },
    barcodes: [
      {
        message: `MEMBER:${data.memberId}`,
        format: 'PKBarcodeFormatQR',
        messageEncoding: 'iso-8859-1',
      },
    ],
  };
}

function selectLogoSource(tier: string): string {
  const colors = TIER_COLORS[tier] || TIER_COLORS.Social;
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

async function generatePassImages(tier: string): Promise<PassImages> {
  const logoSource = selectLogoSource(tier);
  const colors = TIER_COLORS[tier] || TIER_COLORS.Social;
  const bgHex = colors.bg;
  const bgR = parseInt(bgHex.slice(1, 3), 16);
  const bgG = parseInt(bgHex.slice(3, 5), 16);
  const bgB = parseInt(bgHex.slice(5, 7), 16);

  const [icon, icon2x, icon3x, logo, logo2x, logo3x] = await Promise.all([
    sharp(logoSource).resize(29, 29, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    sharp(logoSource).resize(58, 58, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    sharp(logoSource).resize(87, 87, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    sharp(logoSource).resize(160, 50, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    sharp(logoSource).resize(320, 100, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    sharp(logoSource).resize(480, 150, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
  ]);

  const createStrip = async (width: number, height: number): Promise<Buffer> => {
    const logoResized = await sharp(logoSource)
      .resize(Math.round(width * 0.4), Math.round(height * 0.5), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: bgR, g: bgG, b: bgB, alpha: 255 },
      },
    })
      .composite([{
        input: logoResized,
        gravity: 'centre',
      }])
      .png()
      .toBuffer();
  };

  const [strip, strip2x, strip3x] = await Promise.all([
    createStrip(375, 123),
    createStrip(750, 246),
    createStrip(1125, 369),
  ]);

  return {
    'icon.png': icon,
    'icon@2x.png': icon2x,
    'icon@3x.png': icon3x,
    'logo.png': logo,
    'logo@2x.png': logo2x,
    'logo@3x.png': logo3x,
    'strip.png': strip,
    'strip@2x.png': strip2x,
    'strip@3x.png': strip3x,
  };
}

function computeSha1(data: Buffer | string): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function signManifest(manifestJson: string, config: WalletConfig): Buffer {
  const cert = forge.pki.certificateFromPem(config.certPem);
  const key = forge.pki.privateKeyFromPem(config.keyPem);
  const wwdr = forge.pki.certificateFromPem(WWDR_PEM);

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
        value: new Date() as unknown as string,
      },
    ],
  });

  p7.sign({ detached: true });

  const asn1 = p7.toAsn1();
  const derBytes = forge.asn1.toDer(asn1);
  return Buffer.from(derBytes.getBytes(), 'binary');
}

export async function generatePkPass(data: PassData, config: WalletConfig): Promise<Buffer> {
  const passJson = buildPassJson(data, config);
  const passJsonStr = JSON.stringify(passJson, null, 2);

  const images = await generatePassImages(data.tier);

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
    const archive = archiver('zip', { store: true });
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

export type { PassData, WalletConfig };
