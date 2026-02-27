import React from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../../hooks/queries/useFetch';

interface FailedJob {
  id: number;
  jobType: string;
  lastError: string | null;
  createdAt: string;
  retryCount: number;
  maxRetries: number;
}

interface JobQueueData {
  stats: { pending: number; processing: number; completed: number; failed: number };
  recentFailed: FailedJob[];
  recentCompleted: { id: number; jobType: string; processedAt: string }[];
  oldestPending: string | null;
}

function ensureUtc(s: string): string {
  let n = s.replace(' ', 'T');
  if (!n.includes('Z') && !n.includes('+') && !/T[\d:]+[-+]/.test(n)) n += 'Z';
  return n;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(ensureUtc(dateStr));
  const diff = Date.now() - d.getTime();
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
}

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

const JobQueuePanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const [jobsRef] = useAutoAnimate();
  const { data } = useQuery({
    queryKey: ['admin', 'monitoring', 'jobs'],
    queryFn: () => fetchWithCredentials<JobQueueData>('/api/admin/monitoring/jobs'),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    enabled: isOpen,
  });

  const stats = data?.stats || { pending: 0, processing: 0, completed: 0, failed: 0 };

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <button onClick={onToggle} className="tactile-btn flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">work</span>
          <span className="font-bold text-primary dark:text-white">Job Queue</span>
          {stats.failed > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
              {stats.failed} failed
            </span>
          )}
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>

      {isOpen && (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-2">
              <p className="text-lg font-bold text-yellow-600 dark:text-yellow-400">{stats.pending}</p>
              <p className="text-[10px] text-yellow-600/70 dark:text-yellow-400/70 uppercase">Pending</p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2">
              <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{stats.processing}</p>
              <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70 uppercase">Processing</p>
            </div>
            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-2">
              <p className="text-lg font-bold text-green-600 dark:text-green-400">{stats.completed}</p>
              <p className="text-[10px] text-green-600/70 dark:text-green-400/70 uppercase">Done (24h)</p>
            </div>
            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-2">
              <p className="text-lg font-bold text-red-600 dark:text-red-400">{stats.failed}</p>
              <p className="text-[10px] text-red-600/70 dark:text-red-400/70 uppercase">Failed</p>
            </div>
          </div>

          {data?.oldestPending && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Oldest pending: {formatTime(data.oldestPending)}
            </p>
          )}

          {data?.recentFailed && data.recentFailed.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Recent Failed Jobs</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                      <th className="pb-2 pr-3">Job Type</th>
                      <th className="pb-2 pr-3">Error</th>
                      <th className="pb-2 pr-3">Created</th>
                      <th className="pb-2">Retries</th>
                    </tr>
                  </thead>
                  <tbody ref={jobsRef}>
                    {data.recentFailed.map((job, idx) => (
                      <tr key={job.id} className={`border-b border-gray-100 dark:border-gray-800 ${idx % 2 === 0 ? 'bg-gray-50/50 dark:bg-white/[0.02]' : ''}`}>
                        <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{job.jobType}</td>
                        <td className="py-2 pr-3 text-red-600 dark:text-red-400 max-w-[200px] truncate" title={job.lastError || ''}>
                          {job.lastError || '-'}
                        </td>
                        <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{formatTime(job.createdAt)}</td>
                        <td className="py-2 text-gray-600 dark:text-gray-400">{job.retryCount}/{job.maxRetries}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(!data?.recentFailed || data.recentFailed.length === 0) && stats.failed === 0 && (
            <p className="text-center text-gray-500 dark:text-gray-400 text-xs py-2">No failed jobs</p>
          )}
        </div>
      )}
    </div>
  );
};

export default JobQueuePanel;
