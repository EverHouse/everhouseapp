import React from 'react';
import { useTheme } from '../contexts/ThemeContext';

interface MetadataChip {
  icon: string;
  label: string;
}

interface Action {
  icon: string;
  label: string;
  onClick: () => void;
}

interface ScheduleCardProps {
  status?: string;
  statusColor?: string;
  icon: string;
  title: string;
  dateTime: string;
  metadata?: MetadataChip[];
  actions?: Action[];
  staggerIndex?: number;
  onClick?: () => void;
  linkedInfo?: string;
}

const ScheduleCard: React.FC<ScheduleCardProps> = ({
  status,
  statusColor,
  icon,
  title,
  dateTime,
  metadata,
  actions,
  staggerIndex,
  onClick,
  linkedInfo,
}) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  return (
    <div
      onClick={onClick}
      {...(onClick ? {
        role: 'button' as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }
      } : {})}
      className={`glass-card p-6 animate-slide-up-stagger ${onClick ? 'tactile-row cursor-pointer card-pressable glass-interactive transition-transform active:scale-[0.98]' : ''}`}
      style={staggerIndex !== undefined ? { '--stagger-index': staggerIndex, animationFillMode: 'both' } as React.CSSProperties : { animationFillMode: 'both' }}
    >
      <div className="flex items-start justify-between mb-4">
        {status && (
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${statusColor || 'bg-green-500'} ring-2 ${isDark ? 'ring-white/10' : 'ring-primary/10'}`} />
            <span className={`text-[11px] font-extrabold uppercase tracking-widest ${isDark ? 'text-white/60' : 'text-primary/50'}`}>
              {status}
            </span>
          </div>
        )}
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ml-auto shrink-0 ${isDark ? 'bg-white/[0.08] ring-1 ring-white/[0.06]' : 'bg-primary/[0.05] ring-1 ring-primary/[0.04]'}`}>
          <span className={`material-symbols-outlined text-[24px] ${isDark ? 'text-white/60' : 'text-primary/60'}`}>{icon}</span>
        </div>
      </div>

      <h4 className={`text-xl font-bold leading-tight mb-1.5 ${isDark ? 'text-white' : 'text-primary'}`} style={{ fontFamily: 'var(--font-headline)', fontOpticalSizing: 'auto' }}>
        {title}
      </h4>

      <p className={`text-[15px] font-semibold mb-1.5 ${isDark ? 'text-accent' : 'text-brand-green'}`}>
        {dateTime}
      </p>

      {linkedInfo && (
        <p className={`text-xs font-medium mb-1.5 flex items-center gap-1 ${isDark ? 'text-purple-300' : 'text-purple-600'}`}>
          <span className="material-symbols-outlined text-[13px]">link</span>
          {linkedInfo}
        </p>
      )}

      {((metadata && metadata.length > 0) || (actions && actions.length > 0)) && (
        <div className={`flex items-center justify-between mt-4 pt-4 border-t ${isDark ? 'border-white/[0.08]' : 'border-primary/[0.06]'}`}>
          {metadata && metadata.length > 0 ? (
            <div className={`flex items-center gap-0 text-[13px] flex-wrap ${isDark ? 'text-white/50' : 'text-primary/45'}`}>
              {metadata.map((chip, idx) => (
                <React.Fragment key={idx}>
                  {idx > 0 && <span className={`mx-2.5 ${isDark ? 'text-white/15' : 'text-primary/15'}`}>|</span>}
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[15px]">{chip.icon}</span>
                    {chip.label}
                  </span>
                </React.Fragment>
              ))}
            </div>
          ) : <div />}
          {actions && actions.length > 0 && (
            <div className="flex gap-2">
              {actions.map((action, idx) => (
                <button
                  key={idx}
                  onClick={(e) => { e.stopPropagation(); action.onClick(); }}
                  className={`w-10 h-10 rounded-[4px] flex items-center justify-center active:scale-90 transition-all duration-150 ${isDark ? 'bg-white/[0.08] text-white/60 hover:text-white hover:bg-white/[0.14]' : 'bg-primary/[0.05] text-primary/50 hover:text-primary hover:bg-primary/[0.1]'}`}
                  aria-label={action.label}
                >
                  <span className="material-symbols-outlined text-[18px]">{action.icon}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ScheduleCard;
