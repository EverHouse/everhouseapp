import { getWelcomeEmailHtml } from '../emails/welcomeEmail';
import { getTrialWelcomeHtml } from '../emails/trialWelcomeEmail';
import { getFirstVisitHtml } from '../emails/firstVisitEmail';
import { getBookingConfirmationHtml, getBookingRescheduleHtml } from '../emails/bookingEmails';
import { getPassWithQrHtml, getRedemptionConfirmationHtml } from '../emails/passEmails';
import { getPaymentReceiptHtml, getPaymentFailedHtml, getOutstandingBalanceHtml, getFeeWaivedHtml, getPurchaseReceiptHtml } from '../emails/paymentEmails';
import { getMembershipRenewalHtml, getMembershipFailedHtml, getCardExpiringHtml, getGracePeriodReminderHtml, getMembershipActivationHtml } from '../emails/membershipEmails';
import { getIntegrityAlertEmailHtml } from '../emails/integrityAlertEmail';

export interface EmailTemplateInfo {
  id: string;
  name: string;
  description: string;
  category: string;
}

const TEMPLATE_REGISTRY: EmailTemplateInfo[] = [
  { id: 'welcome', name: 'Welcome Email', description: 'Sent when a new member joins', category: 'Welcome' },
  { id: 'trial-welcome', name: 'Trial Welcome', description: 'Sent when a trial membership begins', category: 'Welcome' },
  { id: 'first-visit', name: 'First Visit', description: 'Sent after a member\'s first visit', category: 'Welcome' },
  { id: 'booking-confirmation', name: 'Booking Confirmation', description: 'Sent when a bay booking is confirmed', category: 'Booking' },
  { id: 'booking-reschedule', name: 'Booking Reschedule', description: 'Sent when a booking is rescheduled', category: 'Booking' },
  { id: 'pass-with-qr', name: 'Pass with QR Code', description: 'Pass purchase confirmation with QR code', category: 'Passes' },
  { id: 'redemption-confirmation', name: 'Redemption Confirmation', description: 'Sent when a pass is redeemed', category: 'Passes' },
  { id: 'payment-receipt', name: 'Payment Receipt', description: 'Receipt for a successful payment', category: 'Payments' },
  { id: 'payment-failed', name: 'Payment Failed', description: 'Notification of a failed payment', category: 'Payments' },
  { id: 'outstanding-balance', name: 'Outstanding Balance', description: 'Reminder about an outstanding balance', category: 'Payments' },
  { id: 'fee-waived', name: 'Fee Waived', description: 'Notification that a fee has been waived', category: 'Payments' },
  { id: 'purchase-receipt', name: 'Purchase Receipt', description: 'Receipt for product purchases', category: 'Payments' },
  { id: 'membership-renewal', name: 'Membership Renewal', description: 'Confirmation of membership renewal', category: 'Membership' },
  { id: 'membership-failed', name: 'Membership Payment Failed', description: 'Membership payment failure notice', category: 'Membership' },
  { id: 'card-expiring', name: 'Card Expiring', description: 'Warning that card on file is expiring', category: 'Membership' },
  { id: 'grace-period-reminder', name: 'Grace Period Reminder', description: 'Reminder during grace period', category: 'Membership' },
  { id: 'membership-activation', name: 'Membership Activation', description: 'Membership activation checkout link', category: 'Membership' },
  { id: 'integrity-alert', name: 'Integrity Alert', description: 'System data integrity check results', category: 'System' },
];

export function getAllTemplates(): EmailTemplateInfo[] {
  return TEMPLATE_REGISTRY;
}

export function renderTemplatePreview(templateId: string): string | null {
  switch (templateId) {
    case 'welcome':
      return getWelcomeEmailHtml('Alex');

    case 'trial-welcome':
      return getTrialWelcomeHtml({
        firstName: 'Alex',
        userId: 1,
        trialEndDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        couponCode: 'WELCOME10',
      });

    case 'first-visit':
      return getFirstVisitHtml({ firstName: 'Alex' });

    case 'booking-confirmation':
      return getBookingConfirmationHtml({
        date: '2026-03-15',
        time: '14:00',
        bayName: 'Bay 3',
        memberName: 'Alex Johnson',
        durationMinutes: 60,
      });

    case 'booking-reschedule':
      return getBookingRescheduleHtml({
        date: '2026-03-15',
        startTime: '14:00',
        endTime: '15:00',
        bayName: 'Bay 3',
        memberName: 'Alex Johnson',
      });

    case 'pass-with-qr':
      return getPassWithQrHtml({
        passId: 42,
        type: 'day_pass',
        quantity: 2,
        purchaseDate: new Date(),
      });

    case 'redemption-confirmation':
      return getRedemptionConfirmationHtml({
        guestName: 'Jordan Smith',
        passType: 'day_pass',
        remainingUses: 1,
        redeemedAt: new Date(),
      });

    case 'payment-receipt':
      return getPaymentReceiptHtml({
        memberName: 'Alex Johnson',
        amount: 150.00,
        description: 'Monthly Membership - Premium',
        date: new Date(),
        transactionId: 'txn_sample_12345',
      });

    case 'payment-failed':
      return getPaymentFailedHtml({
        memberName: 'Alex Johnson',
        amount: 150.00,
        reason: 'Card declined — insufficient funds',
        updateCardUrl: 'https://everclub.app/profile',
      });

    case 'outstanding-balance':
      return getOutstandingBalanceHtml({
        memberName: 'Alex Johnson',
        amount: 75.00,
        description: 'Late cancellation fee',
        dueDate: '2026-04-01',
      });

    case 'fee-waived':
      return getFeeWaivedHtml({
        memberName: 'Alex Johnson',
        originalAmount: 25.00,
        reason: 'First-time courtesy waiver',
        bookingDescription: 'Bay 3 — March 15, 2:00 PM',
      });

    case 'purchase-receipt':
      return getPurchaseReceiptHtml({
        memberName: 'Alex Johnson',
        items: [
          { name: 'Day Pass (2-pack)', quantity: 1, unitPrice: 60.00, total: 60.00 },
          { name: 'Pro Shop Glove', quantity: 2, unitPrice: 25.00, total: 50.00 },
        ],
        totalAmount: 110.00,
        paymentMethod: 'Visa ending in 4242',
        paymentIntentId: 'pi_sample_67890',
        date: new Date(),
      });

    case 'membership-renewal':
      return getMembershipRenewalHtml({
        memberName: 'Alex Johnson',
        amount: 299.00,
        planName: 'Premium Membership',
        nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

    case 'membership-failed':
      return getMembershipFailedHtml({
        memberName: 'Alex Johnson',
        amount: 299.00,
        planName: 'Premium Membership',
        reason: 'Card declined',
      });

    case 'card-expiring':
      return getCardExpiringHtml({
        memberName: 'Alex Johnson',
        cardLast4: '4242',
        expiryMonth: 3,
        expiryYear: 2026,
      });

    case 'grace-period-reminder':
      return getGracePeriodReminderHtml({
        memberName: 'Alex Johnson',
        currentDay: 5,
        totalDays: 7,
        reactivationLink: 'https://everclub.app/profile',
      });

    case 'membership-activation':
      return getMembershipActivationHtml({
        memberName: 'Alex Johnson',
        tierName: 'Premium',
        monthlyPrice: 299.00,
        checkoutUrl: 'https://everclub.app/checkout/sample',
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });

    case 'integrity-alert':
      return getIntegrityAlertEmailHtml(
        [
          { checkName: 'Orphaned Bookings', status: 'warning', issueCount: 3, duration: 1200 },
          { checkName: 'Duplicate Members', status: 'error', issueCount: 1, duration: 800 },
          { checkName: 'Stripe Sync', status: 'pass', issueCount: 0, duration: 500 },
        ],
        [
          {
            id: 'issue-1',
            checkName: 'Duplicate Members',
            severity: 'error',
            message: 'Duplicate email found: alex@example.com',
            context: { memberName: 'Alex Johnson', memberEmail: 'alex@example.com' },
          },
        ]
      );

    default:
      return null;
  }
}
