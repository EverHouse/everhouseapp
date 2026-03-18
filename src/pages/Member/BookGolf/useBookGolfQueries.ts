import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials, putWithCredentials } from '../../../hooks/queries/useFetch';
import { formatTime12Hour } from '../../../utils/dateUtils';
import {
  type APIResource,
  type APISlot,
  type TimeSlot,
  type Resource,
  type BookingRequest,
  type Closure,
  type GuestPassInfo,
  type FeeEstimateResponse,
  type PlayerSlot,
  bookGolfKeys,
} from '../bookGolf/bookGolfTypes';

export function useBookGolfQueries(
  activeTab: 'simulator' | 'conference',
  selectedDateObj: { date: string } | null,
  duration: number,
  effectiveUser: { email: string; tier: string; id?: string } | null,
  playerCount: number,
  playerSlots: PlayerSlot[],
  isAdminViewingAs: boolean,
  selectedResource: Resource | null,
) {
  const queryClient = useQueryClient();

  const resourceType = activeTab === 'simulator' ? 'simulator' : 'conference_room';
  const { data: resources = [], isLoading: resourcesLoading, error: resourcesError } = useQuery({
    queryKey: bookGolfKeys.resources(resourceType),
    queryFn: async () => {
      const data = await fetchWithCredentials<APIResource[]>('/api/resources');
      const typeMap: Record<string, string> = { simulator: 'simulator', conference: 'conference_room' };
      return data
        .filter(r => r.type === typeMap[activeTab])
        .map(r => ({
          id: `resource-${r.id}`, dbId: r.id, name: r.name,
          meta: r.description || `Capacity: ${r.capacity}`,
          badge: r.type === 'simulator' ? 'Indoor' : undefined,
          icon: r.type === 'simulator' ? 'golf_course' : r.type === 'conference_room' ? 'meeting_room' : 'person'
        }));
    },
    staleTime: 1000 * 60 * 5,
  });

  const resourceIds = resources.map(r => r.dbId);
  const { data: availableSlots = [], isLoading: availabilityLoading } = useQuery({
    queryKey: bookGolfKeys.availability(resourceIds, selectedDateObj?.date || '', duration, undefined, effectiveUser?.email),
    staleTime: 1000 * 30,
    queryFn: async () => {
      if (!selectedDateObj?.date || resourceIds.length === 0) return [];
      const batchResult = await postWithCredentials<Record<number, { slots: APISlot[] }>>('/api/availability/batch', {
        resource_ids: resourceIds, date: selectedDateObj.date, duration, user_email: effectiveUser?.email
      });
      const allSlots: Map<string, { slot: TimeSlot; resourceIds: number[]; requestedIds: number[] }> = new Map();
      resources.forEach(resource => {
        const resourceData = batchResult[resource.dbId];
        if (!resourceData?.slots) return;
        resourceData.slots.forEach(slot => {
          if (!slot.available && !slot.requested) return;
          const key = slot.start_time;
          if (allSlots.has(key)) {
            const entry = allSlots.get(key)!;
            if (slot.available) entry.resourceIds.push(resource.dbId);
            else if (slot.requested) entry.requestedIds.push(resource.dbId);
          } else {
            allSlots.set(key, {
              slot: {
                id: `slot-${slot.start_time}`, start: formatTime12Hour(slot.start_time), end: formatTime12Hour(slot.end_time),
                startTime24: slot.start_time, endTime24: slot.end_time,
                label: `${formatTime12Hour(slot.start_time)} – ${formatTime12Hour(slot.end_time)}`,
                available: slot.available, availableResourceDbIds: [], requestedResourceDbIds: []
              },
              resourceIds: slot.available ? [resource.dbId] : [],
              requestedIds: slot.requested ? [resource.dbId] : []
            });
          }
        });
      });
      return Array.from(allSlots.values())
        .filter(({ resourceIds: resIds, requestedIds }) => resIds.length > 0 || requestedIds.length > 0)
        .map(({ slot, resourceIds: resIds, requestedIds }) => ({
          ...slot, available: resIds.length > 0, availableResourceDbIds: resIds, requestedResourceDbIds: requestedIds
        }))
        .sort((a, b) => a.startTime24.localeCompare(b.startTime24));
    },
    enabled: !!selectedDateObj?.date && resourceIds.length > 0,
  });

  const { data: guestPassInfo } = useQuery({
    queryKey: bookGolfKeys.guestPasses(effectiveUser?.email || '', effectiveUser?.tier || ''),
    queryFn: () => fetchWithCredentials<GuestPassInfo>(`/api/guest-passes/${encodeURIComponent(effectiveUser!.email!)}?tier=${encodeURIComponent(effectiveUser!.tier!)}`),
    enabled: !!effectiveUser?.email && !!effectiveUser?.tier,
  });

  const { data: myRequests = [] } = useQuery({
    queryKey: bookGolfKeys.myRequests(effectiveUser?.email || ''),
    queryFn: () => fetchWithCredentials<BookingRequest[]>(`/api/booking-requests?user_email=${encodeURIComponent(effectiveUser!.email!)}`),
    enabled: !!effectiveUser?.email,
  });

  const { data: closures = [] } = useQuery({
    queryKey: bookGolfKeys.closures(),
    queryFn: () => fetchWithCredentials<Closure[]>('/api/closures'),
    staleTime: 1000 * 60 * 5,
  });

  const { data: walletPassStatus } = useQuery({
    queryKey: ['walletPassStatus'],
    queryFn: () => fetchWithCredentials<{ available: boolean }>('/api/member/wallet-pass/status'),
    staleTime: 1000 * 60 * 10,
  });
  const walletPassAvailable = walletPassStatus?.available ?? false;

  const guestCount = activeTab === 'simulator' ? playerSlots.filter(slot => slot.type === 'guest').length : 0;
  const effectivePlayerCount = activeTab === 'simulator' ? playerCount : 1;
  const guestsWithInfo = activeTab === 'simulator'
    ? playerSlots.filter(slot => slot.type === 'guest' && (slot.selectedId || (slot.firstName?.trim() && slot.lastName?.trim() && slot.email && slot.email.includes('@')))).length
    : 0;
  const memberUserIds = useMemo(() => activeTab === 'simulator'
    ? playerSlots.filter(slot => slot.type === 'member' && slot.selectedId).map(slot => slot.selectedId!)
    : [], [activeTab, playerSlots]);
  const memberEmails = useMemo(() => activeTab === 'simulator'
    ? playerSlots.filter(slot => slot.type === 'member' && slot.email).map(slot => slot.email!)
    : [], [activeTab, playerSlots]);

  const feeEstimateParams = useMemo(() => {
    if (!duration || !selectedDateObj?.date) return '';
    const params = new URLSearchParams({
      durationMinutes: duration.toString(), guestCount: guestCount.toString(),
      playerCount: effectivePlayerCount.toString(), date: selectedDateObj.date,
      resourceType: activeTab === 'conference' ? 'conference_room' : 'simulator',
      guestsWithInfo: guestsWithInfo.toString()
    });
    if (memberUserIds.length > 0) params.set('memberUserIds', memberUserIds.join(','));
    if (memberEmails.length > 0) params.set('memberEmails', memberEmails.join(','));
    if (effectiveUser?.email && isAdminViewingAs) params.set('email', effectiveUser.email);
    return params.toString();
  }, [duration, guestCount, guestsWithInfo, effectivePlayerCount, selectedDateObj?.date, activeTab, effectiveUser?.email, isAdminViewingAs, memberUserIds, memberEmails]);

  const { data: feeEstimateData, isLoading: feeEstimateLoading } = useQuery({
    queryKey: bookGolfKeys.feeEstimate(feeEstimateParams),
    queryFn: () => fetchWithCredentials<FeeEstimateResponse>(`/api/fee-estimate?${feeEstimateParams}`),
    enabled: !!feeEstimateParams && activeTab === 'conference',
    staleTime: 1000 * 60,
  });

  const createBookingMutation = useMutation({
    mutationFn: async (bookingData: {
      user_email: string; user_name: string; user_tier: string; resource_id: number;
      request_date: string; start_time: string; duration_minutes: number; notes: string | null;
      declared_player_count?: number; member_notes?: string;
      request_participants?: Array<{ email?: string; type: string; userId?: string; name?: string }>;
      guardian_name?: string; guardian_relationship?: string; guardian_phone?: string; guardian_consent?: boolean;
    }) => postWithCredentials<{ id: number; status: string; invoicePayment?: { paidInFull: boolean; status: string; clientSecret: string | null; amountFromBalance: number } }>('/api/booking-requests', bookingData),
    onMutate: async (bookingData) => {
      await queryClient.cancelQueries({ queryKey: bookGolfKeys.all });
      const bookingRequestsKey = ['member', 'dashboard', effectiveUser?.email, 'booking-requests'];
      await queryClient.cancelQueries({ queryKey: bookingRequestsKey });
      const previousBookingRequests = queryClient.getQueryData(bookingRequestsKey);
      const startTimeParts = bookingData.start_time.split(':').map(Number);
      const endTotalMinutes = (startTimeParts[0] * 60 + startTimeParts[1]) + bookingData.duration_minutes;
      const endH = Math.floor(endTotalMinutes / 60) % 24;
      const endM = endTotalMinutes % 60;
      const endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
      const optimisticRequest = {
        id: -Date.now(), user_email: bookingData.user_email, user_name: bookingData.user_name,
        resource_id: bookingData.resource_id, resource_name: selectedResource?.name || 'Simulator',
        bay_name: selectedResource?.name || null, resource_preference: null,
        request_date: bookingData.request_date, start_time: bookingData.start_time, end_time: endTime,
        duration_minutes: bookingData.duration_minutes, notes: bookingData.notes,
        status: 'pending' as const, staff_notes: null, suggested_time: null,
        created_at: new Date().toISOString(), declared_player_count: bookingData.declared_player_count,
      };
      queryClient.setQueryData(bookingRequestsKey, (old: unknown[] | undefined) => old ? [...old, optimisticRequest] : [optimisticRequest]);
      return { previousBookingRequests, bookingRequestsKey };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousBookingRequests && context?.bookingRequestsKey) {
        queryClient.setQueryData(context.bookingRequestsKey, context.previousBookingRequests);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: bookGolfKeys.all });
      queryClient.invalidateQueries({ queryKey: ['member', 'dashboard'] });
    },
  });

  const cancelBookingMutation = useMutation<{ success: boolean; status?: string }, Error, { bookingId: number; actingAsEmail?: string }, { previousData?: [readonly unknown[], unknown][] }>({
    mutationFn: async ({ bookingId, actingAsEmail }) =>
      putWithCredentials<{ success: boolean; status?: string }>(`/api/bookings/${bookingId}/member-cancel`, { acting_as_email: actingAsEmail }),
    onMutate: async ({ bookingId }) => {
      await queryClient.cancelQueries({ queryKey: bookGolfKeys.all });
      const previousData = queryClient.getQueriesData({ queryKey: bookGolfKeys.all });
      queryClient.setQueriesData({ queryKey: bookGolfKeys.all }, (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return old.map((b: Record<string, unknown>) => b.id === bookingId ? { ...b, status: 'cancelled' } : b);
      });
      return { previousData };
    },
    onError: (_err, _vars, context) => {
      context?.previousData?.forEach(([key, data]) => queryClient.setQueryData(key as string[], data));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: bookGolfKeys.all });
      queryClient.invalidateQueries({ queryKey: ['member', 'dashboard'] });
    },
  });

  return {
    queryClient, resources, resourcesLoading, resourcesError, resourceIds,
    availableSlots, availabilityLoading, guestPassInfo, myRequests, closures,
    walletPassAvailable, feeEstimateData, feeEstimateLoading,
    createBookingMutation, cancelBookingMutation,
  };
}
