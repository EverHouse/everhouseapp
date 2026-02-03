import React from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { getTodayString } from '../utils/dateUtils';
import AnimatedCounter from './AnimatedCounter';

interface NextItem {
  title: string;
  date: string;
}

interface MetricsGridProps {
  simulatorMinutesUsed: number;
  simulatorMinutesAllowed: number;
  conferenceMinutesUsed: number;
  conferenceMinutesAllowed: number;
  nextWellnessClass?: NextItem;
  nextEvent?: NextItem;
  onNavigate: (path: string) => void;
  className?: string;
}

interface MetricCardProps {
  icon: string;
  label: string;
  value: React.ReactNode;
  subtext?: string;
  isDark: boolean;
  onClick: () => void;
  ariaLabel: string;
}

const MetricCard: React.FC<MetricCardProps> = React.memo(({ icon, label, value, subtext, isDark, onClick, ariaLabel }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={ariaLabel}
    className={`flex flex-col items-start p-4 rounded-2xl backdrop-blur-xl border transition-transform active:scale-95 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
      isDark 
        ? 'bg-white/10 border-white/20 hover:bg-white/15' 
        : 'bg-white/30 border-white/20 hover:bg-white/40'
    }`}
  >
    <span 
      className={`material-symbols-outlined text-2xl mb-2 ${isDark ? 'text-accent' : 'text-brand-green'}`}
      aria-hidden="true"
    >
      {icon}
    </span>
    <div className={`text-xs font-medium uppercase tracking-wide ${isDark ? 'text-white/60' : 'text-brand-green/60'}`}>
      {label}
    </div>
    <div className={`text-lg font-bold mt-0.5 leading-tight text-left ${isDark ? 'text-white' : 'text-brand-green'}`}>
      {value}
    </div>
    {subtext && (
      <div className={`text-xs mt-0.5 ${isDark ? 'text-white/50' : 'text-brand-green/50'}`}>
        {subtext}
      </div>
    )}
  </button>
));

const formatMinutesUsage = (used: number, allowed: number): { value: string; subtext: string } => {
  if (allowed === 999) {
    return {
      value: used > 0 ? `${used} min` : '0 min',
      subtext: 'used today'
    };
  }
  
  return {
    value: `${used}/${allowed} min`,
    subtext: 'used today'
  };
};

const formatCountdown = (dateStr: string): string => {
  const todayStr = getTodayString();
  const targetStr = dateStr.split('T')[0];
  
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const [ey, em, ed] = targetStr.split('-').map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const targetMs = Date.UTC(ey, em - 1, ed);
  const diffDays = Math.round((targetMs - todayMs) / (1000 * 60 * 60 * 24));
  
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays < 7) return `in ${diffDays} days`;
  if (diffDays < 14) return 'in 1 week';
  return `in ${Math.floor(diffDays / 7)} weeks`;
};

const truncateTitle = (title: string, maxLength: number = 18): string => {
  if (title.length <= maxLength) return title;
  return title.substring(0, maxLength - 1) + '…';
};

const MetricsGrid: React.FC<MetricsGridProps> = React.memo(({
  simulatorMinutesUsed,
  simulatorMinutesAllowed,
  conferenceMinutesUsed,
  conferenceMinutesAllowed,
  nextWellnessClass,
  nextEvent,
  onNavigate,
  className
}) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  const simUsage = formatMinutesUsage(simulatorMinutesUsed, simulatorMinutesAllowed);
  const confUsage = formatMinutesUsage(conferenceMinutesUsed, conferenceMinutesAllowed);

  const wellnessValue = nextWellnessClass 
    ? truncateTitle(nextWellnessClass.title)
    : 'None scheduled';
  const wellnessSubtext = nextWellnessClass 
    ? formatCountdown(nextWellnessClass.date)
    : undefined;

  const eventValue = nextEvent 
    ? truncateTitle(nextEvent.title)
    : 'None scheduled';
  const eventSubtext = nextEvent 
    ? formatCountdown(nextEvent.date)
    : undefined;

  const renderMinutesValue = (used: number, allowed: number) => {
    if (allowed === 999) {
      return (
        <>
          <AnimatedCounter value={used} /> min
        </>
      );
    }
    return (
      <>
        <AnimatedCounter value={used} />/{allowed} min
      </>
    );
  };

  return (
    <div className={`grid grid-cols-2 gap-3 ${className || ''}`}>
      <MetricCard
        icon="sports_golf"
        label="Golf Sims"
        value={renderMinutesValue(simulatorMinutesUsed, simulatorMinutesAllowed)}
        subtext={simUsage.subtext}
        isDark={isDark}
        onClick={() => onNavigate('/book')}
        ariaLabel={`Golf Simulators: ${simUsage.value} ${simUsage.subtext}. Tap to book.`}
      />
      <MetricCard
        icon="meeting_room"
        label="Conference Room"
        value={renderMinutesValue(conferenceMinutesUsed, conferenceMinutesAllowed)}
        subtext={confUsage.subtext}
        isDark={isDark}
        onClick={() => onNavigate('/book?tab=conference')}
        ariaLabel={`Conference Room: ${confUsage.value} ${confUsage.subtext}. Tap to book.`}
      />
      <MetricCard
        icon="self_improvement"
        label="Next Wellness"
        value={wellnessValue}
        subtext={wellnessSubtext}
        isDark={isDark}
        onClick={() => onNavigate('/member-wellness')}
        ariaLabel={`Next Wellness: ${wellnessValue}${wellnessSubtext ? `, ${wellnessSubtext}` : ''}. Tap to view.`}
      />
      <MetricCard
        icon="celebration"
        label="Next Events"
        value={eventValue}
        subtext={eventSubtext}
        isDark={isDark}
        onClick={() => onNavigate('/member-events')}
        ariaLabel={`Next Events: ${eventValue}${eventSubtext ? `, ${eventSubtext}` : ''}. Tap to view.`}
      />
    </div>
  );
});

export default MetricsGrid;
