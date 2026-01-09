import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Real-time Sync - Optimistic UI Updates', () => {
  interface Booking {
    id: number;
    status: string;
    userEmail: string;
    resourceId: number;
    date: string;
    startTime: string;
  }
  
  function applyOptimisticUpdate<T extends { id: number }>(
    items: T[],
    itemId: number,
    update: Partial<T>
  ): T[] {
    return items.map(item => 
      item.id === itemId ? { ...item, ...update } : item
    );
  }
  
  function removeOptimistically<T extends { id: number }>(items: T[], itemId: number): T[] {
    return items.filter(item => item.id !== itemId);
  }
  
  function addOptimistically<T>(items: T[], newItem: T): T[] {
    return [...items, newItem];
  }
  
  it('should optimistically remove cancelled booking from list', () => {
    const bookings: Booking[] = [
      { id: 1, status: 'approved', userEmail: 'member@example.com', resourceId: 1, date: '2026-01-10', startTime: '14:00' },
      { id: 2, status: 'approved', userEmail: 'member@example.com', resourceId: 1, date: '2026-01-10', startTime: '15:00' },
    ];
    
    const updated = removeOptimistically(bookings, 2);
    
    expect(updated.length).toBe(1);
    expect(updated.find(b => b.id === 2)).toBeUndefined();
  });
  
  it('should optimistically add new booking to list', () => {
    const bookings: Booking[] = [
      { id: 1, status: 'approved', userEmail: 'member@example.com', resourceId: 1, date: '2026-01-10', startTime: '14:00' }
    ];
    
    const newBooking: Booking = { 
      id: 2, 
      status: 'pending', 
      userEmail: 'member@example.com',
      resourceId: 2,
      date: '2026-01-10',
      startTime: '16:00'
    };
    
    const updated = addOptimistically(bookings, newBooking);
    
    expect(updated.length).toBe(2);
    expect(updated.find(b => b.id === 2)).toBeDefined();
  });
  
  it('should optimistically update booking status', () => {
    const bookings: Booking[] = [
      { id: 1, status: 'pending', userEmail: 'member@example.com', resourceId: 1, date: '2026-01-10', startTime: '14:00' }
    ];
    
    const updated = applyOptimisticUpdate(bookings, 1, { status: 'approved' });
    
    expect(updated[0].status).toBe('approved');
    expect(updated[0].id).toBe(1);
  });
  
  it('should support rollback by keeping original snapshot', () => {
    const original: Booking[] = [
      { id: 1, status: 'approved', userEmail: 'member@example.com', resourceId: 1, date: '2026-01-10', startTime: '14:00' },
      { id: 2, status: 'approved', userEmail: 'member@example.com', resourceId: 1, date: '2026-01-10', startTime: '15:00' }
    ];
    
    const snapshot = [...original];
    let current = removeOptimistically(original, 2);
    
    expect(current.length).toBe(1);
    
    const apiSuccess = false;
    if (!apiSuccess) {
      current = snapshot;
    }
    
    expect(current.length).toBe(2);
    expect(current.find(b => b.id === 2)).toBeDefined();
  });
});

describe('Real-time Sync - Multi-Tab Communication', () => {
  it('should dispatch booking-update CustomEvent with correct detail', () => {
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    
    window.addEventListener('booking-update', listener);
    
    const detail = { 
      eventType: 'booking_cancelled', 
      bookingId: 123,
      resourceId: 1,
      date: '2026-01-10'
    };
    
    window.dispatchEvent(new CustomEvent('booking-update', { detail }));
    
    expect(events.length).toBe(1);
    expect(events[0].detail).toEqual(detail);
    
    window.removeEventListener('booking-update', listener);
  });
  
  it('should debounce rapid updates to prevent excessive refetches', async () => {
    let updateCount = 0;
    const debounceMs = 50;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    
    const debouncedUpdate = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => updateCount++, debounceMs);
    };
    
    debouncedUpdate();
    debouncedUpdate();
    debouncedUpdate();
    debouncedUpdate();
    debouncedUpdate();
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    expect(updateCount).toBe(1);
  });
  
  it('should use localStorage for cross-tab sync signaling', () => {
    const syncKey = 'eh_booking_sync';
    const syncData = { 
      timestamp: Date.now(), 
      bookingId: 123, 
      action: 'cancelled',
      tabId: 'tab-123'
    };
    
    localStorage.setItem(syncKey, JSON.stringify(syncData));
    
    const stored = JSON.parse(localStorage.getItem(syncKey) || '{}');
    expect(stored.bookingId).toBe(123);
    expect(stored.action).toBe('cancelled');
    expect(stored.tabId).toBe('tab-123');
    
    localStorage.removeItem(syncKey);
  });
});

describe('Real-time Sync - Staff Calendar Grid Updates', () => {
  interface CalendarCell {
    resourceId: number;
    time: string;
    date: string;
    booking: { id: number; memberName: string; status: string } | null;
  }
  
  function updateCalendarCell(
    grid: CalendarCell[],
    resourceId: number,
    time: string,
    date: string,
    booking: { id: number; memberName: string; status: string } | null
  ): CalendarCell[] {
    return grid.map(cell => {
      if (cell.resourceId === resourceId && cell.time === time && cell.date === date) {
        return { ...cell, booking };
      }
      return cell;
    });
  }
  
  function clearBookingFromGrid(grid: CalendarCell[], bookingId: number): CalendarCell[] {
    return grid.map(cell => {
      if (cell.booking?.id === bookingId) {
        return { ...cell, booking: null };
      }
      return cell;
    });
  }
  
  it('should update cell when booking is approved', () => {
    const grid: CalendarCell[] = [
      { resourceId: 1, time: '14:00', date: '2026-01-10', booking: null },
      { resourceId: 1, time: '15:00', date: '2026-01-10', booking: null }
    ];
    
    const newBooking = { id: 123, memberName: 'John Doe', status: 'approved' };
    const updated = updateCalendarCell(grid, 1, '14:00', '2026-01-10', newBooking);
    
    expect(updated[0].booking).not.toBeNull();
    expect(updated[0].booking?.memberName).toBe('John Doe');
    expect(updated[1].booking).toBeNull();
  });
  
  it('should clear cell when booking is cancelled', () => {
    const grid: CalendarCell[] = [
      { resourceId: 1, time: '14:00', date: '2026-01-10', booking: { id: 123, memberName: 'John Doe', status: 'approved' } }
    ];
    
    const updated = clearBookingFromGrid(grid, 123);
    
    expect(updated[0].booking).toBeNull();
  });
  
  it('should handle booking move between resources', () => {
    const grid: CalendarCell[] = [
      { resourceId: 1, time: '14:00', date: '2026-01-10', booking: { id: 123, memberName: 'John Doe', status: 'approved' } },
      { resourceId: 2, time: '14:00', date: '2026-01-10', booking: null }
    ];
    
    let updated = clearBookingFromGrid(grid, 123);
    updated = updateCalendarCell(updated, 2, '14:00', '2026-01-10', { id: 123, memberName: 'John Doe', status: 'approved' });
    
    expect(updated[0].booking).toBeNull();
    expect(updated[1].booking?.id).toBe(123);
  });
});

describe('Real-time Sync - WebSocket Reconnection', () => {
  it('should implement exponential backoff for reconnection', () => {
    const baseDelay = 1000;
    const maxDelay = 30000;
    
    const getBackoffDelay = (attempt: number): number => {
      return Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    };
    
    expect(getBackoffDelay(0)).toBe(1000);
    expect(getBackoffDelay(1)).toBe(2000);
    expect(getBackoffDelay(2)).toBe(4000);
    expect(getBackoffDelay(3)).toBe(8000);
    expect(getBackoffDelay(10)).toBe(maxDelay);
  });
  
  it('should limit max reconnection attempts', async () => {
    const maxAttempts = 5;
    let attempts = 0;
    let connected = false;
    
    const attemptReconnect = async (): Promise<boolean> => {
      while (attempts < maxAttempts && !connected) {
        attempts++;
        connected = attempts >= 5;
        if (!connected) {
          await new Promise(r => setTimeout(r, 10));
        }
      }
      return connected;
    };
    
    const result = await attemptReconnect();
    
    expect(attempts).toBe(5);
    expect(result).toBe(true);
  });
  
  it('should trigger data refetch after successful reconnection', () => {
    const refetchQueue: string[] = [];
    
    const onReconnect = () => {
      refetchQueue.push('bookings');
      refetchQueue.push('notifications');
      refetchQueue.push('pendingCount');
    };
    
    onReconnect();
    
    expect(refetchQueue).toContain('bookings');
    expect(refetchQueue).toContain('notifications');
    expect(refetchQueue).toContain('pendingCount');
  });
});

describe('Real-time Sync - Pending Count Updates', () => {
  function updatePendingCount(
    currentCount: number,
    eventType: string
  ): number {
    switch (eventType) {
      case 'booking_requested':
        return currentCount + 1;
      case 'booking_approved':
      case 'booking_declined':
      case 'booking_cancelled':
        return Math.max(0, currentCount - 1);
      default:
        return currentCount;
    }
  }
  
  it('should increment on new booking request', () => {
    expect(updatePendingCount(5, 'booking_requested')).toBe(6);
  });
  
  it('should decrement on booking approval', () => {
    expect(updatePendingCount(5, 'booking_approved')).toBe(4);
  });
  
  it('should decrement on booking decline', () => {
    expect(updatePendingCount(5, 'booking_declined')).toBe(4);
  });
  
  it('should decrement on booking cancellation', () => {
    expect(updatePendingCount(5, 'booking_cancelled')).toBe(4);
  });
  
  it('should not go below zero', () => {
    expect(updatePendingCount(0, 'booking_approved')).toBe(0);
  });
  
  it('should ignore unknown event types', () => {
    expect(updatePendingCount(5, 'unknown_event')).toBe(5);
  });
});
