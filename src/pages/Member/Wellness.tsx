import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useToast } from '../../components/Toast';
import { apiRequest } from '../../lib/apiRequest';
import TabButton from '../../components/TabButton';
import SwipeablePage from '../../components/SwipeablePage';
import PullToRefresh from '../../components/PullToRefresh';
import { MotionList, MotionListItem, AnimatedPage } from '../../components/motion';
import { EmptyEvents } from '../../components/EmptyState';
import { playSound } from '../../utils/sounds';
import { formatDateDisplayWithDay } from '../../utils/dateUtils';
import { bookingEvents } from '../../lib/bookingEvents';

interface WellnessEnrollment {
  class_id: number;
  user_email: string;
  is_waitlisted?: boolean;
}

interface WellnessClass {
    id: number;
    title: string;
    date: string;
    time: string;
    instructor: string;
    duration: string;
    category: string;
    spots: string;
    spotsRemaining: number | null;
    enrolledCount: number;
    status: string;
    description?: string;
    capacity?: number | null;
    waitlistEnabled?: boolean;
    waitlistCount?: number;
}

const formatDateForDisplay = (dateStr: string): string => {
  if (!dateStr) return 'No Date';
  const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
  return formatDateDisplayWithDay(datePart);
};

const formatTimeTo12Hour = (timeStr: string): { time: string; period: string } => {
  if (!timeStr) return { time: '12:00', period: 'PM' };
  
  if (timeStr.includes('AM') || timeStr.includes('PM')) {
    const parts = timeStr.split(' ');
    return { time: parts[0], period: parts[1] || 'PM' };
  }
  
  const timePart = timeStr.split(':');
  let hours = parseInt(timePart[0]) || 0;
  const minutes = timePart[1] || '00';
  
  const period = hours >= 12 ? 'PM' : 'AM';
  if (hours === 0) hours = 12;
  else if (hours > 12) hours -= 12;
  
  return { time: `${hours}:${minutes}`, period };
};

const Wellness: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { user } = useData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const { showToast } = useToast();
  const isDark = effectiveTheme === 'dark';
  const initialTab = searchParams.get('tab') === 'medspa' ? 'medspa' : 'classes';
  const [activeTab, setActiveTab] = useState<'classes' | 'medspa'>(initialTab);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmationMessage, setConfirmationMessage] = useState('Booking confirmed.');

  useEffect(() => {
    if (activeTab === 'medspa') {
      setPageReady(true);
    }
  }, [activeTab, setPageReady]);

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'medspa') setActiveTab('medspa');
    else if (tab === 'classes') setActiveTab('classes');
  }, [searchParams]);

  const convertTo24Hour = (time12: string): string => {
    const match = time12.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return '09:00:00';
    let hours = parseInt(match[1]);
    const minutes = match[2];
    const period = match[3].toUpperCase();
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
  };

  const calculateEndTime = (startTime24: string, durationStr: string): string => {
    const durationMatch = durationStr.match(/(\d+)/);
    const durationMinutes = durationMatch ? parseInt(durationMatch[1]) : 60;
    const [hours, minutes] = startTime24.split(':').map(Number);
    const totalMinutes = hours * 60 + minutes + durationMinutes;
    const endHours = Math.floor(totalMinutes / 60) % 24;
    const endMins = totalMinutes % 60;
    return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
  };

  const handleBook = async (classData: WellnessClass) => {
    if (!user?.email) return;
    
    const { ok, error } = await apiRequest('/api/wellness-enrollments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        class_id: classData.id,
        user_email: user.email
      })
    });
    
    if (ok) {
      playSound('bookingConfirmed');
      showToast(`RSVP confirmed for ${classData.title}!`, 'success');
      setConfirmationMessage(`RSVP confirmed for ${classData.title}!`);
      setShowConfirmation(true);
      setTimeout(() => setShowConfirmation(false), 2500);
    } else {
      showToast(error || 'Unable to load data. Please try again.', 'error');
      setConfirmationMessage(error || 'Unable to load data. Please try again.');
      setShowConfirmation(true);
      setTimeout(() => setShowConfirmation(false), 2500);
    }
  };

  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshPromiseResolve, setRefreshPromiseResolve] = useState<(() => void) | null>(null);

  const handleRefresh = useCallback(async () => {
    return new Promise<void>((resolve) => {
      setRefreshPromiseResolve(() => resolve);
      setRefreshKey(k => k + 1);
    });
  }, []);

  const onRefreshComplete = useCallback(() => {
    if (refreshPromiseResolve) {
      refreshPromiseResolve();
      setRefreshPromiseResolve(null);
    }
  }, [refreshPromiseResolve]);

  return (
    <AnimatedPage>
    <PullToRefresh onRefresh={handleRefresh}>
    <SwipeablePage className="px-6 relative overflow-hidden">
      <section className="mb-4 pt-4 md:pt-2 animate-content-enter-delay-1">
        <h1 className={`text-3xl font-bold leading-tight drop-shadow-md ${isDark ? 'text-white' : 'text-primary'}`}>Wellness</h1>
        <p className={`text-sm font-medium mt-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Book your next session.</p>
      </section>

      <section className={`mb-8 border-b -mx-6 px-6 animate-content-enter-delay-2 ${isDark ? 'border-white/25' : 'border-black/10'}`}>
        <div className="flex gap-6 overflow-x-auto pb-0 scrollbar-hide scroll-fade-right">
          <TabButton label="Upcoming" active={activeTab === 'classes'} onClick={() => setActiveTab('classes')} isDark={isDark} />
          <TabButton label="MedSpa" active={activeTab === 'medspa'} onClick={() => setActiveTab('medspa')} isDark={isDark} />
        </div>
      </section>

      <div className="relative z-10">
        {activeTab === 'classes' && <ClassesView onBook={handleBook} isDark={isDark} userEmail={user?.email} userStatus={user?.status} refreshKey={refreshKey} onRefreshComplete={onRefreshComplete} />}
        {activeTab === 'medspa' && <MedSpaView isDark={isDark} />}
      </div>

      {showConfirmation && (
         <div className="fixed bottom-32 left-0 right-0 z-[60] flex justify-center pointer-events-none">
             <div className={`backdrop-blur-md px-6 py-3 rounded-full shadow-2xl text-sm font-bold flex items-center gap-3 animate-pop-in w-max max-w-[90%] border pointer-events-auto ${isDark ? 'bg-black/80 text-white border-white/25' : 'bg-white/95 text-primary border-black/10'}`}>
                <span className="material-symbols-outlined text-xl text-green-500">check_circle</span>
                <div>
                  <p>{confirmationMessage}</p>
                </div>
             </div>
         </div>
      )}

    </SwipeablePage>
    </PullToRefresh>
    </AnimatedPage>
  );
};

const ClassesView: React.FC<{onBook: (cls: WellnessClass) => void; isDark?: boolean; userEmail?: string; userStatus?: string; refreshKey?: number; onRefreshComplete?: () => void}> = ({ onBook, isDark = true, userEmail, userStatus, refreshKey = 0, onRefreshComplete }) => {
  const { showToast } = useToast();
  const { setPageReady } = usePageReady();
  const [selectedFilter, setSelectedFilter] = useState('All');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [classes, setClasses] = useState<WellnessClass[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [enrollments, setEnrollments] = useState<WellnessEnrollment[]>([]);
  const [loadingCancel, setLoadingCancel] = useState<number | null>(null);
  const [loadingRsvp, setLoadingRsvp] = useState<number | null>(null);
  const [categories, setCategories] = useState<string[]>(['All', 'Classes', 'MedSpa', 'Recovery', 'Therapy', 'Nutrition', 'Personal Training', 'Mindfulness', 'Outdoors', 'General']);

  const fetchClasses = useCallback(async () => {
    const { ok, data } = await apiRequest<any[]>('/api/wellness-classes?active_only=true');
    
    if (ok && data) {
      const formatted = data.map((c: any) => {
        const spotsRemaining = c.spots_remaining !== null ? parseInt(c.spots_remaining, 10) : null;
        const enrolledCount = parseInt(c.enrolled_count, 10) || 0;
        const waitlistCount = parseInt(c.waitlist_count, 10) || 0;
        const capacity = c.capacity !== null ? parseInt(c.capacity, 10) : null;
        return {
          id: c.id,
          title: c.title,
          date: c.date,
          time: c.time,
          instructor: c.instructor,
          duration: c.duration,
          category: c.category,
          spots: c.spots,
          spotsRemaining,
          enrolledCount,
          status: spotsRemaining !== null && spotsRemaining <= 0 ? 'Full' : (c.status || 'Open'),
          description: c.description,
          capacity,
          waitlistEnabled: c.waitlist_enabled || false,
          waitlistCount
        };
      });
      setClasses(formatted);
    } else {
      showToast('Unable to load data. Please try again.', 'error');
    }
    
    setIsLoading(false);
  }, [showToast]);

  const fetchEnrollments = useCallback(async () => {
    if (!userEmail) return;
    const { ok, data } = await apiRequest<WellnessEnrollment[]>(`/api/wellness-enrollments?user_email=${encodeURIComponent(userEmail)}`);
    if (ok && data) {
      setEnrollments(data);
    }
  }, [userEmail]);

  const handleCancel = useCallback(async (classData: WellnessClass) => {
    if (!userEmail) return;
    
    setLoadingCancel(classData.id);
    
    // Optimistic UI: remove enrollment and update counts immediately
    const previousEnrollments = [...enrollments];
    const previousClasses = [...classes];
    
    const enrollmentToCancel = enrollments.find(e => e.class_id === classData.id);
    const isWaitlistCancel = enrollmentToCancel?.is_waitlisted;

    setEnrollments(prev => prev.filter(e => e.class_id !== classData.id));
    setClasses(prev => prev.map(c => {
      if (c.id === classData.id) {
        if (isWaitlistCancel) {
          return { ...c, waitlistCount: Math.max(0, (c.waitlistCount || 1) - 1) };
        } else {
          return { 
            ...c, 
            enrolledCount: Math.max(0, c.enrolledCount - 1),
            spotsRemaining: c.spotsRemaining !== null ? c.spotsRemaining + 1 : null
          };
        }
      }
      return c;
    }));
    
    const { ok, error } = await apiRequest(`/api/wellness-enrollments/${classData.id}/${encodeURIComponent(userEmail)}`, {
      method: 'DELETE'
    });
    
    if (ok) {
      showToast(`Cancelled enrollment for ${classData.title}`, 'success');
      fetchClasses(); // Sync spots remaining
    } else {
      // Revert on failure
      setEnrollments(previousEnrollments);
      setClasses(previousClasses);
      showToast(error || 'Unable to cancel. Please try again.', 'error');
      console.error('Wellness cancellation error:', error);
    }
    setLoadingCancel(null);
  }, [userEmail, showToast, fetchClasses, enrollments, classes]);

  const handleRsvp = useCallback(async (classData: WellnessClass) => {
    if (!userEmail) return;
    
    setLoadingRsvp(classData.id);
    
    // Optimistic UI: add enrollment and update counts immediately
    const previousEnrollments = [...enrollments];
    const previousClasses = [...classes];
    const isWaitlistJoin = classData.spotsRemaining !== null && classData.spotsRemaining <= 0 && classData.waitlistEnabled;
    
    setEnrollments(prev => [...prev, { class_id: classData.id, user_email: userEmail, is_waitlisted: isWaitlistJoin }]);
    setClasses(prev => prev.map(c => {
      if (c.id === classData.id) {
        if (isWaitlistJoin) {
          return { ...c, waitlistCount: (c.waitlistCount || 0) + 1 };
        } else {
          return { 
            ...c, 
            enrolledCount: c.enrolledCount + 1,
            spotsRemaining: c.spotsRemaining !== null ? Math.max(0, c.spotsRemaining - 1) : null
          };
        }
      }
      return c;
    }));
    
    const { ok, data, error } = await apiRequest<{isWaitlisted?: boolean; message?: string}>('/api/wellness-enrollments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        class_id: classData.id,
        user_email: userEmail
      })
    });
    
    if (ok) {
      playSound('bookingConfirmed');
      const isWaitlisted = data?.isWaitlisted;
      showToast(isWaitlisted ? `Added to waitlist for ${classData.title}` : `RSVP confirmed for ${classData.title}!`, 'success');
      fetchClasses();
      fetchEnrollments();
    } else {
      setEnrollments(previousEnrollments);
      setClasses(previousClasses);
      showToast(error || 'Unable to RSVP. Please try again.', 'error');
      console.error('Wellness RSVP error:', error);
    }
    setLoadingRsvp(null);
  }, [userEmail, showToast, fetchClasses, fetchEnrollments, enrollments, classes]);

  const isEnrolled = useCallback((classId: number) => {
    return enrollments.some(e => e.class_id === classId);
  }, [enrollments]);

  const isOnWaitlist = useCallback((classId: number) => {
    const enrollment = enrollments.find(e => e.class_id === classId);
    return enrollment?.is_waitlisted || false;
  }, [enrollments]);

  const getWaitlistPosition = useCallback((classId: number) => {
    const cls = classes.find(c => c.id === classId);
    return cls?.waitlistCount || 0;
  }, [classes]);

  useEffect(() => {
    const loadData = async () => {
      await Promise.all([fetchClasses(), fetchEnrollments()]);
      if (refreshKey > 0 && onRefreshComplete) {
        onRefreshComplete();
      }
    };
    loadData();
  }, [fetchClasses, fetchEnrollments, refreshKey, onRefreshComplete]);

  // Subscribe to real-time updates for wellness enrollments
  useEffect(() => {
    const unsubscribe = bookingEvents.subscribe(() => {
      fetchClasses();
      fetchEnrollments();
    });
    return unsubscribe;
  }, [fetchClasses, fetchEnrollments]);

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  const sortedClasses = classes
    .filter(cls => selectedFilter === 'All' || cls.category === selectedFilter)
    .sort((a, b) => {
      const dateA = new Date(a.date + ' ' + a.time);
      const dateB = new Date(b.date + ' ' + b.time);
      return dateA.getTime() - dateB.getTime();
    });

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-4">
        {[1, 2, 3].map(i => (
          <div key={i} className={`h-32 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-black/5'}`} />
        ))}
      </div>
    );
  }

  return (
    <div>
        <section className="mb-6">
        <div className="flex gap-3 overflow-x-auto -mx-6 px-6 scrollbar-hide items-center mb-4 scroll-fade-right">
            {categories.map(cat => (
              <FilterPill 
                key={cat} 
                label={cat} 
                active={selectedFilter === cat} 
                onClick={() => setSelectedFilter(cat)} 
                isDark={isDark} 
              />
            ))}
        </div>
        
        <MotionList className="space-y-4">
            {sortedClasses.length > 0 ? (
                sortedClasses.map((cls) => {
                    const isExpanded = expandedId === cls.id;
                    const enrolled = isEnrolled(cls.id);
                    const waitlisted = isOnWaitlist(cls.id);
                    const isCancelling = loadingCancel === cls.id;
                    const isRsvping = loadingRsvp === cls.id;
                    const isFull = cls.spotsRemaining !== null && cls.spotsRemaining <= 0;
                    return (
                    <MotionListItem key={cls.id}>
                        <ClassCard 
                            {...cls}
                            date={formatDateForDisplay(cls.date)}
                            isExpanded={isExpanded}
                            onToggle={() => setExpandedId(isExpanded ? null : cls.id)}
                            onBook={() => handleRsvp(cls)}
                            onCancel={() => handleCancel(cls)}
                            isEnrolled={enrolled}
                            isOnWaitlist={waitlisted}
                            isCancelling={isCancelling}
                            isRsvping={isRsvping}
                            isDark={isDark}
                            isMembershipInactive={!!(userStatus && userStatus.toLowerCase() !== 'active')}
                            isFull={isFull}
                        />
                    </MotionListItem>
                    );
                })
            ) : (
                <EmptyEvents message="No classes scheduled yet. Check back soon!" />
            )}
        </MotionList>
        </section>
    </div>
  );
};

const MedSpaView: React.FC<{isDark?: boolean}> = ({ isDark = true }) => (
  <div className="space-y-8">
    <div className="text-center space-y-2 mb-6">
      <p className={`text-xs uppercase tracking-[0.2em] ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Powered by</p>
      <h2 className={`font-bold text-3xl ${isDark ? 'text-white' : 'text-primary'}`}>Amarie Aesthetics</h2>
      <div className="w-12 h-0.5 bg-accent mx-auto my-4"></div>
      <p className={`text-sm leading-relaxed max-w-[90%] mx-auto ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
        Exclusive medical aesthetics and wellness treatments curated for Ever House members.
      </p>
    </div>

    <div className={`sticky top-0 z-10 py-3 -mx-6 px-6 mb-6 ${isDark ? 'bg-[#0f120a]/95 backdrop-blur-sm' : 'bg-[#F2F2EC]/95 backdrop-blur-sm'}`}>
       <a 
         href="https://www.amarieaesthetics.co" 
         target="_blank" 
         rel="noopener noreferrer"
         className={`w-full py-3.5 rounded-xl font-bold tracking-wide active:scale-[0.98] transition-all flex items-center justify-center gap-2 ${isDark ? 'bg-lavender text-primary hover:bg-lavender/90' : 'bg-primary text-white hover:bg-primary/90'}`}
       >
         <span className="material-symbols-outlined text-[20px]">calendar_add_on</span>
         Book with Amarie
       </a>
    </div>

    <div className="space-y-6">
      <MedSpaCard title="IV Hydration Drip Menu" subtitle="$125" isDark={isDark}>
        <MenuItem name="The Beauty Drip" desc="Healthy hair, skin, nails, hydration, glowy skin" isDark={isDark} />
        <MenuItem name="Immunity Boost" desc="Immune-supporting vitamins for wellness & recovery" isDark={isDark} />
        <MenuItem name="Hangover Relief" desc="Rehydrate, ease headaches, restore energy" isDark={isDark} />
        <MenuItem name="The Wellness Blend" desc="Myers Cocktail for overall wellness" isDark={isDark} />
        <MenuItem name="Fitness Recovery" desc="Vitamins, minerals, electrolytes for athletes" isDark={isDark} />
        <MenuItem name="Energy Recharge" desc="B12 infusion to boost energy & reduce fatigue" isDark={isDark} />
      </MedSpaCard>
      
      <MedSpaCard title="Wellness Shots" isDark={isDark}>
        <div className="mb-4">
          <h4 className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Essentials & Energy</h4>
          <MenuItem name="B12" price="$15" isDark={isDark} />
          <MenuItem name="Glutathione" price="$25" isDark={isDark} />
          <MenuItem name="Folic Acid" price="$20" isDark={isDark} />
          <MenuItem name="Vitamin D3" price="$20" isDark={isDark} />
          <MenuItem name="Zinc" price="$20" isDark={isDark} />
          <MenuItem name="MIC B12" price="$20" isDark={isDark} />
        </div>
        <div className="mb-4">
          <h4 className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Amarie x EverHouse Signature Shots</h4>
          <MenuItem name="The Beauty Trio" price="$30" isDark={isDark} />
          <MenuItem name="Boost Me Up" price="$30" isDark={isDark} />
          <MenuItem name="The Happy Shot" price="$30" isDark={isDark} />
          <MenuItem name="Immuniglow" price="$30" isDark={isDark} />
        </div>
        <div>
          <h4 className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Peptides</h4>
          <MenuItem name="BPC-157" price="$85" isDark={isDark} />
          <MenuItem name="GHK-Cu" price="$110" isDark={isDark} />
          <MenuItem name="Thymosin Beta-4" price="$115" isDark={isDark} />
        </div>
      </MedSpaCard>

      <MedSpaCard title="NAD+ Treatments" isDark={isDark}>
        <MenuItem name="NAD+ Single Shot" price="$50" isDark={isDark} />
        <MenuItem name="NAD+ Low Dose Package" price="$180" isDark={isDark} />
        <MenuItem name="NAD+ High Dose Package" price="$350" isDark={isDark} />
      </MedSpaCard>

      <MedSpaCard title="Injectables" isDark={isDark}>
        <div className="mb-4">
          <h4 className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Neurotoxins</h4>
          <MenuItem name="Botox" price="$10/unit" isDark={isDark} />
          <MenuItem name="Dysport" price="$10/unit" isDark={isDark} />
          <MenuItem name="Lip Flip" price="$50" isDark={isDark} />
          <MenuItem name="Masseters" price="Varies" isDark={isDark} />
        </div>
        <div>
          <h4 className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Dermal Fillers</h4>
          <p className={`text-xs ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Special pricing for Ever House members. Consultation required.</p>
        </div>
      </MedSpaCard>

      <MedSpaCard title="Medical Weightloss" isDark={isDark}>
        <div className="mb-4">
          <h4 className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Semaglutide GLP-1</h4>
          <MenuItem name="1 Month" price="$299" isDark={isDark} />
          <MenuItem name="3 Months" price="$799" isDark={isDark} />
        </div>
        <div>
          <h4 className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Tirzepatide GLP-1/GIP</h4>
          <MenuItem name="1 Month" price="$399" isDark={isDark} />
          <MenuItem name="3 Months" price="$999" isDark={isDark} />
        </div>
      </MedSpaCard>
    </div>
  </div>
);

const FilterPill: React.FC<{label: string; active?: boolean; onClick?: () => void; isDark?: boolean}> = ({ label, active, onClick, isDark = true }) => (
  <button onClick={onClick} className={`flex-shrink-0 px-5 py-2.5 rounded-full text-sm font-bold border transition-colors ${active ? 'bg-accent text-[#293515] border-accent shadow-glow' : (isDark ? 'bg-transparent border-white/20 text-white hover:bg-white/5' : 'bg-white border-black/10 text-primary hover:bg-black/5')}`}>
    {label}
  </button>
);

const getCategoryIcon = (category: string): string => {
  switch (category?.toLowerCase()) {
    case 'recovery': return 'ac_unit';
    case 'wellness': return 'self_improvement';
    case 'classes': return 'fitness_center';
    case 'medspa': return 'spa';
    case 'therapy': return 'healing';
    case 'nutrition': return 'restaurant';
    case 'personal training': return 'sprint';
    case 'mindfulness': return 'psychology';
    default: return 'spa';
  }
};

const ClassCard: React.FC<any> = ({ title, date, time, instructor, duration, category, spots, spotsRemaining, enrolledCount, status, description, isExpanded, onToggle, onBook, onCancel, isEnrolled, isOnWaitlist, isCancelling, isRsvping, isDark = true, isMembershipInactive = false, isFull = false, capacity, waitlistEnabled, waitlistCount = 0 }) => {
  const formattedTime = formatTimeTo12Hour(time);
  const showJoinWaitlist = isFull && waitlistEnabled && !isEnrolled;
  const showFullNoWaitlist = isFull && !waitlistEnabled && !isEnrolled;
  
  const getSpotDisplay = () => {
    if (isOnWaitlist) return 'On Waitlist';
    if (isEnrolled) return 'Booked';
    if (capacity !== null && capacity !== undefined) {
      if (isFull) {
        return waitlistCount > 0 ? `Full (${waitlistCount} on waitlist)` : 'Full';
      }
      return `${enrolledCount || 0}/${capacity} spots filled`;
    }
    if (spotsRemaining !== null) {
      return isFull ? 'Full' : `${spotsRemaining} spots left`;
    }
    return spots;
  };

  return (
  <div 
    className={`rounded-xl relative overflow-hidden transition-all glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}
  >
    <div 
      onClick={onToggle}
      className={`p-4 cursor-pointer transition-all ${isExpanded ? '' : 'active:scale-[0.98]'}`}
    >
      <div className="flex gap-4 items-start">
        <div className={`w-14 h-14 flex-shrink-0 rounded-xl flex items-center justify-center ${isDark ? 'bg-lavender/20' : 'bg-lavender/30'}`}>
          <span className="material-symbols-outlined text-2xl text-lavender">
            {getCategoryIcon(category)}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${isDark ? 'bg-lavender/20 text-lavender' : 'bg-brand-green/20 text-brand-green'}`}>{category}</span>
            <span className={`text-xs font-bold ${isDark ? 'text-white/80' : 'text-primary/80'}`}>• {duration}</span>
            {isOnWaitlist ? (
              <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-500 px-1.5 py-0.5 rounded-md whitespace-nowrap">Waitlist</span>
            ) : isEnrolled ? (
              <span className="text-[10px] font-bold uppercase tracking-wider bg-accent text-brand-green px-1.5 py-0.5 rounded-md whitespace-nowrap">Going</span>
            ) : null}
          </div>
          <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-primary'}`}>{title}</h3>
        </div>
        <div className="flex flex-col items-end flex-shrink-0">
          <span className={`text-sm font-bold ${isDark ? 'text-accent' : 'text-primary'}`}>{date}</span>
          <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-primary'}`}>{formattedTime.time}</span>
          <span className={`text-xs font-medium ${isDark ? 'text-white/70' : 'text-primary/70'}`}>{formattedTime.period}</span>
        </div>
      </div>
    </div>
    <div className={`accordion-content ${isExpanded ? 'expanded' : ''}`}>
      <div className="px-4 pb-4 pt-0 space-y-3">
        <div className={`flex items-center gap-1.5 text-sm ${isDark ? 'text-gray-400' : 'text-primary/70'}`}>
          <span className="material-symbols-outlined text-[16px]">person</span>
          <span>{instructor}</span>
        </div>
        <p className={`text-sm leading-relaxed ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
          {description || "Join us for a restorative session designed to improve flexibility, strength, and mental clarity."}
        </p>
        <div className={`flex items-center gap-1.5 text-xs font-bold ${isFull && !isEnrolled ? 'text-orange-500' : isOnWaitlist ? 'text-amber-500' : isEnrolled ? 'text-green-500' : (isDark ? 'text-white/80' : 'text-primary/80')}`}>
          <span className={`w-2 h-2 rounded-full ${isFull && !isEnrolled ? 'bg-orange-500' : isOnWaitlist ? 'bg-amber-500' : isEnrolled ? 'bg-green-500' : 'bg-green-500'}`}></span>
          {getSpotDisplay()}
        </div>
        {isMembershipInactive ? (
          <div className={`w-full py-2.5 rounded-lg flex items-center justify-center ${isDark ? 'bg-white/10' : 'bg-[#F2F2EC]'}`}>
            <span className={`text-xs font-medium ${isDark ? 'text-white/60' : 'text-primary/60'}`}>Members Only Class</span>
          </div>
        ) : isEnrolled ? (
          <button 
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            disabled={isCancelling}
            className={`w-full py-2.5 rounded-lg font-bold text-sm transition-all border ${isDark ? 'border-red-500/50 text-red-400 hover:bg-red-500/10' : 'border-red-500/50 text-red-500 hover:bg-red-500/10'} ${isCancelling ? 'opacity-50 cursor-not-allowed' : 'active:scale-[0.98]'}`}
          >
            {isCancelling ? 'Cancelling...' : isOnWaitlist ? 'Leave Waitlist' : 'Cancel'}
          </button>
        ) : showFullNoWaitlist ? (
          <div className={`w-full py-2.5 rounded-lg flex items-center justify-center ${isDark ? 'bg-white/10' : 'bg-[#F2F2EC]'}`}>
            <span className={`text-xs font-medium ${isDark ? 'text-white/60' : 'text-primary/60'}`}>Class Full</span>
          </div>
        ) : (
          <button 
            onClick={(e) => { e.stopPropagation(); onBook(); }}
            disabled={isRsvping}
            className={`w-full py-2.5 rounded-lg font-bold text-sm transition-all ${isRsvping ? 'opacity-50 cursor-not-allowed' : 'active:scale-[0.98]'} ${showJoinWaitlist ? 'bg-amber-500/20 text-amber-500 border border-amber-500/50' : (isDark ? 'bg-white text-brand-green' : 'bg-brand-green text-white')}`}
          >
            {isRsvping ? 'Confirming...' : showJoinWaitlist ? 'Join Waitlist' : 'RSVP'}
          </button>
        )}
      </div>
    </div>
  </div>
  );
};

const MedSpaCard: React.FC<{title: string; subtitle?: string; children: React.ReactNode; isDark?: boolean}> = ({ title, subtitle, children, isDark = true }) => (
  <div className={`rounded-2xl p-5 border glass-card ${isDark ? 'border-white/20' : 'border-black/10'}`}>
    <div className="flex items-center justify-between mb-4">
      <h3 className={`font-bold text-xl ${isDark ? 'text-white' : 'text-primary'}`}>
        {title}
      </h3>
      {subtitle && <span className={`text-lg font-bold ${isDark ? 'text-accent' : 'text-primary'}`}>{subtitle}</span>}
    </div>
    <div className="space-y-3">{children}</div>
  </div>
);

const MenuItem: React.FC<{name: string; price?: string; desc?: string; isDark?: boolean}> = ({ name, price, desc, isDark = true }) => (
  <div className="flex justify-between items-start py-1">
    <div className="flex-1 pr-4">
      <span className={`text-sm font-medium ${isDark ? 'text-gray-500' : 'text-primary/80'}`}>{name}</span>
      {desc && <p className={`text-xs mt-0.5 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>{desc}</p>}
    </div>
    {price && <span className={`text-sm font-bold flex-shrink-0 ${isDark ? 'text-white' : 'text-primary'}`}>{price}</span>}
  </div>
);

export default Wellness;