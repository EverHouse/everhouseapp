import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials, putWithCredentials, patchWithCredentials } from './useFetch';

export interface MemberHistory {
  bookings: BookingHistoryItem[];
  visits: Array<{ id: number; date: string; type: string; notes?: string }>;
  totalVisits: number;
  [key: string]: unknown;
}

export interface BookingHistoryItem {
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  status: string;
  [key: string]: unknown;
}

export interface MemberNote {
  id: number;
  content: string;
  isPinned: boolean;
  createdAt: string;
  createdBy?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface CommunicationLog {
  id: number;
  type: string;
  direction: string;
  subject: string;
  body: string;
  createdAt: string;
  createdBy?: string;
  [key: string]: unknown;
}

export interface GuestVisit {
  id: number;
  guestName: string;
  date: string;
  [key: string]: unknown;
}

export interface PurchaseItem {
  id: number | string;
  description?: string;
  amount?: number;
  date?: string;
  status?: string;
  type?: string;
  category?: string;
  product_name?: string;
  quantity?: number;
  created_at?: string;
}

export interface AccountBalance {
  balanceCents: number;
  balanceDollars: number;
}

export interface MergePreviewData {
  sourceEmail: string;
  targetEmail: string;
  recordsToTransfer?: number;
  bookings?: number;
  notes?: number;
  communications?: number;
  guestPasses?: number;
  recordsToMerge?: Record<string, { source: number; target: number; action: string }>;
  conflicts?: Array<{ field: string; sourceValue: unknown; targetValue: unknown }>;
  recommendations?: Array<{ field: string; recommendation: string }>;
}

export const memberProfileKeys = {
  all: ['member-profile'] as const,
  details: (email: string) => [...memberProfileKeys.all, 'details', email] as const,
  history: (email: string) => [...memberProfileKeys.all, 'history', email] as const,
  notes: (email: string) => [...memberProfileKeys.all, 'notes', email] as const,
  communications: (email: string) => [...memberProfileKeys.all, 'communications', email] as const,
  guests: (email: string) => [...memberProfileKeys.all, 'guests', email] as const,
  payments: (email: string) => [...memberProfileKeys.all, 'payments', email] as const,
  balance: (email: string) => [...memberProfileKeys.all, 'balance', email] as const,
  idImage: (memberId: string) => [...memberProfileKeys.all, 'id-image', memberId] as const,
  addOptions: () => [...memberProfileKeys.all, 'add-options'] as const,
  mergePreview: (sourceEmail: string, targetEmail: string) => [...memberProfileKeys.all, 'merge-preview', sourceEmail, targetEmail] as const,
};

export function useMemberDetails(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberProfileKeys.details(email ?? ''),
    queryFn: () => fetchWithCredentials<Record<string, unknown>>(`/api/members/${encodeURIComponent(email!)}/details`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMemberHistory(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberProfileKeys.history(email ?? ''),
    queryFn: () => fetchWithCredentials<MemberHistory>(`/api/members/${encodeURIComponent(email!)}/history`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMemberNotes(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberProfileKeys.notes(email ?? ''),
    queryFn: () => fetchWithCredentials<MemberNote[]>(`/api/members/${encodeURIComponent(email!)}/notes`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMemberCommunications(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberProfileKeys.communications(email ?? ''),
    queryFn: () => fetchWithCredentials<CommunicationLog[]>(`/api/members/${encodeURIComponent(email!)}/communications`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMemberGuests(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberProfileKeys.guests(email ?? ''),
    queryFn: () => fetchWithCredentials<GuestVisit[]>(`/api/members/${encodeURIComponent(email!)}/guests`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMemberPayments(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberProfileKeys.payments(email ?? ''),
    queryFn: async () => {
      const data = await fetchWithCredentials<{ payments?: PurchaseItem[] } | PurchaseItem[]>(`/api/stripe/payments/${encodeURIComponent(email!)}`);
      const paymentsArray = Array.isArray(data) ? data : (data.payments || []);
      return Array.isArray(paymentsArray) ? paymentsArray : [];
    },
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMemberBalance(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberProfileKeys.balance(email ?? ''),
    queryFn: () => fetchWithCredentials<AccountBalance>(`/api/my-billing/account-balance?user_email=${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMemberIdImage(memberId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberProfileKeys.idImage(memberId ?? ''),
    queryFn: () => fetchWithCredentials<{ idImageUrl: string | null }>(`/api/admin/member/${encodeURIComponent(memberId!)}/id-image`),
    enabled: (options?.enabled ?? true) && !!memberId,
  });
}

export function useMemberAddOptions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberProfileKeys.addOptions(),
    queryFn: () => fetchWithCredentials<{ tiersWithIds: Array<{ id: number; name: string; priceCents: number; billingInterval: string; hasStripePrice: boolean }> }>('/api/members/add-options'),
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 10,
  });
}

export function useAddMemberNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, content, isPinned }: { email: string; content: string; isPinned: boolean }) =>
      postWithCredentials<MemberNote>(`/api/members/${encodeURIComponent(email)}/notes`, { content, isPinned }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.notes(variables.email) });
    },
  });
}

export function useUpdateMemberNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, noteId, content, isPinned }: { email: string; noteId: number; content: string; isPinned?: boolean }) =>
      putWithCredentials<MemberNote>(`/api/members/${encodeURIComponent(email)}/notes/${noteId}`, { content, isPinned }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.notes(variables.email) });
    },
  });
}

export function useDeleteMemberNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, noteId }: { email: string; noteId: number }) =>
      deleteWithCredentials<{ success: boolean }>(`/api/members/${encodeURIComponent(email)}/notes/${noteId}`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.notes(variables.email) });
    },
  });
}

export function useAddCommunication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, type, direction, subject, body }: { email: string; type: string; direction: string; subject: string; body: string }) =>
      postWithCredentials<CommunicationLog>(`/api/members/${encodeURIComponent(email)}/communications`, { type, direction, subject, body }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.communications(variables.email) });
    },
  });
}

export function useApplyCredit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, amountCents, description }: { email: string; amountCents: number; description: string }) =>
      postWithCredentials<{ endingBalance: number }>(`/api/member-billing/${encodeURIComponent(email)}/credit`, { amountCents, description }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.balance(variables.email) });
    },
  });
}

export function useSaveIdImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, image, mimeType }: { userId: string; image: string; mimeType: string }) =>
      postWithCredentials<{ imageUrl: string }>('/api/admin/save-id-image', { userId, image, mimeType }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.idImage(variables.userId) });
    },
  });
}

export function useDeleteIdImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId }: { memberId: string }) =>
      deleteWithCredentials<{ success: boolean }>(`/api/admin/member/${encodeURIComponent(memberId)}/id-image`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.idImage(variables.memberId) });
    },
  });
}

export function useRemoveLinkedEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ memberEmail, linkedEmail }: { memberEmail: string; linkedEmail: string }) => {
      const res = await fetch('/api/admin/trackman/linked-email', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberEmail, linkedEmail }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to remove linked email');
      }
      return res.json() as Promise<{ manuallyLinkedEmails: string[] }>;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.details(variables.memberEmail) });
    },
  });
}

export function useDeleteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ email, memberId, visitorMode, deleteFromHubSpot, deleteFromStripe }: {
      email: string;
      memberId?: string;
      visitorMode?: boolean;
      deleteFromHubSpot?: boolean;
      deleteFromStripe?: boolean;
    }) => {
      const params = new URLSearchParams();
      if (deleteFromHubSpot) params.append('deleteFromHubSpot', 'true');
      if (deleteFromStripe) params.append('deleteFromStripe', 'true');
      const url = visitorMode && memberId
        ? `/api/visitors/${memberId}?${params}`
        : `/api/members/${encodeURIComponent(email)}/permanent?${params}`;
      return deleteWithCredentials<{ success: boolean }>(url);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

export function useChangeMemberEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ oldEmail, newEmail }: { oldEmail: string; newEmail: string }) =>
      postWithCredentials<{ success: boolean; message?: string }>('/api/admin/member/change-email', { oldEmail, newEmail }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.details(variables.oldEmail) });
      queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

export function useUpdateMemberContactInfo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, ...data }: { email: string; firstName?: string; lastName?: string; phone?: string | null }) =>
      putWithCredentials<{ success: boolean; name?: string; firstName?: string; lastName?: string; phone?: string; syncResults?: { stripe?: boolean; hubspot?: boolean } }>(`/api/members/${encodeURIComponent(email)}/contact-info`, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.details(variables.email) });
      queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

export function useMergePreview() {
  return useMutation({
    mutationFn: ({ primaryUserId, secondaryUserId }: { primaryUserId: string; secondaryUserId: string }) =>
      postWithCredentials<MergePreviewData>('/api/members/merge/preview', { primaryUserId, secondaryUserId }),
  });
}

export function useExecuteMerge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ primaryUserId, secondaryUserId }: { primaryUserId: string; secondaryUserId: string }) =>
      postWithCredentials<{ success: boolean }>('/api/members/merge/execute', { primaryUserId, secondaryUserId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.all });
      queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

export function useSendPaymentLink() {
  return useMutation({
    mutationFn: (data: { email: string; firstName?: string; lastName?: string; tierId: number }) =>
      postWithCredentials<{ success: boolean }>('/api/stripe/staff/send-membership-link', data),
  });
}

export function useSendReactivationLink() {
  return useMutation({
    mutationFn: ({ memberEmail }: { memberEmail: string }) =>
      postWithCredentials<{ success: boolean }>('/api/stripe/staff/send-reactivation-link', { memberEmail }),
  });
}

export function useAssignTier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, tier }: { email: string; tier: string }) =>
      patchWithCredentials<{ success: boolean }>(`/api/members/${encodeURIComponent(email)}/tier`, { tier }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.details(variables.email) });
      queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

export function useDeleteCommunication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, logId }: { email: string; logId: number }) =>
      deleteWithCredentials<{ success: boolean }>(`/api/members/${encodeURIComponent(email)}/communications/${logId}`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: memberProfileKeys.communications(variables.email) });
    },
  });
}
