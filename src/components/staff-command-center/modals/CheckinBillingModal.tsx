import React, { useState, useEffect } from 'react';
import { useToast } from '../../Toast';
import { StripePaymentForm } from '../../stripe/StripePaymentForm';
import SlideUpDrawer from '../../SlideUpDrawer';
import { getApiErrorMessage, getNetworkErrorMessage } from '../../../utils/errorHandling';

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
    day: 'numeric' 
  });
}

interface ParticipantFee {
  participantId: number;
  displayName: string;
  participantType: 'owner' | 'member' | 'guest';
  paymentStatus: 'pending' | 'paid' | 'waived';
  overageFee: number;
  guestFee: number;
  totalFee: number;
  tierAtBooking: string | null;
  dailyAllowance?: number;
  minutesUsed?: number;
  guestPassUsed?: boolean;
  waiverNeedsReview?: boolean;
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
  overageMinutes?: number;
  overageFeeCents?: number;
  overagePaid?: boolean;
  hasUnpaidOverage?: boolean;
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
  const [showOveragePayment, setShowOveragePayment] = useState(false);
  const [overageClientSecret, setOverageClientSecret] = useState<string | null>(null);
  const [savedCardInfo, setSavedCardInfo] = useState<{
    hasSavedCard: boolean;
    cardLast4?: string;
    cardBrand?: string;
  } | null>(null);
  const [checkingCard, setCheckingCard] = useState(false);

  useEffect(() => {
    console.log('[CheckinBillingModal] Props changed:', { isOpen, bookingId });
    if (isOpen && bookingId) {
      console.log('[CheckinBillingModal] Opening and fetching context');
      fetchContext();
    }
  }, [isOpen, bookingId]);

  const fetchContext = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/staff-checkin-context`, {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        setContext(data);
      } else {
        setError(getApiErrorMessage(res, 'load billing context'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setLoading(false);
    }
  };

  const checkSavedCard = async (email: string) => {
    try {
      setCheckingCard(true);
      const res = await fetch(`/api/stripe/staff/check-saved-card/${encodeURIComponent(email)}`, {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        setSavedCardInfo(data);
      }
    } catch (err) {
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
      p.paymentStatus === 'pending' && p.totalFee > 0
    );
    const participantIds = pendingParticipants.map(p => p.participantId);

    setActionInProgress('charge-saved-card');
    try {
      // Backend computes authoritative amount from cached fees - we only send participant IDs
      const res = await fetch('/api/stripe/staff/charge-saved-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail: context.ownerEmail,
          bookingId,
          sessionId: context.sessionId,
          participantIds
        })
      });
      
      const data = await res.json();
      
      if (res.ok && data.success) {
        showToast(data.message || 'Card charged successfully', 'success');
        await fetchContext();
        onCheckinComplete();
        onClose();
      } else {
        if (data.noSavedCard || data.noStripeCustomer) {
          showToast('No saved card on file - use the card payment option', 'warning');
          setSavedCardInfo({ hasSavedCard: false });
        } else if (data.requiresAction) {
          showToast('Card requires additional verification - use the card payment option', 'warning');
        } else if (data.cardError) {
          showToast(`Card declined: ${data.error}`, 'error');
        } else {
          showToast(data.error || 'Failed to charge card', 'error');
        }
      }
    } catch (err) {
      console.error('Failed to charge saved card:', err);
      showToast('Failed to charge card - please try again', 'error');
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
        p.participantId === participantId ? { ...p, paymentStatus: 'paid' } : p
      ),
      totalOutstanding: context.totalOutstanding - (context.participants.find(p => p.participantId === participantId)?.totalFee || 0),
      hasUnpaidBalance: context.participants.filter(p => p.participantId !== participantId && p.paymentStatus === 'pending' && p.totalFee > 0).length > 0
    });
    
    setActionInProgress(`confirm-${participantId}`);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ participantId, action: 'confirm' })
      });
      if (res.ok) {
        showToast('Payment confirmed', 'success');
        await fetchContext();
      } else {
        setContext(previousContext);
        showToast('Failed to confirm payment', 'error');
      }
    } catch (err) {
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
      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          participantId: participantId === 'all' ? undefined : participantId,
          action: participantId === 'all' ? 'waive_all' : 'waive',
          reason: waiverReason.trim()
        })
      });
      if (res.ok) {
        showToast(participantId === 'all' ? 'All fees waived' : 'Fee waived', 'success');
        setWaiverReason('');
        setShowWaiverInput(null);
        await fetchContext();
      } else {
        showToast('Failed to waive fee', 'error');
      }
    } catch (err) {
      console.error('Failed to waive payment:', err);
      showToast('Failed to waive fee', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUseGuestPass = async (participantId: number) => {
    setActionInProgress(`guest-pass-${participantId}`);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ participantId, action: 'use_guest_pass' })
      });
      if (res.ok) {
        const data = await res.json();
        showToast(`Guest pass used${data.passesRemaining !== undefined ? ` (${data.passesRemaining} remaining)` : ''}`, 'success');
        await fetchContext();
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to use guest pass', 'error');
      }
    } catch (err) {
      console.error('Failed to use guest pass:', err);
      showToast('Failed to use guest pass', 'error');
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
        p.paymentStatus === 'pending' && p.totalFee > 0 ? { ...p, paymentStatus: 'paid' } : p
      ),
      totalOutstanding: 0,
      hasUnpaidBalance: false
    });
    
    setActionInProgress('confirm-all');
    try {
      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'confirm_all' })
      });
      if (res.ok) {
        showToast('All payments confirmed', 'success');
        await fetchContext();
      } else {
        setContext(previousContext);
        showToast('Failed to confirm payments', 'error');
      }
    } catch (err) {
      console.error('Failed to confirm all payments:', err);
      setContext(previousContext);
      showToast('Failed to confirm payments', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleCheckinWithPayment = async () => {
    setActionInProgress('checkin');
    try {
      const res = await fetch(`/api/bookings/${bookingId}/checkin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'attended', confirmPayment: true })
      });
      if (res.ok) {
        onCheckinComplete();
        onClose();
      } else {
        setError(getApiErrorMessage(res, 'check in'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setActionInProgress(null);
    }
  };

  const handleCheckinNoPayment = async () => {
    setActionInProgress('checkin-skip');
    try {
      const res = await fetch(`/api/bookings/${bookingId}/checkin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'attended' })
      });
      if (res.ok) {
        onCheckinComplete();
        onClose();
      } else {
        setError(getApiErrorMessage(res, 'check in'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setActionInProgress(null);
    }
  };

  const handleMarkWaiversReviewed = async () => {
    setActionInProgress('mark-reviewed');
    try {
      const res = await fetch(`/api/bookings/${bookingId}/mark-all-waivers-reviewed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        showToast(`${data.updatedCount} waiver(s) marked as reviewed`, 'success');
        await fetchContext();
        onCheckinComplete();
        onClose();
      } else {
        showToast('Failed to mark waivers as reviewed', 'error');
      }
    } catch (err) {
      console.error('Failed to mark waivers as reviewed:', err);
      showToast('Failed to mark waivers as reviewed', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleChargeOverage = async () => {
    if (!context) return;
    setActionInProgress('overage-payment');
    try {
      const res = await fetch('/api/stripe/overage/create-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ bookingId })
      });
      if (res.ok) {
        const data = await res.json();
        setOverageClientSecret(data.clientSecret);
        setShowOveragePayment(true);
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to create payment', 'error');
      }
    } catch (err) {
      console.error('Failed to create overage payment:', err);
      showToast('Failed to create payment', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleOveragePaymentSuccess = async (paymentIntentId?: string) => {
    showToast('Overage payment successful!', 'success');
    setShowOveragePayment(false);
    setOverageClientSecret(null);
    if (paymentIntentId) {
      await fetch('/api/stripe/confirm-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentIntentId })
      });
    }
    await fetchContext();
  };

  const handleStripePaymentSuccess = async (paymentIntentId?: string) => {
    showToast('Payment successful - syncing...', 'success');
    setShowStripePayment(false);
    setFrozenPaymentData(null);
    setActionInProgress('checkin-after-payment');
    try {
      if (paymentIntentId) {
        await fetch('/api/stripe/confirm-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ paymentIntentId })
        });
      }
      const res = await fetch(`/api/bookings/${bookingId}/checkin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'attended', confirmPayment: true })
      });
      if (res.ok) {
        onCheckinComplete();
        onClose();
      } else {
        const data = await res.json();
        if (data.requiresRoster) {
          showToast('Payment recorded! Please fill in guest details before check-in.', 'warning');
          await fetchContext();
        } else {
          showToast(data.error || 'Payment succeeded but check-in failed - please retry', 'error');
        }
      }
    } catch (err) {
      showToast('Payment succeeded but check-in failed - please retry', 'error');
    } finally {
      setActionInProgress(null);
    }
  };
  
  const handleShowStripePayment = () => {
    if (!context) return;
    const pendingParticipants = context.participants.filter(p => p.paymentStatus === 'pending' && p.totalFee > 0);
    const fees = pendingParticipants.map(p => ({ id: p.participantId, amount: p.totalFee }));
    const totalAmount = fees.reduce((sum, f) => sum + f.amount, 0);
    
    let formattedDate = 'Booking';
    if (context.bookingDate) {
      const datePart = context.bookingDate.includes('T') ? context.bookingDate.split('T')[0] : context.bookingDate;
      const dateObj = new Date(datePart + 'T12:00:00');
      if (!isNaN(dateObj.getTime())) {
        formattedDate = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
    p.paymentStatus === 'pending' && p.totalFee > 0
  ) || [];
  const hasPendingPayments = unpaidParticipants.length > 0;
  
  const hasUnreviewedWaivers = context?.participants.some(p => p.waiverNeedsReview) || false;

  const drawerTitle = context 
    ? `${context.resourceName} • ${formatBookingDate(context.bookingDate)}`
    : 'Check-In & Billing';

  const footerContent = (
    <div className="px-6 py-4">
      {showOveragePayment ? (
        <button
          onClick={() => { setShowOveragePayment(false); setOverageClientSecret(null); }}
          className="w-full py-2 text-primary/70 dark:text-white/70 font-medium hover:text-primary dark:hover:text-white"
        >
          Back
        </button>
      ) : showStripePayment ? (
        <button
          onClick={onClose}
          className="w-full py-2 text-primary/70 dark:text-white/70 font-medium hover:text-primary dark:hover:text-white"
        >
          Cancel
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          {hasPendingPayments ? (
            <>
              {context?.totalOutstanding && context.totalOutstanding > 0 && savedCardInfo?.hasSavedCard && (
                <button
                  onClick={handleChargeSavedCard}
                  disabled={actionInProgress !== null}
                  className="w-full py-3 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
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
                  className="w-full py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined">credit_card</span>
                  {savedCardInfo?.hasSavedCard ? 'Pay with Different Card' : `Pay with Card ($${context.totalOutstanding.toFixed(2)})`}
                </button>
              )}
              <button
                onClick={handleConfirmAll}
                disabled={actionInProgress !== null}
                className="w-full py-3 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined">payments</span>
                {actionInProgress === 'confirm-all' ? 'Processing...' : 'Mark Paid (Cash/External)'}
              </button>
              <button
                onClick={() => setShowWaiverInput('all')}
                disabled={actionInProgress !== null}
                className="w-full py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-medium rounded-xl hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
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
                      className="flex-1 py-2 text-sm font-medium bg-gray-600 text-white rounded-lg disabled:opacity-50"
                    >
                      Confirm Waive All
                    </button>
                    <button
                      onClick={() => { setShowWaiverInput(null); setWaiverReason(''); }}
                      className="px-4 py-2 text-sm font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : hasUnreviewedWaivers ? (
            <button
              onClick={handleMarkWaiversReviewed}
              disabled={actionInProgress !== null}
              className="w-full py-3 bg-amber-600 text-white font-semibold rounded-xl hover:bg-amber-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined">check_circle</span>
              {actionInProgress === 'mark-reviewed' ? 'Processing...' : 'Mark Waivers as Reviewed'}
            </button>
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
              className="w-full py-3 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined">how_to_reg</span>
              {actionInProgress === 'checkin-skip' ? 'Processing...' : 'Complete Check-In'}
            </button>
          )}
          <button
            onClick={onClose}
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
      onClose={onClose}
      title={drawerTitle}
      maxHeight="full"
      stickyFooter={footerContent}
    >
      <div className="p-6">
        {showOveragePayment && context && overageClientSecret ? (
          <div className="space-y-4">
            <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4">
              <h3 className="font-semibold text-red-800 dark:text-red-300 mb-2">Simulator Overage Payment</h3>
              <p className="text-sm text-red-700 dark:text-red-400">
                {context.overageMinutes} minutes over tier limit • ${((context.overageFeeCents || 0) / 100).toFixed(2)}
              </p>
            </div>
            <StripePaymentForm
              amount={(context.overageFeeCents || 0) / 100}
              description={`Simulator overage fee - ${context.resourceName}`}
              userId={context.ownerId}
              userEmail={context.ownerEmail}
              memberName={context.ownerName}
              purpose="overage_fee"
              bookingId={bookingId}
              onSuccess={handleOveragePaymentSuccess}
              onCancel={() => { setShowOveragePayment(false); setOverageClientSecret(null); }}
            />
          </div>
        ) : showStripePayment && context && frozenPaymentData ? (
          <div className="space-y-4">
            <div className="bg-primary/5 dark:bg-white/5 rounded-xl p-4">
              <h3 className="font-semibold text-primary dark:text-white mb-2">{context.ownerName}</h3>
              <p className="text-sm text-primary/70 dark:text-white/70">
                {context.resourceName} • {formatBookingDate(context.bookingDate)} • {formatTime12Hour(context.startTime)} - {formatTime12Hour(context.endTime)}
              </p>
            </div>
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
              onCancel={() => { setShowStripePayment(false); setFrozenPaymentData(null); }}
            />
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
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

            {context.hasUnpaidOverage && context.overageFeeCents && context.overageFeeCents > 0 && (
              <div className="bg-red-50 dark:bg-red-900/20 border-2 border-red-300 dark:border-red-700 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-red-600 dark:text-red-400 text-xl">warning</span>
                  <div className="flex-1">
                    <h4 className="font-semibold text-red-800 dark:text-red-300 mb-1">Simulator Overage Fee Required</h4>
                    <p className="text-sm text-red-700 dark:text-red-400 mb-3">
                      This booking exceeds the member's daily simulator allowance by {context.overageMinutes} minutes.
                      Payment of ${(context.overageFeeCents / 100).toFixed(2)} is required before check-in.
                    </p>
                    <button
                      onClick={handleChargeOverage}
                      disabled={actionInProgress !== null}
                      className="px-4 py-2 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
                    >
                      <span className="material-symbols-outlined text-sm">credit_card</span>
                      {actionInProgress === 'overage-payment' ? 'Processing...' : `Charge $${(context.overageFeeCents / 100).toFixed(2)}`}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {context.participants.length > 0 && (
              <div>
                <h4 className="font-semibold text-primary dark:text-white mb-3 flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg">group</span>
                  Player Fees
                </h4>
                <div className="space-y-2">
                  {context.participants.map(p => (
                    <div key={p.participantId} className="bg-white dark:bg-white/5 border border-primary/10 dark:border-white/10 rounded-xl p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                            p.participantType === 'owner' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' :
                            p.participantType === 'guest' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' :
                            'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                          }`}>
                            {p.participantType === 'owner' ? 'Host' : p.participantType === 'guest' ? 'Guest' : 'Member'}
                          </span>
                          <span className="font-medium text-primary dark:text-white">{p.displayName}</span>
                        </div>
                        <span className={`text-sm font-bold ${
                          p.paymentStatus === 'paid' ? 'text-green-600 dark:text-green-400' :
                          p.paymentStatus === 'waived' ? 'text-gray-500' :
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
                        {(p.overageFee > 0 || p.guestFee > 0) && (
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
                            {p.guestPassUsed && (
                              <span className="inline-flex items-center px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded">
                                <span className="material-symbols-outlined text-xs mr-0.5">confirmation_number</span>
                                Pass Used
                              </span>
                            )}
                          </div>
                        )}
                        {p.totalFee === 0 && p.participantType !== 'guest' && !p.guestPassUsed && (
                          p.cachedFeeCents === null && p.paymentStatus === 'pending' ? (
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

                      {p.paymentStatus === 'pending' && p.totalFee > 0 ? (
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
                          <div className={`flex gap-2 ${p.participantType === 'guest' ? 'flex-wrap' : ''}`}>
                            <button
                              onClick={() => handleConfirmPayment(p.participantId)}
                              disabled={actionInProgress !== null}
                              className="flex-1 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                            >
                              {actionInProgress === `confirm-${p.participantId}` ? 'Processing...' : 'Mark Paid'}
                            </button>
                            {p.participantType === 'guest' && (
                              <button
                                onClick={() => handleUseGuestPass(p.participantId)}
                                disabled={actionInProgress !== null}
                                className="py-1.5 text-xs font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 flex items-center gap-1 px-3"
                              >
                                <span className="material-symbols-outlined text-sm">loyalty</span>
                                Guest Pass
                              </button>
                            )}
                            <button
                              onClick={() => setShowWaiverInput(p.participantId)}
                              disabled={actionInProgress !== null}
                              className="px-3 py-1.5 text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600"
                            >
                              Waive
                            </button>
                          </div>
                        )
                      ) : (
                        <div className="flex items-center gap-2 text-xs flex-wrap">
                          <div className="flex items-center gap-1">
                            <span className={`material-symbols-outlined text-sm ${
                              p.paymentStatus === 'paid' ? 'text-green-500' : 
                              p.paymentStatus === 'waived' ? 'text-gray-500' : 'text-yellow-500'
                            }`}>
                              {p.paymentStatus === 'paid' ? 'check_circle' : 
                               p.paymentStatus === 'waived' ? 'remove_circle' : 'pending'}
                            </span>
                            <span className={`capitalize ${
                              p.paymentStatus === 'paid' ? 'text-green-600 dark:text-green-400' : 
                              p.paymentStatus === 'waived' ? 'text-gray-500' : ''
                            }`}>
                              {p.paymentStatus}
                            </span>
                          </div>
                          {p.paymentStatus === 'paid' && p.prepaidOnline && (
                            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 text-xs font-medium bg-lavender/20 dark:bg-lavender/20 text-primary dark:text-lavender rounded-full">
                              <span className="material-symbols-outlined text-xs">credit_card</span>
                              Prepaid online
                            </span>
                          )}
                          {p.waiverNeedsReview && (
                            <span className="px-1.5 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded">
                              Needs Review
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
