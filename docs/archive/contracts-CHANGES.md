# Contract change log

Append-only. Entries are applied only by the integrator (T0.5, then I1); blocks append **proposals** below the last applied entry and keep working against their fakes. Format per `docs/REPO_LAYOUT.md` section 4.

Namespaces cited here: `A-xx` assumption, `D-x` user decision (`docs/ASSUMPTIONS.md`), `ADR-x` architecture decision (`docs/ARCHITECTURE.md` section 9).

## v0.0 - 2026-09-08 - planning baseline

Proposed by: planning. Applied by: n/a (no code yet).
Why: establishes the baseline the T0.2 contracts must implement: `docs/TOOL_CATALOG.md`, `docs/XRAY_EVENT_MODEL.md`, `docs/ARCHITECTURE.md` sections 4-7 as revised on 2026-09-08 (ADR-8 lenient `rationale`, ADR-13 listing rule and `listed` availability field, ADR-14 `login_id` and `auth.grant.updated`, ADR-15 `dataset` / `overlay` layering, ADR-4 JWT `jti` / `typ`, ADR-9 worker-backed `ScratchDb`).
Diff: none (documents only).
Affected: all blocks.

## v0.1 - 2026-09-08 - contracts frozen for Phase 1

Proposed by: T0.2 (contracts), T0.1 (scaffold), T0.3 (spike), T0.4 (infra). Applied by: integrator (T0.5).
Why: Phase 0 is code-complete locally. `src/contracts` is now exercised by the running system - the
auth block signs and verifies against `auth.ts`, the mcp block answers 401/403/405 from `scopes.ts`
and `tools.ts`, and 477 unit tests plus two scripted end-to-end walks pass - so the interface is
frozen as **v0.1** and is **append-only** from here (docs/REPO_LAYOUT.md section 4): new event types,
new optional fields, new tools, new scopes and new routes are allowed; no existing name is renamed or
removed in v1.

Affected: all blocks. Phase 1 lanes L1-L8 build against this version.

### SDK decision (ADR-2): stay on `@modelcontextprotocol/sdk` 1.30.0

Measured at T0.3, not assumed (full write-up in `docs/observations/claude-ai.md`):

- v2 (`@modelcontextprotocol/server` 2.0.0) advertises exactly the same five protocol versions as
  1.30.0 - `SUPPORTED_PROTOCOL_VERSIONS` is byte-identical and `LATEST_PROTOCOL_VERSION` is
  `2025-11-25` in both. Neither major knows `2026-07-28`, so the premise for moving ("v2 would serve a
  second era") is false today.
- v2 ships no Node `IncomingMessage`/`ServerResponse` transport, only
  `WebStandardStreamableHTTPServerTransport`; it would cost a hand-written Express bridge that 1.30.0
  gets for free.
- v2's OAuth helpers moved into `@modelcontextprotocol/server-legacy`, which npm marks deprecated and
  whose own notice says to use a dedicated OAuth server - upstream agreeing with T0.3's hand-rolled AS.
- The ADR-8 mechanism (low-level `Server` + `setRequestHandler`) exists in both.

The swap stays a one-file change behind `createTransport(deps)` in `src/mcp/transport.ts`. Revisit when
an SDK actually advertises a new protocol era; the per-request `mcp_protocol_version_header` log line is
the signal.

### Proposals applied

- **P-1 accepted.** Items 1 and 3 are applied to `THIRD_PARTY_NOTICES.md`: the load-tool instruction
  strings, `No data found`, the table messages and the error wording are recorded as living in
  `src/contracts/tools.ts` and being consumed by `src/tools`, and the error-wording verdict now records
  that Ramp's newline is replaced by a full stop per `docs/TOOL_CATALOG.md` section 1. Item 2 (`Pairing`
  declared in `auth.ts` rather than `bank.ts`) is **recorded here rather than applied to
  `docs/tasks/T0.2-contracts.md`**, because a closed ticket is a historical record; `src/contracts/index.ts`
  re-exports `Pairing` either way, so no consumer sees a difference.
- **P-2 accepted, nothing to apply.** `ToolRegistry`, `ToolCatalogSnapshot`, `JwtService`, `ClaimsFor`,
  `SignableClaims`, `VerifyAccessToken`, `AccessTokenVerification` and `XrayEventDataInput<T>` are part of
  v0.1 as shipped. `VerifyAccessToken` and `XrayEventDataInput<T>` are load-bearing in the running system
  (the bearer gate and every producer call site); `ToolRegistry` and `JwtService` are still only
  interfaces - L3/L4 and L6 should confirm their shapes and raise a v0.2 proposal if they do not fit.

### Amendments recorded during Phase 0

These change documents, not the contract surface. Each was measured; none of them alters a name in
`src/contracts`, so v0.1 stands.

1. **A-39 does not hold as written** (T0.1, reproduced by the integrator at T0.5).
   `node scripts/smoke-worker-sqlite.mjs` exits 1 on purpose: 4 of 5 checks pass, and the failing one is
   real. `worker.terminate()` frees a `worker_threads` worker **only when SQLite returns to JavaScript**
   (measured: 11 ms when an unbounded `WITH RECURSIVE` is consumed with `Statement.iterate()`). A
   statement that never yields a row to JS - an aggregate over an unbounded recursion - blocks the thread
   inside a synchronous native call, survives `terminate()` past a 2000 ms budget, and additionally
   prevents the host process from exiting (SIGKILL was required), which would break the 10 s SIGTERM
   budget of invariant 12. `better-sqlite3` 13.0.3 exposes neither `sqlite3_interrupt` nor a progress
   handler. The out-of-process fallback works: SIGKILL frees such a runner in 1-2 ms.
   Consequences: **ADR-9 must name a cancellation mechanism that actually bounds any query**, and
   **CLAUDE.md invariant 8's "timeout enforced with `worker.terminate()`" is false for the worst case**.
   `ScratchDb` in `src/contracts/bank.ts` is deliberately mechanism-agnostic (`query` may reject with
   `ScratchDbError{reason:'timeout'}`; `terminate(reason)` frees the database), so L2 can choose an
   out-of-process runner **without a contract change**. Recommended for L2: an out-of-process SQL runner
   the parent can SIGKILL, plus row-by-row `iterate()` consumption with the 100-row cap as defence in
   depth, plus a token-scan rejection of unbounded recursive CTEs.
2. **ADR-16 is amended: the SDK auth router is not used** (T0.3). `mcpAuthRouter` fixes `issuerUrl` at
   construction and mounts exactly one PRM path, both incompatible with A-36 and with
   `docs/ARCHITECTURE.md` section 5's two-path PRM; `OAuthServerProvider` has no place for the `txn` JWT,
   the CSRF double-submit, the `login_id` cookie, `iss` in the redirect or ADR-14 grant extension.
   `src/auth` is hand-rolled. ADR-16's `rateLimit: false` is therefore **moot, not implemented** - the
   SDK's rate-limit middleware is never constructed. The limits are real and live in
   `src/auth/rate-limit.ts` under the `docs/DEPLOYMENT.md` section 3 knob names.
3. **ADR-8's mechanism is the low-level `Server`, not a raw schema passed to `registerTool`** (T0.3).
   `McpServer.registerTool`'s `inputSchema` type is `AnySchema = z3.ZodTypeAny | z4.$ZodType`; it cannot
   take a raw JSON Schema and it validates every call, which is exactly the `-32602`-before-the-handler
   ADR-8 forbids. `src/mcp/transport.ts` uses `Server` + `setRequestHandler`. Verified end to end: a
   `tools/call` with **no** `rationale` reaches the handler and returns a result.
4. **A-13 sees `application_type: "native"`** (T0.3). MCP Inspector CLI 2.5.0 registers with
   `application_type: "native"`, not `web`. The allowlist accepts any `application_type`, so nothing
   broke, but the assumption text talks about `web`.
5. **RFC 8707 deviation** (T0.3, deliberate). An unrecognised `resource` parameter is silently ignored
   and the canonical MCP URL from the validated request `Host` is used, rather than answering
   `invalid_target`. Rationale: a client that computes `resource` slightly differently would otherwise be
   unable to connect at all, and A-36 already bounds the acceptable audiences. **Revisit against real
   claude.ai traffic.**
6. **Ids must not be base64url** (T0.3). `idPattern` in `src/contracts/events.ts` requires the first
   character after the prefix to be alphanumeric, and `randomBytes().toString('base64url')` starts with
   `-` or `_` about 3 % of the time, producing an intermittent `invalid_grant`. Every block minting a
   `per_` / `lgn_` / `grt_` / `xs_` / `acc_` / ... id must encode as hex. This is a property of the frozen
   contract, so it binds L1-L8.
7. **Image tags are timestamps until the first commit** (T0.4). D-10 keeps git local and nothing is
   committed, so `deploy.sh` falls back to `ts-YYYYMMDDTHHMMSSZ` (plus `-dirty-<ts>`). A loud, temporary
   deviation from invariant 12 that self-corrects on the first commit.
8. **Dependency substitutions** (T0.1, recorded in `docs/DEPENDENCIES.md`): vitest 3.2.7 instead of 5.x
   (npm 10.9.2 cannot resolve vitest 4/5, and neither supports the Mac's Node 23.10) and TypeScript 5.9.3
   instead of 7.x (typescript-eslint 8.70.0 declares `<6.1.0`).

### What this freeze rests on, and what it does not

Verified locally on 2026-09-08 against the **built** artefact (`npm run build && node dist/server.js`),
not only against `tsx`: `npm run check` (20 files, 477 tests), `infra/smoke.sh http://localhost:8080`
(20 passed / 0 failed / 3 skipped), `npm run e2e` (53 checks), and a second scripted walk driven straight
at `dist/server.js` (17 checks) covering DCR, PKCE, `iss` in the redirect, `initialize`, `tools/list` of
all 17 tools, a `tools/call` with no `rationale`, and the 403 `insufficient_scope` step-up.

**Not verified: anything involving claude.ai.** Nothing is deployed (no gcloud resource has been
created), no connector exists, and `cloudflared` is not installed on this machine. A-01, A-02, A-03,
A-05, A-06, A-17, A-40, A-41, A-42 and A-43 are therefore still open against the real client, and the
second half of the T0.5 gate (deploy under `log-only`, record the Origin values, switch to `allowlist`,
reconnect) has **not** run. Two consequences to watch when it does:

- `create_transfer` publishes its `to` parameter as a JSON Schema `oneOf`. MCP Inspector's `--strict`
  check passes on all 17 schemas, but claude.ai's behaviour with `oneOf` is unobserved. If it struggles,
  the flat `to_payee_id` / `to_account_id` alternative is a **schema change under cached clients** and
  needs a v0.2 proposal, decided early.
- A-13 allows the Inspector's `http://127.0.0.1:6276/oauth/callback` in development only, so under
  `NODE_ENV=production` the Inspector cannot register against the deployed service. Someone has to decide
  whether that is acceptable or whether the loopback path is allowed in production too.

Because the contract is append-only rather than immutable, freezing now is safe: whatever claude.ai
teaches us becomes a v0.2 entry, not a rewrite.

## Proposals (dispositions recorded in v0.1)

### P-1 - 2026-09-08 - three document edits the T0.2 contracts imply

**Status: ACCEPTED at v0.1.** Items 1 and 3 applied to `THIRD_PARTY_NOTICES.md`; item 2 recorded, not applied to the closed T0.2 ticket.

Proposed by: T0.2 (contracts). Applied by: integrator (T0.5, with the v0.1 freeze).
Why: writing `src/contracts` forced three small departures from the letter of the planning
documents. None changes an interface, all three leave a document inaccurate until edited.

1. **The ETL protocol strings live in `src/contracts/tools.ts`, not `src/tools`.**
   `THIRD_PARTY_NOTICES.md` records the "Where it lands here" of the load-tool instruction
   string, `No data found`, `Table {t} created`/`cleared` and the error wording as `src/tools`.
   They are wire strings shared by `tools` (produces), `etl` (limits) and the dashboard
   fixture, so duplicating them across blocks is exactly what `contracts` exists to prevent.
   Diff: `THIRD_PARTY_NOTICES.md`, rows 3 and 4 of the fragment table, "Where" column ->
   `src/contracts/tools.ts` (`loadResultText`, `NO_DATA_FOUND`, `processedTableText`,
   `clearedTableText`, `toolErrorText`), consumed by `src/tools`.
   Affected: tools, etl, dashboard (none need a code change).

2. **`Pairing` is declared in `src/contracts/auth.ts`, not `bank.ts`.**
   `docs/tasks/T0.2-contracts.md` puts it under `bank.ts`. It is a viewer-authentication
   mechanism (ADR-10) and sits next to the viewer JWT claims and the cookie names; nothing
   about it is a bank concept. `src/contracts/index.ts` re-exports it either way, so no
   consumer sees a difference.
   Diff: `docs/tasks/T0.2-contracts.md` deliverable list, `bank.ts` -> `auth.ts` for `Pairing`.
   Affected: xray, tools (import from the barrel, unchanged).

3. **The tool-error wording uses ". " where Ramp used a newline.**
   `docs/TOOL_CATALOG.md` section 1 writes "Ran into an error: {message}. Communicate this to
   the user ..."; `THIRD_PARTY_NOTICES.md` quotes Ramp's original as
   "Ran into an error: {e}\nCommunicate this to the user ...". `toolErrorText` follows the
   tool catalog, which is our specification, and the notices entry should say so.
   Diff: `THIRD_PARTY_NOTICES.md`, error-wording row, verdict column -> "copied, `isError`
   added, newline replaced by a full stop per TOOL_CATALOG section 1".
   Affected: tools.

### P-2 - 2026-09-08 - names added at T0.2 that the documents did not enumerate

**Status: ACCEPTED at v0.1.** All eight names ship in v0.1; nothing to apply.

Proposed by: T0.2 (contracts). Applied by: integrator (T0.5, with the v0.1 freeze).
Why: three block documents list a "Consumes" item that no document had named, and the freeze
should record them explicitly rather than have them appear as new API in Phase 1.
Diff (all additive, all in `src/contracts`):

- `ToolRegistry` and `ToolCatalogSnapshot` in `tools.ts` - the "registry interface" that
  `docs/blocks/mcp.md` says `mcp` consumes from `contracts`.
- `JwtService`, `ClaimsFor<T>` and `SignableClaims<T>` in `auth.ts` - the sign/verify helper
  that `docs/REPO_LAYOUT.md` section 3 says lives in `contracts` "as a pure function
  signature" and is injected into `xray` so `jose` stays inside `auth` and `xray`.
- `VerifyAccessToken` and `AccessTokenVerification` in `auth.ts` - the one function
  `docs/blocks/mcp.md` says `auth` injects into the bearer gate.
- `XrayEventDataInput<T>` in `events.ts` - the producer-side payload type, so a block can omit
  the fields the contract defaults; `XrayEmitter.emit` takes it.

Affected: mcp, auth, xray, tools (all gain a type they were going to have to invent).

## Phase 0 fix pass - 2026-09-08 - adversarial-review findings applied

Proposed by: the Phase 0 fix pass (after two adversarial reviews). Applied by: the same pass, inside
`src/`, `test/` and `docs/blocks/`. **No name in `src/contracts` was renamed, removed or added, so
v0.1 stands unchanged.** Two items below are contract-*adjacent* and need an integrator decision;
everything else is behaviour that the documents already promised and the code did not deliver.

### Contract-affecting, NOT applied - for the integrator

1. **`token_endpoint_auth_methods_supported` advertises a method `/register` refuses.**
   `OAUTH_METADATA_CONSTANTS` (`src/contracts/auth.ts:66`) lists `["client_secret_post", "none"]` for
   both the token and the revocation endpoint, but `/register` rejects any
   `token_endpoint_auth_method` other than `"none"` and no secret is ever minted. A client that reads
   the metadata and picks the first entry cannot connect. claude.ai picks `none`, so nothing is broken
   today, but the advertisement is false. Proposed diff: value change to `['none']` in
   `src/contracts/auth.ts`, plus the one line of `docs/ARCHITECTURE.md` section 5 that repeats the
   list. This is a value change, not a rename or removal, so it stays inside the append-only rule -
   but `src/contracts` is the integrator's file, so it is raised here rather than applied.

2. **`/token` and `/revoke` need a rate-limit knob of their own.** The per-IP window they now charge
   borrows `RATE_LIMIT_IP_AUTHORIZE`'s value (the one knob documented as sized for Anthropic's shared
   `160.79.104.0/21` egress). `docs/DEPLOYMENT.md` section 3 and `.env.example` should gain
   `RATE_LIMIT_IP_TOKEN`. Root-owned files, so not applied here.

### Root-owned document corrections, NOT applied

3. **`.env.example`'s `QUERY_TIMEOUT_MS` comment still says "enforced with worker.terminate()"**, which
   amendment 1 above disproved. `docs/blocks/etl.md` has been corrected in this pass; the `.env.example`
   line and `CLAUDE.md` invariant 8's body text (the header already carries the correction) are the
   integrator's.

### Amendments to amendment records

4. **Node's receive-side timeouts do not protect this service, and deleting the `= 0` lines was not
   enough.** `src/server.ts` used to set `headersTimeout`, `requestTimeout` and `keepAliveTimeout` all
   to `0` with a comment claiming they would otherwise cut long SSE streams. The comment is wrong for
   all three - none of them bounds a *response* - so the lines were deleted. But measurement then showed
   the platform does not do the job either: on **Node 23.10.0 / darwin-arm64**, a socket that sends a
   partial header block, or nothing at all, is not reaped by `headersTimeout=60000`, by
   `requestTimeout=300000`, or even by `headersTimeout=3000` with `connectionsCheckingInterval=1000` -
   it was still open past 130 s. The only built-in that reaps it is `server.timeout` (socket
   inactivity), which process-wide would also kill an idle SSE stream between heartbeats and a long ETL
   call. `src/server.ts` therefore arms a 60 s header-phase guard per connection and disarms it on the
   `request` event; measured, a partial-headers socket is now destroyed at 60 008 ms and a 6 s response
   under a 2 s guard completes untouched. **Re-measure on the container's Node 22 before relying on
   this being unnecessary there.**

5. **`trust proxy` is `1`, and that value is unverified against Cloud Run.** `true` let any caller pick
   its own `req.ip` through `X-Forwarded-For`, voiding every per-IP limit of invariant 14 and the /24
   provenance of invariant 11. The fix assumes exactly one appending proxy in front of the container,
   which is the documented Cloud Run and cloudflared shape but has never been observed here - nothing is
   deployed. First real connection: record the chain in `docs/observations/claude-ai.md` and promote the
   hop count to `TRUST_PROXY_HOPS` if it is not 1.

### Behaviour fixed inside blocks (no contract impact)

- `readCookie` no longer lets a malformed percent-encoded cookie throw, and every Express handler
  forwards its rejection with `.catch(next)` instead of `void`; `src/server.ts` adds
  `unhandledRejection` (log, keep serving) and `uncaughtException` (log, graceful exit) handlers. One
  unauthenticated request used to kill the process.
- OAuth 2.1 client binding: `/token` requires `client_id` and matches it against the code's and the
  refresh token's claims.
- Re-consent narrows as well as widens.
- A flag-disabled tool answers `-32601` at the gate **and** is refused by the transport.
- Every `/mcp` response carries CORS, not only the preflight.
- DCR registrations are bounded (10 URIs x 512 chars, clamped text fields); `/authorize` reconstructions
  no longer evict them; `revokedGrants` expires; `ExpiringSet` and the rate limiter are bounded and
  sweep on an amortised schedule; `/revoke` is rate-limited.
- `scripts/e2e-placeholder.mjs` deleted (dead since `npm run e2e` became the real 53-check walk).

---

## Proposals (not yet applied)

### P-3 - 2026-09-08 - `sql.rejected` cannot name four of the reasons `etl` actually rejects with

Proposed by: L2 (etl). Applied by: integrator (I1, with a v0.2 bump).
Status: **NOT APPLIED.** `src/etl` codes around it as described below.

Why: `ScratchDbFailureReason` in `bank.ts` has eleven members; `SqlRejectedReasonSchema` in
`events.ts` has six (`not_readonly`, `denylist`, `timeout`, `unknown_table`, `multi_statement`,
`row_cap`). Four rejections the shipped guard produces therefore have no `sql.rejected` reason to
travel under, so the dashboard cannot show why the call failed:

| Reason | When `etl` raises it | What v1 does instead |
|---|---|---|
| `unknown_column` | `process_data` with empty `cols`, or a column the load tool never advertised (Ramp OSS defect 10) | no `sql.*` event; the error reaches the model and the `tool.*` events |
| `syntax_error` | the model's SQL does not parse, or names a table it never loaded | no `sql.*` event; same as above |
| `ops_limit` | more than `MAX_CONCURRENT_ETL_OPS` operations in flight for one grant | `etl.limit_reached {limit: "ops"}` (a good fit, kept either way) |
| `grant_cap` | a load past `MAX_TABLES_PER_GRANT` | `etl.limit_reached {limit: "tables"}` (a good fit, kept either way) |

Related, and smaller: `EtlEvictionReasonSchema` (`ttl`, `grant_cap`, `global_cap`, `timeout`) has
no member for an **unexpected** runner exit (a crash or an OOM kill). `etl` clears the grant's
tables and rejects the in-flight call with `worker_crashed`, but emits no `etl.worker_terminated`,
because misreporting a crash as a timeout would be worse than silence.

Diff: `events.ts` - add `unknown_column` and `syntax_error` to `SqlRejectedReasonSchema`; add
`crash` to `EtlEvictionReasonSchema`. Both are additive enum members on existing types, which the
append-only rule allows.
Affected: `etl` (emits them), `xray` (renders raw until a row type exists), `dashboard`.


---

## Proposals (not yet applied)

### P-3 - 2026-09-08 - optional `last_event_id` query parameter on `GET /xray/api/stream`

Proposed by: L7 (dashboard). Applied by: nobody yet.

**Why.** `EventSource` sends the `Last-Event-ID` header only on the reconnects the *browser*
performs by itself. Whenever the dashboard has to rebuild a dead connection - the browser gave up
(`readyState === CLOSED`), or the viewer pressed "Reconnect now" - the new `EventSource` is a fresh
object with no memory, and the header is not sent. The server then replays its default window
(`INITIAL_REPLAY`, 200 events) instead of the events actually missing. There is no way to set a
header on an `EventSource`, so the cursor can only travel in the URL.

This is currently correct but wasteful: `public/store.js` keys on the event `id` and drops
anything it already holds, which `public/_dev/check-live.mjs` measures at 0 duplicates across a
forced mid-stream cut. It becomes wrong at scale - a viewer resuming after a long absence re-reads
200 events to learn about 3.

**Diff.** `src/contracts/xray-api.ts`, append-only:

```ts
export interface XrayStreamQuery {
  readonly xs?: string;
  readonly login?: 'me';
  readonly all?: '1';
  /**
   * Resume cursor for a reconnect the browser did not perform itself, where the `Last-Event-ID`
   * header cannot be set. The header wins when both are present.
   */
  readonly last_event_id?: string;
}
```

**Affected.** `xray` (read the parameter, prefer the header when both arrive, clamp it to the
viewer's filter exactly as the header path already does); `dashboard` (append it in
`api.streamUrl`). Nothing else. No event type, field or route name changes; a server that ignores
the parameter behaves exactly as today.

**Meanwhile.** `public/stream.js` relies on the browser's own retry for the common case and
tolerates the wider replay for the rest; nothing is blocked on this proposal.

### P-5 - 2026-09-08 - let `XrayEmitter.emit` report the id it assigned

Proposed by: L4 (mcp). Applied by: nobody yet.
Status: **NOT APPLIED.** `src/mcp` codes around it as described below; nothing is blocked.

(Numbering note: `P-3` was used twice, by L2 and by L7. This one takes `P-5` so no third
collision is created; the integrator may renumber when the proposals are applied.)

**Why.** `catalog.tools_listed.snapshot_ref` is defined as "id of the last `catalog.tools_listed`
that carried the full array for this grant", and the array is carried **only when `content_hash`
changed** because claude.ai re-lists every 25-80 s. To fill that field a producer has to know the
id the emitter gave the event that carried the array - and `emit` returns `void`, so it cannot.

`src/xray/emitter.ts` assigns the id synchronously inside `emit` (`buildEvent` then `publish`), so
the value exists at the moment of the call and returning it costs nothing.

**Diff.** `src/contracts/events.ts`, append-only (widening a return type breaks no caller):

```ts
export interface XrayEmitter {
  /** Returns the id assigned to the event, when the implementation can report one. */
  emit<T extends XrayEventType>(
    type: T,
    data: XrayEventDataInput<T>,
    correlation?: XrayCorrelation,
  ): number | void;
}
```

**Affected.** `xray` (`return event.id` at the end of `emit`, and `src/testing/fakes.ts` likewise);
`mcp` (`emitWithId` in `src/mcp/xray.ts` already reads the return value structurally and starts
filling `snapshot_ref` the moment this lands). Nothing else has to change: every other producer
ignores the value.

**Meanwhile.** `src/mcp` emits `snapshot_ref: null` on an elided listing, which the field's
`.nullable()` allows. Nothing is lost on the dashboard, because
`src/xray/read-model.ts` resolves an elided tool array by `content_hash` **first**
(`toolsByHash.peek(event.data.content_hash)`) and only falls back to `resolveSnapshotRef`. The
`content_hash` on the elided event is the join key that already works; `snapshot_ref` would make
it exact rather than by-content.

---

## v0.2 - 2026-09-08 - Phase 1 wired together (integration seam I1, plus I2 and the local half of I3)

Proposed by: L1-L7. Applied by: the Phase 1 integrator.
Why: the eight Phase 1 lanes landed against contracts v0.1 and fakes. This entry records what the
composition root now builds, the four proposals that were **applied** as additive contract changes,
and the ones that were considered and deliberately **not** applied.

Still **append-only**: every change below adds an enum member, widens a return type or adds a
comment. No name in `src/contracts` was renamed or removed, so every v0.1 consumer still compiles.

### What the system is now

`src/composition.ts` builds one graph and three callers use it (`src/server.ts`,
`test/e2e/*-walk.mjs` through `src/server.ts`, and `src/__tests__/wiring.test.ts`):

```
bank-core --(personas)--> auth --(jwt)--> xray --(emitter, pairing)--> etl, tools, mcp --> app
```

- the real 17-tool registry is injected into `mcp` (`src/mcp/registry.ts`, the T0.3 stand-in, is
  gone; `src/mcp/bootstrap-tools.ts` survives only as the no-registry fallback and is unreachable
  in every wired path);
- `bank-core` and `etl` reach the handlers through `ToolContext` (`bank`, `scratch`), which the
  composition root completes per request from the half `mcp` owns;
- `xray.emitter` is injected into `auth`, `mcp`, `tools`, `bank-core` and `etl`, `xray.pairing`
  into `auth` (the consent success page) and into `ToolContext` (`xray_get_session_link`);
- `app.use('/xray', xray.router)` serves `/xray/s/:code` and `/xray/api/*`, and the dashboard's
  static files are mounted **behind** it, so no file can shadow the JSON API. `public/_dev/` and
  `public/__tests__/` are refused.

Measured end to end on 2026-09-08 against the **built** artefact (`npm run build && node
dist/server.js`): `npm run check` (53 files, 1022 tests), `npm run e2e` (55 + 84 = 139 checks),
`bash infra/smoke.sh http://localhost:8080` (20 passed / 0 failed / 3 skipped), `npm run login`,
and a full read flow, write flow, step-up and paired dashboard session in a real browser engine.

### Proposals applied

- **P-5 accepted and applied.** `XrayEmitter.emit` now returns `number | void`. `src/xray/emitter.ts`
  returns `event.id`, `src/testing/fakes.ts` does the same, and `withCorrelation` in
  `src/mcp/xray.ts` forwards the value instead of swallowing it. Verified live: a second
  `tools/list` for an unchanged catalog is elided and now carries
  `snapshot_ref: <id of the listing that carried the array>` instead of `null`. Widening a return
  type breaks no caller, so this stays inside the append-only rule.
- **P-3 (L2, `etl`) accepted and applied**, both halves. `SqlRejectedReasonSchema` gains
  `unknown_column` and `syntax_error`; `EtlEvictionReasonSchema` gains `crash`.
  `src/etl/scratch-db.ts` now emits `sql.rejected` for the first two, so a query that does not
  parse or that names a column the load tool never advertised leaves a visible trace instead of
  reaching the model silently. **`crash` has no producer yet**: emitting `etl.worker_terminated`
  on an unexpected runner exit is a change inside `src/etl/runner-pool.ts` and belongs to that
  lane; the member exists so the change is a one-liner.
- **L5's proposal accepted and applied** (it was written out in the lane's notes rather than
  appended here, because two concurrent agents had already collided on the number `P-3`).
  `AuthRejectedData.reason` gains `rate_limited`, and `src/auth/routes.ts` uses it for the
  `RATE_LIMIT_LOGIN_GRANTS` refusal. It used to travel as `invalid_grant`, which reads on the
  dashboard as "this user replayed a code" rather than "this browser hit its daily cap".
- **The two "contract-affecting, NOT applied" items of the Phase 0 fix pass are both closed.**
  `OAUTH_METADATA_CONSTANTS.tokenEndpointAuthMethodsSupported` is already `['none']` in the shipped
  contract, and `RATE_LIMIT_IP_TOKEN` is a real knob in `src/config`, `.env.example` and
  `docs/DEPLOYMENT.md` section 3. Recorded here so nobody applies them twice.

### Numbering note

`docs/contracts/CHANGES.md` carries **two** proposals numbered `P-3` (L2's and L7's), appended by
concurrent agents, under two separate "Proposals (not yet applied)" headings. Rather than rewrite
either (the file is append-only), this entry names them by their proposer:

| Referred to here as | Number in the file | Proposer | Disposition |
|---|---|---|---|
| P-3 (etl) | P-3 | L2 | applied, above |
| P-3 (dashboard) | P-3 | L7 | deferred, below |
| P-5 | P-5 | L4 | applied, above |

The next free number is **P-6**.

### Proposals considered and deliberately not applied

- **P-3 (L7, dashboard): an optional `last_event_id` query parameter on `GET /xray/api/stream`.**
  Accepted in principle, deferred. It needs `src/xray` to read the parameter *and* `public/api.js`
  to send it, and a type added to `xray-api.ts` with neither half implemented would be a promise
  the server does not keep. Nothing is blocked: `public/store.js` de-duplicates by event id, and a
  forced mid-stream cut was measured at zero duplicates. Belongs to seam I3 or to H5, applied as
  one change across both lanes.
- **`same_account` on `TransferFailureReason` (L1).** A transfer whose destination is its own
  source account is refused today as `unknown_account` with the message "the destination account
  must be different from the source account". The message is right and the model recovers; the
  reason code is imprecise. Additive and cheap, but it needs a `src/bank-core` change to be worth
  anything, so it goes with the next `bank-core` task. Recorded here as **P-6** when someone picks
  it up.
- **`getBalances` on the `BankCore` interface (L1).** It exists on `BankCoreHandle`, not on the
  contract interface, so `src/tools` cannot call it through `ToolContext.bank`. No tool needs it in
  v1 (`load_accounts` carries `balance_cents` and `available_balance_cents` per account), so
  widening the interface now would add a method with no caller. Revisit if a balances tool is added
  (backlog B4).

### Known gaps this integration leaves open

1. **`bank.op` correlation is bought with `AsyncLocalStorage`, not with a contract change.**
   `bank-core` is a process-wide singleton holding every overlay, so it cannot be rebuilt per
   request and the emitter it was constructed with is the only one it has. What it knows about a
   call is `{persona_id, login_id}` from the `BankScope`; it cannot know the `xs`. Without the
   `xs`, `GET /xray/api/sessions/:xs/events` filters `bank.op` out and the one event that says what
   the bank actually did is missing from the view built to show it - measured, before the fix.
   `src/composition.ts` therefore opens an `AsyncLocalStorage` around every `registry.call` and the
   emitter it hands `bank-core` merges the ambient correlation under the producer's own fields. The
   clean alternative is a contract change - a per-call scope argument on the `BankCore` methods, or
   an emitter on `BankScope` - and that is a v0.3 conversation, not an append.
2. **`bank.op.card_id` and `account_id` are masked by `bank-core` before they are emitted**
   (`card_ava_stone_001` arrives as `****_001`), so a `bank.op` cannot be joined to the
   `tool.call.started` arguments that caused it by id. That is defence in depth the redaction
   pipeline no longer needs - `src/xray/redaction.ts` leaves a prefixed id alone on purpose, so the
   correlation would survive - and it is `bank-core`'s call to make. Worth revisiting with L1.
3. **Nothing has been deployed and no claude.ai client has ever connected.** Every claude.ai-facing
   assumption from the v0.1 freeze (A-01, A-02, A-03, A-05, A-06, A-17, A-40 to A-43) is still
   open, `ORIGIN_POLICY` is still `log-only`, and `docs/observations/claude-ai.md` still records
   only local clients. That is seam I4.
