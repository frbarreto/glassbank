/**
 * Process entry point (block: app).
 *
 * Binds 0.0.0.0:$PORT (CLAUDE.md invariant 12), and shuts down on SIGTERM in well under the
 * 10 second budget Cloud Run allows before it kills the container.
 *
 * This is the only place blocks are wired together (docs/REPO_LAYOUT.md section 3): `auth` and
 * `mcp` are constructed here and injected into `createApp`, which owns the mount order. Neither
 * block may import `src/config`, so each declares a narrow structural subset of `AppConfig`
 * (`AuthConfig`, `McpConfig`) that the validated configuration satisfies.
 */
import type { Socket } from 'node:net';

import { newBootId, readPackageVersion } from './app.js';
import { createGlassBank } from './composition.js';
import { ConfigError, loadConfig } from './config/index.js';

/** Hard ceiling for a graceful shutdown; Cloud Run kills the container at 10 s. */
const SHUTDOWN_TIMEOUT_MS = 9_000;

function main(): void {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const bootId = newBootId();
  const version = readPackageVersion();

  // --- block wiring ---------------------------------------------------------------------------
  // Every block, in the one order the dependencies allow. `src/composition.ts` is the whole graph;
  // this file owns the socket, the signals and nothing else (docs/REPO_LAYOUT.md section 3).
  const glassBank = createGlassBank(config, {
    bootId,
    version,
    gitSha: process.env.GIT_SHA ?? null,
  });
  const app = glassBank.app;

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(
      JSON.stringify({
        message: 'glass-bank listening',
        boot_id: bootId,
        version,
        port: config.port,
        node_env: config.nodeEnv,
        origin_policy: config.originPolicy,
        feature_flags: config.featureFlags,
        public_base_url: config.publicBaseUrl,
        // `npm run e2e` and infra/smoke.sh wait for this key, so it stays on the first line.
        event: 'server.started',
      }),
    );
    if (config.usingDevelopmentSigningKey) {
      console.warn(
        'OAUTH_SIGNING_KEY is the insecure development default; do not use it in the cloud.',
      );
    }
  });

  // Node's receive-side defaults are kept (headersTimeout 60 s, requestTimeout 300 s,
  // keepAliveTimeout 5 s). None of them can terminate a long-running SSE *response* - they bound
  // only the time to receive request headers, to receive a whole request, and idle keep-alive
  // sockets between responses - so the previous `= 0` on all three bought nothing and let a
  // client hold a socket open forever with incomplete headers. On a single pinned instance
  // (invariant 1) at --concurrency=250 that is a cheap outage.
  //
  // Measured on this Node (23.10.0, darwin/arm64): the defaults do NOT reap such a socket - a
  // connection that sends a partial header block, or nothing at all, survives past 130 s with
  // `headersTimeout=60000`, and still survives with `headersTimeout=3000` and a 1 s
  // `connectionsCheckingInterval`. The only built-in that does reap it is `server.timeout`, and
  // that is a *socket inactivity* timeout: process-wide it would also kill an idle SSE stream
  // between heartbeats and a long ETL request that writes nothing for minutes. So the header
  // phase gets its own guard, armed per connection and disarmed the moment Node hands us a
  // request with complete headers. A response, however long it runs, is never touched.
  const HEADER_PHASE_TIMEOUT_MS = 60_000;
  const headerGuards = new WeakMap<Socket, NodeJS.Timeout>();

  server.on('connection', (socket: Socket) => {
    const guard = setTimeout(() => socket.destroy(), HEADER_PHASE_TIMEOUT_MS);
    guard.unref();
    headerGuards.set(socket, guard);
    socket.once('close', () => {
      clearTimeout(guard);
      headerGuards.delete(socket);
    });
  });

  server.on('request', (request) => {
    // `request` is emitted once the headers are complete: the connection has proved itself.
    const socket = request.socket as Socket;
    const guard = headerGuards.get(socket);
    if (guard !== undefined) {
      clearTimeout(guard);
      headerGuards.delete(socket);
    }
  });

  let shuttingDown = false;
  const shutdown = (reason: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ message: 'shutting down', signal: reason, boot_id: bootId }));

    // --- SIGTERM HOOK ---------------------------------------------------------------------
    // `mcp` closes its sessions and cancels in-flight calls, `xray` flushes those events and
    // closes the log, `etl` SIGKILLs its SQL runners and `auth` releases its SQLite handle. The
    // first two are synchronous, so they are done before the socket starts closing; the promise
    // only covers `etl`. Any failure is logged and never blocks the exit (invariant 12).
    void glassBank.shutdown(reason === 'SIGINT' ? 'sigint' : 'sigterm').catch((error: unknown) => {
      console.error(
        `error while shutting the blocks down: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    const forced = setTimeout(() => {
      // A socket still mid-request keeps `server.close()` from finishing. Cut every remaining
      // connection first: `close()` then completes and we exit 0 through its callback instead of
      // falling through to `exit(1)` (invariant 12's 10 s budget).
      console.error('graceful shutdown timed out; closing all remaining connections');
      server.closeAllConnections();
      const hardStop = setTimeout(() => {
        console.error('connections did not close; exiting');
        process.exit(1);
      }, 500);
      hardStop.unref();
    }, SHUTDOWN_TIMEOUT_MS);
    forced.unref();

    server.close((error) => {
      clearTimeout(forced);
      if (error) {
        console.error(`error while closing the server: ${error.message}`);
        process.exit(1);
      }
      process.exit(exitCode);
    });
    // Express 5 runs on Node >= 18: end idle keep-alive sockets so close() can finish quickly.
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Node 23 defaults to `--unhandled-rejections=throw`, so a promise nobody awaited takes the
  // whole process down - and on a `--max-instances=1` service that is a total outage that also
  // destroys every in-memory grant and session. Express handlers now forward their rejections to
  // `next(error)`, so anything that still reaches here is a bug: log it and keep serving.
  process.on('unhandledRejection', (reason: unknown) => {
    console.error(
      JSON.stringify({
        message: 'unhandled promise rejection',
        boot_id: bootId,
        error: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : null,
      }),
    );
  });

  // An uncaught exception leaves the process in an unknown state, so this one does exit - but
  // through the graceful path, so in-flight responses finish and Cloud Run sees a clean close.
  process.on('uncaughtException', (error: Error) => {
    console.error(
      JSON.stringify({
        message: 'uncaught exception',
        boot_id: bootId,
        error: error.message,
        stack: error.stack ?? null,
      }),
    );
    shutdown('uncaughtException', 1);
  });
}

main();
