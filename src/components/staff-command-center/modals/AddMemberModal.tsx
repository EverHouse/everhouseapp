import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
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

export const AddMemberModal: React.FC<AddMemberModalProps> = ({
  isOpen,
  onClose,
  onSuccess
}) => {
  const { showToast } = useToast();
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
  }, []);

  useEffect(() => {
    if (!isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!firstName.trim()) {
      setError('First name is required');
      return;
    }
    if (!lastName.trim()) {
      setError('Last name is required');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      setError('Valid email is required');
      return;
    }
    if (!tier) {
      setError('Please select a tier');
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
        const data = await res.json();
        showToast(data.message || `Successfully created member ${firstName} ${lastName}`, 'success');
        onSuccess?.();
        onClose();
        resetForm();
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

  if (!isOpen) return null;

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-md bg-white dark:bg-[#1a1d12] rounded-2xl shadow-2xl border border-primary/20 dark:border-white/10 overflow-hidden">
        <div className="px-6 py-4 border-b border-primary/10 dark:border-white/10 bg-primary/5 dark:bg-white/5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-primary dark:text-white flex items-center gap-2">
              <span className="material-symbols-outlined">person_add</span>
              Add New Member
            </h2>
            <button onClick={onClose} className="p-1 hover:bg-primary/10 dark:hover:bg-white/10 rounded-lg">
              <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
            </button>
          </div>
        </div>

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
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder="John"
                      className="w-full px-4 py-2 border border-primary/20 dark:border-white/20 rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                      Last Name *
                    </label>
                    <input
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      placeholder="Smith"
                      className="w-full px-4 py-2 border border-primary/20 dark:border-white/20 rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                    Email *
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="john@example.com"
                    className="w-full px-4 py-2 border border-primary/20 dark:border-white/20 rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                    Phone <span className="text-primary/50 dark:text-white/50">(optional)</span>
                  </label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1 (555) 123-4567"
                    className="w-full px-4 py-2 border border-primary/20 dark:border-white/20 rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                    Membership Tier *
                  </label>
                  <select
                    value={tier}
                    onChange={(e) => setTier(e.target.value)}
                    className="w-full px-4 py-2 border border-primary/20 dark:border-white/20 rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white"
                  >
                    <option value="">Select a tier...</option>
                    {options?.tiers.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
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
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default AddMemberModal;
