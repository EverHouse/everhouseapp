import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useData, EventData } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useToast } from '../../components/Toast';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials } from '../../hooks/queries/useFetch';
import { EventCardSkeleton, SkeletonList } from '../../components/skeletons';
import TabButton from '../../components/TabButton';
import SwipeablePage from '../../components/SwipeablePage';
import { MotionList, MotionListItem, AnimatedPage } from '../../components/motion';
import { EmptyEvents } from '../../components/EmptyState';
import { downloadICalFile } from '../../utils/icalUtils';
import { getTodayPacific } from '../../utils/dateUtils';
import WalkingGolferSpinner from '../../components/WalkingGolferSpinner';
import ModalShell from '../../components/ModalShell';
import { bookingEvents } from '../../lib/bookingEvents';
import { useAutoAnimate } from '@formkit/auto-animate/react';

interface UserRsvp {
  event_id: number;
  status: string;
}

type OptimisticAction = 'rsvp' | 'cancel';

const parseEventTime = (timeStr: string): { time: string; period: string } => {
  const t = (timeStr || '').trim();
  const m = t.match(/^(\d{1,2}(?::\d{2})?)\s*(AM|PM)$/i);
  if (m) return { time: m[1], period: m[2].toUpperCase() };
  return { time: t, period: '' };
};

const MemberEvents: React.FC = () => {
  const { events, isLoading, user, actualUser, isViewingAs, viewAsUser } = useData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const isDark = effectiveTheme === 'dark';
  const [filter, setFilter] = useState('All');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [loadingRsvp, setLoadingRsvp] = useState<string | null>(null);
  const [showViewAsConfirm, setShowViewAsConfirm] = useState(false);
  const [pendingEvent, setPendingEvent] = useState<EventData | null>(null);
  const [optimisticActions, setOptimisticActions] = useState<Map<string, OptimisticAction>>(new Map());
  
  const [eventsParent] = useAutoAnimate();
  const isAdminViewingAs = actualUser?.role === 'admin' && isViewingAs;
  
  const getOptimisticAction = (eventId: string): OptimisticAction | null => {
    return optimisticActions.get(eventId) || null;
  };
  
  const setOptimisticAction = (eventId: string, action: OptimisticAction) => {
    setOptimisticActions(prev => new Map(prev).set(eventId, action));
  };
  
  const clearOptimisticAction = (eventId: string) => {
    setOptimisticActions(prev => {
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
  };

  const { data: userRsvps = [], refetch: refetchRsvps } = useQuery({
    queryKey: ['user-rsvps', user?.email],
    queryFn: async () => {
      if (!user?.email) return [];
      const data = await fetchWithCredentials<Array<{ event_id: number; status: string }>>(`/api/rsvps?user_email=${encodeURIComponent(user.email)}`);
      return data.map((r: { event_id: number; status: string }) => ({ event_id: r.event_id, status: r.status }));
    },
    enabled: !!user?.email,
  });

  const rsvpMutation = useMutation({
    mutationFn: async ({ eventId, userEmail }: { eventId: string; userEmail: string }) => {
      return postWithCredentials('/api/rsvps', {
        event_id: eventId,
        user_email: userEmail
      });
    },
    onMutate: async ({ eventId }) => {
      setOptimisticAction(eventId, 'rsvp');
      await queryClient.cancelQueries({ queryKey: ['user-rsvps', user?.email] });
      const previousRsvps = queryClient.getQueryData<UserRsvp[]>(['user-rsvps', user?.email]);
      queryClient.setQueryData<UserRsvp[]>(['user-rsvps', user?.email], (old = []) => [
        ...old,
        { event_id: parseInt(eventId), status: 'confirmed' }
      ]);
      return { previousRsvps, eventId };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousRsvps) {
        queryClient.setQueryData(['user-rsvps', user?.email], context.previousRsvps);
      }
      showToast('Unable to RSVP. Please try again.', 'error');
    },
    onSuccess: () => {
      showToast('You are on the list!', 'success');
    },
    onSettled: (_data, _error, variables) => {
      setLoadingRsvp(null);
      clearOptimisticAction(variables.eventId);
      queryClient.invalidateQueries({ queryKey: ['user-rsvps', user?.email] });
    }
  });

  const cancelRsvpMutation = useMutation({
    mutationFn: async ({ eventId, userEmail }: { eventId: string; userEmail: string }) => {
      return deleteWithCredentials(`/api/rsvps/${eventId}/${encodeURIComponent(userEmail)}`);
    },
    onMutate: async ({ eventId }) => {
      setOptimisticAction(eventId, 'cancel');
      await queryClient.cancelQueries({ queryKey: ['user-rsvps', user?.email] });
      const previousRsvps = queryClient.getQueryData<UserRsvp[]>(['user-rsvps', user?.email]);
      queryClient.setQueryData<UserRsvp[]>(['user-rsvps', user?.email], (old = []) =>
        old.filter(r => r.event_id !== parseInt(eventId))
      );
      return { previousRsvps, eventId };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousRsvps) {
        queryClient.setQueryData(['user-rsvps', user?.email], context.previousRsvps);
      }
      showToast('Unable to cancel. Please try again.', 'error');
    },
    onSuccess: () => {
      showToast('RSVP cancelled', 'success');
    },
    onSettled: (_data, _error, variables) => {
      setLoadingRsvp(null);
      clearOptimisticAction(variables.eventId);
      queryClient.invalidateQueries({ queryKey: ['user-rsvps', user?.email] });
    }
  });

  useEffect(() => {
    const unsubscribe = bookingEvents.subscribe(() => {
      refetchRsvps();
    });
    return unsubscribe;
  }, [refetchRsvps]);

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
    if (event.externalLink) {
      window.open(event.externalLink, '_blank');
      return;
    }

    if (user?.email) {
      setLoadingRsvp(event.id);
      rsvpMutation.mutate({ eventId: event.id, userEmail: user.email });
    }
  };

  const cancelRSVP = async (event: EventData) => {
    if (user?.email) {
      setLoadingRsvp(event.id);
      cancelRsvpMutation.mutate({ eventId: event.id, userEmail: user.email });
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
    const timeStr = (event.time || '12:00 PM').trim();
    
    const match12Hour = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    const match24Hour = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    
    let hours: number;
    let minutes: number;
    
    if (match12Hour) {
      hours = parseInt(match12Hour[1]);
      minutes = match12Hour[2] ? parseInt(match12Hour[2]) : 0;
      const period = match12Hour[3].toUpperCase();
      if (period === 'AM') {
        hours = hours === 12 ? 0 : hours;
      } else {
        hours = hours === 12 ? 12 : hours + 12;
      }
    } else if (match24Hour) {
      hours = parseInt(match24Hour[1]);
      minutes = parseInt(match24Hour[2]);
    } else {
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
    } catch (err: unknown) {
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

  return (
    <AnimatedPage>
    <SwipeablePage className="px-6 relative overflow-hidden">
      <section className="mb-4 pt-4 md:pt-2 animate-content-enter-delay-1">
        <p className={`text-sm font-medium ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Discover what's happening at the House.</p>
      </section>

      <section className={`mb-6 border-b -mx-6 px-6 animate-content-enter-delay-2 ${isDark ? 'border-white/25' : 'border-black/10'}`}>
        <div className="flex gap-6 overflow-x-auto pb-0 scrollbar-hide scroll-fade-right" role="tablist">
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

      <section key={filter} className="mb-6 animate-content-enter-delay-3">
        <div className={`transition-opacity duration-normal ${isLoading ? 'opacity-100' : 'opacity-0 hidden'}`}>
          <SkeletonList count={4} Component={EventCardSkeleton} isDark={isDark} className="space-y-4" />
        </div>
        <div className={`transition-opacity duration-normal ${isLoading ? 'opacity-0 hidden' : 'opacity-100'}`}>
          {filteredAndSortedEvents.length === 0 ? (
            <EmptyEvents />
          ) : (
            <MotionList ref={eventsParent} className="space-y-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4">
              {filteredAndSortedEvents.map((event, index) => {
                const isExpanded = expandedEventId === event.id;
                const isRsvpd = hasRsvp(event.id);
                const isLoadingThis = loadingRsvp === event.id;
                const optimisticAction = getOptimisticAction(event.id);
                const isPendingRsvp = optimisticAction === 'rsvp';
                const isPendingCancel = optimisticAction === 'cancel';
                const showOptimisticGoing = isRsvpd || isPendingRsvp;
                
                return (
                  <MotionListItem 
                    key={event.id}
                    index={index}
                    className={`rounded-xl overflow-hidden transition-all duration-fast glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}
                  >
                    <button 
                      onClick={() => handleCardClick(event.id)}
                      aria-expanded={isExpanded}
                      aria-label={`${event.title} on ${event.date} at ${event.time}. ${isExpanded ? 'Collapse' : 'Expand'} for details`}
                      className={`w-full p-4 cursor-pointer transition-all duration-fast text-left ${isExpanded ? '' : 'active:scale-[0.98]'}`}
                    >
                      <div className="flex gap-4 items-start">
                        <div className={`w-14 h-14 flex-shrink-0 rounded-xl flex items-center justify-center ${isDark ? 'bg-lavender/20' : 'bg-primary/10'}`}>
                          <span className={`material-symbols-outlined text-2xl ${isDark ? 'text-lavender' : 'text-primary'}`}>
                            {event.category === 'Golf' ? 'golf_course' : 
                             event.category === 'Wellness' ? 'spa' : 
                             event.category === 'Social' ? 'groups' : 
                             event.category === 'Tournaments' ? 'emoji_events' :
                             event.category === 'Dining' ? 'restaurant' : 'event'}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${isDark ? 'bg-lavender/20 text-lavender' : 'bg-brand-green/20 text-brand-green'}`}>{event.category}</span>
                            {event.source === 'eventbrite' && (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-[#F05537]/20 text-[#F05537]">Eventbrite</span>
                            )}
                            {isPendingRsvp ? (
                              <span className="text-[10px] font-bold uppercase tracking-wider bg-accent/60 text-brand-green px-1.5 py-0.5 rounded-md whitespace-nowrap animate-pulse flex items-center gap-1">
                                <span className="w-1.5 h-1.5 bg-brand-green rounded-full animate-ping"></span>
                                RSVP'ing
                              </span>
                            ) : isPendingCancel ? (
                              <span className="text-[10px] font-bold uppercase tracking-wider bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-md whitespace-nowrap animate-pulse flex items-center gap-1">
                                <span className="w-1.5 h-1.5 bg-red-400 rounded-full animate-ping"></span>
                                Cancelling
                              </span>
                            ) : isRsvpd ? (
                              <span className="text-[10px] font-bold uppercase tracking-wider bg-accent text-brand-green px-1.5 py-0.5 rounded-md whitespace-nowrap transition-all duration-fast">Going</span>
                            ) : event.source === 'eventbrite' ? (
                              <span className="text-[10px] font-bold uppercase tracking-wider bg-[#F05537]/20 text-[#F05537] px-1.5 py-0.5 rounded-md whitespace-nowrap">Ticketed</span>
                            ) : (
                              <span className="text-[10px] font-bold uppercase tracking-wider bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded-md whitespace-nowrap">Open</span>
                            )}
                          </div>
                          <h3 className={`text-2xl md:text-3xl font-bold leading-none translate-y-[2px] ${isDark ? 'text-white' : 'text-primary'}`} style={{ fontFamily: 'var(--font-headline)', fontOpticalSizing: 'auto', letterSpacing: '-0.02em' }}>{event.title}</h3>
                        </div>
                        <div className="flex flex-col items-end flex-shrink-0">
                          <span className={`text-sm md:text-base font-bold ${isDark ? 'text-accent' : 'text-primary'}`}>{event.date}</span>
                          <span className={`text-lg md:text-xl font-bold ${isDark ? 'text-white' : 'text-primary'}`}>{parseEventTime(event.time).time}</span>
                          <span className={`text-xs md:text-sm font-medium ${isDark ? 'text-white/70' : 'text-primary/70'}`}>{parseEventTime(event.time).period}</span>
                        </div>
                      </div>
                    </button>

                    <div className={`accordion-content ${isExpanded ? 'is-open' : ''}`}>
                      <div className="accordion-inner">
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
                            className={`tactile-btn flex-1 py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-black/5 text-primary hover:bg-black/10'}`}
                          >
                            <span className="material-symbols-outlined text-lg">calendar_add_on</span>
                            Add to Cal
                          </button>
                          
                          {event.externalLink && event.source !== 'eventbrite' ? (
                            <a 
                              href={event.externalLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className={`tactile-btn flex-1 py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${isDark ? 'bg-white text-brand-green hover:bg-white/90' : 'bg-brand-green text-white hover:opacity-90'}`}
                            >
                              <span>Learn More</span>
                              <span className="material-symbols-outlined text-sm">open_in_new</span>
                            </a>
                          ) : user?.status && user.status.toLowerCase() !== 'active' ? (
                            <div className={`flex-1 py-3 rounded-xl flex items-center justify-center ${isDark ? 'bg-white/10' : 'bg-bone'}`}>
                              <span className={`text-xs font-medium ${isDark ? 'text-white/60' : 'text-primary/60'}`}>Members Only Event</span>
                            </div>
                          ) : isPendingRsvp ? (
                            <button 
                              disabled
                              className="flex-1 py-3 rounded-xl font-semibold text-sm bg-brand-green/70 text-white cursor-not-allowed flex items-center justify-center gap-2"
                            >
                              <WalkingGolferSpinner size="sm" variant="light" />
                              <span>RSVP'ing...</span>
                            </button>
                          ) : isPendingCancel ? (
                            <button 
                              disabled
                              className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-colors border flex items-center justify-center gap-2 cursor-not-allowed opacity-70 ${isDark ? 'border-red-500/50 text-red-400' : 'border-red-500/50 text-red-500'}`}
                            >
                              <WalkingGolferSpinner size="sm" variant={isDark ? 'light' : 'dark'} />
                              <span>Cancelling...</span>
                            </button>
                          ) : isRsvpd ? (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleCancelRSVP(event); }}
                              disabled={isLoadingThis}
                              className={`tactile-btn flex-1 py-3 rounded-xl font-semibold text-sm transition-colors border flex items-center justify-center gap-2 ${isDark ? 'border-red-500/50 text-red-400 hover:bg-red-500/10' : 'border-red-500/50 text-red-500 hover:bg-red-500/10'} ${isLoadingThis ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                              {isLoadingThis ? <WalkingGolferSpinner size="sm" variant={isDark ? 'light' : 'dark'} /> : 'Cancel RSVP'}
                            </button>
                          ) : event.source === 'eventbrite' ? (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleRSVP(event); }}
                              className="tactile-btn flex-1 py-3 rounded-xl font-semibold text-sm bg-[#F05537] text-white hover:bg-[#d94829] transition-colors"
                            >
                              Get Tickets
                            </button>
                          ) : (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleRSVP(event); }}
                              disabled={isLoadingThis}
                              className={`tactile-btn flex-1 py-3 rounded-xl font-semibold text-sm bg-brand-green text-white hover:opacity-90 transition-opacity flex items-center justify-center gap-2 ${isLoadingThis ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                              {isLoadingThis ? <WalkingGolferSpinner size="sm" variant="light" /> : 'RSVP'}
                            </button>
                          )}
                        </div>
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
    </AnimatedPage>
  );
};

export default MemberEvents;
