/**
 * The `mcp` block factory.
 *
 * `createMcp(deps)` returns the Express router `src/app.ts` mounts at `/mcp`. The order inside is
 * the whole point of the block:
 *
 *   1. GET and DELETE answer `405` - stateless transport, no GET stream, no session to delete
 *      (ADR-3, invariant 6).
 *   2. The Origin policy is applied (invariant 10).
 *   3. The bearer gate runs **before** the SDK: no token is `401` + Ramp's body + the
 *      `WWW-Authenticate` challenge (invariant 5).
 *   4. The X-ray session for the grant is opened or resumed, so everything after this point -
 *      including a refusal - lands in the right session on the dashboard (A-27).
 *   5. The gate parses `method` and `params.name` and answers `403 insufficient_scope` for a
 *      `tools/call` the grant cannot make (ADR-13), or `429` when the grant has spent its
 *      per-minute `tools/call` budget (invariant 14).
 *   6. Only then does the SDK see the request, through `createTransport`.
 *
 * Every step emits its documented `XrayEvent` (invariant 13). The injected `XrayEmitter` is the
 * observability path; the injected `log` writes one structured line per request to stdout and
 * exists only so `docs/observations/claude-ai.md` can be filled from a container log with no
 * dashboard viewer attached.
 */
import express from 'express';
import type { Request, RequestHandler, Response, Router } from 'express';

import {
  ClientInfoSchema,
  TOOL_CATALOG,
  getTool,
  keepRawBody,
  markHttpObserved,
  normaliseFeatureFlags,
  parseScopeString,
  resourceMetadataUrl,
  type AuthContext,
  type ClientInfo,
  type FeatureFlag,
  type PublicBankInfo,
  type PublicToolRegistry,
  type Scope,
  type ToolRegistry,
  type VerifyAccessToken,
  type XrayCorrelation,
  type XrayEmitter,
} from '../contracts/index.js';

import { bootstrapCall, bootstrapListFor } from './bootstrap-tools.js';
import { createCatalogMemory } from './catalog-memory.js';
import {
  baseUrlForRequest,
  bearerTokenOf,
  decideOrigin,
  isAnthropicEgress,
  scopeDenial,
  sendInsufficientScope,
  sendUnauthorized,
  summariseJsonRpc,
} from './gate.js';
import {
  createHttpObserver,
  createMcpCors,
  createMethodNotAllowed,
  createParseErrorObserver,
  createWindowLimiter,
  httpRequestFacts,
  ipPrefixOf,
  registerPreflight,
} from './http.js';
import { createInFlightCalls } from './in-flight.js';
import { createPublicLane, type PublicLaneHandler } from './public-lane.js';
import { createSessionManager, type EndedSession, type SessionManager } from './sessions.js';
import { createTransport, negotiateProtocolVersion, type ToolPort } from './transport.js';
import type {
  ClientLookup,
  McpConfig,
  McpLogRecord,
  McpLogger,
  PersonaLookup,
  ToolCallBase,
  ToolContextBase,
  ToolContextFactory,
} from './types.js';
import { eraOf, withCorrelation } from './xray.js';

/** How often idle sessions are swept so `session.ended` appears without further traffic. */
export const SESSION_SWEEP_INTERVAL_MS = 60_000;

export interface McpDeps {
  readonly config: McpConfig;
  /** Injected by `src/app.ts` from `createAuth(...).verifyAccessToken`. */
  readonly verifyAccessToken: VerifyAccessToken;
  /** `bankCore.personas.get` in production. */
  readonly lookupPersona: PersonaLookup;
  /** `auth.lookupClient`; the registered-client view `AuthContext` carries. */
  readonly lookupClient: ClientLookup;
  /** Changes on every restart so a user can see why a locked card is active again (A-15). */
  readonly bootId: string;
  /**
   * `createXray(...).emitter`. Optional only so the composition root can be wired in one step at
   * a time; with no emitter this block observes nothing and invariant 13 is unsatisfied, so
   * `src/app.ts` must pass it.
   */
  readonly xray?: XrayEmitter;
  /** `createTools(...)` from `src/tools`. Two bootstrap tools answer until it is injected. */
  readonly registry?: ToolRegistry;
  /** Completes a `ToolContext`; required whenever `registry` is injected. */
  readonly toolContext?: ToolContextFactory;
  /** One structured stdout line per request, for docs/observations/claude-ai.md. */
  readonly log?: McpLogger;
  readonly now?: () => Date;
  /** 0 disables the periodic idle sweep; tests drive `sweep()` by hand instead. */
  readonly sweepIntervalMs?: number;
  /**
   * v0.7, D-26: the public lane `src/app.ts` mounts at `PUBLIC_MCP_PATH`. Absent when
   * `PUBLIC_MCP=off`; then `McpHandle.publicLane` is `null` and nothing is mounted.
   */
  readonly publicLane?: {
    readonly registry: PublicToolRegistry;
    readonly info: PublicBankInfo;
    /** `RATE_LIMIT_PUBLIC_IP_TOOL_CALLS`. */
    readonly ipToolCallsPerMin: number;
    /** `RATE_LIMIT_PUBLIC_TOOL_CALLS`. */
    readonly toolCallsPerMin: number;
  };
  /**
   * v0.9 (D-28): `XRAY_CAPTURE_SKIP_PATHS`, the path prefixes `McpHandle.httpObserver` leaves out.
   * Defaults to none.
   */
  readonly captureSkipPaths?: readonly string[];
}

/**
 * What `createMcp` returns: the Express handler, plus the two hooks the composition root needs.
 * It is a function, so `app.use('/mcp', createMcp(...))` keeps working unchanged.
 */
export interface McpHandle {
  /**
   * Closes every live X-ray session and cancels every tool call still in flight. `src/server.ts`
   * calls this from the SIGTERM handler, before `xray.shutdown()`, so the dashboard sees each
   * session close rather than the stream simply stopping (invariant 12).
   */
  shutdown(reason?: 'server_stopping'): { sessions_ended: number; calls_cancelled: number };
  /** Closes idle sessions now; the periodic sweep calls it. Returns how many it closed. */
  sweep(): number;
  sessions: SessionManager;
  /** The sign-in-free endpoint (D-26), or `null` when it is switched off. */
  publicLane: PublicLaneHandler | null;
  /**
   * v0.9 (D-28): the catch-all `http.request` producer `src/app.ts` mounts in front of every
   * router, for the requests neither MCP endpoint reports (`createHttpObserver`, `http.ts`).
   */
  httpObserver: RequestHandler;
  stats(): {
    sessions: number;
    callsInFlight: number;
    catalogsRemembered: number;
    publicSessions: number;
  };
}

export type McpHandler = RequestHandler & McpHandle;

const defaultLogger = (record: McpLogRecord): void => {
  console.log(JSON.stringify(record));
};

/** An emitter that drops everything, so the block runs before `src/xray` is wired. */
const silentEmitter: XrayEmitter = { emit: () => undefined };

/**
 * Adapts the injected `ToolRegistry` onto the transport's port, or falls back to the two tools
 * this block can answer alone (`src/mcp/bootstrap-tools.ts`).
 */
/**
 * The half of a `ToolContext` this block builds, from what the transport hands a port. The
 * signed-in catalog is only ever reached through the bearer gate, so `auth` is always set here;
 * a `null` would be a wiring mistake, not a caller to serve.
 */
function signedInBase(base: ToolCallBase): ToolContextBase {
  if (base.auth === null) throw new Error('the signed-in catalog was called without an AuthContext');
  return {
    auth: base.auth,
    xray: base.xray,
    featureFlags: base.featureFlags,
    now: base.now,
    requestId: base.requestId,
    publicBaseUrl: base.publicBaseUrl,
  };
}

function toolPortFor(deps: McpDeps): ToolPort {
  const { registry, toolContext } = deps;
  if (registry === undefined) {
    if (toolContext !== undefined) {
      throw new Error('createMcp was given a toolContext factory but no registry to use it with');
    }
    return {
      // The frozen catalog unfiltered: the transport needs it to tell "no such tool" apart from
      // "hidden by a feature flag", which are the same `-32601` to the client but not to the log.
      catalog: TOOL_CATALOG,
      listFor: bootstrapListFor,
      call: (name, args, base) => Promise.resolve(bootstrapCall(name, args, signedInBase(base))),
    };
  }
  if (toolContext === undefined) {
    throw new Error(
      'createMcp needs a toolContext factory to build the ToolContext the registry expects',
    );
  }
  return {
    catalog: registry.catalog,
    listFor: (grant, flags) => registry.listFor(grant, flags),
    call: async (name, args, base) =>
      registry.call(name, args, await toolContext(signedInBase(base))),
  };
}

export function createMcp(deps: McpDeps): McpHandler {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLogger;
  const xray = deps.xray ?? silentEmitter;
  const featureFlags: FeatureFlag[] = normaliseFeatureFlags(config.featureFlags);
  const tools = toolPortFor(deps);
  const catalogMemory = createCatalogMemory();
  const inFlight = createInFlightCalls({ xray, now });
  const sessions = createSessionManager({ idleGapMinutes: config.xsIdleGapMinutes, now });
  const transport = createTransport({
    tools,
    xray,
    catalogMemory,
    inFlight,
    counters: sessions,
    now,
  });
  // A fixed window per grant for `tools/call` (invariant 14, `RATE_LIMIT_GRANT_TOOL_CALLS`).
  const hitGrantLimit = createWindowLimiter(config.grantToolCallsPerMin, now);
  const sweepEvery = deps.sweepIntervalMs ?? SESSION_SWEEP_INTERVAL_MS;
  const publicLane =
    deps.publicLane === undefined
      ? null
      : createPublicLane({
          config: {
            publicBaseUrl: config.publicBaseUrl,
            publicHosts: config.publicHosts,
            originPolicy: config.originPolicy,
            xsIdleGapMinutes: config.xsIdleGapMinutes,
            ipToolCallsPerMin: deps.publicLane.ipToolCallsPerMin,
            toolCallsPerMin: deps.publicLane.toolCallsPerMin,
          },
          registry: deps.publicLane.registry,
          info: deps.publicLane.info,
          xray,
          log,
          now,
          sweepIntervalMs: sweepEvery,
        });

  /** `session.ended` for a segment the idle gap or the shutdown closed (section 4). */
  function emitSessionEnded(ended: EndedSession, reason: EndedSession['reason']): void {
    xray.emit(
      'session.ended',
      {
        reason,
        idle_ms: ended.idleMs,
        duration_ms: ended.durationMs,
        call_count: ended.callCount,
        error_count: ended.errorCount,
        initialize_count: ended.initializeCount,
      },
      {
        xs: ended.xs,
        grant_id: ended.grantId,
        login_id: ended.loginId,
        persona_id: ended.personaId,
        client: ended.client,
        protocol_version: ended.protocolVersion,
        era: ended.era,
      },
    );
  }

  function sweep(): number {
    const closed = sessions.sweep();
    for (const ended of closed) emitSessionEnded(ended, 'idle_gap');
    return closed.length;
  }

  const sweepTimer =
    sweepEvery > 0
      ? setInterval(() => {
          sweep();
        }, sweepEvery)
      : null;
  // Unref'd: an idle sweep must never be the reason the process stays alive (invariant 12).
  sweepTimer?.unref();

  const router: Router = express.Router();
  // `keepRawBody` keeps the bytes for the `raw` block of `http.request` (v0.9, D-28).
  router.use(express.json({ limit: '4mb', verify: keepRawBody }));

  /** Requests whose `http.request` has already been arranged, so it is emitted exactly once. */
  const observed = new WeakSet<Response>();

  // CORS on every answer, the preflight, and 405 for GET and DELETE (`http.ts`, invariant 6).
  const applyMcpCors = createMcpCors(config);
  registerPreflight(router, applyMcpCors);
  const methodNotAllowed = createMethodNotAllowed({
    config,
    now,
    log,
    xray,
    observed,
    applyCors: applyMcpCors,
  });
  router.get('/', methodNotAllowed);
  router.delete('/', methodNotAllowed);

  // `next(error)` rather than `void handlePost(...)`: an unobserved rejection is an
  // `unhandledRejection`, which Node 23 turns into a process exit.
  router.post('/', (request: Request, response: Response, next) => {
    handlePost(request, response).catch(next);
  });

  async function handlePost(request: Request, response: Response): Promise<void> {
    const startedAt = now().getTime();
    applyMcpCors(request, response);
    const baseUrl = baseUrlForRequest(request, config);
    const summary = summariseJsonRpc(request.body);
    const remoteIp = request.ip ?? request.socket.remoteAddress ?? null;
    const origin = request.get('origin');
    const originDecision = decideOrigin(origin, baseUrl, config.originPolicy);
    const requestId = summary.ids.length > 0 ? String(summary.ids[0]) : null;

    let grantId: string | null = null;
    let xs: string | null = null;
    let rateLimited = false;
    // Filled in as the request reveals who it is; `http.request` carries whatever is known.
    let correlation: XrayCorrelation = { request_id: requestId, trace_id: summary.traceparent };

    observed.add(response);
    markHttpObserved(response);
    // Once, on `finish` or on a `close` that came first (the caller hung up mid-answer).
    let reported = false;
    const report = (): void => {
      if (reported) return;
      reported = true;
      const status = response.statusCode;
      const durationMs = Math.max(0, now().getTime() - startedAt);
      const contentType = String(response.getHeader('content-type') ?? '');
      // One structured line per request: this is what fills docs/observations/claude-ai.md with
      // the JSON-RPC facts `http.request` deliberately does not carry.
      log({
        event: 'http.request',
        ts: now().toISOString(),
        method: request.method,
        path: request.originalUrl,
        status,
        duration_ms: durationMs,
        base_url: baseUrl,
        host: request.headers.host ?? null,
        user_agent: request.get('user-agent') ?? null,
        remote_ip_prefix: ipPrefixOf(remoteIp),
        anthropic_egress: isAnthropicEgress(remoteIp),
        origin: origin ?? null,
        origin_decision: originDecision.decision,
        origin_policy: config.originPolicy,
        mcp_protocol_version_header: request.get('mcp-protocol-version') ?? null,
        mcp_session_id: request.get('mcp-session-id') ?? null,
        has_authorization: request.get('authorization') !== undefined,
        content_type: request.get('content-type') ?? null,
        rate_limited: rateLimited,
        // The JSON-RPC facts the observations table asks for.
        rpc_methods: summary.methods,
        rpc_tools: summary.toolNames,
        initialize_protocol_version: summary.protocolVersion,
        client_info: summary.clientInfo,
        client_capabilities: summary.clientCapabilities,
        grant_id: grantId,
        xs,
      });
      xray.emit(
        'http.request',
        httpRequestFacts(request, config, {
          status,
          durationMs,
          sse: contentType.includes('text/event-stream'),
          rateLimited,
        }),
        correlation,
      );
    };
    response.on('finish', report);
    response.on('close', report);

    if (!originDecision.allowed) {
      xray.emit(
        'session.rejected',
        {
          reason: 'origin_rejected',
          error: `Origin ${origin ?? ''} is not allowed by this deployment's Origin policy`,
          protocol_version_requested: summary.protocolVersion,
        },
        correlation,
      );
      response.status(403).json({
        error: 'origin_not_allowed',
        error_description: `The Origin ${origin ?? ''} is not allowed by this deployment's Origin policy.`,
      });
      return;
    }

    const token = bearerTokenOf(request);
    if (token === null) {
      // Invariant 5: 401 starts auth, never 200 + isError.
      sendUnauthorized(response, baseUrl);
      return;
    }

    const verification = await deps.verifyAccessToken(token, { now: now() });
    if (!verification.ok) {
      sendUnauthorized(response, baseUrl, { error: verification.error });
      return;
    }

    const claims = verification.claims;
    grantId = claims.grant_id;
    const scopes = parseScopeString(claims.scope);

    // The client only ever arrives on `initialize`; the session record carries it forward so a
    // stateless `tools/call` still reports who is calling (A-28, the T0.3 gap).
    const parsedClient =
      summary.clientInfo === null ? null : ClientInfoSchema.safeParse(summary.clientInfo);
    const requestClient: ClientInfo | null =
      parsedClient !== null && parsedClient.success ? parsedClient.data : null;
    const headerVersion = request.get('mcp-protocol-version') ?? null;
    const sessionProtocol = summary.isInitialize
      ? negotiateProtocolVersion(summary.protocolVersion)
      : (summary.protocolVersion ?? headerVersion);

    // Opened before the scope check so a refusal lands in the session it belongs to.
    const touch = sessions.touch(claims.grant_id, {
      isInitialize: summary.isInitialize,
      client: requestClient,
      protocolVersion: sessionProtocol,
      era: eraOf(sessionProtocol),
      personaId: claims.sub,
      loginId: claims.login_id,
    });
    xs = touch.xs;
    correlation = {
      xs: touch.xs,
      login_id: claims.login_id,
      grant_id: claims.grant_id,
      persona_id: claims.sub,
      request_id: requestId,
      era: touch.session.era,
      client: touch.session.client,
      protocol_version: touch.session.protocolVersion,
      trace_id: summary.traceparent,
    };
    if (touch.ended !== null) emitSessionEnded(touch.ended, 'idle_gap');
    if (touch.started) {
      xray.emit(
        'session.started',
        { reason: touch.reason === 'idle_gap' ? 'idle_gap' : 'first_request', idle_ms: touch.idleMs },
        correlation,
      );
    }

    // ADR-13: the scope decision happens here, before the SDK, on the parsed JSON-RPC body.
    const denial = scopeDenial(
      summary,
      { scopes, auth_level: claims.auth_level },
      tools.catalog,
      featureFlags,
    );
    if (denial !== null) {
      const tool = getTool(denial.tool);
      xray.emit(
        'tool.call.denied',
        {
          tool: denial.tool,
          denied_reason: 'insufficient_scope',
          required_scopes: tool === undefined ? [] : [...tool.requiredScopes],
          missing_scopes: [...denial.scopes],
          status: 403,
        },
        correlation,
      );
      xray.emit(
        'auth.stepup.requested',
        {
          status: 403,
          error: 'insufficient_scope',
          grant_id: claims.grant_id,
          login_id: claims.login_id,
          persona_id: claims.sub,
          tool: denial.tool,
          scope: denial.scopes.join(' '),
          missing_scopes: [...denial.scopes],
          resource_metadata: resourceMetadataUrl(baseUrl),
        },
        correlation,
      );
      sendInsufficientScope(response, baseUrl, denial.scopes, denial.tool, denial.ownMissing);
      return;
    }

    if (summary.toolNames.length > 0 && hitGrantLimit(claims.grant_id)) {
      rateLimited = true;
      for (const name of summary.toolNames) {
        const tool = getTool(name);
        xray.emit(
          'tool.call.denied',
          {
            tool: name,
            denied_reason: 'rate_limited',
            required_scopes: tool === undefined ? [] : [...tool.requiredScopes],
            missing_scopes: [],
            status: 429,
          },
          correlation,
        );
      }
      sessions.noteError(claims.grant_id);
      response.setHeader('Retry-After', '60');
      response.status(429).json({
        error: 'too_many_requests',
        error_description: 'This connection has made too many tool calls in the last minute.',
      });
      return;
    }

    const persona = await deps.lookupPersona(claims.sub);
    if (persona === null) {
      sendUnauthorized(response, baseUrl, { error: 'invalid_token' });
      return;
    }

    const auth: AuthContext = {
      persona,
      login_id: claims.login_id,
      grant_id: claims.grant_id,
      parent_grant_id: null,
      scopes: scopes as Scope[],
      auth_level: claims.auth_level,
      // Carried on the session record, so it survives a stateless `tools/call` (A-28).
      client: touch.session.client,
      oauth_client: deps.lookupClient(claims.client_id),
      xs: touch.xs,
      boot_id: deps.bootId,
      token_expires_at: new Date(claims.exp * 1000).toISOString(),
      aud: claims.aud,
    };

    try {
      const outcome = await transport.handle(request, response, request.body, {
        auth,
        grantId: claims.grant_id,
        grant: { scopes: auth.scopes, auth_level: auth.auth_level },
        featureFlags,
        // The JSON-RPC id, never `res.locals.requestId`. The envelope defines `request_id` as the
        // JSON-RPC id (`src/contracts/events.ts`), `tool.call.started` is emitted with exactly
        // that through `correlation`, and the dashboard keys a call on `<xs>#<request_id>`. Handing
        // the tools block the HTTP id instead made every `intent.*`, `bank.op`, `etl.*` and `sql.*`
        // of a live server fail to nest inside its call - the events were all there and the one
        // view built to show what a call did came up empty.
        requestId,
        publicBaseUrl: config.publicBaseUrl,
        correlation,
        xray: withCorrelation(xray, correlation),
        summary,
      });

      if (summary.isInitialize) {
        const failed = outcome.protocolErrors.some((error) => error.method === 'initialize');
        if (failed) {
          xray.emit(
            'session.rejected',
            {
              reason: 'initialize',
              error: outcome.protocolErrors.find((error) => error.method === 'initialize')?.message ?? null,
              protocol_version_requested: summary.protocolVersion,
            },
            correlation,
          );
        } else {
          xray.emit(
            'session.initialized',
            {
              protocol_version_requested: summary.protocolVersion,
              protocol_version_negotiated: outcome.protocolVersionNegotiated,
              client: touch.session.client,
              client_capabilities: summary.clientCapabilities ?? {},
              server_capabilities: outcome.serverCapabilities,
              instructions_sent: outcome.instructionsSent,
              initialize_count: touch.initializeCount,
            },
            correlation,
          );
        }
      }
    } catch (error) {
      xray.emit(
        'protocol.error',
        {
          'mcp.method.name': summary.methods[0] ?? null,
          code: -32603,
          message: error instanceof Error ? error.message : 'unknown transport failure',
        },
        correlation,
      );
      sessions.noteError(claims.grant_id);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error.' },
          id: null,
        });
      }
    }
  }

  // A body `express.json` refused still gets `protocol.error` and `http.request` (`http.ts`).
  router.use(createParseErrorObserver({ config, now, xray, observed }));

  const handle = router as unknown as McpHandler;
  handle.shutdown = (reason: 'server_stopping' = 'server_stopping') => {
    if (sweepTimer !== null) clearInterval(sweepTimer);
    const callsCancelled = inFlight.cancelAll('server_stopping');
    const closed = sessions.endAll(reason);
    for (const ended of closed) emitSessionEnded(ended, 'server_stopping');
    const lane = publicLane?.shutdown(reason) ?? { sessions_ended: 0, calls_cancelled: 0 };
    return {
      sessions_ended: closed.length + lane.sessions_ended,
      calls_cancelled: callsCancelled + lane.calls_cancelled,
    };
  };
  // The public lane runs its own sweep timer; this one is the signed-in endpoint's.
  handle.sweep = sweep;
  handle.sessions = sessions;
  handle.publicLane = publicLane;
  handle.httpObserver = createHttpObserver({
    config,
    now,
    xray,
    skipPaths: deps.captureSkipPaths ?? [],
  });
  handle.stats = () => ({
    sessions: sessions.size,
    callsInFlight: inFlight.size,
    catalogsRemembered: catalogMemory.size,
    publicSessions: publicLane?.sessions.size ?? 0,
  });
  return handle;
}

export { createTransport, negotiateProtocolVersion, SERVER_CAPABILITIES } from './transport.js';
export {
  bootstrapCall,
  bootstrapListFor,
  catalogContentHash,
  BOOTSTRAP_TOOLS,
  NOT_IMPLEMENTED_MESSAGE,
} from './bootstrap-tools.js';
export { SERVER_INSTRUCTIONS, SERVER_INFO } from './instructions.js';
export { createSessionManager } from './sessions.js';
export {
  createPublicLane,
  visitorGrantId,
  PUBLIC_BODY_LIMIT,
  type PublicLaneConfig,
  type PublicLaneDeps,
  type PublicLaneHandle,
  type PublicLaneHandler,
} from './public-lane.js';
export { PUBLIC_SERVER_INFO, PUBLIC_SERVER_INSTRUCTIONS } from './instructions.js';
export { catalogRowsOf, eraOf, inputSchemaHash, withCorrelation } from './xray.js';
export type { ToolPort, TransportOutcome, TransportRequestContext } from './transport.js';
export type { EndedSession, SessionManager, SessionState } from './sessions.js';
export type {
  McpConfig,
  McpLogger,
  McpLogRecord,
  SpikeLogger,
  SpikeLogRecord,
  ToolContextBase,
  ToolContextFactory,
} from './types.js';
