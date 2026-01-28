import { pool } from '../core/db';
import { getPacificHour, getPacificDayOfMonth } from '../utils/dateUtils';

const RESET_HOUR = 3;

async function resetGuestPasses(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const dayOfMonth = getPacificDayOfMonth();
    
    if (currentHour !== RESET_HOUR || dayOfMonth !== 1) {
      return;
    }
    
    console.log('[Guest Pass Reset] Starting monthly reset...');
    
    const result = await pool.query(
      `UPDATE guest_passes 
       SET passes_used = 0, 
           updated_at = NOW()
       WHERE passes_used > 0
       RETURNING member_email, passes_total`
    );
    
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
