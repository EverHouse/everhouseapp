import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../hooks/queries/useFetch';
import Toggle from '../../../components/Toggle';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';

interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
}

interface GroupedTemplates {
  [category: string]: EmailTemplate[];
}

const CATEGORY_ORDER = ['Welcome', 'Booking', 'Passes', 'Payments', 'Membership', 'System'];

const CATEGORY_ICONS: Record<string, string> = {
  Welcome: 'waving_hand',
  Booking: 'event_note',
  Passes: 'confirmation_number',
  Payments: 'payments',
  Membership: 'card_membership',
  System: 'settings',
};

interface EmailCategory {
  key: string;
  label: string;
  icon: string;
  description: string;
  defaultOff?: boolean;
  stripeNote?: boolean;
}

const EMAIL_CATEGORIES: EmailCategory[] = [
  { key: 'email.welcome.enabled', label: 'Welcome', icon: 'waving_hand', description: 'Welcome, trial welcome, and first visit emails' },
  { key: 'email.booking.enabled', label: 'Booking', icon: 'event_note', description: 'Booking confirmation and reschedule notifications' },
  { key: 'email.passes.enabled', label: 'Passes', icon: 'confirmation_number', description: 'Day pass and guest pass emails with QR codes' },
  { key: 'email.payments.enabled', label: 'Payments', icon: 'payments', description: 'Payment receipts, failed payments, outstanding balances', defaultOff: true, stripeNote: true },
  { key: 'email.membership.enabled', label: 'Membership', icon: 'card_membership', description: 'Renewal, failed payment, card expiring, grace period emails', defaultOff: true, stripeNote: true },
  { key: 'email.onboarding.enabled', label: 'Onboarding', icon: 'school', description: 'Automated onboarding nudge emails for stalled members' },
  { key: 'email.system.enabled', label: 'System', icon: 'settings', description: 'Data integrity alerts sent to staff' },
];

const EmailTemplatesTab: React.FC = () => {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [controlsOpen, setControlsOpen] = useState(true);
  const [savedToast, setSavedToast] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => fetchWithCredentials<Record<string, { value: string | null; category: string | null }>>('/api/settings'),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      return fetchWithCredentials(`/api/admin/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
    },
    onMutate: async ({ key, value }) => {
      setSavingKey(key);
      await queryClient.cancelQueries({ queryKey: ['settings'] });
      const previous = queryClient.getQueryData(['settings']);
      queryClient.setQueryData(['settings'], (old: Record<string, { value: string }> | undefined) => {
        if (!old) return old;
        return { ...old, [key]: { ...old[key], value } };
      });
      return { previous };
    },
    onSuccess: () => {
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 3000);
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['settings'], context.previous);
      }
    },
    onSettled: () => {
      setSavingKey(null);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const getEmailEnabled = (key: string): boolean => {
    if (!settingsData) {
      const cat = EMAIL_CATEGORIES.find(c => c.key === key);
      return !cat?.defaultOff;
    }
    const setting = settingsData[key];
    if (!setting) {
      const cat = EMAIL_CATEGORIES.find(c => c.key === key);
      return !cat?.defaultOff;
    }
    return setting.value !== 'false';
  };

  const handleToggle = (key: string, currentValue: boolean) => {
    toggleMutation.mutate({ key, value: String(!currentValue) });
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    try {
      setLoading(true);
      const data = await fetchWithCredentials<{ templates?: Array<{ id: string; name: string; subject?: string; body?: string }> }>('/api/admin/email-templates');
      setTemplates(data.templates as EmailTemplate[]);
      if (data.templates && data.templates.length > 0) {
        selectTemplate(data.templates[0] as EmailTemplate);
      }
    } catch (err: unknown) {
      setError('Failed to load email templates');
    } finally {
      setLoading(false);
    }
  };

  const selectTemplate = useCallback(async (template: EmailTemplate) => {
    setSelectedTemplate(template);
    setPreviewLoading(true);
    setPreviewHtml(null);
    try {
      const data = await fetchWithCredentials<{ html?: string; subject?: string }>(`/api/admin/email-templates/${template.id}/preview`);
      setPreviewHtml(data.html);
    } catch (err: unknown) {
      setPreviewHtml('<html><body><p style="padding:40px;color:#666;text-align:center;">Failed to load template preview.</p></body></html>');
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (previewHtml && iframeRef.current) {
      const doc = iframeRef.current.contentDocument;
      if (doc) {
        doc.open();
        doc.write(previewHtml);
        doc.close();
      }
    }
  }, [previewHtml]);

  const groupedTemplates: GroupedTemplates = templates.reduce((acc, template) => {
    if (!acc[template.category]) acc[template.category] = [];
    acc[template.category].push(template);
    return acc;
  }, {} as GroupedTemplates);

  const sortedCategories = CATEGORY_ORDER.filter(cat => groupedTemplates[cat]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <WalkingGolferSpinner size="sm" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <span className="material-symbols-outlined text-5xl text-primary/50 dark:text-white/50 mb-4">error_outline</span>
        <h3 className="text-lg font-bold text-primary dark:text-white mb-2">Something went wrong</h3>
        <p className="text-sm text-primary/70 dark:text-white/70 mb-6">{error}</p>
        <button onClick={fetchTemplates} className="tactile-btn px-5 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-full font-medium">
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-pop-in pb-32">
      {savedToast && (
        <div className="fixed top-4 right-4 z-50 animate-pop-in">
          <div className="px-4 py-3 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 rounded-xl text-green-700 dark:text-green-400 text-sm font-medium flex items-center gap-2 shadow-lg backdrop-blur-lg">
            <span className="material-symbols-outlined text-lg">check_circle</span>
            Saved
          </div>
        </div>
      )}

      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg rounded-xl border border-primary/10 dark:border-white/20 overflow-hidden">
        <button
          onClick={() => setControlsOpen(!controlsOpen)}
          className="tactile-btn w-full px-6 py-4 flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary dark:text-white">mail</span>
            </div>
            <div className="text-left">
              <h3 className="text-lg font-bold text-primary dark:text-white">Email Controls</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">Enable or disable email categories</p>
            </div>
          </div>
          <span className={`material-symbols-outlined text-primary/50 dark:text-white/50 transition-transform duration-200 ${controlsOpen ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>

        {controlsOpen && (
          <div className="px-6 pb-6 space-y-3 border-t border-primary/5 dark:border-white/5 pt-4">
            {EMAIL_CATEGORIES.map((cat) => {
              const enabled = getEmailEnabled(cat.key);
              const isSaving = savingKey === cat.key;
              return (
                <div
                  key={cat.key}
                  className="flex items-center justify-between p-4 bg-gray-50 dark:bg-black/20 rounded-xl"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 dark:bg-white/10 flex items-center justify-center flex-shrink-0">
                      <span className="material-symbols-outlined text-lg text-primary dark:text-white">{cat.icon}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-primary dark:text-white">{cat.label}</p>
                        {!enabled && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-700/50">
                            Disabled
                          </span>
                        )}
                        {isSaving && (
                          <span className="material-symbols-outlined animate-spin text-sm text-primary/40 dark:text-white/40">progress_activity</span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{cat.description}</p>
                      {cat.stripeNote && (
                        <p className="text-xs text-primary/40 dark:text-white/30 mt-1 flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">info</span>
                          Using Stripe emails instead
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex-shrink-0 ml-4">
                    <Toggle
                      checked={enabled}
                      onChange={() => handleToggle(cat.key, enabled)}
                      disabled={isSaving}
                      size="sm"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mb-2">
        <p className="text-sm text-primary/70 dark:text-white/70">
          Preview all email templates sent to members. Select a template to see its rendered HTML.
        </p>
      </div>

      <div className="lg:hidden mb-4">
        <select
          value={selectedTemplate?.id || ''}
          onChange={(e) => {
            const t = templates.find(t => t.id === e.target.value);
            if (t) selectTemplate(t);
          }}
          className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/[0.05] backdrop-blur-xl border border-white/20 dark:border-white/10 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent appearance-none"
        >
          {sortedCategories.map(category => (
            <optgroup key={category} label={category}>
              {groupedTemplates[category].map(template => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="flex gap-6">
        <div className="hidden lg:block w-72 flex-shrink-0">
          <div className="bg-white/80 dark:bg-white/[0.05] backdrop-blur-xl border border-white/20 dark:border-white/10 rounded-xl shadow-lg overflow-hidden sticky top-32">
            <div className="max-h-[calc(100vh-180px)] overflow-y-auto">
              {sortedCategories.map(category => (
                <div key={category}>
                  <div className="px-4 py-3 border-b border-primary/5 dark:border-white/5">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-base text-primary/40 dark:text-white/40">
                        {CATEGORY_ICONS[category] || 'folder'}
                      </span>
                      <h3 className="text-xs font-semibold text-primary/50 dark:text-white/40 uppercase tracking-widest">
                        {category}
                      </h3>
                    </div>
                  </div>
                  <div className="py-1">
                    {groupedTemplates[category].map(template => {
                      const isActive = selectedTemplate?.id === template.id;
                      return (
                        <button
                          key={template.id}
                          onClick={() => selectTemplate(template)}
                          className={`tactile-btn w-full text-left px-4 py-2.5 transition-all duration-fast ${
                            isActive
                              ? 'bg-accent/20 dark:bg-accent/10 border-l-2 border-accent'
                              : 'hover:bg-primary/5 dark:hover:bg-white/5 border-l-2 border-transparent'
                          }`}
                        >
                          <p className={`text-sm font-medium ${isActive ? 'text-primary dark:text-accent' : 'text-primary/80 dark:text-white/70'}`}>
                            {template.name}
                          </p>
                          <p className="text-xs text-primary/50 dark:text-white/40 mt-0.5 line-clamp-1">
                            {template.description}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          {selectedTemplate && (
            <div className="bg-white/80 dark:bg-white/[0.05] backdrop-blur-xl border border-white/20 dark:border-white/10 rounded-xl shadow-lg overflow-hidden">
              <div className="px-5 py-4 border-b border-primary/5 dark:border-white/5 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-primary dark:text-white">
                    {selectedTemplate.name}
                  </h2>
                  <p className="text-xs text-primary/50 dark:text-white/40 mt-0.5">
                    {selectedTemplate.description}
                  </p>
                </div>
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-accent/20 text-primary dark:text-accent">
                  {selectedTemplate.category}
                </span>
              </div>

              <div className="relative bg-bone dark:bg-[#1a1a1a]" style={{ minHeight: '600px' }}>
                {previewLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-bone/80 dark:bg-[#1a1a1a]/80 z-10">
                    <WalkingGolferSpinner size="sm" />
                  </div>
                )}
                <iframe
                  ref={iframeRef}
                  title="Email Template Preview"
                  className="w-full border-0"
                  style={{ minHeight: '600px', height: '80vh', maxHeight: '900px' }}
                  sandbox="allow-same-origin"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default EmailTemplatesTab;
