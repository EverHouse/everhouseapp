import React, { useState, useEffect, useRef, useCallback } from 'react';
import { usePageReady } from '../../../contexts/PageReadyContext';
import { formatDateDisplayWithDay, formatTime12Hour, getRelativeDateLabel } from '../../../utils/dateUtils';
import { formatPhoneNumber } from '../../../utils/formatting';
import PullToRefresh from '../../../components/PullToRefresh';
import ModalShell from '../../../components/ModalShell';

interface Tour {
  id: number;
  googleCalendarId: string | null;
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

const ToursTab: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [tours, setTours] = useState<Tour[]>([]);
  const [todayTours, setTodayTours] = useState<Tour[]>([]);
  const [pastTours, setPastTours] = useState<Tour[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [checkInModalOpen, setCheckInModalOpen] = useState(false);
  const [selectedTour, setSelectedTour] = useState<Tour | null>(null);
  const typeformContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  const fetchTours = useCallback(async () => {
    try {
      const [todayRes, allToursRes] = await Promise.all([
        fetch('/api/tours/today', { credentials: 'include' }),
        fetch('/api/tours', { credentials: 'include' })
      ]);
      
      if (todayRes.ok) {
        const data = await todayRes.json();
        setTodayTours(data);
      }
      
      if (allToursRes.ok) {
        const data = await allToursRes.json();
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        
        const upcoming: Tour[] = [];
        const past: Tour[] = [];
        
        data.forEach((t: Tour) => {
          if (t.tourDate === todayStr) return;
          if (t.tourDate > todayStr) {
            // Filter out cancelled tours from upcoming list
            if (t.status !== 'cancelled') {
              upcoming.push(t);
            }
          } else {
            past.push(t);
          }
        });
        
        upcoming.sort((a, b) => a.tourDate.localeCompare(b.tourDate));
        past.sort((a, b) => b.tourDate.localeCompare(a.tourDate));
        
        setTours(upcoming);
        setPastTours(past);
      }
    } catch (err) {
      console.error('Failed to fetch tours:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTours();
  }, [fetchTours]);

  const handlePullRefresh = useCallback(async () => {
    setSyncMessage(null);
    const maxRetries = 3;
    
    const attemptSync = async (attempt = 1): Promise<{ ok: boolean; data: any }> => {
      try {
        const res = await fetch('/api/tours/sync', { method: 'POST', credentials: 'include' });
        const data = await res.json();
        return { ok: res.ok, data };
      } catch (err: any) {
        if (attempt < maxRetries && (err.message?.includes('fetch') || err.message?.includes('network'))) {
          await new Promise(r => setTimeout(r, 500 * attempt));
          return attemptSync(attempt + 1);
        }
        throw err;
      }
    };
    
    try {
      const { ok, data } = await attemptSync();
      if (ok) {
        setSyncMessage(`Synced ${data.synced} tours (${data.created} new, ${data.updated} updated)`);
      } else {
        setSyncMessage(data.error || 'Sync failed');
      }
    } catch (err) {
      setSyncMessage('Network error - please try again');
    }
    await fetchTours();
  }, [fetchTours]);

  const openCheckIn = (tour: Tour) => {
    setSelectedTour(tour);
    setCheckInModalOpen(true);
  };

  const handleCheckIn = async () => {
    if (!selectedTour) return;
    
    // Optimistic UI: mark tour as checked in immediately across all lists
    const previousTodayTours = [...todayTours];
    const previousTours = [...tours];
    const previousPastTours = [...pastTours];
    
    const updateTour = (t: Tour) => 
      t.id === selectedTour.id ? { ...t, status: 'checked_in' as const } : t;
    
    setTodayTours(prev => prev.map(updateTour));
    setTours(prev => prev.map(updateTour));
    setPastTours(prev => prev.map(updateTour));
    setCheckInModalOpen(false);
    setSelectedTour(null);
    
    try {
      const res = await fetch(`/api/tours/${selectedTour.id}/checkin`, {
        method: 'POST',
        credentials: 'include'
      });
      if (res.ok) {
        fetchTours(); // Sync with server
      } else {
        // Revert on failure
        setTodayTours(previousTodayTours);
        setTours(previousTours);
        setPastTours(previousPastTours);
      }
    } catch (err) {
      // Revert on error
      setTodayTours(previousTodayTours);
      setTours(previousTours);
      setPastTours(previousPastTours);
      console.error('Check-in failed:', err);
    }
  };

  useEffect(() => {
    if (checkInModalOpen && typeformContainerRef.current && selectedTour) {
      typeformContainerRef.current.innerHTML = '';
      const script = document.createElement('script');
      script.src = '//embed.typeform.com/next/embed.js';
      script.async = true;
      
      const formDiv = document.createElement('div');
      formDiv.setAttribute('data-tf-live', '01KDGXG8YBRCC5S8Z1YZWDBQB8');
      formDiv.style.width = '100%';
      formDiv.style.height = '500px';
      
      typeformContainerRef.current.appendChild(formDiv);
      typeformContainerRef.current.appendChild(script);
    }
  }, [checkInModalOpen, selectedTour]);

  const formatDate = (dateStr: string) => {
    const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    return formatDateDisplayWithDay(datePart);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin"></div>
      </div>
    );
  }

  const TourCard = ({ tour, isToday = false, isPast = false }: { tour: Tour; isToday?: boolean; isPast?: boolean }) => (
    <div className={`p-4 rounded-2xl border ${tour.status === 'checked_in' 
      ? 'bg-green-500/10 border-green-500/30' 
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
        <div className="flex-shrink-0">
          {tour.status === 'checked_in' ? (
            <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-green-500/20 text-green-700 dark:text-green-400 text-xs font-bold">
              <span aria-hidden="true" className="material-symbols-outlined text-sm">check_circle</span>
              Checked In
            </span>
          ) : isToday ? (
            <button
              onClick={() => openCheckIn(tour)}
              className="px-4 py-2 rounded-full bg-accent text-primary text-xs font-bold hover:opacity-90 transition-opacity flex items-center gap-1"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-sm">how_to_reg</span>
              Check In
            </button>
          ) : isPast ? (
            <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-primary/5 dark:bg-white/5 text-primary/70 dark:text-white/70 text-xs font-medium">
              <span aria-hidden="true" className="material-symbols-outlined text-sm">event_busy</span>
              Completed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-primary/10 dark:bg-white/10 text-primary/70 dark:text-white/70 text-xs font-medium">
              <span aria-hidden="true" className="material-symbols-outlined text-sm">schedule</span>
              Scheduled
            </span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <PullToRefresh onRefresh={handlePullRefresh}>
      <div className="space-y-6 animate-pop-in pb-32">
        <p className="text-sm text-primary/80 dark:text-white/80">
          Synced from Google Calendar: <span className="font-medium">Tours Scheduled</span>
        </p>

      {syncMessage && (
        <div className="p-3 rounded-xl bg-accent/20 text-primary dark:text-accent text-sm text-center">
          {syncMessage}
        </div>
      )}

      {todayTours.length > 0 && (
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-primary/70 dark:text-white/70 mb-3 flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-lg">today</span>
            Today's Tours ({todayTours.length})
          </h3>
          <div className="space-y-3">
            {todayTours.map((tour) => (
              <TourCard key={tour.id} tour={tour} isToday />
            ))}
          </div>
        </div>
      )}

      {todayTours.length === 0 && (
        <div className="text-center py-8 bg-white/40 dark:bg-white/5 rounded-2xl">
          <span aria-hidden="true" className="material-symbols-outlined text-4xl text-primary/30 dark:text-white/70 mb-2">event_available</span>
          <p className="text-primary/80 dark:text-white/80 text-sm">No tours scheduled for today</p>
        </div>
      )}

      {tours.length > 0 && (
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-primary/70 dark:text-white/70 mb-3 flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-lg">upcoming</span>
            Upcoming Tours ({tours.length})
          </h3>
          <div className="space-y-3">
            {tours.map((tour) => (
              <TourCard key={tour.id} tour={tour} />
            ))}
          </div>
        </div>
      )}

      {todayTours.length === 0 && tours.length === 0 && pastTours.length === 0 && (
        <div className="text-center py-12">
          <span aria-hidden="true" className="material-symbols-outlined text-5xl text-primary/20 dark:text-white/20 mb-3">directions_walk</span>
          <p className="text-primary/70 dark:text-white/70">No tours found</p>
          <p className="text-sm text-primary/70 dark:text-white/70 mt-1">
            Tours will appear here after syncing from Google Calendar
          </p>
        </div>
      )}

      {pastTours.length > 0 && (
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-primary/70 dark:text-white/70 mb-3 flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-lg">history</span>
            Past Tours ({pastTours.length})
          </h3>
          <div className="space-y-3">
            {pastTours.map((tour) => (
              <TourCard key={tour.id} tour={tour} isPast />
            ))}
          </div>
        </div>
      )}

      <ModalShell isOpen={checkInModalOpen && !!selectedTour} onClose={() => setCheckInModalOpen(false)} title={`Check In: ${selectedTour?.guestName || selectedTour?.title || ''}`} showCloseButton={true} size="full">
        <div className="p-6 space-y-4">
          <p className="text-sm text-primary/80 dark:text-white/80">Complete the check-in form below</p>
          <div ref={typeformContainerRef} className="min-h-[500px]"></div>
          <div className="flex justify-end gap-3 pt-4 border-t border-primary/10 dark:border-white/25">
            <button
              onClick={() => setCheckInModalOpen(false)}
              className="px-4 py-2 rounded-full text-sm font-medium text-primary/70 dark:text-white/70 hover:bg-primary/10 dark:hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCheckIn}
              className="px-6 py-2 rounded-full bg-accent text-primary text-sm font-bold hover:opacity-90 transition-opacity flex items-center gap-2"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-sm">check_circle</span>
              Mark as Checked In
            </button>
          </div>
        </div>
      </ModalShell>
      </div>
    </PullToRefresh>
  );
};

export default ToursTab;
