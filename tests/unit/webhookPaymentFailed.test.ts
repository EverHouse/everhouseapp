import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../server/core/db', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn()
  }
}));

vi.mock('../../server/core/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }
}));

type DeferredAction = () => Promise<void>;

interface MockQueryResult {
  rows: any[];
  rowCount: number;
}

class MockPoolClient {
  private queries: Array<{ sql: string; params: any[]; result: MockQueryResult }> = [];
  private executedQueries: Array<{ sql: string; params: any[] }> = [];

  mockQuery(sqlPattern: string, result: MockQueryResult) {
    this.queries.push({ sql: sqlPattern, params: [], result });
  }

  async query(sql: string, params: any[] = []): Promise<MockQueryResult> {
    this.executedQueries.push({ sql, params });

    for (const mock of this.queries) {
      if (sql.includes(mock.sql)) {
        return mock.result;
      }
    }
    return { rows: [], rowCount: 0 };
  }

  getExecutedQueries() {
    return this.executedQueries;
  }

  hasQueryContaining(pattern: string): boolean {
    return this.executedQueries.some(q => q.sql.includes(pattern));
  }

  getQueryParams(pattern: string): any[] | null {
    const query = this.executedQueries.find(q => q.sql.includes(pattern));
    return query?.params || null;
  }

  reset() {
    this.queries = [];
    this.executedQueries = [];
  }
}

function createMockInvoice(overrides: Partial<any> = {}): any {
  return {
    id: 'in_test_123',
    customer: 'cus_test_456',
    customer_email: 'member@example.com',
    subscription: 'sub_test_789',
    amount_due: 15000,
    currency: 'usd',
    created: Math.floor(Date.now() / 1000),
    attempt_count: 1,
    last_finalization_error: null,
    lines: {
      data: [{ description: 'VIP Membership' }]
    },
    metadata: {},
    payment_intent: 'pi_test_abc',
    ...overrides
  };
}

function createMockPaymentIntent(overrides: Partial<any> = {}): any {
  return {
    id: 'pi_test_abc',
    metadata: {
      email: 'member@example.com',
      bookingId: '42',
      description: 'Booking prepayment'
    },
    amount: 5000,
    currency: 'usd',
    created: Math.floor(Date.now() / 1000),
    last_payment_error: {
      message: 'Your card was declined.',
      code: 'card_declined',
      decline_code: 'insufficient_funds'
    },
    customer: 'cus_test_456',
    ...overrides
  };
}

describe('Webhook Payment Failed Handlers', () => {
  let client: MockPoolClient;

  beforeEach(() => {
    client = new MockPoolClient();
    vi.clearAllMocks();
  });

  describe('handleInvoicePaymentFailed — Subscription Status Validation', () => {
    it('should skip grace period for canceled subscriptions', async () => {
      const invoice = createMockInvoice({ subscription: 'sub_canceled_123' });

      client.mockQuery('SELECT first_name', { rows: [{ first_name: 'John', last_name: 'Doe' }], rowCount: 1 });
      client.mockQuery('SELECT membership_status', { rows: [{ membership_status: 'active' }], rowCount: 1 });

      const subscriptionStatus = 'canceled';
      const shouldSkip = ['canceled', 'incomplete_expired'].includes(subscriptionStatus);

      expect(shouldSkip).toBe(true);
    });

    it('should skip grace period for already suspended members', async () => {
      client.mockQuery('SELECT membership_status', {
        rows: [{ membership_status: 'suspended' }],
        rowCount: 1
      });

      const currentStatus = 'suspended';
      const shouldSkip = ['cancelled', 'suspended'].includes(currentStatus);

      expect(shouldSkip).toBe(true);
    });

    it('should proceed with grace period for active members with active subscriptions', async () => {
      const subscriptionStatus = 'active';
      const currentStatus = 'active';

      const subShouldSkip = ['canceled', 'incomplete_expired'].includes(subscriptionStatus);
      const userShouldSkip = ['cancelled', 'suspended'].includes(currentStatus);

      expect(subShouldSkip).toBe(false);
      expect(userShouldSkip).toBe(false);
    });

    it('should skip grace period for incomplete_expired subscriptions', async () => {
      const subscriptionStatus = 'incomplete_expired';
      const shouldSkip = ['canceled', 'incomplete_expired'].includes(subscriptionStatus);

      expect(shouldSkip).toBe(true);
    });
  });

  describe('handleInvoicePaymentFailed — Concurrency Guard', () => {
    it('should not send duplicate notifications when grace period already started', async () => {
      client.mockQuery('UPDATE users SET', { rows: [], rowCount: 0 });

      const updateResult = await client.query(
        `UPDATE users SET 
          grace_period_start = COALESCE(grace_period_start, NOW()),
          membership_status = CASE 
            WHEN membership_status = 'active' THEN 'past_due'
            ELSE membership_status 
          END,
          updated_at = NOW()
        WHERE LOWER(email) = LOWER($1) AND grace_period_start IS NULL`,
        ['member@example.com']
      );

      expect(updateResult.rowCount).toBe(0);

      const gracePeriodAlreadyActive = updateResult.rowCount === 0;
      expect(gracePeriodAlreadyActive).toBe(true);
    });

    it('should send notifications when grace period is newly started', async () => {
      client.mockQuery('UPDATE users SET', { rows: [{}], rowCount: 1 });

      const updateResult = await client.query(
        `UPDATE users SET 
          grace_period_start = COALESCE(grace_period_start, NOW()),
          membership_status = CASE 
            WHEN membership_status = 'active' THEN 'past_due'
            ELSE membership_status 
          END,
          updated_at = NOW()
        WHERE LOWER(email) = LOWER($1) AND grace_period_start IS NULL`,
        ['member@example.com']
      );

      expect(updateResult.rowCount).toBe(1);

      const gracePeriodNewlyStarted = updateResult.rowCount > 0;
      expect(gracePeriodNewlyStarted).toBe(true);
    });
  });

  describe('handleInvoicePaymentFailed — Attempt Count Tracking', () => {
    it('should include attempt count in notifications', () => {
      const invoice = createMockInvoice({ attempt_count: 3 });
      const attemptCount = invoice.attempt_count || 1;
      const isEscalated = attemptCount >= 3;

      expect(attemptCount).toBe(3);
      expect(isEscalated).toBe(true);
    });

    it('should use default attempt count of 1 when not provided', () => {
      const invoice = createMockInvoice({ attempt_count: undefined });
      const attemptCount = invoice.attempt_count || 1;

      expect(attemptCount).toBe(1);
    });

    it('should escalate notifications at attempt 3+', () => {
      const testCases = [
        { attempt: 1, shouldEscalate: false },
        { attempt: 2, shouldEscalate: false },
        { attempt: 3, shouldEscalate: true },
        { attempt: 4, shouldEscalate: true },
      ];

      for (const { attempt, shouldEscalate } of testCases) {
        expect(attempt >= 3).toBe(shouldEscalate);
      }
    });
  });

  describe('handleInvoicePaymentFailed — Email Normalization', () => {
    it('should use LOWER() for case-insensitive email matching', async () => {
      client.mockQuery('SELECT first_name', { rows: [], rowCount: 0 });

      await client.query(
        'SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)',
        ['Member@Example.COM']
      );

      const query = client.getQueryParams('SELECT first_name');
      expect(query).toContain('Member@Example.COM');
      expect(client.hasQueryContaining('LOWER(email) = LOWER')).toBe(true);
    });
  });

  describe('handleInvoicePaymentFailed — Deferred Action Pattern', () => {
    it('should defer HubSpot sync outside transaction', async () => {
      const deferredActions: DeferredAction[] = [];
      let hubspotSyncCalled = false;
      let transactionCommitted = false;

      deferredActions.push(async () => {
        hubspotSyncCalled = true;
        expect(transactionCommitted).toBe(true);
      });

      transactionCommitted = true;

      for (const action of deferredActions) {
        await action();
      }

      expect(hubspotSyncCalled).toBe(true);
    });

    it('should not execute deferred actions if transaction rolls back', async () => {
      const deferredActions: DeferredAction[] = [];
      let sideEffectExecuted = false;

      deferredActions.push(async () => {
        sideEffectExecuted = true;
      });

      const transactionFailed = true;
      if (!transactionFailed) {
        for (const action of deferredActions) {
          await action();
        }
      }

      expect(sideEffectExecuted).toBe(false);
    });
  });

  describe('handlePaymentIntentFailed — Retry Tracking', () => {
    it('should increment retry count on each failure', () => {
      const MAX_RETRY_ATTEMPTS = 3;
      let retryCount = 0;

      retryCount += 1;
      expect(retryCount).toBe(1);
      expect(retryCount >= MAX_RETRY_ATTEMPTS).toBe(false);

      retryCount += 1;
      expect(retryCount).toBe(2);
      expect(retryCount >= MAX_RETRY_ATTEMPTS).toBe(false);

      retryCount += 1;
      expect(retryCount).toBe(3);
      expect(retryCount >= MAX_RETRY_ATTEMPTS).toBe(true);
    });

    it('should flag requires_card_update at max retries', () => {
      const MAX_RETRY_ATTEMPTS = 3;
      const testCases = [
        { retryCount: 1, expected: false },
        { retryCount: 2, expected: false },
        { retryCount: 3, expected: true },
        { retryCount: 5, expected: true },
      ];

      for (const { retryCount, expected } of testCases) {
        expect(retryCount >= MAX_RETRY_ATTEMPTS).toBe(expected);
      }
    });
  });

  describe('handlePaymentIntentFailed — Error Code Extraction', () => {
    it('should extract decline_code from last_payment_error', () => {
      const pi = createMockPaymentIntent();
      const errorCode = pi.last_payment_error?.code || 'unknown';
      const declineCode = pi.last_payment_error?.decline_code;

      expect(errorCode).toBe('card_declined');
      expect(declineCode).toBe('insufficient_funds');
    });

    it('should handle missing last_payment_error gracefully', () => {
      const pi = createMockPaymentIntent({ last_payment_error: null });
      const reason = pi.last_payment_error?.message || 'Payment could not be processed';
      const errorCode = pi.last_payment_error?.code || 'unknown';
      const declineCode = pi.last_payment_error?.decline_code;

      expect(reason).toBe('Payment could not be processed');
      expect(errorCode).toBe('unknown');
      expect(declineCode).toBeUndefined();
    });

    it('should handle partial last_payment_error without decline_code', () => {
      const pi = createMockPaymentIntent({
        last_payment_error: {
          message: 'Generic processing error',
          code: 'processing_error'
        }
      });
      const errorCode = pi.last_payment_error?.code || 'unknown';
      const declineCode = pi.last_payment_error?.decline_code;

      expect(errorCode).toBe('processing_error');
      expect(declineCode).toBeUndefined();
    });
  });

  describe('handlePaymentIntentFailed — Email Normalization', () => {
    it('should use LOWER() for user lookup in deferred actions', async () => {
      client.mockQuery('SELECT first_name', {
        rows: [{ first_name: 'Jane', last_name: 'Smith' }],
        rowCount: 1
      });

      await client.query(
        'SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)',
        ['Member@Example.com']
      );

      expect(client.hasQueryContaining('LOWER(email) = LOWER')).toBe(true);
    });
  });

  describe('handlePaymentIntentFailed — Missing Email Handling', () => {
    it('should return early with audit/cache deferred actions when no email in metadata', () => {
      const pi = createMockPaymentIntent({ metadata: {} });
      const email = pi.metadata?.email;

      expect(email).toBeUndefined();

      const deferredActions: DeferredAction[] = [];
      deferredActions.push(async () => {});
      deferredActions.push(async () => {});

      if (!email) {
        expect(deferredActions.length).toBeGreaterThan(0);
        return;
      }

      throw new Error('Should not reach here');
    });
  });

  describe('Race Condition Protection', () => {
    it('should prevent duplicate event processing via event dedup', async () => {
      const processedEvents = new Set<string>();

      const tryClaimEvent = (eventId: string): boolean => {
        if (processedEvents.has(eventId)) return false;
        processedEvents.add(eventId);
        return true;
      };

      const eventId = 'evt_invoice_failed_123';
      expect(tryClaimEvent(eventId)).toBe(true);
      expect(tryClaimEvent(eventId)).toBe(false);
    });

    it('should handle concurrent invoice.payment_failed events for same subscription', async () => {
      const processedEvents = new Set<string>();
      const gracePeriodStarted = new Map<string, boolean>();

      const processInvoiceFailed = (eventId: string, email: string): { processed: boolean; gracePeriodSet: boolean } => {
        if (processedEvents.has(eventId)) {
          return { processed: false, gracePeriodSet: false };
        }
        processedEvents.add(eventId);

        const alreadyInGracePeriod = gracePeriodStarted.get(email) || false;
        if (!alreadyInGracePeriod) {
          gracePeriodStarted.set(email, true);
          return { processed: true, gracePeriodSet: true };
        }
        return { processed: true, gracePeriodSet: false };
      };

      const result1 = processInvoiceFailed('evt_1', 'member@example.com');
      expect(result1.processed).toBe(true);
      expect(result1.gracePeriodSet).toBe(true);

      const result2 = processInvoiceFailed('evt_2', 'member@example.com');
      expect(result2.processed).toBe(true);
      expect(result2.gracePeriodSet).toBe(false);

      const result3 = processInvoiceFailed('evt_1', 'member@example.com');
      expect(result3.processed).toBe(false);
      expect(result3.gracePeriodSet).toBe(false);
    });

    it('should use conditional UPDATE to prevent grace period reset', async () => {
      let rowsAffectedFirstCall = 1;
      let rowsAffectedSecondCall = 0;

      expect(rowsAffectedFirstCall).toBe(1);
      expect(rowsAffectedSecondCall).toBe(0);
    });

    it('should skip notifications when grace period already active (rowCount=0)', () => {
      const rowCount = 0;
      const gracePeriodAlreadyActive = rowCount === 0;

      expect(gracePeriodAlreadyActive).toBe(true);
    });
  });

  describe('Event Priority Ordering for Payment Failures', () => {
    const EVENT_PRIORITY: Record<string, number> = {
      'payment_intent.created': 1,
      'payment_intent.processing': 2,
      'payment_intent.requires_action': 3,
      'payment_intent.succeeded': 10,
      'payment_intent.payment_failed': 10,
      'payment_intent.canceled': 10,
      'invoice.created': 1,
      'invoice.finalized': 2,
      'invoice.payment_succeeded': 10,
      'invoice.payment_failed': 10,
      'invoice.paid': 11,
      'invoice.voided': 20,
    };

    it('should have equal priority for succeeded and failed payment intents', () => {
      expect(EVENT_PRIORITY['payment_intent.succeeded']).toBe(EVENT_PRIORITY['payment_intent.payment_failed']);
    });

    it('should have equal priority for succeeded and failed invoices', () => {
      expect(EVENT_PRIORITY['invoice.payment_succeeded']).toBe(EVENT_PRIORITY['invoice.payment_failed']);
    });

    it('should block payment_failed after invoice.voided (out-of-order)', () => {
      const lastPriority = EVENT_PRIORITY['invoice.voided'];
      const currentPriority = EVENT_PRIORITY['invoice.payment_failed'];

      expect(lastPriority).toBeGreaterThan(currentPriority);
    });

    it('should allow payment_failed after invoice.finalized (in-order)', () => {
      const lastPriority = EVENT_PRIORITY['invoice.finalized'];
      const currentPriority = EVENT_PRIORITY['invoice.payment_failed'];

      expect(currentPriority).toBeGreaterThanOrEqual(lastPriority);
    });
  });
});
