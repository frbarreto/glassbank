#!/usr/bin/env node
/**
 * The ADR-9 / A-39 mechanism smoke test.
 *
 * History: this script was written at T0.1 to validate assumption A-39 ("`worker.terminate()`
 * reliably frees a worker stuck in a long statement"). It measured the opposite and exited 1 on
 * purpose for the whole of Phase 0, because it was testing a mechanism the code had not chosen
 * yet. L2 has now chosen: **an out-of-process SQL runner the parent kills with `SIGKILL`**, which
 * is what `src/etl/runner-pool.ts` ships. This script asserts that mechanism, and keeps the
 * measurements that ruled the other two out, so a future dependency bump cannot quietly
 * invalidate the decision.
 *
 * Six checks, all of which must pass (exit 0):
 *   1  better-sqlite3 loads and runs a :memory: database off the main thread            (A-18)
 *   2  the main event loop keeps ticking while SQLite burns CPU elsewhere               (ADR-9)
 *   3  `worker.terminate()` STILL does not bound native SQLite - the A-39 amendment holds
 *   4  `worker.terminate()` does free a worker that yields rows, which is the boundary  (A-39)
 *   5  `SIGKILL` frees an out-of-process runner mid-recursion - the shipped mechanism   (ADR-9)
 *   6  the shipped `src/etl` guard bounds a WITH RECURSIVE bomb inside QUERY_TIMEOUT_MS while
 *      its own event loop keeps answering, then serves the next request                 (L2)
 *
 * Check 3 runs in a child process on purpose: a worker thread blocked in a synchronous native
 * call can keep its whole process from exiting, and this script must still be able to report.
 *
 * Run: `node scripts/smoke-worker-sqlite.mjs`  (also `npm run smoke:worker-sqlite`)
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./worker-sqlite-task.mjs', import.meta.url);
const TERMINATE_PROBE = fileURLToPath(new URL('./probe-worker-terminate.mjs', import.meta.url));
const BOMB_CHILD = fileURLToPath(new URL('./bomb-child.mjs', import.meta.url));
const ETL_PROBE = fileURLToPath(new URL('./probe-etl-timeout.mjs', import.meta.url));

/** How long the hostile query is allowed to burn before cancellation is attempted. */
const BURN_MS = 400;
/** A cancellation mechanism must free the thread or process well inside this. */
const CANCEL_BUDGET_MS = 2000;
/** How long the basic check may take, including native module load. */
const BASIC_BUDGET_MS = 15_000;
/** `QUERY_TIMEOUT_MS` for check 6; the shipped default is 2000, shortened here to keep it quick. */
const ETL_TIMEOUT_MS = 600;
/** Teardown slack on top of `ETL_TIMEOUT_MS`: SIGKILL was measured at 1-2 ms. */
const ETL_SLACK_MS = 2000;

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  return ok;
}

/** Reads newline-delimited JSON from a stream into a growing array. */
function collectJsonLines(stream, sink) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          sink.push(JSON.parse(line));
        } catch {
          sink.push({ event: 'unparsed', line });
        }
      }
      index = buffer.indexOf('\n');
    }
  });
}

/** Check 1: better-sqlite3 loads and runs a :memory: database off the main thread (A-18). */
async function checkOffMainThreadSqlite() {
  const startedAt = performance.now();
  const worker = new Worker(WORKER_URL, { workerData: { mode: 'basic' } });

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ error: `no result within ${BASIC_BUDGET_MS} ms` }),
      BASIC_BUDGET_MS,
    );
    worker.once('message', (message) => {
      clearTimeout(timer);
      resolve({ message });
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.stack ?? String(error) });
    });
  });
  await worker.terminate();
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (outcome.error) {
    return record('better-sqlite3 runs off the main thread (A-18)', false, outcome.error);
  }
  const { sqlite_version: sqliteVersion, result, statement_readonly: readonly } = outcome.message;
  if (!result || result.row_count !== 3 || result.total_cents !== 3150) {
    return record(
      'better-sqlite3 runs off the main thread (A-18)',
      false,
      `unexpected result ${JSON.stringify(result)}`,
    );
  }
  return record(
    'better-sqlite3 runs off the main thread (A-18)',
    true,
    `sqlite ${sqliteVersion}, ${result.row_count} rows summing ${result.total_cents} cents, ` +
      `Statement.readonly=${readonly}, ${elapsedMs} ms including native module load`,
  );
}

/** Runs the terminate probe in a child process and SIGKILLs it if it cannot exit. */
async function runTerminateProbe(mode) {
  const child = spawn(
    process.execPath,
    [TERMINATE_PROBE, String(BURN_MS), String(CANCEL_BUDGET_MS), mode],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const events = [];
  collectJsonLines(child.stdout, events);

  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const hardDeadlineMs = BURN_MS + CANCEL_BUDGET_MS + 3000;
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('hung'), hardDeadlineMs)),
  ]);

  let processHung = false;
  if (outcome === 'hung') {
    processHung = true;
    child.kill('SIGKILL');
    await exited;
  }
  return { events, processHung };
}

/**
 * Checks 2 and 3: event-loop responsiveness, then the A-39 amendment itself.
 *
 * Check 3 passes when `terminate()` FAILS to free the worker, because that is the measurement L2
 * built on. If it ever starts passing, better-sqlite3 has gained an interruptible path and ADR-9
 * is worth revisiting - so the check turns red to say so rather than silently drifting.
 */
async function checkTerminateAmendment() {
  const { events, processHung } = await runTerminateProbe('bomb');
  const heartbeat = events.find((event) => event.event === 'heartbeat');
  const terminate = events.find((event) => event.event === 'terminate_result');

  const loopOk = record(
    'main event loop stays free while SQLite burns CPU elsewhere (ADR-9)',
    Boolean(heartbeat) && heartbeat.ticks >= 5,
    heartbeat
      ? `${heartbeat.ticks} timer ticks during a ${heartbeat.burn_ms} ms hostile query`
      : 'the probe never reported a heartbeat',
  );

  let amendmentOk;
  if (!terminate) {
    amendmentOk = record(
      'worker.terminate() still does not bound native SQLite (A-39 amended)',
      false,
      'the probe never reported a result',
    );
  } else if (terminate.finished_on_its_own) {
    amendmentOk = record(
      'worker.terminate() still does not bound native SQLite (A-39 amended)',
      false,
      'the recursive CTE finished on its own; the cancellation path was not exercised',
    );
  } else if (terminate.terminated) {
    amendmentOk = record(
      'worker.terminate() still does not bound native SQLite (A-39 amended)',
      false,
      `terminate() DID free the worker (exit ${terminate.exit_code}) after ` +
        `${terminate.elapsed_ms} ms. The A-39 amendment no longer holds on this build: ` +
        'better-sqlite3 has become interruptible and ADR-9 could drop the out-of-process runner. ' +
        'Re-measure before changing anything.',
    );
  } else {
    amendmentOk = record(
      'worker.terminate() still does not bound native SQLite (A-39 amended)',
      true,
      `terminate() did not free the worker within ${CANCEL_BUDGET_MS} ms` +
        (processHung ? ', and the process could not exit either (SIGKILL required)' : '') +
        ' - which is why src/etl runs SQL out of process',
    );
  }
  return loopOk && amendmentOk;
}

/**
 * Check 4: the same hostile recursion consumed with `.iterate()`. Every row hands control back to
 * JavaScript, so V8 can act on the termination request. This is the boundary of A-39, and the
 * reason `iterate()` is used inside the runner as an optimisation but never as the guard.
 */
async function checkTerminateWhileIterating() {
  const { events } = await runTerminateProbe('bomb-iterate');
  const terminate = events.find((event) => event.event === 'terminate_result');
  if (!terminate) {
    return record(
      'worker.terminate() frees a worker iterating rows - the A-39 boundary',
      false,
      'the probe never reported a result',
    );
  }
  return record(
    'worker.terminate() frees a worker iterating rows - the A-39 boundary',
    terminate.terminated && !terminate.finished_on_its_own,
    terminate.terminated
      ? `worker exited (code ${terminate.exit_code}) ${terminate.elapsed_ms} ms after terminate()`
      : `terminate() did not free the worker within ${CANCEL_BUDGET_MS} ms`,
  );
}

/** Check 5: the mechanism src/etl ships - an out-of-process runner the parent SIGKILLs. */
async function checkChildProcessKill() {
  const name = 'SIGKILL frees an out-of-process SQL runner - the shipped mechanism (ADR-9)';
  const child = spawn(process.execPath, [BOMB_CHILD], { stdio: ['ignore', 'pipe', 'inherit'] });
  const events = [];
  collectJsonLines(child.stdout, events);
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );

  const started = await Promise.race([
    new Promise((resolve) => {
      const poll = setInterval(() => {
        if (events.some((event) => event.event === 'query_started')) {
          clearInterval(poll);
          resolve(true);
        }
      }, 10);
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), BASIC_BUDGET_MS)),
  ]);
  if (!started) {
    child.kill('SIGKILL');
    return record(name, false, 'the child never started the query');
  }

  await new Promise((resolve) => setTimeout(resolve, BURN_MS));
  const startedAt = performance.now();
  child.kill('SIGKILL');
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('hung'), CANCEL_BUDGET_MS)),
  ]);
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (outcome === 'hung') {
    return record(name, false, `the child survived SIGKILL for more than ${CANCEL_BUDGET_MS} ms`);
  }
  if (events.some((event) => event.event === 'query_finished')) {
    return record(
      name,
      false,
      'the recursive CTE finished on its own; the cancellation path was not exercised',
    );
  }
  return record(
    name,
    true,
    `child killed mid WITH RECURSIVE in ${elapsedMs} ms (signal ${outcome.signal})`,
  );
}

/**
 * Check 6: the shipped guard, end to end. Runs `src/etl` itself (through tsx, because the block
 * is TypeScript) against the exact statement that defeats `worker.terminate()`.
 */
async function checkShippedEtlGuard() {
  const name = 'src/etl bounds a WITH RECURSIVE bomb within QUERY_TIMEOUT_MS (the shipped guard)';
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', ETL_PROBE, String(ETL_TIMEOUT_MS)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const events = [];
  collectJsonLines(child.stdout, events);
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('hung'), 60_000)),
  ]);
  if (outcome === 'hung') {
    child.kill('SIGKILL');
    return record(name, false, 'the probe did not finish within 60 s');
  }

  const bomb = events.find((event) => event.event === 'bomb_result');
  const recovered = events.find((event) => event.event === 'recovered');
  if (!bomb) {
    return record(name, false, `the probe reported no result (exit ${outcome})`);
  }
  const withinBudget = bomb.elapsed_ms <= ETL_TIMEOUT_MS + ETL_SLACK_MS;
  const emittedTimeout =
    bomb.emitted.includes('sql.rejected') && bomb.emitted.includes('etl.worker_terminated');
  const ok =
    bomb.reason === 'timeout' &&
    withinBudget &&
    bomb.ticks >= 5 &&
    bomb.max_gap_ms < 250 &&
    bomb.tables_after === 0 &&
    emittedTimeout &&
    Boolean(recovered);

  return record(
    name,
    ok,
    `reason=${bomb.reason} in ${bomb.elapsed_ms} ms (budget ${bomb.budget_ms} ms + ` +
      `${ETL_SLACK_MS} ms slack), ${bomb.ticks} host ticks with a ${bomb.max_gap_ms} ms worst gap, ` +
      `events ${bomb.emitted.join(' ')}, tables left ${bomb.tables_after}, ` +
      `next query ${recovered ? 'served' : 'FAILED'}`,
  );
}

await checkOffMainThreadSqlite();
await checkTerminateAmendment();
await checkTerminateWhileIterating();
await checkChildProcessKill();
await checkShippedEtlGuard();

const failed = results.filter((result) => !result.ok);
console.log(
  `\nnode ${process.version} on ${process.platform}/${process.arch}, better-sqlite3 ` +
    `${process.env.npm_package_dependencies_better_sqlite3 ?? '13.0.3'}: ` +
    `${results.length - failed.length}/${results.length} checks passed`,
);
if (failed.length > 0) {
  console.log(
    'The ADR-9 mechanism is NOT as documented. Failing checks:\n' +
      failed.map((result) => `  - ${result.name}`).join('\n') +
      '\n\nWhat the design rests on: `worker.terminate()` only stops a worker when SQLite returns\n' +
      'to JavaScript, so an aggregate over an unbounded recursion survives it and also stops the\n' +
      'process from exiting (CLAUDE.md invariant 12). `src/etl` therefore runs every model-authored\n' +
      'statement in a forked SQL runner and kills it with SIGKILL on QUERY_TIMEOUT_MS.\n' +
      'See docs/ASSUMPTIONS.md A-39 (amended), ADR-9 (amended) and docs/blocks/etl.md.',
  );
}
process.exit(failed.length === 0 ? 0 : 1);
