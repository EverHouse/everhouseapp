import React, { Suspense, lazy } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithCredentials } from '../../../hooks/queries/useFetch';
import { AnimatedPage } from '../../../components/motion';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';
import { ChartCardSkeleton, Skeleton, SkeletonCrossfade } from '../../../components/skeletons';
import type { BookingStats, ExtendedStats, MembershipInsights, ActiveMembers, AtRiskMember } from './analyticsTypes';

function formatDuration(minutes: number): string {
  const hrs = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hrs === 0) return `${mins}m`;
  if (mins === 0) return `${hrs}h`;
  return `${hrs}h ${mins}m`;
}

const SectionCard: React.FC<{ icon: string; title: string; subtitle?: string; children: React.ReactNode }> = ({ icon, title, subtitle, children }) => (
  <div className="glass-card rounded-xl p-4 sm:p-5 border border-primary/10 dark:border-white/10">
    <div className="flex items-center gap-2 mb-1">
      <span className="material-symbols-outlined text-lg text-primary/60 dark:text-white/60">{icon}</span>
      <h2 className="text-base sm:text-lg font-semibold text-primary dark:text-white" style={{ fontFamily: 'var(--font-heading)' }}>{title}</h2>
    </div>
    {subtitle && <p className="text-xs text-primary/40 dark:text-white/40 mb-3 ml-7">{subtitle}</p>}
    {!subtitle && <div className="mb-3" />}
    {children}
  </div>
);

const StatCard: React.FC<{
  label: string;
  value: string;
  subtitle?: string;
  icon: string;
  accentColor?: string;
}> = ({ label, value, subtitle, icon, accentColor = '#6366f1' }) => (
  <div className="glass-card rounded-xl p-4 flex items-start gap-3 border border-primary/10 dark:border-white/10">
    <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
      <span className="material-symbols-outlined text-xl" style={{ color: accentColor }}>{icon}</span>
    </div>
    <div className="min-w-0">
      <div className="text-[11px] text-primary/50 dark:text-white/50 uppercase tracking-wider mb-0.5">{label}</div>
      <div className="text-2xl font-semibold text-primary dark:text-white" style={{ fontFamily: 'var(--font-heading)' }}>{value}</div>
      {subtitle && <div className="text-xs text-primary/40 dark:text-white/40 mt-0.5">{subtitle}</div>}
    </div>
  </div>
);

const ActiveMembersCard: React.FC<{ data: ActiveMembers }> = ({ data }) => {
  const periods = [
    { label: '30 days', active: data.active30 },
    { label: '60 days', active: data.active60 },
    { label: '90 days', active: data.active90 },
  ];

  return (
    <div className="space-y-4">
      <div className="text-center">
        <div className="text-3xl font-semibold text-primary dark:text-white" style={{ fontFamily: 'var(--font-heading)' }}>
          {data.totalActiveMembers}
        </div>
        <div className="text-xs text-primary/50 dark:text-white/50 uppercase tracking-wider mt-1">Total Active Members</div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {periods.map(({ label, active }) => {
          const pct = data.totalActiveMembers > 0 ? Math.round((active / data.totalActiveMembers) * 100) : 0;
          return (
            <div key={label} className="text-center">
              <div className="relative w-16 h-16 mx-auto">
                <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                  <circle cx="18" cy="18" r="15.9" fill="none" strokeWidth="3" className="stroke-primary/10 dark:stroke-white/10" />
                  <circle
                    cx="18" cy="18" r="15.9" fill="none" strokeWidth="3"
                    strokeDasharray={`${pct} ${100 - pct}`}
                    strokeLinecap="round"
                    stroke="#6366f1"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-primary dark:text-white">
                  {pct}%
                </div>
              </div>
              <div className="text-lg font-semibold text-primary dark:text-white mt-1">{active}</div>
              <div className="text-[10px] text-primary/50 dark:text-white/50 uppercase tracking-wider">{label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const AtRiskMembersList: React.FC<{ data: AtRiskMember[] }> = ({ data }) => {
  if (!data.length) return <p className="text-primary/40 dark:text-white/40 text-sm text-center py-8">No at-risk members found.</p>;
  return (
    <div className="space-y-1 max-h-[300px] overflow-y-auto">
      {data.map((member) => {
        const daysSince = member.lastBookingDate
          // eslint-disable-next-line react-hooks/purity
          ? Math.floor((Date.now() - new Date(member.lastBookingDate).getTime()) / (1000 * 60 * 60 * 24))
          : null;
        return (
          <div key={member.id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-primary/5 dark:hover:bg-white/5 transition-colors">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-primary dark:text-white truncate">{member.name}</p>
              <p className="text-xs text-primary/50 dark:text-white/50 truncate">{member.tier}</p>
            </div>
            <div className="text-right flex-shrink-0 ml-3">
              {daysSince !== null ? (
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${daysSince > 90 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                  {daysSince}d ago
                </span>
              ) : (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                  Never booked
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const ChartFallback = () => (
  <div className="w-full h-[220px] flex items-center justify-center">
    <div className="w-5 h-5 border-2 border-primary/20 border-t-primary/60 rounded-full animate-spin" />
  </div>
);

const LazyPeakHoursHeatmap = lazy(() =>
  import('./AnalyticsChartsSection').then(mod => ({ default: mod.PeakHoursHeatmap }))
);
const LazyResourceUtilizationChart = lazy(() =>
  import('./AnalyticsChartsSection').then(mod => ({ default: mod.ResourceUtilizationChart }))
);
const LazyTopMembersLeaderboard = lazy(() =>
  import('./AnalyticsChartsSection').then(mod => ({ default: mod.TopMembersLeaderboard }))
);
const LazyBookingFrequencyChart = lazy(() =>
  import('./AnalyticsChartsSection').then(mod => ({ default: mod.BookingFrequencyChart }))
);
const LazyRevenueChart = lazy(() =>
  import('./AnalyticsChartsSection').then(mod => ({ default: mod.RevenueChart }))
);
const LazyBookingsOverTimeChart = lazy(() =>
  import('./AnalyticsChartsSection').then(mod => ({ default: mod.BookingsOverTimeChart }))
);
const LazyDayOfWeekChart = lazy(() =>
  import('./AnalyticsChartsSection').then(mod => ({ default: mod.DayOfWeekChart }))
);
const LazyUtilizationChart = lazy(() =>
  import('./AnalyticsChartsSection').then(mod => ({ default: mod.UtilizationChart }))
);
const LazyTierDistributionChart = lazy(() =>
  import('./AnalyticsChartsSection').then(mod => ({ default: mod.TierDistributionChart }))
);
const LazyNewMemberGrowthChart = lazy(() =>
  import('./AnalyticsChartsSection').then(mod => ({ default: mod.NewMemberGrowthChart }))
);

const AnalyticsTab: React.FC = () => {
  const { data, isLoading, error } = useQuery<BookingStats>({
    queryKey: ['booking-analytics'],
    queryFn: () => fetchWithCredentials<BookingStats>('/api/analytics/booking-stats'),
    staleTime: 5 * 60 * 1000,
  });

  const { data: extData, isLoading: extLoading } = useQuery<ExtendedStats>({
    queryKey: ['extended-analytics'],
    queryFn: () => fetchWithCredentials<ExtendedStats>('/api/analytics/extended-stats'),
    staleTime: 5 * 60 * 1000,
  });

  const { data: memberData, isLoading: memberLoading } = useQuery<MembershipInsights>({
    queryKey: ['membership-insights'],
    queryFn: () => fetchWithCredentials<MembershipInsights>('/api/analytics/membership-insights'),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <WalkingGolferSpinner />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center min-h-[400px] text-primary/50 dark:text-white/50">
        <div className="text-center">
          <span className="material-symbols-outlined text-4xl mb-2 block">error_outline</span>
          <p>Failed to load analytics data.</p>
        </div>
      </div>
    );
  }

  return (
    <AnimatedPage>
      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-primary dark:text-white" style={{ fontFamily: 'var(--font-heading)' }}>Booking Analytics</h1>
          <p className="text-sm text-primary/50 dark:text-white/50 mt-1">Insights from your booking history</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          <StatCard
            label="Total Bookings"
            value={data.totalBookings.toLocaleString()}
            icon="calendar_today"
            accentColor="#6366f1"
          />
          <StatCard
            label="Cancellation Rate"
            value={`${data.cancellationRate}%`}
            subtitle={`${data.cancelledBookings} of ${data.totalBookings} cancelled`}
            icon="event_busy"
            accentColor={data.cancellationRate > 20 ? '#ef4444' : data.cancellationRate > 10 ? '#f59e0b' : '#22c55e'}
          />
          <StatCard
            label="Avg Session Length"
            value={formatDuration(data.avgSessionMinutes)}
            subtitle={`${data.avgSessionMinutes} minutes`}
            icon="timer"
            accentColor="#8b5cf6"
          />
        </div>

        <SkeletonCrossfade
          loading={extLoading}
          skeleton={
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
              <ChartCardSkeleton />
              <ChartCardSkeleton />
            </div>
          }
        >
          {extData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
              <SectionCard icon="trending_up" title="Bookings Over Time" subtitle="Weekly booking volume (last 6 months)">
                <Suspense fallback={<ChartFallback />}>
                  <LazyBookingsOverTimeChart data={extData.bookingsOverTime} />
                </Suspense>
              </SectionCard>
              <SectionCard icon="attach_money" title="Revenue Over Time" subtitle="Live Stripe data by category (last 6 months)">
                <Suspense fallback={<ChartFallback />}>
                  <LazyRevenueChart data={extData.revenueOverTime} />
                </Suspense>
              </SectionCard>
            </div>
          )}
        </SkeletonCrossfade>

        <SectionCard icon="local_fire_department" title="Weekly Peak Hours">
          <Suspense fallback={<ChartFallback />}>
            <LazyPeakHoursHeatmap data={data.peakHours} />
          </Suspense>
        </SectionCard>

        <SkeletonCrossfade
          loading={extLoading}
          skeleton={
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
              <ChartCardSkeleton />
              <ChartCardSkeleton />
            </div>
          }
        >
          {extData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
              <SectionCard icon="date_range" title="Day of Week" subtitle="All-time booking distribution by weekday">
                <Suspense fallback={<ChartFallback />}>
                  <LazyDayOfWeekChart data={extData.dayOfWeekBreakdown} />
                </Suspense>
              </SectionCard>
              <SectionCard icon="speed" title="Utilization by Hour" subtitle="Average simulator utilization per time slot">
                <Suspense fallback={<ChartFallback />}>
                  <LazyUtilizationChart data={extData.utilizationByHour} />
                </Suspense>
              </SectionCard>
            </div>
          )}
        </SkeletonCrossfade>

        <SkeletonCrossfade
          loading={extLoading}
          skeleton={
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
              <ChartCardSkeleton />
              <ChartCardSkeleton />
            </div>
          }
        >
          {extData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
              <SectionCard icon="group" title="Member Activity" subtitle="Unique members who booked within each window">
                <ActiveMembersCard data={extData.activeMembers} />
              </SectionCard>
              <SectionCard icon="bar_chart" title="Booking Frequency" subtitle="How often members book (last 90 days)">
                <Suspense fallback={<ChartFallback />}>
                  <LazyBookingFrequencyChart data={extData.bookingFrequency} />
                </Suspense>
              </SectionCard>
            </div>
          )}
        </SkeletonCrossfade>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          <SectionCard icon="sports_golf" title="Resource Utilization" subtitle="Total hours booked per resource">
            <Suspense fallback={<ChartFallback />}>
              <LazyResourceUtilizationChart data={data.resourceUtilization} />
            </Suspense>
          </SectionCard>
          <SectionCard icon="emoji_events" title="Top Members" subtitle="By total hours booked">
            <Suspense fallback={<ChartFallback />}>
              <LazyTopMembersLeaderboard data={data.topMembers} />
            </Suspense>
          </SectionCard>
        </div>

        <SkeletonCrossfade
          loading={memberLoading}
          className="space-y-4 sm:space-y-6"
          skeleton={
            <>
              <div>
                <Skeleton variant="text" width={192} height={28} className="rounded mt-2" />
                <Skeleton variant="text" width={256} height={16} className="rounded mt-2" />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                <ChartCardSkeleton />
                <ChartCardSkeleton />
              </div>
              <ChartCardSkeleton />
            </>
          }
        >
          {memberData && (
            <>
              <div>
                <h2 className="text-lg sm:text-xl font-semibold text-primary dark:text-white mt-2" style={{ fontFamily: 'var(--font-heading)' }}>Membership Insights</h2>
                <p className="text-sm text-primary/50 dark:text-white/50 mt-1">Member composition, engagement, and growth</p>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                <SectionCard icon="pie_chart" title="Tier Distribution" subtitle="Active members by membership tier">
                  <Suspense fallback={<ChartFallback />}>
                    <LazyTierDistributionChart data={memberData.tierDistribution} />
                  </Suspense>
                </SectionCard>
                <SectionCard icon="person_alert" title="At-Risk Members" subtitle="No bookings in the last 45 days">
                  <AtRiskMembersList data={memberData.atRiskMembers} />
                </SectionCard>
              </div>
              <SectionCard icon="trending_up" title="Membership Trends" subtitle="New vs. former members over the last 6 months">
                <Suspense fallback={<ChartFallback />}>
                  <LazyNewMemberGrowthChart data={memberData.newMemberGrowth} />
                </Suspense>
              </SectionCard>
            </>
          )}
        </SkeletonCrossfade>
      </div>
    </AnimatedPage>
  );
};

export default AnalyticsTab;
