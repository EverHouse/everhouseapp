import React from 'react';

interface SyncToolsPanelProps {
  showDataTools: boolean;
  setShowDataTools: (show: boolean) => void;
  resyncEmail: string;
  setResyncEmail: (email: string) => void;
  handleResyncMember: () => void;
  isResyncing: boolean;
  resyncResult: { success: boolean; message: string } | null;
  handleReconcileGroupBilling: () => void;
  isReconciling: boolean;
  reconcileResult: {
    success: boolean;
    groupsChecked: number;
    membersDeactivated: number;
    membersReactivated: number;
    membersCreated: number;
    itemsRelinked: number;
    errors: string[];
  } | null;
  handleBackfillStripeCache: () => void;
  isBackfillingStripeCache: boolean;
  stripeCacheResult: { success: boolean; message: string; stats?: any } | null;
  handleDetectDuplicates: () => void;
  isRunningDuplicateDetection: boolean;
  duplicateDetectionResult: { success: boolean; message: string; appDuplicates?: any[]; hubspotDuplicates?: any[] } | null;
  expandedDuplicates: { app: boolean; hubspot: boolean };
  setExpandedDuplicates: React.Dispatch<React.SetStateAction<{ app: boolean; hubspot: boolean }>>;
  handleCleanupStripeCustomers: (dryRun: boolean) => void;
  isRunningStripeCustomerCleanup: boolean;
  stripeCleanupResult: {
    success: boolean;
    message: string;
    dryRun?: boolean;
    totalCustomers?: number;
    emptyCount?: number;
    skippedActiveCount?: number;
    customers?: Array<{ id: string; email: string | null; name: string | null; created: string }>;
    deleted?: Array<{ id: string; email: string | null }>;
    deletedCount?: number;
  } | null;
  stripeCleanupProgress: {
    phase: string;
    totalCustomers: number;
    checked: number;
    emptyFound: number;
    skippedActiveCount: number;
    deleted: number;
    errors: number;
  } | null;
  handleArchiveStaleVisitors: (dryRun: boolean) => void;
  isRunningVisitorArchive: boolean;
  visitorArchiveResult: {
    success: boolean;
    message: string;
    dryRun?: boolean;
    totalScanned?: number;
    eligibleCount?: number;
    keptCount?: number;
    archivedCount?: number;
    sampleArchived?: Array<{ name: string; email: string }>;
  } | null;
  visitorArchiveProgress: {
    phase: string;
    totalVisitors: number;
    checked: number;
    eligibleCount: number;
    keptCount: number;
    archived: number;
    errors: number;
  } | null;
}

const SyncToolsPanel: React.FC<SyncToolsPanelProps> = ({
  showDataTools,
  setShowDataTools,
  resyncEmail,
  setResyncEmail,
  handleResyncMember,
  isResyncing,
  resyncResult,
  handleReconcileGroupBilling,
  isReconciling,
  reconcileResult,
  handleBackfillStripeCache,
  isBackfillingStripeCache,
  stripeCacheResult,
  handleDetectDuplicates,
  isRunningDuplicateDetection,
  duplicateDetectionResult,
  expandedDuplicates,
  setExpandedDuplicates,
  handleCleanupStripeCustomers,
  isRunningStripeCustomerCleanup,
  stripeCleanupResult,
  stripeCleanupProgress,
  handleArchiveStaleVisitors,
  isRunningVisitorArchive,
  visitorArchiveResult,
  visitorArchiveProgress,
}) => {
  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <button
        onClick={() => setShowDataTools(!showDataTools)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">build</span>
          <span className="font-bold text-primary dark:text-white">Data Tools</span>
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showDataTools ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>
      
      {showDataTools && (
        <div className="mt-4 space-y-6">
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-primary dark:text-white">Resync Member</h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">Force a full resync of a member's data from HubSpot and Stripe</p>
            <div className="flex gap-2">
              <input
                type="email"
                value={resyncEmail}
                onChange={(e) => setResyncEmail(e.target.value)}
                placeholder="Enter member email"
                className="flex-1 px-3 py-2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg text-sm"
              />
              <button
                onClick={handleResyncMember}
                disabled={isResyncing || !resyncEmail.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {isResyncing && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Resync
              </button>
            </div>
            {resyncResult && (
              <p className={`text-xs ${resyncResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {resyncResult.message}
              </p>
            )}
          </div>

          <div className="border-t border-gray-200 dark:border-white/10 pt-4 space-y-3">
            <h4 className="text-sm font-medium text-primary dark:text-white">Reconcile Group Billing</h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">Sync group billing members with Stripe subscription line items</p>
            <button
              onClick={handleReconcileGroupBilling}
              disabled={isReconciling}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
            >
              {isReconciling && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
              Run Reconciliation
            </button>
            {reconcileResult && (
              <div className={`p-3 rounded-lg ${reconcileResult.success ? 'bg-green-50 dark:bg-green-900/20' : 'bg-yellow-50 dark:bg-yellow-900/20'}`}>
                <p className="text-xs text-gray-700 dark:text-gray-300">
                  Checked {reconcileResult.groupsChecked} groups • 
                  Deactivated: {reconcileResult.membersDeactivated} • 
                  Reactivated: {reconcileResult.membersReactivated} • 
                  Created: {reconcileResult.membersCreated} • 
                  Relinked: {reconcileResult.itemsRelinked}
                </p>
                {reconcileResult.errors.length > 0 && (
                  <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                    {reconcileResult.errors.map((err, i) => <p key={i}>{err}</p>)}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-gray-200 dark:border-white/10 pt-4 space-y-3">
            <h4 className="text-sm font-medium text-primary dark:text-white">Backfill Stripe Cache</h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">Fetch and cache recent Stripe payments, charges, and invoices</p>
            <button
              onClick={handleBackfillStripeCache}
              disabled={isBackfillingStripeCache}
              className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
            >
              {isBackfillingStripeCache && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
              Backfill Cache
            </button>
            {stripeCacheResult && (
              <p className={`text-xs ${stripeCacheResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {stripeCacheResult.message}
              </p>
            )}
          </div>

          <div className="border-t border-gray-200 dark:border-white/10 pt-4 space-y-3">
            <h4 className="text-sm font-medium text-primary dark:text-white">Detect Duplicates</h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">Scan for duplicate members in the app and HubSpot</p>
            <button
              onClick={handleDetectDuplicates}
              disabled={isRunningDuplicateDetection}
              className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
            >
              {isRunningDuplicateDetection && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
              Detect Duplicates
            </button>
            {duplicateDetectionResult && (
              <div className={`p-3 rounded-lg ${duplicateDetectionResult.success ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
                <p className={`text-xs ${duplicateDetectionResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                  {duplicateDetectionResult.message}
                </p>
                {duplicateDetectionResult.appDuplicates && duplicateDetectionResult.appDuplicates.length > 0 && (
                  <div className="mt-2">
                    <button
                      onClick={() => setExpandedDuplicates(prev => ({ ...prev, app: !prev.app }))}
                      className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[14px]">{expandedDuplicates.app ? 'expand_less' : 'expand_more'}</span>
                      App Duplicates ({duplicateDetectionResult.appDuplicates.length})
                    </button>
                    {expandedDuplicates.app && (
                      <div className="mt-1 max-h-32 overflow-y-auto text-[11px] bg-white dark:bg-white/5 rounded p-2">
                        {duplicateDetectionResult.appDuplicates.map((dup: any, i: number) => (
                          <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                            {dup.email}: {dup.count} records
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {duplicateDetectionResult.hubspotDuplicates && duplicateDetectionResult.hubspotDuplicates.length > 0 && (
                  <div className="mt-2">
                    <button
                      onClick={() => setExpandedDuplicates(prev => ({ ...prev, hubspot: !prev.hubspot }))}
                      className="text-xs text-orange-600 dark:text-orange-400 flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[14px]">{expandedDuplicates.hubspot ? 'expand_less' : 'expand_more'}</span>
                      HubSpot Duplicates ({duplicateDetectionResult.hubspotDuplicates.length})
                    </button>
                    {expandedDuplicates.hubspot && (
                      <div className="mt-1 max-h-32 overflow-y-auto text-[11px] bg-white dark:bg-white/5 rounded p-2">
                        {duplicateDetectionResult.hubspotDuplicates.map((dup: any, i: number) => (
                          <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                            {dup.email}: {dup.count} contacts
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-gray-200 dark:border-white/10 pt-4 space-y-3">
            <h4 className="text-sm font-medium text-primary dark:text-white flex items-center gap-2">
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">person_remove</span>
              Stripe Customer Cleanup
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Scan your Stripe account for customers with zero transactions (no charges, subscriptions, invoices, or payment intents) and delete them to keep your account clean.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleCleanupStripeCustomers(true)}
                disabled={isRunningStripeCustomerCleanup}
                className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {isRunningStripeCustomerCleanup && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Scan & Preview
              </button>
              <button
                onClick={() => handleCleanupStripeCustomers(false)}
                disabled={isRunningStripeCustomerCleanup || !stripeCleanupResult?.dryRun}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {isRunningStripeCustomerCleanup && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Delete Empty Customers
              </button>
            </div>
            {isRunningStripeCustomerCleanup && stripeCleanupProgress && (
              <div className="mt-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined animate-spin text-[16px] text-blue-600">progress_activity</span>
                  <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
                    {stripeCleanupProgress.phase === 'fetching' && 'Fetching customers from Stripe...'}
                    {stripeCleanupProgress.phase === 'checking' && `Checking customers: ${stripeCleanupProgress.checked} / ${stripeCleanupProgress.totalCustomers}`}
                    {stripeCleanupProgress.phase === 'deleting' && `Deleting empty customers: ${stripeCleanupProgress.deleted} / ${stripeCleanupProgress.emptyFound}`}
                  </span>
                </div>
                {stripeCleanupProgress.totalCustomers > 0 && (
                  <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-2">
                    <div 
                      className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                      style={{ 
                        width: `${stripeCleanupProgress.phase === 'checking' 
                          ? Math.round((stripeCleanupProgress.checked / Math.max(1, stripeCleanupProgress.totalCustomers)) * 100)
                          : stripeCleanupProgress.phase === 'deleting'
                            ? Math.round((stripeCleanupProgress.deleted / Math.max(1, stripeCleanupProgress.emptyFound)) * 100)
                            : 0}%` 
                      }}
                    />
                  </div>
                )}
                <div className="mt-1 text-[10px] text-blue-600 dark:text-blue-400">
                  {stripeCleanupProgress.emptyFound > 0 && `Empty: ${stripeCleanupProgress.emptyFound} | `}
                  {stripeCleanupProgress.skippedActiveCount > 0 && `Active (kept): ${stripeCleanupProgress.skippedActiveCount} | `}
                  {stripeCleanupProgress.errors > 0 && `Errors: ${stripeCleanupProgress.errors}`}
                </div>
              </div>
            )}
            {stripeCleanupResult && (
              <div className={`p-3 rounded-lg ${stripeCleanupResult.success ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
                {stripeCleanupResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only — No Changes Made</p>
                )}
                <p className={`text-xs ${stripeCleanupResult.success ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                  {stripeCleanupResult.message}
                </p>
                {stripeCleanupResult.skippedActiveCount != null && stripeCleanupResult.skippedActiveCount > 0 && (
                  <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                    Skipped {stripeCleanupResult.skippedActiveCount} active members (kept for future billing)
                  </p>
                )}
                {stripeCleanupResult.dryRun && stripeCleanupResult.customers && stripeCleanupResult.customers.length > 0 && (
                  <div className="mt-2 max-h-40 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                    <p className="font-medium mb-1">{stripeCleanupResult.emptyCount} empty customers found:</p>
                    {stripeCleanupResult.customers.map((c: any, i: number) => (
                      <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                        {c.email || 'No email'} — {c.name || 'No name'} ({c.id})
                      </div>
                    ))}
                  </div>
                )}
                {!stripeCleanupResult.dryRun && stripeCleanupResult.deleted && stripeCleanupResult.deleted.length > 0 && (
                  <div className="mt-2 max-h-40 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                    <p className="font-medium mb-1">{stripeCleanupResult.deletedCount} customers deleted:</p>
                    {stripeCleanupResult.deleted.map((c: any, i: number) => (
                      <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                        {c.email || 'No email'} ({c.id})
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-gray-200 dark:border-white/10 pt-4 space-y-3">
            <h4 className="text-sm font-medium text-primary dark:text-white flex items-center gap-2">
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">archive</span>
              Archive Stale Visitors
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Archive non-member visitors who have zero visit activity, no MindBody transaction history, no day pass purchases, and no Stripe charges. Archived visitors are hidden from search results and directory.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleArchiveStaleVisitors(true)}
                disabled={isRunningVisitorArchive}
                className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {isRunningVisitorArchive && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Scan & Preview
              </button>
              <button
                onClick={() => handleArchiveStaleVisitors(false)}
                disabled={isRunningVisitorArchive || !visitorArchiveResult?.dryRun}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {isRunningVisitorArchive && <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>}
                Archive Stale Visitors
              </button>
            </div>
            {isRunningVisitorArchive && visitorArchiveProgress && (
              <div className="mt-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined animate-spin text-[16px] text-blue-600">progress_activity</span>
                  <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
                    {visitorArchiveProgress.phase === 'scanning' && 'Scanning visitors for activity...'}
                    {visitorArchiveProgress.phase === 'checking_stripe' && `Checking Stripe transactions: ${visitorArchiveProgress.checked} / ${visitorArchiveProgress.totalVisitors}`}
                    {visitorArchiveProgress.phase === 'archiving' && `Archiving: ${visitorArchiveProgress.archived} / ${visitorArchiveProgress.eligibleCount}`}
                  </span>
                </div>
                {visitorArchiveProgress.totalVisitors > 0 && (
                  <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-2">
                    <div 
                      className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                      style={{ 
                        width: `${visitorArchiveProgress.phase === 'checking_stripe' 
                          ? Math.round((visitorArchiveProgress.checked / Math.max(1, visitorArchiveProgress.totalVisitors)) * 100)
                          : visitorArchiveProgress.phase === 'archiving'
                            ? Math.round((visitorArchiveProgress.archived / Math.max(1, visitorArchiveProgress.eligibleCount)) * 100)
                            : visitorArchiveProgress.phase === 'scanning' ? 0 : 100}%` 
                      }}
                    />
                  </div>
                )}
                <div className="mt-1 text-[10px] text-blue-600 dark:text-blue-400">
                  {visitorArchiveProgress.eligibleCount > 0 && `Eligible: ${visitorArchiveProgress.eligibleCount} | `}
                  {visitorArchiveProgress.keptCount > 0 && `Kept (has activity): ${visitorArchiveProgress.keptCount} | `}
                  {visitorArchiveProgress.errors > 0 && `Errors: ${visitorArchiveProgress.errors}`}
                </div>
              </div>
            )}
            {visitorArchiveResult && (
              <div className={`mt-2 p-3 rounded-lg ${visitorArchiveResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'}`}>
                {visitorArchiveResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${visitorArchiveResult.success ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>{visitorArchiveResult.message}</p>
                {visitorArchiveResult.sampleArchived && visitorArchiveResult.sampleArchived.length > 0 && (
                  <div className="mt-2 max-h-32 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                    <p className="text-[10px] font-medium text-gray-500 mb-1">Sample of {visitorArchiveResult.dryRun ? 'visitors to archive' : 'archived visitors'}:</p>
                    {visitorArchiveResult.sampleArchived.map((v, i) => (
                      <div key={i} className="py-0.5 text-gray-600 dark:text-gray-400">
                        {v.name} ({v.email})
                      </div>
                    ))}
                    {(visitorArchiveResult.eligibleCount || 0) > 20 && (
                      <p className="text-[10px] text-gray-400 mt-1">...and {(visitorArchiveResult.eligibleCount || 0) - 20} more</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SyncToolsPanel;
