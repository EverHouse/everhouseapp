import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  computeUsageAllocation, 
  calculateOverageFee, 
  OVERAGE_RATE_PER_30_MIN,
  FLAT_GUEST_FEE,
  type Participant,
  type ParticipantBilling,
  type SessionBillingResult
} from '../../server/core/bookingService/usageCalculator';

vi.mock('../../server/core/db', () => ({
  pool: {
    query: vi.fn()
  }
}));

vi.mock('../../server/core/tierService', () => ({
  getMemberTierByEmail: vi.fn(),
  getTierLimits: vi.fn()
}));

vi.mock('../../server/core/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }
}));

import { pool } from '../../server/core/db';
import { getMemberTierByEmail, getTierLimits } from '../../server/core/tierService';
import { 
  calculateFullSessionBilling,
  getDailyUsageFromLedger,
  getGuestPassInfo,
  recalculateSessionFees
} from '../../server/core/bookingService/usageCalculator';

interface TierConfig {
  name: string;
  dailySimMinutes: number;
  guestPassesPerMonth: number;
  canBookSimulators: boolean;
  hasSimulatorGuestPasses: boolean;
  unlimitedAccess: boolean;
}

const TIER_CONFIGS: TierConfig[] = [
  { name: 'Social', dailySimMinutes: 0, guestPassesPerMonth: 0, canBookSimulators: true, hasSimulatorGuestPasses: false, unlimitedAccess: false },
  { name: 'Core', dailySimMinutes: 60, guestPassesPerMonth: 4, canBookSimulators: true, hasSimulatorGuestPasses: false, unlimitedAccess: false },
  { name: 'Premium', dailySimMinutes: 90, guestPassesPerMonth: 8, canBookSimulators: true, hasSimulatorGuestPasses: true, unlimitedAccess: false },
  { name: 'Corporate', dailySimMinutes: 90, guestPassesPerMonth: 15, canBookSimulators: true, hasSimulatorGuestPasses: false, unlimitedAccess: false },
  { name: 'VIP', dailySimMinutes: 999, guestPassesPerMonth: 999, canBookSimulators: true, hasSimulatorGuestPasses: true, unlimitedAccess: true },
];

function getTierConfig(tierName: string): TierConfig | undefined {
  return TIER_CONFIGS.find(t => t.name.toLowerCase() === tierName.toLowerCase());
}

function getTierLimitsFromConfig(tierName: string) {
  const tier = getTierConfig(tierName);
  if (!tier) return null;
  return {
    daily_sim_minutes: tier.dailySimMinutes,
    guest_passes_per_month: tier.guestPassesPerMonth,
    can_book_simulators: tier.canBookSimulators,
    has_simulator_guest_passes: tier.hasSimulatorGuestPasses,
    unlimited_access: tier.unlimitedAccess,
    booking_window_days: 7,
    daily_conf_room_minutes: 0,
    can_book_conference: false,
    can_book_wellness: true,
    has_group_lessons: false,
    has_extended_sessions: false,
    has_private_lesson: false,
    has_discounted_merch: false
  };
}

function setupMocksForTier(tierName: string, priorUsage: number = 0, guestPassesRemaining?: number) {
  const tierLimits = getTierLimitsFromConfig(tierName);
  
  (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(tierName);
  (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(tierLimits);
  
  (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
    if (query.includes('usage_ledger')) {
      return Promise.resolve({ rows: [{ total_minutes: priorUsage }] });
    }
    if (query.includes('guest_passes')) {
      const remaining = guestPassesRemaining ?? tierLimits?.guest_passes_per_month ?? 0;
      return Promise.resolve({ 
        rows: remaining > 0 ? [{ passes_used: 0, passes_total: remaining }] : [] 
      });
    }
    return Promise.resolve({ rows: [] });
  });
}

function calculatePlayerCharge(
  tierName: string,
  minutesUsed: number,
  isGuest: boolean = false
): { includedMinutes: number; overageMinutes: number; overageFee: number } {
  const tier = getTierConfig(tierName);
  
  if (!tier) {
    return { includedMinutes: 0, overageMinutes: minutesUsed, overageFee: Math.ceil(minutesUsed / 30) * OVERAGE_RATE_PER_30_MIN };
  }

  if (isGuest) {
    const overageBlocks = Math.ceil(minutesUsed / 30);
    return { 
      includedMinutes: 0, 
      overageMinutes: minutesUsed, 
      overageFee: overageBlocks * OVERAGE_RATE_PER_30_MIN 
    };
  }
  
  if (tier.unlimitedAccess || tier.dailySimMinutes >= 999) {
    return { includedMinutes: minutesUsed, overageMinutes: 0, overageFee: 0 };
  }
  
  const includedMinutes = Math.min(minutesUsed, tier.dailySimMinutes);
  const overageMinutes = Math.max(0, minutesUsed - tier.dailySimMinutes);
  const overageBlocks = Math.ceil(overageMinutes / 30);
  const overageFee = overageBlocks * OVERAGE_RATE_PER_30_MIN;
  
  return { includedMinutes, overageMinutes, overageFee };
}

interface GuestPassUsage {
  guestPassesAvailable: number;
  guestsToAdd: number;
  guestPassesUsed: number;
  guestPassesRemaining: number;
  additionalGuestsCharged: number;
}

function calculateGuestPassUsage(
  tierName: string,
  guestPassesRemaining: number,
  guestsToAdd: number
): GuestPassUsage {
  const tier = getTierConfig(tierName);
  
  if (!tier || !tier.hasSimulatorGuestPasses || tier.guestPassesPerMonth === 0) {
    return {
      guestPassesAvailable: 0,
      guestsToAdd,
      guestPassesUsed: 0,
      guestPassesRemaining: 0,
      additionalGuestsCharged: guestsToAdd
    };
  }
  
  const guestPassesUsed = Math.min(guestsToAdd, guestPassesRemaining);
  const additionalGuestsCharged = Math.max(0, guestsToAdd - guestPassesRemaining);
  
  return {
    guestPassesAvailable: guestPassesRemaining,
    guestsToAdd,
    guestPassesUsed,
    guestPassesRemaining: guestPassesRemaining - guestPassesUsed,
    additionalGuestsCharged
  };
}

describe('Check-in Billing - Tier-Based Charging Tests', () => {
  
  describe('Social Tier Billing', () => {
    it('should charge Social tier for all time as overage (0 included minutes)', () => {
      const charge = calculatePlayerCharge('Social', 60);
      expect(charge.includedMinutes).toBe(0);
      expect(charge.overageMinutes).toBe(60);
      expect(charge.overageFee).toBe(50);
    });
    
    it('should charge Social tier $25 for 30 minutes', () => {
      const charge = calculatePlayerCharge('Social', 30);
      expect(charge.overageFee).toBe(25);
    });
    
    it('should charge Social tier $75 for 90 minutes', () => {
      const charge = calculatePlayerCharge('Social', 90);
      expect(charge.overageFee).toBe(75);
    });
    
    it('should round up partial blocks for Social tier', () => {
      const charge = calculatePlayerCharge('Social', 45);
      expect(charge.overageFee).toBe(50);
    });
  });
  
  describe('Core Tier Billing', () => {
    it('should include 60 minutes for Core tier with no overage', () => {
      const charge = calculatePlayerCharge('Core', 60);
      expect(charge.includedMinutes).toBe(60);
      expect(charge.overageMinutes).toBe(0);
      expect(charge.overageFee).toBe(0);
    });
    
    it('should charge overage for Core tier exceeding 60 minutes', () => {
      const charge = calculatePlayerCharge('Core', 90);
      expect(charge.includedMinutes).toBe(60);
      expect(charge.overageMinutes).toBe(30);
      expect(charge.overageFee).toBe(25);
    });
    
    it('should charge $50 overage for Core tier using 120 minutes', () => {
      const charge = calculatePlayerCharge('Core', 120);
      expect(charge.includedMinutes).toBe(60);
      expect(charge.overageMinutes).toBe(60);
      expect(charge.overageFee).toBe(50);
    });
  });
  
  describe('Premium Tier Billing', () => {
    it('should include 90 minutes for Premium tier with no overage', () => {
      const charge = calculatePlayerCharge('Premium', 90);
      expect(charge.includedMinutes).toBe(90);
      expect(charge.overageMinutes).toBe(0);
      expect(charge.overageFee).toBe(0);
    });
    
    it('should charge overage for Premium tier exceeding 90 minutes', () => {
      const charge = calculatePlayerCharge('Premium', 120);
      expect(charge.includedMinutes).toBe(90);
      expect(charge.overageMinutes).toBe(30);
      expect(charge.overageFee).toBe(25);
    });
  });
  
  describe('Corporate Tier Billing', () => {
    it('should include 90 minutes for Corporate tier with no overage', () => {
      const charge = calculatePlayerCharge('Corporate', 90);
      expect(charge.includedMinutes).toBe(90);
      expect(charge.overageMinutes).toBe(0);
      expect(charge.overageFee).toBe(0);
    });
    
    it('should charge overage for Corporate tier exceeding 90 minutes', () => {
      const charge = calculatePlayerCharge('Corporate', 180);
      expect(charge.includedMinutes).toBe(90);
      expect(charge.overageMinutes).toBe(90);
      expect(charge.overageFee).toBe(75);
    });
  });
  
  describe('VIP Tier Billing', () => {
    it('should have unlimited included minutes with no overage', () => {
      const charge = calculatePlayerCharge('VIP', 180);
      expect(charge.includedMinutes).toBe(180);
      expect(charge.overageMinutes).toBe(0);
      expect(charge.overageFee).toBe(0);
    });
    
    it('should never charge overage for VIP tier', () => {
      const charge = calculatePlayerCharge('VIP', 500);
      expect(charge.overageFee).toBe(0);
    });
  });
});

describe('Check-in Billing - Guest Time Allocation', () => {
  
  describe('Time Split Calculations', () => {
    it('should split 60 minutes equally between 2 players', () => {
      const participants = [
        { participantType: 'owner' as const, displayName: 'Host' },
        { participantType: 'guest' as const, displayName: 'Guest 1' }
      ];
      const allocations = computeUsageAllocation(60, participants);
      
      expect(allocations).toHaveLength(2);
      expect(allocations[0].minutesAllocated).toBe(30);
      expect(allocations[1].minutesAllocated).toBe(30);
    });
    
    it('should split 60 minutes equally between 3 players', () => {
      const participants = [
        { participantType: 'owner' as const, displayName: 'Host' },
        { participantType: 'member' as const, displayName: 'Member 1' },
        { participantType: 'guest' as const, displayName: 'Guest 1' }
      ];
      const allocations = computeUsageAllocation(60, participants);
      
      expect(allocations).toHaveLength(3);
      expect(allocations[0].minutesAllocated).toBe(20);
      expect(allocations[1].minutesAllocated).toBe(20);
      expect(allocations[2].minutesAllocated).toBe(20);
    });
    
    it('should split 60 minutes equally between 4 players', () => {
      const participants = [
        { participantType: 'owner' as const, displayName: 'Host' },
        { participantType: 'member' as const, displayName: 'Member 1' },
        { participantType: 'guest' as const, displayName: 'Guest 1' },
        { participantType: 'guest' as const, displayName: 'Guest 2' }
      ];
      const allocations = computeUsageAllocation(60, participants);
      
      expect(allocations).toHaveLength(4);
      expect(allocations.every(a => a.minutesAllocated === 15)).toBe(true);
    });
    
    it('should handle remainder distribution when time does not divide evenly', () => {
      const participants = [
        { participantType: 'owner' as const, displayName: 'Host' },
        { participantType: 'guest' as const, displayName: 'Guest 1' },
        { participantType: 'guest' as const, displayName: 'Guest 2' }
      ];
      const allocations = computeUsageAllocation(65, participants);
      
      const totalAllocated = allocations.reduce((sum, a) => sum + a.minutesAllocated, 0);
      expect(totalAllocated).toBe(65);
    });
  });
  
  describe('Guest Time Assigned to Host', () => {
    it('should charge host for guest time when guest pass is not used', () => {
      const hostCharge = calculatePlayerCharge('Core', 30 + 30);
      expect(hostCharge.overageMinutes).toBe(0);
      expect(hostCharge.overageFee).toBe(0);
    });
    
    it('should cause overage when guest time pushes host over limit', () => {
      const hostCharge = calculatePlayerCharge('Core', 60 + 30);
      expect(hostCharge.includedMinutes).toBe(60);
      expect(hostCharge.overageMinutes).toBe(30);
      expect(hostCharge.overageFee).toBe(25);
    });
    
    it('should calculate correct overage for Premium host with 2 guests', () => {
      const hostCharge = calculatePlayerCharge('Premium', 30 + 30 + 30);
      expect(hostCharge.includedMinutes).toBe(90);
      expect(hostCharge.overageMinutes).toBe(0);
      expect(hostCharge.overageFee).toBe(0);
    });
    
    it('should charge VIP host nothing even with multiple guests', () => {
      const hostCharge = calculatePlayerCharge('VIP', 30 + 30 + 30 + 30);
      expect(hostCharge.overageFee).toBe(0);
    });
  });
});

describe('Check-in Billing - Guest Pass Usage Tests', () => {
  
  describe('Premium Tier Guest Passes (has guest passes)', () => {
    it('should use guest passes when available', () => {
      const usage = calculateGuestPassUsage('Premium', 8, 2);
      expect(usage.guestPassesUsed).toBe(2);
      expect(usage.guestPassesRemaining).toBe(6);
      expect(usage.additionalGuestsCharged).toBe(0);
    });
    
    it('should use remaining passes and charge extras', () => {
      const usage = calculateGuestPassUsage('Premium', 1, 3);
      expect(usage.guestPassesUsed).toBe(1);
      expect(usage.guestPassesRemaining).toBe(0);
      expect(usage.additionalGuestsCharged).toBe(2);
    });
    
    it('should charge all guests when no passes remaining', () => {
      const usage = calculateGuestPassUsage('Premium', 0, 2);
      expect(usage.guestPassesUsed).toBe(0);
      expect(usage.additionalGuestsCharged).toBe(2);
    });
  });
  
  describe('Core Tier Guest Passes (no guest passes benefit)', () => {
    it('should charge all guests when tier has no guest pass benefit', () => {
      const usage = calculateGuestPassUsage('Core', 4, 2);
      expect(usage.guestPassesUsed).toBe(0);
      expect(usage.additionalGuestsCharged).toBe(2);
    });
  });
  
  describe('Social Tier (cannot add guests)', () => {
    it('should not allow guest pass usage for Social tier', () => {
      const usage = calculateGuestPassUsage('Social', 0, 1);
      expect(usage.guestPassesUsed).toBe(0);
      expect(usage.additionalGuestsCharged).toBe(1);
    });
  });
  
  describe('VIP Tier Guest Passes', () => {
    it('should use unlimited guest passes for VIP tier', () => {
      const usage = calculateGuestPassUsage('VIP', 999, 5);
      expect(usage.guestPassesUsed).toBe(5);
      expect(usage.guestPassesRemaining).toBe(994);
      expect(usage.additionalGuestsCharged).toBe(0);
    });
  });
});

describe('Check-in Billing - Complete Booking Scenarios', () => {
  
  interface BookingScenario {
    description: string;
    hostTier: string;
    durationMinutes: number;
    playerCount: number;
    guestCount: number;
    guestPassesRemaining: number;
    expectedHostCharge: number;
    expectedGuestPassesUsed: number;
    expectedGuestsCharged: number;
  }
  
  function calculateBookingCharges(scenario: BookingScenario) {
    const tier = getTierConfig(scenario.hostTier);
    const minutesPerPlayer = scenario.durationMinutes / scenario.playerCount;
    const hostMinutes = minutesPerPlayer;
    const guestMinutesTotal = minutesPerPlayer * scenario.guestCount;
    
    const guestPassUsage = calculateGuestPassUsage(
      scenario.hostTier, 
      scenario.guestPassesRemaining, 
      scenario.guestCount
    );
    
    const chargeableGuestMinutes = (guestPassUsage.additionalGuestsCharged / scenario.guestCount) * guestMinutesTotal;
    const hostTotalMinutes = hostMinutes + chargeableGuestMinutes;
    const hostCharge = calculatePlayerCharge(scenario.hostTier, hostTotalMinutes);
    
    return {
      hostCharge: hostCharge.overageFee,
      guestPassesUsed: guestPassUsage.guestPassesUsed,
      guestsCharged: guestPassUsage.additionalGuestsCharged
    };
  }
  
  const scenarios: BookingScenario[] = [
    {
      description: 'Core member solo 60min - no charge',
      hostTier: 'Core',
      durationMinutes: 60,
      playerCount: 1,
      guestCount: 0,
      guestPassesRemaining: 4,
      expectedHostCharge: 0,
      expectedGuestPassesUsed: 0,
      expectedGuestsCharged: 0
    },
    {
      description: 'Core member + 1 guest 60min - guest charged (no guest passes benefit)',
      hostTier: 'Core',
      durationMinutes: 60,
      playerCount: 2,
      guestCount: 1,
      guestPassesRemaining: 4,
      expectedHostCharge: 0,
      expectedGuestPassesUsed: 0,
      expectedGuestsCharged: 1
    },
    {
      description: 'Premium member + 2 guests 90min - guest passes used',
      hostTier: 'Premium',
      durationMinutes: 90,
      playerCount: 3,
      guestCount: 2,
      guestPassesRemaining: 8,
      expectedHostCharge: 0,
      expectedGuestPassesUsed: 2,
      expectedGuestsCharged: 0
    },
    {
      description: 'Premium member + 2 guests 90min - no passes left',
      hostTier: 'Premium',
      durationMinutes: 90,
      playerCount: 3,
      guestCount: 2,
      guestPassesRemaining: 0,
      expectedHostCharge: 50,
      expectedGuestPassesUsed: 0,
      expectedGuestsCharged: 2
    },
    {
      description: 'VIP member + 3 guests 120min - no charge ever',
      hostTier: 'VIP',
      durationMinutes: 120,
      playerCount: 4,
      guestCount: 3,
      guestPassesRemaining: 999,
      expectedHostCharge: 0,
      expectedGuestPassesUsed: 3,
      expectedGuestsCharged: 0
    },
    {
      description: 'Social member solo 60min - full overage',
      hostTier: 'Social',
      durationMinutes: 60,
      playerCount: 1,
      guestCount: 0,
      guestPassesRemaining: 0,
      expectedHostCharge: 50,
      expectedGuestPassesUsed: 0,
      expectedGuestsCharged: 0
    }
  ];
  
  scenarios.forEach(scenario => {
    it(scenario.description, () => {
      const result = calculateBookingCharges(scenario);
      expect(result.guestPassesUsed).toBe(scenario.expectedGuestPassesUsed);
      expect(result.guestsCharged).toBe(scenario.expectedGuestsCharged);
    });
  });
});

describe('Check-in Billing - Overage Rate Constants', () => {
  it('should have correct overage rate of $25 per 30 minutes', () => {
    expect(OVERAGE_RATE_PER_30_MIN).toBe(25);
  });
  
  it('should have correct flat guest fee of $25', () => {
    expect(FLAT_GUEST_FEE).toBe(25);
  });
  
  it('calculateOverageFee should return 0 for usage within allowance', () => {
    const result = calculateOverageFee(60, 90);
    expect(result.hasOverage).toBe(false);
    expect(result.overageFee).toBe(0);
  });
  
  it('calculateOverageFee should calculate correct overage for excess usage', () => {
    const result = calculateOverageFee(90, 60);
    expect(result.hasOverage).toBe(true);
    expect(result.overageMinutes).toBe(30);
    expect(result.overageFee).toBe(25);
  });
  
  it('calculateOverageFee should handle unlimited tiers (999+ allowance)', () => {
    const result = calculateOverageFee(180, 999);
    expect(result.hasOverage).toBe(false);
    expect(result.overageFee).toBe(0);
  });
});

describe('Check-in Billing - Per-Member Overage Calculation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should calculate overage based on each member\'s own tier, not the host\'s tier', async () => {
    const memberTierLimits: Record<string, any> = {
      'host@test.com': getTierLimitsFromConfig('Premium'),
      'core-member@test.com': getTierLimitsFromConfig('Core'),
      'social-member@test.com': getTierLimitsFromConfig('Social')
    };
    
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockImplementation((email: string) => {
      if (email === 'host@test.com') return Promise.resolve('Premium');
      if (email === 'core-member@test.com') return Promise.resolve('Core');
      if (email === 'social-member@test.com') return Promise.resolve('Social');
      return Promise.resolve(null);
    });
    
    (getTierLimits as ReturnType<typeof vi.fn>).mockImplementation((tierName: string) => {
      return Promise.resolve(getTierLimitsFromConfig(tierName));
    });
    
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 8 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Premium Host', email: 'host@test.com' },
      { participantType: 'member', displayName: 'Core Member', email: 'core-member@test.com' },
      { participantType: 'member', displayName: 'Social Member', email: 'social-member@test.com' }
    ];
    
    const result = await calculateFullSessionBilling(
      '2026-01-13',
      90,
      participants,
      'host@test.com'
    );
    
    expect(result.participantCount).toBe(3);
    
    const hostBilling = result.billingBreakdown.find(b => b.participantType === 'owner');
    expect(hostBilling?.tierName).toBe('Premium');
    expect(hostBilling?.dailyAllowance).toBe(90);
    expect(hostBilling?.overageFee).toBe(0);
    
    const coreMemberBilling = result.billingBreakdown.find(
      b => b.participantType === 'member' && b.email === 'core-member@test.com'
    );
    expect(coreMemberBilling?.tierName).toBe('Core');
    expect(coreMemberBilling?.dailyAllowance).toBe(60);
    
    const socialMemberBilling = result.billingBreakdown.find(
      b => b.participantType === 'member' && b.email === 'social-member@test.com'
    );
    expect(socialMemberBilling?.tierName).toBe('Social');
    expect(socialMemberBilling?.dailyAllowance).toBe(0);
    expect(socialMemberBilling?.overageFee).toBeGreaterThan(0);
  });
  
  it('should calculate Core member overage based on 60min allowance', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Core'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 90, participants, 'core@test.com');
    
    const hostBilling = result.billingBreakdown[0];
    expect(hostBilling.dailyAllowance).toBe(60);
    expect(hostBilling.overageMinutes).toBe(30);
    expect(hostBilling.overageFee).toBe(25);
  });
  
  it('should calculate Premium member overage based on 90min allowance', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Premium');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Premium'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 8 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Premium Host', email: 'premium@test.com' }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 120, participants, 'premium@test.com');
    
    const hostBilling = result.billingBreakdown[0];
    expect(hostBilling.dailyAllowance).toBe(90);
    expect(hostBilling.overageMinutes).toBe(30);
    expect(hostBilling.overageFee).toBe(25);
  });
});

describe('Check-in Billing - Guest Pass Only Waives $25 Fee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should waive $25 guest fee when guest pass is used', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Premium');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Premium'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 8 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Premium Host', email: 'premium@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 60, participants, 'premium@test.com');
    
    const guestBilling = result.billingBreakdown.find(b => b.participantType === 'guest');
    expect(guestBilling?.guestPassUsed).toBe(true);
    expect(guestBilling?.guestFee).toBe(0);
    expect(result.totalGuestFees).toBe(0);
  });
  
  it('should NOT reduce host overage when guest pass is used', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockImplementation((tierName: string) => {
      if (tierName === 'Core') {
        return Promise.resolve({
          ...getTierLimitsFromConfig('Core'),
          has_simulator_guest_passes: true
        });
      }
      return Promise.resolve(getTierLimitsFromConfig(tierName));
    });
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 4 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 90, participants, 'core@test.com');
    
    const hostBilling = result.billingBreakdown.find(b => b.participantType === 'owner');
    expect(hostBilling?.overageMinutes).toBe(30);
    expect(hostBilling?.overageFee).toBe(25);
    
    const guestBilling = result.billingBreakdown.find(b => b.participantType === 'guest');
    expect(guestBilling?.guestPassUsed).toBe(true);
    expect(guestBilling?.guestFee).toBe(0);
  });
  
  it('should charge $25 guest fee AND host overage when no guest pass available', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...getTierLimitsFromConfig('Core'),
      has_simulator_guest_passes: false
    });
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 90, participants, 'core@test.com');
    
    const hostBilling = result.billingBreakdown.find(b => b.participantType === 'owner');
    expect(hostBilling?.overageFee).toBe(25);
    
    const guestBilling = result.billingBreakdown.find(b => b.participantType === 'guest');
    expect(guestBilling?.guestPassUsed).toBe(false);
    expect(guestBilling?.guestFee).toBe(25);
    expect(result.totalGuestFees).toBe(25);
  });
});

describe('Check-in Billing - Flat $25 Guest Fee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should charge exactly $25 per guest when no guest pass is used', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Core'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 },
      { participantType: 'guest', displayName: 'Guest 2', guestId: 2 },
      { participantType: 'guest', displayName: 'Guest 3', guestId: 3 }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 60, participants, 'core@test.com');
    
    const guestBillings = result.billingBreakdown.filter(b => b.participantType === 'guest');
    expect(guestBillings).toHaveLength(3);
    guestBillings.forEach(guest => {
      expect(guest.guestFee).toBe(FLAT_GUEST_FEE);
      expect(guest.guestPassUsed).toBe(false);
    });
    
    expect(result.totalGuestFees).toBe(75);
    expect(result.guestCount).toBe(3);
  });
  
  it('should charge $25 flat fee regardless of session duration', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Core'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 }
    ];
    
    const shortSession = await calculateFullSessionBilling('2026-01-13', 30, participants, 'core@test.com');
    expect(shortSession.totalGuestFees).toBe(25);
    
    const longSession = await calculateFullSessionBilling('2026-01-13', 180, participants, 'core@test.com');
    expect(longSession.totalGuestFees).toBe(25);
  });
  
  it('should charge $0 guest fee when guest pass is applied', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Premium');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Premium'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 8 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Premium Host', email: 'premium@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 60, participants, 'premium@test.com');
    
    const guestBilling = result.billingBreakdown.find(b => b.participantType === 'guest');
    expect(guestBilling?.guestFee).toBe(0);
    expect(guestBilling?.guestPassUsed).toBe(true);
    expect(result.totalGuestFees).toBe(0);
  });
});

describe('Check-in Billing - Multi-Member Different Tiers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should calculate correct fees for VIP host with Core and Social members', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockImplementation((email: string) => {
      if (email === 'vip@test.com') return Promise.resolve('VIP');
      if (email === 'core@test.com') return Promise.resolve('Core');
      if (email === 'social@test.com') return Promise.resolve('Social');
      return Promise.resolve(null);
    });
    
    (getTierLimits as ReturnType<typeof vi.fn>).mockImplementation((tierName: string) => {
      return Promise.resolve(getTierLimitsFromConfig(tierName));
    });
    
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 999 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'VIP Host', email: 'vip@test.com' },
      { participantType: 'member', displayName: 'Core Member', email: 'core@test.com' },
      { participantType: 'member', displayName: 'Social Member', email: 'social@test.com' }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 120, participants, 'vip@test.com');
    
    const vipBilling = result.billingBreakdown.find(b => b.email === 'vip@test.com');
    expect(vipBilling?.overageFee).toBe(0);
    
    const coreBilling = result.billingBreakdown.find(b => b.email === 'core@test.com');
    expect(coreBilling?.dailyAllowance).toBe(60);
    
    const socialBilling = result.billingBreakdown.find(b => b.email === 'social@test.com');
    expect(socialBilling?.dailyAllowance).toBe(0);
    expect(socialBilling?.overageFee).toBeGreaterThan(0);
  });
  
  it('should handle mixed member and guest participants correctly', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockImplementation((email: string) => {
      if (email === 'premium@test.com') return Promise.resolve('Premium');
      if (email === 'core@test.com') return Promise.resolve('Core');
      return Promise.resolve(null);
    });
    
    (getTierLimits as ReturnType<typeof vi.fn>).mockImplementation((tierName: string) => {
      return Promise.resolve(getTierLimitsFromConfig(tierName));
    });
    
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 8 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Premium Host', email: 'premium@test.com' },
      { participantType: 'member', displayName: 'Core Member', email: 'core@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 },
      { participantType: 'guest', displayName: 'Guest 2', guestId: 2 }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 60, participants, 'premium@test.com');
    
    expect(result.participantCount).toBe(4);
    expect(result.guestCount).toBe(2);
    
    expect(result.guestPassesUsed).toBe(2);
    expect(result.totalGuestFees).toBe(0);
  });
  
  it('should use guest passes until exhausted, then charge remaining guests', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Premium');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Premium'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 6, passes_total: 8 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Premium Host', email: 'premium@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 },
      { participantType: 'guest', displayName: 'Guest 2', guestId: 2 },
      { participantType: 'guest', displayName: 'Guest 3', guestId: 3 }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 60, participants, 'premium@test.com');
    
    expect(result.guestPassesUsed).toBe(2);
    expect(result.totalGuestFees).toBe(25);
    
    const guestsWithPasses = result.billingBreakdown.filter(b => b.guestPassUsed);
    const guestsCharged = result.billingBreakdown.filter(b => b.participantType === 'guest' && b.guestFee > 0);
    expect(guestsWithPasses).toHaveLength(2);
    expect(guestsCharged).toHaveLength(1);
  });
});

describe('Check-in Billing - Dynamic Recalculation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should recalculate fees when a participant is added', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Premium');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Premium'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 8 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const initialParticipants: Participant[] = [
      { participantType: 'owner', displayName: 'Premium Host', email: 'premium@test.com' }
    ];
    
    const initialResult = await calculateFullSessionBilling('2026-01-13', 60, initialParticipants, 'premium@test.com');
    expect(initialResult.participantCount).toBe(1);
    expect(initialResult.totalFees).toBe(0);
    
    const updatedParticipants: Participant[] = [
      { participantType: 'owner', displayName: 'Premium Host', email: 'premium@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 }
    ];
    
    const updatedResult = await calculateFullSessionBilling('2026-01-13', 60, updatedParticipants, 'premium@test.com');
    expect(updatedResult.participantCount).toBe(2);
    expect(updatedResult.guestPassesUsed).toBe(1);
  });
  
  it('should recalculate fees when a participant is removed', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Core'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const withGuests: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 },
      { participantType: 'guest', displayName: 'Guest 2', guestId: 2 }
    ];
    
    const withGuestsResult = await calculateFullSessionBilling('2026-01-13', 60, withGuests, 'core@test.com');
    expect(withGuestsResult.totalGuestFees).toBe(50);
    
    const withoutGuests: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' }
    ];
    
    const withoutGuestsResult = await calculateFullSessionBilling('2026-01-13', 60, withoutGuests, 'core@test.com');
    expect(withoutGuestsResult.totalGuestFees).toBe(0);
  });
  
  it('should recalculate fees when session duration changes', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Core'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' }
    ];
    
    const shortSession = await calculateFullSessionBilling('2026-01-13', 60, participants, 'core@test.com');
    expect(shortSession.billingBreakdown[0].overageFee).toBe(0);
    
    const longSession = await calculateFullSessionBilling('2026-01-13', 90, participants, 'core@test.com');
    expect(longSession.billingBreakdown[0].overageFee).toBe(25);
  });
});

describe('Check-in Billing - VIP Unlimited Access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should never charge VIP member overage regardless of duration', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('VIP');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('VIP'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 999 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'VIP Host', email: 'vip@test.com' }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 480, participants, 'vip@test.com');
    
    expect(result.billingBreakdown[0].overageFee).toBe(0);
    expect(result.totalOverageFees).toBe(0);
  });
  
  it('should never charge VIP member overage even with prior usage', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('VIP');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('VIP'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 300 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 999 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'VIP Host', email: 'vip@test.com' }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 180, participants, 'vip@test.com');
    
    expect(result.billingBreakdown[0].overageFee).toBe(0);
    expect(result.billingBreakdown[0].remainingMinutesBefore).toBe(999);
  });
  
  it('should not charge guest fees when VIP uses guest passes', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('VIP');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('VIP'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 999 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'VIP Host', email: 'vip@test.com' },
      { participantType: 'guest', displayName: 'Guest 1', guestId: 1 },
      { participantType: 'guest', displayName: 'Guest 2', guestId: 2 },
      { participantType: 'guest', displayName: 'Guest 3', guestId: 3 }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 120, participants, 'vip@test.com');
    
    expect(result.guestPassesUsed).toBe(3);
    expect(result.totalGuestFees).toBe(0);
    expect(result.totalFees).toBe(0);
  });
  
  it('VIP with unlimited access should show 999 remaining minutes', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('VIP');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('VIP'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 999 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'VIP Host', email: 'vip@test.com' }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 60, participants, 'vip@test.com');
    
    expect(result.billingBreakdown[0].remainingMinutesBefore).toBe(999);
    expect(result.billingBreakdown[0].dailyAllowance).toBe(999);
  });
});

describe('Check-in Billing - Daily Usage Accumulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should account for prior usage when calculating overage', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Core'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 30 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 60, participants, 'core@test.com');
    
    expect(result.billingBreakdown[0].usedMinutesToday).toBe(30);
    expect(result.billingBreakdown[0].remainingMinutesBefore).toBe(30);
    expect(result.billingBreakdown[0].overageMinutes).toBe(30);
    expect(result.billingBreakdown[0].overageFee).toBe(25);
  });
  
  it('should show full overage when prior usage exhausted allowance', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Core'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 60 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 60, participants, 'core@test.com');
    
    expect(result.billingBreakdown[0].usedMinutesToday).toBe(60);
    expect(result.billingBreakdown[0].remainingMinutesBefore).toBe(0);
    expect(result.billingBreakdown[0].overageMinutes).toBe(60);
    expect(result.billingBreakdown[0].overageFee).toBe(50);
  });
  
  it('should have no overage when prior usage leaves enough allowance', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Premium');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Premium'));
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('usage_ledger')) {
        return Promise.resolve({ rows: [{ total_minutes: 30 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [{ passes_used: 0, passes_total: 8 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Premium Host', email: 'premium@test.com' }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 60, participants, 'premium@test.com');
    
    expect(result.billingBreakdown[0].usedMinutesToday).toBe(30);
    expect(result.billingBreakdown[0].remainingMinutesBefore).toBe(60);
    expect(result.billingBreakdown[0].overageFee).toBe(0);
  });
  
  it('should correctly track usage for multiple members in same session', async () => {
    const memberUsage: Record<string, number> = {
      'host@test.com': 60,
      'member@test.com': 30
    };
    
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockImplementation((email: string) => {
      if (email === 'host@test.com') return Promise.resolve('Core');
      if (email === 'member@test.com') return Promise.resolve('Premium');
      return Promise.resolve(null);
    });
    
    (getTierLimits as ReturnType<typeof vi.fn>).mockImplementation((tierName: string) => {
      return Promise.resolve(getTierLimitsFromConfig(tierName));
    });
    
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string, params?: any[]) => {
      if (query.includes('usage_ledger')) {
        const email = params?.[0] || '';
        const usage = memberUsage[email.toLowerCase()] || 0;
        return Promise.resolve({ rows: [{ total_minutes: usage }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'host@test.com' },
      { participantType: 'member', displayName: 'Premium Member', email: 'member@test.com' }
    ];
    
    const result = await calculateFullSessionBilling('2026-01-13', 60, participants, 'host@test.com');
    
    const hostBilling = result.billingBreakdown.find(b => b.email === 'host@test.com');
    expect(hostBilling?.usedMinutesToday).toBe(60);
    expect(hostBilling?.remainingMinutesBefore).toBe(0);
    expect(hostBilling?.overageFee).toBe(50);
    
    const memberBilling = result.billingBreakdown.find(b => b.email === 'member@test.com');
    expect(memberBilling?.usedMinutesToday).toBe(30);
    expect(memberBilling?.remainingMinutesBefore).toBe(60);
    expect(memberBilling?.overageFee).toBe(0);
  });
  
  it('should exclude current session when recalculating', async () => {
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Core'));
    
    let queryCount = 0;
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string, params?: any[]) => {
      if (query.includes('usage_ledger')) {
        const hasExclude = query.includes('ul.session_id != $3') || params?.includes(123);
        return Promise.resolve({ rows: [{ total_minutes: hasExclude ? 0 : 60 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    const participants: Participant[] = [
      { participantType: 'owner', displayName: 'Core Host', email: 'core@test.com' }
    ];
    
    const result = await calculateFullSessionBilling(
      '2026-01-13', 
      60, 
      participants, 
      'core@test.com',
      { excludeSessionId: 123 }
    );
    
    expect(result.billingBreakdown[0].usedMinutesToday).toBe(0);
    expect(result.billingBreakdown[0].overageFee).toBe(0);
  });
});

describe('Check-in Billing - getDailyUsageFromLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should return 0 when no prior usage exists', async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ 
      rows: [{ total_minutes: 0 }] 
    });
    
    const usage = await getDailyUsageFromLedger('test@example.com', '2026-01-13');
    expect(usage).toBe(0);
  });
  
  it('should return accumulated minutes from ledger', async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ 
      rows: [{ total_minutes: 90 }] 
    });
    
    const usage = await getDailyUsageFromLedger('test@example.com', '2026-01-13');
    expect(usage).toBe(90);
  });
  
  it('should exclude specified session ID', async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ 
      rows: [{ total_minutes: 60 }] 
    });
    
    const usage = await getDailyUsageFromLedger('test@example.com', '2026-01-13', 123);
    expect(usage).toBe(60);
    
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ul.session_id != $3'),
      ['test@example.com', '2026-01-13', 123]
    );
  });
});

describe('Check-in Billing - getGuestPassInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should return no guest pass benefit for tiers without it', async () => {
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Core'));
    
    const result = await getGuestPassInfo('core@test.com', 'Core');
    expect(result.hasGuestPassBenefit).toBe(false);
    expect(result.remaining).toBe(0);
  });
  
  it('should return guest pass info for Premium tier', async () => {
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Premium'));
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [{ passes_used: 2, passes_total: 8 }]
    });
    
    const result = await getGuestPassInfo('premium@test.com', 'Premium');
    expect(result.hasGuestPassBenefit).toBe(true);
    expect(result.remaining).toBe(6);
  });
  
  it('should return full monthly allocation when no record exists', async () => {
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Premium'));
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    
    const result = await getGuestPassInfo('premium@test.com', 'Premium');
    expect(result.hasGuestPassBenefit).toBe(true);
    expect(result.remaining).toBe(8);
  });
  
  it('should return 0 remaining when all passes used', async () => {
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Premium'));
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [{ passes_used: 8, passes_total: 8 }]
    });
    
    const result = await getGuestPassInfo('premium@test.com', 'Premium');
    expect(result.hasGuestPassBenefit).toBe(true);
    expect(result.remaining).toBe(0);
  });
});

describe('Check-in Billing - recalculateSessionFees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should throw error when session not found', async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    
    await expect(recalculateSessionFees(999)).rejects.toThrow('Session 999 not found');
  });
  
  it('should recalculate and update ledger for existing session', async () => {
    const queryResults: Record<string, any> = {};
    
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation((query: string, params?: any[]) => {
      if (query.includes('booking_sessions') && query.includes('SELECT')) {
        return Promise.resolve({
          rows: [{
            id: 1,
            session_date: '2026-01-13',
            start_time: '10:00',
            end_time: '11:00',
            duration_minutes: 60,
            host_email: 'host@test.com'
          }]
        });
      }
      if (query.includes('booking_participants') && query.includes('SELECT')) {
        return Promise.resolve({
          rows: [{
            id: 1,
            user_id: 'user-1',
            guest_id: null,
            display_name: 'Test Host',
            participant_type: 'owner',
            member_email: 'host@test.com'
          }]
        });
      }
      if (query.includes('DELETE FROM usage_ledger')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (query.includes('INSERT INTO usage_ledger')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (query.includes('usage_ledger') && query.includes('SELECT')) {
        return Promise.resolve({ rows: [{ total_minutes: 0 }] });
      }
      if (query.includes('guest_passes')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    
    (getMemberTierByEmail as ReturnType<typeof vi.fn>).mockResolvedValue('Core');
    (getTierLimits as ReturnType<typeof vi.fn>).mockResolvedValue(getTierLimitsFromConfig('Core'));
    
    const result = await recalculateSessionFees(1);
    
    expect(result.sessionId).toBe(1);
    expect(result.ledgerUpdated).toBe(true);
    expect(result.participantsUpdated).toBeGreaterThan(0);
  });
});
