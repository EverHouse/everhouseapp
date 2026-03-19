import { z } from "zod";

// Zod validation schema for API-facing user payloads (subset of the full Drizzle `users` table in auth-session.ts).
// This schema validates incoming user data at API boundaries. It does NOT define the database table —
// the full table definition with 40+ columns (auth linking, membership, billing, etc.) lives in auth-session.ts.
// Only fields needed for API validation are included here.
export const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.enum(["admin", "member", "staff"]),
  membershipStatus: z.string().optional(),

  // Corporate & HubSpot Fields (camelCase to match Drizzle model in auth-session.ts)
  companyName: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  hubspotId: z.string().nullable().optional(),
  hubspotCompanyId: z.string().nullable().optional(),

  // Billing group reference
  billingGroupId: z.number().nullable().optional(),

  createdAt: z.date().optional(),
});

export type User = z.infer<typeof userSchema>;
