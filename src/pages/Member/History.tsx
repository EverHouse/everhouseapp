import React, { useState, useEffect, useCallback } from 'react';
import { useData } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { apiRequest } from '../../lib/apiRequest';
import TabButton from '../../components/TabButton';
import SwipeablePage from '../../components/SwipeablePage';
import PullToRefresh from '../../components/PullToRefresh';
import MemberBottomNav from '../../components/MemberBottomNav';
import { BottomSentinel } from '../../components/layout/BottomSentinel';
import { formatDateShort, getTodayString, formatTime12Hour, getNowTimePacific, getRelativeDateLabel } from '../../utils/dateUtils';
import { getStatusColor, formatStatusLabel } from '../../utils/statusColors';

interface BookingRecord {
  id: number;
  resource_id: number;
  bay_name?: string;
  resource_name?: string;
  resource_preference?: string;
  user_email: string;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes?: number;
  status: string;
  notes: string;
}

interface RSVPRecord {
  id: number;
  event_id: number;
  status: string;
  title: string;
  event_date: string;
  start_time: string;
  location: string;
  category: string;
  order_date?: string;
  created_at?: string;
}

interface WellnessEnrollmentRecord {
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

const normalizeTime = (time: string | null | undefined): string => {
  if (!time) return '00:00';
  const parts = time.split(':');
  if (parts.length < 2) return '00:00';
  const hours = parts[0].padStart(2, '0');
  const minutes = parts[1].slice(0, 2).padStart(2, '0');
  return `${hours}:${minutes}`;
};

const History: React.FC = () => {
  const { user } = useData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const isDark = effectiveTheme === 'dark';
  
  const [activeTab, setActiveTab] = useState<'bookings' | 'experiences'>('bookings');
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [rsvps, setRSVPs] = useState<RSVPRecord[]>([]);
  const [wellnessEnrollments, setWellnessEnrollments] = useState<WellnessEnrollmentRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchBookings = useCallback(async () => {
    if (!user?.email) return;
    try {
      const { ok, data } = await apiRequest<BookingRecord[]>(
        `/api/booking-requests?user_email=${encodeURIComponent(user.email)}`
      );
      if (ok && data) {
        const today = getTodayString();
        const nowTime = getNowTimePacific();
        
        const pastBookings = data.filter(b => {
          const bookingDate = b.request_date?.split('T')[0] || b.request_date;
          const isPast = bookingDate < today;
          const isToday = bookingDate === today;
          const status = b.status?.toLowerCase() || '';
          
          // Exclude cancelled and declined - only show actual bookings
          if (status === 'cancelled' || status === 'declined') return false;
          
          const terminalStatuses = ['attended', 'no_show'];
          const isTerminalStatus = terminalStatuses.includes(status);
          
          if (isPast) return true;
          if (isToday && isTerminalStatus) return true;
          if (isToday && b.end_time && normalizeTime(b.end_time) <= nowTime) return true;
          return false;
        });
        pastBookings.sort((a, b) => {
          const dateA = a.request_date?.split('T')[0] || a.request_date;
          const dateB = b.request_date?.split('T')[0] || b.request_date;
          return dateB.localeCompare(dateA);
        });
        setBookings(pastBookings);
      }
    } catch (err) {
      console.error('[History] Failed to fetch bookings:', err);
    }
  }, [user?.email]);

  const fetchRSVPs = useCallback(async () => {
    if (!user?.email) return;
    try {
      const { ok, data } = await apiRequest<RSVPRecord[]>(
        `/api/rsvps?user_email=${encodeURIComponent(user.email)}&include_past=true`
      );
      if (ok && data) {
        const today = getTodayString();
        const nowTime = getNowTimePacific();
        
        const pastRsvps = data.filter(r => {
          const eventDate = r.event_date?.split('T')[0] || r.event_date;
          const isPast = eventDate < today;
          const isToday = eventDate === today;
          if (isPast) return true;
          if (isToday && r.start_time && normalizeTime(r.start_time) <= nowTime) return true;
          return false;
        });
        pastRsvps.sort((a, b) => b.event_date.localeCompare(a.event_date));
        setRSVPs(pastRsvps);
      }
    } catch (err) {
      console.error('[History] Failed to fetch RSVPs:', err);
    }
  }, [user?.email]);

  const fetchWellnessEnrollments = useCallback(async () => {
    if (!user?.email) return;
    try {
      const { ok, data } = await apiRequest<WellnessEnrollmentRecord[]>(
        `/api/wellness-enrollments?user_email=${encodeURIComponent(user.email)}&include_past=true`
      );
      if (ok && data) {
        const today = getTodayString();
        const nowTime = getNowTimePacific();
        
        const pastEnrollments = data.filter(e => {
          const enrollmentDate = e.date?.split('T')[0] || e.date;
          const isPast = enrollmentDate < today;
          const isToday = enrollmentDate === today;
          if (isPast) return true;
          if (isToday && e.time && normalizeTime(e.time) <= nowTime) return true;
          return false;
        });
        pastEnrollments.sort((a, b) => {
          const dateA = a.date?.split('T')[0] || a.date;
          const dateB = b.date?.split('T')[0] || b.date;
          return dateB.localeCompare(dateA);
        });
        setWellnessEnrollments(pastEnrollments);
      }
    } catch (err) {
      console.error('[History] Failed to fetch wellness enrollments:', err);
    }
  }, [user?.email]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    await Promise.all([fetchBookings(), fetchRSVPs(), fetchWellnessEnrollments()]);
    setIsLoading(false);
  }, [fetchBookings, fetchRSVPs, fetchWellnessEnrollments]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  const handleRefresh = useCallback(async () => {
    await loadData();
  }, [loadData]);

  const experiencesCount = rsvps.length + wellnessEnrollments.length;

  const combinedExperiences = [
    ...rsvps.map(r => ({
      id: `rsvp-${r.id}`,
      title: r.title,
      date: r.event_date?.split('T')[0] || r.event_date,
      time: r.start_time,
      type: 'Event' as const,
      category: r.category,
      location: r.location
    })),
    ...wellnessEnrollments.map(w => ({
      id: `wellness-${w.id}`,
      title: w.title,
      date: w.date?.split('T')[0] || w.date,
      time: w.time,
      type: 'Wellness' as const,
      category: w.category,
      instructor: w.instructor
    }))
  ].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <SwipeablePage className="px-6 relative overflow-hidden">
        <section className="mb-4 pt-4 md:pt-2 animate-pop-in">
          <h1 className={`text-3xl font-bold leading-tight drop-shadow-md ${isDark ? 'text-white' : 'text-primary'}`}>History</h1>
          <p className={`text-sm font-medium mt-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Your past bookings and experiences.</p>
        </section>

        <section className={`mb-6 border-b -mx-6 px-6 animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`} style={{animationDelay: '0.05s'}}>
          <div className="flex gap-6 overflow-x-auto pb-0 scrollbar-hide scroll-fade-right">
            <TabButton label="Bookings" active={activeTab === 'bookings'} onClick={() => setActiveTab('bookings')} isDark={isDark} />
            <TabButton label="Experiences" active={activeTab === 'experiences'} onClick={() => setActiveTab('experiences')} isDark={isDark} />
          </div>
        </section>

        <div className="relative z-10 animate-pop-in" style={{animationDelay: '0.1s'}}>
          {isLoading ? (
            <div className="animate-pulse space-y-4">
              {[1, 2, 3].map(i => (
                <div key={i} className={`h-24 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-black/5'}`} />
              ))}
            </div>
          ) : activeTab === 'bookings' ? (
            <div className="space-y-4">
              <div className={`text-sm font-medium ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                {bookings.length} past booking{bookings.length !== 1 ? 's' : ''}
              </div>
              {bookings.length === 0 ? (
                <div className={`text-center py-12 rounded-2xl border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}>
                  <span className={`material-symbols-outlined text-5xl mb-4 ${isDark ? 'text-white/30' : 'text-primary/30'}`}>history</span>
                  <p className={`${isDark ? 'text-white/80' : 'text-primary/80'}`}>No past bookings yet</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {bookings.map((booking, index) => {
                    const isConferenceRoom = booking.resource_id === 11 || 
                      (booking.resource_name?.toLowerCase()?.includes('conference') ?? false) ||
                      (booking.bay_name?.toLowerCase()?.includes('conference') ?? false) ||
                      (booking.notes?.toLowerCase()?.includes('conference') ?? false);
                    const resourceTypeLabel = isConferenceRoom ? 'Conference Room' : 'Golf Sim';
                    const resourceIcon = isConferenceRoom ? 'meeting_room' : 'golf_course';
                    const resourceDetail = booking.bay_name || booking.resource_name || booking.resource_preference;
                    
                    return (
                    <div 
                      key={booking.id} 
                      className={`rounded-xl p-4 border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}
                      style={{animationDelay: `${0.05 * index}s`}}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 ${
                              isConferenceRoom
                                ? (isDark ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-100 text-blue-700')
                                : (isDark ? 'bg-accent/20 text-accent' : 'bg-accent/20 text-brand-green')
                            }`}>
                              <span className="material-symbols-outlined text-xs">{resourceIcon}</span>
                              {resourceTypeLabel}
                            </span>
                          </div>
                          <p className={`font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                            {getRelativeDateLabel(booking.request_date?.split('T')[0] || booking.request_date)}
                          </p>
                          <p className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                            {formatTime12Hour(booking.start_time)} - {formatTime12Hour(booking.end_time)}
                          </p>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${getStatusColor(booking.status, isDark)}`}>
                          {formatStatusLabel(booking.status)}
                        </span>
                      </div>
                      {resourceDetail && !isConferenceRoom && (
                        <p className={`text-sm flex items-center gap-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                          <span className="material-symbols-outlined text-sm">golf_course</span>
                          {resourceDetail}
                        </p>
                      )}
                    </div>
                  );})}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className={`text-sm font-medium ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                {experiencesCount} past experience{experiencesCount !== 1 ? 's' : ''}
              </div>
              {combinedExperiences.length === 0 ? (
                <div className={`text-center py-12 rounded-2xl border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}>
                  <span className={`material-symbols-outlined text-5xl mb-4 ${isDark ? 'text-white/30' : 'text-primary/30'}`}>celebration</span>
                  <p className={`${isDark ? 'text-white/80' : 'text-primary/80'}`}>No past experiences yet</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {combinedExperiences.map((exp, index) => (
                    <div 
                      key={exp.id} 
                      className={`rounded-xl p-4 border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}
                      style={{animationDelay: `${0.05 * index}s`}}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
                              exp.type === 'Event' 
                                ? (isDark ? 'bg-accent/20 text-accent' : 'bg-accent/20 text-brand-green')
                                : (isDark ? 'bg-lavender/20 text-lavender' : 'bg-lavender/30 text-purple-700')
                            }`}>
                              {exp.type}
                            </span>
                            {exp.category && (
                              <span className={`text-xs ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                                {exp.category}
                              </span>
                            )}
                          </div>
                          <p className={`font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                            {exp.title}
                          </p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className={`text-sm font-bold ${isDark ? 'text-accent' : 'text-primary'}`}>
                            {getRelativeDateLabel(exp.date)}
                          </p>
                          {exp.time && (
                            <p className={`text-xs ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                              {formatTime12Hour(exp.time)}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <BottomSentinel />
      </SwipeablePage>
      <MemberBottomNav currentPath="/history" isDarkTheme={isDark} />
    </PullToRefresh>
  );
};

export default History;
