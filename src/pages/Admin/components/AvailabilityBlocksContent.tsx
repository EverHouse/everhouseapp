import React, { useState, useEffect, useMemo } from 'react';
import { formatDateDisplayWithDay, getTodayPacific } from '../../../utils/dateUtils';
import EmptyState from '../../../components/EmptyState';
import { useToast } from '../../../components/Toast';
import ModalShell from '../../../components/ModalShell';
import FloatingActionButton from '../../../components/FloatingActionButton';

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

const BLOCK_TYPES = [
    { id: 'blocked', label: 'Blocked / Private Event' },
    { id: 'maintenance', label: 'Maintenance' },
    { id: 'wellness', label: 'Wellness Class' },
    { id: 'event', label: 'Club Event' },
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
    const [showPastAccordion, setShowPastAccordion] = useState(false);
    const [visibleDayCount, setVisibleDayCount] = useState(10);

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
        } catch (err: unknown) {
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
            } else if (res.status === 401) {
                setError('Session expired. Please refresh the page to log in again.');
            } else if (res.status === 429) {
                setError('Too many requests. Please wait a moment and try again.');
            } else if (res.status >= 500) {
                setError('Server error. The system may be temporarily unavailable.');
            } else {
                setError('Failed to fetch availability blocks. Try refreshing the page.');
            }
        } catch (err: unknown) {
            console.error('Failed to fetch blocks:', err);
            setError('Network error. Check your connection and try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleFilter = () => {
        setVisibleDayCount(10);
        fetchBlocks();
    };

    const handleReset = () => {
        setFilterResource('');
        setFilterStartDate('');
        setFilterEndDate('');
        setVisibleDayCount(10);
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
                const savedItem = await res.json();
                
                if (editId) {
                    setBlocks(prev => prev.map(b => b.id === editId ? savedItem : b));
                } else {
                    setBlocks(prev => [savedItem, ...prev]);
                }
                
                showToast(editId ? 'Block updated' : 'Block created', 'success');
                setIsEditing(false);
            } else {
                const data = await res.json();
                setFormError(data.error || 'Failed to save block');
            }
        } catch (err: unknown) {
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
        
        const snapshot = [...blocks];
        const deletedId = blockToDelete.id;
        
        setBlocks(prev => prev.filter(b => b.id !== deletedId));
        setShowDeleteConfirm(false);
        setBlockToDelete(null);

        try {
            setIsDeleting(true);
            const res = await fetch(`/api/availability-blocks/${deletedId}`, {
                method: 'DELETE',
                credentials: 'include',
            });

            if (res.ok) {
                showToast('Block deleted', 'success');
            } else {
                setBlocks(snapshot);
                showToast('Failed to delete block', 'error');
            }
        } catch (err: unknown) {
            setBlocks(snapshot);
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
            case 'blocked': return 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400';
            case 'maintenance': return 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400';
            case 'wellness': return 'bg-[#CCB8E4]/30 dark:bg-[#CCB8E4]/20 text-[#293515] dark:text-[#CCB8E4]';
            case 'event': return 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400';
            case 'available': return 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400';
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

    const { upcomingBlocks, pastBlocks } = useMemo(() => {
        const today = getTodayPacific();
        const upcoming: AvailabilityBlock[] = [];
        const past: AvailabilityBlock[] = [];
        
        blocks.forEach(block => {
            const blockDate = block.block_date?.includes('T') 
                ? block.block_date.split('T')[0] 
                : block.block_date;
            if (blockDate < today) {
                past.push(block);
            } else {
                upcoming.push(block);
            }
        });
        
        return { upcomingBlocks: upcoming, pastBlocks: past };
    }, [blocks]);

    const groupedUpcoming = groupBlocksByDate(upcomingBlocks);
    const groupedPast = useMemo(() => {
        const grouped = groupBlocksByDate(pastBlocks);
        return grouped.reverse();
    }, [pastBlocks]);

    return (
        <div className="animate-pop-in">
            <div className="mb-4 p-4 bg-white dark:bg-surface-dark rounded-xl border border-gray-200 dark:border-white/20">
                <div className="flex items-center gap-3">
                    <select
                        value={filterResource}
                        onChange={(e) => setFilterResource(e.target.value)}
                        className="flex-1 min-w-[120px] p-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white text-sm"
                    >
                        <option value="">All Resources</option>
                        {resources.map(r => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                    </select>
                    <button
                        onClick={handleFilter}
                        className="tactile-btn py-2.5 px-4 rounded-lg bg-primary text-white text-sm font-medium hover:opacity-90 transition-opacity"
                    >
                        Filter
                    </button>
                    <button
                        onClick={handleReset}
                        className="tactile-btn py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-400 text-sm font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                    >
                        Reset
                    </button>
                </div>
            </div>

            {error && (
                <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg">
                    <div className="flex items-start gap-3">
                        <span aria-hidden="true" className="material-symbols-outlined text-red-500 dark:text-red-400 text-xl flex-shrink-0">error</span>
                        <div className="flex-1">
                            <p className="text-red-700 dark:text-red-400 text-sm font-medium">{error}</p>
                            <div className="flex gap-2 mt-3">
                                <button
                                    onClick={() => fetchBlocks()}
                                    className="tactile-btn px-3 py-1.5 bg-red-100 dark:bg-red-800/30 text-red-700 dark:text-red-300 text-xs font-medium rounded-lg hover:bg-red-200 dark:hover:bg-red-700/40 transition-colors"
                                >
                                    Try Again
                                </button>
                                <button
                                    onClick={() => {
                                        if ('caches' in window) {
                                            caches.keys().then(keys => {
                                                keys.forEach(key => caches.delete(key));
                                            });
                                        }
                                        window.location.reload();
                                    }}
                                    className="tactile-btn px-3 py-1.5 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-300 text-xs font-medium rounded-lg hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
                                >
                                    Clear Cache & Reload
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center py-12">
                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-2xl text-gray-600 dark:text-gray-500">progress_activity</span>
                </div>
            ) : upcomingBlocks.length === 0 && pastBlocks.length === 0 ? (
                <EmptyState
                    icon="block"
                    title="No availability blocks found"
                    description="Use the + button to add a new block"
                    variant="compact"
                />
            ) : upcomingBlocks.length === 0 ? (
                <EmptyState
                    icon="event_available"
                    title="No upcoming blocks"
                    variant="compact"
                />
            ) : (
                <div className="space-y-3">
                    {groupedUpcoming.slice(0, visibleDayCount).map(({ date, blocks: dayBlocks }, groupIndex) => {
                        const isExpanded = expandedDays.has(date);
                        return (
                            <div 
                                key={date} 
                                className="bg-white dark:bg-surface-dark rounded-xl border border-gray-200 dark:border-white/20 overflow-hidden animate-slide-up-stagger"
                                style={{ '--stagger-index': groupIndex } as React.CSSProperties}
                            >
                                <button
                                    onClick={() => toggleDay(date)}
                                    className="tactile-row w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
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
                                    <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform duration-fast ${isExpanded ? 'rotate-180' : ''}`}>
                                        expand_more
                                    </span>
                                </button>
                                
                                {isExpanded && (
                                    <div className="border-t border-gray-100 dark:border-white/10 p-3 space-y-3">
                                        {dayBlocks.map((block, blockIndex) => (
                                            <div 
                                                key={block.id} 
                                                role="button"
                                                tabIndex={0}
                                                onClick={() => openEdit(block)}
                                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(block); } }}
                                                className="tactile-row bg-gray-50 dark:bg-black/20 p-3 rounded-lg flex flex-col gap-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-black/30 transition-colors animate-slide-up-stagger"
                                                style={{ '--stagger-index': blockIndex } as React.CSSProperties}
                                            >
                                                <div className="flex gap-3">
                                                    <div className={`w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center ${getBlockTypeColor(block.block_type)}`}>
                                                        <span aria-hidden="true" className="material-symbols-outlined text-lg">event_busy</span>
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 mb-1">
                                                            <h4 className="font-bold text-primary dark:text-white text-sm leading-tight">{block.resource_name}</h4>
                                                            <span className={`text-[10px] font-bold uppercase tracking-wider w-fit px-1.5 py-0.5 rounded-[4px] ${getBlockTypeColor(block.block_type)}`}>
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
                                                        className="tactile-btn self-start text-gray-400 hover:text-red-500 transition-colors p-1"
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
                    {visibleDayCount < groupedUpcoming.length && (
                        <button
                            onClick={() => setVisibleDayCount(prev => prev + 10)}
                            className="tactile-btn w-full py-3 px-4 rounded-xl border border-gray-200 dark:border-white/20 text-primary dark:text-white font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-sm">expand_more</span>
                            Load {Math.min(10, groupedUpcoming.length - visibleDayCount)} more ({groupedUpcoming.length - visibleDayCount} remaining)
                        </button>
                    )}
                </div>
            )}

            {pastBlocks.length > 0 && (
                <div className="mt-6 rounded-xl border border-gray-200 dark:border-white/20 overflow-hidden">
                    <button
                        onClick={() => setShowPastAccordion(!showPastAccordion)}
                        className="tactile-row w-full flex items-center justify-between p-4 bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                    >
                        <div className="flex items-center gap-2">
                            <span aria-hidden="true" className="material-symbols-outlined text-gray-500 dark:text-white/60">history</span>
                            <span className="font-semibold text-gray-600 dark:text-white/80">Past Blocks</span>
                            <span className="text-xs bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 px-2 py-0.5 rounded-full">
                                {pastBlocks.length}
                            </span>
                        </div>
                        <span aria-hidden="true" className={`material-symbols-outlined text-gray-400 transition-transform ${showPastAccordion ? 'rotate-180' : ''}`}>
                            expand_more
                        </span>
                    </button>
                    
                    {showPastAccordion && (
                        <div className="p-4 space-y-3 bg-gray-50/50 dark:bg-black/20">
                            {groupedPast.map(({ date, blocks: dayBlocks }, groupIndex) => {
                                const isExpanded = expandedDays.has(`past-${date}`);
                                return (
                                    <div 
                                        key={`past-${date}`} 
                                        className="bg-white/60 dark:bg-surface-dark/60 rounded-xl border border-gray-200/60 dark:border-white/10 overflow-hidden opacity-70 hover:opacity-100 transition-opacity"
                                    >
                                        <button
                                            onClick={() => {
                                                setExpandedDays(prev => {
                                                    const newSet = new Set(prev);
                                                    if (newSet.has(`past-${date}`)) {
                                                        newSet.delete(`past-${date}`);
                                                    } else {
                                                        newSet.add(`past-${date}`);
                                                    }
                                                    return newSet;
                                                });
                                            }}
                                            className="tactile-row w-full flex items-center justify-between p-3 text-left hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                                        >
                                            <div className="flex items-center gap-2">
                                                <div className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-white/10 flex items-center justify-center">
                                                    <span aria-hidden="true" className="material-symbols-outlined text-sm text-gray-500 dark:text-gray-400">calendar_today</span>
                                                </div>
                                                <div>
                                                    <p className="font-medium text-sm text-gray-600 dark:text-white/70">{formatDateDisplayWithDay(date)}</p>
                                                    <p className="text-xs text-gray-500 dark:text-gray-400">{dayBlocks.length} block{dayBlocks.length !== 1 ? 's' : ''}</p>
                                                </div>
                                            </div>
                                            <span aria-hidden="true" className={`material-symbols-outlined text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                                                expand_more
                                            </span>
                                        </button>
                                        
                                        {isExpanded && (
                                            <div className="border-t border-gray-200/40 dark:border-white/10 p-3 space-y-2 bg-gray-50/50 dark:bg-black/10">
                                                {dayBlocks.map((block) => (
                                                    <div 
                                                        key={block.id}
                                                        className="flex items-center gap-2 p-2 rounded-lg bg-white dark:bg-surface-dark border border-gray-100 dark:border-white/10"
                                                    >
                                                        <div className="flex-1 min-w-0">
                                                            <p className="font-medium text-sm text-gray-700 dark:text-white/80">{block.resource_name}</p>
                                                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                                                {formatTime(block.start_time)} - {formatTime(block.end_time)}
                                                            </p>
                                                        </div>
                                                        <button 
                                                            onClick={(e) => { e.stopPropagation(); handleDelete(block); }} 
                                                            className="tactile-btn text-gray-400 hover:text-red-500 transition-colors p-1"
                                                        >
                                                            <span aria-hidden="true" className="material-symbols-outlined text-base">delete</span>
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
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
                            className="tactile-btn flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="tactile-btn flex-1 py-3 px-4 rounded-lg bg-brand-green text-white font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
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
                            className="tactile-btn flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={confirmDelete}
                            disabled={isDeleting}
                            className="tactile-btn flex-1 py-3 px-4 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
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

            <FloatingActionButton 
                onClick={openCreate} 
                color="amber" 
                label="Add block"
                extended
                text="Add Block"
            />
        </div>
    );
};

export default AvailabilityBlocksContent;
