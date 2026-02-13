import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../../hooks/queries/useFetch';

interface SchedulerStatus {
  taskName: string;
  lastRunAt: string | null;
  lastResult: 'success' | 'error' | 'pending';
  lastError?: string;
  intervalMs: number;
  nextRunAt: string | null;
  runCount: number;
  lastDurationMs: number | null;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatInterval(ms: number): string {
  if (ms < 60000) return `${ms / 1000}s`;
  if (ms < 3600000) return `${ms / 60000}m`;
  return `${ms / 3600000}h`;
}

function getStatusInfo(scheduler: SchedulerStatus): { color: string; bgClass: string } {
  if (scheduler.lastResult === 'error') {
    return { color: 'bg-red-500', bgClass: 'bg-red-50 dark:bg-red-900/20' };
  }
  if (scheduler.lastResult === 'pending') {
    return { color: 'bg-gray-400', bgClass: '' };
  }
  if (scheduler.lastRunAt && scheduler.intervalMs > 0) {
    const elapsed = Date.now() - new Date(scheduler.lastRunAt).getTime();
    if (elapsed > scheduler.intervalMs * 2) {
      return { color: 'bg-yellow-500', bgClass: 'bg-yellow-50 dark:bg-yellow-900/20' };
    }
  }
  return { color: 'bg-green-500', bgClass: '' };
}

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

const SchedulerMonitorPanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const [expandedError, setExpandedError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['admin', 'monitoring', 'schedulers'],
    queryFn: () => fetchWithCredentials<{ schedulers: SchedulerStatus[] }>('/api/admin/monitoring/schedulers'),
    refetchInterval: 30000,
  });

  const schedulers = data?.schedulers || [];
  const errorCount = schedulers.filter(s => s.lastResult === 'error').length;
  const warningCount = schedulers.filter(s => {
    if (s.lastResult !== 'success' || !s.lastRunAt || s.intervalMs <= 0) return false;
    return (Date.now() - new Date(s.lastRunAt).getTime()) > s.intervalMs * 2;
  }).length;

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <button onClick={onToggle} className="flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">schedule</span>
          <span className="font-bold text-primary dark:text-white">Scheduled Tasks</span>
          {(errorCount > 0 || warningCount > 0) && (
            <div className="flex items-center gap-1 ml-2">
              {errorCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                  {errorCount} error{errorCount !== 1 ? 's' : ''}
                </span>
              )}
              {warningCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                  {warningCount} late
                </span>
              )}
            </div>
          )}
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>

      {isOpen && (
        <div className="mt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 pr-3">Task</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 pr-3">Last Run</th>
                  <th className="pb-2 pr-3">Interval</th>
                  <th className="pb-2 pr-3">Duration</th>
                  <th className="pb-2">Runs</th>
                </tr>
              </thead>
              <tbody>
                {schedulers.map((scheduler, idx) => {
                  const status = getStatusInfo(scheduler);
                  return (
                    <React.Fragment key={scheduler.taskName}>
                      <tr
                        className={`border-b border-gray-100 dark:border-gray-800 ${idx % 2 === 0 ? 'bg-gray-50/50 dark:bg-white/[0.02]' : ''} ${status.bgClass} cursor-pointer hover:bg-gray-100 dark:hover:bg-white/[0.05]`}
                        onClick={() => scheduler.lastError && setExpandedError(expandedError === scheduler.taskName ? null : scheduler.taskName)}
                      >
                        <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{scheduler.taskName}</td>
                        <td className="py-2 pr-3">
                          <span className={`inline-block w-2 h-2 rounded-full ${status.color}`} />
                        </td>
                        <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{formatRelativeTime(scheduler.lastRunAt)}</td>
                        <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{formatInterval(scheduler.intervalMs)}</td>
                        <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{formatDuration(scheduler.lastDurationMs)}</td>
                        <td className="py-2 text-gray-600 dark:text-gray-400">{scheduler.runCount}</td>
                      </tr>
                      {expandedError === scheduler.taskName && scheduler.lastError && (
                        <tr>
                          <td colSpan={6} className="px-3 py-2 bg-red-50 dark:bg-red-900/10">
                            <p className="text-[11px] text-red-700 dark:text-red-400 font-mono break-all">{scheduler.lastError}</p>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {schedulers.length === 0 && (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">No schedulers registered yet</p>
          )}
        </div>
      )}
    </div>
  );
};

export default SchedulerMonitorPanel;
