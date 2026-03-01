import { useEffect, useCallback } from 'react';
import { useNotificationStore } from '../../../../stores/notificationStore';
import { useVisibilityAwareInterval } from '../../../../hooks/useVisibilityAwareInterval';

const POLL_INTERVAL = 120000;

interface UseUnreadNotificationsResult {
  unreadNotifCount: number;
  refreshUnreadCount: () => void;
}

export function useUnreadNotifications(userEmail: string | undefined): UseUnreadNotificationsResult {
  const unreadNotifCount = useNotificationStore(state => state.unreadCount);
  const fetchUnreadCount = useNotificationStore(state => state.fetchUnreadCount);

  const refreshUnreadCount = useCallback(() => {
    if (userEmail) {
      fetchUnreadCount(userEmail);
    }
  }, [userEmail, fetchUnreadCount]);

  useEffect(() => {
    if (!userEmail) return;
    
    fetchUnreadCount(userEmail);
    
    const handleNotificationsRead = () => fetchUnreadCount(userEmail);
    window.addEventListener('notifications-read', handleNotificationsRead);
    
    const handleMemberNotification = () => fetchUnreadCount(userEmail);
    window.addEventListener('member-notification', handleMemberNotification);
    
    const handleBookingUpdate = () => fetchUnreadCount(userEmail);
    window.addEventListener('booking-update', handleBookingUpdate);
    
    return () => {
      window.removeEventListener('notifications-read', handleNotificationsRead);
      window.removeEventListener('member-notification', handleMemberNotification);
      window.removeEventListener('booking-update', handleBookingUpdate);
    };
  }, [userEmail, fetchUnreadCount]);

  useVisibilityAwareInterval(refreshUnreadCount, POLL_INTERVAL, !!userEmail);

  return { unreadNotifCount, refreshUnreadCount };
}
