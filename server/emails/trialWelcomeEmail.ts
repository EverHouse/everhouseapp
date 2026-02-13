import { getResendClient } from '../utils/resend';
import { getErrorMessage } from '../utils/errorUtils';

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
          
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <img src="https://everclub.app/images/everclub-logo-dark.png" alt="Ever Club" width="180" height="60" style="display: inline-block;">
            </td>
          </tr>
          
          ${content}
          
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

export function getTrialWelcomeHtml(params: { firstName?: string; userId: number; trialEndDate: Date; couponCode?: string }): string {
  const greeting = params.firstName ? `Welcome, ${params.firstName}!` : 'Welcome to Ever Club!';
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(`MEMBER:${params.userId}`)}`;
  const coupon = params.couponCode || 'ASTORIA7';

  const content = `
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                ${greeting}
              </h1>
            </td>
          </tr>
          
          <tr>
            <td style="text-align: center; padding-bottom: 40px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                You've been activated as a trial member. Enjoy full access to Ever Club for 7 days, through ${formatDate(params.trialEndDate)}.
              </p>
            </td>
          </tr>
          
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <div style="display: inline-block; background-color: #ffffff; padding: 16px; border: 2px solid ${CLUB_COLORS.deepGreen}; border-radius: 12px;">
                <img src="${qrCodeUrl}" alt="Member QR Code" width="200" height="200" style="display: block;">
              </div>
            </td>
          </tr>
          
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.lavender}20; border-radius: 12px; border: 1px solid ${CLUB_COLORS.lavender};">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">Your Member Pass</p>
                    <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                      This QR code is your member pass. Show it at the front desk on your first visit to check in. You can also access it anytime in the Ever Club app.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <tr>
            <td style="padding-bottom: 32px;">
              <p style="margin: 0 0 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Here are 3 ways to get the most out of your trial:
              </p>
            </td>
          </tr>
          
          <tr>
            <td style="padding-bottom: 28px; border-bottom: 1px solid ${CLUB_COLORS.borderLight};">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td width="48" valign="top" style="padding-right: 16px;">
                    <div style="width: 40px; height: 40px; background-color: ${CLUB_COLORS.bone}; border-radius: 10px; text-align: center; line-height: 40px;">
                      <span style="font-size: 20px;">⛳</span>
                    </div>
                  </td>
                  <td valign="top">
                    <h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">
                      Book Golf Simulators
                    </h3>
                    <p style="margin: 0 0 12px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                      Reserve your Trackman bay in just a few taps. See real-time availability, request your preferred time, and get instant confirmation.
                    </p>
                    <a href="https://everclub.app/book-golf" style="display: inline-block; font-size: 14px; color: ${CLUB_COLORS.deepGreen}; text-decoration: none; font-weight: 500;">
                      Book now →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 28px 0; border-bottom: 1px solid ${CLUB_COLORS.borderLight};">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td width="48" valign="top" style="padding-right: 16px;">
                    <div style="width: 40px; height: 40px; background-color: ${CLUB_COLORS.bone}; border-radius: 10px; text-align: center; line-height: 40px;">
                      <span style="font-size: 20px;">🧘</span>
                    </div>
                  </td>
                  <td valign="top">
                    <h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">
                      Explore Wellness
                    </h3>
                    <p style="margin: 0 0 12px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                      Browse spa services, fitness classes, and wellness treatments. Sign up for classes directly from the app with one-tap enrollment.
                    </p>
                    <a href="https://everclub.app/wellness" style="display: inline-block; font-size: 14px; color: ${CLUB_COLORS.deepGreen}; text-decoration: none; font-weight: 500;">
                      View wellness →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <tr>
            <td style="padding-top: 28px; padding-bottom: 40px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td width="48" valign="top" style="padding-right: 16px;">
                    <div style="width: 40px; height: 40px; background-color: ${CLUB_COLORS.bone}; border-radius: 10px; text-align: center; line-height: 40px;">
                      <span style="font-size: 20px;">🎉</span>
                    </div>
                  </td>
                  <td valign="top">
                    <h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">
                      Join Events
                    </h3>
                    <p style="margin: 0 0 12px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                      Stay in the loop on member gatherings, workshops, and special occasions. RSVP with one tap and add events to your calendar.
                    </p>
                    <a href="https://everclub.app/events" style="display: inline-block; font-size: 14px; color: ${CLUB_COLORS.deepGreen}; text-decoration: none; font-weight: 500;">
                      See events →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Open Ever Club App
              </a>
            </td>
          </tr>
          
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px;">
                <tr>
                  <td style="padding: 24px;">
                    <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">Love Ever Club?</p>
                    <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                      After your 7-day trial, use code <strong style="color: ${CLUB_COLORS.deepGreen};">${coupon}</strong> to get 50% off your first month of membership.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
  `;

  return getEmailWrapper(content);
}

export async function sendTrialWelcomeWithQrEmail(
  email: string,
  params: { firstName?: string; userId: number; trialEndDate: Date; couponCode?: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: 'Welcome to Ever Club - Your Trial Pass',
      html: getTrialWelcomeHtml(params)
    });
    
    console.log(`[TrialWelcomeEmail] Sent trial welcome email to ${email} for user #${params.userId}`);
    return { success: true };
  } catch (error: unknown) {
    console.error(`[TrialWelcomeEmail] Failed to send to ${email}:`, getErrorMessage(error));
    return { success: false, error: getErrorMessage(error) };
  }
}
