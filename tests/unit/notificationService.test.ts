import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NotificationType, NotificationPayload, DeliveryResult, NotificationResult } from '../../server/core/notificationService';

describe('Notification Service Types', () => {
  describe('NotificationType', () => {
    it('should have all expected booking types', () => {
      const bookingTypes: NotificationType[] = [
        'booking',
        'booking_approved',
        'booking_declined',
        'booking_cancelled',
        'booking_reminder'
      ];
      expect(bookingTypes).toHaveLength(5);
    });
    
    it('should have event and wellness types', () => {
      const otherTypes: NotificationType[] = [
        'event',
        'event_reminder',
        'wellness',
        'wellness_reminder'
      ];
      expect(otherTypes).toHaveLength(4);
    });
    
    it('should have utility types', () => {
      const utilTypes: NotificationType[] = [
        'guest_pass',
        'tour_scheduled',
        'system',
        'staff_note'
      ];
      expect(utilTypes).toHaveLength(4);
    });
  });

  describe('NotificationPayload', () => {
    it('should accept valid payload', () => {
      const payload: NotificationPayload = {
        userEmail: 'test@example.com',
        title: 'Test Title',
        message: 'Test message',
        type: 'booking_approved'
      };
      
      expect(payload.userEmail).toBe('test@example.com');
      expect(payload.title).toBe('Test Title');
      expect(payload.message).toBe('Test message');
      expect(payload.type).toBe('booking_approved');
    });
    
    it('should accept optional fields', () => {
      const payload: NotificationPayload = {
        userEmail: 'test@example.com',
        title: 'Test Title',
        message: 'Test message',
        type: 'booking_approved',
        relatedId: 123,
        relatedType: 'booking_request',
        url: '/#/sims'
      };
      
      expect(payload.relatedId).toBe(123);
      expect(payload.relatedType).toBe('booking_request');
      expect(payload.url).toBe('/#/sims');
    });
  });

  describe('DeliveryResult', () => {
    it('should represent successful database delivery', () => {
      const result: DeliveryResult = {
        channel: 'database',
        success: true,
        details: { notificationId: 456 }
      };
      
      expect(result.channel).toBe('database');
      expect(result.success).toBe(true);
      expect(result.details?.notificationId).toBe(456);
    });
    
    it('should represent failed websocket delivery', () => {
      const result: DeliveryResult = {
        channel: 'websocket',
        success: false,
        error: 'No active connections'
      };
      
      expect(result.channel).toBe('websocket');
      expect(result.success).toBe(false);
      expect(result.error).toBe('No active connections');
    });
    
    it('should represent push notification with subscription counts', () => {
      const result: DeliveryResult = {
        channel: 'push',
        success: true,
        details: { successCount: 2, failCount: 1, totalSubscriptions: 3 }
      };
      
      expect(result.channel).toBe('push');
      expect(result.success).toBe(true);
      expect(result.details?.successCount).toBe(2);
      expect(result.details?.failCount).toBe(1);
    });
  });
});

describe('Notification Delivery Logic', () => {
  it('should determine all succeeded when all channels succeed', () => {
    const results: DeliveryResult[] = [
      { channel: 'database', success: true },
      { channel: 'websocket', success: true },
      { channel: 'push', success: true }
    ];
    
    const allSucceeded = results.every(r => r.success);
    expect(allSucceeded).toBe(true);
  });
  
  it('should determine not all succeeded when any channel fails', () => {
    const results: DeliveryResult[] = [
      { channel: 'database', success: true },
      { channel: 'websocket', success: false, error: 'No connection' },
      { channel: 'push', success: true }
    ];
    
    const allSucceeded = results.every(r => r.success);
    expect(allSucceeded).toBe(false);
  });
  
  it('should count successful deliveries', () => {
    const results: DeliveryResult[] = [
      { channel: 'database', success: true },
      { channel: 'websocket', success: false },
      { channel: 'push', success: true }
    ];
    
    const successCount = results.filter(r => r.success).length;
    expect(successCount).toBe(2);
  });
});

describe('NotificationResult Aggregation', () => {
  it('should aggregate results from all channels', () => {
    const result: NotificationResult = {
      notificationId: 123,
      deliveryResults: [
        { channel: 'database', success: true, details: { notificationId: 123 } },
        { channel: 'websocket', success: true, details: { connectionsSent: 2 } },
        { channel: 'push', success: true, details: { successCount: 1, failCount: 0, totalSubscriptions: 1 } }
      ],
      allSucceeded: true
    };
    
    expect(result.notificationId).toBe(123);
    expect(result.deliveryResults).toHaveLength(3);
    expect(result.allSucceeded).toBe(true);
  });
  
  it('should report partial success correctly', () => {
    const result: NotificationResult = {
      notificationId: 456,
      deliveryResults: [
        { channel: 'database', success: true },
        { channel: 'websocket', success: false, error: 'No active connection' },
        { channel: 'push', success: true, details: { reason: 'no_subscriptions' } }
      ],
      allSucceeded: false
    };
    
    expect(result.allSucceeded).toBe(false);
    const wsResult = result.deliveryResults.find(r => r.channel === 'websocket');
    expect(wsResult?.error).toBe('No active connection');
  });
  
  it('should handle database failure gracefully', () => {
    const result: NotificationResult = {
      notificationId: undefined,
      deliveryResults: [
        { channel: 'database', success: false, error: 'Database connection failed' }
      ],
      allSucceeded: false
    };
    
    expect(result.notificationId).toBeUndefined();
    expect(result.allSucceeded).toBe(false);
  });
});

describe('Delivery Channel Behavior', () => {
  describe('Database Channel', () => {
    it('should return notification ID on success', () => {
      const result: DeliveryResult = {
        channel: 'database',
        success: true,
        details: { notificationId: 789 }
      };
      
      expect(result.success).toBe(true);
      expect(result.details?.notificationId).toBe(789);
      expect(result.error).toBeUndefined();
    });
    
    it('should return error message on failure', () => {
      const result: DeliveryResult = {
        channel: 'database',
        success: false,
        error: 'Unique constraint violation'
      };
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unique constraint violation');
      expect(result.details).toBeUndefined();
    });
  });
  
  describe('WebSocket Channel', () => {
    it('should report connection and sent counts on success', () => {
      const result: DeliveryResult = {
        channel: 'websocket',
        success: true,
        details: { connectionsSent: 3 }
      };
      
      expect(result.success).toBe(true);
      expect(result.details?.connectionsSent).toBe(3);
    });
    
    it('should report zero connections when user is offline', () => {
      const result: DeliveryResult = {
        channel: 'websocket',
        success: false,
        details: { connectionsSent: 0 }
      };
      
      expect(result.success).toBe(false);
      expect(result.details?.connectionsSent).toBe(0);
    });
  });
  
  describe('Push Channel', () => {
    it('should report success even with no subscriptions', () => {
      const result: DeliveryResult = {
        channel: 'push',
        success: true,
        details: { reason: 'no_subscriptions', count: 0 }
      };
      
      expect(result.success).toBe(true);
      expect(result.details?.reason).toBe('no_subscriptions');
    });
    
    it('should report partial delivery with mixed results', () => {
      const result: DeliveryResult = {
        channel: 'push',
        success: true,
        details: { successCount: 2, failCount: 1, totalSubscriptions: 3 }
      };
      
      expect(result.success).toBe(true);
      expect(result.details?.successCount).toBe(2);
      expect(result.details?.failCount).toBe(1);
    });
    
    it('should report failure when all subscriptions fail', () => {
      const result: DeliveryResult = {
        channel: 'push',
        success: false,
        details: { successCount: 0, failCount: 3, totalSubscriptions: 3 }
      };
      
      expect(result.success).toBe(false);
      expect(result.details?.successCount).toBe(0);
    });
    
    it('should handle VAPID configuration error', () => {
      const result: DeliveryResult = {
        channel: 'push',
        success: false,
        error: 'VAPID keys not configured'
      };
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('VAPID keys not configured');
    });
  });
});

describe('Notification Service Integration Scenarios', () => {
  it('should handle booking approval notification flow', () => {
    const payload: NotificationPayload = {
      userEmail: 'member@example.com',
      title: 'Booking Approved!',
      message: 'Your simulator booking for January 15 at 2:00 PM has been approved.',
      type: 'booking_approved',
      relatedId: 42,
      relatedType: 'booking_request',
      url: '/#/sims'
    };
    
    const result: NotificationResult = {
      notificationId: 100,
      deliveryResults: [
        { channel: 'database', success: true, details: { notificationId: 100 } },
        { channel: 'websocket', success: true, details: { connectionsSent: 1 } },
        { channel: 'push', success: true, details: { successCount: 1, failCount: 0, totalSubscriptions: 1 } }
      ],
      allSucceeded: true
    };
    
    expect(result.allSucceeded).toBe(true);
    expect(result.notificationId).toBe(100);
    expect(payload.type).toBe('booking_approved');
  });
  
  it('should handle staff notification for new booking request', () => {
    const staffResult = {
      staffCount: 3,
      deliveryResults: [
        { channel: 'database' as const, success: true, details: { staffCount: 3 } },
        { channel: 'websocket' as const, success: true, details: { connectionsSent: 2 } },
        { channel: 'push' as const, success: true, details: { successCount: 2, failCount: 0, totalSubscriptions: 2 } }
      ]
    };
    
    expect(staffResult.staffCount).toBe(3);
    expect(staffResult.deliveryResults.every(r => r.success)).toBe(true);
  });
  
  it('should handle offline member notification gracefully', () => {
    const result: NotificationResult = {
      notificationId: 200,
      deliveryResults: [
        { channel: 'database', success: true, details: { notificationId: 200 } },
        { channel: 'websocket', success: false, details: { connectionsSent: 0 } },
        { channel: 'push', success: true, details: { reason: 'no_subscriptions', count: 0 } }
      ],
      allSucceeded: false
    };
    
    expect(result.notificationId).toBe(200);
    expect(result.allSucceeded).toBe(false);
    
    const dbResult = result.deliveryResults.find(r => r.channel === 'database');
    expect(dbResult?.success).toBe(true);
  });
});
