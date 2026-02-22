import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useData } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { fetchWithCredentials } from '../../hooks/queries/useFetch';
import TabButton from '../../components/TabButton';
import SwipeablePage from '../../components/SwipeablePage';
import MemberBottomNav from '../../components/MemberBottomNav';
import { BottomSentinel } from '../../components/layout/BottomSentinel';
import { formatTime12Hour, getRelativeDateLabel } from '../../utils/dateUtils';
import InvoicePaymentModal from '../../components/billing/InvoicePaymentModal';
import { AnimatedPage } from '../../components/motion';
import { TabTransition } from '../../components/motion/TabTransition';
import { useAutoAnimate } from '@formkit/auto-animate/react';

interface UnifiedVisit {
  id: number;
  type: 'booking' | 'wellness' | 'event';
  role: 'Host' | 'Player' | 'Guest' | 'Wellness' | 'Event';
  date: string;
  startTime: string | null;
  endTime: string | null;
  resourceName: string;
  location?: string;
  category?: string;
  invitedBy?: string;
}

interface UnifiedPurchase {
  id: string;
  type: 'legacy' | 'stripe';
  itemName: string;
  itemCategory: string | null;
  amountCents: number;
  date: string;
  status: string;
  source: string;
  quantity?: number;
  hostedInvoiceUrl?: string | null;
  stripeInvoiceId?: string;
  stripePaymentIntentId?: string | null;
}

const History: React.FC = () => {
  const { user } = useData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const isDark = effectiveTheme === 'dark';
  
  const initialTab = searchParams.get('tab') === 'payments' ? 'payments' : 'visits';
  const [activeTab, setActiveTab] = useState<'visits' | 'payments'>(initialTab);
  const [payingInvoice, setPayingInvoice] = useState<UnifiedPurchase | null>(null);
  const [visitsParent] = useAutoAnimate();
  const [purchasesParent] = useAutoAnimate();

  const { data: visits = [], isLoading: visitsLoading, refetch: refetchVisits } = useQuery({
    queryKey: ['my-visits', user?.email],
    queryFn: () => fetchWithCredentials<UnifiedVisit[]>(
      `/api/my-visits?user_email=${encodeURIComponent(user?.email || '')}`
    ),
    enabled: !!user?.email,
  });

  const { data: purchases = [], isLoading: purchasesLoading, refetch: refetchPurchases } = useQuery({
    queryKey: ['my-purchases', user?.email],
    queryFn: () => fetchWithCredentials<UnifiedPurchase[]>(
      `/api/my-unified-purchases?user_email=${encodeURIComponent(user?.email || '')}`
    ),
    enabled: !!user?.email,
  });

  const isLoading = visitsLoading || purchasesLoading;

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  useEffect(() => {
    const handleBillingUpdate = () => {
      queryClient.invalidateQueries({ queryKey: ['my-purchases', user?.email] });
    };

    window.addEventListener('billing-update', handleBillingUpdate);
    return () => {
      window.removeEventListener('billing-update', handleBillingUpdate);
    };
  }, [queryClient, user?.email]);


  const getRoleBadgeStyle = (role: string): string => {
    switch (role) {
      case 'Host':
        return isDark ? 'bg-accent/20 text-accent' : 'bg-accent/20 text-brand-green';
      case 'Player':
        return isDark ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-100 text-blue-700';
      case 'Guest':
        return isDark ? 'bg-orange-500/20 text-orange-300' : 'bg-orange-100 text-orange-700';
      case 'Wellness':
        return isDark ? 'bg-purple-500/20 text-purple-300' : 'bg-purple-100 text-purple-700';
      case 'Event':
        return isDark ? 'bg-pink-500/20 text-pink-300' : 'bg-pink-100 text-pink-700';
      default:
        return isDark ? 'bg-white/10 text-white/70' : 'bg-gray-100 text-gray-700';
    }
  };

  const getRoleIcon = (role: string, type: string): string => {
    if (type === 'wellness') return 'spa';
    if (type === 'event') return 'celebration';
    switch (role) {
      case 'Host':
        return 'person';
      case 'Player':
        return 'group';
      case 'Guest':
        return 'person_add';
      default:
        return 'golf_course';
    }
  };

  return (
    <AnimatedPage>
      <SwipeablePage className="px-6 lg:px-8 xl:px-12 relative overflow-hidden">
        <section className="mb-4 pt-4 md:pt-2 animate-content-enter-delay-1">
          <h1 className={`text-3xl font-bold leading-tight drop-shadow-md ${isDark ? 'text-white' : 'text-primary'}`}>History</h1>
          <p className={`text-sm font-medium mt-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Your past visits</p>
        </section>

        <section className={`mb-6 border-b -mx-6 px-6 animate-content-enter-delay-2 ${isDark ? 'border-white/25' : 'border-black/10'}`}>
          <div className="flex gap-6 overflow-x-auto pb-0 scrollbar-hide scroll-fade-right">
            <TabButton label="Visits" active={activeTab === 'visits'} onClick={() => setActiveTab('visits')} isDark={isDark} />
            <TabButton label="Payments" icon="payments" active={activeTab === 'payments'} onClick={() => setActiveTab('payments')} isDark={isDark} />
          </div>
        </section>

        <TabTransition activeKey={activeTab}>
        <div className="relative z-10 animate-content-enter-delay-3">
          {isLoading ? (
            <div className="animate-pulse space-y-4">
              {[1, 2, 3].map(i => (
                <div key={i} className={`h-24 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-black/5'}`} />
              ))}
            </div>
          ) : activeTab === 'visits' ? (
            <div className="space-y-4">
              <div className={`text-sm font-medium ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                {visits.length} past visit{visits.length !== 1 ? 's' : ''}
              </div>
              {visits.length === 0 ? (
                <div className={`text-center py-12 rounded-2xl border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}>
                  <span className={`material-symbols-outlined text-5xl mb-4 ${isDark ? 'text-white/30' : 'text-primary/30'}`}>history</span>
                  <p className={`${isDark ? 'text-white/80' : 'text-primary/80'}`}>No past visits yet</p>
                </div>
              ) : (
                <div ref={visitsParent} className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {visits.map((visit, index) => {
                    const isConferenceRoom = visit.category === 'Conference Room';
                    
                    return (
                    <div 
                      key={`${visit.type}-${visit.id}`} 
                      className={`rounded-xl p-4 border glass-card animate-list-item-delay-${Math.min(index, 10)} ${isDark ? 'border-white/25' : 'border-black/10'}`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 ${getRoleBadgeStyle(visit.role)}`}>
                              <span className="material-symbols-outlined text-xs">{getRoleIcon(visit.role, visit.type)}</span>
                              {visit.role}
                            </span>
                            {visit.category && visit.type === 'booking' && (
                              <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                                isConferenceRoom
                                  ? (isDark ? 'bg-blue-500/15 text-blue-300' : 'bg-blue-100 text-blue-700')
                                  : (isDark ? 'bg-white/10 text-white/70' : 'bg-gray-100 text-gray-700')
                              }`}>
                                {visit.category}
                              </span>
                            )}
                          </div>
                          <p className={`font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                            {getRelativeDateLabel(visit.date?.split('T')[0] || visit.date)}
                          </p>
                          {visit.startTime && (
                            <p className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                              {formatTime12Hour(visit.startTime)}
                              {visit.endTime && ` - ${formatTime12Hour(visit.endTime)}`}
                            </p>
                          )}
                        </div>
                      </div>
                      <p className={`text-sm flex items-center gap-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                        <span className="material-symbols-outlined text-sm">
                          {visit.type === 'wellness' ? 'spa' : visit.type === 'event' ? 'location_on' : isConferenceRoom ? 'meeting_room' : 'golf_course'}
                        </span>
                        {visit.resourceName}
                      </p>
                      {visit.location && visit.type === 'event' && (
                        <p className={`text-xs mt-1 flex items-center gap-1 ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                          <span className="material-symbols-outlined text-xs">pin_drop</span>
                          {visit.location}
                        </p>
                      )}
                      {visit.role === 'Guest' && visit.invitedBy && (
                        <p className={`text-xs mt-2 flex items-center gap-1 ${isDark ? 'text-orange-300/80' : 'text-orange-600'}`}>
                          <span className="material-symbols-outlined text-xs">person</span>
                          Invited by {visit.invitedBy}
                        </p>
                      )}
                      {visit.role === 'Player' && visit.invitedBy && (
                        <p className={`text-xs mt-2 flex items-center gap-1 ${isDark ? 'text-blue-300/80' : 'text-blue-600'}`}>
                          <span className="material-symbols-outlined text-xs">person</span>
                          Played with {visit.invitedBy}
                        </p>
                      )}
                      {visit.role === 'Wellness' && visit.invitedBy && (
                        <p className={`text-xs mt-1 flex items-center gap-1 ${isDark ? 'text-purple-300/80' : 'text-purple-600'}`}>
                          <span className="material-symbols-outlined text-xs">person</span>
                          Instructor: {visit.invitedBy}
                        </p>
                      )}
                    </div>
                  );})}
                </div>
              )}
            </div>
          ) : activeTab === 'payments' ? (
            <div className="space-y-4">
              <div className={`text-sm font-medium ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                {purchases.length} payment{purchases.length !== 1 ? 's' : ''}
              </div>
              {purchases.length === 0 ? (
                <div className={`text-center py-12 rounded-2xl border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}>
                  <span className={`material-symbols-outlined text-5xl mb-4 ${isDark ? 'text-white/30' : 'text-primary/30'}`}>payments</span>
                  <p className={`${isDark ? 'text-white/80' : 'text-primary/80'}`}>No payments yet</p>
                  <p className={`text-sm mt-1 ${isDark ? 'text-white/50' : 'text-primary/50'}`}>Your payment history will appear here</p>
                </div>
              ) : (
                <div ref={purchasesParent} className="space-y-6">
                  {(() => {
                    const categoryIcons: Record<string, string> = {
                      sim_walk_in: 'golf_course',
                      guest_pass: 'badge',
                      guest_fee: 'group_add',
                      overage_fee: 'schedule',
                      one_time_purchase: 'payments',
                      membership: 'card_membership',
                      cafe: 'local_cafe',
                      retail: 'shopping_bag',
                      payment: 'paid',
                      invoice: 'description',
                      other: 'receipt',
                    };
                    
                    const categoryColors: Record<string, { dark: string; light: string }> = {
                      sim_walk_in: { dark: 'bg-blue-500/20 text-blue-300', light: 'bg-blue-100 text-blue-700' },
                      guest_pass: { dark: 'bg-purple-500/20 text-purple-300', light: 'bg-purple-100 text-purple-700' },
                      guest_fee: { dark: 'bg-indigo-500/20 text-indigo-300', light: 'bg-indigo-100 text-indigo-700' },
                      overage_fee: { dark: 'bg-rose-500/20 text-rose-300', light: 'bg-rose-100 text-rose-700' },
                      one_time_purchase: { dark: 'bg-accent/20 text-accent', light: 'bg-accent/20 text-brand-green' },
                      membership: { dark: 'bg-accent/20 text-accent', light: 'bg-accent/20 text-brand-green' },
                      cafe: { dark: 'bg-orange-500/20 text-orange-300', light: 'bg-orange-100 text-orange-700' },
                      retail: { dark: 'bg-pink-500/20 text-pink-300', light: 'bg-pink-100 text-pink-700' },
                      payment: { dark: 'bg-teal-500/20 text-teal-300', light: 'bg-teal-100 text-teal-700' },
                      invoice: { dark: 'bg-slate-500/20 text-slate-300', light: 'bg-slate-100 text-slate-700' },
                    };
                    
                    const getCategoryStyle = (category: string) => {
                      const colors = categoryColors[category?.toLowerCase()] || { dark: 'bg-amber-500/20 text-amber-300', light: 'bg-amber-100 text-amber-700' };
                      return isDark ? colors.dark : colors.light;
                    };
                    
                    const getCategoryIcon = (category: string) => {
                      return categoryIcons[category?.toLowerCase()] || 'receipt';
                    };
                    
                    const formatCategoryLabel = (category: string | null): string => {
                      if (!category) return 'Purchase';
                      const labels: Record<string, string> = {
                        guest_fee: 'Guest Fee',
                        overage_fee: 'Overage',
                        one_time_purchase: 'Charge',
                        sim_walk_in: 'Simulator',
                        guest_pass: 'Guest Pass',
                        membership: 'Membership',
                        cafe: 'Cafe',
                        retail: 'Retail',
                        payment: 'Payment',
                        invoice: 'Invoice',
                      };
                      return labels[category.toLowerCase()] || category;
                    };
                    
                    const formatCurrency = (cents: number): string => {
                      if (cents == null || isNaN(cents)) return '$0.00';
                      return `$${(cents / 100).toFixed(2)}`;
                    };
                    
                    const sourceColors: Record<string, { dark: string; light: string }> = {
                      Mindbody: { dark: 'bg-white/10 text-white/80', light: 'bg-primary/10 text-primary' },
                      Stripe: { dark: 'bg-accent/20 text-accent', light: 'bg-accent/20 text-primary' },
                      'Ever Club': { dark: 'bg-lavender/30 text-lavender', light: 'bg-lavender/20 text-primary' },
                      Cash: { dark: 'bg-emerald-500/20 text-emerald-300', light: 'bg-emerald-100 text-emerald-700' },
                      Check: { dark: 'bg-cyan-500/20 text-cyan-300', light: 'bg-cyan-100 text-cyan-700' },
                    };
                    
                    const getSourceStyle = (source: string) => {
                      const colors = sourceColors[source] || { dark: 'bg-white/10 text-white/80', light: 'bg-primary/10 text-primary' };
                      return isDark ? colors.dark : colors.light;
                    };
                    
                    const groupedByMonth: { [key: string]: UnifiedPurchase[] } = {};
                    purchases.forEach(p => {
                      const date = new Date(p.date);
                      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                      if (!groupedByMonth[monthKey]) {
                        groupedByMonth[monthKey] = [];
                      }
                      groupedByMonth[monthKey].push(p);
                    });
                    
                    const sortedMonths = Object.keys(groupedByMonth).sort((a, b) => b.localeCompare(a));
                    
                    return sortedMonths.map((monthKey, monthIndex) => {
                      const monthPurchases = groupedByMonth[monthKey];
                      const [year, month] = monthKey.split('-');
                      const monthLabel = new Date(parseInt(year), parseInt(month) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/Los_Angeles' });
                      
                      return (
                        <div key={monthKey} className="animate-slide-up-stagger" style={{ '--stagger-index': monthIndex } as React.CSSProperties}>
                          <h3 className={`text-sm font-semibold mb-3 ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                            {monthLabel}
                          </h3>
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                            {monthPurchases.map((purchase, index) => (
                              <div 
                                key={purchase.id} 
                                className={`rounded-xl p-4 border glass-card animate-slide-up-stagger ${isDark ? 'border-white/25' : 'border-black/10'}`}
                                style={{ '--stagger-index': monthIndex + index + 1 } as React.CSSProperties}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 ${getCategoryStyle(purchase.itemCategory || '')}`}>
                                        <span className="material-symbols-outlined text-xs">{getCategoryIcon(purchase.itemCategory || '')}</span>
                                        {formatCategoryLabel(purchase.itemCategory)}
                                      </span>
                                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${getSourceStyle(purchase.source)}`}>
                                        {purchase.source}
                                      </span>
                                      {(purchase.quantity ?? 1) > 1 && (
                                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${isDark ? 'bg-white/10 text-white/70' : 'bg-primary/10 text-primary/70'}`}>
                                          x{purchase.quantity}
                                        </span>
                                      )}
                                    </div>
                                    <p className={`font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                                      {purchase.itemName}
                                    </p>
                                    <p className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                                      {getRelativeDateLabel(purchase.date?.split('T')[0] || purchase.date)}
                                    </p>
                                  </div>
                                  <div className="text-right flex-shrink-0">
                                    <p className={`text-lg font-bold ${purchase.status === 'open' ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-accent' : 'text-brand-green')}`}>
                                      {formatCurrency(purchase.amountCents)}
                                    </p>
                                    {purchase.itemCategory === 'invoice' && purchase.status === 'open' && (
                                      <button
                                        onClick={() => setPayingInvoice(purchase)}
                                        className="tactile-btn bg-primary text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-primary/90 transition-colors flex items-center gap-1.5 mt-2 ml-auto"
                                      >
                                        <span className="material-symbols-outlined text-sm">credit_card</span>
                                        Pay Now
                                      </button>
                                    )}
                                    {purchase.hostedInvoiceUrl && purchase.status !== 'open' && (
                                      <a 
                                        href={purchase.hostedInvoiceUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className={`tactile-btn text-xs flex items-center gap-0.5 justify-end mt-1 ${isDark ? 'text-accent hover:text-accent/80' : 'text-brand-green hover:text-brand-green/80'}`}
                                      >
                                        View
                                        <span className="material-symbols-outlined text-xs">open_in_new</span>
                                      </a>
                                    )}
                                    {!purchase.hostedInvoiceUrl && purchase.stripePaymentIntentId && (
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          try {
                                            const resp = await fetchWithCredentials<{ receiptUrl: string }>(
                                              `/api/my-billing/receipt/${purchase.stripePaymentIntentId}`
                                            );
                                            if (resp.receiptUrl) {
                                              window.open(resp.receiptUrl, '_blank', 'noopener,noreferrer');
                                            }
                                          } catch (e) {
                                          }
                                        }}
                                        className={`tactile-btn text-xs flex items-center gap-0.5 justify-end mt-1 ${isDark ? 'text-accent hover:text-accent/80' : 'text-brand-green hover:text-brand-green/80'}`}
                                      >
                                        View
                                        <span className="material-symbols-outlined text-xs">open_in_new</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          ) : null}
        </div>
        </TabTransition>

        <BottomSentinel />
      </SwipeablePage>
      <MemberBottomNav currentPath="/history" isDarkTheme={isDark} />

      {user && (
        <InvoicePaymentModal
          isOpen={!!(payingInvoice && payingInvoice.stripeInvoiceId)}
          invoice={{
            id: payingInvoice?.stripeInvoiceId || '',
            status: payingInvoice?.status || '',
            amountDue: payingInvoice?.amountCents || 0,
            description: payingInvoice?.itemName || null,
            lines: [{ description: payingInvoice?.itemName || '', amount: payingInvoice?.amountCents || 0, quantity: 1 }],
          }}
          userEmail={user.email || ''}
          userName={user.name || user.email?.split('@')[0] || 'Member'}
          onSuccess={async () => {
            setPayingInvoice(null);
            queryClient.invalidateQueries({ queryKey: ['my-purchases', user?.email] });
          }}
          onClose={() => setPayingInvoice(null)}
        />
      )}
    </AnimatedPage>
  );
};

export default History;
