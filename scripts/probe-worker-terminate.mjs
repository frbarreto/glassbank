#!/usr/bin/env node
/**
 * Child process used by scripts/smoke-worker-sqlite.mjs to measure `worker.terminate()` against a
 * worker stuck inside better-sqlite3 (assumption A-39).
 *
 * It runs in its own process because a worker thread blocked in a synchronous native call can also
 * block the *process* from exiting: the parent must be able to SIGKILL this probe and still report.
 * Communication is one JSON object per stdout line.
 */
import process from 'node:process';
import { Worker } from 'node:worker_threads';

const BURN_MS = Number(process.argv[2] ?? 400);
const TERMINATE_BUDGET_MS = Number(process.argv[3] ?? 2000);
/** 'bomb' never yields a row to JavaScript; 'bomb-iterate' yields one row at a time. */
const MODE = process.argv[4] ?? 'bomb';

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const worker = new Worker(new URL('./worker-sqlite-task.mjs', import.meta.url), {
  workerData: { mode: MODE },
});

let finishedOnItsOwn = false;
worker.on('message', (message) => {
  if (message?.finished) finishedOnItsOwn = true;
});

await new Promise((resolve) => {
  worker.once('message', (message) => {
    if (message?.started) resolve();
  });
});
emit({ event: 'worker_started' });

// While the worker burns CPU inside SQLite the main event loop must keep ticking: this is what
// keeps /token, /mcp and the SSE fan-out responsive during a hostile query.
let ticks = 0;
const heartbeat = setInterval(() => {
  ticks += 1;
}, 20);
await new Promise((resolve) => setTimeout(resolve, BURN_MS));
clearInterval(heartbeat);
emit({ event: 'heartbeat', ticks, burn_ms: BURN_MS });

const startedAt = performance.now();
let exitCode = null;
worker.once('exit', (code) => {
  exitCode = code;
});
// Deliberately not awaited: terminate()'s promise only settles once the thread actually stops.
void worker.terminate();

const deadline = Date.now() + TERMINATE_BUDGET_MS;
while (exitCode === null && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const elapsedMs = Math.round(performance.now() - startedAt);

emit({
  event: 'terminate_result',
  terminated: exitCode !== null,
  exit_code: exitCode,
  elapsed_ms: elapsedMs,
  finished_on_its_own: finishedOnItsOwn,
});

// If the thread is still stuck, a clean exit would hang here too: report that and leave. The parent
// SIGKILLs this process when it does not exit, and reports the hang.
emit({ event: 'exiting' });
process.exit(0);
