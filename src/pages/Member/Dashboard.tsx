import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../hooks/queries/useFetch';
import { useData, Booking } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';
import { useToast } from '../../components/Toast';
import { bookingEvents } from '../../lib/bookingEvents';
import ScheduleCard from '../../components/ScheduleCard';
import OnboardingChecklist from '../../components/OnboardingChecklist';
import { formatDateShort, getTodayString, getPacificHour, CLUB_TIMEZONE, formatDateTimePacific, formatMemberSince, formatTime12Hour, getNowTimePacific } from '../../utils/dateUtils';
import { downloadICalFile } from '../../utils/icalUtils';
import { DashboardSkeleton } from '../../components/skeletons';
import { SmoothReveal } from '../../components/motion/SmoothReveal';
import { getBaseTier } from '../../utils/permissions';
import { getTierColor } from '../../utils/tierUtils';
import { getStatusBadge as getStatusBadgeColor, formatStatusLabel } from '../../utils/statusColors';
import TierBadge from '../../components/TierBadge';
import HubSpotFormModal from '../../components/HubSpotFormModal';
import { useTierPermissions } from '../../hooks/useTierPermissions';
import AnnouncementAlert from '../../components/AnnouncementAlert';
import ClosureAlert from '../../components/ClosureAlert';
import ErrorState from '../../components/ErrorState';
import ModalShell from '../../components/ModalShell';
import MetricsGrid from '../../components/MetricsGrid';
import { RosterManager } from '../../components/booking';
import { apiRequest } from '../../lib/apiRequest';
import { AnimatedPage } from '../../components/motion';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import FirstLoginWelcomeModal from '../../components/FirstLoginWelcomeModal';
import NfcCheckinWelcomeModal from '../../components/NfcCheckinWelcomeModal';

const GUEST_CHECKIN_FIELDS = [
  { name: 'guest_firstname', label: 'Guest First Name', type: 'text' as const, required: true, placeholder: 'John' },
  { name: 'guest_lastname', label: 'Guest Last Name', type: 'text' as const, required: true, placeholder: 'Smith' },
  { name: 'guest_email', label: 'Guest Email', type: 'email' as const, required: true, placeholder: 'john@example.com' },
  { name: 'guest_phone', label: 'Guest Phone', type: 'tel' as const, required: false, placeholder: '(555) 123-4567' }
];


interface DBBooking {
  id: number;
  resource_id: number;
  resource_name?: string;
  resource_type?: string;
  user_email: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  notes: string;
  declared_player_count?: number;
}

interface DBEvent {
  id: number;
  title: string;
  description: string;
  event_date: string;
  start_time: string;
  end_time: string;
  location: string;
  category: string;
}

interface DBRSVP {
  id: number;
  event_id: number;
  status: string;
  title: string;
  event_date: string;
  start_time: string;
  end_time?: string;
  location: string;
  category: string;
}

interface DBWellnessEnrollment {
  id: number;
  class_id: number;
  user_email: string;
  status: string;
  title: string;
  date: string;
  time: string;
  instructor: string;
  duration: string;
  category: string;
}

interface DBBookingRequest {
  id: number;
  user_email: string;
  user_name: string | null;
  resource_id: number | null;
  resource_name?: string | null;
  bay_name: string | null;
  resource_preference: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  notes: string | null;
  status: 'pending' | 'approved' | 'confirmed' | 'attended' | 'no_show' | 'declined' | 'cancelled' | 'cancellation_pending';
  staff_notes: string | null;
  suggested_time: string | null;
  created_at: string;
  calendar_event_id?: string | null;
  is_linked_member?: boolean;
  primary_booker_name?: string | null;
  declared_player_count?: number;
}

interface GuestPasses {
  passes_used: number;
  passes_total: number;
  passes_remaining: number;
}

interface BannerAnnouncement {
  id: string;
  title: string;
  desc: string;
  linkType?: string;
  linkTarget?: string;
}

interface DashboardData {
  bookings: DBBooking[];
  rsvps: DBRSVP[];
  wellnessEnrollments: DBWellnessEnrollment[];
  bookingRequests: DBBookingRequest[];
  conferenceRoomBookings: DashboardBookingItem[];
  wellnessClasses: { id: number; title: string; date: string; time: string }[];
  events: { id: number; title: string; event_date: string; start_time: string }[];
  guestPasses: GuestPasses | null;
  bannerAnnouncement: BannerAnnouncement | null;
}

const formatDate = (dateStr: string): string => {
  return formatDateShort(dateStr);
};


interface DashboardBookingItem {
  id: number | string;
  resource_name?: string;
  bay_name?: string;
  request_date?: string;
  start_time?: string;
  end_time?: string;
  status?: string;
  user_email?: string;
  user_name?: string;
  resource_id?: number;
  resource_type?: string;
  isLinkedMember?: boolean;
  primaryBookerName?: string;
  declared_player_count?: number;
  notes?: string;
  calendar_event_id?: string | null;
}

interface DashboardRawBooking {
  booking_id?: number;
  request_date?: string;
  start_time?: string;
  end_time?: string;
  bay_name?: string;
  resource_name?: string;
  resource_type?: string;
  status?: string;
  declared_player_count?: number;
}


const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, actualUser, viewAsUser, isViewingAs, addBooking, deleteBooking } = useData();
  const { effectiveTheme } = useTheme();
  
  const isAdminViewingAs = actualUser?.role === 'admin' && isViewingAs;
  // For View As mode, use the viewed member's email for API calls
  const viewAsEmail = isAdminViewingAs && viewAsUser?.email ? viewAsUser.email : null;
  const { setPageReady } = usePageReady();
  const { startNavigation } = useNavigationLoading();
  const { showToast } = useToast();
  const isDark = effectiveTheme === 'dark';
  
  const [selectedBooking, setSelectedBooking] = useState<DBBooking | null>(null);
  const [newDate, setNewDate] = useState<string>('');
  const [newTime, setNewTime] = useState<string | null>(null);
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; title: string; message: string; onConfirm: () => void } | null>(null);
  const [showGuestCheckin, setShowGuestCheckin] = useState(false);
  const [isCardOpen, setIsCardOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // Optimistic UI state
  const [optimisticCancellingIds, setOptimisticCancellingIds] = useState<Set<number>>(new Set());
  const [optimisticCancelledIds, setOptimisticCancelledIds] = useState<Set<number>>(new Set());
  const [scheduleRef] = useAutoAnimate();
  const [showFirstLoginModal, setShowFirstLoginModal] = useState(false);
  const [nfcCheckinData, setNfcCheckinData] = useState<{ type: 'success' | 'already_checked_in', memberName: string, tier?: string | null } | null>(null);

  const isStaffOrAdminProfile = user?.role === 'admin' || user?.role === 'staff';
  const { permissions: tierPermissions } = useTierPermissions(user?.tier);

  // Combined dashboard data query - replaces 9 separate API calls
  // When admin is in "View As" mode, include member_email param to fetch that member's data
  const dashboardUrl = viewAsEmail 
    ? `/api/member/dashboard-data?member_email=${encodeURIComponent(viewAsEmail)}`
    : '/api/member/dashboard-data';
  
  const { data: dashboardData, isLoading, error: dashboardError, refetch: refetchDashboardData } = useQuery({
    queryKey: ['member', 'dashboard-data', viewAsEmail || user?.email],
    queryFn: () => fetchWithCredentials<DashboardData>(dashboardUrl),
    enabled: !!user?.email,
    refetchOnWindowFocus: true,
    staleTime: 300000, // 5 minutes - makes returning to dashboard instant
  });

  // Extract individual data with fallbacks
  const dbBookings = dashboardData?.bookings ?? [];
  const dbRSVPs = dashboardData?.rsvps ?? [];
  const dbWellnessEnrollments = dashboardData?.wellnessEnrollments ?? [];
  const dbBookingRequests = dashboardData?.bookingRequests ?? [];
  const dbConferenceRoomBookings = dashboardData?.conferenceRoomBookings ?? [];
  const allWellnessClasses = dashboardData?.wellnessClasses ?? [];
  const allEvents = dashboardData?.events ?? [];
  const guestPasses = isStaffOrAdminProfile ? null : dashboardData?.guestPasses;
  const bannerAnnouncement = dashboardData?.bannerAnnouncement;
  
  const error = dashboardError ? 'Failed to load dashboard data. Pull down to refresh.' : null;

  const refetchAllData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['member', 'dashboard-data'] });
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
        queryClient.invalidateQueries({ queryKey: ['member', 'dashboard-data'] });
      }
    };

    window.addEventListener('member-stats-updated', handleMemberStatsUpdated as EventListener);
    return () => window.removeEventListener('member-stats-updated', handleMemberStatsUpdated as EventListener);
  }, [user?.email, queryClient]);

  useEffect(() => {
    if (user?.email && bannerAnnouncement) {
      const dismissedKey = `eh_banner_dismissed_${user.email}`;
      const dismissedId = localStorage.getItem(dismissedKey);
      if (bannerAnnouncement.id === dismissedId) {
        setBannerDismissed(true);
      }
    }
  }, [user?.email, bannerAnnouncement]);

  useEffect(() => {
    if (user?.email) {
      const key = `eh_first_login_shown_${user.email}`;
      if (!localStorage.getItem(key)) {
        setShowFirstLoginModal(true);
        localStorage.setItem(key, 'true');
      }
    }
  }, [user?.email]);

  useEffect(() => {
    const stored = sessionStorage.getItem('nfc_checkin_result');
    if (stored) {
      sessionStorage.removeItem('nfc_checkin_result');
      try {
        const data = JSON.parse(stored);
        setNfcCheckinData(data);
      } catch {}
    }
  }, []);

  useEffect(() => {
    const handleCheckinNotification = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const isCheckinNotification = detail?.data?.notificationType === 'booking' && 
        (detail?.title === 'Check-In Complete' || detail?.title === 'Checked In');
      if (isCheckinNotification) {
        setIsCardOpen(false);
        setNfcCheckinData({
          type: 'success',
          memberName: user?.name?.split(' ')[0] || user?.name || 'Member',
          tier: user?.tier || null,
        });
      }
    };
    window.addEventListener('member-notification', handleCheckinNotification);
    return () => window.removeEventListener('member-notification', handleCheckinNotification);
  }, [user?.name, user?.tier]);

  const allItems = [
    ...dbBookings.map(b => {
      const isLinkedMember = user?.email ? b.user_email?.toLowerCase() !== user.email.toLowerCase() : false;
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
      const durationMin = parseInt(w.duration) || 60;
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
        dbId: c.id,
        type: 'conference_room_calendar' as const,
        title: 'Conference Room',
        resourceType: 'conference_room',
        date: formatDate(c.request_date),
        rawDate: c.request_date.split('T')[0],
        time: formatTime12Hour(c.start_time),
        endTime: formatTime12Hour(c.end_time),
        details: `${formatTime12Hour(c.start_time)} - ${formatTime12Hour(c.end_time)}`,
        sortKey: `${c.request_date}T${c.start_time}`,
        raw: c,
        source: 'calendar'
      }))
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

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
      itemDate = raw.request_date.split('T')[0];
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
  const upcomingEventsWellness = upcomingItemsFiltered.filter(item => item.type === 'rsvp' || item.type === 'wellness');

  const nextBooking = upcomingBookings[0];
  
  const nextItem = upcomingItemsFiltered[0];
  const laterItems = upcomingItemsFiltered.slice(1);

  const getIconForType = (type: string) => {
    switch(type) {
      case 'simulator': return 'sports_golf';
      case 'conference_room': return 'meeting_room';
      case 'wellness_room': return 'spa';
      case 'wellness_class': return 'self_improvement';
      case 'event': return 'celebration';
      default: return 'event';
    }
  };

  const handleCancelBooking = (bookingId: number, bookingType: 'booking' | 'booking_request') => {
    setConfirmModal({
      isOpen: true,
      title: "Cancel Booking",
      message: "Are you sure you want to cancel this booking?",
      onConfirm: async () => {
        setConfirmModal(null);
        
        // Optimistic UI: immediately show cancelling state
        setOptimisticCancellingIds(prev => new Set(prev).add(bookingId));
        
        try {
          let res;
          const headers = { 'Content-Type': 'application/json' };
          
          if (bookingType === 'booking') {
            res = await fetch(`/api/bookings/${bookingId}/member-cancel`, {
              method: 'PUT',
              headers,
              credentials: 'include',
              body: JSON.stringify(isAdminViewingAs ? { acting_as_email: user?.email } : {})
            });
          } else {
            res = await fetch(`/api/booking-requests/${bookingId}/member-cancel`, {
              method: 'PUT',
              headers,
              credentials: 'include',
              body: JSON.stringify(isAdminViewingAs ? { acting_as_email: user?.email } : {})
            });
          }

          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            
            setOptimisticCancellingIds(prev => {
              const next = new Set(prev);
              next.delete(bookingId);
              return next;
            });
            
            if (data.status === 'cancellation_pending') {
              showToast('Cancellation request submitted. You\'ll be notified when it\'s complete.', 'success');
              refetchAllData();
            } else {
              setOptimisticCancelledIds(prev => new Set(prev).add(bookingId));
              setSelectedBooking(null);
              deleteBooking(String(bookingId));
              showToast('Booking cancelled successfully', 'success');
              refetchAllData();
            }
          } else {
            // Revert optimistic state on failure
            setOptimisticCancellingIds(prev => {
              const next = new Set(prev);
              next.delete(bookingId);
              return next;
            });
            const data = await res.json().catch(() => ({}));
            showToast(data.error || 'Failed to cancel booking', 'error');
          }
        } catch (err: unknown) {
          // Revert optimistic state on error
          setOptimisticCancellingIds(prev => {
            const next = new Set(prev);
            next.delete(bookingId);
            return next;
          });
          showToast('Failed to cancel booking', 'error');
        }
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
          const participantsRes = await fetch(`/api/bookings/${bookingId}/participants`, { credentials: 'include' });
          if (!participantsRes.ok) {
            showToast('Failed to get booking details', 'error');
            return;
          }
          
          const participantsData = await participantsRes.json();
          const participants = participantsData.participants || [];
          
          const myParticipant = participants.find((p: { user_email?: string }) => 
            p.user_email?.toLowerCase() === user.email.toLowerCase()
          );
          
          if (!myParticipant) {
            showToast('Could not find your participant record', 'error');
            return;
          }
          
          const body = isAdminViewingAs && user?.email ? { onBehalfOf: user.email } : {};
          const res = await fetch(`/api/bookings/${bookingId}/participants/${myParticipant.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body)
          });
          
          if (res.ok) {
            showToast('You have left the booking', 'success');
            refetchAllData();
          } else {
            const data = await res.json().catch(() => ({}));
            showToast(data.error || 'Failed to leave booking', 'error');
          }
        } catch (err: unknown) {
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
          const res = await fetch(`/api/rsvps/${eventId}/${encodeURIComponent(user.email)}`, {
            method: 'DELETE',
            credentials: 'include'
          });
          if (res.ok) {
            showToast('RSVP cancelled', 'success');
            refetchAllData();
          } else {
            showToast('Failed to cancel RSVP', 'error');
          }
        } catch (err: unknown) {
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
          const res = await fetch(`/api/wellness-enrollments/${classId}/${encodeURIComponent(user.email)}`, {
            method: 'DELETE',
            credentials: 'include'
          });
          if (res.ok) {
            showToast('Enrollment cancelled', 'success');
            refetchAllData();
          } else {
            showToast('Failed to cancel enrollment', 'error');
          }
        } catch (err: unknown) {
          showToast('Failed to cancel enrollment', 'error');
        }
      }
    });
  };

  const getGreeting = () => {
    const hour = getPacificHour();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const getTierBadgeStyle = (tier: string | undefined) => {
    const t = (tier || '').toLowerCase();
    if (t === 'vip' || t === 'premium') {
      return 'bg-amber-400 text-amber-900';
    } else if (t === 'core') {
      return 'bg-brand-green text-white';
    }
    return 'bg-gray-400 text-gray-900';
  };

  if (error) {
    return (
      <div 
        className="px-6 pb-32 min-h-screen bg-transparent"
        style={{ marginTop: 'calc(-1 * var(--header-offset))', paddingTop: 'calc(var(--header-offset) + 1rem)' }}
      >
        <ErrorState
          title="Unable to load dashboard"
          message={error}
          onRetry={() => refetchAllData()}
        />
      </div>
    );
  }

  return (
    <AnimatedPage>
    <SmoothReveal isLoaded={!isLoading}>
    <div 
      className="min-h-screen flex flex-col"
      style={{ marginTop: 'calc(-1 * var(--header-offset))', paddingTop: 'var(--header-offset)' }}
    >
    {isLoading ? (
      <DashboardSkeleton isDark={isDark} />
    ) : (
    <>
    <div className="flex-1 flex flex-col">
      <div className="px-6 lg:px-8 xl:px-12 pt-4 md:pt-2 pb-32 font-sans relative flex-1">
        <ClosureAlert />
        <AnnouncementAlert />
        
        {bannerAnnouncement && !bannerDismissed && (
          <div className={`mb-4 py-3 px-4 rounded-xl flex items-start justify-between gap-3 animate-pop-in ${isDark ? 'bg-lavender/20 border border-lavender/30' : 'bg-lavender/30 border border-lavender/40'}`}>
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <span className={`material-symbols-outlined text-xl flex-shrink-0 mt-0.5 ${isDark ? 'text-lavender' : 'text-primary'}`}>campaign</span>
              <div className="min-w-0 flex-1">
                <h4 className={`font-bold text-sm ${isDark ? 'text-white' : 'text-primary'}`}>{bannerAnnouncement.title}</h4>
                {bannerAnnouncement.desc && (
                  <p className={`text-xs mt-0.5 line-clamp-2 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>{bannerAnnouncement.desc}</p>
                )}
                <button
                  onClick={() => {
                    if (bannerAnnouncement.linkType === 'external' && bannerAnnouncement.linkTarget) {
                      window.open(bannerAnnouncement.linkTarget, '_blank');
                    } else if (bannerAnnouncement.linkType === 'events') {
                      startNavigation(); navigate('/events');
                    } else if (bannerAnnouncement.linkType === 'wellness') {
                      startNavigation(); navigate('/wellness');
                    } else if (bannerAnnouncement.linkType === 'golf') {
                      startNavigation(); navigate('/book');
                    } else {
                      startNavigation(); navigate('/updates?tab=announcements');
                    }
                  }}
                  className={`text-xs font-semibold mt-2 flex items-center gap-1 ${isDark ? 'text-lavender' : 'text-primary'}`}
                >
                  Learn more
                  <span className="material-symbols-outlined text-sm">arrow_forward</span>
                </button>
              </div>
            </div>
            <button 
              onClick={() => {
                if (user?.email && bannerAnnouncement.id) {
                  localStorage.setItem(`eh_banner_dismissed_${user.email}`, bannerAnnouncement.id);
                }
                setBannerDismissed(true);
              }}
              className={`p-1.5 min-w-[32px] min-h-[32px] flex items-center justify-center rounded-full transition-colors flex-shrink-0 ${isDark ? 'hover:bg-white/10 text-white/60 hover:text-white' : 'hover:bg-black/10 text-primary/60 hover:text-primary'}`}
              aria-label="Dismiss banner"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        )}
        
        {user?.status && user.status.toLowerCase() !== 'active' && (
          <div className="mb-4 p-4 rounded-xl bg-red-500/90 border border-red-600 animate-pop-in">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-2xl text-white">warning</span>
              <div className="flex-1">
                <h4 className="font-bold text-white text-sm">Membership Not Active</h4>
                <p className="text-white/90 text-xs mt-0.5">
                  Your membership status is currently {user.status.toLowerCase()}. Some features are unavailable until your membership is reactivated.
                </p>
              </div>
            </div>
          </div>
        )}
        
        <OnboardingChecklist />
        
        <div className="mb-6 animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
          <div className="flex items-center gap-3">
            <h1 className={`text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-primary'}`}>
              {getGreeting()}, {user?.name.split(' ')[0]}
            </h1>
          </div>
          <p className={`text-sm font-medium mt-1 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
            {new Date().toLocaleDateString('en-US', { timeZone: CLUB_TIMEZONE, weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>

        {/* Member Card + Quick Actions - side by side on desktop, stacked on mobile */}
        {!isStaffOrAdminProfile && (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 mb-6">
            {/* Membership Card */}
            {(() => {
              const isExpired = user?.status === 'Expired';
              const tierColors = getTierColor(user?.tier || 'Social');
              const cardBgColor = isExpired ? '#6B7280' : tierColors.bg;
              const cardTextColor = isExpired ? '#F9FAFB' : tierColors.text;
              const baseTier = getBaseTier(user?.tier || 'Social');
              const useDarkLogo = isExpired || ['Social', 'Premium', 'VIP'].includes(baseTier);
              return (
                <div 
                  onClick={() => setIsCardOpen(true)} 
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsCardOpen(true); } }}
                  className={`relative h-56 lg:h-full lg:min-h-56 w-full rounded-[1.5rem] overflow-hidden cursor-pointer transition-all duration-emphasis ease-out group animate-slide-up-stagger active:scale-[0.98] hover:scale-[1.015] hover:shadow-2xl ${isExpired ? 'grayscale-[30%]' : ''}`}
                  style={{ '--stagger-index': 2 } as React.CSSProperties}
                >
                  <div className="absolute inset-0" style={{ backgroundColor: cardBgColor }}></div>
                  <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.25) 0%, rgba(255,255,255,0.05) 100%)' }}></div>
                  <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")` }}></div>
                  <div className="absolute inset-0 border border-white/30 rounded-[1.5rem] backdrop-blur-xl" style={{ boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.2)' }}></div>
                  <div className="absolute inset-0 overflow-hidden rounded-[1.5rem] opacity-0 group-hover:opacity-100 transition-opacity duration-normal pointer-events-none">
                    <div className="holographic-shimmer absolute -inset-full"></div>
                  </div>
                  <div className="absolute inset-0 p-6 flex flex-col justify-between z-10">
                    <div className="flex justify-between items-start">
                      <img src={useDarkLogo ? "/images/everclub-logo-dark.webp" : "/images/everclub-logo-light.webp"} className={`h-10 w-auto ${isExpired ? 'opacity-50' : 'opacity-90'}`} alt="" />
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: `${cardTextColor}99` }}>Ever Club</span>
                        {isExpired && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-500 text-white">
                            Expired
                          </span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <TierBadge tier={user?.tier || 'Social'} size="sm" />
                      </div>
                      <h3 className="text-xl font-display font-bold tracking-wide" style={{ color: cardTextColor, textShadow: '0 1px 3px rgba(0,0,0,0.15)' }}>{user?.name}</h3>
                      {isExpired ? (
                        <p className="text-xs mt-2 text-red-200">Membership expired - Contact us to renew</p>
                      ) : (
                        <>
                          {user?.joinDate && (
                            <p className="text-xs mt-2" style={{ color: `${cardTextColor}80` }}>Joined {formatMemberSince(user.joinDate)}</p>
                          )}
                          {user?.lifetimeVisits !== undefined && (
                            <p className="text-xs" style={{ color: `${cardTextColor}80` }}>{user.lifetimeVisits} {user.lifetimeVisits === 1 ? 'lifetime visit' : 'lifetime visits'}</p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity duration-normal z-20 p-4 pointer-events-none">
                    <div className="w-full py-2 px-4 rounded-xl bg-black/40 backdrop-blur-md border border-white/20 text-center" style={{ boxShadow: '0 -4px 16px rgba(0,0,0,0.1)' }}>
                      <span className="font-bold text-sm text-white/90">{isExpired ? 'Renew Membership' : 'View Membership Details'}</span>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Quick Links Metrics Grid */}
            <div className="h-full animate-slide-up-stagger" style={{ '--stagger-index': 1 } as React.CSSProperties}>
              <MetricsGrid
                simulatorMinutesUsed={simMinutesToday}
                simulatorMinutesAllowed={tierPermissions.dailySimulatorMinutes}
                conferenceMinutesUsed={confMinutesToday}
                conferenceMinutesAllowed={tierPermissions.dailyConfRoomMinutes}
                nextWellnessClass={nextWellnessClass ? { title: nextWellnessClass.title, date: nextWellnessClass.date } : undefined}
                nextEvent={nextEvent ? { title: nextEvent.title, date: nextEvent.event_date } : undefined}
                onNavigate={navigate}
                className="h-full"
              />
            </div>
          </div>
        )}

        {error ? (
        <div className="p-4 rounded-xl bg-red-500/20 border border-red-500/30 text-red-300 text-sm flex items-center gap-3 mb-6">
          <span className="material-symbols-outlined">error</span>
          {error}
        </div>
      ) : (
        <>
          {/* Your Schedule - Combined Bookings, Events & Wellness */}
          <div className="animate-slide-up-stagger" style={{ '--stagger-index': 4 } as React.CSSProperties}>
            <div className="flex justify-between items-center mb-4 px-1">
              <h3 className={`text-sm font-bold uppercase tracking-wider ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Your Schedule</h3>
              <button
                onClick={() => { startNavigation(); navigate('/book'); }}
                className={`tactile-btn text-xs font-semibold flex items-center gap-1 ${isDark ? 'text-accent' : 'text-brand-green'}`}
                aria-label="Book new"
              >
                <span className="material-symbols-outlined text-base">add</span>
                Book
              </button>
            </div>
            <div ref={scheduleRef} className="space-y-3">
              {upcomingItemsFiltered.length > 0 ? upcomingItemsFiltered.slice(0, 6).map((item, idx) => {
                let actions;
                const isCancelling = optimisticCancellingIds.has(Number(item.dbId));
                
                if (item.type === 'booking' || item.type === 'booking_request') {
                  const bookingStatus = (item as DashboardBookingItem).status;
                  const isConfirmed = bookingStatus === 'approved' || bookingStatus === 'confirmed';
                  const rawBooking = item.raw as DBBookingRequest | DBBooking;
                  const startTime24 = 'start_time' in rawBooking ? rawBooking.start_time : '';
                  const endTime24 = 'end_time' in rawBooking ? rawBooking.end_time : '';
                  const isLinkedMember = (item as DashboardBookingItem).isLinkedMember || false;
                  
                  const primaryBookerName = (item as DashboardBookingItem).primaryBookerName;
                  
                  const isCancellationPending = (item as DashboardBookingItem).status === 'cancellation_pending';
                  
                  // When cancelling or cancellation_pending, show no actions (disabled state)
                  if (isCancelling || isCancellationPending) {
                    actions = [];
                  } else {
                    actions = [
                      ...(isConfirmed ? [{
                        icon: 'calendar_add_on',
                        label: 'Add to Calendar',
                        onClick: () => downloadICalFile({
                          title: `${item.title} - Ever Club`,
                          description: `Your ${item.resourceType === 'conference_room' ? 'conference room' : 'golf simulator'} booking at Ever Club`,
                          location: 'Ever Club, 15771 Red Hill Ave, Ste 500, Tustin, CA 92780',
                          startDate: item.rawDate,
                          startTime: startTime24,
                          endTime: endTime24
                        }, `EverClub_${item.rawDate}_${item.title.replace(/[^a-zA-Z0-9]/g, '_')}.ics`)
                      }] : []),
                      ...(!isLinkedMember ? [
                        { icon: 'close', label: 'Cancel', onClick: () => handleCancelBooking(Number(item.dbId), item.type) }
                      ] : []),
                      ...(isLinkedMember && isConfirmed ? [{
                        icon: 'logout',
                        label: 'Leave',
                        onClick: () => handleLeaveBooking(Number(item.dbId), primaryBookerName)
                      }] : [])
                    ];
                  }
                } else if (item.type === 'rsvp') {
                  const rsvpRaw = item.raw as DBRSVP;
                  actions = [
                    {
                      icon: 'calendar_add_on',
                      label: 'Add to Calendar',
                      onClick: () => downloadICalFile({
                        title: `${item.title} - Ever Club`,
                        description: `Your event at Ever Club`,
                        location: rsvpRaw.location || 'Ever Club, 15771 Red Hill Ave, Ste 500, Tustin, CA 92780',
                        startDate: item.rawDate,
                        startTime: rsvpRaw.start_time,
                        endTime: rsvpRaw.end_time || ''
                      }, `EverClub_${item.rawDate}_${item.title.replace(/[^a-zA-Z0-9]/g, '_')}.ics`)
                    },
                    { icon: 'close', label: 'Cancel RSVP', onClick: () => handleCancelRSVP(rsvpRaw.event_id) }
                  ];
                } else if (item.type === 'wellness') {
                  const wellnessRaw = item.raw as DBWellnessEnrollment;
                  actions = [
                    {
                      icon: 'calendar_add_on',
                      label: 'Add to Calendar',
                      onClick: () => downloadICalFile({
                        title: `${item.title} - Ever Club`,
                        description: `Your wellness class at Ever Club`,
                        location: 'Ever Club, 15771 Red Hill Ave, Ste 500, Tustin, CA 92780',
                        startDate: item.rawDate,
                        startTime: wellnessRaw.time,
                        endTime: ''
                      }, `EverClub_${item.rawDate}_${item.title.replace(/[^a-zA-Z0-9]/g, '_')}.ics`)
                    },
                    { icon: 'close', label: 'Cancel', onClick: () => handleCancelWellness(wellnessRaw.class_id) }
                  ];
                } else {
                  actions = [];
                }
                const getStatusBadge = () => {
                  if (item.type !== 'booking' && item.type !== 'booking_request') return null;
                  const status = (item as DashboardBookingItem).status;
                  const isLinked = (item as DashboardBookingItem).isLinkedMember || false;
                  const rawBooking = item.raw as DBBookingRequest;
                  
                  const badges: React.ReactNode[] = [];
                  
                  // Show "Cancelling..." badge when optimistically cancelling
                  if (isCancelling) {
                    badges.push(
                      <span key="cancelling" className="px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs animate-spin">progress_activity</span>
                        Cancelling...
                      </span>
                    );
                    return <div className="flex gap-1.5 flex-wrap">{badges}</div>;
                  }
                  
                  if (isLinked) {
                    badges.push(
                      <span key="player" className="px-2 py-0.5 text-xs font-medium rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">
                        Player
                      </span>
                    );
                  }
                  
                  if (status) {
                    badges.push(
                      <span key="status" className={`px-2 py-0.5 text-xs font-medium rounded-full ${getStatusBadgeColor(status)}`}>
                        {status === 'cancellation_pending' && <span className="material-symbols-outlined text-xs mr-0.5">hourglass_top</span>}
                        {formatStatusLabel(status)}
                      </span>
                    );
                  }
                  
                  if (status === 'cancellation_pending') {
                    badges.push(
                      <span key="cancel-pending-info" className="text-xs text-orange-600 dark:text-orange-400">
                        Your cancellation is being processed
                      </span>
                    );
                  }
                  
                  
                  if (badges.length === 0) return null;
                  return <div className="flex gap-1.5 flex-wrap">{badges}</div>;
                };
                const isSimulatorBooking = item.resourceType === 'simulator';
                const isApprovedOrConfirmed = ['approved', 'confirmed'].includes((item as DashboardBookingItem).status);
                const isOwnerOfBooking = !((item as DashboardBookingItem).isLinkedMember);
                const showRosterManager = (item.type === 'booking' || item.type === 'booking_request') && 
                  isSimulatorBooking && 
                  isApprovedOrConfirmed && 
                  isOwnerOfBooking;
                const rawBookingData = item.raw as DBBookingRequest;

                const getScheduleStatus = () => {
                  if (isCancelling) return { label: 'Cancelling', color: 'bg-red-500' };
                  if (item.type === 'booking' || item.type === 'booking_request') {
                    const s = (item as DashboardBookingItem).status;
                    if (s === 'approved' || s === 'confirmed') return { label: 'Confirmed', color: 'bg-green-500' };
                    if (s === 'pending' || s === 'pending_approval') return { label: 'Pending', color: 'bg-amber-500' };
                    if (s === 'attended') return { label: 'Attended', color: 'bg-blue-500' };
                    if (s === 'cancellation_pending') return { label: 'Cancel Pending', color: 'bg-orange-500' };
                    return { label: formatStatusLabel(s || ''), color: 'bg-gray-400' };
                  }
                  if (item.type === 'rsvp') return { label: "RSVP'd", color: 'bg-green-500' };
                  if (item.type === 'wellness') return { label: 'Enrolled', color: 'bg-green-500' };
                  return undefined;
                };

                const getMetadata = () => {
                  const chips: { icon: string; label: string }[] = [];
                  if (item.type === 'booking' || item.type === 'booking_request') {
                    const raw = item.raw as DBBookingRequest;
                    const playerCount = raw.declared_player_count || 1;
                    chips.push({ icon: 'group', label: `${playerCount} Player${playerCount !== 1 ? 's' : ''}` });
                    if (raw.duration_minutes) {
                      const hrs = Math.floor(raw.duration_minutes / 60);
                      const mins = raw.duration_minutes % 60;
                      chips.push({ icon: 'schedule', label: hrs > 0 ? (mins > 0 ? `${hrs}h ${mins}m` : `${hrs} Hour${hrs > 1 ? 's' : ''}`) : `${mins} min` });
                    } else if (raw.start_time && raw.end_time) {
                      const [sh, sm] = raw.start_time.split(':').map(Number);
                      const [eh, em] = raw.end_time.split(':').map(Number);
                      const dur = (eh * 60 + em) - (sh * 60 + sm);
                      if (dur > 0) {
                        const hrs = Math.floor(dur / 60);
                        const mins = dur % 60;
                        chips.push({ icon: 'schedule', label: hrs > 0 ? (mins > 0 ? `${hrs}h ${mins}m` : `${hrs} Hour${hrs > 1 ? 's' : ''}`) : `${mins} min` });
                      }
                    }
                  } else if (item.type === 'wellness') {
                    const raw = item.raw as DBWellnessEnrollment;
                    if (raw.category) chips.push({ icon: 'category', label: raw.category });
                    if (raw.instructor) chips.push({ icon: 'person', label: raw.instructor });
                  }
                  return chips;
                };

                const scheduleStatus = getScheduleStatus();
                const linkedBookerInfo = (item.type === 'booking' || item.type === 'booking_request') && 
                  (item as DashboardBookingItem).isLinkedMember && (item as DashboardBookingItem).primaryBookerName
                  ? `Booked by ${(item as DashboardBookingItem).primaryBookerName?.split(' ')[0]}`
                  : undefined;

                return (
                  <React.Fragment key={item.id}>
                    <ScheduleCard
                      status={scheduleStatus?.label}
                      statusColor={scheduleStatus?.color}
                      icon={getIconForType(item.resourceType)}
                      title={item.title}
                      dateTime={`${item.date} • ${item.time}${item.endTime ? ` - ${item.endTime}` : ''}`}
                      metadata={getMetadata()}
                      actions={actions}
                      staggerIndex={idx + 4}
                      linkedInfo={linkedBookerInfo}
                    />
                    {showRosterManager && (
                      <div className="mt-2 mb-4">
                        <RosterManager
                          bookingId={item.dbId}
                          declaredPlayerCount={rawBookingData.declared_player_count || 1}
                          isOwner={isOwnerOfBooking}
                          isStaff={isStaffOrAdminProfile}
                          onUpdate={() => refetchAllData()}
                        />
                      </div>
                    )}
                  </React.Fragment>
                );
              }) : (
                <div className="space-y-4 animate-pop-in">
                  <div className={`flex flex-col items-center justify-center text-center py-6 px-6 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-primary/[0.03]'}`}>
                    <div className="relative mb-3">
                      <div className={`w-14 h-14 rounded-full flex items-center justify-center ${isDark ? 'bg-accent/20' : 'bg-accent/10'}`}>
                        <span className={`material-symbols-outlined text-2xl ${isDark ? 'text-accent' : 'text-brand-green'}`}>sports_golf</span>
                      </div>
                    </div>
                    <h4 className={`text-base font-semibold mb-1 ${isDark ? 'text-white' : 'text-primary'}`}>No upcoming bookings</h4>
                    <p className={`text-xs max-w-[260px] mb-3 ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                      Ready to play? Book a golf simulator session.
                    </p>
                    <button
                      onClick={() => { startNavigation(); navigate('/book'); }}
                      className={`px-5 py-2 rounded-xl text-sm font-semibold transition-all duration-fast hover:scale-[1.02] active:scale-[0.98] ${isDark ? 'bg-accent text-brand-green' : 'bg-brand-green text-white'}`}
                    >
                      Book a Session
                    </button>
                  </div>

                  <div className={`flex items-center gap-3 py-4 px-5 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-primary/[0.03]'}`}>
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-lavender/20' : 'bg-lavender/10'}`}>
                      <span className={`material-symbols-outlined text-xl ${isDark ? 'text-lavender' : 'text-primary/70'}`}>event</span>
                    </div>
                    <div>
                      <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>No upcoming events</p>
                      <p className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>Check back soon for club events and activities.</p>
                    </div>
                  </div>

                  <div className={`flex items-center gap-3 py-4 px-5 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-primary/[0.03]'}`}>
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
                      <span className={`material-symbols-outlined text-xl ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>how_to_reg</span>
                    </div>
                    <div>
                      <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>No RSVPs yet</p>
                      <p className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>RSVP to events to see them here.</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      </div>
    </div>

    <ModalShell 
      isOpen={!!confirmModal} 
      onClose={() => setConfirmModal(null)}
      title={confirmModal?.title || ''}
      size="sm"
    >
      {confirmModal && (
        <div className="p-6">
          <p className="mb-6 text-sm opacity-70">{confirmModal.message}</p>
          <div className="flex gap-3">
            <button 
              onClick={() => setConfirmModal(null)}
              className={`flex-1 py-3 rounded-xl font-bold text-sm ${isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-gray-100 hover:bg-gray-200'}`}
            >
              Keep it
            </button>
            <button 
              onClick={confirmModal.onConfirm}
              className="flex-1 py-3 rounded-xl font-bold text-sm bg-red-500 hover:bg-red-600 text-white shadow-lg"
            >
              Yes, Cancel
            </button>
          </div>
        </div>
      )}
    </ModalShell>

    {/* Guest Check-In Modal */}
    <HubSpotFormModal
      isOpen={showGuestCheckin}
      onClose={() => setShowGuestCheckin(false)}
      formType="guest-checkin"
      title="Guest Check-In"
      subtitle="Register your guest for today's visit."
      fields={GUEST_CHECKIN_FIELDS}
      submitButtonText="Check In Guest"
      additionalFields={{
        member_name: user?.name || '',
        member_email: user?.email || ''
      }}
      onSuccess={async () => {
        queryClient.invalidateQueries({ queryKey: ['member', 'dashboard-data'] });
      }}
    />

    {/* Membership Details Modal */}
    <ModalShell 
      isOpen={isCardOpen && !!user} 
      onClose={() => setIsCardOpen(false)}
      showCloseButton={false}
      size="sm"
      className="!bg-transparent !border-0 !shadow-none"
    >
      {user && (() => {
        const isExpiredModal = user.status === 'Expired';
        const tierColors = getTierColor(user.tier || 'Social');
        const cardBgColor = isExpiredModal ? '#6B7280' : (isStaffOrAdminProfile ? '#293515' : tierColors.bg);
        const cardTextColor = isExpiredModal ? '#F9FAFB' : (isStaffOrAdminProfile ? '#F2F2EC' : tierColors.text);
        return (
          <div className="flex flex-col items-center">
            <div className={`w-full rounded-[2rem] relative overflow-hidden shadow-2xl flex flex-col ${isExpiredModal ? 'grayscale-[30%]' : ''}`} style={{ backgroundColor: cardBgColor }}>
              
              {/* Close Button */}
              <button onClick={() => setIsCardOpen(false)} className="absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center z-10" style={{ backgroundColor: `${cardTextColor}33`, color: cardTextColor }}>
                <span className="material-symbols-outlined text-sm">close</span>
              </button>

              {/* Member Info */}
              <div className="pt-6 px-6 pb-4 text-center" style={{ backgroundColor: cardBgColor }}>
                <h2 className="text-2xl font-bold mb-3" style={{ color: cardTextColor }}>{user.name}</h2>
                
                <div className="flex items-center justify-center gap-2 flex-wrap mb-2">
                  <TierBadge tier={user.tier || 'Social'} size="md" />
                  {isExpiredModal && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-red-500 text-white">
                      Expired
                    </span>
                  )}
                </div>
                {isExpiredModal && (
                  <div className="mt-4 p-3 rounded-xl bg-red-500/20 border border-red-500/30">
                    <p className="text-sm text-red-200 text-center mb-2">Your membership has expired</p>
                    <a 
                      href="/contact" 
                      className="block w-full py-2 px-4 bg-red-500 hover:bg-red-600 text-white text-sm font-bold rounded-lg text-center transition-colors"
                    >
                      Contact Us to Renew
                    </a>
                  </div>
                )}
              </div>

              {/* QR Code for check-in */}
              {!isExpiredModal && user.id && (
                <div className="px-6 pb-2 flex flex-col items-center" style={{ backgroundColor: cardBgColor }}>
                  <div className="bg-white p-2.5 rounded-xl shadow-md flex items-center justify-center" style={{ width: '55%', aspectRatio: '1' }}>
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(`MEMBER:${user.id}`)}`}
                      alt="Member QR Code"
                      className="w-full h-full"
                    />
                  </div>
                  <p className="text-xs mt-1.5 opacity-50" style={{ color: cardTextColor }}>Show for quick check-in</p>
                </div>
              )}

              {/* Benefits Section */}
              <div className="px-6 pb-6" style={{ backgroundColor: cardBgColor }}>
                <div className="rounded-xl p-4 space-y-3" style={{ backgroundColor: `${cardTextColor}10` }}>
                  <h3 className="text-xs font-bold uppercase tracking-wider opacity-60 mb-3" style={{ color: cardTextColor }}>Membership Benefits</h3>
                  
                  {user.joinDate && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-lg opacity-60" style={{ color: cardTextColor }}>badge</span>
                        <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Member Since</span>
                      </div>
                      <span className="font-semibold text-sm" style={{ color: cardTextColor }}>{formatMemberSince(user.joinDate)}</span>
                    </div>
                  )}
                  
                  {tierPermissions.dailySimulatorMinutes > 0 && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-lg opacity-60" style={{ color: cardTextColor }}>sports_golf</span>
                        <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Daily Simulator</span>
                      </div>
                      <span className="font-semibold text-sm" style={{ color: cardTextColor }}>
                        {tierPermissions.dailySimulatorMinutes === Infinity ? 'Unlimited' : `${tierPermissions.dailySimulatorMinutes} min`}
                      </span>
                    </div>
                  )}
                  
                  {tierPermissions.dailyConfRoomMinutes > 0 && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-lg opacity-60" style={{ color: cardTextColor }}>meeting_room</span>
                        <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Daily Conference</span>
                      </div>
                      <span className="font-semibold text-sm" style={{ color: cardTextColor }}>
                        {tierPermissions.dailyConfRoomMinutes === Infinity ? 'Unlimited' : `${tierPermissions.dailyConfRoomMinutes} min`}
                      </span>
                    </div>
                  )}
                  
                  {guestPasses && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-lg opacity-60" style={{ color: cardTextColor }}>group_add</span>
                        <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Guest Passes</span>
                      </div>
                      <span className="font-semibold text-sm" style={{ color: cardTextColor }}>
                        {guestPasses.passes_remaining} / {guestPasses.passes_total} remaining
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </ModalShell>

    <FirstLoginWelcomeModal
      isOpen={showFirstLoginModal}
      onClose={() => setShowFirstLoginModal(false)}
      firstName={user?.name?.split(' ')[0]}
    />

    <NfcCheckinWelcomeModal
      isOpen={!!nfcCheckinData}
      onClose={() => setNfcCheckinData(null)}
      checkinData={nfcCheckinData}
    />
    </>
  )}
    </div>
    </SmoothReveal>
    </AnimatedPage>
  );
};

export default Dashboard;
