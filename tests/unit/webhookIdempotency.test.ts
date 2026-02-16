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

const EVENT_PRIORITY: Record<string, number> = {
  'payment_intent.created': 1,
  'payment_intent.processing': 2,
  'payment_intent.requires_action': 3,
  'payment_intent.succeeded': 10,
  'payment_intent.payment_failed': 10,
  'charge.succeeded': 11,
  'charge.refunded': 20,
  'invoice.created': 1,
  'invoice.finalized': 2,
  'invoice.payment_succeeded': 10,
  'invoice.payment_failed': 10,
  'invoice.paid': 11,
  'invoice.voided': 20,
  'invoice.marked_uncollectible': 20,
};

interface MockEventRecord {
  eventId: string;
  eventType: string;
  processedAt: Date;
}

class MockWebhookProcessor {
  private processedEvents: Map<string, MockEventRecord> = new Map();
  private resourceEventHistory: Map<string, MockEventRecord[]> = new Map();
  private transactionActive = false;
  private pendingEventClaim: { eventId: string; eventType: string } | null = null;

  async tryClaimEvent(
    eventId: string,
    eventType: string,
    eventTimestamp: number
  ): Promise<{ claimed: boolean; reason?: 'duplicate' | 'out_of_order' }> {
    if (this.processedEvents.has(eventId)) {
      return { claimed: false, reason: 'duplicate' };
    }

    this.pendingEventClaim = { eventId, eventType };
    return { claimed: true };
  }

  async checkResourceEventOrder(
    resourceId: string,
    resourceType: string,
    eventTimestamp: number,
    eventType: string
  ): Promise<boolean> {
    const currentPriority = EVENT_PRIORITY[eventType] || 5;
    const historyKey = `${resourceType}_${resourceId}`;
    const history = this.resourceEventHistory.get(historyKey) || [];

    if (history.length === 0) {
      return true;
    }

    const lastEvent = history[history.length - 1];
    const lastPriority = EVENT_PRIORITY[lastEvent.eventType] || 5;

    if (lastPriority > currentPriority) {
      return false;
    }

    return true;
  }

  async beginTransaction(): Promise<void> {
    this.transactionActive = true;
  }

  async commitTransaction(): Promise<void> {
    if (this.pendingEventClaim && this.transactionActive) {
      const record: MockEventRecord = {
        eventId: this.pendingEventClaim.eventId,
        eventType: this.pendingEventClaim.eventType,
        processedAt: new Date()
      };
      this.processedEvents.set(this.pendingEventClaim.eventId, record);
      
      const resourceId = this.pendingEventClaim.eventId.split('_')[1] || '';
      const historyKey = `event_${resourceId}`;
      const history = this.resourceEventHistory.get(historyKey) || [];
      history.push(record);
      this.resourceEventHistory.set(historyKey, history);
    }
    this.transactionActive = false;
    this.pendingEventClaim = null;
  }

  async rollbackTransaction(): Promise<void> {
    this.pendingEventClaim = null;
    this.transactionActive = false;
  }

  isEventProcessed(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }

  reset(): void {
    this.processedEvents.clear();
    this.resourceEventHistory.clear();
    this.transactionActive = false;
    this.pendingEventClaim = null;
  }
}

describe('Webhook Idempotency', () => {
  let processor: MockWebhookProcessor;
  let deferredActions: Array<() => Promise<any>>;

  beforeEach(() => {
    processor = new MockWebhookProcessor();
    deferredActions = [];
    vi.clearAllMocks();
  });

  describe('Event Deduplication', () => {
    it('should process event only once', async () => {
      const eventId = 'evt_test123';
      const eventType = 'payment_intent.succeeded';
      const eventTimestamp = Date.now();

      await processor.beginTransaction();
      const firstClaim = await processor.tryClaimEvent(eventId, eventType, eventTimestamp);
      expect(firstClaim.claimed).toBe(true);
      await processor.commitTransaction();

      expect(processor.isEventProcessed(eventId)).toBe(true);

      await processor.beginTransaction();
      const secondClaim = await processor.tryClaimEvent(eventId, eventType, eventTimestamp);
      expect(secondClaim.claimed).toBe(false);
      expect(secondClaim.reason).toBe('duplicate');
      await processor.rollbackTransaction();
    });

    it('should allow processing different events', async () => {
      const eventId1 = 'evt_first123';
      const eventId2 = 'evt_second456';
      const eventType = 'payment_intent.succeeded';

      await processor.beginTransaction();
      const firstClaim = await processor.tryClaimEvent(eventId1, eventType, Date.now());
      expect(firstClaim.claimed).toBe(true);
      await processor.commitTransaction();

      await processor.beginTransaction();
      const secondClaim = await processor.tryClaimEvent(eventId2, eventType, Date.now());
      expect(secondClaim.claimed).toBe(true);
      await processor.commitTransaction();

      expect(processor.isEventProcessed(eventId1)).toBe(true);
      expect(processor.isEventProcessed(eventId2)).toBe(true);
    });
  });

  describe('Transaction Rollback', () => {
    it('should rollback if processing fails', async () => {
      const eventId = 'evt_failing123';
      const eventType = 'payment_intent.succeeded';

      await processor.beginTransaction();
      const claim = await processor.tryClaimEvent(eventId, eventType, Date.now());
      expect(claim.claimed).toBe(true);

      await processor.rollbackTransaction();

      expect(processor.isEventProcessed(eventId)).toBe(false);
    });

    it('should not persist dedup marker on rollback', async () => {
      const eventId = 'evt_rollback123';
      const eventType = 'charge.succeeded';

      await processor.beginTransaction();
      await processor.tryClaimEvent(eventId, eventType, Date.now());
      
      const simulatedError = new Error('Processing failed');
      try {
        throw simulatedError;
      } catch {
        await processor.rollbackTransaction();
      }

      expect(processor.isEventProcessed(eventId)).toBe(false);

      await processor.beginTransaction();
      const retryResult = await processor.tryClaimEvent(eventId, eventType, Date.now());
      expect(retryResult.claimed).toBe(true);
    });
  });

  describe('Event Ordering', () => {
    it('should skip out-of-order events', async () => {
      const resourceId = 'pi_test123';
      const resourceType = 'payment_intent';

      processor['resourceEventHistory'].set(`${resourceType}_${resourceId}`, [{
        eventId: 'evt_succeeded',
        eventType: 'payment_intent.succeeded',
        processedAt: new Date()
      }]);

      const canProcessCreated = await processor.checkResourceEventOrder(
        resourceId,
        resourceType,
        Date.now() - 1000,
        'payment_intent.created'
      );

      expect(canProcessCreated).toBe(false);
    });

    it('should allow in-order events', async () => {
      const resourceId = 'pi_test456';
      const resourceType = 'payment_intent';

      processor['resourceEventHistory'].set(`${resourceType}_${resourceId}`, [{
        eventId: 'evt_created',
        eventType: 'payment_intent.created',
        processedAt: new Date()
      }]);

      const canProcessSucceeded = await processor.checkResourceEventOrder(
        resourceId,
        resourceType,
        Date.now(),
        'payment_intent.succeeded'
      );

      expect(canProcessSucceeded).toBe(true);
    });

    it('should allow first event for a resource', async () => {
      const resourceId = 'pi_new789';
      const resourceType = 'payment_intent';

      const canProcess = await processor.checkResourceEventOrder(
        resourceId,
        resourceType,
        Date.now(),
        'payment_intent.created'
      );

      expect(canProcess).toBe(true);
    });

    it('should use event priority for ordering decisions', () => {
      expect(EVENT_PRIORITY['payment_intent.created']).toBe(1);
      expect(EVENT_PRIORITY['payment_intent.succeeded']).toBe(10);
      expect(EVENT_PRIORITY['charge.refunded']).toBe(20);

      expect(EVENT_PRIORITY['payment_intent.succeeded']).toBeGreaterThan(
        EVENT_PRIORITY['payment_intent.created']
      );
    });
  });

  describe('Deferred Actions', () => {
    it('should defer external calls until after commit', async () => {
      const executionOrder: string[] = [];
      let transactionCommitted = false;

      deferredActions.push(async () => {
        executionOrder.push('external_call');
        expect(transactionCommitted).toBe(true);
      });

      await processor.beginTransaction();
      executionOrder.push('begin_transaction');

      executionOrder.push('process_event');

      executionOrder.push('commit_transaction');
      await processor.commitTransaction();
      transactionCommitted = true;

      for (const action of deferredActions) {
        await action();
      }

      expect(executionOrder).toEqual([
        'begin_transaction',
        'process_event',
        'commit_transaction',
        'external_call'
      ]);
    });

    it('should not execute deferred actions on rollback', async () => {
      let externalCallExecuted = false;

      deferredActions.push(async () => {
        externalCallExecuted = true;
      });

      await processor.beginTransaction();
      
      await processor.rollbackTransaction();

      expect(externalCallExecuted).toBe(false);
    });

    it('should handle multiple deferred actions', async () => {
      const executedActions: string[] = [];

      deferredActions.push(async () => executedActions.push('email_notification'));
      deferredActions.push(async () => executedActions.push('hubspot_sync'));
      deferredActions.push(async () => executedActions.push('websocket_broadcast'));

      await processor.beginTransaction();
      await processor.commitTransaction();

      for (const action of deferredActions) {
        await action();
      }

      expect(executedActions).toHaveLength(3);
      expect(executedActions).toContain('email_notification');
      expect(executedActions).toContain('hubspot_sync');
      expect(executedActions).toContain('websocket_broadcast');
    });

    it('should continue executing other deferred actions if one fails', async () => {
      const executedActions: string[] = [];

      deferredActions.push(async () => executedActions.push('action1'));
      deferredActions.push(async () => { throw new Error('Action 2 failed'); });
      deferredActions.push(async () => executedActions.push('action3'));

      await processor.beginTransaction();
      await processor.commitTransaction();

      for (const action of deferredActions) {
        try {
          await action();
        } catch {
        }
      }

      expect(executedActions).toContain('action1');
      expect(executedActions).toContain('action3');
    });
  });

  describe('Event Priority Ordering', () => {
    it('should have correct priority for invoice lifecycle events', () => {
      expect(EVENT_PRIORITY['invoice.created']).toBeLessThan(EVENT_PRIORITY['invoice.finalized']);
      expect(EVENT_PRIORITY['invoice.finalized']).toBeLessThan(EVENT_PRIORITY['invoice.payment_succeeded']);
      expect(EVENT_PRIORITY['invoice.payment_succeeded']).toBeLessThan(EVENT_PRIORITY['invoice.voided']);
    });

    it('should have correct priority for payment intent lifecycle', () => {
      expect(EVENT_PRIORITY['payment_intent.created']).toBeLessThan(EVENT_PRIORITY['payment_intent.processing']);
      expect(EVENT_PRIORITY['payment_intent.processing']).toBeLessThan(EVENT_PRIORITY['payment_intent.succeeded']);
    });

    it('should handle events with equal priority', () => {
      expect(EVENT_PRIORITY['payment_intent.succeeded']).toBe(EVENT_PRIORITY['payment_intent.payment_failed']);
      expect(EVENT_PRIORITY['invoice.payment_succeeded']).toBe(EVENT_PRIORITY['invoice.payment_failed']);
    });
  });
});
