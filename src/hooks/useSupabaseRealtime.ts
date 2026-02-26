import { useEffect, useRef, useCallback } from 'react';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase';
import { bookingEvents } from '../lib/bookingEvents';

export interface UseSupabaseRealtimeOptions {
  userEmail?: string;
  tables?: string[];
  onNotification?: (payload: Record<string, unknown>) => void;
  onBookingUpdate?: (payload: Record<string, unknown>) => void;
  onAnnouncementUpdate?: (payload: Record<string, unknown>) => void;
  onTrackmanUnmatchedUpdate?: (payload: Record<string, unknown>) => void;
}

const DEFAULT_TABLES = ['notifications', 'booking_sessions', 'announcements', 'trackman_unmatched_bookings'];
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 3000;

function getRetryDelay(attempt: number): number {
  const exponentialDelay = BASE_RETRY_DELAY * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;
  return exponentialDelay + jitter;
}

export function useSupabaseRealtime(options: UseSupabaseRealtimeOptions = {}) {
  const {
    userEmail,
    tables = DEFAULT_TABLES,
    onNotification,
    onBookingUpdate,
    onAnnouncementUpdate,
    onTrackmanUnmatchedUpdate
  } = options;

  const channelsRef = useRef<Map<string, RealtimeChannel>>(new Map());
  const retryCountRef = useRef<Record<string, number>>({});
  const retryTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const mountedRef = useRef(true);

  const handleNotification = useCallback((payload: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent('member-notification', { detail: payload }));
    if (!window.__wsConnected) {
      bookingEvents.emit();
    }
    onNotification?.(payload);
  }, [onNotification]);

  const handleBookingUpdate = useCallback((payload: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent('booking-update', { detail: payload }));
    if (!window.__wsConnected) {
      bookingEvents.emit();
    }
    onBookingUpdate?.(payload);
  }, [onBookingUpdate]);

  const handleAnnouncementUpdate = useCallback((payload: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent('announcement-update', { detail: payload }));
    onAnnouncementUpdate?.(payload);
  }, [onAnnouncementUpdate]);

  const handleTrackmanUnmatchedUpdate = useCallback((payload: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent('trackman-unmatched-update', { detail: payload }));
    onTrackmanUnmatchedUpdate?.(payload);
  }, [onTrackmanUnmatchedUpdate]);

  const getHandler = useCallback((table: string) => {
    switch (table) {
      case 'notifications': return handleNotification;
      case 'booking_sessions': return handleBookingUpdate;
      case 'announcements': return handleAnnouncementUpdate;
      case 'trackman_unmatched_bookings': return handleTrackmanUnmatchedUpdate;
      default: return (payload: Record<string, unknown>) => {
        window.dispatchEvent(new CustomEvent(`${table}-update`, { detail: payload }));
      };
    }
  }, [handleNotification, handleBookingUpdate, handleAnnouncementUpdate, handleTrackmanUnmatchedUpdate]);

  const getChannelName = useCallback((table: string) => {
    if (table === 'notifications' && userEmail) {
      return `realtime-${table}-${userEmail}`;
    }
    return `realtime-${table}`;
  }, [userEmail]);

  const subscribeToTable = useCallback((supabase: ReturnType<typeof getSupabase>, table: string) => {
    if (!supabase || !mountedRef.current) return;

    const existingChannel = channelsRef.current.get(table);
    if (existingChannel) {
      try {
        supabase.removeChannel(existingChannel);
      } catch {
        // Channel may already be removed
      }
      channelsRef.current.delete(table);
    }

    const channelName = getChannelName(table);
    const handler = getHandler(table);

    const filter = (table === 'notifications' && userEmail)
      ? { event: '*' as const, schema: 'public', table, filter: `user_email=eq.${userEmail}` }
      : { event: '*' as const, schema: 'public', table };

    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', filter, (payload) => {
        handler(payload);
      });

    channel.subscribe((status, err) => {
      if (!mountedRef.current) return;

      if (status === 'SUBSCRIBED') {
        console.log(`[Supabase Realtime] Subscribed to ${table}`);
        retryCountRef.current[table] = 0;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        const currentRetries = retryCountRef.current[table] || 0;
        const errMsg = err ? ` (${err.message || err})` : '';

        if (currentRetries >= MAX_RETRIES) {
          console.warn(`[Supabase Realtime] Max retries reached for ${table}, disabling${errMsg}`);
          try {
            supabase.removeChannel(channel);
          } catch {
            // Ignore
          }
          channelsRef.current.delete(table);
          return;
        }

        retryCountRef.current[table] = currentRetries + 1;
        const delay = getRetryDelay(currentRetries);
        console.warn(`[Supabase Realtime] ${status} for ${table} (attempt ${currentRetries + 1}/${MAX_RETRIES})${errMsg}, retrying in ${Math.round(delay / 1000)}s`);

        if (retryTimersRef.current[table]) {
          clearTimeout(retryTimersRef.current[table]);
        }

        retryTimersRef.current[table] = setTimeout(() => {
          delete retryTimersRef.current[table];
          if (!mountedRef.current) return;
          subscribeToTable(supabase, table);
        }, delay);
      } else if (status === 'CLOSED') {
        console.log(`[Supabase Realtime] Channel closed for ${table}`);
        channelsRef.current.delete(table);
      }
    });

    channelsRef.current.set(table, channel);
  }, [getChannelName, getHandler, userEmail]);

  useEffect(() => {
    mountedRef.current = true;
    const supabase = getSupabase();
    if (!supabase) {
      return () => {
        mountedRef.current = false;
      };
    }

    retryCountRef.current = {};

    for (const table of tables) {
      subscribeToTable(supabase, table);
    }

    return () => {
      mountedRef.current = false;
      Object.values(retryTimersRef.current).forEach(clearTimeout);
      retryTimersRef.current = {};
      channelsRef.current.forEach((channel) => {
        try {
          supabase.removeChannel(channel);
        } catch {
          // Ignore cleanup errors
        }
      });
      channelsRef.current.clear();
      retryCountRef.current = {};
    };
  }, [userEmail, tables, subscribeToTable]);

  return {
    isConfigured: !!getSupabase()
  };
}
