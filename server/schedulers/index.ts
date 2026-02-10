import { startIntegrityScheduler } from './integrityScheduler';
import { startWaiverReviewScheduler } from './waiverReviewScheduler';
import { startStripeReconciliationScheduler } from './stripeReconciliationScheduler';
import { startFeeSnapshotReconciliationScheduler } from './feeSnapshotReconciliationScheduler';
import { startGracePeriodScheduler } from './gracePeriodScheduler';
import { startBookingExpiryScheduler } from './bookingExpiryScheduler';
import { startBackgroundSyncScheduler } from './backgroundSyncScheduler';
import { startDailyReminderScheduler } from './dailyReminderScheduler';
import { startMorningClosureScheduler } from './morningClosureScheduler';
import { startWeeklyCleanupScheduler } from './weeklyCleanupScheduler';
import { startInviteExpiryScheduler } from './inviteExpiryScheduler';
import { startCommunicationLogsScheduler } from './communicationLogsScheduler';
import { startWebhookLogCleanupScheduler } from './webhookLogCleanupScheduler';
import { startHubSpotQueueScheduler } from './hubspotQueueScheduler';
import { startHubSpotFormSyncScheduler } from './hubspotFormSyncScheduler';
import { startSessionCleanupScheduler } from './sessionCleanupScheduler';
import { startUnresolvedTrackmanScheduler } from './unresolvedTrackmanScheduler';
import { startGuestPassResetScheduler } from './guestPassResetScheduler';
import { startMemberSyncScheduler } from './memberSyncScheduler';
import { startDuplicateCleanupScheduler } from './duplicateCleanupScheduler';
import { startRelocationCleanupScheduler } from './relocationCleanupScheduler';
import { startStuckCancellationScheduler } from './stuckCancellationScheduler';
import { startJobProcessor, stopJobProcessor } from '../core/jobQueue';

export function initSchedulers(): void {
  startBackgroundSyncScheduler();
  startDailyReminderScheduler();
  startMorningClosureScheduler();
  startWeeklyCleanupScheduler();
  startInviteExpiryScheduler();
  startIntegrityScheduler();
  startWaiverReviewScheduler();
  startStripeReconciliationScheduler();
  startFeeSnapshotReconciliationScheduler();
  startGracePeriodScheduler();
  startBookingExpiryScheduler();
  startCommunicationLogsScheduler();
  startWebhookLogCleanupScheduler();
  startSessionCleanupScheduler();
  startUnresolvedTrackmanScheduler();
  startHubSpotQueueScheduler();
  startHubSpotFormSyncScheduler();
  startMemberSyncScheduler();
  startDuplicateCleanupScheduler();
  startGuestPassResetScheduler();
  startRelocationCleanupScheduler();
  startStuckCancellationScheduler();
  startJobProcessor(5000);
}

export function stopSchedulers(): void {
  stopJobProcessor();
}
