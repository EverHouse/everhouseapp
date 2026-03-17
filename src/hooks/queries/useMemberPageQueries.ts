import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials } from './useFetch';

export const memberPageKeys = {
  all: ['member-page'] as const,
  dashboard: (email: string) => [...memberPageKeys.all, 'dashboard', email] as const,
  myBookings: (email: string) => [...memberPageKeys.all, 'my-bookings', email] as const,
  myBilling: (email: string) => [...memberPageKeys.all, 'my-billing', email] as const,
  updates: () => [...memberPageKeys.all, 'updates'] as const,
  announcements: () => [...memberPageKeys.all, 'announcements'] as const,
  notices: () => [...memberPageKeys.all, 'notices'] as const,
  dismissedNotices: () => [...memberPageKeys.all, 'dismissed-notices'] as const,
  checkout: (sessionId: string) => [...memberPageKeys.all, 'checkout', sessionId] as const,
  myGuestPasses: (email: string) => [...memberPageKeys.all, 'guest-passes', email] as const,
  myUpcomingBookings: (email: string) => [...memberPageKeys.all, 'upcoming-bookings', email] as const,
  myRecentActivity: (email: string) => [...memberPageKeys.all, 'recent-activity', email] as const,
  accountBalance: (email: string) => [...memberPageKeys.all, 'account-balance', email] as const,
  savedCard: (email: string) => [...memberPageKeys.all, 'saved-card', email] as const,
  invoices: (email: string) => [...memberPageKeys.all, 'invoices', email] as const,
  subscription: (email: string) => [...memberPageKeys.all, 'subscription', email] as const,
};

export function useMemberDashboardData(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberPageKeys.dashboard(email ?? ''),
    queryFn: () => fetchWithCredentials<Record<string, unknown>>(`/api/my-dashboard?email=${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMyBookings(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberPageKeys.myBookings(email ?? ''),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>(`/api/my-bookings?email=${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMyBillingSummary(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberPageKeys.myBilling(email ?? ''),
    queryFn: () => fetchWithCredentials<Record<string, unknown>>(`/api/my-billing/summary?email=${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMemberUpdates() {
  return useQuery({
    queryKey: memberPageKeys.updates(),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/updates'),
  });
}

export function useMemberAnnouncements() {
  return useQuery({
    queryKey: memberPageKeys.announcements(),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/announcements'),
  });
}

export function useDismissedNotices() {
  return useQuery({
    queryKey: memberPageKeys.dismissedNotices(),
    queryFn: () => fetchWithCredentials<{ dismissed: number[] }>('/api/notices/dismissed'),
    staleTime: 1000 * 60 * 5,
  });
}

export function useDismissNotice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (noticeId: number) =>
      postWithCredentials<{ success: boolean }>('/api/notices/dismiss', { noticeId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberPageKeys.dismissedNotices() });
    },
  });
}

export function useMyGuestPasses(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberPageKeys.myGuestPasses(email ?? ''),
    queryFn: () => fetchWithCredentials<Record<string, unknown>>(`/api/my-billing/guest-passes?email=${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMyUpcomingBookings(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberPageKeys.myUpcomingBookings(email ?? ''),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>(`/api/my-bookings/upcoming?email=${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useAccountBalance(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberPageKeys.accountBalance(email ?? ''),
    queryFn: () => fetchWithCredentials<{ balanceCents: number; balanceDollars: number }>(`/api/my-billing/account-balance?user_email=${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMySavedCard(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberPageKeys.savedCard(email ?? ''),
    queryFn: () => fetchWithCredentials<{ hasSavedCard: boolean; cardLast4?: string; cardBrand?: string }>(`/api/stripe/staff/check-saved-card/${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMyInvoices(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberPageKeys.invoices(email ?? ''),
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>(`/api/my-billing/invoices?email=${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useMySubscription(email: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memberPageKeys.subscription(email ?? ''),
    queryFn: () => fetchWithCredentials<Record<string, unknown>>(`/api/my-billing/subscription?email=${encodeURIComponent(email!)}`),
    enabled: (options?.enabled ?? true) && !!email,
  });
}

export function useCancelMyBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, reason }: { bookingId: number | string; reason?: string }) =>
      postWithCredentials<{ success: boolean }>(`/api/bookings/${bookingId}/cancel`, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberPageKeys.all });
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
    },
  });
}

export function useSubmitBugReport() {
  return useMutation({
    mutationFn: (data: { description: string; screenshotUrl?: string; pageUrl?: string; userAgent?: string }) =>
      postWithCredentials<{ success: boolean }>('/api/bug-reports', data),
  });
}

export function usePublicFaqs() {
  return useQuery({
    queryKey: ['public', 'faqs'],
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/faqs'),
    staleTime: 1000 * 60 * 10,
  });
}

export function usePublicGallery() {
  return useQuery({
    queryKey: ['public', 'gallery'],
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/gallery'),
    staleTime: 1000 * 60 * 10,
  });
}

export function usePublicPricing() {
  return useQuery({
    queryKey: ['public', 'pricing'],
    queryFn: () => fetchWithCredentials<Record<string, unknown>>('/api/pricing'),
    staleTime: 1000 * 60 * 10,
  });
}

export function usePublicMembershipTiers() {
  return useQuery({
    queryKey: ['public', 'membership-tiers'],
    queryFn: () => fetchWithCredentials<Array<Record<string, unknown>>>('/api/membership-tiers?active=true'),
    staleTime: 1000 * 60 * 10,
  });
}

export function useSubmitContactForm() {
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      postWithCredentials<{ success: boolean }>('/api/hubspot/forms/contact', data),
  });
}

export function useMapKitToken() {
  return useQuery({
    queryKey: ['public', 'mapkit-token'],
    queryFn: async () => {
      const res = await fetch('/api/mapkit-token');
      if (!res.ok) throw new Error('Failed to fetch mapkit token');
      return res.json() as Promise<{ token: string }>;
    },
    staleTime: 1000 * 60 * 30,
  });
}

export function usePublicSettings() {
  return useQuery({
    queryKey: ['public', 'settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/public');
      if (!res.ok) throw new Error('Failed to fetch settings');
      return res.json() as Promise<Record<string, string>>;
    },
    staleTime: 1000 * 60 * 10,
  });
}

export function useSubmitApplication() {
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      postWithCredentials<Record<string, unknown>>('/api/hubspot/forms/membership', data),
  });
}

export function useSubmitPrivateHireInquiry() {
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      postWithCredentials<Record<string, unknown>>('/api/hubspot/forms/private-hire', data),
  });
}

export function useDayPassCheckout() {
  return useMutation({
    mutationFn: (data: { email: string; passType: string; firstName?: string; lastName?: string }) =>
      postWithCredentials<{ checkoutUrl?: string }>('/api/public/day-pass/checkout', data),
  });
}
