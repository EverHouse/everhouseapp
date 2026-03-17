import React from 'react';
import { putWithCredentials } from '../../../hooks/queries/useFetch';
import { formatTimeAgo, downloadCSV } from './dataIntegrity/dataIntegrityUtils';
import { useDataIntegrityState } from './dataIntegrity/useDataIntegrityState';
import { useDataIntegrityActions } from './dataIntegrity/useDataIntegrityActions';
import HealthStatusGrid from './dataIntegrity/HealthStatusGrid';
import IntegritySummaryStats from './dataIntegrity/IntegritySummaryStats';
import CalendarStatusSection from './dataIntegrity/CalendarStatusSection';
import HistorySection from './dataIntegrity/HistorySection';
import IntegrityResultsPanel from './dataIntegrity/IntegrityResultsPanel';
import SyncToolsPanel from './dataIntegrity/SyncToolsPanel';
import CleanupToolsPanel from './dataIntegrity/CleanupToolsPanel';
import SchedulerMonitorPanel from './dataIntegrity/SchedulerMonitorPanel';
import WebhookEventsPanel from './dataIntegrity/WebhookEventsPanel';
import JobQueuePanel from './dataIntegrity/JobQueuePanel';
import HubSpotQueuePanel from './dataIntegrity/HubSpotQueuePanel';
import AlertHistoryPanel from './dataIntegrity/AlertHistoryPanel';
import PushNotificationPanel from './dataIntegrity/PushNotificationPanel';
import AutoApprovePanel from './dataIntegrity/AutoApprovePanel';
import AuditLogPanel from './dataIntegrity/AuditLogPanel';
import StripeTerminalPanel from './dataIntegrity/StripeTerminalPanel';
import EmailHealthPanel from './dataIntegrity/EmailHealthPanel';
import MarketingContactsAuditPanel from './dataIntegrity/MarketingContactsAuditPanel';
import IgnoreModals from './dataIntegrity/IgnoreModals';
import MemberProfileDrawer from '../../../components/MemberProfileDrawer';
import { UnifiedBookingSheet } from '../../../components/staff-command-center/modals/UnifiedBookingSheet';
import { DataIntegritySkeleton } from '../../../components/skeletons';


const DataIntegrityTab: React.FC = () => {
  const state = useDataIntegrityState();
  const actions = useDataIntegrityActions(state);

  return (
    <div className="space-y-6 animate-page-enter pb-32">
      <HealthStatusGrid
        systemHealth={state.systemHealth}
        isCheckingHealth={state.isCheckingHealth}
        onCheckHealth={actions.handleCheckHealth}
      />

      <div className="mb-6 flex flex-col gap-3">
        <div className="flex gap-3">
          <button
            onClick={actions.runIntegrityChecks}
            disabled={actions.isRunning || actions.isLoadingCached}
            className="tactile-btn flex-1 py-3 px-4 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-xl font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {actions.isRunning ? (
              <>
                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                Running Checks...
              </>
            ) : (
              <>
                <span aria-hidden="true" className="material-symbols-outlined text-[20px]">{actions.isCached ? 'refresh' : 'fact_check'}</span>
                {actions.isCached ? 'Refresh Checks' : 'Run Integrity Checks'}
              </>
            )}
          </button>
          {actions.results.length > 0 && (
            <button
              onClick={() => downloadCSV(actions.results)}
              disabled={!actions.hasIssues}
              className="tactile-btn py-3 px-4 border-2 border-primary dark:border-white/40 text-primary dark:text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[20px]">download</span>
              Download CSV
            </button>
          )}
        </div>
        {actions.meta?.lastRun && actions.isCached && (
          <p className="text-sm text-primary/60 dark:text-white/60 text-center">
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] align-middle mr-1">schedule</span>
            Last checked {formatTimeAgo(actions.meta.lastRun)}
          </p>
        )}
      </div>

      {actions.isLoadingCached && !actions.meta && (
        <DataIntegritySkeleton />
      )}

      <IntegritySummaryStats
        meta={actions.meta}
        errorCount={actions.errorCount}
        warningCount={actions.warningCount}
        infoCount={actions.infoCount}
      />

      <CalendarStatusSection
        showCalendars={state.showCalendars}
        onToggle={() => state.setShowCalendars(!state.showCalendars)}
        isLoadingCalendars={actions.isLoadingCalendars}
        calendarStatus={actions.calendarStatus}
      />

      <HistorySection
        showHistory={state.showHistory}
        onToggleHistory={() => state.setShowHistory(!state.showHistory)}
        isLoadingHistory={actions.isLoadingHistory}
        historyData={actions.historyData}
      />

      <IntegrityResultsPanel
        results={actions.results}
        expandedChecks={state.expandedChecks}
        toggleCheck={state.toggleCheck}
        syncingIssues={state.syncingIssues}
        handleSyncPush={actions.handleSyncPush}
        handleSyncPull={actions.handleSyncPull}
        cancellingBookings={state.cancellingBookings}
        handleCancelBooking={actions.handleCancelBooking}
        loadingMemberEmail={state.loadingMemberEmail}
        handleViewProfile={actions.handleViewProfile}
        setBookingSheet={state.setBookingSheet}
        fixIssueMutation={actions.fixIssueMutation}
        fixingIssues={state.fixingIssues}
        isRefreshing={actions.runIntegrityMutation.isPending}
        openIgnoreModal={actions.openIgnoreModal}
        openBulkIgnoreModal={actions.openBulkIgnoreModal}
        getIssueTracking={actions.getIssueTrackingForIssue}
        isSyncingToHubspot={actions.isSyncingToHubspot}
        hubspotSyncResult={state.hubspotSyncResult}
        handleSyncMembersToHubspot={actions.handleSyncMembersToHubspot}
        isRunningSubscriptionSync={actions.isRunningSubscriptionSync}
        subscriptionStatusResult={state.subscriptionStatusResult}
        handleSyncSubscriptionStatus={actions.handleSyncSubscriptionStatus}
        isRunningOrphanedStripeCleanup={actions.isRunningOrphanedStripeCleanup}
        orphanedStripeResult={state.orphanedStripeResult}
        handleClearOrphanedStripeIds={actions.handleClearOrphanedStripeIds}
        isRunningStripeCustomerCleanup={actions.isRunningStripeCustomerCleanup}
        stripeCleanupResult={state.stripeCleanupResult}
        handleCleanupStripeCustomers={actions.handleCleanupStripeCustomers}
        stripeCleanupProgress={state.stripeCleanupProgress}
        isRunningGhostBookingFix={actions.isRunningGhostBookingFix}
        ghostBookingResult={state.ghostBookingResult}
        handleFixGhostBookings={actions.handleFixGhostBookings}
        isCleaningMindbodyIds={actions.isCleaningMindbodyIds}
        mindbodyCleanupResult={state.mindbodyCleanupResult}
        handleCleanupMindbodyIds={actions.handleCleanupMindbodyIds}
        isRunningStripeHubspotLink={actions.isRunningStripeHubspotLink}
        stripeHubspotLinkResult={state.stripeHubspotLinkResult}
        handleLinkStripeHubspot={actions.handleLinkStripeHubspot}
        isRunningPaymentStatusSync={actions.isRunningPaymentStatusSync}
        paymentStatusResult={state.paymentStatusResult}
        handleSyncPaymentStatus={actions.handleSyncPaymentStatus}
        isRunningVisitCountSync={actions.isRunningVisitCountSync}
        visitCountResult={state.visitCountResult}
        handleSyncVisitCounts={actions.handleSyncVisitCounts}
        handleArchiveStaleVisitors={actions.handleArchiveStaleVisitors}
        isRunningVisitorArchive={state.isRunningVisitorArchive}
        visitorArchiveResult={state.visitorArchiveResult}
        visitorArchiveProgress={state.visitorArchiveProgress}
        isRunningOrphanedParticipantFix={actions.isRunningOrphanedParticipantFix}
        orphanedParticipantResult={state.orphanedParticipantResult}
        handleFixOrphanedParticipants={actions.handleFixOrphanedParticipants}
        isRunningReviewItemsApproval={actions.isRunningReviewItemsApproval}
        reviewItemsResult={state.reviewItemsResult}
        handleApproveAllReviewItems={actions.handleApproveAllReviewItems}
      />

      <SyncToolsPanel
        showDataTools={state.showDataTools}
        setShowDataTools={state.setShowDataTools}
        resyncEmail={state.resyncEmail}
        setResyncEmail={state.setResyncEmail}
        handleResyncMember={actions.handleResyncMember}
        isResyncing={actions.isResyncing}
        resyncResult={state.resyncResult}
        handleReconcileGroupBilling={actions.handleReconcileGroupBilling}
        isReconciling={actions.isReconciling}
        reconcileResult={state.reconcileResult}
        handleBackfillStripeCache={actions.handleBackfillStripeCache}
        isBackfillingStripeCache={actions.isBackfillingStripeCache}
        stripeCacheResult={state.stripeCacheResult}
        handleDetectDuplicates={actions.handleDetectDuplicates}
        isRunningDuplicateDetection={actions.isRunningDuplicateDetection}
        duplicateDetectionResult={state.duplicateDetectionResult}
        expandedDuplicates={state.expandedDuplicates}
        setExpandedDuplicates={state.setExpandedDuplicates}
        handleCleanupStripeCustomers={actions.handleCleanupStripeCustomers}
        isRunningStripeCustomerCleanup={actions.isRunningStripeCustomerCleanup}
        stripeCleanupResult={state.stripeCleanupResult}
        stripeCleanupProgress={state.stripeCleanupProgress}
        handleArchiveStaleVisitors={actions.handleArchiveStaleVisitors}
        isRunningVisitorArchive={state.isRunningVisitorArchive}
        visitorArchiveResult={state.visitorArchiveResult}
        visitorArchiveProgress={state.visitorArchiveProgress}
      />

      <CleanupToolsPanel
        showPlaceholderCleanup={state.showPlaceholderCleanup}
        setShowPlaceholderCleanup={state.setShowPlaceholderCleanup}
        handleScanPlaceholders={actions.handleScanPlaceholders}
        isLoadingPlaceholders={actions.isLoadingPlaceholders}
        placeholderAccounts={state.placeholderAccounts}
        showDeleteConfirm={state.showDeleteConfirm}
        setShowDeleteConfirm={state.setShowDeleteConfirm}
        handleDeletePlaceholders={actions.handleDeletePlaceholders}
        isDeletingPlaceholders={actions.isDeletingPlaceholders}
        placeholderDeleteResult={state.placeholderDeleteResult}
      />

      <SchedulerMonitorPanel
        isOpen={state.showSchedulerMonitor}
        onToggle={() => state.setShowSchedulerMonitor(!state.showSchedulerMonitor)}
      />

      <WebhookEventsPanel
        isOpen={state.showWebhookEvents}
        onToggle={() => state.setShowWebhookEvents(!state.showWebhookEvents)}
      />

      <JobQueuePanel
        isOpen={state.showJobQueue}
        onToggle={() => state.setShowJobQueue(!state.showJobQueue)}
      />

      <HubSpotQueuePanel
        isOpen={state.showHubSpotQueue}
        onToggle={() => state.setShowHubSpotQueue(!state.showHubSpotQueue)}
      />

      <AlertHistoryPanel
        isOpen={state.showAlertHistory}
        onToggle={() => state.setShowAlertHistory(!state.showAlertHistory)}
      />

      <PushNotificationPanel
        isOpen={state.showPushNotifications}
        onToggle={() => state.setShowPushNotifications(!state.showPushNotifications)}
      />

      <AutoApprovePanel
        isOpen={state.showAutoApprove}
        onToggle={() => state.setShowAutoApprove(!state.showAutoApprove)}
      />

      <AuditLogPanel
        isOpen={state.showAuditLog}
        onToggle={() => state.setShowAuditLog(!state.showAuditLog)}
      />

      <StripeTerminalPanel
        isOpen={state.showStripeTerminal}
        onToggle={() => state.setShowStripeTerminal(!state.showStripeTerminal)}
      />

      <EmailHealthPanel
        isOpen={state.showEmailHealth}
        onToggle={() => state.setShowEmailHealth(!state.showEmailHealth)}
      />

      <MarketingContactsAuditPanel
        isOpen={state.showMarketingAudit}
        onToggle={() => state.setShowMarketingAudit(!state.showMarketingAudit)}
      />

      <IgnoreModals
        ignoreModal={state.ignoreModal}
        bulkIgnoreModal={state.bulkIgnoreModal}
        ignoreDuration={state.ignoreDuration}
        setIgnoreDuration={state.setIgnoreDuration}
        ignoreReason={state.ignoreReason}
        setIgnoreReason={state.setIgnoreReason}
        handleIgnoreIssue={actions.handleIgnoreIssue}
        closeIgnoreModal={actions.closeIgnoreModal}
        handleBulkIgnore={actions.handleBulkIgnore}
        closeBulkIgnoreModal={actions.closeBulkIgnoreModal}
        isIgnoring={actions.isIgnoring}
        isBulkIgnoring={actions.isBulkIgnoring}
      />

      <MemberProfileDrawer
        isOpen={state.isProfileDrawerOpen}
        member={state.selectedMember}
        isAdmin={true}
        onClose={() => {
          state.setIsProfileDrawerOpen(false);
          state.setSelectedMember(null);
        }}
        onViewAs={() => {}}
        onMemberDeleted={() => {
          state.setIsProfileDrawerOpen(false);
          state.setSelectedMember(null);
          actions.runIntegrityMutation.mutate();
        }}
        onMemberUpdated={() => {
          actions.runIntegrityMutation.mutate();
        }}
      />

      <UnifiedBookingSheet
        isOpen={state.bookingSheet.isOpen}
        onClose={() => state.setBookingSheet({ isOpen: false, bookingId: null })}
        mode={state.bookingSheet.isUnmatched ? "assign" : "manage"}
        trackmanBookingId={state.bookingSheet.trackmanBookingId || null}
        sessionId={state.bookingSheet.sessionId}
        bayName={state.bookingSheet.bayName}
        bookingDate={state.bookingSheet.bookingDate}
        timeSlot={state.bookingSheet.timeSlot}
        bookingId={state.bookingSheet.bookingId || undefined}
        matchedBookingId={state.bookingSheet.isUnmatched ? undefined : (state.bookingSheet.bookingId || undefined)}
        currentMemberName={state.bookingSheet.memberName}
        currentMemberEmail={state.bookingSheet.memberEmail}
        importedName={state.bookingSheet.importedName}
        notes={state.bookingSheet.notes}
        originalEmail={state.bookingSheet.originalEmail}
        onCancelBooking={(bookingId) => {
          actions.cancelBookingMutation.mutate(bookingId, {
            onSuccess: () => {
              state.setBookingSheet({ isOpen: false, bookingId: null });
              actions.runIntegrityMutation.mutate();
            }
          });
        }}
        onCheckIn={async (bookingId, targetStatus) => {
          const statusToSet = targetStatus || 'attended';
          try {
            await putWithCredentials(`/api/bookings/${bookingId}/checkin`, {
                status: statusToSet === 'no_show' ? 'no_show' : 'attended',
                skipPaymentCheck: true,
                skipRosterCheck: true
              });
            state.setBookingSheet({ isOpen: false, bookingId: null });
            actions.runIntegrityMutation.mutate();
          } catch (error) {
            console.error('Check-in failed:', error);
          }
        }}
        onSuccess={() => {
          state.setBookingSheet({ isOpen: false, bookingId: null });
          actions.runIntegrityMutation.mutate();
        }}
      />
    </div>
  );
};

export default DataIntegrityTab;
