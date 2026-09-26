/**
 * From `BankCore` pages to scratch-table rows.
 *
 * Three jobs, all shared by the seven load tools:
 *   - walk Ramp's `{data, page: {next}}` envelope to the end, with `CLIENT_MAX_PAGES` as the stop;
 *   - drop `persona_id` from every row, because it is the same value on every row of every table
 *     and only costs the model context (`test/fixtures/events.jsonl` records the same shape);
 *   - validate the `YYYY-MM-DD` date range before it reaches the bank, so a malformed date is a
 *     tool error the model can fix rather than an empty table it has to guess about.
 */
import type { ListQuery, Page } from '../contracts/index.js';

/** A row as it is stored in the scratch database. */
export type ScratchRow = Record<string, unknown>;

/** Everything but `persona_id`: it is constant per table and the model already knows who it is. */
export function withoutPersonaId(row: object): ScratchRow {
  const projected: ScratchRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'persona_id') continue;
    projected[key] = value;
  }
  return projected;
}

export type PageFetcher<T> = (query: ListQuery) => Promise<Page<T>>;

export type CollectResult<T> =
  | { readonly ok: true; readonly rows: readonly T[]; readonly pages: number }
  | { readonly ok: false; readonly reason: 'too_many_pages'; readonly pages: number };

/**
 * Reads every page of a list operation. The cursor is opaque (bank-core encodes an offset in
 * base64url), so it is passed back verbatim; a cursor that repeats itself ends the loop rather
 * than spinning, which no correct implementation does but a fake or a future backend might.
 */
export async function collectPages<T>(
  fetchPage: PageFetcher<T>,
  options: { readonly pageSize: number; readonly maxPages: number },
): Promise<CollectResult<T>> {
  const rows: T[] = [];
  let cursor: string | null = null;
  let pages = 0;
  const seen = new Set<string>();

  for (;;) {
    const query: ListQuery =
      cursor === null ? { limit: options.pageSize } : { cursor, limit: options.pageSize };
    const page: Page<T> = await fetchPage(query);
    pages += 1;
    rows.push(...page.data);
    const next = page.page.next;
    if (next === null || next === undefined) return { ok: true, rows, pages };
    if (seen.has(next)) return { ok: true, rows, pages };
    seen.add(next);
    if (pages >= options.maxPages) return { ok: false, reason: 'too_many_pages', pages };
    cursor = next;
  }
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

export type DateRangeResult =
  | { readonly ok: true; readonly from_date: string; readonly to_date: string }
  | { readonly ok: false; readonly message: string };

/** A `YYYY-MM-DD` day, in UTC, or `null` when the value is not one. */
export function normaliseDate(value: string): string | null {
  const match = DATE_PATTERN.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects 2026-02-31 and 2026-13-01, which `Date` would otherwise roll over silently.
  if (parsed.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/**
 * Both ends of a load tool's window. `to_date` stays inclusive: bank-core adds the day in UTC
 * (Ramp's rule, repeated in every `to_date` description), so nothing is shifted here.
 */
export function parseDateRange(fromDate: string, toDate: string): DateRangeResult {
  const from = normaliseDate(fromDate);
  const to = normaliseDate(toDate);
  if (from === null) {
    return { ok: false, message: `from_date "${fromDate}" is not a YYYY-MM-DD date in UTC` };
  }
  if (to === null) {
    return { ok: false, message: `to_date "${toDate}" is not a YYYY-MM-DD date in UTC` };
  }
  if (from > to) {
    return {
      ok: false,
      message: `from_date ${from} is after to_date ${to}: pass the earlier day first`,
    };
  }
  return { ok: true, from_date: from, to_date: to };
}
