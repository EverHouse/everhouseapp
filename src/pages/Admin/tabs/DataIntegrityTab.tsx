import React, { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../../components/Toast';
import EmptyState from '../../../components/EmptyState';
import { getCheckMetadata, sortBySeverity, CheckSeverity } from '../../../data/integrityCheckMetadata';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials } from '../../../hooks/queries/useFetch';
import MemberProfileDrawer from '../../../components/MemberProfileDrawer';
import { TrackmanLinkModal } from '../../../components/staff-command-center/modals/TrackmanLinkModal';
import type { MemberProfile } from '../../../types/data';

interface SyncComparisonData {
  field: string;
  appValue: string | number | null;
  externalValue: string | number | null;
}

interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs?: number;
  message?: string;
  lastChecked: string;
}

interface SystemHealth {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  services: {
    database: ServiceHealth;
    stripe: ServiceHealth;
    hubspot: ServiceHealth;
    resend: ServiceHealth;
    googleCalendar: ServiceHealth;
  };
  timestamp: string;
}

interface IssueContext {
  memberName?: string;
  memberEmail?: string;
  memberTier?: string;
  bookingDate?: string;
  resourceName?: string;
  startTime?: string;
  endTime?: string;
  className?: string;
  classDate?: string;
  instructor?: string;
  eventTitle?: string;
  eventDate?: string;
  tourDate?: string;
  guestName?: string;
  trackmanBookingId?: string;
  importedName?: string;
  notes?: string;
  originalEmail?: string;
  syncType?: 'hubspot' | 'calendar';
  syncComparison?: SyncComparisonData[];
  hubspotContactId?: string;
  userId?: number;
}

interface IgnoreInfo {
  ignoredBy: string;
  ignoredAt: string;
  expiresAt: string;
  reason: string;
}

interface IntegrityIssue {
  category: 'orphan_record' | 'missing_relationship' | 'sync_mismatch' | 'data_quality';
  severity: 'error' | 'warning' | 'info';
  table: string;
  recordId: number | string;
  description: string;
  suggestion?: string;
  context?: IssueContext;
  ignored?: boolean;
  ignoreInfo?: IgnoreInfo;
}

interface IgnoredIssueEntry {
  id: number;
  issueKey: string;
  ignoredBy: string;
  ignoredAt: string;
  expiresAt: string;
  reason: string;
  isActive: boolean;
  isExpired: boolean;
}

interface IntegrityCheckResult {
  checkName: string;
  status: 'pass' | 'warning' | 'fail';
  issueCount: number;
  issues: IntegrityIssue[];
  lastRun: Date;
}

interface IntegrityMeta {
  totalChecks: number;
  passed: number;
  warnings: number;
  failed: number;
  totalIssues: number;
  lastRun: Date;
}

interface CalendarStatus {
  name: string;
  status: 'connected' | 'not_found';
}

interface CalendarStatusResponse {
  timestamp: string;
  configured_calendars: CalendarStatus[];
}

interface HistoryEntry {
  id: number;
  runAt: string;
  totalIssues: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  triggeredBy: string;
}

interface ActiveIssue {
  issueKey: string;
  checkName: string;
  severity: string;
  description: string;
  firstDetectedAt: string;
  lastSeenAt: string;
  daysUnresolved: number;
}

interface HistoryData {
  history: HistoryEntry[];
  trend: 'increasing' | 'decreasing' | 'stable';
  activeIssues: ActiveIssue[];
}

interface AuditLogEntry {
  id: number;
  issueKey: string;
  action: string;
  actionBy: string;
  actionAt: string;
  resolutionMethod: string | null;
  notes: string | null;
}

interface IgnoreModalState {
  isOpen: boolean;
  issue: IntegrityIssue | null;
  checkName: string;
}

interface BulkIgnoreModalState {
  isOpen: boolean;
  checkName: string;
  issues: IntegrityIssue[];
}

interface CachedResultsResponse {
  hasCached: boolean;
  results: IntegrityCheckResult[];
  meta: IntegrityMeta;
}

interface IntegrityRunResponse {
  results: IntegrityCheckResult[];
  meta: IntegrityMeta;
}

const DataIntegrityTab: React.FC = () => {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());
  const [selectedCheck, setSelectedCheck] = useState<string | null>(null);
  
  const [showCalendars, setShowCalendars] = useState(true);
  const [showHistory, setShowHistory] = useState(true);
  const [showActivityLog, setShowActivityLog] = useState(true);

  const [syncingIssues, setSyncingIssues] = useState<Set<string>>(new Set());
  const [cancellingBookings, setCancellingBookings] = useState<Set<number>>(new Set());

  const [ignoreModal, setIgnoreModal] = useState<IgnoreModalState>({ isOpen: false, issue: null, checkName: '' });
  const [bulkIgnoreModal, setBulkIgnoreModal] = useState<BulkIgnoreModalState>({ isOpen: false, checkName: '', issues: [] });
  const [ignoreDuration, setIgnoreDuration] = useState<'24h' | '1w' | '30d'>('24h');
  const [ignoreReason, setIgnoreReason] = useState<string>('');
  const [showIgnoredIssues, setShowIgnoredIssues] = useState(false);

  const [showDataTools, setShowDataTools] = useState(true);
  const [resyncEmail, setResyncEmail] = useState('');
  const [resyncResult, setResyncResult] = useState<{ success: boolean; message: string } | null>(null);

  const [guestFeeStartDate, setGuestFeeStartDate] = useState('');
  const [guestFeeEndDate, setGuestFeeEndDate] = useState('');
  const [unlinkedGuestFees, setUnlinkedGuestFees] = useState<any[]>([]);
  const [availableSessions, setAvailableSessions] = useState<any[]>([]);
  const [selectedFeeId, setSelectedFeeId] = useState<number | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);

  const [attendanceSearchDate, setAttendanceSearchDate] = useState('');
  const [attendanceSearchEmail, setAttendanceSearchEmail] = useState('');
  const [attendanceBookings, setAttendanceBookings] = useState<any[]>([]);
  const [updatingAttendanceId, setUpdatingAttendanceId] = useState<number | null>(null);
  const [attendanceNote, setAttendanceNote] = useState('');

  const [mindbodyStartDate, setMindbodyStartDate] = useState('');
  const [mindbodyEndDate, setMindbodyEndDate] = useState('');
  const [mindbodyResult, setMindbodyResult] = useState<{ success: boolean; message: string } | null>(null);

  const [hubspotSyncResult, setHubspotSyncResult] = useState<{ success: boolean; message: string; members?: any[]; dryRun?: boolean } | null>(null);
  const [mindbodyCleanupResult, setMindbodyCleanupResult] = useState<{ success: boolean; message: string; toClean?: number; dryRun?: boolean } | null>(null);

  const [firstVisitFile, setFirstVisitFile] = useState<File | null>(null);
  const [salesFile, setSalesFile] = useState<File | null>(null);
  const [csvUploadResult, setCsvUploadResult] = useState<{
    success: boolean;
    message: string;
    firstVisit?: { total: number; linked: number; alreadyLinked: number; skipped: number };
    sales?: { total: number; imported: number; skipped: number; matchedByEmail: number; matchedByPhone: number; matchedByName: number; unmatched: number };
  } | null>(null);

  const [reconcileResult, setReconcileResult] = useState<{
    success: boolean;
    groupsChecked: number;
    membersDeactivated: number;
    membersReactivated: number;
    membersCreated: number;
    itemsRelinked: number;
    errors: string[];
  } | null>(null);

  const [stripeCacheResult, setStripeCacheResult] = useState<{ success: boolean; message: string; stats?: any } | null>(null);

  const [showSyncTools, setShowSyncTools] = useState(true);
  const [subscriptionStatusResult, setSubscriptionStatusResult] = useState<{ success: boolean; message: string; totalChecked?: number; mismatchCount?: number; updated?: any[]; dryRun?: boolean } | null>(null);
  const [orphanedStripeResult, setOrphanedStripeResult] = useState<{ success: boolean; message: string; totalChecked?: number; orphanedCount?: number; cleared?: any[]; dryRun?: boolean } | null>(null);
  const [stripeHubspotLinkResult, setStripeHubspotLinkResult] = useState<{ success: boolean; message: string; stripeOnlyMembers?: any[]; hubspotOnlyMembers?: any[]; linkedCount?: number; dryRun?: boolean } | null>(null);
  const [paymentStatusResult, setPaymentStatusResult] = useState<{ success: boolean; message: string; totalChecked?: number; updatedCount?: number; updates?: any[]; dryRun?: boolean } | null>(null);
  const [visitCountResult, setVisitCountResult] = useState<{ success: boolean; message: string; mismatchCount?: number; updatedCount?: number; sampleMismatches?: any[]; dryRun?: boolean } | null>(null);
  const [ghostBookingResult, setGhostBookingResult] = useState<{ success: boolean; message: string; ghostBookings?: number; fixed?: number; dryRun?: boolean } | null>(null);
  const [duplicateDetectionResult, setDuplicateDetectionResult] = useState<{ success: boolean; message: string; appDuplicates?: any[]; hubspotDuplicates?: any[] } | null>(null);
  const [expandedDuplicates, setExpandedDuplicates] = useState<{ app: boolean; hubspot: boolean }>({ app: false, hubspot: false });
  const [dealStageRemediationResult, setDealStageRemediationResult] = useState<{ success: boolean; message: string; total?: number; fixed?: number; dryRun?: boolean } | null>(null);

  const [selectedMember, setSelectedMember] = useState<MemberProfile | null>(null);
  const [isProfileDrawerOpen, setIsProfileDrawerOpen] = useState(false);
  const [loadingMemberEmail, setLoadingMemberEmail] = useState<string | null>(null);
  
  // Trackman Link Modal state for viewing unmatched bookings
  const [trackmanLinkModal, setTrackmanLinkModal] = useState<{
    isOpen: boolean;
    bookingId: number | null;
    bayName?: string;
    bookingDate?: string;
    timeSlot?: string;
    memberName?: string;
    memberEmail?: string;
    trackmanBookingId?: string;
    importedName?: string;
    notes?: string;
    originalEmail?: string;
  }>({ isOpen: false, bookingId: null });

  const [showPlaceholderCleanup, setShowPlaceholderCleanup] = useState(true);
  const [placeholderAccounts, setPlaceholderAccounts] = useState<{
    stripeCustomers: Array<{ id: string; email: string; name: string | null; created: number }>;
    hubspotContacts: Array<{ id: string; email: string; name: string }>;
    localDatabaseUsers: Array<{ id: string; email: string; name: string; status: string; createdAt: string }>;
    totals: { stripe: number; hubspot: number; localDatabase: number; total: number };
  } | null>(null);
  const [placeholderDeleteResult, setPlaceholderDeleteResult] = useState<{
    stripeDeleted: number;
    stripeFailed: number;
    hubspotDeleted: number;
    hubspotFailed: number;
    localDatabaseDeleted: number;
    localDatabaseFailed: number;
  } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);

  // ==================== REACT QUERY HOOKS ====================

  // Cached Results Query
  const { 
    data: cachedData, 
    isLoading: isLoadingCached,
    refetch: refetchCached
  } = useQuery({
    queryKey: ['data-integrity', 'cached'],
    queryFn: () => fetchWithCredentials<CachedResultsResponse>('/api/data-integrity/cached'),
  });

  // Calendar Status Query
  const { 
    data: calendarStatus, 
    isLoading: isLoadingCalendars 
  } = useQuery({
    queryKey: ['data-integrity', 'calendars'],
    queryFn: () => fetchWithCredentials<CalendarStatusResponse>('/api/admin/calendars'),
  });

  // History Query
  const { 
    data: historyData, 
    isLoading: isLoadingHistory 
  } = useQuery({
    queryKey: ['data-integrity', 'history'],
    queryFn: () => fetchWithCredentials<HistoryData>('/api/data-integrity/history'),
  });

  // Audit Log Query
  const { 
    data: auditLog = [], 
    isLoading: isLoadingAuditLog 
  } = useQuery({
    queryKey: ['data-integrity', 'audit-log'],
    queryFn: () => fetchWithCredentials<AuditLogEntry[]>('/api/data-integrity/audit-log?limit=10'),
  });

  // Ignored Issues Query
  const { 
    data: ignoredIssues = [], 
    isLoading: isLoadingIgnored 
  } = useQuery({
    queryKey: ['data-integrity', 'ignores'],
    queryFn: () => fetchWithCredentials<IgnoredIssueEntry[]>('/api/data-integrity/ignores'),
  });

  // Derive results and meta from cached data or run results
  const results = cachedData?.hasCached ? sortBySeverity(cachedData.results) : [];
  const meta = cachedData?.meta || null;
  const isCached = cachedData?.hasCached || false;

  // Run Integrity Checks Mutation
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
      showToast(err.message || 'Failed to run integrity checks', 'error');
    },
  });

  // Trigger run if no cached data
  useEffect(() => {
    if (cachedData && !cachedData.hasCached && !runIntegrityMutation.isPending) {
      runIntegrityMutation.mutate();
    }
  }, [cachedData]);

  // Real-time updates via WebSocket
  useEffect(() => {
    const handleDataIntegrityUpdate = (event: CustomEvent) => {
      const { action } = event.detail || {};
      console.log('[DataIntegrity] Real-time update received:', action);
      
      if (action === 'data_changed' || action === 'issue_resolved') {
        runIntegrityMutation.mutate();
        queryClient.invalidateQueries({ queryKey: ['data-integrity', 'history'] });
        queryClient.invalidateQueries({ queryKey: ['data-integrity', 'audit-log'] });
      }
    };

    window.addEventListener('data-integrity-update', handleDataIntegrityUpdate as EventListener);
    return () => {
      window.removeEventListener('data-integrity-update', handleDataIntegrityUpdate as EventListener);
    };
  }, [queryClient]);

  // Ignore Issue Mutation
  const ignoreIssueMutation = useMutation({
    mutationFn: (params: { issueKey: string; duration: string; reason: string }) => 
      postWithCredentials<{ success: boolean }>('/api/data-integrity/ignore', {
        issue_key: params.issueKey,
        duration: params.duration,
        reason: params.reason,
      }),
    onSuccess: () => {
      showToast('Issue ignored successfully', 'success');
      closeIgnoreModal();
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'ignores'] });
      runIntegrityMutation.mutate();
    },
    onError: (err: Error) => {
      showToast(err.message || 'Failed to ignore issue', 'error');
    },
  });

  // Unignore Issue Mutation
  const unignoreIssueMutation = useMutation({
    mutationFn: (issueKey: string) => 
      deleteWithCredentials<{ success: boolean }>(`/api/data-integrity/ignore/${encodeURIComponent(issueKey)}`),
    onSuccess: () => {
      showToast('Issue un-ignored successfully', 'success');
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'ignores'] });
      runIntegrityMutation.mutate();
    },
    onError: (err: Error) => {
      showToast(err.message || 'Failed to un-ignore issue', 'error');
    },
  });

  // Bulk Ignore Mutation
  const bulkIgnoreMutation = useMutation({
    mutationFn: (params: { issueKeys: string[]; duration: string; reason: string }) => 
      postWithCredentials<{ total: number }>('/api/data-integrity/ignore-bulk', {
        issue_keys: params.issueKeys,
        duration: params.duration,
        reason: params.reason,
      }),
    onSuccess: (data) => {
      showToast(`${data.total} issues excluded successfully`, 'success');
      closeBulkIgnoreModal();
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'ignores'] });
      runIntegrityMutation.mutate();
    },
    onError: (err: Error) => {
      showToast(err.message || 'Failed to exclude issues', 'error');
    },
  });

  // Sync Push Mutation
  const syncPushMutation = useMutation({
    mutationFn: (params: { issueKey: string; target: string; userId?: number; hubspotContactId?: string }) => 
      postWithCredentials<{ message: string }>('/api/data-integrity/sync-push', params),
    onSuccess: (data, variables) => {
      setSyncingIssues(prev => {
        const next = new Set(prev);
        next.delete(variables.issueKey);
        return next;
      });
      showToast(data.message || 'Successfully pushed to external system', 'success');
      runIntegrityMutation.mutate();
    },
    onError: (err: Error, variables) => {
      setSyncingIssues(prev => {
        const next = new Set(prev);
        next.delete(variables.issueKey);
        return next;
      });
      showToast(err.message || 'Failed to push sync', 'error');
    },
  });

  // Sync Pull Mutation
  const syncPullMutation = useMutation({
    mutationFn: (params: { issueKey: string; target: string; userId?: number; hubspotContactId?: string }) => 
      postWithCredentials<{ message: string }>('/api/data-integrity/sync-pull', params),
    onSuccess: (data, variables) => {
      setSyncingIssues(prev => {
        const next = new Set(prev);
        next.delete(variables.issueKey);
        return next;
      });
      showToast(data.message || 'Successfully pulled from external system', 'success');
      runIntegrityMutation.mutate();
    },
    onError: (err: Error, variables) => {
      setSyncingIssues(prev => {
        const next = new Set(prev);
        next.delete(variables.issueKey);
        return next;
      });
      showToast(err.message || 'Failed to pull sync', 'error');
    },
  });

  // Resync Member Mutation
  const resyncMemberMutation = useMutation({
    mutationFn: (email: string) => 
      postWithCredentials<{ message: string }>('/api/data-tools/resync-member', { email }),
    onSuccess: (data) => {
      setResyncResult({ success: true, message: data.message });
      showToast(data.message, 'success');
      setResyncEmail('');
    },
    onError: (err: Error) => {
      setResyncResult({ success: false, message: err.message || 'Failed to resync member' });
      showToast(err.message || 'Failed to resync member', 'error');
    },
  });

  // Cancel Booking Mutation (for ghost bookings without sessions)
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
      setCancellingBookings(prev => {
        const next = new Set(prev);
        next.delete(bookingId);
        return next;
      });
      showToast('Booking cancelled successfully', 'success');
      runIntegrityMutation.mutate();
    },
    onError: (err: Error, bookingId) => {
      setCancellingBookings(prev => {
        const next = new Set(prev);
        next.delete(bookingId);
        return next;
      });
      showToast(err.message || 'Failed to cancel booking', 'error');
    },
  });

  // Reconcile Group Billing Mutation
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
      setReconcileResult(data);
      const summary = `Checked ${data.groupsChecked} groups. Deactivated: ${data.membersDeactivated}, Reactivated: ${data.membersReactivated}, Created: ${data.membersCreated}, Relinked: ${data.itemsRelinked}`;
      showToast(summary, data.success ? 'success' : 'info');
    },
    onError: (err: Error) => {
      showToast(err.message || 'Failed to reconcile group billing', 'error');
    },
  });

  // Search Unlinked Guest Fees Mutation
  const searchGuestFeesMutation = useMutation({
    mutationFn: (params: { startDate: string; endDate: string }) => 
      fetchWithCredentials<any[]>(`/api/data-tools/unlinked-guest-fees?startDate=${params.startDate}&endDate=${params.endDate}`),
    onSuccess: (data) => {
      setUnlinkedGuestFees(data);
    },
    onError: () => {
      showToast('Failed to search guest fees', 'error');
    },
  });

  // Load Sessions For Fee Mutation
  const loadSessionsMutation = useMutation({
    mutationFn: (params: { date: string; memberEmail: string }) => 
      fetchWithCredentials<any[]>(`/api/data-tools/available-sessions?date=${params.date}&memberEmail=${params.memberEmail || ''}`),
    onSuccess: (data) => {
      setAvailableSessions(data);
    },
    onError: () => {
      console.error('Failed to load sessions');
    },
  });

  // Link Guest Fee Mutation
  const linkGuestFeeMutation = useMutation({
    mutationFn: (params: { guestFeeId: number; bookingId: number }) => 
      postWithCredentials<{ success: boolean }>('/api/data-tools/link-guest-fee', params),
    onSuccess: () => {
      showToast('Guest fee linked successfully', 'success');
      setUnlinkedGuestFees(prev => prev.filter(f => f.id !== selectedFeeId));
      setSelectedFeeId(null);
      setSelectedSessionId(null);
      setAvailableSessions([]);
    },
    onError: (err: Error) => {
      showToast(err.message || 'Failed to link guest fee', 'error');
    },
  });

  // Search Attendance Mutation
  const searchAttendanceMutation = useMutation({
    mutationFn: (params: { date?: string; memberEmail?: string }) => {
      const searchParams = new URLSearchParams();
      if (params.date) searchParams.append('date', params.date);
      if (params.memberEmail) searchParams.append('memberEmail', params.memberEmail);
      return fetchWithCredentials<any[]>(`/api/data-tools/bookings-search?${searchParams.toString()}`);
    },
    onSuccess: (data) => {
      setAttendanceBookings(data);
    },
    onError: () => {
      showToast('Failed to search bookings', 'error');
    },
  });

  // Update Attendance Mutation
  const updateAttendanceMutation = useMutation({
    mutationFn: (params: { bookingId: number; attendanceStatus: string; notes: string }) => 
      postWithCredentials<{ success: boolean }>('/api/data-tools/update-attendance', params),
    onSuccess: (_, variables) => {
      showToast(`Attendance updated to ${variables.attendanceStatus}`, 'success');
      setAttendanceBookings(prev => prev.map(b => 
        b.id === variables.bookingId 
          ? { ...b, reconciliationStatus: variables.attendanceStatus, reconciliationNotes: variables.notes } 
          : b
      ));
      setAttendanceNote('');
      setUpdatingAttendanceId(null);
    },
    onError: (err: Error) => {
      showToast(err.message || 'Failed to update attendance', 'error');
      setUpdatingAttendanceId(null);
    },
  });

  // Mindbody Reimport Mutation
  const mindbodyReimportMutation = useMutation({
    mutationFn: (params: { startDate: string; endDate: string }) => 
      postWithCredentials<{ message: string }>('/api/data-tools/mindbody-reimport', params),
    onSuccess: (data) => {
      setMindbodyResult({ success: true, message: data.message });
      showToast(data.message, 'success');
    },
    onError: (err: Error) => {
      setMindbodyResult({ success: false, message: err.message || 'Failed to queue reimport' });
      showToast(err.message || 'Failed to queue reimport', 'error');
    },
  });

  // CSV Upload Mutation
  const csvUploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const response = await fetch('/api/legacy-purchases/admin/upload-csv', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Import failed');
      }
      return response.json();
    },
    onSuccess: (data) => {
      const importedCount = data.results?.sales?.imported || 0;
      const linkedCount = data.results?.firstVisit?.linked || 0;
      setCsvUploadResult({
        success: true,
        message: `Import complete! ${importedCount} sales imported, ${linkedCount} clients linked.`,
        firstVisit: data.results?.firstVisit,
        sales: data.results?.sales,
      });
      showToast(`Successfully imported ${importedCount} sales records`, 'success');
      setFirstVisitFile(null);
      setSalesFile(null);
    },
    onError: (err: Error) => {
      setCsvUploadResult({ success: false, message: err.message || 'Import failed' });
      showToast(err.message || 'Failed to upload CSV files', 'error');
    },
  });

  // Backfill Stripe Cache Mutation
  const backfillStripeCacheMutation = useMutation({
    mutationFn: () => 
      postWithCredentials<{ stats?: any }>('/api/financials/backfill-stripe-cache', {}),
    onSuccess: (data) => {
      const msg = `Backfilled ${data.stats?.paymentIntents || 0} payments, ${data.stats?.charges || 0} charges, ${data.stats?.invoices || 0} invoices`;
      setStripeCacheResult({ success: true, message: msg, stats: data.stats });
      showToast(msg, 'success');
    },
    onError: (err: Error) => {
      setStripeCacheResult({ success: false, message: err.message || 'Failed to backfill cache' });
      showToast(err.message || 'Failed to backfill cache', 'error');
    },
  });

  // Sync Members to HubSpot Mutation
  const syncMembersToHubspotMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message: string; members?: any[]; syncedCount?: number }>('/api/data-tools/sync-members-to-hubspot', { dryRun }),
    onSuccess: (data, dryRun) => {
      setHubspotSyncResult({ 
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
      setHubspotSyncResult({ success: false, message: err.message || 'Failed to sync to HubSpot' });
      showToast(err.message || 'Failed to sync to HubSpot', 'error');
    },
  });

  // Cleanup Mindbody IDs Mutation
  const cleanupMindbodyIdsMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message: string; toClean?: number }>('/api/data-tools/cleanup-mindbody-ids', { dryRun }),
    onSuccess: (data, dryRun) => {
      setMindbodyCleanupResult({ 
        success: true, 
        message: data.message,
        toClean: data.toClean,
        dryRun
      });
      showToast(dryRun ? 'Preview complete - no changes made' : data.message, dryRun ? 'info' : 'success');
    },
    onError: (err: Error) => {
      setMindbodyCleanupResult({ success: false, message: err.message || 'Failed to cleanup Mind Body IDs' });
      showToast(err.message || 'Failed to cleanup Mind Body IDs', 'error');
    },
  });

  // Sync Subscription Status Mutation
  const syncSubscriptionStatusMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; totalChecked?: number; mismatchCount?: number; updated?: any[]; updatedCount?: number }>('/api/data-tools/sync-subscription-status', { dryRun }),
    onSuccess: (data, dryRun) => {
      setSubscriptionStatusResult({
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
      setSubscriptionStatusResult({ success: false, message: err.message || 'Failed to sync subscription status' });
      showToast(err.message || 'Failed to sync subscription status', 'error');
    },
  });

  // Clear Orphaned Stripe IDs Mutation
  const clearOrphanedStripeIdsMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; totalChecked?: number; orphanedCount?: number; cleared?: any[]; clearedCount?: number }>('/api/data-tools/clear-orphaned-stripe-ids', { dryRun }),
    onSuccess: (data, dryRun) => {
      setOrphanedStripeResult({
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
      setOrphanedStripeResult({ success: false, message: err.message || 'Failed to clear orphaned Stripe IDs' });
      showToast(err.message || 'Failed to clear orphaned Stripe IDs', 'error');
    },
  });

  // Link Stripe HubSpot Mutation
  const linkStripeHubspotMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; stripeOnlyMembers?: any[]; hubspotOnlyMembers?: any[]; linkedCount?: number }>('/api/data-tools/link-stripe-hubspot', { dryRun }),
    onSuccess: (data, dryRun) => {
      setStripeHubspotLinkResult({
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
      setStripeHubspotLinkResult({ success: false, message: err.message || 'Failed to link Stripe and HubSpot' });
      showToast(err.message || 'Failed to link Stripe and HubSpot', 'error');
    },
  });

  // Sync Payment Status Mutation
  const syncPaymentStatusMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; totalChecked?: number; updatedCount?: number; updates?: any[] }>('/api/data-tools/sync-payment-status', { dryRun }),
    onSuccess: (data, dryRun) => {
      setPaymentStatusResult({
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
      setPaymentStatusResult({ success: false, message: err.message || 'Failed to sync payment status' });
      showToast(err.message || 'Failed to sync payment status', 'error');
    },
  });

  // Sync Visit Counts Mutation
  const syncVisitCountsMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; mismatchCount?: number; updatedCount?: number; sampleMismatches?: any[] }>('/api/data-tools/sync-visit-counts', { dryRun }),
    onSuccess: (data, dryRun) => {
      setVisitCountResult({
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
      setVisitCountResult({ success: false, message: err.message || 'Failed to sync visit counts' });
      showToast(err.message || 'Failed to sync visit counts', 'error');
    },
  });

  // Fix Ghost Bookings Mutation (preview)
  const previewGhostBookingsMutation = useMutation({
    mutationFn: () => fetchWithCredentials<{ message?: string; totalCount?: number }>('/api/admin/backfill-sessions/preview'),
    onSuccess: (data) => {
      setGhostBookingResult({
        success: true,
        message: data.message || `Found ${data.totalCount} bookings without sessions`,
        ghostBookings: data.totalCount,
        fixed: 0,
        dryRun: true
      });
      showToast('Preview complete - no changes made', 'info');
    },
    onError: (err: Error) => {
      setGhostBookingResult({ success: false, message: err.message || 'Failed to preview' });
      showToast(err.message || 'Failed to preview', 'error');
    },
  });

  // Fix Ghost Bookings Mutation (execute)
  const fixGhostBookingsMutation = useMutation({
    mutationFn: () => postWithCredentials<{ message?: string; sessionsCreated?: number }>('/api/admin/backfill-sessions', {}),
    onSuccess: (data) => {
      setGhostBookingResult({
        success: true,
        message: data.message || `Created ${data.sessionsCreated} sessions`,
        ghostBookings: data.sessionsCreated,
        fixed: data.sessionsCreated,
        dryRun: false
      });
      showToast(data.message || `Created ${data.sessionsCreated} sessions`, 'success');
      if (data.sessionsCreated && data.sessionsCreated > 0) {
        runIntegrityMutation.mutate();
      }
    },
    onError: (err: Error) => {
      setGhostBookingResult({ success: false, message: err.message || 'Failed to create sessions' });
      showToast(err.message || 'Failed to create sessions', 'error');
    },
  });

  // Remediate Deal Stages Mutation
  const remediateDealStagesMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; total?: number; fixed?: number }>('/api/hubspot/remediate-deal-stages', { dryRun }),
    onSuccess: (data, dryRun) => {
      setDealStageRemediationResult({
        success: true,
        message: data.message || `Found ${data.total || 0} deals needing updates${!dryRun ? `, fixed ${data.fixed || 0}` : ''}`,
        total: data.total,
        fixed: data.fixed,
        dryRun
      });
      showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Deal stage remediation complete'), dryRun ? 'info' : 'success');
    },
    onError: (err: Error) => {
      setDealStageRemediationResult({ success: false, message: err.message || 'Failed to remediate deal stages' });
      showToast(err.message || 'Failed to remediate deal stages', 'error');
    },
  });

  // Detect Duplicates Mutation
  const detectDuplicatesMutation = useMutation({
    mutationFn: () => 
      postWithCredentials<{ message?: string; appDuplicates?: any[]; hubspotDuplicates?: any[] }>('/api/data-tools/detect-duplicates', {}),
    onSuccess: (data) => {
      const appCount = data.appDuplicates?.length || 0;
      const hubspotCount = data.hubspotDuplicates?.length || 0;
      setDuplicateDetectionResult({
        success: true,
        message: data.message || `Found ${appCount} app duplicates, ${hubspotCount} HubSpot duplicates`,
        appDuplicates: data.appDuplicates,
        hubspotDuplicates: data.hubspotDuplicates
      });
      setExpandedDuplicates({ app: false, hubspot: false });
      showToast(data.message || 'Duplicate detection complete', 'success');
    },
    onError: (err: Error) => {
      setDuplicateDetectionResult({ success: false, message: err.message || 'Failed to detect duplicates' });
      showToast(err.message || 'Failed to detect duplicates', 'error');
    },
  });

  // Scan Placeholders Mutation
  const scanPlaceholdersMutation = useMutation({
    mutationFn: () => 
      fetchWithCredentials<{ success: boolean; stripeCustomers?: any[]; hubspotContacts?: any[]; localDatabaseUsers?: any[]; totals?: { stripe: number; hubspot: number; localDatabase: number; total: number } }>('/api/data-integrity/placeholder-accounts'),
    onSuccess: (data) => {
      if (data.success) {
        setPlaceholderAccounts({
          stripeCustomers: data.stripeCustomers || [],
          hubspotContacts: data.hubspotContacts || [],
          localDatabaseUsers: data.localDatabaseUsers || [],
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
      setPlaceholderDeleteResult(null);
    },
    onError: () => {
      showToast('Failed to scan for placeholders', 'error');
    },
  });

  // Delete Placeholders Mutation
  const deletePlaceholdersMutation = useMutation({
    mutationFn: (params: { stripeCustomerIds: string[]; hubspotContactIds: string[]; localDatabaseUserIds: string[] }) => 
      postWithCredentials<{ success: boolean; stripeDeleted?: number; stripeFailed?: number; hubspotDeleted?: number; hubspotFailed?: number; localDatabaseDeleted?: number; localDatabaseFailed?: number }>('/api/data-integrity/placeholder-accounts/delete', params),
    onSuccess: (data) => {
      if (data.success) {
        setPlaceholderDeleteResult({
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
        setPlaceholderAccounts(null);
      } else {
        showToast('Failed to delete placeholder accounts', 'error');
      }
      setShowDeleteConfirm(false);
    },
    onError: () => {
      showToast('Failed to delete placeholder accounts', 'error');
      setShowDeleteConfirm(false);
    },
  });

  // ==================== HELPER FUNCTIONS ====================

  const openIgnoreModal = (issue: IntegrityIssue, checkName: string) => {
    setIgnoreModal({ isOpen: true, issue, checkName });
    setIgnoreDuration('24h');
    setIgnoreReason('');
  };

  const closeIgnoreModal = () => {
    setIgnoreModal({ isOpen: false, issue: null, checkName: '' });
    setIgnoreDuration('24h');
    setIgnoreReason('');
  };

  const handleIgnoreIssue = () => {
    if (!ignoreModal.issue || !ignoreReason.trim()) return;
    const issueKey = `${ignoreModal.issue.table}_${ignoreModal.issue.recordId}`;
    ignoreIssueMutation.mutate({ issueKey, duration: ignoreDuration, reason: ignoreReason.trim() });
  };

  const handleUnignoreIssue = (issueKey: string) => {
    unignoreIssueMutation.mutate(issueKey);
  };

  const openBulkIgnoreModal = (checkName: string, issues: IntegrityIssue[]) => {
    const nonIgnoredIssues = issues.filter(i => !i.ignored);
    setBulkIgnoreModal({ isOpen: true, checkName, issues: nonIgnoredIssues });
    setIgnoreDuration('30d');
    setIgnoreReason('');
  };

  const closeBulkIgnoreModal = () => {
    setBulkIgnoreModal({ isOpen: false, checkName: '', issues: [] });
    setIgnoreDuration('24h');
    setIgnoreReason('');
  };

  const handleBulkIgnore = () => {
    if (bulkIgnoreModal.issues.length === 0 || !ignoreReason.trim()) return;
    const issueKeys = bulkIgnoreModal.issues.map(issue => `${issue.table}_${issue.recordId}`);
    bulkIgnoreMutation.mutate({ issueKeys, duration: ignoreDuration, reason: ignoreReason.trim() });
  };

  const handleSyncPush = (issue: IntegrityIssue) => {
    if (!issue.context?.syncType) return;
    const issueKey = `${issue.table}_${issue.recordId}`;
    setSyncingIssues(prev => new Set(prev).add(issueKey));
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
    setSyncingIssues(prev => new Set(prev).add(issueKey));
    syncPullMutation.mutate({
      issueKey,
      target: issue.context.syncType,
      userId: issue.context.userId,
      hubspotContactId: issue.context.hubspotContactId
    });
  };

  const handleCancelBooking = (bookingId: number) => {
    if (cancellingBookings.has(bookingId)) return;
    setCancellingBookings(prev => new Set(prev).add(bookingId));
    cancelBookingMutation.mutate(bookingId);
  };

  const handleViewProfile = useCallback(async (email: string) => {
    if (!email) return;
    setLoadingMemberEmail(email);
    try {
      const response = await fetchWithCredentials<any>(`/api/members/${encodeURIComponent(email)}/details`);
      if (!response || !response.id) {
        throw new Error('Invalid response from server');
      }
      const profile: MemberProfile = {
        id: response.id,
        name: [response.firstName, response.lastName].filter(Boolean).join(' ') || response.email,
        tier: response.tier || '',
        rawTier: response.tier,
        membershipStatus: response.membershipStatus || null,
        tags: response.tags || [],
        status: response.membershipStatus || 'Inactive',
        email: response.email,
        phone: response.phone || '',
        role: response.role,
        mindbodyClientId: response.mindbodyClientId,
        stripeCustomerId: response.stripeCustomerId,
        hubspotId: response.hubspotId,
        dateOfBirth: response.dateOfBirth,
        billingProvider: response.billingProvider,
        streetAddress: response.streetAddress,
        city: response.city,
        state: response.state,
        zipCode: response.zipCode,
        companyName: response.companyName,
        lifetimeVisits: response.lifetimeVisits,
        lastBookingDate: response.lastBookingDate,
      };
      setSelectedMember(profile);
      setIsProfileDrawerOpen(true);
    } catch (error: any) {
      showToast(error.message || 'Failed to load member profile', 'error');
    } finally {
      setLoadingMemberEmail(null);
    }
  }, [showToast]);

  const runIntegrityChecks = () => {
    runIntegrityMutation.mutate();
  };

  const handleCheckHealth = async () => {
    setIsCheckingHealth(true);
    try {
      const response = await fetchWithCredentials<{ success: boolean; health: SystemHealth }>('/api/data-integrity/health');
      if (response.success) {
        setSystemHealth(response.health);
        showToast('System health check completed', 'success');
      }
    } catch (error: any) {
      showToast(error.message || 'Failed to check system health', 'error');
    } finally {
      setIsCheckingHealth(false);
    }
  };

  const handleResyncMember = () => {
    if (!resyncEmail.trim()) return;
    setResyncResult(null);
    resyncMemberMutation.mutate(resyncEmail.trim());
  };

  const handleReconcileGroupBilling = () => {
    setReconcileResult(null);
    reconcileGroupBillingMutation.mutate();
  };

  const handleSearchUnlinkedGuestFees = () => {
    if (!guestFeeStartDate || !guestFeeEndDate) return;
    searchGuestFeesMutation.mutate({ startDate: guestFeeStartDate, endDate: guestFeeEndDate });
  };

  const handleLoadSessionsForFee = (fee: any) => {
    setSelectedFeeId(fee.id);
    setSelectedSessionId(null);
    loadSessionsMutation.mutate({ date: fee.saleDate, memberEmail: fee.memberEmail || '' });
  };

  const handleLinkGuestFee = () => {
    if (!selectedFeeId || !selectedSessionId) return;
    linkGuestFeeMutation.mutate({ guestFeeId: selectedFeeId, bookingId: selectedSessionId });
  };

  const handleSearchAttendance = () => {
    if (!attendanceSearchDate && !attendanceSearchEmail) {
      showToast('Please enter a date or member email', 'error');
      return;
    }
    searchAttendanceMutation.mutate({ 
      date: attendanceSearchDate || undefined, 
      memberEmail: attendanceSearchEmail || undefined 
    });
  };

  const handleUpdateAttendance = (bookingId: number, status: string) => {
    setUpdatingAttendanceId(bookingId);
    updateAttendanceMutation.mutate({ bookingId, attendanceStatus: status, notes: attendanceNote });
  };

  const handleMindbodyReimport = () => {
    if (!mindbodyStartDate || !mindbodyEndDate) return;
    setMindbodyResult(null);
    mindbodyReimportMutation.mutate({ startDate: mindbodyStartDate, endDate: mindbodyEndDate });
  };

  const handleCSVUpload = () => {
    if (!salesFile) {
      showToast('Please select a Sales Report CSV file', 'error');
      return;
    }
    setCsvUploadResult(null);
    const formData = new FormData();
    if (firstVisitFile) {
      formData.append('firstVisitFile', firstVisitFile);
    }
    formData.append('salesFile', salesFile);
    csvUploadMutation.mutate(formData);
  };

  const handleBackfillStripeCache = () => {
    setStripeCacheResult(null);
    backfillStripeCacheMutation.mutate();
  };

  const handleSyncMembersToHubspot = (dryRun: boolean = true) => {
    setHubspotSyncResult(null);
    syncMembersToHubspotMutation.mutate(dryRun);
  };

  const handleCleanupMindbodyIds = (dryRun: boolean = true) => {
    setMindbodyCleanupResult(null);
    cleanupMindbodyIdsMutation.mutate(dryRun);
  };

  const handleSyncSubscriptionStatus = (dryRun: boolean = true) => {
    setSubscriptionStatusResult(null);
    syncSubscriptionStatusMutation.mutate(dryRun);
  };

  const handleClearOrphanedStripeIds = (dryRun: boolean = true) => {
    setOrphanedStripeResult(null);
    clearOrphanedStripeIdsMutation.mutate(dryRun);
  };

  const handleLinkStripeHubspot = (dryRun: boolean = true) => {
    setStripeHubspotLinkResult(null);
    linkStripeHubspotMutation.mutate(dryRun);
  };

  const handleSyncPaymentStatus = (dryRun: boolean = true) => {
    setPaymentStatusResult(null);
    syncPaymentStatusMutation.mutate(dryRun);
  };

  const handleSyncVisitCounts = (dryRun: boolean = true) => {
    setVisitCountResult(null);
    syncVisitCountsMutation.mutate(dryRun);
  };

  const handleFixGhostBookings = (dryRun: boolean = true) => {
    setGhostBookingResult(null);
    if (dryRun) {
      previewGhostBookingsMutation.mutate();
    } else {
      fixGhostBookingsMutation.mutate();
    }
  };

  const handleRemediateDealStages = (dryRun: boolean = true) => {
    setDealStageRemediationResult(null);
    remediateDealStagesMutation.mutate(dryRun);
  };

  const handleDetectDuplicates = () => {
    setDuplicateDetectionResult(null);
    setExpandedDuplicates({ app: false, hubspot: false });
    detectDuplicatesMutation.mutate();
  };

  const handleScanPlaceholders = () => {
    setPlaceholderAccounts(null);
    setPlaceholderDeleteResult(null);
    scanPlaceholdersMutation.mutate();
  };

  const handleDeletePlaceholders = () => {
    if (!placeholderAccounts) return;
    setShowDeleteConfirm(false);
    deletePlaceholdersMutation.mutate({
      stripeCustomerIds: placeholderAccounts.stripeCustomers.map(c => c.id),
      hubspotContactIds: placeholderAccounts.hubspotContacts.map(c => c.id),
      localDatabaseUserIds: placeholderAccounts.localDatabaseUsers.map(u => u.id)
    });
  };

  // Derived loading states
  const isRunning = runIntegrityMutation.isPending;
  const isIgnoring = ignoreIssueMutation.isPending;
  const isBulkIgnoring = bulkIgnoreMutation.isPending;
  const isResyncing = resyncMemberMutation.isPending;
  const isReconciling = reconcileGroupBillingMutation.isPending;
  const isLoadingGuestFees = searchGuestFeesMutation.isPending;
  const isLinkingFee = linkGuestFeeMutation.isPending;
  const isSearchingAttendance = searchAttendanceMutation.isPending;
  const isRunningMindbodyImport = mindbodyReimportMutation.isPending;
  const isUploadingCSV = csvUploadMutation.isPending;
  const isBackfillingStripeCache = backfillStripeCacheMutation.isPending;
  const isSyncingToHubspot = syncMembersToHubspotMutation.isPending;
  const isCleaningMindbodyIds = cleanupMindbodyIdsMutation.isPending;
  const isRunningSubscriptionSync = syncSubscriptionStatusMutation.isPending;
  const isRunningOrphanedStripeCleanup = clearOrphanedStripeIdsMutation.isPending;
  const isRunningStripeHubspotLink = linkStripeHubspotMutation.isPending;
  const isRunningPaymentStatusSync = syncPaymentStatusMutation.isPending;
  const isRunningVisitCountSync = syncVisitCountsMutation.isPending;
  const isRunningGhostBookingFix = previewGhostBookingsMutation.isPending || fixGhostBookingsMutation.isPending;
  const isRunningDealStageRemediation = remediateDealStagesMutation.isPending;
  const isRunningDuplicateDetection = detectDuplicatesMutation.isPending;
  const isLoadingPlaceholders = scanPlaceholdersMutation.isPending;
  const isDeletingPlaceholders = deletePlaceholdersMutation.isPending;

  const formatTimeAgo = (date: Date | string) => {
    const now = new Date();
    const then = new Date(date);
    const diffMs = now.getTime() - then.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  };

  const getIssueTracking = (issue: IntegrityIssue): ActiveIssue | undefined => {
    if (!historyData) return undefined;
    const issueKey = `${issue.table}_${issue.recordId}`;
    return historyData.activeIssues.find(ai => ai.issueKey === issueKey);
  };

  const getTrendIcon = (trend: 'increasing' | 'decreasing' | 'stable') => {
    switch (trend) {
      case 'increasing': return 'trending_up';
      case 'decreasing': return 'trending_down';
      case 'stable': return 'trending_flat';
    }
  };

  const getTrendColor = (trend: 'increasing' | 'decreasing' | 'stable') => {
    switch (trend) {
      case 'increasing': return 'text-red-500 dark:text-red-400';
      case 'decreasing': return 'text-green-500 dark:text-green-400';
      case 'stable': return 'text-gray-500 dark:text-gray-400';
    }
  };

  const toggleCheck = (checkName: string) => {
    setExpandedChecks(prev => {
      const next = new Set(prev);
      if (next.has(checkName)) {
        next.delete(checkName);
      } else {
        next.add(checkName);
      }
      return next;
    });
  };

  const getStatusColor = (status: 'pass' | 'warning' | 'fail') => {
    switch (status) {
      case 'pass': return 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400';
      case 'warning': return 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400';
      case 'fail': return 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400';
    }
  };

  const getCheckSeverityColor = (severity: CheckSeverity) => {
    switch (severity) {
      case 'critical': return 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400';
      case 'high': return 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400';
      case 'medium': return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400';
      case 'low': return 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400';
    }
  };

  const getSeverityColor = (severity: 'error' | 'warning' | 'info') => {
    switch (severity) {
      case 'error': return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300';
      case 'warning': return 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300';
      case 'info': return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300';
    }
  };

  const getSeverityIcon = (severity: 'error' | 'warning' | 'info') => {
    switch (severity) {
      case 'error': return 'error';
      case 'warning': return 'warning';
      case 'info': return 'info';
    }
  };

  const renderCheckFixTools = (checkName: string) => {
    const getResultStyle = (result: { success: boolean; dryRun?: boolean } | null) => {
      if (!result) return '';
      if (!result.success) return 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700';
      if (result.dryRun) return 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700';
      return 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700';
    };
    
    const getTextStyle = (result: { success: boolean; dryRun?: boolean } | null) => {
      if (!result) return '';
      if (!result.success) return 'text-red-700 dark:text-red-400';
      if (result.dryRun) return 'text-blue-700 dark:text-blue-400';
      return 'text-green-700 dark:text-green-400';
    };

    switch (checkName) {
      case 'HubSpot Sync Mismatch':
        return (
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
              <strong>Quick Fix:</strong> Sync member data to HubSpot to resolve mismatches
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleSyncMembersToHubspot(true)}
                disabled={isSyncingToHubspot}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isSyncingToHubspot && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleSyncMembersToHubspot(false)}
                disabled={isSyncingToHubspot}
                className="px-3 py-1.5 bg-orange-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isSyncingToHubspot && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">sync</span>
                Sync to HubSpot
              </button>
            </div>
            {hubspotSyncResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(hubspotSyncResult)}`}>
                {hubspotSyncResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(hubspotSyncResult)}`}>{hubspotSyncResult.message}</p>
              </div>
            )}
          </div>
        );

      case 'Subscription Status Drift':
      case 'Stripe Subscription Sync':
        return (
          <div className="space-y-3">
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
              <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
                <strong>Sync Status:</strong> Sync membership status from Stripe to correct mismatches
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => handleSyncSubscriptionStatus(true)}
                  disabled={isRunningSubscriptionSync}
                  className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  {isRunningSubscriptionSync && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                  <span className="material-symbols-outlined text-[14px]">visibility</span>
                  Preview
                </button>
                <button
                  onClick={() => handleSyncSubscriptionStatus(false)}
                  disabled={isRunningSubscriptionSync}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  {isRunningSubscriptionSync && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                  <span className="material-symbols-outlined text-[14px]">sync</span>
                  Sync from Stripe
                </button>
              </div>
              {subscriptionStatusResult && (
                <div className={`mt-2 p-2 rounded ${getResultStyle(subscriptionStatusResult)}`}>
                  {subscriptionStatusResult.dryRun && (
                    <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                  )}
                  <p className={`text-xs ${getTextStyle(subscriptionStatusResult)}`}>{subscriptionStatusResult.message}</p>
                </div>
              )}
            </div>
            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
              <p className="text-xs text-red-700 dark:text-red-300 mb-2">
                <strong>Clear Orphaned IDs:</strong> Remove Stripe customer IDs that no longer exist in Stripe
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => handleClearOrphanedStripeIds(true)}
                  disabled={isRunningOrphanedStripeCleanup}
                  className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  {isRunningOrphanedStripeCleanup && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                  <span className="material-symbols-outlined text-[14px]">visibility</span>
                  Preview
                </button>
                <button
                  onClick={() => handleClearOrphanedStripeIds(false)}
                  disabled={isRunningOrphanedStripeCleanup}
                  className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  {isRunningOrphanedStripeCleanup && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                  <span className="material-symbols-outlined text-[14px]">delete_sweep</span>
                  Clear Orphaned IDs
                </button>
              </div>
              {orphanedStripeResult && (
                <div className={`mt-2 p-2 rounded ${getResultStyle(orphanedStripeResult)}`}>
                  {orphanedStripeResult.dryRun && (
                    <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                  )}
                  <p className={`text-xs ${getTextStyle(orphanedStripeResult)}`}>{orphanedStripeResult.message}</p>
                  {orphanedStripeResult.cleared && orphanedStripeResult.cleared.length > 0 && (
                    <div className="mt-2 max-h-24 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                      {orphanedStripeResult.cleared.map((c: any, i: number) => (
                        <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                          {c.email}: {c.stripeCustomerId}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );

      case 'Bookings Without Sessions':
      case 'Active Bookings Without Sessions':
        return (
          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-amber-700 dark:text-amber-300 mb-2">
              <strong>Quick Fix:</strong> Create missing billing sessions for Trackman bookings
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleFixGhostBookings(true)}
                disabled={isRunningGhostBookingFix}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningGhostBookingFix && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleFixGhostBookings(false)}
                disabled={isRunningGhostBookingFix}
                className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningGhostBookingFix && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">build</span>
                Create Sessions
              </button>
            </div>
            {ghostBookingResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(ghostBookingResult)}`}>
                {ghostBookingResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(ghostBookingResult)}`}>{ghostBookingResult.message}</p>
              </div>
            )}
          </div>
        );

      case 'Stale Mindbody IDs':
        return (
          <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-purple-700 dark:text-purple-300 mb-2">
              <strong>Quick Fix:</strong> Remove old Mindbody IDs from members no longer in Mindbody
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleCleanupMindbodyIds(true)}
                disabled={isCleaningMindbodyIds}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isCleaningMindbodyIds && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleCleanupMindbodyIds(false)}
                disabled={isCleaningMindbodyIds}
                className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isCleaningMindbodyIds && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">cleaning_services</span>
                Clean Up
              </button>
            </div>
            {mindbodyCleanupResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(mindbodyCleanupResult)}`}>
                {mindbodyCleanupResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(mindbodyCleanupResult)}`}>{mindbodyCleanupResult.message}</p>
              </div>
            )}
          </div>
        );

      case 'Deal Stage Drift':
        return (
          <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-orange-700 dark:text-orange-300 mb-2">
              <strong>Quick Fix:</strong> Update HubSpot deal stages to match current membership status
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleRemediateDealStages(true)}
                disabled={isRunningDealStageRemediation}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningDealStageRemediation && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleRemediateDealStages(false)}
                disabled={isRunningDealStageRemediation}
                className="px-3 py-1.5 bg-orange-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningDealStageRemediation && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">sync</span>
                Remediate Deal Stages
              </button>
            </div>
            {dealStageRemediationResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(dealStageRemediationResult)}`}>
                {dealStageRemediationResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(dealStageRemediationResult)}`}>{dealStageRemediationResult.message}</p>
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  const groupByCategory = (issues: IntegrityIssue[]) => {
    return issues.reduce((acc, issue) => {
      if (!acc[issue.category]) acc[issue.category] = [];
      acc[issue.category].push(issue);
      return acc;
    }, {} as Record<string, IntegrityIssue[]>);
  };

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case 'orphan_record': return 'Orphan Records';
      case 'missing_relationship': return 'Missing Relationships';
      case 'sync_mismatch': return 'Sync Mismatches';
      case 'data_quality': return 'Data Quality';
      default: return category;
    }
  };

  const formatContextString = (context?: IssueContext): string | null => {
    if (!context) return null;
    
    const parts: string[] = [];
    
    if (context.memberName) parts.push(context.memberName);
    if (context.guestName && !context.memberName) parts.push(context.guestName);
    if (context.memberEmail && !context.memberName) parts.push(context.memberEmail);
    if (context.memberTier) parts.push(`Tier: ${context.memberTier}`);
    
    if (context.bookingDate || context.tourDate || context.classDate || context.eventDate) {
      const date = context.bookingDate || context.tourDate || context.classDate || context.eventDate;
      if (date) {
        try {
          const formatted = new Date(date).toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: 'numeric' 
          });
          parts.push(formatted);
        } catch {
          parts.push(date);
        }
      }
    }
    
    if (context.startTime) {
      const timeStr = context.startTime.substring(0, 5);
      parts.push(timeStr);
    }
    
    if (context.resourceName) parts.push(context.resourceName);
    if (context.className && !context.eventTitle) parts.push(context.className);
    if (context.eventTitle) parts.push(context.eventTitle);
    if (context.instructor) parts.push(`Instructor: ${context.instructor}`);
    
    return parts.length > 0 ? parts.join(' • ') : null;
  };

  const errorCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'error').length, 0);
  const warningCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'warning').length, 0);
  const infoCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'info').length, 0);

  const escapeCSVField = (field: string | number): string => {
    const str = String(field);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const downloadCSV = () => {
    const headers = ['Check Name', 'Severity', 'Category', 'Table', 'Record ID', 'Description', 'Suggestion'];
    const rows: string[][] = [];

    results.forEach(result => {
      const metadata = getCheckMetadata(result.checkName);
      const displayTitle = metadata?.title || result.checkName;
      
      result.issues.forEach(issue => {
        rows.push([
          displayTitle,
          issue.severity,
          issue.category,
          issue.table,
          String(issue.recordId),
          issue.description,
          issue.suggestion || ''
        ]);
      });
    });

    const csvContent = [
      headers.map(escapeCSVField).join(','),
      ...rows.map(row => row.map(escapeCSVField).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().split('T')[0];
    link.href = url;
    link.download = `data-integrity-export-${date}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const hasIssues = results.some(r => r.issues.length > 0);

  return (
    <div className="space-y-6 animate-slide-up-stagger pb-32" style={{ '--stagger-index': 0 } as React.CSSProperties}>
      <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white text-[24px]">monitoring</span>
            <h3 className="text-lg font-bold text-primary dark:text-white">System Health</h3>
          </div>
          <button
            onClick={handleCheckHealth}
            disabled={isCheckingHealth}
            className="px-4 py-2 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-lg font-medium text-sm flex items-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isCheckingHealth ? (
              <>
                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                Checking...
              </>
            ) : (
              <>
                <span aria-hidden="true" className="material-symbols-outlined text-[16px]">health_and_safety</span>
                Check Health
              </>
            )}
          </button>
        </div>

        {systemHealth ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
              {[
                { key: 'database' as const, label: 'Database', icon: 'database' },
                { key: 'stripe' as const, label: 'Stripe', icon: 'credit_card' },
                { key: 'hubspot' as const, label: 'HubSpot', icon: 'groups' },
                { key: 'resend' as const, label: 'Resend', icon: 'mail' },
                { key: 'googleCalendar' as const, label: 'Google Calendar', icon: 'calendar_today' },
              ].map(({ key, label, icon }) => {
                const service = systemHealth.services[key];
                const isHealthy = service.status === 'healthy';
                const isDegraded = service.status === 'degraded';
                const isUnhealthy = service.status === 'unhealthy';
                
                let statusBgColor = 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800';
                let statusTextColor = 'text-green-700 dark:text-green-300';
                let statusIcon = 'check_circle';
                
                if (isDegraded) {
                  statusBgColor = 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800';
                  statusTextColor = 'text-yellow-700 dark:text-yellow-300';
                  statusIcon = 'warning';
                } else if (isUnhealthy) {
                  statusBgColor = 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
                  statusTextColor = 'text-red-700 dark:text-red-300';
                  statusIcon = 'cancel';
                }

                return (
                  <div key={key} className={`border rounded-lg p-3 ${statusBgColor}`}>
                    <div className="flex items-start gap-2 mb-2">
                      <span aria-hidden="true" className={`material-symbols-outlined text-[20px] ${statusTextColor}`}>{statusIcon}</span>
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs font-bold ${statusTextColor}`}>{label}</p>
                        <p className={`text-[10px] ${statusTextColor} opacity-80`}>{service.status}</p>
                      </div>
                    </div>
                    {service.latencyMs !== undefined && (
                      <p className={`text-[10px] ${statusTextColor} opacity-70`}>
                        <span aria-hidden="true" className="material-symbols-outlined text-[12px] align-text-bottom mr-0.5">schedule</span>
                        {service.latencyMs}ms
                      </p>
                    )}
                    {service.message && isUnhealthy && (
                      <p className={`text-[10px] ${statusTextColor} opacity-80 mt-1 line-clamp-2`}>{service.message}</p>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 text-right">
              Checked {new Date(systemHealth.timestamp).toLocaleTimeString()}
            </p>
          </div>
        ) : (
          <div className="text-center py-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">Click "Check Health" to see system status</p>
          </div>
        )}
      </div>

      <div className="mb-6 flex flex-col gap-3">
        <div className="flex gap-3">
          <button
            onClick={runIntegrityChecks}
            disabled={isRunning || isLoadingCached}
            className="flex-1 py-3 px-4 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-xl font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isRunning ? (
              <>
                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                Running Checks...
              </>
            ) : (
              <>
                <span aria-hidden="true" className="material-symbols-outlined text-[20px]">{isCached ? 'refresh' : 'fact_check'}</span>
                {isCached ? 'Refresh Checks' : 'Run Integrity Checks'}
              </>
            )}
          </button>
          {results.length > 0 && (
            <button
              onClick={downloadCSV}
              disabled={!hasIssues}
              className="py-3 px-4 border-2 border-primary dark:border-white/40 text-primary dark:text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[20px]">download</span>
              Download CSV
            </button>
          )}
        </div>
        {meta?.lastRun && isCached && (
          <p className="text-sm text-primary/60 dark:text-white/60 text-center">
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] align-middle mr-1">schedule</span>
            Last checked {formatTimeAgo(meta.lastRun)}
          </p>
        )}
      </div>

      {isLoadingCached && !meta && (
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-8 text-center">
          <span aria-hidden="true" className="material-symbols-outlined animate-spin text-3xl text-primary/40 dark:text-white/40 mb-2">progress_activity</span>
          <p className="text-sm text-primary/60 dark:text-white/60">Loading cached results...</p>
        </div>
      )}

      {meta && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-primary dark:text-white">{meta.totalIssues}</p>
            <p className="text-xs text-primary/60 dark:text-white/60 uppercase tracking-wide">Total Issues</p>
          </div>
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-red-600 dark:text-red-400">{errorCount}</p>
            <p className="text-xs text-red-600/70 dark:text-red-400/70 uppercase tracking-wide">Errors</p>
          </div>
          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{warningCount}</p>
            <p className="text-xs text-amber-600/70 dark:text-amber-400/70 uppercase tracking-wide">Warnings</p>
          </div>
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{infoCount}</p>
            <p className="text-xs text-blue-600/70 dark:text-blue-400/70 uppercase tracking-wide">Info</p>
          </div>
        </div>
      )}

      <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
        <button
          onClick={() => setShowCalendars(!showCalendars)}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">calendar_month</span>
            <span className="font-bold text-primary dark:text-white">Calendar Status</span>
          </div>
          <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showCalendars ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>
        
        {showCalendars && (
          <div className="mt-4 space-y-3">
            {isLoadingCalendars ? (
              <div className="flex items-center justify-center py-4">
                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-gray-500">progress_activity</span>
              </div>
            ) : calendarStatus ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {calendarStatus.configured_calendars.map((cal, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                      <span className="text-sm font-medium text-primary dark:text-white truncate mr-2">{cal.name}</span>
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded shrink-0 ${
                        cal.status === 'connected' 
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400' 
                          : 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                      }`}>
                        {cal.status === 'connected' ? 'Connected' : 'Not Found'}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Last checked: {new Date(calendarStatus.timestamp).toLocaleString()}
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">Failed to load calendar status</p>
            )}
          </div>
        )}
      </div>

      <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">history</span>
            <span className="font-bold text-primary dark:text-white">Issue History</span>
            {historyData && (
              <span className={`flex items-center gap-1 text-sm ${getTrendColor(historyData.trend)}`}>
                <span aria-hidden="true" className="material-symbols-outlined text-[16px]">{getTrendIcon(historyData.trend)}</span>
                {historyData.trend === 'increasing' ? 'Issues increasing' : historyData.trend === 'decreasing' ? 'Issues decreasing' : 'Stable'}
              </span>
            )}
          </div>
          <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showHistory ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>
        
        {showHistory && (
          <div className="mt-4 space-y-4">
            {isLoadingHistory ? (
              <div className="flex items-center justify-center py-4">
                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-gray-500">progress_activity</span>
              </div>
            ) : historyData ? (
              <>
                {historyData.history.length > 0 ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-2">
                        <p className="text-lg font-bold text-red-600 dark:text-red-400">{historyData.activeIssues.filter(i => i.severity === 'critical').length}</p>
                        <p className="text-[10px] text-red-600/70 dark:text-red-400/70 uppercase">Critical</p>
                      </div>
                      <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-2">
                        <p className="text-lg font-bold text-orange-600 dark:text-orange-400">{historyData.activeIssues.filter(i => i.severity === 'high').length}</p>
                        <p className="text-[10px] text-orange-600/70 dark:text-orange-400/70 uppercase">High</p>
                      </div>
                      <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-2">
                        <p className="text-lg font-bold text-yellow-600 dark:text-yellow-400">{historyData.activeIssues.filter(i => i.severity === 'medium').length}</p>
                        <p className="text-[10px] text-yellow-600/70 dark:text-yellow-400/70 uppercase">Medium</p>
                      </div>
                      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2">
                        <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{historyData.activeIssues.filter(i => i.severity === 'low').length}</p>
                        <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70 uppercase">Low</p>
                      </div>
                    </div>

                    <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-3">
                      <p className="text-xs font-medium text-primary/80 dark:text-white/80 uppercase tracking-wide mb-2">Recent Check History</p>
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {historyData.history.slice(0, 10).map((entry) => (
                          <div key={entry.id} className="flex items-center justify-between text-sm">
                            <span className="text-gray-600 dark:text-gray-400">
                              {new Date(entry.runAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-medium ${entry.totalIssues === 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-700 dark:text-gray-300'}`}>
                                {entry.totalIssues} issues
                              </span>
                              <span className="text-[10px] text-gray-500 dark:text-gray-500">
                                {entry.triggeredBy}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    icon="history"
                    title="No history available"
                    description="Run an integrity check to start tracking history."
                    variant="compact"
                  />
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">Failed to load history</p>
            )}
          </div>
        )}
      </div>

      <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
        <button
          onClick={() => setShowActivityLog(!showActivityLog)}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">assignment</span>
            <span className="font-bold text-primary dark:text-white">Activity Log</span>
          </div>
          <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showActivityLog ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>
        
        {showActivityLog && (
          <div className="mt-4">
            {isLoadingAuditLog ? (
              <div className="flex items-center justify-center py-4">
                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-gray-500">progress_activity</span>
              </div>
            ) : auditLog.length > 0 ? (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {auditLog.map((entry) => (
                  <div key={entry.id} className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                        entry.action === 'resolved' 
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
                          : entry.action === 'ignored'
                          ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                      }`}>
                        {entry.action}
                      </span>
                      <span className="text-[10px] text-gray-500 dark:text-gray-500">
                        {new Date(entry.actionAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-xs text-gray-700 dark:text-gray-300 font-mono truncate">{entry.issueKey}</p>
                    <p className="text-[10px] text-gray-500 dark:text-gray-500">by {entry.actionBy}</p>
                    {entry.notes && (
                      <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 italic">{entry.notes}</p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">No activity logged yet</p>
            )}
          </div>
        )}
      </div>

      {results.length > 0 && (
        <div className="space-y-3">
          {results.map((result) => {
            const metadata = getCheckMetadata(result.checkName);
            const displayTitle = metadata?.title || result.checkName;
            const description = metadata?.description;
            const checkSeverity = metadata?.severity || 'medium';
            const isExpanded = expandedChecks.has(result.checkName);
            
            return (
              <div
                key={result.checkName}
                className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl overflow-hidden"
              >
                <button
                  onClick={() => toggleCheck(result.checkName)}
                  className="w-full p-4 flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded ${getStatusColor(result.status)}`}>
                      {result.status}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-primary dark:text-white truncate">{displayTitle}</span>
                        <span className={`px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded ${getCheckSeverityColor(checkSeverity)}`}>
                          {checkSeverity}
                        </span>
                      </div>
                      {description && (
                        <p className="text-xs text-primary/60 dark:text-white/60 truncate">{description}</p>
                      )}
                    </div>
                    {result.issueCount > 0 && (
                      <span className="bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-2 py-0.5 text-xs font-bold rounded-full shrink-0">
                        {result.issueCount}
                      </span>
                    )}
                  </div>
                  <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ml-2 ${isExpanded ? 'rotate-180' : ''}`}>
                    expand_more
                  </span>
                </button>
                
                {isExpanded && result.issues.length > 0 && (
                  <div className="px-4 pb-4 space-y-3">
                    {renderCheckFixTools(result.checkName)}
                    
                    {result.issues.filter(i => !i.ignored).length > 3 && (
                      <div className="flex justify-end">
                        <button
                          onClick={() => openBulkIgnoreModal(result.checkName, result.issues)}
                          className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 flex items-center gap-1"
                        >
                          <span className="material-symbols-outlined text-[14px]">visibility_off</span>
                          Exclude All ({result.issues.filter(i => !i.ignored).length})
                        </button>
                      </div>
                    )}
                    
                    {Object.entries(groupByCategory(result.issues)).map(([category, categoryIssues]) => (
                      <div key={category} className="space-y-2">
                        <p className="text-xs font-medium text-primary/60 dark:text-white/60 uppercase tracking-wide">
                          {getCategoryLabel(category)} ({categoryIssues.length})
                        </p>
                        {categoryIssues.map((issue, idx) => {
                          const issueKey = `${issue.table}_${issue.recordId}`;
                          const isSyncing = syncingIssues.has(issueKey);
                          const tracking = getIssueTracking(issue);
                          const contextStr = formatContextString(issue.context);
                          
                          return (
                            <div
                              key={idx}
                              className={`p-3 rounded-lg border ${getSeverityColor(issue.severity)} ${issue.ignored ? 'opacity-50' : ''}`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
                                      {getSeverityIcon(issue.severity)}
                                    </span>
                                    <span className="font-medium text-sm">{issue.description}</span>
                                    {issue.ignored && issue.ignoreInfo && (
                                      <span className="text-[10px] bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded">
                                        Ignored until {new Date(issue.ignoreInfo.expiresAt).toLocaleDateString()}
                                      </span>
                                    )}
                                  </div>
                                  {contextStr && (
                                    <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">{contextStr}</p>
                                  )}
                                  {issue.suggestion && (
                                    <p className="text-xs text-gray-500 dark:text-gray-400 italic">{issue.suggestion}</p>
                                  )}
                                  {tracking && tracking.daysUnresolved > 0 && (
                                    <p className="text-[10px] text-orange-600 dark:text-orange-400 mt-1">
                                      Unresolved for {tracking.daysUnresolved} day{tracking.daysUnresolved === 1 ? '' : 's'}
                                    </p>
                                  )}
                                  
                                  {issue.context?.syncComparison && issue.context.syncComparison.length > 0 && (
                                    <div className="mt-2 bg-white/50 dark:bg-white/5 rounded p-2">
                                      <p className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1">Field Differences</p>
                                      <div className="space-y-1">
                                        {issue.context.syncComparison.map((comp, compIdx) => (
                                          <div key={compIdx} className="grid grid-cols-3 gap-2 text-[11px]">
                                            <span className="font-medium text-gray-700 dark:text-gray-300">{comp.field}</span>
                                            <span className="text-blue-600 dark:text-blue-400 truncate" title={String(comp.appValue)}>App: {String(comp.appValue)}</span>
                                            <span className="text-orange-600 dark:text-orange-400 truncate" title={String(comp.externalValue)}>External: {String(comp.externalValue)}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                                
                                <div className="flex items-center gap-1 shrink-0">
                                  {issue.context?.syncType && !issue.ignored && (
                                    <>
                                      <button
                                        onClick={() => handleSyncPush(issue)}
                                        disabled={isSyncing}
                                        className="p-1.5 text-blue-600 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-900/30 rounded transition-colors disabled:opacity-50"
                                        title="Push app data to external system"
                                      >
                                        {isSyncing ? (
                                          <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                                        ) : (
                                          <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                                        )}
                                      </button>
                                      <button
                                        onClick={() => handleSyncPull(issue)}
                                        disabled={isSyncing}
                                        className="p-1.5 text-orange-600 hover:bg-orange-100 dark:text-orange-400 dark:hover:bg-orange-900/30 rounded transition-colors disabled:opacity-50"
                                        title="Pull external data to app"
                                      >
                                        {isSyncing ? (
                                          <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                                        ) : (
                                          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
                                        )}
                                      </button>
                                    </>
                                  )}
                                  {issue.context?.memberEmail && (
                                    <button
                                      onClick={() => handleViewProfile(issue.context!.memberEmail!)}
                                      disabled={loadingMemberEmail === issue.context.memberEmail}
                                      className="p-1.5 text-primary hover:bg-primary/10 dark:text-white dark:hover:bg-white/10 rounded transition-colors disabled:opacity-50"
                                      title="View member profile"
                                    >
                                      {loadingMemberEmail === issue.context.memberEmail ? (
                                        <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                                      ) : (
                                        <span className="material-symbols-outlined text-[16px]">person</span>
                                      )}
                                    </button>
                                  )}
                                  {issue.table === 'booking_requests' && !issue.ignored && (
                                    <>
                                      {issue.context?.trackmanBookingId && (
                                        <button
                                          onClick={() => setTrackmanLinkModal({
                                            isOpen: true,
                                            bookingId: issue.recordId as number,
                                            bayName: issue.context?.resourceName,
                                            bookingDate: issue.context?.bookingDate,
                                            timeSlot: issue.context?.startTime,
                                            memberName: issue.context?.memberName,
                                            memberEmail: issue.context?.memberEmail,
                                            trackmanBookingId: issue.context?.trackmanBookingId,
                                            importedName: issue.context?.importedName,
                                            notes: issue.context?.notes,
                                            originalEmail: issue.context?.originalEmail
                                          })}
                                          className="p-1.5 text-green-600 hover:bg-green-100 dark:text-green-400 dark:hover:bg-green-900/30 rounded transition-colors"
                                          title="Review Unmatched Booking"
                                        >
                                          <span className="material-symbols-outlined text-[16px]">calendar_month</span>
                                        </button>
                                      )}
                                      <button
                                        onClick={() => handleCancelBooking(issue.recordId as number)}
                                        disabled={cancellingBookings.has(issue.recordId as number)}
                                        className="p-1.5 text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/30 rounded transition-colors disabled:opacity-50"
                                        title="Cancel this booking"
                                      >
                                        {cancellingBookings.has(issue.recordId as number) ? (
                                          <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                                        ) : (
                                          <span className="material-symbols-outlined text-[16px]">cancel</span>
                                        )}
                                      </button>
                                    </>
                                  )}
                                  {!issue.ignored && (
                                    <button
                                      onClick={() => openIgnoreModal(issue, result.checkName)}
                                      className="p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 rounded transition-colors"
                                      title="Ignore this issue"
                                    >
                                      <span className="material-symbols-outlined text-[16px]">visibility_off</span>
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {results.length > 0 && results.every(r => r.status === 'pass') && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-2xl">
          <EmptyState
            icon="verified"
            title="All Checks Passed!"
            description="No data integrity issues found."
            variant="compact"
          />
        </div>
      )}

      <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
        <button
          onClick={() => setShowIgnoredIssues(!showIgnoredIssues)}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">visibility_off</span>
            <span className="font-bold text-primary dark:text-white">Ignored Issues</span>
            {ignoredIssues.length > 0 && (
              <span className="bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 text-xs font-bold rounded-full">
                {ignoredIssues.filter(i => i.isActive).length}
              </span>
            )}
          </div>
          <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showIgnoredIssues ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>
        
        {showIgnoredIssues && (
          <div className="mt-4">
            {isLoadingIgnored ? (
              <div className="flex items-center justify-center py-4">
                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-gray-500">progress_activity</span>
              </div>
            ) : ignoredIssues.filter(i => i.isActive).length > 0 ? (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {ignoredIssues.filter(i => i.isActive).map((entry) => (
                  <div key={entry.id} className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate">{entry.issueKey}</p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-500">
                        {entry.reason} • Expires {new Date(entry.expiresAt).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      onClick={() => handleUnignoreIssue(entry.issueKey)}
                      className="p-1.5 text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/30 rounded transition-colors shrink-0"
                      title="Un-ignore this issue"
                    >
                      <span className="material-symbols-outlined text-[16px]">visibility</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">No ignored issues</p>
            )}
          </div>
        )}
      </div>

      <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
        <button
          onClick={() => setShowDataTools(!showDataTools)}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">build</span>
            <span className="font-bold text-primary dark:text-white">Data Tools</span>
          </div>
          <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showDataTools ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>
        
        {showDataTools && (
          <div className="mt-4 space-y-6">
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-primary dark:text-white">Resync Member</h4>
              <p className="text-xs text-gray-500 dark:text-gray-400">Force a full resync of a member's data from HubSpot and Stripe</p>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={resyncEmail}
                  onChange={(e) => setResyncEmail(e.target.value)}
                  placeholder="Enter member email"
                  className="flex-1 px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm"
                />
                <button
                  onClick={handleResyncMember}
                  disabled={isResyncing || !resyncEmail.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                >
                  {isResyncing && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                  Resync
                </button>
              </div>
              {resyncResult && (
                <p className={`text-xs ${resyncResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {resyncResult.message}
                </p>
              )}
            </div>

            <div className="border-t border-gray-200 dark:border-white/10 pt-4 space-y-3">
              <h4 className="text-sm font-medium text-primary dark:text-white">Reconcile Group Billing</h4>
              <p className="text-xs text-gray-500 dark:text-gray-400">Sync group billing members with Stripe subscription line items</p>
              <button
                onClick={handleReconcileGroupBilling}
                disabled={isReconciling}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {isReconciling && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Run Reconciliation
              </button>
              {reconcileResult && (
                <div className={`p-3 rounded-lg ${reconcileResult.success ? 'bg-green-50 dark:bg-green-900/20' : 'bg-yellow-50 dark:bg-yellow-900/20'}`}>
                  <p className="text-xs text-gray-700 dark:text-gray-300">
                    Checked {reconcileResult.groupsChecked} groups • 
                    Deactivated: {reconcileResult.membersDeactivated} • 
                    Reactivated: {reconcileResult.membersReactivated} • 
                    Created: {reconcileResult.membersCreated} • 
                    Relinked: {reconcileResult.itemsRelinked}
                  </p>
                  {reconcileResult.errors.length > 0 && (
                    <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                      {reconcileResult.errors.map((err, i) => <p key={i}>{err}</p>)}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="border-t border-gray-200 dark:border-white/10 pt-4 space-y-3">
              <h4 className="text-sm font-medium text-primary dark:text-white">Backfill Stripe Cache</h4>
              <p className="text-xs text-gray-500 dark:text-gray-400">Fetch and cache recent Stripe payments, charges, and invoices</p>
              <button
                onClick={handleBackfillStripeCache}
                disabled={isBackfillingStripeCache}
                className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {isBackfillingStripeCache && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Backfill Cache
              </button>
              {stripeCacheResult && (
                <p className={`text-xs ${stripeCacheResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {stripeCacheResult.message}
                </p>
              )}
            </div>

            <div className="border-t border-gray-200 dark:border-white/10 pt-4 space-y-3">
              <h4 className="text-sm font-medium text-primary dark:text-white">Detect Duplicates</h4>
              <p className="text-xs text-gray-500 dark:text-gray-400">Scan for duplicate members in the app and HubSpot</p>
              <button
                onClick={handleDetectDuplicates}
                disabled={isRunningDuplicateDetection}
                className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {isRunningDuplicateDetection && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Detect Duplicates
              </button>
              {duplicateDetectionResult && (
                <div className={`p-3 rounded-lg ${duplicateDetectionResult.success ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
                  <p className={`text-xs ${duplicateDetectionResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                    {duplicateDetectionResult.message}
                  </p>
                  {duplicateDetectionResult.appDuplicates && duplicateDetectionResult.appDuplicates.length > 0 && (
                    <div className="mt-2">
                      <button
                        onClick={() => setExpandedDuplicates(prev => ({ ...prev, app: !prev.app }))}
                        className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1"
                      >
                        <span className="material-symbols-outlined text-[14px]">{expandedDuplicates.app ? 'expand_less' : 'expand_more'}</span>
                        App Duplicates ({duplicateDetectionResult.appDuplicates.length})
                      </button>
                      {expandedDuplicates.app && (
                        <div className="mt-1 max-h-32 overflow-y-auto text-[11px] bg-white dark:bg-white/5 rounded p-2">
                          {duplicateDetectionResult.appDuplicates.map((dup: any, i: number) => (
                            <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                              {dup.email}: {dup.count} records
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {duplicateDetectionResult.hubspotDuplicates && duplicateDetectionResult.hubspotDuplicates.length > 0 && (
                    <div className="mt-2">
                      <button
                        onClick={() => setExpandedDuplicates(prev => ({ ...prev, hubspot: !prev.hubspot }))}
                        className="text-xs text-orange-600 dark:text-orange-400 flex items-center gap-1"
                      >
                        <span className="material-symbols-outlined text-[14px]">{expandedDuplicates.hubspot ? 'expand_less' : 'expand_more'}</span>
                        HubSpot Duplicates ({duplicateDetectionResult.hubspotDuplicates.length})
                      </button>
                      {expandedDuplicates.hubspot && (
                        <div className="mt-1 max-h-32 overflow-y-auto text-[11px] bg-white dark:bg-white/5 rounded p-2">
                          {duplicateDetectionResult.hubspotDuplicates.map((dup: any, i: number) => (
                            <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                              {dup.email}: {dup.count} contacts
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
        <button
          onClick={() => setShowPlaceholderCleanup(!showPlaceholderCleanup)}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">cleaning_services</span>
            <span className="font-bold text-primary dark:text-white">Placeholder Cleanup</span>
          </div>
          <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showPlaceholderCleanup ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>
        
        {showPlaceholderCleanup && (
          <div className="mt-4 space-y-4">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Scan for and remove placeholder accounts in Stripe and HubSpot (e.g., test@placeholder.com)
            </p>
            
            <button
              onClick={handleScanPlaceholders}
              disabled={isLoadingPlaceholders}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
            >
              {isLoadingPlaceholders && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
              Scan for Placeholders
            </button>
            
            {placeholderAccounts && (
              <div className="space-y-3">
                <div className="grid grid-cols-4 gap-2 text-center">
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2">
                    <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{placeholderAccounts.totals.stripe}</p>
                    <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70 uppercase">Stripe</p>
                  </div>
                  <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-2">
                    <p className="text-lg font-bold text-orange-600 dark:text-orange-400">{placeholderAccounts.totals.hubspot}</p>
                    <p className="text-[10px] text-orange-600/70 dark:text-orange-400/70 uppercase">HubSpot</p>
                  </div>
                  <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-2">
                    <p className="text-lg font-bold text-green-600 dark:text-green-400">{placeholderAccounts.totals.localDatabase}</p>
                    <p className="text-[10px] text-green-600/70 dark:text-green-400/70 uppercase">Database</p>
                  </div>
                  <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-2">
                    <p className="text-lg font-bold text-purple-600 dark:text-purple-400">{placeholderAccounts.totals.total}</p>
                    <p className="text-[10px] text-purple-600/70 dark:text-purple-400/70 uppercase">Total</p>
                  </div>
                </div>
                
                {placeholderAccounts.totals.total > 0 && (
                  <>
                    {!showDeleteConfirm ? (
                      <button
                        onClick={() => setShowDeleteConfirm(true)}
                        className="w-full px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:opacity-90 flex items-center justify-center gap-2"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete_forever</span>
                        Delete All Placeholders
                      </button>
                    ) : (
                      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg p-3">
                        <p className="text-sm text-red-700 dark:text-red-400 mb-3">
                          Are you sure you want to delete {placeholderAccounts.totals.total} placeholder accounts?
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setShowDeleteConfirm(false)}
                            className="flex-1 px-3 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleDeletePlaceholders}
                            disabled={isDeletingPlaceholders}
                            className="flex-1 px-3 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                          >
                            {isDeletingPlaceholders && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                            Confirm Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            
            {placeholderDeleteResult && (
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg p-3">
                <p className="text-sm text-green-700 dark:text-green-400">
                  Deleted: Stripe {placeholderDeleteResult.stripeDeleted}, HubSpot {placeholderDeleteResult.hubspotDeleted}, Database {placeholderDeleteResult.localDatabaseDeleted}
                  {(placeholderDeleteResult.stripeFailed > 0 || placeholderDeleteResult.hubspotFailed > 0 || placeholderDeleteResult.localDatabaseFailed > 0) && (
                    <span className="text-red-600 dark:text-red-400">
                      {' '}• Failed: Stripe {placeholderDeleteResult.stripeFailed}, HubSpot {placeholderDeleteResult.hubspotFailed}, Database {placeholderDeleteResult.localDatabaseFailed}
                    </span>
                  )}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {ignoreModal.isOpen && ignoreModal.issue && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-primary dark:text-white">Ignore Issue</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">{ignoreModal.issue.description}</p>
            
            <div className="space-y-3">
              <label className="block text-sm font-medium text-primary dark:text-white">Duration</label>
              <div className="flex gap-2">
                {(['24h', '1w', '30d'] as const).map((dur) => (
                  <button
                    key={dur}
                    onClick={() => setIgnoreDuration(dur)}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                      ignoreDuration === dur
                        ? 'bg-primary dark:bg-white text-white dark:text-primary'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {dur === '24h' ? '24 Hours' : dur === '1w' ? '1 Week' : '30 Days'}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="space-y-2">
              <label className="block text-sm font-medium text-primary dark:text-white">Reason</label>
              <textarea
                value={ignoreReason}
                onChange={(e) => setIgnoreReason(e.target.value)}
                placeholder="Why are you ignoring this issue?"
                className="w-full px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm resize-none"
                rows={3}
              />
            </div>
            
            <div className="flex gap-2 pt-2">
              <button
                onClick={closeIgnoreModal}
                className="flex-1 py-2 px-4 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleIgnoreIssue}
                disabled={isIgnoring || !ignoreReason.trim()}
                className="flex-1 py-2 px-4 bg-primary dark:bg-white text-white dark:text-primary rounded-lg text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isIgnoring && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Ignore Issue
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkIgnoreModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-primary dark:text-white">Exclude All Issues</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Exclude {bulkIgnoreModal.issues.length} issues from "{bulkIgnoreModal.checkName}"
            </p>
            
            <div className="space-y-3">
              <label className="block text-sm font-medium text-primary dark:text-white">Duration</label>
              <div className="flex gap-2">
                {(['24h', '1w', '30d'] as const).map((dur) => (
                  <button
                    key={dur}
                    onClick={() => setIgnoreDuration(dur)}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                      ignoreDuration === dur
                        ? 'bg-primary dark:bg-white text-white dark:text-primary'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {dur === '24h' ? '24 Hours' : dur === '1w' ? '1 Week' : '30 Days'}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="space-y-2">
              <label className="block text-sm font-medium text-primary dark:text-white">Reason</label>
              <textarea
                value={ignoreReason}
                onChange={(e) => setIgnoreReason(e.target.value)}
                placeholder="Why are you excluding these issues?"
                className="w-full px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm resize-none"
                rows={3}
              />
            </div>
            
            <div className="flex gap-2 pt-2">
              <button
                onClick={closeBulkIgnoreModal}
                className="flex-1 py-2 px-4 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkIgnore}
                disabled={isBulkIgnoring || !ignoreReason.trim()}
                className="flex-1 py-2 px-4 bg-primary dark:bg-white text-white dark:text-primary rounded-lg text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isBulkIgnoring && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Exclude All
              </button>
            </div>
          </div>
        </div>
      )}

      <MemberProfileDrawer
        isOpen={isProfileDrawerOpen}
        member={selectedMember}
        isAdmin={true}
        onClose={() => {
          setIsProfileDrawerOpen(false);
          setSelectedMember(null);
        }}
        onViewAs={() => {}}
        onMemberDeleted={() => {
          setIsProfileDrawerOpen(false);
          setSelectedMember(null);
          runIntegrityMutation.mutate();
        }}
      />

      <TrackmanLinkModal
        isOpen={trackmanLinkModal.isOpen}
        onClose={() => setTrackmanLinkModal({ isOpen: false, bookingId: null })}
        trackmanBookingId={trackmanLinkModal.trackmanBookingId || null}
        bayName={trackmanLinkModal.bayName}
        bookingDate={trackmanLinkModal.bookingDate}
        timeSlot={trackmanLinkModal.timeSlot}
        matchedBookingId={trackmanLinkModal.bookingId || undefined}
        currentMemberName={trackmanLinkModal.memberName}
        currentMemberEmail={trackmanLinkModal.memberEmail}
        importedName={trackmanLinkModal.importedName}
        notes={trackmanLinkModal.notes}
        originalEmail={trackmanLinkModal.originalEmail}
        onSuccess={() => {
          setTrackmanLinkModal({ isOpen: false, bookingId: null });
          runIntegrityMutation.mutate();
        }}
      />
    </div>
  );
};

export default DataIntegrityTab;
