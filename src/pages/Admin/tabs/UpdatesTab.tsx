import React, { useState, useEffect, useCallback } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../../../contexts/DataContext';
import { usePageReady } from '../../../contexts/PageReadyContext';
import { formatDateTimePacific, formatRelativeTime } from '../../../utils/dateUtils';
import { useNotificationSounds } from '../../../hooks/useNotificationSounds';
import FloatingActionButton from '../../../components/FloatingActionButton';
import AnnouncementManager from '../../../components/admin/AnnouncementManager';
import { AnimatedPage } from '../../../components/motion';

interface StaffNotification {
    id: number;
    user_email: string;
    type: string;
    title: string;
    message: string;
    data?: Record<string, unknown>;
    is_read: boolean;
    created_at: string;
}

const UpdatesTab: React.FC = () => {
    const navigate = useNavigate();
    const { setPageReady } = usePageReady();
    const { actualUser } = useData();
    const [notificationsRef] = useAutoAnimate();
    const [activeSubTab, setActiveSubTab] = useState<'alerts' | 'announcements'>('alerts');
    const [notifications, setNotifications] = useState<StaffNotification[]>([]);
    const [notificationsLoading, setNotificationsLoading] = useState(true);
    const [unreadCount, setUnreadCount] = useState(0);
    const [triggerCreateAnnouncement, setTriggerCreateAnnouncement] = useState(0);
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
        } catch (err: unknown) {
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

    const getStaffNotificationRoute = (notif: StaffNotification): string | null => {
        const routeMap: Record<string, string> = {
            booking: '/admin/bookings',
            booking_request: '/admin/bookings',
            booking_approved: '/admin/bookings',
            booking_declined: '/admin/bookings',
            booking_cancelled: '/admin/bookings',
            booking_reminder: '/admin/bookings',
            booking_update: '/admin/bookings',
            booking_pending: '/admin/bookings',
            trackman_booking: '/admin/bookings',
            trackman_unmatched: '/admin/trackman',
            event: '/admin/calendar',
            event_rsvp: '/admin/calendar',
            event_rsvp_cancelled: '/admin/calendar',
            event_reminder: '/admin/calendar',
            wellness: '/admin/calendar',
            wellness_booking: '/admin/calendar',
            wellness_enrollment: '/admin/calendar',
            wellness_cancellation: '/admin/calendar',
            wellness_reminder: '/admin/calendar',
            tour_scheduled: '/admin/tours',
            tour_reminder: '/admin/tours',
            tour: '/admin/tours',
            payment_success: '/admin/financials',
            payment_failed: '/admin/financials',
            payment_receipt: '/admin/financials',
            outstanding_balance: '/admin/financials',
            fee_waived: '/admin/financials',
            membership_renewed: '/admin/directory',
            membership_failed: '/admin/financials',
            membership_past_due: '/admin/financials',
            membership_cancelled: '/admin/directory',
            membership_terminated: '/admin/directory',
            new_member: '/admin/directory',
            member_status_change: '/admin/directory',
            card_expiring: '/admin/financials',
            day_pass: '/admin/bookings',
            guest_pass: '/admin/bookings',
            system: '/admin/data-integrity',
            closure: '/admin/notices',
        };
        return routeMap[notif.type] || null;
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
            } catch (err: unknown) {
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
        } catch (err: unknown) {
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
        } catch (err: unknown) {
            console.error('Failed to dismiss all notifications:', err);
            setNotifications(snapshot);
            setUnreadCount(prevUnread);
        }
    };

    const renderAlertsTab = () => (
        <div className="animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
            {notifications.length > 0 && (
                <div className="flex justify-end gap-2 mb-4">
                    {unreadCount > 0 && (
                        <button 
                            onClick={markAllAsRead}
                            className="tactile-btn text-xs font-medium px-3 py-1.5 rounded-lg transition-colors text-primary/70 hover:text-primary bg-primary/5 hover:bg-primary/10 dark:text-white/70 dark:hover:text-white dark:bg-white/5 dark:hover:bg-white/10"
                        >
                            Mark all as read
                        </button>
                    )}
                    <button 
                        onClick={dismissAll}
                        className="tactile-btn text-xs font-medium px-3 py-1.5 rounded-lg transition-colors text-red-600/70 hover:text-red-600 bg-red-500/5 hover:bg-red-500/10 dark:text-red-400/70 dark:hover:text-red-400"
                    >
                        Dismiss all
                    </button>
                </div>
            )}
            
            <div ref={notificationsRef} className="space-y-3">
            {notificationsLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="p-4 rounded-xl animate-pulse bg-white dark:bg-white/[0.03]">
                        <div className="flex gap-3">
                            <div className="w-10 h-10 rounded-lg bg-gray-200 dark:bg-white/10" />
                            <div className="flex-1">
                                <div className="h-4 w-1/2 rounded mb-2 bg-gray-200 dark:bg-white/10" />
                                <div className="h-3 w-3/4 rounded bg-gray-100 dark:bg-white/5" />
                            </div>
                        </div>
                    </div>
                ))
            ) : notifications.length === 0 ? (
                <div className="text-center py-16 text-primary/70 dark:text-white/70">
                    <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 block opacity-30">notifications_off</span>
                    <p className="text-lg font-medium">No new alerts</p>
                    <p className="text-sm mt-1 opacity-70">New tours, booking requests, and system alerts will appear here.</p>
                </div>
            ) : (
                notifications.map((notif, index) => (
                        <div
                            key={notif.id}
                            onClick={() => handleNotificationClick(notif)}
                            className={`tactile-row rounded-xl transition-colors cursor-pointer overflow-hidden animate-pop-in ${
                                notif.is_read 
                                    ? 'bg-white hover:bg-gray-50 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]' 
                                    : 'bg-accent/10 hover:bg-accent/15 border border-accent/30 dark:border-accent/20'
                            } shadow-layered dark:shadow-layered-dark`}
                            style={{ '--stagger-index': index } as React.CSSProperties}
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
                                            {notif.created_at ? formatRelativeTime(notif.created_at) : 'Just now'}
                                        </span>
                                    </div>
                                    <p className={`text-xs mt-0.5 ${notif.is_read ? 'text-primary/70 dark:text-white/70' : 'text-primary/70 dark:text-white/70'}`}>
                                        {notif.message}
                                    </p>
                                </div>
                            </div>
                        </div>
                    ))
            )}
            </div>
        </div>
    );

    const handleCreateAnnouncement = () => {
        setActiveSubTab('announcements');
        setTriggerCreateAnnouncement(prev => prev + 1);
    };

    return (
            <AnimatedPage className="pb-32">
                <div className="flex gap-1.5 sm:gap-2 mb-6 animate-content-enter-delay-1">
                    <button
                        onClick={() => setActiveSubTab('alerts')}
                        className={`tactile-btn flex-1 py-3 px-2 sm:px-4 rounded-xl text-xs sm:text-sm font-bold uppercase tracking-wide transition-all duration-fast relative ${
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
                        onClick={() => setActiveSubTab('announcements')}
                        className={`tactile-btn flex-1 py-3 px-2 sm:px-4 rounded-xl text-xs sm:text-sm font-bold uppercase tracking-wide transition-all duration-fast ${
                            activeSubTab === 'announcements'
                                ? 'bg-[#CCB8E4] text-[#293515]'
                                : 'bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10'
                        }`}
                    >
                        Announce
                    </button>
                </div>

                {activeSubTab === 'alerts' && renderAlertsTab()}
                {activeSubTab === 'announcements' && <AnnouncementManager triggerCreate={triggerCreateAnnouncement} />}
                <FloatingActionButton onClick={handleCreateAnnouncement} color="purple" label="Add announcement" extended text="Add Announcement" />
            </AnimatedPage>
    );
};

export default UpdatesTab;
