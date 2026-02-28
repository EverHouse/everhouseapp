import React from 'react';

export interface FeeBreakdownCardProps {
  overageFee: number;
  overageMinutes: number;
  guestFees: number;
  guestsCharged: number;
  guestsUsingPasses: number;
  guestFeePerUnit: number;
  totalFee: number;
  passesRemainingAfter?: number;
  passesTotal?: number;
  isLoading?: boolean;
  tierLabel?: string;
  resourceType?: 'simulator' | 'conference';
  isDark?: boolean;
  compact?: boolean;
  guestsWithoutInfo?: number;
}

const FeeBreakdownCard: React.FC<FeeBreakdownCardProps> = ({
  overageFee,
  overageMinutes,
  guestFees,
  guestsCharged,
  guestsUsingPasses,
  guestFeePerUnit,
  totalFee,
  passesRemainingAfter,
  passesTotal,
  tierLabel,
  resourceType = 'simulator',
  isDark = false,
  compact = false,
  guestsWithoutInfo,
}) => {
  const isSimulator = resourceType === 'simulator';
  const isSocial = tierLabel?.toLowerCase() === 'social';
  const guestCount = guestsCharged + guestsUsingPasses;

  return (
    <div className={`w-full ${compact ? 'px-2 py-2' : 'px-3 sm:px-4 py-3'} rounded-xl backdrop-blur-md border ${isDark ? 'bg-black/70 border-white/20' : 'bg-white/90 border-black/10 shadow-lg'}`}>
      <div className={`flex items-center gap-2 ${compact ? 'mb-1' : 'mb-2'}`}>
        <span className={`material-symbols-outlined ${compact ? 'text-base' : 'text-lg'} ${totalFee > 0 ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-green-400' : 'text-green-600')}`}>receipt_long</span>
        <span className={`${compact ? 'text-[10px]' : 'text-xs'} font-bold uppercase tracking-widest ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Estimated Fees</span>
      </div>
      <div className="space-y-1">
        {overageFee > 0 && (
          <div className="flex justify-between items-center">
            <span className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
              {isSocial 
                ? `${resourceType === 'conference' ? 'Conference room' : 'Simulator'} time (${overageMinutes} min)`
                : `Your time (${overageMinutes} min overage)`}
            </span>
            <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>${overageFee}</span>
          </div>
        )}
        {isSimulator && guestsUsingPasses > 0 && (
          <div className="flex justify-between items-center">
            <span className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
              {guestsUsingPasses} guest{guestsUsingPasses > 1 ? 's' : ''} (using pass{guestsUsingPasses > 1 ? 'es' : ''})
            </span>
            <span className={`text-sm font-semibold ${isDark ? 'text-green-400' : 'text-green-600'}`}>$0</span>
          </div>
        )}
        {isSimulator && guestsCharged > 0 && (
          <div className="flex justify-between items-center">
            <span className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
              {guestsCharged} guest{guestsCharged > 1 ? 's' : ''} @ ${guestFeePerUnit}
            </span>
            <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>${guestFees}</span>
          </div>
        )}
        {isSimulator && guestCount > 0 && passesRemainingAfter !== undefined && passesTotal !== undefined && (!guestsWithoutInfo || guestsWithoutInfo === 0) && (
          <div className="flex justify-between items-center">
            <span className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
              Passes remaining after booking
            </span>
            <span className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
              {passesRemainingAfter} of {passesTotal}
            </span>
          </div>
        )}
        {isSimulator && guestCount > 0 && guestsWithoutInfo !== undefined && guestsWithoutInfo > 0 && (
          <div className={`flex items-center gap-1.5 text-xs mt-1 ${isDark ? 'text-amber-400/70' : 'text-amber-600/80'}`}>
            <span className="material-symbols-outlined text-xs">info</span>
            Enter guest details above to use passes
          </div>
        )}
        {totalFee === 0 && (resourceType === 'conference' || guestCount === 0) && (
          <div className="flex justify-between items-center">
            <span className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
              Included in your membership
            </span>
            <span className={`text-sm font-semibold ${isDark ? 'text-green-400' : 'text-green-600'}`}>No charge</span>
          </div>
        )}
        <div className={`flex justify-between items-center pt-1 border-t ${isDark ? 'border-white/20' : 'border-black/10'}`}>
          <span className={`text-sm font-bold ${isDark ? 'text-white' : 'text-primary'}`}>Total due at check-in</span>
          <span className={`text-base font-bold ${totalFee > 0 ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-green-400' : 'text-green-600')}`}>${totalFee}</span>
        </div>
        {totalFee > 0 && (
          <p className={`text-xs text-center mt-2 ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
            Pay online once booking is confirmed, or at check-in
          </p>
        )}
      </div>
    </div>
  );
};

export default FeeBreakdownCard;
