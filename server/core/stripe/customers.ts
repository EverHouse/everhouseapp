import { pool } from '../db';
import { getStripeClient } from './client';
import { alertOnExternalServiceError } from '../errorAlerts';

const PLACEHOLDER_EMAIL_PATTERNS = [
  '@visitors.evenhouse.club',
  '@trackman.local',
  '@trackman.import',
  'unmatched-',
  'unmatched@',
  'golfnow-',
  'classpass-',
  'lesson-',
  'anonymous-',
  'private-event@',
  '@resolved',
  '@placeholder.',
  '@test.local',
  '@example.com'
];

export function isPlaceholderEmail(email: string): boolean {
  if (!email) return true;
  const lowerEmail = email.toLowerCase();
  return PLACEHOLDER_EMAIL_PATTERNS.some(pattern => lowerEmail.includes(pattern));
}

export async function getOrCreateStripeCustomer(
  userId: string,
  email: string,
  name?: string,
  tier?: string
): Promise<{ customerId: string; isNew: boolean }> {
  // Prevent creating Stripe customers for placeholder emails
  if (isPlaceholderEmail(email)) {
    console.log(`[Stripe] Skipping customer creation for placeholder email: ${email}`);
    throw new Error(`Cannot create Stripe customer for placeholder email: ${email}`);
  }
  
  const userResult = await pool.query(
    'SELECT stripe_customer_id, tier, first_name, last_name FROM users WHERE id = $1',
    [userId]
  );
  
  const userTier = tier || userResult.rows[0]?.tier;
  const resolvedName = name || (userResult.rows[0]?.first_name && userResult.rows[0]?.last_name
    ? `${userResult.rows[0].first_name} ${userResult.rows[0].last_name}`.trim()
    : userResult.rows[0]?.first_name || undefined);
  
  if (userResult.rows[0]?.stripe_customer_id) {
    const existingCustomerId = userResult.rows[0].stripe_customer_id;
    try {
      const stripeForValidation = await getStripeClient();
      await stripeForValidation.customers.retrieve(existingCustomerId);
      return { customerId: existingCustomerId, isNew: false };
    } catch (validationError: any) {
      if (validationError.code === 'resource_missing') {
        console.warn(`[Stripe] Stored customer ${existingCustomerId} no longer exists in Stripe for user ${userId}, clearing and re-creating`);
        await pool.query('UPDATE users SET stripe_customer_id = NULL WHERE id = $1', [userId]);
      } else {
        return { customerId: existingCustomerId, isNew: false };
      }
    }
  }

  const linkedEmailsResult = await pool.query(
    `SELECT linked_email FROM user_linked_emails WHERE LOWER(primary_email) = LOWER($1)`,
    [email]
  );
  const linkedEmails = linkedEmailsResult.rows.map((r: any) => r.linked_email.toLowerCase());
  const allEmails = [email.toLowerCase(), ...linkedEmails];
  const uniqueEmails = [...new Set(allEmails)];

  const existingFromLinkedResult = await pool.query(
    `SELECT u.stripe_customer_id, u.email,
            CASE WHEN LOWER(u.email) = $2 THEN 0 ELSE 1 END as priority
     FROM users u 
     WHERE u.stripe_customer_id IS NOT NULL 
       AND (LOWER(u.email) = ANY($1) 
            OR EXISTS (SELECT 1 FROM user_linked_emails ule 
                       WHERE LOWER(ule.primary_email) = LOWER(u.email) 
                       AND LOWER(ule.linked_email) = ANY($1)))
     ORDER BY priority ASC, u.created_at DESC
     LIMIT 1`,
    [uniqueEmails, email.toLowerCase()]
  );
  
  if (existingFromLinkedResult.rows[0]?.stripe_customer_id) {
    const existingCustomerId = existingFromLinkedResult.rows[0].stripe_customer_id;
    console.log(`[Stripe] Found existing customer ${existingCustomerId} via linked email for user ${userId}`);
    
    await pool.query(
      'UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2',
      [existingCustomerId, userId]
    );
    
    return { customerId: existingCustomerId, isNew: false };
  }

  let stripe;
  try {
    stripe = await getStripeClient();
  } catch (error: any) {
    console.error('[Stripe] Failed to get Stripe client:', error);
    await alertOnExternalServiceError('Stripe', error, 'initialize Stripe client');
    throw error;
  }
  
  let foundCustomerId: string | null = null;
  let foundViaEmail: string | null = null;
  const stripeErrors: Array<{ email: string; error: string }> = [];
  
  for (const searchEmail of uniqueEmails) {
    try {
      const existingCustomers = await stripe.customers.list({
        email: searchEmail,
        limit: 10
      });
      if (existingCustomers.data.length > 0) {
        const sortedCustomers = existingCustomers.data.sort((a, b) => b.created - a.created);
        const primaryEmailMatch = sortedCustomers.find(c => 
          c.email?.toLowerCase() === email.toLowerCase()
        );
        const selectedCustomer = primaryEmailMatch || sortedCustomers[0];
        
        foundCustomerId = selectedCustomer.id;
        foundViaEmail = searchEmail;
        console.log(`[Stripe] Found existing customer ${foundCustomerId} in Stripe via email ${searchEmail} (preferred: ${primaryEmailMatch ? 'primary match' : 'most recent'})`);
        
        if (existingCustomers.data.length > 1) {
          console.warn(`[Stripe] Multiple customers found for ${searchEmail}: ${existingCustomers.data.map(c => c.id).join(', ')} - selected ${foundCustomerId}`);
        }
        break;
      }
    } catch (error: any) {
      const isRateLimitOrNetwork = error.type === 'StripeRateLimitError' || 
        error.type === 'StripeConnectionError' ||
        error.code === 'ECONNREFUSED';
      
      stripeErrors.push({ email: searchEmail, error: error.message });
      
      if (isRateLimitOrNetwork) {
        console.error(`[Stripe] Critical error searching for customer ${searchEmail}, aborting to prevent duplicates:`, error);
        await alertOnExternalServiceError('Stripe', error, `search for customer by email ${searchEmail}`);
        throw new Error(`Stripe unavailable while searching for existing customers - cannot safely create new customer: ${error.message}`);
      }
      
      console.warn(`[Stripe] Non-critical error searching for customer by email ${searchEmail}:`, error.message);
    }
  }
  
  if (stripeErrors.length === uniqueEmails.length && uniqueEmails.length > 0) {
    console.error(`[Stripe] All email searches failed, cannot safely create customer`);
    throw new Error(`Failed to search Stripe for existing customers across all emails: ${stripeErrors.map(e => e.error).join('; ')}`);
  }

  let customerId: string;
  let isNew = false;

  const metadata: Record<string, string> = {
    userId: userId,
    source: 'even_house_app',
    primaryEmail: email.toLowerCase()
  };
  if (userTier) {
    metadata.tier = userTier;
  }
  if (linkedEmails.length > 0) {
    metadata.linkedEmails = linkedEmails.slice(0, 5).join(',');
  }

  try {
    if (foundCustomerId) {
      customerId = foundCustomerId;
      await stripe.customers.update(customerId, {
        metadata: metadata,
        name: resolvedName || undefined,
        email: email.toLowerCase()
      });
      console.log(`[Stripe] Updated metadata for existing customer ${customerId}, set primary email to ${email}`);
    } else {
      const customer = await stripe.customers.create({
        email: email.toLowerCase(),
        name: resolvedName || undefined,
        metadata: metadata
      });
      customerId = customer.id;
      isNew = true;
    }
  } catch (error: any) {
    console.error('[Stripe] Failed to create/update customer:', error);
    await alertOnExternalServiceError('Stripe', error, 'create or update customer');
    throw error;
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
    await alertOnExternalServiceError('Stripe', error, 'sync customer metadata');
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
