import { getResendClient } from '../utils/resend';
import { logger } from '../core/logger';

const CLUB_COLORS = {
  deepGreen: '#293515',
  lavender: '#CCB8E4',
  bone: '#F2F2EC',
  textDark: '#1f2937',
  textMuted: '#4b5563',
  borderLight: '#e5e7eb'
};

interface BookingConfirmationData {
  date: string;
  time: string;
  bayName: string;
  memberName: string;
  durationMinutes?: number;
}

export function getBookingConfirmationHtml(data: BookingConfirmationData): string {
  const formattedDate = new Date(data.date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  
  const formattedTime = data.time.length === 5 
    ? new Date(`2000-01-01T${data.time}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    : data.time;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Booking Confirmed - Ever Club</title>
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
          
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 28px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Booking Confirmed
              </h1>
            </td>
          </tr>
          
          <!-- Checkmark icon -->
          <tr>
            <td style="text-align: center; padding-bottom: 24px;">
              <div style="width: 64px; height: 64px; background-color: #22c55e; border-radius: 50%; margin: 0 auto; line-height: 64px;">
                <span style="font-size: 32px; color: #ffffff;">✓</span>
              </div>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Hi ${data.memberName}, your simulator booking is confirmed!
              </p>
            </td>
          </tr>
          
          <!-- Booking Details Card -->
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px; padding: 24px;">
                <tr>
                  <td>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 16px;">
                          <p style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: ${CLUB_COLORS.textMuted};">Date</p>
                          <p style="margin: 4px 0 0 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">${formattedDate}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 16px;">
                          <p style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: ${CLUB_COLORS.textMuted};">Time</p>
                          <p style="margin: 4px 0 0 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">${formattedTime}</p>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <p style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: ${CLUB_COLORS.textMuted};">Location</p>
                          <p style="margin: 4px 0 0 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">${data.bayName}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app/bookings" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
                View My Bookings
              </a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="text-align: center; border-top: 1px solid ${CLUB_COLORS.borderLight}; padding-top: 24px;">
              <p style="margin: 0; font-size: 12px; color: ${CLUB_COLORS.textMuted};">
                Need to make changes? You can reschedule or cancel from your bookings page.
              </p>
              <p style="margin: 16px 0 0 0; font-size: 12px; color: ${CLUB_COLORS.textMuted};">
                Ever Club • 123 Golf Club Drive • Los Angeles, CA
              </p>
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

interface BookingRescheduleData {
  date: string;
  startTime: string;
  endTime: string;
  bayName: string;
  memberName: string;
}

export function getBookingRescheduleHtml(data: BookingRescheduleData): string {
  const formattedDate = new Date(data.date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const formatTime = (t: string) =>
    t.length === 5
      ? new Date(`2000-01-01T${t}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
      : t;

  const formattedStart = formatTime(data.startTime);
  const formattedEnd = formatTime(data.endTime);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Booking Rescheduled - Ever Club</title>
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

          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 28px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Booking Rescheduled
              </h1>
            </td>
          </tr>

          <tr>
            <td style="text-align: center; padding-bottom: 24px;">
              <div style="width: 64px; height: 64px; background-color: ${CLUB_COLORS.lavender}; border-radius: 50%; margin: 0 auto; line-height: 64px;">
                <span style="font-size: 32px; color: ${CLUB_COLORS.deepGreen};">&#8635;</span>
              </div>
            </td>
          </tr>

          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Hi ${data.memberName}, your simulator booking has been rescheduled to a new time.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px; padding: 24px;">
                <tr>
                  <td>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 16px;">
                          <p style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: ${CLUB_COLORS.textMuted};">New Date</p>
                          <p style="margin: 4px 0 0 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">${formattedDate}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 16px;">
                          <p style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: ${CLUB_COLORS.textMuted};">New Time</p>
                          <p style="margin: 4px 0 0 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">${formattedStart} – ${formattedEnd}</p>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <p style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: ${CLUB_COLORS.textMuted};">Location</p>
                          <p style="margin: 4px 0 0 0; font-size: 18px; font-weight: 600; color: ${CLUB_COLORS.textDark};">${data.bayName}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app/bookings" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
                View My Bookings
              </a>
            </td>
          </tr>

          <tr>
            <td style="text-align: center; border-top: 1px solid ${CLUB_COLORS.borderLight}; padding-top: 24px;">
              <p style="margin: 0; font-size: 12px; color: ${CLUB_COLORS.textMuted};">
                If you have any questions about this change, please contact the front desk.
              </p>
              <p style="margin: 16px 0 0 0; font-size: 12px; color: ${CLUB_COLORS.textMuted};">
                Ever Club • 123 Golf Club Drive • Los Angeles, CA
              </p>
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

export async function sendBookingRescheduleEmail(
  email: string,
  data: BookingRescheduleData
): Promise<boolean> {
  try {
    const resendResult = await getResendClient();
    if (!resendResult) {
      logger.warn('[BookingEmails] Resend client not configured, skipping reschedule email');
      return false;
    }

    const html = getBookingRescheduleHtml(data);

    await resendResult.client.emails.send({
      from: 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: `Booking Rescheduled: ${data.bayName} on ${data.date}`,
      html,
    });

    logger.info('[BookingEmails] Sent booking reschedule email', { extra: { email, date: data.date } });
    return true;
  } catch (error) {
    logger.error('[BookingEmails] Failed to send booking reschedule email', { error: error as Error });
    return false;
  }
}

export async function sendBookingConfirmationEmail(
  email: string,
  data: BookingConfirmationData
): Promise<boolean> {
  try {
    const resendResult = await getResendClient();
    if (!resendResult) {
      logger.warn('[BookingEmails] Resend client not configured, skipping email');
      return false;
    }
    
    const html = getBookingConfirmationHtml(data);
    
    await resendResult.client.emails.send({
      from: 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: `Booking Confirmed: ${data.bayName} on ${data.date}`,
      html,
    });
    
    logger.info('[BookingEmails] Sent booking confirmation email', { extra: { email, date: data.date } });
    return true;
  } catch (error) {
    logger.error('[BookingEmails] Failed to send booking confirmation', { error: error as Error });
    return false;
  }
}
