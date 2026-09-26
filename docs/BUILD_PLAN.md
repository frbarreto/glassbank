# Build plan

Roadmap only. The tests and `docs/blocks/<block>.md` are the specification of what exists. New work starts from `docs/tasks/TEMPLATE.md`. Ids: `A-xx` and `D-x` in `docs/ASSUMPTIONS.md`, `ADR-x` in `docs/ARCHITECTURE.md`, `H-x` / `B-x` in the backlog below.

## Done

| Block / feature | What exists | Test entry point |
|---|---|---|
| `contracts` | v0.5 zod schemas: events (a `catalog.tools_listed` row may carry the descriptor the client was sent, built by `publishedToolDescriptor` for both `tools/list` and the record), 17-tool catalog (published and lenient schemas), bank and scratch-db interfaces, auth context, X-ray API, scopes; fakes in `src/testing/fakes.ts`; `test/fixtures/events.jsonl`, a truthful 200-event v0.5 recording | `npx vitest run src/contracts test/contracts` |
| `bank-core` | Deterministic seeded personas, `{data, page: {next}}` lists, copy-on-write overlays per login, card lock/unlock, transfer preview and confirm, audit entries, `bank.*` events | `npx vitest run src/bank-core` |
| `etl` | `load_*` -> `process_data` -> `execute_query` -> `clear_table` on a per-grant `:memory:` SQLite inside a forked `src/etl/sql-runner.ts` killed with SIGKILL on `QUERY_TIMEOUT_MS`; token-scan guard; per-grant, global and TTL caps; `etl.*` / `sql.*` events | `npx vitest run src/etl`; `npm run smoke:worker-sqlite` (6/6) |
| `tools` | All 17 handlers, listing and availability rules, `rationale` extraction, intent classifier, per-tool redaction deny-lists | `npx vitest run src/tools` |
| `mcp` | Stateless POST-only `/mcp`, bearer gate (401 challenge, 403 `insufficient_scope`), tools registered from the raw published schema, per-grant call rate limit, Origin/Host policy, `http.*` / `session.*` / `catalog.*` / `tool.*` / `protocol.*` events | `npx vitest run src/mcp` |
| `auth` | Hand-rolled OAuth 2.1 AS: DCR, PKCE, `txn` JWT browser pages, consent with grant extension, signed JWT code / access / refresh / viewer / login tokens, rotation and revocation, rate limits, PRM per `PUBLIC_HOSTS` entry | `npx vitest run src/auth` |
| `xray` | Emitter, redaction, ring buffer plus SQLite log, SSE with `Last-Event-ID` replay, REST read model, login-bound pairing codes, admin observer mode | `npx vitest run src/xray` |
| `dashboard` (`public/`) | Vanilla-JS SPA, twelve `panel-*.js` modules. Chain mode is a spine of one line per call (`panel-call.js`) that opens in place into REQUEST / INSIDE / RESPONSE (data from `hops.js`, each value attributed to one of five actors - client app, model, this server, our engine, this page - by `provenance.js`), with open state and a depth control (`open-state.js`: overview / calls / open / inside, Collapse all, Esc). The Possibility space opens each tool on the descriptor the client was sent and re-hashes its schema in the browser against the recorded digest. Fixture mode `/xray/?fixture=1`, pairing-code entry | `npx vitest run public` (280 tests); `node public/_dev/check-console.mjs`; `npm run build && npm run e2e:dashboard` (28 checks) |
| `app` | `src/composition.ts` injects every block (including the persona-card lookup), `src/server.ts` boots and flushes on SIGTERM, `src/config` reads every knob, `src/app.ts` sets `x-request-id` on the HTTP response only - the event `request_id` is the JSON-RPC id the dashboard nests a call's children on (invariant 6) | `npx vitest run src/__tests__ src/config`; `npm run e2e` (151 checks) |
| `infra` | `infra/Dockerfile`, `cloudbuild.yaml`, `bootstrap.sh`, `deploy.sh`, `smoke.sh`, `infra/local/` compose and cloudflared notes, `infra/vm/` alternative | `bash infra/smoke.sh http://localhost:8080` (23 passed, 3 skipped); `DRY_RUN=1 ./infra/deploy.sh` |
| Whole repository | 1295 tests in 60 files | `npm run check` |

## Remaining

Sequence decided on 2026-09-26 (D-20 to D-25); the plan with its gates is https://claude.ai/artifact/96Ze17Gp72eeVJeanxejXQ. Done on 2026-09-26: the first commit, tag `v0.1.0` and the public repository https://github.com/frbarreto/glassbank; both GCP bootstraps; the pipeline and its first deploy (revision `mcp-bank-00002-c4w`, image `aa7f30397e79`).

1. Hostname (`infra`): `infra/domain.sh` ran on 2026-09-26 (mapping and CNAME for `glassbank-mcp.abovethefog.app` created, certificate pending; `docs/DEPLOYMENT.md` section 16). Left: once `https://glassbank-mcp.abovethefog.app/health` answers, set the repository variable `PUBLIC_BASE_URL=https://glassbank-mcp.abovethefog.app` and redeploy (a push, or a dispatch with the current tag); the `run.app` host stays in `PUBLIC_HOSTS`.
2. Connect a claude.ai account (D-9 picks it), Claude Code and Codex to the live URL; complete OAuth and call a tool from each; record their `Origin`, headers, `clientInfo`, DCR body and discovery sequence in `docs/observations/claude-ai.md`.
3. Switch to `allowlist` (dispatch the pipeline with `origin_policy: allowlist`), reconnect the clients, smoke again. The uptime check and alert exist since 2026-09-26 (`infra/observe.sh`, `docs/DEPLOYMENT.md` section 17).
4. Independent of 1-3, finish the X-ray redesign (`dashboard`); its tasks and decisions D-17 to D-19 (`docs/ASSUMPTIONS.md`; D-A to D-C in the plan) live in the plan https://claude.ai/artifact/S5DVentLBvuqZfBi5SVfEp. Open: T5 the Bytes drawer (D-19) and per-key author marks in the JSON viewer (the INSIDE cards already render), T6 a connection block per session with episodes partitioned by `xs`, T10b that block reusing the descriptor card, T9 phone width, sticky toolbar and session strip, T11 deep link and repaint ceiling. Review follow-ups: `store.js` lets `catalog.availability` overwrite a catalog's `resolved_from` / `event_id`, so `hops.rationaleLocator` can name another session's listing on a shared hash; the fixture limits in `docs/blocks/contracts.md` Known gaps.

## Backlog

- H1 `etl`, `mcp`, `xray`, `app`: security review - SQL guard audit (ATTACH escape, identifier injection, runner-kill races), redaction audit, rate limits and caps tuned against real traffic (per-login grant cap, cost alerts), Origin policy review from real claude.ai traffic, 150k-character and 300 s budgets enforced and surfaced, SIGTERM under load, browser-page CSRF/framing review.
- H2 `auth`, `xray`, `infra`: restart tolerance - redeploy during a live claude.ai session (tokens survive, re-initialize succeeds, client reconstruction works, replay window of the consumed/revoked sets measured), `server.started` markers and `boot_id` on the dashboard, optional GCS snapshot/restore of the event log (D-6).
- H3 `test/`: Inspector CLI scripts for OAuth and every tool, contract tests (schemas versus docs), fixture-driven dashboard regression, chaos test (restart -> re-initialize), a full-year load timed inside the 300 s budget.
- H4 docs: generated `docs/contracts/*` from the catalog and event schema, per-block docs finalized, demo script, cost sheet.
- H5 `dashboard`: catalog diff between snapshots, raw JSON-RPC/HTTP frame view with JSONL export, mock core-banking audit panel, p50/p95 polish, empty and error states.
- B1 `auth`: CIMD behind `CIMD_ENABLED` (fetch-and-validate `https://` client ids with SSRF, size and timeout guards; metadata flags).
- B2 `mcp`: migrate the transport to v2 `createMcpHandler` for dual-era (2026-07-28) support (ADR-2 chose SDK 1.30.0).
- B3 `xray`, `infra`: split `xray` into its own Cloud Run service via an `HttpForwarder` emitter adapter; OpenTelemetry exporter from the same emitter.
- B4 `tools`, `bank-core`: more writes with Ramp's approval pattern (`approve_or_reject_transfer` with `thoughts` and verbatim `user_reason`, `pay_bill`, `update_card_limit`), attention feed, decline explanation; business-role scoping (D-11).
- B5 `etl`: DuckDB "analyst" read-only layer with catalog -> docs -> SQL gating (`docs_required`), Ramp 2026 pattern.
- B6 `auth`, `dashboard`: dashboard sign-in with the mock IdP (see all logins of a persona); lazy-auth mode with public reference tools.
