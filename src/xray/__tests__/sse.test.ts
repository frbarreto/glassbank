/**
 * The SSE stream (docs/XRAY_EVENT_MODEL.md section 5, CLAUDE.md invariant 3).
 *
 * The test that matters: disconnect, keep producing, reconnect with `Last-Event-ID`, and receive
 * every event in between exactly once. That is what makes the 60-minute Cloud Run cut invisible.
 */
import { EventEmitter } from 'node:events';

// Aliased: the DOM `Response` of `fetch` is what the rest of this file works with.
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COOKIE_NAMES,
  SSE_HEARTBEAT_MS,
  SSE_RETRY_MS,
  type XrayEvent,
} from '../../contracts/index.js';

import { createPipeline } from '../emitter.js';
import { createNullEventLog } from '../log.js';
import { createReadModel } from '../read-model.js';
import { createRing } from '../ring.js';
import { openSseStream } from '../sse.js';
import { cookieFrom, createHarness, parseFrames, readFrames } from './harness.js';

interface Fixture {
  readonly harness: ReturnType<typeof createHarness>;
  readonly baseUrl: string;
}

/** One `tool.call.started` for a login, so every emitted event is scope-checkable. */
function emitCall(
  harness: ReturnType<typeof createHarness>,
  login: string,
  xs: string,
  note: string,
): void {
  harness.xray.emitter.emit(
    'tool.call.started',
    {
      tool: 'load_transactions',
      arguments: { note },
      rationale: `A rationale long enough to be worth masking in observer mode: ${note}. ${'x'.repeat(120)}`,
      rationale_present: true,
    },
    { xs, login_id: login, grant_id: `grt_${login.slice(4, 10)}` },
  );
}

async function pairCookie(baseUrl: string, harness: Fixture['harness'], login: string): Promise<string> {
  const minted = await harness.xray.pairing.createCode({ login_id: login });
  const response = await fetch(`${baseUrl}/xray/s/${minted.code}`, { redirect: 'manual' });
  const cookie = cookieFrom(response.headers, COOKIE_NAMES.viewer);
  if (cookie === null) throw new Error('the pairing exchange set no cookie');
  return cookie;
}

async function openStream(
  baseUrl: string,
  cookie: string,
  options: { readonly query?: string; readonly lastEventId?: number } = {},
): Promise<{ response: Response; abort: AbortController }> {
  const abort = new AbortController();
  const headers: Record<string, string> = { cookie: `${COOKIE_NAMES.viewer}=${cookie}` };
  if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId);
  const response = await fetch(`${baseUrl}/xray/api/stream${options.query ?? ''}`, {
    headers,
    signal: abort.signal,
  });
  return { response, abort };
}

describe('the SSE stream', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const harness = createHarness({ adminToken: 'observer-token-for-tests', heartbeatMs: 40 });
    const baseUrl = await harness.listen();
    fixture = { harness, baseUrl };
  });

  afterEach(async () => {
    await fixture.harness.close();
  });

  it('opens with the documented headers, a retry hint and the initial replay', async () => {
    emitCall(fixture.harness, 'lgn_stream1', 'xs_stream001', 'before the viewer connected');
    const cookie = await pairCookie(fixture.baseUrl, fixture.harness, 'lgn_stream1');
    const { response, abort } = await openStream(fixture.baseUrl, cookie);
    try {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toContain('no-cache');
      expect(response.headers.get('x-accel-buffering')).toBe('no');

      const frames = await readFrames(response, {
        until: (collected) => collected.some((frame) => frame.includes('tool.call.started')),
      });
      expect(frames[0]).toBe(`retry: ${SSE_RETRY_MS}`);
      const events = parseFrames(frames);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((frame) => frame.id !== null)).toBe(true);
      const types = events.map((frame) => (frame.data as XrayEvent).type);
      expect(types).toContain('tool.call.started');
      // The viewer sees its own connection, which is what the health panel counts.
      expect(types).toContain('xray.viewer.connected');
    } finally {
      abort.abort();
    }
  });

  it('sends a heartbeat comment on the documented interval', async () => {
    const cookie = await pairCookie(fixture.baseUrl, fixture.harness, 'lgn_stream2');
    const { response, abort } = await openStream(fixture.baseUrl, cookie);
    try {
      const frames = await readFrames(response, {
        until: (collected) => collected.some((frame) => frame.startsWith(': ping')),
        timeoutMs: 2000,
      });
      expect(frames.some((frame) => frame.startsWith(': ping'))).toBe(true);
    } finally {
      abort.abort();
    }
    // The contract default is 20 s; the test only shortens it.
    expect(SSE_HEARTBEAT_MS).toBe(20_000);
  });

  it('replays with no gaps and no duplicates after a disconnect and a reconnect', async () => {
    const login = 'lgn_replay1';
    const xs = 'xs_replay001';
    const cookie = await pairCookie(fixture.baseUrl, fixture.harness, login);

    // 1. Connected: receive two live calls.
    const first = await openStream(fixture.baseUrl, cookie);
    emitCall(fixture.harness, login, xs, 'call one');
    emitCall(fixture.harness, login, xs, 'call two');
    const firstFrames = await readFrames(first.response, {
      until: (collected) => parseFrames(collected).filter((frame) => frame.id !== null).length >= 3,
    });
    const received = parseFrames(firstFrames);
    const seenIds = received.map((frame) => frame.id as number);
    expect(seenIds.length).toBeGreaterThanOrEqual(3);
    const lastEventId = Math.max(...seenIds);
    first.abort.abort();
    // Let the server observe the close before anything else is emitted.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 2. Disconnected: three more calls the viewer must not lose.
    emitCall(fixture.harness, login, xs, 'call three');
    emitCall(fixture.harness, login, xs, 'call four');
    emitCall(fixture.harness, login, xs, 'call five');

    // 3. Reconnect exactly the way EventSource does.
    const second = await openStream(fixture.baseUrl, cookie, { lastEventId });
    try {
      const secondFrames = await readFrames(second.response, {
        until: (collected) =>
          collected.filter((frame) => frame.includes('"call five"')).length > 0,
      });
      const replayed = parseFrames(secondFrames);
      const replayIds = replayed.map((frame) => frame.id as number).filter((id) => id !== null);

      const notes = replayed
        .map((frame) => frame.data as XrayEvent)
        .filter((event) => event.type === 'tool.call.started')
        .map((event) =>
          event.type === 'tool.call.started' ? (event.data.arguments as { note: string }).note : '',
        );
      // No gaps: everything emitted while the viewer was away is there.
      expect(notes).toEqual(['call three', 'call four', 'call five']);
      // No duplicates: nothing at or below the cursor comes back, and no id repeats.
      expect(replayIds.every((id) => id > lastEventId)).toBe(true);
      expect(new Set(replayIds).size).toBe(replayIds.length);
      // And the two runs together are one strictly increasing sequence.
      const union = [...seenIds, ...replayIds];
      expect(new Set(union).size).toBe(union.length);
      expect([...union].sort((left, right) => left - right)).toEqual(union);
    } finally {
      second.abort.abort();
    }
  });

  it('never lets one login see another login stream', async () => {
    const cookie = await pairCookie(fixture.baseUrl, fixture.harness, 'lgn_owner01');
    const { response, abort } = await openStream(fixture.baseUrl, cookie);
    try {
      emitCall(fixture.harness, 'lgn_owner01', 'xs_owner0001', 'mine');
      emitCall(fixture.harness, 'lgn_other01', 'xs_other0001', 'not mine');
      emitCall(fixture.harness, 'lgn_owner01', 'xs_owner0001', 'mine again');
      const frames = await readFrames(response, {
        until: (collected) => collected.some((frame) => frame.includes('"mine again"')),
      });
      const body = frames.join('\n');
      expect(body).toContain('"mine"');
      expect(body).toContain('"mine again"');
      expect(body).not.toContain('not mine');
      expect(body).not.toContain('xs_other0001');
    } finally {
      abort.abort();
    }
  });

  it('gives observer mode every login, with arguments hidden and the rationale masked', async () => {
    const adminResponse = await fetch(`${fixture.baseUrl}/xray/api/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'observer-token-for-tests' }),
    });
    const cookie = cookieFrom(adminResponse.headers, COOKIE_NAMES.viewer);
    if (cookie === null) throw new Error('the admin exchange set no cookie');

    const { response, abort } = await openStream(fixture.baseUrl, cookie, { query: '?all=1' });
    try {
      emitCall(fixture.harness, 'lgn_admin001', 'xs_admin0001', 'first login');
      emitCall(fixture.harness, 'lgn_admin002', 'xs_admin0002', 'second login');
      const frames = await readFrames(response, {
        until: (collected) =>
          parseFrames(collected).filter(
            (frame) => (frame.data as XrayEvent).type === 'tool.call.started',
          ).length >= 2,
      });
      const calls = parseFrames(frames)
        .map((frame) => frame.data as XrayEvent)
        .filter((event) => event.type === 'tool.call.started');
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        if (call.type !== 'tool.call.started') throw new Error('type changed');
        expect(call.data.arguments).toEqual({});
        expect(call.data.rationale?.length ?? 0).toBeLessThanOrEqual(100);
      }
      // The notes themselves were inside `arguments`, so observer mode must not leak them.
      const body = frames.join('\n');
      expect(body).not.toContain('"first login"');
    } finally {
      abort.abort();
    }
  });

  it('rejects a stream the viewer is not scoped for', async () => {
    const cookie = await pairCookie(fixture.baseUrl, fixture.harness, 'lgn_scoped1');
    emitCall(fixture.harness, 'lgn_stranger', 'xs_stranger01', 'not yours');
    const response = await fetch(`${fixture.baseUrl}/xray/api/stream?xs=xs_stranger01`, {
      headers: { cookie: `${COOKIE_NAMES.viewer}=${cookie}` },
    });
    expect(response.status).toBe(403);
    await response.body?.cancel();
  });

  it('counts the viewer connecting and disconnecting', async () => {
    const cookie = await pairCookie(fixture.baseUrl, fixture.harness, 'lgn_count01');
    const { response, abort } = await openStream(fixture.baseUrl, cookie);
    await readFrames(response, {
      until: (collected) => collected.some((frame) => frame.includes('xray.viewer.connected')),
    });
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const types = fixture.harness.xray.ring.last(200).map((event) => event.type);
    expect(types).toContain('xray.viewer.connected');
    expect(types).toContain('xray.viewer.disconnected');
    expect(fixture.harness.xray.stats().subscribers).toBe(0);
  });
});

/**
 * Backpressure, against a socket that never drains (section 5: "the fan-out queue per subscriber
 * is bounded; on overflow the subscriber gets an `xray.dropped` event with the count").
 *
 * A real socket needs megabytes to fill, so the writable is faked: `write` returns `false` - Node's
 * "buffer is full" signal - until the test emits `drain`.
 */
describe('subscriber backpressure', () => {
  it('bounds the queue, counts the drops and tells the viewer without moving its cursor', () => {
    const ring = createRing(100);
    const log = createNullEventLog();
    const readModel = createReadModel();
    const pipeline = createPipeline({ ring, log, readModel });

    const written: string[] = [];
    let accepting = false;
    const response = Object.assign(new EventEmitter(), {
      setHeader: () => undefined,
      status: () => response,
      flushHeaders: () => undefined,
      write: (chunk: string) => {
        written.push(chunk);
        return accepting;
      },
      end: () => undefined,
    }) as unknown as ExpressResponse;
    const request = Object.assign(new EventEmitter(), {
      headers: {} as Record<string, string>,
      query: {} as Record<string, string>,
    }) as unknown as ExpressRequest;

    openSseStream({
      request,
      response,
      scope: { viewer_kind: 'admin', filter: 'all', login_id: null, xs: null },
      pipeline,
      log,
      readModel,
      heartbeatMs: 0,
      maxQueue: 3,
    });

    // The very first write (`retry:`) was refused, so the subscriber starts paused.
    expect(written[0]).toBe(`retry: ${SSE_RETRY_MS}\n\n`);
    const before = written.length;

    for (let index = 0; index < 8; index += 1) {
      pipeline.emitter.emit('sql.query', {
        sql: `SELECT ${index}`,
        rows_returned: 1,
        duration_ms: 1,
      });
    }
    // Nothing more reached the socket: three events are queued, the rest were dropped.
    expect(written).toHaveLength(before);

    accepting = true;
    (response as unknown as EventEmitter).emit('drain');

    const frames = written.slice(before).join('');
    expect(pipeline.droppedToSubscribers).toBeGreaterThan(0);
    const notice = written.find((chunk) => chunk.includes('"xray.dropped"'));
    expect(notice).toBeDefined();
    // No `id:` line on the notice: the browser keeps the cursor of the last real event, so its
    // reconnect backfills the gap instead of skipping it.
    expect(notice?.includes('\nid: ')).toBe(false);
    expect(frames).toContain('event: xray');
    pipeline.stop();
  });
});

describe('a degraded log', () => {
  it('replays from the ring buffer instead of failing the viewer', () => {
    const ring = createRing(100);
    // The null log is what `createEventLog` returns when the file cannot be opened at all.
    const log = createNullEventLog();
    const readModel = createReadModel();
    const pipeline = createPipeline({ ring, log, readModel });

    pipeline.emitter.emit('sql.query', { sql: 'SELECT 1', rows_returned: 1, duration_ms: 1 });
    pipeline.emitter.emit('sql.query', { sql: 'SELECT 2', rows_returned: 1, duration_ms: 1 });

    const written: string[] = [];
    const response = Object.assign(new EventEmitter(), {
      setHeader: () => undefined,
      status: () => response,
      flushHeaders: () => undefined,
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
      end: () => undefined,
    }) as unknown as ExpressResponse;
    const request = Object.assign(new EventEmitter(), {
      headers: {} as Record<string, string>,
      query: {} as Record<string, string>,
    }) as unknown as ExpressRequest;

    openSseStream({
      request,
      response,
      scope: { viewer_kind: 'admin', filter: 'all', login_id: null, xs: null },
      pipeline,
      log,
      readModel,
      ring,
      heartbeatMs: 0,
    });

    const body = written.join('');
    expect(body).toContain('SELECT 1');
    expect(body).toContain('SELECT 2');
    // And the stream is live from there on.
    pipeline.emitter.emit('sql.query', { sql: 'SELECT 3', rows_returned: 1, duration_ms: 1 });
    expect(written.join('')).toContain('SELECT 3');
    pipeline.stop();
  });
});
