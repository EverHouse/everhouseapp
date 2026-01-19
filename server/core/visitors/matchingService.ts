import { db } from "../../db";
import { users, dayPassPurchases } from "../../../shared/schema";
import { User } from "../../../shared/schema";
import { eq, ilike, and } from "drizzle-orm";

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
 * 2. Exact mindbodyClientId match
 * 3. Exact hubspotId match
 * 4. Exact phone match (normalized)
 * 5. firstName + lastName + phone match (all three required)
 */
export async function findMatchingUser(criteria: MatchCriteria): Promise<User | null> {
  // 1. Exact email match (case-insensitive, trim whitespace)
  if (criteria.email) {
    const trimmedEmail = criteria.email.trim();
    const results = await db
      .select()
      .from(users)
      .where(ilike(users.email, trimmedEmail))
      .limit(1);
    if (results.length > 0) return results[0];
  }

  // 2. Exact mindbodyClientId match
  if (criteria.mindbodyClientId) {
    const results = await db
      .select()
      .from(users)
      .where(eq(users.mindbodyClientId, criteria.mindbodyClientId))
      .limit(1);
    if (results.length > 0) return results[0];
  }

  // 3. Exact hubspotId match
  if (criteria.hubspotId) {
    const results = await db
      .select()
      .from(users)
      .where(eq(users.hubspotId, criteria.hubspotId))
      .limit(1);
    if (results.length > 0) return results[0];
  }

  // 4. Exact phone match (normalize phone format first)
  if (criteria.phone) {
    const normalizedPhone = normalizePhone(criteria.phone);
    const results = await db
      .select()
      .from(users)
      .where(eq(users.phone, normalizedPhone))
      .limit(1);
    if (results.length > 0) return results[0];
  }

  // 5. firstName + lastName + phone match (all three required)
  if (criteria.firstName && criteria.lastName && criteria.phone) {
    const normalizedPhone = normalizePhone(criteria.phone);
    const results = await db
      .select()
      .from(users)
      .where(
        and(
          ilike(users.firstName, criteria.firstName),
          ilike(users.lastName, criteria.lastName),
          eq(users.phone, normalizedPhone)
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
 */
export async function upsertVisitor(data: VisitorData): Promise<User> {
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

  return newUser[0];
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
