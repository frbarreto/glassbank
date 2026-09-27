/**
 * The HTTP half both MCP endpoints share (block: mcp).
 *
 * `/mcp` (the bearer gate, `index.ts`) and `/public/mcp` (the public lane, `public-lane.ts`, D-26)
 * differ only in who the caller is. Everything around that - CORS, the preflight, the `405` for
 * GET and DELETE, the `http.request` facts, the parser-reject observer, the fixed-window limiter -
 * lives here once, so the two endpoints cannot drift apart on what the dashboard sees.
 */
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

import type {
  XrayCorrelation,
  XrayEmitter,
  XrayEventDataInput,
} from '../contracts/index.js';

import { BoundedSessionMap } from './bounded-map.js';
import { baseUrlForRequest, decideOrigin, isAnthropicEgress } from './gate.js';
import type { McpConfig, McpLogger } from './types.js';

/** The configuration the shared HTTP pieces read: the origin policy and the served hosts. */
export type McpHttpConfig = Pick<McpConfig, 'publicBaseUrl' | 'publicHosts' | 'originPolicy'>;

/** Only the `/24` prefix of a caller's address is ever logged (invariant 11). */
export function ipPrefixOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const octets = plain.split('.');
  if (octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet))) {
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  const hextets = plain.split(':').filter(Boolean);
  return hextets.length === 0 ? null : `${hextets.slice(0, 3).join(':')}::/48`;
}

/** The caller's address as Express resolved it behind `trust proxy` (invariant 12). */
export function remoteIpOf(request: Request): string | null {
  return request.ip ?? request.socket.remoteAddress ?? null;
}

/**
 * A fixed one-minute window per key (invariant 14): `hit(key)` counts one call and answers `true`
 * once the key is over `limitPerMinute`. The key map is bounded, like every map fed by traffic.
 */
export function createWindowLimiter(
  limitPerMinute: number,
  now: () => Date,
  capacity = 5000,
): (key: string) => boolean {
  const windows = new BoundedSessionMap<string, { count: number; startedAt: number }>(capacity);
  return function hit(key: string): boolean {
    const currentTime = now().getTime();
    const existing = windows.get(key);
    const window =
      existing === undefined || currentTime - existing.startedAt >= 60_000
        ? { count: 0, startedAt: currentTime }
        : existing;
    window.count += 1;
    windows.set(key, window);
    return window.count > limitPerMinute;
  };
}

/**
 * The CORS headers every MCP answer carries, preflight and real response alike.
 *
 * Setting them only on the OPTIONS preflight made the transport look CORS-enabled while a
 * browser still blocked every actual response: the 401 that starts auth, the 403 step-up and
 * the 405 all arrived without `Access-Control-Allow-Origin`, so JavaScript could never read
 * `WWW-Authenticate` and the MCP Inspector UI could not connect at all. claude.ai's connector
 * fetches server-side and was unaffected, which is what hid this.
 *
 * The origin is echoed only when the Origin policy of invariant 10 allows it. No
 * `Access-Control-Allow-Credentials`: neither endpoint authenticates with a cookie.
 */
export function createMcpCors(config: McpHttpConfig): (request: Request, response: Response) => void {
  return function applyMcpCors(request: Request, response: Response): void {
    response.setHeader('Vary', 'Origin');
    response.setHeader(
      'Access-Control-Expose-Headers',
      'WWW-Authenticate, x-request-id, mcp-protocol-version',
    );
    const origin = request.get('origin');
    if (origin === undefined || origin.length === 0) {
      response.setHeader('Access-Control-Allow-Origin', '*');
      return;
    }
    const baseUrl = baseUrlForRequest(request, config);
    if (decideOrigin(origin, baseUrl, config.originPolicy).allowed) {
      response.setHeader('Access-Control-Allow-Origin', origin);
    }
  };
}

/** Browser-based clients (the Inspector UI) preflight the endpoint. */
export function registerPreflight(
  router: Router,
  applyCors: (request: Request, response: Response) => void,
): void {
  router.options('/', (request: Request, response: Response) => {
    applyCors(request, response);
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader(
      'Access-Control-Allow-Headers',
      'authorization, content-type, mcp-protocol-version, last-event-id, x-request-id',
    );
    response.status(204).end();
  });
}

/** What `http.request` carries about a request, given what the handler learned while answering. */
export function httpRequestFacts(
  request: Request,
  config: McpHttpConfig,
  outcome: {
    readonly status: number;
    readonly durationMs: number;
    readonly sse: boolean;
    readonly rateLimited: boolean;
  },
): XrayEventDataInput<'http.request'> {
  const remoteIp = remoteIpOf(request);
  return {
    method: request.method,
    path: request.originalUrl,
    status: outcome.status,
    duration_ms: outcome.durationMs,
    user_agent: request.get('user-agent') ?? null,
    remote_ip_prefix: ipPrefixOf(remoteIp),
    anthropic_egress: isAnthropicEgress(remoteIp),
    origin: request.get('origin') ?? null,
    origin_decision: decideOrigin(
      request.get('origin'),
      baseUrlForRequest(request, config),
      config.originPolicy,
    ).decision,
    mcp_protocol_version_header: request.get('mcp-protocol-version') ?? null,
    mcp_session_id: request.get('mcp-session-id') ?? null,
    has_authorization: request.get('authorization') !== undefined,
    content_type: request.get('content-type') ?? null,
    sse: outcome.sse,
    rate_limited: outcome.rateLimited,
  };
}

export interface HttpObserverDeps {
  readonly config: McpHttpConfig;
  readonly now: () => Date;
  readonly log: McpLogger;
  readonly xray: XrayEmitter;
  /** Responses whose `http.request` is already arranged, so it is emitted exactly once. */
  readonly observed: WeakSet<Response>;
  readonly applyCors: (request: Request, response: Response) => void;
  /**
   * The correlation of a request that never reached a handler. `/mcp` knows nobody yet and
   * passes nothing; the public lane already knows the visitor from the request alone.
   */
  readonly correlationOf?: (request: Request) => XrayCorrelation | undefined;
}

/**
 * Invariant 6: no GET stream and nothing to DELETE. `Allow: POST` tells a client that probes
 * the legacy SSE transport exactly what this server speaks.
 */
export function createMethodNotAllowed(deps: HttpObserverDeps): RequestHandler {
  return (request: Request, response: Response) => {
    const startedAt = deps.now().getTime();
    deps.observed.add(response);
    deps.applyCors(request, response);
    response.setHeader('Allow', 'POST');
    deps.log({
      event: 'http.request',
      ts: deps.now().toISOString(),
      method: request.method,
      path: request.originalUrl,
      status: 405,
      user_agent: request.get('user-agent') ?? null,
      origin: request.get('origin') ?? null,
      mcp_protocol_version_header: request.get('mcp-protocol-version') ?? null,
      mcp_session_id: request.get('mcp-session-id') ?? null,
    });
    deps.xray.emit(
      'http.request',
      httpRequestFacts(request, deps.config, {
        status: 405,
        durationMs: Math.max(0, deps.now().getTime() - startedAt),
        sse: false,
        rateLimited: false,
      }),
      deps.correlationOf?.(request),
    );
    response.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          'Method not allowed. This server speaks stateless Streamable HTTP: send JSON-RPC with POST. It issues no Mcp-Session-Id and serves no GET stream.',
      },
      id: null,
    });
  };
}

/**
 * Observes a request that never reached the POST handler.
 *
 * `express.json` rejects a body that is not JSON (400) or larger than its limit (413) before any
 * handler runs, and `src/app.ts` owns the response it produces. Without this the frame would be
 * invisible to the dashboard: no `http.request`, no `protocol.error`, nothing to explain a client
 * that has started sending rubbish. `next(error)` is still called, so the response is unchanged -
 * this only watches.
 */
export function createParseErrorObserver(
  deps: Omit<HttpObserverDeps, 'log' | 'applyCors'>,
): (error: unknown, request: Request, response: Response, next: NextFunction) => void {
  return (error: unknown, request: Request, response: Response, next: NextFunction) => {
    if (deps.observed.has(response)) {
      next(error);
      return;
    }
    deps.observed.add(response);
    const startedAt = deps.now().getTime();
    const correlation = deps.correlationOf?.(request);
    const message = error instanceof Error ? error.message : 'the request body could not be read';
    deps.xray.emit(
      'protocol.error',
      {
        'mcp.method.name': null,
        // -32700 is a body that is not JSON at all; anything else that stopped the parser is an
        // invalid request (an over-large payload, a wrong content type).
        code: error instanceof SyntaxError ? -32700 : -32600,
        message,
      },
      correlation,
    );
    response.on('finish', () => {
      deps.xray.emit(
        'http.request',
        httpRequestFacts(request, deps.config, {
          status: response.statusCode,
          durationMs: Math.max(0, deps.now().getTime() - startedAt),
          sse: false,
          rateLimited: false,
        }),
        correlation,
      );
    });
    next(error);
  };
}
