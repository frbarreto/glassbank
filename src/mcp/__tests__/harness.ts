/**
 * In-process HTTP harness for the `mcp` tests.
 *
 * The block boundaries (docs/REPO_LAYOUT.md section 3) forbid `src/mcp` - tests included - from
 * importing `src/auth`, `src/tools` implementations or `src/testing`, which is exactly right
 * here: the block's only contact with those is an injected `VerifyAccessToken` and an injected
 * `ToolRegistry`, so the tests inject their own and stay honest about what this block owns. The
 * real pairs are exercised end to end by `test/e2e/oauth-walk.mjs`.
 *
 * The emitter the harness injects is not a spy that records anything it is handed: it builds the
 * envelope the real pipeline builds and **parses the result against the frozen contract**, so a
 * test that asserts an event was emitted has also asserted that the event is valid. Anything
 * that fails to parse lands in `invalidEvents` and `expectNoInvalidEvents()` fails the test.
 *
 * Not a `*.test.ts` file, so vitest does not collect it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { expect } from 'vitest';

import {
  ACCESS_TOKEN_PREFIX,
  PUBLIC_MCP_PATH,
  PUBLIC_TOOL_CATALOG,
  TOOL_CATALOG,
  catalogAvailability,
  XRAY_CONTRACT_VERSION,
  formatScopeString,
  safeParseXrayEvent,
  toolText,
  type AccessClaims,
  type BankCore,
  type OAuthClient,
  type Pairing,
  type Persona,
  type PublicBankInfo,
  type PublicToolContext,
  type PublicToolRegistry,
  type Scope,
  type ScratchDb,
  type ToolContext,
  type ToolLimits,
  type ToolRegistry,
  type ToolResult,
  type VerifyAccessToken,
  type XrayCorrelation,
  type XrayEmitter,
  type XrayEvent,
  type XrayEventDataInput,
  type XrayEventType,
} from '../../contracts/index.js';
import { bootstrapListFor } from '../bootstrap-tools.js';
import { createMcp, type McpHandler } from '../index.js';
import type { McpConfig, McpLogRecord, ToolContextFactory } from '../types.js';

export const TEST_PERSONA: Persona = {
  id: 'per_ava_stone',
  name: 'Ava Stone',
  kind: 'retail',
  shared: true,
  seed: 'ava-stone',
  email: 'ava.stone@example.com',
  created_at: '2026-01-05T00:00:00.000Z',
  transfer_limit_cents: 250_000,
};

export const TEST_OAUTH_CLIENT: OAuthClient = {
  client_id: 'abc123def456',
  client_name: 'Test MCP client',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  token_endpoint_auth_method: 'none',
  reconstructed: false,
};

export const READ_ONLY_SCOPES: Scope[] = [
  'profile',
  'accounts:read',
  'transactions:read',
  'cards:read',
  'transfers:read',
  'bills:read',
  'payees:read',
  'xray:read',
];

export const READ_WRITE_SCOPES: Scope[] = [...READ_ONLY_SCOPES, 'cards:write', 'transfers:write'];

/**
 * The HTTP request id `src/app.ts` stamps on `res.locals` for every request (`requestIdMiddleware`,
 * echoed back as `x-request-id`). The harness sets it because *not* setting it hid a defect:
 *
 * `src/mcp` used to hand the tools block `res.locals.requestId` as `ToolContext.requestId` while
 * emitting `tool.call.started` and `tool.call.completed` with the JSON-RPC id. Every event the
 * tools block correlates itself - `intent.declared`, `intent.missing`, `intent.inferred`, and
 * through the same context `bank.op`, `etl.*` and `sql.*` - therefore carried a `request_id` the
 * call did not have, and the dashboard, which keys a call on `<xs>#<request_id>` (`callKeyOf` in
 * `public/catalogue.js`), nested none of them under the call that caused them. Under a bare
 * express app `res.locals.requestId` is `undefined`, so the wrong source fell through to the right
 * value and every test passed while a live server was wrong (CLAUDE.md invariant 13).
 *
 * Setting it here is inert for every other test: `src/mcp` reads `res.locals` nowhere, so the
 * value is observable only if the defect comes back - and then it is observably wrong.
 */
export const HTTP_REQUEST_ID_SENTINEL = 'http-req-id-sentinel-not-a-json-rpc-id';

/** The token the stub verifier accepts. Its value carries the scopes, so a test can vary them. */
export function tokenFor(scopes: readonly Scope[], grantId = 'grt_test'): string {
  return `${ACCESS_TOKEN_PREFIX}${grantId}::${formatScopeString(scopes as Scope[])}`;
}

// ---------------------------------------------------------------------------
// The recording emitter
// ---------------------------------------------------------------------------

export interface RecordedEvent {
  readonly type: string;
  readonly issues: readonly string[];
}

export interface RecordingEmitter {
  readonly emitter: XrayEmitter;
  readonly events: XrayEvent[];
  readonly invalid: RecordedEvent[];
  typesOf(): string[];
  of<T extends XrayEventType>(type: T): Extract<XrayEvent, { type: T }>[];
  clear(): void;
}

export function createRecordingEmitter(now: () => Date = () => new Date()): RecordingEmitter {
  const events: XrayEvent[] = [];
  const invalid: RecordedEvent[] = [];
  let nextId = 1;

  const emitter: XrayEmitter = {
    emit<T extends XrayEventType>(
      type: T,
      data: XrayEventDataInput<T>,
      correlation?: XrayCorrelation,
    ): void {
      // The envelope `src/xray` builds: the producer supplies `type`, `data` and correlation and
      // the emitter fills `id`, `ts`, `v` and `seq` (contracts/events.ts).
      const candidate = {
        ...correlation,
        id: nextId,
        ts: now().toISOString(),
        v: XRAY_CONTRACT_VERSION,
        seq: nextId,
        type,
        data,
      };
      const parsed = safeParseXrayEvent(candidate);
      nextId += 1;
      if (parsed.success) {
        events.push(parsed.data);
      } else {
        invalid.push({
          type,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          ),
        });
      }
    },
  };

  return {
    emitter,
    events,
    invalid,
    typesOf: () => events.map((event) => event.type),
    of<T extends XrayEventType>(type: T) {
      return events.filter((event): event is Extract<XrayEvent, { type: T }> => event.type === type);
    },
    clear() {
      events.length = 0;
      invalid.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// A fake ToolRegistry (the contract interface, not `src/tools`)
// ---------------------------------------------------------------------------

export interface FakeRegistryCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly context: ToolContext;
}

export interface FakeRegistry extends ToolRegistry {
  readonly calls: FakeRegistryCall[];
  /** Overrides the result for one tool; anything else answers a plain text success. */
  answer(name: string, result: ToolResult | (() => Promise<ToolResult>)): void;
}

export function createFakeRegistry(): FakeRegistry {
  const calls: FakeRegistryCall[] = [];
  const answers = new Map<string, ToolResult | (() => Promise<ToolResult>)>();
  return {
    calls,
    catalog: TOOL_CATALOG,
    listFor: bootstrapListFor,
    answer(name, result) {
      answers.set(name, result);
    },
    async call(name, args, context) {
      calls.push({ name, args, context });
      const answer = answers.get(name);
      if (typeof answer === 'function') return await answer();
      if (answer !== undefined) return answer;
      return toolText(`fake registry answered ${name}`, { tool: name });
    },
  };
}

/** A fake `PublicToolRegistry` (the contract interface, not `src/tools`), D-26. */
export interface FakePublicRegistry extends PublicToolRegistry {
  readonly calls: { name: string; args: Record<string, unknown>; context: PublicToolContext }[];
}

export function createFakePublicRegistry(): FakePublicRegistry {
  const calls: FakePublicRegistry['calls'] = [];
  return {
    calls,
    catalog: PUBLIC_TOOL_CATALOG,
    list: () => ({
      content_hash: '0123456789abcdef',
      listed: PUBLIC_TOOL_CATALOG,
      availability: catalogAvailability(PUBLIC_TOOL_CATALOG, { scopes: [] }, []),
      feature_flags: [],
    }),
    async call(name, args, context) {
      calls.push({ name, args, context });
      return toolText(`fake public registry answered ${name}`);
    },
  };
}

/**
 * The half of `ToolContext` `src/app.ts` fills in. `BankCore`, `ScratchDb` and `Pairing` belong
 * to blocks `src/mcp` may not import, and nothing in this block reads them - it only carries
 * them through - so the tests hand over objects that throw if anything ever touches them.
 */
function unwired<T>(block: string): T {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`the ${block} block is not wired in this test (read "${String(property)}")`);
      },
    },
  ) as T;
}

export const TEST_TOOL_LIMITS: ToolLimits = {
  maxTablesPerGrant: 10,
  maxQueryRows: 100,
  tableTtlMinutes: 30,
  queryTimeoutMs: 5_000,
  maxConcurrentEtlOps: 2,
  contentCharCap: 150_000,
  budgetMs: 300_000,
};

export const testToolContext: ToolContextFactory = (base) => ({
  ...base,
  bank: unwired<BankCore>('bank-core'),
  scratch: unwired<ScratchDb>('etl'),
  pairing: unwired<Pairing>('xray'),
  limits: TEST_TOOL_LIMITS,
});

// ---------------------------------------------------------------------------
// The HTTP harness
// ---------------------------------------------------------------------------

export interface McpHarness {
  readonly baseUrl: string;
  readonly logs: McpLogRecord[];
  readonly xray: RecordingEmitter;
  readonly registry: FakeRegistry | null;
  readonly publicRegistry: FakePublicRegistry | null;
  readonly handler: McpHandler;
  /** A JSON-RPC POST to the public lane, never with a bearer unless a header says so. */
  publicRpc(body: unknown, headers?: Record<string, string>): Promise<Response>;
  /** A JSON-RPC POST with the Accept header the Streamable HTTP transport demands. */
  rpc(
    body: unknown,
    options?: { token?: string | null; headers?: Record<string, string> },
  ): Promise<Response>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Fails the test if any emitted event was rejected by the frozen event schema. */
  expectNoInvalidEvents(): void;
  close(): Promise<void>;
}

export interface McpHarnessOptions {
  readonly config?: Partial<McpConfig>;
  /** Replaces the stub verifier entirely (used by the "expired token" case). */
  readonly verifyAccessToken?: VerifyAccessToken;
  /** Injects a fake `ToolRegistry` instead of the two bootstrap tools. */
  readonly registry?: FakeRegistry;
  /** An injectable clock, so idle-gap segmentation can be simulated without waiting. */
  readonly now?: () => Date;
  /** Mounts the public lane at `PUBLIC_MCP_PATH` with a fake registry (D-26). */
  readonly publicLane?: { readonly ipToolCallsPerMin?: number; readonly toolCallsPerMin?: number };
}

export async function startMcpHarness(options: McpHarnessOptions = {}): Promise<McpHarness> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;
  const baseUrl = `http://${host}`;
  const now = options.now ?? (() => new Date());

  const config: McpConfig = {
    publicBaseUrl: baseUrl,
    publicHosts: [host],
    originPolicy: 'log-only',
    featureFlags: ['writes', 'transfers'],
    xsIdleGapMinutes: 30,
    grantToolCallsPerMin: 120,
    ...options.config,
  };

  const verifyAccessToken: VerifyAccessToken =
    options.verifyAccessToken ??
    (async (token) => {
      const raw = token.startsWith(ACCESS_TOKEN_PREFIX)
        ? token.slice(ACCESS_TOKEN_PREFIX.length)
        : token;
      const [grantId, scopeString] = raw.split('::');
      if (grantId === undefined || scopeString === undefined) {
        return { ok: false, reason: 'malformed', error: 'invalid_token', status: 401 };
      }
      const scopes = scopeString.split(' ').filter(Boolean);
      const claims: AccessClaims = {
        typ: 'access',
        jti: 'jti-test',
        iat: Math.floor(now().getTime() / 1000) - 10,
        exp: Math.floor(now().getTime() / 1000) + 3600,
        iss: baseUrl,
        aud: `${baseUrl}/mcp`,
        sub: TEST_PERSONA.id,
        client_id: 'client-test',
        grant_id: grantId,
        login_id: 'lgn_test',
        scope: scopes.join(' '),
        auth_level: scopes.some((scope) => scope.endsWith(':write')) ? 'read_write' : 'read_only',
      };
      return { ok: true, claims };
    });

  const logs: McpLogRecord[] = [];
  const xray = createRecordingEmitter(now);
  const registry = options.registry ?? null;
  const publicRegistry = options.publicLane === undefined ? null : createFakePublicRegistry();
  const handler = createMcp({
    config,
    verifyAccessToken,
    lookupPersona: async (id) => (id === TEST_PERSONA.id ? TEST_PERSONA : null),
    lookupClient: () => TEST_OAUTH_CLIENT,
    bootId: 'boot_test_0001',
    xray: xray.emitter,
    ...(registry === null ? {} : { registry, toolContext: testToolContext }),
    log: (record) => logs.push(record),
    now,
    // The tests drive `sweep()` by hand; a timer would make them depend on wall-clock time.
    sweepIntervalMs: 0,
    ...(publicRegistry === null
      ? {}
      : {
          publicLane: {
            registry: publicRegistry,
            info: unwired<PublicBankInfo>('bank-core'),
            ipToolCallsPerMin: options.publicLane?.ipToolCallsPerMin ?? 60,
            toolCallsPerMin: options.publicLane?.toolCallsPerMin ?? 600,
          },
        }),
  });

  const app = express();
  app.set('trust proxy', true);
  // Reproduces `requestIdMiddleware` (src/app.ts), which runs ahead of every router in
  // production. See `HTTP_REQUEST_ID_SENTINEL` for why its absence used to hide a defect.
  app.use((_request, response, next) => {
    response.locals.requestId = HTTP_REQUEST_ID_SENTINEL;
    response.setHeader('x-request-id', HTTP_REQUEST_ID_SENTINEL);
    next();
  });
  if (handler.publicLane !== null) app.use(PUBLIC_MCP_PATH, handler.publicLane);
  app.use('/mcp', handler);
  server.on('request', app);

  return {
    baseUrl,
    logs,
    xray,
    registry,
    publicRegistry,
    handler,
    async publicRpc(body, headers = {}) {
      return await fetch(new URL(PUBLIC_MCP_PATH, baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(body),
        redirect: 'manual',
      });
    },
    async fetch(path: string, init: RequestInit = {}) {
      return await fetch(new URL(path, baseUrl), { ...init, redirect: 'manual' });
    },
    async rpc(body, callOptions = {}) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        // The Streamable HTTP transport answers 406 unless BOTH types are accepted, even with
        // enableJsonResponse: true.
        accept: 'application/json, text/event-stream',
        ...callOptions.headers,
      };
      const token = callOptions.token === undefined ? tokenFor(READ_ONLY_SCOPES) : callOptions.token;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      return await fetch(new URL('/mcp', baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
      });
    },
    expectNoInvalidEvents() {
      expect(xray.invalid).toEqual([]);
    },
    async close() {
      handler.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `initialize` exactly as a 2025-11-25 client sends it. */
export function initializeFrame(id: number | string = 1): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' },
    },
  };
}

/** A `tools/call` frame. */
export function callFrame(
  name: string,
  args: Record<string, unknown> = {},
  id: number | string = 100,
): unknown {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}
