import { db } from '../../db';
import { getErrorMessage, getErrorCode, getErrorStatusCode } from '../../utils/errorUtils';
import { isProduction } from '../db';
import { getHubSpotClient } from '../integrations';
import { sql } from 'drizzle-orm';
import { retryableHubSpotRequest } from './request';
import { DB_STATUS_TO_HUBSPOT_STATUS, DB_BILLING_PROVIDER_TO_HUBSPOT } from './constants';
import { isPlaceholderEmail } from '../stripe/customers';
import { getTodayPacific } from '../../utils/dateUtils';

import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import { logger } from '../logger';
export interface AddMemberInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  tier: string;
  startDate?: string;
  discountReason?: string;
  createdBy: string;
  createdByName?: string;
}

export interface AddMemberResult {
  success: boolean;
  userId?: string;
  hubspotContactId?: string;
  hubspotDealId?: string;
  lineItemId?: string;
  error?: string;
}

export async function findOrCreateHubSpotContact(
  email: string,
  firstName: string,
  lastName: string,
  phone?: string,
  tier?: string,
  options?: { role?: string }
): Promise<{ contactId: string; isNew: boolean }> {
  if (isPlaceholderEmail(email)) {
    logger.info(`[HubSpot] Skipping contact creation for placeholder email: ${email}`);
    throw new Error(`Cannot create HubSpot contact for placeholder email: ${email}`);
  }
  
  const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('./readOnlyGuard');
  const hubspot = await getHubSpotClient();

  let dbStatus: string | null = null;
  try {
    const dbResult = await db.execute(sql`SELECT membership_status FROM users WHERE LOWER(email) = ${email.toLowerCase()} LIMIT 1`);
    if (dbResult.rows.length > 0) {
      const row = dbResult.rows[0] as { membership_status: string | null };
      dbStatus = row.membership_status;
    }
  } catch (dbErr: unknown) {
    logger.warn(`[HubSpot] Failed to look up DB status for ${email}:`, { error: dbErr });
  }
  
  try {
    const searchResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: FilterOperatorEnum.Eq,
            value: email.toLowerCase()
          }]
        }],
        properties: ['email', 'firstname', 'lastname', 'phone', 'lifecyclestage', 'membership_status'],
        limit: 1
      })
    );
    
    if (searchResponse.results && searchResponse.results.length > 0) {
      const existingContact = searchResponse.results[0];
      const contactId = existingContact.id;
      const currentLifecycle = existingContact.properties?.lifecyclestage?.toLowerCase() || '';
      const isVisitor = options?.role === 'visitor' || options?.role === 'day-pass';
      
      const targetLifecycle = isVisitor ? 'lead' : 'customer';
      const resolvedHubSpotStatus = isVisitor ? 'Non-Member' : (dbStatus ? (DB_STATUS_TO_HUBSPOT_STATUS[dbStatus] || 'Active') : 'Active');
      const targetStatus = resolvedHubSpotStatus;
      
      const shouldUpdateLifecycle = isVisitor
        ? currentLifecycle !== 'customer' && currentLifecycle !== 'lead'
        : currentLifecycle !== 'customer';
      
      const currentStatus = existingContact.properties?.membership_status || '';
      const shouldUpdateStatus = currentStatus !== targetStatus;
      
      const updateProps: Record<string, string> = {};
      
      if (shouldUpdateLifecycle) {
        updateProps.lifecyclestage = targetLifecycle;
      }
      if (shouldUpdateLifecycle || shouldUpdateStatus) {
        updateProps.membership_status = targetStatus;
      }
      
      if (firstName && !existingContact.properties?.firstname) {
        updateProps.firstname = firstName;
      }
      if (lastName && !existingContact.properties?.lastname) {
        updateProps.lastname = lastName;
      }
      if (phone && !existingContact.properties?.phone) {
        updateProps.phone = phone;
      }
      
      if (Object.keys(updateProps).length > 0) {
        if (isHubSpotReadOnly()) {
          logHubSpotWriteSkipped('update_existing_contact', email.toLowerCase());
        } else {
          try {
            if (updateProps.lifecyclestage) {
              await retryableHubSpotRequest(() =>
                hubspot.crm.contacts.basicApi.update(contactId, { properties: { lifecyclestage: '' } })
              );
            }
            await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.update(contactId, { properties: updateProps })
            );
            logger.info(`[HubSpot] Updated existing contact ${contactId} for ${email.toLowerCase()}: ${JSON.stringify(updateProps)}`);
          } catch (updateErr: unknown) {
            if (updateProps.lifecyclestage) {
              try {
                await retryableHubSpotRequest(() =>
                  hubspot.crm.contacts.basicApi.update(contactId, { properties: { lifecyclestage: currentLifecycle || 'lead' } })
                );
                logger.warn(`[HubSpot] Restored lifecycle to '${currentLifecycle || 'lead'}' for contact ${contactId} after update failure`);
              } catch (restoreErr: unknown) {
                logger.error(`[HubSpot] CRITICAL: Contact ${contactId} may have blank lifecycle after failed update + failed restore`, { error: restoreErr });
              }
            }
            logger.warn(`[HubSpot] Failed to update existing contact ${contactId} for ${email.toLowerCase()}:`, { error: updateErr });
          }
        }
      }
      
      return { contactId, isNew: false };
    }
  } catch (error: unknown) {
    const statusCode = getErrorStatusCode(error);
    const errorMsg = getErrorMessage(error);
    
    const isNotFoundError = statusCode === 404 || errorMsg.includes('not found');
    
    const isNetworkOrAuthError = 
      !isNotFoundError && (
        statusCode === 401 || 
        statusCode === 403 || 
        (statusCode && statusCode >= 500) ||
        errorMsg.includes('ECONNREFUSED') ||
        errorMsg.includes('ETIMEDOUT') ||
        errorMsg.includes('unauthorized') ||
        errorMsg.includes('forbidden')
      );
    
    if (isNetworkOrAuthError) {
      logger.error('[HubSpot] Network/Auth error during contact search:', { error: error });
      throw error;
    }
    
    if (!isProduction) logger.warn('[HubSpot] Error searching for contact, will create new one:', { error: error });
  }
  
  if (isHubSpotReadOnly()) {
    logHubSpotWriteSkipped('create_contact', email.toLowerCase());
    return { contactId: '', isNew: false };
  }

  try {
    const { denormalizeTierForHubSpotAsync } = await import('../../utils/tierUtils');
    const hubspotTier = tier ? await denormalizeTierForHubSpotAsync(tier) : null;
    
    const isVisitor = options?.role === 'visitor' || options?.role === 'day-pass';
    const newContactStatus = isVisitor ? 'Non-Member' : (dbStatus ? (DB_STATUS_TO_HUBSPOT_STATUS[dbStatus] || 'Active') : 'Active');
    const properties: Record<string, string> = {
      email: email.toLowerCase(),
      firstname: firstName,
      lastname: lastName,
      phone: phone || '',
      membership_status: newContactStatus,
      lifecyclestage: isVisitor ? 'lead' : 'customer'
    };
    
    if (hubspotTier) {
      properties.membership_tier = hubspotTier;
    }
    
    const createResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.create({ properties })
    );
    
    return { contactId: createResponse.id, isNew: true };
  } catch (createError: unknown) {
    const statusCode = getErrorStatusCode(createError) || (getErrorCode(createError) ? Number(getErrorCode(createError)) : undefined);
    const errorBody = createError && typeof createError === 'object' && 'body' in createError ? (createError as { body?: { message?: string } }).body : (createError && typeof createError === 'object' && 'response' in createError ? (createError as { response?: { body?: { message?: string } } }).response?.body : undefined);
    
    if (statusCode === 409 && errorBody?.message) {
      const match = errorBody.message.match(/Existing ID:\s*(\d+)/);
      if (match && match[1]) {
        logger.info(`[HubSpot] Contact ${email} already exists (ID: ${match[1]}), using existing`);
        return { contactId: match[1], isNew: false };
      }
    }
    
    throw createError;
  }
}

export interface CreateMemberLocallyResult {
  success: boolean;
  userId?: string;
  error?: string;
}

export async function createMemberLocally(input: AddMemberInput): Promise<CreateMemberLocallyResult> {
  const { firstName, lastName, email, phone, tier, startDate, discountReason } = input;
  const normalizedEmail = email.toLowerCase().trim();
  
  const exclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${normalizedEmail}`);
  if (exclusionCheck.rows.length > 0) {
    return { success: false, error: 'This email belongs to a permanently deleted member and cannot be re-added. Remove them from the sync exclusions list first if this is intentional.' };
  }
  
  if (!tier || tier.trim() === '') {
    return { success: false, error: 'Membership tier is required when creating a member' };
  }
  
  try {
    const { resolveUserByEmail } = await import('../stripe/customers');
    const resolved = await resolveUserByEmail(normalizedEmail);

    const existingUser = resolved
      ? await db.execute(sql`SELECT id, email, role, membership_status FROM users WHERE id = ${resolved.userId}`)
      : await db.execute(sql`SELECT id, email, role, membership_status FROM users WHERE LOWER(email) = ${normalizedEmail}`);

    if (resolved && resolved.matchType !== 'direct') {
      logger.info(`[AddMember] Email ${normalizedEmail} resolved to existing user ${resolved.primaryEmail} via ${resolved.matchType}`);
    }
    
    const existingRows = existingUser.rows as Array<Record<string, unknown>>;
    if (existingRows.length > 0) {
      const existing = existingRows[0];
      if (existing.role === 'member' && existing.membership_status === 'active') {
        return { success: false, error: 'A member with this email already exists' };
      }
      
      const updateResult = await db.execute(sql`UPDATE users SET 
          first_name = COALESCE(NULLIF(${firstName}, ''), first_name),
          last_name = COALESCE(NULLIF(${lastName}, ''), last_name),
          phone = COALESCE(NULLIF(${phone || null}, ''), phone),
          role = 'member',
          tier = ${tier},
          membership_status = 'active',
          membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END,
          billing_provider = COALESCE(billing_provider, 'stripe'),
          join_date = COALESCE(join_date, ${startDate || getTodayPacific()}),
          discount_code = ${discountReason || null},
          updated_at = NOW()
        WHERE id = ${existing.id}
        RETURNING id`);
      
      logger.info(`[AddMember] Converted existing visitor ${normalizedEmail} to member with tier ${tier}`);

      findOrCreateHubSpotContact(normalizedEmail, firstName, lastName, phone || undefined, tier)
        .catch((err: unknown) => logger.error(`[AddMember] HubSpot contact sync failed for converted visitor ${normalizedEmail}:`, { extra: { detail: getErrorMessage(err) } }));

      return { success: true, userId: String((updateResult.rows as Array<Record<string, unknown>>)[0].id) };
    }
    
    const tags: string[] = [];
    const result = await db.execute(sql`INSERT INTO users (
        email, first_name, last_name, phone, role, tier, 
        membership_status, billing_provider,
        tags, discount_code, data_source, join_date, created_at, updated_at
      ) VALUES (${normalizedEmail}, ${firstName}, ${lastName}, ${phone || null}, 'member', ${tier}, 'active', 'stripe', ${JSON.stringify(tags)}, ${discountReason || null}, 'staff_manual', ${startDate || getTodayPacific()}, NOW(), NOW())
      RETURNING id`);

    findOrCreateHubSpotContact(normalizedEmail, firstName, lastName, phone || undefined, tier)
      .catch((err: unknown) => logger.error(`[AddMember] HubSpot contact sync failed for ${normalizedEmail}:`, { extra: { detail: getErrorMessage(err) } }));
    
    return { success: true, userId: String((result.rows as Array<Record<string, unknown>>)[0].id) };
  } catch (error: unknown) {
    logger.error('[AddMember] Failed to create user locally:', { error: error });
    return { success: false, error: getErrorMessage(error) || 'Failed to create member' };
  }
}

export async function syncNewMemberToHubSpot(_input: AddMemberInput): Promise<void> {
  logger.info(`[HubSpot] Deal creation disabled — skipping syncNewMemberToHubSpot`);
  return;
}

export async function syncTierToHubSpot(params: {
  email: string;
  newTier: string;
  oldTier?: string;
  changedBy?: string;
  changedByName?: string;
}): Promise<void> {
  const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('./readOnlyGuard');
  if (isHubSpotReadOnly()) {
    logHubSpotWriteSkipped('sync_tier', params.email);
    return;
  }

  const { email, newTier } = params;
  const normalizedEmail = email.toLowerCase().trim();
  
  const { denormalizeTierForHubSpotAsync } = await import('../../utils/tierUtils');
  const hubspotTier = await denormalizeTierForHubSpotAsync(newTier);
  const isTierCleared = !newTier || newTier === '';
  
  if (!hubspotTier && !isTierCleared) {
    logger.info(`[HubSpot TierSync] Unknown tier "${newTier}" for ${normalizedEmail}, skipping HubSpot sync`);
    return;
  }
  
  const userResult = await db.execute(sql`SELECT hubspot_id, billing_provider, membership_status FROM users WHERE LOWER(email) = ${normalizedEmail}`);
  
  const userRows = userResult.rows as Array<Record<string, unknown>>;
  if (userRows.length === 0 || !userRows[0].hubspot_id) {
    logger.info(`[HubSpot TierSync] No HubSpot ID for ${normalizedEmail}, skipping sync`);
    return;
  }
  
  const hubspotContactId = userRows[0].hubspot_id as string;
  const billingProvider = userRows[0].billing_provider as string;
  const membershipStatus = userRows[0].membership_status as string;
  
  const hubspotBillingProvider = billingProvider ? (DB_BILLING_PROVIDER_TO_HUBSPOT[(billingProvider as string).toLowerCase()] || 'manual') : undefined;
  
  const normalizedStatus = (membershipStatus || '').toLowerCase();
  const hubspotStatus = DB_STATUS_TO_HUBSPOT_STATUS[normalizedStatus] || 'Suspended';
  const isActive = ['active', 'trialing', 'past_due'].includes(normalizedStatus);
  const lifecyclestage = isActive ? 'customer' : 'other';
  
  try {
    const hubspot = await getHubSpotClient();
    
    const isMindbodyBilled = (billingProvider || '').toLowerCase() === 'mindbody';

    const properties: Record<string, string> = {
      membership_tier: hubspotTier || '',
      membership_status: hubspotStatus,
      lifecyclestage: lifecyclestage
    };
    
    if (!isMindbodyBilled) {
      const midnightUtc = new Date();
      midnightUtc.setUTCHours(0, 0, 0, 0);
      properties.last_modified_at = midnightUtc.getTime().toString();
    }
    
    if (hubspotBillingProvider) {
      properties.billing_provider = hubspotBillingProvider;
    }
    
    try {
      await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.basicApi.update(hubspotContactId, { properties: { lifecyclestage: '' } })
      );
    } catch (clearError: unknown) {
      logger.warn(`[HubSpot TierSync] Could not clear lifecyclestage for ${normalizedEmail} before setting to '${lifecyclestage}':`, { error: clearError });
    }

    try {
      await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.basicApi.update(hubspotContactId, { properties })
      );
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
          logger.info(`[HubSpot TierSync] Retrying ${normalizedEmail} without missing properties: ${invalidProps.join(', ')}`);
          await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.basicApi.update(hubspotContactId, { properties: validProperties })
          );
        } else {
          logger.warn(`[HubSpot TierSync] All properties invalid for ${normalizedEmail}: ${invalidProps.join(', ')}`);
          return;
        }
      } else {
        throw updateError;
      }
    }
    
    logger.info(`[HubSpot TierSync] Updated contact ${normalizedEmail}: tier="${hubspotTier}", status="${hubspotStatus}", lifecycle="${lifecyclestage}", billing="${hubspotBillingProvider || 'not set'}"`);
  } catch (error: unknown) {
    logger.error(`[HubSpot TierSync] Failed to sync tier for ${normalizedEmail}:`, { error: error });
    throw error;
  }
}
