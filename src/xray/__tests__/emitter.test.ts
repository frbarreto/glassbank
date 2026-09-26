/**
 * The emitter (docs/ARCHITECTURE.md section 6, CLAUDE.md invariants 11 and 13).
 *
 * Three properties are load-bearing and each is asserted against a hostile case: the emitter never
 * throws, it never writes to SQLite on the producer's call stack, and its ids stay monotonic -
 * including across a restart, which is what `Last-Event-ID` replay depends on.
 */
import { describe, expect, it } from 'vitest';

import { XRAY_CONTRACT_VERSION, type XrayEvent } from '../../contracts/index.js';

import { createPipeline, MAX_PENDING_WRITES } from '../emitter.js';
import { createEventLog, createNullEventLog, type EventLog } from '../log.js';
import { createReadModel } from '../read-model.js';
import { createRing } from '../ring.js';
import { createHarness, createTempDb } from './harness.js';

function build(options: { log?: EventLog; firstId?: number; maxPendingWrites?: number } = {}) {
  const ring = createRing(100);
  const log = options.log ?? createNullEventLog();
  const readModel = createReadModel();
  const errors: { error: unknown; where: string }[] = [];
  const pipeline = createPipeline({
    ring,
    log,
    readModel,
    firstId: options.firstId ?? 0,
    onError: (error, where) => errors.push({ error, where }),
    ...(options.maxPendingWrites === undefined
      ? {}
      : { maxPendingWrites: options.maxPendingWrites }),
  });
  return { ring, log, readModel, pipeline, errors };
}

describe('the emitter never throws', () => {
  it('swallows a payload that does not match the catalogue and keeps counting', () => {
    const { pipeline, ring } = build();
    expect(() =>
      // A deliberately wrong payload: `latency_ms` is required and `ok` is a boolean.
      pipeline.emitter.emit('bank.op', { operation: 'not a valid operation' } as never),
    ).not.toThrow();
    expect(pipeline.invalid).toBe(1);
    // The envelope still reaches the dashboard, which renders an unknown payload as raw JSON.
    expect(ring.size).toBe(1);
  });

  it('swallows a payload that is not an object at all', () => {
    const { pipeline } = build();
    expect(() => pipeline.emitter.emit('sql.query', undefined as never)).not.toThrow();
    expect(() => pipeline.emitter.emit('sql.query', 'nonsense' as never)).not.toThrow();
  });

  it('survives a subscriber that throws on every event', () => {
    const { pipeline } = build();
    pipeline.subscribe({
      id: 0,
      scope: { viewer_kind: 'admin', filter: 'all', login_id: null, xs: null },
      deliver() {
        throw new Error('a dead socket');
      },
    });
    expect(() =>
      pipeline.emitter.emit('sql.query', { sql: 'SELECT 1', rows_returned: 1, duration_ms: 1 }),
    ).not.toThrow();
    expect(pipeline.emitted).toBe(1);
  });

  it('survives a log that throws on every write', () => {
    const broken: EventLog = {
      ...createNullEventLog(),
      append() {
        throw new Error('disk gone');
      },
    };
    const { pipeline, errors } = build({ log: broken });
    pipeline.emitter.emit('sql.query', { sql: 'SELECT 1', rows_returned: 1, duration_ms: 1 });
    expect(() => pipeline.flush()).not.toThrow();
    expect(errors.map((entry) => entry.where)).toContain('flush');
  });
});

describe('ids and seq', () => {
  it('assigns monotonic ids and a per-session seq', () => {
    const { pipeline, ring } = build();
    // `emit` returns `number | void` since contracts v0.2 (proposal P-5); the real emitter always
    // reports the id it assigned, which is what `catalog.tools_listed.snapshot_ref` needs.
    const emit = (xs: string | null): number | void =>
      pipeline.emitter.emit(
        'bank.op',
        { operation: 'accounts.list', latency_ms: 1, ok: true },
        xs === null ? {} : { xs },
      );
    expect(emit('xs_aaa')).toBe(1);
    emit('xs_bbb');
    emit('xs_aaa');
    expect(emit(null)).toBe(4);
    const events = ring.last(10);
    expect(events.map((event) => event.id)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.seq)).toEqual([1, 1, 2, null]);
    expect(events.every((event) => event.v === XRAY_CONTRACT_VERSION)).toBe(true);
  });

  it('continues the ids and the seq of a restored log (A-25, section 2)', () => {
    const temporary = createTempDb();
    try {
      const first = createHarness({ dbPath: temporary.path, bootId: 'boot_one' });
      first.xray.emitter.emit(
        'tool.call.started',
        { tool: 'load_accounts', arguments: {}, rationale_present: false },
        { xs: 'xs_restart1' },
      );
      first.xray.emitter.emit(
        'tool.call.completed',
        { tool: 'load_accounts', duration_ms: 5, is_error: false },
        { xs: 'xs_restart1' },
      );
      first.xray.flush();
      // After the shutdown, so the `server.stopping` marker it writes is part of the log.
      first.xray.shutdown('shutdown');
      const lastId = first.xray.stats().nextId - 1;

      // A restart: same file, new process state.
      const second = createHarness({
        dbPath: temporary.path,
        bootId: 'boot_two',
        emitServerStarted: true,
      });
      const restored = second.xray.ring
        .last(10)
        .find((event: XrayEvent) => event.type === 'server.started');
      expect(restored?.id).toBe(lastId + 1);
      if (restored?.type !== 'server.started') throw new Error('no restart marker');
      expect(restored.data.restored_max_id).toBe(lastId);
      expect(restored.data.boot_id).toBe('boot_two');

      second.xray.emitter.emit(
        'tool.call.completed',
        { tool: 'load_accounts', duration_ms: 5, is_error: false },
        { xs: 'xs_restart1' },
      );
      second.xray.flush();
      const continued = second.xray.log
        .readSession('xs_restart1', 0, 10)
        .map((event) => event.seq);
      // 1, 2 from the first boot; the third continues at 3 rather than restarting at 1.
      expect(continued).toEqual([1, 2, 3]);
      second.xray.shutdown('shutdown');
    } finally {
      temporary.cleanup();
    }
  });
});

describe('backpressure', () => {
  it('does not write to SQLite on the producer call stack', async () => {
    const temporary = createTempDb();
    try {
      const log = createEventLog({ path: temporary.path });
      const { pipeline } = build({ log });
      pipeline.emitter.emit('sql.query', { sql: 'SELECT 1', rows_returned: 1, duration_ms: 1 });
      // Still only queued: the flush is scheduled on the next turn of the loop.
      expect(pipeline.pending).toBe(1);
      expect(log.count()).toBe(0);
      await new Promise((resolve) => setImmediate(resolve));
      expect(pipeline.pending).toBe(0);
      expect(log.count()).toBe(1);
      log.close();
    } finally {
      temporary.cleanup();
    }
  });

  it('drops the oldest queued writes and reports xray.dropped when the queue is full', () => {
    const { pipeline, ring } = build({ maxPendingWrites: 4 });
    for (let index = 0; index < 8; index += 1) {
      pipeline.emitter.emit('sql.query', {
        sql: `SELECT ${index}`,
        rows_returned: 1,
        duration_ms: 1,
      });
    }
    expect(pipeline.droppedFromLog).toBeGreaterThan(0);
    expect(pipeline.pending).toBeLessThanOrEqual(5);
    const dropped = ring.last(50).filter((event) => event.type === 'xray.dropped');
    expect(dropped.length).toBeGreaterThan(0);
    if (dropped[0]?.type !== 'xray.dropped') throw new Error('no drop event');
    expect(dropped[0].data.reason).toBe('backpressure');
  });

  it('has a documented default queue bound', () => {
    expect(MAX_PENDING_WRITES).toBeGreaterThanOrEqual(10_000);
  });
});

describe('Ring.remove (v0.4): the replay buffer forgets an erased session', () => {
  function fill(ring: ReturnType<typeof createRing>, sessions: readonly string[]): void {
    let id = 1;
    for (const xs of sessions) {
      ring.push({
        id: id++,
        ts: '2026-09-09T10:00:00.000Z',
        type: 'session.started',
        xs,
        login_id: null,
        grant_id: null,
        persona_id: null,
        request_id: null,
        trace_id: null,
        seq: null,
        protocol_version: null,
        era: null,
        data: { reason: 'first_request', idle_ms: null },
      } as never);
    }
  }

  it('drops only what the predicate accepts and answers how many went', () => {
    const ring = createRing(100);
    fill(ring, ['xs_a', 'xs_b', 'xs_a', 'xs_c']);
    expect(ring.size).toBe(4);

    expect(ring.remove((event) => event.xs === 'xs_a')).toBe(2);
    expect(ring.size).toBe(2);
    expect(ring.after(0, 50).map((event) => event.xs)).toEqual(['xs_b', 'xs_c']);
    // Nothing to remove is not an error and changes nothing.
    expect(ring.remove((event) => event.xs === 'xs_gone')).toBe(0);
    expect(ring.size).toBe(2);
  });

  it('keeps the survivors in id order, so a Last-Event-ID replay still works', () => {
    const ring = createRing(100);
    fill(ring, ['xs_a', 'xs_b', 'xs_a', 'xs_c', 'xs_b']);
    ring.remove((event) => event.xs === 'xs_a');

    const ids = ring.after(0, 50).map((event) => event.id);
    expect(ids).toEqual([...ids].sort((left, right) => left - right));
    expect(ring.oldestId).toBe(ids[0]);
    expect(ring.after(2, 50).every((event) => event.id > 2)).toBe(true);
    // The byte budget is recomputed, not left counting the events that went.
    expect(ring.bytes).toBeGreaterThan(0);
  });
});
