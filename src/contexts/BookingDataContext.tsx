import React, { createContext, useState, useContext, ReactNode, useCallback, useMemo } from 'react';
import type { Booking } from '../types/data';
import { INITIAL_BOOKINGS } from '../data/defaults';

interface BookingDataContextType {
  bookings: Booking[];
  addBooking: (booking: Booking) => void;
  deleteBooking: (id: string) => void;
}

const BookingDataContext = createContext<BookingDataContextType | undefined>(undefined);

export const BookingDataProvider: React.FC<{children: ReactNode}> = ({ children }) => {
  const [bookings, setBookings] = useState<Booking[]>(INITIAL_BOOKINGS);

  const addBooking = useCallback((booking: Booking) => setBookings(prev => [booking, ...prev]), []);
  const deleteBooking = useCallback((id: string) => setBookings(prev => prev.filter(b => b.id !== id)), []);

  const contextValue = useMemo(() => ({
    bookings, addBooking, deleteBooking
  }), [bookings, addBooking, deleteBooking]);

  return (
    <BookingDataContext.Provider value={contextValue}>
      {children}
    </BookingDataContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useBookingData = () => {
  const context = useContext(BookingDataContext);
  if (!context) {
    throw new Error('useBookingData must be used within a BookingDataProvider');
  }
  return context;
};
