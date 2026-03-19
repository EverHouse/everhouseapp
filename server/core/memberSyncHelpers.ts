import { db } from '../db';
import { users } from '../../shared/schema';
import { sql, eq } from 'drizzle-orm';
import { isProduction } from './db';
import { notifyMember, notifyAllStaff } from './notificationService';
import { TIER_NAMES } from '../../shared/constants/tiers';
import { logger } from './logger';
import { getErrorMessage } from '../utils/errorUtils';

export interface SyncExclusionRow {
  email: string;
}

export interface HubSpotCallRecord {
  id: string;
  properties: {
    hs_timestamp?: string;
    hs_call_body?: string;
    hs_call_direction?: string;
    hs_call_status?: string;
    hs_call_duration?: string;
    hs_call_title?: string;
    [key: string]: string | undefined;
  };
}

export interface HubSpotCommunicationRecord {
  id: string;
  properties: {
    hs_timestamp?: string;
    hs_communication_body?: string;
    hs_communication_channel_type?: string;
    hs_communication_logged_from?: string;
    [key: string]: string | undefined;
  };
}

export interface HubSpotContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    hs_calculated_full_name?: string;
    email?: string;
    phone?: string;
    company?: string;
    membership_tier?: string;
    membership_status?: string;
    membership_discount_reason?: string;
    mindbody_client_id?: string;
    membership_start_date?: string;
    createdate?: string;
    eh_email_updates_opt_in?: string;
    eh_sms_updates_opt_in?: string;
    interest_golf?: string;
    interest_in_cafe?: string;
    interest_in_events?: string;
    interest_in_workspace?: string;
    total_visit_count?: string;
    membership_notes?: string;
    message?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    date_of_birth?: string;
    last_modified_at?: string;
    stripe_delinquent?: string;
    hs_sms_promotional?: string;
    hs_sms_customer_updates?: string;
    hs_sms_reminders?: string;
    hs_merged_object_ids?: string;
  };
}

export function isRecognizedTier(tierString: string | null | undefined): boolean {
  if (!tierString || typeof tierString !== 'string') return false;
  const normalized = tierString.trim().toLowerCase();
  if (normalized.length === 0) return false;
  
  return TIER_NAMES.some(tier => normalized.includes(tier.toLowerCase()));
}

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function detectAndNotifyStatusChange(
  email: string,
  firstName: string | null,
  lastName: string | null,
  oldStatus: string | null,
  newStatus: string
): Promise<void> {
  if (!oldStatus || oldStatus === newStatus) return;
  
  const memberName = [firstName, lastName].filter(Boolean).join(' ') || email;
  
  const problematicStatuses = ['past_due', 'declined', 'suspended', 'expired', 'terminated', 'cancelled', 'frozen'];
  
  if (problematicStatuses.includes(newStatus) && !problematicStatuses.includes(oldStatus)) {
    await notifyMember({
      userEmail: email,
      title: 'Membership Status Update',
      message: `Your membership status has been updated to: ${newStatus}. Please contact the club if you have questions.`,
      type: 'membership_past_due'
    }, { sendPush: true });
    
    await notifyAllStaff(
      'Member Status Changed',
      `${memberName}'s membership status changed from ${oldStatus} to ${newStatus}`,
      'member_status_change',
      { relatedType: 'membership_status', url: '/admin/members' }
    );
    
    logger.info(`[MemberSync] Notified about status change for ${email}: ${oldStatus} -> ${newStatus}`);
    
    try {
      const userResult = await db.select({ 
        billingProvider: users.billingProvider,
        gracePeriodStart: users.gracePeriodStart
      })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      
      const user = userResult[0];
      
      if (user && user.billingProvider === 'mindbody' && !user.gracePeriodStart) {
        await db.update(users)
          .set({
            gracePeriodStart: new Date(),
            gracePeriodEmailCount: 0,
            updatedAt: new Date()
          })
          .where(eq(users.email, email));
        
        logger.info(`[MemberSync] Started grace period for Mindbody member ${email} - status changed to ${newStatus}`);
      }
    } catch (err: unknown) {
      logger.error(`[MemberSync] Failed to start grace period for ${email}:`, { error: err });
    }
  }
}

export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

let syncInProgress = false;
let lastSyncTime = 0;
export const SYNC_COOLDOWN = 5 * 60 * 1000;

export function getSyncInProgress(): boolean {
  return syncInProgress;
}

export function setSyncInProgress(val: boolean): void {
  syncInProgress = val;
}

export function getLastSyncTime(): number {
  return lastSyncTime;
}

export function setLastSyncTime(val: number): void {
  lastSyncTime = val;
}

export { isProduction };

export async function initMemberSyncSettings(): Promise<void> {
  try {
    const result = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'last_member_sync_time'`);
    if (result.rows.length > 0 && result.rows[0].value) {
      lastSyncTime = parseInt(result.rows[0].value as string, 10);
      logger.info(`[MemberSync] Loaded last sync time: ${new Date(lastSyncTime).toISOString()}`);
    }
  } catch (err: unknown) {
    logger.error('[MemberSync] Failed to load last sync time:', { error: err });
  }
}

export function getLastMemberSyncTime(): number {
  return lastSyncTime;
}

export async function setLastMemberSyncTime(time: number): Promise<void> {
  lastSyncTime = time;
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, category, updated_at) 
       VALUES ('last_member_sync_time', ${time.toString()}, 'sync', NOW())
       ON CONFLICT (key) DO UPDATE SET value = ${time.toString()}, updated_at = NOW()`);
  } catch (err: unknown) {
    logger.error('[MemberSync] Failed to persist last sync time:', { error: err });
  }
}

export const parseOptIn = (val?: string): boolean | null => {
  if (!val) return null;
  const lower = val.toLowerCase();
  return lower === 'true' || lower === 'yes' || lower === '1';
};

export const getNameFromContact = (contact: HubSpotContact): { firstName: string | null; lastName: string | null } => {
  let firstName = contact.properties.firstname || null;
  let lastName = contact.properties.lastname || null;
  
  if ((!firstName || !lastName) && contact.properties.hs_calculated_full_name) {
    const fullName = contact.properties.hs_calculated_full_name.trim();
    const parts = fullName.split(' ');
    if (parts.length >= 2) {
      firstName = firstName || parts[0];
      lastName = lastName || parts.slice(1).join(' ');
    } else if (parts.length === 1 && parts[0]) {
      firstName = firstName || parts[0];
    }
  }
  
  return { firstName, lastName };
};

export const isTransientDbError = (err: unknown): boolean => {
  const msg = getErrorMessage(err);
  return /connection terminat|connection timeout|pool|too many clients|ECONNRESET|ECONNREFUSED|idle_in_transaction_session_timeout/i.test(msg);
};

export const retryDbOperation = async <T>(fn: () => Promise<T>, label: string, maxRetries = 3): Promise<T> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < maxRetries && isTransientDbError(err)) {
        const delayMs = attempt * 250;
        logger.warn(`[MemberSync] Transient DB error for ${label}, retrying (${attempt}/${maxRetries}) in ${delayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`retryDbOperation: unreachable`);
};
