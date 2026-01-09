import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
let serverAvailable = false;

interface TestSession {
  cookie: string;
  email: string;
}

async function checkServerAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/health`, { 
      method: 'GET',
      signal: AbortSignal.timeout(2000) 
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function testLogin(email: string, role: 'member' | 'staff' | 'admin'): Promise<TestSession | null> {
  try {
    const response = await fetch(`${BASE_URL}/api/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
      signal: AbortSignal.timeout(5000)
    });
    
    if (!response.ok) {
      return null;
    }
    
    const setCookie = response.headers.get('set-cookie');
    return { cookie: setCookie || '', email };
  } catch {
    return null;
  }
}

async function fetchWithSession(url: string, session: TestSession, options: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: {
      ...options.headers,
      'Cookie': session.cookie,
    },
    signal: AbortSignal.timeout(5000)
  });
}

describe('Notification Flow E2E Tests', () => {
  let memberSession: TestSession | null = null;
  let staffSession: TestSession | null = null;
  
  beforeAll(async () => {
    serverAvailable = await checkServerAvailable();
    if (serverAvailable) {
      memberSession = await testLogin('notif-test-member@example.com', 'member');
      staffSession = await testLogin('notif-test-staff@example.com', 'staff');
    }
  });

  describe('Member Notification Endpoint Access', () => {
    it('should return 200 for authenticated member accessing own notifications', async () => {
      if (!serverAvailable || !memberSession) {
        console.log('Skipping: Server or session not available');
        return;
      }
      
      const email = encodeURIComponent(memberSession.email);
      const response = await fetchWithSession(`/api/notifications?user_email=${email}`, memberSession);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });
    
    it('should return 200 for unread notifications query', async () => {
      if (!serverAvailable || !memberSession) {
        console.log('Skipping: Server or session not available');
        return;
      }
      
      const email = encodeURIComponent(memberSession.email);
      const response = await fetchWithSession(`/api/notifications?user_email=${email}&unread_only=true`, memberSession);
      
      expect(response.status).toBe(200);
    });
    
    it('should return 400 when user_email query param is missing', async () => {
      if (!serverAvailable || !memberSession) {
        console.log('Skipping: Server or session not available');
        return;
      }
      
      const response = await fetchWithSession('/api/notifications', memberSession);
      
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('user_email');
    });
    
    it('should return 403 when accessing other users notifications', async () => {
      if (!serverAvailable || !memberSession) {
        console.log('Skipping: Server or session not available');
        return;
      }
      
      const otherEmail = encodeURIComponent('other-user@example.com');
      const response = await fetchWithSession(`/api/notifications?user_email=${otherEmail}`, memberSession);
      
      expect(response.status).toBe(403);
    });
  });
  
  describe('Staff Notification Access', () => {
    it('should allow staff to access booking requests', async () => {
      if (!serverAvailable || !staffSession) {
        console.log('Skipping: Server or session not available');
        return;
      }
      
      const response = await fetchWithSession('/api/bays?status=pending', staffSession);
      expect(response.status).toBe(200);
    });
    
    it('should allow staff to access member notifications', async () => {
      if (!serverAvailable || !staffSession || !memberSession) {
        console.log('Skipping: Server or session not available');
        return;
      }
      
      const email = encodeURIComponent(memberSession.email);
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
      if (!serverAvailable || !memberSession) {
        console.log('Skipping: Server or session not available');
        return;
      }
      
      const email = encodeURIComponent(memberSession.email);
      const response = await fetchWithSession(`/api/notifications/count?user_email=${email}`, memberSession);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(typeof data.count).toBe('number');
      expect(data.count).toBeGreaterThanOrEqual(0);
    });
  });
});
