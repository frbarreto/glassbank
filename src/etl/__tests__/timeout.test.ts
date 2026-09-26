/**
 * The acceptance test of ADR-9 as amended (docs/ASSUMPTIONS.md A-39, CLAUDE.md invariant 8).
 *
 * A `WITH RECURSIVE` bomb whose aggregate never yields a row to JavaScript - the exact statement
 * that survives `worker.terminate()` and wedges process exit - must come back as
 * `sql.rejected {reason: timeout}` inside `QUERY_TIMEOUT_MS` (plus teardown slack), while a
 * health probe running on this process's own event loop keeps answering throughout.
 *
 * The mechanism under test is the out-of-process runner: the parent sends `SIGKILL`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { isScratchDbError, type ScratchDb } from '../../contracts/index.js';
import { createEtl, type Etl } from '../index.js';
import { createRecordingEmitter, type RecordingEmitter } from './harness.js';

/** `SELECT count(*)` over an unbounded recursion: SQLite never returns a row to JavaScript. */
const BOMB =
  'WITH RECURSIVE counter(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM counter) ' +
  'SELECT count(*) AS n FROM counter';

/** The same recursion consumed row by row; `iterate()` alone bounds only this one. */
const STREAMING_BOMB =
  'WITH RECURSIVE counter(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM counter) SELECT x FROM counter';

const QUERY_TIMEOUT_MS = 600;
/** Teardown slack: SIGKILL was measured at 1-2 ms, so this is generous on purpose. */
const TEARDOWN_SLACK_MS = 2500;

const created: Etl[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((etl) => etl.shutdown()));
});

async function ready(grantId: string): Promise<{
  readonly etl: Etl;
  readonly scratch: ScratchDb;
  readonly xray: RecordingEmitter;
  readonly table: string;
}> {
  const xray = createRecordingEmitter();
  const etl = createEtl({
    xray,
    limits: { queryTimeoutMs: QUERY_TIMEOUT_MS, etlWorkerPoolSize: 2 },
    sweepIntervalMs: null,
  });
  created.push(etl);
  const scratch = etl.forGrant(grantId);
  const loaded = await scratch.load({
    source_tool: 'load_transactions',
    rows: [{ id: 'txn_1', amount_cents: -450 }],
  });
  await scratch.process({ table_name: loaded.table_name, cols: ['id', 'amount_cents'] });
  return { etl, scratch, xray, table: loaded.table_name };
}

/** A stand-in for `/healthz`: a synchronous answer scheduled on this process's event loop. */
function startHealthProbe(): { stop: () => { readonly answers: number; readonly maxGapMs: number } } {
  let answers = 0;
  let maxGapMs = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    answers += 1;
  }, 20);
  return {
    stop() {
      clearInterval(timer);
      return { answers, maxGapMs };
    },
  };
}

describe('the WITH RECURSIVE bomb (ADR-9 amended, A-39 amended)', () => {
  it(
    'is stopped inside QUERY_TIMEOUT_MS while the health probe keeps answering',
    async () => {
      const { scratch, xray, table } = await ready('grt_bomb0001');
      const probe = startHealthProbe();
      const startedAt = Date.now();

      let reason = 'none';
      try {
        await scratch.query({ table_name: table, sql: BOMB });
      } catch (error) {
        if (!isScratchDbError(error)) throw error;
        reason = error.reason;
      }
      const elapsedMs = Date.now() - startedAt;
      const health = probe.stop();

      expect(reason).toBe('timeout');
      expect(elapsedMs).toBeLessThan(QUERY_TIMEOUT_MS + TEARDOWN_SLACK_MS);

      // Invariant 8: /healthz stays responsive while a hostile query burns CPU elsewhere.
      expect(health.answers).toBeGreaterThanOrEqual(Math.floor(QUERY_TIMEOUT_MS / 20 / 2));
      expect(health.maxGapMs).toBeLessThan(250);

      const rejected = xray.lastOfType('sql.rejected');
      expect(rejected?.data.rejected_reason).toBe('timeout');
      expect(rejected?.data.sql).toBe(BOMB);
      expect(rejected?.data.table).toBe(table);

      const terminated = xray.lastOfType('etl.worker_terminated');
      expect(terminated?.data.reason).toBe('timeout');
      expect(terminated?.data.tables_lost).toEqual([table]);
      expect(xray.ofType('etl.table_evicted').at(-1)?.data.reason).toBe('timeout');
    },
    QUERY_TIMEOUT_MS + TEARDOWN_SLACK_MS + 20_000,
  );

  it(
    'also bounds the streaming form that iterate() alone would catch',
    async () => {
      const { scratch, table } = await ready('grt_bomb0002');
      const startedAt = Date.now();
      let reason = 'none';
      try {
        await scratch.query({ table_name: table, sql: STREAMING_BOMB });
      } catch (error) {
        if (!isScratchDbError(error)) throw error;
        reason = error.reason;
      }
      // The row cap stops this one long before the timeout does; either way it must come back.
      expect(['timeout', 'none']).toContain(reason);
      expect(Date.now() - startedAt).toBeLessThan(QUERY_TIMEOUT_MS + TEARDOWN_SLACK_MS);
    },
    QUERY_TIMEOUT_MS + TEARDOWN_SLACK_MS + 20_000,
  );

  it(
    'loses the grant s tables and keeps serving after the kill',
    async () => {
      const { scratch, table } = await ready('grt_bomb0003');
      await expect(scratch.query({ table_name: table, sql: BOMB })).rejects.toThrow();

      // The `:memory:` database went with the runner; the model is told to reload.
      expect(await scratch.listTables()).toEqual([]);

      const reloaded = await scratch.load({
        source_tool: 'load_transactions',
        rows: [{ id: 'txn_2', amount_cents: 100 }],
      });
      await scratch.process({ table_name: reloaded.table_name, cols: ['id', 'amount_cents'] });
      const result = await scratch.query({
        table_name: reloaded.table_name,
        sql: `SELECT sum(amount_cents) AS total_cents FROM "${reloaded.table_name}"`,
      });
      expect(result.rows).toEqual([{ total_cents: 100 }]);
    },
    QUERY_TIMEOUT_MS + TEARDOWN_SLACK_MS + 20_000,
  );

  it(
    'costs no other grant its tables while the pool has an idle runner',
    async () => {
      const xray = createRecordingEmitter();
      const etl = createEtl({
        xray,
        limits: { queryTimeoutMs: QUERY_TIMEOUT_MS, etlWorkerPoolSize: 2 },
        sweepIntervalMs: null,
      });
      created.push(etl);

      const attacker = etl.forGrant('grt_bomb0004');
      const bystander = etl.forGrant('grt_calm0001');
      const attackerTable = await attacker.load({ source_tool: 'load_a', rows: [{ id: 1 }] });
      const bystanderTable = await bystander.load({ source_tool: 'load_b', rows: [{ id: 2 }] });
      await attacker.process({ table_name: attackerTable.table_name, cols: ['id'] });
      await bystander.process({ table_name: bystanderTable.table_name, cols: ['id'] });

      await expect(
        attacker.query({ table_name: attackerTable.table_name, sql: BOMB }),
      ).rejects.toThrow();

      expect(await attacker.listTables()).toEqual([]);
      const survivors = await bystander.listTables();
      expect(survivors.map((entry) => entry.table_name)).toEqual([bystanderTable.table_name]);
      const stillWorks = await bystander.query({
        table_name: bystanderTable.table_name,
        sql: `SELECT id FROM "${bystanderTable.table_name}"`,
      });
      expect(stillWorks.rows).toEqual([{ id: 2 }]);
    },
    QUERY_TIMEOUT_MS + TEARDOWN_SLACK_MS + 20_000,
  );

  it(
    'stops charging co-tenant grants after a caller spends its timeout budget',
    async () => {
      // A kill costs every grant sharing the runner its tables, and one forked runner per grant is
      // not affordable on a 1 GiB instance, so the blast radius is bounded by refusing a repeat
      // offender's queries BEFORE they reach a runner. Without this the per-grant `tools/call`
      // limit (120/min) is the only ceiling on how often one caller can wipe its neighbours.
      const xray = createRecordingEmitter();
      const etl = createEtl({
        xray,
        limits: { queryTimeoutMs: QUERY_TIMEOUT_MS, etlWorkerPoolSize: 1, maxQueryTimeouts: 2 },
        sweepIntervalMs: null,
      });
      created.push(etl);

      const attacker = etl.forGrant('grt_bomb0006');
      const attackerTable = await attacker.load({ source_tool: 'load_a', rows: [{ id: 1 }] });
      await attacker.process({ table_name: attackerTable.table_name, cols: ['id'] });

      // Two bombs are allowed through and each kills the shared runner.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const reloaded = await attacker.load({ source_tool: 'load_a', rows: [{ id: 1 }] });
        await attacker.process({ table_name: reloaded.table_name, cols: ['id'] });
        await expect(
          attacker.query({ table_name: reloaded.table_name, sql: BOMB }),
        ).rejects.toThrow();
      }
      expect(xray.ofType('etl.worker_terminated')).toHaveLength(2);

      // The third is refused up front: no runner is killed, so a co-tenant loaded now survives.
      const bystander = etl.forGrant('grt_calm0002');
      const bystanderTable = await bystander.load({ source_tool: 'load_b', rows: [{ id: 2 }] });
      await bystander.process({ table_name: bystanderTable.table_name, cols: ['id'] });

      const reloaded = await attacker.load({ source_tool: 'load_a', rows: [{ id: 1 }] });
      await attacker.process({ table_name: reloaded.table_name, cols: ['id'] });
      const refused = await attacker
        .query({ table_name: reloaded.table_name, sql: BOMB })
        .then(() => null)
        .catch((error: unknown) => (isScratchDbError(error) ? error : null));

      expect(refused?.reason).toBe('timeout');
      expect(refused?.message).toContain('no further query will be run');
      // Still two: the third bomb never reached a runner.
      expect(xray.ofType('etl.worker_terminated')).toHaveLength(2);
      expect(await bystander.listTables()).toHaveLength(1);
    },
    QUERY_TIMEOUT_MS * 4 + TEARDOWN_SLACK_MS + 20_000,
  );

  it(
    'shutdown() frees every runner well inside the SIGTERM budget (invariant 12)',
    async () => {
      const { etl, scratch, table } = await ready('grt_bomb0005');
      const bomb = scratch.query({ table_name: table, sql: BOMB, timeout_ms: 60_000 });
      bomb.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const startedAt = Date.now();
      await etl.shutdown();
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(etl.stats().liveRunners).toBe(0);
      await expect(bomb).rejects.toThrow();
    },
    30_000,
  );
});
