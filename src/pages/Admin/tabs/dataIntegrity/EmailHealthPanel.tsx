import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../../hooks/queries/useFetch';

interface EmailStats {
  period: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  delayed: number;
}

interface RecentEvent {
  id: number;
  eventType: string;
  recipientEmail: string | null;
  subject: string | null;
  createdAt: string;
}

interface EmailHealthData {
  stats: EmailStats[];
  recentEvents: RecentEvent[];
}

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

function getEventTypeColor(type: string): string {
  if (type.includes('delivered') || type.includes('sent')) return 'text-green-600 dark:text-green-400';
  if (type.includes('bounced')) return 'text-red-600 dark:text-red-400';
  if (type.includes('complained')) return 'text-orange-600 dark:text-orange-400';
  if (type.includes('delayed')) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-gray-600 dark:text-gray-400';
}

function getEventIcon(type: string): string {
  if (type.includes('delivered') || type.includes('sent')) return 'check_circle';
  if (type.includes('bounced')) return 'error';
  if (type.includes('complained')) return 'warning';
  if (type.includes('delayed')) return 'schedule';
  return 'mail';
}

function ensureUtc(s: string): string {
  let n = s.replace(' ', 'T');
  if (!n.includes('Z') && !n.includes('+') && !/T[\d:]+[-+]/.test(n)) n += 'Z';
  return n;
}

function formatTimestamp(dateStr: string): string {
  const d = new Date(ensureUtc(dateStr));
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
}

const EmailHealthPanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const [showEvents, setShowEvents] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'monitoring', 'email-health'],
    queryFn: () => fetchWithCredentials<EmailHealthData>('/api/admin/monitoring/email-health'),
    refetchInterval: 60000,
    enabled: isOpen,
  });

  const stats = data?.stats || [];
  const recentEvents = data?.recentEvents || [];

  const latest = stats[0];
  const totalBounces = stats.reduce((sum, s) => sum + s.bounced, 0);
  const totalComplaints = stats.reduce((sum, s) => sum + s.complained, 0);

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <button onClick={onToggle} className="tactile-btn flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">mail</span>
          <span className="font-bold text-primary dark:text-white">Email Delivery Health</span>
          {latest && (
            <div className="flex items-center gap-1 ml-2">
              {totalBounces > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                  {totalBounces} bounce{totalBounces !== 1 ? 's' : ''}
                </span>
              )}
              {totalComplaints > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                  {totalComplaints} complaint{totalComplaints !== 1 ? 's' : ''}
                </span>
              )}
              {totalBounces === 0 && totalComplaints === 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  Healthy
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
          {isLoading ? (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">Loading...</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                      <th className="pb-2 pr-3">Period</th>
                      <th className="pb-2 pr-3">Sent</th>
                      <th className="pb-2 pr-3">Delivered</th>
                      <th className="pb-2 pr-3">Bounced</th>
                      <th className="pb-2 pr-3">Complaints</th>
                      <th className="pb-2">Delayed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.map((row, idx) => {
                      const deliveryRate = row.sent > 0 ? ((row.delivered / row.sent) * 100).toFixed(1) : '-';
                      return (
                        <tr
                          key={row.period}
                          className={`border-b border-gray-100 dark:border-gray-800 ${idx % 2 === 0 ? 'bg-gray-50/50 dark:bg-white/[0.02]' : ''}`}
                        >
                          <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{row.period}</td>
                          <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{row.sent}</td>
                          <td className="py-2 pr-3">
                            <span className="text-green-600 dark:text-green-400">{row.delivered}</span>
                            {row.sent > 0 && (
                              <span className="text-gray-400 dark:text-gray-500 ml-1 text-[10px]">({deliveryRate}%)</span>
                            )}
                          </td>
                          <td className={`py-2 pr-3 ${row.bounced > 0 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-400'}`}>{row.bounced}</td>
                          <td className={`py-2 pr-3 ${row.complained > 0 ? 'text-orange-600 dark:text-orange-400 font-medium' : 'text-gray-400'}`}>{row.complained}</td>
                          <td className={`py-2 ${row.delayed > 0 ? 'text-yellow-600 dark:text-yellow-400' : 'text-gray-400'}`}>{row.delayed}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {stats.length === 0 && (
                <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">No email events recorded yet</p>
              )}

              {recentEvents.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                  <button
                    onClick={() => setShowEvents(!showEvents)}
                    className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  >
                    <span aria-hidden="true" className={`material-symbols-outlined text-[14px] transition-transform ${showEvents ? 'rotate-180' : ''}`}>expand_more</span>
                    Recent Events ({recentEvents.length})
                  </button>

                  {showEvents && (
                    <div className="mt-2 space-y-1">
                      {recentEvents.map((event) => (
                        <div
                          key={event.id}
                          className="flex items-center gap-2 text-xs py-1.5 px-2 rounded-lg bg-gray-50/80 dark:bg-white/[0.03]"
                        >
                          <span aria-hidden="true" className={`material-symbols-outlined text-[14px] ${getEventTypeColor(event.eventType)}`}>
                            {getEventIcon(event.eventType)}
                          </span>
                          <span className={`font-medium ${getEventTypeColor(event.eventType)}`}>
                            {event.eventType.replace('email.', '')}
                          </span>
                          <span className="text-gray-600 dark:text-gray-400 truncate flex-1">
                            {event.recipientEmail || '-'}
                          </span>
                          <span className="text-gray-400 dark:text-gray-500 whitespace-nowrap">
                            {formatTimestamp(event.createdAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default EmailHealthPanel;