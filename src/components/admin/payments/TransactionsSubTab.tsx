import React, { useState, useEffect, useRef } from 'react';
import EmptyState from '../../EmptyState';
import { useIsMobile } from '../../../hooks/useBreakpoint';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';
import { useConfirmDialog } from '../../ConfirmDialog';
import { formatTime12Hour } from '../../../utils/dateUtils';
import RecentTransactionsSection, { TransactionListRef, Transaction } from './TransactionList';
import OverduePaymentsPanel from './OverduePaymentsPanel';
import { UnifiedBookingSheet } from '../../staff-command-center/modals/UnifiedBookingSheet';
import {
  useDailySummary,
  useOverduePayments,
  useFailedPayments,
  usePendingAuthorizations,
  useFutureBookingsWithFees,
  useRefundedPayments,
  useRetryPayment,
  useCancelPayment,
  useCapturePayment,
  useVoidPayment,
} from '../../../hooks/queries/useFinancialsQueries';

interface Payment {
  id: string;
  memberName?: string;
  description?: string;
  amount: number;
  createdAt: string;
  status?: string;
  [key: string]: unknown;
}

interface SectionProps {
  onClose?: () => void;
  variant?: 'modal' | 'card';
}

interface OverduePayment {
  bookingId: number;
  sessionId: number;
  ownerEmail: string;
  ownerName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  totalOutstanding: number;
  unreviewedWaivers: number;
}

interface FailedPayment {
  id: number;
  paymentIntentId: string;
  memberEmail: string;
  memberName: string;
  amount: number;
  description: string | null;
  status: string;
  failureReason: string | null;
  retryCount: number;
  lastRetryAt: string | null;
  requiresCardUpdate: boolean;
  dunningNotifiedAt: string | null;
  createdAt: string;
}

interface PendingAuthorization {
  id: number;
  paymentIntentId: string;
  memberEmail: string;
  memberName: string;
  amount: number;
  description: string | null;
  createdAt: string;
  expiresAt: string;
}

interface FutureBooking {
  bookingId: number;
  memberEmail: string;
  memberName: string;
  tier: string | null;
  date: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  status: string;
  playerCount: number;
  guestCount: number;
  estimatedFeeCents: number;
  hasPaymentIntent: boolean;
}

interface RefundablePayment {
  id: number;
  paymentIntentId: string;
  memberEmail: string;
  memberName: string;
  amount: number;
  description: string;
  createdAt: string;
  status: string;
  [key: string]: unknown;
}

const MAX_RETRY_ATTEMPTS = 3;

const DailySummaryCard: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const { data: summary, isLoading, error } = useDailySummary();

  const formatCurrency = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  const formatDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const date = new Date(year, month - 1, day);
    return `${days[date.getDay()]}, ${months[month - 1]} ${day}`;
  };

  const categoryLabels: Record<string, { label: string; icon: string }> = {
    bookingFee: { label: 'Booking Fees', icon: 'sports_golf' },
    guestFee: { label: 'Guest Fees', icon: 'person_add' },
    overage: { label: 'Overages', icon: 'schedule' },
    merchandise: { label: 'Merchandise', icon: 'shopping_bag' },
    membership: { label: 'Memberships', icon: 'card_membership' },
    cash: { label: 'Cash', icon: 'payments' },
    check: { label: 'Check', icon: 'money' },
    other: { label: 'Other', icon: 'more_horiz' }
  };

  const content = (
    <div className="space-y-4">
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <WalkingGolferSpinner size="sm" variant="dark" />
        </div>
      ) : error ? (
        <div className="text-center py-4 text-red-500">{error instanceof Error ? error.message : 'Failed to fetch summary'}</div>
      ) : summary ? (
        <>
          <div className="text-center">
            <p className="text-sm font-medium text-primary/60 dark:text-white/60 uppercase tracking-wide">
              {formatDate(summary.date)}
            </p>
            <p className="text-4xl font-bold text-green-600 dark:text-green-400 mt-1">
              {formatCurrency(summary.totalCollected)}
            </p>
            <p className="text-xs text-primary/50 dark:text-white/50 mt-1">
              Total Collected
            </p>
          </div>

          <div className="border-t border-primary/10 dark:border-white/10 pt-4 space-y-2">
            {Object.entries(summary.breakdown)
              .filter(([_, cents]) => cents > 0)
              .sort(([, a], [, b]) => b - a)
              .map(([key, cents]) => {
                const cat = categoryLabels[key] || { label: key, icon: 'circle' };
                return (
                  <div key={key} className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-lg text-primary/60 dark:text-white/60">
                        {cat.icon}
                      </span>
                      <span className="text-sm text-primary dark:text-white">{cat.label}</span>
                    </div>
                    <span className="font-semibold text-primary dark:text-white">
                      {formatCurrency(cents)}
                    </span>
                  </div>
                );
              })}
            {Object.values(summary.breakdown).every(v => v === 0) && (
              <p className="text-center text-sm text-primary/50 dark:text-white/50 py-2">
                No transactions today
              </p>
            )}
          </div>

          <div className="border-t border-primary/10 dark:border-white/10 pt-3 text-center">
            <p className="text-sm text-primary/60 dark:text-white/60">
              <span className="font-semibold text-primary dark:text-white">{summary.transactionCount}</span>
              {' '}transaction{summary.transactionCount !== 1 ? 's' : ''} today
            </p>
          </div>
        </>
      ) : null}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-emerald-600 dark:text-emerald-400">summarize</span>
          <h3 className="font-bold text-primary dark:text-white">Daily Summary</h3>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-emerald-600 dark:text-emerald-400">summarize</span>
          <h3 className="font-bold text-primary dark:text-white">Daily Summary</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

const PendingAuthorizationsSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const { data: authorizations = [], isLoading: loading } = usePendingAuthorizations();
  const capturePayment = useCapturePayment();
  const voidPayment = useVoidPayment();

  const [selectedAuth, setSelectedAuth] = useState<PendingAuthorization | null>(null);
  const [actionType, setActionType] = useState<'capture' | 'void' | null>(null);
  const [captureAmount, setCaptureAmount] = useState('');
  const [isPartialCapture, setIsPartialCapture] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isProcessing = capturePayment.isPending || voidPayment.isPending;

  const getTimeUntilExpiry = (expiresAt: string) => {
    const now = new Date();
    const expiry = new Date(expiresAt);
    const diffMs = expiry.getTime() - now.getTime();
    
    if (diffMs <= 0) return { text: 'Expired', urgent: true };
    
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    if (days > 0) {
      return { text: `${days}d ${hours}h left`, urgent: days <= 1 };
    }
    return { text: `${hours}h left`, urgent: true };
  };

  const handleCapture = async () => {
    if (!selectedAuth) return;
    
    setError(null);
    
    try {
      const amountCents = isPartialCapture && captureAmount 
        ? Math.round(parseFloat(captureAmount) * 100)
        : undefined;
      
      await capturePayment.mutateAsync({
        paymentIntentId: selectedAuth.paymentIntentId,
        amountCents
      });

      setSuccess(true);
      setTimeout(() => {
        resetModal();
      }, 1500);
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Failed to capture payment');
    }
  };

  const handleVoid = async () => {
    if (!selectedAuth) return;
    
    setError(null);
    
    try {
      await voidPayment.mutateAsync({
        paymentIntentId: selectedAuth.paymentIntentId,
        reason: voidReason || 'No reason provided'
      });

      setSuccess(true);
      setTimeout(() => {
        resetModal();
      }, 1500);
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Failed to void authorization');
    }
  };

  const resetModal = () => {
    setSelectedAuth(null);
    setActionType(null);
    setCaptureAmount('');
    setIsPartialCapture(false);
    setVoidReason('');
    setError(null);
    setSuccess(false);
  };

  const voidReasons = [
    'Customer requested cancellation',
    'Duplicate authorization',
    'Booking cancelled',
    'Amount error',
    'Other'
  ];

  const content = loading ? (
    <div className="flex items-center justify-center py-8">
      <WalkingGolferSpinner size="sm" variant="dark" />
    </div>
  ) : authorizations.length === 0 ? (
    <EmptyState 
      icon="check_circle" 
      title="No pending authorizations" 
      description="All pre-authorized payments have been processed" 
      variant="compact" 
    />
  ) : (
    <div className="space-y-2 max-h-[350px] overflow-y-auto">
      {authorizations.map(auth => {
        const expiry = getTimeUntilExpiry(auth.expiresAt);
        return (
          <div key={auth.id} className="p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-blue-100 dark:border-blue-900/20">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
                <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">hourglass_top</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm text-primary dark:text-white">{auth.memberName || 'Unknown'}</p>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                    expiry.urgent 
                      ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400' 
                      : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400'
                  }`}>
                    {expiry.text}
                  </span>
                </div>
                <p className="text-xs text-primary/60 dark:text-white/60 truncate mt-0.5">
                  {auth.description || 'Pre-authorization'}
                </p>
                <p className="text-xs text-primary/50 dark:text-white/50 mt-1">
                  {new Date(auth.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    timeZone: 'America/Los_Angeles'
                  })}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-bold text-primary dark:text-white">${(auth.amount / 100).toFixed(2)}</p>
                <div className="flex gap-1 mt-1">
                  <button
                    onClick={() => {
                      setSelectedAuth(auth);
                      setActionType('capture');
                    }}
                    className="tactile-btn px-2 py-1 text-xs font-medium text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 rounded-lg transition-colors"
                  >
                    Capture
                  </button>
                  <button
                    onClick={() => {
                      setSelectedAuth(auth);
                      setActionType('void');
                    }}
                    className="tactile-btn px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                  >
                    Void
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {selectedAuth && actionType && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={resetModal}>
          <div 
            className="bg-white dark:bg-surface-dark rounded-2xl w-full max-w-sm shadow-xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            {success ? (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
                  <span className="material-symbols-outlined text-4xl text-green-600">check_circle</span>
                </div>
                <p className="text-lg font-semibold text-primary dark:text-white">
                  {actionType === 'capture' ? 'Payment Captured!' : 'Authorization Voided!'}
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-primary dark:text-white">
                    {actionType === 'capture' ? 'Capture Payment' : 'Void Authorization'}
                  </h3>
                  <button
                    onClick={resetModal}
                    className="tactile-btn p-2 rounded-full hover:bg-primary/10 dark:hover:bg-white/10"
                  >
                    <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
                  </button>
                </div>

                <div className="flex items-center gap-3 p-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/30 mb-4">
                  <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
                    <span className="text-blue-600 dark:text-blue-400 font-semibold">
                      {selectedAuth.memberName?.charAt(0)?.toUpperCase() || '?'}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-primary dark:text-white truncate">{selectedAuth.memberName}</p>
                    <p className="text-xs text-primary/60 dark:text-white/60 truncate">{selectedAuth.description}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-primary dark:text-white">${(selectedAuth.amount / 100).toFixed(2)}</p>
                  </div>
                </div>

                {actionType === 'capture' && (
                  <>
                    <div className="flex items-center gap-4 p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/10 dark:border-white/10 mb-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          checked={!isPartialCapture}
                          onChange={() => {
                            setIsPartialCapture(false);
                            setCaptureAmount('');
                          }}
                          className="w-4 h-4 text-green-500 accent-green-500"
                        />
                        <span className="text-sm text-primary dark:text-white">Full Amount</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          checked={isPartialCapture}
                          onChange={() => setIsPartialCapture(true)}
                          className="w-4 h-4 text-green-500 accent-green-500"
                        />
                        <span className="text-sm text-primary dark:text-white">Partial</span>
                      </label>
                    </div>

                    {isPartialCapture && (
                      <div className="mb-4">
                        <label className="block text-sm font-medium text-primary dark:text-white mb-2">Capture Amount</label>
                        <div className="relative">
                          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60 dark:text-white/60 font-medium">$</span>
                          <input
                            type="number"
                            value={captureAmount}
                            onChange={(e) => setCaptureAmount(e.target.value)}
                            placeholder="0.00"
                            step="0.01"
                            min="0.50"
                            max={(selectedAuth.amount / 100).toFixed(2)}
                            className="w-full pl-8 pr-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-green-400 text-lg font-semibold"
                          />
                        </div>
                        <p className="text-xs text-primary/50 dark:text-white/50 mt-1">
                          Maximum: ${(selectedAuth.amount / 100).toFixed(2)}
                        </p>
                      </div>
                    )}
                  </>
                )}

                {actionType === 'void' && (
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-primary dark:text-white mb-2">Reason</label>
                    <select
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-red-400"
                    >
                      <option value="">Select a reason...</option>
                      {voidReasons.map(reason => (
                        <option key={reason} value={reason}>{reason}</option>
                      ))}
                    </select>
                  </div>
                )}

                {error && (
                  <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 mb-4">
                    <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={resetModal}
                    className="tactile-btn flex-1 py-3 rounded-full bg-white dark:bg-white/10 text-primary dark:text-white font-medium border border-primary/20 dark:border-white/20 hover:bg-primary/5 dark:hover:bg-white/20 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={actionType === 'capture' ? handleCapture : handleVoid}
                    disabled={isProcessing || (actionType === 'capture' && isPartialCapture && (!captureAmount || parseFloat(captureAmount) <= 0))}
                    className={`tactile-btn flex-1 py-3 rounded-full font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
                      actionType === 'capture' 
                        ? 'bg-green-500 text-white' 
                        : 'bg-red-500 text-white'
                    }`}
                  >
                    {isProcessing ? (
                      <>
                        <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                        Processing...
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-outlined text-lg">
                          {actionType === 'capture' ? 'check_circle' : 'cancel'}
                        </span>
                        {actionType === 'capture' ? 'Capture' : 'Void'}
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">hourglass_top</span>
          <h3 className="font-bold text-primary dark:text-white">Pending Authorizations</h3>
          {authorizations.length > 0 && (
            <span className="px-2 py-0.5 text-xs font-bold bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded-full">
              {authorizations.length}
            </span>
          )}
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">hourglass_top</span>
          <h3 className="font-bold text-primary dark:text-white">Pending Authorizations</h3>
          {authorizations.length > 0 && (
            <span className="px-2 py-0.5 text-xs font-bold bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded-full">
              {authorizations.length}
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

const FutureBookingsSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const { data: allFutureBookings = [], isLoading: loading } = useFutureBookingsWithFees();
  const [bookingSheet, setBookingSheet] = useState<{ isOpen: boolean; bookingId: number | null }>({ isOpen: false, bookingId: null });

  const futureBookings = allFutureBookings.filter(b => b.estimatedFeeCents > 0);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
  };

  const content = loading ? (
    <div className="flex items-center justify-center py-8">
      <WalkingGolferSpinner size="sm" variant="dark" />
    </div>
  ) : futureBookings.length === 0 ? (
    <EmptyState 
      icon="event_available" 
      title="No upcoming bookings with fees"
      description="Bookings with outstanding fees will appear here"
    />
  ) : (
    <div className="space-y-3">
      {futureBookings.map((booking) => (
        <button 
          type="button"
          key={booking.bookingId}
          onClick={() => setBookingSheet({ isOpen: true, bookingId: booking.bookingId })}
          className="w-full text-left flex items-center justify-between p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10 transition-colors cursor-pointer"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-primary dark:text-white truncate">
                {booking.memberName}
              </span>
              {booking.tier && (
                <span className="px-1.5 py-0.5 text-xs bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 rounded">
                  {booking.tier}
                </span>
              )}
            </div>
            <div className="text-sm text-primary/60 dark:text-white/60 flex items-center gap-2 mt-1">
              <span>{booking.resourceName}</span>
              <span className="text-primary/30 dark:text-white/30">|</span>
              <span>{formatDate(booking.date)}</span>
              <span className="text-primary/30 dark:text-white/30">|</span>
              <span>{formatTime12Hour(booking.startTime)}</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              {booking.playerCount > 1 && (
                <span className="text-xs text-primary/50 dark:text-white/50">
                  {booking.playerCount} players
                </span>
              )}
              {booking.guestCount > 0 && (
                <span className="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 rounded">
                  {booking.guestCount} guest{booking.guestCount > 1 ? 's' : ''}
                </span>
              )}
              {booking.hasPaymentIntent && (
                <span className="text-xs px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded">
                  Payment pending
                </span>
              )}
            </div>
          </div>
          <div className="text-right flex items-center gap-2">
            <span className="font-bold text-green-600 dark:text-green-400">
              ${(booking.estimatedFeeCents / 100).toFixed(2)}
            </span>
            <span className="material-symbols-outlined text-primary/30 dark:text-white/30 text-lg">chevron_right</span>
          </div>
        </button>
      ))}
    </div>
  );

  const sectionContent = (
    <>
      {variant === 'card' ? (
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-green-600 dark:text-green-400">event_upcoming</span>
            <h3 className="font-bold text-primary dark:text-white">Future Bookings</h3>
            {futureBookings.length > 0 && (
              <span className="px-2 py-0.5 text-xs font-bold bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 rounded-full">
                {futureBookings.length}
              </span>
            )}
          </div>
          {content}
        </div>
      ) : (
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-green-600 dark:text-green-400">event_upcoming</span>
              <h3 className="font-bold text-primary dark:text-white">Future Bookings</h3>
              {futureBookings.length > 0 && (
                <span className="px-2 py-0.5 text-xs font-bold bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 rounded-full">
                  {futureBookings.length}
                </span>
              )}
            </div>
            <button type="button" onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
              <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
            </button>
          </div>
          {content}
        </div>
      )}
      <UnifiedBookingSheet
        isOpen={bookingSheet.isOpen}
        onClose={() => setBookingSheet({ isOpen: false, bookingId: null })}
        mode="manage"
        bookingId={bookingSheet.bookingId || undefined}
        onSuccess={() => {
          setBookingSheet({ isOpen: false, bookingId: null });
        }}
        onRosterUpdated={() => {}}
      />
    </>
  );

  return sectionContent;
};

const FailedPaymentsSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const { data: failedPayments = [], isLoading: loading } = useFailedPayments();
  const retryPayment = useRetryPayment();
  const cancelPayment = useCancelPayment();

  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [retryingPaymentId, setRetryingPaymentId] = useState<string | null>(null);
  const [cancelingPaymentId, setCancelingPaymentId] = useState<string | null>(null);
  const { confirm, ConfirmDialogComponent } = useConfirmDialog();

  const handleRetryPayment = async (paymentIntentId: string) => {
    setRetryingPaymentId(paymentIntentId);
    try {
      await retryPayment.mutateAsync(paymentIntentId);
    } catch (err: unknown) {
      console.error('Error retrying payment:', err);
    } finally {
      setRetryingPaymentId(null);
    }
  };

  const handleCancelPayment = async (paymentIntentId: string) => {
    const confirmed = await confirm({
      title: 'Cancel Payment',
      message: 'Cancel this payment? This will remove it from the failed payments list.',
      confirmText: 'Cancel Payment',
      variant: 'warning'
    });
    if (!confirmed) return;
    setCancelingPaymentId(paymentIntentId);
    try {
      await cancelPayment.mutateAsync(paymentIntentId);
    } catch (err: unknown) {
      console.error('Error canceling payment:', err);
    } finally {
      setCancelingPaymentId(null);
    }
  };

  const getStatusBadge = (payment: FailedPayment) => {
    if (payment.requiresCardUpdate) {
      return { label: 'Card Update Required', className: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400' };
    }
    switch (payment.status) {
      case 'failed':
        return { label: 'Failed', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400' };
      case 'canceled':
        return { label: 'Canceled', className: 'bg-gray-100 dark:bg-gray-800/40 text-gray-700 dark:text-gray-400' };
      case 'requires_action':
        return { label: 'Action Required', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400' };
      case 'requires_payment_method':
        return { label: 'No Payment Method', className: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400' };
      default:
        return { label: payment.status, className: 'bg-gray-100 dark:bg-gray-800/40 text-gray-700 dark:text-gray-400' };
    }
  };

  const handleContactMember = (email: string) => {
    setSelectedEmail(email);
  };

  const content = loading ? (
    <div className="flex items-center justify-center py-8">
      <WalkingGolferSpinner size="sm" variant="dark" />
    </div>
  ) : failedPayments.length === 0 ? (
    <EmptyState 
      icon="check_circle" 
      title="No failed payments" 
      description="All payments are processing normally" 
      variant="compact" 
    />
  ) : (
    <div className="space-y-2 max-h-[350px] overflow-y-auto">
      {failedPayments.map(payment => {
        const badge = getStatusBadge(payment);
        const canRetry = !payment.requiresCardUpdate && payment.retryCount < MAX_RETRY_ATTEMPTS;
        const isRetrying = retryingPaymentId === payment.paymentIntentId;
        return (
          <div key={payment.id} className="p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-red-100 dark:border-red-900/20">
            <div className="flex items-start gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                payment.requiresCardUpdate 
                  ? 'bg-purple-100 dark:bg-purple-900/30' 
                  : 'bg-red-100 dark:bg-red-900/30'
              }`}>
                <span className={`material-symbols-outlined ${
                  payment.requiresCardUpdate 
                    ? 'text-purple-600 dark:text-purple-400' 
                    : 'text-red-600 dark:text-red-400'
                }`}>
                  {payment.requiresCardUpdate ? 'credit_card_off' : 'error'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm text-primary dark:text-white">{payment.memberName}</p>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${badge.className}`}>
                    {badge.label}
                  </span>
                  {payment.retryCount > 0 && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 dark:bg-gray-800/40 text-gray-600 dark:text-gray-400">
                      Attempt {payment.retryCount}/{MAX_RETRY_ATTEMPTS}
                    </span>
                  )}
                </div>
                <p className="text-xs text-primary/60 dark:text-white/60 truncate mt-0.5">
                  {payment.description || 'No description'}
                </p>
                {payment.failureReason && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                    {payment.failureReason}
                  </p>
                )}
                <p className="text-xs text-primary/50 dark:text-white/50 mt-1">
                  {new Date(payment.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    timeZone: 'America/Los_Angeles'
                  })}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-bold text-red-600 dark:text-red-400">${(payment.amount / 100).toFixed(2)}</p>
                <div className="mt-1 flex flex-col gap-1">
                  {canRetry && (
                    <button
                      onClick={() => handleRetryPayment(payment.paymentIntentId)}
                      disabled={isRetrying}
                      className="tactile-btn px-2 py-1 text-xs font-medium text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30 hover:bg-green-200 dark:hover:bg-green-900/50 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                    >
                      {isRetrying ? (
                        <span className="animate-spin w-3 h-3 border-2 border-green-600 border-t-transparent rounded-full" />
                      ) : (
                        <span className="material-symbols-outlined text-sm">refresh</span>
                      )}
                      Retry
                    </button>
                  )}
                  <button
                    onClick={() => handleCancelPayment(payment.paymentIntentId)}
                    disabled={cancelingPaymentId === payment.paymentIntentId}
                    className="tactile-btn px-2 py-1 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                  >
                    {cancelingPaymentId === payment.paymentIntentId ? (
                      <span className="animate-spin w-3 h-3 border-2 border-red-600 border-t-transparent rounded-full" />
                    ) : (
                      <span className="material-symbols-outlined text-sm">close</span>
                    )}
                    Cancel
                  </button>
                  <button
                    onClick={() => handleContactMember(payment.memberEmail)}
                    className="tactile-btn px-2 py-1 text-xs font-medium text-primary dark:text-lavender hover:bg-primary/10 dark:hover:bg-white/10 rounded-lg transition-colors flex items-center gap-1"
                  >
                    <span className="material-symbols-outlined text-sm">mail</span>
                    Contact
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {selectedEmail && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setSelectedEmail(null)}>
          <div 
            className="bg-white dark:bg-surface-dark rounded-2xl w-full max-w-sm shadow-xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-primary dark:text-white">Contact Member</h3>
              <button
                onClick={() => setSelectedEmail(null)}
                className="tactile-btn p-2 rounded-full hover:bg-primary/10 dark:hover:bg-white/10"
              >
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
              </button>
            </div>
            <p className="text-sm text-primary/70 dark:text-white/70 mb-4">
              Send an email to follow up about the failed payment:
            </p>
            <div className="p-3 rounded-xl bg-primary/5 dark:bg-white/5 border border-primary/10 dark:border-white/10 mb-4">
              <p className="text-sm font-medium text-primary dark:text-white break-all">{selectedEmail}</p>
            </div>
            <a
              href={`mailto:${selectedEmail}?subject=Regarding Your Payment&body=Hi, we noticed an issue with a recent payment attempt. Please contact us to resolve this.`}
              className="w-full py-3 rounded-full bg-primary dark:bg-lavender text-white dark:text-primary font-semibold flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined">mail</span>
              Open Email
            </a>
          </div>
        </div>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <>
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-red-600 dark:text-red-400">error</span>
            <h3 className="font-bold text-primary dark:text-white">Failed Payments</h3>
            {failedPayments.length > 0 && (
              <span className="px-2 py-0.5 text-xs font-bold bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 rounded-full">
                {failedPayments.length}
              </span>
            )}
          </div>
          {content}
        </div>
        <ConfirmDialogComponent />
      </>
    );
  }

  return (
    <>
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-red-600 dark:text-red-400">error</span>
            <h3 className="font-bold text-primary dark:text-white">Failed Payments</h3>
            {failedPayments.length > 0 && (
              <span className="px-2 py-0.5 text-xs font-bold bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 rounded-full">
                {failedPayments.length}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
            <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
          </button>
        </div>
        {content}
      </div>
      <ConfirmDialogComponent />
    </>
  );
};

const RefundsSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const { data: payments = [], isLoading: loading } = useRefundedPayments();

  const content = loading ? (
    <div className="flex items-center justify-center py-8">
      <WalkingGolferSpinner size="sm" variant="dark" />
    </div>
  ) : payments.length === 0 ? (
    <EmptyState icon="undo" title="No refunds yet" description="Completed refunds from the last 90 days will appear here" variant="compact" />
  ) : (
    <div className="space-y-2 max-h-[300px] overflow-y-auto">
      {payments.map((payment: RefundablePayment) => (
        <div key={payment.id} className="flex items-center gap-3 p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/5 dark:border-white/10">
          <div className="w-10 h-10 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
            <span className="material-symbols-outlined text-purple-600 dark:text-purple-400 text-lg">undo</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm text-primary dark:text-white truncate">{payment.memberName || 'Unknown'}</p>
            <p className="text-xs text-primary/60 dark:text-white/60 truncate">{payment.description || 'Payment'}</p>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="font-bold text-purple-600 dark:text-purple-400">${(payment.amount / 100).toFixed(2)}</p>
            <p className="text-xs text-primary/50 dark:text-white/50">
              {new Date(payment.createdAt).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })}
            </p>
          </div>
          <span className="px-2 py-1 text-xs rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 font-medium flex-shrink-0">
            {payment.status === 'partially_refunded' ? 'Partial' : 'Refunded'}
          </span>
        </div>
      ))}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-purple-600 dark:text-purple-400">undo</span>
          <h3 className="font-bold text-primary dark:text-white">Refund History</h3>
          {payments.length > 0 && (
            <span className="px-2 py-0.5 text-xs font-bold bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 rounded-full">
              {payments.length}
            </span>
          )}
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-purple-600 dark:text-purple-400">undo</span>
          <h3 className="font-bold text-primary dark:text-white">Refund History</h3>
        </div>
        <button type="button" onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

const QuickInvoiceCard: React.FC = () => {
  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="material-symbols-outlined text-primary dark:text-lavender">description</span>
        <h3 className="font-bold text-primary dark:text-white">Quick Invoice</h3>
      </div>
      <p className="text-sm text-primary/60 dark:text-white/60 mb-4">
        Create a formal invoice for services, merchandise, or custom charges.
      </p>
      <a
        href="/admin/financials"
        className="block w-full py-3 rounded-full bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium text-center hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
      >
        Open Invoice Creator
      </a>
    </div>
  );
};

const MobileTransactionsView: React.FC = () => {
  const [activeSection, setActiveSection] = useState<'overdue' | 'transactions' | 'refunds' | 'failed' | 'summary' | 'pending' | 'future' | null>(null);
  const activeSectionRef = useRef<HTMLDivElement>(null);

  const { data: overduePayments } = useOverduePayments();
  const { data: failedPayments } = useFailedPayments();
  const { data: pendingAuthorizations } = usePendingAuthorizations();
  const { data: allFutureBookings } = useFutureBookingsWithFees();

  const overdueCount = overduePayments?.length || 0;
  const failedCount = failedPayments?.length || 0;
  const pendingCount = pendingAuthorizations?.length || 0;
  const futureBookingsCount = (allFutureBookings || []).filter(b => b.estimatedFeeCents > 0).length;

  useEffect(() => {
    if (activeSection && activeSectionRef.current) {
      setTimeout(() => {
        activeSectionRef.current?.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'start' 
        });
      }, 100);
    }
  }, [activeSection]);

  const quickActions = [
    { 
      id: 'summary' as const, 
      icon: 'summarize', 
      label: 'Summary', 
      bgClass: 'bg-emerald-100/60 dark:bg-emerald-950/40',
      textClass: 'text-emerald-900 dark:text-emerald-100',
      borderClass: 'border-emerald-200 dark:border-emerald-500/20',
      hoverClass: 'hover:bg-emerald-200/60 dark:hover:bg-emerald-900/60',
      iconClass: 'text-emerald-600 dark:text-emerald-400'
    },
    { 
      id: 'pending' as const, 
      icon: 'hourglass_top', 
      label: 'Pending', 
      bgClass: 'bg-blue-100/60 dark:bg-blue-950/40',
      textClass: 'text-blue-900 dark:text-blue-100',
      borderClass: 'border-blue-200 dark:border-blue-500/20',
      hoverClass: 'hover:bg-blue-200/60 dark:hover:bg-blue-900/60',
      iconClass: 'text-blue-600 dark:text-blue-400',
      badge: pendingCount 
    },
    { 
      id: 'overdue' as const, 
      icon: 'warning', 
      label: 'Overdue', 
      bgClass: overdueCount > 0 ? 'bg-red-100/60 dark:bg-red-950/40' : 'bg-zinc-100/60 dark:bg-zinc-800/40',
      textClass: overdueCount > 0 ? 'text-red-900 dark:text-red-100' : 'text-zinc-600 dark:text-zinc-400',
      borderClass: overdueCount > 0 ? 'border-red-200 dark:border-red-500/20' : 'border-zinc-200 dark:border-zinc-600/20',
      hoverClass: overdueCount > 0 ? 'hover:bg-red-200/60 dark:hover:bg-red-900/60' : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60',
      iconClass: overdueCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-500',
      badge: overdueCount 
    },
    { 
      id: 'failed' as const, 
      icon: 'error', 
      label: 'Failed', 
      bgClass: failedCount > 0 ? 'bg-red-100/60 dark:bg-red-950/40' : 'bg-zinc-100/60 dark:bg-zinc-800/40',
      textClass: failedCount > 0 ? 'text-red-900 dark:text-red-100' : 'text-zinc-600 dark:text-zinc-400',
      borderClass: failedCount > 0 ? 'border-red-200 dark:border-red-500/20' : 'border-zinc-200 dark:border-zinc-600/20',
      hoverClass: failedCount > 0 ? 'hover:bg-red-200/60 dark:hover:bg-red-900/60' : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60',
      iconClass: failedCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-500',
      badge: failedCount 
    },
    { 
      id: 'future' as const, 
      icon: 'event_upcoming', 
      label: 'Future', 
      bgClass: futureBookingsCount > 0 ? 'bg-green-100/60 dark:bg-green-950/40' : 'bg-zinc-100/60 dark:bg-zinc-800/40',
      textClass: futureBookingsCount > 0 ? 'text-green-900 dark:text-green-100' : 'text-zinc-600 dark:text-zinc-400',
      borderClass: futureBookingsCount > 0 ? 'border-green-200 dark:border-green-500/20' : 'border-zinc-200 dark:border-zinc-600/20',
      hoverClass: futureBookingsCount > 0 ? 'hover:bg-green-200/60 dark:hover:bg-green-900/60' : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60',
      iconClass: futureBookingsCount > 0 ? 'text-green-600 dark:text-green-400' : 'text-zinc-500 dark:text-zinc-500',
      badge: futureBookingsCount 
    },
    { 
      id: 'refunds' as const, 
      icon: 'undo', 
      label: 'Refunds', 
      bgClass: 'bg-purple-100/60 dark:bg-purple-950/40',
      textClass: 'text-purple-900 dark:text-purple-100',
      borderClass: 'border-purple-200 dark:border-purple-500/20',
      hoverClass: 'hover:bg-purple-200/60 dark:hover:bg-purple-900/60',
      iconClass: 'text-purple-600 dark:text-purple-400'
    },
    { 
      id: 'transactions' as const, 
      icon: 'receipt_long', 
      label: 'Recent', 
      bgClass: 'bg-blue-100/60 dark:bg-blue-950/40',
      textClass: 'text-blue-900 dark:text-blue-100',
      borderClass: 'border-blue-200 dark:border-blue-500/20',
      hoverClass: 'hover:bg-blue-200/60 dark:hover:bg-blue-900/60',
      iconClass: 'text-blue-600 dark:text-blue-400'
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {quickActions.map((action, index) => (
          <button
            key={action.id}
            onClick={() => setActiveSection(action.id)}
            className={`${action.bgClass} ${action.textClass} ${action.borderClass} ${action.hoverClass} border backdrop-blur-md rounded-2xl p-4 flex flex-col items-center gap-2 min-h-[100px] shadow-lg active:scale-95 transition-all duration-normal relative animate-list-item-delay-${Math.min(index, 10)}`}
          >
            <span className={`material-symbols-outlined text-3xl ${action.iconClass}`}>{action.icon}</span>
            <span className="font-semibold text-sm">{action.label}</span>
            {action.badge !== undefined && action.badge > 0 && (
              <span className="absolute top-2 right-2 min-w-[24px] h-6 px-1.5 flex items-center justify-center bg-red-500 text-white text-sm font-bold rounded-full">
                {action.badge > 99 ? '99+' : action.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      <div ref={activeSectionRef}>
        {activeSection === 'summary' && (
          <DailySummaryCard onClose={() => setActiveSection(null)} />
        )}
        {activeSection === 'overdue' && (
          <OverduePaymentsPanel onClose={() => setActiveSection(null)} />
        )}
        {activeSection === 'refunds' && (
          <RefundsSection onClose={() => setActiveSection(null)} />
        )}
        {activeSection === 'transactions' && (
          <RecentTransactionsSection onClose={() => setActiveSection(null)} />
        )}
        {activeSection === 'failed' && (
          <FailedPaymentsSection onClose={() => setActiveSection(null)} />
        )}
        {activeSection === 'pending' && (
          <PendingAuthorizationsSection onClose={() => setActiveSection(null)} />
        )}
        {activeSection === 'future' && (
          <FutureBookingsSection onClose={() => setActiveSection(null)} />
        )}
      </div>
    </div>
  );
};

const DesktopTransactionsView: React.FC = () => {
  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-6 space-y-6">
        <DailySummaryCard variant="card" />
        <RecentTransactionsSection variant="card" />
        <PendingAuthorizationsSection variant="card" />
        <FutureBookingsSection variant="card" />
      </div>
      <div className="col-span-6 space-y-6">
        <OverduePaymentsPanel variant="card" />
        <FailedPaymentsSection variant="card" />
        <RefundsSection variant="card" />
      </div>
    </div>
  );
};

const TransactionsSubTab: React.FC = () => {
  const isMobile = useIsMobile();

  return isMobile ? <MobileTransactionsView /> : <DesktopTransactionsView />;
};

export default TransactionsSubTab;
