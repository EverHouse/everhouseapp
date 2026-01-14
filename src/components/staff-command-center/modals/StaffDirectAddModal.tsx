import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useData } from '../../../contexts/DataContext';

interface MemberSearchResult {
  email: string;
  name: string;
  tier: string;
}

interface StaffDirectAddModalProps {
  isOpen: boolean;
  onClose: () => void;
  bookingId: number;
  ownerTier: string;
  onSuccess: () => void;
}

interface GuestFieldErrors {
  guestName?: string;
  guestEmail?: string;
  waiveReason?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const StaffDirectAddModal: React.FC<StaffDirectAddModalProps> = ({
  isOpen,
  onClose,
  bookingId,
  ownerTier,
  onSuccess
}) => {
  const { members } = useData();
  const [mode, setMode] = useState<'member' | 'guest'>('member');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMember, setSelectedMember] = useState<MemberSearchResult | null>(null);
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [useGuestPassOption, setUseGuestPassOption] = useState(true);
  const [waiveGuestFee, setWaiveGuestFee] = useState(false);
  const [waiveReason, setWaiveReason] = useState('');
  const [tierOverride, setTierOverride] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<GuestFieldErrors>({});

  const validateGuestName = (value: string): string | undefined => {
    if (!value.trim()) return 'Guest name is required';
    if (value.trim().length > 100) return 'Name must be 100 characters or less';
    return undefined;
  };

  const validateGuestEmail = (value: string): string | undefined => {
    if (!value.trim()) return undefined;
    if (!EMAIL_REGEX.test(value)) return 'Please enter a valid email address';
    if (value.length > 255) return 'Email must be 255 characters or less';
    return undefined;
  };

  const validateWaiveReason = (value: string, isWaiving: boolean): string | undefined => {
    if (isWaiving && !value.trim()) return 'Please provide a reason for waiving the fee';
    return undefined;
  };

  const validateGuestFields = (): GuestFieldErrors => {
    return {
      guestName: validateGuestName(guestName),
      guestEmail: validateGuestEmail(guestEmail),
      waiveReason: validateWaiveReason(waiveReason, waiveGuestFee)
    };
  };

  const hasErrors = (errors: GuestFieldErrors): boolean => {
    return Object.values(errors).some(e => e !== undefined);
  };

  const handleGuestNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setGuestName(value);
    if (fieldErrors.guestName) {
      setFieldErrors(prev => ({ ...prev, guestName: validateGuestName(value) }));
    }
  };

  const handleGuestEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setGuestEmail(value);
    if (fieldErrors.guestEmail) {
      setFieldErrors(prev => ({ ...prev, guestEmail: validateGuestEmail(value) }));
    }
  };

  const handleWaiveReasonChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setWaiveReason(value);
    if (fieldErrors.waiveReason) {
      setFieldErrors(prev => ({ ...prev, waiveReason: validateWaiveReason(value, waiveGuestFee) }));
    }
  };

  const isSocialHost = ownerTier?.toLowerCase() === 'social';

  const filteredMembers = members.filter(m => {
    if (!searchQuery.trim()) return false;
    const query = searchQuery.toLowerCase();
    return (
      m.name?.toLowerCase().includes(query) ||
      m.email?.toLowerCase().includes(query)
    );
  }).slice(0, 8);

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);

    try {
      let body: any = {};

      if (mode === 'member') {
        if (!selectedMember) {
          setError('Please select a member');
          setLoading(false);
          return;
        }
        body = {
          type: 'member',
          memberEmail: selectedMember.email,
          tierOverride: tierOverride || undefined
        };
      } else {
        const errors = validateGuestFields();
        setFieldErrors(errors);
        
        if (hasErrors(errors)) {
          setLoading(false);
          return;
        }
        body = {
          type: 'guest',
          guestName: guestName.trim(),
          guestEmail: guestEmail.trim() || undefined,
          useGuestPass: useGuestPassOption,
          waiveGuestFee: waiveGuestFee,
          waiveReason: waiveGuestFee ? waiveReason : undefined
        };
      }

      const res = await fetch(`/api/bookings/${bookingId}/staff-direct-add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
      });

      if (res.ok) {
        onSuccess();
        onClose();
        resetForm();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to add player');
      }
    } catch (err) {
      setError('Failed to add player');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = useCallback(() => {
    setSearchQuery('');
    setSelectedMember(null);
    setGuestName('');
    setGuestEmail('');
    setUseGuestPassOption(true);
    setWaiveGuestFee(false);
    setWaiveReason('');
    setTierOverride('');
    setError(null);
    setFieldErrors({});
  }, []);

  useEffect(() => {
    if (!isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  if (!isOpen) return null;

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-md bg-white dark:bg-[#1a1d12] rounded-2xl shadow-2xl border border-primary/20 dark:border-white/10 overflow-hidden">
        <div className="px-6 py-4 border-b border-primary/10 dark:border-white/10 bg-primary/5 dark:bg-white/5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-primary dark:text-white flex items-center gap-2">
              <span className="material-symbols-outlined">person_add</span>
              Add Player (Staff)
            </h2>
            <button onClick={onClose} className="p-1 hover:bg-primary/10 dark:hover:bg-white/10 rounded-lg">
              <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {isSocialHost && mode === 'guest' && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-xl">
              <p className="text-sm text-amber-800 dark:text-amber-300 flex items-center gap-2">
                <span className="material-symbols-outlined text-lg">warning</span>
                Social tier hosts cannot add guests
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => setMode('member')}
              className={`flex-1 py-2 px-4 rounded-xl font-medium transition-colors ${
                mode === 'member'
                  ? 'bg-primary text-white'
                  : 'bg-primary/10 dark:bg-white/10 text-primary dark:text-white'
              }`}
            >
              Add Member
            </button>
            <button
              onClick={() => setMode('guest')}
              disabled={isSocialHost}
              className={`flex-1 py-2 px-4 rounded-xl font-medium transition-colors ${
                mode === 'guest'
                  ? 'bg-primary text-white'
                  : 'bg-primary/10 dark:bg-white/10 text-primary dark:text-white'
              } ${isSocialHost ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              Add Guest
            </button>
          </div>

          {mode === 'member' ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  Search Members
                </label>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSelectedMember(null);
                  }}
                  placeholder="Type name or email..."
                  className="w-full px-4 py-2 border border-primary/20 dark:border-white/20 rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white"
                />
              </div>

              {filteredMembers.length > 0 && !selectedMember && (
                <div className="border border-primary/10 dark:border-white/10 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                  {filteredMembers.map(member => (
                    <button
                      key={member.email}
                      onClick={() => {
                        setSelectedMember({
                          email: member.email,
                          name: member.name,
                          tier: member.tier || 'Platinum'
                        });
                        setSearchQuery(member.name);
                      }}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-primary/5 dark:hover:bg-white/5 border-b border-primary/5 dark:border-white/5 last:border-0"
                    >
                      <div className="w-8 h-8 rounded-full bg-primary/10 dark:bg-white/10 flex items-center justify-center">
                        <span className="material-symbols-outlined text-sm text-primary dark:text-white">person</span>
                      </div>
                      <div className="text-left">
                        <p className="font-medium text-primary dark:text-white">{member.name}</p>
                        <p className="text-xs text-primary/60 dark:text-white/60">{member.tier || 'Member'}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {selectedMember && (
                <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700/30 rounded-xl flex items-center gap-3">
                  <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
                  <div>
                    <p className="font-medium text-green-800 dark:text-green-300">{selectedMember.name}</p>
                    <p className="text-xs text-green-600 dark:text-green-400">{selectedMember.tier}</p>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  Tier Override (Optional)
                </label>
                <select
                  value={tierOverride}
                  onChange={(e) => setTierOverride(e.target.value)}
                  className="w-full px-4 py-2 border border-primary/20 dark:border-white/20 rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white"
                >
                  <option value="">Use member's actual tier</option>
                  <option value="Platinum">Platinum</option>
                  <option value="Gold">Gold</option>
                  <option value="Silver">Silver</option>
                  <option value="Social">Social</option>
                </select>
                <p className="text-xs text-primary/50 dark:text-white/50 mt-1">
                  This will be logged for audit purposes
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  Guest Name *
                </label>
                <input
                  type="text"
                  value={guestName}
                  onChange={handleGuestNameChange}
                  placeholder="Enter guest name"
                  className={`w-full px-4 py-2 border rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white ${
                    fieldErrors.guestName ? 'border-red-500' : 'border-primary/20 dark:border-white/20'
                  }`}
                />
                {fieldErrors.guestName && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.guestName}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  Guest Email (Optional)
                </label>
                <input
                  type="email"
                  value={guestEmail}
                  onChange={handleGuestEmailChange}
                  placeholder="guest@email.com"
                  className={`w-full px-4 py-2 border rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white ${
                    fieldErrors.guestEmail ? 'border-red-500' : 'border-primary/20 dark:border-white/20'
                  }`}
                />
                {fieldErrors.guestEmail && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.guestEmail}</p>
                )}
              </div>

              <div className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useGuestPassOption}
                    onChange={(e) => setUseGuestPassOption(e.target.checked)}
                    className="w-5 h-5 rounded border-primary/30 dark:border-white/30 text-primary"
                  />
                  <span className="text-sm text-primary dark:text-white">Use guest pass (if available)</span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={waiveGuestFee}
                    onChange={(e) => {
                      setWaiveGuestFee(e.target.checked);
                      if (!e.target.checked) {
                        setFieldErrors(prev => ({ ...prev, waiveReason: undefined }));
                      }
                    }}
                    className="w-5 h-5 rounded border-primary/30 dark:border-white/30 text-primary"
                  />
                  <span className="text-sm text-primary dark:text-white">Waive guest fee</span>
                </label>

                {waiveGuestFee && (
                  <div>
                    <input
                      type="text"
                      value={waiveReason}
                      onChange={handleWaiveReasonChange}
                      placeholder="Reason for waiving fee (required)..."
                      className={`w-full px-4 py-2 border rounded-xl bg-white dark:bg-black/20 text-primary dark:text-white ${
                        fieldErrors.waiveReason ? 'border-red-500' : 'border-primary/20 dark:border-white/20'
                      }`}
                    />
                    {fieldErrors.waiveReason && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.waiveReason}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 rounded-xl">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-primary/10 dark:border-white/10 bg-primary/5 dark:bg-white/5">
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2 px-4 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl font-medium hover:bg-gray-300 dark:hover:bg-gray-600"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading || (mode === 'guest' && isSocialHost) || (mode === 'guest' && waiveGuestFee && !waiveReason.trim())}
              className="flex-1 py-2 px-4 bg-primary text-white rounded-xl font-medium hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                  Adding...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-lg">person_add</span>
                  Add Player
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default StaffDirectAddModal;
