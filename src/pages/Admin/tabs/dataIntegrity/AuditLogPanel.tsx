import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../../hooks/queries/useFetch';

interface AuditLogEntry {
  id: number;
  staffEmail: string;
  staffName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceName: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  actorType: string | null;
  actorEmail: string | null;
  createdAt: string;
}

interface AuditLogResponse {
  logs: AuditLogEntry[];
  total: number;
}

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

const ACTION_CATEGORIES: Record<string, string[]> = {
  'Booking': ['approve_booking', 'decline_booking', 'cancel_booking', 'create_booking', 'update_booking', 'reschedule_booking'],
  'Member': ['create_member', 'update_member', 'delete_member', 'change_tier', 'archive_member'],
  'Payment': ['process_refund', 'record_charge', 'send_payment_link', 'apply_credit'],
  'Settings': ['update_setting', 'update_settings_bulk'],
  'System': ['import_trackman', 'sync_hubspot', 'data_migration'],
};

function ensureUtc(s: string): string {
  let n = s.replace(' ', 'T');
  if (!n.includes('Z') && !n.includes('+') && !/T[\d:]+[-+]/.test(n)) n += 'Z';
  return n;
}

function formatTimestamp(dateStr: string): string {
  const d = new Date(ensureUtc(dateStr));
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
}

function getActionColor(action: string): string {
  if (action.includes('delete') || action.includes('cancel') || action.includes('decline')) return 'text-red-600 dark:text-red-400';
  if (action.includes('create') || action.includes('approve')) return 'text-green-600 dark:text-green-400';
  if (action.includes('update') || action.includes('change')) return 'text-blue-600 dark:text-blue-400';
  return 'text-gray-600 dark:text-gray-400';
}

function getActorIcon(actorType: string | null): string {
  if (actorType === 'system') return 'smart_toy';
  if (actorType === 'member') return 'person';
  return 'badge';
}

const AuditLogPanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const [filters, setFilters] = useState({
    action: '',
    resourceType: '',
    staffEmail: '',
  });
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const limit = 25;

  const queryParams = new URLSearchParams();
  if (filters.action) queryParams.set('action', filters.action);
  if (filters.resourceType) queryParams.set('resourceType', filters.resourceType);
  if (filters.staffEmail) queryParams.set('staffEmail', filters.staffEmail);
  queryParams.set('limit', String(limit));
  queryParams.set('offset', String(page * limit));

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'monitoring', 'audit-logs', filters, page],
    queryFn: () => fetchWithCredentials<AuditLogResponse>(`/api/admin/monitoring/audit-logs?${queryParams.toString()}`),
    refetchInterval: 30000,
    enabled: isOpen,
  });

  const logs = data?.logs || [];

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <button onClick={onToggle} className="tactile-btn flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">history</span>
          <span className="font-bold text-primary dark:text-white">Audit Log</span>
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>

      {isOpen && (
        <div className="mt-4">
          <div className="flex flex-wrap gap-2 mb-3">
            <input
              type="text"
              placeholder="Filter by actor email..."
              value={filters.staffEmail}
              onChange={(e) => { setFilters(f => ({ ...f, staffEmail: e.target.value })); setPage(0); }}
              className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-white/5 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 w-44"
            />
            <select
              value={filters.resourceType}
              onChange={(e) => { setFilters(f => ({ ...f, resourceType: e.target.value })); setPage(0); }}
              className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-white/5 text-gray-900 dark:text-gray-100"
            >
              <option value="">All resources</option>
              {['member', 'booking', 'payment', 'settings', 'subscription', 'event', 'wellness', 'announcement', 'trackman', 'system', 'stripe', 'billing'].map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <select
              value={filters.action}
              onChange={(e) => { setFilters(f => ({ ...f, action: e.target.value })); setPage(0); }}
              className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-white/5 text-gray-900 dark:text-gray-100"
            >
              <option value="">All actions</option>
              {Object.entries(ACTION_CATEGORIES).map(([category, actions]) => (
                <optgroup key={category} label={category}>
                  {actions.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
                </optgroup>
              ))}
            </select>
            {(filters.action || filters.resourceType || filters.staffEmail) && (
              <button
                onClick={() => { setFilters({ action: '', resourceType: '', staffEmail: '' }); setPage(0); }}
                className="px-2 py-1.5 text-xs rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
              >
                Clear
              </button>
            )}
          </div>

          {isLoading ? (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">Loading...</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                      <th className="pb-2 pr-3">When</th>
                      <th className="pb-2 pr-3">Actor</th>
                      <th className="pb-2 pr-3">Action</th>
                      <th className="pb-2 pr-3">Resource</th>
                      <th className="pb-2">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log, idx) => (
                      <React.Fragment key={log.id}>
                        <tr
                          className={`border-b border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-100 dark:hover:bg-white/[0.05] ${idx % 2 === 0 ? 'bg-gray-50/50 dark:bg-white/[0.02]' : ''}`}
                          tabIndex={0}
                          role="button"
                          onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(expandedId === log.id ? null : log.id); } }}
                        >
                          <td className="py-2 pr-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{formatTimestamp(log.createdAt)}</td>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-1">
                              <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-gray-400">{getActorIcon(log.actorType)}</span>
                              <span className="text-gray-900 dark:text-gray-100 truncate max-w-[120px]">{log.staffName || log.staffEmail}</span>
                            </div>
                          </td>
                          <td className={`py-2 pr-3 font-medium ${getActionColor(log.action)}`}>{log.action.replace(/_/g, ' ')}</td>
                          <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{log.resourceType}</td>
                          <td className="py-2 text-gray-600 dark:text-gray-400 truncate max-w-[150px]">{log.resourceName || log.resourceId || '-'}</td>
                        </tr>
                        {expandedId === log.id && log.details && (
                          <tr>
                            <td colSpan={5} className="px-3 py-2 bg-gray-50 dark:bg-white/[0.02]">
                              <pre className="text-[11px] text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                                {JSON.stringify(log.details, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              {logs.length === 0 && (
                <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">No audit log entries found</p>
              )}

              {logs.length > 0 && (
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                  <button
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-xs text-gray-500 dark:text-gray-400">Page {page + 1}</span>
                  <button
                    onClick={() => setPage(p => p + 1)}
                    disabled={logs.length < limit}
                    className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default AuditLogPanel;
