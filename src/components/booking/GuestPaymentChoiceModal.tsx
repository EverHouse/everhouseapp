import React, { useState } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import { StripePaymentForm } from '../stripe/StripePaymentForm';
import SlideUpDrawer from '../SlideUpDrawer';
import Input from '../Input';
import { usePricing } from '../../hooks/usePricing';

interface GuestPaymentChoiceModalProps {
  bookingId: number;
  sessionId: number | null;
  guestName?: string;
  guestEmail?: string;
  ownerEmail: string;
  ownerName: string;
  guestPassesRemaining: number;
  onSuccess: (guestName: string) => void;
  onError?: (error: string) => void;
  onClose: () => void;
}

interface GuestAddResponse {
  success: boolean;
  participantId: number;
  guestId: number;
  passesRemaining?: number;
}

interface PaymentInitResponse {
  clientSecret?: string;
  paymentIntentId?: string;
  amount: number;
  participantId: number;
  paidInFull?: boolean;
  balanceApplied?: number;
  remainingCents?: number;
}

export function GuestPaymentChoiceModal({
  bookingId,
  sessionId,
  guestName: initialGuestName,
  guestEmail: initialGuestEmail,
  ownerEmail,
  ownerName,
  guestPassesRemaining,
  onSuccess,
  onError,
  onClose
}: GuestPaymentChoiceModalProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const { guestFeeDollars } = usePricing();

  const [step, setStep] = useState<'choice' | 'guest-info' | 'payment'>('choice');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentData, setPaymentData] = useState<PaymentInitResponse | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);

  const [guestFirstName, setGuestFirstName] = useState('');
  const [guestLastName, setGuestLastName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestEmailError, setGuestEmailError] = useState<string | undefined>(undefined);

  const [activeGuestName, setActiveGuestName] = useState(initialGuestName || 'Guest');

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

  const handleClose = async () => {
    if (step === 'payment' && paymentData) {
      try {
        await apiRequest(
          `/api/bookings/${bookingId}/cancel-guest-payment`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              participantId: paymentData.participantId,
              paymentIntentId: paymentData.paymentIntentId
            })
          }
        );
      } catch (err: unknown) {
        console.error('[GuestPaymentChoice] Error cancelling payment:', err);
      }
    }
    onClose();
  };

  const handleUseGuestPass = async () => {
    const emailError = validateGuestEmail(guestEmail);
    if (emailError) {
      setGuestEmailError(emailError);
      return;
    }

    const fullName = `${guestFirstName.trim()} ${guestLastName.trim()}`;

    onSuccess(fullName);

    apiRequest<GuestAddResponse>(
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
    ).then(({ ok, error: apiError }) => {
      if (!ok) {
        const msg = (apiError || '').toLowerCase();
        const isTimeout = msg.includes('abort') || msg.includes('timeout');
        if (!isTimeout) {
          onError?.(apiError || 'Failed to add guest with pass');
        }
      }
    }).catch((err: unknown) => {
      const msg = ((err instanceof Error ? err.message : String(err)) || '').toLowerCase();
      const isTimeout = msg.includes('abort') || msg.includes('timeout');
      if (!isTimeout) {
        onError?.(msg || 'Failed to add guest');
      }
    });
  };

  const handlePayFee = async () => {
    setLoading(true);
    setError(null);

    const gName = 'Guest';
    setActiveGuestName(gName);

    try {
      const { ok, data, error: apiError } = await apiRequest<PaymentInitResponse>(
        `/api/bookings/${bookingId}/guest-fee-checkout`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guestName: gName,
            guestEmail: `guest-${Date.now()}@guest.local`
          })
        }
      );

      if (ok && data) {
        if (data.paidInFull) {
          onSuccess(gName);
          return;
        }
        setPaymentData(data);
        setPaymentIntentId(data.paymentIntentId || null);
        setStep('payment');
      } else {
        setError(apiError || 'Failed to initialize payment');
      }
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Failed to initialize payment');
    } finally {
      setLoading(false);
    }
  };

  const handlePaymentSuccess = async () => {
    if (!paymentIntentId || !paymentData) {
      onSuccess(activeGuestName);
      return;
    }

    try {
      const { ok, error: confirmError } = await apiRequest(
        `/api/bookings/${bookingId}/confirm-guest-payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentIntentId,
            participantId: paymentData.participantId
          })
        }
      );

      if (!ok) {
        console.error('[GuestPaymentChoice] Failed to confirm payment:', confirmError);
        setError(confirmError || 'Payment succeeded but confirmation failed. Please contact support.');
        return;
      }

      onSuccess(activeGuestName);
    } catch (err: unknown) {
      console.error('[GuestPaymentChoice] Error confirming payment:', err);
      setError((err instanceof Error ? err.message : String(err)) || 'Payment succeeded but confirmation failed. Please contact support.');
    }
  };

  const getTitle = () => {
    if (step === 'choice') return 'Add Guest';
    if (step === 'guest-info') return 'Guest Information';
    return 'Pay Guest Fee';
  };

  return (
    <SlideUpDrawer
      isOpen={true}
      onClose={handleClose}
      title={getTitle()}
      maxHeight={step === 'guest-info' ? 'medium' : 'small'}
    >
      <div className="p-4">
        {error && (
          <div className={`mb-4 p-3 rounded-xl ${isDark ? 'bg-red-500/20 text-red-400' : 'bg-red-50 text-red-600'}`}>
            {error}
          </div>
        )}

        {step === 'choice' && (
          <div className="space-y-4">
            <p className={`text-center text-sm font-medium ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
              How would you like to cover this guest?
            </p>

            <div className="space-y-3">
              <button
                onClick={() => setStep('guest-info')}
                disabled={loading || guestPassesRemaining <= 0}
                className={`w-full p-4 rounded-xl border-2 transition-all duration-fast flex items-start gap-4 tactile-btn ${
                  guestPassesRemaining > 0
                    ? isDark
                      ? 'border-emerald-500/50 bg-emerald-500/10 hover:bg-emerald-500/20'
                      : 'border-emerald-500/50 bg-emerald-50 hover:bg-emerald-100'
                    : isDark
                      ? 'border-white/10 bg-white/5 opacity-50 cursor-not-allowed'
                      : 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                }`}
              >
                <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                  guestPassesRemaining > 0
                    ? isDark ? 'bg-emerald-500/20 text-emerald-400' : 'bg-emerald-100 text-emerald-600'
                    : isDark ? 'bg-white/10 text-white/40' : 'bg-gray-100 text-gray-400'
                }`}>
                  <span className="material-symbols-outlined text-2xl">confirmation_number</span>
                </div>
                <div className="flex-1 text-left">
                  <p className={`font-bold ${
                    guestPassesRemaining > 0
                      ? isDark ? 'text-emerald-400' : 'text-emerald-700'
                      : isDark ? 'text-white/40' : 'text-gray-400'
                  }`}>
                    Use Guest Pass
                  </p>
                  <p className={`text-sm ${
                    guestPassesRemaining > 0
                      ? isDark ? 'text-white/60' : 'text-gray-600'
                      : isDark ? 'text-white/30' : 'text-gray-400'
                  }`}>
                    {guestPassesRemaining > 0
                      ? `${guestPassesRemaining} pass${guestPassesRemaining > 1 ? 'es' : ''} remaining`
                      : 'No passes remaining this month'
                    }
                  </p>
                  <p className={`text-lg font-bold mt-1 ${
                    guestPassesRemaining > 0
                      ? isDark ? 'text-emerald-400' : 'text-emerald-600'
                      : isDark ? 'text-white/40' : 'text-gray-400'
                  }`}>
                    FREE
                  </p>
                </div>
              </button>

              <button
                onClick={handlePayFee}
                disabled={loading}
                className={`w-full p-4 rounded-xl border-2 transition-all duration-fast flex items-start gap-4 tactile-btn ${
                  isDark
                    ? 'border-[#CCB8E4]/50 bg-[#CCB8E4]/10 hover:bg-[#CCB8E4]/20'
                    : 'border-[#CCB8E4] bg-[#CCB8E4]/10 hover:bg-[#CCB8E4]/20'
                }`}
              >
                <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                  isDark ? 'bg-[#CCB8E4]/20 text-[#CCB8E4]' : 'bg-[#CCB8E4]/30 text-[#5a4a6d]'
                }`}>
                  <span className="material-symbols-outlined text-2xl">credit_card</span>
                </div>
                <div className="flex-1 text-left">
                  <p className={`font-bold ${isDark ? 'text-[#CCB8E4]' : 'text-[#5a4a6d]'}`}>
                    Pay Guest Fee
                  </p>
                  <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                    One-time charge for this visit
                  </p>
                  <p className={`text-lg font-bold mt-1 ${isDark ? 'text-white' : 'text-primary'}`}>
                    ${guestFeeDollars.toFixed(2)}
                  </p>
                </div>
                {loading && (
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                )}
              </button>
            </div>
          </div>
        )}

        {step === 'guest-info' && (
          <div className="space-y-4">
            <button
              onClick={() => {
                setStep('choice');
                setError(null);
              }}
              className={`flex items-center gap-1 text-sm font-medium transition-colors ${
                isDark ? 'text-white/60 hover:text-white' : 'text-primary/60 hover:text-primary'
              }`}
            >
              <span className="material-symbols-outlined text-lg">arrow_back</span>
              Back
            </button>

            <div className={`p-3 rounded-xl ${isDark ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-emerald-50 border border-emerald-200'}`}>
              <div className="flex items-center gap-2">
                <span className={`material-symbols-outlined text-lg ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                  confirmation_number
                </span>
                <p className={`text-sm font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                  Using Guest Pass ({guestPassesRemaining} remaining)
                </p>
              </div>
            </div>

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
              onClick={handleUseGuestPass}
              disabled={!guestInfoValid || loading}
              className={`w-full py-3 px-4 rounded-xl font-bold text-sm transition-all duration-fast flex items-center justify-center gap-2 ${
                guestInfoValid && !loading
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700 active:scale-[0.98]'
                  : isDark
                    ? 'bg-white/10 text-white/40 cursor-not-allowed'
                    : 'bg-black/5 text-black/30 cursor-not-allowed'
              }`}
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span className="material-symbols-outlined text-lg">confirmation_number</span>
                  Use Guest Pass
                </>
              )}
            </button>
          </div>
        )}

        {step === 'payment' && paymentData && (
          <div className="space-y-4">
            <div className={`rounded-xl p-4 ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
              <h4 className={`text-sm font-bold mb-3 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                Guest Fee
              </h4>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                    isDark
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-amber-100 text-amber-700'
                  }`}>
                    G
                  </span>
                  <span className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                    {activeGuestName}
                  </span>
                </div>
                <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>
                  ${(paymentData.amount / 100).toFixed(2)}
                </span>
              </div>
            </div>

            <StripePaymentForm
              amount={paymentData.amount / 100}
              description={`Guest fee for ${activeGuestName}`}
              userId={ownerEmail}
              userEmail={ownerEmail}
              memberName={ownerName}
              purpose="guest_fee"
              bookingId={bookingId}
              sessionId={sessionId || undefined}
              participantFees={[{ id: paymentData.participantId, amount: paymentData.amount / 100 }]}
              onSuccess={handlePaymentSuccess}
              onCancel={handleClose}
            />
          </div>
        )}
      </div>
    </SlideUpDrawer>
  );
}

export default GuestPaymentChoiceModal;
