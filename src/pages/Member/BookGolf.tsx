import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useData } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useToast } from '../../components/Toast';
import { bookingEvents } from '../../lib/bookingEvents';
import { fetchWithCredentials, postWithCredentials, putWithCredentials } from '../../hooks/queries/useFetch';
import DateButton from '../../components/DateButton';
import TabButton from '../../components/TabButton';
import SwipeablePage from '../../components/SwipeablePage';
import PullToRefresh from '../../components/PullToRefresh';
import { haptic } from '../../utils/haptics';
import { playSound } from '../../utils/sounds';
import { useTierPermissions } from '../../hooks/useTierPermissions';
import { canAccessResource } from '../../services/tierService';
import { getDateString, formatDateShort, getPacificDateParts, formatTime12Hour } from '../../utils/dateUtils';
import { getStatusColor } from '../../utils/statusColors';
import WalkingGolferSpinner from '../../components/WalkingGolferSpinner';
import ModalShell from '../../components/ModalShell';
import { BookGolfSkeleton } from '../../components/skeletons';
import { GuardianConsentForm, type GuardianConsentData } from '../../components/booking';
import { AnimatedPage } from '../../components/motion';


interface APIResource {
  id: number;
  name: string;
  type: string;
  description: string;
  capacity: number;
}

interface APISlot {
  start_time: string;
  end_time: string;
  available: boolean;
}

interface TimeSlot {
  id: string;
  start: string;
  end: string;
  startTime24: string;
  endTime24: string;
  label: string;
  available: boolean;
  availableResourceDbIds: number[];
}

interface Resource {
  id: string;
  dbId: number;
  name: string;
  meta: string;
  badge?: string;
  icon?: string;
  image?: string;
}

interface BookingRequest {
  id: number;
  user_email: string;
  user_name: string;
  resource_id: number | null;
  bay_name: string | null;
  resource_preference: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  notes: string | null;
  status: 'pending' | 'approved' | 'confirmed' | 'attended' | 'no_show' | 'declined' | 'cancelled';
  staff_notes: string | null;
  suggested_time: string | null;
  created_at: string;
  reschedule_booking_id?: number | null;
}

interface Closure {
  id: number;
  title: string | null;
  reason: string | null;
  noticeType: string | null;
  startDate: string;
  startTime: string | null;
  endDate: string;
  endTime: string | null;
  affectedAreas: string;
  isActive: boolean;
}

interface GuestPassInfo {
  passes_used: number;
  passes_total: number;
  passes_remaining: number;
  passes_pending?: number;
  passes_remaining_conservative?: number;
}

interface ExistingBookingCheck {
  hasExisting: boolean;
  bookings: Array<{ id: number; resourceName: string; startTime: string; endTime: string; status: string; isStaffCreated: boolean }>;
  staffCreated: boolean;
}

interface FeeEstimateResponse {
  totalFee: number;
  feeBreakdown: {
    overageFee: number;
    guestFees: number;
    guestCount: number;
    overageMinutes: number;
    guestsUsingPasses: number;
    guestsCharged: number;
    guestPassesRemaining: number;
  };
}

const bookGolfKeys = {
  all: ['bookGolf'] as const,
  resources: (type: string) => [...bookGolfKeys.all, 'resources', type] as const,
  availability: (resourceIds: number[], date: string, duration: number, ignoreId?: number) => 
    [...bookGolfKeys.all, 'availability', resourceIds, date, duration, ignoreId] as const,
  guestPasses: (email: string, tier: string) => [...bookGolfKeys.all, 'guestPasses', email, tier] as const,
  myRequests: (email: string) => [...bookGolfKeys.all, 'myRequests', email] as const,
  closures: () => [...bookGolfKeys.all, 'closures'] as const,
  existingBookings: (date: string, resourceType: string) => [...bookGolfKeys.all, 'existingBookings', date, resourceType] as const,
  feeEstimate: (params: string) => [...bookGolfKeys.all, 'feeEstimate', params] as const,
};

const generateDates = (advanceDays: number = 7): { label: string; date: string; day: string; dateNum: string }[] => {
  const dates = [];
  const { year, month, day } = getPacificDateParts();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  // Show today + advanceDays (today doesn't count toward the advance booking window)
  for (let i = 0; i <= advanceDays; i++) {
    const d = new Date(year, month - 1, day + i);
    const dayName = days[d.getDay()];
    const dateNum = d.getDate().toString();
    dates.push({
      label: `${dayName} ${dateNum}`,
      date: getDateString(d),
      day: dayName,
      dateNum: dateNum
    });
  }
  return dates;
};

const doesClosureAffectResource = (affectedAreas: string, resourceType: 'simulator' | 'conference'): boolean => {
  if (!affectedAreas) return false;
  
  const normalized = affectedAreas.toLowerCase().trim();
  if (normalized === 'entire_facility') return true;
  
  let parts: string[];
  if (normalized.startsWith('[')) {
    try {
      parts = JSON.parse(affectedAreas).map((p: string) => p.toLowerCase().trim());
    } catch {
      parts = [normalized];
    }
  } else {
    parts = normalized.split(',').map(p => p.trim());
  }
  
  if (resourceType === 'simulator') {
    return parts.some(part => 
      part === 'all_bays' || 
      part.startsWith('bay_') || 
      part.startsWith('bay ') ||
      /^bay\s*\d+$/.test(part)
    );
  } else if (resourceType === 'conference') {
    return parts.some(part => 
      part === 'conference_room' || 
      part === 'conference room'
    );
  }
  
  return false;
};

const BookGolf: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { addBooking, user, viewAsUser, actualUser, isViewingAs } = useData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const { showToast } = useToast();
  const isDark = effectiveTheme === 'dark';
  const activeTab: 'simulator' | 'conference' = searchParams.get('tab') === 'conference' ? 'conference' : 'simulator';
  
  const setActiveTab = (tab: 'simulator' | 'conference') => {
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      if (tab === 'simulator') {
        newParams.delete('tab');
      } else {
        newParams.set('tab', tab);
      }
      return newParams;
    }, { replace: true });
  };
  const [playerCount, setPlayerCount] = useState<number>(1);
  const [duration, setDuration] = useState<number>(60);
  const [memberNotes, setMemberNotes] = useState<string>('');
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);
  const [showViewAsConfirm, setShowViewAsConfirm] = useState(false);
  const [expandedHour, setExpandedHour] = useState<string | null>(null);
  const [hasUserSelectedDuration, setHasUserSelectedDuration] = useState(false);
  const [showPlayerTooltip, setShowPlayerTooltip] = useState(false);
  const [playerSlots, setPlayerSlots] = useState<Array<{
    email: string;
    type: 'member' | 'guest';
    searchQuery: string;
    selectedId?: string;
    selectedName?: string;
  }>>([]);
  const [playerSearchResults, setPlayerSearchResults] = useState<Record<number, Array<{
    id: string;
    name: string;
    emailRedacted: string;
    visitorType?: string;
  }>>>({});
  const [activeSearchIndex, setActiveSearchIndex] = useState<number | null>(null);
  const searchTimeoutRef = useRef<Record<number, NodeJS.Timeout>>({});
  
  const [rescheduleBookingId, setRescheduleBookingId] = useState<number | null>(null);
  const [originalBooking, setOriginalBooking] = useState<BookingRequest | null>(null);
  const [existingDayBooking, setExistingDayBooking] = useState<BookingRequest | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showGuardianConsent, setShowGuardianConsent] = useState(false);
  const [guardianConsentData, setGuardianConsentData] = useState<GuardianConsentData | null>(null);
  
  const timeSlotsRef = useRef<HTMLDivElement>(null);
  const baySelectionRef = useRef<HTMLDivElement>(null);
  const requestButtonRef = useRef<HTMLDivElement>(null);
  const isFirstRenderRef = useRef(true);
  const prevDateRef = useRef<string | null>(null);
  const prevDurationRef = useRef<number | null>(null);

  const effectiveUser = viewAsUser || user;
  
  // Helper to check if member is a minor (under 18)
  const isMinor = useMemo(() => {
    const dob = effectiveUser?.dateOfBirth;
    if (!dob) return false; // If no DOB, don't block bookings
    
    const birthDate = new Date(dob);
    if (isNaN(birthDate.getTime())) return false;
    
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age < 18;
  }, [effectiveUser?.dateOfBirth]);
  
  // Check if admin is viewing as a member
  const isAdminViewingAs = actualUser?.role === 'admin' && isViewingAs;

  // IMPORTANT: Define tier permissions, dates, and selectedDateObj BEFORE any useEffect that depends on them
  const { permissions: tierPermissions, loading: tierLoading } = useTierPermissions(effectiveUser?.tier);
  const canBookSimulators = canAccessResource(tierPermissions, 'simulator');
  const canBookConference = canAccessResource(tierPermissions, 'conference');
  const isTierLoaded = Boolean(effectiveUser?.tier) && !tierLoading;
  
    
  // Generate dates with safe fallback - ensure we always have at least one date
  const dates = useMemo(() => {
    const advanceDays = tierPermissions?.advanceBookingDays ?? 7;
    return generateDates(advanceDays);
  }, [tierPermissions?.advanceBookingDays]);
  
  // Initialize with null to avoid accessing potentially undefined array element
  const [selectedDateObj, setSelectedDateObj] = useState<{ label: string; date: string; day: string; dateNum: string } | null>(null);

  // Sync selectedDateObj when dates array changes (e.g., when user tier loads)
  useEffect(() => {
    if (dates.length > 0 && (!selectedDateObj || !dates.find(d => d.date === selectedDateObj.date))) {
      setSelectedDateObj(dates[0]);
    }
  }, [dates, selectedDateObj]);

  // ============ REACT QUERY HOOKS ============

  // Resources Query
  const resourceType = activeTab === 'simulator' ? 'simulator' : 'conference_room';
  const { data: resources = [], isLoading: resourcesLoading, error: resourcesError } = useQuery({
    queryKey: bookGolfKeys.resources(resourceType),
    queryFn: async () => {
      const data = await fetchWithCredentials<APIResource[]>('/api/resources');
      const typeMap: Record<string, string> = { simulator: 'simulator', conference: 'conference_room' };
      return data
        .filter(r => r.type === typeMap[activeTab])
        .map(r => ({
          id: `resource-${r.id}`,
          dbId: r.id,
          name: r.name,
          meta: r.description || `Capacity: ${r.capacity}`,
          badge: r.type === 'simulator' ? 'Indoor' : undefined,
          icon: r.type === 'simulator' ? 'golf_course' : r.type === 'conference_room' ? 'meeting_room' : 'person'
        }));
    },
    staleTime: 1000 * 60 * 5,
  });

  // Availability Query
  const resourceIds = resources.map(r => r.dbId);
  const { data: availableSlots = [], isLoading: availabilityLoading } = useQuery({
    queryKey: bookGolfKeys.availability(resourceIds, selectedDateObj?.date || '', duration, rescheduleBookingId || undefined),
    queryFn: async () => {
      if (!selectedDateObj?.date || resourceIds.length === 0) return [];
      
      const batchResult = await postWithCredentials<Record<number, { slots: APISlot[] }>>(
        '/api/availability/batch',
        {
          resource_ids: resourceIds,
          date: selectedDateObj.date,
          duration,
          ignore_booking_id: rescheduleBookingId || undefined
        }
      );
      
      const allSlots: Map<string, { slot: TimeSlot; resourceIds: number[] }> = new Map();
      
      resources.forEach(resource => {
        const resourceData = batchResult[resource.dbId];
        if (!resourceData?.slots) return;
        
        resourceData.slots.forEach(slot => {
          if (!slot.available) return;
          const key = slot.start_time;
          
          if (allSlots.has(key)) {
            allSlots.get(key)!.resourceIds.push(resource.dbId);
          } else {
            allSlots.set(key, { 
              slot: {
                id: `slot-${slot.start_time}`,
                start: formatTime12Hour(slot.start_time),
                end: formatTime12Hour(slot.end_time),
                startTime24: slot.start_time,
                endTime24: slot.end_time,
                label: `${formatTime12Hour(slot.start_time)} – ${formatTime12Hour(slot.end_time)}`,
                available: true,
                availableResourceDbIds: []
              }, 
              resourceIds: [resource.dbId] 
            });
          }
        });
      });
      
      return Array.from(allSlots.values())
        .map(({ slot, resourceIds: resIds }) => ({
          ...slot,
          availableResourceDbIds: resIds
        }))
        .sort((a, b) => a.startTime24.localeCompare(b.startTime24));
    },
    enabled: !!selectedDateObj?.date && resourceIds.length > 0,
  });

  // Guest Passes Query
  const { data: guestPassInfo } = useQuery({
    queryKey: bookGolfKeys.guestPasses(effectiveUser?.email || '', effectiveUser?.tier || ''),
    queryFn: () => fetchWithCredentials<GuestPassInfo>(
      `/api/guest-passes/${encodeURIComponent(effectiveUser!.email!)}?tier=${encodeURIComponent(effectiveUser!.tier!)}`
    ),
    enabled: !!effectiveUser?.email && !!effectiveUser?.tier,
  });

  // My Booking Requests Query
  const { data: myRequests = [] } = useQuery({
    queryKey: bookGolfKeys.myRequests(effectiveUser?.email || ''),
    queryFn: () => fetchWithCredentials<BookingRequest[]>(
      `/api/booking-requests?user_email=${encodeURIComponent(effectiveUser!.email!)}`
    ),
    enabled: !!effectiveUser?.email,
  });

  // Closures Query
  const { data: closures = [] } = useQuery({
    queryKey: bookGolfKeys.closures(),
    queryFn: () => fetchWithCredentials<Closure[]>('/api/closures'),
    staleTime: 1000 * 60 * 5,
  });

  // Existing Bookings Check Query
  const { data: existingBookingCheck } = useQuery({
    queryKey: bookGolfKeys.existingBookings(selectedDateObj?.date || '', activeTab),
    queryFn: () => fetchWithCredentials<ExistingBookingCheck>(
      `/api/bookings/check-existing?date=${selectedDateObj!.date}&resource_type=${activeTab}`
    ),
    enabled: !!selectedDateObj?.date && activeTab === 'simulator' && !rescheduleBookingId,
  });

  // Fee Estimate Query (debounced via staleTime)
  const guestCount = activeTab === 'simulator' ? playerSlots.filter(slot => slot.type === 'guest').length : 0;
  const effectivePlayerCount = activeTab === 'simulator' ? playerCount : 1;
  const feeEstimateParams = useMemo(() => {
    if (!duration || !selectedDateObj?.date) return '';
    const params = new URLSearchParams({
      durationMinutes: duration.toString(),
      guestCount: guestCount.toString(),
      playerCount: effectivePlayerCount.toString(),
      date: selectedDateObj.date,
      resourceType: activeTab === 'conference' ? 'conference_room' : 'simulator'
    });
    if (effectiveUser?.email && isAdminViewingAs) {
      params.set('email', effectiveUser.email);
    }
    return params.toString();
  }, [duration, guestCount, effectivePlayerCount, selectedDateObj?.date, activeTab, effectiveUser?.email, isAdminViewingAs]);

  const { data: feeEstimateData, isLoading: feeEstimateLoading } = useQuery({
    queryKey: bookGolfKeys.feeEstimate(feeEstimateParams),
    queryFn: () => fetchWithCredentials<FeeEstimateResponse>(`/api/fee-estimate?${feeEstimateParams}`),
    enabled: !!feeEstimateParams,
    staleTime: 1000 * 60,
  });

  const estimatedFees = useMemo(() => {
    if (!feeEstimateData) {
      return {
        overageFee: 0, guestFees: 0, totalFee: 0, guestCount: 0, overageMinutes: 0,
        guestsUsingPasses: 0, guestsCharged: 0, passesRemainingAfter: guestPassInfo?.passes_remaining ?? 0, isLoading: feeEstimateLoading
      };
    }
    return {
      overageFee: feeEstimateData.feeBreakdown.overageFee,
      guestFees: feeEstimateData.feeBreakdown.guestFees,
      totalFee: feeEstimateData.totalFee,
      guestCount: feeEstimateData.feeBreakdown.guestCount,
      overageMinutes: feeEstimateData.feeBreakdown.overageMinutes,
      guestsUsingPasses: feeEstimateData.feeBreakdown.guestsUsingPasses,
      guestsCharged: feeEstimateData.feeBreakdown.guestsCharged,
      passesRemainingAfter: Math.max(0, feeEstimateData.feeBreakdown.guestPassesRemaining - feeEstimateData.feeBreakdown.guestCount),
      isLoading: feeEstimateLoading
    };
  }, [feeEstimateData, feeEstimateLoading, guestPassInfo?.passes_remaining]);

  // Create Booking Mutation
  const createBookingMutation = useMutation({
    mutationFn: async (bookingData: {
      user_email: string;
      user_name: string;
      user_tier: string;
      resource_id: number;
      request_date: string;
      start_time: string;
      duration_minutes: number;
      notes: string | null;
      declared_player_count?: number;
      member_notes?: string;
      request_participants?: Array<{ email?: string; type: string; userId?: string; name?: string }>;
      reschedule_booking_id?: number;
      guardian_name?: string;
      guardian_relationship?: string;
      guardian_phone?: string;
      guardian_consent?: boolean;
    }) => postWithCredentials<{ id: number }>('/api/booking-requests', bookingData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookGolfKeys.all });
    },
  });

  // Cancel Booking Mutation
  const cancelBookingMutation = useMutation({
    mutationFn: async ({ bookingId, actingAsEmail }: { bookingId: number; actingAsEmail?: string }) => 
      putWithCredentials<{ success: boolean }>(`/api/bookings/${bookingId}/member-cancel`, { acting_as_email: actingAsEmail }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookGolfKeys.all });
    },
  });

  // Derived loading state
  const isLoading = resourcesLoading || availabilityLoading;
  const error = resourcesError ? (resourcesError as Error).message : null;

  // ============ END REACT QUERY HOOKS ============

  // Clear selected slot and resource when date or duration changes to prevent stale data
  useEffect(() => {
    const currentDate = selectedDateObj?.date ?? null;
    
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      prevDateRef.current = currentDate;
      prevDurationRef.current = duration;
      return;
    }
    
    const dateChanged = currentDate !== prevDateRef.current;
    const durationChanged = duration !== prevDurationRef.current;
    
    if (dateChanged || durationChanged) {
      setSelectedSlot(null);
      setSelectedResource(null);
    }
    
    prevDateRef.current = currentDate;
    prevDurationRef.current = duration;
  }, [selectedDateObj, duration]);

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  useEffect(() => {
    const rescheduleParam = searchParams.get('reschedule');
    if (rescheduleParam) {
      const bookingId = parseInt(rescheduleParam, 10);
      if (!isNaN(bookingId)) {
        setRescheduleBookingId(bookingId);
      }
    }
  }, [searchParams]);

  // Find original booking when rescheduling
  useEffect(() => {
    if (rescheduleBookingId && myRequests.length > 0 && dates.length > 0) {
      const booking = myRequests.find(b => b.id === rescheduleBookingId);
      if (booking) {
        setOriginalBooking(booking);
        const dateParam = searchParams.get('date');
        const matchingDate = dateParam ? dates.find(d => d.date === dateParam) : null;
        if (matchingDate) {
          setSelectedDateObj(matchingDate);
        }
      }
    }
  }, [rescheduleBookingId, myRequests, dates, searchParams]);

  // Listen for real-time booking updates
  useEffect(() => {
    const handleBookingUpdate = () => {
      queryClient.invalidateQueries({ queryKey: bookGolfKeys.myRequests(effectiveUser?.email || '') });
      if (selectedDateObj?.date && activeTab === 'simulator' && !rescheduleBookingId) {
        queryClient.invalidateQueries({ queryKey: bookGolfKeys.existingBookings(selectedDateObj.date, activeTab) });
      }
    };
    
    window.addEventListener('booking-update', handleBookingUpdate);
    return () => window.removeEventListener('booking-update', handleBookingUpdate);
  }, [queryClient, effectiveUser?.email, selectedDateObj?.date, activeTab, rescheduleBookingId]);


  // Reset playerSlots when playerCount changes
  useEffect(() => {
    const slotsNeeded = Math.max(0, playerCount - 1);
    setPlayerSlots(prev => {
      if (prev.length === slotsNeeded) return prev;
      const newSlots: Array<{email: string, type: 'member' | 'guest', searchQuery: string, selectedId?: string, selectedName?: string}> = [];
      for (let i = 0; i < slotsNeeded; i++) {
        newSlots.push(prev[i] || { email: '', type: 'guest', searchQuery: '' });
      }
      return newSlots;
    });
    setPlayerSearchResults({});
    setActiveSearchIndex(null);
  }, [playerCount]);

  // Search for members or guests based on player slot type
  const handlePlayerSearch = useCallback(async (index: number, query: string, type: 'member' | 'guest') => {
    if (searchTimeoutRef.current[index]) {
      clearTimeout(searchTimeoutRef.current[index]);
    }
    
    if (query.length < 2) {
      setPlayerSearchResults(prev => ({ ...prev, [index]: [] }));
      return;
    }
    
    searchTimeoutRef.current[index] = setTimeout(async () => {
      try {
        const endpoint = type === 'member' 
          ? `/api/members/search?query=${encodeURIComponent(query)}&limit=8`
          : `/api/guests/search?query=${encodeURIComponent(query)}&limit=8`;
        
        const data = await fetchWithCredentials<Array<{
          id: string;
          name: string;
          emailRedacted: string;
          visitorType?: string;
        }>>(endpoint);
        
        setPlayerSearchResults(prev => ({ ...prev, [index]: data }));
      } catch (err) {
        console.error('Player search error:', err);
      }
    }, 300);
  }, []);
  
  // Select a player from search results
  const handleSelectPlayer = useCallback((index: number, result: { id: string; name: string; emailRedacted: string }) => {
    setPlayerSlots(prev => {
      const newSlots = [...prev];
      newSlots[index] = {
        ...newSlots[index],
        selectedId: result.id,
        selectedName: result.name,
        searchQuery: result.name,
        email: result.emailRedacted, // Store redacted email for display
      };
      return newSlots;
    });
    setPlayerSearchResults(prev => ({ ...prev, [index]: [] }));
    setActiveSearchIndex(null);
  }, []);
  
  // Clear selection and allow manual entry (for new guests)
  const handleClearSelection = useCallback((index: number) => {
    setPlayerSlots(prev => {
      const newSlots = [...prev];
      newSlots[index] = {
        ...newSlots[index],
        selectedId: undefined,
        selectedName: undefined,
        searchQuery: '',
        email: '',
      };
      return newSlots;
    });
  }, []);


  // Auto-scroll to time slots when duration is selected by user (not on initial load)
  useEffect(() => {
    if (hasUserSelectedDuration && duration && timeSlotsRef.current) {
      setTimeout(() => {
        timeSlotsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [hasUserSelectedDuration, duration, activeTab]);

  // Auto-scroll to bay/room selection when a time slot is picked
  useEffect(() => {
    if (selectedSlot && !selectedResource && baySelectionRef.current) {
      setTimeout(() => {
        baySelectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
    }
  }, [selectedSlot, selectedResource]);

  // Auto-scroll to request button when a bay/room is selected
  useEffect(() => {
    if (selectedSlot && selectedResource && requestButtonRef.current) {
      setTimeout(() => {
        requestButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 150);
    }
  }, [selectedSlot, selectedResource]);

  const cancelRescheduleMode = useCallback(() => {
    setRescheduleBookingId(null);
    setOriginalBooking(null);
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('reschedule');
    newParams.delete('date');
    setSearchParams(newParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const isBookingWithin30Minutes = useCallback((booking: BookingRequest): boolean => {
    if (!booking) return false;
    const { year, month, day, hour, minute } = getPacificDateParts();
    const nowPacific = new Date(year, month - 1, day, hour, minute);
    
    const [bookingYear, bookingMonth, bookingDay] = booking.request_date.split('-').map(Number);
    const [bookingHour, bookingMinute] = booking.start_time.split(':').map(Number);
    const bookingStart = new Date(bookingYear, bookingMonth - 1, bookingDay, bookingHour, bookingMinute);
    
    const diffMs = bookingStart.getTime() - nowPacific.getTime();
    const diffMinutes = diffMs / (1000 * 60);
    return diffMinutes <= 30;
  }, []);

  const hasPendingRescheduleRequest = useMemo(() => {
    if (!rescheduleBookingId) return false;
    return myRequests.some(r => 
      r.reschedule_booking_id === rescheduleBookingId && 
      r.status === 'pending'
    );
  }, [myRequests, rescheduleBookingId]);

  const rescheduleTimeError = useMemo(() => {
    if (!rescheduleBookingId || !originalBooking) return null;
    if (isBookingWithin30Minutes(originalBooking)) {
      return 'Cannot reschedule a booking that starts within 30 minutes.';
    }
    return null;
  }, [rescheduleBookingId, originalBooking, isBookingWithin30Minutes]);

  useEffect(() => {
    if (!selectedDateObj?.date || !myRequests.length || activeTab !== 'simulator' || rescheduleBookingId) {
      setExistingDayBooking(null);
      return;
    }
    
    const existingBayBooking = myRequests.find(r => 
      r.request_date === selectedDateObj.date &&
      (r.status === 'approved' || r.status === 'pending') &&
      !r.notes?.includes('Conference room booking')
    );
    
    setExistingDayBooking(existingBayBooking || null);
  }, [selectedDateObj, myRequests, activeTab, rescheduleBookingId]);

  const memberBayBookingForDay = useMemo(() => {
    if (!selectedDateObj?.date || !myRequests.length) return null;
    return myRequests.find(r => 
      r.request_date === selectedDateObj.date &&
      (r.status === 'approved' || r.status === 'pending') &&
      !r.notes?.includes('Conference room booking')
    ) || null;
  }, [selectedDateObj, myRequests]);

  // Calculate minutes already booked for the selected date
  const { usedMinutesForDay, remainingMinutes, isAtDailyLimit } = useMemo(() => {
    if (!selectedDateObj?.date || !myRequests.length) {
      const dailyLimit = activeTab === 'simulator' 
        ? tierPermissions.dailySimulatorMinutes 
        : tierPermissions.dailyConfRoomMinutes;
      return { usedMinutesForDay: 0, remainingMinutes: dailyLimit || 60, isAtDailyLimit: false };
    }
    
    const isSimulator = activeTab === 'simulator';
    const dailyLimit = isSimulator 
      ? tierPermissions.dailySimulatorMinutes 
      : tierPermissions.dailyConfRoomMinutes;
    
    // For unlimited access, return large values
    if (tierPermissions.unlimitedAccess || dailyLimit >= 999) {
      return { usedMinutesForDay: 0, remainingMinutes: 999, isAtDailyLimit: false };
    }
    
    // Calculate minutes used from bookings on selected date
    // Include approved, pending, confirmed, and attended statuses (exclude cancelled/declined/no_show)
    const bookingsForDate = myRequests.filter(r => {
      if (r.request_date !== selectedDateObj.date) return false;
      if (!['approved', 'pending', 'confirmed', 'attended'].includes(r.status)) return false;
      
      // Check resource type - safely handle null/undefined bay_name
      const bayNameLower = r.bay_name?.toLowerCase() ?? '';
      const isConferenceBooking = r.notes?.includes('Conference room booking') || 
        bayNameLower.includes('conference');
      
      if (isSimulator && isConferenceBooking) return false;
      if (!isSimulator && !isConferenceBooking) return false;
      
      // If rescheduling, exclude the booking being rescheduled from usage calculation
      if (rescheduleBookingId && r.id === rescheduleBookingId) return false;
      
      return true;
    });
    
    const usedMinutes = bookingsForDate.reduce((sum, booking) => {
      const start = booking.start_time?.split(':').map(Number) || [0, 0];
      const end = booking.end_time?.split(':').map(Number) || [0, 0];
      const totalMinutes = (end[0] * 60 + end[1]) - (start[0] * 60 + start[1]);
      
      // Split time among all players (members + guests) if total_player_count is available
      const playerCount = (booking as any).total_player_count || 1;
      const memberShare = Math.ceil(totalMinutes / playerCount);
      
      return sum + memberShare;
    }, 0);
    
    const remaining = Math.max(0, dailyLimit - usedMinutes);
    
    // Members can always book - they just pay overage fees for time beyond their included minutes
    // Never block booking based on daily limit (isAtDailyLimit is only used for display, not blocking)
    
    return { 
      usedMinutesForDay: usedMinutes, 
      remainingMinutes: remaining, 
      isAtDailyLimit: false  // Never block - show fees instead
    };
  }, [selectedDateObj?.date, myRequests, activeTab, tierPermissions, rescheduleBookingId]);

  const doTimesOverlap = (
    start1: string, end1: string,
    start2: string, end2: string
  ): boolean => {
    const toMinutes = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const s1 = toMinutes(start1), e1 = toMinutes(end1);
    const s2 = toMinutes(start2), e2 = toMinutes(end2);
    return s1 < e2 && s2 < e1;
  };

  const filteredSlotsForConference = useMemo(() => {
    if (activeTab !== 'conference' || !memberBayBookingForDay) {
      return availableSlots;
    }
    return availableSlots.filter(slot => 
      !doTimesOverlap(
        slot.startTime24, 
        slot.endTime24,
        memberBayBookingForDay.start_time,
        memberBayBookingForDay.end_time
      )
    );
  }, [activeTab, memberBayBookingForDay, availableSlots]);

  const handleCancelRequest = async (id: number) => {
    haptic.light();
    const request = myRequests.find(r => r.id === id);
    const wasApproved = request?.status === 'approved';
    
    try {
      await cancelBookingMutation.mutateAsync({
        bookingId: id,
        actingAsEmail: isAdminViewingAs ? effectiveUser?.email : undefined
      });
      
      haptic.success();
      playSound('success');
      showToast(wasApproved ? 'Booking cancelled successfully' : 'Request cancelled', 'success');
    } catch (err) {
      console.error('[BookGolf] Failed to cancel request:', err);
      haptic.error();
      showToast((err as Error).message || 'Failed to cancel booking', 'error');
    }
  };

  const getAvailableResourcesForSlot = (slot: TimeSlot): Resource[] => {
    return resources.filter(r => slot.availableResourceDbIds.includes(r.dbId));
  };

  // Handle the actual booking submission
  const submitBooking = async (consentData?: GuardianConsentData) => {
    if (!selectedSlot || !selectedResource || !effectiveUser || !selectedDateObj) return;
    
    // Double-check ref to prevent duplicate submissions
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    
    setBookingError(null);
    setShowViewAsConfirm(false);
    
    // Use passed consent data or existing state
    const consent = consentData || guardianConsentData;
    
    try {
      // Validate guest slots have valid email if not selected from directory
      const invalidGuestSlot = playerSlots.find(slot => 
        slot.type === 'guest' && 
        !slot.selectedId && 
        slot.email && 
        !slot.email.includes('@')
      );
      if (invalidGuestSlot) {
        setBookingError('Please enter a valid email address for each guest.');
        haptic.error();
        return;
      }
      
      const requestParticipants = activeTab === 'simulator' && playerSlots.length > 0
        ? playerSlots
            .filter(slot => slot.selectedId || (slot.email && slot.email.includes('@')))
            .map(slot => ({ 
              // Only include email for new guests (not selected from directory)
              email: slot.selectedId ? undefined : slot.email, 
              type: slot.type,
              userId: slot.selectedId,
              name: slot.selectedName,
            }))
        : undefined;

      await createBookingMutation.mutateAsync({
        user_email: effectiveUser.email,
        user_name: effectiveUser.name,
        user_tier: effectiveUser.tier,
        resource_id: selectedResource.dbId,
        request_date: selectedDateObj.date,
        start_time: selectedSlot.startTime24,
        duration_minutes: duration,
        notes: activeTab === 'conference' ? 'Conference room booking' : null,
        declared_player_count: activeTab === 'simulator' ? playerCount : undefined,
        member_notes: memberNotes.trim() || undefined,
        request_participants: requestParticipants,
        ...(rescheduleBookingId ? { reschedule_booking_id: rescheduleBookingId } : {}),
        ...(consent ? {
          guardian_name: consent.guardianName,
          guardian_relationship: consent.guardianRelationship,
          guardian_phone: consent.guardianPhone,
          guardian_consent: consent.acknowledged
        } : {})
      });
      
      addBooking({
        id: Date.now().toString(),
        type: 'golf',
        title: selectedResource.name,
        date: selectedDateObj.label,
        time: selectedSlot.start,
        details: `${duration} min`,
        color: 'primary'
      });
      
      bookingEvents.emit();
      
      haptic.success();
      playSound('bookingConfirmed');
      setShowConfirmation(true);
      setTimeout(() => {
        setShowConfirmation(false);
        setSelectedSlot(null);
        setSelectedResource(null);
        if (rescheduleBookingId) {
          cancelRescheduleMode();
        }
      }, 2500);
    } catch (err: any) {
      haptic.error();
      const errorMessage = err.message || 'Booking failed. Please try again.';
      if (errorMessage.includes('402') || errorMessage.includes('payment')) {
        setBookingError('Please contact the front desk to complete your booking.');
      } else {
        showToast(errorMessage, 'error');
        setBookingError(errorMessage);
      }
    } finally {
      isSubmittingRef.current = false;
    }
  };

  // Check if booking is in progress
  const isBooking = createBookingMutation.isPending;

  const handleConfirm = async () => {
    if (!selectedSlot || !selectedResource || !effectiveUser || !selectedDateObj) return;
    
    // Prevent double-taps with ref (immediate check before React re-render)
    if (isSubmittingRef.current || isBooking) return;
    
    // If admin is viewing as member, show confirmation popup first
    if (isAdminViewingAs) {
      setShowViewAsConfirm(true);
      return;
    }
    
    // For simulator bookings, check if member is a minor and needs guardian consent
    if (activeTab === 'simulator' && isMinor && !guardianConsentData) {
      setShowGuardianConsent(true);
      return;
    }
    
    // Otherwise proceed directly
    await submitBooking();
  };
  
  const handleGuardianConsentSubmit = (data: GuardianConsentData) => {
    setGuardianConsentData(data);
    setShowGuardianConsent(false);
    submitBooking(data);
  };

  const canBook = Boolean(
    selectedDateObj && 
    duration && 
    selectedSlot && 
    selectedResource && 
    !isBooking && 
    !rescheduleTimeError &&
    !hasPendingRescheduleRequest &&
    (activeTab !== 'simulator' || !isAtDailyLimit || rescheduleBookingId)
  );


  const activeClosures = useMemo(() => {
    if (!selectedDateObj?.date) return [];
    return closures.filter(closure => {
      const selectedDate = selectedDateObj.date;
      if (selectedDate < closure.startDate || selectedDate > closure.endDate) {
        return false;
      }
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
      
      if (!grouped[hour24]) {
        grouped[hour24] = { hourLabel, hour24, slots: [], totalAvailable: 0 };
      }
      grouped[hour24].slots.push(slot);
      grouped[hour24].totalAvailable = Math.max(grouped[hour24].totalAvailable, slot.availableResourceDbIds.length);
    });
    
    return Object.values(grouped).sort((a, b) => a.hour24.localeCompare(b.hour24));
  }, [slotsToDisplay]);

  const handleRefresh = useCallback(async () => {
    // Preserve scroll position
    const scrollY = window.scrollY;
    
    setSelectedSlot(null);
    setSelectedResource(null);
    setExpandedHour(null);
    
    // Invalidate all BookGolf-related queries to refetch data
    await queryClient.invalidateQueries({ queryKey: bookGolfKeys.all });
    
    // Restore scroll position after data refresh
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollY);
    });
  }, [queryClient]);

  return (
    <AnimatedPage>
    <PullToRefresh onRefresh={handleRefresh}>
    <SwipeablePage className="px-6 lg:px-8 xl:px-12 relative">
      <section className="mb-6 pt-4 md:pt-2 animate-content-enter-delay-1">
        <h1 className={`text-3xl font-bold leading-tight drop-shadow-md ${isDark ? 'text-white' : 'text-primary'}`}>Book</h1>
        <p className={`text-sm font-medium mt-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Reserve simulators or conference room.</p>
      </section>

      {rescheduleBookingId && originalBooking && (
        <section className={`mb-4 rounded-xl p-4 border ${isDark ? 'bg-blue-500/10 border-blue-500/30' : 'bg-blue-50 border-blue-200'}`}>
          <div className="flex items-start gap-3">
            <span className={`material-symbols-outlined text-2xl ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>event_repeat</span>
            <div className="flex-1">
              <h4 className={`font-bold ${isDark ? 'text-blue-300' : 'text-blue-800'}`}>
                Rescheduling Booking
              </h4>
              <p className={`text-sm mt-1 ${isDark ? 'text-blue-300/80' : 'text-blue-700'}`}>
                {originalBooking.bay_name} on {formatDateShort(originalBooking.request_date)} at {formatTime12Hour(originalBooking.start_time)}
              </p>
            </div>
            <button
              onClick={cancelRescheduleMode}
              className={`text-sm font-medium flex items-center gap-1 ${isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-800'}`}
            >
              <span className="material-symbols-outlined text-sm">close</span>
              Cancel
            </button>
          </div>
          {rescheduleTimeError && (
            <div className={`mt-3 p-3 rounded-lg ${isDark ? 'bg-red-500/20' : 'bg-red-100'}`}>
              <p className={`text-sm font-medium ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                {rescheduleTimeError}
              </p>
            </div>
          )}
          {hasPendingRescheduleRequest && (
            <div className={`mt-3 p-3 rounded-lg ${isDark ? 'bg-yellow-500/20' : 'bg-yellow-100'}`}>
              <p className={`text-sm font-medium ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>
                You already have a pending reschedule request for this booking.
              </p>
            </div>
          )}
        </section>
      )}

      {effectiveUser?.status && effectiveUser.status.toLowerCase() !== 'active' ? (
        <section className={`rounded-2xl p-6 border text-center glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}>
          <span className="material-symbols-outlined text-4xl text-accent mb-4">lock</span>
          <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-primary'}`}>Membership Not Active</h3>
          <p className={`text-sm mb-4 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
            Your membership is currently {effectiveUser.status.toLowerCase()}. Please contact the front desk or update your membership to resume booking.
          </p>
          <a 
            href="/membership" 
            className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-brand-green rounded-xl font-bold text-sm"
          >
            <span className="material-symbols-outlined text-lg">upgrade</span>
            View Membership Options
          </a>
        </section>
      ) : (
        <>
        <section className={`mb-8 border-b -mx-6 px-6 ${isDark ? 'border-white/25' : 'border-black/10'}`}>
          <div className="flex gap-6 overflow-x-auto pb-0 scrollbar-hide scroll-fade-right" role="tablist">
            <TabButton 
              label="Golf Simulator" 
              active={activeTab === 'simulator'} 
              onClick={() => setActiveTab('simulator')} 
              isDark={isDark} 
            />
            <TabButton 
              label="Conference Room" 
              active={activeTab === 'conference'} 
              onClick={() => setActiveTab('conference')} 
              isDark={isDark} 
            />
          </div>
        </section>

        {activeTab === 'simulator' && isTierLoaded && !canBookSimulators ? (
        <section className={`rounded-2xl p-6 border text-center glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}>
          <span className="material-symbols-outlined text-4xl text-accent mb-4">lock</span>
          <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-primary'}`}>Upgrade to Book Simulators</h3>
          <p className={`text-sm mb-4 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
            Golf simulator access is available for Core, Premium, and Corporate members. Upgrade your membership to start booking.
          </p>
          <a 
            href="/membership" 
            className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-brand-green rounded-xl font-bold text-sm"
          >
            <span className="material-symbols-outlined text-lg">upgrade</span>
            View Membership Options
          </a>
        </section>
      ) : activeTab === 'conference' && isTierLoaded && !canBookConference ? (
        <section className={`rounded-2xl p-6 border text-center glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}>
          <span className="material-symbols-outlined text-4xl text-accent mb-4">lock</span>
          <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-primary'}`}>Upgrade for Conference Room Access</h3>
          <p className={`text-sm mb-4 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
            Conference room booking is available for Core, Premium, and Corporate members. Upgrade your membership to start booking.
          </p>
          <a 
            href="/membership" 
            className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-brand-green rounded-xl font-bold text-sm"
          >
            <span className="material-symbols-outlined text-lg">upgrade</span>
            View Membership Options
          </a>
        </section>
) : (
        <div key={activeTab} className="relative z-10 animate-content-enter space-y-6">
          {activeTab === 'simulator' && (
          <section className={`rounded-2xl p-4 border glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-white/80' : 'text-primary/80'}`}>How many players?</span>
                <button
                  onClick={() => setShowPlayerTooltip(!showPlayerTooltip)}
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${isDark ? 'bg-white/10 text-white/60 hover:bg-white/20' : 'bg-black/5 text-primary/60 hover:bg-black/10'}`}
                >
                  ?
                </button>
              </div>
            </div>
            {showPlayerTooltip && (
              <div className={`mb-3 p-3 rounded-lg text-sm ${isDark ? 'bg-blue-500/10 border border-blue-500/30 text-blue-300' : 'bg-blue-50 border border-blue-200 text-blue-700'}`}>
                <span className="material-symbols-outlined text-sm mr-1 align-middle">info</span>
                Guest time counts toward your daily usage. Time is split equally among all players.
              </div>
            )}
            <div className={`flex gap-2 p-1 rounded-xl border ${isDark ? 'bg-black/20 border-white/20' : 'bg-black/5 border-black/5'}`}>
              {[1, 2, 3, 4].map(count => (
                <button
                  key={count}
                  onClick={() => { haptic.selection(); setPlayerCount(count); }}
                  aria-pressed={playerCount === count}
                  className={`flex-1 py-3 rounded-lg transition-all active:scale-95 focus:ring-2 focus:ring-accent focus:outline-none ${
                    playerCount === count
                      ? 'bg-accent text-[#293515] shadow-glow'
                      : (isDark ? 'text-white/80 hover:bg-white/5 hover:text-white' : 'text-primary/80 hover:bg-black/5 hover:text-primary')
                  }`}
                >
                  <div className="text-lg font-bold">{count}</div>
                  <div className="text-[10px] opacity-70">{count === 1 ? 'Solo' : count === 2 ? 'Duo' : count === 3 ? 'Trio' : 'Four'}</div>
                </button>
              ))}
            </div>
          </section>
          )}

          {activeTab === 'simulator' && playerCount > 1 && (
          <section className={`rounded-2xl p-4 border glass-card relative ${activeSearchIndex !== null ? 'z-20' : 'z-10'} ${isDark ? 'border-white/25' : 'border-black/10'}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Additional Players</span>
              <span className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>(Optional)</span>
            </div>
            <div className="space-y-4">
              {playerSlots.map((slot, index) => (
                <div key={index} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className={`text-sm font-medium ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                      Player {index + 2}
                    </label>
                    <div className={`flex rounded-lg border overflow-hidden ${isDark ? 'border-white/20' : 'border-black/10'}`}>
                      <button
                        type="button"
                        onClick={() => {
                          haptic.selection();
                          const newSlots = [...playerSlots];
                          newSlots[index] = { ...newSlots[index], type: 'member', searchQuery: '', selectedId: undefined, selectedName: undefined, email: '' };
                          setPlayerSlots(newSlots);
                          setPlayerSearchResults(prev => ({ ...prev, [index]: [] }));
                        }}
                        className={`px-3 py-1.5 text-xs font-medium transition-all ${
                          slot.type === 'member'
                            ? 'bg-accent text-[#293515]'
                            : (isDark ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'bg-black/5 text-primary/60 hover:bg-black/10')
                        }`}
                      >
                        Member
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          haptic.selection();
                          const newSlots = [...playerSlots];
                          newSlots[index] = { ...newSlots[index], type: 'guest', searchQuery: '', selectedId: undefined, selectedName: undefined, email: '' };
                          setPlayerSlots(newSlots);
                          setPlayerSearchResults(prev => ({ ...prev, [index]: [] }));
                        }}
                        className={`px-3 py-1.5 text-xs font-medium transition-all ${
                          slot.type === 'guest'
                            ? 'bg-accent text-[#293515]'
                            : (isDark ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'bg-black/5 text-primary/60 hover:bg-black/10')
                        }`}
                      >
                        Guest
                      </button>
                    </div>
                  </div>
                  
                  <div className="relative">
                    {slot.selectedId ? (
                      <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${
                        isDark 
                          ? 'bg-accent/10 border-accent/30' 
                          : 'bg-accent/10 border-accent/30'
                      }`}>
                        <span className="material-symbols-outlined text-accent text-lg">
                          {slot.type === 'member' ? 'person' : 'person_add'}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-medium truncate ${isDark ? 'text-white' : 'text-primary'}`}>
                            {slot.selectedName}
                          </div>
                          <div className={`text-xs truncate ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                            {slot.email}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleClearSelection(index)}
                          className={`p-1 rounded-full transition-colors ${
                            isDark ? 'hover:bg-white/10' : 'hover:bg-black/10'
                          }`}
                        >
                          <span className="material-symbols-outlined text-lg opacity-60">close</span>
                        </button>
                      </div>
                    ) : (
                      <>
                        <input
                          type={slot.type === 'guest' ? 'email' : 'text'}
                          placeholder={slot.type === 'member' ? 'Search members by name...' : 'Search guests or enter their email...'}
                          value={slot.searchQuery}
                          onChange={(e) => {
                            const value = e.target.value;
                            const newSlots = [...playerSlots];
                            newSlots[index] = { ...newSlots[index], searchQuery: value, email: value };
                            setPlayerSlots(newSlots);
                            handlePlayerSearch(index, value, slot.type);
                          }}
                          onFocus={() => setActiveSearchIndex(index)}
                          onBlur={() => setTimeout(() => setActiveSearchIndex(null), 200)}
                          className={`w-full px-3 py-2.5 rounded-lg border text-sm transition-all focus:ring-2 focus:ring-accent focus:outline-none ${
                            isDark 
                              ? 'bg-white/5 border-white/20 text-white placeholder:text-white/40' 
                              : 'bg-black/5 border-black/10 text-primary placeholder:text-primary/40'
                          }`}
                        />
                        {activeSearchIndex === index && playerSearchResults[index]?.length > 0 && (
                          <div className={`absolute z-50 left-0 right-0 mt-1 rounded-lg border shadow-lg overflow-hidden max-h-48 overflow-y-auto ${
                            isDark ? 'bg-[#1a1f0e] border-white/20' : 'bg-white border-black/10'
                          }`}>
                            {playerSearchResults[index].map((result) => (
                              <button
                                key={result.id}
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => handleSelectPlayer(index, result)}
                                className={`w-full px-3 py-2.5 flex items-center gap-2 text-left transition-colors ${
                                  isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
                                }`}
                              >
                                <span className={`material-symbols-outlined text-lg ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                                  {slot.type === 'member' ? 'person' : 'person_add'}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className={`text-sm font-medium truncate ${isDark ? 'text-white' : 'text-primary'}`}>
                                    {result.name}
                                  </div>
                                  <div className={`text-xs truncate ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                                    {result.emailRedacted}
                                  </div>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                        {slot.searchQuery.length >= 2 && (playerSearchResults[index]?.length ?? 0) === 0 && activeSearchIndex === index && (
                          <div className={`absolute z-50 left-0 right-0 mt-1 rounded-lg border shadow-lg overflow-hidden ${
                            isDark ? 'bg-[#1a1f0e] border-white/20' : 'bg-white border-black/10'
                          }`}>
                            <div className={`px-3 py-2.5 text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                              {slot.type === 'member' 
                                ? "No member found with that name."
                                : slot.searchQuery.includes('@') 
                                  ? "No guest found. They'll be added as a new guest."
                                  : "Enter their email address to add as a new guest."}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
          )}

          <section className={`rounded-2xl p-4 border glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}>
            <div className="flex items-center justify-between mb-3">
              <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Date & Duration</span>
            </div>
            <div className="space-y-4">
              <div className="flex gap-3 overflow-x-auto py-8 px-3 -mx-3 scrollbar-hide scroll-fade-right">
                {dates.map((d) => (
                  <DateButton 
                    key={d.date}
                    day={d.day} 
                    date={d.dateNum} 
                    active={selectedDateObj?.date === d.date} 
                    onClick={() => { setSelectedDateObj(d); setExpandedHour(null); }} 
                    isDark={isDark}
                  />
                ))}
              </div>
              <div className={`grid ${activeTab === 'simulator' ? 'grid-cols-2' : 'grid-cols-4'} gap-2`}>
                {(() => {
                  const baseSimDurations = [60, 90, 120, 150, 180];
                  if (playerCount >= 4) baseSimDurations.push(240);
                  const baseDurations = activeTab === 'simulator' 
                    ? baseSimDurations 
                    : [30, 60, 90, 120];
                  const availableDurations = baseDurations;
                  
                  if (availableDurations.length === 0) {
                    return (
                      <div className={`col-span-2 py-2.5 text-center text-xs ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                        No time remaining for this date
                      </div>
                    );
                  }
                  
                  const isSocialTier = effectiveUser?.tier?.toLowerCase() === 'social';
                  const dailyAllowance = tierPermissions.dailySimulatorMinutes || 0;
                  
                  return availableDurations.map(mins => {
                    // For simulators: split time among players; for conference: full time to user
                    const perPersonMins = activeTab === 'simulator' ? Math.floor(mins / playerCount) : mins;
                    const isLowTime = activeTab === 'simulator' && playerCount >= 3 && mins <= 60;
                    const recommendedMins = playerCount * 30;
                    
                    const myUsageMinutes = perPersonMins;
                    const overageMinutes = isSocialTier 
                      ? myUsageMinutes 
                      : Math.max(0, (usedMinutesForDay + myUsageMinutes) - dailyAllowance);
                    const overageBlocks = Math.ceil(overageMinutes / 30);
                    const overageFee = overageBlocks * 25;
                    const hasOverage = overageMinutes > 0;
                    
                    return (
                      <button
                        key={mins}
                        onClick={() => { haptic.selection(); setDuration(mins); setExpandedHour(null); setHasUserSelectedDuration(true); }}
                        aria-pressed={duration === mins}
                        className={`relative p-3 rounded-xl border transition-all active:scale-95 focus:ring-2 focus:ring-accent focus:outline-none ${
                          duration === mins
                            ? 'bg-accent text-[#293515] border-accent shadow-glow'
                            : isLowTime
                              ? (isDark ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-700')
                              : (isDark ? 'bg-black/20 border-white/20 text-white/80 hover:bg-white/5' : 'bg-white border-black/10 text-primary/80 hover:bg-black/5')
                        }`}
                      >
                        <div className="text-lg font-bold">{mins}m</div>
                        {activeTab === 'simulator' && (
                          <div className={`text-[10px] ${duration === mins ? 'opacity-80' : 'opacity-60'}`}>
                            {perPersonMins} min each
                          </div>
                        )}
                        {isLowTime && duration !== mins && (
                          <div className="text-[9px] mt-1 opacity-80">
                            Rec: {recommendedMins}m+
                          </div>
                        )}
                        {hasOverage && duration !== mins && (
                          <div className={`absolute -top-2 -right-2 px-1.5 py-0.5 rounded-full text-[9px] font-bold ${
                            isDark ? 'bg-amber-500 text-black' : 'bg-amber-500 text-white'
                          }`}>
                            ${overageFee}
                          </div>
                        )}
                      </button>
                    );
                  });
                })()}
              </div>
            </div>
          </section>

          {error && (
            <div className="p-4 rounded-xl bg-red-500/20 border border-red-500/30 text-red-300 text-sm flex items-center gap-3">
              <span className="material-symbols-outlined">error</span>
              {error}
            </div>
          )}

          {activeClosures.length > 0 && (
            <div className="space-y-3">
              {activeClosures.map(closure => {
                const hasTimeRange = closure.startTime && closure.endTime;
                const isPartialDay = hasTimeRange;
                return (
                  <div 
                    key={closure.id}
                    className={`rounded-xl p-4 border ${isDark ? 'bg-amber-500/10 border-amber-500/30' : 'bg-amber-50 border-amber-200'}`}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`material-symbols-outlined text-2xl ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>notifications</span>
                      <div className="flex-1">
                        <h4 className={`font-bold ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>
                          {closure.noticeType || 'Notice'}
                        </h4>
                        {hasTimeRange && (
                          <p className={`text-sm mt-1 ${isDark ? 'text-amber-300/80' : 'text-amber-700'}`}>
                            {formatTime12Hour(closure.startTime!)} - {formatTime12Hour(closure.endTime!)}
                          </p>
                        )}
                        {isPartialDay && (
                          <p className={`text-xs mt-2 font-medium ${isDark ? 'text-amber-400/80' : 'text-amber-700'}`}>
                            Limited availability - see times below
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'simulator' && existingBookingCheck?.hasExisting && !rescheduleBookingId && (
            <div className={`p-4 rounded-xl mb-4 border ${isDark ? 'bg-amber-900/20 border-amber-800' : 'bg-amber-50 border-amber-200'}`}>
              <p className={`font-medium ${isDark ? 'text-amber-200' : 'text-amber-800'}`}>
                You already have a booking on this day
              </p>
              <p className={`text-sm mt-1 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                {existingBookingCheck.bookings[0]?.resourceName} - {formatTime12Hour(existingBookingCheck.bookings[0]?.startTime)} - {formatTime12Hour(existingBookingCheck.bookings[0]?.endTime)}
                {existingBookingCheck.staffCreated && ' (Booked by staff)'}
              </p>
              <p className={`text-xs mt-2 ${isDark ? 'text-amber-500' : 'text-amber-500'}`}>
                Only one simulator booking per day is allowed. You can cancel your existing booking from the Dashboard.
              </p>
            </div>
          )}

          {activeTab === 'simulator' && existingDayBooking && !rescheduleBookingId && !existingBookingCheck?.hasExisting && (
            <section className={`rounded-xl p-4 border ${isDark ? 'bg-accent/10 border-accent/30' : 'bg-accent/5 border-accent/30'}`}>
              <div className="flex items-start gap-3">
                <span className={`material-symbols-outlined text-2xl text-accent`}>event_available</span>
                <div className="flex-1">
                  <h4 className={`font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                    You already have a booking for {formatDateShort(existingDayBooking.request_date)}
                  </h4>
                  <p className={`text-sm mt-1 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                    {existingDayBooking.bay_name} - {formatTime12Hour(existingDayBooking.start_time)} - {formatTime12Hour(existingDayBooking.end_time)}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => {
                    haptic.medium();
                    const newParams = new URLSearchParams(searchParams);
                    newParams.set('reschedule', existingDayBooking.id.toString());
                    newParams.set('date', existingDayBooking.request_date);
                    setSearchParams(newParams, { replace: true });
                  }}
                  className="flex-1 py-3 rounded-xl font-bold text-sm bg-accent text-brand-green hover:bg-accent/90 transition-colors flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-lg">event_repeat</span>
                  Reschedule
                </button>
                <button
                  onClick={() => {
                    haptic.light();
                    setShowCancelConfirm(true);
                  }}
                  className={`flex-1 py-3 rounded-xl font-bold text-sm border transition-colors flex items-center justify-center gap-2 ${
                    isDark 
                      ? 'border-red-500/50 text-red-400 hover:bg-red-500/10' 
                      : 'border-red-300 text-red-600 hover:bg-red-50'
                  }`}
                >
                  <span className="material-symbols-outlined text-lg">event_busy</span>
                  Cancel
                </button>
              </div>
            </section>
          )}
          
          <ModalShell isOpen={showCancelConfirm} onClose={() => setShowCancelConfirm(false)} showCloseButton={false}>
            <div className="p-6 text-center">
              {(() => {
                const hasTrackman = existingDayBooking && (
                  !!(existingDayBooking.trackman_booking_id) || 
                  (existingDayBooking.notes && existingDayBooking.notes.includes('[Trackman Import ID:'))
                );
                return (
                  <>
                    <div className={`w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center ${hasTrackman ? (isDark ? 'bg-amber-500/20' : 'bg-amber-100') : (isDark ? 'bg-red-500/20' : 'bg-red-100')}`}>
                      <span className={`material-symbols-outlined text-3xl ${hasTrackman ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-red-400' : 'text-red-600')}`}>
                        {hasTrackman ? 'warning' : 'event_busy'}
                      </span>
                    </div>
                    <h3 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-primary'}`}>Cancel Booking?</h3>
                    <p className={`text-sm mb-4 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                      Are you sure you want to cancel your booking for {existingDayBooking ? formatDateShort(existingDayBooking.request_date) : ''} at {existingDayBooking ? `${formatTime12Hour(existingDayBooking.start_time)} - ${formatTime12Hour(existingDayBooking.end_time)}` : ''}?
                    </p>
                    
                    {hasTrackman && (
                      <div className={`rounded-lg p-4 mb-4 text-left ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
                        <div className="flex gap-3">
                          <span className={`material-symbols-outlined text-xl flex-shrink-0 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>info</span>
                          <div>
                            <p className={`text-sm font-medium ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>
                              This booking is linked to Trackman
                            </p>
                            <p className={`text-xs mt-1 ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                              After cancelling, the staff will be notified to also cancel it in Trackman.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    <div className="flex gap-3">
                      <button
                        onClick={() => setShowCancelConfirm(false)}
                        disabled={cancelBookingMutation.isPending}
                        className={`flex-1 py-3 rounded-xl font-bold text-sm border transition-colors ${
                          isDark 
                            ? 'border-white/20 text-white hover:bg-white/5' 
                            : 'border-primary/20 text-primary hover:bg-primary/5'
                        }`}
                      >
                        Keep Booking
                      </button>
                      <button
                        onClick={async () => {
                          if (!existingDayBooking) return;
                          setExistingDayBooking(null);
                          setShowCancelConfirm(false);
                          await handleCancelRequest(existingDayBooking.id);
                        }}
                        disabled={cancelBookingMutation.isPending}
                        className={`flex-1 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2 ${
                          cancelBookingMutation.isPending ? 'opacity-50 cursor-not-allowed' : ''
                        } ${isDark ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-red-600 text-white hover:bg-red-700'}`}
                      >
                        {cancelBookingMutation.isPending ? (
                          <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
                        ) : (
                          <>
                            <span className="material-symbols-outlined text-lg">check</span>
                            Yes, Cancel
                          </>
                        )}
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          </ModalShell>

          {activeTab === 'conference' && memberBayBookingForDay && (
            <div className={`rounded-xl p-3 border ${isDark ? 'bg-amber-500/10 border-amber-500/30' : 'bg-amber-50 border-amber-200'}`}>
              <p className={`text-sm flex items-center gap-2 ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                <span className="material-symbols-outlined text-lg">info</span>
                Time slots during your bay booking ({formatTime12Hour(memberBayBookingForDay.start_time)} - {formatTime12Hour(memberBayBookingForDay.end_time)}) are unavailable
              </p>
            </div>
          )}

          {(!existingDayBooking || activeTab !== 'simulator' || rescheduleBookingId) && !existingBookingCheck?.hasExisting && (activeTab !== 'simulator' || !isAtDailyLimit || rescheduleBookingId) && (
          <>
          <section ref={timeSlotsRef} className="min-h-[120px]">
            <h3 className={`text-sm font-bold uppercase tracking-wider mb-3 pl-1 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Available Times</h3>
            
            {isLoading && (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className={`h-14 rounded-xl animate-pulse ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
                  ))}
                </div>
            )}
              <div className={`transition-opacity duration-300 ${isLoading ? 'opacity-0 hidden' : 'opacity-100'}`}>
              <div className="space-y-2">
                {slotsByHour.map((hourGroup, groupIndex) => {
                  const isExpanded = expandedHour === hourGroup.hour24;
                  const hasSelectedSlot = hourGroup.slots.some(s => selectedSlot?.id === s.id);
                  
                  return (
                    <div 
                      key={hourGroup.hour24}
                      className="animate-slide-up-stagger"
                      style={{ '--stagger-index': groupIndex, animationFillMode: 'both' } as React.CSSProperties}
                    >
                      <button
                        onClick={() => {
                          haptic.light();
                          setExpandedHour(isExpanded ? null : hourGroup.hour24);
                        }}
                        className={`w-full p-4 rounded-xl border text-left transition-all active:scale-[0.99] flex items-center justify-between ${
                          hasSelectedSlot
                            ? 'bg-accent/20 border-accent/50'
                            : isExpanded
                              ? (isDark ? 'glass-card border-white/20 bg-white/10' : 'bg-white border-black/20')
                              : (isDark ? 'glass-card border-white/25 hover:bg-white/5' : 'bg-white border-black/10 hover:bg-black/5 shadow-sm')
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className={`material-symbols-outlined text-xl transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''} ${
                            hasSelectedSlot ? (isDark ? 'text-accent' : 'text-accent') : (isDark ? 'text-white/80' : 'text-primary/80')
                          }`}>
                            chevron_right
                          </span>
                          <div>
                            <div className={`font-bold text-base ${hasSelectedSlot ? (isDark ? 'text-accent' : 'text-[#293515]') : (isDark ? 'text-white' : 'text-primary')}`}>
                              {hourGroup.hourLabel}
                            </div>
                            <div className={`text-[10px] font-bold uppercase tracking-wide ${hasSelectedSlot ? 'text-accent/80' : 'opacity-50'}`}>
                              {hourGroup.slots.length} {hourGroup.slots.length === 1 ? 'time' : 'times'} · {hourGroup.totalAvailable} {activeTab === 'simulator' ? 'bays' : 'rooms'}
                            </div>
                          </div>
                        </div>
                        {hasSelectedSlot && (
                          <span className="material-symbols-outlined text-accent">check_circle</span>
                        )}
                      </button>
                      
                      <div className={`grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 overflow-hidden transition-all duration-300 ease-out ${
                        isExpanded ? 'max-h-[500px] opacity-100 mt-2 pl-6' : 'max-h-0 opacity-0'
                      }`}>
                        {hourGroup.slots.map((slot, slotIndex) => (
                          <button
                            key={slot.id}
                            onClick={() => {
                              haptic.light();
                              setSelectedSlot(slot);
                              setSelectedResource(null);
                            }}
                            aria-pressed={selectedSlot?.id === slot.id}
                            className={`p-3 rounded-xl border text-left transition-all active:scale-[0.98] focus:ring-2 focus:ring-accent focus:outline-none ${
                              selectedSlot?.id === slot.id
                              ? 'bg-accent text-[#293515] border-accent shadow-glow'
                              : (isDark ? 'glass-card text-white hover:bg-white/10 border-white/25' : 'bg-white text-primary hover:bg-black/5 border-black/10 shadow-sm')
                            }`}
                            style={{ '--stagger-index': slotIndex } as React.CSSProperties}
                          >
                            <div className="font-bold text-sm">{slot.start}</div>
                            <div className={`text-[10px] font-bold uppercase tracking-wide ${selectedSlot?.id === slot.id ? 'opacity-80' : 'opacity-40'}`}>
                              {slot.availableResourceDbIds.length} {activeTab === 'simulator' ? 'bays' : 'rooms'}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {slotsByHour.length === 0 && !isLoading && (
                  <div className={`text-center py-8 text-sm rounded-xl border border-dashed ${isDark ? 'text-white/80 glass-card border-white/20' : 'text-primary/80 bg-white border-black/20'}`}>
                    No slots available for this date.
                  </div>
                )}
              </div>
              </div>
          </section>

          {selectedSlot && (
            <section ref={baySelectionRef} className="animate-pop-in">
              <h3 className={`text-sm font-bold uppercase tracking-wider mb-3 pl-1 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                Select {activeTab === 'simulator' ? 'Bay' : 'Room'}
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
                {getAvailableResourcesForSlot(selectedSlot).map((resource, index) => (
                  <div key={resource.id} className="animate-slide-up-stagger" style={{ '--stagger-index': index, animationFillMode: 'both' } as React.CSSProperties}>
                    <ResourceCard
                      resource={resource}
                      selected={selectedResource?.id === resource.id}
                      onClick={() => { haptic.medium(); setSelectedResource(resource); }}
                      isDark={isDark}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          {selectedResource && (
            <section className="animate-pop-in pb-48">
              <h3 className={`text-sm font-bold uppercase tracking-wider mb-3 pl-1 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                Notes for Staff <span className="font-normal opacity-60">(optional)</span>
              </h3>
              <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-white/20 bg-black/20' : 'border-black/10 bg-white'}`}>
                <textarea
                  value={memberNotes}
                  onChange={(e) => setMemberNotes(e.target.value.slice(0, 280))}
                  placeholder="Any special requests or information for staff..."
                  maxLength={280}
                  rows={3}
                  className={`w-full p-4 resize-none focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset ${
                    isDark ? 'bg-transparent text-white placeholder:text-white/40' : 'bg-transparent text-primary placeholder:text-primary/40'
                  }`}
                />
                <div className={`px-4 py-2 text-xs text-right border-t ${isDark ? 'border-white/10 text-white/50' : 'border-black/5 text-primary/50'}`}>
                  {memberNotes.length}/280
                </div>
              </div>
            </section>
          )}
          </>
          )}
        </div>
      )}
        </>
      )}

      {canBook && (
        <div ref={requestButtonRef} className="fixed bottom-24 left-0 right-0 z-20 px-4 sm:px-6 flex flex-col items-center w-full max-w-lg sm:max-w-xl lg:max-w-2xl mx-auto animate-in slide-in-from-bottom-4 duration-300 gap-2">
          {/* Fee Breakdown - show for both simulator and conference room bookings */}
          <div className={`w-full px-3 sm:px-4 py-3 rounded-xl backdrop-blur-md border ${isDark ? 'bg-black/70 border-white/20' : 'bg-white/90 border-black/10 shadow-lg'}`}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`material-symbols-outlined text-lg ${estimatedFees.totalFee > 0 ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-green-400' : 'text-green-600')}`}>receipt_long</span>
              <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Estimated Fees</span>
            </div>
            <div className="space-y-1">
              {estimatedFees.overageFee > 0 && (
                <div className="flex justify-between items-center">
                  <span className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                    {effectiveUser?.tier?.toLowerCase() === 'social' 
                      ? `${activeTab === 'conference' ? 'Conference room' : 'Simulator'} time (${estimatedFees.overageMinutes} min)`
                      : `Your time (${estimatedFees.overageMinutes} min overage)`}
                  </span>
                  <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>${estimatedFees.overageFee}</span>
                </div>
              )}
              {activeTab === 'simulator' && estimatedFees.guestsUsingPasses > 0 && (
                <div className="flex justify-between items-center">
                  <span className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                    {estimatedFees.guestsUsingPasses} guest{estimatedFees.guestsUsingPasses > 1 ? 's' : ''} (using pass{estimatedFees.guestsUsingPasses > 1 ? 'es' : ''})
                  </span>
                  <span className={`text-sm font-semibold ${isDark ? 'text-green-400' : 'text-green-600'}`}>$0</span>
                </div>
              )}
              {activeTab === 'simulator' && estimatedFees.guestsCharged > 0 && (
                <div className="flex justify-between items-center">
                  <span className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                    {estimatedFees.guestsCharged} guest{estimatedFees.guestsCharged > 1 ? 's' : ''} @ $25
                  </span>
                  <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>${estimatedFees.guestFees}</span>
                </div>
              )}
              {activeTab === 'simulator' && estimatedFees.guestCount > 0 && guestPassInfo && (
                <div className="flex justify-between items-center">
                  <span className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                    Passes remaining after booking
                  </span>
                  <span className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                    {estimatedFees.passesRemainingAfter} of {guestPassInfo.passes_total}
                  </span>
                </div>
              )}
              {estimatedFees.totalFee === 0 && (activeTab === 'conference' || estimatedFees.guestCount === 0) && (
                <div className="flex justify-between items-center">
                  <span className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                    Included in your membership
                  </span>
                  <span className={`text-sm font-semibold ${isDark ? 'text-green-400' : 'text-green-600'}`}>No charge</span>
                </div>
              )}
              <div className={`flex justify-between items-center pt-1 border-t ${isDark ? 'border-white/20' : 'border-black/10'}`}>
                <span className={`text-sm font-bold ${isDark ? 'text-white' : 'text-primary'}`}>Total due at check-in</span>
                <span className={`text-base font-bold ${estimatedFees.totalFee > 0 ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-green-400' : 'text-green-600')}`}>${estimatedFees.totalFee}</span>
              </div>
              {estimatedFees.totalFee > 0 && (
                <p className={`text-xs text-center mt-2 ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                  Pay online once booking is confirmed, or at check-in
                </p>
              )}
            </div>
          </div>
          <button 
            onClick={() => { haptic.heavy(); handleConfirm(); }}
            disabled={isBooking}
            className="w-full py-4 rounded-xl font-bold text-lg shadow-glow transition-all flex items-center justify-center gap-2 bg-accent text-[#293515] hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 focus:ring-2 focus:ring-white focus:outline-none"
          >
            {isBooking ? (
              <>
                <WalkingGolferSpinner size="sm" />
                <span>Booking...</span>
              </>
            ) : (
              <>
                <span>{rescheduleBookingId ? 'Request Reschedule' : 'Request Booking'}</span>
                <span className="material-symbols-outlined text-xl">arrow_forward</span>
              </>
            )}
          </button>
        </div>
      )}

      {showConfirmation && (
        <div className="fixed bottom-32 left-0 right-0 z-[60] flex justify-center pointer-events-none">
          <div className={`backdrop-blur-md px-6 py-3 rounded-full shadow-2xl text-sm font-bold flex items-center gap-3 animate-pop-in w-max max-w-[90%] border pointer-events-auto ${isDark ? 'bg-black/80 text-white border-white/25' : 'bg-white/95 text-primary border-black/10'}`}>
            <span className="material-symbols-outlined text-xl text-green-500">schedule_send</span>
            <div>
              <p>{rescheduleBookingId ? 'Reschedule request sent!' : 'Request sent!'}</p>
              <p className="text-[10px] font-normal opacity-80 mt-0.5">Staff will review shortly.</p>
            </div>
          </div>
        </div>
      )}

      {/* View As Confirmation Modal */}
      <ModalShell 
        isOpen={showViewAsConfirm && !!viewAsUser} 
        onClose={() => setShowViewAsConfirm(false)}
        title="Booking on Behalf"
        size="sm"
      >
        {viewAsUser && (
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
                <span className="material-symbols-outlined text-2xl text-amber-500">warning</span>
              </div>
              <div>
                <p className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>View As Mode Active</p>
              </div>
            </div>
            
            <p className={`text-sm mb-6 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
              You're about to make a booking on behalf of <span className="font-bold">{viewAsUser.name}</span>. 
              This booking will appear in their account.
            </p>
            
            <div className="flex gap-3">
              <button 
                onClick={() => setShowViewAsConfirm(false)}
                className={`flex-1 py-3 px-4 rounded-xl font-bold text-sm transition-colors ${isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-black/5 text-primary hover:bg-black/10'}`}
              >
                Cancel
              </button>
              <button 
                onClick={submitBooking}
                className="flex-1 py-3 px-4 rounded-xl font-bold text-sm bg-accent text-brand-green hover:bg-accent/90 transition-colors"
              >
                Confirm Booking
              </button>
            </div>
          </div>
        )}
      </ModalShell>
      
      <ModalShell 
        isOpen={showGuardianConsent} 
        onClose={() => setShowGuardianConsent(false)}
        title="Guardian Consent Required"
      >
        <GuardianConsentForm
          memberName={effectiveUser?.name || 'this member'}
          onSubmit={handleGuardianConsentSubmit}
          onCancel={() => setShowGuardianConsent(false)}
        />
      </ModalShell>
    </SwipeablePage>
    </PullToRefresh>
    </AnimatedPage>
  );
};

const ResourceCard: React.FC<{resource: Resource; selected: boolean; onClick: () => void; isDark?: boolean}> = ({ resource, selected, onClick, isDark = true }) => (
  <button 
    onClick={onClick}
    aria-pressed={selected}
    className={`w-full flex items-center p-4 rounded-xl cursor-pointer transition-all active:scale-[0.98] border text-left focus:ring-2 focus:ring-accent focus:outline-none ${
      selected 
      ? 'bg-accent/10 border-accent ring-1 ring-accent' 
      : (isDark ? 'glass-card hover:bg-white/5 border-white/25' : 'bg-white hover:bg-black/5 border-black/10 shadow-sm')
    }`}
  >
    <div className={`w-12 h-12 rounded-lg flex-shrink-0 flex items-center justify-center mr-4 overflow-hidden ${selected ? 'bg-accent text-[#293515]' : (isDark ? 'bg-white/5 text-white/70' : 'bg-black/5 text-primary/70')}`}>
      <span className="material-symbols-outlined text-2xl">{resource.icon || 'meeting_room'}</span>
    </div>
    
    <div className="flex-1">
      <div className="flex justify-between items-center mb-0.5">
        <span className={`font-bold text-base ${isDark ? 'text-white' : 'text-primary'}`}>{resource.name}</span>
        {resource.badge && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${selected ? 'bg-accent text-[#293515]' : (isDark ? 'bg-white/10 text-white/70' : 'bg-black/10 text-primary/70')}`}>
            {resource.badge}
          </span>
        )}
      </div>
      <p className={`text-xs ${isDark ? 'text-white/80' : 'text-primary/80'}`}>{resource.meta}</p>
    </div>
  </button>
);

export default BookGolf;
