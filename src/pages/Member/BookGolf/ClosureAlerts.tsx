import React from 'react';
import { formatTime12Hour } from '../../../utils/dateUtils';
import type { Closure } from '../bookGolf/bookGolfTypes';

interface ClosureAlertsProps {
  closures: Closure[];
  isDark: boolean;
}

const ClosureAlerts: React.FC<ClosureAlertsProps> = ({ closures, isDark }) => {
  if (closures.length === 0) return null;

  return (
    <div className="space-y-3">
      {closures.map(closure => {
        const hasTimeRange = closure.startTime && closure.endTime;
        const isPartialDay = hasTimeRange;
        return (
          <div
            key={closure.id}
            className={`rounded-xl p-4 border ${isDark ? 'bg-amber-500/10 border-amber-500/30' : 'bg-amber-50 border-amber-200'}`}
          >
            <div className="flex items-start gap-3">
              <span className={`material-symbols-outlined text-2xl ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>notifications</span>
              <div className="flex-1">
                <h4 className={`font-bold ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>
                  {closure.noticeType ? (closure.noticeType.includes('_') ? closure.noticeType.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : closure.noticeType) : 'Notice'}
                </h4>
                {hasTimeRange && (
                  <p className={`text-sm mt-1 ${isDark ? 'text-amber-300/80' : 'text-amber-700'}`}>
                    {formatTime12Hour(closure.startTime!)} - {formatTime12Hour(closure.endTime!)}
                  </p>
                )}
                {isPartialDay && (
                  <p className={`text-xs mt-2 font-medium ${isDark ? 'text-amber-400/80' : 'text-amber-700'}`}>
                    Limited availability - see times below
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default ClosureAlerts;
