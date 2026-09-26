/**
 * Turning a failure into something the model can act on.
 *
 * Every tool error leaves this block through `toolError` (A-08): `isError: true` plus Ramp's
 * exact wording, never a JSON-RPC error code - those stay reserved for malformed JSON-RPC. What
 * this module adds is the *message*: a `ScratchDbError` carries a machine reason and `src/etl`'s
 * own words, and the model needs to be told what to do about each one (reload the tables, drop a
 * table, narrow the query).
 */
import {
  ETL_OPERATION_LIMIT_MESSAGE,
  TOO_MANY_TABLES_MESSAGE,
  isScratchDbError,
  type ScratchDbError,
  type ToolLimits,
} from '../contracts/index.js';

/** Ramp's `CLIENT_MAX_PAGES` message, verbatim (docs/RAMP_REFERENCE.md section 2). */
export const TOO_MANY_PAGES_MESSAGE = 'Too many pages, try to filter more results out.';

/** What the model is told after its scratch database was torn down under it. */
export const RELOAD_AFTER_TEARDOWN =
  'the tables of this session were dropped, so load the data you need again before querying';

/** A message for one scratch-database failure, with the recovery step spelled out. */
export function describeScratchError(error: ScratchDbError, limits: ToolLimits): string {
  switch (error.reason) {
    case 'timeout':
      return (
        `the query ran longer than the ${limits.queryTimeoutMs} ms budget and was stopped; ` +
        `${RELOAD_AFTER_TEARDOWN}, then retry with a narrower query`
      );
    case 'worker_crashed':
      return `the SQL runner stopped unexpectedly; ${RELOAD_AFTER_TEARDOWN}`;
    case 'grant_cap':
      return TOO_MANY_TABLES_MESSAGE;
    case 'ops_limit':
      return ETL_OPERATION_LIMIT_MESSAGE;
    case 'global_cap':
      return `${error.message}; ${RELOAD_AFTER_TEARDOWN}`;
    case 'denylist':
    case 'not_readonly':
    case 'multi_statement':
    case 'unknown_table':
    case 'unknown_column':
    case 'syntax_error':
      return error.message;
    default:
      return error.message;
  }
}

/** The message for anything thrown inside a handler, scratch-database failures included. */
export function describeFailure(error: unknown, limits: ToolLimits): string {
  if (isScratchDbError(error)) return describeScratchError(error, limits);
  if (error instanceof Error) return error.message;
  return String(error);
}
