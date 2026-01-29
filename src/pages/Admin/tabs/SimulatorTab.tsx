import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useData } from '../../../contexts/DataContext';
import { usePageReady } from '../../../contexts/PageReadyContext';
import { getTodayPacific, addDaysToPacificDate, formatDateDisplayWithDay, formatTime12Hour, getRelativeDateLabel, formatDuration, formatRelativeTime } from '../../../utils/dateUtils';
import { getStatusBadge, formatStatusLabel } from '../../../utils/statusColors';
import TierBadge from '../../../components/TierBadge';
import { SwipeableListItem } from '../../../components/SwipeableListItem';
import ModalShell from '../../../components/ModalShell';
import { useToast } from '../../../components/Toast';
import { useTheme } from '../../../contexts/ThemeContext';
import { TabType } from '../layout/types';
import BookingMembersEditor from '../../../components/admin/BookingMembersEditor';
import { CheckinBillingModal } from '../../../components/staff-command-center/modals/CheckinBillingModal';
import { CompleteRosterModal } from '../../../components/staff-command-center/modals/CompleteRosterModal';
import { TrackmanBookingModal } from '../../../components/staff-command-center/modals/TrackmanBookingModal';
import { TrackmanLinkModal } from '../../../components/staff-command-center/modals/TrackmanLinkModal';
import { StaffManualBookingModal, type StaffManualBookingData } from '../../../components/staff-command-center/modals/StaffManualBookingModal';
import { AnimatedPage } from '../../../components/motion';
import { TrackmanWebhookEventsSection } from '../../../components/staff-command-center/sections/TrackmanWebhookEventsSection';
import FloatingActionButton from '../../../components/FloatingActionButton';

interface BookingRequest {
    id: number | string;
    user_email: string | null;
    user_name: string | null;
    resource_id: number | null;
    bay_name: string | null;
    resource_preference: string | null;
    request_date: string;
    start_time: string;
    end_time: string;
    duration_minutes: number | null;
    notes: string | null;
    status: 'pending' | 'pending_approval' | 'approved' | 'declined' | 'cancelled' | 'confirmed' | 'attended' | 'no_show';
    staff_notes: string | null;
    suggested_time: string | null;
    created_at: string | null;
    source?: 'booking_request' | 'booking' | 'calendar';
    resource_name?: string;
    first_name?: string;
    last_name?: string;
    reschedule_booking_id?: number | null;
    tier?: string | null;
    trackman_booking_id?: string | null;
    has_unpaid_fees?: boolean;
    total_owed?: number;
    guardian_name?: string | null;
    guardian_relationship?: string | null;
    guardian_phone?: string | null;
    guardian_consent_at?: string | null;
}

interface Bay {
    id: number;
    name: string;
    description: string;
}

interface Resource {
    id: number;
    name: string;
    type: string;
    description: string | null;
}

interface CalendarClosure {
    id: number;
    title: string;
    startDate: string;
    endDate: string;
    startTime: string | null;
    endTime: string | null;
    affectedAreas: string;
    reason: string | null;
}

interface AvailabilityBlock {
    id: number;
    resourceId: number;
    blockDate: string;
    startTime: string;
    endTime: string;
    blockType: string;
    notes: string | null;
    closureTitle?: string | null;
}

const formatDateShortAdmin = (dateStr: string): string => {
    if (!dateStr) return 'No Date';
    const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    return formatDateDisplayWithDay(datePart);
};

interface MemberSearchResult {
    email: string;
    firstName: string | null;
    lastName: string | null;
    tier: string | null;
    status: string | null;
}

interface ManualBookingResult {
    id: number;
    user_email: string;
    user_name: string | null;
    resource_id: number;
    bay_name: string | null;
    request_date: string;
    start_time: string;
    end_time: string;
    duration_minutes: number;
    status: 'approved' | 'confirmed';
    notes: string | null;
    staff_notes: string | null;
}

const ManualBookingModal: React.FC<{
    resources: Resource[];
    onClose: () => void;
    onSuccess: (booking?: ManualBookingResult) => void;
    defaultMemberEmail?: string;
    rescheduleFromId?: number;
    defaultResourceId?: number;
    defaultDate?: string;
    defaultStartTime?: string;
}> = ({ resources, onClose, onSuccess, defaultMemberEmail, rescheduleFromId, defaultResourceId, defaultDate, defaultStartTime }) => {
    const { showToast } = useToast();
    const [memberEmail, setMemberEmail] = useState(defaultMemberEmail || '');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<MemberSearchResult[]>([]);
    const [showDropdown, setShowDropdown] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const [allMembers, setAllMembers] = useState<MemberSearchResult[]>([]);
    const [memberLookupStatus, setMemberLookupStatus] = useState<'idle' | 'checking' | 'found' | 'not_found'>('idle');
    const [memberName, setMemberName] = useState<string | null>(null);
    const [memberTier, setMemberTier] = useState<string | null>(null);
    const [bookingDate, setBookingDate] = useState(() => defaultDate || getTodayPacific());
    const [startTime, setStartTime] = useState(defaultStartTime || '10:00');
    const [durationMinutes, setDurationMinutes] = useState(60);
    const [resourceId, setResourceId] = useState<number | ''>(defaultResourceId || '');
    const [guestCount, setGuestCount] = useState(0);
    const [bookingSource, setBookingSource] = useState<string>('Trackman');
    const [notes, setNotes] = useState('');
    const [staffNotes, setStaffNotes] = useState('');
    const [trackmanBookingId, setTrackmanBookingId] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [existingBookingWarning, setExistingBookingWarning] = useState<string | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const availableDurations = useMemo(() => [30, 60, 90, 120, 150, 180, 210, 240, 270, 300], []);

    const lookupTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        if (defaultResourceId !== undefined) setResourceId(defaultResourceId || '');
    }, [defaultResourceId]);

    useEffect(() => {
        if (defaultDate !== undefined) setBookingDate(defaultDate || getTodayPacific());
    }, [defaultDate]);

    useEffect(() => {
        if (defaultStartTime !== undefined) setStartTime(defaultStartTime || '10:00');
    }, [defaultStartTime]);

    useEffect(() => {
        const fetchMembers = async () => {
            try {
                const res = await fetch('/api/hubspot/contacts', { credentials: 'include' });
                if (res.ok) {
                    const rawData = await res.json();
                    const data = Array.isArray(rawData) ? rawData : (rawData.contacts || []);
                    const members: MemberSearchResult[] = data.map((m: { email: string; firstName?: string; lastName?: string; tier?: string }) => ({
                        email: m.email,
                        firstName: m.firstName || null,
                        lastName: m.lastName || null,
                        tier: m.tier || null
                    }));
                    setAllMembers(members);
                }
            } catch (err) {
                console.error('Failed to fetch members:', err);
            }
        };
        fetchMembers();
    }, []);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
                inputRef.current && !inputRef.current.contains(e.target as Node)) {
                setShowDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (!searchQuery || searchQuery.length < 2) {
            setSearchResults([]);
            setShowDropdown(false);
            return;
        }

        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        setIsSearching(true);
        searchTimeoutRef.current = setTimeout(() => {
            const query = searchQuery.toLowerCase();
            const filtered = allMembers.filter(m => {
                const fullName = `${m.firstName || ''} ${m.lastName || ''}`.toLowerCase();
                return m.email.toLowerCase().includes(query) || fullName.includes(query);
            }).slice(0, 10);
            setSearchResults(filtered);
            setShowDropdown(filtered.length > 0);
            setIsSearching(false);
        }, 200);

        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, [searchQuery, allMembers]);

    const handleSelectMember = (member: MemberSearchResult) => {
        setMemberEmail(member.email);
        setSearchQuery('');
        setShowDropdown(false);
        setMemberLookupStatus('found');
        setMemberName(member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : null);
        setMemberTier(member.tier);
    };

    useEffect(() => {
        if (!memberEmail || !memberEmail.includes('@')) {
            setMemberLookupStatus('idle');
            setMemberName(null);
            setMemberTier(null);
            return;
        }

        if (lookupTimeoutRef.current) {
            clearTimeout(lookupTimeoutRef.current);
        }

        setMemberLookupStatus('checking');
        lookupTimeoutRef.current = setTimeout(async () => {
            try {
                const normalizedEmail = memberEmail.toLowerCase().trim();
                const res = await fetch(`/api/members/${encodeURIComponent(normalizedEmail)}/details`, {
                    credentials: 'include'
                });
                if (res.ok) {
                    const member = await res.json();
                    setMemberLookupStatus('found');
                    setMemberName(member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : null);
                    if (member.tier && !memberTier) {
                        setMemberTier(member.tier);
                    }
                } else {
                    setMemberLookupStatus('not_found');
                    setMemberName(null);
                    setMemberTier(null);
                }
            } catch (err) {
                setMemberLookupStatus('not_found');
                setMemberName(null);
                setMemberTier(null);
            }
        }, 500);

        return () => {
            if (lookupTimeoutRef.current) {
                clearTimeout(lookupTimeoutRef.current);
            }
        };
    }, [memberEmail]);

    useEffect(() => {
        if (!memberEmail || memberLookupStatus !== 'found' || !bookingDate || !resourceId) {
            setExistingBookingWarning(null);
            return;
        }

        const checkExistingBookings = async () => {
            try {
                const selectedResource = resources.find(r => r.id === resourceId);
                const resourceType = selectedResource?.type || 'simulator';
                
                const res = await fetch(`/api/bookings/check-existing-staff?member_email=${encodeURIComponent(memberEmail)}&date=${bookingDate}&resource_type=${resourceType}`, {
                    credentials: 'include'
                });
                
                if (res.ok) {
                    const data = await res.json();
                    if (data.hasExisting) {
                        const typeLabel = resourceType === 'conference_room' ? 'conference room' : 'bay';
                        setExistingBookingWarning(`This member already has a ${typeLabel} booking on ${bookingDate}`);
                    } else {
                        setExistingBookingWarning(null);
                    }
                }
            } catch (err) {
                console.error('Failed to check existing bookings:', err);
            }
        };

        checkExistingBookings();
    }, [memberEmail, memberLookupStatus, bookingDate, resourceId, resources]);

    const handleSubmit = async () => {
        if (!memberEmail || memberLookupStatus !== 'found') {
            setError('Please enter a valid member email');
            return;
        }
        if (!resourceId) {
            setError('Please select a resource');
            return;
        }
        if (!bookingDate || !startTime) {
            setError('Please select date and time');
            return;
        }

        setIsSubmitting(true);
        setError(null);

        try {
            const res = await fetch('/api/staff/bookings/manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    member_email: memberEmail.toLowerCase().trim(),
                    resource_id: resourceId,
                    booking_date: bookingDate,
                    start_time: startTime,
                    duration_minutes: durationMinutes,
                    guest_count: guestCount,
                    booking_source: bookingSource,
                    notes: notes || undefined,
                    staff_notes: staffNotes || undefined,
                    trackman_booking_id: trackmanBookingId || undefined,
                    reschedule_from_id: rescheduleFromId
                })
            });

            if (res.ok) {
                const data = await res.json();
                showToast(rescheduleFromId ? 'Booking rescheduled successfully!' : 'Booking created successfully!', 'success');
                
                const selectedResource = resources.find(r => r.id === resourceId);
                const endTimeCalc = (() => {
                    const [h, m] = startTime.split(':').map(Number);
                    const totalMins = h * 60 + m + durationMinutes;
                    const endHour = Math.floor(totalMins / 60) % 24;
                    return `${endHour.toString().padStart(2, '0')}:${(totalMins % 60).toString().padStart(2, '0')}`;
                })();
                
                const bookingResult: ManualBookingResult = {
                    id: data.id || data.booking?.id || Date.now(),
                    user_email: memberEmail.toLowerCase().trim(),
                    user_name: memberName,
                    resource_id: resourceId as number,
                    bay_name: selectedResource?.name || null,
                    request_date: bookingDate,
                    start_time: startTime,
                    end_time: endTimeCalc,
                    duration_minutes: durationMinutes,
                    status: 'confirmed',
                    notes: notes || null,
                    staff_notes: staffNotes || null
                };
                
                onSuccess(bookingResult);
            } else {
                const data = await res.json();
                setError(data.message || data.error || 'Failed to create booking');
            }
        } catch (err) {
            setError('Network error. Please try again.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const timeSlots = useMemo(() => {
        const slots: string[] = [];
        for (let hour = 8; hour <= 21; hour++) {
            for (let minute = 0; minute < 60; minute += 5) {
                if (hour === 21 && minute > 30) break;
                slots.push(`${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`);
            }
        }
        return slots;
    }, []);

    const bookingSources = ['Trackman', 'YGB', 'Mindbody', 'Texted Concierge', 'Called', 'Other'];

    return (
        <ModalShell isOpen={true} onClose={onClose} title={rescheduleFromId ? 'Reschedule Booking' : 'Manual Booking'} showCloseButton={true}>
            <div className="p-6 space-y-4">
                {error && (
                        <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg">
                            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                        </div>
                    )}

                    <div className="space-y-4">
                        <div className="relative">
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Member *</label>
                            {memberEmail && memberLookupStatus === 'found' ? (
                                <div className="w-full p-3 rounded-lg border border-green-300 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 flex items-center justify-between">
                                    <div>
                                        <p className="text-sm font-medium text-primary dark:text-white">{memberName || memberEmail}</p>
                                        {memberName && <p className="text-xs text-gray-500 dark:text-gray-400">{memberEmail}</p>}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setMemberEmail('');
                                            setMemberName(null);
                                            setMemberTier(null);
                                            setMemberLookupStatus('idle');
                                            setSearchQuery('');
                                            setExistingBookingWarning(null);
                                        }}
                                        className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
                                    >
                                        <span aria-hidden="true" className="material-symbols-outlined text-gray-500 dark:text-gray-400 text-sm">close</span>
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <div className="relative">
                                        <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 dark:text-gray-500 text-lg">search</span>
                                        <input
                                            ref={inputRef}
                                            type="text"
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            onFocus={() => searchQuery.length >= 2 && searchResults.length > 0 && setShowDropdown(true)}
                                            placeholder="Search by name or email..."
                                            className="w-full p-3 pl-10 rounded-lg border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-primary dark:text-white"
                                        />
                                        {isSearching && (
                                            <span aria-hidden="true" className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 dark:text-gray-500 text-lg animate-spin">progress_activity</span>
                                        )}
                                    </div>
                                    {showDropdown && searchResults.length > 0 && (
                                        <div 
                                            ref={dropdownRef}
                                            className="absolute z-50 w-full mt-1 bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/20 rounded-lg shadow-lg max-h-60 overflow-y-auto"
                                        >
                                            {searchResults.map((member, idx) => (
                                                <button
                                                    key={member.email}
                                                    type="button"
                                                    onClick={() => handleSelectMember(member)}
                                                    className={`w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-white/5 flex items-center justify-between ${idx !== searchResults.length - 1 ? 'border-b border-gray-200 dark:border-white/20' : ''}`}
                                                >
                                                    <div>
                                                        <p className="text-sm font-medium text-primary dark:text-white">
                                                            {member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.email}
                                                        </p>
                                                        {member.firstName && member.lastName && (
                                                            <p className="text-xs text-gray-500 dark:text-gray-400">{member.email}</p>
                                                        )}
                                                    </div>
                                                    {member.tier && (
                                                        <span className="text-xs px-2 py-0.5 rounded-full bg-accent/20 text-primary dark:text-accent font-medium">
                                                            {member.tier}
                                                        </span>
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    {searchQuery.length >= 2 && !isSearching && searchResults.length === 0 && (
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">No members found matching "{searchQuery}"</p>
                                    )}
                                </>
                            )}
                            {memberLookupStatus === 'checking' && (
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-1">
                                    <span aria-hidden="true" className="material-symbols-outlined text-xs animate-spin">progress_activity</span>
                                    Looking up member...
                                </p>
                            )}
                            {memberLookupStatus === 'not_found' && (
                                <p className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-center gap-1">
                                    <span aria-hidden="true" className="material-symbols-outlined text-xs">error</span>
                                    Member not found
                                </p>
                            )}
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Resource *</label>
                            <select
                                value={resourceId}
                                onChange={(e) => setResourceId(e.target.value ? Number(e.target.value) : '')}
                                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-primary dark:text-white"
                            >
                                <option value="">Select a bay or room...</option>
                                {resources.map(r => (
                                    <option key={r.id} value={r.id}>
                                        {r.type === 'conference_room' ? 'Conference Room' : r.name}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date *</label>
                                <input
                                    type="date"
                                    value={bookingDate}
                                    onChange={(e) => setBookingDate(e.target.value)}
                                    className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-primary dark:text-white"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Time *</label>
                                <select
                                    value={startTime}
                                    onChange={(e) => setStartTime(e.target.value)}
                                    className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-primary dark:text-white"
                                >
                                    {timeSlots.map(slot => (
                                        <option key={slot} value={slot}>{formatTime12Hour(slot)}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        {existingBookingWarning && (
                            <div className="p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg">
                                <p className="text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2">
                                    <span aria-hidden="true" className="material-symbols-outlined text-base">warning</span>
                                    {existingBookingWarning}
                                </p>
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                    Duration *
                                    {memberTier && (
                                        <span className="ml-1 text-xs text-gray-600 dark:text-gray-500 font-normal">
                                            ({memberTier})
                                        </span>
                                    )}
                                </label>
                                <select
                                    value={durationMinutes}
                                    onChange={(e) => setDurationMinutes(Number(e.target.value))}
                                    className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-primary dark:text-white"
                                >
                                    {availableDurations.map(d => (
                                        <option key={d} value={d}>{d} minutes</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Guests</label>
                                <input
                                    type="number"
                                    min="0"
                                    max="10"
                                    value={guestCount}
                                    onChange={(e) => setGuestCount(Math.max(0, parseInt(e.target.value) || 0))}
                                    className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-primary dark:text-white"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Booking Source *</label>
                            <select
                                value={bookingSource}
                                onChange={(e) => setBookingSource(e.target.value)}
                                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-primary dark:text-white"
                            >
                                {bookingSources.map(source => (
                                    <option key={source} value={source}>{source}</option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
                            <textarea
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                placeholder="Any additional notes..."
                                rows={2}
                                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-primary dark:text-white resize-none"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Staff Notes (optional)
                                <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">- Staff only, not visible to member</span>
                            </label>
                            <textarea
                                value={staffNotes}
                                onChange={(e) => setStaffNotes(e.target.value)}
                                placeholder="Internal notes about this booking (e.g., private event, Trackman import, special arrangements)..."
                                rows={2}
                                className="w-full p-3 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-primary dark:text-white resize-none"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-amber-700 dark:text-amber-400 mb-1">
                                Trackman Booking ID <span className="text-gray-500 dark:text-gray-400 font-normal">(optional)</span>
                            </label>
                            <input
                                type="text"
                                value={trackmanBookingId}
                                onChange={(e) => setTrackmanBookingId(e.target.value)}
                                placeholder="e.g., TM-12345"
                                className="w-full p-3 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-primary dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Enter the ID from Trackman to link this booking for easier import matching
                            </p>
                        </div>
                    </div>

                <div className="flex gap-3 mt-6">
                    <button
                        onClick={onClose}
                        className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
                        disabled={isSubmitting}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={isSubmitting || memberLookupStatus !== 'found' || !resourceId}
                        className="flex-1 py-3 px-4 rounded-lg bg-primary text-white font-medium flex items-center justify-center gap-2 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isSubmitting ? (
                            <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                        ) : (
                            <span aria-hidden="true" className="material-symbols-outlined text-sm">add</span>
                        )}
                        Create Booking
                    </button>
                </div>
            </div>
        </ModalShell>
    );
};

const SimulatorTab: React.FC<{ onTabChange: (tab: TabType) => void }> = ({ onTabChange }) => {
    const { setPageReady } = usePageReady();
    const { user, actualUser, members } = useData();
    
    // Create a Set of active member emails for fast lookup
    const activeMemberEmails = useMemo(() => 
        new Set(members.map(m => m.email.toLowerCase())),
        [members]
    );
    
    // Map of all member emails to their status (for showing actual status of inactive members)
    const [memberStatusMap, setMemberStatusMap] = useState<Record<string, string>>({});
    // Map of all member emails to their proper formatted name from the directory
    const [memberNameMap, setMemberNameMap] = useState<Record<string, string>>({});
    const { showToast } = useToast();
    const { effectiveTheme } = useTheme();
    const isDark = effectiveTheme === 'dark';
    const [activeView, setActiveView] = useState<'requests' | 'calendar'>('requests');
    const [requests, setRequests] = useState<BookingRequest[]>([]);
    const [bays, setBays] = useState<Bay[]>([]);
    const [resources, setResources] = useState<Resource[]>([]);
    const [approvedBookings, setApprovedBookings] = useState<BookingRequest[]>([]);
    const [closures, setClosures] = useState<CalendarClosure[]>([]);
    const [availabilityBlocks, setAvailabilityBlocks] = useState<AvailabilityBlock[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedRequest, setSelectedRequest] = useState<BookingRequest | null>(null);
    const [actionModal, setActionModal] = useState<'approve' | 'decline' | null>(null);
    const [selectedBayId, setSelectedBayId] = useState<number | null>(null);
    const [staffNotes, setStaffNotes] = useState('');
    const [suggestedTime, setSuggestedTime] = useState('');
    const [declineAvailableSlots, setDeclineAvailableSlots] = useState<string[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [availabilityStatus, setAvailabilityStatus] = useState<'checking' | 'available' | 'conflict' | null>(null);
    const [conflictDetails, setConflictDetails] = useState<string | null>(null);
    const [showTrackmanConfirm, setShowTrackmanConfirm] = useState(false);
    const [showManualBooking, setShowManualBooking] = useState(false);
    const [rescheduleEmail, setRescheduleEmail] = useState<string | null>(null);
    const [rescheduleBookingId, setRescheduleBookingId] = useState<number | null>(null);
    const [prefillResourceId, setPrefillResourceId] = useState<number | null>(null);
    const [prefillDate, setPrefillDate] = useState<string | null>(null);
    const [prefillStartTime, setPrefillStartTime] = useState<string | null>(null);
    const [selectedCalendarBooking, setSelectedCalendarBooking] = useState<BookingRequest | null>(null);
    const [isCancellingFromModal, setIsCancellingFromModal] = useState(false);
    const [isUnmatchingMember, setIsUnmatchingMember] = useState(false);
    const [scheduledFilter, setScheduledFilter] = useState<'all' | 'today' | 'tomorrow' | 'week'>('all');
    const [markStatusModal, setMarkStatusModal] = useState<{ booking: BookingRequest | null; confirmNoShow: boolean }>({ booking: null, confirmNoShow: false });
    
    const [calendarDate, setCalendarDate] = useState(() => getTodayPacific());
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
    const [editingTrackmanId, setEditingTrackmanId] = useState(false);
    const [trackmanIdDraft, setTrackmanIdDraft] = useState('');
    const [savingTrackmanId, setSavingTrackmanId] = useState(false);
    const [editingPlayerCount, setEditingPlayerCount] = useState(false);
    const [playerCountDraft, setPlayerCountDraft] = useState<number>(1);
    const [savingPlayerCount, setSavingPlayerCount] = useState(false);
    const [membersEditorKey, setMembersEditorKey] = useState(0);
    const [feeEstimate, setFeeEstimate] = useState<{
      totalFee: number;
      ownerTier: string | null;
      perPersonMins: number;
      feeBreakdown: {
        overageMinutes: number;
        overageFee: number;
        guestCount: number;
        guestPassesRemaining: number;
        guestsUsingPasses: number;
        guestsCharged: number;
        guestFees: number;
      };
      note: string;
    } | null>(null);
    const [isFetchingFeeEstimate, setIsFetchingFeeEstimate] = useState(false);
    const [billingModal, setBillingModal] = useState<{isOpen: boolean; bookingId: number | null}>({isOpen: false, bookingId: null});
    const [rosterModal, setRosterModal] = useState<{isOpen: boolean; bookingId: number | null}>({isOpen: false, bookingId: null});
    const [trackmanModal, setTrackmanModal] = useState<{ isOpen: boolean; booking: BookingRequest | null }>({ isOpen: false, booking: null });
    const [trackmanLinkModal, setTrackmanLinkModal] = useState<{ 
        isOpen: boolean; 
        trackmanBookingId: string | null;
        bayName?: string;
        bookingDate?: string;
        timeSlot?: string;
        matchedBookingId?: number;
        currentMemberName?: string;
        currentMemberEmail?: string;
        isRelink?: boolean;
        importedName?: string;
        notes?: string;
    }>({ isOpen: false, trackmanBookingId: null });
    const [cancelConfirmModal, setCancelConfirmModal] = useState<{
        isOpen: boolean;
        booking: BookingRequest | null;
        hasTrackman: boolean;
        isCancelling: boolean;
        showSuccess: boolean;
    }>({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false });
    const [staffManualBookingModalOpen, setStaffManualBookingModalOpen] = useState(false);
    const [staffManualBookingDefaults, setStaffManualBookingDefaults] = useState<{
        resourceId?: number;
        startTime?: string;
        date?: string;
    }>({});
    
    // Refs for syncing queue height to calendar height
    const calendarColRef = useRef<HTMLDivElement>(null);
    const [queueMaxHeight, setQueueMaxHeight] = useState<number | null>(null);
    
    // Sync queue height to match calendar height
    useLayoutEffect(() => {
        const syncHeights = () => {
            if (calendarColRef.current) {
                const calendarHeight = calendarColRef.current.offsetHeight;
                if (calendarHeight > 0) {
                    setQueueMaxHeight(calendarHeight);
                }
            }
        };
        
        // Small delay to ensure calendar is rendered
        const timer = setTimeout(syncHeights, 100);
        
        // Also sync on window resize
        window.addEventListener('resize', syncHeights);
        
        // Use ResizeObserver to detect calendar content changes
        const observer = new ResizeObserver(syncHeights);
        if (calendarColRef.current) {
            observer.observe(calendarColRef.current);
        }
        
        return () => {
            clearTimeout(timer);
            window.removeEventListener('resize', syncHeights);
            observer.disconnect();
        };
    }, [isLoading, calendarDate]);

    useEffect(() => {
        setEditingTrackmanId(false);
        setTrackmanIdDraft('');
        setSavingTrackmanId(false);
        setEditingPlayerCount(false);
        setPlayerCountDraft(1);
        setSavingPlayerCount(false);
    }, [selectedCalendarBooking]);

    useEffect(() => {
        const fetchAllMemberStatuses = async () => {
            try {
                // Fetch all members (including inactive) for status and name maps
                const res = await fetch('/api/hubspot/contacts?status=all', { credentials: 'include' });
                if (res.ok) {
                    const rawData = await res.json();
                    const data = Array.isArray(rawData) ? rawData : (rawData.contacts || []);
                    const statusMap: Record<string, string> = {};
                    const nameMap: Record<string, string> = {};
                    data.forEach((m: { email: string; status?: string; firstName?: string; lastName?: string; manuallyLinkedEmails?: string[] }) => {
                        const fullName = [m.firstName, m.lastName].filter(Boolean).join(' ');
                        if (m.email) {
                            const emailLower = m.email.toLowerCase();
                            statusMap[emailLower] = m.status || 'unknown';
                            // Build proper formatted name from directory
                            if (fullName) {
                                nameMap[emailLower] = fullName;
                            }
                        }
                        // Also add manually linked emails to the maps
                        if (m.manuallyLinkedEmails && fullName) {
                            m.manuallyLinkedEmails.forEach((linkedEmail: string) => {
                                if (linkedEmail) {
                                    const linkedEmailLower = linkedEmail.toLowerCase();
                                    statusMap[linkedEmailLower] = m.status || 'unknown';
                                    nameMap[linkedEmailLower] = fullName;
                                }
                            });
                        }
                    });
                    setMemberStatusMap(statusMap);
                    setMemberNameMap(nameMap);
                }
            } catch (err) {
                console.error('Failed to fetch member statuses:', err);
            }
        };
        
        fetchAllMemberStatuses();
    }, []);

    useEffect(() => {
        if (!isLoading) {
            setPageReady(true);
        }
    }, [isLoading, setPageReady]);


    useEffect(() => {
        const openBookingById = async (bookingId: number | string) => {
            try {
                const res = await fetch(`/api/booking-requests?id=${bookingId}`, { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.length > 0) {
                        setSelectedCalendarBooking(data[0]);
                    }
                }
            } catch (err) {
                console.error('Failed to open booking details:', err);
            }
        };
        
        const handleOpenBookingDetails = async (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.bookingId) {
                await openBookingById(detail.bookingId);
            }
        };
        window.addEventListener('open-booking-details', handleOpenBookingDetails);
        
        // Check for pending roster booking from StaffCommandCenter check-in
        const pendingBookingId = sessionStorage.getItem('pendingRosterBookingId');
        if (pendingBookingId) {
            sessionStorage.removeItem('pendingRosterBookingId');
            openBookingById(pendingBookingId);
        }
        
        return () => window.removeEventListener('open-booking-details', handleOpenBookingDetails);
    }, []);

    useEffect(() => {
        if (actionModal || showTrackmanConfirm || selectedCalendarBooking || markStatusModal.booking) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    }, [actionModal, showTrackmanConfirm, selectedCalendarBooking, markStatusModal.booking]);

    const fetchData = useCallback(async () => {
        setIsLoading(true);
        try {
            const results = await Promise.allSettled([
                fetch('/api/booking-requests?include_all=true'),
                fetch('/api/pending-bookings'),
                fetch('/api/bays'),
                fetch('/api/resources')
            ]);
            
            let allRequests: BookingRequest[] = [];
            
            if (results[0].status === 'fulfilled' && results[0].value.ok) {
                const data = await results[0].value.json();
                allRequests = data.map((r: any) => ({ ...r, source: 'booking_request' as const }));
            }
            
            if (results[1].status === 'fulfilled' && results[1].value.ok) {
                const pendingBookings = await results[1].value.json();
                const mappedBookings = pendingBookings.map((b: any) => ({
                    id: b.id,
                    user_email: b.user_email,
                    user_name: b.first_name && b.last_name ? `${b.first_name} ${b.last_name}` : b.user_email,
                    resource_id: null,
                    bay_name: null,
                    resource_preference: b.resource_name || null,
                    request_date: b.booking_date,
                    start_time: b.start_time,
                    end_time: b.end_time,
                    duration_minutes: 60,
                    notes: b.notes,
                    status: b.status,
                    staff_notes: null,
                    suggested_time: null,
                    created_at: b.created_at,
                    source: 'booking' as const,
                    resource_name: b.resource_name
                }));
                allRequests = [...allRequests, ...mappedBookings];
            }
            
            setRequests(allRequests);
            
            if (results[2].status === 'fulfilled' && results[2].value.ok) {
                const data = await results[2].value.json();
                setBays(data);
            }
            
            if (results[3].status === 'fulfilled' && results[3].value.ok) {
                const data = await results[3].value.json();
                setResources(data);
            }
        } catch (err) {
            console.error('Failed to fetch data:', err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const fetchCalendarData = useCallback(async () => {
        const today = getTodayPacific();
        const baseDate = activeView === 'calendar' ? calendarDate : today;
        const startDate = addDaysToPacificDate(baseDate, -60);
        const endDate = addDaysToPacificDate(baseDate, 30);
        try {
            const [bookingsRes, closuresRes, blocksRes] = await Promise.all([
                fetch(`/api/approved-bookings?start_date=${startDate}&end_date=${endDate}`),
                fetch('/api/closures'),
                fetch(`/api/availability-blocks?start_date=${startDate}&end_date=${endDate}`)
            ]);
            
            if (bookingsRes.ok) {
                const data = await bookingsRes.json();
                setApprovedBookings(data);
            }
            
            if (closuresRes.ok) {
                const closuresData = await closuresRes.json();
                const activeClosures = closuresData.filter((c: CalendarClosure) => 
                    c.startDate <= endDate && c.endDate >= startDate
                );
                setClosures(activeClosures);
            }
            
            if (blocksRes.ok) {
                const blocksData = await blocksRes.json();
                const mappedBlocks: AvailabilityBlock[] = blocksData.map((b: any) => ({
                    id: b.id,
                    resourceId: b.resource_id,
                    blockDate: b.block_date,
                    startTime: b.start_time,
                    endTime: b.end_time,
                    blockType: b.block_type,
                    notes: b.notes,
                    closureTitle: b.closure_title
                }));
                setAvailabilityBlocks(mappedBlocks);
            }
        } catch (err) {
            console.error('Failed to fetch calendar data:', err);
        }
    }, [activeView, calendarDate]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    useEffect(() => {
        fetchCalendarData().then(() => {
            setLastRefresh(new Date());
        });
    }, [fetchCalendarData]);

    const handleRefresh = useCallback(async () => {
        await Promise.all([fetchData(), fetchCalendarData()]);
        setLastRefresh(new Date());
    }, [fetchData, fetchCalendarData]);

    useEffect(() => {
        const handleBookingUpdate = () => {
            console.log('[SimulatorTab] Global booking-update event received');
            handleRefresh();
        };
        window.addEventListener('booking-update', handleBookingUpdate);
        return () => window.removeEventListener('booking-update', handleBookingUpdate);
    }, [handleRefresh]);

    const handleTrackmanConfirm = useCallback(async (bookingId: number | string, trackmanExternalId: string) => {
        const apiId = typeof bookingId === 'string' ? parseInt(String(bookingId).replace('cal_', '')) : bookingId;
        const booking = requests.find(r => r.id === bookingId);
        
        const previousRequests = [...requests];
        setRequests(prev => prev.filter(r => r.id !== bookingId));

        try {
            const res = await fetch(`/api/booking-requests/${apiId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ 
                    status: 'approved',
                    trackman_external_id: trackmanExternalId
                })
            });
            if (res.ok) {
                showToast('Booking confirmed with Trackman', 'success');
                window.dispatchEvent(new CustomEvent('booking-action-completed'));
                handleRefresh();
            } else {
                const error = await res.json().catch(() => ({}));
                setRequests(previousRequests);
                throw new Error(error.error || 'Failed to confirm booking');
            }
        } catch (err: any) {
            setRequests(previousRequests);
            throw err;
        }
    }, [requests, showToast, handleRefresh]);

    const handleLinkTrackmanToMember = useCallback((event: {
        trackmanBookingId: string;
        bayName?: string;
        bookingDate?: string;
        timeSlot?: string;
        matchedBookingId?: number;
        currentMemberName?: string;
        currentMemberEmail?: string;
        isRelink?: boolean;
    }) => {
        setTrackmanLinkModal({
            isOpen: true,
            trackmanBookingId: event.trackmanBookingId,
            bayName: event.bayName,
            bookingDate: event.bookingDate,
            timeSlot: event.timeSlot,
            matchedBookingId: event.matchedBookingId,
            currentMemberName: event.currentMemberName,
            currentMemberEmail: event.currentMemberEmail,
            isRelink: event.isRelink
        });
    }, []);

    const handleStaffManualBookingSubmit = useCallback(async (data: StaffManualBookingData) => {
        const requestParticipants = data.participants.map(p => ({
            type: p.type,
            email: p.member?.email || p.email || '',
            userId: p.member?.id,
            name: p.member?.name || p.name
        })).filter(p => p.email || p.userId);

        const res = await fetch('/api/staff/manual-booking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                user_email: data.hostMember.email,
                user_name: data.hostMember.name,
                resource_id: data.resourceId,
                request_date: data.requestDate,
                start_time: data.startTime + ':00',
                duration_minutes: data.durationMinutes,
                declared_player_count: data.declaredPlayerCount,
                request_participants: requestParticipants,
                trackman_external_id: data.trackmanExternalId
            })
        });

        if (!res.ok) {
            const error = await res.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to create booking');
        }

        showToast('Booking created successfully', 'success');
        setStaffManualBookingModalOpen(false);
        handleRefresh();
    }, [showToast, handleRefresh]);

    const unmatchedBookings = useMemo(() => {
        const today = getTodayPacific();
        return approvedBookings.filter(b => 
            (b as any).is_unmatched === true && 
            b.request_date >= today &&
            (b.status === 'approved' || b.status === 'confirmed')
        ).sort((a, b) => {
            if (a.request_date !== b.request_date) {
                return a.request_date.localeCompare(b.request_date);
            }
            return a.start_time.localeCompare(b.start_time);
        });
    }, [approvedBookings]);

    const updateBookingStatusOptimistic = useCallback(async (
        booking: BookingRequest,
        newStatus: 'attended' | 'no_show' | 'cancelled'
    ): Promise<boolean> => {
        const previousRequests = [...requests];
        const previousApproved = [...approvedBookings];
        
        setRequests(prev => prev.map(r => 
            r.id === booking.id && r.source === booking.source 
                ? { ...r, status: newStatus } 
                : r
        ));
        setApprovedBookings(prev => prev.map(b => 
            b.id === booking.id && b.source === booking.source 
                ? { ...b, status: newStatus } 
                : b
        ));
        
        try {
            const res = await fetch(`/api/bookings/${booking.id}/checkin`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ status: newStatus, source: booking.source })
            });
            
            if (res.status === 402) {
                const errorData = await res.json();
                // Revert optimistic update
                setRequests(previousRequests);
                setApprovedBookings(previousApproved);
                
                // Open the appropriate modal based on what's needed
                const bookingId = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', '')) : booking.id;
                if (errorData.requiresRoster) {
                    setRosterModal({ isOpen: true, bookingId });
                } else {
                    setBillingModal({ isOpen: true, bookingId });
                }
                return false;
            }
            
            if (res.status === 400) {
                const errorData = await res.json();
                // If billing session not generated, allow user to proceed anyway
                if (errorData.requiresSync) {
                    // Retry with skipPaymentCheck to bypass the billing session check
                    const retryRes = await fetch(`/api/bookings/${booking.id}/checkin`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ status: newStatus, skipPaymentCheck: true })
                    });
                    if (retryRes.ok) {
                        showToast('Booking checked in (billing session pending)', 'success');
                        return true;
                    } else {
                        const retryErr = await retryRes.json();
                        throw new Error(retryErr.error || 'Failed to check in');
                    }
                }
                throw new Error(errorData.error || 'Failed to update status');
            }
            
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to update status');
            }
            
            const statusLabel = newStatus === 'attended' ? 'checked in' : 
                              newStatus === 'no_show' ? 'marked as no show' : 'cancelled';
            showToast(`Booking ${statusLabel}`, 'success');
            return true;
        } catch (err: any) {
            setRequests(previousRequests);
            setApprovedBookings(previousApproved);
            showToast(err.message || 'Failed to update booking', 'error');
            return false;
        }
    }, [requests, approvedBookings, showToast]);

    const showCancelConfirmation = useCallback((booking: BookingRequest) => {
        const hasTrackman = !!(booking.trackman_booking_id) || 
            (booking.notes && booking.notes.includes('[Trackman Import ID:'));
        setCancelConfirmModal({
            isOpen: true,
            booking,
            hasTrackman,
            isCancelling: false,
            showSuccess: false
        });
    }, []);

    const performCancellation = useCallback(async () => {
        const booking = cancelConfirmModal.booking;
        if (!booking) return;
        
        setCancelConfirmModal(prev => ({ ...prev, isCancelling: true }));
        
        const previousRequests = [...requests];
        const previousApproved = [...approvedBookings];
        
        setRequests(prev => prev.map(r => 
            r.id === booking.id && r.source === booking.source 
                ? { ...r, status: 'cancelled' } 
                : r
        ));
        setApprovedBookings(prev => prev.filter(b => 
            !(b.id === booking.id && b.source === booking.source)
        ));
        
        try {
            const res = await fetch(`/api/bookings/${booking.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ 
                    status: 'cancelled', 
                    source: booking.source,
                    cancelled_by: actualUser?.email
                })
            });
            
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to cancel booking');
            }
            
            showToast('Booking cancelled', 'success');
            
            if (cancelConfirmModal.hasTrackman) {
                setCancelConfirmModal(prev => ({ ...prev, isCancelling: false, showSuccess: true }));
            } else {
                setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false });
            }
        } catch (err: any) {
            setRequests(previousRequests);
            setApprovedBookings(previousApproved);
            showToast(err.message || 'Failed to cancel booking', 'error');
            setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false });
        }
    }, [cancelConfirmModal.booking, cancelConfirmModal.hasTrackman, requests, approvedBookings, actualUser?.email, showToast]);

    const cancelBookingOptimistic = useCallback(async (
        booking: BookingRequest
    ): Promise<boolean> => {
        showCancelConfirmation(booking);
        return true;
    }, [showCancelConfirmation]);

    useEffect(() => {
        const checkAvailability = async () => {
            if (!selectedBayId || !selectedRequest || actionModal !== 'approve') {
                setAvailabilityStatus(null);
                setConflictDetails(null);
                return;
            }
            
            setAvailabilityStatus('checking');
            setConflictDetails(null);
            
            try {
                const [bookingsRes, closuresRes] = await Promise.all([
                    fetch(`/api/approved-bookings?start_date=${selectedRequest.request_date}&end_date=${selectedRequest.request_date}`),
                    fetch('/api/closures')
                ]);
                
                let hasConflict = false;
                let details = '';
                
                if (bookingsRes.ok) {
                    const bookings = await bookingsRes.json();
                    const reqStart = selectedRequest.start_time;
                    const reqEnd = selectedRequest.end_time;
                    
                    const conflict = bookings.find((b: any) => 
                        b.resource_id === selectedBayId && 
                        b.request_date === selectedRequest.request_date &&
                        b.start_time < reqEnd && b.end_time > reqStart
                    );
                    
                    if (conflict) {
                        hasConflict = true;
                        details = `Conflicts with existing booking: ${formatTime12Hour(conflict.start_time)} - ${formatTime12Hour(conflict.end_time)}`;
                    }
                }
                
                if (!hasConflict && closuresRes.ok) {
                    const allClosures = await closuresRes.json();
                    const reqDate = selectedRequest.request_date;
                    const reqStartMins = parseInt(selectedRequest.start_time.split(':')[0]) * 60 + parseInt(selectedRequest.start_time.split(':')[1]);
                    const reqEndMins = parseInt(selectedRequest.end_time.split(':')[0]) * 60 + parseInt(selectedRequest.end_time.split(':')[1]);
                    
                    const closure = allClosures.find((c: any) => {
                        if (c.startDate > reqDate || c.endDate < reqDate) return false;
                        
                        const areas = c.affectedAreas;
                        const affectsResource = areas === 'entire_facility' || 
                            areas === 'all_bays' || 
                            areas.includes(String(selectedBayId));
                        
                        if (!affectsResource) return false;
                        
                        if (c.startTime && c.endTime) {
                            const closureStartMins = parseInt(c.startTime.split(':')[0]) * 60 + parseInt(c.startTime.split(':')[1]);
                            const closureEndMins = parseInt(c.endTime.split(':')[0]) * 60 + parseInt(c.endTime.split(':')[1]);
                            return reqStartMins < closureEndMins && reqEndMins > closureStartMins;
                        }
                        return true;
                    });
                    
                    if (closure) {
                        hasConflict = true;
                        details = `Conflicts with notice: ${closure.title}`;
                    }
                }
                
                setAvailabilityStatus(hasConflict ? 'conflict' : 'available');
                setConflictDetails(hasConflict ? details : null);
            } catch (err) {
                setAvailabilityStatus(null);
            }
        };
        
        checkAvailability();
    }, [selectedBayId, selectedRequest, actionModal]);

    useEffect(() => {
        if (actionModal === 'approve' && selectedRequest?.id) {
            const fetchFeeEstimate = async () => {
                setIsFetchingFeeEstimate(true);
                try {
                    const res = await fetch(`/api/booking-requests/${selectedRequest.id}/fee-estimate`, {
                        credentials: 'include'
                    });
                    if (res.ok) {
                        const data = await res.json();
                        setFeeEstimate(data);
                    } else {
                        setFeeEstimate(null);
                    }
                } catch (err) {
                    console.error('Failed to fetch fee estimate:', err);
                    setFeeEstimate(null);
                } finally {
                    setIsFetchingFeeEstimate(false);
                }
            };
            fetchFeeEstimate();
        } else {
            setFeeEstimate(null);
        }
    }, [actionModal, selectedRequest?.id]);

    useEffect(() => {
        const fetchDeclineSlots = async (bookingDate: string, resourceId: number) => {
            try {
                const res = await fetch(`/api/bays/${resourceId}/availability?date=${bookingDate}`, {
                    credentials: 'include'
                });
                if (res.ok) {
                    const blocks = await res.json();
                    const available = blocks
                        .filter((b: any) => b.block_type === 'available' || !b.block_type)
                        .map((b: any) => b.start_time?.substring(0, 5))
                        .filter(Boolean);
                    setDeclineAvailableSlots(available);
                }
            } catch (err) {
                console.error('Failed to fetch available slots:', err);
                setDeclineAvailableSlots([]);
            }
        };

        if (actionModal === 'decline' && selectedRequest) {
            setSuggestedTime('');
            setDeclineAvailableSlots([]);
            if (selectedRequest.resource_id) {
                fetchDeclineSlots(selectedRequest.request_date, selectedRequest.resource_id);
            }
        }
    }, [actionModal, selectedRequest]);

    // Queue shows both pending requests AND unmatched webhook bookings
    const pendingRequests = requests.filter(r => 
        r.status === 'pending' || 
        r.status === 'pending_approval'
    );
    
    // Include unmatched webhook bookings in the queue for staff visibility
    const unmatchedBookings = approvedBookings.filter(b => 
        (b as any).is_unmatched === true ||
        b.user_email === 'unmatched@trackman.import' ||
        (b.user_name || '').includes('Unknown (Trackman)')
    );
    
    // Combined queue: all items sorted chronologically by date/time for staff visibility
    const queueItems = [
        ...pendingRequests.map(r => ({ ...r, queueType: 'pending' as const })),
        ...unmatchedBookings.map(b => ({ ...b, queueType: 'unmatched' as const }))
    ].sort((a, b) => {
        // Sort chronologically by date first, then time
        if (a.request_date !== b.request_date) {
            return a.request_date.localeCompare(b.request_date);
        }
        return a.start_time.localeCompare(b.start_time);
    });

    const scheduledBookings = useMemo(() => {
        const today = getTodayPacific();
        const tomorrow = (() => {
            const d = new Date(today);
            d.setDate(d.getDate() + 1);
            return d.toISOString().split('T')[0];
        })();
        const weekEnd = (() => {
            const d = new Date(today);
            d.setDate(d.getDate() + 7);
            return d.toISOString().split('T')[0];
        })();
        
        return approvedBookings
            .filter(b => {
                // Include approved/confirmed, plus attended for today only (so checked-in bookings stay visible)
                const isScheduledStatus = b.status === 'approved' || b.status === 'confirmed';
                const isCheckedInToday = b.status === 'attended' && b.request_date === today;
                if (!(isScheduledStatus || isCheckedInToday) || b.request_date < today) return false;
                
                if (scheduledFilter === 'today') return b.request_date === today;
                if (scheduledFilter === 'tomorrow') return b.request_date === tomorrow;
                if (scheduledFilter === 'week') return b.request_date >= today && b.request_date <= weekEnd;
                return true;
            })
            .sort((a, b) => {
                if (a.request_date !== b.request_date) {
                    return a.request_date.localeCompare(b.request_date);
                }
                return a.start_time.localeCompare(b.start_time);
            });
    }, [approvedBookings, scheduledFilter]);

    const isBookingUnmatched = useCallback((booking: BookingRequest): boolean => {
        return (booking as any).is_unmatched === true ||
            booking.user_email === 'unmatched@trackman.import' ||
            (booking.user_name || '').includes('Unknown (Trackman)');
    }, []);

    const initiateApproval = () => {
        if (!selectedRequest) return;
        
        if (selectedRequest.source !== 'booking' && !selectedBayId) {
            setError('Please select a bay');
            return;
        }
        
        setShowTrackmanConfirm(true);
    };

    const handleApprove = async () => {
        if (!selectedRequest) return;
        
        setIsProcessing(true);
        setError(null);
        
        // Optimistic UI: update status immediately
        const previousRequests = [...requests];
        setRequests(prev => prev.map(r => 
            r.id === selectedRequest.id && r.source === selectedRequest.source 
                ? { ...r, status: 'confirmed' as const } 
                : r
        ));
        setShowTrackmanConfirm(false);
        setActionModal(null);
        const approvedRequest = selectedRequest;
        setSelectedRequest(null);
        setSelectedBayId(null);
        setStaffNotes('');
        
        try {
            let res;
            if (approvedRequest.source === 'booking') {
                res = await fetch(`/api/bookings/${approvedRequest.id}/approve`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' }
                });
            } else {
                res = await fetch(`/api/booking-requests/${approvedRequest.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        status: 'approved',
                        resource_id: selectedBayId,
                        staff_notes: staffNotes || null,
                        reviewed_by: user?.email
                    })
                });
            }
            
            if (!res.ok) {
                // Revert on failure
                setRequests(previousRequests);
                const errData = await res.json();
                setError(errData.message || errData.error || 'Failed to approve');
            } else {
                window.dispatchEvent(new CustomEvent('booking-action-completed'));
                setTimeout(() => handleRefresh(), 300);
            }
        } catch (err: any) {
            // Revert on error
            setRequests(previousRequests);
            setError(err.message);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleDecline = async () => {
        if (!selectedRequest) return;
        
        setIsProcessing(true);
        setError(null);
        
        const newStatus = selectedRequest.status === 'approved' ? 'cancelled' : 'declined';
        const wasPending = selectedRequest.status === 'pending' || selectedRequest.status === 'pending_approval';
        
        // Optimistic UI: update status immediately
        const previousRequests = [...requests];
        setRequests(prev => prev.map(r => 
            r.id === selectedRequest.id && r.source === selectedRequest.source 
                ? { ...r, status: newStatus as 'declined' | 'cancelled' } 
                : r
        ));
        const declinedRequest = selectedRequest;
        setActionModal(null);
        setSelectedRequest(null);
        setStaffNotes('');
        setSuggestedTime('');
        
        try {
            let res;
            if (declinedRequest.source === 'booking') {
                res = await fetch(`/api/bookings/${declinedRequest.id}/decline`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include'
                });
            } else {
                res = await fetch(`/api/booking-requests/${declinedRequest.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        status: newStatus,
                        staff_notes: staffNotes || null,
                        suggested_time: suggestedTime ? suggestedTime + ':00' : null,
                        reviewed_by: actualUser?.email || user?.email,
                        cancelled_by: newStatus === 'cancelled' ? (actualUser?.email || user?.email) : undefined
                    })
                });
            }
            
            if (!res.ok) {
                // Revert on failure
                setRequests(previousRequests);
                const errData = await res.json();
                setError(errData.error || 'Failed to process request');
            } else {
                if (wasPending) {
                    window.dispatchEvent(new CustomEvent('booking-action-completed'));
                }
                setTimeout(() => handleRefresh(), 300);
            }
        } catch (err: any) {
            // Revert on error
            setRequests(previousRequests);
            setError(err.message);
        } finally {
            setIsProcessing(false);
        }
    };


    const groupBookingsByDate = (bookings: BookingRequest[]): Map<string, BookingRequest[]> => {
        const grouped = new Map<string, BookingRequest[]>();
        for (const booking of bookings) {
            const date = booking.request_date;
            if (!grouped.has(date)) {
                grouped.set(date, []);
            }
            grouped.get(date)!.push(booking);
        }
        return grouped;
    };

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

    const parseAffectedBayIds = (affectedAreas: string): number[] => {
        if (affectedAreas === 'entire_facility') {
            return resources.map(r => r.id);
        }
        
        if (affectedAreas === 'all_bays') {
            return resources.filter(r => r.type === 'simulator').map(r => r.id);
        }
        
        if (affectedAreas === 'conference_room') {
            return [11];
        }
        
        if (affectedAreas.startsWith('bay_') && !affectedAreas.includes(',') && !affectedAreas.includes('[')) {
            const areaId = parseInt(affectedAreas.replace('bay_', ''));
            return isNaN(areaId) ? [] : [areaId];
        }
        
        if (affectedAreas.includes(',') && !affectedAreas.startsWith('[')) {
            const ids: number[] = [];
            for (const item of affectedAreas.split(',')) {
                const trimmed = item.trim();
                if (trimmed.startsWith('bay_')) {
                    const areaId = parseInt(trimmed.replace('bay_', ''));
                    if (!isNaN(areaId)) ids.push(areaId);
                } else {
                    const areaId = parseInt(trimmed);
                    if (!isNaN(areaId)) ids.push(areaId);
                }
            }
            return ids;
        }
        
        try {
            const parsed = JSON.parse(affectedAreas);
            if (Array.isArray(parsed)) {
                const ids: number[] = [];
                for (const item of parsed) {
                    if (typeof item === 'number') {
                        ids.push(item);
                    } else if (typeof item === 'string') {
                        if (item.startsWith('bay_')) {
                            const areaId = parseInt(item.replace('bay_', ''));
                            if (!isNaN(areaId)) ids.push(areaId);
                        } else {
                            const areaId = parseInt(item);
                            if (!isNaN(areaId)) ids.push(areaId);
                        }
                    }
                }
                return ids;
            }
        } catch {}
        
        return [];
    };

    const getClosureForSlot = (resourceId: number, date: string, slotStart: number, slotEnd: number): CalendarClosure | null => {
        for (const closure of closures) {
            if (closure.startDate > date || closure.endDate < date) continue;
            
            const affectedBayIds = parseAffectedBayIds(closure.affectedAreas);
            if (!affectedBayIds.includes(resourceId)) continue;
            
            if (!closure.startTime && !closure.endTime) {
                return closure;
            }
            
            const closureStartMinutes = closure.startTime 
                ? parseInt(closure.startTime.split(':')[0]) * 60 + parseInt(closure.startTime.split(':')[1] || '0') 
                : 0;
            const closureEndMinutes = closure.endTime 
                ? parseInt(closure.endTime.split(':')[0]) * 60 + parseInt(closure.endTime.split(':')[1] || '0') 
                : 24 * 60;
            
            if (slotStart < closureEndMinutes && slotEnd > closureStartMinutes) {
                return closure;
            }
        }
        return null;
    };

    const getBlockForSlot = (resourceId: number, date: string, slotStart: number, slotEnd: number): AvailabilityBlock | null => {
        for (const block of availabilityBlocks) {
            if (block.blockDate !== date) continue;
            if (block.resourceId !== resourceId) continue;
            
            const blockStartMinutes = block.startTime 
                ? parseInt(block.startTime.split(':')[0]) * 60 + parseInt(block.startTime.split(':')[1] || '0') 
                : 0;
            const blockEndMinutes = block.endTime 
                ? parseInt(block.endTime.split(':')[0]) * 60 + parseInt(block.endTime.split(':')[1] || '0') 
                : 24 * 60;
            
            if (slotStart < blockEndMinutes && slotEnd > blockStartMinutes) {
                return block;
            }
        }
        return null;
    };

    return (
            <AnimatedPage className="flex flex-col">
                <div className="w-full bg-white dark:bg-surface-dark rounded-2xl shadow-lg border border-gray-200 dark:border-white/25 flex flex-col">
                <div className="lg:hidden flex items-center justify-between border-b border-gray-200 dark:border-white/25 mb-0 animate-content-enter-delay-1 px-4 py-3">
                    <div className="flex">
                        <button
                            onClick={() => setActiveView('requests')}
                            className={`py-3 px-6 font-medium text-sm transition-all relative ${
                                activeView === 'requests'
                                    ? 'text-primary dark:text-white'
                                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                            }`}
                        >
                            Queue {queueItems.length > 0 && `(${queueItems.length})`}
                            {activeView === 'requests' && (
                                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary dark:bg-white" />
                            )}
                        </button>
                        <button
                            onClick={() => setActiveView('calendar')}
                            className={`py-3 px-6 font-medium text-sm transition-all relative ${
                                activeView === 'calendar'
                                    ? 'text-primary dark:text-white'
                                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                            }`}
                        >
                            Calendar
                            {activeView === 'calendar' && (
                                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary dark:bg-white" />
                            )}
                        </button>
                    </div>
                    <div className="flex items-center">
                        <button
                            onClick={() => onTabChange('trackman')}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-primary dark:text-white bg-primary/10 dark:bg-white/10 hover:bg-primary/20 dark:hover:bg-white/20 rounded-lg transition-colors shadow-sm"
                            title="Import bookings from Trackman CSV"
                        >
                            <span className="material-symbols-outlined text-sm">upload_file</span>
                            <span>Import</span>
                        </button>
                    </div>
                </div>

            {isLoading ? (
                <div className="flex items-center justify-center py-12">
                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-primary dark:text-white">progress_activity</span>
                </div>
            ) : (
                <div className="flex flex-col lg:grid lg:grid-cols-[400px_1fr] xl:grid-cols-[450px_1fr] lg:items-start flex-1">
                    <div 
                        className={`lg:border border-gray-200 dark:border-white/25 relative rounded-xl ${activeView === 'requests' ? 'block' : 'hidden lg:block'}`}
                        style={queueMaxHeight ? { height: queueMaxHeight, overflow: 'hidden' } : undefined}
                    >
                        <div className="hidden lg:block absolute top-0 left-0 right-0 h-10 bg-gradient-to-b from-white dark:from-[#1e1e1e] to-transparent z-10 pointer-events-none rounded-t-xl" />
                        <div className="hidden lg:block absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-white dark:from-[#1e1e1e] to-transparent z-10 pointer-events-none rounded-b-xl" />
                        <div className="space-y-6 p-5 animate-slide-up-stagger h-full overflow-y-auto pb-10" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                    <div className="animate-slide-up-stagger" style={{ '--stagger-index': 1 } as React.CSSProperties}>
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-bold text-primary dark:text-white flex items-center gap-2">
                                <span aria-hidden="true" className="material-symbols-outlined text-yellow-500">pending</span>
                                Queue ({queueItems.length})
                                {pendingRequests.length > 0 && unmatchedBookings.length > 0 && (
                                    <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                                        {pendingRequests.length} pending, {unmatchedBookings.length} unassigned
                                    </span>
                                )}
                            </h3>
                            <button
                                onClick={() => onTabChange('trackman')}
                                className="hidden lg:flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-primary dark:text-white bg-primary/10 dark:bg-white/10 hover:bg-primary/20 dark:hover:bg-white/20 rounded-lg transition-colors shadow-sm"
                                title="Import bookings from Trackman CSV"
                            >
                                <span className="material-symbols-outlined text-sm">upload_file</span>
                                <span>Import</span>
                            </button>
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
                                        // Unmatched webhook booking card
                                        return (
                                            <div 
                                                key={`unmatched-${item.id}`} 
                                                className="bg-amber-50/80 dark:bg-amber-500/10 p-4 rounded-xl border-2 border-dashed border-amber-300 dark:border-amber-500/30 animate-slide-up-stagger cursor-pointer hover:bg-amber-100/80 dark:hover:bg-amber-500/20 transition-colors" 
                                                style={{ '--stagger-index': index + 2 } as React.CSSProperties}
                                                onClick={() => setTrackmanLinkModal({
                                                    isOpen: true,
                                                    bookingId: item.id,
                                                    trackmanBookingId: (item as any).trackman_booking_id || null,
                                                    currentEmail: item.user_email,
                                                    currentName: item.user_name || undefined,
                                                    bayName: (item as any).bay_name || `Bay ${item.resource_id}`
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
                                                {(item as any).trackman_booking_id && (
                                                    <p className="text-xs text-amber-600 dark:text-amber-500">
                                                        Trackman ID: {(item as any).trackman_booking_id}
                                                    </p>
                                                )}
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setTrackmanLinkModal({
                                                            isOpen: true,
                                                            bookingId: item.id,
                                                            trackmanBookingId: (item as any).trackman_booking_id || null,
                                                            currentEmail: item.user_email,
                                                            currentName: item.user_name || undefined,
                                                            bayName: (item as any).bay_name || `Bay ${item.resource_id}`
                                                        });
                                                    }}
                                                    className="w-full mt-3 py-2 px-3 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors"
                                                >
                                                    <span aria-hidden="true" className="material-symbols-outlined text-sm">person_add</span>
                                                    Assign Member
                                                </button>
                                            </div>
                                        );
                                    }
                                    
                                    // Pending request card (existing design)
                                    return (
                                    <div key={`${req.source || 'request'}-${req.id}`} className="bg-gray-50 dark:bg-white/5 p-4 rounded-xl border border-gray-200 dark:border-white/25 animate-slide-up-stagger" style={{ '--stagger-index': index + 2 } as React.CSSProperties}>
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
                                                {req.reschedule_booking_id && (
                                                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/20 text-blue-600 dark:text-blue-400">
                                                        Reschedule
                                                    </span>
                                                )}
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
                                                className="flex-1 py-2 px-3 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                                            >
                                                <span aria-hidden="true" className="material-symbols-outlined text-sm">sports_golf</span>
                                                Book on Trackman
                                            </button>
                                            <button
                                                onClick={() => { setSelectedRequest(req); setActionModal('decline'); }}
                                                className="flex-1 py-2 px-3 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                                            >
                                                <span aria-hidden="true" className="material-symbols-outlined text-sm">close</span>
                                                Deny
                                            </button>
                                        </div>
                                        {import.meta.env.DEV && (
                                            <button
                                                onClick={async () => {
                                                    try {
                                                        const res = await fetch(`/api/admin/bookings/${req.id}/simulate-confirm`, {
                                                            method: 'POST',
                                                            headers: { 'Content-Type': 'application/json' },
                                                            credentials: 'include'
                                                        });
                                                        const data = await res.json();
                                                        if (res.ok) {
                                                            const totalFee = (data.totalFeeCents || data.overageFeeCents || 0) / 100;
                                                            showToast(`Confirmed! Total fees: $${totalFee.toFixed(2)}`, 'success');
                                                            setRequests(prev => prev.filter(r => r.id !== req.id));
                                                            handleRefresh();
                                                        } else {
                                                            showToast(data.error || 'Failed to confirm', 'error');
                                                        }
                                                    } catch (err) {
                                                        showToast('Failed to simulate confirm', 'error');
                                                    }
                                                }}
                                                className="w-full mt-2 py-1.5 px-3 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors border border-dashed border-green-400 dark:border-green-500/50"
                                            >
                                                <span aria-hidden="true" className="material-symbols-outlined text-sm">science</span>
                                                DEV: Simulate Confirm
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
                                                return (
                                                    <SwipeableListItem
                                                        key={`upcoming-${booking.id}`}
                                                        leftActions={[
                                                            {
                                                                id: 'reschedule',
                                                                icon: 'schedule',
                                                                label: 'Reschedule',
                                                                color: 'primary',
                                                                onClick: () => {
                                                                    setRescheduleEmail(booking.user_email);
                                                                    setRescheduleBookingId(booking.id as number);
                                                                    setShowManualBooking(true);
                                                                }
                                                            }
                                                        ]}
                                                        rightActions={[
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
                                                            className={`p-4 rounded-2xl animate-pop-in cursor-pointer hover:opacity-90 transition-opacity ${
                                                            isUnmatched 
                                                                ? 'bg-amber-50/80 dark:bg-amber-500/10 border-2 border-dashed border-amber-300 dark:border-amber-500/30' 
                                                                : 'glass-card border border-primary/10 dark:border-white/25'
                                                        }`} 
                                                            style={{ '--stagger-index': index } as React.CSSProperties}
                                                            onClick={() => setSelectedCalendarBooking(booking)}
                                                        >
                                                            {/* Header: Name/Badge + Status */}
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
                                                            
                                                            {/* Date & Time */}
                                                            <p className={`text-sm mb-1 ${isUnmatched ? 'text-amber-700 dark:text-amber-400' : 'text-primary/80 dark:text-white/80'}`}>
                                                                {new Date(booking.request_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} • {formatTime12Hour(booking.start_time)} - {formatTime12Hour(booking.end_time)}
                                                            </p>
                                                            
                                                            {/* Trackman ID */}
                                                            {booking.trackman_booking_id && (
                                                                <p className="text-xs text-orange-600 dark:text-orange-400 font-mono mt-2">
                                                                    Trackman ID: {booking.trackman_booking_id}
                                                                </p>
                                                            )}
                                                            
                                                            {/* Action Buttons - Full Width */}
                                                            <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                                                                {isUnmatched ? (
                                                                    <button
                                                                        onClick={() => setTrackmanLinkModal({
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
                                                                        className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2 transition-colors"
                                                                    >
                                                                        <span aria-hidden="true" className="material-symbols-outlined text-lg">person_add</span>
                                                                        Assign Member
                                                                    </button>
                                                                ) : !isConferenceRoom && isToday && booking.status === 'attended' ? (
                                                                    <span className="flex-1 py-2.5 bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400 rounded-xl text-sm font-medium flex items-center justify-center gap-2">
                                                                        <span aria-hidden="true" className="material-symbols-outlined text-lg">check_circle</span>
                                                                        Checked In
                                                                    </span>
                                                                ) : !isConferenceRoom && isToday && booking.has_unpaid_fees ? (
                                                                    <button
                                                                        onClick={() => {
                                                                            const bookingId = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', '')) : booking.id;
                                                                            setBillingModal({ isOpen: true, bookingId });
                                                                        }}
                                                                        className="flex-1 py-2.5 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 rounded-xl text-sm font-medium flex items-center justify-center gap-2 hover:bg-amber-200 dark:hover:bg-amber-500/30 transition-colors"
                                                                    >
                                                                        <span aria-hidden="true" className="material-symbols-outlined text-lg">payments</span>
                                                                        ${(booking.total_owed || 0).toFixed(0)} Due
                                                                    </button>
                                                                ) : !isConferenceRoom && ((booking as any).declared_player_count || 1) > ((booking as any).filled_player_count || 0) ? (
                                                                    <button
                                                                        onClick={() => {
                                                                            const bookingId = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', '')) : booking.id;
                                                                            setRosterModal({ isOpen: true, bookingId });
                                                                        }}
                                                                        className="flex-1 py-2.5 bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400 rounded-xl text-sm font-medium flex items-center justify-center gap-2 hover:bg-blue-200 dark:hover:bg-blue-500/30 transition-colors"
                                                                    >
                                                                        <span aria-hidden="true" className="material-symbols-outlined text-lg">group</span>
                                                                        {(booking as any).filled_player_count || 0}/{(booking as any).declared_player_count || 1} Players
                                                                    </button>
                                                                ) : !isConferenceRoom && isToday ? (
                                                                    <button
                                                                        onClick={() => updateBookingStatusOptimistic(booking, 'attended')}
                                                                        className="flex-1 py-2.5 bg-accent text-primary rounded-xl text-sm font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-colors"
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
                    
                    <div className="flex-1 relative animate-slide-up-stagger" style={{ '--stagger-index': 1 } as React.CSSProperties}>
                        <div className="w-full px-1 sm:px-2 pb-4">
                            <div className="w-full">
                            <div className="grid gap-0.5 w-full" style={{ gridTemplateColumns: `minmax(32px, 0.6fr) repeat(${resources.length}, minmax(0, 1fr))` }}>
                                <div className="h-8 sm:h-10 sticky top-0 z-20 bg-white dark:bg-[#1a1f1a] flex items-center justify-center text-[10px] sm:text-xs font-bold text-primary dark:text-white rounded-t-lg border border-gray-200 dark:border-white/25">
                                    <span className="hidden sm:inline">Time</span>
                                    <span className="sm:hidden">T</span>
                                </div>
                                {[...resources].sort((a, b) => {
                                    if (a.type === 'conference_room' && b.type !== 'conference_room') return 1;
                                    if (a.type !== 'conference_room' && b.type === 'conference_room') return -1;
                                    return 0;
                                }).map(resource => (
                                    <div key={resource.id} className={`h-8 sm:h-10 flex items-center justify-center font-bold text-[10px] sm:text-xs text-primary dark:text-white text-center rounded-t-lg border border-gray-200 dark:border-white/25 px-0.5 sticky top-0 z-20 ${resource.type === 'conference_room' ? 'bg-purple-100 dark:bg-purple-900/50' : 'bg-white dark:bg-[#1a1f1a]'}`}>
                                        <span className="hidden sm:inline">{resource.type === 'conference_room' ? 'Conf' : resource.name.replace('Simulator Bay ', 'Bay ')}</span>
                                        <span className="sm:hidden">{resource.type === 'conference_room' ? 'CR' : resource.name.replace('Simulator Bay ', 'B')}</span>
                                    </div>
                                ))}
                                
                                {timeSlots.map(slot => (
                                    <React.Fragment key={slot}>
                                        <div className="h-7 sm:h-8 flex items-center justify-end pr-0.5 sm:pr-1 text-[9px] sm:text-[10px] text-gray-600 dark:text-white/70 font-medium whitespace-nowrap bg-white dark:bg-surface-dark">
                                            <span className="hidden sm:inline">{formatTime12Hour(slot)}</span>
                                            <span className="sm:hidden">{formatTime12Hour(slot).replace(':00', '').replace(' AM', 'a').replace(' PM', 'p')}</span>
                                        </div>
                                        {[...resources].sort((a, b) => {
                                            if (a.type === 'conference_room' && b.type !== 'conference_room') return 1;
                                            if (a.type !== 'conference_room' && b.type === 'conference_room') return -1;
                                            return 0;
                                        }).map(resource => {
                                            const [slotHour, slotMin] = slot.split(':').map(Number);
                                            const slotStart = slotHour * 60 + slotMin;
                                            const slotEnd = slotStart + 15;
                                            
                                            const closure = getClosureForSlot(resource.id, calendarDate, slotStart, slotEnd);
                                            const eventBlock = !closure ? getBlockForSlot(resource.id, calendarDate, slotStart, slotEnd) : null;
                                            
                                            const booking = approvedBookings.find(b => {
                                                if (b.resource_id !== resource.id || b.request_date !== calendarDate) return false;
                                                const [bh, bm] = b.start_time.split(':').map(Number);
                                                const [eh, em] = b.end_time.split(':').map(Number);
                                                const bookStart = bh * 60 + bm;
                                                const bookEnd = eh * 60 + em;
                                                return slotStart < bookEnd && slotEnd > bookStart;
                                            });
                                            
                                            // Check for pending requests (awaiting Trackman webhook sync)
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
                                            // Prefer member directory name over Trackman import name
                                            const bookingDisplayName = bookingEmail && memberNameMap[bookingEmail] 
                                                ? memberNameMap[bookingEmail] 
                                                : booking?.user_name || 'Booked';
                                            const isTrackmanMatched = !!(booking as any)?.trackman_booking_id || (booking?.notes && booking.notes.includes('[Trackman Import ID:'));
                                            const hasKnownInactiveStatus = bookingMemberStatus && bookingMemberStatus.toLowerCase() !== 'active' && bookingMemberStatus.toLowerCase() !== 'unknown';
                                            const isInactiveMember = booking && bookingEmail && isTrackmanMatched && hasKnownInactiveStatus;
                                            const isUnmatched = !!(booking as any)?.is_unmatched;
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
                                                            date: calendarDate
                                                        });
                                                        setStaffManualBookingModalOpen(true);
                                                    } : booking ? (isUnmatched ? () => setTrackmanLinkModal({
                                                        isOpen: true,
                                                        trackmanBookingId: (booking as any).trackman_booking_id || null,
                                                        bayName: resource.type === 'conference_room' ? 'Conference Room' : resource.name,
                                                        bookingDate: formatDateShortAdmin(booking.request_date),
                                                        timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                                                        matchedBookingId: Number(booking.id),
                                                        isRelink: false,
                                                        importedName: (booking as any).user_name || (booking as any).userName,
                                                        notes: (booking as any).notes || (booking as any).note
                                                    }) : () => setSelectedCalendarBooking(booking)) : pendingRequest ? () => setTrackmanModal({ isOpen: true, booking: pendingRequest }) : undefined}
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
                                                    } transition-colors`}
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
                                                            {/* Calculate slot data once for both views */}
                                                            {(() => {
                                                                const unfilledSlots = (booking as any)?.unfilled_slots ?? 0;
                                                                const declaredPlayers = (booking as any)?.declared_player_count ?? 1;
                                                                const filledSlots = Math.max(0, declaredPlayers - unfilledSlots);
                                                                const hasUnpaidFees = (booking as any)?.has_unpaid_fees ?? false;
                                                                const totalOwed = (booking as any)?.total_owed ?? 0;
                                                                const isPartialRoster = !isConference && declaredPlayers > 1 && filledSlots < declaredPlayers;
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
                                                                        {/* Desktop: show name + X/Y inline when there are multiple players */}
                                                                        <span className={`hidden sm:flex items-center gap-1 text-[9px] sm:text-[10px] font-medium truncate ${textColor}`}>
                                                                            <span className="truncate">{bookingDisplayName}</span>
                                                                            {declaredPlayers > 1 && (
                                                                                <span className="text-[8px] opacity-70" title={`${filledSlots}/${declaredPlayers} slots filled`}>
                                                                                    {filledSlots}/{declaredPlayers}
                                                                                </span>
                                                                            )}
                                                                        </span>
                                                                        
                                                                        {/* Mobile: show X/Y player count when >1 player OR unpaid, else show dot */}
                                                                        {declaredPlayers > 1 || hasUnpaidFees ? (
                                                                            <span className={`sm:hidden text-[9px] font-bold ${hasUnpaidFees ? 'text-red-600 dark:text-red-400' : textColor}`} title={`${bookingDisplayName}${hasUnpaidFees ? ` - $${totalOwed.toFixed(2)} owed` : ''}`}>
                                                                                {filledSlots}/{declaredPlayers}
                                                                            </span>
                                                                        ) : (
                                                                            <span className={`sm:hidden w-3 h-3 rounded-full ${isConference ? 'bg-purple-500 dark:bg-purple-400' : isUnmatched ? 'bg-amber-500 dark:bg-amber-400' : 'bg-green-500 dark:bg-green-400'}`} title={bookingDisplayName}></span>
                                                                        )}
                                                                        
                                                                        {/* Desktop: Red badge for unpaid fees - top right */}
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
                                                            {/* Desktop: Inactive member badge - top right, shifts left if unpaid badge present */}
                                                            {isInactiveMember && (
                                                                <span className={`hidden sm:block absolute -top-1 ${(booking as any)?.has_unpaid_fees ? '-right-4' : '-right-1'} group`}>
                                                                    <span className="w-2 h-2 rounded-full bg-orange-400 dark:bg-orange-500 block cursor-help"></span>
                                                                    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs font-medium text-white bg-gray-800 dark:bg-gray-700 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                                                                        Non-active member
                                                                    </span>
                                                                </span>
                                                            )}
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
                                ))}
                            </div>
                            </div>
                        </div>
                    </div>
                    </div>
                </div>
            )}
            
            <ModalShell isOpen={!!actionModal && !!selectedRequest} onClose={() => { setActionModal(null); setSelectedRequest(null); setError(null); setShowTrackmanConfirm(false); }} title={actionModal === 'approve' ? 'Approve Request' : 'Decline Request'} showCloseButton={false}>
                <div className="p-6 space-y-4">
                    <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                        <p className="font-medium text-primary dark:text-white">{selectedRequest?.user_name || selectedRequest?.user_email}</p>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            {selectedRequest && formatDateShortAdmin(selectedRequest.request_date)} • {selectedRequest && formatTime12Hour(selectedRequest.start_time)} - {selectedRequest && formatTime12Hour(selectedRequest.end_time)}
                        </p>
                        {(selectedRequest as any)?.declared_player_count && (
                            <div className="flex items-center gap-1 mt-2 text-sm text-accent">
                                <span className="material-symbols-outlined text-base">group</span>
                                <span>{(selectedRequest as any).declared_player_count} {(selectedRequest as any).declared_player_count === 1 ? 'player' : 'players'}</span>
                            </div>
                        )}
                    </div>
                    
                    {actionModal === 'approve' && (
                        <div className="p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg">
                            <div className="flex items-center gap-2 mb-2">
                                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-base">payments</span>
                                <p className="text-xs text-amber-700 dark:text-amber-300 font-medium uppercase tracking-wide">Fee Estimate</p>
                            </div>
                            {isFetchingFeeEstimate ? (
                                <div className="flex items-center gap-2 text-sm text-gray-500">
                                    <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                                    Calculating fees...
                                </div>
                            ) : feeEstimate ? (
                                <div className="space-y-1.5">
                                    {feeEstimate.ownerTier && (
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="text-gray-600 dark:text-gray-400">Member tier</span>
                                            <span className="text-gray-700 dark:text-gray-300 font-medium">{feeEstimate.ownerTier}</span>
                                        </div>
                                    )}
                                    {feeEstimate.feeBreakdown.overageFee > 0 && (
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="text-gray-600 dark:text-gray-400">Overage ({feeEstimate.feeBreakdown.overageMinutes} min)</span>
                                            <span className="text-amber-700 dark:text-amber-300">${feeEstimate.feeBreakdown.overageFee}</span>
                                        </div>
                                    )}
                                    {feeEstimate.feeBreakdown.guestCount > 0 && (
                                        <>
                                            {feeEstimate.feeBreakdown.guestsUsingPasses > 0 && (
                                                <div className="flex items-center justify-between text-xs">
                                                    <span className="text-gray-600 dark:text-gray-400">{feeEstimate.feeBreakdown.guestsUsingPasses} guest{feeEstimate.feeBreakdown.guestsUsingPasses > 1 ? 's' : ''} (using pass)</span>
                                                    <span className="text-green-600 dark:text-green-400">$0</span>
                                                </div>
                                            )}
                                            {feeEstimate.feeBreakdown.guestsCharged > 0 && (
                                                <div className="flex items-center justify-between text-xs">
                                                    <span className="text-gray-600 dark:text-gray-400">{feeEstimate.feeBreakdown.guestsCharged} guest{feeEstimate.feeBreakdown.guestsCharged > 1 ? 's' : ''} @ $25</span>
                                                    <span className="text-amber-700 dark:text-amber-300">${feeEstimate.feeBreakdown.guestFees}</span>
                                                </div>
                                            )}
                                        </>
                                    )}
                                    {feeEstimate.feeBreakdown.guestPassesRemaining > 0 && (
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="text-gray-600 dark:text-gray-400">Guest passes remaining</span>
                                            <span className="text-gray-500 dark:text-gray-400">{feeEstimate.feeBreakdown.guestPassesRemaining}</span>
                                        </div>
                                    )}
                                    <div className="flex items-center justify-between pt-1.5 mt-1.5 border-t border-amber-200 dark:border-amber-500/30">
                                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Owner pays</span>
                                        <span className={`text-sm font-bold ${feeEstimate.totalFee > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-green-600 dark:text-green-400'}`}>
                                            {feeEstimate.totalFee > 0 ? `$${feeEstimate.totalFee}` : 'No fees'}
                                        </span>
                                    </div>
                                    <p className="text-[10px] text-gray-500 dark:text-gray-400 italic">{feeEstimate.note}</p>
                                </div>
                            ) : (
                                <p className="text-xs text-gray-500 dark:text-gray-400">Unable to calculate fees</p>
                            )}
                        </div>
                    )}
                    
                    {(selectedRequest as any)?.member_notes && (
                        <div className="p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg">
                            <p className="text-xs text-blue-600 dark:text-blue-400 mb-1 flex items-center gap-1">
                                <span className="material-symbols-outlined text-sm">chat</span>
                                Member Notes
                            </p>
                            <p className="text-sm text-primary dark:text-white">{(selectedRequest as any).member_notes}</p>
                        </div>
                    )}
                    
                    {error && (
                        <div className="p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg">
                            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                        </div>
                    )}
                    
                    {actionModal === 'approve' && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Assign Resource *</label>
                            <select
                                value={selectedBayId || ''}
                                onChange={(e) => setSelectedBayId(Number(e.target.value))}
                                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                            >
                                <option value="">Select a resource...</option>
                                {resources.map(resource => (
                                    <option key={resource.id} value={resource.id}>
                                        {resource.type === 'conference_room' ? 'Conference Room' : resource.name}
                                    </option>
                                ))}
                            </select>
                            
                            {selectedBayId && availabilityStatus && (
                                <div className={`mt-2 p-2 rounded-lg flex items-center gap-2 text-sm ${
                                    availabilityStatus === 'checking' 
                                        ? 'bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400'
                                        : availabilityStatus === 'available'
                                            ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400'
                                            : 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400'
                                }`}>
                                    <span className={`material-symbols-outlined text-base ${availabilityStatus === 'checking' ? 'animate-spin' : ''}`}>
                                        {availabilityStatus === 'checking' ? 'progress_activity' : availabilityStatus === 'available' ? 'check_circle' : 'warning'}
                                    </span>
                                    <span>
                                        {availabilityStatus === 'checking' && 'Checking availability...'}
                                        {availabilityStatus === 'available' && 'This time slot is available'}
                                        {availabilityStatus === 'conflict' && (conflictDetails || 'Conflict detected')}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                    
                    {actionModal === 'decline' && selectedRequest?.status !== 'approved' && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Suggest Alternative Time (Optional)</label>
                            <select
                                value={suggestedTime || ''}
                                onChange={(e) => setSuggestedTime(e.target.value)}
                                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                            >
                                <option value="">Select alternative time...</option>
                                {declineAvailableSlots.map((time) => (
                                    <option key={time} value={time}>
                                        {formatTime12Hour(time)}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                    
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Staff Notes (Optional)</label>
                        <textarea
                            value={staffNotes}
                            onChange={(e) => setStaffNotes(e.target.value)}
                            placeholder="Add a note for the member..."
                            rows={2}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white resize-none"
                        />
                    </div>
                    
                    <div className="flex gap-3 pt-2">
                        <button
                            onClick={() => { setActionModal(null); setSelectedRequest(null); setError(null); setShowTrackmanConfirm(false); }}
                            className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
                            disabled={isProcessing}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={actionModal === 'approve' ? initiateApproval : handleDecline}
                            disabled={isProcessing || (actionModal === 'approve' && (!selectedBayId || availabilityStatus === 'conflict' || availabilityStatus === 'checking'))}
                            className={`flex-1 py-3 px-4 rounded-lg text-white font-medium flex items-center justify-center gap-2 ${
                                actionModal === 'approve' 
                                    ? 'bg-green-500 hover:bg-green-600' 
                                    : 'bg-red-500 hover:bg-red-600'
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                            {isProcessing ? (
                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                            ) : (
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">
                                    {actionModal === 'approve' ? 'check' : 'close'}
                                </span>
                            )}
                            {actionModal === 'approve' ? 'Approve' : (selectedRequest?.status === 'approved' ? 'Cancel Booking' : 'Decline')}
                        </button>
                    </div>
                </div>
            </ModalShell>

            <ModalShell isOpen={showTrackmanConfirm && !!selectedRequest} onClose={() => setShowTrackmanConfirm(false)} showCloseButton={false}>
                <div className="p-6 space-y-4">
                    <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center mx-auto mb-3">
                            <span aria-hidden="true" className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-2xl">sports_golf</span>
                        </div>
                        <h3 className="text-lg font-bold text-primary dark:text-white mb-2">Trackman Confirmation</h3>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            Have you created this booking in Trackman?
                        </p>
                    </div>
                    
                    <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg text-sm">
                        <p className="font-medium text-primary dark:text-white">{selectedRequest?.user_name || selectedRequest?.user_email}</p>
                        <p className="text-gray-500 dark:text-gray-400">
                            {selectedRequest && formatDateShortAdmin(selectedRequest.request_date)} • {selectedRequest && formatTime12Hour(selectedRequest.start_time)} - {selectedRequest && formatTime12Hour(selectedRequest.end_time)}
                        </p>
                        {selectedBayId && (
                            <p className="text-gray-500 dark:text-gray-400">
                                {resources.find(r => r.id === selectedBayId)?.name || `Bay ${selectedBayId}`}
                            </p>
                        )}
                    </div>

                    {error && (
                        <div className="p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg">
                            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                        </div>
                    )}
                    
                    <div className="flex gap-3 pt-2">
                        <button
                            onClick={() => setShowTrackmanConfirm(false)}
                            className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
                            disabled={isProcessing}
                        >
                            Go Back
                        </button>
                        <button
                            onClick={handleApprove}
                            disabled={isProcessing}
                            className="flex-1 py-3 px-4 rounded-lg bg-green-500 hover:bg-green-600 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isProcessing ? (
                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                            ) : (
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">check</span>
                            )}
                            Yes, Approve
                        </button>
                    </div>
                </div>
            </ModalShell>

            {showManualBooking && (
                <ManualBookingModal 
                    resources={resources}
                    defaultMemberEmail={rescheduleEmail || undefined}
                    rescheduleFromId={rescheduleBookingId || undefined}
                    defaultResourceId={prefillResourceId || undefined}
                    defaultDate={prefillDate || undefined}
                    defaultStartTime={prefillStartTime || undefined}
                    onClose={() => { setShowManualBooking(false); setRescheduleEmail(null); setRescheduleBookingId(null); setPrefillResourceId(null); setPrefillDate(null); setPrefillStartTime(null); }}
                    onSuccess={(booking) => {
                        setShowManualBooking(false);
                        setRescheduleEmail(null);
                        setRescheduleBookingId(null);
                        setPrefillResourceId(null);
                        setPrefillDate(null);
                        setPrefillStartTime(null);
                        
                        if (booking) {
                            const newBooking: BookingRequest = {
                                id: booking.id,
                                user_email: booking.user_email,
                                user_name: booking.user_name,
                                resource_id: booking.resource_id,
                                bay_name: booking.bay_name,
                                resource_preference: null,
                                request_date: booking.request_date,
                                start_time: booking.start_time,
                                end_time: booking.end_time,
                                duration_minutes: booking.duration_minutes,
                                notes: booking.notes,
                                status: booking.status,
                                staff_notes: booking.staff_notes,
                                suggested_time: null,
                                created_at: new Date().toISOString(),
                                source: 'booking'
                            };
                            setApprovedBookings(prev => [...prev, newBooking]);
                        }
                        
                        window.dispatchEvent(new CustomEvent('booking-action-completed'));
                        setTimeout(() => handleRefresh(), 500);
                    }}
                />
            )}

            <ModalShell isOpen={!!selectedCalendarBooking} onClose={() => setSelectedCalendarBooking(null)} title="Booking Details">
                <div className="p-6 space-y-3">
                    {(() => {
                        const email = selectedCalendarBooking?.user_email?.toLowerCase() || '';
                        const memberStatus = email ? memberStatusMap[email] : null;
                        // Prefer member directory name over Trackman import name
                        const modalDisplayName = email && memberNameMap[email] 
                            ? memberNameMap[email] 
                            : selectedCalendarBooking?.user_name || 'Unknown';
                        const isTrackmanMatched = !!(selectedCalendarBooking as any)?.trackman_booking_id || (selectedCalendarBooking?.notes && selectedCalendarBooking.notes.includes('[Trackman Import ID:'));
                        const hasKnownInactiveStatus = memberStatus && memberStatus.toLowerCase() !== 'active' && memberStatus.toLowerCase() !== 'unknown';
                        const shouldShowWarning = email && isTrackmanMatched && hasKnownInactiveStatus;
                        return shouldShowWarning ? (
                            <div className="p-3 bg-orange-50 dark:bg-orange-500/10 border border-orange-200 dark:border-orange-500/30 rounded-lg flex items-start gap-2">
                                <span aria-hidden="true" className="material-symbols-outlined text-orange-500 dark:text-orange-400 text-lg flex-shrink-0">warning</span>
                                <div>
                                    <p className="font-medium text-orange-700 dark:text-orange-300 text-sm">
                                        Member Status: {(memberStatus || 'Unknown').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                    </p>
                                    <p className="text-xs text-orange-600 dark:text-orange-400">This member is not currently active. Please verify their membership before proceeding.</p>
                                </div>
                            </div>
                        ) : null;
                    })()}
                    <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                        <div className="flex items-center justify-between">
                            {(() => {
                                const email = selectedCalendarBooking?.user_email?.toLowerCase() || '';
                                const isUnmatched = (selectedCalendarBooking as any)?.is_unmatched || 
                                    email.includes('unmatched@') || 
                                    email.includes('@trackman.import') ||
                                    selectedCalendarBooking?.user_name === 'Unknown (Trackman)';
                                const displayName = isUnmatched 
                                    ? null 
                                    : (email && memberNameMap[email] ? memberNameMap[email] : selectedCalendarBooking?.user_name);
                                
                                if (isUnmatched) {
                                    return (
                                        <div className="flex items-center gap-2">
                                            <span aria-hidden="true" className="material-symbols-outlined text-amber-500 dark:text-amber-400 text-lg">person_off</span>
                                            <div>
                                                <p className="font-bold text-amber-600 dark:text-amber-400">Unassigned</p>
                                                <p className="text-sm text-amber-500/70 dark:text-amber-500/60">Needs member assignment</p>
                                            </div>
                                        </div>
                                    );
                                }
                                return (
                                    <div className="flex items-center gap-2">
                                        <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white text-lg">person</span>
                                        <div>
                                            <p className="font-bold text-primary dark:text-white">{displayName || 'Unknown'}</p>
                                            <p className="text-sm text-gray-500 dark:text-gray-400">{selectedCalendarBooking?.user_email}</p>
                                        </div>
                                    </div>
                                );
                            })()}
                            <button
                                onClick={() => {
                                    if (!selectedCalendarBooking) return;
                                    const bookingId = typeof selectedCalendarBooking.id === 'string' 
                                        ? parseInt(String(selectedCalendarBooking.id).replace('cal_', '')) 
                                        : selectedCalendarBooking.id as number;
                                    const email = selectedCalendarBooking?.user_email?.toLowerCase() || '';
                                    const isUnmatched = (selectedCalendarBooking as any)?.is_unmatched || 
                                        email.includes('unmatched@') || 
                                        email.includes('@trackman.import') ||
                                        selectedCalendarBooking?.user_name === 'Unknown (Trackman)';
                                    const currentName = isUnmatched ? undefined : (() => {
                                        return email && memberNameMap[email] ? memberNameMap[email] : selectedCalendarBooking?.user_name || 'Unknown';
                                    })();
                                    setTrackmanLinkModal({
                                        isOpen: true,
                                        trackmanBookingId: (selectedCalendarBooking as any)?.trackman_booking_id || null,
                                        bayName: selectedCalendarBooking.bay_name || selectedCalendarBooking.resource_name,
                                        bookingDate: formatDateShortAdmin(selectedCalendarBooking.request_date),
                                        timeSlot: `${formatTime12Hour(selectedCalendarBooking.start_time)} - ${formatTime12Hour(selectedCalendarBooking.end_time)}`,
                                        matchedBookingId: bookingId,
                                        currentMemberName: isUnmatched ? undefined : currentName,
                                        currentMemberEmail: isUnmatched ? undefined : selectedCalendarBooking.user_email,
                                        isRelink: true,
                                        importedName: (selectedCalendarBooking as any)?.user_name || (selectedCalendarBooking as any)?.userName,
                                        notes: (selectedCalendarBooking as any)?.notes || (selectedCalendarBooking as any)?.note
                                    });
                                    setSelectedCalendarBooking(null);
                                }}
                                className="p-2 rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors"
                                title={(() => {
                                    const email = selectedCalendarBooking?.user_email?.toLowerCase() || '';
                                    const isUnmatched = (selectedCalendarBooking as any)?.is_unmatched || 
                                        email.includes('unmatched@') || 
                                        email.includes('@trackman.import') ||
                                        selectedCalendarBooking?.user_name === 'Unknown (Trackman)';
                                    return isUnmatched ? "Assign member to booking" : "Change booking owner";
                                })()}
                            >
                                <span className="material-symbols-outlined text-sm">{(() => {
                                    const email = selectedCalendarBooking?.user_email?.toLowerCase() || '';
                                    const isUnmatched = (selectedCalendarBooking as any)?.is_unmatched || 
                                        email.includes('unmatched@') || 
                                        email.includes('@trackman.import') ||
                                        selectedCalendarBooking?.user_name === 'Unknown (Trackman)';
                                    return isUnmatched ? "person_add" : "edit";
                                })()}</span>
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Date</p>
                            <p className="font-medium text-primary dark:text-white text-sm">{selectedCalendarBooking && formatDateShortAdmin(selectedCalendarBooking.request_date)}</p>
                        </div>
                        <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Time</p>
                            <p className="font-medium text-primary dark:text-white text-sm">
                                {selectedCalendarBooking && formatTime12Hour(selectedCalendarBooking.start_time)} - {selectedCalendarBooking && formatTime12Hour(selectedCalendarBooking.end_time)}
                            </p>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Duration</p>
                            <p className="font-medium text-primary dark:text-white text-sm">{selectedCalendarBooking?.duration_minutes} min</p>
                        </div>
                        <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Bay/Resource</p>
                            <p className="font-medium text-primary dark:text-white text-sm">{selectedCalendarBooking?.bay_name || selectedCalendarBooking?.resource_name || '-'}</p>
                        </div>
                    </div>

                    {((selectedCalendarBooking as any)?.declared_player_count || (selectedCalendarBooking as any)?.booking_source || (selectedCalendarBooking as any)?.guest_count) && (
                        <div className="grid grid-cols-2 gap-3">
                            {(selectedCalendarBooking as any)?.declared_player_count && (
                                <div 
                                    className={`p-3 bg-accent/10 dark:bg-accent/20 rounded-lg border border-accent/30 ${!editingPlayerCount ? 'cursor-pointer hover:bg-accent/20 dark:hover:bg-accent/30 transition-colors' : ''}`}
                                    onClick={() => {
                                        if (!editingPlayerCount) {
                                            setPlayerCountDraft((selectedCalendarBooking as any).declared_player_count);
                                            setEditingPlayerCount(true);
                                        }
                                    }}
                                >
                                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1 flex items-center gap-1">
                                        Players
                                        {!editingPlayerCount && (
                                            <span className="material-symbols-outlined text-xs text-accent">edit</span>
                                        )}
                                    </p>
                                    {editingPlayerCount ? (
                                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                            <select
                                                value={playerCountDraft}
                                                onChange={(e) => setPlayerCountDraft(parseInt(e.target.value, 10))}
                                                className="px-2 py-1 text-sm rounded border border-accent/50 bg-white dark:bg-gray-800 text-primary dark:text-white flex-1"
                                                disabled={savingPlayerCount}
                                            >
                                                {[1, 2, 3, 4].map(n => (
                                                    <option key={n} value={n}>{n}</option>
                                                ))}
                                            </select>
                                            <button
                                                onClick={async () => {
                                                    if (!selectedCalendarBooking) return;
                                                    setSavingPlayerCount(true);
                                                    const bookingId = typeof selectedCalendarBooking.id === 'string' 
                                                        ? parseInt(String(selectedCalendarBooking.id).replace('cal_', ''), 10) 
                                                        : selectedCalendarBooking.id;
                                                    try {
                                                        const res = await fetch(`/api/admin/booking/${bookingId}/player-count`, {
                                                            method: 'PATCH',
                                                            headers: { 'Content-Type': 'application/json' },
                                                            credentials: 'include',
                                                            body: JSON.stringify({ playerCount: playerCountDraft })
                                                        });
                                                        if (res.ok) {
                                                            setSelectedCalendarBooking({
                                                                ...selectedCalendarBooking,
                                                                declared_player_count: playerCountDraft
                                                            } as any);
                                                            setEditingPlayerCount(false);
                                                            setMembersEditorKey(prev => prev + 1);
                                                            handleRefresh();
                                                        }
                                                    } catch (err) {
                                                        console.error('Failed to update player count:', err);
                                                    } finally {
                                                        setSavingPlayerCount(false);
                                                    }
                                                }}
                                                disabled={savingPlayerCount}
                                                className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-500/20 text-green-600 dark:text-green-400"
                                            >
                                                <span className="material-symbols-outlined text-sm">
                                                    {savingPlayerCount ? 'progress_activity' : 'check'}
                                                </span>
                                            </button>
                                            <button
                                                onClick={() => setEditingPlayerCount(false)}
                                                disabled={savingPlayerCount}
                                                className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-500/20 text-red-600 dark:text-red-400"
                                            >
                                                <span className="material-symbols-outlined text-sm">close</span>
                                            </button>
                                        </div>
                                    ) : (
                                        <p className="font-medium text-primary dark:text-white text-sm flex items-center gap-1">
                                            <span className="material-symbols-outlined text-accent text-base">group</span>
                                            {(selectedCalendarBooking as any).declared_player_count} {(selectedCalendarBooking as any).declared_player_count === 1 ? 'player' : 'players'}
                                        </p>
                                    )}
                                </div>
                            )}
                            {(selectedCalendarBooking as any)?.booking_source && (
                                <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Booking Source</p>
                                    <p className="font-medium text-primary dark:text-white text-sm">{(selectedCalendarBooking as any).booking_source}</p>
                                </div>
                            )}
                            {(selectedCalendarBooking as any)?.guest_count !== undefined && (selectedCalendarBooking as any).guest_count > 0 && (
                                <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Guest Count</p>
                                    <p className="font-medium text-primary dark:text-white text-sm">{(selectedCalendarBooking as any).guest_count}</p>
                                </div>
                            )}
                        </div>
                    )}

                    {(selectedCalendarBooking as any)?.member_notes && (
                        <div className="p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg">
                            <p className="text-xs text-blue-600 dark:text-blue-400 mb-1 flex items-center gap-1">
                                <span className="material-symbols-outlined text-sm">chat</span>
                                Member Notes
                            </p>
                            <p className="font-medium text-primary dark:text-white text-sm">{(selectedCalendarBooking as any).member_notes}</p>
                        </div>
                    )}

                    {selectedCalendarBooking?.guardian_name && (
                        <div className="p-3 bg-purple-50 dark:bg-purple-500/10 border border-purple-200 dark:border-purple-500/30 rounded-lg">
                            <p className="text-xs text-purple-600 dark:text-purple-400 mb-2 flex items-center gap-1">
                                <span className="material-symbols-outlined text-sm">family_restroom</span>
                                Guardian Consent (Minor Booking)
                            </p>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                                <div>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">Guardian Name</p>
                                    <p className="font-medium text-primary dark:text-white">{selectedCalendarBooking.guardian_name}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">Relationship</p>
                                    <p className="font-medium text-primary dark:text-white">{selectedCalendarBooking.guardian_relationship}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">Phone</p>
                                    <p className="font-medium text-primary dark:text-white">{selectedCalendarBooking.guardian_phone}</p>
                                </div>
                                {selectedCalendarBooking.guardian_consent_at && (
                                    <div>
                                        <p className="text-xs text-gray-500 dark:text-gray-400">Consent Given</p>
                                        <p className="font-medium text-primary dark:text-white text-xs">
                                            {new Date(selectedCalendarBooking.guardian_consent_at).toLocaleString()}
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {selectedCalendarBooking?.notes && (
                        <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Notes</p>
                            <p className="font-medium text-primary dark:text-white text-sm">{selectedCalendarBooking.notes}</p>
                        </div>
                    )}

                    {(selectedCalendarBooking as any)?.created_by_staff_id && (
                        <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Created by Staff</p>
                            <p className="font-medium text-primary dark:text-white text-sm">{(selectedCalendarBooking as any).created_by_staff_id}</p>
                        </div>
                    )}

                    <div className="p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg">
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-amber-700 dark:text-amber-400 mb-1 flex items-center gap-1">
                                <span className="material-symbols-outlined text-sm">sports_golf</span>
                                Trackman Booking ID
                            </p>
                            {!editingTrackmanId && (selectedCalendarBooking as any)?.trackman_booking_id && (
                                <button
                                    onClick={() => {
                                        setTrackmanIdDraft((selectedCalendarBooking as any)?.trackman_booking_id || '');
                                        setEditingTrackmanId(true);
                                    }}
                                    className="p-1 rounded hover:bg-amber-200 dark:hover:bg-amber-500/20 transition-colors"
                                    title="Edit Trackman ID"
                                >
                                    <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-sm">edit</span>
                                </button>
                            )}
                        </div>
                        {editingTrackmanId ? (
                            <div className="flex items-center gap-2 mt-1">
                                <input
                                    type="text"
                                    value={trackmanIdDraft}
                                    onChange={(e) => setTrackmanIdDraft(e.target.value)}
                                    placeholder="e.g., TM-12345"
                                    className="flex-1 px-3 py-2 rounded-lg border border-amber-300 dark:border-amber-500/50 bg-white dark:bg-black/20 text-primary dark:text-white text-sm placeholder-gray-400 dark:placeholder-gray-500"
                                    disabled={savingTrackmanId}
                                    autoFocus
                                />
                                <button
                                    onClick={async () => {
                                        if (!selectedCalendarBooking) return;
                                        setSavingTrackmanId(true);
                                        const bookingId = typeof selectedCalendarBooking.id === 'string' 
                                            ? parseInt(String(selectedCalendarBooking.id).replace('cal_', ''), 10) 
                                            : selectedCalendarBooking.id;
                                        try {
                                            const res = await fetch(`/api/booking-requests/${bookingId}`, {
                                                method: 'PUT',
                                                headers: { 'Content-Type': 'application/json' },
                                                credentials: 'include',
                                                body: JSON.stringify({ trackman_booking_id: trackmanIdDraft || null })
                                            });
                                            if (res.ok) {
                                                setSelectedCalendarBooking({
                                                    ...selectedCalendarBooking,
                                                    trackman_booking_id: trackmanIdDraft || null
                                                } as BookingRequest);
                                                setEditingTrackmanId(false);
                                                handleRefresh();
                                                showToast('Trackman ID updated', 'success');
                                            } else {
                                                const errData = await res.json();
                                                showToast(errData.error || 'Failed to update Trackman ID', 'error');
                                            }
                                        } catch (err) {
                                            showToast('Failed to update Trackman ID', 'error');
                                        } finally {
                                            setSavingTrackmanId(false);
                                        }
                                    }}
                                    disabled={savingTrackmanId}
                                    className="p-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors disabled:opacity-50"
                                    title="Save"
                                >
                                    {savingTrackmanId ? (
                                        <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                                    ) : (
                                        <span className="material-symbols-outlined text-sm">check</span>
                                    )}
                                </button>
                                <button
                                    onClick={() => {
                                        setEditingTrackmanId(false);
                                        setTrackmanIdDraft('');
                                    }}
                                    disabled={savingTrackmanId}
                                    className="p-2 rounded-lg border border-gray-300 dark:border-white/20 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                    title="Cancel"
                                >
                                    <span className="material-symbols-outlined text-sm text-gray-600 dark:text-gray-400">close</span>
                                </button>
                            </div>
                        ) : (selectedCalendarBooking as any)?.trackman_booking_id ? (
                            <p className="font-medium text-primary dark:text-white text-sm">{(selectedCalendarBooking as any).trackman_booking_id}</p>
                        ) : (
                            <button
                                onClick={() => {
                                    setTrackmanIdDraft('');
                                    setEditingTrackmanId(true);
                                }}
                                className="text-sm text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 font-medium flex items-center gap-1"
                            >
                                <span className="material-symbols-outlined text-sm">add</span>
                                Add Trackman ID
                            </button>
                        )}
                    </div>

                    {selectedCalendarBooking && (
                        <BookingMembersEditor 
                            key={`members-editor-${selectedCalendarBooking.id}-${membersEditorKey}`}
                            bookingId={selectedCalendarBooking.id}
                            onMemberLinked={() => {
                                handleRefresh();
                            }}
                            onCollectPayment={(bookingId) => setBillingModal({isOpen: true, bookingId})}
                        />
                    )}
                    
                    <div className="flex flex-col gap-2 pt-3">
                        <div className="flex gap-3">
                            <button
                                onClick={() => {
                                    if (!selectedCalendarBooking) return;
                                    setRescheduleEmail(selectedCalendarBooking.user_email);
                                    setRescheduleBookingId(selectedCalendarBooking.id as number);
                                    setSelectedCalendarBooking(null);
                                    setShowManualBooking(true);
                                }}
                                className="flex-1 py-3 px-4 rounded-lg bg-primary text-white font-medium flex items-center justify-center gap-2 hover:bg-primary/90"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">schedule</span>
                                Reschedule
                            </button>
                            <button
                                onClick={async () => {
                                    if (!selectedCalendarBooking) return;
                                    if (!confirm(`Cancel booking for ${selectedCalendarBooking.user_name || selectedCalendarBooking.user_email}?`)) {
                                        return;
                                    }
                                    
                                    setIsCancellingFromModal(true);
                                    try {
                                        const res = await fetch(`/api/booking-requests/${selectedCalendarBooking.id}`, {
                                            method: 'PUT',
                                            headers: { 'Content-Type': 'application/json' },
                                            credentials: 'include',
                                            body: JSON.stringify({
                                                status: 'cancelled',
                                                staff_notes: 'Cancelled from calendar view',
                                                cancelled_by: actualUser?.email || user?.email
                                            })
                                        });
                                        
                                        if (!res.ok) {
                                            const errData = await res.json();
                                            throw new Error(errData.error || 'Failed to cancel booking');
                                        }
                                        
                                        try {
                                            await fetch('/api/notifications', {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({
                                                    user_email: selectedCalendarBooking.user_email,
                                                    title: 'Booking Cancelled',
                                                    message: `Your booking for ${formatDateShortAdmin(selectedCalendarBooking.request_date)} at ${formatTime12Hour(selectedCalendarBooking.start_time)} has been cancelled by staff.`,
                                                    type: 'booking_cancelled',
                                                    related_id: selectedCalendarBooking.id,
                                                    related_type: 'booking'
                                                })
                                            });
                                        } catch (notifErr) {
                                            console.error('Failed to create cancellation notification:', notifErr);
                                        }
                                        
                                        setApprovedBookings(prev => prev.filter(b => b.id !== selectedCalendarBooking.id));
                                        setSelectedCalendarBooking(null);
                                    } catch (err: any) {
                                        console.error('Failed to cancel booking:', err);
                                        alert(err.message || 'Failed to cancel booking');
                                    } finally {
                                        setIsCancellingFromModal(false);
                                    }
                                }}
                                disabled={isCancellingFromModal}
                                className="flex-1 py-3 px-4 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isCancellingFromModal ? (
                                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                                ) : (
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm">close</span>
                                )}
                                Cancel
                            </button>
                        </div>
                        {(() => {
                            const isTrackmanBooking = !!(selectedCalendarBooking as any)?.trackman_booking_id || (selectedCalendarBooking?.notes && selectedCalendarBooking.notes.includes('[Trackman Import ID:'));
                            const emailLower = selectedCalendarBooking?.user_email?.toLowerCase() || '';
                            const hasMatchedMember = selectedCalendarBooking?.user_email && 
                                !emailLower.includes('unmatched@') &&
                                !emailLower.includes('unmatched-') &&
                                !emailLower.includes('@trackman.local') &&
                                !emailLower.includes('anonymous@') &&
                                !emailLower.includes('booking@');
                            
                            if (isTrackmanBooking && hasMatchedMember) {
                                return (
                                    <button
                                        onClick={async () => {
                                            if (!selectedCalendarBooking?.user_email) return;
                                            if (!confirm(`Unmatch all Trackman bookings for ${selectedCalendarBooking.user_email}? This will allow you to reassign them to a different member.`)) {
                                                return;
                                            }
                                            
                                            setIsUnmatchingMember(true);
                                            try {
                                                const res = await fetch('/api/admin/trackman/unmatch-member', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    credentials: 'include',
                                                    body: JSON.stringify({ email: selectedCalendarBooking.user_email })
                                                });
                                                
                                                if (!res.ok) {
                                                    const errData = await res.json();
                                                    throw new Error(errData.error || 'Failed to unmatch member');
                                                }
                                                
                                                const data = await res.json();
                                                showToast(data.message || `Unmatched ${data.affectedCount} booking(s)`, 'success', 5000);
                                                
                                                setSelectedCalendarBooking(null);
                                                await handleRefresh();
                                            } catch (err: any) {
                                                console.error('Failed to unmatch member:', err);
                                                showToast(err.message || 'Failed to unmatch member', 'error');
                                            } finally {
                                                setIsUnmatchingMember(false);
                                            }
                                        }}
                                        disabled={isUnmatchingMember || isCancellingFromModal}
                                        className="w-full py-2.5 px-4 rounded-lg border border-orange-300 dark:border-orange-500/50 text-orange-600 dark:text-orange-400 font-medium flex items-center justify-center gap-2 hover:bg-orange-50 dark:hover:bg-orange-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {isUnmatchingMember ? (
                                            <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                                        ) : (
                                            <span aria-hidden="true" className="material-symbols-outlined text-sm">person_remove</span>
                                        )}
                                        Unmatch Member
                                    </button>
                                );
                            }
                            return null;
                        })()}
                        <button
                            onClick={() => setSelectedCalendarBooking(null)}
                            className="w-full py-2 px-4 rounded-lg text-gray-500 dark:text-gray-400 text-sm font-medium hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                            disabled={isCancellingFromModal || isUnmatchingMember}
                        >
                            Close
                        </button>
                    </div>
                </div>
            </ModalShell>

            <ModalShell isOpen={!!markStatusModal.booking} onClose={() => setMarkStatusModal({ booking: null, confirmNoShow: false })} showCloseButton={false}>
                <div className="p-6 space-y-4">
                    <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mx-auto mb-3">
                            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-accent text-2xl">task_alt</span>
                        </div>
                        <h3 className="text-lg font-bold text-primary dark:text-white mb-2">
                            {markStatusModal.confirmNoShow ? 'Confirm No Show' : 'Mark Booking Status'}
                        </h3>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            {markStatusModal.confirmNoShow 
                                ? 'Are you sure you want to mark this booking as a no show?' 
                                : 'Did the member attend their booking?'}
                        </p>
                    </div>
                    
                    <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg text-sm">
                        <p className="font-medium text-primary dark:text-white">{markStatusModal.booking?.user_name || markStatusModal.booking?.user_email}</p>
                        <p className="text-gray-500 dark:text-gray-400">
                            {markStatusModal.booking && formatDateShortAdmin(markStatusModal.booking.request_date)} • {markStatusModal.booking && formatTime12Hour(markStatusModal.booking.start_time)} - {markStatusModal.booking && formatTime12Hour(markStatusModal.booking.end_time)}
                        </p>
                        {markStatusModal.booking?.bay_name && (
                            <p className="text-gray-500 dark:text-gray-400">
                                {markStatusModal.booking.bay_name}
                            </p>
                        )}
                    </div>
                    
                    {markStatusModal.confirmNoShow ? (
                        <div className="flex gap-3">
                            <button
                                onClick={() => setMarkStatusModal({ ...markStatusModal, confirmNoShow: false })}
                                className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
                            >
                                Go Back
                            </button>
                            <button
                                onClick={async () => {
                                    if (!markStatusModal.booking) return;
                                    const booking = markStatusModal.booking;
                                    setMarkStatusModal({ booking: null, confirmNoShow: false });
                                    await updateBookingStatusOptimistic(booking, 'no_show');
                                }}
                                className="flex-1 py-3 px-4 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-2"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">person_off</span>
                                Confirm No Show
                            </button>
                        </div>
                    ) : (
                        <div className="flex gap-3">
                            <button
                                onClick={async () => {
                                    if (!markStatusModal.booking) return;
                                    const booking = markStatusModal.booking;
                                    setMarkStatusModal({ booking: null, confirmNoShow: false });
                                    await updateBookingStatusOptimistic(booking, 'attended');
                                }}
                                className="flex-1 py-3 px-4 rounded-lg bg-green-500 hover:bg-green-600 text-white font-medium flex items-center justify-center gap-2"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">check_circle</span>
                                Attended
                            </button>
                            <button
                                onClick={() => setMarkStatusModal({ ...markStatusModal, confirmNoShow: true })}
                                className="flex-1 py-3 px-4 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-2"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">person_off</span>
                                No Show
                            </button>
                        </div>
                    )}
                    
                    <button
                        onClick={() => setMarkStatusModal({ booking: null, confirmNoShow: false })}
                        className="w-full py-2 px-4 rounded-lg text-gray-500 dark:text-gray-400 text-sm font-medium hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            </ModalShell>

            <CheckinBillingModal
              isOpen={billingModal.isOpen}
              onClose={() => setBillingModal({isOpen: false, bookingId: null})}
              bookingId={billingModal.bookingId || 0}
              onCheckinComplete={() => {
                setBillingModal({isOpen: false, bookingId: null});
                handleRefresh();
              }}
            />
            
            <CompleteRosterModal
              isOpen={rosterModal.isOpen}
              bookingId={rosterModal.bookingId || 0}
              onClose={() => setRosterModal({isOpen: false, bookingId: null})}
              onComplete={() => {
                setRosterModal({isOpen: false, bookingId: null});
                handleRefresh();
              }}
            />

            <TrackmanBookingModal
              isOpen={trackmanModal.isOpen}
              onClose={() => setTrackmanModal({ isOpen: false, booking: null })}
              booking={trackmanModal.booking}
              onConfirm={handleTrackmanConfirm}
            />

            <StaffManualBookingModal
              isOpen={staffManualBookingModalOpen}
              onClose={() => {
                setStaffManualBookingModalOpen(false);
                setStaffManualBookingDefaults({});
              }}
              onSubmit={handleStaffManualBookingSubmit}
              defaultResourceId={staffManualBookingDefaults.resourceId}
              defaultStartTime={staffManualBookingDefaults.startTime}
              defaultDate={staffManualBookingDefaults.date}
            />

            <TrackmanLinkModal
              isOpen={trackmanLinkModal.isOpen}
              onClose={() => setTrackmanLinkModal({ isOpen: false, trackmanBookingId: null })}
              trackmanBookingId={trackmanLinkModal.trackmanBookingId}
              bayName={trackmanLinkModal.bayName}
              bookingDate={trackmanLinkModal.bookingDate}
              timeSlot={trackmanLinkModal.timeSlot}
              matchedBookingId={trackmanLinkModal.matchedBookingId}
              currentMemberName={trackmanLinkModal.currentMemberName}
              currentMemberEmail={trackmanLinkModal.currentMemberEmail}
              isRelink={trackmanLinkModal.isRelink}
              importedName={trackmanLinkModal.importedName}
              notes={trackmanLinkModal.notes}
              onSuccess={() => {
                showToast(trackmanLinkModal.isRelink ? 'Booking owner changed' : 'Trackman booking linked to member', 'success');
                handleRefresh();
              }}
              onOpenBillingModal={(bookingId) => setBillingModal({ isOpen: true, bookingId })}
            />

            <ModalShell 
              isOpen={cancelConfirmModal.isOpen} 
              onClose={() => !cancelConfirmModal.isCancelling && setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false })} 
              showCloseButton={!cancelConfirmModal.isCancelling}
            >
              <div className="p-6">
                {!cancelConfirmModal.showSuccess ? (
                  <>
                    <div className="flex items-center justify-center mb-4">
                      <div className={`w-16 h-16 rounded-full flex items-center justify-center ${cancelConfirmModal.hasTrackman ? 'bg-amber-100 dark:bg-amber-500/20' : 'bg-red-100 dark:bg-red-500/20'}`}>
                        <span className={`material-symbols-outlined text-3xl ${cancelConfirmModal.hasTrackman ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                          {cancelConfirmModal.hasTrackman ? 'warning' : 'event_busy'}
                        </span>
                      </div>
                    </div>
                    <h3 className="text-xl font-bold text-center text-primary dark:text-white mb-2">
                      Cancel Booking?
                    </h3>
                    <p className="text-sm text-center text-gray-600 dark:text-gray-300 mb-4">
                      Cancel booking for {cancelConfirmModal.booking?.user_name || cancelConfirmModal.booking?.user_email}?
                    </p>
                    
                    {cancelConfirmModal.hasTrackman && (
                      <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-4 mb-4">
                        <div className="flex gap-3">
                          <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-xl flex-shrink-0">info</span>
                          <div>
                            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                              This booking is linked to Trackman
                            </p>
                            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                              After cancelling here, you'll need to also cancel it in Trackman.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    <div className="flex gap-3">
                      <button
                        onClick={() => setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false })}
                        disabled={cancelConfirmModal.isCancelling}
                        className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                      >
                        Keep Booking
                      </button>
                      <button
                        onClick={performCancellation}
                        disabled={cancelConfirmModal.isCancelling}
                        className="flex-1 py-3 px-4 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        {cancelConfirmModal.isCancelling ? (
                          <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                        ) : (
                          <span className="material-symbols-outlined text-sm">check</span>
                        )}
                        {cancelConfirmModal.isCancelling ? 'Cancelling...' : 'Yes, Cancel'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-center mb-4">
                      <div className="w-16 h-16 rounded-full flex items-center justify-center bg-green-100 dark:bg-green-500/20">
                        <span className="material-symbols-outlined text-3xl text-green-600 dark:text-green-400">check_circle</span>
                      </div>
                    </div>
                    <h3 className="text-xl font-bold text-center text-primary dark:text-white mb-2">
                      Booking Cancelled
                    </h3>
                    <p className="text-sm text-center text-gray-600 dark:text-gray-300 mb-4">
                      The booking has been cancelled in the app.
                    </p>
                    
                    <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-4 mb-4">
                      <div className="flex gap-3">
                        <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-xl flex-shrink-0">task_alt</span>
                        <div>
                          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                            Action Required: Cancel in Trackman
                          </p>
                          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                            Please also cancel this booking in the Trackman system to keep both systems in sync.
                          </p>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex gap-3">
                      <button
                        onClick={() => setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false })}
                        className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-white/5"
                      >
                        Done
                      </button>
                      <button
                        onClick={() => {
                          window.open('https://booking.indoorgolf.io', '_blank');
                          setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false });
                        }}
                        className="flex-1 py-3 px-4 rounded-lg bg-primary hover:bg-primary/90 text-white font-medium flex items-center justify-center gap-2"
                      >
                        <span className="material-symbols-outlined text-sm">open_in_new</span>
                        Open Trackman
                      </button>
                    </div>
                  </>
                )}
              </div>
            </ModalShell>
                </div>
                
                {/* Trackman Webhook Events - Separate full-width card below main content */}
                <div className="w-full mt-4">
                  <TrackmanWebhookEventsSection 
                    compact={false} 
                    onLinkToMember={handleLinkTrackmanToMember}
                  />
                </div>

                {/* FAB for Staff Manual Booking */}
                <FloatingActionButton
                  onClick={() => setStaffManualBookingModalOpen(true)}
                  icon="add"
                  color="brand"
                  label="Create Booking for Member"
                />
            </AnimatedPage>
    );
};

export default SimulatorTab;
