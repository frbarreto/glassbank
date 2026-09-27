/**
 * The event pipeline (block: xray).
 *
 * `emit(type, data, correlation)` is called from a tool handler, from the bearer gate and from
 * the OAuth routes. Three properties matter more than anything this file computes:
 *
 *   1. **It never throws.** Every step is inside a `try`. A redaction bug, a malformed payload, a
 *      broken SQLite file or a dead subscriber socket must not be able to fail a `tools/call` or
 *      an OAuth request (CLAUDE.md invariants 5 and 13, docs/ARCHITECTURE.md section 6).
 *   2. **It never blocks the producer.** The synchronous part is: assign an id, snapshot, validate,
 *      push into the ring, hand the frame to each matching subscriber, append to a bounded queue.
 *      The SQLite write is batched on `setImmediate`; the only synchronous flush is `flush()`,
 *      which a *viewer* request (a replay) or shutdown calls, never a producer.
 *   3. **Ids are monotonic and continue across a restart.** `restored_max_id + 1` on boot, and a
 *      per-`xs` `seq` restored the same way (docs/XRAY_EVENT_MODEL.md section 2).
 *   4. **It stores what it is given** (v0.9, D-28). No redaction, no truncation and no field
 *      dropped on the way in: the catalogue's schemas are open, so validation only fills the
 *      documented defaults. Redaction runs on the way out (`viewEvent`, `redaction.ts`), and the
 *      memory bound is `XRAY_MAX_LOG_BYTES`, which drops the oldest whole events, never a part
 *      of a new one.
 *
 * On overflow of the write queue the events stay live (they are already in the ring and already
 * fanned out) and only durability is lost; the drop is counted and reported as `xray.dropped`.
 */
import {
  XRAY_CONTRACT_VERSION,
  XrayEnvelopeSchema,
  XrayEventSchema,
  type XrayCorrelation,
  type XrayEvent,
  type XrayEventDataInput,
  type XrayEventType,
  type XrayEmitter,
  type XrayViewerScope,
} from '../contracts/index.js';

import { BoundedLru } from './bounded.js';
import type { EventLog } from './log.js';
import type { ReadModel } from './read-model.js';
import type { Ring } from './ring.js';

/** Events waiting to be written to SQLite before the oldest are dropped. */
export const MAX_PENDING_WRITES = 20_000;
/** `xs` values whose `seq` counter is kept in memory (ADR-16). */
export const MAX_TRACKED_SESSIONS = 5000;

/** One live consumer of the stream. The SSE layer owns its own queue and backpressure. */
export interface Subscriber {
  readonly id: number;
  readonly scope: XrayViewerScope;
  deliver(event: XrayEvent): void;
}

export interface Pipeline {
  readonly emitter: XrayEmitter;
  /** Writes every queued event to the log synchronously. Called before a replay and on SIGTERM. */
  flush(): void;
  subscribe(subscriber: Subscriber): () => void;
  readonly subscriberCount: number;
  readonly nextId: number;
  readonly pending: number;
  readonly emitted: number;
  readonly invalid: number;
  readonly droppedFromLog: number;
  /** Counted by the SSE layer when a slow subscriber loses frames. */
  noteSubscriberDrop(count: number): void;
  readonly droppedToSubscribers: number;
  stop(): void;
}

export interface PipelineOptions {
  readonly ring: Ring;
  readonly log: EventLog;
  readonly readModel: ReadModel;
  readonly now?: () => Date;
  /** Continues the id sequence after a restart; normally `log.maxId()`. */
  readonly firstId?: number;
  /** Continues each session's `seq` after a restart; normally `log.seqByXs()`. */
  readonly restoredSeq?: Map<string, number>;
  readonly onError?: (error: unknown, where: string) => void;
  readonly maxPendingWrites?: number;
  /** `XRAY_MAX_LOG_BYTES`: past it, a flush trims the oldest whole events (v0.9, D-28). */
  readonly maxLogBytes?: number;
}

/**
 * A deep copy of a payload at the moment it is emitted. `structuredClone` keeps every value and
 * survives cycles; a payload it refuses (a function inside) falls back to its JSON form, which is
 * what the log stores anyway.
 */
function snapshot(data: unknown): unknown {
  try {
    return structuredClone(data);
  } catch {
    const seen = new WeakSet<object>();
    return JSON.parse(
      JSON.stringify(data, (_key, value: unknown) => {
        if (typeof value === 'bigint') return value.toString();
        if (value !== null && typeof value === 'object') {
          if (seen.has(value)) return '[circular]';
          seen.add(value);
        }
        return value;
      }) ?? 'null',
    ) as unknown;
  }
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const { ring, log, readModel } = options;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => {});
  const maxPending = options.maxPendingWrites ?? MAX_PENDING_WRITES;

  const seqByXs = new BoundedLru<string, number>(MAX_TRACKED_SESSIONS);
  for (const [xs, seq] of options.restoredSeq ?? []) seqByXs.set(xs, seq);

  const subscribers = new Map<number, Subscriber>();
  let nextSubscriberId = 1;

  let nextId = (options.firstId ?? 0) + 1;
  let pending: XrayEvent[] = [];
  let scheduled: NodeJS.Immediate | null = null;
  let emitted = 0;
  let invalid = 0;
  let droppedFromLog = 0;
  let droppedToSubscribers = 0;
  let reportingDrop = false;
  let stopped = false;

  function flush(): void {
    if (scheduled !== null) {
      clearImmediate(scheduled);
      scheduled = null;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      log.append(batch);
      // Events are stored whole, so the byte cap is enforced here and not only by the periodic
      // retention: a burst of large bodies must not outgrow the instance's memory in between.
      if (options.maxLogBytes !== undefined && log.storedBytes() > options.maxLogBytes) {
        log.trimToMaxBytes(options.maxLogBytes);
      }
    } catch (error) {
      onError(error, 'flush');
    }
  }

  function schedule(): void {
    if (scheduled !== null || stopped) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      flush();
    });
    // A queued flush must never be the reason the process stays alive; `shutdown` flushes.
    scheduled.unref?.();
  }

  /** Builds the validated envelope. Returns `null` when even the lenient schema refuses it. */
  function buildEvent(
    type: string,
    data: unknown,
    correlation: XrayCorrelation | undefined,
  ): XrayEvent | null {
    const merged: XrayCorrelation = correlation ?? {};
    const xs = merged.xs ?? null;
    let seq: number | null = null;
    if (xs) {
      seq = (seqByXs.get(xs) ?? 0) + 1;
      seqByXs.set(xs, seq);
    }
    const candidate = {
      ...merged,
      id: nextId,
      ts: now().toISOString(),
      v: XRAY_CONTRACT_VERSION,
      type,
      xs,
      seq,
      // v0.9 (D-28): the payload as the producer gave it, copied so that a producer changing its
      // own object after `emit` cannot change what was recorded.
      data: snapshot(data),
    };
    nextId += 1;

    const strict = XrayEventSchema.safeParse(candidate);
    if (strict.success) return strict.data;
    // A payload the catalogue refuses is still worth showing: the dashboard renders an unknown
    // envelope as raw JSON (section 1 of the model), which is how a producer bug becomes visible
    // instead of silent.
    const lenient = XrayEnvelopeSchema.safeParse(candidate);
    if (lenient.success) {
      invalid += 1;
      onError(strict.error, `event ${type} failed the catalogue schema`);
      return lenient.data as unknown as XrayEvent;
    }
    invalid += 1;
    onError(lenient.error, `event ${type} failed the envelope schema`);
    return null;
  }

  function publish(event: XrayEvent): void {
    try {
      ring.push(event);
    } catch (error) {
      onError(error, 'ring');
    }
    try {
      readModel.observe(event);
    } catch (error) {
      onError(error, 'read-model');
    }
    for (const subscriber of subscribers.values()) {
      try {
        if (readModel.matchesScope(event, subscriber.scope)) subscriber.deliver(event);
      } catch (error) {
        onError(error, 'subscriber');
      }
    }
    if (pending.length >= maxPending) {
      // Durability is the only thing lost: the event is in the ring and already fanned out.
      const overflow = pending.length - maxPending + 1;
      pending.splice(0, overflow);
      droppedFromLog += overflow;
      reportDrop(overflow);
    }
    pending.push(event);
    schedule();
  }

  /** Emits `xray.dropped` once, without recursing back into itself. */
  function reportDrop(count: number): void {
    if (reportingDrop || count <= 0) return;
    reportingDrop = true;
    try {
      const event = buildEvent(
        'xray.dropped',
        { dropped_count: count, viewer_kind: null, filter: null, reason: 'backpressure' },
        {},
      );
      if (event) {
        ring.push(event);
        readModel.observe(event);
        for (const subscriber of subscribers.values()) {
          try {
            if (readModel.matchesScope(event, subscriber.scope)) subscriber.deliver(event);
          } catch (error) {
            onError(error, 'subscriber');
          }
        }
        pending.push(event);
      }
    } catch (error) {
      onError(error, 'reportDrop');
    } finally {
      reportingDrop = false;
    }
  }

  const emitter: XrayEmitter = {
    emit<T extends XrayEventType>(
      type: T,
      data: XrayEventDataInput<T>,
      correlation?: XrayCorrelation,
    ): number | void {
      // The whole body is inside one `try`: a producer calls this on the path of a tool call and
      // an exception here would turn an observability bug into a user-visible failure.
      try {
        if (stopped) return undefined;
        const event = buildEvent(type, data, correlation);
        if (!event) return undefined;
        emitted += 1;
        publish(event);
        // v0.2 (P-5): the id exists synchronously here, so a producer that has to point at this
        // event later - `catalog.tools_listed.snapshot_ref` - can be told what it was.
        return event.id;
      } catch (error) {
        try {
          onError(error, 'emit');
        } catch {
          // Even the error reporter is not allowed to throw out of `emit`.
        }
      }
    },
  };

  return {
    emitter,
    flush,
    subscribe(subscriber) {
      const id = nextSubscriberId;
      nextSubscriberId += 1;
      subscribers.set(id, { ...subscriber, id });
      return () => {
        subscribers.delete(id);
      };
    },
    get subscriberCount() {
      return subscribers.size;
    },
    get nextId() {
      return nextId;
    },
    get pending() {
      return pending.length;
    },
    get emitted() {
      return emitted;
    },
    get invalid() {
      return invalid;
    },
    get droppedFromLog() {
      return droppedFromLog;
    },
    noteSubscriberDrop(count) {
      droppedToSubscribers += Math.max(0, count);
    },
    get droppedToSubscribers() {
      return droppedToSubscribers;
    },
    stop() {
      stopped = true;
      flush();
      subscribers.clear();
    },
  };
}
