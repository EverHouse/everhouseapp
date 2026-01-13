import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '../../Toast';

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
}

interface CheckinContext {
  bookingId: number;
  sessionId: number | null;
  ownerName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  memberNotes: string | null;
  participants: ParticipantFee[];
  totalOutstanding: number;
  hasUnpaidBalance: boolean;
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

  useEffect(() => {
    if (isOpen && bookingId) {
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
        setError('Failed to load billing context');
      }
    } catch (err) {
      setError('Failed to load billing context');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmPayment = async (participantId: number) => {
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
        showToast('Failed to confirm payment', 'error');
      }
    } catch (err) {
      console.error('Failed to confirm payment:', err);
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

  const handleConfirmAll = async () => {
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
        showToast('Failed to confirm payments', 'error');
      }
    } catch (err) {
      console.error('Failed to confirm all payments:', err);
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
        const data = await res.json();
        setError(data.error || 'Failed to check in');
      }
    } catch (err) {
      setError('Failed to check in');
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
        body: JSON.stringify({ status: 'attended', skipPaymentCheck: true })
      });
      if (res.ok) {
        onCheckinComplete();
        onClose();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to check in');
      }
    } catch (err) {
      setError('Failed to check in');
    } finally {
      setActionInProgress(null);
    }
  };

  if (!isOpen) return null;

  const unpaidParticipants = context?.participants.filter(p => 
    p.paymentStatus === 'pending' && p.totalFee > 0
  ) || [];
  const hasPendingPayments = unpaidParticipants.length > 0;

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-white dark:bg-[#1a1d12] rounded-2xl shadow-2xl border border-primary/20 dark:border-white/10 overflow-hidden">
        <div className="px-6 py-4 border-b border-primary/10 dark:border-white/10 bg-primary/5 dark:bg-white/5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-primary dark:text-white flex items-center gap-2">
              <span className="material-symbols-outlined">payments</span>
              Check-In & Billing
            </h2>
            <button onClick={onClose} className="p-1 hover:bg-primary/10 dark:hover:bg-white/10 rounded-lg">
              <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
            </button>
          </div>
        </div>

        <div className="p-6 max-h-[70vh] overflow-y-auto">
          {loading ? (
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
                  {context.resourceName} • {context.startTime?.slice(0, 5)} - {context.endTime?.slice(0, 5)}
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
                            <span className="text-green-600 dark:text-green-400">Within daily allowance</span>
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
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleConfirmPayment(p.participantId)}
                                disabled={actionInProgress !== null}
                                className="flex-1 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                              >
                                {actionInProgress === `confirm-${p.participantId}` ? 'Processing...' : 'Mark Paid'}
                              </button>
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
                          <div className="flex items-center gap-1 text-xs">
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

        <div className="px-6 py-4 border-t border-primary/10 dark:border-white/10 bg-primary/5 dark:bg-white/5">
          <div className="flex flex-col gap-2">
            {hasPendingPayments ? (
              <>
                <button
                  onClick={handleConfirmAll}
                  disabled={actionInProgress !== null}
                  className="w-full py-3 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined">payments</span>
                  {actionInProgress === 'confirm-all' ? 'Processing...' : 'Confirm All Payments & Check In'}
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
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default CheckinBillingModal;
