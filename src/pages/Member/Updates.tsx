import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useData, Announcement } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import SwipeablePage from '../../components/SwipeablePage';
import { MotionList, MotionListItem } from '../../components/motion';
import { getTodayPacific, formatDateDisplayWithDay, formatDateTimePacific, addDaysToPacificDate } from '../../utils/dateUtils';
import { getMemberNoticeTitle, getAffectedAreasList, isBlockingClosure } from '../../utils/closureUtils';
import { useNotificationStore } from '../../stores/notificationStore';

const NOTICE_PREVIEW_DAYS = 7; // Show notices this many days before they start

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

const getNoticeDisplayType = (closure: Closure): 'closure' | 'notice' => {
  if (isBlockingClosure(closure.affectedAreas)) {
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

interface NotificationItem {
  id: number;
  type: string;
  title: string;
  message: string;
  created_at: string;
  read: boolean;
  action_url?: string;
}

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
  const [activeTab, setActiveTab] = useState<'announcements' | 'notices' | 'activity'>(
    tabParam === 'announcements' ? 'announcements' : (tabParam === 'notices' || tabParam === 'closures') ? 'notices' : 'activity'
  );
  
  const [closures, setClosures] = useState<Closure[]>([]);
  const [closuresLoading, setClosuresLoading] = useState(true);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!isLoading && !closuresLoading && !notificationsLoading) {
      setPageReady(true);
    }
  }, [isLoading, closuresLoading, notificationsLoading, setPageReady]);

  const fetchNotifications = useCallback(async () => {
    if (!user?.email) {
      setNotificationsLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/notifications?user_email=${encodeURIComponent(user.email)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        // Map is_read from API to read for frontend consistency
        const mapped = data.map((n: Record<string, unknown>) => ({ ...n, read: n.is_read ?? n.read ?? false }));
        setNotifications(mapped);
        const newUnreadCount = mapped.filter((n: NotificationItem) => !n.read).length;
        setUnreadCount(newUnreadCount);
        useNotificationStore.getState().setUnreadCount(newUnreadCount);
      }
    } catch (err: unknown) {
      console.error('Failed to fetch notifications:', err);
    } finally {
      setNotificationsLoading(false);
    }
  }, [user?.email]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

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
            // Members see notices up to 7 days before they start
            const previewCutoffDate = addDaysToPacificDate(todayStr, NOTICE_PREVIEW_DAYS);
            if (c.startDate > previewCutoffDate) return false;
            // Only show notices that affect booking availability
            const hasAffectedResources = c.affectedAreas && c.affectedAreas !== 'none';
            return hasAffectedResources || c.notifyMembers === true;
          })
          .sort((a: Closure, b: Closure) => a.startDate.localeCompare(b.startDate));
        setClosures(activeClosures);
      }
    } catch (err: unknown) {
      console.error('Failed to fetch closures:', err);
    } finally {
      setClosuresLoading(false);
    }
  }, [isStaffOrAdmin, isViewingAsMember]);

  useEffect(() => {
    fetchClosures();
  }, [fetchClosures]);

  useEffect(() => {
    const handleAppRefresh = () => {
      fetchNotifications();
      fetchClosures();
    };
    window.addEventListener('app-refresh', handleAppRefresh);
    return () => window.removeEventListener('app-refresh', handleAppRefresh);
  }, [fetchNotifications, fetchClosures]);

  useEffect(() => {
    if (tabParam === 'announcements') {
      setActiveTab('announcements');
    } else if (tabParam === 'notices' || tabParam === 'closures') {
      setActiveTab('notices');
    } else if (tabParam === 'activity') {
      setActiveTab('activity');
    }
  }, [tabParam]);

  const handleTabChange = (tab: 'announcements' | 'notices' | 'activity') => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  const markNotificationRead = async (notificationId: number) => {
    try {
      await fetch(`/api/notifications/${notificationId}/read`, { 
        method: 'POST',
        credentials: 'include' 
      });
      setNotifications(prev => prev.map(n => n.id === notificationId ? { ...n, read: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
      useNotificationStore.getState().markAsRead(notificationId);
      window.dispatchEvent(new CustomEvent('notifications-read'));
    } catch (err: unknown) {
      console.error('Failed to mark notification read:', err);
    }
  };

  const markAllRead = async () => {
    if (!user?.email) return;
    try {
      await fetch(`/api/notifications/mark-all-read`, { 
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include' 
      });
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
      useNotificationStore.getState().markAllAsRead();
      window.dispatchEvent(new CustomEvent('notifications-read'));
    } catch (err: unknown) {
      console.error('Failed to mark all notifications read:', err);
    }
  };

  const dismissAll = async () => {
    if (!user?.email) return;
    const snapshot = [...notifications];
    const prevUnread = unreadCount;

    setNotifications([]);
    setUnreadCount(0);
    useNotificationStore.getState().setUnreadCount(0);

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
        useNotificationStore.getState().setUnreadCount(prevUnread);
      }
    } catch (err) {
      console.error('Failed to dismiss all notifications:', err);
      setNotifications(snapshot);
      setUnreadCount(prevUnread);
      useNotificationStore.getState().setUnreadCount(prevUnread);
    }
  };

  const handleAnnouncementClick = (item: Announcement) => {
    if (item.linkType) {
      switch (item.linkType) {
        case 'events':
          navigate('/events');
          break;
        case 'wellness':
          navigate('/wellness');
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
            <div key={i} className={`p-5 rounded-xl animate-pulse ${isDark ? 'bg-white/[0.03]' : 'bg-white'}`}>
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
                className={`rounded-xl transition-all duration-fast overflow-hidden ${priorityCardClass}`}
              >
                <div 
                  className={`p-5 ${hasLongDesc || hasLink ? 'cursor-pointer' : ''}`}
                  {...(hasLongDesc || hasLink ? {
                    role: 'button',
                    tabIndex: 0,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (hasLink) {
                          handleAnnouncementClick(item);
                        } else if (hasLongDesc) {
                          setExpandedId(isExpanded ? null : item.id);
                        }
                      }
                    }
                  } : {})}
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

  const renderNoticesTab = () => {
    const todayStr = getTodayPacific();
    // Separate active (happening now) from upcoming
    const activeNotices = closures.filter(c => c.startDate <= todayStr);
    const upcomingNotices = closures.filter(c => c.startDate > todayStr);
    
    return (
    <div className="relative z-10 pb-32">
      {closuresLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={`p-5 rounded-xl animate-pulse ${isDark ? 'bg-white/[0.03]' : 'bg-white'}`}>
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
        <div className="space-y-6">
          {/* Active Now Section */}
          {activeNotices.length > 0 && (
            <div>
              <h3 className={`text-[11px] font-semibold uppercase tracking-[0.2em] mb-3 flex items-center gap-2 ${isDark ? 'text-white/50' : 'text-gray-500'}`} style={{ fontFamily: 'var(--font-label)' }}>
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                Active Now
              </h3>
              <MotionList className="space-y-4">
                {activeNotices.map((closure) => (
                  <NoticeCard key={`active-${closure.id}`} closure={closure} isDark={isDark} isUpcoming={false} />
                ))}
              </MotionList>
            </div>
          )}
          
          {/* Upcoming Section */}
          {upcomingNotices.length > 0 && (
            <div>
              <h3 className={`text-[11px] font-semibold uppercase tracking-[0.2em] mb-3 flex items-center gap-2 ${isDark ? 'text-white/50' : 'text-gray-500'}`} style={{ fontFamily: 'var(--font-label)' }}>
                <span className="material-symbols-outlined text-sm">schedule</span>
                Coming Up
              </h3>
              <MotionList className="space-y-4">
                {upcomingNotices.map((closure) => (
                  <NoticeCard key={`upcoming-${closure.id}`} closure={closure} isDark={isDark} isUpcoming={true} />
                ))}
              </MotionList>
            </div>
          )}
        </div>
      )}
    </div>
  )};
  
  // NoticeCard component for rendering individual notices
  const NoticeCard = ({ closure, isDark, isUpcoming }: { closure: Closure; isDark: boolean; isUpcoming: boolean }) => {
    const displayType = getNoticeDisplayType(closure);
    const isClosure = displayType === 'closure';
    const areasList = getAffectedAreasList(closure.affectedAreas);
    const hasAffectedAreas = areasList.length > 0;
    
    return (
      <MotionListItem 
        className={`rounded-xl transition-all duration-fast overflow-hidden ${
          isUpcoming
            ? isDark ? 'bg-blue-500/10 shadow-layered-dark' : 'bg-blue-50 shadow-layered'
            : isClosure
              ? isDark ? 'bg-red-500/10 shadow-layered-dark' : 'bg-red-50 shadow-layered'
              : isDark ? 'bg-amber-500/10 shadow-layered-dark' : 'bg-amber-50 shadow-layered'
        }`}
      >
        <div className="p-5">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
              isUpcoming
                ? isDark ? 'bg-blue-500/20' : 'bg-blue-100'
                : isClosure
                  ? isDark ? 'bg-red-500/20' : 'bg-red-100'
                  : isDark ? 'bg-amber-500/20' : 'bg-amber-100'
            }`}>
              <span className={`material-symbols-outlined text-xl ${
                isUpcoming
                  ? isDark ? 'text-blue-400' : 'text-blue-600'
                  : isClosure
                    ? isDark ? 'text-red-400' : 'text-red-600'
                    : isDark ? 'text-amber-400' : 'text-amber-600'
              }`}>{isUpcoming ? 'event_upcoming' : isClosure ? 'block' : 'notifications'}</span>
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-bold uppercase tracking-wider ${
                  isUpcoming
                    ? isDark ? 'text-blue-400' : 'text-blue-600'
                    : isClosure
                      ? isDark ? 'text-red-400' : 'text-red-600'
                      : isDark ? 'text-amber-400' : 'text-amber-600'
                }`}>
                  {isUpcoming ? 'Upcoming' : isClosure ? 'Closure' : 'Notice'}
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
                  {isUpcoming ? 'Areas affected' : 'Closed areas'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {areasList.map((area, idx) => (
                    <span 
                      key={idx} 
                      className={`text-xs px-2 py-1 rounded-lg ${
                        isUpcoming
                          ? isDark ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-100 text-blue-700'
                          : isClosure
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
  };

  const getNotificationIcon = (type: string): string => {
    switch (type) {
      case 'booking_approved': return 'check_circle';
      case 'booking_declined': return 'cancel';
      case 'booking_cancelled': return 'event_busy';
      case 'booking_reminder': return 'schedule';
      case 'check_in': return 'location_on';
      case 'no_show': return 'person_off';
      case 'payment': return 'payments';
      case 'refund': return 'receipt_long';
      case 'fee_charged': return 'attach_money';
      case 'roster_update': return 'group';
      case 'trackman': return 'sports_golf';
      default: return 'notifications';
    }
  };

  const getNotificationColor = (type: string, isDark: boolean): string => {
    switch (type) {
      case 'booking_approved':
      case 'check_in':
        return isDark ? 'text-green-400' : 'text-green-600';
      case 'booking_declined':
      case 'no_show':
      case 'booking_cancelled':
        return isDark ? 'text-red-400' : 'text-red-600';
      case 'payment':
      case 'fee_charged':
      case 'refund':
        return isDark ? 'text-blue-400' : 'text-blue-600';
      default:
        return isDark ? 'text-accent' : 'text-primary';
    }
  };

  const renderActivityTab = () => (
    <div className="relative z-10 pb-32">
      {notificationsLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`p-4 rounded-xl animate-pulse ${isDark ? 'bg-white/[0.03]' : 'bg-white'}`}>
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
                <div className="flex-1">
                  <div className={`h-4 w-3/4 rounded mb-2 ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
                  <div className={`h-3 w-1/2 rounded ${isDark ? 'bg-white/5' : 'bg-gray-100'}`} />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : notifications.length === 0 ? (
        <div className={`text-center py-16 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
          <span className="material-symbols-outlined text-6xl mb-4 block opacity-30">notifications_none</span>
          <p className="text-lg font-medium">No activity yet</p>
          <p className="text-sm mt-1 opacity-70">Booking updates and alerts will appear here.</p>
        </div>
      ) : (
        <>
          {notifications.length > 0 && (
            <div className="flex justify-end gap-2 mb-4">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className={`tactile-btn text-xs font-medium px-3 py-2 rounded-lg transition-colors ${
                    isDark ? 'bg-white/10 text-white/80 hover:bg-white/15' : 'bg-primary/10 text-primary/80 hover:bg-primary/15'
                  }`}
                >
                  Mark all as read
                </button>
              )}
              <button
                onClick={dismissAll}
                className={`tactile-btn text-xs font-medium px-3 py-2 rounded-lg transition-colors ${
                  isDark ? 'text-red-400/70 hover:text-red-400 bg-red-500/10 hover:bg-red-500/15' : 'text-red-600/70 hover:text-red-600 bg-red-500/5 hover:bg-red-500/10'
                }`}
              >
                Dismiss all
              </button>
            </div>
          )}
          <MotionList className="space-y-3">
            {notifications.map((notification) => (
              <MotionListItem
                key={notification.id}
                className={`rounded-xl transition-all duration-fast overflow-hidden cursor-pointer ${
                  notification.read
                    ? isDark ? 'bg-white/[0.02] shadow-layered-dark' : 'bg-white/70 shadow-layered'
                    : isDark ? 'bg-white/[0.05] shadow-layered-dark' : 'bg-white shadow-layered'
                }`}
                onClick={() => {
                  if (!notification.read) markNotificationRead(notification.id);
                  if (notification.action_url) navigate(notification.action_url);
                }}
              >
                <div className="p-4 flex gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                    isDark ? 'bg-white/10' : 'bg-primary/5'
                  }`}>
                    <span className={`material-symbols-outlined text-xl ${getNotificationColor(notification.type, isDark)}`}>
                      {getNotificationIcon(notification.type)}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className={`font-semibold text-sm leading-snug ${isDark ? 'text-white' : 'text-gray-900'} ${!notification.read ? 'font-bold' : ''}`}>
                        {notification.title}
                      </h4>
                      {!notification.read && (
                        <span className="w-2 h-2 rounded-full bg-accent shrink-0 mt-1.5" />
                      )}
                    </div>
                    <p className={`text-sm mt-0.5 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                      {notification.message}
                    </p>
                    <p className={`text-xs mt-2 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                      {formatDateTimePacific(notification.created_at)}
                    </p>
                  </div>
                </div>
              </MotionListItem>
            ))}
          </MotionList>
        </>
      )}
    </div>
  );

  return (
    <SwipeablePage className="px-6 relative overflow-hidden">
      <section className="mb-4 pt-4 md:pt-2">
        <h1 className={`text-3xl sm:text-4xl md:text-5xl leading-none drop-shadow-md ${isDark ? 'text-white' : 'text-primary'}`} style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.03em' }}>Updates</h1>
        <p className={`text-sm font-medium mt-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Stay in the loop with what's happening.</p>
      </section>

      <div className="flex gap-1.5 mb-6">
        <button
          onClick={() => handleTabChange('activity')}
          className={`flex-1 py-3 px-2 rounded-xl text-[11px] font-bold uppercase tracking-tight transition-all duration-fast relative ${
            activeTab === 'activity'
              ? 'bg-accent text-primary'
              : isDark ? 'bg-white/5 text-white/80 hover:bg-white/10' : 'bg-primary/5 text-primary/80 hover:bg-primary/10'
          }`}
        >
          Activity
          {unreadCount > 0 && activeTab !== 'activity' && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-accent text-primary text-[10px] font-bold rounded-full flex items-center justify-center">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
        <button
          onClick={() => handleTabChange('announcements')}
          className={`flex-1 py-3 px-2 rounded-xl text-[11px] font-bold uppercase tracking-tight transition-all duration-fast ${
            activeTab === 'announcements'
              ? 'bg-accent text-primary'
              : isDark ? 'bg-white/5 text-white/80 hover:bg-white/10' : 'bg-primary/5 text-primary/80 hover:bg-primary/10'
          }`}
        >
          Announcements
        </button>
        <button
          onClick={() => handleTabChange('notices')}
          className={`flex-1 py-3 px-2 rounded-xl text-[11px] font-bold uppercase tracking-tight transition-all duration-fast relative ${
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

      <div key={activeTab} className="animate-content-enter">
        {activeTab === 'announcements' ? renderAnnouncementsTab() : activeTab === 'notices' ? renderNoticesTab() : renderActivityTab()}
      </div>
    </SwipeablePage>
  );
};

export default MemberUpdates;
