import React from 'react';
import { ManageModeRosterData, FetchedContext } from './bookingSheetTypes';
import { StripePaymentForm } from '../../stripe/StripePaymentForm';
import { TerminalPayment } from '../TerminalPayment';
import { useToast } from '../../Toast';
import { BookingStatusDropdown } from '../../BookingStatusDropdown';
import { postWithCredentials, patchWithCredentials } from '../../../hooks/queries/useFetch';

interface PaymentSummaryBodyProps {
  isConferenceRoom: boolean;
  rosterData: ManageModeRosterData | null;
  renderTierBadge: (tier: string | null | undefined, membershipStatus?: string | null) => React.ReactNode;
  paymentSuccess: boolean;
}

export function PaymentSummaryBody({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isConferenceRoom,
  rosterData,
  renderTierBadge,
  paymentSuccess,
}: PaymentSummaryBodyProps) {
  const fs = rosterData?.financialSummary;
  if (!fs) return null;

  const guestPassesUsed = rosterData?.members?.filter(
    m => m.guestInfo && m.guestInfo.usedGuestPass === true && m.guestInfo.fee === 0
  ).length || 0;

  return (
    <div className="p-3 rounded-xl border border-primary/10 dark:border-white/10 bg-primary/5 dark:bg-white/5 space-y-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-lg">payments</span>
        <h4 className="font-medium text-sm text-primary dark:text-white">Financial Summary</h4>
        {fs.allPaid && (
          <span className="ml-auto flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
            <span className="material-symbols-outlined text-sm">check_circle</span>
            Paid
          </span>
        )}
      </div>

      <div className="space-y-1 text-xs">
        {fs.ownerOverageFee > 0 && (
          <div className="flex justify-between text-primary/70 dark:text-white/70">
            <span>Owner overage fee</span>
            <span>${fs.ownerOverageFee.toFixed(2)}</span>
          </div>
        )}
        {fs.guestFeesWithoutPass > 0 && (
          <div className="flex justify-between text-primary/70 dark:text-white/70">
            <span>Guest fees (no pass)</span>
            <span>${fs.guestFeesWithoutPass.toFixed(2)}</span>
          </div>
        )}
        {guestPassesUsed > 0 && (
          <div className="flex justify-between text-emerald-600 dark:text-emerald-400">
            <span>Guest passes used</span>
            <span>{guestPassesUsed}</span>
          </div>
        )}
        {fs.playerBreakdown && fs.playerBreakdown.length > 0 && (
          <div className="pt-1 border-t border-primary/10 dark:border-white/10 space-y-0.5">
            {fs.playerBreakdown.map((p, idx) => (
              <div key={idx} className="flex justify-between text-primary/60 dark:text-white/60">
                <span className="flex items-center gap-1">
                  {p.name}
                  {renderTierBadge(p.tier, p.membershipStatus)}
                </span>
                <span className={p.tier === 'Staff' ? 'text-blue-600 dark:text-blue-400' : ''}>
                  {p.tier === 'Staff' ? '$0.00 — Staff — included' : p.fee > 0 ? `$${p.fee.toFixed(2)}` : p.feeNote || 'Included'}
                </span>
              </div>
            ))}
          </div>
        )}
        {fs.grandTotal > 0 && fs.grandTotal !== fs.totalOwnerOwes && (
          <div className="pt-1 border-t border-primary/10 dark:border-white/10 flex justify-between text-primary/70 dark:text-white/70">
            <span>Grand Total</span>
            <span>${fs.grandTotal.toFixed(2)}</span>
          </div>
        )}
      </div>

      {paymentSuccess && fs.allPaid && (
        <div className="mt-2 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-500/30 rounded-lg flex items-center gap-2">
          <span className="material-symbols-outlined text-green-600 dark:text-green-400 text-base">check_circle</span>
          <span className="text-sm font-medium text-green-700 dark:text-green-300">Payment collected — ready for check-in</span>
        </div>
      )}
    </div>
  );
}

interface PaymentActionFooterProps {
  isConferenceRoom: boolean;
  bookingId?: number;
  rosterData: ManageModeRosterData | null;
  fetchedContext: FetchedContext | null;
  ownerName?: string;
  ownerEmail?: string;
  bayName?: string;
  bookingDate?: string;
  showInlinePayment: boolean;
  setShowInlinePayment: (show: boolean) => void;
  inlinePaymentAction: string | null;
  setInlinePaymentAction: (action: string | null) => void;
  paymentSuccess: boolean;
  processingPayment?: boolean;
  savedCardInfo: { hasSavedCard: boolean; cardLast4?: string; cardBrand?: string } | null;
  checkingCard: boolean;
  showWaiverInput: boolean;
  setShowWaiverInput: (show: boolean) => void;
  waiverReason: string;
  setWaiverReason: (reason: string) => void;
  handleInlineStripeSuccess: () => void;
  handleChargeCardOnFile: () => void;
  handleWaiveFees: () => void;
  renderTierBadge: (tier: string | null | undefined, membershipStatus?: string | null) => React.ReactNode;
  onClose: () => void;
  checkinMode?: boolean;
  savingChanges: boolean;
  handleManageModeSave: () => void;
  onCheckIn?: (bookingId: number, targetStatus?: 'attended' | 'no_show') => void | Promise<void>;
  onRevertToApproved?: (bookingId: number) => void | Promise<void>;
  onReschedule?: (booking: { id: number; requestDate: string; startTime: string; endTime: string; resourceId: number; resourceName?: string; userName?: string; userEmail?: string }) => void;
  onCancelBooking?: (bookingId: number) => void;
  bookingContext?: { requestDate?: string; startTime?: string; endTime?: string; resourceId?: number; resourceName?: string };
  bookingStatus?: string;
}

export function PaymentActionFooter({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isConferenceRoom,
  bookingId,
  rosterData,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fetchedContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ownerName,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ownerEmail,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  bayName,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  bookingDate,
  showInlinePayment,
  setShowInlinePayment,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  inlinePaymentAction,
  setInlinePaymentAction,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  paymentSuccess,
  processingPayment,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  savedCardInfo,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  checkingCard,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  showWaiverInput,
  setShowWaiverInput,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  waiverReason,
  setWaiverReason,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleInlineStripeSuccess,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleChargeCardOnFile,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleWaiveFees,
  onClose,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  checkinMode,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  savingChanges,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleManageModeSave,
  onCheckIn,
  onRevertToApproved,
  onReschedule: _onReschedule,
  onCancelBooking,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  bookingContext,
  bookingStatus,
}: PaymentActionFooterProps) {
  const [checkingIn, setCheckingIn] = React.useState(false);
  const [localStatus, setLocalStatus] = React.useState<'attended' | 'no_show' | null>(null);

  React.useEffect(() => {
    setCheckingIn(false);
    setLocalStatus(null);
  }, [bookingId]);

  const fs = rosterData?.financialSummary;

  const closePaymentOptions = () => {
    setShowInlinePayment(false);
    setInlinePaymentAction(null);
    setShowWaiverInput(false);
    setWaiverReason('');
  };

  const handleCheckIn = async (targetStatus?: 'attended' | 'no_show' | 'approved') => {
    if (!bookingId) return;
    if (targetStatus === 'approved' && onRevertToApproved) {
      setCheckingIn(true);
      try {
        const result = onRevertToApproved(bookingId);
        if (result instanceof Promise) await result;
        setLocalStatus(null);
      } catch (error) {
        console.error('Revert failed:', error);
      } finally {
        setCheckingIn(false);
      }
      return;
    }
    if (!onCheckIn) return;
    setCheckingIn(true);
    try {
      const result = onCheckIn(bookingId, targetStatus as 'attended' | 'no_show' | undefined);
      if (result instanceof Promise) await result;
      setLocalStatus((targetStatus as 'attended' | 'no_show') || 'attended');
    } catch (error) {
      console.error('Check-in failed:', error);
    } finally {
      setCheckingIn(false);
    }
  };

  const renderSecondaryActions = () => (
    <div className="flex items-center justify-center gap-4 mt-2">
      {onCancelBooking && bookingStatus !== 'cancelled' && bookingStatus !== 'cancellation_pending' && localStatus !== 'attended' && localStatus !== 'no_show' && bookingStatus !== 'attended' && bookingStatus !== 'no_show' && (
        <button
          type="button"
          onClick={() => bookingId && onCancelBooking(bookingId)}
          className="text-xs text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 font-medium flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-sm">cancel</span>
          Cancel Booking
        </button>
      )}
    </div>
  );

  return (
    <div className="px-4 py-3 backdrop-blur-xl bg-white/80 dark:bg-[#1a1d15]/80">
      {processingPayment ? (
        <div className="flex items-center justify-center gap-2 py-3">
          <span className="material-symbols-outlined animate-spin text-lg text-green-600 dark:text-green-400">progress_activity</span>
          <span className="text-sm font-medium text-primary/70 dark:text-white/70">Confirming payment...</span>
        </div>
      ) : (
        <div>
          {fs && !fs.allPaid && fs.grandTotal > 0 && !showInlinePayment ? (
            <button
              type="button"
              onClick={() => setShowInlinePayment(true)}
              className="tactile-btn w-full py-2.5 px-4 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-sm">payments</span>
              Collect ${fs.grandTotal.toFixed(2)}
            </button>
          ) : localStatus || bookingStatus === 'attended' || bookingStatus === 'no_show' ? (
            <BookingStatusDropdown
              currentStatus={(localStatus || bookingStatus) as 'attended' | 'no_show'}
              onStatusChange={(status) => handleCheckIn(status)}
              loading={checkingIn}
              size="md"
              menuDirection="up"
              showRevert={!!onRevertToApproved}
            />
          ) : bookingStatus !== 'cancelled' && onCheckIn && !showInlinePayment ? (
            <BookingStatusDropdown
              currentStatus="check_in"
              onStatusChange={(status) => handleCheckIn(status)}
              loading={checkingIn}
              size="md"
              menuDirection="up"
            />
          ) : !showInlinePayment ? (
            <button
              type="button"
              onClick={onClose}
              className="tactile-btn w-full py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/20 text-primary dark:text-white text-sm font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
            >
              Close
            </button>
          ) : (
            <button
              type="button"
              onClick={closePaymentOptions}
              className="tactile-btn w-full py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/20 text-primary dark:text-white text-sm font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-sm">arrow_back</span>
              Back
            </button>
          )}
          {!showInlinePayment && renderSecondaryActions()}
        </div>
      )}
    </div>
  );
}

export function InlinePaymentBody({
  bookingId,
  rosterData,
  fetchedContext,
  ownerName,
  ownerEmail,
  bayName,
  bookingDate,
  showInlinePayment,
  setShowInlinePayment,
  inlinePaymentAction,
  setInlinePaymentAction,
  savedCardInfo,
  showWaiverInput,
  setShowWaiverInput,
  waiverReason,
  setWaiverReason,
  handleInlineStripeSuccess,
  handleChargeCardOnFile,
  handleWaiveFees,
}: {
  bookingId?: number;
  rosterData: ManageModeRosterData | null;
  fetchedContext: FetchedContext | null;
  ownerName?: string;
  ownerEmail?: string;
  bayName?: string;
  bookingDate?: string;
  showInlinePayment: boolean;
  setShowInlinePayment: (show: boolean) => void;
  inlinePaymentAction: string | null;
  setInlinePaymentAction: (action: string | null) => void;
  savedCardInfo: { hasSavedCard: boolean; cardLast4?: string; cardBrand?: string } | null;
  showWaiverInput: boolean;
  setShowWaiverInput: (show: boolean) => void;
  waiverReason: string;
  setWaiverReason: (reason: string) => void;
  handleInlineStripeSuccess: () => void;
  handleChargeCardOnFile: () => void;
  handleWaiveFees: () => void;
}) {
  const { showToast } = useToast();
  const [showCancelConfirm, setShowCancelConfirm] = React.useState(false);
  const [cancellingPayment, setCancellingPayment] = React.useState(false);
  const fs = rosterData?.financialSummary;

  const scrollRef = React.useCallback((node: HTMLDivElement | null) => {
    if (node) {
      requestAnimationFrame(() => {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }, []);

  if (!showInlinePayment || !fs || !bookingId) return null;

  const closePaymentOptions = () => {
    setShowInlinePayment(false);
    setInlinePaymentAction(null);
    setShowWaiverInput(false);
    setWaiverReason('');
  };

  const renderPaymentOptions = () => {
    if (inlinePaymentAction === 'stripe') {
      const resolvedUserId = rosterData?.ownerId || fetchedContext?.ownerUserId || '';
      const resolvedUserEmail = ownerEmail || fetchedContext?.ownerEmail || rosterData?.members?.find(m => m.isPrimary)?.userEmail || '';
      if (!resolvedUserEmail) {
        return (
          <div className="text-center py-4 space-y-2">
            <span className="material-symbols-outlined text-3xl text-red-500">error</span>
            <p className="text-sm text-red-600 dark:text-red-400">Unable to load member payment info. Try closing and reopening this booking.</p>
            <button type="button" onClick={() => setInlinePaymentAction(null)} className="tactile-btn py-2 px-4 rounded-lg text-sm font-medium text-primary/70 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors">
              <span className="material-symbols-outlined text-sm align-middle mr-1">arrow_back</span>Go Back
            </button>
          </div>
        );
      }
      return (
        <StripePaymentForm
          amount={fs.grandTotal}
          description={`${bayName || fetchedContext?.bayName || 'Booking'} • ${bookingDate || fetchedContext?.bookingDate || ''}`}
          userId={resolvedUserId}
          userEmail={resolvedUserEmail}
          memberName={ownerName || fetchedContext?.ownerName || rosterData?.members?.find(m => m.isPrimary)?.memberName || ''}
          purpose="overage_fee"
          bookingId={bookingId}
          sessionId={rosterData?.sessionId}
          participantFees={rosterData?.financialSummary?.playerBreakdown?.filter((p: { fee: number }) => p.fee > 0).map((p: { fee: number }, i: number) => ({ id: i, amount: p.fee })) || []}
          onSuccess={async (paymentIntentId?: string) => {
            if (paymentIntentId) {
              for (let attempt = 0; attempt < 2; attempt++) {
                try {
                  await postWithCredentials('/api/stripe/confirm-payment', { paymentIntentId });
                  break;
                } catch (err: unknown) {
                  console.error(`Confirm-payment attempt ${attempt + 1} failed:`, err);
                }
                if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
              }
            }
            handleInlineStripeSuccess();
          }}
          onCancel={() => setInlinePaymentAction(null)}
        />
      );
    }

    if (inlinePaymentAction === 'terminal') {
      const feeLines: string[] = [];
      if (fs.ownerOverageFee > 0) {
        feeLines.push(`Overage — $${fs.ownerOverageFee.toFixed(2)}`);
      }
      if (fs.playerBreakdown) {
        for (const p of fs.playerBreakdown) {
          if (p.fee > 0) {
            feeLines.push(`${p.name} — $${p.fee.toFixed(2)}`);
          }
        }
      }
      if (fs.guestFeesWithoutPass > 0) {
        const slotCount = rosterData?.validation?.emptySlots || 0;
        if (slotCount > 0) {
          feeLines.push(`Empty slots (${slotCount}) — $${fs.guestFeesWithoutPass.toFixed(2)}`);
        } else {
          feeLines.push(`Guest fees — $${fs.guestFeesWithoutPass.toFixed(2)}`);
        }
      }
      const feeBreakdownStr = feeLines.join('; ');
      const baseDesc = `${bayName || fetchedContext?.bayName || 'Booking'} • ${bookingDate || fetchedContext?.bookingDate || ''}`;
      const terminalDesc = feeLines.length > 0
        ? `${baseDesc} | ${feeBreakdownStr}`.substring(0, 1000)
        : baseDesc;
      const metaBreakdown = feeBreakdownStr.length > 500 ? feeBreakdownStr.substring(0, 497) + '...' : feeBreakdownStr;

      return (
        <TerminalPayment
          amount={Math.round(fs.grandTotal * 100)}
          userId={rosterData?.ownerId || fetchedContext?.ownerUserId || null}
          description={terminalDesc}
          paymentMetadata={{
            bookingId: String(bookingId),
            ...(rosterData?.sessionId ? { sessionId: String(rosterData.sessionId) } : {}),
            ownerEmail: ownerEmail || fetchedContext?.ownerEmail || rosterData?.members?.find(m => m.isPrimary)?.userEmail || '',
            userId: rosterData?.ownerId || fetchedContext?.ownerUserId || '',
            paymentType: 'booking_fee',
            ...(metaBreakdown ? { feeBreakdown: metaBreakdown } : {}),
          }}
          onSuccess={async (_paymentIntentId) => {
            try {
              await patchWithCredentials(`/api/bookings/${bookingId}/payments`, { action: 'confirm_all' });
            } catch (err: unknown) {
              console.error('Failed to mark participants as paid after terminal payment:', err);
            }
            showToast('Terminal payment successful!', 'success');
            handleInlineStripeSuccess();
          }}
          onError={(message) => {
            showToast(message || 'Terminal payment failed', 'error');
          }}
          onCancel={() => setInlinePaymentAction(null)}
        />
      );
    }

    return (
      <div className="space-y-2">
        {savedCardInfo?.hasSavedCard && (
          <button
            type="button"
            onClick={handleChargeCardOnFile}
            disabled={!!inlinePaymentAction}
            className="tactile-btn w-full py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {inlinePaymentAction === 'charge-card' ? (
              <><span className="material-symbols-outlined animate-spin text-sm">progress_activity</span> Charging...</>
            ) : (
              <><span className="material-symbols-outlined text-sm">credit_card</span> Charge Card on File ({savedCardInfo.cardBrand} •••• {savedCardInfo.cardLast4})</>
            )}
          </button>
        )}

        <button
          type="button"
          onClick={() => setInlinePaymentAction('stripe')}
          disabled={!!inlinePaymentAction}
          className="tactile-btn w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">credit_card</span>
          Pay with Card (${fs.grandTotal.toFixed(2)})
        </button>

        <button
          type="button"
          onClick={() => setInlinePaymentAction('terminal')}
          disabled={!!inlinePaymentAction}
          className="tactile-btn w-full py-2 px-3 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">contactless</span>
          Card Reader (${fs.grandTotal.toFixed(2)})
        </button>

        <button
          type="button"
          onClick={async () => {
            setInlinePaymentAction('mark-paid');
            try {
              await patchWithCredentials(`/api/bookings/${bookingId}/payments`, { action: 'confirm_all' });
              showToast('Payment confirmed — marked as paid', 'success');
            } catch (_err: unknown) {
              showToast('Failed to confirm payment', 'error');
            } finally {
              setInlinePaymentAction(null);
            }
          }}
          disabled={!!inlinePaymentAction}
          className="tactile-btn w-full py-2 px-3 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          {inlinePaymentAction === 'mark-paid' ? (
            <><span className="material-symbols-outlined animate-spin text-sm">progress_activity</span> Confirming...</>
          ) : (
            <><span className="material-symbols-outlined text-sm">payments</span> Mark Paid (Cash/External)</>
          )}
        </button>

        {!showWaiverInput ? (
          <button
            type="button"
            onClick={() => setShowWaiverInput(true)}
            disabled={!!inlinePaymentAction}
            className="tactile-btn w-full py-2 px-3 rounded-lg border border-gray-300 dark:border-white/20 text-primary/70 dark:text-white/70 hover:bg-gray-50 dark:hover:bg-white/5 text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">money_off</span>
            Waive All Fees
          </button>
        ) : (
          <div className="space-y-2">
            <input
              type="text"
              value={waiverReason}
              onChange={(e) => setWaiverReason(e.target.value)}
              placeholder="Reason for waiving fees..."
              className="w-full py-2 px-3 rounded-lg border border-gray-300 dark:border-white/20 bg-white dark:bg-white/5 text-sm text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setShowWaiverInput(false); setWaiverReason(''); }}
                className="tactile-btn flex-1 py-1.5 px-3 rounded-lg border border-gray-300 dark:border-white/20 text-primary/70 dark:text-white/70 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleWaiveFees}
                disabled={!waiverReason.trim() || !!inlinePaymentAction}
                className="tactile-btn flex-1 py-1.5 px-3 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium disabled:opacity-50"
              >
                {inlinePaymentAction === 'waive' ? 'Waiving...' : 'Confirm Waive'}
              </button>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowCancelConfirm(true)}
          disabled={!!inlinePaymentAction}
          className="tactile-btn w-full py-2 px-3 rounded-lg border border-red-300 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">block</span>
          Void All Payments
        </button>
      </div>
    );
  };

  const renderVoidConfirmation = () => {
    if (!showCancelConfirm) return null;
    return (
      <div className="mt-2 p-2 rounded-lg border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-900/10 space-y-2">
        <p className="text-xs text-red-600 dark:text-red-400 font-medium text-center">Are you sure? This will cancel all outstanding payment intents.</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowCancelConfirm(false)}
            disabled={cancellingPayment}
            className="tactile-btn flex-1 py-1.5 px-3 rounded-lg border border-gray-300 dark:border-white/20 text-primary/70 dark:text-white/70 text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              setCancellingPayment(true);
              try {
                const data = await patchWithCredentials<{ success?: boolean; failedCount?: number; cancelledCount?: number; message?: string; error?: string }>(`/api/bookings/${bookingId}/payments`, { action: 'cancel_all' });
                if (data.success) {
                  const msg = data.failedCount && data.failedCount > 0
                    ? `${data.cancelledCount} cancelled, ${data.failedCount} failed — check Stripe dashboard`
                    : (data.message || 'Payments cancelled');
                  showToast(msg, data.failedCount && data.failedCount > 0 ? 'warning' : 'success');
                  handleInlineStripeSuccess();
                } else {
                  showToast(data.error || 'Failed to cancel payments', 'error');
                }
              } catch (_err: unknown) {
                showToast('Failed to cancel payments', 'error');
              } finally {
                setCancellingPayment(false);
                setShowCancelConfirm(false);
              }
            }}
            disabled={cancellingPayment}
            className="tactile-btn flex-1 py-1.5 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50"
          >
            {cancellingPayment ? 'Cancelling...' : 'Confirm Void'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div ref={scrollRef} className="p-3 rounded-xl border border-blue-200 dark:border-blue-500/20 bg-blue-50/50 dark:bg-blue-900/10 space-y-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-primary dark:text-white flex items-center gap-1.5">
          <span className="material-symbols-outlined text-blue-600 dark:text-blue-400 text-lg">payments</span>
          Collect ${fs?.grandTotal?.toFixed(2)}
        </span>
        <button
          type="button"
          onClick={closePaymentOptions}
          className="tactile-btn p-1 rounded-full text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
          aria-label="Close payment options"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>
      {renderPaymentOptions()}
      {renderVoidConfirmation()}
    </div>
  );
}

interface PaymentSectionProps {
  isConferenceRoom: boolean;
  bookingId?: number;
  rosterData: ManageModeRosterData | null;
  fetchedContext: FetchedContext | null;
  ownerName?: string;
  ownerEmail?: string;
  bayName?: string;
  bookingDate?: string;

  showInlinePayment: boolean;
  setShowInlinePayment: (show: boolean) => void;
  inlinePaymentAction: string | null;
  setInlinePaymentAction: (action: string | null) => void;
  paymentSuccess: boolean;
  processingPayment?: boolean;
  savedCardInfo: { hasSavedCard: boolean; cardLast4?: string; cardBrand?: string } | null;
  checkingCard: boolean;
  showWaiverInput: boolean;
  setShowWaiverInput: (show: boolean) => void;
  waiverReason: string;
  setWaiverReason: (reason: string) => void;

  handleInlineStripeSuccess: () => void;
  handleChargeCardOnFile: () => void;
  handleWaiveFees: () => void;
  renderTierBadge: (tier: string | null | undefined, membershipStatus?: string | null) => React.ReactNode;
}

export function PaymentSection(props: PaymentSectionProps) {
  const renderGuestPassInfo = () => {
    if (!props.rosterData) return null;
    const total = props.rosterData.tierLimits?.guest_passes_per_month;
    if (!total) return null;
    const remaining = props.rosterData.ownerGuestPassesRemaining;

    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="material-symbols-outlined text-emerald-500 text-sm">redeem</span>
        <span className="text-primary/70 dark:text-white/70">
          Guest Passes: <span className="font-semibold text-primary dark:text-white">{remaining}/{total}</span> remaining
        </span>
      </div>
    );
  };

  return (
    <>
      <PaymentSummaryBody
        isConferenceRoom={props.isConferenceRoom}
        rosterData={props.rosterData}
        renderTierBadge={props.renderTierBadge}
        paymentSuccess={props.paymentSuccess}
      />
      {renderGuestPassInfo()}
    </>
  );
}

export default PaymentSection;
