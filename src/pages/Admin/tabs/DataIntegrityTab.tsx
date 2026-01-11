import React, { useState, useEffect } from 'react';
import { useToast } from '../../../components/Toast';
import { getCheckMetadata, sortBySeverity, CheckSeverity } from '../../../data/integrityCheckMetadata';

interface IntegrityIssue {
  category: 'orphan_record' | 'missing_relationship' | 'sync_mismatch' | 'data_quality';
  severity: 'error' | 'warning' | 'info';
  table: string;
  recordId: number | string;
  description: string;
  suggestion?: string;
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

const DataIntegrityTab: React.FC = () => {
  const { showToast } = useToast();
  
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<IntegrityCheckResult[]>([]);
  const [meta, setMeta] = useState<IntegrityMeta | null>(null);
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());
  
  const [calendarStatus, setCalendarStatus] = useState<CalendarStatusResponse | null>(null);
  const [isLoadingCalendars, setIsLoadingCalendars] = useState(true);
  const [showCalendars, setShowCalendars] = useState(true);

  useEffect(() => {
    fetchCalendarStatus();
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

  const runIntegrityChecks = async () => {
    setIsRunning(true);
    try {
      const res = await fetch('/api/data-integrity/run', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setResults(sortBySeverity(data.results));
        setMeta(data.meta);
        showToast('Integrity checks completed', 'success');
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
                          {issues.map((issue, idx) => (
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
                                  </div>
                                  <p className="text-sm">{issue.description}</p>
                                  {issue.suggestion && (
                                    <p className="text-xs mt-1 opacity-80">
                                      <span className="font-medium">Suggestion:</span> {issue.suggestion}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
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
    </div>
  );
};

export default DataIntegrityTab;
