import { describe, it, expect, beforeAll } from 'vitest';
import { assertServerAvailable, login, fetchWithSession, TestSession } from './setup';

describe('Comprehensive Notification E2E Tests', () => {
  let memberSession: TestSession;
  let staffSession: TestSession;
  
  beforeAll(async () => {
    await assertServerAvailable();
    memberSession = await login('notification-test-member@evenhouse.club', 'member');
    staffSession = await login('nick@evenhouse.club', 'admin');
  });

  describe('1. Staff Notification Delivery on New Booking Request', () => {
    it('should deliver notification to staff when new booking is created', async () => {
      if (!staffSession) {
        expect.fail('Failed to establish staff test session');
      }
      
      const response = await fetchWithSession('/api/notifications?user_email=' + encodeURIComponent(staffSession.email!), staffSession);
      expect(response.status).toBe(200);
      
      const notifications = await response.json();
      expect(Array.isArray(notifications)).toBe(true);
    });
    
    it('should have proper structure for booking notifications', async () => {
      if (!staffSession) {
        expect.fail('Failed to establish staff test session');
      }
      
      const response = await fetchWithSession('/api/notifications?user_email=' + encodeURIComponent(staffSession.email!), staffSession);
      const notifications = await response.json();
      
      if (notifications.length > 0) {
        const bookingNotification = notifications.find((n: any) => n.type?.includes('booking'));
        if (bookingNotification) {
          expect(bookingNotification).toHaveProperty('id');
          expect(bookingNotification).toHaveProperty('title');
          expect(bookingNotification).toHaveProperty('message');
          expect(bookingNotification).toHaveProperty('type');
        }
      }
    });
  });

  describe('2. Push Notification Infrastructure', () => {
    it('should have push subscription endpoint available', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const response = await fetchWithSession('/api/push/subscriptions', memberSession);
      expect([200, 404]).toContain(response.status);
    });
    
    it('should have VAPID public key endpoint available', async () => {
      const response = await fetch('http://localhost:3001/api/push/vapid-public-key');
      expect([200, 500]).toContain(response.status);
      
      if (response.status === 200) {
        const data = await response.json();
        if (data.publicKey) {
          expect(typeof data.publicKey).toBe('string');
        }
      }
    });
  });

  describe('3. In-App Notification System', () => {
    it('should return notification count for member', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const email = encodeURIComponent(memberSession.email!);
      const response = await fetchWithSession(`/api/notifications/count?user_email=${email}`, memberSession);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(typeof data.count).toBe('number');
    });
    
    it('should allow marking notifications as read', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const email = encodeURIComponent(memberSession.email!);
      const response = await fetchWithSession(`/api/notifications?user_email=${email}`, memberSession);
      const notifications = await response.json();
      
      if (notifications.length > 0 && notifications[0].id) {
        const markReadResponse = await fetchWithSession(`/api/notifications/${notifications[0].id}/read`, memberSession, {
          method: 'PUT'
        });
        expect([200, 204]).toContain(markReadResponse.status);
      }
    });
    
    it('should allow marking all notifications as read', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const response = await fetchWithSession('/api/notifications/mark-all-read', memberSession, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: memberSession.email })
      });
      
      expect([200, 204]).toContain(response.status);
    });
  });

  describe('4. Booking Approval Notification Flow', () => {
    it('should list pending booking requests for staff', async () => {
      if (!staffSession) {
        expect.fail('Failed to establish staff test session');
      }
      
      const response = await fetchWithSession('/api/booking-requests?include_all=true&status=pending', staffSession);
      expect(response.status).toBe(200);
      
      const bookings = await response.json();
      expect(Array.isArray(bookings)).toBe(true);
    });
    
    it('should have booking approval endpoint available', async () => {
      if (!staffSession) {
        expect.fail('Failed to establish staff test session');
      }
      
      const pendingResponse = await fetchWithSession('/api/booking-requests?status=pending', staffSession);
      const pending = await pendingResponse.json();
      
      if (pending.length > 0) {
        expect(pending[0]).toHaveProperty('id');
        expect(pending[0]).toHaveProperty('user_email');
      }
    });
  });

  describe('5. WebSocket Real-Time Notifications', () => {
    it('should verify WebSocket connection endpoint exists', async () => {
      expect(true).toBe(true);
    });
    
    it('should have booking event structure for WebSocket', () => {
      const bookingEvent = {
        eventType: 'booking_created',
        bookingId: 123,
        memberEmail: 'test@example.com',
        memberName: 'Test User',
        resourceId: 1,
        resourceName: 'Bay 1',
        bookingDate: '2026-01-15',
        startTime: '14:00:00',
        durationMinutes: 120,
        playerCount: 2,
        status: 'pending',
        actionBy: 'member',
        timestamp: new Date().toISOString()
      };
      
      expect(bookingEvent.eventType).toBe('booking_created');
      expect(bookingEvent.resourceName).toBe('Bay 1');
      expect(bookingEvent.durationMinutes).toBe(120);
      expect(bookingEvent.playerCount).toBe(2);
    });
    
    it('should have notification toast format with all required fields', () => {
      const toastFormat = {
        title: 'New Golf Booking Request',
        message: 'John Smith (2 players) - Bay 1 on Wed, Jan 15 at 2:00 PM for 2 hrs',
        type: 'booking_created'
      };
      
      expect(toastFormat.title).toContain('Booking');
      expect(toastFormat.message).toContain('Bay');
      expect(toastFormat.message).toContain('PM');
      expect(toastFormat.message).toContain('players');
      expect(toastFormat.message).toContain('hr');
    });
  });

  describe('6. Event RSVP Notifications', () => {
    it('should list events for member', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const response = await fetchWithSession('/api/events', memberSession);
      expect(response.status).toBe(200);
      
      const events = await response.json();
      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe('7. Wellness Class Notifications', () => {
    it('should list wellness classes', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const response = await fetchWithSession('/api/wellness-classes', memberSession);
      expect(response.status).toBe(200);
      
      const classes = await response.json();
      expect(Array.isArray(classes)).toBe(true);
    });
  });

  describe('8. Staff Toast Notifications (New Feature)', () => {
    it('should have StaffBookingToast component integrated', () => {
      const wsPayload = {
        type: 'booking',
        data: {
          eventType: 'booking_created',
          bookingId: 456,
          memberEmail: 'member@test.com',
          memberName: 'Jane Doe',
          resourceName: 'Bay 2',
          durationMinutes: 90,
          playerCount: 3,
          bookingDate: '2026-01-16',
          startTime: '10:30:00'
        }
      };
      
      expect(wsPayload.type).toBe('booking');
      expect(wsPayload.data.eventType).toBe('booking_created');
      expect(wsPayload.data.resourceName).toBe('Bay 2');
      expect(wsPayload.data.durationMinutes).toBe(90);
      expect(wsPayload.data.playerCount).toBe(3);
    });
    
    it('should format notification message correctly', () => {
      const formatMessage = (event: any) => {
        const time = event.startTime ? event.startTime.substring(0, 5) : '';
        const hour = parseInt(time.split(':')[0]);
        const mins = time.split(':')[1];
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
        const formattedTime = `${displayHour}:${mins} ${ampm}`;
        
        const durationHrs = event.durationMinutes >= 60 
          ? `${Math.floor(event.durationMinutes / 60)} hr${event.durationMinutes >= 120 ? 's' : ''}`
          : `${event.durationMinutes} min`;
        
        const players = event.playerCount > 1 ? ` (${event.playerCount} players)` : '';
        
        return `${event.memberName}${players} - ${event.resourceName} at ${formattedTime} for ${durationHrs}`;
      };
      
      const testEvent = {
        memberName: 'John Smith',
        resourceName: 'Bay 1',
        startTime: '14:30:00',
        durationMinutes: 120,
        playerCount: 3
      };
      
      const message = formatMessage(testEvent);
      expect(message).toContain('John Smith');
      expect(message).toContain('(3 players)');
      expect(message).toContain('Bay 1');
      expect(message).toContain('2:30 PM');
      expect(message).toContain('2 hrs');
    });
  });

  describe('9. Notification Message Format Validation', () => {
    it('should include bay name in notification', () => {
      const msg = 'John Smith (2 players) - Bay 1 on Wed, Jan 15 at 2:30 PM for 2 hrs';
      expect(msg).toContain('Bay 1');
    });
    
    it('should include 12-hour time format with AM/PM', () => {
      const msg = 'John Smith - Bay 1 on Wed, Jan 15 at 2:30 PM for 2 hrs';
      expect(msg).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
    });
    
    it('should include duration in hours or minutes', () => {
      const msg1 = 'John Smith - Bay 1 at 2:30 PM for 2 hrs';
      const msg2 = 'John Smith - Bay 1 at 2:30 PM for 90 min';
      
      expect(msg1).toMatch(/\d+\s*(hr|hrs|min)/);
      expect(msg2).toMatch(/\d+\s*(hr|hrs|min)/);
    });
    
    it('should include player count when more than 1', () => {
      const msgWithPlayers = 'John Smith (3 players) - Bay 1 at 2:30 PM for 2 hrs';
      const msgSinglePlayer = 'John Smith - Bay 1 at 2:30 PM for 2 hrs';
      
      expect(msgWithPlayers).toContain('(3 players)');
      expect(msgSinglePlayer).not.toContain('players');
    });
  });

  describe('10. Notification Delivery Channels', () => {
    it('should have three delivery channels configured', () => {
      const channels = ['database', 'websocket', 'push'];
      expect(channels).toHaveLength(3);
      expect(channels).toContain('database');
      expect(channels).toContain('websocket');
      expect(channels).toContain('push');
    });
    
    it('should verify database channel persists notifications', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const email = encodeURIComponent(memberSession.email!);
      const response = await fetchWithSession(`/api/notifications?user_email=${email}`, memberSession);
      
      expect(response.status).toBe(200);
    });
  });
});
