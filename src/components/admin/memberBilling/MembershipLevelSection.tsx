import React from 'react';
import type { BillingInfo } from './types';

export function MembershipLevelSection({
  billingInfo,
  currentTier,
  isEditingTier,
  setIsEditingTier,
  manualTier,
  setManualTier,
  isSavingTier,
  validTiers,
  onSave,
  isDark,
}: {
  billingInfo: BillingInfo | null;
  currentTier?: string;
  isEditingTier: boolean;
  setIsEditingTier: (v: boolean) => void;
  manualTier: string;
  setManualTier: (v: string) => void;
  isSavingTier: boolean;
  validTiers: string[];
  onSave: () => void;
  isDark: boolean;
}) {
  return (
    <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`material-symbols-outlined ${isDark ? 'text-purple-400' : 'text-purple-600'}`}>badge</span>
          <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Membership Level</h3>
        </div>
        {!isEditingTier && (
          <button
            onClick={() => {
              setManualTier(currentTier || billingInfo?.tier || '');
              setIsEditingTier(true);
            }}
            className={`text-xs font-medium ${isDark ? 'text-purple-400 hover:text-purple-300' : 'text-purple-600 hover:text-purple-700'}`}
          >
            Edit Level
          </button>
        )}
      </div>

      {isEditingTier ? (
        <div className="flex items-center gap-2 mt-2">
          <select
            value={manualTier}
            onChange={(e) => setManualTier(e.target.value)}
            className={`flex-1 px-3 py-2 rounded-lg border text-sm ${
              isDark 
                ? 'bg-black/30 border-white/20 text-white' 
                : 'bg-white border-gray-200 text-primary'
            }`}
            disabled={isSavingTier}
          >
            <option value="">No Tier</option>
            {validTiers.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <button
            onClick={onSave}
            disabled={isSavingTier}
            className="px-3 py-2 bg-brand-green text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {isSavingTier ? '...' : 'Save'}
          </button>
          <button
            onClick={() => setIsEditingTier(false)}
            disabled={isSavingTier}
            className={`px-3 py-2 rounded-lg text-sm font-medium ${
              isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-gray-200 hover:bg-gray-300'
            }`}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className={`text-lg font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {currentTier || billingInfo?.tier || 'No Tier Assigned'}
          </span>
          {(currentTier || billingInfo?.tier) && (
             <span className={`px-2 py-0.5 rounded text-[10px] ${isDark ? 'bg-white/10 text-gray-400' : 'bg-gray-200 text-gray-600'}`}>
               {billingInfo?.billingProvider === 'stripe' && billingInfo?.activeSubscription 
                 ? 'Billed through Stripe' 
                 : billingInfo?.billingProvider === 'mindbody' 
                   ? 'Synced from Mindbody' 
                   : 'Database Record'}
             </span>
          )}
        </div>
      )}
      <p className={`text-xs mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        Manually updating this will give the member app permissions immediately. It does not automatically update billing in Mindbody.
      </p>
    </div>
  );
}
