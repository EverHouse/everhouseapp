import React, { useState } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../../hooks/queries/useFetch';

interface WebhookEvent {
  id: number;
  eventType: string;
  trackmanBookingId: string | null;
  trackmanUserId: string | null;
  processedAt: string | null;
  processingError: string | null;
  matchedBookingId: number | null;
  matchedUserId: string | null;
  createdAt: string;
  retryCount: number;
  lastRetryAt: string | null;
  status: 'processed' | 'failed' | 'pending';
}

function ensureUtc(dateStr: string): string {
  if (!dateStr) return dateStr;
  let s = dateStr.replace(' ', 'T');
  if (!s.includes('Z') && !s.includes('+') && !/T[\d:]+[-+]/.test(s)) {
    s += 'Z';
  }
  return s;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(ensureUtc(dateStr));
  const diff = Date.now() - d.getTime();
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
}

function formatDateTimePacific(dateStr: string): string {
  return new Date(ensureUtc(dateStr)).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
}

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

const WebhookEventsPanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const [webhookRef] = useAutoAnimate();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);

  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);
  if (typeFilter) params.set('type', typeFilter);
  params.set('limit', '50');

  const { data } = useQuery({
    queryKey: ['admin', 'monitoring', 'webhooks', statusFilter, typeFilter],
    queryFn: () => fetchWithCredentials<{ events: WebhookEvent[]; total: number }>(`/api/admin/monitoring/webhooks?${params.toString()}`),
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    enabled: isOpen,
  });

  const { data: typesData } = useQuery({
    queryKey: ['admin', 'monitoring', 'webhook-types'],
    queryFn: () => fetchWithCredentials<{ types: string[] }>('/api/admin/monitoring/webhook-types'),
    enabled: isOpen,
  });

  const events = data?.events || [];
  const eventTypes = typesData?.types || [];

  const statusBadge = (status: string) => {
    switch (status) {
      case 'processed': return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
      case 'failed': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
      case 'pending': return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
      default: return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
    }
  };

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
      <button onClick={onToggle} className="tactile-btn flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">webhook</span>
          <span className="font-bold text-primary dark:text-white">Webhook Events</span>
          {data && (
            <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">({data.total} total)</span>
          )}
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>

      {isOpen && (
        <div className="mt-4 space-y-3">
          <div className="flex gap-2 flex-wrap">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-2 py-1 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
            >
              <option value="">All Statuses</option>
              <option value="processed">Processed</option>
              <option value="failed">Failed</option>
              <option value="pending">Pending</option>
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="px-2 py-1 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
            >
              <option value="">All Types</option>
              {eventTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 pr-3">Type</th>
                  <th className="pb-2 pr-3">Source ID</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 pr-3">Time</th>
                  <th className="pb-2">Retries</th>
                </tr>
              </thead>
              <tbody ref={webhookRef}>
                {events.map((event, idx) => (
                  <React.Fragment key={event.id}>
                    <tr
                      className={`tactile-row border-b border-gray-100 dark:border-gray-800 ${idx % 2 === 0 ? 'bg-gray-50/50 dark:bg-white/[0.02]' : ''} cursor-pointer hover:bg-gray-100 dark:hover:bg-white/[0.05]`}
                      tabIndex={0}
                      role="button"
                      onClick={() => setExpandedEvent(expandedEvent === event.id ? null : event.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedEvent(expandedEvent === event.id ? null : event.id); } }}
                    >
                      <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{event.eventType}</td>
                      <td className="py-2 pr-3 text-gray-600 dark:text-gray-400 font-mono text-[10px]">
                        {event.trackmanBookingId || event.trackmanUserId || '-'}
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${statusBadge(event.status)}`}>
                          {event.status}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{formatTime(event.createdAt)}</td>
                      <td className="py-2 text-gray-600 dark:text-gray-400">{event.retryCount}</td>
                    </tr>
                    {expandedEvent === event.id && (
                      <tr>
                        <td colSpan={5} className="px-3 py-2 bg-gray-50 dark:bg-gray-800/50">
                          <div className="space-y-1 text-[11px]">
                            {event.processingError && (
                              <p className="text-red-600 dark:text-red-400"><strong>Error:</strong> {event.processingError}</p>
                            )}
                            {event.matchedBookingId && (
                              <p className="text-gray-600 dark:text-gray-400"><strong>Matched Booking:</strong> #{event.matchedBookingId}</p>
                            )}
                            {event.matchedUserId && (
                              <p className="text-gray-600 dark:text-gray-400"><strong>Matched User:</strong> {event.matchedUserId}</p>
                            )}
                            <p className="text-gray-500 dark:text-gray-500"><strong>Created:</strong> {formatDateTimePacific(event.createdAt)}</p>
                            {event.processedAt && (
                              <p className="text-gray-500 dark:text-gray-500"><strong>Processed:</strong> {formatDateTimePacific(event.processedAt)}</p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {events.length === 0 && (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">No webhook events found</p>
          )}
        </div>
      )}
    </div>
  );
};

export default WebhookEventsPanel;
