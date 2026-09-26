/**
 * The worker half of scripts/smoke-worker-sqlite.mjs (assumptions A-18 and A-39).
 *
 * Runs inside a `worker_threads` worker. Two modes:
 *   basic - load better-sqlite3, open a :memory: database, create a table, query it.
 *   bomb  - run an unbounded WITH RECURSIVE so the parent can try to stop it on a timeout.
 *
 * This is the shape src/etl uses (ADR-9): model-authored SQL never runs on the main event loop.
 */
import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

const port = parentPort;
if (!port) throw new Error('worker-sqlite-task.mjs must be started as a worker_threads worker');

const database = new Database(':memory:');

if (workerData.mode === 'basic') {
  database.exec('CREATE TABLE transactions (id TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL)');
  const insert = database.prepare('INSERT INTO transactions (id, amount_cents) VALUES (?, ?)');
  const insertMany = database.transaction((rows) => {
    for (const row of rows) insert.run(row.id, row.amount_cents);
  });
  // Decision D-1: amounts are USD cents; 1000 refers to 1000 cents or $10.00.
  insertMany([
    { id: 'txn_1', amount_cents: 1000 },
    { id: 'txn_2', amount_cents: 2550 },
    { id: 'txn_3', amount_cents: -400 },
  ]);

  const statement = database.prepare(
    'SELECT count(*) AS row_count, sum(amount_cents) AS total_cents FROM transactions',
  );
  port.postMessage({
    ok: true,
    sqlite_version: database.prepare('SELECT sqlite_version() AS v').get().v,
    statement_readonly: statement.readonly,
    result: statement.get(),
  });
  database.close();
} else if (workerData.mode === 'bomb') {
  // PRAGMA query_only is the read-only guard src/etl sets on every scratch database.
  database.pragma('query_only = 1');
  port.postMessage({ started: true });
  // Unbounded recursive CTE with an aggregate on top: SQLite never yields a row and never
  // returns to JavaScript, so only a cancellation mechanism can stop it (assumption A-39).
  const rows = database
    .prepare(
      'WITH RECURSIVE counter(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM counter) ' +
        'SELECT count(*) AS n FROM counter',
    )
    .get();
  port.postMessage({ finished: true, rows });
} else if (workerData.mode === 'bomb-iterate') {
  database.pragma('query_only = 1');
  port.postMessage({ started: true });
  // The same unbounded recursion, but consumed row by row. Every row hands control back to
  // JavaScript, which is the only place V8 can act on a termination request.
  let rowCount = 0;
  const statement = database.prepare(
    'WITH RECURSIVE counter(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM counter) SELECT x FROM counter',
  );
  const iterator = statement.iterate();
  while (!iterator.next().done) rowCount += 1;
  port.postMessage({ finished: true, rows: { n: rowCount } });
} else {
  throw new Error(`unknown mode: ${String(workerData.mode)}`);
}
