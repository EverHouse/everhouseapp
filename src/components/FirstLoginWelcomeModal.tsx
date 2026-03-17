import React from 'react';
import { useNavigate } from 'react-router-dom';
import ModalShell from './ModalShell';
import { postWithCredentials } from '../hooks/queries/useFetch';

interface FirstLoginWelcomeModalProps {
  isOpen: boolean;
  onClose: () => void;
  firstName?: string;
}

const FirstLoginWelcomeModal: React.FC<FirstLoginWelcomeModalProps> = ({ isOpen, onClose, firstName }) => {
  const navigate = useNavigate();

  const handleAction = (path: string) => {
    onClose();
    navigate(path);
  };

  const handleSaveConcierge = async () => {
    const link = document.createElement('a');
    link.href = '/Ever_Club_Concierge.vcf';
    link.download = 'Ever_Club_Concierge.vcf';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    try {
      await postWithCredentials('/api/member/onboarding/complete-step', { step: 'concierge' });
    } catch (e) { console.warn('[FirstLoginWelcome] Failed to track onboarding step:', e); }
  };

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="">
      <div className="px-2 pb-4">
        <div className="text-center mb-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 dark:bg-accent/20 flex items-center justify-center">
            <span className="material-symbols-outlined text-3xl text-green-700 dark:text-accent">waving_hand</span>
          </div>
          <h2 className="text-2xl font-bold text-primary dark:text-white mb-2">
            Welcome{firstName ? `, ${firstName}` : ''}!
          </h2>
          <p className="text-primary/60 dark:text-white/60">
            Your membership is ready. Here are a few things to get you started.
          </p>
        </div>

        <div className="space-y-3 mb-6">
          <button
            onClick={() => handleAction('/profile')}
            className="w-full flex items-center gap-4 p-4 rounded-xl bg-primary/5 dark:bg-white/5 hover:bg-primary/10 dark:hover:bg-white/10 transition-colors tactile-btn text-left"
          >
            <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-accent/20 flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-green-700 dark:text-accent text-xl">person</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-primary dark:text-white text-sm">Complete your profile</p>
              <p className="text-xs text-primary/50 dark:text-white/50">Add your phone number and preferences</p>
            </div>
            <span className="material-symbols-outlined text-primary/30 dark:text-white/30 text-xl flex-shrink-0">chevron_right</span>
          </button>

          <button
            onClick={handleSaveConcierge}
            className="w-full flex items-center gap-4 p-4 rounded-xl bg-primary/5 dark:bg-white/5 hover:bg-primary/10 dark:hover:bg-white/10 transition-colors tactile-btn text-left"
          >
            <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-accent/20 flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-green-700 dark:text-accent text-xl">contact_phone</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-primary dark:text-white text-sm">Save concierge contact</p>
              <p className="text-xs text-primary/50 dark:text-white/50">Add Ever Club to your phone contacts</p>
            </div>
            <span className="material-symbols-outlined text-primary/30 dark:text-white/30 text-xl flex-shrink-0">download</span>
          </button>

          <button
            onClick={() => { onClose(); navigate('/profile', { state: { showWaiver: true } }); }}
            className="w-full flex items-center gap-4 p-4 rounded-xl bg-primary/5 dark:bg-white/5 hover:bg-primary/10 dark:hover:bg-white/10 transition-colors tactile-btn text-left"
          >
            <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-accent/20 flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-green-700 dark:text-accent text-xl">description</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-primary dark:text-white text-sm">Sign the club waiver</p>
              <p className="text-xs text-primary/50 dark:text-white/50">Required before your first visit</p>
            </div>
            <span className="material-symbols-outlined text-primary/30 dark:text-white/30 text-xl flex-shrink-0">chevron_right</span>
          </button>

          <button
            onClick={() => handleAction('/book')}
            className="w-full flex items-center gap-4 p-4 rounded-xl bg-primary/5 dark:bg-white/5 hover:bg-primary/10 dark:hover:bg-white/10 transition-colors tactile-btn text-left"
          >
            <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-accent/20 flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-green-700 dark:text-accent text-xl">sports_golf</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-primary dark:text-white text-sm">Book your first session</p>
              <p className="text-xs text-primary/50 dark:text-white/50">Reserve a golf simulator</p>
            </div>
            <span className="material-symbols-outlined text-primary/30 dark:text-white/30 text-xl flex-shrink-0">chevron_right</span>
          </button>
        </div>

        <button
          onClick={onClose}
          className="w-full py-3 rounded-xl font-medium text-primary/60 dark:text-white/60 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors text-sm tactile-btn text-center"
        >
          I'll explore on my own
        </button>
      </div>
    </ModalShell>
  );
};

export default FirstLoginWelcomeModal;
