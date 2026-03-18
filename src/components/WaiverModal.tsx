import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import SlideUpDrawer from './SlideUpDrawer';
import { useTheme } from '../contexts/ThemeContext';
import { useToast } from './Toast';
import { postWithCredentials } from '../hooks/queries/useFetch';

interface WaiverModalProps {
  isOpen: boolean;
  onComplete: () => void;
  currentVersion: string;
}

export function WaiverModal({ isOpen, onComplete, currentVersion }: WaiverModalProps) {
  const { effectiveTheme } = useTheme();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const isDark = effectiveTheme === 'dark';
  const [agreed, setAgreed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEmailing, setIsEmailing] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const endOfWaiverRef = useRef<HTMLDivElement>(null);

  const markScrolledToBottom = useCallback(() => {
    setScrolledToBottom(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setScrolledToBottom(false);
      setAgreed(false);
      setEmailSent(false);
    }
  }, [isOpen, currentVersion]);

  useEffect(() => {
    if (!isOpen || scrolledToBottom) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const sentinel = endOfWaiverRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          markScrolledToBottom();
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    const timer = setTimeout(() => {
      observer.observe(sentinel);
    }, 500);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [isOpen, scrolledToBottom, markScrolledToBottom]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const isAtBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 100;
    if (isAtBottom && !scrolledToBottom) {
      markScrolledToBottom();
    }
  };

  const handleSign = async () => {
    if (!agreed) {
      showToast('Please agree to the Membership Agreement terms', 'error');
      return;
    }
    
    setIsSubmitting(true);
    try {
      await postWithCredentials('/api/waivers/sign', {});
      
      queryClient.invalidateQueries({ queryKey: ['waiverStatus'] });
      showToast('Membership Agreement signed successfully', 'success');
      onComplete();
    } catch (_error: unknown) {
      showToast('Failed to sign agreement. Please try again.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEmailCopy = async () => {
    setIsEmailing(true);
    try {
      await postWithCredentials('/api/waivers/email-copy', {});
      setEmailSent(true);
      showToast('Agreement emailed to you successfully', 'success');
    } catch (_error: unknown) {
      showToast('Failed to send email. Please try again.', 'error');
    } finally {
      setIsEmailing(false);
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
          I have read and agree to the terms of this Membership Agreement.
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
        className={`w-full py-3 px-4 rounded-xl font-semibold transition-all duration-fast tactile-btn ${
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
          'Sign Membership Agreement'
        )}
      </button>

      <button
        onClick={handleEmailCopy}
        disabled={isEmailing || emailSent}
        className={`w-full py-2.5 px-4 rounded-xl text-sm font-medium transition-all duration-fast flex items-center justify-center gap-2 ${
          emailSent
            ? isDark
              ? 'bg-white/5 text-[#a3e635]'
              : 'bg-gray-50 text-primary'
            : isEmailing
              ? isDark
                ? 'bg-white/5 text-white/50 cursor-not-allowed'
                : 'bg-gray-50 text-gray-400 cursor-not-allowed'
              : isDark
                ? 'bg-white/5 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-gray-50 text-gray-600 hover:bg-gray-100 hover:text-gray-800'
        }`}
      >
        {isEmailing ? (
          <>
            <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
            Sending...
          </>
        ) : emailSent ? (
          <>
            <span className="material-symbols-outlined text-base">check_circle</span>
            Agreement Emailed
          </>
        ) : (
          <>
            <span className="material-symbols-outlined text-base">mail</span>
            Email Me a Copy
          </>
        )}
      </button>
    </div>
  );

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={() => {}}
      title="Membership Agreement"
      showCloseButton={false}
      dismissible={false}
      maxHeight="full"
      stickyFooter={stickyFooterContent}
      onContentScroll={handleScroll}
    >
      <div className="p-4 space-y-4">
        <div className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          <p className="mb-2">
            Our Membership Agreement has been updated to version <strong>{currentVersion}</strong>. 
            Please review and sign to continue using your membership.
          </p>
        </div>

        <div className={`text-sm space-y-4 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
          <h4 className={`font-display text-xl mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            Ever Members Club – Membership Agreement
          </h4>
          
          <p>
            Please read the Membership Agreement below carefully. You must agree to these terms 
            as a condition of your membership at Ever Members Club. This Agreement is a binding 
            legal contract – please review each section before signing.
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Section 1. Recurring Billing Authorization</h5>
          <p>
            By signing this Agreement, you authorize Ever Members Club ("the Club") to charge your 
            designated payment method on a recurring basis for your membership dues at the rate 
            associated with your selected membership tier. You acknowledge that your membership 
            dues will be billed automatically each billing cycle (monthly or annually, as applicable) 
            until your membership is cancelled in accordance with Section 2. You are responsible for 
            keeping your payment information current. If a payment fails, the Club reserves the right 
            to suspend your membership privileges until payment is received. The Club may update 
            pricing with at least 30 days' written notice before your next billing cycle.
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Section 2. Cancellation Policy</h5>
          <p>
            You may cancel your membership at any time by submitting a cancellation request through 
            the Ever Members Club app or by contacting Club staff in writing. Cancellation will take 
            effect at the end of your current billing period – no partial-month refunds will be issued. 
            If you cancel, you will retain access to Club facilities through the remainder of your 
            paid billing cycle. Any promotional or discounted rates may not be available if you 
            re-enroll after cancellation. The Club reserves the right to terminate your membership 
            for cause (including but not limited to violation of Club rules, non-payment, or 
            inappropriate behavior) with or without notice.
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Section 3. Guest Policy & Guest Fees</h5>
          <p>
            Members may bring guests to the Club subject to the guest policy applicable to their 
            membership tier. Each membership tier includes a specified number of complimentary guest 
            passes per year. Additional guest visits beyond the included passes will incur a guest 
            fee, which will be charged to the member's payment method on file. Members are responsible 
            for the conduct of their guests at all times. Guests must comply with all Club rules 
            and policies. The Club reserves the right to refuse entry to any guest and to modify the 
            guest policy or fees with reasonable notice.
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Section 4. Equipment & Facility Damage</h5>
          <p>
            Members and their guests are expected to treat all Club equipment, simulators, furnishings, 
            and facilities with care. You agree to report any damage or malfunction immediately to 
            Club staff. You will be held financially responsible for any damage to Club property 
            caused by your intentional misconduct, gross negligence, or misuse of equipment. This 
            includes but is not limited to damage to golf simulators, screens, projectors, clubs, 
            furniture, and common areas. The Club will assess repair or replacement costs at its 
            reasonable discretion, and such costs may be charged to your payment method on file.
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Section 6. Surveillance & Recording Consent</h5>
          <p>
            You acknowledge and consent to the use of video surveillance cameras and audio/video 
            recording equipment throughout Club premises, including but not limited to common areas, 
            simulator bays, and entry/exit points. These systems are used for security, safety, and 
            operational purposes. By entering the Club, you consent to being recorded. The Club may 
            use surveillance footage for security investigations, dispute resolution, and operational 
            improvement. You agree not to tamper with, obstruct, or disable any surveillance equipment. 
            Footage is retained in accordance with the Club's data retention policy.
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Section 7. SMS & Communication Consent</h5>
          <p>
            By providing your phone number, you consent to receive SMS text messages, push notifications, 
            and other electronic communications from the Club related to your membership, bookings, 
            billing, promotions, and Club operations. Message frequency varies. Message and data rates 
            may apply. You may opt out of promotional messages at any time by replying STOP, but you 
            acknowledge that transactional messages related to your membership (such as booking 
            confirmations, payment receipts, and account alerts) are a necessary part of the 
            membership service and cannot be individually opted out of while your membership is active.
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Section 8. Liability Waiver & Assumption of Risk</h5>
          <p>
            To the maximum extent allowed by law, you release Ever Members Club, its owners, partners, 
            officers, employees, and agents from any and all liability, claims, demands, or causes 
            of action for property damage, personal injury, illness, or death arising out of or 
            relating to your membership, presence at the Club, or participation in Club activities. 
            This waiver applies to injuries or damages occurring on Club premises or during 
            Club-sponsored activities, whether caused by inherent risks (e.g., being struck by a 
            golf ball, equipment malfunction) or by the negligence of the Club or its staff.
          </p>
          <p>
            You understand and voluntarily accept all risks inherent in using the Club's facilities 
            and services, including but not limited to: athletic injuries, repetitive motion injuries, 
            equipment malfunctions, interactions with other members or guests, and risks associated 
            with food and beverage consumption. You agree to use all facilities and equipment safely 
            and within your personal physical limits.
          </p>
          <p>
            You agree to indemnify, defend, and hold harmless Ever Members Club from any claims, 
            damages, losses, or expenses (including reasonable legal fees) arising from your actions, 
            omissions, or the actions of your guests at the Club.
          </p>

          <h5 className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Section 9. Dispute Resolution & Arbitration</h5>
          <p>
            Any dispute, controversy, or claim arising out of or relating to this Agreement, your 
            membership, or your use of Club facilities shall first be addressed through good-faith 
            informal negotiation. If the dispute cannot be resolved informally within 30 days, it 
            shall be resolved exclusively through binding arbitration administered in accordance with 
            the rules of the American Arbitration Association (AAA). The arbitration shall take place 
            in Dallas County, Texas. The arbitrator's decision shall be final and binding and may be 
            entered as a judgment in any court of competent jurisdiction. You agree that any dispute 
            resolution proceedings will be conducted on an individual basis and not as part of a class, 
            consolidated, or representative action. Each party shall bear its own costs and attorney's 
            fees unless the arbitrator determines otherwise.
          </p>

          <p className={`text-xs opacity-70 mt-6`}>
            By checking the box below, you confirm that you have read this Membership Agreement in 
            its entirety, understand its terms, and agree to be bound by all provisions herein. 
            This includes the recurring billing authorization, cancellation policy, liability waiver 
            and assumption of risk, and binding arbitration clause, which you acknowledge as 
            conditions of your membership.
          </p>

          <p className={`font-medium ${isDark ? 'text-[#a3e635]' : 'text-primary'}`}>
            — End of Membership Agreement —
          </p>
          <div ref={endOfWaiverRef} aria-hidden="true" className="h-px w-full" />
        </div>
      </div>
    </SlideUpDrawer>
  );
}

export default WaiverModal;
