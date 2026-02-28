import { getResendClient } from '../utils/resend';
import { getErrorMessage } from '../utils/errorUtils';
import { logger } from '../core/logger';
import { isEmailCategoryEnabled } from '../core/settingsHelper';

const CLUB_COLORS = {
  deepGreen: '#293515',
  lavender: '#CCB8E4',
  bone: '#F2F2EC',
  textDark: '#1f2937',
  textMuted: '#4b5563',
  borderLight: '#e5e7eb'
};

function getEmailWrapper(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
</html>`;
}

function getNudge24hHtml(firstName?: string): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';

  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Newsreader', Georgia, serif; font-size: 28px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Your membership is waiting
              </h1>
            </td>
          </tr>
          
          <!-- Body -->
          <tr>
            <td style="padding-bottom: 24px;">
              <p style="margin: 0 0 16px 0; font-size: 16px; color: ${CLUB_COLORS.textDark}; line-height: 1.6;">
                ${greeting}
              </p>
              <p style="margin: 0 0 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Just a friendly reminder — your Ever Club membership is active and ready to go! You can sign in anytime to book your first golf simulator session, explore upcoming events, or check out our wellness services.
              </p>
              <p style="margin: 0 0 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                It only takes a moment to get started.
              </p>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app/login" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Sign In & Book a Session
              </a>
            </td>
          </tr>`;

  return getEmailWrapper(content);
}

function getNudge72hHtml(firstName?: string): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';

  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Newsreader', Georgia, serif; font-size: 28px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                3 things to try at Ever Club
              </h1>
            </td>
          </tr>
          
          <!-- Intro -->
          <tr>
            <td style="padding-bottom: 24px;">
              <p style="margin: 0 0 16px 0; font-size: 16px; color: ${CLUB_COLORS.textDark}; line-height: 1.6;">
                ${greeting}
              </p>
              <p style="margin: 0 0 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                You've been a member for a few days now — here are some quick ways to make the most of your membership:
              </p>
            </td>
          </tr>

          <!-- Tip 1 -->
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
                      Book a Golf Simulator Session
                    </h3>
                    <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                      Reserve a Trackman bay and play world-class courses right from the club. It's easy to find an open time that works for you.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Tip 2 -->
          <tr>
            <td style="padding: 28px 0; border-bottom: 1px solid ${CLUB_COLORS.borderLight};">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td width="48" valign="top" style="padding-right: 16px;">
                    <div style="width: 40px; height: 40px; background-color: ${CLUB_COLORS.bone}; border-radius: 10px; text-align: center; line-height: 40px;">
                      <span style="font-size: 20px;">🎉</span>
                    </div>
                  </td>
                  <td valign="top">
                    <h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">
                      Check Upcoming Club Events
                    </h3>
                    <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                      From social mixers to themed nights, there's always something happening. Browse the events calendar and RSVP with one tap.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Tip 3 -->
          <tr>
            <td style="padding-top: 28px; padding-bottom: 40px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td width="48" valign="top" style="padding-right: 16px;">
                    <div style="width: 40px; height: 40px; background-color: ${CLUB_COLORS.bone}; border-radius: 10px; text-align: center; line-height: 40px;">
                      <span style="font-size: 20px;">🧘</span>
                    </div>
                  </td>
                  <td valign="top">
                    <h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">
                      Explore Wellness Services
                    </h3>
                    <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                      Discover spa treatments, fitness classes, and wellness offerings designed to help you recharge and feel your best.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Open Ever Club
              </a>
            </td>
          </tr>`;

  return getEmailWrapper(content);
}

function getNudge7dHtml(firstName?: string): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';

  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Newsreader', Georgia, serif; font-size: 28px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Need help getting started?
              </h1>
            </td>
          </tr>
          
          <!-- Body -->
          <tr>
            <td style="padding-bottom: 24px;">
              <p style="margin: 0 0 16px 0; font-size: 16px; color: ${CLUB_COLORS.textDark}; line-height: 1.6;">
                ${greeting}
              </p>
              <p style="margin: 0 0 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                We noticed you haven't had a chance to visit the club yet, and we want to make sure everything is set up for you. Our team is here to help!
              </p>
              <p style="margin: 0 0 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                We'd love to:
              </p>
              <ul style="margin: 0 0 16px 0; padding-left: 20px; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.8;">
                <li>Give you a personal tour of the club</li>
                <li>Help you book your first simulator session</li>
                <li>Walk you through the app and membership perks</li>
              </ul>
              <p style="margin: 0 0 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Just reply to this email or reach out to us directly — we're happy to help you get the most out of your membership.
              </p>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <a href="mailto:hello@everclub.app" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Contact Us
              </a>
            </td>
          </tr>
          
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <p style="margin: 0; font-size: 13px; color: ${CLUB_COLORS.textMuted};">
                Or simply reply to this email — we'd love to hear from you.
              </p>
            </td>
          </tr>`;

  return getEmailWrapper(content);
}

export async function sendOnboardingNudge24h(email: string, firstName?: string): Promise<{ success: boolean; error?: string }> {
  if (!await isEmailCategoryEnabled('onboarding')) {
    logger.info('[Onboarding Nudge Email] SKIPPED - onboarding emails disabled via settings', { extra: { email } });
    return { success: true };
  }
  try {
    const { client, fromEmail } = await getResendClient();

    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: 'Your Ever Club membership is waiting',
      html: getNudge24hHtml(firstName)
    });

    logger.info(`[Onboarding Nudge] 24h nudge sent successfully to ${email}`);
    return { success: true };
  } catch (error: unknown) {
    logger.error(`[Onboarding Nudge] Failed to send 24h nudge to ${email}:`, { extra: { errorMessage: getErrorMessage(error) } });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function sendOnboardingNudge72h(email: string, firstName?: string): Promise<{ success: boolean; error?: string }> {
  if (!await isEmailCategoryEnabled('onboarding')) {
    logger.info('[Onboarding Nudge Email] SKIPPED - onboarding emails disabled via settings', { extra: { email } });
    return { success: true };
  }
  try {
    const { client, fromEmail } = await getResendClient();

    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: '3 things to try at Ever Club',
      html: getNudge72hHtml(firstName)
    });

    logger.info(`[Onboarding Nudge] 72h nudge sent successfully to ${email}`);
    return { success: true };
  } catch (error: unknown) {
    logger.error(`[Onboarding Nudge] Failed to send 72h nudge to ${email}:`, { extra: { errorMessage: getErrorMessage(error) } });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function sendOnboardingNudge7d(email: string, firstName?: string): Promise<{ success: boolean; error?: string }> {
  if (!await isEmailCategoryEnabled('onboarding')) {
    logger.info('[Onboarding Nudge Email] SKIPPED - onboarding emails disabled via settings', { extra: { email } });
    return { success: true };
  }
  try {
    const { client, fromEmail } = await getResendClient();

    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: 'Need help getting started?',
      html: getNudge7dHtml(firstName)
    });

    logger.info(`[Onboarding Nudge] 7d nudge sent successfully to ${email}`);
    return { success: true };
  } catch (error: unknown) {
    logger.error(`[Onboarding Nudge] Failed to send 7d nudge to ${email}:`, { extra: { errorMessage: getErrorMessage(error) } });
    return { success: false, error: getErrorMessage(error) };
  }
}
