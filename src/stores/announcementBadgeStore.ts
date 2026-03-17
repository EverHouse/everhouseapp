import { create } from 'zustand';
import { useEffect, useMemo } from 'react';
import { useAuthData, useAnnouncementData } from '../contexts/DataContext';
import type { Announcement } from '../types/data';
import { getTodayPacific } from '../utils/dateUtils';
import { fetchWithCredentials, postWithCredentials } from '../hooks/queries/useFetch';

interface DismissedNotice {
  noticeType: 'announcement' | 'closure';
  noticeId: number;
}

const getStorageKey = (email: string) => `eh_seen_announcements_${email}`;

const isActiveAnnouncement = (item: Announcement): boolean => {
  const todayStr = getTodayPacific();
  if (item.startDate && item.startDate > todayStr) return false;
  if (item.endDate && item.endDate < todayStr) return false;
  return true;
};

interface AnnouncementBadgeState {
  seenIds: Set<string>;
  isInitialized: boolean;
  _currentEmail: string | null;

  loadDismissedNotices: (userEmail: string) => Promise<void>;
  markAsSeen: (userEmail: string, announcementIds: string[]) => void;
  markSingleAsSeen: (userEmail: string, announcementId: string) => void;
  reset: () => void;
}

export const useAnnouncementBadgeStore = create<AnnouncementBadgeState>((set, get) => ({
  seenIds: new Set(),
  isInitialized: false,
  _currentEmail: null,

  loadDismissedNotices: async (userEmail: string) => {
    if (get()._currentEmail === userEmail && get().isInitialized) return;
    set({ _currentEmail: userEmail, isInitialized: false });

    try {
      const dismissed = await fetchWithCredentials<DismissedNotice[]>('/api/notices/dismissed');
      const dismissedAnnouncementIds = dismissed
        .filter(d => d.noticeType === 'announcement')
        .map(d => d.noticeId.toString());
      set({ seenIds: new Set(dismissedAnnouncementIds), isInitialized: true });
      localStorage.setItem(getStorageKey(userEmail), JSON.stringify(dismissedAnnouncementIds));
    } catch {
      const stored = localStorage.getItem(getStorageKey(userEmail));
      if (stored) {
        try {
          set({ seenIds: new Set(JSON.parse(stored)), isInitialized: true });
        } catch {
          set({ seenIds: new Set(), isInitialized: true });
        }
      } else {
        set({ seenIds: new Set(), isInitialized: true });
      }
    }
  },

  markAsSeen: (userEmail, announcementIds) => {
    if (!userEmail) return;
    set((state) => {
      const newSet = new Set(state.seenIds);
      announcementIds.forEach(id => newSet.add(id));
      localStorage.setItem(getStorageKey(userEmail), JSON.stringify([...newSet]));
      return { seenIds: newSet };
    });
    announcementIds.forEach(id => {
      postWithCredentials('/api/notices/dismiss', { noticeType: 'announcement', noticeId: id }).catch(() => {});
    });
  },

  markSingleAsSeen: (userEmail, announcementId) => {
    get().markAsSeen(userEmail, [announcementId]);
  },

  reset: () => set({ seenIds: new Set(), isInitialized: false, _currentEmail: null }),
}));

export const useAnnouncementBadge = () => {
  const { user } = useAuthData();
  const { announcements } = useAnnouncementData();
  const seenIds = useAnnouncementBadgeStore((s) => s.seenIds);
  const isInitialized = useAnnouncementBadgeStore((s) => s.isInitialized);
  const loadDismissedNotices = useAnnouncementBadgeStore((s) => s.loadDismissedNotices);
  const storeMarkAsSeen = useAnnouncementBadgeStore((s) => s.markAsSeen);
  const storeMarkSingleAsSeen = useAnnouncementBadgeStore((s) => s.markSingleAsSeen);

  useEffect(() => {
    if (user?.email) {
      loadDismissedNotices(user.email);
    }
  }, [user?.email, loadDismissedNotices]);

  const unseenHighPriority = useMemo(() => {
    if (!isInitialized) return [];
    return announcements.filter(a =>
      isActiveAnnouncement(a) &&
      !seenIds.has(a.id)
    );
  }, [announcements, seenIds, isInitialized]);

  const hasUnseenAnnouncements = unseenHighPriority.length > 0;

  const markAsSeen = useMemo(() => (announcementIds: string[]) => {
    if (user?.email) storeMarkAsSeen(user.email, announcementIds);
  }, [user?.email, storeMarkAsSeen]);

  const markSingleAsSeen = useMemo(() => (announcementId: string) => {
    if (user?.email) storeMarkSingleAsSeen(user.email, announcementId);
  }, [user?.email, storeMarkSingleAsSeen]);

  const markAllAsSeen = useMemo(() => () => {
    if (!user?.email) return;
    const allActiveIds = announcements
      .filter(a => isActiveAnnouncement(a))
      .map(a => a.id);
    storeMarkAsSeen(user.email, allActiveIds);
  }, [user?.email, announcements, storeMarkAsSeen]);

  return { unseenHighPriority, hasUnseenAnnouncements, markAsSeen, markSingleAsSeen, markAllAsSeen };
};
