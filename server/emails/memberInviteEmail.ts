export function getMembershipInviteHtml(params: { firstName: string; tierName: string; priceFormatted: string; checkoutUrl: string }): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #F2F2EC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #F2F2EC;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 40px;">
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <img src="https://everclub.app/images/everclub-logo-dark.png" alt="Ever Club" width="180" height="60" style="display: inline-block;">
            </td>
          </tr>
          <tr>
            <td>
              <h1 style="margin: 0 0 24px; font-size: 24px; font-weight: 600; color: #1a1a1a;">Welcome to Ever Club, ${params.firstName}!</h1>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">You've been invited to join Ever Club as a <strong>${params.tierName}</strong> member at ${params.priceFormatted}.</p>
              <p style="margin: 0 0 32px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">Click below to complete your membership signup:</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center;">
                    <a href="${params.checkoutUrl}" style="display: inline-block; padding: 14px 32px; background-color: #1a1a1a; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 500; border-radius: 8px;">Complete Membership</a>
                  </td>
                </tr>
              </table>
              <p style="margin: 32px 0 0; font-size: 14px; line-height: 1.6; color: #888888; text-align: center;">This link will expire in 24 hours. If you have any questions, please contact us.</p>
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

export function getWinBackHtml(params: { firstName: string; reactivationLink: string }): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #F2F2EC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #F2F2EC;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 40px;">
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <img src="https://everclub.app/images/everclub-logo-dark.png" alt="Ever Club" width="180" height="60" style="display: inline-block;">
            </td>
          </tr>
          <tr>
            <td>
              <h1 style="margin: 0 0 24px; font-size: 24px; font-weight: 600; color: #1a1a1a;">We Miss You, ${params.firstName}!</h1>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">We'd love to welcome you back to Ever Club. Your spot is waiting for you.</p>
              <p style="margin: 0 0 32px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">Click below to rejoin and pick up right where you left off:</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center;">
                    <a href="${params.reactivationLink}" style="display: inline-block; padding: 14px 32px; background-color: #1a1a1a; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 500; border-radius: 8px;">Rejoin Ever Club</a>
                  </td>
                </tr>
              </table>
              <p style="margin: 32px 0 0; font-size: 14px; line-height: 1.6; color: #888888; text-align: center;">This link will expire in 24 hours. If you have any questions, please contact us.</p>
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

export function getAccountDeletionHtml(params: { firstName: string }): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #F2F2EC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #F2F2EC;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 40px;">
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <img src="https://everclub.app/images/everclub-logo-dark.png" alt="Ever Club" width="180" height="60" style="display: inline-block;">
            </td>
          </tr>
          <tr>
            <td>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">Hello ${params.firstName},</p>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">We've received your request to delete your Ever Club account.</p>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">Our team will process this request within 7 business days. You will receive a confirmation email once your account has been deleted.</p>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">If you did not make this request or have changed your mind, please contact us immediately at <a href="mailto:info@everclub.app" style="color: #293515;">info@everclub.app</a>.</p>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">Thank you for being a part of the Ever Club community.</p>
              <p style="margin: 0; font-size: 16px; line-height: 1.6; color: #4a4a4a;">Best regards,<br>The Ever Club Team</p>
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
