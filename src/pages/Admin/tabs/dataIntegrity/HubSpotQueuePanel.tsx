import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { fetchWithCredentials } from '../../../../hooks/queries/useFetch';

interface FailedQueueItem {
  id: number;
  operation: string;
  lastError: string | null;
  createdAt: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
}

interface HubSpotQueueData {
  stats: { pending: number; failed: number; completed_24h: number; processing: number };
  recentFailed: FailedQueueItem[];
  avgProcessingTime: number;
  queueLag: string;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

const HubSpotQueuePanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const { data } = useQuery({
    queryKey: ['admin', 'monitoring', 'hubspot-queue'],
    queryFn: () => fetchWithCredentials<HubSpotQueueData>('/api/admin/monitoring/hubspot-queue'),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    enabled: isOpen,
  });

  const [queueRef] = useAutoAnimate();
  const stats = data?.stats || { pending: 0, failed: 0, completed_24h: 0, processing: 0 };

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <button onClick={onToggle} className="flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">sync</span>
          <span className="font-bold text-primary dark:text-white">HubSpot Sync Queue</span>
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
              <p className="text-[10px] text-yellow-600/70 dark:text-yellow-400/70 uppercase">Queue Depth</p>
            </div>
            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-2">
              <p className="text-lg font-bold text-red-600 dark:text-red-400">{stats.failed}</p>
              <p className="text-[10px] text-red-600/70 dark:text-red-400/70 uppercase">Failed</p>
            </div>
            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-2">
              <p className="text-lg font-bold text-green-600 dark:text-green-400">{stats.completed_24h}</p>
              <p className="text-[10px] text-green-600/70 dark:text-green-400/70 uppercase">Done (24h)</p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2">
              <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{data ? formatMs(data.avgProcessingTime) : '-'}</p>
              <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70 uppercase">Avg Time</p>
            </div>
          </div>

          {data?.queueLag && (
            <p className="text-xs text-gray-500 dark:text-gray-400">Queue lag: {data.queueLag}</p>
          )}

          {data?.recentFailed && data.recentFailed.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Recent Failed Items</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                      <th className="pb-2 pr-3">Operation</th>
                      <th className="pb-2 pr-3">Error</th>
                      <th className="pb-2 pr-3">Created</th>
                      <th className="pb-2 pr-3">Retries</th>
                      <th className="pb-2">Next Retry</th>
                    </tr>
                  </thead>
                  <tbody ref={queueRef}>
                    {data.recentFailed.map((item, idx) => (
                      <tr key={item.id} className={`border-b border-gray-100 dark:border-gray-800 tactile-row ${idx % 2 === 0 ? 'bg-gray-50/50 dark:bg-white/[0.02]' : ''}`}>
                        <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{item.operation}</td>
                        <td className="py-2 pr-3 text-red-600 dark:text-red-400 max-w-[200px] truncate" title={item.lastError || ''}>
                          {item.lastError || '-'}
                        </td>
                        <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{formatTime(item.createdAt)}</td>
                        <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{item.retryCount}/{item.maxRetries}</td>
                        <td className="py-2 text-gray-600 dark:text-gray-400">{formatTime(item.nextRetryAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(!data?.recentFailed || data.recentFailed.length === 0) && stats.failed === 0 && (
            <p className="text-center text-gray-500 dark:text-gray-400 text-xs py-2">No failed items</p>
          )}
        </div>
      )}
    </div>
  );
};

export default HubSpotQueuePanel;
