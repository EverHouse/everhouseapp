import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useData, MemberProfile } from '../../../contexts/DataContext';
import { usePageReady } from '../../../contexts/PageReadyContext';
import TierBadge from '../../../components/TierBadge';
import TagBadge from '../../../components/TagBadge';
import MemberProfileDrawer from '../../../components/MemberProfileDrawer';
import { AddMemberModal } from '../../../components/staff-command-center/modals/AddMemberModal';
import { formatPhoneNumber } from '../../../utils/formatting';
import { getTierColor, getTagColor } from '../../../utils/tierUtils';

const TIER_OPTIONS = ['All', 'Social', 'Core', 'Premium', 'Corporate', 'VIP'] as const;

type SortField = 'name' | 'tier' | 'visits' | 'joinDate' | 'lastVisit';
type SortDirection = 'asc' | 'desc';
type MemberTab = 'active' | 'former';

const formatJoinDate = (dateStr: string | null | undefined): string => {
    if (!dateStr) return '-';
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    } catch {
        return dateStr;
    }
};

const getStatusColor = (status: string): string => {
    const s = status.toLowerCase();
    if (s === 'expired') return 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400';
    if (s === 'terminated') return 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400';
    if (s === 'former_member') return 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400';
    if (s === 'pending') return 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400';
    if (s === 'suspended') return 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400';
    if (s === 'frozen' || s === 'froze') return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-400';
    if (s === 'non-member') return 'bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-400';
    if (s === 'declined') return 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400';
    if (s === 'cancelled' || s === 'canceled') return 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400';
    return 'bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-400';
};

const formatStatusLabel = (status: string): string => {
    return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

const DirectoryTab: React.FC = () => {
    const { setPageReady } = usePageReady();
    const { members, formerMembers, fetchFormerMembers, refreshMembers, setViewAsUser, actualUser } = useData();
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const [tierFilter, setTierFilter] = useState<string>('All');
    const [tagFilter, setTagFilter] = useState<string>('All');
    const [statusFilter, setStatusFilter] = useState<string>('All');
    const [selectedMember, setSelectedMember] = useState<MemberProfile | null>(null);
    const [isViewingDetails, setIsViewingDetails] = useState(false);
    const [memberTab, setMemberTab] = useState<MemberTab>('active');
    const [sortField, setSortField] = useState<SortField>('name');
    const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
    const [formerLoading, setFormerLoading] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [addMemberModalOpen, setAddMemberModalOpen] = useState(false);
    
    const isAdmin = actualUser?.role === 'admin';

    const handleSync = async () => {
        setIsSyncing(true);
        setSyncMessage(null);
        try {
            const result = await refreshMembers();
            if (result.success) {
                setSyncMessage({ type: 'success', text: `Synced ${result.count} members from HubSpot` });
                if (memberTab === 'former') {
                    setFormerLoading(true);
                    await fetchFormerMembers();
                    setFormerLoading(false);
                }
            } else {
                setSyncMessage({ type: 'error', text: 'Failed to sync with HubSpot' });
            }
        } catch (err) {
            setSyncMessage({ type: 'error', text: 'Failed to sync with HubSpot' });
        } finally {
            setIsSyncing(false);
            setTimeout(() => setSyncMessage(null), 5000);
        }
    };

    const openDetailsModal = (member: MemberProfile) => {
        setSelectedMember(member);
        setIsViewingDetails(true);
    };

    useEffect(() => {
        setPageReady(true);
    }, [setPageReady]);

    useEffect(() => {
        if (isViewingDetails && selectedMember) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    }, [isViewingDetails, selectedMember]);

    // Fetch former members when switching to that tab
    const handleTabChange = useCallback(async (tab: MemberTab) => {
        setMemberTab(tab);
        setStatusFilter('All');
        if (tab === 'former') {
            setFormerLoading(true);
            await fetchFormerMembers();
            setFormerLoading(false);
        }
    }, [fetchFormerMembers]);

    // Get current member list based on tab
    const currentMembers = memberTab === 'active' ? members : formerMembers;
    
    const regularMembers = useMemo(() => 
        currentMembers.filter(m => !m.role || m.role === 'member'), 
        [currentMembers]
    );

    // Get all unique tags for the tag filter
    const allTags = useMemo(() => {
        const tagSet = new Set<string>();
        regularMembers.forEach(m => {
            m.tags?.forEach(tag => tagSet.add(tag));
        });
        return Array.from(tagSet).sort();
    }, [regularMembers]);

    // Get all unique statuses for the status filter (former members tab only)
    const allStatuses = useMemo(() => {
        const statusSet = new Set<string>();
        if (Array.isArray(formerMembers)) {
            formerMembers.forEach(m => {
                if (m?.status && typeof m.status === 'string' && m.status.toLowerCase() !== 'active') {
                    statusSet.add(m.status);
                }
            });
        }
        return Array.from(statusSet).sort();
    }, [formerMembers]);

    // Handle sorting
    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDirection('asc');
        }
    };

    const getSortIcon = (field: SortField) => {
        if (sortField !== field) return 'unfold_more';
        return sortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward';
    };

    const filteredList = useMemo(() => {
        let filtered = regularMembers;
        
        // Tier filter
        if (tierFilter !== 'All') {
            filtered = filtered.filter(m => {
                const tier = m.tier || '';
                return tier === tierFilter || tier.includes(tierFilter);
            });
        }
        
        // Tag filter
        if (tagFilter !== 'All') {
            filtered = filtered.filter(m => 
                m.tags?.includes(tagFilter)
            );
        }
        
        // Status filter (former members tab only)
        if (memberTab === 'former' && statusFilter !== 'All') {
            filtered = filtered.filter(m => m.status === statusFilter);
        }
        
        // Search filter
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            filtered = filtered.filter(m => 
                m.name.toLowerCase().includes(query) ||
                m.email.toLowerCase().includes(query) ||
                (m.tier && m.tier.toLowerCase().includes(query)) ||
                (m.phone && m.phone.toLowerCase().includes(query)) ||
                (m.tags?.some(t => t.toLowerCase().includes(query)))
            );
        }
        
        // Sorting
        filtered = [...filtered].sort((a, b) => {
            let comparison = 0;
            switch (sortField) {
                case 'name':
                    comparison = a.name.localeCompare(b.name);
                    break;
                case 'tier':
                    comparison = (a.tier || '').localeCompare(b.tier || '');
                    break;
                case 'visits':
                    comparison = (a.lifetimeVisits || 0) - (b.lifetimeVisits || 0);
                    break;
                case 'joinDate':
                    const dateA = a.joinDate ? new Date(a.joinDate).getTime() : 0;
                    const dateB = b.joinDate ? new Date(b.joinDate).getTime() : 0;
                    comparison = dateA - dateB;
                    break;
                case 'lastVisit':
                    const lastA = a.lastBookingDate ? new Date(a.lastBookingDate).getTime() : 0;
                    const lastB = b.lastBookingDate ? new Date(b.lastBookingDate).getTime() : 0;
                    comparison = lastA - lastB;
                    break;
            }
            return sortDirection === 'asc' ? comparison : -comparison;
        });
        
        return filtered;
    }, [regularMembers, tierFilter, tagFilter, statusFilter, memberTab, searchQuery, sortField, sortDirection]);
    
    const handleViewAs = async (member: MemberProfile) => {
        if (!isAdmin) return;
        await setViewAsUser(member);
        navigate('/dashboard');
    };

    const SortableHeader = ({ field, label, className = '' }: { field: SortField; label: string; className?: string }) => (
        <th 
            className={`p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-white/10 transition-colors select-none ${className}`}
            onClick={() => handleSort(field)}
        >
            <div className="flex items-center gap-1">
                {label}
                <span className={`material-symbols-outlined text-[16px] ${sortField === field ? 'text-primary dark:text-lavender' : 'text-gray-400'}`}>
                    {getSortIcon(field)}
                </span>
            </div>
        </th>
    );

    return (
        <div className="animate-pop-in">
            {/* Active/Former Toggle + Sync Button */}
            <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => handleTabChange('active')}
                        className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
                            memberTab === 'active'
                                ? 'bg-primary dark:bg-lavender text-white'
                                : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                        }`}
                    >
                        Active
                    </button>
                    <button
                        onClick={() => handleTabChange('former')}
                        className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
                            memberTab === 'former'
                                ? 'bg-primary dark:bg-lavender text-white'
                                : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                        }`}
                    >
                        Former
                    </button>
                    {syncMessage && (
                        <span className={`text-[10px] font-medium ${syncMessage.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {syncMessage.text}
                        </span>
                    )}
                </div>
                <button
                    onClick={handleSync}
                    disabled={isSyncing}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-amber-500 hover:bg-amber-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <span className={`material-symbols-outlined text-[14px] ${isSyncing ? 'animate-spin' : ''}`}>
                        sync
                    </span>
                    {isSyncing ? 'Syncing...' : 'Sync'}
                </button>
            </div>

            <div className="mb-6 space-y-3 animate-pop-in" style={{animationDelay: '0.05s'}}>
                {/* Search */}
                <div className="relative">
                    <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 text-[20px]">search</span>
                    <input
                        type="text"
                        placeholder="Search members..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    {searchQuery && (
                        <button 
                            onClick={() => setSearchQuery('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-600"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
                        </button>
                    )}
                </div>
                
                {/* Tier Filter */}
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">Tier:</span>
                    {TIER_OPTIONS.map(tier => {
                        const isSelected = tierFilter === tier;
                        const colors = tier !== 'All' ? getTierColor(tier) : null;
                        return (
                            <button
                                key={tier}
                                onClick={() => setTierFilter(tier)}
                                className={`px-2 py-0.5 rounded text-[11px] font-bold transition-all ${
                                    tier === 'All' 
                                        ? isSelected
                                            ? 'bg-primary dark:bg-lavender text-white'
                                            : 'bg-gray-200 dark:bg-white/20 text-gray-400 dark:text-gray-500'
                                        : ''
                                }`}
                                style={tier !== 'All' ? {
                                    backgroundColor: isSelected ? colors?.bg : '#E5E7EB',
                                    color: isSelected ? colors?.text : '#9CA3AF',
                                    border: `1px solid ${isSelected ? colors?.border : '#D1D5DB'}`,
                                } : undefined}
                            >
                                {tier}
                            </button>
                        );
                    })}
                </div>

                {/* Tag Filter */}
                {allTags.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">Tag:</span>
                        <button
                            onClick={() => setTagFilter('All')}
                            className={`px-2 py-0.5 rounded text-[11px] font-bold transition-all ${
                                tagFilter === 'All'
                                    ? 'bg-primary dark:bg-lavender text-white'
                                    : 'bg-gray-200 dark:bg-white/20 text-gray-400 dark:text-gray-500'
                            }`}
                        >
                            All
                        </button>
                        {allTags.map(tag => {
                            const isSelected = tagFilter === tag;
                            const colors = getTagColor(tag);
                            return (
                                <button
                                    key={tag}
                                    onClick={() => setTagFilter(tag)}
                                    className="px-2 py-0.5 rounded text-[11px] font-bold transition-all"
                                    style={{
                                        backgroundColor: isSelected ? colors.bg : '#E5E7EB',
                                        color: isSelected ? colors.text : '#9CA3AF',
                                        border: `1px solid ${isSelected ? colors.border : '#D1D5DB'}`,
                                    }}
                                >
                                    {tag}
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Status Filter (Former Members Only) */}
                {memberTab === 'former' && allStatuses.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">Status:</span>
                        <button
                            onClick={() => setStatusFilter('All')}
                            className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
                                statusFilter === 'All'
                                    ? 'bg-orange-500 text-white'
                                    : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                            }`}
                        >
                            All
                        </button>
                        {allStatuses.map(status => (
                            <button
                                key={status}
                                onClick={() => setStatusFilter(status)}
                                className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
                                    statusFilter === status
                                        ? 'bg-orange-500 text-white'
                                        : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                                }`}
                            >
                                {formatStatusLabel(status)}
                            </button>
                        ))}
                    </div>
                )}
                
                <p className="text-xs text-gray-500 dark:text-gray-400">
                    {filteredList.length} {memberTab === 'former' ? 'former ' : ''}member{filteredList.length !== 1 ? 's' : ''} found
                </p>
            </div>

            {/* Loading state for former members */}
            {formerLoading && memberTab === 'former' && (
                <div className="text-center py-12">
                    <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4"></div>
                    <p className="text-gray-500 dark:text-gray-400">Loading former members...</p>
                </div>
            )}

            {/* Empty state */}
            {!formerLoading && filteredList.length === 0 && (
                <div className="text-center py-12 px-6 rounded-2xl border-2 border-dashed border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-white/5">
                    <span aria-hidden="true" className="material-symbols-outlined text-5xl mb-4 text-gray-500 dark:text-white/20">person_off</span>
                    <h3 className="text-lg font-bold mb-2 text-gray-600 dark:text-white/70">
                        {searchQuery ? 'No results found' : memberTab === 'former' ? 'No former members' : 'No members yet'}
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-white/70 max-w-xs mx-auto">
                        {searchQuery 
                            ? 'Try a different search term or clear the filter.'
                            : memberTab === 'former' ? 'Former members will appear here.' : 'Members will appear here once they sign up.'}
                    </p>
                </div>
            )}

            {/* Mobile view */}
            {!formerLoading && filteredList.length > 0 && (
            <div className="md:hidden space-y-3 animate-pop-in" style={{animationDelay: '0.1s'}}>
                {filteredList.map((m, index) => (
                    <div 
                        key={m.id} 
                        onClick={() => openDetailsModal(m)}
                        className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm animate-pop-in cursor-pointer hover:border-primary/50 transition-colors" 
                        style={{animationDelay: `${0.15 + Math.min(index, 10) * 0.03}s`}}
                    >
                        <div className="flex justify-between items-start mb-2">
                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <h4 className="font-bold text-lg text-primary dark:text-white">{m.name}</h4>
                                    {memberTab === 'former' && m.status && (
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getStatusColor(m.status)}`}>
                                            {formatStatusLabel(m.status)}
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-gray-500 dark:text-gray-400">{m.email}</p>
                                {m.phone && <p className="text-xs text-gray-500 dark:text-gray-400">{formatPhoneNumber(m.phone)}</p>}
                            </div>
                            <div className="text-right">
                                <p className="text-xs text-gray-500 dark:text-gray-400">{m.lifetimeVisits || 0} visits</p>
                                {m.lastBookingDate && <p className="text-xs text-gray-500 dark:text-gray-400">Last: {formatJoinDate(m.lastBookingDate)}</p>}
                            </div>
                        </div>
                        <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-gray-50 dark:border-white/20">
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <TierBadge tier={m.rawTier} size="sm" showNoTier={true} />
                                {m.tags?.map(tag => (
                                    <TagBadge key={tag} tag={tag} size="sm" />
                                ))}
                            </div>
                            {isAdmin && memberTab === 'active' && (
                                <button 
                                    onClick={(e) => { e.stopPropagation(); handleViewAs(m); }} 
                                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-accent/20 text-brand-green dark:bg-accent/30 dark:text-accent text-xs font-bold hover:bg-accent/30 transition-colors"
                                >
                                    <span aria-hidden="true" className="material-symbols-outlined text-[14px]">visibility</span>
                                    View As
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
            )}

            {/* Desktop table view */}
            {!formerLoading && filteredList.length > 0 && (
            <div className="hidden md:block bg-white dark:bg-surface-dark rounded-xl shadow-sm border border-gray-200 dark:border-white/20 overflow-hidden animate-pop-in" style={{animationDelay: '0.1s'}}>
                <table className="w-full text-left table-fixed">
                    <colgroup>
                        <col className="w-[15%]" />
                        <col className="w-[20%]" />
                        <col className="w-[8%]" />
                        <col className="w-[10%]" />
                        <col className="w-[10%]" />
                        <col className="w-[22%]" />
                        {memberTab === 'former' && <col className="w-[15%]" />}
                    </colgroup>
                    <thead className="bg-gray-50 dark:bg-white/5 border-b border-gray-200 dark:border-white/20">
                        <tr>
                            <SortableHeader field="name" label="Name" />
                            <SortableHeader field="tier" label="Tier" />
                            <SortableHeader field="visits" label="Visits" className="text-center" />
                            <SortableHeader field="joinDate" label="Joined" />
                            <SortableHeader field="lastVisit" label="Last Visit" />
                            <th className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm">Email</th>
                            {memberTab === 'former' && (
                                <th className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm">Status</th>
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {filteredList.map((m, index) => (
                            <tr 
                                key={m.id} 
                                onClick={() => openDetailsModal(m)}
                                className="border-b border-gray-200 dark:border-white/20 last:border-0 hover:bg-gray-50 dark:hover:bg-white/5 animate-pop-in cursor-pointer" 
                                style={{animationDelay: `${0.15 + Math.min(index, 10) * 0.03}s`}}
                            >
                                <td className="p-4 font-medium text-primary dark:text-white truncate">{m.name}</td>
                                <td className="p-4">
                                    <div className="flex items-center gap-1 flex-wrap">
                                        <TierBadge tier={m.rawTier} size="sm" showNoTier={true} />
                                        {m.tags?.map(tag => (
                                            <TagBadge key={tag} tag={tag} size="sm" />
                                        ))}
                                    </div>
                                </td>
                                <td className="p-4 text-center text-gray-600 dark:text-gray-400 text-sm font-medium">
                                    {m.lifetimeVisits || 0}
                                </td>
                                <td className="p-4 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                                    {formatJoinDate(m.joinDate)}
                                </td>
                                <td className="p-4 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                                    {formatJoinDate(m.lastBookingDate)}
                                </td>
                                <td className="p-4 text-gray-500 dark:text-gray-400 text-sm truncate" title={m.email}>{m.email}</td>
                                {memberTab === 'former' && (
                                    <td className="p-4">
                                        {m.status ? (
                                            <span className={`px-2 py-1 rounded-full text-xs font-bold whitespace-nowrap ${getStatusColor(m.status)}`}>
                                                {formatStatusLabel(m.status)}
                                            </span>
                                        ) : (
                                            <span className="px-2 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                                                Unknown
                                            </span>
                                        )}
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            )}

            <MemberProfileDrawer
                isOpen={isViewingDetails && !!selectedMember}
                member={selectedMember}
                isAdmin={isAdmin}
                onClose={() => { setIsViewingDetails(false); setSelectedMember(null); }}
                onViewAs={(member) => { setIsViewingDetails(false); setSelectedMember(null); handleViewAs(member); }}
            />

            {/* Add Member FAB */}
            {createPortal(
                <button
                    onClick={() => setAddMemberModalOpen(true)}
                    className="fixed right-5 bottom-24 lg:bottom-8 z-[9998] w-14 h-14 rounded-full shadow-lg flex items-center justify-center bg-green-600 hover:bg-green-700 text-white transition-all duration-300 hover:scale-110 active:scale-95"
                    title="Add New Member"
                    aria-label="Add New Member"
                >
                    <span className="material-symbols-outlined text-2xl">person_add</span>
                </button>,
                document.body
            )}

            <AddMemberModal
                isOpen={addMemberModalOpen}
                onClose={() => setAddMemberModalOpen(false)}
                onSuccess={() => {
                    setAddMemberModalOpen(false);
                    refreshMembers();
                }}
            />
        </div>
    );
};

export default DirectoryTab;
