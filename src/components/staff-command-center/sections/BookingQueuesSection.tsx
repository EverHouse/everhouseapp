import React, { useMemo, useCallback, useState, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import EmptyState from '../../EmptyState';
import { formatTime12Hour, getNowTimePacific, getTodayPacific, formatRelativeTime } from '../../../utils/dateUtils';
import { DateBlock, GlassListRow } from '../helpers';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import type { BookingRequest, TabType } from '../types';
import { tabToPath } from '../../../lib/nav-constants';
import { BookingStatusDropdown } from '../../../components/BookingStatusDropdown';
import { BOOKING_STATUS, RESOURCE_TYPE } from '../../../../shared/constants/statuses';
import Icon from '../../icons/Icon';

interface PendingRequestsCardProps {
  pendingRequests: BookingRequest[];
  today: string;
  navigateToTab: (tab: TabType) => void;
  isActionLoading: (actionKey: string) => boolean;
  onOpenTrackman: (booking?: BookingRequest) => void;
  onCompleteCancellation?: (request: BookingRequest) => void;
  executeDeny: (request: BookingRequest) => void;
}

const PendingRequestsCard = memo<PendingRequestsCardProps>(({
  pendingRequests,
  today,
  navigateToTab,
  isActionLoading,
  onOpenTrackman,
  onCompleteCancellation,
  executeDeny
}) => {
  const hasCancellations = pendingRequests.some(r => r.status === BOOKING_STATUS.CANCELLATION_PENDING);
  const cancellationCount = pendingRequests.filter(r => r.status === BOOKING_STATUS.CANCELLATION_PENDING).length;
  const [listRef] = useAutoAnimate();

  return (
    <div 
      className={`flex flex-col bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl pt-4 shadow-liquid dark:shadow-liquid-dark overflow-hidden ${pendingRequests.length > 0 ? `border-l-4 ${hasCancellations ? 'border-l-red-500' : 'border-l-amber-500'}` : ''}`}
      role="region"
      aria-label={pendingRequests.length > 0 ? `Booking Requests - ${pendingRequests.length} pending, action required` : 'Booking Requests'}
    >
      <div className="flex items-center justify-between mb-4 flex-shrink-0 px-4">
        <h3 className="text-2xl leading-tight font-bold text-primary dark:text-white" style={{ fontFamily: 'var(--font-headline)' }}>Booking Requests</h3>
        <div className="flex items-center gap-2">
          {cancellationCount > 0 && (
            <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 rounded-[4px]">
              {cancellationCount} Cancellation{cancellationCount !== 1 ? 's' : ''}
            </span>
          )}
          {pendingRequests.length > 0 ? (
            <button
              onClick={() => navigateToTab('simulator')}
              className="tactile-btn flex items-center gap-1 px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full text-xs font-medium hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
              title={`${pendingRequests.length} pending request${pendingRequests.length !== 1 ? 's' : ''}`}
            >
              <Icon name="assignment" className="text-sm" />
              {pendingRequests.length}
            </button>
          ) : (
            <button onClick={() => navigateToTab('simulator')} className="tactile-btn text-xs text-primary/80 dark:text-white/80 hover:underline">View all</button>
          )}
        </div>
      </div>
      <div ref={listRef} className="relative">
        {pendingRequests.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-8">
            <EmptyState icon="check_circle" title="All caught up!" description="No pending requests" variant="compact" />
          </div>
        ) : (
          pendingRequests.map((request, _index) => {
            const isDenying = isActionLoading(`deny-${request.id}`);
            
            return (
              <GlassListRow 
                key={`${request.source || 'request'}-${request.id}`} 
                className="flex-col !items-stretch !gap-2"
                hasInteractiveChildren
              >
                {request.status === BOOKING_STATUS.CANCELLATION_PENDING ? (
                  <>
                    <div className="flex items-center gap-3">
                      <DateBlock dateStr={request.request_date} today={today} />
                      <Icon name="event_busy" className="text-lg text-red-500 dark:text-red-400" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <p className="font-semibold text-sm text-primary dark:text-white truncate">{request.user_name}</p>
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 rounded-[4px]">
                              Cancellation
                            </span>
                          </div>
                          {request.created_at && (
                            <span className="text-[10px] text-red-600 dark:text-red-400 shrink-0">
                              {formatRelativeTime(request.created_at)}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-primary/80 dark:text-white/80">
                          {formatTime12Hour(request.start_time)} - {formatTime12Hour(request.end_time)} • {request.bay_name}
                        </p>
                      </div>
                    </div>
                    {request.trackman_booking_id && (
                      <div className="flex items-center gap-1.5 ml-[56px] px-2 py-1 bg-orange-100 dark:bg-orange-900/30 rounded-lg">
                        <Icon name="sports_golf" className="text-sm text-orange-600 dark:text-orange-400" />
                        <span className="text-[10px] font-medium text-orange-700 dark:text-orange-400">
                          Cancel in Trackman (TM: {request.trackman_booking_id})
                        </span>
                      </div>
                    )}
                    <div className="flex gap-2 ml-[56px]">
                      {onCompleteCancellation && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onCompleteCancellation(request); }}
                          className="tactile-btn flex-1 py-1.5 px-3 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs font-medium rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors flex items-center justify-center gap-1.5"
                        >
                          <Icon name="check_circle" className="text-sm" />
                          Complete Cancellation
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <DateBlock dateStr={request.request_date} today={today} />
                      <Icon name="pending_actions" className="text-lg text-primary dark:text-[#CCB8E4]" />
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
                        {((request.declared_player_count && request.declared_player_count > 1) || (request.request_participants && request.request_participants.length > 0)) && (
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Icon name="group" className="text-xs text-primary/50 dark:text-white/50" />
                            <span className="text-[11px] text-primary/60 dark:text-white/60">
                              {request.declared_player_count ?? 1} players
                              {request.request_participants && request.request_participants.length > 0 && (
                                <>
                                  {' — '}
                                  {request.request_participants.map(p => p.name || p.email || (p.type === 'member' ? 'Member' : 'Guest')).join(', ')}
                                </>
                              )}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    {request.has_conflict && (
                      <div className="flex items-center gap-1.5 ml-[56px] px-2 py-1 bg-orange-100 dark:bg-orange-900/30 rounded-lg">
                        <Icon name="warning" className="text-sm text-orange-600 dark:text-orange-400" />
                        <span className="text-[10px] font-medium text-orange-700 dark:text-orange-400">
                          Conflicts with existing booking{request.conflicting_booking_name ? ` (${request.conflicting_booking_name})` : ''}
                        </span>
                      </div>
                    )}
                    <div className="flex gap-2 ml-[56px]">
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenTrackman(request); }}
                        className="tactile-btn flex-1 py-1.5 px-3 bg-[#E55A22]/10 text-[#E55A22] dark:bg-[#E55A22]/20 dark:text-[#FF7A44] text-xs font-medium rounded-lg hover:bg-[#E55A22]/20 dark:hover:bg-[#E55A22]/30 transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Icon name="sports_golf" className="text-sm" />
                        Book on Trackman
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); executeDeny(request); }}
                        disabled={isDenying}
                        className="tactile-btn flex-1 py-1.5 px-3 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs font-medium rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                      >
                        {isDenying ? (
                          <>
                            <Icon name="progress_activity" className="text-sm animate-spin" />
                            Denying...
                          </>
                        ) : (
                          <>
                            <Icon name="close" className="text-sm" />
                            Deny
                          </>
                        )}
                      </button>
                    </div>
                  </>
                )}
              </GlassListRow>
            );
          })
        )}
      </div>
    </div>
  );
});

interface UpcomingBookingsCardProps {
  mergedUpcomingBookings: BookingRequest[];
  today: string;
  navigateToTab: (tab: TabType) => void;
  getSmartActionButton: (booking: BookingRequest) => React.ReactNode;
  onEditBooking?: (booking: BookingRequest) => void;
}

const UpcomingBookingsCard = memo<UpcomingBookingsCardProps>(({
  mergedUpcomingBookings,
  today,
  navigateToTab,
  getSmartActionButton,
  onEditBooking
}) => {
  const unmatchedCount = mergedUpcomingBookings.filter(b => b.is_unmatched).length;
  const hasUnmatchedBookings = unmatchedCount > 0;
  const [listRef] = useAutoAnimate();
  
  return (
    <div 
      className="flex flex-col bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl pt-4 shadow-liquid dark:shadow-liquid-dark overflow-hidden"
      role="region"
      aria-label={hasUnmatchedBookings ? "Today's Bookings - some need member assignment" : "Today's Bookings"}
    >
      <div className="flex items-center justify-between mb-4 flex-shrink-0 px-4">
        <h3 className="text-2xl leading-tight font-bold text-primary dark:text-white" style={{ fontFamily: 'var(--font-headline)' }}>Today's Bookings</h3>
        {unmatchedCount > 0 ? (
          <button 
            onClick={() => navigateToTab('simulator')}
            className="tactile-btn flex items-center gap-1 px-2 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 rounded-full text-xs font-medium hover:bg-orange-200 dark:hover:bg-orange-900/50 transition-colors"
            title={`${unmatchedCount} booking${unmatchedCount !== 1 ? 's' : ''} need${unmatchedCount !== 1 ? '' : 's'} assignment`}
          >
            <Icon name="link_off" className="text-sm" />
            {unmatchedCount}
          </button>
        ) : (
          <button onClick={() => navigateToTab('simulator')} className="tactile-btn text-xs text-primary/80 dark:text-white/80 hover:underline">View all</button>
        )}
      </div>
      <div ref={listRef} className="relative">
        {mergedUpcomingBookings.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-8">
            <EmptyState icon="calendar_today" title="No bookings today" variant="compact" />
          </div>
        ) : (
          mergedUpcomingBookings.map((booking, _index) => {
            const isUnmatched = booking.is_unmatched;
            const cardClass = isUnmatched 
              ? 'bg-amber-50/80 dark:bg-amber-500/10 border border-amber-300 dark:border-amber-500/30' 
              : '';
            
            return (
              <GlassListRow 
                key={`${isUnmatched ? 'unmatched-' : ''}${booking.id}`}
                onClick={() => navigateToTab('simulator')}
                className={`flex-col !items-stretch !gap-2 ${cardClass}`}
                hasInteractiveChildren
              >
                <div className="flex items-start gap-3">
                  <DateBlock dateStr={booking.request_date || booking.slot_date || ''} today={today} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {isUnmatched ? (
                        <>
                          <span className="px-2 py-0.5 text-[11px] font-semibold uppercase tracking-widest bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-[4px]">
                            Needs Assignment
                          </span>
                          {booking.resource_type === RESOURCE_TYPE.CONFERENCE_ROOM ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-glass-surface-primary dark:bg-glass-surface-primary-dark text-glass-surface-primary-text dark:text-purple-400">
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
                          {booking.resource_type === RESOURCE_TYPE.CONFERENCE_ROOM ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-glass-surface-primary dark:bg-glass-surface-primary-dark text-glass-surface-primary-text dark:text-purple-400">
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
                </div>
                <div className="flex items-center gap-2 ml-[56px]">
                  {getSmartActionButton(booking)}
                  {onEditBooking && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onEditBooking(booking); }}
                      className="tactile-btn p-1.5 text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white hover:bg-primary/10 dark:hover:bg-white/10 rounded-lg transition-colors"
                      aria-label="Edit booking"
                    >
                      <Icon name="edit" className="text-base" />
                    </button>
                  )}
                </div>
              </GlassListRow>
            );
          })
        )}
      </div>
    </div>
  );
});

interface BookingQueuesSectionProps {
  pendingRequests: BookingRequest[];
  todaysBookings: BookingRequest[];
  unmatchedBookings?: BookingRequest[];
  today: string;
  actionInProgress: string | null;
  onOpenTrackman: (booking?: BookingRequest) => void;
  onDeny: (request: BookingRequest) => void;
  onCheckIn: (booking: BookingRequest, targetStatus?: 'attended' | 'no_show' | 'approved') => void;
  onPaymentClick?: (bookingId: number) => void;
  onRosterClick?: (bookingId: number) => void;
  onAssignMember?: (booking: BookingRequest) => void;
  onCompleteCancellation?: (request: BookingRequest) => void;
  onEditBooking?: (booking: BookingRequest) => void;
  onRevertToApproved?: (bookingId: number) => void;
  variant: 'desktop' | 'desktop-top' | 'desktop-bottom' | 'mobile';
}

export const BookingQueuesSection: React.FC<BookingQueuesSectionProps> = memo(({
  pendingRequests,
  todaysBookings,
  unmatchedBookings = [],
  today,
  actionInProgress,
  onOpenTrackman,
  onDeny,
  onCheckIn,
  onPaymentClick,
  onRosterClick,
  onCompleteCancellation,
  onAssignMember,
  onEditBooking,
  onRevertToApproved,
  variant
}) => {
  const navigate = useNavigate();
  const navigateToTab = useCallback((tab: TabType) => {
    if ((tabToPath as Record<string, string>)[tab]) navigate((tabToPath as Record<string, string>)[tab]);
  }, [navigate]);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

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
    async (booking: BookingRequest, targetStatus?: 'attended' | 'no_show' | 'approved') => {
      const bookingId = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', ''), 10) : booking.id;
      if (targetStatus === 'approved' && onRevertToApproved) {
        setLoadingAction(`checkin-${booking.id}`);
        try {
          await onRevertToApproved(bookingId);
        } finally {
          setLoadingAction(null);
        }
        return;
      }
      setLoadingAction(`checkin-${booking.id}`);
      try {
        await onCheckIn(booking, targetStatus);
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
    
    const unmatchedTrackmanIds = new Set(
      unmatchedBookings
        .filter(b => b.trackman_booking_id)
        .map(b => String(b.trackman_booking_id))
    );
    const unmatchedBookingIds = new Set(unmatchedBookings.map(b => String(b.id)));
    
    const isUnmatchedBooking = (b: BookingRequest) => {
      const email = b.user_email?.toLowerCase() || '';
      const isPlaceholderEmail = !email || 
        email.includes('@trackman.local') ||
        email.includes('@visitors.evenhouse.club') ||
        email.includes('@visitors.everclub.co') ||
        email.startsWith('unmatched-') ||
        email.startsWith('golfnow-') ||
        email.startsWith('classpass-') ||
        email === 'unmatched@trackman.import';
      
      return b.is_unmatched === true ||
        isPlaceholderEmail ||
        (b.user_name || '').includes('Unknown (Trackman)');
    };
    
    const scheduledBookings = todaysBookings.filter(booking => {
      if (booking.request_date !== todayPacific) return false;
      if (booking.end_time <= nowTime) return false;
      return true;
    }).filter(booking => {
      if (booking.trackman_booking_id && unmatchedTrackmanIds.has(String(booking.trackman_booking_id))) return false;
      if (unmatchedBookingIds.has(String(booking.id))) return false;
      return true;
    }).map(b => ({ ...b, is_unmatched: isUnmatchedBooking(b) }));
    
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

  const _isDesktopGrid = variant === 'desktop-top' || variant === 'desktop-bottom';

  const getStatusBadge = (booking: BookingRequest) => {
    if (booking.status === BOOKING_STATUS.ATTENDED && booking.has_unpaid_fees && (booking.total_owed ?? 0) > 0) {
      return (
        <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-[4px]">
          Payment Due
        </span>
      );
    }
    if (booking.status === BOOKING_STATUS.ATTENDED) {
      return (
        <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 rounded-[4px]">
          Checked In
        </span>
      );
    }
    if (booking.status === BOOKING_STATUS.CANCELLATION_PENDING) {
      return (
        <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400 rounded-[4px]">
          Cancellation Pending
        </span>
      );
    }
    if (booking.is_unmatched) {
      return (
        <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-[4px]">
          Needs Assignment
        </span>
      );
    }
    return null;
  };

  const getSmartActionButton = (booking: BookingRequest) => {
    const isCheckingIn = isActionLoading(`checkin-${booking.id}`);
    const bookingId = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', ''), 10) : booking.id;
    
    if (booking.status === BOOKING_STATUS.ATTENDED && booking.has_unpaid_fees && (booking.total_owed ?? 0) > 0) {
      return (
        <button
          onClick={(e) => { 
            e.stopPropagation(); 
            onPaymentClick?.(bookingId);
          }}
          className="tactile-btn text-xs px-2 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors flex items-center gap-1"
        >
          <Icon name="payments" className="text-sm" />
          Charge ${(booking.total_owed || 0).toFixed(0)}
        </button>
      );
    }

    if (booking.status === BOOKING_STATUS.ATTENDED && !(booking.has_unpaid_fees && (booking.total_owed ?? 0) > 0)) {
      return (
        <BookingStatusDropdown
          currentStatus={BOOKING_STATUS.ATTENDED}
          onStatusChange={(status) => executeCheckIn(booking, status)}
          showRevert={true}
          size="sm"
          menuDirection="down"
        />
      );
    }

    if (booking.status === BOOKING_STATUS.NO_SHOW) {
      return (
        <BookingStatusDropdown
          currentStatus={BOOKING_STATUS.NO_SHOW}
          onStatusChange={(status) => executeCheckIn(booking, status)}
          showRevert={true}
          size="sm"
          menuDirection="down"
        />
      );
    }
    
    if (booking.is_unmatched) {
      return (
        <button
          onClick={(e) => { e.stopPropagation(); onAssignMember?.(booking); }}
          className="tactile-btn text-xs px-2 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-colors flex items-center gap-1"
        >
          <Icon name="link" className="text-sm" />
          Assign Member
        </button>
      );
    }
    
    const declaredPlayers = booking.declared_player_count ?? 0;
    const filledPlayers = booking.filled_player_count ?? 0;
    
    if (declaredPlayers > 0 && filledPlayers < declaredPlayers) {
      return (
        <button
          onClick={(e) => { 
            e.stopPropagation(); 
            onRosterClick?.(bookingId);
          }}
          className="tactile-btn text-xs px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-lg hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors flex items-center gap-1"
        >
          <Icon name="group" className="text-sm" />
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
          className="tactile-btn text-xs px-2 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors flex items-center gap-1"
        >
          <Icon name="payments" className="text-sm" />
          Charge ${(booking.total_owed || 0).toFixed(0)}
        </button>
      );
    }
    
    return (
      <BookingStatusDropdown
        currentStatus="check_in"
        onStatusChange={(status) => executeCheckIn(booking, status)}
        disabled={isCheckingIn}
        loading={isCheckingIn}
        size="sm"
        menuDirection="down"
      />
    );
  };

  if (variant === 'desktop-top') {
    return (
      <PendingRequestsCard
        pendingRequests={pendingRequests}
        today={today}
        navigateToTab={navigateToTab}
        isActionLoading={isActionLoading}
        onOpenTrackman={onOpenTrackman}
        onCompleteCancellation={onCompleteCancellation}
        executeDeny={executeDeny}
      />
    );
  }

  if (variant === 'desktop-bottom') {
    return (
      <UpcomingBookingsCard
        mergedUpcomingBookings={mergedUpcomingBookings}
        today={today}
        navigateToTab={navigateToTab}
        getSmartActionButton={getSmartActionButton}
        onEditBooking={onEditBooking}
      />
    );
  }

  if (variant === 'desktop') {
    return (
      <>
        <PendingRequestsCard
          pendingRequests={pendingRequests}
          today={today}
          navigateToTab={navigateToTab}
          isActionLoading={isActionLoading}
          onOpenTrackman={onOpenTrackman}
          onCompleteCancellation={onCompleteCancellation}
          executeDeny={executeDeny}
        />
        <UpcomingBookingsCard
          mergedUpcomingBookings={mergedUpcomingBookings}
          today={today}
          navigateToTab={navigateToTab}
          getSmartActionButton={getSmartActionButton}
          onEditBooking={onEditBooking}
        />
      </>
    );
  }

  return (
    <>
      <PendingRequestsCard
        pendingRequests={pendingRequests}
        today={today}
        navigateToTab={navigateToTab}
        isActionLoading={isActionLoading}
        onOpenTrackman={onOpenTrackman}
        onCompleteCancellation={onCompleteCancellation}
        executeDeny={executeDeny}
      />
      <UpcomingBookingsCard
        mergedUpcomingBookings={mergedUpcomingBookings}
        today={today}
        navigateToTab={navigateToTab}
        getSmartActionButton={getSmartActionButton}
        onEditBooking={onEditBooking}
      />
    </>
  );
});
