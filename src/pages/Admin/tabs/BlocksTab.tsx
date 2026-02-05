import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useData } from '../../../contexts/DataContext';
import { useToast } from '../../../components/Toast';
import { getTodayPacific, formatDateDisplayWithDay } from '../../../utils/dateUtils';
import PullToRefresh from '../../../components/PullToRefresh';
import { SlideUpDrawer } from '../../../components/SlideUpDrawer';
import FloatingActionButton from '../../../components/FloatingActionButton';
import AvailabilityBlocksContent from '../components/AvailabilityBlocksContent';
import { AnimatedPage } from '../../../components/motion';
import { useConfirmDialog } from '../../../components/ConfirmDialog';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials, putWithCredentials } from '../../../hooks/queries/useFetch';

interface BlocksClosure {
    id: number;
    title: string;
    reason: string | null;
    memberNotice: string | null;
    notes: string | null;
    noticeType: string | null;
    startDate: string;
    startTime: string | null;
    endDate: string;
    endTime: string | null;
    affectedAreas: string | null;
    visibility: string | null;
    notifyMembers: boolean | null;
    isActive: boolean;
    needsReview: boolean | null;
    createdAt: string;
    createdBy: string | null;
}

interface BlocksClosureForm {
    start_date: string;
    start_time: string;
    end_date: string;
    end_time: string;
    affected_areas: string;
    visibility: string;
    reason: string;
    member_notice: string;
    notes: string;
    title: string;
    notice_type: string;
    notify_members: boolean;
}

interface NoticeType {
    id: number;
    name: string;
    isPreset: boolean;
    sortOrder: number;
}

interface ClosureReason {
    id: number;
    label: string;
    sortOrder: number;
    isActive: boolean;
}

function stripHtml(html: string | null | undefined): string {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n\n')
        .replace(/<p>/gi, '')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const BlocksTab: React.FC = () => {
    const { actualUser } = useData();
    const { showToast } = useToast();
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const subtabParam = searchParams.get('subtab');
    const activeSubTab: 'notices' | 'blocks' = subtabParam === 'blocks' ? 'blocks' : 'notices';
    
    const setActiveSubTab = (tab: 'notices' | 'blocks') => {
        setSearchParams(params => {
            const newParams = new URLSearchParams(params);
            if (tab === 'notices') {
                newParams.delete('subtab');
            } else {
                newParams.set('subtab', tab);
            }
            return newParams;
        });
    };
    
    const [isClosureModalOpen, setIsClosureModalOpen] = useState(false);
    const [editingClosureId, setEditingClosureId] = useState<number | null>(null);
    const [expandedNotices, setExpandedNotices] = useState<Set<number>>(new Set());
    const [showClosureReasonsSection, setShowClosureReasonsSection] = useState(false);
    const [newReasonLabel, setNewReasonLabel] = useState('');
    
    const [showNoticeTypesSection, setShowNoticeTypesSection] = useState(false);
    const [newNoticeTypeName, setNewNoticeTypeName] = useState('');
    
    const [isReasonDrawerOpen, setIsReasonDrawerOpen] = useState(false);
    const [reasonDrawerData, setReasonDrawerData] = useState<{ id: number; label: string; sortOrder: number } | null>(null);
    const [isNoticeTypeDrawerOpen, setIsNoticeTypeDrawerOpen] = useState(false);
    const [noticeTypeDrawerData, setNoticeTypeDrawerData] = useState<{ id: number; name: string; sortOrder: number } | null>(null);
    
    const [closuresFilterResource, setClosuresFilterResource] = useState<string>('all');
    const [closuresFilterDate, setClosuresFilterDate] = useState<string>('');
    const [showPastAccordion, setShowPastAccordion] = useState(false);
    const [closureForm, setClosureForm] = useState<BlocksClosureForm>({
        start_date: '',
        start_time: '',
        end_date: '',
        end_time: '',
        affected_areas: 'entire_facility',
        visibility: '',
        reason: '',
        member_notice: '',
        notes: '',
        title: '',
        notice_type: '',
        notify_members: false
    });
    const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();

    // React Query hooks for data fetching
    const { data: closures = [], isLoading: closuresLoading } = useQuery({
        queryKey: ['closures'],
        queryFn: () => fetchWithCredentials<BlocksClosure[]>('/api/closures')
    });

    const { data: resources = [], isLoading: isLoading } = useQuery({
        queryKey: ['resources'],
        queryFn: () => fetchWithCredentials<{ id: number; name: string; type: string }[]>('/api/resources')
    });

    const { data: noticeTypes = [] } = useQuery({
        queryKey: ['noticeTypes'],
        queryFn: () => fetchWithCredentials<NoticeType[]>('/api/notice-types')
    });

    const { data: closureReasons = [] } = useQuery({
        queryKey: ['closureReasons'],
        queryFn: () => fetchWithCredentials<ClosureReason[]>('/api/closure-reasons?includeInactive=true')
    });

    const markTouched = (field: string) => {
        setTouchedFields(prev => new Set(prev).add(field));
    };

    const closureValidation = {
        notice_type: !closureForm.notice_type?.trim(),
        affected_areas: !closureForm.affected_areas?.trim(),
        visibility: !closureForm.visibility?.trim()
    };

    const isClosureFormValid = !closureValidation.notice_type && !closureValidation.affected_areas && !closureValidation.visibility;

    // Mutations for closure reasons
    const addClosureReasonMutation = useMutation({
        mutationFn: (label: string) => postWithCredentials<ClosureReason>('/api/closure-reasons', { label: label.trim() }),
        onSuccess: () => {
            setNewReasonLabel('');
            queryClient.invalidateQueries({ queryKey: ['closureReasons'] });
            showToast('Closure reason added', 'success');
        },
        onError: (error: any) => {
            showToast(error.message || 'Failed to add reason', 'error');
        }
    });

    const handleAddClosureReason = () => {
        if (!newReasonLabel.trim()) return;
        addClosureReasonMutation.mutate(newReasonLabel);
    };

    const updateClosureReasonMutation = useMutation({
        mutationFn: (data: { id: number; label: string; sortOrder: number }) =>
            putWithCredentials(`/api/closure-reasons/${data.id}`, { label: data.label, sort_order: data.sortOrder }),
        onSuccess: () => {
            closeReasonDrawer();
            queryClient.invalidateQueries({ queryKey: ['closureReasons'] });
            showToast('Closure reason updated', 'success');
        },
        onError: (error: any) => {
            showToast(error.message || 'Failed to update reason', 'error');
        }
    });

    const deleteClosureReasonMutation = useMutation({
        mutationFn: (id: number) => deleteWithCredentials(`/api/closure-reasons/${id}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['closureReasons'] });
            showToast('Closure reason deleted', 'success');
        },
        onError: (error: any) => {
            showToast(error.message || 'Failed to delete reason', 'error');
        }
    });

    const reactivateClosureReasonMutation = useMutation({
        mutationFn: (id: number) => putWithCredentials(`/api/closure-reasons/${id}`, { is_active: true }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['closureReasons'] });
            showToast('Closure reason reactivated', 'success');
        },
        onError: (error: any) => {
            showToast(error.message || 'Failed to reactivate reason', 'error');
        }
    });

    const addNoticeTypeMutation = useMutation({
        mutationFn: (name: string) => postWithCredentials<NoticeType>('/api/notice-types', { name: name.trim() }),
        onSuccess: () => {
            setNewNoticeTypeName('');
            queryClient.invalidateQueries({ queryKey: ['noticeTypes'] });
            showToast('Notice type added', 'success');
        },
        onError: (error: any) => {
            showToast(error.message || 'Failed to add notice type', 'error');
        }
    });

    const updateNoticeTypeMutation = useMutation({
        mutationFn: (data: { id: number; name: string; sortOrder: number }) =>
            putWithCredentials(`/api/notice-types/${data.id}`, { name: data.name, sort_order: data.sortOrder }),
        onSuccess: () => {
            closeNoticeTypeDrawer();
            queryClient.invalidateQueries({ queryKey: ['noticeTypes'] });
            showToast('Notice type updated', 'success');
        },
        onError: (error: any) => {
            showToast(error.message || 'Failed to update notice type', 'error');
        }
    });

    const deleteNoticeTypeMutation = useMutation({
        mutationFn: (id: number) => deleteWithCredentials(`/api/notice-types/${id}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['noticeTypes'] });
            showToast('Notice type deleted', 'success');
        },
        onError: (error: any) => {
            showToast(error.message || 'Failed to delete notice type', 'error');
        }
    });

    const openReasonDrawer = (reason: ClosureReason) => {
        setReasonDrawerData({ id: reason.id, label: reason.label, sortOrder: reason.sortOrder });
        setIsReasonDrawerOpen(true);
    };

    const closeReasonDrawer = () => {
        setIsReasonDrawerOpen(false);
        setReasonDrawerData(null);
    };

    const handleSaveReasonFromDrawer = () => {
        if (!reasonDrawerData) return;
        updateClosureReasonMutation.mutate(reasonDrawerData);
    };

    const handleDeleteClosureReason = async (id: number) => {
        const confirmed = await confirm({
            title: 'Delete Closure Reason',
            message: 'Are you sure you want to delete this closure reason?',
            confirmText: 'Delete',
            variant: 'danger'
        });
        if (!confirmed) return;
        deleteClosureReasonMutation.mutate(id);
    };

    const handleReactivateClosureReason = (id: number) => {
        reactivateClosureReasonMutation.mutate(id);
    };

    const handleAddNoticeType = () => {
        if (!newNoticeTypeName.trim()) return;
        addNoticeTypeMutation.mutate(newNoticeTypeName);
    };

    const openNoticeTypeDrawer = (noticeType: NoticeType) => {
        setNoticeTypeDrawerData({ id: noticeType.id, name: noticeType.name, sortOrder: noticeType.sortOrder });
        setIsNoticeTypeDrawerOpen(true);
    };

    const closeNoticeTypeDrawer = () => {
        setIsNoticeTypeDrawerOpen(false);
        setNoticeTypeDrawerData(null);
    };

    const handleSaveNoticeTypeFromDrawer = () => {
        if (!noticeTypeDrawerData) return;
        updateNoticeTypeMutation.mutate(noticeTypeDrawerData);
    };

    const handleDeleteNoticeType = async (id: number) => {
        const confirmed = await confirm({
            title: 'Delete Notice Type',
            message: 'Are you sure you want to delete this notice type?',
            confirmText: 'Delete',
            variant: 'danger'
        });
        if (!confirmed) return;
        deleteNoticeTypeMutation.mutate(id);
    };

    // Mutations for closures
    const saveClosureMutation = useMutation({
        mutationFn: (data: { form: BlocksClosureForm; isEdit: boolean; id?: number }) => {
            const url = data.isEdit ? `/api/closures/${data.id}` : '/api/closures';
            const payload = data.isEdit
                ? { ...data.form }
                : { ...data.form, created_by: actualUser?.email };
            return data.isEdit
                ? putWithCredentials(url, payload)
                : postWithCredentials(url, payload);
        },
        onSuccess: (data: any) => {
            setIsClosureModalOpen(false);
            resetClosureForm();
            queryClient.invalidateQueries({ queryKey: ['closures'] });

            if (data.warnings && data.warnings.length > 0) {
                showToast(
                    `Notice ${editingClosureId ? 'updated' : 'created'}, but: ${data.warnings.join(', ')}`,
                    'warning'
                );
            } else {
                showToast(
                    editingClosureId ? 'Notice updated successfully' : 'Notice created successfully',
                    'success'
                );
            }
        },
        onError: (error: any) => {
            showToast(error.message || 'Failed to save notice', 'error');
        }
    });

    const deleteClosureMutation = useMutation({
        mutationFn: (closureId: number) => deleteWithCredentials(`/api/closures/${closureId}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['closures'] });
            showToast('Notice deleted', 'success');
        },
        onError: (error: any) => {
            showToast(error.message || 'Failed to delete notice', 'error');
        }
    });

    const syncClosuresMutation = useMutation({
        mutationFn: async () => {
            await postWithCredentials('/api/closures/sync', {});
            // Then fetch updated closures
            return queryClient.refetchQueries({ queryKey: ['closures'] });
        },
        onSuccess: () => {
            showToast('Calendar synced & notices refreshed', 'success');
        },
        onError: (error: any) => {
            console.error('Calendar sync failed:', error);
            showToast('Failed to sync calendar', 'error');
        }
    });

    useEffect(() => {
        const handleOpenNewClosure = () => {
            resetClosureForm();
            setIsClosureModalOpen(true);
        };
        window.addEventListener('open-new-closure', handleOpenNewClosure);
        return () => window.removeEventListener('open-new-closure', handleOpenNewClosure);
    }, []);

    const resetClosureForm = () => {
        setClosureForm({
            start_date: '',
            start_time: '',
            end_date: '',
            end_time: '',
            affected_areas: 'entire_facility',
            visibility: '',
            reason: '',
            member_notice: '',
            notes: '',
            title: '',
            notice_type: '',
            notify_members: false
        });
        setEditingClosureId(null);
        setTouchedFields(new Set());
    };

    const handleSaveClosure = () => {
        if (!closureForm.start_date || !closureForm.affected_areas || !closureForm.visibility?.trim()) return;
        saveClosureMutation.mutate({ form: closureForm, isEdit: !!editingClosureId, id: editingClosureId || undefined });
    };

    const handleEditClosure = (closure: BlocksClosure, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        setEditingClosureId(closure.id);
        setClosureForm({
            start_date: closure.startDate,
            start_time: closure.startTime || '',
            end_date: closure.endDate,
            end_time: closure.endTime || '',
            affected_areas: closure.affectedAreas || 'entire_facility',
            visibility: closure.visibility || '',
            reason: closure.reason || '',
            member_notice: closure.memberNotice || '',
            notes: stripHtml(closure.notes),
            title: closure.title || '',
            notice_type: closure.noticeType || '',
            notify_members: closure.notifyMembers ?? false
        });
        setIsClosureModalOpen(true);
    };

    const handleDeleteClosure = async (closureId: number, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        const confirmed = await confirm({
            title: 'Delete Notice',
            message: 'Are you sure you want to delete this notice? This will also remove the calendar event and announcement.',
            confirmText: 'Delete',
            variant: 'danger'
        });
        if (!confirmed) return;
        deleteClosureMutation.mutate(closureId);
    };

    const openNewClosure = () => {
        resetClosureForm();
        setIsClosureModalOpen(true);
    };

    const handlePullRefresh = () => {
        syncClosuresMutation.mutate();
    };

    const toggleNoticeExpand = (closureId: number) => {
        setExpandedNotices(prev => {
            const newSet = new Set(prev);
            if (newSet.has(closureId)) {
                newSet.delete(closureId);
            } else {
                newSet.add(closureId);
            }
            return newSet;
        });
    };

    const formatDate = (dateStr: string) => {
        if (!dateStr) return 'No Date';
        const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
        return formatDateDisplayWithDay(datePart);
    };

    const formatTime = (time: string) => {
        if (!time) return '';
        const [hours, minutes] = time.split(':').map(Number);
        const period = hours >= 12 ? 'PM' : 'AM';
        const hours12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
        return `${hours12}:${minutes.toString().padStart(2, '0')} ${period}`;
    };

    const bays = resources.filter(r => r.type === 'simulator');
    const conferenceRoom = resources.find(r => r.type === 'conference_room');

    const formatAffectedAreas = (areas: string | null) => {
        if (!areas) return 'Unknown';
        if (areas === 'entire_facility') return 'Entire Facility';
        if (areas === 'all_bays') return 'All Bays';
        if (areas === 'conference_room') return 'Conference Room';
        if (areas === 'none') return 'No booking restrictions';
        
        const areaList = areas.split(',').map(a => a.trim());
        const formatted = areaList.map(area => {
            if (area === 'entire_facility') return 'Entire Facility';
            if (area === 'all_bays') return 'All Bays';
            if (area === 'conference_room') return 'Conference Room';
            if (area === 'Conference Room') return 'Conference Room';
            if (area === 'none') return 'No booking restrictions';
            if (area.startsWith('bay_')) {
                const areaId = parseInt(area.replace('bay_', ''));
                const bay = bays.find(b => b.id === areaId);
                return bay ? bay.name : area;
            }
            return area;
        });
        return formatted.join(', ');
    };

    const isBlocking = (areas: string | null): boolean => {
        return areas !== 'none' && areas !== '' && areas !== null;
    };

    const getAffectedAreasList = (areas: string | null): string[] => {
        if (!areas || areas === 'none') return [];
        if (areas === 'entire_facility') {
            const allResources: string[] = [];
            bays.forEach(b => allResources.push(b.name));
            if (conferenceRoom) allResources.push('Conference Room');
            return allResources.length > 0 ? allResources : ['Entire Facility'];
        }
        if (areas === 'all_bays') {
            return bays.map(b => b.name);
        }
        if (areas === 'conference_room') return ['Conference Room'];
        
        const areaList = areas.split(',').map(a => a.trim());
        return areaList.map(area => {
            if (area === 'entire_facility') return 'Entire Facility';
            if (area === 'all_bays') return 'All Bays';
            if (area === 'conference_room' || area === 'Conference Room') return 'Conference Room';
            if (area.startsWith('bay_')) {
                const areaId = parseInt(area.replace('bay_', ''));
                const bay = bays.find(b => b.id === areaId);
                return bay ? bay.name : `Bay ${areaId}`;
            }
            return area;
        });
    };

    const filteredClosures = useMemo(() => {
        return closures.filter(closure => {
            if (closuresFilterDate) {
                const startNorm = closure.startDate.split('T')[0];
                const endNorm = (closure.endDate || closure.startDate).split('T')[0];
                if (closuresFilterDate < startNorm || closuresFilterDate > endNorm) return false;
            }
            
            if (closuresFilterResource !== 'all') {
                const areas = closure.affectedAreas || '';
                
                if (closuresFilterResource === 'entire_facility') {
                    if (areas !== 'entire_facility') return false;
                } else if (closuresFilterResource === 'none') {
                    if (areas !== 'none') return false;
                } else if (closuresFilterResource === 'conference_room') {
                    const areaList = areas.split(',').map(a => a.trim());
                    const matchesConf = areas === 'entire_facility' || 
                        areas === 'conference_room' ||
                        areaList.includes('conference_room') ||
                        areaList.includes('Conference Room');
                    if (!matchesConf) return false;
                } else if (closuresFilterResource.startsWith('bay_')) {
                    const areaList = areas.split(',').map(a => a.trim());
                    const matchesBay = areas === 'entire_facility' || 
                        areas === 'all_bays' ||
                        areaList.includes(closuresFilterResource);
                    if (!matchesBay) return false;
                }
            }
            
            return true;
        }).sort((a, b) => {
            const aStart = a.startDate.split('T')[0];
            const bStart = b.startDate.split('T')[0];
            return aStart.localeCompare(bStart);
        });
    }, [closures, closuresFilterDate, closuresFilterResource]);

    const { upcomingClosures, pastClosures } = useMemo(() => {
        const today = getTodayPacific();
        const upcoming: BlocksClosure[] = [];
        const past: BlocksClosure[] = [];
        
        for (const closure of filteredClosures) {
            if (closure.needsReview) continue;
            const endDateStr = closure.endDate || closure.startDate;
            const endDateNormalized = endDateStr.split('T')[0];
            if (endDateNormalized < today) {
                past.push(closure);
            } else {
                upcoming.push(closure);
            }
        }
        
        past.sort((a, b) => {
            const aStart = a.startDate.split('T')[0];
            const bStart = b.startDate.split('T')[0];
            return bStart.localeCompare(aStart);
        });
        
        return { upcomingClosures: upcoming, pastClosures: past };
    }, [filteredClosures]);

    const getMissingFields = (closure: BlocksClosure): string[] => {
        const missing: string[] = [];
        if (!closure.noticeType || closure.noticeType.trim() === '') {
            missing.push('Notice type');
        }
        if (!closure.affectedAreas || closure.affectedAreas === 'none' || closure.affectedAreas === '') {
            missing.push('Affected areas');
        }
        if (!closure.visibility || closure.visibility.trim() === '') {
            missing.push('Visibility');
        }
        return missing;
    };

    const needsReviewClosures = useMemo(() => {
        const today = getTodayPacific();
        return closures.filter(closure => {
            if (!closure.needsReview) return false;
            const endDateStr = closure.endDate || closure.startDate;
            const endDateNormalized = endDateStr.split('T')[0];
            return endDateNormalized >= today;
        }).sort((a, b) => {
            const aStart = a.startDate.split('T')[0];
            const bStart = b.startDate.split('T')[0];
            return aStart.localeCompare(bStart);
        });
    }, [closures]);

    const configuredClosures = upcomingClosures;

    if (isLoading && closuresLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
            </div>
        );
    }

    return (
        <PullToRefresh onRefresh={handlePullRefresh}>
        <AnimatedPage className="space-y-6">
            <div className="flex gap-2 mb-4 animate-content-enter-delay-1">
                <button
                    onClick={() => setActiveSubTab('notices')}
                    className={`flex-1 py-2.5 px-3 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-1.5 ${
                        activeSubTab === 'notices'
                            ? 'bg-amber-500 text-white shadow-md'
                            : 'bg-white dark:bg-white/10 text-gray-600 dark:text-white/80 border border-gray-200 dark:border-white/25'
                    }`}
                >
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">notifications</span>
                    Notices
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

            <div key={activeSubTab} className="animate-content-enter">
            {activeSubTab === 'blocks' && <AvailabilityBlocksContent />}

            {activeSubTab === 'notices' && (
            <>
            <p className="text-sm text-primary/80 dark:text-white/80 mb-4">
                Synced from Google Calendar: <span className="font-medium">Internal Calendar</span>
            </p>

            <div className="flex gap-2 items-center animate-slide-up-stagger overflow-x-auto" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                <select
                    value={closuresFilterResource}
                    onChange={(e) => setClosuresFilterResource(e.target.value)}
                    className="px-2 py-2 rounded-xl bg-gray-100 dark:bg-white/10 border border-gray-300 dark:border-white/20 text-primary dark:text-white text-sm flex-shrink-0"
                >
                    <option value="all">All</option>
                    <option value="entire_facility">Entire Facility</option>
                    <option value="none">Informational Only</option>
                    {bays.map(bay => (
                        <option key={bay.id} value={`bay_${bay.id}`}>{bay.name}</option>
                    ))}
                    {conferenceRoom && (
                        <option value="conference_room">{conferenceRoom.name}</option>
                    )}
                </select>
                
                <input
                    type="date"
                    value={closuresFilterDate}
                    onChange={(e) => setClosuresFilterDate(e.target.value)}
                    placeholder="Filter date"
                    className="px-2 py-2 rounded-xl bg-gray-100 dark:bg-white/10 border border-gray-300 dark:border-white/20 text-primary dark:text-white text-sm flex-shrink-0 w-[130px] [&::-webkit-datetime-edit-text]:text-gray-400 [&::-webkit-datetime-edit-month-field]:text-gray-400 [&::-webkit-datetime-edit-day-field]:text-gray-400 [&::-webkit-datetime-edit-year-field]:text-gray-400 [&:not(:valid)]:text-gray-400"
                />
                {closuresFilterDate && (
                    <button
                        onClick={() => setClosuresFilterDate('')}
                        className="px-2 py-2 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70 text-sm hover:bg-gray-200 dark:hover:bg-white/20 flex-shrink-0"
                    >
                        Clear
                    </button>
                )}
            </div>

            <div className="flex items-center gap-3 text-xs my-4">
                <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-full bg-red-500"></span>
                    <span className="text-gray-600 dark:text-white/70">Blocks bookings</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-full bg-amber-500"></span>
                    <span className="text-gray-600 dark:text-white/70">Informational</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-full bg-cyan-500"></span>
                    <span className="text-gray-600 dark:text-white/70">Draft</span>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <div className="rounded-2xl border border-gray-200 dark:border-white/20 overflow-hidden">
                <button
                    onClick={() => setShowClosureReasonsSection(!showClosureReasonsSection)}
                    className="w-full flex items-center justify-between p-4 bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                >
                    <div className="flex items-center gap-2">
                        <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">settings</span>
                        <span className="font-semibold text-primary dark:text-white">Closure Reasons</span>
                        <span className="text-xs bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 px-2 py-0.5 rounded-full">
                            {closureReasons.filter(r => r.isActive).length}
                        </span>
                    </div>
                    <span aria-hidden="true" className={`material-symbols-outlined text-gray-400 transition-transform ${showClosureReasonsSection ? 'rotate-180' : ''}`}>
                        expand_more
                    </span>
                </button>
                
                {showClosureReasonsSection && (
                    <div className="p-4 space-y-4 bg-white dark:bg-black/20">
                        <p className="text-xs text-gray-500 dark:text-white/60">
                            Manage the dropdown options shown when creating closures. Lower sort order appears first.
                        </p>
                        
                        <div className="flex flex-col sm:flex-row gap-2">
                            <input
                                type="text"
                                value={newReasonLabel}
                                onChange={(e) => setNewReasonLabel(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddClosureReason()}
                                placeholder="Add new reason..."
                                className="flex-1 px-3 py-2 rounded-xl bg-gray-100 dark:bg-white/10 border border-gray-300 dark:border-white/20 text-primary dark:text-white text-sm placeholder:text-gray-400 dark:placeholder:text-white/40 focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                            />
                            <button
                                onClick={handleAddClosureReason}
                                disabled={!newReasonLabel.trim() || addClosureReasonMutation.isPending}
                                className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-1.5"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-base">add</span>
                                Add
                            </button>
                        </div>
                        
                        <div className="space-y-2">
                            {closureReasons.filter(r => r.isActive).map((reason) => (
                                <div 
                                    key={reason.id}
                                    className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10"
                                >
                                    <span className="w-8 text-center text-xs text-gray-400 dark:text-white/40 tabular-nums">{reason.sortOrder}</span>
                                    <span className="flex-1 text-sm text-primary dark:text-white font-medium truncate">{reason.label}</span>
                                    <div className="flex gap-2 flex-shrink-0">
                                        <button
                                            onClick={() => openReasonDrawer(reason)}
                                            className="p-1.5 rounded-lg bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 hover:bg-gray-300 dark:hover:bg-white/30 transition-colors"
                                            title="Edit"
                                        >
                                            <span aria-hidden="true" className="material-symbols-outlined text-base">edit</span>
                                        </button>
                                        <button
                                            onClick={() => handleDeleteClosureReason(reason.id)}
                                            className="p-1.5 rounded-lg bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30 transition-colors"
                                            title="Delete"
                                        >
                                            <span aria-hidden="true" className="material-symbols-outlined text-base">delete</span>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        
                        {closureReasons.filter(r => !r.isActive).length > 0 && (
                            <div className="pt-4 border-t border-gray-200 dark:border-white/20">
                                <p className="text-xs text-gray-500 dark:text-white/60 mb-2">Inactive Reasons</p>
                                <div className="space-y-2">
                                    {closureReasons.filter(r => !r.isActive).map((reason) => (
                                        <div 
                                            key={reason.id}
                                            className="flex items-center gap-2 p-3 bg-gray-100 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10 opacity-60"
                                        >
                                            <span className="flex-1 text-sm text-gray-500 dark:text-white/50 line-through">{reason.label}</span>
                                            <button
                                                onClick={() => handleReactivateClosureReason(reason.id)}
                                                className="px-3 py-1.5 rounded-lg bg-green-100 dark:bg-green-500/20 text-green-600 dark:text-green-400 text-xs font-medium hover:bg-green-200 dark:hover:bg-green-500/30 transition-colors"
                                            >
                                                Reactivate
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="rounded-2xl border border-gray-200 dark:border-white/20 overflow-hidden">
                <button
                    onClick={() => setShowNoticeTypesSection(!showNoticeTypesSection)}
                    className="w-full flex items-center justify-between p-4 bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                >
                    <div className="flex items-center gap-2">
                        <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">category</span>
                        <span className="font-semibold text-primary dark:text-white">Notice Types</span>
                        <span className="text-xs bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 px-2 py-0.5 rounded-full">
                            {noticeTypes.length}
                        </span>
                    </div>
                    <span aria-hidden="true" className={`material-symbols-outlined text-gray-400 transition-transform ${showNoticeTypesSection ? 'rotate-180' : ''}`}>
                        expand_more
                    </span>
                </button>
                
                {showNoticeTypesSection && (
                    <div className="p-4 space-y-4 bg-white dark:bg-black/20">
                        <p className="text-xs text-gray-500 dark:text-white/60">
                            Manage notice categories used when creating closures. Preset types cannot be edited or deleted.
                        </p>
                        
                        <div className="flex flex-col sm:flex-row gap-2">
                            <input
                                type="text"
                                value={newNoticeTypeName}
                                onChange={(e) => setNewNoticeTypeName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddNoticeType()}
                                placeholder="Add new notice type..."
                                className="flex-1 px-3 py-2 rounded-xl bg-gray-100 dark:bg-white/10 border border-gray-300 dark:border-white/20 text-primary dark:text-white text-sm placeholder:text-gray-400 dark:placeholder:text-white/40 focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                            />
                            <button
                                onClick={handleAddNoticeType}
                                disabled={!newNoticeTypeName.trim() || addNoticeTypeMutation.isPending}
                                className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-1.5"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-base">add</span>
                                Add
                            </button>
                        </div>
                        
                        <div className="space-y-2">
                            {noticeTypes.map((noticeType) => (
                                <div 
                                    key={noticeType.id}
                                    className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10"
                                >
                                    <span className="w-8 text-center text-xs text-gray-400 dark:text-white/40 tabular-nums">{noticeType.sortOrder}</span>
                                    <span className="flex-1 text-sm text-primary dark:text-white font-medium truncate">{noticeType.name}</span>
                                    {noticeType.isPreset && (
                                        <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex-shrink-0">
                                            Preset
                                        </span>
                                    )}
                                    {!noticeType.isPreset && (
                                        <div className="flex gap-2 flex-shrink-0">
                                            <button
                                                onClick={() => openNoticeTypeDrawer(noticeType)}
                                                className="p-1.5 rounded-lg bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 hover:bg-gray-300 dark:hover:bg-white/30 transition-colors"
                                                title="Edit"
                                            >
                                                <span aria-hidden="true" className="material-symbols-outlined text-base">edit</span>
                                            </button>
                                            <button
                                                onClick={() => handleDeleteNoticeType(noticeType.id)}
                                                className="p-1.5 rounded-lg bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30 transition-colors"
                                                title="Delete"
                                            >
                                                <span aria-hidden="true" className="material-symbols-outlined text-base">delete</span>
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                            {noticeTypes.length === 0 && (
                                <p className="text-sm text-gray-500 dark:text-white/50 text-center py-4">
                                    No notice types yet. Add one above or wait for preset types to be seeded.
                                </p>
                            )}
                        </div>
                    </div>
                )}
            </div>
            </div>

            {needsReviewClosures.length > 0 && (
                <div className="space-y-3 animate-slide-up-stagger" style={{ '--stagger-index': 1 } as React.CSSProperties}>
                    <div className="flex items-center gap-2">
                        <span aria-hidden="true" className="material-symbols-outlined text-cyan-500">rate_review</span>
                        <h3 className="font-semibold text-primary dark:text-white">Needs Review</h3>
                        <span className="text-xs bg-cyan-100 dark:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 px-2 py-0.5 rounded-full">{needsReviewClosures.length}</span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-white/60">
                        These calendar events were imported and need to be configured before members can see them.
                    </p>
                    <div className="space-y-2">
                        {needsReviewClosures.map((closure, index) => {
                            const missingFields = getMissingFields(closure);
                            return (
                                <div 
                                    key={closure.id}
                                    className="rounded-2xl overflow-hidden bg-cyan-50 dark:bg-cyan-500/10 border border-cyan-200 dark:border-cyan-500/30 animate-slide-up-stagger"
                                    style={{ '--stagger-index': index } as React.CSSProperties}
                                >
                                    <div className="p-4 flex items-start justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5 mb-1">
                                                <span className="w-2 h-2 rounded-full bg-cyan-500 flex-shrink-0"></span>
                                                <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-cyan-200 dark:bg-cyan-500/30 text-cyan-700 dark:text-cyan-300">
                                                    Draft
                                                </span>
                                            </div>
                                            <h4 className="font-bold text-primary dark:text-white truncate">{closure.title}</h4>
                                            <div className="flex items-center gap-1 text-xs text-cyan-600 dark:text-cyan-400 mt-1">
                                                <span aria-hidden="true" className="material-symbols-outlined text-[12px]">calendar_today</span>
                                                <span>{formatDate(closure.startDate)}{closure.startDate !== closure.endDate ? ` - ${formatDate(closure.endDate)}` : ''}</span>
                                            </div>
                                            {missingFields.length > 0 && (
                                                <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-600 dark:text-amber-400">
                                                    <span aria-hidden="true" className="material-symbols-outlined text-[14px]">warning</span>
                                                    <span>Missing: {missingFields.join(', ')}</span>
                                                </div>
                                            )}
                                        </div>
                                        <button
                                            onClick={(e) => handleEditClosure(closure, e)}
                                            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-cyan-500 text-white text-sm font-medium hover:bg-cyan-600 active:scale-95 transition-all flex-shrink-0"
                                        >
                                            <span aria-hidden="true" className="material-symbols-outlined text-base">edit</span>
                                            Edit
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {closuresLoading ? (
                <div className="text-center py-8 text-gray-600 dark:text-white/70">Loading notices...</div>
            ) : configuredClosures.length === 0 && needsReviewClosures.length === 0 ? (
                <div className="text-center py-12 text-gray-600 dark:text-white/70">
                    <span aria-hidden="true" className="material-symbols-outlined text-4xl mb-2">event_available</span>
                    <p>{closures.length === 0 ? 'No notices' : 'No notices match filters'}</p>
                </div>
            ) : configuredClosures.length > 0 && (
                <div className="space-y-3">
                    {configuredClosures.map((closure, index) => {
                        const blocking = isBlocking(closure.affectedAreas);
                        const isExpanded = expandedNotices.has(closure.id);
                        
                        return (
                            <div 
                                key={closure.id} 
                                className={`rounded-2xl overflow-hidden transition-all animate-pop-in ${
                                    blocking 
                                        ? 'bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30'
                                        : 'bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30'
                                }`}
                                style={{ '--stagger-index': index } as React.CSSProperties}
                            >
                                <div
                                    className={`w-full p-4 text-left transition-colors ${
                                        blocking 
                                            ? 'hover:bg-red-100 dark:hover:bg-red-500/20'
                                            : 'hover:bg-amber-100 dark:hover:bg-amber-500/20'
                                    }`}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div 
                                            className="flex-1 min-w-0 cursor-pointer"
                                            onClick={() => toggleNoticeExpand(closure.id)}
                                        >
                                            <div className="flex flex-wrap items-center gap-1.5 mb-1">
                                                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${blocking ? 'bg-red-500' : 'bg-amber-500'}`}></span>
                                                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                                    blocking 
                                                        ? 'bg-red-200 dark:bg-red-500/30 text-red-700 dark:text-red-300'
                                                        : 'bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300'
                                                }`}>
                                                    {blocking 
                                                        ? (closure.noticeType || 'Closure')
                                                        : (closure.noticeType && closure.noticeType.toLowerCase() !== 'closure' ? closure.noticeType : 'Notice')
                                                    }
                                                </span>
                                                {closure.reason && closure.reason.trim() && (
                                                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                                        blocking 
                                                            ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                                                            : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                    }`}>
                                                        {closure.reason}
                                                    </span>
                                                )}
                                            </div>
                                            <h4 className="font-bold text-primary dark:text-white mb-1 truncate">{closure.title.replace(/^\[[^\]]+\]\s*:?\s*/i, '')}</h4>
                                            {closure.notes && (
                                                <p className="text-sm text-gray-600 dark:text-white/70 mb-2 line-clamp-2">{stripHtml(closure.notes)}</p>
                                            )}
                                            <div className="flex flex-wrap gap-2">
                                                <div className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
                                                    blocking 
                                                        ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                                                        : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                }`}>
                                                    <span aria-hidden="true" className="material-symbols-outlined text-[12px]">calendar_today</span>
                                                    <span>
                                                        {formatDate(closure.startDate)}
                                                        {closure.endDate && closure.endDate !== closure.startDate ? ` - ${formatDate(closure.endDate)}` : ''}
                                                    </span>
                                                </div>
                                                {(closure.startTime || closure.endTime) && (
                                                    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
                                                        blocking 
                                                            ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                                                            : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                    }`}>
                                                        <span aria-hidden="true" className="material-symbols-outlined text-[12px]">schedule</span>
                                                        <span>{formatTime(closure.startTime || '')}{closure.endTime ? ` - ${formatTime(closure.endTime)}` : ''}</span>
                                                    </div>
                                                )}
                                                {blocking && closure.affectedAreas && (
                                                    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400`}>
                                                        <span aria-hidden="true" className="material-symbols-outlined text-[12px]">block</span>
                                                        <span>{formatAffectedAreas(closure.affectedAreas)}</span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 flex-shrink-0">
                                            <button
                                                onClick={(e) => handleEditClosure(closure, e)}
                                                className={`p-2 rounded-xl transition-all ${
                                                    blocking 
                                                        ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30'
                                                        : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-500/30'
                                                }`}
                                            >
                                                <span aria-hidden="true" className="material-symbols-outlined text-lg">edit</span>
                                            </button>
                                            <button
                                                onClick={() => toggleNoticeExpand(closure.id)}
                                                className="p-1"
                                            >
                                                <span aria-hidden="true" className={`material-symbols-outlined text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                                                    expand_more
                                                </span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                                
                                {isExpanded && (
                                    <div className={`border-t ${blocking ? 'border-red-200 dark:border-red-500/30' : 'border-amber-200 dark:border-amber-500/30'}`}>
                                        <div className="p-4 space-y-3">
                                            {closure.memberNotice && (
                                                <div>
                                                    <p className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1">Note to Members</p>
                                                    <p className="text-sm text-gray-600 dark:text-white/80 whitespace-pre-wrap">{closure.memberNotice}</p>
                                                </div>
                                            )}
                                            
                                            {closure.notes && (
                                                <div>
                                                    <p className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1">Staff Notes</p>
                                                    <p className="text-sm text-gray-600 dark:text-white/80 whitespace-pre-wrap">{stripHtml(closure.notes)}</p>
                                                </div>
                                            )}
                                            
                                            {blocking && (
                                                <div>
                                                    <p className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-2">Affected Resources</p>
                                                    <div className="flex flex-wrap gap-2">
                                                        {getAffectedAreasList(closure.affectedAreas).map((area, idx) => (
                                                            <div 
                                                                key={idx} 
                                                                className="flex items-center gap-2 px-3 py-2 bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400 rounded-lg text-sm"
                                                            >
                                                                <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                                                                    {area.includes('Bay') ? 'sports_golf' : area.includes('Conference') ? 'meeting_room' : 'block'}
                                                                </span>
                                                                <span>{area}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            
                                            <div className="flex gap-2 pt-2">
                                                <button
                                                    onClick={(e) => handleEditClosure(closure, e)}
                                                    className={`flex-1 py-2 px-4 rounded-xl font-medium transition-all ${
                                                        blocking 
                                                            ? 'bg-red-500 text-white hover:bg-red-600'
                                                            : 'bg-amber-500 text-white hover:bg-amber-600'
                                                    }`}
                                                >
                                                    Edit Notice
                                                </button>
                                                <button
                                                    onClick={(e) => handleDeleteClosure(closure.id, e)}
                                                    className="py-2 px-4 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70 hover:bg-gray-200 dark:hover:bg-white/20 transition-all"
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {pastClosures.length > 0 && (
                <div className="mt-6 rounded-2xl border border-gray-200 dark:border-white/20 overflow-hidden">
                    <button
                        onClick={() => setShowPastAccordion(!showPastAccordion)}
                        className="w-full flex items-center justify-between p-4 bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                    >
                        <div className="flex items-center gap-2">
                            <span aria-hidden="true" className="material-symbols-outlined text-gray-500 dark:text-white/60">history</span>
                            <span className="font-semibold text-gray-600 dark:text-white/80">Past Notices</span>
                            <span className="text-xs bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 px-2 py-0.5 rounded-full">
                                {pastClosures.length}
                            </span>
                        </div>
                        <span aria-hidden="true" className={`material-symbols-outlined text-gray-400 transition-transform ${showPastAccordion ? 'rotate-180' : ''}`}>
                            expand_more
                        </span>
                    </button>
                    
                    {showPastAccordion && (
                        <div className="p-4 space-y-3 bg-gray-50/50 dark:bg-black/20">
                            {pastClosures.map((closure, index) => {
                                const blocking = isBlocking(closure.affectedAreas);
                                const isExpanded = expandedNotices.has(closure.id);
                                
                                return (
                                    <div 
                                        key={closure.id} 
                                        className={`rounded-xl overflow-hidden transition-all opacity-70 hover:opacity-100 ${
                                            blocking 
                                                ? 'bg-red-50 dark:bg-red-500/10 border border-red-200/60 dark:border-red-500/20'
                                                : 'bg-amber-50 dark:bg-amber-500/10 border border-amber-200/60 dark:border-amber-500/20'
                                        }`}
                                    >
                                        <div className="p-3">
                                            <div className="flex items-start justify-between gap-2">
                                                <div 
                                                    className="flex-1 min-w-0 cursor-pointer"
                                                    onClick={() => toggleNoticeExpand(closure.id)}
                                                >
                                                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                                                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${blocking ? 'bg-red-400' : 'bg-amber-400'}`}></span>
                                                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                                            blocking 
                                                                ? 'bg-red-200/60 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                                                                : 'bg-amber-200/60 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                        }`}>
                                                            {blocking 
                                                                ? (closure.noticeType || 'Closure')
                                                                : (closure.noticeType && closure.noticeType.toLowerCase() !== 'closure' ? closure.noticeType : 'Notice')
                                                            }
                                                        </span>
                                                    </div>
                                                    <h4 className="font-medium text-sm text-gray-600 dark:text-white/70 mb-1 truncate">{closure.title.replace(/^\[[^\]]+\]\s*:?\s*/i, '')}</h4>
                                                    {closure.notes && (
                                                        <p className="text-xs text-gray-500 dark:text-white/50 mb-1 line-clamp-1">{stripHtml(closure.notes)}</p>
                                                    )}
                                                    <div className="flex flex-wrap gap-1.5">
                                                        <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${
                                                            blocking 
                                                                ? 'bg-red-100/60 dark:bg-red-500/15 text-red-500 dark:text-red-400'
                                                                : 'bg-amber-100/60 dark:bg-amber-500/15 text-amber-500 dark:text-amber-400'
                                                        }`}>
                                                            <span aria-hidden="true" className="material-symbols-outlined text-[11px]">calendar_today</span>
                                                            <span>
                                                                {formatDate(closure.startDate)}
                                                                {closure.endDate && closure.endDate !== closure.startDate ? ` - ${formatDate(closure.endDate)}` : ''}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-1 flex-shrink-0">
                                                    <button
                                                        onClick={(e) => handleEditClosure(closure, e)}
                                                        className="p-1.5 rounded-lg bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/50 hover:bg-gray-200 dark:hover:bg-white/20 transition-all"
                                                    >
                                                        <span aria-hidden="true" className="material-symbols-outlined text-base">edit</span>
                                                    </button>
                                                    <button
                                                        onClick={() => toggleNoticeExpand(closure.id)}
                                                        className="p-1"
                                                    >
                                                        <span aria-hidden="true" className={`material-symbols-outlined text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                                                            expand_more
                                                        </span>
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                        
                                        {isExpanded && (
                                            <div className={`border-t p-3 ${blocking ? 'border-red-200/40 dark:border-red-500/20' : 'border-amber-200/40 dark:border-amber-500/20'}`}>
                                                <div className="flex gap-2">
                                                    <button
                                                        onClick={(e) => handleEditClosure(closure, e)}
                                                        className="flex-1 py-2 px-3 rounded-lg bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-white/70 text-sm font-medium hover:bg-gray-300 dark:hover:bg-white/20 transition-all"
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        onClick={(e) => handleDeleteClosure(closure.id, e)}
                                                        className="py-2 px-3 rounded-lg bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-white/50 text-sm hover:bg-gray-200 dark:hover:bg-white/10 transition-all"
                                                    >
                                                        Delete
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            <SlideUpDrawer 
                isOpen={isClosureModalOpen} 
                onClose={() => { setIsClosureModalOpen(false); resetClosureForm(); }} 
                title={editingClosureId ? 'Edit Notice' : 'New Notice'}
                maxHeight="large"
                stickyFooter={
                    <div className="flex gap-3 p-4">
                        <button 
                            onClick={() => { setIsClosureModalOpen(false); resetClosureForm(); }}
                            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={handleSaveClosure}
                            disabled={!closureForm.start_date || saveClosureMutation.isPending || !isClosureFormValid}
                            className={`flex-1 py-3 rounded-xl font-medium text-white transition-colors ${
                                isBlocking(closureForm.affected_areas)
                                    ? 'bg-red-500 hover:bg-red-600 disabled:bg-red-300'
                                    : 'bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300'
                            }`}
                        >
                            {saveClosureMutation.isPending ? 'Saving...' : editingClosureId ? 'Update' : 'Create'}
                        </button>
                    </div>
                }
            >
                <div className="p-5 space-y-4">
                    <div className="space-y-3">
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Reason Category *</label>
                            <select
                                value={closureForm.notice_type}
                                onChange={e => setClosureForm({...closureForm, notice_type: e.target.value})}
                                onBlur={() => markTouched('notice_type')}
                                className={`w-full border bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all ${
                                    touchedFields.has('notice_type') && closureValidation.notice_type 
                                        ? 'border-red-500 dark:border-red-500' 
                                        : 'border-gray-200 dark:border-white/20'
                                }`}
                            >
                                <option value="">Select category...</option>
                                {noticeTypes.map(type => (
                                    <option key={type.id} value={type.name}>{type.name}</option>
                                ))}
                            </select>
                            {touchedFields.has('notice_type') && closureValidation.notice_type && (
                                <p className="text-xs text-red-500 mt-1">Reason category is required</p>
                            )}
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Syncs with Google Calendar bracket prefix
                            </p>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Title <span className="text-[9px] font-normal normal-case text-gray-400 dark:text-gray-500">(internal only)</span></label>
                            <input 
                                type="text" 
                                placeholder="e.g., Holiday Closure, Maintenance" 
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                value={closureForm.title} 
                                onChange={e => setClosureForm({...closureForm, title: e.target.value})} 
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Closure Reason</label>
                            <select
                                value={closureForm.reason}
                                onChange={e => setClosureForm({...closureForm, reason: e.target.value})}
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                            >
                                <option value="">Select reason...</option>
                                {closureReasons.filter(r => r.isActive).map(reason => (
                                    <option key={reason.id} value={reason.label}>{reason.label}</option>
                                ))}
                            </select>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Shown as a badge to members. Manage options in "Closure Reasons" section above.
                            </p>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Notes</label>
                            <textarea 
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all resize-none" 
                                placeholder="Internal notes, event details, logistics..." 
                                rows={3} 
                                value={closureForm.notes} 
                                onChange={e => setClosureForm({...closureForm, notes: e.target.value})} 
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Syncs with Google Calendar event description
                            </p>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-2 block">Affected Resources *</label>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500"></span> Selecting resources will block bookings (red card)</span>
                                <br />
                                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500"></span> "None" is for announcements only (amber card)</span>
                            </p>
                            <div className="space-y-2 p-3 bg-gray-50 dark:bg-black/20 rounded-xl border border-gray-200 dark:border-white/25">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input 
                                        type="checkbox" 
                                        checked={closureForm.affected_areas === 'none' || closureForm.affected_areas === ''}
                                        onChange={(e) => {
                                            if (e.target.checked) {
                                                setClosureForm({...closureForm, affected_areas: 'none'});
                                            }
                                        }}
                                        className="w-4 h-4 rounded border-gray-300 text-amber-500 focus:ring-amber-500"
                                    />
                                    <span className="text-sm text-primary dark:text-white">None (informational only)</span>
                                </label>
                                <div className="border-t border-gray-200 dark:border-white/25 my-2"></div>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input 
                                        type="checkbox" 
                                        checked={closureForm.affected_areas === 'entire_facility'}
                                        onChange={(e) => {
                                            if (e.target.checked) {
                                                setClosureForm({...closureForm, affected_areas: 'entire_facility'});
                                            } else {
                                                setClosureForm({...closureForm, affected_areas: 'none'});
                                            }
                                        }}
                                        className="w-4 h-4 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                    />
                                    <span className="text-sm text-primary dark:text-white font-medium">Entire Facility</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input 
                                        type="checkbox" 
                                        checked={closureForm.affected_areas.split(',').some(a => a.trim() === 'conference_room')}
                                        onChange={(e) => {
                                            const currentSet = new Set(closureForm.affected_areas.split(',').map(a => a.trim()).filter(a => a && a !== 'none' && a !== 'entire_facility'));
                                            if (e.target.checked) {
                                                currentSet.add('conference_room');
                                            } else {
                                                currentSet.delete('conference_room');
                                            }
                                            setClosureForm({...closureForm, affected_areas: currentSet.size > 0 ? Array.from(currentSet).join(',') : 'none'});
                                        }}
                                        className="w-4 h-4 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                    />
                                    <span className="text-sm text-primary dark:text-white">Conference Room</span>
                                </label>
                                {bays.map(bay => (
                                    <label key={bay.id} className="flex items-center gap-2 cursor-pointer">
                                        <input 
                                            type="checkbox" 
                                            checked={closureForm.affected_areas.split(',').some(a => a.trim() === `bay_${bay.id}`)}
                                            onChange={(e) => {
                                                const currentSet = new Set(closureForm.affected_areas.split(',').map(a => a.trim()).filter(a => a && a !== 'none' && a !== 'entire_facility'));
                                                if (e.target.checked) {
                                                    currentSet.add(`bay_${bay.id}`);
                                                } else {
                                                    currentSet.delete(`bay_${bay.id}`);
                                                }
                                                setClosureForm({...closureForm, affected_areas: currentSet.size > 0 ? Array.from(currentSet).join(',') : 'none'});
                                            }}
                                            className="w-4 h-4 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                        />
                                        <span className="text-sm text-primary dark:text-white">{bay.name}</span>
                                    </label>
                                ))}
                            </div>
                            {closureForm.affected_areas && closureForm.affected_areas !== 'none' && closureForm.affected_areas !== 'entire_facility' && (
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                    Selected: {formatAffectedAreas(closureForm.affected_areas)}
                                </p>
                            )}
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Visibility *</label>
                            <select
                                value={closureForm.visibility}
                                onChange={e => setClosureForm({...closureForm, visibility: e.target.value})}
                                onBlur={() => markTouched('visibility')}
                                className={`w-full border bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all ${
                                    touchedFields.has('visibility') && closureValidation.visibility 
                                        ? 'border-red-500 dark:border-red-500' 
                                        : 'border-gray-200 dark:border-white/20'
                                }`}
                            >
                                <option value="">Select visibility...</option>
                                <option value="Public">Public</option>
                                <option value="Staff Only">Staff Only</option>
                                <option value="Private">Private</option>
                                <option value="Draft">Draft</option>
                            </select>
                            {touchedFields.has('visibility') && closureValidation.visibility && (
                                <p className="text-xs text-red-500 mt-1">Visibility is required</p>
                            )}
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Controls who can see this notice
                            </p>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-2 block">Member Visibility</label>
                            <div className="p-3 bg-gray-50 dark:bg-black/20 rounded-xl border border-gray-200 dark:border-white/25">
                                <label className={`flex items-center gap-3 ${closureForm.affected_areas !== 'none' ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}>
                                    <input 
                                        type="checkbox" 
                                        checked={closureForm.affected_areas !== 'none' || closureForm.notify_members}
                                        disabled={closureForm.affected_areas !== 'none'}
                                        onChange={(e) => {
                                            if (closureForm.affected_areas === 'none') {
                                                setClosureForm({...closureForm, notify_members: e.target.checked});
                                            }
                                        }}
                                        className="w-5 h-5 rounded border-gray-300 text-primary focus:ring-primary disabled:opacity-50"
                                    />
                                    <div>
                                        <span className="text-sm font-medium text-primary dark:text-white">Show to Members</span>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                            {closureForm.affected_areas !== 'none' 
                                                ? 'Always shown when bookings are affected'
                                                : 'Display this notice on member dashboard and updates'}
                                        </p>
                                    </div>
                                </label>
                            </div>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Start Date *</label>
                            <input 
                                type="date" 
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                value={closureForm.start_date} 
                                onChange={e => setClosureForm({...closureForm, start_date: e.target.value})} 
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Start Time</label>
                            <input 
                                type="time" 
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                value={closureForm.start_time} 
                                onChange={e => setClosureForm({...closureForm, start_time: e.target.value})} 
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">End Date</label>
                            <input 
                                type="date" 
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                value={closureForm.end_date} 
                                onChange={e => setClosureForm({...closureForm, end_date: e.target.value})} 
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">End Time</label>
                            <input 
                                type="time" 
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                value={closureForm.end_time} 
                                onChange={e => setClosureForm({...closureForm, end_time: e.target.value})} 
                            />
                        </div>
                    </div>
                </div>
            </SlideUpDrawer>

            <SlideUpDrawer
                isOpen={isReasonDrawerOpen}
                onClose={closeReasonDrawer}
                title="Edit Closure Reason"
                maxHeight="small"
                stickyFooter={
                    <div className="flex gap-3 p-4">
                        <button
                            onClick={closeReasonDrawer}
                            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSaveReasonFromDrawer}
                            disabled={!reasonDrawerData?.label?.trim() || updateClosureReasonMutation.isPending}
                            className="flex-1 py-3 rounded-xl font-medium text-white bg-primary hover:bg-primary/90 disabled:bg-primary/50 transition-colors"
                        >
                            {updateClosureReasonMutation.isPending ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                }
            >
                <div className="p-5 space-y-4">
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Label *</label>
                        <input
                            type="text"
                            value={reasonDrawerData?.label || ''}
                            onChange={(e) => setReasonDrawerData(prev => prev ? { ...prev, label: e.target.value } : null)}
                            placeholder="e.g., Private Event, Maintenance"
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Sort Order</label>
                        <input
                            type="number"
                            value={reasonDrawerData?.sortOrder || 100}
                            onChange={(e) => setReasonDrawerData(prev => prev ? { ...prev, sortOrder: parseInt(e.target.value) || 100 } : null)}
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Lower numbers appear first in dropdown menus</p>
                    </div>
                </div>
            </SlideUpDrawer>

            <SlideUpDrawer
                isOpen={isNoticeTypeDrawerOpen}
                onClose={closeNoticeTypeDrawer}
                title="Edit Notice Type"
                maxHeight="small"
                stickyFooter={
                    <div className="flex gap-3 p-4">
                        <button
                            onClick={closeNoticeTypeDrawer}
                            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSaveNoticeTypeFromDrawer}
                            disabled={!noticeTypeDrawerData?.name?.trim() || updateNoticeTypeMutation.isPending}
                            className="flex-1 py-3 rounded-xl font-medium text-white bg-primary hover:bg-primary/90 disabled:bg-primary/50 transition-colors"
                        >
                            {updateNoticeTypeMutation.isPending ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                }
            >
                <div className="p-5 space-y-4">
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Name *</label>
                        <input
                            type="text"
                            value={noticeTypeDrawerData?.name || ''}
                            onChange={(e) => setNoticeTypeDrawerData(prev => prev ? { ...prev, name: e.target.value } : null)}
                            placeholder="e.g., Maintenance, Holiday"
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Sort Order</label>
                        <input
                            type="number"
                            value={noticeTypeDrawerData?.sortOrder || 100}
                            onChange={(e) => setNoticeTypeDrawerData(prev => prev ? { ...prev, sortOrder: parseInt(e.target.value) || 100 } : null)}
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Lower numbers appear first in dropdown menus</p>
                    </div>
                </div>
            </SlideUpDrawer>

            <FloatingActionButton
                icon="add"
                label="New Notice"
                onClick={openNewClosure}
            />
            </>
            )}
            </div>
            <ConfirmDialogComponent />
        </AnimatedPage>
        </PullToRefresh>
    );
};

export default BlocksTab;
