import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import EmptyState from '../../../components/EmptyState';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useData, MemberProfile } from '../../../contexts/DataContext';
import { usePageReady } from '../../../contexts/PageReadyContext';
import { useBottomNav } from '../../../contexts/BottomNavContext';
import { useIsMobile } from '../../../hooks/useBreakpoint';
import TierBadge from '../../../components/TierBadge';
import MemberProfileDrawer from '../../../components/MemberProfileDrawer';
import { NewUserDrawer } from '../../../components/staff-command-center/drawers/NewUserDrawer';
import { DirectoryTabSkeleton } from '../../../components/skeletons';
import { formatPhoneNumber } from '../../../utils/formatting';
import { getTierColor } from '../../../utils/tierUtils';
import { getMemberStatusLabel, getMemberStatusBadgeClass } from '../../../utils/statusColors';
import { AnimatedPage } from '../../../components/motion';
import { fetchWithCredentials, postWithCredentials } from '../../../hooks/queries/useFetch';
import { useToast } from '../../../components/Toast';
import { useAutoAnimate } from '@formkit/auto-animate/react';

const TIER_OPTIONS = ['All', 'Social', 'Core', 'Premium', 'Corporate', 'VIP'] as const;
const ASSIGNABLE_TIERS = ['Social', 'Core', 'Premium', 'Corporate', 'VIP'] as const;
const BILLING_OPTIONS = ['All', 'Individual', 'Group', 'Stripe', 'Mindbody', 'Family Add-on', 'Comped'] as const;
type BillingFilter = 'All' | 'Individual' | 'Group' | 'Stripe' | 'Mindbody' | 'Family Add-on' | 'Comped';

const SORT_OPTIONS: { value: SortField; label: string }[] = [
    { value: 'name', label: 'Name A-Z' },
    { value: 'joinDate', label: 'Join Date' },
    { value: 'lastVisit', label: 'Last Visit' },
    { value: 'visits', label: 'Lifetime Visits' },
    { value: 'tier', label: 'Tier' },
];

const VIRTUALIZATION_THRESHOLD = 75;
const ITEMS_PER_PAGE = 50;
const VISITORS_PAGE_SIZE = 100;

function useIncrementalLoad<T>(items: T[], threshold: number = VIRTUALIZATION_THRESHOLD) {
    const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE);
    const loadMoreRef = useRef<HTMLDivElement>(null);
    
    const needsVirtualization = items.length > threshold;
    const visibleItems = needsVirtualization ? items.slice(0, visibleCount) : items;
    const hasMore = needsVirtualization && visibleCount < items.length;
    
    useEffect(() => {
        setVisibleCount(ITEMS_PER_PAGE);
    }, [items.length]);
    
    useEffect(() => {
        if (!needsVirtualization || !loadMoreRef.current) return;
        
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting && hasMore) {
                    setVisibleCount(prev => Math.min(prev + ITEMS_PER_PAGE, items.length));
                }
            },
            { rootMargin: '200px' }
        );
        
        observer.observe(loadMoreRef.current);
        return () => observer.disconnect();
    }, [needsVirtualization, hasMore, items.length]);
    
    return { visibleItems, hasMore, loadMoreRef, totalCount: items.length, visibleCount };
}

type SortField = 'name' | 'tier' | 'visits' | 'joinDate' | 'lastVisit';
type SortDirection = 'asc' | 'desc';
type MemberTab = 'active' | 'former' | 'visitors' | 'team';

type VisitorType = 'all' | 'NEW' | 'classpass' | 'sim_walkin' | 'private_lesson' | 'day_pass' | 'guest' | 'lead';
type VisitorSource = 'all' | 'mindbody' | 'hubspot' | 'stripe' | 'APP';
type VisitorSortField = 'name' | 'email' | 'type' | 'source' | 'lastActivity' | 'createdAt' | 'purchases';

type StaffRole = 'staff' | 'admin' | 'golf_instructor';

interface TeamMember {
    staff_id: number;
    email: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    job_title: string | null;
    role: StaffRole | null;
    is_active: boolean;
    user_id: string | null;
    tier: string | null;
    membership_status: string | null;
    stripe_customer_id: string | null;
    hubspot_id: string | null;
}

const RoleBadge: React.FC<{ role: StaffRole | null }> = ({ role }) => {
    if (role === 'golf_instructor') {
        return (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                Instructor
            </span>
        );
    }
    if (role === 'admin') {
        return (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                Admin
            </span>
        );
    }
    return (
        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400">
            Staff
        </span>
    );
};

interface Visitor {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    purchaseCount: number;
    totalSpentCents: number;
    lastPurchaseDate: string | null;
    guestCount: number;
    lastGuestDate: string | null;
    membershipStatus: string | null;
    role: string | null;
    stripeCustomerId: string | null;
    hubspotId: string | null;
    mindbodyClientId: string | null;
    lastActivityAt: string | null;
    lastActivitySource: string | null;
    createdAt: string | null;
    source: 'mindbody' | 'hubspot' | 'stripe' | 'app';
    type: 'classpass' | 'sim_walkin' | 'private_lesson' | 'day_pass' | 'guest' | 'lead';
}

interface VisitorPurchase {
    id: string;
    purchaserEmail: string;
    purchaserFirstName: string | null;
    purchaserLastName: string | null;
    purchaserPhone: string | null;
    quantity: number;
    amountCents: number;
    stripePaymentIntentId: string | null;
    purchasedAt: string;
}

interface VisitorsResponse {
    visitors: Visitor[];
    total: number;
}

interface SyncStatusResponse {
    lastSyncTime: string | null;
}

interface SyncResponse {
    created?: number;
    updated?: number;
    synced?: number;
}

const directoryKeys = {
    all: ['directory'] as const,
    syncStatus: () => [...directoryKeys.all, 'sync-status'] as const,
    visitors: (params: { type?: VisitorType; source?: VisitorSource; search?: string; page?: number; archived?: string }) => 
        [...directoryKeys.all, 'visitors', params] as const,
    team: () => [...directoryKeys.all, 'team'] as const,
    visitorPurchases: (visitorId: string) => [...directoryKeys.all, 'visitor-purchases', visitorId] as const,
};

const formatJoinDate = (dateStr: string | null | undefined): string => {
    if (!dateStr) return '-';
    try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return '-';
        return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    } catch {
        return '-';
    }
};


interface SortableHeaderProps {
    field: SortField;
    label: string;
    className?: string;
    width: string;
    currentSortField: SortField;
    onSort: (field: SortField) => void;
    getSortIcon: (field: SortField) => string;
}

const SortableHeader: React.FC<SortableHeaderProps> = ({ field, label, className = '', width, currentSortField, onSort, getSortIcon }) => (
    <div 
        className={`px-4 py-3 font-semibold text-gray-600 dark:text-gray-300 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-white/10 transition-colors select-none tactile-btn ${className}`}
        style={{ width }}
        onClick={() => onSort(field)}
    >
        <div className="flex items-center gap-1">
            {label}
            <span className={`material-symbols-outlined text-[16px] ${currentSortField === field ? 'text-[#293515] dark:!text-[#CCB8E4]' : 'text-gray-400'}`}>
                {getSortIcon(field)}
            </span>
        </div>
    </div>
);

const DirectoryTab: React.FC = () => {
    const { setPageReady } = usePageReady();
    const { members, formerMembers, fetchFormerMembers, refreshMembers, setViewAsUser, actualUser } = useData();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    
    const [visitorsCardParent] = useAutoAnimate();
    const [visitorsTbodyParent] = useAutoAnimate();
    const [teamCardParent] = useAutoAnimate();
    const [teamTbodyParent] = useAutoAnimate();
    const [membersCardParent] = useAutoAnimate();
    const [membersDesktopParent] = useAutoAnimate();

    const [searchQuery, setSearchQuery] = useState('');
    const [tierFilter, setTierFilter] = useState<string>('All');
    const [statusFilter, setStatusFilter] = useState<string>('All');
    const [membershipStatusFilter, setMembershipStatusFilter] = useState<string>('All');
    const [appUsageFilter, setAppUsageFilter] = useState<'All' | 'Logged In' | 'Never Logged In'>('All');
    const [billingFilter, setBillingFilter] = useState<BillingFilter>('All');
    const [discountFilter, setDiscountFilter] = useState<string>('All');
    const [selectedMember, setSelectedMember] = useState<MemberProfile | null>(null);
    const [isViewingDetails, setIsViewingDetails] = useState(false);
    const [memberTab, setMemberTab] = useState<MemberTab>('active');
    const [sortField, setSortField] = useState<SortField>('name');
    const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
    const [formerLoading, setFormerLoading] = useState(false);
    const [formerError, setFormerError] = useState(false);
    const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [addMemberModalOpen, setAddMemberModalOpen] = useState(false);
    const [showMissingTierOnly, setShowMissingTierOnly] = useState(false);
    const [assignTierModalOpen, setAssignTierModalOpen] = useState(false);
    const [memberToAssignTier, setMemberToAssignTier] = useState<MemberProfile | null>(null);
    const [selectedTierToAssign, setSelectedTierToAssign] = useState<string>('');
    const [assignTierError, setAssignTierError] = useState<string | null>(null);
    const [selectedVisitor, setSelectedVisitor] = useState<Visitor | null>(null);
    const [visitorDetailsOpen, setVisitorDetailsOpen] = useState(false);
    const [visitorTypeFilter, setVisitorTypeFilter] = useState<VisitorType>('all');
    const [visitorSourceFilter, setVisitorSourceFilter] = useState<VisitorSource>('all');
    const [visitorSearchQuery, setVisitorSearchQuery] = useState('');
    const [debouncedVisitorSearch, setDebouncedVisitorSearch] = useState('');
    const [visitorSortField, setVisitorSortField] = useState<VisitorSortField>('lastActivity');
    const [visitorSortDirection, setVisitorSortDirection] = useState<SortDirection>('desc');
    const [visitorsPage, setVisitorsPage] = useState(1);
    const [visitorArchiveView, setVisitorArchiveView] = useState<'active' | 'archived'>('active');
    const [purchaseFilter, setPurchaseFilter] = useState<'all' | 'purchasers' | 'non-purchasers'>('all');
    const [teamSearchQuery, setTeamSearchQuery] = useState('');
    const [optimisticTiers, setOptimisticTiers] = useState<Record<string, string>>({});
    const [pendingTierUpdates, setPendingTierUpdates] = useState<Set<string>>(new Set());
    const [filtersOpen, setFiltersOpen] = useState(false);
    const filterPopoverRef = useRef<HTMLDivElement>(null);
    const [sortOpen, setSortOpen] = useState(false);
    const sortPopoverRef = useRef<HTMLDivElement>(null);
    
    const isAdmin = actualUser?.role === 'admin';
    const { isAtBottom, drawerOpen } = useBottomNav();
    const isMobile = useIsMobile();
    const { showToast } = useToast();

    React.useEffect(() => {
        setPageReady(true);
    }, [setPageReady]);

    React.useEffect(() => {
        const timeoutId = setTimeout(() => {
            setDebouncedVisitorSearch(visitorSearchQuery);
        }, 300);
        return () => clearTimeout(timeoutId);
    }, [visitorSearchQuery]);

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

    useEffect(() => {
        setFiltersOpen(false);
        setSortOpen(false);
    }, [memberTab]);

    useEffect(() => {
        if (!filtersOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (filterPopoverRef.current && !filterPopoverRef.current.contains(e.target as Node)) {
                setFiltersOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [filtersOpen]);

    useEffect(() => {
        if (!sortOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (sortPopoverRef.current && !sortPopoverRef.current.contains(e.target as Node)) {
                setSortOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [sortOpen]);

    const { data: syncStatusData } = useQuery({
        queryKey: directoryKeys.syncStatus(),
        queryFn: () => fetchWithCredentials<SyncStatusResponse>('/api/hubspot/sync-status'),
        staleTime: 60000,
    });
    const lastSyncTime = syncStatusData?.lastSyncTime ?? null;

    const { 
        data: visitorsData, 
        isLoading: visitorsLoading, 
        isError: visitorsError,
        refetch: refetchVisitors
    } = useQuery({
        queryKey: directoryKeys.visitors({ 
            type: visitorTypeFilter, 
            source: visitorSourceFilter, 
            search: debouncedVisitorSearch, 
            page: visitorsPage,
            archived: visitorArchiveView,
        }),
        queryFn: async () => {
            const params = new URLSearchParams();
            params.set('limit', VISITORS_PAGE_SIZE.toString());
            params.set('offset', ((visitorsPage - 1) * VISITORS_PAGE_SIZE).toString());
            if (visitorTypeFilter !== 'all') params.set('typeFilter', visitorTypeFilter);
            if (visitorSourceFilter !== 'all') params.set('sourceFilter', visitorSourceFilter);
            if (debouncedVisitorSearch.trim()) params.set('search', debouncedVisitorSearch.trim());
            if (visitorArchiveView === 'archived') params.set('archived', 'true');
            return fetchWithCredentials<VisitorsResponse>(`/api/visitors?${params.toString()}`);
        },
        enabled: memberTab === 'visitors',
        staleTime: 30000,
    });
    const visitors = visitorsData?.visitors ?? [];
    const visitorsTotal = visitorsData?.total ?? 0;
    const visitorsTotalPages = Math.ceil(visitorsTotal / VISITORS_PAGE_SIZE);

    const { 
        data: teamMembers = [], 
        isLoading: teamLoading, 
        isError: teamError,
        refetch: refetchTeam
    } = useQuery({
        queryKey: directoryKeys.team(),
        queryFn: () => fetchWithCredentials<TeamMember[]>('/api/directory/team'),
        enabled: memberTab === 'team',
        staleTime: 60000,
    });

    const { data: visitorPurchases = [], isLoading: purchasesLoading } = useQuery({
        queryKey: directoryKeys.visitorPurchases(selectedVisitor?.id ?? ''),
        queryFn: async () => {
            if (!selectedVisitor?.id) return [];
            const data = await fetchWithCredentials<{ purchases: VisitorPurchase[] }>(`/api/visitors/${selectedVisitor.id}/purchases`);
            return data.purchases ?? [];
        },
        enabled: !!selectedVisitor?.id && visitorDetailsOpen,
        staleTime: 30000,
    });

    const syncMutation = useMutation({
        mutationFn: async () => {
            let pullCount = 0;
            let pushCount = 0;
            let stripeUpdated = 0;
            let errors: string[] = [];

            try {
                const pullRes = await postWithCredentials<SyncResponse>('/api/hubspot/sync-all-members', {});
                pullCount = pullRes.synced || 0;
            } catch {
                errors.push('pull');
            }

            try {
                const pushRes = await postWithCredentials<{ synced?: number }>('/api/hubspot/push-members-to-hubspot', {});
                pushCount = pushRes.synced || 0;
            } catch {
                errors.push('push');
            }

            try {
                const stripeRes = await postWithCredentials<{ updated?: number }>('/api/stripe/sync-member-subscriptions', {});
                stripeUpdated = stripeRes.updated || 0;
            } catch {
                errors.push('stripe');
            }

            return { pullCount, pushCount, stripeUpdated, errors };
        },
        onSuccess: async ({ pullCount, pushCount, stripeUpdated, errors }) => {
            await refreshMembers();

            const hubspotErrors = errors.filter(e => e === 'pull' || e === 'push');
            const stripeError = errors.includes('stripe');

            const parts: string[] = [];

            if (hubspotErrors.length === 0) {
                const hsTotal = pullCount + pushCount;
                if (hsTotal > 0) parts.push(`HubSpot: ${hsTotal} synced`);
            } else if (hubspotErrors.length === 2) {
                parts.push('HubSpot: failed');
            } else {
                const failedPart = hubspotErrors[0] === 'pull' ? 'pull' : 'push';
                parts.push(`HubSpot: partial (${failedPart} failed)`);
            }

            if (!stripeError) {
                if (stripeUpdated > 0) parts.push(`Stripe: ${stripeUpdated} updated`);
            } else {
                parts.push('Stripe: failed');
            }

            const allFailed = hubspotErrors.length === 2 && stripeError;
            const hasAnyError = errors.length > 0;

            if (allFailed) {
                setSyncMessage({ type: 'error', text: 'Failed to sync' });
            } else {
                setSyncMessage({
                    type: hasAnyError ? 'success' : 'success',
                    text: parts.length > 0 ? parts.join('. ') : 'All up to date'
                });
            }

            if (memberTab === 'former') {
                setFormerLoading(true);
                await fetchFormerMembers();
                setFormerLoading(false);
            }

            queryClient.invalidateQueries({ queryKey: directoryKeys.syncStatus() });
            setTimeout(() => setSyncMessage(null), 5000);
        },
        onError: () => {
            setSyncMessage({ type: 'error', text: 'Failed to sync' });
            setTimeout(() => setSyncMessage(null), 5000);
        },
    });

    const assignTierMutation = useMutation({
        mutationFn: async ({ memberId, tier, memberEmail }: { memberId: string | number; tier: string; memberEmail: string }) => {
            return fetchWithCredentials<{ success: boolean }>(`/api/hubspot/contacts/${memberId}/tier`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tier }),
            });
        },
        onMutate: async ({ memberEmail, tier }) => {
            await queryClient.cancelQueries({ queryKey: ['directory'] });
            setOptimisticTiers(prev => ({ ...prev, [memberEmail]: tier }));
            setPendingTierUpdates(prev => new Set(prev).add(memberEmail));
            setAssignTierModalOpen(false);
            setMemberToAssignTier(null);
        },
        onSuccess: async (_data, { memberEmail, tier }) => {
            setPendingTierUpdates(prev => {
                const next = new Set(prev);
                next.delete(memberEmail);
                return next;
            });
            setOptimisticTiers(prev => {
                const next = { ...prev };
                delete next[memberEmail];
                return next;
            });
            showToast(`Tier updated to ${tier}`, 'success');
        },
        onSettled: async () => {
            await refreshMembers();
        },
        onError: (err: Error, { memberEmail }) => {
            setPendingTierUpdates(prev => {
                const next = new Set(prev);
                next.delete(memberEmail);
                return next;
            });
            setOptimisticTiers(prev => {
                const next = { ...prev };
                delete next[memberEmail];
                return next;
            });
            showToast((err instanceof Error ? err.message : String(err)) || 'Failed to assign tier', 'error');
            setAssignTierError((err instanceof Error ? err.message : String(err)) || 'Failed to assign tier. Please try again.');
        },
    });
    
    const membersWithoutTierCount = useMemo(() => {
        if (!Array.isArray(members)) return 0;
        return members.filter(m => 
            m && (!m.role || m.role === 'member') && 
            (!m.rawTier || m.rawTier.trim() === '')
        ).length;
    }, [members]);
    
    const openAssignTierModal = (member: MemberProfile) => {
        setMemberToAssignTier(member);
        setSelectedTierToAssign('');
        setAssignTierError(null);
        setAssignTierModalOpen(true);
    };
    
    const handleAssignTier = () => {
        if (!memberToAssignTier || !selectedTierToAssign) return;
        assignTierMutation.mutate({ 
            memberId: memberToAssignTier.id!, 
            tier: selectedTierToAssign,
            memberEmail: memberToAssignTier.email
        });
    };
    
    const getDisplayTier = useCallback((member: MemberProfile): string | null => {
        if (optimisticTiers[member.email]) {
            return optimisticTiers[member.email];
        }
        return member.rawTier || member.tier || null;
    }, [optimisticTiers]);
    
    const isMemberPendingUpdate = useCallback((memberEmail: string): boolean => {
        return pendingTierUpdates.has(memberEmail);
    }, [pendingTierUpdates]);

    const handleSync = () => {
        syncMutation.mutate();
    };

    const openDetailsModal = (member: MemberProfile) => {
        setSelectedMember(member);
        setIsViewingDetails(true);
    };

    const handleTabChange = useCallback(async (tab: MemberTab) => {
        setMemberTab(tab);
        setStatusFilter('All');
        setMembershipStatusFilter('All');
        setDiscountFilter('All');
        setPurchaseFilter('all');
        if (tab === 'former') {
            setFormerLoading(true);
            setFormerError(false);
            try {
                await fetchFormerMembers();
            } catch (err: unknown) {
                console.error('Error loading former members:', err);
                setFormerError(true);
            } finally {
                setFormerLoading(false);
            }
        }
    }, [fetchFormerMembers]);

    const handleRetryFormer = useCallback(async () => {
        setFormerLoading(true);
        setFormerError(false);
        try {
            await fetchFormerMembers(true);
        } catch (err: unknown) {
            console.error('Error loading former members:', err);
            setFormerError(true);
        } finally {
            setFormerLoading(false);
        }
    }, [fetchFormerMembers]);

    const visitorToMemberProfile = useCallback((visitor: Visitor) => ({
        id: String(visitor.id),
        email: visitor.email || '',
        name: [visitor.firstName, visitor.lastName].filter(Boolean).join(' ') || 'Unknown',
        tier: null,
        rawTier: null,
        role: visitor.role || 'visitor',
        joinDate: visitor.createdAt || null,
        phone: visitor.phone || '',
        mindbodyId: null,
        accountBalance: 0,
        tags: [],
        lifetimeVisits: 0,
        lastVisit: visitor.lastPurchaseDate || null,
        membershipStatus: visitor.membershipStatus || 'visitor',
        stripeCustomerId: visitor.stripeCustomerId || null,
        status: 'active',
        billingProvider: null,
        legacySource: null,
        firstName: visitor.firstName || null,
        lastName: visitor.lastName || null,
        userId: visitor.id,
        hubspotId: visitor.hubspotId || null,
    }), []);

    const openVisitorDetails = useCallback((visitor: Visitor) => {
        setSelectedVisitor(visitor);
        setVisitorDetailsOpen(true);
    }, []);

    const teamMemberToMemberProfile = useCallback((member: TeamMember) => ({
        email: member.email || '',
        name: [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown',
        tier: member.tier || null,
        rawTier: member.tier || null,
        role: member.role || 'staff',
        joinDate: null,
        phone: member.phone || '',
        mindbodyId: null,
        accountBalance: 0,
        tags: [],
        lifetimeVisits: 0,
        lastVisit: null,
        membershipStatus: member.membership_status || null,
        stripeCustomerId: member.stripe_customer_id || null,
        status: 'active',
        billingProvider: null,
        legacySource: null,
        firstName: member.first_name || null,
        lastName: member.last_name || null,
        userId: member.user_id || undefined,
        hubspotId: member.hubspot_id || null,
    }), []);

    const openTeamMemberDetails = useCallback((member: TeamMember) => {
        const profile = teamMemberToMemberProfile(member);
        setSelectedMember(profile as unknown as MemberProfile);
        setIsViewingDetails(true);
    }, [teamMemberToMemberProfile]);

    const filteredTeamMembers = useMemo(() => {
        if (!teamSearchQuery.trim()) return teamMembers;
        const query = teamSearchQuery.toLowerCase().trim();
        return teamMembers.filter(member => {
            const name = [member.first_name, member.last_name].filter(Boolean).join(' ').toLowerCase();
            const email = member.email?.toLowerCase() || '';
            const role = member.role?.toLowerCase() || 'staff';
            const jobTitle = member.job_title?.toLowerCase() || '';
            return name.includes(query) || email.includes(query) || role.includes(query) || jobTitle.includes(query);
        });
    }, [teamMembers, teamSearchQuery]);

    const currentMembers = memberTab === 'active' ? (members || []) : (formerMembers || []);
    
    const regularMembers = useMemo(() => {
        if (!Array.isArray(currentMembers)) return [];
        return currentMembers.filter(m => m && (!m.role || m.role === 'member'));
    }, [currentMembers]);

    const sortedVisitors = useMemo(() => {
        const sorted = [...visitors];
        sorted.sort((a, b) => {
            let comparison = 0;
            switch (visitorSortField) {
                case 'name':
                    const nameA = [a.firstName, a.lastName].filter(Boolean).join(' ').toLowerCase();
                    const nameB = [b.firstName, b.lastName].filter(Boolean).join(' ').toLowerCase();
                    if (!nameA && !nameB) comparison = 0;
                    else if (!nameA) comparison = 1;
                    else if (!nameB) comparison = -1;
                    else comparison = nameA.localeCompare(nameB);
                    break;
                case 'email':
                    const emailA = (a.email || '').toLowerCase();
                    const emailB = (b.email || '').toLowerCase();
                    if (!emailA && !emailB) comparison = 0;
                    else if (!emailA) comparison = 1;
                    else if (!emailB) comparison = -1;
                    else comparison = emailA.localeCompare(emailB);
                    break;
                case 'type':
                    const typeA = a.type || '';
                    const typeB = b.type || '';
                    if (!typeA && !typeB) comparison = 0;
                    else if (!typeA) comparison = 1;
                    else if (!typeB) comparison = -1;
                    else comparison = typeA.localeCompare(typeB);
                    break;
                case 'source':
                    const sourceA = a.source || '';
                    const sourceB = b.source || '';
                    if (!sourceA && !sourceB) comparison = 0;
                    else if (!sourceA) comparison = 1;
                    else if (!sourceB) comparison = -1;
                    else comparison = sourceA.localeCompare(sourceB);
                    break;
                case 'lastActivity':
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
                case 'purchases':
                    comparison = (a.purchaseCount || 0) - (b.purchaseCount || 0);
                    break;
                case 'createdAt':
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

    const discountCodes = useMemo(() => {
        const codes = new Set<string>();
        regularMembers.forEach(m => {
            if (m.discountCode) codes.add(m.discountCode);
        });
        return Array.from(codes).sort();
    }, [regularMembers]);

    const clearAllFilters = useCallback(() => {
        if (memberTab === 'visitors') {
            setVisitorTypeFilter('all');
            setVisitorSourceFilter('all');
            setPurchaseFilter('all');
            setVisitorsPage(1);
        } else if (memberTab === 'former') {
            setTierFilter('All');
            setStatusFilter('All');
            setBillingFilter('All');
            setDiscountFilter('All');
            setShowMissingTierOnly(false);
        } else {
            setTierFilter('All');
            setMembershipStatusFilter('All');
            setAppUsageFilter('All');
            setBillingFilter('All');
            setDiscountFilter('All');
            setShowMissingTierOnly(false);
        }
    }, [memberTab]);

    const activeFilters = useMemo(() => {
        const filters: Array<{ key: string; label: string; onRemove: () => void }> = [];

        if (memberTab === 'visitors') {
            if (visitorTypeFilter !== 'all') {
                const typeLabels: Record<string, string> = { 'NEW': 'New (Staff Added)', 'classpass': 'ClassPass', 'sim_walkin': 'Sim Walk-In', 'private_lesson': 'Private Lesson', 'day_pass': 'Day Pass', 'guest': 'Guest', 'lead': 'Lead' };
                filters.push({ key: 'type', label: `Type: ${typeLabels[visitorTypeFilter] || visitorTypeFilter}`, onRemove: () => { setVisitorTypeFilter('all'); setVisitorsPage(1); } });
            }
            if (visitorSourceFilter !== 'all') {
                const sourceLabels: Record<string, string> = { 'APP': 'App', 'hubspot': 'HubSpot', 'mindbody': 'MindBody', 'stripe': 'Stripe' };
                filters.push({ key: 'source', label: `Source: ${sourceLabels[visitorSourceFilter] || visitorSourceFilter}`, onRemove: () => { setVisitorSourceFilter('all'); setVisitorsPage(1); } });
            }
            if (purchaseFilter !== 'all') {
                filters.push({ key: 'purchases', label: `Purchases: ${purchaseFilter === 'purchasers' ? 'Purchasers' : 'Non-Purchasers'}`, onRemove: () => { setPurchaseFilter('all'); setVisitorsPage(1); } });
            }
        } else if (memberTab === 'former') {
            if (tierFilter !== 'All') filters.push({ key: 'tier', label: `Tier: ${tierFilter}`, onRemove: () => setTierFilter('All') });
            if (statusFilter !== 'All') filters.push({ key: 'status', label: `Status: ${getMemberStatusLabel(statusFilter)}`, onRemove: () => setStatusFilter('All') });
            if (billingFilter !== 'All') filters.push({ key: 'billing', label: `Billing: ${billingFilter}`, onRemove: () => setBillingFilter('All') });
            if (discountFilter !== 'All') filters.push({ key: 'discount', label: `Discount: ${discountFilter}`, onRemove: () => setDiscountFilter('All') });
        } else if (memberTab === 'active') {
            if (tierFilter !== 'All') filters.push({ key: 'tier', label: `Tier: ${tierFilter}`, onRemove: () => setTierFilter('All') });
            if (membershipStatusFilter !== 'All') filters.push({ key: 'status', label: `Status: ${getMemberStatusLabel(membershipStatusFilter)}`, onRemove: () => setMembershipStatusFilter('All') });
            if (appUsageFilter !== 'All') filters.push({ key: 'app', label: `App: ${appUsageFilter}`, onRemove: () => setAppUsageFilter('All') });
            if (billingFilter !== 'All') filters.push({ key: 'billing', label: `Billing: ${billingFilter}`, onRemove: () => setBillingFilter('All') });
            if (discountFilter !== 'All') filters.push({ key: 'discount', label: `Discount: ${discountFilter}`, onRemove: () => setDiscountFilter('All') });
        }

        return filters;
    }, [memberTab, tierFilter, statusFilter, membershipStatusFilter, appUsageFilter, billingFilter, discountFilter, visitorTypeFilter, visitorSourceFilter, purchaseFilter]);

    const activeFilterCount = activeFilters.length;

    const filteredList = useMemo(() => {
        let filtered = regularMembers;
        
        if (showMissingTierOnly && memberTab === 'active') {
            filtered = filtered.filter(m => !m.rawTier || m.rawTier.trim() === '');
        }
        
        if (tierFilter !== 'All' && !showMissingTierOnly) {
            filtered = filtered.filter(m => {
                if (memberTab === 'former') {
                    const lastTier = m.lastTier || '';
                    return lastTier === tierFilter || lastTier.includes(tierFilter);
                }
                const tier = m.tier || '';
                return tier === tierFilter || tier.includes(tierFilter);
            });
        }
        
        if (memberTab === 'active' && appUsageFilter === 'Never Logged In') {
            filtered = filtered.filter(m => !m.firstLoginAt);
        }
        if (memberTab === 'active' && appUsageFilter === 'Logged In') {
            filtered = filtered.filter(m => !!m.firstLoginAt);
        }
        
        if (billingFilter !== 'All') {
            if (billingFilter === 'Individual') {
                filtered = filtered.filter(m => !m.billingGroupId);
            } else if (billingFilter === 'Group') {
                filtered = filtered.filter(m => !!m.billingGroupId);
            } else if (billingFilter === 'Stripe') {
                filtered = filtered.filter(m => m.billingProvider === 'stripe');
            } else if (billingFilter === 'Mindbody') {
                filtered = filtered.filter(m => m.billingProvider === 'mindbody');
            } else if (billingFilter === 'Family Add-on') {
                filtered = filtered.filter(m => m.billingProvider === 'family_addon');
            } else if (billingFilter === 'Comped') {
                filtered = filtered.filter(m => m.billingProvider === 'comped');
            }
        }

        if (discountFilter !== 'All') {
            filtered = filtered.filter(m => m.discountCode === discountFilter);
        }
        
        if (memberTab === 'former' && statusFilter !== 'All') {
            filtered = filtered.filter(m => m.membershipStatus === statusFilter);
        }
        
        if (memberTab === 'active' && membershipStatusFilter !== 'All') {
            filtered = filtered.filter(m => m.membershipStatus === membershipStatusFilter);
        }
        
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            filtered = filtered.filter(m => 
                m.name.toLowerCase().includes(query) ||
                m.email.toLowerCase().includes(query) ||
                (m.tier && m.tier.toLowerCase().includes(query)) ||
                (m.lastTier && m.lastTier.toLowerCase().includes(query)) ||
                (m.phone && m.phone.toLowerCase().includes(query)) ||
                (m.discountCode && m.discountCode.toLowerCase().includes(query))
            );
        }
        
        filtered = [...filtered].sort((a, b) => {
            let comparison = 0;
            switch (sortField) {
                case 'name':
                    comparison = a.name.localeCompare(b.name);
                    break;
                case 'tier':
                    if (memberTab === 'former') {
                        comparison = (a.lastTier || '').localeCompare(b.lastTier || '');
                    } else {
                        comparison = (a.tier || '').localeCompare(b.tier || '');
                    }
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
    }, [regularMembers, tierFilter, appUsageFilter, statusFilter, membershipStatusFilter, billingFilter, discountFilter, memberTab, searchQuery, sortField, sortDirection, showMissingTierOnly]);
    
    const { visibleItems, hasMore, loadMoreRef, totalCount, visibleCount } = useIncrementalLoad(filteredList);
    
    const handleViewAs = async (member: MemberProfile) => {
        if (!isAdmin) return;
        await setViewAsUser(member);
        navigate('/dashboard');
    };

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
                                    setShowMissingTierOnly(false);
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
                    {syncMessage && (
                        <span className={`text-[10px] font-medium ${syncMessage.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {syncMessage.text}
                        </span>
                    )}
                </div>
                <button
                    onClick={handleSync}
                    disabled={syncMutation.isPending}
                    className="tactile-btn flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                    <span className={`material-symbols-outlined text-[16px] ${syncMutation.isPending ? 'animate-spin' : ''}`}>
                        sync
                    </span>
                    {syncMutation.isPending ? 'Syncing...' : lastSyncTime ? `Sync (Last: ${new Date(lastSyncTime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })})` : 'Sync All'}
                </button>
            </div>
            
            {memberTab === 'active' && membersWithoutTierCount > 0 && (
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

            <div className="mb-6 space-y-3 animate-content-enter-delay-1 sticky top-0 z-10 bg-transparent pt-2 pb-3">
                {memberTab !== 'visitors' && memberTab !== 'team' && (
                    <div className="flex gap-2 relative" ref={filterPopoverRef}>
                        <div className="relative flex-1">
                            <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 text-[20px]">search</span>
                            <input
                                type="text"
                                placeholder="Search members..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary/30"
                            />
                        </div>
                        <div className="relative" ref={sortPopoverRef}>
                            <button
                                onClick={() => { setSortOpen(!sortOpen); setFiltersOpen(false); }}
                                className={`flex items-center justify-center w-[42px] h-[42px] rounded-xl border text-sm font-medium transition-colors cursor-pointer ${
                                    sortOpen
                                        ? 'border-lavender/50 text-[#293515] dark:!text-[#CCB8E4] bg-primary/5 dark:bg-lavender/5'
                                        : 'border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/10'
                                }`}
                                aria-label="Sort options"
                                title="Sort"
                            >
                                <span className="material-symbols-outlined text-[20px]">swap_vert</span>
                            </button>
                            <div className={`absolute right-0 top-full mt-1 glass-panel rounded-xl p-2 z-30 min-w-[180px] !bg-[#f5f5f0] dark:!bg-[#1a1a1a] transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${
                                    sortOpen ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-1 scale-[0.97] pointer-events-none'
                                }`}>
                                    <div className="flex items-center justify-between px-2 py-1 mb-1">
                                        <span className="text-[11px] font-bold text-gray-500 dark:text-white/50 uppercase tracking-wider">Sort By</span>
                                        <button
                                            onClick={() => setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')}
                                            className="tactile-btn flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
                                            title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                                        >
                                            <span className="material-symbols-outlined text-[14px]">
                                                {sortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                                            </span>
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
                            className={`px-3 py-2 rounded-xl border text-sm font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
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

                        <div className={`absolute left-0 right-0 top-full mt-1 glass-panel rounded-xl p-4 space-y-3 z-30 !bg-[#f5f5f0] dark:!bg-[#1a1a1a] transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${
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
                                        {TIER_OPTIONS.map(tier => {
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
                                            {(['active', 'trialing', 'past_due', 'grace_period', 'paused', 'pending'] as const).map(status => (
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
                                            {(['terminated', 'expired', 'suspended', 'cancelled', 'frozen', 'inactive', 'former_member'] as const).map(status => (
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
                        <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 text-[20px]">search</span>
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
                                    <span className="material-symbols-outlined text-[12px]">close</span>
                                </button>
                            </span>
                        ))}
                    </div>
                )}

                <p className="text-xs text-gray-500 dark:text-gray-400">
                    {memberTab === 'visitors' 
                        ? `Showing ${visitors.length} of ${visitorsTotal.toLocaleString()} visitor${visitorsTotal !== 1 ? 's' : ''}`
                        : memberTab === 'team'
                        ? `${filteredTeamMembers.length} team member${filteredTeamMembers.length !== 1 ? 's' : ''}`
                        : `${filteredList.length} ${memberTab === 'former' ? 'former ' : ''}member${filteredList.length !== 1 ? 's' : ''} found`
                    }
                </p>
            </div>

            <div key={memberTab} className="flex flex-col animate-content-enter">
                {formerLoading && memberTab === 'former' && (
                    <DirectoryTabSkeleton />
                )}

                {!formerLoading && formerError && memberTab === 'former' && (
                    <div className="flex flex-col items-center justify-center py-16 px-6 rounded-2xl border-2 border-dashed border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/5">
                        <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 text-red-400 dark:text-red-400/70">cloud_off</span>
                        <h3 className="text-lg font-bold mb-2 text-red-600 dark:text-red-400">
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
                )}

                {!formerLoading && !formerError && memberTab === 'former' && formerMembers.length === 0 && (
                    <EmptyState
                        icon="group"
                        title="No former members found"
                        description="When members leave or their membership expires, they will appear here"
                        variant="compact"
                    />
                )}

                {!formerLoading && filteredList.length === 0 && memberTab !== 'visitors' && memberTab !== 'team' && (memberTab === 'active' || formerMembers.length > 0) && (
                    <EmptyState
                        icon={searchQuery || tierFilter !== 'All' || appUsageFilter !== 'All' || statusFilter !== 'All' || discountFilter !== 'All' ? 'search_off' : 'group'}
                        title={searchQuery || tierFilter !== 'All' || appUsageFilter !== 'All' || statusFilter !== 'All' || discountFilter !== 'All'
                            ? 'No results found' 
                            : memberTab === 'former' ? 'No former members' : 'No members yet'}
                        description={searchQuery || tierFilter !== 'All' || appUsageFilter !== 'All' || statusFilter !== 'All' || discountFilter !== 'All'
                            ? 'Try adjusting your search or filters to find what you\'re looking for'
                            : memberTab === 'former' ? 'Former members will appear here' : 'Members will appear here once they sign up'}
                        variant="compact"
                    />
                )}

                {memberTab === 'visitors' && (
                    <div className="space-y-3 mb-4">
                        <div className="flex gap-2 relative" ref={filterPopoverRef}>
                            <div className="relative flex-1">
                                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-white/40 text-[20px]">search</span>
                                <input
                                    type="text"
                                    value={visitorSearchQuery}
                                    onChange={(e) => setVisitorSearchQuery(e.target.value)}
                                    placeholder="Search by name, email, or phone..."
                                    className="w-full pl-10 pr-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-white/20 bg-white dark:bg-surface-dark text-gray-800 dark:text-white placeholder-gray-400 dark:placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-primary/50"
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
                                className={`px-3 py-2 rounded-lg border text-sm font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
                                    activeFilterCount > 0
                                        ? 'border-lavender/50 text-[#293515] dark:!text-[#CCB8E4] bg-primary/5 dark:bg-lavender/5 hover:bg-primary/10 dark:hover:bg-lavender/10'
                                        : 'border-gray-200 dark:border-white/20 bg-white dark:bg-surface-dark text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/10'
                                }`}
                                aria-label="Toggle filters"
                            >
                                <span className="material-symbols-outlined text-[18px]">filter_list</span>
                                <span className="hidden sm:inline">Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}</span>
                                {activeFilterCount > 0 && <span className="sm:hidden min-w-[18px] h-[18px] rounded-full bg-primary dark:bg-lavender text-white text-[10px] font-bold flex items-center justify-center">{activeFilterCount}</span>}
                            </button>

                            <div className={`absolute left-0 right-0 top-full mt-1 glass-panel rounded-xl p-4 space-y-3 z-30 !bg-[#f5f5f0] dark:!bg-[#1a1a1a] transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${
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
                            {visitorsTotal.toLocaleString()} {visitorArchiveView === 'archived' ? 'archived' : ''} contacts
                        </span>
                    </div>
                )}

                {visitorsLoading && memberTab === 'visitors' && (
                    <DirectoryTabSkeleton />
                )}

                {!visitorsLoading && visitorsError && memberTab === 'visitors' && (
                    <div className="flex flex-col items-center justify-center py-16 px-6 rounded-2xl border-2 border-dashed border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/5">
                        <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 text-red-400 dark:text-red-400/70">cloud_off</span>
                        <h3 className="text-lg font-bold mb-2 text-red-600 dark:text-red-400">
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

                {!visitorsLoading && !visitorsError && memberTab === 'visitors' && visitors.length === 0 && (
                    <EmptyState
                        icon="group"
                        title="No contacts found"
                        description={visitorTypeFilter !== 'all' || visitorSourceFilter !== 'all'
                            ? 'Try adjusting your filters to find contacts'
                            : 'Non-member contacts, day pass buyers, and leads will appear here'}
                        variant="compact"
                    />
                )}

                {!visitorsLoading && !visitorsError && memberTab === 'visitors' && visitors.length > 0 && (
                    <div className="md:hidden flex-1 min-h-0 relative">
                        <div className="h-full overflow-y-auto pt-2 pb-24">
                            <div ref={visitorsCardParent} className="space-y-3 px-1">
                                {sortedVisitors.map((v, index) => (
                                    <div 
                                        key={v.id}
                                        onClick={() => openVisitorDetails(v)}
                                        className="tactile-row bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.98] animate-slide-up-stagger"
                                        style={{ '--stagger-index': index } as React.CSSProperties}
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

                {!visitorsLoading && !visitorsError && memberTab === 'visitors' && visitors.length > 0 && (
                    <div className="hidden md:block flex-1 min-h-0 relative">
                        <div className="h-full overflow-y-auto">
                            <table className="w-full">
                                <thead className="sticky top-0 z-10">
                                    <tr>
                                        <td colSpan={6} className="p-0">
                                            <div className="flex items-center bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
                                                {([
                                                    ['name', 'Name'],
                                                    ['email', 'Email'],
                                                    ['type', 'Type'],
                                                    ['source', 'Source'],
                                                    ['purchases', 'Purchases'],
                                                    ['lastActivity', 'Last Activity'],
                                                ] as [VisitorSortField, string][]).map(([field, label]) => (
                                                    <div
                                                        key={field + label}
                                                        className="flex-1 px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase cursor-pointer hover:bg-gray-100 dark:hover:bg-white/10 transition-colors select-none tactile-btn"
                                                        onClick={() => {
                                                            if (visitorSortField === field) {
                                                                setVisitorSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                                                            } else {
                                                                setVisitorSortField(field);
                                                                setVisitorSortDirection(field === 'name' || field === 'email' || field === 'type' || field === 'source' ? 'asc' : 'desc');
                                                            }
                                                        }}
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
                                <tbody ref={visitorsTbodyParent}>
                                    {sortedVisitors.map(v => (
                                        <tr 
                                            key={v.id}
                                            onClick={() => openVisitorDetails(v)}
                                            className="border-b border-gray-100 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
                                        >
                                            <td className="p-3 font-medium text-primary dark:text-white">
                                                {[v.firstName, v.lastName].filter(Boolean).join(' ') || 'Unknown'}
                                            </td>
                                            <td className="p-3 text-sm text-gray-600 dark:text-gray-400">{v.email || '-'}</td>
                                            <td className="p-3">
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
                                            <td className="p-3">
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                    v.source === 'hubspot' ? 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400' :
                                                    v.source === 'stripe' ? 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400' :
                                                    v.source === 'mindbody' ? 'bg-teal-100 dark:bg-teal-500/20 text-teal-700 dark:text-teal-400' :
                                                    'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400'
                                                }`}>
                                                    {v.source === 'hubspot' ? 'HubSpot' : v.source === 'stripe' ? 'Stripe' : v.source === 'mindbody' ? 'MindBody' : 'App'}
                                                </span>
                                            </td>
                                            <td className="p-3 text-sm text-gray-600 dark:text-gray-400">{v.purchaseCount || 0}</td>
                                            <td className="p-3 text-sm text-gray-500 dark:text-gray-400">{formatJoinDate(v.lastActivityAt || v.lastPurchaseDate)}</td>
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

                {teamLoading && memberTab === 'team' && (
                    <DirectoryTabSkeleton />
                )}

                {!teamLoading && teamError && memberTab === 'team' && (
                    <div className="flex flex-col items-center justify-center py-16 px-6 rounded-2xl border-2 border-dashed border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/5">
                        <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 text-red-400 dark:text-red-400/70">cloud_off</span>
                        <h3 className="text-lg font-bold mb-2 text-red-600 dark:text-red-400">
                            Failed to load team
                        </h3>
                        <p className="text-sm text-red-500 dark:text-red-400/80 max-w-sm mx-auto text-center mb-4">
                            There was a problem connecting to the server. Please try again.
                        </p>
                        <button
                            onClick={() => refetchTeam()}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-bold transition-colors"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">refresh</span>
                            Retry
                        </button>
                    </div>
                )}

                {!teamLoading && !teamError && memberTab === 'team' && teamMembers.length === 0 && (
                    <EmptyState
                        icon="group"
                        title="No team members found"
                        description="Staff and admin accounts will appear here"
                        variant="compact"
                    />
                )}

                {!teamLoading && !teamError && memberTab === 'team' && filteredTeamMembers.length > 0 && (
                    <div className="flex-1 min-h-0 relative">
                        <div className="h-full overflow-y-auto">
                            <div ref={teamCardParent} className="md:hidden space-y-3 px-1 pt-2 pb-24">
                                {filteredTeamMembers.map((member, index) => (
                                    <div 
                                        key={member.staff_id}
                                        onClick={() => openTeamMemberDetails(member)}
                                        className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.98] animate-slide-up-stagger"
                                        style={{ '--stagger-index': index } as React.CSSProperties}
                                    >
                                        <div className="flex justify-between items-start mb-2">
                                            <div className="flex-1">
                                                <h4 className="font-bold text-lg text-primary dark:text-white">
                                                    {[member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown'}
                                                </h4>
                                                <p className="text-xs text-gray-500 dark:text-gray-400">{member.email}</p>
                                                {member.job_title && <p className="text-xs text-gray-500 dark:text-gray-400">{member.job_title}</p>}
                                            </div>
                                            <RoleBadge role={member.role} />
                                        </div>
                                        <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-gray-50 dark:border-white/20">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                {member.tier && <TierBadge tier={member.tier} size="sm" membershipStatus={member.membership_status} />}
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                    member.is_active 
                                                        ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400' 
                                                        : 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400'
                                                }`}>
                                                    {member.is_active ? 'Active' : 'Inactive'}
                                                </span>
                                            </div>
                                            <span className="material-symbols-outlined text-gray-400 text-[16px]">chevron_right</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <table className="hidden md:table w-full">
                                <thead className="sticky top-0 z-10">
                                    <tr>
                                        <td colSpan={5} className="p-0">
                                            <div className="flex items-center bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
                                                <div className="flex-1 px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Name</div>
                                                <div className="flex-1 px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Email</div>
                                                <div className="flex-1 px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Role</div>
                                                <div className="flex-1 px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Job Title</div>
                                                <div className="flex-1 px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Status</div>
                                            </div>
                                        </td>
                                    </tr>
                                </thead>
                                <tbody ref={teamTbodyParent}>
                                    {filteredTeamMembers.map(member => (
                                        <tr 
                                            key={member.staff_id}
                                            onClick={() => openTeamMemberDetails(member)}
                                            className="border-b border-gray-100 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
                                        >
                                            <td className="p-3 font-medium text-primary dark:text-white">
                                                {[member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown'}
                                            </td>
                                            <td className="p-3 text-sm text-gray-600 dark:text-gray-400">{member.email}</td>
                                            <td className="p-3"><RoleBadge role={member.role} /></td>
                                            <td className="p-3 text-sm text-gray-600 dark:text-gray-400">{member.job_title || '-'}</td>
                                            <td className="p-3">
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                    member.is_active 
                                                        ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400' 
                                                        : 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400'
                                                }`}>
                                                    {member.is_active ? 'Active' : 'Inactive'}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {!formerLoading && Array.isArray(filteredList) && filteredList.length > 0 && (memberTab === 'active' || memberTab === 'former') && (
                    <>
                        <div className="md:hidden relative">
                            <div className="pt-2 pb-24">
                                <div ref={membersCardParent} className="space-y-3 px-1">
                                    {visibleItems.map((m, index) => (
                                        <div 
                                            key={m.email}
                                            onClick={() => openDetailsModal(m)}
                                            className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.98] animate-slide-up-stagger"
                                            style={{ '--stagger-index': Math.min(index, 10) } as React.CSSProperties}
                                        >
                                            <div className="flex justify-between items-start mb-2">
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <h4 className="font-bold text-lg text-primary dark:text-white">{m.name}</h4>
                                                        {memberTab === 'former' && m.lastTier && (
                                                            <span className="flex items-center gap-1">
                                                                <span className="text-[10px] text-gray-400 dark:text-gray-500 italic">was</span>
                                                                <TierBadge tier={m.lastTier} size="sm" />
                                                            </span>
                                                        )}
                                                        {memberTab === 'former' && m.membershipStatus && (
                                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getMemberStatusBadgeClass(m.membershipStatus)}`}>
                                                                {getMemberStatusLabel(m.membershipStatus)}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                                        {m.email}
                                                        {memberTab === 'active' && m.billingProvider && (
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
                                                    </p>
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
                                                        {memberTab === 'former' ? (
                                                            <TierBadge tier={m.lastTier || null} size="sm" showNoTier={true} membershipStatus={m.membershipStatus} />
                                                        ) : (
                                                            <>
                                                                <TierBadge tier={getDisplayTier(m)} size="sm" showNoTier={true} membershipStatus={m.membershipStatus} />
                                                                {isMemberPendingUpdate(m.email) && (
                                                                    <span className="material-symbols-outlined text-[14px] text-primary dark:!text-lavender animate-spin">progress_activity</span>
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                    {m.membershipStatus && (
                                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getMemberStatusBadgeClass(m.membershipStatus)}`}>
                                                            {getMemberStatusLabel(m.membershipStatus)}
                                                        </span>
                                                    )}
                                                    {isAdmin && memberTab === 'active' && !getDisplayTier(m) && !isMemberPendingUpdate(m.email) && (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); openAssignTierModal(m); }}
                                                            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-xs font-bold hover:bg-amber-200 dark:hover:bg-amber-500/30 transition-all duration-fast active:scale-95"
                                                        >
                                                            <span aria-hidden="true" className="material-symbols-outlined text-[14px]">add_circle</span>
                                                            Assign Tier
                                                        </button>
                                                    )}
                                                </div>
                                                {memberTab === 'former' && (
                                                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                        m.stripeCustomerId
                                                            ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400'
                                                            : 'bg-gray-100 text-gray-500 dark:bg-gray-500/20 dark:text-gray-400'
                                                    }`}>
                                                        {m.stripeCustomerId ? 'Send Link' : 'New Signup'}
                                                    </span>
                                                )}
                                                {isAdmin && memberTab === 'active' && (
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
                                <SortableHeader field="tier" label={memberTab === 'former' ? 'Last Tier' : 'Tier'} width="12%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                                <div className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '10%' }}>Status</div>
                                <SortableHeader field="visits" label="Visits" width="7%" className="text-center" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                                <SortableHeader field="joinDate" label="Joined" width="9%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                                <SortableHeader field="lastVisit" label="Last Visit" width="9%" currentSortField={sortField} onSort={handleSort} getSortIcon={getSortIcon} />
                                <div className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: memberTab === 'former' ? '28%' : '39%' }}>Email</div>
                                {memberTab === 'former' && (
                                    <div className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '13%' }}>Reactivation</div>
                                )}
                            </div>
                            <div ref={membersDesktopParent}>
                                {visibleItems.map(m => (
                                    <div 
                                        key={m.email}
                                        onClick={() => openDetailsModal(m)}
                                        className="flex items-center border-b border-gray-200 dark:border-white/20 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
                                    >
                                        <div style={{ width: '14%' }} className="p-4 font-medium text-primary dark:text-white truncate">{m.name}</div>
                                        <div style={{ width: '12%' }} className="p-4">
                                            {memberTab === 'former' ? (
                                                <div className="flex items-center gap-1">
                                                    {m.lastTier ? (
                                                        <TierBadge tier={m.lastTier} size="sm" />
                                                    ) : (
                                                        <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                                                    )}
                                                </div>
                                            ) : (
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
                                            )}
                                        </div>
                                        <div style={{ width: '10%' }} className="p-4">
                                            {m.membershipStatus ? (
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getMemberStatusBadgeClass(m.membershipStatus)}`}>
                                                    {getMemberStatusLabel(m.membershipStatus)}
                                                </span>
                                            ) : (
                                                <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                                            )}
                                        </div>
                                        <div style={{ width: '7%' }} className="p-4 text-center text-gray-600 dark:text-gray-400 text-sm font-medium">
                                            {m.lifetimeVisits || 0}
                                        </div>
                                        <div style={{ width: '9%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                                            {formatJoinDate(m.joinDate)}
                                        </div>
                                        <div style={{ width: '9%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                                            {formatJoinDate(m.lastBookingDate)}
                                        </div>
                                        <div style={{ width: memberTab === 'former' ? '28%' : '39%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm truncate" title={m.email}>
                                            {m.email}
                                            {memberTab === 'active' && m.billingProvider && (
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
                                        {memberTab === 'former' && (
                                            <div style={{ width: '13%' }} className="p-4">
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
                                        )}
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
            </div>

            <MemberProfileDrawer
                isOpen={isViewingDetails && !!selectedMember}
                member={selectedMember}
                isAdmin={isAdmin}
                onClose={() => { setIsViewingDetails(false); setSelectedMember(null); }}
                onViewAs={() => { if (selectedMember) handleViewAs(selectedMember); }}
                onMemberDeleted={refreshMembers}
            />

            <NewUserDrawer
                isOpen={addMemberModalOpen}
                onClose={() => setAddMemberModalOpen(false)}
                onSuccess={() => { setAddMemberModalOpen(false); refreshMembers(); }}
                defaultMode="member"
            />

            {!drawerOpen && createPortal(
                <div 
                    className="fixed right-5 z-[9998]" 
                    style={{ 
                        bottom: isMobile 
                            ? (isAtBottom 
                                ? 'calc(24px + env(safe-area-inset-bottom, 0px))' 
                                : 'calc(140px + env(safe-area-inset-bottom, 0px))')
                            : '24px',
                        transition: 'bottom 0.3s ease-out'
                    }}
                >
                    <button
                        onClick={() => setAddMemberModalOpen(true)}
                        aria-label="Add new user"
                        className="w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-normal hover:scale-110 active:scale-95 bg-green-600 text-white backdrop-blur-xl border border-white/30"
                        title="Add New User"
                    >
                        <span className="material-symbols-outlined text-2xl" aria-hidden="true">person_add</span>
                    </button>
                </div>,
                document.body
            )}

            {assignTierModalOpen && memberToAssignTier && createPortal(
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 w-full max-w-md shadow-2xl">
                        <h3 className="text-xl font-bold text-primary dark:text-white mb-2">Assign Tier</h3>
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
                                disabled={!selectedTierToAssign || assignTierMutation.isPending}
                                className="flex-1 px-4 py-2.5 rounded-xl bg-primary dark:bg-lavender text-white font-bold hover:opacity-90 transition-all duration-fast disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                            >
                                {assignTierMutation.isPending ? (
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
                member={selectedVisitor ? visitorToMemberProfile(selectedVisitor) as unknown as MemberProfile : null}
                isAdmin={isAdmin}
                onClose={() => { setVisitorDetailsOpen(false); setSelectedVisitor(null); }}
                onViewAs={() => {}}
                onMemberDeleted={() => refetchVisitors()}
                visitorMode={true}
            />
        </AnimatedPage>
    );
};

export default DirectoryTab;
