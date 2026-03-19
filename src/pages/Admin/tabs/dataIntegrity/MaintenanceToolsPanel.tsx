import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { postWithCredentials, fetchWithCredentials } from '../../../../hooks/queries/useFetch';

interface ToolResult {
  success: boolean;
  message?: string;
  error?: string;
  fixed?: number;
  cleaned?: number;
  synced?: number;
  repaired?: number;
  backfilled?: number;
  deleted?: number;
  [key: string]: unknown;
}

interface MaintenanceTool {
  key: string;
  label: string;
  description: string;
  endpoint: string;
  icon: string;
  confirmMessage: string;
  body?: Record<string, unknown>;
}

const TOOLS: MaintenanceTool[] = [
  {
    key: 'cleanup-ghost-fees',
    label: 'Cleanup Ghost Fees',
    description: 'Remove orphaned fee records that no longer have associated bookings.',
    endpoint: '/api/data-tools/cleanup-ghost-fees',
    icon: 'payments',
    confirmMessage: 'This will delete ghost fee records with no associated bookings. Continue?',
    body: { dryRun: false },
  },
  {
    key: 'fix-trackman-ghost-bookings',
    label: 'Fix Trackman Ghost Bookings',
    description: 'Repair Trackman bookings that are linked to deleted or missing app bookings.',
    endpoint: '/api/data-tools/fix-trackman-ghost-bookings',
    icon: 'sports_golf',
    confirmMessage: 'This will repair Trackman ghost bookings. Continue?',
    body: { dryRun: false },
  },
  {
    key: 'sync-stripe-metadata',
    label: 'Sync Stripe Metadata',
    description: 'Sync member name and email metadata to their Stripe customer records.',
    endpoint: '/api/data-integrity/sync-stripe-metadata',
    icon: 'sync',
    confirmMessage: 'This will update metadata on all Stripe customer records. Continue?',
    body: { dryRun: false },
  },
  {
    key: 'repair-linked-email-bookings',
    label: 'Repair Linked-Email Bookings',
    description: 'Fix bookings that reference stale or unlinked email addresses.',
    endpoint: '/api/admin/repair-linked-email-bookings',
    icon: 'mail',
    confirmMessage: 'This will attempt to re-link bookings to the correct member accounts. Continue?',
    body: { dryRun: false },
  },
  {
    key: 'backfill-calendar-properties',
    label: 'Backfill Calendar Extended Properties',
    description: 'Backfill Google Calendar events with extended properties needed for app sync.',
    endpoint: '/api/admin/backfill-calendar-extended-properties',
    icon: 'calendar_today',
    confirmMessage: 'This will update existing Google Calendar events with extended metadata. Continue?',
  },
  {
    key: 'cleanup-stale-intents',
    label: 'Cleanup Stale Payment Intents',
    description: 'Cancel or remove stale Stripe payment intents that were never completed.',
    endpoint: '/api/stripe/cleanup-stale-intents',
    icon: 'credit_card_off',
    confirmMessage: 'This will cancel stale Stripe payment intents older than 24 hours. Continue?',
    body: { dryRun: false },
  },
];

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

const BACKGROUND_TOOLS = new Set(['backfill-calendar-properties']);

const MaintenanceToolsPanel: React.FC<Props> = ({ isOpen, onToggle }) => {
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ToolResult | null>>({});
  const [pollingKeys, setPollingKeys] = useState<Set<string>>(new Set());
  const pollTimerRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const stopPolling = useCallback((key: string) => {
    if (pollTimerRef.current[key]) {
      clearInterval(pollTimerRef.current[key]);
      delete pollTimerRef.current[key];
    }
    setPollingKeys(prev => { const next = new Set(prev); next.delete(key); return next; });
  }, []);

  const startPolling = useCallback((tool: MaintenanceTool) => {
    const statusUrl = `${tool.endpoint}/status`;
    setPollingKeys(prev => new Set(prev).add(tool.key));
    setResults(prev => ({ ...prev, [tool.key]: { success: true, message: 'Running in background...' } }));

    pollTimerRef.current[tool.key] = setInterval(async () => {
      try {
        const status = await fetchWithCredentials<{ status: string; message?: string; error?: string }>(statusUrl);
        if (status.status === 'complete') {
          stopPolling(tool.key);
          setResults(prev => ({ ...prev, [tool.key]: { success: true, message: status.message || 'Complete' } }));
        } else if (status.status === 'error') {
          stopPolling(tool.key);
          setResults(prev => ({ ...prev, [tool.key]: { success: false, error: status.error || 'Backfill failed' } }));
        }
      } catch {
        stopPolling(tool.key);
        setResults(prev => ({ ...prev, [tool.key]: { success: false, error: 'Failed to check status' } }));
      }
    }, 5000);
  }, [stopPolling]);

  useEffect(() => {
    return () => {
      Object.values(pollTimerRef.current).forEach(clearInterval);
    };
  }, []);

  const runToolMutation = useMutation({
    mutationFn: async ({ tool }: { tool: MaintenanceTool }) => {
      return postWithCredentials<ToolResult>(tool.endpoint, tool.body ?? {});
    },
    onSuccess: (data, { tool }) => {
      if (BACKGROUND_TOOLS.has(tool.key) && data.success) {
        startPolling(tool);
      } else {
        setResults(prev => ({ ...prev, [tool.key]: data }));
      }
    },
    onError: (err, { tool }) => {
      setResults(prev => ({
        ...prev,
        [tool.key]: {
          success: false,
          error: err instanceof Error ? err.message : 'Operation failed',
        },
      }));
    },
  });

  const handleRun = (tool: MaintenanceTool) => {
    setConfirmingKey(null);
    setResults(prev => ({ ...prev, [tool.key]: null }));
    runToolMutation.mutate({ tool });
  };

  const getResultSummary = (key: string, result: ToolResult | null): string | null => {
    if (!result) return null;
    if (!result.success) return result.error || result.message || 'Failed';
    const parts: string[] = [];
    if (result.fixed) parts.push(`${result.fixed} fixed`);
    if (result.cleaned) parts.push(`${result.cleaned} cleaned`);
    if (result.synced) parts.push(`${result.synced} synced`);
    if (result.repaired) parts.push(`${result.repaired} repaired`);
    if (result.backfilled) parts.push(`${result.backfilled} backfilled`);
    if (result.deleted) parts.push(`${result.deleted} deleted`);
    return parts.length > 0 ? parts.join(', ') : result.message || 'Complete';
  };

  const isMutating = runToolMutation.isPending;
  const mutatingKey = isMutating && runToolMutation.variables ? runToolMutation.variables.tool.key : null;
  const isRunning = isMutating || pollingKeys.size > 0;
  const isToolBusy = (key: string) => mutatingKey === key || pollingKeys.has(key);

  return (
    <div className="mb-6 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
      <button onClick={onToggle} className="tactile-btn flex items-center justify-between w-full text-left">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">build</span>
          <span className="font-bold text-primary dark:text-white">Maintenance Tools</span>
          <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">({TOOLS.length} tools)</span>
        </div>
        <span aria-hidden="true" className={`material-symbols-outlined text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>

      {isOpen && (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Run targeted maintenance operations. Each tool includes a confirmation step before executing.
          </p>
          {TOOLS.map((tool) => {
            const result = results[tool.key];
            const toolRunning = isToolBusy(tool.key);
            const isConfirming = confirmingKey === tool.key;

            return (
              <div
                key={tool.key}
                className="p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <span aria-hidden="true" className="material-symbols-outlined text-primary/60 dark:text-white/60 text-lg mt-0.5 flex-shrink-0">
                      {tool.icon}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-primary dark:text-white">{tool.label}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{tool.description}</p>
                      {result !== undefined && result !== null && (
                        <p className={`text-xs mt-1 font-medium ${result.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                          {result.success ? '✓ ' : '✗ '}{getResultSummary(tool.key, result)}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    {isConfirming ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setConfirmingKey(null)}
                          className="px-2 py-1 text-xs rounded-lg border border-gray-300 dark:border-white/20 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleRun(tool)}
                          className="px-2 py-1 text-xs rounded-lg bg-amber-500 text-white font-medium hover:bg-amber-600 transition-colors"
                        >
                          Confirm
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmingKey(tool.key)}
                        disabled={isRunning}
                        className="px-3 py-1.5 text-xs rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium hover:bg-primary/20 dark:hover:bg-white/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                      >
                        {toolRunning ? (
                          <>
                            <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                            Running...
                          </>
                        ) : (
                          <>
                            <span className="material-symbols-outlined text-sm">play_arrow</span>
                            Run
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
                {isConfirming && (
                  <div className="mt-2 p-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30">
                    <p className="text-xs text-amber-700 dark:text-amber-400">{tool.confirmMessage}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default MaintenanceToolsPanel;
