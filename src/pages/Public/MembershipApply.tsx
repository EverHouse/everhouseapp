import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import { triggerHaptic } from '../../utils/haptics';
import { formatPhoneNumber } from '../../utils/phoneFormat';
import { usePageReady } from '../../contexts/PageReadyContext';
import WalkingGolferSpinner from '../../components/WalkingGolferSpinner';
import SEO from '../../components/SEO';
import ConfirmDialogComponent from '../../components/ConfirmDialog';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { useFormPersistence } from '../../hooks/useFormPersistence';

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

const TIER_OPTIONS = [
  'Social',
  'Core',
  'Premium',
  'Corporate',
  'Not sure yet'
];

const INITIAL_FORM_DATA = {
  firstname: '',
  lastname: '',
  email: '',
  phone: '',
  consent: false,
  membership_tier: '',
  message: ''
};

const MembershipApply: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [persistedData, setPersistData, clearPersistedData] = useFormPersistence('membership-apply', INITIAL_FORM_DATA);
  
  const [formData, setFormData] = useState(persistedData);
  const initialDataRef = useRef(persistedData);

  const isDirty = useMemo(() => {
    if (success) return false;
    const initial = initialDataRef.current;
    return (
      formData.firstname !== initial.firstname ||
      formData.lastname !== initial.lastname ||
      formData.email !== initial.email ||
      formData.phone !== initial.phone ||
      formData.membership_tier !== initial.membership_tier ||
      formData.message !== initial.message ||
      formData.consent !== initial.consent
    );
  }, [formData, success]);

  const { showDialog, dialogTitle, dialogMessage, confirmDiscard, cancelDiscard } = useUnsavedChanges({
    isDirty,
    message: 'You have unsaved changes. Discard changes?'
  });

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  const handleChange = (name: string, value: string | boolean) => {
    setFormData(prev => {
      const updated = { ...prev, [name]: value };
      setPersistData(updated);
      return updated;
    });
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

    if (!formData.consent) {
      setFieldErrors({ consent: 'You must agree to receive communications' });
      setError('Please agree to receive communications');
      setLoading(false);
      return;
    }

    triggerHaptic('medium');

    try {
      const fields = [
        { name: 'firstname', value: formData.firstname },
        { name: 'lastname', value: formData.lastname },
        { name: 'email', value: formData.email },
        { name: 'phone', value: formData.phone },
        { name: 'membership_interest', value: formData.membership_tier },
        { name: 'message', value: formData.message },
        { name: 'marketing_consent', value: formData.consent ? 'Yes' : 'No' }
      ];

      const hutk = getHubspotCookie();
      const context: Record<string, unknown> = {
        pageUri: window.location.href,
        pageName: 'Membership Application'
      };
      if (hutk) {
        context.hutk = hutk;
      }

      const response = await fetch('/api/hubspot/forms/membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, context })
      });

      if (!response.ok) {
        throw new Error('Submission failed');
      }

      triggerHaptic('success');
      clearPersistedData();
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
      <SEO title="Apply for Membership | Ever Club — OC Golf Club" description="Join OC's premier indoor golf & social club. Apply for membership at Ever Club in Tustin — Trackman simulators, workspace, wellness & community." url="/membership/apply" />
      <div className="pt-4 px-4 pb-4">
        <Link 
          to="/membership" 
          className="inline-flex items-center gap-1 text-primary/70 dark:text-white/70 hover:text-primary dark:hover:text-white transition-colors py-2"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          <span className="text-sm font-medium">Back to Membership</span>
        </Link>
      </div>

      <div className="px-4 pb-12">
        <div className="max-w-xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-3xl sm:text-4xl md:text-5xl text-primary dark:text-white mb-3 leading-none" style={{ fontFamily: 'var(--font-display)' }}>
              Apply for Membership
            </h1>
            <p className="text-primary/60 dark:text-white/60 text-sm md:text-base">
              Tell us a little about yourself. We'll reach out within 24 hours to schedule your private tour.
            </p>
          </div>

          {success ? (
            <div className="bg-white/60 dark:bg-white/5 backdrop-blur-xl rounded-xl border border-white/80 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-8 text-center">
              <div className="w-20 h-20 bg-green-100 dark:bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <span className="material-symbols-outlined text-4xl text-green-600 dark:text-green-400">check_circle</span>
              </div>
              <h2 className="text-2xl text-primary dark:text-white mb-3 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Thank You!</h2>
              <p className="text-primary/70 dark:text-white/70 mb-4 max-w-sm mx-auto">
                We've received your membership application. Our team will reach out within 24 hours to schedule your private tour.
              </p>
              <p className="text-primary/50 dark:text-white/50 text-sm mb-8 max-w-sm mx-auto">
                In the meantime, <Link to="/membership" className="underline hover:text-primary dark:hover:text-white transition-colors">explore our membership tiers</Link>.
              </p>
              <Link 
                to="/membership"
                className="inline-block px-8 py-4 bg-primary text-white rounded-[4px] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all duration-fast"
              >
                Back to Membership
              </Link>
            </div>
          ) : (
            <div className="bg-white/60 dark:bg-white/5 backdrop-blur-xl rounded-xl border border-white/80 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)] overflow-hidden">
              <div className="flex items-center justify-center gap-3 py-6 border-b border-primary/10 dark:border-white/10">
                <div className="flex flex-col items-center gap-1">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-fast ${step === 1 ? 'bg-primary text-white' : 'bg-primary/10 dark:bg-white/10 text-primary dark:text-white'}`}>1</div>
                  <span className={`text-[10px] font-medium ${step === 1 ? 'text-primary dark:text-white' : 'text-primary/40 dark:text-white/40'}`}>Your Info</span>
                </div>
                <div className="w-16 h-0.5 bg-primary/20 dark:bg-white/20 mb-5" />
                <div className="flex flex-col items-center gap-1">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-fast ${step === 2 ? 'bg-primary text-white' : 'bg-primary/10 dark:bg-white/10 text-primary dark:text-white'}`}>2</div>
                  <span className={`text-[10px] font-medium ${step === 2 ? 'text-primary dark:text-white' : 'text-primary/40 dark:text-white/40'}`}>Preferences</span>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="p-6 md:p-8">
                {step === 1 ? (
                  <div className="space-y-5">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="apply-firstname" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                          First Name <span className="text-red-500 dark:text-red-400">*</span>
                        </label>
                        <input
                          id="apply-firstname"
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
                        <label htmlFor="apply-lastname" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                          Last Name <span className="text-red-500 dark:text-red-400">*</span>
                        </label>
                        <input
                          id="apply-lastname"
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
                      <label htmlFor="apply-email" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                        Email <span className="text-red-500 dark:text-red-400">*</span>
                      </label>
                      <input
                        id="apply-email"
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
                      <label htmlFor="apply-phone" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                        Phone Number <span className="text-red-500 dark:text-red-400">*</span>
                      </label>
                      <input
                        id="apply-phone"
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
                      Continue to Preferences
                    </button>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <h3 className="text-2xl text-primary dark:text-white leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Almost There</h3>

                    <div>
                      <label htmlFor="apply-tier" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                        Which tier are you interested in?
                      </label>
                      <select
                        id="apply-tier"
                        value={formData.membership_tier}
                        onChange={(e) => handleChange('membership_tier', e.target.value)}
                        className={getInputClass('membership_tier')}
                      >
                        <option value="">Select...</option>
                        {TIER_OPTIONS.map(tier => (
                          <option key={tier} value={tier}>{tier}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label htmlFor="apply-message" className="block text-sm font-semibold text-primary dark:text-white mb-2">
                        What brings you to Ever Members Club?
                      </label>
                      <textarea
                        id="apply-message"
                        value={formData.message}
                        onChange={(e) => handleChange('message', e.target.value)}
                        placeholder="Golf, coworking, wellness, events — we'd love to know what interests you most."
                        rows={5}
                        className={`${getInputClass('message')} resize-none`}
                      />
                    </div>

                    <div className="pt-4 border-t border-primary/10 dark:border-white/10">
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
                          I agree to receive communications from Ever Members Club. <span className="text-red-500 dark:text-red-400">*</span>
                          <Link to="/privacy" className="underline text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white ml-1">Privacy Policy</Link>
                        </span>
                      </label>
                      {fieldErrors.consent && (
                        <p className="text-sm text-red-500 dark:text-red-400 mt-2 flex items-center gap-1 pl-1">
                          <span className="material-symbols-outlined text-sm">error</span>
                          {fieldErrors.consent}
                        </p>
                      )}
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
                          'Submit Application'
                        )}
                      </button>
                    </div>
                    <p className="text-xs text-primary/40 dark:text-white/40 text-center mt-3 font-light">Your information is kept private and never shared.</p>
                  </div>
                )}
              </form>
            </div>
          )}
        </div>
      </div>

      <Footer />

      <ConfirmDialogComponent
        isOpen={showDialog}
        title={dialogTitle}
        message={dialogMessage}
        confirmText="Discard"
        cancelText="Keep Editing"
        variant="warning"
        onConfirm={confirmDiscard}
        onCancel={cancelDiscard}
      />
    </div>
  );
};

export default MembershipApply;
