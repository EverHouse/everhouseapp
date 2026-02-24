import { getResendClient } from '../utils/resend';
import { logger } from '../core/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { isEmailCategoryEnabled } from '../core/settingsHelper';

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

interface PaymentReceiptParams {
  memberName: string;
  amount: number;
  description: string;
  date: Date;
  transactionId?: string;
}

export function getPaymentReceiptHtml(params: PaymentReceiptParams): string {
  const { memberName, amount, description, date, transactionId } = params;
  
  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Payment Received
              </h1>
            </td>
          </tr>
          
          <!-- Subtitle -->
          <tr>
            <td style="text-align: center; padding-bottom: 40px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Thank you for your payment, ${memberName}.
              </p>
            </td>
          </tr>
          
          <!-- Payment Details -->
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px; padding: 24px;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 16px; border-bottom: 1px solid ${CLUB_COLORS.borderLight};">
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Amount Paid</p>
                          <p style="margin: 0; font-size: 28px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">${formatCurrency(amount)}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top: 16px; padding-bottom: 12px;">
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Description</p>
                          <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textDark};">${description}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px;">
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Date</p>
                          <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textDark};">${formatDate(date)}</p>
                        </td>
                      </tr>
                      ${transactionId ? `
                      <tr>
                        <td>
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Transaction ID</p>
                          <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textMuted}; font-family: monospace;">${transactionId}</p>
                        </td>
                      </tr>
                      ` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app/history" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                View Payment History
              </a>
            </td>
          </tr>
  `;
  
  return getEmailWrapper(content);
}

interface PaymentFailedParams {
  memberName: string;
  amount: number;
  reason: string;
  updateCardUrl?: string;
}

export function getPaymentFailedHtml(params: PaymentFailedParams): string {
  const { memberName, amount, reason, updateCardUrl } = params;
  const ctaUrl = updateCardUrl || 'https://everclub.app/profile';
  
  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Payment Issue
              </h1>
            </td>
          </tr>
          
          <!-- Subtitle -->
          <tr>
            <td style="text-align: center; padding-bottom: 40px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Hi ${memberName}, we were unable to process your payment.
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
                Please update your payment method to ensure uninterrupted access to your membership benefits. If you believe this is an error, please contact us.
              </p>
            </td>
          </tr>
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="${ctaUrl}" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Update Payment Method
              </a>
            </td>
          </tr>
  `;
  
  return getEmailWrapper(content);
}

interface OutstandingBalanceParams {
  memberName: string;
  amount: number;
  description: string;
  dueDate?: string;
}

export function getOutstandingBalanceHtml(params: OutstandingBalanceParams): string {
  const { memberName, amount, description, dueDate } = params;
  
  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Outstanding Balance
              </h1>
            </td>
          </tr>
          
          <!-- Subtitle -->
          <tr>
            <td style="text-align: center; padding-bottom: 40px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Hi ${memberName}, you have an outstanding balance on your account.
              </p>
            </td>
          </tr>
          
          <!-- Balance Details -->
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px; padding: 24px;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 16px; border-bottom: 1px solid ${CLUB_COLORS.borderLight};">
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Amount Due</p>
                          <p style="margin: 0; font-size: 28px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">${formatCurrency(amount)}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top: 16px; padding-bottom: 12px;">
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Description</p>
                          <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textDark};">${description}</p>
                        </td>
                      </tr>
                      ${dueDate ? `
                      <tr>
                        <td>
                          <p style="margin: 0 0 4px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Due Date</p>
                          <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textDark};">${dueDate}</p>
                        </td>
                      </tr>
                      ` : ''}
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
                Please settle this balance at your earliest convenience to continue enjoying your membership benefits. You can pay online or speak with our team at the club.
              </p>
            </td>
          </tr>
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app/profile" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                View Account
              </a>
            </td>
          </tr>
  `;
  
  return getEmailWrapper(content);
}

interface FeeWaivedParams {
  memberName: string;
  originalAmount: number;
  reason: string;
  bookingDescription?: string;
}

export function getFeeWaivedHtml(params: FeeWaivedParams): string {
  const { memberName, originalAmount, reason, bookingDescription } = params;
  
  const content = `
          <!-- Headline -->
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Fee Waived
              </h1>
            </td>
          </tr>
          
          <!-- Subtitle -->
          <tr>
            <td style="text-align: center; padding-bottom: 40px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Good news, ${memberName}! A fee has been waived on your account.
              </p>
            </td>
          </tr>
          
          <!-- Waiver Details -->
          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f0fdf4; border-radius: 12px; border: 1px solid #bbf7d0;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td width="40" valign="top" style="padding-right: 16px;">
                          <div style="width: 32px; height: 32px; background-color: #dcfce7; border-radius: 50%; text-align: center; line-height: 32px;">
                            <span style="font-size: 16px;">✓</span>
                          </div>
                        </td>
                        <td valign="top">
                          <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #166534;">Fee Waived</p>
                          <p style="margin: 0 0 4px 0; font-size: 14px; color: #15803d;">Original Amount: ${formatCurrency(originalAmount)}</p>
                          <p style="margin: 0; font-size: 14px; color: #15803d;">Reason: ${reason}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          ${bookingDescription ? `
          <!-- Booking Details -->
          <tr>
            <td style="padding-bottom: 32px;">
              <p style="margin: 0 0 8px 0; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Related Booking</p>
              <p style="margin: 0; font-size: 14px; color: ${CLUB_COLORS.textDark}; line-height: 1.6;">${bookingDescription}</p>
            </td>
          </tr>
          ` : ''}
          
          <!-- CTA Button -->
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                Open Ever Club App
              </a>
            </td>
          </tr>
  `;
  
  return getEmailWrapper(content);
}

export async function sendPaymentReceiptEmail(
  email: string, 
  params: PaymentReceiptParams
): Promise<{ success: boolean; error?: string }> {
  if (!await isEmailCategoryEnabled('payments')) {
    logger.info('[Payment Receipt Email] SKIPPED - payments emails disabled via settings', { extra: { email } });
    return { success: true };
  }
  try {
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: 'Payment Receipt - Ever Club',
      html: getPaymentReceiptHtml(params)
    });
    
    logger.info(`[Payment Receipt Email] Sent successfully to ${email}`);
    return { success: true };
  } catch (error: unknown) {
    logger.error(`[Payment Receipt Email] Failed to send to ${email}:`, { extra: { errorMessage: getErrorMessage(error) } });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function sendPaymentFailedEmail(
  email: string, 
  params: PaymentFailedParams
): Promise<{ success: boolean; error?: string }> {
  if (!await isEmailCategoryEnabled('payments')) {
    logger.info('[Payment Failed Email] SKIPPED - payments emails disabled via settings', { extra: { email } });
    return { success: true };
  }
  try {
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: 'Payment Issue - Action Required',
      html: getPaymentFailedHtml(params)
    });
    
    logger.info(`[Payment Failed Email] Sent successfully to ${email}`);
    return { success: true };
  } catch (error: unknown) {
    logger.error(`[Payment Failed Email] Failed to send to ${email}:`, { extra: { errorMessage: getErrorMessage(error) } });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function sendOutstandingBalanceEmail(
  email: string, 
  params: OutstandingBalanceParams
): Promise<{ success: boolean; error?: string }> {
  if (!await isEmailCategoryEnabled('payments')) {
    logger.info('[Outstanding Balance Email] SKIPPED - payments emails disabled via settings', { extra: { email } });
    return { success: true };
  }
  try {
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: 'Outstanding Balance - Ever Club',
      html: getOutstandingBalanceHtml(params)
    });
    
    logger.info(`[Outstanding Balance Email] Sent successfully to ${email}`);
    return { success: true };
  } catch (error: unknown) {
    logger.error(`[Outstanding Balance Email] Failed to send to ${email}:`, { extra: { errorMessage: getErrorMessage(error) } });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function sendFeeWaivedEmail(
  email: string, 
  params: FeeWaivedParams
): Promise<{ success: boolean; error?: string }> {
  if (!await isEmailCategoryEnabled('payments')) {
    logger.info('[Fee Waived Email] SKIPPED - payments emails disabled via settings', { extra: { email } });
    return { success: true };
  }
  try {
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: 'Fee Waived - Ever Club',
      html: getFeeWaivedHtml(params)
    });
    
    logger.info(`[Fee Waived Email] Sent successfully to ${email}`);
    return { success: true };
  } catch (error: unknown) {
    logger.error(`[Fee Waived Email] Failed to send to ${email}:`, { extra: { errorMessage: getErrorMessage(error) } });
    return { success: false, error: getErrorMessage(error) };
  }
}

export interface PurchaseReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface PurchaseReceiptParams {
  memberName: string;
  items: PurchaseReceiptItem[];
  totalAmount: number;
  paymentMethod: string;
  paymentIntentId?: string;
  date: Date;
}

export function getPurchaseReceiptHtml(params: PurchaseReceiptParams): string {
  const { memberName, items, totalAmount, paymentMethod, paymentIntentId, date } = params;

  const lineItemsHtml = items.map(item => `
                      <tr>
                        <td style="padding: 10px 0; font-size: 14px; color: ${CLUB_COLORS.textDark}; border-bottom: 1px solid ${CLUB_COLORS.borderLight};">
                          ${item.name}${item.quantity > 1 ? ` <span style="color: ${CLUB_COLORS.textMuted};">x${item.quantity}</span>` : ''}
                        </td>
                        <td style="padding: 10px 0; font-size: 14px; color: ${CLUB_COLORS.textDark}; text-align: right; border-bottom: 1px solid ${CLUB_COLORS.borderLight};">
                          ${formatCurrency(item.total / 100)}
                        </td>
                      </tr>`).join('');

  const paymentMethodLabel = paymentMethod === 'card' ? 'Credit Card' 
    : paymentMethod === 'terminal' ? 'Card Reader' 
    : paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1);

  const content = `
          <tr>
            <td style="text-align: center; padding-bottom: 16px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 32px; font-weight: 400; color: ${CLUB_COLORS.deepGreen};">
                Purchase Receipt
              </h1>
            </td>
          </tr>

          <tr>
            <td style="text-align: center; padding-bottom: 40px;">
              <p style="margin: 0; font-size: 16px; color: ${CLUB_COLORS.textMuted}; line-height: 1.6;">
                Thank you for your purchase, ${memberName}.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${CLUB_COLORS.bone}; border-radius: 12px;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 16px; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Items</td>
                        <td style="padding-bottom: 16px; font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px; text-align: right;">Amount</td>
                      </tr>
                      ${lineItemsHtml}
                      <tr>
                        <td style="padding-top: 16px; font-size: 16px; font-weight: 600; color: ${CLUB_COLORS.deepGreen};">Total</td>
                        <td style="padding-top: 16px; font-size: 16px; font-weight: 600; color: ${CLUB_COLORS.deepGreen}; text-align: right;">${formatCurrency(totalAmount / 100)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding-bottom: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding-bottom: 8px;">
                    <span style="font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Payment Method</span>
                    <span style="font-size: 14px; color: ${CLUB_COLORS.textDark}; float: right;">${paymentMethodLabel}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom: 8px;">
                    <span style="font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Date</span>
                    <span style="font-size: 14px; color: ${CLUB_COLORS.textDark}; float: right;">${formatDate(date)}</span>
                  </td>
                </tr>
                ${paymentIntentId ? `
                <tr>
                  <td>
                    <span style="font-size: 12px; color: ${CLUB_COLORS.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">Transaction ID</span>
                    <span style="font-size: 12px; color: ${CLUB_COLORS.textMuted}; font-family: monospace; float: right;">${paymentIntentId}</span>
                  </td>
                </tr>
                ` : ''}
              </table>
            </td>
          </tr>

          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <a href="https://everclub.app/history" style="display: inline-block; background-color: ${CLUB_COLORS.deepGreen}; color: #ffffff; font-size: 16px; font-weight: 500; text-decoration: none; padding: 14px 32px; border-radius: 12px;">
                View Payment History
              </a>
            </td>
          </tr>
  `;

  return getEmailWrapper(content);
}

export async function sendPurchaseReceipt(
  email: string,
  params: PurchaseReceiptParams
): Promise<{ success: boolean; error?: string }> {
  if (!await isEmailCategoryEnabled('payments')) {
    logger.info('[Purchase Receipt Email] SKIPPED - payments emails disabled via settings', { extra: { email } });
    return { success: true };
  }
  try {
    const { client, fromEmail } = await getResendClient();

    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: email,
      subject: 'Purchase Receipt - Ever Club',
      html: getPurchaseReceiptHtml(params)
    });

    logger.info(`[Purchase Receipt Email] Sent successfully to ${email}`);
    return { success: true };
  } catch (error: unknown) {
    logger.error(`[Purchase Receipt Email] Failed to send to ${email}:`, { extra: { errorMessage: getErrorMessage(error) } });
    return { success: false, error: getErrorMessage(error) };
  }
}
