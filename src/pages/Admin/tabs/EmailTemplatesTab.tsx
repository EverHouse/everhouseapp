import React, { useState, useEffect, useCallback, useRef } from 'react';
import { fetchWithCredentials } from '../../../hooks/queries/useFetch';
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

const EmailTemplatesTab: React.FC = () => {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    try {
      setLoading(true);
      const data = await fetchWithCredentials('/api/admin/email-templates') as any;
      setTemplates(data.templates);
      if (data.templates.length > 0) {
        selectTemplate(data.templates[0]);
      }
    } catch (err) {
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
      const data = await fetchWithCredentials(`/api/admin/email-templates/${template.id}/preview`) as any;
      setPreviewHtml(data.html);
    } catch (err) {
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
          <div className="bg-white/80 dark:bg-white/[0.05] backdrop-blur-xl border border-white/20 dark:border-white/10 rounded-2xl shadow-lg overflow-hidden sticky top-32">
            <div className="max-h-[calc(100vh-180px)] overflow-y-auto">
              {sortedCategories.map(category => (
                <div key={category}>
                  <div className="px-4 py-3 border-b border-primary/5 dark:border-white/5">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-base text-primary/40 dark:text-white/40">
                        {CATEGORY_ICONS[category] || 'folder'}
                      </span>
                      <h3 className="text-xs font-semibold text-primary/50 dark:text-white/40 uppercase tracking-widest font-['Playfair_Display']">
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
            <div className="bg-white/80 dark:bg-white/[0.05] backdrop-blur-xl border border-white/20 dark:border-white/10 rounded-2xl shadow-lg overflow-hidden">
              <div className="px-5 py-4 border-b border-primary/5 dark:border-white/5 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-primary dark:text-white font-['Playfair_Display']">
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
