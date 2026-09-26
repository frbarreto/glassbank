/**
 * The `ScratchDb` contract as this block implements it: Ramp's load -> process -> query -> clear
 * protocol, the corrected error messages of docs/RAMP_REFERENCE.md section 2.1, every guard of
 * CLAUDE.md invariant 8 that needs a real SQLite behind it, and the `etl.*` / `sql.*` events.
 *
 * These tests fork real SQL runner processes, which is the point: the guard is only worth
 * anything if it holds against the database it actually ships with.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  isScratchDbError,
  rowCapMessage,
  type ScratchDbError,
  ETL_OPERATION_LIMIT_MESSAGE,
  TOO_MANY_TABLES_MESSAGE,
  type ScratchDb,
  type XrayCorrelation,
} from '../../contracts/index.js';
import { createEtl, type Etl, type EtlLimits } from '../index.js';
import { createRecordingEmitter, type RecordingEmitter } from './harness.js';

const GRANT = 'grt_scratch01';
const OTHER_GRANT = 'grt_scratch02';

const TRANSACTIONS: Record<string, unknown>[] = [
  {
    id: 'txn_1',
    date: '2026-01-04',
    merchant_name: 'Blue Bottle Coffee',
    amount_cents: -450,
    card: { last4: '4242' },
  },
  {
    id: 'txn_2',
    date: '2026-01-05',
    merchant_name: 'City Power and Light',
    amount_cents: -12_050,
    card: { last4: '4242' },
    decline_reason: 'insufficient_funds',
  },
  { id: 'txn_3', date: '2026-01-06', merchant_name: 'Payroll', amount_cents: 250_000 },
];

interface Harness {
  readonly etl: Etl;
  readonly xray: RecordingEmitter;
  readonly scratch: ScratchDb;
  readonly clock: { now: Date };
}

const harnesses: Etl[] = [];

function makeEtl(
  limits: Partial<EtlLimits> = {},
  options: { readonly grantId?: string } = {},
): Harness {
  const clock = { now: new Date('2026-09-08T12:00:00.000Z') };
  const xray = createRecordingEmitter(() => clock.now);
  let counter = 0;
  const etl = createEtl({
    xray,
    limits,
    now: () => clock.now,
    newTableSuffix: () => {
      counter += 1;
      return counter.toString(16).padStart(32, '0');
    },
    sweepIntervalMs: null,
  });
  harnesses.push(etl);
  return { etl, xray, clock, scratch: etl.forGrant(options.grantId ?? GRANT) };
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((etl) => etl.shutdown()));
});

async function expectRejection(promise: Promise<unknown>): Promise<ScratchDbError> {
  try {
    await promise;
  } catch (error) {
    if (isScratchDbError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to reject with a ScratchDbError');
}

describe('load -> process -> query -> clear (Ramp memory_db.py)', () => {
  it('names the table {tool}_{uuid} and advertises the union of keys across all rows', async () => {
    const { scratch, xray } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });

    expect(loaded.table_name).toMatch(/^load_transactions_[0-9a-f]{32}$/);
    expect(loaded.rows).toBe(3);
    // `decline_reason` only exists on row 2 and `card__last4` is nested: Ramp OSS defect 5.
    expect(loaded.columns_advertised).toEqual([
      'id',
      'date',
      'merchant_name',
      'amount_cents',
      'card__last4',
      'decline_reason',
    ]);

    const event = xray.lastOfType('etl.load');
    expect(event?.data).toMatchObject({
      table: loaded.table_name,
      rows: 3,
      source_tool: 'load_transactions',
    });
    expect(event?.grant_id).toBe(GRANT);
  });

  it('processes selected columns and answers a real aggregate query', async () => {
    const { scratch, xray } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    const processed = await scratch.process({
      table_name: loaded.table_name,
      cols: ['merchant_name', 'amount_cents', 'card__last4'],
    });
    expect(processed.rows).toBe(3);
    expect(processed.columns_selected).toEqual(['merchant_name', 'amount_cents', 'card__last4']);
    expect(xray.lastOfType('etl.processed')?.data.columns_selected).toEqual(
      processed.columns_selected,
    );

    const result = await scratch.query({
      table_name: loaded.table_name,
      sql: `SELECT sum(amount_cents) AS total_cents, count(*) AS n FROM "${loaded.table_name}"`,
    });
    // Decision D-1: integer USD cents. -450 + -12050 + 250000.
    expect(result.rows).toEqual([{ total_cents: 237_500, n: 3 }]);
    expect(result.columns).toEqual(['total_cents', 'n']);
    expect(result.capped).toBe(false);
    expect(xray.lastOfType('sql.query')?.data).toMatchObject({
      table: loaded.table_name,
      rows_returned: 1,
      capped: false,
    });
  });

  it('keeps a sparse numeric column numeric, so ORDER BY sorts by value', async () => {
    const { scratch } = makeEtl();
    const loaded = await scratch.load({
      source_tool: 'load_transactions',
      rows: [{ id: 'a', amount_cents: 900 }, { id: 'b' }, { id: 'c', amount_cents: 10 }],
    });
    await scratch.process({ table_name: loaded.table_name, cols: ['id', 'amount_cents'] });
    const result = await scratch.query({
      table_name: loaded.table_name,
      sql: `SELECT id FROM "${loaded.table_name}" WHERE amount_cents IS NOT NULL ORDER BY amount_cents DESC`,
    });
    expect(result.rows).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('stores a nested object under its __ column and a list as JSON text', async () => {
    const { scratch } = makeEtl();
    const loaded = await scratch.load({
      source_tool: 'load_payees',
      rows: [{ id: 'pay_1', rails: ['ach', 'wire'], bank: { name: 'First National' } }],
    });
    await scratch.process({ table_name: loaded.table_name, cols: ['rails', 'bank__name'] });
    const result = await scratch.query({
      table_name: loaded.table_name,
      sql: `SELECT rails, bank__name FROM "${loaded.table_name}"`,
    });
    expect(result.rows).toEqual([{ rails: '["ach","wire"]', bank__name: 'First National' }]);
  });

  it('lists the tables it holds with their advertised and selected columns', async () => {
    const { scratch } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_cards', rows: [{ id: 'card_1' }] });
    await scratch.process({ table_name: loaded.table_name, cols: ['id'] });
    const tables = await scratch.listTables();
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      table_name: loaded.table_name,
      source_tool: 'load_cards',
      rows: 1,
      processed: true,
      columns_advertised: ['id'],
      columns_selected: ['id'],
    });
    expect(tables[0]?.expires_at).toBe('2026-09-08T12:30:00.000Z');
  });

  it('clears a table and emits sql.table_cleared', async () => {
    const { scratch, xray } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_bills', rows: [{ id: 'bill_1' }] });
    await scratch.process({ table_name: loaded.table_name, cols: ['id'] });
    await scratch.clear(loaded.table_name);
    expect(await scratch.listTables()).toEqual([]);
    expect(xray.lastOfType('sql.table_cleared')?.data.table).toBe(loaded.table_name);
    const rejected = await expectRejection(
      scratch.query({ table_name: loaded.table_name, sql: 'SELECT 1' }),
    );
    expect(rejected.reason).toBe('unknown_table');
  });

  it('re-processing with different columns replaces the table (Ramp said "already processed")', async () => {
    const { scratch } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    await scratch.process({ table_name: loaded.table_name, cols: ['id'] });
    await scratch.process({ table_name: loaded.table_name, cols: ['id', 'merchant_name'] });
    const result = await scratch.query({
      table_name: loaded.table_name,
      sql: `SELECT merchant_name FROM "${loaded.table_name}" ORDER BY merchant_name LIMIT 1`,
    });
    expect(result.rows).toEqual([{ merchant_name: 'Blue Bottle Coffee' }]);
  });

  it('stores an empty payload without inventing columns', async () => {
    const { scratch } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: [] });
    expect(loaded).toMatchObject({ rows: 0, columns_advertised: [] });
  });
});

describe('the corrected error messages (Ramp OSS defect 10)', () => {
  it('process_data on an unknown table says so instead of "already processed"', async () => {
    const { scratch, xray } = makeEtl();
    const error = await expectRejection(
      scratch.process({ table_name: 'load_transactions_missing', cols: ['id'] }),
    );
    expect(error.reason).toBe('unknown_table');
    expect(error.message).toContain('no table named load_transactions_missing');
    expect(error.message).toContain('run a load_* tool first');
    expect(xray.lastOfType('sql.rejected')?.data.rejected_reason).toBe('unknown_table');
  });

  it('clear_table on an unknown name says so instead of "cleared"', async () => {
    const { scratch, xray } = makeEtl();
    const error = await expectRejection(scratch.clear('load_transactions_missing'));
    expect(error.reason).toBe('unknown_table');
    expect(error.message).toContain('no table named load_transactions_missing');
    expect(xray.lastOfType('sql.rejected')?.data.rejected_reason).toBe('unknown_table');
  });

  it('empty cols is an explicit error, not a SQL syntax error', async () => {
    const { scratch } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    const error = await expectRejection(scratch.process({ table_name: loaded.table_name, cols: [] }));
    expect(error.reason).toBe('unknown_column');
    expect(error.message).toContain('at least one column must be selected');
  });

  it('unknown cols are named instead of silently dropped', async () => {
    const { scratch } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    const error = await expectRejection(
      scratch.process({ table_name: loaded.table_name, cols: ['id', 'nope', 'also_nope'] }),
    );
    expect(error.reason).toBe('unknown_column');
    expect(error.message).toContain('nope, also_nope');
    expect(error.message).toContain('Available columns are: id, date');
  });

  it('execute_query on a table that was never processed explains what to do', async () => {
    const { scratch } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    const error = await expectRejection(
      scratch.query({ table_name: loaded.table_name, sql: 'SELECT 1' }),
    );
    expect(error.reason).toBe('unknown_table');
    expect(error.message).toContain('has not been processed yet');
  });
});

describe('the SQL guard against a live SQLite (CLAUDE.md invariant 8)', () => {
  async function ready(): Promise<Harness & { table: string }> {
    const harness = makeEtl();
    const loaded = await harness.scratch.load({
      source_tool: 'load_transactions',
      rows: TRANSACTIONS,
    });
    await harness.scratch.process({
      table_name: loaded.table_name,
      cols: ['id', 'merchant_name', 'amount_cents'],
    });
    return { ...harness, table: loaded.table_name };
  }

  it.each([
    ["ATTACH DATABASE '/tmp/glass-bank-escape.db' AS esc", 'denylist'],
    ['DETACH DATABASE esc', 'denylist'],
    ['PRAGMA query_only', 'denylist'],
    ['VACUUM', 'denylist'],
    ['UPDATE t SET amount_cents = 0', 'not_readonly'],
    ["INSERT INTO t (id) VALUES ('x')", 'not_readonly'],
    ['DROP TABLE t', 'not_readonly'],
    ['SELECT 1; SELECT 2', 'multi_statement'],
  ])('rejects %s with reason %s and emits sql.rejected', async (sql, reason) => {
    const { scratch, xray, table } = await ready();
    const error = await expectRejection(scratch.query({ table_name: table, sql }));
    expect(error.reason).toBe(reason);
    const event = xray.lastOfType('sql.rejected');
    expect(event?.data.rejected_reason).toBe(reason);
    expect(event?.data.sql).toBe(sql);
    expect(event?.data.table).toBe(table);
  });

  it('rejects a query against a table this grant never loaded', async () => {
    const { scratch } = await ready();
    const error = await expectRejection(
      scratch.query({ table_name: 'load_transactions_other', sql: 'SELECT 1' }),
    );
    expect(error.reason).toBe('unknown_table');
  });

  it('leaves PRAGMA query_only = 1 as the resting state of the scratch database', async () => {
    const { scratch, table } = await ready();
    // `pragma_query_only` is a read-only table-valued function, so it passes the token scan and
    // reports what the connection is actually set to after a load and a process both lifted the
    // pragma for their own trusted statements.
    const result = await scratch.query({
      table_name: table,
      sql: 'SELECT * FROM pragma_query_only',
    });
    expect(result.rows).toEqual([{ query_only: 1 }]);
  });

  it('one grant cannot read another grant s scratch table', async () => {
    const { etl, scratch, table } = await ready();
    const other = etl.forGrant(OTHER_GRANT);
    await other.load({ source_tool: 'load_cards', rows: [{ id: 'card_1' }] });
    expect((await other.listTables()).map((entry) => entry.table_name)).not.toContain(table);
    const error = await expectRejection(other.query({ table_name: table, sql: 'SELECT 1' }));
    expect(error.reason).toBe('unknown_table');
    // And the scratch database itself is separate: the table does not exist over there.
    const otherTables = await other.listTables();
    const otherTable = otherTables[0]?.table_name ?? '';
    await other.process({ table_name: otherTable, cols: ['id'] });
    const crossRead = await expectRejection(
      other.query({ table_name: otherTable, sql: `SELECT * FROM "${table}"` }),
    );
    expect(crossRead.reason).toBe('syntax_error');
    expect(crossRead.message).toContain('no such table');
    expect(scratch.grantId).toBe(GRANT);
  });
});

describe('the row cap (hosted Ramp: 100 rows)', () => {
  it('trims the result, reports capped and emits Ramp s "add filters and retry" wording', async () => {
    const { scratch, xray } = makeEtl({ maxQueryRows: 2 });
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    await scratch.process({ table_name: loaded.table_name, cols: ['id'] });
    const result = await scratch.query({
      table_name: loaded.table_name,
      sql: `SELECT id FROM "${loaded.table_name}" ORDER BY id`,
    });
    expect(result.rows_returned).toBe(2);
    expect(result.capped).toBe(true);
    const rejected = xray.ofType('sql.rejected').at(-1);
    expect(rejected?.data.rejected_reason).toBe('row_cap');
    expect(rejected?.data.error).toBe(rowCapMessage(2));
    expect(xray.lastOfType('sql.query')?.data.capped).toBe(true);
  });

  it('honours a per-call max_rows below the configured cap', async () => {
    const { scratch } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    await scratch.process({ table_name: loaded.table_name, cols: ['id'] });
    const result = await scratch.query({
      table_name: loaded.table_name,
      sql: `SELECT id FROM "${loaded.table_name}"`,
      max_rows: 1,
    });
    expect(result.rows_returned).toBe(1);
    expect(result.capped).toBe(true);
  });
});

describe('payloads that must not be refused or copied whole', () => {
  it('loads a full year of transactions in one message (child.send() backpressure is not a failure)', async () => {
    // `child.send()` returns FALSE above roughly 150 KB and delivers the message anyway. Treating
    // that as `worker_crashed` failed every real `load_transactions` over a long window while the
    // runner stored the rows regardless - a ghost table the parent could not evict. The e2e walk
    // loads only 90 days (~0.17 MB), which is why it never saw this.
    const { scratch, xray } = makeEtl();
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < 4000; index += 1) {
      rows.push({
        id: `txn_${index}`,
        date: '2026-01-04',
        merchant_name: `Merchant Number ${index} With A Long Neutral English Name`,
        description: `A transaction description padded out so the payload is realistic ${index}`,
        amount_cents: -index * 13,
        card: { last4: '4242' },
      });
    }
    const payloadBytes = JSON.stringify(rows).length;
    expect(payloadBytes).toBeGreaterThan(700_000);

    const loaded = await scratch.load({ source_tool: 'load_transactions', rows });
    expect(loaded.rows).toBe(4000);
    expect(xray.lastOfType('etl.load')?.data.rows).toBe(4000);

    // The table really is there on both sides, not a ghost the parent lost track of.
    await scratch.process({ table_name: loaded.table_name, cols: ['id', 'amount_cents'] });
    const result = await scratch.query({
      table_name: loaded.table_name,
      sql: `SELECT count(*) AS n FROM "${loaded.table_name}"`,
    });
    expect(result.rows).toEqual([{ n: 4000 }]);
    expect(await scratch.listTables()).toHaveLength(1);
  });

  it('truncates one huge cell instead of copying it across the IPC channel', async () => {
    // `SELECT hex(randomblob(50000000))` is ONE row, inside every row cap, and finishes inside
    // QUERY_TIMEOUT_MS. Only a per-cell ceiling stops a 95 MiB string reaching the parent.
    const { scratch } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    await scratch.process({ table_name: loaded.table_name, cols: ['id'] });

    const before = process.memoryUsage().rss;
    const result = await scratch.query({
      table_name: loaded.table_name,
      sql: `SELECT hex(randomblob(50000000)) AS b FROM "${loaded.table_name}" LIMIT 1`,
    });
    const after = process.memoryUsage().rss;

    expect(result.rows).toHaveLength(1);
    const cell = (result.rows[0] as Record<string, unknown>).b;
    expect(typeof cell).toBe('string');
    // 64,000 characters plus the marker, not 100,000,000.
    expect((cell as string).length).toBeLessThan(100_000);
    expect(cell as string).toContain('[cell truncated]');
    expect(result.capped).toBe(true);
    // The parent never allocated the cell, so its own footprint barely moves.
    expect(after - before).toBeLessThan(64 * 1024 * 1024);
  });

  it('stops a wide result at maxResultBytes without materialising the whole row', async () => {
    const { scratch } = makeEtl({ maxResultBytes: 20_000 });
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    await scratch.process({ table_name: loaded.table_name, cols: ['id'] });
    const result = await scratch.query({
      table_name: loaded.table_name,
      sql:
        `SELECT hex(randomblob(30000)) AS a, hex(randomblob(30000)) AS b, ` +
        `hex(randomblob(30000)) AS c FROM "${loaded.table_name}" LIMIT 1`,
    });
    expect(result.capped).toBe(true);
    const row = result.rows[0] as Record<string, unknown>;
    // The budget ran out inside the first row, so the later columns were never converted.
    expect(Object.keys(row).length).toBeLessThan(3);
  });
});

describe('caps and eviction', () => {
  it('refuses a load past the per-grant table cap with Ramp s hosted message', async () => {
    const { scratch, xray } = makeEtl({ maxTablesPerGrant: 2 });
    await scratch.load({ source_tool: 'load_a', rows: [{ id: 1 }] });
    await scratch.load({ source_tool: 'load_b', rows: [{ id: 1 }] });
    const error = await expectRejection(scratch.load({ source_tool: 'load_c', rows: [{ id: 1 }] }));
    expect(error.reason).toBe('grant_cap');
    expect(error.message).toBe(TOO_MANY_TABLES_MESSAGE);
    const limit = xray.lastOfType('etl.limit_reached');
    expect(limit?.data).toMatchObject({ limit: 'tables', current: 2, max: 2 });
    expect(limit?.data.message).toBe(TOO_MANY_TABLES_MESSAGE);
    expect(await scratch.listTables()).toHaveLength(2);
  });

  it('evicts the least recently used scratch database at the global cap', async () => {
    const { etl, xray } = makeEtl({ maxScratchDbs: 2 });
    const first = etl.forGrant('grt_lru0001');
    const second = etl.forGrant('grt_lru0002');
    await first.load({ source_tool: 'load_a', rows: [{ id: 1 }] });
    await second.load({ source_tool: 'load_b', rows: [{ id: 1 }] });
    expect(etl.stats().scratchDatabases).toBe(2);

    const third = etl.forGrant('grt_lru0003');
    await third.load({ source_tool: 'load_c', rows: [{ id: 1 }] });

    expect(etl.stats().scratchDatabases).toBe(2);
    expect(await first.listTables()).toEqual([]);
    expect(await second.listTables()).toHaveLength(1);
    expect(await third.listTables()).toHaveLength(1);

    const evicted = xray.ofType('etl.table_evicted').at(-1);
    expect(evicted?.data.reason).toBe('global_cap');
    expect(evicted?.grant_id).toBe('grt_lru0001');
    expect(xray.lastOfType('etl.limit_reached')?.data.limit).toBe('global_dbs');
  });

  it('drops the evicted grant s handle too, so the handle map stays bounded (invariant 14)', () => {
    const { etl } = makeEtl({ maxScratchDbs: 2 });
    const first = etl.forGrant('grt_lru0001');
    expect(etl.forGrant('grt_lru0001')).toBe(first); // cached while the grant is live

    return (async () => {
      await first.load({ source_tool: 'load_a', rows: [{ id: 1 }] });
      await etl.forGrant('grt_lru0002').load({ source_tool: 'load_b', rows: [{ id: 1 }] });
      await etl.forGrant('grt_lru0003').load({ source_tool: 'load_c', rows: [{ id: 1 }] });
      // `grt_lru0001` was evicted by the global cap, so its handle must be gone with it: a
      // cached handle here is one closure retained per grant id for the life of the process.
      expect(etl.forGrant('grt_lru0001')).not.toBe(first);
    })();
  });

  it('evicts a table once its TTL has passed and reports its age', async () => {
    const { etl, scratch, xray, clock } = makeEtl({ tableTtlMinutes: 30 });
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    await scratch.process({ table_name: loaded.table_name, cols: ['id'] });

    clock.now = new Date('2026-09-08T12:20:00.000Z');
    await etl.sweep();
    expect(await scratch.listTables()).toHaveLength(1);

    clock.now = new Date('2026-09-08T12:31:00.000Z');
    await etl.sweep();
    expect(await scratch.listTables()).toEqual([]);
    const evicted = xray.lastOfType('etl.table_evicted');
    expect(evicted?.data).toMatchObject({ table: loaded.table_name, reason: 'ttl', rows: 3 });
    expect(evicted?.data.age_ms).toBe(31 * 60_000);
  });

  it('drops an idle scratch database once it has held no table for a TTL', async () => {
    const { etl, scratch, clock } = makeEtl({ tableTtlMinutes: 30 });
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    await scratch.clear(loaded.table_name);
    expect(etl.stats().scratchDatabases).toBe(1);
    clock.now = new Date('2026-09-08T12:31:00.000Z');
    await etl.sweep();
    expect(etl.stats().scratchDatabases).toBe(0);
  });

  it('refuses a concurrent operation past the per-grant limit', async () => {
    const { scratch, xray } = makeEtl({ maxConcurrentEtlOps: 1 });
    const first = scratch.load({ source_tool: 'load_a', rows: TRANSACTIONS });
    const error = await expectRejection(scratch.load({ source_tool: 'load_b', rows: TRANSACTIONS }));
    expect(error.reason).toBe('ops_limit');
    expect(error.message).toBe(ETL_OPERATION_LIMIT_MESSAGE);
    expect(xray.lastOfType('etl.limit_reached')?.data).toMatchObject({
      limit: 'ops',
      current: 1,
      max: 1,
    });
    await first;
    // The slot is released again once the first operation finishes.
    await scratch.load({ source_tool: 'load_b', rows: TRANSACTIONS });
    expect(await scratch.listTables()).toHaveLength(2);
  });

  it('terminate() frees the grant s database and emits the eviction reason', async () => {
    const { etl, scratch, xray } = makeEtl();
    const loaded = await scratch.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    await scratch.terminate('global_cap');
    expect(etl.stats().scratchDatabases).toBe(0);
    expect(xray.lastOfType('etl.table_evicted')?.data).toMatchObject({
      table: loaded.table_name,
      reason: 'global_cap',
    });
  });
});

/**
 * Correlation is per call, never per handle.
 *
 * `src/composition.ts` builds `ToolContext.scratch` with `etl.forGrant(grant_id, correlation)` on
 * every single `tools/call`, while the handle behind it is created once and cached for the life
 * of the grant. `createHandle` used to capture the correlation of the call that happened to
 * create the handle, so every later `etl.*` and `sql.*` event of that grant was filed under the
 * *first* call's `request_id`: on real data a `sql.query` run by the fourth tool call carried the
 * second call's id. Nothing was lost, but the dashboard keys a call on `<xs>#<request_id>`
 * (`callKeyOf` in `public/catalogue.js`), so those events nested under the wrong call or under
 * none - a feature that does not emit its documented events is not finished (CLAUDE.md
 * invariant 13), and an event that lands on the wrong call is not emitted correctly.
 *
 * The fix makes `createHandle` read the correlation through a getter that `forGrant` refreshes,
 * which is what these tests pin down: the same cached handle, two calls, two correlations.
 */
describe('the correlation of the call in flight, not of the one that created the handle', () => {
  const CALL_ONE: XrayCorrelation = {
    xs: 'xs_corr0001',
    login_id: 'lgn_corr0001',
    persona_id: 'per_ava_stone',
    grant_id: OTHER_GRANT,
    request_id: 'rpc-1',
  };
  const CALL_TWO: XrayCorrelation = { ...CALL_ONE, request_id: 'rpc-2' };
  const CALL_THREE: XrayCorrelation = { ...CALL_ONE, request_id: 'rpc-3' };

  it('files a load under the call that loaded and a later query under the call that queried', async () => {
    const { etl, xray } = makeEtl();

    // Call one: the load and the process that a `load_*` tool performs.
    const first = etl.forGrant(OTHER_GRANT, CALL_ONE);
    const loaded = await first.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });
    await first.process({ table_name: loaded.table_name, cols: ['id', 'amount_cents'] });

    // Call two: a separate `execute_query` on the same grant, so the same cached handle.
    const second = etl.forGrant(OTHER_GRANT, CALL_TWO);
    expect(second).toBe(first);
    const result = await second.query({
      table_name: loaded.table_name,
      sql: `SELECT count(*) AS n FROM "${loaded.table_name}"`,
    });
    expect(result.rows).toEqual([{ n: 3 }]);

    expect(xray.lastOfType('etl.load')?.request_id).toBe('rpc-1');
    expect(xray.lastOfType('etl.processed')?.request_id).toBe('rpc-1');
    const query = xray.lastOfType('sql.query');
    expect(query?.request_id).toBe('rpc-2');
    // The one that used to be wrong, said out loud: this is not call one's event.
    expect(query?.request_id).not.toBe('rpc-1');
    // The rest of the correlation is unchanged, so the events stay in the same X-ray session.
    expect(query?.xs).toBe('xs_corr0001');
    expect(query?.login_id).toBe('lgn_corr0001');
    expect(query?.persona_id).toBe('per_ava_stone');
    expect(query?.grant_id).toBe(OTHER_GRANT);
  });

  it('follows the correlation on every later call, error events included', async () => {
    const { etl, xray } = makeEtl();

    const first = etl.forGrant(OTHER_GRANT, CALL_ONE);
    const loaded = await first.load({ source_tool: 'load_transactions', rows: TRANSACTIONS });

    const second = etl.forGrant(OTHER_GRANT, CALL_TWO);
    await second.process({ table_name: loaded.table_name, cols: ['id'] });

    // Call three: a query the guard of invariant 8 refuses. A rejection has to nest under the
    // call that caused it just as much as a success does - it is the event a user watching the
    // dashboard most wants to see next to the tool call that produced it.
    const third = etl.forGrant(OTHER_GRANT, CALL_THREE);
    const error = await expectRejection(
      third.query({ table_name: loaded.table_name, sql: 'PRAGMA query_only' }),
    );
    expect(error.reason).toBe('denylist');

    expect(xray.lastOfType('etl.load')?.request_id).toBe('rpc-1');
    expect(xray.lastOfType('etl.processed')?.request_id).toBe('rpc-2');
    expect(xray.lastOfType('sql.rejected')?.request_id).toBe('rpc-3');

    // Call four clears the table: the handle is now three calls old and still current.
    const fourth = etl.forGrant(OTHER_GRANT, { ...CALL_ONE, request_id: 'rpc-4' });
    await fourth.clear(loaded.table_name);
    expect(xray.lastOfType('sql.table_cleared')?.request_id).toBe('rpc-4');
  });
});
