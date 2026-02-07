import { db } from "../../db";
import { users, dayPassPurchases } from "../../../shared/schema";
import { userLinkedEmails } from "../../../shared/models/membership";
import { User } from "../../../shared/schema";
import { eq, ilike, and, sql } from "drizzle-orm";
import { getOrCreateStripeCustomer } from "../stripe/customers";

const PLACEHOLDER_EMAIL_PATTERNS = [
  '@visitors.everclub.app',
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

    // Ensure Stripe customer exists for existing visitor (skip placeholder emails)
    // getOrCreateStripeCustomer handles both lookup and DB update internally
    if (createStripeCustomer && data.email && !existingUser.stripeCustomerId && !isPlaceholderEmail(data.email)) {
      try {
        const fullName = [data.firstName ?? existingUser.firstName, data.lastName ?? existingUser.lastName]
          .filter(Boolean).join(' ') || undefined;
        await getOrCreateStripeCustomer(existingUser.id, data.email, fullName, 'visitor');
      } catch (stripeError) {
        console.error('[upsertVisitor] Failed to create Stripe customer for existing visitor:', stripeError);
      }
    }

    return updated[0];
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

  // Create Stripe customer for new visitor (skip placeholder emails)
  // getOrCreateStripeCustomer handles both creation and DB update internally
  if (createStripeCustomer && data.email && !isPlaceholderEmail(data.email)) {
    try {
      const fullName = [data.firstName, data.lastName].filter(Boolean).join(' ') || undefined;
      await getOrCreateStripeCustomer(createdUser.id, data.email, fullName, 'visitor');
    } catch (stripeError) {
      console.error('[upsertVisitor] Failed to create Stripe customer for new visitor:', stripeError);
    }
  }

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
