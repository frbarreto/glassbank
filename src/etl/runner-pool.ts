/**
 * The pool of out-of-process SQL runners (block: etl, ADR-9 as amended).
 *
 * Why a process and not a `worker_threads` worker: measured at T0.1 and reproduced at T0.5,
 * `worker.terminate()` does not free a thread blocked inside better-sqlite3 on a statement that
 * never yields a row (`SELECT count(*)` over an unbounded `WITH RECURSIVE`), and the wedged
 * thread also stops the host process from exiting, which would break CLAUDE.md invariant 12's
 * 10 s SIGTERM budget. `Statement.iterate()` bounds only the statements that do yield rows, so it
 * is a useful optimisation but not a guard. `SIGKILL` on a child process frees it in 1-2 ms for
 * *any* statement, which is the property `QUERY_TIMEOUT_MS` needs. See docs/ASSUMPTIONS.md A-39
 * (amended) and `node scripts/smoke-worker-sqlite.mjs`.
 *
 * A runner hosts several grants' `:memory:` databases so the process count stays bounded by
 * `ETL_WORKER_POOL_SIZE`; grants are assigned to an empty runner first, so up to `poolSize`
 * concurrent grants never share one and a kill costs only the offending grant. Beyond that the
 * kill is collateral: every grant on the killed runner loses its tables and is told to reload,
 * which is what `etl.worker_terminated {tables_lost}` reports.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ScratchDbError, type ScratchDbFailureReason } from '../contracts/index.js';

import type { RunnerRequestBody, RunnerResponse } from './protocol.js';

/** Resolved once: `src/etl/sql-runner.ts` under tsx, `dist/etl/sql-runner.js` in the container. */
function resolveRunnerEntry(): { readonly path: string; readonly execArgv: string[] } {
  const isTypeScript = import.meta.url.endsWith('.ts');
  const url = new URL(isTypeScript ? './sql-runner.ts' : './sql-runner.js', import.meta.url);
  return {
    path: fileURLToPath(url),
    // The compiled runner needs no loader; the TypeScript source is only forked in dev and tests,
    // where tsx is a dev dependency of this repository.
    execArgv: isTypeScript ? ['--import', 'tsx'] : [],
  };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly killOnTimeout: boolean;
  readonly startedAt: number;
}

export interface Runner {
  readonly index: number;
  child: ChildProcess | null;
  ready: Promise<void> | null;
  /** Rejects the `ready` promise when the runner is killed before it ever answered. */
  abortReady: ((error: unknown) => void) | null;
  /** Database keys (grant ids) whose `:memory:` database lives in this runner. */
  readonly databases: Set<string>;
  readonly pending: Map<number, PendingRequest>;
  stderr: string;
}

export interface SendOptions {
  readonly timeoutMs: number;
  /**
   * True for model-authored SQL: on expiry the runner is `SIGKILL`ed, because nothing else stops
   * a statement that is inside native SQLite.
   */
  readonly killOnTimeout: boolean;
}

/** Why a runner died, as reported to the manager. */
export type RunnerLossCause = 'timeout' | 'crash' | 'shutdown';

export interface RunnerPoolDeps {
  readonly size: number;
  /** Called after a runner died with the database keys it was hosting. */
  readonly onLoss: (
    lost: readonly string[],
    cause: RunnerLossCause,
    context: { readonly db: string | null; readonly durationMs: number },
  ) => void;
  /** Test hook: fork this file instead of the shipped runner. */
  readonly runnerEntry?: { readonly path: string; readonly execArgv: string[] };
  /** How long a runner may take to load better-sqlite3 and answer `ready`. */
  readonly startupTimeoutMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 4000;

export interface RunnerPool {
  /** The runner hosting `db`, creating the assignment (and the process) on first use. */
  acquire(db: string): Runner;
  /** The runner already hosting `db`, or `null`. Never spawns anything. */
  assigned(db: string): Runner | null;
  /** Forgets an assignment; the caller has already closed the database. */
  release(db: string): void;
  send(runner: Runner, request: RunnerRequestBody, options: SendOptions): Promise<unknown>;
  kill(runner: Runner, cause: RunnerLossCause, context?: { db?: string | null }): void;
  shutdown(): void;
  /** Diagnostics for `docs/blocks/etl.md` and the tests. */
  stats(): { readonly runners: number; readonly live: number; readonly databases: number };
}

export function createRunnerPool(deps: RunnerPoolDeps): RunnerPool {
  const entry = deps.runnerEntry ?? resolveRunnerEntry();
  const startupTimeoutMs = deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const runners: Runner[] = Array.from({ length: Math.max(1, deps.size) }, (_unused, index) => ({
    index,
    child: null,
    ready: null,
    abortReady: null,
    databases: new Set<string>(),
    pending: new Map<number, PendingRequest>(),
    stderr: '',
  }));
  const assignment = new Map<string, Runner>();
  let nextRequestId = 1;
  let shuttingDown = false;

  function rejectPending(runner: Runner, cause: RunnerLossCause, timedOutId: number | null): void {
    for (const [id, pending] of runner.pending) {
      clearTimeout(pending.timer);
      const reason: ScratchDbFailureReason =
        id === timedOutId && cause === 'timeout' ? 'timeout' : 'worker_crashed';
      const message =
        reason === 'timeout'
          ? 'the query was stopped because it exceeded the time budget'
          : `the scratch database was torn down while the operation was running (${cause})`;
      pending.reject(new ScratchDbError(reason, message));
    }
    runner.pending.clear();
  }

  function detach(runner: Runner): readonly string[] {
    const lost = [...runner.databases];
    runner.databases.clear();
    for (const db of lost) assignment.delete(db);
    runner.child = null;
    runner.ready = null;
    return lost;
  }

  function kill(
    runner: Runner,
    cause: RunnerLossCause,
    context: { db?: string | null; timedOutId?: number | null; durationMs?: number } = {},
  ): void {
    const child = runner.child;
    const abortReady = runner.abortReady;
    const lost = detach(runner);
    rejectPending(runner, cause, context.timedOutId ?? null);
    // A `send` may be parked on `ready`; without this it would wait forever.
    abortReady?.(
      new ScratchDbError(
        cause === 'timeout' ? 'timeout' : 'worker_crashed',
        `the SQL runner was stopped while starting up (${cause})`,
      ),
    );
    if (child) {
      child.removeAllListeners('message');
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone; nothing to do.
      }
    }
    if (lost.length > 0 && cause !== 'shutdown') {
      deps.onLoss(lost, cause, { db: context.db ?? null, durationMs: context.durationMs ?? 0 });
    }
  }

  function spawn(runner: Runner): void {
    const child = fork(entry.path, [], {
      execArgv: entry.execArgv,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    runner.child = child;
    runner.stderr = '';

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      runner.stderr = (runner.stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    runner.ready = new Promise<void>((resolve, reject) => {
      runner.abortReady = reject;
      const timer = setTimeout(() => {
        reject(
          new ScratchDbError(
            'worker_crashed',
            `the SQL runner did not start within ${startupTimeoutMs} ms`,
          ),
        );
      }, startupTimeoutMs);
      const onMessage = (raw: unknown): void => {
        const response = raw as RunnerResponse;
        if (response.ok === true && 'ready' in response) {
          clearTimeout(timer);
          child.off('message', onMessage);
          resolve();
        }
      };
      child.on('message', onMessage);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new ScratchDbError('worker_crashed', error.message, { cause: error }));
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new ScratchDbError('worker_crashed', 'the SQL runner exited during startup'));
      });
    });
    // The rejection is delivered through `send`; nothing else awaits this promise.
    runner.ready.catch(() => undefined);

    child.on('message', (raw: unknown) => {
      const response = raw as RunnerResponse;
      if (response.ok === true && 'ready' in response) return;
      const pending = runner.pending.get(response.id);
      if (!pending) return;
      runner.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new ScratchDbError(response.reason, response.message));
      }
    });

    child.on('exit', () => {
      if (runner.child !== child) return; // Already replaced by `kill`.
      const abortReady = runner.abortReady;
      const lost = detach(runner);
      rejectPending(runner, 'crash', null);
      abortReady?.(new ScratchDbError('worker_crashed', 'the SQL runner exited unexpectedly'));
      if (lost.length > 0 && !shuttingDown) {
        deps.onLoss(lost, 'crash', { db: null, durationMs: 0 });
      }
    });

    child.on('error', () => {
      // `exit` follows; the pending requests are rejected there.
    });
  }

  function ensureAlive(runner: Runner): void {
    if (!runner.child || runner.child.killed || runner.child.exitCode !== null) spawn(runner);
  }

  function acquire(db: string): Runner {
    const existing = assignment.get(db);
    if (existing) {
      ensureAlive(existing);
      existing.databases.add(db);
      assignment.set(db, existing);
      return existing;
    }
    // Prefer an idle runner so that, up to the pool size, one grant's kill costs nobody else.
    let chosen = runners[0] as Runner;
    for (const runner of runners) {
      if (runner.databases.size < chosen.databases.size) chosen = runner;
      if (chosen.databases.size === 0) break;
    }
    ensureAlive(chosen);
    chosen.databases.add(db);
    assignment.set(db, chosen);
    return chosen;
  }

  function release(db: string): void {
    const runner = assignment.get(db);
    if (!runner) return;
    runner.databases.delete(db);
    assignment.delete(db);
  }

  async function send(
    runner: Runner,
    request: RunnerRequestBody,
    options: SendOptions,
  ): Promise<unknown> {
    ensureAlive(runner);
    const ready = runner.ready;
    if (ready) await ready;
    const child = runner.child;
    if (!child || !child.connected) {
      throw new ScratchDbError('worker_crashed', 'the SQL runner is not available');
    }

    const id = nextRequestId;
    nextRequestId += 1;
    const startedAt = Date.now();

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const durationMs = Date.now() - startedAt;
        if (options.killOnTimeout) {
          // The only mechanism that bounds a statement inside native SQLite (A-39 amended).
          kill(runner, 'timeout', { db: request.db, timedOutId: id, durationMs });
        } else {
          runner.pending.delete(id);
          reject(
            new ScratchDbError(
              'timeout',
              `the operation did not finish within ${options.timeoutMs} ms`,
              { duration_ms: durationMs },
            ),
          );
        }
      }, options.timeoutMs);

      runner.pending.set(id, {
        resolve,
        reject,
        timer,
        killOnTimeout: options.killOnTimeout,
        startedAt,
      });
      // `child.send()` returns FALSE for backpressure, not for failure: measured on Node 23.10,
      // any payload over roughly 150 KB returns false and is still delivered in full. A full year
      // of `load_transactions` is ~0.7 MB of rows, so treating false as fatal failed every large
      // load deterministically while the runner stored the rows anyway - a ghost table the parent
      // could neither see nor evict. Only the completion callback reports a real failure.
      child.send({ ...request, id }, (error) => {
        if (!error) return;
        const stillPending = runner.pending.get(id);
        if (!stillPending) return; // Already settled by the response, a timeout or a kill.
        runner.pending.delete(id);
        clearTimeout(stillPending.timer);
        reject(
          new ScratchDbError('worker_crashed', `the SQL runner could not be reached: ${error.message}`, {
            cause: error,
          }),
        );
      });
    });
  }

  function shutdown(): void {
    shuttingDown = true;
    for (const runner of runners) {
      if (runner.child) kill(runner, 'shutdown');
    }
    assignment.clear();
  }

  return {
    acquire,
    assigned: (db) => assignment.get(db) ?? null,
    release,
    send,
    kill: (runner, cause, context) => kill(runner, cause, context),
    shutdown,
    stats: () => ({
      runners: runners.length,
      live: runners.filter((runner) => runner.child !== null).length,
      databases: assignment.size,
    }),
  };
}
