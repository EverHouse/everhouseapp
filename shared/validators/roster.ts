import { z } from 'zod';

export const addParticipantSchema = z.object({
  type: z.enum(['member', 'guest'], { message: 'Participant type is required' }),
  userId: z.string().optional(),
  guest: z.object({
    name: z.string().min(1, 'Guest name is required').max(200),
    email: z.string().email('Valid guest email is required'),
  }).optional(),
  rosterVersion: z.number().int().optional(),
  useGuestPass: z.boolean().optional(),
  deferFeeRecalc: z.boolean().optional(),
}).refine(
  (data) => data.type !== 'guest' || data.useGuestPass === false || (data.guest && data.guest.name && data.guest.email),
  { message: 'Guest name and email are required when using a guest pass', path: ['guest'] }
);

const batchOperationSchema = z.object({
  action: z.enum(['add', 'remove']),
  type: z.enum(['member', 'guest']).optional(),
  userId: z.string().optional(),
  participantId: z.number().int().positive().optional(),
  guest: z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
  }).optional(),
  useGuestPass: z.boolean().optional(),
});

export const batchRosterSchema = z.object({
  rosterVersion: z.number({ message: 'rosterVersion is required' }).int(),
  operations: z.array(batchOperationSchema).min(1, 'At least one operation is required').max(20),
});

export const previewFeesSchema = z.object({
  provisionalParticipants: z.array(z.object({
    type: z.enum(['member', 'guest']).optional(),
    userId: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
    useGuestPass: z.boolean().optional(),
  })).optional().default([]),
});

export const playerCountSchema = z.object({
  playerCount: z.number({ message: 'playerCount is required' }).int().min(1).max(4),
  deferFeeRecalc: z.boolean().optional(),
});

export const removeParticipantSchema = z.object({
  rosterVersion: z.number().int().optional(),
});

export const memberCancelSchema = z.object({
  acting_as_email: z.string().email().optional(),
});

export type AddParticipantInput = z.infer<typeof addParticipantSchema>;
export type BatchRosterInput = z.infer<typeof batchRosterSchema>;
export type PreviewFeesInput = z.infer<typeof previewFeesSchema>;
export type PlayerCountInput = z.infer<typeof playerCountSchema>;
export type RemoveParticipantInput = z.infer<typeof removeParticipantSchema>;
export type MemberCancelInput = z.infer<typeof memberCancelSchema>;
