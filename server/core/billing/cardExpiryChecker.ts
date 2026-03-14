import { getStripeClient } from '../stripe/client';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { notifyMember, notifyAllStaff } from '../notificationService';
import { sendCardExpiringEmail } from '../../emails/membershipEmails';
import { getErrorMessage } from '../../utils/errorUtils';
import type Stripe from 'stripe';

import { logger } from '../logger';

function extractExpiryAndLast4(pm: Stripe.PaymentMethod): { expMonth: number; expYear: number; last4: string } | null {
  if (pm.card) {
    return { expMonth: pm.card.exp_month, expYear: pm.card.exp_year, last4: pm.card.last4 || '****' };
  }
  const link = (pm as unknown as { link?: { exp_month?: number; exp_year?: number; last4?: string } }).link;
  if (link?.exp_month && link?.exp_year) {
    return { expMonth: link.exp_month, expYear: link.exp_year, last4: link.last4 || '****' };
  }
  return null;
}
interface CheckExpiringCardsResult {
  checked: number;
  notified: number;
  errors: string[];
}

export async function checkExpiringCards(): Promise<CheckExpiringCardsResult> {
  const result: CheckExpiringCardsResult = {
    checked: 0,
    notified: 0,
    errors: []
  };

  try {
    const stripe = await getStripeClient();
    
    let hasMore = true;
    let startingAfter: string | undefined = undefined;
    
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    while (hasMore) {
      const customers: Stripe.ApiList<Stripe.Customer> = await stripe.customers.list({ 
        limit: 100,
        starting_after: startingAfter
      });

      for (const customer of customers.data) {
        result.checked++;
        
        if (!customer.invoice_settings?.default_payment_method) {
          continue;
        }

        try {
          const pm = await stripe.paymentMethods.retrieve(
            customer.invoice_settings.default_payment_method as string
          );

          const cardInfo = extractExpiryAndLast4(pm);
          if (!cardInfo) {
            continue;
          }

          const { expMonth, expYear, last4: cardLast4 } = cardInfo;
          const cardExpiry = new Date(expYear, expMonth - 1, 28);

          if (cardExpiry <= sevenDaysFromNow && cardExpiry > now) {
            const userResult = await db.execute(
              sql`SELECT id, email, first_name, last_name FROM users WHERE stripe_customer_id = ${customer.id}`
            );

            if (userResult.rows.length === 0) {
              continue;
            }

            const user = userResult.rows[0];
            const userEmail = user.email;

            if (!userEmail) {
              continue;
            }

            const recentNotification = await db.execute(
              sql`SELECT id FROM notifications 
               WHERE user_email = ${userEmail} 
               AND type = 'card_expiring' 
               AND created_at > NOW() - INTERVAL '7 days'
               LIMIT 1`
            );

            if (recentNotification.rows.length > 0) {
              continue;
            }

            const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Member';

            await sendCardExpiringEmail(String(userEmail), {
              memberName,
              cardLast4,
              expiryMonth: expMonth,
              expiryYear: expYear
            });

            await notifyMember({
              userEmail: String(userEmail),
              title: 'Card Expiring Soon',
              message: `Your payment card ending in ${cardLast4} expires ${String(expMonth).padStart(2, '0')}/${expYear}. Please update your payment method.`,
              type: 'card_expiring',
              url: '/profile'
            });

            // Notify staff about expiring card
            await notifyAllStaff(
              'Member Card Expiring',
              `${memberName} (${userEmail}) has a card ending in ${cardLast4} expiring ${String(expMonth).padStart(2, '0')}/${expYear}.`,
              'card_expiring',
              { sendPush: false, sendWebSocket: true }
            );

            result.notified++;
          }
        } catch (pmError: unknown) {
          result.errors.push(`Error processing customer ${customer.id}: ${getErrorMessage(pmError)}`);
        }
      }

      hasMore = customers.has_more;
      if (hasMore && customers.data.length > 0) {
        startingAfter = customers.data[customers.data.length - 1].id;
      }
    }

    logger.info(`[CardExpiryChecker] Complete - checked: ${result.checked}, notified: ${result.notified}`);
  } catch (error: unknown) {
    logger.error('[CardExpiryChecker] Error:', { extra: { detail: getErrorMessage(error) } });
    result.errors.push(`Fatal error: ${getErrorMessage(error)}`);
  }

  return result;
}
