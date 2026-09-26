/**
 * The `xray` block factory.
 *
 * `createXray(deps)` builds the whole server half of micro-app B and hands the composition root
 * three things:
 *
 *   - `emitter`  - the contract's `XrayEmitter`, injected into every other block. Fire-and-forget,
 *                  never throws, never blocks a producer (see `emitter.ts`).
 *   - `router`   - mounted at `/xray`: the pairing landing, the JSON read model and the SSE stream.
 *   - `pairing`  - the contract's `Pairing`, injected into `src/tools` so `xray_get_session_link`
 *                  can mint a login-bound code.
 *
 * On boot the block reopens the SQLite log at `XRAY_DB_PATH`, continues the event ids from
 * `max(id)` and the per-session `seq` from the restored rows (A-25), rebuilds the read model from
 * the tail of the log and emits `server.started` with the new `boot_id` - which is how the
 * dashboard draws a restart marker (A-15). `shutdown()` emits `server.stopping`, ends every open
 * stream and flushes inside the 10 s SIGTERM budget (invariant 12).
 */
import type { RequestHandler } from 'express';

import type { Pairing, XrayEmitter } from '../contracts/index.js';

import { createPipeline, type Pipeline } from './emitter.js';
import { createEventLog, type EventLog } from './log.js';
import { createPairing, type XrayPairing } from './pairing.js';
import { createReadModel, type ReadModel } from './read-model.js';
import { createRing, type Ring } from './ring.js';
import { buildXrayRouter } from './routes.js';
import type { SseStream } from './sse.js';
import type { BankSummaryLookup, PersonaLookup, XrayConfig, XrayStats } from './types.js';
import type { JwtService } from '../contracts/index.js';

export type { BankSummaryLookup, XrayConfig, XrayStats, PersonaLookup, ViewerIdentity } from './types.js';
export type { ReadModel, SessionRow } from './read-model.js';
export type { EventLog } from './log.js';
export {
  applyObserverRedaction,
  redactEventData,
  ipPrefixOf,
  isAnthropicEgress,
  maskToLastFour,
  shortHash,
} from './redaction.js';

/** How many events are read back from the log to rebuild the read model on boot. */
export const RESTORE_WINDOW = 5000;
/** How often the retention job runs. */
export const RETENTION_INTERVAL_MS = 10 * 60 * 1000;

export interface XrayDeps {
  readonly config: XrayConfig;
  /** Injected by `src/app.ts` from `createAuth(...).jwt`: the same `OAUTH_SIGNING_KEY`. */
  readonly jwt: JwtService;
  /** Changes on every restart; stamped on `server.started` and on every session row (A-15). */
  readonly bootId: string;
  readonly version?: string;
  readonly gitSha?: string | null;
  readonly sdk?: string | null;
  readonly nodeVersion?: string | null;
  readonly now?: () => Date;
  /** `bankCore.personas` in production; absent in a unit test, where sessions carry no persona. */
  readonly lookupPersona?: PersonaLookup;
  /** The persona card (`GET /xray/api/sessions/:xs/bank`); absent in a unit test (503). */
  readonly lookupBankSummary?: BankSummaryLookup;
  /** Where a swallowed X-ray failure goes. Never on the producer's path. */
  readonly onError?: (error: unknown, where: string) => void;
  /** Off in a test that asserts on the first event it emits itself. */
  readonly emitServerStarted?: boolean;
  /** Overridden in tests; the contract default is 20 s (`SSE_HEARTBEAT_MS`). */
  readonly heartbeatMs?: number;
  /** Set to 0 to disable the timer and call `runRetention()` by hand. */
  readonly retentionIntervalMs?: number;
  /**
   * Registers `SIGTERM`/`SIGINT` handlers that call `shutdown`. Off by default: process-level
   * handlers belong to `src/server.ts` (docs/REPO_LAYOUT.md section 3).
   */
  readonly installSignalHandlers?: boolean;
}

export interface Xray {
  readonly emitter: XrayEmitter;
  readonly router: RequestHandler;
  readonly pairing: Pairing;
  /** The read model, for `src/app.ts` diagnostics and for the block's own tests. */
  readonly readModel: ReadModel;
  readonly log: EventLog;
  readonly ring: Ring;
  stats(): XrayStats;
  /** Writes every queued event to the log synchronously. */
  flush(): void;
  /** Deletes events past `XRAY_RETENTION_HOURS`; returns how many rows went. */
  runRetention(): number;
  /** `server.stopping`, every stream ended, everything flushed, the log closed. */
  shutdown(reason?: 'sigterm' | 'sigint' | 'shutdown'): void;
}

export function createXray(deps: XrayDeps): Xray {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());
  const onError =
    deps.onError ??
    ((error: unknown, where: string): void => {
      // stdout only: an X-ray failure is a diagnostic, never a request failure.
      console.warn(
        JSON.stringify({
          level: 'warn',
          block: 'xray',
          where,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });

  const startedAtMs = now().getTime();

  const log = createEventLog({ path: config.xrayDbPath, onError });
  const ring = createRing();
  const readModel = createReadModel({ lookupEvent: (id) => log.readById(id) });

  // Rebuild the indexes from the tail of the restored log, so a restart does not lose the session
  // list a viewer is looking at (the events themselves are still there, A-25).
  const restored = log.recent(RESTORE_WINDOW);
  for (const event of restored) {
    try {
      readModel.observe(event);
      ring.push(event);
    } catch (error) {
      onError(error, 'restore');
    }
  }
  // Everything after the restore belongs to *this* boot; the rows above keep the boot they had.
  readModel.setBootId(deps.bootId);
  const restoredMaxId = log.maxId();

  const pipeline: Pipeline = createPipeline({
    ring,
    log,
    readModel,
    now,
    firstId: restoredMaxId,
    restoredSeq: log.seqByXs(),
    onError,
  });

  const pairing: XrayPairing = createPairing({
    emitter: pipeline.emitter,
    publicBaseUrl: config.publicBaseUrl,
    adminToken: config.xrayAdminToken,
    now,
    maxFailuresPerMinute: config.rateLimits.ipPairFailuresPerMin,
  });

  const streams = new Set<SseStream>();
  const router = buildXrayRouter({
    config,
    jwt: deps.jwt,
    pipeline,
    log,
    readModel,
    ring,
    pairing,
    now,
    lookupPersona: deps.lookupPersona,
    lookupBankSummary: deps.lookupBankSummary,
    heartbeatMs: deps.heartbeatMs,
    onError,
    streams,
  });

  function runRetention(): number {
    const cutoff = now().getTime() - config.xrayRetentionHours * 3_600_000;
    pipeline.flush();
    let removed = log.deleteOlderThan(cutoff);
    // Time is not a memory bound on its own: one busy hour can hold more than the instance has
    // long before the 72-hour cutoff comes round, so the row cap trims too (invariant 14).
    removed += log.trimToMaxRows(config.xrayMaxLogRows);
    // And deleting rows never shrinks the file by itself; on gen2 `/tmp` that is RAM (A-25).
    if (removed > 0) log.reclaim();
    return removed;
  }

  const retentionEvery = deps.retentionIntervalMs ?? RETENTION_INTERVAL_MS;
  let retentionTimer: NodeJS.Timeout | null = null;
  if (retentionEvery > 0) {
    retentionTimer = setInterval(() => {
      try {
        runRetention();
      } catch (error) {
        onError(error, 'retention');
      }
    }, retentionEvery);
    // Instance-based billing keeps this running with no request in flight (invariant 2), but the
    // timer must never be the reason a test process stays alive.
    retentionTimer.unref?.();
  }

  if (deps.emitServerStarted !== false) {
    pipeline.emitter.emit('server.started', {
      boot_id: deps.bootId,
      version: deps.version ?? '0.0.0',
      git_sha: deps.gitSha ?? null,
      sdk: deps.sdk ?? null,
      restored_max_id: restoredMaxId > 0 ? restoredMaxId : null,
      node_version: deps.nodeVersion ?? process.version,
    });
  }

  let stopped = false;
  function shutdown(reason: 'sigterm' | 'sigint' | 'shutdown' = 'sigterm'): void {
    if (stopped) return;
    stopped = true;
    try {
      const sessionsEnded = readModel
        .sessions({ viewer_kind: 'admin', filter: 'all', login_id: null, xs: null })
        .filter((row) => row.boot_id === deps.bootId).length;
      pipeline.emitter.emit('server.stopping', {
        boot_id: deps.bootId,
        version: deps.version ?? '0.0.0',
        reason,
        uptime_s: Math.max(0, Math.round((now().getTime() - startedAtMs) / 1000)),
        sessions_ended: sessionsEnded,
      });
    } catch (error) {
      onError(error, 'shutdown-marker');
    }
    if (retentionTimer) clearInterval(retentionTimer);
    retentionTimer = null;
    for (const stream of streams) {
      try {
        stream.close('server_cut');
      } catch (error) {
        onError(error, 'shutdown-stream');
      }
    }
    streams.clear();
    // `stop` flushes what is queued; the log is closed only afterwards.
    pipeline.stop();
    log.close();
  }

  if (deps.installSignalHandlers === true) {
    process.once('SIGTERM', () => shutdown('sigterm'));
    process.once('SIGINT', () => shutdown('sigint'));
  }

  return {
    emitter: pipeline.emitter,
    router,
    pairing,
    readModel,
    log,
    ring,
    stats(): XrayStats {
      const logFile = log.fileStats();
      return {
        emitted: pipeline.emitted,
        invalid: pipeline.invalid,
        pending: pipeline.pending,
        droppedFromLog: pipeline.droppedFromLog,
        droppedToSubscribers: pipeline.droppedToSubscribers,
        subscribers: pipeline.subscriberCount,
        ringSize: ring.size,
        ringBytes: ring.bytes,
        nextId: pipeline.nextId,
        logDegraded: log.degraded,
        logRows: log.count(),
        logBytes: logFile.pageSize * logFile.pageCount,
        logFreeBytes: logFile.pageSize * logFile.freePages,
      };
    },
    flush: () => pipeline.flush(),
    runRetention,
    shutdown,
  };
}
