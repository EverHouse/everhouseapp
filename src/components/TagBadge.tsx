import React from 'react';
import { getTagColor } from '../utils/tierUtils';

interface TagBadgeProps {
  tag: string;
  size?: 'sm' | 'md';
}

const TagBadge: React.FC<TagBadgeProps> = ({ tag, size = 'sm' }) => {
  const colors = getTagColor(tag);

  const sizeClasses = size === 'sm' 
    ? 'px-1.5 py-0.5 text-[10px]' 
    : 'px-2 py-0.5 text-[11px]';

  return (
    <span
      className={`inline-flex items-center font-medium rounded ${sizeClasses}`}
      style={{
        backgroundColor: colors.bg,
        color: colors.text,
        border: `1px solid ${colors.border}`,
      }}
    >
      {tag}
    </span>
  );
};

export default TagBadge;
