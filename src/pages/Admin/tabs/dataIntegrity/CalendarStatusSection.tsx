import React from 'react';
import type { CalendarStatusResponse } from './dataIntegrityTypes';

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
