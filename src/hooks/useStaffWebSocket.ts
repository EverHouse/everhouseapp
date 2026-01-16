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

export function useStaffWebSocket(options: UseStaffWebSocketOptions = {}) {
  const { onBookingEvent, debounceMs = 500 } = options;
  const { actualUser, sessionChecked, sessionVersion } = useData();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const initTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isConnectingRef = useRef(false);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingEventsRef = useRef<BookingEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<BookingEvent | null>(null);
  
  // Track which user has an active socket connection (set on socket open, cleared on close)
  const activeConnectionUserRef = useRef<string | null>(null);
  // Track if we intentionally disconnected (to prevent auto-reconnect)
  const intentionalDisconnectRef = useRef(false);
  
  // Store options in refs to avoid dependency changes causing socket teardown
  const onBookingEventRef = useRef(onBookingEvent);
  onBookingEventRef.current = onBookingEvent;
  const debounceMsRef = useRef(debounceMs);
  debounceMsRef.current = debounceMs;

  // Store user info and session state in refs for use in callbacks
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

  const connect = useCallback(() => {
    const email = userEmailRef.current;
    const role = userRoleRef.current;
    
    if (!email) {
      return;
    }
    
    if (isConnectingRef.current) {
      return;
    }
    
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const isStaff = role === 'staff' || role === 'admin';
    if (!isStaff) {
      return;
    }

    console.log('[StaffWebSocket] Connecting as staff:', email);
    isConnectingRef.current = true;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        const currentEmail = userEmailRef.current;
        console.log('[StaffWebSocket] Connected, sending auth for:', currentEmail);
        isConnectingRef.current = false;
        setIsConnected(true);
        // Mark this user as having an active connection
        activeConnectionUserRef.current = currentEmail || null;
        // Reset intentional disconnect flag on successful connect
        intentionalDisconnectRef.current = false;
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
          
          // Handle directory updates (staff only - member directory syncs)
          if (message.type === 'directory_update') {
            console.log('[StaffWebSocket] Received directory_update:', message.action);
            window.dispatchEvent(new CustomEvent('directory-update', { detail: message }));
          }

          // Handle availability updates (booking slots)
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

          // Handle cafe menu updates
          if (message.type === 'cafe_menu_update') {
            window.dispatchEvent(new CustomEvent('cafe-menu-update', { detail: message }));
          }

          // Handle closure/notice updates
          if (message.type === 'closure_update') {
            window.dispatchEvent(new CustomEvent('closure-update', { detail: message }));
          }

          // Handle billing updates (payment status changes)
          if (message.type === 'billing_update') {
            console.log('[StaffWebSocket] Received billing_update:', message.action);
            window.dispatchEvent(new CustomEvent('billing-update', { detail: message }));
            
            // Also trigger booking update to refresh booking lists
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
        } catch (e) {
          console.error('[StaffWebSocket] Error parsing message:', e);
        }
      };

      ws.onclose = () => {
        console.log('[StaffWebSocket] Connection closed');
        isConnectingRef.current = false;
        setIsConnected(false);
        wsRef.current = null;
        // Clear active connection marker
        activeConnectionUserRef.current = null;
        
        // Only reconnect if this wasn't an intentional disconnect
        if (!intentionalDisconnectRef.current) {
          const currentEmail = userEmailRef.current;
          const currentRole = userRoleRef.current;
          if (currentEmail && (currentRole === 'staff' || currentRole === 'admin')) {
            console.log('[StaffWebSocket] Scheduling reconnect in 5 seconds');
            reconnectTimeoutRef.current = setTimeout(() => {
              // Re-check session readiness before reconnecting
              if (!sessionCheckedRef.current) {
                console.log('[StaffWebSocket] Session not ready, delaying reconnect');
                // Schedule another attempt
                reconnectTimeoutRef.current = setTimeout(() => {
                  connect();
                }, 1000);
                return;
              }
              connect();
            }, 5000);
          }
        }
      };

      ws.onerror = (error) => {
        console.error('[StaffWebSocket] Connection error:', error);
        isConnectingRef.current = false;
        setIsConnected(false);
      };
    } catch (e) {
      isConnectingRef.current = false;
      setIsConnected(false);
      console.error('[StaffWebSocket] Connection error:', e);
    }
  }, [handleBookingEvent]);

  // Cleanup function that tears down socket and timers
  const cleanup = useCallback(() => {
    // Mark as intentional to prevent auto-reconnect in onclose
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

  // Effect to manage connection based on auth state and user identity
  useEffect(() => {
    // Wait for auth check to complete before doing anything
    if (!sessionChecked) {
      return;
    }
    
    const userEmail = actualUser?.email;
    const isStaff = actualUser?.role === 'staff' || actualUser?.role === 'admin';
    
    // If user is not a staff member or has no email, clean up any existing connection
    if (!userEmail || !isStaff) {
      if (activeConnectionUserRef.current || wsRef.current) {
        console.log('[StaffWebSocket] User logged out or no longer staff, cleaning up');
        cleanup();
      }
      // Reset intentional disconnect when user logs out so new login can connect
      intentionalDisconnectRef.current = false;
      return;
    }
    
    // If we already have an active connection for this user, skip
    if (activeConnectionUserRef.current === userEmail) {
      return;
    }
    
    // If we have a connection for a different user, clean it up first
    if (activeConnectionUserRef.current && activeConnectionUserRef.current !== userEmail) {
      console.log('[StaffWebSocket] User changed from', activeConnectionUserRef.current, 'to', userEmail);
      cleanup();
    }
    
    // If there's already a socket connecting/connected, skip
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }
    
    // If we're already connecting, skip
    if (isConnectingRef.current) {
      return;
    }

    console.log('[StaffWebSocket] Auth ready and staff user detected, connecting:', userEmail);
    // Reset intentional disconnect flag for new connection attempt
    intentionalDisconnectRef.current = false;
    
    // Connect after a brief delay to ensure session cookies are fully ready
    initTimerRef.current = setTimeout(() => {
      connect();
    }, 300);
    
    // No cleanup return - we handle cleanup explicitly when user identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionChecked, actualUser?.email, actualUser?.role, sessionVersion]);
  
  // Separate effect for component unmount cleanup only
  useEffect(() => {
    return () => {
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isConnected,
    lastEvent
  };
}

export default useStaffWebSocket;
