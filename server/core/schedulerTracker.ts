import { isSchedulerEnabled } from './settingsHelper';

interface SchedulerStatus {
  taskName: string;
  lastRunAt: Date | null;
  lastResult: 'success' | 'error' | 'pending' | 'disabled';
  lastError?: string;
  intervalMs: number;
  nextRunAt: Date | null;
  runCount: number;
  lastDurationMs: number | null;
  isEnabled: boolean;
}

class SchedulerTracker {
  private schedulers: Map<string, SchedulerStatus> = new Map();

  registerScheduler(name: string, intervalMs: number): void {
    this.schedulers.set(name, {
      taskName: name,
      lastRunAt: null,
      lastResult: 'pending',
      intervalMs,
      nextRunAt: new Date(Date.now() + intervalMs),
      runCount: 0,
      lastDurationMs: null,
      isEnabled: true,
    });
  }

  recordRun(name: string, success: boolean, error?: string, durationMs?: number): void {
    const existing = this.schedulers.get(name);
    if (!existing) {
      this.schedulers.set(name, {
        taskName: name,
        lastRunAt: new Date(),
        lastResult: success ? 'success' : 'error',
        lastError: error,
        intervalMs: 0,
        nextRunAt: null,
        runCount: 1,
        lastDurationMs: durationMs ?? null,
        isEnabled: true,
      });
      return;
    }

    existing.lastRunAt = new Date();
    existing.lastResult = success ? 'success' : 'error';
    existing.lastError = error;
    existing.runCount += 1;
    existing.lastDurationMs = durationMs ?? null;
    if (existing.intervalMs > 0) {
      existing.nextRunAt = new Date(Date.now() + existing.intervalMs);
    }
  }

  recordSkipped(name: string): void {
    const existing = this.schedulers.get(name);
    if (existing) {
      existing.lastResult = 'disabled';
      existing.isEnabled = false;
    }
  }

  setEnabled(name: string, enabled: boolean): void {
    const existing = this.schedulers.get(name);
    if (existing) {
      existing.isEnabled = enabled;
      if (!enabled) {
        existing.lastResult = 'disabled';
      }
    }
  }

  async refreshEnabledStates(): Promise<void> {
    for (const [name, status] of this.schedulers) {
      const enabled = await isSchedulerEnabled(name);
      status.isEnabled = enabled;
      if (!enabled && status.lastResult !== 'error') {
        status.lastResult = 'disabled';
      }
    }
  }

  getSchedulerStatuses(): SchedulerStatus[] {
    return Array.from(this.schedulers.values()).sort((a, b) => a.taskName.localeCompare(b.taskName));
  }
}

export const schedulerTracker = new SchedulerTracker();
