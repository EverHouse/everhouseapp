import { useState, useEffect, useCallback } from 'react';

interface UseUnreadNotificationsResult {
  unreadNotifCount: number;
  refreshUnreadCount: () => void;
}

export function useUnreadNotifications(userEmail: string | undefined): UseUnreadNotificationsResult {
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);

  const fetchUnread = useCallback(async () => {
    if (!userEmail) return;
    try {
      const res = await fetch(`/api/notifications?user_email=${encodeURIComponent(userEmail)}&unread_only=true`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setUnreadNotifCount(data.length);
      }
    } catch (err) {
      console.error('Failed to fetch unread notifications:', err);
    }
  }, [userEmail]);

  useEffect(() => {
    if (!userEmail) return;
    
    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    
    const handleNotificationsRead = () => fetchUnread();
    window.addEventListener('notifications-read', handleNotificationsRead);
    
    const handleMemberNotification = () => fetchUnread();
    window.addEventListener('member-notification', handleMemberNotification);
    
    // Also refresh when booking updates come in (covers RSVPs, wellness, etc.)
    const handleBookingUpdate = () => fetchUnread();
    window.addEventListener('booking-update', handleBookingUpdate);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('notifications-read', handleNotificationsRead);
      window.removeEventListener('member-notification', handleMemberNotification);
      window.removeEventListener('booking-update', handleBookingUpdate);
    };
  }, [userEmail, fetchUnread]);

  return { unreadNotifCount, refreshUnreadCount: fetchUnread };
}
