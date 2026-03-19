import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getErrorMessage } from '../../utils/errorUtils';

import { logger } from '../logger';
let supabaseAdmin: SupabaseClient | null = null;
let supabaseAvailable: boolean | null = null;
let lastAvailabilityCheck: number = 0;
const AVAILABILITY_CHECK_INTERVAL = 60000;
const DEFAULT_AVAILABILITY_TIMEOUT = 5000;
const STARTUP_AVAILABILITY_TIMEOUT = 15000;

let realtimeTablesEnabled = false;

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

export async function isSupabaseAvailable(timeoutMs?: number): Promise<boolean> {
  const now = Date.now();
  
  if (supabaseAvailable !== null && (now - lastAvailabilityCheck) < AVAILABILITY_CHECK_INTERVAL) {
    return supabaseAvailable;
  }
  
  if (!isSupabaseConfigured()) {
    supabaseAvailable = false;
    lastAvailabilityCheck = now;
    return false;
  }
  
  const effectiveTimeout = timeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT;
  
  try {
    const supabase = getSupabaseAdmin();
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Supabase availability check timeout')), effectiveTimeout);
    });
    
    await Promise.race([
      supabase.from('users').select('id').limit(1),
      timeoutPromise
    ]);
    
    if (supabaseAvailable === false) {
      logger.info('[Supabase] Service recovered - Supabase features re-enabled');
    }
    supabaseAvailable = true;
    lastAvailabilityCheck = now;
    return true;
  } catch (err: unknown) {
    const errMsg = getErrorMessage(err) || '';
    if (errMsg.includes('fetch failed') || 
        errMsg.includes('ENOTFOUND') || 
        errMsg.includes('ECONNREFUSED') ||
        errMsg.includes('timeout')) {
      if (supabaseAvailable !== false) {
        logger.warn('[Supabase] Service unreachable - Supabase features disabled');
      }
      supabaseAvailable = false;
    } else {
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

export function isRealtimeEnabled(): boolean {
  return realtimeTablesEnabled;
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

const REALTIME_TABLES = ['notifications', 'booking_sessions', 'announcements', 'trackman_unmatched_bookings'] as const;

export async function enableRealtimeForTable(tableName: string, options?: { skipAvailabilityCheck?: boolean }): Promise<boolean> {
  if (!isSupabaseConfigured()) {
    logger.debug(`[Supabase] Skipping realtime for ${tableName} - Supabase not configured`);
    return false;
  }

  if (!options?.skipAvailabilityCheck) {
    const available = await isSupabaseAvailable();
    if (!available) {
      logger.debug(`[Supabase] Skipping realtime for ${tableName} - Supabase not reachable`);
      return false;
    }
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
      logger.warn(`[Supabase] Realtime setup for ${tableName} timed out`);
    } else if (errMsg.includes('fetch failed') || errMsg.includes('ENOTFOUND') || errMsg.includes('ECONNREFUSED')) {
      logger.warn(`[Supabase] Cannot reach Supabase for ${tableName} - check SUPABASE_URL configuration`);
    } else {
      logger.error(`[Supabase] Error enabling realtime for ${tableName}:`, { extra: { detail: errMsg } });
    }
    return false;
  }
}

export async function enableRealtimeWithRetry(): Promise<{ successCount: number; total: number }> {
  const total = REALTIME_TABLES.length;

  resetSupabaseAvailability();
  const available = await isSupabaseAvailable(STARTUP_AVAILABILITY_TIMEOUT);

  if (!available) {
    logger.warn('[Supabase] Not reachable on first attempt, retrying in 15s...');
    await new Promise(resolve => setTimeout(resolve, 15000));
    resetSupabaseAvailability();
    const retryAvailable = await isSupabaseAvailable(STARTUP_AVAILABILITY_TIMEOUT);
    if (!retryAvailable) {
      logger.warn('[Supabase] Still not reachable after retry — scheduling background recovery');
      scheduleRealtimeRecovery();
      return { successCount: 0, total };
    }
  }

  const results = await Promise.all(
    REALTIME_TABLES.map(table => enableRealtimeForTable(table, { skipAvailabilityCheck: true }))
  );
  const successCount = results.filter(Boolean).length;

  if (successCount === total) {
    realtimeTablesEnabled = true;
    logger.info(`[Supabase] Realtime enabled for ${REALTIME_TABLES.join(', ')}`);
  } else if (successCount > 0) {
    realtimeTablesEnabled = true;
    logger.warn(`[Supabase] Realtime partially enabled (${successCount}/${total} tables)`);
  } else {
    logger.warn('[Supabase] Realtime not enabled for any tables — scheduling background recovery');
    scheduleRealtimeRecovery();
  }

  return { successCount, total };
}

let recoveryTimer: NodeJS.Timeout | null = null;
const MAX_RECOVERY_ATTEMPTS = 5;
let recoveryAttempts = 0;

function scheduleRealtimeRecovery(): void {
  if (recoveryTimer) return;
  if (realtimeTablesEnabled) return;

  recoveryAttempts = 0;
  attemptRecovery();
}

async function attemptRecovery(): Promise<void> {
  if (realtimeTablesEnabled) {
    recoveryTimer = null;
    return;
  }

  recoveryAttempts++;
  if (recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
    logger.error(`[Supabase] Realtime recovery failed after ${MAX_RECOVERY_ATTEMPTS} attempts — giving up. Manual restart required.`);
    recoveryTimer = null;
    return;
  }

  const delayMs = Math.min(30000 * Math.pow(2, recoveryAttempts - 1), 300000);
  logger.info(`[Supabase] Recovery attempt ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS} in ${Math.round(delayMs / 1000)}s`);

  recoveryTimer = setTimeout(async () => {
    try {
      resetSupabaseAvailability();
      const available = await isSupabaseAvailable(STARTUP_AVAILABILITY_TIMEOUT);
      if (!available) {
        logger.warn(`[Supabase] Recovery attempt ${recoveryAttempts} — still not reachable`);
        attemptRecovery();
        return;
      }

      const results = await Promise.all(
        REALTIME_TABLES.map(table => enableRealtimeForTable(table, { skipAvailabilityCheck: true }))
      );
      const successCount = results.filter(Boolean).length;

      if (successCount > 0) {
        realtimeTablesEnabled = true;
        logger.info(`[Supabase] Recovery successful — realtime enabled for ${successCount}/${REALTIME_TABLES.length} tables`);
        recoveryTimer = null;
      } else {
        logger.warn(`[Supabase] Recovery attempt ${recoveryAttempts} — tables still not enabled`);
        attemptRecovery();
      }
    } catch (err) {
      logger.error(`[Supabase] Recovery attempt ${recoveryAttempts} error:`, { error: new Error(getErrorMessage(err)) });
      attemptRecovery();
    }
  }, delayMs);
}

export function stopRealtimeRecovery(): void {
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
}

export { SupabaseClient };
