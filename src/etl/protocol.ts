/**
 * The parent <-> SQL-runner message protocol (block: etl, ADR-9 as amended).
 *
 * Types only: this module compiles away, so importing it from the runner costs nothing at
 * startup. Messages travel over the `child_process.fork` IPC channel with
 * `serialization: 'advanced'` (structured clone), so rows keep their JavaScript types.
 */
import type { ScratchDbFailureReason } from '../contracts/index.js';
import type { SqliteColumnType } from './rows.js';

/** Every request carries a correlation id the runner echoes back. */
interface RunnerRequestBase {
  readonly id: number;
  /** The key of the `:memory:` database inside the runner: one per grant. */
  readonly db: string;
}

/** Opens (or re-opens) a grant's `:memory:` database. Idempotent. */
export interface RunnerOpenRequest extends RunnerRequestBase {
  readonly op: 'open';
}

/** Ramp's `store_data`: keep the raw JSON array, flatten it and report the columns. */
export interface RunnerStoreRequest extends RunnerRequestBase {
  readonly op: 'store';
  readonly table: string;
  readonly rows: readonly Record<string, unknown>[];
}

/** Ramp's `process_data`: project the stored rows onto a real SQL table. */
export interface RunnerProcessRequest extends RunnerRequestBase {
  readonly op: 'process';
  readonly table: string;
  readonly cols: readonly string[];
}

/** Ramp's `execute_query`, already scanned by `guard.ts` in the parent. */
export interface RunnerQueryRequest extends RunnerRequestBase {
  readonly op: 'query';
  readonly sql: string;
  /** The row cap; the runner fetches one extra row so it can report `capped`. */
  readonly maxRows: number;
  /** Hard ceiling on the accumulated result size, so a blob bomb cannot exhaust the runner. */
  readonly maxResultBytes: number;
  /**
   * The runner's OWN deadline, set a little under the parent's hard budget.
   *
   * It is checked between rows in the `iterate()` loop, so a merely slow statement - one that
   * does yield rows - is answered with a clean `timeout` and costs nobody anything. The parent's
   * `SIGKILL` stays the backstop for a statement that never returns to JavaScript at all
   * (`SELECT count(*)` over an unbounded `WITH RECURSIVE`), which is the only case that still
   * takes the runner, and its co-tenant grants, down with it (ADR-9 amended).
   */
  readonly softTimeoutMs: number;
}

/** Ramp's `clear_table`. */
export interface RunnerDropRequest extends RunnerRequestBase {
  readonly op: 'drop';
  readonly table: string;
}

/** Closes one grant's database and frees its rows (global-cap eviction, TTL, shutdown). */
export interface RunnerCloseRequest extends RunnerRequestBase {
  readonly op: 'close';
}

export type RunnerRequest =
  | RunnerOpenRequest
  | RunnerStoreRequest
  | RunnerProcessRequest
  | RunnerQueryRequest
  | RunnerDropRequest
  | RunnerCloseRequest;

export interface RunnerStoreResult {
  readonly rows: number;
  readonly columns_advertised: string[];
}

export interface RunnerProcessResult {
  readonly rows: number;
  readonly columns_selected: string[];
  readonly column_types: Record<string, SqliteColumnType>;
}

export interface RunnerQueryResult {
  readonly rows: Record<string, unknown>[];
  readonly columns: string[];
  readonly rows_returned: number;
  readonly capped: boolean;
}

export type RunnerResult =
  | RunnerStoreResult
  | RunnerProcessResult
  | RunnerQueryResult
  | Record<string, never>;

export interface RunnerOkResponse {
  readonly id: number;
  readonly ok: true;
  readonly result: RunnerResult;
}

export interface RunnerErrorResponse {
  readonly id: number;
  readonly ok: false;
  readonly reason: ScratchDbFailureReason;
  readonly message: string;
}

/** The runner says hello once its native module is loaded, so the parent can await readiness. */
export interface RunnerReadyResponse {
  readonly id: 0;
  readonly ok: true;
  readonly ready: true;
  readonly sqlite_version: string;
}

export type RunnerResponse = RunnerOkResponse | RunnerErrorResponse | RunnerReadyResponse;

export function isReadyResponse(value: RunnerResponse): value is RunnerReadyResponse {
  return value.ok === true && 'ready' in value;
}

/** `Omit` that distributes over a union, so every member keeps its own discriminant. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What the manager hands the pool: the pool assigns the correlation id. */
export type RunnerRequestBody = DistributiveOmit<RunnerRequest, 'id'>;
