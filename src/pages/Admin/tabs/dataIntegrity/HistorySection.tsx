import React from 'react';
import EmptyState from '../../../../components/EmptyState';
import { getTrendIcon, getTrendColor } from './dataIntegrityUtils';
import type { HistoryData } from './dataIntegrityTypes';

interface HistorySectionProps {
  showHistory: boolean;
  onToggleHistory: () => void;
  isLoadingHistory: boolean;
  historyData: HistoryData | undefined;
}

const HistorySection: React.FC<HistorySectionProps> = ({
  showHistory,
  onToggleHistory,
  isLoadingHistory,
  historyData,
}) => {
  return (
    <>
      <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
        <button
          onClick={onToggleHistory}
          className="tactile-row flex items-center justify-between w-full text-left"
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
                              {new Date(entry.runAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' })}
                            </span>
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-medium ${entry.totalIssues === 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-700 dark:text-gray-300'}`}>
                                {entry.totalIssues} issues
                              </span>
                              <span className="text-[10px] text-gray-500 dark:text-gray-500">
                                {entry.triggeredBy}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    icon="history"
                    title="No history available"
                    description="Run an integrity check to start tracking history."
                    variant="compact"
                  />
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">Failed to load history</p>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default HistorySection;
