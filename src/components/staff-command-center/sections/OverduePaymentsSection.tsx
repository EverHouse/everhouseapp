import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import EmptyState from '../../EmptyState';
import { DateBlock, GlassListRow } from '../helpers';
import { getTodayPacific } from '../../../utils/dateUtils';
import { UnifiedBookingSheet } from '../modals/UnifiedBookingSheet';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';
import { fetchWithCredentials } from '../../../hooks/queries/useFetch';

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
  const queryClient = useQueryClient();
  const [paymentsRef] = useAutoAnimate();
  const [bookingSheet, setBookingSheet] = useState<{ isOpen: boolean; bookingId: number | null }>({ isOpen: false, bookingId: null });
  const today = getTodayPacific();
  const isDesktop = variant === 'desktop';

  const { data: overduePayments = [], isLoading: loading } = useQuery({
    queryKey: ['admin', 'overdue-payments'],
    queryFn: () => fetchWithCredentials<OverduePayment[]>('/api/bookings/overdue-payments'),
  });

  const fetchOverduePayments = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'overdue-payments'] });
  };

  const _handleBillingComplete = fetchOverduePayments;

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
            <h3 className="text-2xl leading-tight font-bold text-primary dark:text-white" style={{ fontFamily: 'var(--font-headline)' }}>Overdue Payments</h3>
            {count > 0 && (
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 rounded-[4px] flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">warning</span>
                {count}
              </span>
            )}
          </div>
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
                    {payment.totalOutstanding > 0 && (
                      <span className="text-sm font-bold text-red-600 dark:text-red-400">
                        ${payment.totalOutstanding.toFixed(2)}
                      </span>
                    )}
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
