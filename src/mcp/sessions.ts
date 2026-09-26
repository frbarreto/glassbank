/**
 * X-ray session segmentation (block: mcp).
 *
 * ADR-3: the transport is stateless, so there is no `Mcp-Session-Id` and no session map keyed on
 * one. The X-ray session `xs` is server-minted and keyed on the OAuth `grant_id`: a run of
 * requests from one grant is one `xs`, and silence longer than `XS_IDLE_GAP_MINUTES` starts a
 * new one (A-27). That is what survives claude.ai's frequent re-initializations.
 *
 * Two things beyond the id live here because nothing else can hold them:
 *
 *  - **the last-seen `clientInfo`.** Only `initialize` carries it, and this transport keeps no
 *    per-connection state, so a `tools/call` arriving two minutes later would otherwise have no
 *    client to report. The record carries it forward, which closes the T0.3 gap that left
 *    `AuthContext.client` null on every request but one (A-28: displayed, never trusted).
 *  - **the counters `session.ended` reports.** `session.ended` is emitted lazily - when the next
 *    request discovers the gap, when the sweep finds it, or on `server.stopping` - so the
 *    segment has to keep its own `call_count`, `error_count` and `initialize_count` until then
 *    (docs/XRAY_EVENT_MODEL.md section 4).
 */
import { ID_PREFIXES, type ClientInfo, type XrayEra } from '../contracts/index.js';

import { BoundedSessionMap } from './bounded-map.js';

/** One live segment. Mutable: the request in flight updates it in place. */
export interface SessionState {
  readonly xs: string;
  readonly grantId: string;
  /** How many `initialize` calls this `xs` has seen; a reconnect loop raises it. */
  initializeCount: number;
  callCount: number;
  errorCount: number;
  /** Carried forward from the last `initialize` of this segment (the T0.3 gap). */
  client: ClientInfo | null;
  protocolVersion: string | null;
  era: XrayEra | null;
  personaId: string | null;
  loginId: string | null;
  startedAt: number;
  lastSeenAt: number;
}

/** A segment that has closed and still owes the log a `session.ended` (section 4). */
export interface EndedSession {
  readonly xs: string;
  readonly grantId: string;
  readonly reason: 'idle_gap' | 'server_stopping';
  readonly idleMs: number | null;
  readonly durationMs: number;
  readonly callCount: number;
  readonly errorCount: number;
  readonly initializeCount: number;
  readonly client: ClientInfo | null;
  readonly protocolVersion: string | null;
  readonly era: XrayEra | null;
  readonly personaId: string | null;
  readonly loginId: string | null;
}

/** What the gate knows about the request that is touching the session. */
export interface SessionTouchInput {
  readonly isInitialize: boolean;
  readonly client?: ClientInfo | null;
  readonly protocolVersion?: string | null;
  readonly era?: XrayEra | null;
  readonly personaId?: string | null;
  readonly loginId?: string | null;
}

export interface SessionTouch {
  readonly xs: string;
  /** The live record, so the caller can read the carried-forward client and counters. */
  readonly session: SessionState;
  readonly started: boolean;
  readonly reason: 'first_request' | 'idle_gap' | null;
  readonly idleMs: number | null;
  readonly initializeCount: number;
  /** The segment this request closed, when the idle gap split it. `session.ended` for it. */
  readonly ended: EndedSession | null;
}

export interface SessionManagerOptions {
  readonly idleGapMinutes: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly capacity?: number;
}

export interface SessionManager {
  touch(grantId: string, input: SessionTouchInput): SessionTouch;
  /** Counters for `session.ended`; the transport calls these as a call starts and fails. */
  noteCall(grantId: string): void;
  noteError(grantId: string): void;
  /** Segments idle for longer than the gap, closed and removed. Drives the periodic sweep. */
  sweep(): EndedSession[];
  /** Closes every live segment; `src/app.ts` calls it from the SIGTERM handler. */
  endAll(reason: 'server_stopping'): EndedSession[];
  peek(grantId: string): SessionState | undefined;
  readonly size: number;
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const now = options.now ?? (() => new Date());
  const idleGapMs = Math.max(0, options.idleGapMinutes) * 60_000;
  const sessions = new BoundedSessionMap<string, SessionState>(options.capacity ?? 5000);
  let counter = 0;
  const newId =
    options.newId ??
    (() => {
      counter += 1;
      return `${ID_PREFIXES.session}${Date.now().toString(36)}${counter.toString(36)}`;
    });

  function close(
    state: SessionState,
    reason: 'idle_gap' | 'server_stopping',
    at: number,
  ): EndedSession {
    const idleMs = at - state.lastSeenAt;
    return {
      xs: state.xs,
      grantId: state.grantId,
      reason,
      idleMs: reason === 'idle_gap' ? idleMs : null,
      durationMs: Math.max(0, state.lastSeenAt - state.startedAt),
      callCount: state.callCount,
      errorCount: state.errorCount,
      initializeCount: state.initializeCount,
      client: state.client,
      protocolVersion: state.protocolVersion,
      era: state.era,
      personaId: state.personaId,
      loginId: state.loginId,
    };
  }

  function start(grantId: string, input: SessionTouchInput, at: number): SessionState {
    const state: SessionState = {
      xs: newId(),
      grantId,
      initializeCount: input.isInitialize ? 1 : 0,
      callCount: 0,
      errorCount: 0,
      client: input.client ?? null,
      protocolVersion: input.protocolVersion ?? null,
      era: input.era ?? null,
      personaId: input.personaId ?? null,
      loginId: input.loginId ?? null,
      startedAt: at,
      lastSeenAt: at,
    };
    sessions.set(grantId, state);
    return state;
  }

  /** Whatever this request revealed wins; whatever it did not reveal is carried forward. */
  function absorb(state: SessionState, input: SessionTouchInput): void {
    if (input.client != null) state.client = input.client;
    if (input.protocolVersion != null) state.protocolVersion = input.protocolVersion;
    if (input.era != null) state.era = input.era;
    if (input.personaId != null) state.personaId = input.personaId;
    if (input.loginId != null) state.loginId = input.loginId;
  }

  return {
    get size() {
      return sessions.size;
    },

    peek(grantId: string) {
      return sessions.peek(grantId);
    },

    noteCall(grantId: string) {
      const state = sessions.peek(grantId);
      if (state !== undefined) state.callCount += 1;
    },

    noteError(grantId: string) {
      const state = sessions.peek(grantId);
      if (state !== undefined) state.errorCount += 1;
    },

    touch(grantId: string, input: SessionTouchInput): SessionTouch {
      const at = now().getTime();
      const existing = sessions.get(grantId);

      if (existing === undefined) {
        const state = start(grantId, input, at);
        return {
          xs: state.xs,
          session: state,
          started: true,
          reason: 'first_request',
          idleMs: null,
          initializeCount: state.initializeCount,
          ended: null,
        };
      }

      const idleMs = at - existing.lastSeenAt;
      if (idleGapMs > 0 && idleMs > idleGapMs) {
        // A-27: the gap closes the old segment and opens a new one. The client is carried into
        // the new segment, because the connector does not re-`initialize` on every gap.
        const ended = close(existing, 'idle_gap', at);
        const state = start(
          grantId,
          {
            ...input,
            client: input.client ?? existing.client,
            protocolVersion: input.protocolVersion ?? existing.protocolVersion,
            era: input.era ?? existing.era,
          },
          at,
        );
        return {
          xs: state.xs,
          session: state,
          started: true,
          reason: 'idle_gap',
          idleMs,
          initializeCount: state.initializeCount,
          ended,
        };
      }

      // A re-`initialize` inside a live session raises the counter; it never starts a new `xs`
      // (docs/XRAY_EVENT_MODEL.md section 4: claude.ai's reconnect loops are one session).
      existing.lastSeenAt = at;
      if (input.isInitialize) existing.initializeCount += 1;
      absorb(existing, input);
      sessions.set(grantId, existing);
      return {
        xs: existing.xs,
        session: existing,
        started: false,
        reason: null,
        idleMs,
        initializeCount: existing.initializeCount,
        ended: null,
      };
    },

    sweep(): EndedSession[] {
      if (idleGapMs <= 0) return [];
      const at = now().getTime();
      const closed: EndedSession[] = [];
      for (const [grantId, state] of sessions.entries()) {
        if (at - state.lastSeenAt > idleGapMs) {
          closed.push(close(state, 'idle_gap', at));
          sessions.delete(grantId);
        }
      }
      return closed;
    },

    endAll(reason: 'server_stopping'): EndedSession[] {
      const at = now().getTime();
      const closed: EndedSession[] = [];
      for (const [, state] of sessions.entries()) closed.push(close(state, reason, at));
      sessions.clear();
      return closed;
    },
  };
}
