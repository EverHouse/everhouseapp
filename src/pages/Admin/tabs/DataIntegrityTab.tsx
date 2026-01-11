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

const DataIntegrityTab: React.FC = () => {
  const { showToast } = useToast();
  
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<IntegrityCheckResult[]>([]);
  const [meta, setMeta] = useState<IntegrityMeta | null>(null);
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());
  
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
  const [ignoreDuration, setIgnoreDuration] = useState<'24h' | '1w' | '30d'>('24h');
  const [ignoreReason, setIgnoreReason] = useState<string>('');
  const [isIgnoring, setIsIgnoring] = useState(false);
  const [ignoredIssues, setIgnoredIssues] = useState<IgnoredIssueEntry[]>([]);
  const [showIgnoredIssues, setShowIgnoredIssues] = useState(false);
  const [isLoadingIgnored, setIsLoadingIgnored] = useState(false);

  useEffect(() => {
    fetchCalendarStatus();
    fetchHistory();
    fetchAuditLog();
    fetchIgnoredIssues();
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
    <div className="space-y-6 animate-pop-in pb-32">
      <div className="mb-6 flex gap-3">
        <button
          onClick={runIntegrityChecks}
          disabled={isRunning}
          className="flex-1 py-3 px-4 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-xl font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isRunning ? (
            <>
              <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
              Running Checks...
            </>
          ) : (
            <>
              <span aria-hidden="true" className="material-symbols-outlined text-[20px]">fact_check</span>
              Run Integrity Checks
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

      {results.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-bold text-primary dark:text-white text-lg">Check Results</h2>
          {results.map((result) => {
            const metadata = getCheckMetadata(result.checkName);
            const displayTitle = metadata?.title || result.checkName;
            const description = metadata?.description;
            const impact = metadata?.impact;
            const severity = metadata?.severity;
            
            return (
              <div 
                key={result.checkName}
                className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl overflow-hidden"
              >
                <button
                  onClick={() => toggleCheck(result.checkName)}
                  className="w-full flex items-center justify-between p-4 text-left hover:bg-primary/5 dark:hover:bg-white/5 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${getStatusColor(result.status)}`}>
                        {result.status}
                      </span>
                      {severity && (
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${getCheckSeverityColor(severity)}`}>
                          {severity}
                        </span>
                      )}
                    </div>
                    <span className="font-medium text-primary dark:text-white block">{displayTitle}</span>
                    {description && (
                      <p className="text-xs text-primary/60 dark:text-white/60 mt-1">{description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    {result.issueCount > 0 && (
                      <span className="text-sm text-primary/60 dark:text-white/60">{result.issueCount} issues</span>
                    )}
                    <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${expandedChecks.has(result.checkName) ? 'rotate-180' : ''}`}>
                      expand_more
                    </span>
                  </div>
                </button>
                
                {expandedChecks.has(result.checkName) && result.issues.length > 0 && (
                  <div className="border-t border-primary/10 dark:border-white/10 p-4 space-y-3">
                    {impact && (
                      <div className="bg-primary/5 dark:bg-white/5 rounded-lg p-3 mb-3">
                        <p className="text-xs font-medium text-primary/80 dark:text-white/80 uppercase tracking-wide mb-1">Business Impact</p>
                        <p className="text-sm text-primary/70 dark:text-white/70">{impact}</p>
                      </div>
                    )}
                    {Object.entries(groupByCategory(result.issues)).map(([category, issues]) => (
                      <div key={category}>
                        <p className="text-xs text-primary/60 dark:text-white/60 uppercase tracking-wide mb-2">
                          {getCategoryLabel(category)} ({issues.length})
                        </p>
                        <div className="space-y-2">
                          {issues.map((issue, idx) => {
                            const contextStr = formatContextString(issue.context);
                            const tracking = getIssueTracking(issue);
                            return (
                              <div 
                                key={idx} 
                                className={`p-3 rounded-lg border ${getSeverityColor(issue.severity)}`}
                              >
                                <div className="flex items-start gap-2">
                                  <span aria-hidden="true" className="material-symbols-outlined text-[18px] mt-0.5">{getSeverityIcon(issue.severity)}</span>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex flex-wrap items-center gap-2 mb-1">
                                      <span className="text-xs font-mono bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded">
                                        {issue.table}
                                      </span>
                                      <span className="text-xs font-mono bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded">
                                        ID: {issue.recordId}
                                      </span>
                                      {tracking && tracking.daysUnresolved > 0 && (
                                        <span className={`text-xs px-1.5 py-0.5 rounded flex items-center gap-1 ${
                                          tracking.daysUnresolved >= 7 
                                            ? 'bg-red-200 dark:bg-red-800/50 text-red-700 dark:text-red-300' 
                                            : 'bg-amber-200 dark:bg-amber-800/50 text-amber-700 dark:text-amber-300'
                                        }`}>
                                          <span aria-hidden="true" className="material-symbols-outlined text-[12px]">schedule</span>
                                          {tracking.daysUnresolved === 1 ? '1 day' : `${tracking.daysUnresolved} days`}
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-sm">{issue.description}</p>
                                    {tracking && (
                                      <p className="text-xs mt-1 text-gray-500 dark:text-gray-400 flex items-center gap-1">
                                        <span aria-hidden="true" className="material-symbols-outlined text-[12px]">history</span>
                                        First detected {new Date(tracking.firstDetectedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                      </p>
                                    )}
                                    
                                    {issue.context?.syncComparison && issue.context.syncComparison.length > 0 && (
                                      <div className="mt-3 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                                        <div className="grid grid-cols-3 text-xs font-medium uppercase tracking-wide bg-gray-100 dark:bg-gray-800">
                                          <div className="p-2 text-gray-600 dark:text-gray-300">Field</div>
                                          <div className="p-2 text-blue-600 dark:text-blue-400 border-l border-gray-200 dark:border-gray-700">
                                            <span className="flex items-center gap-1">
                                              <span aria-hidden="true" className="material-symbols-outlined text-[12px]">storage</span>
                                              App Data
                                            </span>
                                          </div>
                                          <div className="p-2 text-orange-600 dark:text-orange-400 border-l border-gray-200 dark:border-gray-700">
                                            <span className="flex items-center gap-1">
                                              <span aria-hidden="true" className="material-symbols-outlined text-[12px]">hub</span>
                                              {issue.context.syncType === 'hubspot' ? 'HubSpot' : 'Calendar'}
                                            </span>
                                          </div>
                                        </div>
                                        {issue.context.syncComparison.map((comp, compIdx) => (
                                          <div key={compIdx} className="grid grid-cols-3 text-sm border-t border-gray-200 dark:border-gray-700">
                                            <div className="p-2 font-medium text-gray-700 dark:text-gray-300">{comp.field}</div>
                                            <div className="p-2 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-l border-gray-200 dark:border-gray-700">
                                              {comp.appValue || <span className="text-gray-400 italic">empty</span>}
                                            </div>
                                            <div className="p-2 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 border-l border-gray-200 dark:border-gray-700">
                                              {comp.externalValue || <span className="text-gray-400 italic">empty</span>}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    
                                    {contextStr && !issue.context?.syncComparison && (
                                      <p className="text-xs mt-1.5 text-gray-500 dark:text-gray-400 flex items-center gap-1">
                                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">info</span>
                                        {contextStr}
                                      </p>
                                    )}
                                    {issue.suggestion && !issue.context?.syncComparison && (
                                      <p className="text-xs mt-1 opacity-80">
                                        <span className="font-medium">Suggestion:</span> {issue.suggestion}
                                      </p>
                                    )}
                                    
                                    {issue.ignored && issue.ignoreInfo && (
                                      <div className="mt-3 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-xs">
                                        <div className="flex items-center gap-1 text-gray-600 dark:text-gray-400 font-medium">
                                          <span aria-hidden="true" className="material-symbols-outlined text-[14px]">block</span>
                                          Excluded until {new Date(issue.ignoreInfo.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                        </div>
                                        <p className="text-gray-500 dark:text-gray-400 mt-1">
                                          Reason: {issue.ignoreInfo.reason}
                                        </p>
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleUnignoreIssue(`${issue.table}_${issue.recordId}`);
                                          }}
                                          className="mt-2 text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 rounded font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                                        >
                                          Remove Exclusion
                                        </button>
                                      </div>
                                    )}
                                    
                                    {!issue.ignored && (
                                      <div className="mt-3 flex flex-wrap gap-2">
                                        {issue.context?.syncComparison && issue.context.syncComparison.length > 0 && issue.context.syncType === 'hubspot' && (
                                          <>
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleSyncPush(issue);
                                              }}
                                              disabled={syncingIssues.has(`${issue.table}_${issue.recordId}`)}
                                              className="text-xs px-3 py-1.5 bg-blue-600 dark:bg-blue-500 text-white rounded-lg font-medium hover:opacity-90 transition-opacity flex items-center gap-1 disabled:opacity-50"
                                            >
                                              {syncingIssues.has(`${issue.table}_${issue.recordId}`) ? (
                                                <span aria-hidden="true" className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                                              ) : (
                                                <span aria-hidden="true" className="material-symbols-outlined text-[14px]">cloud_upload</span>
                                              )}
                                              Push to HubSpot
                                            </button>
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleSyncPull(issue);
                                              }}
                                              disabled={syncingIssues.has(`${issue.table}_${issue.recordId}`)}
                                              className="text-xs px-3 py-1.5 bg-orange-600 dark:bg-orange-500 text-white rounded-lg font-medium hover:opacity-90 transition-opacity flex items-center gap-1 disabled:opacity-50"
                                            >
                                              {syncingIssues.has(`${issue.table}_${issue.recordId}`) ? (
                                                <span aria-hidden="true" className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                                              ) : (
                                                <span aria-hidden="true" className="material-symbols-outlined text-[14px]">cloud_download</span>
                                              )}
                                              Pull from HubSpot
                                            </button>
                                          </>
                                        )}
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            openIgnoreModal(issue, result.checkName);
                                          }}
                                          className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 rounded-lg font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center gap-1"
                                        >
                                          <span aria-hidden="true" className="material-symbols-outlined text-[14px]">block</span>
                                          Exclude
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                
                {expandedChecks.has(result.checkName) && result.issues.length === 0 && (
                  <div className="border-t border-primary/10 dark:border-white/10 p-4">
                    {impact && (
                      <div className="bg-primary/5 dark:bg-white/5 rounded-lg p-3 mb-3">
                        <p className="text-xs font-medium text-primary/80 dark:text-white/80 uppercase tracking-wide mb-1">Business Impact</p>
                        <p className="text-sm text-primary/70 dark:text-white/70">{impact}</p>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                      <span aria-hidden="true" className="material-symbols-outlined">check_circle</span>
                      <span className="text-sm">No issues found</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
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
    </div>
  );
};

export default DataIntegrityTab;
