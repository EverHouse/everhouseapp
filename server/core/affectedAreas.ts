import { pool } from './db';

export async function getAllActiveBayIds(): Promise<number[]> {
  const result = await pool.query("SELECT id FROM resources WHERE type = 'simulator'");
  return result.rows.map((r: Record<string, unknown>) => r.id as number);
}

export async function getAllResourceIds(): Promise<number[]> {
  const result = await pool.query('SELECT id FROM resources');
  return result.rows.map((r: Record<string, unknown>) => r.id as number);
}

export async function getConferenceRoomId(): Promise<number | null> {
  const result = await pool.query("SELECT id FROM resources WHERE LOWER(name) LIKE '%conference%' LIMIT 1");
  return result.rows.length > 0 ? result.rows[0].id : null;
}

export async function parseAffectedAreas(affectedAreas: string): Promise<number[]> {
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
      const bayId = parseInt(t.replace('bay_', ''));
      if (!isNaN(bayId)) idSet.add(bayId);
    } else {
      const parsed = parseInt(t);
      if (!isNaN(parsed)) idSet.add(parsed);
    }
  };
  
  if (normalized.startsWith('bay_') && !normalized.includes(',') && !normalized.includes('[')) {
    const bayId = parseInt(normalized.replace('bay_', ''));
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
  } catch {
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
