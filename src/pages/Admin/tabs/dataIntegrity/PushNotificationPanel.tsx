import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../../hooks/queries/useFetch';
import Toggle from '../../../../components/Toggle';

interface PushStatus {
  vapidConfigured: boolean;
  pushEnabled: boolean;
  subscriptionCount: number;
}

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

const PushNotificationPanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'monitoring', 'push-status'],
    queryFn: () => fetchWithCredentials<PushStatus>('/api/admin/monitoring/push-status'),
    refetchInterval: 30000,
    enabled: isOpen,
  });

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const response = await fetch('/api/admin/settings/push.enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ value: String(enabled) }),
      });
      if (!response.ok) throw new Error('Failed to update push setting');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'monitoring', 'push-status'] });
    },
  });

  const status = data;

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
      <button onClick={onToggle} className="tactile-btn flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">notifications_active</span>
          <span className="font-bold text-primary dark:text-white">Push Notifications</span>
          {status && (
            <div className="flex items-center gap-1 ml-2">
              {status.vapidConfigured ? (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  VAPID configured
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                  VAPID missing
                </span>
              )}
              {!status.pushEnabled && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400">
                  Disabled
                </span>
              )}
            </div>
          )}
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>

      {isOpen && (
        <div className="mt-4 space-y-4">
          {isLoading ? (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">Loading...</p>
          ) : status ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-gray-50/80 dark:bg-white/[0.03] rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-primary dark:text-white">{status.subscriptionCount}</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">Active Subscriptions</p>
                </div>
                <div className="bg-gray-50/80 dark:bg-white/[0.03] rounded-xl p-3 text-center">
                  <div className={`inline-block w-3 h-3 rounded-full ${status.vapidConfigured ? 'bg-green-500' : 'bg-red-500'}`} />
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">VAPID Keys</p>
                </div>
                <div className="bg-gray-50/80 dark:bg-white/[0.03] rounded-xl p-3 text-center">
                  <div className={`inline-block w-3 h-3 rounded-full ${status.pushEnabled ? 'bg-green-500' : 'bg-gray-400'}`} />
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">Master Toggle</p>
                </div>
              </div>

              <div className="flex items-center justify-between bg-gray-50/80 dark:bg-white/[0.03] rounded-xl p-3">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Push Notifications Enabled</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">Master toggle for all push notifications</p>
                </div>
                <Toggle
                  checked={status.pushEnabled}
                  onChange={(checked) => toggleMutation.mutate(checked)}
                  disabled={!status.vapidConfigured || toggleMutation.isPending}
                />
              </div>

              {!status.vapidConfigured && (
                <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800/30 rounded-xl p-3">
                  <p className="text-xs text-yellow-700 dark:text-yellow-400">
                    <span className="font-medium">VAPID keys not configured.</span> Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY environment variables to enable push notifications.
                  </p>
                </div>
              )}
            </>
          ) : (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">Failed to load push notification status</p>
          )}
        </div>
      )}
    </div>
  );
};

export default PushNotificationPanel;
