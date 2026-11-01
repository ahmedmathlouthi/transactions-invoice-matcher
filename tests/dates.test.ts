import { describe, expect, it } from 'vitest';
import { daysBetween, parseCalendarDate } from '../src/dates';
import { InvalidDataError } from '../src/errors';

const d = parseCalendarDate;

describe('daysBetween', () => {
  it('runs under a non-UTC timezone, as production would', () => {
    expect(process.env.TZ).toBe('Europe/Paris');
  });

  it('counts whole calendar days', () => {
    expect(daysBetween(d('2026-01-01'), d('2026-01-31'))).toBe(30);
    expect(daysBetween(d('2026-01-31'), d('2026-01-01'))).toBe(-30);
    expect(daysBetween(d('2026-08-16'), d('2026-08-16'))).toBe(0);
  });

  it('is not shifted by daylight saving changes (finding 7)', () => {
    // Paris switches to summer time on 2026-03-29 and back on 2026-10-25.
    expect(daysBetween(d('2026-03-28'), d('2026-03-30'))).toBe(2);
    expect(daysBetween(d('2026-10-24'), d('2026-10-26'))).toBe(2);
  });

  it('crosses month and leap-year boundaries', () => {
    expect(daysBetween(d('2028-02-28'), d('2028-03-01'))).toBe(2);
    expect(daysBetween(d('2026-12-31'), d('2027-01-01'))).toBe(1);
  });
});

describe('parseCalendarDate', () => {
  it.each([null, '', '2026-8-1', '2026-02-30', '16/08/2026', '2026-08-16T00:00:00Z'])(
    'rejects %j',
    (input) => {
      expect(() => parseCalendarDate(input)).toThrow(InvalidDataError);
    },
  );
});
