/**
 * Filtering, ordering and Ramp's `{data, page: {next}}` envelope (block: bank-core).
 *
 * Ramp's conventions are reproduced deliberately (docs/RAMP_REFERENCE.md sections 6.2 and 6.3):
 * an empty string on an enum filter means "no filter" because Claude likes to pass `""` for null;
 * `from_date` / `to_date` are inclusive `YYYY-MM-DD`; and `load_transactions` always sorts by
 * amount descending (`order_by_amount_desc`). Our amounts are *signed* - negative is money out -
 * so the sort is by magnitude, which is what "the biggest transactions first" means to a user
 * whose statement mixes debits and credits.
 *
 * The cursor is opaque on purpose: it is a base64url-encoded offset, so a model cannot reason
 * about it and start hand-crafting page boundaries. A cursor that does not decode is treated as
 * the first page rather than an error, and a bare decimal offset is still accepted so a caller
 * written against `src/testing/fakes.ts` keeps working.
 */
import type { EnumFilter, ListQuery, Page, StatementLine } from '../contracts/index.js';

import { withinDateRange } from './dates.js';

export interface PaginationLimits {
  readonly defaultPageSize: number;
  readonly maxPageSize: number;
}

/** `""` and `undefined` both mean "no filter" (Ramp convention). */
export function matchesEnum<T extends string>(value: T, filter: EnumFilter<T> | undefined): boolean {
  return filter === undefined || filter === '' || filter === value;
}

/** Case-insensitive substring match; `undefined` and `""` mean "no filter". */
export function matchesName(value: string, needle: string | undefined | null): boolean {
  if (needle === undefined || needle === null || needle === '') return true;
  return value.toLowerCase().includes(needle.toLowerCase());
}

/** Re-exported so every list operation applies the same inclusive date rule. */
export { withinDateRange };

export function encodeCursor(offset: number): string {
  return Buffer.from(String(Math.max(0, Math.floor(offset))), 'utf8').toString('base64url');
}

/** Never throws: an unreadable cursor restarts at the first page. */
export function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === '') return 0;
  const direct = Number.parseInt(cursor, 10);
  if (Number.isFinite(direct) && String(direct) === cursor.trim() && direct >= 0) return direct;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = Number.parseInt(decoded, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Ramp's envelope over an already-filtered, already-sorted array. */
export function paginate<T>(
  rows: readonly T[],
  query: ListQuery | undefined,
  limits: PaginationLimits,
): Page<T> {
  const requested = query?.limit;
  const limit =
    requested === undefined || !Number.isFinite(requested) || requested <= 0
      ? limits.defaultPageSize
      : Math.min(Math.floor(requested), limits.maxPageSize);
  const offset = decodeCursor(query?.cursor);
  const data = rows.slice(offset, offset + limit);
  const consumed = offset + data.length;
  return {
    data,
    page: { next: consumed < rows.length ? encodeCursor(consumed) : null },
  };
}

/**
 * Ramp's `order_by_amount_desc`, made a total order so paging is stable: magnitude descending,
 * then the newest date, then the id. Without the tie-breaks two rows of the same amount could
 * swap between page one and page two and a row would be seen twice or not at all.
 */
export function byAmountDescending<T extends { amount_cents: number; date: string; id: string }>(
  left: T,
  right: T,
): number {
  const byAmount = Math.abs(right.amount_cents) - Math.abs(left.amount_cents);
  if (byAmount !== 0) return byAmount;
  if (left.date !== right.date) return left.date < right.date ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Newest first, id as the tie-break, for the flat statement view. */
export function byDateDescending(left: StatementLine, right: StatementLine): number {
  if (left.date !== right.date) return left.date < right.date ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
