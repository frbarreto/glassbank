# mcp

Status: done, contracts v0.9 (every request recorded with its `raw` block, D-28), wired in `src/composition.ts` (`createMcp({...})` with `xray.emitter`, the 17-tool registry, a `toolContext` factory and, unless `PUBLIC_MCP=false`, the public lane; mounted at `/mcp`, and `handle.publicLane` at `/public/mcp`, by `src/app.ts`).

## Purpose
The transport adapter and the only block that imports `@modelcontextprotocol/sdk` (ADR-2): stateless Streamable HTTP at `/mcp`, with the bearer gate, Origin policy, scope check and per-grant rate limit running before the SDK sees the body; and at `/public/mcp` the same transport with no gate at all, for the six public tools (D-26, ADR-19).
It also mints the X-ray session `xs` per grant, correlates every event of a request and instruments every JSON-RPC frame (invariant 13).

## Files
- `index.ts` - `createMcp`: the Express router (`OPTIONS`, `GET`/`DELETE` 405, `POST`), the gate order below, the `xs` touch, the grant limiter, `session.*` and `http.request` emits, `shutdown`/`sweep`/`stats`; builds the public lane when `deps.publicLane` is given.
- `http.ts` - what both endpoints share: `createMcpCors`, `registerPreflight`, `createMethodNotAllowed`, `createParseErrorObserver`, `httpRequestFacts` (the `http.request` payload, `raw` included), `createHttpObserver` (the catch-all `http.request` producer for every other path, D-28), `createWindowLimiter` (fixed one-minute window per key, bounded), `ipPrefixOf`, `remoteIpOf`.
- `public-lane.ts` - `createPublicLane`: `/public/mcp` (D-26). No bearer and no challenge; `visitorGrantId` (`grt_pub_` + 12 hex of sha256 over IP prefix and User-Agent) keys the session manager, catalog memory and counters; every event carries `PUBLIC_LOGIN_ID`; per-IP-prefix and lane-wide `tools/call` limits; its own transport with `PUBLIC_SERVER_INSTRUCTIONS` and `PUBLIC_SERVER_INFO`; `PUBLIC_BODY_LIMIT` 256 kb.
- `gate.ts` - `summariseJsonRpc` (methods, tool names, `initialize` params, `_meta.traceparent`), `bearerTokenOf`, `baseUrlForRequest`, `decideOrigin`, `isAnthropicEgress`, `sendUnauthorized`, `sendInsufficientScope`, `scopeDenial`, `stepUpScopesFor`.
- `transport.ts` - `createTransport`: a fresh low-level `Server` + `StreamableHTTPServerTransport` per request, for a caller described by `grantId`, `grant` and an `auth` that is `null` on the public lane; `tools/list`, `tools/call`, `prompts/list`, `resources/list`, `resources/templates/list`; response-body capture for `protocol.error`; `negotiateProtocolVersion`, `SERVER_CAPABILITIES`.
- `sessions.ts` - `createSessionManager`: one `xs` per `grant_id`, split on `XS_IDLE_GAP_MINUTES`, carries the last `clientInfo` and the counters `session.ended` reports; `sweep`, `endAll`.
- `xray.ts` - `withCorrelation`, `emitWithId`, `eraOf`, `catalogRowsOf`, `inputSchemaHash`, `summariseResult`, `RESULT_PREVIEW_TRUNCATION_SUFFIX` (a copy of the emitter's marker; this block may not import `src/xray`, so `__tests__/events.test.ts` reads the original from disk and fails on drift).
- `in-flight.ts` - open tool calls; `tool.call.cancelled` on client hang-up or shutdown.
- `catalog-memory.ts` - last `content_hash` per grant, so `catalog.tools_listed` elides an unchanged tool array and points at `snapshot_ref`.
- `bounded-map.ts` - `BoundedSessionMap`, the block's own capped LRU (blocks may not share code).
- `bootstrap-tools.ts` - `get_current_user` and `get_tool_availability` answered from `ToolContextBase` alone: the fallback when `createMcp` gets no `registry`. Unreachable once wired: `src/composition.ts` always injects the registry and `src/__tests__/wiring.test.ts` asserts 17 tools.
- `instructions.ts` - `SERVER_INSTRUCTIONS` (docs/TOOL_CATALOG.md section 5) and `SERVER_INFO`; `PUBLIC_SERVER_INSTRUCTIONS` and `PUBLIC_SERVER_INFO` (`glass-bank-public`, section 8).
- `types.ts` - `McpConfig`, `McpLogger`, `ToolContextBase`, `ToolCallBase` (what the transport hands a port: `auth` nullable, `grantId`, `xs`), `ToolContextFactory`, `PersonaLookup`, `ClientLookup`.

## Public interface (`src/mcp/index.ts`)
- `createMcp(deps: McpDeps): McpHandler` - the Express handler plus `shutdown('server_stopping')` (synchronous: cancels in-flight calls, ends every session of both endpoints), `sweep()`, `sessions`, `publicLane` (a `PublicLaneHandler`, or `null`), `httpObserver` (the catch-all middleware `src/app.ts` mounts in front of every router, D-28), `stats()` (with `publicSessions`).
- `createPublicLane`, `visitorGrantId`, `PUBLIC_BODY_LIMIT`, `PUBLIC_SERVER_INFO`, `PUBLIC_SERVER_INSTRUCTIONS`; types `PublicLaneConfig`, `PublicLaneDeps`, `PublicLaneHandle`, `PublicLaneHandler`.
- `SESSION_SWEEP_INTERVAL_MS` (60 000) - the unref'd idle-sweep timer; `deps.sweepIntervalMs: 0` disables it.
- Re-exports: `createTransport`, `negotiateProtocolVersion`, `SERVER_CAPABILITIES` (`transport.ts`); `createSessionManager` (`sessions.ts`); `catalogRowsOf`, `eraOf`, `inputSchemaHash`, `withCorrelation` (`xray.ts`); `bootstrapCall`, `bootstrapListFor`, `catalogContentHash`, `BOOTSTRAP_TOOLS`, `NOT_IMPLEMENTED_MESSAGE` (`bootstrap-tools.ts`); `SERVER_INSTRUCTIONS`, `SERVER_INFO` (`instructions.ts`).
- Types: `McpDeps`, `McpHandle`, `McpHandler`, `ToolPort`, `TransportOutcome`, `TransportRequestContext`, `EndedSession`, `SessionManager`, `SessionState`, `McpConfig`, `McpLogger`, `McpLogRecord`, `SpikeLogger`, `SpikeLogRecord`, `ToolContextBase`, `ToolContextFactory`.

## Consumes
- `McpDeps`: `config: McpConfig` (`publicBaseUrl`, `publicHosts`, `originPolicy`, `featureFlags`, `xsIdleGapMinutes`, `grantToolCallsPerMin` = `RATE_LIMIT_GRANT_TOOL_CALLS`), `verifyAccessToken` (`auth.verifyAccessToken`), `lookupPersona` (`bankCore.personas.get`), `lookupClient` (`auth.lookupClient`), `bootId`, `xray` (`xray.emitter`), `registry` (`ToolRegistry` from `src/tools`), `toolContext` (completes `ToolContextBase` with `bank`, `scratch`, `pairing`, `limits`); optional `log`, `now`, `sweepIntervalMs`, `captureSkipPaths` (`XRAY_CAPTURE_SKIP_PATHS`, the prefixes `httpObserver` leaves out), and `publicLane` (`registry`: a `PublicToolRegistry`, `info`: `bankCore.publicInfo`, `ipToolCallsPerMin` = `RATE_LIMIT_PUBLIC_IP_TOOL_CALLS`, `toolCallsPerMin` = `RATE_LIMIT_PUBLIC_TOOL_CALLS`). `registry` without `toolContext`, or the reverse, throws at construction.
- `src/contracts`: `AuthContext`, `ToolRegistry`, `ToolCatalogEntry`, `GrantView`, the challenge builders, `canonicalBaseUrl`, `resourceMetadataUrl`, `DEFAULT_CHALLENGE_SCOPES`, `ANTHROPIC_EGRESS_CIDR`, `getTool`, `flagsEnabledFor`, `missingScopesFor`, `stepUpScopes`, `isListed`, `catalogAvailability`, `CLAUDE_TOOL_BUDGET_MS`, `CLAUDE_CONTENT_CHAR_CAP`, `RESULT_PREVIEW_BYTES`, `publishedToolDescriptor`, `XrayEmitter`. npm: `@modelcontextprotocol/sdk` 1.30.0 (imported only in `transport.ts`), `express`.

## Gate order (`index.ts` `handlePost`)
1. `GET`/`DELETE /mcp` -> 405, `Allow: POST`, JSON-RPC `-32000` body (invariant 6); `OPTIONS` -> 204 with CORS.
2. `express.json({ limit: '4mb', verify: keepRawBody })`: the bytes are kept for `raw` before parsing; a body it rejects still gets `protocol.error` (`-32700`/`-32600`) and `http.request`, the refused bytes in `raw.body`.
3. Origin (invariant 10): absent, `https://claude.ai`, `https://claude.com` and our own origin allowed; anything else -> 403 `origin_not_allowed` only under `ORIGIN_POLICY=allowlist`, decision `logged` under `log-only`.
4. No bearer -> 401, body `{"detail":"No access token provided"}`, `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp", scope="<read scopes>"`; a token `verifyAccessToken` refuses -> the same plus `error="invalid_token"` (invariant 5).
5. `sessions.touch(grant_id)` mints or resumes `xs`, before the scope check, so a refusal lands in the session it belongs to.
6. `scopeDenial` on the parsed `params.name`: a listed, flag-enabled tool the grant cannot call -> 403 `insufficient_scope`, `WWW-Authenticate` with every still-needed issuable scope (`stepUpScopesFor`) and `resource_metadata`; `error_description` names only this tool's missing scopes. Unknown or flag-disabled tools pass through to the SDK's `-32601`.
7. `RATE_LIMIT_GRANT_TOOL_CALLS` per grant per minute (`createGrantLimiter` in `index.ts`, a 5000-key map): over budget -> 429 JSON + `Retry-After: 60`.
8. `lookupPersona(sub)` null -> 401 `invalid_token`; then the `AuthContext` is built (`parent_grant_id: null`, `client` from the session record, `oauth_client` from `lookupClient`) and the SDK handles the frame.

## The public lane (`public-lane.ts`, D-26)
1. `GET`/`DELETE` 405 and `OPTIONS` 204 as on `/mcp`; `express.json` with a 256 kb limit.
2. The Origin policy, exactly as on `/mcp` (invariant 10).
3. No bearer check: an `Authorization` header is ignored (and recorded as `has_authorization`). The lane never answers 401 or 403 `insufficient_scope`; a signed-in tool name is an unknown tool (`-32601`).
4. `sessions.touch(visitorGrantId(request))` with `loginId: PUBLIC_LOGIN_ID` and no persona.
5. `tools/call` only: `RATE_LIMIT_PUBLIC_IP_TOOL_CALLS` per IP prefix, then `RATE_LIMIT_PUBLIC_TOOL_CALLS` for the whole lane, each per minute; over either -> 429 + `Retry-After: 60` and `tool.call.denied {rate_limited}`. `initialize` and `tools/list` are never limited.
6. The transport answers with `auth: null`, `grant: {scopes: []}`, no feature flags, and the request's own base URL as `publicBaseUrl`, so the pointer to `/mcp` names the host the visitor used.

Every `/mcp` answer carries CORS (`Vary: Origin`, the echoed allowed origin, `Access-Control-Expose-Headers: WWW-Authenticate, x-request-id, mcp-protocol-version`), never `Allow-Credentials`.

## How tools are registered (ADR-8)
The low-level `Server` with `setRequestHandler(ListToolsRequestSchema | CallToolRequestSchema)`, not `McpServer.registerTool` (zod-only; it would answer `-32602` for a missing `rationale`). `tools/list` answers `publishedToolDescriptor(entry)` from `src/contracts`: `entry.publishedInputSchema` verbatim plus `annotations` and `_meta` (`x-read-only`, `x-destructive`, `x-gated-by`, `x-required-scopes`, `x-kind`); `catalog.tools_listed` records the same object, so the wire shape has one source. `sessionIdGenerator: undefined`, `enableJsonResponse: true`; empty `prompts` and `resources` capabilities are declared and answered with empty lists (ADR-3). The SDK answers 406 unless `Accept` lists both `application/json` and `text/event-stream`.

## Sessions (`sessions.ts`)
`xs` is keyed on `grant_id` (capacity 5000); silence over `XS_IDLE_GAP_MINUTES` closes the segment and opens a new one carrying the last `clientInfo`, protocol version and era forward (A-27, A-28); a re-`initialize` inside a live segment only raises `initialize_count`. `session.ended` is emitted lazily: on the next touch, by the 60 s sweep, or by `shutdown()`.

## Events owned
Every event carries the request correlation (`xs`, `login_id`, `grant_id`, `persona_id`, `request_id`, `era`, `client`, `protocol_version`, `trace_id`) via `withCorrelation`; the same wrapper is `ToolContext.xray`, so `src/tools`, `src/bank-core` and `src/etl` events land in the right `xs`.
`request_id` is the JSON-RPC id of the frame, as the envelope defines it (`src/contracts/events.ts`): on every event of the request and on everything the tools block causes through the same context (`intent.*`, `bank.op`, `etl.*`, `sql.*`), because `ToolContext.requestId` is that same id. The dashboard keys a call on `<xs>#<request_id>` (`callKeyOf` in `public/catalogue.js`), so this is what nests a call's children under it. The HTTP id of `src/app.ts` (`res.locals.requestId`) is only echoed as the `x-request-id` header.
- `http.request` - every `/mcp` and `/public/mcp` request, 405 and parser rejects included, once, on `finish` or on an earlier `close`: `method`, `path`, `status`, `duration_ms`, `user_agent`, `remote_ip_prefix` (`/24` or `/48`), `anthropic_egress`, `origin`, `origin_decision`, `mcp_protocol_version_header`, `mcp_session_id`, `has_authorization`, `content_type`, `sse`, `rate_limited`, and `raw` (`captureRawRequest`: every header in arrival order, Web Bot Auth's included, the body bytes, the socket peer; D-28). `httpObserver` emits the same payload, uncorrelated, for every request neither endpoint reports (`markHttpObserved`): discovery, `/register`, `/token`, `/authorize`, the login pages, `/`, CORS preflights, 404s; it skips `XRAY_CAPTURE_SKIP_PATHS`.
- `session.started` - `reason` (`first_request`/`idle_gap`), `idle_ms`.
- `session.initialized` - `protocol_version_requested`, `protocol_version_negotiated`, `client`, `client_capabilities`, `server_capabilities`, `instructions_sent`, `initialize_count`.
- `session.ended` - `reason` (`idle_gap`/`server_stopping`), `idle_ms`, `duration_ms`, `call_count`, `error_count`, `initialize_count`.
- `session.rejected` - `reason` (`origin_rejected`/`initialize`), `error`, `protocol_version_requested`.
- `catalog.tools_listed` - `count`, `content_hash`, `snapshot_ref`, `tools` (the full array only when the hash changed for that grant, else `null`), `availability`, `feature_flags`. Each row carries `descriptor` (contracts v0.5): the `tools/list` entry minus `name` and `title`, so a reader sees the wording and the schema the client received and can re-hash `descriptor.inputSchema` to `input_schema_hash`. Cost: the full 17-row listing is 32 KB of which the descriptors are 27 KB, paid once per grant per process boot (every later listing elides the array while the hash holds), against the emitter's 64 000-character event budget.
- `catalog.prompts_listed`, `catalog.resources_listed` - `count: 0`.
- `tool.call.started` - `tool`, `arguments` (verbatim; viewers get the deny-list applied on the way out), `redacted_fields: []`, `rationale`, `rationale_present`, `rationale_truncated`, `meta`, `required_scopes`, `budget_ms`.
- `tool.call.completed` - `tool`, `duration_ms`, `budget_ms`, `is_error`, `error {code, message, class: 'tool'}` (A-08), `content_types`, `content_chars`, `content_cap`, `structured_content`, `text_preview` (the joined text of the server's answer cut here at `RESULT_PREVIEW_BYTES`, with the `…[truncated]` marker appended when, and only when, it was cut; `content_chars` counts the whole result either way).
- `tool.call.cancelled` - `tool`, `duration_ms`, `reason` (`client_cancelled` on socket close before the response finished, `server_stopping` on `shutdown()`).
- `tool.call.denied` - `tool`, `denied_reason` (`insufficient_scope` 403, `rate_limited` 429, `feature_flag` 200), `required_scopes`, `missing_scopes`, `status`.
- `protocol.error` - `mcp.method.name`, `code`, `message`: every JSON-RPC error read back from the SDK's response body, a parser reject, or a transport throw (`-32603`).
- `auth.stepup.requested` - with the 403: `status`, `error`, `grant_id`, `login_id`, `persona_id`, `tool`, `scope`, `missing_scopes`, `resource_metadata`.

## Invariants held here
- Invariant 5: on `/mcp`, 401 and 403 are written before the SDK, never `200` + `isError`; the 403 lists every still-needed scope plus `resource_metadata`.
- Invariant 5 on the public lane: it never challenges, and serves nothing a scope would guard (D-26).
- Invariant 14 on the public lane: `tools/call` per IP prefix and per lane, both bounded maps; the handshake is never limited.
- Invariant 6: no `Mcp-Session-Id`, no session map, GET/DELETE 405; `prompts` and `resources` declared and empty.
- Invariant 9: tools published from the raw schema; write tools are never filtered for a missing write scope (`registry.listFor` owns the listing rule).
- Invariant 10: `decideOrigin` as above; over-strict validation causes claude.ai initialize timeouts.
- Invariant 11: `remote_ip_prefix` in the categorised fields; the full socket peer and forwarding headers only in `raw`, which viewers see cut to a prefix (D-28). Invariant 12: `shutdown()` is synchronous and the sweep timer is unref'd. Invariant 14: the per-grant `tools/call` limit; sessions, catalog memory and limiter maps capped at 5000.
- Invariant 7: no token reaches a stdout line or a categorised field; the `Authorization` header is recorded as sent inside `raw.headers` only (D-28). A-28, A-29: `clientInfo` and `User-Agent` are displayed and logged, never gated on.

## How to test
- `npx vitest run src/mcp` - 99 tests in 6 files (gate, protocol, sessions, events, public-lane, raw-capture); the harness validates every emitted event against `XrayEventSchema` and can mount the public lane with a fake `PublicToolRegistry` (`publicLane: {}`, `publicRpc`).
- The harness mounts the `res.locals.requestId` of `src/app.ts` as a sentinel ahead of the handler, so a test sees the same two ids a live server has: `ToolContext.requestId` must be the JSON-RPC id, never the HTTP one, or the tools block's events stop nesting under their call.
- `npm run e2e:oauth` (SDK client through `initialize`, `tools/list`, `tools/call`), `npm run e2e:session` (the 403 step-up, the full tool walk) and `npm run e2e:public` (an SDK client with no OAuth on `/public/mcp`, 23 checks with the X-ray export).
- `npx @modelcontextprotocol/inspector --cli --transport http --server-url http://localhost:8080/mcp --method tools/list`.

## Known gaps
- `text_preview` is a 2,048-character preview of the answer; the full text the model received is not in the log (only `content_chars` counts it).
- A body no parser reads (a content type the route does not accept, or one past its limit) is recorded as `raw.body_read: false`, its bytes unread; `content-length` in `raw.headers` still says what was sent.
- The Web Bot Auth signature is recorded, never verified: nothing fetches the `Signature-Agent` key directory.
- The events tests round-trip a listing through the contract schema, not through the viewer redaction walk: the block may not import `src/xray`. That walk over all 17 descriptors is asserted in `src/xray/__tests__/redaction.test.ts`.
- `auth.challenge`, `auth.verified` and the bearer-token `auth.rejected` are emitted by nobody: the gate writes the 401 without an event.
- `AuthContext.parent_grant_id` is always `null`; the access token does not carry it.
- `tool.call.cancelled {timeout}` and `session.rejected {rate_limited, unsupported_protocol}` are contract values nothing emits; the server has no timer of its own on a tool call. `notifications/cancelled` is not honoured; only a socket close cancels a call.
- The `xs` is decided before the persona lookup, so a grant whose generated persona vanished after a restart opens a session and then answers 401.
- `catalog.tools_listed` elision is per grant, not per `xs`; the read model resolves an elided array by `content_hash`.
- The header comment of `bootstrap-tools.ts` still promises the file is deleted at I1; it is not.
- A public visitor is its IP prefix and User-Agent: every claude.ai user behind Anthropic's egress with the same User-Agent shares one visitor, one session and one per-IP budget (A-48).
