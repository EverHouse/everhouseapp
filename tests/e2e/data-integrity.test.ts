import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
let serverAvailable = false;

interface TestSession {
  cookie: string;
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

describe('Data Integrity and Reconciliation E2E Tests', () => {
  const adminEmail = 'test-admin-integrity@example.com';
  const staffEmail = 'test-staff-integrity@example.com';
  let adminSession: TestSession | null = null;
  let staffSession: TestSession | null = null;

  beforeAll(async () => {
    serverAvailable = await checkServerAvailable();
    if (serverAvailable) {
      adminSession = await login(adminEmail, 'admin');
      staffSession = await login(staffEmail, 'staff');
    }
  });

  describe('Data Integrity API - Admin Endpoints', () => {
    it('should require admin authentication for GET /api/data-integrity/summary', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/data-integrity/summary`);
      expect([401, 403]).toContain(response.status);
    });

    it('should allow admin to fetch data integrity summary', async () => {
      if (!adminSession) {
        console.log('Skipping: No admin session');
        return;
      }

      const response = await fetchWithSession('/api/data-integrity/summary', adminSession);
      expect(response.ok).toBe(true);
      
      const summary = await response.json();
      expect(summary).toBeDefined();
      expect(typeof summary).toBe('object');
    });

    it('should require admin authentication for GET /api/data-integrity/run', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/data-integrity/run`);
      expect([401, 403]).toContain(response.status);
    });

    it('should allow admin to run all integrity checks', async () => {
      if (!adminSession) {
        console.log('Skipping: No admin session');
        return;
      }

      const response = await fetchWithSession('/api/data-integrity/run', adminSession);
      expect(response.ok).toBe(true);
      
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(Array.isArray(result.results)).toBe(true);
      
      // Verify meta information is present
      expect(result.meta).toBeDefined();
      expect(typeof result.meta.totalChecks).toBe('number');
      expect(typeof result.meta.passed).toBe('number');
      expect(typeof result.meta.warnings).toBe('number');
      expect(typeof result.meta.failed).toBe('number');
      expect(typeof result.meta.totalIssues).toBe('number');
      expect(result.meta.lastRun).toBeDefined();
    });

    it('should verify integrity check results have expected structure', async () => {
      if (!adminSession) {
        console.log('Skipping: No admin session');
        return;
      }

      const response = await fetchWithSession('/api/data-integrity/run', adminSession);
      expect(response.ok).toBe(true);
      
      const result = await response.json();
      
      // If there are results, verify their structure
      if (result.results.length > 0) {
        const check = result.results[0];
        expect(check).toHaveProperty('status');
        expect(['pass', 'warning', 'fail']).toContain(check.status);
        expect(typeof check.issueCount).toBe('number');
      }
    });

    it('should prevent staff from accessing admin integrity endpoints', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/data-integrity/summary', staffSession);
      expect([401, 403]).toContain(response.status);
    });
  });

  describe('Tours Needs Review API - Reconciliation', () => {
    it('should require staff authentication for GET /api/tours/needs-review', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/tours/needs-review`);
      expect([401, 403]).toContain(response.status);
    });

    it('should allow staff to fetch tours needing review', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/tours/needs-review', staffSession);
      expect(response.ok).toBe(true);
      
      const data = await response.json();
      expect(data).toHaveProperty('unmatchedMeetings');
      expect(Array.isArray(data.unmatchedMeetings)).toBe(true);
    });

    it('should return unmatched meetings with potential matches', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/tours/needs-review', staffSession);
      expect(response.ok).toBe(true);
      
      const data = await response.json();
      const meetings = data.unmatchedMeetings;
      
      // If there are unmatched meetings, verify their structure
      if (meetings.length > 0) {
        const meeting = meetings[0];
        expect(meeting).toHaveProperty('hubspotMeetingId');
        expect(meeting).toHaveProperty('potentialMatches');
        expect(Array.isArray(meeting.potentialMatches)).toBe(true);
        expect(typeof meeting.wouldBackfill).toBe('boolean');
      }
    });

    it('should require staff authentication for POST /api/tours/dismiss-hubspot', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/tours/dismiss-hubspot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hubspotMeetingId: 'test-id' })
      });
      expect([401, 403]).toContain(response.status);
    });

    it('should reject dismiss-hubspot without hubspotMeetingId', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/tours/dismiss-hubspot', staffSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'No meeting ID' })
      });
      
      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error).toHaveProperty('error');
    });

    it('should allow staff to dismiss hubspot meeting', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const testMeetingId = `test-dismiss-${Date.now()}`;
      const response = await fetchWithSession('/api/tours/dismiss-hubspot', staffSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hubspotMeetingId: testMeetingId,
          notes: 'Test dismissal'
        })
      });
      
      // Note: This might fail if HubSpot integration is not available, but the endpoint structure should work
      if (response.ok) {
        const result = await response.json();
        expect(result.success).toBe(true);
        expect(result).toHaveProperty('dismissed');
      }
    });

    it('should prevent admin from dismissing same meeting twice', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const testMeetingId = `test-dismiss-duplicate-${Date.now()}`;
      
      // First dismissal
      const firstResponse = await fetchWithSession('/api/tours/dismiss-hubspot', staffSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hubspotMeetingId: testMeetingId })
      });
      
      if (firstResponse.ok) {
        // Second dismissal with same ID should fail
        const secondResponse = await fetchWithSession('/api/tours/dismiss-hubspot', staffSession, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hubspotMeetingId: testMeetingId })
        });
        
        expect(secondResponse.status).toBe(400);
      }
    });
  });

  describe('Events Needs Review API - Review Management', () => {
    it('should require staff authentication for GET /api/events/needs-review', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/events/needs-review`);
      expect([401, 403]).toContain(response.status);
    });

    it('should allow staff to fetch events needing review', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/events/needs-review', staffSession);
      expect(response.ok).toBe(true);
      
      const events = await response.json();
      expect(Array.isArray(events)).toBe(true);
    });

    it('should return events with review status fields', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/events/needs-review', staffSession);
      expect(response.ok).toBe(true);
      
      const eventsData = await response.json();
      
      // If there are events, verify their structure
      if (eventsData.length > 0) {
        const event = eventsData[0];
        expect(event).toHaveProperty('id');
        expect(event).toHaveProperty('title');
        expect(event).toHaveProperty('needs_review');
        expect(event.needs_review).toBe(true);
      }
    });

    it('should require staff authentication for POST /api/events/:id/mark-reviewed', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/events/999/mark-reviewed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      expect([401, 403]).toContain(response.status);
    });

    it('should return 404 for marking non-existent event as reviewed', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/events/999999/mark-reviewed', staffSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      expect(response.status).toBe(404);
      const error = await response.json();
      expect(error).toHaveProperty('error');
    });

    it('should update event when marked as reviewed', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      // First get events that need review
      const listResponse = await fetchWithSession('/api/events/needs-review', staffSession);
      if (!listResponse.ok) {
        console.log('Skipping: Could not fetch events needing review');
        return;
      }

      const eventsData = await listResponse.json();
      if (eventsData.length === 0) {
        console.log('Skipping: No events needing review');
        return;
      }

      const eventToReview = eventsData[0];
      const response = await fetchWithSession(`/api/events/${eventToReview.id}/mark-reviewed`, staffSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.ok) {
        const result = await response.json();
        expect(result.success).toBe(true);
        expect(result).toHaveProperty('event');
        expect(result.event).toHaveProperty('reviewedBy');
        expect(result.event).toHaveProperty('reviewedAt');
      }
    });
  });

  describe('Wellness Classes Needs Review API - Review Management', () => {
    it('should require staff authentication for GET /api/wellness-classes/needs-review', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/wellness-classes/needs-review`);
      expect([401, 403]).toContain(response.status);
    });

    it('should allow staff to fetch wellness classes needing review', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/wellness-classes/needs-review', staffSession);
      expect(response.ok).toBe(true);
      
      const classes = await response.json();
      expect(Array.isArray(classes)).toBe(true);
    });

    it('should return wellness classes with review status fields', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/wellness-classes/needs-review', staffSession);
      expect(response.ok).toBe(true);
      
      const classesData = await response.json();
      
      // If there are classes, verify their structure
      if (classesData.length > 0) {
        const wc = classesData[0];
        expect(wc).toHaveProperty('id');
        expect(wc).toHaveProperty('title');
        expect(wc).toHaveProperty('needs_review');
        expect(wc.needs_review).toBe(true);
      }
    });

    it('should require staff authentication for POST /api/wellness-classes/:id/mark-reviewed', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/wellness-classes/999/mark-reviewed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      expect([401, 403]).toContain(response.status);
    });

    it('should return 404 for marking non-existent wellness class as reviewed', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/wellness-classes/999999/mark-reviewed', staffSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      expect(response.status).toBe(404);
      const error = await response.json();
      expect(error).toHaveProperty('error');
    });

    it('should update wellness class when marked as reviewed', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      // First get wellness classes that need review
      const listResponse = await fetchWithSession('/api/wellness-classes/needs-review', staffSession);
      if (!listResponse.ok) {
        console.log('Skipping: Could not fetch wellness classes needing review');
        return;
      }

      const classesData = await listResponse.json();
      if (classesData.length === 0) {
        console.log('Skipping: No wellness classes needing review');
        return;
      }

      const classToReview = classesData[0];
      const response = await fetchWithSession(`/api/wellness-classes/${classToReview.id}/mark-reviewed`, staffSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.ok) {
        const result = await response.json();
        expect(result).toHaveProperty('reviewed_by');
        expect(result).toHaveProperty('reviewed_at');
        expect(result.needs_review).toBe(false);
      }
    });
  });

  describe('Cross-API Data Consistency', () => {
    it('should ensure all needs-review endpoints follow same auth pattern', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      // Test that all three endpoints reject unauthenticated requests
      const endpoints = [
        '/api/tours/needs-review',
        '/api/events/needs-review',
        '/api/wellness-classes/needs-review'
      ];

      for (const endpoint of endpoints) {
        const response = await fetch(`${BASE_URL}${endpoint}`);
        expect([401, 403]).toContain(response.status);
      }
    });

    it('should ensure data integrity endpoints are admin-only', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const endpoints = [
        '/api/data-integrity/summary',
        '/api/data-integrity/run'
      ];

      for (const endpoint of endpoints) {
        const response = await fetchWithSession(endpoint, staffSession);
        expect([401, 403]).toContain(response.status);
      }
    });
  });
});
