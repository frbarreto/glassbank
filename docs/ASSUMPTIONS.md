# Assumptions and open decisions

`A-xx` ids are cited from code and tests and are never renumbered. Status: **validated** = enforced by the
code or test named; **amended** = the original belief was measured wrong and only the current truth is
stated; **open** = needs a client or environment not exercised yet (no claude.ai or Claude Code client and
no GCP deploy so far; Codex connected through the cloudflared tunnel on 2026-09-09). `D-x` = user decision
(last section); `ADR-x` = `docs/ARCHITECTURE.md` section 9.

## 1. Protocol and client behaviour

| Id | Current belief | Status | Enforced / tested |
|---|---|---|---|
| A-01 | The protocol revision claude.ai negotiates is unknown; Codex sent `MCP-Protocol-Version: 2024-11-05` on its first `GET /mcp` and `2025-06-18` in `initialize`. | open | recorded per request by `src/mcp/index.ts`; `docs/observations/claude-ai.md` |
| A-02 | A stateless Streamable HTTP server (no `Mcp-Session-Id`, JSON responses, GET/DELETE on `/mcp` -> 405) is accepted by MCP clients; confirmed for the SDK client, Inspector CLI and Codex, not yet claude.ai or Claude Code. | open | `src/mcp/transport.ts`; `npm run e2e:oauth` |
| A-03 | `@modelcontextprotocol/sdk` 1.30.0 is enough for the demo; the SDK is confined to `src/mcp/transport.ts`, so a swap is a one-block task. | validated | eslint import rule; `test/import-boundaries.test.ts` |
| A-04 | claude.ai honours neither sampling nor elicitation, so confirmations are two-step tools (`create_transfer` preview, then `confirm`); Codex advertises `elicitation:{form,url}` but nothing here uses it. | open | `src/tools/handlers/writes.ts` |
| A-05 | Whether `InitializeResult.instructions` reaches the model is unknown, so every point in it is repeated in the tool descriptions. | open | `src/mcp/instructions.ts` |
| A-06 | `rationale` is `required` in the published JSON schema and optional (truncated to 1024) in the lenient server schema; tools are registered through `setRequestHandler` with the raw schema, so a missing `rationale` still runs the handler and emits `intent.missing`. | validated | `src/tools/rationale.ts`, `src/mcp/transport.ts`, `test/contracts/tool-catalog.test.ts` |
| A-07 | `process_data`, `execute_query` and `clear_table` carry `readOnlyHint: true` (scratch database only); `destructiveHint: true` is reserved for tools that mutate bank state. Whether claude.ai skips prompting on them is unobserved. | open | `src/contracts/tools.ts`, `src/tools/__tests__/catalog.test.ts` |
| A-08 | Tool failures come back as `isError: true` content with Ramp's wording, never as protocol errors. | validated | `src/tools/errors.ts`, `src/mcp/__tests__/protocol.test.ts` |
| A-09 | Tool names are snake_case (D-12); Ramp's hosted names may be PascalCase, which is irrelevant here. | validated | `test/contracts/tool-catalog.test.ts` |
| A-10 | Ramp publishes nothing about hosting, sessions or observability; the X-ray event model, dashboard, pairing and identity chain are entirely ours. | validated | - |
| A-27 | An X-ray session `xs` is a grant-scoped segment split after `XS_IDLE_GAP_MINUTES` (15) of silence; reconnect loops stay inside one `xs`. | validated | `src/mcp/sessions.ts`, `src/mcp/__tests__/sessions.test.ts` |
| A-28 | `clientInfo.name` / `title` are displayed verbatim and never gate behaviour. | validated | `src/mcp/sessions.ts`, `public/panel-session-auth.js` |
| A-29 | `User-Agent` is recorded and never filtered on; Anthropic's value is still unobserved. | open | `src/mcp/index.ts` |
| A-34 | The first claude.ai test uses an individual account, not an org-managed connector. | open (D-9) | `infra/local/cloudflared.md` |
| A-38 | `rationale` is on every tool, the three database tools included. | validated | `src/contracts/tools.ts`, `test/contracts/tool-catalog.test.ts` |
| A-40 | A write tool stays listed while unavailable (missing write scope); calling it yields `403` + `WWW-Authenticate: Bearer error="insufficient_scope"` with the still-needed scopes and the client re-runs authorization. Confirmed for the SDK client only. | open | `src/mcp/gate.ts`; `npm run e2e:session` |
| A-41 | The step-up popup shares the browser profile of the first consent, so the `login_id` cookie (`SameSite=Lax` for that reason) lets `/consent` extend the existing grant; without it a new grant is minted. | open for claude.ai | `src/auth/routes.ts`, `src/auth/__tests__/oauth-flow.test.ts` |
| A-42 | The browser-page protections (signed `txn` JWT, `SameSite=Strict` CSRF cookie, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Secure` + `HttpOnly`) do not break the OAuth popup; confirmed for Codex's loopback flow. | open for claude.ai | `src/auth/routes.ts` |

## 2. Auth

| Id | Current belief | Status | Enforced / tested |
|---|---|---|---|
| A-11 | Verification is stateless JWTs (`jti`, `typ`, `aud`; code 10 min, access 1 h, refresh 7 d read-only / 24 h read-write, viewer 24 h, txn 10 min, login 30 d) plus three in-memory sets (consumed codes, rotated or revoked refresh ids, revoked grants) evicted at `exp`; a restart reopens a replay window bounded by `exp` (D-14). | validated | `TOKEN_LIFETIMES_SECONDS` in `src/contracts/auth.ts`, `src/auth/store.ts`, `src/auth/__tests__/store.test.ts` |
| A-12 | The redirect-URI allowlist plus mandatory PKCE is the security boundary; DCR metadata lives in a bounded LRU persisted to `AUTH_DB_PATH`; an unknown `client_id` is reconstructed as a public client with the claude.ai callback plus the loopback URIs and `auth.client.reconstructed` is emitted. | validated | `src/auth/clients.ts`, `src/auth/client-db.ts`, `src/auth/__tests__/persistence.test.ts` |
| A-13 | Allowlist: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` (unverified), `http://localhost/callback` and `http://127.0.0.1/callback` on any port, `http://localhost:*/oauth/callback` outside production. Codex registers `http://127.0.0.1:<port>/callback`. | validated for Codex and Inspector; claude.ai open | `src/contracts/auth.ts`, `src/auth/clients.ts` |
| A-14 | Personas are passwordless public demo identities: three shared seeded personas or a fresh `per_<seed>` demo customer; the login page states that every record is fake; a write on a shared persona lands in the caller's per-login overlay (ADR-15). | validated | `src/bank-core/personas.ts`, `src/auth/pages.ts`, `src/bank-core/__tests__/layering.test.ts` |
| A-16 | Cloud Run IAM is public (`--allow-unauthenticated`); every end-user check is MCP OAuth. | open (not deployed) | `infra/deploy.sh`, `infra/smoke.sh` |
| A-17 | Absent `Origin`, `https://claude.ai`, `https://claude.com` and our own origin are allowed; other browser origins are rejected only in `allowlist` mode; `ORIGIN_POLICY=log-only` until claude.ai's value is observed (Codex sends none). | open | `src/mcp/gate.ts`, `src/mcp/__tests__/gate.test.ts` |
| A-26 | Ramp's idle expiry (7 d read-only / 24 h read-write) is the refresh-token lifetime chosen by `auth_level`, renewed on each rotation. | validated | `refreshLifetimeSeconds` in `src/contracts/auth.ts`; `src/auth/index.ts` |
| A-37 | CIMD is not advertised (`CIMD_ENABLED=false`) until DCR is observed from claude.ai, Claude Code and Inspector. | open | `src/auth/metadata.ts`, `src/auth/__tests__/metadata.test.ts` |

## 3. Data, tools and SQL

| Id | Current belief | Status | Enforced / tested |
|---|---|---|---|
| A-22 | USD with integer cents, neutral English names, ACH / wire / internal rails; `get_currencies` lists USD first (D-1). | validated | `AMOUNT_DESCRIPTION` in `src/contracts/tools.ts`; `src/bank-core/categories.ts` |
| A-23 | About 2,000 transactions per persona over 12 months; a full-year load succeeds and `load_*` never returns rows; Ramp's `{data, page: {next}}` envelope is walked to the end with `maxPagesPerLoad` as the stop. | validated | `src/bank-core/seed.ts`, `src/tools/rows.ts`, `src/bank-core/__tests__/seed.test.ts` |
| A-31 | Ramp's 43-entry merchant category table (ids 1-44, 22 missing) is the taxonomy, copied verbatim. | validated | `src/bank-core/categories.ts` |
| A-33 | Business-role scoping is deferred (D-11): personas have a `kind` but no role gating; `authorization_level_not_allowed` is reserved for it. | validated | `src/tools/__tests__/registry.test.ts` |
| A-35 | Fidelity targets Ramp's design, not its live API: the OSS repo is archived and two of its endpoints no longer exist. | validated | - |
| A-39 | `worker.terminate()` cannot stop a statement that never yields a row to JavaScript and `better-sqlite3` 13.0.3 exposes no `sqlite3_interrupt`; the SQL timeout is therefore enforced by a forked `src/etl/sql-runner.ts` process (pool of `ETL_WORKER_POOL_SIZE`) that the parent `SIGKILL`s at `QUERY_TIMEOUT_MS`; model SQL never runs on the main event loop. | amended | `src/etl/runner-pool.ts`, `src/etl/__tests__/timeout.test.ts`, `npm run smoke:worker-sqlite` (6/6) |

## 4. Runtime and hosting

| Id | Current belief | Status | Enforced / tested |
|---|---|---|---|
| A-15 | One pinned Cloud Run instance; a restart loses scratch tables, the ring buffer, the event log, the token sets, the DCR table and every bank write (per-login overlays); `server.started` and the `boot_id` from `get_current_user` make it visible. | validated locally; cloud open | `src/tools/handlers/meta.ts`, `src/contracts/events.ts` |
| A-18 | Node 22 (`node:22-slim`) with prebuilt `better-sqlite3` binaries builds and runs; Node 23.10 on the Mac works too. | validated | `infra/Dockerfile`; `npm run check` |
| A-19 | `--concurrency=250` and 20 s SSE heartbeats suffice for a few viewers plus MCP traffic. | open | `infra/deploy.sh` |
| A-20 | About US$47/month for an always-on 1 vCPU / 1 GiB instance is accepted over a cheaper VM (D-2). | open | `infra/vm/README.md` |
| A-21 | Two micro-apps in one process is acceptable; the mitigation is a thin `xray` block and an emitter that never throws. | validated | `src/xray/emitter.ts` |
| A-25 | The event log is a WAL SQLite file at `XRAY_DB_PATH` (`/tmp/xray.sqlite`, memory-backed on Cloud Run) and is lost on restart; `SNAPSHOT_BUCKET` is parsed but unused (D-6). | validated | `src/xray/log.ts` |
| A-30 | Images go to the existing `lake-fraude` Artifact Registry repository; the `laf-ingestor` VM stays terminated (D-7). | open (not deployed) | `infra/bootstrap.sh`, `infra/deploy.sh` |
| A-36 | The service answers on several hostnames (`PUBLIC_HOSTS`: both `run.app` forms in the cloud, the tunnel host locally); issuer, PRM `resource`, `aud` and the `resource_metadata` challenge derive from the validated request `Host`; `PUBLIC_BASE_URL` is the fallback and the pairing-URL base. | validated through the tunnel | `src/auth/metadata.ts`, `src/auth/verify.ts`, `infra/smoke.sh` |
| A-43 | Express `trust proxy` yields the client IP; per-IP limits are sized for Anthropic's shared `160.79.104.0/21` egress (`RATE_LIMIT_IP_REGISTER=60` per hour, `RATE_LIMIT_IP_AUTHORIZE=300` per 15 min); `/token` is also keyed by `client_id` / `grant_id`; the SDK auth router is not used. | validated locally | `src/app.ts`, `src/auth/index.ts`, `src/auth/rate-limit.ts`; `infra/smoke.sh` check 9 |
| A-44 | Bounded LRUs (`MAX_DCR_CLIENTS`, `MAX_MATERIALISED_PERSONAS`, `MAX_PERSONA_OVERLAYS`, `MAX_SCRATCH_DBS`, `RATE_LIMIT_LOGIN_GRANTS`) keep a 1 GiB singleton bounded and every eviction is an event; the defaults in `.env.example` are untuned. | open (no load test) | `src/bank-core/lru.ts`, `src/etl/scratch-db.ts`, `src/auth/clients.ts` |

## 5. X-ray and dashboard

| Id | Current belief | Status | Enforced / tested |
|---|---|---|---|
| A-24 | Dashboard access is a login-bound pairing code `BANK-XXXX-XXXX-XX` (50 bits, 24 h, failed exchanges rate-limited per IP) swapped for a viewer JWT cookie, or the admin token in redacted observer mode; there is no public session picker. | validated | `src/contracts/auth.ts`, `src/xray/pairing.ts`, `src/xray/__tests__/pairing.test.ts` |
| A-32 | MIT, like Ramp's OSS server (D-8). | validated | `LICENSE`, `THIRD_PARTY_NOTICES.md` |

## Decisions

Settled by the user on 2026-09-08 except D-9; changing one is a change request in `docs/contracts/CHANGES.md`.

| # | Decision | Outcome |
|---|---|---|
| D-1 | Currency and locale | USD, integer cents, neutral English names, ACH / wire / internal rails |
| D-2 | Hosting | Cloud Run (`mcp-bank`, `lake-fraude`, `us-central1`) with a local-first workflow; `infra/vm/` kept as a working alternative; nothing deployed yet |
| D-3 | Write tools | On: `FEATURE_FLAGS=writes;transfers`; `lock_or_unlock_card` and `create_transfer` listed from day one |
| D-4 | Persona model | Three shared seeded personas plus "create a demo customer" |
| D-5 | Observer mode | Yes, behind `XRAY_ADMIN_TOKEN`, redacted |
| D-6 | Event-log persistence | Live-only; `SNAPSHOT_BUCKET` reserved, not implemented |
| D-7 | GCP housekeeping | Reuse the `lake-fraude` Artifact Registry repository; leave `laf-ingestor` terminated |
| D-8 | License | MIT plus `THIRD_PARTY_NOTICES.md` |
| D-9 | First live client | **Open.** Codex (OpenAI, `codex-mcp-client/0.153.4`) connected through the cloudflared tunnel on 2026-09-09 and ran the full load -> process -> query -> clear flow; ChatGPT has also connected through the tunnel (owner report, not recorded); claude.ai has not connected. |
| | | Someone with an individual claude.ai account (Free, Pro or Max; one custom connector on Free) has to add the connector and finish the OAuth popup; Claude Code and Inspector can be driven from this machine. |
| D-10 | Repository hosting | Local git on `main`, no remote; deploys run from the Mac |
| D-11 | Business-role scoping | Deferred (A-33) |
| D-12 | Tool naming | snake_case |
| D-13 | Writes on shared personas | Copy-on-write per login (ADR-15) |
| D-14 | Auth state after a restart | Accept the bounded replay window (A-11) |
| D-15 | Rate-limit and cap defaults | Ship the `.env.example` defaults; tune from real traffic |
| D-16 | Name | Glass Bank; the Cloud Run service stays `mcp-bank` |
| D-17 | X-ray layout | A vertical, append-only spine: one line per call that opens in place into REQUEST / INSIDE / RESPONSE; no free 2D canvas |
| D-18 | Actor-band board | Retired; its claims live in the triptych and the INSIDE cards |
| D-19 | Call inspector | Becomes a Bytes drawer of raw envelopes only (task T5, not built yet) |
