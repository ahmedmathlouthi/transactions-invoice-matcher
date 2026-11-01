import { InvalidDataError } from './errors';

/** An amount in whole cents. Always an integer, never a float in euros. */
export type Cents = number;

const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses the text Postgres returns for `numeric(…, 2)` (e.g. "466.43", "-12.5")
 * into cents using string arithmetic, so no binary rounding can creep in.
 */
export function parseCents(value: string | null | undefined): Cents {
  const match = DECIMAL.exec(value?.trim() ?? '');
  if (!match) {
    throw new InvalidDataError(`Not a 2-decimal amount: ${JSON.stringify(value)}`);
  }
  const [, sign, units, fraction = ''] = match;
  const cents = Number(units) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) {
    throw new InvalidDataError(`Amount out of range: ${value}`);
  }
  return sign === '-' ? -cents : cents;
}
