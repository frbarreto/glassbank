/**
 * The scratch-database manager (block: etl).
 *
 * One `:memory:` database per grant, all of them living in out-of-process SQL runners
 * (`runner-pool.ts`), plus every guardrail Ramp's open-source server lacks: the token deny-list,
 * quoted identifiers, a table registry, a row cap, a per-grant table cap, a global cap on live
 * scratch databases with LRU eviction, TTL eviction and a per-grant concurrent-operation limit
 * (CLAUDE.md invariant 8, ADR-9 as amended, docs/RAMP_REFERENCE.md section 2.1).
 *
 * The messages a model sees are Ramp's, imported from `src/contracts/tools.ts` rather than
 * retyped, so `tools`, `etl` and the dashboard fixture cannot drift apart.
 */
import { randomUUID } from 'node:crypto';

import {
  ETL_OPERATION_LIMIT_MESSAGE,
  isId,
  rowCapMessage,
  ScratchDbError,
  TOOL_LIMIT_DEFAULTS,
  TOO_MANY_TABLES_MESSAGE,
  type LoadTableInput,
  type LoadedTable,
  type ProcessTableInput,
  type ProcessedTable,
  type ScratchDb,
  type ScratchQueryInput,
  type ScratchQueryResult,
  type ScratchTable,
  type ScratchTerminateReason,
  type XrayCorrelation,
  type XrayEmitter,
  type XrayEventDataInput,
  type XrayEventType,
} from '../contracts/index.js';

import type {
  RunnerProcessResult,
  RunnerQueryResult,
  RunnerRequestBody,
  RunnerStoreResult,
} from './protocol.js';
import { createRunnerPool, type RunnerLossCause } from './runner-pool.js';
import { isValidTableName, scanStatement } from './sql-text.js';

/** Every knob of docs/DEPLOYMENT.md section 3 that this block owns. */
export interface EtlLimits {
  readonly maxTablesPerGrant: number;
  readonly maxScratchDbs: number;
  readonly maxQueryRows: number;
  readonly tableTtlMinutes: number;
  readonly queryTimeoutMs: number;
  readonly maxConcurrentEtlOps: number;
  readonly etlWorkerPoolSize: number;
  /** Budget for this block's own trusted statements (store, process, drop, close). */
  readonly maintenanceTimeoutMs: number;
  /** Ceiling on the accumulated size of one query result, so a blob bomb cannot fill a runner. */
  readonly maxResultBytes: number;
  /**
   * How many hard query timeouts one grant may cause before its queries are refused up front.
   *
   * A hard timeout SIGKILLs a shared runner and every co-tenant grant loses its tables, so this
   * is the bound on how much damage one caller can do: without it the per-grant `tools/call`
   * limit (120/min) is the only ceiling.
   */
  readonly maxQueryTimeouts: number;
}

export const ETL_LIMIT_DEFAULTS: EtlLimits = {
  maxTablesPerGrant: TOOL_LIMIT_DEFAULTS.maxTablesPerGrant,
  maxScratchDbs: TOOL_LIMIT_DEFAULTS.maxScratchDbs,
  maxQueryRows: TOOL_LIMIT_DEFAULTS.maxQueryRows,
  tableTtlMinutes: TOOL_LIMIT_DEFAULTS.tableTtlMinutes,
  queryTimeoutMs: TOOL_LIMIT_DEFAULTS.queryTimeoutMs,
  maxConcurrentEtlOps: TOOL_LIMIT_DEFAULTS.maxConcurrentEtlOps,
  etlWorkerPoolSize: TOOL_LIMIT_DEFAULTS.etlWorkerPoolSize,
  maintenanceTimeoutMs: 30_000,
  maxResultBytes: 4_000_000,
  maxQueryTimeouts: 3,
};

export interface EtlDeps {
  /** Fire-and-forget event sink; every `etl.*` and `sql.*` event goes through it. */
  readonly xray: XrayEmitter;
  readonly limits?: Partial<EtlLimits>;
  /** Injected clock, so TTL and eviction tests stay deterministic. */
  readonly now?: () => Date;
  /** The `{tool}_{uuid4hex}` suffix generator (Ramp convention). */
  readonly newTableSuffix?: () => string;
  /** TTL sweep interval; `null` disables the timer and leaves `sweep()` to the caller. */
  readonly sweepIntervalMs?: number | null;
  /** Test hook forwarded to the runner pool. */
  readonly runnerEntry?: { readonly path: string; readonly execArgv: string[] };
  readonly startupTimeoutMs?: number;
}

interface TableState {
  readonly tableName: string;
  readonly sourceTool: string;
  rows: number;
  columnsAdvertised: string[];
  columnsSelected: string[];
  processed: boolean;
  readonly createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
}

interface GrantState {
  readonly grantId: string;
  correlation: XrayCorrelation;
  readonly tables: Map<string, TableState>;
  inFlight: number;
  lastUsedAt: number;
  /** Hard query timeouts this grant has caused, and when the count last moved. */
  queryTimeouts: number;
  lastTimeoutAt: number;
}

export interface Etl {
  /** The per-grant `ScratchDb` every tool handler is given through `ToolContext`. */
  forGrant(grantId: string, correlation?: XrayCorrelation): ScratchDb;
  /** TTL eviction. Runs on a timer by default; exposed so tests and `app` can drive it. */
  sweep(): Promise<void>;
  /** Frees every runner. Must finish well inside the 10 s SIGTERM budget (invariant 12). */
  shutdown(): Promise<void>;
  stats(): {
    readonly scratchDatabases: number;
    readonly tables: number;
    readonly runners: number;
    readonly liveRunners: number;
  };
}

/** Merges the caller's knobs over the defaults, ignoring keys explicitly set to `undefined`. */
function resolveLimits(overrides: Partial<EtlLimits> | undefined): EtlLimits {
  const limits: EtlLimits = { ...ETL_LIMIT_DEFAULTS };
  if (!overrides) return limits;
  const merged: Record<string, number> = { ...limits };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value;
  }
  return merged as unknown as EtlLimits;
}

export function createEtl(deps: EtlDeps): Etl {
  const limits = resolveLimits(deps.limits);
  const now = deps.now ?? (() => new Date());
  const newTableSuffix = deps.newTableSuffix ?? (() => randomUUID().replace(/-/g, ''));
  const ttlMs = limits.tableTtlMinutes * 60_000;

  /** Insertion order is the LRU order: a touched grant is deleted and re-inserted. */
  const grants = new Map<string, GrantState>();

  function emit<T extends XrayEventType>(
    state: GrantState,
    type: T,
    data: XrayEventDataInput<T>,
  ): void {
    deps.xray.emit(type, data, state.correlation);
  }

  function correlationFor(grantId: string, extra?: XrayCorrelation): XrayCorrelation {
    // The envelope validates `grant_id` against the `grt_` pattern; a test id that is not one
    // simply travels without it rather than making the emitter throw.
    return isId(grantId, 'grant') ? { grant_id: grantId, ...extra } : { ...extra };
  }

  function evictTables(state: GrantState, reason: 'ttl' | 'global_cap' | 'timeout'): string[] {
    const nowMs = now().getTime();
    const names: string[] = [];
    for (const table of state.tables.values()) {
      names.push(table.tableName);
      emit(state, 'etl.table_evicted', {
        table: table.tableName,
        reason,
        rows: table.rows,
        age_ms: Math.max(0, nowMs - table.createdAt),
      });
    }
    state.tables.clear();
    return names;
  }

  /** A runner died: every grant it hosted loses its `:memory:` database. */
  function onLoss(
    lost: readonly string[],
    cause: RunnerLossCause,
    context: { readonly db: string | null; readonly durationMs: number },
  ): void {
    // Only the grant whose statement ran is charged for the kill; its co-tenants are victims.
    if (cause === 'timeout' && context.db !== null) {
      const culprit = grants.get(context.db);
      if (culprit) {
        culprit.queryTimeouts += 1;
        culprit.lastTimeoutAt = now().getTime();
      }
    }
    for (const grantId of lost) {
      const state = grants.get(grantId);
      if (!state) continue;
      if (cause === 'timeout') {
        const tablesLost = evictTables(state, 'timeout');
        emit(state, 'etl.worker_terminated', {
          reason: 'timeout',
          duration_ms: context.durationMs,
          table: context.db === grantId ? (tablesLost[0] ?? null) : null,
          tables_lost: tablesLost,
        });
      } else {
        // An unexpected exit (a crash or an out-of-memory kill) has no reason in
        // `EtlEvictionReasonSchema`; see docs/blocks/etl.md "Known gaps" and the CHANGES proposal.
        state.tables.clear();
      }
    }
  }

  const pool = createRunnerPool({
    size: limits.etlWorkerPoolSize,
    onLoss,
    runnerEntry: deps.runnerEntry,
    startupTimeoutMs: deps.startupTimeoutMs,
  });

  function touch(state: GrantState): void {
    state.lastUsedAt = now().getTime();
    grants.delete(state.grantId);
    grants.set(state.grantId, state);
  }

  /** Global cap with LRU eviction; a grant with work in flight is never the victim. */
  function enforceGlobalCap(exempt: string): void {
    while (grants.size >= limits.maxScratchDbs) {
      let victim: GrantState | null = null;
      for (const candidate of grants.values()) {
        if (candidate.grantId === exempt || candidate.inFlight > 0) continue;
        victim = candidate;
        break;
      }
      if (!victim) return; // Everything live is busy; the caller proceeds over the cap.
      emit(victim, 'etl.limit_reached', {
        limit: 'global_dbs',
        table: null,
        current: grants.size,
        max: limits.maxScratchDbs,
        message: 'the least recently used scratch database was evicted to stay under the cap',
      });
      evictTables(victim, 'global_cap');
      grants.delete(victim.grantId);
      handles.delete(victim.grantId);
      // The handle must leave with the grant, exactly as `terminate` and `sweep` do it: otherwise
      // every grant id that ever called a tool keeps a closure alive for the life of the process,
      // which is the unbounded map CLAUDE.md invariant 14 exists to forbid.
      closeDatabase(victim.grantId);
    }
  }

  /** Closes a grant's `:memory:` database if a runner is actually holding one. */
  function closeDatabase(grantId: string): void {
    const runner = pool.assigned(grantId);
    if (!runner) return;
    void pool
      .send(
        runner,
        { op: 'close', db: grantId },
        { timeoutMs: limits.maintenanceTimeoutMs, killOnTimeout: false },
      )
      .catch(() => undefined)
      .finally(() => pool.release(grantId));
  }

  function stateFor(grantId: string, correlation?: XrayCorrelation): GrantState {
    const existing = grants.get(grantId);
    if (existing) {
      if (correlation) existing.correlation = { ...existing.correlation, ...correlation };
      touch(existing);
      return existing;
    }
    enforceGlobalCap(grantId);
    const created: GrantState = {
      grantId,
      correlation: correlationFor(grantId, correlation),
      tables: new Map(),
      inFlight: 0,
      lastUsedAt: now().getTime(),
      queryTimeouts: 0,
      lastTimeoutAt: 0,
    };
    grants.set(grantId, created);
    return created;
  }

  /**
   * True once this grant has spent its budget of hard query timeouts. The count decays over one
   * TTL window, so an honest caller that hit the budget hours ago is not punished forever, while
   * a caller repeating the kill sees its queries refused without a runner ever being touched.
   */
  function timeoutBudgetSpent(state: GrantState): boolean {
    if (state.queryTimeouts <= 0) return false;
    if (now().getTime() - state.lastTimeoutAt >= ttlMs) {
      state.queryTimeouts = 0;
      return false;
    }
    return state.queryTimeouts >= limits.maxQueryTimeouts;
  }

  async function run<T>(
    state: GrantState,
    body: RunnerRequestBody,
    options: { readonly timeoutMs: number; readonly killOnTimeout: boolean },
  ): Promise<T> {
    const runner = pool.acquire(state.grantId);
    return (await pool.send(runner, body, options)) as T;
  }

  function enterOperation(state: GrantState): void {
    if (state.inFlight >= limits.maxConcurrentEtlOps) {
      emit(state, 'etl.limit_reached', {
        limit: 'ops',
        table: null,
        current: state.inFlight,
        max: limits.maxConcurrentEtlOps,
        message: ETL_OPERATION_LIMIT_MESSAGE,
      });
      throw new ScratchDbError('ops_limit', ETL_OPERATION_LIMIT_MESSAGE);
    }
    state.inFlight += 1;
  }

  function toScratchTable(table: TableState): ScratchTable {
    return {
      table_name: table.tableName,
      source_tool: table.sourceTool,
      rows: table.rows,
      columns_advertised: [...table.columnsAdvertised],
      columns_selected: [...table.columnsSelected],
      processed: table.processed,
      created_at: new Date(table.createdAt).toISOString(),
      expires_at: new Date(table.expiresAt).toISOString(),
    };
  }

  function rejectQuery(
    state: GrantState,
    table: string | null,
    sql: string,
    reason:
      | 'not_readonly'
      | 'denylist'
      | 'timeout'
      | 'unknown_table'
      | 'multi_statement'
      | 'unknown_column'
      | 'syntax_error',
    message: string,
    durationMs: number,
  ): ScratchDbError {
    emit(state, 'sql.rejected', {
      table,
      sql,
      rejected_reason: reason,
      error: message,
      duration_ms: durationMs,
    });
    return new ScratchDbError(reason, message, { sql, duration_ms: durationMs });
  }

  /**
   * One handle per grant, created once and evicted with the grant. `readCorrelation` is a getter,
   * not a captured value: the handle outlives the call that created it, so baking that call's
   * correlation into the closure stamped every later `etl.*` and `sql.*` event of the grant with
   * the *first* call's `request_id`. On a live server that meant a query run by call four was
   * filed under call two and nested under neither.
   */
  function createHandle(
    grantId: string,
    readCorrelation: () => XrayCorrelation | undefined,
  ): ScratchDb {
    return {
      grantId,

      async load(input: LoadTableInput): Promise<LoadedTable> {
        const state = stateFor(grantId, readCorrelation());
        const startedAt = Date.now();
        enterOperation(state);
        try {
          const tableName = input.table_name ?? `${input.source_tool}_${newTableSuffix()}`;
          if (!isValidTableName(tableName)) {
            throw new ScratchDbError(
              'unknown_table',
              `"${tableName}" is not a valid scratch table name`,
            );
          }
          if (!state.tables.has(tableName) && state.tables.size >= limits.maxTablesPerGrant) {
            emit(state, 'etl.limit_reached', {
              limit: 'tables',
              table: tableName,
              current: state.tables.size,
              max: limits.maxTablesPerGrant,
              message: TOO_MANY_TABLES_MESSAGE,
            });
            throw new ScratchDbError('grant_cap', TOO_MANY_TABLES_MESSAGE);
          }

          const result = await run<RunnerStoreResult>(
            state,
            { op: 'store', db: grantId, table: tableName, rows: input.rows },
            { timeoutMs: limits.maintenanceTimeoutMs, killOnTimeout: false },
          );

          const createdAt = now().getTime();
          state.tables.set(tableName, {
            tableName,
            sourceTool: input.source_tool,
            rows: result.rows,
            columnsAdvertised: result.columns_advertised,
            columnsSelected: [],
            processed: false,
            createdAt,
            expiresAt: createdAt + ttlMs,
            lastUsedAt: createdAt,
          });

          emit(state, 'etl.load', {
            table: tableName,
            rows: result.rows,
            columns_advertised: result.columns_advertised,
            source_tool: input.source_tool,
            duration_ms: Date.now() - startedAt,
          });
          return {
            table_name: tableName,
            rows: result.rows,
            columns_advertised: result.columns_advertised,
          };
        } finally {
          state.inFlight -= 1;
        }
      },

      async process(input: ProcessTableInput): Promise<ProcessedTable> {
        const state = stateFor(grantId, readCorrelation());
        const startedAt = Date.now();
        enterOperation(state);
        try {
          const table = state.tables.get(input.table_name);
          if (!table) {
            const message = `no table named ${input.table_name} in this scratch database; run a load_* tool first`;
            throw rejectQuery(state, input.table_name, '', 'unknown_table', message, 0);
          }
          const result = await run<RunnerProcessResult>(
            state,
            { op: 'process', db: grantId, table: input.table_name, cols: input.cols },
            { timeoutMs: limits.maintenanceTimeoutMs, killOnTimeout: false },
          );
          table.columnsSelected = result.columns_selected;
          table.processed = true;
          table.lastUsedAt = now().getTime();

          emit(state, 'etl.processed', {
            table: table.tableName,
            rows: result.rows,
            columns_advertised: [...table.columnsAdvertised],
            columns_selected: result.columns_selected,
            duration_ms: Date.now() - startedAt,
          });
          return {
            table_name: table.tableName,
            rows: result.rows,
            columns_selected: result.columns_selected,
          };
        } finally {
          state.inFlight -= 1;
        }
      },

      async query(input: ScratchQueryInput): Promise<ScratchQueryResult> {
        const state = stateFor(grantId, readCorrelation());
        const startedAt = Date.now();
        enterOperation(state);
        try {
          const table = state.tables.get(input.table_name);
          if (!table || !table.processed) {
            const message = table
              ? `table ${input.table_name} has not been processed yet; call process_data with the columns you need`
              : `no table named ${input.table_name} in this scratch database; run a load_* tool first`;
            throw rejectQuery(state, input.table_name, input.sql, 'unknown_table', message, 0);
          }

          const verdict = scanStatement(input.sql);
          if (!verdict.ok) {
            throw rejectQuery(
              state,
              input.table_name,
              input.sql,
              verdict.reason,
              verdict.message,
              Date.now() - startedAt,
            );
          }

          const maxRows = Math.max(1, input.max_rows ?? limits.maxQueryRows);
          const timeoutMs = Math.max(1, input.timeout_ms ?? limits.queryTimeoutMs);

          // A timeout that reaches the parent SIGKILLs the whole runner, and a runner hosts up to
          // `maxScratchDbs / etlWorkerPoolSize` grants, so every kill costs its co-tenants their
          // tables. Full isolation is not affordable (one forked runner per grant would be ~50 MB
          // each on a 1 GiB instance), so the blast radius is bounded the other way: a grant that
          // has already killed a runner `maxQueryTimeouts` times has its queries refused up front,
          // which turns "120 kills a minute" into a handful. The budget decays with the TTL window.
          if (timeoutBudgetSpent(state)) {
            // `timeout` and not a new reason: `SqlRejectedReasonSchema` is frozen, and this IS a
            // refusal for exceeding the time budget - just one charged before the statement runs.
            throw rejectQuery(
              state,
              input.table_name,
              input.sql,
              'timeout',
              `this connection has already had ${limits.maxQueryTimeouts} queries stopped for exceeding the ` +
                'time budget, so no further query will be run for now. Add filters, aggregate, or use LIMIT, and retry later',
              Date.now() - startedAt,
            );
          }

          let result: RunnerQueryResult;
          try {
            result = await run<RunnerQueryResult>(
              state,
              {
                op: 'query',
                db: grantId,
                sql: verdict.normalised,
                maxRows,
                maxResultBytes: limits.maxResultBytes,
                // Leave the parent a margin to win the race only when the runner cannot: the
                // runner answers cleanly whenever the statement is yielding rows.
                softTimeoutMs: Math.max(1, Math.floor(timeoutMs * 0.8)),
              },
              { timeoutMs, killOnTimeout: true },
            );
          } catch (error) {
            const durationMs = Date.now() - startedAt;
            if (error instanceof ScratchDbError && error.reason === 'timeout') {
              throw rejectQuery(
                state,
                input.table_name,
                input.sql,
                'timeout',
                `the query was stopped after ${timeoutMs} ms; add filters, aggregate, or use LIMIT and retry`,
                durationMs,
              );
            }
            if (
              error instanceof ScratchDbError &&
              (error.reason === 'not_readonly' ||
                error.reason === 'syntax_error' ||
                error.reason === 'unknown_column')
            ) {
              // `syntax_error` and `unknown_column` became reportable at contracts v0.2 (P-3);
              // before that they reached the model but left no `sql.*` event behind them.
              throw rejectQuery(
                state,
                input.table_name,
                input.sql,
                error.reason,
                error.message,
                durationMs,
              );
            }
            throw error;
          }

          table.lastUsedAt = now().getTime();
          const durationMs = Date.now() - startedAt;
          if (result.capped) {
            // Hosted Ramp's wording, so the dashboard and the model say the same thing. The call
            // still succeeds: `row_cap` marks a trimmed result, not a refused statement.
            emit(state, 'sql.rejected', {
              table: input.table_name,
              sql: input.sql,
              rejected_reason: 'row_cap',
              error: rowCapMessage(maxRows),
              duration_ms: durationMs,
            });
          }
          emit(state, 'sql.query', {
            table: input.table_name,
            sql: input.sql,
            rows_returned: result.rows_returned,
            capped: result.capped,
            duration_ms: durationMs,
          });
          return {
            rows: result.rows,
            columns: result.columns,
            rows_returned: result.rows_returned,
            capped: result.capped,
            duration_ms: durationMs,
          };
        } finally {
          state.inFlight -= 1;
        }
      },

      async clear(tableName: string): Promise<void> {
        const state = stateFor(grantId, readCorrelation());
        const startedAt = Date.now();
        enterOperation(state);
        try {
          if (!state.tables.has(tableName)) {
            // Ramp OSS defect 10: `clear_table` on an unknown name answered "cleared".
            throw rejectQuery(
              state,
              tableName,
              '',
              'unknown_table',
              `no table named ${tableName} in this scratch database`,
              0,
            );
          }
          await run<Record<string, never>>(
            state,
            { op: 'drop', db: grantId, table: tableName },
            { timeoutMs: limits.maintenanceTimeoutMs, killOnTimeout: false },
          );
          state.tables.delete(tableName);
          emit(state, 'sql.table_cleared', {
            table: tableName,
            duration_ms: Date.now() - startedAt,
          });
        } finally {
          state.inFlight -= 1;
        }
      },

      async listTables(): Promise<readonly ScratchTable[]> {
        const state = grants.get(grantId);
        if (!state) return [];
        return [...state.tables.values()].map(toScratchTable);
      },

      async terminate(reason: ScratchTerminateReason): Promise<void> {
        const state = grants.get(grantId);
        if (!state) return;
        if (reason === 'ttl' || reason === 'global_cap' || reason === 'timeout') {
          evictTables(state, reason);
        } else {
          state.tables.clear();
        }
        grants.delete(grantId);
        handles.delete(grantId);
        const runner = pool.assigned(grantId);
        if (!runner) return;
        try {
          await pool.send(
            runner,
            { op: 'close', db: grantId },
            { timeoutMs: limits.maintenanceTimeoutMs, killOnTimeout: false },
          );
        } catch {
          // The runner is already gone, which achieves the same thing.
        } finally {
          pool.release(grantId);
        }
      },
    };
  }

  /** The handle plus the correlation of the call currently using it; `forGrant` refreshes it. */
  interface HandleEntry {
    db: ScratchDb;
    correlation: XrayCorrelation | undefined;
  }

  const handles = new Map<string, HandleEntry>();

  async function sweep(): Promise<void> {
    const nowMs = now().getTime();
    for (const state of [...grants.values()]) {
      if (state.inFlight > 0) continue;
      const expired = [...state.tables.values()].filter((table) => table.expiresAt <= nowMs);
      for (const table of expired) {
        emit(state, 'etl.table_evicted', {
          table: table.tableName,
          reason: 'ttl',
          rows: table.rows,
          age_ms: Math.max(0, nowMs - table.createdAt),
        });
        state.tables.delete(table.tableName);
        const runner = pool.assigned(state.grantId);
        if (runner) {
          await pool
            .send(
              runner,
              { op: 'drop', db: state.grantId, table: table.tableName },
              { timeoutMs: limits.maintenanceTimeoutMs, killOnTimeout: false },
            )
            .catch(() => undefined);
        }
      }
      if (state.tables.size === 0 && nowMs - state.lastUsedAt >= ttlMs) {
        grants.delete(state.grantId);
        handles.delete(state.grantId);
        closeDatabase(state.grantId);
      }
    }
  }

  const sweepIntervalMs =
    deps.sweepIntervalMs === undefined
      ? Math.min(60_000, Math.max(1000, ttlMs / 4))
      : deps.sweepIntervalMs;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  if (sweepIntervalMs !== null) {
    sweepTimer = setInterval(() => {
      void sweep();
    }, sweepIntervalMs);
    // Invariant 2: TTL eviction runs with no request in flight, but it must never hold the
    // process open on its own.
    sweepTimer.unref?.();
  }

  return {
    forGrant(id: string, correlation?: XrayCorrelation): ScratchDb {
      const existing = handles.get(id);
      if (existing) {
        // The one write that keeps every later event of this grant on the call that caused it.
        if (correlation) existing.correlation = correlation;
        return existing.db;
      }
      const entry = { correlation } as HandleEntry;
      entry.db = createHandle(id, () => entry.correlation);
      handles.set(id, entry);
      return entry.db;
    },
    sweep,
    async shutdown(): Promise<void> {
      if (sweepTimer) clearInterval(sweepTimer);
      grants.clear();
      handles.clear();
      pool.shutdown();
    },
    stats() {
      const poolStats = pool.stats();
      let tables = 0;
      for (const state of grants.values()) tables += state.tables.size;
      return {
        scratchDatabases: grants.size,
        tables,
        runners: poolStats.runners,
        liveRunners: poolStats.live,
      };
    },
  };
}
