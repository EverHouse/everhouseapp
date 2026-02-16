import { db } from '../../db';
import { pool } from '../db';
import { hubspotDeals, hubspotLineItems, billingAuditLog } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { getHubSpotClient } from '../integrations';

export interface SyncPaymentParams {
  email: string;
  amountCents: number;
  purpose: string;
  description: string;
  paymentIntentId: string;
}

export interface SyncDayPassParams {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  productSlug: string;
  amountCents: number;
  paymentIntentId: string;
  purchaseId?: string;
}

export async function syncPaymentToHubSpot(params: SyncPaymentParams): Promise<void> {
  const { email, amountCents, purpose, description, paymentIntentId } = params;

  const deal = await db.select()
    .from(hubspotDeals)
    .where(eq(hubspotDeals.memberEmail, email.toLowerCase()))
    .limit(1);

  if (deal.length === 0) {
    console.log(`[Stripe->HubSpot] No deal found for ${email}, skipping HubSpot sync`);
    return;
  }

  const memberDeal = deal[0];
  const hubspotDealId = memberDeal.hubspotDealId;

  const productResult = await pool.query(
    `SELECT hubspot_product_id, product_name FROM hubspot_product_mappings 
     WHERE product_type = $1 AND is_active = true 
     LIMIT 1`,
    [purpose === 'guest_fee' ? 'pass' : 'fee']
  );

  let productId: string | null = null;
  let productName = description;

  if (productResult.rows.length > 0) {
    productId = productResult.rows[0].hubspot_product_id;
    productName = productResult.rows[0].product_name;
  }

  try {
    const hubspot = await getHubSpotClient();
    
    const unitPrice = amountCents / 100;
    
    const lineItemProperties: any = {
      quantity: '1',
      price: String(unitPrice),
      name: productName,
    };

    if (productId) {
      lineItemProperties.hs_product_id = productId;
    }

    const lineItemResponse = await hubspot.crm.lineItems.basicApi.create({
      properties: lineItemProperties
    });

    const lineItemId = lineItemResponse.id;

    await hubspot.crm.associations.v4.basicApi.create(
      'line_items',
      lineItemId,
      'deals',
      hubspotDealId,
      [{ associationCategory: 'HUBSPOT_DEFINED' as any, associationTypeId: 20 }]
    );

    await db.insert(hubspotLineItems).values({
      hubspotDealId,
      hubspotLineItemId: lineItemId,
      hubspotProductId: productId || 'stripe_payment',
      productName,
      quantity: 1,
      unitPrice: String(unitPrice),
      discountPercent: 0,
      totalAmount: String(unitPrice),
      status: 'synced',
      createdBy: 'stripe_webhook',
      createdByName: 'Stripe Payment'
    });

    await db.insert(billingAuditLog).values({
      memberEmail: email,
      hubspotDealId,
      actionType: 'stripe_payment_synced_to_hubspot',
      actionDetails: {
        paymentIntentId,
        amountCents,
        purpose,
        lineItemId,
        productId
      },
      newValue: `Synced Stripe payment of $${unitPrice.toFixed(2)} to HubSpot`,
      performedBy: 'stripe_webhook',
      performedByName: 'Stripe Webhook'
    });

    console.log(`[Stripe->HubSpot] Synced payment ${paymentIntentId} to deal ${hubspotDealId} as line item ${lineItemId}`);
  } catch (error) {
    console.error('[Stripe->HubSpot] Error syncing payment:', error);
    throw error;
  }
}

export async function syncDayPassToHubSpot(params: SyncDayPassParams): Promise<void> {
  const { email, firstName, lastName, phone, productSlug, amountCents, paymentIntentId, purchaseId } = params;

  try {
    // Check if there's an existing deal for this email
    const deal = await db.select()
      .from(hubspotDeals)
      .where(eq(hubspotDeals.memberEmail, email.toLowerCase()))
      .limit(1);

    let hubspotDealId: string;

    if (deal.length > 0) {
      // Use existing deal if it exists
      hubspotDealId = deal[0].hubspotDealId;
      console.log(`[DayPass->HubSpot] Using existing deal ${hubspotDealId} for ${email}`);
    } else {
      // For non-members, log the day pass purchase but don't fail if no deal exists
      console.log(`[DayPass->HubSpot] No deal found for ${email} - this is a non-member day pass purchase. Skipping HubSpot sync.`);
      return;
    }

    const productResult = await pool.query(
      `SELECT hubspot_product_id, product_name FROM hubspot_product_mappings 
       WHERE product_type = $1 AND is_active = true 
       LIMIT 1`,
      ['day_pass']
    );

    let productId: string | null = null;
    let productName = `Day Pass - ${productSlug}`;

    if (productResult.rows.length > 0) {
      productId = productResult.rows[0].hubspot_product_id;
      productName = productResult.rows[0].product_name;
    }

    try {
      const hubspot = await getHubSpotClient();

      const unitPrice = amountCents / 100;

      const lineItemProperties: any = {
        quantity: '1',
        price: String(unitPrice),
        name: productName,
      };

      if (productId) {
        lineItemProperties.hs_product_id = productId;
      }

      const lineItemResponse = await hubspot.crm.lineItems.basicApi.create({
        properties: lineItemProperties
      });

      const lineItemId = lineItemResponse.id;

      await hubspot.crm.associations.v4.basicApi.create(
        'line_items',
        lineItemId,
        'deals',
        hubspotDealId,
        [{ associationCategory: 'HUBSPOT_DEFINED' as any, associationTypeId: 20 }]
      );

      await db.insert(hubspotLineItems).values({
        hubspotDealId,
        hubspotLineItemId: lineItemId,
        hubspotProductId: productId || 'day_pass_stripe',
        productName,
        quantity: 1,
        unitPrice: String(unitPrice),
        discountPercent: 0,
        totalAmount: String(unitPrice),
        status: 'synced',
        createdBy: 'stripe_webhook',
        createdByName: 'Stripe Webhook'
      });

      await db.insert(billingAuditLog).values({
        memberEmail: email,
        hubspotDealId,
        actionType: 'day_pass_synced_to_hubspot',
        actionDetails: {
          paymentIntentId,
          amountCents,
          productSlug,
          purchaseId,
          lineItemId,
          productId
        },
        newValue: `Synced day pass purchase of $${unitPrice.toFixed(2)} to HubSpot`,
        performedBy: 'stripe_webhook',
        performedByName: 'Stripe Webhook'
      });

      console.log(`[DayPass->HubSpot] Synced day pass ${purchaseId} to deal ${hubspotDealId} as line item ${lineItemId}`);
    } catch (error) {
      console.error('[DayPass->HubSpot] Error syncing day pass to HubSpot:', error);
      throw error;
    }
  } catch (error) {
    console.error('[DayPass->HubSpot] Error in syncDayPassToHubSpot:', error);
    // Don't throw - day pass purchases should not fail if HubSpot sync fails
  }
}
