import React, { useState, useEffect, useCallback } from 'react';
import { useToast } from '../../Toast';
import { StripePaymentForm } from '../../stripe/StripePaymentForm';
import { TerminalPayment } from '../TerminalPayment';
import SlideUpDrawer from '../../SlideUpDrawer';
import { useBookingActions } from '../../../hooks/useBookingActions';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';
import { BOOKING_STATUS, PAYMENT_STATUS, PARTICIPANT_TYPE } from '../../../../shared/constants/statuses';
import { fetchWithCredentials, postWithCredentials, patchWithCredentials, putWithCredentials } from '../../../hooks/queries/useFetch';
import type { PaymentStatus, ParticipantType } from '../../../../shared/constants/statuses';

function formatTime12Hour(time: string | undefined): string {
  if (!time) return '';
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
}

function formatBookingDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  // Handle both YYYY-MM-DD and ISO formats (with T and timezone)
  const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
  const date = new Date(datePart + 'T00:00:00');
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { 
    weekday: 'short', 
    month: 'short', 
    day: 'numeric',
    timeZone: 'America/Los_Angeles' 
  });
}

interface ParticipantFee {
  participantId: number;
  displayName: string;
  participantType: ParticipantType;
  paymentStatus: PaymentStatus;
  overageFee: number;
  guestFee: number;
  totalFee: number;
  tierAtBooking: string | null;
  dailyAllowance?: number;
  minutesUsed?: number;
  guestPassUsed?: boolean;
  prepaidOnline?: boolean;
  cachedFeeCents?: number | null;
}

interface CheckinContext {
  bookingId: number;
  sessionId: number | null;
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  memberNotes: string | null;
  participants: ParticipantFee[];
  totalOutstanding: number;
  hasUnpaidBalance: boolean;
  memberAccountBalance?: {
    availableCreditCents: number;
    availableCreditDollars: number;
    stripeCustomerId: string | null;
  };
}

interface CheckinBillingModalProps {
  isOpen: boolean;
  onClose: () => void;
  bookingId: number;
  onCheckinComplete: () => void;
}

export const CheckinBillingModal: React.FC<CheckinBillingModalProps> = ({
  isOpen,
  onClose,
  bookingId,
  onCheckinComplete
}) => {
  const { showToast } = useToast();
  const { checkInWithToast, chargeCardWithToast } = useBookingActions();
  const [context, setContext] = useState<CheckinContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [waiverReason, setWaiverReason] = useState('');
  const [showWaiverInput, setShowWaiverInput] = useState<number | 'all' | null>(null);
  const [showStripePayment, setShowStripePayment] = useState(false);
  const [frozenPaymentData, setFrozenPaymentData] = useState<{
    participantFees: Array<{id: number; amount: number}>;
    totalAmount: number;
    description: string;
  } | null>(null);
  const [savedCardInfo, setSavedCardInfo] = useState<{
    hasSavedCard: boolean;
    cardLast4?: string;
    cardBrand?: string;
  } | null>(null);
  const [_checkingCard, setCheckingCard] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'online' | 'terminal'>('terminal');

  const fetchContext = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWithCredentials<CheckinContext>(`/api/bookings/${bookingId}/staff-checkin-context`);
      setContext(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load billing context');
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[CheckinBillingModal] Props changed:', { isOpen, bookingId });
    if (isOpen && bookingId) {
      // eslint-disable-next-line no-console
      console.log('[CheckinBillingModal] Opening and fetching context');
      fetchContext();
    }
  }, [isOpen, bookingId, fetchContext]);

  const checkSavedCard = async (email: string) => {
    try {
      setCheckingCard(true);
      const data = await fetchWithCredentials<{ hasSavedCard: boolean; cardLast4?: string; cardBrand?: string }>(`/api/stripe/staff/check-saved-card/${encodeURIComponent(email)}`);
      setSavedCardInfo(data);
    } catch (err: unknown) {
      console.error('Failed to check saved card:', err);
    } finally {
      setCheckingCard(false);
    }
  };

  useEffect(() => {
    if (context?.ownerEmail && isOpen) {
      checkSavedCard(context.ownerEmail);
    }
  }, [context?.ownerEmail, isOpen]);

  const handleChargeSavedCard = async () => {
    if (!context || !savedCardInfo?.hasSavedCard) return;
    
    const pendingParticipants = context.participants.filter(p => 
      p.paymentStatus === PAYMENT_STATUS.PENDING && p.totalFee > 0
    );
    const participantIds = pendingParticipants.map(p => p.participantId);

    setActionInProgress('charge-saved-card');
    try {
      const result = await chargeCardWithToast({
        memberEmail: context.ownerEmail,
        bookingId,
        sessionId: context.sessionId!,
        participantIds
      });
      
      if (result.success) {
        await fetchContext();
        onCheckinComplete();
        onClose();
      } else if (result.noSavedCard) {
        setSavedCardInfo({ hasSavedCard: false });
      }
    } finally {
      setActionInProgress(null);
    }
  };

  const handleConfirmPayment = async (participantId: number) => {
    if (!context) return;
    
    const previousContext = context;
    
    setContext({
      ...context,
      participants: context.participants.map(p =>
        p.participantId === participantId ? { ...p, paymentStatus: PAYMENT_STATUS.PAID } : p
      ),
      totalOutstanding: context.totalOutstanding - (context.participants.find(p => p.participantId === participantId)?.totalFee || 0),
      hasUnpaidBalance: context.participants.filter(p => p.participantId !== participantId && p.paymentStatus === PAYMENT_STATUS.PENDING && p.totalFee > 0).length > 0
    });
    
    setActionInProgress(`confirm-${participantId}`);
    try {
      await patchWithCredentials(`/api/bookings/${bookingId}/payments`, { participantId, action: 'confirm' });
      showToast('Payment confirmed', 'success');
      await fetchContext();
    } catch (err: unknown) {
      console.error('Failed to confirm payment:', err);
      setContext(previousContext);
      showToast('Failed to confirm payment', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleWaivePayment = async (participantId: number | 'all') => {
    if (!waiverReason.trim()) {
      return;
    }
    setActionInProgress(`waive-${participantId}`);
    try {
      await patchWithCredentials(`/api/bookings/${bookingId}/payments`, { 
        participantId: participantId === 'all' ? undefined : participantId,
        action: participantId === 'all' ? 'waive_all' : 'waive',
        reason: waiverReason.trim()
      });
      showToast(participantId === 'all' ? 'All fees waived' : 'Fee waived', 'success');
      setWaiverReason('');
      setShowWaiverInput(null);
      await fetchContext();
    } catch (err: unknown) {
      console.error('Failed to waive payment:', err);
      showToast('Failed to waive fee', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUseGuestPass = async (participantId: number) => {
    setActionInProgress(`guest-pass-${participantId}`);
    try {
      const data = await patchWithCredentials<{ passesRemaining?: number }>(`/api/bookings/${bookingId}/payments`, { participantId, action: 'use_guest_pass' });
      showToast(`Guest pass used${data.passesRemaining !== undefined ? ` (${data.passesRemaining} remaining)` : ''}`, 'success');
      await fetchContext();
    } catch (err: unknown) {
      console.error('Failed to use guest pass:', err);
      showToast(err instanceof Error ? err.message : 'Failed to use guest pass', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleConfirmAll = async () => {
    if (!context) return;
    
    const previousContext = context;
    
    setContext({
      ...context,
      participants: context.participants.map(p =>
        p.paymentStatus === PAYMENT_STATUS.PENDING && p.totalFee > 0 ? { ...p, paymentStatus: PAYMENT_STATUS.PAID } : p
      ),
      totalOutstanding: 0,
      hasUnpaidBalance: false
    });
    
    setActionInProgress('confirm-all');
    try {
      await patchWithCredentials(`/api/bookings/${bookingId}/payments`, { action: 'confirm_all' });
      showToast('All payments confirmed', 'success');
      await fetchContext();
    } catch (err: unknown) {
      console.error('Failed to confirm all payments:', err);
      setContext(previousContext);
      showToast('Failed to confirm payments', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleApplyBalance = async () => {
    if (!context) return;
    setActionInProgress('apply-balance');
    try {
      const data = await patchWithCredentials<{
        success?: boolean;
        paidInFull?: boolean;
        balanceApplied?: number;
        remainingCents?: number;
        remainingDollars?: number;
        message?: string;
        error?: string;
      }>(`/api/bookings/${bookingId}/payments`, { action: 'apply_balance' });

      if (data.success) {
        if (data.paidInFull) {
          showToast(data.message || 'Account balance applied — all fees covered', 'success');
          await fetchContext();
          onCheckinComplete();
          onClose();
        } else {
          showToast(data.message || `Account balance partially applied — $${(data.remainingDollars || 0).toFixed(2)} remaining`, 'warning');
          await fetchContext();
        }
      } else {
        showToast(data.error || 'Failed to apply account balance', 'error');
      }
    } catch (err: unknown) {
      console.error('Failed to apply account balance:', err);
      showToast(err instanceof Error ? err.message : 'Failed to apply account balance', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const _handleCheckinWithPayment = async () => {
    setActionInProgress('checkin');
    try {
      const result = await checkInWithToast(bookingId, { status: BOOKING_STATUS.ATTENDED });
      if (result.success) {
        onCheckinComplete();
        onClose();
      } else {
        setError(result.error || 'Failed to check in');
      }
    } finally {
      setActionInProgress(null);
    }
  };

  const handleCheckinNoPayment = async () => {
    setActionInProgress('checkin-skip');
    try {
      await putWithCredentials(`/api/bookings/${bookingId}/checkin`, { status: BOOKING_STATUS.ATTENDED });
      onCheckinComplete();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to check in');
    } finally {
      setActionInProgress(null);
    }
  };


  const handleStripePaymentSuccess = async (paymentIntentId?: string) => {
    showToast('Payment successful - syncing...', 'success');
    setShowStripePayment(false);
    setFrozenPaymentData(null);
    setPaymentMethod('online');
    setActionInProgress('checkin-after-payment');
    try {
      if (paymentIntentId) {
        await postWithCredentials('/api/stripe/confirm-payment', { paymentIntentId }).catch(() => {});
      }
      const result = await checkInWithToast(bookingId, { status: BOOKING_STATUS.ATTENDED });
      if (result.success) {
        onCheckinComplete();
        onClose();
      } else {
        if (result.requiresRoster) {
          showToast('Payment recorded! Please fill in guest details before check-in.', 'warning');
          await fetchContext();
        } else {
          showToast(result.error || 'Payment succeeded but check-in failed - please retry', 'error');
        }
      }
    } catch (_err: unknown) {
      showToast('Payment succeeded but check-in failed - please retry', 'error');
    } finally {
      setActionInProgress(null);
    }
  };
  
  const handleShowStripePayment = () => {
    if (!context) return;
    const pendingParticipants = context.participants.filter(p => p.paymentStatus === PAYMENT_STATUS.PENDING && p.totalFee > 0);
    const fees = pendingParticipants.map(p => ({ id: p.participantId, amount: p.totalFee }));
    const totalAmount = fees.reduce((sum, f) => sum + f.amount, 0);
    
    let formattedDate = 'Booking';
    if (context.bookingDate) {
      const datePart = context.bookingDate.includes('T') ? context.bookingDate.split('T')[0] : context.bookingDate;
      const dateObj = new Date(datePart + 'T12:00:00');
      if (!isNaN(dateObj.getTime())) {
        formattedDate = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
      }
    }
    
    const formatTime = (time: string) => {
      const [h, m] = time.split(':').map(Number);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hour = h % 12 || 12;
      return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
    };
    const timeRange = `${formatTime(context.startTime)} - ${formatTime(context.endTime)}`;
    
    const totalOverage = pendingParticipants.reduce((sum, p) => sum + (p.overageFee || 0), 0);
    const totalGuestFees = pendingParticipants.reduce((sum, p) => sum + (p.guestFee || 0), 0);
    const breakdownParts: string[] = [];
    if (totalOverage > 0) breakdownParts.push(`Overage: $${totalOverage.toFixed(2)}`);
    if (totalGuestFees > 0) breakdownParts.push(`Guest fees: $${totalGuestFees.toFixed(2)}`);
    const breakdown = breakdownParts.length > 0 ? ` (${breakdownParts.join(', ')})` : '';
    
    const description = `${context.resourceName} • ${formattedDate} • ${timeRange}${breakdown}`;
    
    setFrozenPaymentData({ participantFees: fees, totalAmount, description });
    setShowStripePayment(true);
  };

  const unpaidParticipants = context?.participants.filter(p => 
    p.paymentStatus === PAYMENT_STATUS.PENDING && p.totalFee > 0
  ) || [];
  const hasPendingPayments = unpaidParticipants.length > 0;
  
  const handleClose = () => {
    onClose();
  };

  const drawerTitle = context 
    ? `${context.resourceName} • ${formatBookingDate(context.bookingDate)}`
    : 'Check-In & Billing';

  const footerContent = (
    <div className="px-6 py-4">
      {showStripePayment ? (
        <button
          onClick={() => { setShowStripePayment(false); setFrozenPaymentData(null); setPaymentMethod('online'); }}
          className="w-full py-2 text-primary/70 dark:text-white/70 font-medium hover:text-primary dark:hover:text-white"
        >
          Cancel
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          {hasPendingPayments ? (
            <>
              {context?.memberAccountBalance && context.memberAccountBalance.availableCreditCents > 0 && context?.totalOutstanding && context.totalOutstanding > 0 && (
                <button
                  onClick={handleApplyBalance}
                  disabled={actionInProgress !== null}
                  className="tactile-btn w-full py-3 bg-emerald-600 text-white font-semibold rounded-xl hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined">account_balance_wallet</span>
                  {actionInProgress === 'apply-balance'
                    ? 'Applying...'
                    : `Apply Account Balance ($${context.memberAccountBalance.availableCreditDollars.toFixed(2)})${context.memberAccountBalance.availableCreditCents >= Math.round(context.totalOutstanding * 100) ? '' : ' — Partial'}`}
                </button>
              )}
              {context?.totalOutstanding && context.totalOutstanding > 0 && savedCardInfo?.hasSavedCard && (
                <button
                  onClick={handleChargeSavedCard}
                  disabled={actionInProgress !== null}
                  className="tactile-btn w-full py-3 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined">credit_score</span>
                  {actionInProgress === 'charge-saved-card' 
                    ? 'Charging...' 
                    : `Charge Card on File (${savedCardInfo.cardBrand} ****${savedCardInfo.cardLast4}) - $${context.totalOutstanding.toFixed(2)}`}
                </button>
              )}
              {context?.totalOutstanding && context.totalOutstanding > 0 && (
                <button
                  onClick={handleShowStripePayment}
                  disabled={actionInProgress !== null}
                  className="tactile-btn w-full py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined">credit_card</span>
                  {savedCardInfo?.hasSavedCard ? 'Pay with Different Card' : `Pay with Card ($${context.totalOutstanding.toFixed(2)})`}
                </button>
              )}
              <button
                onClick={handleConfirmAll}
                disabled={actionInProgress !== null}
                className="tactile-btn w-full py-3 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined">payments</span>
                {actionInProgress === 'confirm-all' ? 'Processing...' : 'Mark Paid (Cash/External)'}
              </button>
              <button
                onClick={() => setShowWaiverInput('all')}
                disabled={actionInProgress !== null}
                className="tactile-btn w-full py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-medium rounded-xl hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
              >
                Waive All Fees
              </button>
              {showWaiverInput === 'all' && (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={waiverReason}
                    onChange={(e) => setWaiverReason(e.target.value)}
                    placeholder="Reason for waiving all fees..."
                    className="w-full px-3 py-2 text-sm border border-primary/20 dark:border-white/20 rounded-lg bg-white dark:bg-black/20 text-primary dark:text-white"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleWaivePayment('all')}
                      disabled={!waiverReason.trim() || actionInProgress !== null}
                      className="tactile-btn flex-1 py-2 text-sm font-medium bg-gray-600 text-white rounded-lg disabled:opacity-50"
                    >
                      Confirm Waive All
                    </button>
                    <button
                      onClick={() => { setShowWaiverInput(null); setWaiverReason(''); }}
                      className="tactile-btn px-4 py-2 text-sm font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : context?.hasUnpaidBalance ? (
            <div className="w-full p-3 bg-red-50 dark:bg-red-900/20 rounded-xl text-center flex items-center justify-center gap-2">
              <span className="material-symbols-outlined text-red-500">warning</span>
              <span className="text-red-600 dark:text-red-400 font-medium">
                Collect all payments before check-in
              </span>
            </div>
          ) : (
            <button
              onClick={handleCheckinNoPayment}
              disabled={actionInProgress !== null}
              className="tactile-btn w-full py-3 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined">how_to_reg</span>
              {actionInProgress === 'checkin-skip' ? 'Processing...' : 'Complete Check-In'}
            </button>
          )}
          <button
            onClick={handleClose}
            className="w-full py-2 text-primary/70 dark:text-white/70 font-medium hover:text-primary dark:hover:text-white"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={handleClose}
      title={drawerTitle}
      maxHeight="full"
      stickyFooter={footerContent}
    >
      <div className="p-6">
        {showStripePayment && context && frozenPaymentData ? (
          <div className="space-y-4">
            <div className="bg-primary/5 dark:bg-white/5 rounded-xl p-4">
              <h3 className="font-semibold text-primary dark:text-white mb-2">{context.ownerName}</h3>
              <p className="text-sm text-primary/70 dark:text-white/70">
                {context.resourceName} • {formatBookingDate(context.bookingDate)} • {formatTime12Hour(context.startTime)} - {formatTime12Hour(context.endTime)}
              </p>
            </div>
            <div className="flex rounded-lg border border-primary/20 dark:border-white/20 overflow-hidden">
              <button
                onClick={() => setPaymentMethod('online')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${
                  paymentMethod === 'online'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white dark:bg-white/5 text-primary/70 dark:text-white/70 hover:bg-primary/5 dark:hover:bg-white/10'
                }`}
              >
                <span className="material-symbols-outlined text-base">credit_card</span>
                Online Card
              </button>
              <button
                onClick={() => setPaymentMethod('terminal')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${
                  paymentMethod === 'terminal'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white dark:bg-white/5 text-primary/70 dark:text-white/70 hover:bg-primary/5 dark:hover:bg-white/10'
                }`}
              >
                <span className="material-symbols-outlined text-base">contactless</span>
                Card Reader
              </button>
            </div>
            {paymentMethod === 'terminal' ? (
              <TerminalPayment
                amount={Math.round(frozenPaymentData.totalAmount * 100)}
                subscriptionId={null}
                userId={context.ownerId}
                description={frozenPaymentData.description}
                paymentMetadata={{ bookingId: String(bookingId), ownerEmail: context.ownerEmail, userId: context.ownerId, ownerName: context.ownerName, paymentType: 'booking_fee' }}
                onSuccess={(piId) => handleStripePaymentSuccess(piId)}
                onError={(msg) => showToast(msg, 'error')}
                onCancel={() => { setShowStripePayment(false); setFrozenPaymentData(null); setPaymentMethod('online'); }}
              />
            ) : (
              <StripePaymentForm
                amount={frozenPaymentData.totalAmount}
                description={frozenPaymentData.description}
                userId={context.ownerId}
                userEmail={context.ownerEmail}
                memberName={context.ownerName}
                purpose="guest_fee"
                bookingId={bookingId}
                sessionId={context.sessionId || undefined}
                participantFees={frozenPaymentData.participantFees}
                onSuccess={handleStripePaymentSuccess}
                onCancel={() => { setShowStripePayment(false); setFrozenPaymentData(null); setPaymentMethod('online'); }}
              />
            )}
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-8">
            <WalkingGolferSpinner size="sm" variant="auto" />
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <span className="material-symbols-outlined text-4xl text-red-500 mb-2">error</span>
            <p className="text-red-600 dark:text-red-400">{error}</p>
            <button onClick={fetchContext} className="mt-4 px-4 py-2 bg-primary text-white rounded-lg">
              Retry
            </button>
          </div>
        ) : context ? (
          <div className="space-y-6">
            <div className="bg-primary/5 dark:bg-white/5 rounded-xl p-4">
              <h3 className="font-semibold text-primary dark:text-white mb-2">{context.ownerName}</h3>
              <p className="text-sm text-primary/70 dark:text-white/70">
                {context.resourceName} • {formatBookingDate(context.bookingDate)} • {formatTime12Hour(context.startTime)} - {formatTime12Hour(context.endTime)}
              </p>
              {context.memberNotes && (
                <div className="mt-3 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-lg">
                  <p className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
                    <span className="material-symbols-outlined text-sm flex-shrink-0">edit_note</span>
                    <span>"{context.memberNotes}"</span>
                  </p>
                </div>
              )}
            </div>

            {context.participants.length > 0 && (
              <div>
                <h4 className="font-semibold text-primary dark:text-white mb-3 flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg">group</span>
                  Player Fees
                </h4>
                <div className="space-y-2">
                  {context.participants.map(p => (
                    <div key={p.participantId} className="tactile-row bg-white dark:bg-white/5 border border-primary/10 dark:border-white/10 rounded-xl p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                            p.participantType === PARTICIPANT_TYPE.OWNER ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' :
                            p.participantType === PARTICIPANT_TYPE.GUEST ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' :
                            'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                          }`}>
                            {p.participantType === PARTICIPANT_TYPE.OWNER ? 'Host' : p.participantType === PARTICIPANT_TYPE.GUEST ? 'Guest' : 'Member'}
                          </span>
                          <span className="font-medium text-primary dark:text-white">{p.displayName}</span>
                        </div>
                        <span className={`text-sm font-bold ${
                          p.paymentStatus === PAYMENT_STATUS.PAID ? 'text-green-600 dark:text-green-400' :
                          p.paymentStatus === PAYMENT_STATUS.WAIVED ? 'text-gray-500' :
                          'text-primary dark:text-white'
                        }`}>
                          {p.totalFee > 0 ? `$${p.totalFee.toFixed(2)}` : 'No charge'}
                        </span>
                      </div>
                      
                      <div className="text-xs text-primary/60 dark:text-white/60 mb-2 space-y-0.5">
                        {p.tierAtBooking && (
                          <div className="flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs">workspace_premium</span>
                            <span>{p.tierAtBooking}</span>
                            {p.dailyAllowance !== undefined && p.dailyAllowance < 999 && (
                              <span className="opacity-60">({p.dailyAllowance} min/day)</span>
                            )}
                            {p.dailyAllowance !== undefined && p.dailyAllowance >= 999 && (
                              <span className="opacity-60">(Unlimited)</span>
                            )}
                          </div>
                        )}
                        {(p.overageFee > 0 || p.guestFee > 0 || (p.guestPassUsed && p.totalFee === 0)) && (
                          <div className="flex flex-wrap gap-2">
                            {p.overageFee > 0 && (
                              <span className="inline-flex items-center px-1.5 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 rounded">
                                Time Overage: ${p.overageFee.toFixed(2)}
                              </span>
                            )}
                            {p.guestFee > 0 && (
                              <span className="inline-flex items-center px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">
                                Guest Fee: ${p.guestFee.toFixed(2)}
                              </span>
                            )}
                            {p.guestPassUsed && p.totalFee === 0 && (
                              <span className="inline-flex items-center px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded">
                                <span className="material-symbols-outlined text-xs mr-0.5">confirmation_number</span>
                                Pass Used
                              </span>
                            )}
                          </div>
                        )}
                        {p.totalFee === 0 && p.participantType !== PARTICIPANT_TYPE.GUEST && !p.guestPassUsed && (
                          p.cachedFeeCents === null && p.paymentStatus === PAYMENT_STATUS.PENDING ? (
                            <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                              <span className="inline-block w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></span>
                              Calculating fees...
                            </span>
                          ) : (p.dailyAllowance !== undefined && p.dailyAllowance < 999 && p.minutesUsed !== undefined && p.minutesUsed > p.dailyAllowance) ? (
                            <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                              <span className="inline-block w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></span>
                              Calculating fees...
                            </span>
                          ) : (
                            <span className="text-green-600 dark:text-green-400">Within daily allowance</span>
                          )
                        )}
                      </div>

                      {p.paymentStatus === PAYMENT_STATUS.PENDING && p.totalFee > 0 ? (
                        showWaiverInput === p.participantId ? (
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={waiverReason}
                              onChange={(e) => setWaiverReason(e.target.value)}
                              placeholder="Reason for waiving..."
                              className="w-full px-3 py-2 text-sm border border-primary/20 dark:border-white/20 rounded-lg bg-white dark:bg-black/20 text-primary dark:text-white"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleWaivePayment(p.participantId)}
                                disabled={!waiverReason.trim() || actionInProgress !== null}
                                className="flex-1 py-1.5 text-xs font-medium bg-gray-600 text-white rounded-lg disabled:opacity-50"
                              >
                                Confirm Waiver
                              </button>
                              <button
                                onClick={() => { setShowWaiverInput(null); setWaiverReason(''); }}
                                className="px-3 py-1.5 text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className={`flex gap-2 ${p.participantType === PARTICIPANT_TYPE.GUEST ? 'flex-wrap' : ''}`}>
                            <button
                              onClick={() => handleConfirmPayment(p.participantId)}
                              disabled={actionInProgress !== null}
                              className="tactile-btn flex-1 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                            >
                              {actionInProgress === `confirm-${p.participantId}` ? 'Processing...' : 'Mark Paid'}
                            </button>
                            {p.participantType === PARTICIPANT_TYPE.GUEST && (
                              <button
                                onClick={() => handleUseGuestPass(p.participantId)}
                                disabled={actionInProgress !== null}
                                className="tactile-btn py-1.5 text-xs font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 flex items-center gap-1 px-3"
                              >
                                <span className="material-symbols-outlined text-sm">loyalty</span>
                                Guest Pass
                              </button>
                            )}
                            <button
                              onClick={() => setShowWaiverInput(p.participantId)}
                              disabled={actionInProgress !== null}
                              className="tactile-btn px-3 py-1.5 text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600"
                            >
                              Waive
                            </button>
                          </div>
                        )
                      ) : (
                        <div className="flex items-center gap-2 text-xs flex-wrap">
                          <div className="flex items-center gap-1">
                            <span className={`material-symbols-outlined text-sm ${
                              p.paymentStatus === PAYMENT_STATUS.PAID ? 'text-green-500' : 
                              p.paymentStatus === PAYMENT_STATUS.WAIVED ? 'text-gray-500' : 'text-yellow-500'
                            }`}>
                              {p.paymentStatus === PAYMENT_STATUS.PAID ? 'check_circle' : 
                               p.paymentStatus === PAYMENT_STATUS.WAIVED ? 'remove_circle' : 'pending'}
                            </span>
                            <span className={`capitalize ${
                              p.paymentStatus === PAYMENT_STATUS.PAID ? 'text-green-600 dark:text-green-400' : 
                              p.paymentStatus === PAYMENT_STATUS.WAIVED ? 'text-gray-500' : ''
                            }`}>
                              {p.paymentStatus}
                            </span>
                          </div>
                          {p.paymentStatus === PAYMENT_STATUS.PAID && p.prepaidOnline && (
                            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 text-xs font-medium bg-lavender/20 dark:bg-lavender/20 text-primary dark:text-lavender rounded-full">
                              <span className="material-symbols-outlined text-xs">credit_card</span>
                              Prepaid online
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {context.totalOutstanding > 0 && (
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-amber-800 dark:text-amber-300">Total Outstanding</span>
                  <span className="text-xl font-bold text-amber-800 dark:text-amber-300">
                    ${context.totalOutstanding.toFixed(2)}
                  </span>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </SlideUpDrawer>
  );
};

export default CheckinBillingModal;
