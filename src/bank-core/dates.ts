/**
 * UTC date helpers (block: bank-core).
 *
 * CLAUDE.md "Do": construct dates in UTC. Every `YYYY-MM-DD` this block produces or compares is a
 * UTC calendar day, so a server in any region and a model reading a scratch table agree on what
 * "last month" means. Ramp's convention (docs/RAMP_REFERENCE.md section 6.2) is that `to_date` is
 * inclusive; on `YYYY-MM-DD` strings that is plain lexicographic `<=`, which is what
 * `withinDateRange` does.
 */

export const MS_PER_DAY = 86_400_000;

export function pad(value: number, width = 2): string {
  return String(Math.trunc(Math.abs(value))).padStart(width, '0');
}

/** Midnight UTC of the day `date` falls in. */
export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

/** `YYYY-MM-DD` in UTC. */
export function toIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** `YYYY-MM` in UTC, the shape `Card.expires_on` uses. */
export function toIsoMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

/** `YYYY-MM-DD` of the day `daysBefore` days before `reference`. */
export function isoDateBefore(reference: Date, daysBefore: number): string {
  return toIsoDate(addDays(reference, -daysBefore));
}

/** A full ISO-8601 UTC timestamp `daysBefore` days (plus `hour`:`minute`) before `reference`. */
export function isoTimestampBefore(
  reference: Date,
  daysBefore: number,
  hour = 0,
  minute = 0,
): string {
  const day = startOfUtcDay(addDays(reference, -daysBefore));
  return new Date(day.getTime() + hour * 3_600_000 + minute * 60_000).toISOString();
}

/** Midnight UTC on the `dayOfMonth`-th day of the month `monthsBefore` months before `reference`. */
export function utcDayInMonthBefore(
  reference: Date,
  monthsBefore: number,
  dayOfMonth: number,
): Date {
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth() - monthsBefore;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(dayOfMonth, lastDay), 0, 0, 0, 0));
}

/**
 * Ramp's inclusive `from_date` / `to_date` on `YYYY-MM-DD` strings. An absent bound is no bound;
 * an empty string is treated as absent, matching the `""`-means-null convention of the tools.
 */
export function withinDateRange(
  date: string,
  from: string | undefined | null,
  to: string | undefined | null,
): boolean {
  if (from !== undefined && from !== null && from !== '' && date < from) return false;
  if (to !== undefined && to !== null && to !== '' && date > to) return false;
  return true;
}
