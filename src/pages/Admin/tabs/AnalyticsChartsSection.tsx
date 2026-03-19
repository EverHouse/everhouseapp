import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Legend,
} from 'recharts';
import type {
  PeakHourEntry,
  ResourceEntry,
  TopMember,
  BookingFrequencyEntry,
  RevenueEntry,
  BookingsOverTimeEntry,
  DayOfWeekEntry,
  UtilizationEntry,
  TierDistributionEntry,
  NewMemberGrowthEntry,
} from './analyticsTypes';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => {
  if (i === 0) return '12a';
  if (i < 12) return `${i}a`;
  if (i === 12) return '12p';
  return `${i - 12}p`;
});

const RESOURCE_COLORS = ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#818cf8'];
const TIER_COLORS = ['#6366f1', '#8b5cf6', '#a78bfa', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#f97316', '#64748b'];

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-bone, #f5f0e8)',
  border: '1px solid rgba(0,0,0,0.1)',
  borderRadius: '8px',
  color: '#1a1a1a',
};

const LEGEND_CLASSES = [
  'bg-primary/5 dark:bg-white/5',
  'bg-indigo-200 dark:bg-indigo-900',
  'bg-indigo-300 dark:bg-indigo-700',
  'bg-indigo-400 dark:bg-indigo-500',
  'bg-indigo-500 dark:bg-indigo-400',
];

function getHeatmapClasses(value: number, max: number): string {
  if (value === 0 || max === 0) return 'bg-primary/5 dark:bg-white/5';
  const intensity = value / max;
  if (intensity < 0.25) return 'bg-indigo-200 dark:bg-indigo-900';
  if (intensity < 0.5) return 'bg-indigo-300 dark:bg-indigo-700';
  if (intensity < 0.75) return 'bg-indigo-400 dark:bg-indigo-500';
  return 'bg-indigo-500 dark:bg-indigo-400';
}

const REVENUE_LABEL_MAP: Record<string, string> = {
  subscription: 'Memberships',
  booking: 'Booking Fees',
  overage: 'Overage',
  guestFee: 'Guest Fees',
  posSale: 'POS Sales',
  accountBalance: 'Account Balance',
  other: 'Other',
};

export const PeakHoursHeatmap: React.FC<{ data: PeakHourEntry[] }> = ({ data }) => {
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let maxCount = 0;

  for (const entry of data) {
    const day = Number(entry.day_of_week);
    const hour = Number(entry.hour_of_day);
    const count = Number(entry.booking_count);
    if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
      grid[day][hour] = count;
      if (count > maxCount) maxCount = count;
    }
  }

  const startHour = 6;
  const endHour = 23;

  return (
    <div className="overflow-x-auto -mx-2 px-2">
      <table className="w-full border-collapse text-xs" style={{ minWidth: '480px' }}>
        <thead>
          <tr>
            <th className="p-1 text-left text-primary/50 dark:text-white/50 font-normal w-10" />
            {HOUR_LABELS.slice(startHour, endHour + 1).map((label) => (
              <th key={label} className="p-0.5 text-center text-primary/50 dark:text-white/50 font-normal">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAY_LABELS.map((day, dayIdx) => (
            <tr key={day}>
              <td className="p-1 text-primary/70 dark:text-white/70 font-medium text-xs">{day}</td>
              {Array.from({ length: endHour - startHour + 1 }, (_, i) => {
                const hour = startHour + i;
                const count = grid[dayIdx][hour];
                return (
                  <td key={hour} className="p-0.5">
                    <div
                      className={`rounded-sm aspect-square flex items-center justify-center text-[10px] transition-colors ${getHeatmapClasses(count, maxCount)} ${count > 0 ? 'text-white font-medium' : ''}`}
                      style={{ minWidth: '22px', minHeight: '22px' }}
                      title={`${day} ${HOUR_LABELS[hour]}: ${count} booking${count !== 1 ? 's' : ''}`}
                    >
                      {count > 0 ? count : ''}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-1.5 mt-3 text-xs text-primary/50 dark:text-white/50">
        <span>Less</span>
        {LEGEND_CLASSES.map((cls, i) => (
          <div key={i} className={`w-3.5 h-3.5 rounded-sm ${cls}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
};

export const ResourceUtilizationChart: React.FC<{ data: ResourceEntry[] }> = ({ data }) => {
  if (data.length === 0) {
    return <p className="text-primary/50 dark:text-white/50 text-sm">No resource data available.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 44)}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 20, top: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} horizontal={false} />
        <XAxis
          type="number"
          tick={{ fill: 'currentColor', fillOpacity: 0.5, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          unit="h"
        />
        <YAxis
          dataKey="resourceName"
          type="category"
          tick={{ fill: 'currentColor', fillOpacity: 0.7, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          width={110}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={((value: number) => [`${value} hours`, 'Total Booked']) as never} />
        <Bar dataKey="totalHours" radius={[0, 6, 6, 0]} maxBarSize={28}>
          {data.map((_, index) => (
            <Cell key={index} fill={RESOURCE_COLORS[index % RESOURCE_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
};

export const TopMembersLeaderboard: React.FC<{ data: TopMember[] }> = ({ data }) => {
  if (data.length === 0) {
    return <p className="text-primary/50 dark:text-white/50 text-sm">No member data available.</p>;
  }

  const maxHours = Math.max(...data.map((m) => m.totalHours), 1);

  return (
    <div className="space-y-3">
      {data.map((member, idx) => (
        <div key={member.memberEmail} className="flex items-center gap-3">
          <div
            className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold"
            style={{
              backgroundColor: idx === 0 ? '#f59e0b' : idx === 1 ? '#94a3b8' : idx === 2 ? '#cd7f32' : 'rgba(128,128,128,0.15)',
              color: idx < 3 ? '#000' : 'inherit',
            }}
          >
            {idx + 1}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-primary/90 dark:text-white/90 font-medium truncate">{member.memberName}</div>
            <div className="relative h-2 mt-1 rounded-full overflow-hidden bg-primary/5 dark:bg-white/10">
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-all"
                style={{
                  width: `${(member.totalHours / maxHours) * 100}%`,
                  backgroundColor: RESOURCE_COLORS[idx % RESOURCE_COLORS.length],
                }}
              />
            </div>
          </div>
          <div className="flex-shrink-0 text-sm text-primary/60 dark:text-white/60 font-mono tabular-nums">{member.totalHours}h</div>
        </div>
      ))}
    </div>
  );
};

export const BookingFrequencyChart: React.FC<{ data: BookingFrequencyEntry[] }> = ({ data }) => {
  if (data.length === 0) {
    return <p className="text-primary/50 dark:text-white/50 text-sm">No booking frequency data available.</p>;
  }

  const BUCKET_ORDER = ['1-2', '3-5', '6-10', '11-20', '20+'];
  const sorted = BUCKET_ORDER.map(b => data.find(d => d.bucket === b) || { bucket: b, memberCount: 0 });

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={sorted} margin={{ left: -10, right: 10, top: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
        <XAxis
          dataKey="bucket"
          tick={{ fill: 'currentColor', fillOpacity: 0.6, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          label={{ value: 'bookings / 90 days', position: 'insideBottom', offset: -2, fill: 'currentColor', fillOpacity: 0.4, fontSize: 10 }}
        />
        <YAxis
          tick={{ fill: 'currentColor', fillOpacity: 0.5, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={((value: number) => [`${value} members`, 'Members']) as never} />
        <Bar dataKey="memberCount" radius={[6, 6, 0, 0]} maxBarSize={40} fill="#8b5cf6" />
      </BarChart>
    </ResponsiveContainer>
  );
};

export const RevenueChart: React.FC<{ data: RevenueEntry[] }> = ({ data }) => {
  if (data.length === 0 || data.every(r => r.totalRevenue === 0)) {
    return <p className="text-primary/50 dark:text-white/50 text-sm">No revenue data available.</p>;
  }

  const chartData = data.map(r => ({
    month: new Date(r.month + '-15T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
    subscription: r.subscriptionRevenue,
    booking: r.bookingRevenue,
    overage: r.overageRevenue,
    guestFee: r.guestFeeRevenue,
    posSale: r.posSaleRevenue,
    accountBalance: r.accountBalanceRevenue,
    other: r.otherRevenue,
    total: r.totalRevenue,
  }));

  const categories = [
    { key: 'subscription', color: '#6366f1' },
    { key: 'booking', color: '#8b5cf6' },
    { key: 'overage', color: '#f59e0b' },
    { key: 'guestFee', color: '#ec4899' },
    { key: 'posSale', color: '#22c55e' },
    { key: 'accountBalance', color: '#06b6d4' },
    { key: 'other', color: '#94a3b8' },
  ];

  const activeCategories = categories.filter(c =>
    chartData.some(d => (d as unknown as Record<string, number>)[c.key] > 0)
  );

  return (
    <div>
      <ResponsiveContainer width="100%" height={250}>
        <AreaChart data={chartData} margin={{ left: -10, right: 10, top: 5, bottom: 5 }}>
          <defs>
            {activeCategories.map(c => (
              <linearGradient key={c.key} id={`grad-${c.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={c.color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={c.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
          <XAxis
            dataKey="month"
            tick={{ fill: 'currentColor', fillOpacity: 0.6, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'currentColor', fillOpacity: 0.5, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v.toLocaleString()}`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={((value: number, name: string) => [`$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, REVENUE_LABEL_MAP[name] || name]) as never}
          />
          {activeCategories.map(c => (
            <Area key={c.key} type="monotone" dataKey={c.key} stroke={c.color} strokeWidth={2} fill={`url(#grad-${c.key})`} stackId="1" />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex items-center justify-center gap-3 sm:gap-4 mt-2 text-xs text-primary/60 dark:text-white/60 flex-wrap">
        {activeCategories.map(c => (
          <span key={c.key} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: c.color }} />
            {REVENUE_LABEL_MAP[c.key]}
          </span>
        ))}
      </div>
    </div>
  );
};

export const BookingsOverTimeChart: React.FC<{ data: BookingsOverTimeEntry[] }> = ({ data }) => {
  if (data.length === 0) {
    return <p className="text-primary/50 dark:text-white/50 text-sm">No trend data available.</p>;
  }

  const chartData = data.map(d => ({
    week: new Date(`${String(d.weekStart).split('T')[0]}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    count: d.bookingCount,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ left: -10, right: 10, top: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
        <XAxis
          dataKey="week"
          tick={{ fill: 'currentColor', fillOpacity: 0.6, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: 'currentColor', fillOpacity: 0.5, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={((value: number) => [`${value} bookings`, 'Weekly Total']) as never} />
        <Line type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={2.5} dot={false} activeDot={{ r: 4, fill: '#6366f1' }} />
      </LineChart>
    </ResponsiveContainer>
  );
};

export const DayOfWeekChart: React.FC<{ data: DayOfWeekEntry[] }> = ({ data }) => {
  if (data.length === 0) {
    return <p className="text-primary/50 dark:text-white/50 text-sm">No day-of-week data available.</p>;
  }

  const allDays = DAY_LABELS.map((label, idx) => {
    const entry = data.find(d => Number(d.dayOfWeek) === idx);
    return { day: label, count: entry ? entry.bookingCount : 0 };
  });

  const maxCount = Math.max(...allDays.map(d => d.count), 1);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={allDays} margin={{ left: -10, right: 10, top: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
        <XAxis
          dataKey="day"
          tick={{ fill: 'currentColor', fillOpacity: 0.6, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: 'currentColor', fillOpacity: 0.5, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={((value: number) => [`${value} bookings`, 'Total']) as never} />
        <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={40}>
          {allDays.map((entry, index) => (
            <Cell key={index} fill={entry.count === maxCount ? '#6366f1' : '#a78bfa'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
};

export const UtilizationChart: React.FC<{ data: UtilizationEntry[] }> = ({ data }) => {
  if (data.length === 0) {
    return <p className="text-primary/50 dark:text-white/50 text-sm">No utilization data available.</p>;
  }

  const chartData = data.map(d => ({
    hour: HOUR_LABELS[d.hourSlot] || `${d.hourSlot}`,
    pct: d.utilizationPct,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} margin={{ left: -10, right: 10, top: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
        <XAxis
          dataKey="hour"
          tick={{ fill: 'currentColor', fillOpacity: 0.6, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: 'currentColor', fillOpacity: 0.5, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          unit="%"
          domain={[0, 100]}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={((value: number) => [`${value}%`, 'Utilization']) as never} />
        <Bar dataKey="pct" radius={[6, 6, 0, 0]} maxBarSize={32}>
          {chartData.map((entry, index) => (
            <Cell key={index} fill={entry.pct >= 75 ? '#ef4444' : entry.pct >= 50 ? '#f59e0b' : entry.pct >= 25 ? '#6366f1' : '#a78bfa'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
};

export const TierDistributionChart: React.FC<{ data: TierDistributionEntry[] }> = ({ data }) => {
  if (!data.length) return <p className="text-primary/40 dark:text-white/40 text-sm text-center py-8">No membership data available.</p>;
  const total = data.reduce((sum, d) => sum + d.memberCount, 0);
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <div className="w-full sm:w-1/2 h-[220px]">
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie
              data={data}
              dataKey="memberCount"
              nameKey="tier"
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={85}
              paddingAngle={2}
              strokeWidth={0}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={TIER_COLORS[i % TIER_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={((value: number, name: string) => [`${value} (${((value / total) * 100).toFixed(1)}%)`, name]) as never} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="w-full sm:w-1/2 space-y-2">
        {data.map((entry, i) => (
          <div key={entry.tier} className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: TIER_COLORS[i % TIER_COLORS.length] }} />
              <span className="text-primary dark:text-white truncate">{entry.tier}</span>
            </div>
            <span className="text-primary/60 dark:text-white/60 font-medium tabular-nums">{entry.memberCount}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const NewMemberGrowthChart: React.FC<{ data: NewMemberGrowthEntry[] }> = ({ data }) => {
  if (!data.length) return <p className="text-primary/40 dark:text-white/40 text-sm text-center py-8">No membership data available.</p>;
  const formatted = data.map(d => ({
    ...d,
    label: new Date(d.month + '-15T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={formatted} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
        <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="#94a3b8" />
        <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={((value: number, name: string) => [value, name === 'newMembers' ? 'New Members' : 'Former Members']) as never} />
        <Legend formatter={(value: string) => value === 'newMembers' ? 'New Members' : 'Former Members'} wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="newMembers" name="newMembers" stroke="#22c55e" strokeWidth={2.5} dot={{ fill: '#22c55e', r: 4 }} activeDot={{ r: 6 }} />
        <Line type="monotone" dataKey="lostMembers" name="lostMembers" stroke="#ef4444" strokeWidth={2.5} dot={{ fill: '#ef4444', r: 4 }} activeDot={{ r: 6 }} />
      </LineChart>
    </ResponsiveContainer>
  );
};
