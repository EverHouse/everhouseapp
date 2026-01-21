import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../Toast';

interface DiscountReason {
  tag: string;
  percent: number;
  description: string;
}

interface AddMemberOptions {
  tiers: string[];
  discountReasons: DiscountReason[];
}

interface AddMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

interface FieldErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  tier?: string;
}

interface CreatedMemberInfo {
  email: string;
  name: string;
  tier: string;
}

type ModalStep = 'form' | 'success' | 'next-steps';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[\d\s\-\+\(\)\.]+$/;

export const AddMemberModal: React.FC<AddMemberModalProps> = ({
  isOpen,
  onClose,
  onSuccess
}) => {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState<ModalStep>('form');
  const [createdMember, setCreatedMember] = useState<CreatedMemberInfo | null>(null);
  const [options, setOptions] = useState<AddMemberOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [tier, setTier] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [startDate, setStartDate] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  
  const [sendingPaymentLink, setSendingPaymentLink] = useState(false);
  const [paymentLinkUrl, setPaymentLinkUrl] = useState<string | null>(null);
  const [paymentLinkSent, setPaymentLinkSent] = useState(false);

  const validateFirstName = (value: string): string | undefined => {
    if (!value.trim()) return 'First name is required';
    if (value.trim().length > 50) return 'First name must be 50 characters or less';
    return undefined;
  };

  const validateLastName = (value: string): string | undefined => {
    if (!value.trim()) return 'Last name is required';
    if (value.trim().length > 50) return 'Last name must be 50 characters or less';
    return undefined;
  };

  const validateEmail = (value: string): string | undefined => {
    if (!value.trim()) return 'Email is required';
    if (!EMAIL_REGEX.test(value)) return 'Please enter a valid email address';
    if (value.length > 255) return 'Email must be 255 characters or less';
    return undefined;
  };

  const validatePhone = (value: string): string | undefined => {
    if (!value.trim()) return undefined;
    if (!PHONE_REGEX.test(value)) return 'Please enter a valid phone number';
    const digitsOnly = value.replace(/\D/g, '');
    if (digitsOnly.length < 10) return 'Phone number must have at least 10 digits';
    if (digitsOnly.length > 15) return 'Phone number is too long';
    return undefined;
  };

  const validateTier = (value: string): string | undefined => {
    if (!value) return 'Please select a tier';
    return undefined;
  };

  const validateAllFields = (): FieldErrors => {
    return {
      firstName: validateFirstName(firstName),
      lastName: validateLastName(lastName),
      email: validateEmail(email),
      phone: validatePhone(phone),
      tier: validateTier(tier)
    };
  };

  const hasErrors = (errors: FieldErrors): boolean => {
    return Object.values(errors).some(e => e !== undefined);
  };

  const fetchOptions = useCallback(async () => {
    setOptionsLoading(true);
    setOptionsError(null);
    try {
      const res = await fetch('/api/members/add-options', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setOptions(data);
        if (data.tiers?.length > 0 && !tier) {
          setTier(data.tiers[0]);
        }
      } else {
        setOptionsError('Failed to load form options');
      }
    } catch (err) {
      setOptionsError('Failed to load form options');
    } finally {
      setOptionsLoading(false);
    }
  }, [tier]);

  useEffect(() => {
    if (isOpen) {
      fetchOptions();
      const today = new Date().toISOString().split('T')[0];
      setStartDate(today);
    }
  }, [isOpen, fetchOptions]);

  const resetForm = useCallback(() => {
    setFirstName('');
    setLastName('');
    setEmail('');
    setPhone('');
    setTier('');
    setDiscountReason('');
    setStartDate('');
    setError(null);
    setFieldErrors({});
    setStep('form');
    setCreatedMember(null);
    setSendingPaymentLink(false);
    setPaymentLinkUrl(null);
    setPaymentLinkSent(false);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  const handleFirstNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setFirstName(value);
    if (fieldErrors.firstName) {
      setFieldErrors(prev => ({ ...prev, firstName: validateFirstName(value) }));
    }
  };

  const handleLastNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setLastName(value);
    if (fieldErrors.lastName) {
      setFieldErrors(prev => ({ ...prev, lastName: validateLastName(value) }));
    }
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setEmail(value);
    if (fieldErrors.email) {
      setFieldErrors(prev => ({ ...prev, email: validateEmail(value) }));
    }
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setPhone(value);
    if (fieldErrors.phone) {
      setFieldErrors(prev => ({ ...prev, phone: validatePhone(value) }));
    }
  };

  const handleTierChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setTier(value);
    if (fieldErrors.tier) {
      setFieldErrors(prev => ({ ...prev, tier: validateTier(value) }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const errors = validateAllFields();
    setFieldErrors(errors);
    
    if (hasErrors(errors)) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim() || undefined,
          tier,
          discountReason: discountReason || undefined,
          startDate: startDate || undefined
        })
      });

      if (res.ok) {
        setCreatedMember({
          email: email.trim().toLowerCase(),
          name: `${firstName.trim()} ${lastName.trim()}`,
          tier
        });
        setStep('next-steps');
        onSuccess?.();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create member');
      }
    } catch (err) {
      setError('Failed to create member');
    } finally {
      setLoading(false);
    }
  };

  const handleSendPaymentLink = async () => {
    if (!createdMember) return;
    
    setSendingPaymentLink(true);
    try {
      const res = await fetch(`/api/members/${encodeURIComponent(createdMember.email)}/send-payment-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });

      if (res.ok) {
        const data = await res.json();
        setPaymentLinkUrl(data.paymentLink || data.url || null);
        setPaymentLinkSent(true);
        showToast(`Payment link sent to ${createdMember.email}`, 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to send payment link', 'error');
      }
    } catch (err) {
      showToast('Failed to send payment link', 'error');
    } finally {
      setSendingPaymentLink(false);
    }
  };

  const handleCopyPaymentLink = () => {
    if (paymentLinkUrl) {
      navigator.clipboard.writeText(paymentLinkUrl).then(() => {
        showToast('Payment link copied to clipboard', 'success');
      }).catch(() => {
        showToast('Failed to copy link', 'error');
      });
    }
  };

  const handleDone = () => {
    onClose();
    resetForm();
  };

  const handleChargeManually = () => {
    if (!createdMember) return;
    navigator.clipboard.writeText(createdMember.email).then(() => {
      showToast(`Email copied: ${createdMember.email}`, 'success');
    }).catch(() => {
      showToast(`Member email: ${createdMember.email}`, 'info');
    });
    onClose();
    navigate('/admin?tab=financials');
  };

  const handleSkip = () => {
    showToast(`Member ${createdMember?.name} created successfully`, 'success');
    onClose();
  };

  if (!isOpen) return null;

  const renderNextSteps = () => (
    <div className="p-6 space-y-6">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 mb-4">
          <span className="material-symbols-outlined text-3xl text-green-600 dark:text-green-400">check_circle</span>
        </div>
        <h3 className="text-xl font-bold text-primary dark:text-white mb-2">
          {paymentLinkSent ? 'Payment link sent!' : 'Member created successfully!'}
        </h3>
        <div className="text-sm text-primary/70 dark:text-white/70">
          <p className="font-medium">{createdMember?.name}</p>
          <p>{createdMember?.email}</p>
          <p className="mt-1 text-primary/50 dark:text-white/50">{createdMember?.tier}</p>
        </div>
      </div>

      {paymentLinkSent ? (
        <div className="space-y-4">
          <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700/30 rounded-xl">
            <div className="flex items-start gap-3 mb-3">
              <span className="material-symbols-outlined text-green-600 dark:text-green-400">mail</span>
              <p className="text-sm text-green-700 dark:text-green-300">
                Email sent to {createdMember?.email}
              </p>
            </div>
            {paymentLinkUrl && (
              <div className="mt-3">
                <label className="block text-xs font-medium text-primary/60 dark:text-white/60 mb-1">
                  Payment Link (for manual sharing)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={paymentLinkUrl}
                    className="flex-1 px-3 py-2 text-xs border border-primary/20 dark:border-white/20 rounded-lg bg-white dark:bg-black/20 text-primary dark:text-white truncate"
                  />
                  <button
                    onClick={handleCopyPaymentLink}
                    className="px-3 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 flex items-center gap-1 text-sm"
                  >
                    <span className="material-symbols-outlined text-lg">content_copy</span>
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={handleDone}
            className="w-full py-3 px-4 bg-primary text-white rounded-xl font-medium hover:bg-primary/90"
          >
            Done
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            <button
              onClick={handleSendPaymentLink}
              disabled={sendingPaymentLink}
              className="w-full p-4 bg-white dark:bg-white/5 border border-primary/20 dark:border-white/20 rounded-xl hover:bg-primary/5 dark:hover:bg-white/10 transition-colors text-left group"
            >
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                  <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">link</span>
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-semibold text-primary dark:text-white group-hover:text-primary/80 dark:group-hover:text-white/80">
                    Send Payment Link
                  </h4>
                  <p className="text-sm text-primary/60 dark:text-white/60 mt-0.5">
                    Send member a payment link to set up their subscription
                  </p>
                </div>
                {sendingPaymentLink ? (
                  <div className="flex-shrink-0">
                    <span className="animate-spin rounded-full h-5 w-5 border-2 border-primary dark:border-white border-t-transparent inline-block" />
                  </div>
                ) : (
                  <span className="material-symbols-outlined text-primary/40 dark:text-white/40 group-hover:text-primary/60 dark:group-hover:text-white/60 flex-shrink-0">
                    chevron_right
                  </span>
                )}
              </div>
            </button>

            <button
              onClick={handleChargeManually}
              className="w-full p-4 bg-white dark:bg-white/5 border border-primary/20 dark:border-white/20 rounded-xl hover:bg-primary/5 dark:hover:bg-white/10 transition-colors text-left group"
            >
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                  <span className="material-symbols-outlined text-purple-600 dark:text-purple-400">point_of_sale</span>
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-semibold text-primary dark:text-white group-hover:text-primary/80 dark:group-hover:text-white/80">
                    Charge via Financials Tab
                  </h4>
                  <p className="text-sm text-primary/60 dark:text-white/60 mt-0.5">
                    Copy email and go to Quick Charge
                  </p>
                </div>
                <span className="material-symbols-outlined text-primary/40 dark:text-white/40 group-hover:text-primary/60 dark:group-hover:text-white/60 flex-shrink-0">
                  arrow_forward
                </span>
              </div>
            </button>
          </div>

          <div className="text-center pt-2">
            <button
              onClick={handleSkip}
              className="text-sm text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white underline underline-offset-2"
            >
              Skip for Now
            </button>
          </div>
        </>
      )}
    </div>
  );

  const renderForm = () => (
    <form onSubmit={handleSubmit}>
      <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
        {optionsLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
          </div>
        ) : optionsError ? (
          <div className="text-center py-8">
            <span className="material-symbols-outlined text-4xl text-red-500 mb-2">error</span>
            <p className="text-red-600 dark:text-red-400">{optionsError}</p>
            <button type="button" onClick={fetchOptions} className="mt-4 px-4 py-2 bg-primary text-white rounded-lg">
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  First Name *
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={handleFirstNameChange}
                  placeholder="John"
                  className={`w-full px-4 py-2 border rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 ${
                    fieldErrors.firstName ? 'border-red-500' : 'border-primary/20 dark:border-white/20'
                  }`}
                />
                {fieldErrors.firstName && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.firstName}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  Last Name *
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={handleLastNameChange}
                  placeholder="Smith"
                  className={`w-full px-4 py-2 border rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 ${
                    fieldErrors.lastName ? 'border-red-500' : 'border-primary/20 dark:border-white/20'
                  }`}
                />
                {fieldErrors.lastName && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.lastName}</p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                Email *
              </label>
              <input
                type="email"
                value={email}
                onChange={handleEmailChange}
                placeholder="john@example.com"
                className={`w-full px-4 py-2 border rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 ${
                  fieldErrors.email ? 'border-red-500' : 'border-primary/20 dark:border-white/20'
                }`}
              />
              {fieldErrors.email && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.email}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                Phone <span className="text-primary/50 dark:text-white/50">(optional)</span>
              </label>
              <input
                type="tel"
                value={phone}
                onChange={handlePhoneChange}
                placeholder="+1 (555) 123-4567"
                className={`w-full px-4 py-2 border rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 ${
                  fieldErrors.phone ? 'border-red-500' : 'border-primary/20 dark:border-white/20'
                }`}
              />
              {fieldErrors.phone && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.phone}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                Membership Tier *
              </label>
              <select
                value={tier}
                onChange={handleTierChange}
                className={`w-full px-4 py-2 border rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white ${
                  fieldErrors.tier ? 'border-red-500' : 'border-primary/20 dark:border-white/20'
                }`}
              >
                <option value="">Select a tier...</option>
                {options?.tiers.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {fieldErrors.tier && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.tier}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                Discount Reason <span className="text-primary/50 dark:text-white/50">(optional)</span>
              </label>
              <select
                value={discountReason}
                onChange={(e) => setDiscountReason(e.target.value)}
                className="w-full px-4 py-2 border border-primary/20 dark:border-white/20 rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white"
              >
                <option value="">No discount</option>
                {options?.discountReasons.map(dr => (
                  <option key={dr.tag} value={dr.tag}>
                    {dr.tag} ({dr.percent}% off)
                  </option>
                ))}
              </select>
              {discountReason && options?.discountReasons.find(dr => dr.tag === discountReason)?.description && (
                <p className="text-xs text-primary/60 dark:text-white/60 mt-1">
                  {options.discountReasons.find(dr => dr.tag === discountReason)?.description}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                Start Date <span className="text-primary/50 dark:text-white/50">(defaults to today)</span>
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-4 py-2 border border-primary/20 dark:border-white/20 rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 rounded-xl">
                <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg">error</span>
                  {error}
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-6 py-4 border-t border-primary/10 dark:border-white/10 bg-primary/5 dark:bg-white/5">
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 px-4 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl font-medium hover:bg-gray-300 dark:hover:bg-gray-600"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || optionsLoading || !!optionsError}
            className="flex-1 py-2 px-4 bg-primary text-white rounded-xl font-medium hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                Creating...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-lg">person_add</span>
                Create Member
              </>
            )}
          </button>
        </div>
      </div>
    </form>
  );

  const modalContent = (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
        <div className="w-full max-w-md bg-white dark:bg-[#1a1d12] rounded-2xl shadow-2xl border border-primary/20 dark:border-white/10 overflow-hidden">
          <div className="px-6 py-4 border-b border-primary/10 dark:border-white/10 bg-primary/5 dark:bg-white/5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-primary dark:text-white flex items-center gap-2">
                <span className="material-symbols-outlined">
                  {step === 'next-steps' ? 'check_circle' : 'person_add'}
                </span>
                {step === 'next-steps' ? 'Next Steps' : 'Add New Member'}
              </h2>
              <button onClick={onClose} className="p-1 hover:bg-primary/10 dark:hover:bg-white/10 rounded-lg">
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
              </button>
            </div>
          </div>

          {step === 'form' ? renderForm() : renderNextSteps()}
        </div>
      </div>
    </>
  );

  return createPortal(modalContent, document.body);
};

export default AddMemberModal;
