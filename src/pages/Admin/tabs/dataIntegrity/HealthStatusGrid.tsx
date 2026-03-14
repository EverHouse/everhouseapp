import React from 'react';
import type { SystemHealth } from './dataIntegrityTypes';

interface HealthStatusGridProps {
  systemHealth: SystemHealth | null;
  isCheckingHealth: boolean;
  onCheckHealth: () => void;
}

const HealthStatusGrid: React.FC<HealthStatusGridProps> = ({
  systemHealth,
  isCheckingHealth,
  onCheckHealth,
}) => {
  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-6 animate-content-enter-delay-1">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white text-[24px]">monitoring</span>
          <h3 className="text-2xl leading-tight text-primary dark:text-white" style={{ fontFamily: 'var(--font-headline)' }}>System Health</h3>
        </div>
        <button
          onClick={onCheckHealth}
          disabled={isCheckingHealth}
          className="tactile-btn px-4 py-2 bg-primary dark:bg-[#CCB8E4] text-white dark:text-[#293515] rounded-lg font-medium text-sm flex items-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isCheckingHealth ? (
            <>
              <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
              Checking...
            </>
          ) : (
            <>
              <span aria-hidden="true" className="material-symbols-outlined text-[16px]">health_and_safety</span>
              Check Health
            </>
          )}
        </button>
      </div>

      {systemHealth ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
            {[
              { key: 'database' as const, label: 'Database', icon: 'database' },
              { key: 'stripe' as const, label: 'Stripe', icon: 'credit_card' },
              { key: 'hubspot' as const, label: 'HubSpot', icon: 'groups' },
              { key: 'resend' as const, label: 'Resend', icon: 'mail' },
              { key: 'googleCalendar' as const, label: 'Google Calendar', icon: 'calendar_today' },
            ].map(({ key, label, icon: _icon }) => {
              const service = systemHealth.services[key];
              const isDegraded = service.status === 'degraded';
              const isUnhealthy = service.status === 'unhealthy';
              
              let statusBgColor = 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800';
              let statusTextColor = 'text-green-700 dark:text-green-300';
              let statusIcon = 'check_circle';
              
              if (isDegraded) {
                statusBgColor = 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800';
                statusTextColor = 'text-yellow-700 dark:text-yellow-300';
                statusIcon = 'warning';
              } else if (isUnhealthy) {
                statusBgColor = 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
                statusTextColor = 'text-red-700 dark:text-red-300';
                statusIcon = 'cancel';
              }

              return (
                <div key={key} className={`border rounded-lg p-3 ${statusBgColor}`}>
                  <div className="flex items-start gap-2 mb-2">
                    <span aria-hidden="true" className={`material-symbols-outlined text-[20px] ${statusTextColor}`}>{statusIcon}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-bold ${statusTextColor}`}>{label}</p>
                      <p className={`text-[10px] ${statusTextColor} opacity-80`}>{service.status}</p>
                    </div>
                  </div>
                  {service.latencyMs !== undefined && (
                    <p className={`text-[10px] ${statusTextColor} opacity-70`}>
                      <span aria-hidden="true" className="material-symbols-outlined text-[12px] align-text-bottom mr-0.5">schedule</span>
                      {service.latencyMs}ms
                    </p>
                  )}
                  {service.message && isUnhealthy && (
                    <p className={`text-[10px] ${statusTextColor} opacity-80 mt-1 line-clamp-2`}>{service.message}</p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 text-right">
            Checked {new Date(systemHealth.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })}
          </p>
        </div>
      ) : (
        <div className="text-center py-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">Click "Check Health" to see system status</p>
        </div>
      )}
    </div>
  );
};

export default HealthStatusGrid;
