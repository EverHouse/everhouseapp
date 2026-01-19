import React from 'react';

interface FamilyGroup {
  id: number;
  primaryEmail: string;
  primaryName?: string;
  groupName?: string;
  members?: {
    id: number;
    memberEmail: string;
    memberName: string;
    addOnPriceCents: number;
  }[];
}

interface FamilyAddonBillingSectionProps {
  familyGroup?: FamilyGroup | null;
  memberEmail: string;
  isDark: boolean;
}

function formatCurrency(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export const FamilyAddonBillingSection: React.FC<FamilyAddonBillingSectionProps> = ({
  familyGroup,
  memberEmail,
  isDark,
}) => {
  return (
    <div className={`p-4 rounded-xl ${isDark ? 'bg-purple-500/10 border border-purple-500/30' : 'bg-purple-50 border border-purple-200'}`}>
      <div className="flex items-start gap-3">
        <span className={`material-symbols-outlined ${isDark ? 'text-purple-400' : 'text-purple-600'} text-xl`}>family_restroom</span>
        <div className="flex-1">
          <p className={`text-sm font-medium ${isDark ? 'text-purple-300' : 'text-purple-700'}`}>
            Billed as family add-on
          </p>
          {familyGroup && (
            <div className={`mt-3 p-3 rounded-lg ${isDark ? 'bg-black/20' : 'bg-white'}`}>
              <div className="space-y-2">
                <div>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Primary Payer</p>
                  <p className={`text-sm ${isDark ? 'text-white' : 'text-primary'}`}>
                    {familyGroup.primaryName || familyGroup.primaryEmail}
                  </p>
                  <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {familyGroup.primaryEmail}
                  </p>
                </div>
                {familyGroup.members && (
                  <div>
                    <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Add-on Price</p>
                    <p className={`text-sm ${isDark ? 'text-white' : 'text-primary'}`}>
                      {formatCurrency(
                        familyGroup.members.find(
                          (m) => m.memberEmail.toLowerCase() === memberEmail.toLowerCase()
                        )?.addOnPriceCents || 0
                      )}/month
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
          <p className={`text-xs mt-3 ${isDark ? 'text-purple-400/80' : 'text-purple-600'}`}>
            To make billing changes, check the primary payer's profile.
          </p>
        </div>
      </div>
    </div>
  );
};

export default FamilyAddonBillingSection;
