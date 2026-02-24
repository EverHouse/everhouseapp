import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { logger } from './logger';

const settingsCache = new Map<string, { value: string; fetchedAt: number }>();
const CACHE_TTL_MS = 30_000;

export async function getSettingValue(key: string, defaultValue: string): Promise<string> {
  const cached = settingsCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
    const value = row?.value ?? defaultValue;
    settingsCache.set(key, { value, fetchedAt: Date.now() });
    return value;
  } catch (error) {
    logger.error(`[Settings Helper] Failed to read setting ${key}`, { error: error as Error });
    return defaultValue;
  }
}

export async function getSettingBoolean(key: string, defaultValue: boolean): Promise<boolean> {
  const val = await getSettingValue(key, String(defaultValue));
  return val === 'true';
}

export function invalidateSettingsCache(key?: string): void {
  if (key) {
    settingsCache.delete(key);
  } else {
    settingsCache.clear();
  }
}

export async function isEmailCategoryEnabled(category: string): Promise<boolean> {
  const key = `email.${category.toLowerCase()}.enabled`;
  return getSettingBoolean(key, true);
}

export async function isSchedulerEnabled(schedulerName: string): Promise<boolean> {
  const normalizedName = schedulerName.replace(/\s+/g, '_');
  const key = `scheduler.${normalizedName}.enabled`;
  return getSettingBoolean(key, true);
}
