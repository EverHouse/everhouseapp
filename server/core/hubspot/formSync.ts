/**
 * HubSpot Form Sync — pulls form submissions from HubSpot into our database.
 *
 * AUTH HISTORY & ROOT CAUSE (Feb 2026):
 * ----------------------------------------
 * 1. The Replit HubSpot connector token does NOT have the `forms` scope.
 *    It works for contacts, properties, deals, etc. — but NOT for
 *    /marketing/v3/forms/ or /form-integrations/v1/submissions/.
 *
 * 2. The Private App token (HUBSPOT_PRIVATE_APP_TOKEN) DOES have the
 *    `forms` scope. But the SDK's `client.apiRequest()` method fails
 *    in production (auth header gets lost in the HTTP pipeline).
 *
 * 3. The SDK's typed methods (e.g. `client.marketing.forms.formsApi`)
 *    DO work with the Private App token — they use the OpenAPI-generated
 *    auth middleware which properly injects credentials.
 *
 * THE FIX:
 * - Use `getHubSpotPrivateAppClient()` for forms — it has the `forms` scope
 * - Use the typed SDK method `client.marketing.forms.formsApi.getPage()`
 *   for form discovery (proven to work in production)
 * - For submissions (no typed SDK method), use `node-fetch` directly
 *   with the Private App Bearer token
 *
 * NEVER USE FOR FORMS:
 * - `getHubSpotClient()` — connector token lacks `forms` scope
 * - `client.apiRequest()` — auth header breaks in production
 */

import { getHubSpotPrivateAppClient } from '../integrations';
import { getErrorMessage } from '../../utils/errorUtils';
import { db } from '../../db';
import { formSubmissions, systemSettings } from '../../../shared/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { notifyAllStaff } from '../notificationService';
import { Client } from '@hubspot/api-client';
import nodeFetch from 'node-fetch';

import { logger } from '../logger';

const FORM_TYPE_LABELS: Record<string, string> = {
  'tour-request': 'Tour Request',
  'event-inquiry': 'Event Inquiry',
  'membership': 'Membership Application',
  'private-hire': 'Private Hire Inquiry',
  'guest-checkin': 'Guest Check-in',
  'contact': 'Contact Form',
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DB_TOKEN_KEY = 'hubspot_private_app_token';
let authFailureBackoffUntil = 0;
let authFailureAlreadyLogged = false;
let apiErrorBackoffUntil = 0;
let firstSyncCompleted = false;

async function getPrivateAppToken(): Promise<string | null> {
  try {
    logger.info('[HubSpot FormSync] Checking database for Private App token...');
    const rows = await db.select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, DB_TOKEN_KEY))
      .limit(1);
    logger.info(`[HubSpot FormSync] Database query returned ${rows.length} rows`);
    if (rows.length > 0 && rows[0].value) {
      const suffix = rows[0].value.substring(rows[0].value.length - 4);
      logger.info(`[HubSpot FormSync] Found token in database ending ...${suffix}`);
      return rows[0].value;
    }
    logger.info('[HubSpot FormSync] No token found in database, falling back to env var');
  } catch (err: unknown) {
    logger.error(`[HubSpot FormSync] Database token lookup failed: ${getErrorMessage(err)}`);
  }
  return process.env.HUBSPOT_PRIVATE_APP_TOKEN || null;
}

export async function setPrivateAppToken(token: string, updatedBy: string): Promise<void> {
  await db.insert(systemSettings)
    .values({ key: DB_TOKEN_KEY, value: token, category: 'hubspot', updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: token, updatedBy, updatedAt: new Date() },
    });
  authFailureBackoffUntil = 0;
  authFailureAlreadyLogged = false;
  apiErrorBackoffUntil = 0;
  firstSyncCompleted = false;
  logger.info(`[HubSpot FormSync] Private App token updated in database by ${updatedBy}. All backoff flags reset.`);
}

export function resetFormSyncAccessDeniedFlag(): void {
  authFailureBackoffUntil = 0;
  authFailureAlreadyLogged = false;
  apiErrorBackoffUntil = 0;
  firstSyncCompleted = false;
  logger.info('[HubSpot FormSync] All backoff flags reset');
}

export function getFormSyncStatus(): {
  accessDenied: boolean;
  accessDeniedUntil: number | null;
  authFailure: boolean;
  authFailureUntil: number | null;
  firstSyncCompleted: boolean;
} {
  return {
    accessDenied: Date.now() < apiErrorBackoffUntil,
    accessDeniedUntil: apiErrorBackoffUntil > 0 ? apiErrorBackoffUntil : null,
    authFailure: Date.now() < authFailureBackoffUntil,
    authFailureUntil: authFailureBackoffUntil > 0 ? authFailureBackoffUntil : null,
    firstSyncCompleted,
  };
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

interface HubSpotForm {
  id: string;
  name: string;
  formType?: string;
  createdAt?: string;
  updatedAt?: string;
}

function getFieldValue(values: HubSpotSubmissionValue[], fieldName: string): string | null {
  const field = values.find(v => v.name === fieldName);
  return field?.value || null;
}

function inferFormTypeFromName(formName: string): string {
  const name = formName.toLowerCase();
  if (name.includes('check-in') || name.includes('checkin') || name.includes('waiver')) return 'guest-checkin';
  if (name.includes('membership') || name.includes('application')) return 'membership';
  if (name.includes('private') && (name.includes('event') || name.includes('hire'))) return 'private-hire';
  if (name.includes('event') || name.includes('inquiry')) return 'event-inquiry';
  if (name.includes('tour')) return 'tour-request';
  if (name.includes('contact')) return 'contact';
  return 'contact';
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

async function discoverFormsViaSDK(client: Client): Promise<HubSpotForm[]> {
  try {
    const response = await client.marketing.forms.formsApi.getPage();
    const forms: HubSpotForm[] = (response.results || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      formType: f.formType,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }));
    logger.info(`[HubSpot FormSync] Discovered ${forms.length} forms via typed SDK (Private App token with forms scope)`);
    return forms;
  } catch (err: unknown) {
    const errMsg = getErrorMessage(err);
    if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('MISSING_SCOPES')) {
      logger.error(
        `[HubSpot FormSync] API error discovering forms: ${errMsg}. ` +
        `The Private App token needs the 'forms' scope enabled.`
      );
      throw new Error(`HUBSPOT_API_ERROR: ${errMsg}`);
    }
    logger.warn(`[HubSpot FormSync] Could not discover forms via typed SDK: ${errMsg}`);
    return [];
  }
}

async function fetchFormSubmissionsDirectly(
  accessToken: string,
  formId: string,
  sinceTimestamp: number
): Promise<HubSpotSubmission[]> {
  const allSubmissions: HubSpotSubmission[] = [];
  let after: string | undefined;

  do {
    let url = `https://api.hubapi.com/form-integrations/v1/submissions/forms/${formId}?limit=50`;
    if (after) {
      url += `&after=${encodeURIComponent(after)}`;
    }

    const response = await nodeFetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    if (response.status === 401 || response.status === 403) {
      const body = await response.text().catch(() => '');
      logger.error(
        `[HubSpot FormSync] Got ${response.status} fetching submissions for form ${formId}. ` +
        `Token may be expired or missing forms scope. Body: ${body.substring(0, 500)}`
      );
      throw new Error(`HUBSPOT_API_ERROR: ${response.status} ${body.substring(0, 200)}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${body.substring(0, 200)}`);
    }

    const data: HubSpotSubmissionsResponse = await response.json() as HubSpotSubmissionsResponse;

    if (!data.results || !Array.isArray(data.results)) {
      logger.warn(`[HubSpot FormSync] Unexpected response for form ${formId}: no results array`);
      break;
    }

    const recentResults = data.results.filter(s => s.submittedAt >= sinceTimestamp);
    allSubmissions.push(...recentResults);

    if (recentResults.length < data.results.length) {
      break;
    }

    after = data.paging?.next?.after;
  } while (after);

  return allSubmissions;
}

export async function syncHubSpotFormSubmissions(options?: { force?: boolean }): Promise<{
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

  const force = options?.force === true;

  if (!force && Date.now() < authFailureBackoffUntil) {
    logger.info(`[HubSpot FormSync] Skipping sync — auth failure backoff active until ${new Date(authFailureBackoffUntil).toISOString()}`);
    return result;
  }

  if (!force && Date.now() < apiErrorBackoffUntil) {
    logger.info(`[HubSpot FormSync] Skipping sync — API error backoff active until ${new Date(apiErrorBackoffUntil).toISOString()}`);
    return result;
  }

  if (force) {
    authFailureBackoffUntil = 0;
    authFailureAlreadyLogged = false;
    apiErrorBackoffUntil = 0;
    firstSyncCompleted = false;
    logger.info('[HubSpot FormSync] Force sync requested — all backoff flags cleared');
  }

  try {
    const privateAppToken = await getPrivateAppToken();
    if (!privateAppToken) {
      authFailureBackoffUntil = Date.now() + 60 * 60 * 1000;
      if (!authFailureAlreadyLogged) {
        logger.warn('[HubSpot FormSync] No Private App token found (checked database + env var). Form sync requires Private App token with forms scope. Will retry in 1 hour.');
        authFailureAlreadyLogged = true;
      }
      return result;
    }

    const tokenSuffix = privateAppToken.substring(privateAppToken.length - 4);
    logger.info(`[HubSpot FormSync] Using token ...${tokenSuffix} (source: ${privateAppToken === process.env.HUBSPOT_PRIVATE_APP_TOKEN ? 'env' : 'database'})`);

    const client = new Client({ accessToken: privateAppToken });

    logger.info('[HubSpot FormSync] Starting sync using Private App token (has forms scope — connector token does NOT)');

    let forms: HubSpotForm[];
    try {
      forms = await discoverFormsViaSDK(client);
    } catch (err: unknown) {
      const errMsg = getErrorMessage(err);
      if (errMsg.includes('HUBSPOT_API_ERROR')) {
        apiErrorBackoffUntil = Date.now() + 30 * 60 * 1000;
        logger.error(
          `[HubSpot FormSync] API error discovering forms. Error: ${errMsg}. ` +
          `Suppressing retries for 30 minutes.`
        );
        result.errors.push(`API error: ${errMsg}`);
        return result;
      }
      throw err;
    }

    if (forms.length === 0) {
      const hardcodedId = 'b69f9fe4-9b3b-4d1e-a689-ba3127e5f8f2';
      forms = [{ id: hardcodedId, name: 'Events Inquiry Form' }];
      logger.info('[HubSpot FormSync] No forms discovered, falling back to hardcoded Events Inquiry form');
    }

    if (!firstSyncCompleted) {
      logger.info(
        `[HubSpot FormSync] DIAGNOSTIC — First sync this process. ` +
        `Auth: Private App token (typed SDK for discovery + node-fetch for submissions). ` +
        `Forms discovered: ${forms.length}. ` +
        `Form names: ${forms.map(f => f.name).join(', ')}.`
      );
    }

    const sinceTimestamp = Date.now() - THIRTY_DAYS_MS;

    for (const form of forms) {
      const formType = inferFormTypeFromName(form.name);
      logger.info(`[HubSpot FormSync] Fetching submissions for "${form.name}" (${form.id}) → type: ${formType}`);

      let submissions: HubSpotSubmission[];
      try {
        submissions = await fetchFormSubmissionsDirectly(privateAppToken, form.id, sinceTimestamp);
      } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        if (errMsg.includes('HUBSPOT_API_ERROR')) {
          apiErrorBackoffUntil = Date.now() + 30 * 60 * 1000;
          logger.error(
            `[HubSpot FormSync] API error fetching submissions for "${form.name}". ` +
            `Error: ${errMsg}. Suppressing retries for 30 minutes.`
          );
          break;
        }
        const msg = `Failed to fetch form "${form.name}" (${form.id}): ${errMsg}`;
        logger.error(`[HubSpot FormSync] ${msg}`);
        result.errors.push(msg);
        continue;
      }

      if (submissions.length === 0) continue;

      result.totalFetched += submissions.length;
      logger.info(`[HubSpot FormSync] Found ${submissions.length} submissions for "${form.name}"`);

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

          const resolvedFormType = submission.pageUrl
            ? inferFormTypeFromPageUrl(submission.pageUrl, formType)
            : formType;

          const email = getFieldValue(submission.values, 'email') || '';
          if (!email) {
            continue;
          }

          const windowStart = new Date(submission.submittedAt - 5 * 60 * 1000);
          const windowEnd = new Date(submission.submittedAt + 5 * 60 * 1000);
          const localMatch = await db.select({ id: formSubmissions.id })
            .from(formSubmissions)
            .where(and(
              eq(formSubmissions.email, email),
              eq(formSubmissions.formType, resolvedFormType),
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
          metadataFields['hubspotFormName'] = form.name;

          const insertResult = await db.insert(formSubmissions).values({
            formType: resolvedFormType,
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
          }).returning({ id: formSubmissions.id });

          result.newInserted++;

          const formLabel = FORM_TYPE_LABELS[resolvedFormType] || 'Form Submission';
          const submitterName = [firstName, lastName].filter(Boolean).join(' ') || email || 'Someone';
          const staffMessage = `${submitterName} submitted a ${formLabel}`;
          const notificationUrl = resolvedFormType === 'membership' ? '/admin/applications' : '/admin/inquiries';
          const notificationRelatedType = resolvedFormType === 'membership' ? 'application' : 'inquiry';

          notifyAllStaff(
            `New ${formLabel}`,
            staffMessage,
            'system',
            {
              relatedId: insertResult[0]?.id,
              relatedType: notificationRelatedType,
              url: notificationUrl
            }
          ).catch(err => logger.error('[HubSpot FormSync] Staff notification failed:', { extra: { err } }));
        } catch (err: unknown) {
          const msg = `Failed to insert submission ${submission.conversionId}: ${getErrorMessage(err)}`;
          logger.error(`[HubSpot FormSync] ${msg}`);
          result.errors.push(msg);
        }
      }
    }

    firstSyncCompleted = true;
    authFailureAlreadyLogged = false;
    logger.info(`[HubSpot FormSync] Sync complete: ${result.totalFetched} fetched, ${result.newInserted} inserted, ${result.skippedDuplicate} duplicates skipped, ${result.errors.length} errors`);
  } catch (err: unknown) {
    logger.error(`[HubSpot FormSync] Unexpected error during sync: ${getErrorMessage(err)}`);
    result.errors.push(`Unexpected sync error: ${getErrorMessage(err)}`);
  }

  return result;
}
