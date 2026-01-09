import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useData, Announcement } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import SwipeablePage from '../../components/SwipeablePage';
import PullToRefresh from '../../components/PullToRefresh';
import { MotionList, MotionListItem } from '../../components/motion';
import { SwipeableListItem } from '../../components/SwipeableListItem';
import { getTodayPacific, formatDateDisplayWithDay, formatDateTimePacific, addDaysToPacificDate } from '../../utils/dateUtils';

interface UserNotification {
  id: number;
  user_email: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, any>;
  is_read: boolean;
  created_at: string;
}

interface Closure {
  id: number;
  title: string;
  reason: string | null;
  noticeType: string | null;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  affectedAreas: string;
  notifyMembers?: boolean;
  needsReview?: boolean;
}

const formatAffectedAreas = (areas: string): string => {
  if (areas === 'entire_facility') return 'Entire Facility';
  if (areas === 'all_bays') return 'All Simulator Bays';
  if (areas === 'none') return 'No booking restrictions';
  
  const areaList = areas.split(',').map(a => a.trim());
  const formatted = areaList.map(area => {
    if (area === 'entire_facility') return 'Entire Facility';
    if (area === 'all_bays') return 'All Simulator Bays';
    if (area === 'conference_room') return 'Conference Room';
    if (area === 'Conference Room') return 'Conference Room';
    if (area === 'none') return 'No booking restrictions';
    if (area.startsWith('bay_')) {
      const bayNum = area.replace('bay_', '');
      return `Bay ${bayNum}`;
    }
    return area;
  });
  return formatted.join(', ');
};

const getAffectedAreasList = (areas: string): string[] => {
  if (!areas || areas === 'none') return [];
  if (areas === 'entire_facility') return ['Entire Facility'];
  if (areas === 'all_bays') return ['All Simulator Bays'];
  
  return areas.split(',').map(a => a.trim()).map(area => {
    if (area === 'entire_facility') return 'Entire Facility';
    if (area === 'all_bays') return 'All Simulator Bays';
    if (area === 'conference_room') return 'Conference Room';
    if (area === 'Conference Room') return 'Conference Room';
    if (area === 'none') return '';
    if (area.startsWith('bay_')) {
      const bayNum = area.replace('bay_', '');
      return `Bay ${bayNum}`;
    }
    return area;
  }).filter(a => a);
};

const getMemberNoticeTitle = (closure: Closure): string => {
  if (closure.noticeType && closure.noticeType.trim() && closure.noticeType.toLowerCase() !== 'closure') {
    return closure.noticeType;
  }
  if (closure.reason && closure.reason.trim()) {
    return closure.reason;
  }
  return closure.affectedAreas && closure.affectedAreas !== 'none' 
    ? formatAffectedAreas(closure.affectedAreas) 
    : 'Notice';
};

const getNoticeDisplayText = (closure: Closure): string => {
  if (closure.noticeType && closure.noticeType.trim()) {
    return closure.noticeType;
  }
  if (closure.reason && closure.reason.trim()) {
    return closure.reason;
  }
  if (closure.affectedAreas) {
    return formatAffectedAreas(closure.affectedAreas);
  }
  return closure.title || 'Notice';
};

const formatTime12HourShort = (timeStr: string): string => {
  if (!timeStr) return '';
  const [hours, minutes] = timeStr.substring(0, 5).split(':').map(Number);
  const period = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 || 12;
  if (minutes === 0) {
    return `${hour12}${period}`;
  }
  return `${hour12}:${String(minutes).padStart(2, '0')}${period}`;
};

const formatClosureDateRange = (startDate: string, endDate: string, startTime: string | null, endTime: string | null): string => {
  const startFormatted = formatDateDisplayWithDay(startDate);
  const endFormatted = formatDateDisplayWithDay(endDate);
  
  const timeRange = startTime && endTime 
    ? ` (${formatTime12HourShort(startTime)} - ${formatTime12HourShort(endTime)})`
    : startTime 
      ? ` from ${formatTime12HourShort(startTime)}`
      : '';
  
  if (startDate === endDate) {
    return `${startFormatted}${timeRange}`;
  }
  return `${startFormatted} - ${endFormatted}${timeRange}`;
};

const isActualClosure = (affectedAreas: string): boolean => {
  if (!affectedAreas || affectedAreas === 'none') return false;
  return true;
};

const getNoticeDisplayType = (closure: Closure): 'closure' | 'notice' => {
  if (isActualClosure(closure.affectedAreas)) {
    return 'closure';
  }
  return 'notice';
};

const formatDate = (dateStr: string): string => {
  if (!dateStr || dateStr === 'Just now') return dateStr;
  if (dateStr.includes('T') || dateStr.includes('Z')) {
    return formatDateTimePacific(dateStr);
  }
  return formatDateDisplayWithDay(dateStr);
};

const isActiveAnnouncement = (item: Announcement): boolean => {
  const todayStr = getTodayPacific();
  
  if (item.startDate && item.startDate > todayStr) return false;
  if (item.endDate && item.endDate < todayStr) return false;
  
  return true;
};

const getNotificationRoute = (notif: UserNotification, isStaffOrAdmin: boolean): string | null => {
  // Booking notifications
  if (notif.type === 'booking_approved' || notif.type === 'booking_declined') {
    return '/book';
  }
  if (notif.type === 'booking' || notif.type === 'booking_request') {
    return isStaffOrAdmin ? '/admin?tab=simulator' : '/book';
  }
  if (notif.type === 'booking_cancelled' || notif.type === 'booking_reminder') {
    return isStaffOrAdmin ? '/admin?tab=simulator' : '/book';
  }
  
  // Event notifications
  if (notif.type === 'event_reminder' || notif.type === 'event_rsvp' || notif.type === 'event_rsvp_cancelled') {
    return isStaffOrAdmin ? '/admin?tab=events' : '/member-events';
  }
  
  // Tour notifications
  if (notif.type === 'tour_scheduled' || notif.type === 'tour_reminder') {
    return isStaffOrAdmin ? '/admin?tab=tours' : null;
  }
  
  // Wellness notifications
  if (notif.type === 'wellness_booking' || notif.type === 'wellness_enrollment' || 
      notif.type === 'wellness_cancellation' || notif.type === 'wellness_reminder') {
    return isStaffOrAdmin ? '/admin?tab=events&subtab=wellness' : '/member-wellness';
  }
  
  // Notice/Closure notifications
  if (notif.type === 'closure') {
    return isStaffOrAdmin ? '/admin?tab=blocks' : '/updates?tab=notices';
  }
  
  // Guest pass notifications
  if (notif.type === 'guest_pass') {
    return '/profile';
  }
  
  return null;
};

const MemberUpdates: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { announcements, isLoading, user, actualUser } = useData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const isDark = effectiveTheme === 'dark';
  const [expandedId, setExpandedId] = useState<string | null>(null);
  
  const isStaffOrAdmin = actualUser?.role === 'admin' || actualUser?.role === 'staff';
  // When "View As" mode is active (user differs from actualUser), show member perspective
  const isViewingAsMember = user?.email && actualUser?.email && user.email !== actualUser.email;
  
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<'activity' | 'announcements' | 'notices'>(
    tabParam === 'activity' ? 'activity' : (tabParam === 'notices' || tabParam === 'closures') ? 'notices' : 'announcements'
  );
  
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [closuresLoading, setClosuresLoading] = useState(true);

  useEffect(() => {
    if (!isLoading && !notificationsLoading && !closuresLoading) {
      setPageReady(true);
    }
  }, [isLoading, notificationsLoading, closuresLoading, setPageReady]);

  const fetchClosures = useCallback(async () => {
    try {
      const res = await fetch('/api/closures', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const todayStr = getTodayPacific();
        const activeClosures = data
          .filter((c: Closure) => c.endDate >= todayStr)
          .filter((c: Closure) => {
            // For members: only show notices where notifyMembers is true OR resources are affected
            // Staff/admin see all notices (unless in "View As" mode - then show member perspective)
            if (isStaffOrAdmin && !isViewingAsMember) return true;
            // Members never see draft notices (needsReview = true)
            if (c.needsReview) return false;
            // Members only see notices ON the day of the closure (startDate <= today)
            if (c.startDate > todayStr) return false;
            // Only show notices that affect booking availability
            const hasAffectedResources = c.affectedAreas && c.affectedAreas !== 'none';
            return hasAffectedResources || c.notifyMembers === true;
          })
          .sort((a: Closure, b: Closure) => a.startDate.localeCompare(b.startDate));
        setClosures(activeClosures);
      }
    } catch (err) {
      console.error('Failed to fetch closures:', err);
    } finally {
      setClosuresLoading(false);
    }
  }, [isStaffOrAdmin, isViewingAsMember]);

  useEffect(() => {
    fetchClosures();
  }, [fetchClosures]);

  useEffect(() => {
    if (tabParam === 'activity' || tabParam === 'announcements') {
      setActiveTab(tabParam);
    } else if (tabParam === 'notices' || tabParam === 'closures') {
      setActiveTab('notices');
    }
  }, [tabParam]);

  const handleTabChange = (tab: 'activity' | 'announcements' | 'notices') => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  const fetchNotifications = useCallback(async () => {
    if (!user?.email) return;
    try {
      const res = await fetch(`/api/notifications?user_email=${encodeURIComponent(user.email)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setNotifications(data);
        setUnreadCount(data.filter((n: UserNotification) => !n.is_read).length);
      }
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
    } finally {
      setNotificationsLoading(false);
    }
  }, [user?.email]);

  useEffect(() => {
    if (user?.email) {
      fetchNotifications();
      const interval = setInterval(fetchNotifications, 30000);
      return () => clearInterval(interval);
    }
  }, [user?.email, fetchNotifications]);

  const handleRefresh = useCallback(async () => {
    await Promise.all([fetchNotifications(), fetchClosures()]);
  }, [fetchNotifications, fetchClosures]);

  const handleNotificationClick = async (notif: UserNotification) => {
    if (!notif.is_read) {
      const snapshot = [...notifications];
      const prevUnread = unreadCount;
      
      setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, is_read: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
      
      try {
        const res = await fetch(`/api/notifications/${notif.id}/read`, { method: 'PUT', credentials: 'include' });
        if (res.ok) {
          window.dispatchEvent(new CustomEvent('notifications-read'));
        } else {
          setNotifications(snapshot);
          setUnreadCount(prevUnread);
        }
      } catch (err) {
        console.error('Failed to mark notification as read:', err);
        setNotifications(snapshot);
        setUnreadCount(prevUnread);
      }
    }
    
    const route = getNotificationRoute(notif, isStaffOrAdmin);
    if (route) {
      navigate(route);
    }
  };

  const markAllAsRead = async () => {
    if (!user?.email) return;
    
    const snapshot = [...notifications];
    const prevUnread = unreadCount;
    
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    setUnreadCount(0);
    
    try {
      const res = await fetch('/api/notifications/mark-all-read', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: user.email }),
      });
      if (res.ok) {
        window.dispatchEvent(new CustomEvent('notifications-read'));
      } else {
        setNotifications(snapshot);
        setUnreadCount(prevUnread);
      }
    } catch (err) {
      console.error('Failed to mark all as read:', err);
      setNotifications(snapshot);
      setUnreadCount(prevUnread);
    }
  };

  const dismissAll = async () => {
    if (!user?.email) return;
    
    const snapshot = [...notifications];
    const prevUnread = unreadCount;
    
    setNotifications([]);
    setUnreadCount(0);
    
    try {
      const res = await fetch('/api/notifications/dismiss-all', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: user.email }),
        credentials: 'include'
      });
      if (res.ok) {
        window.dispatchEvent(new CustomEvent('notifications-read'));
      } else {
        setNotifications(snapshot);
        setUnreadCount(prevUnread);
      }
    } catch (err) {
      console.error('Failed to dismiss all notifications:', err);
      setNotifications(snapshot);
      setUnreadCount(prevUnread);
    }
  };

  const handleAnnouncementClick = (item: Announcement) => {
    if (item.linkType) {
      switch (item.linkType) {
        case 'events':
          navigate('/member-events');
          break;
        case 'wellness':
          navigate('/member-wellness');
          break;
        case 'golf':
          navigate('/book');
          break;
        case 'external':
          if (item.linkTarget) {
            window.open(item.linkTarget, '_blank', 'noopener,noreferrer');
          }
          break;
      }
    }
  };

  const activeAnnouncements = useMemo(() => {
    return announcements.filter(isActiveAnnouncement);
  }, [announcements]);

  const getPriorityOrder = (priority?: string): number => {
    if (priority === 'urgent') return 1;
    if (priority === 'high') return 2;
    return 3;
  };

  const sortedAnnouncements = useMemo(() => {
    return [...activeAnnouncements].sort((a, b) => {
      const priorityDiff = getPriorityOrder(a.priority) - getPriorityOrder(b.priority);
      if (priorityDiff !== 0) return priorityDiff;
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });
  }, [activeAnnouncements]);

  const renderAnnouncementsTab = () => (
    <div className="relative z-10 pb-32">
      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`p-5 rounded-2xl animate-pulse ${isDark ? 'bg-white/[0.03]' : 'bg-white'}`}>
              <div className="flex items-center gap-2 mb-3">
                <div className={`w-2 h-2 rounded-full ${isDark ? 'bg-white/20' : 'bg-gray-200'}`} />
                <div className={`h-3 w-16 rounded ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
              </div>
              <div className={`h-5 w-3/4 rounded mb-2 ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
              <div className={`h-4 w-full rounded ${isDark ? 'bg-white/5' : 'bg-gray-100'}`} />
            </div>
          ))}
        </div>
      ) : sortedAnnouncements.length === 0 ? (
        <div className={`text-center py-16 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
          <span className="material-symbols-outlined text-6xl mb-4 block opacity-30">campaign</span>
          <p className="text-lg font-medium">No announcements right now</p>
          <p className="text-sm mt-1 opacity-70">Check back soon for the latest news.</p>
        </div>
      ) : (
        <MotionList className="space-y-4">
          {sortedAnnouncements.map((item) => {
            const isExpanded = expandedId === item.id;
            const hasLongDesc = item.desc && item.desc.length > 100;
            const hasLink = !!item.linkType;
            const linkLabel = item.linkType === 'events' ? 'View Events' 
              : item.linkType === 'wellness' ? 'View Wellness' 
              : item.linkType === 'golf' ? 'Book Now' 
              : item.linkType === 'external' ? 'Learn More' : '';
            
            const priorityCardClass = item.priority === 'urgent' 
              ? (isDark ? 'bg-red-500/10 shadow-layered-dark' : 'bg-red-50 shadow-layered')
              : item.priority === 'high'
                ? (isDark ? 'bg-amber-500/10 shadow-layered-dark' : 'bg-amber-50 shadow-layered')
                : (isDark ? 'bg-white/[0.03] shadow-layered-dark' : 'bg-white shadow-layered');
            
            const priorityDotClass = item.priority === 'urgent'
              ? 'bg-red-500'
              : item.priority === 'high'
                ? 'bg-amber-400'
                : 'bg-accent';
            
            return (
              <MotionListItem 
                key={item.id}
                className={`rounded-2xl transition-all overflow-hidden ${priorityCardClass}`}
              >
                <div 
                  className={`p-5 ${hasLongDesc || hasLink ? 'cursor-pointer' : ''}`}
                  onClick={() => {
                    if (hasLink) {
                      handleAnnouncementClick(item);
                    } else if (hasLongDesc) {
                      setExpandedId(isExpanded ? null : item.id);
                    }
                  }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-2.5 h-2.5 rounded-full ${priorityDotClass}`} />
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                      {item.type}
                    </span>
                    <span className={`text-[10px] ${isDark ? 'text-white/30' : 'text-primary/30'}`}>•</span>
                    <span className={`text-[10px] ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                      {formatDate(item.startDate || item.date)}
                    </span>
                  </div>
                  
                  <h3 className={`text-lg font-bold mb-2 leading-snug ${isDark ? 'text-white' : 'text-primary'}`}>
                    {item.title}
                  </h3>
                  
                  {item.desc && (
                    <p className={`text-sm leading-relaxed ${isDark ? 'text-white/70' : 'text-primary/70'} ${!isExpanded && hasLongDesc ? 'line-clamp-2' : ''}`}>
                      {item.desc}
                    </p>
                  )}
                  
                  {hasLongDesc && !hasLink && (
                    <button className={`mt-3 text-xs font-bold uppercase tracking-wider flex items-center gap-1 ${isDark ? 'text-white/70 hover:text-white/70' : 'text-primary/70 hover:text-primary/70'}`}>
                      <span>{isExpanded ? 'Show less' : 'Read more'}</span>
                      <span className={`material-symbols-outlined text-sm transition-transform ${isExpanded ? 'rotate-180' : ''}`}>expand_more</span>
                    </button>
                  )}
                  
                  {item.endDate && (
                    <div className={`mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs ${isDark ? 'bg-white/5 text-white/70' : 'bg-primary/5 text-primary/70'}`}>
                      <span className="material-symbols-outlined text-[14px]">schedule</span>
                      <span>Until {formatDate(item.endDate)}</span>
                    </div>
                  )}
                  
                  {hasLink && (
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAnnouncementClick(item);
                      }}
                      className={`mt-3 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors ${
                        isDark 
                          ? 'bg-accent/20 text-accent hover:bg-accent/30' 
                          : 'bg-accent/10 text-primary hover:bg-accent/20'
                      }`}
                    >
                      <span>{linkLabel}</span>
                      <span className="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  )}
                </div>
              </MotionListItem>
            );
          })}
        </MotionList>
      )}
    </div>
  );

  const renderActivityTab = () => (
    <div className="relative z-10 pb-32">
      {notifications.length > 0 && (
        <div className="flex justify-end gap-2 mb-4">
          {unreadCount > 0 && (
            <button 
              onClick={markAllAsRead}
              className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
                isDark 
                  ? 'text-white/70 hover:text-white bg-white/5 hover:bg-white/10' 
                  : 'text-primary/70 hover:text-primary bg-primary/5 hover:bg-primary/10'
              }`}
            >
              Mark all as read
            </button>
          )}
          <button 
            onClick={dismissAll}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              isDark 
                ? 'text-red-400/70 hover:text-red-400 bg-red-500/10 hover:bg-red-500/20' 
                : 'text-red-600/70 hover:text-red-600 bg-red-500/5 hover:bg-red-500/10'
            }`}
          >
            Dismiss all
          </button>
        </div>
      )}
      
      {notificationsLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`p-4 rounded-2xl animate-pulse ${isDark ? 'bg-white/[0.03]' : 'bg-white'}`}>
              <div className="flex gap-3">
                <div className={`w-10 h-10 rounded-lg ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
                <div className="flex-1">
                  <div className={`h-4 w-1/2 rounded mb-2 ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
                  <div className={`h-3 w-3/4 rounded ${isDark ? 'bg-white/5' : 'bg-gray-100'}`} />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (() => {
        const fourteenDaysAgoStr = addDaysToPacificDate(getTodayPacific(), -14);
        const recentNotifications = notifications.filter(n => {
          if (!n.created_at) return false;
          const notifDate = n.created_at.split('T')[0];
          return notifDate >= fourteenDaysAgoStr;
        });
        
        return recentNotifications.length === 0 ? (
          <div className={`text-center py-16 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
            <span className="material-symbols-outlined text-6xl mb-4 block opacity-30">notifications_off</span>
            <p className="text-lg font-medium">No recent activity</p>
            <p className="text-sm mt-1 opacity-70">Your booking updates and alerts will appear here.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {recentNotifications.map((notif) => (
            <SwipeableListItem
              key={notif.id}
              leftActions={!notif.is_read ? [
                {
                  id: 'read',
                  icon: 'mark_email_read',
                  label: 'Read',
                  color: 'primary',
                  onClick: async () => {
                    try {
                      await fetch(`/api/notifications/${notif.id}/read`, {
                        method: 'PUT',
                        credentials: 'include'
                      });
                      setNotifications(prev => prev.map(n => 
                        n.id === notif.id ? { ...n, is_read: true } : n
                      ));
                      setUnreadCount(prev => Math.max(0, prev - 1));
                      window.dispatchEvent(new CustomEvent('notifications-read'));
                    } catch (err) {
                      console.error('Failed to mark as read:', err);
                    }
                  }
                }
              ] : []}
              rightActions={[
                {
                  id: 'dismiss',
                  icon: 'close',
                  label: 'Dismiss',
                  color: 'gray',
                  onClick: async () => {
                    try {
                      const wasUnread = !notif.is_read;
                      await fetch(`/api/notifications/${notif.id}`, {
                        method: 'DELETE',
                        credentials: 'include'
                      });
                      setNotifications(prev => prev.filter(n => n.id !== notif.id));
                      if (wasUnread) {
                        setUnreadCount(prev => Math.max(0, prev - 1));
                        window.dispatchEvent(new CustomEvent('notifications-read'));
                      }
                    } catch (err) {
                      console.error('Failed to dismiss notification:', err);
                    }
                  }
                }
              ]}
            >
              <div 
                onClick={() => handleNotificationClick(notif)}
                className={`rounded-2xl transition-all cursor-pointer overflow-hidden ${
                  notif.is_read 
                    ? isDark ? 'bg-white/[0.03] hover:bg-white/[0.06]' : 'bg-white hover:bg-gray-50'
                    : isDark ? 'bg-accent/10 hover:bg-accent/15 border border-accent/20' : 'bg-accent/10 hover:bg-accent/15 border border-accent/30'
                } ${isDark ? 'shadow-layered-dark' : 'shadow-layered'}`}
              >
                <div className="flex gap-3 p-4">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                    notif.type === 'booking_approved' ? 'bg-green-500/20' :
                    notif.type === 'booking_declined' ? 'bg-red-500/20' :
                    isDark ? 'bg-accent/20' : 'bg-accent/20'
                  }`}>
                    <span className={`material-symbols-outlined text-[20px] ${
                      notif.type === 'booking_approved' ? 'text-green-500' :
                      notif.type === 'booking_declined' ? 'text-red-500' :
                      isDark ? 'text-white' : 'text-primary'
                    }`}>
                      {notif.type === 'booking_approved' ? 'check_circle' :
                       notif.type === 'booking_declined' ? 'cancel' :
                       'notifications'}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start">
                      <h4 className={`font-bold text-sm ${notif.is_read ? (isDark ? 'text-white/70' : 'text-primary/70') : (isDark ? 'text-white' : 'text-primary')}`}>
                        {notif.title}
                      </h4>
                      <span className={`text-[10px] ml-2 shrink-0 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                        {notif.created_at ? formatDateTimePacific(notif.created_at) : 'Just now'}
                      </span>
                    </div>
                    <p className={`text-xs mt-0.5 ${notif.is_read ? (isDark ? 'text-white/70' : 'text-primary/70') : (isDark ? 'text-white/70' : 'text-primary/70')}`}>
                      {notif.message}
                    </p>
                  </div>
                </div>
              </div>
            </SwipeableListItem>
          ))}
          </div>
        );
      })()}
    </div>
  );

  const renderNoticesTab = () => (
    <div className="relative z-10 pb-32">
      {closuresLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={`p-5 rounded-2xl animate-pulse ${isDark ? 'bg-white/[0.03]' : 'bg-white'}`}>
              <div className="flex items-center gap-2 mb-3">
                <div className={`w-10 h-10 rounded-xl ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
                <div className="flex-1">
                  <div className={`h-3 w-16 rounded mb-2 ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
                  <div className={`h-5 w-3/4 rounded ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : closures.length === 0 ? (
        <div className={`text-center py-16 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
          <span className="material-symbols-outlined text-6xl mb-4 block opacity-30">event_available</span>
          <p className="text-lg font-medium">No upcoming notices</p>
          <p className="text-sm mt-1 opacity-70">The club is open as usual.</p>
        </div>
      ) : (
        <MotionList className="space-y-4">
          {closures.map((closure) => {
            const displayType = getNoticeDisplayType(closure);
            const isClosure = displayType === 'closure';
            const areasList = getAffectedAreasList(closure.affectedAreas);
            const hasAffectedAreas = areasList.length > 0;
            return (
              <MotionListItem 
                key={`closure-${closure.id}`}
                className={`rounded-2xl transition-all overflow-hidden ${
                  isClosure
                    ? isDark ? 'bg-red-500/10 shadow-layered-dark' : 'bg-red-50 shadow-layered'
                    : isDark ? 'bg-amber-500/10 shadow-layered-dark' : 'bg-amber-50 shadow-layered'
                }`}
              >
                <div className="p-5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                      isClosure
                        ? isDark ? 'bg-red-500/20' : 'bg-red-100'
                        : isDark ? 'bg-amber-500/20' : 'bg-amber-100'
                    }`}>
                      <span className={`material-symbols-outlined text-xl ${
                        isClosure
                          ? isDark ? 'text-red-400' : 'text-red-600'
                          : isDark ? 'text-amber-400' : 'text-amber-600'
                      }`}>{isClosure ? 'block' : 'notifications'}</span>
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${
                          isClosure
                            ? isDark ? 'text-red-400' : 'text-red-600'
                            : isDark ? 'text-amber-400' : 'text-amber-600'
                        }`}>
                          {isClosure ? 'Closure' : 'Notice'}
                        </span>
                      </div>
                      <h3 className={`text-lg font-bold leading-snug ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {getMemberNoticeTitle(closure)}
                      </h3>
                    </div>
                  </div>
                  <div className="ml-12 space-y-2">
                    <p className={`text-sm ${isDark ? 'text-white/80' : 'text-gray-500'}`}>
                      {formatClosureDateRange(closure.startDate, closure.endDate, closure.startTime, closure.endTime)}
                    </p>
                    {hasAffectedAreas ? (
                      <div>
                        <p className={`text-[10px] font-bold uppercase mb-1 ${isDark ? 'text-white/50' : 'text-gray-400'}`}>
                          Closed areas
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {areasList.map((area, idx) => (
                            <span 
                              key={idx} 
                              className={`text-xs px-2 py-1 rounded-lg ${
                                isClosure
                                  ? isDark ? 'bg-red-500/20 text-red-300' : 'bg-red-100 text-red-700'
                                  : isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700'
                              }`}
                            >
                              {area}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-400'}`}>
                        No booking restrictions
                      </p>
                    )}
                    {closure.reason && closure.reason.trim() && closure.noticeType && closure.noticeType.trim() && closure.noticeType.toLowerCase() !== 'closure' && (
                      <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                        {closure.reason}
                      </p>
                    )}
                  </div>
                </div>
              </MotionListItem>
            );
          })}
        </MotionList>
      )}
    </div>
  );

  return (
    <PullToRefresh onRefresh={handleRefresh}>
    <SwipeablePage className="px-6 relative overflow-hidden">
      <section className="mb-4 pt-4 md:pt-2">
        <h1 className={`text-3xl font-bold leading-tight drop-shadow-md ${isDark ? 'text-white' : 'text-primary'}`}>Updates</h1>
        <p className={`text-sm font-medium mt-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Stay in the loop with what's happening.</p>
      </section>

      <div className="flex gap-1.5 mb-6">
        <button
          onClick={() => handleTabChange('activity')}
          className={`flex-1 py-3 px-2 rounded-xl text-[11px] font-bold uppercase tracking-tight transition-all relative ${
            activeTab === 'activity'
              ? 'bg-accent text-primary'
              : isDark ? 'bg-white/5 text-white/80 hover:bg-white/10' : 'bg-primary/5 text-primary/80 hover:bg-primary/10'
          }`}
        >
          Activity
          {unreadCount > 0 && activeTab !== 'activity' && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
        <button
          onClick={() => handleTabChange('announcements')}
          className={`flex-1 py-3 px-2 rounded-xl text-[11px] font-bold uppercase tracking-tight transition-all ${
            activeTab === 'announcements'
              ? 'bg-[#CCB8E4] text-[#293515]'
              : isDark ? 'bg-white/5 text-white/80 hover:bg-white/10' : 'bg-primary/5 text-primary/80 hover:bg-primary/10'
          }`}
        >
          Announcements
        </button>
        <button
          onClick={() => handleTabChange('notices')}
          className={`flex-1 py-3 px-2 rounded-xl text-[11px] font-bold uppercase tracking-tight transition-all relative ${
            activeTab === 'notices'
              ? 'bg-amber-500 text-white'
              : isDark ? 'bg-white/5 text-white/80 hover:bg-white/10' : 'bg-primary/5 text-primary/80 hover:bg-primary/10'
          }`}
        >
          Notices
          {closures.length > 0 && activeTab !== 'notices' && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-amber-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {closures.length > 9 ? '9+' : closures.length}
            </span>
          )}
        </button>
      </div>

      {activeTab === 'activity' ? renderActivityTab() : activeTab === 'announcements' ? renderAnnouncementsTab() : renderNoticesTab()}
    </SwipeablePage>
    </PullToRefresh>
  );
};

export default MemberUpdates;
