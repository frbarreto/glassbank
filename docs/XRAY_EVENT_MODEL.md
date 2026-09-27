# X-ray event model

The contract between the server (producer) and the dashboard (consumer): `src/contracts/events.ts` (zod; 46 event types in 12 families; `XRAY_CONTRACT_VERSION` = 1) and `src/contracts/xray-api.ts` (routes, SSE constants, response types). Contracts are v0.7 and append-only: types and fields are added, never renamed or removed. The dashboard parses with `XrayEnvelopeSchema` (any `type`, any `data`), so an unknown type still gets a timeline row and its whole envelope as a JSON tree in the inspector. Tests: `npx vitest run test/contracts src/xray public/__tests__`.

## 1. What the server can and cannot see

- Can see: HTTP facts (method, path, status, `User-Agent`, `Origin` and its decision, the `/24` IP prefix, `MCP-Protocol-Version`), the OAuth identity (persona, login, grant, scopes, expiry, client), every JSON-RPC frame it answers (`initialize`, `tools/list`, `tools/call` arguments and `_meta`, results, `isError`, protocol errors), its own work (bank operations, ETL, SQL, evictions) and the model-authored `rationale`.
- Cannot see: the user's prompt, the model's reasoning, the final answer, other connectors, approvals clicked in the client, token usage, the conversation id (`panel-intent.js` says so on screen).
- `intent.declared` is the model's own `rationale`, verbatim, always `model_authored: true`; `intent.inferred` is this server's guess from the tool sequence and the rationale wording, always `model_authored: false` and always a label for the run of calls, not for one call. Details below the catalogue.
- `clientInfo` is displayed verbatim and never used for gating (A-28).
- Approvals in a two-step write are invisible: the server only sees the second `create_transfer` call.

## 2. Envelope (`EnvelopeBase`)

| Field | Meaning |
|---|---|
| `id` | Process-monotonic integer; SQLite primary key, SSE `id`, replay cursor; continues from `restored_max_id` after a restart. |
| `ts` | ISO-8601 UTC. |
| `type` | `family.noun[.verb]`, section 3. |
| `v` | Literal `1`. |
| `xs` | X-ray session id (`xs_`); `null` before a grant is known. |
| `login_id`, `grant_id`, `persona_id` | Correlation keys (`lgn_`, `grt_`, `per_`); `null` when unknown. `login_id` is what the viewer scope is bound to (ADR-14). |
| `seq` | Per-`xs` counter from 1; `null` when `xs` is `null`. |
| `request_id` | JSON-RPC id as a string, when applicable. |
| `era` | `legacy` (initialize handshake) / `modern` (`_meta`) / `null`. |
| `client` | `{name, version, title}` from `initialize`, carried forward to later requests by the session record. |
| `protocol_version` | Negotiated or header-declared. |
| `trace_id` | `_meta.traceparent` if a client ever sends it. |
| `data` | Type-specific payload; OTel attribute names where they exist (`mcp.method.name`). |

Producers call `XrayEmitter.emit(type, data, correlation?)`, which returns the assigned id (or `void`); the emitter fills `id`, `ts`, `v`, `seq`, appends the payload to the log exactly as given and fans out; it never throws and never blocks the caller. Since v0.9 (D-28) every schema is open: a field the catalogue does not name is kept (the dashboard lists it as "unmapped"), and nothing is redacted or truncated on the way in.

## 3. Event catalogue

Producer in brackets; `?` = nullable or defaulted; enums spelled out.

| Type | `data` |
|---|---|
| `server.started` [xray] | `boot_id`, `version`, `git_sha?`, `sdk?`, `restored_max_id?`, `node_version?` |
| `server.stopping` [xray] | `boot_id`, `version`, `reason: sigterm / sigint / shutdown`, `uptime_s?`, `sessions_ended?` |
| `http.request` [mcp] | `method`, `path`, `status`, `duration_ms`, `user_agent?`, `remote_ip_prefix?`, `anthropic_egress`, `origin?`, `origin_decision: allowed / absent / rejected / logged`, `mcp_protocol_version_header?`, `mcp_session_id?`, `has_authorization`, `content_type?`, `sse`, `rate_limited`, `raw?` (v0.9, D-28: the request as it arrived - `method`, `url`, `http_version`, `headers` as `[name, value]` pairs in arrival order with case and duplicates, `trailers`, `body` (UTF-8 text or base64), `body_encoding`, `body_bytes`, `body_read`, `remote_address`, `remote_port`). One per request on every path: `/mcp` and `/public/mcp` with correlation, everything else (discovery, OAuth, `/`, 404s) through the catch-all observer, with none; `XRAY_CAPTURE_SKIP_PATHS` (default `/xray;/health;/healthz`) leaves prefixes out |
| `auth.challenge` [no producer yet] | `status` (401), `error?`, `scope`, `resource_metadata`, `reason?` |
| `auth.verified` [no producer yet] | `grant_id`, `login_id?`, `persona_id`, `scopes`, `auth_level: read_only / read_write`, `client_id` (hash), `client_name?`, `aud`, `expires_at` |
| `auth.rejected` [auth] | `status` (401), `error`, `reason: no_access_token / malformed / invalid_signature / expired / wrong_typ / bad_audience / revoked_grant / unknown_client / invalid_grant / rate_limited`, `client_id?` |
| `auth.client.registered` [auth] | `client_id`, `client_name?`, `redirect_uris`, `token_endpoint_auth_method`, `application_type?` |
| `auth.client.reconstructed` [auth] | `client_id`, `client_name`, `redirect_uris`, `reason: unknown_client_after_restart / evicted_from_lru` |
| `auth.grant.created` [auth] | `grant_id`, `parent_grant_id?`, `login_id`, `persona_id`, `scopes`, `auth_level`, `client_id`, `client_name?`, `expires_at?`, `shared_persona` |
| `auth.grant.updated` [auth] | same `grant_id` as the consent it extends; `login_id`, `persona_id`, `scopes`, `added_scopes`, `auth_level`, `client_id`, `reason: step_up / re_consent` |
| `auth.token.issued` [auth] | `grant_id`, `login_id?`, `persona_id`, `scopes`, `auth_level`, `client_id`, `aud`, `expires_at`, `refresh_expires_at?` |
| `auth.token.refreshed` [auth] | as issued minus `aud`, plus `rotated_jti?` |
| `auth.token.revoked` [auth] | `grant_id?`, `login_id?`, `client_id?`, `reason: revocation_request / grant_revoked / reuse_detected` |
| `auth.stepup.requested` [mcp gate] | `status` (403), `error`, `grant_id`, `login_id?`, `persona_id?`, `tool`, `scope`, `missing_scopes`, `resource_metadata` |
| `auth.login.created` [auth] | `login_id`, `persona_id`, `expires_at`, `persona_source: seeded / generated / recovered`, `shared_persona` |
| `session.started` [mcp] | `reason: first_request / idle_gap`, `idle_ms?` |
| `session.initialized` [mcp] | `protocol_version_requested?`, `protocol_version_negotiated`, `client?`, `client_capabilities`, `server_capabilities`, `instructions_sent`, `initialize_count` |
| `session.ended` [mcp] | `reason: idle_gap / server_stopping`, `idle_ms?`, `duration_ms?`, `call_count`, `error_count`, `initialize_count` |
| `session.rejected` [mcp] | `reason: initialize / origin_rejected / rate_limited / unsupported_protocol`, `error?`, `protocol_version_requested?` |
| `catalog.tools_listed` [mcp] | `count`, `content_hash`, `snapshot_ref?`, `tools?` (`{name, title, read_only, destructive, idempotent, scopes, input_schema_hash, descriptor?}`, `descriptor` = `{description, inputSchema, annotations, _meta}`, the `tools/list` entry minus `name` / `title` from `publishedToolDescriptor`, so the record cannot drift from the response (contracts v0.5; absent on rows recorded before it); the array only when `content_hash` changed for the grant, otherwise `snapshot_ref` points at the listing that carried it), `availability[]`, `feature_flags[]` |
| `catalog.resources_listed` / `catalog.prompts_listed` [mcp] | `count` (always 0) |
| `catalog.availability` [tools] | `content_hash`, `availability[]`, `feature_flags[]`, `source: tools_list / get_tool_availability` |
| `tool.call.started` [mcp] | `tool`, `arguments` (verbatim minus deny-lists), `redacted_fields[]`, `rationale?`, `rationale_present`, `rationale_truncated`, `meta?`, `required_scopes[]`, `budget_ms` (300000) |
| `tool.call.completed` [mcp] | `tool`, `duration_ms`, `budget_ms`, `is_error`, `error? {code?, message, class: protocol / tool}`, `content_types[]`, `content_chars`, `content_cap` (150000), `structured_content?`, `text_preview?` (2 KB) |
| `tool.call.cancelled` [mcp] | `tool`, `duration_ms`, `reason: client_cancelled / timeout / server_stopping` |
| `tool.call.denied` [mcp gate, tools registry] | `tool`, `denied_reason: insufficient_scope / rate_limited / feature_flag`, `required_scopes[]`, `missing_scopes[]`, `status` (403; 429 when rate-limited; 200 for `feature_flag`, which the client sees as `-32601`) |
| `protocol.error` [mcp] | `mcp.method.name?`, `code` (`-32700 -32600 -32601 -32602 -32603`; `-32020..-32022` reserved), `message` |
| `bank.op` [bank-core] | `operation` (`family.verb`, `BANK_OPERATIONS`: `accounts.list`, `cards.list`, `transactions.list`, `transfers.list`, `bills.list`, `payees.list`, `categories.list`, `statement_lines.list`, `persona.get`, `card.lock`, `card.unlock`, `transfer.preview`, `transfer.confirm`, `audit.append`, `overlay.reset`), `account_id?`, `card_id?` (masked), `pages?`, `rows?`, `latency_ms`, `ok`, `audit_id?`, `preview_id?`, `error?` |
| `etl.load` [etl] | `table`, `rows`, `columns_advertised[]`, `source_tool`, `duration_ms` |
| `etl.processed` [etl] | `table`, `rows`, `columns_advertised[]`, `columns_selected[]`, `duration_ms` |
| `etl.table_evicted` [etl] | `table`, `reason: ttl / grant_cap / global_cap / timeout / crash`, `rows?`, `age_ms?` |
| `etl.limit_reached` [etl] | `limit: tables / ops / global_dbs`, `table?`, `current?`, `max?`, `message?` |
| `etl.worker_terminated` [etl] | `reason` (same enum as `etl.table_evicted`), `duration_ms?`, `table?`, `tables_lost[]` |
| `sql.query` [etl] | `table?`, `sql` (verbatim), `rows_returned`, `capped`, `duration_ms` |
| `sql.table_cleared` [etl] | `table`, `duration_ms?` |
| `sql.rejected` [etl] | `table?`, `sql`, `rejected_reason: not_readonly / denylist / timeout / unknown_table / multi_statement / row_cap / unknown_column / syntax_error`, `error`, `duration_ms?` |
| `intent.declared` [tools] | `text` (the rationale, verbatim), `source: rationale`, `model_authored: true`, `tool`, `truncated` |
| `intent.inferred` [tools] | `workflow: spend_analysis / card_control / payment / balance_check / exploration / unknown`, `confidence` (schema 0..1; only 0.2 and 0.40-0.85 are reachable, and it is not a probability - see Intent below), `source: classifier`, `model_authored: false`, `tools[]`. No `tool` field: it labels the run of calls. |
| `intent.missing` [tools] | `tool`, `reason: absent / empty / wrong_type` |
| `xray.pairing.created` [xray] | `code` (hashed), `login_id`, `expires_at` |
| `xray.pairing.rejected` [xray] | `code?` (hashed), `reason: unknown_code / expired / rate_limited / malformed` |
| `xray.viewer.connected` [xray] | `viewer_kind: pairing / admin`, `login_id?`, `filter: xs / login / all`, `last_event_id?`, `replayed` |
| `xray.viewer.disconnected` [xray] | `viewer_kind`, `login_id?`, `filter`, `duration_ms?`, `reason: client_closed / server_cut / backpressure` |
| `xray.dropped` [xray] | `dropped_count`, `viewer_kind?`, `filter?`, `reason: backpressure` |
| `xray.events.deleted` [xray] | `scope: session / login`, `xs_deleted?`, `deleted_count`, `sessions_deleted`, `viewer_kind`; written after the erase, so it is the one record that survives it |

Redaction (`src/xray/redaction.ts`, on the way out since v0.9, D-28: `viewEvent` for the stream, the session page and a pairing or public-lane export; the admin export returns the log as stored; unit-tested): sensitive keys by exact name and fragment (`token`, `secret`, `password`, `cookie`, `jwt`, `verifier`, `cvv`, ...) -> `[redacted]`; `account_number` / `card_number` / `routing_number` / `iban` / `swift` / `pan` masked to `****1234`; bare Luhn-valid 13-19 digit runs masked; `GLOBAL_REDACTION_PATTERNS`; `tool.call.started.arguments` and `meta` verbatim except the per-tool deny-list; `rationale` (cap 8192) and `sql` verbatim; IP addresses shown as their `/24` (IPv6 `/48`) prefix, in `remote_ip`, `raw.remote_address` and forwarding headers (`X-Forwarded-For`, `Forwarded`, ...); in `raw`, credential headers (`Authorization`, `Cookie`, any name with a sensitive fragment) and query parameters hidden, a JSON body walked like the categorised fields (the per-tool deny-list reaches `tools/call` `params.arguments`, an OAuth token request's `code` is hidden), a form body by parameter; `Signature`, `Signature-Input` and `Signature-Agent` shown; `_meta.progressToken` shown (a handle, not a credential); pairing codes hashed; per-event budget 64,000 chars, strings 16,384, depth 12, arrays 500, keys 200. Observer mode (`applyObserverRedaction`, admin viewers): `arguments` emptied, in the raw `tools/call` body too, `rationale` and `intent.declared.text` cut to 80 chars. The log itself is bounded by `XRAY_MAX_LOG_BYTES` (256 MiB) as well as rows and hours: the oldest whole events go, on every write batch.

### Intent, exactly (`src/tools/registry.ts`, `src/tools/rationale.ts`, `src/tools/intent.ts`)

| Fact | Detail |
|---|---|
| `intent.declared` / `intent.missing` timing | Emitted first thing in the registry's `call()`: **before** the feature-flag check, the scope check, schema validation and the handler. A call that is about to be refused still records what the model said it was doing (A-06, ADR-8). |
| `intent.declared` payload | The `rationale` verbatim, cut at `RATIONALE_MAX_LENGTH` (1024, `src/contracts/tools.ts`) with `truncated` saying so, plus the `tool` it arrived on. `intent.missing` carries the `tool` and why (`absent` / `empty` / `wrong_type`). The copy on `tool.call.started` is the raw argument, capped later by the emitter at `MAX_RATIONALE_CHARS` (8192). |
| `intent.inferred` timing | Emitted **after** the handler returned, and only when the label changed since the session's last emission or the tool was a closing one (`clear_table`, `lock_or_unlock_card`, `create_transfer`); a closing tool with the same label and the same `tools[]` as the last emission is skipped. |
| `intent.inferred` scope | Session-level: keyed on `xs` (falling back to `grant_id`), carries **no `tool` field**, only the `tools[]` sequence it scored (the remembered history, capped at `intentHistoryLength` 8, plus the tool just called). It changes nothing about the call and the model is never told. |
| `confidence` | `min(0.95, max(0.4, 0.4 + 0.45 * margin))` rounded to 2 dp, where `margin` is how far the winning workflow scored ahead of the runner-up, over the winner's score. `margin` is in 0..1, so the ceiling never binds: the only reachable values are `0.2` (`unknown`, nothing scored) and `0.40`-`0.85`. It is a margin, not a probability, and reads as an accuracy the classifier never claimed when it is rendered as one, so the dashboard prints `scored <n>` (episode header, the classifier step inside a call, panel 6), never a percentage. |
| The `rationale` never gates | It changes no server behaviour: nothing is refused, ordered, routed or rate-limited by it. It is stripped from the arguments the handler receives. |
| The one place it travels | On `lock_or_unlock_card` and `create_transfer` it is passed to `bank-core` and stored verbatim on the audit entry (`AuditEntry.rationale`) as the reason for the write (invariant 16). This is the only place the model's prose outlives the call. |

## 4. Sessions and correlation (`src/mcp/sessions.ts`)

- `xs` is server-minted (`xs_<time36><counter36>`) and keyed on `grant_id`; no `Mcp-Session-Id`, no session map keyed on one (invariant 6). The manager holds at most 5000 grants.
- Every event one `tools/call` causes - `tool.call.*`, `intent.declared` / `intent.missing` / `intent.inferred`, `bank.op`, `etl.*`, `sql.*`, `auth.stepup.requested` - carries that call's JSON-RPC id as `request_id`. The dashboard keys a call on `<xs>#<request_id>` (`callKeyOf` in `public/catalogue.js`), so a child event carrying any other id would not nest inside its call.
- First authenticated request of a grant -> `session.started {first_request}`. A request after more than `XS_IDLE_GAP_MINUTES` (15; env, 1-1440) of silence closes the segment (`session.ended {idle_gap, idle_ms}`) and starts a new `xs` (`session.started {idle_gap}`), carrying `client`, `protocol_version` and `era` forward (A-27).
- `initialize` inside a live segment increments `initialize_count` and emits `session.initialized`; it never starts a new `xs`, so a reconnect loop is one session with many initializations.
- A sweep every 60 s (`SESSION_SWEEP_INTERVAL_MS`) closes idle segments; `shutdown` closes every segment with `session.ended {server_stopping}` and every open call with `tool.call.cancelled {server_stopping}`.
- Logins and grants: `login_id` comes from the 30-day `login_id` cookie. A step-up extends the same grant (`auth.grant.updated {step_up}`); any other re-consent mints a new grant with `parent_grant_id` (`auth.grant.created`). The dashboard groups by login, then grant, so one human's history is never split.
- Pairing (`src/xray/pairing.ts`): `xray_get_session_link` mints `BANK-XXXX-XXXX-XX` (32-letter alphabet without `0 O 1 I`, 50 bits), bound to the login, valid `PAIRING_CODE_TTL_HOURS` (24), multi-use, URL `<PUBLIC_BASE_URL>/xray/s/<code>`. Only the hash is kept, in an in-memory LRU of 10,000 that a restart empties. The exchange sets cookie `xray_viewer`: a JWT `typ: viewer` with `{login_id, viewer_kind}`, 24 h, `HttpOnly Secure SameSite=Lax Path=/`, which survives a restart. Failed exchanges are limited to `RATE_LIMIT_IP_PAIR_FAILURES` (5) per IP prefix per minute (`xray.pairing.rejected {rate_limited}`).
- Observer mode (D-5): `POST /xray/api/admin {token}` against `XRAY_ADMIN_TOKEN` sets the same cookie with `viewer_kind: admin` and no login; shares the failure limiter; 403 on a bad token. No public session picker exists (invariant 11).
- The public lane (D-26, `src/mcp/public-lane.ts`): a caller of `/public/mcp` has no grant, so it gets a pseudo one, `grt_pub_` + 12 hex of sha256 over its IP prefix and User-Agent, which keys its `xs` exactly like a real grant. Every event of the lane - `http.request`, `session.*`, `catalog.tools_listed`, `tool.call.*`, `intent.declared` / `intent.missing`, `bank.op {public.*}` - carries `login_id: "lgn_public"` (`PUBLIC_LOGIN_ID`) and no `persona_id`. No `auth.*` event: nothing is granted. The hash groups one agent's calls and gates nothing (A-29); two agents behind one egress and one User-Agent are one visitor (A-48).

## 5. SSE transport (`src/xray/sse.ts`; constants in `xray-api.ts`)

- `GET /xray/api/stream?xs=<id>` | `?login=me` | `?all=1` (admin cookie only, else 403). No query = the viewer's login, or everything for an admin. A pairing viewer may name only an `xs` its login owns.
- Headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`; socket timeout 0. Frame (`renderStreamFrame`): `event: xray` / `id: <event id>` / `data: <envelope JSON>`. `retry: 2000` (`SSE_RETRY_MS`) on open; a `: ping` comment every `SSE_HEARTBEAT_MS` (20 s).
- Open order: subscribe, flush the emitter, replay, go live and drain - no gap and no duplicate across the 60-minute Cloud Run cut (invariant 3).
- Replay: `Last-Event-ID` header (or `?last_event_id=`) -> every event with a greater `id` that the scope may see, in chunks of 500, at most `MAX_REPLAY_EVENTS` (20,000); with no cursor, the last `INITIAL_REPLAY` (200). Source: the SQLite log, or the in-memory ring (`RING_BUFFER_SIZE` 10,000 events, 48 MB budget) when the log is degraded.
- Backpressure: per-subscriber queue of `MAX_SUBSCRIBER_QUEUE` (1000 frames) / 4 MB; overflow drops frames, then one id-less `xray.dropped {dropped_count}` frame tells the browser, whose cursor stays on the last real event so the automatic reconnect backfills.
- `?lane=public` (v0.7) streams the public lane with no cookie: the `public` reader sees `lgn_public` only, verbatim.
- Caps: `XRAY_MAX_STREAMS` (64 per process), `XRAY_MAX_STREAMS_PER_LOGIN` (4; all admins share one bucket) and `XRAY_MAX_PUBLIC_STREAMS` (16, every public reader together) -> 429 `too_many_streams`, `Retry-After: 5`.
- Lifecycle: `xray.viewer.connected {filter, last_event_id, replayed}` on open; `xray.viewer.disconnected {reason}` on close; `shutdown` closes every stream with `server_cut`. Admin streams pass through `applyObserverRedaction`.
- Storage: append-only `events` table at `XRAY_DB_PATH` (WAL, incremental auto-vacuum). A retention job every 10 min deletes rows older than `XRAY_RETENTION_HOURS` (72), trims to `XRAY_MAX_LOG_ROWS` (200,000) and reclaims pages. The read model is rebuilt from the last 5000 events on boot.

## 6. HTTP read model (`src/xray/routes.ts`; types in `src/contracts/xray-api.ts`)

| Route | Auth | Response |
|---|---|---|
| `GET /xray/`, `/xray/assets/*`, `/xray/fixtures/events.jsonl` | none | Static `public/` behind the router (`express.static`; `_dev/` and `__tests__/` answer 404; `.html` and `.jsonl` are `no-cache`). |
| `GET /xray/s/:code` | pairing code in the path; failure limiter | Sets `xray_viewer`, 302 to `/xray/`. Failure: 400 `malformed`, 404 `unknown_code`, 410 `expired`, 429 `rate_limited`, as HTML or JSON by `Accept`. |
| `POST /xray/api/pair {code}` | pairing code in the body; failure limiter | `PairResponse {ok: true, viewer_kind, login_id, expires_at}` plus the cookie. |
| `POST /xray/api/admin {token}` | admin token; failure limiter | `PairResponse` with `viewer_kind: admin`, `login_id: null`; 403 `forbidden`. |
| `GET /xray/api/me` | viewer cookie | `ViewerMeResponse {viewer_kind, login_id?, grant_ids?, persona?, expires_at}` (`grant_ids` and `persona` absent for admin). |
| `GET /xray/api/sessions[?xs= / login=me / all=1]` | viewer cookie | `XraySessionsResponse {data: XraySessionSummary[], page: {next: null}}`. |
| `GET /xray/api/sessions/:xs` | viewer cookie; the login must own `xs` (403) | `XraySessionDetailResponse {session, grant: XrayGrantFacts?, catalog: XrayCatalogSnapshot?, availability[], counters}`; 404 `not_found`. |
| `GET /xray/api/sessions/:xs/events?after=&limit=` | viewer cookie | `XraySessionEventsResponse {data: XrayEvent[], page: {next}}`; `limit` default 200, max `MAX_EVENTS_PAGE_LIMIT` (500); `next` = last id when the page is full. |
| `DELETE /xray/api/sessions/:xs` | pairing cookie only; the login must own `xs` | Erases that session from the log, the ring and the read model. `XrayDeleteResponse {deleted, sessions, scope: "session"}`; 403 for a stranger's or an unknown `xs`, 403 in observer mode (v0.4). |
| `DELETE /xray/api/events` | pairing cookie only | The same for every session of the login; `scope: "login"` (v0.4). |
| `GET /xray/api/sessions/:xs/bank` | viewer cookie; same ownership rule as the session detail | `XraySessionBankResponse {xs, login_id, persona, currency, as_of, accounts[], total_cash_cents, total_available_cents, total_credit_owed_cents, net_position_cents, cards {total, active, locked, fraud_locked}, transfer_limit_cents}` on the login's overlay; 404 `not_found` / `no_persona`, 503 `unavailable` when no bank is wired (v0.3). |
| `GET /xray/api/catalog?xs=` | viewer cookie | `XrayCatalogSnapshot {xs, content_hash, captured_at, event_id, tools, availability, feature_flags}`; 400 without `xs`, 404 before a listing. |
| `GET /xray/api/stream` | viewer cookie | SSE, section 5. |
| `GET /xray/api/export[?xs= / login=me / all=1][&after=]` | viewer cookie, or `Authorization: Bearer <XRAY_ADMIN_TOKEN>` (failure limiter) | JSONL, one stored envelope per line, oldest first (`XRAY_EXPORT_CONTENT_TYPE`, the line format of `test/fixtures/events.jsonl`), as an attachment named `glass-bank-xray-<UTC stamp>.jsonl`. Every event the scope may read with `id > after`, up to the newest id when the request arrived; the admin gets the log as stored (raw headers, bodies and addresses included), a pairing or public-lane reader the redacted view (D-28). Holds a stream slot while it runs (429 + `Retry-After: 5`); wrong bearer 403 (v0.8, D-27). |
| other `/xray/api/*` | - | 404 `not_found`. |
| `GET /health` (alias `/healthz`, unreachable through Cloud Run's front end) | none | `HealthzResponse {status: "ok", boot_id, version, origin_policy, uptime_s}` (app block). |

The public lane (v0.7, D-26): every `GET` above except the pairing and admin exchanges also answers `?lane=public` with no cookie, as the `public` reader of `PUBLIC_LOGIN_ID` (a cookie sent along is ignored). Another login's `xs` and `all=1` -> 403; both `DELETE` routes -> 403; `me` -> `{viewer_kind: "public", login_id: "lgn_public", grant_ids, persona: null}`; `sessions/:xs/bank` -> 404 `no_persona`.

Errors are `{error, message}` (`XrayErrorResponse`); no cookie -> 401 `unauthorized`. Every event leaves through `viewEvent` (admin responses also through `applyObserverRedaction`), except the admin export, which is the operator's verbatim copy (D-27, D-28). `XraySessionSummary`: `xs, login_id, grant_id, parent_grant_id, persona {id, name, kind, shared}, client, protocol_version, era, started_at, last_seen_at, initialize_count, call_count, error_count, token_expires_at, boot_id`. `XrayGrantFacts`: `grant_id, parent_grant_id, login_id, scopes, auth_level, client_id (hash), client_name, client_reconstructed, created_at, expires_at, revoked`. `XraySessionCounters`: `events, calls, errors, protocol_errors, tables_loaded, queries, bank_operations`.

## 7. Dashboard panels (`public/`, flat ES modules, no framework or bundler)

`index.html` mounts `#gate` (the connect screen) and `#app` = header, banner slot, now strip, Sessions aside, Live timeline, one tabbed detail panel. `app.js` owns the view state and repaints; `store.js` is the reducer; `stream.js` the live and fixture sources; `api.js` the routes and `?` switches; `catalogue.js` the per-type labels and summaries; `chain.js` derives the episodes and what flowed from one call into the next; `panel-call.js` draws one call as a row and as three panes, from the data `hops.js` derives; `open-state.js` holds what is open and the depth; `provenance.js` answers who authored what; `json-view.js` draws every JSON blob as a collapsible tree.

| File | Panel | Fed by |
|---|---|---|
| `panel-connect.js` | Connect: pairing-code form, "Watch the public lane" (`?lane=public`, D-26), stream-drop banner, viewer identity chip (`public lane` for the public reader). | `/xray/api/me`, `/xray/api/pair`, stream state |
| `panel-sessions.js` | 1 Sessions: grouped by login then grant, `parent_grant_id` lineage, `boot_id` restart chip, token expiry; `lgn_public` headed "Public lane" and each visitor labelled as a hash, never as a consent. | `/xray/api/sessions`, `session.*`, `auth.grant.*`, `server.started` |
| `panel-timeline.js` | 2 Live timeline, two modes (`view.timelineMode`): `chain` (default) groups the calls into episodes and threads and draws each call as one spine line that opens in place (below), with one-line context rows between episodes (40 episodes drawn); `events` draws one row per event (400 drawn), newest last, with a latency bar. Filters (`/`), pause and jump-to-live serve both; the depth control, `⇱ Collapse all` and the legend are chain mode only; unknown types still get a row. | every event |
| `panel-inspector.js` | 3 Call inspector (a spine row's `⤢` button, or a row in events mode): arguments with redaction markers, rationale, `_meta`, timings, result and size, error class; `bank/etl/sql/intent/auth.stepup` events with the same `request_id` nested; the call's `http.request` drawn as "Request as received" (`raw-request.js`: request line, Web Bot Auth callout, every header in order, body tree, socket peer); raw envelope fallback, with any field the contract does not map listed as "Unmapped fields" (`unmapped.js`, `contract-keys.js`). Every JSON blob here is a `json-view.js` tree, with Raw and Copy handing back exactly the bytes that arrived. | `tool.*` and correlated events |
| `panel-possibility.js` | 4 Possibility space: the listing the rows came from, the availability row per tool with "listed but not usable" made explicit (ADR-13), and per tool the descriptor as it was sent, with this browser's digest check (below). | `catalog.tools_listed`, `catalog.availability` |
| `panel-session-auth.js` | 5 Session and auth: initialize exchange, capabilities, `clientInfo` verbatim, HTTP facts, grant facts, auth events. | `session.*`, `auth.*`, `http.*` |
| `panel-intent.js` | 6 Intent: declared (the model's verbatim rationale) versus inferred (this server's session-level label with `scored <n>`, never a percentage), missing-rationale badge, the cannot-see list. | `intent.*` |
| `panel-sql-data.js` | 7 SQL and data: tables loaded and processed, every query with rows and duration, rejections, evictions, the live scratch schema. | `etl.*`, `sql.*` |
| `panel-errors-health.js` | 8 Errors and health: protocol versus tool errors, p50/p95 per tool, stream reconnects and drops, initialize-loop signal. | `protocol.*`, `tool.*`, `xray.*`, `http.*` |
| `panel-now-strip.js` | Now strip: the in-flight call's elapsed time against the 300 s budget, else the last completed call. | `tool.call.started` / `completed` |
| `panel-persona.js` | Persona card at the top of the Sessions aside: who is in the session, the money with the login's overlay applied (ADR-15), cards, transfer limit, the grant that authorised the calls. A public-lane session gets an "Anonymous visitor" card instead, with no balance request. | `GET /xray/api/sessions/:xs/bank`, `bank.op` |

### The spine of panel 2 (`panel-call.js`, `hops.js`, `open-state.js`)

A flat log makes every line look equally authored. Chain mode draws each call as one line that opens in place into REQUEST | INSIDE | RESPONSE and puts every value on the rail of the actor that authored it. Layout, keys, depths and the evidence, size and rationale-note rules: `docs/blocks/dashboard.md`. What feeds each part:

- **The row** (`renderCallRow`): `#<JSON-RPC id>`, the only number a call is counted by; the arguments of `tool.call.started` minus `rationale` (a `+rationale` chip, or `no rationale` on `intent.missing`, A-06); the head of the `tool.call.completed` preview with its size fact. Both halves are recorded bytes; page-derived captions sit only on connectors and thread heads.
- **REQUEST** (`requestHop`): the keys of `tool.call.started` in arrival order. The rationale is drawn once, where it arrived, with a page-rail locator naming the `catalog.tools_listed` that sent its schema (the ADR-8 sentence when that listing carried no `descriptor`) and a server-rail note from its `intent.declared` child. Nothing the server did on receipt is drawn here.
- **INSIDE** (`insideHop`): a pill opening to numbered steps, each naming its source event: the gate, each `bank.op` / `etl.*` / `sql.*` / `auth.stepup.requested` child, the audit hand-off (a `bank.op` carrying an `audit_id`), the classifier (`intent.inferred`). Its redesign and the Bytes drawer are task T5 (`docs/BUILD_PLAN.md` item 7).
- **RESPONSE** (`responseHop`): `tool.call.completed` or `tool.call.denied`, plus the `http.request` matched by JSON-RPC id (invariant 6), which is where a 403 step-up or a 429 shows its HTTP status. Ratios print at 5% or more of the 300 s budget or the 150,000-character content cap, never for the recording's 2,048-character preview cut. Both wire panes end in `rebuilt by this page from <event type> #N` and the raw envelope.
- **Depth and episodes** (`open-state.js`, `chain.js`): `Overview` / `Calls` (default) / `Open` / `Inside`, `⇱ Collapse all`, `Esc`; nothing is written to the URL yet (T11). Episode headers print the `intent.inferred` workflow with `scored <n>` and say on the page rail that the dashboard, not the server, did the grouping.
- **Who did what** (chain mode only): a legend chip sets `view.actorFocus` and dims the marks the other actors drew; a lens, not a filter, not persisted. Colours `--who-*` in `app.css`.

| Actor (`ACTORS`) | Label | Meaning |
|---|---|---|
| `agent` | client app | The program the model runs inside - Claude Code, the claude.ai app, Codex. It opened the connection, framed the request and holds the token. It never picks a tool. |
| `model` | model | The model itself: it picked the tool, wrote every argument, wrote the `rationale` and wrote the SQL. Stored word for word. |
| `server` | this server | This bank server: it checked the token and the scopes, dropped what it refuses to keep, recorded the stated intent and framed the answer. It decides; it does not execute. |
| `engine` | our engine | What actually ran: `bank-core` and the per-grant scratch SQL database. |
| `page` | this page | Worked out in the browser from the events. Never something the server recorded, and always labelled. |

### The descriptor card of panel 4 (`panel-possibility.js`, `ui.toolDescriptorCard`)

The listing header names the `catalog.tools_listed` the rows came from (`N of M sent`; its `content_hash` covers names, scopes and flags, not wording or schemas). An opened tool shows its `descriptor` as sent, the `rationale` parameter in the `model` colour, and this browser's verdict from re-hashing `inputSchema` through `crypto.subtle` against the recorded `input_schema_hash`. No sentence says the model read a description (A-05). Rows, verdict wording and the pre-v0.5 fallback: `docs/blocks/dashboard.md`.

### Provenance rule (`actorOfEvent` in `provenance.js`)

Who originated what the event records. The table is static except the two payload-dependent rows.

| Event | Actor |
|---|---|
| `server.started`, `server.stopping` | server |
| `http.request` | agent |
| `auth.client.registered`, `auth.client.reconstructed` | agent |
| every other `auth.*` (`challenge`, `verified`, `rejected`, `grant.*`, `token.*`, `stepup.requested`, `login.created`) | server |
| `session.initialized` | agent |
| `session.started`, `session.ended`, `session.rejected` | server |
| `catalog.*` | server |
| `tool.call.started` | model |
| `tool.call.completed`, `tool.call.denied` | server |
| **`tool.call.cancelled`** | agent when `reason` is `client_cancelled`, else server (`timeout`, `server_stopping`) |
| **`protocol.error`** | server when `code` is `-32603` (our own internal error), else agent |
| `bank.op`, `etl.*`, `sql.*` | engine |
| `intent.declared`, `intent.missing` | model |
| `intent.inferred` | server |
| `xray.*` | server |
| an unknown type | server (the fallback) |

`page` never appears here: no event is authored by the browser, so anything wearing that colour is the dashboard's own reading.

`npx vitest run public/__tests__` covers the store, filters, panels and the copied contract constants. `node public/_dev/check-console.mjs` renders the fixture in headless Chrome over its own static server (`_dev/serve.mjs`, an auto-assigned DevTools port; `CDP_PORT` pins one) and fails on any console error.

## 8. Fixtures

- `test/fixtures/events.jsonl`: 200 validated events of one session: boot; 401, DCR, login, consent, first token; `session.started` and the first listing; `get_current_user`; load, process, query; a rejected `ATTACH`; a capped query; `clear_table`; `intent.inferred`; a call without rationale; a reconnect `initialize` inside the same `xs`; a protocol error; the 403 step-up; re-consent extending the same grant; `create_transfer` preview and confirm; `lock_or_unlock_card`; a refused unlock of a fraud-locked card; `xray_get_session_link` and a viewer pairing (one mistyped code); a second ETL cycle; the per-grant table cap; a refresh and an expired token; a stream overflow and `Last-Event-ID` reconnect; `server.stopping`, a restart marker (`server.started` with `restored_max_id`) and a new `xs` for the same grant; `get_tool_availability`; a final ETL cycle.
- Built by `npx tsx test/fixtures/build-events.ts` (monotonic ids, `seq` per `xs`, every line parsed with `XrayEventSchema` before writing; the JSONL is the committed artefact). `test/contracts/events-fixture.test.ts` validates every line and the scenes above.
- Contracts v0.5 (T7b): the full listings 21 and 178 carry `descriptor` rows built by `catalogRowsOf`, so their `input_schema_hash` is the real digest. Every `/mcp` `http.request` except the 202 notification carries its JSON-RPC id, so a call finds the HTTP row that carried it. Every result preview is whole except the capped `execute_query` at id 57: 8,417 characters, kept as the first 2,048 plus `…[truncated]`. What the recording still lacks: `docs/blocks/contracts.md` Known gaps.
- Served at `/xray/fixtures/events.jsonl` through the `public/fixtures -> ../test/fixtures` symlink. `?fixture=1` replaces the SSE client with `createFixtureSource` (`stream.js`): play, pause, step, skip to end, `?rate=` (default 20x), `?autoplay=all`; the dashboard clock follows the recording.
