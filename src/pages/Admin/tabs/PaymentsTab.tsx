import React, { useState, useEffect, useCallback } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import EmptyState from '../../../components/EmptyState';
import ModalShell from '../../../components/ModalShell';
import { StripePaymentForm } from '../../../components/stripe/StripePaymentForm';
import { CheckinBillingModal } from '../../../components/staff-command-center/modals/CheckinBillingModal';
import { MemberSearchInput, SelectedMember } from '../../../components/shared/MemberSearchInput';
import { getTodayPacific, formatTime12Hour } from '../../../utils/dateUtils';
import SendMembershipInvite from '../../../components/admin/payments/SendMembershipInvite';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY || '');

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

interface MemberSearchResult {
  id: number;
  email: string;
  name: string;
  membershipTier: string | null;
  stripeCustomerId: string | null;
}

interface Transaction {
  id: string;
  amount: number;
  status: string;
  description: string;
  memberEmail: string;
  memberName: string;
  createdAt: string;
  type: string;
}

interface TransactionNote {
  id: number;
  note: string;
  performedByName: string;
  createdAt: string;
}

interface MemberBalance {
  totalCents: number;
  items: Array<{
    participantId: number;
    sessionId: number;
    sessionDate: string;
    resourceName: string;
    amountCents: number;
    type: string;
  }>;
  guestPasses: {
    remaining: number;
    total: number;
    used: number;
  } | null;
  purchaseHistory: Array<{
    id: number;
    purchaseDate: string;
    itemName: string;
    totalAmount: number;
    source: string;
  }>;
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

interface DailySummary {
  date: string;
  totalCollected: number;
  breakdown: {
    guest_fee: number;
    overage: number;
    merchandise: number;
    membership: number;
    cash: number;
    check: number;
    other: number;
  };
  transactionCount: number;
}

interface DayPass {
  id: string;
  productType: string;
  quantity: number;
  remainingUses: number;
  purchaserEmail: string;
  purchaserFirstName: string | null;
  purchaserLastName: string | null;
  purchasedAt: string;
}

const PaymentsTab: React.FC = () => {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
  
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="animate-pop-in pb-32">
      {isMobile ? <MobilePaymentsView /> : <DesktopPaymentsView />}
    </div>
  );
};

const MobilePaymentsView: React.FC = () => {
  const [activeSection, setActiveSection] = useState<'quick-charge' | 'overdue' | 'lookup' | 'transactions' | 'record-payment' | 'refunds' | 'failed' | 'summary' | 'pending' | 'redeem-pass' | 'send-invite' | null>(null);
  const [overdueCount, setOverdueCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    fetch('/api/bookings/overdue-payments', { credentials: 'include' })
      .then(res => res.json())
      .then(data => setOverdueCount(data.length || 0))
      .catch(() => {});
    
    fetch('/api/payments/failed', { credentials: 'include' })
      .then(res => res.json())
      .then(data => setFailedCount(Array.isArray(data) ? data.length : 0))
      .catch(() => {});

    fetch('/api/payments/pending-authorizations', { credentials: 'include' })
      .then(res => res.json())
      .then(data => setPendingCount(Array.isArray(data) ? data.length : 0))
      .catch(() => {});
  }, []);

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
      id: 'quick-charge' as const, 
      icon: 'point_of_sale', 
      label: 'Quick Charge', 
      bgClass: 'bg-slate-100/60 dark:bg-slate-800/40',
      textClass: 'text-slate-900 dark:text-slate-100',
      borderClass: 'border-slate-200 dark:border-slate-500/20',
      hoverClass: 'hover:bg-slate-200/60 dark:hover:bg-slate-700/60',
      iconClass: 'text-slate-600 dark:text-slate-400'
    },
    { 
      id: 'record-payment' as const, 
      icon: 'savings', 
      label: 'Record Payment', 
      bgClass: 'bg-orange-100/60 dark:bg-orange-950/40',
      textClass: 'text-orange-900 dark:text-orange-100',
      borderClass: 'border-orange-200 dark:border-orange-500/20',
      hoverClass: 'hover:bg-orange-200/60 dark:hover:bg-orange-900/60',
      iconClass: 'text-orange-600 dark:text-orange-400'
    },
    { 
      id: 'redeem-pass' as const, 
      icon: 'qr_code_scanner', 
      label: 'Redeem Pass', 
      bgClass: 'bg-teal-100/60 dark:bg-teal-950/40',
      textClass: 'text-teal-900 dark:text-teal-100',
      borderClass: 'border-teal-200 dark:border-teal-500/20',
      hoverClass: 'hover:bg-teal-200/60 dark:hover:bg-teal-900/60',
      iconClass: 'text-teal-600 dark:text-teal-400'
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
      id: 'lookup' as const, 
      icon: 'person_search', 
      label: 'Member Lookup', 
      bgClass: 'bg-amber-100/60 dark:bg-amber-950/40',
      textClass: 'text-amber-900 dark:text-amber-100',
      borderClass: 'border-amber-200 dark:border-amber-500/20',
      hoverClass: 'hover:bg-amber-200/60 dark:hover:bg-amber-900/60',
      iconClass: 'text-amber-600 dark:text-amber-400'
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
    { 
      id: 'send-invite' as const, 
      icon: 'mail', 
      label: 'Send Invite', 
      bgClass: 'bg-green-100/60 dark:bg-green-950/40',
      textClass: 'text-green-900 dark:text-green-100',
      borderClass: 'border-green-200 dark:border-green-500/20',
      hoverClass: 'hover:bg-green-200/60 dark:hover:bg-green-900/60',
      iconClass: 'text-green-600 dark:text-green-400'
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {quickActions.map(action => (
          <button
            key={action.id}
            onClick={() => setActiveSection(action.id)}
            className={`${action.bgClass} ${action.textClass} ${action.borderClass} ${action.hoverClass} border backdrop-blur-md rounded-2xl p-4 flex flex-col items-center gap-2 min-h-[100px] shadow-lg active:scale-95 transition-all duration-300 relative`}
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

      {activeSection === 'summary' && (
        <DailySummaryCard onClose={() => setActiveSection(null)} />
      )}
      {activeSection === 'quick-charge' && (
        <QuickChargeSection onClose={() => setActiveSection(null)} />
      )}
      {activeSection === 'record-payment' && (
        <CashCheckPaymentSection onClose={() => setActiveSection(null)} />
      )}
      {activeSection === 'overdue' && (
        <OverduePaymentsPanel onClose={() => setActiveSection(null)} />
      )}
      {activeSection === 'refunds' && (
        <RefundsSection onClose={() => setActiveSection(null)} />
      )}
      {activeSection === 'lookup' && (
        <MemberLookupSection onClose={() => setActiveSection(null)} />
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
      {activeSection === 'redeem-pass' && (
        <RedeemDayPassSection onClose={() => setActiveSection(null)} />
      )}
      {activeSection === 'send-invite' && (
        <SendMembershipInvite onClose={() => setActiveSection(null)} />
      )}
    </div>
  );
};

const DesktopPaymentsView: React.FC = () => {
  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-4 space-y-6">
        <DailySummaryCard variant="card" />
        <QuickChargeSection variant="card" />
        <CashCheckPaymentSection variant="card" />
        <RedeemDayPassSection variant="card" />
        <SendMembershipInvite variant="card" />
      </div>
      
      <div className="col-span-4 space-y-6">
        <MemberLookupSection variant="card" />
        <RecentTransactionsSection variant="card" />
      </div>
      
      <div className="col-span-4 space-y-6">
        <PendingAuthorizationsSection variant="card" />
        <OverduePaymentsPanel variant="card" />
        <FailedPaymentsSection variant="card" />
        <RefundsSection variant="card" />
      </div>
    </div>
  );
};

interface SectionProps {
  onClose?: () => void;
  variant?: 'modal' | 'card';
}

const DailySummaryCard: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSummary = async () => {
      try {
        const res = await fetch('/api/payments/daily-summary', { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to fetch summary');
        const data = await res.json();
        setSummary(data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSummary();
  }, []);

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
    guest_fee: { label: 'Guest Fees', icon: 'person_add' },
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
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-green-600 border-t-transparent" />
        </div>
      ) : error ? (
        <div className="text-center py-4 text-red-500">{error}</div>
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

const QuickChargeSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [paymentStep, setPaymentStep] = useState<'form' | 'payment'>('form');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [isCreatingPayment, setIsCreatingPayment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleCreatePayment = async () => {
    if (!selectedMember || !amount || parseFloat(amount) <= 0) return;
    
    setIsCreatingPayment(true);
    setError(null);
    
    try {
      const amountCents = Math.round(parseFloat(amount) * 100);
      const res = await fetch('/api/stripe/staff/quick-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail: selectedMember.email,
          memberName: selectedMember.name,
          amountCents,
          description: description || 'Quick charge'
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create payment');
      }

      const data = await res.json();
      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
      setPaymentStep('payment');
    } catch (err: any) {
      setError(err.message || 'Failed to create payment');
    } finally {
      setIsCreatingPayment(false);
    }
  };

  const handlePaymentSuccess = async () => {
    if (!paymentIntentId) return;
    
    try {
      await fetch('/api/stripe/staff/quick-charge/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentIntentId })
      });
      setSuccess(true);
      setTimeout(() => {
        setSelectedMember(null);
        setAmount('');
        setDescription('');
        setPaymentStep('form');
        setSuccess(false);
        setClientSecret(null);
        setPaymentIntentId(null);
      }, 2000);
    } catch (err) {
      console.error('Confirm failed:', err);
    }
  };

  const handlePaymentError = (errorMessage: string) => {
    setError(errorMessage);
    setPaymentStep('form');
  };

  const content = (
    <div className="space-y-4">
      {success ? (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
            <span className="material-symbols-outlined text-4xl text-green-600">check_circle</span>
          </div>
          <p className="text-lg font-semibold text-primary dark:text-white">Payment Successful!</p>
        </div>
      ) : paymentStep === 'form' ? (
        <>
          <MemberSearchInput
            label="Search Member"
            placeholder="Name or email..."
            selectedMember={selectedMember}
            onSelect={(member) => setSelectedMember(member)}
            onClear={() => setSelectedMember(null)}
          />

          {selectedMember && (
            <>
              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">Amount</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60 dark:text-white/60 font-medium">$</span>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    step="0.01"
                    min="0.50"
                    className="w-full pl-8 pr-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-lg font-semibold"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">Description (optional)</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What is this charge for?"
                  className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
                  <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
                </div>
              )}

              <button
                onClick={handleCreatePayment}
                disabled={!amount || parseFloat(amount) < 0.5 || isCreatingPayment}
                className="w-full py-3.5 rounded-full bg-primary dark:bg-lavender text-white dark:text-primary font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isCreatingPayment ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                    Creating...
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined">credit_card</span>
                    Charge ${amount || '0.00'}
                  </>
                )}
              </button>
            </>
          )}
        </>
      ) : (
        <div>
          <div className="mb-4 p-3 rounded-xl bg-primary/5 dark:bg-white/5">
            <p className="text-sm text-primary/60 dark:text-white/60">Charging</p>
            <p className="text-2xl font-bold text-primary dark:text-white">${amount}</p>
            <p className="text-sm text-primary/60 dark:text-white/60 mt-1">{selectedMember?.name}</p>
          </div>
          
          {clientSecret && (
            <Elements stripe={stripePromise} options={{ clientSecret }}>
              <StripePaymentForm
                onSuccess={handlePaymentSuccess}
                onError={handlePaymentError}
                submitLabel={`Pay $${amount}`}
              />
            </Elements>
          )}
        </div>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-slate-600 dark:text-slate-400">point_of_sale</span>
          <h3 className="font-bold text-primary dark:text-white">Quick Charge</h3>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-slate-600 dark:text-slate-400">point_of_sale</span>
          <h3 className="font-bold text-primary dark:text-white">Quick Charge</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

const CashCheckPaymentSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'check' | 'other'>('cash');
  const [category, setCategory] = useState<'guest_fee' | 'overage' | 'merchandise' | 'membership' | 'other'>('other');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleRecordPayment = async () => {
    if (!selectedMember || !amount || parseFloat(amount) <= 0) return;
    
    setIsRecording(true);
    setError(null);
    
    try {
      const amountCents = Math.round(parseFloat(amount) * 100);
      const res = await fetch('/api/payments/record-offline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail: selectedMember.email,
          memberId: selectedMember.id,
          memberName: selectedMember.name,
          amountCents,
          paymentMethod,
          category,
          description: description || undefined,
          notes: notes || undefined
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to record payment');
      }

      setSuccess(true);
      setTimeout(() => {
        setSelectedMember(null);
        setAmount('');
        setPaymentMethod('cash');
        setCategory('other');
        setDescription('');
        setNotes('');
        setSuccess(false);
      }, 2500);
    } catch (err: any) {
      setError(err.message || 'Failed to record payment');
    } finally {
      setIsRecording(false);
    }
  };

  const paymentMethodOptions = [
    { value: 'cash', label: 'Cash', icon: 'payments' },
    { value: 'check', label: 'Check', icon: 'money' },
    { value: 'other', label: 'Other', icon: 'more_horiz' },
  ];

  const categoryOptions = [
    { value: 'guest_fee', label: 'Guest Fee' },
    { value: 'overage', label: 'Overage' },
    { value: 'merchandise', label: 'Merchandise' },
    { value: 'membership', label: 'Membership' },
    { value: 'other', label: 'Other' },
  ];

  const content = (
    <div className="space-y-4">
      {success ? (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
            <span className="material-symbols-outlined text-4xl text-green-600">check_circle</span>
          </div>
          <p className="text-lg font-semibold text-primary dark:text-white">Payment Recorded!</p>
          <p className="text-sm text-primary/60 dark:text-white/60">${amount} via {paymentMethod}</p>
        </div>
      ) : (
        <>
          <MemberSearchInput
            label="Search Member"
            placeholder="Name or email..."
            selectedMember={selectedMember}
            onSelect={(member) => setSelectedMember(member)}
            onClear={() => setSelectedMember(null)}
          />

          {selectedMember && (
            <>
              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">Amount</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60 dark:text-white/60 font-medium">$</span>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    step="0.01"
                    min="0.01"
                    className="w-full pl-8 pr-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-lg font-semibold"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">Payment Method</label>
                <div className="flex gap-2">
                  {paymentMethodOptions.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setPaymentMethod(opt.value as typeof paymentMethod)}
                      className={`flex-1 py-2.5 px-3 rounded-xl font-medium text-sm flex items-center justify-center gap-1.5 transition-colors ${
                        paymentMethod === opt.value
                          ? 'bg-orange-500 text-white'
                          : 'bg-white/50 dark:bg-white/5 text-primary dark:text-white border border-primary/10 dark:border-white/10'
                      }`}
                    >
                      <span className="material-symbols-outlined text-base">{opt.icon}</span>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as typeof category)}
                  className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {categoryOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What is this payment for?"
                  className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">Notes (optional)</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Additional notes..."
                  rows={2}
                  className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                />
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
                  <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
                </div>
              )}

              <button
                onClick={handleRecordPayment}
                disabled={!amount || parseFloat(amount) <= 0 || isRecording}
                className="w-full py-3.5 rounded-full bg-orange-500 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isRecording ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                    Recording...
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined">savings</span>
                    Record ${amount || '0.00'} Payment
                  </>
                )}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-orange-600 dark:text-orange-400">savings</span>
          <h3 className="font-bold text-primary dark:text-white">Record Cash/Check</h3>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-orange-600 dark:text-orange-400">savings</span>
          <h3 className="font-bold text-primary dark:text-white">Record Cash/Check</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

const formatPassType = (productType: string): string => {
  return productType
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace('Day Pass', 'Day Pass -');
};

const RedeemDayPassSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [searchEmail, setSearchEmail] = useState('');
  const [passes, setPasses] = useState<DayPass[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!searchEmail.trim()) return;
    
    setIsSearching(true);
    setError(null);
    setSuccessMessage(null);
    
    try {
      const res = await fetch(`/api/staff/passes/search?email=${encodeURIComponent(searchEmail.trim())}`, {
        credentials: 'include'
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to search passes');
      }
      
      const data = await res.json();
      setPasses(data.passes || []);
      setHasSearched(true);
    } catch (err: any) {
      setError(err.message || 'Failed to search passes');
    } finally {
      setIsSearching(false);
    }
  };

  const handleRedeem = async (passId: string) => {
    setRedeemingId(passId);
    setError(null);
    setSuccessMessage(null);
    
    try {
      const res = await fetch(`/api/staff/passes/${passId}/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to redeem pass');
      }
      
      const data = await res.json();
      setSuccessMessage(`Pass redeemed! ${data.remainingUses} uses remaining.`);
      
      handleSearch();
    } catch (err: any) {
      setError(err.message || 'Failed to redeem pass');
    } finally {
      setRedeemingId(null);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const content = (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          type="email"
          value={searchEmail}
          onChange={(e) => setSearchEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Enter visitor email..."
          className="flex-1 px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <button
          onClick={handleSearch}
          disabled={!searchEmail.trim() || isSearching}
          className="px-5 py-3 rounded-xl bg-teal-500 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isSearching ? (
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
          ) : (
            <span className="material-symbols-outlined text-lg">search</span>
          )}
          Search
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      {successMessage && (
        <div className="p-3 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30 flex items-center gap-2">
          <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
          <p className="text-sm text-green-700 dark:text-green-400">{successMessage}</p>
        </div>
      )}

      {!hasSearched ? (
        <div className="text-center py-8">
          <span className="material-symbols-outlined text-4xl text-primary/30 dark:text-white/30 mb-2">qr_code_scanner</span>
          <p className="text-sm text-primary/60 dark:text-white/60">Search by email to find active passes</p>
        </div>
      ) : passes.length === 0 ? (
        <div className="text-center py-8">
          <span className="material-symbols-outlined text-4xl text-primary/30 dark:text-white/30 mb-2">search_off</span>
          <p className="text-sm text-primary/60 dark:text-white/60">No active passes found for this email</p>
        </div>
      ) : (
        <div className="space-y-3 max-h-[350px] overflow-y-auto">
          {passes.map(pass => (
            <div
              key={pass.id}
              className="p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/10 dark:border-white/10"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-primary dark:text-white">
                    {formatPassType(pass.productType)}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="px-2 py-0.5 text-xs font-medium bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300 rounded-full">
                      {pass.remainingUses} {pass.remainingUses === 1 ? 'use' : 'uses'} remaining
                    </span>
                  </div>
                  <p className="text-xs text-primary/60 dark:text-white/60 mt-2">
                    Purchased: {formatDate(pass.purchasedAt)}
                  </p>
                  {(pass.purchaserFirstName || pass.purchaserLastName) && (
                    <p className="text-xs text-primary/60 dark:text-white/60">
                      {[pass.purchaserFirstName, pass.purchaserLastName].filter(Boolean).join(' ')}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => handleRedeem(pass.id)}
                  disabled={redeemingId === pass.id}
                  className="px-4 py-2 rounded-lg bg-teal-500 text-white font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 flex-shrink-0"
                >
                  {redeemingId === pass.id ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                  ) : (
                    <span className="material-symbols-outlined text-base">check</span>
                  )}
                  Redeem
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-teal-600 dark:text-teal-400">qr_code_scanner</span>
          <h3 className="font-bold text-primary dark:text-white">Redeem Day Pass</h3>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-teal-600 dark:text-teal-400">qr_code_scanner</span>
          <h3 className="font-bold text-primary dark:text-white">Redeem Day Pass</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

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

const MemberLookupSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  const [memberBalance, setMemberBalance] = useState<MemberBalance | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [showAdjustForm, setShowAdjustForm] = useState(false);
  const [adjustmentAmount, setAdjustmentAmount] = useState(0);
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);

  const loadMemberBalance = useCallback(async (email: string, tier: string | null) => {
    setIsLoadingBalance(true);
    try {
      const [balanceRes, passesRes, historyRes] = await Promise.all([
        fetch(`/api/staff/member-balance/${encodeURIComponent(email)}`, { credentials: 'include' }),
        fetch(`/api/guest-passes/${encodeURIComponent(email)}?tier=${tier || ''}`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(email)}/unified-purchases`, { credentials: 'include' })
      ]);

      const balanceData = balanceRes.ok ? await balanceRes.json() : { totalCents: 0, items: [] };
      const passesData = passesRes.ok ? await passesRes.json() : null;
      const historyData = historyRes.ok ? await historyRes.json() : [];

      setMemberBalance({
        totalCents: balanceData.totalCents || 0,
        items: balanceData.items || [],
        guestPasses: passesData ? {
          remaining: passesData.passes_remaining || 0,
          total: passesData.passes_total || 0,
          used: passesData.passes_used || 0
        } : null,
        purchaseHistory: historyData
      });
    } catch (err) {
      console.error('Failed to load member balance:', err);
    } finally {
      setIsLoadingBalance(false);
    }
  }, []);

  useEffect(() => {
    if (selectedMember) {
      loadMemberBalance(selectedMember.email, selectedMember.tier);
    }
  }, [selectedMember, loadMemberBalance]);

  const handleAdjustGuestPasses = async () => {
    if (!selectedMember || adjustmentAmount === 0 || !adjustmentReason.trim()) return;
    
    setIsAdjusting(true);
    setAdjustError(null);
    
    try {
      const res = await fetch('/api/payments/adjust-guest-passes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberId: selectedMember.id,
          memberEmail: selectedMember.email,
          memberName: selectedMember.name,
          adjustment: adjustmentAmount,
          reason: adjustmentReason.trim()
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to adjust guest passes');
      }

      setShowAdjustForm(false);
      setAdjustmentAmount(0);
      setAdjustmentReason('');
      loadMemberBalance(selectedMember.email, selectedMember.tier);
    } catch (err: any) {
      setAdjustError(err.message || 'Failed to adjust guest passes');
    } finally {
      setIsAdjusting(false);
    }
  };

  const cancelAdjustment = () => {
    setShowAdjustForm(false);
    setAdjustmentAmount(0);
    setAdjustmentReason('');
    setAdjustError(null);
  };

  const content = (
    <div className="space-y-4">
      <MemberSearchInput
        placeholder="Search by name or email..."
        selectedMember={selectedMember}
        onSelect={(member) => setSelectedMember(member)}
        onClear={() => {
          setSelectedMember(null);
          setMemberBalance(null);
        }}
      />

      {selectedMember && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/5 dark:bg-white/5 border border-primary/10 dark:border-white/10">
            <div className="w-12 h-12 rounded-full bg-primary/10 dark:bg-lavender/20 flex items-center justify-center">
              <span className="text-xl text-primary dark:text-lavender font-semibold">
                {selectedMember.name?.charAt(0)?.toUpperCase() || '?'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-primary dark:text-white truncate">{selectedMember.name}</p>
              <p className="text-sm text-primary/60 dark:text-white/60 truncate">{selectedMember.email}</p>
              {selectedMember.tier && (
                <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium bg-lavender/20 text-primary dark:text-lavender rounded-full">
                  {selectedMember.tier}
                </span>
              )}
            </div>
          </div>

          {isLoadingBalance ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
            </div>
          ) : memberBalance && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/5 dark:border-white/10">
                  <p className="text-xs text-primary/60 dark:text-white/60">Outstanding Balance</p>
                  <p className={`text-xl font-bold ${memberBalance.totalCents > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    ${(memberBalance.totalCents / 100).toFixed(2)}
                  </p>
                </div>
                <div className="p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/5 dark:border-white/10">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-primary/60 dark:text-white/60">Guest Passes</p>
                    <button
                      onClick={() => setShowAdjustForm(true)}
                      className="text-xs text-primary dark:text-lavender hover:underline font-medium"
                    >
                      Adjust
                    </button>
                  </div>
                  <p className="text-xl font-bold text-primary dark:text-white">
                    {memberBalance.guestPasses ? `${memberBalance.guestPasses.remaining}/${memberBalance.guestPasses.total}` : '0/0'}
                  </p>
                </div>
              </div>

              {showAdjustForm && (
                <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 space-y-3">
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">Adjust Guest Passes</p>
                  
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setAdjustmentAmount(prev => prev - 1)}
                      className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                    >
                      <span className="material-symbols-outlined">remove</span>
                    </button>
                    <div className="flex-1 text-center">
                      <span className={`text-2xl font-bold ${adjustmentAmount > 0 ? 'text-green-600' : adjustmentAmount < 0 ? 'text-red-600' : 'text-primary dark:text-white'}`}>
                        {adjustmentAmount > 0 ? '+' : ''}{adjustmentAmount}
                      </span>
                    </div>
                    <button
                      onClick={() => setAdjustmentAmount(prev => prev + 1)}
                      className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 flex items-center justify-center hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
                    >
                      <span className="material-symbols-outlined">add</span>
                    </button>
                  </div>

                  <input
                    type="text"
                    value={adjustmentReason}
                    onChange={(e) => setAdjustmentReason(e.target.value)}
                    placeholder="Reason for adjustment (required)"
                    className="w-full px-3 py-2 rounded-lg bg-white dark:bg-white/10 border border-amber-300 dark:border-amber-700 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-amber-400 text-sm"
                  />

                  {adjustError && (
                    <p className="text-xs text-red-600 dark:text-red-400">{adjustError}</p>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={cancelAdjustment}
                      disabled={isAdjusting}
                      className="flex-1 py-2 rounded-full bg-white dark:bg-white/10 text-primary dark:text-white text-sm font-medium hover:bg-primary/5 dark:hover:bg-white/20 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAdjustGuestPasses}
                      disabled={adjustmentAmount === 0 || !adjustmentReason.trim() || isAdjusting}
                      className="flex-1 py-2 rounded-full bg-amber-500 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                    >
                      {isAdjusting ? (
                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                      ) : (
                        'Save'
                      )}
                    </button>
                  </div>
                </div>
              )}

              {memberBalance.purchaseHistory.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wide mb-2">Recent Purchases</p>
                  <div className="space-y-1.5">
                    {memberBalance.purchaseHistory.slice(0, 3).map(purchase => (
                      <div key={purchase.id} className="flex items-center justify-between p-2 rounded-lg bg-white/30 dark:bg-white/5">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-primary dark:text-white truncate">{purchase.itemName}</p>
                          <p className="text-xs text-primary/50 dark:text-white/50">
                            {new Date(purchase.purchaseDate).toLocaleDateString()}
                          </p>
                        </div>
                        <span className="text-sm font-semibold text-primary dark:text-white">
                          ${purchase.totalAmount.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">person_search</span>
          <h3 className="font-bold text-primary dark:text-white">Member Lookup</h3>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">person_search</span>
          <h3 className="font-bold text-primary dark:text-white">Member Lookup</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

const RecentTransactionsSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
  const [notes, setNotes] = useState<TransactionNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    const fetchTransactions = async () => {
      try {
        const res = await fetch('/api/stripe/transactions/today', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setTransactions(data);
        }
      } catch (err) {
        console.error('Failed to fetch transactions:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchTransactions();
  }, []);

  const fetchNotes = async (txId: string) => {
    setNotesLoading(true);
    try {
      const res = await fetch(`/api/payments/${txId}/notes`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setNotes(data.notes || []);
      }
    } catch (err) {
      console.error('Failed to fetch notes:', err);
    } finally {
      setNotesLoading(false);
    }
  };

  const handleOpenNotes = (txId: string) => {
    setSelectedTxId(txId);
    setNewNote('');
    fetchNotes(txId);
  };

  const handleCloseNotes = () => {
    setSelectedTxId(null);
    setNotes([]);
    setNewNote('');
  };

  const handleSaveNote = async () => {
    if (!selectedTxId || !newNote.trim()) return;
    
    setSavingNote(true);
    try {
      const res = await fetch('/api/payments/add-note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          transactionId: selectedTxId,
          note: newNote.trim()
        })
      });

      if (res.ok) {
        setNewNote('');
        await fetchNotes(selectedTxId);
      }
    } catch (err) {
      console.error('Failed to save note:', err);
    } finally {
      setSavingNote(false);
    }
  };

  const content = loading ? (
    <div className="flex items-center justify-center py-8">
      <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
    </div>
  ) : transactions.length === 0 ? (
    <EmptyState icon="receipt_long" title="No transactions today" description="Payments will appear here as they're processed" variant="compact" />
  ) : (
    <div className="space-y-2 max-h-[300px] overflow-y-auto">
      {transactions.map(tx => (
        <div key={tx.id} className="flex items-center gap-3 p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/5 dark:border-white/10">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
            tx.status === 'succeeded' ? 'bg-green-100 dark:bg-green-900/30' : 
            tx.status === 'pending' ? 'bg-amber-100 dark:bg-amber-900/30' : 
            'bg-red-100 dark:bg-red-900/30'
          }`}>
            <span className={`material-symbols-outlined ${
              tx.status === 'succeeded' ? 'text-green-600' : 
              tx.status === 'pending' ? 'text-amber-600' : 
              'text-red-600'
            }`}>
              {tx.status === 'succeeded' ? 'check_circle' : tx.status === 'pending' ? 'schedule' : 'error'}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm text-primary dark:text-white truncate">{tx.memberName}</p>
            <p className="text-xs text-primary/60 dark:text-white/60 truncate">{tx.description || tx.type}</p>
          </div>
          <button
            onClick={() => handleOpenNotes(tx.id)}
            className="p-1.5 rounded-full hover:bg-primary/10 dark:hover:bg-white/10 transition-colors flex-shrink-0"
            title="View/Add Notes"
          >
            <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-lg">sticky_note_2</span>
          </button>
          <div className="text-right flex-shrink-0">
            <p className="font-bold text-primary dark:text-white">${(tx.amount / 100).toFixed(2)}</p>
            <p className="text-xs text-primary/50 dark:text-white/50">
              {new Date(tx.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </p>
          </div>
        </div>
      ))}

      {selectedTxId && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={handleCloseNotes}>
          <div 
            className="bg-white dark:bg-surface-dark rounded-2xl w-full max-w-md shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-primary/10 dark:border-white/10">
              <h3 className="font-bold text-primary dark:text-white">Payment Notes</h3>
              <button
                onClick={handleCloseNotes}
                className="p-2 rounded-full hover:bg-primary/10 dark:hover:bg-white/10"
              >
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
              </button>
            </div>
            
            <div className="p-4 space-y-4">
              <div className="max-h-48 overflow-y-auto space-y-2">
                {notesLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
                  </div>
                ) : notes.length === 0 ? (
                  <p className="text-sm text-primary/50 dark:text-white/50 text-center py-4">No notes yet</p>
                ) : (
                  notes.map(note => (
                    <div key={note.id} className="p-3 rounded-lg bg-primary/5 dark:bg-white/5">
                      <p className="text-sm text-primary dark:text-white">{note.note}</p>
                      <p className="text-xs text-primary/50 dark:text-white/50 mt-1">
                        {note.performedByName} · {new Date(note.createdAt).toLocaleString()}
                      </p>
                    </div>
                  ))
                )}
              </div>

              <div className="space-y-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  rows={2}
                  className="w-full px-3 py-2 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm resize-none"
                />
                <button
                  onClick={handleSaveNote}
                  disabled={!newNote.trim() || savingNote}
                  className="w-full py-2.5 rounded-full bg-primary dark:bg-lavender text-white dark:text-primary font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {savingNote ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-lg">add</span>
                      Add Note
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">receipt_long</span>
          <h3 className="font-bold text-primary dark:text-white">Today's Transactions</h3>
          {transactions.length > 0 && (
            <span className="px-2 py-0.5 text-xs font-bold bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded-full">
              {transactions.length}
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
          <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">receipt_long</span>
          <h3 className="font-bold text-primary dark:text-white">Today's Transactions</h3>
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
  const [authorizations, setAuthorizations] = useState<PendingAuthorization[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAuth, setSelectedAuth] = useState<PendingAuthorization | null>(null);
  const [actionType, setActionType] = useState<'capture' | 'void' | null>(null);
  const [captureAmount, setCaptureAmount] = useState('');
  const [isPartialCapture, setIsPartialCapture] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const fetchAuthorizations = async () => {
    try {
      const res = await fetch('/api/payments/pending-authorizations', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setAuthorizations(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch pending authorizations:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuthorizations();
  }, []);

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
    
    setIsProcessing(true);
    setError(null);
    
    try {
      const amountCents = isPartialCapture && captureAmount 
        ? Math.round(parseFloat(captureAmount) * 100)
        : undefined;
      
      const res = await fetch('/api/payments/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          paymentIntentId: selectedAuth.paymentIntentId,
          amountCents
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to capture payment');
      }

      setSuccess(true);
      setTimeout(() => {
        resetModal();
        fetchAuthorizations();
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to capture payment');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleVoid = async () => {
    if (!selectedAuth) return;
    
    setIsProcessing(true);
    setError(null);
    
    try {
      const res = await fetch('/api/payments/void-authorization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          paymentIntentId: selectedAuth.paymentIntentId,
          reason: voidReason || 'No reason provided'
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to void authorization');
      }

      setSuccess(true);
      setTimeout(() => {
        resetModal();
        fetchAuthorizations();
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to void authorization');
    } finally {
      setIsProcessing(false);
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
      <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent" />
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
                    minute: '2-digit'
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
                    className="px-2 py-1 text-xs font-medium text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 rounded-lg transition-colors"
                  >
                    Capture
                  </button>
                  <button
                    onClick={() => {
                      setSelectedAuth(auth);
                      setActionType('void');
                    }}
                    className="px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors"
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
                    className="p-2 rounded-full hover:bg-primary/10 dark:hover:bg-white/10"
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
                    className="flex-1 py-3 rounded-full bg-white dark:bg-white/10 text-primary dark:text-white font-medium border border-primary/20 dark:border-white/20 hover:bg-primary/5 dark:hover:bg-white/20 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={actionType === 'capture' ? handleCapture : handleVoid}
                    disabled={isProcessing || (actionType === 'capture' && isPartialCapture && (!captureAmount || parseFloat(captureAmount) <= 0))}
                    className={`flex-1 py-3 rounded-full font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
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

const FailedPaymentsSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [failedPayments, setFailedPayments] = useState<FailedPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);

  useEffect(() => {
    const fetchFailedPayments = async () => {
      try {
        const res = await fetch('/api/payments/failed', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setFailedPayments(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        console.error('Failed to fetch failed payments:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchFailedPayments();
  }, []);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'failed':
        return { label: 'Failed', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400' };
      case 'canceled':
        return { label: 'Canceled', className: 'bg-gray-100 dark:bg-gray-800/40 text-gray-700 dark:text-gray-400' };
      case 'requires_action':
        return { label: 'Action Required', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400' };
      case 'requires_payment_method':
        return { label: 'No Payment Method', className: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400' };
      default:
        return { label: status, className: 'bg-gray-100 dark:bg-gray-800/40 text-gray-700 dark:text-gray-400' };
    }
  };

  const handleContactMember = (email: string) => {
    setSelectedEmail(email);
  };

  const content = loading ? (
    <div className="flex items-center justify-center py-8">
      <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
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
        const badge = getStatusBadge(payment.status);
        return (
          <div key={payment.id} className="p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-red-100 dark:border-red-900/20">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                <span className="material-symbols-outlined text-red-600 dark:text-red-400">error</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm text-primary dark:text-white">{payment.memberName}</p>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${badge.className}`}>
                    {badge.label}
                  </span>
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
                    minute: '2-digit'
                  })}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-bold text-red-600 dark:text-red-400">${(payment.amount / 100).toFixed(2)}</p>
                <button
                  onClick={() => handleContactMember(payment.memberEmail)}
                  className="mt-1 px-2 py-1 text-xs font-medium text-primary dark:text-lavender hover:bg-primary/10 dark:hover:bg-white/10 rounded-lg transition-colors flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">mail</span>
                  Contact
                </button>
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
                className="p-2 rounded-full hover:bg-primary/10 dark:hover:bg-white/10"
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
    );
  }

  return (
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
  );
};

interface RefundablePayment {
  id: number;
  paymentIntentId: string;
  memberEmail: string;
  memberName: string;
  amount: number;
  description: string;
  createdAt: string;
  status: string;
}

const RefundsSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [payments, setPayments] = useState<RefundablePayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPayment, setSelectedPayment] = useState<RefundablePayment | null>(null);
  const [isPartialRefund, setIsPartialRefund] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const fetchRefundable = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/payments/refundable', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setPayments(data);
      }
    } catch (err) {
      console.error('Failed to fetch refundable payments:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRefundable();
  }, [fetchRefundable]);

  const handleRefund = async () => {
    if (!selectedPayment) return;
    
    setIsProcessing(true);
    setError(null);
    
    try {
      const amountCents = isPartialRefund && refundAmount 
        ? Math.round(parseFloat(refundAmount) * 100) 
        : null;
      
      if (isPartialRefund && amountCents && amountCents > selectedPayment.amount) {
        setError('Refund amount cannot exceed original payment amount');
        setIsProcessing(false);
        return;
      }

      const res = await fetch('/api/payments/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          paymentIntentId: selectedPayment.paymentIntentId,
          amountCents,
          reason: refundReason || 'No reason provided'
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to process refund');
      }

      setSuccess(true);
      setTimeout(() => {
        setSelectedPayment(null);
        setIsPartialRefund(false);
        setRefundAmount('');
        setRefundReason('');
        setSuccess(false);
        fetchRefundable();
      }, 2000);
    } catch (err: any) {
      setError(err.message || 'Failed to process refund');
    } finally {
      setIsProcessing(false);
    }
  };

  const reasonOptions = [
    'Customer request',
    'Duplicate charge',
    'Service not provided',
    'Billing error',
    'Other'
  ];

  const content = loading ? (
    <div className="flex items-center justify-center py-8">
      <div className="animate-spin rounded-full h-6 w-6 border-2 border-purple-500 border-t-transparent" />
    </div>
  ) : selectedPayment ? (
    success ? (
      <div className="flex flex-col items-center justify-center py-8 gap-3">
        <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
          <span className="material-symbols-outlined text-4xl text-green-600">check_circle</span>
        </div>
        <p className="text-lg font-semibold text-primary dark:text-white">Refund Processed!</p>
      </div>
    ) : (
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-3 rounded-xl bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800/30">
          <div className="w-10 h-10 rounded-full bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center">
            <span className="text-purple-600 dark:text-purple-400 font-semibold">
              {selectedPayment.memberName?.charAt(0)?.toUpperCase() || '?'}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-primary dark:text-white truncate">{selectedPayment.memberName}</p>
            <p className="text-xs text-primary/60 dark:text-white/60 truncate">{selectedPayment.description}</p>
          </div>
          <div className="text-right">
            <p className="font-bold text-primary dark:text-white">${(selectedPayment.amount / 100).toFixed(2)}</p>
            <p className="text-xs text-primary/50 dark:text-white/50">
              {new Date(selectedPayment.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/10 dark:border-white/10">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={!isPartialRefund}
              onChange={() => {
                setIsPartialRefund(false);
                setRefundAmount('');
              }}
              className="w-4 h-4 text-purple-500 accent-purple-500"
            />
            <span className="text-sm text-primary dark:text-white">Full Refund</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={isPartialRefund}
              onChange={() => setIsPartialRefund(true)}
              className="w-4 h-4 text-purple-500 accent-purple-500"
            />
            <span className="text-sm text-primary dark:text-white">Partial Refund</span>
          </label>
        </div>

        {isPartialRefund && (
          <div>
            <label className="block text-sm font-medium text-primary dark:text-white mb-2">Refund Amount</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60 dark:text-white/60 font-medium">$</span>
              <input
                type="number"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                placeholder="0.00"
                step="0.01"
                min="0.01"
                max={(selectedPayment.amount / 100).toFixed(2)}
                className="w-full pl-8 pr-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-purple-400 text-lg font-semibold"
              />
            </div>
            <p className="text-xs text-primary/50 dark:text-white/50 mt-1">
              Maximum: ${(selectedPayment.amount / 100).toFixed(2)}
            </p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-primary dark:text-white mb-2">Reason</label>
          <select
            value={refundReason}
            onChange={(e) => setRefundReason(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-400"
          >
            <option value="">Select a reason...</option>
            {reasonOptions.map(reason => (
              <option key={reason} value={reason}>{reason}</option>
            ))}
          </select>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => {
              setSelectedPayment(null);
              setIsPartialRefund(false);
              setRefundAmount('');
              setRefundReason('');
              setError(null);
            }}
            className="flex-1 py-3 rounded-full bg-white dark:bg-white/10 text-primary dark:text-white font-medium border border-primary/20 dark:border-white/20 hover:bg-primary/5 dark:hover:bg-white/20 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleRefund}
            disabled={isProcessing || (isPartialRefund && (!refundAmount || parseFloat(refundAmount) <= 0))}
            className="flex-1 py-3 rounded-full bg-purple-500 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <>
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                Processing...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-lg">undo</span>
                Confirm Refund
              </>
            )}
          </button>
        </div>
      </div>
    )
  ) : payments.length === 0 ? (
    <EmptyState icon="undo" title="No refundable payments" description="Succeeded payments from the last 30 days will appear here" variant="compact" />
  ) : (
    <div className="space-y-2 max-h-[300px] overflow-y-auto">
      {payments.map(payment => (
        <div key={payment.id} className="flex items-center gap-3 p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/5 dark:border-white/10">
          <div className="w-10 h-10 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
            <span className="text-purple-600 dark:text-purple-400 font-semibold text-sm">
              {payment.memberName?.charAt(0)?.toUpperCase() || '?'}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm text-primary dark:text-white truncate">{payment.memberName || 'Unknown'}</p>
            <p className="text-xs text-primary/60 dark:text-white/60 truncate">{payment.description || 'Payment'}</p>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="font-bold text-primary dark:text-white">${(payment.amount / 100).toFixed(2)}</p>
            <p className="text-xs text-primary/50 dark:text-white/50">
              {new Date(payment.createdAt).toLocaleDateString()}
            </p>
          </div>
          <button
            onClick={() => setSelectedPayment(payment)}
            className="px-3 py-1.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-sm font-medium hover:bg-purple-200 dark:hover:bg-purple-900/50 transition-colors flex-shrink-0"
          >
            Refund
          </button>
        </div>
      ))}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-purple-600 dark:text-purple-400">undo</span>
          <h3 className="font-bold text-primary dark:text-white">Refunds</h3>
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
          <h3 className="font-bold text-primary dark:text-white">Refunds</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
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
        href="/admin?tab=billing"
        className="block w-full py-3 rounded-full bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium text-center hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
      >
        Open Invoice Creator
      </a>
    </div>
  );
};

export default PaymentsTab;
