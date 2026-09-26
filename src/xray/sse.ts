/**
 * The SSE stream (block: xray).
 *
 * `GET /xray/api/stream?xs=` | `?login=me` | `?all=1` (docs/XRAY_EVENT_MODEL.md section 5).
 *
 * The order inside `openSseStream` is the whole correctness argument for "no gaps and no
 * duplicates" across the 60-minute Cloud Run cut (invariant 3):
 *
 *   1. subscribe first, buffering every live event into a bounded queue;
 *   2. flush the emitter's pending writes, so the log is complete;
 *   3. replay `id > Last-Event-ID` from the log (or the last 200 events on a fresh connect);
 *   4. switch to live and drain the queue, skipping anything the replay already sent.
 *
 * Steps 1-4 are synchronous, so nothing can be emitted between them: an event either lands in the
 * replay or in the queue, never in both and never in neither.
 *
 * A subscriber that cannot keep up loses frames rather than memory: the queue is bounded, drops
 * are counted, and the viewer is told with an id-less `xray.dropped` frame so its `Last-Event-ID`
 * cursor stays on the last event it actually received and the next reconnect backfills.
 */
import type { Request, Response } from 'express';

import {
  INITIAL_REPLAY,
  SSE_EVENT_NAME,
  SSE_HEADERS,
  SSE_HEARTBEAT_MS,
  SSE_RETRY_MS,
  XRAY_CONTRACT_VERSION,
  renderStreamFrame,
  type XrayEvent,
  type XrayViewerScope,
} from '../contracts/index.js';

import type { Pipeline } from './emitter.js';
import type { EventLog, LogFilter } from './log.js';
import type { ReadModel } from './read-model.js';
import { applyObserverRedaction } from './redaction.js';
import type { Ring } from './ring.js';

/** Frames a subscriber may fall behind by before it starts losing them. */
export const MAX_SUBSCRIBER_QUEUE = 1000;
/**
 * Characters a subscriber may fall behind by, alongside the frame count.
 *
 * A count is not a memory bound: 1,000 queued events at the redaction pipeline's per-event budget
 * is tens of megabytes for ONE paused viewer, and Cloud Run allows 250 concurrent requests against
 * 1 GiB. Whichever bound binds first starts dropping, and the viewer is told either way.
 */
export const MAX_SUBSCRIBER_QUEUE_BYTES = 4_000_000;

/** Cheap size estimate for one queued frame; the envelope is only ever JSON. */
function approximateFrameBytes(event: XrayEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 1024;
  }
}
/** Events read per replay chunk. */
const REPLAY_CHUNK = 500;
/** Hard cap on one replay, so a viewer that was away for days cannot pin the event loop. */
export const MAX_REPLAY_EVENTS = 20_000;

export interface SseStreamOptions {
  readonly request: Request;
  readonly response: Response;
  readonly scope: XrayViewerScope;
  readonly pipeline: Pipeline;
  readonly log: EventLog;
  readonly readModel: ReadModel;
  /** The live buffer, used for the replay when the log is degraded. */
  readonly ring?: Ring;
  readonly now?: () => Date;
  readonly heartbeatMs?: number;
  readonly retryMs?: number;
  readonly initialReplay?: number;
  readonly maxQueue?: number;
  readonly maxQueueBytes?: number;
  readonly onError?: (error: unknown, where: string) => void;
}

/** The `Last-Event-ID` the browser reconnects with, or the query fallback for a manual client. */
export function lastEventIdOf(request: Request): number | null {
  const header = request.headers['last-event-id'];
  const raw =
    typeof header === 'string'
      ? header
      : Array.isArray(header)
        ? header[0]
        : typeof request.query.last_event_id === 'string'
          ? request.query.last_event_id
          : null;
  if (raw === null || raw === undefined) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The coarse SQL filter for a scope; `readModel.matchesScope` stays the authority. */
export function logFilterFor(scope: XrayViewerScope, readModel: ReadModel): LogFilter {
  if (scope.filter === 'all') return { kind: 'all' };
  if (scope.filter === 'xs') return { kind: 'xs', xs: scope.xs };
  const loginId = scope.login_id ?? '';
  return {
    kind: 'login',
    loginId,
    sessionIds: readModel.sessionIdsForLogin(loginId),
    grantIds: readModel.grantIdsForLogin(loginId),
  };
}

/** Every event after `afterId` the scope may see, in id order, chunked so one query stays small. */
export function replayEvents(input: {
  readonly afterId: number | null;
  readonly scope: XrayViewerScope;
  readonly log: EventLog;
  readonly readModel: ReadModel;
  readonly ring?: Ring | undefined;
  readonly initialReplay: number;
}): XrayEvent[] {
  const collected: XrayEvent[] = [];
  // A log that could not be opened (or that gave up after repeated failures) must not take the
  // dashboard down with it: the last 10,000 events are still in memory.
  if (input.log.degraded && input.ring) {
    const source =
      input.afterId === null
        ? input.ring.last(input.initialReplay)
        : input.ring.after(input.afterId, MAX_REPLAY_EVENTS);
    for (const event of source) {
      if (input.readModel.matchesScope(event, input.scope)) collected.push(event);
    }
    return collected;
  }
  const filter = logFilterFor(input.scope, input.readModel);
  if (input.afterId === null) {
    for (const event of input.log.readLast(input.initialReplay, filter)) {
      if (input.readModel.matchesScope(event, input.scope)) collected.push(event);
    }
    return collected;
  }
  let cursor = input.afterId;
  for (let guard = 0; guard < MAX_REPLAY_EVENTS / REPLAY_CHUNK; guard += 1) {
    const chunk = input.log.readAfter(cursor, REPLAY_CHUNK, filter);
    if (chunk.length === 0) break;
    for (const event of chunk) {
      if (input.readModel.matchesScope(event, input.scope)) collected.push(event);
      cursor = Math.max(cursor, event.id);
    }
    if (chunk.length < REPLAY_CHUNK) break;
    if (collected.length >= MAX_REPLAY_EVENTS) break;
  }
  return collected;
}

/** An open stream, so the caller can close it on shutdown. */
export interface SseStream {
  close(reason: 'client_closed' | 'server_cut' | 'backpressure'): void;
}

export function openSseStream(options: SseStreamOptions): SseStream {
  const { request, response, scope, pipeline, log, readModel } = options;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => {});
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const retryMs = options.retryMs ?? SSE_RETRY_MS;
  const maxQueue = options.maxQueue ?? MAX_SUBSCRIBER_QUEUE;
  const maxQueueBytes = options.maxQueueBytes ?? MAX_SUBSCRIBER_QUEUE_BYTES;
  const startedAt = now().getTime();
  const isObserver = scope.viewer_kind === 'admin';

  const queue: XrayEvent[] = [];
  /** Approximate characters currently queued, kept in step with `queue` on both ends. */
  let queuedBytes = 0;
  let live = false;
  let paused = false;
  let closed = false;
  let lastSentId = 0;
  let dropped = 0;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  function writeRaw(chunk: string): boolean {
    if (closed) return false;
    try {
      const accepted = response.write(chunk);
      if (!accepted) paused = true;
      return accepted;
    } catch (error) {
      onError(error, 'sse-write');
      closed = true;
      return false;
    }
  }

  function writeEvent(event: XrayEvent): void {
    const rendered = isObserver ? applyObserverRedaction(event) : event;
    writeRaw(renderStreamFrame({ event: SSE_EVENT_NAME, id: event.id, data: rendered }));
    lastSentId = Math.max(lastSentId, event.id);
  }

  /**
   * The drop notice deliberately carries **no `id:` line**: the browser must keep the cursor of
   * the last event it really received, so its automatic reconnect backfills the gap.
   */
  function writeDropNotice(count: number): void {
    const envelope = {
      id: lastSentId,
      ts: now().toISOString(),
      v: XRAY_CONTRACT_VERSION,
      type: 'xray.dropped',
      xs: null,
      login_id: scope.login_id,
      grant_id: null,
      persona_id: null,
      seq: null,
      request_id: null,
      era: null,
      client: null,
      protocol_version: null,
      trace_id: null,
      data: {
        dropped_count: count,
        viewer_kind: scope.viewer_kind,
        filter: scope.filter,
        reason: 'backpressure',
      },
    };
    writeRaw(`event: ${SSE_EVENT_NAME}\ndata: ${JSON.stringify(envelope)}\n\n`);
  }

  function drain(): void {
    while (!closed && !paused && queue.length > 0) {
      const event = queue.shift();
      if (!event) break;
      queuedBytes -= approximateFrameBytes(event);
      if (event.id <= lastSentId) continue;
      writeEvent(event);
    }
    if (!closed && !paused && dropped > 0) {
      const count = dropped;
      dropped = 0;
      pipeline.noteSubscriberDrop(count);
      writeDropNotice(count);
    }
  }

  function enqueue(event: XrayEvent): void {
    if (closed) return;
    if (live && !paused && queue.length === 0) {
      if (event.id > lastSentId) writeEvent(event);
      return;
    }
    const size = approximateFrameBytes(event);
    if (queue.length >= maxQueue || queuedBytes + size > maxQueueBytes) {
      dropped += 1;
      return;
    }
    queue.push(event);
    queuedBytes += size;
    if (live) drain();
  }

  // 1. Headers. `X-Accel-Buffering: no` and `no-cache` keep every proxy from holding a frame.
  for (const [header, value] of Object.entries(SSE_HEADERS)) response.setHeader(header, value);
  response.status(200);
  response.flushHeaders?.();
  writeRaw(`retry: ${retryMs}\n\n`);

  // 2. Subscribe before the replay, so nothing emitted during it can be lost.
  unsubscribe = pipeline.subscribe({ id: 0, scope, deliver: enqueue });

  // 3. Flush the emitter's queue: a replay must see everything already emitted.
  const afterId = lastEventIdOf(request);
  try {
    pipeline.flush();
  } catch (error) {
    onError(error, 'sse-flush');
  }

  // 4. Replay, then go live and drain what arrived meanwhile.
  let replayed = 0;
  try {
    const events = replayEvents({
      afterId,
      scope,
      log,
      readModel,
      ring: options.ring,
      initialReplay: options.initialReplay ?? INITIAL_REPLAY,
    });
    if (afterId !== null) lastSentId = afterId;
    for (const event of events) {
      if (event.id <= lastSentId) continue;
      writeEvent(event);
      replayed += 1;
    }
  } catch (error) {
    onError(error, 'sse-replay');
  }
  live = true;
  drain();

  response.on('drain', () => {
    paused = false;
    drain();
  });

  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      // A comment line: valid SSE, ignored by `EventSource`, enough to keep the socket warm.
      writeRaw(': ping\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  function close(reason: 'client_closed' | 'server_cut' | 'backpressure'): void {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    pipeline.emitter.emit(
      'xray.viewer.disconnected',
      {
        viewer_kind: scope.viewer_kind,
        login_id: scope.login_id,
        filter: scope.filter,
        duration_ms: Math.max(0, now().getTime() - startedAt),
        reason,
      },
      { login_id: scope.login_id, xs: scope.xs },
    );
    try {
      response.end();
    } catch (error) {
      onError(error, 'sse-end');
    }
  }

  request.on('close', () => close('client_closed'));
  response.on('close', () => close('client_closed'));

  pipeline.emitter.emit(
    'xray.viewer.connected',
    {
      viewer_kind: scope.viewer_kind,
      login_id: scope.login_id,
      filter: scope.filter,
      last_event_id: afterId,
      replayed,
    },
    { login_id: scope.login_id, xs: scope.xs },
  );

  return { close };
}
