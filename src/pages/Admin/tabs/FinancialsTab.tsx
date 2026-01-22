import React, { useState, useEffect, useCallback, useRef } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import EmptyState from '../../../components/EmptyState';
import ModalShell from '../../../components/ModalShell';
import { StripePaymentForm } from '../../../components/stripe/StripePaymentForm';
import { CheckinBillingModal } from '../../../components/staff-command-center/modals/CheckinBillingModal';
import { MemberSearchInput, SelectedMember } from '../../../components/shared/MemberSearchInput';
import { getTodayPacific, formatTime12Hour } from '../../../utils/dateUtils';
import RecordPurchaseCard from '../../../components/admin/payments/RecordPurchaseCard';
import RedeemDayPassSection from '../../../components/admin/payments/RedeemPassCard';
import RecentTransactionsSection from '../../../components/admin/payments/TransactionList';
import OverduePaymentsPanel from '../../../components/admin/payments/OverduePaymentsPanel';
import { useIsMobile } from '../../../hooks/useBreakpoint';
import { AnimatedPage } from '../../../components/motion';

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

interface SubscriptionListItem {
  id: string;
  memberEmail: string;
  memberName: string;
  planName: string;
  amount: number;
  currency: string;
  interval: string;
  status: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
}

interface InvoiceListItem {
  id: string;
  memberEmail: string;
  memberName: string;
  number: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: string;
  created: number;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

const FinancialsTab: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'POS' | 'Subscriptions' | 'Invoices'>('POS');
  const isMobile = useIsMobile();

  return (
    <AnimatedPage className="pb-32">
      {/* Sub-tab Navigation */}
      <div className="flex gap-2 mb-6 animate-content-enter-delay-1">
        <button
          onClick={() => setActiveTab('POS')}
          className={`px-4 py-2 rounded-full font-medium transition-colors ${
            activeTab === 'POS'
              ? 'bg-primary dark:bg-accent text-white dark:text-primary'
              : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60'
          }`}
        >
          POS
        </button>
        <button
          onClick={() => setActiveTab('Subscriptions')}
          className={`px-4 py-2 rounded-full font-medium transition-colors ${
            activeTab === 'Subscriptions'
              ? 'bg-primary dark:bg-accent text-white dark:text-primary'
              : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60'
          }`}
        >
          Subscriptions
        </button>
        <button
          onClick={() => setActiveTab('Invoices')}
          className={`px-4 py-2 rounded-full font-medium transition-colors ${
            activeTab === 'Invoices'
              ? 'bg-primary dark:bg-accent text-white dark:text-primary'
              : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60'
          }`}
        >
          Invoices
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'POS' && (
        <>
          {isMobile ? <MobilePaymentsView /> : <DesktopPaymentsView />}
        </>
      )}
      {activeTab === 'Subscriptions' && <SubscriptionsSubTab />}
      {activeTab === 'Invoices' && <InvoicesSubTab />}
    </AnimatedPage>
  );
};

const MobilePaymentsView: React.FC = () => {
  const [activeSection, setActiveSection] = useState<'record-purchase' | 'overdue' | 'transactions' | 'refunds' | 'failed' | 'summary' | 'pending' | 'redeem-pass' | null>(null);
  const [overdueCount, setOverdueCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const activeSectionRef = useRef<HTMLDivElement>(null);

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
      id: 'record-purchase' as const, 
      icon: 'point_of_sale', 
      label: 'Record Purchase', 
      bgClass: 'bg-slate-100/60 dark:bg-slate-800/40',
      textClass: 'text-slate-900 dark:text-slate-100',
      borderClass: 'border-slate-200 dark:border-slate-500/20',
      hoverClass: 'hover:bg-slate-200/60 dark:hover:bg-slate-700/60',
      iconClass: 'text-slate-600 dark:text-slate-400'
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
            className={`${action.bgClass} ${action.textClass} ${action.borderClass} ${action.hoverClass} border backdrop-blur-md rounded-2xl p-4 flex flex-col items-center gap-2 min-h-[100px] shadow-lg active:scale-95 transition-all duration-300 relative animate-list-item-delay-${Math.min(index, 10)}`}
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
        {activeSection === 'record-purchase' && (
          <RecordPurchaseCard onClose={() => setActiveSection(null)} />
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
        {activeSection === 'redeem-pass' && (
          <RedeemDayPassSection onClose={() => setActiveSection(null)} />
        )}
      </div>
    </div>
  );
};

const DesktopPaymentsView: React.FC = () => {
  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-6 space-y-6">
        <DailySummaryCard variant="card" />
        <div className="relative z-20 focus-within:z-50">
          <RecordPurchaseCard variant="card" />
        </div>
        <RedeemDayPassSection variant="card" />
      </div>
      
      <div className="col-span-6 space-y-6">
        <div className="relative z-10">
          <RecentTransactionsSection variant="card" />
        </div>
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

const MAX_RETRY_ATTEMPTS = 3;

const FailedPaymentsSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [failedPayments, setFailedPayments] = useState<FailedPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [retryingPaymentId, setRetryingPaymentId] = useState<string | null>(null);

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

  useEffect(() => {
    fetchFailedPayments();
  }, []);

  const handleRetryPayment = async (paymentIntentId: string) => {
    setRetryingPaymentId(paymentIntentId);
    try {
      const res = await fetch('/api/payments/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentIntentId })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await fetchFailedPayments();
      } else {
        console.error('Retry failed:', data.error);
      }
    } catch (err) {
      console.error('Error retrying payment:', err);
    } finally {
      setRetryingPaymentId(null);
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
                    minute: '2-digit'
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
                      className="px-2 py-1 text-xs font-medium text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30 hover:bg-green-200 dark:hover:bg-green-900/50 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
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
                    onClick={() => handleContactMember(payment.memberEmail)}
                    className="px-2 py-1 text-xs font-medium text-primary dark:text-lavender hover:bg-primary/10 dark:hover:bg-white/10 rounded-lg transition-colors flex items-center gap-1"
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

const SubscriptionsSubTab: React.FC = () => {
  const [subscriptions, setSubscriptions] = useState<SubscriptionListItem[]>([]);
  const [filteredSubscriptions, setFilteredSubscriptions] = useState<SubscriptionListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'past_due' | 'canceled'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sendingReminder, setSendingReminder] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ created: number; updated: number; skipped: number } | null>(null);

  const handleSyncFromStripe = async () => {
    setIsSyncing(true);
    setSyncResult(null);
    setError(null);
    try {
      const res = await fetch('/api/stripe/sync-subscriptions', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to sync from Stripe');
      }
      const data = await res.json();
      setSyncResult({ created: data.created, updated: data.updated, skipped: data.skipped });
      setSuccessMessage(`Synced from Stripe: ${data.created} created, ${data.updated} updated`);
      setTimeout(() => setSuccessMessage(null), 5000);
      fetchSubscriptions();
    } catch (err: any) {
      setError(err.message);
      setTimeout(() => setError(null), 5000);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    fetchSubscriptions();
  }, [statusFilter]);

  useEffect(() => {
    let filtered = subscriptions;
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(sub => 
        sub.memberName.toLowerCase().includes(query) ||
        sub.memberEmail.toLowerCase().includes(query)
      );
    }
    
    setFilteredSubscriptions(filtered);
  }, [subscriptions, searchQuery]);

  const fetchSubscriptions = async (cursor?: string) => {
    if (cursor) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
      setSubscriptions([]);
    }
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (cursor) params.append('starting_after', cursor);
      params.append('limit', '50');
      
      const url = `/api/financials/subscriptions${params.toString() ? `?${params.toString()}` : ''}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch subscriptions');
      const data = await res.json();
      
      if (cursor) {
        setSubscriptions(prev => [...prev, ...(data.subscriptions || [])]);
      } else {
        setSubscriptions(data.subscriptions || []);
      }
      setHasMore(data.hasMore || false);
      setNextCursor(data.nextCursor || null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  };
  
  const handleLoadMore = () => {
    if (nextCursor && !isLoadingMore) {
      fetchSubscriptions(nextCursor);
    }
  };

  const handleSendReminder = async (subscriptionId: string) => {
    setSendingReminder(subscriptionId);
    try {
      const res = await fetch(`/api/financials/subscriptions/${subscriptionId}/send-reminder`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to send reminder');
      }
      setSuccessMessage('Payment reminder sent successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message);
      setTimeout(() => setError(null), 3000);
    } finally {
      setSendingReminder(null);
    }
  };

  const formatCurrency = (cents: number, currency: string = 'usd') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
      case 'past_due':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
      case 'canceled':
        return 'bg-gray-100 text-gray-800 dark:bg-gray-700/30 dark:text-gray-400';
      case 'trialing':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
      case 'unpaid':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400';
      default:
        return 'bg-gray-100 text-gray-600 dark:bg-gray-700/30 dark:text-gray-400';
    }
  };

  const getStripeSubscriptionUrl = (subscriptionId: string) => {
    return `https://dashboard.stripe.com/subscriptions/${subscriptionId}`;
  };

  const statusCounts = {
    all: subscriptions.length,
    active: subscriptions.filter(s => s.status === 'active').length,
    past_due: subscriptions.filter(s => s.status === 'past_due').length,
    canceled: subscriptions.filter(s => s.status === 'canceled').length,
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary dark:border-white/30 dark:border-t-white rounded-full animate-spin"></div>
          <p className="text-sm text-primary/60 dark:text-white/60">Loading subscriptions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {successMessage && (
        <div className="bg-green-100 dark:bg-green-900/30 border border-green-200 dark:border-green-700 rounded-xl p-4 flex items-center gap-3">
          <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
          <p className="text-green-800 dark:text-green-300">{successMessage}</p>
        </div>
      )}

      {syncResult && (
        <div className="bg-blue-100 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-xl p-4">
          <div className="flex items-center gap-3 mb-2">
            <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">cloud_sync</span>
            <p className="font-medium text-blue-800 dark:text-blue-300">Stripe Sync Results</p>
          </div>
          <div className="flex gap-4 text-sm text-blue-700 dark:text-blue-300">
            <span><strong>{syncResult.created}</strong> created</span>
            <span><strong>{syncResult.updated}</strong> updated</span>
            <span><strong>{syncResult.skipped}</strong> skipped</span>
          </div>
        </div>
      )}
      
      {error && (
        <div className="bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-xl p-4 flex items-center gap-3">
          <span className="material-symbols-outlined text-red-600 dark:text-red-400">error</span>
          <p className="text-red-800 dark:text-red-300">{error}</p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-primary/40 dark:text-white/40">search</span>
            <input
              type="text"
              placeholder="Search by name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-white/60 dark:bg-white/5 border border-primary/10 dark:border-white/20 rounded-xl text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/20 dark:focus:ring-white/20"
            />
          </div>
        </div>
        
        <div className="flex gap-2 overflow-x-auto pb-1">
          {(['all', 'active', 'past_due', 'canceled'] as const).map(status => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-full font-medium text-sm whitespace-nowrap transition-colors ${
                statusFilter === status
                  ? 'bg-primary dark:bg-accent text-white dark:text-primary'
                  : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60 hover:bg-white/80 dark:hover:bg-white/15'
              }`}
            >
              {status === 'all' ? 'All' : status === 'past_due' ? 'Past Due' : status.charAt(0).toUpperCase() + status.slice(1)}
              <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-black/10 dark:bg-white/10">
                {statusCounts[status]}
              </span>
            </button>
          ))}
        </div>
        
        <button
          onClick={handleSyncFromStripe}
          disabled={isSyncing}
          className="flex items-center gap-2 px-4 py-2 rounded-full font-medium text-sm whitespace-nowrap bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className={`material-symbols-outlined text-lg ${isSyncing ? 'animate-spin' : ''}`}>
            {isSyncing ? 'sync' : 'cloud_sync'}
          </span>
          {isSyncing ? 'Syncing...' : 'Sync from Stripe'}
        </button>
      </div>

      {filteredSubscriptions.length === 0 ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-8 max-w-md w-full">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 dark:bg-lavender/20 flex items-center justify-center">
                <span className="material-symbols-outlined text-4xl text-primary dark:text-lavender">subscriptions</span>
              </div>
              <h3 className="text-xl font-bold text-primary dark:text-white">No subscriptions found</h3>
              <p className="text-sm text-primary/60 dark:text-white/60">
                {searchQuery || statusFilter !== 'all' 
                  ? 'Try adjusting your search or filter criteria.' 
                  : 'No Stripe subscriptions are currently configured.'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-primary/10 dark:border-white/10">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Member</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Plan</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Next Billing</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary/5 dark:divide-white/5">
                {filteredSubscriptions.map((sub) => (
                  <tr key={sub.id} className="hover:bg-primary/5 dark:hover:bg-white/5 transition-colors">
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-primary dark:text-white">{sub.memberName}</p>
                        <p className="text-xs text-primary/60 dark:text-white/60">{sub.memberEmail}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-primary dark:text-white">{sub.planName}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-primary dark:text-white">
                        {formatCurrency(sub.amount, sub.currency)}
                        <span className="text-xs text-primary/60 dark:text-white/60">/{sub.interval}</span>
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${getStatusBadgeClass(sub.status)}`}>
                          {sub.status === 'past_due' ? 'Past Due' : sub.status.charAt(0).toUpperCase() + sub.status.slice(1)}
                        </span>
                        {sub.cancelAtPeriodEnd && (
                          <span className="px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
                            Canceling
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-primary dark:text-white">{formatDate(sub.currentPeriodEnd)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {sub.status === 'past_due' && (
                          <button
                            onClick={() => handleSendReminder(sub.id)}
                            disabled={sendingReminder === sub.id}
                            className="px-3 py-1.5 bg-red-100 hover:bg-red-200 dark:bg-red-900/30 dark:hover:bg-red-900/50 text-red-700 dark:text-red-400 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1"
                          >
                            <span className="material-symbols-outlined text-sm">mail</span>
                            {sendingReminder === sub.id ? 'Sending...' : 'Remind'}
                          </button>
                        )}
                        <a
                          href={getStripeSubscriptionUrl(sub.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 bg-primary/10 hover:bg-primary/20 dark:bg-white/10 dark:hover:bg-white/15 text-primary dark:text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                        >
                          <span className="material-symbols-outlined text-sm">open_in_new</span>
                          Stripe
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-sm text-primary/60 dark:text-white/60">
        <p>Showing {filteredSubscriptions.length} of {subscriptions.length} subscriptions</p>
        <div className="flex items-center gap-4">
          {hasMore && (
            <button
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="flex items-center gap-1 px-4 py-2 bg-primary dark:bg-accent text-white dark:text-primary rounded-full font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isLoadingMore ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">expand_more</span>
                  Load More
                </>
              )}
            </button>
          )}
          <button
            onClick={() => fetchSubscriptions()}
            className="flex items-center gap-1 hover:text-primary dark:hover:text-white transition-colors"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
};

const InvoicesSubTab: React.FC = () => {
  const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);
  const [filteredInvoices, setFilteredInvoices] = useState<InvoiceListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'open' | 'uncollectible'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [appliedStartDate, setAppliedStartDate] = useState('');
  const [appliedEndDate, setAppliedEndDate] = useState('');

  useEffect(() => {
    fetchInvoices();
  }, [statusFilter, appliedStartDate, appliedEndDate]);

  useEffect(() => {
    let filtered = invoices;
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(inv => 
        inv.memberName.toLowerCase().includes(query) ||
        inv.memberEmail.toLowerCase().includes(query) ||
        (inv.number && inv.number.toLowerCase().includes(query))
      );
    }
    
    setFilteredInvoices(filtered);
  }, [invoices, searchQuery]);

  const fetchInvoices = async (cursor?: string) => {
    if (cursor) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
      setInvoices([]);
    }
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (appliedStartDate) params.append('startDate', appliedStartDate);
      if (appliedEndDate) params.append('endDate', appliedEndDate);
      if (cursor) params.append('starting_after', cursor);
      params.append('limit', '50');
      
      const url = `/api/financials/invoices${params.toString() ? `?${params.toString()}` : ''}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch invoices');
      const data = await res.json();
      
      if (cursor) {
        setInvoices(prev => [...prev, ...(data.invoices || [])]);
      } else {
        setInvoices(data.invoices || []);
      }
      setHasMore(data.hasMore || false);
      setNextCursor(data.nextCursor || null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  };

  const handleLoadMore = () => {
    if (nextCursor && !isLoadingMore) {
      fetchInvoices(nextCursor);
    }
  };

  const handleDateFilterApply = () => {
    setAppliedStartDate(startDate);
    setAppliedEndDate(endDate);
  };

  const handleClearDateFilters = () => {
    setStartDate('');
    setEndDate('');
    setAppliedStartDate('');
    setAppliedEndDate('');
  };

  const formatCurrency = (cents: number, currency: string = 'usd') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'paid':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
      case 'open':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
      case 'uncollectible':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
      case 'void':
        return 'bg-gray-100 text-gray-800 dark:bg-gray-700/30 dark:text-gray-400';
      case 'draft':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400';
      default:
        return 'bg-gray-100 text-gray-600 dark:bg-gray-700/30 dark:text-gray-400';
    }
  };

  const getStripeInvoiceUrl = (invoiceId: string) => {
    return `https://dashboard.stripe.com/invoices/${invoiceId}`;
  };

  const statusCounts = {
    all: invoices.length,
    paid: invoices.filter(i => i.status === 'paid').length,
    open: invoices.filter(i => i.status === 'open').length,
    uncollectible: invoices.filter(i => i.status === 'uncollectible').length,
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary dark:border-white/30 dark:border-t-white rounded-full animate-spin"></div>
          <p className="text-sm text-primary/60 dark:text-white/60">Loading invoices...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-xl p-4 flex items-center gap-3">
          <span className="material-symbols-outlined text-red-600 dark:text-red-400">error</span>
          <p className="text-red-800 dark:text-red-300">{error}</p>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-primary/40 dark:text-white/40">search</span>
              <input
                type="text"
                placeholder="Search by name, email, or invoice number..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-white/60 dark:bg-white/5 border border-primary/10 dark:border-white/20 rounded-xl text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/20 dark:focus:ring-white/20"
              />
            </div>
          </div>
          
          <div className="flex gap-2 overflow-x-auto pb-1">
            {(['all', 'paid', 'open', 'uncollectible'] as const).map(status => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-4 py-2 rounded-full font-medium text-sm whitespace-nowrap transition-colors ${
                  statusFilter === status
                    ? 'bg-primary dark:bg-accent text-white dark:text-primary'
                    : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60 hover:bg-white/80 dark:hover:bg-white/15'
                }`}
              >
                {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
                <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-black/10 dark:bg-white/10">
                  {statusCounts[status]}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-white/40 dark:bg-white/5 border border-primary/10 dark:border-white/10 rounded-xl p-3">
          <span className="text-sm font-medium text-primary/70 dark:text-white/70">Date Range:</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="px-3 py-1.5 bg-white/60 dark:bg-white/10 border border-primary/10 dark:border-white/20 rounded-lg text-sm text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/20 dark:focus:ring-white/20"
          />
          <span className="text-primary/50 dark:text-white/50">to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="px-3 py-1.5 bg-white/60 dark:bg-white/10 border border-primary/10 dark:border-white/20 rounded-lg text-sm text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/20 dark:focus:ring-white/20"
          />
          <button
            onClick={handleDateFilterApply}
            className="px-3 py-1.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Apply
          </button>
          {(startDate || endDate) && (
            <button
              onClick={handleClearDateFilters}
              className="px-3 py-1.5 bg-primary/10 dark:bg-white/10 text-primary dark:text-white rounded-lg text-sm font-medium hover:bg-primary/20 dark:hover:bg-white/15 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {filteredInvoices.length === 0 ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-8 max-w-md w-full">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 dark:bg-lavender/20 flex items-center justify-center">
                <span className="material-symbols-outlined text-4xl text-primary dark:text-lavender">description</span>
              </div>
              <h3 className="text-xl font-bold text-primary dark:text-white">No invoices found</h3>
              <p className="text-sm text-primary/60 dark:text-white/60">
                {searchQuery || statusFilter !== 'all' || startDate || endDate
                  ? 'Try adjusting your search or filter criteria.' 
                  : 'No Stripe invoices are currently available.'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-primary/10 dark:border-white/10">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Invoice #</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Member</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Date</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary/5 dark:divide-white/5">
                {filteredInvoices.map((invoice) => (
                  <tr key={invoice.id} className="hover:bg-primary/5 dark:hover:bg-white/5 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-primary dark:text-white font-mono text-sm">
                        {invoice.number || '-'}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-primary dark:text-white">{invoice.memberName}</p>
                        <p className="text-xs text-primary/60 dark:text-white/60">{invoice.memberEmail}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-primary dark:text-white font-medium">
                          {formatCurrency(invoice.amountDue, invoice.currency)}
                        </p>
                        {invoice.amountPaid > 0 && invoice.amountPaid < invoice.amountDue && (
                          <p className="text-xs text-green-600 dark:text-green-400">
                            Paid: {formatCurrency(invoice.amountPaid, invoice.currency)}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${getStatusBadgeClass(invoice.status)}`}>
                        {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-primary dark:text-white">{formatDate(invoice.created)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {invoice.invoicePdf && (
                          <a
                            href={invoice.invoicePdf}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3 py-1.5 bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-400 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                          >
                            <span className="material-symbols-outlined text-sm">picture_as_pdf</span>
                            PDF
                          </a>
                        )}
                        <a
                          href={getStripeInvoiceUrl(invoice.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 bg-primary/10 hover:bg-primary/20 dark:bg-white/10 dark:hover:bg-white/15 text-primary dark:text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                        >
                          <span className="material-symbols-outlined text-sm">open_in_new</span>
                          Stripe
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-sm text-primary/60 dark:text-white/60">
        <p>Showing {filteredInvoices.length} of {invoices.length} invoices</p>
        <div className="flex items-center gap-4">
          {hasMore && (
            <button
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="flex items-center gap-1 px-4 py-2 bg-primary dark:bg-accent text-white dark:text-primary rounded-full font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isLoadingMore ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">expand_more</span>
                  Load More
                </>
              )}
            </button>
          )}
          <button
            onClick={() => fetchInvoices()}
            className="flex items-center gap-1 hover:text-primary dark:hover:text-white transition-colors"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
};

export default FinancialsTab;
