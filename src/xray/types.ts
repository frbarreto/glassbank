/**
 * The shapes `createXray` is built from (block: xray).
 *
 * `XrayConfig` is a structural subset of `AppConfig` (src/config/types.ts) so the composition
 * root can pass its config straight through without this block importing it.
 */
import type {
  XrayBankSummary, JwtService, XrayPersonaSummary, ViewerKind } from '../contracts/index.js';

export interface XrayConfig {
  /** Fallback base URL; also the base every pairing link is built from (A-36). */
  readonly publicBaseUrl: string;
  /** `/tmp/xray.sqlite` by default; `:memory:` in tests (A-25). */
  readonly xrayDbPath: string;
  readonly xrayRetentionHours: number;
  /** Hard row cap on the event log; retention by time alone is not a memory bound. */
  readonly xrayMaxLogRows: number;
  /** Observer mode is off entirely when this is undefined (Decision D-5). */
  readonly xrayAdminToken: string | undefined;
  readonly rateLimits: {
    /** Failed pairing exchanges per IP per minute before `rate_limited` (invariant 14). */
    readonly ipPairFailuresPerMin: number;
  };
  /** Concurrent SSE streams one login may hold open. */
  readonly xrayMaxStreamsPerLogin: number;
  /** Concurrent SSE streams the whole process may hold open. */
  readonly xrayMaxStreams: number;
  /**
   * `XRAY_MAX_PUBLIC_STREAMS` (v0.7, D-26): concurrent streams of the public lane, all readers
   * together. Its own budget, so strangers watching the public lane cannot use up the streams a
   * paired viewer needs; still inside `xrayMaxStreams`.
   */
  readonly xrayMaxPublicStreams: number;
}

/** Resolves a persona for the dashboard. Injected by `app` from `bankCore.personas`. */
export type PersonaLookup = (personaId: string) => Promise<XrayPersonaSummary | null>;

/**
 * Resolves the persona card behind a session: balances and card counts with the login's overlay
 * applied (ADR-15). Injected by `app` from bank-core; `null` when the persona is unknown. Absent in
 * a unit test, where the route answers 503.
 */
export type BankSummaryLookup = (session: {
  readonly persona_id: string;
  readonly login_id: string | null;
  readonly grant_id: string | null;
}) => Promise<XrayBankSummary | null>;

/** Reported by `createXray().stats()`; the errors-and-health panel and the tests read it. */
export interface XrayStats {
  readonly emitted: number;
  readonly invalid: number;
  readonly pending: number;
  /** Events that never reached the log because the write queue was full. */
  readonly droppedFromLog: number;
  /** Frames a slow subscriber never received. */
  readonly droppedToSubscribers: number;
  readonly subscribers: number;
  readonly ringSize: number;
  /** Approximate characters the ring holds; the byte half of its bound. */
  readonly ringBytes: number;
  readonly nextId: number;
  readonly logDegraded: boolean;
  /** Rows in the event log right now. */
  readonly logRows: number;
  /**
   * What the log really costs. `/tmp` is memory-backed on Cloud Run gen2, so this is RAM, and a
   * deleted row that keeps its page still counts until `reclaim()` runs.
   */
  readonly logBytes: number;
  readonly logFreeBytes: number;
}

/** What a viewer's cookie resolved to. */
export interface ViewerIdentity {
  readonly viewer_kind: ViewerKind;
  readonly login_id: string | null;
  readonly expires_at: string;
}

export type { JwtService };
