import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatedPage } from '../../../components/motion';
import { TabTransition } from '../../../components/motion/TabTransition';
import TransactionsSubTab from '../../../components/admin/payments/TransactionsSubTab';
import POSRegister from '../../../components/admin/payments/POSRegister';
import {
  useSubscriptions,
  useInvoices,
  useOverduePayments,
} from '../../../hooks/queries/useFinancialsQueries';
import { getSubscriptionStatusBadge, getInvoiceStatusBadge } from '../../../utils/statusColors';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';

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
  const { data: overduePayments } = useOverduePayments();
  const overdueCount = overduePayments?.length || 0;
  const [searchParams, setSearchParams] = useSearchParams();
  const subtabParam = searchParams.get('subtab');
  const activeTab: 'POS' | 'Transactions' | 'Subscriptions' | 'Invoices' = subtabParam === 'transactions' ? 'Transactions' : subtabParam === 'subscriptions' ? 'Subscriptions' : subtabParam === 'invoices' ? 'Invoices' : 'POS';
  
  const setActiveTab = (tab: 'POS' | 'Transactions' | 'Subscriptions' | 'Invoices') => {
    setSearchParams(params => {
      const newParams = new URLSearchParams(params);
      if (tab === 'POS') {
        newParams.delete('subtab');
      } else {
        newParams.set('subtab', tab.toLowerCase());
      }
      return newParams;
    });
  };

  return (
    <AnimatedPage className="pb-32">
      {/* Sub-tab Navigation */}
      <div className="flex gap-2 mb-6 animate-content-enter-delay-1 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide">
        <button
          onClick={() => setActiveTab('POS')}
          className={`shrink-0 px-4 py-2 rounded-full font-medium transition-colors tactile-btn ${
            activeTab === 'POS'
              ? 'bg-primary dark:bg-accent text-white dark:text-primary'
              : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60'
          }`}
        >
          POS
        </button>
        <button
          onClick={() => setActiveTab('Transactions')}
          className={`shrink-0 px-4 py-2 rounded-full font-medium transition-colors tactile-btn ${
            activeTab === 'Transactions'
              ? 'bg-primary dark:bg-accent text-white dark:text-primary'
              : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60'
          }`}
        >
          <span className="flex items-center gap-1.5">
            Transactions
            {overdueCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold rounded-full bg-red-500 text-white">
                {overdueCount}
              </span>
            )}
          </span>
        </button>
        <button
          onClick={() => setActiveTab('Subscriptions')}
          className={`shrink-0 px-4 py-2 rounded-full font-medium transition-colors tactile-btn ${
            activeTab === 'Subscriptions'
              ? 'bg-primary dark:bg-accent text-white dark:text-primary'
              : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60'
          }`}
        >
          Subscriptions
        </button>
        <button
          onClick={() => setActiveTab('Invoices')}
          className={`shrink-0 px-4 py-2 rounded-full font-medium transition-colors tactile-btn ${
            activeTab === 'Invoices'
              ? 'bg-primary dark:bg-accent text-white dark:text-primary'
              : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60'
          }`}
        >
          Invoices
        </button>
      </div>

      {/* Tab Content */}
      <TabTransition activeKey={activeTab}>
      <div className="animate-content-enter">
        {activeTab === 'POS' && <POSRegister />}
        {activeTab === 'Transactions' && <TransactionsSubTab />}
        {activeTab === 'Subscriptions' && <SubscriptionsSubTab />}
        {activeTab === 'Invoices' && <InvoicesSubTab />}
      </div>
      </TabTransition>
    </AnimatedPage>
  );
};

const SubscriptionsSubTab: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'past_due' | 'canceled'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sendingReminder, setSendingReminder] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ created: number; updated: number; skipped: number } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [subsMobileParent] = useAutoAnimate();
  const [subsTbodyParent] = useAutoAnimate();

  const { data: subscriptionsData, isLoading, error: queryError, refetch } = useSubscriptions(statusFilter);
  const subscriptions = subscriptionsData?.subscriptions || [];
  const hasMore = subscriptionsData?.hasMore || false;
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  
  const error = localError || (queryError instanceof Error ? queryError.message : null);

  const filteredSubscriptions = searchQuery.trim()
    ? subscriptions.filter(sub => 
        sub.memberName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        sub.memberEmail.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : subscriptions;

  const handleSyncFromStripe = async () => {
    setIsSyncing(true);
    setSyncResult(null);
    setLocalError(null);
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
      refetch();
    } catch (err: unknown) {
      setLocalError((err instanceof Error ? err.message : String(err)));
      setTimeout(() => setLocalError(null), 5000);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleLoadMore = () => {
    // Note: Pagination would need additional query implementation
    // For now, just refetch
    refetch();
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
    } catch (err: unknown) {
      setLocalError((err instanceof Error ? err.message : String(err)));
      setTimeout(() => setLocalError(null), 3000);
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

  const formatDate = (timestamp: number | null | undefined) => {
    if (!timestamp || typeof timestamp !== 'number') {
      return '—';
    }
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'America/Los_Angeles',
    });
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
          <WalkingGolferSpinner size="md" variant="dark" />
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
        <>
          {/* Mobile card view */}
          <div ref={subsMobileParent} className="md:hidden space-y-3">
            {filteredSubscriptions.map((sub) => (
              <div key={sub.id} className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-primary dark:text-white truncate">{sub.memberName}</p>
                    <p className="text-xs text-primary/60 dark:text-white/60 truncate">{sub.memberEmail}</p>
                  </div>
                  <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getSubscriptionStatusBadge(sub.status)}`}>
                      {sub.status === 'past_due' ? 'Past Due' : sub.status.charAt(0).toUpperCase() + sub.status.slice(1)}
                    </span>
                    {sub.cancelAtPeriodEnd && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
                        Canceling
                      </span>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                  <div>
                    <span className="text-primary/50 dark:text-white/50 text-xs">Plan</span>
                    <p className="text-primary dark:text-white">{sub.planName}</p>
                  </div>
                  <div>
                    <span className="text-primary/50 dark:text-white/50 text-xs">Amount</span>
                    <p className="text-primary dark:text-white">
                      {formatCurrency(sub.amount, sub.currency)}
                      <span className="text-xs text-primary/60 dark:text-white/60">/{sub.interval}</span>
                    </p>
                  </div>
                  <div className="col-span-2">
                    <span className="text-primary/50 dark:text-white/50 text-xs">Next Billing</span>
                    <p className="text-primary dark:text-white">{formatDate(sub.currentPeriodEnd)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-2 border-t border-primary/10 dark:border-white/10">
                  {sub.status === 'past_due' && (
                    <button
                      onClick={() => handleSendReminder(sub.id)}
                      disabled={sendingReminder === sub.id}
                      className="flex-1 px-3 py-2 bg-red-100 hover:bg-red-200 dark:bg-red-900/30 dark:hover:bg-red-900/50 text-red-700 dark:text-red-400 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
                    >
                      <span className="material-symbols-outlined text-sm">mail</span>
                      {sendingReminder === sub.id ? 'Sending...' : 'Send Reminder'}
                    </button>
                  )}
                  <a
                    href={getStripeSubscriptionUrl(sub.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 px-3 py-2 bg-primary/10 hover:bg-primary/20 dark:bg-white/10 dark:hover:bg-white/15 text-primary dark:text-white rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1"
                  >
                    <span className="material-symbols-outlined text-sm">open_in_new</span>
                    View in Stripe
                  </a>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop table view */}
          <div className="hidden md:block bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl overflow-hidden">
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
                <tbody ref={subsTbodyParent} className="divide-y divide-primary/5 dark:divide-white/5">
                  {filteredSubscriptions.map((sub) => (
                    <tr key={sub.id} className="hover:bg-primary/5 dark:hover:bg-white/5 transition-colors tactile-row">
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
                          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${getSubscriptionStatusBadge(sub.status)}`}>
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
        </>
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
                  <WalkingGolferSpinner size="sm" variant="light" />
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
            onClick={() => refetch()}
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
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'open' | 'uncollectible'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [appliedStartDate, setAppliedStartDate] = useState('');
  const [appliedEndDate, setAppliedEndDate] = useState('');
  const [invMobileParent] = useAutoAnimate();
  const [invTbodyParent] = useAutoAnimate();

  const { data: invoicesData, isLoading, error: queryError, refetch } = useInvoices(statusFilter, appliedStartDate, appliedEndDate);
  const invoices = invoicesData?.invoices || [];
  const hasMore = invoicesData?.hasMore || false;
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const error = queryError instanceof Error ? queryError.message : null;

  const filteredInvoices = searchQuery.trim()
    ? invoices.filter(inv => 
        inv.memberName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        inv.memberEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (inv.number && inv.number.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : invoices;

  const handleLoadMore = () => {
    // Note: Pagination would need additional query implementation
    // For now, just refetch
    refetch();
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

  const formatDate = (timestamp: number | null | undefined) => {
    if (!timestamp || typeof timestamp !== 'number') {
      return '—';
    }
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'America/Los_Angeles',
    });
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
          <WalkingGolferSpinner size="md" variant="dark" />
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

      <div className="flex flex-col gap-4 animate-content-enter-delay-1">
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
        <>
          {/* Mobile card view */}
          <div ref={invMobileParent} className="md:hidden space-y-3">
            {filteredInvoices.map((invoice) => (
              <div key={invoice.id} className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-primary dark:text-white truncate">{invoice.memberName}</p>
                    <p className="text-xs text-primary/60 dark:text-white/60 truncate">{invoice.memberEmail}</p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ml-2 flex-shrink-0 ${getInvoiceStatusBadge(invoice.status)}`}>
                    {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                  <div>
                    <span className="text-primary/50 dark:text-white/50 text-xs">Invoice #</span>
                    <p className="text-primary dark:text-white font-mono text-sm">{invoice.number || '-'}</p>
                  </div>
                  <div>
                    <span className="text-primary/50 dark:text-white/50 text-xs">Date</span>
                    <p className="text-primary dark:text-white">{formatDate(invoice.created)}</p>
                  </div>
                  <div>
                    <span className="text-primary/50 dark:text-white/50 text-xs">Amount Due</span>
                    <p className="text-primary dark:text-white font-medium">
                      {formatCurrency(invoice.amountDue, invoice.currency)}
                    </p>
                  </div>
                  {invoice.amountPaid > 0 && invoice.amountPaid < invoice.amountDue && (
                    <div>
                      <span className="text-primary/50 dark:text-white/50 text-xs">Paid</span>
                      <p className="text-green-600 dark:text-green-400">
                        {formatCurrency(invoice.amountPaid, invoice.currency)}
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 pt-2 border-t border-primary/10 dark:border-white/10">
                  {invoice.invoicePdf && (
                    <a
                      href={invoice.invoicePdf}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 px-3 py-2 bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-400 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1"
                    >
                      <span className="material-symbols-outlined text-sm">picture_as_pdf</span>
                      Download PDF
                    </a>
                  )}
                  <a
                    href={getStripeInvoiceUrl(invoice.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 px-3 py-2 bg-primary/10 hover:bg-primary/20 dark:bg-white/10 dark:hover:bg-white/15 text-primary dark:text-white rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1"
                  >
                    <span className="material-symbols-outlined text-sm">open_in_new</span>
                    View in Stripe
                  </a>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop table view */}
          <div className="hidden md:block bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl overflow-hidden">
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
                <tbody ref={invTbodyParent} className="divide-y divide-primary/5 dark:divide-white/5">
                  {filteredInvoices.map((invoice, index) => (
                    <tr key={invoice.id} className={`hover:bg-primary/5 dark:hover:bg-white/5 transition-colors tactile-row animate-list-item-delay-${Math.min(index + 1, 10)}`}>
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
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${getInvoiceStatusBadge(invoice.status)}`}>
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
        </>
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
                  <WalkingGolferSpinner size="sm" variant="light" />
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
            onClick={() => refetch()}
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
