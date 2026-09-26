# Dependencies

One row per entry in `package.json`. Versions are pinned exactly; `package-lock.json` and `npm ci` are the
source of truth. Add a row in the same change that adds a dependency (CLAUDE.md "Do"). Verified with
`npm ls --depth=0` on Node 23.10.0 / npm 10.9.2 (Mac) and on `node:22-slim` (container).

## Runtime

| Package | Version | Imported by | Why |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.30.0 | `mcp` (`src/mcp/transport.ts`); the client side of `test/e2e/*.mjs` | Low-level `Server` + `setRequestHandler` and the Streamable HTTP transport. Only `mcp` may import it (eslint). |
| `better-sqlite3` | 13.0.3 | `etl` (`src/etl/sql-runner.ts`, the forked process), `xray` (`src/xray/log.ts`), `auth` (`src/auth/client-db.ts`); `scripts/*.mjs` probes | Scratch `:memory:` databases, the event log, the DCR client table. The only native dependency allowed; prebuilt binaries on darwin/arm64 and `node:22-slim`, with python3/make/g++ in the Docker build stage as the fallback. |
| `express` | 5.2.1 | `app` (`src/app.ts`, `src/composition.ts`) and the routers in `auth`, `mcp`, `xray` | HTTP layer; `trust proxy` and `0.0.0.0:$PORT` (CLAUDE.md invariant 12). |
| `jose` | 6.2.12 | `auth` (`src/auth/jwt.ts`) only; `xray` receives `JwtService` by injection and imports `jose` just in its test harness | HS256 JWTs for code, access, refresh, viewer, txn and login tokens. eslint allows `auth` and `xray`. |
| `zod` | 4.5.4 | `contracts` (`auth.ts`, `events.ts`, `tools.ts`), `app` (`src/config/index.ts`) | Tool, event and API schemas plus env parsing. Satisfies the SDK peer range `^3.25 \|\| ^4.0`. |

## Development

| Package | Version | Used by | Why |
|---|---|---|---|
| `typescript` | 5.9.3 | `npm run typecheck` (`tsc --noEmit`), `npm run build` (`tsc -p tsconfig.build.json`) | 5.x is the ceiling: `typescript-eslint` 8.70.0 declares `typescript >=4.8.4 <6.1.0`. |
| `tsx` | 4.23.13 | `npm run dev`; `src/etl/runner-pool.ts` forks the SQL runner with `--import tsx` when running from `src/`; `scripts/smoke-worker-sqlite.mjs`, `scripts/probe-etl-timeout.mjs` | Runs TypeScript without a build step. |
| `vitest` | 3.2.7 | `vitest.config.ts` (`src/**/__tests__`, `test/**`, `public/__tests__`); `public/_dev/vitest.config.mjs` for the dashboard alone | Unit and contract tests. 3.x stays pinned because npm 10.9.2 cannot resolve vitest 4.x or 5.x on this Mac (`edgesOut` TypeError in arborist); revisit after upgrading npm. |
| `eslint` | 10.10.0 | `eslint.config.js`, `npm run lint` | Flat config with the block-boundary `no-restricted-imports` rules. Prints `EBADENGINE` on Node 23.10 (wants `^20.19.0 \|\| ^22.13.0 \|\| >=24`); harmless, and the container's Node 22 satisfies it. |
| `@eslint/js` | 10.0.1 | `eslint.config.js` | ESLint's recommended rule set. |
| `typescript-eslint` | 8.70.0 | `eslint.config.js` | TypeScript parser and rules. |
| `prettier` | 3.9.6 | `.prettierrc`; run on demand, not part of `npm run check` | Formatting. |
| `@types/node` | 26.5.0 | `tsc` | Node type definitions. |
| `@types/express` | 5.0.6 | `tsc` | Express 5 types. |
| `@types/better-sqlite3` | 9.6.0 | `tsc` | Types for the native module, which ships none. |
