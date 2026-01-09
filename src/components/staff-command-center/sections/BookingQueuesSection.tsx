import React, { useMemo } from 'react';
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
  variant
}) => {
  const isDesktop = variant === 'desktop' || variant === 'desktop-top' || variant === 'desktop-bottom';
  const maxRequests = isDesktop ? 5 : 3;
  const maxBookings = isDesktop ? 6 : 4;

  const upcomingBookings = useMemo(() => {
    const nowTimePacific = getNowTimePacific();
    return todaysBookings.filter(booking => {
      return booking.end_time > nowTimePacific;
    });
  }, [todaysBookings]);

  const isDesktopGrid = variant === 'desktop-top' || variant === 'desktop-bottom';
  
  const PendingRequestsCard = () => (
    <div className={`${isDesktopGrid ? 'h-full min-h-[280px]' : 'min-h-[200px]'} flex flex-col bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4`}>
      <div className="flex items-center justify-between mb-3 lg:mb-4 flex-shrink-0">
        <h3 className={`font-bold text-primary dark:text-white ${variant === 'desktop' ? 'text-sm' : ''}`}>Booking Requests</h3>
        <button onClick={() => onTabChange('simulator')} className="text-xs text-primary/60 dark:text-white/60 hover:underline">View all</button>
      </div>
      {pendingRequests.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-8">
          <EmptyState icon="check_circle" title="All caught up!" description="No pending requests" variant="compact" />
        </div>
      ) : (
        <div className={`${variant === 'desktop' ? 'flex-1 overflow-y-auto pb-6' : ''} space-y-2`}>
          {pendingRequests.slice(0, maxRequests).map(request => (
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
              {(request.member_notes || request.notes) && (
                <div className="ml-[56px] px-2 py-1.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-lg">
                  <p className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
                    <span className="material-symbols-outlined text-sm flex-shrink-0 mt-0.5">edit_note</span>
                    <span className="italic">"{request.member_notes || request.notes}"</span>
                  </p>
                </div>
              )}
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
      ) : (
        <div className={`${variant === 'desktop' ? 'flex-1 overflow-y-auto pb-6' : ''} space-y-2`}>
          {upcomingBookings.slice(0, maxBookings).map(booking => (
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
