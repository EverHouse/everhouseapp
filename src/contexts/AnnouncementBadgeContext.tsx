import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useData, Announcement } from './DataContext';
import { getTodayPacific } from '../utils/dateUtils';

interface DismissedNotice {
  noticeType: 'announcement' | 'closure';
  noticeId: number;
}

interface AnnouncementBadgeContextType {
  unseenHighPriority: Announcement[];
  hasUnseenAnnouncements: boolean;
  markAsSeen: (announcementIds: string[]) => void;
  markSingleAsSeen: (announcementId: string) => void;
  markAllAsSeen: () => void;
}

const AnnouncementBadgeContext = createContext<AnnouncementBadgeContextType>({
  unseenHighPriority: [],
  hasUnseenAnnouncements: false,
  markAsSeen: () => {},
  markSingleAsSeen: () => {},
  markAllAsSeen: () => {},
});

export const useAnnouncementBadge = () => useContext(AnnouncementBadgeContext);

const getStorageKey = (email: string) => `eh_seen_announcements_${email}`;

const isActiveAnnouncement = (item: Announcement): boolean => {
  const todayStr = getTodayPacific();
  
  if (item.startDate && item.startDate > todayStr) return false;
  if (item.endDate && item.endDate < todayStr) return false;
  
  return true;
};

export const AnnouncementBadgeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, announcements } = useData();
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    if (!user?.email) return;

    const loadDismissedNotices = async () => {
      try {
        const response = await fetch('/api/notices/dismissed', {
          credentials: 'include'
        });
        
        if (response.ok) {
          const dismissed: DismissedNotice[] = await response.json();
          const dismissedAnnouncementIds = dismissed
            .filter(d => d.noticeType === 'announcement')
            .map(d => d.noticeId.toString());
          setSeenIds(new Set(dismissedAnnouncementIds));
          localStorage.setItem(getStorageKey(user.email), JSON.stringify(dismissedAnnouncementIds));
        } else {
          const stored = localStorage.getItem(getStorageKey(user.email));
          if (stored) {
            try {
              const parsed = JSON.parse(stored);
              setSeenIds(new Set(parsed));
            } catch {
              setSeenIds(new Set());
            }
          }
        }
      } catch {
        const stored = localStorage.getItem(getStorageKey(user.email));
        if (stored) {
          try {
            const parsed = JSON.parse(stored);
            setSeenIds(new Set(parsed));
          } catch {
            setSeenIds(new Set());
          }
        }
      } finally {
        setIsInitialized(true);
      }
    };

    loadDismissedNotices();
  }, [user?.email]);

  const unseenHighPriority = useMemo(() => {
    if (!isInitialized) return [];
    return announcements.filter(a => 
      isActiveAnnouncement(a) && 
      !seenIds.has(a.id)
    );
  }, [announcements, seenIds, isInitialized]);

  const hasUnseenAnnouncements = unseenHighPriority.length > 0;

  const dismissToServer = useCallback(async (noticeType: string, noticeId: string) => {
    try {
      await fetch('/api/notices/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ noticeType, noticeId })
      });
    } catch {
    }
  }, []);

  const markSingleAsSeen = useCallback((announcementId: string) => {
    if (!user?.email) return;
    setSeenIds(prev => {
      const newSet = new Set(prev);
      newSet.add(announcementId);
      localStorage.setItem(getStorageKey(user.email), JSON.stringify([...newSet]));
      return newSet;
    });
    dismissToServer('announcement', announcementId);
  }, [user?.email, dismissToServer]);

  const markAsSeen = useCallback((announcementIds: string[]) => {
    if (!user?.email) return;
    setSeenIds(prev => {
      const newSet = new Set(prev);
      announcementIds.forEach(id => newSet.add(id));
      localStorage.setItem(getStorageKey(user.email), JSON.stringify([...newSet]));
      return newSet;
    });
    announcementIds.forEach(id => dismissToServer('announcement', id));
  }, [user?.email, dismissToServer]);

  const markAllAsSeen = useCallback(() => {
    if (!user?.email) return;
    const allActiveIds = announcements
      .filter(a => isActiveAnnouncement(a))
      .map(a => a.id);
    markAsSeen(allActiveIds);
  }, [user?.email, announcements, markAsSeen]);

  return (
    <AnnouncementBadgeContext.Provider value={{ unseenHighPriority, hasUnseenAnnouncements, markAsSeen, markSingleAsSeen, markAllAsSeen }}>
      {children}
    </AnnouncementBadgeContext.Provider>
  );
};
