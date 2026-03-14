import React from 'react';
import { formatPhoneInput } from '../../../../utils/formatting';
import {
  MemberFormData,
  MembershipTier,
  ExistingBillingGroup,
  GroupMember,
  RecentCreation,
  EmailCheckResult,
} from './newUserTypes';

interface MemberFormStepProps {
  form: MemberFormData;
  setForm: React.Dispatch<React.SetStateAction<MemberFormData>>;
  tiers: MembershipTier[];
  discounts: { id: string; code: string; percentOff: number; stripeCouponId?: string; name?: string }[];
  existingBillingGroups: ExistingBillingGroup[];
  isDark: boolean;
  fieldErrors: Record<string, string>;
  setFieldErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  inputClass: string;
  getInputClass: (fieldName: string) => string;
  labelClass: string;
  errorMsgClass: string;
  scannedIdImage: { base64: string; mimeType: string } | null;
  onShowIdScanner: () => void;
  recentCreations: RecentCreation[];
  emailCheckResult: EmailCheckResult | null;
  onEmailBlur: (email: string) => void;
  handleReviewCharges: () => void;
  addGroupMember: () => void;
  removeGroupMember: (index: number) => void;
  updateGroupMember: (index: number, field: keyof GroupMember, value: string) => void;
  subMemberScannedIds: Record<number, { base64: string; mimeType: string }>;
  setScanningSubMemberIndex: (index: number | null) => void;
  setShowIdScanner: (show: boolean) => void;
}

export function MemberFormStep({
  form,
  setForm,
  tiers,
  discounts,
  existingBillingGroups,
  isDark,
  fieldErrors,
  setFieldErrors,
  inputClass,
  getInputClass,
  labelClass,
  errorMsgClass,
  scannedIdImage,
  onShowIdScanner,
  recentCreations,
  emailCheckResult,
  onEmailBlur,
  handleReviewCharges,
  addGroupMember,
  removeGroupMember,
  updateGroupMember,
  subMemberScannedIds,
  setScanningSubMemberIndex,
  setShowIdScanner,
}: MemberFormStepProps) {
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onShowIdScanner}
        className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg border-2 border-dashed transition-colors tactile-btn ${
          isDark
            ? 'border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10'
            : 'border-emerald-500/50 text-emerald-600 hover:bg-emerald-50'
        }`}
      >
        <span className="material-symbols-outlined text-xl">photo_camera</span>
        <span className="text-sm font-medium">Scan Driver's License / ID</span>
      </button>
      {scannedIdImage && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
          isDark ? 'bg-emerald-900/30 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
        }`}>
          <span className="material-symbols-outlined text-sm">check_circle</span>
          ID scanned — fields auto-filled
        </div>
      )}
      <div className="space-y-1">
        <label className={labelClass}>Membership Tier *</label>
        <select
          value={form.tierId || ''}
          onChange={(e) => {
            setForm(prev => ({ ...prev, tierId: Number(e.target.value) || null }));
            if (fieldErrors.tierId) setFieldErrors(prev => ({ ...prev, tierId: '' }));
          }}
          className={getInputClass('tierId')}
        >
          <option value="">Select a tier...</option>
          {tiers.map(tier => (
            <option key={tier.id} value={tier.id}>
              {tier.name} - ${(tier.priceCents / 100).toFixed(2)}/mo
            </option>
          ))}
        </select>
        {fieldErrors.tierId && (
          <p className={errorMsgClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {fieldErrors.tierId}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className={labelClass}>First Name *</label>
          <input
            type="text"
            value={form.firstName}
            onChange={(e) => {
              setForm(prev => ({ ...prev, firstName: e.target.value }));
              if (fieldErrors.firstName) setFieldErrors(prev => ({ ...prev, firstName: '' }));
            }}
            placeholder="First name"
            className={getInputClass('firstName')}
          />
          {fieldErrors.firstName && (
            <p className={errorMsgClass}>
              <span className="material-symbols-outlined text-xs">error</span>
              {fieldErrors.firstName}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label className={labelClass}>Last Name *</label>
          <input
            type="text"
            value={form.lastName}
            onChange={(e) => {
              setForm(prev => ({ ...prev, lastName: e.target.value }));
              if (fieldErrors.lastName) setFieldErrors(prev => ({ ...prev, lastName: '' }));
            }}
            placeholder="Last name"
            className={getInputClass('lastName')}
          />
          {fieldErrors.lastName && (
            <p className={errorMsgClass}>
              <span className="material-symbols-outlined text-xs">error</span>
              {fieldErrors.lastName}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <label className={labelClass}>Email *</label>
        <input
          type="email"
          value={form.email}
          onChange={(e) => {
            setForm(prev => ({ ...prev, email: e.target.value }));
            if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: '' }));
          }}
          onBlur={() => onEmailBlur(form.email)}
          placeholder="email@example.com"
          className={getInputClass('email')}
        />
        {fieldErrors.email && (
          <p className={errorMsgClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {fieldErrors.email}
          </p>
        )}
        {emailCheckResult?.exists && (
          <div className={`mt-1.5 p-2 rounded-lg flex items-start gap-2 text-xs ${isDark ? 'bg-amber-900/20 border border-amber-700 text-amber-400' : 'bg-amber-50 border border-amber-200 text-amber-700'}`}>
            <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">warning</span>
            <span>A {emailCheckResult.role || 'user'} named <strong>{emailCheckResult.userName}</strong> already exists with this email ({emailCheckResult.membershipStatus || 'active'}). Are you sure this is correct?</span>
          </div>
        )}
        {(() => {
          const currentEmail = form.email.trim().toLowerCase();
          const currentName = `${form.firstName} ${form.lastName}`.trim().toLowerCase();
          // eslint-disable-next-line react-hooks/purity
          const recentMatch = recentCreations.find(r => (Date.now() - r.timestamp) < 600000 && (r.email === currentEmail || (currentName.length > 1 && r.name.toLowerCase() === currentName)));
          if (recentMatch) {
            // eslint-disable-next-line react-hooks/purity
            const minsAgo = Math.round((Date.now() - recentMatch.timestamp) / 60000);
            return (
              <div className={`mt-1.5 p-2 rounded-lg flex items-start gap-2 text-xs ${isDark ? 'bg-orange-900/20 border border-orange-700 text-orange-400' : 'bg-orange-50 border border-orange-200 text-orange-700'}`}>
                <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">history</span>
                <span>You created a record for <strong>{recentMatch.name}</strong> {minsAgo < 1 ? 'just now' : `${minsAgo} min ago`}. Is this a different person?</span>
              </div>
            );
          }
          return null;
        })()}
      </div>

      <div className="space-y-1">
        <label className={labelClass}>Phone *</label>
        <input
          type="tel"
          value={formatPhoneInput(form.phone)}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
            setForm(prev => ({ ...prev, phone: digits }));
            if (fieldErrors.phone) setFieldErrors(prev => ({ ...prev, phone: '' }));
          }}
          placeholder="(555) 123-4567"
          className={getInputClass('phone')}
        />
        {fieldErrors.phone && (
          <p className={errorMsgClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {fieldErrors.phone}
          </p>
        )}
      </div>

      <div>
        <label className={labelClass}>Date of Birth</label>
        <input
          type="date"
          value={form.dob}
          onChange={(e) => setForm(prev => ({ ...prev, dob: e.target.value }))}
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Discount Code</label>
        <select
          value={form.discountCode}
          onChange={(e) => setForm(prev => ({ ...prev, discountCode: e.target.value }))}
          className={inputClass}
        >
          <option value="">No discount</option>
          {discounts.map(discount => (
            <option key={discount.id} value={discount.code}>
              {(discount as { id: string; code: string; percentOff: number; name?: string }).name || discount.code} ({discount.percentOff}% off)
            </option>
          ))}
        </select>
      </div>

      {existingBillingGroups.length > 0 && (
        <div className={`p-4 rounded-lg ${isDark ? 'bg-blue-900/20 border border-blue-700' : 'bg-blue-50 border border-blue-200'}`}>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.joinExistingGroup}
              onChange={(e) => {
                setForm(prev => ({
                  ...prev,
                  joinExistingGroup: e.target.checked,
                  existingGroupId: e.target.checked ? null : null,
                  existingGroupType: null,
                  addGroupMembers: false,
                  groupMembers: [],
                }));
              }}
              className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <div>
              <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Add to Existing Billing Group?
              </span>
              <p className={`text-sm ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>
                Add this member to an existing family or corporate billing group
              </p>
            </div>
          </label>

          {form.joinExistingGroup && (
            <div className="mt-4">
              <label className={labelClass}>Select Billing Group</label>
              <select
                value={form.existingGroupId ?? ''}
                onChange={(e) => {
                  const groupId = e.target.value ? parseInt(e.target.value, 10) : null;
                  const selectedGroup = existingBillingGroups.find(g => g.id === groupId);
                  setForm(prev => ({
                    ...prev,
                    existingGroupId: groupId,
                    existingGroupType: selectedGroup?.groupType || null,
                  }));
                }}
                className={inputClass}
              >
                <option value="">Select a group...</option>
                {existingBillingGroups.map(group => (
                  <option key={group.id} value={group.id}>
                    {group.groupName || group.primaryName} ({group.primaryEmail}) - {group.groupType}
                  </option>
                ))}
              </select>
              {form.existingGroupId && (
                <p className={`mt-2 text-sm ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>
                  <span className="material-symbols-outlined text-sm align-middle mr-1">info</span>
                  Member will be billed through the group's primary account with 20% family discount
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {!form.joinExistingGroup && (
        <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.addGroupMembers}
              onChange={(e) => {
                setForm(prev => ({
                  ...prev,
                  addGroupMembers: e.target.checked,
                  groupMembers: e.target.checked ? [{ firstName: '', lastName: '', email: '', phone: '', dob: '', tierId: prev.tierId, streetAddress: '', city: '', state: '', zipCode: '' }] : [],
                }));
              }}
              className="w-5 h-5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
            />
            <div>
              <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Add Group Members?
              </span>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                Family members get 20% off their membership
              </p>
            </div>
          </label>

          {form.addGroupMembers && (
            <div className="mt-4 space-y-4">
              {form.groupMembers.map((member, index) => (
                <div key={index} className={`p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'} border ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <span className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                      Sub-Member {index + 1}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setScanningSubMemberIndex(index);
                          setShowIdScanner(true);
                        }}
                        className="text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 flex items-center gap-1"
                      >
                        <span className="material-symbols-outlined text-sm">badge</span>
                        Scan ID
                      </button>
                      <button
                        onClick={() => removeGroupMember(index)}
                        className="text-red-500 hover:text-red-600"
                      >
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                  </div>
                  <div className="mb-2">
                    <select
                      value={member.tierId ?? ''}
                      onChange={(e) => updateGroupMember(index, 'tierId', e.target.value)}
                      className={`${inputClass} text-sm py-2`}
                    >
                      <option value="">Select tier...</option>
                      {tiers.map(tier => (
                        <option key={tier.id} value={tier.id}>
                          {tier.name} - ${(tier.priceCents * 0.8 / 100).toFixed(2)}/mo (20% off)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={member.firstName}
                      onChange={(e) => updateGroupMember(index, 'firstName', e.target.value)}
                      placeholder="First name"
                      className={`${inputClass} text-sm py-2`}
                    />
                    <input
                      type="text"
                      value={member.lastName}
                      onChange={(e) => updateGroupMember(index, 'lastName', e.target.value)}
                      placeholder="Last name"
                      className={`${inputClass} text-sm py-2`}
                    />
                    <input
                      type="email"
                      value={member.email}
                      onChange={(e) => updateGroupMember(index, 'email', e.target.value)}
                      placeholder="Email"
                      className={`${inputClass} text-sm py-2`}
                    />
                    <input
                      type="tel"
                      value={formatPhoneInput(member.phone)}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
                        updateGroupMember(index, 'phone', digits);
                      }}
                      placeholder="Phone"
                      className={`${inputClass} text-sm py-2`}
                    />
                  </div>
                  <div className="mt-2">
                    <input
                      type="date"
                      value={member.dob}
                      onChange={(e) => updateGroupMember(index, 'dob', e.target.value)}
                      placeholder="Date of birth"
                      className={`${inputClass} text-sm py-2`}
                    />
                  </div>
                  {subMemberScannedIds[index] && (
                    <div className={`flex items-center gap-2 mt-2 text-xs ${
                      isDark ? 'text-emerald-400' : 'text-emerald-600'
                    }`}>
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      ID scanned
                    </div>
                  )}
                </div>
              ))}
              <button
                onClick={addGroupMember}
                className={`w-full py-2 rounded-lg border-2 border-dashed transition-colors tactile-btn ${
                  isDark 
                    ? 'border-white/20 text-gray-400 hover:border-white/40' 
                    : 'border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                <span className="material-symbols-outlined text-sm mr-1 align-middle">add</span>
                Add Another Member
              </button>
            </div>
          )}
        </div>
      )}

      <button
        onClick={handleReviewCharges}
        disabled={!form.tierId || !form.firstName || !form.lastName || !form.email || !form.phone}
        className="w-full py-3 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed tactile-btn"
      >
        Review Charges
      </button>
    </div>
  );
}
