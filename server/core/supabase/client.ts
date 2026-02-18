import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getErrorMessage } from '../../utils/errorUtils';

import { logger } from '../logger';
let supabaseAdmin: SupabaseClient | null = null;
let supabaseAvailable: boolean | null = null;
let lastAvailabilityCheck: number = 0;
const AVAILABILITY_CHECK_INTERVAL = 60000; // Re-check every 60 seconds

export function getSupabaseAdmin(): SupabaseClient {
  if (supabaseAdmin) {
    return supabaseAdmin;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SERVICE_ROLE_KEY environment variables');
  }

  supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return supabaseAdmin;
}

export async function isSupabaseAvailable(): Promise<boolean> {
  const now = Date.now();
  
  // Return cached result if checked recently
  if (supabaseAvailable !== null && (now - lastAvailabilityCheck) < AVAILABILITY_CHECK_INTERVAL) {
    return supabaseAvailable;
  }
  
  if (!isSupabaseConfigured()) {
    supabaseAvailable = false;
    lastAvailabilityCheck = now;
    return false;
  }
  
  try {
    const supabase = getSupabaseAdmin();
    
    // Use Promise.race to enforce a timeout on the Supabase call
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Supabase availability check timeout')), 5000);
    });
    
    await Promise.race([
      supabase.auth.getSession(),
      timeoutPromise
    ]);
    
    supabaseAvailable = true;
    lastAvailabilityCheck = now;
    return true;
  } catch (err: unknown) {
    const errMsg = getErrorMessage(err) || '';
    if (errMsg.includes('fetch failed') || 
        errMsg.includes('ENOTFOUND') || 
        errMsg.includes('ECONNREFUSED') ||
        errMsg.includes('timeout')) {
      // Only log once when status changes
      if (supabaseAvailable !== false) {
        logger.warn('[Supabase] Service unreachable - Supabase features disabled');
      }
      supabaseAvailable = false;
    } else {
      // For other errors, assume it's available but had a different issue
      supabaseAvailable = true;
    }
    lastAvailabilityCheck = now;
    return supabaseAvailable;
  }
}

export function resetSupabaseAvailability(): void {
  supabaseAvailable = null;
  lastAvailabilityCheck = 0;
}

export function getSupabaseAnon(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    throw new Error('Missing SUPABASE_URL environment variable');
  }

  return createClient(supabaseUrl, anonKey || '', {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function isSupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SERVICE_ROLE_KEY);
}

export async function enableRealtimeForTable(tableName: string): Promise<boolean> {
  if (!isSupabaseConfigured()) {
    logger.warn(`[Supabase] Skipping realtime for ${tableName} - Supabase not configured`);
    return false;
  }

  const available = await isSupabaseAvailable();
  if (!available) {
    logger.warn(`[Supabase] Skipping realtime for ${tableName} - Supabase not reachable`);
    return false;
  }

  try {
    const supabase = getSupabaseAdmin();
    
    const { error } = await supabase.rpc('supabase_realtime_add_table', {
      table_name: tableName,
    });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('function') && msg.includes('does not exist')) {
        logger.warn(`[Supabase] Realtime RPC not available for ${tableName} - this is normal for some Supabase configurations`);
        return false;
      }
      if (msg.includes('fetch failed') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('TypeError')) {
        logger.warn(`[Supabase] Cannot reach Supabase for ${tableName} realtime - service may be unreachable`);
        supabaseAvailable = false;
        return false;
      }
      logger.error(`[Supabase] Failed to enable realtime for ${tableName}:`, { extra: { detail: msg } });
      return false;
    }

    logger.info(`[Supabase] Realtime enabled for table: ${tableName}`);
    return true;
  } catch (err: unknown) {
    const errMsg = getErrorMessage(err);
    if (errMsg.includes('fetch failed') || errMsg.includes('ENOTFOUND') || errMsg.includes('ECONNREFUSED')) {
      logger.warn(`[Supabase] Cannot reach Supabase for ${tableName} - check SUPABASE_URL configuration`);
    } else {
      logger.error(`[Supabase] Error enabling realtime for ${tableName}:`, { extra: { detail: errMsg } });
    }
    return false;
  }
}

export { SupabaseClient };
