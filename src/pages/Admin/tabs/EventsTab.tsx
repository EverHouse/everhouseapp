import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePageReady } from '../../../contexts/PageReadyContext';
import { useData, MemberProfile } from '../../../contexts/DataContext';
import { formatDateDisplayWithDay, formatDateTimePacific, getTodayPacific } from '../../../utils/dateUtils';
import PullToRefresh from '../../../components/PullToRefresh';
import { useToast } from '../../../components/Toast';
import FloatingActionButton from '../../../components/FloatingActionButton';
import ModalShell from '../../../components/ModalShell';
import TierBadge from '../../../components/TierBadge';

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
  capacity?: number | null;
  waitlist_enabled?: boolean;
  enrolled_count?: number;
  waitlist_count?: number;
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

interface AvailabilityBlock {
  id: number;
  resource_id: number;
  resource_name: string;
  block_date: string;
  start_time: string;
  end_time: string;
  block_type: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  closure_title: string | null;
}

interface BlockFormData {
  resource_id: number | null;
  block_date: string;
  start_time: string;
  end_time: string;
  block_type: string;
  notes: string;
}

interface CalendarStatus {
  name: string;
  status: 'connected' | 'not_found';
}

interface CalendarStatusResponse {
  timestamp: string;
  configured_calendars: CalendarStatus[];
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
    const [isAdding, setIsAdding] = useState(false);
    const [newEmail, setNewEmail] = useState('');
    const [addError, setAddError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<{ synced: number; matched: number } | null>(null);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [filteredMembers, setFilteredMembers] = useState<MemberProfile[]>([]);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

    const handleDeleteRsvp = async (rsvpId: number) => {
        if (!eventId) return;
        setDeletingId(rsvpId);
        try {
            const res = await fetch(`/api/events/${eventId}/rsvps/${rsvpId}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (res.ok) {
                showToast('RSVP removed successfully', 'success');
                setConfirmDeleteId(null);
                onRefresh?.();
            } else {
                const data = await res.json();
                showToast(data.error || 'Failed to remove RSVP', 'error');
            }
        } catch (err) {
            console.error('Failed to delete RSVP:', err);
            showToast('Failed to remove RSVP', 'error');
        } finally {
            setDeletingId(null);
        }
    };

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

    const handleSyncEventbrite = async () => {
        if (!eventId) return;
        setIsSyncing(true);
        setSyncResult(null);
        try {
            const res = await fetch(`/api/events/${eventId}/sync-eventbrite-attendees`, {
                method: 'POST',
                credentials: 'include',
            });
            if (res.ok) {
                const data = await res.json();
                setSyncResult({ synced: data.synced, matched: data.matched });
                showToast(`Synced ${data.synced} attendees, ${data.matched} matched to members`, 'success');
                onRefresh?.();
            } else {
                showToast('Failed to sync Eventbrite attendees', 'error');
            }
        } catch (err) {
            console.error('Failed to sync Eventbrite attendees:', err);
            showToast('Failed to sync Eventbrite attendees', 'error');
        } finally {
            setIsSyncing(false);
        }
    };

    const formatDate = (dateStr: string) => {
        return formatDateTimePacific(dateStr);
    };

    const handleAdd = async () => {
        if (!newEmail.trim()) {
            setAddError('Email is required');
            return;
        }
        if (!newEmail.includes('@')) {
            setAddError('Please enter a valid email');
            return;
        }

        setIsSubmitting(true);
        setAddError(null);

        try {
            const url = type === 'rsvp' 
                ? `/api/events/${eventId}/rsvps/manual`
                : `/api/wellness-classes/${classId}/enrollments/manual`;
            
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ email: newEmail.trim() })
            });

            if (res.ok) {
                setNewEmail('');
                setIsAdding(false);
                onRefresh?.();
            } else {
                const data = await res.json();
                setAddError(data.error || `Failed to add ${type === 'rsvp' ? 'RSVP' : 'enrollment'}`);
            }
        } catch (err) {
            setAddError(`Failed to add ${type === 'rsvp' ? 'RSVP' : 'enrollment'}`);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <ModalShell isOpen={isOpen} onClose={onClose} showCloseButton={false}>
            <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="font-bold text-lg text-primary dark:text-white">{title}</h3>
                        {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
                    </div>
                    <button 
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-gray-500 dark:text-gray-400">close</span>
                    </button>
                </div>

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
                                        disabled={isSubmitting}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleAdd}
                                        disabled={isSubmitting}
                                        className="flex-1 py-2 px-3 rounded-lg bg-primary text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-1"
                                    >
                                        {isSubmitting && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
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
                                        disabled={isSyncing}
                                        className="py-2.5 px-4 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-600 dark:text-orange-400 text-sm font-medium flex items-center justify-center gap-2 hover:bg-orange-500/20 transition-colors disabled:opacity-50"
                                    >
                                        {isSyncing ? (
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

                        {participants.length === 0 ? (
                            <div className="text-center py-12 text-gray-600 dark:text-gray-500">
                                <span aria-hidden="true" className="material-symbols-outlined text-4xl mb-2 block">
                                    {type === 'rsvp' ? 'event_busy' : 'person_off'}
                                </span>
                                <p>No {type === 'rsvp' ? 'RSVPs' : 'enrollments'} yet</p>
                            </div>
                        ) : (() => {
                            const grouped = participants.reduce((acc, p) => {
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
                            const totalHeadcount = participants.reduce((sum, p) => sum + 1 + (p.guestCount || 0), 0);

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
                                        
                                        return (
                                            <div 
                                                key={primary.id}
                                                className="p-4 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/20"
                                            >
                                                <div className="flex items-start justify-between mb-2">
                                                    <div className="flex items-center gap-3">
                                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${
                                                            isMember 
                                                                ? 'bg-accent/20 text-brand-green' 
                                                                : isEventbrite 
                                                                    ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400' 
                                                                    : 'bg-gray-100 dark:bg-white/10 text-gray-500'
                                                        }`}>
                                                            {(primary.firstName?.[0] || primary.attendeeName?.[0] || primary.userEmail[0]).toUpperCase()}
                                                        </div>
                                                        <div>
                                                            <p className="font-semibold text-primary dark:text-white">
                                                                {primary.displayName}
                                                                {guestCount > 0 && (
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
                                                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded shrink-0 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                                                            RSVP
                                                        </span>
                                                        {type === 'rsvp' && (
                                                            confirmDeleteId === primary.id ? (
                                                                <div className="flex items-center gap-1">
                                                                    <button
                                                                        onClick={() => handleDeleteRsvp(primary.id)}
                                                                        disabled={deletingId === primary.id}
                                                                        className="p-1.5 rounded-lg bg-red-500 text-white text-xs font-medium min-w-[44px] min-h-[32px] flex items-center justify-center disabled:opacity-50"
                                                                        aria-label="Confirm remove"
                                                                    >
                                                                        {deletingId === primary.id ? (
                                                                            <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                                                                        ) : (
                                                                            'Yes'
                                                                        )}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => setConfirmDeleteId(null)}
                                                                        className="p-1.5 rounded-lg border border-gray-300 dark:border-white/25 text-gray-600 dark:text-gray-400 text-xs font-medium min-w-[44px] min-h-[32px]"
                                                                        aria-label="Cancel remove"
                                                                    >
                                                                        No
                                                                    </button>
                                                                </div>
                                                            ) : (
                                                                <button
                                                                    onClick={() => setConfirmDeleteId(primary.id)}
                                                                    className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors min-w-[32px] min-h-[32px] flex items-center justify-center"
                                                                    aria-label="Remove RSVP"
                                                                >
                                                                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
                                                                </button>
                                                            )
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
        </ModalShell>
    );
};

const EventsAdminContent: React.FC = () => {
    const { setPageReady } = usePageReady();
    const [events, setEvents] = useState<DBEvent[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [activeCategory, setActiveCategory] = useState('all');
    const [isEditing, setIsEditing] = useState(false);
    const [editId, setEditId] = useState<number | null>(null);
    const [newItem, setNewItem] = useState<Partial<DBEvent>>({ category: 'Social' });
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isViewingRsvps, setIsViewingRsvps] = useState(false);
    const [selectedEvent, setSelectedEvent] = useState<DBEvent | null>(null);
    const [rsvps, setRsvps] = useState<Participant[]>([]);
    const [isLoadingRsvps, setIsLoadingRsvps] = useState(false);
    const [deletingEventId, setDeletingEventId] = useState<number | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [eventToDelete, setEventToDelete] = useState<DBEvent | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    useEffect(() => {
        if (!isLoading) {
            setPageReady(true);
        }
    }, [isLoading, setPageReady]);

    const fetchEvents = async () => {
        try {
            const res = await fetch('/api/events?include_past=true');
            const data = await res.json();
            setEvents(data);
        } catch (err) {
            console.error('Failed to fetch events:', err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchEvents();
    }, []);

    useEffect(() => {
        const handleOpenCreate = () => openCreate();
        window.addEventListener('openEventCreate', handleOpenCreate);
        return () => window.removeEventListener('openEventCreate', handleOpenCreate);
    }, []);

    useEffect(() => {
        const handleRefresh = () => fetchEvents();
        window.addEventListener('refreshEventsData', handleRefresh);
        // Also refresh on booking-update for real-time RSVP updates
        window.addEventListener('booking-update', handleRefresh);
        return () => {
            window.removeEventListener('refreshEventsData', handleRefresh);
            window.removeEventListener('booking-update', handleRefresh);
        };
    }, []);

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

    const filteredEvents = activeCategory === 'all' 
        ? events 
        : events.filter(e => e.category === activeCategory);

    const today = getTodayPacific();
    const upcomingEvents = filteredEvents.filter(e => e.event_date >= today).sort((a, b) => a.event_date.localeCompare(b.event_date));
    const pastEvents = filteredEvents.filter(e => e.event_date < today).sort((a, b) => b.event_date.localeCompare(a.event_date));

    const openEdit = (event: DBEvent) => {
        setNewItem(event);
        setEditId(event.id);
        setIsEditing(true);
    };

    const openCreate = () => {
        setNewItem({ category: activeCategory === 'all' ? 'Social' : activeCategory });
        setEditId(null);
        setIsEditing(true);
    };

    const handleSave = async () => {
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
        };

        setIsSaving(true);
        try {
            const res = editId 
                ? await fetch(`/api/events/${editId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                : await fetch('/api/events', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
            
            if (!res.ok) {
                throw new Error('Failed to save');
            }
            
            await fetchEvents();
            setIsEditing(false);
        } catch (err) {
            console.error('Failed to save event:', err);
            setError('Failed to save event. Please try again.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = (event: DBEvent) => {
        setEventToDelete(event);
        setShowDeleteConfirm(true);
    };

    const confirmDelete = async () => {
        if (!eventToDelete) return;
        
        const snapshot = [...events];
        const deletedId = eventToDelete.id;
        
        setEvents(prev => prev.filter(e => e.id !== deletedId));
        setShowDeleteConfirm(false);
        setEventToDelete(null);
        
        try {
            const res = await fetch(`/api/events/${deletedId}`, { method: 'DELETE', credentials: 'include' });
            if (res.ok) {
                setSuccess('Event deleted');
                setTimeout(() => setSuccess(null), 3000);
            } else {
                setEvents(snapshot);
                setError('Failed to delete event');
                setTimeout(() => setError(null), 3000);
            }
        } catch (err) {
            console.error('Failed to delete event:', err);
            setEvents(snapshot);
            setError('Failed to delete event');
            setTimeout(() => setError(null), 3000);
        }
    };

    const handleViewRsvps = async (event: DBEvent) => {
        setSelectedEvent(event);
        setIsViewingRsvps(true);
        setIsLoadingRsvps(true);
        try {
            const res = await fetch(`/api/events/${event.id}/rsvps`, { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setRsvps(data);
            }
        } catch (err) {
            console.error('Failed to fetch RSVPs:', err);
        } finally {
            setIsLoadingRsvps(false);
        }
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

    return (
        <div className="animate-pop-in">
            <p className="text-sm text-primary/80 dark:text-white/80 mb-4">
                Synced from Google Calendar: <span className="font-medium">Events</span>
            </p>
            <div className="flex gap-2 overflow-x-auto pb-4 mb-4 scrollbar-hide -mx-4 px-4 animate-pop-in scroll-fade-right" style={{animationDelay: '0.05s'}}>
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
                <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg text-green-700 dark:text-green-400 text-sm flex items-center gap-2">
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">check_circle</span>
                    {success}
                </div>
            )}

            <ModalShell isOpen={showDeleteConfirm} onClose={() => { setShowDeleteConfirm(false); setEventToDelete(null); }} title="Delete Event" showCloseButton={false}>
                <div className="p-6">
                    <p className="text-gray-600 dark:text-gray-300 mb-6">
                        Are you sure you want to delete <span className="font-bold text-primary dark:text-white">"{eventToDelete?.title}"</span>? This action cannot be undone.
                    </p>
                    <div className="flex gap-3 justify-end">
                        <button 
                            onClick={() => { setShowDeleteConfirm(false); setEventToDelete(null); }} 
                            className="px-4 py-2 text-gray-500 dark:text-gray-400 font-bold hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg transition-colors"
                            disabled={deletingEventId !== null}
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={confirmDelete} 
                            disabled={deletingEventId !== null}
                            className="px-6 py-2 bg-red-500 text-white rounded-lg font-bold shadow-md hover:bg-red-600 transition-colors disabled:opacity-50 flex items-center gap-2"
                        >
                            {deletingEventId !== null && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                            {deletingEventId !== null ? 'Deleting...' : 'Delete'}
                        </button>
                    </div>
                </div>
            </ModalShell>

            <ModalShell isOpen={isEditing} onClose={() => { setIsEditing(false); setError(null); }} title={editId ? 'Edit Event' : 'Create Event'} showCloseButton={false}>
                <div className="p-6 space-y-4 overflow-hidden">
                    {error && (
                        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 px-4 py-2 rounded-lg text-sm">
                            {error}
                        </div>
                    )}
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Title *</label>
                        <input className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="Event title" value={newItem.title || ''} onChange={e => setNewItem({...newItem, title: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Category</label>
                        <select className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white" value={newItem.category} onChange={e => setNewItem({...newItem, category: e.target.value})}>
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
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Location</label>
                        <input className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="Event location" value={newItem.location || ''} onChange={e => setNewItem({...newItem, location: e.target.value})} />
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
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Description</label>
                        <textarea className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 resize-none" placeholder="Event description" rows={3} value={newItem.description || ''} onChange={e => setNewItem({...newItem, description: e.target.value})} />
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
                    <div className="flex items-center justify-between p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700/50">
                        <div className="flex-1">
                            <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                                <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-amber-600">block</span>
                                Block Bookings During Event
                            </label>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Prevents bay and conference room bookings during this event's time slot
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setNewItem({...newItem, block_bookings: !newItem.block_bookings})}
                            className={`relative w-12 h-6 rounded-full transition-colors ${
                                newItem.block_bookings 
                                    ? 'bg-amber-500' 
                                    : 'bg-gray-300 dark:bg-white/20'
                            }`}
                        >
                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
                                newItem.block_bookings ? 'translate-x-6' : 'translate-x-0'
                            }`} />
                        </button>
                    </div>
                    <div className="flex gap-3 justify-end pt-2">
                        <button onClick={() => { setIsEditing(false); setError(null); }} className="px-4 py-2 text-gray-500 dark:text-gray-400 font-bold" disabled={isSaving}>Cancel</button>
                        <button onClick={handleSave} disabled={isSaving} className="px-6 py-2 bg-primary text-white rounded-lg font-bold shadow-md disabled:opacity-50 flex items-center gap-2">
                            {isSaving && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                            {isSaving ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </div>
            </ModalShell>

            {isLoading ? (
                <div className="flex items-center justify-center py-12">
                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-2xl text-gray-600 dark:text-gray-500">progress_activity</span>
                </div>
            ) : filteredEvents.length === 0 ? (
                <div className="text-center py-12 text-gray-600 dark:text-gray-500">
                    <span aria-hidden="true" className="material-symbols-outlined text-4xl mb-2 block">event_busy</span>
                    <p>No {activeCategory === 'all' ? 'events' : activeCategory.toLowerCase()} found</p>
                </div>
            ) : (
                <div className="space-y-6">
                    {upcomingEvents.length > 0 && (
                        <div className="animate-pop-in" style={{animationDelay: '0.1s'}}>
                            <div className="flex items-center gap-2 mb-3">
                                <span aria-hidden="true" className="material-symbols-outlined text-green-500">schedule</span>
                                <h3 className="font-bold text-primary dark:text-white">Upcoming ({upcomingEvents.length})</h3>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {upcomingEvents.map((event, index) => (
                                    <div key={event.id} onClick={() => openEdit(event)} className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 flex flex-col gap-3 relative overflow-hidden cursor-pointer hover:border-primary/30 transition-all animate-pop-in" style={{animationDelay: `${0.15 + index * 0.03}s`}}>
                                        {event.eventbrite_id && (
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
                                                    disabled={deletingEventId === event.id}
                                                    className="text-primary/70 dark:text-white/70 text-xs font-bold uppercase tracking-wider hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                                                >
                                                    {deletingEventId === event.id && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    
                    {pastEvents.length > 0 && (
                        <div className="animate-pop-in" style={{animationDelay: '0.2s'}}>
                            <div className="flex items-center gap-2 mb-3">
                                <span aria-hidden="true" className="material-symbols-outlined text-gray-600 dark:text-gray-500">history</span>
                                <h3 className="font-bold text-gray-500 dark:text-gray-400">Past ({pastEvents.length})</h3>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-70">
                                {pastEvents.map((event, index) => (
                                    <div key={event.id} onClick={() => openEdit(event)} className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 flex flex-col gap-3 relative overflow-hidden cursor-pointer hover:border-primary/30 transition-all animate-pop-in" style={{animationDelay: `${0.25 + index * 0.03}s`}}>
                                        {event.eventbrite_id && (
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
                                                    disabled={deletingEventId === event.id}
                                                    className="text-primary/70 dark:text-white/70 text-xs font-bold uppercase tracking-wider hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                                                >
                                                    {deletingEventId === event.id && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            <ParticipantDetailsModal
                isOpen={isViewingRsvps}
                onClose={() => { setIsViewingRsvps(false); setSelectedEvent(null); setRsvps([]); }}
                title={selectedEvent?.title || 'Event RSVPs'}
                subtitle={selectedEvent ? `${formatDate(selectedEvent.event_date)} at ${formatTime(selectedEvent.start_time)}` : undefined}
                participants={rsvps}
                isLoading={isLoadingRsvps}
                type="rsvp"
                eventId={selectedEvent?.id}
                onRefresh={() => selectedEvent && handleViewRsvps(selectedEvent)}
                eventbriteId={selectedEvent?.eventbrite_id}
            />
        </div>
    );
};

const WellnessAdminContent: React.FC = () => {
    const [classes, setClasses] = useState<WellnessClass[]>([]);
    const [isLoading, setIsLoading] = useState(true);
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
    const [enrollments, setEnrollments] = useState<Participant[]>([]);
    const [isLoadingEnrollments, setIsLoadingEnrollments] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [classToDelete, setClassToDelete] = useState<WellnessClass | null>(null);
    const [deletingClassId, setDeletingClassId] = useState<number | null>(null);

    const categories = ['Classes', 'MedSpa', 'Recovery', 'Therapy', 'Nutrition', 'Personal Training', 'Mindfulness', 'Outdoors', 'General'];

    useEffect(() => {
        fetchClasses();
    }, []);

    useEffect(() => {
        const handleOpenCreate = () => openCreate();
        window.addEventListener('openWellnessCreate', handleOpenCreate);
        return () => window.removeEventListener('openWellnessCreate', handleOpenCreate);
    }, []);

    useEffect(() => {
        const handleRefresh = () => fetchClasses();
        window.addEventListener('refreshWellnessData', handleRefresh);
        // Also refresh on booking-update for real-time enrollment updates
        window.addEventListener('booking-update', handleRefresh);
        return () => {
            window.removeEventListener('refreshWellnessData', handleRefresh);
            window.removeEventListener('booking-update', handleRefresh);
        };
    }, []);

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

    const fetchClasses = async () => {
        try {
            setIsLoading(true);
            const res = await fetch('/api/wellness-classes');
            if (res.ok) {
                const data = await res.json();
                setClasses(data);
            }
        } catch (err) {
            console.error('Error fetching wellness classes:', err);
        } finally {
            setIsLoading(false);
        }
    };

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
        setFormData({
            ...cls,
            time: startTime24,
            date: cls.date.split('T')[0],
            endTime
        });
        setEditId(cls.id);
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
        setIsEditing(true);
        setError(null);
    };

    const filteredClasses = activeCategory === 'all' 
        ? classes 
        : classes.filter(c => c.category === activeCategory);

    const todayWellness = getTodayPacific();
    const upcomingClasses = filteredClasses.filter(c => {
        const classDate = c.date.includes('T') ? c.date.split('T')[0] : c.date;
        return classDate >= todayWellness;
    }).sort((a, b) => a.date.localeCompare(b.date));
    const pastClasses = filteredClasses.filter(c => {
        const classDate = c.date.includes('T') ? c.date.split('T')[0] : c.date;
        return classDate < todayWellness;
    }).sort((a, b) => b.date.localeCompare(a.date));

    const calculateDuration = (startTime: string, endTime: string): string => {
        if (!startTime || !endTime) return '60 min';
        const [startHours, startMins] = startTime.split(':').map(Number);
        const [endHours, endMins] = endTime.split(':').map(Number);
        let durationMins = (endHours * 60 + endMins) - (startHours * 60 + startMins);
        if (durationMins <= 0) durationMins += 24 * 60;
        return `${durationMins} min`;
    };

    const handleSave = async () => {
        if (!formData.title || !formData.time || !formData.endTime || !formData.instructor || !formData.date || !formData.spots) {
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
                    setError('Failed to upload image');
                    setIsUploading(false);
                    return;
                }
            }
            
            const url = editId ? `/api/wellness-classes/${editId}` : '/api/wellness-classes';
            const method = editId ? 'PUT' : 'POST';

            const { imageFile, endTime, ...restFormData } = formData;
            const duration = calculateDuration(formData.time!, endTime!);
            const payload = {
                ...restFormData,
                duration,
                image_url: imageUrl || null,
                external_url: formData.external_url || null,
                visibility: formData.visibility || 'public',
                block_bookings: formData.block_bookings || false,
                capacity: formData.capacity || null,
                waitlist_enabled: formData.waitlist_enabled || false,
            };

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                await fetchClasses();
                setIsEditing(false);
                setFormData({ category: 'Classes', status: 'available', duration: '60 min' });
                setSuccess(editId ? 'Class updated successfully' : 'Class created successfully');
                setTimeout(() => setSuccess(null), 3000);
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to save class');
            }
        } catch (err) {
            setError('Failed to save class');
        } finally {
            setIsUploading(false);
        }
    };

    const handleDelete = (cls: WellnessClass) => {
        setClassToDelete(cls);
        setShowDeleteConfirm(true);
    };

    const confirmDelete = async () => {
        if (!classToDelete) return;
        
        const snapshot = [...classes];
        const deletedId = classToDelete.id;
        
        setClasses(prev => prev.filter(c => c.id !== deletedId));
        setShowDeleteConfirm(false);
        setClassToDelete(null);
        
        try {
            const res = await fetch(`/api/wellness-classes/${deletedId}`, { method: 'DELETE', credentials: 'include' });
            if (res.ok) {
                setSuccess('Class deleted');
                setTimeout(() => setSuccess(null), 3000);
            } else {
                setClasses(snapshot);
                setError('Failed to delete class');
                setTimeout(() => setError(null), 3000);
            }
        } catch (err) {
            console.error('Error deleting class:', err);
            setClasses(snapshot);
            setError('Failed to delete class');
            setTimeout(() => setError(null), 3000);
        }
    };

    const formatDate = (dateStr: string) => {
        if (!dateStr) return 'No Date';
        const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
        return formatDateDisplayWithDay(datePart);
    };

    const handleViewEnrollments = async (cls: WellnessClass) => {
        setSelectedClass(cls);
        setIsViewingEnrollments(true);
        setIsLoadingEnrollments(true);
        try {
            const res = await fetch(`/api/wellness-classes/${cls.id}/enrollments`, { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setEnrollments(data);
            }
        } catch (err) {
            console.error('Failed to fetch enrollments:', err);
        } finally {
            setIsLoadingEnrollments(false);
        }
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
        <div className="animate-pop-in">
            <p className="text-sm text-primary/80 dark:text-white/80 mb-4">
                Synced from Google Calendar: <span className="font-medium">Wellness & Classes</span>
            </p>
            <div className="flex gap-2 overflow-x-auto pb-4 mb-4 scrollbar-hide -mx-4 px-4 animate-pop-in scroll-fade-right" style={{animationDelay: '0.05s'}}>
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

            {isLoading ? (
                <div className="flex items-center justify-center py-12">
                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-2xl text-gray-600 dark:text-gray-500">progress_activity</span>
                </div>
            ) : filteredClasses.length === 0 ? (
                <div className="text-center py-12 text-gray-600 dark:text-gray-500">
                    <span aria-hidden="true" className="material-symbols-outlined text-4xl mb-2 block">spa</span>
                    <p>No {activeCategory === 'all' ? 'wellness classes' : activeCategory.toLowerCase()} found</p>
                </div>
            ) : (
                <div className="space-y-6">
                    {upcomingClasses.length > 0 && (
                        <div className="animate-pop-in" style={{animationDelay: '0.1s'}}>
                            <div className="flex items-center gap-2 mb-3">
                                <span aria-hidden="true" className="material-symbols-outlined text-green-500">schedule</span>
                                <h3 className="font-bold text-primary dark:text-white">Upcoming ({upcomingClasses.length})</h3>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {upcomingClasses.map((cls, index) => (
                                    <div key={cls.id} onClick={() => openEdit(cls)} className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 flex flex-col gap-3 relative overflow-hidden cursor-pointer hover:border-primary/30 transition-all animate-pop-in" style={{animationDelay: `${0.15 + index * 0.03}s`}}>
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
                        </div>
                    )}
                    
                    {pastClasses.length > 0 && (
                        <div className="animate-pop-in" style={{animationDelay: '0.2s'}}>
                            <div className="flex items-center gap-2 mb-3">
                                <span aria-hidden="true" className="material-symbols-outlined text-gray-600 dark:text-gray-500">history</span>
                                <h3 className="font-bold text-gray-500 dark:text-gray-400">Past ({pastClasses.length})</h3>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-70">
                                {pastClasses.map((cls, index) => (
                                    <div key={cls.id} onClick={() => openEdit(cls)} className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 flex flex-col gap-3 relative overflow-hidden cursor-pointer hover:border-primary/30 transition-all animate-pop-in" style={{animationDelay: `${0.25 + index * 0.03}s`}}>
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
                        </div>
                    )}
                </div>
            )}

            <ParticipantDetailsModal
                isOpen={isViewingEnrollments}
                onClose={() => { setIsViewingEnrollments(false); setSelectedClass(null); setEnrollments([]); }}
                title={selectedClass?.title || 'Class Enrollments'}
                subtitle={selectedClass ? `${formatDate(selectedClass.date)} at ${selectedClass.time}` : undefined}
                participants={enrollments}
                isLoading={isLoadingEnrollments}
                type="enrollment"
                classId={selectedClass?.id}
                onRefresh={() => selectedClass && handleViewEnrollments(selectedClass)}
            />

            <ModalShell isOpen={isEditing} onClose={() => { setIsEditing(false); setError(null); }} title={editId ? 'Edit Class' : 'Add Class'} showCloseButton={false}>
                <div className="p-6 space-y-4 overflow-hidden">
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
                            placeholder="Jane Smith"
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
                        <select
                            value={formData.category || 'Yoga'}
                            onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        >
                            {categories.map(cat => (
                                <option key={cat} value={cat}>{cat}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Spots *</label>
                        <input
                            type="text"
                            value={formData.spots || ''}
                            onChange={(e) => setFormData({ ...formData, spots: e.target.value })}
                            placeholder="12 spots"
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                        <textarea
                            value={formData.description || ''}
                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                            placeholder="A restorative session designed to improve flexibility..."
                            rows={3}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white resize-none"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Image (optional)</label>
                        <input
                            type="file"
                            accept="image/*"
                            onChange={(e) => {
                                const file = e.target.files?.[0] || null;
                                setFormData({ ...formData, imageFile: file });
                            }}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:bg-primary/10 file:text-primary dark:file:bg-white/10 dark:file:text-white file:font-medium file:cursor-pointer"
                        />
                        {(formData.imageFile || formData.image_url) && (
                            <div className="mt-2 relative">
                                <img
                                    src={formData.imageFile ? URL.createObjectURL(formData.imageFile) : formData.image_url || ''}
                                    alt="Preview"
                                    className="w-full h-32 object-cover rounded-lg border border-gray-200 dark:border-white/25"
                                />
                                <button
                                    type="button"
                                    onClick={() => setFormData({ ...formData, imageFile: null, image_url: null })}
                                    className="absolute top-2 right-2 w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors"
                                >
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm">close</span>
                                </button>
                            </div>
                        )}
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">External URL (optional)</label>
                        <input
                            type="url"
                            value={formData.external_url || ''}
                            onChange={(e) => setFormData({ ...formData, external_url: e.target.value })}
                            placeholder="https://example.com"
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Visibility</label>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setFormData({ ...formData, visibility: 'public' })}
                                className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                                    (formData.visibility || 'public') === 'public'
                                        ? 'bg-[#CCB8E4] text-[#293515] shadow-md'
                                        : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70 border border-gray-200 dark:border-white/25'
                                }`}
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">public</span>
                                Public
                            </button>
                            <button
                                type="button"
                                onClick={() => setFormData({ ...formData, visibility: 'members' })}
                                className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                                    formData.visibility === 'members'
                                        ? 'bg-[#CCB8E4] text-[#293515] shadow-md'
                                        : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70 border border-gray-200 dark:border-white/25'
                                }`}
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">lock</span>
                                Members Only
                            </button>
                        </div>
                        <p className="text-xs text-gray-600 dark:text-gray-500 mt-1">
                            {(formData.visibility || 'public') === 'public' ? 'Visible on public website and member portal' : 'Only visible to logged-in members'}
                        </p>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700/50">
                        <div className="flex-1">
                            <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                                <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-amber-600">block</span>
                                Block Bookings During Class
                            </label>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Prevents bay and conference room bookings during this class
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setFormData({ ...formData, block_bookings: !formData.block_bookings })}
                            className={`relative w-12 h-6 rounded-full transition-colors ${
                                formData.block_bookings 
                                    ? 'bg-amber-500' 
                                    : 'bg-gray-300 dark:bg-white/20'
                            }`}
                        >
                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
                                formData.block_bookings ? 'translate-x-6' : 'translate-x-0'
                            }`} />
                        </button>
                    </div>

                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Class Capacity
                            </label>
                            <input
                                type="number"
                                min="1"
                                placeholder="Leave blank for unlimited"
                                value={formData.capacity || ''}
                                onChange={(e) => setFormData({ ...formData, capacity: e.target.value ? parseInt(e.target.value) : null })}
                                className="w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-white/25 bg-white dark:bg-white/10 text-gray-900 dark:text-white placeholder-gray-400"
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Maximum number of enrollments allowed. Leave blank for unlimited.
                            </p>
                        </div>

                        <div className="flex items-center justify-between p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700/50">
                            <div className="flex-1">
                                <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                                    <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-blue-600">playlist_add</span>
                                    Enable Waitlist
                                </label>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                    Allow users to join a waitlist when class is full
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setFormData({ ...formData, waitlist_enabled: !formData.waitlist_enabled })}
                                className={`relative w-12 h-6 rounded-full transition-colors ${
                                    formData.waitlist_enabled 
                                        ? 'bg-blue-500' 
                                        : 'bg-gray-300 dark:bg-white/20'
                                }`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
                                    formData.waitlist_enabled ? 'translate-x-6' : 'translate-x-0'
                                }`} />
                            </button>
                        </div>
                    </div>

                    {error && (
                        <p className="text-red-600 text-sm">{error}</p>
                    )}

                    <div className="flex gap-3 pt-2">
                        <button
                            onClick={() => { setIsEditing(false); setError(null); }}
                            className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={isUploading}
                            className="flex-1 py-3 px-4 rounded-lg bg-brand-green text-white font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {isUploading && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                            {isUploading ? 'Saving...' : editId ? 'Save Changes' : 'Add Class'}
                        </button>
                    </div>
                </div>
            </ModalShell>

            <ModalShell 
                isOpen={showDeleteConfirm} 
                onClose={() => { setShowDeleteConfirm(false); setClassToDelete(null); }} 
                title="Delete Class"
                size="sm"
            >
                <div className="p-6">
                    <p className="text-gray-600 dark:text-gray-300 mb-6">
                        Are you sure you want to delete <span className="font-semibold text-primary dark:text-white">"{classToDelete?.title}"</span>? This action cannot be undone.
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={() => { setShowDeleteConfirm(false); setClassToDelete(null); }}
                            disabled={deletingClassId !== null}
                            className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={confirmDelete}
                            disabled={deletingClassId !== null}
                            className="flex-1 py-3 px-4 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                            {deletingClassId !== null ? (
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
                </div>
            </ModalShell>
        </div>
    );
};

const BLOCK_TYPES = [
    { id: 'maintenance', label: 'Maintenance' },
    { id: 'private_event', label: 'Private Event' },
    { id: 'staff_hold', label: 'Staff Hold' },
    { id: 'wellness', label: 'Wellness Class' },
    { id: 'other', label: 'Other' },
];

const AvailabilityBlocksContent: React.FC = () => {
    const { showToast } = useToast();
    const [blocks, setBlocks] = useState<AvailabilityBlock[]>([]);
    const [resources, setResources] = useState<Resource[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    
    const [filterResource, setFilterResource] = useState<string>('');
    const [filterStartDate, setFilterStartDate] = useState<string>('');
    const [filterEndDate, setFilterEndDate] = useState<string>('');
    
    const [isEditing, setIsEditing] = useState(false);
    const [editId, setEditId] = useState<number | null>(null);
    const [formData, setFormData] = useState<BlockFormData>({
        resource_id: null,
        block_date: '',
        start_time: '09:00',
        end_time: '10:00',
        block_type: 'maintenance',
        notes: ''
    });
    const [isSaving, setIsSaving] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [blockToDelete, setBlockToDelete] = useState<AvailabilityBlock | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    
    const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

    useEffect(() => {
        fetchResources();
        fetchBlocks();
    }, []);

    useEffect(() => {
        const handleOpenCreate = () => openCreate();
        window.addEventListener('openBlockCreate', handleOpenCreate);
        return () => window.removeEventListener('openBlockCreate', handleOpenCreate);
    }, []);

    const fetchResources = async () => {
        try {
            const res = await fetch('/api/resources', { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setResources(data);
            }
        } catch (err) {
            console.error('Failed to fetch resources:', err);
        }
    };

    const fetchBlocks = async () => {
        try {
            setIsLoading(true);
            setError(null);
            
            const params = new URLSearchParams();
            if (filterStartDate) params.append('start_date', filterStartDate);
            if (filterEndDate) params.append('end_date', filterEndDate);
            if (filterResource) params.append('resource_id', filterResource);
            
            const url = `/api/availability-blocks${params.toString() ? '?' + params.toString() : ''}`;
            const res = await fetch(url, { credentials: 'include' });
            
            if (res.ok) {
                const data = await res.json();
                setBlocks(data);
            } else {
                setError('Failed to fetch availability blocks');
            }
        } catch (err) {
            console.error('Failed to fetch blocks:', err);
            setError('Failed to fetch availability blocks');
        } finally {
            setIsLoading(false);
        }
    };

    const handleFilter = () => {
        fetchBlocks();
    };

    const handleReset = () => {
        setFilterResource('');
        setFilterStartDate('');
        setFilterEndDate('');
        setTimeout(() => fetchBlocks(), 0);
    };

    const openCreate = () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        setFormData({
            resource_id: resources[0]?.id || null,
            block_date: tomorrow.toISOString().split('T')[0],
            start_time: '09:00',
            end_time: '10:00',
            block_type: 'maintenance',
            notes: ''
        });
        setEditId(null);
        setFormError(null);
        setIsEditing(true);
    };

    const openEdit = (block: AvailabilityBlock) => {
        setFormData({
            resource_id: block.resource_id,
            block_date: block.block_date,
            start_time: block.start_time.substring(0, 5),
            end_time: block.end_time.substring(0, 5),
            block_type: block.block_type,
            notes: block.notes || ''
        });
        setEditId(block.id);
        setFormError(null);
        setIsEditing(true);
    };

    const handleSave = async () => {
        if (!formData.resource_id || !formData.block_date || !formData.start_time || !formData.end_time || !formData.block_type) {
            setFormError('Please fill in all required fields');
            return;
        }

        try {
            setIsSaving(true);
            setFormError(null);
            
            const payload = {
                resource_id: formData.resource_id,
                block_date: formData.block_date,
                start_time: formData.start_time + ':00',
                end_time: formData.end_time + ':00',
                block_type: formData.block_type,
                notes: formData.notes || null
            };

            const url = editId ? `/api/availability-blocks/${editId}` : '/api/availability-blocks';
            const method = editId ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                showToast(editId ? 'Block updated' : 'Block created', 'success');
                setIsEditing(false);
                fetchBlocks();
            } else {
                const data = await res.json();
                setFormError(data.error || 'Failed to save block');
            }
        } catch (err) {
            setFormError('Failed to save block');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = (block: AvailabilityBlock) => {
        setBlockToDelete(block);
        setShowDeleteConfirm(true);
    };

    const confirmDelete = async () => {
        if (!blockToDelete) return;
        
        try {
            setIsDeleting(true);
            const res = await fetch(`/api/availability-blocks/${blockToDelete.id}`, {
                method: 'DELETE',
                credentials: 'include',
            });

            if (res.ok) {
                showToast('Block deleted', 'success');
                setShowDeleteConfirm(false);
                setBlockToDelete(null);
                fetchBlocks();
            } else {
                showToast('Failed to delete block', 'error');
            }
        } catch (err) {
            showToast('Failed to delete block', 'error');
        } finally {
            setIsDeleting(false);
        }
    };

    const formatDate = (dateStr: string) => {
        if (!dateStr) return 'No Date';
        const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
        return formatDateDisplayWithDay(datePart);
    };

    const formatTime = (timeStr: string) => {
        if (!timeStr) return '';
        const [hours, minutes] = timeStr.split(':');
        const h = parseInt(hours);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${h12}:${minutes} ${ampm}`;
    };

    const getBlockTypeLabel = (type: string) => {
        return BLOCK_TYPES.find(t => t.id === type)?.label || type;
    };

    const getBlockTypeColor = (type: string) => {
        switch (type) {
            case 'maintenance': return 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400';
            case 'private_event': return 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400';
            case 'staff_hold': return 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400';
            case 'wellness': return 'bg-[#CCB8E4]/30 dark:bg-[#CCB8E4]/20 text-[#293515] dark:text-[#CCB8E4]';
            default: return 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-400';
        }
    };

    const groupBlocksByDate = (blockList: AvailabilityBlock[]) => {
        const grouped: { [key: string]: AvailabilityBlock[] } = {};
        blockList.forEach(block => {
            const dateKey = block.block_date?.includes('T') 
                ? block.block_date.split('T')[0] 
                : block.block_date || 'No Date';
            if (!grouped[dateKey]) grouped[dateKey] = [];
            grouped[dateKey].push(block);
        });
        const sortedDates = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
        return sortedDates.map(date => ({ date, blocks: grouped[date] }));
    };

    const toggleDay = (date: string) => {
        setExpandedDays(prev => {
            const newSet = new Set(prev);
            if (newSet.has(date)) {
                newSet.delete(date);
            } else {
                newSet.add(date);
            }
            return newSet;
        });
    };

    const groupedBlocks = groupBlocksByDate(blocks);

    return (
        <div className="animate-pop-in">
            <div className="mb-4 p-4 bg-white dark:bg-surface-dark rounded-xl border border-gray-200 dark:border-white/20">
                <div className="flex flex-wrap gap-3">
                    <div className="flex-1 min-w-[150px]">
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Resource</label>
                        <select
                            value={filterResource}
                            onChange={(e) => setFilterResource(e.target.value)}
                            className="w-full p-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white text-sm"
                        >
                            <option value="">All Resources</option>
                            {resources.map(r => (
                                <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                        </select>
                    </div>
                    <div className="flex-1 min-w-[130px]">
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Start Date</label>
                        <input
                            type="date"
                            value={filterStartDate}
                            onChange={(e) => setFilterStartDate(e.target.value)}
                            className="w-full p-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white text-sm"
                        />
                    </div>
                    <div className="flex-1 min-w-[130px]">
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">End Date</label>
                        <input
                            type="date"
                            value={filterEndDate}
                            onChange={(e) => setFilterEndDate(e.target.value)}
                            className="w-full p-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white text-sm"
                        />
                    </div>
                    <div className="flex items-end gap-2">
                        <button
                            onClick={handleFilter}
                            className="py-2.5 px-4 rounded-lg bg-primary text-white text-sm font-medium hover:opacity-90 transition-opacity"
                        >
                            Filter
                        </button>
                        <button
                            onClick={handleReset}
                            className="py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-400 text-sm font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                        >
                            Reset
                        </button>
                    </div>
                </div>
            </div>

            {error && (
                <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm">
                    {error}
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center py-12">
                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-2xl text-gray-600 dark:text-gray-500">progress_activity</span>
                </div>
            ) : blocks.length === 0 ? (
                <div className="text-center py-12 text-gray-600 dark:text-gray-500">
                    <span aria-hidden="true" className="material-symbols-outlined text-4xl mb-2 block">event_busy</span>
                    <p>No availability blocks found</p>
                    <p className="text-sm mt-1">Use the + button to add a new block</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {groupedBlocks.map(({ date, blocks: dayBlocks }, groupIndex) => {
                        const isExpanded = expandedDays.has(date);
                        return (
                            <div 
                                key={date} 
                                className="bg-white dark:bg-surface-dark rounded-xl border border-gray-200 dark:border-white/20 overflow-hidden animate-pop-in"
                                style={{animationDelay: `${0.05 + groupIndex * 0.05}s`}}
                            >
                                <button
                                    onClick={() => toggleDay(date)}
                                    className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                                            <span aria-hidden="true" className="material-symbols-outlined text-orange-600 dark:text-orange-400">calendar_today</span>
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <h3 className="font-bold text-primary dark:text-white">{formatDate(date)}</h3>
                                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                                {dayBlocks.length} block{dayBlocks.length !== 1 ? 's' : ''}
                                                {(() => {
                                                    const closureTitles = [...new Set(dayBlocks.map(b => b.closure_title).filter(Boolean))];
                                                    if (closureTitles.length > 0) {
                                                        const displayTitle = closureTitles[0]?.replace(/^\[[^\]]+\]\s*:?\s*/i, '');
                                                        return <span className="text-primary/70 dark:text-white/70"> - {displayTitle}{closureTitles.length > 1 ? ` +${closureTitles.length - 1} more` : ''}</span>;
                                                    }
                                                    return null;
                                                })()}
                                            </p>
                                        </div>
                                    </div>
                                    <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}>
                                        expand_more
                                    </span>
                                </button>
                                
                                {isExpanded && (
                                    <div className="border-t border-gray-100 dark:border-white/10 p-3 space-y-3">
                                        {dayBlocks.map((block, blockIndex) => (
                                            <div 
                                                key={block.id} 
                                                onClick={() => openEdit(block)}
                                                className="bg-gray-50 dark:bg-black/20 p-3 rounded-lg flex flex-col gap-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-black/30 transition-colors animate-pop-in"
                                                style={{animationDelay: `${blockIndex * 0.03}s`}}
                                            >
                                                <div className="flex gap-3">
                                                    <div className={`w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center ${getBlockTypeColor(block.block_type)}`}>
                                                        <span aria-hidden="true" className="material-symbols-outlined text-lg">event_busy</span>
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 mb-1">
                                                            <h4 className="font-bold text-primary dark:text-white text-sm leading-tight">{block.resource_name}</h4>
                                                            <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${getBlockTypeColor(block.block_type)}`}>
                                                                {getBlockTypeLabel(block.block_type)}
                                                            </span>
                                                        </div>
                                                        <p className="text-xs text-gray-500 dark:text-gray-400">
                                                            {formatTime(block.start_time)} - {formatTime(block.end_time)}
                                                        </p>
                                                        {block.notes && (
                                                            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 truncate">{block.notes}</p>
                                                        )}
                                                    </div>
                                                    <button 
                                                        onClick={(e) => { e.stopPropagation(); handleDelete(block); }} 
                                                        className="self-start text-gray-400 hover:text-red-500 transition-colors p-1"
                                                    >
                                                        <span aria-hidden="true" className="material-symbols-outlined text-lg">delete</span>
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            <ModalShell isOpen={isEditing} onClose={() => { setIsEditing(false); setFormError(null); }} title={editId ? 'Edit Block' : 'Add Availability Block'} showCloseButton={false}>
                <div className="p-6 space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Resource *</label>
                        <select
                            value={formData.resource_id || ''}
                            onChange={(e) => setFormData({ ...formData, resource_id: parseInt(e.target.value) || null })}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        >
                            <option value="">Select a resource</option>
                            {resources.map(r => (
                                <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date *</label>
                        <input
                            type="date"
                            value={formData.block_date}
                            onChange={(e) => setFormData({ ...formData, block_date: e.target.value })}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Time *</label>
                            <input
                                type="time"
                                value={formData.start_time}
                                onChange={(e) => setFormData({ ...formData, start_time: e.target.value })}
                                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">End Time *</label>
                            <input
                                type="time"
                                value={formData.end_time}
                                onChange={(e) => setFormData({ ...formData, end_time: e.target.value })}
                                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Block Type *</label>
                        <select
                            value={formData.block_type}
                            onChange={(e) => setFormData({ ...formData, block_type: e.target.value })}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                        >
                            {BLOCK_TYPES.map(t => (
                                <option key={t.id} value={t.id}>{t.label}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
                        <textarea
                            value={formData.notes}
                            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                            placeholder="Optional notes about this block..."
                            rows={3}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white resize-none"
                        />
                    </div>

                    {formError && (
                        <p className="text-red-600 text-sm">{formError}</p>
                    )}

                    <div className="flex gap-3 pt-2">
                        <button
                            onClick={() => { setIsEditing(false); setFormError(null); }}
                            className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="flex-1 py-3 px-4 rounded-lg bg-brand-green text-white font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {isSaving && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                            {isSaving ? 'Saving...' : editId ? 'Save Changes' : 'Add Block'}
                        </button>
                    </div>
                </div>
            </ModalShell>

            <ModalShell 
                isOpen={showDeleteConfirm} 
                onClose={() => { setShowDeleteConfirm(false); setBlockToDelete(null); }} 
                title="Delete Block"
                size="sm"
            >
                <div className="p-6">
                    <p className="text-gray-600 dark:text-gray-300 mb-6">
                        Are you sure you want to delete this availability block for <span className="font-semibold text-primary dark:text-white">"{blockToDelete?.resource_name}"</span> on {blockToDelete ? formatDate(blockToDelete.block_date) : ''}? This action cannot be undone.
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={() => { setShowDeleteConfirm(false); setBlockToDelete(null); }}
                            disabled={isDeleting}
                            className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={confirmDelete}
                            disabled={isDeleting}
                            className="flex-1 py-3 px-4 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                            {isDeleting ? (
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
                </div>
            </ModalShell>
        </div>
    );
};

const EventsTab: React.FC = () => {
    const { showToast } = useToast();
    const [searchParams] = useSearchParams();
    const subtabParam = searchParams.get('subtab');
    const [activeSubTab, setActiveSubTab] = useState<'events' | 'wellness' | 'blocks'>(
        subtabParam === 'wellness' ? 'wellness' : subtabParam === 'blocks' ? 'blocks' : 'events'
    );
    const [syncMessage, setSyncMessage] = useState<string | null>(null);
    
    const [calendarStatus, setCalendarStatus] = useState<CalendarStatusResponse | null>(null);
    const [isLoadingCalendars, setIsLoadingCalendars] = useState(true);
    const [showCalendars, setShowCalendars] = useState(false);
    const [isBackfilling, setIsBackfilling] = useState(false);
    
    useEffect(() => {
        fetchCalendarStatus();
    }, []);
    
    useEffect(() => {
        if (subtabParam === 'wellness') {
            setActiveSubTab('wellness');
        } else if (subtabParam === 'blocks') {
            setActiveSubTab('blocks');
        } else if (subtabParam === 'events' || subtabParam === null) {
            setActiveSubTab('events');
        }
    }, [subtabParam]);
    
    const fetchCalendarStatus = async () => {
        try {
            setIsLoadingCalendars(true);
            const res = await fetch('/api/admin/calendars', { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setCalendarStatus(data);
            }
        } catch (err) {
            console.error('Failed to fetch calendar status:', err);
        } finally {
            setIsLoadingCalendars(false);
        }
    };

    const handleBackfillCalendar = async () => {
        try {
            setIsBackfilling(true);
            const res = await fetch('/api/wellness-classes/backfill-calendar', {
                method: 'POST',
                credentials: 'include',
            });
            
            if (res.ok) {
                const data = await res.json();
                showToast(`Created ${data.created} calendar events`, 'success');
            } else {
                const data = await res.json();
                showToast(data.error || 'Failed to backfill calendar', 'error');
            }
        } catch (err) {
            showToast('Failed to backfill calendar', 'error');
        } finally {
            setIsBackfilling(false);
        }
    };
    
    const handlePullRefresh = async () => {
        setSyncMessage(null);
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
        
        try {
            const [calRes, ebRes] = await Promise.all([
                retryFetch('/api/calendars/sync-all'),
                retryFetch('/api/eventbrite/sync')
            ]);
            
            const calData = await calRes.json();
            const ebData = await ebRes.json();
            
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
        } catch (err) {
            console.error('Sync failed:', err);
            setSyncMessage('Network error - please try again');
        }
        setTimeout(() => setSyncMessage(null), 5000);
    };

    return (
        <PullToRefresh onRefresh={handlePullRefresh}>
            <div className="animate-pop-in">
                {syncMessage && (
                    <div className={`mb-4 px-4 py-2 rounded-lg text-sm font-medium ${
                        syncMessage.startsWith('Error') || syncMessage.startsWith('Failed') || syncMessage.startsWith('Some syncs')
                            ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800' 
                            : 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border border-green-200 dark:border-green-800'
                    }`}>
                        {syncMessage}
                    </div>
                )}

                <div className="mb-4 p-4 bg-white dark:bg-surface-dark rounded-xl border border-gray-200 dark:border-white/20">
                    <button
                        onClick={() => setShowCalendars(!showCalendars)}
                        className="flex items-center justify-between w-full text-left"
                    >
                        <div className="flex items-center gap-2">
                            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">calendar_month</span>
                            <span className="font-bold text-primary dark:text-white">Calendar Status</span>
                        </div>
                        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showCalendars ? 'rotate-180' : ''}`}>
                            expand_more
                        </span>
                    </button>
                    
                    {showCalendars && (
                        <div className="mt-4 space-y-3">
                            {isLoadingCalendars ? (
                                <div className="flex items-center justify-center py-4">
                                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-gray-500">progress_activity</span>
                                </div>
                            ) : calendarStatus ? (
                                <>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                        {calendarStatus.configured_calendars.map((cal, idx) => (
                                            <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                                                <span className="text-sm font-medium text-primary dark:text-white truncate mr-2">{cal.name}</span>
                                                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded shrink-0 ${
                                                    cal.status === 'connected' 
                                                        ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400' 
                                                        : 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                                                }`}>
                                                    {cal.status === 'connected' ? 'Connected' : 'Not Found'}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        Last checked: {new Date(calendarStatus.timestamp).toLocaleString()}
                                    </p>
                                    <button
                                        onClick={handleBackfillCalendar}
                                        disabled={isBackfilling}
                                        className="w-full py-2.5 px-4 rounded-lg border-2 border-dashed border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-400 text-sm font-medium flex items-center justify-center gap-2 hover:border-primary/30 hover:text-primary dark:hover:border-white/30 dark:hover:text-white transition-colors disabled:opacity-50"
                                    >
                                        {isBackfilling ? (
                                            <>
                                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
                                                Filling gaps...
                                            </>
                                        ) : (
                                            <>
                                                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">sync</span>
                                                Fill Calendar Gaps
                                            </>
                                        )}
                                    </button>
                                </>
                            ) : (
                                <p className="text-sm text-gray-500 dark:text-gray-400">Failed to load calendar status</p>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex gap-2 mb-4 animate-pop-in" style={{animationDelay: '0.05s'}}>
                    <button
                        onClick={() => setActiveSubTab('events')}
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
                        onClick={() => setActiveSubTab('wellness')}
                        className={`flex-1 py-2.5 px-3 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-1.5 ${
                            activeSubTab === 'wellness'
                                ? 'bg-[#CCB8E4] text-[#293515] shadow-md'
                                : 'bg-white dark:bg-white/10 text-gray-600 dark:text-white/80 border border-gray-200 dark:border-white/25'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[18px]">spa</span>
                        Wellness
                    </button>
                    <button
                        onClick={() => setActiveSubTab('blocks')}
                        className={`flex-1 py-2.5 px-3 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-1.5 ${
                            activeSubTab === 'blocks'
                                ? 'bg-orange-500 text-white shadow-md'
                                : 'bg-white dark:bg-white/10 text-gray-600 dark:text-white/80 border border-gray-200 dark:border-white/25'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[18px]">event_busy</span>
                        Blocks
                    </button>
                </div>

                {activeSubTab === 'events' && <EventsAdminContent />}
                {activeSubTab === 'wellness' && <WellnessAdminContent />}
                {activeSubTab === 'blocks' && <AvailabilityBlocksContent />}
                <FloatingActionButton 
                    onClick={() => {
                        if (activeSubTab === 'events') {
                            window.dispatchEvent(new CustomEvent('openEventCreate'));
                        } else if (activeSubTab === 'wellness') {
                            window.dispatchEvent(new CustomEvent('openWellnessCreate'));
                        } else {
                            window.dispatchEvent(new CustomEvent('openBlockCreate'));
                        }
                    }} 
                    color={activeSubTab === 'events' ? 'green' : activeSubTab === 'wellness' ? 'purple' : 'amber'} 
                    label={activeSubTab === 'events' ? 'Add event' : activeSubTab === 'wellness' ? 'Add wellness session' : 'Add block'} 
                />
            </div>
        </PullToRefresh>
    );
};

export default EventsTab;
