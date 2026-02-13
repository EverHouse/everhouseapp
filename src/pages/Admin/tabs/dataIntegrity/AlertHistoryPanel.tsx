import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../../hooks/queries/useFetch';

interface AlertEntry {
  id: number;
  title: string;
  message: string;
  createdAt: string;
  isRead: boolean;
  userEmail: string;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getAlertSeverity(title: string): 'error' | 'warning' | 'info' {
  const lower = title.toLowerCase();
  if (lower.includes('fail') || lower.includes('critical') || lower.includes('error')) return 'error';
  if (lower.includes('warn') || lower.includes('low') || lower.includes('issue') || lower.includes('expired')) return 'warning';
  return 'info';
}

function getSeverityStyles(severity: 'error' | 'warning' | 'info'): { border: string; icon: string; iconColor: string } {
  switch (severity) {
    case 'error': return { border: 'border-l-red-500', icon: 'error', iconColor: 'text-red-500' };
    case 'warning': return { border: 'border-l-yellow-500', icon: 'warning', iconColor: 'text-yellow-500' };
    case 'info': return { border: 'border-l-blue-500', icon: 'info', iconColor: 'text-blue-500' };
  }
}

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

const AlertHistoryPanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const params = new URLSearchParams();
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);

  const { data } = useQuery({
    queryKey: ['admin', 'monitoring', 'alerts', startDate, endDate],
    queryFn: () => fetchWithCredentials<{ alerts: AlertEntry[] }>(`/api/admin/monitoring/alerts?${params.toString()}`),
    refetchInterval: 60000,
    enabled: isOpen,
  });

  const alerts = data?.alerts || [];

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <button onClick={onToggle} className="flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">notification_important</span>
          <span className="font-bold text-primary dark:text-white">System Alerts</span>
          {alerts.length > 0 && (
            <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">({alerts.length})</span>
          )}
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>

      {isOpen && (
        <div className="mt-4 space-y-3">
          <div className="flex gap-2 flex-wrap items-center">
            <label className="text-xs text-gray-500 dark:text-gray-400">From:</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-2 py-1 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
            />
            <label className="text-xs text-gray-500 dark:text-gray-400">To:</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-2 py-1 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
            />
            {(startDate || endDate) && (
              <button
                onClick={() => { setStartDate(''); setEndDate(''); }}
                className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                Clear
              </button>
            )}
          </div>

          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {alerts.map((alert) => {
              const severity = getAlertSeverity(alert.title);
              const styles = getSeverityStyles(severity);
              return (
                <div
                  key={alert.id}
                  className={`border-l-4 ${styles.border} pl-3 py-2 bg-gray-50/50 dark:bg-white/[0.02] rounded-r-lg`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`material-symbols-outlined text-[16px] mt-0.5 ${styles.iconColor}`}>{styles.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">{alert.title}</p>
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatTime(alert.createdAt)}</span>
                      </div>
                      <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-0.5 line-clamp-2">{alert.message}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {alerts.length === 0 && (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">No system alerts found</p>
          )}
        </div>
      )}
    </div>
  );
};

export default AlertHistoryPanel;
