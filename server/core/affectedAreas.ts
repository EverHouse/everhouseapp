import { logger } from './logger';
import { getErrorMessage } from '../utils/errorUtils';
import { db } from '../db';
import { sql } from 'drizzle-orm';

interface ResourceIdRow {
  id: number;
}

export async function getAllActiveBayIds(): Promise<number[]> {
  const result = await db.execute(sql`SELECT id FROM resources WHERE type = 'simulator'`);
  return (result.rows as unknown as ResourceIdRow[]).map((r) => r.id);
}

export async function getAllResourceIds(): Promise<number[]> {
  const result = await db.execute(sql`SELECT id FROM resources`);
  return (result.rows as unknown as ResourceIdRow[]).map((r) => r.id);
}

export async function getConferenceRoomId(): Promise<number | null> {
  const result = await db.execute(sql`SELECT id FROM resources WHERE LOWER(name) LIKE '%conference%' LIMIT 1`);
  return result.rows.length > 0 ? (result.rows[0] as unknown as ResourceIdRow).id : null;
}

interface ResourceCache {
  allResourceIds?: number[];
  allBayIds?: number[];
  conferenceRoomId?: number | null;
}

async function resolveTokenWithCache(token: string, cache: ResourceCache): Promise<number[]> {
  const t = token.toLowerCase().trim();

  if (t === 'entire_facility') {
    if (cache.allResourceIds === undefined) {
      cache.allResourceIds = await getAllResourceIds();
    }
    return cache.allResourceIds;
  }
  if (t === 'all_bays') {
    if (cache.allBayIds === undefined) {
      cache.allBayIds = await getAllActiveBayIds();
    }
    return cache.allBayIds;
  }
  if (t === 'conference_room' || t === 'conference room') {
    if (cache.conferenceRoomId === undefined) {
      cache.conferenceRoomId = await getConferenceRoomId();
    }
    return cache.conferenceRoomId ? [cache.conferenceRoomId] : [];
  }
  if (t.startsWith('bay_')) {
    const bayId = parseInt(t.replace('bay_', ''), 10);
    if (!isNaN(bayId)) return [bayId];
  }
  const parsed = parseInt(t, 10);
  if (!isNaN(parsed)) return [parsed];
  return [];
}

export async function parseAffectedAreasBatch(
  affectedAreasList: (string | null | undefined)[]
): Promise<number[][]> {
  const cache: ResourceCache = {};
  const results: number[][] = [];

  for (const affectedAreas of affectedAreasList) {
    if (!affectedAreas) {
      results.push([]);
      continue;
    }
    const normalized = affectedAreas.toLowerCase().trim();
    if (normalized === '' || normalized === 'none') {
      results.push([]);
      continue;
    }

    const idSet = new Set<number>();

    if (normalized === 'entire_facility' || normalized === 'all_bays' ||
        normalized === 'conference_room' || normalized === 'conference room') {
      const ids = await resolveTokenWithCache(normalized, cache);
      results.push(ids);
      continue;
    }

    if (normalized.startsWith('bay_') && !normalized.includes(',') && !normalized.includes('[')) {
      const bayId = parseInt(normalized.replace('bay_', ''), 10);
      if (!isNaN(bayId)) {
        results.push([bayId]);
        continue;
      }
    }

    try {
      const parsed = JSON.parse(affectedAreas);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'number') {
            idSet.add(item);
          } else if (typeof item === 'string') {
            const ids = await resolveTokenWithCache(item, cache);
            ids.forEach(id => idSet.add(id));
          }
        }
        if (idSet.size > 0) {
          results.push(Array.from(idSet));
          continue;
        }
      }
    } catch (_err) {
      // fall through to comma/token parsing
    }

    if (affectedAreas.includes(',')) {
      const parts = affectedAreas.split(',').map(s => s.trim());
      for (const part of parts) {
        const ids = await resolveTokenWithCache(part, cache);
        ids.forEach(id => idSet.add(id));
      }
    } else {
      const ids = await resolveTokenWithCache(affectedAreas, cache);
      ids.forEach(id => idSet.add(id));
    }

    results.push(Array.from(idSet));
  }

  return results;
}

export async function parseAffectedAreas(affectedAreas: string | null | undefined): Promise<number[]> {
  if (!affectedAreas) return [];
  const normalized = affectedAreas.toLowerCase().trim();
  
  if (normalized === '' || normalized === 'none') {
    return [];
  }
  
  if (normalized === 'entire_facility') {
    return getAllResourceIds();
  }
  
  if (normalized === 'all_bays') {
    return getAllActiveBayIds();
  }
  
  if (normalized === 'conference_room' || normalized === 'conference room') {
    const confId = await getConferenceRoomId();
    return confId ? [confId] : [];
  }
  
  const idSet = new Set<number>();
  
  const processToken = async (token: string): Promise<void> => {
    const t = token.toLowerCase().trim();
    
    if (t === 'entire_facility') {
      const all = await getAllResourceIds();
      all.forEach(id => idSet.add(id));
    } else if (t === 'all_bays') {
      const bays = await getAllActiveBayIds();
      bays.forEach(id => idSet.add(id));
    } else if (t === 'conference_room' || t === 'conference room') {
      const confId = await getConferenceRoomId();
      if (confId) idSet.add(confId);
    } else if (t.startsWith('bay_')) {
      const bayId = parseInt(t.replace('bay_', ''), 10);
      if (!isNaN(bayId)) idSet.add(bayId);
    } else {
      const parsed = parseInt(t, 10);
      if (!isNaN(parsed)) idSet.add(parsed);
    }
  };
  
  if (normalized.startsWith('bay_') && !normalized.includes(',') && !normalized.includes('[')) {
    const bayId = parseInt(normalized.replace('bay_', ''), 10);
    if (!isNaN(bayId)) return [bayId];
  }
  
  try {
    const parsed = JSON.parse(affectedAreas);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'number') {
          idSet.add(item);
        } else if (typeof item === 'string') {
          await processToken(item);
        }
      }
      if (idSet.size > 0) return Array.from(idSet);
    }
  } catch (err) {
    logger.debug('JSON.parse fallback for affectedAreas — input may be comma-separated or plain text', { error: getErrorMessage(err) });
  }
  
  if (affectedAreas.includes(',')) {
    const parts = affectedAreas.split(',').map(s => s.trim());
    for (const part of parts) {
      await processToken(part);
    }
  } else {
    await processToken(affectedAreas);
  }
  
  return Array.from(idSet);
}
