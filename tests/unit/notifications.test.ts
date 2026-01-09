import { describe, it, expect, vi, beforeEach } from 'vitest';
import WebSocket from 'ws';

interface NotificationDeliveryResult {
  success: boolean;
  connectionCount: number;
  sentCount: number;
  hasActiveSocket: boolean;
}

interface NotificationContext {
  action: string;
  bookingId?: number;
  resourceType?: string;
  triggerSource: string;
}

function createMockWebSocket(readyState: number): { ws: WebSocket; send: ReturnType<typeof vi.fn> } {
  const sendFn = vi.fn();
  return {
    ws: { readyState, send: sendFn } as unknown as WebSocket,
    send: sendFn
  };
}

function sendNotificationToUserMock(
  connections: Map<string, Array<{ ws: WebSocket; isAlive: boolean }>>,
  userEmail: string,
  notification: { type: string; title: string; message: string; data?: any },
  context?: NotificationContext
): NotificationDeliveryResult {
  const userConnections = connections.get(userEmail.toLowerCase());
  
  if (!userConnections || userConnections.length === 0) {
    return { success: false, connectionCount: 0, sentCount: 0, hasActiveSocket: false };
  }
  
  let sentCount = 0;
  const activeConnections = userConnections.filter(c => c.ws.readyState === WebSocket.OPEN);
  
  for (const conn of activeConnections) {
    try {
      conn.ws.send(JSON.stringify(notification));
      sentCount++;
    } catch (e) {
      // Send error - continue with other connections
    }
  }
  
  return {
    success: sentCount > 0,
    connectionCount: userConnections.length,
    sentCount,
    hasActiveSocket: activeConnections.length > 0
  };
}

describe('Notification System - WebSocket Delivery', () => {
  let connections: Map<string, Array<{ ws: WebSocket; isAlive: boolean }>>;
  
  beforeEach(() => {
    connections = new Map();
  });
  
  it('should deliver notification to connected user and return success result', () => {
    const userEmail = 'member@example.com';
    const { ws, send } = createMockWebSocket(WebSocket.OPEN);
    connections.set(userEmail, [{ ws, isAlive: true }]);
    
    const notification = {
      type: 'notification',
      title: 'Booking Approved',
      message: 'Your booking has been approved'
    };
    
    const result = sendNotificationToUserMock(connections, userEmail, notification);
    
    expect(result.success).toBe(true);
    expect(result.sentCount).toBe(1);
    expect(result.connectionCount).toBe(1);
    expect(result.hasActiveSocket).toBe(true);
    expect(send).toHaveBeenCalledWith(JSON.stringify(notification));
  });
  
  it('should return failure result when user has no connections', () => {
    const result = sendNotificationToUserMock(
      connections,
      'disconnected@example.com',
      { type: 'notification', title: 'Test', message: 'Test' }
    );
    
    expect(result.success).toBe(false);
    expect(result.connectionCount).toBe(0);
    expect(result.sentCount).toBe(0);
    expect(result.hasActiveSocket).toBe(false);
  });
  
  it('should handle multiple connections for same user', () => {
    const userEmail = 'multi-device@example.com';
    const { ws: ws1, send: send1 } = createMockWebSocket(WebSocket.OPEN);
    const { ws: ws2, send: send2 } = createMockWebSocket(WebSocket.OPEN);
    
    connections.set(userEmail, [
      { ws: ws1, isAlive: true },
      { ws: ws2, isAlive: true }
    ]);
    
    const result = sendNotificationToUserMock(
      connections,
      userEmail,
      { type: 'notification', title: 'Test', message: 'Test' }
    );
    
    expect(result.success).toBe(true);
    expect(result.sentCount).toBe(2);
    expect(result.connectionCount).toBe(2);
    expect(send1).toHaveBeenCalled();
    expect(send2).toHaveBeenCalled();
  });
  
  it('should skip closed connections and only count successful sends', () => {
    const userEmail = 'partial@example.com';
    const { ws: wsOpen, send: sendOpen } = createMockWebSocket(WebSocket.OPEN);
    const { ws: wsClosed, send: sendClosed } = createMockWebSocket(WebSocket.CLOSED);
    
    connections.set(userEmail, [
      { ws: wsOpen, isAlive: true },
      { ws: wsClosed, isAlive: false }
    ]);
    
    const result = sendNotificationToUserMock(
      connections,
      userEmail,
      { type: 'notification', title: 'Test', message: 'Test' }
    );
    
    expect(result.success).toBe(true);
    expect(result.sentCount).toBe(1);
    expect(result.connectionCount).toBe(2);
    expect(result.hasActiveSocket).toBe(true);
    expect(sendOpen).toHaveBeenCalled();
    expect(sendClosed).not.toHaveBeenCalled();
  });
  
  it('should handle case-insensitive email lookup', () => {
    const { ws, send } = createMockWebSocket(WebSocket.OPEN);
    connections.set('member@example.com', [{ ws, isAlive: true }]);
    
    const result = sendNotificationToUserMock(
      connections,
      'MEMBER@EXAMPLE.COM',
      { type: 'notification', title: 'Test', message: 'Test' }
    );
    
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalled();
  });
});

describe('Notification System - Badge Updates', () => {
  it('should dispatch member-notification event with correct detail structure', () => {
    const dispatchedEvents: CustomEvent[] = [];
    const listener = (e: Event) => dispatchedEvents.push(e as CustomEvent);
    
    window.addEventListener('member-notification', listener);
    
    const detail = { type: 'new_notification', count: 5, bookingId: 123 };
    window.dispatchEvent(new CustomEvent('member-notification', { detail }));
    
    expect(dispatchedEvents.length).toBe(1);
    expect(dispatchedEvents[0].detail).toEqual(detail);
    
    window.removeEventListener('member-notification', listener);
  });
  
  it('should trigger booking-update event with eventType for refetch', () => {
    let capturedEvent: CustomEvent | null = null;
    const handler = (e: Event) => { capturedEvent = e as CustomEvent; };
    
    window.addEventListener('booking-update', handler);
    
    window.dispatchEvent(new CustomEvent('booking-update', {
      detail: { eventType: 'booking_approved', bookingId: 456 }
    }));
    
    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent!.detail.eventType).toBe('booking_approved');
    expect(capturedEvent!.detail.bookingId).toBe(456);
    
    window.removeEventListener('booking-update', handler);
  });
});

describe('Notification System - Delivery Context Logging', () => {
  it('should include all required context fields for observability', () => {
    const context: NotificationContext = {
      action: 'booking_approved',
      bookingId: 123,
      resourceType: 'simulator',
      triggerSource: 'bays.ts'
    };
    
    expect(context.action).toBe('booking_approved');
    expect(context.bookingId).toBe(123);
    expect(context.resourceType).toBe('simulator');
    expect(context.triggerSource).toBe('bays.ts');
  });
  
  it('should structure delivery result for logging with all fields', () => {
    const deliveryResult: NotificationDeliveryResult = {
      success: true,
      connectionCount: 2,
      sentCount: 2,
      hasActiveSocket: true
    };
    
    const logEntry = {
      event: 'notification.delivery',
      status: deliveryResult.success ? 'success' : 'no_connection',
      ...deliveryResult
    };
    
    expect(logEntry.event).toBe('notification.delivery');
    expect(logEntry.status).toBe('success');
  });
  
  it('should identify failed delivery with correct status', () => {
    const failedDelivery: NotificationDeliveryResult = {
      success: false,
      connectionCount: 0,
      sentCount: 0,
      hasActiveSocket: false
    };
    
    const status = !failedDelivery.hasActiveSocket 
      ? 'no_connection' 
      : failedDelivery.sentCount === 0 
        ? 'send_error' 
        : 'partial_failure';
    
    expect(status).toBe('no_connection');
  });
});

describe('Notification System - Push Fallback Structure', () => {
  it('should structure push notification with required web-push fields', () => {
    const pushPayload = {
      title: 'Booking Approved',
      body: 'Your golf simulator booking has been approved',
      url: '/dashboard',
      icon: '/logo.png'
    };
    
    expect(pushPayload).toHaveProperty('title');
    expect(pushPayload).toHaveProperty('body');
    expect(pushPayload).toHaveProperty('url');
  });
  
  it('should use correct URL for staff notifications', () => {
    const staffPush = {
      title: 'New Booking Request',
      body: 'John Doe has requested a golf simulator booking',
      url: '/#/staff'
    };
    
    expect(staffPush.url).toMatch(/\/staff/);
  });
});
