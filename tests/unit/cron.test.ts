import { describe, it, expect } from 'vitest';
import { parseCron, nextRun, assertTimeZone } from '../../packages/core/src/index.js';

const next = (expr: string, from: string, tz = 'UTC') => nextRun(parseCron(expr), new Date(from), tz)?.toISOString();

describe('parseCron', () => {
  it('should parse lists, ranges, steps and names', () => {
    const s = parseCron('*/15 9-17/4 1,15 jan-mar mon-fri');
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toEqual([9, 13, 17]);
    expect([...s.days]).toEqual([1, 15]);
    expect([...s.months]).toEqual([1, 2, 3]);
    expect([...s.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect(s.dayOr).toBe(true);
    expect(s.hasSeconds).toBe(false);
  });

  it('should accept a seconds field, start/step, Sunday as 7 and macros', () => {
    expect([...parseCron('5/20 * * * * *').seconds]).toEqual([5, 25, 45]);
    expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0]);
    expect(parseCron('@daily').minutes).toEqual(new Set([0]));
    expect(parseCron('@HOURLY').hours.size).toBe(24);
  });

  it.each([
    ['* * * *', /must have 5 or 6 fields/],
    ['60 * * * *', /minute "60" is out of range 0-59/],
    ['* * 0 * *', /day-of-month "0" is out of range/],
    ['* * * foo *', /Invalid month "foo"/],
    ['*/0 * * * *', /Invalid step/],
    ['5-1 * * * *', /out of range/],
  ])('should reject %j', (expr, message) => {
    expect(() => parseCron(expr)).toThrow(message);
  });
});

describe('nextRun', () => {
  it('should find the next matching minute strictly after the given time', () => {
    expect(next('0 2 * * *', '2026-03-10T01:59:30Z')).toBe('2026-03-10T02:00:00.000Z');
    expect(next('0 2 * * *', '2026-03-10T02:00:00Z')).toBe('2026-03-11T02:00:00.000Z');
    expect(next('*/15 * * * *', '2026-03-10T10:07:00Z')).toBe('2026-03-10T10:15:00.000Z');
  });

  it('should honour seconds, weekdays, month ends and leap days', () => {
    expect(next('*/10 * * * * *', '2026-03-10T10:00:01Z')).toBe('2026-03-10T10:00:10.000Z');
    // 2026-03-10 is a Tuesday
    expect(next('30 8 * * mon', '2026-03-10T00:00:00Z')).toBe('2026-03-16T08:30:00.000Z');
    expect(next('0 0 31 * *', '2026-04-01T00:00:00Z')).toBe('2026-05-31T00:00:00.000Z');
    expect(next('0 0 29 2 *', '2026-01-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('should OR day-of-month and day-of-week when both are restricted', () => {
    // the 15th (Sunday) or any Friday: Friday 2026-03-13 comes first
    expect(next('0 12 15 * fri', '2026-03-10T00:00:00Z')).toBe('2026-03-13T12:00:00.000Z');
  });

  it('should evaluate in the given time zone, including DST changes', () => {
    // 02:00 in Istanbul (UTC+3, no DST) is 23:00 UTC the day before
    expect(next('0 2 * * *', '2026-06-01T00:00:00Z', 'Europe/Istanbul')).toBe('2026-06-01T23:00:00.000Z');
    // New York: 09:00 is 14:00 UTC in winter (EST) and 13:00 UTC after the 8 March 2026 switch (EDT)
    expect(next('0 9 * * *', '2026-03-06T15:00:00Z', 'America/New_York')).toBe('2026-03-07T14:00:00.000Z');
    expect(next('0 9 * * *', '2026-03-08T15:00:00Z', 'America/New_York')).toBe('2026-03-09T13:00:00.000Z');
  });

  it('should return undefined for a date that never exists', () => {
    expect(next('0 0 30 2 *', '2026-01-01T00:00:00Z')).toBeUndefined();
  });
});

describe('assertTimeZone', () => {
  it('should accept IANA zones and reject unknown ones', () => {
    expect(() => { assertTimeZone('Europe/Istanbul'); }).not.toThrow();
    expect(() => { assertTimeZone('Mars/Olympus'); }).toThrow(RangeError);
  });
});
