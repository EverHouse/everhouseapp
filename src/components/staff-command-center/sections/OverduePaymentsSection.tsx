import React, { useState, useEffect, useCallback } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import EmptyState from '../../EmptyState';
import { DateBlock, GlassListRow } from '../helpers';
import { getTodayPacific } from '../../../utils/dateUtils';
import { UnifiedBookingSheet } from '../modals/UnifiedBookingSheet';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';

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

interface OverduePaymentsSectionProps {
  variant?: 'mobile' | 'desktop';
}

export const OverduePaymentsSection: React.FC<OverduePaymentsSectionProps> = ({ variant = 'mobile' }) => {
  const [paymentsRef] = useAutoAnimate();
  const [overduePayments, setOverduePayments] = useState<OverduePayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [bookingSheet, setBookingSheet] = useState<{ isOpen: boolean; bookingId: number | null }>({ isOpen: false, bookingId: null });
  const [bulkReviewing, setBulkReviewing] = useState(false);
  const [staleWaiverCount, setStaleWaiverCount] = useState(0);
  const today = getTodayPacific();
  const isDesktop = variant === 'desktop';

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

  const handleBillingComplete = useCallback(() => {
    fetchOverduePayments();
  }, [fetchOverduePayments]);

  const maxItems = isDesktop ? 6 : 4;
  const count = overduePayments.length;

  if (loading) {
    return (
      <div className={`${isDesktop ? 'h-full min-h-[280px]' : 'min-h-[200px]'} flex flex-col bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl pt-4 overflow-hidden shadow-liquid dark:shadow-liquid-dark`}>
        <div className="flex items-center justify-center flex-1">
          <WalkingGolferSpinner size="sm" variant="auto" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div 
        className={`${isDesktop ? 'h-full min-h-[280px]' : 'min-h-[200px]'} flex flex-col bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl pt-4 overflow-hidden shadow-liquid dark:shadow-liquid-dark ${count > 0 ? 'border-l-4 border-l-red-500' : ''}`}
        role="region"
        aria-label={count > 0 ? `Overdue Payments - ${count} outstanding` : 'Overdue Payments'}
      >
        <div className="flex items-center justify-between mb-3 lg:mb-4 flex-shrink-0 px-4">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-primary dark:text-white" style={{ fontFamily: 'var(--font-headline)' }}>Overdue Payments</h3>
            {count > 0 && (
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 rounded-[4px] flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">warning</span>
                {count}
              </span>
            )}
          </div>
          {staleWaiverCount > 0 && (
            <button
              onClick={handleBulkReviewWaivers}
              disabled={bulkReviewing}
              className="px-3 py-1.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-[4px] hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">check_circle</span>
              {bulkReviewing ? 'Reviewing...' : `Review All Waivers (${staleWaiverCount})`}
            </button>
          )}
        </div>

        <div ref={paymentsRef} className={`${isDesktop ? 'flex-1 overflow-y-auto pb-6' : ''}`}>
          {count === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-8 px-4">
              <EmptyState icon="payments" title="No overdue payments" description="All payments are up to date" variant="compact" />
            </div>
          ) : (
            <>
              {overduePayments.slice(0, maxItems).map(payment => (
                <GlassListRow 
                  key={payment.bookingId} 
                  onClick={() => setBookingSheet({ isOpen: true, bookingId: payment.bookingId })}
                >
                  <DateBlock dateStr={payment.bookingDate} today={today} />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-primary dark:text-white truncate">{payment.ownerName}</p>
                    <p className="text-xs text-primary/80 dark:text-white/80 truncate">
                      {payment.resourceName}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {payment.totalOutstanding > 0 ? (
                      <span className="text-sm font-bold text-red-600 dark:text-red-400">
                        ${payment.totalOutstanding.toFixed(2)}
                      </span>
                    ) : payment.unreviewedWaivers > 0 ? (
                      <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-[4px]">
                        Needs Review
                      </span>
                    ) : null}
                    <span className="material-symbols-outlined text-base text-primary/70 dark:text-white/70">chevron_right</span>
                  </div>
                </GlassListRow>
              ))}
              {count > maxItems && (
                <p className="text-xs text-center text-primary/70 dark:text-white/70 pt-2 px-4">
                  +{count - maxItems} more overdue payments
                </p>
              )}
            </>
          )}
        </div>
      </div>

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
};
