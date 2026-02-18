import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Express, RequestHandler } from 'express';
import { authStorage } from '../replit_integrations/auth/storage';
import { logger } from '../core/logger';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }
  if (!supabaseClient) {
    supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
  }
  return supabaseClient;
}

export { getSupabaseClient };

export function setupSupabaseAuthRoutes(app: Express) {
  const client = getSupabaseClient();
  
  if (!client) {
    logger.info('Supabase auth routes disabled - credentials not configured');
    
    const supabaseNotConfigured = (_req: Request, res: Response) => {
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
      
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name: firstName,
            last_name: lastName,
          }
        }
      });
      
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
      logger.error('Supabase signup error:', { error: error as Error });
      res.status(500).json({ error: 'Signup failed' });
    }
  });

  app.post('/api/supabase/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      
      const { data, error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      
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
      logger.error('Supabase login error:', { error: error as Error });
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.post('/api/supabase/logout', async (req, res) => {
    try {
      const { error } = await client.auth.signOut();
      
      if (error) {
        return res.status(400).json({ error: error.message });
      }
      
      res.json({ message: 'Logged out successfully' });
    } catch (error: unknown) {
      logger.error('Supabase logout error:', { error: error as Error });
      res.status(500).json({ error: 'Logout failed' });
    }
  });

  app.post('/api/supabase/forgot-password', async (req, res) => {
    try {
      const { email } = req.body;
      
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: `${req.protocol}://${req.hostname}/reset-password`,
      });
      
      if (error) {
        return res.status(400).json({ error: error.message });
      }
      
      res.json({ message: 'Check your email for the password reset link' });
    } catch (error: unknown) {
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
      const { data: { user }, error } = await client.auth.getUser(token);
      
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
      logger.error('Get user error:', { error: error as Error });
      res.status(500).json({ error: 'Failed to get user' });
    }
  });

  app.post('/api/supabase/oauth', async (req, res) => {
    try {
      const { provider } = req.body;
      
      const { data, error } = await client.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${req.protocol}://${req.hostname}/auth/callback`,
        }
      });
      
      if (error) {
        return res.status(400).json({ error: error.message });
      }
      
      res.json({ url: data.url });
    } catch (error: unknown) {
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
    const { data: { user }, error } = await client.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    (req as Request & { supabaseUser?: unknown }).supabaseUser = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Authentication failed' });
  }
};
