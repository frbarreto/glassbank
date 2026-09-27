/**
 * The bearer gate (block: mcp).
 *
 * CLAUDE.md invariant 5: the gate runs **before** the SDK ever sees the request. It answers
 * `401` (never `200` + `isError`) to start auth, and it parses `method` and `params.name` out of
 * the JSON-RPC body so that a `tools/call` whose scope the grant lacks gets `403` with the
 * 2025-11-25 `insufficient_scope` challenge (ADR-13) instead of reaching a handler.
 *
 * Nothing here logs or echoes a token (invariant 7).
 */
import type { Request, Response } from 'express';

import {
  ANTHROPIC_EGRESS_CIDR,
  DEFAULT_CHALLENGE_SCOPES,
  NO_ACCESS_TOKEN_BODY,
  SCOPES,
  buildInsufficientScopeChallenge,
  buildUnauthorizedChallenge,
  canonicalBaseUrl,
  flagsEnabledFor,
  getTool,
  missingScopesFor,
  resourceMetadataUrl,
  stepUpScopes,
  supportedScopes,
  type FeatureFlag,
  type GrantView,
  type OriginDecision,
  type Scope,
  type ScopedTool,
} from '../contracts/index.js';

import type { McpConfig } from './types.js';

/** One JSON-RPC message of the body; a batch carries several. */
export interface JsonRpcFrame {
  readonly id: string | number | null;
  readonly method: string | null;
}

/** What the gate could read out of a JSON-RPC body without trusting it. */
export interface JsonRpcSummary {
  /** Every message in the body, so a JSON-RPC error can be named by the method that caused it. */
  readonly frames: readonly JsonRpcFrame[];
  /** Every `method` in the frame (a batch carries several). */
  readonly methods: readonly string[];
  /** Every `params.name` of a `tools/call` in the frame. */
  readonly toolNames: readonly string[];
  /** `initialize.params.protocolVersion`, for docs/observations/claude-ai.md. */
  readonly protocolVersion: string | null;
  /** `initialize.params.clientInfo`, verbatim. Displayed, never trusted (A-28). */
  readonly clientInfo: Record<string, unknown> | null;
  readonly clientCapabilities: Record<string, unknown> | null;
  readonly ids: readonly (string | number | null)[];
  readonly isInitialize: boolean;
  /** `_meta.traceparent` if a client ever sends one (W3C trace context, envelope `trace_id`). */
  readonly traceparent: string | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads the JSON-RPC frame the gate has to make a decision about. A batch is an array; every
 * element is inspected, because one bad call in a batch must not slip past the scope check.
 */
export function summariseJsonRpc(body: unknown): JsonRpcSummary {
  const messages = Array.isArray(body) ? body : [body];
  const frames: JsonRpcFrame[] = [];
  const methods: string[] = [];
  const toolNames: string[] = [];
  const ids: (string | number | null)[] = [];
  let protocolVersion: string | null = null;
  let clientInfo: Record<string, unknown> | null = null;
  let clientCapabilities: Record<string, unknown> | null = null;
  let traceparent: string | null = null;

  for (const frame of messages) {
    const message = asObject(frame);
    if (message === null) continue;
    const method = typeof message.method === 'string' ? message.method : null;
    if (method !== null) methods.push(method);
    const id =
      typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
    if (id !== null) ids.push(id);
    frames.push({ id, method });

    const params = asObject(message.params);
    if (params === null) continue;
    if (method === 'tools/call' && typeof params.name === 'string') toolNames.push(params.name);
    const meta = asObject(params._meta);
    if (meta !== null && typeof meta.traceparent === 'string') traceparent = meta.traceparent;
    if (method === 'initialize') {
      if (typeof params.protocolVersion === 'string') protocolVersion = params.protocolVersion;
      clientInfo = asObject(params.clientInfo);
      clientCapabilities = asObject(params.capabilities);
    }
  }

  return {
    frames,
    methods,
    toolNames,
    protocolVersion,
    clientInfo,
    clientCapabilities,
    ids,
    isInitialize: methods.includes('initialize'),
    traceparent,
  };
}

/** `Authorization: Bearer <token>`, case-insensitive scheme. Returns `null` when absent. */
export function bearerTokenOf(request: Request): string | null {
  const header = request.get('authorization');
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** The origin every challenge URL is built from: the validated `Host`, else `PUBLIC_BASE_URL`. */
export function baseUrlForRequest(
  request: Request,
  config: Pick<McpConfig, 'publicBaseUrl' | 'publicHosts'>,
): string {
  const forwarded = request.headers['x-forwarded-host'];
  const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const raw =
    (typeof candidate === 'string' && candidate.length > 0 ? candidate : request.headers.host) ??
    null;
  const host = raw === null ? null : (raw.split(',')[0]?.trim() ?? null);
  return canonicalBaseUrl(host, config);
}

// ---------------------------------------------------------------------------
// Origin policy (CLAUDE.md invariant 10)
// ---------------------------------------------------------------------------

/**
 * Absent `Origin` is allowed (server-side clients never send one). claude.ai, claude.com and our
 * own origin are allowed. Anything else is *rejected only in `allowlist` mode*: over-strict
 * validation is a documented cause of claude.ai initialize timeouts, so Phase 0 runs `log-only`.
 */
export function decideOrigin(
  origin: string | undefined,
  baseUrl: string,
  policy: 'log-only' | 'allowlist',
): { readonly decision: OriginDecision; readonly allowed: boolean } {
  if (origin === undefined || origin.length === 0) return { decision: 'absent', allowed: true };
  const allowedOrigins = new Set(['https://claude.ai', 'https://claude.com', baseUrl]);
  if (allowedOrigins.has(origin)) return { decision: 'allowed', allowed: true };
  if (policy === 'allowlist') return { decision: 'rejected', allowed: false };
  return { decision: 'logged', allowed: true };
}

/** True when the address is inside Anthropic's documented egress range `160.79.104.0/21`. */
export function isAnthropicEgress(address: string | null | undefined): boolean {
  if (!address) return false;
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const [network, bitsText] = ANTHROPIC_EGRESS_CIDR.split('/');
  const bits = Number(bitsText);
  const toInteger = (value: string): number | null => {
    const octets = value.split('.');
    if (octets.length !== 4) return null;
    let total = 0;
    for (const octet of octets) {
      if (!/^\d{1,3}$/.test(octet)) return null;
      const parsed = Number(octet);
      if (parsed > 255) return null;
      total = total * 256 + parsed;
    }
    return total;
  };
  const candidate = toInteger(plain);
  const base = network === undefined ? null : toInteger(network);
  if (candidate === null || base === null || !Number.isFinite(bits)) return false;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return (candidate & mask) >>> 0 === (base & mask) >>> 0;
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

/**
 * The 401 that starts auth: Ramp's body verbatim, plus the `resource_metadata` the client needs
 * to find the PRM document and the read-only scope hint.
 */
export function sendUnauthorized(
  response: Response,
  baseUrl: string,
  options: { readonly error?: string } = {},
): void {
  const challenge = buildUnauthorizedChallenge({
    resourceMetadata: resourceMetadataUrl(baseUrl),
    scopes: DEFAULT_CHALLENGE_SCOPES,
    ...(options.error === undefined ? {} : { error: options.error }),
  });
  response.setHeader('WWW-Authenticate', challenge);
  response.setHeader('Cache-Control', 'no-store');
  response.status(401).json(NO_ACCESS_TOKEN_BODY);
}

/**
 * The scopes the 403 must ask for: every still-needed **write** scope of the whole catalog
 * (Claude does not carry earlier step-up scopes forward) plus any scope this particular tool is
 * still missing, so a tool hidden by a missing *read* scope is also recoverable.
 *
 * Feature flags bound the answer twice. The catalog is filtered to flag-enabled tools, so a
 * `writes=on, transfers=off` deployment does not ask for `transfers:write` on behalf of a tool
 * nobody can call; and the result is intersected with `supportedScopes(enabledFlags)`, so the
 * challenge can never name a scope the authorization server refuses to issue - a client that
 * followed such a challenge would re-authorize, get the same grant back and 403 forever.
 */
export function stepUpScopesFor(
  catalog: readonly ScopedTool[],
  grant: GrantView,
  tool: ScopedTool,
  enabledFlags: readonly FeatureFlag[],
): Scope[] {
  const enabledCatalog = catalog.filter((entry) => flagsEnabledFor(entry, enabledFlags));
  const issuable = new Set<Scope>(supportedScopes(enabledFlags));
  const missing = missingScopesFor(tool, grant.scopes);
  const needed = new Set<Scope>([...stepUpScopes(enabledCatalog, grant), ...missing]);
  const challenge = SCOPES.filter((scope) => needed.has(scope) && issuable.has(scope));
  // Both write tools of the v1 catalog are gated by `writes`, and `supportedScopes` advertises the
  // write scopes exactly when that flag is on, so the intersection is never empty in practice.
  // If a later catalog entry breaks that pairing, the call still has to be denied - so fall back
  // to this tool's own missing scopes rather than sending an empty `scope=""`.
  return challenge.length > 0 ? challenge : missing;
}

/**
 * ADR-13: the 403 step-up for a listed tool the grant cannot use yet.
 *
 * `scopes` is the deliberately-widened challenge list, so one re-consent covers every tool this
 * connection still cannot use; `ownMissing` is what THIS tool is actually short of. The header
 * carries the wide list, but the sentence is written from the narrow one, because the sentence is
 * what the model reads and relays: telling the user that reading a dashboard link requires
 * permission to move money is false, and it is the kind of false that loses their consent.
 */
export function sendInsufficientScope(
  response: Response,
  baseUrl: string,
  scopes: readonly Scope[],
  toolName: string,
  ownMissing: readonly Scope[] = scopes,
): void {
  response.setHeader(
    'WWW-Authenticate',
    buildInsufficientScopeChallenge({
      resourceMetadata: resourceMetadataUrl(baseUrl),
      scopes,
    }),
  );
  response.setHeader('Cache-Control', 'no-store');
  const needs = ownMissing.length > 0 ? ownMissing : scopes;
  const extra = scopes.filter((scope) => !needs.includes(scope));
  const description =
    extra.length > 0
      ? `The tool ${toolName} needs ${needs.join(' ')}, which this connection has not been granted. ` +
        `Re-authorize with ${scopes.join(' ')} to also cover every other tool this connection cannot use yet.`
      : `The tool ${toolName} needs ${needs.join(' ')}, which this connection has not been granted.`;
  response.status(403).json({ error: 'insufficient_scope', error_description: description });
}

/**
 * The scope decision for a whole frame: the first `tools/call` whose scopes the grant lacks.
 * Unknown tool names are passed through to the SDK, which answers `-32601`.
 *
 * A tool whose `x-gated-by` flag is off is deliberately hidden from `tools/list` (ADR-13), so it
 * must look unknown here too and get the SDK's `-32601` rather than a step-up. Answering `403`
 * for it demanded scopes the authorization server would refuse to issue, which left the client
 * re-authorizing in a loop it could never escape.
 */
export function scopeDenial(
  summary: JsonRpcSummary,
  grant: GrantView,
  catalog: readonly ScopedTool[],
  enabledFlags: readonly FeatureFlag[],
): {
  readonly tool: string;
  /** The widened challenge list for `WWW-Authenticate`. */
  readonly scopes: Scope[];
  /** What this tool alone is short of; what the 403's sentence is written from. */
  readonly ownMissing: Scope[];
} | null {
  for (const name of summary.toolNames) {
    const tool = getTool(name);
    if (tool === undefined) continue;
    if (!flagsEnabledFor(tool, enabledFlags)) continue;
    const ownMissing = missingScopesFor(tool, grant.scopes);
    if (ownMissing.length === 0) continue;
    return {
      tool: name,
      scopes: stepUpScopesFor(catalog, grant, tool, enabledFlags),
      ownMissing,
    };
  }
  return null;
}
