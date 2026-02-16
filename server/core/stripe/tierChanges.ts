import { getStripeClient } from './client';
import { db } from '../../db';
import { membershipTiers, users, memberNotes } from '../../../shared/schema';
import { eq, ilike } from 'drizzle-orm';
import { changeSubscriptionTier } from './subscriptions';
import { pool } from '../db';
import { syncCustomerMetadataToStripe } from './customers';
import { getErrorMessage } from '../../utils/errorUtils';

export interface TierChangePreview {
  currentTier: string;
  currentPriceId: string;
  currentAmountCents: number;
  newTier: string;
  newPriceId: string;
  newAmountCents: number;
  prorationAmountCents: number;
  nextInvoiceAmountCents: number;
  effectiveDate: Date;
  isImmediate: boolean;
}

export async function previewTierChange(
  subscriptionId: string,
  newPriceId: string,
  immediate: boolean = true
): Promise<{ success: boolean; preview?: TierChangePreview; error?: string }> {
  try {
    const stripe = await getStripeClient();
    
    // Get current subscription
    const sub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price.product']
    });
    
    const currentItem = sub.items.data[0];
    const currentPrice = currentItem.price;
    const currentProduct = currentPrice.product as any;
    
    // Get new price details
    const newPrice = await stripe.prices.retrieve(newPriceId, { expand: ['product'] });
    const newProduct = newPrice.product as any;
    
    if (immediate) {
      // Use createPreview to preview proration (replaces deprecated retrieveUpcoming)
      const previewInvoice = await stripe.invoices.createPreview({
        customer: sub.customer as string,
        subscription: subscriptionId,
        subscription_details: {
          items: [{ id: currentItem.id, price: newPriceId }],
          proration_behavior: 'always_invoice',
        },
      });
      
      // Calculate proration from invoice line items
      let prorationAmount = 0;
      for (const line of previewInvoice.lines.data) {
        if ((line as any).proration) {
          prorationAmount += line.amount;
        }
      }
      
      return {
        success: true,
        preview: {
          currentTier: currentProduct.name,
          currentPriceId: currentPrice.id,
          currentAmountCents: currentPrice.unit_amount || 0,
          newTier: newProduct.name,
          newPriceId: newPriceId,
          newAmountCents: newPrice.unit_amount || 0,
          prorationAmountCents: prorationAmount,
          nextInvoiceAmountCents: previewInvoice.amount_due,
          effectiveDate: new Date(),
          isImmediate: true,
        }
      };
    } else {
      // End of cycle change - no proration
      return {
        success: true,
        preview: {
          currentTier: currentProduct.name,
          currentPriceId: currentPrice.id,
          currentAmountCents: currentPrice.unit_amount || 0,
          newTier: newProduct.name,
          newPriceId: newPriceId,
          newAmountCents: newPrice.unit_amount || 0,
          prorationAmountCents: 0,
          nextInvoiceAmountCents: newPrice.unit_amount || 0,
          effectiveDate: new Date((sub as any).current_period_end * 1000),
          isImmediate: false,
        }
      };
    }
  } catch (error: unknown) {
    console.error('[Tier Change] Preview error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function commitTierChange(
  memberEmail: string,
  subscriptionId: string,
  newPriceId: string,
  immediate: boolean,
  staffEmail: string
): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    const stripe = await getStripeClient();
    
    // Get current subscription to find current price ID
    const currentSub = await stripe.subscriptions.retrieve(subscriptionId);
    const currentPriceId = currentSub.items.data[0]?.price?.id;
    
    // Look up current tier from DB using price ID (consistent naming)
    let currentTierName = 'Unknown';
    if (currentPriceId) {
      const currentTierResult = await pool.query(
        'SELECT name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
        [currentPriceId]
      );
      if (currentTierResult.rows.length > 0) {
        currentTierName = currentTierResult.rows[0].name;
      }
    }
    
    // Find new tier in DB
    const tier = await db.query.membershipTiers.findFirst({
      where: eq(membershipTiers.stripePriceId, newPriceId)
    });
    
    if (!tier) {
      return { success: false, error: 'New tier not found in database' };
    }
    
    // Change subscription in Stripe
    const result = await changeSubscriptionTier(subscriptionId, newPriceId, immediate);
    if (!result.success) {
      return result;
    }
    
    // Only update DB tier immediately if this is an immediate change
    // Scheduled changes are handled by the subscription.updated webhook when Stripe applies them
    if (immediate) {
      await pool.query(
        'UPDATE users SET tier = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2)',
        [tier.name, memberEmail]
      );
      
      // Sync the updated tier to Stripe customer metadata
      await syncCustomerMetadataToStripe(memberEmail);
      
      // Sync tier change to HubSpot
      try {
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        await syncMemberToHubSpot({ email: memberEmail, tier: tier.name, billingProvider: 'stripe' });
        console.log(`[TierChange] Synced ${memberEmail} tier=${tier.name} to HubSpot`);
      } catch (hubspotError) {
        console.error('[TierChange] HubSpot sync failed:', hubspotError);
      }
    }
    
    // Add member note for audit trail using DB tier names for consistency
    const changeType = immediate ? 'immediately' : 'at end of billing cycle';
    const noteContent = `Membership tier changed from ${currentTierName} to ${tier.name} (${changeType}). Changed by staff: ${staffEmail}`;
    
    await db.insert(memberNotes).values({
      memberEmail: memberEmail.toLowerCase(),
      content: noteContent,
      createdBy: staffEmail,
      createdByName: staffEmail.split('@')[0] || 'Staff',
      isPinned: false,
    });
    
    console.log(`[Tier Change] Staff ${staffEmail} changed ${memberEmail} from ${currentTierName} to ${tier.name} (${changeType})`);
    
    // Verification: Check if DB tier was properly updated
    let warning: string | undefined;
    if (immediate) {
      const userResult = await pool.query(
        'SELECT tier FROM users WHERE LOWER(email) = LOWER($1)',
        [memberEmail]
      );
      if (userResult.rows.length > 0) {
        const actualTier = userResult.rows[0].tier;
        if (actualTier !== tier.name) {
          warning = `Expected ${tier.name} but DB shows ${actualTier}`;
          console.log(`[Tier Change] VERIFICATION FAILED: ${warning}`);
        }
      }
    }
    
    return { success: true, ...(warning && { warning }) };
  } catch (error: unknown) {
    console.error('[Tier Change] Commit error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getAvailableTiersForChange(): Promise<Array<{
  id: number;
  name: string;
  slug: string;
  priceCents: number;
  stripePriceId: string;
  billingInterval: string;
}>> {
  const tiers = await db.select({
    id: membershipTiers.id,
    name: membershipTiers.name,
    slug: membershipTiers.slug,
    priceCents: membershipTiers.priceCents,
    stripePriceId: membershipTiers.stripePriceId,
    billingInterval: membershipTiers.billingInterval,
    productType: membershipTiers.productType,
  })
  .from(membershipTiers)
  .where(eq(membershipTiers.isActive, true));
  
  // Only return subscription tiers with Stripe price IDs
  return tiers
    .filter(t => t.stripePriceId && t.productType !== 'one_time')
    .map(t => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      priceCents: t.priceCents || 0,
      stripePriceId: t.stripePriceId!,
      billingInterval: t.billingInterval || 'month',
    }));
}
