import React, { useState, useEffect, useMemo, useRef } from 'react';
import ModalShell from '../../../../components/ModalShell';
import { useToast } from '../../../../components/Toast';
import { getTodayPacific, formatTime12Hour } from '../../../../utils/dateUtils';
import { MemberSearchInput, type SelectedMember } from '../../../../components/shared/MemberSearchInput';
import type { Resource, ManualBookingResult } from './simulatorTypes';
import { fetchWithCredentials, postWithCredentials } from '../../../../hooks/queries/useFetch';

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
    const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);

    const availableDurations = useMemo(() => [30, 60, 90, 120, 150, 180, 210, 240, 270, 300], []);

    const lookupTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        if (defaultResourceId !== undefined) setResourceId(defaultResourceId || '');
    }, [defaultResourceId]);

    useEffect(() => {
        if (defaultDate !== undefined) setBookingDate(defaultDate || getTodayPacific());
    }, [defaultDate]);

    useEffect(() => {
        if (defaultStartTime !== undefined) setStartTime(defaultStartTime || '10:00');
    }, [defaultStartTime]);

    const handleSelectMember = (member: SelectedMember) => {
        setMemberEmail(member.email);
        setSelectedMember(member);
        setMemberLookupStatus('found');
        setMemberName(member.name);
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
                const member = await fetchWithCredentials<{ firstName?: string; lastName?: string; tier?: string }>(`/api/members/${encodeURIComponent(normalizedEmail)}/details`);
                setMemberLookupStatus('found');
                setMemberName(member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : null);
                if (member.tier && !memberTier) {
                    setMemberTier(member.tier);
                }
            } catch (_err: unknown) {
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
    }, [memberEmail, memberTier]);

    useEffect(() => {
        if (!memberEmail || memberLookupStatus !== 'found' || !bookingDate || !resourceId) {
            setExistingBookingWarning(null);
            return;
        }

        const checkExistingBookings = async () => {
            try {
                const selectedResource = resources.find(r => r.id === resourceId);
                const resourceType = selectedResource?.type || 'simulator';
                
                const data = await fetchWithCredentials<{ hasExisting?: boolean }>(`/api/bookings/check-existing-staff?member_email=${encodeURIComponent(memberEmail)}&date=${bookingDate}&resource_type=${resourceType}`);
                if (data.hasExisting) {
                    const typeLabel = resourceType === 'conference_room' ? 'conference room' : 'bay';
                    setExistingBookingWarning(`This member already has a ${typeLabel} booking on ${bookingDate}`);
                } else {
                    setExistingBookingWarning(null);
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
            const data = await postWithCredentials<{ id?: number; booking?: { id?: number } }>('/api/staff/bookings/manual', {
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
            });

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
        } catch (_err: unknown) {
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
                        <div>
                            <MemberSearchInput
                                forceApiSearch
                                includeVisitors
                                showTier
                                onSelect={handleSelectMember}
                                onClear={() => {
                                    setMemberEmail('');
                                    setMemberName(null);
                                    setMemberTier(null);
                                    setMemberLookupStatus('idle');
                                    setSelectedMember(null);
                                    setExistingBookingWarning(null);
                                }}
                                selectedMember={selectedMember}
                                placeholder="Search by name or email..."
                                label="Member *"
                            />
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
