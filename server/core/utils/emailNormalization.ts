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
