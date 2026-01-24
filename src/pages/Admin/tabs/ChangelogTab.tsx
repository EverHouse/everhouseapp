import React, { useState, useEffect, useCallback } from 'react';
import { changelog } from '../../../data/changelog';
import { formatRelativeTime } from '../../../utils/dateUtils';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';
import PullToRefresh from '../../../components/PullToRefresh';
import { AnimatedPage } from '../../../components/motion';
import { useData } from '../../../contexts/DataContext';

interface AuditLogEntry {
    id: number;
    staffEmail: string;
    staffName: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    resourceName: string | null;
    details: Record<string, any> | null;
    ipAddress: string | null;
    createdAt: string;
}

const ACTION_LABELS: Record<string, { label: string; icon: string; color: string }> = {
    // Booking actions
    approve_booking: { label: 'Approved Booking', icon: 'check_circle', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    decline_booking: { label: 'Declined Booking', icon: 'cancel', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    cancel_booking: { label: 'Cancelled Booking', icon: 'event_busy', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    create_booking: { label: 'Created Booking', icon: 'event_available', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    reschedule_booking: { label: 'Rescheduled Booking', icon: 'update', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    mark_no_show: { label: 'Marked No-Show', icon: 'person_off', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    mark_attended: { label: 'Marked Attended', icon: 'how_to_reg', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    add_guest_to_booking: { label: 'Added Guest to Booking', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    remove_guest_from_booking: { label: 'Removed Guest', icon: 'person_remove', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    link_member_to_booking: { label: 'Linked Member to Booking', icon: 'link', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    unlink_member_from_booking: { label: 'Unlinked Member', icon: 'link_off', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    direct_add_participant: { label: 'Added Participant', icon: 'group_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    change_booking_owner: { label: 'Change Booking Owner', icon: 'swap_horiz', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    assign_member_to_booking: { label: 'Assigned Member to Booking', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    link_trackman_to_member: { label: 'Linked Trackman to Member', icon: 'link', color: 'text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900/30' },
    // Billing actions
    pause_subscription: { label: 'Paused Subscription', icon: 'pause_circle', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' },
    resume_subscription: { label: 'Resumed Subscription', icon: 'play_circle', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    cancel_subscription: { label: 'Cancelled Subscription', icon: 'cancel', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    record_charge: { label: 'Recorded Charge', icon: 'payments', color: 'text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/30' },
    process_refund: { label: 'Processed Refund', icon: 'currency_exchange', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    send_payment_link: { label: 'Sent Payment Link', icon: 'link', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    change_tier: { label: 'Changed Tier', icon: 'swap_vert', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    update_payment_status: { label: 'Updated Payment', icon: 'payment', color: 'text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/30' },
    // Member actions
    invite_member: { label: 'Invited Member', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    create_member: { label: 'Created Member', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    sync_hubspot: { label: 'Synced HubSpot', icon: 'sync', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    link_stripe_customer: { label: 'Linked Stripe Customer', icon: 'link', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    update_member_notes: { label: 'Updated Member Notes', icon: 'edit_note', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    view_member: { label: 'Viewed Member', icon: 'visibility', color: 'text-gray-500 bg-gray-100 dark:text-gray-400 dark:bg-gray-800/30' },
    view_member_profile: { label: 'Viewed Profile', icon: 'person', color: 'text-gray-500 bg-gray-100 dark:text-gray-400 dark:bg-gray-800/30' },
    view_member_billing: { label: 'Viewed Billing', icon: 'receipt', color: 'text-gray-500 bg-gray-100 dark:text-gray-400 dark:bg-gray-800/30' },
    export_member_data: { label: 'Exported Member Data', icon: 'download', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    update_member: { label: 'Updated Member', icon: 'edit', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    delete_member: { label: 'Deleted Member', icon: 'delete', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    archive_member: { label: 'Archived Member', icon: 'archive', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    // Tour actions
    tour_checkin: { label: 'Tour Check-In', icon: 'how_to_reg', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    tour_completed: { label: 'Tour Completed', icon: 'task_alt', color: 'text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/30' },
    tour_no_show: { label: 'Tour No-Show', icon: 'person_off', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    tour_cancelled: { label: 'Tour Cancelled', icon: 'event_busy', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    tour_status_changed: { label: 'Tour Status Changed', icon: 'swap_horiz', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    // Event actions
    create_event: { label: 'Created Event', icon: 'event', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    update_event: { label: 'Updated Event', icon: 'edit_calendar', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    delete_event: { label: 'Deleted Event', icon: 'event_busy', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    sync_events: { label: 'Synced Events', icon: 'sync', color: 'text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900/30' },
    manual_rsvp: { label: 'Added RSVP', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    remove_rsvp: { label: 'Removed RSVP', icon: 'person_remove', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    // Wellness actions
    create_wellness_class: { label: 'Created Wellness Class', icon: 'fitness_center', color: 'text-pink-600 bg-pink-100 dark:text-pink-400 dark:bg-pink-900/30' },
    update_wellness_class: { label: 'Updated Wellness Class', icon: 'edit', color: 'text-pink-600 bg-pink-100 dark:text-pink-400 dark:bg-pink-900/30' },
    delete_wellness_class: { label: 'Deleted Wellness Class', icon: 'delete', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    sync_wellness: { label: 'Synced Wellness', icon: 'sync', color: 'text-pink-600 bg-pink-100 dark:text-pink-400 dark:bg-pink-900/30' },
    manual_enrollment: { label: 'Enrolled Member', icon: 'group_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    // Announcement actions
    create_announcement: { label: 'Created Announcement', icon: 'campaign', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' },
    update_announcement: { label: 'Updated Announcement', icon: 'edit', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' },
    delete_announcement: { label: 'Deleted Announcement', icon: 'delete', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    // Closure actions
    create_closure: { label: 'Created Closure', icon: 'block', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    update_closure: { label: 'Updated Closure', icon: 'edit', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    delete_closure: { label: 'Deleted Closure', icon: 'delete', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    sync_closures: { label: 'Synced Closures', icon: 'sync', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    // Trackman/Import actions
    import_trackman: { label: 'Imported Trackman Data', icon: 'upload_file', color: 'text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900/30' },
    reassign_booking: { label: 'Reassigned Booking', icon: 'swap_horiz', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    unmatch_booking: { label: 'Unmatched Booking', icon: 'link_off', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    reset_trackman_data: { label: 'Reset Trackman Data', icon: 'restart_alt', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    // Group billing actions
    add_group_member: { label: 'Added Group Member', icon: 'group_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    remove_group_member: { label: 'Removed Group Member', icon: 'group_remove', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    link_group_subscription: { label: 'Linked Group Subscription', icon: 'link', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    // Waiver actions
    review_waiver: { label: 'Reviewed Waiver', icon: 'verified', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
};

const FILTER_CATEGORIES = [
    { key: 'all', label: 'All' },
    { key: 'bookings', label: 'Bookings', actions: ['approve_booking', 'decline_booking', 'cancel_booking', 'create_booking', 'reschedule_booking', 'mark_no_show', 'mark_attended', 'add_guest_to_booking', 'remove_guest_from_booking', 'link_member_to_booking', 'unlink_member_from_booking', 'direct_add_participant', 'reassign_booking', 'unmatch_booking', 'import_trackman', 'change_booking_owner', 'assign_member_to_booking', 'link_trackman_to_member'] },
    { key: 'billing', label: 'Billing', actions: ['pause_subscription', 'resume_subscription', 'cancel_subscription', 'record_charge', 'process_refund', 'send_payment_link', 'change_tier', 'update_payment_status', 'add_group_member', 'remove_group_member', 'link_group_subscription'] },
    { key: 'members', label: 'Members', actions: ['invite_member', 'create_member', 'update_member', 'delete_member', 'archive_member', 'sync_hubspot', 'link_stripe_customer', 'update_member_notes', 'review_waiver'] },
    { key: 'tours', label: 'Tours', actions: ['tour_checkin', 'tour_completed', 'tour_no_show', 'tour_cancelled', 'tour_status_changed'] },
    { key: 'events', label: 'Events', actions: ['create_event', 'update_event', 'delete_event', 'sync_events', 'manual_rsvp', 'remove_rsvp', 'create_wellness_class', 'update_wellness_class', 'delete_wellness_class', 'sync_wellness', 'manual_enrollment'] },
    { key: 'admin', label: 'Admin', actions: ['create_announcement', 'update_announcement', 'delete_announcement', 'create_closure', 'update_closure', 'delete_closure', 'sync_closures', 'reset_trackman_data'] },
];

const ChangelogTab: React.FC = () => {
    const { actualUser } = useData();
    const isAdmin = actualUser?.role === 'admin';
    const [activeTab, setActiveTab] = useState<'updates' | 'activity'>('updates');
    
    const [entries, setEntries] = useState<AuditLogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filterCategory, setFilterCategory] = useState('all');
    const [staffFilter, setStaffFilter] = useState('');
    const [uniqueStaff, setUniqueStaff] = useState<string[]>([]);
    const [limit, setLimit] = useState(50);
    const [hasMore, setHasMore] = useState(true);

    useEffect(() => {
        window.scrollTo(0, 0);
    }, []);

    const fetchActivityLog = useCallback(async (reset = false) => {
        if (!isAdmin) return;
        
        try {
            if (reset) {
                setLoading(true);
                setLimit(50);
            }
            
            const params = new URLSearchParams();
            params.set('limit', String(reset ? 50 : limit));
            
            if (staffFilter) {
                params.set('staff_email', staffFilter);
            }
            
            const category = FILTER_CATEGORIES.find(c => c.key === filterCategory);
            if (category && category.actions) {
                params.set('actions', category.actions.join(','));
            }
            
            const res = await fetch(`/api/data-tools/staff-activity?${params.toString()}`, { credentials: 'include' });
            if (!res.ok) throw new Error('Failed to fetch activity log');
            
            const data = await res.json();
            setEntries(data.logs || []);
            setHasMore(data.logs?.length >= (reset ? 50 : limit));
            
            const staffList = [...new Set(data.logs?.map((e: AuditLogEntry) => e.staffEmail) || [])].filter(Boolean) as string[];
            if (staffList.length > uniqueStaff.length) {
                setUniqueStaff(staffList);
            }
            
            setError(null);
        } catch (err: any) {
            setError(err.message || 'Failed to load activity log');
        } finally {
            setLoading(false);
        }
    }, [limit, staffFilter, filterCategory, uniqueStaff.length, isAdmin]);

    useEffect(() => {
        if (activeTab === 'activity' && isAdmin) {
            fetchActivityLog(true);
        }
    }, [activeTab, filterCategory, staffFilter, isAdmin]);

    useEffect(() => {
        if (limit > 50 && activeTab === 'activity') {
            fetchActivityLog();
        }
    }, [limit, fetchActivityLog, activeTab]);

    const handleRefresh = useCallback(async () => {
        if (activeTab === 'activity') {
            await fetchActivityLog(true);
        }
    }, [activeTab, fetchActivityLog]);

    const loadMore = () => {
        setLimit(prev => prev + 50);
    };

    const formatDate = (dateStr: string) => {
        const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
        const [year, month, day] = datePart.split('-').map(Number);
        const longMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return `${day} ${longMonths[month - 1]} ${year}`;
    };

    const getActionInfo = (action: string) => {
        return ACTION_LABELS[action] || { 
            label: action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), 
            icon: 'info', 
            color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' 
        };
    };

    const formatDetails = (entry: AuditLogEntry): string => {
        const parts: string[] = [];
        const d = entry.details || {};
        
        // Resource name first
        if (entry.resourceName) {
            parts.push(entry.resourceName);
        }
        
        // Action-specific details
        switch (entry.action) {
            case 'tour_checkin':
            case 'tour_completed':
            case 'tour_no_show':
            case 'tour_cancelled':
            case 'tour_status_changed':
                if (d.guest_email) parts.push(d.guest_email);
                if (d.tour_date) parts.push(d.tour_date);
                if (d.previous_status && d.new_status) {
                    parts.push(`${d.previous_status} → ${d.new_status}`);
                }
                break;
            case 'create_event':
            case 'update_event':
            case 'delete_event':
                if (d.event_date || d.date) parts.push(d.event_date || d.date);
                if (d.location) parts.push(d.location);
                break;
            case 'manual_rsvp':
            case 'remove_rsvp':
                if (d.attendee_email || d.rsvp_email) parts.push(d.attendee_email || d.rsvp_email);
                if (d.event_date) parts.push(d.event_date);
                break;
            case 'create_wellness_class':
            case 'update_wellness_class':
            case 'delete_wellness_class':
                if (d.instructor) parts.push(`Instructor: ${d.instructor}`);
                if (d.date) parts.push(d.date);
                break;
            case 'manual_enrollment':
                if (d.memberEnrolled) parts.push(d.memberEnrolled);
                break;
            case 'create_announcement':
            case 'update_announcement':
            case 'delete_announcement':
                if (d.priority) parts.push(`Priority: ${d.priority}`);
                break;
            case 'create_closure':
            case 'update_closure':
            case 'delete_closure':
                if (d.startDate && d.endDate) parts.push(`${d.startDate} to ${d.endDate}`);
                else if (d.startDate) parts.push(d.startDate);
                if (d.affectedAreas) parts.push(d.affectedAreas);
                if (d.reason) parts.push(d.reason);
                break;
            case 'add_guest_to_booking':
                if (d.guest_name) parts.push(d.guest_name);
                if (d.guest_email) parts.push(d.guest_email);
                if (d.fee_amount) parts.push(`Fee: $${(d.fee_amount / 100).toFixed(2)}`);
                break;
            case 'link_member_to_booking':
            case 'unlink_member_from_booking':
                if (d.memberEmail || d.linkedBy) parts.push(d.memberEmail || d.linkedBy);
                break;
            case 'direct_add_participant':
                if (d.guestName) parts.push(d.guestName);
                if (d.memberName) parts.push(d.memberName);
                if (d.participantType) parts.push(d.participantType);
                if (d.reason) parts.push(d.reason);
                break;
            case 'update_payment_status':
                if (d.participantName) parts.push(d.participantName);
                if (d.newStatus) parts.push(`Status: ${d.newStatus}`);
                if (d.action) parts.push(d.action.replace(/_/g, ' '));
                if (d.participantCount) parts.push(`${d.participantCount} participants`);
                break;
            case 'add_group_member':
            case 'remove_group_member':
                if (d.memberEmail) parts.push(d.memberEmail);
                if (d.groupType) parts.push(d.groupType);
                break;
            case 'import_trackman':
                if (d.filename) parts.push(d.filename);
                if (d.bookingsImported !== undefined) parts.push(`${d.bookingsImported} bookings`);
                break;
            case 'reassign_booking':
                if (d.oldEmail && d.newEmail) parts.push(`${d.oldEmail} → ${d.newEmail}`);
                break;
            default:
                // Generic fallback
                if (d.member_email) parts.push(d.member_email);
                if (d.amount) {
                    const amount = typeof d.amount === 'number' 
                        ? `$${(d.amount / 100).toFixed(2)}` 
                        : d.amount;
                    parts.push(amount);
                }
                if (d.tier) parts.push(`Tier: ${d.tier}`);
                if (d.reason) parts.push(`Reason: ${d.reason}`);
                if (d.bay) parts.push(`Bay ${d.bay}`);
        }
        
        return parts.join(' • ') || 'No additional details';
    };

    const renderUpdatesTab = () => (
        <div className="space-y-6 animate-pop-in">
            <div className="text-sm text-primary/80 dark:text-white/80 mb-6">
                A complete history of updates, improvements, and new features added to the Ever House app.
            </div>

            {changelog.map((entry, index) => (
                <div 
                    key={entry.version}
                    className={`relative pl-8 pb-6 ${index !== changelog.length - 1 ? 'border-l-2 border-primary/20 dark:border-white/20' : ''}`}
                >
                    <div className={`absolute left-0 top-0 w-4 h-4 rounded-full -translate-x-[9px] ${
                        entry.isMajor 
                            ? 'bg-primary dark:bg-accent ring-4 ring-primary/20 dark:ring-accent/20' 
                            : 'bg-gray-300 dark:bg-gray-600'
                    }`} />
                    
                    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-sm rounded-2xl p-5 border border-primary/10 dark:border-white/25">
                        <div className="flex items-start justify-between mb-3">
                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-lg font-bold ${
                                        entry.isMajor 
                                            ? 'text-primary dark:text-accent' 
                                            : 'text-primary dark:text-white'
                                    }`}>
                                        v{entry.version}
                                    </span>
                                    {entry.isMajor && (
                                        <span className="text-[10px] font-bold uppercase tracking-wider bg-primary/10 dark:bg-accent/20 text-primary dark:text-accent px-2 py-0.5 rounded">
                                            Major Release
                                        </span>
                                    )}
                                </div>
                                <h3 className="text-base font-semibold text-primary dark:text-white">
                                    {entry.title}
                                </h3>
                            </div>
                            <span className="text-xs text-primary/70 dark:text-white/70 whitespace-nowrap">
                                {formatDate(entry.date)}
                            </span>
                        </div>
                        
                        <ul className="space-y-2">
                            {entry.changes.map((change, i) => (
                                <li key={i} className="flex items-start gap-2 text-sm text-primary/80 dark:text-white/80">
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm text-primary/70 dark:text-white/70 mt-0.5">check_circle</span>
                                    {change}
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            ))}
        </div>
    );

    const renderActivityTab = () => {
        if (loading && entries.length === 0) {
            return (
                <div className="flex items-center justify-center py-20">
                    <WalkingGolferSpinner size="lg" />
                </div>
            );
        }

        return (
            <div className="animate-pop-in">
                <div className="flex flex-wrap gap-2 mb-4">
                    {FILTER_CATEGORIES.map(cat => (
                        <button
                            key={cat.key}
                            onClick={() => setFilterCategory(cat.key)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                filterCategory === cat.key
                                    ? 'bg-accent text-primary'
                                    : 'bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10'
                            }`}
                        >
                            {cat.label}
                        </button>
                    ))}
                </div>

                {uniqueStaff.length > 1 && (
                    <div className="mb-4">
                        <select
                            value={staffFilter}
                            onChange={(e) => setStaffFilter(e.target.value)}
                            className="w-full sm:w-auto px-3 py-2 rounded-xl text-sm bg-white dark:bg-white/5 border border-primary/10 dark:border-white/10 text-primary dark:text-white"
                        >
                            <option value="">All Staff Members</option>
                            {uniqueStaff.map(email => (
                                <option key={email} value={email}>{email}</option>
                            ))}
                        </select>
                    </div>
                )}

                {error && (
                    <div className="mb-4 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
                        {error}
                    </div>
                )}

                {entries.length === 0 ? (
                    <div className="text-center py-16 text-primary/70 dark:text-white/70">
                        <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 block opacity-30">history</span>
                        <p className="text-lg font-medium">No activity found</p>
                        <p className="text-sm mt-1 opacity-70">Staff actions will appear here as they occur.</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {entries.map((entry, index) => {
                            const actionInfo = getActionInfo(entry.action);
                            return (
                                <div
                                    key={entry.id}
                                    className="rounded-2xl bg-white dark:bg-white/[0.03] shadow-layered dark:shadow-layered-dark overflow-hidden animate-pop-in"
                                    style={{ animationDelay: `${0.05 + index * 0.02}s` }}
                                >
                                    <div className="flex gap-3 p-4">
                                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${actionInfo.color}`}>
                                            <span className="material-symbols-outlined text-[20px]">
                                                {actionInfo.icon}
                                            </span>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-start">
                                                <h4 className="font-bold text-sm text-primary dark:text-white">
                                                    {actionInfo.label}
                                                </h4>
                                                <span className="text-[10px] ml-2 shrink-0 text-primary/70 dark:text-white/70">
                                                    {formatRelativeTime(entry.createdAt)}
                                                </span>
                                            </div>
                                            <p className="text-xs mt-0.5 text-primary/70 dark:text-white/70">
                                                by {entry.staffName || entry.staffEmail}
                                            </p>
                                            <p className="text-xs mt-1 text-primary/60 dark:text-white/60 truncate">
                                                {formatDetails(entry)}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        
                        {hasMore && (
                            <button
                                onClick={loadMore}
                                disabled={loading}
                                className="w-full py-3 rounded-xl text-sm font-medium transition-all bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10 disabled:opacity-50"
                            >
                                {loading ? 'Loading...' : 'Load More'}
                            </button>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <PullToRefresh onRefresh={handleRefresh}>
            <AnimatedPage className="pb-32">
                {isAdmin && (
                    <div className="flex gap-2 mb-6 animate-content-enter">
                        <button
                            onClick={() => setActiveTab('updates')}
                            className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold uppercase tracking-wide transition-all ${
                                activeTab === 'updates'
                                    ? 'bg-accent text-primary'
                                    : 'bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10'
                            }`}
                        >
                            App Updates
                        </button>
                        <button
                            onClick={() => setActiveTab('activity')}
                            className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold uppercase tracking-wide transition-all ${
                                activeTab === 'activity'
                                    ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                    : 'bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10'
                            }`}
                        >
                            Staff Activity
                        </button>
                    </div>
                )}

                {activeTab === 'updates' && renderUpdatesTab()}
                {activeTab === 'activity' && isAdmin && renderActivityTab()}
            </AnimatedPage>
        </PullToRefresh>
    );
};

export default ChangelogTab;
