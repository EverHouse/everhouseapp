import { getHubSpotAccessToken } from '../integrations';
import { getErrorMessage } from '../../utils/errorUtils';
import { db } from '../../db';
import { formSubmissions } from '../../../shared/schema';
import { eq, and, gte, lte } from 'drizzle-orm';

import { logger } from '../logger';
const HUBSPOT_FORMS: Record<string, string> = {
  'tour-request': process.env.HUBSPOT_FORM_TOUR_REQUEST || '',
  'membership': process.env.HUBSPOT_FORM_MEMBERSHIP || '',
  'private-hire': process.env.HUBSPOT_FORM_PRIVATE_HIRE || 'b69f9fe4-9b3b-4d1e-a689-ba3127e5f8f2',
  'event-inquiry': process.env.HUBSPOT_FORM_EVENT_INQUIRY || 'b69f9fe4-9b3b-4d1e-a689-ba3127e5f8f2',
  'guest-checkin': process.env.HUBSPOT_FORM_GUEST_CHECKIN || '',
  'contact': process.env.HUBSPOT_FORM_CONTACT || '',
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
let formSyncAccessDeniedLogged = false;

export function resetFormSyncAccessDeniedFlag(): void {
  formSyncAccessDeniedLogged = false;
}

interface HubSpotSubmissionValue {
  name: string;
  value: string;
}

interface HubSpotSubmission {
  conversionId: string;
  submittedAt: number;
  values: HubSpotSubmissionValue[];
  pageUrl?: string;
}

interface HubSpotSubmissionsResponse {
  results: HubSpotSubmission[];
  paging?: {
    next?: {
      after: string;
      link: string;
    };
  };
}

function getFieldValue(values: HubSpotSubmissionValue[], fieldName: string): string | null {
  const field = values.find(v => v.name === fieldName);
  return field?.value || null;
}

function inferFormTypeFromPageUrl(pageUrl: string | undefined, defaultType: string): string {
  if (!pageUrl) return defaultType;
  const url = pageUrl.toLowerCase();
  if (url.includes('private-hire') || url.includes('privatehire')) return 'private-hire';
  if (url.includes('event')) return 'event-inquiry';
  if (url.includes('tour')) return 'tour-request';
  if (url.includes('membership')) return 'membership';
  if (url.includes('contact')) return 'contact';
  if (url.includes('checkin') || url.includes('check-in')) return 'guest-checkin';
  return defaultType;
}

async function fetchFormSubmissions(
  formId: string,
  accessToken: string,
  sinceTimestamp: number
): Promise<HubSpotSubmission[]> {
  const allSubmissions: HubSpotSubmission[] = [];
  let after: string | undefined;

  do {
    const url = new URL(`https://api.hubapi.com/form-integrations/v1/submissions/forms/${formId}`);
    url.searchParams.set('limit', '50');
    if (after) {
      url.searchParams.set('after', after);
    }

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    if (response.status === 403) {
      throw new Error('HUBSPOT_FORMS_ACCESS_DENIED');
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new Error(`HubSpot API error ${response.status}: ${errorText}`);
    }

    const data: HubSpotSubmissionsResponse = await response.json();

    const recentResults = data.results.filter(s => s.submittedAt >= sinceTimestamp);
    allSubmissions.push(...recentResults);

    if (recentResults.length < data.results.length) {
      break;
    }

    after = data.paging?.next?.after;
  } while (after);

  return allSubmissions;
}

export async function syncHubSpotFormSubmissions(): Promise<{
  totalFetched: number;
  newInserted: number;
  skippedDuplicate: number;
  errors: string[];
}> {
  const result = {
    totalFetched: 0,
    newInserted: 0,
    skippedDuplicate: 0,
    errors: [] as string[],
  };

  try {
    let accessToken: string;
    const privateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (privateAppToken) {
      accessToken = privateAppToken;
    } else {
      try {
        accessToken = await getHubSpotAccessToken();
      } catch (err: unknown) {
        const msg = `Failed to get HubSpot access token: ${getErrorMessage(err)}`;
        logger.error(`[HubSpot FormSync] ${msg}`);
        result.errors.push(msg);
        return result;
      }
    }

    const sinceTimestamp = Date.now() - THIRTY_DAYS_MS;

    const formIdToTypes = new Map<string, string[]>();
    for (const [formType, formId] of Object.entries(HUBSPOT_FORMS)) {
      if (!formId) continue;
      const existing = formIdToTypes.get(formId) || [];
      existing.push(formType);
      formIdToTypes.set(formId, existing);
    }

    for (const [formId, formTypes] of formIdToTypes.entries()) {
      const defaultFormType = formTypes[0];
      logger.info(`[HubSpot FormSync] Fetching submissions for form ${formId} (types: ${formTypes.join(', ')})`);

      let submissions: HubSpotSubmission[];
      try {
        submissions = await fetchFormSubmissions(formId, accessToken, sinceTimestamp);
      } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        if (errMsg.includes('HUBSPOT_FORMS_ACCESS_DENIED')) {
          if (!formSyncAccessDeniedLogged) {
            logger.warn('[HubSpot FormSync] Access denied (403) - token may lack "forms" scope. Skipping remaining forms.');
            formSyncAccessDeniedLogged = true;
          }
          break;
        }
        const msg = `Failed to fetch form ${formId}: ${errMsg}`;
        logger.error(`[HubSpot FormSync] ${msg}`);
        result.errors.push(msg);
        continue;
      }

      result.totalFetched += submissions.length;
      logger.info(`[HubSpot FormSync] Found ${submissions.length} submissions for form ${formId}`);

      for (const submission of submissions) {
        try {
          const existing = await db.select({ id: formSubmissions.id })
            .from(formSubmissions)
            .where(eq(formSubmissions.hubspotSubmissionId, submission.conversionId))
            .limit(1);

          if (existing.length > 0) {
            result.skippedDuplicate++;
            continue;
          }

          const formType = formTypes.length > 1
            ? inferFormTypeFromPageUrl(submission.pageUrl, defaultFormType)
            : defaultFormType;

          const email = getFieldValue(submission.values, 'email') || '';
          if (!email) {
            continue;
          }

          const submittedAt = new Date(submission.submittedAt);
          const windowStart = new Date(submission.submittedAt - 5 * 60 * 1000);
          const windowEnd = new Date(submission.submittedAt + 5 * 60 * 1000);
          const localMatch = await db.select({ id: formSubmissions.id })
            .from(formSubmissions)
            .where(and(
              eq(formSubmissions.email, email),
              eq(formSubmissions.formType, formType),
              gte(formSubmissions.createdAt, windowStart),
              lte(formSubmissions.createdAt, windowEnd),
            ))
            .limit(1);

          if (localMatch.length > 0) {
            await db.update(formSubmissions)
              .set({ hubspotSubmissionId: submission.conversionId })
              .where(eq(formSubmissions.id, localMatch[0].id));
            result.skippedDuplicate++;
            continue;
          }

          const firstName = getFieldValue(submission.values, 'firstname');
          const lastName = getFieldValue(submission.values, 'lastname');
          const phone = getFieldValue(submission.values, 'phone');
          const message = getFieldValue(submission.values, 'message')
            || getFieldValue(submission.values, 'comments')
            || getFieldValue(submission.values, 'inquiry_details');

          const metadataFields: Record<string, string> = {};
          for (const v of submission.values) {
            if (!['email', 'firstname', 'lastname', 'phone', 'message', 'comments', 'inquiry_details'].includes(v.name)) {
              metadataFields[v.name] = v.value;
            }
          }
          if (submission.pageUrl) {
            metadataFields['pageUrl'] = submission.pageUrl;
          }

          await db.insert(formSubmissions).values({
            formType,
            firstName,
            lastName,
            email,
            phone,
            message,
            metadata: Object.keys(metadataFields).length > 0 ? metadataFields : null,
            status: 'new',
            hubspotSubmissionId: submission.conversionId,
            createdAt: new Date(submission.submittedAt),
            updatedAt: new Date(submission.submittedAt),
          });

          result.newInserted++;
        } catch (err: unknown) {
          const msg = `Failed to insert submission ${submission.conversionId}: ${getErrorMessage(err)}`;
          logger.error(`[HubSpot FormSync] ${msg}`);
          result.errors.push(msg);
        }
      }
    }

    logger.info(`[HubSpot FormSync] Sync complete: ${result.totalFetched} fetched, ${result.newInserted} inserted, ${result.skippedDuplicate} duplicates skipped, ${result.errors.length} errors`);
  } catch (err: unknown) {
    logger.error(`[HubSpot FormSync] Unexpected error during sync: ${getErrorMessage(err)}`);
    result.errors.push(`Unexpected sync error: ${getErrorMessage(err)}`);
  }

  return result;
}
