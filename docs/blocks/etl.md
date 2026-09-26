# etl

Status: done, contracts v0.5, wired in `src/composition.ts` (`createEtl({ xray, limits })` once at boot; `etl.forGrant(grant_id, correlation)` becomes `ToolContext.scratch` per request; `etl.shutdown()` runs on SIGTERM).

## Purpose
Ramp's `memory_db.py` protocol (`load` -> `process` -> `query` -> `clear`) as one `:memory:` SQLite database per grant, with the guards Ramp lacks (CLAUDE.md invariant 8, ADR-9).
Model-authored SQL never runs in the server process.

## Files
- `index.ts` - the public exports.
- `scratch-db.ts` - `createEtl`: the manager (grant registry, caps, TTL, LRU, timeout budget, events) and the `ScratchDb` handles.
- `runner-pool.ts` - `createRunnerPool`: forks the runners, routes requests over IPC, `SIGKILL`s a runner on timeout, reports the databases it lost.
- `sql-runner.ts` - the forked child entry: the only place that executes model SQL and the only `better-sqlite3` importer for scratch data.
- `sql-text.ts` - `scanStatement` (literal masking, single statement, deny-list, write tokens, leader check), `quoteIdentifier`, `TABLE_NAME_PATTERN`.
- `rows.ts` - Ramp's row transforms: flattening, union-of-keys columns, type inference, value binding.
- `protocol.ts` - the parent <-> runner message types (`open`, `store`, `process`, `query`, `drop`, `close`).

## Public interface (`src/etl/index.ts`)
- `createEtl(deps: EtlDeps): Etl` - `deps = { xray, limits?, now?, newTableSuffix?, sweepIntervalMs?, runnerEntry?, startupTimeoutMs? }`.
- `Etl` - `forGrant(grantId, correlation?): ScratchDb` (same handle per grant, `correlation` replaced on every call), `sweep()`, `shutdown()`, `stats()` (`scratchDatabases`, `tables`, `runners`, `liveRunners`).
- `ETL_LIMIT_DEFAULTS`; types `EtlLimits`, `EtlDeps`.
- `advertisedColumns`, `flattenRow`, `flattenRows`, `inferColumnTypes`, `toSqliteValue`, `NESTED_KEY_SEPARATOR`; types `SqliteColumnType`, `SqliteValue`.
- `isValidTableName`, `maskLiterals`, `quoteIdentifier`, `scanStatement`, `tokenize`, `MAX_SQL_LENGTH`, `SQL_DENYLIST_TOKENS`, `SQL_WRITE_TOKENS`, `TABLE_NAME_PATTERN`; types `SqlScanReason`, `SqlScanVerdict`.
`ScratchDb` is the contract's: `grantId`, `load`, `process`, `query`, `clear`, `listTables`, `terminate`; every method may reject with a `ScratchDbError`.

## Consumes
- `EtlDeps.xray` (`XrayEmitter`) and `EtlDeps.limits` (partial `EtlLimits`); `composition.ts` passes the eight env knobs below.
- `src/contracts` only: `ScratchDb`, `ScratchDbError`, `ScratchDbFailureReason`, `TOOL_LIMIT_DEFAULTS`, `isId`, `rowCapMessage`, `TOO_MANY_TABLES_MESSAGE`, `ETL_OPERATION_LIMIT_MESSAGE`, the event types. Never `bank-core`: load tools hand it JSON arrays.

## Mechanism
1. `sql-runner.ts` is forked (`child_process.fork`, `serialization: 'advanced'`) into a pool of `ETL_WORKER_POOL_SIZE` runners; a grant goes to the emptiest runner, so up to the pool size no two grants share one.
2. A `query` is sent with `timeoutMs = QUERY_TIMEOUT_MS` and `killOnTimeout: true`; on expiry the parent `SIGKILL`s the runner and every grant on it loses its tables (`etl.worker_terminated` plus one `etl.table_evicted {reason: 'timeout'}` per table). `store`, `process`, `drop` and `close` use `maintenanceTimeoutMs` with no kill.
3. The runner also enforces `softTimeoutMs = 0.8 x QUERY_TIMEOUT_MS` between rows of `Statement.iterate()`, so a slow but row-yielding query returns a clean `timeout` with no kill; only a statement that never yields a row needs the `SIGKILL`.
4. `scanStatement` runs on both sides of the IPC channel: `db.prepare('PRAGMA query_only = 0')` applies the pragma at prepare time, so nothing denylisted may reach `prepare()`.
5. `PRAGMA query_only = 1` is the resting state of every database, lifted only around the block's own `CREATE TABLE`, parameterised `INSERT` and `DROP` and restored in a `finally`; `Statement.readonly` and `Statement.reader` are checked after `prepare()`.
6. Every identifier is quoted; a table name must match `TABLE_NAME_PATTERN` and be in the grant's registry; a query needs a processed table.
7. Caps: `MAX_QUERY_ROWS` (one extra row is fetched to set `capped`), `maxResultBytes` charged per cell, `MAX_CELL_BYTES` 64,000 per cell, `MAX_TABLES_PER_GRANT` (rejects, never evicts), `MAX_SCRATCH_DBS` (LRU-evicts an idle grant), `TABLE_TTL_MINUTES` (sweep on an `unref`'d timer), `MAX_CONCURRENT_ETL_OPS` per grant, `MAX_QUERY_TIMEOUTS` (a grant that caused that many kills has its queries refused as `timeout` until the count decays over one TTL window).
8. A runner exits on IPC `disconnect`, so a dead server leaves no orphans; `shutdown()` kills every runner.

## Knobs (`EtlLimits`; env names and defaults in `.env.example`)
`MAX_TABLES_PER_GRANT` 10, `MAX_SCRATCH_DBS` 200, `MAX_QUERY_ROWS` 100, `TABLE_TTL_MINUTES` 30, `QUERY_TIMEOUT_MS` 2000, `MAX_CONCURRENT_ETL_OPS` 2, `ETL_WORKER_POOL_SIZE` 4, `MAX_QUERY_TIMEOUTS` 3; code-only `maintenanceTimeoutMs` 30000 and `maxResultBytes` 4,000,000.

## Type inference (`rows.ts`)
- Nested objects flatten to `a__b` keys (depth cap 12); arrays and deeper objects become JSON text; columns are the union of keys across all rows in first-seen order.
- Per selected column: INTEGER by default; a string is TEXT, a boolean or integer is INTEGER, a non-integer number is REAL; mixed values resolve TEXT > REAL > INTEGER.
- A missing key and an explicit `null` contribute no type (the cell is NULL); a column with no non-null value is TEXT.
- Binding: booleans become 0/1, non-finite numbers NULL, bigints outside the safe range strings, objects JSON text.

## Events owned
- `etl.load` - `table`, `rows`, `columns_advertised`, `source_tool`, `duration_ms`.
- `etl.processed` - `table`, `rows`, `columns_advertised`, `columns_selected`, `duration_ms`.
- `etl.table_evicted` - `table`, `reason` (`ttl` | `global_cap` | `timeout`), `rows`, `age_ms`.
- `etl.limit_reached` - `limit` (`tables` | `ops` | `global_dbs`), `table`, `current`, `max`, `message`.
- `etl.worker_terminated` - `reason: 'timeout'`, `duration_ms`, `table`, `tables_lost`.
- `sql.query` - `table`, `sql`, `rows_returned`, `capped`, `duration_ms`.
- `sql.table_cleared` - `table`, `duration_ms`.
- `sql.rejected` - `table`, `sql`, `rejected_reason` (`not_readonly` | `denylist` | `multi_statement` | `unknown_table` | `unknown_column` | `syntax_error` | `timeout`; `row_cap` next to a successful capped `sql.query`), `error`, `duration_ms`.
Correlation: `grant_id` when it matches `grt_`, plus what `forGrant` was given (`xs`, `login_id`, `persona_id`, `request_id`).
The handle is one long-lived object per grant, but it carries the correlation of the call *currently* using it: `forGrant` refreshes that correlation on every `tools/call`, so an `etl.*` or `sql.*` event is always filed under the call that caused it (the dashboard keys a call on `<xs>#<request_id>`).

## Invariants held here
- Invariant 8: SQL runs only in a forked runner; the deny-list, not `Statement.readonly`, is the primary ATTACH/DETACH/PRAGMA/VACUUM guard; one `:memory:` database per grant; row, per-grant, global and TTL caps.
- Invariant 12: `shutdown()` is a synchronous kill of every runner, well inside the 10 s budget.
- Invariant 2: the TTL sweep runs on a timer with no request in flight, `unref`'d so it never holds the process open.
- Invariant 14: the grant map, the handle map and each runner's database set are bounded and evicted together.
- Invariant 13: every load, process, query, clear, eviction, cap hit and kill emits an event.

## How to test
```
npx vitest run src/etl        # 101 tests, 5 files, about 5 s (forks real runners)
npm run smoke:worker-sqlite   # 6/6, exit 0: terminate() fails, SIGKILL and the shipped guard succeed
npx eslint src/etl
```
The runner is forked as `src/etl/sql-runner.ts` under tsx in dev and tests and as `dist/etl/sql-runner.js` from the build (`resolveRunnerEntry` picks by extension).

## Known gaps
- An unexpected runner exit clears the affected grants' tables silently: `crash` exists on `EtlEvictionReasonSchema` (v0.2) but `onLoss` in `scratch-db.ts` emits no `etl.worker_terminated` or `etl.table_evicted` for it.
- Beyond `ETL_WORKER_POOL_SIZE` live grants a hard kill costs co-tenants their tables; `MAX_QUERY_TIMEOUTS` and the soft deadline bound the rate, not the radius.
- `MAX_SCRATCH_DBS` counts databases, not bytes; only a single result set is byte-bounded.
- Nothing calls `ScratchDb.terminate`: a revoked grant's database lives until TTL or LRU eviction, and `etl.table_evicted {reason: 'grant_cap'}` has no producer.
- No backpressure on `load`; the row count is bounded by `bank-core` paging only.
