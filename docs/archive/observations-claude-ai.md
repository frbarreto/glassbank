# Observations: what claude.ai, Claude Code and MCP Inspector actually sent

Filled at T0.5, updated at I4 and whenever a gate or cloud run teaches something new. Facts only, with dates and the git SHA of the server that observed them; interpretation goes to `docs/ASSUMPTIONS.md` (mark the assumption validated or amended) and `docs/contracts/CHANGES.md`.

## Environment

| Item | Value | Date / SHA |
|---|---|---|
| Cloud Run `status.url` | **not deployed** - no gcloud resource has ever been created for this project's `mcp-bank` service | 2026-09-08, no SHA (D-10) |
| Deterministic URL | `https://mcp-bank-520283334162.us-central1.run.app` (predicted by `infra/deploy.sh`, **not** confirmed against a live service) | 2026-09-08 |
| `PUBLIC_HOSTS` deployed | **not deployed**. Locally `localhost:8080` (host process and container) | 2026-09-08 |
| Node / `better-sqlite3` in `worker_threads` (A-18, A-39) | host: Node v23.10.0, darwin/arm64; container (`node:22-slim`): Node v22.23.2, linux/arm64. `better-sqlite3` 13.0.3 with SQLite **3.53.4** on both, prebuilt binaries, loads and queries fine inside a worker. `worker.terminate()` is bounded **only** when SQLite returns to JS - see A-39 below | 2026-09-08 |
| Related | The one hostname fact that *is* empirical: this project's existing `review` Cloud Run service reports the legacy `status.url` form `https://review-wdm7njj4pa-uc.a.run.app`, which is why `deploy.sh` runs the `status.url` correction step (A-36) | 2026-09-08 (T0.4) |

## Per client

Repeat the table for `claude.ai web`, `Claude Desktop`, `Claude mobile`, `Claude Code`, `MCP Inspector`.

**Status after T0.5 (2026-09-08): four of the five clients are still entirely unobserved.**
`claude.ai web`, `Claude Desktop`, `Claude mobile` and `Claude Code` have never reached this server -
nothing is deployed and no tunnel exists. The blank template below is theirs. The only real client that
has connected is **MCP Inspector CLI 2.5.0**, filled in immediately after it, plus the SDK's own client
in our e2e walk; both are local-only evidence and neither tells us anything about Claude.

| Observation | Value | Date / SHA |
|---|---|---|
| `MCP-Protocol-Version` header | | |
| `initialize.params.protocolVersion` | | |
| `clientInfo` (name, version, title) verbatim | | |
| Client capabilities | | |
| `Origin` header present? value? | | |
| `User-Agent` | | |
| Remote IP in `160.79.104.0/21`? | | |
| Discovery sequence (`initialize`, `notifications/initialized`, `resources/list`, `tools/list`, `prompts/list`, ...) | | |
| `tools/list` cadence / reconnect loop interval | | |
| DCR request body (`redirect_uris`, `token_endpoint_auth_method`, `application_type`, `client_name`) | | |
| Callback URL used | | |
| PRM path probed first | | |
| AS metadata document fetched (`oauth-authorization-server` / `openid-configuration`) | | |
| OAuth endpoint timings (register / authorize / token / refresh) | | |
| Step-up: was the listed write tool called under a read-only grant? 403 honoured? (A-40) | | |
| Step-up popup carried the `login_id` cookie? (A-41) | | |
| Behaviour under `ORIGIN_POLICY=log-only` vs `allowlist` (A-17) | | |
| `rationale` filled? quality? (A-05, A-06) | | |
| Prompted on destructive tools only? (A-07) | | |
| Anything unexpected | | |

### MCP Inspector CLI 2.5.0 (filled - local only, 2026-09-08, no SHA per D-10)

| Observation | Value |
|---|---|
| `MCP-Protocol-Version` header | absent on `initialize`; `2025-11-25` on every later request |
| `initialize.params.protocolVersion` | `2025-11-25` |
| `clientInfo` verbatim | `{"name":"inspector-cli","version":"2.5.0"}` |
| Client capabilities | T0.3 run: `{}`. T0.5 run: `{"roots":{"listChanged":true},"extensions":{"io.modelcontextprotocol/tasks":{},"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}`. Invocation-dependent; our server advertises neither extension and the client proceeded either way |
| `Origin` header present? value? | **absent** |
| `User-Agent` | `node` |
| Remote IP in `160.79.104.0/21`? | no - loopback (`127.0.0.0/24` after the invariant-11 prefixing) |
| Discovery sequence | `initialize` (401) -> PRM `/mcp` -> AS metadata -> `/register` -> `/authorize` -> `/token` -> `initialize` (200) -> `notifications/initialized` (202) -> `GET /mcp` (405, tolerated) -> `tools/list` |
| `tools/list` cadence / reconnect loop | one `tools/list` per connection; no reconnect loop observed |
| DCR request body | `{"client_name":"MCP Inspector","redirect_uris":["http://127.0.0.1:6276/oauth/callback"],"token_endpoint_auth_method":"none","application_type":"native"}` - note `native`, not `web` |
| Callback URL used | `http://127.0.0.1:6276/oauth/callback` (the **development-only** loopback path of A-13; refused under `NODE_ENV=production`) |
| PRM path probed first | `/.well-known/oauth-protected-resource/mcp`; the bare path was never fetched |
| AS metadata document fetched | `/.well-known/oauth-authorization-server` only; no `openid-configuration` probe |
| OAuth endpoint timings | register 1.8 ms, authorize ~1 ms, login ~4 ms, consent ~2 ms, token ~4 ms (loopback, warm) |
| Step-up (A-40) | not exercised by the Inspector. Exercised by our own SDK client: `create_transfer` under a read-only grant -> `403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="cards:write transfers:write", resource_metadata=...`. **Whether a client acts on it is unknown** |
| Step-up popup carried the `login_id` cookie? (A-41) | unobserved - needs a browser |
| `ORIGIN_POLICY` behaviour (A-17) | sends no `Origin`, so `log-only` and `allowlist` are indistinguishable for this client |
| `rationale` filled? (A-05, A-06) | n/a - the Inspector sends what the operator types |
| Prompted on destructive tools only? (A-07) | n/a - CLI |
| Anything unexpected | It opens a `GET /mcp` stream on **every** connection and carries on happily with our `405`. It also reconnected using a **token stored from a previous server process** with no OAuth flow at all (see A-11 below) |


## Spike findings (T0.3)

Recorded 2026-09-08 on macOS 15 (arm64), Node v23.10.0, against the local spike server
(`npx tsx test/e2e/spike-server.ts`, `PORT=8080`, `ORIGIN_POLICY=log-only`,
`FEATURE_FLAGS=writes;transfers`). No git SHA: nothing is committed yet (D-10). Nothing was deployed.

### MCP Inspector CLI 2.5.0 - observed traffic

The only real client available headlessly. `clientInfo` and the DCR body are verbatim from the server's
own per-request log lines; these belong in the "Per client" table above once someone who owns it folds
them in.

| Observation | Value |
|---|---|
| `MCP-Protocol-Version` header | absent on `initialize`; `2025-11-25` on every later request |
| `initialize.params.protocolVersion` | `2025-11-25` |
| `clientInfo` verbatim | `{"name":"inspector-cli","version":"2.5.0"}` |
| Client capabilities | `{}` (empty object) |
| `Origin` header | **absent** |
| `User-Agent` | `node` |
| Discovery sequence | `POST /mcp initialize` (401) -> `GET /.well-known/oauth-protected-resource/mcp` -> `GET /.well-known/oauth-authorization-server` -> `POST /register` -> `GET /authorize` -> `POST /token` -> `POST /mcp initialize` (200) -> `notifications/initialized` (202) -> **`GET /mcp` (405, tolerated)** -> `tools/list` |
| PRM path probed first | `/.well-known/oauth-protected-resource/mcp` (the resource-specific one). The bare path was never fetched by this client, but it is served. |
| AS metadata document fetched | `/.well-known/oauth-authorization-server` only; no `openid-configuration` probe |
| DCR request body | `{"client_name":"MCP Inspector","redirect_uris":["http://127.0.0.1:6276/oauth/callback"],"token_endpoint_auth_method":"none","application_type":"native"}` |
| Callback URL used | `http://127.0.0.1:6276/oauth/callback` - the **dev-only** loopback path of A-13. Without `allowDevLoopback` (i.e. under `NODE_ENV=production`) the Inspector cannot register at all. |
| `application_type` | `native`, not `web`. A-13's allowlist has to accept it. |
| Notable | After `notifications/initialized` the CLI opens a `GET /mcp` stream on **every** connection and carries on happily with the `405`. ADR-3's "GET -> 405" costs nothing with this client. |

### What the Inspector CLI could and could not do headlessly

`npx @modelcontextprotocol/inspector --cli --transport http --server-url http://localhost:8080/mcp`:

- **Reaches the 401 challenge and reports it correctly.** With `--stored-auth-only` it prints
  `{"error":{"code":"auth_required","message":"Error POSTing to endpoint: {\"detail\":\"No access token provided\"}"}}`
  - our Ramp body, echoed verbatim.
- **Cannot complete the browser OAuth leg by itself.** Without a TTY it refuses:
  `Interactive OAuth requires a TTY on stdin or stderr (or MCP_AUTO_OPEN_ENABLED=true).`
  With `MCP_AUTO_OPEN_ENABLED=true` it does everything except click: it registers the client, starts its
  loopback listener on `127.0.0.1:6276` and prints `Please navigate to: <authorize URL>`.
- **Completed the whole flow when the browser leg was driven with `fetch`.** Taking that URL, POSTing
  `/login` and `/consent` with the rendered `txn`/`csrf` and letting the 302 land on the Inspector's own
  callback produced `Authorization complete.`, a full `tools/list` of all 17 tools, and then
  `--stored-auth-only --method tools/call --tool-name get_current_user` returned a real result
  (`Harbor Supply Co. (per_harbor_supply)`, `read_only`, `xs_mtt2n3961`).
  **Stated plainly: the human click was replaced by a script; every other step was the Inspector's own.**
- **`--strict` (tool-schema portability) reports nothing.** Exit 0, empty stderr, for all 17 published
  schemas - including `create_transfer`'s `oneOf`, which T0.2 flagged as a risk. That is a green light
  from one client, not from claude.ai.

### SDK facts established (v1 1.30.0)

- `McpServer.registerTool` accepts **only** zod schemas (`AnySchema = z3.ZodTypeAny | z4.$ZodType`), so
  ADR-8's "register from the raw published JSON schema" is only reachable through the low-level `Server`
  plus `setRequestHandler`. `Server.setRequestHandler` wraps `tools/call` with `CallToolRequestSchema`
  and `CallToolResultSchema` and validates nothing else, so a call with no `rationale` reaches the
  handler. Proven by a test.
- `StreamableHTTPServerTransport` answers **406** unless `Accept` contains **both** `application/json`
  and `text/event-stream`, even with `enableJsonResponse: true`. Any hand-written `curl` probe needs
  both.
- `mcpAuthRouter` fixes `issuerUrl` at construction and mounts exactly one PRM path. Both are
  incompatible with A-36 and with ARCHITECTURE section 5; see `docs/blocks/auth.md` for the full
  reasoning behind hand-rolling the AS.

### v2 packages trial (2026-09-08, time-boxed, ~30 minutes)

Installed `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/express@2.0.0` and
`@modelcontextprotocol/server-legacy@2.0.0` in a scratch directory (never in `package.json`) and ran a
probe. Measured, not read:

| Question | Answer |
|---|---|
| Does v2 serve a **second protocol era**? | **No.** `SUPPORTED_PROTOCOL_VERSIONS` is `["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]` and `LATEST_PROTOCOL_VERSION` is `2025-11-25` - **byte-identical to SDK 1.30.0**. Neither major knows about `2026-07-28`. The premise of the trial ("would v2 serve both eras behind one `createTransport`") is false today. |
| Can v2 sit behind our `createTransport(deps)` interface? | **Yes**, with a bridge. v2 ships **no** Node `IncomingMessage`/`ServerResponse` transport - only `WebStandardStreamableHTTPServerTransport`. A ~15-line Express adapter (build a `Request` from `req`, pass `parsedBody`, copy the returned `Response` onto `res`) answered an `initialize` with `sessionIdGenerator: undefined` and `enableJsonResponse: true`. v1 gets this bridge for free through `@hono/node-server`. |
| Is the ADR-8 mechanism still available? | **Yes.** v2 exports the low-level `Server` with `setRequestHandler`, plus `fromJsonSchema`. |
| Is `@modelcontextprotocol/express` useful to us? | **No.** Its `createMcpExpressApp` builds a whole `Express` app aimed at localhost dev servers (automatic DNS-rebinding and Origin validation for loopback binds); it is not a router we can mount inside our own middleware order. Its `requireBearerAuth` would replace a gate we deliberately wrote ourselves. |
| What about the OAuth server helpers? | v2 moved them to `@modelcontextprotocol/server-legacy`, which npm marks **deprecated**: *"a frozen copy of v1's SSE transport and OAuth Authorization Server helpers for migration purposes only... Use a dedicated OAuth server in production."* Since T0.3 hand-rolled the AS, this costs us nothing - and it is upstream agreeing with the decision. |

**Recommendation for the T0.5 gate: stay on `@modelcontextprotocol/sdk` 1.30.0.** v2 buys no protocol
era, no ADR-8 improvement and no auth help, and costs a hand-written Node-to-Web-Standard bridge. Revisit
when an SDK actually advertises `2026-07-28`; the per-request `MCP-Protocol-Version` log line is what will
tell us claude.ai has moved.

### Local verification runs

| Command | Result |
|---|---|
| `npm run check` | 18 test files, 467 tests, typecheck and lint clean |
| `npx vitest run src/auth src/mcp` | 71 tests |
| `node test/e2e/oauth-walk.mjs` | 53 checks passed, 0 failed |
| `./infra/smoke.sh http://localhost:8080` | 20 passed, 0 failed, 3 skipped (the five checks T0.4 left red are now green) |

### Still unobserved

Everything about **claude.ai itself**: no connector was created, because nothing is deployed and no
tunnel exists (`cloudflared` is not installed on this Mac). The whole "Per client" table above is still
empty for `claude.ai web`, `Claude Desktop`, `Claude mobile` and `Claude Code`. In particular A-40 (does
Claude honour the 403 step-up?), A-41 (does the step-up popup carry the `login_id` cookie?), A-17 (Origin
values) and A-05/A-06 (`rationale` quality) cannot be answered from the Inspector alone.

## Local integration observations (T0.5, integrator) - NOT claude.ai

**Read this heading literally.** Everything below was measured on 2026-09-08 on this Mac
(macOS 15, arm64, Node v23.10.0, npm 10.9.2, Docker 27.4.0) against the **fully wired** server -
`src/server.ts` constructing `createAuth` + `createMcp` and injecting both into `createApp`. No git
SHA: nothing is committed (D-10). **Nothing was deployed, and no claude.ai connector exists**, so the
"Per client" table above is still empty for claude.ai web, Desktop, mobile and Claude Code.

Two targets were exercised, and they behave identically:

| Target | How | Result |
|---|---|---|
| Host process | `npm run build && node dist/server.js` (`NODE_ENV=development`) | `/healthz` 200; smoke 20/0/3; walk 17/17 |
| Shipped container | `HOST_PORT=8080 docker compose -f infra/local/docker-compose.yml up --build -d` (`NODE_ENV=production`, real signing key, uid 1000, SQLite on a named volume) | `/healthz` 200; smoke 20/0/3; walk 17/17 |

### Protocol version negotiated, per client (local)

| Client | `initialize.params.protocolVersion` | `MCP-Protocol-Version` header | `clientInfo` | Client capabilities |
|---|---|---|---|---|
| SDK 1.30.0 `Client` over `StreamableHTTPClientTransport` (our own e2e walk) | `2025-11-25` | **absent** on `initialize`, `2025-11-25` on every later request | `{"name":"integrator-dist-walk","version":"1.0.0"}` | `{}` |
| MCP Inspector CLI 2.5.0 | `2025-11-25` | **absent** on `initialize`, `2025-11-25` afterwards | `{"name":"inspector-cli","version":"2.5.0"}` | `{"roots":{"listChanged":true},"extensions":{"io.modelcontextprotocol/tasks":{},"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}` |
| `curl` (hand-written probe) | whatever is sent | as sent | as sent | as sent |

Two notes on that table:

- **The Inspector's capabilities are richer than T0.3 recorded.** T0.3 logged `{}`; this run logged
  `roots.listChanged` plus the `io.modelcontextprotocol/tasks` and `io.modelcontextprotocol/ui`
  extensions. Our server advertises neither extension and the Inspector proceeded normally. Treat the
  earlier `{}` as invocation-dependent, not as the client's fixed shape.
- **The `MCP-Protocol-Version` header is absent on `initialize` by design in both clients** (there is
  nothing negotiated yet) and present on everything after. `mcp_protocol_version_header` in the
  `http.request` log line is the field to watch for a future `2026-07-28` era.

### Discovery sequence observed locally

Composite, and honest about which client did which leg: T0.3 watched the **Inspector CLI** perform the
whole thing (with the human click scripted); at T0.5 the OAuth leg was driven by our own walk script and
the MCP leg by an SDK 1.30.0 `Client`. On the T0.5 Inspector run the client reused a **stored token** and
skipped discovery entirely, which is itself the A-11 finding below. Every step below was served by the
wired server and appears in its log:

```
POST /mcp initialize                      -> 401 + WWW-Authenticate (no token yet)
GET  /.well-known/oauth-protected-resource/mcp   -> 200   (the resource-specific path is probed first)
GET  /.well-known/oauth-authorization-server     -> 200   (no openid-configuration probe)
POST /register                            -> 201
GET  /authorize -> POST /login -> POST /consent  -> 302 to the client callback with code + state + iss
POST /token                               -> 200
POST /mcp initialize                      -> 200
POST /mcp notifications/initialized       -> 202
GET  /mcp                                 -> 405   (opened anyway; both clients tolerate it, ADR-3)
POST /mcp tools/list                      -> 200   (17 tools)
POST /mcp tools/call                      -> 200
```

The bare `/.well-known/oauth-protected-resource` path is served and correct but **no client fetched it**;
only `infra/smoke.sh` exercises it.

### Endpoint timings (local, warm, loopback)

`curl -w '%{time_total}'`, host process:

| Endpoint | Status | Time |
|---|---|---|
| `GET /healthz` | 200 | 9.7 ms first hit, ~1 ms after |
| `GET /.well-known/oauth-protected-resource` | 200 | 1.8 ms |
| `GET /.well-known/oauth-protected-resource/mcp` | 200 | 1.1 ms |
| `GET /.well-known/oauth-authorization-server` | 200 | 1.0 ms |
| `POST /mcp` (no bearer) | 401 | 1.2 ms |
| `POST /register` | 201 | 1.8 ms |
| `GET /xray` (placeholder) | 200 | 1.2 ms |

The whole browser leg from the server's own log lines: `/authorize` at `T+0 ms`, `/login` at `T+4 ms`,
`/consent` at `T+6 ms`, `/token` at `T+10 ms`. `POST /mcp initialize` took 10 ms (first, cold), then
1-3 ms per request. Claude's 10 s discovery budget is not remotely at risk locally; the open question is
the cold-start and TLS cost on Cloud Run, which only a deploy can answer.

### Origin values (A-17) - local only, and they prove nothing about claude.ai

Under `ORIGIN_POLICY=log-only`, `POST /mcp` with three different `Origin` headers:

| `Origin` sent | `origin_decision` logged | HTTP status |
|---|---|---|
| absent | `absent` | unchanged |
| `https://claude.ai` | `allowed` | unchanged |
| `http://localhost:8080` (our own origin) | `allowed` | unchanged |
| `https://evil.example` | `logged` | unchanged (401 from the bearer gate, not from the Origin check) |

`logged` is what would become `rejected` under `allowlist`. **The real Origin values claude.ai sends are
still unobserved**, so the T0.5 deliverable "switch `ORIGIN_POLICY` to `allowlist` once the observed
Origin values are recorded" has not been earned and the deployment default stays `log-only`.

### A-11 confirmed the hard way: a token outlived its server

The Inspector CLI connected with **no OAuth flow at all**, using a token stored during T0.3, against a
**different process running a different build**, and was authorised (`grant_id grt_BlZlN3VZUwVDd3Oc` -
a base64url-shaped id from before the T0.3 hex fix, which no longer exists in any store). This is exactly
A-11: verification is stateless, so a token is accepted by any process holding the same signing key while
`aud` matches and `exp` has not passed. Locally the signing key is a fixed development constant, so every
local run shares one trust domain. In the cloud the key comes from Secret Manager and
`NODE_ENV=production` refuses the development default, which bounds the blast radius to a key rotation -
but it is worth knowing that **restarting the server does not invalidate anything**, and that the
consumed-code / revoked-refresh sets are the only per-process state.

### Shutdown, and what threatens it

`SIGTERM` to the wired host process: **39 ms** to exit (invariant 12 allows 10 s). That number is only
safe while nothing holds a stuck native call - see A-39 below, which is the one measured threat to it.

### A-39 re-measured at the gate

`node scripts/smoke-worker-sqlite.mjs` -> **4 of 5 checks pass, exit code 1, on purpose**:

```
PASS  worker-thread sqlite (A-18, A-39): sqlite 3.53.4, ..., Statement.readonly=true, 31 ms
PASS  main event loop stays free while a worker burns CPU (ADR-9): 19 timer ticks during a 400 ms query
FAIL  worker.terminate() frees a worker stuck in WITH RECURSIVE (A-39): not freed within 2000 ms;
      the process itself could not exit either (SIGKILL required)
PASS  worker.terminate() frees a worker iterating a hostile query: worker exited 11 ms after terminate()
PASS  SIGKILL frees an out-of-process SQL runner (A-39 fallback): child killed mid-recursion in 1 ms
```

Independently reproduced by T0.1 and by the integrator. See `docs/contracts/CHANGES.md` v0.1, amendment 1.

### Local verification runs (integrator, wired system)

| Command | Result |
|---|---|
| `npm run check` | 20 test files, **477 tests**; `tsc --noEmit` and `eslint .` clean |
| `npm run build` then `node dist/server.js` | boots, `/healthz` 200, `origin_policy: log-only` |
| `infra/smoke.sh http://localhost:8080` (host process) | 20 passed, 0 failed, 3 skipped |
| `infra/smoke.sh http://localhost:8080` (container, `NODE_ENV=production`) | 20 passed, 0 failed, 3 skipped |
| `npm run e2e` (`test/e2e/oauth-walk.mjs`) | 53 checks passed, 0 failed |
| integrator walk against `dist/server.js` and against the container | 17 checks passed, 0 failed, each |
| `DRY_RUN=1 infra/deploy.sh` | prints the full build + deploy + status.url correction, creates nothing |
| `node scripts/smoke-worker-sqlite.mjs` | 4/5, exit 1 (A-39, above) |
| `SIGTERM` to the running server | clean exit in 39 ms |

### What T0.5 still owes

The gate is **half done**. Everything that can be proven without a cloud account or a browser is proven;
the deliverables that need either are not:

- Deploy under `ORIGIN_POLICY=log-only` (`infra/bootstrap.sh`, `infra/deploy.sh`, `infra/smoke.sh`
  against the live URL) - blocked: this run may not create cloud resources.
- Connect from claude.ai (web, Desktop, mobile) and from Claude Code; call `get_current_user` from each.
- Fill the "Per client" table above, including the real `Origin` values and the DCR payload claude.ai
  sends.
- Switch to `ORIGIN_POLICY=allowlist` and reconnect.
- Record the service URL, **both** `run.app` hostnames and the deployed revision in the Environment
  table above.

## L4 (Phase 1, `mcp`): what the server now records - still nothing new about claude.ai

Recorded 2026-09-08, same Mac, no deploy, no tunnel, no connector. **No Claude client has reached
this server yet**; everything in the "Per client" table above is still empty for claude.ai web,
Desktop, mobile and Claude Code. What changed is the *instrument*, not the observation.

### Every `/mcp` request now leaves two traces

1. **A contract-validated `XrayEvent`** for each of `http.request`, `session.started` /
   `initialized` / `ended` / `rejected`, `catalog.tools_listed` / `resources_listed` /
   `prompts_listed`, `tool.call.started` / `completed` / `cancelled` / `denied`,
   `protocol.error` and `auth.stepup.requested`. These reach the dashboard live.
2. **One structured stdout line per request**, kept deliberately, because it carries the
   JSON-RPC facts this table asks for that `http.request` does not: `rpc_methods`, `rpc_tools`,
   `initialize_protocol_version`, `client_info`, `client_capabilities`, alongside
   `mcp_protocol_version_header`, `origin`, `origin_decision`, `user_agent`,
   `remote_ip_prefix` (`/24` only), `anthropic_egress`, `grant_id` and `xs`. **That line is how
   this table gets filled from a container log with no dashboard viewer attached** -
   `gcloud run services logs read mcp-bank | grep '"event":"http.request"'`.

Two fields worth watching when a Claude client finally connects:

- `mcp_protocol_version_header` - the first sign of a `2026-07-28` era client (ADR-2).
- `initialize_count` on `session.initialized` - claude.ai's documented reconnect loop shows up as
  one `xs` with a rising count, never as new sessions (A-27). If it *does* produce new sessions,
  `XS_IDLE_GAP_MINUTES` is set wrong.

### SDK facts established by running, not by reading (1.30.0)

- **Protocol negotiation is exactly** `SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested
  : LATEST_PROTOCOL_VERSION` (`server/index.js` `_oninitialize`). A request for an unsupported
  version is **not** refused - it is silently negotiated down to `2025-11-25`. `src/mcp` reports
  both `protocol_version_requested` and `protocol_version_negotiated` for that reason, and a test
  asserts its own copy of the expression against the SDK's real answer for `2025-11-25`,
  `2024-11-05` and `1999-01-01`.
- **An unknown JSON-RPC *method* is answered by the `Protocol` layer with `-32601` and no hook.**
  `fallbackRequestHandler` exists, but `-32602` from the SDK's own envelope validation does not go
  through it either. The only place both are visible is the response body, so `src/mcp/transport.ts`
  reads the body back (`write`/`end` are wrapped, capped at 512 KB, always forwarded) and emits
  `protocol.error` from what the SDK actually answered. Verified with
  `sampling/createMessage` -> `-32601` recorded, and with `tools/call` naming a tool that is not in
  the catalog.
- **A malformed `initialize` is answered `-32603`, not `-32602`.** `{"method":"initialize","params":{"capabilities":{}}}`
  (no `protocolVersion`) fails the SDK's own envelope validation and comes back as an internal
  error, not as invalid params. This is precisely why `src/mcp` reads the code off the response
  rather than inventing one from the shape of the request.
- **`StreamableHTTPServerTransport` in 1.30.0 is a wrapper over `WebStandardStreamableHTTPServerTransport`
  through `@hono/node-server`**, and the body still arrives on the Node `ServerResponse`, which is
  what makes that capture work.

### Still unobserved (unchanged)

A-40 (does Claude honour the 403 step-up?), A-41 (does the step-up popup carry the `login_id`
cookie?), A-17 (the real `Origin` values), A-05/A-06 (`rationale` quality), and the `tools/list`
cadence that motivates the `catalog.tools_listed` snapshot elision - the "every 25 to 80 seconds"
figure is Anthropic's documentation, **not** something this server has measured.

## Decisions taken from these observations

Link each to its `docs/contracts/CHANGES.md` entry.

| Observation | Decision | Entry |
|---|---|---|
| v2 SDK packages advertise the same five protocol versions as 1.30.0, ship no Node transport and moved the OAuth helpers into a deprecated package | Stay on `@modelcontextprotocol/sdk` 1.30.0 (ADR-2) | `CHANGES.md` v0.1, "SDK decision" |
| `McpServer.registerTool` takes only zod schemas and validates every call | ADR-8 is implemented with the low-level `Server` + `setRequestHandler`; proven by a `tools/call` with no `rationale` reaching the handler | `CHANGES.md` v0.1, amendment 3 |
| `mcpAuthRouter` fixes `issuerUrl` and serves one PRM path | The SDK auth router is not used; `src/auth` is hand-rolled and ADR-16's `rateLimit: false` is moot | `CHANGES.md` v0.1, amendment 2 |
| `worker.terminate()` does not free a worker blocked in native SQLite | ADR-9 needs a cancellation mechanism that bounds any query; `ScratchDb` is already mechanism-agnostic so no contract change is needed | `CHANGES.md` v0.1, amendment 1 |
| The Inspector registers with `application_type: "native"` and a `/oauth/callback` loopback path | A-13 accepts it in development; **someone must decide** whether the Inspector should be usable against the deployed service | `CHANGES.md` v0.1, amendment 4 and "what this freeze rests on" |
| An access token minted by a previous process was accepted | A-11 confirmed as written; no change, but the runbook should say that a restart revokes nothing | `CHANGES.md` v0.1 (recorded here, no entry needed) |
| No `Origin` value from any Claude client has ever been seen | `ORIGIN_POLICY` stays `log-only`; the switch to `allowlist` is **not** earned yet | T0.5 remains open |
