import React, { useState, useEffect } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import EmptyState from '../../../../components/EmptyState';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDateDisplayWithDay } from '../../../../utils/dateUtils';
import { getApiErrorMessage, getNetworkErrorMessage } from '../../../../utils/errorHandling';
import { useToast } from '../../../../components/Toast';
import { SlideUpDrawer } from '../../../../components/SlideUpDrawer';
import { fetchWithCredentials, deleteWithCredentials } from '../../../../hooks/queries/useFetch';
import { EventsTabSkeleton } from '../../../../components/skeletons';
import { getTodayPacific } from '../../../../utils/dateUtils';
import { Participant, WellnessClass, WellnessFormData, WELLNESS_CATEGORY_TABS, INITIAL_DISPLAY_COUNT } from './eventsTypes';
import { ParticipantDetailsModal } from './ParticipantDetailsModal';

export const WellnessAdminContent: React.FC = () => {
    const queryClient = useQueryClient();
    const [upcomingClassesRef] = useAutoAnimate();
    const [pastClassesRef] = useAutoAnimate();
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
            setIsEditing(false);
            setFormData({ category: 'Classes', status: 'available', duration: '60 min' });
            
            const recurringCount = savedItem.recurringUpdated || 0;
            const successMsg = editId 
                ? (recurringCount > 0 
                    ? `Wellness updated + ${recurringCount} future instances updated` 
                    : 'Wellness updated successfully')
                : 'Wellness created successfully';
            setSuccess(successMsg);
            showToast(successMsg, 'success');
            setTimeout(() => setSuccess(null), 3000);
        },
        onError: (error: Error) => {
            setError(error.message || getNetworkErrorMessage());
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['wellness-classes'] });
            queryClient.invalidateQueries({ queryKey: ['wellness-needs-review'] });
        }
    });

    const deleteClassMutation = useMutation({
        mutationFn: (classId: number) => 
            deleteWithCredentials(`/api/wellness-classes/${classId}`),
        onMutate: async (classId) => {
            await queryClient.cancelQueries({ queryKey: ['wellness-classes'] });
            const snapshot = queryClient.getQueryData<WellnessClass[]>(['wellness-classes']);
            queryClient.setQueryData<WellnessClass[]>(['wellness-classes'], (old) => {
                if (!old) return old;
                return old.filter(c => c.id !== classId);
            });
            return { snapshot };
        },
        onSuccess: () => {
            setSuccess('Wellness deleted');
            showToast('Wellness deleted', 'success');
            setTimeout(() => setSuccess(null), 3000);
        },
        onError: (_err, _classId, context) => {
            if (context?.snapshot !== undefined) {
                queryClient.setQueryData(['wellness-classes'], context.snapshot);
            }
            setError(getNetworkErrorMessage());
            setTimeout(() => setError(null), 3000);
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['wellness-classes'] });
        },
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
    } catch (err: unknown) {
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
        } catch (err: unknown) {
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
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] bg-orange-500 text-white text-[10px] font-bold uppercase tracking-widest">
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
                            <div ref={upcomingClassesRef} className="grid grid-cols-1 gap-4">
                                {upcomingClasses.slice(0, showAllUpcoming ? upcomingClasses.length : INITIAL_DISPLAY_COUNT).map((cls, index) => (
                                    <div key={cls.id} onClick={() => openEdit(cls)} className={`tactile-card bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 flex flex-col gap-3 relative overflow-hidden cursor-pointer hover:border-primary/30 transition-colors animate-list-item-delay-${Math.min(index + 1, 10)}`}>
                                        <div className="flex gap-4">
                                            <div className="w-20 h-20 rounded-lg bg-[#CCB8E4]/20 dark:bg-[#CCB8E4]/10 flex-shrink-0 overflow-hidden flex items-center justify-center">
                                                {cls.image_url ? (
                                                    <img src={cls.image_url} alt={cls.title || 'Wellness class image'} className="w-full h-full object-cover" />
                                                ) : (
                                                    <span aria-hidden="true" className="material-symbols-outlined text-3xl text-[#CCB8E4]">
                                                        {getCategoryIcon(cls.category)}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                <h4 className="font-bold text-xl text-primary dark:text-white leading-none truncate translate-y-[1px]" style={{ fontFamily: 'var(--font-headline)', fontOpticalSizing: 'auto', letterSpacing: '-0.02em' }}>{cls.title}</h4>
                                                <span className="w-fit inline-block text-[10px] font-bold uppercase tracking-wider bg-[#CCB8E4]/20 text-[#293515] dark:text-[#CCB8E4] px-2 py-0.5 rounded mt-1.5" style={{ fontFamily: 'var(--font-label)' }}>{cls.category}</span>
                                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{formatDate(cls.date)} • {cls.time}</p>
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
                            <div ref={pastClassesRef} className="grid grid-cols-1 gap-4 opacity-70">
                                {pastClasses.slice(0, showAllPast ? pastClasses.length : INITIAL_DISPLAY_COUNT).map((cls, index) => (
                                    <div key={cls.id} onClick={() => openEdit(cls)} className={`tactile-card bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 flex flex-col gap-3 relative overflow-hidden cursor-pointer hover:border-primary/30 transition-colors animate-list-item-delay-${Math.min(index + 1, 10)}`}>
                                        <div className="flex gap-4">
                                            <div className="w-20 h-20 rounded-lg bg-[#CCB8E4]/20 dark:bg-[#CCB8E4]/10 flex-shrink-0 overflow-hidden flex items-center justify-center">
                                                {cls.image_url ? (
                                                    <img src={cls.image_url} alt={cls.title || 'Wellness class image'} className="w-full h-full object-cover" />
                                                ) : (
                                                    <span aria-hidden="true" className="material-symbols-outlined text-3xl text-[#CCB8E4]">
                                                        {getCategoryIcon(cls.category)}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                <h4 className="font-bold text-xl text-primary dark:text-white leading-none truncate translate-y-[1px]" style={{ fontFamily: 'var(--font-headline)', fontOpticalSizing: 'auto', letterSpacing: '-0.02em' }}>{cls.title}</h4>
                                                <span className="w-fit inline-block text-[10px] font-bold uppercase tracking-wider bg-[#CCB8E4]/20 text-[#293515] dark:text-[#CCB8E4] px-2 py-0.5 rounded mt-1.5" style={{ fontFamily: 'var(--font-label)' }}>{cls.category}</span>
                                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{formatDate(cls.date)} • {cls.time}</p>
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
                title={editId ? 'Edit Wellness' : 'Add Wellness'}
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
                            {isUploading || saveClassMutation.isPending ? 'Saving...' : editId ? 'Save Changes' : 'Add Wellness'}
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
                                className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all duration-fast flex items-center justify-center gap-2 ${
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
                                className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all duration-fast flex items-center justify-center gap-2 ${
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
