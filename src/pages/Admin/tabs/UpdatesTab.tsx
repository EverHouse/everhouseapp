import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../../../contexts/DataContext';
import { usePageReady } from '../../../contexts/PageReadyContext';
import { formatDateTimePacific } from '../../../utils/dateUtils';
import { useNotificationSounds } from '../../../hooks/useNotificationSounds';
import FloatingActionButton from '../../../components/FloatingActionButton';
import PullToRefresh from '../../../components/PullToRefresh';
import AnnouncementManager from '../../../components/admin/AnnouncementManager';

interface StaffNotification {
    id: number;
    user_email: string;
    type: string;
    title: string;
    message: string;
    data?: Record<string, any>;
    is_read: boolean;
    created_at: string;
}

interface RecentActivityItem {
    id: string;
    type: 'booking_created' | 'booking_approved' | 'check_in' | 'cancellation' | 'tour' | 'notification';
    timestamp: string;
    primary_text: string;
    secondary_text: string;
    icon: string;
}

const UpdatesTab: React.FC = () => {
    const navigate = useNavigate();
    const { setPageReady } = usePageReady();
    const { actualUser } = useData();
    const [activeSubTab, setActiveSubTab] = useState<'alerts' | 'activity' | 'announcements'>('announcements');
    const [notifications, setNotifications] = useState<StaffNotification[]>([]);
    const [notificationsLoading, setNotificationsLoading] = useState(true);
    const [unreadCount, setUnreadCount] = useState(0);
    const [triggerCreateAnnouncement, setTriggerCreateAnnouncement] = useState(0);
    const [recentActivity, setRecentActivity] = useState<RecentActivityItem[]>([]);
    const [activityLoading, setActivityLoading] = useState(true);
    const { processNotifications } = useNotificationSounds(true, actualUser?.email);

    const fetchNotificationsRef = React.useRef<(() => Promise<void>) | null>(null);

    useEffect(() => {
        const handleBookingUpdate = () => {
            console.log('[UpdatesTab] Global booking-update event received');
            if (fetchNotificationsRef.current) {
                fetchNotificationsRef.current();
            }
        };
        window.addEventListener('booking-update', handleBookingUpdate);
        return () => window.removeEventListener('booking-update', handleBookingUpdate);
    }, []);

    useEffect(() => {
        if (!notificationsLoading) {
            setPageReady(true);
        }
    }, [notificationsLoading, setPageReady]);

    useEffect(() => {
        const handleOpenNewAnnouncement = () => {
            setActiveSubTab('announcements');
            setTriggerCreateAnnouncement(prev => prev + 1);
        };
        const handleSwitchToAlertsTab = () => {
            setActiveSubTab('alerts');
        };
        window.addEventListener('open-new-announcement', handleOpenNewAnnouncement);
        window.addEventListener('switch-to-alerts-tab', handleSwitchToAlertsTab);
        return () => {
            window.removeEventListener('open-new-announcement', handleOpenNewAnnouncement);
            window.removeEventListener('switch-to-alerts-tab', handleSwitchToAlertsTab);
        };
    }, []);

    const fetchRecentActivity = useCallback(async () => {
        try {
            const res = await fetch('/api/recent-activity', { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setRecentActivity(data);
            }
        } catch (err) {
            console.error('Failed to fetch recent activity:', err);
        } finally {
            setActivityLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchRecentActivity();
        const interval = setInterval(fetchRecentActivity, 30000);
        return () => clearInterval(interval);
    }, [fetchRecentActivity]);

    const fetchNotifications = useCallback(async () => {
        if (!actualUser?.email) return;
        try {
            const res = await fetch(`/api/notifications?user_email=${encodeURIComponent(actualUser.email)}`, { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setNotifications(data);
                setUnreadCount(data.filter((n: StaffNotification) => !n.is_read).length);
                processNotifications(data);
            }
        } catch (err) {
            console.error('Failed to fetch notifications:', err);
        } finally {
            setNotificationsLoading(false);
        }
    }, [actualUser?.email, processNotifications]);

    useEffect(() => {
        fetchNotificationsRef.current = fetchNotifications;
    }, [fetchNotifications]);

    useEffect(() => {
        if (actualUser?.email) {
            fetchNotifications();
            const interval = setInterval(fetchNotifications, 30000);
            return () => clearInterval(interval);
        }
    }, [actualUser?.email, fetchNotifications]);

    const handleRefresh = useCallback(async () => {
        await fetchNotifications();
    }, [fetchNotifications]);

    const getStaffNotificationRoute = (notif: StaffNotification): string | null => {
        if (notif.type === 'booking' || notif.type === 'booking_request' || 
            notif.type === 'booking_cancelled' || notif.type === 'booking_approved' ||
            notif.type === 'booking_declined') {
            return '/admin?tab=simulator';
        }
        if (notif.type === 'event_rsvp' || notif.type === 'event_rsvp_cancelled') {
            return '/admin?tab=events';
        }
        if (notif.type === 'tour_scheduled' || notif.type === 'tour_reminder') {
            return '/admin?tab=tours';
        }
        if (notif.type === 'wellness_booking' || notif.type === 'wellness_enrollment' || 
            notif.type === 'wellness_cancellation') {
            return '/admin?tab=events';
        }
        if (notif.type === 'closure') {
            return '/admin?tab=blocks';
        }
        return null;
    };

    const handleNotificationClick = async (notif: StaffNotification) => {
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
        
        const route = getStaffNotificationRoute(notif);
        if (route) {
            navigate(route);
        }
    };

    const markAllAsRead = async () => {
        if (!actualUser?.email) return;
        
        const snapshot = [...notifications];
        const prevUnread = unreadCount;
        
        setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
        setUnreadCount(0);
        
        try {
            const res = await fetch('/api/notifications/mark-all-read', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_email: actualUser.email }),
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
        if (!actualUser?.email) return;
        
        const snapshot = [...notifications];
        const prevUnread = unreadCount;
        
        setNotifications([]);
        setUnreadCount(0);
        
        try {
            const res = await fetch('/api/notifications/dismiss-all', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_email: actualUser.email }),
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

    const getActivityColor = (type: RecentActivityItem['type']): string => {
        switch (type) {
            case 'booking_created':
                return 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/30';
            case 'booking_approved':
                return 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30';
            case 'check_in':
                return 'text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/30';
            case 'cancellation':
                return 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30';
            case 'tour':
                return 'text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/30';
            case 'notification':
                return 'text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30';
            default:
                return 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-900/30';
        }
    };

    const renderActivityTab = () => (
        <div className="animate-pop-in" style={{animationDelay: '0.1s'}}>
            {activityLoading ? (
                <div className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="p-4 rounded-2xl animate-pulse bg-white dark:bg-white/[0.03]">
                            <div className="flex gap-3">
                                <div className="w-10 h-10 rounded-lg bg-gray-200 dark:bg-white/10" />
                                <div className="flex-1">
                                    <div className="h-4 w-1/2 rounded mb-2 bg-gray-200 dark:bg-white/10" />
                                    <div className="h-3 w-3/4 rounded bg-gray-100 dark:bg-white/5" />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            ) : recentActivity.length === 0 ? (
                <div className="text-center py-16 text-primary/70 dark:text-white/70">
                    <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 block opacity-30">history</span>
                    <p className="text-lg font-medium">No recent activity</p>
                    <p className="text-sm mt-1 opacity-70">Bookings, check-ins, and cancellations will appear here.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {recentActivity.map((activity, index) => (
                        <div
                            key={activity.id}
                            className="rounded-2xl transition-all bg-white hover:bg-gray-50 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] shadow-layered dark:shadow-layered-dark animate-pop-in"
                            style={{animationDelay: `${0.15 + index * 0.03}s`}}
                        >
                            <div className="flex gap-3 p-4">
                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${getActivityColor(activity.type)}`}>
                                    <span className="material-symbols-outlined text-[20px]">
                                        {activity.icon}
                                    </span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-start">
                                        <h4 className="font-bold text-sm text-primary dark:text-white">
                                            {activity.primary_text}
                                        </h4>
                                        <span className="text-[10px] ml-2 shrink-0 text-primary/70 dark:text-white/70">
                                            {activity.timestamp ? formatDateTimePacific(activity.timestamp) : 'Just now'}
                                        </span>
                                    </div>
                                    <p className="text-xs mt-0.5 text-primary/70 dark:text-white/70">
                                        {activity.secondary_text}
                                    </p>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    const renderAlertsTab = () => (
        <div className="animate-pop-in" style={{animationDelay: '0.1s'}}>
            {notifications.length > 0 && (
                <div className="flex justify-end gap-2 mb-4">
                    {unreadCount > 0 && (
                        <button 
                            onClick={markAllAsRead}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors text-primary/70 hover:text-primary bg-primary/5 hover:bg-primary/10 dark:text-white/70 dark:hover:text-white dark:bg-white/5 dark:hover:bg-white/10"
                        >
                            Mark all as read
                        </button>
                    )}
                    <button 
                        onClick={dismissAll}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors text-red-600/70 hover:text-red-600 bg-red-500/5 hover:bg-red-500/10 dark:text-red-400/70 dark:hover:text-red-400"
                    >
                        Dismiss all
                    </button>
                </div>
            )}
            
            {notificationsLoading ? (
                <div className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="p-4 rounded-2xl animate-pulse bg-white dark:bg-white/[0.03]">
                            <div className="flex gap-3">
                                <div className="w-10 h-10 rounded-lg bg-gray-200 dark:bg-white/10" />
                                <div className="flex-1">
                                    <div className="h-4 w-1/2 rounded mb-2 bg-gray-200 dark:bg-white/10" />
                                    <div className="h-3 w-3/4 rounded bg-gray-100 dark:bg-white/5" />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            ) : notifications.length === 0 ? (
                <div className="text-center py-16 text-primary/70 dark:text-white/70">
                    <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 block opacity-30">notifications_off</span>
                    <p className="text-lg font-medium">No new alerts</p>
                    <p className="text-sm mt-1 opacity-70">New tours, booking requests, and system alerts will appear here.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {notifications.map((notif, index) => (
                        <div
                            key={notif.id}
                            onClick={() => handleNotificationClick(notif)}
                            className={`rounded-2xl transition-all cursor-pointer overflow-hidden animate-pop-in ${
                                notif.is_read 
                                    ? 'bg-white hover:bg-gray-50 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]' 
                                    : 'bg-accent/10 hover:bg-accent/15 border border-accent/30 dark:border-accent/20'
                            } shadow-layered dark:shadow-layered-dark`}
                            style={{animationDelay: `${0.15 + index * 0.03}s`}}
                        >
                            <div className="flex gap-3 p-4">
                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                                    notif.type === 'booking_request' ? 'bg-blue-500/20' :
                                    notif.type === 'system_alert' ? 'bg-amber-500/20' :
                                    'bg-accent/20'
                                }`}>
                                    <span className={`material-symbols-outlined text-[20px] ${
                                        notif.type === 'booking_request' ? 'text-blue-500' :
                                        notif.type === 'system_alert' ? 'text-amber-500' :
                                        'text-primary dark:text-white'
                                    }`}>
                                        {notif.type === 'booking_request' ? 'event_note' :
                                         notif.type === 'system_alert' ? 'warning' :
                                         'notifications'}
                                    </span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-start">
                                        <h4 className={`font-bold text-sm ${notif.is_read ? 'text-primary/70 dark:text-white/70' : 'text-primary dark:text-white'}`}>
                                            {notif.title}
                                        </h4>
                                        <span className="text-[10px] ml-2 shrink-0 text-primary/70 dark:text-white/70">
                                            {notif.created_at ? formatDateTimePacific(notif.created_at) : 'Just now'}
                                        </span>
                                    </div>
                                    <p className={`text-xs mt-0.5 ${notif.is_read ? 'text-primary/70 dark:text-white/70' : 'text-primary/70 dark:text-white/70'}`}>
                                        {notif.message}
                                    </p>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    const handleCreateAnnouncement = () => {
        setActiveSubTab('announcements');
        setTriggerCreateAnnouncement(prev => prev + 1);
    };

    return (
        <PullToRefresh onRefresh={handleRefresh}>
            <div className="animate-pop-in pb-32">
                <div className="flex gap-1.5 sm:gap-2 mb-6 animate-pop-in" style={{animationDelay: '0.05s'}}>
                    <button
                        onClick={() => setActiveSubTab('alerts')}
                        className={`flex-1 py-3 px-2 sm:px-4 rounded-xl text-xs sm:text-sm font-bold uppercase tracking-wide transition-all relative ${
                            activeSubTab === 'alerts'
                                ? 'bg-accent text-primary'
                                : 'bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10'
                        }`}
                    >
                        Alerts
                        {unreadCount > 0 && activeSubTab !== 'alerts' && (
                            <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                                {unreadCount > 9 ? '9+' : unreadCount}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => setActiveSubTab('activity')}
                        className={`flex-1 py-3 px-2 sm:px-4 rounded-xl text-xs sm:text-sm font-bold uppercase tracking-wide transition-all ${
                            activeSubTab === 'activity'
                                ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                : 'bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10'
                        }`}
                    >
                        Activity
                    </button>
                    <button
                        onClick={() => setActiveSubTab('announcements')}
                        className={`flex-1 py-3 px-2 sm:px-4 rounded-xl text-xs sm:text-sm font-bold uppercase tracking-wide transition-all ${
                            activeSubTab === 'announcements'
                                ? 'bg-[#CCB8E4] text-[#293515]'
                                : 'bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10'
                        }`}
                    >
                        Announce
                    </button>
                </div>

                {activeSubTab === 'alerts' && renderAlertsTab()}
                {activeSubTab === 'activity' && renderActivityTab()}
                {activeSubTab === 'announcements' && <AnnouncementManager triggerCreate={triggerCreateAnnouncement} />}
                <FloatingActionButton onClick={handleCreateAnnouncement} color="purple" label="Add announcement" />
            </div>
        </PullToRefresh>
    );
};

export default UpdatesTab;
