import { useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../../../components/Toast';
import { sortBySeverity } from '../../../../data/integrityCheckMetadata';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials } from '../../../../hooks/queries/useFetch';
import type { MemberProfile } from '../../../../types/data';
import type {
  IntegrityIssue,
  CachedResultsResponse,
  IntegrityRunResponse,
  CalendarStatusResponse,
  HistoryData,
  AuditLogEntry,
  IgnoredIssueEntry,
  ActiveIssue,
  SystemHealth,
} from './dataIntegrityTypes';
import type { DataIntegrityState } from './useDataIntegrityState';

interface HubspotSyncMember {
  email: string;
  firstName?: string;
  lastName?: string;
  tier?: string;
  status?: string;
}

interface SubscriptionUpdate {
  email: string;
  oldStatus?: string;
  newStatus?: string;
  reason?: string;
}

interface OrphanedStripeRecord {
  email: string;
  stripeCustomerId?: string;
  reason?: string;
}

interface StripeHubspotMember {
  email: string;
  name?: string;
  stripeCustomerId?: string;
  hubspotId?: string;
}

interface PaymentUpdate {
  email: string;
  oldStatus?: string;
  newStatus?: string;
}

interface VisitMismatch {
  email: string;
  name?: string;
  currentCount?: number;
  actualCount?: number;
}

interface OrphanedParticipantDetail {
  email: string;
  bookingId?: number;
  action?: string;
}

interface DuplicateRecord {
  email: string;
  emails?: string[];
  name?: string;
  count?: number;
}

interface UnlinkedGuestFee {
  id: number;
  guest_name?: string;
  guest_email?: string;
  fee_amount?: number;
  booking_date?: string;
  member_email?: string;
  memberEmail?: string;
  saleDate?: string;
}

interface AvailableSession {
  id: number;
  date: string;
  start_time: string;
  end_time: string;
  resource_name?: string;
}

interface AttendanceBooking {
  id: number;
  user_email?: string;
  user_name?: string;
  request_date?: string;
  start_time?: string;
  end_time?: string;
  status?: string;
  resource_name?: string;
}

interface StripeCacheStats {
  cached?: number;
  total?: number;
  failed?: number;
  paymentIntents?: number;
  charges?: number;
  invoices?: number;
}

interface PlaceholderAccount {
  id?: string;
  email: string;
  name?: string;
  source?: string;
  createdAt?: string;
  created?: number;
  status?: string;
}

interface BackgroundJobStatus {
  hasJob: boolean;
  job?: { id: string; status: string; progress?: number; result?: unknown; error?: string };
}

interface StripeCleanupJobResult {
  success: boolean;
  message: string;
  dryRun?: boolean;
  totalCustomers?: number;
  emptyCount?: number;
  skippedActiveCount?: number;
  customers?: Array<{ id: string; email: string; name: string; created: string }>;
  deleted?: Array<{ id: string; email: string }>;
  deletedCount?: number;
}

interface VisitorArchiveJobResult {
  success: boolean;
  message: string;
  dryRun?: boolean;
  totalScanned?: number;
  eligibleCount?: number;
  keptCount?: number;
  archivedCount?: number;
  sampleArchived?: Array<{ name: string; email: string }>;
}

interface MemberDetails {
  id?: unknown;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  tier?: string;
  membershipStatus?: string;
  tags?: string[];
  phone?: string;
  role?: 'admin' | 'member' | 'staff';
  mindbodyClientId?: string;
  stripeCustomerId?: string;
  hubspotId?: string;
  dateOfBirth?: string;
  billingProvider?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  [key: string]: unknown;
}

export function useDataIntegrityActions(state: DataIntegrityState) {
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const { 
    data: cachedData, 
    isLoading: isLoadingCached,
    refetch: refetchCached
  } = useQuery({
    queryKey: ['data-integrity', 'cached'],
    queryFn: () => fetchWithCredentials<CachedResultsResponse>('/api/data-integrity/cached'),
  });

  const { 
    data: calendarStatus, 
    isLoading: isLoadingCalendars 
  } = useQuery({
    queryKey: ['data-integrity', 'calendars'],
    queryFn: () => fetchWithCredentials<CalendarStatusResponse>('/api/admin/calendars'),
  });

  const { 
    data: historyData, 
    isLoading: isLoadingHistory 
  } = useQuery({
    queryKey: ['data-integrity', 'history'],
    queryFn: () => fetchWithCredentials<HistoryData>('/api/data-integrity/history'),
  });

  const { 
    data: auditLog = [], 
    isLoading: isLoadingAuditLog 
  } = useQuery({
    queryKey: ['data-integrity', 'audit-log'],
    queryFn: () => fetchWithCredentials<AuditLogEntry[]>('/api/data-integrity/audit-log?limit=10'),
  });

  const { 
    data: ignoredIssues = [], 
    isLoading: isLoadingIgnored 
  } = useQuery({
    queryKey: ['data-integrity', 'ignores'],
    queryFn: () => fetchWithCredentials<IgnoredIssueEntry[]>('/api/data-integrity/ignores'),
  });

  const results = cachedData?.hasCached ? sortBySeverity(cachedData.results) : [];
  const meta = cachedData?.meta || null;
  const isCached = cachedData?.hasCached || false;

  const runIntegrityMutation = useMutation({
    mutationFn: () => fetchWithCredentials<IntegrityRunResponse>('/api/data-integrity/run'),
    onSuccess: (data) => {
      queryClient.setQueryData(['data-integrity', 'cached'], {
        hasCached: true,
        results: data.results,
        meta: data.meta,
      });
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'history'] });
      showToast('Integrity checks completed', 'success');
    },
    onError: (err: Error) => {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to run integrity checks', 'error');
    },
  });

  useEffect(() => {
    if (cachedData && !cachedData.hasCached && !runIntegrityMutation.isPending) {
      runIntegrityMutation.mutate();
    }
  }, [cachedData]);

  useEffect(() => {
    const handleDataIntegrityUpdate = (event: CustomEvent) => {
      const { action } = event.detail || {};
      console.log('[DataIntegrity] Real-time update received:', action);
      
      if (action === 'data_changed' || action === 'issue_resolved') {
        queryClient.invalidateQueries({ queryKey: ['data-integrity', 'cached'] });
        queryClient.invalidateQueries({ queryKey: ['data-integrity', 'history'] });
        queryClient.invalidateQueries({ queryKey: ['data-integrity', 'audit-log'] });
      }
    };

    window.addEventListener('data-integrity-update', handleDataIntegrityUpdate as EventListener);
    return () => {
      window.removeEventListener('data-integrity-update', handleDataIntegrityUpdate as EventListener);
    };
  }, [queryClient]);

  const closeIgnoreModal = () => {
    state.setIgnoreModal({ isOpen: false, issue: null, checkName: '' });
    state.setIgnoreDuration('24h');
    state.setIgnoreReason('');
  };

  const closeBulkIgnoreModal = () => {
    state.setBulkIgnoreModal({ isOpen: false, checkName: '', issues: [] });
    state.setIgnoreDuration('24h');
    state.setIgnoreReason('');
  };

  const ignoreIssueMutation = useMutation({
    mutationFn: (params: { issueKey: string; duration: string; reason: string }) => 
      postWithCredentials<{ success: boolean }>('/api/data-integrity/ignore', {
        issue_key: params.issueKey,
        duration: params.duration,
        reason: params.reason,
      }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ['data-integrity'] });
      const snapshot = queryClient.getQueryData<CachedResultsResponse>(['data-integrity', 'cached']);
      queryClient.setQueryData(['data-integrity', 'cached'], (old: CachedResultsResponse | undefined) => {
        if (!old?.hasCached) return old;
        return {
          ...old,
          results: old.results.map((check) => ({
            ...check,
            issues: Array.isArray(check.issues)
              ? check.issues.filter((d) => d.context?.issueKey !== variables.issueKey && d.issueKey !== variables.issueKey)
              : check.issues,
            issueCount: Array.isArray(check.issues)
              ? check.issues.filter((d) => d.context?.issueKey !== variables.issueKey && d.issueKey !== variables.issueKey).length
              : check.issueCount,
          })).filter((check) => check.issueCount > 0),
        };
      });
      closeIgnoreModal();
      return { snapshot };
    },
    onSuccess: () => {
      showToast('Issue ignored successfully', 'success');
    },
    onError: (err: Error, _variables, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(['data-integrity', 'cached'], context.snapshot);
      }
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to ignore issue', 'error');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'ignores'] });
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'cached'] });
    },
  });

  const unignoreIssueMutation = useMutation({
    mutationFn: (issueKey: string) => 
      deleteWithCredentials<{ success: boolean }>(`/api/data-integrity/ignore/${encodeURIComponent(issueKey)}`),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['data-integrity'] });
    },
    onSuccess: () => {
      showToast('Issue un-ignored successfully', 'success');
    },
    onError: (err: Error) => {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to un-ignore issue', 'error');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'ignores'] });
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'cached'] });
    },
  });

  const bulkIgnoreMutation = useMutation({
    mutationFn: (params: { issueKeys: string[]; duration: string; reason: string }) => 
      postWithCredentials<{ total: number }>('/api/data-integrity/ignore-bulk', {
        issue_keys: params.issueKeys,
        duration: params.duration,
        reason: params.reason,
      }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ['data-integrity'] });
      const snapshot = queryClient.getQueryData<CachedResultsResponse>(['data-integrity', 'cached']);
      const ignoredKeys = new Set(variables.issueKeys);
      queryClient.setQueryData(['data-integrity', 'cached'], (old: CachedResultsResponse | undefined) => {
        if (!old?.hasCached) return old;
        return {
          ...old,
          results: old.results.map((check) => ({
            ...check,
            issues: Array.isArray(check.issues)
              ? check.issues.filter((d) => !ignoredKeys.has(d.issueKey as string) && !ignoredKeys.has(d.context?.issueKey as string))
              : check.issues,
            issueCount: Array.isArray(check.issues)
              ? check.issues.filter((d) => !ignoredKeys.has(d.issueKey as string) && !ignoredKeys.has(d.context?.issueKey as string)).length
              : check.issueCount,
          })).filter((check) => check.issueCount > 0),
        };
      });
      closeBulkIgnoreModal();
      return { snapshot };
    },
    onSuccess: (data) => {
      showToast(`${data.total} issues excluded successfully`, 'success');
    },
    onError: (err: Error, _variables, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(['data-integrity', 'cached'], context.snapshot);
      }
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to exclude issues', 'error');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'ignores'] });
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'cached'] });
    },
  });

  const syncPushMutation = useMutation({
    mutationFn: (params: { issueKey: string; target: string; userId?: number; hubspotContactId?: string }) => 
      postWithCredentials<{ message: string }>('/api/data-integrity/sync-push', params),
    onSuccess: (data, variables) => {
      state.setSyncingIssues(prev => {
        const next = new Set(prev);
        next.delete(variables.issueKey);
        return next;
      });
      showToast(data.message || 'Successfully pushed to external system', 'success');
      queryClient.setQueryData(['data-integrity', 'cached'], (old: CachedResultsResponse | undefined) => {
        if (!old?.hasCached) return old;
        return {
          ...old,
          results: old.results.map((check) => ({
            ...check,
            issues: Array.isArray(check.issues)
              ? check.issues.filter((d) => d.issueKey !== variables.issueKey)
              : check.issues,
            issueCount: Array.isArray(check.issues)
              ? check.issues.filter((d) => d.issueKey !== variables.issueKey).length
              : check.issueCount,
          })).filter((check) => check.issueCount > 0),
        };
      });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['data-integrity', 'cached'] });
      }, 2000);
    },
    onError: (err: Error, variables) => {
      state.setSyncingIssues(prev => {
        const next = new Set(prev);
        next.delete(variables.issueKey);
        return next;
      });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to push sync', 'error');
    },
  });

  const syncPullMutation = useMutation({
    mutationFn: (params: { issueKey: string; target: string; userId?: number; hubspotContactId?: string }) => 
      postWithCredentials<{ message: string }>('/api/data-integrity/sync-pull', params),
    onSuccess: (data, variables) => {
      state.setSyncingIssues(prev => {
        const next = new Set(prev);
        next.delete(variables.issueKey);
        return next;
      });
      showToast(data.message || 'Successfully pulled from external system', 'success');
      queryClient.setQueryData(['data-integrity', 'cached'], (old: CachedResultsResponse | undefined) => {
        if (!old?.hasCached) return old;
        return {
          ...old,
          results: old.results.map((check) => ({
            ...check,
            issues: Array.isArray(check.issues)
              ? check.issues.filter((d) => d.issueKey !== variables.issueKey)
              : check.issues,
            issueCount: Array.isArray(check.issues)
              ? check.issues.filter((d) => d.issueKey !== variables.issueKey).length
              : check.issueCount,
          })).filter((check) => check.issueCount > 0),
        };
      });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['data-integrity', 'cached'] });
      }, 2000);
    },
    onError: (err: Error, variables) => {
      state.setSyncingIssues(prev => {
        const next = new Set(prev);
        next.delete(variables.issueKey);
        return next;
      });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to pull sync', 'error');
    },
  });

  const resyncMemberMutation = useMutation({
    mutationFn: (email: string) => 
      postWithCredentials<{ message: string }>('/api/data-tools/resync-member', { email }),
    onSuccess: (data) => {
      state.setResyncResult({ success: true, message: data.message });
      showToast(data.message, 'success');
      state.setResyncEmail('');
    },
    onError: (err: Error) => {
      state.setResyncResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to resync member' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to resync member', 'error');
    },
  });

  const cancelBookingMutation = useMutation({
    mutationFn: (bookingId: number) => 
      fetch(`/api/booking-requests/${bookingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'cancelled', cancelled_by: 'staff' })
      }).then(res => {
        if (!res.ok) throw new Error('Failed to cancel booking');
        return res.json();
      }),
    onSuccess: (_, bookingId) => {
      state.setCancellingBookings(prev => {
        const next = new Set(prev);
        next.delete(bookingId);
        return next;
      });
      showToast('Booking cancelled successfully', 'success');
      queryClient.setQueryData(['data-integrity', 'cached'], (old: CachedResultsResponse | undefined) => {
        if (!old?.hasCached) return old;
        return {
          ...old,
          results: old.results.map((check) => ({
            ...check,
            issues: Array.isArray(check.issues)
              ? check.issues.filter((d) => d.bookingId !== bookingId && d.id !== bookingId)
              : check.issues,
            issueCount: Array.isArray(check.issues)
              ? check.issues.filter((d) => d.bookingId !== bookingId && d.id !== bookingId).length
              : check.issueCount,
          })).filter((check) => check.issueCount > 0),
        };
      });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['data-integrity', 'cached'] });
      }, 2000);
    },
    onError: (err: Error, bookingId) => {
      state.setCancellingBookings(prev => {
        const next = new Set(prev);
        next.delete(bookingId);
        return next;
      });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to cancel booking', 'error');
    },
  });

  const reconcileGroupBillingMutation = useMutation({
    mutationFn: () => 
      postWithCredentials<{
        success: boolean;
        groupsChecked: number;
        membersDeactivated: number;
        membersReactivated: number;
        membersCreated: number;
        itemsRelinked: number;
        errors: string[];
      }>('/api/group-billing/reconcile', {}),
    onSuccess: (data) => {
      state.setReconcileResult(data);
      const summary = `Checked ${data.groupsChecked} groups. Deactivated: ${data.membersDeactivated}, Reactivated: ${data.membersReactivated}, Created: ${data.membersCreated}, Relinked: ${data.itemsRelinked}`;
      showToast(summary, data.success ? 'success' : 'info');
    },
    onError: (err: Error) => {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to reconcile group billing', 'error');
    },
  });

  const searchGuestFeesMutation = useMutation({
    mutationFn: (params: { startDate: string; endDate: string }) => 
      fetchWithCredentials<UnlinkedGuestFee[]>(`/api/data-tools/unlinked-guest-fees?startDate=${params.startDate}&endDate=${params.endDate}`),
    onSuccess: (data) => {
      state.setUnlinkedGuestFees(data);
    },
    onError: () => {
      showToast('Failed to search guest fees', 'error');
    },
  });

  const loadSessionsMutation = useMutation({
    mutationFn: (params: { date: string; memberEmail: string }) => 
      fetchWithCredentials<AvailableSession[]>(`/api/data-tools/available-sessions?date=${params.date}&memberEmail=${params.memberEmail || ''}`),
    onSuccess: (data) => {
      state.setAvailableSessions(data);
    },
    onError: () => {
      console.error('Failed to load sessions');
    },
  });

  const linkGuestFeeMutation = useMutation({
    mutationFn: (params: { guestFeeId: number; bookingId: number }) => 
      postWithCredentials<{ success: boolean }>('/api/data-tools/link-guest-fee', params),
    onSuccess: () => {
      showToast('Guest fee linked successfully', 'success');
      state.setUnlinkedGuestFees(prev => prev.filter(f => f.id !== state.selectedFeeId));
      state.setSelectedFeeId(null);
      state.setSelectedSessionId(null);
      state.setAvailableSessions([]);
    },
    onError: (err: Error) => {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to link guest fee', 'error');
    },
  });

  const searchAttendanceMutation = useMutation({
    mutationFn: (params: { date?: string; memberEmail?: string }) => {
      const searchParams = new URLSearchParams();
      if (params.date) searchParams.append('date', params.date);
      if (params.memberEmail) searchParams.append('memberEmail', params.memberEmail);
      return fetchWithCredentials<AttendanceBooking[]>(`/api/data-tools/bookings-search?${searchParams.toString()}`);
    },
    onSuccess: (data) => {
      state.setAttendanceBookings(data);
    },
    onError: () => {
      showToast('Failed to search bookings', 'error');
    },
  });

  const updateAttendanceMutation = useMutation({
    mutationFn: (params: { bookingId: number; attendanceStatus: string; notes: string }) => 
      postWithCredentials<{ success: boolean }>('/api/data-tools/update-attendance', params),
    onSuccess: (_, variables) => {
      showToast(`Attendance updated to ${variables.attendanceStatus}`, 'success');
      state.setAttendanceBookings(prev => prev.map(b => 
        b.id === variables.bookingId 
          ? { ...b, reconciliationStatus: variables.attendanceStatus, reconciliationNotes: variables.notes } 
          : b
      ));
      state.setAttendanceNote('');
      state.setUpdatingAttendanceId(null);
    },
    onError: (err: Error) => {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to update attendance', 'error');
      state.setUpdatingAttendanceId(null);
    },
  });

  const mindbodyReimportMutation = useMutation({
    mutationFn: (params: { startDate: string; endDate: string }) => 
      postWithCredentials<{ message: string }>('/api/data-tools/mindbody-reimport', params),
    onSuccess: (data) => {
      state.setMindbodyResult({ success: true, message: data.message });
      showToast(data.message, 'success');
    },
    onError: (err: Error) => {
      state.setMindbodyResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to queue reimport' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to queue reimport', 'error');
    },
  });

  const backfillStripeCacheMutation = useMutation({
    mutationFn: () => 
      postWithCredentials<{ stats?: StripeCacheStats }>('/api/financials/backfill-stripe-cache', {}),
    onSuccess: (data) => {
      const msg = `Backfilled ${data.stats?.paymentIntents || 0} payments, ${data.stats?.charges || 0} charges, ${data.stats?.invoices || 0} invoices`;
      state.setStripeCacheResult({ success: true, message: msg, stats: data.stats });
      showToast(msg, 'success');
    },
    onError: (err: Error) => {
      state.setStripeCacheResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to backfill cache' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to backfill cache', 'error');
    },
  });

  const syncMembersToHubspotMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message: string; members?: HubspotSyncMember[]; syncedCount?: number; totalSynced?: number }>('/api/data-tools/bulk-push-to-hubspot', { dryRun }),
    onSuccess: (data, dryRun) => {
      state.setHubspotSyncResult({ 
        success: true, 
        message: data.message,
        members: data.members,
        dryRun
      });
      showToast(dryRun ? 'Preview complete - no changes made' : data.message, dryRun ? 'info' : 'success');
      if (!dryRun && data.syncedCount && data.syncedCount > 0) {
        runIntegrityMutation.mutate();
      }
    },
    onError: (err: Error) => {
      state.setHubspotSyncResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to sync to HubSpot' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to sync to HubSpot', 'error');
    },
  });

  const cleanupMindbodyIdsMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message: string; toClean?: number }>('/api/data-tools/cleanup-mindbody-ids', { dryRun }),
    onSuccess: (data, dryRun) => {
      state.setMindbodyCleanupResult({ 
        success: true, 
        message: data.message,
        toClean: data.toClean,
        dryRun
      });
      showToast(dryRun ? 'Preview complete - no changes made' : data.message, dryRun ? 'info' : 'success');
    },
    onError: (err: Error) => {
      state.setMindbodyCleanupResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to cleanup Mind Body IDs' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to cleanup Mind Body IDs', 'error');
    },
  });

  const fixIssueMutation = useMutation({
    mutationFn: (params: { endpoint: string; body: Record<string, unknown> }) =>
      postWithCredentials<{ success: boolean; message: string }>(params.endpoint, params.body),
    onMutate: (params) => {
      const recordId = params.body.recordId || params.body.userId || params.body.primaryUserId;
      if (recordId) {
        const key = String(recordId);
        state.setFixingIssues(prev => new Set(prev).add(key));
      }
    },
    onSuccess: (data, params) => {
      const recordId = params.body.recordId || params.body.userId || params.body.primaryUserId;
      if (recordId) {
        const key = String(recordId);
        state.setFixingIssues(prev => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
      showToast(data.message || 'Issue fixed successfully', 'success');
      queryClient.setQueryData(['data-integrity', 'cached'], (old: CachedResultsResponse | undefined) => {
        if (!old?.hasCached || !recordId) return old;
        const rid = String(recordId);
        const matchesIssue = (issue: { recordId?: string | number; id?: string | number; context?: { userId?: number } }) => {
          const id = issue.recordId ?? issue.id;
          if (id != null && String(id) === rid) return true;
          if (issue.context?.userId && String(issue.context.userId) === rid) return true;
          return false;
        };
        return {
          ...old,
          results: old.results.map((check) => {
            if (!Array.isArray(check.issues)) return check;
            const filtered = check.issues.filter((issue) => !matchesIssue(issue));
            return { ...check, issues: filtered, issueCount: filtered.length };
          }).filter((check) => check.issueCount > 0),
        };
      });
      setTimeout(() => {
        runIntegrityMutation.mutate();
      }, 1500);
    },
    onError: (err: unknown, params) => {
      const recordId = params.body.recordId || params.body.userId || params.body.primaryUserId;
      if (recordId) {
        const key = String(recordId);
        state.setFixingIssues(prev => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to fix issue', 'error');
    }
  });

  useEffect(() => {
    const handleProgress = (event: CustomEvent) => {
      const { data, result, error } = event.detail || {};
      if (data) {
        state.setStripeCleanupProgress(data);
      }
      if (data?.phase === 'done') {
        state.setIsRunningStripeCleanup(false);
        if (result) {
          state.setStripeCleanupResult({
            success: result.success,
            message: result.message,
            dryRun: result.dryRun,
            totalCustomers: result.totalCustomers,
            emptyCount: result.emptyCount,
            skippedActiveCount: result.skippedActiveCount,
            customers: result.customers,
            deleted: result.deleted,
            deletedCount: result.deletedCount,
          });
          if (!result.dryRun) showToast(result.message, 'success');
        }
        if (error) {
          state.setStripeCleanupResult({ success: false, message: error });
          showToast(error, 'error');
        }
      }
    };

    window.addEventListener('stripe-cleanup-progress', handleProgress as EventListener);
    return () => {
      window.removeEventListener('stripe-cleanup-progress', handleProgress as EventListener);
    };
  }, [showToast]);

  useEffect(() => {
    if (!state.isRunningStripeCleanup) return;
    const interval = setInterval(async () => {
      try {
        const statusData = await fetchWithCredentials<BackgroundJobStatus>('/api/data-tools/cleanup-stripe-customers/status');
        if (statusData.hasJob && statusData.job) {
          if (statusData.job.progress != null) {
            state.setStripeCleanupProgress(statusData.job.progress as unknown as { phase: string; totalCustomers: number; checked: number; emptyFound: number; skippedActiveCount: number; deleted: number; errors: number });
          }
          if (statusData.job.status === 'completed') {
            state.setIsRunningStripeCleanup(false);
            state.setStripeCleanupProgress(null);
            const r = statusData.job.result as StripeCleanupJobResult | undefined;
            if (r) {
              state.setStripeCleanupResult({
                success: r.success,
                message: r.message,
                dryRun: r.dryRun,
                totalCustomers: r.totalCustomers,
                emptyCount: r.emptyCount,
                skippedActiveCount: r.skippedActiveCount,
                customers: r.customers,
                deleted: r.deleted,
                deletedCount: r.deletedCount,
              });
            }
          } else if (statusData.job.status === 'failed') {
            state.setIsRunningStripeCleanup(false);
            state.setStripeCleanupProgress(null);
            state.setStripeCleanupResult({ success: false, message: statusData.job.error || 'Job failed' });
          }
        } else if (!statusData.hasJob) {
          state.setIsRunningStripeCleanup(false);
          state.setStripeCleanupProgress(null);
          state.setStripeCleanupResult({ success: false, message: 'Job was lost (server may have restarted). Please try again.' });
        }
      } catch (pollErr) {
        console.warn('[DataIntegrity] Stripe cleanup poll failed:', pollErr);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [state.isRunningStripeCleanup]);

  useEffect(() => {
    const handleProgress = (event: CustomEvent) => {
      const { data, result, error } = event.detail || {};
      if (data) {
        state.setVisitorArchiveProgress(data);
      }
      if (data?.phase === 'done') {
        state.setIsRunningVisitorArchive(false);
        if (result) {
          state.setVisitorArchiveResult({
            success: result.success,
            message: result.message,
            dryRun: result.dryRun,
            totalScanned: result.totalScanned,
            eligibleCount: result.eligibleCount,
            keptCount: result.keptCount,
            archivedCount: result.archivedCount,
            sampleArchived: result.sampleArchived,
          });
          if (!result.dryRun) showToast(result.message, 'success');
        }
        if (error) {
          state.setVisitorArchiveResult({ success: false, message: error });
          showToast(error, 'error');
        }
      }
    };

    window.addEventListener('visitor-archive-progress', handleProgress as EventListener);
    return () => {
      window.removeEventListener('visitor-archive-progress', handleProgress as EventListener);
    };
  }, [showToast]);

  useEffect(() => {
    if (!state.isRunningVisitorArchive) return;
    const interval = setInterval(async () => {
      try {
        const statusData = await fetchWithCredentials<BackgroundJobStatus>('/api/data-tools/archive-stale-visitors/status');
        if (statusData.hasJob && statusData.job) {
          if (statusData.job.progress != null) {
            state.setVisitorArchiveProgress(statusData.job.progress as unknown as { phase: string; totalVisitors: number; checked: number; eligibleCount: number; keptCount: number; archived: number; errors: number });
          }
          if (statusData.job.status === 'completed') {
            state.setIsRunningVisitorArchive(false);
            state.setVisitorArchiveProgress(null);
            const r = statusData.job.result as VisitorArchiveJobResult | undefined;
            if (r) {
              state.setVisitorArchiveResult({
                success: r.success,
                message: r.message,
                dryRun: r.dryRun,
                totalScanned: r.totalScanned,
                eligibleCount: r.eligibleCount,
                keptCount: r.keptCount,
                archivedCount: r.archivedCount,
                sampleArchived: r.sampleArchived,
              });
            }
          } else if (statusData.job.status === 'failed') {
            state.setIsRunningVisitorArchive(false);
            state.setVisitorArchiveProgress(null);
            state.setVisitorArchiveResult({ success: false, message: statusData.job.error || 'Job failed' });
          }
        } else if (!statusData.hasJob) {
          state.setIsRunningVisitorArchive(false);
          state.setVisitorArchiveProgress(null);
          state.setVisitorArchiveResult({ success: false, message: 'Job was lost (server may have restarted). Please try again.' });
        }
      } catch (pollErr) {
        console.warn('[DataIntegrity] Visitor archive poll failed:', pollErr);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [state.isRunningVisitorArchive]);

  const syncSubscriptionStatusMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; totalChecked?: number; mismatchCount?: number; updated?: SubscriptionUpdate[]; updatedCount?: number }>('/api/data-tools/sync-subscription-status', { dryRun }),
    onSuccess: (data, dryRun) => {
      state.setSubscriptionStatusResult({
        success: true,
        message: data.message || `Checked ${data.totalChecked} members, found ${data.mismatchCount} mismatches`,
        totalChecked: data.totalChecked,
        mismatchCount: data.mismatchCount,
        updated: data.updated,
        dryRun
      });
      showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Subscription status sync complete'), dryRun ? 'info' : 'success');
      if (!dryRun && data.updatedCount && data.updatedCount > 0) {
        runIntegrityMutation.mutate();
      }
    },
    onError: (err: Error) => {
      state.setSubscriptionStatusResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to sync subscription status' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to sync subscription status', 'error');
    },
  });

  const clearOrphanedStripeIdsMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; totalChecked?: number; orphanedCount?: number; cleared?: OrphanedStripeRecord[]; clearedCount?: number }>('/api/data-tools/clear-orphaned-stripe-ids', { dryRun }),
    onSuccess: (data, dryRun) => {
      state.setOrphanedStripeResult({
        success: true,
        message: data.message || `Found ${data.orphanedCount} orphaned Stripe IDs`,
        totalChecked: data.totalChecked,
        orphanedCount: data.orphanedCount,
        cleared: data.cleared,
        dryRun
      });
      showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Orphaned Stripe IDs cleared'), dryRun ? 'info' : 'success');
      if (!dryRun && data.clearedCount && data.clearedCount > 0) {
        runIntegrityMutation.mutate();
      }
    },
    onError: (err: Error) => {
      state.setOrphanedStripeResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to clear orphaned Stripe IDs' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to clear orphaned Stripe IDs', 'error');
    },
  });

  const linkStripeHubspotMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; stripeOnlyMembers?: StripeHubspotMember[]; hubspotOnlyMembers?: StripeHubspotMember[]; linkedCount?: number }>('/api/data-tools/link-stripe-hubspot', { dryRun }),
    onSuccess: (data, dryRun) => {
      state.setStripeHubspotLinkResult({
        success: true,
        message: data.message || 'Stripe-HubSpot link complete',
        stripeOnlyMembers: data.stripeOnlyMembers,
        hubspotOnlyMembers: data.hubspotOnlyMembers,
        linkedCount: data.linkedCount,
        dryRun
      });
      showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Stripe-HubSpot link complete'), dryRun ? 'info' : 'success');
    },
    onError: (err: Error) => {
      state.setStripeHubspotLinkResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to link Stripe and HubSpot' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to link Stripe and HubSpot', 'error');
    },
  });

  const syncPaymentStatusMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; totalChecked?: number; updatedCount?: number; updates?: PaymentUpdate[] }>('/api/data-tools/sync-payment-status', { dryRun }),
    onSuccess: (data, dryRun) => {
      state.setPaymentStatusResult({
        success: true,
        message: data.message || `Checked ${data.totalChecked} members, updated ${data.updatedCount}`,
        totalChecked: data.totalChecked,
        updatedCount: data.updatedCount,
        updates: data.updates,
        dryRun
      });
      showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Payment status sync complete'), dryRun ? 'info' : 'success');
    },
    onError: (err: Error) => {
      state.setPaymentStatusResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to sync payment status' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to sync payment status', 'error');
    },
  });

  const syncVisitCountsMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; mismatchCount?: number; updatedCount?: number; sampleMismatches?: VisitMismatch[] }>('/api/data-tools/sync-visit-counts', { dryRun }),
    onSuccess: (data, dryRun) => {
      state.setVisitCountResult({
        success: true,
        message: data.message || `Found ${data.mismatchCount} mismatches, updated ${data.updatedCount}`,
        mismatchCount: data.mismatchCount,
        updatedCount: data.updatedCount,
        sampleMismatches: data.sampleMismatches,
        dryRun
      });
      showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Visit count sync complete'), dryRun ? 'info' : 'success');
    },
    onError: (err: Error) => {
      state.setVisitCountResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to sync visit counts' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to sync visit counts', 'error');
    },
  });

  const previewGhostBookingsMutation = useMutation({
    mutationFn: () => fetchWithCredentials<{ message?: string; totalCount?: number }>('/api/admin/backfill-sessions/preview'),
    onSuccess: (data) => {
      state.setGhostBookingResult({
        success: true,
        message: data.message || `Found ${data.totalCount} bookings without sessions`,
        ghostBookings: data.totalCount,
        fixed: 0,
        dryRun: true
      });
      showToast('Preview complete - no changes made', 'info');
    },
    onError: (err: Error) => {
      state.setGhostBookingResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to preview' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to preview', 'error');
    },
  });

  const fixGhostBookingsMutation = useMutation({
    mutationFn: () => postWithCredentials<{ message?: string; sessionsCreated?: number; sessionsLinked?: number; totalProcessed?: number; errorsCount?: number; errors?: Array<{ bookingId: number; error: string }> }>('/api/admin/backfill-sessions', {}),
    onSuccess: (data) => {
      const hasErrors = data.errorsCount && data.errorsCount > 0;
      state.setGhostBookingResult({
        success: true,
        message: data.message || `Created ${data.sessionsCreated} sessions`,
        ghostBookings: data.totalProcessed,
        fixed: (data.sessionsCreated || 0) + (data.sessionsLinked || 0),
        dryRun: false,
        errors: data.errors
      });
      showToast(data.message || `Created ${data.sessionsCreated} sessions`, hasErrors ? 'warning' : 'success');
      runIntegrityMutation.mutate();
    },
    onError: (err: Error) => {
      state.setGhostBookingResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to create sessions' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to create sessions', 'error');
    },
  });

  const fixOrphanedParticipantsMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      postWithCredentials<{ message?: string; relinked?: number; converted?: number; total?: number; dryRun?: boolean; relinkedDetails?: OrphanedParticipantDetail[]; convertedDetails?: OrphanedParticipantDetail[] }>('/api/data-integrity/fix/fix-orphaned-participants', { dryRun }),
    onSuccess: (data, dryRun) => {
      state.setOrphanedParticipantResult({
        success: true,
        message: data.message || `${dryRun ? 'Found' : 'Fixed'} ${data.total || 0} orphaned participants`,
        relinked: data.relinked,
        converted: data.converted,
        total: data.total,
        dryRun,
        relinkedDetails: data.relinkedDetails,
        convertedDetails: data.convertedDetails
      });
      showToast(data.message || `${dryRun ? 'Preview complete' : 'Fix applied'}`, dryRun ? 'info' : 'success');
      if (!dryRun && (data.total || 0) > 0) {
        runIntegrityMutation.mutate();
      }
    },
    onError: (err: Error) => {
      state.setOrphanedParticipantResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to fix', 'error');
    },
  });

  const approveAllReviewItemsMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      postWithCredentials<{ message?: string; wellnessCount?: number; eventCount?: number; total?: number; dryRun?: boolean }>('/api/data-integrity/fix/approve-all-review-items', { dryRun }),
    onSuccess: (data, dryRun) => {
      state.setReviewItemsResult({
        success: true,
        message: data.message || `${dryRun ? 'Found' : 'Approved'} ${data.total || 0} items`,
        wellnessCount: data.wellnessCount,
        eventCount: data.eventCount,
        total: data.total,
        dryRun
      });
      showToast(data.message || `${dryRun ? 'Preview complete' : 'All items approved'}`, dryRun ? 'info' : 'success');
      if (!dryRun && (data.total || 0) > 0) {
        runIntegrityMutation.mutate();
      }
    },
    onError: (err: Error) => {
      state.setReviewItemsResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed', 'error');
    },
  });

  const detectDuplicatesMutation = useMutation({
    mutationFn: () => 
      postWithCredentials<{ message?: string; appDuplicates?: DuplicateRecord[]; hubspotDuplicates?: DuplicateRecord[] }>('/api/data-tools/detect-duplicates', {}),
    onSuccess: (data) => {
      const appCount = data.appDuplicates?.length || 0;
      const hubspotCount = data.hubspotDuplicates?.length || 0;
      state.setDuplicateDetectionResult({
        success: true,
        message: data.message || `Found ${appCount} app duplicates, ${hubspotCount} HubSpot duplicates`,
        appDuplicates: data.appDuplicates,
        hubspotDuplicates: data.hubspotDuplicates
      });
      state.setExpandedDuplicates({ app: false, hubspot: false });
      showToast(data.message || 'Duplicate detection complete', 'success');
    },
    onError: (err: Error) => {
      state.setDuplicateDetectionResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to detect duplicates' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to detect duplicates', 'error');
    },
  });

  const scanPlaceholdersMutation = useMutation({
    mutationFn: () => 
      fetchWithCredentials<{ success: boolean; stripeCustomers?: PlaceholderAccount[]; hubspotContacts?: PlaceholderAccount[]; localDatabaseUsers?: PlaceholderAccount[]; totals?: { stripe: number; hubspot: number; localDatabase: number; total: number } }>('/api/data-integrity/placeholder-accounts'),
    onSuccess: (data) => {
      if (data.success) {
        state.setPlaceholderAccounts({
          stripeCustomers: (data.stripeCustomers || []) as Array<{ id: string; email: string; name: string; created: number }>,
          hubspotContacts: (data.hubspotContacts || []) as Array<{ id: string; email: string; name: string }>,
          localDatabaseUsers: (data.localDatabaseUsers || []) as Array<{ id: string; email: string; name: string; status: string; createdAt: string }>,
          totals: {
            stripe: data.totals?.stripe || 0,
            hubspot: data.totals?.hubspot || 0,
            localDatabase: data.totals?.localDatabase || 0,
            total: data.totals?.total || 0
          }
        });
        showToast(`Found ${data.totals?.total || 0} placeholder accounts`, data.totals?.total && data.totals.total > 0 ? 'info' : 'success');
      } else {
        showToast('Failed to scan for placeholders', 'error');
      }
      state.setPlaceholderDeleteResult(null);
    },
    onError: () => {
      showToast('Failed to scan for placeholders', 'error');
    },
  });

  const deletePlaceholdersMutation = useMutation({
    mutationFn: (params: { stripeCustomerIds: string[]; hubspotContactIds: string[]; localDatabaseUserIds: string[] }) => 
      postWithCredentials<{ success: boolean; stripeDeleted?: number; stripeFailed?: number; hubspotDeleted?: number; hubspotFailed?: number; localDatabaseDeleted?: number; localDatabaseFailed?: number }>('/api/data-integrity/placeholder-accounts/delete', params),
    onSuccess: (data) => {
      if (data.success) {
        state.setPlaceholderDeleteResult({
          stripeDeleted: data.stripeDeleted || 0,
          stripeFailed: data.stripeFailed || 0,
          hubspotDeleted: data.hubspotDeleted || 0,
          hubspotFailed: data.hubspotFailed || 0,
          localDatabaseDeleted: data.localDatabaseDeleted || 0,
          localDatabaseFailed: data.localDatabaseFailed || 0
        });
        const totalDeleted = (data.stripeDeleted || 0) + (data.hubspotDeleted || 0) + (data.localDatabaseDeleted || 0);
        const totalFailed = (data.stripeFailed || 0) + (data.hubspotFailed || 0) + (data.localDatabaseFailed || 0);
        showToast(`Deleted ${totalDeleted} placeholder accounts${totalFailed > 0 ? `, ${totalFailed} failed` : ''}`, totalFailed > 0 ? 'warning' : 'success');
        state.setPlaceholderAccounts(null);
      } else {
        showToast('Failed to delete placeholder accounts', 'error');
      }
      state.setShowDeleteConfirm(false);
    },
    onError: () => {
      showToast('Failed to delete placeholder accounts', 'error');
      state.setShowDeleteConfirm(false);
    },
  });

  const openIgnoreModal = (issue: IntegrityIssue, checkName: string) => {
    state.setIgnoreModal({ isOpen: true, issue, checkName });
    state.setIgnoreDuration('24h');
    state.setIgnoreReason('');
  };

  const handleIgnoreIssue = () => {
    if (!state.ignoreModal.issue || !state.ignoreReason.trim()) return;
    const issueKey = `${state.ignoreModal.issue.table}_${state.ignoreModal.issue.recordId}`;
    ignoreIssueMutation.mutate({ issueKey, duration: state.ignoreDuration, reason: state.ignoreReason.trim() });
  };

  const handleUnignoreIssue = (issueKey: string) => {
    unignoreIssueMutation.mutate(issueKey);
  };

  const openBulkIgnoreModal = (checkName: string, issues: IntegrityIssue[]) => {
    const nonIgnoredIssues = issues.filter(i => !i.ignored);
    state.setBulkIgnoreModal({ isOpen: true, checkName, issues: nonIgnoredIssues });
    state.setIgnoreDuration('30d');
    state.setIgnoreReason('');
  };

  const handleBulkIgnore = () => {
    if (state.bulkIgnoreModal.issues.length === 0 || !state.ignoreReason.trim()) return;
    const issueKeys = state.bulkIgnoreModal.issues.map(issue => `${issue.table}_${issue.recordId}`);
    bulkIgnoreMutation.mutate({ issueKeys, duration: state.ignoreDuration, reason: state.ignoreReason.trim() });
  };

  const handleSyncPush = (issue: IntegrityIssue) => {
    if (!issue.context?.syncType) return;
    const issueKey = `${issue.table}_${issue.recordId}`;
    state.setSyncingIssues(prev => new Set(prev).add(issueKey));
    syncPushMutation.mutate({
      issueKey,
      target: issue.context.syncType,
      userId: issue.context.userId,
      hubspotContactId: issue.context.hubspotContactId
    });
  };

  const handleSyncPull = (issue: IntegrityIssue) => {
    if (!issue.context?.syncType) return;
    const issueKey = `${issue.table}_${issue.recordId}`;
    state.setSyncingIssues(prev => new Set(prev).add(issueKey));
    syncPullMutation.mutate({
      issueKey,
      target: issue.context.syncType,
      userId: issue.context.userId,
      hubspotContactId: issue.context.hubspotContactId
    });
  };

  const handleCancelBooking = (bookingId: number) => {
    if (state.cancellingBookings.has(bookingId)) return;
    state.setCancellingBookings(prev => new Set(prev).add(bookingId));
    cancelBookingMutation.mutate(bookingId);
  };

  const handleViewProfile = useCallback(async (email: string) => {
    if (!email) return;
    state.setLoadingMemberEmail(email);
    try {
      const response = await fetchWithCredentials<MemberDetails>(`/api/members/${encodeURIComponent(email)}/details`);
      if (!response || !response.id) {
        throw new Error('Invalid response from server');
      }
      const profile: MemberProfile = {
        id: response.id as string,
        name: [response.firstName, response.lastName].filter(Boolean).join(' ') || response.email,
        tier: response.tier || '',
        rawTier: response.tier,
        membershipStatus: response.membershipStatus || null,
        tags: response.tags || [],
        status: response.membershipStatus || 'Inactive',
        email: response.email,
        phone: response.phone || '',
        role: response.role,
        mindbodyClientId: response.mindbodyClientId as string,
        stripeCustomerId: response.stripeCustomerId as string,
        hubspotId: response.hubspotId as string,
        dateOfBirth: response.dateOfBirth,
        billingProvider: response.billingProvider,
        streetAddress: response.streetAddress,
        city: response.city,
        state: response.state,
        zipCode: response.zipCode,
        companyName: response.companyName as string,
        lifetimeVisits: response.lifetimeVisits as number,
        lastBookingDate: response.lastBookingDate as string,
      };
      state.setSelectedMember(profile);
      state.setIsProfileDrawerOpen(true);
    } catch (error: unknown) {
      showToast((error instanceof Error ? error.message : String(error)) || 'Failed to load member profile', 'error');
    } finally {
      state.setLoadingMemberEmail(null);
    }
  }, [showToast]);

  const runIntegrityChecks = () => {
    runIntegrityMutation.mutate();
  };

  const handleCheckHealth = async () => {
    state.setIsCheckingHealth(true);
    try {
      const response = await fetchWithCredentials<{ success: boolean; health: SystemHealth }>('/api/data-integrity/health');
      if (response.success) {
        state.setSystemHealth(response.health);
        showToast('System health check completed', 'success');
      }
    } catch (error: unknown) {
      showToast((error instanceof Error ? error.message : String(error)) || 'Failed to check system health', 'error');
    } finally {
      state.setIsCheckingHealth(false);
    }
  };

  const handleResyncMember = () => {
    if (!state.resyncEmail.trim()) return;
    state.setResyncResult(null);
    resyncMemberMutation.mutate(state.resyncEmail.trim());
  };

  const handleReconcileGroupBilling = () => {
    state.setReconcileResult(null);
    reconcileGroupBillingMutation.mutate();
  };

  const handleSearchUnlinkedGuestFees = () => {
    if (!state.guestFeeStartDate || !state.guestFeeEndDate) return;
    searchGuestFeesMutation.mutate({ startDate: state.guestFeeStartDate, endDate: state.guestFeeEndDate });
  };

  const handleLoadSessionsForFee = (fee: UnlinkedGuestFee) => {
    state.setSelectedFeeId(fee.id);
    state.setSelectedSessionId(null);
    loadSessionsMutation.mutate({ date: fee.saleDate || '', memberEmail: fee.memberEmail || '' });
  };

  const handleLinkGuestFee = () => {
    if (!state.selectedFeeId || !state.selectedSessionId) return;
    linkGuestFeeMutation.mutate({ guestFeeId: state.selectedFeeId, bookingId: state.selectedSessionId });
  };

  const handleSearchAttendance = () => {
    if (!state.attendanceSearchDate && !state.attendanceSearchEmail) {
      showToast('Please enter a date or member email', 'error');
      return;
    }
    searchAttendanceMutation.mutate({ 
      date: state.attendanceSearchDate || undefined, 
      memberEmail: state.attendanceSearchEmail || undefined 
    });
  };

  const handleUpdateAttendance = (bookingId: number, status: string) => {
    state.setUpdatingAttendanceId(bookingId);
    updateAttendanceMutation.mutate({ bookingId, attendanceStatus: status, notes: state.attendanceNote });
  };

  const handleMindbodyReimport = () => {
    if (!state.mindbodyStartDate || !state.mindbodyEndDate) return;
    state.setMindbodyResult(null);
    mindbodyReimportMutation.mutate({ startDate: state.mindbodyStartDate, endDate: state.mindbodyEndDate });
  };

  const handleBackfillStripeCache = () => {
    state.setStripeCacheResult(null);
    backfillStripeCacheMutation.mutate();
  };

  const handleSyncMembersToHubspot = (dryRun: boolean = true) => {
    state.setHubspotSyncResult(null);
    syncMembersToHubspotMutation.mutate(dryRun);
  };

  const handleCleanupMindbodyIds = (dryRun: boolean = true) => {
    state.setMindbodyCleanupResult(null);
    cleanupMindbodyIdsMutation.mutate(dryRun);
  };

  const handleSyncSubscriptionStatus = (dryRun: boolean = true) => {
    state.setSubscriptionStatusResult(null);
    syncSubscriptionStatusMutation.mutate(dryRun);
  };

  const handleArchiveStaleVisitors = async (dryRun: boolean = true) => {
    state.setVisitorArchiveResult(null);
    state.setVisitorArchiveProgress(null);
    try {
      await postWithCredentials('/api/data-tools/archive-stale-visitors', { dryRun });
      state.setIsRunningVisitorArchive(true);
    } catch (err: unknown) {
      state.setVisitorArchiveResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to start archive job' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to start archive job', 'error');
    }
  };

  const handleCleanupStripeCustomers = async (dryRun: boolean = true) => {
    state.setStripeCleanupResult(null);
    state.setStripeCleanupProgress(null);
    try {
      await postWithCredentials('/api/data-tools/cleanup-stripe-customers', { dryRun });
      state.setIsRunningStripeCleanup(true);
    } catch (err: unknown) {
      state.setStripeCleanupResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to start cleanup job' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to start cleanup job', 'error');
    }
  };

  const handleClearOrphanedStripeIds = (dryRun: boolean = true) => {
    state.setOrphanedStripeResult(null);
    clearOrphanedStripeIdsMutation.mutate(dryRun);
  };

  const handleLinkStripeHubspot = (dryRun: boolean = true) => {
    state.setStripeHubspotLinkResult(null);
    linkStripeHubspotMutation.mutate(dryRun);
  };

  const handleSyncPaymentStatus = (dryRun: boolean = true) => {
    state.setPaymentStatusResult(null);
    syncPaymentStatusMutation.mutate(dryRun);
  };

  const handleSyncVisitCounts = (dryRun: boolean = true) => {
    state.setVisitCountResult(null);
    syncVisitCountsMutation.mutate(dryRun);
  };

  const handleFixGhostBookings = (dryRun: boolean = true) => {
    state.setGhostBookingResult(null);
    if (dryRun) {
      previewGhostBookingsMutation.mutate();
    } else {
      fixGhostBookingsMutation.mutate();
    }
  };

  const handleFixOrphanedParticipants = (dryRun: boolean = true) => {
    state.setOrphanedParticipantResult(null);
    fixOrphanedParticipantsMutation.mutate(dryRun);
  };

  const handleApproveAllReviewItems = (dryRun: boolean = true) => {
    state.setReviewItemsResult(null);
    approveAllReviewItemsMutation.mutate(dryRun);
  };

  const handleDetectDuplicates = () => {
    state.setDuplicateDetectionResult(null);
    state.setExpandedDuplicates({ app: false, hubspot: false });
    detectDuplicatesMutation.mutate();
  };

  const handleScanPlaceholders = () => {
    state.setPlaceholderAccounts(null);
    state.setPlaceholderDeleteResult(null);
    scanPlaceholdersMutation.mutate();
  };

  const handleDeletePlaceholders = () => {
    if (!state.placeholderAccounts) return;
    state.setShowDeleteConfirm(false);
    deletePlaceholdersMutation.mutate({
      stripeCustomerIds: state.placeholderAccounts.stripeCustomers.map(c => c.id),
      hubspotContactIds: state.placeholderAccounts.hubspotContacts.map(c => c.id),
      localDatabaseUserIds: state.placeholderAccounts.localDatabaseUsers.map(u => u.id)
    });
  };

  const getIssueTrackingForIssue = (issue: IntegrityIssue): ActiveIssue | undefined => {
    if (!historyData) return undefined;
    const issueKey = `${issue.table}_${issue.recordId}`;
    return historyData.activeIssues.find(ai => ai.issueKey === issueKey);
  };

  const isRunning = runIntegrityMutation.isPending;
  const isIgnoring = ignoreIssueMutation.isPending;
  const isBulkIgnoring = bulkIgnoreMutation.isPending;
  const isResyncing = resyncMemberMutation.isPending;
  const isReconciling = reconcileGroupBillingMutation.isPending;
  const isLoadingGuestFees = searchGuestFeesMutation.isPending;
  const isLinkingFee = linkGuestFeeMutation.isPending;
  const isSearchingAttendance = searchAttendanceMutation.isPending;
  const isRunningMindbodyImport = mindbodyReimportMutation.isPending;
  const isUploadingCSV = false;
  const isBackfillingStripeCache = backfillStripeCacheMutation.isPending;
  const isSyncingToHubspot = syncMembersToHubspotMutation.isPending;
  const isCleaningMindbodyIds = cleanupMindbodyIdsMutation.isPending;
  const isRunningSubscriptionSync = syncSubscriptionStatusMutation.isPending;
  const isRunningOrphanedStripeCleanup = clearOrphanedStripeIdsMutation.isPending;
  const isRunningStripeHubspotLink = linkStripeHubspotMutation.isPending;
  const isRunningPaymentStatusSync = syncPaymentStatusMutation.isPending;
  const isRunningVisitCountSync = syncVisitCountsMutation.isPending;
  const isRunningGhostBookingFix = previewGhostBookingsMutation.isPending || fixGhostBookingsMutation.isPending;
  const isRunningOrphanedParticipantFix = fixOrphanedParticipantsMutation.isPending;
  const isRunningReviewItemsApproval = approveAllReviewItemsMutation.isPending;
  const isRunningDuplicateDetection = detectDuplicatesMutation.isPending;
  const isLoadingPlaceholders = scanPlaceholdersMutation.isPending;
  const isDeletingPlaceholders = deletePlaceholdersMutation.isPending;
  const isRunningStripeCustomerCleanup = state.isRunningStripeCleanup;

  const errorCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'error').length, 0);
  const warningCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'warning').length, 0);
  const infoCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'info').length, 0);
  const hasIssues = results.some(r => r.issues.length > 0);

  return {
    results,
    meta,
    isCached,
    isLoadingCached,
    calendarStatus,
    isLoadingCalendars,
    historyData,
    isLoadingHistory,
    auditLog,
    isLoadingAuditLog,
    ignoredIssues,
    isLoadingIgnored,

    runIntegrityChecks,
    runIntegrityMutation,
    cancelBookingMutation,
    fixIssueMutation,

    handleCheckHealth,
    handleResyncMember,
    handleReconcileGroupBilling,
    handleSearchUnlinkedGuestFees,
    handleLoadSessionsForFee,
    handleLinkGuestFee,
    handleSearchAttendance,
    handleUpdateAttendance,
    handleMindbodyReimport,
    handleBackfillStripeCache,
    handleSyncMembersToHubspot,
    handleCleanupMindbodyIds,
    handleSyncSubscriptionStatus,
    handleArchiveStaleVisitors,
    handleCleanupStripeCustomers,
    handleClearOrphanedStripeIds,
    handleLinkStripeHubspot,
    handleSyncPaymentStatus,
    handleSyncVisitCounts,
    handleFixGhostBookings,
    handleFixOrphanedParticipants,
    handleApproveAllReviewItems,
    handleDetectDuplicates,
    handleScanPlaceholders,
    handleDeletePlaceholders,

    openIgnoreModal,
    closeIgnoreModal,
    handleIgnoreIssue,
    handleUnignoreIssue,
    openBulkIgnoreModal,
    closeBulkIgnoreModal,
    handleBulkIgnore,
    handleSyncPush,
    handleSyncPull,
    handleCancelBooking,
    handleViewProfile,
    getIssueTrackingForIssue,

    isRunning,
    isIgnoring,
    isBulkIgnoring,
    isResyncing,
    isReconciling,
    isLoadingGuestFees,
    isLinkingFee,
    isSearchingAttendance,
    isRunningMindbodyImport,
    isUploadingCSV,
    isBackfillingStripeCache,
    isSyncingToHubspot,
    isCleaningMindbodyIds,
    isRunningSubscriptionSync,
    isRunningOrphanedStripeCleanup,
    isRunningStripeHubspotLink,
    isRunningPaymentStatusSync,
    isRunningVisitCountSync,
    isRunningGhostBookingFix,
    isRunningOrphanedParticipantFix,
    isRunningReviewItemsApproval,
    isRunningDuplicateDetection,
    isLoadingPlaceholders,
    isDeletingPlaceholders,
    isRunningStripeCustomerCleanup,

    errorCount,
    warningCount,
    infoCount,
    hasIssues,
  };
}
