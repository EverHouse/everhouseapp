import { startIntegrityScheduler } from './integrityScheduler';
import { startWaiverReviewScheduler, stopWaiverReviewScheduler } from './waiverReviewScheduler';
import { startStripeReconciliationScheduler, stopStripeReconciliationScheduler } from './stripeReconciliationScheduler';
import { startFeeSnapshotReconciliationScheduler, stopFeeSnapshotReconciliationScheduler } from './feeSnapshotReconciliationScheduler';
import { startGracePeriodScheduler, stopGracePeriodScheduler } from './gracePeriodScheduler';
import { startBookingExpiryScheduler, stopBookingExpiryScheduler } from './bookingExpiryScheduler';
import { startBookingAutoCompleteScheduler, stopBookingAutoCompleteScheduler } from './bookingAutoCompleteScheduler';
import { startBackgroundSyncScheduler, stopBackgroundSyncScheduler } from './backgroundSyncScheduler';
import { startDailyReminderScheduler, stopDailyReminderScheduler } from './dailyReminderScheduler';
import { startMorningClosureScheduler, stopMorningClosureScheduler } from './morningClosureScheduler';
import { startWeeklyCleanupScheduler } from './weeklyCleanupScheduler';
import { startCommunicationLogsScheduler, stopCommunicationLogsScheduler } from './communicationLogsScheduler';
import { startWebhookLogCleanupScheduler } from './webhookLogCleanupScheduler';
import { startHubSpotQueueScheduler, stopHubSpotQueueScheduler } from './hubspotQueueScheduler';
import { startHubSpotFormSyncScheduler, stopHubSpotFormSyncScheduler } from './hubspotFormSyncScheduler';
import { startSessionCleanupScheduler } from './sessionCleanupScheduler';
import { startUnresolvedTrackmanScheduler, stopUnresolvedTrackmanScheduler } from './unresolvedTrackmanScheduler';
import { startGuestPassResetScheduler, stopGuestPassResetScheduler } from './guestPassResetScheduler';
import { startMemberSyncScheduler, stopMemberSyncScheduler } from './memberSyncScheduler';
import { startDuplicateCleanupScheduler } from './duplicateCleanupScheduler';
import { startRelocationCleanupScheduler } from './relocationCleanupScheduler';
import { startStuckCancellationScheduler, stopStuckCancellationScheduler } from './stuckCancellationScheduler';
import { startPendingUserCleanupScheduler, stopPendingUserCleanupScheduler } from './pendingUserCleanupScheduler';
import { startWebhookEventCleanupScheduler, stopWebhookEventCleanupScheduler } from './webhookEventCleanupScheduler';
import { startOnboardingNudgeScheduler, stopOnboardingNudgeScheduler } from './onboardingNudgeScheduler';
import { startSupabaseHeartbeatScheduler, stopSupabaseHeartbeatScheduler } from './supabaseHeartbeatScheduler';
import { startJobProcessor, stopJobProcessor } from '../core/jobQueue';
import { schedulerTracker } from '../core/schedulerTracker';

const intervalIds: NodeJS.Timeout[] = [];

export function initSchedulers(): void {
  schedulerTracker.registerScheduler('Background Sync', 5 * 60 * 1000);
  schedulerTracker.registerScheduler('Daily Reminder', 30 * 60 * 1000);
  schedulerTracker.registerScheduler('Morning Closure', 30 * 60 * 1000);
  schedulerTracker.registerScheduler('Weekly Cleanup', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Integrity Check', 30 * 60 * 1000);
  schedulerTracker.registerScheduler('Auto-Fix Tiers', 4 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Abandoned Pending Cleanup', 6 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Waiver Review', 4 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Stripe Reconciliation', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Fee Snapshot Reconciliation', 15 * 60 * 1000);
  schedulerTracker.registerScheduler('Grace Period', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Booking Expiry', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Booking Auto-Complete', 2 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Communication Logs Sync', 30 * 60 * 1000);
  schedulerTracker.registerScheduler('Webhook Log Cleanup', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Session Cleanup', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Unresolved Trackman', 15 * 60 * 1000);
  schedulerTracker.registerScheduler('HubSpot Queue', 2 * 60 * 1000);
  schedulerTracker.registerScheduler('HubSpot Form Sync', 30 * 60 * 1000);
  schedulerTracker.registerScheduler('Member Sync', 24 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Duplicate Cleanup', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Guest Pass Reset', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Relocation Cleanup', 5 * 60 * 1000);
  schedulerTracker.registerScheduler('Stuck Cancellation', 2 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Pending User Cleanup', 6 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Webhook Event Cleanup', 24 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Onboarding Nudge', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Supabase Heartbeat', 6 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Job Queue Processor', 5000);

  startBackgroundSyncScheduler();
  startDailyReminderScheduler();
  startMorningClosureScheduler();
  intervalIds.push(startWeeklyCleanupScheduler());
  intervalIds.push(...startIntegrityScheduler());
  startWaiverReviewScheduler();
  startStripeReconciliationScheduler();
  startFeeSnapshotReconciliationScheduler();
  startGracePeriodScheduler();
  startBookingExpiryScheduler();
  startBookingAutoCompleteScheduler();
  startCommunicationLogsScheduler();
  intervalIds.push(startWebhookLogCleanupScheduler());
  intervalIds.push(startSessionCleanupScheduler());
  startUnresolvedTrackmanScheduler();
  startHubSpotQueueScheduler();
  startHubSpotFormSyncScheduler();
  startMemberSyncScheduler();
  intervalIds.push(startDuplicateCleanupScheduler());
  startGuestPassResetScheduler();
  intervalIds.push(startRelocationCleanupScheduler());
  startStuckCancellationScheduler();
  startPendingUserCleanupScheduler();
  startWebhookEventCleanupScheduler();
  startOnboardingNudgeScheduler();
  startSupabaseHeartbeatScheduler();
  startJobProcessor(5000);
}

export function stopSchedulers(): void {
  for (const id of intervalIds) {
    clearInterval(id);
  }
  intervalIds.length = 0;

  stopStripeReconciliationScheduler();
  stopFeeSnapshotReconciliationScheduler();
  stopGracePeriodScheduler();
  stopBookingExpiryScheduler();
  stopBookingAutoCompleteScheduler();
  stopGuestPassResetScheduler();
  stopStuckCancellationScheduler();
  stopPendingUserCleanupScheduler();
  stopWebhookEventCleanupScheduler();
  stopCommunicationLogsScheduler();
  stopDailyReminderScheduler();
  stopMorningClosureScheduler();
  stopWaiverReviewScheduler();
  stopUnresolvedTrackmanScheduler();
  stopHubSpotQueueScheduler();
  stopHubSpotFormSyncScheduler();
  stopOnboardingNudgeScheduler();
  stopMemberSyncScheduler();
  stopBackgroundSyncScheduler();
  stopSupabaseHeartbeatScheduler();
  stopJobProcessor();
}
