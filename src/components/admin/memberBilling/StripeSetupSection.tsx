import React from 'react';

export function StripeSetupSection({
  onSyncToStripe,
  isSyncingToStripe,
  isDark,
}: {
  onSyncToStripe: () => void;
  isSyncingToStripe: boolean;
  isDark: boolean;
}) {
  return (
    <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`material-symbols-outlined ${isDark ? 'text-accent' : 'text-primary'}`}>sync</span>
        <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Stripe Setup</h3>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={onSyncToStripe}
          disabled={isSyncingToStripe}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors tactile-btn ${
            isDark ? 'bg-purple-500/20 text-purple-300 hover:bg-purple-500/30' : 'bg-purple-100 text-purple-700 hover:bg-purple-200'
          } disabled:opacity-50`}
        >
          {isSyncingToStripe ? (
            <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
          ) : (
            <span className="material-symbols-outlined text-base">person_add</span>
          )}
          Sync to Stripe
        </button>
      </div>
      <p className={`text-xs mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        Create or link a Stripe customer for this member to enable wallet features.
      </p>
    </div>
  );
}
