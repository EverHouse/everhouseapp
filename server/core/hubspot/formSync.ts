import { getHubSpotClientWithFallback } from '../integrations';
import { getErrorMessage } from '../../utils/errorUtils';
import { db } from '../../db';
import { formSubmissions } from '../../../shared/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { notifyAllStaff } from '../notificationService';
import type { Client } from '@hubspot/api-client';

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
let formSyncAccessDeniedLogged = false;
let formSyncAccessDeniedUntil = 0;
let formSyncAuthFailureLogged = false;
let formSyncAuthFailureUntil = 0;

export function resetFormSyncAccessDeniedFlag(): void {
  formSyncAccessDeniedLogged = false;
  formSyncAccessDeniedUntil = 0;
  formSyncAuthFailureLogged = false;
  formSyncAuthFailureUntil = 0;
}

export function getFormSyncStatus(): { accessDenied: boolean; accessDeniedUntil: number | null; authFailure: boolean; authFailureUntil: number | null } {
  return {
    accessDenied: Date.now() < formSyncAccessDeniedUntil,
    accessDeniedUntil: formSyncAccessDeniedUntil > 0 ? formSyncAccessDeniedUntil : null,
    authFailure: Date.now() < formSyncAuthFailureUntil,
    authFailureUntil: formSyncAuthFailureUntil > 0 ? formSyncAuthFailureUntil : null,
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

async function discoverForms(client: Client): Promise<HubSpotForm[]> {
  try {
    const response = await client.apiRequest({
      method: 'GET',
      path: '/marketing/v3/forms/',
    });
    const data = await response.json() as { results?: HubSpotForm[]; total?: number };
    const forms = data.results || [];
    logger.info(`[HubSpot FormSync] Discovered ${forms.length} forms from HubSpot`);
    return forms;
  } catch (err: unknown) {
    const errMsg = getErrorMessage(err);
    if (errMsg.includes('401') || errMsg.includes('403')) {
      throw new Error(`HUBSPOT_FORMS_ACCESS_DENIED: ${errMsg}`);
    }
    logger.warn(`[HubSpot FormSync] Could not discover forms via v3 API: ${errMsg}`);
    return [];
  }
}

async function fetchFormSubmissionsViaClient(
  client: Client,
  formId: string,
  sinceTimestamp: number
): Promise<HubSpotSubmission[]> {
  const allSubmissions: HubSpotSubmission[] = [];
  let after: string | undefined;

  do {
    const queryParams: Record<string, string> = { limit: '50' };
    if (after) {
      queryParams.after = after;
    }

    const response = await client.apiRequest({
      method: 'GET',
      path: `/form-integrations/v1/submissions/forms/${formId}`,
      qs: queryParams,
    });

    if ((response as any).status === 403 || (response as any).status === 401) {
      const body = await response.text().catch(() => '');
      throw new Error(`HUBSPOT_FORMS_ACCESS_DENIED: ${(response as any).status} ${body}`);
    }

    const data: HubSpotSubmissionsResponse = await response.json() as HubSpotSubmissionsResponse;

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

  if (Date.now() < formSyncAccessDeniedUntil) {
    return result;
  }

  if (Date.now() < formSyncAuthFailureUntil) {
    return result;
  }

  try {
    let client: Client;
    let authSource: string;
    try {
      const fallback = await getHubSpotClientWithFallback();
      client = fallback.client;
      authSource = fallback.source;
    } catch (err: unknown) {
      formSyncAuthFailureUntil = Date.now() + 60 * 60 * 1000;
      if (!formSyncAuthFailureLogged) {
        const msg = `No HubSpot client available: ${getErrorMessage(err)}`;
        logger.warn(`[HubSpot FormSync] ${msg}`);
        result.errors.push(msg);
        formSyncAuthFailureLogged = true;
      }
      return result;
    }

    logger.info(`[HubSpot FormSync] Using auth source: ${authSource}`);

    let forms: HubSpotForm[];
    try {
      forms = await discoverForms(client);
    } catch (err: unknown) {
      const errMsg = getErrorMessage(err);
      if (errMsg.includes('HUBSPOT_FORMS_ACCESS_DENIED')) {
        formSyncAccessDeniedUntil = Date.now() + 30 * 60 * 1000;
        logger.warn(`[HubSpot FormSync] Access denied discovering forms (${authSource}): ${errMsg}. Suppressing retries for 30 minutes.`);
        result.errors.push(`Access denied: ${errMsg}`);
        return result;
      }
      throw err;
    }

    if (forms.length === 0) {
      const hardcodedId = 'b69f9fe4-9b3b-4d1e-a689-ba3127e5f8f2';
      forms = [{ id: hardcodedId, name: 'Events Inquiry Form' }];
      logger.info('[HubSpot FormSync] No forms discovered, falling back to hardcoded Events Inquiry form');
    }

    const sinceTimestamp = Date.now() - THIRTY_DAYS_MS;

    for (const form of forms) {
      const formType = inferFormTypeFromName(form.name);
      logger.info(`[HubSpot FormSync] Fetching submissions for "${form.name}" (${form.id}) → type: ${formType}`);

      let submissions: HubSpotSubmission[];
      try {
        submissions = await fetchFormSubmissionsViaClient(client, form.id, sinceTimestamp);
      } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        if (errMsg.includes('HUBSPOT_FORMS_ACCESS_DENIED')) {
          formSyncAccessDeniedUntil = Date.now() + 30 * 60 * 1000;
          logger.warn(`[HubSpot FormSync] Access denied during sync (${errMsg}). Suppressing retries for 30 minutes.`);
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

    logger.info(`[HubSpot FormSync] Sync complete: ${result.totalFetched} fetched, ${result.newInserted} inserted, ${result.skippedDuplicate} duplicates skipped, ${result.errors.length} errors`);
  } catch (err: unknown) {
    logger.error(`[HubSpot FormSync] Unexpected error during sync: ${getErrorMessage(err)}`);
    result.errors.push(`Unexpected sync error: ${getErrorMessage(err)}`);
  }

  return result;
}
