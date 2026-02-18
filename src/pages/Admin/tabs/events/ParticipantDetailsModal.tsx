import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useData, MemberProfile } from '../../../../contexts/DataContext';
import { formatDateTimePacific } from '../../../../utils/dateUtils';
import { useToast } from '../../../../components/Toast';
import { SlideUpDrawer } from '../../../../components/SlideUpDrawer';
import TierBadge from '../../../../components/TierBadge';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials } from '../../../../hooks/queries/useFetch';
import { Participant, ParticipantDetailsModalProps } from './eventsTypes';

export const ParticipantDetailsModal: React.FC<ParticipantDetailsModalProps> = ({
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
                                                className={`p-4 rounded-xl border transition-all duration-fast ${
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
