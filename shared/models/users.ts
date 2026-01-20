import { z } from "zod";

// User schema with Corporate fields - uses camelCase to match Drizzle model
export const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.enum(["admin", "member", "staff"]),
  membershipStatus: z.string().optional(),

  // Corporate & HubSpot Fields (camelCase to match Drizzle model in auth-session.ts)
  companyName: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  hubspotContactId: z.string().nullable().optional(),
  hubspotCompanyId: z.string().nullable().optional(),

  // Billing group reference
  billingGroupId: z.number().nullable().optional(),

  createdAt: z.date().optional(),
});

export type User = z.infer<typeof userSchema>;
