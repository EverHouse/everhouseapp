import React, { useState } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import SlideUpDrawer from '../SlideUpDrawer';
import Input from '../Input';
import { usePricing } from '../../hooks/usePricing';

interface GuestPaymentChoiceModalProps {
  bookingId: number;
  guestName?: string;
  guestEmail?: string;
  guestPassesRemaining: number;
  onSuccess: (guestName: string) => void;
  onError?: (error: string) => void;
  onClose: () => void;
}

export function GuestPaymentChoiceModal({
  bookingId,
  guestPassesRemaining,
  onSuccess,
  onError,
  onClose
}: GuestPaymentChoiceModalProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const { guestFeeDollars } = usePricing();
  const [animateRef] = useAutoAnimate({ duration: 250 });

  const [step, setStep] = useState<'choice' | 'guest-info'>('choice');
  const [selectedMethod, setSelectedMethod] = useState<'guest_pass' | 'pay_fee' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [guestFirstName, setGuestFirstName] = useState('');
  const [guestLastName, setGuestLastName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestEmailError, setGuestEmailError] = useState<string | undefined>(undefined);

  const validateGuestEmail = (value: string): string | undefined => {
    if (!value.trim()) return 'Email is required for guest tracking';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) return 'Please enter a valid email address';
    return undefined;
  };

  const handleGuestEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setGuestEmail(value);
    if (guestEmailError) {
      setGuestEmailError(validateGuestEmail(value));
    }
  };

  const guestInfoValid = guestFirstName.trim() && guestLastName.trim() && guestEmail.trim() && !validateGuestEmail(guestEmail);

  const handleClose = () => {
    onClose();
  };

  const handleUseGuestPass = async () => {
    const emailError = validateGuestEmail(guestEmail);
    if (emailError) {
      setGuestEmailError(emailError);
      return;
    }

    const fullName = `${guestFirstName.trim()} ${guestLastName.trim()}`;

    setLoading(true);
    setError(null);

    try {
      const { ok, error: apiError } = await apiRequest(
        `/api/bookings/${bookingId}/participants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'guest',
            guest: {
              name: fullName,
              email: guestEmail.trim()
            },
            useGuestPass: true
          })
        }
      );

      if (ok) {
        onSuccess(fullName);
      } else {
        setError(apiError || "We couldn't add your guest at this time. Please try again.");
      }
    } catch (err: unknown) {
      const msg = ((err instanceof Error ? err.message : String(err)) || '').toLowerCase();
      const isTimeout = msg.includes('abort') || msg.includes('timeout');
      if (!isTimeout) {
        setError("Something went wrong adding your guest. Please try again.");
        onError?.(msg || 'Failed to add guest');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAddPaidGuest = async () => {
    const emailError = validateGuestEmail(guestEmail);
    if (emailError) {
      setGuestEmailError(emailError);
      return;
    }
    const fullName = `${guestFirstName.trim()} ${guestLastName.trim()}`;
    setLoading(true);
    setError(null);
    try {
      const { ok, error: apiError } = await apiRequest(
        `/api/bookings/${bookingId}/participants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'guest',
            guest: { name: fullName, email: guestEmail.trim() },
            useGuestPass: false
          })
        }
      );
      if (ok) {
        onSuccess(fullName);
      } else {
        setError(apiError || "Something went wrong adding your guest. Please try again.");
      }
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || "Something went wrong adding your guest. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const getTitle = () => {
    if (step === 'choice') return 'Add Guest';
    return 'Guest Details';
  };

  return (
    <SlideUpDrawer
      isOpen={true}
      onClose={handleClose}
      title={getTitle()}
      maxHeight={step === 'guest-info' ? 'medium' : 'small'}
    >
      <div className="p-4" ref={animateRef}>
        {error && (
          <div className={`mb-4 p-3 rounded-xl flex items-start gap-2.5 animate-content-enter ${
            isDark ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-amber-50 border border-amber-200/60'
          }`}>
            <span className={`material-symbols-outlined text-base mt-0.5 shrink-0 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>info</span>
            <p className={`text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>{error}</p>
          </div>
        )}

        {step === 'choice' && (
          <div key="choice" className="space-y-4">
            <p className={`text-center text-sm font-medium ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
              How would you like to handle your guest's visit?
            </p>

            <div className="space-y-3">
              <button
                onClick={() => { setSelectedMethod('guest_pass'); setStep('guest-info'); }}
                disabled={loading || guestPassesRemaining <= 0}
                className={`w-full p-4 rounded-xl border transition-all duration-fast flex items-start gap-4 active:scale-[0.98] ${
                  guestPassesRemaining > 0
                    ? isDark
                      ? 'border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/15'
                      : 'border-emerald-200 bg-emerald-50/80 hover:bg-emerald-50'
                    : isDark
                      ? 'border-white/10 bg-white/5 opacity-50 cursor-not-allowed'
                      : 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                }`}
              >
                <div className={`w-11 h-11 rounded-full flex items-center justify-center ${
                  guestPassesRemaining > 0
                    ? isDark ? 'bg-emerald-500/20 text-emerald-400' : 'bg-emerald-100 text-emerald-600'
                    : isDark ? 'bg-white/10 text-white/40' : 'bg-gray-100 text-gray-400'
                }`}>
                  <span className="material-symbols-outlined text-xl">confirmation_number</span>
                </div>
                <div className="flex-1 text-left">
                  <p className={`font-semibold ${
                    guestPassesRemaining > 0
                      ? isDark ? 'text-emerald-400' : 'text-emerald-700'
                      : isDark ? 'text-white/40' : 'text-gray-400'
                  }`}>
                    Use Guest Pass
                  </p>
                  <p className={`text-sm ${
                    guestPassesRemaining > 0
                      ? isDark ? 'text-white/50' : 'text-gray-500'
                      : isDark ? 'text-white/30' : 'text-gray-400'
                  }`}>
                    {guestPassesRemaining > 0
                      ? `${guestPassesRemaining} pass${guestPassesRemaining > 1 ? 'es' : ''} remaining`
                      : 'No passes remaining this month'
                    }
                  </p>
                  <p className={`text-lg font-semibold mt-1 ${
                    guestPassesRemaining > 0
                      ? isDark ? 'text-emerald-400' : 'text-emerald-600'
                      : isDark ? 'text-white/40' : 'text-gray-400'
                  }`}>
                    FREE
                  </p>
                </div>
              </button>

              <button
                onClick={() => { setSelectedMethod('pay_fee'); setStep('guest-info'); }}
                disabled={loading}
                className={`w-full p-4 rounded-xl border transition-all duration-fast flex items-start gap-4 active:scale-[0.98] ${
                  isDark
                    ? 'border-[#CCB8E4]/30 bg-[#CCB8E4]/10 hover:bg-[#CCB8E4]/15'
                    : 'border-[#CCB8E4]/60 bg-[#CCB8E4]/8 hover:bg-[#CCB8E4]/15'
                }`}
              >
                <div className={`w-11 h-11 rounded-full flex items-center justify-center ${
                  isDark ? 'bg-[#CCB8E4]/20 text-[#CCB8E4]' : 'bg-[#CCB8E4]/25 text-[#5a4a6d]'
                }`}>
                  <span className="material-symbols-outlined text-xl">credit_card</span>
                </div>
                <div className="flex-1 text-left">
                  <p className={`font-semibold ${isDark ? 'text-[#CCB8E4]' : 'text-[#5a4a6d]'}`}>
                    Pay Guest Fee
                  </p>
                  <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                    One-time charge for this visit
                  </p>
                  <p className={`text-lg font-semibold mt-1 ${isDark ? 'text-white' : 'text-primary'}`}>
                    ${guestFeeDollars.toFixed(2)}
                  </p>
                </div>
              </button>
            </div>
          </div>
        )}

        {step === 'guest-info' && (
          <div key="guest-info" className="space-y-4">
            <button
              onClick={() => {
                setStep('choice');
                setSelectedMethod(null);
                setError(null);
              }}
              className={`flex items-center gap-1 text-sm font-medium transition-colors ${
                isDark ? 'text-white/60 hover:text-white' : 'text-primary/60 hover:text-primary'
              }`}
            >
              <span className="material-symbols-outlined text-lg">arrow_back</span>
              Back
            </button>

            {selectedMethod === 'guest_pass' && (
              <div className={`p-3 rounded-xl ${isDark ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-emerald-50 border border-emerald-200/60'}`}>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-lg ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                    confirmation_number
                  </span>
                  <p className={`text-sm font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                    Using Guest Pass ({guestPassesRemaining} remaining)
                  </p>
                </div>
              </div>
            )}

            {selectedMethod === 'pay_fee' && (
              <div className={`p-3 rounded-xl ${isDark ? 'bg-[#CCB8E4]/10 border border-[#CCB8E4]/20' : 'bg-[#CCB8E4]/10 border border-[#CCB8E4]/30'}`}>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-lg ${isDark ? 'text-[#CCB8E4]' : 'text-[#5a4a6d]'}`}>
                    credit_card
                  </span>
                  <p className={`text-sm font-medium ${isDark ? 'text-[#CCB8E4]' : 'text-[#5a4a6d]'}`}>
                    Guest Fee: ${guestFeeDollars.toFixed(2)} will be added to booking fees
                  </p>
                </div>
              </div>
            )}

            <Input
              label="First Name"
              placeholder="Enter first name"
              value={guestFirstName}
              onChange={(e) => setGuestFirstName(e.target.value)}
              icon="person"
            />

            <Input
              label="Last Name"
              placeholder="Enter last name"
              value={guestLastName}
              onChange={(e) => setGuestLastName(e.target.value)}
              icon="person"
            />

            <Input
              label="Guest Email"
              placeholder="Enter guest's email"
              type="email"
              value={guestEmail}
              onChange={handleGuestEmailChange}
              onBlur={() => {
                if (guestEmail.trim()) {
                  setGuestEmailError(validateGuestEmail(guestEmail));
                }
              }}
              icon="mail"
              error={guestEmailError}
              required
            />

            <button
              onClick={selectedMethod === 'guest_pass' ? handleUseGuestPass : handleAddPaidGuest}
              disabled={!guestInfoValid || loading}
              className={`relative w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all duration-fast flex items-center justify-center gap-2 ${
                guestInfoValid && !loading
                  ? selectedMethod === 'guest_pass'
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700 active:scale-[0.98]'
                    : 'bg-[#CCB8E4] text-[#293515] hover:bg-[#baa6d6] active:scale-[0.98]'
                  : isDark
                    ? 'bg-white/10 text-white/40 cursor-not-allowed'
                    : 'bg-black/5 text-black/30 cursor-not-allowed'
              }`}
            >
              <span className={`flex items-center gap-2 transition-opacity ${loading ? 'opacity-0' : 'opacity-100'}`}>
                {selectedMethod === 'guest_pass' ? (
                  <>
                    <span className="material-symbols-outlined text-lg">confirmation_number</span>
                    Use Guest Pass
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-lg">credit_card</span>
                    Add Guest (${guestFeeDollars.toFixed(2)} fee)
                  </>
                )}
              </span>
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </button>
          </div>
        )}
      </div>
    </SlideUpDrawer>
  );
}

export default GuestPaymentChoiceModal;
