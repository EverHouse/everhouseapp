import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabaseClient: SupabaseClient | null = null;
let initAttempted = false;

function isValidSupabaseKey(key: string): boolean {
  // Supabase anon keys are JWTs that start with 'eyJ'
  return key && key.startsWith('eyJ') && key.length > 100;
}

export function getSupabase(): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;
  if (initAttempted) return null;
  
  initAttempted = true;
  
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  
  // Validate both URL and key format to prevent connection errors
  if (!url || !anonKey || !isValidSupabaseKey(anonKey)) {
    // Silently skip - Supabase Realtime is optional, WebSocket is primary
    return null;
  }
  
  try {
    supabaseClient = createClient(url, anonKey, {
      realtime: {
        heartbeatIntervalMs: 25000,
        reconnectAfterMs: (tries: number) => {
          return Math.min(1000 * Math.pow(2, tries), 30000);
        },
        timeout: 30000,
        eventsPerSecond: 100,
      }
    });
    return supabaseClient;
  } catch {
    return null;
  }
}

export const supabase = getSupabase();
export const isSupabaseConfigured = !!supabase;

export type AuthProvider = 'google' | 'apple' | 'github';

export async function signInWithEmail(email: string, password: string) {
  const client = getSupabase();
  if (!client) {
    return { data: null, error: { message: 'Supabase is not configured' } };
  }
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  return { data, error };
}

export async function signUpWithEmail(email: string, password: string, metadata?: { firstName?: string; lastName?: string }) {
  const client = getSupabase();
  if (!client) {
    return { data: null, error: { message: 'Supabase is not configured' } };
  }
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: {
      data: {
        first_name: metadata?.firstName,
        last_name: metadata?.lastName,
      }
    }
  });
  return { data, error };
}

export async function signInWithOAuth(provider: AuthProvider) {
  const client = getSupabase();
  if (!client) {
    return { data: null, error: { message: 'Supabase is not configured' } };
  }
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    }
  });
  return { data, error };
}

export async function signOut() {
  const client = getSupabase();
  if (!client) {
    return { error: { message: 'Supabase is not configured' } };
  }
  const { error } = await client.auth.signOut();
  return { error };
}

export async function resetPassword(email: string) {
  const client = getSupabase();
  if (!client) {
    return { data: null, error: { message: 'Supabase is not configured' } };
  }
  const { data, error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  return { data, error };
}

export async function getSession() {
  const client = getSupabase();
  if (!client) {
    return { data: null, error: { message: 'Supabase is not configured' } };
  }
  const { data, error } = await client.auth.getSession();
  return { data, error };
}

export async function getUser() {
  const client = getSupabase();
  if (!client) {
    return { user: null, error: { message: 'Supabase is not configured' } };
  }
  const { data: { user }, error } = await client.auth.getUser();
  return { user, error };
}
