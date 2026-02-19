import { db } from '../../db';
import { hubspotProductMappings } from '../../../shared/schema';
import { eq, and } from 'drizzle-orm';

import { logger } from '../logger';
export async function getProductMapping(tierName?: string, productType?: string): Promise<any | null> {
  try {
    if (tierName) {
      const result = await db.select()
        .from(hubspotProductMappings)
        .where(and(
          eq(hubspotProductMappings.tierName, tierName),
          eq(hubspotProductMappings.isActive, true)
        ))
        .limit(1);
      return result[0] || null;
    }
    
    if (productType) {
      const result = await db.select()
        .from(hubspotProductMappings)
        .where(and(
          eq(hubspotProductMappings.productType, productType),
          eq(hubspotProductMappings.isActive, true)
        ));
      return result;
    }
    
    return null;
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error getting product mapping:', { error: error });
    return null;
  }
}

export async function getAllProductMappings(): Promise<any[]> {
  try {
    const products = await db.select().from(hubspotProductMappings).orderBy(hubspotProductMappings.productType);
    return products;
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error fetching product mappings:', { error: error });
    return [];
  }
}
