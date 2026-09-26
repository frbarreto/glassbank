# CLAUDE.md - Glass Bank

A public remote MCP server for a fictional bank plus a live X-ray dashboard. Any MCP client (a claude.ai custom connector, Claude Code, Codex, MCP Inspector) connects over OAuth 2.1 with a mock login, uses Ramp-style tools (`load_*` -> `process_data` -> `execute_query` -> `clear_table`, two guarded write tools) and can watch everything the server observes at `/xray`. All bank data is fake and seeded deterministically. One npm package, TypeScript ESM, one Node process, one Cloud Run service pinned to one instance, deployed by GitHub Actions on every push to `main` and deleted between demos.

**State (2026-09-26):** **deployed, paused between demos.** Cloud Run service `mcp-bank` in `lake-fraude`, deployed by `.github/workflows/pipeline.yml` on every push to `main` of https://github.com/frbarreto/glassbank (private, no branch protection, D-20 to D-25). `make pause` deletes the service when no demo is planned and `make resume` recreates it in about 45 s; when up, it is live at `https://glassbank-mcp.abovethefog.app` (landing page at `/`, MCP at `/mcp`, dashboard at `/xray/`, status at `/health`; D-25; the `run.app` hostnames also answer), `ORIGIN_POLICY=log-only`, contracts v0.6, uptime check and email alert on `/health`. Codex and ChatGPT connected earlier through a tunnel (`docs/observations/claude-ai.md`); no claude.ai client yet. Next steps (real clients, `allowlist`, the open X-ray redesign tasks): `docs/BUILD_PLAN.md`.

## Documents (read only what the task needs)

| Need | Read |
|---|---|
| Run it, log in, call tools, watch a session | `docs/LOCAL_TESTING.md` |
| Blocks, stack, auth sequence, ADRs | `docs/ARCHITECTURE.md` |
| Directory tree, ownership, import rules, doc templates | `docs/REPO_LAYOUT.md` |
| One page per block: files, interface, events, tests, gaps | `docs/blocks/<block>.md` |
| Tool catalog, scopes, the `rationale` convention | `docs/TOOL_CATALOG.md` |
| Event catalogue, SSE, dashboard routes and panels | `docs/XRAY_EVENT_MODEL.md` |
| Deploy, CI/CD, pause and resume, hostname, monitoring, every env knob | `docs/DEPLOYMENT.md` |
| Roadmap and backlog | `docs/BUILD_PLAN.md` |
| Assumptions `A-xx` and user decisions `D-x` | `docs/ASSUMPTIONS.md` |
| Ramp lineage and copied fragments | `docs/RAMP_REFERENCE.md`, `THIRD_PARTY_NOTICES.md` |
| Contract change log and open proposals | `docs/contracts/CHANGES.md` |
| What real clients actually sent | `docs/observations/claude-ai.md` |
| Build history (evidence only, not maintained) | `docs/archive/` |

Ids: `A-xx` assumption, `D-x` user decision, `ADR-x` architecture decision. Always cite the prefix.

## Blocks

`contracts`, `app` (`src/app.ts`, `src/composition.ts`, `src/server.ts`, `src/config/`), `auth`, `mcp`, `tools`, `bank-core`, `etl`, `xray`, `dashboard` (`public/`), `infra` (`infra/`, `.github/`, `Makefile`). Each block exports one factory `create<Block>(deps)`; `app` wires everything by injection; no global mutable state outside the composition root.

- Import rules (ESLint-enforced): a block imports only `src/contracts`; `mcp` may also import `tools`; only `mcp` imports the MCP SDK; only `auth` and `xray` import `jose`; only `auth`, `etl` and `xray` import `better-sqlite3`; the dashboard talks HTTP only.
- Contracts are append-only: never rename or remove an event type, tool, scope, field or route. Propose additions in `docs/contracts/CHANGES.md`.
- One task edits one block. `src/contracts`, the `app` files, `package.json` and `CLAUDE.md` change only in a task that names them.

## Commands (every line verified on 2026-09-09; `check`, `e2e`, `e2e:dashboard` and `check-console` re-verified 2026-09-14/15; `check`, the local `smoke.sh`, every `infra/*.sh`, `make pause` / `make resume` and the pipeline verified 2026-09-26)

```
npm ci                        # Node 22 (.nvmrc); 23 works
npm run dev                   # tsx watch, http://localhost:8080
npm run check                 # tsc + eslint + vitest: 1296 tests / 60 files - the definition of green
npx vitest run src/<block>    # one block; the dashboard is `npx vitest run public`
npm run build && npm start    # what the container runs (dist/server.js)
npm run login [-- --write]    # OAuth handshake in the browser; writes .glass-bank-token.json
npm run e2e                   # 55 + 96 checks against a real server: OAuth walk, then session walk
npm run e2e:dashboard         # 28 checks: a real browser paired to a real session, ending in an erase (needs Chrome; boots dist/, so build first)
npm run smoke:worker-sqlite   # 6/6: proves the SQL timeout mechanism of invariant 8
bash infra/smoke.sh http://localhost:8080   # 24 pass / 0 fail / 3 skip with the default env
node public/_dev/check-console.mjs          # the dashboard in headless Chrome over the fixture
docker compose -f infra/local/docker-compose.yml up --build   # the shipped image
cloudflared tunnel --url http://localhost:8080   # then restart with PUBLIC_BASE_URL = tunnel URL and PUBLIC_HOSTS = '<tunnel host>;localhost:8080'
DRY_RUN=1 ./infra/deploy.sh   # prints every gcloud command; `make deploy` and `make smoke` run for real (the manual fallback)
DRY_RUN=1 ./infra/ci-bootstrap.sh   # the GitHub Actions deployer service account (ran for real 2026-09-26)
make pause / make resume      # stop the bill (alert off, service deleted; pushes then skip the deploy) / redeploy the newest image, alert on (infra/pause.sh)
DRY_RUN=1 ./infra/domain.sh   # the hostname mapping + its CNAME (ran for real 2026-09-26); `./infra/domain.sh status` shows the certificate
DRY_RUN=1 ./infra/observe.sh  # uptime check + email alert on /health (ran for real 2026-09-26)
git push origin main          # runs .github/workflows/pipeline.yml: check, e2e, image, deploy + smoke (D-23)
```

Dashboard: `http://localhost:8080/xray/?fixture=1` replays a recorded session; a connected client can call `xray_get_session_link` and open the `BANK-XXXX-XXXX-XX` link it returns.

## Invariants (numbers are stable; code and docs cite them)

1. **`--max-instances=1` is correctness**: scratch SQLite, the event ring buffer and SSE fan-out are in-process.
2. **`--no-cpu-throttling`**: heartbeats, TTL eviction and fan-out run with no request in flight.
3. **`--timeout=3600`**, SSE heartbeat every 20 s, `Last-Event-ID` replay on the dashboard stream; never `--use-http2`.
4. **Single origin**: `/mcp`, `/.well-known/*`, `/authorize`, `/token`, `/register`, `/revoke`, `/xray/*` on one host. `PUBLIC_HOSTS` lists every hostname served; the PRM `resource`, issuer and `aud` follow a listed request `Host`, otherwise `PUBLIC_BASE_URL`.
5. **Cloud Run IAM is public; auth is MCP OAuth.** Unauthenticated -> `401` + `WWW-Authenticate`, never `200` + `isError`. The bearer gate runs before the SDK: a `tools/call` missing its scope -> `403 insufficient_scope` naming every missing scope.
6. **Stateless transport**: no `Mcp-Session-Id`, no session map, GET/DELETE `/mcp` -> 405. Everything is keyed on `grant_id`; `xs` is server-minted by idle gap; `login_id` groups grants. `request_id` on every event is the call's JSON-RPC id, including on everything a tool causes (`bank.*`, `etl.*`, `sql.*`, `intent.*`), because the dashboard nests a call's children on `<xs>#<request_id>`; never the HTTP `x-request-id`. `prompts` and `resources` are declared empty and answer empty lists.
7. **JWTs only** (`code`, `access` 1 h, rotating `refresh`, `viewer`, `txn`, `login`, each with `jti` and `typ`), verified statelessly plus in-memory consumed/revoked sets evicted at `exp` (A-11). Never log or store tokens, codes or verifiers.
8. **SQL guard**: one `:memory:` DB per grant, run in a forked `src/etl/sql-runner.ts` that is `SIGKILL`ed at `QUERY_TIMEOUT_MS` (`worker.terminate()` cannot stop native SQLite). A token scan on both sides of the IPC channel rejects ATTACH, DETACH, PRAGMA, VACUUM and multi-statement input; plus `PRAGMA query_only=1`, `Statement.readonly`, quoted identifiers, a 100-row cap, per-grant table cap, global LRU and TTL.
9. **Every tool**: snake_case <= 64 chars, `title`, exactly one of `readOnlyHint` / `destructiveHint`, `openWorldHint: false`, a description per parameter, `rationale` required in the published schema and optional server-side (registered from the raw schema on the low-level `Server`; a missing value emits `intent.missing`), a redaction deny-list. Write tools are listed whenever their flag is on; hide only for a missing read scope or flag.
10. **Origin policy**: absent allowed; `https://claude.ai`, `https://claude.com` and our own origin allowed; `allowlist` rejects other browser origins, `log-only` (current) only records. Switch to `allowlist` only after real claude.ai Origin values are recorded.
11. **Dashboard privacy**: a viewer sees only their login's grants (pairing code `BANK-XXXX-XXXX-XX`, 50 bits, rate-limited exchange, signed viewer cookie) or uses the admin token (redacted). No public session picker; `remote_ip` is stored as a prefix only.
12. **Listen on `0.0.0.0:$PORT`**; `trust proxy` = 1 hop; every cookie `Secure` + `HttpOnly`; SIGTERM finishes in under 10 s; image tags are git SHAs; secrets only via `--set-secrets`.
13. **Observability is part of done**: a feature that does not emit its documented events is not finished.
14. **Abuse caps**: per-IP limits on `/register`, `/authorize`, `/consent`, `/token` and pairing; per `client_id` on `/token`; per grant on `tools/call`; bounded LRUs for DCR clients, personas, overlays and scratch DBs. Every cap is an env knob (`docs/DEPLOYMENT.md`).
15. **Browser pages carry state in a signed `txn` JWT** with a `SameSite=Strict` CSRF double-submit, `X-Frame-Options: DENY` and `frame-ancestors 'none'`; the login page sets the 30-day `login_id` cookie; a step-up extends the existing grant.
16. **Personas are copy-on-write**: the seed is immutable and shared; card status, balances, transfers and audit entries live in a per-login overlay; writes are atomic per call.

## Rules

- Read `docs/blocks/<block>.md` before touching a block and update its Status, Files, Public interface, Events owned, How to test and Known gaps in the same change.
- Code against `src/contracts`; test against `src/testing/fakes.ts` and `test/fixtures/`. Construct dates in UTC. Compute advertised columns from the union of keys across all rows.
- Tool errors are `isError: true` with the text built by `toolErrorText` in `src/contracts/tools.ts` ("Ran into an error: ... Communicate this to the user and consider retrying if the error seems transient.").
- Cite `A-xx`, `D-x` and `ADR-x` in comments and tests when a behaviour depends on them.
- A new npm dependency gets a line in `docs/DEPENDENCIES.md`; a copied Ramp fragment a line in `THIRD_PARTY_NOTICES.md`; a new fact about a real client a line in `docs/observations/claude-ai.md`.
- `gcloud run deploy` flags live only in `infra/deploy.sh`; the other `infra/*.sh` scripts hold one-time or operational gcloud commands, each honouring `DRY_RUN=1`. Never raise `--max-instances`, drop `--no-cpu-throttling`, lower `--timeout` or add `--use-http2`.
- A push to `main` deploys and restarts the instance, which wipes the in-memory state (scratch tables, event log, bank writes): during a live demo, work on a branch. While paused, a push tests and builds but does not deploy; `make resume` or **Run workflow** in GitHub Actions turns the service back on.
- Never: a session map or `Mcp-Session-Id`; model-authored SQL on the main event loop; `McpServer.registerTool` for the catalog; the SDK auth router; filtering write tools out of `tools/list` for a missing write scope; binding pairing codes or viewer cookies to a grant instead of the login; advertising CIMD before it is implemented and observed; returning rows from a `load_*` tool; gating behaviour on `clientInfo.name` or `User-Agent`; a native dependency other than `better-sqlite3`, a front-end framework or bundler, Redis/Firestore or a second service without a `CHANGES.md` proposal.
- Everything is in English, including comments, UI strings and seed labels. Amounts are USD cents (D-1).
- Commits: `[block] summary` with a conventional body; branch `feat/<block>-<task>` or directly on `main` (no protection rules, D-22); commit or push only when asked; push only as GitHub account `frbarreto` over the HTTPS remote (D-21: the Mac's SSH key belongs to another account); every push to `main` deploys through `.github/workflows/pipeline.yml` (D-23); never commit `.env` or secrets.
