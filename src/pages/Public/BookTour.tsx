import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import { triggerHaptic } from '../../utils/haptics';
import { formatPhoneNumber } from '../../utils/phoneFormat';
import { usePageReady } from '../../contexts/PageReadyContext';
import SEO from '../../components/SEO';

interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

interface FormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

interface BookingResult {
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  guestName: string;
}

const formatTime12h = (time24: string): string => {
  const [h, m] = time24.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`;
};

const formatDateNice = (dateStr: string): string => {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};

const generateNext14Days = (): string[] => {
  const days: string[] = [];
  const now = new Date();
  const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  for (let i = 1; i <= 14; i++) {
    const d = new Date(pacific);
    d.setDate(d.getDate() + i);
    days.push(d.toISOString().split('T')[0]);
  }
  return days;
};

const BookTour: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState<FormData>({ firstName: '', lastName: '', email: '', phone: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedTime, setSelectedTime] = useState('');
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [booking, setBooking] = useState(false);
  const [bookingResult, setBookingResult] = useState<BookingResult | null>(null);
  const [error, setError] = useState('');

  const availableDays = generateNext14Days();

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  const fetchSlots = useCallback(async (date: string) => {
    setLoadingSlots(true);
    setSlots([]);
    setSelectedTime('');
    try {
      const res = await fetch(`/api/tours/availability?date=${date}`);
      if (!res.ok) throw new Error('Failed to load availability');
      const data = await res.json();
      setSlots(data.availableSlots || []);
    } catch {
      setSlots([]);
    } finally {
      setLoadingSlots(false);
    }
  }, []);

  useEffect(() => {
    if (selectedDate) {
      fetchSlots(selectedDate);
    }
  }, [selectedDate, fetchSlots]);

  const validateStep1 = (): boolean => {
    const errors: Record<string, string> = {};
    if (!formData.firstName.trim()) errors.firstName = 'First name is required';
    if (!formData.lastName.trim()) errors.lastName = 'Last name is required';
    if (!formData.email.trim()) errors.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) errors.email = 'Please enter a valid email';
    if (!formData.phone.trim()) errors.phone = 'Phone number is required';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleContinueToStep2 = () => {
    if (validateStep1()) {
      triggerHaptic('light');
      setStep(2);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleBook = async () => {
    if (!selectedDate || !selectedTime) return;
    setBooking(true);
    setError('');
    triggerHaptic('medium');
    try {
      const res = await fetch('/api/tours/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: formData.firstName,
          lastName: formData.lastName,
          email: formData.email,
          phone: formData.phone || undefined,
          date: selectedDate,
          startTime: selectedTime,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to book tour');
      triggerHaptic('success');
      setBookingResult(data.tour);
      setStep(3);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: unknown) {
      triggerHaptic('error');
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBooking(false);
    }
  };

  const getInputClass = (fieldName: string) =>
    `w-full px-4 py-3 rounded-xl border transition-colors focus:outline-none focus:ring-2 ${
      fieldErrors[fieldName]
        ? 'border-red-500 dark:border-red-500 focus:ring-red-500 bg-red-50 dark:bg-red-500/10'
        : 'border-primary/20 dark:border-white/10 bg-white dark:bg-white/5 focus:ring-primary focus:border-primary'
    } text-primary dark:text-white placeholder:text-gray-400 dark:placeholder-white/40`;

  const getDayLabel = (dateStr: string) => {
    const d = new Date(dateStr + 'T12:00:00');
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dayNum = d.getDate();
    const month = d.toLocaleDateString('en-US', { month: 'short' });
    return { dayName, dayNum, month };
  };

  return (
    <div className="min-h-screen pb-0 overflow-x-hidden relative bg-bone dark:bg-[#141414]">
      <SEO
        title="Book a Tour | Ever Club — Golf & Social Club, OC"
        description="Schedule a free 30-min tour of Ever Club in Tustin. See Trackman simulators, coworking, café & wellness at OC's top private club."
        url="/tours"
      />
      <div
        className="fixed top-0 left-0 right-0 bg-primary"
        style={{ height: 'env(safe-area-inset-top, 0px)', zIndex: 'var(--z-header)' }}
        aria-hidden="true"
      />

      <div className="pt-[max(1rem,env(safe-area-inset-top))] px-4 pb-4">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-primary/70 dark:text-white/70 hover:text-primary dark:hover:text-white transition-colors py-2"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          <span className="text-sm font-medium">Back</span>
        </Link>
      </div>

      <div className="px-4 pb-12">
        <div className="max-w-xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-3xl md:text-4xl font-serif font-light text-primary dark:text-white mb-3">
              Book Your Private Tour
            </h1>
            <p className="text-primary/60 dark:text-white/60 text-sm md:text-base">
              Experience the club firsthand. Meet the team, explore the space, and see if Ever Club is the right fit for you.
            </p>
            <p className="text-primary/40 dark:text-white/40 text-xs font-medium mt-2">
              Join 200+ members who started with a tour.
            </p>
            <div className="flex items-center justify-center gap-6 text-primary/50 dark:text-white/50 text-xs mt-4 mb-2">
              <span className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">schedule</span>
                30 minutes
              </span>
              <span className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">person</span>
                Private & guided
              </span>
              <span className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">check_circle</span>
                No commitment
              </span>
            </div>
          </div>

          {step === 3 && bookingResult ? (
            <div className="bg-white/60 dark:bg-white/5 backdrop-blur-xl rounded-[2rem] border border-white/80 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-8 text-center">
              <div className="w-20 h-20 bg-green-100 dark:bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <span className="material-symbols-outlined text-4xl text-green-600 dark:text-green-400">check_circle</span>
              </div>
              <h2 className="text-2xl font-bold text-primary dark:text-white mb-3">You're All Set!</h2>
              <p className="text-primary/70 dark:text-white/70 mb-6 max-w-sm mx-auto">
                Your tour is confirmed. We'll send a confirmation to <strong className="text-primary dark:text-white">{formData.email}</strong>.
              </p>

              <div className="bg-primary/5 dark:bg-white/5 rounded-2xl p-6 mb-8 text-left space-y-3">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary/60 dark:text-white/60">calendar_today</span>
                  <span className="text-primary dark:text-white font-medium">{formatDateNice(bookingResult.date)}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary/60 dark:text-white/60">schedule</span>
                  <span className="text-primary dark:text-white font-medium">
                    {formatTime12h(bookingResult.startTime)} – {formatTime12h(bookingResult.endTime)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary/60 dark:text-white/60">location_on</span>
                  <span className="text-primary dark:text-white font-medium">3625 W MacArthur Blvd, Santa Ana, CA 92704</span>
                </div>
              </div>

              <div className="border-t border-primary/10 dark:border-white/10 pt-6 mt-2">
                <p className="text-sm text-primary/60 dark:text-white/60 mb-4">
                  Ready to learn more about membership?
                </p>
                <Link
                  to="/membership"
                  className="text-sm font-semibold text-primary dark:text-white hover:opacity-80 transition-opacity flex items-center justify-center gap-1"
                >
                  Explore Membership
                  <span className="material-symbols-outlined text-lg">arrow_forward</span>
                </Link>
              </div>

              <Link
                to="/"
                className="inline-block px-8 py-4 bg-primary text-white rounded-[2rem] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all duration-fast"
              >
                Back to Home
              </Link>
            </div>
          ) : (
            <div className="bg-white/60 dark:bg-white/5 backdrop-blur-xl rounded-[2rem] border border-white/80 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)] overflow-hidden">
              <div className="flex items-center justify-center gap-3 py-6 border-b border-primary/10 dark:border-white/10">
                <div className="flex flex-col items-center gap-1">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-fast ${step === 1 ? 'bg-primary text-white' : step > 1 ? 'bg-green-500 text-white' : 'bg-primary/10 dark:bg-white/10 text-primary dark:text-white'}`}>
                    {step > 1 ? <span className="material-symbols-outlined text-lg">check</span> : '1'}
                  </div>
                  <span className={`text-[10px] font-medium ${step === 1 ? 'text-primary dark:text-white' : 'text-primary/40 dark:text-white/40'}`}>Your Info</span>
                </div>
                <div className="w-16 h-0.5 bg-primary/20 dark:bg-white/20 mb-5" />
                <div className="flex flex-col items-center gap-1">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-fast ${step === 2 ? 'bg-primary text-white' : 'bg-primary/10 dark:bg-white/10 text-primary dark:text-white'}`}>2</div>
                  <span className={`text-[10px] font-medium ${step === 2 ? 'text-primary dark:text-white' : 'text-primary/40 dark:text-white/40'}`}>Pick a Time</span>
                </div>
              </div>

              {step === 1 && (
                <div className="p-6 md:p-8 space-y-5">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="tour-firstName" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                        First Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        id="tour-firstName"
                        type="text"
                        value={formData.firstName}
                        onChange={(e) => {
                          setFormData(prev => ({ ...prev, firstName: e.target.value }));
                          if (fieldErrors.firstName) setFieldErrors(prev => ({ ...prev, firstName: '' }));
                        }}
                        placeholder="Jane"
                        className={getInputClass('firstName')}
                      />
                      {fieldErrors.firstName && (
                        <p className="text-sm text-red-500 mt-1 flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">error</span>
                          {fieldErrors.firstName}
                        </p>
                      )}
                    </div>
                    <div>
                      <label htmlFor="tour-lastName" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                        Last Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        id="tour-lastName"
                        type="text"
                        value={formData.lastName}
                        onChange={(e) => {
                          setFormData(prev => ({ ...prev, lastName: e.target.value }));
                          if (fieldErrors.lastName) setFieldErrors(prev => ({ ...prev, lastName: '' }));
                        }}
                        placeholder="Doe"
                        className={getInputClass('lastName')}
                      />
                      {fieldErrors.lastName && (
                        <p className="text-sm text-red-500 mt-1 flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">error</span>
                          {fieldErrors.lastName}
                        </p>
                      )}
                    </div>
                  </div>

                  <div>
                    <label htmlFor="tour-email" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                      Email <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="tour-email"
                      type="email"
                      value={formData.email}
                      onChange={(e) => {
                        setFormData(prev => ({ ...prev, email: e.target.value }));
                        if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: '' }));
                      }}
                      placeholder="jane@example.com"
                      className={getInputClass('email')}
                    />
                    {fieldErrors.email && (
                      <p className="text-sm text-red-500 mt-1 flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm">error</span>
                        {fieldErrors.email}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="tour-phone" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                      Phone <span className="text-red-500 dark:text-red-400">*</span>
                    </label>
                    <input
                      id="tour-phone"
                      type="tel"
                      value={formData.phone}
                      onChange={(e) => {
                        setFormData(prev => ({ ...prev, phone: formatPhoneNumber(e.target.value) }));
                        if (fieldErrors.phone) setFieldErrors(prev => ({ ...prev, phone: '' }));
                      }}
                      placeholder="(949) 555-0100"
                      className={getInputClass('phone')}
                    />
                    {fieldErrors.phone && (
                      <p className="text-sm text-red-500 dark:text-red-400 mt-1 flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm">error</span>
                        {fieldErrors.phone}
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={handleContinueToStep2}
                    className="tactile-btn w-full py-4 rounded-xl bg-primary text-white font-bold text-sm hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
                  >
                    Continue to Select Time
                    <span className="material-symbols-outlined text-lg">arrow_forward</span>
                  </button>
                </div>
              )}

              {step === 2 && (
                <div className="p-6 md:p-8 space-y-6">
                  <div>
                    <h3 className="text-sm font-semibold text-primary dark:text-white mb-3">Select a Date</h3>
                    <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
                      {availableDays.map((date) => {
                        const { dayName, dayNum, month } = getDayLabel(date);
                        const isSelected = selectedDate === date;
                        return (
                          <button
                            key={date}
                            type="button"
                            onClick={() => setSelectedDate(date)}
                            className={`flex-shrink-0 w-[72px] py-3 rounded-2xl border text-center transition-all duration-fast ${
                              isSelected
                                ? 'bg-primary text-white border-primary shadow-lg scale-[1.02]'
                                : 'bg-white/60 dark:bg-white/5 border-primary/10 dark:border-white/10 text-primary dark:text-white hover:border-primary/30 dark:hover:border-white/30'
                            }`}
                          >
                            <div className={`text-[10px] font-medium uppercase ${isSelected ? 'text-white/70' : 'text-primary/50 dark:text-white/50'}`}>{dayName}</div>
                            <div className="text-xl font-bold leading-tight">{dayNum}</div>
                            <div className={`text-[10px] ${isSelected ? 'text-white/70' : 'text-primary/50 dark:text-white/50'}`}>{month}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {selectedDate && (
                    <div>
                      <h3 className="text-sm font-semibold text-primary dark:text-white mb-3">Available Times</h3>
                      {loadingSlots ? (
                        <div className="flex items-center justify-center py-8 gap-3">
                          <div className="w-5 h-5 border-2 border-primary/30 dark:border-white/30 border-t-primary dark:border-t-white rounded-full animate-spin" />
                          <span className="text-sm text-primary/60 dark:text-white/60">Checking availability...</span>
                        </div>
                      ) : slots.length === 0 ? (
                        <div className="text-center py-8">
                          <span className="material-symbols-outlined text-3xl text-primary/30 dark:text-white/30 mb-2 block">event_busy</span>
                          <p className="text-primary/60 dark:text-white/60 text-sm">No available times on this date. Please try another day.</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                          {slots.map((slot) => {
                            const isSelected = selectedTime === slot.start;
                            return (
                              <button
                                key={slot.start}
                                type="button"
                                onClick={() => {
                                  setSelectedTime(slot.start);
                                  triggerHaptic('light');
                                }}
                                className={`tactile-btn py-3 px-2 rounded-xl text-sm font-medium transition-all duration-fast ${
                                  isSelected
                                    ? 'bg-primary text-white shadow-lg scale-[1.02]'
                                    : 'bg-white/60 dark:bg-white/5 border border-primary/10 dark:border-white/10 text-primary dark:text-white hover:border-primary/30 dark:hover:border-white/30'
                                }`}
                              >
                                {formatTime12h(slot.start)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {error && (
                    <p className="text-red-500 text-sm text-center">{error}</p>
                  )}

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => { setStep(1); setError(''); }}
                      className="tactile-btn flex-1 py-4 rounded-xl border border-primary/20 dark:border-white/20 text-primary dark:text-white font-bold text-sm hover:bg-primary/5 dark:hover:bg-white/5 transition-colors"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={handleBook}
                      disabled={!selectedDate || !selectedTime || booking}
                      className="tactile-btn flex-[2] py-4 rounded-xl bg-primary text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
                    >
                      {booking ? (
                        <>
                          <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Booking...
                        </>
                      ) : (
                        <>
                          Confirm Tour
                          <span className="material-symbols-outlined text-lg">check</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <Footer hideCta />
    </div>
  );
};

export default BookTour;
