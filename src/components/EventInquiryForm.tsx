import React, { useState } from 'react';
import { triggerHaptic } from '../utils/haptics';
import WalkingGolferSpinner from './WalkingGolferSpinner';
import SlideUpDrawer from './SlideUpDrawer';

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
  'Corporate Event',
  'Private Party',
  'Wedding Reception',
  'Birthday Celebration',
  'Holiday Party',
  'Networking Event',
  'Team Building',
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

interface EventInquiryFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const EventInquiryForm: React.FC<EventInquiryFormProps> = ({
  isOpen,
  onClose,
  onSuccess
}) => {
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
  };

  const handleBack = () => {
    triggerHaptic('light');
    setStep(1);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    triggerHaptic('medium');

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
      const context: Record<string, any> = {
        pageUri: window.location.href,
        pageName: 'Private Hire - Event Inquiry'
      };
      if (hutk) {
        context.hutk = hutk;
      }

      const response = await fetch('/api/hubspot/forms/event-inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, context })
      });

      if (!response.ok) {
        throw new Error('Submission failed');
      }

      triggerHaptic('success');
      setSuccess(true);
      onSuccess?.();
    } catch (err: any) {
      triggerHaptic('error');
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    triggerHaptic('light');
    setFormData({
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
      services: []
    });
    setStep(1);
    setSuccess(false);
    setError('');
    setFieldErrors({});
    onClose();
  };

  const getInputClass = (fieldName: string) => `w-full px-4 py-3 rounded-xl border transition-colors focus:outline-none focus:ring-2 ${
    fieldErrors[fieldName] 
      ? 'border-red-500 focus:ring-red-500 bg-red-50 dark:bg-red-900/10' 
      : 'glass-input focus:ring-accent'
  } text-primary dark:text-white placeholder:text-gray-400`;

  const renderFooter = () => {
    if (success) {
      return (
        <div className="p-4">
          <button
            onClick={handleClose}
            className="w-full py-4 min-h-[44px] bg-primary dark:bg-accent text-white dark:text-brand-green rounded-[2rem] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all duration-[400ms] ease-in-out"
          >
            Close
          </button>
        </div>
      );
    }
    
    if (step === 1) {
      return (
        <div className="p-4">
          <button
            type="button"
            onClick={handleNext}
            className="w-full py-4 min-h-[44px] bg-primary dark:bg-accent text-white dark:text-brand-green rounded-[2rem] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all duration-[400ms] ease-in-out"
          >
            Next
          </button>
        </div>
      );
    }
    
    return (
      <div className="p-4 flex gap-3">
        <button
          type="button"
          onClick={handleBack}
          className="flex-1 py-4 min-h-[44px] bg-gray-100 dark:bg-white/10 text-primary dark:text-white rounded-[2rem] font-semibold hover:bg-gray-200 dark:hover:bg-white/20 transition-all duration-[400ms] ease-in-out"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={loading}
          className="flex-1 py-4 min-h-[44px] bg-primary dark:bg-accent text-white dark:text-brand-green rounded-[2rem] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all duration-[400ms] ease-in-out disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <WalkingGolferSpinner size="sm" variant="light" />
              Submitting...
            </>
          ) : (
            'Submit'
          )}
        </button>
      </div>
    );
  };

  return (
    <SlideUpDrawer 
      isOpen={isOpen} 
      onClose={handleClose} 
      title="Host Your Event with Us" 
      maxHeight="full"
      stickyFooter={renderFooter()}
    >
      <div className="p-6">
        {success ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-3xl text-green-600 dark:text-green-400" aria-hidden="true">check_circle</span>
            </div>
            <h3 className="text-xl font-bold text-primary dark:text-white mb-2">Thank You!</h3>
            <p className="text-primary/70 dark:text-white/80 mb-6">We've received your event inquiry and will be in touch soon to discuss the details.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-center gap-2 mb-6">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${step === 1 ? 'bg-primary text-white' : 'bg-primary/10 text-primary'}`}>1</div>
              <div className="w-12 h-0.5 bg-gray-200 dark:bg-gray-700" />
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${step === 2 ? 'bg-primary text-white' : 'bg-primary/10 text-primary'}`}>2</div>
            </div>

            <div>
              {step === 1 ? (
                <div className="space-y-4">
                  <p className="text-gray-600 dark:text-white/80 text-sm mb-4">Tell us about your vision, and our team will be in touch to help you bring it to life.</p>
                  
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1.5 pl-1">
                      Company / Organization
                    </label>
                    <input
                      type="text"
                      value={formData.company}
                      onChange={(e) => handleChange('company', e.target.value)}
                      placeholder="Company / Organization (Optional)"
                      className="w-full px-4 py-3 glass-input text-primary dark:text-white placeholder:text-gray-400"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1.5 pl-1">
                        First Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={formData.firstname}
                        onChange={(e) => {
                          handleChange('firstname', e.target.value);
                          if (fieldErrors.firstname) setFieldErrors(prev => ({ ...prev, firstname: '' }));
                        }}
                        placeholder="Jane"
                        required
                        className={getInputClass('firstname')}
                      />
                      {fieldErrors.firstname && (
                        <p className="text-sm text-red-500 flex items-center gap-1 pl-1">
                          <span className="material-symbols-outlined text-sm">error</span>
                          {fieldErrors.firstname}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1.5 pl-1">
                        Last Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={formData.lastname}
                        onChange={(e) => {
                          handleChange('lastname', e.target.value);
                          if (fieldErrors.lastname) setFieldErrors(prev => ({ ...prev, lastname: '' }));
                        }}
                        placeholder="Doe"
                        required
                        className={getInputClass('lastname')}
                      />
                      {fieldErrors.lastname && (
                        <p className="text-sm text-red-500 flex items-center gap-1 pl-1">
                          <span className="material-symbols-outlined text-sm">error</span>
                          {fieldErrors.lastname}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1.5 pl-1">
                      Email <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="email"
                      value={formData.email}
                      onChange={(e) => {
                        handleChange('email', e.target.value);
                        if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: '' }));
                      }}
                      placeholder="jane.doe@example.com"
                      required
                      className={getInputClass('email')}
                    />
                    {fieldErrors.email && (
                      <p className="text-sm text-red-500 flex items-center gap-1 pl-1">
                        <span className="material-symbols-outlined text-sm">error</span>
                        {fieldErrors.email}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1.5 pl-1">
                      Phone Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="tel"
                      value={formData.phone}
                      onChange={(e) => {
                        handleChange('phone', e.target.value);
                        if (fieldErrors.phone) setFieldErrors(prev => ({ ...prev, phone: '' }));
                      }}
                      placeholder="+1 (555) 000-0000"
                      required
                      className={getInputClass('phone')}
                    />
                    {fieldErrors.phone && (
                      <p className="text-sm text-red-500 flex items-center gap-1 pl-1">
                        <span className="material-symbols-outlined text-sm">error</span>
                        {fieldErrors.phone}
                      </p>
                    )}
                  </div>

                  <div className="pt-2">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                      Ever Club is committed to protecting and respecting your privacy. We use your information to administer your account and to provide the products, services, and updates you request from us.
                    </p>
                    <label className="flex items-start gap-3 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={formData.consent}
                        onChange={(e) => handleChange('consent', e.target.checked)}
                        className="mt-1 w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        I agree to receive other communications from Even House.
                      </span>
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
                      By submitting this form, you authorize Even House to store and process your personal information to provide the content, services, and membership evaluation you have requested.
                    </p>
                  </div>

                  {error && (
                    <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-700 flex items-start gap-2" role="alert">
                      <span className="material-symbols-outlined text-red-600 dark:text-red-400 text-sm mt-0.5" aria-hidden="true">error</span>
                      <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <h3 className="text-lg font-bold text-primary dark:text-white">Event Details</h3>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1.5 pl-1">
                        Event Date
                      </label>
                      <input
                        type="date"
                        value={formData.event_date}
                        onChange={(e) => handleChange('event_date', e.target.value)}
                        className="w-full px-4 py-3 glass-input text-primary dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1.5 pl-1">
                        Time
                      </label>
                      <input
                        type="text"
                        value={formData.event_time}
                        onChange={(e) => handleChange('event_time', e.target.value)}
                        placeholder="e.g., Set up at 2 PM, start at 4 PM"
                        className="w-full px-4 py-3 glass-input text-primary dark:text-white placeholder:text-gray-400"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1.5 pl-1">
                        Event Type
                      </label>
                      <select
                        value={formData.event_type}
                        onChange={(e) => handleChange('event_type', e.target.value)}
                        className="w-full px-4 py-3 glass-input text-primary dark:text-white"
                      >
                        <option value="">Select...</option>
                        {EVENT_TYPES.map(type => (
                          <option key={type} value={type}>{type}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1.5 pl-1">
                        Guest Count
                      </label>
                      <input
                        type="number"
                        value={formData.guest_count}
                        onChange={(e) => handleChange('guest_count', e.target.value)}
                        placeholder="Numbers only (e.g., 50)"
                        min="1"
                        className="w-full px-4 py-3 glass-input text-primary dark:text-white placeholder:text-gray-400"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1.5 pl-1">
                      Additional Details
                    </label>
                    <textarea
                      value={formData.additional_details}
                      onChange={(e) => handleChange('additional_details', e.target.value)}
                      placeholder="Tell us about your theme, dietary needs, or special requests."
                      rows={3}
                      className="w-full px-4 py-3 glass-input text-primary dark:text-white placeholder:text-gray-400 resize-none"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-3 pl-1">
                      Event Services & Requirements
                    </label>
                    <div className="space-y-2">
                      {EVENT_SERVICES.map(service => (
                        <label key={service.id} className="flex items-center gap-3 cursor-pointer group p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                          <input
                            type="checkbox"
                            checked={formData.services.includes(service.id)}
                            onChange={() => toggleService(service.id)}
                            className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
                          />
                          <span className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-primary dark:group-hover:text-white transition-colors">
                            {service.label}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {error && (
                    <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-700 flex items-start gap-2" role="alert">
                      <span className="material-symbols-outlined text-red-600 dark:text-red-400 text-sm mt-0.5" aria-hidden="true">error</span>
                      <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </SlideUpDrawer>
  );
};

export default EventInquiryForm;
