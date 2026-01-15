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
  
  const [activeTab, setActiveTab] = useState<'bookings' | 'experiences' | 'purchases' | 'invoices'>('bookings');
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [rsvps, setRSVPs] = useState<RSVPRecord[]>([]);
  const [wellnessEnrollments, setWellnessEnrollments] = useState<WellnessEnrollmentRecord[]>([]);
  const [purchases, setPurchases] = useState<UnifiedPurchase[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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

  const fetchInvoices = useCallback(async () => {
    if (!user?.email) return;
    try {
      const { ok, data } = await apiRequest<{ invoices: Invoice[]; count: number }>(
        `/api/my-invoices?user_email=${encodeURIComponent(user.email)}`
      );
      if (ok && data?.invoices) {
        setInvoices(data.invoices);
      }
    } catch (err) {
      console.error('[History] Failed to fetch invoices:', err);
    }
  }, [user?.email]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    await Promise.all([fetchBookings(), fetchRSVPs(), fetchWellnessEnrollments(), fetchPurchases(), fetchInvoices()]);
    setIsLoading(false);
  }, [fetchBookings, fetchRSVPs, fetchWellnessEnrollments, fetchPurchases, fetchInvoices]);

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
    <PullToRefresh onRefresh={handleRefresh}>
      <SwipeablePage className="px-6 relative overflow-hidden">
        <section className="mb-4 pt-4 md:pt-2 animate-pop-in">
          <h1 className={`text-3xl font-bold leading-tight drop-shadow-md ${isDark ? 'text-white' : 'text-primary'}`}>History</h1>
          <p className={`text-sm font-medium mt-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Your past bookings and experiences.</p>
        </section>

        <section className={`mb-6 border-b -mx-6 px-6 animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`} style={{animationDelay: '0.05s'}}>
          <div className="flex gap-6 overflow-x-auto pb-0 scrollbar-hide scroll-fade-right">
            <TabButton label="Bookings" active={activeTab === 'bookings'} onClick={() => setActiveTab('bookings')} isDark={isDark} />
            <TabButton label="Experiences" active={activeTab === 'experiences'} onClick={() => setActiveTab('experiences')} isDark={isDark} />
            <TabButton label="Purchases" icon="receipt_long" active={activeTab === 'purchases'} onClick={() => setActiveTab('purchases')} isDark={isDark} />
            <TabButton label="Invoices" icon="description" active={activeTab === 'invoices'} onClick={() => setActiveTab('invoices')} isDark={isDark} />
          </div>
        </section>

        <div className="relative z-10 animate-pop-in" style={{animationDelay: '0.1s'}}>
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
                      className={`rounded-xl p-4 border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}
                      style={{animationDelay: `${0.05 * index}s`}}
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
          ) : activeTab === 'purchases' ? (
            <div className="space-y-4">
              <div className={`text-sm font-medium ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                {purchases.length} purchase{purchases.length !== 1 ? 's' : ''}
              </div>
              {purchases.length === 0 ? (
                <div className={`text-center py-12 rounded-2xl border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}>
                  <span className={`material-symbols-outlined text-5xl mb-4 ${isDark ? 'text-white/30' : 'text-primary/30'}`}>receipt_long</span>
                  <p className={`${isDark ? 'text-white/80' : 'text-primary/80'}`}>No purchases yet</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {(() => {
                    const categoryIcons: Record<string, string> = {
                      sim_walk_in: 'golf_course',
                      guest_pass: 'badge',
                      membership: 'card_membership',
                      cafe: 'local_cafe',
                      retail: 'shopping_bag',
                      other: 'receipt',
                    };
                    
                    const categoryColors: Record<string, { dark: string; light: string }> = {
                      sim_walk_in: { dark: 'bg-blue-500/20 text-blue-300', light: 'bg-blue-100 text-blue-700' },
                      guest_pass: { dark: 'bg-purple-500/20 text-purple-300', light: 'bg-purple-100 text-purple-700' },
                      membership: { dark: 'bg-accent/20 text-accent', light: 'bg-accent/20 text-brand-green' },
                      cafe: { dark: 'bg-orange-500/20 text-orange-300', light: 'bg-orange-100 text-orange-700' },
                      retail: { dark: 'bg-pink-500/20 text-pink-300', light: 'bg-pink-100 text-pink-700' },
                    };
                    
                    const getCategoryStyle = (category: string) => {
                      const colors = categoryColors[category?.toLowerCase()] || { dark: 'bg-amber-500/20 text-amber-300', light: 'bg-amber-100 text-amber-700' };
                      return isDark ? colors.dark : colors.light;
                    };
                    
                    const getCategoryIcon = (category: string) => {
                      return categoryIcons[category?.toLowerCase()] || 'receipt';
                    };
                    
                    const formatCurrency = (cents: number): string => {
                      if (cents == null || isNaN(cents)) return '$0.00';
                      return `$${(cents / 100).toFixed(2)}`;
                    };
                    
                    const sourceColors: Record<string, { dark: string; light: string }> = {
                      Mindbody: { dark: 'bg-white/10 text-white/80', light: 'bg-primary/10 text-primary' },
                      Stripe: { dark: 'bg-accent/20 text-accent', light: 'bg-accent/20 text-primary' },
                      'Even House': { dark: 'bg-lavender/30 text-lavender', light: 'bg-lavender/20 text-primary' },
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
                                        {purchase.itemCategory || 'Purchase'}
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
                                    <p className={`text-lg font-bold ${isDark ? 'text-accent' : 'text-brand-green'}`}>
                                      {formatCurrency(purchase.amountCents)}
                                    </p>
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
          ) : activeTab === 'invoices' ? (
            <div className="space-y-4">
              <div className={`text-sm font-medium ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                {invoices.length} invoice{invoices.length !== 1 ? 's' : ''}
              </div>
              {invoices.length === 0 ? (
                <div className={`text-center py-12 rounded-2xl border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}>
                  <span className={`material-symbols-outlined text-5xl mb-4 ${isDark ? 'text-white/30' : 'text-primary/30'}`}>description</span>
                  <p className={`${isDark ? 'text-white/80' : 'text-primary/80'}`}>No invoices yet</p>
                  <p className={`text-sm mt-1 ${isDark ? 'text-white/50' : 'text-primary/50'}`}>Subscription invoices will appear here</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {invoices.map((invoice, index) => {
                    const getStatusBadge = (status: string) => {
                      const statusMap: Record<string, { label: string; style: string }> = {
                        paid: { label: 'Paid', style: isDark ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700' },
                        open: { label: 'Due', style: isDark ? 'bg-amber-900/30 text-amber-400' : 'bg-amber-100 text-amber-700' },
                        draft: { label: 'Draft', style: isDark ? 'bg-white/10 text-white/80' : 'bg-primary/10 text-primary' },
                        void: { label: 'Void', style: isDark ? 'bg-red-900/30 text-red-400' : 'bg-red-100 text-red-700' },
                        uncollectible: { label: 'Uncollectible', style: isDark ? 'bg-red-900/30 text-red-400' : 'bg-red-100 text-red-700' },
                      };
                      return statusMap[status] || { label: status, style: isDark ? 'bg-white/10 text-white/80' : 'bg-primary/10 text-primary' };
                    };
                    
                    const formatAmount = (cents: number) => `$${(cents / 100).toFixed(2)}`;
                    const formatDate = (dateStr: string) => {
                      const date = new Date(dateStr);
                      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    };
                    
                    const status = getStatusBadge(invoice.status);
                    const primaryLine = invoice.lines?.[0];
                    const description = primaryLine?.description || invoice.description || 'Invoice';
                    
                    return (
                      <div 
                        key={invoice.id}
                        className={`rounded-xl p-4 border glass-card animate-pop-in ${isDark ? 'border-white/25' : 'border-black/10'}`}
                        style={{animationDelay: `${0.05 * index}s`}}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1.5">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${status.style}`}>
                                {status.label}
                              </span>
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${isDark ? 'bg-accent/20 text-accent' : 'bg-accent/20 text-primary'}`}>
                                Stripe
                              </span>
                            </div>
                            <p className={`font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                              {description}
                            </p>
                            <p className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                              {formatDate(invoice.created)}
                              {invoice.paidAt && ` - Paid ${formatDate(invoice.paidAt)}`}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className={`text-lg font-bold ${invoice.status === 'paid' ? (isDark ? 'text-accent' : 'text-brand-green') : (isDark ? 'text-white' : 'text-primary')}`}>
                              {formatAmount(invoice.amountDue)}
                            </p>
                            {invoice.hostedInvoiceUrl && (
                              <a 
                                href={invoice.hostedInvoiceUrl}
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
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <BottomSentinel />
      </SwipeablePage>
      <MemberBottomNav currentPath="/history" isDarkTheme={isDark} />
    </PullToRefresh>
  );
};

export default History;
