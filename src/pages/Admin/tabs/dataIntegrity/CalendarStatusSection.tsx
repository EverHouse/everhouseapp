import React, { useState, useEffect, useCallback } from 'react';
import { postWithCredentials, fetchWithCredentials } from '../../../../hooks/queries/useFetch';
import type { CalendarStatusResponse } from './dataIntegrityTypes';

interface MigrationResults {
  wellness: { total: number; cleaned: number; errors: number };
  events: { total: number; cleaned: number; errors: number };
  closures: { total: number; cleaned: number; errors: number };
}

interface CalendarStatusSectionProps {
  showCalendars: boolean;
  onToggle: () => void;
  isLoadingCalendars: boolean;
  calendarStatus: CalendarStatusResponse | undefined;
}

const CalendarStatusSection: React.FC<CalendarStatusSectionProps> = ({
  showCalendars,
  onToggle,
  isLoadingCalendars,
  calendarStatus,
}) => {
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<{ success: boolean; results?: MigrationResults; error?: string } | null>(null);

  useEffect(() => {
    fetchWithCredentials<{ running: boolean }>('/api/admin/calendar/cleanup-status')
      .then(data => { if (data.running) setIsMigrating(true); })
      .catch(() => {});
  }, []);

  const handleCleanupComplete = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    const data = detail?.data;
    if (!data) return;

    setIsMigrating(false);

    if (data.success && data.results) {
      setMigrationResult({ success: true, results: data.results as MigrationResults });
    } else {
      setMigrationResult({ success: false, error: data.error || 'Cleanup failed' });
    }
  }, []);

  useEffect(() => {
    window.addEventListener('calendar-cleanup-complete', handleCleanupComplete);
    return () => window.removeEventListener('calendar-cleanup-complete', handleCleanupComplete);
  }, [handleCleanupComplete]);

  const handleMigrateDescriptions = async () => {
    if (!confirm('This will re-push all wellness, events, and closures to Google Calendar with clean descriptions. This runs in the background and you can navigate away. Continue?')) return;
    setIsMigrating(true);
    setMigrationResult(null);
    try {
      const data = await postWithCredentials<{ success: boolean; message?: string; error?: string }>('/api/admin/calendar/migrate-clean-descriptions', {});
      if (!data.success) {
        setIsMigrating(false);
        setMigrationResult({ success: false, error: data.error || 'Failed to start cleanup' });
      }
    } catch (err: unknown) {
      setIsMigrating(false);
      setMigrationResult({ success: false, error: err instanceof Error ? err.message : 'Failed to start cleanup' });
    }
  };

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
      <button
        onClick={onToggle}
        className="tactile-row flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">calendar_month</span>
          <span className="font-bold text-primary dark:text-white">Calendar Status</span>
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${showCalendars ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>
      
      {showCalendars && (
        <div className="mt-4 space-y-3">
          {isLoadingCalendars ? (
            <div className="flex items-center justify-center py-4">
              <span aria-hidden="true" className="material-symbols-outlined animate-spin text-gray-500">progress_activity</span>
            </div>
          ) : calendarStatus ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {calendarStatus.configured_calendars.map((cal, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                    <span className="text-sm font-medium text-primary dark:text-white truncate mr-2">{cal.name}</span>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded shrink-0 ${
                      cal.status === 'connected' 
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400' 
                        : 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                    }`}>
                      {cal.status === 'connected' ? 'Connected' : 'Not Found'}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Last checked: {new Date(calendarStatus.timestamp).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}
              </p>

              <div className="pt-3 border-t border-gray-200 dark:border-white/10">
                <button
                  onClick={handleMigrateDescriptions}
                  disabled={isMigrating}
                  className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white hover:bg-primary/20 dark:hover:bg-white/20 disabled:opacity-50 transition-colors"
                >
                  {isMigrating ? (
                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  ) : (
                    <span aria-hidden="true" className="material-symbols-outlined text-sm">cleaning_services</span>
                  )}
                  {isMigrating ? 'Cleaning descriptions...' : 'Clean Calendar Descriptions'}
                </button>
                <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
                  Re-pushes all events to Google Calendar with clean descriptions and metadata in hidden properties
                </p>

                {migrationResult && (
                  <div className={`mt-2 p-3 rounded-lg text-sm ${
                    migrationResult.success 
                      ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' 
                      : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                  }`}>
                    {migrationResult.success && migrationResult.results ? (
                      <div className="space-y-1">
                        <p className="font-medium">Migration complete</p>
                        <p>Wellness: {migrationResult.results.wellness.cleaned}/{migrationResult.results.wellness.total} cleaned{migrationResult.results.wellness.errors > 0 ? `, ${migrationResult.results.wellness.errors} errors` : ''}</p>
                        <p>Events: {migrationResult.results.events.cleaned}/{migrationResult.results.events.total} cleaned{migrationResult.results.events.errors > 0 ? `, ${migrationResult.results.events.errors} errors` : ''}</p>
                        <p>Closures: {migrationResult.results.closures.cleaned}/{migrationResult.results.closures.total} cleaned{migrationResult.results.closures.errors > 0 ? `, ${migrationResult.results.closures.errors} errors` : ''}</p>
                      </div>
                    ) : migrationResult.success ? (
                      <p className="font-medium">Cleanup running in the background. You&apos;ll get a notification when it finishes.</p>
                    ) : (
                      <p>{migrationResult.error || 'Migration failed'}</p>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">Failed to load calendar status</p>
          )}
        </div>
      )}
    </div>
  );
};

export default CalendarStatusSection;
