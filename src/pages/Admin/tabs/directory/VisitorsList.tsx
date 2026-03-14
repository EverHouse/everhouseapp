import React, { useMemo } from 'react';
import { DirectoryTabSkeleton } from '../../../../components/skeletons';
import EmptyState from '../../../../components/EmptyState';
import { formatPhoneNumber } from '../../../../utils/formatting';
import { formatJoinDate } from './directoryTypes';
import type {
    Visitor,
    VisitorType,
    VisitorSource,
    VisitorSortField,
    SortDirection,
} from './directoryTypes';

interface VisitorsListProps {
    visitors: Visitor[];
    visitorsTotal: number;
    visitorsTotalPages: number;
    visitorsLoading: boolean;
    visitorsError: boolean;
    refetchVisitors: () => void;
    visitorSearchQuery: string;
    setVisitorSearchQuery: (q: string) => void;
    visitorTypeFilter: VisitorType;
    setVisitorTypeFilter: (t: VisitorType) => void;
    visitorSourceFilter: VisitorSource;
    setVisitorSourceFilter: (s: VisitorSource) => void;
    visitorSortField: VisitorSortField;
    setVisitorSortField: (f: VisitorSortField) => void;
    visitorSortDirection: SortDirection;
    setVisitorSortDirection: React.Dispatch<React.SetStateAction<SortDirection>>;
    visitorsPage: number;
    setVisitorsPage: React.Dispatch<React.SetStateAction<number>>;
    visitorArchiveView: 'active' | 'archived';
    setVisitorArchiveView: (v: 'active' | 'archived') => void;
    purchaseFilter: 'all' | 'purchasers' | 'non-purchasers';
    setPurchaseFilter: (f: 'all' | 'purchasers' | 'non-purchasers') => void;
    filtersOpen: boolean;
    setFiltersOpen: (v: boolean) => void;
    filterPopoverRef: React.RefObject<HTMLDivElement | null>;
    activeFilters: Array<{ key: string; label: string; onRemove: () => void }>;
    activeFilterCount: number;
    clearAllFilters: () => void;
    openVisitorDetails: (v: Visitor) => void;
}

const VisitorsList: React.FC<VisitorsListProps> = ({
    visitors,
    visitorsTotal,
    visitorsTotalPages,
    visitorsLoading,
    visitorsError,
    refetchVisitors,
    visitorSearchQuery,
    setVisitorSearchQuery,
    visitorTypeFilter,
    setVisitorTypeFilter,
    visitorSourceFilter,
    setVisitorSourceFilter,
    visitorSortField,
    setVisitorSortField,
    visitorSortDirection,
    setVisitorSortDirection,
    visitorsPage,
    setVisitorsPage,
    visitorArchiveView,
    setVisitorArchiveView,
    purchaseFilter,
    setPurchaseFilter,
    filtersOpen,
    setFiltersOpen,
    filterPopoverRef,
    activeFilters,
    activeFilterCount,
    clearAllFilters,
    openVisitorDetails,
}) => {
    const sortedVisitors = useMemo(() => {
        const sorted = [...visitors];
        sorted.sort((a, b) => {
            let comparison = 0;
            switch (visitorSortField) {
                case 'name': {
                    const nameA = [a.firstName, a.lastName].filter(Boolean).join(' ').toLowerCase();
                    const nameB = [b.firstName, b.lastName].filter(Boolean).join(' ').toLowerCase();
                    if (!nameA && !nameB) comparison = 0;
                    else if (!nameA) comparison = 1;
                    else if (!nameB) comparison = -1;
                    else comparison = nameA.localeCompare(nameB);
                    break;
                    }
                case 'email': {
                    const emailA = (a.email || '').toLowerCase();
                    const emailB = (b.email || '').toLowerCase();
                    if (!emailA && !emailB) comparison = 0;
                    else if (!emailA) comparison = 1;
                    else if (!emailB) comparison = -1;
                    else comparison = emailA.localeCompare(emailB);
                    break;
                    }
                case 'type': {
                    const typeA = a.type || '';
                    const typeB = b.type || '';
                    if (!typeA && !typeB) comparison = 0;
                    else if (!typeA) comparison = 1;
                    else if (!typeB) comparison = -1;
                    else comparison = typeA.localeCompare(typeB);
                    break;
                    }
                case 'source': {
                    const sourceA = a.source || '';
                    const sourceB = b.source || '';
                    if (!sourceA && !sourceB) comparison = 0;
                    else if (!sourceA) comparison = 1;
                    else if (!sourceB) comparison = -1;
                    else comparison = sourceA.localeCompare(sourceB);
                    break;
                    }
                case 'lastActivity': {
                    const dateStrA = a.lastActivityAt || a.lastPurchaseDate || a.lastGuestDate;
                    const dateStrB = b.lastActivityAt || b.lastPurchaseDate || b.lastGuestDate;
                    const timestampA = dateStrA ? Date.parse(dateStrA) : NaN;
                    const timestampB = dateStrB ? Date.parse(dateStrB) : NaN;
                    const validA = !isNaN(timestampA);
                    const validB = !isNaN(timestampB);
                    if (!validA && !validB) comparison = 0;
                    else if (!validA) comparison = 1;
                    else if (!validB) comparison = -1;
                    else comparison = timestampA - timestampB;
                    break;
                    }
                case 'purchases':
                    comparison = (a.purchaseCount || 0) - (b.purchaseCount || 0);
                    break;
                case 'createdAt': {
                    const createdA = a.createdAt ? Date.parse(a.createdAt) : NaN;
                    const createdB = b.createdAt ? Date.parse(b.createdAt) : NaN;
                    const createdValidA = !isNaN(createdA);
                    const createdValidB = !isNaN(createdB);
                    if (!createdValidA && !createdValidB) comparison = 0;
                    else if (!createdValidA) comparison = 1;
                    else if (!createdValidB) comparison = -1;
                    else comparison = createdA - createdB;
                    break;
                    }
            }
            return visitorSortDirection === 'asc' ? comparison : -comparison;
        });
        if (purchaseFilter === 'purchasers') {
            return sorted.filter(v => v.purchaseCount > 0);
        }
        if (purchaseFilter === 'non-purchasers') {
            return sorted.filter(v => !v.purchaseCount || v.purchaseCount === 0);
        }
        return sorted;
    }, [visitors, visitorSortField, visitorSortDirection, purchaseFilter]);

    return (
        <>
            <div className="space-y-3 mb-4">
                <div className="flex gap-2 relative" ref={filterPopoverRef}>
                    <div className="relative flex-1">
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-white/40 text-[20px]">search</span>
                        <input
                            type="text"
                            value={visitorSearchQuery}
                            onChange={(e) => setVisitorSearchQuery(e.target.value)}
                            placeholder="Search by name, email, or phone..."
                            className="w-full h-[44px] pl-10 pr-4 text-sm rounded-xl border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-gray-800 dark:text-white placeholder-gray-400 dark:placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-primary/50"
                            aria-label="Search visitors"
                        />
                        {visitorSearchQuery && (
                            <button
                                onClick={() => setVisitorSearchQuery('')}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-white/40 dark:hover:text-white/70 cursor-pointer"
                                aria-label="Clear search"
                            >
                                <span className="material-symbols-outlined text-[18px]">close</span>
                            </button>
                        )}
                    </div>
                    <button
                        onClick={() => setFiltersOpen(!filtersOpen)}
                        className={`px-3 h-[44px] rounded-xl border text-sm font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
                            activeFilterCount > 0
                                ? 'border-lavender/50 text-[#293515] dark:!text-[#CCB8E4] bg-primary/5 dark:bg-lavender/5 hover:bg-primary/10 dark:hover:bg-lavender/10'
                                : 'border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/10'
                        }`}
                        aria-label="Toggle filters"
                    >
                        <span className="material-symbols-outlined text-[18px]">filter_list</span>
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
                                <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">View</span>
                                <div className="flex rounded-lg border border-gray-200 dark:border-white/20 overflow-hidden w-fit">
                                    <button
                                        onClick={() => { setVisitorArchiveView('active'); setVisitorsPage(1); }}
                                        className={`tactile-btn px-3 py-1.5 text-sm font-medium transition-colors ${
                                            visitorArchiveView === 'active'
                                                ? 'bg-primary text-white'
                                                : 'bg-white dark:bg-surface-dark text-gray-600 dark:text-white/60 hover:bg-gray-50 dark:hover:bg-white/5'
                                        }`}
                                    >
                                        Active
                                    </button>
                                    <button
                                        onClick={() => { setVisitorArchiveView('archived'); setVisitorsPage(1); }}
                                        className={`tactile-btn px-3 py-1.5 text-sm font-medium transition-colors ${
                                            visitorArchiveView === 'archived'
                                                ? 'bg-primary text-white'
                                                : 'bg-white dark:bg-surface-dark text-gray-600 dark:text-white/60 hover:bg-gray-50 dark:hover:bg-white/5'
                                        }`}
                                    >
                                        Archived
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">Type</span>
                                <select
                                    value={visitorTypeFilter}
                                    onChange={(e) => { setVisitorTypeFilter(e.target.value as VisitorType); setVisitorsPage(1); }}
                                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/20 bg-white dark:bg-surface-dark text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                                    aria-label="Filter by type"
                                >
                                    <option value="all">All Types</option>
                                    <option value="NEW">New (Staff Added)</option>
                                    <option value="classpass">ClassPass</option>
                                    <option value="sim_walkin">Sim Walk-In</option>
                                    <option value="private_lesson">Private Lesson</option>
                                    <option value="day_pass">Day Pass</option>
                                    <option value="guest">Guests</option>
                                    <option value="lead">Leads</option>
                                </select>
                            </div>

                            <div className="space-y-1.5">
                                <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">Source</span>
                                <select
                                    value={visitorSourceFilter}
                                    onChange={(e) => { setVisitorSourceFilter(e.target.value as VisitorSource); setVisitorsPage(1); }}
                                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/20 bg-white dark:bg-surface-dark text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                                    aria-label="Filter by source"
                                >
                                    <option value="all">All Sources</option>
                                    <option value="APP">App (Staff Added)</option>
                                    <option value="hubspot">HubSpot</option>
                                    <option value="mindbody">MindBody</option>
                                    <option value="stripe">Stripe</option>
                                </select>
                            </div>

                            <div className="space-y-1.5">
                                <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase">Purchases</span>
                                <div className="flex flex-wrap gap-1.5">
                                    {(['all', 'purchasers', 'non-purchasers'] as const).map(option => (
                                        <button
                                            key={option}
                                            onClick={() => { setPurchaseFilter(option); setVisitorsPage(1); }}
                                            className={`tactile-btn px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
                                                purchaseFilter === option
                                                    ? 'bg-primary dark:bg-lavender text-white'
                                                    : 'bg-gray-200 dark:bg-white/15 text-gray-400 dark:text-white/40 hover:bg-gray-300 dark:hover:bg-white/30'
                                            }`}
                                        >
                                            {option === 'all' ? 'All' : option === 'purchasers' ? 'Purchasers' : 'Non-Purchasers'}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                {activeFilters.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {activeFilters.map(filter => (
                            <span key={filter.key} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-primary/10 dark:bg-lavender/10 text-primary dark:!text-lavender border border-primary/20 dark:border-lavender/20">
                                {filter.label}
                                <button onClick={filter.onRemove} className="hover:text-red-500 transition-colors ml-0.5 cursor-pointer" aria-label={`Remove ${filter.label} filter`}>
                                    <span className="material-symbols-outlined text-[12px]">close</span>
                                </button>
                            </span>
                        ))}
                    </div>
                )}

                <span className="text-sm text-gray-500 dark:text-white/60">
                    {visitorsTotal.toLocaleString('en-US')} {visitorArchiveView === 'archived' ? 'archived' : ''} contacts
                </span>
            </div>

            {visitorsLoading && (
                <DirectoryTabSkeleton />
            )}

            {!visitorsLoading && visitorsError && (
                <div className="flex flex-col items-center justify-center py-16 px-6 rounded-xl border-2 border-dashed border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/5">
                    <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 text-red-400 dark:text-red-400/70">cloud_off</span>
                    <h3 className="text-2xl leading-tight font-bold mb-2 text-red-600 dark:text-red-400" style={{ fontFamily: 'var(--font-headline)' }}>
                        Failed to load visitors
                    </h3>
                    <p className="text-sm text-red-500 dark:text-red-400/80 max-w-sm mx-auto text-center mb-4">
                        There was a problem connecting to the server. Please try again.
                    </p>
                    <button
                        onClick={() => refetchVisitors()}
                        className="tactile-btn flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-bold transition-colors"
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[18px]">refresh</span>
                        Retry
                    </button>
                </div>
            )}

            {!visitorsLoading && !visitorsError && visitors.length === 0 && (
                <EmptyState
                    icon="group"
                    title="No contacts found"
                    description={visitorTypeFilter !== 'all' || visitorSourceFilter !== 'all'
                        ? 'Try adjusting your filters to find contacts'
                        : 'Non-member contacts, day pass buyers, and leads will appear here'}
                    variant="compact"
                />
            )}

            {!visitorsLoading && !visitorsError && visitors.length > 0 && (
                <div className="md:hidden flex-1 min-h-0 relative">
                    <div className="h-full overflow-y-auto pt-2 pb-24">
                        <div className="space-y-3 px-1">
                            {sortedVisitors.map((v, index) => (
                                <div
                                    key={v.id ?? `visitor-${index}`}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => openVisitorDetails(v)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVisitorDetails(v); } }}
                                    className={`tactile-row bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.98] ${index < 10 ? `animate-list-item-delay-${index}` : 'animate-list-item'}`}
                                >
                                    <div className="flex justify-between items-start mb-2">
                                        <div className="flex-1">
                                            <h4 className="font-bold text-lg text-primary dark:text-white">
                                                {[v.firstName, v.lastName].filter(Boolean).join(' ') || 'Unknown'}
                                            </h4>
                                            {v.email && <p className="text-xs text-gray-500 dark:text-gray-400">{v.email}</p>}
                                            {v.phone && <p className="text-xs text-gray-500 dark:text-gray-400">{formatPhoneNumber(v.phone)}</p>}
                                        </div>
                                        <div className="text-right">
                                            <p className="text-xs text-gray-500 dark:text-gray-400">{v.purchaseCount || 0} purchase{v.purchaseCount !== 1 ? 's' : ''}</p>
                                            {(v.lastActivityAt || v.lastPurchaseDate) && <p className="text-xs text-gray-500 dark:text-gray-400">Last: {formatJoinDate(v.lastActivityAt || v.lastPurchaseDate)}</p>}
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-gray-50 dark:border-white/20">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                v.type === 'classpass'
                                                    ? 'bg-[#e8ecd8] dark:bg-[#6b7a3d]/20 text-[#5a6a2c] dark:text-[#a8b87a]'
                                                    : v.type === 'sim_walkin'
                                                    ? 'bg-[#e8ecd8] dark:bg-[#6b7a3d]/20 text-[#5a6a2c] dark:text-[#a8b87a]'
                                                    : v.type === 'private_lesson'
                                                    ? 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-400'
                                                    : v.type === 'day_pass'
                                                    ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400'
                                                    : v.type === 'guest'
                                                    ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400'
                                                    : 'bg-gray-100 dark:bg-gray-500/20 text-gray-600 dark:text-gray-400'
                                            }`}>
                                                {v.type === 'classpass' ? 'ClassPass'
                                                    : v.type === 'sim_walkin' ? 'Sim Walk-In'
                                                    : v.type === 'private_lesson' ? 'Private Lesson'
                                                    : v.type === 'day_pass' ? 'Day Pass'
                                                    : v.type === 'guest' ? 'Guest'
                                                    : 'Lead'}
                                            </span>
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                v.source === 'hubspot' ? 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400' :
                                                v.source === 'stripe' ? 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400' :
                                                v.source === 'mindbody' ? 'bg-teal-100 dark:bg-teal-500/20 text-teal-700 dark:text-teal-400' :
                                                'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400'
                                            }`}>
                                                {v.source === 'hubspot' ? 'HubSpot' : v.source === 'stripe' ? 'Stripe' : v.source === 'mindbody' ? 'MindBody' : 'App'}
                                            </span>
                                            {v.totalSpentCents > 0 && (
                                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                                    ${(v.totalSpentCents / 100).toFixed(2)} spent
                                                </span>
                                            )}
                                        </div>
                                        <span className="material-symbols-outlined text-gray-400 text-[16px]">chevron_right</span>
                                    </div>
                                </div>
                            ))}
                            {visitorsTotalPages > 1 && (
                                <div className="py-4 flex items-center justify-center gap-4">
                                    <button
                                        onClick={() => setVisitorsPage(p => Math.max(1, p - 1))}
                                        disabled={visitorsPage <= 1 || visitorsLoading}
                                        className="tactile-btn px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        Previous
                                    </button>
                                    <span className="text-sm text-gray-600 dark:text-gray-400">
                                        Page {visitorsPage} of {visitorsTotalPages}
                                    </span>
                                    <button
                                        onClick={() => setVisitorsPage(p => Math.min(visitorsTotalPages, p + 1))}
                                        disabled={visitorsPage >= visitorsTotalPages || visitorsLoading}
                                        className="tactile-btn px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        Next
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {!visitorsLoading && !visitorsError && visitors.length > 0 && (
                <div className="hidden md:block flex-1 min-h-0 relative">
                    <div className="h-full overflow-y-auto">
                        <table className="w-full" style={{ tableLayout: 'fixed' }}>
                            <colgroup>
                                <col style={{ width: '20%' }} />
                                <col style={{ width: '28%' }} />
                                <col style={{ width: '12%' }} />
                                <col style={{ width: '14%' }} />
                                <col style={{ width: '12%' }} />
                                <col style={{ width: '14%' }} />
                            </colgroup>
                            <thead className="sticky top-0 z-10">
                                <tr>
                                    <td colSpan={6} className="p-0">
                                        <div className="flex items-center bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
                                            {([
                                                ['name', 'Name', '20%'],
                                                ['email', 'Email', '28%'],
                                                ['type', 'Type', '12%'],
                                                ['source', 'Source', '14%'],
                                                ['purchases', 'Purchases', '12%'],
                                                ['lastActivity', 'Last Activity', '14%'],
                                            ] as [VisitorSortField, string, string][]).map(([field, label, width]) => (
                                                <div
                                                    key={field + label}
                                                    style={{ width }}
                                                    className="px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase cursor-pointer hover:bg-gray-100 dark:hover:bg-white/10 transition-colors select-none tactile-btn"
                                                    role="button"
                                                    tabIndex={0}
                                                    onClick={() => {
                                                        if (visitorSortField === field) {
                                                            setVisitorSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                                                        } else {
                                                            setVisitorSortField(field);
                                                            setVisitorSortDirection(field === 'name' || field === 'email' || field === 'type' || field === 'source' ? 'asc' : 'desc');
                                                        }
                                                    }}
                                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (visitorSortField === field) { setVisitorSortDirection(prev => prev === 'asc' ? 'desc' : 'asc'); } else { setVisitorSortField(field); setVisitorSortDirection(field === 'name' || field === 'email' || field === 'type' || field === 'source' ? 'asc' : 'desc'); } } }}
                                                >
                                                    <div className="flex items-center gap-1 whitespace-nowrap">
                                                        {label}
                                                        {visitorSortField === field && (
                                                            <span className="material-symbols-outlined text-[14px] text-[#293515] dark:!text-[#CCB8E4]">
                                                                {visitorSortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </td>
                                </tr>
                            </thead>
                            <tbody >
                                {sortedVisitors.map((v, index) => (
                                    <tr
                                        key={v.id ?? `visitor-${index}`}
                                        tabIndex={0}
                                        role="button"
                                        onClick={() => openVisitorDetails(v)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVisitorDetails(v); } }}
                                        className="border-b border-gray-100 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
                                    >
                                        <td style={{ width: '20%' }} className="p-3 font-medium text-primary dark:text-white">
                                            {[v.firstName, v.lastName].filter(Boolean).join(' ') || 'Unknown'}
                                        </td>
                                        <td style={{ width: '28%' }} className="p-3 text-sm text-gray-600 dark:text-gray-400 truncate max-w-0">{v.email || '-'}</td>
                                        <td style={{ width: '12%' }} className="p-3">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                v.type === 'classpass'
                                                    ? 'bg-[#e8ecd8] dark:bg-[#6b7a3d]/20 text-[#5a6a2c] dark:text-[#a8b87a]'
                                                    : v.type === 'sim_walkin'
                                                    ? 'bg-[#e8ecd8] dark:bg-[#6b7a3d]/20 text-[#5a6a2c] dark:text-[#a8b87a]'
                                                    : v.type === 'private_lesson'
                                                    ? 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-400'
                                                    : v.type === 'day_pass'
                                                    ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400'
                                                    : v.type === 'guest'
                                                    ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400'
                                                    : 'bg-gray-100 dark:bg-gray-500/20 text-gray-600 dark:text-gray-400'
                                            }`}>
                                                {v.type === 'classpass' ? 'ClassPass'
                                                    : v.type === 'sim_walkin' ? 'Sim Walk-In'
                                                    : v.type === 'private_lesson' ? 'Private Lesson'
                                                    : v.type === 'day_pass' ? 'Day Pass'
                                                    : v.type === 'guest' ? 'Guest'
                                                    : 'Lead'}
                                            </span>
                                        </td>
                                        <td style={{ width: '14%' }} className="p-3">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                v.source === 'hubspot' ? 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400' :
                                                v.source === 'stripe' ? 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400' :
                                                v.source === 'mindbody' ? 'bg-teal-100 dark:bg-teal-500/20 text-teal-700 dark:text-teal-400' :
                                                'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400'
                                            }`}>
                                                {v.source === 'hubspot' ? 'HubSpot' : v.source === 'stripe' ? 'Stripe' : v.source === 'mindbody' ? 'MindBody' : 'App'}
                                            </span>
                                        </td>
                                        <td style={{ width: '12%' }} className="p-3 text-sm text-gray-600 dark:text-gray-400">{v.purchaseCount || 0}</td>
                                        <td style={{ width: '14%' }} className="p-3 text-sm text-gray-500 dark:text-gray-400">{formatJoinDate(v.lastActivityAt || v.lastPurchaseDate)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {visitorsTotalPages > 1 && (
                            <div className="py-4 flex items-center justify-center gap-4 border-t border-gray-200 dark:border-white/20">
                                <button
                                    onClick={() => setVisitorsPage(p => Math.max(1, p - 1))}
                                    disabled={visitorsPage <= 1 || visitorsLoading}
                                    className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Previous
                                </button>
                                <span className="text-sm text-gray-600 dark:text-gray-400">
                                    Page {visitorsPage} of {visitorsTotalPages}
                                </span>
                                <button
                                    onClick={() => setVisitorsPage(p => Math.min(visitorsTotalPages, p + 1))}
                                    disabled={visitorsPage >= visitorsTotalPages || visitorsLoading}
                                    className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Next
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
};

export default VisitorsList;
