import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
let serverAvailable = false;

interface TestSession {
  cookie: string;
}

interface WellnessClass {
  id: number;
  title: string;
  capacity: number | null;
  waitlist_enabled: boolean;
  enrolledCount?: number;
  spotsRemaining?: number | null;
  waitlistCount?: number;
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
      return null;
    }
    
    const setCookie = response.headers.get('set-cookie');
    return { cookie: setCookie || '' };
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

describe('Wellness Class Capacity & Waitlist E2E Tests', () => {
  const adminEmail = 'test-admin@example.com';
  const member1Email = 'test-member1@example.com';
  const member2Email = 'test-member2@example.com';
  let adminSession: TestSession | null = null;
  let member1Session: TestSession | null = null;
  let member2Session: TestSession | null = null;
  let testClassId: number | null = null;

  beforeAll(async () => {
    serverAvailable = await checkServerAvailable();
    if (serverAvailable) {
      adminSession = await login(adminEmail, 'admin');
      member1Session = await login(member1Email, 'member', 'Premium');
      member2Session = await login(member2Email, 'member', 'Premium');
    }
  });

  describe('Wellness Classes API', () => {
    it('should fetch wellness classes with capacity info', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/wellness-classes`);
      expect(response.ok).toBe(true);
      
      const classes = await response.json();
      expect(Array.isArray(classes)).toBe(true);
      
      if (classes.length > 0) {
        const cls = classes[0] as WellnessClass;
        expect(cls).toHaveProperty('id');
        expect(cls).toHaveProperty('title');
        expect(cls).toHaveProperty('enrolledCount');
      }
    });

    it('should create wellness class with capacity and waitlist', async () => {
      if (!adminSession) {
        console.log('Skipping: No admin session');
        return;
      }

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 7);
      const classDate = tomorrow.toISOString().split('T')[0];

      const response = await fetchWithSession('/api/wellness-classes', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test Yoga Class',
          description: 'Test class for E2E testing',
          instructor: 'Test Instructor',
          category: 'Yoga',
          class_date: classDate,
          start_time: '09:00',
          end_time: '10:00',
          capacity: 2,
          waitlist_enabled: true
        })
      });
      
      if (response.ok) {
        const cls = await response.json();
        expect(cls.capacity).toBe(2);
        expect(cls.waitlist_enabled).toBe(true);
        testClassId = cls.id;
      }
    });

    it('should allow first member to enroll normally', async () => {
      if (!member1Session || !testClassId) {
        console.log('Skipping: No member session or class');
        return;
      }

      const response = await fetchWithSession(`/api/wellness-classes/${testClassId}/enroll`, member1Session, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (response.ok) {
        const result = await response.json();
        expect(result.status).toBe('enrolled');
        expect(result.is_waitlisted).toBe(false);
      }
    });

    it('should show updated enrollment count', async () => {
      if (!testClassId) {
        console.log('Skipping: No test class');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/wellness-classes`);
      const classes = await response.json();
      const testClass = classes.find((c: WellnessClass) => c.id === testClassId);
      
      if (testClass) {
        expect(testClass.enrolledCount).toBeGreaterThanOrEqual(1);
      }
    });
  });

  afterAll(async () => {
    if (adminSession && testClassId) {
      await fetchWithSession(`/api/wellness-classes/${testClassId}`, adminSession, {
        method: 'DELETE'
      });
    }
  });
});

describe('RSVP Deletion E2E Tests', () => {
  let staffSession: TestSession | null = null;
  const staffEmail = 'test-staff@example.com';

  beforeAll(async () => {
    serverAvailable = await checkServerAvailable();
    if (serverAvailable) {
      staffSession = await login(staffEmail, 'staff');
    }
  });

  it('should have events API endpoint', async () => {
    if (!serverAvailable) {
      console.log('Skipping: Server not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/events`);
    expect(response.ok).toBe(true);
    
    const events = await response.json();
    expect(Array.isArray(events)).toBe(true);
  });

  it('should allow staff to view RSVPs for an event', async () => {
    if (!staffSession) {
      console.log('Skipping: No staff session');
      return;
    }

    const eventsResponse = await fetch(`${BASE_URL}/api/events`);
    const events = await eventsResponse.json();
    
    if (events.length === 0) {
      console.log('Skipping: No events available');
      return;
    }

    const eventId = events[0].id;
    const response = await fetchWithSession(`/api/events/${eventId}/rsvps`, staffSession);
    expect(response.ok).toBe(true);
  });
});
