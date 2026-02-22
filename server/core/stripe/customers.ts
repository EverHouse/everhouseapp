import Stripe from 'stripe';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getStripeClient } from './client';
import { alertOnExternalServiceError } from '../errorAlerts';
import { getErrorMessage, getErrorCode, isStripeError } from '../../utils/errorUtils';

import { logger } from '../logger';
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

export interface ResolvedUser {
  userId: string;
  primaryEmail: string;
  stripeCustomerId: string | null;
  membershipStatus: string | null;
  tier: string | null;
  firstName: string | null;
  lastName: string | null;
  matchType: 'direct' | 'linked_email' | 'manually_linked';
}

export async function resolveUserByEmail(email: string): Promise<ResolvedUser | null> {
  if (!email || isPlaceholderEmail(email)) return null;

  const normalizedEmail = email.trim().toLowerCase();

  const directMatch = await db.execute(sql`SELECT id, email, stripe_customer_id, membership_status, tier, first_name, last_name
     FROM users WHERE LOWER(email) = ${normalizedEmail} AND archived_at IS NULL`);
  if (directMatch.rows.length > 0) {
    const u = directMatch.rows[0] as Record<string, unknown>;
    return {
      userId: u.id,
      primaryEmail: u.email,
      stripeCustomerId: u.stripe_customer_id,
      membershipStatus: u.membership_status,
      tier: u.tier,
      firstName: u.first_name,
      lastName: u.last_name,
      matchType: 'direct',
    };
  }

  try {
    const linkedMatch = await db.execute(sql`SELECT u.id, u.email, u.stripe_customer_id, u.membership_status, u.tier, u.first_name, u.last_name
       FROM user_linked_emails ule
       INNER JOIN users u ON LOWER(u.email) = LOWER(ule.primary_email)
       WHERE LOWER(ule.linked_email) = ${normalizedEmail} AND u.archived_at IS NULL
       LIMIT 1`);
    if (linkedMatch.rows.length > 0) {
      const u = linkedMatch.rows[0] as Record<string, unknown>;
      return {
        userId: u.id,
        primaryEmail: u.email,
        stripeCustomerId: u.stripe_customer_id,
        membershipStatus: u.membership_status,
        tier: u.tier,
        firstName: u.first_name,
        lastName: u.last_name,
        matchType: 'linked_email',
      };
    }
  } catch (err: unknown) {
    logger.error(`[resolveUserByEmail] Error checking linked emails for ${normalizedEmail}:`, { extra: { detail: getErrorMessage(err) } });
  }

  try {
    const manualMatch = await db.execute(sql`SELECT id, email, stripe_customer_id, membership_status, tier, first_name, last_name
       FROM users
       WHERE COALESCE(manually_linked_emails, '[]'::jsonb) @> ${JSON.stringify([normalizedEmail])}::jsonb
         AND archived_at IS NULL
       LIMIT 1`);
    if (manualMatch.rows.length > 0) {
      const u = manualMatch.rows[0] as Record<string, unknown>;
      return {
        userId: u.id,
        primaryEmail: u.email,
        stripeCustomerId: u.stripe_customer_id,
        membershipStatus: u.membership_status,
        tier: u.tier,
        firstName: u.first_name,
        lastName: u.last_name,
        matchType: 'manually_linked',
      };
    }
  } catch (err: unknown) {
    logger.error(`[resolveUserByEmail] Error checking manually linked emails for ${normalizedEmail}:`, { extra: { detail: getErrorMessage(err) } });
  }

  return null;
}

export async function getOrCreateStripeCustomer(
  userId: string,
  email: string,
  name?: string,
  tier?: string
): Promise<{ customerId: string; isNew: boolean }> {
  // Prevent creating Stripe customers for placeholder emails
  if (isPlaceholderEmail(email)) {
    logger.info(`[Stripe] Skipping customer creation for placeholder email: ${email}`);
    throw new Error(`Cannot create Stripe customer for placeholder email: ${email}`);
  }
  
  const userResult = await db.execute(sql`SELECT stripe_customer_id, tier, first_name, last_name, email, phone, archived_at FROM users WHERE id = ${userId}`);
  
  const userRow = (userResult.rows as Array<Record<string, unknown>>)[0];
  const userTier = tier || userRow?.tier;
  const resolvedName = name || (userRow?.first_name && userRow?.last_name
    ? `${userRow.first_name} ${userRow.last_name}`.trim()
    : (userRow?.first_name as string) || undefined);
  
  if (userRow?.stripe_customer_id) {
    const existingCustomerId = userRow.stripe_customer_id as string;
    try {
      const stripeForValidation = await getStripeClient();
      const existingCustomer = await stripeForValidation.customers.retrieve(existingCustomerId);
      
      const firstName = userRow?.first_name;
      const lastName = userRow?.last_name;
      
      // Update metadata and name if missing
      const cust = existingCustomer as Stripe.Customer | Stripe.DeletedCustomer;
      const needsUpdate = !('deleted' in cust && cust.deleted) && (
        !('metadata' in cust && cust.metadata?.userId) ||
        !('name' in cust && cust.name) ||
        (userTier && 'metadata' in cust && cust.metadata?.tier !== userTier) ||
        (firstName && !('metadata' in cust && cust.metadata?.firstName)) ||
        (lastName && !('metadata' in cust && cust.metadata?.lastName))
      );
      
      if (needsUpdate) {
        const updateMetadata: Record<string, string> = {
          userId: userId,
          source: 'even_house_app',
          primaryEmail: email.toLowerCase(),
        };
        if (userTier) updateMetadata.tier = userTier;
        if (firstName) updateMetadata.firstName = firstName;
        if (lastName) updateMetadata.lastName = lastName;
        
        const userPhone = userRow?.phone;
        await stripeForValidation.customers.update(existingCustomerId, {
          metadata: updateMetadata,
          ...(resolvedName && !('name' in existingCustomer && existingCustomer.name) ? { name: resolvedName } : {}),
          ...(userPhone && !('phone' in existingCustomer && existingCustomer.phone) ? { phone: userPhone } : {}),
        });
        logger.info(`[Stripe] Updated metadata for existing customer ${existingCustomerId}`);
      }
      
      return { customerId: existingCustomerId, isNew: false };
    } catch (validationError: unknown) {
      if (getErrorCode(validationError) === 'resource_missing') {
        logger.warn(`[Stripe] Stored customer ${existingCustomerId} no longer exists in Stripe for user ${userId}, clearing and re-creating`);
        await db.execute(sql`UPDATE users SET stripe_customer_id = NULL WHERE id = ${userId}`);
      } else {
        return { customerId: existingCustomerId, isNew: false };
      }
    }
  }

  const linkedEmailsResult = await db.execute(sql`SELECT linked_email FROM user_linked_emails WHERE LOWER(primary_email) = LOWER(${email})`);
  const linkedEmails = linkedEmailsResult.rows.map((r: Record<string, unknown>) => (r.linked_email as string).toLowerCase());
  const allEmails = [email.toLowerCase(), ...linkedEmails];
  const uniqueEmails = [...new Set(allEmails)];

  const existingFromLinkedResult = await db.execute(sql`SELECT u.stripe_customer_id, u.email,
            CASE WHEN LOWER(u.email) = ${email.toLowerCase()} THEN 0 ELSE 1 END as priority
     FROM users u 
     WHERE u.stripe_customer_id IS NOT NULL 
       AND (LOWER(u.email) = ANY(${uniqueEmails}) 
            OR EXISTS (SELECT 1 FROM user_linked_emails ule 
                       WHERE LOWER(ule.primary_email) = LOWER(u.email) 
                       AND LOWER(ule.linked_email) = ANY(${uniqueEmails})))
     ORDER BY priority ASC, u.created_at DESC
     LIMIT 1`);
  
  if (existingFromLinkedResult.rows[0]?.stripe_customer_id) {
    const existingCustomerId = existingFromLinkedResult.rows[0].stripe_customer_id;
    try {
      const stripeForValidation = await getStripeClient();
      await stripeForValidation.customers.retrieve(existingCustomerId);
      logger.info(`[Stripe] Found existing customer ${existingCustomerId} via linked email for user ${userId}`);
      
      await db.execute(sql`UPDATE users SET stripe_customer_id = ${existingCustomerId}, archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = ${userId}`);
      if (userRow?.archived_at) {
        logger.info(`[Auto-Unarchive] User ${email} unarchived after receiving Stripe customer ID`);
      }
      
      return { customerId: existingCustomerId, isNew: false };
    } catch (validationError: unknown) {
      if (getErrorCode(validationError) === 'resource_missing') {
        logger.warn(`[Stripe] Stale linked customer ${existingCustomerId} for ${email} — clearing and creating new`);
        await db.execute(sql`UPDATE users SET stripe_customer_id = NULL WHERE stripe_customer_id = ${existingCustomerId}`);
      } else {
        logger.info(`[Stripe] Found existing customer ${existingCustomerId} via linked email for user ${userId}`);
        await db.execute(sql`UPDATE users SET stripe_customer_id = ${existingCustomerId}, archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = ${userId}`);
        if (userRow?.archived_at) {
          logger.info(`[Auto-Unarchive] User ${email} unarchived after receiving Stripe customer ID`);
        }
        return { customerId: existingCustomerId, isNew: false };
      }
    }
  }

  const hubspotResult = await db.execute(sql`SELECT u.stripe_customer_id, u.email, u.hubspot_id 
     FROM users u 
     WHERE u.id = ${userId} AND u.hubspot_id IS NOT NULL`);

  if (hubspotResult.rows[0]?.hubspot_id) {
    const hubspotMatchResult = await db.execute(sql`SELECT u.stripe_customer_id, u.email
       FROM users u
       WHERE u.hubspot_id = ${hubspotResult.rows[0].hubspot_id}
         AND u.id != ${userId}
         AND u.stripe_customer_id IS NOT NULL
         AND u.archived_at IS NULL
       ORDER BY u.membership_status = 'active' DESC, u.lifetime_visits DESC
       LIMIT 1`);

    if (hubspotMatchResult.rows[0]?.stripe_customer_id) {
      const existingCustomerId = hubspotMatchResult.rows[0].stripe_customer_id;
      try {
        const stripeForValidation = await getStripeClient();
        await stripeForValidation.customers.retrieve(existingCustomerId);
        logger.info(`[Stripe] Found existing customer ${existingCustomerId} via HubSpot ID match for user ${userId} (matched user: ${hubspotMatchResult.rows[0].email})`);
        
        await db.execute(sql`UPDATE users SET stripe_customer_id = ${existingCustomerId}, archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = ${userId}`);
        if (userRow?.archived_at) {
          logger.info(`[Auto-Unarchive] User ${email} unarchived after receiving Stripe customer ID`);
        }
        
        return { customerId: existingCustomerId, isNew: false };
      } catch (validationError: unknown) {
        if (getErrorCode(validationError) === 'resource_missing') {
          logger.warn(`[Stripe] Stale HubSpot-matched customer ${existingCustomerId} for ${email} — clearing and creating new`);
          await db.execute(sql`UPDATE users SET stripe_customer_id = NULL WHERE stripe_customer_id = ${existingCustomerId}`);
        } else {
          logger.info(`[Stripe] Found existing customer ${existingCustomerId} via HubSpot ID match for user ${userId}`);
          await db.execute(sql`UPDATE users SET stripe_customer_id = ${existingCustomerId}, archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = ${userId}`);
          if (userRow?.archived_at) {
            logger.info(`[Auto-Unarchive] User ${email} unarchived after receiving Stripe customer ID`);
          }
          return { customerId: existingCustomerId, isNew: false };
        }
      }
    }
  }

  let stripe;
  try {
    stripe = await getStripeClient();
  } catch (error: unknown) {
    logger.error('[Stripe] Failed to get Stripe client:', { error: error });
    await alertOnExternalServiceError('Stripe', error as Error, 'initialize Stripe client');
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
        logger.info(`[Stripe] Found existing customer ${foundCustomerId} in Stripe via email ${searchEmail} (preferred: ${primaryEmailMatch ? 'primary match' : 'most recent'})`);
        
        if (existingCustomers.data.length > 1) {
          logger.warn(`[Stripe] Multiple customers found for ${searchEmail}: ${existingCustomers.data.map(c => c.id).join(', ')} - selected ${foundCustomerId}`);
        }
        break;
      }
    } catch (error: unknown) {
      const isRateLimitOrNetwork = isStripeError(error) && (error.type === 'StripeRateLimitError' || 
        error.type === 'StripeConnectionError') ||
        getErrorCode(error) === 'ECONNREFUSED';
      
      stripeErrors.push({ email: searchEmail, error: getErrorMessage(error) });
      
      if (isRateLimitOrNetwork) {
        logger.error(`[Stripe] Critical error searching for customer ${searchEmail}, aborting to prevent duplicates:`, { error: error });
        await alertOnExternalServiceError('Stripe', error as Error, `search for customer by email ${searchEmail}`);
        throw new Error(`Stripe unavailable while searching for existing customers - cannot safely create new customer: ${getErrorMessage(error)}`);
      }
      
      logger.warn(`[Stripe] Non-critical error searching for customer by email ${searchEmail}:`, { extra: { detail: getErrorMessage(error) } });
    }
  }
  
  if (stripeErrors.length === uniqueEmails.length && uniqueEmails.length > 0) {
    logger.error(`[Stripe] All email searches failed, cannot safely create customer`);
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
  const firstName = userRow?.first_name;
  const lastName = userRow?.last_name;
  if (firstName) metadata.firstName = firstName;
  if (lastName) metadata.lastName = lastName;
  if (linkedEmails.length > 0) {
    metadata.linkedEmails = linkedEmails.slice(0, 5).join(',');
  }

  try {
    const userPhone = userRow?.phone;

    if (foundCustomerId) {
      customerId = foundCustomerId;
      await stripe.customers.update(customerId, {
        metadata: metadata,
        name: resolvedName || undefined,
        email: email.toLowerCase(),
        ...(userPhone ? { phone: userPhone } : {}),
      });
      logger.info(`[Stripe] Updated metadata for existing customer ${customerId}, set primary email to ${email}`);
    } else {
      const customer = await stripe.customers.create({
        email: email.toLowerCase(),
        name: resolvedName || undefined,
        metadata: metadata,
        ...(userPhone ? { phone: userPhone } : {}),
      });
      customerId = customer.id;
      isNew = true;
    }
  } catch (error: unknown) {
    logger.error('[Stripe] Failed to create/update customer:', { error: error });
    await alertOnExternalServiceError('Stripe', error as Error, 'create or update customer');
    throw error;
  }

  await db.execute(sql`UPDATE users SET stripe_customer_id = ${customerId}, archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = ${userId}`);
  if (userRow?.archived_at) {
    logger.info(`[Auto-Unarchive] User ${email} unarchived after receiving Stripe customer ID`);
  }

  logger.info(`[Stripe] ${isNew ? 'Created' : 'Linked existing'} customer ${customerId} for user ${userId}`);
  
  return { customerId, isNew };
}

export async function getStripeCustomerByEmail(email: string): Promise<string | null> {
  const result = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = ${email.toLowerCase()} AND stripe_customer_id IS NOT NULL`);
  
  return (result.rows as Array<Record<string, unknown>>)[0]?.stripe_customer_id as string || null;
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

  logger.info(`[Stripe] Updated default payment method for customer ${customerId}`);
}

export async function syncCustomerMetadataToStripe(
  email: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const userResult = await db.execute(sql`SELECT id, tier, stripe_customer_id, first_name, last_name, phone FROM users WHERE LOWER(email) = LOWER(${email})`);
    
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
    if (user.first_name) metadata.firstName = user.first_name;
    if (user.last_name) metadata.lastName = user.last_name;
    
    const updateParams: Stripe.CustomerUpdateParams = { metadata };
    if (user.first_name || user.last_name) {
      updateParams.name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    }
    if (user.phone) {
      updateParams.phone = user.phone;
    }
    
    await stripe.customers.update(user.stripe_customer_id, updateParams);
    
    logger.info(`[Stripe] Synced metadata for customer ${user.stripe_customer_id} (tier: ${user.tier})`);
    return { success: true };
  } catch (error: unknown) {
    logger.error('[Stripe] Failed to sync customer metadata:', { error: error });
    await alertOnExternalServiceError('Stripe', error as Error, 'sync customer metadata');
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function syncAllCustomerMetadata(): Promise<{ synced: number; failed: number }> {
  const result = await db.execute(sql`SELECT id, email, tier, stripe_customer_id, first_name, last_name, phone FROM users WHERE stripe_customer_id IS NOT NULL`);
  
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
      if (user.first_name) metadata.firstName = user.first_name;
      if (user.last_name) metadata.lastName = user.last_name;
      
      const updateParams: Stripe.CustomerUpdateParams = { metadata };
      if (user.first_name || user.last_name) {
        updateParams.name = [user.first_name, user.last_name].filter(Boolean).join(' ');
      }
      if (user.phone) {
        updateParams.phone = user.phone;
      }
      
      await stripe.customers.update(user.stripe_customer_id, updateParams);
      synced++;
    } catch (error: unknown) {
      logger.error(`[Stripe] Failed to sync metadata for ${user.email}:`, { extra: { detail: getErrorMessage(error) } });
      failed++;
    }
  }
  
  logger.info(`[Stripe] Bulk metadata sync complete: ${synced} synced, ${failed} failed`);
  return { synced, failed };
}
