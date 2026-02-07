import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import { triggerHaptic } from '../../utils/haptics';
import { usePageReady } from '../../contexts/PageReadyContext';
import WalkingGolferSpinner from '../../components/WalkingGolferSpinner';

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

const MembershipApply: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  
  const [formData, setFormData] = useState({
    firstname: '',
    lastname: '',
    email: '',
    phone: '',
    consent: false,
    membership_tier: '',
    message: ''
  });

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  const handleChange = (name: string, value: string | boolean) => {
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const validateStep1 = () => {
    const errors: Record<string, string> = {};
    if (!formData.firstname.trim()) errors.firstname = 'First name is required';
    if (!formData.lastname.trim()) errors.lastname = 'Last name is required';
    if (!formData.email.trim()) errors.email = 'Email is required';
    if (!formData.phone.trim()) errors.phone = 'Phone number is required';
    if (!formData.consent) errors.consent = 'You must agree to receive communications';
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

    try {
      const fields = [
        { name: 'firstname', value: formData.firstname },
        { name: 'lastname', value: formData.lastname },
        { name: 'email', value: formData.email },
        { name: 'phone', value: formData.phone },
        { name: 'membership_tier', value: formData.membership_tier },
        { name: 'message', value: formData.message },
        { name: 'marketing_consent', value: formData.consent ? 'Yes' : 'No' }
      ];

      const hutk = getHubspotCookie();
      const context: Record<string, any> = {
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
      setSuccess(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      triggerHaptic('error');
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const getInputClass = (fieldName: string) => `w-full px-4 py-3 rounded-xl border transition-colors focus:outline-none focus:ring-2 ${
    fieldErrors[fieldName] 
      ? 'border-red-500 focus:ring-red-500 bg-red-50' 
      : 'border-primary/20 bg-white focus:ring-primary focus:border-primary'
  } text-primary placeholder:text-gray-400`;

  return (
    <div className="min-h-screen pb-0 overflow-x-hidden relative bg-[#F2F2EC]">
      <div 
        className="fixed top-0 left-0 right-0 bg-[#293515]"
        style={{ height: 'env(safe-area-inset-top, 0px)', zIndex: 'var(--z-header)' }}
        aria-hidden="true"
      />

      <div className="pt-[max(1rem,env(safe-area-inset-top))] px-4 pb-4">
        <Link 
          to="/membership" 
          className="inline-flex items-center gap-1 text-primary/70 hover:text-primary transition-colors py-2"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          <span className="text-sm font-medium">Back to Membership</span>
        </Link>
      </div>

      <div className="px-4 pb-12">
        <div className="max-w-xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-3xl md:text-4xl font-serif font-light text-primary mb-3">
              Apply for Membership
            </h1>
            <p className="text-primary/60 text-sm md:text-base">
              Join the Ever Club community and discover a new way to connect, play, and unwind.
            </p>
          </div>

          {success ? (
            <div className="bg-white/60 backdrop-blur-xl rounded-[2rem] border border-white/80 shadow-[0_8px_32px_rgba(0,0,0,0.08)] p-8 text-center">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <span className="material-symbols-outlined text-4xl text-green-600">check_circle</span>
              </div>
              <h2 className="text-2xl font-bold text-primary mb-3">Thank You!</h2>
              <p className="text-primary/70 mb-8 max-w-sm mx-auto">
                We've received your membership application and will be in touch soon to discuss next steps.
              </p>
              <Link 
                to="/membership"
                className="inline-block px-8 py-4 bg-primary text-white rounded-[2rem] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all"
              >
                Back to Membership
              </Link>
            </div>
          ) : (
            <div className="bg-white/60 backdrop-blur-xl rounded-[2rem] border border-white/80 shadow-[0_8px_32px_rgba(0,0,0,0.08)] overflow-hidden">
              <div className="flex items-center justify-center gap-3 py-6 border-b border-primary/10">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all ${step === 1 ? 'bg-primary text-white' : 'bg-primary/10 text-primary'}`}>1</div>
                <div className="w-16 h-0.5 bg-primary/20" />
                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all ${step === 2 ? 'bg-primary text-white' : 'bg-primary/10 text-primary'}`}>2</div>
              </div>

              <form onSubmit={handleSubmit} className="p-6 md:p-8">
                {step === 1 ? (
                  <div className="space-y-5">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-semibold text-primary mb-2">
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
                          className={getInputClass('firstname')}
                        />
                        {fieldErrors.firstname && (
                          <p className="text-sm text-red-500 mt-1 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">error</span>
                            {fieldErrors.firstname}
                          </p>
                        )}
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-primary mb-2">
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
                          className={getInputClass('lastname')}
                        />
                        {fieldErrors.lastname && (
                          <p className="text-sm text-red-500 mt-1 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">error</span>
                            {fieldErrors.lastname}
                          </p>
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-primary mb-2">
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
                      <label className="block text-sm font-semibold text-primary mb-2">
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
                        className={getInputClass('phone')}
                      />
                      {fieldErrors.phone && (
                        <p className="text-sm text-red-500 mt-1 flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">error</span>
                          {fieldErrors.phone}
                        </p>
                      )}
                    </div>

                    <div className="pt-4 border-t border-primary/10">
                      <p className="text-xs text-primary/60 mb-4 leading-relaxed">
                        Even House is committed to protecting and respecting your privacy. We use your information to administer your account and to provide the products, services, and updates you request from us. We also contact you with information about membership, events, promotions, operational updates, and other content that may be relevant to you. If you consent to receiving communications from us, please indicate your preferences below.
                      </p>
                      <label className={`flex items-start gap-3 cursor-pointer group p-3 rounded-xl transition-colors ${fieldErrors.consent ? 'bg-red-50 border border-red-200' : 'hover:bg-primary/5'}`}>
                        <input
                          type="checkbox"
                          checked={formData.consent}
                          onChange={(e) => {
                            handleChange('consent', e.target.checked);
                            if (fieldErrors.consent) setFieldErrors(prev => ({ ...prev, consent: '' }));
                          }}
                          className="mt-0.5 w-5 h-5 rounded border-primary/30 text-primary focus:ring-primary"
                        />
                        <span className="text-sm text-primary leading-relaxed">
                          I agree to receive communications from Even House regarding membership, account updates, events, and promotions. <span className="text-red-500">*</span>
                        </span>
                      </label>
                      {fieldErrors.consent && (
                        <p className="text-sm text-red-500 mt-2 flex items-center gap-1 pl-1">
                          <span className="material-symbols-outlined text-sm">error</span>
                          {fieldErrors.consent}
                        </p>
                      )}
                      <p className="text-xs text-primary/60 mt-4 leading-relaxed">
                        You can unsubscribe from Even House communications at any time. For more information about how to unsubscribe, our privacy practices, and how we protect and respect your personal information, please review our Privacy Policy.
                      </p>
                      <p className="text-xs text-primary/60 mt-3 leading-relaxed">
                        By submitting this form, you authorize Even House to store and process your personal information to provide the content, services, and membership evaluation you have requested.
                      </p>
                    </div>

                    {error && (
                      <div className="p-4 rounded-xl bg-red-50 border border-red-100 flex items-start gap-2">
                        <span className="material-symbols-outlined text-red-600 text-lg mt-0.5">error</span>
                        <span className="text-sm text-red-600">{error}</span>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={handleNext}
                      className="w-full py-4 bg-primary text-white rounded-[2rem] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all"
                    >
                      Next
                    </button>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <h3 className="text-xl font-bold text-primary font-serif">Tell Us More</h3>

                    <div>
                      <label className="block text-sm font-semibold text-primary mb-2">
                        Which tier are you interested in?
                      </label>
                      <select
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
                      <label className="block text-sm font-semibold text-primary mb-2">
                        Tell us about yourself
                      </label>
                      <textarea
                        value={formData.message}
                        onChange={(e) => handleChange('message', e.target.value)}
                        placeholder="Tell us about yourself and your interests..."
                        rows={5}
                        className={`${getInputClass('message')} resize-none`}
                      />
                    </div>

                    {error && (
                      <div className="p-4 rounded-xl bg-red-50 border border-red-100 flex items-start gap-2">
                        <span className="material-symbols-outlined text-red-600 text-lg mt-0.5">error</span>
                        <span className="text-sm text-red-600">{error}</span>
                      </div>
                    )}

                    <div className="flex gap-3 pt-2">
                      <button
                        type="button"
                        onClick={handleBack}
                        className="flex-1 py-4 bg-primary/10 text-primary rounded-[2rem] font-semibold hover:bg-primary/20 transition-all"
                      >
                        Previous
                      </button>
                      <button
                        type="submit"
                        disabled={loading}
                        className="flex-1 py-4 bg-primary text-white rounded-[2rem] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
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

export default MembershipApply;
