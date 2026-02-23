export function toIntArrayLiteral(ids: number[]): string {
  return '{' + ids.filter(id => Number.isFinite(id)).map(id => Math.floor(id)).join(',') + '}';
}

export function toTextArrayLiteral(values: string[]): string {
  return '{' + values.map(v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
}
