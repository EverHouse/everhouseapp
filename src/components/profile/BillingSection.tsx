import React, { useState, useEffect } from 'react';
import { useToast } from '../Toast';
import { useData } from '../../contexts/DataContext';

interface BillingInfo {
  billingProvider: 'stripe' | 'mindbody' | 'family_addon' | 'comped' | null;
  tier: string;
  billingMigrationRequestedAt?: string;
  subscription?: {
    status: string;
    currentPeriodEnd: number | null;
    cancelAtPeriodEnd: boolean;
    isPaused: boolean;
  };
  paymentMethods?: Array<{
    id: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  }>;
  customerBalanceDollars?: number;
  familyGroup?: {
    primaryName: string;
    primaryEmail: string;
  };
  stripeError?: string;
  upcomingChanges?: {
    cancelAtPeriodEnd: boolean;
    cancelAt: number | null;
    pausedUntil: number | null;
    pendingTierChange: {
      newPlanName: string;
      effectiveDate: number;
    } | null;
  };
}

interface Invoice {
  id: string;
  number: string;
  status: string;
  amountDue: number;
  amountPaid: number;
  created: number;
  hostedInvoiceUrl: string;
  invoicePdf: string;
}

interface Props {
  isDark: boolean;
}

export default function BillingSection({ isDark }: Props) {
  const { showToast } = useToast();
  const { viewAsUser } = useData();
  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvoices, setShowInvoices] = useState(false);
  const [updatingPayment, setUpdatingPayment] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [migratingPayment, setMigratingPayment] = useState(false);

  const fetchBillingData = () => {
    const emailParam = viewAsUser?.email ? `?email=${encodeURIComponent(viewAsUser.email)}` : '';
    Promise.all([
      fetch(`/api/my/billing${emailParam}`, { credentials: 'include' }).then(r => r.ok ? r.json() : null),
      fetch(`/api/my/billing/invoices${emailParam}`, { credentials: 'include' }).then(r => r.ok ? r.json() : { invoices: [] }),
    ]).then(([billing, invoiceData]) => {
      setBillingInfo(billing);
      setInvoices(invoiceData?.invoices || []);
    }).catch(() => {})
    .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchBillingData();
  }, [viewAsUser?.email]);

  useEffect(() => {
    const handleBillingUpdate = () => {
      fetchBillingData();
    };

    window.addEventListener('billing-update', handleBillingUpdate);
    return () => {
      window.removeEventListener('billing-update', handleBillingUpdate);
    };
  }, [viewAsUser?.email]);

  const handleUpdatePaymentMethod = async () => {
    setUpdatingPayment(true);
    try {
      const res = await fetch('/api/my/billing/update-payment-method', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        showToast('Unable to update payment method', 'error');
      }
    } catch {
      showToast('Failed to open payment portal', 'error');
    } finally {
      setUpdatingPayment(false);
    }
  };

  const handleOpenBillingPortal = async () => {
    setOpeningPortal(true);
    const portalWindow = window.open('about:blank', '_blank');
    try {
      const emailParam = viewAsUser?.email ? JSON.stringify({ email: viewAsUser.email }) : '{}';
      const res = await fetch('/api/my/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: emailParam,
      });
      const data = await res.json();
      if (data.url) {
        if (portalWindow) {
          portalWindow.location.href = data.url;
        } else {
          window.location.href = data.url;
        }
      } else {
        portalWindow?.close();
        showToast(data.error || 'Unable to open billing portal', 'error');
      }
    } catch {
      portalWindow?.close();
      showToast('Failed to open billing portal', 'error');
    } finally {
      setOpeningPortal(false);
    }
  };

  const handleAddPaymentMethod = async () => {
    setMigratingPayment(true);
    try {
      const res = await fetch('/api/my/billing/add-payment-method-for-extras', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        showToast(data.error || 'Unable to add payment method', 'error');
      }
    } catch {
      showToast('Failed to open payment portal', 'error');
    } finally {
      setMigratingPayment(false);
    }
  };

  if (loading) {
    return (
      <div className={`rounded-2xl overflow-hidden ${isDark ? 'bg-white/5' : 'bg-white'}`}>
        <div className="p-4">
          <div className="animate-pulse space-y-3">
            <div className={`h-4 w-32 rounded ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
            <div className={`h-4 w-48 rounded ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
          </div>
        </div>
      </div>
    );
  }

  if (!billingInfo || !billingInfo.billingProvider) {
    return null;
  }

  const formatDate = (timestamp: number) => {
    if (!timestamp || timestamp <= 0) {
      return 'Date unavailable';
    }
    const date = new Date(timestamp * 1000);
    if (date.getFullYear() < 2000) {
      return 'Date unavailable';
    }
    return date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles'
    });
  };

  const formatCurrency = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
      case 'trialing':
      case 'paid':
        return 'text-green-600';
      case 'past_due':
        return 'text-amber-600';
      case 'canceled':
      case 'unpaid':
        return 'text-red-600';
      default:
        return isDark ? 'text-white/70' : 'text-primary/70';
    }
  };

  if (billingInfo.billingProvider === 'stripe') {
    const sub = billingInfo.subscription;
    const card = billingInfo.paymentMethods?.[0];
    
    if (billingInfo.stripeError) {
      return (
        <div className={`rounded-2xl overflow-hidden ${isDark ? 'bg-white/5' : 'bg-white'}`}>
          <div className="p-4">
            <div className="flex items-center gap-3">
              <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                credit_card
              </span>
              <div>
                <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Billing</span>
                <p className={`text-xs mt-0.5 ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                  Unable to load billing details. Please try again later.
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }
    
    return (
      <div className={`rounded-2xl overflow-hidden ${isDark ? 'bg-white/5' : 'bg-white'}`}>
        <div className={`p-4 ${isDark ? '' : ''}`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                credit_card
              </span>
              <div>
                <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Membership</span>
                {sub && (
                  <p className={`text-xs mt-0.5 ${getStatusColor(sub.status)}`}>
                    {sub.isPaused ? 'Paused' : sub.cancelAtPeriodEnd ? 'Cancels at period end' : sub.status === 'active' ? 'Active' : sub.status}
                  </p>
                )}
                {!sub && (
                  <p className={`text-xs mt-0.5 ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                    No active subscription
                  </p>
                )}
              </div>
            </div>
            {sub && !sub.isPaused && !sub.cancelAtPeriodEnd && sub.currentPeriodEnd && (
              <span className={`text-xs ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                Renews {formatDate(sub.currentPeriodEnd)}
              </span>
            )}
          </div>
          
          <button
            onClick={handleOpenBillingPortal}
            disabled={openingPortal}
            className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium text-sm transition-all duration-fast disabled:opacity-50 tactile-btn ${
              isDark 
                ? 'bg-accent/20 text-accent hover:bg-accent/30' 
                : 'bg-primary/10 text-primary hover:bg-primary/20'
            }`}
          >
            {openingPortal ? (
              <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
            ) : (
              <span className="material-symbols-outlined text-lg">manage_accounts</span>
            )}
            {openingPortal ? 'Opening...' : 'Manage Subscription'}
          </button>
          
          {card && (
            <div className={`flex items-center justify-between py-3 border-t ${isDark ? 'border-white/10' : 'border-black/5'}`}>
              <div className="flex items-center gap-3">
                <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-50' : 'text-primary/50'}`}>
                  payment
                </span>
                <span className={`text-sm ${isDark ? 'opacity-80' : 'text-primary/80'}`}>
                  {card.brand?.charAt(0).toUpperCase()}{card.brand?.slice(1)} ending in {card.last4}
                </span>
              </div>
              <button
                onClick={handleUpdatePaymentMethod}
                disabled={updatingPayment}
                className={`text-xs font-medium ${isDark ? 'text-accent' : 'text-primary'} hover:underline disabled:opacity-50 tactile-btn`}
              >
                {updatingPayment ? 'Loading...' : 'Update'}
              </button>
            </div>
          )}
          
          {billingInfo.customerBalanceDollars !== undefined && billingInfo.customerBalanceDollars < 0 && (
            <div className={`flex items-center justify-between py-3 border-t ${isDark ? 'border-white/10' : 'border-black/5'}`}>
              <span className={`text-sm ${isDark ? 'opacity-80' : 'text-primary/80'}`}>Account Credit</span>
              <span className={`text-sm font-medium text-green-600`}>
                ${Math.abs(billingInfo.customerBalanceDollars).toFixed(2)}
              </span>
            </div>
          )}
          
          {billingInfo.upcomingChanges && (
            <div className={`mt-3 p-3 rounded-lg ${isDark ? 'bg-yellow-900/20 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-yellow-500 text-lg">schedule</span>
                <span className={`text-sm font-medium ${isDark ? 'text-yellow-400' : 'text-yellow-700'}`}>Upcoming Changes</span>
              </div>
              <div className={`text-sm ${isDark ? 'text-yellow-300/80' : 'text-yellow-700'}`}>
                {billingInfo.upcomingChanges.cancelAtPeriodEnd && billingInfo.upcomingChanges.cancelAt && (
                  <p>Your membership will cancel on {formatDate(billingInfo.upcomingChanges.cancelAt)}</p>
                )}
                {billingInfo.upcomingChanges.pausedUntil && (
                  <p>Your membership is paused until {formatDate(billingInfo.upcomingChanges.pausedUntil)}</p>
                )}
                {billingInfo.upcomingChanges.pendingTierChange && (
                  <p>Your plan will change to {billingInfo.upcomingChanges.pendingTierChange.newPlanName} on {formatDate(billingInfo.upcomingChanges.pendingTierChange.effectiveDate)}</p>
                )}
              </div>
            </div>
          )}
          
          <button
            onClick={() => setShowInvoices(!showInvoices)}
            className={`w-full flex items-center justify-between py-3 border-t tactile-btn ${isDark ? 'border-white/10' : 'border-black/5'}`}
          >
            <div className="flex items-center gap-3">
              <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-50' : 'text-primary/50'}`}>
                receipt_long
              </span>
              <span className={`text-sm ${isDark ? 'opacity-80' : 'text-primary/80'}`}>Invoices</span>
            </div>
            <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-50' : 'text-primary/50'}`}>
              {showInvoices ? 'expand_less' : 'expand_more'}
            </span>
          </button>
          
          {showInvoices && invoices.length > 0 && (
            <div className={`border-t ${isDark ? 'border-white/10' : 'border-black/5'}`}>
              {invoices.slice(0, 5).map((invoice) => (
                <div key={invoice.id} className={`flex items-center justify-between py-3 px-2 ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
                  <div>
                    <p className={`text-sm ${isDark ? '' : 'text-primary'}`}>
                      {invoice.number || 'Invoice'}
                    </p>
                    <p className={`text-xs ${isDark ? 'opacity-50' : 'text-primary/50'}`}>
                      {formatDate(invoice.created)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-medium ${getStatusColor(invoice.status)}`}>
                      {formatCurrency(invoice.amountPaid || invoice.amountDue)}
                    </span>
                    {invoice.hostedInvoiceUrl && (
                      <a
                        href={invoice.hostedInvoiceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`text-xs ${isDark ? 'text-accent' : 'text-primary'} hover:underline`}
                      >
                        View
                      </a>
                    )}
                    {invoice.invoicePdf && (
                      <a
                        href={invoice.invoicePdf}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`text-xs ${isDark ? 'text-accent/70' : 'text-primary/70'} hover:underline`}
                      >
                        PDF
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          
          {showInvoices && invoices.length === 0 && (
            <p className={`text-sm py-3 ${isDark ? 'opacity-50' : 'text-primary/50'}`}>No invoices yet</p>
          )}
        </div>
      </div>
    );
  }

  if (billingInfo.billingProvider === 'mindbody') {
    const hasPaymentMethod = billingInfo.paymentMethods && billingInfo.paymentMethods.length > 0;
    
    return (
      <div className={`rounded-2xl overflow-hidden ${isDark ? 'bg-white/5' : 'bg-white'}`}>
        <div className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
              credit_card
            </span>
            <div>
              <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Billing</span>
              <p className={`text-xs mt-0.5 ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                Subscription through Mindbody
              </p>
            </div>
          </div>
          
          {hasPaymentMethod ? (
            <div className={`p-3 rounded-lg mb-4 ${isDark ? 'bg-green-900/20 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-green-500 text-lg">check_circle</span>
                <span className={`text-sm font-medium ${isDark ? 'text-green-400' : 'text-green-700'}`}>
                  Payment method on file
                </span>
              </div>
              <p className={`text-sm mt-1 ${isDark ? 'text-green-300/80' : 'text-green-700'}`}>
                Your card ending in {billingInfo.paymentMethods[0].last4} will be used for any additional charges.
              </p>
            </div>
          ) : (
            <p className={`text-sm mb-4 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
              Add a payment method for overage fees, guest passes, and other club purchases.
            </p>
          )}
          
          <button
            onClick={handleAddPaymentMethod}
            disabled={migratingPayment}
            className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium text-sm transition-all duration-fast disabled:opacity-50 tactile-btn ${
              isDark 
                ? 'bg-accent/20 text-accent hover:bg-accent/30' 
                : 'bg-primary/10 text-primary hover:bg-primary/20'
            }`}
          >
            {migratingPayment ? (
              <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
            ) : (
              <span className="material-symbols-outlined text-lg">credit_card</span>
            )}
            {migratingPayment ? 'Opening...' : hasPaymentMethod ? 'Update Payment Method' : 'Add Payment Method'}
          </button>
          
          {/* Show Stripe payments for overage fees, guest passes, etc. */}
          {invoices.length > 0 && (
            <div className="mt-4 pt-4 border-t border-white/10">
              <button
                className={`w-full flex items-center justify-between py-2 text-sm font-medium tactile-btn ${isDark ? 'opacity-80 hover:opacity-100' : 'text-primary/80 hover:text-primary'}`}
                onClick={() => setShowInvoices(!showInvoices)}
              >
                <span className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg">receipt_long</span>
                  Club Purchases
                </span>
                <span className="material-symbols-outlined text-sm">
                  {showInvoices ? 'expand_less' : 'expand_more'}
                </span>
              </button>
              
              {showInvoices && (
                <div className="space-y-2 mt-2">
                  {invoices.map(inv => (
                    <a
                      key={inv.id}
                      href={inv.hostedInvoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`flex items-center justify-between p-2.5 rounded-lg transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-primary/5'}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                          inv.status === 'paid'
                            ? isDark ? 'bg-green-500/20 text-green-400' : 'bg-green-100 text-green-700'
                            : isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-700'
                        }`}>
                          {inv.status}
                        </span>
                        <span className={`text-xs ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                          {new Date(inv.created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${isDark ? '' : 'text-primary'}`}>
                          ${(inv.amountPaid / 100).toFixed(2)}
                        </span>
                        <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-50' : 'text-primary/50'}`}>open_in_new</span>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (billingInfo.billingProvider === 'family_addon') {
    return (
      <div className={`rounded-2xl overflow-hidden ${isDark ? 'bg-white/5' : 'bg-white'}`}>
        <div className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
              groups
            </span>
            <div>
              <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Group Membership</span>
              <p className={`text-xs mt-0.5 ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                Add-on member
              </p>
            </div>
          </div>
          {billingInfo.familyGroup && (
            <p className={`text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
              Your membership is covered by {billingInfo.familyGroup.primaryName || billingInfo.familyGroup.primaryEmail}.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (billingInfo.billingProvider === 'comped') {
    return (
      <div className={`rounded-2xl overflow-hidden ${isDark ? 'bg-white/5' : 'bg-white'}`}>
        <div className="p-4">
          <div className="flex items-center gap-3">
            <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
              verified
            </span>
            <div>
              <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Complimentary Access</span>
              <p className={`text-xs mt-0.5 ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                No billing required
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
