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

export function useSupabaseRealtime(options: UseSupabaseRealtimeOptions = {}) {
  const {
    userEmail,
    tables = DEFAULT_TABLES,
    onNotification,
    onBookingUpdate,
    onAnnouncementUpdate,
    onTrackmanUnmatchedUpdate
  } = options;

  const channelsRef = useRef<RealtimeChannel[]>([]);
  const isSubscribedRef = useRef(false);
  const retryCountRef = useRef<Record<string, number>>({});
  const retryTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const handleNotification = useCallback((payload: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent('member-notification', { detail: payload }));
    // Only emit if WebSocket is not handling events (Supabase Realtime acts as fallback)
    if (!window.__wsConnected) {
      bookingEvents.emit();
    }
    onNotification?.(payload);
  }, [onNotification]);

  const handleBookingUpdate = useCallback((payload: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent('booking-update', { detail: payload }));
    // Only emit if WebSocket is not handling events (Supabase Realtime acts as fallback)
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

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      return;
    }

    if (isSubscribedRef.current) {
      return;
    }

    const subscribeToTables = async () => {
      const channels: RealtimeChannel[] = [];

      for (const table of tables) {
        let channel: RealtimeChannel;

        if (table === 'notifications' && userEmail) {
          channel = supabase
            .channel(`realtime-${table}-${userEmail}`)
            .on(
              'postgres_changes',
              {
                event: '*',
                schema: 'public',
                table,
                filter: `user_email=eq.${userEmail}`
              },
              (payload) => {
                handleNotification(payload);
              }
            );
        } else if (table === 'notifications') {
          channel = supabase
            .channel(`realtime-${table}`)
            .on(
              'postgres_changes',
              {
                event: '*',
                schema: 'public',
                table
              },
              (payload) => {
                handleNotification(payload);
              }
            );
        } else if (table === 'booking_sessions') {
          channel = supabase
            .channel(`realtime-${table}`)
            .on(
              'postgres_changes',
              {
                event: '*',
                schema: 'public',
                table
              },
              (payload) => {
                handleBookingUpdate(payload);
              }
            );
        } else if (table === 'announcements') {
          channel = supabase
            .channel(`realtime-${table}`)
            .on(
              'postgres_changes',
              {
                event: '*',
                schema: 'public',
                table
              },
              (payload) => {
                handleAnnouncementUpdate(payload);
              }
            );
        } else if (table === 'trackman_unmatched_bookings') {
          channel = supabase
            .channel(`realtime-${table}`)
            .on(
              'postgres_changes',
              {
                event: '*',
                schema: 'public',
                table
              },
              (payload) => {
                handleTrackmanUnmatchedUpdate(payload);
              }
            );
        } else {
          channel = supabase
            .channel(`realtime-${table}`)
            .on(
              'postgres_changes',
              {
                event: '*',
                schema: 'public',
                table
              },
              (payload) => {
                window.dispatchEvent(new CustomEvent(`${table}-update`, { detail: payload }));
              }
            );
        }

        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            console.log(`[Supabase Realtime] Subscribed to ${table}`);
            retryCountRef.current[table] = 0;
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            const currentRetries = retryCountRef.current[table] || 0;
            console.warn(`[Supabase Realtime] ${status} for ${table} (attempt ${currentRetries + 1}/3)`);
            if (currentRetries < 3) {
              retryCountRef.current[table] = currentRetries + 1;
              if (retryTimersRef.current[table]) {
                clearTimeout(retryTimersRef.current[table]);
              }
              retryTimersRef.current[table] = setTimeout(() => {
                delete retryTimersRef.current[table];
                try {
                  supabase.removeChannel(channel);
                } catch {}
                const idx = channelsRef.current.indexOf(channel);
                if (idx !== -1) {
                  channelsRef.current.splice(idx, 1);
                }
                isSubscribedRef.current = false;
                subscribeToTables();
              }, 5000);
            } else {
              console.warn(`[Supabase Realtime] Max retries reached for ${table}, giving up`);
            }
          } else if (status === 'CLOSED') {
            console.log(`[Supabase Realtime] Channel closed for ${table}`);
            const idx = channelsRef.current.indexOf(channel);
            if (idx !== -1) {
              channelsRef.current.splice(idx, 1);
            }
          }
        });

        channels.push(channel);
      }

      channelsRef.current = channels;
      isSubscribedRef.current = true;
    };

    subscribeToTables();

    return () => {
      Object.values(retryTimersRef.current).forEach(clearTimeout);
      retryTimersRef.current = {};
      channelsRef.current.forEach((channel) => {
        supabase.removeChannel(channel);
      });
      channelsRef.current = [];
      isSubscribedRef.current = false;
    };
  }, [userEmail, tables, handleNotification, handleBookingUpdate, handleAnnouncementUpdate, handleTrackmanUnmatchedUpdate]);

  return {
    isConfigured: !!getSupabase()
  };
}
