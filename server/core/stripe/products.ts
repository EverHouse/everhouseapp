import { pool } from '../db';
import { db } from '../../db';
import { stripeProducts } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from './client';
import { getHubSpotClient } from '../integrations';

export interface HubSpotProduct {
  id: string;
  name: string;
  price: number;
  sku: string | null;
  description: string | null;
  recurringPeriod: string | null;
}

export interface StripeProductWithPrice {
  id: number;
  hubspotProductId: string;
  stripeProductId: string;
  stripePriceId: string;
  name: string;
  priceCents: number;
  billingInterval: string;
  billingIntervalCount: number;
  isActive: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ProductSyncStatus {
  hubspotProductId: string;
  name: string;
  price: number;
  isSynced: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
}

function parseRecurringPeriod(period: string | null): { interval: 'month' | 'year' | 'week' | 'day'; intervalCount: number } {
  if (!period) {
    return { interval: 'month', intervalCount: 1 };
  }
  
  const match = period.match(/^P(\d+)([YMWD])$/);
  if (!match) {
    return { interval: 'month', intervalCount: 1 };
  }
  
  const count = parseInt(match[1], 10);
  const unit = match[2];
  
  switch (unit) {
    case 'Y':
      return { interval: 'year', intervalCount: count };
    case 'M':
      return { interval: 'month', intervalCount: count };
    case 'W':
      return { interval: 'week', intervalCount: count };
    case 'D':
      return { interval: 'day', intervalCount: count };
    default:
      return { interval: 'month', intervalCount: 1 };
  }
}

export async function fetchHubSpotProducts(): Promise<HubSpotProduct[]> {
  try {
    const hubspot = await getHubSpotClient();
    
    const properties = ['name', 'price', 'hs_sku', 'description', 'hs_recurring_billing_period'];
    let allProducts: any[] = [];
    let after: string | undefined = undefined;
    
    do {
      const response = await hubspot.crm.products.basicApi.getPage(100, after, properties);
      allProducts = allProducts.concat(response.results);
      after = response.paging?.next?.after;
    } while (after);
    
    return allProducts.map((product: any) => ({
      id: product.id,
      name: product.properties.name || '',
      price: parseFloat(product.properties.price) || 0,
      sku: product.properties.hs_sku || null,
      description: product.properties.description || null,
      recurringPeriod: product.properties.hs_recurring_billing_period || null,
    }));
  } catch (error: any) {
    console.error('[Stripe Products] Error fetching HubSpot products:', error);
    throw error;
  }
}

export async function syncHubSpotProductToStripe(hubspotProduct: HubSpotProduct): Promise<{
  success: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    
    const existingSync = await db.select()
      .from(stripeProducts)
      .where(eq(stripeProducts.hubspotProductId, hubspotProduct.id))
      .limit(1);
    
    if (existingSync.length > 0) {
      const existing = existingSync[0];
      
      await stripe.products.update(existing.stripeProductId, {
        name: hubspotProduct.name,
        description: hubspotProduct.description || undefined,
        metadata: {
          hubspot_product_id: hubspotProduct.id,
          hubspot_sku: hubspotProduct.sku || '',
        },
      });
      
      const priceCents = Math.round(hubspotProduct.price * 100);
      const { interval, intervalCount } = parseRecurringPeriod(hubspotProduct.recurringPeriod);
      
      const currentPrice = await stripe.prices.retrieve(existing.stripePriceId);
      const priceChanged = currentPrice.unit_amount !== priceCents;
      const intervalChanged = currentPrice.recurring?.interval !== interval || 
                              currentPrice.recurring?.interval_count !== intervalCount;
      
      let newPriceId = existing.stripePriceId;
      
      if (priceChanged || intervalChanged) {
        await stripe.prices.update(existing.stripePriceId, { active: false });
        
        const newPrice = await stripe.prices.create({
          product: existing.stripeProductId,
          unit_amount: priceCents,
          currency: 'usd',
          recurring: {
            interval,
            interval_count: intervalCount,
          },
          metadata: {
            hubspot_product_id: hubspotProduct.id,
          },
        });
        newPriceId = newPrice.id;
      }
      
      await db.update(stripeProducts)
        .set({
          name: hubspotProduct.name,
          priceCents,
          billingInterval: interval,
          billingIntervalCount: intervalCount,
          stripePriceId: newPriceId,
          updatedAt: new Date(),
        })
        .where(eq(stripeProducts.hubspotProductId, hubspotProduct.id));
      
      console.log(`[Stripe Products] Updated product ${hubspotProduct.name} (${hubspotProduct.id})`);
      
      return {
        success: true,
        stripeProductId: existing.stripeProductId,
        stripePriceId: newPriceId,
      };
    }
    
    const stripeProduct = await stripe.products.create({
      name: hubspotProduct.name,
      description: hubspotProduct.description || undefined,
      metadata: {
        hubspot_product_id: hubspotProduct.id,
        hubspot_sku: hubspotProduct.sku || '',
      },
    });
    
    const priceCents = Math.round(hubspotProduct.price * 100);
    const { interval, intervalCount } = parseRecurringPeriod(hubspotProduct.recurringPeriod);
    
    const stripePrice = await stripe.prices.create({
      product: stripeProduct.id,
      unit_amount: priceCents,
      currency: 'usd',
      recurring: {
        interval,
        interval_count: intervalCount,
      },
      metadata: {
        hubspot_product_id: hubspotProduct.id,
      },
    });
    
    await db.insert(stripeProducts).values({
      hubspotProductId: hubspotProduct.id,
      stripeProductId: stripeProduct.id,
      stripePriceId: stripePrice.id,
      name: hubspotProduct.name,
      priceCents,
      billingInterval: interval,
      billingIntervalCount: intervalCount,
      isActive: true,
    });
    
    console.log(`[Stripe Products] Created product ${hubspotProduct.name} (${hubspotProduct.id}) -> ${stripeProduct.id}`);
    
    return {
      success: true,
      stripeProductId: stripeProduct.id,
      stripePriceId: stripePrice.id,
    };
  } catch (error: any) {
    console.error('[Stripe Products] Error syncing product:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function syncAllHubSpotProductsToStripe(): Promise<{
  success: boolean;
  synced: number;
  failed: number;
  errors: Array<{ productId: string; error: string }>;
}> {
  try {
    const hubspotProducts = await fetchHubSpotProducts();
    
    let synced = 0;
    let failed = 0;
    const errors: Array<{ productId: string; error: string }> = [];
    
    for (const product of hubspotProducts) {
      const result = await syncHubSpotProductToStripe(product);
      if (result.success) {
        synced++;
      } else {
        failed++;
        errors.push({ productId: product.id, error: result.error || 'Unknown error' });
      }
    }
    
    console.log(`[Stripe Products] Sync complete: ${synced} synced, ${failed} failed`);
    
    return { success: true, synced, failed, errors };
  } catch (error: any) {
    console.error('[Stripe Products] Error syncing all products:', error);
    return {
      success: false,
      synced: 0,
      failed: 0,
      errors: [{ productId: 'all', error: error.message }],
    };
  }
}

export async function getStripeProducts(): Promise<StripeProductWithPrice[]> {
  try {
    const products = await db.select().from(stripeProducts);
    return products;
  } catch (error: any) {
    console.error('[Stripe Products] Error getting products:', error);
    return [];
  }
}

export async function getProductSyncStatus(): Promise<ProductSyncStatus[]> {
  try {
    const hubspotProducts = await fetchHubSpotProducts();
    const syncedProducts = await db.select().from(stripeProducts);
    
    const syncedMap = new Map(syncedProducts.map(p => [p.hubspotProductId, p]));
    
    return hubspotProducts.map(product => {
      const synced = syncedMap.get(product.id);
      return {
        hubspotProductId: product.id,
        name: product.name,
        price: product.price,
        isSynced: !!synced,
        stripeProductId: synced?.stripeProductId,
        stripePriceId: synced?.stripePriceId,
      };
    });
  } catch (error: any) {
    console.error('[Stripe Products] Error getting sync status:', error);
    return [];
  }
}
