import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiRequest } from '../lib/apiRequest';
import { useNotificationStore } from './notificationStore';

export interface UserProfile {
  id: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  tier: string;
  tags?: string[];
  status: 'Active' | 'Pending' | 'Expired' | 'Inactive' | 'Terminated' | 'former_member' | string;
  email: string;
  phone: string;
  joinDate?: string;
  avatar?: string;
  role?: 'member' | 'staff' | 'admin' | 'visitor' | string;
  mindbodyClientId?: string;
  lifetimeVisits?: number;
  lastBookingDate?: string;
}

export interface GuestPasses {
  passes_used: number;
  passes_total: number;
  passes_remaining: number;
}

interface UserState {
  user: UserProfile | null;
  guestPasses: GuestPasses | null;
  isHydrated: boolean;
  
  setUser: (user: UserProfile | null) => void;
  clearUser: () => void;
  
  fetchGuestPasses: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      user: null,
      guestPasses: null,
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
          guestPasses: null
        });
        useNotificationStore.getState().setNotifications([]);
      },

      fetchGuestPasses: async () => {
        const { user } = get();
        if (!user?.email) return;
        
        try {
          if (user.role === 'visitor') {
            set({ guestPasses: null });
            return;
          }
          const { ok, data, error: _error } = await apiRequest<GuestPasses>(
            `/api/guest-passes/${encodeURIComponent(user.email)}?tier=${encodeURIComponent(user.tier || '')}`
          );
          if (ok && data) {
            set({ guestPasses: data });
          }
          // Silently ignore auth/network errors - session may not be ready
        } catch {
          // Silently fail - prevents "Failed to fetch" console spam
        }
      },

      refreshAll: async () => {
        const state = get();
        await state.fetchGuestPasses();
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
