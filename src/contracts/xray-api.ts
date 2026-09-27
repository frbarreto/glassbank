/**
 * The X-ray HTTP read model (block: contracts).
 *
 * One type per route of docs/XRAY_EVENT_MODEL.md section 6, plus the SSE frame shape and the
 * transport constants of section 5. The dashboard consumes these shapes over HTTP only
 * (docs/REPO_LAYOUT.md section 3), so this file is also the specification it is written against.
 *
 * Pure types. No I/O.
 */
import type {
  AuthLevel,
  CatalogTool,
  ClientInfo,
  ToolAvailability,
  ViewerFilter,
  ViewerKind,
  XrayEra,
  XrayEvent,
} from './events.js';
import type { AccountStatus, AccountType, PersonaKind } from './bank.js';
import type { Scope } from './scopes.js';

// ---------------------------------------------------------------------------
// Routes and transport constants
// ---------------------------------------------------------------------------

/** Every route of the dashboard, in one place. `:code` and `:xs` are Express parameters. */
export const XRAY_ROUTES = {
  spa: '/xray/',
  assets: '/xray/assets',
  /** Fixture mode serves `test/fixtures/events.jsonl` to the SPA (`?fixture=1`). */
  fixtures: '/xray/fixtures/events.jsonl',
  pairingLanding: '/xray/s/:code',
  pair: '/xray/api/pair',
  admin: '/xray/api/admin',
  me: '/xray/api/me',
  sessions: '/xray/api/sessions',
  session: '/xray/api/sessions/:xs',
  sessionEvents: '/xray/api/sessions/:xs/events',
  /** v0.3: the persona behind a session with its balances, for the dashboard's persona card. */
  sessionBank: '/xray/api/sessions/:xs/bank',
  /** v0.4: `DELETE` erases every event of the viewer's login. `GET` is not served. */
  events: '/xray/api/events',
  catalog: '/xray/api/catalog',
  stream: '/xray/api/stream',
  healthz: '/healthz',
  /**
   * v0.6: the same handler as `healthz`. On Cloud Run, Google's front end answers `/healthz` itself
   * with a 404 and never forwards it (observed 2026-09-26), so `/health` is the public name and
   * `/healthz` stays for local tooling.
   */
  health: '/health',
  /**
   * v0.8 (D-27): `GET` downloads the event log as JSONL, one stored envelope per line, oldest
   * first - the copy that survives a restart, a push or `make pause`. Same scopes as `stream`,
   * never observer-redacted; `Authorization: Bearer <XRAY_ADMIN_TOKEN>` stands in for the admin
   * cookie so one `curl` is enough (`XrayExportQuery`).
   */
  export: '/xray/api/export',
} as const;

/**
 * v0.7 (D-26): `?lane=public` on any read route - `me`, `sessions`, `session`, `sessionEvents`,
 * `catalog`, `stream` - answers for the public lane without a cookie: `viewer_kind: 'public'`,
 * bound to `PUBLIC_LOGIN_ID`, read-only. The cookie, when present, is ignored for that request, so
 * one browser can keep a paired tab and a public tab open side by side.
 */
export const PUBLIC_LANE_QUERY = { lane: 'public' } as const;

/** SSE transport (docs/XRAY_EVENT_MODEL.md section 5). */
export const SSE_EVENT_NAME = 'xray';
export const SSE_RETRY_MS = 2000;
export const SSE_HEARTBEAT_MS = 20_000;
/** Events replayed when the browser connects without `Last-Event-ID`. */
export const INITIAL_REPLAY = 200;
/** `GET /xray/api/sessions/:xs/events?limit=` is capped here. */
export const MAX_EVENTS_PAGE_LIMIT = 500;
/** Live fan-out ring buffer size. */
export const RING_BUFFER_SIZE = 10_000;
/** Result previews are truncated to this many characters before storage. */
export const RESULT_PREVIEW_BYTES = 2048;
/** Observer mode masks `rationale` to this many characters and hides arguments entirely. */
export const OBSERVER_RATIONALE_PREVIEW_CHARS = 80;
/** v0.8: the body of `GET /xray/api/export`, the same line format as `test/fixtures/events.jsonl`. */
export const XRAY_EXPORT_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

/** The headers every SSE response carries. */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Every failing X-ray API response has this body. */
export interface XrayErrorResponse {
  readonly error: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Pairing and viewer identity
// ---------------------------------------------------------------------------

/** `POST /xray/api/pair` body. */
export interface PairRequest {
  readonly code: string;
}

/** `POST /xray/api/admin` body (Decision D-5, the single observer entry point). */
export interface AdminRequest {
  readonly token: string;
}

/** What both exchanges answer with on success; the viewer cookie is set as a side effect. */
export interface PairResponse {
  readonly ok: true;
  readonly viewer_kind: ViewerKind;
  /** `null` in observer mode, which is not bound to a login. */
  readonly login_id: string | null;
  readonly expires_at: string;
}

/** The persona as the dashboard shows it; never carries account numbers. */
export interface XrayPersonaSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: PersonaKind;
  /** Drives the "shared demo persona" banner (ADR-15). */
  readonly shared: boolean;
}

/** `GET /xray/api/me`. */
export interface ViewerMeResponse {
  readonly viewer_kind: ViewerKind;
  /** Absent in observer mode. */
  readonly login_id?: string | null;
  /** Every grant of the viewer's login; absent in observer mode. */
  readonly grant_ids?: readonly string[];
  readonly persona?: XrayPersonaSummary | null;
  readonly expires_at: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** One row of the Sessions panel. */
export interface XraySessionSummary {
  readonly xs: string;
  readonly login_id: string | null;
  readonly grant_id: string | null;
  readonly parent_grant_id: string | null;
  readonly persona: XrayPersonaSummary | null;
  /** `clientInfo` verbatim; displayed, never trusted (A-28). */
  readonly client: ClientInfo | null;
  readonly protocol_version: string | null;
  readonly era: XrayEra | null;
  readonly started_at: string;
  readonly last_seen_at: string;
  /** How many `initialize` calls this `xs` saw; a reconnect-loop health signal (A-27). */
  readonly initialize_count: number;
  readonly call_count: number;
  readonly error_count: number;
  readonly token_expires_at: string | null;
  /** Changes across a restart, so the dashboard can draw a restart marker (A-15). */
  readonly boot_id: string | null;
}

/** `GET /xray/api/sessions`; Ramp's `{data, page: {next}}` envelope. */
export interface XraySessionsResponse {
  readonly data: readonly XraySessionSummary[];
  readonly page: { readonly next: string | null };
}

/** The grant facts the Session and auth panel shows. */
export interface XrayGrantFacts {
  readonly grant_id: string;
  readonly parent_grant_id: string | null;
  readonly login_id: string | null;
  readonly scopes: readonly Scope[];
  readonly auth_level: AuthLevel;
  readonly client_id: string;
  readonly client_name: string | null;
  /** True when the client had to be rebuilt after a restart (A-12). */
  readonly client_reconstructed: boolean;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly revoked: boolean;
}

/** The catalog snapshot a client actually received, for the Possibility space panel. */
export interface XrayCatalogSnapshot {
  readonly xs: string;
  readonly content_hash: string;
  readonly captured_at: string;
  /** The id of the `catalog.tools_listed` event this snapshot came from. */
  readonly event_id: number;
  readonly tools: readonly CatalogTool[];
  readonly availability: readonly ToolAvailability[];
  readonly feature_flags: readonly string[];
}

/** Counters computed from the event log for one session. */
export interface XraySessionCounters {
  readonly events: number;
  readonly calls: number;
  readonly errors: number;
  readonly protocol_errors: number;
  readonly tables_loaded: number;
  readonly queries: number;
  readonly bank_operations: number;
}

/** `GET /xray/api/sessions/:xs`. */
export interface XraySessionDetailResponse {
  readonly session: XraySessionSummary;
  readonly grant: XrayGrantFacts | null;
  readonly catalog: XrayCatalogSnapshot | null;
  readonly availability: readonly ToolAvailability[];
  readonly counters: XraySessionCounters;
}

/** `GET /xray/api/sessions/:xs/events?after=&limit=`. */
export interface XraySessionEventsQuery {
  /** Return events with `id` greater than this. */
  readonly after?: number;
  /** At most `MAX_EVENTS_PAGE_LIMIT` (500). */
  readonly limit?: number;
}

export interface XraySessionEventsResponse {
  readonly data: readonly XrayEvent[];
  readonly page: { readonly next: string | null };
}

/** `GET /xray/api/catalog?xs=`. */
export interface XrayCatalogQuery {
  readonly xs: string;
}

export type XrayCatalogResponse = XrayCatalogSnapshot;

// ---------------------------------------------------------------------------
// The SSE stream
// ---------------------------------------------------------------------------

/**
 * `GET /xray/api/stream?xs=<id>` | `?login=me` | `?all=1`. Exactly one of the three is set;
 * `all=1` needs the admin cookie.
 */
export interface XrayStreamQuery {
  readonly xs?: string;
  readonly login?: 'me';
  readonly all?: '1';
  /** v0.7: the public lane, no cookie needed (`PUBLIC_LANE_QUERY`). */
  readonly lane?: 'public';
}

/**
 * `GET /xray/api/export` (v0.8, D-27): the scope of `XrayStreamQuery`, plus `after` to fetch only
 * what is newer than the last line of a previous export. The answer is JSONL
 * (`XRAY_EXPORT_CONTENT_TYPE`): every event the scope may read with `id > after`, up to the newest
 * id at the moment of the request, verbatim as stored. No observer redaction, not even for the
 * admin reader, because the export is the operator's copy of the log. An empty scope answers 200
 * with an empty body.
 */
export interface XrayExportQuery extends XrayStreamQuery {
  readonly after?: number;
}

/** What the viewer's cookie resolves to before any event is fanned out. */
export interface XrayViewerScope {
  readonly viewer_kind: ViewerKind;
  readonly filter: ViewerFilter;
  readonly login_id: string | null;
  readonly xs: string | null;
}

/** One `text/event-stream` frame: `event: xray`, `id: <event id>`, `data: <envelope JSON>`. */
export interface XrayStreamFrame {
  readonly event: typeof SSE_EVENT_NAME;
  readonly id: number;
  readonly data: XrayEvent;
}

/** Serialises one frame exactly as the wire format requires, trailing blank line included. */
export function renderStreamFrame(frame: XrayStreamFrame): string {
  return `event: ${frame.event}\nid: ${frame.id}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Erasing history (v0.4, additive)
// ---------------------------------------------------------------------------

/**
 * `DELETE /xray/api/sessions/:xs` (one session) and `DELETE /xray/api/events` (every session of
 * the viewer's login). Only a pairing viewer may erase, and only its own login's events: observer
 * mode is read-only, so an operator cannot wipe someone else's history (invariant 11).
 *
 * The erase is real - the SQLite log, the live ring buffer and the read model all forget - and it
 * leaves one `xray.events.deleted` event behind, because a page that can destroy its own evidence
 * silently is worse than one that cannot (invariant 13).
 */
export interface XrayDeleteResponse {
  /** How many events were removed from the log. */
  readonly deleted: number;
  /** How many sessions disappeared with them. */
  readonly sessions: number;
  /** `session` for one `xs`, `login` for the whole login. */
  readonly scope: 'session' | 'login';
}

// ---------------------------------------------------------------------------
// Persona card (v0.3, additive): GET /xray/api/sessions/:xs/bank
// ---------------------------------------------------------------------------

/** One account as the persona card shows it; never carries account numbers. Amounts are cents (D-1). */
export interface XrayBankAccount {
  readonly account_id: string;
  readonly name: string;
  readonly account_type: AccountType;
  readonly currency: string;
  readonly balance_cents: number;
  readonly available_balance_cents: number;
  readonly credit_limit_cents: number | null;
  readonly status: AccountStatus;
}

/** Card counts by status for the persona card. */
export interface XrayBankCardCounts {
  readonly total: number;
  readonly active: number;
  readonly locked: number;
  readonly fraud_locked: number;
}

/**
 * The persona behind a session as the bank sees it right now, overlay applied (ADR-15): the
 * same numbers `load_accounts` and `load_cards` return to the model. Produced by the app block
 * from bank-core and injected into `xray`; `xray` never imports bank-core.
 */
export interface XrayBankSummary {
  readonly persona: XrayPersonaSummary;
  readonly currency: string;
  /** When the balances were computed (ISO 8601). */
  readonly as_of: string;
  readonly accounts: readonly XrayBankAccount[];
  /** Ledger balance of the open deposit accounts. */
  readonly total_cash_cents: number;
  /** Available balance of the open deposit accounts. */
  readonly total_available_cents: number;
  /** Owed on the open credit-card accounts, as a positive number. */
  readonly total_credit_owed_cents: number;
  /** `total_cash_cents - total_credit_owed_cents`. */
  readonly net_position_cents: number;
  readonly cards: XrayBankCardCounts;
  readonly transfer_limit_cents: number;
}

/** `GET /xray/api/sessions/:xs/bank`. Same visibility rule as `GET /xray/api/sessions/:xs`. */
export interface XraySessionBankResponse extends XrayBankSummary {
  readonly xs: string;
  readonly login_id: string | null;
}

// ---------------------------------------------------------------------------
// /health and its alias /healthz (owned by the app block; typed here so the dashboard can read it)
// ---------------------------------------------------------------------------

export interface HealthzResponse {
  readonly status: 'ok';
  readonly boot_id: string;
  readonly version: string;
  readonly origin_policy: string;
  readonly uptime_s: number;
}
