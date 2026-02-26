import { WebSocketServer, WebSocket } from 'ws';
import { getErrorMessage } from '../utils/errorUtils';
import { Server, IncomingMessage } from 'http';
import { parse as parseCookie } from 'cookie';
import { unsign } from 'cookie-signature';
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
  
  const poolerUrl = process.env.DATABASE_POOLER_URL;
  const directUrl = process.env.DATABASE_URL;
  const usePooler = process.env.ENABLE_PGBOUNCER === 'true' && !!poolerUrl;
  const dbUrl = usePooler ? poolerUrl : directUrl;
  if (!dbUrl) {
    logger.warn('[WebSocket] No database URL configured - session verification disabled');
    return null;
  }
  
  try {
    const needsSsl = process.env.NODE_ENV === 'production' || usePooler;
    sessionPool = new Pool({ 
      connectionString: dbUrl,
      connectionTimeoutMillis: 5000,
      max: 20,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
    return sessionPool;
  } catch (err: unknown) {
    logger.warn('[WebSocket] Failed to create session pool:', { extra: { detail: getErrorMessage(err) } });
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
      const raw = signedCookie.slice(2);
      const result = unsign(raw, sessionSecret);
      if (result === false) {
        logger.warn('[WebSocket] Cookie signature verification failed — possible tampering');
        return null;
      }
      return result;
    }
    
    return signedCookie;
  } catch (err: unknown) {
    logger.error('[WebSocket] Error parsing session cookie:', { error: err });
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
  } catch (err: unknown) {
    logger.error('[WebSocket] Error verifying session:', { error: err });
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
    logger.warn('[WebSocket] SESSION_SECRET not configured - session verification disabled');
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

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  
  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    
    // Allow Replit domains
    if (hostname.endsWith('.replit.app') || 
        hostname.endsWith('.replit.dev') || 
        hostname.endsWith('.repl.co')) {
      return true;
    }
    
    // Allow localhost for development
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return true;
    }
    
    // Allow production domains
    if (hostname === 'everclub.app' || 
        hostname === 'everhouse.app' ||
        hostname.endsWith('.everclub.app') ||
        hostname.endsWith('.everhouse.app')) {
      return true;
    }
    
    // Allow domains from ALLOWED_ORIGINS env var
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];
    if (allowedOrigins.some(allowed => hostname === allowed || hostname.endsWith('.' + allowed))) {
      return true;
    }
    
    return false;
  } catch (err) {
    logger.debug('Origin validation failed', { error: err });
    return false;
  }
}

export function closeWebSocketServer(): void {
  if (wss) {
    clients.forEach((connections, email) => {
      connections.forEach(conn => {
        try {
          conn.ws.close(1001, 'Server shutting down');
        } catch (err: unknown) {
          // Ignore close errors during shutdown
        }
      });
    });
    clients.clear();
    staffEmails.clear();
    
    wss.close((err) => {
      if (err) {
        logger.error('[WebSocket] Error closing server:', { error: err });
      } else {
        logger.info('[WebSocket] Server closed gracefully');
      }
    });
    wss = null;
  }
}

export function initWebSocketServer(server: Server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  
  wss.on('error', (error) => {
    logger.error('[WebSocket] Server error:', { error: error.message, stack: error.stack });
    logger.error('[WebSocket] Server error:', { error: error });
  });

  wss.on('connection', async (ws, req) => {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      logger.warn('[WebSocket] Connection rejected - invalid origin', { 
        extra: { event: 'websocket.rejected', origin, reason: 'invalid_origin' } 
      });
      ws.close(4003, 'Forbidden origin');
      return;
    }
    
    ws.on('error', (error) => {
      logger.error('[WebSocket] Client connection error:', { error: error.message });
    });
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
      if (!existing.some(c => c.ws === ws)) {
        existing.push(connection);
      }
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
            
            let verifiedFromMessage: Awaited<ReturnType<typeof getVerifiedUserFromRequest>> = null;
            
            if (message.sessionId && typeof message.sessionId === 'string') {
              const sessionData = await verifySessionFromDatabase(message.sessionId);
              if (sessionData?.user?.email) {
                const user = sessionData.user;
                verifiedFromMessage = {
                  email: user.email.toLowerCase(),
                  role: user.role,
                  isStaff: user.role === 'staff' || user.role === 'admin',
                  sessionId: message.sessionId
                };
              }
            }
            
            if (!verifiedFromMessage) {
              verifiedFromMessage = await getVerifiedUserFromRequest(req);
            }
            
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
              if (!existing.some(c => c.ws === ws)) {
                existing.push(connection);
              }
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
        } catch (e: unknown) {
          logger.error('[WebSocket] Error parsing message from unauthenticated client:', { error: e });
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
          
          let isStaffUser = false;
          const verifiedStaff = await getVerifiedUserFromRequest(req);
          if (verifiedStaff?.isStaff) {
            isStaffUser = true;
          } else {
            const pool = getSessionPool();
            if (pool) {
              const staffCheck = await pool.query(
                `SELECT role FROM users WHERE LOWER(email) = LOWER($1) AND role IN ('staff', 'admin') LIMIT 1`,
                [userEmail]
              );
              if (staffCheck.rows.length > 0) {
                isStaffUser = true;
              }
            }
          }
          if (isStaffUser) {
            connections.forEach(conn => {
              if (conn.ws === ws) {
                conn.isStaff = true;
              }
            });
            staffEmails.add(userEmail);
            logger.info(`[WebSocket] Staff verified and registered: ${userEmail}`);
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
      } catch (e: unknown) {
        logger.error('[WebSocket] Error parsing message:', { error: e });
      }
    });

    ws.on('close', () => {
      if (userEmail) {
        const connections = clients.get(userEmail) || [];
        const filtered = connections.filter(c => c.ws !== ws);
        if (filtered.length > 0) {
          clients.set(userEmail, filtered);
          if (!filtered.some(c => c.isStaff)) {
            staffEmails.delete(userEmail);
          }
        } else {
          clients.delete(userEmail);
          staffEmails.delete(userEmail);
        }
        logger.info(`[WebSocket] Client disconnected: ${userEmail}`);
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
      const alive: ClientConnection[] = [];
      connections.forEach((conn) => {
        if (!conn.isAlive) {
          conn.ws.terminate();
          return;
        }
        conn.isAlive = false;
        conn.ws.ping();
        alive.push(conn);
      });
      if (alive.length === 0) {
        clients.delete(email);
        staffEmails.delete(email);
      } else {
        clients.set(email, alive);
      }
    });
  }, 30000);

  const sessionRevalidationInterval = setInterval(async () => {
    const pool = getSessionPool();
    if (!pool) return;

    for (const [email, connections] of clients) {
      const valid: ClientConnection[] = [];
      for (const conn of connections) {
        if (!conn.sessionId) {
          valid.push(conn);
          continue;
        }
        try {
          const result = await pool.query(
            'SELECT 1 FROM sessions WHERE sid = $1 AND expire > NOW()',
            [conn.sessionId]
          );
          if (result.rows.length === 0) {
            logger.info(`[WebSocket] Session expired/revoked for ${email} — terminating connection`);
            conn.ws.terminate();
          } else if (conn.ws.readyState === WebSocket.OPEN) {
            valid.push(conn);
          }
        } catch {
          if (conn.ws.readyState === WebSocket.OPEN) {
            valid.push(conn);
          }
        }
      }
      if (valid.length === 0) {
        clients.delete(email);
        staffEmails.delete(email);
      } else {
        clients.set(email, valid);
      }
    }
  }, 5 * 60 * 1000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
    clearInterval(sessionRevalidationInterval);
  });

  logger.info('[WebSocket] Server initialized on /ws with session-based authentication');
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
    data?: Record<string, unknown>;
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
      } catch (error: unknown) {
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
  data?: Record<string, unknown>;
}) {
  const payload = JSON.stringify({
    type: 'notification',
    ...notification
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastToAllMembers send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  logger.info(`[WebSocket] Broadcast notification to ${sent} connections`);
  return sent;
}

export function broadcastToStaff(notification: {
  type: string;
  title?: string;
  message?: string;
  action?: string;
  eventId?: number;
  classId?: number;
  tourId?: number;
  memberEmail?: string;
  data?: unknown;
  result?: unknown;
  error?: string;
  [key: string]: unknown;
}) {
  const payload = JSON.stringify({
    type: 'notification',
    ...notification
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastToStaff send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast to staff: ${sent} connections`);
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
          try {
            conn.ws.send(payload);
            sent++;
          } catch (err: unknown) {
            logger.warn(`[WebSocket] Error in broadcastBookingEvent send`, { error: getErrorMessage(err) });
          }
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast booking event ${event.eventType} to ${sent} staff connections`);
  } else {
    logger.info(`[WebSocket] No staff connections for booking event ${event.eventType} (total: ${totalConnections}, staff: ${staffConnections}, staffEmails: ${Array.from(staffEmails).join(', ')})`);
  }
  return sent;
}

export function broadcastAnnouncementUpdate(action: 'created' | 'updated' | 'deleted', announcement?: Record<string, unknown>) {
  const payload = JSON.stringify({
    type: 'announcement_update',
    action,
    announcement
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastAnnouncementUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  logger.info(`[WebSocket] Broadcast announcement ${action} to ${sent} connections`);
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
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastAvailabilityUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast availability ${data.action} to ${sent} connections`);
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
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastWaitlistUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast waitlist ${data.action} to ${sent} connections`);
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
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastDirectoryUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast directory ${action} to ${sent} staff connections`);
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
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastCafeMenuUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast cafe menu ${action} to ${sent} connections`);
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
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastClosureUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast closure ${action} to ${sent} connections`);
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
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastMemberDataUpdated send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0 && changedEmails.length > 0) {
    logger.info(`[WebSocket] Broadcast member data updated (${changedEmails.length} members) to ${sent} staff connections`);
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
      try {
        conn.ws.send(payload);
        sent++;
      } catch (err: unknown) {
        logger.warn(`[WebSocket] Error in broadcastMemberStatsUpdated send`, { error: getErrorMessage(err) });
      }
    }
  });

  // Also broadcast to staff
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastMemberStatsUpdated send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast member stats updated for ${memberEmail} to ${sent} connections`);
  }
  return sent;
}

export function broadcastTierUpdate(data: {
  action: 'assigned' | 'updated' | 'removed';
  memberEmail: string;
  tier?: string;
  previousTier?: string | null;
  assignedBy?: string;
}) {
  const payload = JSON.stringify({
    type: 'tier_update',
    ...data
  });

  let sent = 0;
  const memberEmail = data.memberEmail.toLowerCase();

  // Send to the member whose tier changed
  const memberConnections = clients.get(memberEmail) || [];
  memberConnections.forEach(conn => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(payload);
        sent++;
      } catch (err: unknown) {
        logger.warn(`[WebSocket] Error in broadcastTierUpdate send`, { error: getErrorMessage(err) });
      }
    }
  });

  // Also broadcast to all staff
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastTierUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast tier ${data.action} for ${memberEmail} to ${sent} connections`);
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
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastDataIntegrityUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast data integrity ${action} to ${sent} staff connections`);
  }
  return sent;
}

export function broadcastBillingUpdate(data: {
  action: 'subscription_created' | 'subscription_cancelled' | 'subscription_updated' | 
          'payment_succeeded' | 'payment_failed' | 'invoice_paid' | 'invoice_failed' |
          'booking_payment_updated' | 'payment_refunded' | 'balance_updated' |
          'invoice_created' | 'invoice_finalized' | 'invoice_voided' |
          'payment_confirmed';
  customerId?: string;
  memberEmail?: string;
  memberName?: string;
  amount?: number;
  planName?: string;
  status?: string;
  bookingId?: number;
  sessionId?: number;
  amountCents?: number;
  newBalance?: number;
}) {
  const payload = JSON.stringify({
    type: 'billing_update',
    ...data
  });

  let sent = 0;

  // Send to the affected member if memberEmail is provided
  if (data.memberEmail) {
    const memberConnections = clients.get(data.memberEmail.toLowerCase()) || [];
    memberConnections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastBillingUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  }

  // Also broadcast to all staff
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastBillingUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast billing ${data.action} to ${sent} connections (member: ${data.memberEmail || 'none'})`);
  }
  return sent;
}

export function broadcastDayPassUpdate(data: {
  action: 'day_pass_purchased' | 'day_pass_redeemed' | 'day_pass_refunded';
  passId: string;
  purchaserEmail?: string;
  purchaserName?: string;
  productType?: string;
  remainingUses?: number;
  quantity?: number;
  purchasedAt?: string;
}) {
  const payload = JSON.stringify({
    type: 'day_pass_update',
    ...data
  });

  let sent = 0;
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(payload);
          sent++;
        } catch (err: unknown) {
          logger.warn(`[WebSocket] Error in broadcastDayPassUpdate send`, { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast day pass ${data.action} to ${sent} staff connections`);
  }
  return sent;
}

// Debounce map for booking-scoped broadcasts (prevent event storms during batch roster edits)
const bookingBroadcastTimers = new Map<string, NodeJS.Timeout>();

export function broadcastBookingRosterUpdate(data: {
  bookingId: number;
  sessionId?: number;
  action: 'roster_updated' | 'player_count_changed' | 'participant_added' | 'participant_removed';
  memberEmail?: string;
  resourceType?: string;
  totalFeeCents?: number;
  participantCount?: number;
}) {
  const key = `roster_${data.bookingId}_${data.action}`;
  const existing = bookingBroadcastTimers.get(key);
  if (existing) clearTimeout(existing);

  bookingBroadcastTimers.set(key, setTimeout(() => {
    bookingBroadcastTimers.delete(key);
    const payload = JSON.stringify({
      type: 'booking_roster_update',
      ...data,
      timestamp: new Date().toISOString()
    });

    let sent = 0;

    if (data.memberEmail) {
      const memberConnections = clients.get(data.memberEmail.toLowerCase()) || [];
      memberConnections.forEach(conn => {
        if (conn.ws.readyState === WebSocket.OPEN) {
          try { conn.ws.send(payload); sent++; } catch (err: unknown) {
            logger.warn('[WebSocket] Error in broadcastBookingRosterUpdate send', { error: getErrorMessage(err) });
          }
        }
      });
    }

    const memberEmailLower = data.memberEmail?.toLowerCase();
    clients.forEach((connections) => {
      connections.forEach(conn => {
        if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN && conn.userEmail !== memberEmailLower) {
          try { conn.ws.send(payload); sent++; } catch (err: unknown) {
            logger.warn('[WebSocket] Error in broadcastBookingRosterUpdate send', { error: getErrorMessage(err) });
          }
        }
      });
    });

    if (sent > 0) {
      logger.info(`[WebSocket] Broadcast booking roster ${data.action} for booking #${data.bookingId} to ${sent} connections`);
    }
  }, 300));
}

export function broadcastBookingInvoiceUpdate(data: {
  bookingId: number;
  sessionId?: number;
  action: 'invoice_created' | 'invoice_updated' | 'invoice_finalized' | 'invoice_paid' | 'invoice_voided' | 'invoice_deleted' | 'payment_confirmed' | 'fees_waived' | 'payment_voided';
  memberEmail?: string;
  invoiceId?: string;
  totalCents?: number;
  paidInFull?: boolean;
  status?: string;
}) {
  const payload = JSON.stringify({
    type: 'booking_invoice_update',
    ...data,
    timestamp: new Date().toISOString()
  });

  let sent = 0;

  if (data.memberEmail) {
    const memberConnections = clients.get(data.memberEmail.toLowerCase()) || [];
    memberConnections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        try { conn.ws.send(payload); sent++; } catch (err: unknown) {
          logger.warn('[WebSocket] Error in broadcastBookingInvoiceUpdate send', { error: getErrorMessage(err) });
        }
      }
    });
  }

  const memberEmailLower = data.memberEmail?.toLowerCase();
  clients.forEach((connections) => {
    connections.forEach(conn => {
      if (conn.isStaff && conn.ws.readyState === WebSocket.OPEN && conn.userEmail !== memberEmailLower) {
        try { conn.ws.send(payload); sent++; } catch (err: unknown) {
          logger.warn('[WebSocket] Error in broadcastBookingInvoiceUpdate send', { error: getErrorMessage(err) });
        }
      }
    });
  });

  if (sent > 0) {
    logger.info(`[WebSocket] Broadcast booking invoice ${data.action} for booking #${data.bookingId} to ${sent} connections`);
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
