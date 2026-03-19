import { schedulerTracker } from '../core/schedulerTracker';
import { queryWithRetry } from '../core/db';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { sendOnboardingNudge24h, sendOnboardingNudge72h, sendOnboardingNudge7d } from '../emails/onboardingNudgeEmails';
import { logger } from '../core/logger';
import { getSettingValue } from '../core/settingsHelper';
import { getErrorMessage } from '../utils/errorUtils';

const DEFAULT_NUDGE_CHECK_HOUR = 10;
let lastNudgeDate: string | null = null;

async function processOnboardingNudges(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const today = getTodayPacific();
    const nudgeHour = Number(await getSettingValue('scheduling.onboarding_nudge_hour', String(DEFAULT_NUDGE_CHECK_HOUR)));
    if (currentHour < nudgeHour || currentHour >= nudgeHour + 3 || lastNudgeDate === today) return;
    lastNudgeDate = today;

    logger.info('[Onboarding Nudge] Starting onboarding nudge check...');

    const maxNudges = Number(await getSettingValue('scheduling.max_onboarding_nudges', '3'));
    const membersResult = await queryWithRetry(
      `SELECT id, email, first_name, created_at, onboarding_nudge_count
      FROM users
      WHERE membership_status IN ('active', 'trialing')
        AND billing_provider = 'stripe'
        AND first_login_at IS NULL
        AND onboarding_completed_at IS NULL
        AND onboarding_nudge_count < $1
        AND (onboarding_last_nudge_at IS NULL OR onboarding_last_nudge_at < NOW() - INTERVAL '20 hours')
        AND created_at < NOW() - INTERVAL '20 hours'
        AND archived_at IS NULL
      ORDER BY created_at ASC
      LIMIT 20`,
      [maxNudges],
      3
    );

    if (membersResult.rows.length === 0) {
      logger.info('[Onboarding Nudge] No stalled members found');
      return;
    }

    logger.info(`[Onboarding Nudge] Found ${membersResult.rows.length} stalled members to nudge`);

    for (const rawMember of membersResult.rows) {
      const member = rawMember as { email: string; first_name: string; created_at: string; onboarding_nudge_count: number; id: number };
      const hoursSinceSignup = (Date.now() - new Date(String(member.created_at)).getTime()) / (1000 * 60 * 60);
      const currentNudgeCount = member.onboarding_nudge_count || 0;

      let sendResult: { success: boolean; error?: string } = { success: false };

      if (currentNudgeCount === 0 && hoursSinceSignup >= 24) {
        sendResult = await sendOnboardingNudge24h(String(member.email), String(member.first_name));
      } else if (currentNudgeCount === 1 && hoursSinceSignup >= 72) {
        sendResult = await sendOnboardingNudge72h(String(member.email), String(member.first_name));
      } else if (currentNudgeCount === 2 && hoursSinceSignup >= 168) {
        sendResult = await sendOnboardingNudge7d(String(member.email), String(member.first_name));
      } else {
        continue;
      }

      if (sendResult.success) {
        await queryWithRetry(
          `UPDATE users SET onboarding_nudge_count = onboarding_nudge_count + 1, onboarding_last_nudge_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [member.id],
          3
        );
        logger.info(`[Onboarding Nudge] Sent nudge #${currentNudgeCount + 1} to ${member.email}`);
      } else {
        logger.warn(`[Onboarding Nudge] Failed to send to ${member.email}: ${sendResult.error}`);
      }
    }
  } catch (error: unknown) {
    logger.error('[Onboarding Nudge] Scheduler error:', { error: error as Error });
    lastNudgeDate = null;
    try {
      const { notifyAllStaff } = await import('../core/staffNotifications');
      await notifyAllStaff('Onboarding Nudge Failed', `Scheduler error: ${getErrorMessage(error)}`, 'system_error');
    } catch {
      logger.error('[Onboarding Nudge] Failed to send staff alert for scheduler failure');
    }
  }
}

let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

export function startOnboardingNudgeScheduler(): void {
  if (intervalId) {
    logger.info('[Onboarding Nudge] Scheduler already running');
    return;
  }

  const interval = 60 * 60 * 1000;
  logger.info('[Scheduler] Onboarding Nudge scheduler started (runs at 10 AM Pacific)');
  intervalId = setInterval(() => {
    if (isRunning) {
      logger.info('[Onboarding Nudge] Skipping run — previous run still in progress');
      return;
    }
    isRunning = true;
    processOnboardingNudges()
      .then(() => schedulerTracker.recordRun('Onboarding Nudge', true))
      .catch((err: unknown) => {
        logger.error('[Onboarding Nudge] Uncaught error:', { error: err as Error });
        schedulerTracker.recordRun('Onboarding Nudge', false, getErrorMessage(err));
      })
      .finally(() => { isRunning = false; });
  }, interval);
}

export function stopOnboardingNudgeScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Onboarding Nudge] Scheduler stopped');
  }
}
