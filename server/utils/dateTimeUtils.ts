export function ensureDateString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }
  if (typeof value === 'string') {
    return value.split('T')[0];
  }
  return String(value ?? '');
}

export function ensureTimeString(value: unknown, length: 5 | 8 = 5): string {
  if (value instanceof Date) {
    return value.toISOString().substring(11, 11 + length);
  }
  if (typeof value === 'string') {
    return value.substring(0, length);
  }
  return String(value ?? '');
}
