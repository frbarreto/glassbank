/**
 * The MCP SDK adapter (block: mcp).
 *
 * The only file in the repository that imports an MCP SDK (lint-enforced). Everything else in
 * `src/mcp` deals in Express, JSON-RPC frames and contracts, so swapping SDK 1.30.0 for the v2
 * split packages is a change to this file alone (ADR-2).
 *
 * Three decisions live here:
 *
 *  - ADR-3, stateless: `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` and
 *    `enableJsonResponse: true`. A fresh `Server` + transport pair is built per request and torn
 *    down with the response, so there is no session map and no `Mcp-Session-Id`.
 *  - ADR-8, raw schemas: the tools are registered through the **low-level** `Server` with
 *    `setRequestHandler`, not through `McpServer.registerTool`. `registerTool` accepts only zod
 *    schemas (`AnySchema = z3.ZodTypeAny | z4.$ZodType`), builds the published JSON Schema from
 *    them and validates every call against them, which would answer `-32602` for a missing
 *    `rationale` before any handler ran. The low-level path publishes `publishedInputSchema`
 *    verbatim and validates nothing but the JSON-RPC envelope.
 *  - Invariant 13, observability: every frame produces its documented `XrayEvent`. The
 *    `catalog.*` and `tool.*` families are emitted from inside the handlers, where the timings
 *    are honest; `protocol.error` is read back off the response the SDK wrote, which is the only
 *    place that sees a `-32601` for an unknown *method* or a `-32602` the SDK's own envelope
 *    validation produced.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';

import {
  CLAUDE_CONTENT_CHAR_CAP,
  CLAUDE_TOOL_BUDGET_MS,
  flagsEnabledFor,
  isRationaleTruncated,
  publishedToolDescriptor,
  type AuthContext,
  type FeatureFlag,
  type GrantView,
  type ToolCatalogEntry,
  type ToolCatalogSnapshot,
  type ToolResult,
  type XrayCorrelation,
  type XrayEmitter,
} from '../contracts/index.js';

import type { CatalogMemory } from './catalog-memory.js';
import type { JsonRpcSummary } from './gate.js';
import type { InFlightCall, InFlightCalls } from './in-flight.js';
import { SERVER_INFO, SERVER_INSTRUCTIONS } from './instructions.js';
import type { ToolContextBase } from './types.js';
import { catalogRowsOf, emitWithId, summariseResult } from './xray.js';

/**
 * What the transport needs from the tool surface.
 *
 * Not the contract's `ToolRegistry` itself: `ToolRegistry.call` takes a full `ToolContext`, and
 * `src/mcp` may not import the blocks that own `BankCore`, `ScratchDb` and `Pairing`
 * (docs/REPO_LAYOUT.md section 3). `index.ts` adapts an injected `ToolRegistry` (plus the
 * `ToolContextFactory` that `src/app.ts` supplies) onto this port, and the two bootstrap tools
 * onto the same port when no registry has been injected yet.
 */
export interface ToolPort {
  readonly catalog: readonly ToolCatalogEntry[];
  listFor(grant: GrantView, flags: readonly FeatureFlag[]): ToolCatalogSnapshot;
  call(
    name: string,
    args: Record<string, unknown>,
    context: ToolContextBase,
  ): Promise<ToolResult>;
}

/** Opens one tool call in the register and returns the function that closes it. */
export type CallTracker = (call: InFlightCall) => () => void;

export interface TransportDeps {
  readonly tools: ToolPort;
  /** The uncorrelated emitter; each request gets its own correlated view (`context.xray`). */
  readonly xray: XrayEmitter;
  readonly catalogMemory: CatalogMemory;
  readonly inFlight: InFlightCalls;
  /** `session.ended` reports these counters, so the session record has to be told (A-27). */
  readonly counters?: {
    noteCall(grantId: string): void;
    noteError(grantId: string): void;
  };
  readonly instructions?: string;
  readonly serverInfo?: { readonly name: string; readonly title: string; readonly version: string };
  readonly now?: () => Date;
}

/** Everything the per-request server needs to answer for one authenticated caller. */
export interface TransportRequestContext {
  readonly auth: AuthContext;
  readonly featureFlags: readonly FeatureFlag[];
  readonly requestId: string | null;
  readonly publicBaseUrl: string;
  /** The envelope fields every event of this request carries. */
  readonly correlation: XrayCorrelation;
  /** The emitter already carrying `correlation`; handed to tool handlers as `ToolContext.xray`. */
  readonly xray: XrayEmitter;
  readonly summary: JsonRpcSummary;
}

/** What `index.ts` needs back to finish the `session.*` and `http.request` story. */
export interface TransportOutcome {
  readonly protocolVersionNegotiated: string;
  readonly serverCapabilities: Record<string, unknown>;
  readonly instructionsSent: boolean;
  readonly protocolErrors: readonly {
    readonly method: string | null;
    readonly code: number;
    readonly message: string;
  }[];
}

export interface McpTransport {
  handle(
    request: Request,
    response: Response,
    body: unknown,
    context: TransportRequestContext,
  ): Promise<TransportOutcome>;
}

/**
 * The SDK's own negotiation, reproduced so `session.initialized` can report
 * `protocol_version_negotiated` without waiting for the response to be written. `Server`
 * computes exactly this in `_oninitialize`; `protocol.test.ts` asserts the two still agree.
 */
export function negotiateProtocolVersion(requested: string | null): string {
  if (requested !== null && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

/** The capabilities this server declares. Reported verbatim on `session.initialized`. */
export const SERVER_CAPABILITIES = {
  // ADR-3: empty `prompts` and `resources` capabilities are declared so claude.ai's discovery
  // loop gets empty lists instead of `-32601` in the Errors panel.
  tools: { listChanged: false },
  prompts: {},
  resources: {},
} as const;

/** Bytes of a response body kept while looking for JSON-RPC errors in it. */
const MAX_CAPTURED_BODY_BYTES = 512 * 1024;

interface CapturedBody {
  /** Everything the SDK wrote, up to the cap. */
  text(): string;
  restore(): void;
}

/**
 * Reads back what the SDK answered.
 *
 * `Server` handles `initialize`, and the `Protocol` layer answers `-32601` for an unknown method
 * and `-32602` for params that fail its envelope schema, all without a hook this block could
 * register. The response is the only place those become visible, so it is captured here rather
 * than guessed at. `enableJsonResponse: true` means the body is one JSON document (or an array
 * for a batch) written through the `@hono/node-server` adapter, which ends up on this exact
 * `ServerResponse`.
 */
function captureResponseBody(response: Response): CapturedBody {
  const chunks: Buffer[] = [];
  let size = 0;
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);

  const record = (chunk: unknown, encoding?: unknown): void => {
    if (size >= MAX_CAPTURED_BODY_BYTES) return;
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'));
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    } else {
      return;
    }
    size += chunks[chunks.length - 1]?.length ?? 0;
  };

  // The signatures are the Node stream overloads; the capture is deliberately permissive and
  // always forwards to the original, so a mistake here can drop an event but never a response.
  const patchedWrite = function write(this: Response, ...args: unknown[]): boolean {
    try {
      record(args[0], args[1]);
    } catch {
      // Never let instrumentation break a response.
    }
    return (originalWrite as (...rest: unknown[]) => boolean)(...args);
  };
  const patchedEnd = function end(this: Response, ...args: unknown[]): Response {
    try {
      if (typeof args[0] !== 'function') record(args[0], args[1]);
    } catch {
      // As above.
    }
    return (originalEnd as (...rest: unknown[]) => Response)(...args);
  };

  (response as unknown as { write: unknown }).write = patchedWrite;
  (response as unknown as { end: unknown }).end = patchedEnd;

  return {
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    restore() {
      (response as unknown as { write: unknown }).write = originalWrite;
      (response as unknown as { end: unknown }).end = originalEnd;
    },
  };
}

/** Every JSON-RPC error in a response body, batch included. */
export function jsonRpcErrorsIn(
  body: string,
  methodById: ReadonlyMap<string, string>,
): { method: string | null; code: number; message: string }[] {
  if (body.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const frames = Array.isArray(parsed) ? parsed : [parsed];
  const errors: { method: string | null; code: number; message: string }[] = [];
  for (const frame of frames) {
    if (frame === null || typeof frame !== 'object') continue;
    const message = frame as { id?: unknown; error?: unknown };
    const error = message.error;
    if (error === null || typeof error !== 'object') continue;
    const { code, message: text } = error as { code?: unknown; message?: unknown };
    if (typeof code !== 'number') continue;
    const id = message.id === null || message.id === undefined ? null : String(message.id);
    errors.push({
      method: id === null ? null : (methodById.get(id) ?? null),
      code,
      message: typeof text === 'string' ? text : 'unknown JSON-RPC error',
    });
  }
  return errors;
}

export function createTransport(deps: TransportDeps): McpTransport {
  const instructions = deps.instructions ?? SERVER_INSTRUCTIONS;
  const serverInfo = deps.serverInfo ?? SERVER_INFO;
  const now = deps.now ?? (() => new Date());
  const serverCapabilities: Record<string, unknown> = JSON.parse(
    JSON.stringify(SERVER_CAPABILITIES),
  ) as Record<string, unknown>;

  function buildServer(context: TransportRequestContext, track: CallTracker): Server {
    const server = new Server(
      { name: serverInfo.name, title: serverInfo.title, version: serverInfo.version },
      { capabilities: SERVER_CAPABILITIES, instructions },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => {
      const snapshot = deps.tools.listFor(
        { scopes: context.auth.scopes, auth_level: context.auth.auth_level },
        context.featureFlags,
      );
      const decision = deps.catalogMemory.decide(context.auth.grant_id, snapshot.content_hash);
      const id = emitWithId(
        context.xray,
        'catalog.tools_listed',
        {
          count: snapshot.listed.length,
          content_hash: snapshot.content_hash,
          // The seventeen-entry array only when the hash moved; otherwise a pointer to the
          // listing that carried it (docs/XRAY_EVENT_MODEL.md section 3).
          snapshot_ref: decision.snapshotRef,
          tools: decision.changed ? catalogRowsOf(snapshot.listed) : null,
          availability: [...snapshot.availability],
          feature_flags: [...snapshot.feature_flags],
        },
        context.correlation,
      );
      if (decision.changed) {
        deps.catalogMemory.remember(context.auth.grant_id, snapshot.content_hash, id);
      }
      return { tools: snapshot.listed.map(publishedToolDescriptor) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const meta = (request.params._meta ?? null) as Record<string, unknown> | null;
      const entry = deps.tools.catalog.find((tool) => tool.name === name);

      // A tool whose `x-gated-by` flag is off is hidden from `tools/list` (ADR-13), so a call
      // naming it must look exactly like a call naming a tool that does not exist. Membership in
      // the catalog alone let a flag-disabled write tool reach its handler.
      if (entry === undefined || !flagsEnabledFor(entry, context.featureFlags)) {
        if (entry !== undefined) {
          context.xray.emit(
            'tool.call.denied',
            {
              tool: name,
              denied_reason: 'feature_flag',
              required_scopes: [...entry.requiredScopes],
              missing_scopes: [],
              // The client sees a JSON-RPC `-32601` inside an HTTP 200, not a 4xx: a tool the
              // deployment turned off must be indistinguishable from one that never existed.
              status: 200,
            },
            context.correlation,
          );
        }
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      const rationale = args.rationale;
      const startedAt = now().getTime();
      context.xray.emit(
        'tool.call.started',
        {
          tool: name,
          // Verbatim: the emitter owns redaction (per-tool deny-list plus the global token
          // patterns) and fills `redacted_fields` on the way through.
          arguments: args,
          redacted_fields: [],
          rationale: typeof rationale === 'string' ? rationale : null,
          rationale_present: typeof rationale === 'string' && rationale.trim().length > 0,
          rationale_truncated: isRationaleTruncated(rationale),
          meta,
          required_scopes: [...entry.requiredScopes],
          budget_ms: CLAUDE_TOOL_BUDGET_MS,
        },
        context.correlation,
      );
      deps.counters?.noteCall(context.auth.grant_id);
      const finish = track({ tool: name, startedAt, correlation: context.correlation });

      let result: ToolResult;
      try {
        result = await deps.tools.call(name, args, {
          auth: context.auth,
          xray: context.xray,
          featureFlags: context.featureFlags,
          now,
          requestId: context.requestId,
          publicBaseUrl: context.publicBaseUrl,
        });
      } catch (error) {
        finish();
        const message = error instanceof Error ? error.message : 'the tool handler threw';
        deps.counters?.noteError(context.auth.grant_id);
        context.xray.emit(
          'tool.call.completed',
          {
            tool: name,
            duration_ms: Math.max(0, now().getTime() - startedAt),
            budget_ms: CLAUDE_TOOL_BUDGET_MS,
            is_error: true,
            // A-08: a handler that throws is still a *tool* failure, not a protocol one.
            error: { code: null, message, class: 'tool' },
            content_types: [],
            content_chars: 0,
            content_cap: CLAUDE_CONTENT_CHAR_CAP,
            structured_content: null,
            text_preview: null,
          },
          context.correlation,
        );
        throw error;
      }
      finish();

      const summary = summariseResult(result);
      const isError = result.isError === true;
      if (isError) deps.counters?.noteError(context.auth.grant_id);
      context.xray.emit(
        'tool.call.completed',
        {
          tool: name,
          duration_ms: Math.max(0, now().getTime() - startedAt),
          budget_ms: CLAUDE_TOOL_BUDGET_MS,
          is_error: isError,
          error: isError
            ? { code: null, message: summary.textPreview ?? 'the tool reported an error', class: 'tool' }
            : null,
          content_types: summary.contentTypes,
          content_chars: summary.contentChars,
          content_cap: CLAUDE_CONTENT_CHAR_CAP,
          structured_content: summary.structuredContent,
          text_preview: summary.textPreview,
        },
        context.correlation,
      );

      return {
        content: [...result.content],
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
      };
    });

    // ADR-3: declared and answered, never `-32601`.
    server.setRequestHandler(ListPromptsRequestSchema, () => {
      context.xray.emit('catalog.prompts_listed', { count: 0 }, context.correlation);
      return { prompts: [] };
    });
    server.setRequestHandler(ListResourcesRequestSchema, () => {
      context.xray.emit('catalog.resources_listed', { count: 0 }, context.correlation);
      return { resources: [] };
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
      resourceTemplates: [],
    }));

    return server;
  }

  return {
    async handle(request, response, body, context): Promise<TransportOutcome> {
      // The calls this request opened, so a client hang-up cancels its own and nobody else's.
      const openHandles = new Set<() => void>();
      const track: CallTracker = (call) => {
        const handle = deps.inFlight.start(call);
        openHandles.add(handle);
        return () => {
          openHandles.delete(handle);
          handle();
        };
      };

      const server = buildServer(context, track);
      const transport = new StreamableHTTPServerTransport({
        // ADR-3, invariant 6: no session id is ever issued.
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const captured = captureResponseBody(response);

      // A request the client drops mid-call leaves `tool.call.started` unanswered; `close`
      // arriving before `finish` is exactly that case (claude.ai's 300 s budget expiring, or the
      // user pressing stop). `inFlight.cancelAll` covers the shutdown case from `index.ts`.
      response.on('close', () => {
        void transport.close();
        void server.close();
        if (!response.writableFinished) {
          for (const handle of [...openHandles]) deps.inFlight.cancel(handle, 'client_cancelled');
        }
        openHandles.clear();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
      } finally {
        captured.restore();
      }

      const methodById = new Map<string, string>();
      for (const frame of context.summary.frames) {
        if (frame.id !== null && frame.method !== null) {
          methodById.set(String(frame.id), frame.method);
        }
      }
      const protocolErrors = jsonRpcErrorsIn(captured.text(), methodById);
      for (const error of protocolErrors) {
        context.xray.emit(
          'protocol.error',
          { 'mcp.method.name': error.method, code: error.code, message: error.message },
          context.correlation,
        );
      }

      return {
        protocolVersionNegotiated: negotiateProtocolVersion(context.summary.protocolVersion),
        serverCapabilities,
        instructionsSent: instructions.length > 0,
        protocolErrors,
      };
    },
  };
}
