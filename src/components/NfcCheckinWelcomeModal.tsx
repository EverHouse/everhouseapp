import React, { useEffect, useRef } from 'react';
import ModalShell from './ModalShell';
import { playSound } from '../utils/sounds';

interface NfcCheckinWelcomeModalProps {
  isOpen: boolean;
  onClose: () => void;
  checkinData: { type: 'success' | 'already_checked_in'; memberName: string; tier?: string | null } | null;
}

const NfcCheckinWelcomeModal: React.FC<NfcCheckinWelcomeModalProps> = ({ isOpen, onClose, checkinData }) => {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isOpen && checkinData) {
      if (checkinData.type === 'success') {
        playSound('checkinSuccess');
      } else {
        playSound('tap');
      }

      timeoutRef.current = setTimeout(() => {
        onClose();
      }, 3500);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isOpen, checkinData, onClose]);

  if (!checkinData) return null;

  const isSuccess = checkinData.type === 'success';

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="" showCloseButton={false}>
      <div className="text-center px-2 pb-6 pt-2 cursor-pointer" onClick={onClose}>
        {isSuccess ? (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-accent/20 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-accent">check_circle</span>
            </div>
            <h2 className="text-2xl font-bold text-primary dark:text-white mb-1">
              Welcome, {checkinData.memberName}!
            </h2>
            <p className="text-primary/60 dark:text-white/60 text-sm font-medium mb-3">
              You're checked in
            </p>
            {checkinData.tier && (
              <div className="inline-flex items-center px-3 py-1 rounded-full bg-accent/15 text-accent text-xs font-semibold uppercase tracking-wider mb-4">
                {checkinData.tier}
              </div>
            )}
            <p className="text-primary/50 dark:text-white/50 text-sm">
              Enjoy your visit!
            </p>
          </>
        ) : (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-500/20 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-blue-500">info</span>
            </div>
            <h2 className="text-2xl font-bold text-primary dark:text-white mb-1">
              Already Checked In
            </h2>
            <p className="text-primary/60 dark:text-white/60 text-sm font-medium">
              {checkinData.memberName}, you were already checked in
            </p>
          </>
        )}
        <p className="text-primary/30 dark:text-white/30 text-xs mt-4">
          Tap to dismiss
        </p>
      </div>
    </ModalShell>
  );
};

export default NfcCheckinWelcomeModal;
