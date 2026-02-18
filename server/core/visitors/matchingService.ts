import { db } from "../../db";
import { users, dayPassPurchases } from "../../../shared/schema";
import { userLinkedEmails } from "../../../shared/models/membership";
import { User } from "../../../shared/schema";
import { eq, ilike, and, sql } from "drizzle-orm";
import { findOrCreateHubSpotContact } from "../hubspot/members";
import { syncCustomerMetadataToStripe } from "../stripe/customers";

import { logger } from '../logger';
const PLACEHOLDER_EMAIL_PATTERNS = [
  '@visitors.evenhouse.club',
  '@trackman.local',
  'unmatched-',
  'golfnow-',
  'classpass-',
  'anonymous-',
  'anongolfnow@',
  'placeholder@'
];

function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const lower = email.toLowerCase();
  return PLACEHOLDER_EMAIL_PATTERNS.some(pattern => lower.includes(pattern));
}

/**
 * Criteria for matching existing users
 */
export interface MatchCriteria {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  mindbodyClientId?: string;
  hubspotId?: string;
}

/**
 * Data for creating or updating a visitor
 */
export interface VisitorData {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  mindbodyClientId?: string;
  hubspotId?: string;
}

/**
 * Normalizes phone number by stripping all non-digit characters
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Finds an existing user by multiple identifiers in priority order:
 * 1. Exact email match (case-insensitive, trim whitespace)
 * 1b. Linked email match (user_linked_emails table)
 * 1c. Manually linked email match (manuallyLinkedEmails JSONB field)
 * 2. Exact mindbodyClientId match
 * 3. Exact hubspotId match
 * 4. Exact phone match (normalized)
 * 5. firstName + lastName + phone match (all three required)
 * 
 * NOTE: All lookups exclude archived users to prevent matching "zombie" merged profiles
 */
export async function findMatchingUser(criteria: MatchCriteria): Promise<User | null> {
  // 1. Exact email match (case-insensitive, trim whitespace)
  // FIX: Exclude archived users to prevent matching merged/deleted profiles
  if (criteria.email) {
    const trimmedEmail = criteria.email.trim().toLowerCase();
    const results = await db
      .select()
      .from(users)
      .where(and(ilike(users.email, trimmedEmail), sql`archived_at IS NULL`))
      .limit(1);
    if (results.length > 0) return results[0];
    
    // 1b. Check user_linked_emails table for linked email match
    // FIX: Exclude archived users
    try {
      const linkedResult = await db
        .select({ user: users })
        .from(userLinkedEmails)
        .innerJoin(users, eq(users.email, userLinkedEmails.primaryEmail))
        .where(and(ilike(userLinkedEmails.linkedEmail, trimmedEmail), sql`${users.archivedAt} IS NULL`))
        .limit(1);
      if (linkedResult.length > 0) return linkedResult[0].user;
    } catch {
      // Table may not exist in older schemas, continue silently
    }
    
    // 1c. Check manuallyLinkedEmails JSONB field for linked email match
    // FIX: Exclude archived users
    const manuallyLinkedResults = await db
      .select()
      .from(users)
      .where(and(sql`COALESCE(${users.manuallyLinkedEmails}, '[]'::jsonb) @> ${JSON.stringify([trimmedEmail])}::jsonb`, sql`archived_at IS NULL`))
      .limit(1);
    if (manuallyLinkedResults.length > 0) return manuallyLinkedResults[0];
  }

  // 2. Exact mindbodyClientId match
  // FIX: Exclude archived users
  if (criteria.mindbodyClientId) {
    const results = await db
      .select()
      .from(users)
      .where(and(eq(users.mindbodyClientId, criteria.mindbodyClientId), sql`archived_at IS NULL`))
      .limit(1);
    if (results.length > 0) return results[0];
  }

  // 3. Exact hubspotId match
  // FIX: Exclude archived users
  if (criteria.hubspotId) {
    const results = await db
      .select()
      .from(users)
      .where(and(eq(users.hubspotId, criteria.hubspotId), sql`archived_at IS NULL`))
      .limit(1);
    if (results.length > 0) return results[0];
  }

  // 4. Exact phone match (normalize phone format first)
  // FIX: Exclude archived users
  if (criteria.phone) {
    const normalizedPhone = normalizePhone(criteria.phone);
    const results = await db
      .select()
      .from(users)
      .where(and(eq(users.phone, normalizedPhone), sql`archived_at IS NULL`))
      .limit(1);
    if (results.length > 0) return results[0];
  }

  // 5. firstName + lastName + phone match (all three required)
  // FIX: Exclude archived users
  if (criteria.firstName && criteria.lastName && criteria.phone) {
    const normalizedPhone = normalizePhone(criteria.phone);
    const results = await db
      .select()
      .from(users)
      .where(
        and(
          ilike(users.firstName, criteria.firstName),
          ilike(users.lastName, criteria.lastName),
          eq(users.phone, normalizedPhone),
          sql`archived_at IS NULL`
        )
      )
      .limit(1);
    if (results.length > 0) return results[0];
  }

  return null;
}

/**
 * Creates a new visitor or updates an existing user if found via matching
 * New users are created with role='visitor' and membershipStatus='visitor'
 * Also ensures a Stripe customer is created for billing purposes
 */
export async function upsertVisitor(data: VisitorData, createStripeCustomer: boolean = true): Promise<User> {
  // Try to find existing user
  const existingUser = await findMatchingUser(data);

  if (!existingUser && data.email) {
    const archivedUser = await db.select().from(users)
      .where(ilike(users.email, data.email.trim().toLowerCase()))
      .limit(1);
    if (archivedUser.length > 0 && archivedUser[0].archivedAt) {
      const updated = await db.update(users).set({
        firstName: data.firstName ?? archivedUser[0].firstName,
        lastName: data.lastName ?? archivedUser[0].lastName,
        phone: data.phone ? normalizePhone(data.phone) : archivedUser[0].phone,
        mindbodyClientId: data.mindbodyClientId ?? archivedUser[0].mindbodyClientId,
        hubspotId: data.hubspotId ?? archivedUser[0].hubspotId,
        archivedAt: null,
        archivedBy: null,
        updatedAt: new Date(),
      }).where(eq(users.id, archivedUser[0].id)).returning();
      logger.info(`[Auto-Unarchive] User ${data.email} unarchived via upsertVisitor (day pass purchase or similar)`);
      if (updated[0].email) {
        findOrCreateHubSpotContact(
          updated[0].email,
          updated[0].firstName || '',
          updated[0].lastName || '',
          updated[0].phone || undefined
        ).catch((err) => {
          logger.error('[upsertVisitor] Background HubSpot sync failed:', { extra: { detail: err instanceof Error ? err.message : String(err) } });
        });
        if (updated[0].stripeCustomerId) {
          syncCustomerMetadataToStripe(updated[0].email).catch((err) => {
            logger.error('[upsertVisitor] Background Stripe sync failed:', { extra: { detail: err instanceof Error ? err.message : String(err) } });
          });
        }
      }
      return updated[0];
    }
  }

  if (existingUser) {
    // Update existing user with provided data
    const updated = await db
      .update(users)
      .set({
        email: data.email ?? existingUser.email,
        firstName: data.firstName ?? existingUser.firstName,
        lastName: data.lastName ?? existingUser.lastName,
        phone: data.phone ? normalizePhone(data.phone) : existingUser.phone,
        mindbodyClientId: data.mindbodyClientId ?? existingUser.mindbodyClientId,
        hubspotId: data.hubspotId ?? existingUser.hubspotId,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingUser.id))
      .returning();

    if (updated[0].email) {
      findOrCreateHubSpotContact(
        updated[0].email,
        updated[0].firstName || '',
        updated[0].lastName || '',
        updated[0].phone || undefined
      ).catch((err) => {
        logger.error('[upsertVisitor] Background HubSpot sync failed:', { extra: { detail: err instanceof Error ? err.message : String(err) } });
      });
      if (updated[0].stripeCustomerId) {
        syncCustomerMetadataToStripe(updated[0].email).catch((err) => {
          logger.error('[upsertVisitor] Background Stripe sync failed:', { extra: { detail: err instanceof Error ? err.message : String(err) } });
        });
      }
    }

    return updated[0];
  }

  // Check sync exclusions before creating visitor
  if (data.email) {
    const exclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${data.email.toLowerCase().trim()}`);
    if ((exclusionCheck.rows as any[]).length > 0) {
      throw new Error(`Cannot create visitor for ${data.email} — permanently deleted (sync_exclusions)`);
    }
  }

  // Create new visitor user
  const newUser = await db
    .insert(users)
    .values({
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone ? normalizePhone(data.phone) : undefined,
      mindbodyClientId: data.mindbodyClientId,
      hubspotId: data.hubspotId,
      role: "visitor",
      membershipStatus: "visitor",
    })
    .returning();

  const createdUser = newUser[0];

  return createdUser;
}

/**
 * Links a day pass purchase to a user
 */
export async function linkPurchaseToUser(
  purchaseId: string,
  userId: string
): Promise<void> {
  await db
    .update(dayPassPurchases)
    .set({
      userId: userId,
      updatedAt: new Date(),
    })
    .where(eq(dayPassPurchases.id, purchaseId));
}
