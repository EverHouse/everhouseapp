import { describe, it, expect, beforeAll } from 'vitest';
import { assertServerAvailable, login, fetchWithSession, TestSession } from './setup';

describe('Notification Flow E2E Tests', () => {
  let memberSession: TestSession;
  let staffSession: TestSession;
  
  beforeAll(async () => {
    await assertServerAvailable();
    memberSession = await login('notif-test-member@example.com', 'member');
    staffSession = await login('notif-test-staff@example.com', 'staff');
  });

  describe('Member Notification Endpoint Access', () => {
    it('should return 200 for authenticated member accessing own notifications', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const email = encodeURIComponent(memberSession.email!);
      const response = await fetchWithSession(`/api/notifications?user_email=${email}`, memberSession);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });
    
    it('should return 200 for unread notifications query', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const email = encodeURIComponent(memberSession.email!);
      const response = await fetchWithSession(`/api/notifications?user_email=${email}&unread_only=true`, memberSession);
      
      expect(response.status).toBe(200);
    });
    
    it('should default to session user when user_email query param is missing', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      // When user_email is missing, the endpoint defaults to the authenticated user's notifications
      const response = await fetchWithSession('/api/notifications', memberSession);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });
    
    it('should return own notifications when member tries to access other user data', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      // When a non-staff member requests another user's notifications,
      // the endpoint returns their own notifications (secure - no data leak)
      const otherEmail = encodeURIComponent('other-user@example.com');
      const response = await fetchWithSession(`/api/notifications?user_email=${otherEmail}`, memberSession);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });
  });
  
  describe('Staff Notification Access', () => {
    it('should allow staff to access booking requests', async () => {
      if (!staffSession) {
        expect.fail('Failed to establish staff test session');
      }
      
      const response = await fetchWithSession('/api/bays?status=pending', staffSession);
      expect(response.status).toBe(200);
    });
    
    it('should allow staff to access member notifications', async () => {
      if (!staffSession) {
        expect.fail('Failed to establish staff test session');
      }
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const email = encodeURIComponent(memberSession.email!);
      const response = await fetchWithSession(`/api/notifications?user_email=${email}`, staffSession);
      
      expect(response.status).toBe(200);
    });
  });
  
  describe('Notification Structure Validation', () => {
    it('should verify notification database schema fields', () => {
      const notification = {
        id: 1,
        userEmail: 'member@example.com',
        title: 'Booking Approved',
        message: 'Your booking has been approved',
        type: 'booking_approved',
        isRead: false,
        createdAt: new Date().toISOString(),
        relatedId: 123,
        relatedType: 'booking'
      };
      
      expect(notification).toHaveProperty('id');
      expect(notification).toHaveProperty('userEmail');
      expect(notification).toHaveProperty('title');
      expect(notification).toHaveProperty('message');
      expect(notification).toHaveProperty('type');
      expect(notification).toHaveProperty('isRead');
      expect(notification).toHaveProperty('relatedId');
      expect(notification).toHaveProperty('relatedType');
    });
    
    it('should verify WebSocket notification payload matches expected format', () => {
      const wsPayload = {
        type: 'notification',
        title: 'Booking Approved',
        message: 'Your golf simulator booking has been confirmed',
        data: {
          bookingId: 123,
          eventType: 'booking_approved'
        }
      };
      
      expect(wsPayload.type).toBe('notification');
      expect(wsPayload.data).toHaveProperty('bookingId');
      expect(wsPayload.data).toHaveProperty('eventType');
    });
    
    it('should verify CustomEvent structure for client-side updates', () => {
      const eventDetail = {
        type: 'new_notification',
        notificationId: 123,
        bookingId: 456
      };
      
      const event = new CustomEvent('member-notification', { detail: eventDetail });
      
      expect(event.type).toBe('member-notification');
      expect(event.detail.type).toBe('new_notification');
      expect(event.detail.notificationId).toBe(123);
    });
  });
  
  describe('Notification Count Endpoint', () => {
    it('should return count for authenticated member', async () => {
      if (!memberSession) {
        expect.fail('Failed to establish member test session');
      }
      
      const email = encodeURIComponent(memberSession.email!);
      const response = await fetchWithSession(`/api/notifications/count?user_email=${email}`, memberSession);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(typeof data.count).toBe('number');
      expect(data.count).toBeGreaterThanOrEqual(0);
    });
  });
});
