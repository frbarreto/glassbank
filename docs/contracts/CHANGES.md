# Contract change log

Version log for `src/contracts` (`auth.ts`, `bank.ts`, `events.ts`, `scopes.ts`, `tools.ts`, `xray-api.ts`, re-exported by `index.ts`), newest first. The contract is append-only: names are added, never renamed or removed in v1. Namespaces: `A-xx` assumption and `D-x` user decision (`docs/ASSUMPTIONS.md`), `ADR-x` architecture decision (`docs/ARCHITECTURE.md` section 9).

## v0.5 - 2026-09-09 - what the client was told

| Change | File | Producer / consumer |
|---|---|---|
| `CatalogToolDescriptorSchema {description, inputSchema, annotations, _meta}` and the optional `descriptor` on `CatalogToolSchema` | `events.ts` | no producer and no consumer yet: `catalogRowsOf` in `src/mcp/xray.ts` is to fill it, the dashboard is to render it and to degrade when a row lacks it |
| `publishedToolDescriptor(entry)`: the `tools/list` entry of one catalog entry, `_meta` included | `tools.ts` | to be shared by `src/mcp/transport.ts` (the response) and `src/mcp/xray.ts` (the record) at T8, so the record cannot drift from the wire |

Why: the `tools/list` response is the largest output this server sends and the model's whole world-model of the bank, and nothing recorded proved its wording or its schema - `content_hash` covers membership, scopes and flags only. Recording the descriptor at send time is the only option that shows what was actually sent, survives redeploys and works in fixture mode. Measured cost: 27,712 chars of descriptors, 32,859 for the whole listing payload, carried once per grant per process boot because catalog memory elides the array on an unchanged hash - under `MAX_EVENT_CHARS` (64,000), deepest path at walker depth 11 against `MAX_DEPTH` (12). Hazard for the producer: `published()` gives every schema the same `PUBLISHED_RATIONALE_PROPERTY` object, so a payload-wide cycle guard would write `[circular]` on 16 of 17 descriptors; the `xray` guard is ancestor-scoped since 2026-09-09. Cites ADR-8 (`rationale` in `required`), ADR-13 (write tools listed without their scope, so their annotations and `_meta` are part of the record) and A-05 (the record says "sent to the client", never "read by the model").

Adoption, tasks T8 and T10a (the Producer / consumer cells above are as proposed): `catalogRowsOf` in `src/mcp/xray.ts` fills `descriptor` through `publishedToolDescriptor`, the same helper `src/mcp/transport.ts` answers `tools/list` with (T8, 2026-09-09); `public/panel-possibility.js` renders the descriptor and degrades on a row without one (T10a, 17 of 17 digests verified in Chrome over the fixture on 2026-09-14).

Fixture, task T7b, landed 2026-09-14 (`test/fixtures/build-events.ts`; no schema change): `test/fixtures/events.jsonl` is a v0.5 recording, still 200 lines with every id, type and timestamp in place.

- The two full listings (ids 21 and 178; 178 stays full because `server.started` 172 sits between them and catalog memory is in-process) are built by `catalogRowsOf`, so every row carries its `descriptor` and the real 16-hex `inputSchemaHash` instead of the FNV stand-in. `content_hash` remains the `sha256:` stand-in that `public/__tests__/store.test.mjs` pins.
- Every `/mcp` `http.request` carries the first JSON-RPC id of its body; only the 202 notification stays `null`. The scene does not show the body of the two 401s, so they carry `"0"`, the `initialize` the client sent next.
- `intent.inferred` 63 carries `request_id: "10"`, the `clear_table` that closed the sequence.
- Every `tool.call.completed` is `summariseResult` over the text the real handler returns, so each preview is whole and as long as `content_chars`, errors in `toolErrorText` wording. The one exception is id 57, the capped `execute_query` (request 9): 8,417 characters, preview the first 2,048 plus `…[truncated]`. The plan wanted a separate 8,4xx result and a message-length id 57, but `executeQuery` appends the row-cap sentence to the first 100 rows and still succeeds, so id 57 is that result. Its 100 rows are the largest of the 184 loaded, whose 133 posted rows add up to the category totals of request 7.
- The two `sql.rejected` errors use the guard's and the timeout path's real wording.
- `test/contracts/events-fixture.test.ts` re-hashes every descriptor, compares both listings with `catalogRowsOf(TOOL_CATALOG)`, and checks the HTTP ids, the cut preview and every whole one.

No second proposal: `http.request.request_id` already carries the first JSON-RPC id of the body (`src/mcp/index.ts`) and `intent.inferred` already carries the causing call's correlation (`src/tools/registry.ts`); the missing `auth.verified` producer is a gap of the `mcp` block, not a contract change.

## v0.4 - 2026-09-09 - erasing history

| Change | File | Producer / consumer |
|---|---|---|
| `XRAY_ROUTES.events` = `/xray/api/events`; `DELETE` there and on `sessions/:xs` | `xray-api.ts` | served by `src/xray/routes.ts`; called by `public/api.js` |
| `XrayDeleteResponse {deleted, sessions, scope}` | `xray-api.ts` | the answer to both DELETEs |
| `xray.events.deleted` event: `scope`, `xs_deleted`, `deleted_count`, `sessions_deleted`, `viewer_kind` | `events.ts` | emitted by `src/xray/routes.ts` after the erase; the catalogue is now 46 types |

Why: sessions accumulate and the dashboard became unreadable. A viewer can now erase one session or its whole login. Only a pairing viewer may erase and only its own login: observer mode is read-only, because the admin token can read every session and must not be able to destroy someone else's evidence (invariant 11). The erase covers the SQLite log, the live ring buffer (or the next `Last-Event-ID` replay would bring it back) and the read model, and it leaves one `xray.events.deleted` event behind, because a page that can destroy its own evidence silently is worse than one that cannot erase at all (invariant 13). An unknown `xs` is refused with the same 403 a stranger's session gets, so the status never reveals which sessions exist.

## v0.3 - 2026-09-09 - the persona card

| Change | File | Producer / consumer |
|---|---|---|
| `XRAY_ROUTES.sessionBank` = `GET /xray/api/sessions/:xs/bank` | `xray-api.ts` | served by `src/xray/routes.ts` with the session-detail visibility rule; read by `public/panel-persona.js` |
| `XrayBankAccount`, `XrayBankCardCounts`, `XrayBankSummary`, `XraySessionBankResponse` | `xray-api.ts` | built by `lookupBankSummary` in `src/composition.ts` from `bank-core` (`getBalances`, `listCards`, `personas.get`) and injected into `xray` as `XrayDeps.lookupBankSummary`; `xray` never imports `bank-core` |

Why: the dashboard shows who is in the session and what they hold (name, net position, accounts, card counts, transfer limit) without the viewer having to read it out of tool results. The read runs on the login's overlay (ADR-15), the same numbers the tools return, and inside a silent emitter scope so it produces no `bank.op` the model never caused. `overlayLoginKeyOf` is now exported from `src/tools` so the composition root keys a login-less grant exactly as the tools do.

## v0.2 - 2026-09-08 - four additive changes

| Change | File | Producer / consumer |
|---|---|---|
| `XrayEmitter.emit` returns `number \| void` (the id it assigned) instead of `void` | `events.ts` | `src/xray/emitter.ts` and `src/testing/fakes.ts` return the id; `emitWithId` in `src/mcp/xray.ts` fills `catalog.tools_listed.snapshot_ref` |
| `unknown_column` and `syntax_error` added to `SqlRejectedReasonSchema` | `events.ts` | `src/etl/scratch-db.ts` emits `sql.rejected` for both |
| `crash` added to `EtlEvictionReasonSchema` | `events.ts` | no producer yet (see Known open gaps) |
| `rate_limited` added to `AuthRejectedData.reason` | `events.ts` | `src/auth/routes.ts`, the `RATE_LIMIT_LOGIN_GRANTS` refusal (used to travel as `invalid_grant`) |

## v0.1 - 2026-09-08 - frozen

Frozen: every event type and data schema in `events.ts`; the 17 tools of `TOOL_CATALOG` (`tools.ts`); the 10 scopes of `SCOPES` (`scopes.ts`); `OAUTH_ROUTES`, `COOKIE_NAMES`, `OAUTH_METADATA_CONSTANTS`, `isAllowedRedirectUri` and the JWT claim shapes (`auth.ts`); `BankCore`, `ScratchDb` and the bank row types (`bank.ts`); `XRAY_ROUTES` and the dashboard API types (`xray-api.ts`).

Three facts settled by measurement; the code below is the current truth:

- Model-authored SQL runs in a forked process (`src/etl/sql-runner.ts`, pooled by `src/etl/runner-pool.ts`) that the parent kills with `SIGKILL` on `QUERY_TIMEOUT_MS`. `worker.terminate()` cannot free a `worker_threads` worker stuck inside native SQLite, so there are no worker threads; `ScratchDb` is mechanism-agnostic, so no contract change was needed (ADR-9, A-39, CLAUDE.md invariant 8). `npm run smoke:worker-sqlite` proves both halves.
- The authorization server is hand-rolled in `src/auth`; the SDK's `mcpAuthRouter` is not mounted, because it fixes `issuerUrl` at construction and serves one PRM path (incompatible with invariant 4). The rate limits are real and live in `src/auth/rate-limit.ts` (ADR-16, invariant 14).
- Tools are registered on the SDK's low-level `Server` with `setRequestHandler`, from the raw published JSON schema (`src/mcp/transport.ts`). `McpServer.registerTool` accepts only zod schemas and would answer `-32602` before the handler for a missing `rationale` (ADR-8, invariant 9).

Properties of v0.1 that bind every block:

- Ids are hex after their prefix (`per_`, `lgn_`, `grt_`, `xs_`, `acc_`, ...): `idPattern` in `events.ts` requires an alphanumeric first character, which base64url violates about 3 % of the time.
- An unrecognised RFC 8707 `resource` parameter on `/authorize` is ignored and the canonical MCP URL of the validated `Host` is used, not `invalid_target` (A-36). Revisit against real claude.ai traffic.
- `OAUTH_METADATA_CONSTANTS.tokenEndpointAuthMethodsSupported` is `['none']`; `/register` accepts any `application_type` (MCP Inspector and Codex send `native`). A loopback `/callback` redirect is always accepted; the Inspector's `/oauth/callback` only with `allowDevLoopback`, i.e. outside production (A-13).
- `create_transfer.to` is published as a JSON Schema `oneOf`; MCP Inspector `--strict` accepts it, claude.ai is unobserved.

## Open proposals (not implemented)

| Proposal | Diff | Affected | State in the code |
|---|---|---|---|
| Optional `last_event_id` query parameter on `GET /xray/api/stream`, for reconnects the browser does not perform itself (`EventSource` cannot set `Last-Event-ID`) | `xray-api.ts`: `readonly last_event_id?: string` on `XrayStreamQuery`; the header wins when both arrive | `xray`, `dashboard` | Half done: `lastEventIdOf` in `src/xray/sse.ts` already falls back to `request.query.last_event_id`; `XrayStreamQuery` does not declare it and `streamUrl` in `public/api.js` does not send it. `public/store.js` de-duplicates by event id meanwhile |
| `same_account` on `TransferFailureReason` | `bank.ts`: one union member | `bank-core`, `tools` | Absent. A transfer to its own source account is refused as `unknown_account` with the message "the destination account must be different from the source account" |
| `getBalances` on the `BankCore` interface | `bank.ts`: `getBalances(scope: BankScope): Promise<BalanceSummary>` | `bank-core`, `tools` | Absent from the contract; exists on `BankCoreHandle` in `src/bank-core/index.ts`, so `ToolContext.bank` cannot reach it. No tool needs it: `load_accounts` carries `balance_cents` and `available_balance_cents` (backlog B4) |

## Known open gaps

- `bank.op` correlation is bought with `AsyncLocalStorage`, not a contract: `bank-core` is a process-wide singleton that knows only `{persona_id, login_id}`, so `src/composition.ts` opens an `AsyncLocalStorage` around every `registry.call` and the emitter handed to `bank-core` merges the ambient `xs` / `grant_id` under the producer's fields. The contract alternative (a per-call scope on the `BankCore` methods, or an emitter on `BankScope`) is a v0.3 change.
- `bank-core` masks `card_id` and `account_id` to `****` plus the last four characters (`maskId`, `src/bank-core/index.ts`) before emitting `bank.op`, so a `bank.op` cannot be joined by id to the `tool.call.started` that caused it. `src/xray/redaction.ts` leaves prefixed ids alone, so the masking is `bank-core`'s choice, not a redaction requirement.
- `crash` on `EtlEvictionReasonSchema` has no producer: `onLoss` in `src/etl/scratch-db.ts` emits `etl.worker_terminated` only for `cause === 'timeout'` and clears the grant's tables silently on `'crash'`.

## How to propose a change

1. Append an entry under "Open proposals" with what (the exact names), why (one clause), affected blocks, and the diff as it would appear in `src/contracts`.
2. Additive only: a new event type, optional field, enum member, tool, scope or route. Never rename or remove a name in v1.
3. Keep coding against `src/testing/fakes.ts`; a proposal blocks nothing.
4. Whoever owns `src/contracts` applies it with a version bump and moves the entry into the version log as one line per change; block tasks never edit `src/contracts`.
5. Cite `A-xx`, `D-x` or `ADR-x` when the change depends on one.
