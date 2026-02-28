import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../../hooks/queries/useFetch';
import Toggle from '../../../../components/Toggle';

interface AutoApproveConfig {
  conferenceRooms: boolean;
  trackmanImports: boolean;
}

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

const AutoApprovePanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'monitoring', 'auto-approve'],
    queryFn: () => fetchWithCredentials<AutoApproveConfig>('/api/admin/monitoring/auto-approve-config'),
    enabled: isOpen,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ key, enabled }: { key: string; enabled: boolean }) => {
      const response = await fetch(`/api/admin/settings/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ value: String(enabled) }),
      });
      if (!response.ok) throw new Error('Failed to update auto-approve setting');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'monitoring', 'auto-approve'] });
    },
  });

  const config = data;
  const disabledCount = config ? [config.conferenceRooms, config.trackmanImports].filter(v => !v).length : 0;

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
      <button onClick={onToggle} className="tactile-btn flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">check_circle</span>
          <span className="font-bold text-primary dark:text-white">Auto-Approve Rules</span>
          {disabledCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 ml-2">
              {disabledCount} manual
            </span>
          )}
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>

      {isOpen && (
        <div className="mt-4 space-y-3">
          {isLoading ? (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">Loading...</p>
          ) : config ? (
            <>
              <div className="flex items-center justify-between bg-gray-50/80 dark:bg-white/[0.03] rounded-xl p-3">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Conference Rooms</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">Skip staff review for conference room bookings</p>
                </div>
                <Toggle
                  checked={config.conferenceRooms}
                  onChange={(checked) => toggleMutation.mutate({ key: 'booking.auto_approve.conference_rooms', enabled: checked })}
                  disabled={toggleMutation.isPending}
                  loading={toggleMutation.isPending}
                />
              </div>

              <div className="flex items-center justify-between bg-gray-50/80 dark:bg-white/[0.03] rounded-xl p-3">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Trackman Imports</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">Auto-approve bookings matched to members during Trackman import</p>
                </div>
                <Toggle
                  checked={config.trackmanImports}
                  onChange={(checked) => toggleMutation.mutate({ key: 'booking.auto_approve.trackman_imports', enabled: checked })}
                  disabled={toggleMutation.isPending}
                  loading={toggleMutation.isPending}
                />
              </div>

              <div className="bg-blue-50/60 dark:bg-blue-900/10 border border-blue-200/50 dark:border-blue-800/20 rounded-xl p-3">
                <p className="text-[11px] text-gray-600 dark:text-gray-400">
                  <span className="font-medium text-blue-700 dark:text-blue-400">Note:</span> Golf simulator bookings always require staff approval regardless of these settings.
                </p>
              </div>
            </>
          ) : (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">Failed to load auto-approve configuration</p>
          )}
        </div>
      )}
    </div>
  );
};

export default AutoApprovePanel;