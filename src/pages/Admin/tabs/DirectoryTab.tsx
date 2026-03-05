import React, { useState, useCallback, type ErrorInfo } from 'react';
import { createPortal } from 'react-dom';
import FeatureErrorBoundary from '../../../components/FeatureErrorBoundary';
import { useNavigate } from 'react-router-dom';
import { useData, MemberProfile } from '../../../contexts/DataContext';
import { usePageReady } from '../../../contexts/PageReadyContext';
import MemberProfileDrawer from '../../../components/MemberProfileDrawer';
import { NewUserDrawer } from '../../../components/staff-command-center/drawers/NewUserDrawer';
import { AnimatedPage } from '../../../components/motion';
import FloatingActionButton from '../../../components/FloatingActionButton';
import { getTierColor } from '../../../utils/tierUtils';

import { useDirectoryFilters } from './directory/useDirectoryFilters';
import { useDirectoryData, useIncrementalLoad } from './directory/useDirectoryData';
import DirectoryFilters from './directory/DirectoryFilters';
import ActiveMembersList from './directory/ActiveMembersList';
import FormerMembersList from './directory/FormerMembersList';
import VisitorsList from './directory/VisitorsList';
import TeamList from './directory/TeamList';
import type { MemberTab, Visitor, TeamMember } from './directory/directoryTypes';
import { ASSIGNABLE_TIERS } from './directory/directoryTypes';

const DirectoryTab: React.FC = () => {
    const { setPageReady } = usePageReady();
    const { members, formerMembers, fetchFormerMembers, refreshMembers, setViewAsUser, actualUser, isFetchingMembers } = useData();
    const navigate = useNavigate();

    const [memberTab, setMemberTab] = useState<MemberTab>('active');
    const [selectedMember, setSelectedMember] = useState<MemberProfile | null>(null);
    const [isViewingDetails, setIsViewingDetails] = useState(false);
    const [addMemberModalOpen, setAddMemberModalOpen] = useState(false);
    const [assignTierModalOpen, setAssignTierModalOpen] = useState(false);
    const [memberToAssignTier, setMemberToAssignTier] = useState<MemberProfile | null>(null);
    const [selectedTierToAssign, setSelectedTierToAssign] = useState<string>('');
    const [assignTierError, setAssignTierError] = useState<string | null>(null);
    const [selectedVisitor, setSelectedVisitor] = useState<Visitor | null>(null);
    const [visitorDetailsOpen, setVisitorDetailsOpen] = useState(false);

    const isAdmin = actualUser?.role === 'admin';

    const filters = useDirectoryFilters({ members, formerMembers, memberTab });

    const data = useDirectoryData({
        memberTab,
        visitorTypeFilter: filters.visitorTypeFilter,
        visitorSourceFilter: filters.visitorSourceFilter,
        debouncedVisitorSearch: filters.debouncedVisitorSearch,
        visitorsPage: filters.visitorsPage,
        visitorArchiveView: filters.visitorArchiveView,
        selectedVisitorId: selectedVisitor?.id ?? null,
        visitorDetailsOpen,
        refreshMembers,
        fetchFormerMembers,
    });

    const { visibleItems, hasMore, loadMoreRef, totalCount, visibleCount } = useIncrementalLoad(filters.filteredList);

    React.useEffect(() => {
        setPageReady(true);
    }, [setPageReady]);

    React.useEffect(() => {
        if (isViewingDetails && selectedMember) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    }, [isViewingDetails, selectedMember]);

    const openDetailsModal = (member: MemberProfile) => {
        setSelectedMember(member);
        setIsViewingDetails(true);
    };

    const openAssignTierModal = (member: MemberProfile) => {
        setMemberToAssignTier(member);
        setSelectedTierToAssign('');
        setAssignTierError(null);
        setAssignTierModalOpen(true);
    };

    const handleAssignTier = () => {
        if (!memberToAssignTier || !selectedTierToAssign) return;
        data.assignTierMutation.mutate({
            memberId: memberToAssignTier.id!,
            tier: selectedTierToAssign,
            memberEmail: memberToAssignTier.email
        });
        setAssignTierModalOpen(false);
        setMemberToAssignTier(null);
    };

    const handleSync = () => {
        data.syncMutation.mutate();
    };

    const handleTabChange = useCallback(async (tab: MemberTab) => {
        setMemberTab(tab);
        filters.resetForTabChange();
        if (tab === 'former') {
            data.setFormerLoading(true);
            data.setFormerError(false);
            try {
                await fetchFormerMembers();
            } catch (err: unknown) {
                console.error('Error loading former members:', err);
                data.setFormerError(true);
            } finally {
                data.setFormerLoading(false);
            }
        }
    }, [fetchFormerMembers, filters, data]);

    const handleViewAs = async (member: MemberProfile) => {
        if (!isAdmin) return;
        await setViewAsUser(member);
        navigate('/dashboard');
    };

    const openVisitorDetails = useCallback((visitor: Visitor) => {
        setSelectedVisitor(visitor);
        setVisitorDetailsOpen(true);
    }, []);

    const openTeamMemberDetails = useCallback((member: TeamMember) => {
        const profile = data.teamMemberToMemberProfile(member);
        setSelectedMember(profile as unknown as MemberProfile);
        setIsViewingDetails(true);
    }, [data.teamMemberToMemberProfile]);

    return (
        <AnimatedPage className="bg-white dark:bg-surface-dark rounded-xl p-4 border border-gray-200 dark:border-white/20 flex flex-col h-full">
            <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="inline-flex bg-black/5 dark:bg-white/10 backdrop-blur-sm rounded-full p-1 relative">
                        <div
                            className="absolute top-1 bottom-1 bg-white dark:bg-white/20 shadow-md rounded-full transition-all duration-normal"
                            style={{
                                width: 'calc(25% - 4px)',
                                left: memberTab === 'active' ? '4px'
                                    : memberTab === 'former' ? 'calc(25% + 0px)'
                                    : memberTab === 'visitors' ? 'calc(50% + 0px)'
                                    : 'calc(75% - 0px)',
                            }}
                        />
                        {([
                            { key: 'active' as MemberTab, label: 'Active', icon: 'group' },
                            { key: 'former' as MemberTab, label: 'Former', icon: 'person_off' },
                            { key: 'visitors' as MemberTab, label: 'Visitors', icon: 'badge' },
                            { key: 'team' as MemberTab, label: 'Team', icon: 'admin_panel_settings' },
                        ] as const).map(tab => (
                            <button
                                key={tab.key}
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleTabChange(tab.key);
                                    filters.setShowMissingTierOnly(false);
                                }}
                                className={`tactile-btn relative z-10 px-3 py-1.5 text-[11px] sm:text-sm font-medium transition-colors duration-fast rounded-full flex items-center gap-1 sm:gap-1.5 cursor-pointer ${
                                    memberTab === tab.key
                                        ? 'text-primary dark:text-white'
                                        : 'text-gray-500 dark:text-white/60'
                                }`}
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-[16px] sm:text-[18px]">{tab.icon}</span>
                                <span className="hidden xs:inline">{tab.label}</span>
                            </button>
                        ))}
                    </div>
                    {data.syncMessage && (
                        <span className={`text-[10px] font-medium ${data.syncMessage.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {data.syncMessage.text}
                        </span>
                    )}
                </div>
                <button
                    onClick={handleSync}
                    disabled={data.syncMutation.isPending}
                    className="tactile-btn flex items-center justify-center gap-1.5 sm:px-3 px-2 py-1.5 rounded-full text-[11px] sm:text-xs font-medium text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shrink-0"
                    title={data.syncMutation.isPending ? 'Syncing...' : data.lastSyncTime ? `Last sync: ${new Date(data.lastSyncTime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })}` : 'Sync All'}
                >
                    <span className={`material-symbols-outlined text-[16px] ${data.syncMutation.isPending ? 'animate-spin' : ''}`}>
                        sync
                    </span>
                    <span className="hidden sm:inline">
                        {data.syncMutation.isPending ? 'Syncing...' : data.lastSyncTime ? `Sync (${new Date(data.lastSyncTime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })})` : 'Sync All'}
                    </span>
                </button>
            </div>

            {memberTab !== 'visitors' && (
                <DirectoryFilters
                    memberTab={memberTab}
                    searchQuery={filters.searchQuery}
                    setSearchQuery={filters.setSearchQuery}
                    tierFilter={filters.tierFilter}
                    setTierFilter={filters.setTierFilter}
                    statusFilter={filters.statusFilter}
                    setStatusFilter={filters.setStatusFilter}
                    membershipStatusFilter={filters.membershipStatusFilter}
                    setMembershipStatusFilter={filters.setMembershipStatusFilter}
                    appUsageFilter={filters.appUsageFilter}
                    setAppUsageFilter={filters.setAppUsageFilter}
                    billingFilter={filters.billingFilter}
                    setBillingFilter={filters.setBillingFilter}
                    discountFilter={filters.discountFilter}
                    setDiscountFilter={filters.setDiscountFilter}
                    showMissingTierOnly={filters.showMissingTierOnly}
                    setShowMissingTierOnly={filters.setShowMissingTierOnly}
                    showRecentlyAdded={filters.showRecentlyAdded}
                    setShowRecentlyAdded={filters.setShowRecentlyAdded}
                    sortField={filters.sortField}
                    setSortField={filters.setSortField}
                    sortDirection={filters.sortDirection}
                    setSortDirection={filters.setSortDirection}
                    filtersOpen={filters.filtersOpen}
                    setFiltersOpen={filters.setFiltersOpen}
                    filterPopoverRef={filters.filterPopoverRef}
                    sortOpen={filters.sortOpen}
                    setSortOpen={filters.setSortOpen}
                    sortPopoverRef={filters.sortPopoverRef}
                    activeFilters={filters.activeFilters}
                    activeFilterCount={filters.activeFilterCount}
                    clearAllFilters={filters.clearAllFilters}
                    discountCodes={filters.discountCodes}
                    filteredListLength={filters.filteredList.length}
                    teamSearchQuery={filters.teamSearchQuery}
                    setTeamSearchQuery={filters.setTeamSearchQuery}
                    filteredTeamMembersLength={data.teamMembers.length}
                    visitorsLength={data.visitors.length}
                    visitorsTotal={data.visitorsTotal}
                />
            )}

            <div key={memberTab} className="flex flex-col animate-content-enter">
                {memberTab === 'active' && (
                    <ActiveMembersList
                        members={members}
                        isFetchingMembers={isFetchingMembers}
                        filteredList={filters.filteredList}
                        visibleItems={visibleItems}
                        hasMore={hasMore}
                        loadMoreRef={loadMoreRef}
                        totalCount={totalCount}
                        visibleCount={visibleCount}
                        isAdmin={isAdmin}
                        searchQuery={filters.searchQuery}
                        tierFilter={filters.tierFilter}
                        appUsageFilter={filters.appUsageFilter}
                        statusFilter={filters.statusFilter}
                        discountFilter={filters.discountFilter}
                        membersWithoutTierCount={filters.membersWithoutTierCount}
                        showMissingTierOnly={filters.showMissingTierOnly}
                        setShowMissingTierOnly={filters.setShowMissingTierOnly}
                        setTierFilter={filters.setTierFilter}
                        sortField={filters.sortField}
                        handleSort={filters.handleSort}
                        getSortIcon={filters.getSortIcon}
                        getDisplayTier={data.getDisplayTier}
                        isMemberPendingUpdate={data.isMemberPendingUpdate}
                        openDetailsModal={openDetailsModal}
                        openAssignTierModal={openAssignTierModal}
                        handleViewAs={handleViewAs}
                    />
                )}

                {memberTab === 'former' && (
                    <FormerMembersList
                        formerMembers={formerMembers}
                        formerLoading={data.formerLoading}
                        formerError={data.formerError}
                        filteredList={filters.filteredList}
                        visibleItems={visibleItems}
                        hasMore={hasMore}
                        loadMoreRef={loadMoreRef}
                        totalCount={totalCount}
                        visibleCount={visibleCount}
                        searchQuery={filters.searchQuery}
                        tierFilter={filters.tierFilter}
                        statusFilter={filters.statusFilter}
                        discountFilter={filters.discountFilter}
                        sortField={filters.sortField}
                        handleSort={filters.handleSort}
                        getSortIcon={filters.getSortIcon}
                        openDetailsModal={openDetailsModal}
                        handleRetryFormer={data.handleRetryFormer}
                    />
                )}

                {memberTab === 'visitors' && (
                    <VisitorsList
                        visitors={data.visitors}
                        visitorsTotal={data.visitorsTotal}
                        visitorsTotalPages={data.visitorsTotalPages}
                        visitorsLoading={data.visitorsLoading}
                        visitorsError={data.visitorsError}
                        refetchVisitors={data.refetchVisitors}
                        visitorSearchQuery={filters.visitorSearchQuery}
                        setVisitorSearchQuery={filters.setVisitorSearchQuery}
                        visitorTypeFilter={filters.visitorTypeFilter}
                        setVisitorTypeFilter={filters.setVisitorTypeFilter}
                        visitorSourceFilter={filters.visitorSourceFilter}
                        setVisitorSourceFilter={filters.setVisitorSourceFilter}
                        visitorSortField={filters.visitorSortField}
                        setVisitorSortField={filters.setVisitorSortField}
                        visitorSortDirection={filters.visitorSortDirection}
                        setVisitorSortDirection={filters.setVisitorSortDirection}
                        visitorsPage={filters.visitorsPage}
                        setVisitorsPage={filters.setVisitorsPage}
                        visitorArchiveView={filters.visitorArchiveView}
                        setVisitorArchiveView={filters.setVisitorArchiveView}
                        purchaseFilter={filters.purchaseFilter}
                        setPurchaseFilter={filters.setPurchaseFilter}
                        filtersOpen={filters.filtersOpen}
                        setFiltersOpen={filters.setFiltersOpen}
                        filterPopoverRef={filters.filterPopoverRef}
                        activeFilters={filters.activeFilters}
                        activeFilterCount={filters.activeFilterCount}
                        clearAllFilters={filters.clearAllFilters}
                        openVisitorDetails={openVisitorDetails}
                    />
                )}

                {memberTab === 'team' && (
                    <TeamList
                        teamMembers={data.teamMembers}
                        teamLoading={data.teamLoading}
                        teamError={data.teamError}
                        refetchTeam={data.refetchTeam}
                        teamSearchQuery={filters.teamSearchQuery}
                        openTeamMemberDetails={openTeamMemberDetails}
                    />
                )}
            </div>

            <MemberProfileDrawer
                isOpen={isViewingDetails && !!selectedMember}
                member={selectedMember}
                isAdmin={isAdmin}
                onClose={() => { setIsViewingDetails(false); setSelectedMember(null); }}
                onViewAs={() => { if (selectedMember) handleViewAs(selectedMember); }}
                onMemberDeleted={refreshMembers}
                onMemberUpdated={refreshMembers}
            />

            <NewUserDrawer
                isOpen={addMemberModalOpen}
                onClose={() => setAddMemberModalOpen(false)}
                onSuccess={() => { setAddMemberModalOpen(false); refreshMembers(); }}
                defaultMode="member"
            />

            <FloatingActionButton
                onClick={() => setAddMemberModalOpen(true)}
                color="green"
                icon="person_add"
                label="Add new user"
                extended
                text="Add User"
            />

            {assignTierModalOpen && memberToAssignTier && createPortal(
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-surface-dark rounded-xl p-6 w-full max-w-md shadow-2xl">
                        <h3 className="text-2xl leading-tight font-bold text-primary dark:text-white mb-2" style={{ fontFamily: 'var(--font-headline)' }}>Assign Tier</h3>
                        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                            Select a membership tier for <span className="font-bold">{memberToAssignTier.name}</span>
                        </p>

                        <div className="space-y-2 mb-4">
                            {ASSIGNABLE_TIERS.map(tier => {
                                const colors = getTierColor(tier);
                                const isSelected = selectedTierToAssign === tier;
                                return (
                                    <button
                                        key={tier}
                                        onClick={() => setSelectedTierToAssign(tier)}
                                        className={`w-full p-3 rounded-xl border-2 text-left transition-all duration-fast ${
                                            isSelected
                                                ? 'border-primary dark:border-lavender'
                                                : 'border-gray-200 dark:border-white/20 hover:border-gray-300 dark:hover:border-white/30'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between">
                                            <span
                                                className="px-2 py-0.5 rounded text-xs font-bold"
                                                style={{
                                                    backgroundColor: colors.bg,
                                                    color: colors.text,
                                                    border: `1px solid ${colors.border}`,
                                                }}
                                            >
                                                {tier}
                                            </span>
                                            {isSelected && (
                                                <span className="material-symbols-outlined text-primary dark:!text-lavender">check_circle</span>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {assignTierError && (
                            <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30">
                                <p className="text-sm text-red-700 dark:text-red-400">{assignTierError}</p>
                            </div>
                        )}

                        <div className="flex gap-3">
                            <button
                                onClick={() => { setAssignTierModalOpen(false); setMemberToAssignTier(null); }}
                                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-300 dark:border-white/20 text-gray-700 dark:text-gray-300 font-bold hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleAssignTier}
                                disabled={!selectedTierToAssign || data.assignTierMutation.isPending}
                                className="flex-1 px-4 py-2.5 rounded-xl bg-primary dark:bg-lavender text-white font-bold hover:opacity-90 transition-all duration-fast disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                            >
                                {data.assignTierMutation.isPending ? (
                                    <>
                                        <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
                                        Saving...
                                    </>
                                ) : (
                                    'Assign Tier'
                                )}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            <MemberProfileDrawer
                isOpen={visitorDetailsOpen && !!selectedVisitor}
                member={selectedVisitor ? data.visitorToMemberProfile(selectedVisitor) as unknown as MemberProfile : null}
                isAdmin={isAdmin}
                onClose={() => { setVisitorDetailsOpen(false); setSelectedVisitor(null); }}
                onViewAs={() => {}}
                onMemberDeleted={() => data.refetchVisitors()}
                onMemberUpdated={() => data.refetchVisitors()}
                visitorMode={true}
            />
        </AnimatedPage>
    );
};

function handleDirectoryError(error: Error, errorInfo: ErrorInfo) {
    const isError306 = error.message?.includes('306') || error.message?.includes('Minified React error');
    try {
        fetch('/api/client-error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                page: 'DirectoryTab',
                error: error.message,
                stack: error.stack?.substring(0, 2000),
                componentStack: errorInfo.componentStack?.substring(0, 2000),
                isError306,
            })
        }).catch(() => {});
    } catch {}
}

function DirectoryTabWithBoundary() {
    return (
        <FeatureErrorBoundary
            featureName="Member Directory"
            onError={handleDirectoryError}
        >
            <DirectoryTab />
        </FeatureErrorBoundary>
    );
}

export default DirectoryTabWithBoundary;
