import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials } from '../../../hooks/queries/useFetch';
import Toggle from '../../../components/Toggle';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';

interface SettingsState {
  clubName: string;
  supportEmail: string;
  timezoneDisplay: string;
  categoryLabels: Record<string, string>;
  dataIntegrityAlerts: boolean;
  syncFailureAlerts: boolean;
}

const CATEGORY_KEYS = [
  'guest_pass',
  'guest_sim_fee',
  'sim_walk_in',
  'membership',
  'cafe',
  'retail',
  'other'
] as const;

const TIMEZONE_OPTIONS = [
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'UTC', label: 'UTC' },
];

const SettingsTab: React.FC = () => {
  const queryClient = useQueryClient();
  const [success, setSuccess] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  
  const [settings, setSettings] = useState<SettingsState>({
    clubName: 'Ever House',
    supportEmail: 'support@everhouse.com',
    timezoneDisplay: 'America/Los_Angeles',
    categoryLabels: {
      guest_pass: 'Guest Pass',
      guest_sim_fee: 'Guest Sim Fee',
      sim_walk_in: 'Sim Walk-In',
      membership: 'Membership',
      cafe: 'Cafe',
      retail: 'Retail',
      other: 'Other',
    },
    dataIntegrityAlerts: true,
    syncFailureAlerts: true,
  });

  const { data: fetchedSettings, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const data = await fetchWithCredentials<any>('/api/settings');
      
      const categoryLabels: Record<string, string> = {};
      for (const key of CATEGORY_KEYS) {
        categoryLabels[key] = data[`category.${key}`]?.value || key.replace(/_/g, ' ');
      }
      
      return {
        clubName: data['app.club_name']?.value || 'Ever House',
        supportEmail: data['app.support_email']?.value || 'support@everhouse.com',
        timezoneDisplay: data['app.timezone_display']?.value || 'America/Los_Angeles',
        categoryLabels,
        dataIntegrityAlerts: data['notifications.data_integrity_alerts']?.value !== 'false',
        syncFailureAlerts: data['notifications.sync_failure_alerts']?.value !== 'false',
      } as SettingsState;
    },
  });

  useEffect(() => {
    if (fetchedSettings) {
      setSettings(fetchedSettings);
      setHasChanges(false);
    }
  }, [fetchedSettings]);

  const saveMutation = useMutation({
    mutationFn: async (settingsToSave: SettingsState) => {
      const payload: Record<string, string> = {
        'app.club_name': settingsToSave.clubName,
        'app.support_email': settingsToSave.supportEmail,
        'app.timezone_display': settingsToSave.timezoneDisplay,
        'notifications.data_integrity_alerts': String(settingsToSave.dataIntegrityAlerts),
        'notifications.sync_failure_alerts': String(settingsToSave.syncFailureAlerts),
      };
      
      for (const [key, label] of Object.entries(settingsToSave.categoryLabels)) {
        payload[`category.${key}`] = label;
      }
      
      return fetchWithCredentials('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: payload }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setHasChanges(false);
      setSuccess('Settings saved successfully');
      setTimeout(() => setSuccess(null), 3000);
    },
  });

  const handleSave = () => {
    saveMutation.mutate(settings);
  };

  const handleReset = () => {
    if (fetchedSettings) {
      setSettings(fetchedSettings);
      setHasChanges(false);
    }
  };

  if (isLoading) {
    return (
      <div className="py-8 flex flex-col items-center gap-2">
        <WalkingGolferSpinner size="md" variant="dark" />
        <p className="text-sm text-gray-500">Loading settings...</p>
      </div>
    );
  }

  const errorMessage = error instanceof Error ? error.message : (saveMutation.error instanceof Error ? saveMutation.error.message : null);

  return (
    <div className="animate-pop-in space-y-6 pb-32">
      {success && (
        <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg text-green-700 dark:text-green-400 text-sm flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">check_circle</span>
          {success}
        </div>
      )}

      {errorMessage && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">error</span>
          {errorMessage}
        </div>
      )}

      <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 border border-gray-200 dark:border-white/25">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">tune</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-primary dark:text-white">App Display Settings</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">Configure how the app appears to users</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-primary dark:text-white mb-1">
              Club Name
            </label>
            <input
              type="text"
              value={settings.clubName}
              onChange={(e) => {
                setSettings({ ...settings, clubName: e.target.value });
                setHasChanges(true);
              }}
              className="w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="Club name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-primary dark:text-white mb-1">
              Support Email
            </label>
            <input
              type="email"
              value={settings.supportEmail}
              onChange={(e) => {
                setSettings({ ...settings, supportEmail: e.target.value });
                setHasChanges(true);
              }}
              className="w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="support@example.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-primary dark:text-white mb-1">
              Time Zone Display
            </label>
            <select
              value={settings.timezoneDisplay}
              onChange={(e) => {
                setSettings({ ...settings, timezoneDisplay: e.target.value });
                setHasChanges(true);
              }}
              className="w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {TIMEZONE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 border border-gray-200 dark:border-white/25">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">category</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-primary dark:text-white">Purchase Category Labels</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">Customize display names for purchase categories</p>
          </div>
        </div>

        <div className="space-y-3">
          {CATEGORY_KEYS.map(key => (
            <div key={key} className="flex items-center gap-4">
              <div className="w-32 flex-shrink-0">
                <span className="text-xs font-mono text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-black/30 px-2 py-1 rounded">
                  {key}
                </span>
              </div>
              <input
                type="text"
                value={settings.categoryLabels[key]}
                onChange={(e) => {
                  setSettings({
                    ...settings,
                    categoryLabels: {
                      ...settings.categoryLabels,
                      [key]: e.target.value
                    }
                  });
                  setHasChanges(true);
                }}
                className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent text-sm"
                placeholder="Display label"
              />
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 border border-gray-200 dark:border-white/25">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">notifications</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-primary dark:text-white">Notification Settings</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">Configure system notification preferences</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-black/20 rounded-xl">
            <div>
              <p className="font-medium text-primary dark:text-white">Data Integrity Check Alerts</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">Receive alerts when data integrity issues are detected</p>
            </div>
            <Toggle
              checked={settings.dataIntegrityAlerts}
              onChange={(checked) => {
                setSettings({ ...settings, dataIntegrityAlerts: checked });
                setHasChanges(true);
              }}
              size="md"
            />
          </div>

          <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-black/20 rounded-xl">
            <div>
              <p className="font-medium text-primary dark:text-white">Sync Failure Alerts</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">Receive alerts when external sync operations fail</p>
            </div>
            <Toggle
              checked={settings.syncFailureAlerts}
              onChange={(checked) => {
                setSettings({ ...settings, syncFailureAlerts: checked });
                setHasChanges(true);
              }}
              size="md"
            />
          </div>
        </div>
      </div>

      {hasChanges && (
        <div className="fixed bottom-20 lg:bottom-6 left-4 right-4 lg:left-72 lg:right-8 bg-white dark:bg-surface-dark border border-gray-200 dark:border-white/25 rounded-2xl shadow-lg p-4 flex items-center justify-between gap-4 z-50 animate-slide-up">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            You have unsaved changes
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={handleReset}
              disabled={saveMutation.isPending}
              className="px-4 py-2 rounded-full text-primary dark:text-white hover:bg-gray-100 dark:hover:bg-white/10 transition-colors text-sm font-medium"
            >
              Reset
            </button>
            <button
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="px-6 py-2 rounded-full bg-primary dark:bg-accent text-white dark:text-primary font-medium text-sm disabled:opacity-50 flex items-center gap-2"
            >
              {saveMutation.isPending ? (
                <>
                  <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  Saving...
                </>
              ) : (
                <>
                  <span aria-hidden="true" className="material-symbols-outlined text-sm">save</span>
                  Save Changes
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsTab;
