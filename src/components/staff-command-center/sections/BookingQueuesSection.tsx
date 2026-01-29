import React, { useMemo, useCallback, useState } from 'react';
import EmptyState from '../../EmptyState';
import { formatTime12Hour, getNowTimePacific, getTodayPacific, formatRelativeTime } from '../../../utils/dateUtils';
import { DateBlock, GlassListRow } from '../helpers';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import type { BookingRequest, TabType } from '../types';

interface BookingQueuesSectionProps {
  pendingRequests: BookingRequest[];
  todaysBookings: BookingRequest[];
  unmatchedBookings?: BookingRequest[];
  today: string;
  actionInProgress: string | null;
  onTabChange: (tab: TabType) => void;
  onOpenTrackman: (booking?: BookingRequest) => void;
  onApprove: (request: BookingRequest) => void;
  onDeny: (request: BookingRequest) => void;
  onCheckIn: (booking: BookingRequest) => void;
  onPaymentClick?: (bookingId: number) => void;
  onRosterClick?: (bookingId: number) => void;
  onAssignMember?: (booking: BookingRequest) => void;
  onEditBooking?: (booking: BookingRequest) => void;
  variant: 'desktop' | 'desktop-top' | 'desktop-bottom' | 'mobile';
}

export const BookingQueuesSection: React.FC<BookingQueuesSectionProps> = ({
  pendingRequests,
  todaysBookings,
  unmatchedBookings = [],
  today,
  actionInProgress,
  onTabChange,
  onOpenTrackman,
  onApprove,
  onDeny,
  onCheckIn,
  onPaymentClick,
  onRosterClick,
  onAssignMember,
  onEditBooking,
  variant
}) => {
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  const { execute: executeApprove } = useAsyncAction(
    async (request: BookingRequest) => {
      setLoadingAction(`approve-${request.id}`);
      try {
        await onApprove(request);
      } finally {
        setLoadingAction(null);
      }
    }
  );

  const { execute: executeDeny } = useAsyncAction(
    async (request: BookingRequest) => {
      setLoadingAction(`deny-${request.id}`);
      try {
        await onDeny(request);
      } finally {
        setLoadingAction(null);
      }
    }
  );

  const { execute: executeCheckIn } = useAsyncAction(
    async (booking: BookingRequest) => {
      setLoadingAction(`checkin-${booking.id}`);
      try {
        await onCheckIn(booking);
      } finally {
        setLoadingAction(null);
      }
    }
  );

  const isActionLoading = useCallback((actionKey: string) => {
    return loadingAction === actionKey || actionInProgress === actionKey;
  }, [loadingAction, actionInProgress]);

  const mergedUpcomingBookings = useMemo(() => {
    const nowTime = getNowTimePacific();
    const todayPacific = getTodayPacific();
    
    // Convert to strings for reliable Set comparison (avoids number vs string mismatch)
    const unmatchedTrackmanIds = new Set(
      unmatchedBookings
        .filter(b => b.trackman_booking_id)
        .map(b => String(b.trackman_booking_id))
    );
    const unmatchedBookingIds = new Set(unmatchedBookings.map(b => String(b.id)));
    
    const isUnmatchedBooking = (b: BookingRequest) => {
      return b.is_unmatched === true ||
        b.user_email === 'unmatched@trackman.import' ||
        (b.user_name || '').includes('Unknown (Trackman)');
    };
    
    // Only show TODAY's bookings that haven't ended yet (staff can click View all for future dates)
    const scheduledBookings = todaysBookings.filter(booking => {
      if (booking.request_date !== todayPacific) return false;
      if (booking.end_time <= nowTime) return false;
      return true;
    }).filter(booking => {
      // Use String() for reliable comparison
      if (booking.trackman_booking_id && unmatchedTrackmanIds.has(String(booking.trackman_booking_id))) return false;
      if (unmatchedBookingIds.has(String(booking.id))) return false;
      return true;
    }).map(b => ({ ...b, is_unmatched: isUnmatchedBooking(b) }));
    
    // Only include unmatched bookings that are for today
    const unmatchedWithFlag = unmatchedBookings
      .filter(b => (b.request_date || b.slot_date || '') === todayPacific)
      .map(b => ({
        ...b,
        is_unmatched: true,
        request_date: b.request_date || b.slot_date || todayPacific
      }));
    
    const allBookings = [...scheduledBookings, ...unmatchedWithFlag];
    
    return allBookings.sort((a, b) => {
      if (a.request_date !== b.request_date) return a.request_date.localeCompare(b.request_date);
      return a.start_time.localeCompare(b.start_time);
    });
  }, [todaysBookings, unmatchedBookings]);

  const isDesktopGrid = variant === 'desktop-top' || variant === 'desktop-bottom';

  const getStatusBadge = (booking: BookingRequest) => {
    if (booking.status === 'attended') {
      return (
        <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 rounded-full">
          Checked In
        </span>
      );
    }
    if (booking.is_unmatched) {
      return (
        <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-full">
          Needs Assignment
        </span>
      );
    }
    return null;
  };

  const getSmartActionButton = (booking: BookingRequest) => {
    const isCheckingIn = isActionLoading(`checkin-${booking.id}`);
    const bookingId = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', '')) : booking.id;
    
    if (booking.status === 'attended') {
      return (
        <span className="text-xs px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded-lg font-medium flex items-center gap-1">
          <span className="material-symbols-outlined text-sm">check_circle</span>
          Checked In
        </span>
      );
    }
    
    if (booking.is_unmatched) {
      return (
        <button
          onClick={(e) => { e.stopPropagation(); onAssignMember?.(booking); }}
          className="text-xs px-2 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-colors flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-sm">link</span>
          Assign Member
        </button>
      );
    }
    
    const declaredPlayers = booking.declared_player_count ?? 1;
    const filledPlayers = booking.filled_player_count ?? 0;
    
    if (declaredPlayers > 0 && filledPlayers < declaredPlayers) {
      return (
        <button
          onClick={(e) => { 
            e.stopPropagation(); 
            onRosterClick?.(bookingId);
          }}
          className="text-xs px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-lg hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-sm">group</span>
          {filledPlayers}/{declaredPlayers} Players
        </button>
      );
    }
    
    if (booking.has_unpaid_fees && (booking.total_owed ?? 0) > 0) {
      return (
        <button
          onClick={(e) => { 
            e.stopPropagation(); 
            onPaymentClick?.(bookingId);
          }}
          className="text-xs px-2 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-sm">payments</span>
          Charge ${(booking.total_owed || 0).toFixed(0)}
        </button>
      );
    }
    
    return (
      <button
        onClick={(e) => { e.stopPropagation(); executeCheckIn(booking); }}
        disabled={isCheckingIn}
        className="text-xs px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50 flex items-center gap-1"
      >
        {isCheckingIn ? (
          <>
            <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
            Checking...
          </>
        ) : (
          <>
            <span className="material-symbols-outlined text-sm">login</span>
            Check In
          </>
        )}
      </button>
    );
  };

  const PendingRequestsCard = () => (
    <div 
      className={`flex flex-col bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4 ${pendingRequests.length > 0 ? 'border-l-4 border-l-amber-500' : ''}`}
      role="region"
      aria-label={pendingRequests.length > 0 ? `Booking Requests - ${pendingRequests.length} pending, action required` : 'Booking Requests'}
    >
      <div className="flex items-center justify-between mb-3 lg:mb-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <h3 className={`font-bold text-primary dark:text-white ${variant === 'desktop' ? 'text-sm' : ''}`}>Booking Requests</h3>
          {pendingRequests.length > 0 && (
            <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-full">
              Action Required
            </span>
          )}
        </div>
        <button onClick={() => onTabChange('simulator')} className="text-xs text-primary/80 dark:text-white/80 hover:underline">View all</button>
      </div>
      {pendingRequests.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-8">
          <EmptyState icon="check_circle" title="All caught up!" description="No pending requests" variant="compact" />
        </div>
      ) : (
        <div className="space-y-2">
          {pendingRequests.map((request, index) => {
            const isDenying = isActionLoading(`deny-${request.id}`);
            
            return (
              <GlassListRow 
                key={`${request.source || 'request'}-${request.id}`} 
                className="flex-col !items-stretch !gap-2 animate-slide-up-stagger"
                style={{ '--stagger-index': index } as React.CSSProperties}
              >
                <div className="flex items-center gap-3">
                  <DateBlock dateStr={request.request_date} today={today} />
                  <span className="material-symbols-outlined text-lg text-primary dark:text-[#CCB8E4]">pending_actions</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-sm text-primary dark:text-white truncate">{request.user_name}</p>
                      {request.created_at && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0">
                          {formatRelativeTime(request.created_at)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-primary/80 dark:text-white/80">
                      {formatTime12Hour(request.start_time)} - {formatTime12Hour(request.end_time)} • {request.bay_name}
                    </p>
                  </div>
                </div>
                {request.has_conflict && (
                  <div className="flex items-center gap-1.5 ml-[56px] px-2 py-1 bg-orange-100 dark:bg-orange-900/30 rounded-lg">
                    <span className="material-symbols-outlined text-sm text-orange-600 dark:text-orange-400">warning</span>
                    <span className="text-[10px] font-medium text-orange-700 dark:text-orange-400">
                      Conflicts with existing booking{request.conflicting_booking_name ? ` (${request.conflicting_booking_name})` : ''}
                    </span>
                  </div>
                )}
                <div className="flex gap-2 ml-[56px]">
                  <button
                    onClick={(e) => { e.stopPropagation(); onOpenTrackman(request); }}
                    className="flex-1 py-1.5 px-3 bg-[#E55A22]/10 text-[#E55A22] dark:bg-[#E55A22]/20 dark:text-[#FF7A44] text-xs font-medium rounded-lg hover:bg-[#E55A22]/20 dark:hover:bg-[#E55A22]/30 transition-colors flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-sm">sports_golf</span>
                    Book on Trackman
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); executeDeny(request); }}
                    disabled={isDenying}
                    className="flex-1 py-1.5 px-3 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs font-medium rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    {isDenying ? (
                      <>
                        <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                        Denying...
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-outlined text-sm">close</span>
                        Deny
                      </>
                    )}
                  </button>
                </div>
              </GlassListRow>
            );
          })}
        </div>
      )}
    </div>
  );

  const UpcomingBookingsCard = () => {
    const hasUnmatchedBookings = mergedUpcomingBookings.some(b => b.is_unmatched);
    
    return (
      <div 
        className="flex flex-col bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4"
        role="region"
        aria-label={hasUnmatchedBookings ? "Today's Bookings - some need member assignment" : "Today's Bookings"}
      >
        <div className="flex items-center justify-between mb-3 lg:mb-4 flex-shrink-0">
          <h3 className="font-bold text-primary dark:text-white">Today's Bookings</h3>
          <button onClick={() => onTabChange('simulator')} className="text-xs text-primary/80 dark:text-white/80 hover:underline">View all</button>
        </div>
        {mergedUpcomingBookings.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-8">
            <EmptyState icon="calendar_today" title="No bookings today" variant="compact" />
          </div>
        ) : (
          <div className="space-y-2">
            {mergedUpcomingBookings.map((booking, index) => {
              const isUnmatched = booking.is_unmatched;
              const cardClass = isUnmatched 
                ? 'bg-amber-50/80 dark:bg-amber-500/10 border border-amber-300 dark:border-amber-500/30' 
                : '';
              
              return (
                <GlassListRow 
                  key={`${isUnmatched ? 'unmatched-' : ''}${booking.id}`}
                  onClick={() => onTabChange('simulator')}
                  className={`flex-col !items-stretch !gap-2 animate-slide-up-stagger ${cardClass}`}
                  style={{ '--stagger-index': index } as React.CSSProperties}
                >
                  <div className="flex items-start gap-3">
                    <DateBlock dateStr={booking.request_date || booking.slot_date || ''} today={today} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        {isUnmatched ? (
                          <>
                            <span className="px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-full">
                              Needs Assignment
                            </span>
                            {booking.resource_type === 'conference_room' ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400">
                                Conf
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400">
                                {booking.bay_name || `Bay ${booking.resource_id}`}
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            <p className="font-semibold text-sm truncate text-primary dark:text-white">
                              {booking.user_name || 'Unknown Customer'}
                            </p>
                            {booking.resource_type === 'conference_room' ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400">
                                Conf
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-primary/10 dark:bg-white/10 text-primary/70 dark:text-white/70">
                                {booking.bay_name || `Bay ${booking.resource_id}`}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                      <p className={`text-xs ${isUnmatched ? 'text-amber-600/80 dark:text-amber-400/80' : 'text-primary/80 dark:text-white/80'}`}>
                        {formatTime12Hour(booking.start_time)} - {formatTime12Hour(booking.end_time)}
                        {booking.trackman_booking_id && (
                          <span className="ml-2 text-[10px] text-orange-600 dark:text-orange-400">
                            TM: {booking.trackman_booking_id}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {getSmartActionButton(booking)}
                      {onEditBooking && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onEditBooking(booking); }}
                          className="p-1.5 text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white hover:bg-primary/10 dark:hover:bg-white/10 rounded-lg transition-colors"
                          aria-label="Edit booking"
                        >
                          <span className="material-symbols-outlined text-base">edit</span>
                        </button>
                      )}
                    </div>
                  </div>
                </GlassListRow>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  if (variant === 'desktop-top') {
    return <PendingRequestsCard />;
  }

  if (variant === 'desktop-bottom') {
    return <UpcomingBookingsCard />;
  }

  if (variant === 'desktop') {
    return (
      <>
        <PendingRequestsCard />
        <UpcomingBookingsCard />
      </>
    );
  }

  return (
    <>
      <PendingRequestsCard />
      <UpcomingBookingsCard />
    </>
  );
};
