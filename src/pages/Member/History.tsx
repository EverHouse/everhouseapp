import React, { useState, useEffect, useCallback } from 'react';
import { useData } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { apiRequest } from '../../lib/apiRequest';
import TabButton from '../../components/TabButton';
import SwipeablePage from '../../components/SwipeablePage';
import PullToRefresh from '../../components/PullToRefresh';
import MemberBottomNav from '../../components/MemberBottomNav';
import { BottomSentinel } from '../../components/layout/BottomSentinel';
import { formatDateShort, getTodayString, formatTime12Hour, getNowTimePacific, getRelativeDateLabel } from '../../utils/dateUtils';
import { getStatusColor, formatStatusLabel } from '../../utils/statusColors';
import InvoicePaymentModal from '../../components/billing/InvoicePaymentModal';
import { AnimatedPage } from '../../components/motion';

interface Participant {
  name: string;
  type: 'member' | 'guest';
}

interface BookingRecord {
  id: number;
  resource_id: number;
  bay_name?: string;
  resource_name?: string;
  resource_preference?: string;
  user_email: string;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes?: number;
  status: string;
  notes: string;
  participants?: Participant[];
}

interface RSVPRecord {
  id: number;
  event_id: number;
  status: string;
  title: string;
  event_date: string;
  start_time: string;
  location: string;
  category: string;
  order_date?: string;
  created_at?: string;
}

interface WellnessEnrollmentRecord {
  id: number;
  class_id: number;
  user_email: string;
  status: string;
  title: string;
  date: string;
  time: string;
  instructor: string;
  duration: string;
  category: string;
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

const normalizeTime = (time: string | null | undefined): string => {
  if (!time) return '00:00';
  const parts = time.split(':');
  if (parts.length < 2) return '00:00';
  const hours = parts[0].padStart(2, '0');
  const minutes = parts[1].slice(0, 2).padStart(2, '0');
  return `${hours}:${minutes}`;
};

const History: React.FC = () => {
  const { user } = useData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const isDark = effectiveTheme === 'dark';
  
  const [activeTab, setActiveTab] = useState<'bookings' | 'experiences' | 'payments'>('bookings');
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [rsvps, setRSVPs] = useState<RSVPRecord[]>([]);
  const [wellnessEnrollments, setWellnessEnrollments] = useState<WellnessEnrollmentRecord[]>([]);
  const [purchases, setPurchases] = useState<UnifiedPurchase[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [payingInvoice, setPayingInvoice] = useState<UnifiedPurchase | null>(null);

  const fetchBookings = useCallback(async () => {
    if (!user?.email) return;
    try {
      const { ok, data } = await apiRequest<BookingRecord[]>(
        `/api/booking-requests?user_email=${encodeURIComponent(user.email)}`
      );
      if (ok && data) {
        const today = getTodayString();
        const nowTime = getNowTimePacific();
        
        const pastBookings = data.filter(b => {
          const bookingDate = b.request_date?.split('T')[0] || b.request_date;
          const isPast = bookingDate < today;
          const isToday = bookingDate === today;
          const status = b.status?.toLowerCase() || '';
          
          // Exclude cancelled and declined - only show actual bookings
          if (status === 'cancelled' || status === 'declined') return false;
          
          const terminalStatuses = ['attended', 'no_show'];
          const isTerminalStatus = terminalStatuses.includes(status);
          
          if (isPast) return true;
          if (isToday && isTerminalStatus) return true;
          if (isToday && b.end_time && normalizeTime(b.end_time) <= nowTime) return true;
          return false;
        });
        pastBookings.sort((a, b) => {
          const dateA = a.request_date?.split('T')[0] || a.request_date;
          const dateB = b.request_date?.split('T')[0] || b.request_date;
          return dateB.localeCompare(dateA);
        });
        setBookings(pastBookings);
      }
    } catch (err) {
      console.error('[History] Failed to fetch bookings:', err);
    }
  }, [user?.email]);

  const fetchRSVPs = useCallback(async () => {
    if (!user?.email) return;
    try {
      const { ok, data } = await apiRequest<RSVPRecord[]>(
        `/api/rsvps?user_email=${encodeURIComponent(user.email)}&include_past=true`
      );
      if (ok && data) {
        const today = getTodayString();
        const nowTime = getNowTimePacific();
        
        const pastRsvps = data.filter(r => {
          const eventDate = r.event_date?.split('T')[0] || r.event_date;
          const isPast = eventDate < today;
          const isToday = eventDate === today;
          if (isPast) return true;
          if (isToday && r.start_time && normalizeTime(r.start_time) <= nowTime) return true;
          return false;
        });
        pastRsvps.sort((a, b) => b.event_date.localeCompare(a.event_date));
        setRSVPs(pastRsvps);
      }
    } catch (err) {
      console.error('[History] Failed to fetch RSVPs:', err);
    }
  }, [user?.email]);

  const fetchWellnessEnrollments = useCallback(async () => {
    if (!user?.email) return;
    try {
      const { ok, data } = await apiRequest<WellnessEnrollmentRecord[]>(
        `/api/wellness-enrollments?user_email=${encodeURIComponent(user.email)}&include_past=true`
      );
      if (ok && data) {
        const today = getTodayString();
        const nowTime = getNowTimePacific();
        
        const pastEnrollments = data.filter(e => {
          const enrollmentDate = e.date?.split('T')[0] || e.date;
          const isPast = enrollmentDate < today;
          const isToday = enrollmentDate === today;
          if (isPast) return true;
          if (isToday && e.time && normalizeTime(e.time) <= nowTime) return true;
          return false;
        });
        pastEnrollments.sort((a, b) => {
          const dateA = a.date?.split('T')[0] || a.date;
          const dateB = b.date?.split('T')[0] || b.date;
          return dateB.localeCompare(dateA);
        });
        setWellnessEnrollments(pastEnrollments);
      }
    } catch (err) {
      console.error('[History] Failed to fetch wellness enrollments:', err);
    }
  }, [user?.email]);

  const fetchPurchases = useCallback(async () => {
    if (!user?.email) return;
    try {
      const { ok, data } = await apiRequest<UnifiedPurchase[]>(
        `/api/my-unified-purchases?user_email=${encodeURIComponent(user.email)}`
      );
      if (ok && data) {
        setPurchases(data);
      }
    } catch (err) {
      console.error('[History] Failed to fetch purchases:', err);
    }
  }, [user?.email]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    await Promise.all([fetchBookings(), fetchRSVPs(), fetchWellnessEnrollments(), fetchPurchases()]);
    setIsLoading(false);
  }, [fetchBookings, fetchRSVPs, fetchWellnessEnrollments, fetchPurchases]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  const handleRefresh = useCallback(async () => {
    await loadData();
  }, [loadData]);

  const experiencesCount = rsvps.length + wellnessEnrollments.length;

  const combinedExperiences = [
    ...rsvps.map(r => ({
      id: `rsvp-${r.id}`,
      title: r.title,
      date: r.event_date?.split('T')[0] || r.event_date,
      time: r.start_time,
      type: 'Event' as const,
      category: r.category,
      location: r.location
    })),
    ...wellnessEnrollments.map(w => ({
      id: `wellness-${w.id}`,
      title: w.title,
      date: w.date?.split('T')[0] || w.date,
      time: w.time,
      type: 'Wellness' as const,
      category: w.category,
      instructor: w.instructor
    }))
  ].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <AnimatedPage>
    <PullToRefresh onRefresh={handleRefresh}>
      <SwipeablePage className="px-6 relative overflow-hidden">
        <section className="mb-4 pt-4 md:pt-2 animate-content-enter-delay-1">
          <h1 className={`text-3xl font-bold leading-tight drop-shadow-md ${isDark ? 'text-white' : 'text-primary'}`}>History</h1>
          <p className={`text-sm font-medium mt-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Your past bookings and experiences.</p>
        </section>

        <section className={`mb-6 border-b -mx-6 px-6 animate-content-enter-delay-2 ${isDark ? 'border-white/25' : 'border-black/10'}`}>
          <div className="flex gap-6 overflow-x-auto pb-0 scrollbar-hide scroll-fade-right">
            <TabButton label="Bookings" active={activeTab === 'bookings'} onClick={() => setActiveTab('bookings')} isDark={isDark} />
            <TabButton label="Experiences" active={activeTab === 'experiences'} onClick={() => setActiveTab('experiences')} isDark={isDark} />
            <TabButton label="Payments" icon="payments" active={activeTab === 'payments'} onClick={() => setActiveTab('payments')} isDark={isDark} />
          </div>
        </section>

        <div className="relative z-10 animate-content-enter-delay-3">
          {isLoading ? (
            <div className="animate-pulse space-y-4">
              {[1, 2, 3].map(i => (
                <div key={i} className={`h-24 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-black/5'}`} />
              ))}
            </div>
          ) : activeTab === 'bookings' ? (
            <div className="space-y-4">
              <div className={`text-sm font-medium ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                {bookings.length} past booking{bookings.length !== 1 ? 's' : ''}
              </div>
              {bookings.length === 0 ? (
                <div className={`text-center py-12 rounded-2xl border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}>
                  <span className={`material-symbols-outlined text-5xl mb-4 ${isDark ? 'text-white/30' : 'text-primary/30'}`}>history</span>
                  <p className={`${isDark ? 'text-white/80' : 'text-primary/80'}`}>No past bookings yet</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {bookings.map((booking, index) => {
                    const isConferenceRoom = booking.resource_id === 11 || 
                      (booking.resource_name?.toLowerCase()?.includes('conference') ?? false) ||
                      (booking.bay_name?.toLowerCase()?.includes('conference') ?? false) ||
                      (booking.notes?.toLowerCase()?.includes('conference') ?? false);
                    const resourceTypeLabel = isConferenceRoom ? 'Conference Room' : 'Golf Sim';
                    const resourceIcon = isConferenceRoom ? 'meeting_room' : 'golf_course';
                    const resourceDetail = booking.bay_name || booking.resource_name || booking.resource_preference;
                    
                    return (
                    <div 
                      key={booking.id} 
                      className={`rounded-xl p-4 border glass-card animate-list-item-delay-${Math.min(index, 10)} ${isDark ? 'border-white/25' : 'border-black/10'}`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 ${
                              isConferenceRoom
                                ? (isDark ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-100 text-blue-700')
                                : (isDark ? 'bg-accent/20 text-accent' : 'bg-accent/20 text-brand-green')
                            }`}>
                              <span className="material-symbols-outlined text-xs">{resourceIcon}</span>
                              {resourceTypeLabel}
                            </span>
                          </div>
                          <p className={`font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                            {getRelativeDateLabel(booking.request_date?.split('T')[0] || booking.request_date)}
                          </p>
                          <p className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                            {formatTime12Hour(booking.start_time)} - {formatTime12Hour(booking.end_time)}
                          </p>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${getStatusColor(booking.status, isDark)}`}>
                          {formatStatusLabel(booking.status)}
                        </span>
                      </div>
                      {resourceDetail && !isConferenceRoom && (
                        <p className={`text-sm flex items-center gap-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                          <span className="material-symbols-outlined text-sm">golf_course</span>
                          {resourceDetail}
                        </p>
                      )}
                      {booking.participants && booking.participants.length > 0 && (
                        <div className={`mt-2 pt-2 border-t ${isDark ? 'border-white/10' : 'border-black/5'}`}>
                          <p className={`text-xs font-medium mb-1 flex items-center gap-1 ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                            <span className="material-symbols-outlined text-xs">group</span>
                            Played with
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {booking.participants.map((p, idx) => (
                              <span 
                                key={idx} 
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${
                                  p.type === 'member'
                                    ? (isDark ? 'bg-accent/15 text-accent' : 'bg-accent/15 text-brand-green')
                                    : (isDark ? 'bg-orange-500/15 text-orange-300' : 'bg-orange-100 text-orange-700')
                                }`}
                              >
                                {p.name}
                                <span className={`text-[10px] font-medium ${
                                  p.type === 'member' 
                                    ? (isDark ? 'text-accent/70' : 'text-brand-green/70')
                                    : (isDark ? 'text-orange-300/70' : 'text-orange-600/70')
                                }`}>
                                  {p.type === 'member' ? 'Member' : 'Guest'}
                                </span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );})}
                </div>
              )}
            </div>
          ) : activeTab === 'experiences' ? (
            <div className="space-y-4">
              <div className={`text-sm font-medium ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                {experiencesCount} past experience{experiencesCount !== 1 ? 's' : ''}
              </div>
              {combinedExperiences.length === 0 ? (
                <div className={`text-center py-12 rounded-2xl border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}>
                  <span className={`material-symbols-outlined text-5xl mb-4 ${isDark ? 'text-white/30' : 'text-primary/30'}`}>celebration</span>
                  <p className={`${isDark ? 'text-white/80' : 'text-primary/80'}`}>No past experiences yet</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {combinedExperiences.map((exp, index) => (
                    <div 
                      key={exp.id} 
                      className={`rounded-xl p-4 border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}
                      style={{animationDelay: `${0.05 * index}s`}}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
                              exp.type === 'Event' 
                                ? (isDark ? 'bg-accent/20 text-accent' : 'bg-accent/20 text-brand-green')
                                : (isDark ? 'bg-lavender/20 text-lavender' : 'bg-lavender/30 text-purple-700')
                            }`}>
                              {exp.type}
                            </span>
                            {exp.category && (
                              <span className={`text-xs ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                                {exp.category}
                              </span>
                            )}
                          </div>
                          <p className={`font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                            {exp.title}
                          </p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className={`text-sm font-bold ${isDark ? 'text-accent' : 'text-primary'}`}>
                            {getRelativeDateLabel(exp.date)}
                          </p>
                          {exp.time && (
                            <p className={`text-xs ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                              {formatTime12Hour(exp.time)}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
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
                <div className="space-y-6">
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
                      'Even House': { dark: 'bg-lavender/30 text-lavender', light: 'bg-lavender/20 text-primary' },
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
                      const monthLabel = new Date(parseInt(year), parseInt(month) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                      
                      return (
                        <div key={monthKey} className="animate-pop-in" style={{animationDelay: `${0.05 * monthIndex}s`}}>
                          <h3 className={`text-sm font-semibold mb-3 ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                            {monthLabel}
                          </h3>
                          <div className="space-y-3">
                            {monthPurchases.map((purchase, index) => (
                              <div 
                                key={purchase.id} 
                                className={`rounded-xl p-4 border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}
                                style={{animationDelay: `${0.05 * (monthIndex + index)}s`}}
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
                                        className="bg-primary text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-primary/90 transition-colors flex items-center gap-1.5 mt-2 ml-auto"
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
                                        className={`text-xs flex items-center gap-0.5 justify-end mt-1 ${isDark ? 'text-accent hover:text-accent/80' : 'text-brand-green hover:text-brand-green/80'}`}
                                      >
                                        View
                                        <span className="material-symbols-outlined text-xs">open_in_new</span>
                                      </a>
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

        <BottomSentinel />
      </SwipeablePage>
      <MemberBottomNav currentPath="/history" isDarkTheme={isDark} />

      {payingInvoice && payingInvoice.stripeInvoiceId && user && (
        <InvoicePaymentModal
          invoice={{
            id: payingInvoice.stripeInvoiceId,
            status: payingInvoice.status,
            amountDue: payingInvoice.amountCents,
            amountPaid: 0,
            currency: 'usd',
            customerEmail: user.email,
            description: payingInvoice.itemName,
            hostedInvoiceUrl: payingInvoice.hostedInvoiceUrl || null,
            invoicePdf: null,
            created: payingInvoice.date,
            dueDate: null,
            paidAt: null,
            lines: [{ description: payingInvoice.itemName, amount: payingInvoice.amountCents, quantity: 1 }],
          }}
          userEmail={user.email || ''}
          userName={user.name || user.email?.split('@')[0] || 'Member'}
          onSuccess={async () => {
            setPayingInvoice(null);
            await fetchPurchases();
          }}
          onClose={() => setPayingInvoice(null)}
        />
      )}
    </PullToRefresh>
    </AnimatedPage>
  );
};

export default History;
