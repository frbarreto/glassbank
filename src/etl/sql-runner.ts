/**
 * The out-of-process SQL runner (block: etl, ADR-9 as amended by measurement).
 *
 * This file is the entry point of a `child_process.fork` child. It owns every scratch
 * `:memory:` database of the grants assigned to it, and it is the ONLY place in the system that
 * ever executes model-authored SQL. The parent never runs it, and can stop it at any instant by
 * sending `SIGKILL` - measured at 1-2 ms even in the middle of an unbounded `WITH RECURSIVE`,
 * which is the reason this is a process and not a `worker_threads` worker
 * (`worker.terminate()` was measured NOT to free a thread blocked inside better-sqlite3, and it
 * additionally wedged process exit: docs/ASSUMPTIONS.md A-39 amended, ADR-9 amended,
 * `node scripts/smoke-worker-sqlite.mjs`).
 *
 * Guards enforced here, behind the parent-side scan in `sql-text.ts`:
 *   - `PRAGMA query_only = 1` is the resting state of every database. It is lifted only around
 *     this block's own trusted DDL and parameterised INSERTs, never around model SQL.
 *   - `Statement.readonly` is checked before a model statement is stepped.
 *   - every identifier is quoted (`quoteIdentifier`), and table names must be in the registry.
 *   - rows are consumed with `Statement.iterate()` so the row cap and the byte cap can stop a
 *     runaway result set without waiting for SQLite to finish.
 *
 * If the parent goes away the IPC channel closes and this process exits, so a crashed server can
 * never leave orphaned runners behind.
 */
import process from 'node:process';

import Database from 'better-sqlite3';

import type {
  RunnerErrorResponse,
  RunnerOkResponse,
  RunnerProcessResult,
  RunnerQueryResult,
  RunnerReadyResponse,
  RunnerRequest,
  RunnerStoreResult,
} from './protocol.js';
import {
  advertisedColumns,
  flattenRows,
  inferColumnTypes,
  toSqliteValue,
  type SqliteValue,
} from './rows.js';
import { isValidTableName, quoteIdentifier, scanStatement } from './sql-text.js';

/** Mirrors `ScratchDbFailureReason` without importing zod into the child. */
type FailureReason =
  | 'timeout'
  | 'not_readonly'
  | 'denylist'
  | 'multi_statement'
  | 'unknown_table'
  | 'unknown_column'
  | 'grant_cap'
  | 'ops_limit'
  | 'global_cap'
  | 'worker_crashed'
  | 'syntax_error';

class RunnerError extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason, message: string) {
    super(message);
    this.name = 'RunnerError';
    this.reason = reason;
  }
}

interface StoredTable {
  /** The already-flattened rows, kept so `process_data` can be re-run with other columns. */
  readonly rows: Record<string, unknown>[];
  readonly columnsAdvertised: string[];
  processed: boolean;
}

interface ScratchDatabase {
  readonly db: Database.Database;
  readonly tables: Map<string, StoredTable>;
}

const databases = new Map<string, ScratchDatabase>();

function openDatabase(key: string): ScratchDatabase {
  const existing = databases.get(key);
  if (existing) return existing;
  const db = new Database(':memory:');
  // The resting state of every scratch database (CLAUDE.md invariant 8).
  db.pragma('query_only = 1');
  const created: ScratchDatabase = { db, tables: new Map() };
  databases.set(key, created);
  return created;
}

function requireDatabase(key: string): ScratchDatabase {
  const found = databases.get(key);
  if (!found) throw new RunnerError('unknown_table', `no scratch database open for ${key}`);
  return found;
}

/**
 * Runs this block's own trusted statements with `query_only` lifted, and restores it whatever
 * happens. Model-authored SQL is never passed to this function.
 */
function withWriteAccess<T>(scratch: ScratchDatabase, run: () => T): T {
  scratch.db.pragma('query_only = 0');
  try {
    return run();
  } finally {
    scratch.db.pragma('query_only = 1');
  }
}

function handleStore(request: Extract<RunnerRequest, { op: 'store' }>): RunnerStoreResult {
  const scratch = openDatabase(request.db);
  if (!isValidTableName(request.table)) {
    throw new RunnerError('unknown_table', `"${request.table}" is not a valid table name`);
  }
  const rows = flattenRows(request.rows);
  scratch.tables.set(request.table, {
    rows,
    columnsAdvertised: advertisedColumns(rows),
    processed: false,
  });
  return {
    rows: rows.length,
    columns_advertised: scratch.tables.get(request.table)?.columnsAdvertised ?? [],
  };
}

function handleProcess(request: Extract<RunnerRequest, { op: 'process' }>): RunnerProcessResult {
  const scratch = requireDatabase(request.db);
  const table = scratch.tables.get(request.table);
  // Ramp OSS defect 10: `process_data` on an unknown table answered "already processed".
  if (!table) {
    throw new RunnerError(
      'unknown_table',
      `no table named ${request.table} in this scratch database`,
    );
  }
  if (request.cols.length === 0) {
    throw new RunnerError(
      'unknown_column',
      'at least one column must be selected; pass the columns the load tool advertised',
    );
  }
  const unknown = request.cols.filter((col) => !table.columnsAdvertised.includes(col));
  if (unknown.length > 0) {
    throw new RunnerError(
      'unknown_column',
      `these columns are not in ${request.table}: ${unknown.join(', ')}. ` +
        `Available columns are: ${table.columnsAdvertised.join(', ')}`,
    );
  }

  const cols = [...request.cols];
  const columnTypes = inferColumnTypes(table.rows, cols);
  const quotedTable = quoteIdentifier(request.table);
  const columnDefinitions = cols
    .map((col) => `${quoteIdentifier(col)} ${columnTypes[col] ?? 'TEXT'}`)
    .join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const quotedColumns = cols.map((col) => quoteIdentifier(col)).join(', ');

  withWriteAccess(scratch, () => {
    // Re-processing a table with a different column set replaces it; Ramp answered
    // "already processed" and silently ignored the new columns (defect 10).
    scratch.db.exec(`DROP TABLE IF EXISTS ${quotedTable}`);
    scratch.db.exec(`CREATE TABLE ${quotedTable} (${columnDefinitions})`);
    const insert = scratch.db.prepare(
      `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders})`,
    );
    const insertAll = scratch.db.transaction((rows: readonly Record<string, unknown>[]) => {
      for (const row of rows) {
        const values: SqliteValue[] = cols.map((col) => toSqliteValue(row[col]));
        insert.run(values);
      }
    });
    insertAll(table.rows);
  });

  table.processed = true;
  return { rows: table.rows.length, columns_selected: cols, column_types: columnTypes };
}

/**
 * Ceiling on ONE cell, before it is ever copied out of SQLite's own memory.
 *
 * `SELECT hex(randomblob(150000000))` is a single row inside every row cap and finishes well
 * inside `QUERY_TIMEOUT_MS`, so nothing but this stops a 286 MiB string being materialised here
 * and then structured-cloned into the parent - measured at ~1.5 GB of combined RSS on a 1 GiB
 * instance. The cap is generous next to the 100-row result the model actually reads.
 */
const MAX_CELL_BYTES = 64_000;

const CELL_TRUNCATION_SUFFIX = '…[cell truncated]';

/** Rough serialized size of one cell, used only to stop a result set that is growing wildly. */
function approximateSize(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return value.length + 2;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return 8;
  }
  if (value instanceof Uint8Array) return value.byteLength;
  return 32;
}

/** Trims one converted cell to `MAX_CELL_BYTES`, so nothing larger crosses the IPC channel. */
function truncateCell(value: unknown): { readonly value: unknown; readonly truncated: boolean } {
  if (typeof value === 'string' && value.length > MAX_CELL_BYTES) {
    return { value: `${value.slice(0, MAX_CELL_BYTES)}${CELL_TRUNCATION_SUFFIX}`, truncated: true };
  }
  return { value, truncated: false };
}

/** Converts a value better-sqlite3 produced into something structured clone and JSON both like. */
function fromSqliteValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    // Convert only as much of a blob as may survive the cell cap: base64 is 4 bytes per 3.
    const slice =
      value.byteLength > MAX_CELL_BYTES ? value.subarray(0, MAX_CELL_BYTES) : value;
    return Buffer.from(slice).toString('base64');
  }
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return value;
}

function handleQuery(request: Extract<RunnerRequest, { op: 'query' }>): RunnerQueryResult {
  const scratch = requireDatabase(request.db);

  // The same token scan the parent already ran, repeated here because `prepare()` is NOT inert:
  // measured on better-sqlite3 13.0.3 / sqlite 3.53.4, `db.prepare('PRAGMA query_only = 0')`
  // APPLIES the pragma at prepare time, before any `Statement.readonly` check can refuse it.
  // Preparing a denylisted statement is therefore already an escape, so nothing denylisted may
  // reach `prepare()` on either side of the IPC channel.
  const verdict = scanStatement(request.sql);
  if (!verdict.ok) throw new RunnerError(verdict.reason, verdict.message);

  let statement: Database.Statement;
  try {
    statement = scratch.db.prepare(verdict.normalised);
  } catch (error) {
    throw new RunnerError('syntax_error', error instanceof Error ? error.message : String(error));
  }

  // Second line of defence behind the token scan: ATTACH and DETACH are `readonly === true`,
  // which is exactly why the deny-list, not this check, is the primary ATTACH guard.
  if (!statement.readonly) {
    throw new RunnerError(
      'not_readonly',
      'only read-only statements may run against a scratch database',
    );
  }
  if (!statement.reader) {
    throw new RunnerError('not_readonly', 'the statement returns no rows');
  }

  let columns: string[];
  try {
    columns = statement.columns().map((column) => column.name);
  } catch {
    // A statement with no result-set metadata; the column names are recovered from the first row.
    columns = [];
  }

  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  let capped = false;
  // The runner's own deadline, set a little under the parent's hard budget. A statement that
  // yields rows slowly is stopped HERE, with a clean error and no kill, so an honestly slow query
  // no longer costs every other grant sharing this runner its tables. The loop runs at most
  // `maxRows + 1` times, so checking the clock on every row is free next to fetching one.
  const deadline =
    request.softTimeoutMs > 0 ? Date.now() + request.softTimeoutMs : Number.POSITIVE_INFINITY;
  // `iterate()` keeps control coming back to JavaScript between rows, so the caps below can stop
  // a runaway result without waiting for SQLite. The hard bound remains the parent's SIGKILL:
  // a statement that never yields a row (`SELECT count(*)` over an unbounded `WITH RECURSIVE`)
  // never reaches this loop at all.
  const iterator = statement.iterate();
  try {
    for (const row of iterator as IterableIterator<Record<string, unknown>>) {
      if (Date.now() > deadline) {
        throw new RunnerError(
          'timeout',
          `the query was stopped after ${request.softTimeoutMs} ms; add filters, aggregate, or use LIMIT and retry`,
        );
      }
      if (rows.length >= request.maxRows) {
        capped = true;
        break;
      }
      const converted: Record<string, unknown> = {};
      let budgetSpent = false;
      for (const [key, value] of Object.entries(row)) {
        // Per CELL, not per row: one `hex(randomblob(...))` cell is a single row inside every row
        // cap, so a check that only ran after a whole row was converted bounded nothing at all.
        const cell = truncateCell(fromSqliteValue(value));
        if (cell.truncated) capped = true;
        converted[key] = cell.value;
        bytes += approximateSize(cell.value) + key.length;
        if (bytes > request.maxResultBytes) {
          budgetSpent = true;
          break;
        }
      }
      rows.push(converted);
      if (budgetSpent) {
        capped = true;
        break;
      }
    }
  } finally {
    iterator.return?.(undefined);
  }

  if (columns.length === 0 && rows.length > 0) {
    columns = Object.keys(rows[0] ?? {});
  }
  return { rows, columns, rows_returned: rows.length, capped };
}

function handleDrop(request: Extract<RunnerRequest, { op: 'drop' }>): Record<string, never> {
  const scratch = requireDatabase(request.db);
  const table = scratch.tables.get(request.table);
  // Ramp OSS defect 10: `clear_table` on an unknown name answered "cleared".
  if (!table) {
    throw new RunnerError(
      'unknown_table',
      `no table named ${request.table} in this scratch database`,
    );
  }
  withWriteAccess(scratch, () => {
    scratch.db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(request.table)}`);
  });
  scratch.tables.delete(request.table);
  return {};
}

function handleClose(request: Extract<RunnerRequest, { op: 'close' }>): Record<string, never> {
  const scratch = databases.get(request.db);
  if (scratch) {
    scratch.db.close();
    databases.delete(request.db);
  }
  return {};
}

function dispatch(request: RunnerRequest): RunnerOkResponse['result'] {
  switch (request.op) {
    case 'open':
      openDatabase(request.db);
      return {};
    case 'store':
      return handleStore(request);
    case 'process':
      return handleProcess(request);
    case 'query':
      return handleQuery(request);
    case 'drop':
      return handleDrop(request);
    case 'close':
      return handleClose(request);
  }
}

function start(): void {
  const send = (message: RunnerOkResponse | RunnerErrorResponse | RunnerReadyResponse): void => {
    process.send?.(message);
  };

  process.on('message', (raw: unknown) => {
    const request = raw as RunnerRequest;
    try {
      send({ id: request.id, ok: true, result: dispatch(request) });
    } catch (error) {
      const reason: FailureReason = error instanceof RunnerError ? error.reason : 'syntax_error';
      send({
        id: request.id,
        ok: false,
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // The parent died: take the scratch data with it rather than leaking a process.
  process.on('disconnect', () => {
    process.exit(0);
  });

  const probe = new Database(':memory:');
  const version = String(
    (probe.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v ?? 'unknown',
  );
  probe.close();
  send({ id: 0, ok: true, ready: true, sqlite_version: version });
}

// Only run when forked with an IPC channel; importing this module in a test does nothing.
if (typeof process.send === 'function') start();
