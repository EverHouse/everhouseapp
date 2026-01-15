import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { parse as parseCookie } from 'cookie';
import { Pool } from 'pg';
import { logger } from './logger';

interface ClientConnection {
  ws: WebSocket;
  userEmail: string;
  isAlive: boolean;
  isStaff: boolean;
  sessionId?: string;
}

export interface NotificationDeliveryResult {
  success: boolean;
  connectionCount: number;
  sentCount: number;
  hasActiveSocket: boolean;
}

export interface NotificationContext {
  action?: string;
  bookingId?: number;
  eventId?: number;
  classId?: number;
  resourceType?: string;
  triggerSource?: string;
}

export interface BookingEvent {
  eventType: string;
  bookingId: number;
  memberEmail: string;
  memberName?: string;
  resourceId?: number;
  resourceName?: string;
  resourceType?: string;
  bookingDate: string;
  startTime: string;
  endTime?: string;
  durationMinutes?: number;
  playerCount?: number;
  status: string;
  actionBy?: 'member' | 'staff';
  timestamp: string;
}

const clients: Map<string, ClientConnection[]> = new Map();
const staffEmails: Set<string> = new Set();

let wss: WebSocketServer | null = null;
let sessionPool: Pool | null = null;

function getSessionPool(): Pool | null {
  if (sessionPool) return sessionPool;
  
  if (!process.env.DATABASE_URL) {
    console.warn('[WebSocket] DATABASE_URL not configured - session verification disabled');
    return null;
  }
  
  try {
    sessionPool = new Pool({ 
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      max: 5
    });
    return sessionPool;
  } catch (err: any) {
    console.warn('[WebSocket] Failed to create session pool:', err.message);
    return null;
  }
}

function parseSessionId(cookieHeader: string | undefined, sessionSecret: string): string | null {
  if (!cookieHeader) return null;
  
  try {
    const cookies = parseCookie(cookieHeader);
    const signedCookie = cookies['connect.sid'];
    
    if (!signedCookie) return null;
    
    if (signedCookie.startsWith('s:')) {
      const sessionId = signedCookie.slice(2).split('.')[0];
      return sessionId;
    }
    
    return signedCookie;
  } catch (err) {
    console.error('[WebSocket] Error parsing session cookie:', err);
    return null;
  }
}

interface SessionData {
  user?: {
    email: string;
    role: string;
    tier?: string;
    tierId?: number;
    firstName?: string;
    lastName?: string;
    isTestUser?: boolean;
  };
}

async function verifySessionFromDatabase(sessionId: string): Promise<SessionData | null> {
  const pool = getSessionPool();
  if (!pool) return null;
  
  try {
    const result = await pool.query(
      'SELECT sess FROM sessions WHERE sid = $1 AND expire > NOW()',
      [sessionId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const sessionData = result.rows[0].sess as SessionData;
    return sessionData;
  } catch (err) {
    console.error('[WebSocket] Error verifying session:', err);
    return null;
  }
}

async function getVerifiedUserFromRequest(req: IncomingMessage): Promise<{
  email: string;
  role: string;
  isStaff: boolean;
  sessionId: string;
} | null> {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    console.warn('[WebSocket] SESSION_SECRET not configured - session verification disabled');
    return null;
  }
  
  const sessionId = parseSessionId(req.headers.cookie, sessionSecret);
  if (!sessionId) {
    return null;
  }
  
  const sessionData = await verifySessionFromDatabase(sessionId);
  if (!sessionData?.user?.email) {
    return null;
  }
  
  const user = sessionData.user;
  const isStaff = user.role === 'staff' || user.role === 'admin';
  
  return {
    email: user.email.toLowerCase(),
    role: user.role,
    isStaff,
    sessionId
  };
}

const MAX_AUTH_ATTEMPTS = 3;
const AUTH_TIMEOUT_MS = 10000;

export function initWebSocketServer(server: Server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    let userEmail: string | null = null;
    let isAuthenticated = false;
    let sessionId: string | undefined;
    let authAttempts = 0;

    const verifiedUser = await getVerifiedUserFromRequest(req);
    
    if (verifiedUser) {
      userEmail = verifiedUser.email;
      isAuthenticated = true;
      sessionId = verifiedUser.sessionId;
      
      const connection: ClientConnection = { 
        ws, 
        userEmail, 
        isAlive: true, 
        isStaff: verifiedUser.isStaff,
        sessionId
      };
      
      const existing = clients.get(userEmail) || [];
      existing.push(connection);
      clients.set(userEmail, existing);
      
      if (verifiedUser.isStaff) {
        staffEmails.add(userEmail);
      }
      
      ws.send(JSON.stringify({ 
        type: 'auth_success',
        email: userEmail,
        verified: true
      }));
      
      logger.info(`[WebSocket] Session-verified connection: ${userEmail} (staff: ${verifiedUser.isStaff})`, {
        userEmail,
        extra: { event: 'websocket.authenticated', role: verifiedUser.role, isStaff: verifiedUser.isStaff, method: 'session_cookie' }
      });
    } else {
      const authTimeout = setTimeout(() => {
        if (!isAuthenticated) {
          logger.warn(`[WebSocket] Connection closed - no valid session within timeout`, {
            extra: { event: 'websocket.auth_timeout', reason: 'no_valid_session_within_timeout' }
          });
          ws.close(4001, 'Authentication timeout');
        }
      }, AUTH_TIMEOUT_MS);
      
      ws.once('close', () => clearTimeout(authTimeout));
    }

    ws.on('message', async (data) => {
      if (!isAuthenticated) {
        try {
          const message = JSON.parse(data.toString());
          
          if (message.type === 'auth') {
            authAttempts++;
            
            if (authAttempts > MAX_AUTH_ATTEMPTS) {
              logger.warn(`[WebSocket] Connection closed - max auth attempts exceeded`, {
                extra: { event: 'websocket.auth_blocked', attempts: authAttempts, reason: 'max_attempts_exceeded' }
              });
              ws.close(4003, 'Too many authentication attempts');
              return;
            }
            
            const verifiedFromMessage = await getVerifiedUserFromRequest(req);
            
            if (verifiedFromMessage) {
              userEmail = verifiedFromMessage.email;
              isAuthenticated = true;
              sessionId = verifiedFromMessage.sessionId;
              
              const connection: ClientConnection = { 
                ws, 
                userEmail, 
                isAlive: true, 
                isStaff: verifiedFromMessage.isStaff,
                sessionId
              };
              
              const existing = clients.get(userEmail) || [];
              existing.push(connection);
              clients.set(userEmail, existing);
              
              if (verifiedFromMessage.isStaff) {
                staffEmails.add(userEmail);
              }
              
              ws.send(JSON.stringify({ 
                type: 'auth_success',
                email: userEmail,
                verified: true
              }));
              
              logger.info(`[WebSocket] Session-verified auth: ${userEmail}`, {
                userEmail,
                extra: { event: 'websocket.authenticated', role: verifiedFromMessage.role, isStaff: verifiedFromMessage.isStaff, method: 'auth_message', attempts: authAttempts }
              });
            } else {
              ws.send(JSON.stringify({ 
                type: 'auth_error',
                message: 'Invalid or expired session',
                attemptsRemaining: MAX_AUTH_ATTEMPTS - authAttempts
              }));
              
              logger.warn(`[WebSocket] Auth rejected - session verification failed (attempt ${authAttempts}/${MAX_AUTH_ATTEMPTS})`, {
                extra: { event: 'websocket.auth_failed', clientEmail: message.email, reason: 'session_verification_failed', attempts: authAttempts }
              });
              
              if (authAttempts >= MAX_AUTH_ATTEMPTS) {
                ws.close(4002, 'Authentication failed');
              }
            }
          } else {
            ws.send(JSON.stringify({ 
              type: 'error',
              message: 'Not authenticated'
            }));
          }
        } catch (e) {
          console.error('[WebSocket] Error parsing message from unauthenticated client:', e);
        }
        return;
      }
      
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'auth') {
          ws.send(JSON.stringify({ 
            type: 'auth_success',
            email: userEmail,
            verified: true
          }));
          return;
        }
        
        if (message.type === 'staff_register' && userEmail && isAuthenticated) {
          const connections = clients.get(userEmail) || [];
          
          const verifiedStaff = await getVerifiedUserFromRequest(req);
          if (verifiedStaff?.isStaff) {
            connections.forEach(conn => {
              if (conn.ws === ws) {
                conn.isStaff = true;
              }
            });
            staffEmails.add(userEmail);
            console.log(`[WebSocket] Staff verified and registered: ${userEmail}`);
          } else {
            logger.warn(`[WebSocket] Staff register rejected - user is not staff`, {
              userEmail,
              extra: { event: 'websocket.staff_register_rejected', reason: 'not_staff_role' }
            });
          }
        }
        
        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        console.error('[WebSocket] Error parsing message:', e);
      }
    });

    ws.on('close', () => {
      if (userEmail) {
        const connections = clients.get(userEmail) || [];
        const filtered = connections.filter(c => c.ws !== ws);
        if (filtered.length > 0) {
          clients.set(userEmail, filtered);
        } else {
          clients.delete(userEmail);
          staffEmails.delete(userEmail);
        }
        console.log(`[WebSocket] Client disconnected: ${userEmail}`);
      }
    });

    ws.on('pong', () => {
      if (userEmail) {
        const connections = clients.get(userEmail) || [];
        const conn = connections.find(c => c.ws === ws);
        if (conn) conn.isAlive = true;
      }
    });
  });

  const heartbeatInterval = setInterval(() => {
    clients.forEach((connections, email) => {
      connections.forEach((conn, index) => {
        if (!conn.isAlive) {
          conn.ws.terminate();
          connections.splice(index, 1);
          return;
        }
        conn.isAlive = false;
        conn.ws.ping();
      });
      if (connections.length === 0) {
        clients.delete(email);
        staffEmails.delete(email);
      }
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  console.log('[WebSocket] Server initialized on /ws with session-based authentication');
  return wss;
}

export function getClientStatus(userEmail: string): { connected: boolean; connectionCount: number; activeCount: number } {
  const email = userEmail.toLowerCase();
  const connections = clients.get(email) || [];
  const activeCount = connections.filter(c => c.ws.readyState === WebSocket.OPEN).length;
  return {
    connected: connections.length > 0,
    connectionCount: connections.length,
    activeCount
  };
}

export function sendNotificationToUser(
  userEmail: string, 
  notification: {
    type: string;
    title: string;
    message: string;
    data?: any;
  },
  context?: NotificationContext
): NotificationDeliveryResult {
  const email = userEmail.toLowerCase();
  const connections = clients.get(email) || [];
  const hasActiveSocket = connections.some(c => c.ws.readyState === WebSocket.OPEN);
  
  if (connections.length === 0) {
    logger.info(`[WebSocket] No connection for ${email} - notification not delivered`, {
      userEmail: email,
      bookingId: context?.bookingId,
      extra: {
        event: 'notification.delivery', status: 'no_connection', notificationType: notification.type,
        action: context?.action, resourceType: context?.resourceType, triggerSource: context?.triggerSource,
        hasActiveSocket: false, connectionCount: 0, sentCount: 0
      }
    });
    
    return { success: false, connectionCount: 0, sentCount: 0, hasActiveSocket: false };
  }

  const payload = JSON.stringify({
    type: 'notification',
    ...notification
  });

  let sent = 0;
  connections.forEach(conn => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(payload);
        sent++;
      } catch (error) {
        logger.warn(`[WebSocket] Error sending to ${email}`, {
          userEmail: email,
          error: (error as Error).message,
          extra: { event: 'notification.delivery', status: 'send_error', notificationType: notification.type }
        });
      }
    }
  });

  const result: NotificationDeliveryResult = {
    success: sent > 0,
    connectionCount: connections.length,
    sentCount: sent,
    hasActiveSocket
  };

  if (sent > 0) {
    logger.info(`[WebSocket] Sent notification to ${email} (${sent}/${connections.length} connections)`, {
      userEmail: email,
      bookingId: context?.bookingId,
      extra: {
        event: 'notification.delivery', status: 'success', notificationType: notification.type,
        action: context?.action, resourceType: context?.resourceType, triggerSource: context?.triggerSource,
        hasActiveSocket, connectionCount: connections.length, sentCount: sent
      }
    });
  } else {
    logger.warn(`[WebSocket] No active connections for ${email} - notification not delivered`, {
      userEmail: email,
      bookingId: context?.bookingId,
      extra: {
        event: 'notification.delivery', status: 'no_active_connections', notificationType: notification.type,
        action: context?.action, hasActiveSocket, connectionCount: connections.length, sentCount: 0
      }
    });
  }

  return result;
}

export function broadcastToAllMembers(notification: {
  type: string;
  title: string;
  message: string;
  data?: any;
}) {
  const payload = JSON.stringify({
    type: 'notification',
    ...notification
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  console.log(`[WebSocket] Broadcast notification to ${sent} connections`);
  return sent;
}

export function broadcastToStaff(notification: {
  type: string;
  title?: string;
  message?: string;
  action?: string;
  eventId?: number;
  classId?: number;
  memberEmail?: string;
  data?: any;
}) {
  const payload = JSON.stringify({
    type: 'notification',
    ...notification
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  if (sent > 0) {
    console.log(`[WebSocket] Broadcast to staff: ${sent} connections`);
  }
  return sent;
}

export function broadcastBookingEvent(event: BookingEvent) {
  const payload = JSON.stringify({
    type: 'booking_event',
    ...event
  });

  let sent = 0;
  let totalConnections = 0;
  let staffConnections = 0;
  
  clients.forEach((connections, email) => {
    connections.forEach(conn => {
      totalConnections++;
      if (conn.isStaff) {
        staffConnections++;
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(payload);
          sent++;
        }
      }
    });
  });

  if (sent > 0) {
    console.log(`[WebSocket] Broadcast booking event ${event.eventType} to ${sent} staff connections`);
  } else {
    console.log(`[WebSocket] No staff connections for booking event ${event.eventType} (total: ${totalConnections}, staff: ${staffConnections}, staffEmails: ${Array.from(staffEmails).join(', ')})`);
  }
  return sent;
}

export function broadcastAnnouncementUpdate(action: 'created' | 'updated' | 'deleted', announcement?: any) {
  const payload = JSON.stringify({
    type: 'announcement_update',
    action,
    announcement
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  console.log(`[WebSocket] Broadcast announcement ${action} to ${sent} connections`);
  return sent;
}

export function broadcastAvailabilityUpdate(data: {
  resourceId?: number;
  resourceType?: string;
  date?: string;
  action: 'booked' | 'cancelled' | 'updated';
}) {
  const payload = JSON.stringify({
    type: 'availability_update',
    ...data
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  if (sent > 0) {
    console.log(`[WebSocket] Broadcast availability ${data.action} to ${sent} connections`);
  }
  return sent;
}

export function broadcastWaitlistUpdate(data: {
  classId?: number;
  eventId?: number;
  action: 'spot_opened' | 'enrolled' | 'removed';
  spotsAvailable?: number;
}) {
  const payload = JSON.stringify({
    type: 'waitlist_update',
    ...data
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  if (sent > 0) {
    console.log(`[WebSocket] Broadcast waitlist ${data.action} to ${sent} connections`);
  }
  return sent;
}

export function broadcastDirectoryUpdate(action: 'synced' | 'updated' | 'created') {
  const payload = JSON.stringify({
    type: 'directory_update',
    action
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  if (sent > 0) {
    console.log(`[WebSocket] Broadcast directory ${action} to ${sent} staff connections`);
  }
  return sent;
}

export function broadcastCafeMenuUpdate(action: 'created' | 'updated' | 'deleted') {
  const payload = JSON.stringify({
    type: 'cafe_menu_update',
    action
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  if (sent > 0) {
    console.log(`[WebSocket] Broadcast cafe menu ${action} to ${sent} connections`);
  }
  return sent;
}

export function broadcastClosureUpdate(action: 'created' | 'updated' | 'deleted' | 'synced', closureId?: number) {
  const payload = JSON.stringify({
    type: 'closure_update',
    action,
    closureId
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  if (sent > 0) {
    console.log(`[WebSocket] Broadcast closure ${action} to ${sent} connections`);
  }
  return sent;
}

export function broadcastMemberDataUpdated(changedEmails: string[] = []) {
  const payload = JSON.stringify({
    type: 'member_data_updated',
    changedEmails
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  if (sent > 0 && changedEmails.length > 0) {
    console.log(`[WebSocket] Broadcast member data updated (${changedEmails.length} members) to ${sent} staff connections`);
  }
  return sent;
}

export function broadcastMemberStatsUpdated(memberEmail: string, data: { guestPasses?: number; lifetimeVisits?: number }) {
  const payload = JSON.stringify({
    type: 'member_stats_updated',
    memberEmail,
    ...data
  });

  // Send to the specific member
  const memberConnections = clients.get(memberEmail.toLowerCase()) || [];
  let sent = 0;
  memberConnections.forEach(conn => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(payload);
      sent++;
    }
  });

  // Also broadcast to staff
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  if (sent > 0) {
    console.log(`[WebSocket] Broadcast member stats updated for ${memberEmail} to ${sent} connections`);
  }
  return sent;
}

export function broadcastDataIntegrityUpdate(action: 'check_complete' | 'issue_resolved' | 'data_changed', details?: { source?: string; affectedChecks?: string[] }) {
  const payload = JSON.stringify({
    type: 'data_integrity_update',
    action,
    ...details
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  if (sent > 0) {
    console.log(`[WebSocket] Broadcast data integrity ${action} to ${sent} staff connections`);
  }
  return sent;
}

export function broadcastBillingUpdate(data: {
  action: 'subscription_created' | 'subscription_cancelled' | 'subscription_updated' | 
          'payment_succeeded' | 'payment_failed' | 'invoice_paid' | 'invoice_failed';
  customerId?: string;
  memberEmail?: string;
  memberName?: string;
  amount?: number;
  planName?: string;
  status?: string;
}) {
  const payload = JSON.stringify({
    type: 'billing_update',
    ...data
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
        sent++;
      }
    });
  });

  if (sent > 0) {
    console.log(`[WebSocket] Broadcast billing ${data.action} to ${sent} staff connections`);
  }
  return sent;
}

export function getConnectedUsers(): string[] {
  return Array.from(clients.keys());
}

export function getConnectedStaff(): string[] {
  return Array.from(staffEmails);
}

export function isUserConnected(email: string): boolean {
  const connections = clients.get(email.toLowerCase());
  return !!connections && connections.some(c => c.ws.readyState === WebSocket.OPEN);
}
