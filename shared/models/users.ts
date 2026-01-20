import { z } from "zod";

// Update your User schema to include Corporate fields
export const userSchema = z.object({
  id: z.string(), // Replit uses 'id' as a varchar/string
  email: z.string().email(),
  role: z.enum(["admin", "member", "staff"]),
  membershipStatus: z.string().optional(),

  // New Corporate & HubSpot Fields
  company_name: z.string().nullable().optional(),
  job_title: z.string().nullable().optional(),
  hubspot_contact_id: z.string().nullable().optional(),
  hubspot_company_id: z.string().nullable().optional(),

  createdAt: z.date().optional(),
});

export type User = z.infer<typeof userSchema>;
