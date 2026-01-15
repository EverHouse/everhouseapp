import { useEffect, useRef, useCallback } from 'react';
import { useUserStore } from '../stores/userStore';
import { apiRequest } from '../lib/apiRequest';
import { bookingEvents } from '../lib/bookingEvents';

interface WebSocketMessage {
  type: string;
  title?: string;
  message?: string;
  data?: any;
}

interface UseWebSocketOptions {
  effectiveEmail?: string;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const { user, fetchNotifications } = useUserStore();
  const { effectiveEmail } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isConnectingRef = useRef(false);

  const emailToUse = effectiveEmail || user?.email;
  const isViewAsMode = effectiveEmail && effectiveEmail !== user?.email;

  const fetchNotificationsForEmail = useCallback(async () => {
    if (!emailToUse) return;
    
    if (isViewAsMode) {
      const { ok, data } = await apiRequest<any[]>(
        `/api/notifications?user_email=${encodeURIComponent(emailToUse)}&unread_only=true`
      );
      if (ok && data) {
        useUserStore.setState({ unreadNotifications: data.length });
      }
    } else {
      fetchNotifications();
    }
  }, [emailToUse, isViewAsMode, fetchNotifications]);

  const connect = useCallback(() => {
    if (!emailToUse || isConnectingRef.current || wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    isConnectingRef.current = true;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        isConnectingRef.current = false;
        ws.send(JSON.stringify({ type: 'auth', email: emailToUse }));
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          
          if (message.type === 'notification') {
            fetchNotificationsForEmail();
            window.dispatchEvent(new CustomEvent('member-notification', { detail: message }));
            
            // Trigger data refresh for booking, RSVP, and wellness related notifications
            const eventType = message.data?.eventType;
            if (eventType && [
              'booking_approved', 'booking_declined', 'booking_cancelled', 'booking_created',
              'rsvp_created', 'rsvp_cancelled',
              'wellness_enrolled', 'wellness_cancelled'
            ].includes(eventType)) {
              bookingEvents.emit();
            }
          }
          
          // Handle booking events directly (for real-time updates without notification)
          if (message.type === 'booking_event' || message.type === 'rsvp_event' || message.type === 'wellness_event') {
            bookingEvents.emit();
          }
          
          // Handle announcement updates (for instant refresh without page reload)
          if (message.type === 'announcement_update') {
            window.dispatchEvent(new CustomEvent('announcement-update', { detail: message }));
          }
          
          // Handle availability updates (booking slots)
          if (message.type === 'availability_update') {
            window.dispatchEvent(new CustomEvent('availability-update', { detail: message }));
            bookingEvents.emit(); // Trigger data refresh
          }

          // Handle waitlist updates (wellness classes)
          if (message.type === 'waitlist_update') {
            window.dispatchEvent(new CustomEvent('waitlist-update', { detail: message }));
            bookingEvents.emit();
          }

          // Handle cafe menu updates
          if (message.type === 'cafe_menu_update') {
            window.dispatchEvent(new CustomEvent('cafe-menu-update', { detail: message }));
          }

          // Handle closure/notice updates
          if (message.type === 'closure_update') {
            window.dispatchEvent(new CustomEvent('closure-update', { detail: message }));
          }

          // Handle member data updates (from HubSpot sync)
          if (message.type === 'member_data_updated') {
            window.dispatchEvent(new CustomEvent('member-data-updated', { detail: message }));
          }

          // Handle member stats updates (guest passes, visit counts)
          if (message.type === 'member_stats_updated') {
            window.dispatchEvent(new CustomEvent('member-stats-updated', { detail: message }));
          }

          // Handle data integrity updates (for admin dashboard)
          if (message.type === 'data_integrity_update') {
            window.dispatchEvent(new CustomEvent('data-integrity-update', { detail: message }));
          }

          // Handle billing updates (for Billing tab real-time updates)
          if (message.type === 'billing_update') {
            window.dispatchEvent(new CustomEvent('billing-update', { detail: message }));
          }
        } catch (e) {
          console.error('[WebSocket] Error parsing message:', e);
        }
      };

      ws.onclose = () => {
        isConnectingRef.current = false;
        wsRef.current = null;
        
        if (emailToUse) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, 5000);
        }
      };

      ws.onerror = () => {
        isConnectingRef.current = false;
      };
    } catch (e) {
      isConnectingRef.current = false;
      console.error('[WebSocket] Connection error:', e);
    }
  }, [emailToUse, fetchNotificationsForEmail]);

  useEffect(() => {
    if (emailToUse) {
      connect();
    }

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [emailToUse, connect]);

  return {
    isConnected: wsRef.current?.readyState === WebSocket.OPEN
  };
}
