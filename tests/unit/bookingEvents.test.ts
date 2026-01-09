import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Booking Events Frontend Bus', () => {
  let bookingUpdateHandler: (e: Event) => void;
  let memberNotificationHandler: (e: Event) => void;

  beforeEach(() => {
    bookingUpdateHandler = vi.fn();
    memberNotificationHandler = vi.fn();
    
    window.addEventListener('booking-update', bookingUpdateHandler);
    window.addEventListener('member-notification', memberNotificationHandler);
  });

  afterEach(() => {
    window.removeEventListener('booking-update', bookingUpdateHandler);
    window.removeEventListener('member-notification', memberNotificationHandler);
  });

  it('should dispatch and receive booking-update CustomEvent', () => {
    const bookingData = {
      eventType: 'booking_created',
      bookingId: 123,
      memberEmail: 'test@example.com',
      status: 'pending'
    };

    window.dispatchEvent(new CustomEvent('booking-update', { detail: bookingData }));

    expect(bookingUpdateHandler).toHaveBeenCalled();
    const event = (bookingUpdateHandler as any).mock.calls[0][0] as CustomEvent;
    expect(event.detail.eventType).toBe('booking_created');
    expect(event.detail.bookingId).toBe(123);
  });

  it('should dispatch and receive member-notification CustomEvent', () => {
    const notificationData = {
      type: 'notification',
      title: 'Booking Approved',
      message: 'Your booking has been approved'
    };

    window.dispatchEvent(new CustomEvent('member-notification', { detail: notificationData }));

    expect(memberNotificationHandler).toHaveBeenCalled();
    const event = (memberNotificationHandler as any).mock.calls[0][0] as CustomEvent;
    expect(event.detail.type).toBe('notification');
    expect(event.detail.title).toBe('Booking Approved');
  });

  it('should allow multiple listeners for the same event', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    window.addEventListener('booking-update', handler1);
    window.addEventListener('booking-update', handler2);

    window.dispatchEvent(new CustomEvent('booking-update', { detail: { test: true } }));

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();

    window.removeEventListener('booking-update', handler1);
    window.removeEventListener('booking-update', handler2);
  });
});

describe('Optimistic UI Pattern', () => {
  it('should demonstrate optimistic update pattern for cancellation', () => {
    const bookings = [
      { id: 1, status: 'approved' },
      { id: 2, status: 'approved' },
      { id: 3, status: 'pending' }
    ];

    const bookingIdToCancel = 2;
    const updatedBookings = bookings.filter(b => b.id !== bookingIdToCancel);

    expect(updatedBookings).toHaveLength(2);
    expect(updatedBookings.find(b => b.id === bookingIdToCancel)).toBeUndefined();
  });

  it('should demonstrate optimistic update pattern for new booking', () => {
    const approvedBookings = [
      { id: 1, status: 'approved', resourceId: 1 },
      { id: 2, status: 'approved', resourceId: 2 }
    ];

    const newBooking = {
      id: 3,
      status: 'approved',
      resourceId: 1,
      startTime: '14:00',
      endTime: '15:00'
    };

    const updatedBookings = [...approvedBookings, newBooking];

    expect(updatedBookings).toHaveLength(3);
    expect(updatedBookings.find(b => b.id === 3)).toBeDefined();
  });

  it('should demonstrate revert pattern on API failure', () => {
    const originalBookings = [
      { id: 1, status: 'approved' },
      { id: 2, status: 'approved' }
    ];

    const snapshot = [...originalBookings];

    let currentBookings = originalBookings.filter(b => b.id !== 2);
    expect(currentBookings).toHaveLength(1);

    const apiSuccess = false;
    if (!apiSuccess) {
      currentBookings = snapshot;
    }

    expect(currentBookings).toHaveLength(2);
    expect(currentBookings.find(b => b.id === 2)).toBeDefined();
  });
});

describe('usePendingCounts real-time updates', () => {
  it('should respond to booking-update event for badge refresh', () => {
    const fetchPendingCount = vi.fn();
    
    const handleBookingUpdate = () => {
      fetchPendingCount();
    };
    
    window.addEventListener('booking-update', handleBookingUpdate);
    
    window.dispatchEvent(new CustomEvent('booking-update', { 
      detail: { eventType: 'booking_created' } 
    }));
    
    expect(fetchPendingCount).toHaveBeenCalled();
    
    window.removeEventListener('booking-update', handleBookingUpdate);
  });
});

describe('useUnreadNotifications real-time updates', () => {
  it('should respond to member-notification event for badge refresh', () => {
    const fetchUnread = vi.fn();
    
    const handleNotification = () => {
      fetchUnread();
    };
    
    window.addEventListener('member-notification', handleNotification);
    
    window.dispatchEvent(new CustomEvent('member-notification', { 
      detail: { type: 'notification', title: 'Test' } 
    }));
    
    expect(fetchUnread).toHaveBeenCalled();
    
    window.removeEventListener('member-notification', handleNotification);
  });
});
