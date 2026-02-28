import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import { triggerHaptic } from '../../utils/haptics';
import { formatPhoneNumber } from '../../utils/phoneFormat';
import { usePageReady } from '../../contexts/PageReadyContext';
import WalkingGolferSpinner from '../../components/WalkingGolferSpinner';
import SEO from '../../components/SEO';

const getHubspotCookie = (): string | null => {
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'hubspotutk') {
      return value;
    }
  }
  return null;
};

const EVENT_TYPES = [
  'Private Event',
  'Birthday',
  'Corporate',
  'Brand Activation',
  'Other'
];

const EVENT_SERVICES = [
  { id: 'catering', label: 'Catering (Light bites / Full meal)' },
  { id: 'bar_service', label: 'Bar Service (Open Bar / Drink Tickets / Cash Bar)' },
  { id: 'music', label: 'Music (DJ / Live Band)' },
  { id: 'photographer', label: 'Photographer' },
  { id: 'av', label: 'Audio / Visual (Screens & Microphones)' },
  { id: 'golf_bays', label: 'Golf Bays' }
];

const PrivateHireInquire: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  
  const [formData, setFormData] = useState({
    company: '',
    firstname: '',
    lastname: '',
    email: '',
    phone: '',
    consent: false,
    event_date: '',
    event_time: '',
    event_type: '',
    guest_count: '',
    additional_details: '',
    services: [] as string[]
  });

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  const handleChange = (name: string, value: string | boolean | string[]) => {
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const toggleService = (serviceId: string) => {
    setFormData(prev => ({
      ...prev,
      services: prev.services.includes(serviceId)
        ? prev.services.filter(s => s !== serviceId)
        : [...prev.services, serviceId]
    }));
  };

  const validateStep1 = () => {
    const errors: Record<string, string> = {};
    if (!formData.firstname.trim()) errors.firstname = 'First name is required';
    if (!formData.lastname.trim()) errors.lastname = 'Last name is required';
    if (!formData.email.trim()) errors.email = 'Email is required';
    if (!formData.phone.trim()) errors.phone = 'Phone number is required';
    return errors;
  };

  const handleNext = () => {
    const errors = validateStep1();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError('Please fill in all required fields');
      return;
    }
    setError('');
    triggerHaptic('light');
    setStep(2);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleBack = () => {
    triggerHaptic('light');
    setStep(1);
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    triggerHaptic('medium');

    if (!formData.consent) {
      setFieldErrors({ consent: 'You must agree to receive communications' });
      setError('Please agree to receive communications before submitting.');
      setLoading(false);
      return;
    }

    try {
      const servicesText = formData.services
        .map(id => EVENT_SERVICES.find(s => s.id === id)?.label || id)
        .join('; ');

      const fields = [
        { name: 'company', value: formData.company },
        { name: 'firstname', value: formData.firstname },
        { name: 'lastname', value: formData.lastname },
        { name: 'email', value: formData.email },
        { name: 'phone', value: formData.phone },
        { name: 'event_date', value: formData.event_date },
        { name: 'event_time', value: formData.event_time },
        { name: 'event_type', value: formData.event_type },
        { name: 'guest_count', value: formData.guest_count },
        { name: 'additional_details', value: formData.additional_details },
        { name: 'event_services', value: servicesText },
        { name: 'marketing_consent', value: formData.consent ? 'Yes' : 'No' }
      ];

      const hutk = getHubspotCookie();
      const context: Record<string, unknown> = {
        pageUri: window.location.href,
        pageName: 'Private Hire - Event Inquiry'
      };
      if (hutk) {
        context.hutk = hutk;
      }

      const response = await fetch('/api/hubspot/forms/private-hire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, context })
      });

      if (!response.ok) {
        throw new Error('Submission failed');
      }

      triggerHaptic('success');
      setSuccess(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: unknown) {
      triggerHaptic('error');
      setError((err instanceof Error ? err.message : String(err)) || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const getInputClass = (fieldName: string) => `w-full px-4 py-3 rounded-xl border transition-colors focus:outline-none focus:ring-2 ${
    fieldErrors[fieldName] 
      ? 'border-red-500 dark:border-red-500 focus:ring-red-500 bg-red-50 dark:bg-red-500/10' 
      : 'border-primary/20 dark:border-white/10 bg-white dark:bg-white/5 focus:ring-primary focus:border-primary'
  } text-primary dark:text-white placeholder:text-gray-400 dark:placeholder-white/40`;

  return (
    <div className="min-h-screen pb-0 overflow-x-hidden relative bg-bone dark:bg-[#141414]">
      <SEO title="Private Event Inquiry | Ever Club — OC Venue" description="Submit an inquiry for private events at Ever Club in Tustin, OC. Golf simulator parties, corporate events, celebrations & more." url="/private-hire/inquire" />
      <div 
        className="fixed top-0 left-0 right-0 bg-primary"
        style={{ height: 'env(safe-area-inset-top, 0px)', zIndex: 'var(--z-header)' }}
        aria-hidden="true"
      />

      <div className="pt-[max(1rem,env(safe-area-inset-top))] px-4 pb-4">
        <Link 
          to="/private-hire" 
          className="tactile-btn inline-flex items-center gap-1 text-primary/70 dark:text-white/70 hover:text-primary dark:hover:text-white transition-colors py-2"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          <span className="text-sm font-medium">Back to Private Hire</span>
        </Link>
      </div>

      <div className="px-4 pb-12">
        <div className="max-w-xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-5xl text-primary dark:text-white mb-3 leading-none" style={{ fontFamily: 'var(--font-display)' }}>
              Host Your Event
            </h1>
            <p className="text-primary/60 dark:text-white/60 text-sm md:text-base">
              Tell us about your vision, and our team will be in touch to help you bring it to life.
            </p>
          </div>

          {success ? (
            <div className="bg-white/60 dark:bg-white/5 backdrop-blur-xl rounded-xl border border-white/80 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-8 text-center">
              <div className="w-20 h-20 bg-green-100 dark:bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <span className="material-symbols-outlined text-4xl text-green-600 dark:text-green-400">check_circle</span>
              </div>
              <h2 className="text-2xl text-primary dark:text-white mb-3 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Thank You!</h2>
              <p className="text-primary/70 dark:text-white/70 mb-8 max-w-sm mx-auto">
                We've received your event inquiry and will be in touch soon to discuss the details.
              </p>
              <Link 
                to="/private-hire"
                className="inline-block px-8 py-4 bg-primary text-white rounded-[4px] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all duration-fast"
              >
                Back to Private Hire
              </Link>
            </div>
          ) : (
            <div className="bg-white/60 dark:bg-white/5 backdrop-blur-xl rounded-xl border border-white/80 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)] overflow-hidden">
              <div className="flex items-center justify-center gap-3 py-6 border-b border-primary/10 dark:border-white/10">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-fast ${step === 1 ? 'bg-primary text-white' : 'bg-primary/10 dark:bg-white/10 text-primary dark:text-white'}`}>1</div>
                <div className="w-16 h-0.5 bg-primary/20 dark:bg-white/20" />
                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-fast ${step === 2 ? 'bg-primary text-white' : 'bg-primary/10 dark:bg-white/10 text-primary dark:text-white'}`}>2</div>
              </div>

              <form onSubmit={handleSubmit} className="p-6 md:p-8">
                {step === 1 ? (
                  <div className="space-y-5">
                    <div>
                      <label htmlFor="hire-company" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                        Company / Organization
                      </label>
                      <input
                        id="hire-company"
                        type="text"
                        value={formData.company}
                        onChange={(e) => handleChange('company', e.target.value)}
                        placeholder="Company / Organization (Optional)"
                        className={getInputClass('company')}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="hire-firstname" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                          First Name <span className="text-red-500 dark:text-red-400">*</span>
                        </label>
                        <input
                          id="hire-firstname"
                          type="text"
                          value={formData.firstname}
                          onChange={(e) => {
                            handleChange('firstname', e.target.value);
                            if (fieldErrors.firstname) setFieldErrors(prev => ({ ...prev, firstname: '' }));
                          }}
                          placeholder="Jane"
                          className={getInputClass('firstname')}
                        />
                        {fieldErrors.firstname && (
                          <p className="text-sm text-red-500 dark:text-red-400 mt-1 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">error</span>
                            {fieldErrors.firstname}
                          </p>
                        )}
                      </div>
                      <div>
                        <label htmlFor="hire-lastname" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                          Last Name <span className="text-red-500 dark:text-red-400">*</span>
                        </label>
                        <input
                          id="hire-lastname"
                          type="text"
                          value={formData.lastname}
                          onChange={(e) => {
                            handleChange('lastname', e.target.value);
                            if (fieldErrors.lastname) setFieldErrors(prev => ({ ...prev, lastname: '' }));
                          }}
                          placeholder="Doe"
                          className={getInputClass('lastname')}
                        />
                        {fieldErrors.lastname && (
                          <p className="text-sm text-red-500 dark:text-red-400 mt-1 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">error</span>
                            {fieldErrors.lastname}
                          </p>
                        )}
                      </div>
                    </div>

                    <div>
                      <label htmlFor="hire-email" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                        Email <span className="text-red-500 dark:text-red-400">*</span>
                      </label>
                      <input
                        id="hire-email"
                        type="email"
                        value={formData.email}
                        onChange={(e) => {
                          handleChange('email', e.target.value);
                          if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: '' }));
                        }}
                        placeholder="jane.doe@example.com"
                        className={getInputClass('email')}
                      />
                      {fieldErrors.email && (
                        <p className="text-sm text-red-500 dark:text-red-400 mt-1 flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">error</span>
                          {fieldErrors.email}
                        </p>
                      )}
                    </div>

                    <div>
                      <label htmlFor="hire-phone" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                        Phone Number <span className="text-red-500 dark:text-red-400">*</span>
                      </label>
                      <input
                        id="hire-phone"
                        type="tel"
                        value={formData.phone}
                        onChange={(e) => {
                          handleChange('phone', formatPhoneNumber(e.target.value));
                          if (fieldErrors.phone) setFieldErrors(prev => ({ ...prev, phone: '' }));
                        }}
                        placeholder="(555) 000-0000"
                        className={getInputClass('phone')}
                      />
                      {fieldErrors.phone && (
                        <p className="text-sm text-red-500 dark:text-red-400 mt-1 flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">error</span>
                          {fieldErrors.phone}
                        </p>
                      )}
                    </div>

                    {error && (
                      <div className="p-4 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-500/20 flex items-start gap-2">
                        <span className="material-symbols-outlined text-red-600 dark:text-red-400 text-lg mt-0.5">error</span>
                        <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={handleNext}
                      className="w-full py-4 bg-primary text-white rounded-[4px] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all duration-fast"
                    >
                      Next
                    </button>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <h3 className="text-2xl text-primary dark:text-white leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Event Details</h3>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="hire-event-date" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                          Event Date
                        </label>
                        <input
                          id="hire-event-date"
                          type="date"
                          value={formData.event_date}
                          onChange={(e) => handleChange('event_date', e.target.value)}
                          className={getInputClass('event_date')}
                        />
                      </div>
                      <div>
                        <label htmlFor="hire-event-time" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                          Time
                        </label>
                        <input
                          id="hire-event-time"
                          type="text"
                          value={formData.event_time}
                          onChange={(e) => handleChange('event_time', e.target.value)}
                          placeholder='e.g., "Set up at 2 PM, start at 4 PM"'
                          className={getInputClass('event_time')}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="hire-event-type" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                          Event Type
                        </label>
                        <select
                          id="hire-event-type"
                          value={formData.event_type}
                          onChange={(e) => handleChange('event_type', e.target.value)}
                          className={getInputClass('event_type')}
                        >
                          <option value="">Select...</option>
                          {EVENT_TYPES.map(type => (
                            <option key={type} value={type}>{type}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="hire-guest-count" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                          Guest Count
                        </label>
                        <input
                          id="hire-guest-count"
                          type="number"
                          value={formData.guest_count}
                          onChange={(e) => handleChange('guest_count', e.target.value)}
                          placeholder="Numbers only (e.g., 50)"
                          min="1"
                          className={getInputClass('guest_count')}
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="hire-additional-details" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                        Additional Details
                      </label>
                      <textarea
                        id="hire-additional-details"
                        value={formData.additional_details}
                        onChange={(e) => handleChange('additional_details', e.target.value)}
                        placeholder="Tell us about your theme, dietary needs, or special requests."
                        rows={4}
                        className={`${getInputClass('additional_details')} resize-none`}
                      />
                    </div>

                    <div>
                      <label htmlFor="hire-services" className="block text-sm font-semibold text-primary dark:text-white mb-3">
                        Event Services & Requirements
                      </label>
                      <div className="space-y-2">
                        {EVENT_SERVICES.map(service => (
                          <label key={service.id} className="flex items-center gap-3 cursor-pointer group p-3 rounded-xl hover:bg-primary/5 dark:hover:bg-white/5 transition-colors">
                            <input
                              type="checkbox"
                              checked={formData.services.includes(service.id)}
                              onChange={() => toggleService(service.id)}
                              className="w-5 h-5 rounded border-primary/30 text-primary focus:ring-primary"
                            />
                            <span className="text-sm text-primary dark:text-white group-hover:text-primary dark:group-hover:text-white transition-colors">
                              {service.label}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="pt-4 border-t border-primary/10 dark:border-white/10">
                      <p className="text-xs text-primary/60 dark:text-white/60 mb-4 leading-relaxed">
                        Ever Club is committed to protecting and respecting your privacy. We use your information to administer your account and to provide the products, services, and updates you request from us. We also contact you with information about membership, events, promotions, operational updates, and other content that may be relevant to you. If you consent to receiving communications from us, please indicate your preferences below.
                      </p>
                      <label className={`flex items-start gap-3 cursor-pointer group p-3 rounded-xl transition-colors ${fieldErrors.consent ? 'bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20' : 'hover:bg-primary/5 dark:hover:bg-white/5'}`}>
                        <input
                          type="checkbox"
                          checked={formData.consent}
                          onChange={(e) => {
                            handleChange('consent', e.target.checked);
                            if (fieldErrors.consent) setFieldErrors(prev => ({ ...prev, consent: '' }));
                          }}
                          className="mt-0.5 w-5 h-5 rounded border-primary/30 text-primary focus:ring-primary"
                        />
                        <span className="text-sm text-primary dark:text-white leading-relaxed">
                          I agree to receive communications from Ever Club regarding membership, account updates, events, and promotions. <span className="text-red-500 dark:text-red-400">*</span>
                        </span>
                      </label>
                      {fieldErrors.consent && (
                        <p className="text-sm text-red-500 dark:text-red-400 mt-2 flex items-center gap-1 pl-1">
                          <span className="material-symbols-outlined text-sm">error</span>
                          {fieldErrors.consent}
                        </p>
                      )}
                      <p className="text-xs text-primary/60 dark:text-white/60 mt-4 leading-relaxed">
                        You can unsubscribe from Ever Club communications at any time. For more information about how to unsubscribe, our privacy practices, and how we protect and respect your personal information, please review our Privacy Policy.
                      </p>
                      <p className="text-xs text-primary/60 dark:text-white/60 mt-3 leading-relaxed">
                        By submitting this form, you authorize Ever Club to store and process your personal information to provide the content, services, and membership evaluation you have requested.
                      </p>
                    </div>

                    {error && (
                      <div className="p-4 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-500/20 flex items-start gap-2">
                        <span className="material-symbols-outlined text-red-600 dark:text-red-400 text-lg mt-0.5">error</span>
                        <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
                      </div>
                    )}

                    <div className="flex gap-3 pt-2">
                      <button
                        type="button"
                        onClick={handleBack}
                        className="tactile-btn flex-1 py-4 bg-primary/10 dark:bg-white/10 text-primary dark:text-white rounded-[4px] font-semibold hover:bg-primary/20 dark:hover:bg-white/20 transition-all duration-fast"
                      >
                        Previous
                      </button>
                      <button
                        type="submit"
                        disabled={loading}
                        className="flex-1 py-4 bg-primary text-white rounded-[4px] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all duration-fast disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {loading ? (
                          <>
                            <WalkingGolferSpinner size="sm" variant="light" />
                            Submitting...
                          </>
                        ) : (
                          'Plan Your Event'
                        )}
                      </button>
                    </div>
                    <p className="text-xs text-primary/40 dark:text-white/40 text-center mt-3 font-light">Our events team will respond within 24 hours.</p>
                    <p className="text-xs text-primary/40 dark:text-white/40 text-center mt-1 font-light">Your information is kept private and never shared.</p>
                  </div>
                )}
              </form>
            </div>
          )}
        </div>
      </div>

      <Footer />
    </div>
  );
};

export default PrivateHireInquire;
