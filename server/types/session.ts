import type { Session, SessionData } from 'express-session';

export interface SessionUser {
  id?: string;
  email: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  role?: string;
  tier?: string;
  tierId?: number;
  phone?: string;
  tags?: string[];
  mindbodyClientId?: string;
  status?: string;
  expires_at?: number;
  isTestUser?: boolean;
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
  }
}

export function getSessionUser(req: { session?: Session & Partial<SessionData> }): SessionUser | undefined {
  return req.session?.user;
}
