import { getTierLimits } from './tierService';

/**
 * Booking Authorization Module
 * 
 * Checks if members are authorized to book simulators based on their
 * membership tier and special tags (like "Founding" members).
 */

const AUTHORIZED_TAG_KEYWORDS = ['Founding'];

export async function isAuthorizedForMemberBooking(tier: string | null | undefined, tags: string[] = []): Promise<boolean> {
  if (!tier && tags.length === 0) return false;
  
  // Check database-driven tier permissions
  if (tier) {
    const limits = await getTierLimits(tier);
    if (limits.can_book_simulators) return true;
  }
  
  // Fallback: check special tags (e.g., Founding members)
  const tagsLower = tags.map(t => t.toLowerCase());
  const tagAuthorized = AUTHORIZED_TAG_KEYWORDS.some(keyword =>
    tagsLower.some(tag => tag.includes(keyword.toLowerCase()))
  );
  
  return tagAuthorized;
}
