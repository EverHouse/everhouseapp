import React, { useMemo, useCallback } from 'react';
import { FixedSizeList, ListChildComponentProps } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import EmptyState from '../../EmptyState';
import { formatTime12Hour, getNowTimePacific } from '../../../utils/dateUtils';
import { DateBlock, GlassListRow } from '../helpers';
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
    
    return (
      <div style={{ ...style, paddingBottom: 8 }}>
        <GlassListRow key={`${request.source || 'request'}-${request.id}`} className="flex-col !items-stretch !gap-2 h-full">
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
              onClick={(e) => { e.stopPropagation(); onApprove(request); }}
              disabled={actionInProgress === `approve-${request.id}`}
              className="flex-1 py-1.5 px-3 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-medium rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50"
            >
              {actionInProgress === `approve-${request.id}` ? 'Approving...' : 'Approve'}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDeny(request); }}
              disabled={actionInProgress === `deny-${request.id}`}
              className="flex-1 py-1.5 px-3 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs font-medium rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50"
            >
              {actionInProgress === `deny-${request.id}` ? 'Denying...' : 'Deny'}
            </button>
          </div>
        </GlassListRow>
      </div>
    );
  }, [pendingRequests, today, actionInProgress, onApprove, onDeny]);

  const UpcomingBookingRow = useCallback(({ index, style }: ListChildComponentProps) => {
    const booking = upcomingBookings[index];
    if (!booking) return null;
    
    return (
      <div style={{ ...style, paddingBottom: 8 }}>
        <GlassListRow key={booking.id} onClick={() => onTabChange('simulator')} className="h-full">
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
                onClick={(e) => { e.stopPropagation(); onCheckIn(booking); }}
                disabled={actionInProgress === `checkin-${booking.id}`}
                className="text-xs px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50"
              >
                Check In
              </button>
            )}
            <span className="material-symbols-outlined text-base text-primary/40 dark:text-white/40">chevron_right</span>
          </div>
        </GlassListRow>
      </div>
    );
  }, [upcomingBookings, today, actionInProgress, onTabChange, onCheckIn, onPaymentClick]);

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
                height={height}
                width={width}
                itemCount={pendingRequests.length}
                itemSize={PENDING_ROW_HEIGHT}
                overscanCount={2}
              >
                {PendingRequestRow}
              </FixedSizeList>
            )}
          </AutoSizer>
        </div>
      ) : (
        <div className="space-y-2">
          {pendingRequests.map(request => (
            <GlassListRow key={`${request.source || 'request'}-${request.id}`} className="flex-col !items-stretch !gap-2">
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
                  onClick={(e) => { e.stopPropagation(); onApprove(request); }}
                  disabled={actionInProgress === `approve-${request.id}`}
                  className="flex-1 py-1.5 px-3 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-medium rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50"
                >
                  {actionInProgress === `approve-${request.id}` ? 'Approving...' : 'Approve'}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDeny(request); }}
                  disabled={actionInProgress === `deny-${request.id}`}
                  className="flex-1 py-1.5 px-3 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs font-medium rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50"
                >
                  {actionInProgress === `deny-${request.id}` ? 'Denying...' : 'Deny'}
                </button>
              </div>
            </GlassListRow>
          ))}
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
                height={height}
                width={width}
                itemCount={upcomingBookings.length}
                itemSize={BOOKING_ROW_HEIGHT}
                overscanCount={2}
              >
                {UpcomingBookingRow}
              </FixedSizeList>
            )}
          </AutoSizer>
        </div>
      ) : (
        <div className="space-y-2">
          {upcomingBookings.map(booking => (
            <GlassListRow key={booking.id} onClick={() => onTabChange('simulator')}>
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
                    onClick={(e) => { e.stopPropagation(); onCheckIn(booking); }}
                    disabled={actionInProgress === `checkin-${booking.id}`}
                    className="text-xs px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50"
                  >
                    Check In
                  </button>
                )}
                <span className="material-symbols-outlined text-base text-primary/40 dark:text-white/40">chevron_right</span>
              </div>
            </GlassListRow>
          ))}
        </div>
      )}
    </div>
  );

  // Desktop top row - just pending requests card
  if (variant === 'desktop-top') {
    return <PendingRequestsCard />;
  }

  // Desktop bottom row - just upcoming bookings card
  if (variant === 'desktop-bottom') {
    return <UpcomingBookingsCard />;
  }

  // Desktop legacy - both cards
  if (variant === 'desktop') {
    return (
      <>
        <PendingRequestsCard />
        <UpcomingBookingsCard />
      </>
    );
  }

  // Mobile - both cards
  return (
    <>
      <PendingRequestsCard />
      <UpcomingBookingsCard />
    </>
  );
};
