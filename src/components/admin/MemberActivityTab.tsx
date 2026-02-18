import React, { useState, useMemo } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import type { BookingHistoryItem as BaseBookingHistoryItem, EventRsvpItem as BaseEventRsvpItem, WellnessHistoryItem as BaseWellnessHistoryItem, VisitHistoryItem } from '../memberProfile/memberProfileTypes';

type BookingHistoryItem = BaseBookingHistoryItem & { bookingDate?: string; requestDate?: string; bayName?: string; resourceName?: string };
type EventRsvpItem = BaseEventRsvpItem & { eventDate?: string; eventTitle?: string };
type WellnessHistoryItem = BaseWellnessHistoryItem & { classDate?: string; className?: string; classTitle?: string };

interface MemberActivityTabProps {
  memberEmail: string;
  bookingHistory: BookingHistoryItem[];
  bookingRequestsHistory: BookingHistoryItem[];
  eventRsvpHistory: EventRsvpItem[];
  wellnessHistory: WellnessHistoryItem[];
  visitHistory: VisitHistoryItem[];
  onCancelBooking?: (bookingId: number) => Promise<void>;
  onConfirmBookingRequest?: (requestId: number) => Promise<void>;
}

type ActivityFilter = 'all' | 'bookings' | 'events' | 'wellness' | 'visits';

interface ActivityItem {
  id: string;
  type: 'booking' | 'event' | 'wellness' | 'visit';
  date: Date;
  data: BookingHistoryItem | EventRsvpItem | WellnessHistoryItem | VisitHistoryItem;
}

const FILTER_TABS: { id: ActivityFilter; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: 'list' },
  { id: 'bookings', label: 'Bookings', icon: 'golf_course' },
  { id: 'events', label: 'Events', icon: 'celebration' },
  { id: 'wellness', label: 'Wellness', icon: 'spa' },
  { id: 'visits', label: 'Visits', icon: 'check_circle' },
];

const formatDatePacific = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '';
  try {
    const normalizedDate = dateStr.includes('T') ? dateStr : `${dateStr}T12:00:00`;
    const d = new Date(normalizedDate);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  } catch {
    return dateStr || '';
  }
};

const formatTime12Hour = (timeStr: string): string => {
  if (!timeStr) return '';
  const [hours, minutes] = timeStr.substring(0, 5).split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${period}`;
};

const getStatusBadgeStyle = (status: string, isDark: boolean): string => {
  switch (status) {
    case 'attended':
      return 'bg-green-100 text-green-700';
    case 'approved':
    case 'confirmed':
      return 'bg-blue-100 text-blue-700';
    case 'pending':
      return 'bg-yellow-100 text-yellow-700';
    case 'no_show':
      return 'bg-orange-100 text-orange-700';
    case 'cancellation_pending':
      return 'bg-orange-100 text-orange-700';
    case 'cancelled':
    case 'declined':
      return 'bg-red-100 text-red-700';
    case 'enrolled':
      return 'bg-green-100 text-green-700';
    default:
      return 'bg-gray-100 text-gray-700';
  }
};

const getTypeIcon = (type: 'booking' | 'event' | 'wellness' | 'visit'): string => {
  switch (type) {
    case 'booking':
      return 'golf_course';
    case 'event':
      return 'celebration';
    case 'wellness':
      return 'spa';
    case 'visit':
      return 'check_circle';
    default:
      return 'event';
  }
};

const getTypeColor = (type: 'booking' | 'event' | 'wellness' | 'visit'): string => {
  switch (type) {
    case 'booking':
      return 'text-brand-green';
    case 'event':
      return 'text-purple-500';
    case 'wellness':
      return 'text-pink-500';
    case 'visit':
      return 'text-emerald-500';
    default:
      return 'text-gray-500';
  }
};

const EmptyState: React.FC<{ icon: string; message: string; isDark: boolean }> = ({ icon, message, isDark }) => (
  <div className="flex flex-col items-center justify-center py-12">
    <span className={`material-symbols-outlined text-4xl mb-3 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>{icon}</span>
    <p className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>{message}</p>
  </div>
);

const MemberActivityTab: React.FC<MemberActivityTabProps> = ({
  memberEmail,
  bookingHistory,
  bookingRequestsHistory,
  eventRsvpHistory,
  wellnessHistory,
  visitHistory,
  onCancelBooking,
  onConfirmBookingRequest,
}) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const [activeFilter, setActiveFilter] = useState<ActivityFilter>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const allActivities = useMemo(() => {
    const activities: ActivityItem[] = [];

    const filteredBookingHistory = (bookingHistory || []).filter((b: BookingHistoryItem) => b.status !== 'cancelled' && b.status !== 'declined');
    const filteredBookingRequestsHistory = (bookingRequestsHistory || []).filter((b: BookingHistoryItem) => b.status !== 'cancelled' && b.status !== 'declined');

    filteredBookingHistory.forEach((booking: BookingHistoryItem) => {
      const dateStr = booking.bookingDate || booking.requestDate;
      activities.push({
        id: `booking-${booking.id}`,
        type: 'booking',
        date: new Date(dateStr?.includes('T') ? dateStr : `${dateStr}T12:00:00`),
        data: { ...booking, source: 'confirmed' },
      });
    });

    filteredBookingRequestsHistory.forEach((booking: BookingHistoryItem) => {
      const dateStr = booking.bookingDate || booking.requestDate;
      activities.push({
        id: `booking-request-${booking.id}`,
        type: 'booking',
        date: new Date(dateStr?.includes('T') ? dateStr : `${dateStr}T12:00:00`),
        data: { ...booking, source: 'request' },
      });
    });

    (eventRsvpHistory || []).forEach((rsvp: EventRsvpItem) => {
      const dateStr = rsvp.eventDate;
      activities.push({
        id: `event-${rsvp.id}`,
        type: 'event',
        date: new Date(dateStr?.includes('T') ? dateStr : `${dateStr}T12:00:00`),
        data: rsvp,
      });
    });

    (wellnessHistory || []).forEach((enrollment: WellnessHistoryItem) => {
      const dateStr = enrollment.classDate;
      activities.push({
        id: `wellness-${enrollment.id}`,
        type: 'wellness',
        date: new Date(dateStr?.includes('T') ? dateStr : `${dateStr}T12:00:00`),
        data: enrollment,
      });
    });

    (visitHistory || []).filter((v: VisitHistoryItem & { isWalkIn?: boolean }) => v.isWalkIn).forEach((visit: VisitHistoryItem) => {
      const dateStr = visit.bookingDate;
      activities.push({
        id: `walkin-${visit.id}`,
        type: 'visit',
        date: new Date(dateStr),
        data: { ...visit, role: 'Walk-in' },
      });
    });

    activities.sort((a, b) => b.date.getTime() - a.date.getTime());

    return activities;
  }, [bookingHistory, bookingRequestsHistory, eventRsvpHistory, wellnessHistory, visitHistory]);

  const filteredActivities = useMemo(() => {
    if (activeFilter === 'all') return allActivities;
    
    // For "visits" filter, show attended activities:
    // - Simulator bookings that are in visitHistory (status='attended' or past approved lounge)
    // - Past event RSVPs
    // - Wellness classes with status='attended'
    if (activeFilter === 'visits') {
      const now = new Date();
      const visitHistoryIds = new Set((visitHistory || []).map((v: VisitHistoryItem) => v.id));
      return allActivities.filter(a => {
        if (a.type === 'visit') return true;
        if (a.type === 'booking' && visitHistoryIds.has(a.data?.id)) return true;
        if (a.type === 'event') {
          const eventDate = new Date(a.data?.eventDate);
          return eventDate < now;
        }
        if (a.type === 'wellness' && a.data?.status === 'attended') return true;
        return false;
      });
    }
    
    const filterMap: Record<ActivityFilter, string> = {
      all: 'all',
      bookings: 'booking',
      events: 'event',
      wellness: 'wellness',
      visits: 'visit', // This won't match anything now, handled above
    };
    return allActivities.filter(a => a.type === filterMap[activeFilter]);
  }, [allActivities, activeFilter]);

  const handleCancelBooking = async (bookingId: number) => {
    if (!onCancelBooking) return;
    setActionLoading(`cancel-${bookingId}`);
    try {
      await onCancelBooking(bookingId);
    } finally {
      setActionLoading(null);
    }
  };

  const handleConfirmBookingRequest = async (requestId: number) => {
    if (!onConfirmBookingRequest) return;
    setActionLoading(`confirm-${requestId}`);
    try {
      await onConfirmBookingRequest(requestId);
    } finally {
      setActionLoading(null);
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case 'Host': return 'star';
      case 'Player': return 'group';
      case 'Guest': return 'person_add';
      case 'Wellness': return 'spa';
      case 'Event': return 'event';
      default: return 'check_circle';
    }
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'Host': return 'bg-brand-green text-white';
      case 'Player': return 'bg-blue-500 text-white';
      case 'Guest': return 'bg-orange-500 text-white';
      case 'Wellness': return 'bg-purple-500 text-white';
      case 'Event': return 'bg-pink-500 text-white';
      default: return 'bg-gray-500 text-white';
    }
  };

  const renderBookingItem = (booking: BookingHistoryItem) => {
    const canConfirm = booking.source === 'request' && booking.status === 'pending' && onConfirmBookingRequest;
    const canCancel = (booking.status === 'approved' || booking.status === 'confirmed' || booking.status === 'pending') && onCancelBooking;
    const isConfirmLoading = actionLoading === `confirm-${booking.id}`;
    const isCancelLoading = actionLoading === `cancel-${booking.id}`;

    return (
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {booking.resourceName || booking.resourceType || 'Booking'}
          </span>
          <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${getStatusBadgeStyle(booking.status, isDark)}`}>
            {booking.status === 'no_show' ? 'No Show' : booking.status === 'cancellation_pending' ? 'Cancellation Pending' : booking.status}
          </span>
          {booking.guestCount > 0 && (
            <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              +{booking.guestCount} guest{booking.guestCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          {formatDatePacific(booking.bookingDate || booking.requestDate)} · {formatTime12Hour(booking.startTime)} - {formatTime12Hour(booking.endTime)}
        </p>
        {booking.notes && <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'} line-clamp-1`}>{booking.notes}</p>}
        {(canConfirm || canCancel) && (
          <div className="flex gap-2 mt-2">
            {canConfirm && (
              <button
                onClick={() => handleConfirmBookingRequest(booking.id)}
                disabled={isConfirmLoading}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-colors tactile-btn ${
                  isConfirmLoading
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-green-100 text-green-700 hover:bg-green-200'
                }`}
              >
                {isConfirmLoading ? 'Confirming...' : 'Confirm'}
              </button>
            )}
            {canCancel && (
              <button
                onClick={() => handleCancelBooking(booking.id)}
                disabled={isCancelLoading}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-colors tactile-btn ${
                  isCancelLoading
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-red-100 text-red-700 hover:bg-red-200'
                }`}
              >
                {isCancelLoading ? 'Cancelling...' : 'Cancel'}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderEventItem = (rsvp: EventRsvpItem) => (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{rsvp.eventTitle}</span>
        {rsvp.checkedIn && <span className="material-symbols-outlined text-green-500 text-sm">check_circle</span>}
      </div>
      <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        {formatDatePacific(rsvp.eventDate)} · {rsvp.eventLocation}
      </p>
      {rsvp.ticketClass && <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>Ticket: {rsvp.ticketClass}</p>}
    </div>
  );

  const renderWellnessItem = (enrollment: WellnessHistoryItem) => (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{enrollment.classTitle}</span>
        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${getStatusBadgeStyle(enrollment.status, isDark)}`}>
          {enrollment.status}
        </span>
      </div>
      <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        {formatDatePacific(enrollment.classDate)} · {enrollment.classTime}
      </p>
      {enrollment.instructor && <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>Instructor: {enrollment.instructor}</p>}
    </div>
  );

  const renderVisitItem = (visit: VisitHistoryItem & { isWalkIn?: boolean; resource_name?: string; check_in_time?: string }) => (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-outlined text-green-500 text-lg">{visit.isWalkIn ? 'qr_code_scanner' : getRoleIcon(visit.role)}</span>
        <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{visit.resourceName || 'Visit'}</span>
        {visit.role && (
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${visit.isWalkIn ? 'bg-emerald-500 text-white' : getRoleBadgeColor(visit.role)}`}>
            {visit.role}
          </span>
        )}
      </div>
      <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        {formatDatePacific(visit.date || visit.bookingDate)}
        {visit.startTime && <> · {formatTime12Hour(visit.startTime)}{visit.endTime && ` - ${formatTime12Hour(visit.endTime)}`}</>}
      </p>
      {visit.checkedInBy && (
        <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
          Checked in by {visit.checkedInBy}
        </p>
      )}
      {visit.hostName && visit.role === 'Guest' && (
        <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
          Invited by {visit.hostName}
        </p>
      )}
      {visit.instructor && (
        <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
          Instructor: {visit.instructor}
        </p>
      )}
      {visit.location && (
        <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
          {visit.location}
        </p>
      )}
    </div>
  );

  const renderActivityItem = (activity: ActivityItem) => {
    const { type, data } = activity;

    return (
      <div key={activity.id} className={`p-4 rounded-xl tactile-row ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-start gap-3">
          <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
            <span className={`material-symbols-outlined text-lg ${getTypeColor(type)}`}>
              {getTypeIcon(type)}
            </span>
          </div>
          {type === 'booking' && renderBookingItem(data)}
          {type === 'event' && renderEventItem(data)}
          {type === 'wellness' && renderWellnessItem(data)}
          {type === 'visit' && renderVisitItem(data)}
        </div>
      </div>
    );
  };

  const getCounts = () => {
    const filteredBookingHistory = (bookingHistory || []).filter((b: BookingHistoryItem) => b.status !== 'cancelled' && b.status !== 'declined');
    const filteredBookingRequestsHistory = (bookingRequestsHistory || []).filter((b: BookingHistoryItem) => b.status !== 'cancelled' && b.status !== 'declined');
    
    // Count visits: use visitHistory (attended simulator bookings) + past events + attended wellness
    // This matches the backend attendedVisitsCount calculation
    const attendedBookingsCount = visitHistory?.length || 0;
    const pastEventsCount = (eventRsvpHistory || []).filter((e: EventRsvpItem) => {
      const eventDate = new Date(e.eventDate);
      return eventDate < new Date(); // Past events count as attended
    }).length;
    const attendedWellnessCount = (wellnessHistory || []).filter((w: WellnessHistoryItem) => w.status === 'attended').length;
    
    return {
      all: allActivities.length,
      bookings: filteredBookingHistory.length + filteredBookingRequestsHistory.length,
      events: eventRsvpHistory?.length || 0,
      wellness: wellnessHistory?.length || 0,
      visits: attendedBookingsCount + pastEventsCount + attendedWellnessCount,
    };
  };

  const counts = getCounts();

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 sm:gap-2 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveFilter(tab.id)}
            className={`flex-shrink-0 flex items-center justify-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              activeFilter === tab.id
                ? isDark
                  ? 'bg-accent text-primary'
                  : 'bg-primary text-white'
                : isDark
                  ? 'bg-white/5 text-gray-400 hover:bg-white/10'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
            title={tab.label}
          >
            <span className="material-symbols-outlined text-sm">{tab.icon}</span>
            <span className="hidden sm:inline">{tab.label}</span>
            <span className={`text-[10px] px-1 sm:px-1.5 py-0.5 rounded-full ${
              activeFilter === tab.id
                ? isDark
                  ? 'bg-primary/20 text-primary'
                  : 'bg-white/20 text-white'
                : isDark
                  ? 'bg-white/10 text-gray-500'
                  : 'bg-gray-200 text-gray-500'
            }`}>
              {counts[tab.id]}
            </span>
          </button>
        ))}
      </div>

      {filteredActivities.length === 0 ? (
        <EmptyState
          icon={activeFilter === 'all' ? 'event_busy' : FILTER_TABS.find(t => t.id === activeFilter)?.icon || 'event_busy'}
          message={activeFilter === 'all' ? 'No activity history found' : `No ${activeFilter} found`}
          isDark={isDark}
        />
      ) : (
        <div className="space-y-3">
          {filteredActivities.map(renderActivityItem)}
        </div>
      )}
    </div>
  );
};

export default MemberActivityTab;
