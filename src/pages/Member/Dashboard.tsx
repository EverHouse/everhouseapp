import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData, Booking } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';
import { useToast } from '../../components/Toast';
import { bookingEvents } from '../../lib/bookingEvents';
import GlassRow from '../../components/GlassRow';
import DateButton from '../../components/DateButton';
import WelcomeBanner from '../../components/WelcomeBanner';
import { formatDateShort, getTodayString, getPacificHour, CLUB_TIMEZONE, formatDateTimePacific, formatMemberSince, formatTime12Hour, getNowTimePacific } from '../../utils/dateUtils';
import { downloadICalFile } from '../../utils/icalUtils';
import { DashboardSkeleton } from '../../components/skeletons';
import { SmoothReveal } from '../../components/motion/SmoothReveal';
import { getBaseTier, isFoundingMember } from '../../utils/permissions';
import { getTierColor } from '../../utils/tierUtils';
import { getStatusBadge as getStatusBadgeColor, formatStatusLabel } from '../../utils/statusColors';
import TierBadge from '../../components/TierBadge';
import TagBadge from '../../components/TagBadge';
import HubSpotFormModal from '../../components/HubSpotFormModal';
import PullToRefresh from '../../components/PullToRefresh';
import { useTierPermissions } from '../../hooks/useTierPermissions';
import AnnouncementAlert from '../../components/AnnouncementAlert';
import ClosureAlert from '../../components/ClosureAlert';
import ErrorState from '../../components/ErrorState';
import ModalShell from '../../components/ModalShell';
import MetricsGrid from '../../components/MetricsGrid';
import { RosterManager } from '../../components/booking';
import { apiRequest } from '../../lib/apiRequest';
import BalanceCard from '../../components/billing/BalanceCard';
import BalancePaymentModal from '../../components/billing/BalancePaymentModal';
import { AnimatedPage } from '../../components/motion';

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
  status: 'pending' | 'approved' | 'confirmed' | 'attended' | 'no_show' | 'declined' | 'cancelled';
  staff_notes: string | null;
  suggested_time: string | null;
  created_at: string;
  calendar_event_id?: string | null;
  is_linked_member?: boolean;
  primary_booker_name?: string | null;
  declared_player_count?: number;
  invite_status?: 'pending' | 'accepted' | 'declined' | null;
  overage_minutes?: number;
  overage_fee_cents?: number;
  overage_paid?: boolean;
}

const formatDate = (dateStr: string): string => {
  return formatDateShort(dateStr);
};

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const { user, actualUser, isViewingAs, addBooking, deleteBooking } = useData();
  const { effectiveTheme } = useTheme();
  
  // Check if admin is viewing as a member
  const isAdminViewingAs = actualUser?.role === 'admin' && isViewingAs;
  const { setPageReady } = usePageReady();
  const { startNavigation } = useNavigationLoading();
  const { showToast } = useToast();
  const isDark = effectiveTheme === 'dark';
  
  const [dbBookings, setDbBookings] = useState<DBBooking[]>([]);
  const [dbBookingRequests, setDbBookingRequests] = useState<DBBookingRequest[]>([]);
  const [dbRSVPs, setDbRSVPs] = useState<DBRSVP[]>([]);
  const [dbWellnessEnrollments, setDbWellnessEnrollments] = useState<DBWellnessEnrollment[]>([]);
  const [dbConferenceRoomBookings, setDbConferenceRoomBookings] = useState<any[]>([]);
  const [allWellnessClasses, setAllWellnessClasses] = useState<{ id: number; title: string; date: string; time: string }[]>([]);
  const [allEvents, setAllEvents] = useState<{ id: number; title: string; event_date: string; start_time: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [selectedBooking, setSelectedBooking] = useState<DBBooking | null>(null);
  const [newDate, setNewDate] = useState<string>('');
  const [newTime, setNewTime] = useState<string | null>(null);
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; title: string; message: string; onConfirm: () => void } | null>(null);
  const [guestPasses, setGuestPasses] = useState<{ passes_used: number; passes_total: number; passes_remaining: number } | null>(null);
  const [showGuestCheckin, setShowGuestCheckin] = useState(false);
  const [isCardOpen, setIsCardOpen] = useState(false);
  const [bannerAnnouncement, setBannerAnnouncement] = useState<{ id: string; title: string; desc: string; linkType?: string; linkTarget?: string } | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [processingInviteId, setProcessingInviteId] = useState<number | null>(null);
  const [showBalancePaymentModal, setShowBalancePaymentModal] = useState(false);
  const [balanceRefreshKey, setBalanceRefreshKey] = useState(0);
  const [overagePaymentBooking, setOveragePaymentBooking] = useState<{ id: number; amount: number; minutes: number } | null>(null);
  const [isPayingOverage, setIsPayingOverage] = useState(false);

  // PERF: To prevent re-calculating on every render, we throttle the current time
  // This value is updated once a minute, which is enough to keep the UI fresh
  const [throttledNowTime, setThrottledNowTime] = useState(getNowTimePacific());

  useEffect(() => {
    // Update the time every 60 seconds
    const intervalId = setInterval(() => {
      setThrottledNowTime(getNowTimePacific());
    }, 60000); // 60 * 1000 ms

    return () => clearInterval(intervalId);
  }, []);

  const isStaffOrAdminProfile = user?.role === 'admin' || user?.role === 'staff';
  const { permissions: tierPermissions } = useTierPermissions(user?.tier);

  const fetchUserData = useCallback(async (showLoadingState = true) => {
    if (!user?.email) return;
    
    if (showLoadingState) {
      setIsLoading(true);
    }
    setError(null);
    
    try {
      // Build conference room bookings URL with member name and email for proper filtering
      const conferenceRoomParams = new URLSearchParams();
      if (user.name) conferenceRoomParams.set('member_name', user.name);
      if (user.email) conferenceRoomParams.set('member_email', user.email);
      const conferenceRoomUrl = `/api/conference-room-bookings${conferenceRoomParams.toString() ? '?' + conferenceRoomParams.toString() : ''}`;
      
      const results = await Promise.allSettled([
        fetch(`/api/bookings?user_email=${encodeURIComponent(user.email)}`, { credentials: 'include' }),
        fetch(`/api/rsvps?user_email=${encodeURIComponent(user.email)}`, { credentials: 'include' }),
        fetch(`/api/wellness-enrollments?user_email=${encodeURIComponent(user.email)}`, { credentials: 'include' }),
        fetch(`/api/booking-requests?user_email=${encodeURIComponent(user.email)}`, { credentials: 'include' }),
        fetch(conferenceRoomUrl, { credentials: 'include' }),
        fetch('/api/wellness-classes', { credentials: 'include' }),
        fetch('/api/events', { credentials: 'include' })
      ]);

      const failedItems: string[] = [];

      if (results[0].status === 'fulfilled' && results[0].value.ok) {
        setDbBookings(await results[0].value.json());
      } else {
        console.error('Bookings failed to load');
        failedItems.push('bookings');
      }

      if (results[1].status === 'fulfilled' && results[1].value.ok) {
        setDbRSVPs(await results[1].value.json());
      } else {
        failedItems.push('event RSVPs');
      }

      if (results[2].status === 'fulfilled' && results[2].value.ok) {
        setDbWellnessEnrollments(await results[2].value.json());
      } else {
        failedItems.push('wellness enrollments');
      }
      
      if (results[3].status === 'fulfilled' && results[3].value.ok) {
        setDbBookingRequests(await results[3].value.json());
      } else {
        failedItems.push('booking requests');
      }
      
      if (results[4].status === 'fulfilled' && results[4].value.ok) {
        setDbConferenceRoomBookings(await results[4].value.json());
      } else {
        failedItems.push('conference room bookings');
      }
      
      if (results[5].status === 'fulfilled' && results[5].value.ok) {
        setAllWellnessClasses(await results[5].value.json());
      } else {
        failedItems.push('wellness classes');
      }
      
      if (results[6].status === 'fulfilled' && results[6].value.ok) {
        setAllEvents(await results[6].value.json());
      } else {
        failedItems.push('events');
      }

      if (failedItems.length > 0) {
        setError(`Failed to load: ${failedItems.join(', ')}. Pull down to refresh.`);
      }
      
    } catch (err) {
      console.error('Critical error fetching user data:', err);
      setError('Unable to connect to server. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [user?.email]);

  useEffect(() => {
    fetchUserData();
  }, [fetchUserData]);

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchUserData(false);
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [fetchUserData]);

  useEffect(() => {
    const unsubscribe = bookingEvents.subscribe(() => {
      fetchUserData(false);
    });
    return unsubscribe;
  }, [fetchUserData]);

  useEffect(() => {
    if (user?.email && !isStaffOrAdminProfile) {
      fetch(`/api/guest-passes/${encodeURIComponent(user.email)}?tier=${encodeURIComponent(user.tier || 'Social')}`, { credentials: 'include' })
        .then(res => {
          if (!res.ok) throw new Error('Failed to fetch guest passes');
          return res.json();
        })
        .then(data => setGuestPasses(data))
        .catch(err => console.error('Error fetching guest passes:', err));
    }
  }, [user?.email, user?.tier, isStaffOrAdminProfile]);

  useEffect(() => {
    if (user?.email) {
      const dismissedKey = `eh_banner_dismissed_${user.email}`;
      const dismissedId = localStorage.getItem(dismissedKey);
      
      fetch('/api/announcements/banner', { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
          if (data && data.id !== dismissedId) {
            setBannerAnnouncement(data);
            setBannerDismissed(false);
          } else if (data && data.id === dismissedId) {
            setBannerDismissed(true);
          }
        })
        .catch(err => console.error('Error fetching banner announcement:', err));
    }
  }, [user?.email]);

  const handleRefresh = useCallback(async () => {
    await fetchUserData(false);
  }, [fetchUserData]);

  // PERF: Memoize all combined/sorted/filtered lists to prevent re-calculation on every render.
  // These will only re-compute when the underlying API data changes.
  const allItems = useMemo(() => [
    ...dbBookings.map(b => {
      // Check if current user is NOT the primary booker (i.e., is a linked member)
      const isLinkedMember = user?.email ? b.user_email?.toLowerCase() !== user.email.toLowerCase() : false;
      // For linked members, show the primary booker's email (before @) as the booker name
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
      .filter(r => ['pending', 'pending_approval', 'approved', 'confirmed', 'attended'].includes(r.status))
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
      endTime: '',
      details: r.location || '',
      sortKey: `${r.event_date}T${r.start_time}`,
      raw: r
    })),
    ...dbWellnessEnrollments.map(w => ({
      id: `wellness-${w.id}`,
      dbId: w.id,
      classId: w.class_id,
      type: 'wellness' as const,
      title: w.title || 'Wellness Class',
      resourceType: 'wellness_class',
      date: formatDate(w.date),
      rawDate: w.date.split('T')[0],
      time: w.time,
      endTime: '',
      details: `${w.category} with ${w.instructor}`,
      sortKey: `${w.date}T${w.time}`,
      raw: w
    })),
    // Filter out calendar bookings that already exist as DB booking requests (avoid duplicates)
    ...dbConferenceRoomBookings
      .filter(c => {
        // Check if this calendar event already exists as a DB booking (by calendar_event_id)
        // Must check all active statuses, not just 'approved', to avoid duplicates when status changes
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
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey)), [dbBookings, dbBookingRequests, dbRSVPs, dbWellnessEnrollments, dbConferenceRoomBookings, user?.email]);

  const upcomingItems = useMemo(() => {
    const todayStr = getTodayString();
    
    // Normalize time to HH:MM format for comparison
    const normalizeTime = (t: string) => {
      if (!t) return '';
      const parts = t.split(':');
      return `${parts[0].padStart(2, '0')}:${parts[1]?.padStart(2, '0') || '00'}`;
    };
    
    return allItems.filter(item => {
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
        // Events typically last ~2 hours, use end_time if available or keep visible all day
        endTime = raw.end_time;
      } else if (item.type === 'wellness') {
        const raw = item.raw as DBWellnessEnrollment;
        itemDate = raw.date.split('T')[0];
        // Wellness classes don't have end_time, keep visible until end of day
        endTime = undefined;
      } else if (item.type === 'conference_room_calendar') {
        const raw = item.raw as any;
        itemDate = raw.request_date.split('T')[0];
        endTime = raw.end_time;
      }

      if (!itemDate) return false;

      // Future dates are always included
      if (itemDate > todayStr) return true;
      
      // Past dates are always excluded
      if (itemDate < todayStr) return false;
      
      // For today's items, check if they've already ended
      // Items without end_time stay visible all day
      // PERF: Use throttledNowTime to avoid re-filtering on every render
      if (endTime && normalizeTime(endTime) < throttledNowTime) {
        return false;
      }
      
      return true;
    });
  }, [allItems, throttledNowTime]);

  // Calculate minutes used today for metrics (from allItems, not upcomingItems, to include bookings that have already ended)
  const { simMinutesToday, confMinutesToday } = useMemo(() => {
    const todayStr = getTodayString();
    const todayBookingsAll = allItems.filter(item =>
      item.rawDate === todayStr &&
      (item.type === 'booking' || item.type === 'booking_request' || item.type === 'conference_room_calendar')
    );

    const simMinutes = todayBookingsAll
      .filter(b => b.resourceType === 'simulator')
      .reduce((sum, b) => {
        const raw = b.raw as any;
        const start = raw.start_time?.split(':').map(Number) || [0, 0];
        const end = raw.end_time?.split(':').map(Number) || [0, 0];
        const totalMinutes = (end[0] * 60 + end[1]) - (start[0] * 60 + start[1]);
        const playerCount = raw.declared_player_count || 1;
        const memberShare = Math.ceil(totalMinutes / playerCount);
        return sum + memberShare;
      }, 0);

    const confMinutes = todayBookingsAll
      .filter(b => b.resourceType === 'conference_room')
      .reduce((sum, b) => {
        const raw = b.raw as any;
        const start = raw.start_time?.split(':').map(Number) || [0, 0];
        const end = raw.end_time?.split(':').map(Number) || [0, 0];
        const totalMinutes = (end[0] * 60 + end[1]) - (start[0] * 60 + start[1]);
        const playerCount = raw.declared_player_count || 1;
        const memberShare = Math.ceil(totalMinutes / playerCount);
        return sum + memberShare;
      }, 0);
      
    return { simMinutesToday: simMinutes, confMinutesToday: confMinutes };
  }, [allItems]);

  // Calculate next upcoming event/wellness for metrics grid (from all events/classes, not just enrolled)
  const { nextEvent, nextWellnessClass } = useMemo(() => {
    const todayStr = getTodayString();
    const nextEv = allEvents
      .filter(e => e.event_date.split('T')[0] >= todayStr)
      .sort((a, b) => a.event_date.localeCompare(b.event_date) || (a.start_time || '').localeCompare(b.start_time || ''))
      [0];
    const nextWc = allWellnessClasses
      .filter(w => w.date.split('T')[0] >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''))
      [0];
    return { nextEvent: nextEv, nextWellnessClass: nextWc };
  }, [allEvents, allWellnessClasses]);

  // Filter out pending invites from upcomingItems (show them in separate section)
  // A pending invite is: is_linked_member=true AND invite_status='pending'
  const pendingInvites = dbBookingRequests.filter(r => 
    r.is_linked_member === true && 
    r.invite_status === 'pending' &&
    ['pending', 'pending_approval', 'approved', 'confirmed'].includes(r.status)
  );
  
  const pendingInviteIds = new Set(pendingInvites.map(p => p.id));
  
  // Filter upcomingItems to exclude pending invites
  // Check both 'booking' and 'booking_request' types since approved bookings have type='booking'
  const upcomingItemsFiltered = upcomingItems.filter(item => {
    if (item.type === 'booking_request' || item.type === 'booking') {
      const raw = item.raw as DBBookingRequest;
      // Exclude if it's a pending invite (not yet accepted by linked member)
      if (raw && pendingInviteIds.has(raw.id)) {
        return false;
      }
    }
    return true;
  });

  // Separate bookings from events/wellness (include both confirmed bookings, approved requests, and calendar conference room bookings)
  const upcomingBookings = upcomingItemsFiltered.filter(item => item.type === 'booking' || item.type === 'booking_request' || item.type === 'conference_room_calendar');
  const upcomingEventsWellness = upcomingItemsFiltered.filter(item => item.type === 'rsvp' || item.type === 'wellness');

  // Next booking card shows only golf/conference bookings
  const nextBooking = upcomingBookings[0];
  
  // Upcoming section shows events and wellness enrollments
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
        
        // Store previous state
        const previousBookings = [...dbBookings];
        const previousBookingRequests = [...dbBookingRequests];

        // Optimistic update - filter out cancelled item immediately for both types
        if (bookingType === 'booking') {
          setDbBookings(prev => prev.filter(b => b.id !== bookingId));
        } else {
          setDbBookingRequests(prev => prev.filter(r => r.id !== bookingId));
        }

        try {
          let res;
          const headers = { 'Content-Type': 'application/json' };
          
          if (bookingType === 'booking') {
            // Pass acting_as_email for admin "View As" mode
            res = await fetch(`/api/bookings/${bookingId}/member-cancel`, {
              method: 'PUT',
              headers,
              credentials: 'include',
              body: JSON.stringify(isAdminViewingAs ? { acting_as_email: user?.email } : {})
            });
          } else {
            // Pass acting_as_email for admin "View As" mode
            res = await fetch(`/api/booking-requests/${bookingId}/member-cancel`, {
              method: 'PUT',
              headers,
              credentials: 'include',
              body: JSON.stringify(isAdminViewingAs ? { acting_as_email: user?.email } : {})
            });
          }

          if (res.ok) {
            setSelectedBooking(null);
            // Also update global DataContext to keep state in sync
            deleteBooking(String(bookingId));
            showToast('Booking cancelled successfully', 'success');
          } else {
            // Revert on failure
            setDbBookings(previousBookings);
            setDbBookingRequests(previousBookingRequests);
            const data = await res.json().catch(() => ({}));
            showToast(data.error || 'Failed to cancel booking', 'error');
          }
        } catch (err) {
          // Revert on error
          setDbBookings(previousBookings);
          setDbBookingRequests(previousBookingRequests);
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
          // First, get the participant ID for the current user
          const participantsRes = await fetch(`/api/bookings/${bookingId}/participants`, { credentials: 'include' });
          if (!participantsRes.ok) {
            showToast('Failed to get booking details', 'error');
            return;
          }
          
          const participantsData = await participantsRes.json();
          const participants = participantsData.participants || [];
          
          // Find the current user's participant record
          const myParticipant = participants.find((p: any) => 
            p.email?.toLowerCase() === user.email.toLowerCase()
          );
          
          if (!myParticipant) {
            showToast('Could not find your participant record', 'error');
            return;
          }
          
          // Call the delete endpoint to remove ourselves
          const body = isAdminViewingAs && user?.email ? { onBehalfOf: user.email } : {};
          const res = await fetch(`/api/bookings/${bookingId}/participants/${myParticipant.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body)
          });
          
          if (res.ok) {
            showToast('You have left the booking', 'success');
            await fetchUserData(false);
          } else {
            const data = await res.json().catch(() => ({}));
            showToast(data.error || 'Failed to leave booking', 'error');
          }
        } catch (err) {
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
        
        // Store previous state
        const previousRsvps = [...dbRSVPs];

        // Optimistic update
        setDbRSVPs(prev => prev.filter(r => r.event_id !== eventId));

        try {
          const res = await fetch(`/api/rsvps/${eventId}/${encodeURIComponent(user.email)}`, {
            method: 'DELETE',
            credentials: 'include'
          });
          if (res.ok) {
            showToast('RSVP cancelled', 'success');
          } else {
            // Revert on failure
            setDbRSVPs(previousRsvps);
            showToast('Failed to cancel RSVP', 'error');
          }
        } catch (err) {
          // Revert on error
          setDbRSVPs(previousRsvps);
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
        
        // Store previous state
        const previousWellness = [...dbWellnessEnrollments];

        // Optimistic update
        setDbWellnessEnrollments(prev => prev.filter(w => w.class_id !== classId));

        try {
          const res = await fetch(`/api/wellness-enrollments/${classId}/${encodeURIComponent(user.email)}`, {
            method: 'DELETE',
            credentials: 'include'
          });
          if (res.ok) {
            showToast('Enrollment cancelled', 'success');
          } else {
            // Revert on failure
            setDbWellnessEnrollments(previousWellness);
            showToast('Failed to cancel enrollment', 'error');
          }
        } catch (err) {
          // Revert on error
          setDbWellnessEnrollments(previousWellness);
          showToast('Failed to cancel enrollment', 'error');
        }
      }
    });
  };

  const handleAcceptInvite = async (bookingId: number) => {
    setProcessingInviteId(bookingId);
    try {
      // When admin is viewing as a member, pass the member's email so the backend knows who to act for
      const body = isAdminViewingAs && user?.email ? { onBehalfOf: user.email } : {};
      
      const result = await apiRequest(`/api/bookings/${bookingId}/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      if (result.ok) {
        showToast('Invite accepted!', 'success');
        await fetchUserData(false);
      } else {
        showToast(result.error || 'Failed to accept invite', 'error');
      }
    } catch (err) {
      showToast('Failed to accept invite', 'error');
    } finally {
      setProcessingInviteId(null);
    }
  };

  const handleDeclineInvite = (bookingId: number, primaryBookerName?: string | null) => {
    setConfirmModal({
      isOpen: true,
      title: "Decline Invite",
      message: `Are you sure you want to decline this booking invite${primaryBookerName ? ` from ${primaryBookerName}` : ''}? This will remove you from the booking.`,
      onConfirm: async () => {
        setConfirmModal(null);
        setProcessingInviteId(bookingId);
        
        try {
          // When admin is viewing as a member, pass the member's email so the backend knows who to act for
          const body = isAdminViewingAs && user?.email ? { onBehalfOf: user.email } : {};
          
          const result = await apiRequest(`/api/bookings/${bookingId}/invite/decline`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          
          if (result.ok) {
            showToast('Invite declined', 'success');
            await fetchUserData(false);
          } else {
            showToast(result.error || 'Failed to decline invite', 'error');
          }
        } catch (err) {
          showToast('Failed to decline invite', 'error');
        } finally {
          setProcessingInviteId(null);
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

  const formatLastVisit = (dateStr: string | undefined) => {
    if (!dateStr) return null;
    return formatDateTimePacific(dateStr);
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
          onRetry={() => fetchUserData()}
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
    <PullToRefresh onRefresh={handleRefresh} className="flex-1 flex flex-col">
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
        
        <WelcomeBanner />
        
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
                  className={`relative h-48 lg:h-full lg:min-h-48 w-full rounded-[1.5rem] overflow-hidden cursor-pointer transform transition-transform active:scale-95 shadow-layered group animate-slide-up-stagger ${isExpired ? 'grayscale-[30%]' : ''}`}
                  style={{ '--stagger-index': 2 } as React.CSSProperties}
                >
                  <div className="absolute inset-0" style={{ backgroundColor: cardBgColor }}></div>
                  <div className="absolute inset-0 bg-glossy opacity-50"></div>
                  <div className="absolute inset-0 p-6 flex flex-col justify-between z-10">
                    <div className="flex justify-between items-start">
                      <img src={useDarkLogo ? "/assets/logos/monogram-dark.webp" : "/assets/logos/monogram-white.webp"} className={`w-8 h-8 ${isExpired ? 'opacity-50' : 'opacity-90'}`} alt="" />
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: `${cardTextColor}99` }}>Ever House</span>
                        {isExpired && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-500 text-white">
                            Expired
                          </span>
                        )}
                        {!isExpired && (user?.tags || []).map((tag) => (
                          <TagBadge key={tag} tag={tag} size="sm" />
                        ))}
                        {!isExpired && !user?.tags?.length && isFoundingMember(user?.tier || '', user?.isFounding) && (
                          <TagBadge tag="Founding Member" size="sm" />
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <TierBadge tier={user?.tier || 'Social'} size="sm" />
                      </div>
                      <h3 className="text-xl font-bold tracking-wide" style={{ color: cardTextColor }}>{user?.name}</h3>
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
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity backdrop-blur-sm z-20">
                    <span className="font-bold text-sm text-white">{isExpired ? 'Renew Membership' : 'View Membership Details'}</span>
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

        {/* My Balance Section */}
        {!isStaffOrAdminProfile && user?.email && (
          <div className="mb-6 animate-slide-up-stagger" style={{ '--stagger-index': 2 } as React.CSSProperties}>
            <BalanceCard 
              key={`${balanceRefreshKey}-${user.email}`}
              memberEmail={user.email}
              onPayNow={() => setShowBalancePaymentModal(true)} 
            />
          </div>
        )}

        {error ? (
        <div className="p-4 rounded-xl bg-red-500/20 border border-red-500/30 text-red-300 text-sm flex items-center gap-3 mb-6">
          <span className="material-symbols-outlined">error</span>
          {error}
        </div>
      ) : (
        <>
          {/* Pending Invites Section */}
          {pendingInvites.length > 0 && (
            <div className="mb-6 animate-slide-up-stagger" style={{ '--stagger-index': 3 } as React.CSSProperties}>
              <div className="flex justify-between items-center mb-4 px-1">
                <h3 className={`text-sm font-bold uppercase tracking-wider ${isDark ? 'text-amber-400/90' : 'text-amber-600'}`}>
                  <span className="material-symbols-outlined text-base mr-1 align-text-bottom">mail</span>
                  Pending Invites ({pendingInvites.length})
                </h3>
              </div>
              <div className="space-y-3">
                {pendingInvites.map((invite, idx) => (
                  <div 
                    key={`invite-${invite.id}`}
                    className={`rounded-2xl p-4 border ${isDark ? 'bg-amber-900/20 border-amber-500/30' : 'bg-amber-50 border-amber-200'} animate-slide-up-stagger`}
                    style={{ '--stagger-index': idx + 3 } as React.CSSProperties}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
                          <span className={`material-symbols-outlined text-xl ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>sports_golf</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className={`font-bold text-sm ${isDark ? 'text-white' : 'text-primary'}`}>
                            {invite.resource_name || invite.bay_name || 'Simulator'}
                          </h4>
                          <p className={`text-xs mt-0.5 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                            {formatDate(invite.request_date)} • {formatTime12Hour(invite.start_time)} - {formatTime12Hour(invite.end_time)}
                          </p>
                          {invite.primary_booker_name && (
                            <p className={`text-xs mt-1 ${isDark ? 'text-amber-400/80' : 'text-amber-600/80'}`}>
                              Invited by {invite.primary_booker_name.split(' ')[0]}
                            </p>
                          )}
                        </div>
                      </div>
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full flex-shrink-0 ${isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700'}`}>
                        Invite
                      </span>
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => handleAcceptInvite(invite.id)}
                        disabled={processingInviteId === invite.id}
                        className={`flex-1 py-2.5 rounded-xl font-bold text-sm flex items-center justify-center gap-1.5 transition-all ${
                          processingInviteId === invite.id 
                            ? 'opacity-50 cursor-not-allowed' 
                            : 'hover:scale-[0.98] active:scale-95'
                        } ${isDark ? 'bg-brand-green text-white' : 'bg-brand-green text-white'}`}
                      >
                        {processingInviteId === invite.id ? (
                          <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
                        ) : (
                          <span className="material-symbols-outlined text-base">check</span>
                        )}
                        Accept
                      </button>
                      <button
                        onClick={() => handleDeclineInvite(invite.id, invite.primary_booker_name)}
                        disabled={processingInviteId === invite.id}
                        className={`flex-1 py-2.5 rounded-xl font-bold text-sm flex items-center justify-center gap-1.5 transition-all ${
                          processingInviteId === invite.id 
                            ? 'opacity-50 cursor-not-allowed' 
                            : 'hover:scale-[0.98] active:scale-95'
                        } ${isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-primary hover:bg-gray-200'}`}
                      >
                        <span className="material-symbols-outlined text-base">close</span>
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Your Schedule - Combined Bookings, Events & Wellness */}
          <div className="animate-slide-up-stagger" style={{ '--stagger-index': 4 } as React.CSSProperties}>
            <div className="flex justify-between items-center mb-4 px-1">
              <h3 className={`text-sm font-bold uppercase tracking-wider ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Your Schedule</h3>
              <button
                onClick={() => { startNavigation(); navigate('/book'); }}
                className={`text-xs font-semibold flex items-center gap-1 ${isDark ? 'text-accent' : 'text-brand-green'}`}
                aria-label="Book new"
              >
                <span className="material-symbols-outlined text-base">add</span>
                Book
              </button>
            </div>
            <div className="space-y-3">
              {upcomingItemsFiltered.length > 0 ? upcomingItemsFiltered.slice(0, 6).map((item, idx) => {
                let actions;
                if (item.type === 'booking' || item.type === 'booking_request') {
                  const bookingStatus = (item as any).status;
                  const isConfirmed = bookingStatus === 'approved' || bookingStatus === 'confirmed';
                  const rawBooking = item.raw as DBBookingRequest | DBBooking;
                  const startTime24 = 'start_time' in rawBooking ? rawBooking.start_time : '';
                  const endTime24 = 'end_time' in rawBooking ? rawBooking.end_time : '';
                  const isLinkedMember = (item as any).isLinkedMember || false;
                  
                  // Check for unpaid overage fee
                  const hasUnpaidOverage = 'overage_fee_cents' in rawBooking && 
                    rawBooking.overage_fee_cents && 
                    rawBooking.overage_fee_cents > 0 && 
                    !rawBooking.overage_paid;
                  const overageAmount = hasUnpaidOverage ? (rawBooking.overage_fee_cents! / 100).toFixed(2) : null;
                  
                  const primaryBookerName = (item as any).primaryBookerName;
                  actions = [
                    // Pay Now button for unpaid overage fees (appears first)
                    ...(hasUnpaidOverage && !isLinkedMember ? [{
                      icon: 'payment',
                      label: `Pay $${overageAmount}`,
                      onClick: () => setOveragePaymentBooking({ id: item.dbId, amount: rawBooking.overage_fee_cents!, minutes: rawBooking.overage_minutes || 0 }),
                      highlight: true
                    }] : []),
                    ...(isConfirmed ? [{
                      icon: 'calendar_add_on',
                      label: 'Add to Calendar',
                      onClick: () => downloadICalFile({
                        title: `${item.title} - Even House`,
                        description: `Your ${item.resourceType === 'conference_room' ? 'conference room' : 'golf simulator'} booking at Even House`,
                        location: 'Even House, 15771 Red Hill Ave, Ste 500, Tustin, CA 92780',
                        startDate: item.rawDate,
                        startTime: startTime24,
                        endTime: endTime24
                      }, `EvenHouse_${item.rawDate}_${item.title.replace(/[^a-zA-Z0-9]/g, '_')}.ics`)
                    }] : []),
                    ...(!isLinkedMember ? [
                      { icon: 'event_repeat', label: 'Reschedule', onClick: () => { startNavigation(); navigate(`/book?reschedule=${item.dbId}&date=${item.rawDate}`); } },
                      { icon: 'close', label: 'Cancel', onClick: () => handleCancelBooking(item.dbId, item.type) }
                    ] : []),
                    // Allow linked members (guests) to leave the booking
                    ...(isLinkedMember && isConfirmed ? [{
                      icon: 'logout',
                      label: 'Leave',
                      onClick: () => handleLeaveBooking(item.dbId, primaryBookerName)
                    }] : [])
                  ];
                } else if (item.type === 'rsvp') {
                  actions = [{ icon: 'close', label: 'Cancel RSVP', onClick: () => handleCancelRSVP((item.raw as DBRSVP).event_id) }];
                } else if (item.type === 'wellness') {
                  actions = [{ icon: 'close', label: 'Cancel', onClick: () => handleCancelWellness((item.raw as DBWellnessEnrollment).class_id) }];
                } else {
                  actions = [];
                }
                const getStatusBadge = () => {
                  if (item.type !== 'booking' && item.type !== 'booking_request') return null;
                  const status = (item as any).status;
                  const isLinked = (item as any).isLinkedMember || false;
                  const rawBooking = item.raw as DBBookingRequest;
                  
                  const badges: React.ReactNode[] = [];
                  
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
                        {formatStatusLabel(status)}
                      </span>
                    );
                  }
                  
                  // Add payment status badge for confirmed bookings with fees
                  if ((status === 'confirmed' || status === 'attended') && !isLinked) {
                    const hasOverage = rawBooking.overage_fee_cents && rawBooking.overage_fee_cents > 0;
                    const overagePaid = rawBooking.overage_paid;
                    
                    if (hasOverage) {
                      if (overagePaid) {
                        badges.push(
                          <span key="payment" className="px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs">check_circle</span>
                            Paid
                          </span>
                        );
                      } else {
                        badges.push(
                          <span key="payment" className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs">schedule</span>
                            ${(rawBooking.overage_fee_cents / 100).toFixed(0)} due
                          </span>
                        );
                      }
                    }
                  }
                  
                  if (badges.length === 0) return null;
                  return <div className="flex gap-1.5 flex-wrap">{badges}</div>;
                };
                const isSimulatorBooking = item.resourceType === 'simulator';
                const isApprovedOrConfirmed = ['approved', 'confirmed'].includes((item as any).status);
                const isOwnerOfBooking = !((item as any).isLinkedMember);
                const showRosterManager = (item.type === 'booking' || item.type === 'booking_request') && 
                  isSimulatorBooking && 
                  isApprovedOrConfirmed && 
                  isOwnerOfBooking;
                const rawBookingData = item.raw as DBBookingRequest;

                return (
                  <React.Fragment key={item.id}>
                    <GlassRow 
                      title={item.title} 
                      subtitle={`${item.date} • ${item.details}`} 
                      icon={getIconForType(item.resourceType)} 
                      color={isDark ? "text-[#E7E7DC]" : "text-primary"}
                      actions={actions}
                      staggerIndex={idx + 4}
                      badge={getStatusBadge()}
                    />
                    {showRosterManager && (
                      <div className="mt-2 mb-4">
                        <RosterManager
                          bookingId={item.dbId}
                          declaredPlayerCount={rawBookingData.declared_player_count || 1}
                          isOwner={isOwnerOfBooking}
                          isStaff={isStaffOrAdminProfile}
                          onUpdate={() => fetchUserData(false)}
                        />
                      </div>
                    )}
                  </React.Fragment>
                );
              }) : (
                <div className="flex flex-col items-center justify-center text-center py-8 px-6 animate-pop-in">
                  <div className="relative mb-4">
                    <div className={`w-16 h-16 rounded-full flex items-center justify-center relative ${isDark ? 'bg-lavender/20' : 'bg-gradient-to-br from-brand-bone to-secondary'}`}>
                      <span className={`material-symbols-outlined text-3xl ${isDark ? 'text-lavender' : 'text-primary/80'}`}>calendar_month</span>
                    </div>
                  </div>
                  <h3 className={`text-lg font-semibold mb-1 ${isDark ? 'text-white' : 'text-primary'}`}>Nothing scheduled</h3>
                  <p className={`text-sm max-w-[280px] ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                    Book a simulator, RSVP to events, or enroll in wellness classes.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      </div>
    </PullToRefresh>

    <ModalShell 
      isOpen={!!confirmModal} 
      onClose={() => setConfirmModal(null)}
      title={confirmModal?.title || ''}
      size="sm"
    >
      {confirmModal && (
        <div className="p-6">
          <p className={`mb-6 text-sm ${isDark ? 'opacity-70' : 'opacity-70'}`}>{confirmModal.message}</p>
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
        try {
          const res = await fetch(`/api/guest-passes/${encodeURIComponent(user?.email || '')}?tier=${encodeURIComponent(user?.tier || 'Social')}`, { credentials: 'include' });
          if (!res.ok) throw new Error('Failed to refresh guest passes');
          const data = await res.json();
          setGuestPasses(data);
        } catch (err) {
          console.error('Error refreshing guest passes:', err);
        }
      }}
    />

    {/* Balance Payment Modal */}
    {showBalancePaymentModal && user && (
      <BalancePaymentModal
        memberEmail={user.email}
        memberName={user.name}
        onSuccess={() => {
          setShowBalancePaymentModal(false);
          setBalanceRefreshKey(prev => prev + 1);
          showToast('Payment successful! Your balance has been cleared.', 'success');
        }}
        onClose={() => setShowBalancePaymentModal(false)}
      />
    )}

    {/* Overage Payment Modal */}
    <ModalShell
      isOpen={!!overagePaymentBooking}
      onClose={() => !isPayingOverage && setOveragePaymentBooking(null)}
      title="Pay Simulator Overage Fee"
      size="sm"
    >
      {overagePaymentBooking && (
        <div className="p-6 space-y-4">
          <div className="text-center">
            <p className="text-lg font-semibold text-primary dark:text-white mb-2">
              ${(overagePaymentBooking.amount / 100).toFixed(2)}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Overage: {overagePaymentBooking.minutes} minutes ({Math.ceil(overagePaymentBooking.minutes / 30)} x 30 min @ $25)
            </p>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This fee is for simulator usage exceeding your membership tier's daily allowance. Payment is required before check-in.
          </p>
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setOveragePaymentBooking(null)}
              disabled={isPayingOverage}
              className="flex-1 py-3 px-4 rounded-xl border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-medium disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                setIsPayingOverage(true);
                try {
                  const res = await fetch('/api/stripe/overage/create-payment-intent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ bookingId: overagePaymentBooking.id })
                  });
                  if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || 'Failed to create payment');
                  }
                  const data = await res.json();
                  // Open Stripe checkout in new window
                  const stripe = await import('@stripe/stripe-js').then(mod => mod.loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY || ''));
                  if (stripe && data.clientSecret) {
                    const { error: paymentError } = await stripe.confirmPayment({
                      clientSecret: data.clientSecret,
                      confirmParams: {
                        return_url: `${window.location.origin}/dashboard?overage_paid=true&booking_id=${overagePaymentBooking.id}`,
                      },
                    });
                    if (paymentError) {
                      throw new Error(paymentError.message);
                    }
                  }
                } catch (err: any) {
                  showToast(err.message || 'Payment failed', 'error');
                  setIsPayingOverage(false);
                }
              }}
              disabled={isPayingOverage}
              className="flex-1 py-3 px-4 rounded-xl bg-primary text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isPayingOverage ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                  Processing...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-base">payment</span>
                  Pay Now
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </ModalShell>

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
        const baseTier = getBaseTier(user.tier || 'Social');
        const useDarkLogo = isExpiredModal || (!isStaffOrAdminProfile && ['Social', 'Premium', 'VIP'].includes(baseTier));
        return (
          <div className="flex flex-col items-center">
            <div className={`w-full rounded-[2rem] relative overflow-hidden shadow-2xl flex flex-col ${isExpiredModal ? 'grayscale-[30%]' : ''}`} style={{ backgroundColor: cardBgColor }}>
              
              {/* Close Button */}
              <button onClick={() => setIsCardOpen(false)} className="absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center z-10" style={{ backgroundColor: `${cardTextColor}33`, color: cardTextColor }}>
                <span className="material-symbols-outlined text-sm">close</span>
              </button>

              {/* Header with Logo */}
              <div className="pt-6 pb-4 px-6 flex justify-center" style={{ backgroundColor: cardBgColor }}>
                <img src={useDarkLogo ? "/assets/logos/monogram-dark.webp" : "/assets/logos/monogram-white.webp"} className="w-12 h-12" alt="" />
              </div>
              
              {/* Member Info */}
              <div className="px-6 pb-6 text-center" style={{ backgroundColor: cardBgColor }}>
                <h2 className="text-2xl font-bold mb-3" style={{ color: cardTextColor }}>{user.name}</h2>
                
                <div className="flex items-center justify-center gap-2 flex-wrap mb-2">
                  <TierBadge tier={user.tier || 'Social'} size="md" />
                  {isExpiredModal && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-red-500 text-white">
                      Expired
                    </span>
                  )}
                </div>
                {!isExpiredModal && ((user.tags || []).length > 0 || isFoundingMember(user.tier || '', user.isFounding)) && (
                  <div className="flex items-center justify-center gap-2 flex-wrap">
                    {(user.tags || []).map((tag) => (
                      <TagBadge key={tag} tag={tag} size="sm" />
                    ))}
                    {!user.tags?.length && isFoundingMember(user.tier || '', user.isFounding) && (
                      <TagBadge tag="Founding Member" size="sm" />
                    )}
                  </div>
                )}
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

              {/* Benefits Section */}
              <div className="px-6 pb-6" style={{ backgroundColor: cardBgColor }}>
                <div className="rounded-xl p-4 space-y-3" style={{ backgroundColor: `${cardTextColor}10` }}>
                  <h3 className="text-xs font-bold uppercase tracking-wider opacity-60 mb-3" style={{ color: cardTextColor }}>Membership Benefits</h3>
                  
                  {user.joinDate && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-base opacity-70" style={{ color: cardTextColor }}>event</span>
                        <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Member Since</span>
                      </div>
                      <span className="text-sm font-semibold" style={{ color: cardTextColor }}>{formatMemberSince(user.joinDate)}</span>
                    </div>
                  )}

                  {user.lastBookingDate && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-base opacity-70" style={{ color: cardTextColor }}>schedule</span>
                        <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Last Visited</span>
                      </div>
                      <span className="text-sm font-semibold" style={{ color: cardTextColor }}>{formatLastVisit(user.lastBookingDate)}</span>
                    </div>
                  )}
                  
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="material-symbols-outlined text-base opacity-70" style={{ color: cardTextColor }}>calendar_month</span>
                      <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Advance Booking</span>
                    </div>
                    <span className="text-sm font-semibold" style={{ color: cardTextColor }}>
                      {tierPermissions.unlimitedAccess ? 'Unlimited' : `${tierPermissions.advanceBookingDays} days`}
                    </span>
                  </div>
                  
                  {tierPermissions.canBookSimulators && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-base opacity-70" style={{ color: cardTextColor }}>sports_golf</span>
                        <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Daily Sim Time</span>
                      </div>
                      <span className="text-sm font-semibold" style={{ color: cardTextColor }}>
                        {tierPermissions.unlimitedAccess ? 'Unlimited' : `${tierPermissions.dailySimulatorMinutes} min`}
                      </span>
                    </div>
                  )}
                  
                  {guestPasses && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-base opacity-70" style={{ color: cardTextColor }}>group_add</span>
                        <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Guest Passes</span>
                      </div>
                      <span className="text-sm font-semibold" style={{ color: cardTextColor }}>
                        {guestPasses.passes_remaining} / {guestPasses.passes_total}
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
    </>
    )}
  </div>
  </SmoothReveal>
  </AnimatedPage>
  );
};

export default Dashboard;
