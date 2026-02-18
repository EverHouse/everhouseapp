import { getStripeClient } from '../stripe/client';
import { pool } from '../db';
import { notifyMember, notifyAllStaff } from '../notificationService';
import { sendCardExpiringEmail } from '../../emails/membershipEmails';
import { getErrorMessage } from '../../utils/errorUtils';

import { logger } from '../logger';
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
      const customers = await stripe.customers.list({ 
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

          if (!pm.card) {
            continue;
          }

          const expMonth = pm.card.exp_month;
          const expYear = pm.card.exp_year;
          const cardExpiry = new Date(expYear, expMonth - 1, 28);

          if (cardExpiry <= sevenDaysFromNow && cardExpiry > now) {
            const userResult = await pool.query(
              'SELECT id, email, first_name, last_name FROM users WHERE stripe_customer_id = $1',
              [customer.id]
            );

            if (userResult.rows.length === 0) {
              continue;
            }

            const user = userResult.rows[0];
            const userEmail = user.email;

            if (!userEmail) {
              continue;
            }

            const recentNotification = await pool.query(
              `SELECT id FROM notifications 
               WHERE user_email = $1 
               AND type = 'card_expiring' 
               AND created_at > NOW() - INTERVAL '7 days'
               LIMIT 1`,
              [userEmail]
            );

            if (recentNotification.rows.length > 0) {
              continue;
            }

            const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Member';
            const cardLast4 = pm.card.last4 || '****';

            await sendCardExpiringEmail(userEmail, {
              memberName,
              cardLast4,
              expiryMonth: expMonth,
              expiryYear: expYear
            });

            await notifyMember({
              userEmail,
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
