# Observations: what claude.ai, Claude Code and MCP Inspector actually sent

Facts only, with dates. Interpretation goes to `docs/ASSUMPTIONS.md` and `docs/contracts/CHANGES.md`. Deployed on Cloud Run since 2026-09-26 (`docs/DEPLOYMENT.md`); every observation dated before that was made against `node dist/server.js` on the developer's Mac, port 8080, `ORIGIN_POLICY=log-only`. Local clients reached it on loopback. Codex reached it on 2026-09-09 through a cloudflared quick tunnel - the first non-local client, and not a deployment.

## What every `/mcp` request records

Two traces per request, both produced by `src/mcp/index.ts`; the schemas live in `src/contracts/events.ts`, the helpers (`eraOf`, `emitWithId`, `withCorrelation`) in `src/mcp/xray.ts`.

| Trace | Fields |
|---|---|
| `http.request` event (`HttpRequestData`) | `method`, `path`, `status`, `duration_ms`, `user_agent`, `remote_ip_prefix` (`/24` for IPv4, `/48` for IPv6, invariant 11), `anthropic_egress` (inside `160.79.104.0/21`), `origin`, `origin_decision` (`allowed` / `absent` / `rejected` / `logged`), `mcp_protocol_version_header`, `mcp_session_id` (recorded if a client sends one; never issued), `has_authorization`, `content_type`, `sse`, `rate_limited` |
| `http.request` `raw` block (v0.9, D-28; every path, not only `/mcp`) | every header in arrival order with case and duplicates (so `Signature`, `Signature-Input`, `Signature-Agent`, `traceparent`, `X-Forwarded-For`, vendor headers), the body bytes as sent, `http_version`, the socket peer. Read it from an admin export; the dashboard shows it under "Request as received" |
| `session.initialized` event (`SessionInitializedData`) | `protocol_version_requested`, `protocol_version_negotiated`, `client` (`clientInfo` verbatim: `name`, `version`, `title`), `client_capabilities`, `server_capabilities`, `instructions_sent`, `initialize_count` |
| One structured stdout line, `"event":"http.request"` | the `http.request` fields plus `base_url`, `host`, `origin_policy`, `rpc_methods`, `rpc_tools`, `initialize_protocol_version`, `client_info`, `client_capabilities`, `grant_id`, `xs`. This is how the table below is filled from a log with no dashboard attached (`gcloud run services logs read mcp-bank` once deployed) |

Signals to watch: a header or negotiated version at or above `2026-07-28` flips `era` to `modern` (SDK 1.30.0 negotiates at most `2025-11-25`, so every session so far is `legacy`, ADR-2); `initialize_count` rising on one `xs` is a reconnect loop (A-27), while a new `xs` per reconnect means `XS_IDLE_GAP_MINUTES` is too low. The SDK negotiates `SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION`: an unsupported version is negotiated down to `2025-11-25`, never refused.

## Per client

| Client | Version | Date | Protocol version | `clientInfo` | Capabilities | `Origin` | DCR shape | Notes |
|---|---|---|---|---|---|---|---|---|
| curl | - | 2026-09-08 | as sent | as sent | as sent | as sent: absent -> `absent`; `https://claude.ai` and the server's own origin -> `allowed`; `https://evil.example` -> `logged` (`rejected` under `allowlist`) | - | `StreamableHTTPServerTransport` answers 406 unless `Accept` carries both `application/json` and `text/event-stream`. `POST /mcp` without a bearer is 401 in about 1 ms |
| SDK 1.30.0 `Client` over `StreamableHTTPClientTransport` (`test/e2e/*.mjs`) | client `0.1.0` | 2026-09-08 | `2025-11-25`; `MCP-Protocol-Version` absent on `initialize`, `2025-11-25` after | `{"name":"glass-bank-e2e","version":"0.1.0"}`; `glass-bank-session-walk` and `glass-bank-session-walk-write` in the session walk | `{}` | not recorded | `client_name` `Glass Bank e2e walk` / `Glass Bank session walk`, `redirect_uris` `["http://127.0.0.1:60123/callback"]` / `60124`, `token_endpoint_auth_method` `none`, `application_type` `web` | Exercises the step-up: `create_transfer` under a read-only grant -> `403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="cards:write transfers:write", resource_metadata=...`. A `tools/call` with no `rationale` reaches the handler |
| MCP Inspector CLI | 2.5.0 | 2026-09-08 | `2025-11-25`; header absent on `initialize`, `2025-11-25` after | `{"name":"inspector-cli","version":"2.5.0"}` | `{}` on one run; `{"roots":{"listChanged":true},"extensions":{"io.modelcontextprotocol/tasks":{},"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}` on another - invocation-dependent; the server advertises neither extension and the client proceeded | absent | `{"client_name":"MCP Inspector","redirect_uris":["http://127.0.0.1:6276/oauth/callback"],"token_endpoint_auth_method":"none","application_type":"native"}` | `User-Agent: node`, loopback. Probes `/.well-known/oauth-protected-resource/mcp` first (never the bare path), then `/.well-known/oauth-authorization-server` only. Opens `GET /mcp` on every connection and tolerates the 405. One `tools/list` per connection, no reconnect loop. Reconnected with a token stored from a previous server process, no OAuth (A-11). Its `/oauth/callback` is the development-only loopback of A-13, refused under `NODE_ENV=production`. `--strict` passes all 17 schemas, including `create_transfer`'s `oneOf`. The browser leg needs a TTY or `MCP_AUTO_OPEN_ENABLED=true` |
| Codex (OpenAI) | `codex-mcp-client/0.153.4` | 2026-09-09 | requests `2025-06-18`; first sends `GET /mcp` with `MCP-Protocol-Version: 2024-11-05` (405) | title `Codex` | `elicitation: {form, url}`; later connections also `extensions: io.modelcontextprotocol/ui, openai/form` | absent | `{client_name:"Codex", redirect_uris:["http://127.0.0.1:<random port>/callback"], token_endpoint_auth_method:"none", application_type:"native"}`, one fresh registration per connection | First non-local client, through the cloudflared tunnel, not a deployment. Sequence: `GET /mcp` (405) -> unauthenticated `POST /mcp` (401) -> OAuth -> `initialize` twice per connection -> `tools/list` and `resources/list`. No `Mcp-Session-Id`. Requested every scope, including `cards:write`, `transfers:write` and `xray:read`. Chose the shared persona `per_ava_stone`. `rationale` values in the user's language (Portuguese). Ran `get_current_user`, `load_accounts`, `get_tool_availability`, `process_data`, `execute_query`, `clear_table` successfully. Remote address IPv6, recorded as a `/48` prefix |

## Cloud Run itself (2026-09-26)

Measured from the developer's Mac against revision `mcp-bank-00004-9vw`, `ORIGIN_POLICY=log-only`:

- Both hostnames serve the app with the right OAuth identity: `mcp-bank-520283334162.us-central1.run.app` (deterministic) and `mcp-bank-wdm7njj4pa-uc.a.run.app` (Cloud Run's `status.url`); `deploy.sh` put both in `PUBLIC_HOSTS` (A-36).
- Discovery: each of the three documents answers in 0.26 to 0.34 s end to end from Brazil, TLS handshake included (0.09 to 0.17 s), against the 10 s budget; smoke check 8 agrees.
- `http://` answers 302 to `https://`; responses carry `server: Google Frontend` and `alt-svc: h3`; the app's `x-request-id` comes through.
- Google's front end intercepts exactly `/healthz` (query string included) with its own 404 and never forwards it; `/healthz/` and `/health` reach the app. Contracts v0.6 made `/health` the public name.
- `gcloud run services describe --format=yaml` carries a default `startupProbe` with `timeoutSeconds: 240` above the service's own `timeoutSeconds: 3600`; smoke check 6 reads the service field.
- Domain mapping `glassbank-mcp.abovethefog.app`: record created 19:23 UTC, `CertificateProvisioned` 19:34 UTC (11 minutes, well inside the hourly re-check the status message announces); at 19:41 UTC Google's edges still answered TLS for the name inconsistently from Brazil (one request in four), while the GitHub runner's smoke passed all 36 checks at 19:42 UTC. Plain `http://` on the name already answered 302 to `https://` before the certificate was served.

## The first real clients on Cloud Run (2026-09-27, `exports/*20260927*`)

Facts from the X-ray exports and Cloud Run's request log, recorded before v0.9, so without headers:

- claude.ai connected as `clientInfo` `{"name":"Anthropic/ClaudeAI","version":"1.0.0"}`, protocol `2025-11-25`, capabilities `{"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}`, `User-Agent: Claude-User`; its `initialize` carried `_meta.traceparent` (W3C form), its `tools/call` no `_meta`.
- Every `Claude-User` request, and the `python-httpx/0.28.1` calls to `/token` and `/register` that go with them, reached the container as `0.0.0.0`: Cloud Run's own request log shows `remoteIp: 0.0.0.0`, so `remote_ip_prefix` is `0.0.0.0/24` and `anthropic_egress` is `false` (A-43). curl, Python and Codex callers show real addresses.
- Codex arrived as `openai-mcp/1.0.0 (Codex)` from `51.59.24.0/24` and `51.59.48.0/24`, and `openai-mcp/1.0.0` without the suffix.
- OpenAI's `OAI-SearchBot/1.0` fetched `/robots.txt` (404) on the custom hostname.
- Whether any of them signed with Web Bot Auth is unknown: no header was recorded before v0.9, and Cloud Run's request log keeps none. The next connection after the v0.9 deploy answers it (`raw.headers`, the "Signed with Web Bot Auth" callout).

## Still unobserved

- claude.ai Desktop and mobile; the web client's full row in the table above (its DCR body, headers and `Origin`, which v0.9 records).
- Claude Code.
- ChatGPT: the owner reports (by 2026-09-15) that it connected through the cloudflared tunnel, but its `clientInfo`, headers, `Origin` and DCR body were not recorded. Capture them on its next connection.
- Any request from Anthropic's egress range `160.79.104.0/21`: `anthropic_egress` has never been `true`; claude.ai arrives as `0.0.0.0` (above).
- Any Web Bot Auth signature (`Signature-Agent`) from any client.
- Any `Origin` header from a browser-based client. Every recorded client sent none, so `log-only` and `allowlist` have been indistinguishable.
- A-40 (does Claude act on the 403 step-up), A-41 (does the step-up popup carry the `login_id` cookie), A-05 / A-06 (`rationale` quality from Claude), A-17 (Origin values), and the `tools/list` cadence ("every 25 to 80 s" is Anthropic's documentation, not a measurement here).
- Cloud Run: a cold start (never happens with one always-on instance) and the proxy hop count behind `app.set('trust proxy', 1)`: since v0.9 the whole `X-Forwarded-For` chain and the socket peer are in `raw`, so one admin export of a real request answers it.

## Decisions taken from these observations

| Observation | Decision |
|---|---|
| `@modelcontextprotocol/server` 2.0.0 advertises the same five protocol versions as 1.30.0 (`2025-11-25` down to `2024-10-07`), ships no Node `IncomingMessage` transport, and moved the OAuth helpers into the deprecated `server-legacy` package | Stay on `@modelcontextprotocol/sdk` 1.30.0 (ADR-2); revisit when an SDK advertises `2026-07-28` |
| No `Origin` from any Claude client yet | `ORIGIN_POLICY=log-only` until claude.ai's values are recorded here; then `allowlist` (invariant 10) |
| Inspector and Codex both open `GET /mcp`, tolerate the 405 and send no `Mcp-Session-Id` | Stateless transport stands: no `Mcp-Session-Id`, GET and DELETE answer 405 (ADR-3, invariant 6) |
| Codex calls `resources/list` after `tools/list` | Empty `prompts` and `resources` capabilities are declared and both lists answer empty, recorded as `catalog.prompts_listed` / `catalog.resources_listed` |
| Inspector reconnected with a token minted by a previous process | A-11 confirmed: verification is stateless and a restart revokes nothing; the consumed-code and revoked-refresh sets are the only per-process state |
| Inspector and Codex register `application_type: "native"` with a loopback redirect | Any `application_type` is accepted; a loopback `/callback` always, the Inspector's `/oauth/callback` outside production only (A-13, `isAllowedRedirectUri` in `src/contracts/auth.ts`); whether the Inspector should work against the deployed service is undecided |
