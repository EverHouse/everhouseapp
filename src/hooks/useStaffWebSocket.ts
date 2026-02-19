import { useEffect, useRef, useCallback, useState } from 'react';
import { useData } from '../contexts/DataContext';

export interface BookingEvent {
  eventType: string;
  bookingId: number;
  memberEmail: string;
  memberName?: string;
  resourceId?: number;
  resourceName?: string;
  resourceType?: string;
  bookingDate: string;
  startTime: string;
  endTime?: string;
  durationMinutes?: number;
  playerCount?: number;
  status: string;
  actionBy?: 'member' | 'staff';
  timestamp: string;
}

interface UseStaffWebSocketOptions {
  onBookingEvent?: (event: BookingEvent) => void;
  debounceMs?: number;
}

let globalConnectionId = 0;

export function useStaffWebSocket(options: UseStaffWebSocketOptions = {}) {
  const { onBookingEvent, debounceMs = 500 } = options;
  const { actualUser, sessionChecked } = useData();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef(0);
  const initTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isConnectingRef = useRef(false);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingEventsRef = useRef<BookingEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<BookingEvent | null>(null);
  
  const mountIdRef = useRef<number>(0);
  const connectionIdRef = useRef<number>(0);
  const activeConnectionUserRef = useRef<string | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const hasInitializedRef = useRef(false);
  
  const onBookingEventRef = useRef(onBookingEvent);
  onBookingEventRef.current = onBookingEvent;
  const debounceMsRef = useRef(debounceMs);
  debounceMsRef.current = debounceMs;

  const userEmailRef = useRef(actualUser?.email);
  const userRoleRef = useRef(actualUser?.role);
  const sessionCheckedRef = useRef(sessionChecked);
  userEmailRef.current = actualUser?.email;
  userRoleRef.current = actualUser?.role;
  sessionCheckedRef.current = sessionChecked;

  const processPendingEvents = useCallback(() => {
    if (pendingEventsRef.current.length === 0) return;
    
    const events = [...pendingEventsRef.current];
    pendingEventsRef.current = [];
    
    const latestEvent = events[events.length - 1];
    setLastEvent(latestEvent);
    
    if (onBookingEventRef.current) {
      onBookingEventRef.current(latestEvent);
    }
    
    window.dispatchEvent(new CustomEvent('booking-update', { detail: latestEvent }));
  }, []);

  const handleBookingEvent = useCallback((event: BookingEvent) => {
    pendingEventsRef.current.push(event);
    
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    debounceTimerRef.current = setTimeout(() => {
      processPendingEvents();
    }, debounceMsRef.current);
  }, [processPendingEvents]);

  const connect = useCallback((reason: string) => {
    const email = userEmailRef.current;
    const role = userRoleRef.current;
    const currentMountId = mountIdRef.current;
    
    if (!email) {
      console.log('[StaffWebSocket] Skipping connect: no email');
      return;
    }
    
    if (isConnectingRef.current) {
      console.log('[StaffWebSocket] Skipping connect: already connecting');
      return;
    }
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('[StaffWebSocket] Skipping connect: socket already open');
      return;
    }
    
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      console.log('[StaffWebSocket] Skipping connect: socket already connecting');
      return;
    }

    const isStaff = role === 'staff' || role === 'admin';
    if (!isStaff) {
      console.log('[StaffWebSocket] Skipping connect: not staff');
      return;
    }

    globalConnectionId++;
    const thisConnectionId = globalConnectionId;
    connectionIdRef.current = thisConnectionId;
    
    console.log(`[StaffWebSocket] Connecting (id=${thisConnectionId}, mount=${currentMountId}, reason=${reason}):`, email);
    isConnectingRef.current = true;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (connectionIdRef.current !== thisConnectionId) {
          console.log(`[StaffWebSocket] Stale connection opened (id=${thisConnectionId}, current=${connectionIdRef.current}), closing`);
          ws.close();
          return;
        }
        
        const currentEmail = userEmailRef.current;
        console.log(`[StaffWebSocket] Connected (id=${thisConnectionId}):`, currentEmail);
        isConnectingRef.current = false;
        setIsConnected(true);
        activeConnectionUserRef.current = currentEmail || null;
        intentionalDisconnectRef.current = false;
        reconnectAttemptRef.current = 0;
        ws.send(JSON.stringify({ 
          type: 'auth', 
          email: currentEmail,
          isStaff: true 
        }));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          if (message.type === 'booking_event') {
            console.log('[StaffWebSocket] Received booking_event:', message.eventType);
            handleBookingEvent(message as BookingEvent);
          }
          
          if (message.type === 'notification') {
            console.log('[StaffWebSocket] Received notification');
            handleBookingEvent({
              eventType: 'notification',
              bookingId: message.data?.bookingId || 0,
              memberEmail: '',
              bookingDate: '',
              startTime: '',
              status: '',
              timestamp: new Date().toISOString()
            });
          }
          
          if (message.type === 'rsvp_event') {
            console.log('[StaffWebSocket] Received rsvp_event:', message.action);
            handleBookingEvent({
              eventType: `rsvp_${message.action}`,
              bookingId: message.eventId || 0,
              memberEmail: message.memberEmail || '',
              bookingDate: '',
              startTime: '',
              status: message.action,
              timestamp: new Date().toISOString()
            });
          }
          
          if (message.type === 'wellness_event') {
            console.log('[StaffWebSocket] Received wellness_event:', message.action);
            handleBookingEvent({
              eventType: `wellness_${message.action}`,
              bookingId: message.classId || 0,
              memberEmail: message.memberEmail || '',
              bookingDate: '',
              startTime: '',
              status: message.action,
              timestamp: new Date().toISOString()
            });
          }
          
          if (message.type === 'walkin_checkin') {
            console.log('[StaffWebSocket] Received walkin_checkin:', message.data?.memberName);
            window.dispatchEvent(new CustomEvent('walkin-checkin', { detail: message }));
          }

          if (message.type === 'directory_update') {
            console.log('[StaffWebSocket] Received directory_update:', message.action);
            window.dispatchEvent(new CustomEvent('directory-update', { detail: message }));
          }

          if (message.type === 'availability_update') {
            console.log('[StaffWebSocket] Received availability_update');
            handleBookingEvent({
              eventType: 'availability_update',
              bookingId: 0,
              memberEmail: '',
              bookingDate: message.date || '',
              startTime: '',
              status: message.action,
              timestamp: new Date().toISOString()
            });
          }

          if (message.type === 'cafe_menu_update') {
            window.dispatchEvent(new CustomEvent('cafe-menu-update', { detail: message }));
          }

          if (message.type === 'closure_update') {
            window.dispatchEvent(new CustomEvent('closure-update', { detail: message }));
          }

          if (message.type === 'billing_update') {
            console.log('[StaffWebSocket] Received billing_update:', message.action);
            window.dispatchEvent(new CustomEvent('billing-update', { detail: message }));
            
            if (message.action === 'booking_payment_updated' && message.bookingId) {
              handleBookingEvent({
                eventType: 'payment_updated',
                bookingId: message.bookingId,
                memberEmail: message.memberEmail || '',
                bookingDate: '',
                startTime: '',
                status: 'paid',
                timestamp: new Date().toISOString()
              });
            }
          }

          if (message.type === 'tier_update') {
            console.log('[StaffWebSocket] Received tier_update:', message.action);
            window.dispatchEvent(new CustomEvent('tier-update', { detail: message }));
          }

          if (message.type === 'member_stats_updated') {
            console.log('[StaffWebSocket] Received member_stats_updated for:', message.memberEmail);
            window.dispatchEvent(new CustomEvent('member-stats-updated', { detail: message }));
          }

          if (message.type === 'booking_auto_confirmed') {
            console.log('[StaffWebSocket] Received booking_auto_confirmed:', message.data?.memberName);
            window.dispatchEvent(new CustomEvent('booking-auto-confirmed', { detail: message }));
            handleBookingEvent({
              eventType: 'booking_auto_confirmed',
              bookingId: message.data?.bookingId || 0,
              memberEmail: message.data?.memberEmail || '',
              memberName: message.data?.memberName,
              bookingDate: message.data?.date || '',
              startTime: message.data?.time || '',
              status: 'approved',
              timestamp: new Date().toISOString()
            });
          }

          if (message.type === 'booking_confirmed') {
            console.log('[StaffWebSocket] Received booking_confirmed:', message.data?.bookingId);
            window.dispatchEvent(new CustomEvent('booking-confirmed', { detail: message }));
            handleBookingEvent({
              eventType: 'booking_confirmed',
              bookingId: message.data?.bookingId || 0,
              memberEmail: message.data?.userEmail || '',
              bookingDate: '',
              startTime: '',
              status: 'approved',
              timestamp: new Date().toISOString()
            });
          }

          if (message.type === 'day_pass_update') {
            console.log('[StaffWebSocket] Received day_pass_update:', message.action);
            window.dispatchEvent(new CustomEvent('day-pass-update', { detail: message }));
          }

          if (message.type === 'tour_update') {
            console.log('[StaffWebSocket] Received tour_update:', message.action);
            window.dispatchEvent(new CustomEvent('tour-update', { detail: message }));
          }
        } catch (e: unknown) {
          console.error('[StaffWebSocket] Error parsing message:', e);
        }
      };

      ws.onclose = () => {
        const wasThisConnection = connectionIdRef.current === thisConnectionId;
        console.log(`[StaffWebSocket] Connection closed (id=${thisConnectionId}, current=${connectionIdRef.current}, wasActive=${wasThisConnection})`);
        
        if (!wasThisConnection) {
          return;
        }
        
        isConnectingRef.current = false;
        setIsConnected(false);
        wsRef.current = null;
        activeConnectionUserRef.current = null;
        
        if (!intentionalDisconnectRef.current) {
          const currentEmail = userEmailRef.current;
          const currentRole = userRoleRef.current;
          if (currentEmail && (currentRole === 'staff' || currentRole === 'admin')) {
            const baseDelay = 2000;
            const maxDelay = 30000;
            const delay = Math.min(baseDelay * Math.pow(2, reconnectAttemptRef.current), maxDelay);
            reconnectAttemptRef.current++;
            console.log(`[StaffWebSocket] Scheduling reconnect in ${delay / 1000}s (attempt ${reconnectAttemptRef.current})`);
            reconnectTimeoutRef.current = setTimeout(() => {
              if (!sessionCheckedRef.current) {
                console.log('[StaffWebSocket] Session not ready, delaying reconnect');
                reconnectTimeoutRef.current = setTimeout(() => {
                  connect('session_ready_retry');
                }, 1000);
                return;
              }
              connect('auto_reconnect');
            }, delay);
          }
        }
      };

      ws.onerror = (error) => {
        console.error(`[StaffWebSocket] Connection error (id=${thisConnectionId}):`, error);
        isConnectingRef.current = false;
        setIsConnected(false);
      };
    } catch (e: unknown) {
      isConnectingRef.current = false;
      setIsConnected(false);
      console.error('[StaffWebSocket] Connection error:', e);
    }
  }, [handleBookingEvent]);

  const cleanup = useCallback(() => {
    console.log(`[StaffWebSocket] Cleanup called (mount=${mountIdRef.current})`);
    intentionalDisconnectRef.current = true;
    
    if (initTimerRef.current) {
      clearTimeout(initTimerRef.current);
      initTimerRef.current = null;
    }
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    isConnectingRef.current = false;
    activeConnectionUserRef.current = null;
  }, []);

  useEffect(() => {
    mountIdRef.current++;
    const thisMountId = mountIdRef.current;
    console.log(`[StaffWebSocket] Effect running (mount=${thisMountId}, sessionChecked=${sessionChecked}, email=${actualUser?.email})`);
    
    if (!sessionChecked) {
      console.log(`[StaffWebSocket] Waiting for session check (mount=${thisMountId})`);
      return;
    }
    
    const userEmail = actualUser?.email;
    const isStaff = actualUser?.role === 'staff' || actualUser?.role === 'admin';
    
    if (!userEmail || !isStaff) {
      if (activeConnectionUserRef.current || wsRef.current) {
        console.log(`[StaffWebSocket] User logged out or no longer staff, cleaning up (mount=${thisMountId})`);
        cleanup();
      }
      intentionalDisconnectRef.current = false;
      hasInitializedRef.current = false;
      return;
    }
    
    if (activeConnectionUserRef.current === userEmail && wsRef.current?.readyState === WebSocket.OPEN) {
      console.log(`[StaffWebSocket] Already connected to ${userEmail}, skipping (mount=${thisMountId})`);
      return;
    }
    
    if (activeConnectionUserRef.current && activeConnectionUserRef.current !== userEmail) {
      console.log(`[StaffWebSocket] User changed from ${activeConnectionUserRef.current} to ${userEmail} (mount=${thisMountId})`);
      cleanup();
    }
    
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      console.log(`[StaffWebSocket] Socket already open/connecting, skipping (mount=${thisMountId})`);
      return;
    }
    
    if (isConnectingRef.current) {
      console.log(`[StaffWebSocket] Already connecting, skipping (mount=${thisMountId})`);
      return;
    }
    
    if (initTimerRef.current) {
      console.log(`[StaffWebSocket] Init timer already pending, skipping (mount=${thisMountId})`);
      return;
    }

    console.log(`[StaffWebSocket] Scheduling connection for ${userEmail} (mount=${thisMountId})`);
    intentionalDisconnectRef.current = false;
    hasInitializedRef.current = true;
    
    initTimerRef.current = setTimeout(() => {
      initTimerRef.current = null;
      if (mountIdRef.current !== thisMountId) {
        console.log(`[StaffWebSocket] Stale init timer (mount=${thisMountId}, current=${mountIdRef.current}), skipping`);
        return;
      }
      connect('initial');
    }, 300);
    
  }, [sessionChecked, actualUser?.email, actualUser?.role, cleanup, connect]);
  
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    isConnected,
    lastEvent
  };
}

export default useStaffWebSocket;
