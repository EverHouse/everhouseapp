import React, { useState } from 'react';
import { usePageReady } from '../../../contexts/PageReadyContext';
import EmptyState from '../../../components/EmptyState';
import { formatDateDisplayWithDay, formatTime12Hour } from '../../../utils/dateUtils';
import { formatPhoneNumber } from '../../../utils/formatting';
import { AnimatedPage } from '../../../components/motion';
import { useTourData, useSyncTours, useCheckInTour, useUpdateTourStatus } from '../../../hooks/queries';
import { ToursTabSkeleton } from '../../../components/skeletons';
import { useConfirmDialog } from '../../../components/ConfirmDialog';

interface Tour {
  id: number;
  googleCalendarId: string | null;
  hubspotMeetingId: string | null;
  title: string;
  guestName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  tourDate: string;
  startTime: string;
  endTime: string | null;
  notes: string | null;
  status: string;
  checkedInAt: string | null;
  checkedInBy: string | null;
}

const statusConfig: Record<string, { label: string; icon: string; colors: string }> = {
  scheduled: { label: 'Scheduled', icon: 'schedule', colors: 'bg-primary/10 dark:bg-white/10 text-primary/70 dark:text-white/70' },
  checked_in: { label: 'Checked In', icon: 'check_circle', colors: 'bg-green-500/20 text-green-700 dark:text-green-400' },
  completed: { label: 'Completed', icon: 'task_alt', colors: 'bg-blue-500/20 text-blue-700 dark:text-blue-400' },
  'no-show': { label: 'No Show', icon: 'person_off', colors: 'bg-red-500/20 text-red-700 dark:text-red-400' },
  cancelled: { label: 'Cancelled', icon: 'cancel', colors: 'bg-gray-500/20 text-gray-600 dark:text-gray-400' },
  pending: { label: 'Pending', icon: 'hourglass_empty', colors: 'bg-amber-500/20 text-amber-700 dark:text-amber-400' },
};

interface TourCardProps {
  tour: Tour;
  isToday?: boolean;
  isPast?: boolean;
  statusMenuTourId: number | null;
  onStatusMenuToggle: (tourId: number | null) => void;
  isUpdating: boolean;
  isCheckingIn: boolean;
  onCheckIn: (tour: Tour) => void;
  onStatusUpdate: (tourId: number, newStatus: string) => void;
  formatDate: (dateStr: string) => string;
}

const TourCard: React.FC<TourCardProps> = ({ tour, isToday = false, isPast = false, statusMenuTourId, onStatusMenuToggle, isUpdating, isCheckingIn, onCheckIn, onStatusUpdate, formatDate }) => {
  const config = statusConfig[tour.status] || statusConfig.scheduled;
  const isMenuOpen = statusMenuTourId === tour.id;
  
  return (
    <div className={`p-4 rounded-xl border tactile-card ${tour.status === 'checked_in' 
      ? 'bg-green-500/10 border-green-500/30' 
      : tour.status === 'no-show'
        ? 'bg-red-500/5 border-red-500/20'
        : tour.status === 'cancelled'
          ? 'bg-gray-500/5 border-gray-500/20'
          : isPast
            ? 'bg-primary/5 dark:bg-white/3 border-primary/5 dark:border-white/20'
            : 'bg-white/60 dark:bg-white/5 border-primary/10 dark:border-white/25'
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-sm font-bold ${isPast ? 'text-primary/70 dark:text-white/70' : 'text-primary dark:text-white'}`}>
              {formatTime12Hour(tour.startTime)}
            </span>
            {tour.endTime && (
              <span className="text-xs text-primary/70 dark:text-white/70">
                - {formatTime12Hour(tour.endTime)}
              </span>
            )}
          </div>
          <h4 className={`font-semibold truncate ${isPast ? 'text-primary/80 dark:text-white/80' : 'text-primary dark:text-white'}`}>
            {tour.guestName || tour.title}
          </h4>
          {tour.guestEmail && (
            <p className="text-xs text-primary/80 dark:text-white/80 truncate">{tour.guestEmail}</p>
          )}
          {tour.guestPhone && (
            <p className="text-xs text-primary/80 dark:text-white/80">{formatPhoneNumber(tour.guestPhone)}</p>
          )}
          {!isToday && (
            <p className="text-xs text-primary/70 dark:text-white/70 mt-1">{formatDate(tour.tourDate)}</p>
          )}
        </div>
        <div className="flex-shrink-0 relative">
          {isToday && tour.status === 'scheduled' ? (
            <button
              onClick={() => onCheckIn(tour)}
              disabled={isCheckingIn}
              className="px-4 py-2 rounded-full bg-accent text-primary text-xs font-bold hover:opacity-90 transition-opacity flex items-center gap-1 disabled:opacity-50"
            >
              {isCheckingIn ? (
                <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin"></div>
              ) : (
                <span aria-hidden="true" className="material-symbols-outlined text-sm">how_to_reg</span>
              )}
              Check In
            </button>
          ) : (
            <button
              onClick={() => onStatusMenuToggle(isMenuOpen ? null : tour.id)}
              disabled={isUpdating}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-fast ${config.colors} ${isUpdating ? 'opacity-50' : 'hover:ring-2 hover:ring-primary/20 dark:hover:ring-white/20 cursor-pointer'}`}
            >
              {isUpdating ? (
                <div className="w-4 h-4 border-2 border-current/30 border-t-current rounded-full animate-spin"></div>
              ) : (
                <span aria-hidden="true" className="material-symbols-outlined text-sm">{config.icon}</span>
              )}
              {config.label}
              <span aria-hidden="true" className="material-symbols-outlined text-sm ml-0.5">expand_more</span>
            </button>
          )}
          
          {isMenuOpen && (
            <>
              <div 
                className="fixed inset-0 z-40" 
                onClick={() => onStatusMenuToggle(null)}
              />
              <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-primary/10 dark:border-white/20 py-1 min-w-[140px] animate-pop-in">
                {Object.entries(statusConfig).filter(([key]) => key !== 'pending').map(([key, { label, icon, colors }]) => (
                  <button
                    key={key}
                    onClick={() => onStatusUpdate(tour.id, key)}
                    className={`w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors ${tour.status === key ? 'font-bold' : ''}`}
                  >
                    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${colors}`}>
                      <span aria-hidden="true" className="material-symbols-outlined text-xs">{icon}</span>
                    </span>
                    {label}
                    {tour.status === key && (
                      <span aria-hidden="true" className="material-symbols-outlined text-sm ml-auto text-green-600">check</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const ToursTab: React.FC = () => {
  const { setPageReady } = usePageReady();
  const { data: toursData, isLoading } = useTourData();
  const syncMutation = useSyncTours();
  const checkInMutation = useCheckInTour();
  const updateStatusMutation = useUpdateTourStatus();
  const { confirm, ConfirmDialogComponent } = useConfirmDialog();

  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [statusMenuTourId, setStatusMenuTourId] = useState<number | null>(null);

  React.useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  const handleCheckIn = async (tour: Tour) => {
    const confirmed = await confirm({
      title: 'Check In Guest',
      message: `Mark ${tour.guestName || 'this guest'} as checked in for their tour?`,
      confirmText: 'Check In',
      cancelText: 'Cancel',
      variant: 'info'
    });
    
    if (confirmed) {
      try {
        await checkInMutation.mutateAsync({ tourId: tour.id });
      } catch (err: unknown) {
        console.error('Check-in failed:', err);
      }
    }
  };

  const handleStatusUpdate = async (tourId: number, newStatus: string) => {
    setStatusMenuTourId(null);
    try {
      await updateStatusMutation.mutateAsync({ tourId, status: newStatus });
    } catch (err: unknown) {
      console.error('Status update failed:', err);
    }
  };

  const formatDate = (dateStr: string) => {
    const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    return formatDateDisplayWithDay(datePart);
  };

  if (isLoading) {
    return <ToursTabSkeleton />;
  }

  return (
      <AnimatedPage className="space-y-6 pb-32 backdrop-blur-sm">
        <p className="text-sm text-primary/80 dark:text-white/80 animate-content-enter-delay-1">
          Synced from HubSpot Meetings
        </p>

      {syncMessage && (
        <div className="p-3 rounded-xl bg-accent/20 text-primary dark:text-accent text-sm text-center">
          {syncMessage}
        </div>
      )}

      {toursData.todayTours.length > 0 && (
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-primary/70 dark:text-white/70 mb-3 flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-lg">today</span>
            Today's Tours ({toursData.todayTours.length})
          </h3>
          <div className="space-y-3">
            {toursData.todayTours.map((tour) => (
              <TourCard key={tour.id} tour={tour} isToday statusMenuTourId={statusMenuTourId} onStatusMenuToggle={setStatusMenuTourId} isUpdating={updateStatusMutation.isPending} isCheckingIn={checkInMutation.isPending} onCheckIn={handleCheckIn} onStatusUpdate={handleStatusUpdate} formatDate={formatDate} />
            ))}
          </div>
        </div>
      )}

      {toursData.todayTours.length === 0 && (
        <div className="text-center py-8 bg-white/40 dark:bg-white/5 rounded-xl">
          <span aria-hidden="true" className="material-symbols-outlined text-4xl text-primary/30 dark:text-white/70 mb-2">event_available</span>
          <p className="text-primary/80 dark:text-white/80 text-sm">No tours scheduled for today</p>
        </div>
      )}

      {toursData.upcomingTours.length > 0 && (
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-primary/70 dark:text-white/70 mb-3 flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-lg">upcoming</span>
            Upcoming Tours ({toursData.upcomingTours.length})
          </h3>
          <div className="space-y-3">
            {toursData.upcomingTours.map((tour) => (
              <TourCard key={tour.id} tour={tour} statusMenuTourId={statusMenuTourId} onStatusMenuToggle={setStatusMenuTourId} isUpdating={updateStatusMutation.isPending} isCheckingIn={checkInMutation.isPending} onCheckIn={handleCheckIn} onStatusUpdate={handleStatusUpdate} formatDate={formatDate} />
            ))}
          </div>
        </div>
      )}

      {toursData.todayTours.length === 0 && toursData.upcomingTours.length === 0 && toursData.pastTours.length === 0 && (
        <EmptyState
          icon="tour"
          title="No tours found"
          description="Tours will appear here after syncing from HubSpot"
          variant="compact"
        />
      )}

      {toursData.pastTours.length > 0 && (
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-primary/70 dark:text-white/70 mb-3 flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-lg">history</span>
            Past Tours ({toursData.pastTours.length})
          </h3>
          <div className="space-y-3">
            {toursData.pastTours.map((tour) => (
              <TourCard key={tour.id} tour={tour} isPast statusMenuTourId={statusMenuTourId} onStatusMenuToggle={setStatusMenuTourId} isUpdating={updateStatusMutation.isPending} isCheckingIn={checkInMutation.isPending} onCheckIn={handleCheckIn} onStatusUpdate={handleStatusUpdate} formatDate={formatDate} />
            ))}
          </div>
        </div>
      )}

      <ConfirmDialogComponent />
      </AnimatedPage>
  );
};

export default ToursTab;
