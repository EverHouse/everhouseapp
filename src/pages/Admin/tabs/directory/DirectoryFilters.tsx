import React from 'react';
import { getTierColor } from '../../../../utils/tierUtils';
import { getMemberStatusLabel, getMemberStatusBadgeClass } from '../../../../utils/statusColors';
import {
    type MemberTab,
    type BillingFilter,
    type SortField,
    type SortDirection,
    BILLING_OPTIONS,
    SORT_OPTIONS,
} from './directoryTypes';
import { useTierNames } from '../../../../hooks/useTierNames';
import { MEMBERSHIP_STATUS } from '../../../../../shared/constants/statuses';
import Icon from '../../../../components/icons/Icon';

interface DirectoryFiltersProps {
    memberTab: MemberTab;
    searchQuery: string;
    setSearchQuery: (q: string) => void;
    tierFilter: string;
    setTierFilter: (t: string) => void;
    statusFilter: string;
    setStatusFilter: (s: string) => void;
    membershipStatusFilter: string;
    setMembershipStatusFilter: (s: string) => void;
    appUsageFilter: 'All' | 'Logged In' | 'Never Logged In';
    setAppUsageFilter: (f: 'All' | 'Logged In' | 'Never Logged In') => void;
    billingFilter: BillingFilter;
    setBillingFilter: (f: BillingFilter) => void;
    discountFilter: string;
    setDiscountFilter: (f: string) => void;
    showMissingTierOnly: boolean;
    setShowMissingTierOnly: (v: boolean) => void;
    showRecentlyAdded: boolean;
    setShowRecentlyAdded: (v: boolean) => void;
    sortField: SortField;
    setSortField: (f: SortField) => void;
    sortDirection: SortDirection;
    setSortDirection: React.Dispatch<React.SetStateAction<SortDirection>>;
    filtersOpen: boolean;
    setFiltersOpen: (v: boolean) => void;
    filterPopoverRef: React.RefObject<HTMLDivElement | null>;
    sortOpen: boolean;
    setSortOpen: (v: boolean) => void;
    sortPopoverRef: React.RefObject<HTMLDivElement | null>;
    activeFilters: Array<{ key: string; label: string; onRemove: () => void }>;
    activeFilterCount: number;
    clearAllFilters: () => void;
    discountCodes: string[];
    filteredListLength: number;
    teamSearchQuery: string;
    setTeamSearchQuery: (q: string) => void;
    filteredTeamMembersLength: number;
    visitorsLength: number;
    visitorsTotal: number;
}

const DirectoryFilters: React.FC<DirectoryFiltersProps> = ({
    memberTab,
    searchQuery, setSearchQuery,
    tierFilter, setTierFilter,
    statusFilter, setStatusFilter,
    membershipStatusFilter, setMembershipStatusFilter,
    appUsageFilter, setAppUsageFilter,
    billingFilter, setBillingFilter,
    discountFilter, setDiscountFilter,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showMissingTierOnly, setShowMissingTierOnly,
    showRecentlyAdded, setShowRecentlyAdded,
    sortField, setSortField,
    sortDirection, setSortDirection,
    filtersOpen, setFiltersOpen,
    filterPopoverRef,
    sortOpen, setSortOpen,
    sortPopoverRef,
    activeFilters,
    activeFilterCount,
    clearAllFilters,
    discountCodes,
    filteredListLength,
    teamSearchQuery, setTeamSearchQuery,
    filteredTeamMembersLength,
    visitorsLength,
    visitorsTotal,
}) => {
    const { tiers } = useTierNames();
    return (
        <div className="mb-6 space-y-3 animate-content-enter-delay-1 sticky top-0 z-10 bg-transparent pt-2 pb-3">
            {memberTab !== 'visitors' && memberTab !== 'team' && (
                <div className="flex gap-2 relative" ref={filterPopoverRef}>
                    <div className="relative flex-1">
                        <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 text-[20px]" />
                        <input
                            type="text"
                            placeholder="Search members..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full h-[44px] pl-10 pr-4 rounded-xl border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                    </div>
                    <div className="relative" ref={sortPopoverRef}>
                        <button
                            onClick={() => { setSortOpen(!sortOpen); setFiltersOpen(false); }}
                            className={`flex items-center justify-center w-[44px] h-[44px] rounded-xl border text-sm font-medium transition-colors cursor-pointer ${
                                sortOpen
                                    ? 'border-lavender/50 text-[#293515] dark:!text-[#CCB8E4] bg-primary/5 dark:bg-lavender/5'
                                    : 'border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/10'
                            }`}
                            aria-label="Sort options"
                            title="Sort"
                        >
                            <Icon name="swap_vert" className="text-[20px]" />
                        </button>
                        <div className={`absolute right-0 top-full mt-1 glass-panel rounded-xl p-2 z-30 min-w-[180px] !bg-[#f5f5f0] dark:!bg-[#1a1a1a] transition-[opacity,transform] duration-[250ms] ease-m3-emphasized-decel ${
                                sortOpen ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-1 scale-[0.97] pointer-events-none'
                            }`}>
                                <div className="flex items-center justify-between px-2 py-1 mb-1">
                                    <span className="text-[11px] font-bold text-gray-500 dark:text-white/50 uppercase tracking-wider">Sort By</span>
                                    <button
                                        onClick={() => setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')}
                                        className="tactile-btn flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
                                        title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                                    >
                                        <Icon name={sortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'} className="text-[14px]" />
                                        {sortDirection === 'asc' ? 'Asc' : 'Desc'}
                                    </button>
                                </div>
                                {SORT_OPTIONS.map(option => (
                                    <button
                                        key={option.value}
                                        onClick={() => { setSortField(option.value as SortField); setSortOpen(false); }}
                                        className={`w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors cursor-pointer ${
                                            sortField === option.value
                                                ? 'bg-primary/10 dark:bg-lavender/15 text-[#293515] dark:!text-[#CCB8E4] font-medium'
                                                : 'text-gray-700 dark:text-white/80 hover:bg-gray-100 dark:hover:bg-white/10'
                                        }`}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                        </div>
                    </div>
                    <button
                        onClick={() => { setFiltersOpen(!filtersOpen); setSortOpen(false); }}
                        className={`px-3 h-[44px] rounded-xl border text-sm font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
                            activeFilterCount > 0
                                ? 'border-lavender/50 text-[#293515] dark:!text-[#CCB8E4] bg-primary/5 dark:bg-lavender/5 hover:bg-primary/10 dark:hover:bg-lavender/10'
                                : 'border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/10'
                        }`}
                        aria-label="Toggle filters"
                    >
                        <Icon name="filter_list" className="text-[18px]" />
                        <span className="hidden sm:inline">Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}</span>
                        {activeFilterCount > 0 && <span className="sm:hidden min-w-[18px] h-[18px] rounded-full bg-primary dark:bg-lavender text-white text-[10px] font-bold flex items-center justify-center">{activeFilterCount}</span>}
                    </button>

                    <div className={`absolute left-0 right-0 top-full mt-1 glass-panel rounded-xl p-4 space-y-3 z-30 !bg-[#f5f5f0] dark:!bg-[#1a1a1a] transition-[opacity,transform] duration-[250ms] ease-m3-emphasized-decel ${
                            filtersOpen ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-1 scale-[0.97] pointer-events-none'
                        }`}>
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-gray-500 dark:text-white/50 uppercase tracking-wider">Filters</span>
                                {activeFilterCount > 0 && (
                                    <button onClick={() => { clearAllFilters(); }} className="text-xs text-primary dark:!text-lavender hover:underline font-medium cursor-pointer">
                                        Clear All
                                    </button>
                                )}
                            </div>

                            <div className="space-y-1.5">
                                <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">{memberTab === 'former' ? 'Last Tier' : 'Tier'}</span>
                                <div className="flex flex-wrap gap-1.5">
                                    {(['All', ...tiers] as string[]).map(tier => {
                                        const isSelected = tierFilter === tier;
                                        const colors = tier !== 'All' ? getTierColor(tier) : { bg: '', text: '', border: '' };
                                        return (
                                            <button
                                                key={tier}
                                                onClick={() => { setTierFilter(tier); setShowMissingTierOnly(false); }}
                                                className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-all duration-fast flex-shrink-0 whitespace-nowrap ${
                                                    tier === 'All' 
                                                        ? isSelected 
                                                            ? 'bg-primary dark:bg-lavender text-white' 
                                                            : 'bg-gray-200 dark:bg-white/15 text-gray-400 dark:text-white/40'
                                                        : !isSelected
                                                            ? 'bg-gray-200 dark:bg-white/10 text-gray-500 dark:text-white/60 border border-gray-300 dark:border-white/10'
                                                            : ''
                                                }`}
                                                style={tier !== 'All' && isSelected ? {
                                                    backgroundColor: colors.bg,
                                                    color: colors.text,
                                                    border: `1px solid ${colors.border}`,
                                                } : undefined}
                                            >
                                                {tier}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {memberTab === 'active' && (
                                <div className="space-y-1.5">
                                    <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">Status</span>
                                    <div className="flex flex-wrap gap-1.5">
                                        <button
                                            onClick={() => setMembershipStatusFilter('All')}
                                            className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
                                                membershipStatusFilter === 'All'
                                                    ? 'bg-primary dark:bg-lavender text-white'
                                                    : 'bg-gray-200 dark:bg-white/15 text-gray-400 dark:text-white/40 hover:bg-gray-300 dark:hover:bg-white/30'
                                            }`}
                                        >
                                            All
                                        </button>
                                        {([MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.TRIALING, MEMBERSHIP_STATUS.PAST_DUE, MEMBERSHIP_STATUS.GRACE_PERIOD, MEMBERSHIP_STATUS.PAUSED, MEMBERSHIP_STATUS.PENDING] as const).map(status => (
                                            <button
                                                key={status}
                                                onClick={() => setMembershipStatusFilter(status)}
                                                className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
                                                    membershipStatusFilter === status
                                                        ? getMemberStatusBadgeClass(status)
                                                        : 'bg-gray-200 dark:bg-white/15 text-gray-400 dark:text-white/40 hover:bg-gray-300 dark:hover:bg-white/30'
                                                }`}
                                            >
                                                {getMemberStatusLabel(status)}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {memberTab === 'active' && (
                                <div className="space-y-1.5">
                                    <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">App</span>
                                    <div className="flex flex-wrap gap-1.5">
                                        {(['All', 'Logged In', 'Never Logged In'] as const).map(option => (
                                            <button
                                                key={option}
                                                onClick={() => setAppUsageFilter(option)}
                                                className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
                                                    appUsageFilter === option
                                                        ? 'bg-primary dark:bg-lavender text-white'
                                                        : 'bg-gray-200 dark:bg-white/15 text-gray-400 dark:text-white/40 hover:bg-gray-300 dark:hover:bg-white/30'
                                                }`}
                                            >
                                                {option}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {memberTab === 'former' && (
                                <div className="space-y-1.5">
                                    <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">Status</span>
                                    <div className="flex flex-wrap gap-1.5">
                                        <button
                                            onClick={() => setStatusFilter('All')}
                                            className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
                                                statusFilter === 'All'
                                                    ? 'bg-orange-500 text-white'
                                                    : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                                            }`}
                                        >
                                            All
                                        </button>
                                        {([MEMBERSHIP_STATUS.TERMINATED, MEMBERSHIP_STATUS.EXPIRED, MEMBERSHIP_STATUS.SUSPENDED, MEMBERSHIP_STATUS.CANCELLED, MEMBERSHIP_STATUS.FROZEN, MEMBERSHIP_STATUS.INACTIVE, MEMBERSHIP_STATUS.FORMER_MEMBER] as const).map(status => (
                                            <button
                                                key={status}
                                                onClick={() => setStatusFilter(status)}
                                                className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
                                                    statusFilter === status
                                                        ? 'bg-orange-500 text-white'
                                                        : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                                                }`}
                                            >
                                                {getMemberStatusLabel(status)}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {memberTab === 'active' && (
                                <div className="space-y-1.5">
                                    <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">Quick Filters</span>
                                    <div className="flex flex-wrap gap-1.5">
                                        <button
                                            onClick={() => setShowRecentlyAdded(!showRecentlyAdded)}
                                            className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap flex items-center gap-1 ${
                                                showRecentlyAdded
                                                    ? 'bg-blue-600 text-white'
                                                    : 'bg-gray-200 dark:bg-white/15 text-gray-400 dark:text-white/40 hover:bg-gray-300 dark:hover:bg-white/30'
                                            }`}
                                        >
                                            <Icon name="schedule" className="text-[12px]" />
                                            Recently Added (24h)
                                        </button>
                                    </div>
                                </div>
                            )}

                            <div className="space-y-1.5">
                                <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">Billing</span>
                                <div className="flex flex-wrap gap-1.5">
                                    {BILLING_OPTIONS.map(option => (
                                        <button
                                            key={option}
                                            onClick={() => setBillingFilter(option)}
                                            className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
                                                billingFilter === option
                                                    ? 'bg-primary dark:bg-lavender text-white'
                                                    : 'bg-gray-200 dark:bg-white/15 text-gray-400 dark:text-white/40 hover:bg-gray-300 dark:hover:bg-white/30'
                                            }`}
                                        >
                                            {option}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {discountCodes.length > 0 && (
                                <div className="space-y-1.5">
                                    <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">Discount</span>
                                    <div className="flex flex-wrap gap-1.5">
                                        <button
                                            onClick={() => setDiscountFilter('All')}
                                            className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
                                                discountFilter === 'All'
                                                    ? 'bg-primary dark:bg-lavender text-white'
                                                    : 'bg-gray-200 dark:bg-white/15 text-gray-400 dark:text-white/40 hover:bg-gray-300 dark:hover:bg-white/30'
                                            }`}
                                        >
                                            All
                                        </button>
                                        {discountCodes.map(code => (
                                            <button
                                                key={code}
                                                onClick={() => setDiscountFilter(code)}
                                                className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
                                                    discountFilter === code
                                                        ? 'bg-purple-600 text-white'
                                                        : 'bg-gray-200 dark:bg-white/15 text-gray-400 dark:text-white/40 hover:bg-gray-300 dark:hover:bg-white/30'
                                                }`}
                                            >
                                                {code}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                </div>
            )}

            {memberTab === 'team' && (
                <div className="relative">
                    <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 text-[20px]" />
                    <input
                        type="text"
                        placeholder="Search team members..."
                        value={teamSearchQuery}
                        onChange={(e) => setTeamSearchQuery(e.target.value)}
                        className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                </div>
            )}


            {activeFilters.length > 0 && memberTab !== 'visitors' && (
                <div className="flex flex-wrap gap-1.5">
                    {activeFilters.map(filter => (
                        <span key={filter.key} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-primary/10 dark:bg-lavender/10 text-primary dark:!text-lavender border border-primary/20 dark:border-lavender/20">
                            {filter.label}
                            <button onClick={filter.onRemove} className="hover:text-red-500 transition-colors ml-0.5 cursor-pointer" aria-label={`Remove ${filter.label} filter`}>
                                <Icon name="close" className="text-[12px]" />
                            </button>
                        </span>
                    ))}
                </div>
            )}

            <p className="text-xs text-gray-500 dark:text-gray-400">
                {memberTab === 'visitors' 
                    ? `Showing ${visitorsLength} of ${visitorsTotal.toLocaleString('en-US')} visitor${visitorsTotal !== 1 ? 's' : ''}`
                    : memberTab === 'team'
                    ? `${filteredTeamMembersLength} team member${filteredTeamMembersLength !== 1 ? 's' : ''}`
                    : `${filteredListLength} ${memberTab === 'former' ? 'former ' : ''}member${filteredListLength !== 1 ? 's' : ''} found`
                }
            </p>
        </div>
    );
};

export default DirectoryFilters;
