import React from 'react';
import { getTierColor, getDisplayTier } from '../utils/tierUtils';

interface TierBadgeProps {
  tier: string | null | undefined;
  size?: 'sm' | 'md';
  showNoTier?: boolean;
  lastTier?: string | null;
  membershipStatus?: string | null;
}

const TierBadge: React.FC<TierBadgeProps> = ({ tier, size = 'sm', showNoTier = false, lastTier, membershipStatus }) => {
  const sizeClasses = size === 'sm' 
    ? 'px-2 py-0.5 text-[11px]' 
    : 'px-3 py-1 text-xs';

  if (!tier || tier.trim() === '') {
    if (lastTier) {
      const displayLastTier = getDisplayTier(lastTier);
      const statusLabel = membershipStatus 
        ? membershipStatus.charAt(0).toUpperCase() + membershipStatus.slice(1).toLowerCase()
        : null;
      
      return (
        <span className="inline-flex items-center gap-1.5 flex-wrap">
          <span
            className={`inline-flex items-center font-bold rounded ${sizeClasses} bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 border border-gray-200 dark:border-gray-600`}
          >
            No Active Membership
          </span>
          <span className={`text-gray-400 dark:text-gray-500 ${size === 'sm' ? 'text-[10px]' : 'text-xs'}`}>
            (was: {displayLastTier})
          </span>
          {statusLabel && (
            <span className={`inline-flex items-center font-medium rounded ${size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'} bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400`}>
              {statusLabel}
            </span>
          )}
        </span>
      );
    }
    
    if (!showNoTier) return null;
    return (
      <span
        className={`inline-flex items-center font-bold rounded ${sizeClasses} bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 border border-gray-200 dark:border-gray-600`}
      >
        No Tier
      </span>
    );
  }

  const displayTier = getDisplayTier(tier);
  const colors = getTierColor(tier);

  return (
    <span
      className={`inline-flex items-center font-bold rounded ${sizeClasses}`}
      style={{
        backgroundColor: colors.bg,
        color: colors.text,
        border: `1px solid ${colors.border}`,
      }}
    >
      {displayTier}
    </span>
  );
};

export default TierBadge;
