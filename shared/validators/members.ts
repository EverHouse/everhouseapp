import { z } from 'zod';

export const profileUpdateSchema = z.object({
  firstName: z.string().min(1, 'First name is required').max(100).trim(),
  lastName: z.string().min(1, 'Last name is required').max(100).trim(),
  phone: z.string().min(1, 'Phone is required').max(30).trim(),
});

export const smsPreferencesSchema = z.object({
  smsPromoOptIn: z.boolean().optional(),
  smsTransactionalOptIn: z.boolean().optional(),
  smsRemindersOptIn: z.boolean().optional(),
});

export const tierChangeSchema = z.object({
  tier: z.string().nullable().optional(),
  immediate: z.boolean().optional(),
});

export const createMemberSchema = z.object({
  firstName: z.string().min(1, 'First name is required').max(100).trim(),
  lastName: z.string().min(1, 'Last name is required').max(100).trim(),
  email: z.string().email('Valid email is required').transform(val => val.trim().toLowerCase()),
  phone: z.string().max(30).optional(),
  tier: z.string().min(1, 'Tier is required'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date must be in YYYY-MM-DD format').optional(),
  discountReason: z.string().max(500).optional(),
});

export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
export type SmsPreferencesInput = z.infer<typeof smsPreferencesSchema>;
export type TierChangeInput = z.infer<typeof tierChangeSchema>;
export type CreateMemberInput = z.infer<typeof createMemberSchema>;
