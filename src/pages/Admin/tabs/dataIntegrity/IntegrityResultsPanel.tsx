import React from 'react';
import { UseMutationResult } from '@tanstack/react-query';
import { getCheckMetadata, CheckSeverity } from '../../../../data/integrityCheckMetadata';
import EmptyState from '../../../../components/EmptyState';
import type { IntegrityCheckResult, IntegrityIssue, IssueContext, ActiveIssue } from './dataIntegrityTypes';

interface IntegrityResultsPanelProps {
  results: IntegrityCheckResult[];
  expandedChecks: Set<string>;
  toggleCheck: (checkName: string) => void;
  syncingIssues: Set<string>;
  handleSyncPush: (issue: IntegrityIssue) => void;
  handleSyncPull: (issue: IntegrityIssue) => void;
  cancellingBookings: Set<number>;
  handleCancelBooking: (bookingId: number) => void;
  loadingMemberEmail: string | null;
  handleViewProfile: (email: string) => void;
  setBookingSheet: (sheet: {
    isOpen: boolean;
    bookingId: number | null;
    bayName?: string;
    bookingDate?: string;
    timeSlot?: string;
    memberName?: string;
    memberEmail?: string;
    trackmanBookingId?: string;
    importedName?: string;
    notes?: string;
    originalEmail?: string;
  }) => void;
  fixIssueMutation: UseMutationResult<{ success: boolean; message: string }, any, { endpoint: string; body: Record<string, any> }, unknown>;
  openIgnoreModal: (issue: IntegrityIssue, checkName: string) => void;
  openBulkIgnoreModal: (checkName: string, issues: IntegrityIssue[]) => void;
  getIssueTracking: (issue: IntegrityIssue) => ActiveIssue | undefined;
  isSyncingToHubspot: boolean;
  hubspotSyncResult: { success: boolean; message: string; members?: any[]; dryRun?: boolean } | null;
  handleSyncMembersToHubspot: (dryRun: boolean) => void;
  isRunningSubscriptionSync: boolean;
  subscriptionStatusResult: { success: boolean; message: string; totalChecked?: number; mismatchCount?: number; updated?: any[]; dryRun?: boolean } | null;
  handleSyncSubscriptionStatus: (dryRun: boolean) => void;
  isRunningOrphanedStripeCleanup: boolean;
  orphanedStripeResult: { success: boolean; message: string; totalChecked?: number; orphanedCount?: number; cleared?: any[]; dryRun?: boolean } | null;
  handleClearOrphanedStripeIds: (dryRun: boolean) => void;
  isRunningStripeCustomerCleanup: boolean;
  stripeCleanupResult: { success: boolean; message: string; dryRun?: boolean; totalCustomers?: number; emptyCount?: number; customers?: Array<{ id: string; email: string | null; name: string | null; created: string }>; deleted?: Array<{ id: string; email: string | null }>; deletedCount?: number } | null;
  handleCleanupStripeCustomers: (dryRun: boolean) => void;
  stripeCleanupProgress: {
    phase: string;
    totalCustomers: number;
    checked: number;
    emptyFound: number;
    skippedActiveCount: number;
    deleted: number;
    errors: number;
  } | null;
  isRunningGhostBookingFix: boolean;
  ghostBookingResult: { success: boolean; message: string; ghostBookings?: number; fixed?: number; dryRun?: boolean } | null;
  handleFixGhostBookings: (dryRun: boolean) => void;
  isCleaningMindbodyIds: boolean;
  mindbodyCleanupResult: { success: boolean; message: string; toClean?: number; dryRun?: boolean } | null;
  handleCleanupMindbodyIds: (dryRun: boolean) => void;
  isRunningDealStageRemediation: boolean;
  dealStageRemediationResult: { success: boolean; message: string; total?: number; fixed?: number; dryRun?: boolean } | null;
  handleRemediateDealStages: (dryRun: boolean) => void;
  isRunningStripeHubspotLink: boolean;
  stripeHubspotLinkResult: { success: boolean; message: string; stripeOnlyMembers?: any[]; hubspotOnlyMembers?: any[]; linkedCount?: number; dryRun?: boolean } | null;
  handleLinkStripeHubspot: (dryRun: boolean) => void;
  isRunningPaymentStatusSync: boolean;
  paymentStatusResult: { success: boolean; message: string; totalChecked?: number; updatedCount?: number; updates?: any[]; dryRun?: boolean } | null;
  handleSyncPaymentStatus: (dryRun: boolean) => void;
  isRunningVisitCountSync: boolean;
  visitCountResult: { success: boolean; message: string; mismatchCount?: number; updatedCount?: number; sampleMismatches?: any[]; dryRun?: boolean } | null;
  handleSyncVisitCounts: (dryRun: boolean) => void;
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

const IntegrityResultsPanel: React.FC<IntegrityResultsPanelProps> = ({
  results,
  expandedChecks,
  toggleCheck,
  syncingIssues,
  handleSyncPush,
  handleSyncPull,
  cancellingBookings,
  handleCancelBooking,
  loadingMemberEmail,
  handleViewProfile,
  setBookingSheet,
  fixIssueMutation,
  openIgnoreModal,
  openBulkIgnoreModal,
  getIssueTracking,
  isSyncingToHubspot,
  hubspotSyncResult,
  handleSyncMembersToHubspot,
  isRunningSubscriptionSync,
  subscriptionStatusResult,
  handleSyncSubscriptionStatus,
  isRunningOrphanedStripeCleanup,
  orphanedStripeResult,
  handleClearOrphanedStripeIds,
  isRunningStripeCustomerCleanup,
  stripeCleanupResult,
  handleCleanupStripeCustomers,
  stripeCleanupProgress,
  isRunningGhostBookingFix,
  ghostBookingResult,
  handleFixGhostBookings,
  isCleaningMindbodyIds,
  mindbodyCleanupResult,
  handleCleanupMindbodyIds,
  isRunningDealStageRemediation,
  dealStageRemediationResult,
  handleRemediateDealStages,
  isRunningStripeHubspotLink,
  stripeHubspotLinkResult,
  handleLinkStripeHubspot,
  isRunningPaymentStatusSync,
  paymentStatusResult,
  handleSyncPaymentStatus,
  isRunningVisitCountSync,
  visitCountResult,
  handleSyncVisitCounts,
  handleArchiveStaleVisitors,
  isRunningVisitorArchive,
  visitorArchiveResult,
  visitorArchiveProgress,
}) => {
  const getStatusColor = (status: 'pass' | 'warning' | 'fail') => {
    switch (status) {
      case 'pass': return 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400';
      case 'warning': return 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400';
      case 'fail': return 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400';
    }
  };

  const getCheckSeverityColor = (severity: CheckSeverity) => {
    switch (severity) {
      case 'critical': return 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400';
      case 'high': return 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400';
      case 'medium': return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400';
      case 'low': return 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400';
    }
  };

  const getSeverityColor = (severity: 'error' | 'warning' | 'info') => {
    switch (severity) {
      case 'error': return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300';
      case 'warning': return 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300';
      case 'info': return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300';
    }
  };

  const getSeverityIcon = (severity: 'error' | 'warning' | 'info') => {
    switch (severity) {
      case 'error': return 'error';
      case 'warning': return 'warning';
      case 'info': return 'info';
    }
  };

  const groupByCategory = (issues: IntegrityIssue[]) => {
    return issues.reduce((acc, issue) => {
      if (!acc[issue.category]) acc[issue.category] = [];
      acc[issue.category].push(issue);
      return acc;
    }, {} as Record<string, IntegrityIssue[]>);
  };

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case 'orphan_record': return 'Orphan Records';
      case 'missing_relationship': return 'Missing Relationships';
      case 'sync_mismatch': return 'Sync Mismatches';
      case 'data_quality': return 'Data Quality';
      default: return category;
    }
  };

  const formatContextString = (context?: IssueContext): string | null => {
    if (!context) return null;
    
    const parts: string[] = [];
    
    if (context.memberName) parts.push(context.memberName);
    if (context.guestName && !context.memberName) parts.push(context.guestName);
    if (context.memberEmail && !context.memberName) parts.push(context.memberEmail);
    if (context.memberTier) parts.push(`Tier: ${context.memberTier}`);
    
    if (context.bookingDate || context.tourDate || context.classDate || context.eventDate) {
      const date = context.bookingDate || context.tourDate || context.classDate || context.eventDate;
      if (date) {
        try {
          const formatted = new Date(date).toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: 'numeric' 
          });
          parts.push(formatted);
        } catch {
          parts.push(date);
        }
      }
    }
    
    if (context.startTime) {
      const timeStr = context.startTime.substring(0, 5);
      parts.push(timeStr);
    }
    
    if (context.resourceName) parts.push(context.resourceName);
    if (context.className && !context.eventTitle) parts.push(context.className);
    if (context.eventTitle) parts.push(context.eventTitle);
    if (context.instructor) parts.push(`Instructor: ${context.instructor}`);
    
    return parts.length > 0 ? parts.join(' • ') : null;
  };

  const renderCheckFixTools = (checkName: string) => {
    const getResultStyle = (result: { success: boolean; dryRun?: boolean } | null) => {
      if (!result) return '';
      if (!result.success) return 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700';
      if (result.dryRun) return 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700';
      return 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700';
    };
    
    const getTextStyle = (result: { success: boolean; dryRun?: boolean } | null) => {
      if (!result) return '';
      if (!result.success) return 'text-red-700 dark:text-red-400';
      if (result.dryRun) return 'text-blue-700 dark:text-blue-400';
      return 'text-green-700 dark:text-green-400';
    };

    switch (checkName) {
      case 'HubSpot Sync Mismatch':
        return (
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
              <strong>Quick Fix:</strong> Sync member data to HubSpot to resolve mismatches
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleSyncMembersToHubspot(true)}
                disabled={isSyncingToHubspot}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isSyncingToHubspot && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleSyncMembersToHubspot(false)}
                disabled={isSyncingToHubspot}
                className="px-3 py-1.5 bg-orange-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isSyncingToHubspot && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">sync</span>
                Sync to HubSpot
              </button>
            </div>
            {hubspotSyncResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(hubspotSyncResult)}`}>
                {hubspotSyncResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(hubspotSyncResult)}`}>{hubspotSyncResult.message}</p>
              </div>
            )}
          </div>
        );

      case 'Subscription Status Drift':
      case 'Stripe Subscription Sync':
        return (
          <div className="space-y-3">
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
              <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
                <strong>Sync Status:</strong> Sync membership status from Stripe to correct mismatches
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => handleSyncSubscriptionStatus(true)}
                  disabled={isRunningSubscriptionSync}
                  className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  {isRunningSubscriptionSync && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                  <span className="material-symbols-outlined text-[14px]">visibility</span>
                  Preview
                </button>
                <button
                  onClick={() => handleSyncSubscriptionStatus(false)}
                  disabled={isRunningSubscriptionSync}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  {isRunningSubscriptionSync && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                  <span className="material-symbols-outlined text-[14px]">sync</span>
                  Sync from Stripe
                </button>
              </div>
              {subscriptionStatusResult && (
                <div className={`mt-2 p-2 rounded ${getResultStyle(subscriptionStatusResult)}`}>
                  {subscriptionStatusResult.dryRun && (
                    <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                  )}
                  <p className={`text-xs ${getTextStyle(subscriptionStatusResult)}`}>{subscriptionStatusResult.message}</p>
                </div>
              )}
            </div>
            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
              <p className="text-xs text-red-700 dark:text-red-300 mb-2">
                <strong>Clear Orphaned IDs:</strong> Remove Stripe customer IDs that no longer exist in Stripe
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => handleClearOrphanedStripeIds(true)}
                  disabled={isRunningOrphanedStripeCleanup}
                  className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  {isRunningOrphanedStripeCleanup && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                  <span className="material-symbols-outlined text-[14px]">visibility</span>
                  Preview
                </button>
                <button
                  onClick={() => handleClearOrphanedStripeIds(false)}
                  disabled={isRunningOrphanedStripeCleanup}
                  className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  {isRunningOrphanedStripeCleanup && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                  <span className="material-symbols-outlined text-[14px]">delete_sweep</span>
                  Clear Orphaned IDs
                </button>
              </div>
              {orphanedStripeResult && (
                <div className={`mt-2 p-2 rounded ${getResultStyle(orphanedStripeResult)}`}>
                  {orphanedStripeResult.dryRun && (
                    <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                  )}
                  <p className={`text-xs ${getTextStyle(orphanedStripeResult)}`}>{orphanedStripeResult.message}</p>
                  {orphanedStripeResult.cleared && orphanedStripeResult.cleared.length > 0 && (
                    <div className="mt-2 max-h-24 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                      {orphanedStripeResult.cleared.map((c: any, i: number) => (
                        <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                          {c.email}: {c.stripeCustomerId}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-3">
              <p className="text-xs text-orange-700 dark:text-orange-300 mb-2">
                <strong>Cleanup Empty Customers:</strong> Delete Stripe customers that have zero charges, subscriptions, invoices, or payment intents
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => handleCleanupStripeCustomers(true)}
                  disabled={isRunningStripeCustomerCleanup}
                  className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  {isRunningStripeCustomerCleanup && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                  <span className="material-symbols-outlined text-[14px]">visibility</span>
                  Scan & Preview
                </button>
                <button
                  onClick={() => handleCleanupStripeCustomers(false)}
                  disabled={isRunningStripeCustomerCleanup || !stripeCleanupResult?.dryRun}
                  className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  {isRunningStripeCustomerCleanup && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                  <span className="material-symbols-outlined text-[14px]">delete_sweep</span>
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
                <div className={`mt-2 p-2 rounded ${getResultStyle(stripeCleanupResult)}`}>
                  {stripeCleanupResult.dryRun && (
                    <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                  )}
                  <p className={`text-xs ${getTextStyle(stripeCleanupResult)}`}>{stripeCleanupResult.message}</p>
                  {stripeCleanupResult.dryRun && stripeCleanupResult.customers && stripeCleanupResult.customers.length > 0 && (
                    <div className="mt-2 max-h-40 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                      <p className="font-medium mb-1">{stripeCleanupResult.emptyCount} empty customers found:</p>
                      {stripeCleanupResult.customers.map((c, i) => (
                        <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                          {c.email || 'No email'} — {c.name || 'No name'} ({c.id})
                        </div>
                      ))}
                    </div>
                  )}
                  {!stripeCleanupResult.dryRun && stripeCleanupResult.deleted && stripeCleanupResult.deleted.length > 0 && (
                    <div className="mt-2 max-h-24 overflow-y-auto text-xs bg-white dark:bg-white/10 rounded p-2">
                      <p className="font-medium mb-1">{stripeCleanupResult.deletedCount} customers deleted:</p>
                      {stripeCleanupResult.deleted.map((c, i) => (
                        <div key={i} className="py-1 border-b border-gray-100 dark:border-white/10 last:border-0">
                          {c.email || 'No email'} ({c.id})
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="mt-3 pt-3 border-t border-gray-200 dark:border-white/10">
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1">
                  <span className="material-symbols-outlined text-[14px]">archive</span>
                  Archive Stale Visitors
                </p>
                <div className="flex flex-wrap gap-2 mb-2">
                  <button
                    onClick={() => handleArchiveStaleVisitors(true)}
                    disabled={isRunningVisitorArchive}
                    className="px-3 py-1.5 bg-orange-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                  >
                    {isRunningVisitorArchive && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                    Scan & Preview
                  </button>
                  <button
                    onClick={() => handleArchiveStaleVisitors(false)}
                    disabled={isRunningVisitorArchive || !visitorArchiveResult?.dryRun}
                    className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                  >
                    Archive Now
                  </button>
                </div>
                {isRunningVisitorArchive && visitorArchiveProgress && (
                  <div className="p-2 rounded bg-blue-50 dark:bg-blue-900/20 mb-2">
                    <div className="flex items-center gap-1 mb-1">
                      <span className="material-symbols-outlined animate-spin text-[14px] text-blue-600">progress_activity</span>
                      <span className="text-[11px] font-medium text-blue-700 dark:text-blue-300">
                        {visitorArchiveProgress.phase === 'scanning' && 'Scanning...'}
                        {visitorArchiveProgress.phase === 'checking_stripe' && `Stripe: ${visitorArchiveProgress.checked}/${visitorArchiveProgress.totalVisitors}`}
                        {visitorArchiveProgress.phase === 'archiving' && `Archiving: ${visitorArchiveProgress.archived}/${visitorArchiveProgress.eligibleCount}`}
                      </span>
                    </div>
                    {visitorArchiveProgress.totalVisitors > 0 && (
                      <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-1.5">
                        <div 
                          className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
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
                  </div>
                )}
                {visitorArchiveResult && (
                  <div className={`p-2 rounded ${getResultStyle(visitorArchiveResult)}`}>
                    {visitorArchiveResult.dryRun && (
                      <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only</p>
                    )}
                    <p className={`text-xs ${getTextStyle(visitorArchiveResult)}`}>{visitorArchiveResult.message}</p>
                    {visitorArchiveResult.sampleArchived && visitorArchiveResult.sampleArchived.length > 0 && (
                      <div className="mt-1 max-h-24 overflow-y-auto text-[11px] bg-white dark:bg-white/10 rounded p-1">
                        {visitorArchiveResult.sampleArchived.map((v, i) => (
                          <div key={i} className="py-0.5 text-gray-600 dark:text-gray-400">
                            {v.name} ({v.email})
                          </div>
                        ))}
                        {(visitorArchiveResult.eligibleCount || 0) > 20 && (
                          <p className="text-[10px] text-gray-400">...and {(visitorArchiveResult.eligibleCount || 0) - 20} more</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );

      case 'Bookings Without Sessions':
      case 'Active Bookings Without Sessions':
        return (
          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-amber-700 dark:text-amber-300 mb-2">
              <strong>Quick Fix:</strong> Create missing billing sessions for Trackman bookings
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleFixGhostBookings(true)}
                disabled={isRunningGhostBookingFix}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningGhostBookingFix && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleFixGhostBookings(false)}
                disabled={isRunningGhostBookingFix}
                className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningGhostBookingFix && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">build</span>
                Create Sessions
              </button>
            </div>
            {ghostBookingResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(ghostBookingResult)}`}>
                {ghostBookingResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(ghostBookingResult)}`}>{ghostBookingResult.message}</p>
              </div>
            )}
          </div>
        );

      case 'Stale Mindbody IDs':
        return (
          <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-purple-700 dark:text-purple-300 mb-2">
              <strong>Quick Fix:</strong> Remove old Mindbody IDs from members no longer in Mindbody
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleCleanupMindbodyIds(true)}
                disabled={isCleaningMindbodyIds}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isCleaningMindbodyIds && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleCleanupMindbodyIds(false)}
                disabled={isCleaningMindbodyIds}
                className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isCleaningMindbodyIds && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">cleaning_services</span>
                Clean Up
              </button>
            </div>
            {mindbodyCleanupResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(mindbodyCleanupResult)}`}>
                {mindbodyCleanupResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(mindbodyCleanupResult)}`}>{mindbodyCleanupResult.message}</p>
              </div>
            )}
          </div>
        );

      case 'Deal Stage Drift':
        return (
          <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-orange-700 dark:text-orange-300 mb-2">
              <strong>Quick Fix:</strong> Update HubSpot deal stages to match current membership status
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleRemediateDealStages(true)}
                disabled={isRunningDealStageRemediation}
                className="px-3 py-1.5 bg-gray-500 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningDealStageRemediation && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                Preview
              </button>
              <button
                onClick={() => handleRemediateDealStages(false)}
                disabled={isRunningDealStageRemediation}
                className="px-3 py-1.5 bg-orange-600 text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
              >
                {isRunningDealStageRemediation && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                <span className="material-symbols-outlined text-[14px]">sync</span>
                Remediate Deal Stages
              </button>
            </div>
            {dealStageRemediationResult && (
              <div className={`mt-2 p-2 rounded ${getResultStyle(dealStageRemediationResult)}`}>
                {dealStageRemediationResult.dryRun && (
                  <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 mb-1">Preview Only - No Changes Made</p>
                )}
                <p className={`text-xs ${getTextStyle(dealStageRemediationResult)}`}>{dealStageRemediationResult.message}</p>
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      {results.length > 0 && (
        <div className="space-y-3">
          {results.map((result) => {
            const metadata = getCheckMetadata(result.checkName);
            const displayTitle = metadata?.title || result.checkName;
            const description = metadata?.description;
            const checkSeverity = metadata?.severity || 'medium';
            const isExpanded = expandedChecks.has(result.checkName);
            
            return (
              <div
                key={result.checkName}
                className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl overflow-hidden"
              >
                <button
                  onClick={() => toggleCheck(result.checkName)}
                  className="w-full p-4 flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded ${getStatusColor(result.status)}`}>
                      {result.status}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-primary dark:text-white truncate">{displayTitle}</span>
                        <span className={`px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded ${getCheckSeverityColor(checkSeverity)}`}>
                          {checkSeverity}
                        </span>
                      </div>
                      {description && (
                        <p className="text-xs text-primary/60 dark:text-white/60 truncate">{description}</p>
                      )}
                    </div>
                    {result.issueCount > 0 && (
                      <span className="bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-2 py-0.5 text-xs font-bold rounded-full shrink-0">
                        {result.issueCount}
                      </span>
                    )}
                  </div>
                  <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ml-2 ${isExpanded ? 'rotate-180' : ''}`}>
                    expand_more
                  </span>
                </button>
                
                {isExpanded && result.issues.length > 0 && (
                  <div className="px-4 pb-4 space-y-3">
                    {renderCheckFixTools(result.checkName)}
                    
                    {result.issues.filter(i => !i.ignored).length > 3 && (
                      <div className="flex justify-end">
                        <button
                          onClick={() => openBulkIgnoreModal(result.checkName, result.issues)}
                          className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 flex items-center gap-1"
                        >
                          <span className="material-symbols-outlined text-[14px]">visibility_off</span>
                          Exclude All ({result.issues.filter(i => !i.ignored).length})
                        </button>
                      </div>
                    )}
                    
                    {Object.entries(groupByCategory(result.issues)).map(([category, categoryIssues]) => (
                      <div key={category} className="space-y-2">
                        <p className="text-xs font-medium text-primary/60 dark:text-white/60 uppercase tracking-wide">
                          {getCategoryLabel(category)} ({categoryIssues.length})
                        </p>
                        {categoryIssues.map((issue, idx) => {
                          const issueKey = `${issue.table}_${issue.recordId}`;
                          const isSyncing = syncingIssues.has(issueKey);
                          const tracking = getIssueTracking(issue);
                          const contextStr = formatContextString(issue.context);
                          
                          return (
                            <div
                              key={idx}
                              className={`p-3 rounded-lg border ${getSeverityColor(issue.severity)} ${issue.ignored ? 'opacity-50' : ''}`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
                                      {getSeverityIcon(issue.severity)}
                                    </span>
                                    <span className="font-medium text-sm">{issue.description}</span>
                                    {issue.ignored && issue.ignoreInfo && (
                                      <span className="text-[10px] bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded">
                                        Ignored until {new Date(issue.ignoreInfo.expiresAt).toLocaleDateString()}
                                      </span>
                                    )}
                                  </div>
                                  {contextStr && (
                                    <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">{contextStr}</p>
                                  )}
                                  {issue.suggestion && (
                                    <p className="text-xs text-gray-500 dark:text-gray-400 italic">{issue.suggestion}</p>
                                  )}
                                  {tracking && tracking.daysUnresolved > 0 && (
                                    <p className="text-[10px] text-orange-600 dark:text-orange-400 mt-1">
                                      Unresolved for {tracking.daysUnresolved} day{tracking.daysUnresolved === 1 ? '' : 's'}
                                    </p>
                                  )}
                                  
                                  {issue.context?.syncComparison && issue.context.syncComparison.length > 0 && (
                                    <div className="mt-2 bg-white/50 dark:bg-white/5 rounded p-2">
                                      <p className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1">Field Differences</p>
                                      <div className="space-y-1">
                                        {issue.context.syncComparison.map((comp, compIdx) => (
                                          <div key={compIdx} className="grid grid-cols-3 gap-2 text-[11px]">
                                            <span className="font-medium text-gray-700 dark:text-gray-300">{comp.field}</span>
                                            <span className="text-blue-600 dark:text-blue-400 truncate" title={String(comp.appValue)}>App: {String(comp.appValue)}</span>
                                            <span className="text-orange-600 dark:text-orange-400 truncate" title={String(comp.externalValue)}>External: {String(comp.externalValue)}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                                
                                <div className="flex items-center gap-1 shrink-0">
                                  {issue.context?.syncType && !issue.ignored && (
                                    <>
                                      <button
                                        onClick={() => handleSyncPush(issue)}
                                        disabled={isSyncing}
                                        className="p-1.5 text-blue-600 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-900/30 rounded transition-colors disabled:opacity-50"
                                        title="Push app data to external system"
                                      >
                                        {isSyncing ? (
                                          <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                                        ) : (
                                          <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                                        )}
                                      </button>
                                      <button
                                        onClick={() => handleSyncPull(issue)}
                                        disabled={isSyncing}
                                        className="p-1.5 text-orange-600 hover:bg-orange-100 dark:text-orange-400 dark:hover:bg-orange-900/30 rounded transition-colors disabled:opacity-50"
                                        title="Pull external data to app"
                                      >
                                        {isSyncing ? (
                                          <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                                        ) : (
                                          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
                                        )}
                                      </button>
                                    </>
                                  )}
                                  {issue.context?.memberEmail && (
                                    <button
                                      onClick={() => handleViewProfile(issue.context!.memberEmail!)}
                                      disabled={loadingMemberEmail === issue.context.memberEmail}
                                      className="p-1.5 text-primary hover:bg-primary/10 dark:text-white dark:hover:bg-white/10 rounded transition-colors disabled:opacity-50"
                                      title="View member profile"
                                    >
                                      {loadingMemberEmail === issue.context.memberEmail ? (
                                        <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                                      ) : (
                                        <span className="material-symbols-outlined text-[16px]">person</span>
                                      )}
                                    </button>
                                  )}
                                  {issue.table === 'booking_requests' && !issue.ignored && (
                                    <>
                                      {issue.context?.trackmanBookingId && (
                                        <button
                                          onClick={() => setBookingSheet({
                                            isOpen: true,
                                            bookingId: issue.recordId as number,
                                            bayName: issue.context?.resourceName,
                                            bookingDate: issue.context?.bookingDate,
                                            timeSlot: issue.context?.startTime,
                                            memberName: issue.context?.memberName,
                                            memberEmail: issue.context?.memberEmail,
                                            trackmanBookingId: issue.context?.trackmanBookingId,
                                            importedName: issue.context?.importedName,
                                            notes: issue.context?.notes,
                                            originalEmail: issue.context?.originalEmail
                                          })}
                                          className="p-1.5 text-green-600 hover:bg-green-100 dark:text-green-400 dark:hover:bg-green-900/30 rounded transition-colors"
                                          title="Review Unmatched Booking"
                                        >
                                          <span className="material-symbols-outlined text-[16px]">calendar_month</span>
                                        </button>
                                      )}
                                      <button
                                        onClick={() => handleCancelBooking(issue.recordId as number)}
                                        disabled={cancellingBookings.has(issue.recordId as number)}
                                        className="p-1.5 text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/30 rounded transition-colors disabled:opacity-50"
                                        title="Cancel this booking"
                                      >
                                        {cancellingBookings.has(issue.recordId as number) ? (
                                          <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                                        ) : (
                                          <span className="material-symbols-outlined text-[16px]">cancel</span>
                                        )}
                                      </button>
                                    </>
                                  )}
                                  {!issue.ignored && (issue.table === 'guest_passes' || issue.table === 'booking_fee_snapshots' || issue.table === 'booking_participants') && (
                                    <button
                                      onClick={() => {
                                        if (confirm(`Delete this ${issue.table === 'guest_passes' ? 'guest pass' : issue.table === 'booking_fee_snapshots' ? 'fee snapshot' : 'participant'} record?`)) {
                                          const endpoint = issue.table === 'guest_passes'
                                            ? '/api/data-integrity/fix/delete-guest-pass'
                                            : issue.table === 'booking_fee_snapshots'
                                            ? '/api/data-integrity/fix/delete-fee-snapshot'
                                            : '/api/data-integrity/fix/delete-booking-participant';
                                          fixIssueMutation.mutate({ endpoint, body: { recordId: issue.recordId } });
                                        }
                                      }}
                                      disabled={fixIssueMutation.isPending}
                                      className="p-1.5 text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/30 rounded transition-colors disabled:opacity-50"
                                      title="Delete this orphaned record"
                                    >
                                      {fixIssueMutation.isPending ? (
                                        <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                                      ) : (
                                        <span className="material-symbols-outlined text-[16px]">delete</span>
                                      )}
                                    </button>
                                  )}
                                  {!issue.ignored && issue.context?.duplicateUsers && issue.context.duplicateUsers.length > 0 && (
                                    issue.context.duplicateUsers.map((user) => (
                                      <button
                                        key={user.userId}
                                        onClick={() => {
                                          if (confirm(`Unlink HubSpot contact from ${user.email}? This will make them a separate contact.`)) {
                                            fixIssueMutation.mutate({
                                              endpoint: '/api/data-integrity/fix/unlink-hubspot',
                                              body: { userId: user.userId, hubspotContactId: issue.context?.hubspotContactId }
                                            });
                                          }
                                        }}
                                        disabled={fixIssueMutation.isPending}
                                        className="p-1.5 text-orange-600 hover:bg-orange-100 dark:text-orange-400 dark:hover:bg-orange-900/30 rounded transition-colors disabled:opacity-50"
                                        title={`Unlink HubSpot from ${user.email}`}
                                      >
                                        {fixIssueMutation.isPending ? (
                                          <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                                        ) : (
                                          <span className="material-symbols-outlined text-[16px]">link_off</span>
                                        )}
                                      </button>
                                    ))
                                  )}
                                  {!issue.ignored && (
                                    <button
                                      onClick={() => openIgnoreModal(issue, result.checkName)}
                                      className="p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 rounded transition-colors"
                                      title="Ignore this issue"
                                    >
                                      <span className="material-symbols-outlined text-[16px]">visibility_off</span>
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {results.length > 0 && results.every(r => r.status === 'pass') && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-2xl">
          <EmptyState
            icon="verified"
            title="All Checks Passed!"
            description="No data integrity issues found."
            variant="compact"
          />
        </div>
      )}
    </>
  );
};

export default IntegrityResultsPanel;
