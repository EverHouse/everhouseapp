import React, { useState, useEffect } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import EmptyState from '../../../../components/EmptyState';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usePageReady } from '../../../../contexts/PageReadyContext';
import { formatDateDisplayWithDay, formatTime12Hour, getTodayPacific } from '../../../../utils/dateUtils';
import { getNetworkErrorMessage } from '../../../../utils/errorHandling';
import { useToast } from '../../../../components/Toast';
import { SlideUpDrawer } from '../../../../components/SlideUpDrawer';
import { AnimatedPage } from '../../../../components/motion';
import { fetchWithCredentials, deleteWithCredentials } from '../../../../hooks/queries/useFetch';
import { EventsTabSkeleton } from '../../../../components/skeletons';
import { Participant, DBEvent, NeedsReviewEvent, CATEGORY_TABS } from './eventsTypes';
import WalkingGolferSpinner from '../../../../components/WalkingGolferSpinner';
import { ParticipantDetailsModal } from './ParticipantDetailsModal';

interface NeedsReviewSectionProps {
    events: NeedsReviewEvent[];
    isLoading: boolean;
    isExpanded: boolean;
    onToggleExpanded: () => void;
    onEditEvent: (event: NeedsReviewEvent) => void;
}

const NeedsReviewSection: React.FC<NeedsReviewSectionProps> = ({ events, isLoading, isExpanded, onToggleExpanded, onEditEvent }) => {
    const count = events.length;
    
    if (!isLoading && count === 0) {
        return null;
    }
    
    return (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10 backdrop-blur-sm overflow-hidden mb-4">
            <button
                onClick={onToggleExpanded}
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
                <span className={`material-symbols-outlined text-amber-600 dark:text-amber-400 transition-transform duration-fast ${isExpanded ? 'rotate-180' : ''}`}>
                    expand_more
                </span>
            </button>
            
            {isExpanded && (
                <div className="border-t border-amber-500/20 p-4 space-y-4">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-8">
                            <WalkingGolferSpinner size="sm" />
                        </div>
                    ) : (
                        events.map((event) => {
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
                                            onClick={() => onEditEvent(event)}
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

export const EventsAdminContent: React.FC = () => {
    const { setPageReady } = usePageReady();
    const { showToast } = useToast();
    const queryClient = useQueryClient();
    const [upcomingEventsRef] = useAutoAnimate();
    const [pastEventsRef] = useAutoAnimate();
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
            await queryClient.cancelQueries({ queryKey: ['admin-events'] });
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
        },
        onSettled: () => {
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
            await queryClient.cancelQueries({ queryKey: ['admin-events'] });
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
        },
        onSettled: () => {
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
        } catch (err: unknown) {
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

    return (
        <AnimatedPage>
            <NeedsReviewSection
                events={needsReviewEvents}
                isLoading={needsReviewLoading}
                isExpanded={needsReviewExpanded}
                onToggleExpanded={() => setNeedsReviewExpanded(!needsReviewExpanded)}
                onEditEvent={openEditForNeedsReview}
            />

            <div className="flex gap-2 overflow-x-auto pb-4 mb-4 scrollbar-hide -mx-4 px-4 scroll-fade-right">
                {CATEGORY_TABS.map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveCategory(tab.id)}
                        className={`tactile-btn flex items-center gap-1.5 px-3 py-2 rounded-full text-[10px] sm:text-xs font-bold uppercase tracking-wide whitespace-nowrap transition-all duration-fast flex-shrink-0 ${
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
                        <input aria-label="Title" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="Event title" value={newItem.title || ''} onChange={e => setNewItem({...newItem, title: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Category *</label>
                        <select 
                            aria-label="Category"
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
                        <input aria-label="Event date" type="date" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white" value={newItem.event_date || ''} onChange={e => setNewItem({...newItem, event_date: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Start Time</label>
                        <input aria-label="Start time" type="time" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white" value={newItem.start_time || ''} onChange={e => setNewItem({...newItem, start_time: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">End Time</label>
                        <input aria-label="End time" type="time" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white" value={newItem.end_time || ''} onChange={e => setNewItem({...newItem, end_time: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Location *</label>
                        <input 
                            aria-label="Location"
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
                        <input aria-label="Image URL" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="https://..." value={newItem.image_url || ''} onChange={e => setNewItem({...newItem, image_url: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Max Attendees (optional)</label>
                        <input aria-label="Max attendees" type="number" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="e.g., 50" value={newItem.max_attendees || ''} onChange={e => setNewItem({...newItem, max_attendees: parseInt(e.target.value) || null})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">External Link (optional)</label>
                        <input aria-label="External link" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="https://..." value={newItem.external_url || ''} onChange={e => setNewItem({...newItem, external_url: e.target.value})} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Description *</label>
                        <textarea 
                            aria-label="Description"
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
                                className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all duration-fast flex items-center justify-center gap-2 ${
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
                                className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all duration-fast flex items-center justify-center gap-2 ${
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
                            <div ref={upcomingEventsRef} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {upcomingEvents.map((event, index) => {
                                    const isPending = pendingEventIds.has(event.id);
                                    const isOptimistic = event.id < 0;
                                    return (
                                    <div key={event.id} onClick={() => !isOptimistic && openEdit(event)} className={`tactile-card bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border flex flex-col gap-3 relative overflow-hidden transition-colors animate-slide-up-stagger ${
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
                                                    <img src={event.image_url} alt={event.title || 'Event image'} className="w-full h-full object-cover" />
                                                ) : (
                                                    <span aria-hidden="true" className="material-symbols-outlined text-3xl text-gray-500 dark:text-white/20">
                                                        {event.category === 'Golf' ? 'golf_course' : event.category === 'Tournaments' ? 'emoji_events' : event.category === 'Dining' ? 'restaurant' : event.category === 'Networking' ? 'handshake' : event.category === 'Workshops' ? 'school' : event.category === 'Family' ? 'family_restroom' : event.category === 'Entertainment' ? 'music_note' : event.category === 'Charity' ? 'volunteer_activism' : 'celebration'}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                <h4 className="font-bold text-2xl text-primary dark:text-white leading-none mb-1 truncate translate-y-[2px]" style={{ fontFamily: 'var(--font-headline)', fontOpticalSizing: 'auto', letterSpacing: '-0.02em' }}>{event.title}</h4>
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
                            <div ref={pastEventsRef} className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-70">
                                {pastEvents.slice(0, showAllPastEvents ? pastEvents.length : 20).map((event, index) => {
                                    const isPending = pendingEventIds.has(event.id);
                                    return (
                                    <div key={event.id} onClick={() => openEdit(event)} className={`tactile-card bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border flex flex-col gap-3 relative overflow-hidden transition-colors animate-slide-up-stagger ${
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
                                                    <img src={event.image_url} alt={event.title || 'Event image'} className="w-full h-full object-cover" />
                                                ) : (
                                                    <span aria-hidden="true" className="material-symbols-outlined text-3xl text-gray-500 dark:text-white/20">
                                                        {event.category === 'Golf' ? 'golf_course' : event.category === 'Tournaments' ? 'emoji_events' : event.category === 'Dining' ? 'restaurant' : event.category === 'Networking' ? 'handshake' : event.category === 'Workshops' ? 'school' : event.category === 'Family' ? 'family_restroom' : event.category === 'Entertainment' ? 'music_note' : event.category === 'Charity' ? 'volunteer_activism' : 'celebration'}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                <h4 className="font-bold text-2xl text-primary dark:text-white leading-none mb-1 truncate translate-y-[2px]" style={{ fontFamily: 'var(--font-headline)', fontOpticalSizing: 'auto', letterSpacing: '-0.02em' }}>{event.title}</h4>
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
