import React from 'react';
import {
  MemberFormData,
  MembershipTier,
  MemberStep,
  ExistingBillingGroup,
} from './newUserTypes';

interface PreviewStepProps {
  form: MemberFormData;
  tiers: MembershipTier[];
  discounts: { id: string; code: string; percentOff: number; stripeCouponId?: string; name?: string }[];
  existingBillingGroups: ExistingBillingGroup[];
  selectedTier: MembershipTier | undefined;
  isDark: boolean;
  setStep: (step: MemberStep) => void;
}

export function PreviewStep({
  form,
  tiers,
  discounts,
  existingBillingGroups,
  selectedTier,
  isDark,
  setStep,
}: PreviewStepProps) {
  const discount = discounts.find(d => d.code === form.discountCode);
  const tierPrice = selectedTier?.priceCents || 0;
  const discountPercent = discount?.percentOff || 0;
  const primaryPrice = form.joinExistingGroup 
    ? Math.round(tierPrice * 0.8)
    : Math.round(tierPrice * (1 - discountPercent / 100));
  
  const groupMembersPricing = form.groupMembers.map((member) => {
    const memberTier = tiers.find(t => t.id === member.tierId) || selectedTier;
    const memberTierPrice = memberTier?.priceCents || tierPrice;
    const memberDiscount = discounts.find(d => d.code === member.discountCode);
    const memberDiscountPercent = memberDiscount?.percentOff || 0;
    return {
      ...member,
      tierName: memberTier?.name || selectedTier?.name || 'Unknown',
      discountLabel: memberDiscount ? `${memberDiscount.name || memberDiscount.code} ${memberDiscountPercent}% off` : null,
      price: Math.round(memberTierPrice * (1 - memberDiscountPercent / 100)),
    };
  });
  
  const groupMembersTotal = groupMembersPricing.reduce((sum, m) => sum + m.price, 0);
  const totalPrice = primaryPrice + groupMembersTotal;
  
  const selectedGroup = form.joinExistingGroup 
    ? existingBillingGroups.find(g => g.id === form.existingGroupId) 
    : null;

  return (
    <div className="space-y-4">
      <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
        Review Charges
      </h3>

      {form.joinExistingGroup && selectedGroup && (
        <div className={`p-3 rounded-lg ${isDark ? 'bg-blue-900/20 border border-blue-700' : 'bg-blue-50 border border-blue-200'}`}>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-blue-500">group</span>
            <div>
              <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Adding to: {selectedGroup.groupName || selectedGroup.primaryName}
              </p>
              <p className={`text-sm ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>
                Billing through {selectedGroup.primaryEmail}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <div>
              <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {form.firstName} {form.lastName}
              </p>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {selectedTier?.name} Membership
                {form.joinExistingGroup ? ' (20% family discount)' : discount ? ` (${discount.percentOff}% off)` : ''}
              </p>
            </div>
            <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              ${(primaryPrice / 100).toFixed(2)}/mo
            </span>
          </div>

          {groupMembersPricing.map((member, index) => (
            <div key={index} className="flex justify-between items-center">
              <div>
                <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {member.firstName || 'Sub-member'} {member.lastName || index + 1}
                </p>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  {member.tierName}{member.discountLabel ? ` (${member.discountLabel})` : ''}
                </p>
              </div>
              <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                ${(member.price / 100).toFixed(2)}/mo
              </span>
            </div>
          ))}

          <div className={`pt-3 mt-3 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
            <div className="flex justify-between items-center">
              <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Monthly Total
              </span>
              <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                ${(totalPrice / 100).toFixed(2)}/mo
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-3 pt-4">
        <button
          onClick={() => setStep('form')}
          className={`flex-1 py-2.5 rounded-lg font-medium transition-colors tactile-btn ${
            isDark 
              ? 'bg-white/10 text-white hover:bg-white/20' 
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Back
        </button>
        <button
          onClick={() => setStep('payment')}
          className="flex-1 py-2.5 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors tactile-btn"
        >
          Continue to Payment
        </button>
      </div>
    </div>
  );
}
