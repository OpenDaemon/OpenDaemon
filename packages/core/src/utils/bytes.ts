const SIZE_UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/**
 * Parse a byte size: a number of bytes or a string such as '512M', '1.5G', '100KB'
 */
export function parseBytes(value: number | string): number | undefined {
  if (typeof value === 'number') {
    return value >= 0 ? value : undefined;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([BKMG])?B?\s*$/i.exec(value);
  if (!match?.[1]) {
    return undefined;
  }
  const unit = SIZE_UNITS[(match[2] ?? 'B').toUpperCase()] ?? 1;
  return Math.round(parseFloat(match[1]) * unit);
}
