import type { Express, RequestHandler } from 'express';
import { authStorage } from '../replit_integrations/auth/storage';
import { logger } from '../core/logger';
import { getSupabaseAnon } from '../core/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_ROUTE_TIMEOUT = 10000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${SUPABASE_ROUTE_TIMEOUT / 1000}s`)), SUPABASE_ROUTE_TIMEOUT)
    )
  ]);
}

function getSupabaseClient(): SupabaseClient | null {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return null;
  }
  try {
    return getSupabaseAnon();
  } catch {
    return null;
  }
}

export { getSupabaseClient };

export function setupSupabaseAuthRoutes(app: Express) {
  const client = getSupabaseClient();
  
  if (!client) {
    logger.info('Supabase auth routes disabled - credentials not configured');
    
    const supabaseNotConfigured: RequestHandler = (_req, res) => {
      res.status(503).json({ error: 'Supabase authentication is not configured' });
    };
    
    app.post('/api/supabase/signup', supabaseNotConfigured);
    app.post('/api/supabase/login', supabaseNotConfigured);
    app.post('/api/supabase/logout', supabaseNotConfigured);
    app.post('/api/supabase/forgot-password', supabaseNotConfigured);
    app.get('/api/supabase/user', supabaseNotConfigured);
    app.post('/api/supabase/oauth', supabaseNotConfigured);
    return;
  }

  logger.info('Supabase auth routes enabled');

  app.post('/api/supabase/signup', async (req, res) => {
    try {
      const { email, password, firstName, lastName } = req.body;
      
      const { data, error } = await withTimeout(
        client.auth.signUp({
          email,
          password,
          options: {
            data: {
              first_name: firstName,
              last_name: lastName,
            }
          }
        }),
        'Supabase signUp'
      );
      
      if (error) {
        return res.status(400).json({ error: error.message });
      }
      
      if (data.user) {
        await authStorage.upsertUser({
          id: data.user.id,
          email: data.user.email || email,
          firstName: firstName || '',
          lastName: lastName || '',
        });
      }
      
      res.json({ 
        message: 'Check your email for the confirmation link',
        user: data.user 
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('timed out')) {
        logger.warn('[Supabase Auth] Signup timed out');
        return res.status(504).json({ error: 'Authentication service timeout' });
      }
      logger.error('Supabase signup error:', { error: error as Error });
      res.status(500).json({ error: 'Signup failed' });
    }
  });

  app.post('/api/supabase/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      
      const { data, error } = await withTimeout(
        client.auth.signInWithPassword({
          email,
          password,
        }),
        'Supabase signInWithPassword'
      );
      
      if (error) {
        return res.status(401).json({ error: error.message });
      }
      
      if (data.user) {
        await authStorage.upsertUser({
          id: data.user.id,
          email: data.user.email || email,
          firstName: data.user.user_metadata?.first_name || '',
          lastName: data.user.user_metadata?.last_name || '',
        });
      }

      res.json({ 
        user: data.user,
        session: data.session
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('timed out')) {
        logger.warn('[Supabase Auth] Login timed out');
        return res.status(504).json({ error: 'Authentication service timeout' });
      }
      logger.error('Supabase login error:', { error: error as Error });
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.post('/api/supabase/logout', async (req, res) => {
    try {
      const { error } = await withTimeout(
        client.auth.signOut(),
        'Supabase signOut'
      );
      
      if (error) {
        return res.status(400).json({ error: error.message });
      }
      
      res.json({ message: 'Logged out successfully' });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('timed out')) {
        logger.warn('[Supabase Auth] Logout timed out');
        return res.status(504).json({ error: 'Authentication service timeout' });
      }
      logger.error('Supabase logout error:', { error: error as Error });
      res.status(500).json({ error: 'Logout failed' });
    }
  });

  app.post('/api/supabase/forgot-password', async (req, res) => {
    try {
      const { email } = req.body;
      
      const { error } = await withTimeout(
        client.auth.resetPasswordForEmail(email, {
          redirectTo: `${req.protocol}://${req.hostname}/reset-password`,
        }),
        'Supabase resetPasswordForEmail'
      );
      
      if (error) {
        return res.status(400).json({ error: error.message });
      }
      
      res.json({ message: 'Check your email for the password reset link' });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('timed out')) {
        logger.warn('[Supabase Auth] Forgot password timed out');
        return res.status(504).json({ error: 'Authentication service timeout' });
      }
      logger.error('Forgot password error:', { error: error as Error });
      res.status(500).json({ error: 'Failed to send reset email' });
    }
  });

  app.get('/api/supabase/user', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
      }
      
      const token = authHeader.substring(7);
      const { data: { user }, error } = await withTimeout(
        client.auth.getUser(token),
        'Supabase getUser'
      );
      
      if (error || !user) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const dbUser = await authStorage.getUser(user.id);
      
      res.json({
        id: user.id,
        email: user.email,
        firstName: dbUser?.firstName || user.user_metadata?.first_name || '',
        lastName: dbUser?.lastName || user.user_metadata?.last_name || '',
        role: dbUser?.role || 'member',
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('timed out')) {
        logger.warn('[Supabase Auth] Get user timed out');
        return res.status(504).json({ error: 'Authentication service timeout' });
      }
      logger.error('Get user error:', { error: error as Error });
      res.status(500).json({ error: 'Failed to get user' });
    }
  });

  app.post('/api/supabase/oauth', async (req, res) => {
    try {
      const { provider } = req.body;
      
      const { data, error } = await withTimeout(
        client.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: `${req.protocol}://${req.hostname}/auth/callback`,
          }
        }),
        'Supabase signInWithOAuth'
      );
      
      if (error) {
        return res.status(400).json({ error: error.message });
      }
      
      res.json({ url: data.url });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('timed out')) {
        logger.warn('[Supabase Auth] OAuth timed out');
        return res.status(504).json({ error: 'Authentication service timeout' });
      }
      logger.error('OAuth error:', { error: error as Error });
      res.status(500).json({ error: 'OAuth failed' });
    }
  });
}

export const isSupabaseAuthenticated: RequestHandler = async (req, res, next) => {
  const client = getSupabaseClient();
  
  if (!client) {
    return res.status(503).json({ error: 'Supabase authentication is not configured' });
  }
  
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.substring(7);
    const { data: { user }, error } = await withTimeout(
      client.auth.getUser(token),
      'Supabase getUser (middleware)'
    );
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    (req as unknown as Record<string, unknown>).supabaseUser = user;
    next();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('timed out')) {
      logger.warn('[Supabase Auth] Middleware auth check timed out');
      return res.status(504).json({ error: 'Authentication service timeout' });
    }
    res.status(401).json({ error: 'Authentication failed' });
  }
};
