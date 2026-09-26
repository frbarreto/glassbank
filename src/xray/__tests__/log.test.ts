/**
 * The SQLite event log and the retention job (docs/XRAY_EVENT_MODEL.md section 5, A-25).
 */
import { describe, expect, it } from 'vitest';

import { createEventLog, createNullEventLog } from '../log.js';
import { createHarness, createTempDb } from './harness.js';

function emitCall(harness: ReturnType<typeof createHarness>, xs: string): void {
  harness.xray.emitter.emit(
    'tool.call.started',
    { tool: 'load_accounts', arguments: { limit: 10 }, rationale_present: false },
    { xs, login_id: 'lgn_retention', grant_id: 'grt_retention' },
  );
}

describe('retention (XRAY_RETENTION_HOURS)', () => {
  it('deletes events older than the retention window and keeps the rest', () => {
    let clock = new Date('2026-09-01T00:00:00.000Z');
    const harness = createHarness({ dbPath: ':memory:', now: () => clock });
    try {
      emitCall(harness, 'xs_old0001');
      emitCall(harness, 'xs_old0001');
      harness.xray.flush();
      expect(harness.xray.log.count()).toBe(2);

      // 71 hours later: still inside the 72-hour window.
      clock = new Date('2026-09-03T23:00:00.000Z');
      expect(harness.xray.runRetention()).toBe(0);
      expect(harness.xray.log.count()).toBe(2);

      // One more event, then far enough forward that only the new one survives.
      emitCall(harness, 'xs_new0001');
      clock = new Date('2026-09-04T01:00:00.000Z');
      expect(harness.xray.runRetention()).toBe(2);
      expect(harness.xray.log.count()).toBe(1);
      const survivors = harness.xray.log.readSession('xs_new0001', 0, 10);
      expect(survivors).toHaveLength(1);
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });

  it('flushes what is queued before it deletes, so a fresh event is never lost', () => {
    const clock = new Date('2026-09-01T00:00:00.000Z');
    const harness = createHarness({ dbPath: ':memory:', now: () => clock });
    try {
      emitCall(harness, 'xs_pending1');
      expect(harness.xray.stats().pending).toBe(1);
      harness.xray.runRetention();
      expect(harness.xray.stats().pending).toBe(0);
      expect(harness.xray.log.count()).toBe(1);
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });
});

describe('the log across a restart', () => {
  it('rebuilds the session list from the restored rows', () => {
    const temporary = createTempDb();
    try {
      const first = createHarness({
        dbPath: temporary.path,
        bootId: 'boot_one',
        emitServerStarted: true,
      });
      first.xray.emitter.emit(
        'auth.grant.created',
        {
          grant_id: 'grt_survive',
          login_id: 'lgn_survive',
          persona_id: 'per_survive',
          scopes: ['accounts:read'],
          auth_level: 'read_only',
          client_id: 'cli_abc',
        },
        { login_id: 'lgn_survive', grant_id: 'grt_survive' },
      );
      first.xray.emitter.emit(
        'tool.call.started',
        { tool: 'load_accounts', arguments: {}, rationale_present: false },
        { xs: 'xs_survive1', login_id: 'lgn_survive', grant_id: 'grt_survive' },
      );
      first.xray.shutdown('shutdown');

      const second = createHarness({ dbPath: temporary.path, bootId: 'boot_two' });
      const sessions = second.xray.readModel.sessions({
        viewer_kind: 'pairing',
        filter: 'login',
        login_id: 'lgn_survive',
        xs: null,
      });
      expect(sessions.map((row) => row.xs)).toEqual(['xs_survive1']);
      expect(sessions[0]?.grant_id).toBe('grt_survive');
      // The restored session still carries the boot it belonged to, so the dashboard can draw
      // the restart marker (A-15).
      expect(sessions[0]?.boot_id).toBe('boot_one');
      expect(second.xray.readModel.grant('grt_survive')?.login_id).toBe('lgn_survive');
      second.xray.shutdown('shutdown');
    } finally {
      temporary.cleanup();
    }
  });

  it('falls back to a null log rather than throwing when the file cannot be opened', () => {
    const errors: string[] = [];
    // A directory is not a database file.
    const log = createEventLog({ path: '/', onError: (_error, where) => errors.push(where) });
    expect(log.degraded).toBe(true);
    expect(errors).toContain('open');
    expect(() => log.append([])).not.toThrow();
    expect(log.maxId()).toBe(0);
  });

  it('answers everything empty when it is the null log', () => {
    const log = createNullEventLog();
    expect(log.readAfter(0, 10, { kind: 'all' })).toEqual([]);
    expect(log.readLast(10, { kind: 'all' })).toEqual([]);
    expect(log.seqByXs().size).toBe(0);
    expect(log.deleteOlderThan(Date.now())).toBe(0);
  });
});

describe('the log is bounded by size, not only by age', () => {
  it('trims to XRAY_MAX_LOG_ROWS and gives the pages back', () => {
    const temporary = createTempDb();
    try {
      const harness = createHarness({ dbPath: temporary.path, maxLogRows: 50 });
      try {
        for (let index = 0; index < 400; index += 1) emitCall(harness, 'xs_bulk0001');
        harness.xray.flush();
        expect(harness.xray.log.count()).toBe(400);
        const grown = harness.xray.stats();
        expect(grown.logRows).toBe(400);
        expect(grown.logBytes).toBeGreaterThan(0);

        // Every event is well inside the 72-hour window, so age alone would delete nothing.
        const removed = harness.xray.runRetention();
        expect(removed).toBe(350);
        expect(harness.xray.log.count()).toBe(50);
        // The newest rows are the ones that survived.
        const kept = harness.xray.log.recent(50);
        expect(kept).toHaveLength(50);

        // And the space really came back rather than sitting on the free list (A-25: /tmp is RAM).
        const trimmed = harness.xray.stats();
        expect(trimmed.logBytes).toBeLessThan(grown.logBytes);
        expect(trimmed.logFreeBytes).toBe(0);
      } finally {
        harness.xray.shutdown();
      }
    } finally {
      temporary.cleanup();
    }
  });
});

describe('deleteMatching (v0.4): a viewer erases exactly what it could read', () => {
  /** One emitter call, correlated however the test needs. */
  function emit(
    harness: ReturnType<typeof createHarness>,
    correlation: { xs?: string; login_id?: string; grant_id?: string },
  ): void {
    harness.xray.emitter.emit(
      'tool.call.started',
      { tool: 'load_accounts', arguments: {}, rationale_present: false },
      correlation,
    );
  }

  it('erases one session and leaves every other row alone', () => {
    const harness = createHarness({ dbPath: ':memory:' });
    try {
      emit(harness, { xs: 'xs_a0000001', login_id: 'lgn_one00001', grant_id: 'grt_one00001' });
      emit(harness, { xs: 'xs_b0000001', login_id: 'lgn_one00001', grant_id: 'grt_one00001' });
      emit(harness, { xs: 'xs_c0000001', login_id: 'lgn_two00001', grant_id: 'grt_two00001' });
      harness.xray.flush();
      expect(harness.xray.log.count()).toBe(3);

      expect(harness.xray.log.deleteMatching({ kind: 'xs', xs: 'xs_a0000001' })).toBe(1);
      expect(harness.xray.log.count()).toBe(2);
      expect(harness.xray.log.readSession('xs_a0000001', 0, 10)).toEqual([]);
      expect(harness.xray.log.readSession('xs_b0000001', 0, 10)).toHaveLength(1);
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });

  it('erases a login by its own id, by its sessions and by its grants', () => {
    const harness = createHarness({ dbPath: ':memory:' });
    try {
      emit(harness, { xs: 'xs_a0000001', login_id: 'lgn_one00001', grant_id: 'grt_one00001' });
      // Correlated to the login only through the session, which is how an early event arrives.
      emit(harness, { xs: 'xs_a0000001' });
      // Correlated only through the grant, which is how a token event arrives.
      emit(harness, { grant_id: 'grt_one00001' });
      emit(harness, { xs: 'xs_z0000001', login_id: 'lgn_two00001', grant_id: 'grt_two00001' });
      harness.xray.flush();

      const removed = harness.xray.log.deleteMatching({
        kind: 'login',
        loginId: 'lgn_one00001',
        sessionIds: ['xs_a0000001'],
        grantIds: ['grt_one00001'],
      });
      expect(removed).toBe(3);
      expect(harness.xray.log.count()).toBe(1);
      expect(harness.xray.log.readSession('xs_z0000001', 0, 10)).toHaveLength(1);
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });

  it('refuses `kind: all`, which would erase every login at once', () => {
    const harness = createHarness({ dbPath: ':memory:' });
    try {
      emit(harness, { xs: 'xs_a0000001', login_id: 'lgn_one00001', grant_id: 'grt_one00001' });
      harness.xray.flush();
      expect(harness.xray.log.deleteMatching({ kind: 'all' })).toBe(0);
      expect(harness.xray.log.count()).toBe(1);
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });
});
