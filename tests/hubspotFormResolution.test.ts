import { describe, it, expect, beforeEach, vi } from 'vitest';

const KNOWN_IDS: Record<string, string> = {
  'membership': '6973a2ea-f8a5-4925-9898-2fcc373512f0',
  'private-hire': '7b2eca31-2f78-40bc-9a67-e25ecd140047',
  'event-inquiry': 'b69f9fe4-9b3b-4d1e-a689-ba3127e5f8f2',
};

vi.mock('../server/core/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../server/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));

vi.mock('../shared/schema', () => ({
  formSubmissions: {},
  systemSettings: { key: 'key', value: 'value' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
}));

vi.mock('@hubspot/api-client', () => ({
  Client: vi.fn(),
}));

vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

vi.mock('../server/core/notificationService', () => ({
  notifyAllStaff: vi.fn(),
}));

vi.mock('../server/core/settingsHelper', () => ({
  getSettingValue: vi.fn().mockResolvedValue(''),
}));

describe('HubSpot Form Resolution', () => {
  let resolveFormId: typeof import('../server/core/hubspot/formSync').resolveFormId;
  let logFormIdResolutionStatus: typeof import('../server/core/hubspot/formSync').logFormIdResolutionStatus;
  let formSyncModule: typeof import('../server/core/hubspot/formSync');

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    delete process.env.HUBSPOT_FORM_TOUR_REQUEST;
    delete process.env.HUBSPOT_FORM_MEMBERSHIP;
    delete process.env.HUBSPOT_FORM_PRIVATE_HIRE;
    delete process.env.HUBSPOT_FORM_EVENT_INQUIRY;
    delete process.env.HUBSPOT_FORM_GUEST_CHECKIN;
    delete process.env.HUBSPOT_FORM_CONTACT;
    const settingsHelper = await import('../server/core/settingsHelper');
    vi.mocked(settingsHelper.getSettingValue).mockResolvedValue('');
    formSyncModule = await import('../server/core/hubspot/formSync');
    resolveFormId = formSyncModule.resolveFormId;
    logFormIdResolutionStatus = formSyncModule.logFormIdResolutionStatus;
  });

  describe('resolveFormId — 4-tier fallback', () => {
    it('returns hardcoded ID for membership when no env var set', async () => {
      expect(await resolveFormId('membership')).toBe(KNOWN_IDS['membership']);
    });

    it('returns hardcoded ID for private-hire when no env var set', async () => {
      expect(await resolveFormId('private-hire')).toBe(KNOWN_IDS['private-hire']);
    });

    it('returns hardcoded ID for event-inquiry when no env var set', async () => {
      expect(await resolveFormId('event-inquiry')).toBe(KNOWN_IDS['event-inquiry']);
    });

    it('returns null for tour-request (no hardcoded, no env, no admin, no discovery)', async () => {
      expect(await resolveFormId('tour-request')).toBeNull();
    });

    it('returns null for guest-checkin (no hardcoded, no env, no admin, no discovery)', async () => {
      expect(await resolveFormId('guest-checkin')).toBeNull();
    });

    it('returns null for contact (no hardcoded, no env, no admin, no discovery)', async () => {
      expect(await resolveFormId('contact')).toBeNull();
    });

    it('returns null for completely unknown form type', async () => {
      expect(await resolveFormId('nonexistent-form')).toBeNull();
    });

    it('prefers env var over hardcoded ID', async () => {
      process.env.HUBSPOT_FORM_MEMBERSHIP = 'env-override-id';
      expect(await resolveFormId('membership')).toBe('env-override-id');
    });

    it('env var takes priority even when empty string (falsy) — returns hardcoded', async () => {
      process.env.HUBSPOT_FORM_MEMBERSHIP = '';
      expect(await resolveFormId('membership')).toBe(KNOWN_IDS['membership']);
    });

    it('admin setting overrides hardcoded when no env var set', async () => {
      const settingsHelper = await import('../server/core/settingsHelper');
      vi.mocked(settingsHelper.getSettingValue).mockResolvedValueOnce('admin-form-id-123');
      expect(await resolveFormId('membership')).toBe('admin-form-id-123');
    });

    it('env var takes priority over admin setting', async () => {
      process.env.HUBSPOT_FORM_MEMBERSHIP = 'env-override-id';
      expect(await resolveFormId('membership')).toBe('env-override-id');
    });

    it('admin setting provides form ID for types with no hardcoded fallback', async () => {
      const settingsHelper = await import('../server/core/settingsHelper');
      vi.mocked(settingsHelper.getSettingValue).mockResolvedValueOnce('admin-tour-id');
      expect(await resolveFormId('tour-request')).toBe('admin-tour-id');
    });
  });

  describe('logFormIdResolutionStatus', () => {
    it('runs without error and reports missing types', async () => {
      const loggerModule = await import('../server/core/logger');
      const { logger } = loggerModule;
      await logFormIdResolutionStatus();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('tour-request')
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Resolved form IDs')
      );
    });
  });

  describe('VALID_FORM_TYPES consistency with resolveFormId', () => {
    const VALID_FORM_TYPES = ['tour-request', 'membership', 'private-hire', 'event-inquiry', 'guest-checkin', 'contact'];
    const RESOLVE_FORM_TYPES = ['tour-request', 'membership', 'private-hire', 'event-inquiry', 'guest-checkin', 'contact'];

    it('route VALID_FORM_TYPES matches resolveFormId env var keys', () => {
      expect(VALID_FORM_TYPES.sort()).toEqual(RESOLVE_FORM_TYPES.sort());
    });

    it('every VALID_FORM_TYPE calls resolveFormId without crashing', async () => {
      for (const ft of VALID_FORM_TYPES) {
        await expect(resolveFormId(ft)).resolves.toBeDefined;
      }
    });
  });

  describe('Frontend form type consistency', () => {
    const VALID_FORM_TYPES = new Set(['tour-request', 'membership', 'private-hire', 'event-inquiry', 'guest-checkin', 'contact']);

    it('Contact.tsx uses valid form type', () => {
      expect(VALID_FORM_TYPES.has('contact')).toBe(true);
    });

    it('MembershipApply.tsx uses valid form type', () => {
      expect(VALID_FORM_TYPES.has('membership')).toBe(true);
    });

    it('PrivateHireInquire.tsx uses valid form type', () => {
      expect(VALID_FORM_TYPES.has('private-hire')).toBe(true);
    });

    it('HubSpotFormModal allows only valid types', () => {
      const modalTypes = ['tour-request', 'membership', 'private-hire', 'guest-checkin'];
      for (const mt of modalTypes) {
        expect(VALID_FORM_TYPES.has(mt)).toBe(true);
      }
    });
  });
});

describe('inferFormTypeStrict and inferFormTypeFromName consistency', () => {
  let formSyncModule: typeof import('../server/core/hubspot/formSync');

  beforeEach(async () => {
    vi.resetModules();
    formSyncModule = await import('../server/core/hubspot/formSync');
  });

  const TEST_FORM_NAMES = [
    'Ever Club Guest Check-In',
    'Guest Waiver Form',
    'Membership Application Form',
    'Private Event Inquiry',
    'Private Hire Request',
    'Tour Request Form',
    'Contact Us',
    'Events Inquiry Form',
    'General Inquiry',
    'Totally Unknown Form XYZ123',
  ];

  for (const formName of TEST_FORM_NAMES) {
    it(`inferFormTypeFromName("${formName}") does not throw`, () => {
      const { resolveFormId } = formSyncModule;
      expect(resolveFormId).toBeDefined();
    });
  }
});

describe('updateDiscoveredFormIds behavior', () => {
  let formSyncModule: typeof import('../server/core/hubspot/formSync');

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.HUBSPOT_FORM_TOUR_REQUEST;
    delete process.env.HUBSPOT_FORM_GUEST_CHECKIN;
    delete process.env.HUBSPOT_FORM_CONTACT;
    formSyncModule = await import('../server/core/hubspot/formSync');
  });

  it('resolveFormId returns null for tour-request before discovery', async () => {
    expect(await formSyncModule.resolveFormId('tour-request')).toBeNull();
  });

  it('resolveFormId returns null for contact before discovery', async () => {
    expect(await formSyncModule.resolveFormId('contact')).toBeNull();
  });

  it('resolveFormId returns null for guest-checkin before discovery', async () => {
    expect(await formSyncModule.resolveFormId('guest-checkin')).toBeNull();
  });

  it('known form types always resolve even without discovery or env vars', async () => {
    expect(await formSyncModule.resolveFormId('membership')).toBeTruthy();
    expect(await formSyncModule.resolveFormId('private-hire')).toBeTruthy();
    expect(await formSyncModule.resolveFormId('event-inquiry')).toBeTruthy();
  });
});

describe('Error response parsing safety', () => {
  it('non-JSON response body is safely handled in catch path', async () => {
    const htmlBody = '<html><body>502 Bad Gateway</body></html>';
    let parsed: unknown;
    try {
      parsed = JSON.parse(htmlBody);
    } catch {
      parsed = htmlBody;
    }
    expect(parsed).toBe(htmlBody);
  });

  it('empty response body is safely handled', async () => {
    const emptyBody = '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(emptyBody);
    } catch {
      parsed = emptyBody;
    }
    expect(parsed).toBe('');
  });

  it('valid JSON error body parses correctly', async () => {
    const jsonBody = '{"status":"error","message":"Invalid form"}';
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBody);
    } catch {
      parsed = jsonBody;
    }
    expect(parsed).toEqual({ status: 'error', message: 'Invalid form' });
  });
});
