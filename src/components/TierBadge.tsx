import React from 'react';
import { getTierColor, getDisplayTier } from '../utils/tierUtils';

interface TierBadgeProps {
  tier: string | null | undefined;
  size?: 'sm' | 'md';
  showNoTier?: boolean;
}

const TierBadge: React.FC<TierBadgeProps> = ({ tier, size = 'sm', showNoTier = false }) => {
  const sizeClasses = size === 'sm' 
    ? 'px-2 py-0.5 text-[11px]' 
    : 'px-3 py-1 text-xs';

  if (!tier || tier.trim() === '') {
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
