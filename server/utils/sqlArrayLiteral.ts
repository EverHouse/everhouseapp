export function toIntArrayLiteral(ids: number[]): string {
  return '{' + ids.filter(id => Number.isFinite(id)).map(id => Math.floor(id)).join(',') + '}';
}

export function toTextArrayLiteral(values: string[]): string {
  return '{' + values.map(v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
}

export function toNumericArrayLiteral(values: number[]): string {
  return '{' + values.filter(v => Number.isFinite(v)).map(v => String(v)).join(',') + '}';
}

export function toBoolArrayLiteral(values: boolean[]): string {
  return '{' + values.map(v => v ? 't' : 'f').join(',') + '}';
}
