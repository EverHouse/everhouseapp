import { db } from '../../db';
import { isProduction } from '../db';
import { getHubSpotClient } from '../integrations';
import { hubspotDeals, hubspotLineItems, hubspotProductMappings, billingAuditLog } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { retryableHubSpotRequest } from './request';

import { logger } from '../logger';
export async function addLineItemToDeal(
  hubspotDealId: string,
  productId: string,
  quantity: number = 1,
  discountPercent: number = 0,
  discountReason?: string,
  createdBy?: string,
  createdByName?: string
): Promise<{ success: boolean; lineItemId?: string }> {
  try {
    const product = await db.select()
      .from(hubspotProductMappings)
      .where(eq(hubspotProductMappings.hubspotProductId, productId))
      .limit(1);
    
    if (product.length === 0) {
      logger.error('[HubSpotDeals] Product not found:', { extra: { detail: productId } });
      return { success: false };
    }
    
    const productInfo = product[0];
    const unitPrice = parseFloat(productInfo.unitPrice?.toString() || '0');
    const discountedPrice = unitPrice * (1 - discountPercent / 100);
    const totalAmount = discountedPrice * quantity;
    
    const hubspot = await getHubSpotClient();
    
    const lineItemResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.lineItems.basicApi.create({
        properties: {
          hs_product_id: productId,
          quantity: String(quantity),
          price: String(discountedPrice),
          name: productInfo.productName,
          ...(discountPercent > 0 && { 
            hs_discount_percentage: String(discountPercent),
            ...(discountReason && { discount_reason: discountReason })
          })
        }
      })
    );
    
    const lineItemId = lineItemResponse.id;
    
    await retryableHubSpotRequest(() =>
      hubspot.crm.associations.v4.basicApi.create(
        'line_items',
        lineItemId,
        'deals',
        hubspotDealId,
        [{ associationCategory: 'HUBSPOT_DEFINED' as any, associationTypeId: 20 }]
      )
    );
    
    await db.insert(hubspotLineItems).values({
      hubspotDealId,
      hubspotLineItemId: lineItemId,
      hubspotProductId: productId,
      productName: productInfo.productName,
      quantity,
      unitPrice: productInfo.unitPrice,
      discountPercent,
      discountReason,
      totalAmount: String(totalAmount),
      status: 'synced',
      createdBy,
      createdByName
    });
    
    const deal = await db.select()
      .from(hubspotDeals)
      .where(eq(hubspotDeals.hubspotDealId, hubspotDealId))
      .limit(1);
    
    if (deal[0] && createdBy) {
      await db.insert(billingAuditLog).values({
        memberEmail: deal[0].memberEmail,
        hubspotDealId,
        actionType: 'line_item_added',
        actionDetails: {
          productId,
          productName: productInfo.productName,
          quantity,
          unitPrice,
          discountPercent,
          discountReason,
          totalAmount
        },
        newValue: `${productInfo.productName} x${quantity} @ $${discountedPrice}`,
        performedBy: createdBy,
        performedByName: createdByName
      });
    }
    
    if (!isProduction) logger.info(`[HubSpotDeals] Added line item ${lineItemId} to deal ${hubspotDealId}`);
    return { success: true, lineItemId };
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error adding line item:', { error: error });
    return { success: false };
  }
}

export async function removeLineItemFromDeal(
  lineItemId: string,
  performedBy: string,
  performedByName?: string
): Promise<boolean> {
  try {
    const lineItem = await db.select()
      .from(hubspotLineItems)
      .where(eq(hubspotLineItems.hubspotLineItemId, lineItemId))
      .limit(1);
    
    if (lineItem.length === 0) {
      logger.error('[HubSpotDeals] Line item not found:', { extra: { detail: lineItemId } });
      return false;
    }
    
    const hubspot = await getHubSpotClient();
    
    await retryableHubSpotRequest(() =>
      hubspot.crm.lineItems.basicApi.archive(lineItemId)
    );
    
    await db.delete(hubspotLineItems)
      .where(eq(hubspotLineItems.hubspotLineItemId, lineItemId));
    
    const deal = await db.select()
      .from(hubspotDeals)
      .where(eq(hubspotDeals.hubspotDealId, lineItem[0].hubspotDealId))
      .limit(1);
    
    if (deal[0]) {
      await db.insert(billingAuditLog).values({
        memberEmail: deal[0].memberEmail,
        hubspotDealId: lineItem[0].hubspotDealId,
        actionType: 'line_item_removed',
        actionDetails: {
          productName: lineItem[0].productName,
          quantity: lineItem[0].quantity,
          unitPrice: lineItem[0].unitPrice
        },
        previousValue: `${lineItem[0].productName} x${lineItem[0].quantity}`,
        performedBy,
        performedByName
      });
    }
    
    if (!isProduction) logger.info(`[HubSpotDeals] Removed line item ${lineItemId}`);
    return true;
  } catch (error) {
    logger.error('[HubSpotDeals] Error removing line item:', { error: error });
    return false;
  }
}

export async function getMemberDealWithLineItems(memberEmail: string): Promise<any | null> {
  try {
    const deal = await db.select()
      .from(hubspotDeals)
      .where(eq(hubspotDeals.memberEmail, memberEmail.toLowerCase()))
      .limit(1);
    
    if (deal.length === 0) {
      return null;
    }
    
    const lineItems = await db.select()
      .from(hubspotLineItems)
      .where(eq(hubspotLineItems.hubspotDealId, deal[0].hubspotDealId));
    
    return {
      ...deal[0],
      lineItems
    };
  } catch (error) {
    logger.error('[HubSpotDeals] Error fetching member deal:', { error: error });
    return null;
  }
}
