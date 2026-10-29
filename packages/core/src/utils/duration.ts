const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

/**
 * Parse a duration into milliseconds: a number of milliseconds or a string such as '30s',
 * '12h', '7d', '2w'
 */
export function parseDuration(value: number | string): number | undefined {
  if (typeof value === 'number') {
    return value >= 0 ? value : undefined;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i.exec(value);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return Math.round(parseFloat(match[1]) * (DURATION_UNITS[match[2].toLowerCase()] ?? 1));
}
