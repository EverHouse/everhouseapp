import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import EmptyState from '../../../components/EmptyState';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usePageReady } from '../../../contexts/PageReadyContext';
import { useData, MemberProfile } from '../../../contexts/DataContext';
import { formatDateDisplayWithDay, formatDateTimePacific, getTodayPacific } from '../../../utils/dateUtils';
import { getApiErrorMessage, getNetworkErrorMessage } from '../../../utils/errorHandling';
import PullToRefresh from '../../../components/PullToRefresh';
import { useToast } from '../../../components/Toast';
import FloatingActionButton from '../../../components/FloatingActionButton';
import { SlideUpDrawer } from '../../../components/SlideUpDrawer';
import TierBadge from '../../../components/TierBadge';
import { AnimatedPage } from '../../../components/motion';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials } from '../../../hooks/queries/useFetch';
import { EventsTabSkeleton } from '../../../components/skeletons';
import PageErrorBoundary from '../../../components/PageErrorBoundary';

interface Participant {
    id: number;
    userEmail: string;
    status: string;
    source?: string | null;
    attendeeName?: string | null;
    ticketClass?: string | null;
    checkedIn?: boolean | null;
    matchedUserId?: string | null;
    guestCount?: number | null;
    orderDate?: string | null;
    createdAt: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
}

interface DBEvent {
    id: number;
    title: string;
    description: string;
    event_date: string;
    start_time: string;
    end_time: string;
    location: string;
    category: string;
    image_url: string | null;
    max_attendees: number | null;
    eventbrite_id: string | null;
    eventbrite_url: string | null;
    external_url?: string | null;
    visibility?: string;
    block_bookings?: boolean;
    block_simulators?: boolean;
    block_conference_room?: boolean;
}

interface WellnessClass {
  id: number;
  title: string;
  time: string;
  instructor: string;
  duration: string;
  category: string;
  spots: string;
  status: string;
  description: string | null;
  date: string;
  is_active: boolean;
  image_url?: string | null;
  external_url?: string | null;
  visibility?: string;
  block_bookings?: boolean;
  block_simulators?: boolean;
  block_conference_room?: boolean;
  capacity?: number | null;
  waitlist_enabled?: boolean;
  enrolled_count?: number;
  waitlist_count?: number;
  needs_review?: boolean;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  conflict_detected?: boolean;
}

interface WellnessFormData extends Partial<WellnessClass> {
  imageFile?: File | null;
  endTime?: string;
}

interface Resource {
  id: number;
  name: string;
  type: string;
}

const CATEGORY_TABS = [
    { id: 'all', label: 'All', icon: 'calendar_month' },
    { id: 'Social', label: 'Social', icon: 'celebration' },
    { id: 'Golf', label: 'Golf', icon: 'golf_course' },
    { id: 'Tournaments', label: 'Tournaments', icon: 'emoji_events' },
    { id: 'Dining', label: 'Dining', icon: 'restaurant' },
    { id: 'Networking', label: 'Networking', icon: 'handshake' },
    { id: 'Workshops', label: 'Workshops', icon: 'school' },
    { id: 'Family', label: 'Family', icon: 'family_restroom' },
    { id: 'Entertainment', label: 'Entertainment', icon: 'music_note' },
    { id: 'Charity', label: 'Charity', icon: 'volunteer_activism' },
];

const WELLNESS_CATEGORY_TABS = [
    { id: 'all', label: 'All', icon: 'calendar_month' },
    { id: 'Classes', label: 'Classes', icon: 'fitness_center' },
    { id: 'MedSpa', label: 'MedSpa', icon: 'spa' },
    { id: 'Recovery', label: 'Recovery', icon: 'ac_unit' },
    { id: 'Therapy', label: 'Therapy', icon: 'healing' },
    { id: 'Nutrition', label: 'Nutrition', icon: 'nutrition' },
    { id: 'Personal Training', label: 'Training', icon: 'sports' },
    { id: 'Mindfulness', label: 'Mindfulness', icon: 'self_improvement' },
    { id: 'Outdoors', label: 'Outdoors', icon: 'hiking' },
    { id: 'General', label: 'General', icon: 'category' },
];

interface ParticipantDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    participants: Participant[];
    isLoading: boolean;
    type: 'rsvp' | 'enrollment';
    eventId?: number;
    classId?: number;
    onRefresh?: () => void;
    eventbriteId?: string | null;
}

const ParticipantDetailsModal: React.FC<ParticipantDetailsModalProps> = ({
    isOpen,
    onClose,
    title,
    subtitle,
    participants,
    isLoading,
    type,
    eventId,
    classId,
    onRefresh,
    eventbriteId
}) => {
    const { showToast } = useToast();
    const { members } = useData();
    const queryClient = useQueryClient();
    const [isAdding, setIsAdding] = useState(false);
    const [newEmail, setNewEmail] = useState('');
    const [addError, setAddError] = useState<string | null>(null);
    const [syncResult, setSyncResult] = useState<{ synced: number; matched: number } | null>(null);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [filteredMembers, setFilteredMembers] = useState<MemberProfile[]>([]);
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
    
    const [deletingParticipantIds, setDeletingParticipantIds] = useState<Set<number>>(new Set());
    const [optimisticParticipants, setOptimisticParticipants] = useState<Participant[]>([]);
    const [pendingAddEmail, setPendingAddEmail] = useState<string | null>(null);

    const deleteRsvpMutation = useMutation({
        mutationFn: (rsvpId: number) => 
            deleteWithCredentials(`/api/events/${eventId}/rsvps/${rsvpId}`),
        onMutate: async (rsvpId) => {
            setDeletingParticipantIds(prev => new Set(prev).add(rsvpId));
            setConfirmDeleteId(null);
            return { rsvpId };
        },
        onSuccess: (_, __, context) => {
            if (context?.rsvpId) {
                setDeletingParticipantIds(prev => {
                    const next = new Set(prev);
                    next.delete(context.rsvpId);
                    return next;
                });
            }
            showToast('RSVP removed successfully', 'success');
            queryClient.invalidateQueries({ queryKey: ['event-rsvps', eventId] });
            onRefresh?.();
        },
        onError: (error: Error, _, context) => {
            if (context?.rsvpId) {
                setDeletingParticipantIds(prev => {
                    const next = new Set(prev);
                    next.delete(context.rsvpId);
                    return next;
                });
            }
            showToast(error.message || 'Failed to remove RSVP', 'error');
        }
    });

    const deleteEnrollmentMutation = useMutation({
        mutationFn: ({ userEmail, participantId }: { userEmail: string; participantId: number }) => 
            deleteWithCredentials(`/api/wellness-enrollments/${classId}/${encodeURIComponent(userEmail)}`),
        onMutate: async ({ participantId }) => {
            setDeletingParticipantIds(prev => new Set(prev).add(participantId));
            setConfirmDeleteId(null);
            return { participantId };
        },
        onSuccess: (_, __, context) => {
            if (context?.participantId) {
                setDeletingParticipantIds(prev => {
                    const next = new Set(prev);
                    next.delete(context.participantId);
                    return next;
                });
            }
            showToast('Enrollment removed successfully', 'success');
            queryClient.invalidateQueries({ queryKey: ['class-enrollments', classId] });
            onRefresh?.();
        },
        onError: (error: Error, _, context) => {
            if (context?.participantId) {
                setDeletingParticipantIds(prev => {
                    const next = new Set(prev);
                    next.delete(context.participantId);
                    return next;
                });
            }
            showToast(error.message || 'Failed to remove enrollment', 'error');
        }
    });

    const syncEventbriteMutation = useMutation({
        mutationFn: () => 
            postWithCredentials<{ synced: number; matched: number }>(`/api/events/${eventId}/sync-eventbrite-attendees`, {}),
        onSuccess: (data) => {
            setSyncResult({ synced: data.synced, matched: data.matched });
            showToast(`Synced ${data.synced} attendees, ${data.matched} matched to members`, 'success');
            queryClient.invalidateQueries({ queryKey: ['event-rsvps', eventId] });
            onRefresh?.();
        },
        onError: () => {
            showToast('Failed to sync Eventbrite attendees', 'error');
        }
    });

    const addParticipantMutation = useMutation({
        mutationFn: (email: string) => {
            const url = type === 'rsvp' 
                ? `/api/events/${eventId}/rsvps/manual`
                : `/api/wellness-classes/${classId}/enrollments/manual`;
            return postWithCredentials(url, { email });
        },
        onMutate: async (email) => {
            setPendingAddEmail(email);
            const tempId = -Date.now();
            const optimisticParticipant: Participant = {
                id: tempId,
                userEmail: email,
                status: 'confirmed',
                createdAt: new Date().toISOString(),
                firstName: null,
                lastName: null,
                phone: null,
            };
            setOptimisticParticipants(prev => [...prev, optimisticParticipant]);
            setNewEmail('');
            setIsAdding(false);
            return { tempId, email };
        },
        onSuccess: (_, __, context) => {
            if (context?.tempId) {
                setOptimisticParticipants(prev => prev.filter(p => p.id !== context.tempId));
            }
            setPendingAddEmail(null);
            showToast(`${type === 'rsvp' ? 'RSVP' : 'Enrollment'} added successfully`, 'success');
            if (type === 'rsvp') {
                queryClient.invalidateQueries({ queryKey: ['event-rsvps', eventId] });
            } else {
                queryClient.invalidateQueries({ queryKey: ['class-enrollments', classId] });
            }
            onRefresh?.();
        },
        onError: (error: Error, _, context) => {
            if (context?.tempId) {
                setOptimisticParticipants(prev => prev.filter(p => p.id !== context.tempId));
            }
            setPendingAddEmail(null);
            setAddError(error.message || `Failed to add ${type === 'rsvp' ? 'RSVP' : 'enrollment'}`);
        }
    });

    const handleDeleteRsvp = (rsvpId: number) => {
        if (!eventId) return;
        deleteRsvpMutation.mutate(rsvpId);
    };

    const handleDeleteEnrollment = (participantId: number, userEmail: string) => {
        if (!classId) return;
        deleteEnrollmentMutation.mutate({ userEmail, participantId });
    };
    
    const allParticipants = [...participants, ...optimisticParticipants]
        .filter(p => !deletingParticipantIds.has(p.id));

    const handleEmailChange = (value: string) => {
        setNewEmail(value);
        if (value.trim().length > 0) {
            const searchTerm = value.toLowerCase();
            const matches = members.filter(m => 
                m.name.toLowerCase().includes(searchTerm) || 
                m.email.toLowerCase().includes(searchTerm)
            ).slice(0, 5);
            setFilteredMembers(matches);
            setShowSuggestions(matches.length > 0);
        } else {
            setFilteredMembers([]);
            setShowSuggestions(false);
        }
    };

    const handleSelectMember = (member: MemberProfile) => {
        setNewEmail(member.email);
        setShowSuggestions(false);
        setFilteredMembers([]);
    };

    const handleInputBlur = () => {
        setTimeout(() => {
            setShowSuggestions(false);
        }, 200);
    };

    const handleSyncEventbrite = () => {
        if (!eventId) return;
        setSyncResult(null);
        syncEventbriteMutation.mutate();
    };

    const formatDate = (dateStr: string) => {
        return formatDateTimePacific(dateStr);
    };

    const handleAdd = () => {
        if (!newEmail.trim()) {
            setAddError('Email is required');
            return;
        }
        if (!newEmail.includes('@')) {
            setAddError('Please enter a valid email');
            return;
        }
        setAddError(null);
        addParticipantMutation.mutate(newEmail.trim());
    };

    return (
        <SlideUpDrawer 
            isOpen={isOpen} 
            onClose={onClose}
            title={subtitle ? `${title} — ${subtitle}` : title}
            maxHeight="large"
        >
            <div className="p-5">

                {isLoading ? (
                    <div className="flex items-center justify-center py-12">
                        <span aria-hidden="true" className="material-symbols-outlined animate-spin text-2xl text-gray-600 dark:text-gray-500">progress_activity</span>
                    </div>
                ) : (
                    <>
                        {isAdding ? (
                            <div className="mb-4 p-4 bg-gray-50 dark:bg-white/5 rounded-lg border border-gray-200 dark:border-white/25">
                                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    Add {type === 'rsvp' ? 'RSVP' : 'Enrollment'} Manually
                                </p>
                                <div className="relative">
                                    <input 
                                        type="email"
                                        value={newEmail}
                                        onChange={(e) => handleEmailChange(e.target.value)}
                                        onBlur={handleInputBlur}
                                        onFocus={() => newEmail.trim() && filteredMembers.length > 0 && setShowSuggestions(true)}
                                        placeholder="Enter email address or search member"
                                        className="w-full p-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-primary dark:text-white text-sm placeholder:text-gray-500"
                                    />
                                    {showSuggestions && filteredMembers.length > 0 && (
                                        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-white/25 rounded-lg shadow-lg overflow-hidden">
                                            {filteredMembers.map((member) => (
                                                <button
                                                    key={member.id}
                                                    type="button"
                                                    onClick={() => handleSelectMember(member)}
                                                    className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors text-left border-b border-gray-100 dark:border-white/10 last:border-b-0"
                                                >
                                                    <div className="w-8 h-8 rounded-full bg-accent/20 text-brand-green flex items-center justify-center font-bold text-xs shrink-0">
                                                        {(member.name || member.email || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-medium text-primary dark:text-white truncate">{member.name || member.email || 'Unknown'}</p>
                                                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{member.email}</p>
                                                    </div>
                                                    <TierBadge tier={member.tier} size="sm" />
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                {addError && (
                                    <p className="text-xs text-red-500 mt-1">{addError}</p>
                                )}
                                <div className="flex gap-2 mt-3">
                                    <button
                                        onClick={() => { setIsAdding(false); setNewEmail(''); setAddError(null); }}
                                        className="flex-1 py-2 px-3 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-400 text-sm font-medium"
                                        disabled={addParticipantMutation.isPending}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleAdd}
                                        disabled={addParticipantMutation.isPending}
                                        className="flex-1 py-2 px-3 rounded-lg bg-primary text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-1"
                                    >
                                        {addParticipantMutation.isPending && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                                        Add
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex gap-2 mb-4">
                                <button
                                    onClick={() => setIsAdding(true)}
                                    className="flex-1 py-2.5 px-4 rounded-lg border-2 border-dashed border-gray-200 dark:border-white/25 text-gray-500 dark:text-gray-400 text-sm font-medium flex items-center justify-center gap-2 hover:border-primary/30 hover:text-primary dark:hover:border-white/30 dark:hover:text-white transition-colors"
                                >
                                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">person_add</span>
                                    Add Manually
                                </button>
                                {type === 'rsvp' && eventbriteId && (
                                    <button
                                        onClick={handleSyncEventbrite}
                                        disabled={syncEventbriteMutation.isPending}
                                        className="py-2.5 px-4 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-600 dark:text-orange-400 text-sm font-medium flex items-center justify-center gap-2 hover:bg-orange-500/20 transition-colors disabled:opacity-50"
                                    >
                                        {syncEventbriteMutation.isPending ? (
                                            <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
                                        ) : (
                                            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">sync</span>
                                        )}
                                        Sync Eventbrite
                                    </button>
                                )}
                            </div>
                        )}

                        {syncResult && (
                            <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800/30 text-sm text-green-700 dark:text-green-400">
                                Synced {syncResult.synced} attendees, {syncResult.matched} matched to members
                            </div>
                        )}

                        {allParticipants.length === 0 ? (
                            <div className="text-center py-12 text-gray-600 dark:text-gray-500">
                                <span aria-hidden="true" className="material-symbols-outlined text-4xl mb-2 block">
                                    {type === 'rsvp' ? 'event_busy' : 'person_off'}
                                </span>
                                <p>No {type === 'rsvp' ? 'RSVPs' : 'enrollments'} yet</p>
                            </div>
                        ) : (() => {
                            const grouped = allParticipants.reduce((acc, p) => {
                                const displayName = p.firstName && p.lastName 
                                    ? `${p.firstName} ${p.lastName}` 
                                    : p.attendeeName || p.userEmail;
                                const normalizedName = displayName.toLowerCase().trim();
                                if (!acc[normalizedName]) {
                                    acc[normalizedName] = [];
                                }
                                acc[normalizedName].push({ ...p, displayName });
                                return acc;
                            }, {} as Record<string, (Participant & { displayName: string })[]>);

                            const groupedEntries = Object.entries(grouped);
                            const totalHeadcount = allParticipants.reduce((sum, p) => sum + 1 + (p.guestCount || 0), 0);

                            return (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-bold uppercase tracking-wider text-gray-600 dark:text-gray-500">
                                            {groupedEntries.length} {type === 'rsvp' ? 'RSVP' : 'Enrolled'}{groupedEntries.length !== 1 ? 's' : ''}
                                        </span>
                                        <span className="text-xs font-bold uppercase tracking-wider text-primary dark:text-white bg-primary/10 dark:bg-white/10 px-2 py-1 rounded">
                                            {totalHeadcount} Total Attendee{totalHeadcount !== 1 ? 's' : ''}
                                        </span>
                                    </div>
                                    {groupedEntries.map(([_, group]) => {
                                        const primary = group[0];
                                        const guestCount = group.reduce((sum, p) => sum + (p.guestCount || 0), 0);
                                        const isEventbrite = primary.source === 'eventbrite';
                                        const isMember = Boolean(primary.matchedUserId || (primary.firstName && primary.lastName));
                                        const isOptimistic = primary.id < 0;
                                        const isDeleting = deletingParticipantIds.has(primary.id);
                                        
                                        return (
                                            <div 
                                                key={primary.id}
                                                className={`p-4 rounded-xl border transition-all ${
                                                    isOptimistic 
                                                        ? 'bg-brand-green/10 dark:bg-brand-green/20 border-brand-green/30 animate-pulse' 
                                                        : isDeleting
                                                            ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/30 opacity-50'
                                                            : 'bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/20'
                                                }`}
                                            >
                                                <div className="flex items-start justify-between mb-2">
                                                    <div className="flex items-center gap-3">
                                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${
                                                            isOptimistic
                                                                ? 'bg-brand-green/30 text-brand-green'
                                                                : isMember 
                                                                    ? 'bg-accent/20 text-brand-green' 
                                                                    : isEventbrite 
                                                                        ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400' 
                                                                        : 'bg-gray-100 dark:bg-white/10 text-gray-500'
                                                        }`}>
                                                            {isOptimistic ? (
                                                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                                                            ) : (
                                                                (primary.firstName?.[0] || primary.attendeeName?.[0] || primary.userEmail[0]).toUpperCase()
                                                            )}
                                                        </div>
                                                        <div>
                                                            <p className="font-semibold text-primary dark:text-white">
                                                                {primary.displayName}
                                                                {isOptimistic && (
                                                                    <span className="ml-2 text-sm font-normal text-brand-green">
                                                                        Adding...
                                                                    </span>
                                                                )}
                                                                {guestCount > 0 && !isOptimistic && (
                                                                    <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                                                                        (+{guestCount} guest{guestCount !== 1 ? 's' : ''})
                                                                    </span>
                                                                )}
                                                            </p>
                                                            {primary.displayName !== primary.userEmail && (
                                                                <p className="text-sm text-gray-500 dark:text-gray-400">{primary.userEmail}</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {isOptimistic ? (
                                                            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded shrink-0 bg-brand-green/20 text-brand-green flex items-center gap-1">
                                                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[10px]">progress_activity</span>
                                                                Adding...
                                                            </span>
                                                        ) : (
                                                            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded shrink-0 ${
                                                                type === 'rsvp' 
                                                                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                                                                    : 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
                                                            }`}>
                                                                {type === 'rsvp' ? 'RSVP' : 'Enrolled'}
                                                            </span>
                                                        )}
                                                        {!isOptimistic && !isDeleting && confirmDeleteId === primary.id ? (
                                                            <div className="flex items-center gap-1">
                                                                <button
                                                                    onClick={() => type === 'rsvp' ? handleDeleteRsvp(primary.id) : handleDeleteEnrollment(primary.id, primary.userEmail)}
                                                                    className="p-1.5 rounded-lg bg-red-500 text-white text-xs font-medium min-w-[44px] min-h-[32px] flex items-center justify-center"
                                                                    aria-label="Confirm remove"
                                                                >
                                                                    Yes
                                                                </button>
                                                                <button
                                                                    onClick={() => setConfirmDeleteId(null)}
                                                                    className="p-1.5 rounded-lg border border-gray-300 dark:border-white/25 text-gray-600 dark:text-gray-400 text-xs font-medium min-w-[44px] min-h-[32px]"
                                                                    aria-label="Cancel remove"
                                                                >
                                                                    No
                                                                </button>
                                                            </div>
                                                        ) : !isOptimistic && !isDeleting && (
                                                            <button
                                                                onClick={() => setConfirmDeleteId(primary.id)}
                                                                className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors min-w-[32px] min-h-[32px] flex items-center justify-center"
                                                                aria-label={type === 'rsvp' ? 'Remove RSVP' : 'Remove enrollment'}
                                                            >
                                                                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                                    {isEventbrite && (
                                                        <span className="font-bold uppercase tracking-wider bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 px-2 py-0.5 rounded">
                                                            Eventbrite
                                                        </span>
                                                    )}
                                                    {isMember && (
                                                        <span className="font-bold uppercase tracking-wider bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 px-2 py-0.5 rounded">
                                                            Member
                                                        </span>
                                                    )}
                                                    {primary.ticketClass && (
                                                        <span className="text-gray-500 dark:text-gray-400">
                                                            {primary.ticketClass}
                                                        </span>
                                                    )}
                                                    <span className="text-gray-400 dark:text-gray-500 ml-auto">
                                                        RSVP: {formatDate(primary.orderDate || primary.createdAt)}
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })()}
                    </>
                )}
            </div>
        </SlideUpDrawer>
    );
};

interface NeedsReviewEvent {
    id: number;
    title: string;
    description: string | null;
    event_date: string;
    start_time: string;
    end_time: string | null;
    location: string | null;
    category: string | null;
    source: string | null;
    visibility: string | null;
    needs_review: boolean;
    conflict_detected?: boolean;
    block_simulators?: boolean;
    block_conference_room?: boolean;
}

const EventsAdminContent: React.FC = () => {
    const { setPageReady } = usePageReady();
    const { showToast } = useToast();
    const queryClient = useQueryClient();
    const [activeCategory, setActiveCategory] = useState('all');
    const [isEditing, setIsEditing] = useState(false);
    const [editId, setEditId] = useState<number | null>(null);
    const [newItem, setNewItem] = useState<Partial<DBEvent>>({ category: 'Social' });
    const [error, setError] = useState<string | null>(null);
    const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
    
    const [pendingEventIds, setPendingEventIds] = useState<Set<number>>(new Set());
    const [deletingEventIds, setDeletingEventIds] = useState<Set<number>>(new Set());
    const [optimisticEvents, setOptimisticEvents] = useState<DBEvent[]>([]);

    const eventValidation = {
        category: !newItem.category || newItem.category === '' || newItem.category === 'Event',
        description: !newItem.description || newItem.description.trim() === '',
        location: !newItem.location || newItem.location.trim() === ''
    };
    const isEventFormValid = !eventValidation.category && !eventValidation.description && !eventValidation.location;
    const markTouched = (field: string) => setTouchedFields(prev => new Set(prev).add(field));
    const [isViewingRsvps, setIsViewingRsvps] = useState(false);
    const [selectedEvent, setSelectedEvent] = useState<DBEvent | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [eventToDelete, setEventToDelete] = useState<DBEvent | null>(null);
    const [eventCascadePreview, setEventCascadePreview] = useState<{ rsvps: number } | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    
    const [needsReviewExpanded, setNeedsReviewExpanded] = useState(true);
    const [showPastEvents, setShowPastEvents] = useState(false);
    const [showAllPastEvents, setShowAllPastEvents] = useState(false);

    const { data: events = [], isLoading } = useQuery({
        queryKey: ['admin-events'],
        queryFn: () => fetchWithCredentials<DBEvent[]>('/api/events?include_past=true')
    });

    const { data: needsReviewEvents = [], isLoading: needsReviewLoading } = useQuery({
        queryKey: ['events-needs-review'],
        queryFn: () => fetchWithCredentials<NeedsReviewEvent[]>('/api/events/needs-review')
    });

    const { data: rsvps = [], isLoading: isLoadingRsvps, refetch: refetchRsvps } = useQuery({
        queryKey: ['event-rsvps', selectedEvent?.id],
        queryFn: () => fetchWithCredentials<Participant[]>(`/api/events/${selectedEvent!.id}/rsvps`),
        enabled: !!selectedEvent && isViewingRsvps
    });

    useEffect(() => {
        if (!isLoading) {
            setPageReady(true);
        }
    }, [isLoading, setPageReady]);

    useEffect(() => {
        if (needsReviewEvents.length > 0) {
            setNeedsReviewExpanded(true);
        }
    }, [needsReviewEvents.length]);

    const saveEventMutation = useMutation({
        mutationFn: async (payload: Record<string, unknown>) => {
            const url = editId ? `/api/events/${editId}` : '/api/events';
            const method = editId ? 'PUT' : 'POST';
            return fetchWithCredentials<DBEvent>(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        },
        onMutate: async (payload) => {
            const tempId = editId || -Date.now();
            setPendingEventIds(prev => new Set(prev).add(tempId));
            
            if (!editId) {
                const optimisticEvent: DBEvent = {
                    id: tempId,
                    title: String(payload.title || ''),
                    description: String(payload.description || ''),
                    event_date: String(payload.event_date || ''),
                    start_time: String(payload.start_time || ''),
                    end_time: String(payload.end_time || ''),
                    location: String(payload.location || ''),
                    category: String(payload.category || 'Social'),
                    image_url: payload.image_url as string | null,
                    max_attendees: payload.max_attendees as number | null,
                    eventbrite_id: null,
                    eventbrite_url: null,
                    external_url: payload.external_url as string | undefined,
                    visibility: payload.visibility as string | undefined,
                    block_bookings: Boolean(payload.block_bookings),
                    block_simulators: Boolean(payload.block_simulators),
                    block_conference_room: Boolean(payload.block_conference_room),
                };
                setOptimisticEvents(prev => [...prev, optimisticEvent]);
            }
            
            setIsEditing(false);
            return { tempId };
        },
        onSuccess: (_, __, context) => {
            if (context?.tempId) {
                setPendingEventIds(prev => {
                    const next = new Set(prev);
                    next.delete(context.tempId);
                    return next;
                });
                setOptimisticEvents(prev => prev.filter(e => e.id !== context.tempId));
            }
            showToast(editId ? 'Event updated successfully' : 'Event created successfully', 'success');
            queryClient.invalidateQueries({ queryKey: ['admin-events'] });
            queryClient.invalidateQueries({ queryKey: ['events-needs-review'] });
        },
        onError: (_, __, context) => {
            if (context?.tempId) {
                setPendingEventIds(prev => {
                    const next = new Set(prev);
                    next.delete(context.tempId);
                    return next;
                });
                setOptimisticEvents(prev => prev.filter(e => e.id !== context.tempId));
            }
            setError(getNetworkErrorMessage());
        }
    });

    const deleteEventMutation = useMutation({
        mutationFn: (eventId: number) => 
            deleteWithCredentials(`/api/events/${eventId}`),
        onMutate: async (eventId) => {
            setDeletingEventIds(prev => new Set(prev).add(eventId));
            setShowDeleteConfirm(false);
            setEventToDelete(null);
            return { eventId };
        },
        onSuccess: (_, __, context) => {
            if (context?.eventId) {
                setDeletingEventIds(prev => {
                    const next = new Set(prev);
                    next.delete(context.eventId);
                    return next;
                });
            }
            setSuccess('Event archived');
            showToast('Event archived successfully', 'success');
            setTimeout(() => setSuccess(null), 3000);
            queryClient.invalidateQueries({ queryKey: ['admin-events'] });
        },
        onError: (_, __, context) => {
            if (context?.eventId) {
                setDeletingEventIds(prev => {
                    const next = new Set(prev);
                    next.delete(context.eventId);
                    return next;
                });
            }
            setError(getNetworkErrorMessage());
            showToast('Failed to archive event', 'error');
            setTimeout(() => setError(null), 3000);
        }
    });

    const openEditForNeedsReview = (event: NeedsReviewEvent) => {
        setNewItem({
            id: event.id,
            title: event.title,
            description: event.description || '',
            event_date: event.event_date,
            start_time: event.start_time,
            end_time: event.end_time || '',
            location: event.location || '',
            category: event.category || 'Social',
            visibility: event.visibility || 'public',
            block_simulators: event.block_simulators || false,
            block_conference_room: event.block_conference_room || false,
        });
        setEditId(event.id);
        setIsEditing(true);
    };

    useEffect(() => {
        const handleOpenCreate = () => openCreate();
        window.addEventListener('openEventCreate', handleOpenCreate);
        return () => window.removeEventListener('openEventCreate', handleOpenCreate);
    }, []);

    useEffect(() => {
        const handleRefresh = () => {
            queryClient.invalidateQueries({ queryKey: ['admin-events'] });
        };
        window.addEventListener('refreshEventsData', handleRefresh);
        window.addEventListener('booking-update', handleRefresh);
        return () => {
            window.removeEventListener('refreshEventsData', handleRefresh);
            window.removeEventListener('booking-update', handleRefresh);
        };
    }, [queryClient]);

    useEffect(() => {
        if (isEditing) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    }, [isEditing]);

    const allEvents = [...events, ...optimisticEvents];
    const filteredEvents = activeCategory === 'all' 
        ? allEvents 
        : allEvents.filter(e => e.category === activeCategory);

    const today = getTodayPacific();
    const upcomingEvents = filteredEvents
        .filter(e => e.event_date >= today && !deletingEventIds.has(e.id))
        .sort((a, b) => a.event_date.localeCompare(b.event_date));
    const pastEvents = filteredEvents
        .filter(e => e.event_date < today && !deletingEventIds.has(e.id))
        .sort((a, b) => b.event_date.localeCompare(a.event_date));

    const openEdit = (event: DBEvent) => {
        setNewItem(event);
        setEditId(event.id);
        setTouchedFields(new Set());
        setIsEditing(true);
    };

    const openCreate = () => {
        setNewItem({ category: activeCategory === 'all' ? 'Social' : activeCategory });
        setEditId(null);
        setTouchedFields(new Set());
        setIsEditing(true);
    };

    const handleSave = () => {
        setError(null);
        
        if (!newItem.title?.trim()) {
            setError('Title is required');
            return;
        }
        if (!newItem.event_date) {
            setError('Date is required');
            return;
        }
        if (!newItem.start_time) {
            setError('Start time is required');
            return;
        }
        
        const payload = {
            title: newItem.title.trim(),
            description: newItem.description || '',
            event_date: newItem.event_date,
            start_time: newItem.start_time,
            end_time: newItem.end_time || newItem.start_time,
            location: newItem.location || 'The Lounge',
            category: newItem.category || 'Social',
            image_url: newItem.image_url || null,
            max_attendees: newItem.max_attendees || null,
            external_url: newItem.external_url || null,
            visibility: newItem.visibility || 'public',
            block_bookings: newItem.block_bookings || false,
            block_simulators: newItem.block_simulators || false,
            block_conference_room: newItem.block_conference_room || false,
        };

        saveEventMutation.mutate(payload);
    };

    const handleDelete = async (event: DBEvent) => {
        setEventToDelete(event);
        setEventCascadePreview(null);
        try {
            const data = await fetchWithCredentials<{ relatedData?: { rsvps: number } }>(`/api/events/${event.id}/cascade-preview`);
            setEventCascadePreview(data.relatedData || null);
        } catch (err) {
            console.error('Failed to fetch cascade preview:', err);
        }
        setShowDeleteConfirm(true);
    };

    const confirmDelete = () => {
        if (!eventToDelete) return;
        deleteEventMutation.mutate(eventToDelete.id);
    };

    const handleViewRsvps = (event: DBEvent) => {
        setSelectedEvent(event);
        setIsViewingRsvps(true);
    };

    const formatDate = (dateStr: string) => {
        if (!dateStr) return 'TBD';
        const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
        return formatDateDisplayWithDay(datePart);
    };

    const formatTime = (timeStr: string) => {
        if (!timeStr) return '';
        const [hours, mins] = timeStr.split(':').map(Number);
        const period = hours >= 12 ? 'PM' : 'AM';
        const h12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
        return `${h12}:${mins.toString().padStart(2, '0')} ${period}`;
    };

    const formatTime12Hour = (time: string | null | undefined) => {
        if (!time) return '';
        const [h, m] = time.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
    };

    const NeedsReviewSection = () => {
        const count = needsReviewEvents.length;
        
        if (!needsReviewLoading && count === 0) {
            return null;
        }
        
        return (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10 backdrop-blur-sm overflow-hidden mb-4">
                <button
                    onClick={() => setNeedsReviewExpanded(!needsReviewExpanded)}
                    className="w-full flex items-center justify-between p-4 hover:bg-amber-500/5 transition-colors"
                >
                    <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">
                            rate_review
                        </span>
                        <span className="text-sm font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                            Needs Review
                        </span>
                        {count > 0 && (
                            <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-amber-500 text-white text-xs font-bold">
                                {count}
                            </span>
                        )}
                    </div>
                    <span className={`material-symbols-outlined text-amber-600 dark:text-amber-400 transition-transform duration-200 ${needsReviewExpanded ? 'rotate-180' : ''}`}>
                        expand_more
                    </span>
                </button>
                
                {needsReviewExpanded && (
                    <div className="border-t border-amber-500/20 p-4 space-y-4">
                        {needsReviewLoading ? (
                            <div className="flex items-center justify-center py-8">
                                <div className="w-6 h-6 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin"></div>
                            </div>
                        ) : (
                            needsReviewEvents.map((event) => {
                                const missingFields: string[] = [];
                                if (!event.category || event.category === 'General') missingFields.push('Category');
                                if (!event.description) missingFields.push('Description');
                                if (!event.location) missingFields.push('Location');
                                
                                return (
                                    <div 
                                        key={event.id}
                                        className={`p-4 rounded-xl border ${event.conflict_detected ? 'border-orange-500/40 bg-orange-50/60 dark:bg-orange-900/20' : 'border-amber-500/20 bg-white/60 dark:bg-white/5'} space-y-3`}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                    {event.conflict_detected && (
                                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500 text-white text-[10px] font-bold uppercase tracking-wider">
                                                            <span className="material-symbols-outlined text-[12px]">sync_problem</span>
                                                            Conflict Detected
                                                        </span>
                                                    )}
                                                    <span className="text-sm font-bold text-primary dark:text-white">
                                                        {formatTime12Hour(event.start_time)}
                                                    </span>
                                                    {event.end_time && (
                                                        <span className="text-xs text-primary/70 dark:text-white/70">
                                                            - {formatTime12Hour(event.end_time)}
                                                        </span>
                                                    )}
                                                    <span className="text-xs text-primary/60 dark:text-white/60">
                                                        {formatDateDisplayWithDay(event.event_date)}
                                                    </span>
                                                </div>
                                                <h4 className="font-semibold text-primary dark:text-white">
                                                    {event.title}
                                                </h4>
                                                {event.location && (
                                                    <p className="text-xs text-primary/80 dark:text-white/80 truncate">
                                                        {event.location}
                                                    </p>
                                                )}
                                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                                    {event.source && (
                                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 dark:bg-white/10 text-primary/70 dark:text-white/70 text-xs">
                                                            <span className="material-symbols-outlined text-xs">sync</span>
                                                            {event.source}
                                                        </span>
                                                    )}
                                                    {event.category && (
                                                        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-primary/10 dark:bg-white/10 text-primary/70 dark:text-white/70 text-xs">
                                                            {event.category}
                                                        </span>
                                                    )}
                                                </div>
                                                {missingFields.length > 0 && (
                                                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                                                        Missing: {missingFields.join(', ')}
                                                    </p>
                                                )}
                                                {event.conflict_detected && (
                                                    <p className="text-xs text-orange-600 dark:text-orange-400 mt-2">
                                                        This event was modified in Google Calendar after being reviewed. Please verify the changes.
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                        
                                        <div className="flex items-center gap-2 pt-2">
                                            <button
                                                onClick={() => openEditForNeedsReview(event)}
                                                className="flex-1 px-3 py-2 rounded-full bg-accent text-primary text-xs font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-1"
                                            >
                                                <span className="material-symbols-outlined text-sm">edit</span>
                                                Edit Event
                                            </button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <AnimatedPage>
            <NeedsReviewSection />

            <div className="flex gap-2 overflow-x-auto pb-4 mb-4 scrollbar-hide -mx-4 px-4 scroll-fade-right">
                {CATEGORY_TABS.map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveCategory(tab.id)}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-[10px] sm:text-xs font-bold uppercase tracking-wide whitespace-nowrap transition-all flex-shrink-0 ${
                            activeCategory === tab.id 
                                ? 'bg-primary text-white shadow-md' 
                                : 'bg-white dark:bg-white/10 text-gray-600 dark:text-white/80 border border-gray-200 dark:border-white/25'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[14px] sm:text-[16px]">{tab.icon}</span>
                        {tab.label}
                    </button>
                ))}
            </div>

            {success && (
                <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg text-green-700 dark:text-green-400 text-sm">
                    {success}
                </div>
            )}

            {error && !isEditing && (
                <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm">
                    {error}
                </div>
            )}

            <SlideUpDrawer 
                isOpen={showDeleteConfirm} 
                onClose={() => { setShowDeleteConfirm(false); setEventToDelete(null); }} 
                title="Archive Event"
                maxHeight="small"
                stickyFooter={
                    <div className="flex gap-3 p-4">
                        <button
                            onClick={() => { setShowDeleteConfirm(false); setEventToDelete(null); }}
                            disabled={deleteEventMutation.isPending}
                            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={confirmDelete}
                            disabled={deleteEventMutation.isPending}
                            className="flex-1 py-3 rounded-xl bg-red-500 text-white font-medium hover:bg-red-600 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                            {deleteEventMutation.isPending ? (
                                <>
                                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                                    Archiving...
                                </>
                            ) : (
                                <>
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm">archive</span>
                                    Archive
                                </>
                            )}
                        </button>
                    </div>
                }
            >
                <div className="p-5">
                    <p className="text-gray-600 dark:text-gray-300">
                        Are you sure you want to archive <span className="font-semibold text-primary dark:text-white">"{eventToDelete?.title}"</span>?
                    </p>
                    {eventCascadePreview && eventCascadePreview.rsvps > 0 && (
                        <p className="text-amber-600 dark:text-amber-400 text-sm mt-2">
                            This will also archive {eventCascadePreview.rsvps} RSVP{eventCascadePreview.rsvps !== 1 ? 's' : ''}.
                        </p>
                    )}
                </div>
            </SlideUpDrawer>

            <SlideUpDrawer 
                isOpen={isEditing} 
                onClose={() => { setIsEditing(false); setError(null); }} 
                title={editId ? 'Edit Event' : 'Add Event'}
                maxHeight="large"
                stickyFooter={
                    <div className="flex gap-3 p-4">
                        <button
                            onClick={() => { setIsEditing(false); setError(null); setTouchedFields(new Set()); }}
                            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-medium"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={saveEventMutation.isPending || !isEventFormValid}
                            className="flex-1 py-3 rounded-xl bg-brand-green text-white font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {saveEventMutation.isPending && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                            {saveEventMutation.isPending ? 'Saving...' : editId ? 'Save Changes' : 'Add Event'}
                        </button>
                    </div>
                }
            >
                <div className="p-5 space-y-4">
                    {error && (
                        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm">
                            {error}
                        </div>
                    )}
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Title *</label>
                        <input className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="Event title" value={newItem.title || ''} onChange={e => setNewItem({...newItem, title: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Category *</label>
                        <select 
                            className={`w-full border bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white ${
                                touchedFields.has('category') && eventValidation.category 
                                    ? 'border-red-500 dark:border-red-500' 
                                    : 'border-gray-200 dark:border-white/25'
                            }`} 
                            value={newItem.category || ''} 
                            onChange={e => setNewItem({...newItem, category: e.target.value})}
                            onBlur={() => markTouched('category')}
                        >
                            <option value="">Select category...</option>
                            <option value="Social">Social</option>
                            <option value="Golf">Golf</option>
                            <option value="Tournaments">Tournaments</option>
                            <option value="Dining">Dining</option>
                            <option value="Networking">Networking</option>
                            <option value="Workshops">Workshops</option>
                            <option value="Family">Family</option>
                            <option value="Entertainment">Entertainment</option>
                            <option value="Charity">Charity</option>
                        </select>
                        {touchedFields.has('category') && eventValidation.category && (
                            <p className="text-xs text-red-500 mt-1">Category is required</p>
                        )}
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Date *</label>
                        <input type="date" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white" value={newItem.event_date || ''} onChange={e => setNewItem({...newItem, event_date: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Start Time</label>
                        <input type="time" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white" value={newItem.start_time || ''} onChange={e => setNewItem({...newItem, start_time: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">End Time</label>
                        <input type="time" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white" value={newItem.end_time || ''} onChange={e => setNewItem({...newItem, end_time: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Location *</label>
                        <input 
                            className={`w-full border bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 ${
                                touchedFields.has('location') && eventValidation.location 
                                    ? 'border-red-500 dark:border-red-500' 
                                    : 'border-gray-200 dark:border-white/25'
                            }`} 
                            placeholder="Event location" 
                            value={newItem.location || ''} 
                            onChange={e => setNewItem({...newItem, location: e.target.value})}
                            onBlur={() => markTouched('location')}
                        />
                        {touchedFields.has('location') && eventValidation.location && (
                            <p className="text-xs text-red-500 mt-1">Location is required</p>
                        )}
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Image URL (optional)</label>
                        <input className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="https://..." value={newItem.image_url || ''} onChange={e => setNewItem({...newItem, image_url: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Max Attendees (optional)</label>
                        <input type="number" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="e.g., 50" value={newItem.max_attendees || ''} onChange={e => setNewItem({...newItem, max_attendees: parseInt(e.target.value) || null})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">External Link (optional)</label>
                        <input className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="https://..." value={newItem.external_url || ''} onChange={e => setNewItem({...newItem, external_url: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Description *</label>
                        <textarea 
                            className={`w-full border bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 resize-none ${
                                touchedFields.has('description') && eventValidation.description 
                                    ? 'border-red-500 dark:border-red-500' 
                                    : 'border-gray-200 dark:border-white/25'
                            }`} 
                            placeholder="Event description" 
                            rows={3} 
                            value={newItem.description || ''} 
                            onChange={e => setNewItem({...newItem, description: e.target.value})}
                            onBlur={() => markTouched('description')}
                        />
                        {touchedFields.has('description') && eventValidation.description && (
                            <p className="text-xs text-red-500 mt-1">Description is required</p>
                        )}
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">Visibility</label>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setNewItem({...newItem, visibility: 'public'})}
                                className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                                    (newItem.visibility || 'public') === 'public'
                                        ? 'bg-primary text-white shadow-md'
                                        : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70 border border-gray-200 dark:border-white/25'
                                }`}
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">public</span>
                                Public
                            </button>
                            <button
                                type="button"
                                onClick={() => setNewItem({...newItem, visibility: 'members'})}
                                className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                                    newItem.visibility === 'members'
                                        ? 'bg-primary text-white shadow-md'
                                        : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70 border border-gray-200 dark:border-white/25'
                                }`}
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">lock</span>
                                Members Only
                            </button>
                        </div>
                        <p className="text-xs text-gray-600 dark:text-gray-500 mt-1">
                            {(newItem.visibility || 'public') === 'public' ? 'Visible on public website and member portal' : 'Only visible to logged-in members'}
                        </p>
                    </div>
                    <div className="space-y-3">
                        <div className="flex items-center justify-between p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700/50">
                            <div className="flex-1">
                                <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                                    <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-amber-600">sports_golf</span>
                                    Block Simulators
                                </label>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                    Prevents simulator bay bookings during this event's time slot
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setNewItem({...newItem, block_simulators: !newItem.block_simulators})}
                                className={`relative w-12 h-6 rounded-full transition-colors ${
                                    newItem.block_simulators 
                                        ? 'bg-amber-500' 
                                        : 'bg-gray-300 dark:bg-white/20'
                                }`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
                                    newItem.block_simulators ? 'translate-x-6' : 'translate-x-0'
                                }`} />
                            </button>
                        </div>
                        <div className="flex items-center justify-between p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700/50">
                            <div className="flex-1">
                                <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                                    <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-blue-600">meeting_room</span>
                                    Block Conference Room
                                </label>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                    Prevents conference room bookings during this event's time slot
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setNewItem({...newItem, block_conference_room: !newItem.block_conference_room})}
                                className={`relative w-12 h-6 rounded-full transition-colors ${
                                    newItem.block_conference_room 
                                        ? 'bg-blue-500' 
                                        : 'bg-gray-300 dark:bg-white/20'
                                }`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
                                    newItem.block_conference_room ? 'translate-x-6' : 'translate-x-0'
                                }`} />
                            </button>
                        </div>
                    </div>
                </div>
            </SlideUpDrawer>

            {isLoading ? (
                <EventsTabSkeleton />
            ) : filteredEvents.length === 0 ? (
                <EmptyState
                    icon="event"
                    title={`No ${activeCategory === 'all' ? 'events' : activeCategory.toLowerCase()} found`}
                    description="Events will appear here once they are created"
                    variant="compact"
                />
            ) : (
                <div key={activeCategory} className="space-y-6 animate-content-enter">
                    {upcomingEvents.length > 0 && (
                        <div className="animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                            <div className="flex items-center gap-2 mb-3">
                                <span aria-hidden="true" className="material-symbols-outlined text-green-500">schedule</span>
                                <h3 className="font-bold text-primary dark:text-white">Upcoming ({upcomingEvents.length})</h3>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {upcomingEvents.map((event, index) => {
                                    const isPending = pendingEventIds.has(event.id);
                                    const isOptimistic = event.id < 0;
                                    return (
                                    <div key={event.id} onClick={() => !isOptimistic && openEdit(event)} className={`bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border flex flex-col gap-3 relative overflow-hidden transition-all animate-slide-up-stagger ${
                                        isPending || isOptimistic 
                                            ? 'border-brand-green/50 animate-pulse cursor-wait' 
                                            : 'border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-transform active:scale-[0.98]'
                                    }`} style={{ '--stagger-index': index + 1 } as React.CSSProperties}>
                                        {(isPending || isOptimistic) && (
                                            <div className="absolute top-0 left-0 bg-brand-green text-white text-[8px] font-bold uppercase px-2 py-1 rounded-br-lg z-10 flex items-center gap-1">
                                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[10px]">progress_activity</span>
                                                Saving...
                                            </div>
                                        )}
                                        {event.eventbrite_id && !isPending && !isOptimistic && (
                                            <div className="absolute top-0 right-0 bg-[#F05537] text-white text-[8px] font-bold uppercase px-2 py-1 rounded-bl-lg z-10">
                                                Eventbrite
                                            </div>
                                        )}
                                        <div className="flex gap-4">
                                            <div className="w-20 h-20 rounded-lg bg-gray-100 dark:bg-white/5 flex-shrink-0 overflow-hidden flex items-center justify-center">
                                                {event.image_url ? (
                                                    <img src={event.image_url} alt="" className="w-full h-full object-cover" />
                                                ) : (
                                                    <span aria-hidden="true" className="material-symbols-outlined text-3xl text-gray-500 dark:text-white/20">
                                                        {event.category === 'Golf' ? 'golf_course' : event.category === 'Tournaments' ? 'emoji_events' : event.category === 'Dining' ? 'restaurant' : event.category === 'Networking' ? 'handshake' : event.category === 'Workshops' ? 'school' : event.category === 'Family' ? 'family_restroom' : event.category === 'Entertainment' ? 'music_note' : event.category === 'Charity' ? 'volunteer_activism' : 'celebration'}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <h4 className="font-bold text-lg text-primary dark:text-white leading-tight mb-1 truncate">{event.title}</h4>
                                                <span className="inline-block text-[10px] font-bold uppercase tracking-wider bg-primary/10 dark:bg-white/10 text-primary/80 dark:text-white/80 px-1.5 py-0.5 rounded mb-2">{event.category}</span>
                                                <p className="text-xs text-gray-500 dark:text-gray-400">{formatDate(event.event_date)} • {formatTime(event.start_time)}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between pt-2 border-t border-gray-50 dark:border-white/20 mt-auto">
                                            <span className="text-xs text-gray-600 dark:text-gray-500 flex items-center gap-1"><span aria-hidden="true" className="material-symbols-outlined text-[14px]">location_on</span> {event.location}</span>
                                            {!isPending && !isOptimistic && (
                                            <div className="flex items-center gap-2">
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handleViewRsvps(event); }} 
                                                    className="bg-primary/10 dark:bg-white/10 text-primary dark:text-white text-xs font-bold uppercase tracking-wider hover:bg-primary/20 dark:hover:bg-white/20 px-2 py-1 rounded flex items-center gap-1 transition-colors"
                                                >
                                                    <span aria-hidden="true" className="material-symbols-outlined text-[14px]">group</span> RSVPs
                                                </button>
                                                {event.eventbrite_url && (
                                                    <a 
                                                        href={event.eventbrite_url} 
                                                        target="_blank" 
                                                        rel="noopener noreferrer"
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="text-[#F05537] text-xs font-bold uppercase tracking-wider hover:bg-orange-50 px-2 py-1 rounded flex items-center gap-1"
                                                    >
                                                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">open_in_new</span> View
                                                    </a>
                                                )}
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handleDelete(event); }} 
                                                    disabled={deletingEventIds.has(event.id)}
                                                    className="text-primary/70 dark:text-white/70 text-xs font-bold uppercase tracking-wider hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                                                >
                                                    {deletingEventIds.has(event.id) && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                                                    Delete
                                                </button>
                                            </div>
                                            )}
                                        </div>
                                    </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    
                    {pastEvents.length > 0 && (
                        <div className="animate-slide-up-stagger" style={{ '--stagger-index': upcomingEvents.length + 2 } as React.CSSProperties}>
                            <button 
                                onClick={() => setShowPastEvents(!showPastEvents)}
                                className="flex items-center gap-2 mb-3 w-full text-left group"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-gray-600 dark:text-gray-500">history</span>
                                <h3 className="font-bold text-gray-500 dark:text-gray-400">Past ({pastEvents.length})</h3>
                                <span aria-hidden="true" className={`material-symbols-outlined text-gray-400 dark:text-gray-500 text-[18px] transition-transform ${showPastEvents ? 'rotate-180' : ''}`}>expand_more</span>
                            </button>
                            {showPastEvents && (
                            <>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-70">
                                {pastEvents.slice(0, showAllPastEvents ? pastEvents.length : 20).map((event, index) => {
                                    const isPending = pendingEventIds.has(event.id);
                                    return (
                                    <div key={event.id} onClick={() => openEdit(event)} className={`bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border flex flex-col gap-3 relative overflow-hidden transition-all animate-slide-up-stagger ${
                                        isPending ? 'border-brand-green/50 animate-pulse cursor-wait' : 'border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-transform active:scale-[0.98]'
                                    }`} style={{ '--stagger-index': upcomingEvents.length + index + 3 } as React.CSSProperties}>
                                        {isPending && (
                                            <div className="absolute top-0 left-0 bg-brand-green text-white text-[8px] font-bold uppercase px-2 py-1 rounded-br-lg z-10 flex items-center gap-1">
                                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[10px]">progress_activity</span>
                                                Updating...
                                            </div>
                                        )}
                                        {event.eventbrite_id && !isPending && (
                                            <div className="absolute top-0 right-0 bg-[#F05537] text-white text-[8px] font-bold uppercase px-2 py-1 rounded-bl-lg z-10">
                                                Eventbrite
                                            </div>
                                        )}
                                        <div className="flex gap-4">
                                            <div className="w-20 h-20 rounded-lg bg-gray-100 dark:bg-white/5 flex-shrink-0 overflow-hidden flex items-center justify-center">
                                                {event.image_url ? (
                                                    <img src={event.image_url} alt="" className="w-full h-full object-cover" />
                                                ) : (
                                                    <span aria-hidden="true" className="material-symbols-outlined text-3xl text-gray-500 dark:text-white/20">
                                                        {event.category === 'Golf' ? 'golf_course' : event.category === 'Tournaments' ? 'emoji_events' : event.category === 'Dining' ? 'restaurant' : event.category === 'Networking' ? 'handshake' : event.category === 'Workshops' ? 'school' : event.category === 'Family' ? 'family_restroom' : event.category === 'Entertainment' ? 'music_note' : event.category === 'Charity' ? 'volunteer_activism' : 'celebration'}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <h4 className="font-bold text-lg text-primary dark:text-white leading-tight mb-1 truncate">{event.title}</h4>
                                                <span className="inline-block text-[10px] font-bold uppercase tracking-wider bg-primary/10 dark:bg-white/10 text-primary/80 dark:text-white/80 px-1.5 py-0.5 rounded mb-2">{event.category}</span>
                                                <p className="text-xs text-gray-500 dark:text-gray-400">{formatDate(event.event_date)} • {formatTime(event.start_time)}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between pt-2 border-t border-gray-50 dark:border-white/20 mt-auto">
                                            <span className="text-xs text-gray-600 dark:text-gray-500 flex items-center gap-1"><span aria-hidden="true" className="material-symbols-outlined text-[14px]">location_on</span> {event.location}</span>
                                            {!isPending && (
                                            <div className="flex items-center gap-2">
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handleViewRsvps(event); }} 
                                                    className="bg-primary/10 dark:bg-white/10 text-primary dark:text-white text-xs font-bold uppercase tracking-wider hover:bg-primary/20 dark:hover:bg-white/20 px-2 py-1 rounded flex items-center gap-1 transition-colors"
                                                >
                                                    <span aria-hidden="true" className="material-symbols-outlined text-[14px]">group</span> RSVPs
                                                </button>
                                                {event.eventbrite_url && (
                                                    <a 
                                                        href={event.eventbrite_url} 
                                                        target="_blank" 
                                                        rel="noopener noreferrer"
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="text-[#F05537] text-xs font-bold uppercase tracking-wider hover:bg-orange-50 px-2 py-1 rounded flex items-center gap-1"
                                                    >
                                                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">open_in_new</span> View
                                                    </a>
                                                )}
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handleDelete(event); }} 
                                                    disabled={deletingEventIds.has(event.id)}
                                                    className="text-primary/70 dark:text-white/70 text-xs font-bold uppercase tracking-wider hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                                                >
                                                    {deletingEventIds.has(event.id) && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                                                    Delete
                                                </button>
                                            </div>
                                            )}
                                        </div>
                                    </div>
                                    );
                                })}
                            </div>
                            {!showAllPastEvents && pastEvents.length > 20 && (
                                <button onClick={() => setShowAllPastEvents(true)} className="w-full mt-3 py-2.5 rounded-lg bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm font-medium text-primary dark:text-white hover:bg-gray-50 dark:hover:bg-white/15 transition-colors">
                                    Show all {pastEvents.length} past events
                                </button>
                            )}
                            </>
                            )}
                        </div>
                    )}
                </div>
            )}

            <ParticipantDetailsModal
                isOpen={isViewingRsvps}
                onClose={() => { setIsViewingRsvps(false); setSelectedEvent(null); }}
                title={selectedEvent?.title || 'Event RSVPs'}
                subtitle={selectedEvent ? `${formatDate(selectedEvent.event_date)} at ${formatTime(selectedEvent.start_time)}` : undefined}
                participants={rsvps}
                isLoading={isLoadingRsvps}
                type="rsvp"
                eventId={selectedEvent?.id}
                onRefresh={() => refetchRsvps()}
                eventbriteId={selectedEvent?.eventbrite_id}
            />
        </AnimatedPage>
    );
};

const INITIAL_DISPLAY_COUNT = 20;

const WellnessAdminContent: React.FC = () => {
    const queryClient = useQueryClient();
    const [activeCategory, setActiveCategory] = useState('all');
    const [isEditing, setIsEditing] = useState(false);
    const [editId, setEditId] = useState<number | null>(null);
    const [formData, setFormData] = useState<WellnessFormData>({
        category: 'Classes',
        status: 'available',
        duration: '60 min'
    });
    const [isUploading, setIsUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [isViewingEnrollments, setIsViewingEnrollments] = useState(false);
    const [selectedClass, setSelectedClass] = useState<WellnessClass | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [classToDelete, setClassToDelete] = useState<WellnessClass | null>(null);
    const [deletingClassId, setDeletingClassId] = useState<number | null>(null);
    const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
    const [showAllUpcoming, setShowAllUpcoming] = useState(false);
    const [showAllPast, setShowAllPast] = useState(false);
    const [showPastClasses, setShowPastClasses] = useState(false);
    const { showToast } = useToast();

    const categories = ['Classes', 'MedSpa', 'Recovery', 'Therapy', 'Nutrition', 'Personal Training', 'Mindfulness', 'Outdoors', 'General'];

    useEffect(() => {
        setShowAllUpcoming(false);
        setShowAllPast(false);
    }, [activeCategory]);

    const markTouched = (field: string) => {
        setTouchedFields(prev => new Set(prev).add(field));
    };

    const wellnessValidation = {
        instructor: !formData.instructor?.trim() || formData.instructor === 'TBD',
        category: !formData.category || formData.category === 'Wellness',
        capacity: !formData.capacity || formData.capacity <= 0
    };

    const isWellnessFormValid = !wellnessValidation.instructor && !wellnessValidation.category && !wellnessValidation.capacity;

    const { data: classes = [], isLoading, isError, error: queryError, refetch } = useQuery({
        queryKey: ['wellness-classes'],
        queryFn: () => fetchWithCredentials<WellnessClass[]>('/api/wellness-classes'),
        throwOnError: false
    });

    const { data: needsReviewClasses = [] } = useQuery({
        queryKey: ['wellness-needs-review'],
        queryFn: () => fetchWithCredentials<WellnessClass[]>('/api/wellness-classes/needs-review'),
        throwOnError: false
    });

    const { data: enrollments = [], isLoading: isLoadingEnrollments, refetch: refetchEnrollments } = useQuery({
        queryKey: ['class-enrollments', selectedClass?.id],
        queryFn: () => fetchWithCredentials<Participant[]>(`/api/wellness-classes/${selectedClass!.id}/enrollments`),
        enabled: !!selectedClass && isViewingEnrollments
    });

    const saveClassMutation = useMutation({
        mutationFn: async ({ url, method, payload }: { url: string; method: string; payload: Record<string, unknown> }) => {
            return fetchWithCredentials<WellnessClass & { recurringUpdated?: number }>(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        },
        onSuccess: (savedItem) => {
            queryClient.invalidateQueries({ queryKey: ['wellness-classes'] });
            queryClient.invalidateQueries({ queryKey: ['wellness-needs-review'] });
            setIsEditing(false);
            setFormData({ category: 'Classes', status: 'available', duration: '60 min' });
            
            const recurringCount = savedItem.recurringUpdated || 0;
            const successMsg = editId 
                ? (recurringCount > 0 
                    ? `Class updated + ${recurringCount} future instances updated` 
                    : 'Class updated successfully')
                : 'Class created successfully';
            setSuccess(successMsg);
            showToast(successMsg, 'success');
            setTimeout(() => setSuccess(null), 3000);
        },
        onError: (error: Error) => {
            setError(error.message || getNetworkErrorMessage());
        }
    });

    const deleteClassMutation = useMutation({
        mutationFn: (classId: number) => 
            deleteWithCredentials(`/api/wellness-classes/${classId}`),
        onSuccess: () => {
            setSuccess('Class deleted');
            setTimeout(() => setSuccess(null), 3000);
            queryClient.invalidateQueries({ queryKey: ['wellness-classes'] });
        },
        onError: () => {
            setError(getNetworkErrorMessage());
            setTimeout(() => setError(null), 3000);
        }
    });

    useEffect(() => {
        const handleOpenCreate = () => openCreate();
        window.addEventListener('openWellnessCreate', handleOpenCreate);
        return () => window.removeEventListener('openWellnessCreate', handleOpenCreate);
    }, []);

    useEffect(() => {
        const handleRefresh = () => {
            queryClient.invalidateQueries({ queryKey: ['wellness-classes'] });
        };
        window.addEventListener('refreshWellnessData', handleRefresh);
        window.addEventListener('booking-update', handleRefresh);
        return () => {
            window.removeEventListener('refreshWellnessData', handleRefresh);
            window.removeEventListener('booking-update', handleRefresh);
        };
    }, [queryClient]);

    useEffect(() => {
        if (isEditing) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    }, [isEditing]);

    const convertTo24Hour = (timeStr: string): string => {
        if (!timeStr) return '';
        const match12h = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (match12h) {
            let hours = parseInt(match12h[1]);
            const minutes = match12h[2];
            const period = match12h[3].toUpperCase();
            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;
            return `${hours.toString().padStart(2, '0')}:${minutes}`;
        }
        const match24h = timeStr.match(/^(\d{1,2}):(\d{2})/);
        if (match24h) {
            return `${match24h[1].padStart(2, '0')}:${match24h[2]}`;
        }
        return timeStr;
    };

    const calculateEndTime = (startTime: string, durationStr: string): string => {
        if (!startTime) return '';
        const time24 = convertTo24Hour(startTime);
        const match = durationStr?.match(/(\d+)/);
        const durationMinutes = match ? parseInt(match[1]) : 60;
        const [hours, mins] = time24.split(':').map(Number);
        const totalMins = hours * 60 + mins + durationMinutes;
        const endHours = Math.floor(totalMins / 60) % 24;
        const endMins = totalMins % 60;
        return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}`;
    };

    const openEdit = (cls: WellnessClass) => {
        const startTime24 = convertTo24Hour(cls.time);
        const endTime = calculateEndTime(cls.time, cls.duration);
        const dateStr = cls.date || '';
        const parsedCapacity = cls.capacity || (cls.spots ? parseInt(cls.spots.replace(/[^0-9]/g, '')) || null : null);
        setFormData({
            ...cls,
            capacity: parsedCapacity,
            time: startTime24,
            date: dateStr.includes('T') ? dateStr.split('T')[0] : dateStr,
            endTime
        });
        setEditId(cls.id);
        setTouchedFields(new Set());
        setIsEditing(true);
        setError(null);
    };

    const openCreate = () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        setFormData({
            category: activeCategory === 'all' ? 'Classes' : activeCategory,
            status: 'available',
            time: '09:00',
            endTime: '10:00',
            date: tomorrow.toISOString().split('T')[0]
        });
        setEditId(null);
        setTouchedFields(new Set());
        setIsEditing(true);
        setError(null);
    };

    let filteredClasses: WellnessClass[] = [];
    let upcomingClasses: WellnessClass[] = [];
    let pastClasses: WellnessClass[] = [];
    try {
        filteredClasses = activeCategory === 'all' 
            ? classes 
            : classes.filter(c => c.category === activeCategory);

        const todayWellness = getTodayPacific();
        upcomingClasses = filteredClasses.filter(c => {
            try {
                if (!c.date) return false;
                const classDate = c.date.includes('T') ? c.date.split('T')[0] : c.date;
                return classDate >= todayWellness;
            } catch { return false; }
        }).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        pastClasses = filteredClasses.filter(c => {
            try {
                if (!c.date) return false;
                const classDate = c.date.includes('T') ? c.date.split('T')[0] : c.date;
                return classDate < todayWellness;
            } catch { return false; }
        }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    } catch (err) {
        console.error('[WellnessAdminContent] Error processing classes:', err);
    }

    const calculateDuration = (startTime: string, endTime: string): string => {
        if (!startTime || !endTime) return '60 min';
        const [startHours, startMins] = startTime.split(':').map(Number);
        const [endHours, endMins] = endTime.split(':').map(Number);
        let durationMins = (endHours * 60 + endMins) - (startHours * 60 + startMins);
        if (durationMins <= 0) durationMins += 24 * 60;
        return `${durationMins} min`;
    };

    const handleSave = async () => {
        if (!formData.title || !formData.time || !formData.endTime || !formData.instructor || !formData.date || !formData.capacity) {
            setError('Please fill in all required fields');
            return;
        }

        try {
            setError(null);
            setIsUploading(true);
            
            let imageUrl = formData.image_url;
            
            if (formData.imageFile) {
                const uploadFormData = new FormData();
                uploadFormData.append('image', formData.imageFile);
                const uploadRes = await fetch('/api/admin/upload-image', {
                    method: 'POST',
                    credentials: 'include',
                    body: uploadFormData,
                });
                if (uploadRes.ok) {
                    const uploadData = await uploadRes.json();
                    imageUrl = uploadData.url;
                } else {
                    setError(getApiErrorMessage(uploadRes, 'upload image'));
                    setIsUploading(false);
                    return;
                }
            }
            
            const url = editId ? `/api/wellness-classes/${editId}` : '/api/wellness-classes';
            const method = editId ? 'PUT' : 'POST';

            const { imageFile, endTime, ...restFormData } = formData;
            const duration = calculateDuration(formData.time!, endTime!);
            const spotsDisplay = formData.capacity ? `${formData.capacity} spots` : 'Unlimited';
            const payload = {
                ...restFormData,
                duration,
                spots: spotsDisplay,
                image_url: imageUrl || null,
                external_url: formData.external_url || null,
                visibility: formData.visibility || 'public',
                block_bookings: formData.block_bookings || false,
                block_simulators: formData.block_simulators || false,
                block_conference_room: formData.block_conference_room || false,
                capacity: formData.capacity || null,
                waitlist_enabled: formData.waitlist_enabled || false,
            };

            saveClassMutation.mutate({ url, method, payload });
        } catch (err) {
            setError(getNetworkErrorMessage());
        } finally {
            setIsUploading(false);
        }
    };

    const handleDelete = (cls: WellnessClass) => {
        setClassToDelete(cls);
        setShowDeleteConfirm(true);
    };

    const confirmDelete = () => {
        if (!classToDelete) return;
        setShowDeleteConfirm(false);
        deleteClassMutation.mutate(classToDelete.id);
        setClassToDelete(null);
    };

    const formatDate = (dateStr: string) => {
        if (!dateStr) return 'No Date';
        const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
        return formatDateDisplayWithDay(datePart);
    };

    const handleViewEnrollments = (cls: WellnessClass) => {
        setSelectedClass(cls);
        setIsViewingEnrollments(true);
    };

    const getCategoryIcon = (category: string) => {
        switch (category) {
            case 'Classes': return 'fitness_center';
            case 'MedSpa': return 'spa';
            case 'Recovery': return 'ac_unit';
            case 'Therapy': return 'healing';
            case 'Nutrition': return 'nutrition';
            case 'Personal Training': return 'sports';
            case 'Mindfulness': return 'self_improvement';
            case 'Outdoors': return 'hiking';
            default: return 'category';
        }
    };

    return (
        <div key={activeCategory}>
            <p className="text-sm text-primary/80 dark:text-white/80 mb-4 animate-content-enter">
                Synced from Google Calendar: <span className="font-medium">Wellness & Classes</span>
            </p>
            <div className="flex gap-2 overflow-x-auto pb-4 mb-4 scrollbar-hide -mx-4 px-4 animate-content-enter-delay-1 scroll-fade-right">
                {WELLNESS_CATEGORY_TABS.map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveCategory(tab.id)}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-[10px] sm:text-xs font-bold uppercase tracking-wide whitespace-nowrap transition-all flex-shrink-0 ${
                            activeCategory === tab.id 
                                ? 'bg-primary text-white shadow-md' 
                                : 'bg-white dark:bg-white/10 text-gray-600 dark:text-white/80 border border-gray-200 dark:border-white/25'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[14px] sm:text-[16px]">{tab.icon}</span>
                        {tab.label}
                    </button>
                ))}
            </div>

            {success && (
                <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg text-green-700 dark:text-green-400 text-sm">
                    {success}
                </div>
            )}

            {error && !isEditing && (
                <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm">
                    {error}
                </div>
            )}

            {isError && (
                <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-xl text-center">
                    <span className="material-symbols-outlined text-red-400 text-2xl mb-2 block">error_outline</span>
                    <p className="text-sm text-red-600 dark:text-red-400 mb-2">Unable to load wellness classes</p>
                    <button onClick={() => refetch()} className="text-xs font-medium text-primary dark:text-white underline">Try Again</button>
                </div>
            )}

            {needsReviewClasses.length > 0 && (
                <div className="mb-6 animate-content-enter-delay-2">
                    <div className="bg-amber-50/80 dark:bg-amber-900/20 backdrop-blur-sm border border-amber-200 dark:border-amber-700/50 rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-3">
                            <span aria-hidden="true" className="material-symbols-outlined text-amber-500">rate_review</span>
                            <h3 className="font-bold text-amber-700 dark:text-amber-400">Needs Review</h3>
                            <span className="ml-auto bg-amber-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">{needsReviewClasses.length}</span>
                        </div>
                        <p className="text-xs text-amber-600 dark:text-amber-400/80 mb-3">
                            These classes were imported from calendar with incomplete or ambiguous data.
                        </p>
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                            {needsReviewClasses.map(cls => (
                                <div key={cls.id} className={`${cls.conflict_detected ? 'bg-orange-50 dark:bg-orange-900/30 border border-orange-300/50 dark:border-orange-700/50' : 'bg-white/80 dark:bg-black/30'} rounded-lg p-3 flex items-center justify-between gap-3`}>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 mb-1">
                                            {cls.conflict_detected && (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500 text-white text-[10px] font-bold uppercase tracking-wider">
                                                    <span aria-hidden="true" className="material-symbols-outlined text-[12px]">sync_problem</span>
                                                    Conflict
                                                </span>
                                            )}
                                            <h4 className="font-medium text-primary dark:text-white truncate">{cls.title}</h4>
                                        </div>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
                                            <span>{formatDateDisplayWithDay((cls.date || '').split('T')[0])}</span>
                                            <span>•</span>
                                            <span>{cls.time}</span>
                                            {cls.instructor && cls.instructor !== 'TBD' && (
                                                <>
                                                    <span>•</span>
                                                    <span className="flex items-center gap-1">
                                                        <span aria-hidden="true" className="material-symbols-outlined text-[12px]">person</span>
                                                        {cls.instructor}
                                                    </span>
                                                </>
                                            )}
                                        </p>
                                        {cls.conflict_detected && (
                                            <p className="text-[10px] text-orange-600 dark:text-orange-400 mt-1">
                                                Changed in Google Calendar after review
                                            </p>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => openEdit(cls)}
                                        className="bg-primary hover:bg-primary/90 text-white text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded transition-colors flex items-center gap-1 flex-shrink-0"
                                    >
                                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">edit</span>
                                        Edit
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {isLoading ? (
                <EventsTabSkeleton />
            ) : filteredClasses.length === 0 ? (
                <EmptyState
                    icon="spa"
                    title={`No ${activeCategory === 'all' ? 'wellness classes' : activeCategory.toLowerCase()} found`}
                    description="Wellness classes will appear here once they are scheduled"
                    variant="compact"
                />
            ) : (
                <div className="space-y-6">
                    {upcomingClasses.length > 0 && (
                        <div className="animate-content-enter-delay-2">
                            <div className="flex items-center gap-2 mb-3">
                                <span aria-hidden="true" className="material-symbols-outlined text-green-500">schedule</span>
                                <h3 className="font-bold text-primary dark:text-white">Upcoming ({upcomingClasses.length})</h3>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {upcomingClasses.slice(0, showAllUpcoming ? upcomingClasses.length : INITIAL_DISPLAY_COUNT).map((cls, index) => (
                                    <div key={cls.id} onClick={() => openEdit(cls)} className={`bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 flex flex-col gap-3 relative overflow-hidden cursor-pointer hover:border-primary/30 transition-all animate-list-item-delay-${Math.min(index + 1, 10)}`}>
                                        <div className="flex gap-4">
                                            <div className="w-20 h-20 rounded-lg bg-[#CCB8E4]/20 dark:bg-[#CCB8E4]/10 flex-shrink-0 overflow-hidden flex items-center justify-center">
                                                {cls.image_url ? (
                                                    <img src={cls.image_url} alt="" className="w-full h-full object-cover" />
                                                ) : (
                                                    <span aria-hidden="true" className="material-symbols-outlined text-3xl text-[#CCB8E4]">
                                                        {getCategoryIcon(cls.category)}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <h4 className="font-bold text-lg text-primary dark:text-white leading-tight mb-1 truncate">{cls.title}</h4>
                                                <span className="inline-block text-[10px] font-bold uppercase tracking-wider bg-[#CCB8E4]/20 text-[#293515] dark:text-[#CCB8E4] px-1.5 py-0.5 rounded mb-2">{cls.category}</span>
                                                <p className="text-xs text-gray-500 dark:text-gray-400">{formatDate(cls.date)} • {cls.time}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between pt-2 border-t border-gray-50 dark:border-white/20 mt-auto">
                                            <span className="text-xs text-gray-600 dark:text-gray-500 flex items-center gap-1"><span aria-hidden="true" className="material-symbols-outlined text-[14px]">person</span> {cls.instructor}</span>
                                            <div className="flex items-center gap-2">
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handleViewEnrollments(cls); }} 
                                                    className="bg-primary/10 dark:bg-[rgba(204,184,228,0.2)] text-primary dark:text-[#CCB8E4] text-xs font-bold uppercase tracking-wider hover:bg-primary/20 dark:hover:bg-[rgba(204,184,228,0.3)] px-2 py-1 rounded flex items-center gap-1 transition-colors"
                                                >
                                                    <span aria-hidden="true" className="material-symbols-outlined text-[14px]">group</span> 
                                                    {cls.capacity ? `${cls.enrolled_count || 0}/${cls.capacity}` : 'Enrolled'}
                                                    {cls.waitlist_count && cls.waitlist_count > 0 ? ` (+${cls.waitlist_count})` : ''}
                                                </button>
                                                <button onClick={(e) => { e.stopPropagation(); handleDelete(cls); }} className="text-primary/70 dark:text-white/70 text-xs font-bold uppercase tracking-wider hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded transition-colors">Delete</button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {!showAllUpcoming && upcomingClasses.length > INITIAL_DISPLAY_COUNT && (
                                <button onClick={() => setShowAllUpcoming(true)} className="w-full mt-3 py-2.5 rounded-lg bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm font-medium text-primary dark:text-white hover:bg-gray-50 dark:hover:bg-white/15 transition-colors">
                                    Show all {upcomingClasses.length} classes
                                </button>
                            )}
                        </div>
                    )}
                    
                    {pastClasses.length > 0 && (
                        <div className="animate-content-enter-delay-3">
                            <button 
                                onClick={() => setShowPastClasses(!showPastClasses)}
                                className="flex items-center gap-2 mb-3 w-full text-left group"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-gray-600 dark:text-gray-500">history</span>
                                <h3 className="font-bold text-gray-500 dark:text-gray-400">Past ({pastClasses.length})</h3>
                                <span aria-hidden="true" className={`material-symbols-outlined text-gray-400 dark:text-gray-500 text-[18px] transition-transform ${showPastClasses ? 'rotate-180' : ''}`}>expand_more</span>
                            </button>
                            {showPastClasses && (
                            <>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-70">
                                {pastClasses.slice(0, showAllPast ? pastClasses.length : INITIAL_DISPLAY_COUNT).map((cls, index) => (
                                    <div key={cls.id} onClick={() => openEdit(cls)} className={`bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 flex flex-col gap-3 relative overflow-hidden cursor-pointer hover:border-primary/30 transition-all animate-list-item-delay-${Math.min(index + 1, 10)}`}>
                                        <div className="flex gap-4">
                                            <div className="w-20 h-20 rounded-lg bg-[#CCB8E4]/20 dark:bg-[#CCB8E4]/10 flex-shrink-0 overflow-hidden flex items-center justify-center">
                                                {cls.image_url ? (
                                                    <img src={cls.image_url} alt="" className="w-full h-full object-cover" />
                                                ) : (
                                                    <span aria-hidden="true" className="material-symbols-outlined text-3xl text-[#CCB8E4]">
                                                        {getCategoryIcon(cls.category)}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <h4 className="font-bold text-lg text-primary dark:text-white leading-tight mb-1 truncate">{cls.title}</h4>
                                                <span className="inline-block text-[10px] font-bold uppercase tracking-wider bg-[#CCB8E4]/20 text-[#293515] dark:text-[#CCB8E4] px-1.5 py-0.5 rounded mb-2">{cls.category}</span>
                                                <p className="text-xs text-gray-500 dark:text-gray-400">{formatDate(cls.date)} • {cls.time}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between pt-2 border-t border-gray-50 dark:border-white/20 mt-auto">
                                            <span className="text-xs text-gray-600 dark:text-gray-500 flex items-center gap-1"><span aria-hidden="true" className="material-symbols-outlined text-[14px]">person</span> {cls.instructor}</span>
                                            <div className="flex items-center gap-2">
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handleViewEnrollments(cls); }} 
                                                    className="bg-primary/10 dark:bg-[rgba(204,184,228,0.2)] text-primary dark:text-[#CCB8E4] text-xs font-bold uppercase tracking-wider hover:bg-primary/20 dark:hover:bg-[rgba(204,184,228,0.3)] px-2 py-1 rounded flex items-center gap-1 transition-colors"
                                                >
                                                    <span aria-hidden="true" className="material-symbols-outlined text-[14px]">group</span> Enrolled
                                                </button>
                                                <button onClick={(e) => { e.stopPropagation(); handleDelete(cls); }} className="text-primary/70 dark:text-white/70 text-xs font-bold uppercase tracking-wider hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded transition-colors">Delete</button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {!showAllPast && pastClasses.length > INITIAL_DISPLAY_COUNT && (
                                <button onClick={() => setShowAllPast(true)} className="w-full mt-3 py-2.5 rounded-lg bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 text-sm font-medium text-primary dark:text-white hover:bg-gray-50 dark:hover:bg-white/15 transition-colors">
                                    Show all {pastClasses.length} past classes
                                </button>
                            )}
                            </>
                            )}
                        </div>
                    )}
                </div>
            )}

            <ParticipantDetailsModal
                isOpen={isViewingEnrollments}
                onClose={() => { setIsViewingEnrollments(false); setSelectedClass(null); }}
                title={selectedClass?.title || 'Class Enrollments'}
                subtitle={selectedClass ? `${formatDate(selectedClass.date)} at ${selectedClass.time}` : undefined}
                participants={enrollments}
                isLoading={isLoadingEnrollments}
                type="enrollment"
                classId={selectedClass?.id}
                onRefresh={() => refetchEnrollments()}
            />

            <SlideUpDrawer 
                isOpen={isEditing} 
                onClose={() => { setIsEditing(false); setError(null); }} 
                title={editId ? 'Edit Class' : 'Add Class'}
                maxHeight="large"
                stickyFooter={
                    <div className="flex gap-3 p-4">
                        <button
                            onClick={() => { setIsEditing(false); setError(null); setTouchedFields(new Set()); }}
                            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-medium"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={isUploading || saveClassMutation.isPending || !isWellnessFormValid}
                            className="flex-1 py-3 rounded-xl bg-brand-green text-white font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {(isUploading || saveClassMutation.isPending) && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                            {isUploading || saveClassMutation.isPending ? 'Saving...' : editId ? 'Save Changes' : 'Add Class'}
                        </button>
                    </div>
                }
            >
                <div className="p-5 space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title *</label>
                        <input
                            type="text"
                            value={formData.title || ''}
                            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                            placeholder="Morning Yoga Flow"
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        />
                    </div>
                    
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date *</label>
                        <input
                            type="date"
                            value={formData.date || ''}
                            onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Time *</label>
                        <input
                            type="time"
                            value={formData.time || ''}
                            onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">End Time *</label>
                        <input
                            type="time"
                            value={formData.endTime || ''}
                            onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Instructor *</label>
                        <input
                            type="text"
                            value={formData.instructor || ''}
                            onChange={(e) => setFormData({ ...formData, instructor: e.target.value })}
                            onBlur={() => markTouched('instructor')}
                            placeholder="Jane Smith"
                            className={`w-full p-3 rounded-lg border bg-gray-50 dark:bg-black/30 text-primary dark:text-white ${
                                touchedFields.has('instructor') && wellnessValidation.instructor 
                                    ? 'border-red-500 dark:border-red-500' 
                                    : 'border-gray-200 dark:border-white/25'
                            }`}
                        />
                        {touchedFields.has('instructor') && wellnessValidation.instructor && (
                            <p className="text-xs text-red-500 mt-1">Please enter a valid instructor name</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category *</label>
                        <select
                            value={formData.category || ''}
                            onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                            onBlur={() => markTouched('category')}
                            className={`w-full p-3 rounded-lg border bg-gray-50 dark:bg-black/30 text-primary dark:text-white ${
                                touchedFields.has('category') && wellnessValidation.category 
                                    ? 'border-red-500 dark:border-red-500' 
                                    : 'border-gray-200 dark:border-white/25'
                            }`}
                        >
                            <option value="">Select category...</option>
                            {categories.map(cat => (
                                <option key={cat} value={cat}>{cat}</option>
                            ))}
                        </select>
                        {touchedFields.has('category') && wellnessValidation.category && (
                            <p className="text-xs text-red-500 mt-1">Please select a valid category</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Capacity *</label>
                        <input
                            type="number"
                            value={formData.capacity || ''}
                            onChange={(e) => setFormData({ ...formData, capacity: parseInt(e.target.value) || null })}
                            onBlur={() => markTouched('capacity')}
                            placeholder="e.g., 20"
                            className={`w-full p-3 rounded-lg border bg-gray-50 dark:bg-black/30 text-primary dark:text-white ${
                                touchedFields.has('capacity') && wellnessValidation.capacity 
                                    ? 'border-red-500 dark:border-red-500' 
                                    : 'border-gray-200 dark:border-white/25'
                            }`}
                        />
                        {touchedFields.has('capacity') && wellnessValidation.capacity && (
                            <p className="text-xs text-red-500 mt-1">Capacity must be greater than 0</p>
                        )}
                    </div>

                    <div className="flex items-center justify-between p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-700/50">
                        <div className="flex-1">
                            <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                                <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-purple-600">format_list_numbered</span>
                                Enable Waitlist
                            </label>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Allow members to join a waitlist when class is full
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setFormData({...formData, waitlist_enabled: !formData.waitlist_enabled})}
                            className={`relative w-12 h-6 rounded-full transition-colors ${
                                formData.waitlist_enabled 
                                    ? 'bg-purple-500' 
                                    : 'bg-gray-300 dark:bg-white/20'
                            }`}
                        >
                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
                                formData.waitlist_enabled ? 'translate-x-6' : 'translate-x-0'
                            }`} />
                        </button>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                        <textarea
                            value={formData.description || ''}
                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                            placeholder="A gentle flow to start your day..."
                            rows={3}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white resize-none"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">External Link (optional)</label>
                        <input
                            type="url"
                            value={formData.external_url || ''}
                            onChange={(e) => setFormData({ ...formData, external_url: e.target.value })}
                            placeholder="https://..."
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Visibility</label>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setFormData({...formData, visibility: 'public'})}
                                className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                                    (formData.visibility || 'public') === 'public'
                                        ? 'bg-primary text-white shadow-md'
                                        : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70 border border-gray-200 dark:border-white/25'
                                }`}
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">public</span>
                                Public
                            </button>
                            <button
                                type="button"
                                onClick={() => setFormData({...formData, visibility: 'members'})}
                                className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                                    formData.visibility === 'members'
                                        ? 'bg-primary text-white shadow-md'
                                        : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70 border border-gray-200 dark:border-white/25'
                                }`}
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">lock</span>
                                Members Only
                            </button>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <div className="flex items-center justify-between p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700/50">
                            <div className="flex-1">
                                <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                                    <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-amber-600">sports_golf</span>
                                    Block Simulators
                                </label>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                    Prevents simulator bay bookings during this class
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setFormData({...formData, block_simulators: !formData.block_simulators})}
                                className={`relative w-12 h-6 rounded-full transition-colors ${
                                    formData.block_simulators 
                                        ? 'bg-amber-500' 
                                        : 'bg-gray-300 dark:bg-white/20'
                                }`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
                                    formData.block_simulators ? 'translate-x-6' : 'translate-x-0'
                                }`} />
                            </button>
                        </div>
                        <div className="flex items-center justify-between p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700/50">
                            <div className="flex-1">
                                <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                                    <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-blue-600">meeting_room</span>
                                    Block Conference Room
                                </label>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                    Prevents conference room bookings during this class
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setFormData({...formData, block_conference_room: !formData.block_conference_room})}
                                className={`relative w-12 h-6 rounded-full transition-colors ${
                                    formData.block_conference_room 
                                        ? 'bg-blue-500' 
                                        : 'bg-gray-300 dark:bg-white/20'
                                }`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
                                    formData.block_conference_room ? 'translate-x-6' : 'translate-x-0'
                                }`} />
                            </button>
                        </div>
                    </div>
                </div>
            </SlideUpDrawer>

            <SlideUpDrawer 
                isOpen={showDeleteConfirm} 
                onClose={() => { setShowDeleteConfirm(false); setClassToDelete(null); }} 
                title="Delete Class"
                maxHeight="small"
                stickyFooter={
                    <div className="flex gap-3 p-4">
                        <button
                            onClick={() => { setShowDeleteConfirm(false); setClassToDelete(null); }}
                            disabled={deleteClassMutation.isPending}
                            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={confirmDelete}
                            disabled={deleteClassMutation.isPending}
                            className="flex-1 py-3 rounded-xl bg-red-500 text-white font-medium hover:bg-red-600 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                            {deleteClassMutation.isPending ? (
                                <>
                                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                                    Deleting...
                                </>
                            ) : (
                                <>
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm">delete</span>
                                    Delete
                                </>
                            )}
                        </button>
                    </div>
                }
            >
                <div className="p-5">
                    <p className="text-gray-600 dark:text-gray-300">
                        Are you sure you want to delete <span className="font-semibold text-primary dark:text-white">"{classToDelete?.title}"</span>? This action cannot be undone.
                    </p>
                </div>
            </SlideUpDrawer>
        </div>
    );
};

const EventsTab: React.FC = () => {
    const { showToast } = useToast();
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const subtabParam = searchParams.get('subtab');
    const activeSubTab: 'events' | 'wellness' = subtabParam === 'wellness' ? 'wellness' : 'events';
    const [syncMessage, setSyncMessage] = useState<string | null>(null);
    
    const setActiveSubTab = (tab: 'events' | 'wellness') => {
        setSearchParams(prev => {
            const newParams = new URLSearchParams(prev);
            if (tab === 'events') {
                newParams.delete('subtab');
            } else {
                newParams.set('subtab', tab);
            }
            return newParams;
        }, { replace: true });
    };

    const syncMutation = useMutation({
        mutationFn: async () => {
            const maxRetries = 3;
            const retryFetch = async (url: string, attempt = 1): Promise<Response> => {
                try {
                    return await fetch(url, { method: 'POST', credentials: 'include' });
                } catch (err: any) {
                    if (attempt < maxRetries && (err.message?.includes('fetch') || err.message?.includes('network'))) {
                        await new Promise(r => setTimeout(r, 500 * attempt));
                        return retryFetch(url, attempt + 1);
                    }
                    throw err;
                }
            };
            
            const [calRes, ebRes] = await Promise.all([
                retryFetch('/api/calendars/sync-all'),
                retryFetch('/api/eventbrite/sync')
            ]);
            
            const calData = await calRes.json();
            const ebData = await ebRes.json();
            
            return { calRes, ebRes, calData, ebData };
        },
        onSuccess: ({ calRes, ebRes, calData, ebData }) => {
            queryClient.invalidateQueries({ queryKey: ['admin-events'] });
            queryClient.invalidateQueries({ queryKey: ['events-needs-review'] });
            queryClient.invalidateQueries({ queryKey: ['wellness-classes'] });
            queryClient.invalidateQueries({ queryKey: ['wellness-needs-review'] });
            
            window.dispatchEvent(new CustomEvent('refreshEventsData'));
            window.dispatchEvent(new CustomEvent('refreshWellnessData'));
            
            const errors: string[] = [];
            if (!calRes.ok) errors.push('Google Calendar');
            if (!ebRes.ok && !ebData.skipped) errors.push('Eventbrite');
            
            if (errors.length === 0) {
                const parts: string[] = [];
                if (calData.events?.synced) parts.push(`${calData.events.synced} events`);
                if (calData.wellness?.synced) parts.push(`${calData.wellness.synced} wellness`);
                setSyncMessage(parts.length > 0 ? `Synced ${parts.join(', ')}` : 'Sync complete');
            } else {
                setSyncMessage(`Sync failed for: ${errors.join(', ')}`);
            }
            setTimeout(() => setSyncMessage(null), 5000);
        },
        onError: () => {
            setSyncMessage('Network error - please try again');
            setTimeout(() => setSyncMessage(null), 5000);
        }
    });
    
    const handlePullRefresh = async () => {
        setSyncMessage(null);
        syncMutation.mutate();
    };

    return (
        <PullToRefresh onRefresh={handlePullRefresh}>
            <div className="animate-pop-in">
                {syncMessage && (
                    <div className={`mb-4 px-4 py-2 rounded-lg text-sm font-medium ${
                        syncMessage.startsWith('Error') || syncMessage.startsWith('Failed') || syncMessage.startsWith('Some syncs') || syncMessage.includes('failed')
                            ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800' 
                            : 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border border-green-200 dark:border-green-800'
                    }`}>
                        {syncMessage}
                    </div>
                )}

                <div className="flex gap-2 mb-4 animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                    <button
                        type="button"
                        onClick={() => setActiveSubTab('events')}
                        style={{ touchAction: 'manipulation' }}
                        className={`flex-1 py-2.5 px-3 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-1.5 ${
                            activeSubTab === 'events'
                                ? 'bg-primary text-white shadow-md'
                                : 'bg-white dark:bg-white/10 text-gray-600 dark:text-white/80 border border-gray-200 dark:border-white/25'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[18px]">event</span>
                        Events
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveSubTab('wellness')}
                        style={{ touchAction: 'manipulation' }}
                        className={`flex-1 py-2.5 px-3 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-1.5 ${
                            activeSubTab === 'wellness'
                                ? 'bg-[#CCB8E4] text-[#293515] shadow-md'
                                : 'bg-white dark:bg-white/10 text-gray-600 dark:text-white/80 border border-gray-200 dark:border-white/25'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[18px]">spa</span>
                        Wellness
                    </button>
                </div>

                <div key={activeSubTab} className="animate-content-enter">
                    {activeSubTab === 'events' && <PageErrorBoundary pageName="EventsTab"><EventsAdminContent /></PageErrorBoundary>}
                    {activeSubTab === 'wellness' && <PageErrorBoundary pageName="WellnessTab"><WellnessAdminContent /></PageErrorBoundary>}
                </div>
                <FloatingActionButton 
                    onClick={() => {
                        if (activeSubTab === 'events') {
                            window.dispatchEvent(new CustomEvent('openEventCreate'));
                        } else {
                            window.dispatchEvent(new CustomEvent('openWellnessCreate'));
                        }
                    }} 
                    color={activeSubTab === 'events' ? 'green' : 'purple'} 
                    label={activeSubTab === 'events' ? 'Add event' : 'Add wellness session'} 
                />
            </div>
        </PullToRefresh>
    );
};

export default EventsTab;
