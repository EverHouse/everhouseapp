import React, { useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { List, RowComponentProps as ListChildComponentProps } from 'react-window';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useData, MemberProfile } from '../../../contexts/DataContext';
import { usePageReady } from '../../../contexts/PageReadyContext';
import TierBadge from '../../../components/TierBadge';
import TagBadge from '../../../components/TagBadge';
import MemberProfileDrawer from '../../../components/MemberProfileDrawer';
import { AddMemberModal } from '../../../components/staff-command-center/modals/AddMemberModal';
import { DirectoryTabSkeleton } from '../../../components/skeletons';
import { formatPhoneNumber } from '../../../utils/formatting';
import { getTierColor, getTagColor } from '../../../utils/tierUtils';
import { AnimatedPage } from '../../../components/motion';
import { fetchWithCredentials, postWithCredentials } from '../../../hooks/queries/useFetch';

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

const VIRTUALIZATION_THRESHOLD = 20;
const VISITORS_PAGE_SIZE = 100;

interface MobileRowProps {
    data: MemberProfile[];
    memberTab: 'active' | 'former';
    isAdmin: boolean;
    openDetailsModal: (m: MemberProfile) => void;
    openAssignTierModal: (m: MemberProfile) => void;
    handleViewAs: (m: MemberProfile) => void;
}

const MobileRowComponent = ({ index, style, data, memberTab, isAdmin, openDetailsModal, openAssignTierModal, handleViewAs }: ListChildComponentProps & MobileRowProps) => {
    const m = data?.[index];
    if (!m) return null;
    return (
        <div style={{ ...style, paddingBottom: 12 }}>
            <div 
                onClick={() => openDetailsModal(m)}
                className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors h-full" 
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
                <div className="flex items-center justify-between gap-3 mt-3 pt-3 pb-2 border-t border-gray-50 dark:border-white/20">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <TierBadge tier={m.rawTier} size="sm" showNoTier={true} />
                        {m.tags?.filter((tag): tag is string => typeof tag === 'string').map(tag => (
                            <TagBadge key={tag} tag={tag} size="sm" />
                        ))}
                        {isAdmin && memberTab === 'active' && (!m.tier || m.tier.trim() === '') && (
                            <button
                                onClick={(e) => { e.stopPropagation(); openAssignTierModal(m); }}
                                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-xs font-bold hover:bg-amber-200 dark:hover:bg-amber-500/30 transition-all duration-200 active:scale-95"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-[14px]">add_circle</span>
                                Assign Tier
                            </button>
                        )}
                    </div>
                    {isAdmin && memberTab === 'active' && (
                        <button 
                            onClick={(e) => { e.stopPropagation(); handleViewAs(m); }} 
                            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-accent/20 text-brand-green dark:bg-accent/30 dark:text-accent text-xs font-bold hover:bg-accent/30 transition-all duration-200 active:scale-95"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-[14px]">visibility</span>
                            View As
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

interface DesktopRowProps {
    data: MemberProfile[];
    memberTab: 'active' | 'former';
    isAdmin: boolean;
    openDetailsModal: (m: MemberProfile) => void;
    openAssignTierModal: (m: MemberProfile) => void;
}

const DesktopRowComponent = ({ index, style, data, memberTab, isAdmin, openDetailsModal, openAssignTierModal }: ListChildComponentProps & DesktopRowProps) => {
    const m = data?.[index];
    if (!m) return null;
    return (
        <div 
            style={style}
            onClick={() => openDetailsModal(m)}
            className="flex items-center border-b border-gray-200 dark:border-white/20 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
        >
            <div style={{ width: '15%' }} className="p-4 font-medium text-primary dark:text-white truncate">{m.name}</div>
            <div style={{ width: '20%' }} className="p-4">
                <div className="flex items-center gap-1 flex-wrap">
                    <TierBadge tier={m.rawTier} size="sm" showNoTier={true} />
                    {m.tags?.filter((tag): tag is string => typeof tag === 'string').map(tag => (
                        <TagBadge key={tag} tag={tag} size="sm" />
                    ))}
                    {isAdmin && memberTab === 'active' && (!m.tier || m.tier.trim() === '') && (
                        <button
                            onClick={(e) => { e.stopPropagation(); openAssignTierModal(m); }}
                            className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-[10px] font-bold hover:bg-amber-200 dark:hover:bg-amber-500/30 transition-all duration-200 active:scale-95"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-[12px]">add_circle</span>
                            Assign
                        </button>
                    )}
                </div>
            </div>
            <div style={{ width: '8%' }} className="p-4 text-center text-gray-600 dark:text-gray-400 text-sm font-medium">
                {m.lifetimeVisits || 0}
            </div>
            <div style={{ width: '10%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                {formatJoinDate(m.joinDate)}
            </div>
            <div style={{ width: '10%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                {formatJoinDate(m.lastBookingDate)}
            </div>
            <div style={{ width: memberTab === 'former' ? '22%' : '37%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm truncate" title={m.email}>{m.email}</div>
            {memberTab === 'former' && (
                <div style={{ width: '15%' }} className="p-4">
                    {m.status ? (
                        <span className={`px-2 py-1 rounded-full text-xs font-bold whitespace-nowrap ${getStatusColor(m.status)}`}>
                            {formatStatusLabel(m.status)}
                        </span>
                    ) : (
                        <span className="px-2 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                            Unknown
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};

type SortField = 'name' | 'tier' | 'visits' | 'joinDate' | 'lastVisit';
type SortDirection = 'asc' | 'desc';
type MemberTab = 'active' | 'former' | 'visitors' | 'team';

type VisitorType = 'all' | 'NEW' | 'classpass' | 'sim_walkin' | 'private_lesson' | 'day_pass' | 'guest' | 'lead';
type VisitorSource = 'all' | 'mindbody' | 'hubspot' | 'stripe' | 'APP';
type VisitorSortField = 'name' | 'type' | 'source' | 'lastActivity' | 'createdAt';

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
    visitors: (params: { type?: VisitorType; source?: VisitorSource; search?: string; page?: number }) => 
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
    const queryClient = useQueryClient();
    
    const [searchQuery, setSearchQuery] = useState('');
    const [tierFilter, setTierFilter] = useState<string>('All');
    const [tagFilter, setTagFilter] = useState<string>('All');
    const [statusFilter, setStatusFilter] = useState<string>('All');
    const [billingFilter, setBillingFilter] = useState<BillingFilter>('All');
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
    const [teamSearchQuery, setTeamSearchQuery] = useState('');
    
    const isAdmin = actualUser?.role === 'admin';

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
            page: visitorsPage 
        }),
        queryFn: async () => {
            const params = new URLSearchParams();
            params.set('limit', VISITORS_PAGE_SIZE.toString());
            params.set('offset', ((visitorsPage - 1) * VISITORS_PAGE_SIZE).toString());
            if (visitorTypeFilter !== 'all') params.set('typeFilter', visitorTypeFilter);
            if (visitorSourceFilter !== 'all') params.set('sourceFilter', visitorSourceFilter);
            if (debouncedVisitorSearch.trim()) params.set('search', debouncedVisitorSearch.trim());
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
            let stripeCount = 0;
            let hubspotCount = 0;
            let errors: string[] = [];
            
            try {
                const stripeRes = await postWithCredentials<SyncResponse>('/api/stripe/sync-subscriptions', {});
                stripeCount = (stripeRes.created || 0) + (stripeRes.updated || 0);
            } catch {
                errors.push('Stripe');
            }
            
            try {
                const hubspotRes = await postWithCredentials<SyncResponse>('/api/hubspot/sync-all-members', {});
                hubspotCount = hubspotRes.synced || 0;
            } catch {
                errors.push('HubSpot');
            }
            
            return { stripeCount, hubspotCount, errors };
        },
        onSuccess: async ({ stripeCount, hubspotCount, errors }) => {
            await refreshMembers();
            
            if (errors.length === 0) {
                const stripeMsg = stripeCount > 0 ? `${stripeCount} from Stripe` : 'Stripe up to date';
                const hubspotMsg = hubspotCount > 0 ? `${hubspotCount} from HubSpot` : 'HubSpot synced (or cooldown active)';
                setSyncMessage({ type: 'success', text: `${stripeMsg}, ${hubspotMsg}` });
            } else if (errors.length === 2) {
                setSyncMessage({ type: 'error', text: 'Failed to sync with Stripe and HubSpot' });
            } else {
                setSyncMessage({ type: 'success', text: `Partial sync: ${errors[0]} failed, other source synced` });
            }
            
            if (memberTab === 'former') {
                setFormerLoading(true);
                await fetchFormerMembers();
                setFormerLoading(false);
            }
            
            queryClient.invalidateQueries({ queryKey: directoryKeys.syncStatus() });
            setTimeout(() => setSyncMessage(null), 5000);
        },
    });

    const assignTierMutation = useMutation({
        mutationFn: async ({ memberId, tier }: { memberId: string | number; tier: string }) => {
            return fetchWithCredentials<{ success: boolean }>(`/api/hubspot/contacts/${memberId}/tier`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tier }),
            });
        },
        onSuccess: async () => {
            setAssignTierModalOpen(false);
            setMemberToAssignTier(null);
            await refreshMembers();
        },
        onError: (err: Error) => {
            setAssignTierError(err.message || 'Failed to assign tier. Please try again.');
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
            tier: selectedTierToAssign 
        });
    };

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
        if (tab === 'former') {
            setFormerLoading(true);
            setFormerError(false);
            try {
                await fetchFormerMembers();
            } catch (err) {
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
        } catch (err) {
            console.error('Error loading former members:', err);
            setFormerError(true);
        } finally {
            setFormerLoading(false);
        }
    }, [fetchFormerMembers]);

    const visitorToMemberProfile = useCallback((visitor: Visitor): MemberProfile => ({
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

    const teamMemberToMemberProfile = useCallback((member: TeamMember): MemberProfile => ({
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
        setSelectedMember(profile);
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

    const allTags = useMemo(() => {
        const tagSet = new Set<string>();
        if (!Array.isArray(regularMembers)) return [];
        regularMembers.forEach(m => {
            if (m?.tags && Array.isArray(m.tags)) {
                m.tags.forEach(tag => {
                    if (typeof tag === 'string') {
                        tagSet.add(tag);
                    }
                });
            }
        });
        return Array.from(tagSet).sort();
    }, [regularMembers]);

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
        return sorted;
    }, [visitors, visitorSortField, visitorSortDirection]);

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
        
        if (showMissingTierOnly && memberTab === 'active') {
            filtered = filtered.filter(m => !m.rawTier || m.rawTier.trim() === '');
        }
        
        if (tierFilter !== 'All' && !showMissingTierOnly) {
            filtered = filtered.filter(m => {
                const tier = m.tier || '';
                return tier === tierFilter || tier.includes(tierFilter);
            });
        }
        
        if (tagFilter !== 'All') {
            filtered = filtered.filter(m => 
                m.tags?.filter((t): t is string => typeof t === 'string').includes(tagFilter)
            );
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
        
        if (memberTab === 'former' && statusFilter !== 'All') {
            filtered = filtered.filter(m => m.status === statusFilter);
        }
        
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            filtered = filtered.filter(m => 
                m.name.toLowerCase().includes(query) ||
                m.email.toLowerCase().includes(query) ||
                (m.tier && m.tier.toLowerCase().includes(query)) ||
                (m.phone && m.phone.toLowerCase().includes(query)) ||
                (m.tags?.filter((t): t is string => typeof t === 'string').some(t => t.toLowerCase().includes(query)))
            );
        }
        
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
    }, [regularMembers, tierFilter, tagFilter, statusFilter, billingFilter, memberTab, searchQuery, sortField, sortDirection, showMissingTierOnly]);
    
    const handleViewAs = async (member: MemberProfile) => {
        if (!isAdmin) return;
        await setViewAsUser(member);
        navigate('/dashboard');
    };

    const SortableHeader = ({ field, label, className = '', width }: { field: SortField; label: string; className?: string; width: string }) => (
        <div 
            className={`p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-white/10 transition-colors select-none ${className}`}
            style={{ width }}
            onClick={() => handleSort(field)}
        >
            <div className="flex items-center gap-1">
                {label}
                <span className={`material-symbols-outlined text-[16px] ${sortField === field ? 'text-primary dark:text-lavender' : 'text-gray-400'}`}>
                    {getSortIcon(field)}
                </span>
            </div>
        </div>
    );

    return (
        <AnimatedPage className="bg-white dark:bg-surface-dark rounded-xl p-4 border border-gray-200 dark:border-white/20 flex flex-col h-full">
            <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleTabChange('active');
                            setShowMissingTierOnly(false);
                        }}
                        className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
                            memberTab === 'active'
                                ? 'bg-primary dark:bg-lavender text-white'
                                : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                        }`}
                    >
                        Active
                    </button>
                    <button
                        type="button"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleTabChange('former');
                            setShowMissingTierOnly(false);
                        }}
                        className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
                            memberTab === 'former'
                                ? 'bg-primary dark:bg-lavender text-white'
                                : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                        }`}
                    >
                        Former
                    </button>
                    <button
                        type="button"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleTabChange('visitors');
                            setShowMissingTierOnly(false);
                        }}
                        className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
                            memberTab === 'visitors'
                                ? 'bg-primary dark:bg-lavender text-white'
                                : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                        }`}
                    >
                        Visitors
                    </button>
                    <button
                        type="button"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleTabChange('team');
                            setShowMissingTierOnly(false);
                        }}
                        className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
                            memberTab === 'team'
                                ? 'bg-primary dark:bg-lavender text-white'
                                : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                        }`}
                    >
                        Team
                    </button>
                    {syncMessage && (
                        <span className={`text-[10px] font-medium ${syncMessage.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {syncMessage.text}
                        </span>
                    )}
                </div>
                <div className="flex flex-col items-end gap-0.5">
                    <button
                        onClick={handleSync}
                        disabled={syncMutation.isPending}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-amber-500 hover:bg-amber-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <span className={`material-symbols-outlined text-[14px] ${syncMutation.isPending ? 'animate-spin' : ''}`}>
                            sync
                        </span>
                        {syncMutation.isPending ? 'Syncing...' : 'Sync'}
                    </button>
                    {lastSyncTime && (
                        <span className="text-[9px] text-gray-500 dark:text-gray-400">
                            Last synced: {new Date(lastSyncTime).toLocaleString('en-US', { 
                                month: 'short', 
                                day: 'numeric', 
                                hour: 'numeric', 
                                minute: '2-digit',
                                timeZone: 'America/Los_Angeles'
                            })}
                        </span>
                    )}
                </div>
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
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
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
                {memberTab !== 'visitors' && (
                <div className="relative">
                    <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 text-[20px]">search</span>
                    <input
                        type="text"
                        placeholder="Search members..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 dark:border-white/25 bg-white dark:bg-black/20 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
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

                {memberTab !== 'visitors' && memberTab !== 'team' && (
                    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-1">
                        <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap flex-shrink-0">Tier:</span>
                        {TIER_OPTIONS.map(tier => {
                            const isSelected = tierFilter === tier;
                            const colors = tier !== 'All' ? getTierColor(tier) : { bg: '', text: '', border: '' };
                            return (
                                <button
                                    key={tier}
                                    onClick={() => { setTierFilter(tier); setShowMissingTierOnly(false); }}
                                    className={`px-2 py-0.5 rounded text-[11px] font-bold transition-all flex-shrink-0 whitespace-nowrap ${
                                        tier === 'All' 
                                            ? isSelected 
                                                ? 'bg-primary dark:bg-lavender text-white' 
                                                : 'bg-gray-200 dark:bg-white/20 text-gray-400 dark:text-gray-500'
                                            : ''
                                    }`}
                                    style={tier !== 'All' ? {
                                        backgroundColor: isSelected ? colors.bg : '#E5E7EB',
                                        color: isSelected ? colors.text : '#9CA3AF',
                                        border: `1px solid ${isSelected ? colors.border : '#D1D5DB'}`,
                                    } : undefined}
                                >
                                    {tier}
                                </button>
                            );
                        })}
                    </div>
                )}

                {memberTab !== 'visitors' && allTags.length > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-1">
                        <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap flex-shrink-0">Tag:</span>
                        <button
                            onClick={() => setTagFilter('All')}
                            className={`px-2 py-0.5 rounded text-[11px] font-bold transition-all flex-shrink-0 whitespace-nowrap ${
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
                                    className="px-2 py-0.5 rounded text-[11px] font-bold transition-all flex-shrink-0 whitespace-nowrap"
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

                {memberTab === 'former' && allStatuses.length > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-1">
                        <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap flex-shrink-0">Status:</span>
                        <button
                            onClick={() => setStatusFilter('All')}
                            className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
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
                                className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
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

                {memberTab !== 'visitors' && memberTab !== 'team' && (
                    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-1">
                        <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap flex-shrink-0">Billing:</span>
                        {BILLING_OPTIONS.map(option => (
                            <button
                                key={option}
                                onClick={() => setBillingFilter(option)}
                                className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex-shrink-0 whitespace-nowrap ${
                                    billingFilter === option
                                        ? 'bg-primary dark:bg-lavender text-white'
                                        : 'bg-gray-200 dark:bg-white/20 text-gray-400 dark:text-gray-500 hover:bg-gray-300 dark:hover:bg-white/30'
                                }`}
                            >
                                {option}
                            </button>
                        ))}
                    </div>
                )}

                {memberTab !== 'visitors' && memberTab !== 'team' && (
                    <div className="flex items-center gap-2">
                        <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">Sort:</span>
                        <select
                            value={sortField}
                            onChange={(e) => setSortField(e.target.value as SortField)}
                            className="px-2 py-0.5 rounded text-[11px] font-bold bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-white/20 focus:outline-none focus:ring-2 focus:ring-primary/30"
                        >
                            {SORT_OPTIONS.map(option => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={() => setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')}
                            className="flex items-center justify-center w-6 h-6 rounded bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
                            title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                        >
                            <span className="material-symbols-outlined text-[16px]">
                                {sortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                            </span>
                        </button>
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

            <div key={memberTab} className="flex-1 flex flex-col min-h-0 overflow-hidden animate-content-enter">
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
                            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-bold transition-colors"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">refresh</span>
                            Retry
                        </button>
                    </div>
                )}

                {!formerLoading && !formerError && memberTab === 'former' && formerMembers.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-16 px-6 rounded-2xl border-2 border-dashed border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-white/5">
                        <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 text-gray-400 dark:text-white/30">group_off</span>
                        <h3 className="text-lg font-bold mb-2 text-gray-600 dark:text-white/70">
                            No former members found
                        </h3>
                        <p className="text-sm text-gray-500 dark:text-white/60 max-w-sm mx-auto text-center">
                            When members leave or their membership expires, they will appear here.
                        </p>
                    </div>
                )}

                {!formerLoading && filteredList.length === 0 && memberTab !== 'visitors' && memberTab !== 'team' && (memberTab === 'active' || formerMembers.length > 0) && (
                    <div className="flex flex-col items-center justify-center py-16 px-6 rounded-2xl border-2 border-dashed border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-white/5">
                        <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 text-gray-400 dark:text-white/30">
                            {searchQuery || tierFilter !== 'All' || tagFilter !== 'All' || statusFilter !== 'All' ? 'search_off' : 'person_off'}
                        </span>
                        <h3 className="text-lg font-bold mb-2 text-gray-600 dark:text-white/70">
                            {searchQuery || tierFilter !== 'All' || tagFilter !== 'All' || statusFilter !== 'All' 
                                ? 'No results found' 
                                : memberTab === 'former' ? 'No former members' : 'No members yet'}
                        </h3>
                        <p className="text-sm text-gray-500 dark:text-white/60 max-w-sm mx-auto text-center">
                            {searchQuery || tierFilter !== 'All' || tagFilter !== 'All' || statusFilter !== 'All'
                                ? 'Try adjusting your search or filters to find what you\'re looking for.'
                                : memberTab === 'former' ? 'Former members will appear here.' : 'Members will appear here once they sign up.'}
                        </p>
                    </div>
                )}

                {memberTab === 'visitors' && (
                    <div className="space-y-3 mb-4">
                        <div className="relative">
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
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-white/40 dark:hover:text-white/70"
                                    aria-label="Clear search"
                                >
                                    <span className="material-symbols-outlined text-[18px]">close</span>
                                </button>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <select
                                value={visitorTypeFilter}
                                onChange={(e) => setVisitorTypeFilter(e.target.value as VisitorType)}
                                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/20 bg-white dark:bg-surface-dark text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
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
                            <select
                                value={visitorSourceFilter}
                                onChange={(e) => setVisitorSourceFilter(e.target.value as VisitorSource)}
                                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/20 bg-white dark:bg-surface-dark text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                                aria-label="Filter by source"
                            >
                                <option value="all">All Sources</option>
                                <option value="APP">App (Staff Added)</option>
                                <option value="hubspot">HubSpot</option>
                                <option value="mindbody">MindBody</option>
                                <option value="stripe">Stripe</option>
                            </select>
                            <span className="ml-auto text-sm text-gray-500 dark:text-white/60 self-center">
                                {visitorsTotal.toLocaleString()} contacts
                            </span>
                        </div>
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
                            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-bold transition-colors"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">refresh</span>
                            Retry
                        </button>
                    </div>
                )}

                {!visitorsLoading && !visitorsError && memberTab === 'visitors' && visitors.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-16 px-6 rounded-2xl border-2 border-dashed border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-white/5">
                        <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 text-gray-400 dark:text-white/30">badge</span>
                        <h3 className="text-lg font-bold mb-2 text-gray-600 dark:text-white/70">
                            No contacts found
                        </h3>
                        <p className="text-sm text-gray-500 dark:text-white/60 max-w-sm mx-auto text-center">
                            {visitorTypeFilter !== 'all' || visitorSourceFilter !== 'all'
                                ? 'Try adjusting your filters to find contacts.'
                                : 'Non-member contacts, day pass buyers, and leads will appear here.'}
                        </p>
                    </div>
                )}

                {!visitorsLoading && !visitorsError && memberTab === 'visitors' && visitors.length > 0 && (
                    <div className="md:hidden flex-1 min-h-0 relative">
                        <div className="h-full overflow-y-auto pt-2 pb-24">
                            <div className="space-y-3 px-1">
                                {sortedVisitors.map((v, index) => (
                                    <div 
                                        key={v.id}
                                        onClick={() => openVisitorDetails(v)}
                                        className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors animate-slide-up-stagger"
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
                    </div>
                )}

                {!visitorsLoading && !visitorsError && memberTab === 'visitors' && visitors.length > 0 && (
                    <div className="hidden md:block flex-1 min-h-0 relative">
                        <div className="h-full overflow-y-auto">
                            <table className="w-full">
                                <thead className="sticky top-0 bg-gray-50 dark:bg-surface-dark z-10">
                                    <tr className="border-b border-gray-200 dark:border-white/20">
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Name</th>
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Email</th>
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Type</th>
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Source</th>
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Purchases</th>
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Last Activity</th>
                                    </tr>
                                </thead>
                                <tbody>
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
                    <div className="flex flex-col items-center justify-center py-16 px-6 rounded-2xl border-2 border-dashed border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-white/5">
                        <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 text-gray-400 dark:text-white/30">groups</span>
                        <h3 className="text-lg font-bold mb-2 text-gray-600 dark:text-white/70">
                            No team members found
                        </h3>
                        <p className="text-sm text-gray-500 dark:text-white/60 max-w-sm mx-auto text-center">
                            Staff and admin accounts will appear here.
                        </p>
                    </div>
                )}

                {!teamLoading && !teamError && memberTab === 'team' && filteredTeamMembers.length > 0 && (
                    <div className="flex-1 min-h-0 relative">
                        <div className="h-full overflow-y-auto">
                            <div className="md:hidden space-y-3 px-1 pt-2 pb-24">
                                {filteredTeamMembers.map((member, index) => (
                                    <div 
                                        key={member.staff_id}
                                        onClick={() => openTeamMemberDetails(member)}
                                        className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors animate-slide-up-stagger"
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
                                                {member.tier && <TierBadge tier={member.tier} size="sm" />}
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
                                <thead className="sticky top-0 bg-gray-50 dark:bg-surface-dark z-10">
                                    <tr className="border-b border-gray-200 dark:border-white/20">
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Name</th>
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Email</th>
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Role</th>
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Job Title</th>
                                        <th className="p-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
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

                {!formerLoading && filteredList.length > 0 && (memberTab === 'active' || memberTab === 'former') && (
                    <>
                        <div className="md:hidden flex-1 min-h-0 relative">
                            {filteredList.length > VIRTUALIZATION_THRESHOLD ? (
                                <List
                                    height={600}
                                    width="100%"
                                    itemCount={filteredList.length}
                                    itemSize={140}
                                    itemData={filteredList}
                                    className="scrollbar-hide"
                                >
                                    {(props) => (
                                        <MobileRowComponent
                                            {...props}
                                            data={filteredList}
                                            memberTab={memberTab as 'active' | 'former'}
                                            isAdmin={isAdmin}
                                            openDetailsModal={openDetailsModal}
                                            openAssignTierModal={openAssignTierModal}
                                            handleViewAs={handleViewAs}
                                        />
                                    )}
                                </List>
                            ) : (
                                <div className="h-full overflow-y-auto pt-2 pb-24">
                                    <div className="space-y-3 px-1">
                                        {filteredList.map((m, index) => (
                                            <div 
                                                key={m.email}
                                                onClick={() => openDetailsModal(m)}
                                                className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors animate-slide-up-stagger"
                                                style={{ '--stagger-index': index } as React.CSSProperties}
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
                                                <div className="flex items-center justify-between gap-3 mt-3 pt-3 pb-2 border-t border-gray-50 dark:border-white/20">
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <TierBadge tier={m.rawTier} size="sm" showNoTier={true} />
                                                        {m.tags?.filter((tag): tag is string => typeof tag === 'string').map(tag => (
                                                            <TagBadge key={tag} tag={tag} size="sm" />
                                                        ))}
                                                        {isAdmin && memberTab === 'active' && (!m.tier || m.tier.trim() === '') && (
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); openAssignTierModal(m); }}
                                                                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-xs font-bold hover:bg-amber-200 dark:hover:bg-amber-500/30 transition-all duration-200 active:scale-95"
                                                            >
                                                                <span aria-hidden="true" className="material-symbols-outlined text-[14px]">add_circle</span>
                                                                Assign Tier
                                                            </button>
                                                        )}
                                                    </div>
                                                    {isAdmin && memberTab === 'active' && (
                                                        <button 
                                                            onClick={(e) => { e.stopPropagation(); handleViewAs(m); }} 
                                                            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-accent/20 text-brand-green dark:bg-accent/30 dark:text-accent text-xs font-bold hover:bg-accent/30 transition-all duration-200 active:scale-95"
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
                            )}
                        </div>

                        <div className="hidden md:block flex-1 min-h-0 relative">
                            <div className="flex items-center bg-gray-50 dark:bg-white/5 border-b border-gray-200 dark:border-white/20">
                                <SortableHeader field="name" label="Name" width="15%" />
                                <div className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '20%' }}>Tier & Tags</div>
                                <SortableHeader field="visits" label="Visits" width="8%" className="text-center" />
                                <SortableHeader field="joinDate" label="Joined" width="10%" />
                                <SortableHeader field="lastVisit" label="Last Visit" width="10%" />
                                <div className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: memberTab === 'former' ? '22%' : '37%' }}>Email</div>
                                {memberTab === 'former' && (
                                    <div className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '15%' }}>Status</div>
                                )}
                            </div>
                            {filteredList.length > VIRTUALIZATION_THRESHOLD ? (
                                <List
                                    height={500}
                                    width="100%"
                                    itemCount={filteredList.length}
                                    itemSize={52}
                                    itemData={filteredList}
                                    className="scrollbar-hide"
                                >
                                    {(props) => (
                                        <DesktopRowComponent
                                            {...props}
                                            data={filteredList}
                                            memberTab={memberTab as 'active' | 'former'}
                                            isAdmin={isAdmin}
                                            openDetailsModal={openDetailsModal}
                                            openAssignTierModal={openAssignTierModal}
                                        />
                                    )}
                                </List>
                            ) : (
                                <div className="overflow-y-auto max-h-[500px]">
                                    {filteredList.map(m => (
                                        <div 
                                            key={m.email}
                                            onClick={() => openDetailsModal(m)}
                                            className="flex items-center border-b border-gray-200 dark:border-white/20 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
                                        >
                                            <div style={{ width: '15%' }} className="p-4 font-medium text-primary dark:text-white truncate">{m.name}</div>
                                            <div style={{ width: '20%' }} className="p-4">
                                                <div className="flex items-center gap-1 flex-wrap">
                                                    <TierBadge tier={m.rawTier} size="sm" showNoTier={true} />
                                                    {m.tags?.filter((tag): tag is string => typeof tag === 'string').map(tag => (
                                                        <TagBadge key={tag} tag={tag} size="sm" />
                                                    ))}
                                                    {isAdmin && memberTab === 'active' && (!m.tier || m.tier.trim() === '') && (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); openAssignTierModal(m); }}
                                                            className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-[10px] font-bold hover:bg-amber-200 dark:hover:bg-amber-500/30 transition-all duration-200 active:scale-95"
                                                        >
                                                            <span aria-hidden="true" className="material-symbols-outlined text-[12px]">add_circle</span>
                                                            Assign
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                            <div style={{ width: '8%' }} className="p-4 text-center text-gray-600 dark:text-gray-400 text-sm font-medium">
                                                {m.lifetimeVisits || 0}
                                            </div>
                                            <div style={{ width: '10%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                                                {formatJoinDate(m.joinDate)}
                                            </div>
                                            <div style={{ width: '10%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                                                {formatJoinDate(m.lastBookingDate)}
                                            </div>
                                            <div style={{ width: memberTab === 'former' ? '22%' : '37%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm truncate" title={m.email}>{m.email}</div>
                                            {memberTab === 'former' && (
                                                <div style={{ width: '15%' }} className="p-4">
                                                    {m.status ? (
                                                        <span className={`px-2 py-1 rounded-full text-xs font-bold whitespace-nowrap ${getStatusColor(m.status)}`}>
                                                            {formatStatusLabel(m.status)}
                                                        </span>
                                                    ) : (
                                                        <span className="px-2 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                                                            Unknown
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>

            <MemberProfileDrawer
                isOpen={isViewingDetails && !!selectedMember}
                member={selectedMember}
                isAdmin={isAdmin}
                onClose={() => { setIsViewingDetails(false); setSelectedMember(null); }}
                onViewAs={() => { if (selectedMember) handleViewAs(selectedMember); }}
            />

            <AddMemberModal
                isOpen={addMemberModalOpen}
                onClose={() => setAddMemberModalOpen(false)}
                onSuccess={() => { setAddMemberModalOpen(false); refreshMembers(); }}
            />

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
                                        className={`w-full p-3 rounded-xl border-2 text-left transition-all ${
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
                                                <span className="material-symbols-outlined text-primary dark:text-lavender">check_circle</span>
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
                                className="flex-1 px-4 py-2.5 rounded-xl bg-primary dark:bg-lavender text-white font-bold hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
                member={selectedVisitor ? visitorToMemberProfile(selectedVisitor) : null}
                isAdmin={isAdmin}
                onClose={() => { setVisitorDetailsOpen(false); setSelectedVisitor(null); }}
                onViewAs={() => {}}
                visitorMode={true}
            />
        </AnimatedPage>
    );
};

export default DirectoryTab;
