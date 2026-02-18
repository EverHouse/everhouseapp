import { eq } from 'drizzle-orm';
import { db } from '../db';
import { notifications, staffUsers } from '../../shared/schema';

import { logger } from './logger';
export async function getStaffAndAdminEmails(): Promise<string[]> {
  const staffEmails = await db.select({ email: staffUsers.email })
    .from(staffUsers)
    .where(eq(staffUsers.isActive, true));
  
  return staffEmails.map(row => row.email);
}

export async function notifyAllStaffRequired(
  title: string,
  message: string,
  type: string,
  relatedId?: number,
  relatedType?: string
): Promise<void> {
  const emails = await getStaffAndAdminEmails();
  if (emails.length === 0) {
    throw new Error('No staff members to notify - cannot proceed without staff notification');
  }
  
  const notificationValues = emails.map(email => ({
    userEmail: email,
    title,
    message,
    type,
    relatedId: relatedId ?? null,
    relatedType: relatedType ?? null,
  }));
  
  await db.insert(notifications).values(notificationValues);
}

export async function notifyAllStaff(
  title: string,
  message: string,
  type: string,
  relatedId?: number,
  relatedType?: string
): Promise<void> {
  try {
    await notifyAllStaffRequired(title, message, type, relatedId, relatedType);
  } catch (error) {
    logger.error('Failed to insert staff notifications:', { error: error });
  }
}

export async function notifyMemberRequired(
  userEmail: string,
  title: string,
  message: string,
  type: string,
  relatedId?: number,
  relatedType?: string
): Promise<void> {
  await db.insert(notifications).values({
    userEmail,
    title,
    message,
    type,
    relatedId: relatedId ?? null,
    relatedType: relatedType ?? null,
  });
}
