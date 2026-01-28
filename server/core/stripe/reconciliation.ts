import { pool } from '../db';
import { getStripeClient } from './client';
import { confirmPaymentSuccess } from './payments';
import { findOrCreateHubSpotContact } from '../hubspot/members';
import { updateContactMembershipStatus } from '../hubspot/stages';
import Stripe from 'stripe';

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
    
    // Phase 1: Check if DB active/trialing/past_due members have corresponding Stripe subscriptions
    // Include trialing and past_due as active - they still have membership access
    const activeMembers = await pool.query(
      `SELECT stripe_customer_id, email, tier, membership_status 
       FROM users 
       WHERE stripe_customer_id IS NOT NULL 
       AND (membership_status IN ('active', 'trialing', 'past_due') OR stripe_subscription_id IS NOT NULL)`
    );

    let mismatches = 0;
    
    for (const member of activeMembers.rows) {
      if (!member.stripe_customer_id) continue;
      
      try {
        // Check for any active-ish subscription status
        const subscriptions = await stripe.subscriptions.list({
          customer: member.stripe_customer_id,
          limit: 10
        });
        
        const hasActiveSubscription = subscriptions.data.some(s => 
          ['active', 'trialing', 'past_due'].includes(s.status)
        );

        if (!hasActiveSubscription) {
          console.warn(`[Reconcile] Member ${member.email} (status: ${member.membership_status}) has no active Stripe subscription`);
          mismatches++;
        }
      } catch (err: any) {
        if (err.code !== 'resource_missing') {
          console.error(`[Reconcile] Error checking subscription for ${member.email}:`, err.message);
        }
      }
    }

    console.log(`[Reconcile] Phase 1 complete - ${activeMembers.rows.length} members checked, ${mismatches} mismatches found`);
    
    // Phase 2: Check for Stripe subscriptions missing DB users
    console.log('[Reconcile] Phase 2: Checking for Stripe subscriptions missing DB users...');
    
    let subscriptionsChecked = 0;
    let usersCreated = 0;
    let hasMore = true;
    let startingAfter: string | undefined;
    
    // Include trialing and past_due - members still have access during these states
    for (const status of ['active', 'trialing', 'past_due'] as const) {
    hasMore = true;
    startingAfter = undefined;
    
    while (hasMore) {
      const params: Stripe.SubscriptionListParams = {
        status,
        limit: 100,
        expand: ['data.customer']
      };
      if (startingAfter) {
        params.starting_after = startingAfter;
      }
      
      const subscriptions = await stripe.subscriptions.list(params);
      
      for (const subscription of subscriptions.data) {
        subscriptionsChecked++;
        
        try {
          let customer: Stripe.Customer;
          
          // Handle case where customer is not expanded (returns as string ID)
          if (typeof subscription.customer === 'string') {
            try {
              const fetchedCustomer = await stripe.customers.retrieve(subscription.customer);
              if (!fetchedCustomer || (fetchedCustomer as Stripe.DeletedCustomer).deleted) {
                console.warn(`[Reconcile] Subscription ${subscription.id} has deleted customer - skipping`);
                continue;
              }
              customer = fetchedCustomer as Stripe.Customer;
            } catch (fetchErr: any) {
              console.warn(`[Reconcile] Failed to fetch customer for subscription ${subscription.id}: ${fetchErr.message}`);
              continue;
            }
          } else {
            customer = subscription.customer as Stripe.Customer;
            
            // Handle deleted customer
            if (!customer || customer.deleted) {
              console.warn(`[Reconcile] Subscription ${subscription.id} has deleted/missing customer - skipping`);
              continue;
            }
          }
          
          const customerEmail = customer.email?.toLowerCase();
          if (!customerEmail) {
            console.warn(`[Reconcile] Subscription ${subscription.id} customer ${customer.id} has no email - skipping`);
            continue;
          }
          
          // Check if user exists in DB
          const existingUser = await pool.query(
            'SELECT id, email, stripe_customer_id FROM users WHERE LOWER(email) = LOWER($1)',
            [customerEmail]
          );
          
          if (existingUser.rows.length > 0) {
            // User exists, ensure stripe_customer_id is set
            if (!existingUser.rows[0].stripe_customer_id) {
              await pool.query(
                `UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2`,
                [customer.id, existingUser.rows[0].id]
              );
              console.log(`[Reconcile] Updated missing stripe_customer_id for ${customerEmail}`);
            }
            continue;
          }
          
          // User doesn't exist - create them
          console.warn(`[Reconcile] MISSING USER: Stripe subscription ${subscription.id} for ${customerEmail} has no DB user - creating...`);
          
          const customerName = customer.name || '';
          const nameParts = customerName.split(' ');
          const firstName = nameParts[0] || '';
          const lastName = nameParts.slice(1).join(' ') || '';
          
          // Get tier from subscription price ID
          let tierSlug: string | null = null;
          let tierName: string | null = null;
          
          const subscriptionItem = subscription.items?.data?.[0];
          const priceId = subscriptionItem?.price?.id;
          
          if (priceId) {
            const tierResult = await pool.query(
              'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
              [priceId]
            );
            if (tierResult.rows.length > 0) {
              tierSlug = tierResult.rows[0].slug;
              tierName = tierResult.rows[0].name;
            }
          }
          
          // Create user in DB
          await pool.query(
            `INSERT INTO users (email, first_name, last_name, tier, membership_status, stripe_customer_id, stripe_subscription_id, join_date, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'active', $5, $6, NOW(), NOW(), NOW())
             ON CONFLICT (email) DO UPDATE SET 
               stripe_customer_id = EXCLUDED.stripe_customer_id,
               stripe_subscription_id = EXCLUDED.stripe_subscription_id,
               membership_status = 'active',
               tier = COALESCE(EXCLUDED.tier, users.tier),
               updated_at = NOW()`,
            [customerEmail, firstName, lastName, tierSlug, customer.id, subscription.id]
          );
          
          console.log(`[Reconcile] Created user ${customerEmail} with tier ${tierSlug || 'none'}, subscription ${subscription.id}`);
          usersCreated++;
          
          // Sync to HubSpot
          try {
            const { syncMemberToHubSpot } = await import('../hubspot/stages');
            await syncMemberToHubSpot({
              email: customerEmail,
              status: 'active',
              billingProvider: 'stripe',
              tier: tierName || undefined,
              memberSince: new Date()
            });
            console.log(`[Reconcile] Synced ${customerEmail} to HubSpot: status=active, tier=${tierName}, billing=stripe`);
          } catch (hubspotError) {
            console.error(`[Reconcile] HubSpot sync failed for ${customerEmail}:`, hubspotError);
          }
          
        } catch (err: any) {
          console.error(`[Reconcile] Error processing subscription ${subscription.id}:`, err.message);
        }
      }
      
      hasMore = subscriptions.has_more;
      if (hasMore && subscriptions.data.length > 0) {
        startingAfter = subscriptions.data[subscriptions.data.length - 1].id;
      }
    }
    } // end for loop over statuses
    
    console.log(`[Reconcile] Phase 2 complete - ${subscriptionsChecked} subscriptions checked, ${usersCreated} users created`);
    console.log(`[Reconcile] Subscription reconciliation complete`);
    
    return { 
      membersChecked: activeMembers.rows.length, 
      mismatches,
      subscriptionsChecked,
      usersCreated
    };
  } catch (error) {
    console.error('[Reconcile] Error during subscription reconciliation:', error);
    throw error;
  }
}
