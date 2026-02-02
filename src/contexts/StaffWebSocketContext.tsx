import React, { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { useStaffWebSocket, type BookingEvent } from '../hooks/useStaffWebSocket';
import { useData } from './DataContext';

type EventCallback = (event: BookingEvent) => void;

interface StaffWebSocketContextType {
  isConnected: boolean;
  lastEvent: BookingEvent | null;
  registerCallback: (id: string, callback: EventCallback) => void;
  unregisterCallback: (id: string) => void;
}

const StaffWebSocketContext = createContext<StaffWebSocketContextType | null>(null);

export const StaffWebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { actualUser, sessionChecked } = useData();
  const callbacksRef = useRef<Map<string, EventCallback>>(new Map());
  const [lastEventFromContext, setLastEventFromContext] = useState<BookingEvent | null>(null);

  const isStaff = actualUser?.role === 'staff' || actualUser?.role === 'admin';

  const handleBookingEvent = useCallback((event: BookingEvent) => {
    setLastEventFromContext(event);
    callbacksRef.current.forEach((callback) => {
      try {
        callback(event);
      } catch (err) {
        console.error('[StaffWebSocketContext] Error in callback:', err);
      }
    });
  }, []);

  const { isConnected, lastEvent } = useStaffWebSocket(
    sessionChecked && isStaff
      ? { onBookingEvent: handleBookingEvent, debounceMs: 500 }
      : {}
  );

  const registerCallback = useCallback((id: string, callback: EventCallback) => {
    callbacksRef.current.set(id, callback);
  }, []);

  const unregisterCallback = useCallback((id: string) => {
    callbacksRef.current.delete(id);
  }, []);

  const contextValue: StaffWebSocketContextType = {
    isConnected,
    lastEvent: lastEventFromContext || lastEvent,
    registerCallback,
    unregisterCallback,
  };

  return (
    <StaffWebSocketContext.Provider value={contextValue}>
      {children}
    </StaffWebSocketContext.Provider>
  );
};

export function useStaffWebSocketContext() {
  const context = useContext(StaffWebSocketContext);
  if (!context) {
    throw new Error('useStaffWebSocketContext must be used within a StaffWebSocketProvider');
  }
  return context;
}

export function useStaffWebSocketCallback(id: string, callback: EventCallback | undefined) {
  const { registerCallback, unregisterCallback } = useStaffWebSocketContext();

  useEffect(() => {
    if (callback) {
      registerCallback(id, callback);
    }
    return () => {
      unregisterCallback(id);
    };
  }, [id, callback, registerCallback, unregisterCallback]);
}
