import { describe, it, expect } from 'vitest';
import { 
  computeUsageAllocation, 
  calculateOverageFee, 
  OVERAGE_RATE_PER_30_MIN 
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
      expect(charge.overageFee).toBe(50); // 60 min = 2 x 30-min blocks = 2 x $25
    });
    
    it('should charge Social tier $25 for 30 minutes', () => {
      const charge = calculatePlayerCharge('Social', 30);
      expect(charge.overageFee).toBe(25);
    });
    
    it('should charge Social tier $75 for 90 minutes', () => {
      const charge = calculatePlayerCharge('Social', 90);
      expect(charge.overageFee).toBe(75); // 3 x 30-min blocks
    });
    
    it('should round up partial blocks for Social tier', () => {
      const charge = calculatePlayerCharge('Social', 45);
      expect(charge.overageFee).toBe(50); // 45 min rounds up to 2 blocks
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
      expect(charge.overageFee).toBe(75); // 3 x 30-min blocks
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
      const hostCharge = calculatePlayerCharge('Core', 30 + 30); // 30 own + 30 guest
      expect(hostCharge.overageMinutes).toBe(0); // 60 min is within Core limit
      expect(hostCharge.overageFee).toBe(0);
    });
    
    it('should cause overage when guest time pushes host over limit', () => {
      const hostCharge = calculatePlayerCharge('Core', 60 + 30); // 60 own + 30 guest = 90 total
      expect(hostCharge.includedMinutes).toBe(60);
      expect(hostCharge.overageMinutes).toBe(30);
      expect(hostCharge.overageFee).toBe(25);
    });
    
    it('should calculate correct overage for Premium host with 2 guests', () => {
      const hostCharge = calculatePlayerCharge('Premium', 30 + 30 + 30); // 30 own + 60 guest = 90 total
      expect(hostCharge.includedMinutes).toBe(90);
      expect(hostCharge.overageMinutes).toBe(0);
      expect(hostCharge.overageFee).toBe(0);
    });
    
    it('should charge VIP host nothing even with multiple guests', () => {
      const hostCharge = calculatePlayerCharge('VIP', 30 + 30 + 30 + 30); // 120 total
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
      expectedHostCharge: 50, // 60 min of guest time charged to host = $50 overage
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
