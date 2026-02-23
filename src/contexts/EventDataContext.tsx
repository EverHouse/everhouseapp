import React, { createContext, useState, useContext, ReactNode, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuthData } from './AuthDataContext';
import { formatDateShort, formatTime12Hour } from '../utils/dateUtils';
import type { EventData } from '../types/data';

interface DBEventRecord {
  id: number | string;
  source?: string;
  eventbrite_url?: string;
  external_url?: string;
  title: string;
  category?: string;
  event_date: string;
  start_time?: string;
  location?: string;
  image_url?: string;
  description?: string;
  max_attendees?: number;
}

interface EventDataContextType {
  events: EventData[];
  eventsLoaded: boolean;
  addEvent: (event: Partial<EventData>) => Promise<void>;
  updateEvent: (event: EventData) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  syncEventbrite: () => Promise<void>;
}

const EventDataContext = createContext<EventDataContextType | undefined>(undefined);

const normalizeCategory = (cat: string | null | undefined): string => {
  if (!cat) return 'Social';
  const lower = cat.toLowerCase();
  const categoryMap: Record<string, string> = {
    'wellness': 'Wellness',
    'social': 'Social',
    'dining': 'Dining',
    'sport': 'Sport',
    'sports': 'Sport',
  };
  return categoryMap[lower] || cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
};

const formatEventData = (data: DBEventRecord[]) => data.map((event: DBEventRecord) => ({
  id: event.id.toString(),
  source: event.source === 'eventbrite' ? 'eventbrite' : 'internal',
  externalLink: event.eventbrite_url || event.external_url || undefined,
  title: event.title,
  category: normalizeCategory(event.category),
  date: formatDateShort(event.event_date),
  time: event.start_time ? formatTime12Hour(event.start_time) : 'TBD',
  location: event.location || 'Ever Club',
  image: event.image_url || 'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?q=80&w=1000&auto=format&fit=crop',
  description: event.description || '',
  attendees: [],
  capacity: event.max_attendees || undefined,
  ticketsSold: undefined
})) as EventData[];

export const EventDataProvider: React.FC<{children: ReactNode}> = ({ children }) => {
  const { sessionChecked, actualUser } = useAuthData();
  const actualUserRef = useRef(actualUser);
  useEffect(() => { actualUserRef.current = actualUser; }, [actualUser]);

  const [events, setEvents] = useState<EventData[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const eventsFetchedRef = useRef(false);

  useEffect(() => {
    if (!sessionChecked || eventsFetchedRef.current) return;
    eventsFetchedRef.current = true;
    const fetchEvents = async () => {
      try {
        const res = await fetch('/api/events');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setEvents(data.length ? formatEventData(data) : []);
          }
        }
      } catch (err: unknown) {
        if (actualUserRef.current) {
          console.error('Failed to fetch events:', err);
        }
      } finally {
        setEventsLoaded(true);
      }
    };
    fetchEvents();
  }, [sessionChecked]);

  const refreshEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/events');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setEvents(data.length ? formatEventData(data) : []);
        }
      }
    } catch (err: unknown) {
      console.error('Failed to refresh events:', err);
    }
  }, []);

  useEffect(() => {
    const handleAppRefresh = () => { refreshEvents(); };
    window.addEventListener('app-refresh', handleAppRefresh);
    return () => window.removeEventListener('app-refresh', handleAppRefresh);
  }, [refreshEvents]);

  const addEvent = useCallback(async (item: Partial<EventData>) => {
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: item.title,
          description: item.description,
          event_date: item.date,
          start_time: item.time,
          location: item.location,
          category: item.category,
          image_url: item.image,
          max_attendees: item.capacity
        })
      });
      if (res.ok) {
        const data = await res.json();
        const formatted = {
          id: data.id.toString(),
          source: data.source === 'eventbrite' ? 'eventbrite' : 'internal',
          externalLink: data.eventbrite_url || undefined,
          title: data.title,
          category: data.category || 'Social',
          date: formatDateShort(data.event_date),
          time: data.start_time || 'TBD',
          location: data.location || 'Ever Club',
          image: data.image_url || 'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?q=80&w=1000&auto=format&fit=crop',
          description: data.description || '',
          attendees: [],
          capacity: data.max_attendees || undefined,
          ticketsSold: undefined
        } as EventData;
        setEvents(prev => [...prev, formatted]);
      }
    } catch (err: unknown) {
      console.error('Failed to add event:', err);
    }
  }, []);

  const updateEvent = useCallback(async (item: EventData) => {
    try {
      const res = await fetch(`/api/events/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: item.title,
          description: item.description,
          event_date: item.date,
          start_time: item.time,
          location: item.location,
          category: item.category,
          image_url: item.image,
          max_attendees: item.capacity
        })
      });
      if (res.ok) {
        const data = await res.json();
        const formatted = {
          id: data.id.toString(),
          source: data.source === 'eventbrite' ? 'eventbrite' : 'internal',
          externalLink: data.eventbrite_url || undefined,
          title: data.title,
          category: data.category || 'Social',
          date: formatDateShort(data.event_date),
          time: data.start_time || 'TBD',
          location: data.location || 'Ever Club',
          image: data.image_url || 'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?q=80&w=1000&auto=format&fit=crop',
          description: data.description || '',
          attendees: [],
          capacity: data.max_attendees || undefined,
          ticketsSold: undefined
        } as EventData;
        setEvents(prev => prev.map(i => i.id === formatted.id ? formatted : i));
      }
    } catch (err: unknown) {
      console.error('Failed to update event:', err);
    }
  }, []);

  const deleteEvent = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/events/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) {
        setEvents(prev => prev.filter(i => i.id !== id));
      }
    } catch (err: unknown) {
      console.error('Failed to delete event:', err);
    }
  }, []);

  const syncEventbrite = useCallback(async () => {
    try {
      const res = await fetch('/api/eventbrite/sync', { method: 'POST' });
      if (res.ok) {
        const eventsRes = await fetch('/api/events');
        if (eventsRes.ok) {
          const data = await eventsRes.json();
          if (data?.length) {
            setEvents(formatEventData(data));
          }
        }
      }
    } catch (err: unknown) {
      console.error('Failed to sync Eventbrite:', err);
    }
  }, []);

  const contextValue = useMemo(() => ({
    events, eventsLoaded, addEvent, updateEvent, deleteEvent, syncEventbrite
  }), [events, eventsLoaded, addEvent, updateEvent, deleteEvent, syncEventbrite]);

  return (
    <EventDataContext.Provider value={contextValue}>
      {children}
    </EventDataContext.Provider>
  );
};

export const useEventData = () => {
  const context = useContext(EventDataContext);
  if (!context) {
    throw new Error('useEventData must be used within an EventDataProvider');
  }
  return context;
};
