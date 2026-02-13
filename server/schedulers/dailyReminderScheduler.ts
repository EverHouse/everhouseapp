import { schedulerTracker } from '../core/schedulerTracker';
import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { sendDailyReminders } from '../routes/push';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';

const REMINDER_HOUR = 18;
const REMINDER_SETTING_KEY = 'last_daily_reminder_date';

async function tryClaimReminderSlot(todayStr: string): Promise<boolean> {
  try {
    const result = await db
      .insert(systemSettings)
      .values({
        key: REMINDER_SETTING_KEY,
        value: todayStr,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: todayStr,
          updatedAt: new Date(),
        },
        where: sql`${systemSettings.value} IS DISTINCT FROM ${todayStr}`,
      })
      .returning({ key: systemSettings.key });
    
    return result.length > 0;
  } catch (err) {
    console.error('[Daily Reminders] Database error:', err);
    schedulerTracker.recordRun('Daily Reminder', false, String(err));
    return false;
  }
}

async function checkAndSendReminders(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    if (currentHour === REMINDER_HOUR) {
      const claimed = await tryClaimReminderSlot(todayStr);
      
      if (claimed) {
        console.log('[Daily Reminders] Starting scheduled reminder job...');
        
        try {
          const result = await sendDailyReminders();
          console.log(`[Daily Reminders] Completed: ${result.message}`);
          schedulerTracker.recordRun('Daily Reminder', true);
        } catch (err) {
          console.error('[Daily Reminders] Send failed:', err);
          schedulerTracker.recordRun('Daily Reminder', false, String(err));
        }
      }
    }
  } catch (err) {
    console.error('[Daily Reminders] Scheduler error:', err);
    schedulerTracker.recordRun('Daily Reminder', false, String(err));
  }
}

export function startDailyReminderScheduler(): void {
  setInterval(checkAndSendReminders, 30 * 60 * 1000);
  console.log('[Startup] Daily reminder scheduler enabled (runs at 6pm)');
}
