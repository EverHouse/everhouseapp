import { useState } from 'react';
import { useTheme } from '../../contexts/ThemeContext';

interface GuardianConsentFormProps {
  onSubmit: (data: GuardianConsentData) => void;
  onCancel: () => void;
  memberName: string;
}

export interface GuardianConsentData {
  guardianName: string;
  guardianRelationship: string;
  guardianPhone: string;
  acknowledged: boolean;
}

const RELATIONSHIP_OPTIONS = [
  'Parent',
  'Legal Guardian',
  'Mother',
  'Father',
  'Stepmother',
  'Stepfather',
  'Grandparent',
  'Other Legal Guardian'
];

export function GuardianConsentForm({ onSubmit, onCancel, memberName }: GuardianConsentFormProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  const [guardianName, setGuardianName] = useState('');
  const [guardianRelationship, setGuardianRelationship] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!guardianName.trim()) {
      newErrors.guardianName = 'Guardian name is required';
    }

    if (!guardianRelationship) {
      newErrors.guardianRelationship = 'Please select relationship';
    }

    if (!guardianPhone.trim()) {
      newErrors.guardianPhone = 'Phone number is required';
    } else if (!/^[\d\s\-\+\(\)]{10,}$/.test(guardianPhone.replace(/\s/g, ''))) {
      newErrors.guardianPhone = 'Please enter a valid phone number';
    }

    if (!acknowledged) {
      newErrors.acknowledged = 'You must acknowledge the consent statement';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validateForm()) {
      onSubmit({
        guardianName: guardianName.trim(),
        guardianRelationship,
        guardianPhone: guardianPhone.trim(),
        acknowledged
      });
    }
  };

  const getInputClass = (hasError: boolean) => `w-full px-4 py-3 rounded-xl border transition-colors focus:outline-none focus:ring-2 ${
    hasError 
      ? 'border-red-500 focus:ring-red-500' 
      : `focus:ring-accent ${isDark ? 'border-white/20' : 'border-black/10'}`
  } ${isDark ? 'bg-black/20 text-white placeholder:text-white/40' : 'bg-white text-primary placeholder:text-primary/40'}`;

  const getSelectClass = (hasError: boolean) => `w-full px-4 py-3 rounded-xl border transition-colors focus:outline-none focus:ring-2 appearance-none cursor-pointer ${
    hasError 
      ? 'border-red-500 focus:ring-red-500' 
      : `focus:ring-accent ${isDark ? 'border-white/20' : 'border-black/10'}`
  } ${isDark ? 'bg-black/20 text-white' : 'bg-white text-primary'}`;

  const labelClass = `block text-sm font-medium mb-2 ${isDark ? 'text-white/80' : 'text-primary/80'}`;
  const errorClass = 'text-red-500 text-xs mt-1 flex items-center gap-1';

  return (
    <form onSubmit={handleSubmit} className="p-6 space-y-5">
      <div className={`p-4 rounded-xl border ${isDark ? 'bg-amber-500/10 border-amber-500/30' : 'bg-amber-50 border-amber-200'}`}>
        <div className="flex items-start gap-3">
          <span className={`material-symbols-outlined text-xl ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
            family_restroom
          </span>
          <div>
            <h4 className={`font-bold ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>
              Guardian Consent Required
            </h4>
            <p className={`text-sm mt-1 ${isDark ? 'text-amber-300/80' : 'text-amber-700'}`}>
              Since {memberName} is under 18, a parent or legal guardian must provide consent before booking.
            </p>
          </div>
        </div>
      </div>

      <div>
        <label className={labelClass}>Guardian Full Name *</label>
        <input
          type="text"
          value={guardianName}
          onChange={(e) => setGuardianName(e.target.value)}
          placeholder="Enter guardian's full name"
          className={getInputClass(!!errors.guardianName)}
        />
        {errors.guardianName && (
          <p className={errorClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {errors.guardianName}
          </p>
        )}
      </div>

      <div>
        <label className={labelClass}>Relationship to Member *</label>
        <div className="relative">
          <select
            value={guardianRelationship}
            onChange={(e) => setGuardianRelationship(e.target.value)}
            className={getSelectClass(!!errors.guardianRelationship)}
          >
            <option value="">Select relationship...</option>
            {RELATIONSHIP_OPTIONS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
          <span className={`material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
            expand_more
          </span>
        </div>
        {errors.guardianRelationship && (
          <p className={errorClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {errors.guardianRelationship}
          </p>
        )}
      </div>

      <div>
        <label className={labelClass}>Guardian Phone Number *</label>
        <input
          type="tel"
          value={guardianPhone}
          onChange={(e) => setGuardianPhone(e.target.value)}
          placeholder="(555) 123-4567"
          className={getInputClass(!!errors.guardianPhone)}
        />
        {errors.guardianPhone && (
          <p className={errorClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {errors.guardianPhone}
          </p>
        )}
      </div>

      <div className={`p-4 rounded-xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'}`}>
        <label className="flex items-start gap-3 cursor-pointer">
          <div className="relative mt-0.5">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="sr-only"
            />
            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
              acknowledged 
                ? 'bg-accent border-accent' 
                : isDark ? 'border-white/30' : 'border-gray-300'
            } ${errors.acknowledged ? 'border-red-500' : ''}`}>
              {acknowledged && (
                <span className="material-symbols-outlined text-sm text-[#293515]">check</span>
              )}
            </div>
          </div>
          <span className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
            I am the parent or legal guardian of {memberName}. I consent to this booking and acknowledge that I am responsible for supervising this minor during their time at the facility. I understand and accept the facility rules and safety guidelines.
          </span>
        </label>
        {errors.acknowledged && (
          <p className={`${errorClass} mt-2`}>
            <span className="material-symbols-outlined text-xs">error</span>
            {errors.acknowledged}
          </p>
        )}
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className={`flex-1 py-3 rounded-xl font-bold text-sm border transition-colors ${
            isDark 
              ? 'border-white/20 text-white hover:bg-white/5' 
              : 'border-primary/20 text-primary hover:bg-primary/5'
          }`}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="flex-1 py-3 rounded-xl font-bold text-sm bg-accent text-[#293515] hover:bg-accent/90 transition-colors flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-lg">verified</span>
          Confirm & Book
        </button>
      </div>
    </form>
  );
}

export default GuardianConsentForm;
