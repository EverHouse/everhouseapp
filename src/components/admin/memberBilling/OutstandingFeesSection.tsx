import React from 'react';
import type { BillingInfo, OutstandingData } from './types';
import { formatTime12Hour } from './types';

export function OutstandingFeesSection({
  billingInfo,
  outstandingData,
  isDark,
}: {
  billingInfo: BillingInfo | null;
  outstandingData: OutstandingData | null;
  isDark: boolean;
}) {
  const hasIncompleteSubscription = billingInfo?.activeSubscription?.status === 'incomplete';
  const subscriptionAmountCents = billingInfo?.activeSubscription?.planAmount || 0;
  const hasBookingFees = outstandingData && outstandingData.totalOutstandingCents > 0;

  const getDiscountedAmount = (amountCents: number, coupon: { percentOff?: number; amountOff?: number } | undefined | null) => {
    if (coupon?.percentOff) return Math.round(amountCents * (1 - coupon.percentOff / 100));
    if (coupon?.amountOff) return Math.max(0, amountCents - coupon.amountOff);
    return amountCents;
  };

  const coupon = billingInfo?.activeSubscription?.discount?.coupon;
  const pendingAmount = getDiscountedAmount(subscriptionAmountCents, coupon);

  return (
    <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`material-symbols-outlined ${isDark ? 'text-accent' : 'text-primary'}`}>receipt_long</span>
        <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Outstanding Booking Fees</h3>
      </div>
      
      {(() => {
        if (!hasBookingFees && hasIncompleteSubscription && subscriptionAmountCents > 0) {
          return (
            <div className={`flex items-center justify-between p-3 rounded-lg ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
              <div className="flex items-center gap-2">
                <span className={`material-symbols-outlined text-base ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>pending</span>
                <span className={`text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                  Subscription payment pending
                </span>
              </div>
              <span className={`text-lg font-bold ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                ${(pendingAmount / 100).toFixed(2)}
              </span>
            </div>
          );
        }

        if (!hasBookingFees && !hasIncompleteSubscription) {
          return (
            <div className={`flex items-center gap-2 py-2 ${isDark ? 'text-green-400' : 'text-green-600'}`}>
              <span className="material-symbols-outlined text-base">check_circle</span>
              <span className="text-sm">No outstanding fees</span>
            </div>
          );
        }

        return null;
      })()}
      {outstandingData && outstandingData.totalOutstandingCents > 0 && (
        <div className="space-y-3">
          {hasIncompleteSubscription && subscriptionAmountCents > 0 && (() => {
            const subCoupon = billingInfo!.activeSubscription!.discount?.coupon;
            const discountedAmount = getDiscountedAmount(subscriptionAmountCents, subCoupon);
            return (
              <div className={`flex items-center justify-between p-3 rounded-lg ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-base ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>pending</span>
                  <span className={`text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                    Subscription payment pending
                  </span>
                </div>
                <span className={`text-lg font-bold ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                  ${(discountedAmount / 100).toFixed(2)}
                </span>
              </div>
            );
          })()}
          <div className={`flex items-center justify-between p-3 rounded-lg ${isDark ? 'bg-red-500/10 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
            <span className={`text-sm font-medium ${isDark ? 'text-red-400' : 'text-red-700'}`}>Total Outstanding</span>
            <span className={`text-lg font-bold ${isDark ? 'text-red-400' : 'text-red-700'}`}>
              ${outstandingData.totalOutstandingDollars.toFixed(2)}
            </span>
          </div>
          
          <div className="space-y-2">
            {outstandingData.items.map((item) => (
              <div 
                key={item.participantId} 
                className={`flex items-center justify-between py-2 px-3 rounded-lg text-sm ${isDark ? 'bg-white/5' : 'bg-white'}`}
              >
                <div className="flex-1 min-w-0">
                  <div className={`font-medium truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    #{item.trackmanBookingId || item.bookingId} · {item.resourceName}
                  </div>
                  <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {new Date(item.bookingDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })} · {formatTime12Hour(item.startTime)} — {item.feeLabel}
                    {item.participantType === 'guest' && item.displayName && ` (${item.displayName})`}
                  </div>
                </div>
                <span className={`font-medium ml-2 ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                  ${item.feeDollars.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
