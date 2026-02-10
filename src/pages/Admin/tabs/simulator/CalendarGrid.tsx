import React, { useMemo } from 'react';
import ReactDOM from 'react-dom';
import { formatTime12Hour, getTodayPacific } from '../../../../utils/dateUtils';
import type { BookingRequest, Resource, CalendarClosure, AvailabilityBlock } from './simulatorTypes';
import { estimateFeeByTier, formatDateShortAdmin, getClosureForSlot, getBlockForSlot } from './simulatorUtils';

export interface CalendarGridProps {
    resources: Resource[];
    calendarDate: string;
    setCalendarDate: (date: string) => void;
    showDatePicker: boolean;
    setShowDatePicker: (show: boolean) => void;
    approvedBookings: BookingRequest[];
    pendingRequests: BookingRequest[];
    closures: CalendarClosure[];
    availabilityBlocks: AvailabilityBlock[];
    memberStatusMap: Record<string, string>;
    memberNameMap: Record<string, string>;
    setBookingSheet: (sheet: any) => void;
    setStaffManualBookingDefaults: (defaults: any) => void;
    setStaffManualBookingModalOpen: (open: boolean) => void;
    setTrackmanModal: (modal: { isOpen: boolean; booking: BookingRequest | null }) => void;
    handleRefresh: () => void;
    isSyncing: boolean;
    setIsSyncing: (syncing: boolean) => void;
    lastRefresh: Date | null;
    setLastRefresh: (date: Date | null) => void;
    isDark: boolean;
    showToast: (msg: string, type: 'success' | 'error') => void;
    calendarColRef: React.RefObject<HTMLDivElement>;
    activeView: 'requests' | 'calendar';
    guestFeeDollars: number;
    overageRatePerBlockDollars: number;
    tierMinutes: Record<string, number>;
}

const CalendarGrid: React.FC<CalendarGridProps> = ({
    resources,
    calendarDate,
    setCalendarDate,
    showDatePicker,
    setShowDatePicker,
    approvedBookings,
    pendingRequests,
    closures,
    availabilityBlocks,
    memberStatusMap,
    memberNameMap,
    setBookingSheet,
    setStaffManualBookingDefaults,
    setStaffManualBookingModalOpen,
    setTrackmanModal,
    handleRefresh,
    isSyncing,
    setIsSyncing,
    lastRefresh,
    setLastRefresh,
    isDark,
    showToast,
    calendarColRef,
    activeView,
    guestFeeDollars,
    overageRatePerBlockDollars,
    tierMinutes,
}) => {
    const timeSlots = useMemo(() => {
        const slots: string[] = [];
        for (let hour = 8; hour <= 21; hour++) {
            slots.push(`${hour.toString().padStart(2, '0')}:00`);
            if (hour < 21) {
                slots.push(`${hour.toString().padStart(2, '0')}:15`);
                slots.push(`${hour.toString().padStart(2, '0')}:30`);
                slots.push(`${hour.toString().padStart(2, '0')}:45`);
            }
        }
        return slots;
    }, []);

    const getClosureForSlotLocal = (resourceId: number, date: string, slotStart: number, slotEnd: number) => {
        return getClosureForSlot(resourceId, date, slotStart, slotEnd, closures, resources);
    };

    const getBlockForSlotLocal = (resourceId: number, date: string, slotStart: number, slotEnd: number) => {
        return getBlockForSlot(resourceId, date, slotStart, slotEnd, availabilityBlocks);
    };

    return (
        <div ref={calendarColRef} className={`flex-1 lg:flex lg:flex-col ${activeView === 'calendar' ? 'block' : 'hidden lg:flex'}`}>
            <div className="bg-gray-50 dark:bg-white/5 py-3 shrink-0 animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                <div className="flex items-center justify-center px-2 relative">
                    <div className="flex items-center gap-2 relative">
                        <button
                            onClick={() => {
                                const d = new Date(calendarDate);
                                d.setDate(d.getDate() - 1);
                                setCalendarDate(d.toISOString().split('T')[0]);
                            }}
                            className="p-1.5 rounded-full text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-xl">chevron_left</span>
                        </button>
                        <button
                            onClick={() => setShowDatePicker(!showDatePicker)}
                            className="font-semibold text-primary dark:text-white min-w-[120px] text-center text-sm py-1 px-2 rounded-lg hover:bg-gray-200 dark:hover:bg-white/10 transition-colors flex items-center justify-center gap-1"
                        >
                            {formatDateShortAdmin(calendarDate)}
                            <span className="material-symbols-outlined text-sm opacity-60">calendar_month</span>
                        </button>
                        <button
                            onClick={() => {
                                const d = new Date(calendarDate);
                                d.setDate(d.getDate() + 1);
                                setCalendarDate(d.toISOString().split('T')[0]);
                            }}
                            className="p-1.5 rounded-full text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-xl">chevron_right</span>
                        </button>
                        
                        {showDatePicker && ReactDOM.createPortal(
                            <div 
                                className="fixed inset-0 bg-black/30 flex items-center justify-center"
                                style={{ zIndex: 9999 }}
                                onMouseDown={() => setShowDatePicker(false)}
                            >
                                <div 
                                    className={`rounded-xl shadow-2xl p-5 min-w-[220px] ${isDark ? 'bg-[#1a1d15] border border-white/10' : 'bg-white border border-gray-300'}`}
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    <div className="flex flex-col gap-4">
                                        <div className={`text-center text-sm font-semibold mb-1 ${isDark ? 'text-white' : 'text-gray-700'}`}>
                                            Jump to Date
                                        </div>
                                        <input
                                            type="date"
                                            value={calendarDate}
                                            onChange={(e) => {
                                                if (e.target.value) {
                                                    setCalendarDate(e.target.value);
                                                    setShowDatePicker(false);
                                                }
                                            }}
                                            className={`w-full px-4 py-3 rounded-lg text-base font-medium focus:outline-none focus:ring-2 cursor-pointer ${isDark ? 'border border-white/20 bg-white/10 text-white focus:ring-lavender' : 'border border-gray-300 bg-gray-50 text-gray-900 focus:ring-primary'}`}
                                        />
                                        <button
                                            type="button"
                                            onMouseDown={(e) => {
                                                e.stopPropagation();
                                                setCalendarDate(getTodayPacific());
                                                setShowDatePicker(false);
                                            }}
                                            className={`w-full py-3 px-4 rounded-lg text-base font-semibold hover:opacity-90 active:scale-95 transition-all flex items-center justify-center gap-2 shadow-lg ${isDark ? 'bg-[#CCB8E4] text-[#1a1d15]' : 'bg-primary text-white'}`}
                                        >
                                            <span className="material-symbols-outlined text-lg">today</span>
                                            Today
                                        </button>
                                        <button
                                            type="button"
                                            onMouseDown={(e) => {
                                                e.stopPropagation();
                                                setShowDatePicker(false);
                                            }}
                                            className={`w-full py-2 text-sm font-medium ${isDark ? 'text-red-400 hover:text-red-300' : 'text-gray-500 hover:text-gray-700'}`}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            </div>,
                            document.body
                        )}
                    </div>
                    <div className="absolute right-2 flex items-center gap-2">
                        {lastRefresh && (
                            <span className="text-[10px] text-gray-400 dark:text-gray-500 whitespace-nowrap hidden sm:inline">
                                Updated {lastRefresh.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                            </span>
                        )}
                        <button
                            onClick={async () => {
                                if (isSyncing) return;
                                setIsSyncing(true);
                                try {
                                    const syncRes = await fetch('/api/admin/bookings/sync-calendar', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        credentials: 'include'
                                    });
                                    const syncData = await syncRes.json();
                                    
                                    await handleRefresh();
                                    
                                    if (syncRes.ok && syncData.conference_room?.synced > 0) {
                                        showToast(`Refreshed calendar + synced ${syncData.conference_room.synced} conference room bookings`, 'success');
                                    } else {
                                        showToast('Calendar refreshed', 'success');
                                    }
                                } catch (err: any) {
                                    const errorMsg = err?.message || 'Network error - please check your connection';
                                    showToast(`Refresh failed: ${errorMsg}`, 'error');
                                } finally {
                                    setIsSyncing(false);
                                }
                            }}
                            disabled={isSyncing}
                            className="p-1.5 rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
                            title={lastRefresh ? `Refresh calendar (Last: ${lastRefresh.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})` : 'Refresh calendar data'}
                        >
                            <span className={`material-symbols-outlined text-lg ${isSyncing ? 'animate-spin' : ''}`}>sync</span>
                        </button>
                    </div>
                </div>
            </div>
            
            <div className="flex-1 relative animate-slide-up-stagger overflow-x-auto scroll-smooth" style={{ '--stagger-index': 1 } as React.CSSProperties}>
                <div className="w-full px-1 sm:px-2 pb-4">
                    <div className="w-full">
                    <div className="grid gap-0.5 w-full" style={{ gridTemplateColumns: `minmax(32px, 0.6fr) repeat(${resources.length}, minmax(0, 1fr))` }}>
                        <div className="h-8 sm:h-10 sticky top-0 z-20 bg-white dark:bg-[#1a1f1a] flex items-center justify-center text-[10px] sm:text-xs font-bold text-primary dark:text-white rounded-t-lg border border-gray-200 dark:border-white/25 shadow-[0_2px_4px_rgba(0,0,0,0.05)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.2)]">
                            <span className="hidden sm:inline">Time</span>
                            <span className="sm:hidden">T</span>
                        </div>
                        {[...resources].sort((a, b) => {
                            if (a.type === 'conference_room' && b.type !== 'conference_room') return 1;
                            if (a.type !== 'conference_room' && b.type === 'conference_room') return -1;
                            return 0;
                        }).map(resource => (
                            <div key={resource.id} className={`h-8 sm:h-10 flex items-center justify-center font-bold text-[10px] sm:text-xs text-primary dark:text-white text-center rounded-t-lg border border-gray-200 dark:border-white/25 px-0.5 sticky top-0 z-20 shadow-[0_2px_4px_rgba(0,0,0,0.05)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.2)] transition-all duration-150 ${resource.type === 'conference_room' ? 'bg-purple-100 dark:bg-purple-900/50 hover:bg-purple-150 dark:hover:bg-purple-900/60' : 'bg-white dark:bg-[#1a1f1a]'}`}>
                                <span className="hidden sm:inline">{resource.type === 'conference_room' ? 'Conf' : resource.name.replace('Simulator Bay ', 'Bay ')}</span>
                                <span className="sm:hidden">{resource.type === 'conference_room' ? 'CR' : resource.name.replace('Simulator Bay ', 'B')}</span>
                            </div>
                        ))}
                        
                        {timeSlots.map(slot => {
                            const slotHour = parseInt(slot.split(':')[0]);
                            const isEvenHour = slotHour % 2 === 0;
                            return (
                            <React.Fragment key={slot}>
                                <div className={`h-7 sm:h-8 flex items-center justify-end pr-0.5 sm:pr-1 text-[9px] sm:text-[10px] text-gray-600 dark:text-white/70 font-medium whitespace-nowrap border-r border-gray-200 dark:border-white/15 ${isEvenHour ? 'bg-white dark:bg-surface-dark' : 'bg-gray-50 dark:bg-white/3'}`}>
                                    <span className="hidden sm:inline">{formatTime12Hour(slot)}</span>
                                    <span className="sm:hidden">{formatTime12Hour(slot).replace(':00', '').replace(' AM', 'a').replace(' PM', 'p')}</span>
                                </div>
                                {[...resources].sort((a, b) => {
                                    if (a.type === 'conference_room' && b.type !== 'conference_room') return 1;
                                    if (a.type !== 'conference_room' && b.type === 'conference_room') return -1;
                                    return 0;
                                }).map(resource => {
                                    const [slotHourNum, slotMin] = slot.split(':').map(Number);
                                    const slotStart = slotHourNum * 60 + slotMin;
                                    const slotEnd = slotStart + 15;
                                    
                                    const closure = getClosureForSlotLocal(resource.id, calendarDate, slotStart, slotEnd);
                                    const eventBlock = !closure ? getBlockForSlotLocal(resource.id, calendarDate, slotStart, slotEnd) : null;
                                    
                                    const booking = approvedBookings.find(b => {
                                        if (b.resource_id !== resource.id || b.request_date !== calendarDate) return false;
                                        const [bh, bm] = b.start_time.split(':').map(Number);
                                        const [eh, em] = b.end_time.split(':').map(Number);
                                        const bookStart = bh * 60 + bm;
                                        const bookEnd = eh * 60 + em;
                                        return slotStart < bookEnd && slotEnd > bookStart;
                                    });
                                    
                                    const pendingRequest = !booking ? pendingRequests.find(pr => {
                                        if (pr.resource_id !== resource.id || pr.request_date !== calendarDate) return false;
                                        const [prh, prm] = pr.start_time.split(':').map(Number);
                                        const [preh, prem] = pr.end_time.split(':').map(Number);
                                        const prStart = prh * 60 + prm;
                                        const prEnd = preh * 60 + prem;
                                        return slotStart < prEnd && slotEnd > prStart;
                                    }) : null;
                                    
                                    const isConference = resource.type === 'conference_room';
                                    const bookingEmail = booking?.user_email?.toLowerCase() || '';
                                    const bookingMemberStatus = bookingEmail ? memberStatusMap[bookingEmail] : null;
                                    const bookingDisplayName = bookingEmail && memberNameMap[bookingEmail] 
                                        ? memberNameMap[bookingEmail] 
                                        : booking?.user_name || 'Booked';
                                    const isTrackmanMatched = !!(booking as any)?.trackman_booking_id || (booking?.notes && booking.notes.includes('[Trackman Import ID:'));
                                    const hasKnownInactiveStatus = bookingMemberStatus && bookingMemberStatus.toLowerCase() !== 'active' && bookingMemberStatus.toLowerCase() !== 'unknown';
                                    const isInactiveMember = booking && bookingEmail && isTrackmanMatched && hasKnownInactiveStatus;
                                    const isUnmatched = !!(booking as any)?.is_unmatched || (booking && (() => {
                                        const e = (booking.user_email || '').toLowerCase();
                                        return !e || e.includes('@trackman.local') || e.includes('@visitors.evenhouse.club') || e.startsWith('unmatched-') || e.startsWith('golfnow-') || e.startsWith('classpass-') || e === 'unmatched@trackman.import' || booking.user_name === 'Unknown (Trackman)';
                                    })());
                                    const declaredPlayers = (booking as any)?.declared_player_count ?? 1;
                                    const unfilledSlots = (booking as any)?.unfilled_slots ?? 0;
                                    const filledSlots = Math.max(0, declaredPlayers - unfilledSlots);
                                    const hasPartialRoster = !isConference && booking && declaredPlayers > 1 && filledSlots < declaredPlayers;
                                    const isEmptyCell = !closure && !eventBlock && !booking && !pendingRequest;
                                    
                                    return (
                                        <div
                                            key={`${resource.id}-${slot}`}
                                            title={closure ? `CLOSED: ${closure.title}` : eventBlock ? `EVENT BLOCK: ${eventBlock.closureTitle || eventBlock.blockType || 'Blocked'}` : booking ? `${bookingDisplayName}${isUnmatched ? ' (UNMATCHED - Click to assign member)' : isInactiveMember ? ' (Inactive Member)' : ''} - Click for details` : pendingRequest ? `PENDING: ${pendingRequest.user_name || 'Request'} - Awaiting Trackman sync` : `${resource.type === 'conference_room' ? 'Conference Room' : resource.name} - ${formatTime12Hour(slot)} (Available)`}
                                            onClick={closure || eventBlock ? undefined : isEmptyCell ? () => {
                                                setStaffManualBookingDefaults({
                                                    resourceId: resource.id,
                                                    startTime: slot,
                                                    date: calendarDate,
                                                    initialMode: resource.type === 'conference_room' ? 'conference' : 'member'
                                                });
                                                setStaffManualBookingModalOpen(true);
                                            } : booking ? () => setBookingSheet({
                                                isOpen: true,
                                                trackmanBookingId: (booking as any).trackman_booking_id || null,
                                                bookingId: booking.id,
                                                mode: isUnmatched ? 'assign' as const : 'manage' as const,
                                                bayName: resource.type === 'conference_room' ? 'Conference Room' : resource.name,
                                                bookingDate: formatDateShortAdmin(booking.request_date),
                                                timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                                                matchedBookingId: Number(booking.id),
                                                currentMemberName: isUnmatched ? undefined : ((booking as any).user_name || undefined),
                                                currentMemberEmail: isUnmatched ? undefined : ((booking as any).user_email || undefined),
                                                ownerName: (booking as any).user_name || undefined,
                                                ownerEmail: (booking as any).user_email || undefined,
                                                declaredPlayerCount: (booking as any).declared_player_count || (booking as any).player_count || 1,
                                                isRelink: !isUnmatched,
                                                importedName: (booking as any).user_name || (booking as any).userName,
                                                notes: (booking as any).notes || (booking as any).note,
                                                bookingStatus: (booking as any).status,
                                                bookingContext: { requestDate: booking.request_date, startTime: booking.start_time, endTime: booking.end_time, resourceId: booking.resource_id || undefined, resourceName: (resource.type === 'conference_room' ? 'Conference Room' : resource.name) || undefined, durationMinutes: (booking as any).duration_minutes || undefined, trackmanCustomerNotes: (booking as any).trackman_customer_notes || undefined },
                                                ownerMembershipStatus: bookingMemberStatus || null,
                                            }) : pendingRequest ? () => setTrackmanModal({ isOpen: true, booking: pendingRequest }) : undefined}
                                            className={`h-7 sm:h-8 rounded ${
                                                closure
                                                    ? 'bg-red-100 dark:bg-red-500/20 border border-red-300 dark:border-red-500/30'
                                                    : eventBlock
                                                        ? 'bg-orange-100 dark:bg-orange-500/20 border border-orange-300 dark:border-orange-500/30'
                                                    : booking 
                                                        ? isConference
                                                            ? 'bg-purple-100 dark:bg-purple-500/20 border border-purple-300 dark:border-purple-500/30 cursor-pointer hover:bg-purple-200 dark:hover:bg-purple-500/30'
                                                            : isUnmatched
                                                                ? 'bg-amber-100 dark:bg-amber-500/20 border-2 border-dashed border-amber-400 dark:border-amber-400/50 cursor-pointer hover:bg-amber-200 dark:hover:bg-amber-500/30'
                                                            : isInactiveMember
                                                                ? 'bg-green-100/50 dark:bg-green-500/10 border border-dashed border-orange-300 dark:border-orange-500/40 cursor-pointer hover:bg-green-200/50 dark:hover:bg-green-500/20'
                                                                : hasPartialRoster
                                                                    ? 'bg-blue-100 dark:bg-blue-600/20 border-2 border-dashed border-blue-400 dark:border-blue-400/50 cursor-pointer hover:bg-blue-200 dark:hover:bg-blue-600/30'
                                                                    : 'bg-green-100 dark:bg-green-500/20 border border-green-300 dark:border-green-500/30 cursor-pointer hover:bg-green-200 dark:hover:bg-green-500/30' 
                                                        : pendingRequest
                                                                ? 'bg-blue-50 dark:bg-blue-500/10 border-2 border-dashed border-blue-400 dark:border-blue-400/50 cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-500/20'
                                                                : 'bg-white dark:bg-white/5 border border-gray-200 dark:border-white/15 cursor-pointer hover:bg-gray-100 dark:hover:bg-white/10'
                                            } transition-all duration-150`}
                                        >
                                            {closure ? (
                                                <div className="px-0.5 sm:px-1 h-full flex items-center justify-center">
                                                    <span className="hidden sm:block text-[9px] sm:text-[10px] font-medium truncate text-red-600 dark:text-red-400">
                                                        CLOSED
                                                    </span>
                                                    <span className="sm:hidden text-[8px] font-bold text-red-600 dark:text-red-400">X</span>
                                                </div>
                                            ) : eventBlock ? (
                                                <div className="px-0.5 sm:px-1 h-full flex items-center justify-center">
                                                    <span className="hidden sm:block text-[9px] sm:text-[10px] font-medium truncate text-orange-600 dark:text-orange-400">
                                                        EVENT
                                                    </span>
                                                    <span className="sm:hidden text-[8px] font-bold text-orange-600 dark:text-orange-400">E</span>
                                                </div>
                                            ) : booking ? (
                                                <div className="px-0.5 sm:px-1 h-full flex items-center justify-center sm:justify-start relative">
                                                    {(() => {
                                                        const unfilledSlotsInner = (booking as any)?.unfilled_slots ?? 0;
                                                        const declaredPlayersInner = (booking as any)?.declared_player_count ?? 1;
                                                        const filledSlotsInner = Math.max(0, declaredPlayersInner - unfilledSlotsInner);
                                                        const snapshotPaid = (booking as any)?.fee_snapshot_paid === true;
                                                        const estimatedFromTier = snapshotPaid ? 0 : estimateFeeByTier((booking as any)?.tier, (booking as any)?.duration_minutes || 0, declaredPlayersInner, guestFeeDollars, overageRatePerBlockDollars, tierMinutes);
                                                        const dbTotalOwed = (booking as any)?.total_owed ?? 0;
                                                        const hasUnpaidFees = !snapshotPaid && (((booking as any)?.has_unpaid_fees === true) || 
                                                            (dbTotalOwed > 0) || 
                                                            (filledSlotsInner < declaredPlayersInner && estimatedFromTier > 0));
                                                        const unfilledGuestFees = Math.max(0, declaredPlayersInner - filledSlotsInner) * guestFeeDollars;
                                                        const totalOwed = dbTotalOwed > 0 ? dbTotalOwed + unfilledGuestFees : (filledSlotsInner < declaredPlayersInner ? estimatedFromTier : 0);
                                                        const isPartialRoster = !isConference && declaredPlayersInner > 1 && filledSlotsInner < declaredPlayersInner;
                                                        const textColor = isConference 
                                                            ? 'text-purple-700 dark:text-purple-300' 
                                                            : isUnmatched
                                                                ? 'text-amber-700 dark:text-amber-300'
                                                            : isInactiveMember 
                                                                ? 'text-green-600/70 dark:text-green-400/70' 
                                                            : isPartialRoster
                                                                ? 'text-blue-700 dark:text-blue-300'
                                                                : 'text-green-700 dark:text-green-300';
                                                        
                                                        return (
                                                            <>
                                                                <span className={`hidden sm:flex items-center gap-1 text-[9px] sm:text-[10px] font-medium truncate ${textColor}`}>
                                                                    <span className="truncate">{bookingDisplayName}</span>
                                                                    {declaredPlayersInner > 1 && (
                                                                        <span className="text-[8px] opacity-70" title={`${filledSlotsInner}/${declaredPlayersInner} slots filled`}>
                                                                            {filledSlotsInner}/{declaredPlayersInner}
                                                                        </span>
                                                                    )}
                                                                </span>
                                                                
                                                                {declaredPlayersInner > 1 || hasUnpaidFees ? (
                                                                    <span className={`sm:hidden text-[9px] font-bold ${hasUnpaidFees ? 'text-red-600 dark:text-red-400' : textColor}`} title={`${bookingDisplayName}${hasUnpaidFees ? ` - $${totalOwed.toFixed(2)} owed` : ''}`}>
                                                                        {filledSlotsInner}/{declaredPlayersInner}
                                                                    </span>
                                                                ) : (
                                                                    <span className={`sm:hidden w-3 h-3 rounded-full ${isConference ? 'bg-purple-500 dark:bg-purple-400' : isUnmatched ? 'bg-amber-500 dark:bg-amber-400' : 'bg-green-500 dark:bg-green-400'}`} title={bookingDisplayName}></span>
                                                                )}
                                                                
                                                                {hasUnpaidFees && (
                                                                    <span className="hidden sm:block absolute -top-1 -right-1 group">
                                                                        <span className="w-2.5 h-2.5 rounded-full bg-red-500 dark:bg-red-400 block cursor-help border border-white dark:border-gray-800"></span>
                                                                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs font-medium text-white bg-gray-800 dark:bg-gray-700 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                                                                            ${totalOwed.toFixed(2)} owed
                                                                        </span>
                                                                    </span>
                                                                )}
                                                            </>
                                                        );
                                                    })()}
                                                </div>
                                            ) : pendingRequest && (
                                                <div className="px-0.5 sm:px-1 h-full flex items-center justify-center sm:justify-start">
                                                    <span className="hidden sm:block text-[9px] sm:text-[10px] font-medium truncate text-blue-600 dark:text-blue-400">
                                                        {pendingRequest.user_name || 'Pending'}
                                                    </span>
                                                    <span className="sm:hidden w-3 h-3 rounded-full border-2 border-dashed border-blue-400 dark:border-blue-400" title={pendingRequest.user_name || 'Pending'}></span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </React.Fragment>
                            )
                        })}
                    </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CalendarGrid;
