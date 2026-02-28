import React from 'react';
import type { IgnoreModalState, BulkIgnoreModalState } from './dataIntegrityTypes';

interface IgnoreModalsProps {
  ignoreModal: IgnoreModalState;
  bulkIgnoreModal: BulkIgnoreModalState;
  ignoreDuration: '24h' | '1w' | '30d';
  setIgnoreDuration: (dur: '24h' | '1w' | '30d') => void;
  ignoreReason: string;
  setIgnoreReason: (reason: string) => void;
  handleIgnoreIssue: () => void;
  closeIgnoreModal: () => void;
  handleBulkIgnore: () => void;
  closeBulkIgnoreModal: () => void;
  isIgnoring: boolean;
  isBulkIgnoring: boolean;
}

const IgnoreModals: React.FC<IgnoreModalsProps> = ({
  ignoreModal,
  bulkIgnoreModal,
  ignoreDuration,
  setIgnoreDuration,
  ignoreReason,
  setIgnoreReason,
  handleIgnoreIssue,
  closeIgnoreModal,
  handleBulkIgnore,
  closeBulkIgnoreModal,
  isIgnoring,
  isBulkIgnoring,
}) => {
  return (
    <>
      {ignoreModal.isOpen && ignoreModal.issue && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-primary dark:text-white">Ignore Issue</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">{ignoreModal.issue.description}</p>
            
            <div className="space-y-3">
              <label className="block text-sm font-medium text-primary dark:text-white">Duration</label>
              <div className="flex gap-2">
                {(['24h', '1w', '30d'] as const).map((dur) => (
                  <button
                    key={dur}
                    onClick={() => setIgnoreDuration(dur)}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                      ignoreDuration === dur
                        ? 'bg-primary dark:bg-white text-white dark:text-primary'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {dur === '24h' ? '24 Hours' : dur === '1w' ? '1 Week' : '30 Days'}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="space-y-2">
              <label className="block text-sm font-medium text-primary dark:text-white">Reason</label>
              <textarea
                value={ignoreReason}
                onChange={(e) => setIgnoreReason(e.target.value)}
                placeholder="Why are you ignoring this issue?"
                className="w-full px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm resize-none"
                rows={3}
              />
            </div>
            
            <div className="flex gap-2 pt-2">
              <button
                onClick={closeIgnoreModal}
                className="flex-1 py-2 px-4 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleIgnoreIssue}
                disabled={isIgnoring || !ignoreReason.trim()}
                className="flex-1 py-2 px-4 bg-primary dark:bg-white text-white dark:text-primary rounded-lg text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isIgnoring && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Ignore Issue
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkIgnoreModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-primary dark:text-white">Exclude All Issues</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Exclude {bulkIgnoreModal.issues.length} issues from "{bulkIgnoreModal.checkName}"
            </p>
            
            <div className="space-y-3">
              <label className="block text-sm font-medium text-primary dark:text-white">Duration</label>
              <div className="flex gap-2">
                {(['24h', '1w', '30d'] as const).map((dur) => (
                  <button
                    key={dur}
                    onClick={() => setIgnoreDuration(dur)}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                      ignoreDuration === dur
                        ? 'bg-primary dark:bg-white text-white dark:text-primary'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {dur === '24h' ? '24 Hours' : dur === '1w' ? '1 Week' : '30 Days'}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="space-y-2">
              <label className="block text-sm font-medium text-primary dark:text-white">Reason</label>
              <textarea
                value={ignoreReason}
                onChange={(e) => setIgnoreReason(e.target.value)}
                placeholder="Why are you excluding these issues?"
                className="w-full px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm resize-none"
                rows={3}
              />
            </div>
            
            <div className="flex gap-2 pt-2">
              <button
                onClick={closeBulkIgnoreModal}
                className="flex-1 py-2 px-4 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkIgnore}
                disabled={isBulkIgnoring || !ignoreReason.trim()}
                className="flex-1 py-2 px-4 bg-primary dark:bg-white text-white dark:text-primary rounded-lg text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isBulkIgnoring && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Exclude All
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default IgnoreModals;
