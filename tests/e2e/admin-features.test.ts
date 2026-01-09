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

describe('Admin Features E2E Tests', () => {
  const adminEmail = 'test-admin@example.com';
  const staffEmail = 'test-staff@example.com';
  let adminSession: TestSession | null = null;
  let staffSession: TestSession | null = null;

  beforeAll(async () => {
    serverAvailable = await checkServerAvailable();
    if (serverAvailable) {
      adminSession = await login(adminEmail, 'admin');
      staffSession = await login(staffEmail, 'staff');
    }
  });

  describe('Closure Reasons Management', () => {
    let createdReasonId: number | null = null;

    it('should fetch closure reasons list', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/closure-reasons`);
      expect(response.ok).toBe(true);
      
      const reasons = await response.json();
      expect(Array.isArray(reasons)).toBe(true);
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons[0]).toHaveProperty('id');
      expect(reasons[0]).toHaveProperty('label');
    });

    it('should allow admin to create closure reason', async () => {
      if (!adminSession) {
        console.log('Skipping: No admin session');
        return;
      }

      const response = await fetchWithSession('/api/closure-reasons', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Test Closure Reason', sortOrder: 999 })
      });
      
      expect(response.ok).toBe(true);
      const reason = await response.json();
      expect(reason.label).toBe('Test Closure Reason');
      createdReasonId = reason.id;
    });

    it('should allow admin to update closure reason', async () => {
      if (!adminSession || !createdReasonId) {
        console.log('Skipping: No admin session or reason ID');
        return;
      }

      const response = await fetchWithSession(`/api/closure-reasons/${createdReasonId}`, adminSession, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Updated Test Reason', sortOrder: 998 })
      });
      
      expect(response.ok).toBe(true);
      const reason = await response.json();
      expect(reason.label).toBe('Updated Test Reason');
    });

    it('should allow admin to delete closure reason', async () => {
      if (!adminSession || !createdReasonId) {
        console.log('Skipping: No admin session or reason ID');
        return;
      }

      const response = await fetchWithSession(`/api/closure-reasons/${createdReasonId}`, adminSession, {
        method: 'DELETE'
      });
      
      expect(response.ok).toBe(true);
    });
  });

  describe('Notice Types Management', () => {
    let createdTypeId: number | null = null;

    it('should fetch notice types list', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/notice-types`);
      expect(response.ok).toBe(true);
      
      const types = await response.json();
      expect(Array.isArray(types)).toBe(true);
      expect(types.some((t: any) => t.is_preset || t.isPreset)).toBe(true);
    });

    it('should allow staff to create notice type', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const response = await fetchWithSession('/api/notice-types', staffSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Notice Type', sortOrder: 999 })
      });
      
      expect(response.ok).toBe(true);
      const type = await response.json();
      expect(type.name).toBe('Test Notice Type');
      expect(type.is_preset === false || type.isPreset === false).toBe(true);
      createdTypeId = type.id;
    });

    it('should prevent editing preset notice types', async () => {
      if (!staffSession) {
        console.log('Skipping: No staff session');
        return;
      }

      const listResponse = await fetch(`${BASE_URL}/api/notice-types`);
      const types = await listResponse.json();
      const presetType = types.find((t: any) => t.is_preset || t.isPreset);
      
      if (!presetType) {
        console.log('Skipping: No preset type found');
        return;
      }

      const response = await fetchWithSession(`/api/notice-types/${presetType.id}`, staffSession, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hacked Name' })
      });
      
      expect(response.status).toBe(403);
    });

    it('should allow deleting custom notice type', async () => {
      if (!staffSession || !createdTypeId) {
        console.log('Skipping: No staff session or type ID');
        return;
      }

      const response = await fetchWithSession(`/api/notice-types/${createdTypeId}`, staffSession, {
        method: 'DELETE'
      });
      
      expect(response.ok).toBe(true);
    });
  });

  describe('Promotional Banner for Announcements', () => {
    let createdAnnouncementId: number | null = null;

    it('should fetch banner announcement endpoint', async () => {
      if (!serverAvailable) {
        console.log('Skipping: Server not available');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/announcements/banner`);
      expect(response.ok).toBe(true);
    });

    it('should allow admin to create announcement with banner flag', async () => {
      if (!adminSession) {
        console.log('Skipping: No admin session');
        return;
      }

      const response = await fetchWithSession('/api/announcements', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test Banner Announcement',
          content: 'This is a test announcement for E2E',
          priority: 'normal',
          is_active: true,
          showAsBanner: true
        })
      });
      
      expect(response.ok).toBe(true);
      const announcement = await response.json();
      expect(announcement.show_as_banner).toBe(true);
      createdAnnouncementId = announcement.id;
    });

    it('should return banner in banner endpoint', async () => {
      if (!createdAnnouncementId) {
        console.log('Skipping: No announcement created');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/announcements/banner`);
      const banner = await response.json();
      
      if (banner) {
        expect(banner.id).toBe(createdAnnouncementId);
        expect(banner.show_as_banner).toBe(true);
      }
    });

    afterAll(async () => {
      if (adminSession && createdAnnouncementId) {
        await fetchWithSession(`/api/announcements/${createdAnnouncementId}`, adminSession, {
          method: 'DELETE'
        });
      }
    });
  });
});
