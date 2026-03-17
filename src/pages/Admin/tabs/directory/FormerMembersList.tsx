import React from 'react';
import type { MemberProfile } from '../../../../contexts/DataContext';
import TierBadge from '../../../../components/TierBadge';
import { DirectoryTabSkeleton } from '../../../../components/skeletons';
import EmptyState from '../../../../components/EmptyState';
import { formatPhoneNumber } from '../../../../utils/formatting';
import { getMemberStatusBadgeClass, getMemberStatusLabel } from '../../../../utils/statusColors';
import { prefetchMemberProfile } from '../../../../lib/prefetch-actions';
import { formatJoinDate } from './directoryTypes';
import SortableHeader from './DirectoryListHeader';
import type { SortField } from './directoryTypes';

interface FormerMembersListProps {
    formerMembers: MemberProfile[];
    formerLoading: boolean;
    formerError: boolean;
    filteredList: MemberProfile[];
    visibleItems: MemberProfile[];
    hasMore: boolean;
    loadMoreRef: React.RefObject<HTMLDivElement | null>;
    totalCount: number;
    visibleCount: number;
    searchQuery: string;
    tierFilter: string;
    statusFilter: string;
    discountFilter: string;
    sortField: SortField;
    handleSort: (field: SortField) => void;
    getSortIcon: (field: SortField) => string;
    openDetailsModal: (m: MemberProfile) => void;
    handleRetryFormer: () => void;
}

const FormerMembersList: React.FC<FormerMembersListProps> = ({
    formerMembers,
    formerLoading,
    formerError,
    filteredList,
    visibleItems,
    hasMore,
    loadMoreRef,
    totalCount,
    visibleCount,
    searchQuery,
    tierFilter,
    statusFilter,
    discountFilter,
    sortField,
    handleSort,
    getSortIcon,
    openDetailsModal,
    handleRetryFormer,
}) => {
    if (formerLoading) {
        return <DirectoryTabSkeleton />;
    }

    if (formerError) {
        return (
            <div className="flex flex-col items-center justify-center py-16 px-6 rounded-xl border-2 border-dashed border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/5">
                <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 text-red-400 dark:text-red-400/70">cloud_off</span>
                <h3 className="text-2xl leading-tight font-bold mb-2 text-red-600 dark:text-red-400" style={{ fontFamily: 'var(--font-headline)' }}>
                    Failed to load former members
                </h3>
                <p className="text-sm text-red-500 dark:text-red-400/80 max-w-sm mx-auto text-center mb-4">
                    There was a problem connecting to the server. Please try again.
                </p>
                <button
                    onClick={handleRetryFormer}
                    className="tactile-btn flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-bold transition-colors"
                >
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">refresh</span>
                    Retry
                </button>
            </div>
        );
    }

    if (formerMembers.length === 0) {
        return (
            <EmptyState
                icon="group"
                title="No former members found"
                description="When members leave or their membership expires, they will appear here"
                variant="compact"
            />
        );
    }

    if (filteredList.length === 0) {
        return (
            <EmptyState
                icon={searchQuery || tierFilter !== 'All' || statusFilter !== 'All' || discountFilter !== 'All' ? 'search_off' : 'group'}
                title={searchQuery || tierFilter !== 'All' || statusFilter !== 'All' || discountFilter !== 'All'
                    ? 'No results found'
                    : 'No former members'}
                description={searchQuery || tierFilter !== 'All' || statusFilter !== 'All' || discountFilter !== 'All'
                    ? 'Try adjusting your search or filters to find what you\'re looking for'
                    : 'Former members will appear here'}
                variant="compact"
            />
        );
    }

    return (
        <>
            <div className="md:hidden relative">
                <div className="pt-2 pb-24">
                    <div className="space-y-3 px-1">
                        {visibleItems.map((m, index) => (
                            <div
                                key={m.email || `member-${index}`}
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
                                            {m.lastTier && (
                                                <span className="flex items-center gap-1">
                                                    <span className="text-[10px] text-gray-400 dark:text-gray-500 italic">was</span>
                                                    <TierBadge tier={m.lastTier} size="sm" />
                                                </span>
                                            )}
                                            {m.membershipStatus && (
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getMemberStatusBadgeClass(m.membershipStatus)}`}>
                                                    {getMemberStatusLabel(m.membershipStatus)}
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
                                <div className="flex items-center justify-between gap-3 mt-3 pt-3 pb-2 border-t border-gray-50 dark:border-white/20">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        <div className="flex items-center gap-1">
                                            <TierBadge tier={m.lastTier || null} size="sm" showNoTier={true} membershipStatus={m.membershipStatus} role={m.role} />
                                        </div>
                                        {m.membershipStatus && (
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getMemberStatusBadgeClass(m.membershipStatus)}`}>
                                                {getMemberStatusLabel(m.membershipStatus)}
                                            </span>
                                        )}
                                    </div>
                                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                        m.stripeCustomerId
                                            ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400'
                                            : 'bg-gray-100 text-gray-500 dark:bg-gray-500/20 dark:text-gray-400'
                                    }`}>
                                        {m.stripeCustomerId ? 'Send Link' : 'New Signup'}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="hidden md:block relative">
                <div className="flex items-center bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
                    <SortableHeader field="name" label="Name" width="14%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                    <SortableHeader field="tier" label="Last Tier" width="11%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                    <div className="px-3 flex items-center self-stretch overflow-hidden font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '9%', minWidth: 0, minHeight: '44px' }}>Status</div>
                    <SortableHeader field="visits" label="Visits" width="9%" className="text-center" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                    <SortableHeader field="joinDate" label="Joined" width="10%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                    <SortableHeader field="lastVisit" label="Last Visit" width="11%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                    <div className="px-3 flex items-center self-stretch overflow-hidden font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '25%', minWidth: 0, minHeight: '44px' }}>Email</div>
                    <div className="px-3 flex items-center self-stretch overflow-hidden font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '11%', minWidth: 0, minHeight: '44px' }}>Reactivation</div>
                </div>
                <div >
                    {visibleItems.map((m, index) => (
                        <div
                            key={m.email || `member-${index}`}
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
                                <div className="flex items-center gap-1">
                                    {m.lastTier ? (
                                        <TierBadge tier={m.lastTier} size="sm" />
                                    ) : (
                                        <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
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
                            <div style={{ width: '25%' }} className="p-3 text-gray-500 dark:text-gray-400 text-sm truncate" title={m.email}>
                                {m.email}
                            </div>
                            <div style={{ width: '11%' }} className="p-3">
                                {m.stripeCustomerId ? (
                                    <span className="px-2 py-1 rounded-full text-[10px] font-bold whitespace-nowrap bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400">
                                        Send Link
                                    </span>
                                ) : (
                                    <span className="px-2 py-1 rounded-full text-[10px] font-bold whitespace-nowrap bg-gray-100 text-gray-500 dark:bg-gray-500/20 dark:text-gray-400">
                                        New Signup
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
    );
};

export default FormerMembersList;
