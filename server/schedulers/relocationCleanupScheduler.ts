import { schedulerTracker } from '../core/schedulerTracker';
import { clearStaleRelocations } from '../routes/bays/reschedule';

export function startRelocationCleanupScheduler(): void {
  setInterval(async () => {
    try {
      await clearStaleRelocations();
    } catch (err) {
      console.error('[Relocation Cleanup] Scheduler error:', err);
      schedulerTracker.recordRun('Relocation Cleanup', false, String(err));
    }
  }, 5 * 60 * 1000);

  console.log('[Startup] Relocation cleanup scheduler enabled (runs every 5 minutes)');
}
