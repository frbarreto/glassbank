# app

Status: done; `createGlassBank` in `src/composition.ts` builds every block and `src/server.ts` runs it on `0.0.0.0:$PORT`.

## Purpose
The composition root: parses the environment, builds every block in dependency order, wires them by injection, mounts the Express 5 app and owns the process lifecycle.
No domain logic; the only place that imports every block.

## Files
| File | What it does |
|---|---|
| `src/app.ts` | `createApp(config, deps)`: `trust proxy` = 1, request id, `/health` (alias `/healthz`, which Cloud Run's front end never forwards; `XRAY_ROUTES.health`, contracts v0.6), the mount order below, JSON 404, the error handler. |
| `src/composition.ts` | `createGlassBank(config, options)`: bank-core -> auth -> xray -> etl -> tools -> mcp -> `createApp`; `shutdown()`. |
| `src/server.ts` | Entry point: `loadConfig`, listen, a header-phase guard, SIGTERM/SIGINT, `unhandledRejection`, `uncaughtException`. |
| `src/config/index.ts` | `loadConfig(env)`: every knob parsed once with zod and its default; one `ConfigError` listing every problem. |
| `src/config/types.ts`, `errors.ts` | `AppConfig`, `RateLimitConfig`, `NodeEnv`, `LogLevel`, `OriginPolicy`; `ConfigError`. |

## Public interface
- `src/composition.ts`: `createGlassBank(config: AppConfig, options?: GlassBankOptions): GlassBank` = `{app, bootId, version, bankCore, auth, xray, etl, tools, mcp, shutdown(reason?)}`; `GlassBankOptions` = `{bootId?, version?, gitSha?, dashboardRoot?, quiet?}`; `dashboardRootFor(importMetaUrl)`; `SDK_VERSION`.
- `src/app.ts`: `createApp(config, deps?: AppDeps): Express` with `AppDeps` = `{bootId?, version?, authRouter?, mcpRouter?, xrayRouter?, dashboardRoot?}`; `newBootId()`; `readPackageVersion()`; `HealthResponse`.
- `src/config/index.ts`: `loadConfig(env = process.env)`, `hasFeatureFlag(config, flag)`, `ENV_VARIABLE_NAMES` (exactly the `.env.example` list), `ConfigError`, `AppConfig`. `src/server.ts` exports nothing.

## Mount order (`src/app.ts`)
1. `app.set('trust proxy', 1)` - the hop the proxy appended, never the caller's own header; `x-powered-by` off; `x-request-id` accepted and echoed; `GET /health` -> `{status: "ok", boot_id, version, origin_policy, uptime_s}`.
2. `authRouter` at `/` (`/.well-known/*`, `/authorize`, `/login`, `/consent`, `/token`, `/register`, `/revoke`), then `mcpRouter` at `/mcp`; only then `express.json` and `urlencoded` at 1 mb, so each router keeps its own limit (256 kb and 4 mb).
3. `xrayRouter` at `/xray`, then `express.static(public/)` at `/xray` behind it (`_dev/` and `__tests__/` -> 404; `.html` and `.jsonl` sent `no-cache`; the `public/fixtures` symlink serves `?fixture=1`); the placeholder page only when neither is injected.
4. JSON 404; the error handler keeps the error's own 4xx (`413` over the limit, `400` bad JSON) and answers 5xx with a fixed body.

Host and Origin policy are not applied here: `publicHosts` and `originPolicy` go to `mcp` (`src/mcp/gate.ts` decides per request) and the whole config to `auth` (`canonicalBaseUrl` in `src/auth/routes.ts`); `/health` only reports the policy.

## Composition and shutdown
- `auth` needs `xray.emitter` and `xray.pairing`, `xray` needs `auth.jwt`: the cycle is broken with two forwarding objects, not by building `auth` twice.
- Every `registry.call` runs inside an `AsyncLocalStorage` holding `{xs, login_id, grant_id, persona_id, request_id}`; the emitter handed to `bank-core` merges it under the producer's own fields, which is how a `bank.op` gets its `xs`.
- `lookupBankSummary` (injected into `xray` for `GET /xray/api/sessions/:xs/bank`) reads `bankCore.getBalances` and `listCards` on the login's overlay, keyed with the tools' `overlayLoginKeyOf`, inside a second `AsyncLocalStorage` (`silentReads`) that makes the same emitter drop the `bank.op` events of that read.
- Completes the `ToolContext` half `mcp` may not build: `bank`, `scratch: etl.forGrant(grant_id, correlation)`, `pairing`, `limits` (the env caps plus `CLAUDE_TOOL_BUDGET_MS` and `CLAUDE_CONTENT_CHAR_CAP`).
- `shutdown()`: `mcp.shutdown('server_stopping')` then `xray.shutdown()` (both synchronous; reversed, the events are lost), `await etl.shutdown()`, `auth.close()`.
- `src/server.ts` on SIGTERM/SIGINT: `glassBank.shutdown()`, `closeIdleConnections()`, `server.close()` -> exit 0; at 9 s `closeAllConnections()`, 500 ms later exit 1. A 60 s per-connection guard destroys a socket that never completes its headers; a response is never touched. `unhandledRejection` is logged and survived; `uncaughtException` runs the same shutdown with exit 1. `GIT_SHA` from the environment becomes `gitSha`.

## Consumes
`createBankCore`, `createAuth`, `createXray`, `createEtl`, `createTools`, `createMcp`, `src/contracts`, `express`, `zod`.

## Events owned
None. `server.started` and `server.stopping` are emitted by `src/xray/index.ts`; `http.request` by `src/mcp/index.ts`, for `/mcp` requests only. The first stdout line of `src/server.ts` carries `event: "server.started"` as a log line that `npm run e2e` and `infra/smoke.sh` wait for; it is not an X-ray event.

## Invariants held here
- 4: `publicHosts` always contains the host of `PUBLIC_BASE_URL`; the list variables `PUBLIC_HOSTS` and `FEATURE_FLAGS` are `;`-separated because `--set-env-vars` splits on commas.
- 7 and 11: the development signing key and admin token are refused when `NODE_ENV=production`.
- 12: `0.0.0.0:$PORT`, `trust proxy` 1, shutdown well inside 10 s. 14: every cap is a knob of `loadConfig`; none is enforced in `app.ts` itself.

## How to test
```
npx vitest run src/__tests__ src/config        # 37 tests, 3 files: config parsing, /health, trust proxy, error handler, the mount order
npx vitest run test/import-boundaries.test.ts  # 5 tests: the block dependency rules, parsed from source
npm run build && node dist/server.js           # the entry point the container runs
```

## Known gaps
- `LOG_LEVEL` and `SNAPSHOT_BUCKET` are parsed and consumed by nothing (logging is bare `console`); `GIT_SHA` is read but nothing sets it (`infra/deploy.sh` does not pass it), so `server.started.git_sha` is `null`.
- No rate limit on the `/xray` read routes; only the pairing and admin exchanges have one.
- `trust proxy` = 1 is unverified against a real Cloud Run chain; behind no proxy a caller names its own `req.ip`.
- `src/mcp/bootstrap-tools.ts` is unreachable in every wired path but still in the tree.
