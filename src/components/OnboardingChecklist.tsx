import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../contexts/DataContext';
import { fetchWithCredentials } from '../hooks/queries/useFetch';

interface OnboardingStep {
  key: string;
  label: string;
  description: string;
  completed: boolean;
  completedAt: string | null;
}

interface OnboardingStatus {
  steps: OnboardingStep[];
  completedCount: number;
  totalSteps: number;
  isComplete: boolean;
  isDismissed: boolean;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const OnboardingChecklist: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useData();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  const isInStandaloneMode = typeof window !== 'undefined' && (
    (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const data = await fetchWithCredentials<OnboardingStatus>('/api/member/onboarding');
        if (isInStandaloneMode && data.steps) {
          const appStep = data.steps.find((s: OnboardingStep) => s.key === 'app');
          if (appStep && !appStep.completed) {
            try {
              await fetch('/api/member/onboarding/complete-step', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ step: 'app' }),
              });
              const refreshed = await fetchWithCredentials<OnboardingStatus>('/api/member/onboarding');
              setStatus(refreshed);
              if (refreshed.isComplete && !refreshed.isDismissed) {
                setCelebrating(true);
                setTimeout(() => setCelebrating(false), 3000);
              }
              return;
            } catch {}
          }
        }
        setStatus(data);
        if (data.isComplete && !data.isDismissed) {
          setCelebrating(true);
          setTimeout(() => setCelebrating(false), 3000);
        }
      } catch {
        // Silently fail - don't show checklist if endpoint fails
      } finally {
        setLoading(false);
      }
    };
    fetchStatus();
  }, []);

  const handleDismiss = async () => {
    try {
      await fetch('/api/member/onboarding/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      setDismissed(true);
    } catch {
      // fail silently
    }
  };

  const handleStepAction = async (step: OnboardingStep) => {
    switch (step.key) {
      case 'profile':
        navigate('/profile');
        break;
      case 'concierge': {
        const link = document.createElement('a');
        link.href = '/Ever_Club_Concierge.vcf';
        link.download = 'Ever_Club_Concierge.vcf';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        try {
          await fetch('/api/member/onboarding/complete-step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ step: 'concierge' }),
          });
          const data = await fetchWithCredentials('/api/member/onboarding');
          setStatus(data);
          if (data.isComplete && !data.isDismissed) {
            setCelebrating(true);
            setTimeout(() => setCelebrating(false), 3000);
          }
        } catch {}
        break;
      }
      case 'waiver':
        navigate('/profile', { state: { showWaiver: true } });
        break;
      case 'booking':
        navigate('/book');
        break;
      case 'app':
        if (deferredPromptRef.current) {
          await deferredPromptRef.current.prompt();
          const { outcome } = await deferredPromptRef.current.userChoice;
          if (outcome === 'accepted') {
            deferredPromptRef.current = null;
            try {
              await fetch('/api/member/onboarding/complete-step', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ step: 'app' }),
              });
              const data = await fetchWithCredentials('/api/member/onboarding');
              setStatus(data);
            } catch {}
          }
        }
        break;
    }
  };

  if (loading || !status || dismissed || status.isDismissed) return null;
  if (status.isComplete && !celebrating) return null;

  const progressPercent = Math.round((status.completedCount / status.totalSteps) * 100);

  const stepIcons: Record<string, string> = {
    profile: 'person',
    concierge: 'contact_phone',
    waiver: 'description',
    booking: 'sports_golf',
    app: 'install_mobile',
  };

  return (
    <div className="mb-6 glass-card rounded-2xl p-5 backdrop-blur-xl bg-white/30 dark:bg-white/5 border border-white/20 animate-pop-in">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold text-primary dark:text-white">
            {celebrating ? 'You\'re all set!' : 'Get started with Ever Club'}
          </h3>
          <p className="text-sm text-primary/60 dark:text-white/60 mt-0.5">
            {celebrating
              ? 'You\'ve completed all the steps. Enjoy your membership!'
              : `${status.completedCount} of ${status.totalSteps} steps complete`}
          </p>
        </div>
        <button
          onClick={handleDismiss}
          className="p-1 rounded-lg hover:bg-primary/10 dark:hover:bg-white/10 transition-colors tactile-btn"
          aria-label="Dismiss checklist"
        >
          <span className="material-symbols-outlined text-primary/40 dark:text-white/40 text-xl">close</span>
        </button>
      </div>

      <div className="w-full h-2 bg-primary/10 dark:bg-white/10 rounded-full mb-4 overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-emphasis"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className="space-y-2">
        {status.steps.map((step) => (
          <button
            key={step.key}
            onClick={() => !step.completed && handleStepAction(step)}
            disabled={step.completed}
            className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-fast text-left tactile-row ${
              step.completed
                ? 'bg-accent/10 dark:bg-accent/5'
                : 'hover:bg-primary/5 dark:hover:bg-white/5 cursor-pointer'
            }`}
          >
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
              step.completed
                ? 'bg-accent/20 text-accent'
                : 'bg-primary/10 dark:bg-white/10 text-primary/50 dark:text-white/50'
            }`}>
              <span className="material-symbols-outlined text-lg">
                {step.completed ? 'check_circle' : stepIcons[step.key] || 'circle'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${
                step.completed
                  ? 'text-accent line-through'
                  : 'text-primary dark:text-white'
              }`}>
                {step.label}
              </p>
              <p className="text-xs text-primary/50 dark:text-white/50 truncate">
                {step.description}
              </p>
            </div>
            {!step.completed && (
              <span className="material-symbols-outlined text-primary/30 dark:text-white/30 text-lg">
                chevron_right
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default OnboardingChecklist;
