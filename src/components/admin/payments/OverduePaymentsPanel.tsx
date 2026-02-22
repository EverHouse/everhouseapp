import React, { useState, useEffect, useCallback } from 'react';
import EmptyState from '../../EmptyState';
import { UnifiedBookingSheet } from '../../staff-command-center/modals/UnifiedBookingSheet';
import { getTodayPacific } from '../../../utils/dateUtils';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';

export interface SectionProps {
  onClose?: () => void;
  variant?: 'modal' | 'card';
}

export interface OverduePayment {
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

const OverduePaymentsPanel: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [overduePayments, setOverduePayments] = useState<OverduePayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [bookingSheet, setBookingSheet] = useState<{ isOpen: boolean; bookingId: number | null }>({ isOpen: false, bookingId: null });
  const [bulkReviewing, setBulkReviewing] = useState(false);
  const [staleWaiverCount, setStaleWaiverCount] = useState(0);
  const today = getTodayPacific();

  const totalUnreviewedWaivers = overduePayments.reduce((sum, p) => sum + (p.unreviewedWaivers || 0), 0);

  const handleBulkReviewWaivers = async () => {
    if (!window.confirm(`Mark all ${staleWaiverCount} stale waivers as reviewed? This confirms the fee waivers were intentional.`)) return;
    setBulkReviewing(true);
    try {
      const res = await fetch('/api/bookings/bulk-review-all-waivers', { method: 'POST', credentials: 'include' });
      if (res.ok) {
        fetchOverduePayments();
      }
    } catch (err: unknown) {
      console.error('Failed to bulk review waivers:', err);
    } finally {
      setBulkReviewing(false);
    }
  };

  const fetchOverduePayments = useCallback(async () => {
    try {
      const [overdueRes, staleRes] = await Promise.all([
        fetch('/api/bookings/overdue-payments', { credentials: 'include' }),
        fetch('/api/bookings/stale-waivers', { credentials: 'include' }),
      ]);
      if (overdueRes.ok) {
        const data = await overdueRes.json();
        setOverduePayments(data);
      }
      if (staleRes.ok) {
        const staleData = await staleRes.json();
        setStaleWaiverCount(staleData.length);
      }
    } catch (err: unknown) {
      console.error('Failed to fetch overdue payments:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverduePayments();
  }, [fetchOverduePayments]);

  const content = loading ? (
    <div className="flex items-center justify-center py-12">
      <WalkingGolferSpinner size="sm" variant="dark" />
    </div>
  ) : overduePayments.length === 0 ? (
    <EmptyState icon="payments" title="No overdue payments" description="All payments are up to date" variant="compact" />
  ) : (
    <div className="space-y-2 max-h-[400px] overflow-y-auto">
      {overduePayments.map(payment => (
        <button
          key={payment.bookingId}
          onClick={() => setBookingSheet({ isOpen: true, bookingId: payment.bookingId })}
          className="tactile-row w-full flex items-center gap-3 p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/5 dark:border-white/10 hover:bg-primary/5 dark:hover:bg-white/10 transition-colors text-left"
        >
          <div className="flex flex-col items-center justify-center min-w-[44px] h-[44px] rounded-lg bg-red-100 dark:bg-red-900/30">
            <span className="text-[10px] font-semibold text-red-600 dark:text-red-400 uppercase">
              {new Date(payment.bookingDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', timeZone: 'America/Los_Angeles' }).toUpperCase()}
            </span>
            <span className="text-lg font-bold text-red-600 dark:text-red-400 leading-none">
              {new Date(payment.bookingDate + 'T12:00:00').getDate()}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-primary dark:text-white truncate">{payment.ownerName}</p>
            <p className="text-xs text-primary/60 dark:text-white/60 truncate">{payment.resourceName}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {payment.totalOutstanding > 0 ? (
              <span className="text-sm font-bold text-red-600 dark:text-red-400">
                ${payment.totalOutstanding.toFixed(2)}
              </span>
            ) : payment.unreviewedWaivers > 0 ? (
              <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-full">
                Review
              </span>
            ) : null}
            <span className="material-symbols-outlined text-base text-primary/40 dark:text-white/40">chevron_right</span>
          </div>
        </button>
      ))}
    </div>
  );

  const wrapper = (
    <>
      {variant === 'card' ? (
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5 min-h-[300px]">
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-red-600 dark:text-red-400">warning</span>
            <h3 className="font-bold text-primary dark:text-white">Overdue Payments</h3>
            {overduePayments.length > 0 && (
              <span className="px-2 py-0.5 text-xs font-bold bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 rounded-full">
                {overduePayments.length}
              </span>
            )}
          </div>
          {staleWaiverCount > 0 && (
            <button
              onClick={handleBulkReviewWaivers}
              disabled={bulkReviewing}
              className="tactile-btn mb-3 px-3 py-1.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-full hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">check_circle</span>
              {bulkReviewing ? 'Reviewing...' : `Review All Waivers (${staleWaiverCount})`}
            </button>
          )}
          {content}
        </div>
      ) : (
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-red-600 dark:text-red-400">warning</span>
              <h3 className="font-bold text-primary dark:text-white">Overdue Payments</h3>
              {overduePayments.length > 0 && (
                <span className="px-2 py-0.5 text-xs font-bold bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 rounded-full">
                  {overduePayments.length}
                </span>
              )}
            </div>
            <button onClick={onClose} className="tactile-btn p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
              <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
            </button>
          </div>
          {staleWaiverCount > 0 && (
            <button
              onClick={handleBulkReviewWaivers}
              disabled={bulkReviewing}
              className="tactile-btn mb-3 px-3 py-1.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-full hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">check_circle</span>
              {bulkReviewing ? 'Reviewing...' : `Review All Waivers (${staleWaiverCount})`}
            </button>
          )}
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
          fetchOverduePayments();
        }}
        onRosterUpdated={() => fetchOverduePayments()}
      />
    </>
  );

  return wrapper;
};

export default OverduePaymentsPanel;
