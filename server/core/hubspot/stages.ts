import { db } from '../../db';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';
import { getHubSpotClient } from '../integrations';
import { eq, sql } from 'drizzle-orm';
import { retryableHubSpotRequest } from './request';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import { isPlaceholderEmail } from '../stripe/customers';

import { logger } from '../logger';
let _isLiveStripeCache: boolean | null = null;
async function isLiveStripeEnvironment(): Promise<boolean> {
  if (_isLiveStripeCache !== null) return _isLiveStripeCache;
  try {
    const { getStripeEnvironmentInfo } = await import('../stripe/client');
    const envInfo = await getStripeEnvironmentInfo();
    _isLiveStripeCache = envInfo.isLive;
  } catch (err) {
    logger.debug('Failed to detect Stripe environment, falling back to deployment check', { error: getErrorMessage(err) });
    _isLiveStripeCache = process.env.REPLIT_DEPLOYMENT === '1';
  }
  return _isLiveStripeCache;
}

import { 
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MINDBODY_TO_CONTACT_STATUS_MAP,
  ContactMembershipStatus,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  BillingProvider,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  DB_STATUS_TO_HUBSPOT_STATUS,
  DB_BILLING_PROVIDER_TO_HUBSPOT,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  DB_TIER_TO_HUBSPOT,
  getDbStatusToHubSpotMapping
} from './constants';

export async function updateContactMembershipStatus(
  hubspotContactId: string,
  newStatus: ContactMembershipStatus,
  _performedBy: string
): Promise<boolean> {
  const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('./readOnlyGuard');
  if (isHubSpotReadOnly()) {
    logHubSpotWriteSkipped('update_membership_status', hubspotContactId);
    return true;
  }

  try {
    const hubspot = await getHubSpotClient();
    
    await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.update(hubspotContactId, {
        properties: {
          membership_status: newStatus
        }
      })
    );
    
    logger.info(`[HubSpot] Updated contact ${hubspotContactId} membership_status to ${newStatus}`);
    return true;
  } catch (error: unknown) {
    logger.error('[HubSpot] Error updating contact membership_status:', { error: getErrorMessage(error) });
    return false;
  }
}

export interface SyncMemberToHubSpotInput {
  email: string;
  status?: string;
  billingProvider?: string;
  tier?: string;
  memberSince?: Date | string;
  createIfMissing?: boolean;
  stripeCustomerId?: string;
  stripeCreatedDate?: Date | string;
  stripeDelinquent?: boolean;
  stripeDiscountId?: string;
  stripePricingInterval?: string;
  billingGroupRole?: string;
}

export interface SyncMemberToHubSpotResult {
  success: boolean;
  contactId?: string;
  updated: {
    status?: boolean;
    billingProvider?: boolean;
    tier?: boolean;
    memberSince?: boolean;
    stripeFields?: boolean;
    billingGroupRole?: boolean;
  };
  error?: string;
}

export async function syncMemberToHubSpot(
  input: SyncMemberToHubSpotInput
): Promise<SyncMemberToHubSpotResult> {
  const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('./readOnlyGuard');
  if (isHubSpotReadOnly()) {
    logHubSpotWriteSkipped('sync_member', input.email);
    return { success: true, updated: {} };
  }

  const { email, status, billingProvider, tier, memberSince, createIfMissing = true, billingGroupRole } = input;
  
  if (isPlaceholderEmail(email)) {
    logger.info(`[HubSpot Sync] Skipping sync for placeholder email: ${email}`);
    return { success: false, error: 'Placeholder email skipped', updated: {} };
  }
  
  try {
    const hubspot = await getHubSpotClient();
    
    const searchResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: FilterOperatorEnum.Eq,
            value: email.toLowerCase()
          }]
        }],
        properties: ['email', 'membership_status', 'billing_provider', 'membership_tier', 'membership_billing_type', 'membership_start_date'],
        limit: 1
      })
    );
    
    let contactId: string;
    
    if (!searchResponse.results || searchResponse.results.length === 0) {
      if (!createIfMissing) {
        logger.info(`[HubSpot Sync] Contact not found for ${email}, skipping sync`);
        return { success: false, error: 'Contact not found', updated: {} };
      }
      
      logger.info(`[HubSpot Sync] Contact not found for ${email}, creating...`);
      const { findOrCreateHubSpotContact } = await import('./members');
      let contactFirstName = '';
      let contactLastName = '';
      try {
        const { users } = await import('../../../shared/schema');
        const nameResult = await db.select({ firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.email, email.toLowerCase()))
          .limit(1);
        contactFirstName = nameResult[0]?.firstName || '';
        contactLastName = nameResult[0]?.lastName || '';
      } catch (e: unknown) {
        logger.warn('[HubSpot Sync] Failed to fetch name for contact creation:', { error: getErrorMessage(e) });
      }
      const result = await findOrCreateHubSpotContact(email, contactFirstName, contactLastName);
      if (!result.contactId) {
        logger.error(`[HubSpot Sync] Failed to create contact for ${email}`);
        return { success: false, error: 'Failed to create contact', updated: {} };
      }
      contactId = result.contactId;
      logger.info(`[HubSpot Sync] Created contact ${contactId} for ${email}`);
    } else {
      contactId = searchResponse.results[0].id;
    }
    
    const properties: Record<string, string> = {};
    const updated: SyncMemberToHubSpotResult['updated'] = {};
    
    let effectiveBillingProvider = billingProvider?.toLowerCase() || null;
    if (!effectiveBillingProvider) {
      try {
        const { users } = await import('../../../shared/schema');
        const userResult = await db.select({ billingProvider: users.billingProvider })
          .from(users)
          .where(eq(users.email, email.toLowerCase()))
          .limit(1);
        effectiveBillingProvider = userResult[0]?.billingProvider || null;
      } catch (e: unknown) {
        logger.warn('[HubSpot Stages] Failed to fetch billingProvider for email:', { error: getErrorMessage(e) });
      }
    }

    const isMindbodyBilled = effectiveBillingProvider === 'mindbody';
    if (isMindbodyBilled && status) {
      logger.info(`[HubSpot Sync] Skipping status push for Mindbody-billed member ${email} to prevent sync loop`);
    }
    
    let targetLifecycleStage: string | null = null;
    if (status && !isMindbodyBilled) {
      const normalizedStatus = status.toLowerCase();
      const statusMapping = await getDbStatusToHubSpotMapping();
      const hubspotStatus = statusMapping[normalizedStatus] || 'Suspended';
      properties.membership_status = hubspotStatus;
      updated.status = true;
      
      const isActive = ['active', 'trialing', 'past_due'].includes(normalizedStatus);
      targetLifecycleStage = isActive ? 'customer' : 'other';
      properties.lifecyclestage = targetLifecycleStage;

      const midnightUtc = new Date();
      midnightUtc.setUTCHours(0, 0, 0, 0);
      properties.last_modified_at = midnightUtc.getTime().toString();
    }
    
    if (billingProvider) {
      const normalizedProvider = billingProvider.toLowerCase();
      const hubspotProvider = DB_BILLING_PROVIDER_TO_HUBSPOT[normalizedProvider] || 'manual';
      properties.billing_provider = hubspotProvider;
      updated.billingProvider = true;
    }
    
    if (tier) {
      const { denormalizeTierForHubSpotAsync } = await import('../../utils/tierUtils');
      const hubspotTier = await denormalizeTierForHubSpotAsync(tier);
      if (hubspotTier) {
        properties.membership_tier = hubspotTier;
        updated.tier = true;
      }
    }
    
    if (memberSince) {
      const existingStartDate = searchResponse.results?.[0]?.properties?.membership_start_date;
      if (existingStartDate) {
        logger.info(`[HubSpot Sync] Preserving existing membership_start_date for ${email} (existing: ${existingStartDate})`);
      } else {
        const date = memberSince instanceof Date ? memberSince : new Date(memberSince);
        const midnightUtc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        properties.membership_start_date = midnightUtc.getTime().toString();
        updated.memberSince = true;
      }
    }

    const isLiveStripe = await isLiveStripeEnvironment();

    if (isLiveStripe) {
      if (input.stripeCreatedDate) {
        const date = input.stripeCreatedDate instanceof Date ? input.stripeCreatedDate : new Date(input.stripeCreatedDate);
        const midnightUtc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        properties.stripe_created_date = midnightUtc.getTime().toString();
      }
      if (input.stripeDiscountId) {
        properties.stripe_discount_id = input.stripeDiscountId;
      }
      if (input.stripePricingInterval) {
        properties.stripe_pricing_interval_of_last_active_subscription = input.stripePricingInterval;
      }
      if (Object.keys(properties).some(k => k.startsWith('stripe_'))) {
        updated.stripeFields = true;
      }
    } else {
      if (input.stripeCreatedDate || input.stripeDiscountId || input.stripePricingInterval) {
        logger.info(`[HubSpot Sync] Skipping Stripe field push for ${email} — sandbox/test Stripe environment detected`);
      }
    }

    if (input.billingGroupRole) {
      properties.membership_billing_type = input.billingGroupRole;
      updated.billingGroupRole = true;
    }
    
    if (Object.keys(properties).length === 0) {
      logger.info(`[HubSpot Sync] No properties to update for ${email}`);
      return { success: true, contactId, updated };
    }
    
    let lifecycleCleared = false;
    if (targetLifecycleStage) {
      try {
        await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.basicApi.update(contactId, { properties: { lifecyclestage: '' } })
        );
        lifecycleCleared = true;
      } catch (clearError: unknown) {
        logger.warn(`[HubSpot Sync] Could not clear lifecyclestage for ${email} before setting to '${targetLifecycleStage}':`, { error: getErrorMessage(clearError) });
      }
    }

    try {
      await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.basicApi.update(contactId, { properties })
      );
      logger.info(`[HubSpot Sync] Updated ${email}: ${JSON.stringify(properties)}`);
      return { success: true, contactId, updated };
    } catch (updateError: unknown) {
      const errBody = updateError && typeof updateError === 'object' && 'body' in updateError ? (updateError as { body: { errors?: Array<{ code: string; context?: { propertyName?: string[] } }> } }).body : undefined;
      if (errBody?.errors?.some((e) => e.code === 'PROPERTY_DOESNT_EXIST')) {
        const invalidProps = errBody.errors
          .filter((e) => e.code === 'PROPERTY_DOESNT_EXIST')
          .map((e) => e.context?.propertyName?.[0]);
        
        const validProperties: Record<string, string> = {};
        for (const [key, value] of Object.entries(properties)) {
          if (!invalidProps.includes(key)) {
            validProperties[key] = value;
          }
        }
        
        if (Object.keys(validProperties).length > 0) {
          logger.info(`[HubSpot Sync] Retrying ${email} without missing properties: ${invalidProps.join(', ')}`);
          await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.basicApi.update(contactId, { properties: validProperties })
          );
          logger.info(`[HubSpot Sync] Updated ${email}: ${JSON.stringify(validProperties)}`);
          return { success: true, contactId, updated };
        }
      }
      if (lifecycleCleared && targetLifecycleStage) {
        try {
          await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.basicApi.update(contactId, { properties: { lifecyclestage: targetLifecycleStage! } })
          );
          logger.warn(`[HubSpot Sync] Restored lifecyclestage to '${targetLifecycleStage}' for ${email} after update failure`);
        } catch (restoreError: unknown) {
          logger.error(`[HubSpot Sync] Failed to restore lifecyclestage for ${email} after update failure:`, { error: getErrorMessage(restoreError) });
        }
      }
      throw updateError;
    }
  } catch (error: unknown) {
    logger.error(`[HubSpot Sync] Error syncing ${email}:`, { error: getErrorMessage(error) });
    return { success: false, error: getErrorMessage(error), updated: {} };
  }
}

export async function ensureHubSpotPropertiesExist(): Promise<{ success: boolean; created: string[]; existing: string[]; errors: string[] }> {
  const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('./readOnlyGuard');
  if (isHubSpotReadOnly()) {
    logHubSpotWriteSkipped('ensure_properties_exist', 'property creation');
    return { success: true, created: [], existing: [], errors: [] };
  }

  const created: string[] = [];
  const existing: string[] = [];
  const errors: string[] = [];
  
  try {
    const hubspot = await getHubSpotClient();
    
    const billingProviderOptions = [
      { label: 'Stripe', value: 'stripe', displayOrder: 1 },
      { label: 'MindBody', value: 'mindbody', displayOrder: 2 },
      { label: 'Manual', value: 'manual', displayOrder: 3 },
      { label: 'None', value: 'None', displayOrder: 4 },
      { label: 'Comped', value: 'Comped', displayOrder: 5 },
    ];

    let membershipTierOptions: { label: string; value: string; displayOrder: number }[] = [];
    try {
      const tierRows = await db.execute(
        sql`SELECT name FROM membership_tiers WHERE is_active = true ORDER BY sort_order ASC, id ASC`
      );
      membershipTierOptions = (tierRows.rows as { name: string }[]).map((row, idx) => ({
        label: `${row.name} Membership`,
        value: `${row.name} Membership`,
        displayOrder: idx + 1,
      }));
    } catch (tierErr) {
      logger.warn('[HubSpot] Failed to fetch tiers from DB for property sync, skipping membership_tier options', { error: getErrorMessage(tierErr) });
    }

    const propertiesToCreate = [
      {
        name: 'billing_provider',
        label: 'Billing Provider',
        type: 'enumeration',
        fieldType: 'select',
        groupName: 'contactinformation',
        description: 'The billing system managing this member\'s subscription',
        options: billingProviderOptions
      },
      ...(membershipTierOptions.length > 0 ? [{
        name: 'membership_tier',
        label: 'Membership Tier',
        type: 'enumeration',
        fieldType: 'select',
        groupName: 'contactinformation',
        description: 'The membership tier for this contact',
        options: membershipTierOptions,
      }] : []),
    ];
    
    for (const prop of propertiesToCreate) {
      try {
        const existingProp = await retryableHubSpotRequest(() =>
          hubspot.crm.properties.coreApi.getByName('contacts', prop.name)
        );
        existing.push(prop.name);
        logger.info(`[HubSpot] Property ${prop.name} already exists`);

        if (prop.type === 'enumeration' && prop.options) {
          const existingValues = new Set(
            (existingProp.options || []).map((o: { value: string }) => o.value)
          );
          const missingOptions = prop.options.filter(
            (o: { value: string }) => !existingValues.has(o.value)
          );
          if (missingOptions.length > 0) {
            const allOptions = [
              ...(existingProp.options || []),
              ...missingOptions,
            ];
            await retryableHubSpotRequest(() =>
              hubspot.crm.properties.coreApi.update('contacts', prop.name, {
                options: allOptions,
              } as Parameters<typeof hubspot.crm.properties.coreApi.update>[2])
            );
            logger.info(`[HubSpot] Added options to ${prop.name}: ${missingOptions.map((o: { label: string }) => o.label).join(', ')}`);
          }
        }
      } catch (getError: unknown) {
        if (getErrorCode(getError) === '404' || getErrorMessage(getError)?.includes('not exist')) {
          try {
            await retryableHubSpotRequest(() =>
              hubspot.crm.properties.coreApi.create('contacts', prop as Parameters<typeof hubspot.crm.properties.coreApi.create>[1])
            );
            created.push(prop.name);
            logger.info(`[HubSpot] Created property ${prop.name}`);
          } catch (createError: unknown) {
            errors.push(`${prop.name}: ${getErrorMessage(createError)}`);
            logger.error(`[HubSpot] Failed to create property ${prop.name}:`, { extra: { detail: getErrorMessage(createError) } });
          }
        } else {
          errors.push(`${prop.name}: ${getErrorMessage(getError)}`);
        }
      }
    }
    
    return { success: errors.length === 0, created, existing, errors };
  } catch (error: unknown) {
    logger.error('[HubSpot] Error ensuring properties exist:', { error: getErrorMessage(error) });
    return { success: false, created, existing, errors: [getErrorMessage(error)] };
  }
}
