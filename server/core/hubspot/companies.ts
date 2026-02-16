import { getHubSpotClient } from '../integrations';
import { getErrorMessage, getErrorCode, getErrorStatusCode } from '../../utils/errorUtils';
import { isProduction } from '../db';
import { retryableHubSpotRequest } from './request';

export interface SyncCompanyInput {
  companyName: string;
  userEmail: string;
  userHubSpotContactId?: string;
  domain?: string;
}

export interface SyncCompanyResult {
  success: boolean;
  hubspotCompanyId?: string;
  created?: boolean;
  error?: string;
}

function extractDomainFromEmail(email: string): string {
  const parts = email.toLowerCase().trim().split('@');
  return parts.length === 2 ? parts[1] : '';
}

export async function syncCompanyToHubSpot(
  input: SyncCompanyInput
): Promise<SyncCompanyResult> {
  const { companyName, userEmail, userHubSpotContactId } = input;
  const domain = input.domain || extractDomainFromEmail(userEmail);
  const normalizedEmail = userEmail.toLowerCase().trim();

  try {
    const hubspot = await getHubSpotClient();

    let companyId: string | undefined;
    let created = false;

    const searchFilters = [];
    if (companyName) {
      searchFilters.push({
        filters: [{
          propertyName: 'name',
          operator: 'EQ' as const,
          value: companyName
        }]
      });
    }
    if (domain) {
      searchFilters.push({
        filters: [{
          propertyName: 'domain',
          operator: 'EQ' as const,
          value: domain
        }]
      });
    }

    if (searchFilters.length > 0) {
      try {
        const searchResponse = await retryableHubSpotRequest(() =>
          hubspot.crm.companies.searchApi.doSearch({
            filterGroups: searchFilters,
            properties: ['name', 'domain'],
            limit: 1
          })
        );

        if (searchResponse.results && searchResponse.results.length > 0) {
          companyId = searchResponse.results[0].id;
          if (!isProduction) {
            console.log(`[CompanyHubSpot] Found existing company ${companyId} for "${companyName}" or domain "${domain}"`);
          }
        }
      } catch (error: unknown) {
        const statusCode = getErrorStatusCode(error);
        const errorMsg = getErrorMessage(error);
        const isNotFoundError = statusCode === 404 || errorMsg.includes('not found');

        if (!isNotFoundError) {
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
          console.warn('[CompanyHubSpot] Error searching for company, will create new one:', error);
        }
      }
    }

    if (!companyId) {
      try {
        const createResponse = await retryableHubSpotRequest(() =>
          hubspot.crm.companies.basicApi.create({
            properties: {
              name: companyName,
              domain: domain || ''
            }
          })
        );

        companyId = createResponse.id;
        created = true;

        if (!isProduction) {
          console.log(`[CompanyHubSpot] Created new company ${companyId} for "${companyName}"`);
        }
      } catch (createError: unknown) {
        const statusCode = getErrorStatusCode(createError) || (getErrorCode(createError) ? Number(getErrorCode(createError)) : undefined);
        const errorBody = createError && typeof createError === 'object' && 'body' in createError ? (createError as { body?: { message?: string } }).body : (createError && typeof createError === 'object' && 'response' in createError ? (createError as { response?: { body?: { message?: string } } }).response?.body : undefined);

        if (statusCode === 409 && errorBody?.message) {
          const match = errorBody.message.match(/Existing ID:\s*(\d+)/);
          if (match && match[1]) {
            companyId = match[1];
            if (!isProduction) {
              console.log(`[CompanyHubSpot] Company "${companyName}" already exists (ID: ${companyId}), using existing`);
            }
          } else {
            throw createError;
          }
        } else {
          throw createError;
        }
      }
    }

    let contactId = userHubSpotContactId;
    if (!contactId) {
      try {
        const contactSearchResponse = await retryableHubSpotRequest(() =>
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

        if (contactSearchResponse.results && contactSearchResponse.results.length > 0) {
          contactId = contactSearchResponse.results[0].id;
          if (!isProduction) {
            console.log(`[CompanyHubSpot] Found contact ${contactId} for ${normalizedEmail}`);
          }
        }
      } catch (error: unknown) {
        if (!isProduction) {
          console.warn('[CompanyHubSpot] Error searching for contact:', error);
        }
      }
    }

    if (companyId && contactId) {
      try {
        await retryableHubSpotRequest(() =>
          hubspot.crm.associations.v4.basicApi.create(
            'companies',
            companyId!,
            'contacts',
            contactId!,
            [{ associationCategory: 'HUBSPOT_DEFINED' as any, associationTypeId: 280 }]
          )
        );

        if (!isProduction) {
          console.log(`[CompanyHubSpot] Associated contact ${contactId} with company ${companyId}`);
        }
      } catch (assocError: unknown) {
        console.warn('[CompanyHubSpot] Failed to associate contact with company:', assocError);
      }
    }

    return {
      success: true,
      hubspotCompanyId: companyId,
      created
    };

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[CompanyHubSpot] Error syncing company:', error);
    return {
      success: false,
      error: errorMsg || 'Failed to sync company to HubSpot'
    };
  }
}
