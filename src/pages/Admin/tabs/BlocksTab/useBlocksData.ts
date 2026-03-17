import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthData } from '../../../../contexts/DataContext';
import { useToast } from '../../../../components/Toast';
import { getTodayPacific, formatDateDisplayWithDay } from '../../../../utils/dateUtils';
import { useConfirmDialog } from '../../../../components/ConfirmDialog';
import { useUndoAction } from '../../../../hooks/useUndoAction';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials, putWithCredentials } from '../../../../hooks/queries/useFetch';
import { isBlockingClosure, formatAffectedAreas as formatAreasShared, getAffectedAreasList as getAreasListShared } from '../../../../utils/closureUtils';
import type { BlocksClosure, BlocksClosureForm, NoticeType, ClosureReason } from './blocksTabTypes';
import { stripHtml, emptyClosureForm } from './blocksTabTypes';

export function useBlocksData() {
    const { actualUser } = useAuthData();
    const { showToast } = useToast();
    const queryClient = useQueryClient();
    const [activeSubTab, setActiveSubTab] = useState<'notices' | 'blocks'>('notices');

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

    const [closuresFilterResource, _setClosuresFilterResource] = useState<string>('all');
    const [closuresFilterDate, _setClosuresFilterDate] = useState<string>('');
    const [showPastAccordion, setShowPastAccordion] = useState(false);
    const [pastNoticesLimit, setPastNoticesLimit] = useState(50);
    const [closureForm, setClosureForm] = useState<BlocksClosureForm>({ ...emptyClosureForm });
    const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();
    const { execute: undoAction } = useUndoAction();

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
        affected_areas: !closureForm.affected_areas?.trim()
    };

    const isClosureFormValid = !closureValidation.notice_type && !closureValidation.affected_areas;

    const addClosureReasonMutation = useMutation({
        mutationFn: (label: string) => postWithCredentials<ClosureReason>('/api/closure-reasons', { label: label.trim() }),
        onMutate: async () => { await queryClient.cancelQueries({ queryKey: ['closureReasons'] }); },
        onSuccess: () => { setNewReasonLabel(''); showToast('Closure reason added', 'success'); },
        onError: (error: Error) => { showToast(error.message || 'Failed to add reason', 'error'); },
        onSettled: () => { queryClient.invalidateQueries({ queryKey: ['closureReasons'] }); },
    });

    const handleAddClosureReason = () => {
        if (!newReasonLabel.trim()) return;
        addClosureReasonMutation.mutate(newReasonLabel);
    };

    const updateClosureReasonMutation = useMutation({
        mutationFn: (data: { id: number; label: string; sortOrder: number }) =>
            putWithCredentials(`/api/closure-reasons/${data.id}`, { label: data.label, sort_order: data.sortOrder }),
        onMutate: async () => { await queryClient.cancelQueries({ queryKey: ['closureReasons'] }); },
        onSuccess: () => { closeReasonDrawer(); showToast('Closure reason updated', 'success'); },
        onError: (error: Error) => { showToast(error.message || 'Failed to update reason', 'error'); },
        onSettled: () => { queryClient.invalidateQueries({ queryKey: ['closureReasons'] }); },
    });

    const reactivateClosureReasonMutation = useMutation({
        mutationFn: (id: number) => putWithCredentials(`/api/closure-reasons/${id}`, { is_active: true }),
        onMutate: async () => { await queryClient.cancelQueries({ queryKey: ['closureReasons'] }); },
        onSuccess: () => { showToast('Closure reason reactivated', 'success'); },
        onError: (error: Error) => { showToast(error.message || 'Failed to reactivate reason', 'error'); },
        onSettled: () => { queryClient.invalidateQueries({ queryKey: ['closureReasons'] }); },
    });

    const addNoticeTypeMutation = useMutation({
        mutationFn: (name: string) => postWithCredentials<NoticeType>('/api/notice-types', { name: name.trim() }),
        onMutate: async () => { await queryClient.cancelQueries({ queryKey: ['noticeTypes'] }); },
        onSuccess: () => { setNewNoticeTypeName(''); showToast('Notice type added', 'success'); },
        onError: (error: Error) => { showToast(error.message || 'Failed to add notice type', 'error'); },
        onSettled: () => { queryClient.invalidateQueries({ queryKey: ['noticeTypes'] }); },
    });

    const updateNoticeTypeMutation = useMutation({
        mutationFn: (data: { id: number; name: string; sortOrder: number }) =>
            putWithCredentials(`/api/notice-types/${data.id}`, { name: data.name, sort_order: data.sortOrder }),
        onMutate: async () => { await queryClient.cancelQueries({ queryKey: ['noticeTypes'] }); },
        onSuccess: () => { closeNoticeTypeDrawer(); showToast('Notice type updated', 'success'); },
        onError: (error: Error) => { showToast(error.message || 'Failed to update notice type', 'error'); },
        onSettled: () => { queryClient.invalidateQueries({ queryKey: ['noticeTypes'] }); },
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

    const handleDeleteClosureReason = (id: number) => {
        const reasonToDelete = closureReasons.find(r => r.id === id);
        const previous = queryClient.getQueryData<ClosureReason[]>(['closureReasons']);
        queryClient.setQueryData<ClosureReason[]>(['closureReasons'], (old = []) =>
            old.filter(r => r.id !== id)
        );
        undoAction({
            message: `Closure reason "${reasonToDelete?.label || ''}" deleted`,
            onExecute: async () => {
                await deleteWithCredentials(`/api/closure-reasons/${id}`);
                queryClient.invalidateQueries({ queryKey: ['closureReasons'] });
            },
            onUndo: () => {
                if (previous) queryClient.setQueryData(['closureReasons'], previous);
            },
            errorMessage: 'Failed to delete reason',
        });
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

    const handleDeleteNoticeType = (id: number) => {
        const typeToDelete = noticeTypes.find(t => t.id === id);
        const previous = queryClient.getQueryData<NoticeType[]>(['noticeTypes']);
        queryClient.setQueryData<NoticeType[]>(['noticeTypes'], (old = []) =>
            old.filter(t => t.id !== id)
        );
        undoAction({
            message: `Notice type "${typeToDelete?.name || ''}" deleted`,
            onExecute: async () => {
                await deleteWithCredentials(`/api/notice-types/${id}`);
                queryClient.invalidateQueries({ queryKey: ['noticeTypes'] });
            },
            onUndo: () => {
                if (previous) queryClient.setQueryData(['noticeTypes'], previous);
            },
            errorMessage: 'Failed to delete notice type',
        });
    };

    const saveClosureMutation = useMutation<{ blocks?: unknown[]; warnings?: string[] }, Error, { form: BlocksClosureForm; isEdit: boolean; id?: number }>({
        mutationFn: (data) => {
            const url = data.isEdit ? `/api/closures/${data.id}` : '/api/closures';
            const payload = data.isEdit
                ? { ...data.form }
                : { ...data.form, created_by: actualUser?.email };
            return data.isEdit
                ? putWithCredentials(url, payload)
                : postWithCredentials(url, payload);
        },
        onMutate: async () => { await queryClient.cancelQueries({ queryKey: ['closures'] }); },
        onSuccess: (data: { blocks?: unknown[]; warnings?: string[] }) => {
            setIsClosureModalOpen(false);
            resetClosureForm();
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
        onError: (error: Error) => { showToast(error.message || 'Failed to save notice', 'error'); },
        onSettled: () => { queryClient.invalidateQueries({ queryKey: ['closures'] }); },
    });

    const deleteClosureMutation = useMutation<unknown, Error, number>({
        mutationFn: (closureId) => deleteWithCredentials(`/api/closures/${closureId}`),
        onMutate: async (closureId) => {
            await queryClient.cancelQueries({ queryKey: ['closures'] });
            const previous = queryClient.getQueryData<BlocksClosure[]>(['closures']);
            queryClient.setQueryData<BlocksClosure[]>(['closures'], (old = []) =>
                old.filter(c => c.id !== closureId)
            );
            return { previous };
        },
        onError: (_err, _id, context) => {
            if ((context as { previous?: BlocksClosure[] })?.previous) queryClient.setQueryData(['closures'], (context as { previous?: BlocksClosure[] }).previous);
            showToast('Failed to delete notice', 'error');
        },
        onSettled: () => { queryClient.invalidateQueries({ queryKey: ['closures'] }); },
        onSuccess: () => { showToast('Notice deleted', 'success'); }
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const syncClosuresMutation = useMutation({
        mutationFn: async () => {
            await postWithCredentials('/api/closures/sync', {});
            return queryClient.refetchQueries({ queryKey: ['closures'] });
        },
        onSuccess: () => { showToast('Calendar synced & notices refreshed', 'success'); },
        onError: (error: unknown) => {
            console.error('Calendar sync failed:', error);
            showToast('Failed to sync calendar', 'error');
        }
    });

    const resetClosureForm = () => {
        setClosureForm({ ...emptyClosureForm });
        setEditingClosureId(null);
        setTouchedFields(new Set());
    };

    useEffect(() => {
        const handleOpenNewClosure = () => {
            resetClosureForm();
            setIsClosureModalOpen(true);
        };
        window.addEventListener('open-new-closure', handleOpenNewClosure);
        return () => window.removeEventListener('open-new-closure', handleOpenNewClosure);
    }, []);

    const handleSaveClosure = () => {
        if (!closureForm.start_date || !closureForm.affected_areas) return;
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
        return formatAreasShared(areas);
    };

    const isBlocking = isBlockingClosure;

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
        return getAreasListShared(areas);
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
        return missing;
    };

    return {
        activeSubTab, setActiveSubTab,
        isClosureModalOpen, setIsClosureModalOpen,
        editingClosureId,
        expandedNotices,
        showClosureReasonsSection, setShowClosureReasonsSection,
        newReasonLabel, setNewReasonLabel,
        showNoticeTypesSection, setShowNoticeTypesSection,
        newNoticeTypeName, setNewNoticeTypeName,
        isReasonDrawerOpen,
        reasonDrawerData, setReasonDrawerData,
        isNoticeTypeDrawerOpen,
        noticeTypeDrawerData, setNoticeTypeDrawerData,
        showPastAccordion, setShowPastAccordion,
        pastNoticesLimit, setPastNoticesLimit,
        closureForm, setClosureForm,
        touchedFields,
        ConfirmDialogComponent,
        closures, closuresLoading,
        resources, isLoading,
        noticeTypes,
        closureReasons,
        markTouched,
        closureValidation,
        isClosureFormValid,
        addClosureReasonMutation,
        handleAddClosureReason,
        updateClosureReasonMutation,
        openReasonDrawer,
        closeReasonDrawer,
        handleSaveReasonFromDrawer,
        handleDeleteClosureReason,
        handleReactivateClosureReason,
        addNoticeTypeMutation,
        handleAddNoticeType,
        updateNoticeTypeMutation,
        openNoticeTypeDrawer,
        closeNoticeTypeDrawer,
        handleSaveNoticeTypeFromDrawer,
        handleDeleteNoticeType,
        saveClosureMutation,
        resetClosureForm,
        handleSaveClosure,
        handleEditClosure,
        handleDeleteClosure,
        openNewClosure,
        toggleNoticeExpand,
        formatDate,
        formatTime,
        bays,
        conferenceRoom,
        formatAffectedAreas,
        isBlocking,
        getAffectedAreasList,
        upcomingClosures,
        pastClosures,
        getMissingFields,
    };
}
