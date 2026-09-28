/**
 * The X-ray event contract (block: contracts).
 *
 * This file is the primary interface of the system (docs/ARCHITECTURE.md section 1): the MCP
 * server is an event producer and the dashboard an event consumer. It implements
 * docs/XRAY_EVENT_MODEL.md sections 2 and 3 verbatim - the envelope (with `login_id`, ADR-14)
 * and the full catalogue of 45 event types across twelve families.
 *
 * Frozen at the T0.5 gate and append-only afterwards: new event types and new optional fields
 * may be added through docs/contracts/CHANGES.md; existing names are never renamed or removed.
 *
 * v0.9 (D-28): every schema here is open. A field the catalogue does not name is kept verbatim,
 * never stripped, at any depth, so a producer (or a client) that sends something nobody mapped
 * yet still reaches the log. The named fields are the categorised view; `dataKeysOf` lists them,
 * and anything else in `data` is the uncategorised remainder the dashboard shows as "unmapped".
 *
 * Pure types and zod schemas. No I/O, no business logic.
 */
import { z } from 'zod';

/** Contract version carried in every envelope as `v`. */
export const XRAY_CONTRACT_VERSION = 1;

/** claude.ai's per-call limits, echoed on events so the dashboard can draw a budget bar. */
export const CLAUDE_TOOL_BUDGET_MS = 300_000;
export const CLAUDE_CONTENT_CHAR_CAP = 150_000;

/** Anthropic's documented egress range; `http.request.anthropic_egress` is true inside it. */
export const ANTHROPIC_EGRESS_CIDR = '160.79.104.0/21';

// ---------------------------------------------------------------------------
// Identifier conventions (docs/REPO_LAYOUT.md section 8)
// ---------------------------------------------------------------------------

/** Prefix for every generated id in the system. */
export const ID_PREFIXES = {
  persona: 'per_',
  login: 'lgn_',
  grant: 'grt_',
  session: 'xs_',
  account: 'acc_',
  card: 'card_',
  transaction: 'txn_',
  transfer: 'tr_',
  bill: 'bill_',
  payee: 'pay_',
  audit: 'aud_',
  preview: 'prv_',
  boot: 'boot_',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** `per_a1b2` and friends: the prefix plus 1..64 url-safe characters. */
export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`);
}

/** True when `value` is a well-formed id of that kind. */
export function isId(value: unknown, kind: IdKind): value is string {
  return typeof value === 'string' && idPattern(kind).test(value);
}

/** A zod schema for one id kind, used by the envelope and by the entity types. */
export function idSchema(kind: IdKind): z.ZodString {
  return z.string().regex(idPattern(kind), `expected an id prefixed "${ID_PREFIXES[kind]}"`);
}

// ---------------------------------------------------------------------------
// Envelope (docs/XRAY_EVENT_MODEL.md section 2)
// ---------------------------------------------------------------------------

/** `legacy` = the 2025-era initialize handshake, `modern` = the 2026-07-28 `_meta` shape. */
export const XrayEraSchema = z.enum(['legacy', 'modern']);
export type XrayEra = z.infer<typeof XrayEraSchema>;

/** `clientInfo` verbatim from `initialize` (or `_meta`). Never trusted, never used for gating. */
export const ClientInfoSchema = z.looseObject({
  name: z.string(),
  version: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
});
export type ClientInfo = z.infer<typeof ClientInfoSchema>;

/** Arbitrary JSON object captured verbatim (capabilities, `_meta`, tool arguments). */
const JsonObject = z.record(z.string(), z.unknown());

/**
 * The fields every event carries. Correlation keys default to `null` so a producer can omit
 * what it does not know; the emitter fills `id`, `ts`, `v` and `seq`.
 */
const EnvelopeBase = z.looseObject({
  /** Process-monotonic integer; SQLite primary key, SSE `id` and replay cursor. */
  id: z.int().nonnegative(),
  /** ISO-8601 UTC. */
  ts: z.iso.datetime(),
  /** Contract version. */
  v: z.literal(XRAY_CONTRACT_VERSION),
  /** X-ray session id; `null` before any grant is known (auth.challenge, server.started). */
  xs: idSchema('session').nullable().default(null),
  /** Groups every grant of one human's browser (ADR-14); the dashboard viewer scope. */
  login_id: idSchema('login').nullable().default(null),
  grant_id: idSchema('grant').nullable().default(null),
  persona_id: idSchema('persona').nullable().default(null),
  /** Per-`xs` sequence number, starting at 1; `null` when `xs` is `null`. */
  seq: z.int().positive().nullable().default(null),
  /** JSON-RPC id as a string (OTel `jsonrpc.request.id`), when applicable. */
  request_id: z.string().nullable().default(null),
  era: XrayEraSchema.nullable().default(null),
  client: ClientInfoSchema.nullable().default(null),
  /** Negotiated or header-declared protocol version (OTel `mcp.protocol.version`). */
  protocol_version: z.string().nullable().default(null),
  /** From `_meta.traceparent` if a client ever sends it. */
  trace_id: z.string().nullable().default(null),
});

/** The correlation fields a producer passes to `XrayEmitter.emit`; the rest is filled in. */
export type XrayCorrelation = Partial<
  Pick<
    z.input<typeof EnvelopeBase>,
    | 'xs'
    | 'login_id'
    | 'grant_id'
    | 'persona_id'
    | 'request_id'
    | 'era'
    | 'client'
    | 'protocol_version'
    | 'trace_id'
  >
>;

/** Builds one member of the catalogue: the envelope plus a literal `type` and its payload. */
function event<T extends string, D extends z.ZodType>(type: T, data: D) {
  return EnvelopeBase.extend({ type: z.literal(type), data });
}

// ---------------------------------------------------------------------------
// server.* (producer: xray)
// ---------------------------------------------------------------------------

export const ServerStartedData = z.looseObject({
  boot_id: idSchema('boot'),
  version: z.string(),
  git_sha: z.string().nullable().default(null),
  /** Name and version of the MCP SDK in use, for example "@modelcontextprotocol/sdk 1.30.0". */
  sdk: z.string().nullable().default(null),
  /** `max(id)` of the restored event log; ids continue from there (A-25). */
  restored_max_id: z.int().nonnegative().nullable().default(null),
  node_version: z.string().nullable().default(null),
});

export const ServerStoppingData = z.looseObject({
  boot_id: idSchema('boot'),
  version: z.string(),
  reason: z.enum(['sigterm', 'sigint', 'shutdown']).default('sigterm'),
  uptime_s: z.number().nonnegative().nullable().default(null),
  /** Sessions closed by the shutdown (`session.ended` is emitted lazily, section 4). */
  sessions_ended: z.int().nonnegative().nullable().default(null),
});

// ---------------------------------------------------------------------------
// http.* (producer: mcp / app)
// ---------------------------------------------------------------------------

export const OriginDecisionSchema = z.enum(['allowed', 'absent', 'rejected', 'logged']);
export type OriginDecision = z.infer<typeof OriginDecisionSchema>;

/**
 * One header line as it reached the process: the name in the case it arrived in (Cloud Run's front
 * end lower-cases every name before that), the value untouched.
 */
export const RawHeaderSchema = z.tuple([z.string(), z.string()]);
export type RawHeader = z.infer<typeof RawHeaderSchema>;

/**
 * v0.9 (D-28): the request exactly as it reached the process, before anything read it.
 *
 * This is the uncategorised block of `http.request`: every header in arrival order (duplicates
 * and case kept, `Signature`, `Signature-Input` and `Signature-Agent` of Web Bot Auth included),
 * the body bytes the parser read, and the socket peer. Nothing here is mapped, filtered or
 * redacted on the way in; the viewer surfaces redact on the way out (`src/xray/redaction.ts`) and
 * the operator's export returns it as stored. Built by `captureRawRequest` (`raw-http.ts`).
 */
export const RawHttpRequestSchema = z.looseObject({
  method: z.string(),
  /** The request target as sent: path and query string. */
  url: z.string(),
  http_version: z.string().nullable().default(null),
  headers: z.array(RawHeaderSchema).default([]),
  trailers: z.array(RawHeaderSchema).default([]),
  /** The body bytes a parser read (after `Content-Encoding` inflation), as text or base64. */
  body: z.string().nullable().default(null),
  body_encoding: z.enum(['utf8', 'base64']).nullable().default(null),
  body_bytes: z.int().nonnegative().nullable().default(null),
  /**
   * False when no parser read the body: no body at all, a content type the route does not parse,
   * or one past the parser's size limit. `content-length` in `headers` still says what was sent.
   */
  body_read: z.boolean().default(false),
  /** The TCP peer as the socket reports it (on Cloud Run, Google's front end). */
  remote_address: z.string().nullable().default(null),
  remote_port: z.int().nullable().default(null),
});
export type RawHttpRequest = z.infer<typeof RawHttpRequestSchema>;

/**
 * v0.10 (D-29): what this server made of a Web Bot Auth signature (HTTP Message Signatures,
 * RFC 9421, with the `web-bot-auth` tag of draft-meunier-web-bot-auth-architecture).
 *
 * `verified` is the only verdict that names a provider: the signature checked out against a key
 * the agent publishes at `<Signature-Agent>/.well-known/http-message-signatures-directory`.
 * Everything else is a reason it did not. A verdict never changes how the request is answered:
 * this server records and verifies, it never gates on a signature (D-29), the same way it never
 * gates on `clientInfo` or `User-Agent`.
 */
export const BotAuthVerdictSchema = z.enum([
  'verified',
  'invalid_signature',
  'unknown_key',
  'directory_unreachable',
  'expired',
  'not_yet_valid',
  'replayed',
  'malformed',
  'unsupported',
  'unsigned',
  'not_checked',
]);
export type BotAuthVerdict = z.infer<typeof BotAuthVerdictSchema>;

/**
 * v0.10 (D-29): the signature check of one request, on `http.request.signature`. Present when the
 * request carried a signature header or when this server sent the `Accept-Signature` invitation;
 * absent on every other request, whose `raw.headers` already say it was unsigned.
 */
export const SignatureCheckSchema = z.looseObject({
  /** True when `Signature` or `Signature-Input` arrived. */
  present: z.boolean(),
  verdict: BotAuthVerdictSchema,
  /** The signature label checked (`sig1`), the first one tagged `web-bot-auth`. */
  label: z.string().nullable().default(null),
  /** The `Signature-Agent` URI as sent (quotes removed), the only name a verdict can vouch for. */
  agent: z.string().nullable().default(null),
  keyid: z.string().nullable().default(null),
  tag: z.string().nullable().default(null),
  alg: z.string().nullable().default(null),
  /** `created` and `expires` of the signature parameters, in seconds since the epoch. */
  created: z.int().nullable().default(null),
  expires: z.int().nullable().default(null),
  nonce_present: z.boolean().default(false),
  /** The covered components, in the order the signature lists them. */
  components: z.array(z.string()).default([]),
  directory_url: z.string().nullable().default(null),
  /** Where the key came from: this process's directory cache, a fresh fetch, or nowhere. */
  cache: z.enum(['hit', 'miss', 'none']).default('none'),
  /** One sentence on why the verdict is not `verified`; `null` when it is. */
  reason: z.string().nullable().default(null),
  /** True when this response carried `Accept-Signature`, inviting the client to sign. */
  challenge_sent: z.boolean().default(false),
  /** How long the check took, directory fetch included. */
  duration_ms: z.number().nonnegative().nullable().default(null),
});
export type SignatureCheck = z.infer<typeof SignatureCheckSchema>;

export const HttpRequestData = z.looseObject({
  method: z.string(),
  path: z.string(),
  status: z.int(),
  duration_ms: z.number().nonnegative(),
  user_agent: z.string().nullable().default(null),
  /** Only the `/24` prefix is ever stored (redaction rules, section 3). */
  remote_ip_prefix: z.string().nullable().default(null),
  /** True when the remote IP is inside `ANTHROPIC_EGRESS_CIDR`. */
  anthropic_egress: z.boolean().default(false),
  origin: z.string().nullable().default(null),
  origin_decision: OriginDecisionSchema.default('absent'),
  mcp_protocol_version_header: z.string().nullable().default(null),
  /** Recorded if a client ever sends one; this server never issues one (ADR-3). */
  mcp_session_id: z.string().nullable().default(null),
  has_authorization: z.boolean().default(false),
  content_type: z.string().nullable().default(null),
  sse: z.boolean().default(false),
  rate_limited: z.boolean().default(false),
  /** v0.9 (D-28): the request as it arrived. Absent on rows recorded before v0.9. */
  raw: RawHttpRequestSchema.optional(),
  /** v0.10 (D-29): the Web Bot Auth check; absent when nothing was signed or invited. */
  signature: SignatureCheckSchema.optional(),
});

// ---------------------------------------------------------------------------
// auth.* (producer: auth / the mcp bearer gate)
// ---------------------------------------------------------------------------

export const AuthLevelSchema = z.enum(['read_only', 'read_write']);
export type AuthLevel = z.infer<typeof AuthLevelSchema>;

export const AuthChallengeData = z.looseObject({
  status: z.int().default(401),
  /** RFC 6750 `error` code when one applies (`invalid_token`, `insufficient_scope`). */
  error: z.string().nullable().default(null),
  /** The space-separated challenge scope hint sent in `WWW-Authenticate`. */
  scope: z.string(),
  resource_metadata: z.string(),
  reason: z.string().nullable().default(null),
});

export const AuthVerifiedData = z.looseObject({
  grant_id: idSchema('grant'),
  login_id: idSchema('login').nullable().default(null),
  persona_id: idSchema('persona'),
  scopes: z.array(z.string()),
  auth_level: AuthLevelSchema,
  /** Short hash of the OAuth `client_id`; the raw value is never stored. */
  client_id: z.string(),
  client_name: z.string().nullable().default(null),
  aud: z.string(),
  expires_at: z.iso.datetime(),
});

export const AuthRejectedData = z.looseObject({
  status: z.int().default(401),
  error: z.string(),
  reason: z.enum([
    'no_access_token',
    'malformed',
    'invalid_signature',
    'expired',
    'wrong_typ',
    'bad_audience',
    'revoked_grant',
    'unknown_client',
    'invalid_grant',
    // v0.2 (proposal from L5): a refusal that is an abuse control rather than a protocol failure.
    // `RATE_LIMIT_LOGIN_GRANTS` used to travel as `invalid_grant`, which reads on the dashboard
    // as "this user replayed a code" instead of "this browser hit its daily cap".
    'rate_limited',
  ]),
  client_id: z.string().nullable().default(null),
});

/** Why the verifier turned a bearer token down (`auth.rejected.data.reason`). */
export type AuthRejectionReason = z.infer<typeof AuthRejectedData>['reason'];

/**
 * v0.10 (D-29): this server fetched an agent's key directory to check a Web Bot Auth signature.
 * A request to a third party is something this server did, so it is on the record even when it
 * failed; the cache means one per agent per `BOT_AUTH_DIRECTORY_TTL_S`, not one per request.
 */
export const AuthDirectoryFetchedData = z.looseObject({
  /** The `Signature-Agent` URI the directory was derived from. */
  agent: z.string(),
  url: z.string(),
  outcome: z.enum([
    'ok',
    'http_error',
    'timeout',
    'too_large',
    'bad_json',
    'blocked',
    'network',
    'rate_limited',
  ]),
  status: z.int().nullable().default(null),
  /** Ed25519 keys the directory held that this server can use. */
  key_count: z.int().nonnegative().default(0),
  duration_ms: z.number().nonnegative().default(0),
  /** How long the keys are cached, from `Cache-Control: max-age` or `BOT_AUTH_DIRECTORY_TTL_S`. */
  ttl_s: z.int().nonnegative().nullable().default(null),
  error: z.string().nullable().default(null),
});

export const AuthClientRegisteredData = z.looseObject({
  client_id: z.string(),
  client_name: z.string().nullable().default(null),
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: z.string().default('none'),
  application_type: z.string().nullable().default(null),
});

export const AuthClientReconstructedData = z.looseObject({
  client_id: z.string(),
  client_name: z.string().default('unknown (reconstructed)'),
  redirect_uris: z.array(z.string()),
  reason: z.enum(['unknown_client_after_restart', 'evicted_from_lru']),
});

export const AuthGrantCreatedData = z.looseObject({
  grant_id: idSchema('grant'),
  /** Set when the consent came from a browser already holding a login cookie (ADR-14). */
  parent_grant_id: idSchema('grant').nullable().default(null),
  login_id: idSchema('login'),
  persona_id: idSchema('persona'),
  scopes: z.array(z.string()),
  auth_level: AuthLevelSchema,
  client_id: z.string(),
  client_name: z.string().nullable().default(null),
  expires_at: z.iso.datetime().nullable().default(null),
  /** True when the persona is one of the shared seeded demo identities (ADR-15). */
  shared_persona: z.boolean().default(false),
});

export const AuthGrantUpdatedData = z.looseObject({
  /** The SAME grant id as the original consent: a step-up extends, it never replaces (ADR-14). */
  grant_id: idSchema('grant'),
  login_id: idSchema('login'),
  persona_id: idSchema('persona'),
  scopes: z.array(z.string()),
  added_scopes: z.array(z.string()),
  auth_level: AuthLevelSchema,
  client_id: z.string(),
  reason: z.enum(['step_up', 're_consent']).default('step_up'),
});

export const AuthTokenIssuedData = z.looseObject({
  grant_id: idSchema('grant'),
  login_id: idSchema('login').nullable().default(null),
  persona_id: idSchema('persona'),
  scopes: z.array(z.string()),
  auth_level: AuthLevelSchema,
  client_id: z.string(),
  aud: z.string(),
  /** Access-token expiry. The token string itself is never stored or logged (invariant 7). */
  expires_at: z.iso.datetime(),
  refresh_expires_at: z.iso.datetime().nullable().default(null),
});

export const AuthTokenRefreshedData = z.looseObject({
  grant_id: idSchema('grant'),
  login_id: idSchema('login').nullable().default(null),
  persona_id: idSchema('persona'),
  scopes: z.array(z.string()),
  auth_level: AuthLevelSchema,
  client_id: z.string(),
  expires_at: z.iso.datetime(),
  refresh_expires_at: z.iso.datetime().nullable().default(null),
  /** `jti` of the refresh token that was rotated out; it joins the rotated set (ADR-4). */
  rotated_jti: z.string().nullable().default(null),
});

export const AuthTokenRevokedData = z.looseObject({
  grant_id: idSchema('grant').nullable().default(null),
  login_id: idSchema('login').nullable().default(null),
  client_id: z.string().nullable().default(null),
  reason: z.enum(['revocation_request', 'grant_revoked', 'reuse_detected']),
});

export const AuthStepupRequestedData = z.looseObject({
  status: z.int().default(403),
  error: z.string().default('insufficient_scope'),
  grant_id: idSchema('grant'),
  login_id: idSchema('login').nullable().default(null),
  persona_id: idSchema('persona').nullable().default(null),
  /** The tool whose `tools/call` triggered the challenge. */
  tool: z.string(),
  /** Every still-needed write scope, space-separated, as sent in `WWW-Authenticate`. */
  scope: z.string(),
  missing_scopes: z.array(z.string()),
  resource_metadata: z.string(),
});

export const AuthLoginCreatedData = z.looseObject({
  login_id: idSchema('login'),
  persona_id: idSchema('persona'),
  /** 30-day cookie expiry (ADR-14). */
  expires_at: z.iso.datetime(),
  /** How the persona was chosen on the login page. */
  persona_source: z.enum(['seeded', 'generated', 'recovered']).default('seeded'),
  shared_persona: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// session.* (producer: mcp)
// ---------------------------------------------------------------------------

export const SessionStartedData = z.looseObject({
  reason: z.enum(['first_request', 'idle_gap']),
  /** Silence before this request, when the session was split on an idle gap (A-27). */
  idle_ms: z.number().nonnegative().nullable().default(null),
});

export const SessionInitializedData = z.looseObject({
  protocol_version_requested: z.string().nullable().default(null),
  protocol_version_negotiated: z.string(),
  client: ClientInfoSchema.nullable().default(null),
  client_capabilities: JsonObject.default({}),
  server_capabilities: JsonObject.default({}),
  /** Whether `InitializeResult.instructions` was sent (A-05). */
  instructions_sent: z.boolean().default(true),
  /** How many `initialize` calls this `xs` has seen; claude.ai reconnect loops raise it. */
  initialize_count: z.int().positive(),
});

export const SessionEndedData = z.looseObject({
  reason: z.enum(['idle_gap', 'server_stopping']),
  idle_ms: z.number().nonnegative().nullable().default(null),
  duration_ms: z.number().nonnegative().nullable().default(null),
  call_count: z.int().nonnegative().default(0),
  error_count: z.int().nonnegative().default(0),
  initialize_count: z.int().nonnegative().default(0),
});

export const SessionRejectedData = z.looseObject({
  reason: z.enum(['initialize', 'origin_rejected', 'rate_limited', 'unsupported_protocol']),
  error: z.string().nullable().default(null),
  protocol_version_requested: z.string().nullable().default(null),
});

// ---------------------------------------------------------------------------
// catalog.* (producer: mcp + tools)
// ---------------------------------------------------------------------------

/**
 * v0.5: the `tools/list` entry as the client received it, minus `name` and `title` (carried by the
 * row). Optional: rows recorded before v0.5 do not have it.
 */
export const CatalogToolDescriptorSchema = z.looseObject({
  description: z.string(),
  /** The published JSON Schema verbatim; `rationale` is in `required` (ADR-8). */
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()),
  _meta: z.record(z.string(), z.unknown()),
});
export type CatalogToolDescriptor = z.infer<typeof CatalogToolDescriptorSchema>;

/** One row of the tool array carried by `catalog.tools_listed`. */
export const CatalogToolSchema = z.looseObject({
  name: z.string(),
  title: z.string(),
  read_only: z.boolean(),
  destructive: z.boolean(),
  idempotent: z.boolean(),
  scopes: z.array(z.string()),
  input_schema_hash: z.string(),
  descriptor: CatalogToolDescriptorSchema.optional(),
});
export type CatalogTool = z.infer<typeof CatalogToolSchema>;

/** One row of the availability table (docs/TOOL_CATALOG.md section 4, ADR-13). */
export const ToolAvailabilitySchema = z.looseObject({
  tool: z.string(),
  /** Was the entry in the `tools/list` the client received? */
  listed: z.boolean(),
  /** Would a call succeed right now? */
  available: z.boolean(),
  unavailable_reasons: z.array(
    z.enum(['missing_scopes', 'disabled_for_deployment', 'authorization_level_not_allowed']),
  ),
  missing_scopes: z.array(z.string()),
});

export const CatalogToolsListedData = z.looseObject({
  count: z.int().nonnegative(),
  content_hash: z.string(),
  /**
   * Id of the last `catalog.tools_listed` that carried the full array for this grant. The array
   * is repeated only when `content_hash` changed, because claude.ai re-lists every 25-80 s.
   */
  snapshot_ref: z.int().nonnegative().nullable().default(null),
  tools: z.array(CatalogToolSchema).nullable().default(null),
  availability: z.array(ToolAvailabilitySchema).default([]),
  feature_flags: z.array(z.string()).default([]),
});

export const CatalogResourcesListedData = z.looseObject({
  count: z.int().nonnegative(),
});

export const CatalogPromptsListedData = z.looseObject({
  count: z.int().nonnegative(),
});

export const CatalogAvailabilityData = z.looseObject({
  content_hash: z.string(),
  availability: z.array(ToolAvailabilitySchema),
  feature_flags: z.array(z.string()).default([]),
  /** Set when the table was produced by a `get_tool_availability` call rather than a list. */
  source: z.enum(['tools_list', 'get_tool_availability']).default('tools_list'),
});

// ---------------------------------------------------------------------------
// tool.* (producer: mcp lifecycle + tools payload)
// ---------------------------------------------------------------------------

export const ToolErrorSchema = z.looseObject({
  code: z.union([z.int(), z.string()]).nullable().default(null),
  message: z.string(),
  /** `protocol` = a JSON-RPC error, `tool` = `isError: true` content (A-08). */
  class: z.enum(['protocol', 'tool']),
});

export const ToolCallStartedData = z.looseObject({
  /** OTel `gen_ai.tool.name`. */
  tool: z.string(),
  /** Verbatim except the per-tool deny-list and the global token patterns (section 3). */
  arguments: JsonObject.default({}),
  redacted_fields: z.array(z.string()).default([]),
  /** The model-authored rationale, stored verbatim (it is the product). */
  rationale: z.string().nullable().default(null),
  rationale_present: z.boolean(),
  rationale_truncated: z.boolean().default(false),
  /** JSON-RPC `_meta` verbatim. */
  meta: JsonObject.nullable().default(null),
  required_scopes: z.array(z.string()).default([]),
  budget_ms: z.int().positive().default(CLAUDE_TOOL_BUDGET_MS),
});

export const ToolCallCompletedData = z.looseObject({
  tool: z.string(),
  duration_ms: z.number().nonnegative(),
  budget_ms: z.int().positive().default(CLAUDE_TOOL_BUDGET_MS),
  is_error: z.boolean(),
  error: ToolErrorSchema.nullable().default(null),
  content_types: z.array(z.string()).default([]),
  content_chars: z.int().nonnegative().default(0),
  content_cap: z.int().positive().default(CLAUDE_CONTENT_CHAR_CAP),
  /** Truncated to the preview size by the emitter. */
  structured_content: z.unknown().nullable().default(null),
  /** First 2 KB of the text content. */
  text_preview: z.string().nullable().default(null),
});

export const ToolCallCancelledData = z.looseObject({
  tool: z.string(),
  duration_ms: z.number().nonnegative(),
  reason: z.enum(['client_cancelled', 'timeout', 'server_stopping']),
});

export const ToolCallDeniedData = z.looseObject({
  tool: z.string(),
  denied_reason: z.enum(['insufficient_scope', 'rate_limited', 'feature_flag']),
  required_scopes: z.array(z.string()).default([]),
  missing_scopes: z.array(z.string()).default([]),
  status: z.int().default(403),
});

// ---------------------------------------------------------------------------
// protocol.* (producer: mcp)
// ---------------------------------------------------------------------------

/**
 * JSON-RPC errors. `-32700` parse, `-32600` invalid request, `-32601` method not found,
 * `-32602` invalid params, `-32603` internal; `-32020`, `-32021` and `-32022` are reserved
 * for the 2026-07-28 era.
 */
export const ProtocolErrorData = z.looseObject({
  /** OTel attribute name, kept verbatim from docs/XRAY_EVENT_MODEL.md section 3. */
  'mcp.method.name': z.string().nullable().default(null),
  code: z.int(),
  message: z.string(),
});

/** The JSON-RPC codes this server emits, plus the reserved 2026-07-28 range. */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export const RESERVED_2026_ERROR_CODES = [-32020, -32021, -32022] as const;

// ---------------------------------------------------------------------------
// bank.* (producer: bank-core)
// ---------------------------------------------------------------------------

/** The operations bank-core reports. Open-ended by design (section 3 lists "..."). */
export const BANK_OPERATIONS = [
  'accounts.list',
  'cards.list',
  'transactions.list',
  'transfers.list',
  'bills.list',
  'payees.list',
  'categories.list',
  'statement_lines.list',
  'persona.get',
  'card.lock',
  'card.unlock',
  'transfer.preview',
  'transfer.confirm',
  'audit.append',
  'overlay.reset',
  // v0.7: the public lane's reads (`PublicBankInfo`, D-26); one per level of the catalog.
  'public.profile',
  'public.products',
  'public.product',
  'public.prices',
  'public.branches',
  'public.branch',
] as const;
export type BankOperation = (typeof BANK_OPERATIONS)[number];

export const BankOpData = z.looseObject({
  /** `family.verb`, for example `transactions.list` or `transfer.confirm`. */
  operation: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  /** Masked to the last four characters; full numbers never leave bank-core. */
  account_id: z.string().nullable().default(null),
  card_id: z.string().nullable().default(null),
  pages: z.int().nonnegative().nullable().default(null),
  rows: z.int().nonnegative().nullable().default(null),
  latency_ms: z.number().nonnegative(),
  ok: z.boolean(),
  audit_id: idSchema('audit').nullable().default(null),
  preview_id: idSchema('preview').nullable().default(null),
  error: z.string().nullable().default(null),
});

// ---------------------------------------------------------------------------
// etl.* (producer: etl)
// ---------------------------------------------------------------------------

export const EtlEvictionReasonSchema = z.enum([
  'ttl',
  'grant_cap',
  'global_cap',
  'timeout',
  // v0.2 (proposal P-3): an SQL runner that exited unexpectedly (a crash or an OOM kill). Before
  // this member `etl` cleared the grant's tables in silence, because reporting a crash as a
  // timeout would have been worse than saying nothing.
  'crash',
]);
export type EtlEvictionReason = z.infer<typeof EtlEvictionReasonSchema>;

export const EtlLimitSchema = z.enum(['tables', 'ops', 'global_dbs']);
export type EtlLimit = z.infer<typeof EtlLimitSchema>;

export const EtlLoadData = z.looseObject({
  table: z.string(),
  rows: z.int().nonnegative(),
  /** Union of keys across all rows, nested keys joined with "__". */
  columns_advertised: z.array(z.string()).default([]),
  source_tool: z.string(),
  duration_ms: z.number().nonnegative(),
});

export const EtlProcessedData = z.looseObject({
  table: z.string(),
  rows: z.int().nonnegative(),
  columns_advertised: z.array(z.string()).default([]),
  columns_selected: z.array(z.string()).default([]),
  duration_ms: z.number().nonnegative(),
});

export const EtlTableEvictedData = z.looseObject({
  table: z.string(),
  reason: EtlEvictionReasonSchema,
  rows: z.int().nonnegative().nullable().default(null),
  /** Age when the table was dropped, for TTL evictions. */
  age_ms: z.number().nonnegative().nullable().default(null),
});

export const EtlLimitReachedData = z.looseObject({
  limit: EtlLimitSchema,
  table: z.string().nullable().default(null),
  current: z.int().nonnegative().nullable().default(null),
  max: z.int().nonnegative().nullable().default(null),
  message: z.string().nullable().default(null),
});

export const EtlWorkerTerminatedData = z.looseObject({
  reason: EtlEvictionReasonSchema,
  duration_ms: z.number().nonnegative().nullable().default(null),
  table: z.string().nullable().default(null),
  /** Tables lost with the `:memory:` database; the model is told to reload. */
  tables_lost: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// sql.* (producer: etl)
// ---------------------------------------------------------------------------

export const SqlRejectedReasonSchema = z.enum([
  'not_readonly',
  'denylist',
  'timeout',
  'unknown_table',
  'multi_statement',
  'row_cap',
  // v0.2 (proposal P-3): two refusals the shipped guard already produces and had no reason to
  // travel under, so the dashboard could not say why the call failed.
  /** `process_data` with an empty `cols`, or a column the load tool never advertised. */
  'unknown_column',
  /** The model's SQL does not parse. */
  'syntax_error',
]);
export type SqlRejectedReason = z.infer<typeof SqlRejectedReasonSchema>;

export const SqlQueryData = z.looseObject({
  table: z.string().nullable().default(null),
  /** Model-authored SQL, stored verbatim (section 3). */
  sql: z.string(),
  rows_returned: z.int().nonnegative(),
  /** True when the 100-row cap trimmed the result. */
  capped: z.boolean().default(false),
  duration_ms: z.number().nonnegative(),
});

export const SqlTableClearedData = z.looseObject({
  table: z.string(),
  duration_ms: z.number().nonnegative().nullable().default(null),
});

export const SqlRejectedData = z.looseObject({
  table: z.string().nullable().default(null),
  sql: z.string(),
  rejected_reason: SqlRejectedReasonSchema,
  error: z.string(),
  duration_ms: z.number().nonnegative().nullable().default(null),
});

// ---------------------------------------------------------------------------
// intent.* (producer: tools)
// ---------------------------------------------------------------------------

export const IntentWorkflowSchema = z.enum([
  'spend_analysis',
  'card_control',
  'payment',
  'balance_check',
  'exploration',
  'unknown',
]);
export type IntentWorkflow = z.infer<typeof IntentWorkflowSchema>;

export const IntentDeclaredData = z.looseObject({
  /** The `rationale` verbatim. */
  text: z.string(),
  source: z.literal('rationale'),
  /** Always true here: the dashboard labels it as written by the model, not by the user. */
  model_authored: z.literal(true),
  tool: z.string(),
  truncated: z.boolean().default(false),
});

export const IntentInferredData = z.looseObject({
  workflow: IntentWorkflowSchema,
  confidence: z.number().min(0).max(1),
  source: z.literal('classifier'),
  /** Always false: inference is ours, and the dashboard says so. */
  model_authored: z.literal(false),
  /** The tool sequence the classifier looked at. */
  tools: z.array(z.string()).default([]),
});

export const IntentMissingData = z.looseObject({
  tool: z.string(),
  reason: z.enum(['absent', 'empty', 'wrong_type']),
});

// ---------------------------------------------------------------------------
// xray.* (producer: xray)
// ---------------------------------------------------------------------------

/**
 * v0.7: `public` is a reader of the public lane (`?lane=public`, no cookie), bound to
 * `PUBLIC_LOGIN_ID` (D-26). Never carried by a viewer cookie.
 */
export const ViewerKindSchema = z.enum(['pairing', 'admin', 'public']);
export type ViewerKind = z.infer<typeof ViewerKindSchema>;

/** `xs=<id>`, `login=me` (every grant of the viewer's login) or `all=1` (observer mode). */
export const ViewerFilterSchema = z.enum(['xs', 'login', 'all']);
export type ViewerFilter = z.infer<typeof ViewerFilterSchema>;

export const XrayPairingCreatedData = z.looseObject({
  /** The pairing code, hashed. The plaintext code never enters the event log. */
  code: z.string(),
  login_id: idSchema('login'),
  expires_at: z.iso.datetime(),
});

export const XrayPairingRejectedData = z.looseObject({
  code: z.string().nullable().default(null),
  reason: z.enum(['unknown_code', 'expired', 'rate_limited', 'malformed']),
});

export const XrayViewerConnectedData = z.looseObject({
  viewer_kind: ViewerKindSchema,
  login_id: idSchema('login').nullable().default(null),
  filter: ViewerFilterSchema,
  /** `Last-Event-ID` sent by the browser on reconnect; drives the replay. */
  last_event_id: z.int().nonnegative().nullable().default(null),
  replayed: z.int().nonnegative().default(0),
});

export const XrayViewerDisconnectedData = z.looseObject({
  viewer_kind: ViewerKindSchema,
  login_id: idSchema('login').nullable().default(null),
  filter: ViewerFilterSchema,
  duration_ms: z.number().nonnegative().nullable().default(null),
  reason: z.enum(['client_closed', 'server_cut', 'backpressure']).default('client_closed'),
});

export const XrayDroppedData = z.looseObject({
  dropped_count: z.int().positive(),
  viewer_kind: ViewerKindSchema.nullable().default(null),
  filter: ViewerFilterSchema.nullable().default(null),
  reason: z.enum(['backpressure']).default('backpressure'),
});

/**
 * v0.4: a viewer erased history. It is written **after** the deletion, so it is the one event that
 * survives it: a page able to destroy its own evidence with no trace would be worse than one that
 * cannot erase at all (invariant 13).
 */
export const XrayEventsDeletedData = z.looseObject({
  scope: z.enum(['session', 'login']),
  /** The session erased, when `scope` is `session`. */
  xs_deleted: z.string().nullable().default(null),
  deleted_count: z.int().nonnegative(),
  sessions_deleted: z.int().nonnegative(),
  viewer_kind: ViewerKindSchema.default('pairing'),
});

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const ServerStartedEvent = event('server.started', ServerStartedData);
export const ServerStoppingEvent = event('server.stopping', ServerStoppingData);
export const HttpRequestEvent = event('http.request', HttpRequestData);
export const AuthChallengeEvent = event('auth.challenge', AuthChallengeData);
export const AuthVerifiedEvent = event('auth.verified', AuthVerifiedData);
export const AuthRejectedEvent = event('auth.rejected', AuthRejectedData);
export const AuthClientRegisteredEvent = event('auth.client.registered', AuthClientRegisteredData);
export const AuthClientReconstructedEvent = event(
  'auth.client.reconstructed',
  AuthClientReconstructedData,
);
export const AuthGrantCreatedEvent = event('auth.grant.created', AuthGrantCreatedData);
export const AuthGrantUpdatedEvent = event('auth.grant.updated', AuthGrantUpdatedData);
export const AuthTokenIssuedEvent = event('auth.token.issued', AuthTokenIssuedData);
export const AuthTokenRefreshedEvent = event('auth.token.refreshed', AuthTokenRefreshedData);
export const AuthTokenRevokedEvent = event('auth.token.revoked', AuthTokenRevokedData);
export const AuthStepupRequestedEvent = event('auth.stepup.requested', AuthStepupRequestedData);
export const AuthLoginCreatedEvent = event('auth.login.created', AuthLoginCreatedData);
export const AuthDirectoryFetchedEvent = event('auth.directory.fetched', AuthDirectoryFetchedData);
export const SessionStartedEvent = event('session.started', SessionStartedData);
export const SessionInitializedEvent = event('session.initialized', SessionInitializedData);
export const SessionEndedEvent = event('session.ended', SessionEndedData);
export const SessionRejectedEvent = event('session.rejected', SessionRejectedData);
export const CatalogToolsListedEvent = event('catalog.tools_listed', CatalogToolsListedData);
export const CatalogResourcesListedEvent = event(
  'catalog.resources_listed',
  CatalogResourcesListedData,
);
export const CatalogPromptsListedEvent = event('catalog.prompts_listed', CatalogPromptsListedData);
export const CatalogAvailabilityEvent = event('catalog.availability', CatalogAvailabilityData);
export const ToolCallStartedEvent = event('tool.call.started', ToolCallStartedData);
export const ToolCallCompletedEvent = event('tool.call.completed', ToolCallCompletedData);
export const ToolCallCancelledEvent = event('tool.call.cancelled', ToolCallCancelledData);
export const ToolCallDeniedEvent = event('tool.call.denied', ToolCallDeniedData);
export const ProtocolErrorEvent = event('protocol.error', ProtocolErrorData);
export const BankOpEvent = event('bank.op', BankOpData);
export const EtlLoadEvent = event('etl.load', EtlLoadData);
export const EtlProcessedEvent = event('etl.processed', EtlProcessedData);
export const EtlTableEvictedEvent = event('etl.table_evicted', EtlTableEvictedData);
export const EtlLimitReachedEvent = event('etl.limit_reached', EtlLimitReachedData);
export const EtlWorkerTerminatedEvent = event('etl.worker_terminated', EtlWorkerTerminatedData);
export const SqlQueryEvent = event('sql.query', SqlQueryData);
export const SqlTableClearedEvent = event('sql.table_cleared', SqlTableClearedData);
export const SqlRejectedEvent = event('sql.rejected', SqlRejectedData);
export const IntentDeclaredEvent = event('intent.declared', IntentDeclaredData);
export const IntentInferredEvent = event('intent.inferred', IntentInferredData);
export const IntentMissingEvent = event('intent.missing', IntentMissingData);
export const XrayPairingCreatedEvent = event('xray.pairing.created', XrayPairingCreatedData);
export const XrayPairingRejectedEvent = event('xray.pairing.rejected', XrayPairingRejectedData);
export const XrayViewerConnectedEvent = event('xray.viewer.connected', XrayViewerConnectedData);
export const XrayViewerDisconnectedEvent = event(
  'xray.viewer.disconnected',
  XrayViewerDisconnectedData,
);
export const XrayDroppedEvent = event('xray.dropped', XrayDroppedData);
export const XrayEventsDeletedEvent = event('xray.events.deleted', XrayEventsDeletedData);

/** Every known event, as a discriminated union on `type`. */
export const XrayEventSchema = z.discriminatedUnion('type', [
  ServerStartedEvent,
  ServerStoppingEvent,
  HttpRequestEvent,
  AuthChallengeEvent,
  AuthVerifiedEvent,
  AuthRejectedEvent,
  AuthClientRegisteredEvent,
  AuthClientReconstructedEvent,
  AuthGrantCreatedEvent,
  AuthGrantUpdatedEvent,
  AuthTokenIssuedEvent,
  AuthTokenRefreshedEvent,
  AuthTokenRevokedEvent,
  AuthStepupRequestedEvent,
  AuthLoginCreatedEvent,
  AuthDirectoryFetchedEvent,
  SessionStartedEvent,
  SessionInitializedEvent,
  SessionEndedEvent,
  SessionRejectedEvent,
  CatalogToolsListedEvent,
  CatalogResourcesListedEvent,
  CatalogPromptsListedEvent,
  CatalogAvailabilityEvent,
  ToolCallStartedEvent,
  ToolCallCompletedEvent,
  ToolCallCancelledEvent,
  ToolCallDeniedEvent,
  ProtocolErrorEvent,
  BankOpEvent,
  EtlLoadEvent,
  EtlProcessedEvent,
  EtlTableEvictedEvent,
  EtlLimitReachedEvent,
  EtlWorkerTerminatedEvent,
  SqlQueryEvent,
  SqlTableClearedEvent,
  SqlRejectedEvent,
  IntentDeclaredEvent,
  IntentInferredEvent,
  IntentMissingEvent,
  XrayPairingCreatedEvent,
  XrayPairingRejectedEvent,
  XrayViewerConnectedEvent,
  XrayViewerDisconnectedEvent,
  XrayDroppedEvent,
  XrayEventsDeletedEvent,
]);

/** One validated event. */
export type XrayEvent = z.infer<typeof XrayEventSchema>;
/** What a producer may pass before the emitter fills the defaults. */
export type XrayEventInput = z.input<typeof XrayEventSchema>;
export type XrayEventType = XrayEvent['type'];
/** The `data` payload of one event type as a **consumer** sees it: every field present. */
export type XrayEventData<T extends XrayEventType> = Extract<XrayEvent, { type: T }>['data'];
/**
 * The `data` payload as a **producer** writes it: fields the contract defaults may be omitted.
 * This is what `XrayEmitter.emit` accepts, so a block never has to spell out `null` for every
 * optional attribute of an event.
 */
export type XrayEventDataInput<T extends XrayEventType> = Extract<
  XrayEventInput,
  { type: T }
>['data'];
export type ToolAvailability = z.infer<typeof ToolAvailabilitySchema>;
export type UnavailableReason = ToolAvailability['unavailable_reasons'][number];

/** Every event type in catalogue order; `tools/list` order is deterministic, and so is this. */
export const XRAY_EVENT_TYPES: readonly XrayEventType[] = XrayEventSchema.options.map(
  (option) => option.shape.type.value,
);

/** The family part of an event type (`tool.call.started` -> `tool`). */
export const XRAY_EVENT_FAMILIES = [
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
] as const;
export type XrayEventFamily = (typeof XRAY_EVENT_FAMILIES)[number];

export function familyOf(type: string): string {
  return type.split('.')[0] ?? type;
}

/** The documented `data` keys of one event type; the contract test uses it as the allow-list. */
export function dataKeysOf(type: XrayEventType): readonly string[] {
  for (const option of XrayEventSchema.options) {
    if (option.shape.type.value === type) return Object.keys(option.shape.data.shape);
  }
  return [];
}

export function isXrayEventType(value: unknown): value is XrayEventType {
  return typeof value === 'string' && (XRAY_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The forward-compatible envelope: any `type`, any `data`. The dashboard parses with this so an
 * event family that runs ahead of the UI still renders as raw JSON (section 1 of the model).
 */
export const XrayEnvelopeSchema = EnvelopeBase.extend({
  type: z.string().regex(/^[a-z]+(\.[a-z_]+){1,2}$/),
  data: JsonObject.default({}),
});
export type XrayEnvelope = z.infer<typeof XrayEnvelopeSchema>;

/** Strict parse against the catalogue; throws `z.ZodError` on anything unknown or malformed. */
export function parseXrayEvent(value: unknown): XrayEvent {
  return XrayEventSchema.parse(value);
}

/** Strict parse that reports instead of throwing. */
export function safeParseXrayEvent(value: unknown): z.ZodSafeParseResult<XrayEvent> {
  return XrayEventSchema.safeParse(value);
}

/** Lenient parse for consumers that must survive an unknown event type. */
export function parseXrayEnvelope(value: unknown): XrayEnvelope {
  return XrayEnvelopeSchema.parse(value);
}

/** Parses one JSONL line of `test/fixtures/events.jsonl`. */
export function parseXrayEventLine(line: string): XrayEvent {
  return parseXrayEvent(JSON.parse(line));
}

// ---------------------------------------------------------------------------
// The producer interface
// ---------------------------------------------------------------------------

/**
 * What every block receives to report what it did. The real emitter assigns `id`, `ts`, `v` and
 * `seq`, appends the payload to the log as given (v0.9, D-28: no redaction and no truncation on
 * the way in; the viewer surfaces redact on the way out) and fans out to subscribers; it must
 * never throw and never block the caller (docs/ARCHITECTURE.md section 6).
 */
export interface XrayEmitter {
  /**
   * Returns the id the implementation assigned, when it can report one (v0.2, proposal P-5).
   * `void` is still a valid return, so every existing implementation and every existing caller
   * keeps compiling; only a producer that needs to reference the event it just emitted - today
   * `catalog.tools_listed.snapshot_ref` in `src/mcp` - reads the value.
   */
  emit<T extends XrayEventType>(
    type: T,
    data: XrayEventDataInput<T>,
    correlation?: XrayCorrelation,
  ): number | void;
}
