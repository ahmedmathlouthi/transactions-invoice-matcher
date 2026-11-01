import { InvalidDataError } from './errors';

/** A calendar day as 'YYYY-MM-DD'. Deliberately not a JS Date: no time, no timezone. */
export type CalendarDate = string & { readonly __brand: 'CalendarDate' };

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function parseCalendarDate(value: string | null | undefined): CalendarDate {
  const match = ISO_DAY.exec(value ?? '');
  if (!match) {
    throw new InvalidDataError(`Not a YYYY-MM-DD date: ${JSON.stringify(value)}`);
  }
  const [, y, m, d] = match.map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) {
    throw new InvalidDataError(`Not a real calendar day: ${value}`);
  }
  return value as CalendarDate;
}

function toUtcDayNumber(day: CalendarDate): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

/** Whole days from `from` to `to` (positive when `to` is later). Timezone-independent. */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return toUtcDayNumber(to) - toUtcDayNumber(from);
}
