import { z } from 'zod';

const participantSchema = z.object({
  email: z.string().email('Invalid participant email').optional(),
  type: z.enum(['member', 'guest']),
  name: z.string().max(200).optional(),
  userId: z.string().optional(),
}).refine(data => {
  if (data.type === 'guest') return !!data.email;
  return !!(data.email || data.userId);
}, {
  message: 'Guests require email; members require email or userId',
});

export const createBookingRequestSchema = z.object({
  user_email: z.string().email('Valid email is required'),
  user_name: z.string().max(200).optional(),
  resource_id: z.number().int().positive().optional().nullable(),
  resource_preference: z.string().max(100).optional().nullable(),
  request_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Time must be in HH:MM or HH:MM:SS format'),
  duration_minutes: z.number().int().min(1, 'Duration must be at least 1 minute').max(480, 'Duration cannot exceed 480 minutes'),
  declared_player_count: z.number().int().min(1).max(4).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  user_tier: z.string().max(50).optional().nullable(),
  member_notes: z.string().max(1000).optional().nullable(),
  guardian_name: z.string().max(200).optional().nullable(),
  guardian_relationship: z.string().max(100).optional().nullable(),
  guardian_phone: z.string().max(30).optional().nullable(),
  guardian_consent: z.boolean().optional().nullable(),
  request_participants: z.array(participantSchema).max(10).optional().nullable(),
});

export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>;
