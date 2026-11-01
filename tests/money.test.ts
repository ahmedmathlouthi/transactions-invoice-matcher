import { describe, expect, it } from 'vitest';
import { InvalidDataError } from '../src/errors';
import { parseCents } from '../src/money';

describe('parseCents', () => {
  it.each([
    ['466.43', 46643],
    ['-466.43', -46643],
    ['-12.50', -1250], // cents take the sign too: -(12 + 0.50), not -12 + 0.50
    ['-0.50', -50], // under €1: the euro part "-0" carries no sign of its own
    ['12.5', 1250],
    ['1500', 150000],
    ['0.30', 30],
    ['123456.78', 12345678],
  ])('parses %s', (input, expected) => {
    expect(parseCents(input)).toBe(expected);
  });

  it('adds exactly where floats do not (finding 6)', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(parseCents('0.10') + parseCents('0.20')).toBe(parseCents('0.30'));
  });

  it.each([null, undefined, '', 'abc', '1.234', '1e3', '--1'])('rejects %j', (input) => {
    expect(() => parseCents(input)).toThrow(InvalidDataError);
  });
});
