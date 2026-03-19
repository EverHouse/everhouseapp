export interface PeakHourEntry {
  day_of_week: number;
  hour_of_day: number;
  booking_count: number;
}

export interface ResourceEntry {
  resourceName: string;
  totalHours: number;
}

export interface TopMember {
  memberName: string;
  memberEmail: string;
  totalHours: number;
}

export interface BookingFrequencyEntry {
  bucket: string;
  memberCount: number;
}

export interface RevenueEntry {
  month: string;
  subscriptionRevenue: number;
  bookingRevenue: number;
  overageRevenue: number;
  posSaleRevenue: number;
  accountBalanceRevenue: number;
  guestFeeRevenue: number;
  otherRevenue: number;
  totalRevenue: number;
}

export interface BookingsOverTimeEntry {
  weekStart: string;
  bookingCount: number;
}

export interface DayOfWeekEntry {
  dayOfWeek: number;
  bookingCount: number;
}

export interface UtilizationEntry {
  hourSlot: number;
  bookedCount: number;
  utilizationPct: number;
}

export interface TierDistributionEntry {
  tier: string;
  memberCount: number;
}

export interface NewMemberGrowthEntry {
  month: string;
  newMembers: number;
  lostMembers: number;
}

export interface ActiveMembers {
  totalActiveMembers: number;
  active30: number;
  active60: number;
  active90: number;
}

export interface BookingStats {
  peakHours: PeakHourEntry[];
  resourceUtilization: ResourceEntry[];
  topMembers: TopMember[];
  cancellationRate: number;
  totalBookings: number;
  cancelledBookings: number;
  avgSessionMinutes: number;
}

export interface ExtendedStats {
  activeMembers: ActiveMembers;
  bookingFrequency: BookingFrequencyEntry[];
  revenueOverTime: RevenueEntry[];
  bookingsOverTime: BookingsOverTimeEntry[];
  dayOfWeekBreakdown: DayOfWeekEntry[];
  utilizationByHour: UtilizationEntry[];
}

export interface AtRiskMember {
  id: number;
  name: string;
  email: string;
  tier: string;
  lastBookingDate: string | null;
}

export interface MembershipInsights {
  tierDistribution: TierDistributionEntry[];
  atRiskMembers: AtRiskMember[];
  newMemberGrowth: NewMemberGrowthEntry[];
}
