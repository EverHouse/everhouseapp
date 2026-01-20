import { getResendClient } from '../utils/resend';

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
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .replace(/day pass/i, 'Day Pass');
}

function getEmailWrapper(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ever House</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${CLUB_COLORS.bone}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone};">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 40px;">
          
          <!-- Logo -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <img src="https://everhouse.app/assets/logos/monogram-dark.webp" alt="Ever House" width="60" height="60" style="display: inline-block;">
            </td>
          </tr>
          
          ${content}
          
          <!-- Footer -->
          <tr>
            <td style="text-align: center; padding-top: 24px; border-top: 1px solid ${CLUB_COLORS.borderLight};">
              <p style="margin: 0 0 8px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted};">
                Questions? Reply to this email or contact us at the club.
              </p>
              <a href="https://everhouse.app" style="font-size: 12px; color: ${CLUB_COLORS.deepGreen}; text-decoration: none;">
                everhouse.app
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

function getPassWithQrHtml(passDetails: PassDetails): string {
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(`PASS:${passDetails.passId}`)}`;
  const formattedType = formatPassType(passDetails.type);
  
  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
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
                      <li>Enjoy your visit to Ever House!</li>
                    </ol>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everhouse.app" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Visit Ever House
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
  try {
    const { client, fromEmail } = await getResendClient();
    
    const formattedType = formatPassType(passDetails.type);
    
    await client.emails.send({
      from: fromEmail || 'Ever House <noreply@everhouse.app>',
      to: email,
      subject: `Your ${formattedType} is Ready - Ever House`,
      html: getPassWithQrHtml(passDetails)
    });
    
    console.log(`[PassEmails] Sent QR pass email to ${email} for pass #${passDetails.passId}`);
  } catch (error) {
    console.error('[PassEmails] Error sending pass email:', error);
    throw error;
  }
}
