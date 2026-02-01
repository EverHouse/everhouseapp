import { create } from 'zustand';

export interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
  link?: string;
}

interface NotificationState {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  lastFetched: number | null;
  
  setNotifications: (notifications: Notification[]) => void;
  addNotification: (notification: Notification) => void;
  markAsRead: (id: number) => void;
  markAllAsRead: () => void;
  setUnreadCount: (count: number) => void;
  incrementUnread: () => void;
  setLoading: (loading: boolean) => void;
  
  fetchNotifications: (userEmail: string) => Promise<void>;
  fetchUnreadCount: (userEmail: string) => Promise<void>;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  isLoading: false,
  lastFetched: null,
  
  setNotifications: (notifications) => {
    const unreadCount = notifications.filter(n => !n.is_read).length;
    set({ notifications, unreadCount, lastFetched: Date.now() });
  },
  
  addNotification: (notification) => {
    set(state => ({
      notifications: [notification, ...state.notifications],
      unreadCount: notification.is_read ? state.unreadCount : state.unreadCount + 1
    }));
  },
  
  markAsRead: (id) => {
    set(state => ({
      notifications: state.notifications.map(n => 
        n.id === id ? { ...n, is_read: true } : n
      ),
      unreadCount: Math.max(0, state.unreadCount - 1)
    }));
  },
  
  markAllAsRead: () => {
    set(state => ({
      notifications: state.notifications.map(n => ({ ...n, is_read: true })),
      unreadCount: 0
    }));
  },
  
  setUnreadCount: (count) => set({ unreadCount: count }),
  
  incrementUnread: () => set(state => ({ unreadCount: state.unreadCount + 1 })),
  
  setLoading: (loading) => set({ isLoading: loading }),
  
  fetchNotifications: async (userEmail: string) => {
    if (!userEmail) return;
    
    set({ isLoading: true });
    try {
      const res = await fetch(`/api/notifications?user_email=${encodeURIComponent(userEmail)}`, { 
        credentials: 'include' 
      });
      if (res.ok) {
        const data = await res.json();
        get().setNotifications(data);
      }
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
    } finally {
      set({ isLoading: false });
    }
  },
  
  fetchUnreadCount: async (userEmail: string) => {
    if (!userEmail) return;
    
    try {
      const res = await fetch(`/api/notifications?user_email=${encodeURIComponent(userEmail)}&unread_only=true`, { 
        credentials: 'include' 
      });
      if (res.ok) {
        const data = await res.json();
        set({ unreadCount: data.length });
      }
    } catch (err) {
      console.error('Failed to fetch unread count:', err);
    }
  }
}));
