# Repository layout and conventions

One npm package, directory-level ownership, frozen contracts, fakes for every interface, one document per block. Several agents can work in parallel without touching each other's files.

## 1. Tree (as on disk, 2026-09-15)

```
mcp_bank/
  CLAUDE.md  README.md  LICENSE  THIRD_PARTY_NOTICES.md  Makefile
  package.json  tsconfig.json  tsconfig.build.json  eslint.config.js  vitest.config.ts
  .nvmrc  .prettierrc  .env.example  .dockerignore  .gitignore
  docs/
    ARCHITECTURE.md  ASSUMPTIONS.md  BUILD_PLAN.md  DEPENDENCIES.md  DEPLOYMENT.md
    LOCAL_TESTING.md  RAMP_REFERENCE.md  REPO_LAYOUT.md  TOOL_CATALOG.md  XRAY_EVENT_MODEL.md
    blocks/        app auth bank-core contracts dashboard etl infra mcp tools xray  (.md)
    contracts/     CHANGES.md          append-only contract change log
    observations/  claude-ai.md        what real clients sent
    tasks/         TEMPLATE.md         ticket template for a new task
    archive/       build history: planning docs, tickets, review records (not maintained)
  src/
    contracts/     auth.ts bank.ts events.ts scopes.ts tools.ts xray-api.ts index.ts   FROZEN, append-only
    testing/       fakes.ts            in-memory fake of every contract interface
    config/        index.ts types.ts errors.ts      env parsing (block: app)
    app.ts  composition.ts  server.ts  composition root (block: app)
    auth/          mock OAuth 2.1 AS, verifier, login and consent pages, DCR table
    mcp/           bearer gate, SDK transport, tool registration, xs sessions, instrumentation
    tools/         handlers/, registry, args, scope, availability, intent, previews
    bank-core/     seed, personas, overlays, queries, transfers, categories
    etl/           scratch-db, runner-pool, sql-runner (forked), sql-text guard, rows
    xray/          emitter, ring, log (SQLite), sse, routes, pairing, viewer, redaction
    __tests__/     app.test.ts wiring.test.ts
  public/          dashboard (vanilla JS, no bundler): index.html app.css app.js store.js stream.js
                   api.js ui.js h.js format.js filters.js catalogue.js mount.js pairing.js
                   chain.js         call chains and episodes from the event stream
                   hops.js          the data of one call's REQUEST / INSIDE / RESPONSE panes
                   open-state.js    what is open on the spine and how deep it starts
                   json-view.js     the collapsible JSON tree every panel shows a blob with
                   provenance.js    pure attribution: which of the five actors authored each value
                   panel-*.js (12)  call connect errors-health inspector intent now-strip persona
                                    possibility session-auth sessions sql-data timeline
    fixtures -> ../test/fixtures       symlink; how `/xray/?fixture=1` finds the recording (the Dockerfile recreates it)
    __tests__/     chain, contract-copy, filters, hops, json-view, mount, open-state, panels, provenance, store (*.test.mjs) + helpers.mjs
    _dev/          serve.mjs check-console.mjs check-live.mjs shoot.mjs vitest.config.mjs
  test/
    contracts/     barrel, catalog, events fixture, fakes, scopes, xray-api contract tests
    e2e/           oauth-walk.mjs (8899) session-walk.mjs (8897) live-dashboard.mjs (8095, Chrome)
    fixtures/      events.jsonl build-events.ts   the recorded session the dashboard replays
    import-boundaries.test.ts
  scripts/         local-login.mjs (npm run login); smoke-worker-sqlite.mjs and its helpers
                   (worker-sqlite-task.mjs bomb-child.mjs probe-*.mjs check-worker-sqlite.ts)
  infra/           Dockerfile cloudbuild.yaml bootstrap.sh deploy.sh smoke.sh
    local/         docker-compose.yml cloudflared.md
    vm/            docker-compose.yml Caddyfile Caddyfile.ip-cert README.md   (documented alternative)
```

Each `src/<block>/` has `index.ts` (exports exactly one factory `create<Block>(deps)` and its types), the implementation, and `__tests__/`. The block's public interface is what `index.ts` exports.

## 2. Ownership

| Block | Paths owned |
|---|---|
| contracts | `src/contracts/**`, `src/testing/**`, `test/fixtures/**`, `test/contracts/**`, `docs/contracts/**` |
| app | `src/app.ts`, `src/composition.ts`, `src/server.ts`, `src/config/**`, `src/__tests__/**`, `test/e2e/**` |
| auth, mcp, tools, bank-core, etl, xray | `src/<block>/**` and `docs/blocks/<block>.md`; mcp also `docs/observations/**` |
| dashboard | `public/**`, `docs/blocks/dashboard.md` |
| infra | `infra/**`, `docs/DEPLOYMENT.md`, `docs/blocks/infra.md`, `Makefile` |
| root | `CLAUDE.md`, `README.md`, `package.json`, `tsconfig*.json`, `eslint.config.js`, `vitest.config.ts`, `docs/*.md`, `scripts/**` |

A task names one block. Everything else is read-only for it; a needed change elsewhere is written as a proposal (in the task output or `docs/contracts/CHANGES.md`), never applied silently.

## 3. Import rules (`eslint.config.js`, plus `test/import-boundaries.test.ts`)

```
contracts   <- imported by everything (types, schemas, pure helpers)
testing     <- tests only
auth, bank-core, etl, xray, tools  -> contracts
mcp         -> contracts, tools
app         -> everything (src/app.ts, src/composition.ts, src/server.ts, src/config/**)
dashboard   -> HTTP only
```

Gated packages: `@modelcontextprotocol/*` only in `mcp`; `jose` only in `auth` and `xray`; `better-sqlite3` only in `auth`, `etl` and `xray`. No block imports the composition-root files.

## 4. Contracts

`src/contracts` is frozen and append-only (v0.5): new event types, optional fields, tools, scopes and routes may be added; nothing is renamed or removed. A block that needs a change appends a proposal to `docs/contracts/CHANGES.md` and keeps working against `src/testing/fakes.ts`; the owner of `src/contracts` applies it with a version bump.

## 5. Templates

Block document (`docs/blocks/<block>.md`), in this order: `Status` (one line), `Purpose`, `Files` (one line per source file), `Public interface` (the `index.ts` exports), `Consumes`, `Events owned` (type and the fields populated), `Invariants held here` (cite CLAUDE.md numbers), `How to test` (exact commands with the counts they print), `Known gaps`.

Task ticket: `docs/tasks/TEMPLATE.md`. Set `Status:` when you start and when you finish; one block per ticket; branch `feat/<block>-<id>`.

## 6. Tests

| Level | Command | Rule |
|---|---|---|
| Unit and contract | `npm run check`; `npx vitest run src/<block>`; `npx vitest run public` | Every block runs alone against fakes and fixtures |
| Protocol and OAuth | `npm run e2e` | Scripted client against a real server it spawns |
| Dashboard against a real server | `npm run e2e:dashboard` | Headless Chrome paired to a real session; needs Chrome, so not in `check` |
| Guard evidence | `npm run smoke:worker-sqlite` | Proves the SQL timeout mechanism |
| Dashboard rendering | `node public/_dev/check-console.mjs` | Fixture in headless Chrome, zero console errors |
| Deployment | `infra/smoke.sh <url>` | Anthropic's checklist plus invariant assertions |

`build` is `tsc -p tsconfig.build.json` (emits `dist/` from `src/` only); `tsconfig.json` also covers `test/` for `typecheck`, eslint and editors.

## 7. Naming

Tools `snake_case`; events `family.noun.verb`; scopes `resource:read|write`; env vars `UPPER_SNAKE`; ids prefixed `per_`, `lgn_`, `grt_`, `xs_`, `acc_`, `card_`, `txn_`, `tr_`, `bill_`, `pay_`; pairing codes `BANK-XXXX-XXXX-XX`. Files `kebab-case.ts`; tests in `__tests__/`. Commits `[block] summary`. Dependencies pinned to exact versions and listed in `docs/DEPENDENCIES.md`.
