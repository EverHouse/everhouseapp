import React, { useState, useEffect, useCallback } from 'react';
import EmptyState from '../../EmptyState';
import { DateBlock, GlassListRow } from '../helpers';
import { getTodayPacific } from '../../../utils/dateUtils';
import { CheckinBillingModal } from '../modals/CheckinBillingModal';

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
}

interface OverduePaymentsSectionProps {
  variant?: 'mobile' | 'desktop';
}

export const OverduePaymentsSection: React.FC<OverduePaymentsSectionProps> = ({ variant = 'mobile' }) => {
  const [overduePayments, setOverduePayments] = useState<OverduePayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [billingModal, setBillingModal] = useState<{ isOpen: boolean; bookingId: number | null }>({ isOpen: false, bookingId: null });
  const today = getTodayPacific();
  const isDesktop = variant === 'desktop';

  const fetchOverduePayments = useCallback(async () => {
    try {
      const res = await fetch('/api/bookings/overdue-payments', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setOverduePayments(data);
      }
    } catch (err) {
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
      <div className={`${isDesktop ? 'h-full min-h-[280px]' : 'min-h-[200px]'} flex flex-col bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4`}>
        <div className="flex items-center justify-center flex-1">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div 
        className={`${isDesktop ? 'h-full min-h-[280px]' : 'min-h-[200px]'} flex flex-col bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4 ${count > 0 ? 'border-l-4 border-l-red-500' : ''}`}
        role="region"
        aria-label={count > 0 ? `Overdue Payments - ${count} outstanding` : 'Overdue Payments'}
      >
        <div className="flex items-center justify-between mb-3 lg:mb-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-primary dark:text-white">Overdue Payments</h3>
            {count > 0 && (
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 rounded-full flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">warning</span>
                {count}
              </span>
            )}
          </div>
        </div>

        {count === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-8">
            <EmptyState icon="payments" title="No overdue payments" description="All payments are up to date" variant="compact" />
          </div>
        ) : (
          <div className={`${isDesktop ? 'flex-1 overflow-y-auto pb-6' : ''} space-y-2`}>
            {overduePayments.slice(0, maxItems).map(payment => (
              <GlassListRow 
                key={payment.bookingId} 
                onClick={() => setBillingModal({ isOpen: true, bookingId: payment.bookingId })}
              >
                <DateBlock dateStr={payment.bookingDate} today={today} />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm text-primary dark:text-white truncate">{payment.ownerName}</p>
                  <p className="text-xs text-primary/60 dark:text-white/60 truncate">
                    {payment.resourceName}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-sm font-bold text-red-600 dark:text-red-400">
                    ${payment.totalOutstanding.toFixed(2)}
                  </span>
                  <span className="material-symbols-outlined text-base text-primary/40 dark:text-white/40">chevron_right</span>
                </div>
              </GlassListRow>
            ))}
            {count > maxItems && (
              <p className="text-xs text-center text-primary/50 dark:text-white/50 pt-2">
                +{count - maxItems} more overdue payments
              </p>
            )}
          </div>
        )}
      </div>

      <CheckinBillingModal
        isOpen={billingModal.isOpen}
        onClose={() => setBillingModal({ isOpen: false, bookingId: null })}
        bookingId={billingModal.bookingId || 0}
        onCheckinComplete={handleBillingComplete}
      />
    </>
  );
};
