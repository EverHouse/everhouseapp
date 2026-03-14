import React from 'react';
import type { ErrorState } from './types';

interface PassErrorStateProps {
  errorState: ErrorState;
  confirmingRedeemAnyway: string | null;
  forceRedeeming: boolean;
  lastAttemptedPassId: string | null;
  formatDateTime: (dateStr: string) => string;
  formatTime: (dateStr: string) => string;
  handleSearchByEmail: () => void;
  handleSellNewPass: () => void;
  handleProceedAnyway: (passId: string) => void;
  clearErrorAndReset: () => void;
  handleRedeem: (passId: string, force?: boolean) => void;
  setConfirmingRedeemAnyway: (value: string | null) => void;
}

const PassErrorState: React.FC<PassErrorStateProps> = ({
  errorState,
  confirmingRedeemAnyway,
  forceRedeeming,
  lastAttemptedPassId,
  formatDateTime,
  formatTime,
  handleSearchByEmail,
  handleSellNewPass,
  handleProceedAnyway,
  clearErrorAndReset,
  handleRedeem,
  setConfirmingRedeemAnyway,
}) => {
  const { errorCode, passDetails } = errorState;

  if (errorCode === 'PASS_NOT_FOUND') {
    return (
      <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 space-y-3">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-2xl text-amber-600 dark:text-amber-400">search_off</span>
          <div className="flex-1">
            <p className="font-semibold text-amber-900 dark:text-amber-100">Pass not found or invalid</p>
            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
              The scanned QR code doesn't match any active day pass in our system.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            onClick={handleSearchByEmail}
            className="tactile-btn flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-amber-100 dark:bg-amber-800/40 text-amber-900 dark:text-amber-100 font-medium text-sm hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-lg">mail</span>
            Search by email
          </button>
          <button
            onClick={handleSellNewPass}
            className="tactile-btn flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-teal-500 text-white font-medium text-sm hover:bg-teal-600 transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-lg">add_shopping_cart</span>
            Sell new pass
          </button>
        </div>
      </div>
    );
  }

  if (errorCode === 'PASS_EXHAUSTED') {
    return (
      <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 space-y-3">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-2xl text-amber-600 dark:text-amber-400">check_circle</span>
          <div className="flex-1">
            <p className="font-semibold text-amber-900 dark:text-amber-100">This pass has been fully redeemed</p>
            {passDetails && (
              <div className="mt-2 space-y-1">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  <span className="font-medium">{passDetails.name || passDetails.email}</span>
                </p>
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  Used {passDetails.usedCount} of {passDetails.totalUses} times
                </p>
                {passDetails.lastRedemption && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Last used: {formatDateTime(passDetails.lastRedemption)}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            onClick={handleSellNewPass}
            className="tactile-btn flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-teal-500 text-white font-medium text-sm hover:bg-teal-600 transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-lg">add_shopping_cart</span>
            Charge for new pass
          </button>
          <button
            onClick={clearErrorAndReset}
            className="tactile-btn px-4 py-2.5 rounded-lg bg-amber-100 dark:bg-amber-800/40 text-amber-900 dark:text-amber-100 font-medium text-sm hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-lg">refresh</span>
            Start over
          </button>
        </div>
      </div>
    );
  }

  if (errorCode === 'ALREADY_REDEEMED_TODAY') {
    const confirmingThis = confirmingRedeemAnyway === 'current';
    return (
      <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 space-y-3">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-2xl text-amber-600 dark:text-amber-400">schedule</span>
          <div className="flex-1">
            <p className="font-semibold text-amber-900 dark:text-amber-100">Already checked in today</p>
            {passDetails && (
              <div className="mt-2 space-y-1">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  <span className="font-medium">{passDetails.name || passDetails.email}</span>
                </p>
                {passDetails.redeemedTodayAt && (
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Checked in at {formatTime(passDetails.redeemedTodayAt)}
                  </p>
                )}
                {passDetails.remainingUses !== undefined && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {passDetails.remainingUses} uses remaining on this pass
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
        
        {!confirmingThis ? (
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={() => handleProceedAnyway('current')}
              className="tactile-btn flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-amber-100 dark:bg-amber-800/40 text-amber-900 dark:text-amber-100 font-medium text-sm hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">warning</span>
              Redeem anyway
            </button>
            <button
              onClick={clearErrorAndReset}
              className="tactile-btn px-4 py-2.5 rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium text-sm hover:bg-primary/20 dark:hover:bg-white/20 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">close</span>
              Cancel
            </button>
          </div>
        ) : (
          <div className="pt-2 space-y-3">
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800/40">
              <p className="text-sm text-red-800 dark:text-red-200 font-medium">
                Are you sure? This will use another redemption from this pass.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (lastAttemptedPassId) handleRedeem(lastAttemptedPassId, true);
                }}
                disabled={forceRedeeming || !lastAttemptedPassId}
                className="tactile-btn flex-1 px-4 py-2.5 rounded-lg bg-red-500 text-white font-medium text-sm hover:bg-red-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {forceRedeeming ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                ) : (
                  <span className="material-symbols-outlined text-lg">check</span>
                )}
                Yes, redeem again
              </button>
              <button
                onClick={() => setConfirmingRedeemAnyway(null)}
                className="tactile-btn px-4 py-2.5 rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium text-sm hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (errorCode === 'PASS_NOT_ACTIVE') {
    return (
      <div className="p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 space-y-3">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-2xl text-red-600 dark:text-red-400">block</span>
          <div className="flex-1">
            <p className="font-semibold text-red-900 dark:text-red-100">Pass is no longer active</p>
            {passDetails && (
              <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                This pass for {passDetails.name || passDetails.email} has been deactivated.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            onClick={handleSellNewPass}
            className="tactile-btn flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-teal-500 text-white font-medium text-sm hover:bg-teal-600 transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-lg">add_shopping_cart</span>
            Sell new pass
          </button>
          <button
            onClick={clearErrorAndReset}
            className="tactile-btn px-4 py-2.5 rounded-lg bg-red-100 dark:bg-red-800/40 text-red-900 dark:text-red-100 font-medium text-sm hover:bg-red-200 dark:hover:bg-red-800/60 transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-lg">refresh</span>
            Start over
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 space-y-3">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined text-red-600 dark:text-red-400">error</span>
        <p className="text-sm text-red-700 dark:text-red-400">{errorState.message}</p>
      </div>
      <button
        onClick={clearErrorAndReset}
        className="tactile-btn w-full px-4 py-2 rounded-lg bg-red-100 dark:bg-red-800/40 text-red-900 dark:text-red-100 font-medium text-sm hover:bg-red-200 dark:hover:bg-red-800/60 transition-colors flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-lg">refresh</span>
        Try again
      </button>
    </div>
  );
};

export default PassErrorState;
