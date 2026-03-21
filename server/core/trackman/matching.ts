import { db } from '../../db';
import { users, staffUsers } from '../../../shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { getErrorMessage } from '../../utils/errorUtils';
import { getHubSpotClient } from '../integrations';
import { retryableHubSpotRequest } from '../hubspot/request';
import { logger } from '../logger';
import { parseCSVLine } from './parser';
import type { UserIdRow, LinkedEmailRow, HubSpotMember } from './constants';
import { VALID_MEMBER_STATUSES } from './constants';

export async function getGolfInstructorEmails(): Promise<string[]> {
  try {
    const instructors = await db.select({ email: staffUsers.email })
      .from(staffUsers)
      .where(and(
        eq(staffUsers.role, 'golf_instructor'),
        eq(staffUsers.isActive, true)
      ));
    
    return instructors
      .map(i => i.email?.toLowerCase())
      .filter((email): email is string => !!email);
  } catch (err: unknown) {
    logger.error('[Trackman] Error fetching golf instructor emails:', { error: getErrorMessage(err) });
    return [];
  }
}

export async function getAllHubSpotMembers(): Promise<HubSpotMember[]> {
  try {
    const hubspot = await getHubSpotClient();
    
    const properties = [
      'firstname',
      'lastname',
      'email',
      'membership_status'
    ];
    
    const validMembers: HubSpotMember[] = [];
    let after: string | undefined = undefined;
    let totalProcessed = 0;
    const BATCH_SIZE = 100;
    
    do {
      const response = await retryableHubSpotRequest(() => hubspot.crm.contacts.basicApi.getPage(BATCH_SIZE, after, properties));
      totalProcessed += response.results.length;
      
      for (const contact of response.results) {
        const status = (contact.properties.membership_status || '').toLowerCase();
        if (VALID_MEMBER_STATUSES.includes(status)) {
          const email = (contact.properties.email || '').toLowerCase();
          if (email) {
            validMembers.push({
              email,
              firstName: contact.properties.firstname || '',
              lastName: contact.properties.lastname || '',
              status
            });
          }
        }
      }
      
      after = response.paging?.next?.after;
      
      if (totalProcessed % 500 === 0) {
        logger.info('[TrackmanImport] HubSpot contact batch progress', { extra: { totalProcessed, validMembers: validMembers.length } });
      }
    } while (after);
    
    const activeCount = validMembers.filter(m => m.status === 'active').length;
    const formerCount = validMembers.length - activeCount;
    logger.info('[TrackmanImport] Loaded members from HubSpot', { extra: { total: validMembers.length, activeCount, formerCount, totalProcessed } });
    return validMembers;
  } catch (err: unknown) {
    logger.error('[TrackmanImport] Error fetching HubSpot contacts', { error: getErrorMessage(err) });
    return [];
  }
}

export function resolveEmail(email: string, membersByEmail: Map<string, string>, trackmanEmailMapping: Map<string, string>): string {
  const emailLower = email.toLowerCase();
  const trackmanResolved = trackmanEmailMapping.get(emailLower);
  if (trackmanResolved) {
    return trackmanResolved.toLowerCase();
  }
  const memberResolved = membersByEmail.get(emailLower);
  if (memberResolved) {
    return memberResolved.toLowerCase();
  }
  return emailLower;
}

export async function getUserIdByEmail(email: string): Promise<string | null> {
  const result = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${email}) LIMIT 1`);
  return (result.rows[0] as unknown as UserIdRow)?.id || null;
}

export async function isEmailLinkedToUser(email: string, userEmail: string): Promise<boolean> {
  const emailLower = email.toLowerCase().trim();
  const userEmailLower = userEmail.toLowerCase().trim();
  
  if (emailLower === userEmailLower) return true;
  
  const result = await db.execute(sql`SELECT 1 FROM users 
     WHERE LOWER(email) = LOWER(${userEmail}) 
     AND (
       LOWER(trackman_email) = LOWER(${emailLower})
       OR COALESCE(manually_linked_emails, '[]'::jsonb) ? ${emailLower}
     )
     LIMIT 1`);
  return (result.rowCount ?? 0) > 0;
}



export async function loadEmailMapping(): Promise<Map<string, string>> {
  const mappingPath = path.join(process.cwd(), 'uploads', 'trackman', 'even_house_cleaned_member_data_1767012619480.csv');
  const mapping = new Map<string, string>();
  
  if (fs.existsSync(mappingPath)) {
    try {
      const content = fs.readFileSync(mappingPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      
      for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);
        if (fields.length >= 10) {
          const realEmail = fields[3]?.trim().toLowerCase();
          const linkedEmails = fields[9]?.trim();
          
          if (realEmail && linkedEmails) {
            const placeholders = linkedEmails.split(',').map(e => e.trim().toLowerCase());
            for (const placeholder of placeholders) {
              if (placeholder) {
                mapping.set(placeholder, realEmail);
              }
            }
          }
        }
      }
      
      logger.info('[TrackmanImport] Loaded email mappings from CSV', { extra: { count: mapping.size } });
    } catch (err: unknown) {
      logger.error('[TrackmanImport] Error loading CSV mapping', { error: getErrorMessage(err) });
    }
  }
  
  try {
    const usersWithMappings = await db.select({
      email: users.email,
      manuallyLinkedEmails: users.manuallyLinkedEmails
    })
    .from(users)
    .where(sql`manually_linked_emails IS NOT NULL AND jsonb_array_length(manually_linked_emails) > 0`);
    
    let dbMappingsCount = 0;
    for (const user of usersWithMappings) {
      if (user.email && Array.isArray(user.manuallyLinkedEmails)) {
        for (const placeholder of user.manuallyLinkedEmails) {
          if (typeof placeholder === 'string' && placeholder.trim()) {
            mapping.set(placeholder.toLowerCase().trim(), user.email.toLowerCase());
            dbMappingsCount++;
          }
        }
      }
    }
    
    if (dbMappingsCount > 0) {
      logger.info('[TrackmanImport] Loaded email mappings from users.manuallyLinkedEmails', { extra: { count: dbMappingsCount } });
    }
  } catch (err: unknown) {
    logger.error('[TrackmanImport] Error loading DB mappings', { error: getErrorMessage(err) });
  }
  
  try {
    const linkedEmailsResult = await db.execute(
      sql`SELECT primary_email, linked_email FROM user_linked_emails`
    );
    
    let linkedCount = 0;
    for (const row of linkedEmailsResult.rows as unknown as LinkedEmailRow[]) {
      if (row.primary_email && row.linked_email) {
        const normalizedLinked = row.linked_email.toLowerCase().trim();
        const normalizedPrimary = row.primary_email.toLowerCase().trim();
        if (!mapping.has(normalizedLinked)) {
          mapping.set(normalizedLinked, normalizedPrimary);
          linkedCount++;
        }
      }
    }
    
    if (linkedCount > 0) {
      logger.info('[TrackmanImport] Loaded email mappings from user_linked_emails', { extra: { count: linkedCount } });
    }
  } catch (err: unknown) {
    logger.error('[TrackmanImport] Error loading user_linked_emails', { error: getErrorMessage(err) });
  }
  
  logger.info('[TrackmanImport] Total email mappings loaded', { extra: { count: mapping.size } });
  return mapping;
}

export async function isConvertedToPrivateEventBlock(
  resourceId: number | null,
  bookingDate: string,
  startTime: string,
  endTime: string | null
): Promise<boolean> {
  if (!resourceId || !bookingDate || !startTime) return false;
  
  try {
    const { availabilityBlocks, facilityClosures } = await import('../../../shared/schema');
    const { eq: eqOp } = await import('drizzle-orm');

    const effectiveEndTime = endTime 
      ? sql`${endTime}::time`
      : sql`${startTime}::time + interval '1 hour'`;
    
    const matchingBlocks = await db.select({
      blockId: availabilityBlocks.id,
    })
      .from(availabilityBlocks)
      .leftJoin(facilityClosures, eqOp(availabilityBlocks.closureId, facilityClosures.id))
      .where(and(
        eqOp(availabilityBlocks.resourceId, resourceId),
        eqOp(availabilityBlocks.blockDate, bookingDate),
        sql`${availabilityBlocks.startTime} < ${effectiveEndTime}`,
        sql`${availabilityBlocks.endTime} > ${startTime}::time`,
        sql`(
          ${facilityClosures.noticeType} = 'private_event' AND ${facilityClosures.isActive} = true
          OR ${availabilityBlocks.closureId} IS NULL
        )`
      ))
      .limit(1);
    
    return matchingBlocks.length > 0;
  } catch (err: unknown) {
    logger.error('[TrackmanImport] Error checking for private event block', { error: getErrorMessage(err) });
    return false;
  }
}
