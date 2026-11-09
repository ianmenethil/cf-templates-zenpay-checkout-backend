import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absoluteTime, formatAge } from '@/lib/format-age';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Words for a time distance in the visitor's language, the same way `formatAge` writes them. */
const words = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** An ISO timestamp this far from now; negative is the past. */
const at = (offset: number): string => new Date(NOW + offset).toISOString();

describe('formatAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Each row is how far back, and the value and unit the answer must be written in.
  it.each<[string, number, number, Intl.RelativeTimeFormatUnit]>([
    ['right now', 0, 0, 'second'],
    ['59 seconds', -59 * SECOND, -59, 'second'],
    ['the minute boundary', -MINUTE, -1, 'minute'],
    ['59 minutes', -59 * MINUTE, -59, 'minute'],
    ['the hour boundary', -HOUR, -1, 'hour'],
    ['23 hours', -23 * HOUR, -23, 'hour'],
    ['the day boundary', -DAY, -1, 'day'],
    ['6 days', -6 * DAY, -6, 'day'],
    ['the week boundary', -7 * DAY, -1, 'week'],
    ['4 weeks', -28 * DAY, -4, 'week'],
    ['the month boundary', -31 * DAY, -1, 'month'],
    ['11 months', -330 * DAY, -11, 'month'],
    ['the year boundary', -400 * DAY, -1, 'year'],
    ['three years', -3 * 365 * DAY, -3, 'year'],
  ])('writes %s in the right unit', (_name, offset, value, unit) => {
    expect(formatAge(at(offset))).toBe(words.format(value, unit));
  });

  it('rounds to the nearest whole unit', () => {
    expect(formatAge(at(-89 * MINUTE))).toBe(words.format(-1, 'hour'));
    expect(formatAge(at(-91 * MINUTE))).toBe(words.format(-2, 'hour'));
  });

  it('writes a time in the future', () => {
    expect(formatAge(at(5 * MINUTE))).toBe(words.format(5, 'minute'));
    expect(formatAge(at(2 * HOUR))).toBe(words.format(2, 'hour'));
    expect(formatAge(at(3 * DAY))).toBe(words.format(3, 'day'));
  });

  it('changes as the clock moves', () => {
    const iso = at(-30 * SECOND);
    expect(formatAge(iso)).toBe(words.format(-30, 'second'));
    vi.advanceTimersByTime(150 * SECOND);
    expect(formatAge(iso)).toBe(words.format(-3, 'minute'));
  });

  it('gives back the input when it is not a date, instead of throwing', () => {
    expect(formatAge('garbage')).toBe('garbage');
    expect(formatAge('')).toBe('');
    expect(formatAge('2026-13-45T99:99:99Z')).toBe('2026-13-45T99:99:99Z');
  });
});

describe('absoluteTime', () => {
  it('is a medium date with a short time', () => {
    expect(absoluteTime).toBeInstanceOf(Intl.DateTimeFormat);
    const { dateStyle, timeStyle } = absoluteTime.resolvedOptions();
    expect(dateStyle).toBe('medium');
    expect(timeStyle).toBe('short');
  });

  it('writes the year and a time of day', () => {
    const text = absoluteTime.format(new Date('2026-11-09T12:34:00Z'));
    expect(text).toContain('2026');
    expect(text).toMatch(/\d{1,2}[:.]\d{2}/);
  });
});
