import { db } from '../../db';
import { users, staffUsers } from '../../../shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { getErrorMessage } from '../../utils/errorUtils';
import { getHubSpotClient } from '../integrations';
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
    logger.error('[Trackman] Error fetching golf instructor emails:', { error: err });
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
      const response = await hubspot.crm.contacts.basicApi.getPage(BATCH_SIZE, after, properties);
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
        process.stderr.write(`[Trackman Import] Processed ${totalProcessed} contacts, found ${validMembers.length} valid members...\n`);
      }
    } while (after);
    
    const activeCount = validMembers.filter(m => m.status === 'active').length;
    const formerCount = validMembers.length - activeCount;
    process.stderr.write(`[Trackman Import] Loaded ${validMembers.length} members from HubSpot (${activeCount} active, ${formerCount} former) from ${totalProcessed} total contacts\n`);
    return validMembers;
  } catch (err: unknown) {
    process.stderr.write(`[Trackman Import] Error fetching HubSpot contacts: ${getErrorMessage(err)}\n`);
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

export function normalizeName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function areNamesSimilar(name1: string, name2: string): boolean {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);
  
  if (n1 === n2) return true;
  
  const parts1 = n1.split(' ').filter(p => p.length > 1);
  const parts2 = n2.split(' ').filter(p => p.length > 1);
  
  if (parts1.length === 0 || parts2.length === 0) return false;
  
  const firstName1 = parts1[0];
  const firstName2 = parts2[0];
  
  const firstNameMatch = firstName1.startsWith(firstName2) || firstName2.startsWith(firstName1) ||
    firstName1.slice(0, 4) === firstName2.slice(0, 4);
  
  const lastName1 = parts1[parts1.length - 1];
  const lastName2 = parts2[parts2.length - 1];
  
  const lastNameMatch = lastName1 === lastName2 || 
    lastName1.replace(/e+y$/i, 'y') === lastName2.replace(/e+y$/i, 'y') ||
    levenshteinDistance(lastName1, lastName2) <= 2;
  
  return firstNameMatch && lastNameMatch;
}

export async function findMembersByName(name: string): Promise<{
  match: 'unique' | 'ambiguous' | 'none';
  members: Array<{ id: string; email: string; name: string }>;
}> {
  if (!name || name.trim().length < 2) {
    return { match: 'none', members: [] };
  }
  
  const normalized = normalizeName(name);
  const nameParts = normalized.split(' ').filter(p => p.length > 1);
  
  if (nameParts.length === 0) {
    return { match: 'none', members: [] };
  }
  
  const firstName = nameParts[0];
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : null;
  
  try {
    let result;
    if (lastName) {
      result = await db.execute(sql`
      SELECT id, email, 
        COALESCE(
          (SELECT contact->>'firstname' || ' ' || contact->>'lastname' 
           FROM (SELECT ${''}::text) AS dummy(contact) WHERE false),
          email
        ) as name,
        LOWER(COALESCE(
          (SELECT hs.properties->>'firstname' FROM hubspot_contacts hs WHERE LOWER(hs.properties->>'email') = LOWER(u.email) LIMIT 1),
          SPLIT_PART(u.email, '@', 1)
        )) as first_name,
        LOWER(COALESCE(
          (SELECT hs.properties->>'lastname' FROM hubspot_contacts hs WHERE LOWER(hs.properties->>'email') = LOWER(u.email) LIMIT 1),
          ''
        )) as last_name
      FROM users u
      WHERE u.tier IS NOT NULL 
        AND u.tier != ''
        AND (
          LOWER(u.email) LIKE ${firstName} || '%'
          OR EXISTS (
            SELECT 1 FROM hubspot_contacts hs 
            WHERE LOWER(hs.properties->>'email') = LOWER(u.email)
            AND (
              LOWER(hs.properties->>'firstname') LIKE ${firstName} || '%'
              OR LOWER(hs.properties->>'firstname') = ${firstName}
            )
            AND (
              LOWER(hs.properties->>'lastname') LIKE ${lastName} || '%'
              OR LOWER(hs.properties->>'lastname') = ${lastName}
            )
          )
        )
      LIMIT 10
    `);
    } else {
      result = await db.execute(sql`
      SELECT u.id, u.email,
        COALESCE(hs.properties->>'firstname', '') || ' ' || COALESCE(hs.properties->>'lastname', '') as name
      FROM users u
      LEFT JOIN hubspot_contacts hs ON LOWER(hs.properties->>'email') = LOWER(u.email)
      WHERE u.tier IS NOT NULL 
        AND u.tier != ''
        AND (
          LOWER(SPLIT_PART(u.email, '@', 1)) LIKE ${firstName} || '%'
          OR LOWER(COALESCE(hs.properties->>'firstname', '')) = ${firstName}
          OR LOWER(COALESCE(hs.properties->>'firstname', '')) LIKE ${firstName} || '%'
        )
      LIMIT 10
    `);
    }
    
    if (result.rows.length === 0) {
      return { match: 'none', members: [] };
    }
    
    if (result.rows.length === 1) {
      return { 
        match: 'unique', 
        members: result.rows.map(r => ({ id: r.id, email: r.email, name: r.name?.trim() || r.email }))
      };
    }
    
    return { 
      match: 'ambiguous', 
      members: result.rows.map(r => ({ id: r.id, email: r.email, name: r.name?.trim() || r.email }))
    };
  } catch (error: unknown) {
    process.stderr.write(`[Trackman Import] Error searching members by name "${name}": ${error}\n`);
    return { match: 'none', members: [] };
  }
}

export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

export async function autoLinkEmailToOwner(aliasEmail: string, ownerEmail: string, reason: string): Promise<boolean> {
  try {
    const aliasLower = aliasEmail.toLowerCase().trim();
    
    const result = await db.execute(sql`UPDATE users 
       SET manually_linked_emails = 
         CASE 
           WHEN COALESCE(manually_linked_emails, '[]'::jsonb) ? ${aliasLower}
           THEN manually_linked_emails
           ELSE COALESCE(manually_linked_emails, '[]'::jsonb) || to_jsonb(${aliasLower}::text)
         END
       WHERE LOWER(email) = LOWER(${ownerEmail})
       RETURNING email`);
    
    if (result.rowCount && result.rowCount > 0) {
      process.stderr.write(`[Trackman Import] Auto-linked ${aliasLower} to ${ownerEmail}: ${reason}\n`);
      return true;
    }
    return false;
  } catch (error: unknown) {
    process.stderr.write(`[Trackman Import] Failed to auto-link ${aliasEmail} to ${ownerEmail}: ${error}\n`);
    return false;
  }
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
      
      process.stderr.write(`[Trackman Import] Loaded ${mapping.size} email mappings from CSV\n`);
    } catch (err: unknown) {
      process.stderr.write('[Trackman Import] Error loading CSV mapping: ' + getErrorMessage(err) + '\n');
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
      process.stderr.write(`[Trackman Import] Loaded ${dbMappingsCount} email mappings from users.manuallyLinkedEmails\n`);
    }
  } catch (err: unknown) {
    process.stderr.write('[Trackman Import] Error loading DB mappings: ' + getErrorMessage(err) + '\n');
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
      process.stderr.write(`[Trackman Import] Loaded ${linkedCount} email mappings from user_linked_emails table\n`);
    }
  } catch (err: unknown) {
    process.stderr.write('[Trackman Import] Error loading user_linked_emails: ' + getErrorMessage(err) + '\n');
  }
  
  process.stderr.write(`[Trackman Import] Total email mappings: ${mapping.size}\n`);
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
    process.stderr.write(`[Trackman Import] Error checking for private event block: ${getErrorMessage(err)}\n`);
    return false;
  }
}
