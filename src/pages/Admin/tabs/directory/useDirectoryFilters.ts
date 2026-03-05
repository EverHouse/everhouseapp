import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { MemberProfile } from '../../../../contexts/DataContext';
import { getMemberStatusLabel, getMemberStatusBadgeClass } from '../../../../utils/statusColors';
import {
    type MemberTab,
    type BillingFilter,
    type SortField,
    type SortDirection,
    type VisitorType,
    type VisitorSource,
    type VisitorSortField,
} from './directoryTypes';

interface UseDirectoryFiltersParams {
    members: MemberProfile[];
    formerMembers: MemberProfile[];
    memberTab: MemberTab;
}

export function useDirectoryFilters({ members, formerMembers, memberTab }: UseDirectoryFiltersParams) {
    const [searchQuery, setSearchQuery] = useState('');
    const [tierFilter, setTierFilter] = useState<string>('All');
    const [statusFilter, setStatusFilter] = useState<string>('All');
    const [membershipStatusFilter, setMembershipStatusFilter] = useState<string>('All');
    const [appUsageFilter, setAppUsageFilter] = useState<'All' | 'Logged In' | 'Never Logged In'>('All');
    const [billingFilter, setBillingFilter] = useState<BillingFilter>('All');
    const [discountFilter, setDiscountFilter] = useState<string>('All');
    const [showMissingTierOnly, setShowMissingTierOnly] = useState(false);
    const [showRecentlyAdded, setShowRecentlyAdded] = useState(false);
    const [sortField, setSortField] = useState<SortField>('name');
    const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const filterPopoverRef = useRef<HTMLDivElement>(null);
    const [sortOpen, setSortOpen] = useState(false);
    const sortPopoverRef = useRef<HTMLDivElement>(null);

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

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            setDebouncedVisitorSearch(visitorSearchQuery);
        }, 300);
        return () => clearTimeout(timeoutId);
    }, [visitorSearchQuery]);

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

    const currentMembers = memberTab === 'active' ? (members || []) : (formerMembers || []);
    
    const regularMembers = useMemo(() => {
        if (!Array.isArray(currentMembers)) return [];
        return currentMembers.filter(m => m && (!m.role || m.role === 'member'));
    }, [currentMembers]);

    const membersWithoutTierCount = useMemo(() => {
        if (!Array.isArray(members)) return 0;
        return members.filter(m => 
            m && (!m.role || m.role === 'member') && 
            (!m.rawTier || m.rawTier.trim() === '')
        ).length;
    }, [members]);

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
            setShowRecentlyAdded(false);
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
            if (showRecentlyAdded) filters.push({ key: 'recent', label: 'Recently Added (24h)', onRemove: () => setShowRecentlyAdded(false) });
            if (tierFilter !== 'All') filters.push({ key: 'tier', label: `Tier: ${tierFilter}`, onRemove: () => setTierFilter('All') });
            if (membershipStatusFilter !== 'All') filters.push({ key: 'status', label: `Status: ${getMemberStatusLabel(membershipStatusFilter)}`, onRemove: () => setMembershipStatusFilter('All') });
            if (appUsageFilter !== 'All') filters.push({ key: 'app', label: `App: ${appUsageFilter}`, onRemove: () => setAppUsageFilter('All') });
            if (billingFilter !== 'All') filters.push({ key: 'billing', label: `Billing: ${billingFilter}`, onRemove: () => setBillingFilter('All') });
            if (discountFilter !== 'All') filters.push({ key: 'discount', label: `Discount: ${discountFilter}`, onRemove: () => setDiscountFilter('All') });
        }

        return filters;
    }, [memberTab, tierFilter, statusFilter, membershipStatusFilter, appUsageFilter, billingFilter, discountFilter, visitorTypeFilter, visitorSourceFilter, purchaseFilter, showRecentlyAdded]);

    const activeFilterCount = activeFilters.length;

    const filteredList = useMemo(() => {
        let filtered = regularMembers;
        
        if (showRecentlyAdded && memberTab === 'active') {
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            filtered = filtered.filter(m => {
                if (!m.joinDate) return false;
                const joinDate = new Date(m.joinDate);
                return joinDate >= twentyFourHoursAgo;
            });
        }

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
    }, [regularMembers, tierFilter, appUsageFilter, statusFilter, membershipStatusFilter, billingFilter, discountFilter, memberTab, searchQuery, sortField, sortDirection, showMissingTierOnly, showRecentlyAdded]);

    const handleSort = useCallback((field: SortField) => {
        if (sortField === field) {
            setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDirection('asc');
        }
    }, [sortField]);

    const getSortIcon = useCallback((field: SortField) => {
        if (sortField !== field) return 'unfold_more';
        return sortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward';
    }, [sortField, sortDirection]);

    const resetForTabChange = useCallback(() => {
        setStatusFilter('All');
        setMembershipStatusFilter('All');
        setDiscountFilter('All');
        setPurchaseFilter('all');
    }, []);

    return {
        searchQuery, setSearchQuery,
        tierFilter, setTierFilter,
        statusFilter, setStatusFilter,
        membershipStatusFilter, setMembershipStatusFilter,
        appUsageFilter, setAppUsageFilter,
        billingFilter, setBillingFilter,
        discountFilter, setDiscountFilter,
        showMissingTierOnly, setShowMissingTierOnly,
        showRecentlyAdded, setShowRecentlyAdded,
        sortField, setSortField,
        sortDirection, setSortDirection,
        filtersOpen, setFiltersOpen,
        filterPopoverRef,
        sortOpen, setSortOpen,
        sortPopoverRef,
        visitorTypeFilter, setVisitorTypeFilter,
        visitorSourceFilter, setVisitorSourceFilter,
        visitorSearchQuery, setVisitorSearchQuery,
        debouncedVisitorSearch,
        visitorSortField, setVisitorSortField,
        visitorSortDirection, setVisitorSortDirection,
        visitorsPage, setVisitorsPage,
        visitorArchiveView, setVisitorArchiveView,
        purchaseFilter, setPurchaseFilter,
        teamSearchQuery, setTeamSearchQuery,
        membersWithoutTierCount,
        regularMembers,
        filteredList,
        discountCodes,
        clearAllFilters,
        activeFilters,
        activeFilterCount,
        handleSort,
        getSortIcon,
        resetForTabChange,
    };
}
