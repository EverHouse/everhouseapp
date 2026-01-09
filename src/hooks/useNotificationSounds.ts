import { useRef, useCallback, useEffect } from 'react';
import { playSound, sounds } from '../utils/sounds';

type SoundType = keyof typeof sounds;

interface Notification {
  id: number;
  type: string;
  is_read?: boolean;
}

const STAFF_SOUND_MAP: Record<string, SoundType> = {
  'booking': 'newBookingRequest',
  'booking_request': 'newBookingRequest',
  'event_rsvp': 'newBookingRequest',
  'wellness_enrollment': 'newBookingRequest',
  'booking_cancelled': 'bookingCancelled',
  'event_rsvp_cancelled': 'bookingCancelled',
  'wellness_cancellation': 'bookingCancelled',
};

const MEMBER_SOUND_MAP: Record<string, SoundType> = {
  'booking_approved': 'bookingApproved',
  'booking_confirmed': 'bookingApproved',
  'event_rsvp': 'bookingApproved',
  'wellness_booking': 'bookingApproved',
  'booking_declined': 'bookingDeclined',
  'booking_cancelled': 'bookingCancelled',
};

export function useNotificationSounds(isStaff: boolean = false, userKey?: string) {
  const seenIdsRef = useRef<Set<number>>(new Set());
  const initialLoadDoneRef = useRef(false);
  const lastUserKeyRef = useRef<string | undefined>(undefined);

  const soundMap = isStaff ? STAFF_SOUND_MAP : MEMBER_SOUND_MAP;

  useEffect(() => {
    if (lastUserKeyRef.current !== userKey) {
      seenIdsRef.current.clear();
      initialLoadDoneRef.current = false;
      lastUserKeyRef.current = userKey;
    }
  }, [userKey]);

  useEffect(() => {
    return () => {
      seenIdsRef.current.clear();
      initialLoadDoneRef.current = false;
    };
  }, []);

  const processNotifications = useCallback((notifications: Notification[]) => {
    if (!initialLoadDoneRef.current) {
      notifications.forEach(n => seenIdsRef.current.add(n.id));
      initialLoadDoneRef.current = true;
      return;
    }

    const unreadNotifications = notifications.filter(n => !n.is_read);
    
    const newNotifications = unreadNotifications.filter(n => !seenIdsRef.current.has(n.id));
    
    if (newNotifications.length > 0) {
      const soundToPlay = newNotifications.reduce<SoundType | null>((acc, n) => {
        const mapped = soundMap[n.type];
        if (mapped) {
          if (!acc) return mapped;
          if (mapped === 'bookingDeclined' || mapped === 'bookingCancelled') return mapped;
        }
        return acc;
      }, null);

      if (soundToPlay) {
        playSound(soundToPlay);
      } else {
        playSound('notification');
      }
    }

    notifications.forEach(n => seenIdsRef.current.add(n.id));
  }, [soundMap]);

  const reset = useCallback(() => {
    seenIdsRef.current.clear();
    initialLoadDoneRef.current = false;
  }, []);

  return { processNotifications, reset };
}
