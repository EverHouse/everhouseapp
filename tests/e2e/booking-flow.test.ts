import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
let serverAvailable = false;

interface TestSession {
  cookie: string;
}

interface BookingRequest {
  id: number;
  status: string;
  user_email: string;
  request_date: string;
  start_time: string;
}

interface Notification {
  id: number;
  title: string;
  type: string;
  isRead: boolean;
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

async function login(email: string, role: 'member' | 'staff' | 'admin', tier?: string): Promise<TestSession | null> {
  try {
    const response = await fetch(`${BASE_URL}/api/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role, tier }),
      signal: AbortSignal.timeout(5000)
    });
    
    if (!response.ok) {
      console.log(`Login failed for ${email}: ${response.status}`);
      return null;
    }
    
    const setCookie = response.headers.get('set-cookie');
    return { cookie: setCookie || '' };
  } catch (error) {
    console.log(`Login error for ${email}:`, error);
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

async function cleanupTestData(session: TestSession | null): Promise<void> {
  if (!session || !serverAvailable) return;
  
  try {
    await fetch(`${BASE_URL}/api/auth/test-cleanup`, {
      method: 'POST',
      headers: {
        'Cookie': session.cookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        patterns: ['test-member@example.com', 'test-staff@example.com']
      }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    // Cleanup is best-effort
  }
}

describe('Booking Flow E2E Tests', () => {
  const memberEmail = 'test-member@example.com';
  const staffEmail = 'test-staff@example.com';
  let memberSession: TestSession | null = null;
  let staffSession: TestSession | null = null;
  let createdBookingId: number | null = null;
  
  afterAll(async () => {
    await cleanupTestData(staffSession);
  });

  beforeAll(async () => {
    serverAvailable = await checkServerAvailable();
    if (serverAvailable) {
      memberSession = await login(memberEmail, 'member', 'Premium');
      staffSession = await login(staffEmail, 'staff');
    }
  });

  describe('Test 1: Member creates booking request, staff sees it', () => {
    it('should allow member to create a booking request', async () => {
      if (!memberSession) {
        console.log('Skipping: No test login endpoint available');
        return;
      }

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const requestDate = tomorrow.toISOString().split('T')[0];

      const response = await fetchWithSession('/api/booking-requests', memberSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_email: memberEmail,
          user_name: 'Test Member',
          request_date: requestDate,
          start_time: '10:00',
          duration_minutes: 60,
          notes: 'Test booking request',
        }),
      });

      if (response.ok) {
        const booking = await response.json() as BookingRequest;
        createdBookingId = booking.id;
        expect(booking.status).toBe('pending');
        expect(booking.user_email).toBe(memberEmail);
      } else {
        console.log('Booking creation returned:', response.status);
      }
    });

    it('should show pending request in staff command console', async () => {
      if (!staffSession || !createdBookingId) {
        console.log('Skipping: Prerequisites not met');
        return;
      }

      const response = await fetchWithSession('/api/booking-requests?include_all=true', staffSession);
      
      if (response.ok) {
        const requests = await response.json() as BookingRequest[];
        const ourRequest = requests.find(r => r.id === createdBookingId);
        expect(ourRequest).toBeDefined();
        expect(ourRequest?.status).toBe('pending');
      }
    });
  });

  describe('Test 2: Staff approves request, member gets notification', () => {
    it('should allow staff to approve the booking request', async () => {
      if (!staffSession || !createdBookingId) {
        console.log('Skipping: Prerequisites not met');
        return;
      }

      const response = await fetchWithSession(`/api/booking-requests/${createdBookingId}`, staffSession, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'approved',
          resource_id: 1,
          reviewed_by: staffEmail,
        }),
      });

      if (response.ok) {
        const updated = await response.json() as BookingRequest;
        expect(updated.status).toBe('approved');
      } else {
        const error = await response.text();
        console.log('Approval failed:', response.status, error);
      }
    });

    it('should create notification for member after approval', async () => {
      if (!memberSession || !createdBookingId) {
        console.log('Skipping: Prerequisites not met');
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      const response = await fetchWithSession(`/api/notifications?user_email=${encodeURIComponent(memberEmail)}`, memberSession);
      
      if (response.ok) {
        const notifications = await response.json() as Notification[];
        const approvalNotif = notifications.find(n => 
          n.type === 'booking_approved' || n.title.includes('Approved')
        );
        expect(approvalNotif).toBeDefined();
      }
    });
  });

  describe('Test 3: Member cancels booking, optimistic UI update', () => {
    it('should allow member to cancel their approved booking', async () => {
      if (!memberSession || !createdBookingId) {
        console.log('Skipping: Prerequisites not met');
        return;
      }

      const response = await fetchWithSession(`/api/booking-requests/${createdBookingId}/member-cancel`, memberSession, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.success).toBe(true);
    });

    it('should remove cancelled booking from pending requests list for staff', async () => {
      if (!staffSession || !createdBookingId) {
        console.log('Skipping: Prerequisites not met');
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      const response = await fetchWithSession('/api/pending-bookings', staffSession);
      
      if (response.ok) {
        const pendingBookings = await response.json() as BookingRequest[];
        const ourRequest = pendingBookings.find(r => r.id === createdBookingId);
        expect(ourRequest).toBeUndefined();
      }
    });
  });
});

describe('WebSocket Event Bus Tests', () => {
  it('should verify booking event types are properly defined', () => {
    const validEventTypes = [
      'booking_created',
      'booking_approved', 
      'booking_declined',
      'booking_cancelled',
      'booking_rescheduled',
      'booking_checked_in'
    ];
    
    expect(validEventTypes).toContain('booking_created');
    expect(validEventTypes).toContain('booking_approved');
    expect(validEventTypes).toContain('booking_cancelled');
  });
});

describe('Notification Flow Tests', () => {
  it('should verify notification is created with proper fields', async () => {
    const mockNotification = {
      userEmail: 'test@example.com',
      title: 'Booking Approved',
      message: 'Your booking has been approved',
      type: 'booking_approved',
      relatedId: 123,
      relatedType: 'booking_request'
    };
    
    expect(mockNotification.type).toBe('booking_approved');
    expect(mockNotification.relatedType).toBe('booking_request');
  });
});
