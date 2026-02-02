import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiRequest } from '../lib/apiRequest';
import { useNotificationStore } from './notificationStore';

export interface UserProfile {
  id: string;
  name: string;
  tier: string;
  tags?: string[];
  isFounding?: boolean;
  status: 'Active' | 'Pending' | 'Expired' | 'Inactive' | 'Terminated' | 'former_member' | string;
  email: string;
  phone: string;
  joinDate?: string;
  avatar?: string;
  role?: 'member' | 'staff' | 'admin';
  mindbodyClientId?: string;
  lifetimeVisits?: number;
  lastBookingDate?: string;
}

export interface GuestPasses {
  passes_used: number;
  passes_total: number;
  passes_remaining: number;
}

export interface UserBooking {
  id: number;
  resource_name: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
}

interface UserState {
  user: UserProfile | null;
  guestPasses: GuestPasses | null;
  bookings: UserBooking[];
  isHydrated: boolean;
  
  setUser: (user: UserProfile | null) => void;
  clearUser: () => void;
  
  fetchGuestPasses: () => Promise<void>;
  fetchBookings: () => Promise<void>;
  fetchNotifications: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      user: null,
      guestPasses: null,
      bookings: [],
      isHydrated: false,

      setUser: (user) => {
        set({ user });
        if (user) {
          get().refreshAll();
        }
      },

      clearUser: () => {
        set({ 
          user: null, 
          guestPasses: null, 
          bookings: []
        });
        useNotificationStore.getState().setNotifications([]);
      },

      fetchGuestPasses: async () => {
        const { user } = get();
        if (!user?.email) return;
        
        try {
          const { ok, data, error } = await apiRequest<GuestPasses>(
            `/api/guest-passes/${encodeURIComponent(user.email)}?tier=${encodeURIComponent(user.tier || 'Social')}`
          );
          if (ok && data) {
            set({ guestPasses: data });
          }
          // Silently ignore auth/network errors - session may not be ready
        } catch {
          // Silently fail - prevents "Failed to fetch" console spam
        }
      },

      fetchBookings: async () => {
        const { user } = get();
        if (!user?.email) return;
        
        try {
          const { ok, data } = await apiRequest<UserBooking[]>(
            `/api/bookings?user_email=${encodeURIComponent(user.email)}`
          );
          if (ok && data) {
            set({ bookings: data });
          }
          // Silently ignore auth/network errors - session may not be ready
        } catch {
          // Silently fail - prevents "Failed to fetch" console spam
        }
      },

      fetchNotifications: async () => {
        const { user } = get();
        if (!user?.email) return;
        
        await useNotificationStore.getState().fetchUnreadCount(user.email);
      },

      refreshAll: async () => {
        const state = get();
        await Promise.all([
          state.fetchGuestPasses(),
          state.fetchBookings(),
          state.fetchNotifications()
        ]);
      }
    }),
    {
      name: 'eh_user_store',
      partialize: (state) => ({
        user: state.user,
        guestPasses: state.guestPasses
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.isHydrated = true;
          // NOTE: Do NOT call refreshAll here - the session may not be verified yet
          // DataContext will trigger refreshAll after session verification completes
          // This prevents "Failed to fetch" errors on initial page load
        }
      }
    }
  )
);
