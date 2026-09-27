/**
 * Presentation metadata for the event catalogue (block: dashboard).
 *
 * `src/contracts/events.ts` defines what an event *is*; this file defines what it *reads like*.
 * Every known type gets a short label, a family, a severity and a one-line English summary built
 * from its `data`. Unknown types fall through to a generic row plus raw JSON, which is what lets
 * the server ship an event family before the UI knows about it
 * (docs/XRAY_EVENT_MODEL.md section 1).
 *
 * Pure functions. No DOM.
 */
import { charCount, clip, count, duration, joinList, oneLineSql } from './format.js';
import { webBotAuthOf } from './raw-headers.js';

/** The twelve families of docs/XRAY_EVENT_MODEL.md section 3, plus `other` for the unknown. */
export const FAMILIES = [
  'server',
  'http',
  'auth',
  'session',
  'catalog',
  'tool',
  'protocol',
  'bank',
  'etl',
  'sql',
  'intent',
  'xray',
];

/** How each family is labelled in filter chips and legends. */
export const FAMILY_LABELS = {
  server: 'Server',
  http: 'HTTP',
  auth: 'Auth',
  session: 'Session',
  catalog: 'Catalog',
  tool: 'Tool call',
  protocol: 'Protocol',
  bank: 'Bank',
  etl: 'ETL',
  sql: 'SQL',
  intent: 'Intent',
  xray: 'X-ray',
  other: 'Other',
};

/** `tool.call.started` -> `tool`; anything unrecognised is `other`. */
export function familyOf(type) {
  const family = String(type ?? '').split('.')[0];
  return FAMILIES.includes(family) ? family : 'other';
}

/** Short glyph shown at the head of a timeline row. Text, never an emoji. */
export const FAMILY_GLYPHS = {
  server: 'SRV',
  http: 'HTTP',
  auth: 'AUTH',
  session: 'SESS',
  catalog: 'CAT',
  tool: 'TOOL',
  protocol: 'RPC',
  bank: 'BANK',
  etl: 'ETL',
  sql: 'SQL',
  intent: 'WHY',
  xray: 'XRAY',
  other: '?',
};

const DENIED_REASONS = {
  insufficient_scope: 'the grant is missing a write scope',
  rate_limited: 'the per-grant call limit was hit',
  feature_flag: 'the deployment flag for this tool is off',
};

const SQL_REJECTIONS = {
  not_readonly: 'statement is not read-only',
  denylist: 'statement hit the token deny-list',
  timeout: 'query exceeded the time budget',
  unknown_table: 'table is not loaded',
  multi_statement: 'more than one statement was submitted',
  row_cap: 'result exceeded the row cap',
};

const AUTH_REJECTIONS = {
  no_access_token: 'no access token',
  malformed: 'malformed token',
  invalid_signature: 'invalid signature',
  expired: 'token expired',
  wrong_typ: 'wrong token type',
  bad_audience: 'wrong audience',
  revoked_grant: 'grant revoked',
  unknown_client: 'unknown client',
  invalid_grant: 'invalid grant',
};

const PAIRING_REJECTIONS = {
  unknown_code: 'unknown code',
  expired: 'code expired',
  rate_limited: 'too many attempts',
  malformed: 'malformed code',
};

const EVICTION_REASONS = {
  ttl: 'time to live',
  grant_cap: 'per-grant table cap',
  global_cap: 'global scratch-database cap',
  timeout: 'query timeout',
};

const SESSION_START_REASONS = {
  first_request: 'first authenticated request for this grant',
  idle_gap: 'a new segment after an idle gap',
};

/** The human label of each known type; the key set is the "known" set for the raw-JSON fallback. */
export const TYPE_LABELS = {
  'server.started': 'Server started',
  'server.stopping': 'Server stopping',
  'http.request': 'HTTP request',
  'auth.challenge': 'Auth challenge',
  'auth.verified': 'Bearer accepted',
  'auth.rejected': 'Bearer rejected',
  'auth.client.registered': 'Client registered',
  'auth.client.reconstructed': 'Client reconstructed',
  'auth.grant.created': 'Grant created',
  'auth.grant.updated': 'Grant extended',
  'auth.token.issued': 'Access token issued',
  'auth.token.refreshed': 'Access token refreshed',
  'auth.token.revoked': 'Token revoked',
  'auth.stepup.requested': 'Step-up requested',
  'auth.login.created': 'Login created',
  'session.started': 'Session started',
  'session.initialized': 'initialize',
  'session.ended': 'Session ended',
  'session.rejected': 'Session rejected',
  'catalog.tools_listed': 'tools/list',
  'catalog.resources_listed': 'resources/list',
  'catalog.prompts_listed': 'prompts/list',
  'catalog.availability': 'Availability computed',
  'tool.call.started': 'Call started',
  'tool.call.completed': 'Call completed',
  'tool.call.cancelled': 'Call cancelled',
  'tool.call.denied': 'Call denied',
  'protocol.error': 'JSON-RPC error',
  'bank.op': 'Bank operation',
  'etl.load': 'Table loaded',
  'etl.processed': 'Table processed',
  'etl.table_evicted': 'Table evicted',
  'etl.limit_reached': 'ETL limit reached',
  'etl.worker_terminated': 'Query runner killed',
  'sql.query': 'SQL query',
  'sql.table_cleared': 'Table cleared',
  'sql.rejected': 'SQL rejected',
  'intent.declared': 'Rationale',
  'intent.inferred': 'Inferred workflow',
  'intent.missing': 'Rationale missing',
  'xray.pairing.created': 'Pairing code issued',
  'xray.pairing.rejected': 'Pairing rejected',
  'xray.viewer.connected': 'Viewer connected',
  'xray.viewer.disconnected': 'Viewer disconnected',
  'xray.dropped': 'Events dropped',
  /** v0.4: the one record an erase leaves behind, so a page cannot destroy its evidence silently. */
  'xray.events.deleted': 'History erased',
};

export const KNOWN_TYPES = Object.keys(TYPE_LABELS);

export function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(TYPE_LABELS, type);
}

export function labelOf(type) {
  return TYPE_LABELS[type] ?? String(type ?? 'unknown event');
}

/**
 * Severity, used for the row tone, the status filter and the Errors panel.
 * `ok` | `error` | `warn` | `denied` | `running` | `info`.
 */
export function statusOf(event) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case 'tool.call.completed':
      return data.is_error ? 'error' : 'ok';
    case 'tool.call.started':
      return 'running';
    case 'tool.call.denied':
      return 'denied';
    case 'tool.call.cancelled':
      return 'warn';
    case 'protocol.error':
    case 'sql.rejected':
    case 'auth.rejected':
    case 'session.rejected':
    case 'xray.pairing.rejected':
    case 'etl.worker_terminated':
      return 'error';
    case 'auth.challenge':
      return Number(data.status ?? 401) >= 400 ? 'warn' : 'info';
    case 'auth.stepup.requested':
    case 'etl.limit_reached':
    case 'etl.table_evicted':
    case 'xray.dropped':
    case 'intent.missing':
      return 'warn';
    case 'bank.op':
      return data.ok === false ? 'error' : 'ok';
    case 'http.request': {
      const status = Number(data.status ?? 0);
      if (data.rate_limited || status >= 500) return 'error';
      if (status >= 400) return 'warn';
      return 'info';
    }
    case 'server.started':
    case 'server.stopping':
      return 'notice';
    default:
      return 'info';
  }
}

export const STATUS_LABELS = {
  ok: 'OK',
  notice: 'Notice',
  error: 'Error',
  warn: 'Warning',
  denied: 'Denied',
  running: 'In flight',
  info: 'Info',
};

/** The tool this event belongs to, when it names one; drives the `tool:` filter. */
export function toolOf(event) {
  const data = event?.data ?? {};
  if (typeof data.tool === 'string') return data.tool;
  if (typeof data.source_tool === 'string') return data.source_tool;
  return null;
}

function scopeCount(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  return `${list.length} scope${list.length === 1 ? '' : 's'}`;
}

/**
 * The one-line English summary of an event. This is what makes the timeline scannable, so every
 * branch names the thing that actually happened rather than restating the type.
 */
export function summaryOf(event) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case 'server.started':
      return `Version ${data.version ?? 'unknown'} on ${data.node_version ?? 'unknown Node'} · boot ${
        data.boot_id ?? '-'
      }${data.restored_max_id ? ` · restored up to event ${count(data.restored_max_id)}` : ''}`;
    case 'server.stopping':
      return `Reason ${data.reason ?? 'sigterm'}${
        data.uptime_s === null || data.uptime_s === undefined
          ? ''
          : ` · up ${duration(Number(data.uptime_s) * 1000)}`
      }`;
    case 'http.request':
      return `${data.method ?? '?'} ${data.path ?? '?'} → ${data.status ?? '?'} · ${duration(
        data.duration_ms,
      )}${data.sse ? ' · stream' : ''}${data.rate_limited ? ' · rate limited' : ''}${
        data.origin_decision === 'rejected' ? ' · origin rejected' : ''
      }${webBotAuthOf(data.raw) ? ' · signed (Web Bot Auth)' : ''}`;
    case 'auth.challenge':
      return `${data.status ?? 401} with scope hint "${clip(data.scope, 60)}"${
        data.error ? ` · ${data.error}` : ''
      }`;
    case 'auth.verified':
      return `${data.auth_level ?? 'read_only'} grant · ${scopeCount(data.scopes)} · client ${
        data.client_name ?? data.client_id ?? 'unknown'
      }`;
    case 'auth.rejected':
      return `${AUTH_REJECTIONS[data.reason] ?? data.reason ?? 'rejected'} · ${data.error ?? ''}`.trim();
    case 'auth.client.registered':
      return `${data.client_name ?? 'unnamed client'} · ${
        (data.redirect_uris ?? []).length
      } redirect URI(s) · auth method ${data.token_endpoint_auth_method ?? 'none'}`;
    case 'auth.client.reconstructed':
      return `${data.client_name ?? 'unknown (reconstructed)'} · ${data.reason ?? ''}`;
    case 'auth.grant.created':
      return `${data.auth_level ?? 'read_only'} · ${scopeCount(data.scopes)}${
        data.parent_grant_id ? ` · extends ${data.parent_grant_id}` : ''
      }${data.shared_persona ? ' · shared demo persona' : ''}`;
    case 'auth.grant.updated':
      return `Same grant, widened: +${joinList(data.added_scopes, 'nothing')} · now ${
        data.auth_level ?? 'read_write'
      }`;
    case 'auth.token.issued':
    case 'auth.token.refreshed':
      return `${scopeCount(data.scopes)} · access expires ${clip(data.expires_at, 24)}`;
    case 'auth.token.revoked':
      return `Reason ${data.reason ?? 'revocation_request'}`;
    case 'auth.stepup.requested':
      return `${data.tool ?? 'a tool'} needs ${joinList(data.missing_scopes)} · answered ${
        data.status ?? 403
      } insufficient_scope`;
    case 'auth.login.created':
      return `Persona ${data.persona_id ?? '-'} · ${data.persona_source ?? 'seeded'}${
        data.shared_persona ? ' · shared demo persona' : ''
      }`;
    case 'session.started':
      return `${SESSION_START_REASONS[data.reason] ?? data.reason ?? 'started'}${
        data.idle_ms ? ` · after ${duration(data.idle_ms)} of silence` : ''
      }`;
    case 'session.initialized':
      return `Protocol ${data.protocol_version_negotiated ?? '?'}${
        data.protocol_version_requested &&
        data.protocol_version_requested !== data.protocol_version_negotiated
          ? ` (client asked for ${data.protocol_version_requested})`
          : ''
      } · client ${data.client?.name ?? 'unknown'} ${data.client?.version ?? ''} · initialize #${
        data.initialize_count ?? 1
      }`;
    case 'session.ended':
      return `${data.reason === 'server_stopping' ? 'Server stopped' : 'Idle gap'} · ${count(
        data.call_count,
      )} calls, ${count(data.error_count)} errors, ${count(data.initialize_count)} initializes`;
    case 'session.rejected':
      return `${data.reason ?? 'rejected'}${data.error ? ` · ${data.error}` : ''}`;
    case 'catalog.tools_listed':
      return `${count(data.count)} tools sent to the client · hash ${clip(data.content_hash, 24)}${
        data.tools ? '' : ' · unchanged since the last snapshot'
      }`;
    case 'catalog.resources_listed':
      return `${count(data.count)} resources (the server declares the capability and returns an empty list)`;
    case 'catalog.prompts_listed':
      return `${count(data.count)} prompts (the server declares the capability and returns an empty list)`;
    case 'catalog.availability': {
      const rows = Array.isArray(data.availability) ? data.availability : [];
      const usable = rows.filter((row) => row.available).length;
      return `${usable} of ${rows.length} tools usable right now · source ${
        data.source ?? 'tools_list'
      }`;
    }
    case 'tool.call.started':
      return `${data.tool ?? 'unknown tool'}${
        data.rationale_present ? '' : ' · no rationale supplied'
      }${
        (data.redacted_fields ?? []).length
          ? ` · ${data.redacted_fields.length} argument(s) redacted`
          : ''
      }`;
    case 'tool.call.completed':
      return `${data.tool ?? 'unknown tool'} · ${duration(data.duration_ms)} · ${charCount(
        data.content_chars,
      )}${data.is_error ? ` · ${clip(data.error?.message ?? 'error', 70)}` : ''}`;
    case 'tool.call.cancelled':
      return `${data.tool ?? 'unknown tool'} · ${data.reason ?? 'cancelled'} after ${duration(
        data.duration_ms,
      )}`;
    case 'tool.call.denied':
      return `${data.tool ?? 'unknown tool'} · ${
        DENIED_REASONS[data.denied_reason] ?? data.denied_reason ?? 'denied'
      }${(data.missing_scopes ?? []).length ? ` (${joinList(data.missing_scopes)})` : ''}`;
    case 'protocol.error':
      return `${data.code ?? '?'} on ${data['mcp.method.name'] ?? 'an unknown method'} · ${clip(
        data.message,
        80,
      )}`;
    case 'bank.op':
      return `${data.operation ?? 'operation'}${
        data.rows === null || data.rows === undefined ? '' : ` · ${count(data.rows)} rows`
      } · ${duration(data.latency_ms)}${data.ok === false ? ` · failed: ${data.error ?? ''}` : ''}`;
    case 'etl.load':
      return `${data.table ?? 'table'} · ${count(data.rows)} rows · ${
        (data.columns_advertised ?? []).length
      } columns advertised · from ${data.source_tool ?? 'a load tool'}`;
    case 'etl.processed':
      return `${data.table ?? 'table'} · ${count(data.rows)} rows · ${
        (data.columns_selected ?? []).length
      } of ${(data.columns_advertised ?? []).length} columns kept`;
    case 'etl.table_evicted':
      return `${data.table ?? 'table'} · ${EVICTION_REASONS[data.reason] ?? data.reason ?? ''}`;
    case 'etl.limit_reached':
      return `${data.limit ?? 'limit'} ${
        data.current === null || data.current === undefined
          ? ''
          : `(${count(data.current)} of ${count(data.max)})`
      } · ${clip(data.message, 80)}`;
    case 'etl.worker_terminated':
      return `${EVICTION_REASONS[data.reason] ?? data.reason ?? ''} after ${duration(
        data.duration_ms,
      )}${(data.tables_lost ?? []).length ? ` · lost ${joinList(data.tables_lost)}` : ''}`;
    case 'sql.query':
      return `${count(data.rows_returned)} rows${data.capped ? ' (row cap hit)' : ''} · ${duration(
        data.duration_ms,
      )} · ${oneLineSql(data.sql)}`;
    case 'sql.table_cleared':
      return `${data.table ?? 'table'} dropped${
        data.duration_ms === null || data.duration_ms === undefined
          ? ''
          : ` · ${duration(data.duration_ms)}`
      }`;
    case 'sql.rejected':
      return `${SQL_REJECTIONS[data.rejected_reason] ?? data.rejected_reason ?? 'rejected'} · ${clip(
        data.error,
        70,
      )}`;
    case 'intent.declared':
      return `“${clip(data.text, 140)}”`;
    case 'intent.inferred':
      // `confidence` is `0.4 + 0.45 x margin` clamped (`src/tools/intent.ts`), so it can only be
      // 0.2 for `unknown` or 0.40 to 0.85. Printed as a percentage it reads as an accuracy.
      return `${(data.workflow ?? 'unknown').replace(/_/g, ' ')} · scored ${Number(
        data.confidence ?? 0,
      ).toFixed(2)} · inferred by this server, not by the model`;
    case 'intent.missing':
      return `${data.tool ?? 'a tool'} was called without a rationale (${data.reason ?? 'absent'})`;
    case 'xray.pairing.created':
      return `Bound to login ${data.login_id ?? '-'} · valid until ${clip(data.expires_at, 24)}`;
    case 'xray.pairing.rejected':
      return PAIRING_REJECTIONS[data.reason] ?? data.reason ?? 'rejected';
    case 'xray.viewer.connected':
      return `${data.viewer_kind ?? 'pairing'} viewer · filter ${data.filter ?? 'login'}${
        data.last_event_id ? ` · resumed after event ${count(data.last_event_id)}` : ''
      } · ${count(data.replayed)} events replayed`;
    case 'xray.viewer.disconnected':
      return `${data.viewer_kind ?? 'pairing'} viewer · ${data.reason ?? 'client_closed'}${
        data.duration_ms ? ` · after ${duration(data.duration_ms)}` : ''
      }`;
    case 'xray.dropped':
      return `${count(data.dropped_count)} events dropped for one viewer (${
        data.reason ?? 'backpressure'
      }) · reconnecting with Last-Event-ID backfills them`;
    case 'xray.events.deleted':
      return data.scope === 'session'
        ? `Erased ${count(data.deleted_count)} events of session ${
            data.xs_deleted ?? 'unknown'
          } at the ${data.viewer_kind ?? 'pairing'} viewer's request`
        : `Erased ${count(data.deleted_count)} events and ${count(
            data.sessions_deleted,
          )} sessions of this login at the ${data.viewer_kind ?? 'pairing'} viewer's request`;
    default:
      return 'This event type is newer than the dashboard. The raw payload is shown below.';
  }
}

/** The call this event belongs to, as `<xs>#<request_id>`; `null` when it belongs to no call. */
export function callKeyOf(event) {
  if (!event) return null;
  const requestId = event.request_id;
  if (requestId === null || requestId === undefined || requestId === '') return null;
  const family = familyOf(event.type);
  // `http` joins so a click on an HTTP row lands on its call; the store keeps it off the children.
  if (!['tool', 'bank', 'etl', 'sql', 'intent', 'catalog', 'auth', 'http'].includes(family)) return null;
  if (family === 'auth' && event.type !== 'auth.stepup.requested') return null;
  if (family === 'catalog' && event.type !== 'catalog.availability') return null;
  return `${event.xs ?? 'no-session'}#${requestId}`;
}
