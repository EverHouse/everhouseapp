import React, { useState, useEffect } from 'react';
import { useToast } from '../../../components/Toast';
import { getCheckMetadata, sortBySeverity, CheckSeverity } from '../../../data/integrityCheckMetadata';

interface SyncComparisonData {
  field: string;
  appValue: string | number | null;
  externalValue: string | number | null;
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

const DataIntegrityTab: React.FC = () => {
  const { showToast } = useToast();
  
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingCached, setIsLoadingCached] = useState(true);
  const [results, setResults] = useState<IntegrityCheckResult[]>([]);
  const [meta, setMeta] = useState<IntegrityMeta | null>(null);
  const [isCached, setIsCached] = useState(false);
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());
  const [selectedCheck, setSelectedCheck] = useState<string | null>(null);
  
  const [calendarStatus, setCalendarStatus] = useState<CalendarStatusResponse | null>(null);
  const [isLoadingCalendars, setIsLoadingCalendars] = useState(true);
  const [showCalendars, setShowCalendars] = useState(true);
  
  const [historyData, setHistoryData] = useState<HistoryData | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [showHistory, setShowHistory] = useState(true);

  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [isLoadingAuditLog, setIsLoadingAuditLog] = useState(true);
  const [showActivityLog, setShowActivityLog] = useState(true);

  const [syncingIssues, setSyncingIssues] = useState<Set<string>>(new Set());

  const [ignoreModal, setIgnoreModal] = useState<IgnoreModalState>({ isOpen: false, issue: null, checkName: '' });
  const [bulkIgnoreModal, setBulkIgnoreModal] = useState<BulkIgnoreModalState>({ isOpen: false, checkName: '', issues: [] });
  const [ignoreDuration, setIgnoreDuration] = useState<'24h' | '1w' | '30d'>('24h');
  const [ignoreReason, setIgnoreReason] = useState<string>('');
  const [isIgnoring, setIsIgnoring] = useState(false);
  const [isBulkIgnoring, setIsBulkIgnoring] = useState(false);
  const [ignoredIssues, setIgnoredIssues] = useState<IgnoredIssueEntry[]>([]);
  const [showIgnoredIssues, setShowIgnoredIssues] = useState(false);
  const [isLoadingIgnored, setIsLoadingIgnored] = useState(false);

  const [showDataTools, setShowDataTools] = useState(true);
  const [resyncEmail, setResyncEmail] = useState('');
  const [isResyncing, setIsResyncing] = useState(false);
  const [resyncResult, setResyncResult] = useState<{ success: boolean; message: string } | null>(null);

  const [guestFeeStartDate, setGuestFeeStartDate] = useState('');
  const [guestFeeEndDate, setGuestFeeEndDate] = useState('');
  const [unlinkedGuestFees, setUnlinkedGuestFees] = useState<any[]>([]);
  const [isLoadingGuestFees, setIsLoadingGuestFees] = useState(false);
  const [availableSessions, setAvailableSessions] = useState<any[]>([]);
  const [selectedFeeId, setSelectedFeeId] = useState<number | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [isLinkingFee, setIsLinkingFee] = useState(false);

  const [attendanceSearchDate, setAttendanceSearchDate] = useState('');
  const [attendanceSearchEmail, setAttendanceSearchEmail] = useState('');
  const [attendanceBookings, setAttendanceBookings] = useState<any[]>([]);
  const [isSearchingAttendance, setIsSearchingAttendance] = useState(false);
  const [updatingAttendanceId, setUpdatingAttendanceId] = useState<number | null>(null);
  const [attendanceNote, setAttendanceNote] = useState('');

  const [mindbodyStartDate, setMindbodyStartDate] = useState('');
  const [mindbodyEndDate, setMindbodyEndDate] = useState('');
  const [isRunningMindbodyImport, setIsRunningMindbodyImport] = useState(false);
  const [mindbodyResult, setMindbodyResult] = useState<{ success: boolean; message: string } | null>(null);

  const [isSyncingToHubspot, setIsSyncingToHubspot] = useState(false);
  const [hubspotSyncResult, setHubspotSyncResult] = useState<{ success: boolean; message: string; members?: any[]; dryRun?: boolean } | null>(null);
  const [isCleaningMindbodyIds, setIsCleaningMindbodyIds] = useState(false);
  const [mindbodyCleanupResult, setMindbodyCleanupResult] = useState<{ success: boolean; message: string; toClean?: number; dryRun?: boolean } | null>(null);

  // CSV Upload state
  const [firstVisitFile, setFirstVisitFile] = useState<File | null>(null);
  const [salesFile, setSalesFile] = useState<File | null>(null);
  const [isUploadingCSV, setIsUploadingCSV] = useState(false);
  const [csvUploadResult, setCsvUploadResult] = useState<{
    success: boolean;
    message: string;
    firstVisit?: { total: number; linked: number; alreadyLinked: number; skipped: number };
    sales?: { total: number; imported: number; skipped: number; matchedByEmail: number; matchedByPhone: number; matchedByName: number; unmatched: number };
  } | null>(null);

  const [isReconciling, setIsReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<{
    success: boolean;
    groupsChecked: number;
    membersDeactivated: number;
    membersReactivated: number;
    membersCreated: number;
    itemsRelinked: number;
    errors: string[];
  } | null>(null);

  const [isSyncingStripeMetadata, setIsSyncingStripeMetadata] = useState(false);
  const [stripeMetadataResult, setStripeMetadataResult] = useState<{ success: boolean; message: string; synced?: number; failed?: number } | null>(null);
  const [isBackfillingStripeCache, setIsBackfillingStripeCache] = useState(false);
  const [stripeCacheResult, setStripeCacheResult] = useState<{ success: boolean; message: string; stats?: any } | null>(null);

  const [showSyncTools, setShowSyncTools] = useState(true);
  const [isRunningSubscriptionSync, setIsRunningSubscriptionSync] = useState(false);
  const [subscriptionStatusResult, setSubscriptionStatusResult] = useState<{ success: boolean; message: string; totalChecked?: number; mismatchCount?: number; updated?: any[]; dryRun?: boolean } | null>(null);
  const [isRunningStripeHubspotLink, setIsRunningStripeHubspotLink] = useState(false);
  const [stripeHubspotLinkResult, setStripeHubspotLinkResult] = useState<{ success: boolean; message: string; stripeOnlyMembers?: any[]; hubspotOnlyMembers?: any[]; linkedCount?: number; dryRun?: boolean } | null>(null);
  const [isRunningPaymentStatusSync, setIsRunningPaymentStatusSync] = useState(false);
  const [paymentStatusResult, setPaymentStatusResult] = useState<{ success: boolean; message: string; totalChecked?: number; updatedCount?: number; updates?: any[]; dryRun?: boolean } | null>(null);
  const [isRunningVisitCountSync, setIsRunningVisitCountSync] = useState(false);
  const [visitCountResult, setVisitCountResult] = useState<{ success: boolean; message: string; mismatchCount?: number; updatedCount?: number; sampleMismatches?: any[]; dryRun?: boolean } | null>(null);
  const [isRunningGhostBookingFix, setIsRunningGhostBookingFix] = useState(false);
  const [ghostBookingResult, setGhostBookingResult] = useState<{ success: boolean; message: string; ghostBookings?: number; fixed?: number; dryRun?: boolean } | null>(null);
  const [isRunningDuplicateDetection, setIsRunningDuplicateDetection] = useState(false);
  const [duplicateDetectionResult, setDuplicateDetectionResult] = useState<{ success: boolean; message: string; appDuplicates?: any[]; hubspotDuplicates?: any[] } | null>(null);
  const [expandedDuplicates, setExpandedDuplicates] = useState<{ app: boolean; hubspot: boolean }>({ app: false, hubspot: false });
  const [isRunningDealStageRemediation, setIsRunningDealStageRemediation] = useState(false);
  const [dealStageRemediationResult, setDealStageRemediationResult] = useState<{ success: boolean; message: string; total?: number; fixed?: number; dryRun?: boolean } | null>(null);

  useEffect(() => {
    fetchCachedResults();
    fetchCalendarStatus();
    fetchHistory();
    fetchAuditLog();
    fetchIgnoredIssues();
  }, []);

  const fetchCachedResults = async () => {
    try {
      setIsLoadingCached(true);
      const res = await fetch('/api/data-integrity/cached', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data.hasCached) {
          setResults(sortBySeverity(data.results));
          setMeta(data.meta);
          setIsCached(true);
          setIsLoadingCached(false);
        } else {
          setIsLoadingCached(false);
          runIntegrityChecks();
        }
      } else {
        console.error('Cached results endpoint returned error, falling back to fresh run');
        setIsLoadingCached(false);
        runIntegrityChecks();
      }
    } catch (err) {
      console.error('Failed to fetch cached results:', err);
      setIsLoadingCached(false);
      runIntegrityChecks();
    }
  };

  // Real-time updates via WebSocket
  useEffect(() => {
    const handleDataIntegrityUpdate = (event: CustomEvent) => {
      const { action, source } = event.detail || {};
      console.log('[DataIntegrity] Real-time update received:', action, source);
      
      // Refresh the integrity checks when data changes elsewhere
      if (action === 'data_changed' || action === 'issue_resolved') {
        runIntegrityChecks();
        fetchHistory();
        fetchAuditLog();
      }
    };

    window.addEventListener('data-integrity-update', handleDataIntegrityUpdate as EventListener);
    
    return () => {
      window.removeEventListener('data-integrity-update', handleDataIntegrityUpdate as EventListener);
    };
  }, []);

  const fetchCalendarStatus = async () => {
    try {
      setIsLoadingCalendars(true);
      const res = await fetch('/api/admin/calendars', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCalendarStatus(data);
      }
    } catch (err) {
      console.error('Failed to fetch calendar status:', err);
    } finally {
      setIsLoadingCalendars(false);
    }
  };

  const fetchHistory = async () => {
    try {
      setIsLoadingHistory(true);
      const res = await fetch('/api/data-integrity/history', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setHistoryData(data);
      }
    } catch (err) {
      console.error('Failed to fetch history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const fetchAuditLog = async () => {
    try {
      setIsLoadingAuditLog(true);
      const res = await fetch('/api/data-integrity/audit-log?limit=10', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setAuditLog(data);
      }
    } catch (err) {
      console.error('Failed to fetch audit log:', err);
    } finally {
      setIsLoadingAuditLog(false);
    }
  };

  const fetchIgnoredIssues = async () => {
    try {
      setIsLoadingIgnored(true);
      const res = await fetch('/api/data-integrity/ignores', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setIgnoredIssues(data);
      }
    } catch (err) {
      console.error('Failed to fetch ignored issues:', err);
    } finally {
      setIsLoadingIgnored(false);
    }
  };

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

  const handleIgnoreIssue = async () => {
    if (!ignoreModal.issue || !ignoreReason.trim()) return;
    
    const issueKey = `${ignoreModal.issue.table}_${ignoreModal.issue.recordId}`;
    
    setIsIgnoring(true);
    try {
      const res = await fetch('/api/data-integrity/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          issue_key: issueKey,
          duration: ignoreDuration,
          reason: ignoreReason.trim()
        })
      });
      
      if (res.ok) {
        showToast('Issue ignored successfully', 'success');
        closeIgnoreModal();
        fetchIgnoredIssues();
        runIntegrityChecks();
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to ignore issue', 'error');
      }
    } catch (err) {
      console.error('Failed to ignore issue:', err);
      showToast('Failed to ignore issue', 'error');
    } finally {
      setIsIgnoring(false);
    }
  };

  const handleUnignoreIssue = async (issueKey: string) => {
    try {
      const res = await fetch(`/api/data-integrity/ignore/${encodeURIComponent(issueKey)}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      
      if (res.ok) {
        showToast('Issue un-ignored successfully', 'success');
        fetchIgnoredIssues();
        runIntegrityChecks();
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to un-ignore issue', 'error');
      }
    } catch (err) {
      console.error('Failed to un-ignore issue:', err);
      showToast('Failed to un-ignore issue', 'error');
    }
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

  const handleBulkIgnore = async () => {
    if (bulkIgnoreModal.issues.length === 0 || !ignoreReason.trim()) return;
    
    const issueKeys = bulkIgnoreModal.issues.map(issue => `${issue.table}_${issue.recordId}`);
    
    setIsBulkIgnoring(true);
    try {
      const res = await fetch('/api/data-integrity/ignore-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          issue_keys: issueKeys,
          duration: ignoreDuration,
          reason: ignoreReason.trim()
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        showToast(`${data.total} issues excluded successfully`, 'success');
        closeBulkIgnoreModal();
        fetchIgnoredIssues();
        runIntegrityChecks();
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to exclude issues', 'error');
      }
    } catch (err) {
      console.error('Failed to bulk ignore issues:', err);
      showToast('Failed to exclude issues', 'error');
    } finally {
      setIsBulkIgnoring(false);
    }
  };

  const handleSyncPush = async (issue: IntegrityIssue) => {
    if (!issue.context?.syncType) return;
    
    const issueKey = `${issue.table}_${issue.recordId}`;
    setSyncingIssues(prev => new Set(prev).add(issueKey));
    
    try {
      const res = await fetch('/api/data-integrity/sync-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          issue_key: issueKey,
          target: issue.context.syncType,
          user_id: issue.context.userId,
          hubspot_contact_id: issue.context.hubspotContactId
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        showToast(data.message || 'Successfully pushed to external system', 'success');
        runIntegrityChecks();
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to push sync', 'error');
      }
    } catch (err) {
      console.error('Failed to push sync:', err);
      showToast('Failed to push sync', 'error');
    } finally {
      setSyncingIssues(prev => {
        const next = new Set(prev);
        next.delete(issueKey);
        return next;
      });
    }
  };

  const handleSyncPull = async (issue: IntegrityIssue) => {
    if (!issue.context?.syncType) return;
    
    const issueKey = `${issue.table}_${issue.recordId}`;
    setSyncingIssues(prev => new Set(prev).add(issueKey));
    
    try {
      const res = await fetch('/api/data-integrity/sync-pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          issue_key: issueKey,
          target: issue.context.syncType,
          user_id: issue.context.userId,
          hubspot_contact_id: issue.context.hubspotContactId
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        showToast(data.message || 'Successfully pulled from external system', 'success');
        runIntegrityChecks();
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to pull sync', 'error');
      }
    } catch (err) {
      console.error('Failed to pull sync:', err);
      showToast('Failed to pull sync', 'error');
    } finally {
      setSyncingIssues(prev => {
        const next = new Set(prev);
        next.delete(issueKey);
        return next;
      });
    }
  };

  const runIntegrityChecks = async () => {
    setIsRunning(true);
    try {
      const res = await fetch('/api/data-integrity/run', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setResults(sortBySeverity(data.results));
        setMeta(data.meta);
        setIsCached(false);
        showToast('Integrity checks completed', 'success');
        fetchHistory();
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to run integrity checks', 'error');
      }
    } catch (err) {
      console.error('Failed to run integrity checks:', err);
      showToast('Failed to run integrity checks', 'error');
    } finally {
      setIsRunning(false);
    }
  };

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
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
              <strong>Quick Fix:</strong> Sync membership status from Stripe to correct mismatches
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

      case 'Stripe-HubSpot Link':
      case 'Missing Stripe-HubSpot Link':
      case 'Tier Reconciliation':
        return (
          <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-purple-700 dark:text-purple-300 mb-2">
              <strong>Quick Fix:</strong> Link Stripe customers with HubSpot contacts
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleLinkStripeHubspot(true)}
                disabled={isRunningStripeHubspotLink}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningStripeHubspotLink && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleLinkStripeHubspot(false)}
                disabled={isRunningStripeHubspotLink}
                className="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningStripeHubspotLink && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">link</span>
                Link Records
              </button>
            </div>
            {stripeHubspotLinkResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(stripeHubspotLinkResult)}`}>
                {stripeHubspotLinkResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(stripeHubspotLinkResult)}`}>{stripeHubspotLinkResult.message}</p>
              </div>
            )}
          </div>
        );

      case 'Payment Status Mismatch':
        return (
          <div className="bg-teal-50 dark:bg-teal-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-teal-700 dark:text-teal-300 mb-2">
              <strong>Quick Fix:</strong> Sync payment status from Stripe to HubSpot
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleSyncPaymentStatus(true)}
                disabled={isRunningPaymentStatusSync}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningPaymentStatusSync && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleSyncPaymentStatus(false)}
                disabled={isRunningPaymentStatusSync}
                className="px-3 py-1.5 bg-teal-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningPaymentStatusSync && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">sync</span>
                Sync Status
              </button>
            </div>
            {paymentStatusResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(paymentStatusResult)}`}>
                {paymentStatusResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(paymentStatusResult)}`}>{paymentStatusResult.message}</p>
              </div>
            )}
          </div>
        );

      case 'Visit Count Mismatch':
        return (
          <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-indigo-700 dark:text-indigo-300 mb-2">
              <strong>Quick Fix:</strong> Update HubSpot visit counts with actual check-in data
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleSyncVisitCounts(true)}
                disabled={isRunningVisitCountSync}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningVisitCountSync && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleSyncVisitCounts(false)}
                disabled={isRunningVisitCountSync}
                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningVisitCountSync && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">sync</span>
                Sync Counts
              </button>
            </div>
            {visitCountResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(visitCountResult)}`}>
                {visitCountResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(visitCountResult)}`}>{visitCountResult.message}</p>
              </div>
            )}
          </div>
        );

      case 'Stale Mind Body IDs':
        return (
          <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-red-700 dark:text-red-300 mb-2">
              <strong>Quick Fix:</strong> Remove Mind Body IDs that don't exist in HubSpot
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

  const handleResyncMember = async () => {
    if (!resyncEmail.trim()) return;
    
    setIsResyncing(true);
    setResyncResult(null);
    try {
      const res = await fetch('/api/data-tools/resync-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: resyncEmail.trim() })
      });
      
      const data = await res.json();
      if (res.ok) {
        setResyncResult({ success: true, message: data.message });
        showToast(data.message, 'success');
        setResyncEmail('');
      } else {
        setResyncResult({ success: false, message: data.error || 'Failed to resync member' });
        showToast(data.error || 'Failed to resync member', 'error');
      }
    } catch (err) {
      console.error('Failed to resync member:', err);
      setResyncResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to resync member', 'error');
    } finally {
      setIsResyncing(false);
    }
  };

  const handleReconcileGroupBilling = async () => {
    setIsReconciling(true);
    setReconcileResult(null);
    try {
      const res = await fetch('/api/group-billing/reconcile', {
        method: 'POST',
        credentials: 'include',
      });
      
      const data = await res.json();
      if (res.ok) {
        setReconcileResult(data);
        const summary = `Checked ${data.groupsChecked} groups. Deactivated: ${data.membersDeactivated}, Reactivated: ${data.membersReactivated}, Created: ${data.membersCreated}, Relinked: ${data.itemsRelinked}`;
        showToast(summary, data.success ? 'success' : 'info');
      } else {
        showToast(data.error || 'Failed to reconcile', 'error');
      }
    } catch (err) {
      console.error('Failed to reconcile group billing:', err);
      showToast('Failed to reconcile group billing', 'error');
    } finally {
      setIsReconciling(false);
    }
  };

  const handleSearchUnlinkedGuestFees = async () => {
    if (!guestFeeStartDate || !guestFeeEndDate) return;
    
    setIsLoadingGuestFees(true);
    try {
      const res = await fetch(`/api/data-tools/unlinked-guest-fees?startDate=${guestFeeStartDate}&endDate=${guestFeeEndDate}`, {
        credentials: 'include'
      });
      
      if (res.ok) {
        const data = await res.json();
        setUnlinkedGuestFees(data);
      } else {
        showToast('Failed to search guest fees', 'error');
      }
    } catch (err) {
      console.error('Failed to search guest fees:', err);
      showToast('Failed to search guest fees', 'error');
    } finally {
      setIsLoadingGuestFees(false);
    }
  };

  const handleLoadSessionsForFee = async (fee: any) => {
    setSelectedFeeId(fee.id);
    setSelectedSessionId(null);
    try {
      const res = await fetch(`/api/data-tools/available-sessions?date=${fee.saleDate}&memberEmail=${fee.memberEmail || ''}`, {
        credentials: 'include'
      });
      
      if (res.ok) {
        const data = await res.json();
        setAvailableSessions(data);
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  };

  const handleLinkGuestFee = async () => {
    if (!selectedFeeId || !selectedSessionId) return;
    
    setIsLinkingFee(true);
    try {
      const res = await fetch('/api/data-tools/link-guest-fee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ guestFeeId: selectedFeeId, bookingId: selectedSessionId })
      });
      
      if (res.ok) {
        showToast('Guest fee linked successfully', 'success');
        setUnlinkedGuestFees(prev => prev.filter(f => f.id !== selectedFeeId));
        setSelectedFeeId(null);
        setSelectedSessionId(null);
        setAvailableSessions([]);
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to link guest fee', 'error');
      }
    } catch (err) {
      console.error('Failed to link guest fee:', err);
      showToast('Failed to link guest fee', 'error');
    } finally {
      setIsLinkingFee(false);
    }
  };

  const handleSearchAttendance = async () => {
    if (!attendanceSearchDate && !attendanceSearchEmail) {
      showToast('Please enter a date or member email', 'error');
      return;
    }
    
    setIsSearchingAttendance(true);
    try {
      const params = new URLSearchParams();
      if (attendanceSearchDate) params.append('date', attendanceSearchDate);
      if (attendanceSearchEmail) params.append('memberEmail', attendanceSearchEmail);
      
      const res = await fetch(`/api/data-tools/bookings-search?${params.toString()}`, {
        credentials: 'include'
      });
      
      if (res.ok) {
        const data = await res.json();
        setAttendanceBookings(data);
      } else {
        showToast('Failed to search bookings', 'error');
      }
    } catch (err) {
      console.error('Failed to search bookings:', err);
      showToast('Failed to search bookings', 'error');
    } finally {
      setIsSearchingAttendance(false);
    }
  };

  const handleUpdateAttendance = async (bookingId: number, status: string) => {
    setUpdatingAttendanceId(bookingId);
    try {
      const res = await fetch('/api/data-tools/update-attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ bookingId, attendanceStatus: status, notes: attendanceNote })
      });
      
      if (res.ok) {
        showToast(`Attendance updated to ${status}`, 'success');
        setAttendanceBookings(prev => prev.map(b => 
          b.id === bookingId ? { ...b, reconciliationStatus: status, reconciliationNotes: attendanceNote } : b
        ));
        setAttendanceNote('');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to update attendance', 'error');
      }
    } catch (err) {
      console.error('Failed to update attendance:', err);
      showToast('Failed to update attendance', 'error');
    } finally {
      setUpdatingAttendanceId(null);
    }
  };

  const handleMindbodyReimport = async () => {
    if (!mindbodyStartDate || !mindbodyEndDate) return;
    
    setIsRunningMindbodyImport(true);
    setMindbodyResult(null);
    try {
      const res = await fetch('/api/data-tools/mindbody-reimport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ startDate: mindbodyStartDate, endDate: mindbodyEndDate })
      });
      
      const data = await res.json();
      if (res.ok) {
        setMindbodyResult({ success: true, message: data.message });
        showToast(data.message, 'success');
      } else {
        setMindbodyResult({ success: false, message: data.error || 'Failed to queue reimport' });
        showToast(data.error || 'Failed to queue reimport', 'error');
      }
    } catch (err) {
      console.error('Failed to queue reimport:', err);
      setMindbodyResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to queue reimport', 'error');
    } finally {
      setIsRunningMindbodyImport(false);
    }
  };

  const handleCSVUpload = async () => {
    if (!salesFile) {
      showToast('Please select a Sales Report CSV file', 'error');
      return;
    }
    
    setIsUploadingCSV(true);
    setCsvUploadResult(null);
    
    try {
      const formData = new FormData();
      if (firstVisitFile) {
        formData.append('firstVisitFile', firstVisitFile);
      }
      formData.append('salesFile', salesFile);
      
      const res = await fetch('/api/legacy-purchases/admin/upload-csv', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      
      const data = await res.json();
      
      if (res.ok) {
        const importedCount = data.results?.sales?.imported || 0;
        const linkedCount = data.results?.firstVisit?.linked || 0;
        setCsvUploadResult({
          success: true,
          message: `Import complete! ${importedCount} sales imported, ${linkedCount} clients linked.`,
          firstVisit: data.results?.firstVisit,
          sales: data.results?.sales,
        });
        showToast(`Successfully imported ${importedCount} sales records`, 'success');
        // Clear file inputs
        setFirstVisitFile(null);
        setSalesFile(null);
      } else {
        setCsvUploadResult({ success: false, message: data.error || 'Import failed' });
        showToast(data.error || 'Import failed', 'error');
      }
    } catch (err) {
      console.error('CSV upload error:', err);
      setCsvUploadResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to upload CSV files', 'error');
    } finally {
      setIsUploadingCSV(false);
    }
  };

  const handleSyncStripeMetadata = async () => {
    setIsSyncingStripeMetadata(true);
    setStripeMetadataResult(null);
    try {
      const res = await fetch('/api/data-integrity/sync-stripe-metadata', {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        setStripeMetadataResult({ success: true, message: data.message, synced: data.synced, failed: data.failed });
        showToast(data.message, 'success');
      } else {
        setStripeMetadataResult({ success: false, message: data.error || 'Failed to sync metadata' });
        showToast(data.error || 'Failed to sync metadata', 'error');
      }
    } catch (err) {
      console.error('Failed to sync Stripe metadata:', err);
      setStripeMetadataResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to sync Stripe metadata', 'error');
    } finally {
      setIsSyncingStripeMetadata(false);
    }
  };

  const handleBackfillStripeCache = async () => {
    setIsBackfillingStripeCache(true);
    setStripeCacheResult(null);
    try {
      const res = await fetch('/api/financials/backfill-stripe-cache', {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        const msg = `Backfilled ${data.stats?.paymentIntents || 0} payments, ${data.stats?.charges || 0} charges, ${data.stats?.invoices || 0} invoices`;
        setStripeCacheResult({ success: true, message: msg, stats: data.stats });
        showToast(msg, 'success');
      } else {
        setStripeCacheResult({ success: false, message: data.error || 'Failed to backfill cache' });
        showToast(data.error || 'Failed to backfill cache', 'error');
      }
    } catch (err) {
      console.error('Failed to backfill Stripe cache:', err);
      setStripeCacheResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to backfill Stripe cache', 'error');
    } finally {
      setIsBackfillingStripeCache(false);
    }
  };

  const handleSyncMembersToHubspot = async (dryRun: boolean = true) => {
    setIsSyncingToHubspot(true);
    setHubspotSyncResult(null);
    try {
      const res = await fetch('/api/data-tools/sync-members-to-hubspot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ dryRun })
      });
      const data = await res.json();
      if (res.ok) {
        setHubspotSyncResult({ 
          success: true, 
          message: data.message,
          members: data.members,
          dryRun
        });
        showToast(dryRun ? 'Preview complete - no changes made' : data.message, dryRun ? 'info' : 'success');
      } else {
        setHubspotSyncResult({ success: false, message: data.error || 'Failed to sync to HubSpot' });
        showToast(data.error || 'Failed to sync to HubSpot', 'error');
      }
    } catch (err) {
      console.error('Failed to sync members to HubSpot:', err);
      setHubspotSyncResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to sync members to HubSpot', 'error');
    } finally {
      setIsSyncingToHubspot(false);
    }
  };

  const handleCleanupMindbodyIds = async (dryRun: boolean = true) => {
    setIsCleaningMindbodyIds(true);
    setMindbodyCleanupResult(null);
    try {
      const res = await fetch('/api/data-tools/cleanup-mindbody-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ dryRun })
      });
      const data = await res.json();
      if (res.ok) {
        setMindbodyCleanupResult({ 
          success: true, 
          message: data.message,
          toClean: data.toClean,
          dryRun
        });
        showToast(dryRun ? 'Preview complete - no changes made' : data.message, dryRun ? 'info' : 'success');
      } else {
        setMindbodyCleanupResult({ success: false, message: data.error || 'Failed to cleanup Mind Body IDs' });
        showToast(data.error || 'Failed to cleanup Mind Body IDs', 'error');
      }
    } catch (err) {
      console.error('Failed to cleanup Mind Body IDs:', err);
      setMindbodyCleanupResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to cleanup Mind Body IDs', 'error');
    } finally {
      setIsCleaningMindbodyIds(false);
    }
  };

  const handleSyncSubscriptionStatus = async (dryRun: boolean = true) => {
    setIsRunningSubscriptionSync(true);
    setSubscriptionStatusResult(null);
    try {
      const res = await fetch('/api/data-tools/sync-subscription-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ dryRun })
      });
      const data = await res.json();
      if (res.ok) {
        setSubscriptionStatusResult({
          success: true,
          message: data.message || `Checked ${data.totalChecked} members, found ${data.mismatchCount} mismatches`,
          totalChecked: data.totalChecked,
          mismatchCount: data.mismatchCount,
          updated: data.updated,
          dryRun
        });
        showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Subscription status sync complete'), dryRun ? 'info' : 'success');
      } else {
        setSubscriptionStatusResult({ success: false, message: data.error || 'Failed to sync subscription status' });
        showToast(data.error || 'Failed to sync subscription status', 'error');
      }
    } catch (err) {
      console.error('Failed to sync subscription status:', err);
      setSubscriptionStatusResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to sync subscription status', 'error');
    } finally {
      setIsRunningSubscriptionSync(false);
    }
  };

  const handleLinkStripeHubspot = async (dryRun: boolean = true) => {
    setIsRunningStripeHubspotLink(true);
    setStripeHubspotLinkResult(null);
    try {
      const res = await fetch('/api/data-tools/link-stripe-hubspot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ dryRun })
      });
      const data = await res.json();
      if (res.ok) {
        setStripeHubspotLinkResult({
          success: true,
          message: data.message || 'Stripe-HubSpot link complete',
          stripeOnlyMembers: data.stripeOnlyMembers,
          hubspotOnlyMembers: data.hubspotOnlyMembers,
          linkedCount: data.linkedCount,
          dryRun
        });
        showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Stripe-HubSpot link complete'), dryRun ? 'info' : 'success');
      } else {
        setStripeHubspotLinkResult({ success: false, message: data.error || 'Failed to link Stripe and HubSpot' });
        showToast(data.error || 'Failed to link Stripe and HubSpot', 'error');
      }
    } catch (err) {
      console.error('Failed to link Stripe and HubSpot:', err);
      setStripeHubspotLinkResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to link Stripe and HubSpot', 'error');
    } finally {
      setIsRunningStripeHubspotLink(false);
    }
  };

  const handleSyncPaymentStatus = async (dryRun: boolean = true) => {
    setIsRunningPaymentStatusSync(true);
    setPaymentStatusResult(null);
    try {
      const res = await fetch('/api/data-tools/sync-payment-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ dryRun })
      });
      const data = await res.json();
      if (res.ok) {
        setPaymentStatusResult({
          success: true,
          message: data.message || `Checked ${data.totalChecked} members, updated ${data.updatedCount}`,
          totalChecked: data.totalChecked,
          updatedCount: data.updatedCount,
          updates: data.updates,
          dryRun
        });
        showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Payment status sync complete'), dryRun ? 'info' : 'success');
      } else {
        setPaymentStatusResult({ success: false, message: data.error || 'Failed to sync payment status' });
        showToast(data.error || 'Failed to sync payment status', 'error');
      }
    } catch (err) {
      console.error('Failed to sync payment status:', err);
      setPaymentStatusResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to sync payment status', 'error');
    } finally {
      setIsRunningPaymentStatusSync(false);
    }
  };

  const handleSyncVisitCounts = async (dryRun: boolean = true) => {
    setIsRunningVisitCountSync(true);
    setVisitCountResult(null);
    try {
      const res = await fetch('/api/data-tools/sync-visit-counts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ dryRun })
      });
      const data = await res.json();
      if (res.ok) {
        setVisitCountResult({
          success: true,
          message: data.message || `Found ${data.mismatchCount} mismatches, updated ${data.updatedCount}`,
          mismatchCount: data.mismatchCount,
          updatedCount: data.updatedCount,
          sampleMismatches: data.sampleMismatches,
          dryRun
        });
        showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Visit count sync complete'), dryRun ? 'info' : 'success');
      } else {
        setVisitCountResult({ success: false, message: data.error || 'Failed to sync visit counts' });
        showToast(data.error || 'Failed to sync visit counts', 'error');
      }
    } catch (err) {
      console.error('Failed to sync visit counts:', err);
      setVisitCountResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to sync visit counts', 'error');
    } finally {
      setIsRunningVisitCountSync(false);
    }
  };

  const handleFixGhostBookings = async (dryRun: boolean = true) => {
    setIsRunningGhostBookingFix(true);
    setGhostBookingResult(null);
    try {
      if (dryRun) {
        const res = await fetch('/api/admin/backfill-sessions/preview', {
          method: 'GET',
          credentials: 'include'
        });
        const data = await res.json();
        if (res.ok) {
          setGhostBookingResult({
            success: true,
            message: data.message || `Found ${data.totalCount} bookings without sessions`,
            ghostBookings: data.totalCount,
            fixed: 0,
            dryRun: true
          });
          showToast('Preview complete - no changes made', 'info');
        } else {
          setGhostBookingResult({ success: false, message: data.error || 'Failed to preview' });
          showToast(data.error || 'Failed to preview', 'error');
        }
      } else {
        const res = await fetch('/api/admin/backfill-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include'
        });
        const data = await res.json();
        if (res.ok) {
          setGhostBookingResult({
            success: true,
            message: data.message || `Created ${data.sessionsCreated} sessions`,
            ghostBookings: data.sessionsCreated,
            fixed: data.sessionsCreated,
            dryRun: false
          });
          showToast(data.message || `Created ${data.sessionsCreated} sessions`, 'success');
        } else {
          setGhostBookingResult({ success: false, message: data.error || 'Failed to create sessions' });
          showToast(data.error || 'Failed to create sessions', 'error');
        }
      }
    } catch (err) {
      console.error('Failed to fix ghost bookings:', err);
      setGhostBookingResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to fix ghost bookings', 'error');
    } finally {
      setIsRunningGhostBookingFix(false);
    }
  };

  const handleRemediateDealStages = async (dryRun: boolean = true) => {
    setIsRunningDealStageRemediation(true);
    setDealStageRemediationResult(null);
    try {
      const res = await fetch('/api/hubspot/remediate-deal-stages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ dryRun })
      });
      const data = await res.json();
      if (res.ok) {
        setDealStageRemediationResult({
          success: true,
          message: data.message || `Found ${data.total || 0} deals needing updates${!dryRun ? `, fixed ${data.fixed || 0}` : ''}`,
          total: data.total,
          fixed: data.fixed,
          dryRun
        });
        showToast(dryRun ? 'Preview complete - no changes made' : (data.message || 'Deal stage remediation complete'), dryRun ? 'info' : 'success');
      } else {
        setDealStageRemediationResult({ success: false, message: data.error || 'Failed to remediate deal stages' });
        showToast(data.error || 'Failed to remediate deal stages', 'error');
      }
    } catch (err) {
      console.error('Failed to remediate deal stages:', err);
      setDealStageRemediationResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to remediate deal stages', 'error');
    } finally {
      setIsRunningDealStageRemediation(false);
    }
  };

  const handleDetectDuplicates = async () => {
    setIsRunningDuplicateDetection(true);
    setDuplicateDetectionResult(null);
    setExpandedDuplicates({ app: false, hubspot: false });
    try {
      const res = await fetch('/api/data-tools/detect-duplicates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        const appCount = data.appDuplicates?.length || 0;
        const hubspotCount = data.hubspotDuplicates?.length || 0;
        setDuplicateDetectionResult({
          success: true,
          message: data.message || `Found ${appCount} app duplicates, ${hubspotCount} HubSpot duplicates`,
          appDuplicates: data.appDuplicates,
          hubspotDuplicates: data.hubspotDuplicates
        });
        showToast(data.message || 'Duplicate detection complete', 'success');
      } else {
        setDuplicateDetectionResult({ success: false, message: data.error || 'Failed to detect duplicates' });
        showToast(data.error || 'Failed to detect duplicates', 'error');
      }
    } catch (err) {
      console.error('Failed to detect duplicates:', err);
      setDuplicateDetectionResult({ success: false, message: 'Network error occurred' });
      showToast('Failed to detect duplicates', 'error');
    } finally {
      setIsRunningDuplicateDetection(false);
    }
  };

  return (
    <div className="space-y-6 animate-slide-up-stagger pb-32" style={{ '--stagger-index': 0 } as React.CSSProperties}>
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
                              <span className={`font-medium ${entry.totalIssues > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                                {entry.totalIssues} issues
                              </span>
                              <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase">{entry.triggeredBy}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {historyData.activeIssues.filter(i => i.daysUnresolved >= 7).length > 0 && (
                      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                        <p className="text-xs font-medium text-amber-800 dark:text-amber-200 uppercase tracking-wide mb-2 flex items-center gap-1">
                          <span aria-hidden="true" className="material-symbols-outlined text-[14px]">schedule</span>
                          Long-standing Issues ({historyData.activeIssues.filter(i => i.daysUnresolved >= 7).length})
                        </p>
                        <div className="space-y-2">
                          {historyData.activeIssues
                            .filter(i => i.daysUnresolved >= 7)
                            .sort((a, b) => b.daysUnresolved - a.daysUnresolved)
                            .slice(0, 5)
                            .map((issue) => (
                              <div key={issue.issueKey} className="text-sm text-amber-700 dark:text-amber-300">
                                <span className="font-medium">{issue.daysUnresolved} days:</span> {issue.description.substring(0, 60)}...
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                    No history yet. Run integrity checks to start tracking.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">Failed to load history</p>
            )}
          </div>
        )}
      </div>

      {results.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-bold text-primary dark:text-white text-lg">Check Results</h2>
          <div className="flex flex-col lg:flex-row gap-4">
            <div className="w-full lg:w-[30%] bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl overflow-hidden">
              <div className="p-3 border-b border-primary/10 dark:border-white/10 bg-white/80 dark:bg-white/10">
                <h3 className="text-sm font-semibold text-primary dark:text-white">Integrity Checks</h3>
              </div>
              <div className="max-h-[500px] overflow-y-auto divide-y divide-primary/5 dark:divide-white/5">
                {results.map((result) => {
                  const metadata = getCheckMetadata(result.checkName);
                  const displayTitle = metadata?.title || result.checkName;
                  const severity = metadata?.severity;
                  const isSelected = selectedCheck === result.checkName;
                  
                  return (
                    <button
                      key={result.checkName}
                      onClick={() => setSelectedCheck(isSelected ? null : result.checkName)}
                      className={`w-full p-3 text-left transition-colors ${
                        isSelected 
                          ? 'bg-accent/20 dark:bg-accent/30 border-l-4 border-accent' 
                          : 'hover:bg-primary/5 dark:hover:bg-white/5'
                      }`}
                    >
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${getStatusColor(result.status)}`}>
                          {result.status}
                        </span>
                        {severity && (
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${getCheckSeverityColor(severity)}`}>
                            {severity}
                          </span>
                        )}
                        {result.issueCount > 0 && (
                          <span className="text-xs text-primary/60 dark:text-white/60 ml-auto">{result.issueCount}</span>
                        )}
                      </div>
                      <span className="font-medium text-sm text-primary dark:text-white block truncate">{displayTitle}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            
            <div className="w-full lg:w-[70%] bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl overflow-hidden">
              {selectedCheck ? (() => {
                const result = results.find(r => r.checkName === selectedCheck);
                if (!result) return null;
                const metadata = getCheckMetadata(result.checkName);
                const displayTitle = metadata?.title || result.checkName;
                const description = metadata?.description;
                const impact = metadata?.impact;
                
                return (
                  <div className="h-full flex flex-col">
                    <div className="p-4 border-b border-primary/10 dark:border-white/10 bg-white/80 dark:bg-white/10">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-bold text-primary dark:text-white">{displayTitle}</h3>
                          {description && (
                            <p className="text-xs text-primary/60 dark:text-white/60 mt-1">{description}</p>
                          )}
                        </div>
                        <button
                          onClick={() => setSelectedCheck(null)}
                          className="p-1 hover:bg-primary/10 dark:hover:bg-white/10 rounded transition-colors lg:hidden"
                        >
                          <span aria-hidden="true" className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
                        </button>
                      </div>
                    </div>
                    
                    <div className="flex-1 overflow-y-auto max-h-[500px] p-4 space-y-4">
                      {impact && (
                        <div className="bg-primary/5 dark:bg-white/5 rounded-lg p-3">
                          <p className="text-xs font-medium text-primary/80 dark:text-white/80 uppercase tracking-wide mb-1">Business Impact</p>
                          <p className="text-sm text-primary/70 dark:text-white/70">{impact}</p>
                        </div>
                      )}
                      
                      {result.issues.length === 0 ? (
                        <div className="flex items-center gap-2 text-green-600 dark:text-green-400 p-4 bg-green-50 dark:bg-green-500/10 rounded-lg">
                          <span aria-hidden="true" className="material-symbols-outlined">check_circle</span>
                          <span className="text-sm">No issues found</span>
                        </div>
                      ) : (
                        <>
                          {renderCheckFixTools(result.checkName)}
                          
                          {result.issues.filter(i => !i.ignored).length > 1 && (
                            <div className="flex justify-end">
                              <button
                                onClick={() => openBulkIgnoreModal(result.checkName, result.issues)}
                                className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 rounded-lg font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center gap-1"
                              >
                                <span aria-hidden="true" className="material-symbols-outlined text-[14px]">block</span>
                                Exclude All ({result.issues.filter(i => !i.ignored).length})
                              </button>
                            </div>
                          )}
                          
                          <div className="overflow-x-auto rounded-lg border border-primary/10 dark:border-white/10">
                            <table className="w-full text-sm">
                              <thead className="bg-white/80 dark:bg-white/10 sticky top-0 z-10">
                                <tr className="border-b border-primary/10 dark:border-white/10">
                                  <th className="text-left py-2 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide">Severity</th>
                                  <th className="text-left py-2 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide">Table</th>
                                  <th className="text-left py-2 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide hidden md:table-cell">ID</th>
                                  <th className="text-left py-2 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide">Description</th>
                                  <th className="text-right py-2 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide">Actions</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-primary/5 dark:divide-white/5">
                                {result.issues.map((issue, idx) => {
                                  const tracking = getIssueTracking(issue);
                                  return (
                                    <tr key={idx} className="bg-white/50 dark:bg-white/5 hover:bg-white/80 dark:hover:bg-white/10 transition-colors">
                                      <td className="py-2 px-3">
                                        <div className="flex items-center gap-1">
                                          <span aria-hidden="true" className="material-symbols-outlined text-[16px]">{getSeverityIcon(issue.severity)}</span>
                                          <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                            issue.severity === 'error' ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400' :
                                            issue.severity === 'warning' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' :
                                            'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                                          }`}>{issue.severity}</span>
                                        </div>
                                        {tracking && tracking.daysUnresolved > 0 && (
                                          <span className={`text-[10px] mt-1 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 ${
                                            tracking.daysUnresolved >= 7 
                                              ? 'bg-red-200 dark:bg-red-800/50 text-red-700 dark:text-red-300' 
                                              : 'bg-amber-200 dark:bg-amber-800/50 text-amber-700 dark:text-amber-300'
                                          }`}>
                                            <span aria-hidden="true" className="material-symbols-outlined text-[10px]">schedule</span>
                                            {tracking.daysUnresolved}d
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-2 px-3">
                                        <span className="text-xs font-mono bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded">{issue.table}</span>
                                      </td>
                                      <td className="py-2 px-3 hidden md:table-cell">
                                        <span className="text-xs font-mono text-primary/70 dark:text-white/70">{issue.recordId}</span>
                                      </td>
                                      <td className="py-2 px-3 text-primary dark:text-white">
                                        <p className="text-sm truncate max-w-[250px]" title={issue.description}>{issue.description}</p>
                                        {issue.suggestion && (
                                          <p className="text-xs text-primary/50 dark:text-white/50 truncate max-w-[250px]" title={issue.suggestion}>{issue.suggestion}</p>
                                        )}
                                      </td>
                                      <td className="py-2 px-3 text-right whitespace-nowrap">
                                        <div className="flex gap-1 justify-end">
                                          {issue.context?.syncComparison && issue.context.syncType === 'hubspot' && (
                                            <>
                                              <button
                                                onClick={() => handleSyncPush(issue)}
                                                disabled={syncingIssues.has(`${issue.table}_${issue.recordId}`)}
                                                className="px-2 py-1 bg-blue-600 dark:bg-blue-500 text-white rounded text-xs hover:opacity-90 transition-opacity disabled:opacity-50"
                                                title="Push to HubSpot"
                                              >
                                                <span aria-hidden="true" className="material-symbols-outlined text-sm">cloud_upload</span>
                                              </button>
                                              <button
                                                onClick={() => handleSyncPull(issue)}
                                                disabled={syncingIssues.has(`${issue.table}_${issue.recordId}`)}
                                                className="px-2 py-1 bg-orange-600 dark:bg-orange-500 text-white rounded text-xs hover:opacity-90 transition-opacity disabled:opacity-50"
                                                title="Pull from HubSpot"
                                              >
                                                <span aria-hidden="true" className="material-symbols-outlined text-sm">cloud_download</span>
                                              </button>
                                            </>
                                          )}
                                          {!issue.ignored ? (
                                            <button
                                              onClick={() => openIgnoreModal(issue, result.checkName)}
                                              className="px-2 py-1 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 rounded text-xs hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                                              title="Exclude"
                                            >
                                              <span aria-hidden="true" className="material-symbols-outlined text-sm">block</span>
                                            </button>
                                          ) : (
                                            <button
                                              onClick={() => handleUnignoreIssue(`${issue.table}_${issue.recordId}`)}
                                              className="px-2 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded text-xs hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                                              title="Remove Exclusion"
                                            >
                                              <span aria-hidden="true" className="material-symbols-outlined text-sm">do_not_disturb_off</span>
                                            </button>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })() : (
                <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center p-8">
                  <span aria-hidden="true" className="material-symbols-outlined text-4xl text-primary/20 dark:text-white/20 mb-3">arrow_back</span>
                  <p className="text-primary/60 dark:text-white/60">Select a check from the list to view details</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {results.length === 0 && !isRunning && (
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-8 text-center">
          <span aria-hidden="true" className="material-symbols-outlined text-4xl text-primary/30 dark:text-white/30 mb-3 block">fact_check</span>
          <p className="text-primary/60 dark:text-white/60">
            Click "Run Integrity Checks" to scan your database for issues
          </p>
        </div>
      )}

      <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
        <button
          onClick={() => setShowDataTools(!showDataTools)}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">build</span>
            <span className="font-bold text-primary dark:text-white">Data Tools</span>
            <span className="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 px-2 py-0.5 rounded-full">Admin</span>
          </div>
          <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showDataTools ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>
        
        {showDataTools && (
          <div className="mt-4 space-y-6">
            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4">
              <h4 className="font-semibold text-primary dark:text-white mb-2 flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">sync</span>
                Re-sync Member from HubSpot
              </h4>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">Pull the latest contact data from HubSpot for a specific member. Use this when a member's profile looks outdated or incorrect.</p>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={resyncEmail}
                  onChange={(e) => setResyncEmail(e.target.value)}
                  placeholder="Enter member email"
                  className="flex-1 px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm text-primary dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4]"
                />
                <button
                  onClick={handleResyncMember}
                  disabled={!resyncEmail.trim() || isResyncing}
                  className="px-4 py-2 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                >
                  {isResyncing && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                  Resync
                </button>
              </div>
              {resyncResult && (
                <p className={`text-sm mt-2 ${resyncResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {resyncResult.message}
                </p>
              )}
            </div>

            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4">
              <h4 className="font-semibold text-primary dark:text-white mb-2 flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">link</span>
                Guest Fee Relinking
              </h4>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">Connect guest fee charges to their corresponding booking sessions. Fixes cases where guest fees were charged but not linked to the right visit.</p>
              <div className="flex flex-wrap gap-2 mb-3">
                <input
                  type="date"
                  value={guestFeeStartDate}
                  onChange={(e) => setGuestFeeStartDate(e.target.value)}
                  className="px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4]"
                />
                <span className="flex items-center text-gray-500">to</span>
                <input
                  type="date"
                  value={guestFeeEndDate}
                  onChange={(e) => setGuestFeeEndDate(e.target.value)}
                  className="px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4]"
                />
                <button
                  onClick={handleSearchUnlinkedGuestFees}
                  disabled={!guestFeeStartDate || !guestFeeEndDate || isLoadingGuestFees}
                  className="px-4 py-2 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoadingGuestFees && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                  Search
                </button>
              </div>
              {unlinkedGuestFees.length > 0 && (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {unlinkedGuestFees.map((fee) => (
                    <div key={fee.id} className={`p-3 rounded-lg border ${selectedFeeId === fee.id ? 'border-primary dark:border-[#CCB8E4] bg-primary/5 dark:bg-[#CCB8E4]/10' : 'border-gray-200 dark:border-white/10 bg-white dark:bg-white/5'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <span className="text-sm font-medium text-primary dark:text-white">{fee.itemName}</span>
                          <span className="text-xs text-gray-500 ml-2">${fee.itemTotal}</span>
                        </div>
                        <button
                          onClick={() => handleLoadSessionsForFee(fee)}
                          className="text-xs px-2 py-1 bg-primary/10 dark:bg-[#CCB8E4]/20 text-primary dark:text-[#CCB8E4] rounded"
                        >
                          {selectedFeeId === fee.id ? 'Selected' : 'Select'}
                        </button>
                      </div>
                      <p className="text-xs text-gray-500">{fee.saleDate} • {fee.memberEmail || 'Unknown member'}</p>
                      
                      {selectedFeeId === fee.id && availableSessions.length > 0 && (
                        <div className="mt-3 space-y-2">
                          <p className="text-xs font-medium text-gray-600 dark:text-gray-400">Link to session:</p>
                          {availableSessions.map((session) => (
                            <button
                              key={session.id}
                              onClick={() => setSelectedSessionId(session.id)}
                              className={`w-full text-left p-2 rounded text-sm ${selectedSessionId === session.id ? 'bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515]' : 'bg-gray-100 dark:bg-white/10 text-primary dark:text-white hover:bg-gray-200 dark:hover:bg-white/20'}`}
                            >
                              {session.startTime} - {session.endTime} • {session.resourceName || 'Unknown'} • {session.userName}
                            </button>
                          ))}
                          <button
                            onClick={handleLinkGuestFee}
                            disabled={!selectedSessionId || isLinkingFee}
                            className="w-full px-3 py-2 bg-green-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                          >
                            {isLinkingFee && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                            Link Fee to Session
                          </button>
                        </div>
                      )}
                      
                      {selectedFeeId === fee.id && availableSessions.length === 0 && (
                        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">No sessions found for this date/member</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {unlinkedGuestFees.length === 0 && guestFeeStartDate && guestFeeEndDate && !isLoadingGuestFees && (
                <p className="text-sm text-gray-500 text-center py-4">No unlinked guest fees found in this date range</p>
              )}
            </div>

            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4">
              <h4 className="font-semibold text-primary dark:text-white mb-2 flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">how_to_reg</span>
                Manual Attendance Correction
              </h4>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">Mark bookings as attended or no-show. Use this to fix attendance records that were missed or recorded incorrectly.</p>
              <div className="flex flex-wrap gap-2 mb-3">
                <input
                  type="date"
                  value={attendanceSearchDate}
                  onChange={(e) => setAttendanceSearchDate(e.target.value)}
                  placeholder="Date"
                  className="px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4]"
                />
                <input
                  type="email"
                  value={attendanceSearchEmail}
                  onChange={(e) => setAttendanceSearchEmail(e.target.value)}
                  placeholder="Member email (optional)"
                  className="flex-1 min-w-[200px] px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm text-primary dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4]"
                />
                <button
                  onClick={handleSearchAttendance}
                  disabled={(!attendanceSearchDate && !attendanceSearchEmail) || isSearchingAttendance}
                  className="px-4 py-2 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                >
                  {isSearchingAttendance && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                  Search
                </button>
              </div>
              {attendanceBookings.length > 0 && (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {attendanceBookings.map((booking) => (
                    <div key={booking.id} className="p-3 bg-white dark:bg-white/5 rounded-lg border border-gray-200 dark:border-white/10">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <span className="text-sm font-medium text-primary dark:text-white">{booking.userName}</span>
                          <span className="text-xs text-gray-500 ml-2">{booking.startTime} - {booking.endTime}</span>
                        </div>
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                          booking.reconciliationStatus === 'attended' ? 'bg-green-100 dark:bg-green-900/30 text-green-600' :
                          booking.reconciliationStatus === 'no_show' ? 'bg-red-100 dark:bg-red-900/30 text-red-600' :
                          'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                        }`}>
                          {booking.reconciliationStatus || 'Pending'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mb-2">{booking.requestDate} • {booking.resourceName || 'Unknown resource'}</p>
                      <div className="flex flex-wrap gap-2">
                        <input
                          type="text"
                          placeholder="Add note (optional)"
                          value={updatingAttendanceId === booking.id ? attendanceNote : ''}
                          onChange={(e) => { setUpdatingAttendanceId(booking.id); setAttendanceNote(e.target.value); }}
                          className="flex-1 min-w-[150px] px-2 py-1 bg-gray-50 dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded text-xs text-primary dark:text-white placeholder:text-gray-400"
                        />
                        <button
                          onClick={() => handleUpdateAttendance(booking.id, 'attended')}
                          disabled={updatingAttendanceId === booking.id && !attendanceNote}
                          className="px-3 py-1 bg-green-600 text-white rounded text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                        >
                          {updatingAttendanceId === booking.id && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[12px]">progress_activity</span>}
                          Attended
                        </button>
                        <button
                          onClick={() => handleUpdateAttendance(booking.id, 'no_show')}
                          disabled={updatingAttendanceId === booking.id && !attendanceNote}
                          className="px-3 py-1 bg-red-600 text-white rounded text-xs font-medium hover:opacity-90 disabled:opacity-50"
                        >
                          No-Show
                        </button>
                      </div>
                      {booking.reconciliationNotes && (
                        <p className="text-xs text-gray-500 mt-2 italic">Note: {booking.reconciliationNotes}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {attendanceBookings.length === 0 && (attendanceSearchDate || attendanceSearchEmail) && !isSearchingAttendance && (
                <p className="text-sm text-gray-500 text-center py-4">No bookings found</p>
              )}
            </div>

            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4">
              <h4 className="font-semibold text-primary dark:text-white mb-3 flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">groups</span>
                Group Billing Reconciliation
              </h4>
              <p className="text-xs text-gray-500 mb-3">
                Sync group member billing with Stripe. This checks all billing groups and ensures local records match Stripe subscription items.
                Members removed in Stripe will be deactivated, and missing links will be restored.
              </p>
              <button
                onClick={handleReconcileGroupBilling}
                disabled={isReconciling}
                className="px-4 py-2 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {isReconciling && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                {isReconciling ? 'Reconciling...' : 'Reconcile Group Billing'}
              </button>
              {reconcileResult && (
                <div className={`mt-3 p-3 rounded-lg ${reconcileResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'}`}>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="text-gray-600 dark:text-gray-300">Groups Checked:</div>
                    <div className="font-medium text-primary dark:text-white">{reconcileResult.groupsChecked}</div>
                    <div className="text-gray-600 dark:text-gray-300">Members Deactivated:</div>
                    <div className="font-medium text-red-600 dark:text-red-400">{reconcileResult.membersDeactivated}</div>
                    <div className="text-gray-600 dark:text-gray-300">Members Reactivated:</div>
                    <div className="font-medium text-green-600 dark:text-green-400">{reconcileResult.membersReactivated}</div>
                    <div className="text-gray-600 dark:text-gray-300">Members Created:</div>
                    <div className="font-medium text-purple-600 dark:text-purple-400">{reconcileResult.membersCreated}</div>
                    <div className="text-gray-600 dark:text-gray-300">Items Relinked:</div>
                    <div className="font-medium text-blue-600 dark:text-blue-400">{reconcileResult.itemsRelinked}</div>
                  </div>
                  {reconcileResult.errors.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-700">
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-300 mb-1">Errors:</p>
                      {reconcileResult.errors.map((err, idx) => (
                        <p key={idx} className="text-xs text-amber-600 dark:text-amber-400">{err}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4">
              <h4 className="font-semibold text-primary dark:text-white mb-3 flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">upload_file</span>
                Mindbody CSV Import
              </h4>
              <p className="text-xs text-gray-500 mb-3">
                Upload Mindbody CSV exports to import purchase history. The First Visit Report helps link customers to existing members by email/phone.
              </p>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
                    First Visit Report (optional - helps match customers)
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="file"
                      accept=".csv"
                      onChange={(e) => setFirstVisitFile(e.target.files?.[0] || null)}
                      className="flex-1 text-sm text-gray-600 dark:text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 dark:file:bg-blue-900/30 dark:file:text-blue-400 hover:file:bg-blue-100 dark:hover:file:bg-blue-900/50 cursor-pointer"
                    />
                    {firstVisitFile && (
                      <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px]">check_circle</span>
                        {firstVisitFile.name}
                      </span>
                    )}
                  </div>
                </div>
                
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
                    Sales Report (required)
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="file"
                      accept=".csv"
                      onChange={(e) => setSalesFile(e.target.files?.[0] || null)}
                      className="flex-1 text-sm text-gray-600 dark:text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-teal-50 file:text-teal-700 dark:file:bg-teal-900/30 dark:file:text-teal-400 hover:file:bg-teal-100 dark:hover:file:bg-teal-900/50 cursor-pointer"
                    />
                    {salesFile && (
                      <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px]">check_circle</span>
                        {salesFile.name}
                      </span>
                    )}
                  </div>
                </div>
                
                <button
                  onClick={handleCSVUpload}
                  disabled={!salesFile || isUploadingCSV}
                  className="px-4 py-2 bg-teal-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                >
                  {isUploadingCSV && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                  {isUploadingCSV ? 'Importing...' : 'Import CSV Data'}
                </button>
                
                {csvUploadResult && (
                  <div className={`p-3 rounded-lg ${csvUploadResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700'}`}>
                    <p className={`text-sm font-medium ${csvUploadResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                      {csvUploadResult.message}
                    </p>
                    {csvUploadResult.success && csvUploadResult.sales && (
                      <div className="mt-2 space-y-1">
                        <p className="text-xs text-gray-600 dark:text-gray-400">
                          <strong>Sales:</strong> {csvUploadResult.sales.imported} imported, {csvUploadResult.sales.skipped} skipped (duplicates), {csvUploadResult.sales.unmatched} unmatched
                        </p>
                        {(csvUploadResult.sales.matchedByEmail > 0 || csvUploadResult.sales.matchedByPhone > 0 || csvUploadResult.sales.matchedByName > 0) && (
                          <p className="text-xs text-gray-600 dark:text-gray-400">
                            <strong>Matched by:</strong> Email ({csvUploadResult.sales.matchedByEmail}), Phone ({csvUploadResult.sales.matchedByPhone}), Name ({csvUploadResult.sales.matchedByName})
                          </p>
                        )}
                        {csvUploadResult.firstVisit && (
                          <p className="text-xs text-gray-600 dark:text-gray-400">
                            <strong>Clients:</strong> {csvUploadResult.firstVisit.linked} linked to members, {csvUploadResult.firstVisit.alreadyLinked} already linked
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4">
              <h4 className="font-semibold text-primary dark:text-white mb-3 flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">cloud_sync</span>
                Mindbody Data Re-import
              </h4>
              <p className="text-xs text-gray-500 mb-3">Re-import data for a specific date range. This will queue a background job to refresh data from Mindbody CSV exports.</p>
              <div className="flex flex-wrap gap-2 mb-3">
                <input
                  type="date"
                  value={mindbodyStartDate}
                  onChange={(e) => setMindbodyStartDate(e.target.value)}
                  className="px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4]"
                />
                <span className="flex items-center text-gray-500">to</span>
                <input
                  type="date"
                  value={mindbodyEndDate}
                  onChange={(e) => setMindbodyEndDate(e.target.value)}
                  className="px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4]"
                />
                <button
                  onClick={handleMindbodyReimport}
                  disabled={!mindbodyStartDate || !mindbodyEndDate || isRunningMindbodyImport}
                  className="px-4 py-2 bg-amber-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                >
                  {isRunningMindbodyImport && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                  Queue Re-import
                </button>
              </div>
              {mindbodyResult && (
                <p className={`text-sm ${mindbodyResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {mindbodyResult.message}
                </p>
              )}
            </div>

            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4">
              <h4 className="font-semibold text-primary dark:text-white mb-3 flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">sync</span>
                Stripe Data Sync
              </h4>
              <p className="text-xs text-gray-500 mb-4">
                Sync member data with Stripe and cache payment history for faster loading.
              </p>
              
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    <strong>Sync Customer Metadata:</strong> Updates all Stripe customers with their userId and current tier.
                  </p>
                  <button
                    onClick={handleSyncStripeMetadata}
                    disabled={isSyncingStripeMetadata}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                  >
                    {isSyncingStripeMetadata && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                    {isSyncingStripeMetadata ? 'Syncing...' : 'Sync Customer Metadata'}
                  </button>
                  {stripeMetadataResult && (
                    <p className={`text-sm mt-2 ${stripeMetadataResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {stripeMetadataResult.message}
                    </p>
                  )}
                </div>

                <div className="border-t border-gray-200 dark:border-white/10 pt-4">
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    <strong>Backfill Transaction Cache:</strong> Loads the last 90 days of payments from Stripe into the local cache for faster POS loading.
                  </p>
                  <button
                    onClick={handleBackfillStripeCache}
                    disabled={isBackfillingStripeCache}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                  >
                    {isBackfillingStripeCache && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                    {isBackfillingStripeCache ? 'Backfilling...' : 'Backfill Transaction Cache'}
                  </button>
                  {stripeCacheResult && (
                    <p className={`text-sm mt-2 ${stripeCacheResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {stripeCacheResult.message}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4">
              <h4 className="font-semibold text-primary dark:text-white mb-3 flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">hub</span>
                HubSpot Data Sync
              </h4>
              <p className="text-xs text-gray-500 mb-4">
                Sync members to HubSpot and clean up stale Mind Body IDs.
              </p>
              
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    <strong>Create HubSpot Contacts:</strong> Creates HubSpot contacts for members who don't have one yet.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSyncMembersToHubspot(true)}
                      disabled={isSyncingToHubspot}
                      className="px-4 py-2 bg-gray-500 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isSyncingToHubspot && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Preview
                    </button>
                    <button
                      onClick={() => handleSyncMembersToHubspot(false)}
                      disabled={isSyncingToHubspot}
                      className="px-4 py-2 bg-orange-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isSyncingToHubspot && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Sync Now
                    </button>
                  </div>
                  {hubspotSyncResult && (
                    <div className="mt-2">
                      <p className={`text-sm ${hubspotSyncResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {hubspotSyncResult.message}
                      </p>
                      {hubspotSyncResult.members && hubspotSyncResult.members.length > 0 && (
                        <div className="mt-2 max-h-32 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                          {hubspotSyncResult.members.map((m: any, i: number) => (
                            <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                              {m.name || m.email} - {m.tier || 'No tier'} {m.mindbodyClientId && `(MB: ${m.mindbodyClientId})`}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-200 dark:border-white/10 pt-4">
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    <strong>Cleanup Stale Mind Body IDs:</strong> Removes Mind Body IDs that don't exist in HubSpot.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleCleanupMindbodyIds(true)}
                      disabled={isCleaningMindbodyIds}
                      className="px-4 py-2 bg-gray-500 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isCleaningMindbodyIds && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Preview
                    </button>
                    <button
                      onClick={() => handleCleanupMindbodyIds(false)}
                      disabled={isCleaningMindbodyIds}
                      className="px-4 py-2 bg-red-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isCleaningMindbodyIds && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Clean Up
                    </button>
                  </div>
                  {mindbodyCleanupResult && (
                    <p className={`text-sm mt-2 ${mindbodyCleanupResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {mindbodyCleanupResult.message}
                      {mindbodyCleanupResult.toClean !== undefined && mindbodyCleanupResult.toClean > 0 && (
                        <span className="ml-2">({mindbodyCleanupResult.toClean} records to clean)</span>
                      )}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4">
              <h4 className="font-semibold text-primary dark:text-white mb-3 flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">sync_alt</span>
                Cross-Platform Sync Tools
              </h4>
              <p className="text-xs text-gray-500 mb-4">
                Sync data between the app, Stripe, and HubSpot to ensure consistency across all platforms.
              </p>
              
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    <strong>Subscription Status Sync:</strong> Compares member status in the app with Stripe subscription status and fixes mismatches.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSyncSubscriptionStatus(true)}
                      disabled={isRunningSubscriptionSync}
                      className="px-4 py-2 bg-gray-500 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isRunningSubscriptionSync && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Preview
                    </button>
                    <button
                      onClick={() => handleSyncSubscriptionStatus(false)}
                      disabled={isRunningSubscriptionSync}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isRunningSubscriptionSync && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Execute
                    </button>
                  </div>
                  {subscriptionStatusResult && (
                    <div className={`mt-2 p-3 rounded-lg ${subscriptionStatusResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700'}`}>
                      <p className={`text-sm font-medium ${subscriptionStatusResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                        {subscriptionStatusResult.message}
                      </p>
                      {subscriptionStatusResult.success && (
                        <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                          Checked: {subscriptionStatusResult.totalChecked} | Mismatches: {subscriptionStatusResult.mismatchCount}
                        </p>
                      )}
                      {subscriptionStatusResult.updated && subscriptionStatusResult.updated.length > 0 && (
                        <div className="mt-2 max-h-32 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                          {subscriptionStatusResult.updated.map((u: any, i: number) => (
                            <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                              {u.email || u.name}: {u.oldStatus} → {u.newStatus}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-200 dark:border-white/10 pt-4">
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    <strong>Stripe-HubSpot Link Tool:</strong> Links Stripe customers with HubSpot contacts, creating missing records.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleLinkStripeHubspot(true)}
                      disabled={isRunningStripeHubspotLink}
                      className="px-4 py-2 bg-gray-500 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isRunningStripeHubspotLink && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Preview
                    </button>
                    <button
                      onClick={() => handleLinkStripeHubspot(false)}
                      disabled={isRunningStripeHubspotLink}
                      className="px-4 py-2 bg-orange-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isRunningStripeHubspotLink && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Execute
                    </button>
                  </div>
                  {stripeHubspotLinkResult && (
                    <div className={`mt-2 p-3 rounded-lg ${stripeHubspotLinkResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700'}`}>
                      <p className={`text-sm font-medium ${stripeHubspotLinkResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                        {stripeHubspotLinkResult.message}
                      </p>
                      {stripeHubspotLinkResult.success && stripeHubspotLinkResult.linkedCount !== undefined && (
                        <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                          Linked: {stripeHubspotLinkResult.linkedCount} | Stripe Only: {stripeHubspotLinkResult.stripeOnlyMembers?.length || 0} | HubSpot Only: {stripeHubspotLinkResult.hubspotOnlyMembers?.length || 0}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-200 dark:border-white/10 pt-4">
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    <strong>Payment Status Sync:</strong> Syncs payment status from Stripe to HubSpot for accurate reporting.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSyncPaymentStatus(true)}
                      disabled={isRunningPaymentStatusSync}
                      className="px-4 py-2 bg-gray-500 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isRunningPaymentStatusSync && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Preview
                    </button>
                    <button
                      onClick={() => handleSyncPaymentStatus(false)}
                      disabled={isRunningPaymentStatusSync}
                      className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isRunningPaymentStatusSync && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Execute
                    </button>
                  </div>
                  {paymentStatusResult && (
                    <div className={`mt-2 p-3 rounded-lg ${paymentStatusResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700'}`}>
                      <p className={`text-sm font-medium ${paymentStatusResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                        {paymentStatusResult.message}
                      </p>
                      {paymentStatusResult.success && (
                        <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                          Checked: {paymentStatusResult.totalChecked} | Updated: {paymentStatusResult.updatedCount}
                        </p>
                      )}
                      {paymentStatusResult.updates && paymentStatusResult.updates.length > 0 && (
                        <div className="mt-2 max-h-32 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                          {paymentStatusResult.updates.map((u: any, i: number) => (
                            <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                              {u.email || u.name}: {u.field} updated
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-200 dark:border-white/10 pt-4">
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    <strong>Visit Count Sync:</strong> Updates HubSpot total_visit_count with actual check-in data from the app.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSyncVisitCounts(true)}
                      disabled={isRunningVisitCountSync}
                      className="px-4 py-2 bg-gray-500 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isRunningVisitCountSync && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Preview
                    </button>
                    <button
                      onClick={() => handleSyncVisitCounts(false)}
                      disabled={isRunningVisitCountSync}
                      className="px-4 py-2 bg-teal-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isRunningVisitCountSync && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Execute
                    </button>
                  </div>
                  {visitCountResult && (
                    <div className={`mt-2 p-3 rounded-lg ${visitCountResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700'}`}>
                      <p className={`text-sm font-medium ${visitCountResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                        {visitCountResult.message}
                      </p>
                      {visitCountResult.success && (
                        <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                          Mismatches: {visitCountResult.mismatchCount} | Updated: {visitCountResult.updatedCount}
                        </p>
                      )}
                      {visitCountResult.sampleMismatches && visitCountResult.sampleMismatches.length > 0 && (
                        <div className="mt-2 max-h-32 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                          {visitCountResult.sampleMismatches.map((m: any, i: number) => (
                            <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                              {m.email || m.name}: App {m.appCount} vs HubSpot {m.hubspotCount}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-200 dark:border-white/10 pt-4">
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    <strong>Ghost Booking Fix:</strong> Creates missing billing sessions for Trackman bookings that weren't properly set up.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleFixGhostBookings(true)}
                      disabled={isRunningGhostBookingFix}
                      className="px-4 py-2 bg-gray-500 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isRunningGhostBookingFix && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Preview
                    </button>
                    <button
                      onClick={() => handleFixGhostBookings(false)}
                      disabled={isRunningGhostBookingFix}
                      className="px-4 py-2 bg-amber-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isRunningGhostBookingFix && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                      Execute
                    </button>
                  </div>
                  {ghostBookingResult && (
                    <div className={`mt-2 p-3 rounded-lg ${ghostBookingResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700'}`}>
                      <p className={`text-sm font-medium ${ghostBookingResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                        {ghostBookingResult.message}
                      </p>
                      {ghostBookingResult.success && (
                        <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                          Ghost Bookings Found: {ghostBookingResult.ghostBookings} | Fixed: {ghostBookingResult.fixed}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-200 dark:border-white/10 pt-4">
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    <strong>Duplicate Detection:</strong> Detects duplicate contacts in the app and HubSpot for manual review.
                  </p>
                  <button
                    onClick={handleDetectDuplicates}
                    disabled={isRunningDuplicateDetection}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                  >
                    {isRunningDuplicateDetection && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                    {isRunningDuplicateDetection ? 'Detecting...' : 'Run Detection'}
                  </button>
                  {duplicateDetectionResult && (
                    <div className={`mt-2 p-3 rounded-lg ${duplicateDetectionResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700'}`}>
                      <p className={`text-sm font-medium ${duplicateDetectionResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                        {duplicateDetectionResult.message}
                      </p>
                      {duplicateDetectionResult.success && (
                        <div className="mt-2 space-y-2">
                          {duplicateDetectionResult.appDuplicates && duplicateDetectionResult.appDuplicates.length > 0 && (
                            <div>
                              <button
                                onClick={() => setExpandedDuplicates(prev => ({ ...prev, app: !prev.app }))}
                                className="flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-primary dark:hover:text-white"
                              >
                                <span aria-hidden="true" className={`material-symbols-outlined text-[14px] transition-transform ${expandedDuplicates.app ? 'rotate-90' : ''}`}>chevron_right</span>
                                App Duplicates ({duplicateDetectionResult.appDuplicates.length})
                              </button>
                              {expandedDuplicates.app && (
                                <div className="mt-1 max-h-40 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                                  {duplicateDetectionResult.appDuplicates.map((d: any, i: number) => (
                                    <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                                      {d.email} - {d.count} records
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {duplicateDetectionResult.hubspotDuplicates && duplicateDetectionResult.hubspotDuplicates.length > 0 && (
                            <div>
                              <button
                                onClick={() => setExpandedDuplicates(prev => ({ ...prev, hubspot: !prev.hubspot }))}
                                className="flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-primary dark:hover:text-white"
                              >
                                <span aria-hidden="true" className={`material-symbols-outlined text-[14px] transition-transform ${expandedDuplicates.hubspot ? 'rotate-90' : ''}`}>chevron_right</span>
                                HubSpot Duplicates ({duplicateDetectionResult.hubspotDuplicates.length})
                              </button>
                              {expandedDuplicates.hubspot && (
                                <div className="mt-1 max-h-40 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                                  {duplicateDetectionResult.hubspotDuplicates.map((d: any, i: number) => (
                                    <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                                      {d.email} - {d.count} records
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
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
            {auditLog.length > 0 && (
              <span className="text-xs bg-primary/10 dark:bg-white/10 text-primary dark:text-white px-2 py-0.5 rounded-full">
                {auditLog.length} entries
              </span>
            )}
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
              <div className="space-y-2">
                {auditLog.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                    <span aria-hidden="true" className={`material-symbols-outlined text-[20px] mt-0.5 ${
                      entry.action === 'resolved' ? 'text-green-600 dark:text-green-400' :
                      entry.action === 'ignored' ? 'text-amber-600 dark:text-amber-400' :
                      'text-blue-600 dark:text-blue-400'
                    }`}>
                      {entry.action === 'resolved' ? 'check_circle' : entry.action === 'ignored' ? 'do_not_disturb' : 'refresh'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                          entry.action === 'resolved' ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400' :
                          entry.action === 'ignored' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' :
                          'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        }`}>
                          {entry.action}
                        </span>
                        {entry.resolutionMethod && (
                          <span className="text-xs font-mono bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded">
                            {entry.resolutionMethod.replace('_', ' ')}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-primary dark:text-white font-medium truncate">{entry.issueKey}</p>
                      <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 dark:text-gray-400">
                        <span>{entry.actionBy}</span>
                        <span>•</span>
                        <span>{new Date(entry.actionAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      {entry.notes && (
                        <p className="text-xs text-gray-600 dark:text-gray-300 mt-1 italic">"{entry.notes}"</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                No activity logged yet. Resolve issues to start tracking.
              </p>
            )}
          </div>
        )}
      </div>



      {ignoredIssues.length > 0 && (
        <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
          <button
            onClick={() => setShowIgnoredIssues(!showIgnoredIssues)}
            className="flex items-center justify-between w-full text-left"
          >
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="material-symbols-outlined text-gray-500 dark:text-gray-400">block</span>
              <span className="font-bold text-primary dark:text-white">Excluded Issues</span>
              <span className="text-xs px-2 py-0.5 bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full">
                {ignoredIssues.filter(i => !i.isExpired).length} active
              </span>
            </div>
            <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showIgnoredIssues ? 'rotate-180' : ''}`}>
              expand_more
            </span>
          </button>
          
          {showIgnoredIssues && (
            <div className="mt-4 space-y-2">
              {isLoadingIgnored ? (
                <div className="flex items-center justify-center py-4">
                  <span aria-hidden="true" className="material-symbols-outlined animate-spin text-gray-500">progress_activity</span>
                </div>
              ) : ignoredIssues.length > 0 ? (
                ignoredIssues.map((ignore) => (
                  <div
                    key={ignore.id}
                    className={`p-3 rounded-lg border ${ignore.isExpired 
                      ? 'bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700' 
                      : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-xs font-mono bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded">
                            {ignore.issueKey}
                          </span>
                          {ignore.isExpired ? (
                            <span className="text-xs px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded">
                              Expired
                            </span>
                          ) : (
                            <span className="text-xs px-1.5 py-0.5 bg-amber-200 dark:bg-amber-800 text-amber-700 dark:text-amber-300 rounded flex items-center gap-1">
                              <span aria-hidden="true" className="material-symbols-outlined text-[12px]">schedule</span>
                              Expires {new Date(ignore.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-700 dark:text-gray-300">{ignore.reason}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Excluded by {ignore.ignoredBy} on {new Date(ignore.ignoredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </p>
                      </div>
                      <button
                        onClick={() => handleUnignoreIssue(ignore.issueKey)}
                        className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 rounded font-medium hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                  No excluded issues.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {ignoreModal.isOpen && ignoreModal.issue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1a2e] rounded-2xl w-full max-w-md shadow-2xl animate-pop-in">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-primary dark:text-white">Exclude from Checks</h3>
                <button
                  onClick={closeIgnoreModal}
                  className="p-2 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg transition-colors"
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-gray-500">close</span>
                </button>
              </div>
              
              <div className="mb-4 p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                <p className="text-sm text-primary/80 dark:text-white/80">{ignoreModal.issue.description}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {ignoreModal.issue.table} • ID: {ignoreModal.issue.recordId}
                </p>
              </div>
              
              <div className="mb-4">
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  Exclusion Duration *
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setIgnoreDuration('24h')}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                      ignoreDuration === '24h'
                        ? 'bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515]'
                        : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                    }`}
                  >
                    24 hours
                  </button>
                  <button
                    onClick={() => setIgnoreDuration('1w')}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                      ignoreDuration === '1w'
                        ? 'bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515]'
                        : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                    }`}
                  >
                    1 week
                  </button>
                  <button
                    onClick={() => setIgnoreDuration('30d')}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                      ignoreDuration === '30d'
                        ? 'bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515]'
                        : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                    }`}
                  >
                    30 days
                  </button>
                </div>
              </div>
              
              <div className="mb-6">
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  Reason *
                </label>
                <textarea
                  value={ignoreReason}
                  onChange={(e) => setIgnoreReason(e.target.value)}
                  placeholder="Explain why this issue is being excluded (e.g., Test account, intentional edge case, pending external fix)"
                  rows={3}
                  className="w-full px-4 py-3 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl text-primary dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] resize-none"
                />
              </div>
              
              <div className="flex gap-3">
                <button
                  onClick={closeIgnoreModal}
                  className="flex-1 py-3 px-4 border-2 border-gray-200 dark:border-white/20 text-primary dark:text-white rounded-xl font-bold hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleIgnoreIssue}
                  disabled={!ignoreReason.trim() || isIgnoring}
                  className="flex-1 py-3 px-4 bg-amber-500 dark:bg-amber-600 text-white rounded-xl font-bold hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isIgnoring ? (
                    <>
                      <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
                      Excluding...
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true" className="material-symbols-outlined text-[18px]">block</span>
                      Exclude Issue
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {bulkIgnoreModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
          <div className="bg-white dark:bg-[#1a1a2e] rounded-2xl w-full max-w-md shadow-2xl animate-pop-in">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-primary dark:text-white">Exclude All Issues</h3>
                <button
                  onClick={closeBulkIgnoreModal}
                  className="p-2 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg transition-colors"
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-gray-500">close</span>
                </button>
              </div>
              
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-xl p-4 mb-4">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  You are about to exclude <strong>{bulkIgnoreModal.issues.length}</strong> issues from <strong>{bulkIgnoreModal.checkName}</strong>.
                  These issues will be hidden from future checks until the exclusion expires.
                </p>
              </div>
              
              <div className="mb-4">
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  Exclusion Duration
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: '24h', label: '24 Hours' },
                    { value: '1w', label: '1 Week' },
                    { value: '30d', label: '30 Days' }
                  ].map(option => (
                    <button
                      key={option.value}
                      onClick={() => setIgnoreDuration(option.value as '24h' | '1w' | '30d')}
                      className={`py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                        ignoreDuration === option.value
                          ? 'bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515]'
                          : 'bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              
              <div className="mb-6">
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  Reason *
                </label>
                <textarea
                  value={ignoreReason}
                  onChange={(e) => setIgnoreReason(e.target.value)}
                  placeholder="Explain why these issues are being excluded (e.g., Legacy data from migration, known historical records)"
                  rows={3}
                  className="w-full px-4 py-3 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl text-primary dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] resize-none"
                />
              </div>
              
              <div className="flex gap-3">
                <button
                  onClick={closeBulkIgnoreModal}
                  className="flex-1 py-3 px-4 border-2 border-gray-200 dark:border-white/20 text-primary dark:text-white rounded-xl font-bold hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleBulkIgnore}
                  disabled={!ignoreReason.trim() || isBulkIgnoring}
                  className="flex-1 py-3 px-4 bg-amber-500 dark:bg-amber-600 text-white rounded-xl font-bold hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isBulkIgnoring ? (
                    <>
                      <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
                      Excluding...
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true" className="material-symbols-outlined text-[18px]">block</span>
                      Exclude All
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DataIntegrityTab;
