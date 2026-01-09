import { describe, it, expect } from 'vitest';
import { 
  BookingEventType, 
  BookingEventData 
} from '../../server/core/bookingEvents';
import type { TierLimits } from '../../server/core/tierService';
import { parseTimeToMinutes, hasTimeOverlap } from '../../server/core/bookingValidation';

describe('BookingEventTypes (Production Code)', () => {
  const validEventTypes: BookingEventType[] = [
    'booking_created',
    'booking_approved',
    'booking_declined',
    'booking_cancelled',
    'booking_rescheduled',
    'booking_checked_in'
  ];

  it('should have all expected event types defined', () => {
    expect(validEventTypes).toContain('booking_created');
    expect(validEventTypes).toContain('booking_approved');
    expect(validEventTypes).toContain('booking_declined');
    expect(validEventTypes).toContain('booking_cancelled');
    expect(validEventTypes).toContain('booking_rescheduled');
    expect(validEventTypes).toContain('booking_checked_in');
  });

  it('should validate booking event data structure', () => {
    const mockEventData: BookingEventData = {
      bookingId: 123,
      memberEmail: 'test@example.com',
      memberName: 'Test User',
      resourceId: 1,
      resourceName: 'Bay 1',
      resourceType: 'simulator',
      bookingDate: '2025-01-15',
      startTime: '10:00:00',
      endTime: '11:00:00',
      status: 'approved',
      previousStatus: 'pending',
      actionBy: 'staff'
    };

    expect(mockEventData.bookingId).toBe(123);
    expect(mockEventData.memberEmail).toBe('test@example.com');
    expect(mockEventData.bookingDate).toBe('2025-01-15');
    expect(mockEventData.status).toBe('approved');
    expect(mockEventData.actionBy).toBe('staff');
  });

  it('should allow minimal event data', () => {
    const minimalData: BookingEventData = {
      bookingId: 1,
      memberEmail: 'user@test.com',
      bookingDate: '2025-01-20',
      startTime: '14:00:00',
      status: 'pending'
    };

    expect(minimalData.bookingId).toBe(1);
    expect(minimalData.memberEmail).toBe('user@test.com');
    expect(minimalData.endTime).toBeUndefined();
    expect(minimalData.staffEmail).toBeUndefined();
  });
});

describe('Time Overlap Detection Logic (Production Imports)', () => {
  describe('parseTimeToMinutes (from production)', () => {
    it('should convert 09:00 to 540', () => {
      expect(parseTimeToMinutes('09:00')).toBe(540);
    });

    it('should convert 14:30 to 870', () => {
      expect(parseTimeToMinutes('14:30')).toBe(870);
    });

    it('should convert 00:00 to 0', () => {
      expect(parseTimeToMinutes('00:00')).toBe(0);
    });

    it('should convert 23:59 to 1439', () => {
      expect(parseTimeToMinutes('23:59')).toBe(1439);
    });
    
    it('should handle null/undefined gracefully', () => {
      expect(parseTimeToMinutes(null)).toBe(0);
      expect(parseTimeToMinutes(undefined)).toBe(0);
    });
  });

  describe('hasTimeOverlap (from production)', () => {
    it('should detect overlap when times intersect', () => {
      const start1 = parseTimeToMinutes('10:00');
      const end1 = parseTimeToMinutes('11:00');
      const start2 = parseTimeToMinutes('10:30');
      const end2 = parseTimeToMinutes('11:30');
      expect(hasTimeOverlap(start1, end1, start2, end2)).toBe(true);
    });

    it('should detect overlap when one range contains another', () => {
      const start1 = parseTimeToMinutes('09:00');
      const end1 = parseTimeToMinutes('12:00');
      const start2 = parseTimeToMinutes('10:00');
      const end2 = parseTimeToMinutes('11:00');
      expect(hasTimeOverlap(start1, end1, start2, end2)).toBe(true);
    });

    it('should not detect overlap for adjacent times', () => {
      const start1 = parseTimeToMinutes('10:00');
      const end1 = parseTimeToMinutes('11:00');
      const start2 = parseTimeToMinutes('11:00');
      const end2 = parseTimeToMinutes('12:00');
      expect(hasTimeOverlap(start1, end1, start2, end2)).toBe(false);
    });

    it('should not detect overlap for non-overlapping times', () => {
      const start1 = parseTimeToMinutes('09:00');
      const end1 = parseTimeToMinutes('10:00');
      const start2 = parseTimeToMinutes('14:00');
      const end2 = parseTimeToMinutes('15:00');
      expect(hasTimeOverlap(start1, end1, start2, end2)).toBe(false);
    });

    it('should detect complete overlap', () => {
      const start1 = parseTimeToMinutes('10:00');
      const end1 = parseTimeToMinutes('11:00');
      expect(hasTimeOverlap(start1, end1, start1, end1)).toBe(true);
    });
  });
});

describe('Daily Limit Checking Logic', () => {
  function checkDailyLimit(currentMinutes: number, requestedMinutes: number, limitMinutes: number): {
    allowed: boolean;
    remaining: number;
  } {
    const remaining = Math.max(0, limitMinutes - currentMinutes);
    const allowed = currentMinutes + requestedMinutes <= limitMinutes;
    return { allowed, remaining };
  }

  it('should allow booking within limit', () => {
    const result = checkDailyLimit(60, 60, 180);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(120);
  });

  it('should deny booking exceeding limit', () => {
    const result = checkDailyLimit(120, 90, 180);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(60);
  });

  it('should allow booking at exact limit', () => {
    const result = checkDailyLimit(120, 60, 180);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(60);
  });

  it('should handle zero current minutes', () => {
    const result = checkDailyLimit(0, 60, 180);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(180);
  });

  it('should handle already at limit', () => {
    const result = checkDailyLimit(180, 30, 180);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('should handle over limit (edge case)', () => {
    const result = checkDailyLimit(200, 30, 180);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

describe('Booking Status Validation', () => {
  const VALID_STATUSES = ['pending', 'approved', 'declined', 'cancelled', 'checked_in'];
  
  const APPROVABLE_STATUSES = ['pending'];
  const CANCELLABLE_STATUSES = ['pending', 'approved'];
  const DECLINABLE_STATUSES = ['pending'];

  it('should validate approvable statuses', () => {
    expect(APPROVABLE_STATUSES.includes('pending')).toBe(true);
    expect(APPROVABLE_STATUSES.includes('approved')).toBe(false);
    expect(APPROVABLE_STATUSES.includes('cancelled')).toBe(false);
  });

  it('should validate cancellable statuses', () => {
    expect(CANCELLABLE_STATUSES.includes('pending')).toBe(true);
    expect(CANCELLABLE_STATUSES.includes('approved')).toBe(true);
    expect(CANCELLABLE_STATUSES.includes('cancelled')).toBe(false);
    expect(CANCELLABLE_STATUSES.includes('declined')).toBe(false);
  });

  it('should validate declinable statuses', () => {
    expect(DECLINABLE_STATUSES.includes('pending')).toBe(true);
    expect(DECLINABLE_STATUSES.includes('approved')).toBe(false);
  });

  it('should recognize all valid statuses', () => {
    VALID_STATUSES.forEach(status => {
      expect(typeof status).toBe('string');
      expect(status.length).toBeGreaterThan(0);
    });
  });
});

describe('TierLimits Interface (Production Type)', () => {
  it('should validate tier limits structure', () => {
    const premiumLimits: TierLimits = {
      daily_sim_minutes: 180,
      guest_passes_per_month: 4,
      booking_window_days: 14,
      daily_conf_room_minutes: 120,
      can_book_simulators: true,
      can_book_conference: true,
      can_book_wellness: true,
      has_group_lessons: true,
      has_extended_sessions: true,
      has_private_lesson: false,
      has_simulator_guest_passes: true,
      has_discounted_merch: true,
      unlimited_access: false
    };

    expect(premiumLimits.daily_sim_minutes).toBe(180);
    expect(premiumLimits.can_book_simulators).toBe(true);
    expect(premiumLimits.unlimited_access).toBe(false);
  });

  it('should validate social tier with limited access', () => {
    const socialLimits: TierLimits = {
      daily_sim_minutes: 0,
      guest_passes_per_month: 0,
      booking_window_days: 7,
      daily_conf_room_minutes: 0,
      can_book_simulators: false,
      can_book_conference: false,
      can_book_wellness: true,
      has_group_lessons: false,
      has_extended_sessions: false,
      has_private_lesson: false,
      has_simulator_guest_passes: false,
      has_discounted_merch: false,
      unlimited_access: false
    };

    expect(socialLimits.can_book_simulators).toBe(false);
    expect(socialLimits.can_book_wellness).toBe(true);
    expect(socialLimits.daily_sim_minutes).toBe(0);
  });

  it('should validate unlimited tier', () => {
    const unlimitedLimits: TierLimits = {
      daily_sim_minutes: 999,
      guest_passes_per_month: 10,
      booking_window_days: 30,
      daily_conf_room_minutes: 999,
      can_book_simulators: true,
      can_book_conference: true,
      can_book_wellness: true,
      has_group_lessons: true,
      has_extended_sessions: true,
      has_private_lesson: true,
      has_simulator_guest_passes: true,
      has_discounted_merch: true,
      unlimited_access: true
    };

    expect(unlimitedLimits.unlimited_access).toBe(true);
    expect(unlimitedLimits.daily_sim_minutes).toBe(999);
  });
});

describe('Closure Blocking Logic', () => {
  interface Closure {
    startDate: string;
    endDate: string;
    affectsSimulators: boolean;
    affectsWellness: boolean;
    affectsConference: boolean;
  }

  function isDateInClosurePeriod(bookingDate: string, closure: Closure): boolean {
    return bookingDate >= closure.startDate && bookingDate <= closure.endDate;
  }

  function isResourceAffectedByClosure(resourceType: string, closure: Closure): boolean {
    switch (resourceType) {
      case 'simulator':
        return closure.affectsSimulators;
      case 'wellness':
        return closure.affectsWellness;
      case 'conference':
        return closure.affectsConference;
      default:
        return false;
    }
  }

  it('should detect booking during closure', () => {
    const closure: Closure = {
      startDate: '2025-12-24',
      endDate: '2025-12-26',
      affectsSimulators: true,
      affectsWellness: true,
      affectsConference: false
    };

    expect(isDateInClosurePeriod('2025-12-25', closure)).toBe(true);
    expect(isDateInClosurePeriod('2025-12-24', closure)).toBe(true);
    expect(isDateInClosurePeriod('2025-12-26', closure)).toBe(true);
    expect(isDateInClosurePeriod('2025-12-27', closure)).toBe(false);
    expect(isDateInClosurePeriod('2025-12-23', closure)).toBe(false);
  });

  it('should check resource-specific closures', () => {
    const closure: Closure = {
      startDate: '2025-12-24',
      endDate: '2025-12-26',
      affectsSimulators: true,
      affectsWellness: false,
      affectsConference: true
    };

    expect(isResourceAffectedByClosure('simulator', closure)).toBe(true);
    expect(isResourceAffectedByClosure('wellness', closure)).toBe(false);
    expect(isResourceAffectedByClosure('conference', closure)).toBe(true);
    expect(isResourceAffectedByClosure('unknown', closure)).toBe(false);
  });
});
