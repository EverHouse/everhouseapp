import { startIntegrityScheduler } from './integrityScheduler';
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
import { startStuckCancellationScheduler, stopStuckCancellationScheduler } from './stuckCancellationScheduler';
import { startPendingUserCleanupScheduler, stopPendingUserCleanupScheduler } from './pendingUserCleanupScheduler';
import { startWebhookEventCleanupScheduler, stopWebhookEventCleanupScheduler } from './webhookEventCleanupScheduler';
import { startOnboardingNudgeScheduler, stopOnboardingNudgeScheduler } from './onboardingNudgeScheduler';
import { startSupabaseHeartbeatScheduler, stopSupabaseHeartbeatScheduler } from './supabaseHeartbeatScheduler';
import { startNotificationCleanupScheduler, stopNotificationCleanupScheduler } from './notificationCleanupScheduler';
import { stopRealtimeRecovery } from '../core/supabase/client';
import { startJobProcessor, stopJobProcessor } from '../core/jobQueue';
import { schedulerTracker } from '../core/schedulerTracker';
import { isProduction } from '../core/db';
import { logger } from '../core/logger';

const intervalIds: NodeJS.Timeout[] = [];
const staggerTimeouts: NodeJS.Timeout[] = [];

const STAGGER_INTERVAL_MS = 10_000;

function staggerStart(delayMs: number, name: string, fn: () => void): void {
  const timeout = setTimeout(() => {
    try {
      logger.info(`[Schedulers] Starting ${name} (staggered +${Math.round(delayMs / 1000)}s)`);
      fn();
    } catch (err) {
      logger.error(`[Schedulers] Failed to start ${name}:`, { error: err as Error });
    }
  }, delayMs);
  staggerTimeouts.push(timeout);
}

export function initSchedulers(): void {
  if (!isProduction) {
    logger.info('[Schedulers] Skipping all schedulers in dev — production handles background tasks on the shared database');
    return;
  }

  schedulerTracker.registerScheduler('Background Sync', 5 * 60 * 1000);
  schedulerTracker.registerScheduler('Daily Reminder', 30 * 60 * 1000);
  schedulerTracker.registerScheduler('Morning Closure', 30 * 60 * 1000);
  schedulerTracker.registerScheduler('Weekly Cleanup', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Integrity Check', 30 * 60 * 1000);
  schedulerTracker.registerScheduler('Auto-Fix Tiers', 24 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Abandoned Pending Cleanup', 6 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Waiver Review', 4 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Stripe Reconciliation', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Fee Snapshot Reconciliation', 15 * 60 * 1000);
  schedulerTracker.registerScheduler('Grace Period', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Booking Expiry', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Booking Auto-Complete', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Communication Logs Sync', 30 * 60 * 1000);
  schedulerTracker.registerScheduler('Webhook Log Cleanup', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Session Cleanup', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Unresolved Trackman', 15 * 60 * 1000);
  schedulerTracker.registerScheduler('HubSpot Queue', 2 * 60 * 1000);
  schedulerTracker.registerScheduler('HubSpot Form Sync', 30 * 60 * 1000);
  schedulerTracker.registerScheduler('Member Sync', 24 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Duplicate Cleanup', 24 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Guest Pass Reset', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Stuck Cancellation', 2 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Pending User Cleanup', 6 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Webhook Event Cleanup', 24 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Onboarding Nudge', 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Supabase Heartbeat', 6 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Notification Cleanup', 24 * 60 * 60 * 1000);
  schedulerTracker.registerScheduler('Job Queue Processor', 5000);

  logger.info(`[Schedulers] Staggering scheduler startup over ~${26 * STAGGER_INTERVAL_MS / 1000}s to prevent DB connection spikes`);

  let slot = 0;

  // ── Wave 1: Real-time / high-frequency (immediate → +20s) ──
  staggerStart(slot * STAGGER_INTERVAL_MS, 'Job Queue Processor', () => startJobProcessor(5000));
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Supabase Heartbeat', () => startSupabaseHeartbeatScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'HubSpot Queue', () => startHubSpotQueueScheduler());
  slot++;

  // ── Wave 2: Booking & calendar syncs (+30s → +70s) ──
  staggerStart(slot * STAGGER_INTERVAL_MS, 'Background Sync', () => startBackgroundSyncScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Booking Expiry', () => startBookingExpiryScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Booking Auto-Complete', () => startBookingAutoCompleteScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Unresolved Trackman', () => startUnresolvedTrackmanScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Fee Snapshot Reconciliation', () => startFeeSnapshotReconciliationScheduler());
  slot++;

  // ── Wave 3: Notifications & communication (+80s → +110s) ──
  staggerStart(slot * STAGGER_INTERVAL_MS, 'Daily Reminder', () => startDailyReminderScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Morning Closure', () => startMorningClosureScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Communication Logs Sync', () => startCommunicationLogsScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Onboarding Nudge', () => startOnboardingNudgeScheduler());
  slot++;

  // ── Wave 4: Financial & billing (+120s → +160s) ──
  staggerStart(slot * STAGGER_INTERVAL_MS, 'Stripe Reconciliation', () => startStripeReconciliationScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Grace Period', () => startGracePeriodScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Guest Pass Reset', () => startGuestPassResetScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Stuck Cancellation', () => startStuckCancellationScheduler());
  slot++;

  slot++;

  // ── Wave 5: HubSpot & external syncs (+170s → +200s) ──
  staggerStart(slot * STAGGER_INTERVAL_MS, 'HubSpot Form Sync', () => startHubSpotFormSyncScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Member Sync', () => startMemberSyncScheduler());
  slot++;

  // ── Wave 6: Integrity & cleanup (+210s → +270s) ──
  staggerStart(slot * STAGGER_INTERVAL_MS, 'Integrity Check', () => {
    intervalIds.push(...startIntegrityScheduler());
  });
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Weekly Cleanup', () => {
    intervalIds.push(startWeeklyCleanupScheduler());
  });
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Session Cleanup', () => {
    intervalIds.push(startSessionCleanupScheduler());
  });
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Webhook Log Cleanup', () => {
    intervalIds.push(startWebhookLogCleanupScheduler());
  });
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Webhook Event Cleanup', () => startWebhookEventCleanupScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Duplicate Cleanup', () => {
    intervalIds.push(startDuplicateCleanupScheduler());
  });
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Pending User Cleanup', () => startPendingUserCleanupScheduler());
  slot++;

  staggerStart(slot * STAGGER_INTERVAL_MS, 'Notification Cleanup', () => startNotificationCleanupScheduler());
  // eslint-disable-next-line no-useless-assignment
  slot++;
}

export function stopSchedulers(): void {
  for (const timeout of staggerTimeouts) {
    clearTimeout(timeout);
  }
  staggerTimeouts.length = 0;

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

  stopUnresolvedTrackmanScheduler();
  stopHubSpotQueueScheduler();
  stopHubSpotFormSyncScheduler();
  stopOnboardingNudgeScheduler();
  stopMemberSyncScheduler();
  stopBackgroundSyncScheduler();
  stopSupabaseHeartbeatScheduler();
  stopNotificationCleanupScheduler();
  stopRealtimeRecovery();
  stopJobProcessor();
}
