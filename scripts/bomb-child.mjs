#!/usr/bin/env node
/**
 * Child process used by scripts/smoke-worker-sqlite.mjs to measure the documented fallback of
 * assumption A-39: an out-of-process SQL runner that the parent can SIGKILL.
 *
 * It runs the same unbounded recursive CTE on its own main thread and prints one JSON line when
 * the query has started.
 */
import process from 'node:process';

import Database from 'better-sqlite3';

const database = new Database(':memory:');
database.pragma('query_only = 1');
process.stdout.write(`${JSON.stringify({ event: 'query_started', pid: process.pid })}\n`);
database
  .prepare(
    'WITH RECURSIVE counter(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM counter) ' +
      'SELECT count(*) AS n FROM counter',
  )
  .get();
process.stdout.write(`${JSON.stringify({ event: 'query_finished' })}\n`);
