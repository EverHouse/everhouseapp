import React from 'react';
import { formatTime12Hour, getRelativeDateLabel, formatDuration, formatRelativeTime, getTodayPacific } from '../../../../utils/dateUtils';
import { getStatusBadge, formatStatusLabel } from '../../../../utils/statusColors';
import TierBadge from '../../../../components/TierBadge';
import { SwipeableListItem } from '../../../../components/SwipeableListItem';
import type { BookingRequest, Resource } from './simulatorTypes';
import { estimateFeeByTier, formatDateShortAdmin, groupBookingsByDate } from './simulatorUtils';

export interface BookingRequestsPanelProps {
    queueItems: (BookingRequest & { queueType: 'pending' | 'unmatched' })[];
    pendingRequests: BookingRequest[];
    unmatchedWebhookBookings: BookingRequest[];
    scheduledBookings: BookingRequest[];
    scheduledFilter: 'all' | 'today' | 'tomorrow' | 'week';
    setScheduledFilter: (filter: 'all' | 'today' | 'tomorrow' | 'week') => void;
    resources: Resource[];
    memberNameMap: Record<string, string>;
    actionInProgress: Record<string, string>;
    navigateToTab: (tab: string) => void;
    setBookingSheet: (sheet: any) => void;
    setTrackmanModal: (modal: { isOpen: boolean; booking: BookingRequest | null }) => void;
    setSelectedRequest: (req: BookingRequest | null) => void;
    setActionModal: (modal: 'approve' | 'decline' | null) => void;
    cancelBookingOptimistic: (booking: BookingRequest) => Promise<boolean>;
    updateBookingStatusOptimistic: (booking: BookingRequest, status: 'attended' | 'no_show' | 'cancelled') => Promise<boolean>;
    isBookingUnmatched: (booking: BookingRequest) => boolean;
    handleRefresh: () => void;
    showToast: (msg: string, type: 'success' | 'error') => void;
    confirm: (opts: { title: string; message: string; confirmText: string; variant: string }) => Promise<boolean>;
    guestFeeDollars: number;
    overageRatePerBlockDollars: number;
    optimisticNewBooking: BookingRequest | null;
    startDate: string;
    endDate: string;
    queryClient: any;
    simulatorKeys: any;
    activeView: 'requests' | 'calendar';
    queueMaxHeight: number | null;
    setActionInProgress: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

const BookingRequestsPanel: React.FC<BookingRequestsPanelProps> = ({
    queueItems,
    pendingRequests,
    unmatchedWebhookBookings,
    scheduledBookings,
    scheduledFilter,
    setScheduledFilter,
    resources,
    memberNameMap,
    actionInProgress,
    navigateToTab,
    setBookingSheet,
    setTrackmanModal,
    setSelectedRequest,
    setActionModal,
    cancelBookingOptimistic,
    updateBookingStatusOptimistic,
    isBookingUnmatched,
    handleRefresh,
    showToast,
    confirm,
    guestFeeDollars,
    overageRatePerBlockDollars,
    optimisticNewBooking,
    startDate,
    endDate,
    queryClient,
    simulatorKeys,
    activeView,
    queueMaxHeight,
    setActionInProgress,
}) => {
    return (
        <div 
            className={`lg:border border-gray-200 dark:border-white/25 relative rounded-xl ${activeView === 'requests' ? 'block' : 'hidden lg:block'}`}
            style={queueMaxHeight ? { height: queueMaxHeight, overflow: 'hidden' } : undefined}
        >
            <div className="hidden lg:block absolute top-0 left-0 right-0 h-10 bg-gradient-to-b from-white dark:from-[#1e1e1e] to-transparent z-10 pointer-events-none rounded-t-xl" />
            <div className="hidden lg:block absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-white dark:from-[#1e1e1e] to-transparent z-10 pointer-events-none rounded-b-xl" />
            <div className="space-y-6 p-5 animate-slide-up-stagger h-full overflow-y-auto pb-10" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                <div className="animate-slide-up-stagger" style={{ '--stagger-index': 1 } as React.CSSProperties}>
                    <div className="flex flex-col gap-2 mb-4">
                        <div className="flex items-center justify-between">
                            <h3 className="font-bold text-primary dark:text-white flex items-center gap-2">
                                <span aria-hidden="true" className="material-symbols-outlined text-yellow-500">pending</span>
                                Queue ({queueItems.length})
                            </h3>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => navigateToTab('trackman')}
                                    className="hidden lg:flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-primary dark:text-white bg-primary/10 dark:bg-white/10 hover:bg-primary/20 dark:hover:bg-white/20 rounded-lg transition-colors shadow-sm"
                                    title="Import bookings from Trackman CSV"
                                >
                                    <span className="material-symbols-outlined text-sm">upload_file</span>
                                    <span>Import</span>
                                </button>
                            </div>
                        </div>
                        {queueItems.length > 0 && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {pendingRequests.length > 0 && `${pendingRequests.length} pending`}
                                {pendingRequests.length > 0 && unmatchedWebhookBookings.length > 0 && ', '}
                                {unmatchedWebhookBookings.length > 0 && `${unmatchedWebhookBookings.length} unassigned`}
                            </p>
                        )}
                    </div>
                    {queueItems.length === 0 ? (
                        <div className="py-8 text-center border-2 border-dashed border-gray-200 dark:border-white/25 rounded-xl">
                            <p className="text-gray-600 dark:text-white/70">No items in queue</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {queueItems.map((item, index) => {
                                const isUnmatchedItem = item.queueType === 'unmatched';
                                const req = item;
                                
                                if (isUnmatchedItem) {
                                    return (
                                        <div 
                                            key={`unmatched-${item.id}`} 
                                            className="bg-amber-50/80 dark:bg-amber-500/10 p-4 rounded-xl border-2 border-dashed border-amber-300 dark:border-amber-500/30 animate-slide-up-stagger cursor-pointer hover:bg-amber-100/80 dark:hover:bg-amber-500/20 hover:scale-[1.01] active:scale-[0.98] shadow-sm hover:shadow-md transition-all duration-200" 
                                            style={{ '--stagger-index': index + 2 } as React.CSSProperties}
                                            onClick={() => setBookingSheet({
                                                isOpen: true,
                                                trackmanBookingId: (item as any).trackman_booking_id || null,
                                                matchedBookingId: item.id,
                                                bayName: (item as any).bay_name || `Bay ${item.resource_id}`,
                                                bookingDate: formatDateShortAdmin(item.request_date),
                                                timeSlot: `${formatTime12Hour(item.start_time)} - ${formatTime12Hour(item.end_time)}`,
                                                importedName: item.user_name || (item as any).userName,
                                                notes: (item as any).notes || (item as any).trackman_customer_notes || (item as any).staff_notes
                                            })}
                                        >
                                            <div className="flex justify-between items-start mb-2">
                                                <div className="flex items-center gap-2">
                                                    <span className="px-2.5 py-1 text-xs font-semibold bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-400 rounded-lg">
                                                        Needs Assignment
                                                    </span>
                                                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400">
                                                        {(item as any).bay_name || `Bay ${item.resource_id}`}
                                                    </span>
                                                </div>
                                            </div>
                                            <p className="text-sm text-amber-700 dark:text-amber-400 mb-1">
                                                {formatDateShortAdmin(item.request_date)} • {formatTime12Hour(item.start_time)} - {formatTime12Hour(item.end_time)}
                                            </p>
                                            {(item.user_name && item.user_name !== 'Unknown (Trackman)') && (
                                                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                                                    {item.user_name}
                                                </p>
                                            )}
                                            {item.user_email && !item.user_email.includes('unmatched@') && (
                                                <p className="text-xs text-amber-600 dark:text-amber-500">
                                                    {item.user_email}
                                                </p>
                                            )}
                                            {(item as any).trackman_booking_id && (
                                                <p className="text-xs text-amber-600/70 dark:text-amber-500/70">
                                                    Trackman ID: {(item as any).trackman_booking_id}
                                                </p>
                                            )}
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setBookingSheet({
                                                        isOpen: true,
                                                        trackmanBookingId: (item as any).trackman_booking_id || null,
                                                        matchedBookingId: item.id,
                                                        bayName: (item as any).bay_name || `Bay ${item.resource_id}`,
                                                        bookingDate: formatDateShortAdmin(item.request_date),
                                                        timeSlot: `${formatTime12Hour(item.start_time)} - ${formatTime12Hour(item.end_time)}`,
                                                        importedName: item.user_name || (item as any).userName,
                                                        notes: (item as any).notes || (item as any).trackman_customer_notes || (item as any).staff_notes
                                                    });
                                                }}
                                                className="w-full mt-3 py-2 px-3 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 hover:shadow-md active:scale-95 transition-all duration-200"
                                            >
                                                <span aria-hidden="true" className="material-symbols-outlined text-sm">person_add</span>
                                                Assign Member
                                            </button>
                                        </div>
                                    );
                                }
                                
                                const actionKey = `${req.source || 'request'}-${req.id}`;
                                const actionState = actionInProgress[actionKey];
                                const isActionPending = !!actionState;
                                return (
                                    <div key={`${req.source || 'request'}-${req.id}`} className={`bg-gray-50 dark:bg-white/5 p-4 rounded-xl border border-gray-200 dark:border-white/25 animate-slide-up-stagger shadow-sm hover:shadow-md hover:bg-gray-100 dark:hover:bg-white/10 transition-all duration-200 cursor-pointer active:scale-[0.98] ${isActionPending ? 'opacity-60 pointer-events-none' : ''}`} style={{ '--stagger-index': index + 2 } as React.CSSProperties}>
                                        {isActionPending && (
                                            <div className="flex items-center gap-2 mb-2 text-sm text-primary/70 dark:text-white/70">
                                                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                                </svg>
                                                <span className="capitalize">{actionState}...</span>
                                            </div>
                                        )}
                                        <div className="flex justify-between items-start mb-3">
                                            <div>
                                                <div className="flex items-center gap-2 mb-0.5">
                                                    <p className="font-bold text-primary dark:text-white">{req.user_name || req.user_email}</p>
                                                    {req.tier && <TierBadge tier={req.tier} size="sm" />}
                                                </div>
                                                <p className="text-sm text-gray-500 dark:text-gray-400">
                                                    {formatDateShortAdmin(req.request_date)} • {formatTime12Hour(req.start_time)} - {formatTime12Hour(req.end_time)}
                                                </p>
                                                <p className="text-sm text-gray-500 dark:text-gray-400">{formatDuration(req.duration_minutes || 0)}</p>
                                            </div>
                                            <div className="flex flex-col items-end gap-1">
                                                <span className={`px-2 py-1 rounded text-xs font-bold ${getStatusBadge(req.status)}`}>
                                                    {formatStatusLabel(req.status)}
                                                </span>
                                                {req.created_at && (
                                                    <span className="text-[10px] text-amber-600 dark:text-amber-400">
                                                        Requested {formatRelativeTime(req.created_at)}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        
                                        {(req.bay_name || req.resource_preference) && (
                                            <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                                                <span className="font-medium">Bay preference:</span> {req.bay_name || req.resource_preference}
                                            </p>
                                        )}
                                        {req.notes && (
                                            <p className="text-sm text-gray-600 dark:text-gray-300 italic mb-3">"{req.notes}"</p>
                                        )}
                                        
                                        <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-2">
                                            Book in Trackman to confirm - it will auto-link
                                        </p>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setTrackmanModal({ isOpen: true, booking: req })}
                                                className="flex-1 py-2 px-3 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 hover:bg-amber-200 dark:hover:bg-amber-900/50 hover:shadow-md active:scale-95 transition-all duration-200"
                                            >
                                                <span aria-hidden="true" className="material-symbols-outlined text-sm">sports_golf</span>
                                                Book on Trackman
                                            </button>
                                            <button
                                                onClick={() => { setSelectedRequest(req); setActionModal('decline'); }}
                                                className="flex-1 py-2 px-3 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 hover:bg-red-200 dark:hover:bg-red-900/50 hover:shadow-md active:scale-95 transition-all duration-200"
                                            >
                                                <span aria-hidden="true" className="material-symbols-outlined text-sm">close</span>
                                                Deny
                                            </button>
                                        </div>
                                        {import.meta.env.DEV && (
                                            <button
                                                onClick={async () => {
                                                    try {
                                                        const res = await fetch(`/api/admin/bookings/${req.id}/dev-confirm`, {
                                                            method: 'POST',
                                                            headers: { 'Content-Type': 'application/json' },
                                                            credentials: 'include'
                                                        });
                                                        const data = await res.json();
                                                        if (res.ok) {
                                                            const totalFee = (data.totalFeeCents || 0) / 100;
                                                            showToast(`Confirmed! Total fees: $${totalFee.toFixed(2)}`, 'success');
                                                            handleRefresh();
                                                        } else {
                                                            showToast(data.error || 'Failed to confirm', 'error');
                                                        }
                                                    } catch (err) {
                                                        showToast('Failed to confirm booking', 'error');
                                                    }
                                                }}
                                                className="w-full mt-2 py-1.5 px-3 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors border border-dashed border-green-400 dark:border-green-500/50"
                                            >
                                                <span aria-hidden="true" className="material-symbols-outlined text-sm">check_circle</span>
                                                Dev Confirm
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="animate-slide-up-stagger" style={{ '--stagger-index': 2 } as React.CSSProperties}>
                    <h3 className="font-bold text-primary dark:text-white mb-4 flex items-center gap-2">
                        <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-accent">calendar_today</span>
                        Scheduled ({scheduledBookings.length})
                    </h3>
                    
                    <div className="flex gap-2 overflow-x-auto pb-3 scrollbar-hide -mx-1 px-1 mb-3 scroll-fade-right">
                        {(['all', 'today', 'tomorrow', 'week'] as const).map(filter => (
                            <button
                                key={filter}
                                onClick={() => setScheduledFilter(filter)}
                                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                                    scheduledFilter === filter 
                                        ? 'bg-primary dark:bg-lavender text-white shadow-md' 
                                        : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/15'
                                }`}
                            >
                                {filter === 'all' ? 'All' : filter === 'week' ? 'This Week' : filter.charAt(0).toUpperCase() + filter.slice(1)}
                            </button>
                        ))}
                    </div>
                    
                    {scheduledBookings.length === 0 ? (
                        <div className="py-8 text-center border-2 border-dashed border-primary/10 dark:border-white/25 rounded-xl">
                            <p className="text-primary/70 dark:text-white/70">No scheduled bookings {scheduledFilter !== 'all' ? `for ${scheduledFilter === 'week' ? 'this week' : scheduledFilter}` : ''}</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {Array.from(groupBookingsByDate(scheduledBookings)).map(([date, bookings]) => (
                                <div key={date}>
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-xs font-bold text-primary/70 dark:text-white/70 uppercase tracking-wide">
                                            {getRelativeDateLabel(date)}
                                        </span>
                                        <span className="text-xs text-primary/70 dark:text-white/70">
                                            {formatDateShortAdmin(date)}
                                        </span>
                                    </div>
                                    <div className="space-y-2">
                                        {bookings.map((booking, index) => {
                                            const isToday = booking.request_date === getTodayPacific();
                                            const bookingEmail = booking.user_email?.toLowerCase() || '';
                                            const displayName = bookingEmail && memberNameMap[bookingEmail] 
                                                ? memberNameMap[bookingEmail] 
                                                : booking.user_name || booking.user_email;
                                            const bookingResource = resources.find(r => r.id === booking.resource_id);
                                            const isConferenceRoom = bookingResource?.type === 'conference_room';
                                            const isUnmatched = isBookingUnmatched(booking);
                                            const actionKey = `${booking.source || 'booking'}-${booking.id}`;
                                            const actionState = actionInProgress[actionKey];
                                            const isActionPending = !!actionState;
                                            const isOptimisticNew = String(booking.id).startsWith('creating-');
                                            return (
                                                <SwipeableListItem
                                                    key={`upcoming-${booking.id}`}
                                                    leftActions={[]}
                                                    rightActions={isOptimisticNew || isActionPending || booking.status === 'cancellation_pending' ? [] : [
                                                        {
                                                            id: 'cancel',
                                                            icon: 'close',
                                                            label: 'Cancel',
                                                            color: 'red',
                                                            onClick: () => cancelBookingOptimistic(booking)
                                                        }
                                                    ]}
                                                >
                                                    <div 
                                                        className={`p-4 rounded-2xl animate-pop-in cursor-pointer shadow-sm ${
                                                            isOptimisticNew
                                                                ? 'bg-green-50/80 dark:bg-green-500/10 border-2 border-dashed border-green-300 dark:border-green-500/30 opacity-70'
                                                                : isActionPending
                                                                    ? 'opacity-60 pointer-events-none glass-card border border-primary/10 dark:border-white/25'
                                                                    : isUnmatched 
                                                                        ? 'bg-amber-50/80 dark:bg-amber-500/10 border-2 border-dashed border-amber-300 dark:border-amber-500/30 hover:bg-amber-100/80 dark:hover:bg-amber-500/20 hover:shadow-md hover:scale-[1.01]' 
                                                                        : 'glass-card border border-primary/10 dark:border-white/25 hover:shadow-md'
                                                        } transition-all duration-200`} 
                                                        style={{ '--stagger-index': index } as React.CSSProperties}
                                                        onClick={() => !isOptimisticNew && !isActionPending && setBookingSheet({
                                                            isOpen: true,
                                                            trackmanBookingId: (booking as any).trackman_booking_id || null,
                                                            bookingId: booking.id,
                                                            mode: isUnmatched ? 'assign' as const : 'manage' as const,
                                                            bayName: bookingResource?.name || booking.bay_name || booking.resource_name,
                                                            bookingDate: formatDateShortAdmin(booking.request_date),
                                                            timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                                                            matchedBookingId: Number(booking.id),
                                                            currentMemberName: isUnmatched ? undefined : (booking.user_name || undefined),
                                                            currentMemberEmail: isUnmatched ? undefined : (booking.user_email || undefined),
                                                            ownerName: booking.user_name || undefined,
                                                            ownerEmail: booking.user_email || undefined,
                                                            declaredPlayerCount: (booking as any).declared_player_count || (booking as any).player_count || 1,
                                                            isRelink: !isUnmatched,
                                                            importedName: (booking as any).user_name || (booking as any).userName,
                                                            notes: (booking as any).notes || (booking as any).note,
                                                            bookingStatus: booking.status,
                                                            bookingContext: { requestDate: booking.request_date, startTime: booking.start_time, endTime: booking.end_time, resourceId: booking.resource_id || undefined, resourceName: (bookingResource?.name || booking.bay_name || booking.resource_name) || undefined, durationMinutes: booking.duration_minutes || undefined },
                                                        })}
                                                    >
                                                        {(isActionPending || isOptimisticNew) && (
                                                            <div className="flex items-center gap-2 mb-2 text-sm text-primary/70 dark:text-white/70">
                                                                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                                                </svg>
                                                                <span className="capitalize">{isOptimisticNew ? 'Creating booking...' : `${actionState}...`}</span>
                                                            </div>
                                                        )}
                                                        <div className="flex items-center gap-2 mb-2">
                                                            {isUnmatched ? (
                                                                <>
                                                                    <span className="px-2.5 py-1 text-xs font-semibold bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-400 rounded-lg">
                                                                        Needs Assignment
                                                                    </span>
                                                                    {isConferenceRoom ? (
                                                                        <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400">
                                                                            Conf
                                                                        </span>
                                                                    ) : (
                                                                        <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400">
                                                                            {booking.bay_name || `Bay ${booking.resource_id}`}
                                                                        </span>
                                                                    )}
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <p className="font-semibold text-base text-primary dark:text-white">
                                                                        {displayName}
                                                                    </p>
                                                                    {(booking as any).tier && <TierBadge tier={(booking as any).tier} size="sm" />}
                                                                    {isConferenceRoom ? (
                                                                        <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400">
                                                                            Conf
                                                                        </span>
                                                                    ) : (
                                                                        <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-primary/10 dark:bg-white/10 text-primary/70 dark:text-white/70">
                                                                            {booking.bay_name || `Bay ${booking.resource_id}`}
                                                                        </span>
                                                                    )}
                                                                </>
                                                            )}
                                                        </div>
                                                        
                                                        <p className={`text-sm mb-1 ${isUnmatched ? 'text-amber-700 dark:text-amber-400' : 'text-primary/80 dark:text-white/80'}`}>
                                                            {new Date(booking.request_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} • {formatTime12Hour(booking.start_time)} - {formatTime12Hour(booking.end_time)}
                                                        </p>
                                                        
                                                        {booking.trackman_booking_id && !isConferenceRoom && (
                                                            <p className="text-xs text-orange-600 dark:text-orange-400 font-mono mt-2">
                                                                Trackman ID: {booking.trackman_booking_id}
                                                            </p>
                                                        )}
                                                        
                                                        {booking.status === 'cancellation_pending' && (
                                                            <div className="flex items-center gap-2 mt-2">
                                                                <span className="px-2.5 py-1 text-xs font-semibold bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400 rounded-lg flex items-center gap-1">
                                                                    <span className="material-symbols-outlined text-xs">hourglass_top</span>
                                                                    Cancellation Pending
                                                                </span>
                                                            </div>
                                                        )}
                                                        <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                                                            {booking.status === 'cancellation_pending' ? (
                                                                <button
                                                                    onClick={async () => {
                                                                        const confirmed = await confirm({
                                                                            title: 'Complete Cancellation',
                                                                            message: 'Complete this cancellation? This will cancel the billing session and refund any charges.',
                                                                            confirmText: 'Complete Cancellation',
                                                                            variant: 'warning'
                                                                        });
                                                                        if (!confirmed) return;
                                                                        
                                                                        const bookingKey = `${booking.source || 'booking'}-${booking.id}`;
                                                                        setActionInProgress(prev => ({ ...prev, [bookingKey]: 'completing cancellation' }));
                                                                        
                                                                        try {
                                                                            const res = await fetch(`/api/booking-requests/${booking.id}/complete-cancellation`, {
                                                                                method: 'PUT',
                                                                                headers: { 'Content-Type': 'application/json' },
                                                                                credentials: 'include'
                                                                            });
                                                                            
                                                                            if (!res.ok) {
                                                                                const errData = await res.json();
                                                                                throw new Error(errData.error || 'Failed to complete cancellation');
                                                                            }
                                                                            
                                                                            showToast('Cancellation completed successfully', 'success');
                                                                            queryClient.invalidateQueries({ queryKey: simulatorKeys.approvedBookings(startDate, endDate) });
                                                                            queryClient.invalidateQueries({ queryKey: simulatorKeys.allRequests() });
                                                                        } catch (err: any) {
                                                                            showToast(err.message || 'Failed to complete cancellation', 'error');
                                                                        } finally {
                                                                            setActionInProgress(prev => {
                                                                                const next = { ...prev };
                                                                                delete next[bookingKey];
                                                                                return next;
                                                                            });
                                                                        }
                                                                    }}
                                                                    className="flex-1 py-2.5 bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2 hover:shadow-md active:scale-95 transition-all duration-200"
                                                                >
                                                                    <span aria-hidden="true" className="material-symbols-outlined text-lg">check_circle</span>
                                                                    Complete Cancellation
                                                                </button>
                                                            ) : isUnmatched ? (
                                                                <button
                                                                    onClick={() => setBookingSheet({
                                                                        isOpen: true,
                                                                        trackmanBookingId: booking.trackman_booking_id || null,
                                                                        bayName: bookingResource ? (bookingResource.type === 'conference_room' ? 'Conference Room' : bookingResource.name) : (booking.bay_name || `Bay ${booking.resource_id}`),
                                                                        bookingDate: formatDateShortAdmin(booking.request_date),
                                                                        timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                                                                        matchedBookingId: Number(booking.id),
                                                                        isRelink: false,
                                                                        importedName: (booking as any).user_name || (booking as any).userName,
                                                                        notes: (booking as any).notes || (booking as any).note
                                                                    })}
                                                                    className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2 hover:shadow-md active:scale-95 transition-all duration-200"
                                                                >
                                                                    <span aria-hidden="true" className="material-symbols-outlined text-lg">person_add</span>
                                                                    Assign Member
                                                                </button>
                                                            ) : !isConferenceRoom && isToday && booking.status === 'attended' ? (
                                                                <span className="flex-1 py-2.5 bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400 rounded-xl text-sm font-medium flex items-center justify-center gap-2">
                                                                    <span aria-hidden="true" className="material-symbols-outlined text-lg">check_circle</span>
                                                                    Checked In
                                                                </span>
                                                            ) : !isConferenceRoom && isToday && (() => {
                                                                const declPlayers = (booking as any).declared_player_count || 1;
                                                                const filledPlayers = (booking as any).filled_player_count || 0;
                                                                const dbOwed = booking.total_owed || 0;
                                                                const estimatedFee = estimateFeeByTier((booking as any).tier, booking.duration_minutes || 0, declPlayers, guestFeeDollars, overageRatePerBlockDollars);
                                                                return booking.has_unpaid_fees === true || dbOwed > 0 || (filledPlayers < declPlayers && estimatedFee > 0);
                                                            })() ? (
                                                                (() => {
                                                                    const declPlayers = (booking as any).declared_player_count || 1;
                                                                    const filledPlayers = (booking as any).filled_player_count || 0;
                                                                    const dbOwed = booking.total_owed || 0;
                                                                    const estimatedFee = dbOwed > 0 
                                                                      ? dbOwed 
                                                                      : estimateFeeByTier((booking as any).tier, booking.duration_minutes || 0, declPlayers, guestFeeDollars, overageRatePerBlockDollars);
                                                                    const isEstimate = !booking.has_unpaid_fees && dbOwed === 0;
                                                                    return (
                                                                        <button
                                                                            onClick={() => {
                                                                                const bookingId = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', '')) : booking.id;
                                                                                setBookingSheet({
                                                                                    isOpen: true,
                                                                                    trackmanBookingId: null,
                                                                                    bookingId,
                                                                                    mode: 'manage' as const,
                                                                                });
                                                                            }}
                                                                            className="flex-1 py-2.5 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 rounded-xl text-sm font-medium flex items-center justify-center gap-2 hover:bg-amber-200 dark:hover:bg-amber-500/30 hover:shadow-md active:scale-95 transition-all duration-200"
                                                                        >
                                                                            <span aria-hidden="true" className="material-symbols-outlined text-lg">payments</span>
                                                                            {isEstimate ? `~$${estimatedFee} Est` : `$${estimatedFee.toFixed(0)} Due`}
                                                                        </button>
                                                                    );
                                                                })()
                                                            ) : !isConferenceRoom && (booking as any).declared_player_count > 0 && (booking as any).declared_player_count > ((booking as any).filled_player_count || 0) ? (
                                                                <button
                                                                    onClick={() => {
                                                                        const bookingId = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', '')) : booking.id;
                                                                        setBookingSheet({
                                                                            isOpen: true,
                                                                            trackmanBookingId: null,
                                                                            bookingId,
                                                                            mode: 'manage' as const,
                                                                        });
                                                                    }}
                                                                    className="flex-1 py-2.5 bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400 rounded-xl text-sm font-medium flex items-center justify-center gap-2 hover:bg-blue-200 dark:hover:bg-blue-500/30 hover:shadow-md active:scale-95 transition-all duration-200"
                                                                >
                                                                    <span aria-hidden="true" className="material-symbols-outlined text-lg">group_add</span>
                                                                    Roster {(booking as any).filled_player_count || 0}/{(booking as any).declared_player_count}
                                                                </button>
                                                            ) : !isConferenceRoom && isToday ? (
                                                                <button
                                                                    onClick={async (e) => {
                                                                        e.stopPropagation();
                                                                        e.preventDefault();
                                                                        const btn = e.currentTarget;
                                                                        if (btn.disabled) return;
                                                                        btn.disabled = true;
                                                                        await updateBookingStatusOptimistic(booking, 'attended');
                                                                        btn.disabled = false;
                                                                    }}
                                                                    className="flex-1 py-2.5 bg-accent text-primary rounded-xl text-sm font-medium flex items-center justify-center gap-2 hover:opacity-90 hover:shadow-md active:scale-95 transition-all duration-200 disabled:opacity-50"
                                                                >
                                                                    <span aria-hidden="true" className="material-symbols-outlined text-lg">how_to_reg</span>
                                                                    Check In
                                                                </button>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                </SwipeableListItem>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default BookingRequestsPanel;
