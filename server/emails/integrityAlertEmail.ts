import { getResendClient } from '../utils/resend';
import { IntegrityCheckResult, IntegrityIssue } from '../core/dataIntegrity';

const CLUB_COLORS = {
  deepGreen: '#293515',
  lavender: '#CCB8E4',
  bone: '#F2F2EC',
  textDark: '#1f2937',
  textMuted: '#4b5563',
  borderLight: '#e5e7eb',
  errorRed: '#dc2626',
  warningYellow: '#ca8a04'
};

function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'error': return CLUB_COLORS.errorRed;
    case 'warning': return CLUB_COLORS.warningYellow;
    default: return CLUB_COLORS.textMuted;
  }
}

function formatIssueContext(context?: IntegrityIssue['context']): string {
  if (!context) return '';
  
  const parts: string[] = [];
  if (context.memberName) parts.push(`Member: ${context.memberName}`);
  if (context.memberEmail) parts.push(`Email: ${context.memberEmail}`);
  if (context.bookingDate) parts.push(`Date: ${context.bookingDate}`);
  if (context.startTime) parts.push(`Time: ${context.startTime}`);
  if (context.resourceName) parts.push(`Resource: ${context.resourceName}`);
  if (context.className) parts.push(`Class: ${context.className}`);
  if (context.eventTitle) parts.push(`Event: ${context.eventTitle}`);
  if (context.tourDate) parts.push(`Tour Date: ${context.tourDate}`);
  if (context.guestName) parts.push(`Guest: ${context.guestName}`);
  
  return parts.length > 0 ? `<br><span style="font-size: 12px; color: ${CLUB_COLORS.textMuted};">${parts.join(' • ')}</span>` : '';
}

function getIntegrityAlertEmailHtml(
  results: IntegrityCheckResult[],
  criticalIssues: IntegrityIssue[]
): string {
  const totalIssues = results.reduce((sum, r) => sum + r.issueCount, 0);
  const errorCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'error').length, 0);
  const warningCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'warning').length, 0);
  const infoCount = totalIssues - errorCount - warningCount;
  
  const failedChecks = results.filter(r => r.status === 'fail');
  const warningChecks = results.filter(r => r.status === 'warning');
  
  const issueListHtml = criticalIssues.slice(0, 20).map(issue => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid ${CLUB_COLORS.borderLight};">
        <div style="display: flex; align-items: flex-start;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: ${getSeverityColor(issue.severity)}; margin-right: 8px; margin-top: 6px;"></span>
          <div>
            <strong style="color: ${CLUB_COLORS.textDark};">${issue.table}</strong>
            <span style="color: ${CLUB_COLORS.textMuted}; font-size: 12px;"> #${issue.recordId}</span>
            <p style="margin: 4px 0 0 0; font-size: 14px; color: ${CLUB_COLORS.textDark};">
              ${issue.description}
            </p>
            ${issue.suggestion ? `<p style="margin: 4px 0 0 0; font-size: 12px; color: ${CLUB_COLORS.textMuted};">💡 ${issue.suggestion}</p>` : ''}
            ${formatIssueContext(issue.context)}
          </div>
        </div>
      </td>
    </tr>
  `).join('');
  
  const moreIssuesNote = criticalIssues.length > 20 
    ? `<p style="margin: 16px 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; text-align: center;">... and ${criticalIssues.length - 20} more issues. View all in the admin panel.</p>`
    : '';
  
  const runDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles'
  });
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Data Integrity Alert</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${CLUB_COLORS.bone}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone};">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 650px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 40px;">
          
          <!-- Logo & Title -->
          <tr>
            <td style="text-align: center; padding-bottom: 24px;">
              <img src="https://everclub.app/images/everclub-logo-dark.png" alt="Ever Club" width="150" height="50" style="display: inline-block;">
            </td>
          </tr>
          
          <!-- Alert Badge -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <span style="display: inline-block; background-color: ${CLUB_COLORS.errorRed}; color: #ffffff; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 12px; text-transform: uppercase;">
                Data Integrity Alert
              </span>
            </td>
          </tr>
          
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 8px;">
              <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: ${CLUB_COLORS.textDark};">
                ${errorCount} Critical Issue${errorCount !== 1 ? 's' : ''} Detected
              </h1>
            </td>
          </tr>
          
          <!-- Timestamp -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textMuted};">
                ${runDate} (Pacific)
              </p>
            </td>
          </tr>
          
          <!-- Summary Stats -->
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px; padding: 20px;">
                <tr>
                  <td width="33%" style="text-align: center; padding: 8px;">
                    <div style="font-size: 28px; font-weight: 700; color: ${CLUB_COLORS.errorRed};">${errorCount}</div>
                    <div style="font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase;">Errors</div>
                  </td>
                  <td width="33%" style="text-align: center; padding: 8px; border-left: 1px solid ${CLUB_COLORS.borderLight}; border-right: 1px solid ${CLUB_COLORS.borderLight};">
                    <div style="font-size: 28px; font-weight: 700; color: ${CLUB_COLORS.warningYellow};">${warningCount}</div>
                    <div style="font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase;">Warnings</div>
                  </td>
                  <td width="33%" style="text-align: center; padding: 8px;">
                    <div style="font-size: 28px; font-weight: 700; color: ${CLUB_COLORS.textMuted};">${infoCount}</div>
                    <div style="font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase;">Info</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Failed Checks Summary -->
          ${failedChecks.length > 0 ? `
          <tr>
            <td style="padding-bottom: 16px;">
              <h3 style="margin: 0 0 12px 0; font-size: 16px; font-weight: 600; color: ${CLUB_COLORS.textDark};">
                Failed Checks (${failedChecks.length})
              </h3>
              <ul style="margin: 0; padding-left: 20px; color: ${CLUB_COLORS.textDark};">
                ${failedChecks.map(c => `<li style="margin-bottom: 4px;">${c.checkName} <span style="color: ${CLUB_COLORS.errorRed};">(${c.issueCount} issues)</span></li>`).join('')}
              </ul>
            </td>
          </tr>
          ` : ''}
          
          ${warningChecks.length > 0 ? `
          <tr>
            <td style="padding-bottom: 24px;">
              <h3 style="margin: 0 0 12px 0; font-size: 16px; font-weight: 600; color: ${CLUB_COLORS.textDark};">
                Warning Checks (${warningChecks.length})
              </h3>
              <ul style="margin: 0; padding-left: 20px; color: ${CLUB_COLORS.textDark};">
                ${warningChecks.map(c => `<li style="margin-bottom: 4px;">${c.checkName} <span style="color: ${CLUB_COLORS.warningYellow};">(${c.issueCount} issues)</span></li>`).join('')}
              </ul>
            </td>
          </tr>
          ` : ''}
          
          <!-- Issue Details -->
          <tr>
            <td style="padding-bottom: 24px;">
              <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: ${CLUB_COLORS.textDark};">
                Critical Issues
              </h3>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border: 1px solid ${CLUB_COLORS.borderLight}; border-radius: 8px;">
                ${issueListHtml}
              </table>
              ${moreIssuesNote}
            </td>
          </tr>
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app/admin/data-integrity" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                View in Admin Panel
              </a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="text-align: center; padding-top: 24px; border-top: 1px solid ${CLUB_COLORS.borderLight};">
              <p style="margin: 0; font-size: 12px; color: ${CLUB_COLORS.textMuted};">
                This is an automated daily integrity check alert from Ever Club.
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

export async function sendIntegrityAlertEmail(
  results: IntegrityCheckResult[],
  adminEmail: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const criticalIssues = results
      .flatMap(r => r.issues)
      .filter(i => i.severity === 'error' || i.severity === 'warning');
    
    const errorCount = criticalIssues.filter(i => i.severity === 'error').length;
    
    if (errorCount === 0) {
      console.log('[Integrity Alert] No critical issues found, skipping email');
      return { success: true };
    }
    
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever Club System <noreply@everclub.app>',
      to: adminEmail,
      subject: `Data Integrity Alert: ${errorCount} critical issue${errorCount !== 1 ? 's' : ''} detected`,
      html: getIntegrityAlertEmailHtml(results, criticalIssues)
    });
    
    console.log(`[Integrity Alert] Email sent successfully to ${adminEmail}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[Integrity Alert] Failed to send email to ${adminEmail}:`, error.message);
    return { success: false, error: error.message };
  }
}
