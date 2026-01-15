import { getResendClient } from '../utils/resend';

const CLUB_COLORS = {
  deepGreen: '#293515',
  lavender: '#CCB8E4',
  bone: '#F2F2EC',
  textDark: '#1f2937',
  textMuted: '#4b5563',
  borderLight: '#e5e7eb'
};

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  }).format(date);
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

interface MembershipRenewalParams {
  memberName: string;
  amount: number;
  planName: string;
  nextBillingDate: Date;
}

function getMembershipRenewalHtml(params: MembershipRenewalParams): string {
  const { memberName, amount, planName, nextBillingDate } = params;
  
  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Membership Renewed
              </h1>
            </td>
          </tr>
          
          <!-- Subtitle -->
          <tr>
            <td style="text-align: center; padding-bottom: 40px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Thank you for continuing your membership, ${memberName}.
              </p>
            </td>
          </tr>
          
          <!-- Renewal Details -->
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px; padding: 24px;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 16px; border-bottom: 1px solid ${CLUB_COLORS.borderLight};">
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Amount Charged</p>
                          <p style="margin: 0; font-size: 28px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">${formatCurrency(amount)}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top: 16px; padding-bottom: 12px;">
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Membership Plan</p>
                          <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textDark};">${planName}</p>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Next Billing Date</p>
                          <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textDark};">${formatDate(nextBillingDate)}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Thank You Message -->
          <tr>
            <td style="padding-bottom: 32px;">
              <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                We're thrilled to have you as a member of Ever House. Continue enjoying all the benefits of your membership including golf simulators, wellness facilities, and exclusive events.
              </p>
            </td>
          </tr>
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everhouse.app" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Open Ever House App
              </a>
            </td>
          </tr>
  `;
  
  return getEmailWrapper(content);
}

interface MembershipFailedParams {
  memberName: string;
  amount: number;
  planName: string;
  reason: string;
}

function getMembershipFailedHtml(params: MembershipFailedParams): string {
  const { memberName, amount, planName, reason } = params;
  
  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Membership Payment Failed
              </h1>
            </td>
          </tr>
          
          <!-- Subtitle -->
          <tr>
            <td style="text-align: center; padding-bottom: 40px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Hi ${memberName}, we were unable to process your membership renewal.
              </p>
            </td>
          </tr>
          
          <!-- Alert Box -->
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #fef2f2; border-radius: 12px; border: 1px solid #fecaca;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td width="40" valign="top" style="padding-right: 16px;">
                          <div style="width: 32px; height: 32px; background-color: #fee2e2; border-radius: 50%; text-align: center; line-height: 32px;">
                            <span style="font-size: 16px;">⚠️</span>
                          </div>
                        </td>
                        <td valign="top">
                          <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #991b1b;">Payment Failed</p>
                          <p style="margin: 0 0 4px 0; font-size: 14px; color: #7f1d1d;">Plan: ${planName}</p>
                          <p style="margin: 0 0 4px 0; font-size: 14px; color: #7f1d1d;">Amount: ${formatCurrency(amount)}</p>
                          <p style="margin: 0; font-size: 14px; color: #7f1d1d;">Reason: ${reason}</p>
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
              <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                To keep your membership active and continue enjoying Ever House benefits, please update your payment method as soon as possible. Your membership access may be limited until the payment is resolved.
              </p>
            </td>
          </tr>
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everhouse.app/profile" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Update Payment Method
              </a>
            </td>
          </tr>
  `;
  
  return getEmailWrapper(content);
}

interface CardExpiringParams {
  memberName: string;
  cardLast4: string;
  expiryMonth: number;
  expiryYear: number;
}

function getCardExpiringHtml(params: CardExpiringParams): string {
  const { memberName, cardLast4, expiryMonth, expiryYear } = params;
  const expiryDisplay = `${String(expiryMonth).padStart(2, '0')}/${expiryYear}`;
  
  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Card Expiring Soon
              </h1>
            </td>
          </tr>
          
          <!-- Subtitle -->
          <tr>
            <td style="text-align: center; padding-bottom: 40px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Hi ${memberName}, your payment card is about to expire.
              </p>
            </td>
          </tr>
          
          <!-- Warning Box -->
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #fffbeb; border-radius: 12px; border: 1px solid #fde68a;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td width="40" valign="top" style="padding-right: 16px;">
                          <div style="width: 32px; height: 32px; background-color: #fef3c7; border-radius: 50%; text-align: center; line-height: 32px;">
                            <span style="font-size: 16px;">💳</span>
                          </div>
                        </td>
                        <td valign="top">
                          <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #92400e;">Card Expiring</p>
                          <p style="margin: 0 0 4px 0; font-size: 14px; color: #a16207;">Card ending in: •••• ${cardLast4}</p>
                          <p style="margin: 0; font-size: 14px; color: #a16207;">Expires: ${expiryDisplay}</p>
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
              <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                To ensure uninterrupted membership and avoid any payment issues, please update your payment method before your card expires. This only takes a moment.
              </p>
            </td>
          </tr>
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everhouse.app/profile" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Update Payment Method
              </a>
            </td>
          </tr>
  `;
  
  return getEmailWrapper(content);
}

export async function sendMembershipRenewalEmail(
  email: string, 
  params: MembershipRenewalParams
): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever House Members Club <noreply@everhouse.app>',
      to: email,
      subject: 'Membership Renewed - Ever House',
      html: getMembershipRenewalHtml(params)
    });
    
    console.log(`[Membership Renewal Email] Sent successfully to ${email}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[Membership Renewal Email] Failed to send to ${email}:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function sendMembershipFailedEmail(
  email: string, 
  params: MembershipFailedParams
): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever House Members Club <noreply@everhouse.app>',
      to: email,
      subject: 'Membership Payment Failed - Action Required',
      html: getMembershipFailedHtml(params)
    });
    
    console.log(`[Membership Failed Email] Sent successfully to ${email}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[Membership Failed Email] Failed to send to ${email}:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function sendCardExpiringEmail(
  email: string, 
  params: CardExpiringParams
): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever House Members Club <noreply@everhouse.app>',
      to: email,
      subject: 'Update Your Payment Method - Ever House',
      html: getCardExpiringHtml(params)
    });
    
    console.log(`[Card Expiring Email] Sent successfully to ${email}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[Card Expiring Email] Failed to send to ${email}:`, error.message);
    return { success: false, error: error.message };
  }
}
