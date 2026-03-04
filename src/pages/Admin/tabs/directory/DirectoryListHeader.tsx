import React from 'react';
import type { SortField } from './directoryTypes';

interface SortableHeaderProps {
    field: SortField;
    label: string;
    className?: string;
    width: string;
    currentSortField: SortField;
    onSort: (field: SortField) => void;
    getSortIcon: (field: SortField) => string;
}

const SortableHeader: React.FC<SortableHeaderProps> = ({ field, label, className = '', width, currentSortField, onSort, getSortIcon }) => (
    <div 
        className={`px-3 flex items-center self-stretch overflow-hidden font-semibold text-gray-600 dark:text-gray-300 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-white/10 transition-colors select-none tactile-btn ${className}`}
        style={{ width, minWidth: 0, minHeight: '44px' }}
        role="button"
        tabIndex={0}
        onClick={() => onSort(field)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(field); } }}
    >
        <div className="flex items-center gap-1 truncate">
            <span className="truncate">{label}</span>
            <span className={`material-symbols-outlined text-[16px] shrink-0 ${currentSortField === field ? 'text-[#293515] dark:!text-[#CCB8E4]' : 'text-gray-400'}`}>
                {getSortIcon(field)}
            </span>
        </div>
    </div>
);

export default SortableHeader;
