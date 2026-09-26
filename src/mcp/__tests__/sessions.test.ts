/**
 * X-ray session segmentation (ADR-3, A-27).
 *
 * There is no `Mcp-Session-Id`, so `xs` is the only thing that groups a run of requests. The rule
 * is entirely about the clock, which is why the manager takes an injected one.
 */
import { describe, expect, it } from 'vitest';

import { createSessionManager } from '../sessions.js';

const initialize = { isInitialize: true } as const;
const request = { isInitialize: false } as const;

describe('createSessionManager', () => {
  it('mints one xs per grant and keeps it while the grant is active', () => {
    const manager = createSessionManager({ idleGapMinutes: 30, now: () => new Date(0) });
    const first = manager.touch('grt_a', initialize);
    expect(first.started).toBe(true);
    expect(first.reason).toBe('first_request');
    expect(first.xs.startsWith('xs_')).toBe(true);
    expect(first.ended).toBeNull();

    const second = manager.touch('grt_a', request);
    expect(second.started).toBe(false);
    expect(second.xs).toBe(first.xs);
  });

  it('counts initialize calls, so a claude.ai reconnect loop is visible', () => {
    const manager = createSessionManager({ idleGapMinutes: 30, now: () => new Date(0) });
    manager.touch('grt_a', initialize);
    manager.touch('grt_a', request);
    const third = manager.touch('grt_a', initialize);
    expect(third.initializeCount).toBe(2);
    // A re-initialize never starts a new xs (docs/XRAY_EVENT_MODEL.md section 4).
    expect(third.started).toBe(false);
  });

  it('starts a new xs after a silence longer than XS_IDLE_GAP_MINUTES', () => {
    let clock = 0;
    const manager = createSessionManager({ idleGapMinutes: 30, now: () => new Date(clock) });
    const first = manager.touch('grt_a', initialize);
    clock += 29 * 60_000;
    expect(manager.touch('grt_a', request).xs).toBe(first.xs);
    clock += 31 * 60_000;
    const after = manager.touch('grt_a', request);
    expect(after.xs).not.toBe(first.xs);
    expect(after.started).toBe(true);
    expect(after.reason).toBe('idle_gap');
    expect(after.idleMs).toBe(31 * 60_000);
  });

  it('hands back the closed segment so session.ended can be emitted lazily', () => {
    let clock = 0;
    const manager = createSessionManager({ idleGapMinutes: 30, now: () => new Date(clock) });
    const first = manager.touch('grt_a', initialize);
    manager.noteCall('grt_a');
    manager.noteCall('grt_a');
    manager.noteError('grt_a');
    clock += 10 * 60_000;
    manager.touch('grt_a', request);
    clock += 45 * 60_000;

    const split = manager.touch('grt_a', request);
    expect(split.ended?.xs).toBe(first.xs);
    expect(split.ended?.reason).toBe('idle_gap');
    expect(split.ended?.callCount).toBe(2);
    expect(split.ended?.errorCount).toBe(1);
    expect(split.ended?.initializeCount).toBe(1);
    // The segment lasted from its first request to its last, not to the moment it was noticed.
    expect(split.ended?.durationMs).toBe(10 * 60_000);
    expect(split.ended?.idleMs).toBe(45 * 60_000);
    // The new segment starts its counters from zero.
    expect(manager.peek('grt_a')?.callCount).toBe(0);
  });

  it('carries the last-seen clientInfo forward, because only initialize has it (A-28)', () => {
    let clock = 0;
    const manager = createSessionManager({ idleGapMinutes: 30, now: () => new Date(clock) });
    manager.touch('grt_a', {
      isInitialize: true,
      client: { name: 'claude-ai', version: '1.2.3', title: null },
      protocolVersion: '2025-11-25',
      era: 'legacy',
    });
    // A stateless tools/call two minutes later carries no clientInfo at all.
    const later = manager.touch('grt_a', { isInitialize: false });
    expect(later.session.client?.name).toBe('claude-ai');
    expect(later.session.protocolVersion).toBe('2025-11-25');

    // ...and it survives the idle-gap split too: the connector does not re-initialize on a gap.
    clock += 40 * 60_000;
    const afterGap = manager.touch('grt_a', { isInitialize: false });
    expect(afterGap.session.client?.name).toBe('claude-ai');
    expect(afterGap.ended?.client?.name).toBe('claude-ai');
  });

  it('sweeps idle segments so session.ended does not wait for traffic that never comes', () => {
    let clock = 0;
    const manager = createSessionManager({ idleGapMinutes: 30, now: () => new Date(clock) });
    manager.touch('grt_a', initialize);
    manager.touch('grt_b', initialize);
    expect(manager.sweep()).toEqual([]);

    clock += 31 * 60_000;
    manager.touch('grt_b', request);
    const swept = manager.sweep();
    expect(swept).toHaveLength(1);
    expect(swept[0]?.grantId).toBe('grt_a');
    expect(swept[0]?.reason).toBe('idle_gap');
    expect(manager.size).toBe(1);
  });

  it('endAll closes every live segment for the SIGTERM handler', () => {
    const manager = createSessionManager({ idleGapMinutes: 30, now: () => new Date(0) });
    manager.touch('grt_a', initialize);
    manager.touch('grt_b', initialize);
    const closed = manager.endAll('server_stopping');
    expect(closed).toHaveLength(2);
    expect(closed.every((session) => session.reason === 'server_stopping')).toBe(true);
    // `idle_ms` is meaningless for a shutdown and is reported as null, not as a number.
    expect(closed.every((session) => session.idleMs === null)).toBe(true);
    expect(manager.size).toBe(0);
  });

  it('keeps grants apart', () => {
    const manager = createSessionManager({ idleGapMinutes: 30, now: () => new Date(0) });
    expect(manager.touch('grt_a', initialize).xs).not.toBe(manager.touch('grt_b', initialize).xs);
    expect(manager.size).toBe(2);
  });
});
