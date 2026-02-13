import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import { BookingCardSkeleton, SkeletonList } from '../../components/skeletons';
import BackToTop from '../../components/BackToTop';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';
import { formatDateDisplayWithDay } from '../../utils/dateUtils';
import { AnimatedPage } from '../../components/motion';
import SEO from '../../components/SEO';

interface Event {
  id: number;
  title: string;
  description: string;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  location: string;
  category: string;
  image_url?: string;
  eventbrite_url?: string;
  external_url?: string;
  type: 'event';
}

interface WellnessClass {
  id: number;
  title: string;
  description: string | null;
  date: string;
  time: string;
  instructor: string;
  duration: string;
  category: string;
  spots: number;
  status: string;
  external_url?: string;
  type: 'wellness';
}

type ListItem = Event | WellnessClass;

const ITEMS_PER_PAGE = 10;

const WhatsOn: React.FC = () => {
  const navigate = useNavigate();
  const { startNavigation } = useNavigationLoading();
  const { setPageReady } = usePageReady();
  const [events, setEvents] = useState<Event[]>([]);
  const [wellnessClasses, setWellnessClasses] = useState<WellnessClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'events' | 'wellness'>('all');
  const [displayCount, setDisplayCount] = useState(ITEMS_PER_PAGE);

  useEffect(() => {
    if (!loading) {
      setPageReady(true);
    }
  }, [loading, setPageReady]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [eventsRes, wellnessRes] = await Promise.all([
          fetch('/api/events?visibility=public'),
          fetch('/api/wellness-classes?active_only=true')
        ]);
        
        if (eventsRes.ok) {
          const data = await eventsRes.json();
          setEvents(data.map((e: any) => ({ ...e, type: 'event' })));
        }
        if (wellnessRes.ok) {
          const data = await wellnessRes.json();
          setWellnessClasses(data.map((w: any) => ({ ...w, type: 'wellness' })));
        }
      } catch (error) {
        console.error('Failed to fetch data:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const combinedItems = useMemo(() => {
    let items: ListItem[] = [];
    
    if (filter === 'all' || filter === 'events') {
      items = [...items, ...events];
    }
    if (filter === 'all' || filter === 'wellness') {
      items = [...items, ...wellnessClasses];
    }
    
    return items.sort((a, b) => {
      const dateA = a.type === 'event' ? a.event_date : a.date;
      const dateB = b.type === 'event' ? b.event_date : b.date;
      const cleanA = dateA?.includes('T') ? dateA.split('T')[0] : dateA || '';
      const cleanB = dateB?.includes('T') ? dateB.split('T')[0] : dateB || '';
      return cleanA.localeCompare(cleanB);
    });
  }, [events, wellnessClasses, filter]);

  const formatDate = (dateString: string) => {
    if (!dateString) return { day: '--', month: '---', weekday: '---', full: 'No Date' };
    const datePart = dateString.includes('T') ? dateString.split('T')[0] : dateString;
    const [year, month, day] = datePart.split('-').map(Number);
    if (!year || !month || !day) return { day: '--', month: '---', weekday: '---', full: 'Invalid Date' };
    const shortMonths = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return {
      day: day.toString().padStart(2, '0'),
      month: shortMonths[month - 1],
      weekday: formatDateDisplayWithDay(datePart).split(',')[0],
      full: formatDateDisplayWithDay(datePart)
    };
  };

  const formatTime = (timeString: string | null | undefined) => {
    if (!timeString) return 'TBD';
    const [hours, minutes] = timeString.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    return `${hour12}:${minutes} ${ampm}`;
  };

  const getItemId = (item: ListItem) => `${item.type}-${item.id}`;

  useEffect(() => {
    setDisplayCount(ITEMS_PER_PAGE);
  }, [filter]);

  const displayedItems = useMemo(() => {
    return combinedItems.slice(0, displayCount);
  }, [combinedItems, displayCount]);

  const hasMore = displayCount < combinedItems.length;

  const loadMore = () => {
    setDisplayCount(prev => prev + ITEMS_PER_PAGE);
  };

  return (
    <AnimatedPage>
      <SEO
        title="Events & Happenings in Orange County | Ever Members Club"
        description="Discover golf tournaments, social nights, wellness classes & curated events at Ever Members Club in Tustin, Orange County. See what's on and RSVP."
        url="/whats-on"
        image="/images/events-crowd-optimized.webp"
      />
    <div 
      className="flex flex-col min-h-screen bg-[#EAEBE6] dark:bg-[#0f120a] overflow-x-hidden"
      style={{ marginTop: 'calc(-1 * var(--header-offset))', paddingTop: 'var(--header-offset)' }}
    >
      <section className="px-6 pt-4 md:pt-2 pb-6 bg-[#EAEBE6] dark:bg-[#0f120a] animate-content-enter">
        <h1 className="text-5xl font-light text-primary dark:text-white mb-4 tracking-tight">What's On</h1>
        <p className="text-primary/70 dark:text-white/70 text-base leading-relaxed max-w-[90%]">
           Curated experiences at Ever Club. Join us for culture, conversation, and community in Tustin.
        </p>
      </section>

      <div className="flex gap-2 px-6 pb-4 animate-content-enter-delay-1">
        {(['all', 'events', 'wellness'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 min-h-[44px] rounded-full text-sm font-bold whitespace-nowrap transition-all flex-shrink-0 ${
              filter === f
                ? 'bg-primary text-white'
                : 'bg-white dark:bg-white/5 text-primary dark:text-white hover:bg-primary/10 dark:hover:bg-white/10'
            }`}
          >
            {f === 'all' ? 'All' : f === 'events' ? 'Events' : 'Wellness'}
          </button>
        ))}
      </div>

      <div className="px-4 space-y-3 pb-12 flex-1 animate-content-enter-delay-2">
        {loading ? (
          <SkeletonList count={5} Component={BookingCardSkeleton} />
        ) : combinedItems.length === 0 ? (
          <div className="text-center py-20">
            <span className="material-symbols-outlined text-5xl text-primary/30 dark:text-white/30 mb-4">calendar_month</span>
            <p className="text-primary/60 dark:text-white/60">No upcoming {filter === 'all' ? 'events or classes' : filter} scheduled.</p>
            <p className="text-primary/40 dark:text-white/40 text-sm mt-2">Check back soon for new experiences.</p>
          </div>
        ) : (
          <>
          {displayedItems.map((item, index) => {
            const isEvent = item.type === 'event';
            const dateStr = isEvent ? item.event_date : item.date;
            const date = formatDate(dateStr);
            const itemId = getItemId(item);
            const isExpanded = expandedId === itemId;

            return (
              <div 
                key={itemId} 
                className={`bg-white dark:bg-[#1a1d15] rounded-2xl overflow-hidden shadow-layered dark:shadow-black/20 transition-all animate-list-item-delay-${Math.min(index, 10)}`}
              >
                <div 
                  onClick={() => setExpandedId(isExpanded ? null : itemId)}
                  className={`flex gap-4 p-4 cursor-pointer transition-all ${isExpanded ? '' : 'active:scale-[0.98]'}`}
                >
                  <div className="w-14 h-14 flex-shrink-0 flex flex-col items-center justify-center rounded-xl bg-[#EAEBE6] dark:bg-white/5 text-primary dark:text-white">
                    <span className="text-[10px] font-bold uppercase tracking-wider opacity-60">{date.month}</span>
                    <span className="text-2xl font-light leading-none">{date.day}</span>
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-base text-primary dark:text-white leading-tight truncate">{item.title}</h3>
                        <p className="text-xs text-primary/60 dark:text-white/60 mt-0.5">
                          {isEvent 
                            ? `${formatTime(item.start_time)} • ${item.location}`
                            : `${formatTime(item.time)} • ${item.duration} • ${item.instructor}`
                          }
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase ${
                          isEvent ? 'bg-accent text-primary' : 'bg-primary text-white'
                        }`}>
                          {isEvent ? 'Event' : 'Wellness'}
                        </span>
                        {isEvent && item.eventbrite_url && (
                          <span className="px-1.5 py-0.5 rounded bg-[#F05537] text-white text-[8px] font-bold uppercase">Tickets</span>
                        )}
                        <span className={`material-symbols-outlined text-[20px] text-primary/40 dark:text-white/40 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}>
                          expand_more
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className={`accordion-content ${isExpanded ? 'expanded' : ''}`}>
                  <div className="px-4 pb-4 pt-0">
                    {isEvent && item.image_url && (
                      <div className="rounded-xl overflow-hidden mb-3">
                        <img src={item.image_url} className="w-full h-40 object-cover" alt={item.title} />
                      </div>
                    )}
                    
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-2 py-0.5 rounded bg-[#E2DCE6] dark:bg-white/10 text-primary dark:text-white text-[10px] font-bold uppercase tracking-wider">{item.category}</span>
                      {isEvent && item.end_time && (
                        <span className="text-xs text-primary/50 dark:text-white/50">{formatTime(item.start_time)} - {formatTime(item.end_time)}</span>
                      )}
                      {!isEvent && (
                        <span className="text-xs text-primary/50 dark:text-white/50">{item.spots} spots available</span>
                      )}
                    </div>
                    
                    <p className="text-sm text-primary/70 dark:text-white/70 leading-relaxed mb-4">
                      {isEvent ? item.description : (item.description || `Join ${item.instructor} for this ${item.duration} ${item.category.toLowerCase()} session.`)}
                    </p>
                    
                    {isEvent ? (
                      item.eventbrite_url ? (
                        <a 
                          href={item.eventbrite_url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="w-full bg-[#F05537] hover:bg-[#d94a2f] text-white py-3 rounded-xl flex items-center justify-center gap-2 font-bold text-sm transition-colors"
                        >
                          <span>Get Tickets</span>
                          <span className="material-symbols-outlined text-sm">open_in_new</span>
                        </a>
                      ) : item.external_url ? (
                        <a 
                          href={item.external_url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="w-full bg-primary hover:bg-[#1e2810] text-white py-3 rounded-xl flex items-center justify-center gap-2 font-bold text-sm transition-colors"
                        >
                          <span>Learn More</span>
                          <span className="material-symbols-outlined text-sm">open_in_new</span>
                        </a>
                      ) : (
                        <div className="w-full bg-bone dark:bg-white/5 py-3 rounded-xl flex items-center justify-center px-4">
                          <span className="text-xs font-medium text-primary/60 dark:text-white/60">Members Only Event</span>
                        </div>
                      )
                    ) : (
                      (item as WellnessClass).external_url ? (
                        <a 
                          href={(item as WellnessClass).external_url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="w-full bg-primary hover:bg-[#1e2810] text-white py-3 rounded-xl flex items-center justify-center gap-2 font-bold text-sm transition-colors"
                        >
                          <span>Learn More</span>
                          <span className="material-symbols-outlined text-sm">open_in_new</span>
                        </a>
                      ) : (
                        <div className="w-full bg-bone dark:bg-white/5 py-3 rounded-xl flex items-center justify-center px-4">
                          <span className="text-xs font-medium text-primary/60 dark:text-white/60">Members Only Wellness</span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          
          {hasMore && (
            <button
              onClick={loadMore}
              className="w-full bg-white dark:bg-[#1a1d15] hover:bg-bone dark:hover:bg-white/5 text-primary dark:text-white py-4 rounded-2xl flex items-center justify-center gap-2 font-bold text-sm transition-colors shadow-layered dark:shadow-black/20 mt-4"
            >
              <span>Load More</span>
              <span className="text-xs text-primary/50 dark:text-white/50">({combinedItems.length - displayCount} remaining)</span>
            </button>
          )}
          </>
        )}
      </div>

      <section className="px-4 py-8 mb-4">
        <div className="bg-primary rounded-2xl p-6 text-center">
          <h3 className="text-xl font-bold text-white mb-2">Want full access?</h3>
          <p className="text-white/70 text-sm mb-4">Join Ever Club and unlock exclusive member-only events and wellness classes.</p>
          <button 
            onClick={() => { startNavigation(); navigate('/membership'); }}
            className="bg-bone dark:bg-white text-primary px-6 py-3 rounded-xl font-bold text-sm hover:bg-white transition-colors"
          >
            Explore Membership
          </button>
        </div>
      </section>

      <section className="px-6 py-10 text-center">
        <p className="text-primary/60 dark:text-white/60 text-sm mb-4">Want to attend? Membership gives you access to all events and classes.</p>
        <Link to="/tour" className="inline-block px-8 py-4 bg-primary text-white rounded-2xl font-bold text-sm tracking-widest uppercase hover:bg-primary/90 transition-all duration-300 active:scale-[0.98] shadow-[0_4px_16px_rgba(41,53,21,0.3)]">
          Book a Tour
        </Link>
      </section>

      <Footer />

      <BackToTop threshold={200} />
    </div>
    </AnimatedPage>
  );
};

export default WhatsOn;
