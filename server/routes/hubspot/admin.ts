import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { getSessionUser } from '../../types/session';
import { getErrorMessage, getErrorStatusCode, safeErrorDetail } from '../../utils/errorUtils';
import { getHubSpotClient, getHubSpotClientWithFallback } from '../../core/integrations';
import {
  HubSpotApiObject,
  LastActivityRow,
  retryableHubSpotRequest,
  normalizeDateToYYYYMMDD,
} from './shared';

const router = Router();

router.post('/api/admin/hubspot/sync-form-submissions', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { syncHubSpotFormSubmissions } = await import('../../core/hubspot/formSync');
    const result = await syncHubSpotFormSubmissions({ force: true });
    res.json(result);
  } catch (error: unknown) {
    logger.error('[HubSpot FormSync] Manual sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync form submissions' });
  }
});

router.get('/api/admin/hubspot/form-sync-status', isAdmin, async (_req: Request, res: Response) => {
  try {
    const { getFormSyncStatus } = await import('../../core/hubspot/formSync');
    res.json(getFormSyncStatus());
  } catch (error: unknown) {
    logger.error('[HubSpot FormSync] Status check error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get form sync status' });
  }
});

router.post('/api/admin/hubspot/form-sync-reset', isAdmin, async (_req: Request, res: Response) => {
  try {
    const { resetFormSyncAccessDeniedFlag } = await import('../../core/hubspot/formSync');
    resetFormSyncAccessDeniedFlag();
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[HubSpot FormSync] Reset error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to reset form sync flags' });
  }
});

router.post('/api/admin/hubspot/set-forms-token', isAdmin, async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.length < 10) {
      return res.status(400).json({ error: 'A valid token is required' });
    }
    const { setPrivateAppToken } = await import('../../core/hubspot/formSync');
    const userEmail = getSessionUser(req)?.email || 'admin';
    await setPrivateAppToken(token, userEmail);
    const { syncHubSpotFormSubmissions } = await import('../../core/hubspot/formSync');
    const syncResult = await syncHubSpotFormSubmissions({ force: true });
    res.json({
      success: true,
      message: `Token saved and sync triggered: ${syncResult.totalFetched} fetched, ${syncResult.newInserted} new, ${syncResult.errors.length} errors`,
      syncResult,
    });
  } catch (error: unknown) {
    logger.error('[HubSpot FormSync] Set token error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to save token' });
  }
});

router.get('/api/admin/hubspot/set-forms-token-page', isAdmin, (_req: Request, res: Response) => {
  res.send(`<!DOCTYPE html><html><head><title>Set HubSpot Token</title>
<style>body{font-family:system-ui;max-width:500px;margin:80px auto;padding:20px}
input{width:100%;padding:12px;margin:10px 0;border:1px solid #ccc;border-radius:8px;font-size:14px}
button{padding:12px 24px;background:#293515;color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px}
#result{margin-top:20px;padding:16px;border-radius:8px;white-space:pre-wrap;font-size:13px}</style></head>
<body><h2>Set HubSpot Private App Token</h2>
<p>This saves the token directly to the production database, bypassing env vars.</p>
<input type="text" id="token" placeholder="pat-na2-..." />
<button onclick="submit()">Save & Sync</button>
<div id="result"></div>
<script>async function submit(){
const token=document.getElementById('token').value.trim();
if(!token){alert('Enter a token');return}
const r=document.getElementById('result');
r.style.background='#f0f0f0';r.textContent='Saving and syncing...';
try{const res=await fetch('/api/admin/hubspot/set-forms-token',{method:'POST',
headers:{'Content-Type':'application/json'},credentials:'include',
body:JSON.stringify({token})});const data=await res.json();
r.style.background=data.success?'#d4edda':'#f8d7da';
r.textContent=JSON.stringify(data,null,2);}catch(e){r.style.background='#f8d7da';r.textContent='Error: '+e.message;}
}</script></body></html>`);
});

interface MarketingContactAuditRow {
  email: string;
  membership_status: string | null;
  role: string | null;
  tier: string | null;
  billing_provider: string | null;
  hubspot_id: string | null;
}

interface MarketingAuditContact {
  hubspotId: string;
  email: string;
  firstName: string;
  lastName: string;
  membershipStatus: string;
  lifecycleStage: string;
  tier: string | null;
  createdAt: string | null;
  lastModified: string | null;
  isMarketingContact: boolean;
  category: 'safe_to_remove' | 'review' | 'keep';
  reasons: string[];
  inLocalDb: boolean;
  localDbStatus: string | null;
  localDbRole: string | null;
  lastBookingDate: string | null;
  lastEmailOpen: string | null;
  emailBounced: boolean;
}

const MARKETING_AUDIT_PROPERTIES = [
  'firstname',
  'lastname',
  'email',
  'phone',
  'lifecyclestage',
  'createdate',
  'lastmodifieddate',
  'membership_tier',
  'membership_status',
  'membership_start_date',
  'hs_marketable_status',
  'hs_marketable_reason_id',
  'hs_marketable_reason_type',
  'hs_email_optout',
  'hs_email_hard_bounce_reason_enum',
  'hs_email_bounce',
  'hs_email_last_open_date',
  'hs_email_last_click_date',
  'hs_email_last_send_timestamp',
  'hs_email_sends_since_last_engagement',
  'hs_lifecyclestage_lead_date',
  'hs_lifecyclestage_customer_date',
  'notes_last_updated',
  'num_conversion_events',
  'hs_email_delivered',
  'hs_email_open',
  'hs_sa_first_engagement_date',
  'hs_last_sales_activity_date',
  'remove_from_marketing',
];

function checkRecentEngagement(
  lastOpen: string | null | undefined,
  lastClick: string | null | undefined,
  cutoffDate: Date
): boolean {
  if (lastOpen) {
    const openDate = new Date(lastOpen);
    if (!isNaN(openDate.getTime()) && openDate > cutoffDate) return true;
  }
  if (lastClick) {
    const clickDate = new Date(lastClick);
    if (!isNaN(clickDate.getTime()) && clickDate > cutoffDate) return true;
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureNonMarketingProperty(hubspot: any): Promise<'ready' | 'skip' | 'failed'> {
  const PROP_NAME = 'remove_from_marketing';
  try {
    await retryableHubSpotRequest(() =>
      hubspot.crm.properties.coreApi.getByName('contacts', PROP_NAME)
    );
    return 'ready';
  } catch (getErr: unknown) {
    const status = getErrorStatusCode(getErr);
    if (status && status !== 404) {
      logger.warn('[HubSpot MarketingAudit] Could not read property (non-404), will attempt create', {
        error: getErr instanceof Error ? getErr : new Error(String(getErr)),
        status,
      });
    }
    const { isHubSpotReadOnly: isReadOnly, logHubSpotWriteSkipped: logSkipped } = await import('../../core/hubspot/readOnlyGuard');
    if (isReadOnly()) {
      logSkipped('create_property', PROP_NAME);
      return 'skip';
    }
    try {
      await retryableHubSpotRequest(() =>
        hubspot.crm.properties.coreApi.create('contacts', {
          name: PROP_NAME,
          label: 'Remove from Marketing',
          type: 'enumeration',
          fieldType: 'booleancheckbox',
          groupName: 'contactinformation',
          description: 'Set by Ever Club app to flag contacts for non-marketing status. Create a HubSpot workflow that triggers on this property to set marketing status.',
          options: [
            { label: 'True', value: 'true', displayOrder: 0 },
            { label: 'False', value: 'false', displayOrder: 1 },
          ],
        })
      );
      logger.info('[HubSpot MarketingAudit] Created remove_from_marketing custom property');
      return 'ready';
    } catch (createErr: unknown) {
      const createStatus = getErrorStatusCode(createErr);
      if (createStatus === 409) {
        logger.info('[HubSpot MarketingAudit] Property already exists (409 conflict)');
        return 'ready';
      }
      logger.warn('[HubSpot MarketingAudit] Could not create property, will attempt batch update anyway', {
        error: createErr instanceof Error ? createErr : new Error(String(createErr)),
        createStatus,
      });
      return 'skip';
    }
  }
}

router.get('/api/admin/hubspot/marketing-contacts-audit', isAdmin, async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    const hubspot = await getHubSpotClient();

    let allContacts: HubSpotApiObject[] = [];
    let after: string | undefined = undefined;

    do {
      const response = await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.basicApi.getPage(100, after, MARKETING_AUDIT_PROPERTIES)
      );
      allContacts = allContacts.concat(response.results as unknown as HubSpotApiObject[]);
      after = response.paging?.next?.after;
    } while (after);

    const emails = allContacts
      .map(c => (c.properties?.email || '').toLowerCase())
      .filter(Boolean);

    const dbMemberMap: Record<string, MarketingContactAuditRow> = {};
    if (emails.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < emails.length; i += batchSize) {
        const batch = emails.slice(i, i + batchSize);
        const dbResult = await db.execute(
          sql`SELECT LOWER(email) as email, membership_status, role, tier, billing_provider, hubspot_id
              FROM users WHERE LOWER(email) IN (${sql.join(batch.map(e => sql`${e}`), sql`, `)})`
        );
        for (const row of dbResult.rows) {
          const r = row as unknown as MarketingContactAuditRow;
          dbMemberMap[r.email] = r;
        }
      }
    }

    const lastActivityMap: Record<string, string> = {};
    if (emails.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < emails.length; i += batchSize) {
        const batch = emails.slice(i, i + batchSize);
        const activityResult = await db.execute(
          sql`SELECT email, MAX(activity_date)::text as last_activity FROM (
                SELECT LOWER(user_email) as email, request_date as activity_date
                FROM booking_requests
                WHERE LOWER(user_email) IN (${sql.join(batch.map(e => sql`${e}`), sql`, `)})
                  AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
              ) combined GROUP BY email`
        );
        for (const row of activityResult.rows) {
          const r = row as unknown as LastActivityRow;
          if (r.last_activity) {
            lastActivityMap[r.email] = String(r.last_activity).split('T')[0];
          }
        }
      }
    }

    const now = new Date();
    const ninetyDaysAgo = new Date(now);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const auditContacts: MarketingAuditContact[] = allContacts.map(contact => {
      const props = contact.properties as Record<string, string | null | undefined>;
      const email = (props.email || '').toLowerCase();
      const membershipStatus = (props.membership_status || '').toLowerCase();
      const lifecycleStage = (props.lifecyclestage || '').toLowerCase();
      const dbMember = dbMemberMap[email];

      const alreadyFlaggedForRemoval =
        (props.remove_from_marketing || '').toLowerCase() === 'true';

      const isMarketingContact =
        (props.hs_marketable_status || '').toLowerCase() !== 'false' && !alreadyFlaggedForRemoval;

      const emailBounced =
        !!(props.hs_email_hard_bounce_reason_enum) ||
        (props.hs_email_bounce || '').toLowerCase() === 'true';

      const emailOptedOut =
        (props.hs_email_optout || '').toLowerCase() === 'true';

      const totalEmailsDelivered = parseInt(props.hs_email_delivered || '0', 10) || 0;
      const totalEmailsOpened = parseInt(props.hs_email_open || '0', 10) || 0;
      const sendsSinceLastEngagement = parseInt(props.hs_email_sends_since_last_engagement || '0', 10) || 0;
      const neverEngaged = totalEmailsDelivered > 0 && totalEmailsOpened === 0;
      const highSendsNoEngagement = sendsSinceLastEngagement >= 10;

      const lastEmailOpen = props.hs_email_last_open_date || null;
      const lastEmailClick = props.hs_email_last_click_date || null;
      const lastBooking = lastActivityMap[email] || null;

      const reasons: string[] = [];
      let category: 'safe_to_remove' | 'review' | 'keep' = 'keep';

      const activeStatuses = ['active', 'trialing', 'past_due'];
      const terminatedStatuses = ['terminated', 'cancelled', 'non-member', 'expired', 'declined'];

      const localStatus = dbMember?.membership_status?.toLowerCase() || null;
      const isActiveInDb = localStatus ? activeStatuses.includes(localStatus) : false;
      const isActiveInHubSpot = activeStatuses.includes(membershipStatus);

      const hasEngagement90d = checkRecentEngagement(lastEmailOpen, lastEmailClick, ninetyDaysAgo);

      if (emailBounced) {
        category = 'safe_to_remove';
        reasons.push('Email has hard bounced');
      } else if (emailOptedOut && !isActiveInDb && !isActiveInHubSpot) {
        category = 'safe_to_remove';
        reasons.push('Contact opted out of email');
        if (membershipStatus) reasons.push(`Status: ${membershipStatus}`);
      } else if (isActiveInDb || isActiveInHubSpot) {
        if (emailOptedOut) {
          category = 'review';
          reasons.push('Active member but opted out of email');
        } else {
          category = 'keep';
          reasons.push('Active member');
        }
      } else if (terminatedStatuses.includes(membershipStatus)) {
        if (neverEngaged && totalEmailsDelivered >= 3) {
          category = 'safe_to_remove';
          reasons.push(`Status: ${membershipStatus}`);
          reasons.push(`${totalEmailsDelivered} emails sent, 0 ever opened`);
        } else if (!hasEngagement90d) {
          category = 'safe_to_remove';
          reasons.push(`Status: ${membershipStatus}`);
          reasons.push('No email engagement in 90 days');
          if (highSendsNoEngagement) reasons.push(`${sendsSinceLastEngagement} sends since last engagement`);
          if (lastBooking) reasons.push(`Last booking: ${lastBooking}`);
        } else {
          category = 'review';
          reasons.push(`Status: ${membershipStatus}`);
          reasons.push('Engaged in last 90 days');
          if (lastBooking) reasons.push(`Last booking: ${lastBooking}`);
        }
      } else if (lifecycleStage === 'lead' || (!membershipStatus && lifecycleStage !== 'customer')) {
        const createdAt = props.createdate ? new Date(props.createdate) : null;
        const isOldLead = createdAt && createdAt < sixMonthsAgo;

        if (neverEngaged && totalEmailsDelivered >= 3) {
          category = 'safe_to_remove';
          reasons.push('Non-member lead');
          reasons.push(`${totalEmailsDelivered} emails sent, 0 ever opened`);
        } else if (!hasEngagement90d && isOldLead) {
          category = 'safe_to_remove';
          reasons.push('Non-member lead');
          reasons.push('Created over 6 months ago');
          reasons.push('No email engagement in 90 days');
          if (highSendsNoEngagement) reasons.push(`${sendsSinceLastEngagement} sends since last engagement`);
        } else if (!hasEngagement90d) {
          category = 'review';
          reasons.push('Non-member lead');
          reasons.push('No email engagement in 90 days');
          if (createdAt) reasons.push(`Created: ${normalizeDateToYYYYMMDD(props.createdate || null) || 'unknown'}`);
        } else {
          category = 'review';
          reasons.push('Non-member lead with recent engagement');
          if (createdAt) reasons.push(`Created: ${normalizeDateToYYYYMMDD(props.createdate || null) || 'unknown'}`);
        }
      } else if (!membershipStatus) {
        if (neverEngaged && totalEmailsDelivered >= 3) {
          category = 'safe_to_remove';
          reasons.push('No membership status');
          reasons.push(`${totalEmailsDelivered} emails sent, 0 ever opened`);
        } else if (!hasEngagement90d) {
          category = 'review';
          reasons.push('No membership status');
          reasons.push('No email engagement in 90 days');
        } else {
          category = 'keep';
          reasons.push('Has recent email engagement');
        }
      }

      return {
        hubspotId: contact.id,
        email,
        firstName: props.firstname || '',
        lastName: props.lastname || '',
        membershipStatus: membershipStatus || 'unknown',
        lifecycleStage: lifecycleStage || 'unknown',
        tier: props.membership_tier || null,
        createdAt: props.createdate || null,
        lastModified: props.lastmodifieddate || null,
        isMarketingContact,
        category,
        reasons,
        inLocalDb: !!dbMember,
        localDbStatus: localStatus,
        localDbRole: dbMember?.role || null,
        lastBookingDate: lastBooking,
        lastEmailOpen: lastEmailOpen ? normalizeDateToYYYYMMDD(lastEmailOpen) : null,
        emailBounced,
      };
    });

    const marketingContacts = auditContacts.filter(c => c.isMarketingContact);
    const safeToRemove = marketingContacts.filter(c => c.category === 'safe_to_remove');
    const needsReview = marketingContacts.filter(c => c.category === 'review');
    const keep = marketingContacts.filter(c => c.category === 'keep');

    res.json({
      summary: {
        totalContacts: allContacts.length,
        totalMarketingContacts: marketingContacts.length,
        totalNonMarketing: allContacts.length - marketingContacts.length,
        safeToRemoveCount: safeToRemove.length,
        needsReviewCount: needsReview.length,
        keepCount: keep.length,
        potentialSavings: safeToRemove.length + needsReview.length,
      },
      safeToRemove: safeToRemove.sort((a, b) => a.email.localeCompare(b.email)),
      needsReview: needsReview.sort((a, b) => a.email.localeCompare(b.email)),
      keep: keep.sort((a, b) => a.email.localeCompare(b.email)),
    });
  } catch (error: unknown) {
    logger.error('[HubSpot MarketingAudit] Failed to audit marketing contacts', {
      error: error instanceof Error ? error : new Error(String(error)),
    });
    res.status(500).json({ error: 'Failed to audit marketing contacts' });
  }
});

router.post('/api/admin/hubspot/remove-marketing-contacts', isAdmin, async (req: Request, res: Response) => {
  try {
    const { contactIds } = req.body as { contactIds: string[] };
    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: 'contactIds array is required' });
    }

    if (contactIds.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 contacts per batch' });
    }

    const { client: hubspot, source } = await getHubSpotClientWithFallback();
    logger.info(`[HubSpot MarketingAudit] Using ${source} client for marketing contact removal`);

    const propStatus = await ensureNonMarketingProperty(hubspot);
    if (propStatus === 'failed') {
      return res.status(500).json({
        error: 'Could not verify the remove_from_marketing property in HubSpot. Check API permissions.',
      });
    }

    const batchSize = 100;
    const succeededIds: string[] = [];
    const failedIds: string[] = [];
    const errors: string[] = [];

    const { isHubSpotReadOnly: isRO, logHubSpotWriteSkipped: logSkip } = await import('../../core/hubspot/readOnlyGuard');
    for (let i = 0; i < contactIds.length; i += batchSize) {
      const batch = contactIds.slice(i, i + batchSize);
      if (isRO()) {
        logSkip('bulk_status_update', `batch of ${batch.length} contacts`);
        succeededIds.push(...batch);
        continue;
      }
      try {
        await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.batchApi.update({
            inputs: batch.map(id => ({
              id,
              properties: { remove_from_marketing: 'true' },
            })),
          })
        );
        succeededIds.push(...batch);
      } catch (batchError: unknown) {
        failedIds.push(...batch);
        const errMsg = getErrorMessage(batchError);
        errors.push(`Batch starting at index ${i}: ${errMsg}`);
        if (errMsg.includes('remove_from_marketing') && errMsg.includes('not exist')) {
          logger.error('[HubSpot MarketingAudit] Property does not exist. Please create it manually in HubSpot.', {
            error: batchError instanceof Error ? batchError : new Error(String(batchError)),
          });
          return res.status(422).json({
            error: 'The remove_from_marketing property does not exist in HubSpot and could not be auto-created. Please create a checkbox property named "remove_from_marketing" in HubSpot contact settings, then try again.',
          });
        }
      }
    }

    const sessionUser = getSessionUser(req);
    logger.info('[HubSpot MarketingAudit] Contacts flagged for non-marketing', {
      extra: {
        flaggedCount: succeededIds.length,
        failedCount: failedIds.length,
        performedBy: sessionUser?.email || 'unknown',
        clientSource: source,
      },
    });

    res.json({
      success: true,
      removed: succeededIds.length,
      failed: failedIds.length,
      succeededIds,
      needsWorkflow: true,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error: unknown) {
    logger.error('[HubSpot MarketingAudit] Failed to flag marketing contacts', {
      error: error instanceof Error ? error : new Error(String(error)),
    });
    res.status(500).json({ error: 'Failed to flag marketing contacts for removal' });
  }
});

export default router;
