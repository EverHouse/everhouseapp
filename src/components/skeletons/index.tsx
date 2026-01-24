import React, { useState, useEffect } from 'react';

interface SkeletonCardProps {
  className?: string;
  isDark?: boolean;
}

interface SkeletonCrossfadeProps {
  loading: boolean;
  skeleton: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  duration?: number;
}

export const SkeletonCrossfade: React.FC<SkeletonCrossfadeProps> = ({ 
  loading, 
  skeleton, 
  children, 
  className = '',
  duration = 250
}) => {
  const [showSkeleton, setShowSkeleton] = useState(loading);
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    if (!loading && showSkeleton) {
      setIsTransitioning(true);
      const timer = setTimeout(() => {
        setShowSkeleton(false);
        setIsTransitioning(false);
      }, duration);
      return () => clearTimeout(timer);
    } else if (loading) {
      setShowSkeleton(true);
    }
  }, [loading, showSkeleton, duration]);

  if (showSkeleton) {
    return (
      <div className={`${className} ${isTransitioning ? 'animate-skeleton-out' : ''}`}>
        {skeleton}
      </div>
    );
  }

  return (
    <div className={`animate-content-in ${className}`}>
      {children}
    </div>
  );
};

const shimmerClass = "relative overflow-hidden before:content-[''] before:absolute before:inset-0 before:bg-[repeating-linear-gradient(90deg,transparent_0%,transparent_30%,rgba(255,255,255,0.3)_50%,transparent_70%,transparent_100%)] before:bg-[length:200%_100%] before:bg-repeat before:animate-[shimmer_2s_linear_infinite]";
const bgLight = "bg-gray-200";
const bgDark = "bg-white/10";
const bgAuto = "bg-gray-200 dark:bg-white/10";

export const EventCardSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className="rounded-2xl overflow-hidden min-h-[240px] bg-white dark:bg-white/5 shadow-sm">
      <div className={`${shimmerClass} ${bg} h-36 w-full`} />
      <div className="p-4 space-y-3">
        <div className={`${shimmerClass} ${bg} h-6 w-3/4 rounded`} />
        <div className={`${shimmerClass} ${bg} h-4 w-1/2 rounded`} />
        <div className="flex gap-2 pt-2">
          <div className={`${shimmerClass} ${bg} h-7 w-16 rounded-full`} />
          <div className={`${shimmerClass} ${bg} h-7 w-20 rounded-full`} />
        </div>
      </div>
    </div>
  );
};

export const BookingCardSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className="flex items-center gap-4 p-4 rounded-2xl min-h-[88px] bg-white dark:bg-white/5 shadow-sm">
      <div className={`${shimmerClass} ${bg} w-14 h-14 rounded-2xl flex-shrink-0`} />
      <div className="flex-1 space-y-2.5">
        <div className={`${shimmerClass} ${bg} h-5 w-3/4 rounded`} />
        <div className={`${shimmerClass} ${bg} h-4 w-1/2 rounded`} />
      </div>
      <div className={`${shimmerClass} ${bg} w-10 h-10 rounded-full`} />
    </div>
  );
};

export const MenuItemSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className="flex gap-4 p-3 rounded-xl bg-white dark:bg-white/5 shadow-sm">
      <div className={`${shimmerClass} ${bg} w-14 h-14 rounded-lg flex-shrink-0`} />
      <div className="flex-1 space-y-2 py-1">
        <div className={`${shimmerClass} ${bg} h-5 w-3/4 rounded`} />
        <div className={`${shimmerClass} ${bg} h-4 w-1/2 rounded`} />
      </div>
      <div className={`${shimmerClass} ${bg} h-5 w-12 rounded self-center`} />
    </div>
  );
};

export const DashboardCardSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className="p-4 rounded-2xl bg-white dark:bg-white/5 shadow-sm space-y-3">
      <div className="flex items-center gap-3">
        <div className={`${shimmerClass} ${bg} w-10 h-10 rounded-xl`} />
        <div className="flex-1">
          <div className={`${shimmerClass} ${bg} h-5 w-2/3 rounded mb-2`} />
          <div className={`${shimmerClass} ${bg} h-4 w-1/3 rounded`} />
        </div>
      </div>
    </div>
  );
};

export const StatCardSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className="p-4 rounded-2xl bg-white dark:bg-white/5 shadow-sm text-center">
      <div className={`${shimmerClass} ${bg} h-8 w-12 rounded mx-auto mb-2`} />
      <div className={`${shimmerClass} ${bg} h-4 w-16 rounded mx-auto`} />
    </div>
  );
};

export const ProfileSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className={`${shimmerClass} ${bg} w-20 h-20 rounded-full`} />
        <div className="flex-1 space-y-2">
          <div className={`${shimmerClass} ${bg} h-6 w-2/3 rounded`} />
          <div className={`${shimmerClass} ${bg} h-4 w-1/2 rounded`} />
        </div>
      </div>
      <div className={`${shimmerClass} ${bg} h-10 w-full rounded-xl`} />
      <div className={`${shimmerClass} ${bg} h-10 w-full rounded-xl`} />
    </div>
  );
};

export const TimeSlotSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className={`${shimmerClass} ${bg} h-12 w-full rounded-xl`} />
  );
};

export const DateButtonSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className="flex flex-col items-center gap-1 p-3 rounded-xl min-w-[60px] bg-white dark:bg-white/5">
      <div className={`${shimmerClass} ${bg} h-3 w-8 rounded`} />
      <div className={`${shimmerClass} ${bg} h-6 w-6 rounded-full`} />
      <div className={`${shimmerClass} ${bg} h-3 w-10 rounded`} />
    </div>
  );
};

export const TabButtonSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className={`${shimmerClass} ${bg} h-10 w-24 rounded-lg`} />
  );
};

export const SkeletonList: React.FC<{ 
  count?: number; 
  Component: React.FC<SkeletonCardProps>;
  isDark?: boolean;
  className?: string;
}> = ({ count = 3, Component, isDark = false, className = "space-y-3" }) => (
  <div className={className}>
    {Array.from({ length: count }).map((_, i) => (
      <Component key={i} isDark={isDark} />
    ))}
  </div>
);

export const DashboardSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div 
      className="px-6 pb-32 min-h-screen bg-transparent"
      style={{ marginTop: 'calc(-1 * var(--header-offset))', paddingTop: 'calc(var(--header-offset) + 1rem)' }}
    >
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <div className={`${shimmerClass} ${bg} h-9 w-48 rounded-lg`} />
          <div className={`${shimmerClass} ${bg} h-5 w-12 rounded-full`} />
        </div>
        <div className={`${shimmerClass} ${bg} h-5 w-40 rounded mt-2`} />
      </div>

      <div className="mb-6 p-5 rounded-3xl backdrop-blur-xl border shadow-lg shadow-black/5 bg-white/10 border-white/20">
        <div className="flex items-center gap-4">
          <div className={`${shimmerClass} ${bg} w-14 h-14 rounded-2xl`} />
          <div>
            <div className={`${shimmerClass} ${bg} h-8 w-16 rounded mb-2`} />
            <div className={`${shimmerClass} ${bg} h-4 w-24 rounded`} />
          </div>
        </div>
        <div className={`${shimmerClass} ${bg} h-4 w-32 rounded mt-4 pt-3`} />
      </div>

      <div className="mb-8 rounded-3xl p-6 bg-[#E7E7DC] dark:bg-white/5">
        <div className={`${shimmerClass} ${bg} h-5 w-16 rounded-full mb-3`} />
        <div className={`${shimmerClass} ${bg} h-7 w-3/4 rounded mb-2`} />
        <div className={`${shimmerClass} ${bg} h-5 w-1/3 rounded mb-1`} />
        <div className={`${shimmerClass} ${bg} h-5 w-1/2 rounded mb-6`} />
        <div className={`${shimmerClass} ${bg} h-12 w-full rounded-xl`} />
      </div>

      <div>
        <div className={`${shimmerClass} ${bg} h-4 w-20 rounded mb-4 mx-1`} />
        <div className="space-y-3">
          <BookingCardSkeleton isDark={isDark} />
          <BookingCardSkeleton isDark={isDark} />
          <BookingCardSkeleton isDark={isDark} />
        </div>
      </div>
    </div>
  );
};

export const MemberRowSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className="p-4 rounded-xl min-h-[142px] bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10">
      <div className="flex justify-between items-start mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <div className={`${shimmerClass} ${bg} h-6 w-36 rounded`} />
            <div className={`${shimmerClass} ${bg} h-5 w-16 rounded-full`} />
          </div>
          <div className={`${shimmerClass} ${bg} h-3.5 w-44 rounded mt-2`} />
          <div className={`${shimmerClass} ${bg} h-3.5 w-32 rounded mt-1.5`} />
        </div>
        <div className="text-right space-y-1">
          <div className={`${shimmerClass} ${bg} h-3.5 w-16 rounded`} />
          <div className={`${shimmerClass} ${bg} h-3.5 w-20 rounded`} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-gray-100 dark:border-white/10">
        <div className="flex items-center gap-1.5">
          <div className={`${shimmerClass} ${bg} h-6 w-16 rounded-full`} />
          <div className={`${shimmerClass} ${bg} h-6 w-20 rounded-full`} />
        </div>
        <div className={`${shimmerClass} ${bg} h-7 w-16 rounded-lg`} />
      </div>
    </div>
  );
};

export const DirectoryTabSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  return (
    <div className="space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <MemberRowSkeleton key={i} isDark={isDark} />
      ))}
    </div>
  );
};

export const CommandCenterCardSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className={`rounded-2xl p-4 bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 border`}>
      <div className="flex items-center justify-between mb-4">
        <div className={`${shimmerClass} ${bg} h-5 w-32 rounded`} />
        <div className={`${shimmerClass} ${bg} h-4 w-20 rounded`} />
      </div>
      <div className="space-y-3">
        <div className={`${shimmerClass} ${bg} h-16 w-full rounded-xl`} />
        <div className={`${shimmerClass} ${bg} h-16 w-full rounded-xl`} />
      </div>
    </div>
  );
};

export const StaffCommandCenterSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className="pb-40 space-y-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className={`${shimmerClass} ${bg} h-7 w-48 rounded-lg`} />
          <div className={`${shimmerClass} ${bg} h-4 w-32 rounded mt-2`} />
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className={`${shimmerClass} ${bg} h-4 w-24 rounded`} />
          <div className={`${shimmerClass} ${bg} h-5 w-20 rounded-full`} />
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        <CommandCenterCardSkeleton isDark={isDark} />
        <CommandCenterCardSkeleton isDark={isDark} />
        <CommandCenterCardSkeleton isDark={isDark} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        <CommandCenterCardSkeleton isDark={isDark} />
        <CommandCenterCardSkeleton isDark={isDark} />
        <CommandCenterCardSkeleton isDark={isDark} />
      </div>
    </div>
  );
};

export const BookGolfSkeleton: React.FC<SkeletonCardProps> = ({ isDark = false }) => {
  const bg = isDark ? bgDark : bgAuto;
  return (
    <div className="px-6 pb-32 space-y-6">
      <section className="pt-4">
        <div className={`${shimmerClass} ${bg} h-9 w-32 rounded-lg`} />
        <div className={`${shimmerClass} ${bg} h-5 w-56 rounded mt-2`} />
      </section>

      <section className="rounded-2xl p-4 border bg-white/50 dark:bg-white/5 border-gray-200 dark:border-white/20">
        <div className={`${shimmerClass} ${bg} h-4 w-32 rounded mb-3`} />
        <div className="flex gap-3 overflow-x-auto py-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <DateButtonSkeleton key={i} isDark={isDark} />
          ))}
        </div>
        <div className="flex gap-2 mt-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`${shimmerClass} ${bg} h-10 flex-1 rounded-lg`} />
          ))}
        </div>
      </section>

      <section className="rounded-2xl p-4 border bg-white/50 dark:bg-white/5 border-gray-200 dark:border-white/20">
        <div className={`${shimmerClass} ${bg} h-4 w-40 rounded mb-4`} />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`${shimmerClass} ${bg} h-14 w-full rounded-xl`} />
          ))}
        </div>
      </section>
    </div>
  );
};
