import { schedulerTracker } from '../core/schedulerTracker';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getPacificHour } from '../utils/dateUtils';
import { sendOnboardingNudge24h, sendOnboardingNudge72h, sendOnboardingNudge7d } from '../emails/onboardingNudgeEmails';
import { logger } from '../core/logger';

const NUDGE_CHECK_HOUR = 10; // 10 AM Pacific

async function processOnboardingNudges(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    if (currentHour !== NUDGE_CHECK_HOUR) return;

    logger.info('[Onboarding Nudge] Starting onboarding nudge check...');

    const membersResult = await db.execute(sql`
      SELECT id, email, first_name, created_at, onboarding_nudge_count
      FROM users
      WHERE membership_status IN ('active', 'trialing')
        AND billing_provider = 'stripe'
        AND first_login_at IS NULL
        AND onboarding_completed_at IS NULL
        AND onboarding_nudge_count < 3
        AND (onboarding_last_nudge_at IS NULL OR onboarding_last_nudge_at < NOW() - INTERVAL '20 hours')
        AND created_at < NOW() - INTERVAL '20 hours'
        AND archived_at IS NULL
      ORDER BY created_at ASC
      LIMIT 20
    `);

    if (membersResult.rows.length === 0) {
      logger.info('[Onboarding Nudge] No stalled members found');
      return;
    }

    logger.info(`[Onboarding Nudge] Found ${membersResult.rows.length} stalled members to nudge`);

    for (const member of membersResult.rows) {
      const hoursSinceSignup = (Date.now() - new Date(member.created_at).getTime()) / (1000 * 60 * 60);
      const currentNudgeCount = member.onboarding_nudge_count || 0;

      let sendResult: { success: boolean; error?: string } = { success: false };

      if (currentNudgeCount === 0 && hoursSinceSignup >= 24) {
        sendResult = await sendOnboardingNudge24h(member.email, member.first_name);
      } else if (currentNudgeCount === 1 && hoursSinceSignup >= 72) {
        sendResult = await sendOnboardingNudge72h(member.email, member.first_name);
      } else if (currentNudgeCount === 2 && hoursSinceSignup >= 168) {
        sendResult = await sendOnboardingNudge7d(member.email, member.first_name);
      } else {
        continue;
      }

      if (sendResult.success) {
        await db.execute(sql`UPDATE users SET onboarding_nudge_count = onboarding_nudge_count + 1, onboarding_last_nudge_at = NOW(), updated_at = NOW() WHERE id = ${member.id}`);
        logger.info(`[Onboarding Nudge] Sent nudge #${currentNudgeCount + 1} to ${member.email}`);
      } else {
        logger.warn(`[Onboarding Nudge] Failed to send to ${member.email}: ${sendResult.error}`);
      }
    }
  } catch (error: unknown) {
    logger.error('[Onboarding Nudge] Scheduler error:', { error: error as Error });
  }
}

export function startOnboardingNudgeScheduler(): void {
  const interval = 60 * 60 * 1000;
  setInterval(async () => {
    schedulerTracker.recordRun('Onboarding Nudge', true);
    await processOnboardingNudges();
  }, interval);
  logger.info('[Scheduler] Onboarding Nudge scheduler started (runs at 10 AM Pacific)');
}
