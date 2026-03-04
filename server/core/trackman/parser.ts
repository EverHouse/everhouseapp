import { getTodayPacific } from '../../utils/dateUtils';
import type { ParsedPlayer } from './constants';

export function parseNotesForPlayers(notes: string): ParsedPlayer[] {
  const players: ParsedPlayer[] = [];
  if (!notes) return players;
  
  const lines = notes.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    
    const pipeSeparatedMatch = trimmed.match(/^([MG])\|([^|]*)\|([^|]*)\|(.*)$/i);
    if (pipeSeparatedMatch) {
      const type = pipeSeparatedMatch[1].toUpperCase() === 'M' ? 'member' : 'guest';
      const email = pipeSeparatedMatch[2].trim().toLowerCase();
      const firstName = pipeSeparatedMatch[3].trim();
      const lastName = pipeSeparatedMatch[4].trim();
      const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;
      
      players.push({
        type,
        email: email && email !== 'none' ? email : null,
        name: fullName
      });
      continue;
    }
    
    const memberMatch = trimmed.match(/^M:\s*([^\s|]+)(?:\s*\|\s*(.+))?$/i);
    if (memberMatch) {
      let memberName = memberMatch[2]?.trim() || null;
      
      if (memberName) {
        const guestTagIndex = memberName.search(/\bG:\s*/i);
        if (guestTagIndex !== -1) {
          const beforeGuests = memberName.substring(0, guestTagIndex).trim();
          const guestPortion = memberName.substring(guestTagIndex);
          
          memberName = beforeGuests.replace(/\s+(Guests?\s+pay\s+separately|NO\s+additional|Used\s+\$).*$/i, '').trim() || null;
          
          const inlineGuestMatches = guestPortion.matchAll(/G:\s*([A-Za-z][A-Za-z'-]*(?:\s+(?!G:|M:|NO\b|Used\b|additional\b)[A-Za-z][A-Za-z'-]*)?)/gi);
          for (const gm of inlineGuestMatches) {
            const guestName = gm[1].trim();
            if (guestName && guestName.length >= 2) {
              players.push({
                type: 'guest',
                email: null,
                name: guestName
              });
            }
          }
        } else {
          memberName = memberName.replace(/\s+(Guests?\s+pay\s+separately|NO\s+additional|Used\s+\$).*$/i, '').trim() || null;
        }
      }
      
      players.push({
        type: 'member',
        email: memberMatch[1].trim().toLowerCase(),
        name: memberName
      });
      continue;
    }
    
    const guestMatch = trimmed.match(/^G:\s*(?:([^\s|]+)\s*\|\s*)?(.+)$/i);
    if (guestMatch) {
      const emailOrName = guestMatch[1]?.trim().toLowerCase();
      const name = guestMatch[2]?.trim();
      
      if (emailOrName === 'none' || !emailOrName) {
        players.push({
          type: 'guest',
          email: null,
          name: name || null
        });
      } else if (emailOrName.includes('@')) {
        players.push({
          type: 'guest',
          email: emailOrName,
          name: name || null
        });
      } else {
        players.push({
          type: 'guest',
          email: null,
          name: emailOrName + (name ? ' ' + name : '')
        });
      }
      continue;
    }
    
    const inlineGuestMatches = trimmed.matchAll(/G:\s*([A-Za-z][A-Za-z'-]*(?:\s+(?!G:|M:|NO\b|Used\b|additional\b)[A-Za-z][A-Za-z'-]*)?)/gi);
    for (const gm of inlineGuestMatches) {
      const guestName = gm[1].trim();
      if (guestName && guestName.length >= 2) {
        players.push({
          type: 'guest',
          email: null,
          name: guestName
        });
      }
    }
  }
  
  return players;
}

export function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

export function parseCSVWithMultilineSupport(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if ((char === '\n' || (char === '\r' && nextChar === '\n')) && !inQuotes) {
      if (char === '\r') i++;
      currentRow.push(currentField.trim());
      if (currentRow.length > 0 && currentRow.some(f => f)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else if (char === '\r' && !inQuotes) {
      currentRow.push(currentField.trim());
      if (currentRow.length > 0 && currentRow.some(f => f)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += char;
    }
  }
  
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.length > 0 && currentRow.some(f => f)) {
      rows.push(currentRow);
    }
  }
  
  return rows;
}

export function extractTime(dateTimeStr: string): string {
  if (!dateTimeStr) return '00:00';
  const parts = dateTimeStr.split(' ');
  if (parts.length >= 2) {
    return parts[1] + ':00';
  }
  return '00:00:00';
}

export function extractDate(dateTimeStr: string): string {
  if (!dateTimeStr) return getTodayPacific();
  const parts = dateTimeStr.split(' ');
  return parts[0];
}
