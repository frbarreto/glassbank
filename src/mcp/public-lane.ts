/**
 * The public lane: `POST /public/mcp`, the MCP endpoint that needs no sign-in (block: mcp, D-26).
 *
 * Same transport, same events, same Origin policy as `/mcp`; what changes is who the caller is.
 * There is no bearer gate and no challenge, ever: a request is answered from `PublicBankInfo`
 * through the six public tools, and anything personal is pointed at the signed-in connector by
 * the tools' own text. A `401` here would start OAuth in some clients and fail in others (the
 * reason the lanes are two URLs, `docs/ARCHITECTURE.md` ADR-19).
 *
 * The caller is anonymous, but the X-ray keys everything on a grant (invariant 6), so each visitor
 * gets a pseudo grant: `grt_pub_` plus a hash of its IP prefix and User-Agent. That hash groups a
 * visitor's calls into sessions on the dashboard and does nothing else; the rate limits key on
 * the IP prefix alone and on the lane as a whole, never on the User-Agent (A-29). Every visitor
 * belongs to the pseudo login `PUBLIC_LOGIN_ID`, which is what the public viewer sees
 * (invariant 11).
 */
import { createHash } from 'node:crypto';

import express from 'express';
import type { Request, RequestHandler, Response, Router } from 'express';

import {
  ClientInfoSchema,
  keepRawBody,
  markHttpObserved,
  PUBLIC_GRANT_PREFIX,
  PUBLIC_LOGIN_ID,
  type ClientInfo,
  type PublicBankInfo,
  type PublicToolRegistry,
  type XrayCorrelation,
  type XrayEmitter,
} from '../contracts/index.js';

import { createCatalogMemory } from './catalog-memory.js';
import { baseUrlForRequest, decideOrigin, isAnthropicEgress, summariseJsonRpc } from './gate.js';
import {
  createMcpCors,
  createMethodNotAllowed,
  createParseErrorObserver,
  createWindowLimiter,
  httpRequestFacts,
  ipPrefixOf,
  registerPreflight,
  remoteIpOf,
} from './http.js';
import { createInFlightCalls } from './in-flight.js';
import { PUBLIC_SERVER_INFO, PUBLIC_SERVER_INSTRUCTIONS } from './instructions.js';
import { createSessionManager, type EndedSession, type SessionManager } from './sessions.js';
import { createTransport, negotiateProtocolVersion, type ToolPort } from './transport.js';
import type { McpConfig, McpLogger } from './types.js';
import { eraOf, withCorrelation } from './xray.js';

/** The request body cap: a public call carries a few short strings, never a 4 MB batch. */
export const PUBLIC_BODY_LIMIT = '256kb';

export interface PublicLaneConfig
  extends Pick<McpConfig, 'publicBaseUrl' | 'publicHosts' | 'originPolicy' | 'xsIdleGapMinutes'> {
  /** `RATE_LIMIT_PUBLIC_IP_TOOL_CALLS`: `tools/call` per IP prefix per minute. */
  readonly ipToolCallsPerMin: number;
  /** `RATE_LIMIT_PUBLIC_TOOL_CALLS`: `tools/call` per minute across every visitor. */
  readonly toolCallsPerMin: number;
}

export interface PublicLaneDeps {
  readonly config: PublicLaneConfig;
  readonly registry: PublicToolRegistry;
  readonly info: PublicBankInfo;
  readonly xray: XrayEmitter;
  readonly log: McpLogger;
  readonly now: () => Date;
  /** 0 disables the periodic idle sweep. */
  readonly sweepIntervalMs: number;
}

export interface PublicLaneHandle {
  shutdown(reason?: 'server_stopping'): { sessions_ended: number; calls_cancelled: number };
  sweep(): number;
  sessions: SessionManager;
  stats(): { sessions: number; callsInFlight: number };
}

export type PublicLaneHandler = RequestHandler & PublicLaneHandle;

/**
 * The visitor's pseudo grant: its IP prefix (never the address, invariant 11) and User-Agent,
 * hashed. Grouping only: two agents behind one egress and one User-Agent share a visitor.
 */
export function visitorGrantId(request: Request): string {
  const prefix = ipPrefixOf(remoteIpOf(request)) ?? 'unknown';
  const agent = request.get('user-agent') ?? '';
  const digest = createHash('sha256').update(`${prefix}\n${agent}`).digest('hex').slice(0, 12);
  return `${PUBLIC_GRANT_PREFIX}${digest}`;
}

export function createPublicLane(deps: PublicLaneDeps): PublicLaneHandler {
  const { config, now, log, xray } = deps;
  const catalogMemory = createCatalogMemory();
  const inFlight = createInFlightCalls({ xray, now });
  const sessions = createSessionManager({ idleGapMinutes: config.xsIdleGapMinutes, now });
  const port: ToolPort = {
    catalog: deps.registry.catalog,
    listFor: () => deps.registry.list(),
    call: (name, args, base) =>
      deps.registry.call(name, args, {
        info: deps.info,
        xray: base.xray,
        now: base.now,
        requestId: base.requestId,
        publicBaseUrl: base.publicBaseUrl,
        grantId: base.grantId,
        xs: base.xs,
      }),
  };
  const transport = createTransport({
    tools: port,
    xray,
    catalogMemory,
    inFlight,
    counters: sessions,
    now,
    instructions: PUBLIC_SERVER_INSTRUCTIONS,
    serverInfo: PUBLIC_SERVER_INFO,
  });
  const hitIpLimit = createWindowLimiter(config.ipToolCallsPerMin, now);
  const hitLaneLimit = createWindowLimiter(config.toolCallsPerMin, now, 1);

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
        login_id: PUBLIC_LOGIN_ID,
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
    deps.sweepIntervalMs > 0
      ? setInterval(() => {
          sweep();
        }, deps.sweepIntervalMs)
      : null;
  sweepTimer?.unref();

  const router: Router = express.Router();
  // `keepRawBody` keeps the bytes for the `raw` block of `http.request` (v0.9, D-28).
  router.use(express.json({ limit: PUBLIC_BODY_LIMIT, verify: keepRawBody }));
  const observed = new WeakSet<Response>();
  const applyCors = createMcpCors(config);
  /** A request that never reaches the handler is still the visitor's, and public. */
  const correlationOf = (request: Request): XrayCorrelation => ({
    login_id: PUBLIC_LOGIN_ID,
    grant_id: visitorGrantId(request),
  });

  registerPreflight(router, applyCors);
  const methodNotAllowed = createMethodNotAllowed({
    config,
    now,
    log,
    xray,
    observed,
    applyCors,
    correlationOf,
  });
  router.get('/', methodNotAllowed);
  router.delete('/', methodNotAllowed);
  router.post('/', (request: Request, response: Response, next) => {
    handlePost(request, response).catch(next);
  });

  async function handlePost(request: Request, response: Response): Promise<void> {
    const startedAt = now().getTime();
    applyCors(request, response);
    const baseUrl = baseUrlForRequest(request, config);
    const summary = summariseJsonRpc(request.body);
    const remoteIp = remoteIpOf(request);
    const origin = request.get('origin');
    const originDecision = decideOrigin(origin, baseUrl, config.originPolicy);
    const requestId = summary.ids.length > 0 ? String(summary.ids[0]) : null;
    const grantId = visitorGrantId(request);
    let rateLimited = false;
    let correlation: XrayCorrelation = {
      login_id: PUBLIC_LOGIN_ID,
      grant_id: grantId,
      request_id: requestId,
      trace_id: summary.traceparent,
    };

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
      log({
        event: 'http.request',
        lane: 'public',
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
        has_authorization: request.get('authorization') !== undefined,
        rate_limited: rateLimited,
        rpc_methods: summary.methods,
        rpc_tools: summary.toolNames,
        initialize_protocol_version: summary.protocolVersion,
        client_info: summary.clientInfo,
        client_capabilities: summary.clientCapabilities,
        grant_id: grantId,
        xs: correlation.xs ?? null,
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

    const parsedClient =
      summary.clientInfo === null ? null : ClientInfoSchema.safeParse(summary.clientInfo);
    const requestClient: ClientInfo | null =
      parsedClient !== null && parsedClient.success ? parsedClient.data : null;
    const headerVersion = request.get('mcp-protocol-version') ?? null;
    const sessionProtocol = summary.isInitialize
      ? negotiateProtocolVersion(summary.protocolVersion)
      : (summary.protocolVersion ?? headerVersion);

    const touch = sessions.touch(grantId, {
      isInitialize: summary.isInitialize,
      client: requestClient,
      protocolVersion: sessionProtocol,
      era: eraOf(sessionProtocol),
      personaId: null,
      loginId: PUBLIC_LOGIN_ID,
    });
    correlation = {
      xs: touch.xs,
      login_id: PUBLIC_LOGIN_ID,
      grant_id: grantId,
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

    // Invariant 14: only `tools/call` is limited. The handshake and `tools/list` never are, so a
    // client can always connect and learn the catalog (a limit on the handshake is what breaks
    // clients of other public MCP servers). The per-IP window is checked first; the lane-wide one
    // protects the single instance the signed-in demo shares (invariant 1).
    if (summary.toolNames.length > 0) {
      const prefix = ipPrefixOf(remoteIp) ?? 'unknown';
      if (hitIpLimit(prefix) || hitLaneLimit('lane')) {
        rateLimited = true;
        for (const name of summary.toolNames) {
          xray.emit(
            'tool.call.denied',
            {
              tool: name,
              denied_reason: 'rate_limited',
              required_scopes: [],
              missing_scopes: [],
              status: 429,
            },
            correlation,
          );
        }
        sessions.noteError(grantId);
        response.setHeader('Retry-After', '60');
        response.status(429).json({
          error: 'too_many_requests',
          error_description:
            'The public endpoint has answered too many tool calls from this network in the last minute.',
        });
        return;
      }
    }

    try {
      const outcome = await transport.handle(request, response, request.body, {
        auth: null,
        grantId,
        grant: { scopes: [] },
        featureFlags: [],
        requestId,
        // The host the visitor used, so the pointer to `/mcp` names the same host (invariant 4).
        publicBaseUrl: baseUrl,
        correlation,
        xray: withCorrelation(xray, correlation),
        summary,
      });

      if (summary.isInitialize) {
        const failed = outcome.protocolErrors.find((error) => error.method === 'initialize');
        if (failed !== undefined) {
          xray.emit(
            'session.rejected',
            {
              reason: 'initialize',
              error: failed.message,
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
      sessions.noteError(grantId);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error.' },
          id: null,
        });
      }
    }
  }

  router.use(createParseErrorObserver({ config, now, xray, observed, correlationOf }));

  const handle = router as unknown as PublicLaneHandler;
  handle.shutdown = (reason: 'server_stopping' = 'server_stopping') => {
    if (sweepTimer !== null) clearInterval(sweepTimer);
    const callsCancelled = inFlight.cancelAll('server_stopping');
    const closed = sessions.endAll(reason);
    for (const ended of closed) emitSessionEnded(ended, 'server_stopping');
    return { sessions_ended: closed.length, calls_cancelled: callsCancelled };
  };
  handle.sweep = sweep;
  handle.sessions = sessions;
  handle.stats = () => ({ sessions: sessions.size, callsInFlight: inFlight.size });
  return handle;
}
