#!/usr/bin/env node
/**
 * Runs the SHIPPED `src/etl` guard against a `WITH RECURSIVE` bomb and reports what happened
 * (block: etl). Used by `scripts/smoke-worker-sqlite.mjs`, which spawns it as
 * `node --import tsx scripts/probe-etl-timeout.mjs` because the block is TypeScript.
 *
 * It measures the two properties CLAUDE.md invariant 8 promises:
 *   - the hostile query comes back as a `timeout` rejection inside `QUERY_TIMEOUT_MS`;
 *   - this process's event loop keeps ticking the whole time, which is what keeps `/healthz`,
 *     `/token`, `/mcp` and the SSE fan-out answering for every other user.
 *
 * One JSON object per stdout line.
 */
import process from 'node:process';

const QUERY_TIMEOUT_MS = Number(process.argv[2] ?? 600);

/** The statement that survives `worker.terminate()`: an aggregate over an unbounded recursion. */
const BOMB =
  'WITH RECURSIVE counter(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM counter) ' +
  'SELECT count(*) AS n FROM counter';

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const { createEtl } = await import(new URL('../src/etl/index.ts', import.meta.url).href);

const events = [];
const etl = createEtl({
  xray: { emit: (type, data) => events.push({ type, data }) },
  limits: { queryTimeoutMs: QUERY_TIMEOUT_MS, etlWorkerPoolSize: 1 },
  sweepIntervalMs: null,
});

const scratch = etl.forGrant('grt_smoke0001');
const loaded = await scratch.load({
  source_tool: 'load_transactions',
  rows: [
    { id: 'txn_1', amount_cents: -450 },
    { id: 'txn_2', amount_cents: 250_000 },
  ],
});
await scratch.process({ table_name: loaded.table_name, cols: ['id', 'amount_cents'] });
emit({ event: 'table_ready', table: loaded.table_name, rows: loaded.rows });

let ticks = 0;
let maxGapMs = 0;
let lastTick = Date.now();
const heartbeat = setInterval(() => {
  const now = Date.now();
  maxGapMs = Math.max(maxGapMs, now - lastTick);
  lastTick = now;
  ticks += 1;
}, 20);

const startedAt = performance.now();
let reason = 'no_error';
let message = '';
try {
  await scratch.query({ table_name: loaded.table_name, sql: BOMB });
} catch (error) {
  reason = error?.reason ?? 'unknown';
  message = error?.message ?? String(error);
}
const elapsedMs = Math.round(performance.now() - startedAt);
clearInterval(heartbeat);

emit({
  event: 'bomb_result',
  reason,
  message,
  elapsed_ms: elapsedMs,
  budget_ms: QUERY_TIMEOUT_MS,
  ticks,
  max_gap_ms: maxGapMs,
  emitted: events.map((entry) => entry.type),
  tables_after: (await scratch.listTables()).length,
});

// The block must still serve the next request after the kill.
const reloaded = await scratch.load({
  source_tool: 'load_transactions',
  rows: [{ id: 'txn_3', amount_cents: 100 }],
});
await scratch.process({ table_name: reloaded.table_name, cols: ['id', 'amount_cents'] });
const after = await scratch.query({
  table_name: reloaded.table_name,
  sql: `SELECT sum(amount_cents) AS total_cents FROM "${reloaded.table_name}"`,
});
emit({ event: 'recovered', rows: after.rows });

const shutdownStartedAt = performance.now();
await etl.shutdown();
emit({ event: 'shutdown', elapsed_ms: Math.round(performance.now() - shutdownStartedAt) });
process.exit(0);
