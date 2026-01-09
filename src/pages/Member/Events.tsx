import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useData, EventData } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useToast } from '../../components/Toast';
import { apiRequest } from '../../lib/apiRequest';
import { EventCardSkeleton, SkeletonList } from '../../components/skeletons';
import TabButton from '../../components/TabButton';
import SwipeablePage from '../../components/SwipeablePage';
import PullToRefresh from '../../components/PullToRefresh';
import { MotionList, MotionListItem } from '../../components/motion';
import { EmptyEvents } from '../../components/EmptyState';
import { downloadICalFile } from '../../utils/icalUtils';
import { getTodayPacific } from '../../utils/dateUtils';
import WalkingGolferSpinner from '../../components/WalkingGolferSpinner';
import ModalShell from '../../components/ModalShell';
import { bookingEvents } from '../../lib/bookingEvents';

interface UserRsvp {
  event_id: number;
  status: string;
}

const MemberEvents: React.FC = () => {
  const { events, isLoading, user, actualUser, isViewingAs, viewAsUser } = useData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const { showToast } = useToast();
  const isDark = effectiveTheme === 'dark';
  const [filter, setFilter] = useState('All');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [userRsvps, setUserRsvps] = useState<UserRsvp[]>([]);
  const [loadingRsvp, setLoadingRsvp] = useState<string | null>(null);
  const [showViewAsConfirm, setShowViewAsConfirm] = useState(false);
  const [pendingEvent, setPendingEvent] = useState<EventData | null>(null);
  
  const isAdminViewingAs = actualUser?.role === 'admin' && isViewingAs;

  const fetchUserRsvps = useCallback(async () => {
    if (!user?.email) return;
    try {
      const { ok, data } = await apiRequest(`/api/rsvps?user_email=${encodeURIComponent(user.email)}`);
      if (ok && data) {
        setUserRsvps(data.map((r: any) => ({ event_id: r.event_id, status: r.status })));
      }
    } catch (err) {
      console.error('Failed to fetch RSVPs:', err);
    }
  }, [user?.email]);

  useEffect(() => {
    fetchUserRsvps();
  }, [fetchUserRsvps]);

  // Subscribe to real-time updates for RSVPs
  useEffect(() => {
    const unsubscribe = bookingEvents.subscribe(() => {
      fetchUserRsvps();
    });
    return unsubscribe;
  }, [fetchUserRsvps]);

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  const filteredAndSortedEvents = useMemo(() => {
    let result = events;
    
    if (filter !== 'All') {
      result = result.filter(e => e.category.toLowerCase() === filter.toLowerCase());
    }
    
    return [...result].sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      return dateA.getTime() - dateB.getTime();
    });
  }, [events, filter]);

  const hasRsvp = (eventId: string) => {
    return userRsvps.some(r => r.event_id === parseInt(eventId) && r.status === 'confirmed');
  };

  const handleCardClick = (eventId: string) => {
    setExpandedEventId(expandedEventId === eventId ? null : eventId);
  };

  const submitRSVP = async (event: EventData) => {
    if (event.source === 'eventbrite' && event.externalLink) {
      window.open(event.externalLink, '_blank');
      return;
    }

    if (user?.email) {
      setLoadingRsvp(event.id);
      
      // Optimistic UI: add RSVP immediately
      const previousRsvps = [...userRsvps];
      setUserRsvps(prev => [...prev, { event_id: parseInt(event.id), user_email: user.email, status: 'confirmed' } as any]);
      
      const { ok, error } = await apiRequest('/api/rsvps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: event.id,
          user_email: user.email
        })
      });
      
      if (ok) {
        showToast('You are on the list!', 'success');
        fetchUserRsvps(); // Sync with server
      } else {
        // Revert on failure
        setUserRsvps(previousRsvps);
        showToast(error || 'Unable to RSVP. Please try again.', 'error');
      }
      setLoadingRsvp(null);
    }
  };

  const cancelRSVP = async (event: EventData) => {
    if (user?.email) {
      setLoadingRsvp(event.id);
      
      // Optimistic UI: remove RSVP immediately
      const previousRsvps = [...userRsvps];
      setUserRsvps(prev => prev.filter(r => r.event_id !== parseInt(event.id)));
      
      const { ok, error } = await apiRequest(`/api/rsvps/${event.id}/${encodeURIComponent(user.email)}`, {
        method: 'DELETE'
      });
      
      if (ok) {
        showToast('RSVP cancelled', 'success');
        fetchUserRsvps(); // Sync with server
      } else {
        // Revert on failure
        setUserRsvps(previousRsvps);
        showToast(error || 'Unable to cancel. Please try again.', 'error');
      }
      setLoadingRsvp(null);
    }
  };

  const handleRSVP = async (event: EventData) => {
    if (isAdminViewingAs && event.source !== 'eventbrite') {
      setPendingEvent(event);
      setShowViewAsConfirm(true);
      return;
    }
    await submitRSVP(event);
  };

  const handleCancelRSVP = async (event: EventData) => {
    if (isAdminViewingAs) {
      setPendingEvent(event);
      setShowViewAsConfirm(true);
      return;
    }
    await cancelRSVP(event);
  };

  const handleAddToCalendar = (event: EventData) => {
    // Parse time formats: "9:30 AM", "7 PM", "19:00", "7:00 PM"
    const timeStr = (event.time || '12:00 PM').trim();
    
    // Match patterns: "H:MM AM/PM", "H AM/PM", or "HH:MM" (24-hour)
    const match12Hour = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    const match24Hour = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    
    let hours: number;
    let minutes: number;
    
    if (match12Hour) {
      hours = parseInt(match12Hour[1]);
      minutes = match12Hour[2] ? parseInt(match12Hour[2]) : 0;
      const period = match12Hour[3].toUpperCase();
      // Convert 12-hour to 24-hour: 12 AM = 0, 12 PM = 12, others add 12 for PM
      if (period === 'AM') {
        hours = hours === 12 ? 0 : hours;
      } else {
        hours = hours === 12 ? 12 : hours + 12;
      }
    } else if (match24Hour) {
      hours = parseInt(match24Hour[1]);
      minutes = parseInt(match24Hour[2]);
    } else {
      // Default to noon
      hours = 12;
      minutes = 0;
    }
    
    const startTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    
    try {
      downloadICalFile({
        title: event.title,
        description: event.description,
        location: event.location,
        startDate: event.date || getTodayPacific(),
        startTime: startTime,
        durationMinutes: 120
      });
    } catch (err) {
      console.error('Failed to add to calendar:', err);
    }
  };

  const confirmViewAsAction = async () => {
    if (pendingEvent) {
      if (hasRsvp(pendingEvent.id)) {
        await cancelRSVP(pendingEvent);
      } else {
        await submitRSVP(pendingEvent);
      }
    }
    setShowViewAsConfirm(false);
    setPendingEvent(null);
  };

  const handleRefresh = useCallback(async () => {
    await fetchUserRsvps();
  }, [fetchUserRsvps]);

  return (
    <PullToRefresh onRefresh={handleRefresh}>
    <SwipeablePage className="px-6 relative overflow-hidden">
      <section className="mb-4 pt-4 md:pt-2">
        <p className={`text-sm font-medium ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Discover what's happening at the House.</p>
      </section>

      <section className={`mb-6 border-b -mx-6 px-6 ${isDark ? 'border-white/25' : 'border-black/10'}`}>
        <div className="flex gap-6 overflow-x-auto pb-0 scrollbar-hide scroll-fade-right">
          {['All', 'Social', 'Golf', 'Tournaments', 'Dining', 'Networking', 'Workshops', 'Family', 'Entertainment', 'Charity'].map(cat => (
            <TabButton 
              key={cat} 
              label={cat} 
              active={filter === cat} 
              onClick={() => setFilter(cat)} 
              isDark={isDark}
            />
          ))}
        </div>
      </section>

      <section className="mb-6">
        <div className={`transition-opacity duration-300 ${isLoading ? 'opacity-100' : 'opacity-0 hidden'}`}>
          <SkeletonList count={4} Component={EventCardSkeleton} isDark={isDark} className="space-y-4" />
        </div>
        <div className={`transition-opacity duration-300 ${isLoading ? 'opacity-0 hidden' : 'opacity-100'}`}>
          {filteredAndSortedEvents.length === 0 ? (
            <EmptyEvents />
          ) : (
            <MotionList className="space-y-4">
              {filteredAndSortedEvents.map((event) => {
                const isExpanded = expandedEventId === event.id;
                const isRsvpd = hasRsvp(event.id);
                const isLoadingThis = loadingRsvp === event.id;
                
                return (
                  <MotionListItem 
                    key={event.id}
                    className={`rounded-2xl overflow-hidden transition-all glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}
                  >
                    <div 
                      onClick={() => handleCardClick(event.id)}
                      className={`flex gap-4 p-4 cursor-pointer transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}
                    >
                      <div className={`w-20 h-20 flex-shrink-0 rounded-xl overflow-hidden relative flex items-center justify-center ${isDark ? 'bg-lavender/20' : 'bg-primary/10'}`}>
                        <span className={`material-symbols-outlined text-3xl ${isDark ? 'text-lavender' : 'text-primary'}`}>
                          {event.category === 'Golf' ? 'golf_course' : 
                           event.category === 'Wellness' ? 'spa' : 
                           event.category === 'Social' ? 'groups' : 'event'}
                        </span>
                        {event.source === 'eventbrite' && (
                          <div className="absolute bottom-0 left-0 right-0 bg-[#F05537] text-white text-[8px] font-bold uppercase text-center py-0.5">
                            Eventbrite
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start mb-1">
                          <h4 className={`text-base font-bold leading-tight truncate pr-2 ${isDark ? 'text-white' : 'text-primary'}`}>{event.title}</h4>
                          {isRsvpd ? (
                            <span className="text-[10px] font-bold uppercase tracking-wider bg-accent text-brand-green px-1.5 py-0.5 rounded-md whitespace-nowrap">Going</span>
                          ) : event.source === 'eventbrite' ? (
                            <span className="text-[10px] font-bold uppercase tracking-wider bg-[#F05537]/20 text-[#F05537] px-1.5 py-0.5 rounded-md whitespace-nowrap">Ticketed</span>
                          ) : (
                            <span className="text-[10px] font-bold uppercase tracking-wider bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded-md whitespace-nowrap">Open</span>
                          )}
                        </div>
                        <p className={`text-xs mb-1 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>{event.date} • {event.time}</p>
                        <p className={`text-xs truncate ${isDark ? 'text-white/70' : 'text-primary/70'}`}>{event.location}</p>
                      </div>
                      <div className="flex items-center">
                        <span className={`material-symbols-outlined transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''} ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                          expand_more
                        </span>
                      </div>
                    </div>

                    <div 
                      className={`overflow-hidden transition-all duration-300 ease-in-out ${isExpanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}`}
                    >
                      <div className={`px-4 pb-4 pt-2 border-t ${isDark ? 'border-white/25' : 'border-black/10'}`}>
                        <p className={`text-sm leading-relaxed mb-4 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                          {event.description}
                        </p>

                        {(event.ticketsSold || event.capacity) && (
                          <div className={`flex items-center gap-2 mb-4 text-xs ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                            <span className="material-symbols-outlined text-sm">group</span>
                            <span>
                              {event.ticketsSold || 0} / {event.capacity || '∞'} spots filled
                            </span>
                          </div>
                        )}

                        <div className="flex gap-3">
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleAddToCalendar(event); }}
                            className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-black/5 text-primary hover:bg-black/10'}`}
                          >
                            <span className="material-symbols-outlined text-lg">calendar_add_on</span>
                            Add to Cal
                          </button>
                          
                          {user?.status && user.status.toLowerCase() !== 'active' ? (
                            <div className={`flex-1 py-3 rounded-xl flex items-center justify-center ${isDark ? 'bg-white/10' : 'bg-[#F2F2EC]'}`}>
                              <span className={`text-xs font-medium ${isDark ? 'text-white/60' : 'text-primary/60'}`}>Members Only Event</span>
                            </div>
                          ) : isRsvpd ? (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleCancelRSVP(event); }}
                              disabled={isLoadingThis}
                              className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-colors border flex items-center justify-center gap-2 ${isDark ? 'border-red-500/50 text-red-400 hover:bg-red-500/10' : 'border-red-500/50 text-red-500 hover:bg-red-500/10'} ${isLoadingThis ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                              {isLoadingThis ? <WalkingGolferSpinner size="sm" variant={isDark ? 'light' : 'dark'} /> : 'Cancel RSVP'}
                            </button>
                          ) : event.source === 'eventbrite' ? (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleRSVP(event); }}
                              className="flex-1 py-3 rounded-xl font-semibold text-sm bg-[#F05537] text-white hover:bg-[#d94829] transition-colors"
                            >
                              Get Tickets
                            </button>
                          ) : (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleRSVP(event); }}
                              disabled={isLoadingThis}
                              className={`flex-1 py-3 rounded-xl font-semibold text-sm bg-brand-green text-white hover:opacity-90 transition-opacity flex items-center justify-center gap-2 ${isLoadingThis ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                              {isLoadingThis ? <WalkingGolferSpinner size="sm" variant="light" /> : 'RSVP'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </MotionListItem>
                );
              })}
            </MotionList>
          )}
        </div>
      </section>

      <ModalShell 
        isOpen={showViewAsConfirm && !!viewAsUser && !!pendingEvent} 
        onClose={() => { setShowViewAsConfirm(false); setPendingEvent(null); }}
        title={pendingEvent && hasRsvp(pendingEvent.id) ? 'Cancel RSVP on Behalf' : 'RSVP on Behalf'}
        size="sm"
      >
        {viewAsUser && pendingEvent && (
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
                <span className="material-symbols-outlined text-2xl text-amber-500">warning</span>
              </div>
              <div>
                <p className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>View As Mode Active</p>
              </div>
            </div>
            
            <p className={`text-sm mb-6 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
              You're about to {hasRsvp(pendingEvent.id) ? 'cancel the RSVP for' : 'RSVP to'} <span className="font-bold">{pendingEvent.title}</span> on behalf of <span className="font-bold">{viewAsUser.name}</span>.
            </p>
            
            <div className="flex gap-3">
              <button 
                onClick={() => { setShowViewAsConfirm(false); setPendingEvent(null); }}
                className={`flex-1 py-3 px-4 rounded-xl font-bold text-sm transition-colors ${isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-black/5 text-primary hover:bg-black/10'}`}
              >
                Cancel
              </button>
              <button 
                onClick={confirmViewAsAction}
                className="flex-1 py-3 px-4 rounded-xl font-bold text-sm bg-accent text-brand-green hover:bg-accent/90 transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        )}
      </ModalShell>
    </SwipeablePage>
    </PullToRefresh>
  );
};

export default MemberEvents;
