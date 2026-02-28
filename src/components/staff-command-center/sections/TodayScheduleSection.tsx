import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import EmptyState from '../../EmptyState';
import { formatTime12Hour } from '../../../utils/dateUtils';
import { DateBlock, GlassListRow, getWellnessIcon, getEventIcon, formatTimeLeft } from '../helpers';
import type { Tour, DBEvent, WellnessClass, TabType, NextScheduleItem, NextActivityItem } from '../types';
import { tabToPath } from '../../../pages/Admin/layout/types';

interface NextTourWidgetProps {
  nextTour: Tour | null;
  isDesktop: boolean;
  onNavigate: () => void;
}

const NextTourWidget: React.FC<NextTourWidgetProps> = ({ nextTour, isDesktop, onNavigate }) => {
  const hasTour = !!nextTour;

  const getTimeLeft = () => {
    if (nextTour) return formatTimeLeft(nextTour.tourDate, nextTour.startTime);
    return 'No upcoming';
  };

  const getDateDisplay = () => {
    if (nextTour) {
      const dateStr = new Date(nextTour.tourDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
      return nextTour.startTime ? `${dateStr} at ${formatTime12Hour(nextTour.startTime)}` : dateStr;
    }
    return '';
  };

  return (
    <button 
      onClick={onNavigate}
      className={`${isDesktop ? 'h-full' : ''} bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl ${isDesktop ? 'p-4' : 'p-3'} text-left hover:bg-white/80 dark:hover:bg-white/10 transition-colors shadow-liquid dark:shadow-liquid-dark ${isDesktop ? 'flex flex-col' : ''}`}
    >
      <h3 className={`font-bold text-primary dark:text-white ${isDesktop ? 'mb-3' : 'text-sm mb-2'}`} style={{ fontFamily: 'var(--font-headline)' }}>Next Tour</h3>
      <div className={`${hasTour ? 'bg-primary/5 dark:bg-white/10' : ''} rounded-lg ${hasTour ? (isDesktop ? 'p-3' : 'p-2') : ''} ${isDesktop ? 'flex-1 flex flex-col justify-center' : ''}`}>
        <p className={`font-bold text-primary dark:text-white ${hasTour ? (isDesktop ? 'text-2xl' : 'text-xl') : (isDesktop ? 'text-base' : 'text-sm')}`}>
          {getTimeLeft()}
        </p>
        {hasTour && (
          <p className={`${isDesktop ? 'text-xs mt-1' : 'text-[10px] mt-0.5 truncate'} text-primary/80 dark:text-white/80`}>
            {getDateDisplay()}
          </p>
        )}
      </div>
    </button>
  );
};

interface NextEventWidgetProps {
  nextActivityItem: NextActivityItem | null;
  nextEvent: DBEvent | WellnessClass | null;
  isDesktop: boolean;
  onNavigate: (target: 'events' | 'wellness') => void;
}

const NextEventWidget: React.FC<NextEventWidgetProps> = ({ nextActivityItem, nextEvent, isDesktop, onNavigate }) => {
  const isEvent = nextActivityItem?.type === 'event';
  const isWellness = nextActivityItem?.type === 'wellness';
  const event = nextActivityItem?.event;
  const wellness = nextActivityItem?.wellness;
  
  const useFallbackEvent = nextEvent && !nextActivityItem && 'event_date' in nextEvent;
  const useFallbackWellness = nextEvent && !nextActivityItem && 'date' in nextEvent;
  const fallbackEvent = useFallbackEvent ? nextEvent as DBEvent : null;
  const fallbackWellness = useFallbackWellness ? nextEvent as WellnessClass : null;
  
  const hasItem = isEvent || isWellness || !!nextEvent;

  const normalizeDateStr = (d: string | Date | undefined): string => {
    if (!d) return '';
    if (typeof d === 'string') return d.split('T')[0];
    return new Date(d).toISOString().split('T')[0];
  };

  const getTitle = () => {
    if (isEvent || useFallbackEvent) return 'Next Event';
    if (isWellness || useFallbackWellness) return 'Next Wellness';
    return 'Next Event';
  };

  const getTimeLeft = () => {
    if (isEvent && event) return formatTimeLeft(normalizeDateStr(event.event_date), event.start_time || '00:00');
    if (isWellness && wellness) return formatTimeLeft(normalizeDateStr(wellness.date), wellness.time);
    if (useFallbackEvent && fallbackEvent) return formatTimeLeft(normalizeDateStr(fallbackEvent.event_date), fallbackEvent.start_time || '00:00');
    if (useFallbackWellness && fallbackWellness) return formatTimeLeft(normalizeDateStr(fallbackWellness.date), fallbackWellness.time);
    return 'No upcoming';
  };

  const getDateDisplay = () => {
    if (isEvent && event) {
      const normalized = normalizeDateStr(event.event_date);
      const dateStr = new Date(normalized + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
      return event.start_time ? `${dateStr} at ${formatTime12Hour(event.start_time)}` : dateStr;
    }
    if (isWellness && wellness) {
      const normalized = normalizeDateStr(wellness.date);
      const dateStr = new Date(normalized + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
      return wellness.time ? `${dateStr} at ${formatTime12Hour(wellness.time)}` : dateStr;
    }
    if (useFallbackEvent && fallbackEvent) {
      const normalized = normalizeDateStr(fallbackEvent.event_date);
      const dateStr = new Date(normalized + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
      return fallbackEvent.start_time ? `${dateStr} at ${formatTime12Hour(fallbackEvent.start_time)}` : dateStr;
    }
    if (useFallbackWellness && fallbackWellness) {
      const normalized = normalizeDateStr(fallbackWellness.date);
      const dateStr = new Date(normalized + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
      return fallbackWellness.time ? `${dateStr} at ${formatTime12Hour(fallbackWellness.time)}` : dateStr;
    }
    return '';
  };

  const handleClick = () => {
    if (isWellness || useFallbackWellness) {
      onNavigate('wellness');
    } else {
      onNavigate('events');
    }
  };

  return (
    <button 
      onClick={handleClick}
      className={`${isDesktop ? 'h-full' : ''} bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl ${isDesktop ? 'p-4' : 'p-3'} text-left hover:bg-white/80 dark:hover:bg-white/10 transition-colors shadow-liquid dark:shadow-liquid-dark ${isDesktop ? 'flex flex-col' : ''}`}
    >
      <h3 className={`font-bold text-primary dark:text-white ${isDesktop ? 'mb-3' : 'text-sm mb-2'}`} style={{ fontFamily: 'var(--font-headline)' }}>{getTitle()}</h3>
      <div className={`${hasItem ? 'bg-primary/5 dark:bg-white/10' : ''} rounded-lg ${hasItem ? (isDesktop ? 'p-3' : 'p-2') : ''} ${isDesktop ? 'flex-1 flex flex-col justify-center' : ''}`}>
        <p className={`font-bold text-primary dark:text-white ${hasItem ? (isDesktop ? 'text-2xl' : 'text-xl') : (isDesktop ? 'text-base' : 'text-sm')}`}>
          {getTimeLeft()}
        </p>
        {hasItem && (
          <p className={`${isDesktop ? 'text-xs mt-1' : 'text-[10px] mt-0.5 truncate'} text-primary/80 dark:text-white/80`}>
            {getDateDisplay()}
          </p>
        )}
      </div>
    </button>
  );
};

interface WellnessCardProps {
  isDesktopGrid: boolean;
  isDesktop: boolean;
  upcomingWellness: WellnessClass[];
  today: string;
  onNavigateToWellness: () => void;
}

const WellnessCard: React.FC<WellnessCardProps> = ({ isDesktopGrid, isDesktop, upcomingWellness, today, onNavigateToWellness }) => (
  <div className={`${isDesktopGrid ? 'h-full min-h-[280px]' : 'min-h-[200px]'} flex flex-col bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl pt-4 shadow-liquid dark:shadow-liquid-dark overflow-hidden`}>
    <div className="flex items-center justify-between mb-3 lg:mb-4 flex-shrink-0 px-4">
      <h3 className="font-bold text-primary dark:text-white" style={{ fontFamily: 'var(--font-headline)' }}>Upcoming Wellness</h3>
      <button onClick={onNavigateToWellness} className="text-xs text-primary/80 dark:text-white/80 hover:underline">View all</button>
    </div>
    {upcomingWellness.length === 0 ? (
      <div className="flex-1 flex flex-col items-center justify-center py-8 px-4">
        <EmptyState icon="self_improvement" title="No classes scheduled" description={isDesktop ? "Wellness classes will appear here" : undefined} variant="compact" />
      </div>
    ) : (
      <div className={`${isDesktop ? 'flex-1 overflow-y-auto pb-6' : ''}`}>
        {upcomingWellness.slice(0, isDesktop ? 5 : 3).map((wellness, index) => {
          const dateStr = typeof wellness.date === 'string' ? wellness.date.split('T')[0] : new Date(wellness.date).toISOString().split('T')[0];
          return (
            <GlassListRow key={wellness.id} onClick={onNavigateToWellness} className="animate-slide-up-stagger tactile-row" style={{ '--stagger-index': index } as React.CSSProperties}>
              <DateBlock dateStr={dateStr} today={today} />
              <span className="material-symbols-outlined text-lg text-primary dark:text-[#CCB8E4]">{getWellnessIcon(wellness.title)}</span>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-primary dark:text-white truncate">{wellness.title}</p>
                <p className="text-xs text-primary/80 dark:text-white/80">
                  {formatTime12Hour(wellness.time)} - {formatTime12Hour(wellness.end_time)}
                </p>
              </div>
              <span className="material-symbols-outlined text-base text-primary/70 dark:text-white/70 flex-shrink-0">chevron_right</span>
            </GlassListRow>
          );
        })}
      </div>
    )}
  </div>
);

interface EventsCardProps {
  isDesktopGrid: boolean;
  isDesktop: boolean;
  upcomingEvents: DBEvent[];
  today: string;
  onNavigateToEvents: () => void;
}

const EventsCard: React.FC<EventsCardProps> = ({ isDesktopGrid, isDesktop, upcomingEvents, today, onNavigateToEvents }) => (
  <div className={`${isDesktopGrid ? 'h-full min-h-[280px]' : 'min-h-[200px]'} flex flex-col bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl pt-4 shadow-liquid dark:shadow-liquid-dark overflow-hidden`}>
    <div className="flex items-center justify-between mb-3 lg:mb-4 flex-shrink-0 px-4">
      <h3 className="font-bold text-primary dark:text-white" style={{ fontFamily: 'var(--font-headline)' }}>Upcoming Events</h3>
      <button onClick={onNavigateToEvents} className="text-xs text-primary/80 dark:text-white/80 hover:underline">View all</button>
    </div>
    {upcomingEvents.length === 0 ? (
      <div className="flex-1 flex flex-col items-center justify-center py-8 px-4">
        <EmptyState icon="celebration" title="No events scheduled" description={isDesktop ? "Events will appear here" : undefined} variant="compact" />
      </div>
    ) : (
      <div className={`${isDesktop ? 'flex-1 overflow-y-auto pb-6' : ''}`}>
        {upcomingEvents.slice(0, isDesktop ? 5 : 3).map((event, index) => {
          const dateStr = event.event_date;
          const hasStartTime = event.start_time && event.start_time !== '00:00';
          const hasEndTime = event.end_time && event.end_time !== '00:00';
          const timeDisplay = hasStartTime && hasEndTime 
            ? `${formatTime12Hour(event.start_time)} - ${formatTime12Hour(event.end_time)}`
            : hasStartTime 
              ? formatTime12Hour(event.start_time)
              : 'All Day';
          return (
            <GlassListRow key={event.id} onClick={onNavigateToEvents} className="animate-slide-up-stagger tactile-row" style={{ '--stagger-index': index } as React.CSSProperties}>
              <DateBlock dateStr={dateStr} today={today} />
              <span className="material-symbols-outlined text-lg text-primary dark:text-[#CCB8E4]">{getEventIcon(event.category || '')}</span>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-primary dark:text-white truncate">{event.title}</p>
                <p className="text-xs text-primary/80 dark:text-white/80">{timeDisplay}</p>
              </div>
              <span className="material-symbols-outlined text-base text-primary/70 dark:text-white/70 flex-shrink-0">chevron_right</span>
            </GlassListRow>
          );
        })}
      </div>
    )}
  </div>
);

interface TodayScheduleSectionProps {
  upcomingTours: Tour[];
  upcomingEvents: DBEvent[];
  upcomingWellness: WellnessClass[];
  nextTour: Tour | null;
  nextEvent: DBEvent | WellnessClass | null;
  nextScheduleItem: NextScheduleItem | null;
  nextActivityItem: NextActivityItem | null;
  today: string;
  variant: 'desktop' | 'desktop-top' | 'desktop-cards' | 'desktop-wellness' | 'desktop-events' | 'mobile' | 'mobile-top' | 'mobile-cards';
}

export const TodayScheduleSection: React.FC<TodayScheduleSectionProps> = ({
  upcomingTours,
  upcomingEvents,
  upcomingWellness,
  nextTour,
  nextEvent,
  nextScheduleItem,
  nextActivityItem,
  today,
  variant
}) => {
  const navigate = useNavigate();
  const navigateToTab = useCallback((tab: TabType) => {
    if (tabToPath[tab]) navigate(tabToPath[tab]);
  }, [navigate]);
  const isDesktop = variant.startsWith('desktop');
  const isDesktopGrid = variant === 'desktop-wellness' || variant === 'desktop-events';
  
  const navigateToWellnessTab = useCallback(() => {
    navigate('/admin/calendar?subtab=wellness');
  }, [navigate]);

  const handleNavigateToTours = useCallback(() => {
    navigateToTab('tours');
  }, [navigateToTab]);

  const handleNavigateToEvents = useCallback(() => {
    navigateToTab('events');
  }, [navigateToTab]);

  const handleEventWidgetNavigate = useCallback((target: 'events' | 'wellness') => {
    if (target === 'wellness') {
      navigateToWellnessTab();
    } else {
      navigateToTab('events');
    }
  }, [navigateToTab, navigateToWellnessTab]);

  if (variant === 'mobile-top') {
    return (
      <div className="grid grid-cols-2 gap-3">
        <NextTourWidget nextTour={nextTour} isDesktop={isDesktop} onNavigate={handleNavigateToTours} />
        <NextEventWidget nextActivityItem={nextActivityItem} nextEvent={nextEvent} isDesktop={isDesktop} onNavigate={handleEventWidgetNavigate} />
      </div>
    );
  }

  if (variant === 'mobile-cards') {
    return (
      <>
        <EventsCard isDesktopGrid={isDesktopGrid} isDesktop={isDesktop} upcomingEvents={upcomingEvents} today={today} onNavigateToEvents={handleNavigateToEvents} />
        <WellnessCard isDesktopGrid={isDesktopGrid} isDesktop={isDesktop} upcomingWellness={upcomingWellness} today={today} onNavigateToWellness={navigateToWellnessTab} />
      </>
    );
  }

  if (variant === 'mobile') {
    return (
      <>
        <div className="grid grid-cols-2 gap-3">
          <NextTourWidget nextTour={nextTour} isDesktop={isDesktop} onNavigate={handleNavigateToTours} />
          <NextEventWidget nextActivityItem={nextActivityItem} nextEvent={nextEvent} isDesktop={isDesktop} onNavigate={handleEventWidgetNavigate} />
        </div>
        <EventsCard isDesktopGrid={isDesktopGrid} isDesktop={isDesktop} upcomingEvents={upcomingEvents} today={today} onNavigateToEvents={handleNavigateToEvents} />
        <WellnessCard isDesktopGrid={isDesktopGrid} isDesktop={isDesktop} upcomingWellness={upcomingWellness} today={today} onNavigateToWellness={navigateToWellnessTab} />
      </>
    );
  }

  if (variant === 'desktop-top') {
    return (
      <>
        <NextTourWidget nextTour={nextTour} isDesktop={isDesktop} onNavigate={handleNavigateToTours} />
        <NextEventWidget nextActivityItem={nextActivityItem} nextEvent={nextEvent} isDesktop={isDesktop} onNavigate={handleEventWidgetNavigate} />
      </>
    );
  }

  if (variant === 'desktop-wellness') {
    return <WellnessCard isDesktopGrid={isDesktopGrid} isDesktop={isDesktop} upcomingWellness={upcomingWellness} today={today} onNavigateToWellness={navigateToWellnessTab} />;
  }

  if (variant === 'desktop-events') {
    return <EventsCard isDesktopGrid={isDesktopGrid} isDesktop={isDesktop} upcomingEvents={upcomingEvents} today={today} onNavigateToEvents={handleNavigateToEvents} />;
  }

  if (variant === 'desktop-cards') {
    return (
      <>
        <WellnessCard isDesktopGrid={isDesktopGrid} isDesktop={isDesktop} upcomingWellness={upcomingWellness} today={today} onNavigateToWellness={navigateToWellnessTab} />
        <EventsCard isDesktopGrid={isDesktopGrid} isDesktop={isDesktop} upcomingEvents={upcomingEvents} today={today} onNavigateToEvents={handleNavigateToEvents} />
      </>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-6">
        <NextTourWidget nextTour={nextTour} isDesktop={isDesktop} onNavigate={handleNavigateToTours} />
        <NextEventWidget nextActivityItem={nextActivityItem} nextEvent={nextEvent} isDesktop={isDesktop} onNavigate={handleEventWidgetNavigate} />
      </div>
      <div className="space-y-6">
        <WellnessCard isDesktopGrid={isDesktopGrid} isDesktop={isDesktop} upcomingWellness={upcomingWellness} today={today} onNavigateToWellness={navigateToWellnessTab} />
        <EventsCard isDesktopGrid={isDesktopGrid} isDesktop={isDesktop} upcomingEvents={upcomingEvents} today={today} onNavigateToEvents={handleNavigateToEvents} />
      </div>
    </>
  );
};
