import { getHubSpotClient } from '../integrations';
import { getErrorMessage, getErrorCode, getErrorStatusCode } from '../../utils/errorUtils';
import { isProduction } from '../db';
import { retryableHubSpotRequest } from './request';

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
  const normalizedEmail = email.toLowerCase().trim();

  try {
    const hubspot = await getHubSpotClient();

    // Search for contact by email
    const searchResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: 'EQ' as any,
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

    // Map our fields to HubSpot SMS consent properties
    const properties: Record<string, string> = {};
    
    if (preferences.smsPromoOptIn !== null) {
      properties.hs_sms_promotional = preferences.smsPromoOptIn ? 'true' : 'false';
    }
    if (preferences.smsTransactionalOptIn !== null) {
      properties.hs_sms_customer_updates = preferences.smsTransactionalOptIn ? 'true' : 'false';
    }
    if (preferences.smsRemindersOptIn !== null) {
      properties.hs_sms_reminders = preferences.smsRemindersOptIn ? 'true' : 'false';
    }

    if (Object.keys(properties).length === 0) {
      return { success: true }; // Nothing to update
    }

    // Update contact with SMS preferences
    await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.update(contactId, { properties })
    );

    if (!isProduction) {
      logger.info(`[HubSpot SMS Sync] Updated SMS preferences for contact ${contactId}`);
    }

    return { success: true };

  } catch (error: unknown) {
    const errorMsg = getErrorMessage(error);
    logger.error('[HubSpot SMS Sync] Error syncing SMS preferences:', { error: error });
    return {
      success: false,
      error: errorMsg || 'Failed to sync SMS preferences to HubSpot'
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
              operator: 'EQ' as any,
              value: normalizedEmail
            }]
          }],
          properties: ['email', 'firstname', 'lastname', 'lifecyclestage', 'hs_lead_status'],
          limit: 1
        })
      );

      if (searchResponse.results && searchResponse.results.length > 0) {
        contactId = searchResponse.results[0].id;
        if (!isProduction) {
          logger.info(`[DayPassHubSpot] Found existing contact ${contactId} for ${normalizedEmail}`);
        }
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
        logger.warn('[DayPassHubSpot] Error searching for contact, will create new one:', { error: error });
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
          
          const searchResponse = await hubspot.crm.contacts.searchApi.doSearch({
            filterGroups: [{
              filters: [{
                propertyName: 'email',
                operator: 'EQ' as any,
                value: normalizedEmail
              }]
            }],
            properties: ['email', 'firstname', 'lastname'],
            limit: 1
          });
          
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
        const purchaseDateStr = purchaseDate.toLocaleDateString('en-US');
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
        logger.warn('[DayPassHubSpot] Failed to add purchase note to contact:', { error: noteError });
      }
    }

    return {
      success: true,
      contactId
    };

  } catch (error: unknown) {
    const errorMsg = getErrorMessage(error);
    logger.error('[DayPassHubSpot] Error syncing day pass purchase:', { error: error });
    return {
      success: false,
      error: errorMsg || 'Failed to sync day pass purchase to HubSpot'
    };
  }
}
