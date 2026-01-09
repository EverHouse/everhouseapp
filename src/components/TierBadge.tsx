import React from 'react';
import { getTierColor, getDisplayTier } from '../utils/tierUtils';

interface TierBadgeProps {
  tier: string;
  size?: 'sm' | 'md';
}

const TierBadge: React.FC<TierBadgeProps> = ({ tier, size = 'sm' }) => {
  const displayTier = getDisplayTier(tier);
  const colors = getTierColor(tier);

  const sizeClasses = size === 'sm' 
    ? 'px-2 py-0.5 text-[11px]' 
    : 'px-3 py-1 text-xs';

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
