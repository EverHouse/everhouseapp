import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { List, RowComponentProps as ListChildComponentProps } from 'react-window';
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
import { apiRequest } from '../../../lib/apiRequest';

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

// Only virtualize lists with more than this many items to avoid overhead on small lists
const VIRTUALIZATION_THRESHOLD = 20;

// Mobile row component for virtualized list (v2 API)
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
                        {m.tags?.map(tag => (
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

// Desktop row component for virtualized list (v2 API)
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
                    {m.tags?.map(tag => (
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
type MemberTab = 'active' | 'former' | 'visitors';

type VisitorType = 'all' | 'day_pass' | 'guest' | 'lead';
type VisitorSource = 'all' | 'mindbody' | 'hubspot' | 'stripe';
type VisitorSortField = 'name' | 'type' | 'source' | 'lastActivity' | 'createdAt';

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
    type: 'day_pass' | 'guest' | 'lead';
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
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [addMemberModalOpen, setAddMemberModalOpen] = useState(false);
    const [showMissingTierOnly, setShowMissingTierOnly] = useState(false);
    const [assignTierModalOpen, setAssignTierModalOpen] = useState(false);
    const [memberToAssignTier, setMemberToAssignTier] = useState<MemberProfile | null>(null);
    const [selectedTierToAssign, setSelectedTierToAssign] = useState<string>('');
    const [isAssigningTier, setIsAssigningTier] = useState(false);
    const [assignTierError, setAssignTierError] = useState<string | null>(null);
    const [visitors, setVisitors] = useState<Visitor[]>([]);
    const [visitorsLoading, setVisitorsLoading] = useState(false);
    const [visitorsError, setVisitorsError] = useState(false);
    const [selectedVisitor, setSelectedVisitor] = useState<Visitor | null>(null);
    const [visitorPurchases, setVisitorPurchases] = useState<VisitorPurchase[]>([]);
    const [purchasesLoading, setPurchasesLoading] = useState(false);
    const [visitorDetailsOpen, setVisitorDetailsOpen] = useState(false);
    const [visitorTypeFilter, setVisitorTypeFilter] = useState<VisitorType>('all');
    const [visitorSourceFilter, setVisitorSourceFilter] = useState<VisitorSource>('all');
    const [visitorSortField, setVisitorSortField] = useState<VisitorSortField>('lastActivity');
    const [visitorSortDirection, setVisitorSortDirection] = useState<SortDirection>('desc');
    const [visitorsTotal, setVisitorsTotal] = useState(0);
    const [visitorsOffset, setVisitorsOffset] = useState(0);
    const [visitorsHasMore, setVisitorsHasMore] = useState(false);
    const [visitorsLoadingMore, setVisitorsLoadingMore] = useState(false);
    const VISITORS_PAGE_SIZE = 100;
    
    const isAdmin = actualUser?.role === 'admin';
    
    // Count active members without a tier assigned (use rawTier which is the actual HubSpot value)
    const membersWithoutTierCount = useMemo(() => {
        return members.filter(m => 
            (!m.role || m.role === 'member') && 
            (!m.rawTier || m.rawTier.trim() === '')
        ).length;
    }, [members]);
    
    // Handle opening the assign tier modal
    const openAssignTierModal = (member: MemberProfile) => {
        setMemberToAssignTier(member);
        setSelectedTierToAssign('');
        setAssignTierError(null);
        setAssignTierModalOpen(true);
    };
    
    // Handle tier assignment - push to HubSpot first, then update local DB
    const handleAssignTier = async () => {
        if (!memberToAssignTier || !selectedTierToAssign) return;
        
        setIsAssigningTier(true);
        setAssignTierError(null);
        
        try {
            // Push to HubSpot first, then update local DB
            const res = await fetch(`/api/hubspot/contacts/${memberToAssignTier.id}/tier`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ tier: selectedTierToAssign })
            });
            
            if (!res.ok) {
                const error = await res.json();
                throw new Error(error.error || 'Failed to update tier in HubSpot');
            }
            
            // Success - close modal and refresh members
            setAssignTierModalOpen(false);
            setMemberToAssignTier(null);
            await refreshMembers();
        } catch (err: any) {
            setAssignTierError(err.message || 'Failed to assign tier. Please try again.');
        } finally {
            setIsAssigningTier(false);
        }
    };

    const handleSync = async () => {
        setIsSyncing(true);
        setSyncMessage(null);
        
        let stripeCount = 0;
        let hubspotCount = 0;
        let errors: string[] = [];
        
        try {
            const stripeRes = await apiRequest('/api/stripe/sync-subscriptions', { 
                method: 'POST'
            });
            if (stripeRes.ok && stripeRes.data) {
                stripeCount = (stripeRes.data.created || 0) + (stripeRes.data.updated || 0);
            } else {
                errors.push('Stripe');
            }
        } catch {
            errors.push('Stripe');
        }
        
        try {
            const hubspotRes = await apiRequest('/api/hubspot/sync-all-members', { 
                method: 'POST'
            });
            if (hubspotRes.ok && hubspotRes.data) {
                hubspotCount = hubspotRes.data.synced || 0;
            } else {
                errors.push('HubSpot');
            }
        } catch {
            errors.push('HubSpot');
        }
        
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
        
        setIsSyncing(false);
        setTimeout(() => setSyncMessage(null), 5000);
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

    // Fetch visitors - defined before handleTabChange to avoid circular reference
    const fetchVisitors = useCallback(async (typeFilter?: VisitorType, sourceFilter?: VisitorSource, loadMore = false) => {
        if (loadMore) {
            setVisitorsLoadingMore(true);
        } else {
            setVisitorsLoading(true);
            setVisitorsOffset(0);
        }
        setVisitorsError(false);
        try {
            const params = new URLSearchParams();
            params.set('limit', VISITORS_PAGE_SIZE.toString());
            params.set('offset', loadMore ? (visitorsOffset + VISITORS_PAGE_SIZE).toString() : '0');
            if (typeFilter && typeFilter !== 'all') params.set('typeFilter', typeFilter);
            if (sourceFilter && sourceFilter !== 'all') params.set('sourceFilter', sourceFilter);
            
            const res = await fetch(`/api/visitors?${params.toString()}`, { credentials: 'include' });
            if (!res.ok) throw new Error('Failed to fetch visitors');
            const data = await res.json();
            
            if (loadMore) {
                setVisitors(prev => [...prev, ...(data.visitors || [])]);
                setVisitorsOffset(data.offset);
            } else {
                setVisitors(data.visitors || []);
                setVisitorsOffset(0);
            }
            setVisitorsTotal(data.total || 0);
            setVisitorsHasMore(data.hasMore || false);
        } catch (err) {
            console.error('Error loading visitors:', err);
            setVisitorsError(true);
        } finally {
            setVisitorsLoading(false);
            setVisitorsLoadingMore(false);
        }
    }, [visitorsOffset]);

    // Fetch former members or visitors when switching to that tab
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
        } else if (tab === 'visitors') {
            await fetchVisitors(visitorTypeFilter, visitorSourceFilter);
        }
    }, [fetchFormerMembers, fetchVisitors, visitorTypeFilter, visitorSourceFilter]);
    
    // Refetch visitors when filters change
    useEffect(() => {
        if (memberTab === 'visitors') {
            fetchVisitors(visitorTypeFilter, visitorSourceFilter);
        }
    }, [visitorTypeFilter, visitorSourceFilter, memberTab, fetchVisitors]);

    // Retry loading former members
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

    // Fetch visitor purchases
    const fetchVisitorPurchases = useCallback(async (visitorId: string) => {
        setPurchasesLoading(true);
        try {
            const res = await fetch(`/api/visitors/${visitorId}/purchases`, { credentials: 'include' });
            if (!res.ok) throw new Error('Failed to fetch purchases');
            const data = await res.json();
            setVisitorPurchases(data.purchases || []);
        } catch (err) {
            console.error('Error loading visitor purchases:', err);
            setVisitorPurchases([]);
        } finally {
            setPurchasesLoading(false);
        }
    }, []);

    // Convert visitor to MemberProfile format for drawer
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

    // Open visitor details drawer
    const openVisitorDetails = useCallback((visitor: Visitor) => {
        setSelectedVisitor(visitor);
        setVisitorDetailsOpen(true);
    }, []);

    // Get current member list based on tab - ensure arrays are always defined
    const currentMembers = memberTab === 'active' ? (members || []) : (formerMembers || []);
    
    const regularMembers = useMemo(() => 
        (currentMembers || []).filter(m => !m.role || m.role === 'member'), 
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

    // Sort visitors based on current sort field and direction
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
        
        // Missing tier filter (takes priority when active) - use rawTier which is the actual HubSpot value
        if (showMissingTierOnly && memberTab === 'active') {
            filtered = filtered.filter(m => !m.rawTier || m.rawTier.trim() === '');
        }
        
        // Tier filter
        if (tierFilter !== 'All' && !showMissingTierOnly) {
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
        
        // Billing filter
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
            {/* Active/Former Toggle + Sync Button */}
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
            
            {/* Needs Attention Alert - Members without tier */}
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
                {/* Search - only show for active/former tabs */}
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
                    {searchQuery && (
                        <button 
                            onClick={() => setSearchQuery('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-600"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
                        </button>
                    )}
                </div>
                )}
                
                {/* Tier Filter - only for active/former tabs */}
                {memberTab !== 'visitors' && (
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
                )}

                {/* Tag Filter - only for active/former tabs */}
                {memberTab !== 'visitors' && allTags.length > 0 && (
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

                {/* Billing Filter - only for active/former tabs */}
                {memberTab !== 'visitors' && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">Billing:</span>
                        {BILLING_OPTIONS.map(option => (
                            <button
                                key={option}
                                onClick={() => setBillingFilter(option)}
                                className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
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

                {/* Sort Dropdown with Direction Toggle - only for active/former tabs */}
                {memberTab !== 'visitors' && (
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
                        : `${filteredList.length} ${memberTab === 'former' ? 'former ' : ''}member${filteredList.length !== 1 ? 's' : ''} found`
                    }
                </p>
            </div>

            {/* Content area that fills remaining space */}
            <div key={memberTab} className="flex-1 flex flex-col min-h-0 overflow-hidden animate-content-enter">
                {/* Loading state for former members */}
                {formerLoading && memberTab === 'former' && (
                    <DirectoryTabSkeleton />
                )}

                {/* Error state - failed to load former members */}
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

                {/* Empty state - no former members in system */}
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

                {/* Empty state - search/filter returned no results */}
                {!formerLoading && filteredList.length === 0 && memberTab !== 'visitors' && (memberTab === 'active' || formerMembers.length > 0) && (
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

                {/* Visitors tab filters */}
                {memberTab === 'visitors' && (
                    <div className="flex flex-wrap gap-2 mb-4">
                        <select
                            value={visitorTypeFilter}
                            onChange={(e) => setVisitorTypeFilter(e.target.value as VisitorType)}
                            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/20 bg-white dark:bg-surface-dark text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                            aria-label="Filter by type"
                        >
                            <option value="all">All Types</option>
                            <option value="day_pass">Day Pass Buyers</option>
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
                            <option value="hubspot">HubSpot</option>
                            <option value="mindbody">MindBody</option>
                            <option value="stripe">Stripe</option>
                        </select>
                        <span className="ml-auto text-sm text-gray-500 dark:text-white/60 self-center">
                            {visitors.length.toLocaleString()} contacts
                        </span>
                    </div>
                )}

                {/* Loading state for visitors */}
                {visitorsLoading && memberTab === 'visitors' && (
                    <DirectoryTabSkeleton />
                )}

                {/* Error state - failed to load visitors */}
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
                            onClick={() => fetchVisitors(visitorTypeFilter, visitorSourceFilter)}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-bold transition-colors"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">refresh</span>
                            Retry
                        </button>
                    </div>
                )}

                {/* Empty state - no visitors in system */}
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

                {/* Visitors List - Mobile view */}
                {!visitorsLoading && !visitorsError && memberTab === 'visitors' && visitors.length > 0 && (
                    <div className="md:hidden flex-1 min-h-0 relative">
                        <div className="h-full overflow-y-auto pt-2 pb-24">
                            <div className="space-y-3 px-1">
                                {sortedVisitors.map((v, index) => (
                                    <div 
                                        key={v.id}
                                        onClick={() => openVisitorDetails(v)}
                                        className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors animate-slide-in-up"
                                        style={{ animationDelay: `${index * 40}ms` }}
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
                                                    v.type === 'day_pass' 
                                                        ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400'
                                                        : v.type === 'guest'
                                                        ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400'
                                                        : 'bg-gray-100 dark:bg-gray-500/20 text-gray-600 dark:text-gray-400'
                                                }`}>
                                                    {v.type === 'day_pass' ? 'Day Pass' : v.type === 'guest' ? 'Guest' : 'Lead'}
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
                                {/* Load More button for mobile */}
                                {visitorsHasMore && (
                                    <div className="py-4 text-center">
                                        <button
                                            onClick={() => fetchVisitors(visitorTypeFilter, visitorSourceFilter, true)}
                                            disabled={visitorsLoadingMore}
                                            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary/10 hover:bg-primary/20 dark:bg-white/10 dark:hover:bg-white/20 text-primary dark:text-white font-bold transition-colors disabled:opacity-50"
                                        >
                                            {visitorsLoadingMore ? (
                                                <>
                                                    <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
                                                    Loading...
                                                </>
                                            ) : (
                                                <>
                                                    <span className="material-symbols-outlined text-[18px]">expand_more</span>
                                                    Load More ({visitorsTotal - visitors.length} remaining)
                                                </>
                                            )}
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Visitors List - Desktop view */}
                {!visitorsLoading && !visitorsError && memberTab === 'visitors' && visitors.length > 0 && (
                    <div className="hidden md:flex flex-col flex-1 min-h-0 overflow-hidden">
                        <div className="flex bg-gray-50 dark:bg-white/5 border-b border-gray-200 dark:border-white/20 shrink-0">
                            <button 
                                onClick={() => {
                                    if (visitorSortField === 'name') {
                                        setVisitorSortDirection(d => d === 'asc' ? 'desc' : 'asc');
                                    } else {
                                        setVisitorSortField('name');
                                        setVisitorSortDirection('asc');
                                    }
                                }}
                                className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm text-left hover:bg-gray-100 dark:hover:bg-white/10 transition-colors flex items-center gap-1" 
                                style={{ width: '18%' }}
                            >
                                Name
                                {visitorSortField === 'name' && (
                                    <span className="material-symbols-outlined text-[14px]">
                                        {visitorSortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                                    </span>
                                )}
                            </button>
                            <div className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '22%' }}>Email</div>
                            <button 
                                onClick={() => {
                                    if (visitorSortField === 'type') {
                                        setVisitorSortDirection(d => d === 'asc' ? 'desc' : 'asc');
                                    } else {
                                        setVisitorSortField('type');
                                        setVisitorSortDirection('asc');
                                    }
                                }}
                                className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm text-left hover:bg-gray-100 dark:hover:bg-white/10 transition-colors flex items-center gap-1" 
                                style={{ width: '12%' }}
                            >
                                Type
                                {visitorSortField === 'type' && (
                                    <span className="material-symbols-outlined text-[14px]">
                                        {visitorSortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                                    </span>
                                )}
                            </button>
                            <button 
                                onClick={() => {
                                    if (visitorSortField === 'source') {
                                        setVisitorSortDirection(d => d === 'asc' ? 'desc' : 'asc');
                                    } else {
                                        setVisitorSortField('source');
                                        setVisitorSortDirection('asc');
                                    }
                                }}
                                className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm text-left hover:bg-gray-100 dark:hover:bg-white/10 transition-colors flex items-center gap-1" 
                                style={{ width: '12%' }}
                            >
                                Source
                                {visitorSortField === 'source' && (
                                    <span className="material-symbols-outlined text-[14px]">
                                        {visitorSortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                                    </span>
                                )}
                            </button>
                            <div className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm text-center" style={{ width: '10%' }}>Purchases</div>
                            <div className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm text-center" style={{ width: '12%' }}>Total Spent</div>
                            <button 
                                onClick={() => {
                                    if (visitorSortField === 'lastActivity') {
                                        setVisitorSortDirection(d => d === 'asc' ? 'desc' : 'asc');
                                    } else {
                                        setVisitorSortField('lastActivity');
                                        setVisitorSortDirection('desc');
                                    }
                                }}
                                className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm text-left hover:bg-gray-100 dark:hover:bg-white/10 transition-colors flex items-center gap-1" 
                                style={{ width: '14%' }}
                            >
                                Last Activity
                                {visitorSortField === 'lastActivity' && (
                                    <span className="material-symbols-outlined text-[14px]">
                                        {visitorSortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                                    </span>
                                )}
                            </button>
                        </div>
                        <div className="relative flex-1 min-h-0">
                            <div className="h-full overflow-y-auto pt-2">
                                {sortedVisitors.map((v, index) => (
                                    <div 
                                        key={v.id}
                                        onClick={() => openVisitorDetails(v)}
                                        className="flex items-center border-b border-gray-200 dark:border-white/20 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer animate-slide-in-up"
                                        style={{ animationDelay: `${index * 25}ms` }}
                                    >
                                        <div style={{ width: '18%' }} className="p-4 font-medium text-primary dark:text-white truncate">
                                            {[v.firstName, v.lastName].filter(Boolean).join(' ') || 'Unknown'}
                                        </div>
                                        <div style={{ width: '22%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm truncate" title={v.email || ''}>
                                            {v.email || '-'}
                                        </div>
                                        <div style={{ width: '12%' }} className="p-4">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                v.type === 'day_pass' 
                                                    ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400'
                                                    : v.type === 'guest'
                                                    ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400'
                                                    : 'bg-gray-100 dark:bg-gray-500/20 text-gray-600 dark:text-gray-400'
                                            }`}>
                                                {v.type === 'day_pass' ? 'Day Pass' : v.type === 'guest' ? 'Guest' : 'Lead'}
                                            </span>
                                        </div>
                                        <div style={{ width: '12%' }} className="p-4">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                v.source === 'hubspot' ? 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400' :
                                                v.source === 'stripe' ? 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400' :
                                                v.source === 'mindbody' ? 'bg-teal-100 dark:bg-teal-500/20 text-teal-700 dark:text-teal-400' :
                                                'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400'
                                            }`}>
                                                {v.source === 'hubspot' ? 'HubSpot' : v.source === 'stripe' ? 'Stripe' : v.source === 'mindbody' ? 'MindBody' : 'App'}
                                            </span>
                                        </div>
                                        <div style={{ width: '10%' }} className="p-4 text-center text-gray-600 dark:text-gray-400 text-sm font-medium">
                                            {v.purchaseCount || 0}
                                        </div>
                                        <div style={{ width: '12%' }} className="p-4 text-center text-gray-600 dark:text-gray-400 text-sm font-medium">
                                            ${((v.totalSpentCents || 0) / 100).toFixed(2)}
                                        </div>
                                        <div style={{ width: '14%' }} className="p-4 text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
                                            {formatJoinDate(v.lastActivityAt || v.lastPurchaseDate || v.lastGuestDate)}
                                        </div>
                                    </div>
                                ))}
                                {/* Load More button for desktop */}
                                {visitorsHasMore && (
                                    <div className="p-4 text-center">
                                        <button
                                            onClick={() => fetchVisitors(visitorTypeFilter, visitorSourceFilter, true)}
                                            disabled={visitorsLoadingMore}
                                            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary/10 hover:bg-primary/20 dark:bg-white/10 dark:hover:bg-white/20 text-primary dark:text-white font-bold transition-colors disabled:opacity-50"
                                        >
                                            {visitorsLoadingMore ? (
                                                <>
                                                    <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
                                                    Loading...
                                                </>
                                            ) : (
                                                <>
                                                    <span className="material-symbols-outlined text-[18px]">expand_more</span>
                                                    Load More ({visitorsTotal - visitors.length} remaining)
                                                </>
                                            )}
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Mobile view - Virtualized only for large lists (members only) */}
                {!formerLoading && memberTab !== 'visitors' && filteredList.length > 0 && (
                <div className="md:hidden flex-1 min-h-0 relative">
                    <div className="h-full overflow-y-auto pt-2 pb-24">
                        {/* Non-virtualized rendering for small lists */}
                        {filteredList.length < VIRTUALIZATION_THRESHOLD ? (
                            <div className="space-y-3 px-1">
                                {filteredList.map((m, index) => (
                                    <div 
                                        key={m.email}
                                        onClick={() => openDetailsModal(m)}
                                        className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors animate-slide-in-up"
                                        style={{ animationDelay: `${index * 40}ms` }}
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
                        ) : (
                            /* Virtualized rendering for large lists - react-window v2 API with named component */
                            <List
                                defaultHeight={500}
                                rowCount={filteredList.length}
                                rowHeight={180}
                                overscanCount={3}
                                rowProps={{ data: filteredList, memberTab, isAdmin, openDetailsModal, openAssignTierModal, handleViewAs }}
                                rowComponent={MobileRowComponent}
                            />
                        )}
                    </div>
                </div>
            )}

            {/* Desktop view - Virtualized only for large lists with flex-based layout (members only) */}
            {!formerLoading && memberTab !== 'visitors' && filteredList.length > 0 && (
            <div className="hidden md:flex flex-col flex-1 min-h-0 overflow-hidden">
                {/* Header row - fixed */}
                <div className="flex bg-gray-50 dark:bg-white/5 border-b border-gray-200 dark:border-white/20 shrink-0 rounded-t-xl overflow-hidden">
                    <SortableHeader field="name" label="Name" width="15%" />
                    <SortableHeader field="tier" label="Tier" width="20%" />
                    <SortableHeader field="visits" label="Visits" width="8%" className="text-center" />
                    <SortableHeader field="joinDate" label="Joined" width="10%" />
                    <SortableHeader field="lastVisit" label="Last Visit" width="10%" />
                    <div 
                        className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm"
                        style={{ width: memberTab === 'former' ? '22%' : '37%' }}
                    >
                        Email
                    </div>
                    {memberTab === 'former' && (
                        <div className="p-4 font-semibold text-gray-600 dark:text-gray-300 text-sm" style={{ width: '15%' }}>
                            Status
                        </div>
                    )}
                </div>
                
                {/* Scrollable list body */}
                <div className="relative flex-1 min-h-0">
                    <div className="h-full overflow-y-auto">
                        {/* Non-virtualized body for small lists */}
                        {filteredList.length < VIRTUALIZATION_THRESHOLD ? (
                            <div className="pt-2">
                                {filteredList.map((m, index) => (
                                    <div 
                                        key={m.email}
                                        onClick={() => openDetailsModal(m)}
                                        className="flex items-center border-b border-gray-200 dark:border-white/20 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer animate-slide-in-up"
                                        style={{ animationDelay: `${index * 25}ms` }}
                                    >
                                        <div style={{ width: '15%' }} className="p-4 font-medium text-primary dark:text-white truncate">{m.name}</div>
                                        <div style={{ width: '20%' }} className="p-4">
                                            <div className="flex items-center gap-1 flex-wrap">
                                                <TierBadge tier={m.rawTier} size="sm" showNoTier={true} />
                                                {m.tags?.map(tag => (
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
                        ) : (
                            /* Virtualized body for large lists - react-window v2 API with named component */
                            <List
                                defaultHeight={400}
                                rowCount={filteredList.length}
                                rowHeight={56}
                                overscanCount={5}
                                rowProps={{ data: filteredList, memberTab, isAdmin, openDetailsModal, openAssignTierModal }}
                                rowComponent={DesktopRowComponent}
                            />
                        )}
                    </div>
                </div>
            </div>
            )}
            </div>

            <MemberProfileDrawer
                isOpen={isViewingDetails && !!selectedMember}
                member={selectedMember}
                isAdmin={isAdmin}
                onClose={() => { setIsViewingDetails(false); setSelectedMember(null); }}
                onViewAs={(member) => { setIsViewingDetails(false); setSelectedMember(null); handleViewAs(member); }}
                onMemberDeleted={() => { refreshMembers(); }}
            />

            {/* Add Member FAB - Improved with safe-area padding, tooltip, and glow effect */}
            {createPortal(
                <div className="fixed right-5 z-[9998] pointer-events-none" style={{ bottom: 'calc(120px + env(safe-area-inset-bottom, 0px))' }}>
                    <div className="relative group pointer-events-auto">
                        {/* Desktop Tooltip */}
                        <div className="absolute bottom-full right-0 mb-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                            <div className="bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium px-3 py-2 rounded-lg whitespace-nowrap shadow-lg">
                                Add Member
                                <div className="absolute top-full right-2 w-2 h-2 bg-gray-900 dark:bg-white transform rotate-45"></div>
                            </div>
                        </div>
                        
                        {/* FAB Button with Enhanced Styling */}
                        <button
                            onClick={() => setAddMemberModalOpen(true)}
                            className="w-14 h-14 rounded-full flex items-center justify-center bg-[#293515] dark:bg-[#CCB8E4] text-white dark:text-[#293515] transition-all duration-300 hover:scale-110 active:scale-95 shadow-lg hover:shadow-xl"
                            aria-label="Add New Member"
                        >
                            <span className="material-symbols-outlined text-2xl">person_add</span>
                        </button>
                    </div>
                </div>,
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

            {/* Assign Tier Modal */}
            {assignTierModalOpen && memberToAssignTier && createPortal(
                <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
                    <div 
                        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                        onClick={() => { setAssignTierModalOpen(false); setMemberToAssignTier(null); }}
                    />
                    <div className="relative bg-white dark:bg-surface-dark rounded-2xl shadow-2xl w-full max-w-md p-6 animate-pop-in">
                        <button
                            onClick={() => { setAssignTierModalOpen(false); setMemberToAssignTier(null); }}
                            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                        >
                            <span className="material-symbols-outlined">close</span>
                        </button>
                        
                        <div className="flex items-center gap-3 mb-6">
                            <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center">
                                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">person_add</span>
                            </div>
                            <div>
                                <h3 className="text-lg font-bold text-gray-900 dark:text-white">Assign Tier</h3>
                                <p className="text-sm text-gray-500 dark:text-gray-400">{memberToAssignTier.name}</p>
                            </div>
                        </div>
                        
                        <div className="mb-6">
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">
                                Select Membership Tier
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                {ASSIGNABLE_TIERS.map(tier => {
                                    const colors = getTierColor(tier);
                                    const isSelected = selectedTierToAssign === tier;
                                    return (
                                        <button
                                            key={tier}
                                            onClick={() => setSelectedTierToAssign(tier)}
                                            className={`p-3 rounded-xl text-sm font-bold transition-all ${
                                                isSelected 
                                                    ? 'ring-2 ring-offset-2 ring-primary dark:ring-lavender scale-[1.02]' 
                                                    : 'hover:scale-[1.02]'
                                            }`}
                                            style={{
                                                backgroundColor: colors.bg,
                                                color: colors.text,
                                                border: `2px solid ${colors.border}`
                                            }}
                                        >
                                            {tier}
                                        </button>
                                    );
                                })}
                            </div>
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
                                disabled={!selectedTierToAssign || isAssigningTier}
                                className="flex-1 px-4 py-2.5 rounded-xl bg-primary dark:bg-lavender text-white font-bold hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                            >
                                {isAssigningTier ? (
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

            {/* Visitor Profile Drawer */}
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
