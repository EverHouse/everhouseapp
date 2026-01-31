import React, { useState } from 'react';
import SlideUpDrawer from './SlideUpDrawer';
import { useTheme } from '../contexts/ThemeContext';
import { useToast } from './Toast';

interface WaiverModalProps {
  isOpen: boolean;
  onComplete: () => void;
  currentVersion: string;
}

export function WaiverModal({ isOpen, onComplete, currentVersion }: WaiverModalProps) {
  const { effectiveTheme } = useTheme();
  const { showToast } = useToast();
  const isDark = effectiveTheme === 'dark';
  const [agreed, setAgreed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const isAtBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 50;
    if (isAtBottom && !scrolledToBottom) {
      setScrolledToBottom(true);
    }
  };

  const handleSign = async () => {
    if (!agreed) {
      showToast('Please agree to the waiver terms', 'error');
      return;
    }
    
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/waivers/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      
      if (!res.ok) {
        throw new Error('Failed to sign waiver');
      }
      
      showToast('Waiver signed successfully', 'success');
      onComplete();
    } catch (error) {
      showToast('Failed to sign waiver. Please try again.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const stickyFooterContent = (
    <div className="p-4 space-y-4">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          disabled={!scrolledToBottom}
          className={`mt-1 w-5 h-5 rounded border-2 ${
            isDark 
              ? 'bg-black/20 border-white/20 accent-[#a3e635]' 
              : 'bg-white border-gray-300 accent-primary'
          } ${!scrolledToBottom ? 'opacity-50 cursor-not-allowed' : ''}`}
        />
        <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
          I have read and agree to the terms of this waiver.
          {!scrolledToBottom && (
            <span className={`block text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              (Please scroll to the bottom to enable)
            </span>
          )}
        </span>
      </label>

      <button
        onClick={handleSign}
        disabled={!agreed || isSubmitting}
        className={`w-full py-3 px-4 rounded-xl font-semibold transition-all ${
          agreed && !isSubmitting
            ? isDark
              ? 'bg-[#a3e635] text-[#1a1d15] hover:bg-[#bef264]'
              : 'bg-primary text-white hover:bg-primary/90'
            : isDark
              ? 'bg-white/10 text-white/30 cursor-not-allowed'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
        }`}
      >
        {isSubmitting ? (
          <span className="flex items-center justify-center gap-2">
            <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
            Signing...
          </span>
        ) : (
          'Sign Waiver'
        )}
      </button>
    </div>
  );

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={() => {}}
      title="Membership Waiver"
      showCloseButton={false}
      dismissible={false}
      maxHeight="full"
      stickyFooter={stickyFooterContent}
      onContentScroll={handleScroll}
    >
      <div className="p-4 space-y-4">
        <div className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          <p className="mb-2">
            Our waiver has been updated to version <strong>{currentVersion}</strong>. 
            Please review and sign to continue using your membership.
          </p>
        </div>

        <div className={`text-sm space-y-4 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
          <h4 className={`font-display text-xl mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            Liability Waiver Agreement
          </h4>
          
          <p>
            Please read the liability waiver below and provide your agreement. You must agree 
            to the terms before entering Ever House. The following provisions are critical 
            legal protections for the Club – please read them carefully:
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Waiver of Claims</h5>
          <p>
            To the maximum extent allowed by law, you release Ever House, its owners, partners, 
            employees, and agents from any and all liability or claims for property damage, 
            personal injury, illness, or death arising out of or relating to your membership 
            or presence at the Club. This waiver applies to any injuries or damages occurring 
            on the Club premises or during Club-sponsored activities, whether caused by inherent 
            risks (e.g. being struck by a golf ball) or by negligence of the Club or its staff.
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Assumption of Risk</h5>
          <p>
            You understand and voluntarily accept all risks inherent in using the Club, including 
            but not limited to: athletic injuries, equipment malfunctions, or interactions with 
            other members. You agree to use facilities safely and within your personal limits.
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Indemnification</h5>
          <p>
            You agree to indemnify and hold harmless Ever House from any claims, damages, or 
            expenses (including legal fees) arising from your actions or the actions of your 
            guests at the Club.
          </p>

          <p className={`text-xs opacity-70 mt-6`}>
            By checking the box below, you confirm that you have read this Agreement, understand 
            its terms, and agree to be bound by it. This includes the assumption of risk and 
            waiver of liability, which you acknowledge as a condition of entry.
          </p>

          <p className={`font-medium ${isDark ? 'text-[#a3e635]' : 'text-primary'}`}>
            — End of Waiver Document —
          </p>
        </div>
      </div>
    </SlideUpDrawer>
  );
}

export default WaiverModal;
