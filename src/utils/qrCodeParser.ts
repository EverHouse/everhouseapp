export interface QrParseResult {
  type: 'member' | 'booking' | 'unknown';
  memberId?: string;
  bookingId?: number;
}

function sanitizeMemberId(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return trimmed;
  return undefined;
}

export function parseQrCode(rawText: string): QrParseResult {
  const decodedText = rawText.trim();
  if (!decodedText) return { type: 'unknown' };

  const memberMatch = decodedText.match(/^MEMBER:(.+)$/);
  if (memberMatch) {
    const memberId = sanitizeMemberId(memberMatch[1]);
    return memberId ? { type: 'member', memberId } : { type: 'unknown' };
  }

  const bookingMatch = decodedText.match(/^BOOKING:(\d+)$/);
  if (bookingMatch) {
    return { type: 'booking', bookingId: Number(bookingMatch[1]) };
  }

  try {
    const url = new URL(decodedText);
    const rawMemberId = url.searchParams.get('memberId');
    if (rawMemberId) {
      const memberId = sanitizeMemberId(rawMemberId);
      return memberId ? { type: 'member', memberId } : { type: 'unknown' };
    }
    const bookingId = url.searchParams.get('bookingId');
    if (bookingId && /^\d+$/.test(bookingId)) {
      return { type: 'booking', bookingId: Number(bookingId) };
    }
  } catch {
    // Not a URL
  }

  try {
    const scanData = JSON.parse(decodedText);
    if (scanData.memberId) {
      const memberId = sanitizeMemberId(String(scanData.memberId));
      if (memberId) return { type: 'member', memberId };
    }
    if (scanData.bookingId != null) {
      const id = Number(scanData.bookingId);
      if (Number.isFinite(id) && id > 0) {
        return { type: 'booking', bookingId: id };
      }
    }
  } catch {
    // Not JSON
  }

  return { type: 'unknown' };
}
