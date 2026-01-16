import React, { useMemo, useCallback, useState } from 'react';
import { List as FixedSizeList, RowComponentProps as ListChildComponentProps } from 'react-window';
import { AutoSizer } from 'react-virtualized-auto-sizer';
import EmptyState from '../../EmptyState';
import { formatTime12Hour, getNowTimePacific } from '../../../utils/dateUtils';
import { DateBlock, GlassListRow } from '../helpers';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import type { BookingRequest, TabType } from '../types';

interface BookingQueuesSectionProps {
  pendingRequests: BookingRequest[];
  todaysBookings: BookingRequest[];
  today: string;
  actionInProgress: string | null;
  onTabChange: (tab: TabType) => void;
  onApprove: (request: BookingRequest) => void;
  onDeny: (request: BookingRequest) => void;
  onCheckIn: (booking: BookingRequest) => void;
  onPaymentClick?: (bookingId: number) => void;
  variant: 'desktop' | 'desktop-top' | 'desktop-bottom' | 'mobile';
}

export const BookingQueuesSection: React.FC<BookingQueuesSectionProps> = ({
  pendingRequests,
  todaysBookings,
  today,
  actionInProgress,
  onTabChange,
  onApprove,
  onDeny,
  onCheckIn,
  onPaymentClick,
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

  const upcomingBookings = useMemo(() => {
    const nowTimePacific = getNowTimePacific();
    return todaysBookings.filter(booking => {
      return booking.end_time > nowTimePacific;
    });
  }, [todaysBookings]);

  const isDesktopGrid = variant === 'desktop-top' || variant === 'desktop-bottom';
  
  const PENDING_ROW_HEIGHT = 110;
  const BOOKING_ROW_HEIGHT = 88;
  const VIRTUALIZATION_THRESHOLD = 5;

  const PendingRequestRow = useCallback(({ index, style }: ListChildComponentProps) => {
    const request = pendingRequests[index];
    if (!request) return null;
    
    const isApproving = isActionLoading(`approve-${request.id}`);
    const isDenying = isActionLoading(`deny-${request.id}`);
    const isAnyActionLoading = isApproving || isDenying;
    
    return (
      <div style={{ ...style, paddingBottom: 8 }}>
        <GlassListRow 
          key={`${request.source || 'request'}-${request.id}`} 
          className="flex-col !items-stretch !gap-2 h-full animate-slide-in-up"
          style={{ animationDelay: `${index * 50}ms` }}
        >
          <div className="flex items-center gap-3">
            <DateBlock dateStr={request.request_date} today={today} />
            <span className="material-symbols-outlined text-lg text-primary dark:text-[#CCB8E4]">pending_actions</span>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-primary dark:text-white truncate">{request.user_name}</p>
              <p className="text-xs text-primary/60 dark:text-white/60">
                {formatTime12Hour(request.start_time)} - {formatTime12Hour(request.end_time)} • {request.bay_name}
              </p>
            </div>
          </div>
          <div className="flex gap-2 ml-[56px]">
            <button
              onClick={(e) => { e.stopPropagation(); executeApprove(request); }}
              disabled={isAnyActionLoading}
              className="flex-1 py-1.5 px-3 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-medium rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {isApproving ? (
                <>
                  <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                  Approving...
                </>
              ) : 'Approve'}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); executeDeny(request); }}
              disabled={isAnyActionLoading}
              className="flex-1 py-1.5 px-3 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs font-medium rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {isDenying ? (
                <>
                  <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                  Denying...
                </>
              ) : 'Deny'}
            </button>
          </div>
        </GlassListRow>
      </div>
    );
  }, [pendingRequests, today, isActionLoading, executeApprove, executeDeny]);

  const UpcomingBookingRow = useCallback(({ index, style }: ListChildComponentProps) => {
    const booking = upcomingBookings[index];
    if (!booking) return null;
    
    const isCheckingIn = isActionLoading(`checkin-${booking.id}`);
    
    return (
      <div style={{ ...style, paddingBottom: 8 }}>
        <GlassListRow 
          key={booking.id} 
          onClick={() => onTabChange('simulator')} 
          className="h-full animate-slide-in-up"
          style={{ animationDelay: `${index * 50}ms` }}
        >
          <DateBlock dateStr={today} today={today} />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-primary dark:text-white truncate">{booking.user_name}</p>
            <p className="text-xs text-primary/60 dark:text-white/60">
              {formatTime12Hour(booking.start_time)} - {formatTime12Hour(booking.end_time)} • {booking.bay_name}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {booking.status === 'attended' ? (
              <span className="text-xs px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded-lg font-medium flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">check_circle</span>
                Checked In
              </span>
            ) : booking.has_unpaid_fees ? (
              <button
                onClick={(e) => { 
                  e.stopPropagation(); 
                  const bookingId = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', '')) : booking.id;
                  onPaymentClick?.(bookingId);
                }}
                className="text-xs px-2 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-sm">payments</span>
                ${(booking.total_owed || 0).toFixed(0)} Due
              </button>
            ) : (
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
                ) : 'Check In'}
              </button>
            )}
            <span className="material-symbols-outlined text-base text-primary/40 dark:text-white/40">chevron_right</span>
          </div>
        </GlassListRow>
      </div>
    );
  }, [upcomingBookings, today, isActionLoading, onTabChange, executeCheckIn, onPaymentClick]);

  const PendingRequestsCard = () => (
    <div 
      className={`${isDesktopGrid ? 'h-full min-h-[280px]' : 'min-h-[200px]'} flex flex-col bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4 ${pendingRequests.length > 0 ? 'border-l-4 border-l-amber-500' : ''}`}
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
        <button onClick={() => onTabChange('simulator')} className="text-xs text-primary/60 dark:text-white/60 hover:underline">View all</button>
      </div>
      {pendingRequests.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-8">
          <EmptyState icon="check_circle" title="All caught up!" description="No pending requests" variant="compact" />
        </div>
      ) : pendingRequests.length > VIRTUALIZATION_THRESHOLD ? (
        <div className="flex-1 min-h-0">
          <AutoSizer>
            {({ height, width }) => (
              <FixedSizeList
                rowCount={pendingRequests.length}
                rowHeight={PENDING_ROW_HEIGHT}
                overscanCount={2}
                rowComponent={PendingRequestRow}
                style={{ height, width }}
              />
            )}
          </AutoSizer>
        </div>
      ) : (
        <div className="space-y-2">
          {pendingRequests.map((request, index) => {
            const isApproving = isActionLoading(`approve-${request.id}`);
            const isDenying = isActionLoading(`deny-${request.id}`);
            const isAnyActionLoading = isApproving || isDenying;
            
            return (
              <GlassListRow 
                key={`${request.source || 'request'}-${request.id}`} 
                className="flex-col !items-stretch !gap-2 animate-slide-in-up"
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <div className="flex items-center gap-3">
                  <DateBlock dateStr={request.request_date} today={today} />
                  <span className="material-symbols-outlined text-lg text-primary dark:text-[#CCB8E4]">pending_actions</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-primary dark:text-white truncate">{request.user_name}</p>
                    <p className="text-xs text-primary/60 dark:text-white/60">
                      {formatTime12Hour(request.start_time)} - {formatTime12Hour(request.end_time)} • {request.bay_name}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 ml-[56px]">
                  <button
                    onClick={(e) => { e.stopPropagation(); executeApprove(request); }}
                    disabled={isAnyActionLoading}
                    className="flex-1 py-1.5 px-3 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-medium rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    {isApproving ? (
                      <>
                        <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                        Approving...
                      </>
                    ) : 'Approve'}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); executeDeny(request); }}
                    disabled={isAnyActionLoading}
                    className="flex-1 py-1.5 px-3 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs font-medium rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    {isDenying ? (
                      <>
                        <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                        Denying...
                      </>
                    ) : 'Deny'}
                  </button>
                </div>
              </GlassListRow>
            );
          })}
        </div>
      )}
    </div>
  );

  const UpcomingBookingsCard = () => (
    <div className={`${isDesktopGrid ? 'h-full min-h-[280px]' : 'min-h-[200px]'} flex flex-col bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4`}>
      <div className="flex items-center justify-between mb-3 lg:mb-4 flex-shrink-0">
        <h3 className="font-bold text-primary dark:text-white">Upcoming Bookings</h3>
        <button onClick={() => onTabChange('simulator')} className="text-xs text-primary/60 dark:text-white/60 hover:underline">View all</button>
      </div>
      {upcomingBookings.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-8">
          <EmptyState icon="calendar_today" title="No upcoming bookings" variant="compact" />
        </div>
      ) : upcomingBookings.length > VIRTUALIZATION_THRESHOLD ? (
        <div className="flex-1 min-h-0">
          <AutoSizer>
            {({ height, width }) => (
              <FixedSizeList
                rowCount={upcomingBookings.length}
                rowHeight={BOOKING_ROW_HEIGHT}
                overscanCount={2}
                rowComponent={UpcomingBookingRow}
                style={{ height, width }}
              />
            )}
          </AutoSizer>
        </div>
      ) : (
        <div className="space-y-2">
          {upcomingBookings.map((booking, index) => {
            const isCheckingIn = isActionLoading(`checkin-${booking.id}`);
            
            return (
              <GlassListRow 
                key={booking.id} 
                onClick={() => onTabChange('simulator')}
                className="animate-slide-in-up"
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <DateBlock dateStr={today} today={today} />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm text-primary dark:text-white truncate">{booking.user_name}</p>
                  <p className="text-xs text-primary/60 dark:text-white/60">
                    {formatTime12Hour(booking.start_time)} - {formatTime12Hour(booking.end_time)} • {booking.bay_name}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {booking.status === 'attended' ? (
                    <span className="text-xs px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded-lg font-medium flex items-center gap-1">
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      Checked In
                    </span>
                  ) : booking.has_unpaid_fees ? (
                    <button
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        const bookingId = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', '')) : booking.id;
                        onPaymentClick?.(bookingId);
                      }}
                      className="text-xs px-2 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-sm">payments</span>
                      ${(booking.total_owed || 0).toFixed(0)} Due
                    </button>
                  ) : (
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
                      ) : 'Check In'}
                    </button>
                  )}
                  <span className="material-symbols-outlined text-base text-primary/40 dark:text-white/40">chevron_right</span>
                </div>
              </GlassListRow>
            );
          })}
        </div>
      )}
    </div>
  );

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
