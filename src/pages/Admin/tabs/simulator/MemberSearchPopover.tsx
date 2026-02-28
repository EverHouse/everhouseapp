import React, { useState, useEffect, useMemo, useRef } from 'react';
import EmptyState from '../../../../components/EmptyState';
import ModalShell from '../../../../components/ModalShell';
import { useToast } from '../../../../components/Toast';
import { getTodayPacific, formatTime12Hour } from '../../../../utils/dateUtils';
import type { Resource, MemberSearchResult, ManualBookingResult } from './simulatorTypes';

const ManualBookingModal: React.FC<{
    resources: Resource[];
    onClose: () => void;
    onSuccess: (booking?: ManualBookingResult) => void;
    defaultMemberEmail?: string;
    defaultResourceId?: number;
    defaultDate?: string;
    defaultStartTime?: string;
}> = ({ resources, onClose, onSuccess, defaultMemberEmail, defaultResourceId, defaultDate, defaultStartTime }) => {
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
            } catch (err: unknown) {
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
            } catch (err: unknown) {
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
            } catch (err: unknown) {
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
                    trackman_booking_id: trackmanBookingId || undefined
                })
            });

            if (res.ok) {
                const data = await res.json();
                showToast('Booking created successfully!', 'success');
                
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
        } catch (err: unknown) {
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
        <ModalShell isOpen={true} onClose={onClose} title="Manual Booking" showCloseButton={true}>
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
                                            className="absolute z-50 w-full mt-1 bg-white dark:bg-[#293515] border border-gray-200 dark:border-white/20 rounded-lg shadow-lg max-h-60 overflow-y-auto"
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
                                                        <span className="text-xs px-2 py-0.5 rounded-[4px] bg-accent/20 text-primary dark:text-accent font-medium">
                                                            {member.tier}
                                                        </span>
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    {searchQuery.length >= 2 && !isSearching && searchResults.length === 0 && (
                                        <EmptyState
                                            icon="group"
                                            title={`No members found matching "${searchQuery}"`}
                                            variant="compact"
                                        />
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

export default ManualBookingModal;
