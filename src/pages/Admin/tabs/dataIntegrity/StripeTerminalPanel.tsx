import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../../hooks/queries/useFetch';

interface TerminalReader {
  id: string;
  label: string;
  status: string;
  deviceType: string;
  location: string | null;
  serialNumber: string | null;
}

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

function getStatusColor(status: string): { dot: string; bg: string } {
  if (status === 'online') return { dot: 'bg-green-500', bg: 'bg-green-50 dark:bg-green-900/10' };
  if (status === 'offline') return { dot: 'bg-gray-400', bg: '' };
  return { dot: 'bg-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-900/10' };
}

const StripeTerminalPanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'stripe', 'terminal-readers'],
    queryFn: () => fetchWithCredentials<{ readers: TerminalReader[] }>('/api/stripe/terminal/readers'),
    refetchInterval: 60000,
    enabled: isOpen,
  });

  const readers = data?.readers || [];
  const onlineCount = readers.filter(r => r.status === 'online').length;

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
      <button onClick={onToggle} className="tactile-btn flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">point_of_sale</span>
          <span className="font-bold text-primary dark:text-white">Stripe Terminal</span>
          {readers.length > 0 && (
            <div className="flex items-center gap-1 ml-2">
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                {readers.length} reader{readers.length !== 1 ? 's' : ''}
              </span>
              {onlineCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  {onlineCount} online
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
          ) : error ? (
            <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800/30 rounded-xl p-3">
              <p className="text-xs text-red-700 dark:text-red-400">Failed to load terminal readers. Check Stripe configuration.</p>
            </div>
          ) : (
            <>
              {readers.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                        <th className="pb-2 pr-3">Reader</th>
                        <th className="pb-2 pr-3">Status</th>
                        <th className="pb-2 pr-3">Device</th>
                        <th className="pb-2">ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {readers.map((reader, idx) => {
                        const statusInfo = getStatusColor(reader.status);
                        return (
                          <tr
                            key={reader.id}
                            className={`border-b border-gray-100 dark:border-gray-800 ${idx % 2 === 0 ? 'bg-gray-50/50 dark:bg-white/[0.02]' : ''} ${statusInfo.bg}`}
                          >
                            <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{reader.label}</td>
                            <td className="py-2 pr-3">
                              <div className="flex items-center gap-1.5">
                                <span className={`inline-block w-2 h-2 rounded-full ${statusInfo.dot}`} />
                                <span className="text-gray-600 dark:text-gray-400 capitalize">{reader.status}</span>
                              </div>
                            </td>
                            <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{reader.deviceType?.replace(/_/g, ' ')}</td>
                            <td className="py-2 text-gray-400 dark:text-gray-500 font-mono text-[10px] truncate max-w-[100px]">{reader.id}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">No terminal readers registered</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default StripeTerminalPanel;
