import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials } from './useFetch';

interface DailySummary {
  date: string;
  totalCollected: number;
  breakdown: {
    guest_fee: number;
    overage: number;
    merchandise: number;
    membership: number;
    cash: number;
    check: number;
    other: number;
  };
  transactionCount: number;
}

interface OverduePayment {
  bookingId: number;
  sessionId: number;
  ownerEmail: string;
  ownerName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  totalOutstanding: number;
  unreviewedWaivers: number;
}

interface FailedPayment {
  id: number;
  paymentIntentId: string;
  memberEmail: string;
  memberName: string;
  amount: number;
  description: string | null;
  status: string;
  failureReason: string | null;
  retryCount: number;
  lastRetryAt: string | null;
  requiresCardUpdate: boolean;
  dunningNotifiedAt: string | null;
  createdAt: string;
}

interface PendingAuthorization {
  id: number;
  paymentIntentId: string;
  memberEmail: string;
  memberName: string;
  amount: number;
  description: string | null;
  createdAt: string;
  expiresAt: string;
}

interface RefundablePayment {
  paymentIntentId: string;
  memberEmail: string;
  memberName: string;
  amount: number;
  description: string;
  createdAt: string;
  status: string;
}

interface SubscriptionListItem {
  id: string;
  memberEmail: string;
  memberName: string;
  planName: string;
  amount: number;
  currency: string;
  interval: string;
  status: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
}

interface InvoiceListItem {
  id: string;
  memberEmail: string;
  memberName: string;
  number: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: string;
  created: number;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

export const financialsKeys = {
  all: ['financials'] as const,
  dailySummary: () => [...financialsKeys.all, 'daily-summary'] as const,
  overduePayments: () => [...financialsKeys.all, 'overdue-payments'] as const,
  failedPayments: () => [...financialsKeys.all, 'failed-payments'] as const,
  pendingAuthorizations: () => [...financialsKeys.all, 'pending-authorizations'] as const,
  refundablePayments: () => [...financialsKeys.all, 'refundable-payments'] as const,
  subscriptions: (status?: string) => [...financialsKeys.all, 'subscriptions', { status }] as const,
  invoices: (params?: { status?: string; startDate?: string; endDate?: string }) => 
    [...financialsKeys.all, 'invoices', params] as const,
};

export function useDailySummary() {
  return useQuery({
    queryKey: financialsKeys.dailySummary(),
    queryFn: () => fetchWithCredentials<DailySummary>('/api/payments/daily-summary'),
  });
}

export function useOverduePayments() {
  return useQuery({
    queryKey: financialsKeys.overduePayments(),
    queryFn: () => fetchWithCredentials<OverduePayment[]>('/api/bookings/overdue-payments'),
  });
}

export function useFailedPayments() {
  return useQuery({
    queryKey: financialsKeys.failedPayments(),
    queryFn: async () => {
      const data = await fetchWithCredentials<FailedPayment[]>('/api/payments/failed');
      return Array.isArray(data) ? data : [];
    },
  });
}

export function usePendingAuthorizations() {
  return useQuery({
    queryKey: financialsKeys.pendingAuthorizations(),
    queryFn: async () => {
      const data = await fetchWithCredentials<PendingAuthorization[]>('/api/payments/pending-authorizations');
      return Array.isArray(data) ? data : [];
    },
  });
}

export function useRefundablePayments() {
  return useQuery({
    queryKey: financialsKeys.refundablePayments(),
    queryFn: () => fetchWithCredentials<RefundablePayment[]>('/api/payments/refundable'),
  });
}

export function useSubscriptions(statusFilter: string = 'all') {
  return useQuery({
    queryKey: financialsKeys.subscriptions(statusFilter),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.append('status', statusFilter);
      params.append('limit', '50');
      const url = `/api/financials/subscriptions${params.toString() ? `?${params.toString()}` : ''}`;
      const data = await fetchWithCredentials<{ subscriptions: SubscriptionListItem[]; hasMore: boolean; nextCursor?: string }>(url);
      return data;
    },
  });
}

export function useInvoices(statusFilter: string = 'all', startDate?: string, endDate?: string) {
  return useQuery({
    queryKey: financialsKeys.invoices({ status: statusFilter, startDate, endDate }),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);
      params.append('limit', '50');
      const url = `/api/financials/invoices${params.toString() ? `?${params.toString()}` : ''}`;
      const data = await fetchWithCredentials<{ invoices: InvoiceListItem[]; hasMore: boolean; nextCursor?: string }>(url);
      return data;
    },
  });
}

export function useRetryPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paymentIntentId: string) => 
      postWithCredentials<{ success: boolean }>('/api/payments/retry', { paymentIntentId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: financialsKeys.failedPayments() });
    },
  });
}

export function useCancelPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paymentIntentId: string) => 
      postWithCredentials<{ success: boolean }>('/api/payments/cancel', { paymentIntentId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: financialsKeys.failedPayments() });
    },
  });
}

export function useCapturePayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentIntentId, amountCents }: { paymentIntentId: string; amountCents?: number }) =>
      postWithCredentials<{ success: boolean }>('/api/payments/capture', { paymentIntentId, amountCents }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: financialsKeys.pendingAuthorizations() });
      queryClient.invalidateQueries({ queryKey: financialsKeys.dailySummary() });
    },
  });
}

export function useVoidPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentIntentId, reason }: { paymentIntentId: string; reason?: string }) =>
      postWithCredentials<{ success: boolean }>('/api/payments/void-authorization', { paymentIntentId, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: financialsKeys.pendingAuthorizations() });
    },
  });
}

export function useRefundPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentIntentId, amountCents, reason }: { paymentIntentId: string; amountCents?: number | null; reason: string }) =>
      postWithCredentials<{ success: boolean }>('/api/payments/refund', { paymentIntentId, amountCents, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: financialsKeys.refundablePayments() });
      queryClient.invalidateQueries({ queryKey: financialsKeys.dailySummary() });
    },
  });
}
