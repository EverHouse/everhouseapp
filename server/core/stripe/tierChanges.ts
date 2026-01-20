import { getStripeClient } from './client';
import { db } from '../../db';
import { membershipTiers, users } from '../../../shared/schema';
import { eq, ilike } from 'drizzle-orm';
import { changeSubscriptionTier } from './subscriptions';
import { pool } from '../db';

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
      // Use upcoming invoice to preview proration
      const upcomingInvoice = await stripe.invoices.retrieveUpcoming({
        customer: sub.customer as string,
        subscription: subscriptionId,
        subscription_items: [{ id: currentItem.id, price: newPriceId }],
        subscription_proration_behavior: 'always_invoice',
      });
      
      // Calculate proration from invoice line items
      let prorationAmount = 0;
      for (const line of upcomingInvoice.lines.data) {
        if (line.proration) {
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
          nextInvoiceAmountCents: upcomingInvoice.amount_due,
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
          effectiveDate: new Date(sub.current_period_end * 1000),
          isImmediate: false,
        }
      };
    }
  } catch (error: any) {
    console.error('[Tier Change] Preview error:', error);
    return { success: false, error: error.message };
  }
}

export async function commitTierChange(
  memberEmail: string,
  subscriptionId: string,
  newPriceId: string,
  immediate: boolean,
  staffEmail: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get new tier info from price
    const stripe = await getStripeClient();
    const newPrice = await stripe.prices.retrieve(newPriceId, { expand: ['product'] });
    const newProduct = newPrice.product as any;
    const tierSlug = newPrice.metadata?.tier_slug || newProduct.metadata?.tier_slug;
    
    // Find tier in DB
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
    
    // Update user tier in DB
    await pool.query(
      'UPDATE users SET tier = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2)',
      [tier.slug, memberEmail]
    );
    
    // Log the change
    console.log(`[Tier Change] Staff ${staffEmail} changed ${memberEmail} to tier ${tier.name} (immediate: ${immediate})`);
    
    return { success: true };
  } catch (error: any) {
    console.error('[Tier Change] Commit error:', error);
    return { success: false, error: error.message };
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
