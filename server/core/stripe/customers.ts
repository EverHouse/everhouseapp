import { pool } from '../db';
import { getStripeClient } from './client';

export async function getOrCreateStripeCustomer(
  userId: string,
  email: string,
  name?: string,
  tier?: string
): Promise<{ customerId: string; isNew: boolean }> {
  const userResult = await pool.query(
    'SELECT stripe_customer_id, tier FROM users WHERE id = $1',
    [userId]
  );
  
  const userTier = tier || userResult.rows[0]?.tier;
  
  if (userResult.rows[0]?.stripe_customer_id) {
    return { customerId: userResult.rows[0].stripe_customer_id, isNew: false };
  }

  const stripe = await getStripeClient();
  
  const existingCustomers = await stripe.customers.list({
    email: email.toLowerCase(),
    limit: 1
  });

  let customerId: string;
  let isNew = false;

  const metadata: Record<string, string> = {
    userId: userId,
    source: 'even_house_app'
  };
  if (userTier) {
    metadata.tier = userTier;
  }

  if (existingCustomers.data.length > 0) {
    customerId = existingCustomers.data[0].id;
    await stripe.customers.update(customerId, {
      metadata: metadata,
      name: name || existingCustomers.data[0].name || undefined
    });
    console.log(`[Stripe] Updated metadata for existing customer ${customerId}`);
  } else {
    const customer = await stripe.customers.create({
      email: email.toLowerCase(),
      name: name || undefined,
      metadata: metadata
    });
    customerId = customer.id;
    isNew = true;
  }

  await pool.query(
    'UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2',
    [customerId, userId]
  );

  console.log(`[Stripe] ${isNew ? 'Created' : 'Linked existing'} customer ${customerId} for user ${userId}`);
  
  return { customerId, isNew };
}

export async function getStripeCustomerByEmail(email: string): Promise<string | null> {
  const result = await pool.query(
    'SELECT stripe_customer_id FROM users WHERE LOWER(email) = $1 AND stripe_customer_id IS NOT NULL',
    [email.toLowerCase()]
  );
  
  return result.rows[0]?.stripe_customer_id || null;
}

export async function updateCustomerPaymentMethod(
  customerId: string,
  paymentMethodId: string
): Promise<void> {
  const stripe = await getStripeClient();
  
  await stripe.paymentMethods.attach(paymentMethodId, {
    customer: customerId,
  });

  await stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  });

  console.log(`[Stripe] Updated default payment method for customer ${customerId}`);
}

export async function syncCustomerMetadataToStripe(
  email: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const userResult = await pool.query(
      'SELECT id, tier, stripe_customer_id, first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    
    if (userResult.rows.length === 0) {
      return { success: false, error: 'User not found' };
    }
    
    const user = userResult.rows[0];
    if (!user.stripe_customer_id) {
      return { success: false, error: 'No Stripe customer linked' };
    }
    
    const stripe = await getStripeClient();
    
    const metadata: Record<string, string> = {
      userId: user.id,
      source: 'even_house_app'
    };
    if (user.tier) {
      metadata.tier = user.tier;
    }
    
    const updateParams: any = { metadata };
    if (user.first_name || user.last_name) {
      updateParams.name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    }
    
    await stripe.customers.update(user.stripe_customer_id, updateParams);
    
    console.log(`[Stripe] Synced metadata for customer ${user.stripe_customer_id} (tier: ${user.tier})`);
    return { success: true };
  } catch (error: any) {
    console.error('[Stripe] Failed to sync customer metadata:', error);
    return { success: false, error: error.message };
  }
}

export async function syncAllCustomerMetadata(): Promise<{ synced: number; failed: number }> {
  const result = await pool.query(
    'SELECT id, email, tier, stripe_customer_id, first_name, last_name FROM users WHERE stripe_customer_id IS NOT NULL'
  );
  
  let synced = 0;
  let failed = 0;
  
  const stripe = await getStripeClient();
  
  for (const user of result.rows) {
    try {
      const metadata: Record<string, string> = {
        userId: user.id,
        source: 'even_house_app'
      };
      if (user.tier) {
        metadata.tier = user.tier;
      }
      
      const updateParams: any = { metadata };
      if (user.first_name || user.last_name) {
        updateParams.name = [user.first_name, user.last_name].filter(Boolean).join(' ');
      }
      
      await stripe.customers.update(user.stripe_customer_id, updateParams);
      synced++;
    } catch (error: any) {
      console.error(`[Stripe] Failed to sync metadata for ${user.email}:`, error.message);
      failed++;
    }
  }
  
  console.log(`[Stripe] Bulk metadata sync complete: ${synced} synced, ${failed} failed`);
  return { synced, failed };
}
