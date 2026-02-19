import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials } from './useFetch';

interface BookingRequest {
  id: number | string;
  user_email: string | null;
  user_name: string | null;
  resource_id: number | null;
  bay_name: string | null;
  resource_preference: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number | null;
  notes: string | null;
  status: string;
  staff_notes: string | null;
  suggested_time: string | null;
  created_at: string | null;
  source?: string;
  resource_name?: string;
  first_name?: string;
  last_name?: string;
  tier?: string | null;
  trackman_booking_id?: string | null;
  has_unpaid_fees?: boolean;
  total_owed?: number;
}

interface Resource {
  id: number;
  name: string;
  type: string;
  description: string | null;
}

interface AvailabilityBlock {
  id: number;
  resourceId: number;
  blockDate: string;
  startTime: string;
  endTime: string;
  blockType: string;
  notes: string | null;
  closureTitle?: string | null;
}

interface CalendarClosure {
  id: number;
  title: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  affectedAreas: string;
  reason: string | null;
}

export const bookingsKeys = {
  all: ['bookings'] as const,
  list: (date: string) => [...bookingsKeys.all, 'list', date] as const,
  requests: (filters?: { status?: string; date?: string }) => [...bookingsKeys.all, 'requests', filters] as const,
  resources: () => [...bookingsKeys.all, 'resources'] as const,
  availability: (date: string, resourceId?: number) => [...bookingsKeys.all, 'availability', date, resourceId] as const,
  closures: () => [...bookingsKeys.all, 'closures'] as const,
  detail: (id: number | string) => [...bookingsKeys.all, 'detail', id] as const,
};

export function useResources() {
  return useQuery({
    queryKey: bookingsKeys.resources(),
    queryFn: () => fetchWithCredentials<Resource[]>('/api/resources'),
    staleTime: 1000 * 60 * 10,
  });
}

export function useBookingsByDate(date: string) {
  return useQuery({
    queryKey: bookingsKeys.list(date),
    queryFn: () => fetchWithCredentials<BookingRequest[]>(`/api/bookings?date=${date}`),
    enabled: !!date,
  });
}

export function useBookingRequests(status?: string, date?: string) {
  return useQuery({
    queryKey: bookingsKeys.requests({ status, date }),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status) params.append('status', status);
      if (date) params.append('date', date);
      const url = `/api/booking-requests${params.toString() ? `?${params.toString()}` : ''}`;
      return fetchWithCredentials<BookingRequest[]>(url);
    },
  });
}

export function useAvailabilityBlocks(date: string, resourceId?: number) {
  return useQuery({
    queryKey: bookingsKeys.availability(date, resourceId),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.append('date', date);
      if (resourceId) params.append('resourceId', String(resourceId));
      return fetchWithCredentials<AvailabilityBlock[]>(`/api/availability-blocks?${params.toString()}`);
    },
    enabled: !!date,
  });
}

export function useCalendarClosures() {
  return useQuery({
    queryKey: bookingsKeys.closures(),
    queryFn: () => fetchWithCredentials<CalendarClosure[]>('/api/closures'),
    staleTime: 1000 * 60 * 5,
  });
}

export function useApproveBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, resourceId, staffNotes }: { bookingId: number | string; resourceId?: number; staffNotes?: string }) =>
      postWithCredentials<{ success: boolean }>(`/api/booking-requests/${bookingId}/approve`, { resourceId, staffNotes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
    },
  });
}

export function useDeclineBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, reason }: { bookingId: number | string; reason?: string }) =>
      postWithCredentials<{ success: boolean }>(`/api/booking-requests/${bookingId}/decline`, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
    },
  });
}

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, reason }: { bookingId: number | string; reason?: string }) =>
      postWithCredentials<{ success: boolean }>(`/api/bookings/${bookingId}/cancel`, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
    },
  });
}

export function useCheckInBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, actualPlayerCount, waiverWaived }: { sessionId: number; actualPlayerCount?: number; waiverWaived?: boolean }) =>
      postWithCredentials<{ success: boolean }>(`/api/bookings/sessions/${sessionId}/check-in`, { actualPlayerCount, waiverWaived }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
    },
  });
}

export function useCheckOutBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, actualEndTime }: { sessionId: number; actualEndTime?: string }) =>
      postWithCredentials<{ success: boolean }>(`/api/bookings/sessions/${sessionId}/check-out`, { actualEndTime }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
    },
  });
}

export function useCreateManualBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      memberEmail: string;
      resourceId: number;
      bookingDate: string;
      startTime: string;
      durationMinutes: number;
      guestCount?: number;
      notes?: string;
      staffNotes?: string;
      source?: string;
      trackmanBookingId?: string;
    }) => postWithCredentials<{ id: number }>('/api/bookings/manual', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
    },
  });
}

interface Bay {
  id: number;
  name: string;
  description: string;
}

interface PendingBooking {
  id: number;
  user_email: string;
  first_name?: string;
  last_name?: string;
  resource_name?: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  notes: string | null;
  status: string;
  created_at: string | null;
}

interface MemberContact {
  email: string;
  firstName: string | null;
  lastName: string | null;
  tier: string | null;
  status?: string;
  manuallyLinkedEmails?: string[];
}

export const simulatorKeys = {
  all: ['simulator'] as const,
  allRequests: () => [...simulatorKeys.all, 'allRequests'] as const,
  pendingBookings: () => [...simulatorKeys.all, 'pendingBookings'] as const,
  approvedBookings: (startDate: string, endDate: string) => [...simulatorKeys.all, 'approved', startDate, endDate] as const,
  bays: () => [...simulatorKeys.all, 'bays'] as const,
  memberContacts: (status?: string) => [...simulatorKeys.all, 'memberContacts', status] as const,
  feeEstimate: (id: number | string) => [...simulatorKeys.all, 'feeEstimate', id] as const,
  bayAvailability: (resourceId: number, date: string) => [...simulatorKeys.all, 'bayAvailability', resourceId, date] as const,
};

export function useAllBookingRequests() {
  return useQuery({
    queryKey: simulatorKeys.allRequests(),
    queryFn: () => fetchWithCredentials<BookingRequest[]>('/api/booking-requests?include_all=true'),
    staleTime: 1000 * 30,
  });
}

export function usePendingBookings() {
  return useQuery({
    queryKey: simulatorKeys.pendingBookings(),
    queryFn: () => fetchWithCredentials<PendingBooking[]>('/api/pending-bookings'),
    staleTime: 1000 * 30,
  });
}

export function useApprovedBookings(startDate: string, endDate: string) {
  return useQuery({
    queryKey: simulatorKeys.approvedBookings(startDate, endDate),
    queryFn: () => fetchWithCredentials<BookingRequest[]>(`/api/approved-bookings?start_date=${startDate}&end_date=${endDate}`),
    enabled: !!startDate && !!endDate,
    staleTime: 1000 * 30,
  });
}

export function useBays() {
  return useQuery({
    queryKey: simulatorKeys.bays(),
    queryFn: () => fetchWithCredentials<Bay[]>('/api/bays'),
    staleTime: 1000 * 60 * 10,
  });
}

export function useMemberContacts(status?: string) {
  return useQuery({
    queryKey: simulatorKeys.memberContacts(status),
    queryFn: async () => {
      const url = status ? `/api/hubspot/contacts?status=${status}` : '/api/hubspot/contacts';
      const rawData = await fetchWithCredentials<MemberContact[] | { contacts: MemberContact[] }>(url);
      return Array.isArray(rawData) ? rawData : (rawData.contacts || []);
    },
    staleTime: 1000 * 60 * 5,
  });
}

export function useFeeEstimate(bookingId: number | string | null, options?: { enabled?: boolean }) {
  const isEnabled = (options?.enabled ?? true) && !!bookingId;
  return useQuery({
    queryKey: simulatorKeys.feeEstimate(bookingId ?? ''),
    queryFn: async () => {
      const res = await fetch(`/api/fee-estimate?bookingId=${bookingId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch fee estimate');
      return res.json() as Promise<{
        totalFee: number;
        ownerTier: string | null;
        perPersonMins: number;
        feeBreakdown: {
          overageMinutes: number;
          overageFee: number;
          guestCount: number;
          guestPassesRemaining: number;
          guestsUsingPasses: number;
          guestsCharged: number;
          guestFees: number;
        };
        note: string;
      }>;
    },
    enabled: isEnabled,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useBayAvailability(resourceId: number | null, date: string | null) {
  return useQuery({
    queryKey: simulatorKeys.bayAvailability(resourceId ?? 0, date ?? ''),
    queryFn: () => fetchWithCredentials<Array<{ start_time?: string; block_type?: string }>>(`/api/bays/${resourceId}/availability?date=${date}`),
    enabled: !!resourceId && !!date,
  });
}

export function useUpdateBookingStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ bookingId, status, source, skipPaymentCheck }: { 
      bookingId: number | string; 
      status: 'attended' | 'no_show' | 'cancelled'; 
      source?: string;
      skipPaymentCheck?: boolean;
    }) => {
      const response = await fetch(`/api/bookings/${bookingId}/checkin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status, source, skipPaymentCheck })
      });
      
      if (response.status === 402) {
        const errorData = await response.json();
        throw { status: 402, ...errorData };
      }
      
      if (response.status === 400) {
        const errorData = await response.json();
        throw { status: 400, ...errorData };
      }
      
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to update status');
      }
      
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
      queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
    },
  });
}

export function useCancelBookingWithOptimistic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ bookingId, source, cancelledBy }: { 
      bookingId: number | string; 
      source?: string;
      cancelledBy?: string;
    }) => {
      const response = await fetch(`/api/bookings/${bookingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'cancelled', source, cancelled_by: cancelledBy })
      });
      
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to cancel booking');
      }
      
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
      queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
    },
  });
}

export function useApproveBookingRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ bookingId, resourceId, staffNotes, reviewedBy, source }: { 
      bookingId: number | string; 
      resourceId?: number;
      staffNotes?: string;
      reviewedBy?: string;
      source?: 'booking' | 'booking_request';
    }) => {
      let response;
      if (source === 'booking') {
        response = await fetch(`/api/bookings/${bookingId}/approve`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
      } else {
        response = await fetch(`/api/booking-requests/${bookingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            status: 'approved',
            resource_id: resourceId,
            staff_notes: staffNotes || null,
            reviewed_by: reviewedBy
          })
        });
      }
      
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || err.error || 'Failed to approve');
      }
      
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
      queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
      window.dispatchEvent(new CustomEvent('booking-action-completed'));
    },
  });
}

export function useDeclineBookingRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ bookingId, staffNotes, suggestedTime, reviewedBy, cancelledBy, source, newStatus }: { 
      bookingId: number | string;
      staffNotes?: string;
      suggestedTime?: string;
      reviewedBy?: string;
      cancelledBy?: string;
      source?: 'booking' | 'booking_request';
      newStatus?: 'declined' | 'cancelled';
    }) => {
      let response;
      if (source === 'booking') {
        response = await fetch(`/api/bookings/${bookingId}/decline`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
      } else {
        response = await fetch(`/api/booking-requests/${bookingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            status: newStatus || 'declined',
            staff_notes: staffNotes || null,
            suggested_time: suggestedTime ? suggestedTime + ':00' : null,
            reviewed_by: reviewedBy,
            cancelled_by: newStatus === 'cancelled' ? cancelledBy : undefined
          })
        });
      }
      
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to process request');
      }
      
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
      queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
      window.dispatchEvent(new CustomEvent('booking-action-completed'));
    },
  });
}
