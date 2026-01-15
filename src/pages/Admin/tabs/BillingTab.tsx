import React, { useState, useEffect } from 'react';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';

type SubTab = 'products' | 'subscriptions' | 'invoices';

interface ProductSyncStatus {
  hubspotProductId: string;
  name: string;
  price: number;
  isSynced: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
}

interface StripeProduct {
  id: number;
  hubspotProductId: string;
  stripeProductId: string;
  stripePriceId: string;
  name: string;
  priceCents: number;
  billingInterval: string;
  billingIntervalCount: number;
  isActive: boolean;
}

interface Subscription {
  id: string;
  status: string;
  priceId: string;
  productId: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

interface MemberSearchResult {
  id: number;
  email: string;
  name: string;
  stripeCustomerId: string | null;
  membershipTier: string | null;
}

interface Invoice {
  id: string;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  customerEmail: string | null;
  description: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  created: string;
  dueDate: string | null;
  paidAt: string | null;
  lines: Array<{
    description: string | null;
    amount: number;
    quantity: number | null;
  }>;
}

interface InvoicePreview {
  amountDue: number;
  currency: string;
  lines: Array<{
    description: string | null;
    amount: number;
    quantity: number | null;
  }>;
  periodStart: string;
  periodEnd: string;
}

const BillingTab: React.FC = () => {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('products');

  const SUB_TABS: { key: SubTab; label: string; icon: string }[] = [
    { key: 'products', label: 'Products', icon: 'inventory_2' },
    { key: 'subscriptions', label: 'Subscriptions', icon: 'subscriptions' },
    { key: 'invoices', label: 'Invoices', icon: 'receipt_long' },
  ];

  return (
    <div className="animate-pop-in space-y-6 pb-32">
      <div className="flex gap-2 overflow-x-auto pb-2">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveSubTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-full font-medium text-sm whitespace-nowrap transition-all ${
              activeSubTab === tab.key
                ? 'bg-primary dark:bg-white text-white dark:text-primary'
                : 'bg-white dark:bg-surface-dark text-primary dark:text-white border border-gray-200 dark:border-white/25 hover:bg-gray-50 dark:hover:bg-white/10'
            }`}
          >
            <span aria-hidden="true" className="material-symbols-outlined text-lg">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {activeSubTab === 'products' && <ProductsView />}
      {activeSubTab === 'subscriptions' && <SubscriptionsView />}
      {activeSubTab === 'invoices' && <InvoicesView />}
    </div>
  );
};

const ProductsView: React.FC = () => {
  const [syncStatus, setSyncStatus] = useState<ProductSyncStatus[]>([]);
  const [stripeProducts, setStripeProducts] = useState<StripeProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncingProduct, setSyncingProduct] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetch('/api/stripe/products', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch products');
      const data = await res.json();
      setSyncStatus(data.syncStatus || []);
      setStripeProducts(data.products || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load products');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSyncProduct = async (hubspotProductId: string) => {
    try {
      setSyncingProduct(hubspotProductId);
      setError(null);
      const res = await fetch('/api/stripe/products/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ hubspotProductId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to sync product');
      }
      setSuccessMessage('Product synced successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
      await fetchData();
    } catch (err: any) {
      setError(err.message || 'Failed to sync product');
    } finally {
      setSyncingProduct(null);
    }
  };

  const handleSyncAll = async () => {
    try {
      setSyncingAll(true);
      setError(null);
      const res = await fetch('/api/stripe/products/sync-all', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to sync products');
      }
      const result = await res.json();
      setSuccessMessage(`Synced ${result.synced} products${result.failed > 0 ? `, ${result.failed} failed` : ''}`);
      setTimeout(() => setSuccessMessage(null), 5000);
      await fetchData();
    } catch (err: any) {
      setError(err.message || 'Failed to sync products');
    } finally {
      setSyncingAll(false);
    }
  };

  if (isLoading) {
    return (
      <div className="py-8 flex flex-col items-center gap-2">
        <WalkingGolferSpinner size="md" variant="dark" />
        <p className="text-sm text-gray-500">Loading products...</p>
      </div>
    );
  }

  const unsyncedCount = syncStatus.filter(p => !p.isSynced).length;

  return (
    <div className="space-y-6">
      {successMessage && (
        <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg text-green-700 dark:text-green-400 text-sm flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">check_circle</span>
          {successMessage}
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">error</span>
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 border border-gray-200 dark:border-white/25">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
              <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">sync</span>
            </div>
            <div>
              <h3 className="text-lg font-bold text-primary dark:text-white">HubSpot Products</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {syncStatus.length} products found, {unsyncedCount} not synced
              </p>
            </div>
          </div>
          <button
            onClick={handleSyncAll}
            disabled={syncingAll || unsyncedCount === 0}
            className="flex items-center gap-2 px-4 py-2 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {syncingAll ? (
              <>
                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                Syncing...
              </>
            ) : (
              <>
                <span aria-hidden="true" className="material-symbols-outlined text-lg">sync</span>
                Sync All
              </>
            )}
          </button>
        </div>

        <div className="space-y-3">
          {syncStatus.map((product) => (
            <div
              key={product.hubspotProductId}
              className="p-4 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-semibold text-primary dark:text-white truncate">{product.name}</h4>
                    {product.isSynced ? (
                      <span className="px-2 py-0.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full flex items-center gap-1">
                        <span aria-hidden="true" className="material-symbols-outlined text-xs">check</span>
                        Synced
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full">
                        Not Synced
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    ${product.price.toFixed(2)}
                  </p>
                  {product.isSynced && (
                    <div className="mt-2 text-xs text-gray-500 dark:text-gray-500 space-y-0.5">
                      <p>Stripe Product: {product.stripeProductId}</p>
                      <p>Stripe Price: {product.stripePriceId}</p>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleSyncProduct(product.hubspotProductId)}
                  disabled={syncingProduct === product.hubspotProductId || syncingAll}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary dark:text-white bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg hover:bg-gray-50 dark:hover:bg-white/20 transition-colors disabled:opacity-50"
                >
                  {syncingProduct === product.hubspotProductId ? (
                    <span aria-hidden="true" className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                  ) : (
                    <span aria-hidden="true" className="material-symbols-outlined text-base">sync</span>
                  )}
                  {product.isSynced ? 'Re-sync' : 'Sync'}
                </button>
              </div>
            </div>
          ))}

          {syncStatus.length === 0 && (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <span aria-hidden="true" className="material-symbols-outlined text-4xl mb-2">inventory_2</span>
              <p>No products found in HubSpot</p>
            </div>
          )}
        </div>
      </div>

      {stripeProducts.length > 0 && (
        <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 border border-gray-200 dark:border-white/25">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
              <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">payments</span>
            </div>
            <div>
              <h3 className="text-lg font-bold text-primary dark:text-white">Stripe Products</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">{stripeProducts.length} products synced</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-white/10">
                  <th className="text-left py-3 px-2 font-medium text-gray-500 dark:text-gray-400">Product</th>
                  <th className="text-left py-3 px-2 font-medium text-gray-500 dark:text-gray-400">Price</th>
                  <th className="text-left py-3 px-2 font-medium text-gray-500 dark:text-gray-400">Interval</th>
                  <th className="text-left py-3 px-2 font-medium text-gray-500 dark:text-gray-400">Price ID</th>
                  <th className="text-left py-3 px-2 font-medium text-gray-500 dark:text-gray-400">Status</th>
                </tr>
              </thead>
              <tbody>
                {stripeProducts.map((product) => (
                  <tr key={product.id} className="border-b border-gray-100 dark:border-white/5 last:border-0">
                    <td className="py-3 px-2 font-medium text-primary dark:text-white">{product.name}</td>
                    <td className="py-3 px-2 text-gray-600 dark:text-gray-300">
                      ${(product.priceCents / 100).toFixed(2)}
                    </td>
                    <td className="py-3 px-2 text-gray-600 dark:text-gray-300">
                      {product.billingIntervalCount > 1 && `${product.billingIntervalCount} `}
                      {product.billingInterval}{product.billingIntervalCount > 1 ? 's' : ''}
                    </td>
                    <td className="py-3 px-2">
                      <code className="text-xs bg-gray-100 dark:bg-black/30 px-2 py-1 rounded text-gray-600 dark:text-gray-400">
                        {product.stripePriceId}
                      </code>
                    </td>
                    <td className="py-3 px-2">
                      {product.isActive ? (
                        <span className="px-2 py-0.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full">
                          Active
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full">
                          Inactive
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

const SubscriptionsView: React.FC = () => {
  const [searchEmail, setSearchEmail] = useState('');
  const [searchResults, setSearchResults] = useState<MemberSearchResult[]>([]);
  const [selectedMember, setSelectedMember] = useState<MemberSearchResult | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [stripeProducts, setStripeProducts] = useState<StripeProduct[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingSubscriptions, setIsLoadingSubscriptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [creatingSubscription, setCreatingSubscription] = useState(false);
  const [selectedPriceId, setSelectedPriceId] = useState('');
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  useEffect(() => {
    fetchStripeProducts();
  }, []);

  useEffect(() => {
    const handleBillingUpdate = (e: CustomEvent) => {
      const { action, memberEmail } = e.detail || {};
      const billingActions = [
        'subscription_created', 'subscription_cancelled', 'subscription_updated',
        'payment_succeeded', 'payment_failed', 'invoice_paid', 'invoice_failed'
      ];
      
      if (billingActions.includes(action)) {
        setSelectedMember(current => {
          if (current?.stripeCustomerId && (current.email === memberEmail || !memberEmail)) {
            fetch(`/api/stripe/subscriptions/${current.stripeCustomerId}`, { credentials: 'include' })
              .then(res => res.json())
              .then(data => setSubscriptions(data.subscriptions || []))
              .catch(console.error);
          }
          return current;
        });
      }
    };

    window.addEventListener('billing-update', handleBillingUpdate as EventListener);
    return () => window.removeEventListener('billing-update', handleBillingUpdate as EventListener);
  }, []);

  const fetchStripeProducts = async () => {
    try {
      const res = await fetch('/api/stripe/products', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setStripeProducts(data.products || []);
      }
    } catch (err) {
      console.error('Failed to fetch stripe products:', err);
    }
  };

  const handleSearch = async () => {
    if (!searchEmail.trim()) return;
    try {
      setIsSearching(true);
      setError(null);
      setSelectedMember(null);
      setSubscriptions([]);

      const res = await fetch(`/api/billing/members/search?query=${encodeURIComponent(searchEmail.trim())}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to search members');
      const data = await res.json();
      
      const results = (data.members || []).map((m: any) => ({
        id: m.hubspotId || m.id,
        email: m.email,
        name: m.name,
        stripeCustomerId: m.stripeCustomerId || null,
        membershipTier: m.membershipTier || null,
      }));
      
      setSearchResults(results);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectMember = async (member: MemberSearchResult) => {
    setSelectedMember(member);
    setSearchResults([]);
    
    if (!member.stripeCustomerId) {
      setSubscriptions([]);
      return;
    }

    try {
      setIsLoadingSubscriptions(true);
      setError(null);
      const res = await fetch(`/api/stripe/subscriptions/${member.stripeCustomerId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load subscriptions');
      const data = await res.json();
      setSubscriptions(data.subscriptions || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load subscriptions');
    } finally {
      setIsLoadingSubscriptions(false);
    }
  };

  const handleCreateSubscription = async () => {
    if (!selectedMember || !selectedPriceId) return;

    if (!selectedMember.stripeCustomerId) {
      try {
        setCreatingSubscription(true);
        setError(null);
        
        const customerRes = await fetch('/api/stripe/create-customer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: selectedMember.id,
            email: selectedMember.email,
            name: selectedMember.name,
          }),
        });
        
        if (!customerRes.ok) throw new Error('Failed to create Stripe customer');
        const customerData = await customerRes.json();
        selectedMember.stripeCustomerId = customerData.customerId;
      } catch (err: any) {
        setError(err.message || 'Failed to create customer');
        setCreatingSubscription(false);
        return;
      }
    }

    try {
      setCreatingSubscription(true);
      setError(null);

      const res = await fetch('/api/stripe/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          customerId: selectedMember.stripeCustomerId,
          priceId: selectedPriceId,
          memberEmail: selectedMember.email,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create subscription');
      }

      setSuccessMessage('Subscription created successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
      setSelectedPriceId('');
      
      await handleSelectMember(selectedMember);
    } catch (err: any) {
      setError(err.message || 'Failed to create subscription');
    } finally {
      setCreatingSubscription(false);
    }
  };

  const handleCancelSubscription = async (subscriptionId: string) => {
    if (!confirm('Are you sure you want to cancel this subscription?')) return;

    try {
      setCancellingId(subscriptionId);
      setError(null);

      const res = await fetch(`/api/stripe/subscriptions/${subscriptionId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to cancel subscription');
      }

      setSuccessMessage('Subscription cancelled');
      setTimeout(() => setSuccessMessage(null), 3000);
      
      if (selectedMember) {
        await handleSelectMember(selectedMember);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to cancel subscription');
    } finally {
      setCancellingId(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400';
      case 'past_due': return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
      case 'canceled': return 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400';
      case 'trialing': return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400';
      default: return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400';
    }
  };

  const getProductName = (priceId: string) => {
    const product = stripeProducts.find(p => p.stripePriceId === priceId);
    return product?.name || 'Unknown Product';
  };

  return (
    <div className="space-y-6">
      {successMessage && (
        <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg text-green-700 dark:text-green-400 text-sm flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">check_circle</span>
          {successMessage}
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">error</span>
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 border border-gray-200 dark:border-white/25">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">search</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-primary dark:text-white">Find Member</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">Search by name or email to manage subscriptions</p>
          </div>
        </div>

        <div className="flex gap-3">
          <input
            type="text"
            value={searchEmail}
            onChange={(e) => setSearchEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Enter name or email..."
            className="flex-1 px-4 py-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            onClick={handleSearch}
            disabled={isSearching || !searchEmail.trim()}
            className="flex items-center gap-2 px-5 py-3 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isSearching ? (
              <span aria-hidden="true" className="material-symbols-outlined animate-spin">progress_activity</span>
            ) : (
              <span aria-hidden="true" className="material-symbols-outlined">search</span>
            )}
            Search
          </button>
        </div>

        {searchResults.length > 0 && (
          <div className="mt-4 space-y-2">
            {searchResults.map((member) => (
              <button
                key={member.id}
                onClick={() => handleSelectMember(member)}
                className="w-full p-3 text-left bg-gray-50 dark:bg-black/20 rounded-lg hover:bg-gray-100 dark:hover:bg-black/30 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium text-primary dark:text-white">{member.name}</p>
                  {member.membershipTier && (
                    <span className="text-xs px-2 py-1 rounded-full bg-accent/20 dark:bg-accent/30 text-primary dark:text-white">
                      {member.membershipTier}
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400">{member.email}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedMember && (
        <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 border border-gray-200 dark:border-white/25">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
                <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">person</span>
              </div>
              <div>
                <h3 className="text-lg font-bold text-primary dark:text-white">{selectedMember.name}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{selectedMember.email}</p>
              </div>
            </div>
            <button
              onClick={() => {
                setSelectedMember(null);
                setSubscriptions([]);
              }}
              className="p-2 text-gray-500 hover:text-primary dark:hover:text-white transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined">close</span>
            </button>
          </div>

          {isLoadingSubscriptions ? (
            <div className="py-8 flex justify-center">
              <WalkingGolferSpinner size="sm" variant="dark" />
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-primary dark:text-white mb-3">Create New Subscription</h4>
                <div className="flex gap-3">
                  <select
                    value={selectedPriceId}
                    onChange={(e) => setSelectedPriceId(e.target.value)}
                    className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    <option value="">Select a product...</option>
                    {stripeProducts.filter(p => p.isActive).map((product) => (
                      <option key={product.stripePriceId} value={product.stripePriceId}>
                        {product.name} - ${(product.priceCents / 100).toFixed(2)}/{product.billingInterval}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleCreateSubscription}
                    disabled={creatingSubscription || !selectedPriceId}
                    className="flex items-center gap-2 px-4 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {creatingSubscription ? (
                      <span aria-hidden="true" className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                    ) : (
                      <span aria-hidden="true" className="material-symbols-outlined text-base">add</span>
                    )}
                    Create
                  </button>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-primary dark:text-white mb-3">
                  Current Subscriptions ({subscriptions.length})
                </h4>
                {subscriptions.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    <span aria-hidden="true" className="material-symbols-outlined text-4xl mb-2">subscriptions</span>
                    <p>No active subscriptions</p>
                    {!selectedMember.stripeCustomerId && (
                      <p className="text-xs mt-1">This member doesn't have a Stripe customer account yet</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {subscriptions.map((sub) => (
                      <div
                        key={sub.id}
                        className="p-4 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10"
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <h5 className="font-semibold text-primary dark:text-white">
                                {getProductName(sub.priceId)}
                              </h5>
                              <span className={`px-2 py-0.5 text-xs rounded-full ${getStatusColor(sub.status)}`}>
                                {sub.status}
                              </span>
                              {sub.cancelAtPeriodEnd && (
                                <span className="px-2 py-0.5 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full">
                                  Cancelling
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              Current period: {new Date(sub.currentPeriodStart).toLocaleDateString()} - {new Date(sub.currentPeriodEnd).toLocaleDateString()}
                            </p>
                            <p className="text-xs text-gray-400 mt-1">ID: {sub.id}</p>
                          </div>
                          {sub.status === 'active' && !sub.cancelAtPeriodEnd && (
                            <button
                              onClick={() => handleCancelSubscription(sub.id)}
                              disabled={cancellingId === sub.id}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/50 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
                            >
                              {cancellingId === sub.id ? (
                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                              ) : (
                                <span aria-hidden="true" className="material-symbols-outlined text-base">cancel</span>
                              )}
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

const InvoicesView: React.FC = () => {
  const [searchEmail, setSearchEmail] = useState('');
  const [searchResults, setSearchResults] = useState<MemberSearchResult[]>([]);
  const [selectedMember, setSelectedMember] = useState<MemberSearchResult | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [stripeProducts, setStripeProducts] = useState<StripeProduct[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingInvoices, setIsLoadingInvoices] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [finalizingId, setFinalizingId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<InvoicePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [selectedPriceId, setSelectedPriceId] = useState('');
  const [invoiceAmount, setInvoiceAmount] = useState('');
  const [invoiceDescription, setInvoiceDescription] = useState('');

  useEffect(() => {
    fetchStripeProducts();
  }, []);

  const fetchStripeProducts = async () => {
    try {
      const res = await fetch('/api/stripe/products', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setStripeProducts(data.products || []);
      }
    } catch (err) {
      console.error('Failed to fetch stripe products:', err);
    }
  };

  const handleSearch = async () => {
    if (!searchEmail.trim()) return;
    try {
      setIsSearching(true);
      setError(null);
      setSelectedMember(null);
      setInvoices([]);

      const res = await fetch(`/api/billing/members/search?query=${encodeURIComponent(searchEmail.trim())}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to search members');
      const data = await res.json();
      
      const results = (data.members || []).map((m: any) => ({
        id: m.hubspotId || m.id,
        email: m.email,
        name: m.name,
        stripeCustomerId: m.stripeCustomerId || null,
        membershipTier: m.membershipTier || null,
      }));
      
      setSearchResults(results);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectMember = async (member: MemberSearchResult) => {
    setSelectedMember(member);
    setSearchResults([]);
    setPreviewData(null);
    setShowPreview(false);
    
    if (!member.stripeCustomerId) {
      setInvoices([]);
      return;
    }

    try {
      setIsLoadingInvoices(true);
      setError(null);
      const res = await fetch(`/api/stripe/invoices/${member.stripeCustomerId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load invoices');
      const data = await res.json();
      setInvoices(data.invoices || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load invoices');
    } finally {
      setIsLoadingInvoices(false);
    }
  };

  const handlePreviewInvoice = async () => {
    if (!selectedMember?.stripeCustomerId || !selectedPriceId) return;

    try {
      setLoadingPreview(true);
      setError(null);

      const res = await fetch(
        `/api/stripe/invoices/preview?customerId=${selectedMember.stripeCustomerId}&priceId=${selectedPriceId}`,
        { credentials: 'include' }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to preview invoice');
      }

      const data = await res.json();
      setPreviewData(data.preview);
      setShowPreview(true);
    } catch (err: any) {
      setError(err.message || 'Failed to preview invoice');
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleCreateInvoice = async () => {
    if (!selectedMember || (!invoiceAmount && !selectedPriceId)) return;

    let customerId = selectedMember.stripeCustomerId;

    if (!customerId) {
      try {
        setCreatingInvoice(true);
        setError(null);
        
        const customerRes = await fetch('/api/stripe/create-customer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: selectedMember.id,
            email: selectedMember.email,
            name: selectedMember.name,
          }),
        });
        
        if (!customerRes.ok) throw new Error('Failed to create Stripe customer');
        const customerData = await customerRes.json();
        customerId = customerData.customerId;
        selectedMember.stripeCustomerId = customerId;
      } catch (err: any) {
        setError(err.message || 'Failed to create customer');
        setCreatingInvoice(false);
        return;
      }
    }

    try {
      setCreatingInvoice(true);
      setError(null);

      const items = invoiceAmount
        ? [{ amountCents: Math.round(parseFloat(invoiceAmount) * 100), description: invoiceDescription || 'One-off charge' }]
        : [{ priceId: selectedPriceId, quantity: 1 }];

      const res = await fetch('/api/stripe/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          customerId,
          items,
          description: invoiceDescription || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create invoice');
      }

      setSuccessMessage('Draft invoice created');
      setTimeout(() => setSuccessMessage(null), 3000);
      setInvoiceAmount('');
      setInvoiceDescription('');
      setSelectedPriceId('');
      
      await handleSelectMember(selectedMember);
    } catch (err: any) {
      setError(err.message || 'Failed to create invoice');
    } finally {
      setCreatingInvoice(false);
    }
  };

  const handleFinalizeInvoice = async (invoiceId: string) => {
    try {
      setFinalizingId(invoiceId);
      setError(null);

      const res = await fetch(`/api/stripe/invoices/${invoiceId}/finalize`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to finalize invoice');
      }

      setSuccessMessage('Invoice finalized and sent');
      setTimeout(() => setSuccessMessage(null), 3000);
      
      if (selectedMember) {
        await handleSelectMember(selectedMember);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to finalize invoice');
    } finally {
      setFinalizingId(null);
    }
  };

  const handleVoidInvoice = async (invoiceId: string) => {
    if (!confirm('Are you sure you want to void this invoice?')) return;

    try {
      setVoidingId(invoiceId);
      setError(null);

      const res = await fetch(`/api/stripe/invoices/${invoiceId}/void`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to void invoice');
      }

      setSuccessMessage('Invoice voided');
      setTimeout(() => setSuccessMessage(null), 3000);
      
      if (selectedMember) {
        await handleSelectMember(selectedMember);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to void invoice');
    } finally {
      setVoidingId(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'paid': return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400';
      case 'open': return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400';
      case 'draft': return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400';
      case 'void': return 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400';
      case 'uncollectible': return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
      default: return 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400';
    }
  };

  const formatCurrency = (amount: number) => {
    return `$${(amount / 100).toFixed(2)}`;
  };

  return (
    <div className="space-y-6">
      {successMessage && (
        <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg text-green-700 dark:text-green-400 text-sm flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">check_circle</span>
          {successMessage}
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">error</span>
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 border border-gray-200 dark:border-white/25">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">search</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-primary dark:text-white">Find Member</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">Search by email to manage invoices</p>
          </div>
        </div>

        <div className="flex gap-3">
          <input
            type="text"
            value={searchEmail}
            onChange={(e) => setSearchEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Enter name or email..."
            className="flex-1 px-4 py-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            onClick={handleSearch}
            disabled={isSearching || !searchEmail.trim()}
            className="flex items-center gap-2 px-5 py-3 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isSearching ? (
              <span aria-hidden="true" className="material-symbols-outlined animate-spin">progress_activity</span>
            ) : (
              <span aria-hidden="true" className="material-symbols-outlined">search</span>
            )}
            Search
          </button>
        </div>

        {searchResults.length > 0 && (
          <div className="mt-4 space-y-2">
            {searchResults.map((member) => (
              <button
                key={member.id}
                onClick={() => handleSelectMember(member)}
                className="w-full p-3 text-left bg-gray-50 dark:bg-black/20 rounded-lg hover:bg-gray-100 dark:hover:bg-black/30 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium text-primary dark:text-white">{member.name}</p>
                  {member.membershipTier && (
                    <span className="text-xs px-2 py-1 rounded-full bg-accent/20 dark:bg-accent/30 text-primary dark:text-white">
                      {member.membershipTier}
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400">{member.email}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedMember && (
        <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 border border-gray-200 dark:border-white/25">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
                <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">person</span>
              </div>
              <div>
                <h3 className="text-lg font-bold text-primary dark:text-white">{selectedMember.name}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{selectedMember.email}</p>
              </div>
            </div>
            <button
              onClick={() => {
                setSelectedMember(null);
                setInvoices([]);
                setPreviewData(null);
                setShowPreview(false);
              }}
              className="p-2 text-gray-500 hover:text-primary dark:hover:text-white transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined">close</span>
            </button>
          </div>

          {isLoadingInvoices ? (
            <div className="py-8 flex justify-center">
              <WalkingGolferSpinner size="sm" variant="dark" />
            </div>
          ) : (
            <>
              <div className="mb-6 space-y-4">
                <h4 className="text-sm font-semibold text-primary dark:text-white">Preview Subscription Invoice</h4>
                <div className="flex gap-3">
                  <select
                    value={selectedPriceId}
                    onChange={(e) => setSelectedPriceId(e.target.value)}
                    className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    <option value="">Select a product...</option>
                    {stripeProducts.filter(p => p.isActive).map((product) => (
                      <option key={product.stripePriceId} value={product.stripePriceId}>
                        {product.name} - ${(product.priceCents / 100).toFixed(2)}/{product.billingInterval}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handlePreviewInvoice}
                    disabled={loadingPreview || !selectedPriceId || !selectedMember.stripeCustomerId}
                    className="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-white/10 text-primary dark:text-white border border-gray-200 dark:border-white/25 rounded-lg font-medium text-sm hover:bg-gray-50 dark:hover:bg-white/20 transition-colors disabled:opacity-50"
                  >
                    {loadingPreview ? (
                      <span aria-hidden="true" className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                    ) : (
                      <span aria-hidden="true" className="material-symbols-outlined text-base">preview</span>
                    )}
                    Preview
                  </button>
                </div>

                {showPreview && previewData && (
                  <div className="p-4 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700">
                    <h5 className="font-medium text-blue-800 dark:text-blue-300 mb-2">Invoice Preview</h5>
                    <p className="text-sm text-blue-700 dark:text-blue-400">
                      Amount Due: {formatCurrency(previewData.amountDue)}
                    </p>
                    <p className="text-sm text-blue-700 dark:text-blue-400">
                      Period: {new Date(previewData.periodStart).toLocaleDateString()} - {new Date(previewData.periodEnd).toLocaleDateString()}
                    </p>
                    {previewData.lines.map((line, i) => (
                      <p key={i} className="text-xs text-blue-600 dark:text-blue-500 mt-1">
                        • {line.description}: {formatCurrency(line.amount)}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              <div className="mb-6 space-y-4">
                <h4 className="text-sm font-semibold text-primary dark:text-white">Create One-off Invoice</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <input
                    type="number"
                    step="0.01"
                    min="0.50"
                    value={invoiceAmount}
                    onChange={(e) => setInvoiceAmount(e.target.value)}
                    placeholder="Amount ($)"
                    className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <input
                    type="text"
                    value={invoiceDescription}
                    onChange={(e) => setInvoiceDescription(e.target.value)}
                    placeholder="Description"
                    className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <button
                    onClick={handleCreateInvoice}
                    disabled={creatingInvoice || !invoiceAmount || parseFloat(invoiceAmount) < 0.50}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {creatingInvoice ? (
                      <span aria-hidden="true" className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                    ) : (
                      <span aria-hidden="true" className="material-symbols-outlined text-base">add</span>
                    )}
                    Create Draft
                  </button>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-primary dark:text-white mb-3">
                  Invoices ({invoices.length})
                </h4>
                {invoices.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    <span aria-hidden="true" className="material-symbols-outlined text-4xl mb-2">receipt_long</span>
                    <p>No invoices found</p>
                    {!selectedMember.stripeCustomerId && (
                      <p className="text-xs mt-1">This member doesn't have a Stripe customer account yet</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {invoices.map((invoice) => (
                      <div
                        key={invoice.id}
                        className="p-4 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`px-2 py-0.5 text-xs rounded-full ${getStatusColor(invoice.status)}`}>
                                {invoice.status}
                              </span>
                              <span className="font-semibold text-primary dark:text-white">
                                {formatCurrency(invoice.amountDue)}
                              </span>
                            </div>
                            {invoice.description && (
                              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">{invoice.description}</p>
                            )}
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                              Created: {new Date(invoice.created).toLocaleDateString()}
                              {invoice.dueDate && ` • Due: ${new Date(invoice.dueDate).toLocaleDateString()}`}
                              {invoice.paidAt && ` • Paid: ${new Date(invoice.paidAt).toLocaleDateString()}`}
                            </p>
                            <p className="text-xs text-gray-400 mt-1">ID: {invoice.id}</p>
                            {invoice.lines.length > 0 && (
                              <div className="mt-2 text-xs text-gray-500">
                                {invoice.lines.map((line, i) => (
                                  <p key={i}>• {line.description}: {formatCurrency(line.amount)}</p>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex gap-2">
                            {invoice.hostedInvoiceUrl && (
                              <a
                                href={invoice.hostedInvoiceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary dark:text-white bg-white dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg hover:bg-gray-50 dark:hover:bg-white/20 transition-colors"
                              >
                                <span aria-hidden="true" className="material-symbols-outlined text-base">open_in_new</span>
                                View
                              </a>
                            )}
                            {invoice.status === 'draft' && (
                              <button
                                onClick={() => handleFinalizeInvoice(invoice.id)}
                                disabled={finalizingId === invoice.id}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary dark:bg-accent dark:text-primary rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                              >
                                {finalizingId === invoice.id ? (
                                  <span aria-hidden="true" className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                                ) : (
                                  <span aria-hidden="true" className="material-symbols-outlined text-base">send</span>
                                )}
                                Send
                              </button>
                            )}
                            {(invoice.status === 'draft' || invoice.status === 'open') && (
                              <button
                                onClick={() => handleVoidInvoice(invoice.id)}
                                disabled={voidingId === invoice.id}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/50 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
                              >
                                {voidingId === invoice.id ? (
                                  <span aria-hidden="true" className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                                ) : (
                                  <span aria-hidden="true" className="material-symbols-outlined text-base">block</span>
                                )}
                                Void
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default BillingTab;
