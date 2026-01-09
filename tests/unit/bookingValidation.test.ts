import { describe, it, expect } from 'vitest';
import { parseTimeToMinutes, hasTimeOverlap } from '../../server/core/bookingValidation';

interface TimeSlot {
  resourceId: number;
  date: string;
  startTime: string;
  endTime: string;
}

function checkBookingConflict(existingBookings: TimeSlot[], newBooking: TimeSlot): { hasConflict: boolean; conflictingBooking?: TimeSlot } {
  for (const existing of existingBookings) {
    if (existing.resourceId !== newBooking.resourceId) continue;
    if (existing.date !== newBooking.date) continue;
    
    const existingStart = parseTimeToMinutes(existing.startTime);
    const existingEnd = parseTimeToMinutes(existing.endTime);
    const newStart = parseTimeToMinutes(newBooking.startTime);
    const newEnd = parseTimeToMinutes(newBooking.endTime);
    
    if (hasTimeOverlap(newStart, newEnd, existingStart, existingEnd)) {
      return { hasConflict: true, conflictingBooking: existing };
    }
  }
  return { hasConflict: false };
}

describe('Booking Validation - Double-Booking Prevention', () => {
  it('should detect overlapping bookings on same resource', () => {
    const existingBookings: TimeSlot[] = [
      { resourceId: 1, date: '2026-01-10', startTime: '14:00', endTime: '15:00' }
    ];
    
    const conflictingBooking: TimeSlot = {
      resourceId: 1,
      date: '2026-01-10',
      startTime: '14:30',
      endTime: '15:30'
    };
    
    const result = checkBookingConflict(existingBookings, conflictingBooking);
    expect(result.hasConflict).toBe(true);
    expect(result.conflictingBooking).toBeDefined();
  });
  
  it('should allow bookings on different resources at same time', () => {
    const existingBookings: TimeSlot[] = [
      { resourceId: 1, date: '2026-01-10', startTime: '14:00', endTime: '15:00' }
    ];
    
    const differentResource: TimeSlot = {
      resourceId: 2,
      date: '2026-01-10',
      startTime: '14:00',
      endTime: '15:00'
    };
    
    const result = checkBookingConflict(existingBookings, differentResource);
    expect(result.hasConflict).toBe(false);
  });
  
  it('should allow bookings on same resource at different times', () => {
    const existingBookings: TimeSlot[] = [
      { resourceId: 1, date: '2026-01-10', startTime: '14:00', endTime: '15:00' }
    ];
    
    const laterBooking: TimeSlot = {
      resourceId: 1,
      date: '2026-01-10',
      startTime: '16:00',
      endTime: '17:00'
    };
    
    const result = checkBookingConflict(existingBookings, laterBooking);
    expect(result.hasConflict).toBe(false);
  });
  
  it('should allow back-to-back bookings with no overlap', () => {
    const existingBookings: TimeSlot[] = [
      { resourceId: 1, date: '2026-01-10', startTime: '14:00', endTime: '15:00' }
    ];
    
    const backToBack: TimeSlot = {
      resourceId: 1,
      date: '2026-01-10',
      startTime: '15:00',
      endTime: '16:00'
    };
    
    const result = checkBookingConflict(existingBookings, backToBack);
    expect(result.hasConflict).toBe(false);
  });
  
  it('should detect booking that fully contains existing booking', () => {
    const existingBookings: TimeSlot[] = [
      { resourceId: 1, date: '2026-01-10', startTime: '14:00', endTime: '15:00' }
    ];
    
    const containingBooking: TimeSlot = {
      resourceId: 1,
      date: '2026-01-10',
      startTime: '13:00',
      endTime: '16:00'
    };
    
    const result = checkBookingConflict(existingBookings, containingBooking);
    expect(result.hasConflict).toBe(true);
  });
  
  it('should detect booking fully contained within existing booking', () => {
    const existingBookings: TimeSlot[] = [
      { resourceId: 1, date: '2026-01-10', startTime: '13:00', endTime: '16:00' }
    ];
    
    const containedBooking: TimeSlot = {
      resourceId: 1,
      date: '2026-01-10',
      startTime: '14:00',
      endTime: '15:00'
    };
    
    const result = checkBookingConflict(existingBookings, containedBooking);
    expect(result.hasConflict).toBe(true);
  });
});

describe('Booking Validation - Daily Limits', () => {
  interface TierLimits {
    name: string;
    dailyMinutes: number;
    canBook: boolean;
    bookingWindowDays: number;
  }
  
  const tierConfigs: TierLimits[] = [
    { name: 'Premium', dailyMinutes: 180, canBook: true, bookingWindowDays: 14 },
    { name: 'Standard', dailyMinutes: 120, canBook: true, bookingWindowDays: 7 },
    { name: 'Basic', dailyMinutes: 60, canBook: true, bookingWindowDays: 3 },
    { name: 'Social', dailyMinutes: 0, canBook: false, bookingWindowDays: 0 }
  ];
  
  function checkDailyLimit(
    tierName: string,
    existingMinutes: number,
    requestedMinutes: number
  ): { allowed: boolean; reason?: string; remainingMinutes?: number } {
    const tier = tierConfigs.find(t => t.name.toLowerCase() === tierName.toLowerCase());
    
    if (!tier) {
      return { allowed: false, reason: 'Unknown tier' };
    }
    
    if (!tier.canBook) {
      return { allowed: false, reason: 'Tier does not include booking privileges' };
    }
    
    const remainingMinutes = tier.dailyMinutes - existingMinutes;
    
    if (remainingMinutes <= 0) {
      return { 
        allowed: false, 
        reason: `Daily limit of ${tier.dailyMinutes} minutes reached`,
        remainingMinutes: 0
      };
    }
    
    if (requestedMinutes > remainingMinutes) {
      return {
        allowed: false,
        reason: `Exceeds remaining ${remainingMinutes} minutes for today`,
        remainingMinutes
      };
    }
    
    return { allowed: true, remainingMinutes: remainingMinutes - requestedMinutes };
  }
  
  it('should allow booking within daily limit', () => {
    const result = checkDailyLimit('Premium', 60, 60);
    expect(result.allowed).toBe(true);
    expect(result.remainingMinutes).toBe(60);
  });
  
  it('should reject booking exceeding daily limit', () => {
    const result = checkDailyLimit('Basic', 30, 60);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('30 minutes');
  });
  
  it('should apply different limits per tier', () => {
    const premiumResult = checkDailyLimit('Premium', 120, 60);
    const basicResult = checkDailyLimit('Basic', 30, 60);
    
    expect(premiumResult.allowed).toBe(true);
    expect(basicResult.allowed).toBe(false);
  });
  
  it('should allow booking up to exact limit', () => {
    const result = checkDailyLimit('Standard', 60, 60);
    expect(result.allowed).toBe(true);
    expect(result.remainingMinutes).toBe(0);
  });
  
  it('should reject unknown tier', () => {
    const result = checkDailyLimit('Unknown', 0, 60);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Unknown tier');
  });
  
  it('should reject tier without booking privileges', () => {
    const result = checkDailyLimit('Social', 0, 60);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not include');
  });
  
  it('should reject when daily limit already reached', () => {
    const result = checkDailyLimit('Basic', 60, 30);
    expect(result.allowed).toBe(false);
    expect(result.remainingMinutes).toBe(0);
  });
});

describe('Booking Validation - Facility Closure Blocking', () => {
  interface Closure {
    date: string;
    startTime?: string;
    endTime?: string;
    affectedResources: number[] | 'all';
    title?: string;
  }
  
  function isBlockedByClosure(
    closures: Closure[],
    booking: { resourceId: number; date: string; startTime: string; endTime: string }
  ): { blocked: boolean; closureTitle?: string } {
    for (const closure of closures) {
      if (closure.date !== booking.date) continue;
      
      const affectsResource = closure.affectedResources === 'all' || 
        closure.affectedResources.includes(booking.resourceId);
      
      if (!affectsResource) continue;
      
      if (!closure.startTime || !closure.endTime) {
        return { blocked: true, closureTitle: closure.title || 'Facility Closure' };
      }
      
      const closureStart = parseTimeToMinutes(closure.startTime);
      const closureEnd = parseTimeToMinutes(closure.endTime);
      const bookingStart = parseTimeToMinutes(booking.startTime);
      const bookingEnd = parseTimeToMinutes(booking.endTime);
      
      if (hasTimeOverlap(closureStart, closureEnd, bookingStart, bookingEnd)) {
        return { blocked: true, closureTitle: closure.title || 'Facility Closure' };
      }
    }
    return { blocked: false };
  }
  
  it('should block bookings during full-day closure', () => {
    const closures: Closure[] = [
      { date: '2026-01-15', affectedResources: 'all', title: 'Holiday' }
    ];
    
    const booking = {
      resourceId: 1,
      date: '2026-01-15',
      startTime: '14:00',
      endTime: '15:00'
    };
    
    const result = isBlockedByClosure(closures, booking);
    expect(result.blocked).toBe(true);
    expect(result.closureTitle).toBe('Holiday');
  });
  
  it('should allow bookings on non-closure days', () => {
    const closures: Closure[] = [
      { date: '2026-01-15', affectedResources: 'all' }
    ];
    
    const booking = {
      resourceId: 1,
      date: '2026-01-16',
      startTime: '14:00',
      endTime: '15:00'
    };
    
    const result = isBlockedByClosure(closures, booking);
    expect(result.blocked).toBe(false);
  });
  
  it('should block only affected resources during partial closure', () => {
    const closures: Closure[] = [
      { date: '2026-01-15', affectedResources: [1, 2], startTime: '14:00', endTime: '18:00' }
    ];
    
    const blockedBooking = {
      resourceId: 1,
      date: '2026-01-15',
      startTime: '15:00',
      endTime: '16:00'
    };
    
    const allowedBooking = {
      resourceId: 3,
      date: '2026-01-15',
      startTime: '15:00',
      endTime: '16:00'
    };
    
    expect(isBlockedByClosure(closures, blockedBooking).blocked).toBe(true);
    expect(isBlockedByClosure(closures, allowedBooking).blocked).toBe(false);
  });
  
  it('should allow bookings outside closure time window', () => {
    const closures: Closure[] = [
      { date: '2026-01-15', affectedResources: 'all', startTime: '14:00', endTime: '18:00' }
    ];
    
    const morningBooking = {
      resourceId: 1,
      date: '2026-01-15',
      startTime: '10:00',
      endTime: '11:00'
    };
    
    const result = isBlockedByClosure(closures, morningBooking);
    expect(result.blocked).toBe(false);
  });
});

describe('Booking Validation - Reschedule Rules', () => {
  type BookingStatus = 'pending' | 'approved' | 'confirmed' | 'cancelled' | 'declined';
  
  function canReschedule(status: BookingStatus): boolean {
    return status === 'approved' || status === 'confirmed';
  }
  
  it('should allow reschedule of approved booking', () => {
    expect(canReschedule('approved')).toBe(true);
  });
  
  it('should allow reschedule of confirmed booking', () => {
    expect(canReschedule('confirmed')).toBe(true);
  });
  
  it('should not allow reschedule of pending booking', () => {
    expect(canReschedule('pending')).toBe(false);
  });
  
  it('should not allow reschedule of cancelled booking', () => {
    expect(canReschedule('cancelled')).toBe(false);
  });
  
  it('should not allow reschedule of declined booking', () => {
    expect(canReschedule('declined')).toBe(false);
  });
});
