/**
 * Defence in depth: what the SQL runner itself refuses when the parent-side token scan is
 * bypassed entirely. These tests talk to `runner-pool.ts` directly, so every statement below
 * reaches `better-sqlite3` and is refused by `Statement.readonly`, `Statement.reader` or
 * `PRAGMA query_only = 1` - the second and third layers of CLAUDE.md invariant 8.
 *
 * They also record the measurement that makes the token deny-list the *primary* guard rather than a
 * belt-and-braces extra: `Statement.readonly` is `true` for ATTACH, DETACH and `PRAGMA`, and
 * `db.prepare('PRAGMA query_only = 0')` APPLIES the pragma at prepare time - so the deny-list has to
 * run before `prepare()`, which is why it runs inside the runner as well as in the parent.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isScratchDbError } from '../../contracts/index.js';
import { createRunnerPool, type RunnerPool } from '../runner-pool.js';

const DB = 'grt_runner001';
const TABLE = 'load_transactions_deadbeef';

const pools: RunnerPool[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const pool of pools.splice(0)) pool.shutdown();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function readyPool(): Promise<RunnerPool> {
  const pool = createRunnerPool({ size: 1, onLoss: () => undefined });
  pools.push(pool);
  const runner = pool.acquire(DB);
  const options = { timeoutMs: 20_000, killOnTimeout: false };
  await pool.send(runner, { op: 'open', db: DB }, options);
  await pool.send(
    runner,
    { op: 'store', db: DB, table: TABLE, rows: [{ id: 'txn_1', amount_cents: -450 }] },
    options,
  );
  await pool.send(
    runner,
    { op: 'process', db: DB, table: TABLE, cols: ['id', 'amount_cents'] },
    options,
  );
  return pool;
}

async function rawQuery(pool: RunnerPool, sql: string): Promise<unknown> {
  const runner = pool.acquire(DB);
  return pool.send(
    runner,
    { op: 'query', db: DB, sql, maxRows: 100, maxResultBytes: 1_000_000, softTimeoutMs: 15_000 },
    { timeoutMs: 20_000, killOnTimeout: false },
  );
}

async function reasonOf(pool: RunnerPool, sql: string): Promise<string> {
  try {
    await rawQuery(pool, sql);
  } catch (error) {
    if (!isScratchDbError(error)) throw error;
    return error.reason;
  }
  return 'accepted';
}

describe('the runner refuses what the token scan never saw', () => {
  it('refuses a write through Statement.readonly', async () => {
    const pool = await readyPool();
    expect(await reasonOf(pool, `UPDATE "${TABLE}" SET amount_cents = 0`)).toBe('not_readonly');
    expect(await reasonOf(pool, `INSERT INTO "${TABLE}" (id) VALUES ('txn_2')`)).toBe(
      'not_readonly',
    );
    expect(await reasonOf(pool, `DELETE FROM "${TABLE}"`)).toBe('not_readonly');
    expect(await reasonOf(pool, `DROP TABLE "${TABLE}"`)).toBe('not_readonly');
    expect(await reasonOf(pool, 'CREATE TABLE evil (a)')).toBe('not_readonly');
  });

  it('refuses ATTACH and writes no file: the deny-list runs on both sides of the channel', async () => {
    const pool = await readyPool();
    const directory = mkdtempSync(join(tmpdir(), 'glass-bank-runner-'));
    directories.push(directory);
    const escapeFile = join(directory, 'escape.db');

    expect(await reasonOf(pool, `ATTACH DATABASE '${escapeFile}' AS esc`)).toBe('denylist');
    expect(await reasonOf(pool, 'DETACH DATABASE esc')).toBe('denylist');
    expect(existsSync(escapeFile)).toBe(false);
  });

  it('never PREPARES a PRAGMA, because preparing one already applies it', async () => {
    const pool = await readyPool();
    // Measured on better-sqlite3 13.0.3: `db.prepare('PRAGMA query_only = 0')` sets the pragma
    // during prepare, before `Statement.readonly` (which is `true` for it) can be consulted.
    // Only refusing the statement before it reaches `prepare()` keeps the guard standing.
    expect(await reasonOf(pool, 'PRAGMA query_only = 0')).toBe('denylist');
    expect(await rawQuery(pool, 'SELECT * FROM pragma_query_only')).toMatchObject({
      rows: [{ query_only: 1 }],
    });
    expect(await reasonOf(pool, `UPDATE "${TABLE}" SET amount_cents = 0`)).toBe('not_readonly');
  });

  it('reports a syntax error as such instead of crashing the runner', async () => {
    const pool = await readyPool();
    expect(await reasonOf(pool, 'SELECT FROM WHERE')).toBe('syntax_error');
    expect(await reasonOf(pool, 'SELECT * FROM no_such_table')).toBe('syntax_error');
    // Still alive and answering.
    expect(await rawQuery(pool, `SELECT count(*) AS n FROM "${TABLE}"`)).toMatchObject({
      rows: [{ n: 1 }],
    });
  });

  it('refuses to touch a table that was never stored', async () => {
    const pool = await readyPool();
    const runner = pool.acquire(DB);
    await expect(
      pool.send(
        runner,
        { op: 'drop', db: DB, table: 'load_transactions_missing' },
        { timeoutMs: 20_000, killOnTimeout: false },
      ),
    ).rejects.toMatchObject({ reason: 'unknown_table' });
  });

  it('keeps identifiers inert: a table name full of SQL is just a name', async () => {
    const pool = createRunnerPool({ size: 1, onLoss: () => undefined });
    pools.push(pool);
    const runner = pool.acquire(DB);
    const options = { timeoutMs: 20_000, killOnTimeout: false };
    // `isValidTableName` refuses it before quoting ever has to save us.
    await expect(
      pool.send(
        runner,
        { op: 'store', db: DB, table: 'x" ; DROP TABLE y --', rows: [{ a: 1 }] },
        options,
      ),
    ).rejects.toMatchObject({ reason: 'unknown_table' });
  });
});
