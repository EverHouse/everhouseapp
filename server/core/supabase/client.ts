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
      supabase.from('users').select('id').limit(1),
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

let supabaseAnon: SupabaseClient | null = null;

export function getSupabaseAnon(): SupabaseClient {
  if (supabaseAnon) {
    return supabaseAnon;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables');
  }

  supabaseAnon = createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return supabaseAnon;
}

export function isSupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SERVICE_ROLE_KEY);
}

const REALTIME_SETUP_TIMEOUT = 10000;

export async function enableRealtimeForTable(tableName: string): Promise<boolean> {
  if (!isSupabaseConfigured()) {
    logger.debug(`[Supabase] Skipping realtime for ${tableName} - Supabase not configured`);
    return false;
  }

  const available = await isSupabaseAvailable();
  if (!available) {
    logger.debug(`[Supabase] Skipping realtime for ${tableName} - Supabase not reachable`);
    return false;
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Realtime setup for ${tableName} timed out after ${REALTIME_SETUP_TIMEOUT / 1000}s`)), REALTIME_SETUP_TIMEOUT);
  });

  try {
    const supabase = getSupabaseAdmin();

    const { error: tableCheckError } = await Promise.race([
      supabase.from(tableName).select('id').limit(0),
      timeoutPromise
    ]);
    if (tableCheckError) {
      const msg = tableCheckError.message || '';
      if (msg.includes('fetch failed') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('TypeError')) {
        logger.warn(`[Supabase] Cannot reach Supabase for ${tableName} realtime - service may be unreachable`);
        supabaseAvailable = false;
        return false;
      }
      logger.warn(`[Supabase] Table ${tableName} does not exist or is not accessible: ${msg}`);
      return false;
    }

    const quotedTable = `"public"."${tableName.replace(/"/g, '')}"`;
    const { error: pubError } = await Promise.race([
      supabase.rpc('exec_sql' as unknown as string, {
        query: `ALTER PUBLICATION supabase_realtime ADD TABLE ${quotedTable}`
      }).maybeSingle(),
      timeoutPromise
    ]);

    if (pubError) {
      const msg = pubError.message || '';
      if (msg.includes('already member') || msg.includes('already exists') || msg.includes('duplicate')) {
        logger.info(`[Supabase] Table ${tableName} already in supabase_realtime publication`);
        return true;
      }
      if ((msg.includes('function') && (msg.includes('does not exist') || msg.includes('Could not find'))) || msg.includes('exec_sql')) {
        logger.info(`[Supabase] exec_sql RPC not available — assuming ${tableName} was added to realtime publication via dashboard`);
        return true;
      }
      if (msg.includes('fetch failed') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('TypeError')) {
        logger.warn(`[Supabase] Cannot reach Supabase for ${tableName} realtime - service may be unreachable`);
        supabaseAvailable = false;
        return false;
      }
      logger.warn(`[Supabase] Could not add ${tableName} to realtime publication: ${msg}`);
      return true;
    }

    logger.info(`[Supabase] Realtime enabled for table: ${tableName}`);
    return true;
  } catch (err: unknown) {
    const errMsg = getErrorMessage(err);
    if (errMsg.includes('timed out')) {
      logger.warn(`[Supabase] Realtime setup for ${tableName} timed out - marking Supabase as unavailable`);
      supabaseAvailable = false;
    } else if (errMsg.includes('fetch failed') || errMsg.includes('ENOTFOUND') || errMsg.includes('ECONNREFUSED')) {
      logger.warn(`[Supabase] Cannot reach Supabase for ${tableName} - check SUPABASE_URL configuration`);
    } else {
      logger.error(`[Supabase] Error enabling realtime for ${tableName}:`, { extra: { detail: errMsg } });
    }
    return false;
  }
}

export { SupabaseClient };
