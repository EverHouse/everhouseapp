import { pool } from '../db';
import { getStripeClient } from './client';
import { confirmPaymentSuccess } from './payments';

export async function reconcileDailyPayments() {
  console.log('[Reconcile] Starting daily payment reconciliation...');
  
  try {
    const stripe = await getStripeClient();
    
    const yesterday = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    
    let hasMore = true;
    let startingAfter: string | undefined;
    let totalChecked = 0;
    let missingPayments = 0;
    let statusMismatches = 0;

    while (hasMore) {
      const params: any = {
        created: { gte: yesterday },
        limit: 100,
      };
      if (startingAfter) {
        params.starting_after = startingAfter;
      }

      const paymentIntents = await stripe.paymentIntents.list(params);
      
      for (const pi of paymentIntents.data) {
        totalChecked++;
        
        if (pi.status === 'succeeded') {
          const result = await pool.query(
            `SELECT status FROM stripe_payment_intents WHERE stripe_payment_intent_id = $1`,
            [pi.id]
          );

          // If missing in DB OR status mismatch (DB says pending, Stripe says succeeded)
          if (result.rows.length === 0 || result.rows[0].status !== 'succeeded') {
            console.warn(`[Reconcile] Healing payment: ${pi.id} (${(pi.amount / 100).toFixed(2)} ${pi.currency})`);
            
            // A. Update the Audit Log / Intent Table
            await pool.query(
              `INSERT INTO stripe_payment_intents (
                stripe_payment_intent_id, user_id, amount, currency, status, purpose, created_at, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
              ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = $5, updated_at = NOW()`,
              [
                pi.id,
                pi.metadata?.userId || pi.metadata?.email || 'unknown',
                pi.amount,
                pi.currency,
                'succeeded',
                pi.metadata?.purpose || 'reconciled'
              ]
            );

            // B. CRITICAL: Execute Business Logic (Mark booking paid, send email, etc.)
            // We use 'system' as the performedBy to attribute reconciled actions to the system
            await confirmPaymentSuccess(pi.id, 'system', 'System Reconciler');
            
            if (result.rows.length === 0) missingPayments++;
            else statusMismatches++;
          }
        }
      }

      hasMore = paymentIntents.has_more;
      if (hasMore && paymentIntents.data.length > 0) {
        startingAfter = paymentIntents.data[paymentIntents.data.length - 1].id;
      }
    }

    console.log(`[Reconcile] Complete - Checked: ${totalChecked}, Missing: ${missingPayments}, Status mismatches fixed: ${statusMismatches}`);
    
    return {
      totalChecked,
      missingPayments,
      statusMismatches
    };
  } catch (error) {
    console.error('[Reconcile] Error during reconciliation:', error);
    throw error;
  }
}

export async function reconcileSubscriptions() {
  console.log('[Reconcile] Starting subscription reconciliation...');
  
  try {
    const stripe = await getStripeClient();
    
    const activeMembers = await pool.query(
      `SELECT stripe_customer_id, email, tier 
       FROM users 
       WHERE stripe_customer_id IS NOT NULL 
       AND status = 'active'`
    );

    let mismatches = 0;
    
    for (const member of activeMembers.rows) {
      if (!member.stripe_customer_id) continue;
      
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: member.stripe_customer_id,
          status: 'active',
          limit: 1
        });

        if (subscriptions.data.length === 0) {
          console.warn(`[Reconcile] Active member ${member.email} has no active Stripe subscription`);
          mismatches++;
        }
      } catch (err: any) {
        if (err.code !== 'resource_missing') {
          console.error(`[Reconcile] Error checking subscription for ${member.email}:`, err.message);
        }
      }
    }

    console.log(`[Reconcile] Subscription check complete - ${activeMembers.rows.length} members checked, ${mismatches} mismatches found`);
    
    return { membersChecked: activeMembers.rows.length, mismatches };
  } catch (error) {
    console.error('[Reconcile] Error during subscription reconciliation:', error);
    throw error;
  }
}
