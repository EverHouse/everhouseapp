import { getHubSpotClient } from '../integrations';
import { getErrorMessage, getErrorCode, getErrorStatusCode } from '../../utils/errorUtils';
import { isProduction } from '../db';
import { retryableHubSpotRequest } from './request';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';

import { logger } from '../logger';
export interface SmsPreferences {
  smsPromoOptIn: boolean | null;
  smsTransactionalOptIn: boolean | null;
  smsRemindersOptIn: boolean | null;
}

/**
 * Sync SMS preferences from our database back to HubSpot
 * Maps our fields to HubSpot's SMS consent properties
 */
export async function syncSmsPreferencesToHubSpot(
  email: string,
  preferences: SmsPreferences
): Promise<{ success: boolean; error?: string }> {
  const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('./readOnlyGuard');
  if (isHubSpotReadOnly()) {
    logHubSpotWriteSkipped('sync_sms_preferences', email);
    return { success: true };
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const hubspot = await getHubSpotClient();

    // Search for contact by email
    const searchResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: FilterOperatorEnum.Eq,
            value: normalizedEmail
          }]
        }],
        properties: ['email'],
        limit: 1
      })
    );

    if (!searchResponse.results || searchResponse.results.length === 0) {
      if (!isProduction) {
        logger.info(`[HubSpot SMS Sync] Contact not found for ${normalizedEmail}`);
      }
      return { success: false, error: 'Contact not found in HubSpot' };
    }

    const contactId = searchResponse.results[0].id;

    const smsPropertyMap: Record<string, { value: boolean | null; hubspotProp: string }> = {
      smsPromoOptIn: { value: preferences.smsPromoOptIn, hubspotProp: 'hs_sms_promotional' },
      smsTransactionalOptIn: { value: preferences.smsTransactionalOptIn, hubspotProp: 'hs_sms_customer_updates' },
      smsRemindersOptIn: { value: preferences.smsRemindersOptIn, hubspotProp: 'hs_sms_reminders' },
    };

    const properties: Record<string, string> = {};
    for (const entry of Object.values(smsPropertyMap)) {
      if (entry.value !== null) {
        properties[entry.hubspotProp] = entry.value ? 'true' : 'false';
      }
    }

    if (Object.keys(properties).length === 0) {
      return { success: true };
    }

    try {
      await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.basicApi.update(contactId, { properties })
      );
    } catch (updateError: unknown) {
      const errMsg = getErrorMessage(updateError);
      if (errMsg.includes('PROPERTY_DOESNT_EXIST')) {
        const missingProps = new Set<string>();
        try {
          const rawBody = (updateError as { body?: string | Record<string, unknown> })?.body;
          const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
          const errors = parsed?.errors as { context?: { propertyName?: string[] } }[] | undefined;
          if (Array.isArray(errors)) {
            for (const err of errors) {
              const names = err?.context?.propertyName;
              if (Array.isArray(names)) {
                for (const n of names) missingProps.add(n);
              }
            }
          }
        } catch {
          // noop
        }
        if (missingProps.size === 0) {
          for (const entry of Object.values(smsPropertyMap)) {
            if (errMsg.includes(entry.hubspotProp)) {
              missingProps.add(entry.hubspotProp);
            }
          }
        }

        const existingProps: Record<string, string> = {};
        for (const [, entry] of Object.entries(smsPropertyMap)) {
          if (entry.value !== null && !missingProps.has(entry.hubspotProp)) {
            existingProps[entry.hubspotProp] = entry.value ? 'true' : 'false';
          }
        }

        if (Object.keys(existingProps).length > 0) {
          try {
            await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.update(contactId, { properties: existingProps })
            );
          } catch (retryError: unknown) {
            const retryMsg = getErrorMessage(retryError);
            if (retryMsg.includes('PROPERTY_DOESNT_EXIST')) {
              logger.warn('[HubSpot SMS Sync] Retry also failed — none of the SMS properties exist in HubSpot', {
                extra: { contactId, missingProps: Array.from(missingProps), remainingProps: Object.keys(existingProps) }
              });
            } else {
              throw retryError;
            }
          }
        }
        logger.warn('[HubSpot SMS Sync] Some SMS properties do not exist in HubSpot — skipped missing properties', {
          extra: { contactId, missingProps: Array.from(missingProps) }
        });
        return { success: true };
      }
      throw updateError;
    }

    if (!isProduction) {
      logger.info(`[HubSpot SMS Sync] Updated SMS preferences for contact ${contactId}`);
    }

    return { success: true };

  } catch (error: unknown) {
    const errorMsg = getErrorMessage(error);
    logger.error('[HubSpot SMS Sync] Error syncing SMS preferences:', { error: getErrorMessage(error) });
    return {
      success: false,
      error: errorMsg || 'Failed to sync SMS preferences to HubSpot'
    };
  }
}

export interface ProfileDetails {
  dateOfBirth: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
}

export async function syncProfileDetailsToHubSpot(
  email: string,
  details: ProfileDetails
): Promise<{ success: boolean; error?: string }> {
  const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('./readOnlyGuard');
  if (isHubSpotReadOnly()) {
    logHubSpotWriteSkipped('sync_profile_details', email);
    return { success: true };
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const hubspot = await getHubSpotClient();

    const searchResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: FilterOperatorEnum.Eq,
            value: normalizedEmail
          }]
        }],
        properties: ['email'],
        limit: 1
      })
    );

    if (!searchResponse.results || searchResponse.results.length === 0) {
      if (!isProduction) {
        logger.info(`[HubSpot Profile Sync] Contact not found for ${normalizedEmail}`);
      }
      return { success: false, error: 'Contact not found in HubSpot' };
    }

    const contactId = searchResponse.results[0].id;

    const properties: Record<string, string> = {};
    if (details.dateOfBirth !== undefined) {
      properties.date_of_birth = details.dateOfBirth || '';
    }
    if (details.streetAddress !== undefined) {
      properties.address = details.streetAddress || '';
    }
    if (details.city !== undefined) {
      properties.city = details.city || '';
    }
    if (details.state !== undefined) {
      properties.state = details.state || '';
    }
    if (details.zipCode !== undefined) {
      properties.zip = details.zipCode || '';
    }

    if (Object.keys(properties).length === 0) {
      return { success: true };
    }

    await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.update(contactId, { properties })
    );

    if (!isProduction) {
      logger.info(`[HubSpot Profile Sync] Updated profile details for contact ${contactId}`);
    }

    return { success: true };

  } catch (error: unknown) {
    const errorMsg = getErrorMessage(error);
    logger.error('[HubSpot Profile Sync] Error syncing profile details:', { error: getErrorMessage(error) });
    return {
      success: false,
      error: errorMsg || 'Failed to sync profile details to HubSpot'
    };
  }
}

export interface SyncDayPassPurchaseInput {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  productName: string;
  amountCents: number;
  purchaseDate: Date;
}

export interface SyncDayPassPurchaseResult {
  success: boolean;
  contactId?: string;
  error?: string;
}

/**
 * Sync a day pass purchase to HubSpot for a non-member (visitor)
 * Creates or finds a contact with lifecyclestage 'lead' and adds a note about the purchase
 */
export async function syncDayPassPurchaseToHubSpot(
  data: SyncDayPassPurchaseInput
): Promise<SyncDayPassPurchaseResult> {
  const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('./readOnlyGuard');
  if (isHubSpotReadOnly()) {
    logHubSpotWriteSkipped('sync_day_pass_purchase', data.email);
    return { success: true };
  }

  const { email, firstName, lastName, phone, productName, amountCents, purchaseDate } = data;
  const normalizedEmail = email.toLowerCase().trim();

  try {
    const hubspot = await getHubSpotClient();

    // Step 1: Check if contact exists by email
    let contactId: string | undefined;
    let isNewContact = false;

    try {
      const searchResponse = await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: FilterOperatorEnum.Eq,
              value: normalizedEmail
            }]
          }],
          properties: ['email', 'firstname', 'lastname', 'lifecyclestage', 'hs_lead_status'],
          limit: 1
        })
      );

      if (searchResponse.results && searchResponse.results.length > 0) {
        contactId = searchResponse.results[0].id;
        const currentLifecycle = searchResponse.results[0].properties?.lifecyclestage?.toLowerCase() || '';
        
        if (currentLifecycle !== 'customer' && currentLifecycle !== 'lead') {
          let dayPassLifecycleCleared = false;
          try {
            await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.update(contactId!, { properties: { lifecyclestage: '' } })
            );
            dayPassLifecycleCleared = true;
            const updateProps: Record<string, string> = {
              lifecyclestage: 'lead',
              hs_lead_status: 'NEW'
            };
            if (firstName && !searchResponse.results[0].properties?.firstname) {
              updateProps.firstname = firstName;
            }
            if (lastName && !searchResponse.results[0].properties?.lastname) {
              updateProps.lastname = lastName;
            }
            await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.update(contactId!, { properties: updateProps })
            );
            logger.info(`[DayPassHubSpot] Updated existing contact ${contactId} lifecycle to 'lead' for ${normalizedEmail}`);
          } catch (updateErr: unknown) {
            logger.warn(`[DayPassHubSpot] Failed to update lifecycle for existing contact ${contactId}:`, { error: getErrorMessage(updateErr) });
            if (dayPassLifecycleCleared && currentLifecycle) {
              try {
                await retryableHubSpotRequest(() =>
                  hubspot.crm.contacts.basicApi.update(contactId!, { properties: { lifecyclestage: currentLifecycle } })
                );
                logger.warn(`[DayPassHubSpot] Restored lifecyclestage to '${currentLifecycle}' for ${normalizedEmail} after update failure`);
              } catch (restoreErr: unknown) {
                logger.error(`[DayPassHubSpot] Failed to restore lifecyclestage for ${normalizedEmail}:`, { error: getErrorMessage(restoreErr) });
              }
            }
          }
        }
        
        logger.info(`[DayPassHubSpot] Found existing contact ${contactId} for ${normalizedEmail}`);
      }
    } catch (error: unknown) {
      const statusCode = getErrorStatusCode(error);
      const errorMsg = getErrorMessage(error);

      // Only treat 404 as "not found", other errors should be thrown
      const isNotFoundError = statusCode === 404 || errorMsg.includes('not found');

      if (!isNotFoundError) {
        // Network or auth error - rethrow
        const isNetworkOrAuthError = 
          statusCode === 401 || 
          statusCode === 403 || 
          (statusCode && statusCode >= 500) ||
          errorMsg.includes('ECONNREFUSED') ||
          errorMsg.includes('ETIMEDOUT') ||
          errorMsg.includes('unauthorized') ||
          errorMsg.includes('forbidden');

        if (isNetworkOrAuthError) {
          throw error;
        }
      }

      if (!isProduction) {
        logger.warn('[DayPassHubSpot] Error searching for contact, will create new one:', { error: getErrorMessage(error) });
      }
    }

    // Step 2: Create new contact if not found
    if (!contactId) {
      try {
        const createResponse = await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.basicApi.create({
            properties: {
              email: normalizedEmail,
              firstname: firstName || '',
              lastname: lastName || '',
              phone: phone || '',
              lifecyclestage: 'lead',
              hs_lead_status: 'NEW'
            }
          })
        );

        contactId = createResponse.id;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        isNewContact = true;

        if (!isProduction) {
          logger.info(`[DayPassHubSpot] Created new contact ${contactId} for ${normalizedEmail}`);
        }
      } catch (createError: unknown) {
        const statusCode = getErrorStatusCode(createError) || (getErrorCode(createError) ? Number(getErrorCode(createError)) : undefined);

        // Handle duplicate contact (409 Conflict)
        if (statusCode === 409) {
          // Re-query by email instead of parsing error message
          logger.info(`[DayPassHubSpot] Contact ${normalizedEmail} already exists (409), re-querying...`);
          
          const searchResponse = await retryableHubSpotRequest(() => hubspot.crm.contacts.searchApi.doSearch({
            filterGroups: [{
              filters: [{
                propertyName: 'email',
                operator: FilterOperatorEnum.Eq,
                value: normalizedEmail
              }]
            }],
            properties: ['email', 'firstname', 'lastname'],
            limit: 1
          }));
          
          if (searchResponse.results?.length > 0) {
            contactId = searchResponse.results[0].id;
            logger.info(`[DayPassHubSpot] Found existing contact via re-query: ${contactId}`);
          } else {
            logger.error(`[DayPassHubSpot] 409 conflict but contact not found on re-query`);
            throw createError;
          }
        } else {
          throw createError;
        }
      }
    }

    // Step 3: Add a note about the day pass purchase
    if (contactId) {
      try {
        const amountDollars = (amountCents / 100).toFixed(2);
        const purchaseDateStr = purchaseDate.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
        const noteContent = `Day Pass Purchase: ${productName}\nAmount: $${amountDollars}\nPurchase Date: ${purchaseDateStr}`;

        await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.basicApi.update(contactId!, {
            properties: {
              notes: noteContent
            }
          })
        );

        if (!isProduction) {
          logger.info(`[DayPassHubSpot] Added purchase note to contact ${contactId}`);
        }
      } catch (noteError: unknown) {
        // Log error but don't fail the entire operation - contact was created successfully
        logger.warn('[DayPassHubSpot] Failed to add purchase note to contact:', { error: getErrorMessage(noteError) });
      }
    }

    return {
      success: true,
      contactId
    };

  } catch (error: unknown) {
    const errorMsg = getErrorMessage(error);
    logger.error('[DayPassHubSpot] Error syncing day pass purchase:', { error: getErrorMessage(error) });
    return {
      success: false,
      error: errorMsg || 'Failed to sync day pass purchase to HubSpot'
    };
  }
}
