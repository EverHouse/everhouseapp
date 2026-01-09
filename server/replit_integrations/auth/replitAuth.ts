import session from "express-session";
import type { RequestHandler } from "express";
import connectPg from "connect-pg-simple";
import type { Pool } from "pg";
import { pool } from "../../core/db";
import { getSessionUser } from "../../types/session";

export function getAuthPool() {
  if (!process.env.DATABASE_URL) {
    console.warn('[Auth] DATABASE_URL not configured - database features disabled');
    return null;
  }
  return pool;
}

export function getSession() {
  const sessionSecret = process.env.SESSION_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === '1';
  
  const cookieConfig = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' as const : 'lax' as const,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  };
  
  if (!sessionSecret) {
    console.warn('[Session] SESSION_SECRET is missing');
    console.log('[Session] Using MemoryStore');
    return session({
      secret: 'temporary-fallback-secret-' + Date.now(),
      resave: false,
      saveUninitialized: false,
      cookie: cookieConfig,
    });
  }
  
  if (!databaseUrl) {
    console.log('[Session] Using MemoryStore');
    return session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: cookieConfig,
    });
  }
  
  try {
    const sessionTtl = 30 * 24 * 60 * 60 * 1000; // 30 days
    const pgStore = connectPg(session);
    const sessionStore = new pgStore({
      conString: databaseUrl,
      createTableIfMissing: true,
      ttl: sessionTtl,
      tableName: "sessions",
      errorLog: (err: Error) => {
        console.error('[Session Store] Error:', err.message);
      },
    });
    
    console.log('[Session] Using Postgres session store');
    return session({
      secret: sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: cookieConfig,
    });
  } catch (err: any) {
    console.warn('[Session] Postgres store failed, using MemoryStore:', err.message);
    console.log('[Session] Using MemoryStore');
    return session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: cookieConfig,
    });
  }
}

export async function queryWithRetry(pool: Pool, query: string, params: any[]): Promise<any> {
  try {
    return await pool.query(query, params);
  } catch (error: any) {
    console.warn('[Auth] Query failed, retrying once:', error.message);
    return await pool.query(query, params);
  }
}

export async function isAdminEmail(email: string): Promise<boolean> {
  const pool = getAuthPool();
  if (!pool) return false;
  
  try {
    const result = await queryWithRetry(
      pool,
      'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND role = $2 AND is_active = true',
      [email, 'admin']
    );
    return result.rows.length > 0;
  } catch (error: any) {
    console.error('Error checking admin status:', error.message);
    return false;
  }
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  const user = getSessionUser(req);

  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  return next();
};

export const isAdmin: RequestHandler = async (req, res, next) => {
  const user = getSessionUser(req);

  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const email = user.email?.toLowerCase() || '';
  const adminStatus = await isAdminEmail(email);
  
  if (!adminStatus) {
    return res.status(403).json({ message: "Forbidden: Admin access required" });
  }

  return next();
};

export const isStaffOrAdmin: RequestHandler = async (req, res, next) => {
  const user = getSessionUser(req);

  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const email = user.email?.toLowerCase() || '';
  
  const adminStatus = await isAdminEmail(email);
  if (adminStatus) {
    return next();
  }

  const pool = getAuthPool();
  if (!pool) {
    return res.status(403).json({ message: "Forbidden: Staff access required" });
  }

  try {
    const result = await queryWithRetry(
      pool,
      'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email]
    );
    if (result.rows.length > 0) {
      return next();
    }
  } catch (error: any) {
    console.error('Error checking staff status:', error.message);
  }

  return res.status(403).json({ message: "Forbidden: Staff access required" });
};
