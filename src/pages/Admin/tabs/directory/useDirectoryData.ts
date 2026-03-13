import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MemberProfile } from '../../../../contexts/DataContext';
import { fetchWithCredentials, postWithCredentials } from '../../../../hooks/queries/useFetch';
import { useToast } from '../../../../components/Toast';
import {
    type MemberTab,
    type VisitorType,
    type VisitorSource,
    type Visitor,
    type TeamMember,
    type VisitorPurchase,
    type VisitorsResponse,
    type SyncStatusResponse,
    type SyncResponse,
    type DirectorySyncResult,
    directoryKeys,
    VISITORS_PAGE_SIZE,
    ITEMS_PER_PAGE,
    VIRTUALIZATION_THRESHOLD,
} from './directoryTypes';

export function useIncrementalLoad<T>(items: T[], threshold: number = VIRTUALIZATION_THRESHOLD) {
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

interface UseDirectoryDataParams {
    memberTab: MemberTab;
    visitorTypeFilter: VisitorType;
    visitorSourceFilter: VisitorSource;
    debouncedVisitorSearch: string;
    visitorsPage: number;
    visitorArchiveView: 'active' | 'archived';
    selectedVisitorId: string | null;
    visitorDetailsOpen: boolean;
    refreshMembers: () => Promise<unknown>;
    fetchFormerMembers: (force?: boolean) => Promise<void>;
}

export function useDirectoryData({
    memberTab,
    visitorTypeFilter,
    visitorSourceFilter,
    debouncedVisitorSearch,
    visitorsPage,
    visitorArchiveView,
    selectedVisitorId,
    visitorDetailsOpen,
    refreshMembers,
    fetchFormerMembers,
}: UseDirectoryDataParams) {
    const queryClient = useQueryClient();
    const { showToast } = useToast();

    const [formerLoading, setFormerLoading] = useState(false);
    const [formerError, setFormerError] = useState(false);
    const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'warning' | 'error'; text: string } | null>(null);
    const lastAppliedJobIdRef = useRef<string | null>(null);
    const [optimisticTiers, setOptimisticTiers] = useState<Record<string, string>>({});
    const [pendingTierUpdates, setPendingTierUpdates] = useState<Set<string>>(new Set());

    const { data: syncStatusData } = useQuery({
        queryKey: directoryKeys.syncStatus(),
        queryFn: () => fetchWithCredentials<SyncStatusResponse>('/api/directory/sync-status'),
        staleTime: 10000,
        refetchInterval: (query) => {
            const data = query.state.data;
            if (data && data.status === 'running') return 5000;
            return false;
        },
    });
    const lastSyncTime = syncStatusData?.lastSyncTime ?? null;
    const isSyncRunning = syncStatusData?.status === 'running';

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
        queryKey: directoryKeys.visitorPurchases(selectedVisitorId ?? ''),
        queryFn: async () => {
            if (!selectedVisitorId) return [];
            const data = await fetchWithCredentials<{ purchases: VisitorPurchase[] }>(`/api/visitors/${selectedVisitorId}/purchases`);
            return data.purchases ?? [];
        },
        enabled: !!selectedVisitorId && visitorDetailsOpen,
        staleTime: 30000,
    });

    const formatSyncResult = useCallback((result: DirectorySyncResult) => {
        const { pullCount, pushCount, stripeUpdated, errors } = result;
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
            return { type: 'error' as const, text: 'Failed to sync' };
        }
        return {
            type: (hasAnyError ? 'warning' : 'success') as 'warning' | 'success',
            text: parts.length > 0 ? parts.join('. ') : 'All up to date'
        };
    }, []);

    useEffect(() => {
        const jobId = syncStatusData?.jobId;
        if (!jobId || lastAppliedJobIdRef.current === jobId) return;

        if (syncStatusData?.status === 'completed' && syncStatusData.result) {
            lastAppliedJobIdRef.current = jobId;
            refreshMembers();
            if (memberTab === 'former') {
                setFormerLoading(true);
                fetchFormerMembers().finally(() => setFormerLoading(false));
            }
            const msg = formatSyncResult(syncStatusData.result);
            setSyncMessage(msg);
            const timer = setTimeout(() => setSyncMessage(null), 5000);
            return () => clearTimeout(timer);
        }
        if (syncStatusData?.status === 'failed') {
            lastAppliedJobIdRef.current = jobId;
            setSyncMessage({ type: 'error', text: syncStatusData.error || 'Failed to sync' });
            const timer = setTimeout(() => setSyncMessage(null), 5000);
            return () => clearTimeout(timer);
        }
    }, [syncStatusData?.status, syncStatusData?.jobId, formatSyncResult, refreshMembers, memberTab, fetchFormerMembers, setFormerLoading]);

    useEffect(() => {
        const handleDirectorySyncUpdate = (event: CustomEvent) => {
            const { status, result, error, jobId: wsJobId } = event.detail || {};
            
            queryClient.invalidateQueries({ queryKey: directoryKeys.syncStatus() });

            if (status === 'completed') {
                if (wsJobId && lastAppliedJobIdRef.current === wsJobId) return;
                if (wsJobId) lastAppliedJobIdRef.current = wsJobId;

                refreshMembers();
                if (memberTab === 'former') {
                    setFormerLoading(true);
                    fetchFormerMembers().finally(() => setFormerLoading(false));
                }
                if (result) {
                    const msg = formatSyncResult(result as DirectorySyncResult);
                    setSyncMessage(msg);
                    setTimeout(() => setSyncMessage(null), 5000);
                }
            } else if (status === 'failed') {
                if (wsJobId && lastAppliedJobIdRef.current === wsJobId) return;
                if (wsJobId) lastAppliedJobIdRef.current = wsJobId;

                setSyncMessage({ type: 'error', text: error || 'Failed to sync' });
                setTimeout(() => setSyncMessage(null), 5000);
            }
        };

        window.addEventListener('directory-sync-update', handleDirectorySyncUpdate as EventListener);
        return () => {
            window.removeEventListener('directory-sync-update', handleDirectorySyncUpdate as EventListener);
        };
    }, [queryClient, refreshMembers, memberTab, fetchFormerMembers, formatSyncResult, setFormerLoading]);

    const syncMutation = useMutation({
        mutationFn: async () => {
            return postWithCredentials<{ started: boolean; jobId: string; message?: string }>('/api/directory/sync', {});
        },
        onSuccess: (data) => {
            if (!data.started) {
                setSyncMessage({ type: 'warning', text: data.message || 'Sync already in progress' });
                setTimeout(() => setSyncMessage(null), 5000);
            }
            queryClient.invalidateQueries({ queryKey: directoryKeys.syncStatus() });
        },
        onError: () => {
            setSyncMessage({ type: 'error', text: 'Failed to start sync' });
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
        },
    });

    const getDisplayTier = useCallback((member: MemberProfile): string | null => {
        if (optimisticTiers[member.email]) {
            return optimisticTiers[member.email];
        }
        return member.rawTier || member.tier || null;
    }, [optimisticTiers]);
    
    const isMemberPendingUpdate = useCallback((memberEmail: string): boolean => {
        return pendingTierUpdates.has(memberEmail);
    }, [pendingTierUpdates]);

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

    return {
        lastSyncTime,
        isSyncRunning,
        visitors,
        visitorsTotal,
        visitorsTotalPages,
        visitorsLoading,
        visitorsError,
        refetchVisitors,
        teamMembers,
        teamLoading,
        teamError,
        refetchTeam,
        visitorPurchases,
        purchasesLoading,
        syncMutation,
        syncMessage,
        assignTierMutation,
        formerLoading,
        formerError,
        setFormerLoading,
        setFormerError,
        getDisplayTier,
        isMemberPendingUpdate,
        visitorToMemberProfile,
        teamMemberToMemberProfile,
        handleRetryFormer,
    };
}
