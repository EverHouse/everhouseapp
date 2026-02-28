import React from 'react';

interface CleanupToolsPanelProps {
  showPlaceholderCleanup: boolean;
  setShowPlaceholderCleanup: (show: boolean) => void;
  handleScanPlaceholders: () => void;
  isLoadingPlaceholders: boolean;
  placeholderAccounts: {
    stripeCustomers: Array<{ id: string; email: string; name: string | null; created: number }>;
    hubspotContacts: Array<{ id: string; email: string; name: string }>;
    localDatabaseUsers: Array<{ id: string; email: string; name: string; status: string; createdAt: string }>;
    totals: { stripe: number; hubspot: number; localDatabase: number; total: number };
  } | null;
  showDeleteConfirm: boolean;
  setShowDeleteConfirm: (show: boolean) => void;
  handleDeletePlaceholders: () => void;
  isDeletingPlaceholders: boolean;
  placeholderDeleteResult: {
    stripeDeleted: number;
    stripeFailed: number;
    hubspotDeleted: number;
    hubspotFailed: number;
    localDatabaseDeleted: number;
    localDatabaseFailed: number;
  } | null;
}

const CleanupToolsPanel: React.FC<CleanupToolsPanelProps> = ({
  showPlaceholderCleanup,
  setShowPlaceholderCleanup,
  handleScanPlaceholders,
  isLoadingPlaceholders,
  placeholderAccounts,
  showDeleteConfirm,
  setShowDeleteConfirm,
  handleDeletePlaceholders,
  isDeletingPlaceholders,
  placeholderDeleteResult,
}) => {
  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
      <button
        onClick={() => setShowPlaceholderCleanup(!showPlaceholderCleanup)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">cleaning_services</span>
          <span className="font-bold text-primary dark:text-white">Placeholder Cleanup</span>
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showPlaceholderCleanup ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>
      
      {showPlaceholderCleanup && (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Scan for and remove placeholder accounts in Stripe and HubSpot (e.g., test@placeholder.com)
          </p>
          
          <button
            onClick={handleScanPlaceholders}
            disabled={isLoadingPlaceholders}
            className="px-4 py-2 bg-gray-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2 tactile-btn"
          >
            {isLoadingPlaceholders && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
            Scan for Placeholders
          </button>
          
          {placeholderAccounts && (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2">
                  <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{placeholderAccounts.totals.stripe}</p>
                  <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70 uppercase">Stripe</p>
                </div>
                <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-2">
                  <p className="text-lg font-bold text-orange-600 dark:text-orange-400">{placeholderAccounts.totals.hubspot}</p>
                  <p className="text-[10px] text-orange-600/70 dark:text-orange-400/70 uppercase">HubSpot</p>
                </div>
                <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-2">
                  <p className="text-lg font-bold text-green-600 dark:text-green-400">{placeholderAccounts.totals.localDatabase}</p>
                  <p className="text-[10px] text-green-600/70 dark:text-green-400/70 uppercase">Database</p>
                </div>
                <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-2">
                  <p className="text-lg font-bold text-purple-600 dark:text-purple-400">{placeholderAccounts.totals.total}</p>
                  <p className="text-[10px] text-purple-600/70 dark:text-purple-400/70 uppercase">Total</p>
                </div>
              </div>
              
              {placeholderAccounts.totals.total > 0 && (
                <>
                  {!showDeleteConfirm ? (
                    <button
                      onClick={() => setShowDeleteConfirm(true)}
                      className="w-full px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:opacity-90 flex items-center justify-center gap-2 tactile-btn"
                    >
                      <span className="material-symbols-outlined text-[16px]">delete_forever</span>
                      Delete All Placeholders
                    </button>
                  ) : (
                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg p-3">
                      <p className="text-sm text-red-700 dark:text-red-400 mb-3">
                        Are you sure you want to delete {placeholderAccounts.totals.total} placeholder accounts?
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShowDeleteConfirm(false)}
                          className="flex-1 px-3 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleDeletePlaceholders}
                          disabled={isDeletingPlaceholders}
                          className="flex-1 px-3 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                          {isDeletingPlaceholders && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                          Confirm Delete
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          
          {placeholderDeleteResult && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg p-3">
              <p className="text-sm text-green-700 dark:text-green-400">
                Deleted: Stripe {placeholderDeleteResult.stripeDeleted}, HubSpot {placeholderDeleteResult.hubspotDeleted}, Database {placeholderDeleteResult.localDatabaseDeleted}
                {(placeholderDeleteResult.stripeFailed > 0 || placeholderDeleteResult.hubspotFailed > 0 || placeholderDeleteResult.localDatabaseFailed > 0) && (
                  <span className="text-red-600 dark:text-red-400">
                    {' '}• Failed: Stripe {placeholderDeleteResult.stripeFailed}, HubSpot {placeholderDeleteResult.hubspotFailed}, Database {placeholderDeleteResult.localDatabaseFailed}
                  </span>
                )}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CleanupToolsPanel;
