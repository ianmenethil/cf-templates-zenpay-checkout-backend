import { describe, expect, it } from 'vitest';
import { countOf, formatAmount, formatSize } from '@/lib/format';

/** The number part of `formatSize` the way the visitor's language writes it, so the tests hold in any language. */
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** Splits "1.4kB" into the number as written and the unit text after it. */
const split = (text: string, value: number): { shown: string; unit: string } => {
  const shown = number.format(value);
  expect(text.startsWith(shown), `${text} should start with ${shown}`).toBe(true);
  return { shown, unit: text.slice(shown.length).trim() };
};

describe('formatSize', () => {
  it('stays in bytes below 1024', () => {
    expect(split(formatSize(0), 0).unit).not.toBe('');
    const bytes = split(formatSize(1023), 1023);
    expect(bytes.unit).not.toBe('');
  });

  it('switches to kilobytes at exactly 1024 bytes', () => {
    const bytes = split(formatSize(1023), 1023).unit;
    const kilobytes = split(formatSize(1024), 1).unit;
    expect(kilobytes).not.toBe(bytes);
  });

  it('shows one decimal in kilobytes', () => {
    split(formatSize(1536), 1.5);
    split(formatSize(1434), 1.4);
  });

  it('stays in kilobytes just below a megabyte', () => {
    const kilobytes = split(formatSize(1024), 1).unit;
    expect(split(formatSize(1024 ** 2 - 1), 1024).unit).toBe(kilobytes);
  });

  it('switches to megabytes at exactly 1024 kilobytes and keeps counting in megabytes above', () => {
    const kilobytes = split(formatSize(1024), 1).unit;
    const megabytes = split(formatSize(1024 ** 2), 1).unit;
    expect(megabytes).not.toBe(kilobytes);
    expect(split(formatSize(5 * 1024 ** 3), 5120).unit).toBe(megabytes);
  });

  it('writes the English units narrowly when the language is English', () => {
    if (!Intl.NumberFormat().resolvedOptions().locale.startsWith('en')) {
      return;
    }
    expect(formatSize(512)).toBe('512B');
    expect(formatSize(1434)).toBe('1.4kB');
    expect(formatSize(2.5 * 1024 ** 2)).toBe('2.5MB');
  });
});

describe('countOf', () => {
  it('uses the singular for exactly one', () => {
    expect(countOf(1, 'callback')).toBe('1 callback');
  });

  it('adds an s to the singular for any other count, zero included', () => {
    expect(countOf(0, 'callback')).toBe('0 callbacks');
    expect(countOf(3, 'callback')).toBe('3 callbacks');
  });

  it('uses the given plural', () => {
    expect(countOf(1, 'delivery', 'deliveries')).toBe('1 delivery');
    expect(countOf(2, 'delivery', 'deliveries')).toBe('2 deliveries');
  });
});

describe('formatAmount', () => {
  it('writes dollars and cents in Australian dollars whatever the browser language', () => {
    expect(formatAmount(49.9)).toBe('$49.90');
    expect(formatAmount(0)).toBe('$0.00');
    expect(formatAmount(1234.5)).toBe('$1,234.50');
  });

  it('rounds to cents', () => {
    expect(formatAmount(0.005)).toBe('$0.01');
    expect(formatAmount(10.004)).toBe('$10.00');
  });

  it('puts the minus sign of a negative amount in front', () => {
    expect(formatAmount(-5)).toBe('-$5.00');
  });
});
