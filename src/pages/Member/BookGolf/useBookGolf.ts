import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthData, useBookingData } from '../../../contexts/DataContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { usePageReady } from '../../../stores/pageReadyStore';
import { useToast } from '../../../components/Toast';
import { bookingEvents } from '../../../lib/bookingEvents';
import { fetchWithCredentials, postWithCredentials, putWithCredentials, ApiError } from '../../../hooks/queries/useFetch';
import { usePricing } from '../../../hooks/usePricing';
import { haptic } from '../../../utils/haptics';
import { playSound } from '../../../utils/sounds';
import { useTierPermissions } from '../../../hooks/useTierPermissions';
import { canAccessResource } from '../../../services/tierService';
import { formatTime12Hour } from '../../../utils/dateUtils';
import { useAutoAnimate } from '@formkit/auto-animate/react';
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
  generateDates,
  doesClosureAffectResource,
} from '../bookGolf/bookGolfTypes';
import type { GuardianConsentData } from '../../../components/booking';

export function useBookGolf() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user, viewAsUser, actualUser, isViewingAs } = useAuthData();
  const { addBooking } = useBookingData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const { showToast } = useToast();
  const { guestFeeDollars, overageRatePerBlockDollars } = usePricing();
  const isDark = effectiveTheme === 'dark';
  const activeTab: 'simulator' | 'conference' = searchParams.get('tab') === 'conference' ? 'conference' : 'simulator';

  const setActiveTab = (tab: 'simulator' | 'conference') => {
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      if (tab === 'simulator') { newParams.delete('tab'); } else { newParams.set('tab', tab); }
      return newParams;
    }, { replace: true });
  };

  const [playerCount, setPlayerCount] = useState<number>(1);
  const [duration, setDuration] = useState<number>(60);
  const [memberNotes, setMemberNotes] = useState<string>('');
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [resourcesRef] = useAutoAnimate();
  const [errorRef] = useAutoAnimate();
  const [playerSlotRef] = useAutoAnimate();
  const [feeRef] = useAutoAnimate();
  const [timeSlotsAnimRef] = useAutoAnimate();
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [_bookingError, setBookingError] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);
  const [showViewAsConfirm, setShowViewAsConfirm] = useState(false);
  const [expandedHour, setExpandedHour] = useState<string | null>(null);
  const [hasUserSelectedDuration, setHasUserSelectedDuration] = useState(false);
  const [playerSlots, setPlayerSlots] = useState<PlayerSlot[]>([]);
  const [cancelTargetBooking, setCancelTargetBooking] = useState<BookingRequest | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showGuardianConsent, setShowGuardianConsent] = useState(false);
  const [guardianConsentData, setGuardianConsentData] = useState<GuardianConsentData | null>(null);
  const [walletPassDownloading, setWalletPassDownloading] = useState<number | null>(null);
  const [conferencePaymentRequired, setConferencePaymentRequired] = useState(false);
  const [conferenceOverageFee, setConferenceOverageFee] = useState(0);
  const [showUnfilledSlotsWarning, setShowUnfilledSlotsWarning] = useState(false);
  const timeSlotsRef = useRef<HTMLDivElement>(null);
  const baySelectionRef = useRef<HTMLDivElement>(null);
  const requestButtonRef = useRef<HTMLDivElement>(null);
  const isFirstRenderRef = useRef(true);
  const isFirstTabRenderRef = useRef(true);
  const prevDateRef = useRef<string | null>(null);
  const prevDurationRef = useRef<number | null>(null);

  const effectiveUser = viewAsUser || user;

  const isMinor = useMemo(() => {
    const dob = effectiveUser?.dateOfBirth;
    if (!dob) return false;
    const birthDate = new Date(dob);
    if (isNaN(birthDate.getTime())) return false;
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
    return age < 18;
  }, [effectiveUser?.dateOfBirth]);

  const isAdminViewingAs = actualUser?.role === 'admin' && isViewingAs;
  const { permissions: tierPermissions, loading: tierLoading } = useTierPermissions(effectiveUser?.tier);
  const canBookSimulators = canAccessResource(tierPermissions, 'simulator');
  const canBookConference = canAccessResource(tierPermissions, 'conference');
  const isTierLoaded = Boolean(effectiveUser?.tier) && !tierLoading;

  const dates = useMemo(() => {
    const advanceDays = tierPermissions?.advanceBookingDays ?? 7;
    return generateDates(advanceDays);
  }, [tierPermissions?.advanceBookingDays]);

  const [selectedDateObj, setSelectedDateObj] = useState<{ label: string; date: string; day: string; dateNum: string } | null>(null);

  useEffect(() => {
    if (dates.length > 0 && (!selectedDateObj || !dates.find(d => d.date === selectedDateObj.date))) {
      setSelectedDateObj(dates[0]);
    }
  }, [dates, selectedDateObj]);

  useEffect(() => {
    if (isFirstTabRenderRef.current) { isFirstTabRenderRef.current = false; return; }
    setSelectedDateObj(dates.length > 0 ? dates[0] : null);
    setDuration(60);
    setPlayerCount(1);
    setSelectedSlot(null);
    setSelectedResource(null);
    setHasUserSelectedDuration(false);
  }, [activeTab]);

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

  const estimatedFees = useMemo(() => {
    if (!feeEstimateData) {
      return {
        overageFee: 0, guestFees: 0, totalFee: 0, guestCount: 0, overageMinutes: 0,
        guestsUsingPasses: 0, guestsCharged: 0, passesRemainingAfter: guestPassInfo?.passes_remaining ?? 0,
        isLoading: feeEstimateLoading, guestFeePerUnit: guestFeeDollars, overageRatePerBlock: overageRatePerBlockDollars
      };
    }
    return {
      overageFee: feeEstimateData.feeBreakdown.overageFee, guestFees: feeEstimateData.feeBreakdown.guestFees,
      totalFee: feeEstimateData.totalFee, guestCount: feeEstimateData.feeBreakdown.guestCount,
      overageMinutes: feeEstimateData.feeBreakdown.overageMinutes,
      guestsUsingPasses: feeEstimateData.feeBreakdown.guestsUsingPasses,
      guestsCharged: feeEstimateData.feeBreakdown.guestsCharged,
      passesRemainingAfter: Math.max(0, feeEstimateData.feeBreakdown.guestPassesRemaining - feeEstimateData.feeBreakdown.guestsUsingPasses),
      isLoading: feeEstimateLoading,
      guestFeePerUnit: feeEstimateData.feeBreakdown.guestFeePerUnit || guestFeeDollars,
      overageRatePerBlock: feeEstimateData.feeBreakdown.overageRatePerBlock || overageRatePerBlockDollars
    };
  }, [feeEstimateData, feeEstimateLoading, guestPassInfo?.passes_remaining, guestFeeDollars, overageRatePerBlockDollars]);

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

  const isLoading = resourcesLoading || availabilityLoading;
  const error = resourcesError ? (resourcesError instanceof Error ? resourcesError.message : String(resourcesError)) : null;

  useEffect(() => {
    const currentDate = selectedDateObj?.date ?? null;
    if (isFirstRenderRef.current) { isFirstRenderRef.current = false; prevDateRef.current = currentDate; prevDurationRef.current = duration; return; }
    const dateChanged = currentDate !== prevDateRef.current;
    const durationChanged = duration !== prevDurationRef.current;
    if (dateChanged || durationChanged) { setSelectedSlot(null); setSelectedResource(null); }
    prevDateRef.current = currentDate;
    prevDurationRef.current = duration;
  }, [selectedDateObj, duration]);

  useEffect(() => {
    if (activeTab !== 'simulator') return;
    const getValidDurations = (players: number): number[] => {
      switch (players) {
        case 1: return [30, 60, 90, 120, 150, 180, 210, 240];
        case 2: return [60, 120, 180, 240];
        case 3: return [90, 120, 150, 180, 270];
        case 4: return [120, 180, 240];
        default: return [60, 120, 180, 240];
      }
    };
    const validDurations = getValidDurations(playerCount);
    if (!validDurations.includes(duration)) setDuration(validDurations[0]);
  }, [playerCount, activeTab, duration]);

  useEffect(() => { if (!isLoading) setPageReady(true); }, [isLoading, setPageReady]);

  useEffect(() => {
    const handleBookingUpdate = () => {
      queryClient.invalidateQueries({ queryKey: bookGolfKeys.myRequests(effectiveUser?.email || '') });
      queryClient.invalidateQueries({ queryKey: ['bookGolf', 'availability'] });
      if (selectedDateObj?.date && activeTab === 'simulator') {
        queryClient.invalidateQueries({ queryKey: bookGolfKeys.existingBookings(selectedDateObj.date, activeTab) });
      }
    };
    const handleAvailabilityUpdate = () => { queryClient.invalidateQueries({ queryKey: ['bookGolf', 'availability'] }); };
    window.addEventListener('booking-update', handleBookingUpdate);
    window.addEventListener('availability-update', handleAvailabilityUpdate);
    return () => { window.removeEventListener('booking-update', handleBookingUpdate); window.removeEventListener('availability-update', handleAvailabilityUpdate); };
  }, [queryClient, effectiveUser?.email, selectedDateObj?.date, activeTab]);

  useEffect(() => {
    const slotsNeeded = Math.max(0, playerCount - 1);
    setPlayerSlots(prev => {
      if (prev.length === slotsNeeded) return prev;
      if (prev.length < slotsNeeded) {
        const additional: PlayerSlot[] = [];
        for (let i = prev.length; i < slotsNeeded; i++) {
          additional.push({ id: crypto.randomUUID(), email: '', name: '', firstName: '', lastName: '', type: 'guest', searchQuery: '' });
        }
        return [...prev, ...additional];
      }
      return prev.slice(0, slotsNeeded);
    });
  }, [playerCount]);

  useEffect(() => { setConferencePaymentRequired(false); setConferenceOverageFee(0); }, [selectedSlot, selectedResource, selectedDateObj, duration]);

  useEffect(() => {
    if (activeTab !== 'conference' || !selectedSlot || !selectedResource || !selectedDateObj || !effectiveUser?.email) return;
    const fetchPrepaymentEstimate = async () => {
      try {
        const response = await postWithCredentials<{ totalCents: number; overageMinutes: number; dailyAllowance: number; usedToday: number; paymentRequired: boolean }>('/api/member/conference/prepay/estimate', {
          memberEmail: effectiveUser.email, date: selectedDateObj.date, startTime: selectedSlot.startTime24, durationMinutes: duration
        });
        if (response.paymentRequired) { setConferencePaymentRequired(true); setConferenceOverageFee(response.totalCents); }
        else { setConferencePaymentRequired(false); setConferenceOverageFee(0); }
      } catch (err: unknown) { console.error('[BookGolf] Failed to fetch prepayment estimate:', err); setConferencePaymentRequired(false); setConferenceOverageFee(0); }
    };
    fetchPrepaymentEstimate();
  }, [activeTab, selectedSlot, selectedResource, selectedDateObj, duration, effectiveUser?.email]);

  useEffect(() => {
    if (hasUserSelectedDuration && duration && timeSlotsRef.current) {
      setTimeout(() => { timeSlotsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
    }
  }, [hasUserSelectedDuration, duration, activeTab]);

  useEffect(() => {
    if (selectedSlot && !selectedResource && baySelectionRef.current) {
      setTimeout(() => { baySelectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 150);
    }
  }, [selectedSlot, selectedResource]);

  useEffect(() => {
    if (selectedSlot && selectedResource && requestButtonRef.current) {
      setTimeout(() => { requestButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150);
    }
  }, [selectedSlot, selectedResource]);

  useEffect(() => {
    if (cancelTargetBooking && !myRequests.find(r => r.id === cancelTargetBooking.id && (r.status === 'approved' || r.status === 'pending'))) {
      setCancelTargetBooking(null);
    }
  }, [myRequests, cancelTargetBooking]);

  const memberBayBookingsForDay = useMemo(() => {
    if (!selectedDateObj?.date || !myRequests.length) return [];
    return myRequests.filter(r =>
      r.request_date === selectedDateObj.date &&
      (r.status === 'approved' || r.status === 'pending' || r.status === 'cancellation_pending') &&
      !r.notes?.includes('Conference room booking')
    );
  }, [selectedDateObj, myRequests]);

  const { usedMinutesForDay, remainingMinutes: _remainingMinutes, isAtDailyLimit } = useMemo(() => {
    if (!selectedDateObj?.date || !myRequests.length) {
      const dailyLimit = activeTab === 'simulator' ? tierPermissions.dailySimulatorMinutes : tierPermissions.dailyConfRoomMinutes;
      return { usedMinutesForDay: 0, remainingMinutes: dailyLimit || 60, isAtDailyLimit: false };
    }
    const isSimulator = activeTab === 'simulator';
    const dailyLimit = isSimulator ? tierPermissions.dailySimulatorMinutes : tierPermissions.dailyConfRoomMinutes;
    if (tierPermissions.unlimitedAccess || dailyLimit >= 999) return { usedMinutesForDay: 0, remainingMinutes: 999, isAtDailyLimit: false };
    const bookingsForDate = myRequests.filter(r => {
      if (r.request_date !== selectedDateObj.date) return false;
      if (!['approved', 'pending', 'confirmed', 'attended'].includes(r.status)) return false;
      const bayNameLower = r.bay_name?.toLowerCase() ?? '';
      const isConferenceBooking = r.notes?.includes('Conference room booking') || bayNameLower.includes('conference');
      if (isSimulator && isConferenceBooking) return false;
      if (!isSimulator && !isConferenceBooking) return false;
      return true;
    });
    const usedMinutes = bookingsForDate.reduce((sum, booking) => {
      const start = booking.start_time?.split(':').map(Number) || [0, 0];
      const end = booking.end_time?.split(':').map(Number) || [0, 0];
      const totalMinutes = (end[0] * 60 + end[1]) - (start[0] * 60 + start[1]);
      const pc = Number(booking.total_player_count) || 1;
      return sum + Math.ceil(totalMinutes / pc);
    }, 0);
    const remaining = Math.max(0, dailyLimit - usedMinutes);
    return { usedMinutesForDay: usedMinutes, remainingMinutes: remaining, isAtDailyLimit: false };
  }, [selectedDateObj?.date, myRequests, activeTab, tierPermissions]);

  const doTimesOverlap = (start1: string, end1: string, start2: string, end2: string): boolean => {
    const toMinutes = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    return toMinutes(start1) < toMinutes(end2) && toMinutes(start2) < toMinutes(end1);
  };

  const filteredSlotsForConference = useMemo(() => {
    if (activeTab !== 'conference' || memberBayBookingsForDay.length === 0) return availableSlots;
    return availableSlots.filter(slot =>
      !memberBayBookingsForDay.some(booking => doTimesOverlap(slot.startTime24, slot.endTime24, booking.start_time, booking.end_time))
    );
  }, [activeTab, memberBayBookingsForDay, availableSlots]);

  const handleCancelRequest = async (id: number) => {
    haptic.light();
    const request = myRequests.find(r => r.id === id);
    const wasApproved = request?.status === 'approved';
    try {
      const result = await cancelBookingMutation.mutateAsync({ bookingId: id, actingAsEmail: isAdminViewingAs ? effectiveUser?.email : undefined });
      haptic.success(); playSound('success');
      if (result.status === 'cancellation_pending') showToast('Cancellation request submitted. You\'ll be notified when it\'s complete.', 'success');
      else showToast(wasApproved ? 'Booking cancelled successfully' : 'Request cancelled', 'success');
    } catch (err: unknown) {
      console.error('[BookGolf] Failed to cancel request:', err);
      haptic.error(); showToast(err instanceof Error ? err.message : 'Failed to cancel booking', 'error');
    }
  };

  const getAvailableResourcesForSlot = (slot: TimeSlot): Resource[] => resources.filter(r => slot.availableResourceDbIds.includes(r.dbId));

  const submitBooking = async (consentData?: GuardianConsentData) => {
    if (!selectedSlot || !selectedResource || !effectiveUser || !selectedDateObj) return;
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBookingError(null); setShowViewAsConfirm(false);
    const consent = consentData || guardianConsentData;
    try {
      const invalidGuestSlot = playerSlots.find(slot => slot.type === 'guest' && !slot.selectedId && slot.email && !slot.email.includes('@'));
      if (invalidGuestSlot) { setBookingError('Please enter a valid email address for each guest.'); haptic.error(); return; }
      const freshAvailability = await postWithCredentials<Record<number, { slots: APISlot[] }>>('/api/availability/batch', {
        resource_ids: [selectedResource.dbId], date: selectedDateObj.date, duration, user_email: effectiveUser.email
      });
      const resourceSlots = freshAvailability[selectedResource.dbId]?.slots || [];
      const slotStillAvailable = resourceSlots.some(
        s => s.start_time === selectedSlot.startTime24 && s.available
      );
      if (!slotStillAvailable) {
        queryClient.invalidateQueries({ queryKey: bookGolfKeys.all });
        setBookingError('This time slot is no longer available. The availability grid has been refreshed.');
        haptic.error();
        return;
      }

      const requestParticipants = activeTab === 'simulator' && playerSlots.length > 0
        ? playerSlots.filter(slot => slot.selectedId || (slot.email && slot.email.includes('@'))).map(slot => {
            const hasValidEmail = slot.email && slot.email.includes('@') && !slot.email.includes('*');
            return { email: hasValidEmail ? slot.email : undefined, type: slot.type, userId: slot.selectedId, name: slot.selectedId ? slot.selectedName : (slot.name || slot.selectedName) };
          })
        : undefined;
      const bookingResult = await createBookingMutation.mutateAsync({
        user_email: effectiveUser.email, user_name: effectiveUser.name, user_tier: effectiveUser.tier,
        resource_id: selectedResource.dbId, request_date: selectedDateObj.date, start_time: selectedSlot.startTime24,
        duration_minutes: duration, notes: activeTab === 'conference' ? 'Conference room booking' : null,
        declared_player_count: activeTab === 'simulator' ? playerCount : undefined,
        member_notes: memberNotes.trim() || undefined, request_participants: requestParticipants,
        ...(consent ? { guardian_name: consent.guardianName, guardian_relationship: consent.guardianRelationship, guardian_phone: consent.guardianPhone, guardian_consent: consent.acknowledged } : {})
      });
      addBooking({ id: Date.now().toString(), type: 'golf', title: selectedResource.name, date: selectedDateObj.label, time: selectedSlot.start, details: `${duration} min`, color: 'primary' });
      bookingEvents.emit(); haptic.success(); playSound('bookingConfirmed');
      if (activeTab === 'conference' && bookingResult.invoicePayment) {
        showToast(bookingResult.invoicePayment.paidInFull ? 'Conference room booked and paid!' : 'Conference room booked! Overage fee will be collected at check-in.', 'success', 4000);
      } else if (activeTab === 'conference' && bookingResult.status === 'pending') {
        showToast('Conference room request submitted! Staff will confirm shortly.', 'success', 4000);
      } else if (activeTab === 'conference') {
        showToast('Conference room booked!', 'success', 4000);
      } else { showToast('Booking request sent! Staff will review shortly.', 'success', 4000); }
      setShowConfirmation(true);
      setTimeout(() => { setShowConfirmation(false); setSelectedSlot(null); setSelectedResource(null); }, 2500);
    } catch (err: unknown) {
      haptic.error();
      const errorMessage = (err instanceof Error ? err.message : String(err)) || 'Booking failed. Please try again.';
      if ((err instanceof ApiError && err.status === 402) || errorMessage.toLowerCase().includes('payment')) {
        setBookingError('Please contact the front desk to complete your booking.');
      } else { showToast(errorMessage, 'error'); setBookingError(errorMessage); }
    } finally { isSubmittingRef.current = false; }
  };

  const isBooking = createBookingMutation.isPending;

  const handleConfirm = async () => {
    if (!selectedSlot || !selectedResource || !effectiveUser || !selectedDateObj) return;
    if (isSubmittingRef.current || isBooking) return;
    if (isAdminViewingAs) { setShowViewAsConfirm(true); return; }
    if (activeTab === 'simulator' && isMinor && !guardianConsentData) { setShowGuardianConsent(true); return; }
    if (activeTab === 'simulator' && playerCount > 1) {
      const filledSlots = playerSlots.filter(slot => slot.selectedId || (slot.email && slot.email.includes('@'))).length;
      if (filledSlots < playerCount - 1) { setShowUnfilledSlotsWarning(true); return; }
    }
    await submitBooking();
  };

  const handleGuardianConsentSubmit = (data: GuardianConsentData) => {
    setGuardianConsentData(data); setShowGuardianConsent(false); submitBooking(data);
  };

  const canBook = Boolean(selectedDateObj && duration && selectedSlot && selectedResource && !isBooking && (activeTab !== 'simulator' || !isAtDailyLimit));

  const activeClosures = useMemo(() => {
    if (!selectedDateObj?.date) return [];
    return closures.filter(closure => {
      const selectedDate = selectedDateObj.date;
      if (selectedDate < closure.startDate || selectedDate > closure.endDate) return false;
      return doesClosureAffectResource(closure.affectedAreas, activeTab === 'conference' ? 'conference' : 'simulator');
    });
  }, [closures, selectedDateObj, activeTab]);

  const slotsToDisplay = activeTab === 'conference' ? filteredSlotsForConference : availableSlots;

  const slotsByHour = useMemo(() => {
    const grouped: Record<string, { hourLabel: string; hour24: string; slots: TimeSlot[]; totalAvailable: number }> = {};
    slotsToDisplay.forEach(slot => {
      const hour24 = slot.startTime24.split(':')[0];
      const hourNum = parseInt(hour24, 10);
      const period = hourNum >= 12 ? 'PM' : 'AM';
      const hour12 = hourNum === 0 ? 12 : hourNum > 12 ? hourNum - 12 : hourNum;
      const hourLabel = `${hour12}:00 ${period}`;
      if (!grouped[hour24]) grouped[hour24] = { hourLabel, hour24, slots: [], totalAvailable: 0 };
      grouped[hour24].slots.push(slot);
      grouped[hour24].totalAvailable = Math.max(grouped[hour24].totalAvailable, slot.availableResourceDbIds.length);
    });
    return Object.values(grouped).sort((a, b) => a.hour24.localeCompare(b.hour24));
  }, [slotsToDisplay]);

  return {
    activeTab, setActiveTab, playerCount, setPlayerCount, duration, setDuration,
    memberNotes, setMemberNotes, selectedSlot, setSelectedSlot, selectedResource, setSelectedResource,
    showConfirmation, showViewAsConfirm, setShowViewAsConfirm,
    expandedHour, setExpandedHour, hasUserSelectedDuration, setHasUserSelectedDuration,
    playerSlots, setPlayerSlots, cancelTargetBooking, setCancelTargetBooking,
    showCancelConfirm, setShowCancelConfirm, showGuardianConsent, setShowGuardianConsent,
    guardianConsentData, walletPassDownloading, setWalletPassDownloading,
    conferencePaymentRequired, conferenceOverageFee,
    showUnfilledSlotsWarning, setShowUnfilledSlotsWarning,
    selectedDateObj, setSelectedDateObj,
    effectiveUser, isMinor, isAdminViewingAs, viewAsUser,
    tierPermissions, isTierLoaded, canBookSimulators, canBookConference,
    dates, resources, guestPassInfo, myRequests, closures, walletPassAvailable,
    estimatedFees, isLoading, error, isBooking, isDark,
    memberBayBookingsForDay, usedMinutesForDay, isAtDailyLimit,
    slotsByHour, activeClosures, canBook, availableSlots,
    handleCancelRequest, handleConfirm, handleGuardianConsentSubmit, submitBooking, getAvailableResourcesForSlot,
    guestFeeDollars, overageRatePerBlockDollars, cancelBookingMutation,
    resourcesRef, errorRef, playerSlotRef, feeRef, timeSlotsAnimRef,
    timeSlotsRef, baySelectionRef, requestButtonRef,
    showToast,
  };
}
