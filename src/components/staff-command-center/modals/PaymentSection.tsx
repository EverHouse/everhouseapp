import React from 'react';
import { ManageModeRosterData, FetchedContext } from './bookingSheetTypes';
import { StripePaymentForm } from '../../stripe/StripePaymentForm';
import { TerminalPayment } from '../TerminalPayment';
import { useToast } from '../../Toast';

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

export function PaymentSection({
  isConferenceRoom,
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
  paymentSuccess,
  savedCardInfo,
  checkingCard,
  showWaiverInput,
  setShowWaiverInput,
  waiverReason,
  setWaiverReason,
  handleInlineStripeSuccess,
  handleChargeCardOnFile,
  handleWaiveFees,
  renderTierBadge,
}: PaymentSectionProps) {
  const { showToast } = useToast();

  const renderGuestPassInfo = () => {
    if (!rosterData) return null;
    const total = rosterData.tierLimits?.guest_passes_per_month;
    if (!total) return null;
    const remaining = rosterData.ownerGuestPassesRemaining;

    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="material-symbols-outlined text-emerald-500 text-sm">redeem</span>
        <span className="text-primary/70 dark:text-white/70">
          Guest Passes: <span className="font-semibold text-primary dark:text-white">{remaining}/{total}</span> remaining
        </span>
      </div>
    );
  };

  const renderFinancialSummary = () => {
    if (isConferenceRoom) return null;
    const fs = rosterData?.financialSummary;
    if (!fs) return null;

    const guestPassesUsed = rosterData?.members.filter(
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
          <div className="pt-1 border-t border-primary/10 dark:border-white/10 flex justify-between font-semibold text-sm text-primary dark:text-white">
            <span>Owner Pays</span>
            <span>${fs.totalOwnerOwes.toFixed(2)}</span>
          </div>
          {fs.grandTotal > 0 && fs.grandTotal !== fs.totalOwnerOwes && (
            <div className="flex justify-between text-primary/70 dark:text-white/70">
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

        {!fs.allPaid && fs.grandTotal > 0 && bookingId && !showInlinePayment && (
          <button
            onClick={() => setShowInlinePayment(true)}
            className="tactile-btn w-full mt-2 py-2 px-3 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1"
          >
            <span className="material-symbols-outlined text-sm">payments</span>
            Collect ${fs.grandTotal.toFixed(2)}
          </button>
        )}

        {showInlinePayment && !fs.allPaid && fs.grandTotal > 0 && bookingId && (
          <div className="mt-2 space-y-2 p-3 bg-primary/5 dark:bg-white/5 rounded-lg border border-primary/10 dark:border-white/10">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-primary dark:text-white flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">payments</span>
                Collect ${fs.grandTotal.toFixed(2)}
              </span>
              <button onClick={() => { setShowInlinePayment(false); setInlinePaymentAction(null); setShowWaiverInput(false); setWaiverReason(''); }} className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white">
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>

            {inlinePaymentAction === 'stripe' ? (
              (() => {
                const resolvedUserId = rosterData?.ownerId || fetchedContext?.ownerUserId || '';
                const resolvedUserEmail = ownerEmail || fetchedContext?.ownerEmail || rosterData?.members?.find(m => m.isPrimary)?.userEmail || '';
                if (!resolvedUserEmail) {
                  return (
                    <div className="text-center py-4 space-y-2">
                      <span className="material-symbols-outlined text-3xl text-red-500">error</span>
                      <p className="text-sm text-red-600 dark:text-red-400">Unable to load member payment info. Try closing and reopening this booking.</p>
                      <button onClick={() => setInlinePaymentAction(null)} className="py-2 px-4 rounded-lg text-sm font-medium text-primary/70 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors">
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
                    onSuccess={handleInlineStripeSuccess}
                    onCancel={() => setInlinePaymentAction(null)}
                  />
                );
              })()
            ) : inlinePaymentAction === 'terminal' ? (
              (() => {
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
                    onSuccess={async (paymentIntentId) => {
                      try {
                        await fetch(`/api/bookings/${bookingId}/payments`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          credentials: 'include',
                          body: JSON.stringify({ action: 'confirm_all' })
                        });
                      } catch (err) {
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
              })()
            ) : (
              <div className="space-y-2">
                {savedCardInfo?.hasSavedCard && (
                  <button
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
                  onClick={() => setInlinePaymentAction('stripe')}
                  disabled={!!inlinePaymentAction}
                  className="tactile-btn w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-sm">credit_card</span>
                  Pay with Card (${fs.grandTotal.toFixed(2)})
                </button>

                <button
                  onClick={() => setInlinePaymentAction('terminal')}
                  disabled={!!inlinePaymentAction}
                  className="tactile-btn w-full py-2 px-3 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-sm">contactless</span>
                  Card Reader (${fs.grandTotal.toFixed(2)})
                </button>

                <button
                  onClick={async () => {
                    if (!bookingId) return;
                    setInlinePaymentAction('mark-paid');
                    try {
                      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ action: 'confirm_all' })
                      });
                      if (res.ok) {
                        showToast('Payment confirmed — marked as paid', 'success');
                      } else {
                        showToast('Failed to confirm payment', 'error');
                      }
                    } catch (err) {
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
                        onClick={() => { setShowWaiverInput(false); setWaiverReason(''); }}
                        className="tactile-btn flex-1 py-1.5 px-3 rounded-lg border border-gray-300 dark:border-white/20 text-primary/70 dark:text-white/70 text-sm"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleWaiveFees}
                        disabled={!waiverReason.trim() || !!inlinePaymentAction}
                        className="tactile-btn flex-1 py-1.5 px-3 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium disabled:opacity-50"
                      >
                        {inlinePaymentAction === 'waive' ? 'Waiving...' : 'Confirm Waive'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {renderFinancialSummary()}
      {renderGuestPassInfo()}
    </>
  );
}

export default PaymentSection;
