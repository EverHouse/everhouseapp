import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials, putWithCredentials, deleteWithCredentials } from '../../../hooks/queries/useFetch';
import { apiRequestBlob } from '../../../lib/apiRequest';
import { useAuthData } from '../../../contexts/DataContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { usePageReady } from '../../../stores/pageReadyStore';
import { useNavigationLoading } from '../../../stores/navigationLoadingStore';
import { useToast } from '../../../components/Toast';
import { bookingEvents } from '../../../lib/bookingEvents';
import { formatTime12Hour, getTodayString, getNowTimePacific } from '../../../utils/dateUtils';
import { useTierPermissions } from '../../../hooks/useTierPermissions';
import {
  DBBooking, DBBookingRequest, DBRSVP, DBWellnessEnrollment,
  DashboardBookingItem, DashboardRawBooking, DashboardWellnessClass,
  DashboardEvent, GuestPasses, BannerAnnouncement, ConfirmModalState,
  ScheduleItem, formatDate,
} from './dashboardTypes';

export function useDashboardData() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user, actualUser, viewAsUser, isViewingAs } = useAuthData();
  const { effectiveTheme } = useTheme();

  const isAdminViewingAs = actualUser?.role === 'admin' && isViewingAs;
  const viewAsEmail = isAdminViewingAs && viewAsUser?.email ? viewAsUser.email : null;
  const { setPageReady } = usePageReady();
  const { startNavigation } = useNavigationLoading();
  const { showToast } = useToast();
  const isDark = effectiveTheme === 'dark';

  const [_selectedBooking, setSelectedBooking] = useState<DBBooking | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_newDate, setNewDate] = useState<string>('');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_newTime, setNewTime] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [showGuestCheckin, setShowGuestCheckin] = useState(false);
  const [isCardOpen, setIsCardOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [bannerExiting, setBannerExiting] = useState(false);
  const bannerExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (bannerExitTimer.current) clearTimeout(bannerExitTimer.current); }, []);
  const [showPasskeyNudge, setShowPasskeyNudge] = useState(false);
  useEffect(() => {
    const state = location.state as { suggestPasskey?: boolean } | null;
    if (state?.suggestPasskey) {
      setShowPasskeyNudge(true);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);
  const [optimisticCancelledIds, setOptimisticCancelledIds] = useState<Set<number>>(new Set());
  const [walletPassDownloading, setWalletPassDownloading] = useState<number | null>(null);
  const [showFirstLoginModal, setShowFirstLoginModal] = useState(false);
  const firstLoginCheckedRef = useRef(false);
  const [nfcCheckinData, setNfcCheckinData] = useState<{ type: 'success' | 'already_checked_in', memberName: string, tier?: string | null } | null>(() => {
    const stored = sessionStorage.getItem('nfc_checkin_result');
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (e) { console.warn('[Dashboard] Failed to parse NFC checkin data:', e); }
    }
    return null;
  });

  useEffect(() => {
    if (sessionStorage.getItem('nfc_checkin_result') !== null) {
      sessionStorage.removeItem('nfc_checkin_result');
    }
  }, []);

  const isStaffOrAdminProfile = user?.role === 'admin' || user?.role === 'staff';
  const { permissions: tierPermissions } = useTierPermissions(user?.tier);

  const viewAsParam = viewAsEmail ? `?member_email=${encodeURIComponent(viewAsEmail)}` : '';
  const dashboardQueryBase = ['member', 'dashboard', viewAsEmail || user?.email];
  const dashboardQueryOpts = { enabled: !!user?.email, refetchOnWindowFocus: true, staleTime: 300000 };

  const { data: bookingsData, isLoading: bookingsLoading, error: bookingsError } = useQuery({
    queryKey: [...dashboardQueryBase, 'bookings'],
    queryFn: () => fetchWithCredentials<DBBooking[]>(`/api/member/dashboard/bookings${viewAsParam}`),
    ...dashboardQueryOpts,
  });
  const { data: bookingRequestsData, isLoading: bookingRequestsLoading, error: bookingRequestsError } = useQuery({
    queryKey: [...dashboardQueryBase, 'booking-requests'],
    queryFn: () => fetchWithCredentials<DBBookingRequest[]>(`/api/member/dashboard/booking-requests${viewAsParam}`),
    ...dashboardQueryOpts,
  });
  const { data: rsvpsData, isLoading: rsvpsLoading, error: rsvpsError } = useQuery({
    queryKey: [...dashboardQueryBase, 'rsvps'],
    queryFn: () => fetchWithCredentials<DBRSVP[]>(`/api/member/dashboard/rsvps${viewAsParam}`),
    ...dashboardQueryOpts,
  });
  const { data: wellnessData, isLoading: wellnessLoading, error: wellnessError } = useQuery({
    queryKey: [...dashboardQueryBase, 'wellness'],
    queryFn: () => fetchWithCredentials<{ enrollments: DBWellnessEnrollment[]; classes: DashboardWellnessClass[] }>(`/api/member/dashboard/wellness${viewAsParam}`),
    ...dashboardQueryOpts,
  });
  const { data: eventsData } = useQuery({
    queryKey: [...dashboardQueryBase, 'events'],
    queryFn: () => fetchWithCredentials<DashboardEvent[]>(`/api/member/dashboard/events${viewAsParam}`),
    ...dashboardQueryOpts,
  });
  const { data: conferenceRoomData } = useQuery({
    queryKey: [...dashboardQueryBase, 'conference-rooms'],
    queryFn: () => fetchWithCredentials<DashboardBookingItem[]>(`/api/member/dashboard/conference-rooms${viewAsParam}`),
    ...dashboardQueryOpts,
  });
  const { data: statsData } = useQuery({
    queryKey: [...dashboardQueryBase, 'stats'],
    queryFn: () => fetchWithCredentials<{ guestPasses: GuestPasses | null; lifetimeVisitCount: number }>(`/api/member/dashboard/stats${viewAsParam}`),
    enabled: !!user?.email && !isStaffOrAdminProfile,
    refetchOnWindowFocus: true,
    staleTime: 300000,
  });
  const { data: bannerAnnouncementData } = useQuery({
    queryKey: [...dashboardQueryBase, 'announcements'],
    queryFn: () => fetchWithCredentials<BannerAnnouncement | null>(`/api/member/dashboard/announcements${viewAsParam}`),
    ...dashboardQueryOpts,
  });

  const coreScheduleLoading = bookingsLoading || bookingRequestsLoading;
  const initialLoading = coreScheduleLoading && !bookingsData && !bookingRequestsData;
  const isLoading = coreScheduleLoading;

  const dbBookings = useMemo(() => bookingsData ?? [], [bookingsData]);
  const dbRSVPs = useMemo(() => rsvpsData ?? [], [rsvpsData]);
  const dbWellnessEnrollments = useMemo(() => wellnessData?.enrollments ?? [], [wellnessData]);
  const dbBookingRequests = useMemo(() => bookingRequestsData ?? [], [bookingRequestsData]);
  const dbConferenceRoomBookings = useMemo(() => conferenceRoomData ?? [], [conferenceRoomData]);
  const allWellnessClasses = wellnessData?.classes ?? [];
  const allEvents = eventsData ?? [];
  const guestPasses = isStaffOrAdminProfile ? null : statsData?.guestPasses ?? null;
  const bannerAnnouncement = bannerAnnouncementData ?? undefined;

  const { data: walletPassStatus } = useQuery({
    queryKey: ['wallet-pass-status'],
    queryFn: () => fetchWithCredentials<{ available: boolean }>('/api/member/wallet-pass/status'),
    enabled: !isStaffOrAdminProfile && !!user,
    staleTime: 5 * 60 * 1000,
  });
  const walletPassAvailable = walletPassStatus?.available ?? false;

  const scheduleError = !!(bookingsError && bookingRequestsError);
  const error = scheduleError ? 'Failed to load your schedule. Pull down to refresh.' : null;
  const rsvpSectionError = rsvpsError && !rsvpsData;
  const wellnessSectionError = wellnessError && !wellnessData;

  const refetchAllData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['member', 'dashboard'] });
  }, [queryClient]);

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  useEffect(() => {
    const unsubscribe = bookingEvents.subscribe(() => {
      refetchAllData();
    });
    return unsubscribe;
  }, [refetchAllData]);

  useEffect(() => {
    const handleMemberStatsUpdated = (event: CustomEvent) => {
      const detail = event.detail;
      if (detail?.memberEmail?.toLowerCase() === user?.email?.toLowerCase() && (detail?.guestPasses !== undefined || detail?.lifetimeVisits !== undefined)) {
        queryClient.invalidateQueries({ queryKey: ['member', 'dashboard', viewAsEmail || user?.email, 'stats'] });
      }
    };

    window.addEventListener('member-stats-updated', handleMemberStatsUpdated as EventListener);
    return () => window.removeEventListener('member-stats-updated', handleMemberStatsUpdated as EventListener);
  }, [user?.email, queryClient, viewAsEmail]);

  const isBannerInitiallyDismissed = useMemo(() => {
    if (user?.email && bannerAnnouncement) {
      const dismissedKey = `eh_banner_dismissed_${user.email}`;
      const dismissedId = localStorage.getItem(dismissedKey);
      return bannerAnnouncement.id === dismissedId;
    }
    return false;
  }, [user?.email, bannerAnnouncement]);

  useEffect(() => {
    if (!user?.email || firstLoginCheckedRef.current) return;
    firstLoginCheckedRef.current = true;

    const localKey = `eh_first_login_shown_${user.email}`;
    if (localStorage.getItem(localKey)) return;

    (async () => {
      try {
        const data = await fetchWithCredentials<Record<string, unknown>>('/api/member/onboarding');

        if (data.firstLoginAt || data.onboardingCompletedAt || data.isDismissed) {
          localStorage.setItem(localKey, 'true');
          return;
        }

        const joinOrCreated = data.joinDate || data.createdAt;
        if (joinOrCreated) {
          const age = Date.now() - new Date(joinOrCreated as string).getTime();
          if (age > 7 * 24 * 60 * 60 * 1000) {
            localStorage.setItem(localKey, 'true');
            return;
          }
        }

        localStorage.setItem(localKey, 'true');

        postWithCredentials('/api/member/onboarding/complete-step', { step: 'first_login' }).catch(err => console.error('[Dashboard] Failed to complete onboarding step:', err));

        queueMicrotask(() => setShowFirstLoginModal(true));
      } catch {
        const key = `eh_first_login_shown_${user?.email}`;
        if (!localStorage.getItem(key)) {
          localStorage.setItem(key, 'true');
          queueMicrotask(() => setShowFirstLoginModal(true));
        }
      }
    })();
  }, [user?.email]);

  useEffect(() => {
    const handleCheckinNotification = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const isCheckinNotification = detail?.data?.notificationType === 'booking' && 
        (detail?.title === 'Check-In Complete' || detail?.title === 'Checked In');
      if (isCheckinNotification) {
        setIsCardOpen(false);
        setNfcCheckinData({
          type: 'success',
          memberName: user?.firstName || (user?.name && !user.name.includes('@') ? user.name.split(' ')[0] : null) || 'Member',
          tier: user?.tier || null,
        });
      }
    };
    window.addEventListener('member-notification', handleCheckinNotification);
    return () => window.removeEventListener('member-notification', handleCheckinNotification);
  }, [user?.name, user?.tier, user?.firstName]);

  const userEmail = user?.email;
  const allItems: ScheduleItem[] = useMemo(() => [
    ...dbBookings.map(b => {
      const isLinkedMember = userEmail ? b.user_email?.toLowerCase() !== userEmail.toLowerCase() : false;
      const primaryBookerName = isLinkedMember && b.user_email 
        ? b.user_email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        : null;
      return {
        id: `booking-${b.id}`,
        dbId: b.id,
        type: 'booking' as const,
        title: b.resource_name || 'Booking',
        resourceType: b.resource_type || 'simulator',
        date: formatDate(b.booking_date),
        rawDate: b.booking_date.split('T')[0],
        time: formatTime12Hour(b.start_time),
        endTime: formatTime12Hour(b.end_time),
        details: `${formatTime12Hour(b.start_time)} - ${formatTime12Hour(b.end_time)}`,
        sortKey: `${b.booking_date}T${b.start_time}`,
        status: b.status,
        isLinkedMember,
        primaryBookerName,
        raw: b
      };
    }),
    ...dbBookingRequests
      .filter(r => ['pending', 'pending_approval', 'approved', 'confirmed', 'attended', 'cancellation_pending'].includes(r.status))
      .filter(r => !dbBookings.some(b => b.id === r.id))
      .map(r => {
      const timeDetails = `${formatTime12Hour(r.start_time)} - ${formatTime12Hour(r.end_time)}`;
      const linkedInfo = r.is_linked_member && r.primary_booker_name 
        ? ` • Booked by ${r.primary_booker_name.split(' ')[0]}` 
        : '';
      return {
        id: `request-${r.id}`,
        dbId: r.id,
        type: 'booking_request' as const,
        title: r.resource_name || r.bay_name || (r.notes?.includes('Conference room') ? 'Conference Room' : 'Simulator'),
        resourceType: r.notes?.includes('Conference room') ? 'conference_room' : 'simulator',
        date: formatDate(r.request_date),
        rawDate: r.request_date.split('T')[0],
        time: formatTime12Hour(r.start_time),
        endTime: formatTime12Hour(r.end_time),
        details: `${timeDetails}${linkedInfo}`,
        sortKey: `${r.request_date}T${r.start_time}`,
        status: r.status,
        isLinkedMember: r.is_linked_member || false,
        primaryBookerName: r.primary_booker_name,
        raw: r
      };
    }),
    ...dbRSVPs.map(r => ({
      id: `rsvp-${r.id}`,
      dbId: r.id,
      type: 'rsvp' as const,
      title: r.title || 'Event',
      resourceType: 'event',
      date: formatDate(r.event_date),
      rawDate: r.event_date.split('T')[0],
      time: formatTime12Hour(r.start_time),
      endTime: r.end_time ? formatTime12Hour(r.end_time) : '',
      details: r.location || '',
      sortKey: `${r.event_date}T${r.start_time}`,
      raw: r
    })),
    ...dbWellnessEnrollments.map(w => {
      const durationMin = parseInt(w.duration, 10) || 60;
      const [hh, mm] = w.time.substring(0, 5).split(':').map(Number);
      const endTotalMin = hh * 60 + mm + durationMin;
      const endH = Math.floor(endTotalMin / 60) % 24;
      const endM = endTotalMin % 60;
      const wellnessEndTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
      return {
      id: `wellness-${w.id}`,
      dbId: w.id,
      classId: w.class_id,
      type: 'wellness' as const,
      title: w.title || 'Wellness Class',
      resourceType: 'wellness_class',
      date: formatDate(w.date),
      rawDate: w.date.split('T')[0],
      time: formatTime12Hour(w.time),
      endTime: formatTime12Hour(wellnessEndTime),
      details: `${w.category} with ${w.instructor}`,
      sortKey: `${w.date}T${w.time}`,
      raw: w
    };
    }),
    ...dbConferenceRoomBookings
      .filter(c => {
        const isDuplicate = dbBookingRequests.some(r => 
          r.calendar_event_id === c.calendar_event_id && 
          ['pending', 'pending_approval', 'approved', 'confirmed', 'attended'].includes(r.status)
        );
        return !isDuplicate;
      })
      .map(c => ({
        id: c.id,
        dbId: c.id as unknown as number,
        type: 'conference_room_calendar' as const,
        title: 'Conference Room',
        resourceType: 'conference_room',
        date: formatDate(c.request_date || ''),
        rawDate: (c.request_date || '').split('T')[0],
        time: formatTime12Hour(c.start_time || ''),
        endTime: formatTime12Hour(c.end_time || ''),
        details: `${formatTime12Hour(c.start_time || '')} - ${formatTime12Hour(c.end_time || '')}`,
        sortKey: `${c.request_date || ''}T${c.start_time || ''}`,
        raw: c,
        source: 'calendar'
      }))
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey)), [dbBookings, dbBookingRequests, dbRSVPs, dbWellnessEnrollments, dbConferenceRoomBookings, userEmail]);

  const todayStr = getTodayString();
  const nowTime = getNowTimePacific();

  const normalizeTime = (t: string) => {
    if (!t) return '';
    const parts = t.split(':');
    return `${parts[0].padStart(2, '0')}:${parts[1]?.padStart(2, '0') || '00'}`;
  };

  const upcomingItems = allItems.filter(item => {
    let itemDate: string | undefined;
    let endTime: string | undefined;

    if (item.type === 'booking') {
      const raw = item.raw as DBBooking;
      itemDate = raw.booking_date.split('T')[0];
      endTime = raw.end_time;
    } else if (item.type === 'booking_request') {
      const raw = item.raw as DBBookingRequest;
      itemDate = raw.request_date.split('T')[0];
      endTime = raw.end_time;
    } else if (item.type === 'rsvp') {
      const raw = item.raw as DBRSVP;
      itemDate = raw.event_date.split('T')[0];
      endTime = raw.end_time;
    } else if (item.type === 'wellness') {
      const raw = item.raw as DBWellnessEnrollment;
      itemDate = raw.date.split('T')[0];
      endTime = undefined;
    } else if (item.type === 'conference_room_calendar') {
      const raw = item.raw as DashboardRawBooking;
      itemDate = (raw.request_date || '').split('T')[0];
      endTime = raw.end_time;
    }

    if (!itemDate) return false;
    if (itemDate > todayStr) return true;
    if (itemDate < todayStr) return false;
    if (endTime && normalizeTime(endTime) < nowTime) {
      return false;
    }
    return true;
  });

  const todayBookingsAll = allItems.filter(item => 
    item.rawDate === todayStr && 
    (item.type === 'booking' || item.type === 'booking_request' || item.type === 'conference_room_calendar')
  );
  const simMinutesToday = todayBookingsAll
    .filter(b => b.resourceType === 'simulator')
    .reduce((sum, b) => {
      const raw = b.raw as DashboardRawBooking;
      const start = raw.start_time?.split(':').map(Number) || [0, 0];
      const end = raw.end_time?.split(':').map(Number) || [0, 0];
      const totalMinutes = (end[0] * 60 + end[1]) - (start[0] * 60 + start[1]);
      const playerCount = raw.declared_player_count || 1;
      const memberShare = Math.ceil(totalMinutes / playerCount);
      return sum + memberShare;
    }, 0);
  const confMinutesToday = todayBookingsAll
    .filter(b => b.resourceType === 'conference_room')
    .reduce((sum, b) => {
      const raw = b.raw as DashboardRawBooking;
      const start = raw.start_time?.split(':').map(Number) || [0, 0];
      const end = raw.end_time?.split(':').map(Number) || [0, 0];
      const totalMinutes = (end[0] * 60 + end[1]) - (start[0] * 60 + start[1]);
      const playerCount = raw.declared_player_count || 1;
      const memberShare = Math.ceil(totalMinutes / playerCount);
      return sum + memberShare;
    }, 0);

  const nextEvent = allEvents
    .filter(e => e.event_date.split('T')[0] >= todayStr)
    .sort((a, b) => a.event_date.localeCompare(b.event_date) || (a.start_time || '').localeCompare(b.start_time || ''))
    [0];
  const nextWellnessClass = allWellnessClasses
    .filter(w => w.date.split('T')[0] >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''))
    [0];

  const upcomingItemsFiltered = upcomingItems.filter(item => {
    if (item.type === 'booking_request' || item.type === 'booking') {
      const raw = item.raw as DBBookingRequest;
      if (raw) {
        if (optimisticCancelledIds.has(raw.id)) {
          return false;
        }
      }
    }
    return true;
  });

  const upcomingBookings = upcomingItemsFiltered.filter(item => item.type === 'booking' || item.type === 'booking_request' || item.type === 'conference_room_calendar');
  const _upcomingEventsWellness = upcomingItemsFiltered.filter(item => item.type === 'rsvp' || item.type === 'wellness');

  const _nextBooking = upcomingBookings[0];
  const _nextItem = upcomingItemsFiltered[0];
  const _laterItems = upcomingItemsFiltered.slice(1);

  const cancelBookingMutation = useMutation({
    mutationFn: async ({ bookingId, bookingType }: { bookingId: number; bookingType: 'booking' | 'booking_request' }) => {
      const endpoint = bookingType === 'booking'
        ? `/api/bookings/${bookingId}/member-cancel`
        : `/api/booking-requests/${bookingId}/member-cancel`;
      const data = await putWithCredentials<Record<string, unknown>>(endpoint, isAdminViewingAs ? { acting_as_email: user?.email } : {});
      return { bookingId, data };
    },
    onMutate: async ({ bookingId }) => {
      setOptimisticCancelledIds(prev => new Set(prev).add(bookingId));
      setSelectedBooking(null);
    },
    onSuccess: ({ bookingId, data }) => {
      if (data.status === 'cancellation_pending') {
        setOptimisticCancelledIds(prev => {
          const next = new Set(prev);
          next.delete(bookingId);
          return next;
        });
        showToast('Cancellation request submitted. You\'ll be notified when it\'s complete.', 'success');
      } else {
        showToast('Booking cancelled successfully', 'success');
      }
      refetchAllData();
    },
    onError: (error: Error, { bookingId }) => {
      setOptimisticCancelledIds(prev => {
        const next = new Set(prev);
        next.delete(bookingId);
        return next;
      });
      showToast(error.message || 'Failed to cancel booking', 'error');
    },
  });

  const handleCancelBooking = (bookingId: number, bookingType: 'booking' | 'booking_request') => {
    setConfirmModal({
      isOpen: true,
      title: "Cancel Booking",
      message: "Are you sure you want to cancel this booking?",
      onConfirm: () => {
        setConfirmModal(null);
        cancelBookingMutation.mutate({ bookingId, bookingType });
      }
    });
  };

  const handleLeaveBooking = (bookingId: number, primaryBookerName?: string | null) => {
    if (!user?.email) return;

    setConfirmModal({
      isOpen: true,
      title: "Leave Booking",
      message: `Are you sure you want to leave this booking${primaryBookerName ? ` with ${primaryBookerName}` : ''}? You will be removed from the player list.`,
      onConfirm: async () => {
        setConfirmModal(null);

        try {
          const participantsData = await fetchWithCredentials<{ participants: Array<{ user_email?: string; id?: number }> }>(`/api/bookings/${bookingId}/participants`);
          const participants = participantsData.participants || [];

          const myParticipant = participants.find((p: { user_email?: string }) => 
            p.user_email?.toLowerCase() === user.email.toLowerCase()
          );

          if (!myParticipant) {
            showToast('Could not find your participant record', 'error');
            return;
          }

          const body = isAdminViewingAs && user?.email ? { onBehalfOf: user.email } : {};
          await fetchWithCredentials(`/api/bookings/${bookingId}/participants/${myParticipant.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          showToast('You have left the booking', 'success');
          refetchAllData();
        } catch (_err: unknown) {
          showToast('Failed to leave booking', 'error');
        }
      }
    });
  };

  const handleCancelRSVP = (eventId: number) => {
    if (!user?.email) return;

    setConfirmModal({
      isOpen: true,
      title: "Cancel RSVP",
      message: "Are you sure you want to cancel your RSVP?",
      onConfirm: async () => {
        setConfirmModal(null);

        try {
          await deleteWithCredentials(`/api/rsvps/${eventId}/${encodeURIComponent(user.email)}`);
          showToast('RSVP cancelled', 'success');
          refetchAllData();
        } catch (_err: unknown) {
          showToast('Failed to cancel RSVP', 'error');
        }
      }
    });
  };

  const handleCancelWellness = (classId: number) => {
    if (!user?.email) return;

    setConfirmModal({
      isOpen: true,
      title: "Cancel Enrollment",
      message: "Are you sure you want to cancel this enrollment?",
      onConfirm: async () => {
        setConfirmModal(null);

        try {
          await deleteWithCredentials(`/api/wellness-enrollments/${classId}/${encodeURIComponent(user.email)}`);
          showToast('Enrollment cancelled', 'success');
          refetchAllData();
        } catch (_err: unknown) {
          showToast('Failed to cancel enrollment', 'error');
        }
      }
    });
  };

  const isAppleDevice = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent;
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }, []);

  const handleDownloadBookingWalletPass = async (bookingId: number) => {
    setWalletPassDownloading(bookingId);
    try {
      const response = await apiRequestBlob(`/api/member/booking-wallet-pass/${bookingId}`);
      if (!response.ok || !response.blob) throw new Error(response.error || 'Failed to download');
      const url = URL.createObjectURL(response.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `EverClub-Booking-${bookingId}.pkpass`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Wallet pass downloaded — open it to add to Apple Wallet', 'success', 5000);
    } catch {
      showToast('Failed to download booking wallet pass', 'error');
    } finally {
      setWalletPassDownloading(null);
    }
  };

  return {
    navigate,
    queryClient,
    user,
    isDark,
    isStaffOrAdminProfile,
    tierPermissions,
    startNavigation,
    showToast,
    isAdminViewingAs,

    confirmModal, setConfirmModal,
    showGuestCheckin, setShowGuestCheckin,
    isCardOpen, setIsCardOpen,
    bannerDismissed, setBannerDismissed,
    bannerExiting, setBannerExiting,
    bannerExitTimer,
    showPasskeyNudge, setShowPasskeyNudge,
    walletPassDownloading,
    showFirstLoginModal, setShowFirstLoginModal,
    nfcCheckinData, setNfcCheckinData,

    coreScheduleLoading,
    initialLoading,
    isLoading,
    error,
    rsvpSectionError,
    wellnessSectionError,

    guestPasses,
    bannerAnnouncement,
    isBannerInitiallyDismissed,
    walletPassAvailable,
    statsData,

    simMinutesToday,
    confMinutesToday,
    nextEvent,
    nextWellnessClass,
    upcomingItemsFiltered,

    isAppleDevice,

    refetchAllData,
    handleCancelBooking,
    handleLeaveBooking,
    handleCancelRSVP,
    handleCancelWellness,
    handleDownloadBookingWalletPass,
  };
}
