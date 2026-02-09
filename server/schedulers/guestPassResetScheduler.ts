import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getPacificHour, getPacificDayOfMonth, getPacificDateParts } from '../utils/dateUtils';

const RESET_HOUR = 3;

async function tryClaimResetSlot(monthKey: string): Promise<boolean> {
  try {
    const result = await db.execute(sql`INSERT INTO system_settings (key, value, updated_at)
       VALUES ('last_guest_pass_reset', ${monthKey}, NOW())
       ON CONFLICT (key) DO UPDATE SET value = ${monthKey}, updated_at = NOW()
       WHERE system_settings.value IS DISTINCT FROM ${monthKey}
       RETURNING key`);
    return (result.rowCount || 0) > 0;
  } catch (err) {
    console.error('[Guest Pass Reset] Failed to claim reset slot:', err);
    return false;
  }
}

async function resetGuestPasses(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const dayOfMonth = getPacificDayOfMonth();
    
    if (currentHour !== RESET_HOUR || dayOfMonth !== 1) {
      return;
    }
    
    // Create a unique key for this month to prevent double runs
    const parts = getPacificDateParts();
    const monthKey = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
    
    if (!await tryClaimResetSlot(monthKey)) {
      console.log('[Guest Pass Reset] Already ran this month, skipping');
      return;
    }
    
    console.log('[Guest Pass Reset] Starting monthly reset...');
    
    const result = await db.execute(sql`UPDATE guest_passes 
       SET passes_used = 0, 
           updated_at = NOW()
       WHERE passes_used > 0
       RETURNING member_email, passes_total`);
    
    if (result.rowCount === 0) {
      console.log('[Guest Pass Reset] No passes needed resetting');
      return;
    }
    
    console.log(`[Guest Pass Reset] Reset ${result.rowCount} member(s) guest passes to 0`);
    
    for (const row of result.rows) {
      console.log(`[Guest Pass Reset] Reset ${row.member_email}: 0/${row.passes_total} passes used`);
    }
    
  } catch (error) {
    console.error('[Guest Pass Reset] Scheduler error:', error);
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startGuestPassResetScheduler(): void {
  if (intervalId) {
    console.log('[Guest Pass Reset] Scheduler already running');
    return;
  }

  console.log('[Startup] Guest pass reset scheduler enabled (runs 1st of month at 3am Pacific)');
  
  intervalId = setInterval(() => {
    resetGuestPasses().catch(err => {
      console.error('[Guest Pass Reset] Uncaught error:', err);
    });
  }, 60 * 60 * 1000);
}

export function stopGuestPassResetScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Guest Pass Reset] Scheduler stopped');
  }
}
