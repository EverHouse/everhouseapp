import React from 'react';

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  variant?: 'default' | 'compact';
}

const EmptyState: React.FC<EmptyStateProps> = ({
  icon = 'inbox',
  title,
  description,
  action,
  variant = 'default'
}) => {
  const isCompact = variant === 'compact';

  return (
    <div className={`flex flex-col items-center justify-center text-center ${isCompact ? 'py-8 px-4' : 'py-16 px-6'} animate-pop-in`}>
      <div className={`relative ${isCompact ? 'mb-3' : 'mb-6'}`}>
        <div className={`${isCompact ? 'w-16 h-16' : 'w-24 h-24'} rounded-full bg-gradient-to-br from-brand-bone to-secondary flex items-center justify-center relative`}>
          <div className="absolute inset-0 rounded-full bg-gradient-to-br from-primary/5 to-accent/10 animate-pulse" style={{ animationDuration: '3s' }} />
          <span className={`material-symbols-outlined ${isCompact ? 'text-3xl' : 'text-5xl'} text-primary/70 dark:text-primary`} aria-hidden="true">
            {icon}
          </span>
        </div>
        <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-accent/30 animate-bounce" style={{ animationDelay: '0.5s', animationDuration: '2s' }} />
        <div className="absolute -bottom-2 -left-2 w-3 h-3 rounded-full bg-primary/20 animate-bounce" style={{ animationDelay: '1s', animationDuration: '2.5s' }} />
      </div>

      <h3 className={`${isCompact ? 'text-base' : 'text-xl'} font-semibold text-primary dark:text-white mb-2`}>
        {title}
      </h3>

      {description && (
        <p className={`${isCompact ? 'text-xs' : 'text-sm'} text-primary/80 dark:text-white/80 max-w-[280px] mb-4`}>
          {description}
        </p>
      )}

      {action && (
        <button
          onClick={action.onClick}
          className={`
            inline-flex items-center gap-2 
            ${isCompact ? 'px-4 py-2 text-sm' : 'px-6 py-3 text-base'}
            bg-primary dark:bg-accent 
            text-white dark:text-brand-green 
            rounded-2xl font-semibold 
            hover:scale-[1.02] active:scale-[0.98] 
            transition-all duration-300
            shadow-lg hover:shadow-xl
          `}
        >
          <span className="material-symbols-outlined text-lg" aria-hidden="true">add</span>
          {action.label}
        </button>
      )}
    </div>
  );
};

export const EmptyBookings: React.FC<{ onBook?: () => void }> = ({ onBook }) => (
  <EmptyState
    icon="calendar_month"
    title="No upcoming bookings"
    description="Book a simulator session or conference room to see your reservations here."
    action={onBook ? { label: "Book Now", onClick: onBook } : undefined}
  />
);

export const EmptyEvents: React.FC<{ onExplore?: () => void; message?: string }> = ({ onExplore, message }) => (
  <EmptyState
    icon="celebration"
    title="No events found"
    description={message || "Check back soon for upcoming events and experiences at Ever Club."}
    action={onExplore ? { label: "Explore Events", onClick: onExplore } : undefined}
  />
);

export const EmptySearch: React.FC<{ query?: string }> = ({ query }) => (
  <EmptyState
    icon="search_off"
    title="No results found"
    description={query ? `We couldn't find anything matching "${query}". Try a different search.` : "Try adjusting your filters or search terms."}
    variant="compact"
  />
);

export const EmptyNotifications: React.FC = () => (
  <EmptyState
    icon="notifications_none"
    title="All caught up!"
    description="You have no new notifications."
    variant="compact"
  />
);

export default EmptyState;
