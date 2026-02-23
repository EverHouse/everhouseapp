import React, { createContext, useState, useContext, ReactNode, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuthData } from './AuthDataContext';
import type { Announcement } from '../types/data';
import { INITIAL_ANNOUNCEMENTS } from '../data/defaults';

interface AnnouncementDataContextType {
  announcements: Announcement[];
  announcementsLoaded: boolean;
  addAnnouncement: (ann: Announcement) => Promise<void>;
  updateAnnouncement: (ann: Announcement) => Promise<void>;
  deleteAnnouncement: (id: string) => Promise<void>;
  refreshAnnouncements: () => Promise<void>;
}

const AnnouncementDataContext = createContext<AnnouncementDataContextType | undefined>(undefined);

export const AnnouncementDataProvider: React.FC<{children: ReactNode}> = ({ children }) => {
  const { sessionChecked, actualUser } = useAuthData();
  const actualUserRef = useRef(actualUser);
  useEffect(() => { actualUserRef.current = actualUser; }, [actualUser]);

  const [announcements, setAnnouncements] = useState<Announcement[]>(INITIAL_ANNOUNCEMENTS);
  const [announcementsLoaded, setAnnouncementsLoaded] = useState(false);
  const announcementsFetchedRef = useRef(false);

  const refreshAnnouncements = useCallback(async () => {
    try {
      const res = await fetch('/api/announcements?active_only=true');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setAnnouncements(data);
        }
      }
    } catch (err: unknown) {
      console.error('Failed to fetch announcements:', err);
    }
  }, []);

  useEffect(() => {
    if (!sessionChecked || announcementsFetchedRef.current) return;
    announcementsFetchedRef.current = true;
    const fetchAnnouncements = async () => {
      try {
        const res = await fetch('/api/announcements?active_only=true');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setAnnouncements(data);
          }
        }
      } catch (err: unknown) {
        if (actualUserRef.current) {
          console.error('Failed to fetch announcements:', err);
        }
      } finally {
        setAnnouncementsLoaded(true);
      }
    };
    fetchAnnouncements();
  }, [sessionChecked]);

  useEffect(() => {
    const handleAppRefresh = () => { refreshAnnouncements(); };
    window.addEventListener('app-refresh', handleAppRefresh);
    return () => window.removeEventListener('app-refresh', handleAppRefresh);
  }, [refreshAnnouncements]);

  useEffect(() => {
    const handleAnnouncementUpdate = () => { refreshAnnouncements(); };
    window.addEventListener('announcement-update', handleAnnouncementUpdate);
    return () => { window.removeEventListener('announcement-update', handleAnnouncementUpdate); };
  }, [refreshAnnouncements]);

  const addAnnouncement = useCallback(async (item: Announcement) => {
    try {
      const res = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: item.title,
          description: item.desc,
          type: item.type,
          priority: item.priority || 'normal',
          startDate: item.startDate || null,
          endDate: item.endDate || null,
          linkType: item.linkType || null,
          linkTarget: item.linkTarget || null,
          notifyMembers: item.notifyMembers || false
        })
      });
      if (res.ok) {
        const newItem = await res.json();
        setAnnouncements(prev => [newItem, ...prev]);
      }
    } catch (err: unknown) {
      console.error('Failed to add announcement:', err);
    }
  }, []);

  const updateAnnouncement = useCallback(async (item: Announcement) => {
    setAnnouncements(prev => prev.map(a => a.id === item.id ? item : a));
    try {
      const res = await fetch(`/api/announcements/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: item.title,
          description: item.desc,
          type: item.type,
          priority: item.priority || 'normal',
          startDate: item.startDate || null,
          endDate: item.endDate || null,
          linkType: item.linkType || null,
          linkTarget: item.linkTarget || null,
          notifyMembers: item.notifyMembers || false
        })
      });
      if (res.ok) {
        const updated = await res.json();
        setAnnouncements(prev => prev.map(a => a.id === updated.id ? updated : a));
      } else {
        refreshAnnouncements();
      }
    } catch (err: unknown) {
      console.error('Failed to update announcement:', err);
      refreshAnnouncements();
    }
  }, [refreshAnnouncements]);

  const deleteAnnouncement = useCallback(async (id: string) => {
    setAnnouncements(prev => prev.filter(a => a.id !== id));
    try {
      const res = await fetch(`/api/announcements/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) refreshAnnouncements();
    } catch (err: unknown) {
      console.error('Failed to delete announcement:', err);
      refreshAnnouncements();
    }
  }, [refreshAnnouncements]);

  const contextValue = useMemo(() => ({
    announcements, announcementsLoaded, addAnnouncement, updateAnnouncement, deleteAnnouncement, refreshAnnouncements
  }), [announcements, announcementsLoaded, addAnnouncement, updateAnnouncement, deleteAnnouncement, refreshAnnouncements]);

  return (
    <AnnouncementDataContext.Provider value={contextValue}>
      {children}
    </AnnouncementDataContext.Provider>
  );
};

export const useAnnouncementData = () => {
  const context = useContext(AnnouncementDataContext);
  if (!context) {
    throw new Error('useAnnouncementData must be used within an AnnouncementDataProvider');
  }
  return context;
};
