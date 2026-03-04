import React from 'react';
import { ModalShell } from '../../ModalShell';
import type { CouponOption } from './types';

export function CreateSubscriptionModal({
  isOpen,
  onClose,
  validTiers,
  selectedTier,
  onSelectTier,
  selectedCoupon,
  onSelectCoupon,
  availableCoupons,
  isLoadingCoupons,
  isCreating,
  onCreateSubscription,
  isDark,
}: {
  isOpen: boolean;
  onClose: () => void;
  validTiers: string[];
  selectedTier: string;
  onSelectTier: (tier: string) => void;
  selectedCoupon: string;
  onSelectCoupon: (coupon: string) => void;
  availableCoupons: CouponOption[];
  isLoadingCoupons: boolean;
  isCreating: boolean;
  onCreateSubscription: () => void;
  isDark: boolean;
}) {
  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Create Subscription"
      size="sm"
    >
      <div className="p-4 space-y-4">
        <div className={`p-4 rounded-lg ${isDark ? 'bg-green-500/10 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
          <div className="flex items-start gap-3">
            <span className={`material-symbols-outlined ${isDark ? 'text-green-400' : 'text-green-600'} text-xl`}>add_card</span>
            <div>
              <p className={`text-sm font-medium ${isDark ? 'text-green-300' : 'text-green-700'}`}>
                Start a new membership subscription
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-green-400/80' : 'text-green-600'}`}>
                This will create a subscription in Stripe and begin billing the member.
              </p>
            </div>
          </div>
        </div>

        <div>
          <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
            Select Membership Tier
          </label>
          <select
            value={selectedTier}
            onChange={(e) => onSelectTier(e.target.value)}
            className={`w-full p-3 rounded-lg border ${
              isDark
                ? 'bg-white/10 border-white/20 text-white'
                : 'bg-white border-gray-300 text-gray-900'
            } focus:ring-2 focus:ring-green-500 focus:border-green-500`}
          >
            <option value="">Choose a tier...</option>
            {validTiers.map((tier) => (
              <option key={tier} value={tier}>{tier}</option>
            ))}
          </select>
        </div>

        <div>
          <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
            Apply Discount (Optional)
          </label>
          <select
            value={selectedCoupon}
            onChange={(e) => onSelectCoupon(e.target.value)}
            disabled={isLoadingCoupons}
            className={`w-full p-3 rounded-lg border ${
              isDark
                ? 'bg-white/10 border-white/20 text-white'
                : 'bg-white border-gray-300 text-gray-900'
            } focus:ring-2 focus:ring-green-500 focus:border-green-500 disabled:opacity-50`}
          >
            <option value="">No discount</option>
            {availableCoupons.map((coupon) => (
              <option key={coupon.id} value={coupon.id}>
                {coupon.name} ({coupon.percentOff ? `${coupon.percentOff}% off` : coupon.amountOff ? `$${(coupon.amountOff / 100).toFixed(2)} off` : ''} - {coupon.duration === 'forever' ? 'Forever' : coupon.duration === 'once' ? 'First invoice' : `${coupon.duration}`})
              </option>
            ))}
          </select>
          {isLoadingCoupons && (
            <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Loading coupons...</p>
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors tactile-btn ${
              isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={onCreateSubscription}
            disabled={isCreating || !selectedTier}
            className="flex-1 px-4 py-2.5 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50 transition-colors tactile-btn"
          >
            {isCreating ? (
              <span className="flex items-center justify-center gap-2">
                <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                Creating...
              </span>
            ) : (
              'Create Subscription'
            )}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
