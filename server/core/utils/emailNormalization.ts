const PRIMARY_STAFF_DOMAIN = 'everclub.co';
const LEGACY_STAFF_DOMAIN = 'evenhouse.club';

/**
 * Normalize email address for consistent matching:
 * - Lowercase
 * - Trim whitespace
 * - Collapse internal whitespace
 */
export function normalizeEmail(email: string | undefined | null): string {
  if (!email) return '';
  return email.toLowerCase().trim().replace(/\s+/g, '');
}

export function getAlternateDomainEmail(email: string): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  if (normalized.endsWith(`@${PRIMARY_STAFF_DOMAIN}`)) {
    return normalized.replace(`@${PRIMARY_STAFF_DOMAIN}`, `@${LEGACY_STAFF_DOMAIN}`);
  }
  if (normalized.endsWith(`@${LEGACY_STAFF_DOMAIN}`)) {
    return normalized.replace(`@${LEGACY_STAFF_DOMAIN}`, `@${PRIMARY_STAFF_DOMAIN}`);
  }
  return null;
}

