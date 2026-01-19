import React from 'react';

interface CompedBillingSectionProps {
  isDark: boolean;
}

export const CompedBillingSection: React.FC<CompedBillingSectionProps> = ({ isDark }) => {
  return (
    <div className={`p-4 rounded-xl ${isDark ? 'bg-green-500/10 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
      <div className="flex items-start gap-3">
        <span className={`material-symbols-outlined ${isDark ? 'text-green-400' : 'text-green-600'} text-xl`}>card_giftcard</span>
        <div className="flex-1">
          <p className={`text-sm font-medium ${isDark ? 'text-green-300' : 'text-green-700'}`}>
            Complimentary membership - no billing
          </p>
          <p className={`text-xs mt-1 ${isDark ? 'text-green-400/80' : 'text-green-600'}`}>
            This member has a comped membership and is not charged.
          </p>
          <div className={`mt-3 p-3 rounded-lg ${isDark ? 'bg-black/20' : 'bg-white'} border ${isDark ? 'border-white/10' : 'border-gray-100'}`}>
            <div className="flex items-start gap-2">
              <span className={`material-symbols-outlined text-base ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>info</span>
              <div>
                <p className={`text-xs font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  To convert to a paid plan:
                </p>
                <ol className={`text-xs mt-1 list-decimal list-inside ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  <li>Member must sign up through the membership page</li>
                  <li>Complete payment via Stripe checkout</li>
                  <li>Then change billing source above to "Stripe"</li>
                </ol>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CompedBillingSection;
