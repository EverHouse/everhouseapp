import React from 'react';
import { getPacificDateParts } from '../../utils/dateUtils';

export const DateBlock: React.FC<{ dateStr: string; today: string }> = ({ dateStr, today }) => {
  const isToday = dateStr === today;
  const date = new Date(dateStr + 'T12:00:00');
  const month = date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  const day = date.getDate();
  
  return (
    <div className={`flex flex-col items-center justify-center min-w-[44px] h-[44px] rounded-lg ${
      isToday 
        ? 'bg-primary/20 dark:bg-[#CCB8E4]/25' 
        : 'bg-primary/10 dark:bg-[#CCB8E4]/20'
    }`}>
      <span className="text-[10px] font-semibold text-primary dark:text-[#CCB8E4] uppercase tracking-wide leading-none">
        {isToday ? 'TODAY' : month}
      </span>
      {!isToday && (
        <span className="text-lg font-bold text-primary dark:text-white leading-none mt-0.5">
          {day}
        </span>
      )}
    </div>
  );
};

export const GlassListRow: React.FC<{ 
  children: React.ReactNode; 
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
}> = ({ children, onClick, className = '', style }) => (
  <div 
    onClick={onClick}
    style={style}
    className={`flex items-center gap-3 p-3 rounded-xl bg-white/30 dark:bg-white/[0.04] backdrop-blur-lg border border-white/50 dark:border-white/[0.06] hover:bg-white/50 dark:hover:bg-white/[0.08] hover:shadow-liquid dark:hover:shadow-liquid-dark transition-colors cursor-pointer ${className}`}
  >
    {children}
  </div>
);

export const getWellnessIcon = (title: string): string => {
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes('yoga')) return 'self_improvement';
  if (lowerTitle.includes('pilates')) return 'fitness_center';
  if (lowerTitle.includes('meditation') || lowerTitle.includes('mindful')) return 'spa';
  if (lowerTitle.includes('stretch') || lowerTitle.includes('mobility')) return 'accessibility_new';
  if (lowerTitle.includes('hiit') || lowerTitle.includes('cardio')) return 'directions_run';
  if (lowerTitle.includes('strength') || lowerTitle.includes('weight')) return 'exercise';
  return 'favorite';
};

export const getEventIcon = (category: string): string => {
  switch (category) {
    case 'Golf': return 'golf_course';
    case 'Tournaments': return 'emoji_events';
    case 'Dining': return 'restaurant';
    case 'Networking': return 'handshake';
    case 'Workshops': return 'school';
    case 'Family': return 'family_restroom';
    case 'Entertainment': return 'music_note';
    case 'Charity': return 'volunteer_activism';
    default: return 'celebration';
  }
};

export const formatTimeLeft = (targetDate: string | Date, targetTime: string): string => {
  if (!targetDate || !targetTime) return 'No upcoming';
  
  const dateStr = typeof targetDate === 'string' 
    ? targetDate.split('T')[0]
    : targetDate.toISOString().split('T')[0];
  
  if (!dateStr || dateStr === 'Invalid Date' || !dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return 'No upcoming';
  }
  
  const [targetHours, targetMinutes] = targetTime.split(':').map(Number);
  if (isNaN(targetHours) || isNaN(targetMinutes)) return 'No upcoming';
  
  const [tYear, tMonth, tDay] = dateStr.split('-').map(Number);
  if (isNaN(tYear) || isNaN(tMonth) || isNaN(tDay)) return 'No upcoming';

  const { year, month, day, hour, minute } = getPacificDateParts();
  
  const nowMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const targetMs = Date.UTC(tYear, tMonth - 1, tDay, targetHours, targetMinutes, 0);
  
  const diff = targetMs - nowMs;
  if (diff <= 0) return 'Now';
  
  const totalMinutes = Math.floor(diff / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  
  const hoursLeft = Math.floor(totalMinutes / 60);
  const minsLeft = totalMinutes % 60;
  if (hoursLeft < 24) return minsLeft > 0 ? `${hoursLeft}h ${minsLeft}m` : `${hoursLeft}h`;
  
  const days = Math.floor(hoursLeft / 24);
  const remainingHours = hoursLeft % 24;
  if (remainingHours > 0) return `${days}d ${remainingHours}h`;
  return `${days}d`;
};

export const formatLastSynced = (lastSynced: Date): string => {
  const parts = getPacificDateParts();
  const nowMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const diff = Math.floor((nowMs - lastSynced.getTime()) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return lastSynced.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
};

export const formatTodayDate = (): string => {
  return new Date().toLocaleDateString('en-US', { 
    timeZone: 'America/Los_Angeles',
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
};

export const EMPLOYEE_RESOURCES_LINKS = [
  { id: 'directory' as const, icon: 'groups', label: 'Member Directory' },
  { id: 'team' as const, icon: 'badge', label: 'Team' },
  { id: 'cafe' as const, icon: 'local_cafe', label: 'Cafe Menu' },
  { id: 'training' as const, icon: 'school', label: 'Training Guide' },
];

export const ADMIN_LINKS = [
  { id: 'gallery' as const, icon: 'photo_library', label: 'Gallery' },
  { id: 'faqs' as const, icon: 'help_outline', label: 'FAQs' },
  { id: 'tiers' as const, icon: 'loyalty', label: 'Stripe Config' },
  { id: 'bugs' as const, icon: 'bug_report', label: 'Bug Reports' },
  { id: 'inquiries' as const, icon: 'mail', label: 'Inquiries' },
  { id: 'applications' as const, icon: 'how_to_reg', label: 'Applications' },
  { id: 'changelog' as const, icon: 'history', label: 'Version History' },
];

export const ADMIN_ROUTE_LINKS = [
  { route: '/admin/data-integrity', icon: 'fact_check', label: 'Data Integrity' },
];
