import { useEffect, useRef, useCallback, useMemo } from 'react';
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
  const mountedRef = useRef(true);
  const instanceId = useMemo(() => Math.random().toString(36).slice(2, 8), []);

  const onNotificationRef = useRef(onNotification);
  const onBookingUpdateRef = useRef(onBookingUpdate);
  const onAnnouncementUpdateRef = useRef(onAnnouncementUpdate);
  const onTrackmanUnmatchedUpdateRef = useRef(onTrackmanUnmatchedUpdate);
  onNotificationRef.current = onNotification;
  onBookingUpdateRef.current = onBookingUpdate;
  onAnnouncementUpdateRef.current = onAnnouncementUpdate;
  onTrackmanUnmatchedUpdateRef.current = onTrackmanUnmatchedUpdate;

  const getHandler = useCallback((table: string) => {
    switch (table) {
      case 'notifications': return (payload: Record<string, unknown>) => {
        window.dispatchEvent(new CustomEvent('member-notification', { detail: payload }));
        if (!window.__wsConnected) {
          bookingEvents.emit();
        }
        onNotificationRef.current?.(payload);
      };
      case 'booking_sessions': return (payload: Record<string, unknown>) => {
        window.dispatchEvent(new CustomEvent('booking-update', { detail: payload }));
        if (!window.__wsConnected) {
          bookingEvents.emit();
        }
        onBookingUpdateRef.current?.(payload);
      };
      case 'announcements': return (payload: Record<string, unknown>) => {
        window.dispatchEvent(new CustomEvent('announcement-update', { detail: payload }));
        onAnnouncementUpdateRef.current?.(payload);
      };
      case 'trackman_unmatched_bookings': return (payload: Record<string, unknown>) => {
        window.dispatchEvent(new CustomEvent('trackman-unmatched-update', { detail: payload }));
        onTrackmanUnmatchedUpdateRef.current?.(payload);
      };
      default: return (payload: Record<string, unknown>) => {
        window.dispatchEvent(new CustomEvent(`${table}-update`, { detail: payload }));
      };
    }
  }, []);

  const getChannelName = useCallback((table: string) => {
    const base = (table === 'notifications' && userEmail)
      ? `realtime-${table}-${userEmail}`
      : `realtime-${table}`;
    return `${base}-${instanceId}`;
  }, [userEmail, instanceId]);

  const subscribeToTable = useCallback((supabase: ReturnType<typeof getSupabase>, table: string) => {
    if (!supabase || !mountedRef.current) return;

    const existingChannel = channelsRef.current.get(table);
    if (existingChannel) {
      try {
        supabase.removeChannel(existingChannel);
      } catch {
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
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        const errMsg = err ? ` (${err.message || err})` : '';
        console.warn(`[Supabase Realtime] ${status} for ${table}${errMsg} — SDK will auto-recover`);
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

    for (const table of tables) {
      subscribeToTable(supabase, table);
    }

    return () => {
      mountedRef.current = false;
      channelsRef.current.forEach((channel) => {
        try {
          supabase.removeChannel(channel);
        } catch {
        }
      });
      channelsRef.current.clear();
    };
  }, [userEmail, tables, subscribeToTable]);

  return {
    isConfigured: !!getSupabase()
  };
}
