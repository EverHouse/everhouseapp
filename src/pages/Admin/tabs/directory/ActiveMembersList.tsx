import React from 'react';
import type { MemberProfile } from '../../../../contexts/DataContext';
import TierBadge from '../../../../components/TierBadge';
import { DirectoryTabSkeleton } from '../../../../components/skeletons';
import EmptyState from '../../../../components/EmptyState';
import { formatPhoneNumber } from '../../../../utils/formatting';
import { getMemberStatusBadgeClass, getMemberStatusLabel } from '../../../../utils/statusColors';
import { prefetchMemberProfile } from '../../../../lib/prefetch';
import { formatJoinDate } from './directoryTypes';
import SortableHeader from './DirectoryListHeader';
import type { SortField } from './directoryTypes';

interface ActiveMembersListProps {
    members: MemberProfile[];
    isFetchingMembers: boolean;
    filteredList: MemberProfile[];
    visibleItems: MemberProfile[];
    hasMore: boolean;
    loadMoreRef: React.RefObject<HTMLDivElement | null>;
    totalCount: number;
    visibleCount: number;
    isAdmin: boolean;
    searchQuery: string;
    tierFilter: string;
    appUsageFilter: string;
    statusFilter: string;
    discountFilter: string;
    membersWithoutTierCount: number;
    showMissingTierOnly: boolean;
    setShowMissingTierOnly: (v: boolean) => void;
    setTierFilter: (t: string) => void;
    sortField: SortField;
    handleSort: (field: SortField) => void;
    getSortIcon: (field: SortField) => string;
    getDisplayTier: (m: MemberProfile) => string | null;
    isMemberPendingUpdate: (email: string) => boolean;
    openDetailsModal: (m: MemberProfile) => void;
    openAssignTierModal: (m: MemberProfile) => void;
    handleViewAs: (m: MemberProfile) => void;
}

const ActiveMembersList: React.FC<ActiveMembersListProps> = ({
    members,
    isFetchingMembers,
    filteredList,
    visibleItems,
    hasMore,
    loadMoreRef,
    totalCount,
    visibleCount,
    isAdmin,
    searchQuery,
    tierFilter,
    appUsageFilter,
    statusFilter,
    discountFilter,
    membersWithoutTierCount,
    showMissingTierOnly,
    setShowMissingTierOnly,
    setTierFilter,
    sortField,
    handleSort,
    getSortIcon,
    getDisplayTier,
    isMemberPendingUpdate,
    openDetailsModal,
    openAssignTierModal,
    handleViewAs,
}) => {
    return (
        <>
            {membersWithoutTierCount > 0 && (
                <div className={`mb-4 p-3 rounded-xl flex items-center justify-between gap-3 ${
                    showMissingTierOnly 
                        ? 'bg-amber-100 dark:bg-amber-500/20 border-2 border-amber-400 dark:border-amber-500/50' 
                        : 'bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30'
                }`}>
                    <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-xl">warning</span>
                        <div>
                            <p className="text-sm font-bold text-amber-800 dark:text-amber-300">
                                Needs Attention
                            </p>
                            <p className="text-xs text-amber-700 dark:text-amber-400">
                                {membersWithoutTierCount} active member{membersWithoutTierCount !== 1 ? 's' : ''} without a tier assigned
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={() => {
                            setShowMissingTierOnly(!showMissingTierOnly);
                            setTierFilter('All');
                        }}
                        className={`tactile-btn px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                            showMissingTierOnly
                                ? 'bg-amber-600 text-white hover:bg-amber-700'
                                : 'bg-amber-200 dark:bg-amber-500/30 text-amber-800 dark:text-amber-300 hover:bg-amber-300 dark:hover:bg-amber-500/40'
                        }`}
                    >
                        {showMissingTierOnly ? 'Show All' : 'View Members'}
                    </button>
                </div>
            )}

            {members.length === 0 && isFetchingMembers && (
                <DirectoryTabSkeleton />
            )}

            {filteredList.length === 0 && !isFetchingMembers && (
                <EmptyState
                    icon={searchQuery || tierFilter !== 'All' || appUsageFilter !== 'All' || statusFilter !== 'All' || discountFilter !== 'All' ? 'search_off' : 'group'}
                    title={searchQuery || tierFilter !== 'All' || appUsageFilter !== 'All' || statusFilter !== 'All' || discountFilter !== 'All'
                        ? 'No results found' 
                        : 'No members yet'}
                    description={searchQuery || tierFilter !== 'All' || appUsageFilter !== 'All' || statusFilter !== 'All' || discountFilter !== 'All'
                        ? 'Try adjusting your search or filters to find what you\'re looking for'
                        : 'Members will appear here once they sign up'}
                    variant="compact"
                />
            )}

            {Array.isArray(filteredList) && filteredList.length > 0 && (
                <>
                    <div className="md:hidden relative">
                        <div className="pt-2 pb-24">
                            <div className="space-y-3 px-1">
                                {visibleItems.map((m, index) => (
                                    <div 
                                        key={m.email}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => openDetailsModal(m)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetailsModal(m); } }}
                                        onMouseEnter={() => prefetchMemberProfile(m.email)}
                                        onFocus={() => prefetchMemberProfile(m.email)}
                                        className={`bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.98] ${index < 10 ? `animate-list-item-delay-${index}` : 'animate-list-item'}`}
                                    >
                                        <div className="flex justify-between items-start mb-2">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2">
                                                    <h4 className="font-bold text-lg text-primary dark:text-white">{m.name}</h4>
                                                </div>
                                                <p className="text-xs text-gray-500 dark:text-gray-400">{m.email}</p>
                                                {m.phone && <p className="text-xs text-gray-500 dark:text-gray-400">{formatPhoneNumber(m.phone)}</p>}
                                            </div>
                                            <div className="text-right">
                                                <p className="text-xs text-gray-500 dark:text-gray-400">{m.lifetimeVisits || 0} visits</p>
                                                {m.lastBookingDate && <p className="text-xs text-gray-500 dark:text-gray-400">Last: {formatJoinDate(m.lastBookingDate)}</p>}
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between gap-3 mt-3 pt-3 pb-2 border-t border-gray-50 dark:border-white/20">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <div className="flex items-center gap-1">
                                                    <TierBadge tier={getDisplayTier(m)} size="sm" showNoTier={true} membershipStatus={m.membershipStatus} />
                                                    {isMemberPendingUpdate(m.email) && (
                                                        <span className="material-symbols-outlined text-[14px] text-primary dark:!text-lavender animate-spin">progress_activity</span>
                                                    )}
                                                </div>
                                                {m.membershipStatus && (
                                                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getMemberStatusBadgeClass(m.membershipStatus)}`}>
                                                        {getMemberStatusLabel(m.membershipStatus)}
                                                    </span>
                                                )}
                                                {m.billingProvider && (
                                                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                                                        m.billingProvider === 'stripe' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' :
                                                        m.billingProvider === 'mindbody' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' :
                                                        m.billingProvider === 'comped' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' :
                                                        m.billingProvider === 'family_addon' ? 'bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300' :
                                                        m.billingProvider === 'manual' ? 'bg-gray-100 dark:bg-gray-700/30 text-gray-600 dark:text-gray-300' :
                                                        'bg-gray-100 dark:bg-gray-700/30 text-gray-600 dark:text-gray-300'
                                                    }`}>
                                                        {m.billingProvider === 'family_addon' ? 'Family' : m.billingProvider}
                                                    </span>
                                                )}
                                                {isAdmin && !getDisplayTier(m) && !isMemberPendingUpdate(m.email) && (
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); openAssignTierModal(m); }}
                                                        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-xs font-bold hover:bg-amber-200 dark:hover:bg-amber-500/30 transition-all duration-fast active:scale-95"
                                                    >
                                                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">add_circle</span>
                                                        Assign Tier
                                                    </button>
                                                )}
                                            </div>
                                            {isAdmin && (
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handleViewAs(m); }} 
                                                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-accent/20 text-brand-green dark:bg-accent/30 dark:text-accent text-xs font-bold hover:bg-accent/30 transition-all duration-fast active:scale-95"
                                                >
                                                    <span aria-hidden="true" className="material-symbols-outlined text-[14px]">visibility</span>
                                                    View As
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="hidden md:block relative">
                        <div className="flex items-center bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
                            <SortableHeader field="name" label="Name" width="14%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                            <SortableHeader field="tier" label="Tier" width="11%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                            <div className="px-3 flex items-center self-stretch overflow-hidden font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '9%', minWidth: 0, minHeight: '44px' }}>Status</div>
                            <SortableHeader field="visits" label="Visits" width="9%" className="text-center" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                            <SortableHeader field="joinDate" label="Joined" width="10%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                            <SortableHeader field="lastVisit" label="Last Visit" width="11%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                            <div className="px-3 flex items-center self-stretch overflow-hidden font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '36%', minWidth: 0, minHeight: '44px' }}>Email</div>
                        </div>
                        <div >
                            {visibleItems.map(m => (
                                <div 
                                    key={m.email}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => openDetailsModal(m)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetailsModal(m); } }}
                                    onMouseEnter={() => prefetchMemberProfile(m.email)}
                                    onFocus={() => prefetchMemberProfile(m.email)}
                                    className="flex items-center border-b border-gray-200 dark:border-white/20 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
                                >
                                    <div style={{ width: '14%' }} className="p-3 font-medium text-primary dark:text-white truncate">{m.name}</div>
                                    <div style={{ width: '11%' }} className="p-3">
                                        <div className="flex items-center gap-1 flex-wrap">
                                            <div className="flex items-center gap-1">
                                                <TierBadge tier={getDisplayTier(m)} size="sm" showNoTier={true} membershipStatus={m.membershipStatus} />
                                                {isMemberPendingUpdate(m.email) && (
                                                    <span className="material-symbols-outlined text-[12px] text-primary dark:!text-lavender animate-spin">progress_activity</span>
                                                )}
                                            </div>
                                            {isAdmin && !getDisplayTier(m) && !isMemberPendingUpdate(m.email) && (
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); openAssignTierModal(m); }}
                                                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-[10px] font-bold hover:bg-amber-200 dark:hover:bg-amber-500/30 transition-all duration-fast active:scale-95"
                                                >
                                                    <span aria-hidden="true" className="material-symbols-outlined text-[12px]">add_circle</span>
                                                    Assign
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div style={{ width: '9%' }} className="p-3">
                                        {m.membershipStatus ? (
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getMemberStatusBadgeClass(m.membershipStatus)}`}>
                                                {getMemberStatusLabel(m.membershipStatus)}
                                            </span>
                                        ) : (
                                            <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                                        )}
                                    </div>
                                    <div style={{ width: '9%' }} className="p-3 text-center text-gray-600 dark:text-gray-400 text-sm font-medium">
                                        {m.lifetimeVisits || 0}
                                    </div>
                                    <div style={{ width: '10%' }} className="p-3 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                                        {formatJoinDate(m.joinDate)}
                                    </div>
                                    <div style={{ width: '11%' }} className="p-3 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                                        {formatJoinDate(m.lastBookingDate)}
                                    </div>
                                    <div style={{ width: '36%' }} className="p-3 text-gray-500 dark:text-gray-400 text-sm truncate" title={m.email}>
                                        {m.email}
                                        {m.billingProvider && (
                                            <span className={`ml-1.5 inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                                                m.billingProvider === 'stripe' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' :
                                                m.billingProvider === 'mindbody' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' :
                                                m.billingProvider === 'comped' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' :
                                                m.billingProvider === 'family_addon' ? 'bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300' :
                                                m.billingProvider === 'manual' ? 'bg-gray-100 dark:bg-gray-700/30 text-gray-600 dark:text-gray-300' :
                                                'bg-gray-100 dark:bg-gray-700/30 text-gray-600 dark:text-gray-300'
                                            }`}>
                                                {m.billingProvider === 'family_addon' ? 'Family' : m.billingProvider}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {hasMore && (
                        <div ref={loadMoreRef} className="py-4 flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                            <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
                            <span>Loading more... ({visibleCount} of {totalCount})</span>
                        </div>
                    )}
                </>
            )}
        </>
    );
};

export default ActiveMembersList;
