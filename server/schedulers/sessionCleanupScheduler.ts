import { getPacificHour } from '../utils/dateUtils';

export function startSessionCleanupScheduler(): void {
  setInterval(async () => {
    try {
      if (getPacificHour() === 2) {
        const { runSessionCleanup } = await import('../core/sessionCleanup');
        await runSessionCleanup();
      }
    } catch (err) {
      console.error('[Session Cleanup] Scheduler error:', err);
    }
  }, 60 * 60 * 1000);
  
  console.log('[Startup] Session cleanup scheduler enabled (runs daily at 2am Pacific)');
}
