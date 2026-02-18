import React, { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../../components/Toast';
import EmptyState from '../../../components/EmptyState';
import { sortBySeverity } from '../../../data/integrityCheckMetadata';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials } from '../../../hooks/queries/useFetch';
import MemberProfileDrawer from '../../../components/MemberProfileDrawer';
import { UnifiedBookingSheet } from '../../../components/staff-command-center/modals/UnifiedBookingSheet';
import type { MemberProfile } from '../../../types/data';
import type {
  SystemHealth,
  IntegrityIssue,
  CalendarStatusResponse,
  HistoryData,
  AuditLogEntry,
  IgnoredIssueEntry,
  IgnoreModalState,
  BulkIgnoreModalState,
  CachedResultsResponse,
  IntegrityRunResponse,
} from './dataIntegrity/dataIntegrityTypes';
import { formatTimeAgo, getTrendIcon, getTrendColor, downloadCSV } from './dataIntegrity/dataIntegrityUtils';
import IntegrityResultsPanel from './dataIntegrity/IntegrityResultsPanel';
import SyncToolsPanel from './dataIntegrity/SyncToolsPanel';
import CleanupToolsPanel from './dataIntegrity/CleanupToolsPanel';
import SchedulerMonitorPanel from './dataIntegrity/SchedulerMonitorPanel';
import WebhookEventsPanel from './dataIntegrity/WebhookEventsPanel';
import JobQueuePanel from './dataIntegrity/JobQueuePanel';
import HubSpotQueuePanel from './dataIntegrity/HubSpotQueuePanel';
import AlertHistoryPanel from './dataIntegrity/AlertHistoryPanel';
import IgnoreModals from './dataIntegrity/IgnoreModals';


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
}

interface PlaceholderAccount {
  email: string;
  name?: string;
  source?: string;
  createdAt?: string;
}

interface BackgroundJobStatus {
  hasJob: boolean;
  job?: { id: string; status: string; progress?: number; result?: unknown };
}

interface MemberDetails {
  email: string;
  name?: string;
  tier?: string;
  [key: string]: unknown;
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
  const [showSchedulerMonitor, setShowSchedulerMonitor] = useState(false);
  const [showWebhookEvents, setShowWebhookEvents] = useState(false);
  const [showJobQueue, setShowJobQueue] = useState(false);
  const [showHubSpotQueue, setShowHubSpotQueue] = useState(false);
  const [showAlertHistory, setShowAlertHistory] = useState(false);
  const [resyncEmail, setResyncEmail] = useState('');
  const [resyncResult, setResyncResult] = useState<{ success: boolean; message: string } | null>(null);

  const [guestFeeStartDate, setGuestFeeStartDate] = useState('');
  const [guestFeeEndDate, setGuestFeeEndDate] = useState('');
  const [unlinkedGuestFees, setUnlinkedGuestFees] = useState<UnlinkedGuestFee[] | AvailableSession[] | AttendanceBooking[]>([]);
  const [availableSessions, setAvailableSessions] = useState<UnlinkedGuestFee[] | AvailableSession[] | AttendanceBooking[]>([]);
  const [selectedFeeId, setSelectedFeeId] = useState<number | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);

  const [attendanceSearchDate, setAttendanceSearchDate] = useState('');
  const [attendanceSearchEmail, setAttendanceSearchEmail] = useState('');
  const [attendanceBookings, setAttendanceBookings] = useState<UnlinkedGuestFee[] | AvailableSession[] | AttendanceBooking[]>([]);
  const [updatingAttendanceId, setUpdatingAttendanceId] = useState<number | null>(null);
  const [attendanceNote, setAttendanceNote] = useState('');

  const [mindbodyStartDate, setMindbodyStartDate] = useState('');
  const [mindbodyEndDate, setMindbodyEndDate] = useState('');
  const [mindbodyResult, setMindbodyResult] = useState<{ success: boolean; message: string } | null>(null);

  const [hubspotSyncResult, setHubspotSyncResult] = useState<{ success: boolean; message: string; members?: HubspotSyncMember[]; dryRun?: boolean } | null>(null);
  const [mindbodyCleanupResult, setMindbodyCleanupResult] = useState<{ success: boolean; message: string; toClean?: number; dryRun?: boolean } | null>(null);
  const [stripeCleanupResult, setStripeCleanupResult] = useState<{ 
    success: boolean; 
    message: string; 
    dryRun?: boolean;
    totalCustomers?: number;
    emptyCount?: number;
    skippedActiveCount?: number;
    customers?: Array<{ id: string; email: string | null; name: string | null; created: string }>;
    deleted?: Array<{ id: string; email: string | null }>;
    deletedCount?: number;
  } | null>(null);

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

  const [stripeCacheResult, setStripeCacheResult] = useState<{ success: boolean; message: string; stats?: StripeCacheStats } | null>(null);

  const [showSyncTools, setShowSyncTools] = useState(true);
  const [subscriptionStatusResult, setSubscriptionStatusResult] = useState<{ success: boolean; message: string; totalChecked?: number; mismatchCount?: number; updated?: SubscriptionUpdate[]; dryRun?: boolean } | null>(null);
  const [orphanedStripeResult, setOrphanedStripeResult] = useState<{ success: boolean; message: string; totalChecked?: number; orphanedCount?: number; cleared?: OrphanedStripeRecord[]; dryRun?: boolean } | null>(null);
  const [stripeHubspotLinkResult, setStripeHubspotLinkResult] = useState<{ success: boolean; message: string; stripeOnlyMembers?: StripeHubspotMember[]; hubspotOnlyMembers?: StripeHubspotMember[]; linkedCount?: number; dryRun?: boolean } | null>(null);
  const [paymentStatusResult, setPaymentStatusResult] = useState<{ success: boolean; message: string; totalChecked?: number; updatedCount?: number; updates?: PaymentUpdate[]; dryRun?: boolean } | null>(null);
  const [visitCountResult, setVisitCountResult] = useState<{ success: boolean; message: string; mismatchCount?: number; updatedCount?: number; sampleMismatches?: VisitMismatch[]; dryRun?: boolean } | null>(null);
  const [ghostBookingResult, setGhostBookingResult] = useState<{ success: boolean; message: string; ghostBookings?: number; fixed?: number; dryRun?: boolean; errors?: Array<{ bookingId: number; error: string }> } | null>(null);
  const [orphanedParticipantResult, setOrphanedParticipantResult] = useState<{ success: boolean; message: string; relinked?: number; converted?: number; total?: number; dryRun?: boolean; relinkedDetails?: OrphanedParticipantDetail[]; convertedDetails?: OrphanedParticipantDetail[] } | null>(null);
  const [reviewItemsResult, setReviewItemsResult] = useState<{ success: boolean; message: string; wellnessCount?: number; eventCount?: number; total?: number; dryRun?: boolean } | null>(null);
  const [duplicateDetectionResult, setDuplicateDetectionResult] = useState<{ success: boolean; message: string; appDuplicates?: DuplicateRecord[]; hubspotDuplicates?: DuplicateRecord[] } | null>(null);
  const [expandedDuplicates, setExpandedDuplicates] = useState<{ app: boolean; hubspot: boolean }>({ app: false, hubspot: false });
  const [dealStageRemediationResult, setDealStageRemediationResult] = useState<{ success: boolean; message: string; total?: number; fixed?: number; dryRun?: boolean } | null>(null);

  const [selectedMember, setSelectedMember] = useState<MemberProfile | null>(null);
  const [isProfileDrawerOpen, setIsProfileDrawerOpen] = useState(false);
  const [loadingMemberEmail, setLoadingMemberEmail] = useState<string | null>(null);
  
  const [bookingSheet, setBookingSheet] = useState<{
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
    isUnmatched?: boolean;
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
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to ignore issue', 'error');
    },
  });

  const unignoreIssueMutation = useMutation({
    mutationFn: (issueKey: string) => 
      deleteWithCredentials<{ success: boolean }>(`/api/data-integrity/ignore/${encodeURIComponent(issueKey)}`),
    onSuccess: () => {
      showToast('Issue un-ignored successfully', 'success');
      queryClient.invalidateQueries({ queryKey: ['data-integrity', 'ignores'] });
      runIntegrityMutation.mutate();
    },
    onError: (err: Error) => {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to un-ignore issue', 'error');
    },
  });

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
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to exclude issues', 'error');
    },
  });

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
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to push sync', 'error');
    },
  });

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
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to pull sync', 'error');
    },
  });

  const resyncMemberMutation = useMutation({
    mutationFn: (email: string) => 
      postWithCredentials<{ message: string }>('/api/data-tools/resync-member', { email }),
    onSuccess: (data) => {
      setResyncResult({ success: true, message: data.message });
      showToast(data.message, 'success');
      setResyncEmail('');
    },
    onError: (err: Error) => {
      setResyncResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to resync member' });
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
      setReconcileResult(data);
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
      setUnlinkedGuestFees(data);
    },
    onError: () => {
      showToast('Failed to search guest fees', 'error');
    },
  });

  const loadSessionsMutation = useMutation({
    mutationFn: (params: { date: string; memberEmail: string }) => 
      fetchWithCredentials<AvailableSession[]>(`/api/data-tools/available-sessions?date=${params.date}&memberEmail=${params.memberEmail || ''}`),
    onSuccess: (data) => {
      setAvailableSessions(data);
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
      setUnlinkedGuestFees(prev => prev.filter(f => f.id !== selectedFeeId));
      setSelectedFeeId(null);
      setSelectedSessionId(null);
      setAvailableSessions([]);
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
      setAttendanceBookings(data);
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
      setAttendanceBookings(prev => prev.map(b => 
        b.id === variables.bookingId 
          ? { ...b, reconciliationStatus: variables.attendanceStatus, reconciliationNotes: variables.notes } 
          : b
      ));
      setAttendanceNote('');
      setUpdatingAttendanceId(null);
    },
    onError: (err: Error) => {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to update attendance', 'error');
      setUpdatingAttendanceId(null);
    },
  });

  const mindbodyReimportMutation = useMutation({
    mutationFn: (params: { startDate: string; endDate: string }) => 
      postWithCredentials<{ message: string }>('/api/data-tools/mindbody-reimport', params),
    onSuccess: (data) => {
      setMindbodyResult({ success: true, message: data.message });
      showToast(data.message, 'success');
    },
    onError: (err: Error) => {
      setMindbodyResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to queue reimport' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to queue reimport', 'error');
    },
  });

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
      setCsvUploadResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Import failed' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to upload CSV files', 'error');
    },
  });

  const backfillStripeCacheMutation = useMutation({
    mutationFn: () => 
      postWithCredentials<{ stats?: StripeCacheStats }>('/api/financials/backfill-stripe-cache', {}),
    onSuccess: (data) => {
      const msg = `Backfilled ${data.stats?.paymentIntents || 0} payments, ${data.stats?.charges || 0} charges, ${data.stats?.invoices || 0} invoices`;
      setStripeCacheResult({ success: true, message: msg, stats: data.stats });
      showToast(msg, 'success');
    },
    onError: (err: Error) => {
      setStripeCacheResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to backfill cache' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to backfill cache', 'error');
    },
  });

  const syncMembersToHubspotMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message: string; members?: HubspotSyncMember[]; syncedCount?: number; totalSynced?: number }>('/api/data-tools/bulk-push-to-hubspot', { dryRun }),
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
      setHubspotSyncResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to sync to HubSpot' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to sync to HubSpot', 'error');
    },
  });

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
      setMindbodyCleanupResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to cleanup Mind Body IDs' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to cleanup Mind Body IDs', 'error');
    },
  });

  const fixIssueMutation = useMutation({
    mutationFn: (params: { endpoint: string; body: Record<string, any> }) =>
      postWithCredentials<{ success: boolean; message: string }>(params.endpoint, params.body),
    onSuccess: (data) => {
      showToast(data.message || 'Issue fixed successfully', 'success');
      queryClient.invalidateQueries({ queryKey: ['data-integrity'] });
      runIntegrityMutation.mutate();
    },
    onError: (err: unknown) => {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to fix issue', 'error');
    }
  });

  const [isRunningVisitorArchive, setIsRunningVisitorArchive] = useState(false);
  const [visitorArchiveProgress, setVisitorArchiveProgress] = useState<{
    phase: string;
    totalVisitors: number;
    checked: number;
    eligibleCount: number;
    keptCount: number;
    archived: number;
    errors: number;
  } | null>(null);
  const [visitorArchiveResult, setVisitorArchiveResult] = useState<{
    success: boolean;
    message: string;
    dryRun?: boolean;
    totalScanned?: number;
    eligibleCount?: number;
    keptCount?: number;
    archivedCount?: number;
    sampleArchived?: Array<{ name: string; email: string }>;
  } | null>(null);

  const [isRunningStripeCleanup, setIsRunningStripeCleanup] = useState(false);
  const [stripeCleanupProgress, setStripeCleanupProgress] = useState<{
    phase: string;
    totalCustomers: number;
    checked: number;
    emptyFound: number;
    skippedActiveCount: number;
    deleted: number;
    errors: number;
  } | null>(null);

  useEffect(() => {
    const handleProgress = (event: CustomEvent) => {
      const { data, result, error } = event.detail || {};
      if (data) {
        setStripeCleanupProgress(data);
      }
      if (data?.phase === 'done') {
        setIsRunningStripeCleanup(false);
        if (result) {
          setStripeCleanupResult({
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
          setStripeCleanupResult({ success: false, message: error });
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
    if (!isRunningStripeCleanup) return;
    const interval = setInterval(async () => {
      try {
        const statusData = await fetchWithCredentials<BackgroundJobStatus>('/api/data-tools/cleanup-stripe-customers/status');
        if (statusData.hasJob && statusData.job) {
          setStripeCleanupProgress(statusData.job.progress);
          if (statusData.job.status === 'completed') {
            setIsRunningStripeCleanup(false);
            setStripeCleanupProgress(null);
            const r = statusData.job.result;
            if (r) {
              setStripeCleanupResult({
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
            setIsRunningStripeCleanup(false);
            setStripeCleanupProgress(null);
            setStripeCleanupResult({ success: false, message: statusData.job.error || 'Job failed' });
          }
        } else if (!statusData.hasJob) {
          setIsRunningStripeCleanup(false);
          setStripeCleanupProgress(null);
          setStripeCleanupResult({ success: false, message: 'Job was lost (server may have restarted). Please try again.' });
        }
      } catch {
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isRunningStripeCleanup]);

  useEffect(() => {
    const handleProgress = (event: CustomEvent) => {
      const { data, result, error } = event.detail || {};
      if (data) {
        setVisitorArchiveProgress(data);
      }
      if (data?.phase === 'done') {
        setIsRunningVisitorArchive(false);
        if (result) {
          setVisitorArchiveResult({
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
          setVisitorArchiveResult({ success: false, message: error });
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
    if (!isRunningVisitorArchive) return;
    const interval = setInterval(async () => {
      try {
        const statusData = await fetchWithCredentials<BackgroundJobStatus>('/api/data-tools/archive-stale-visitors/status');
        if (statusData.hasJob && statusData.job) {
          setVisitorArchiveProgress(statusData.job.progress);
          if (statusData.job.status === 'completed') {
            setIsRunningVisitorArchive(false);
            setVisitorArchiveProgress(null);
            const r = statusData.job.result;
            if (r) {
              setVisitorArchiveResult({
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
            setIsRunningVisitorArchive(false);
            setVisitorArchiveProgress(null);
            setVisitorArchiveResult({ success: false, message: statusData.job.error || 'Job failed' });
          }
        } else if (!statusData.hasJob) {
          setIsRunningVisitorArchive(false);
          setVisitorArchiveProgress(null);
          setVisitorArchiveResult({ success: false, message: 'Job was lost (server may have restarted). Please try again.' });
        }
      } catch {
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isRunningVisitorArchive]);

  const syncSubscriptionStatusMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; totalChecked?: number; mismatchCount?: number; updated?: SubscriptionUpdate[]; updatedCount?: number }>('/api/data-tools/sync-subscription-status', { dryRun }),
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
      setSubscriptionStatusResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to sync subscription status' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to sync subscription status', 'error');
    },
  });

  const clearOrphanedStripeIdsMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; totalChecked?: number; orphanedCount?: number; cleared?: OrphanedStripeRecord[]; clearedCount?: number }>('/api/data-tools/clear-orphaned-stripe-ids', { dryRun }),
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
      setOrphanedStripeResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to clear orphaned Stripe IDs' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to clear orphaned Stripe IDs', 'error');
    },
  });

  const linkStripeHubspotMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; stripeOnlyMembers?: StripeHubspotMember[]; hubspotOnlyMembers?: StripeHubspotMember[]; linkedCount?: number }>('/api/data-tools/link-stripe-hubspot', { dryRun }),
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
      setStripeHubspotLinkResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to link Stripe and HubSpot' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to link Stripe and HubSpot', 'error');
    },
  });

  const syncPaymentStatusMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; totalChecked?: number; updatedCount?: number; updates?: PaymentUpdate[] }>('/api/data-tools/sync-payment-status', { dryRun }),
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
      setPaymentStatusResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to sync payment status' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to sync payment status', 'error');
    },
  });

  const syncVisitCountsMutation = useMutation({
    mutationFn: (dryRun: boolean) => 
      postWithCredentials<{ message?: string; mismatchCount?: number; updatedCount?: number; sampleMismatches?: VisitMismatch[] }>('/api/data-tools/sync-visit-counts', { dryRun }),
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
      setVisitCountResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to sync visit counts' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to sync visit counts', 'error');
    },
  });

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
      setGhostBookingResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to preview' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to preview', 'error');
    },
  });

  const fixGhostBookingsMutation = useMutation({
    mutationFn: () => postWithCredentials<{ message?: string; sessionsCreated?: number; sessionsLinked?: number; totalProcessed?: number; errorsCount?: number; errors?: Array<{ bookingId: number; error: string }> }>('/api/admin/backfill-sessions', {}),
    onSuccess: (data) => {
      const hasErrors = data.errorsCount && data.errorsCount > 0;
      setGhostBookingResult({
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
      setGhostBookingResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to create sessions' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to create sessions', 'error');
    },
  });

  const fixOrphanedParticipantsMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      postWithCredentials<{ message?: string; relinked?: number; converted?: number; total?: number; dryRun?: boolean; relinkedDetails?: OrphanedParticipantDetail[]; convertedDetails?: OrphanedParticipantDetail[] }>('/api/data-integrity/fix/fix-orphaned-participants', { dryRun }),
    onSuccess: (data, dryRun) => {
      setOrphanedParticipantResult({
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
      setOrphanedParticipantResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to fix', 'error');
    },
  });

  const approveAllReviewItemsMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      postWithCredentials<{ message?: string; wellnessCount?: number; eventCount?: number; total?: number; dryRun?: boolean }>('/api/data-integrity/fix/approve-all-review-items', { dryRun }),
    onSuccess: (data, dryRun) => {
      setReviewItemsResult({
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
      setReviewItemsResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed', 'error');
    },
  });

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
      setDealStageRemediationResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to remediate deal stages' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to remediate deal stages', 'error');
    },
  });

  const detectDuplicatesMutation = useMutation({
    mutationFn: () => 
      postWithCredentials<{ message?: string; appDuplicates?: DuplicateRecord[]; hubspotDuplicates?: DuplicateRecord[] }>('/api/data-tools/detect-duplicates', {}),
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
      setDuplicateDetectionResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to detect duplicates' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to detect duplicates', 'error');
    },
  });

  const scanPlaceholdersMutation = useMutation({
    mutationFn: () => 
      fetchWithCredentials<{ success: boolean; stripeCustomers?: PlaceholderAccount[]; hubspotContacts?: PlaceholderAccount[]; localDatabaseUsers?: PlaceholderAccount[]; totals?: { stripe: number; hubspot: number; localDatabase: number; total: number } }>('/api/data-integrity/placeholder-accounts'),
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
      const response = await fetchWithCredentials<MemberDetails>(`/api/members/${encodeURIComponent(email)}/details`);
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
    } catch (error: unknown) {
      showToast((error instanceof Error ? error.message : String(error)) || 'Failed to load member profile', 'error');
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
    } catch (error: unknown) {
      showToast((error instanceof Error ? error.message : String(error)) || 'Failed to check system health', 'error');
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

  const handleLoadSessionsForFee = (fee: UnlinkedGuestFee) => {
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

  const handleArchiveStaleVisitors = async (dryRun: boolean = true) => {
    setVisitorArchiveResult(null);
    setVisitorArchiveProgress(null);
    try {
      await postWithCredentials('/api/data-tools/archive-stale-visitors', { dryRun });
      setIsRunningVisitorArchive(true);
    } catch (err: unknown) {
      setVisitorArchiveResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to start archive job' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to start archive job', 'error');
    }
  };

  const handleCleanupStripeCustomers = async (dryRun: boolean = true) => {
    setStripeCleanupResult(null);
    setStripeCleanupProgress(null);
    try {
      await postWithCredentials('/api/data-tools/cleanup-stripe-customers', { dryRun });
      setIsRunningStripeCleanup(true);
    } catch (err: unknown) {
      setStripeCleanupResult({ success: false, message: (err instanceof Error ? err.message : String(err)) || 'Failed to start cleanup job' });
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to start cleanup job', 'error');
    }
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

  const handleFixOrphanedParticipants = (dryRun: boolean = true) => {
    setOrphanedParticipantResult(null);
    fixOrphanedParticipantsMutation.mutate(dryRun);
  };

  const handleApproveAllReviewItems = (dryRun: boolean = true) => {
    setReviewItemsResult(null);
    approveAllReviewItemsMutation.mutate(dryRun);
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
  const isRunningOrphanedParticipantFix = fixOrphanedParticipantsMutation.isPending;
  const isRunningReviewItemsApproval = approveAllReviewItemsMutation.isPending;
  const isRunningDealStageRemediation = remediateDealStagesMutation.isPending;
  const isRunningDuplicateDetection = detectDuplicatesMutation.isPending;
  const isLoadingPlaceholders = scanPlaceholdersMutation.isPending;
  const isDeletingPlaceholders = deletePlaceholdersMutation.isPending;
  const isRunningStripeCustomerCleanup = isRunningStripeCleanup;

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

  const getIssueTrackingForIssue = (issue: IntegrityIssue) => {
    if (!historyData) return undefined;
    const issueKey = `${issue.table}_${issue.recordId}`;
    return historyData.activeIssues.find(ai => ai.issueKey === issueKey);
  };

  const errorCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'error').length, 0);
  const warningCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'warning').length, 0);
  const infoCount = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'info').length, 0);

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
            className="tactile-btn px-4 py-2 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-lg font-medium text-sm flex items-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
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
            className="tactile-btn flex-1 py-3 px-4 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-xl font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
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
              onClick={() => downloadCSV(results)}
              disabled={!hasIssues}
              className="tactile-btn py-3 px-4 border-2 border-primary dark:border-white/40 text-primary dark:text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
          className="tactile-row flex items-center justify-between w-full text-left"
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
          className="tactile-row flex items-center justify-between w-full text-left"
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
          className="tactile-row flex items-center justify-between w-full text-left"
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

      <IntegrityResultsPanel
        results={results}
        expandedChecks={expandedChecks}
        toggleCheck={toggleCheck}
        syncingIssues={syncingIssues}
        handleSyncPush={handleSyncPush}
        handleSyncPull={handleSyncPull}
        cancellingBookings={cancellingBookings}
        handleCancelBooking={handleCancelBooking}
        loadingMemberEmail={loadingMemberEmail}
        handleViewProfile={handleViewProfile}
        setBookingSheet={setBookingSheet}
        fixIssueMutation={fixIssueMutation}
        openIgnoreModal={openIgnoreModal}
        openBulkIgnoreModal={openBulkIgnoreModal}
        getIssueTracking={getIssueTrackingForIssue}
        isSyncingToHubspot={isSyncingToHubspot}
        hubspotSyncResult={hubspotSyncResult}
        handleSyncMembersToHubspot={handleSyncMembersToHubspot}
        isRunningSubscriptionSync={isRunningSubscriptionSync}
        subscriptionStatusResult={subscriptionStatusResult}
        handleSyncSubscriptionStatus={handleSyncSubscriptionStatus}
        isRunningOrphanedStripeCleanup={isRunningOrphanedStripeCleanup}
        orphanedStripeResult={orphanedStripeResult}
        handleClearOrphanedStripeIds={handleClearOrphanedStripeIds}
        isRunningStripeCustomerCleanup={isRunningStripeCustomerCleanup}
        stripeCleanupResult={stripeCleanupResult}
        handleCleanupStripeCustomers={handleCleanupStripeCustomers}
        stripeCleanupProgress={stripeCleanupProgress}
        isRunningGhostBookingFix={isRunningGhostBookingFix}
        ghostBookingResult={ghostBookingResult}
        handleFixGhostBookings={handleFixGhostBookings}
        isCleaningMindbodyIds={isCleaningMindbodyIds}
        mindbodyCleanupResult={mindbodyCleanupResult}
        handleCleanupMindbodyIds={handleCleanupMindbodyIds}
        isRunningDealStageRemediation={isRunningDealStageRemediation}
        dealStageRemediationResult={dealStageRemediationResult}
        handleRemediateDealStages={handleRemediateDealStages}
        isRunningStripeHubspotLink={isRunningStripeHubspotLink}
        stripeHubspotLinkResult={stripeHubspotLinkResult}
        handleLinkStripeHubspot={handleLinkStripeHubspot}
        isRunningPaymentStatusSync={isRunningPaymentStatusSync}
        paymentStatusResult={paymentStatusResult}
        handleSyncPaymentStatus={handleSyncPaymentStatus}
        isRunningVisitCountSync={isRunningVisitCountSync}
        visitCountResult={visitCountResult}
        handleSyncVisitCounts={handleSyncVisitCounts}
        handleArchiveStaleVisitors={handleArchiveStaleVisitors}
        isRunningVisitorArchive={isRunningVisitorArchive}
        visitorArchiveResult={visitorArchiveResult}
        visitorArchiveProgress={visitorArchiveProgress}
        isRunningOrphanedParticipantFix={isRunningOrphanedParticipantFix}
        orphanedParticipantResult={orphanedParticipantResult}
        handleFixOrphanedParticipants={handleFixOrphanedParticipants}
        isRunningReviewItemsApproval={isRunningReviewItemsApproval}
        reviewItemsResult={reviewItemsResult}
        handleApproveAllReviewItems={handleApproveAllReviewItems}
      />

      <SyncToolsPanel
        showDataTools={showDataTools}
        setShowDataTools={setShowDataTools}
        resyncEmail={resyncEmail}
        setResyncEmail={setResyncEmail}
        handleResyncMember={handleResyncMember}
        isResyncing={isResyncing}
        resyncResult={resyncResult}
        handleReconcileGroupBilling={handleReconcileGroupBilling}
        isReconciling={isReconciling}
        reconcileResult={reconcileResult}
        handleBackfillStripeCache={handleBackfillStripeCache}
        isBackfillingStripeCache={isBackfillingStripeCache}
        stripeCacheResult={stripeCacheResult}
        handleDetectDuplicates={handleDetectDuplicates}
        isRunningDuplicateDetection={isRunningDuplicateDetection}
        duplicateDetectionResult={duplicateDetectionResult}
        expandedDuplicates={expandedDuplicates}
        setExpandedDuplicates={setExpandedDuplicates}
        handleCleanupStripeCustomers={handleCleanupStripeCustomers}
        isRunningStripeCustomerCleanup={isRunningStripeCustomerCleanup}
        stripeCleanupResult={stripeCleanupResult}
        stripeCleanupProgress={stripeCleanupProgress}
        handleArchiveStaleVisitors={handleArchiveStaleVisitors}
        isRunningVisitorArchive={isRunningVisitorArchive}
        visitorArchiveResult={visitorArchiveResult}
        visitorArchiveProgress={visitorArchiveProgress}
      />

      <CleanupToolsPanel
        showPlaceholderCleanup={showPlaceholderCleanup}
        setShowPlaceholderCleanup={setShowPlaceholderCleanup}
        handleScanPlaceholders={handleScanPlaceholders}
        isLoadingPlaceholders={isLoadingPlaceholders}
        placeholderAccounts={placeholderAccounts}
        showDeleteConfirm={showDeleteConfirm}
        setShowDeleteConfirm={setShowDeleteConfirm}
        handleDeletePlaceholders={handleDeletePlaceholders}
        isDeletingPlaceholders={isDeletingPlaceholders}
        placeholderDeleteResult={placeholderDeleteResult}
      />

      <SchedulerMonitorPanel
        isOpen={showSchedulerMonitor}
        onToggle={() => setShowSchedulerMonitor(!showSchedulerMonitor)}
      />

      <WebhookEventsPanel
        isOpen={showWebhookEvents}
        onToggle={() => setShowWebhookEvents(!showWebhookEvents)}
      />

      <JobQueuePanel
        isOpen={showJobQueue}
        onToggle={() => setShowJobQueue(!showJobQueue)}
      />

      <HubSpotQueuePanel
        isOpen={showHubSpotQueue}
        onToggle={() => setShowHubSpotQueue(!showHubSpotQueue)}
      />

      <AlertHistoryPanel
        isOpen={showAlertHistory}
        onToggle={() => setShowAlertHistory(!showAlertHistory)}
      />

      <IgnoreModals
        ignoreModal={ignoreModal}
        bulkIgnoreModal={bulkIgnoreModal}
        ignoreDuration={ignoreDuration}
        setIgnoreDuration={setIgnoreDuration}
        ignoreReason={ignoreReason}
        setIgnoreReason={setIgnoreReason}
        handleIgnoreIssue={handleIgnoreIssue}
        closeIgnoreModal={closeIgnoreModal}
        handleBulkIgnore={handleBulkIgnore}
        closeBulkIgnoreModal={closeBulkIgnoreModal}
        isIgnoring={isIgnoring}
        isBulkIgnoring={isBulkIgnoring}
      />

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

      <UnifiedBookingSheet
        isOpen={bookingSheet.isOpen}
        onClose={() => setBookingSheet({ isOpen: false, bookingId: null })}
        mode={bookingSheet.isUnmatched ? "assign" : "manage"}
        trackmanBookingId={bookingSheet.trackmanBookingId || null}
        bayName={bookingSheet.bayName}
        bookingDate={bookingSheet.bookingDate}
        timeSlot={bookingSheet.timeSlot}
        matchedBookingId={bookingSheet.isUnmatched ? undefined : (bookingSheet.bookingId || undefined)}
        currentMemberName={bookingSheet.memberName}
        currentMemberEmail={bookingSheet.memberEmail}
        importedName={bookingSheet.importedName}
        notes={bookingSheet.notes}
        originalEmail={bookingSheet.originalEmail}
        onSuccess={() => {
          setBookingSheet({ isOpen: false, bookingId: null });
          runIntegrityMutation.mutate();
        }}
      />
    </div>
  );
};

export default DataIntegrityTab;
