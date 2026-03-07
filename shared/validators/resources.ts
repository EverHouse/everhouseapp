import { z } from 'zod';

export const assignMemberSchema = z.object({
  member_email: z.string().email('Valid email is required'),
  member_name: z.string().min(1, 'member_name is required').max(200),
  member_id: z.string().nullish(),
});
export type AssignMemberInput = z.infer<typeof assignMemberSchema>;

export const linkTrackmanSchema = z.object({
  trackman_booking_id: z.union([z.string(), z.number()]),
  owner: z.object({
    email: z.string().email(),
    name: z.string().min(1),
    member_id: z.string().nullish(),
  }).optional(),
  member_email: z.string().email().optional(),
  member_name: z.string().optional(),
  member_id: z.string().nullish(),
  additional_players: z.array(z.any()).optional(),
  rememberEmail: z.boolean().optional(),
  originalEmail: z.string().optional(),
});
export type LinkTrackmanInput = z.infer<typeof linkTrackmanSchema>;

export const markAsEventSchema = z.object({
  booking_id: z.number().int().positive().optional(),
  trackman_booking_id: z.string().optional(),
  existingClosureId: z.number().optional(),
  eventTitle: z.string().min(1).max(200).optional(),
}).refine(
  (data) => data.booking_id !== undefined || data.trackman_booking_id !== undefined,
  { message: 'At least one of booking_id or trackman_booking_id is required' }
);
export type MarkAsEventInput = z.infer<typeof markAsEventSchema>;

export const assignWithPlayersSchema = z.object({
  owner: z.object({
    email: z.string().email(),
    name: z.string().min(1),
    member_id: z.string().nullish(),
  }),
  additional_players: z.array(z.any()).optional(),
  rememberEmail: z.boolean().optional(),
  originalEmail: z.string().optional(),
});
export type AssignWithPlayersInput = z.infer<typeof assignWithPlayersSchema>;

export const changeOwnerSchema = z.object({
  new_email: z.string().email('Valid email is required'),
  new_name: z.string().min(1, 'new_name is required').max(200),
  member_id: z.string().nullish(),
});
export type ChangeOwnerInput = z.infer<typeof changeOwnerSchema>;

export const createBookingSchema = z.object({
  resource_id: z.number().int().positive(),
  user_email: z.string().email('Valid email is required'),
  booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'booking_date must be YYYY-MM-DD'),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, 'start_time must be HH:MM'),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, 'end_time must be HH:MM'),
  notes: z.string().max(1000).optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const manualBookingSchema = z.object({
  member_email: z.string().email('Valid email is required'),
  resource_id: z.number().int().positive(),
  booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'booking_date must be YYYY-MM-DD'),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, 'start_time must be HH:MM'),
  duration_minutes: z.number().int().min(1).max(480),
  booking_source: z.string().min(1, 'booking_source is required'),
  guest_count: z.number().int().min(0).default(0),
  notes: z.string().optional(),
  staff_notes: z.string().optional(),
  trackman_booking_id: z.string().optional(),
});
export type ManualBookingInput = z.infer<typeof manualBookingSchema>;

export const declineBookingSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type DeclineBookingInput = z.infer<typeof declineBookingSchema>;
