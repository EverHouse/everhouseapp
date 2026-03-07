interface ClosureLike {
  title: string;
  reason: string | null;
  noticeType: string | null;
  affectedAreas: string | null;
}

export function isBlockingClosure(affectedAreas: string | null | undefined): boolean {
  return affectedAreas !== 'none' && affectedAreas !== '' && affectedAreas !== null && affectedAreas !== undefined;
}

export function formatTitleForDisplay(title: string): string {
  if (!title) return 'Notice';
  const trimmed = title.trim();

  if (trimmed.includes('_')) {
    return trimmed
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  if (trimmed.includes('-')) {
    return trimmed
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  if (trimmed === trimmed.toLowerCase() && trimmed.length > 0) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  return trimmed;
}

export function getNoticeTypeLabel(closure: ClosureLike): string {
  const blocking = isBlockingClosure(closure.affectedAreas);
  if (blocking) {
    return 'Closure';
  }
  return closure.noticeType && closure.noticeType.toLowerCase() !== 'closure' ? closure.noticeType : 'Notice';
}

export function getNoticeSecondaryTag(closure: ClosureLike): string | null {
  const blocking = isBlockingClosure(closure.affectedAreas);
  if (blocking && closure.noticeType && closure.noticeType.trim() && closure.noticeType.toLowerCase() !== 'closure') {
    return closure.noticeType;
  }
  const reason = closure.reason && closure.reason.trim() ? closure.reason : null;
  if (reason && reason.toLowerCase() === 'internal calendar event') {
    return null;
  }
  return reason;
}

export function getMemberNoticeTitle(closure: ClosureLike): string {
  if (closure.noticeType && closure.noticeType.trim() && closure.noticeType.toLowerCase() !== 'closure') {
    return formatTitleForDisplay(closure.noticeType);
  }
  if (closure.reason && closure.reason.trim()) {
    return formatTitleForDisplay(closure.reason);
  }
  if (closure.title && closure.title.trim()) {
    return formatTitleForDisplay(closure.title);
  }
  return closure.affectedAreas && closure.affectedAreas !== 'none'
    ? formatAffectedAreas(closure.affectedAreas)
    : 'Notice';
}

export function getNoticeLabel(closure: ClosureLike): string {
  const blocking = isBlockingClosure(closure.affectedAreas);
  if (!blocking) {
    if (closure.noticeType && closure.noticeType.toLowerCase() !== 'closure') {
      return closure.noticeType;
    }
    return 'Notice';
  }
  return closure.noticeType || 'Closure';
}

const formatSingleArea = (area: string): string => {
  const trimmed = area.trim();
  if (trimmed === 'entire_facility') return 'Entire Facility';
  if (trimmed === 'all_bays') return 'All Simulator Bays';
  if (trimmed === 'conference_room' || trimmed === 'Conference Room') return 'Conference Room';
  if (trimmed === 'none') return '';
  if (trimmed.startsWith('bay_')) {
    const bayNum = trimmed.replace('bay_', '');
    return `Simulator Bay ${bayNum}`;
  }
  return trimmed;
};

const parseAreasAsArray = (areas: string): string[] | null => {
  const trimmed = areas.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
};

export function formatAffectedAreas(areas: string): string {
  if (!areas) return 'No booking restrictions';
  const trimmed = areas.trim();
  if (trimmed === 'entire_facility') return 'Entire Facility';
  if (trimmed === 'all_bays') return 'All Simulator Bays';
  if (trimmed === 'none') return 'No booking restrictions';

  const jsonArray = parseAreasAsArray(trimmed);
  if (jsonArray) {
    return jsonArray.map(formatSingleArea).filter(a => a).join(', ');
  }

  return trimmed.split(',').map(a => formatSingleArea(a)).filter(a => a).join(', ');
}

export function getAffectedAreasList(areas: string): string[] {
  if (!areas) return [];
  const trimmed = areas.trim();
  if (trimmed === 'none') return [];
  if (trimmed === 'entire_facility') return ['Entire Facility'];
  if (trimmed === 'all_bays') return ['All Simulator Bays'];

  const jsonArray = parseAreasAsArray(trimmed);
  if (jsonArray) {
    return jsonArray.map(formatSingleArea).filter(a => a);
  }

  return trimmed.split(',').map(a => formatSingleArea(a)).filter(a => a);
}
