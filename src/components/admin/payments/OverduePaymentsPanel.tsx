import React, { useState, useEffect, useCallback } from 'react';
import EmptyState from '../../EmptyState';
import { CheckinBillingModal } from '../../staff-command-center/modals/CheckinBillingModal';
import { getTodayPacific } from '../../../utils/dateUtils';

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
  const [billingModal, setBillingModal] = useState<{ isOpen: boolean; bookingId: number | null }>({ isOpen: false, bookingId: null });
  const today = getTodayPacific();

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

  const content = loading ? (
    <div className="flex items-center justify-center py-12">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
    </div>
  ) : overduePayments.length === 0 ? (
    <EmptyState icon="payments" title="No overdue payments" description="All payments are up to date" variant="compact" />
  ) : (
    <div className="space-y-2 max-h-[400px] overflow-y-auto">
      {overduePayments.map(payment => (
        <button
          key={payment.bookingId}
          onClick={() => setBillingModal({ isOpen: true, bookingId: payment.bookingId })}
          className="w-full flex items-center gap-3 p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/5 dark:border-white/10 hover:bg-primary/5 dark:hover:bg-white/10 transition-colors text-left"
        >
          <div className="flex flex-col items-center justify-center min-w-[44px] h-[44px] rounded-lg bg-red-100 dark:bg-red-900/30">
            <span className="text-[10px] font-semibold text-red-600 dark:text-red-400 uppercase">
              {new Date(payment.bookingDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}
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
            <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
              <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
            </button>
          </div>
          {content}
        </div>
      )}

      <CheckinBillingModal
        isOpen={billingModal.isOpen}
        onClose={() => setBillingModal({ isOpen: false, bookingId: null })}
        bookingId={billingModal.bookingId || 0}
        onCheckinComplete={fetchOverduePayments}
      />
    </>
  );

  return wrapper;
};

export default OverduePaymentsPanel;
