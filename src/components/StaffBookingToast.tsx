import { useEffect, useCallback, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { useToast } from './Toast';
import { playSound } from '../utils/sounds';

interface BookingEventData {
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

function formatTime12Hour(timeStr: string): string {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes.toString().padStart(2, '0')} ${ampm}`;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = minutes / 60;
  if (hours === Math.floor(hours)) {
    return `${hours} hr${hours > 1 ? 's' : ''}`;
  }
  return `${hours.toFixed(1)} hrs`;
}

function formatBookingToastMessage(event: BookingEventData): string {
  const name = event.memberName || event.memberEmail?.split('@')[0] || 'Member';
  const time = formatTime12Hour(event.startTime);
  const bay = event.resourceName || 'Bay';
  const duration = event.durationMinutes ? formatDuration(event.durationMinutes) : '';
  const playerCount = event.playerCount && event.playerCount > 1 ? ` (${event.playerCount} players)` : '';
  
  if (duration) {
    return `${name}${playerCount} requested ${bay} at ${time} for ${duration}`;
  }
  return `${name}${playerCount} requested ${bay} at ${time}`;
}

export function StaffBookingToast() {
  const { actualUser } = useData();
  const { showToast } = useToast();
  const [isInitialized, setIsInitialized] = useState(false);

  const isStaff = actualUser?.role === 'staff' || actualUser?.role === 'admin';

  const handleBookingEvent = useCallback((e: CustomEvent<BookingEventData>) => {
    if (!isInitialized) return;
    
    const event = e.detail;
    
    if (event.eventType === 'booking_created' && event.actionBy === 'member') {
      const message = formatBookingToastMessage(event);
      showToast(message, 'info', 8000);
      playSound('newBookingRequest');
    }
  }, [isInitialized, showToast]);

  useEffect(() => {
    if (!isStaff) return;
    
    const timer = setTimeout(() => {
      setIsInitialized(true);
    }, 2000);

    return () => clearTimeout(timer);
  }, [isStaff]);

  useEffect(() => {
    if (!isStaff || !isInitialized) return;

    const handler = (e: Event) => handleBookingEvent(e as CustomEvent<BookingEventData>);
    window.addEventListener('booking-update', handler);
    
    return () => {
      window.removeEventListener('booking-update', handler);
    };
  }, [isStaff, isInitialized, handleBookingEvent]);

  return null;
}

export default StaffBookingToast;
