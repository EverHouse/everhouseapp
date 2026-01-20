import { useEffect, useRef, useCallback } from 'react';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase';
import { bookingEvents } from '../lib/bookingEvents';

export interface UseSupabaseRealtimeOptions {
  userEmail?: string;
  tables?: string[];
  onNotification?: (payload: any) => void;
  onBookingUpdate?: (payload: any) => void;
  onAnnouncementUpdate?: (payload: any) => void;
}

const DEFAULT_TABLES = ['notifications', 'booking_sessions', 'announcements'];

export function useSupabaseRealtime(options: UseSupabaseRealtimeOptions = {}) {
  const {
    userEmail,
    tables = DEFAULT_TABLES,
    onNotification,
    onBookingUpdate,
    onAnnouncementUpdate
  } = options;

  const channelsRef = useRef<RealtimeChannel[]>([]);
  const isSubscribedRef = useRef(false);

  const handleNotification = useCallback((payload: any) => {
    window.dispatchEvent(new CustomEvent('member-notification', { detail: payload }));
    bookingEvents.emit();
    onNotification?.(payload);
  }, [onNotification]);

  const handleBookingUpdate = useCallback((payload: any) => {
    window.dispatchEvent(new CustomEvent('booking-update', { detail: payload }));
    bookingEvents.emit();
    onBookingUpdate?.(payload);
  }, [onBookingUpdate]);

  const handleAnnouncementUpdate = useCallback((payload: any) => {
    window.dispatchEvent(new CustomEvent('announcement-update', { detail: payload }));
    onAnnouncementUpdate?.(payload);
  }, [onAnnouncementUpdate]);

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
          }
        });

        channels.push(channel);
      }

      channelsRef.current = channels;
      isSubscribedRef.current = true;
    };

    subscribeToTables();

    return () => {
      channelsRef.current.forEach((channel) => {
        supabase.removeChannel(channel);
      });
      channelsRef.current = [];
      isSubscribedRef.current = false;
    };
  }, [userEmail, tables, handleNotification, handleBookingUpdate, handleAnnouncementUpdate]);

  return {
    isConfigured: !!getSupabase()
  };
}
