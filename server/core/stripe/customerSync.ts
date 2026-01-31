import { pool } from '../db';
import { getStripeClient } from './client';
import { isPlaceholderEmail } from './customers';

export interface CustomerSyncResult {
  success: boolean;
  created: number;
  linked: number;
  skipped: number;
  errors: string[];
  details: Array<{
    email: string;
    action: 'created' | 'linked' | 'skipped' | 'error';
    customerId?: string;
    reason?: string;
  }>;
}

export async function syncStripeCustomersForMindBodyMembers(): Promise<CustomerSyncResult> {
  const result: CustomerSyncResult = {
    success: true,
    created: 0,
    linked: 0,
    skipped: 0,
    errors: [],
    details: [],
  };

  try {
    const stripe = await getStripeClient();
    
    console.log('[Stripe Customer Sync] Starting sync for MindBody members...');
    
    const membersResult = await pool.query(`
      SELECT id, email, first_name, last_name, tier, stripe_customer_id
      FROM users
      WHERE billing_provider = 'mindbody'
        AND tier IS NOT NULL 
        AND tier != ''
        AND stripe_customer_id IS NULL
        AND email IS NOT NULL
        AND email != ''
      ORDER BY email
    `);
    
    const members = membersResult.rows;
    console.log(`[Stripe Customer Sync] Found ${members.length} MindBody members without Stripe customer ID`);
    
    if (members.length === 0) {
      console.log('[Stripe Customer Sync] All MindBody members already have Stripe customers');
      return result;
    }
    
    for (const member of members) {
      try {
        // Skip placeholder emails
        if (isPlaceholderEmail(member.email)) {
          console.log(`[Stripe Customer Sync] Skipping placeholder email: ${member.email}`);
          result.skipped++;
          result.details.push({ email: member.email, action: 'skipped', reason: 'placeholder_email' });
          continue;
        }
        
        const existingCustomers = await stripe.customers.list({
          email: member.email.toLowerCase(),
          limit: 1
        });
        
        let customerId: string;
        let action: 'created' | 'linked';
        
        if (existingCustomers.data.length > 0) {
          customerId = existingCustomers.data[0].id;
          action = 'linked';
          result.linked++;
          console.log(`[Stripe Customer Sync] Linked existing customer ${customerId} for ${member.email}`);
        } else {
          const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
          const customer = await stripe.customers.create({
            email: member.email.toLowerCase(),
            name: fullName,
            metadata: {
              source: 'mindbody_presync',
              tier: member.tier || '',
              userId: member.id,
            }
          });
          customerId = customer.id;
          action = 'created';
          result.created++;
          console.log(`[Stripe Customer Sync] Created customer ${customerId} for ${member.email}`);
        }
        
        await pool.query(
          `UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2`,
          [customerId, member.id]
        );
        
        result.details.push({
          email: member.email,
          action,
          customerId,
        });
        
      } catch (error: any) {
        console.error(`[Stripe Customer Sync] Error for ${member.email}:`, error.message);
        result.errors.push(`${member.email}: ${error.message}`);
        result.details.push({
          email: member.email,
          action: 'error',
          reason: error.message,
        });
      }
    }
    
    console.log(`[Stripe Customer Sync] Completed: created=${result.created}, linked=${result.linked}, errors=${result.errors.length}`);
    
  } catch (error: any) {
    console.error('[Stripe Customer Sync] Fatal error:', error);
    result.success = false;
    result.errors.push(`Fatal: ${error.message}`);
  }
  
  return result;
}

export async function getCustomerSyncStatus(): Promise<{
  needsSync: number;
  alreadySynced: number;
  total: number;
}> {
  const result = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE stripe_customer_id IS NULL) as needs_sync,
      COUNT(*) FILTER (WHERE stripe_customer_id IS NOT NULL) as already_synced,
      COUNT(*) as total
    FROM users
    WHERE billing_provider = 'mindbody'
      AND tier IS NOT NULL 
      AND tier != ''
  `);
  
  return {
    needsSync: parseInt(result.rows[0].needs_sync) || 0,
    alreadySynced: parseInt(result.rows[0].already_synced) || 0,
    total: parseInt(result.rows[0].total) || 0,
  };
}
