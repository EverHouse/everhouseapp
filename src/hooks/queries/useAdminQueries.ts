import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials, putWithCredentials, deleteWithCredentials } from './useFetch';

export const adminTabKeys = {
  all: ['admin'] as const,
  applications: () => [...adminTabKeys.all, 'applications'] as const,
  bugReports: (status?: string) => [...adminTabKeys.all, 'bug-reports', status] as const,
  gallery: () => [...adminTabKeys.all, 'gallery'] as const,
  faqs: () => [...adminTabKeys.all, 'faqs'] as const,
  inquiries: (status?: string) => [...adminTabKeys.all, 'inquiries', status] as const,
  notices: () => [...adminTabKeys.all, 'notices'] as const,
  announcements: () => [...adminTabKeys.all, 'announcements'] as const,
  changelog: () => [...adminTabKeys.all, 'changelog'] as const,
  updates: () => [...adminTabKeys.all, 'updates'] as const,
  tiers: (activeOnly?: boolean) => [...adminTabKeys.all, 'tiers', { activeOnly }] as const,
  groupBilling: () => [...adminTabKeys.all, 'group-billing'] as const,
  trackmanWebhookEvents: (filters?: Record<string, unknown>) => [...adminTabKeys.all, 'trackman-webhook-events', filters] as const,
  overduePayments: () => [...adminTabKeys.all, 'overdue-payments'] as const,
  dashboardStats: () => [...adminTabKeys.all, 'dashboard-stats'] as const,
  simulatorSettings: () => [...adminTabKeys.all, 'simulator-settings'] as const,
  pricingConfig: () => [...adminTabKeys.all, 'pricing-config'] as const,
  staffList: () => [...adminTabKeys.all, 'staff-list'] as const,
  coupons: () => [...adminTabKeys.all, 'coupons'] as const,
  dayPassProducts: () => [...adminTabKeys.all, 'day-pass-products'] as const,
  availabilityBlocks: (filters?: Record<string, unknown>) => [...adminTabKeys.all, 'availability-blocks', filters] as const,
  memberDirectory: (status?: string) => [...adminTabKeys.all, 'member-directory', status] as const,
  transactions: (filters?: Record<string, unknown>) => [...adminTabKeys.all, 'transactions', filters] as const,
  bookingRoster: (bookingId: number) => [...adminTabKeys.all, 'booking-roster', bookingId] as const,
  savedCard: (email: string) => [...adminTabKeys.all, 'saved-card', email] as const,
  bookingDetail: (bookingId: number) => [...adminTabKeys.all, 'booking-detail', bookingId] as const,
  overlappingNotices: (filters?: Record<string, unknown>) => [...adminTabKeys.all, 'overlapping-notices', filters] as const,
  feeCalculation: (params?: Record<string, unknown>) => [...adminTabKeys.all, 'fee-calculation', params] as const,
  staffNotifications: (email?: string) => [...adminTabKeys.all, 'staff-notifications', email] as const,
  staffActivity: (params?: Record<string, unknown>) => [...adminTabKeys.all, 'staff-activity', params] as const,
};

export function useApplications() {
  return useQuery({
    queryKey: adminTabKeys.applications(),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/admin/applications'),
  });
}

export function useUpdateApplicationStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      putWithCredentials<Record<string, unknown>>(`/api/admin/applications/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.applications() });
    },
  });
}

export function useSaveApplicationNotes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, notes }: { id: number; notes: string }) =>
      putWithCredentials<Record<string, unknown>>(`/api/admin/applications/${id}/status`, { notes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.applications() });
    },
  });
}

export function useSendApplicationInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ applicationId, tierId }: { applicationId: number; tierId: number; email: string; name: string }) =>
      postWithCredentials<Record<string, unknown>>(`/api/admin/applications/${applicationId}/send-invite`, { tierId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.applications() });
    },
  });
}

export function useSyncHubSpotApplications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      postWithCredentials<{ newInserted: number }>('/api/admin/hubspot/sync-form-submissions', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.applications() });
    },
  });
}

export function useBugReports(status?: string) {
  return useQuery({
    queryKey: adminTabKeys.bugReports(status),
    queryFn: () => {
      const params = new URLSearchParams();
      if (status && status !== 'all') params.append('status', status);
      return fetchWithCredentials<Array<Record<string, unknown>>>(`/api/admin/bug-reports?${params.toString()}`);
    },
  });
}

export function useUpdateBugReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number; status?: string; staffNotes?: string }) =>
      putWithCredentials<Record<string, unknown>>(`/api/admin/bug-reports/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.bugReports() });
    },
  });
}

export function useDeleteBugReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      deleteWithCredentials<{ success: boolean }>(`/api/admin/bug-reports/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.bugReports() });
    },
  });
}

export function useGalleryImages() {
  return useQuery({
    queryKey: adminTabKeys.gallery(),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/gallery?include_inactive=true'),
  });
}

export function useSaveGalleryImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id?: number; title?: string | null; imageUrl: string; category: string; sortOrder: number; isActive: boolean }) => {
      const url = id ? `/api/admin/gallery/${id}` : '/api/admin/gallery';
      const method = id ? 'PUT' : 'POST';
      if (method === 'PUT') {
        return putWithCredentials<Record<string, unknown>>(url, data);
      }
      return postWithCredentials<Record<string, unknown>>(url, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.gallery() });
    },
  });
}

export function useDeleteGalleryImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      deleteWithCredentials<{ success: boolean }>(`/api/admin/gallery/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.gallery() });
    },
  });
}

export function useFaqs() {
  return useQuery({
    queryKey: adminTabKeys.faqs(),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/admin/faqs'),
    staleTime: 1000 * 60 * 5,
  });
}

export function useReorderFaqs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (order: Array<{ id: number; sortOrder: number }>) =>
      postWithCredentials<{ success: boolean }>('/api/admin/faqs/reorder', { order }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.faqs() });
    },
  });
}

export function useSeedFaqs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      postWithCredentials<{ count: number }>('/api/admin/faqs/seed', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.faqs() });
    },
  });
}

export function useSaveFaq() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id?: number; question: string; answer: string; category?: string; sortOrder?: number; isActive?: boolean }) => {
      if (id) {
        return putWithCredentials<Record<string, unknown>>(`/api/admin/faqs/${id}`, data);
      }
      return postWithCredentials<Record<string, unknown>>('/api/admin/faqs', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.faqs() });
    },
  });
}

export function useDeleteFaq() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      deleteWithCredentials<{ success: boolean }>(`/api/admin/faqs/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.faqs() });
    },
  });
}

export function useInquiries(status?: string, formType?: string) {
  return useQuery({
    queryKey: [...adminTabKeys.inquiries(status), formType],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status && status !== 'all') params.append('status', status);
      if (formType && formType !== 'all') params.append('formType', formType);
      return fetchWithCredentials<Array<Record<string, unknown>>>(`/api/admin/inquiries?${params.toString()}`);
    },
  });
}

export function useUpdateInquiry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number; status?: string; notes?: string }) =>
      putWithCredentials<Record<string, unknown>>(`/api/admin/inquiries/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.inquiries() });
    },
  });
}

export function useArchiveInquiry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      deleteWithCredentials<{ success: boolean }>(`/api/admin/inquiries/${id}?archive=true`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.inquiries() });
    },
  });
}

export function useDeleteInquiry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      deleteWithCredentials<{ success: boolean }>(`/api/admin/inquiries/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.inquiries() });
    },
  });
}

export function useSyncHubSpotSubmissions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      postWithCredentials<{ newInserted: number }>('/api/admin/hubspot/sync-form-submissions', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.inquiries() });
    },
  });
}

export function useAnnouncements() {
  return useQuery({
    queryKey: adminTabKeys.announcements(),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/announcements'),
  });
}

export function useSaveAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id?: number; [key: string]: unknown }) => {
      if (id) {
        return putWithCredentials<Record<string, unknown>>(`/api/admin/announcements/${id}`, data);
      }
      return postWithCredentials<Record<string, unknown>>('/api/admin/announcements', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.announcements() });
    },
  });
}

export function useDeleteAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      deleteWithCredentials<{ success: boolean }>(`/api/admin/announcements/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.announcements() });
    },
  });
}

export function useNotices() {
  return useQuery({
    queryKey: adminTabKeys.notices(),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/notices'),
  });
}

export function useSaveNotice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id?: number; [key: string]: unknown }) => {
      if (id) {
        return putWithCredentials<Record<string, unknown>>(`/api/admin/notices/${id}`, data);
      }
      return postWithCredentials<Record<string, unknown>>('/api/admin/notices', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.notices() });
    },
  });
}

export function useDeleteNotice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      deleteWithCredentials<{ success: boolean }>(`/api/admin/notices/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.notices() });
    },
  });
}

export function useMembershipTiers(activeOnly?: boolean) {
  return useQuery({
    queryKey: adminTabKeys.tiers(activeOnly),
    queryFn: () => {
      const url = activeOnly ? '/api/membership-tiers?active=true' : '/api/membership-tiers';
      return fetchWithCredentials<Array<Record<string, unknown>>>(url);
    },
    staleTime: 1000 * 60 * 10,
  });
}

export function useGroupBillingGroups() {
  return useQuery({
    queryKey: adminTabKeys.groupBilling(),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/group-billing/groups'),
  });
}

export function useSaveGroupBilling() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id?: number; [key: string]: unknown }) => {
      if (id) {
        return putWithCredentials<Record<string, unknown>>(`/api/group-billing/groups/${id}`, data);
      }
      return postWithCredentials<Record<string, unknown>>('/api/group-billing/groups', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.groupBilling() });
    },
  });
}

export function useChangelog() {
  return useQuery({
    queryKey: adminTabKeys.changelog(),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/changelog'),
    staleTime: 1000 * 60 * 5,
  });
}

export function useUpdates() {
  return useQuery({
    queryKey: adminTabKeys.updates(),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/updates'),
  });
}

export function useSaveUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id?: number; [key: string]: unknown }) => {
      if (id) {
        return putWithCredentials<Record<string, unknown>>(`/api/admin/updates/${id}`, data);
      }
      return postWithCredentials<Record<string, unknown>>('/api/admin/updates', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.updates() });
    },
  });
}

export function useDeleteUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      deleteWithCredentials<{ success: boolean }>(`/api/admin/updates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.updates() });
    },
  });
}

export function useTrackmanWebhookEvents(filters?: Record<string, unknown>) {
  return useQuery({
    queryKey: adminTabKeys.trackmanWebhookEvents(filters),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([k, v]) => {
          if (v !== undefined && v !== null && v !== '') params.append(k, String(v));
        });
      }
      return fetchWithCredentials<Array<Record<string, unknown>>>(`/api/admin/trackman/webhook-events?${params.toString()}`);
    },
  });
}

export function useStripeCoupons() {
  return useQuery({
    queryKey: adminTabKeys.coupons(),
    queryFn: () => fetchWithCredentials<{ coupons: Array<Record<string, unknown>> }>('/api/stripe/coupons'),
    staleTime: 1000 * 60 * 10,
  });
}

export function useDayPassProducts() {
  return useQuery({
    queryKey: adminTabKeys.dayPassProducts(),
    queryFn: () => fetchWithCredentials<{ products: Array<Record<string, unknown>> }>('/api/day-passes/products'),
    staleTime: 1000 * 60 * 10,
  });
}

export function usePricing() {
  return useQuery({
    queryKey: ['pricing'],
    queryFn: () => fetchWithCredentials<Record<string, unknown>>('/api/pricing'),
    staleTime: 1000 * 60 * 10,
  });
}

export function useMemberSearch(query: string, options?: { enabled?: boolean; includeVisitors?: boolean; memberStatus?: string }) {
  return useQuery({
    queryKey: ['member-search', query, options?.includeVisitors, options?.memberStatus],
    queryFn: () => {
      const params = new URLSearchParams({ q: query });
      if (options?.includeVisitors) params.append('include_visitors', 'true');
      if (options?.memberStatus) params.append('status', options.memberStatus);
      return fetchWithCredentials<Array<Record<string, unknown>>>(`/api/members/search?${params}`);
    },
    enabled: (options?.enabled ?? true) && query.length >= 2,
    staleTime: 1000 * 30,
  });
}

export function useContextualHelp(topic: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['contextual-help', topic],
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>(`/api/faqs?topic=${encodeURIComponent(topic)}`),
    enabled: (options?.enabled ?? true) && !!topic,
    staleTime: 1000 * 60 * 10,
  });
}

export function useAdminAvailabilityBlocks(filters?: { date?: string; resourceId?: number }) {
  return useQuery({
    queryKey: adminTabKeys.availabilityBlocks(filters),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters?.date) params.append('date', filters.date);
      if (filters?.resourceId) params.append('resourceId', String(filters.resourceId));
      return fetchWithCredentials<Array<Record<string, unknown>>>(`/api/availability-blocks?${params.toString()}`);
    },
  });
}

export function useSaveAvailabilityBlock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id?: number; [key: string]: unknown }) => {
      if (id) {
        return putWithCredentials<Record<string, unknown>>(`/api/availability-blocks/${id}`, data);
      }
      return postWithCredentials<Record<string, unknown>>('/api/availability-blocks', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.availabilityBlocks() });
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
    },
  });
}

export function useDeleteAvailabilityBlock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      deleteWithCredentials<{ success: boolean }>(`/api/availability-blocks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.availabilityBlocks() });
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
    },
  });
}

export function useTransactions(filters?: Record<string, unknown>) {
  return useQuery({
    queryKey: adminTabKeys.transactions(filters),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([k, v]) => {
          if (v !== undefined && v !== null && v !== '') params.append(k, String(v));
        });
      }
      return fetchWithCredentials<Array<Record<string, unknown>>>(`/api/payments/transactions?${params.toString()}`);
    },
  });
}

export function useRedeemGuestPass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      postWithCredentials<Record<string, unknown>>('/api/day-passes/redeem', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

export function useUploadImage() {
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('image', file);
      const res = await fetch('/api/admin/upload-image', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      return res.json() as Promise<{ imageUrl: string; originalSize: number; optimizedSize: number }>;
    },
  });
}

export function useReorderGallery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { items: Array<{ id: number; sortOrder: number }> }) =>
      postWithCredentials<{ success: boolean }>('/api/admin/gallery/reorder', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.gallery() });
    },
  });
}

export function useCreateCoupon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      postWithCredentials<Record<string, unknown>>('/api/stripe/coupons', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.coupons() });
    },
  });
}

export function useUpdateCoupon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string }) =>
      putWithCredentials<Record<string, unknown>>(`/api/stripe/coupons/${encodeURIComponent(id)}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.coupons() });
    },
  });
}

export function useDeleteCoupon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      deleteWithCredentials<Record<string, unknown>>(`/api/stripe/coupons/${encodeURIComponent(id)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminTabKeys.coupons() });
    },
  });
}

export function useStaffNotifications(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminTabKeys.staffNotifications(email),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>(`/api/notifications?user_email=${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
    staleTime: 1000 * 60 * 2,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      putWithCredentials<Record<string, unknown>>(`/api/notifications/${id}/read`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...adminTabKeys.all, 'staff-notifications'] });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) =>
      putWithCredentials<Record<string, unknown>>('/api/notifications/mark-all-read', { user_email: email }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...adminTabKeys.all, 'staff-notifications'] });
    },
  });
}

export function useDismissAllNotifications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) =>
      fetchWithCredentials<Record<string, unknown>>('/api/notifications/dismiss-all', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: email }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...adminTabKeys.all, 'staff-notifications'] });
    },
  });
}

export function useStaffActivity(params?: { days?: number; staffFilter?: string; page?: number; pageSize?: number }, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminTabKeys.staffActivity(params as Record<string, unknown>),
    queryFn: () => {
      const searchParams = new URLSearchParams();
      if (params?.days) searchParams.append('days', String(params.days));
      if (params?.staffFilter) searchParams.append('staff', params.staffFilter);
      if (params?.page) searchParams.append('page', String(params.page));
      if (params?.pageSize) searchParams.append('pageSize', String(params.pageSize));
      return fetchWithCredentials<Record<string, unknown>>(`/api/data-tools/staff-activity?${searchParams}`);
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 2,
  });
}
