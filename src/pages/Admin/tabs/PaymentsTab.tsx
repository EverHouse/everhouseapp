import React, { useState, useEffect, useCallback } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import EmptyState from '../../../components/EmptyState';
import ModalShell from '../../../components/ModalShell';
import { StripePaymentForm } from '../../../components/stripe/StripePaymentForm';
import { CheckinBillingModal } from '../../../components/staff-command-center/modals/CheckinBillingModal';
import { getTodayPacific, formatTime12Hour } from '../../../utils/dateUtils';

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
  const [activeSection, setActiveSection] = useState<'quick-charge' | 'overdue' | 'lookup' | 'transactions' | null>(null);
  const [overdueCount, setOverdueCount] = useState(0);

  useEffect(() => {
    fetch('/api/bookings/overdue-payments', { credentials: 'include' })
      .then(res => res.json())
      .then(data => setOverdueCount(data.length || 0))
      .catch(() => {});
  }, []);

  const quickActions = [
    { id: 'quick-charge' as const, icon: 'point_of_sale', label: 'Quick Charge', color: 'bg-primary dark:bg-lavender' },
    { id: 'overdue' as const, icon: 'warning', label: 'Overdue', color: overdueCount > 0 ? 'bg-red-500' : 'bg-gray-400', badge: overdueCount },
    { id: 'lookup' as const, icon: 'person_search', label: 'Member Lookup', color: 'bg-amber-500' },
    { id: 'transactions' as const, icon: 'receipt_long', label: 'Recent', color: 'bg-blue-500' },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {quickActions.map(action => (
          <button
            key={action.id}
            onClick={() => setActiveSection(action.id)}
            className={`${action.color} text-white rounded-2xl p-4 flex flex-col items-center gap-2 min-h-[100px] shadow-lg active:scale-95 transition-transform relative`}
          >
            <span className="material-symbols-outlined text-3xl">{action.icon}</span>
            <span className="font-semibold text-sm">{action.label}</span>
            {action.badge !== undefined && action.badge > 0 && (
              <span className="absolute top-2 right-2 min-w-[24px] h-6 px-1.5 flex items-center justify-center bg-white text-red-600 text-sm font-bold rounded-full">
                {action.badge > 99 ? '99+' : action.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {activeSection === 'quick-charge' && (
        <QuickChargeSection onClose={() => setActiveSection(null)} />
      )}
      {activeSection === 'overdue' && (
        <OverduePaymentsPanel onClose={() => setActiveSection(null)} />
      )}
      {activeSection === 'lookup' && (
        <MemberLookupSection onClose={() => setActiveSection(null)} />
      )}
      {activeSection === 'transactions' && (
        <RecentTransactionsSection onClose={() => setActiveSection(null)} />
      )}
    </div>
  );
};

const DesktopPaymentsView: React.FC = () => {
  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-4 space-y-6">
        <QuickChargeSection variant="card" />
        <QuickInvoiceCard />
      </div>
      
      <div className="col-span-4 space-y-6">
        <OverduePaymentsPanel variant="card" />
      </div>
      
      <div className="col-span-4 space-y-6">
        <MemberLookupSection variant="card" />
        <RecentTransactionsSection variant="card" />
      </div>
    </div>
  );
};

interface SectionProps {
  onClose?: () => void;
  variant?: 'modal' | 'card';
}

const QuickChargeSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemberSearchResult[]>([]);
  const [selectedMember, setSelectedMember] = useState<MemberSearchResult | null>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [paymentStep, setPaymentStep] = useState<'form' | 'payment'>('form');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [isCreatingPayment, setIsCreatingPayment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const searchMembers = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(`/api/members/search?q=${encodeURIComponent(query)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.slice(0, 5));
      }
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => searchMembers(searchQuery), 300);
    return () => clearTimeout(timeout);
  }, [searchQuery, searchMembers]);

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
          {!selectedMember ? (
            <div>
              <label className="block text-sm font-medium text-primary dark:text-white mb-2">Search Member</label>
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Name or email..."
                  className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                {isSearching && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
                  </div>
                )}
              </div>
              {searchResults.length > 0 && (
                <div className="mt-2 rounded-xl bg-white dark:bg-surface-dark border border-primary/10 dark:border-white/10 divide-y divide-primary/5 dark:divide-white/5 overflow-hidden">
                  {searchResults.map(member => (
                    <button
                      key={member.id}
                      onClick={() => {
                        setSelectedMember(member);
                        setSearchQuery('');
                        setSearchResults([]);
                      }}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors text-left"
                    >
                      <div className="w-10 h-10 rounded-full bg-primary/10 dark:bg-lavender/20 flex items-center justify-center">
                        <span className="text-primary dark:text-lavender font-semibold">
                          {member.name?.charAt(0)?.toUpperCase() || '?'}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-primary dark:text-white truncate">{member.name}</p>
                        <p className="text-xs text-primary/60 dark:text-white/60 truncate">{member.email}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/5 dark:bg-white/5 border border-primary/10 dark:border-white/10">
                <div className="w-10 h-10 rounded-full bg-primary/10 dark:bg-lavender/20 flex items-center justify-center">
                  <span className="text-primary dark:text-lavender font-semibold">
                    {selectedMember.name?.charAt(0)?.toUpperCase() || '?'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-primary dark:text-white truncate">{selectedMember.name}</p>
                  <p className="text-xs text-primary/60 dark:text-white/60 truncate">{selectedMember.email}</p>
                </div>
                <button
                  onClick={() => setSelectedMember(null)}
                  className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full transition-colors"
                >
                  <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
                </button>
              </div>

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
          <span className="material-symbols-outlined text-primary dark:text-lavender">point_of_sale</span>
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
          <span className="material-symbols-outlined text-primary dark:text-lavender">point_of_sale</span>
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
            <span className="material-symbols-outlined text-red-500">warning</span>
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
              <span className="material-symbols-outlined text-red-500">warning</span>
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
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemberSearchResult[]>([]);
  const [selectedMember, setSelectedMember] = useState<MemberSearchResult | null>(null);
  const [memberBalance, setMemberBalance] = useState<MemberBalance | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);

  const searchMembers = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(`/api/members/search?q=${encodeURIComponent(query)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.slice(0, 5));
      }
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => searchMembers(searchQuery), 300);
    return () => clearTimeout(timeout);
  }, [searchQuery, searchMembers]);

  const loadMemberBalance = useCallback(async (email: string, tier: string | null) => {
    setIsLoadingBalance(true);
    try {
      const [balanceRes, passesRes, historyRes] = await Promise.all([
        fetch(`/api/staff/member-balance/${encodeURIComponent(email)}`, { credentials: 'include' }),
        fetch(`/api/guest-passes/${encodeURIComponent(email)}?tier=${tier || ''}`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(email)}/purchases?limit=5`, { credentials: 'include' })
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
      loadMemberBalance(selectedMember.email, selectedMember.membershipTier);
    }
  }, [selectedMember, loadMemberBalance]);

  const content = (
    <div className="space-y-4">
      {!selectedMember ? (
        <div>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-primary/40 dark:text-white/40">search</span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name or email..."
              className="w-full pl-10 pr-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            {isSearching && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
              </div>
            )}
          </div>
          {searchResults.length > 0 && (
            <div className="mt-2 rounded-xl bg-white dark:bg-surface-dark border border-primary/10 dark:border-white/10 divide-y divide-primary/5 dark:divide-white/5 overflow-hidden">
              {searchResults.map(member => (
                <button
                  key={member.id}
                  onClick={() => {
                    setSelectedMember(member);
                    setSearchQuery('');
                    setSearchResults([]);
                  }}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-full bg-primary/10 dark:bg-lavender/20 flex items-center justify-center">
                    <span className="text-primary dark:text-lavender font-semibold">
                      {member.name?.charAt(0)?.toUpperCase() || '?'}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-primary dark:text-white truncate">{member.name}</p>
                    <p className="text-xs text-primary/60 dark:text-white/60 truncate">{member.email}</p>
                  </div>
                  {member.membershipTier && (
                    <span className="px-2 py-0.5 text-xs font-medium bg-lavender/20 text-primary dark:text-lavender rounded-full">
                      {member.membershipTier}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
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
              {selectedMember.membershipTier && (
                <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium bg-lavender/20 text-primary dark:text-lavender rounded-full">
                  {selectedMember.membershipTier}
                </span>
              )}
            </div>
            <button
              onClick={() => {
                setSelectedMember(null);
                setMemberBalance(null);
              }}
              className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full transition-colors"
            >
              <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
            </button>
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
                {memberBalance.guestPasses && (
                  <div className="p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/5 dark:border-white/10">
                    <p className="text-xs text-primary/60 dark:text-white/60">Guest Passes</p>
                    <p className="text-xl font-bold text-primary dark:text-white">
                      {memberBalance.guestPasses.remaining}/{memberBalance.guestPasses.total}
                    </p>
                  </div>
                )}
              </div>

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
          <span className="material-symbols-outlined text-amber-500">person_search</span>
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
          <span className="material-symbols-outlined text-amber-500">person_search</span>
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
          <div className="text-right flex-shrink-0">
            <p className="font-bold text-primary dark:text-white">${(tx.amount / 100).toFixed(2)}</p>
            <p className="text-xs text-primary/50 dark:text-white/50">
              {new Date(tx.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </p>
          </div>
        </div>
      ))}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-blue-500">receipt_long</span>
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
          <span className="material-symbols-outlined text-blue-500">receipt_long</span>
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
