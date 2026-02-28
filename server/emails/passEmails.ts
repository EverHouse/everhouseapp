import { getResendClient } from '../utils/resend';
import { logger } from '../core/logger';
import { isEmailCategoryEnabled } from '../core/settingsHelper';
import QRCode from 'qrcode';

async function generateQrDataUri(data: string): Promise<string> {
  return await QRCode.toDataURL(data, {
    width: 200,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' }
  });
}

const CLUB_COLORS = {
  deepGreen: '#293515',
  lavender: '#CCB8E4',
  bone: '#F2F2EC',
  textDark: '#1f2937',
  textMuted: '#4b5563',
  borderLight: '#e5e7eb'
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  }).format(date);
}

function formatPassType(type: string): string {
  return type
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .replace(/day pass/i, 'Day Pass -');
}

function getEmailWrapper(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ever Club</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${CLUB_COLORS.bone}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone};">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 40px;">
          
          <!-- Logo -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <img src="https://everclub.app/images/everclub-logo-dark.png" alt="Ever Club" width="180" height="60" style="display: inline-block;">
            </td>
          </tr>
          
          ${content}
          
          <!-- Footer -->
          <tr>
            <td style="text-align: center; padding-top: 24px; border-top: 1px solid ${CLUB_COLORS.borderLight};">
              <p style="margin: 0 0 8px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted};">
                Questions? Reply to this email or contact us at the club.
              </p>
              <a href="https://everclub.app" style="font-size: 12px; color: ${CLUB_COLORS.deepGreen}; text-decoration: none;">
                everclub.app
              </a>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

interface PassDetails {
  passId: number;
  type: string;
  quantity: number;
  purchaseDate: Date;
}

export async function getPassWithQrHtml(passDetails: PassDetails): Promise<string> {
  const qrCodeUrl = await generateQrDataUri(`PASS:${passDetails.passId}`);
  const formattedType = formatPassType(passDetails.type);
  
  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Newsreader', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Your Pass is Ready
              </h1>
            </td>
          </tr>
          
          <!-- Subtitle -->
          <tr>
            <td style="text-align: center; padding-bottom: 40px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Thank you for your purchase! Show this QR code at the front desk to check in.
              </p>
            </td>
          </tr>
          
          <!-- QR Code -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <div style="display: inline-block; background-color: #ffffff; padding: 16px; border: 2px solid ${CLUB_COLORS.deepGreen}; border-radius: 12px;">
                <img src="${qrCodeUrl}" alt="Pass QR Code" width="200" height="200" style="display: block;">
              </div>
            </td>
          </tr>
          
          <!-- Pass Details -->
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px; padding: 24px;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 16px; border-bottom: 1px solid ${CLUB_COLORS.borderLight};">
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Pass Type</p>
                          <p style="margin: 0; font-size: 20px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">${formattedType}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top: 16px; padding-bottom: 12px;">
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Pass ID</p>
                          <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textDark}; font-family: monospace;">#${passDetails.passId}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px;">
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Number of Uses</p>
                          <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textDark};">${passDetails.quantity}</p>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Purchase Date</p>
                          <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textDark};">${formatDate(passDetails.purchaseDate)}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Instructions -->
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.lavender}20; border-radius: 12px; border: 1px solid ${CLUB_COLORS.lavender};">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">How to Use Your Pass</p>
                    <ol style="margin: 0; padding-left: 20px; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.8;">
                      <li>Show this QR code at the front desk when you arrive</li>
                      <li>Our staff will scan the code to verify your pass</li>
                      <li>Enjoy your visit to Ever Club!</li>
                    </ol>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Visit Ever Club
              </a>
            </td>
          </tr>
  `;
  
  return getEmailWrapper(content);
}

export async function sendPassWithQrEmail(
  email: string,
  passDetails: PassDetails
): Promise<void> {
  if (!await isEmailCategoryEnabled('passes')) {
    logger.info('[Pass QR Email] SKIPPED - passes emails disabled via settings', { extra: { email } });
    return;
  }
  try {
    const { client, fromEmail } = await getResendClient();
    
    const formattedType = formatPassType(passDetails.type);
    
    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: `Your ${formattedType} is Ready - Ever Club`,
      html: await getPassWithQrHtml(passDetails)
    });
    
    logger.info(`[PassEmails] Sent QR pass email to ${email} for pass #${passDetails.passId}`);
  } catch (error: unknown) {
    logger.error('[PassEmails] Error sending pass email:', { error: error as Error });
    throw error;
  }
}

interface RedemptionDetails {
  guestName: string;
  passType: string;
  remainingUses: number;
  redeemedAt: Date;
}

function isGolfPass(passType: string): boolean {
  const normalized = passType.toLowerCase();
  return normalized.includes('golf') || normalized.includes('simulator') || normalized.includes('bay');
}

function getGolfPassContent(details: RedemptionDetails, formattedType: string, formattedTime: string): string {
  return `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Newsreader', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Welcome to Ever Club
              </h1>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Hi ${details.guestName}! Your ${formattedType} has been checked in at ${formattedTime}.
                ${details.remainingUses > 0 ? `You have ${details.remainingUses} ${details.remainingUses === 1 ? 'use' : 'uses'} remaining.` : ''}
              </p>
            </td>
          </tr>
          
          <!-- WiFi Info -->
          <tr>
            <td style="padding-bottom: 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px;">
                <tr>
                  <td style="padding: 24px;">
                    <p style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">WiFi Access</p>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 8px;">
                          <p style="margin: 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Network</p>
                          <p style="margin: 4px 0 0 0; font-size: 16px; color: ${CLUB_COLORS.textDark}; font-weight: 500;">Ever Club Members</p>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <p style="margin: 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Password</p>
                          <p style="margin: 4px 0 0 0; font-size: 16px; color: ${CLUB_COLORS.textDark}; font-family: monospace; font-weight: 500;">house18!</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Trackman Simulator Info -->
          <tr>
            <td style="padding-bottom: 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.lavender}20; border-radius: 12px; border: 1px solid ${CLUB_COLORS.lavender};">
                <tr>
                  <td style="padding: 24px;">
                    <p style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">Trackman Golf Simulators</p>
                    <p style="margin: 0 0 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                      Our state-of-the-art Trackman simulators provide the most accurate ball and club tracking technology available. Play world-famous courses, practice your swing with detailed analytics, or enjoy a virtual round with friends.
                    </p>
                    <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.8;">
                      <li>Access 150+ virtual courses including Pebble Beach, St. Andrews, and more</li>
                      <li>Real-time shot analysis with spin, launch angle, and ball speed data</li>
                      <li>Practice mode with driving range and target challenges</li>
                    </ul>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Trackman App CTA -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <p style="margin: 0 0 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted};">
                Download the Trackman app to track your stats and get the most out of your session.
              </p>
              <a href="https://www.trackman.com/golf/performance-studio" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Get Trackman App
              </a>
            </td>
          </tr>
          
          <!-- Enjoy Message -->
          <tr>
            <td style="text-align: center; padding-bottom: 24px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Enjoy your golf session at Ever Club! Our staff is here to help if you need anything.
              </p>
            </td>
          </tr>
  `;
}

function getWorkspacePassContent(details: RedemptionDetails, formattedType: string, formattedTime: string): string {
  return `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Newsreader', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Welcome to Ever Club
              </h1>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Hi ${details.guestName}! Your ${formattedType} has been checked in at ${formattedTime}.
                ${details.remainingUses > 0 ? `You have ${details.remainingUses} ${details.remainingUses === 1 ? 'use' : 'uses'} remaining.` : ''}
              </p>
            </td>
          </tr>
          
          <!-- WiFi Info -->
          <tr>
            <td style="padding-bottom: 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px;">
                <tr>
                  <td style="padding: 24px;">
                    <p style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">WiFi Access</p>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 8px;">
                          <p style="margin: 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Network</p>
                          <p style="margin: 4px 0 0 0; font-size: 16px; color: ${CLUB_COLORS.textDark}; font-weight: 500;">Ever Club Members</p>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <p style="margin: 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Password</p>
                          <p style="margin: 4px 0 0 0; font-size: 16px; color: ${CLUB_COLORS.textDark}; font-family: monospace; font-weight: 500;">house18!</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Cafe Menu CTA -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <p style="margin: 0 0 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted};">
                Check out our cafe menu for refreshments during your visit.
              </p>
              <a href="https://everclub.app/menu" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                View Cafe Menu
              </a>
            </td>
          </tr>
          
          <!-- Enjoy Message -->
          <tr>
            <td style="text-align: center; padding-bottom: 24px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Enjoy your time at Ever Club! Our staff is here to help if you need anything.
              </p>
            </td>
          </tr>
  `;
}

export function getRedemptionConfirmationHtml(details: RedemptionDetails): string {
  const formattedType = formatPassType(details.passType);
  const formattedTime = new Intl.DateTimeFormat('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles'
  }).format(details.redeemedAt);
  
  const content = isGolfPass(details.passType)
    ? getGolfPassContent(details, formattedType, formattedTime)
    : getWorkspacePassContent(details, formattedType, formattedTime);
  
  return getEmailWrapper(content);
}

export async function sendRedemptionConfirmationEmail(
  email: string,
  details: RedemptionDetails
): Promise<void> {
  if (!await isEmailCategoryEnabled('passes')) {
    logger.info('[Redemption Confirmation Email] SKIPPED - passes emails disabled via settings', { extra: { email } });
    return;
  }
  try {
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: `Welcome to Ever Club - You're Checked In!`,
      html: getRedemptionConfirmationHtml(details)
    });
    
    logger.info(`[PassEmails] Sent redemption confirmation to ${email}`);
  } catch (error: unknown) {
    logger.error('[PassEmails] Error sending redemption confirmation:', { error: error as Error });
  }
}
