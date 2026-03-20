import { useState, useEffect, useRef, useCallback } from 'react';
import { SlideUpDrawer } from './SlideUpDrawer';
import WalkingGolferSpinner from './WalkingGolferSpinner';
import { fetchWithCredentials } from '../hooks/queries/useFetch';
import Icon from './icons/Icon';

interface TrainingSectionDB {
  id: number;
  guideId: string;
  icon: string;
  title: string;
  description: string;
  sortOrder: number;
  isAdminOnly: boolean;
  steps: { title: string; content: string; imageUrl?: string; pageIcon?: string }[];
  createdAt: string;
  updatedAt: string;
}

interface ContextualHelpProps {
  guideIds: string[];
  title?: string;
}

export default function ContextualHelp({ guideIds, title = 'Page Guide' }: ContextualHelpProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [sections, setSections] = useState<TrainingSectionDB[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const expandedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (expandedSection && expandedRef.current) {
      requestAnimationFrame(() => {
        expandedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [expandedSection]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetchWithCredentials<{sections: TrainingSectionDB[]}>('/api/training-sections')
      .then(data => {
        if (cancelled) return;
        const filtered = data.sections
          .filter(s => guideIds.includes(s.guideId))
          .sort((a, b) => a.sortOrder - b.sortOrder);
        setSections(filtered);
      })
      .catch((err) => { console.error('[ContextualHelp] Failed to load help sections:', err); if (!cancelled) setSections([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, guideIds]);

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        aria-expanded={isOpen}
        className="p-2 rounded-xl bg-white/60 dark:bg-white/10 backdrop-blur-sm border border-primary/10 dark:border-white/20 hover:bg-white/80 dark:hover:bg-white/15 transition-colors tactile-btn"
      >
        <Icon name="school" className="text-xl text-primary/70 dark:text-white/70" />
      </button>

      <SlideUpDrawer isOpen={isOpen} onClose={() => setIsOpen(false)} title={title}>
        <div className="p-4 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <WalkingGolferSpinner size="sm" />
            </div>
          ) : sections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Icon name="menu_book" className="text-4xl text-primary/30 dark:text-white/30 mb-3" />
              <p className="text-sm text-primary/60 dark:text-white/60">No guide sections available.</p>
            </div>
          ) : (
            sections.map((section) => {
              const sectionId = String(section.id);
              const isExpanded = expandedSection === sectionId;
              return (
              <div
                key={section.id}
                ref={isExpanded ? expandedRef : undefined}
                className="accordion-item-wrapper bg-white/60 dark:bg-white/5 backdrop-blur-sm rounded-xl border border-primary/10 dark:border-white/25 overflow-hidden hover:bg-white/80 dark:hover:bg-white/10 transition-colors cursor-pointer"
                onClick={() => setExpandedSection(isExpanded ? null : sectionId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedSection(isExpanded ? null : sectionId); } }}
                aria-expanded={isExpanded}
              >
                <div className="flex items-center">
                  <div className="flex-1 flex items-center gap-4 p-5 text-left">
                    <div className="w-12 h-12 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center flex-shrink-0">
                      <Icon name={section.icon} className="text-2xl text-primary dark:text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-bold text-primary dark:text-white">{section.title}</h3>
                      <p className="text-sm text-primary/80 dark:text-white/80">{section.description}</p>
                    </div>
                    <Icon name="expand_more" className={`text-primary/70 dark:text-white/70 transition-transform duration-normal ${isExpanded ? 'rotate-180' : ''}`} />
                  </div>
                </div>

                <div className={`overflow-hidden transition-all duration-normal ${isExpanded ? 'max-h-[5000px]' : 'max-h-0'}`}>
                  <div className="px-5 pb-5 space-y-4">
                    {section.steps.map((step, index) => (
                      <div key={index} className="flex gap-4">
                        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 dark:bg-white/10 flex items-center justify-center text-sm font-bold text-primary dark:text-white">
                          {index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="font-semibold text-primary dark:text-white text-sm">{step.title}</h4>
                            {step.pageIcon && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/20 dark:bg-accent/30 text-xs text-primary dark:text-accent">
                                <Icon name={step.pageIcon} className="text-xs" />
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-primary/70 dark:text-white/70 mt-1">{step.content}</p>
                          {step.imageUrl && (
                            <img src={step.imageUrl} alt="" className="mt-2 rounded-lg max-w-full h-auto" />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );})
          )}
        </div>
      </SlideUpDrawer>
    </>
  );
}
