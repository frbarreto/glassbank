# tools
Status: done, contracts v0.7, wired in `src/composition.ts` (`createTools()` is injected into `createMcp` as `registry`, and `createPublicTools()` as `publicLane.registry`, each wrapped in an `AsyncLocalStorage` so a `bank.op` emitted inside `bank-core` carries the call's `xs`).

## Purpose
The seventeen handlers of `docs/TOOL_CATALOG.md` as pure functions of `(ToolCallContext, args)`, the six public ones of its section 8 as pure functions of `(PublicToolContext, args)`, plus what surrounds a call: the `rationale` rule (ADR-8, A-06), the listing rule and availability table (ADR-13), the intent classifier and the `isError` wrapper (A-08).
No HTTP, transport, SQL, bank logic or redaction here; those belong to `mcp`, `etl`, `bank-core` and `xray`.

## Files
- `index.ts` - the public exports.
- `registry.ts` - `createTools`, `TOOLS_LIMIT_DEFAULTS`, the per-call sequence below, `validationMessage` (shared with `public.ts`).
- `types.ts` - `ToolCallContext`, `ToolCallHandler`, `ToolsDeps`, `ToolsHandle`, `ToolsLimits`, `ToolsStats`, `AvailabilityTable`, `ANONYMOUS_LOGIN_ID`.
- `rationale.ts` - `readRationale`, `stripRationale`, `emitIntent`, `correlationOf`, `describeToolCall` (the `tool.call.started` fields `mcp` takes from here).
- `availability.ts` - `catalogContentHash` (sha256 of the listed entries plus flags, 16 hex chars), `listedFor`, `snapshotFor`, `availabilityTableFor`.
- `intent.ts` - the deterministic intent classifier.
- `scope.ts` - `bankScopeOf` (the `BankScope` of a call), `overlayLoginKeyOf`, `loginKeyOf`.
- `previews.ts` - the open `create_transfer` preview memory, keyed by login, source account, destination, amount and currency; LRU-capped.
- `rows.ts` - `collectPages` (walks `{data, page.next}` to the end, stops at `maxPagesPerLoad`), `withoutPersonaId`, `normaliseDate`, `parseDateRange`.
- `args.ts` - typed readers for validated arguments; `""` means no filter.
- `errors.ts` - `describeFailure`, `describeScratchError` (one recovery message per `ScratchDbFailureReason`), `TOO_MANY_PAGES_MESSAGE`, `RELOAD_AFTER_TEARDOWN`.
- `format.ts` - `formatMoney` (`1000 cents ($10.00)`), `toJson`, the content-cap check.
- `bounded.ts` - `BoundedMap`, the recency-ordered bounded map behind previews and classifier history.
- `public.ts` - `createPublicTools` (the `PublicToolRegistry` of `/public/mcp`, D-26) and `PUBLIC_HANDLERS`: compact JSON plus `next`, the call one level deeper or the signed-in connector at `<base>/mcp`.
- `handlers/index.ts` (`createHandlers` assembles the map and throws if a catalog name has no handler), `handlers/load.ts`, `database.ts`, `meta.ts`, `reference.ts`, `writes.ts`, `xray.ts` - the handlers (table below).

## Public interface (`src/tools/index.ts`)
- `createTools(deps?: ToolsDeps): ToolsHandle` - `ToolsHandle` is the contract's `ToolRegistry` (`catalog`, `listFor`, `call`) plus `registry`, `handlers`, `availabilityFor(grant, flags?)`, `stats()`, `reset()`.
- `createPublicTools(): PublicToolsHandle` - the contract's `PublicToolRegistry` (`catalog`, `list`, `call`) plus `handlers` and `stats()` (`calls`, `errors`); `PUBLIC_HANDLERS`; types `PublicToolHandler`, `PublicToolsHandle`, `PublicToolsStats`.
- `TOOLS_LIMIT_DEFAULTS` - `maxOpenPreviews` 200, `maxIntentSessions` 500, `intentHistoryLength` 8, `loadPageSize` 500, `maxPagesPerLoad` 100.
- `availabilityTableFor`, `catalogContentHash`, `listedFor`, `snapshotFor`, `correlationOf`, `describeToolCall`, `emitIntent`, `readRationale`, `stripRationale`, `classifyIntent`, `createIntentClassifier`.
- `createHandlers`, `createLoadHandlers`, `createTransferHandler`, `createWriteHandlers`, `DATABASE_HANDLERS`, `META_HANDLERS`, `REFERENCE_HANDLERS`, `XRAY_HANDLERS`.
- `describeFailure`, `describeScratchError`, `RELOAD_AFTER_TEARDOWN`, `TOO_MANY_PAGES_MESSAGE`, `collectPages`, `normaliseDate`, `parseDateRange`, `withoutPersonaId`, `bankScopeOf`, `loginKeyOf`, `overlayLoginKeyOf` (also used by the composition root for the persona card), `formatMoney`, `createPreviewStore`, `previewKey`, `ANONYMOUS_LOGIN_ID`.
- Types: `AvailabilityTable`, `ToolCallContext`, `ToolCallHandler`, `ToolsDeps`, `ToolsHandle`, `ToolsLimits`, `ToolsStats`, `RationaleFacts`, `ToolCallDescription`, `IntentClassifier`, `IntentInference`, `HandlerDeps`, `OpenPreview`, `PreviewStore`.

## Consumes
- `ToolsDeps.limits` (partial `ToolsLimits`) at construction; `composition.ts` passes nothing. Per call, `ToolContext`: `auth`, `bank` (`BankCore`), `scratch` (`ScratchDb`), `xray` (`XrayEmitter`), `pairing`, `featureFlags`, `limits` (`ToolLimits`), `now`, `requestId`, `publicBaseUrl`.
- `src/contracts` only: `TOOL_CATALOG`, `getTool`, `flagsEnabledFor`, `missingScopesFor`, `isListed`, `catalogAvailability`, `canonicalCatalogSnapshot`, `toolError`, `toolText`, `loadResultText`, `NO_DATA_FOUND`, `processedTableText`, `clearedTableText`, `rowCapMessage`, `TOO_MANY_TABLES_MESSAGE`, `ETL_OPERATION_LIMIT_MESSAGE`, `RATIONALE_MAX_LENGTH`, `CLAUDE_TOOL_BUDGET_MS`, `ID_PREFIXES`, `isId`, `isScratchDbError`.
- Ramp-copied fragments: `loadResultText`, `NO_DATA_FOUND`, the error wording, `AMOUNT_DESCRIPTION`, the `""`-means-null enums and `CLIENT_MAX_PAGES` (`TOO_MANY_PAGES_MESSAGE`) come from `ramp_mcp/tools.py` and `constants.py`; all but `TOO_MANY_PAGES_MESSAGE` are imported from `src/contracts/tools.ts`. See `THIRD_PARTY_NOTICES.md`.

## What happens on every call (`registry.ts`, in order)
1. `getTool(name)`; unknown -> throws, and the transport answers `-32601`.
2. `readRationale(args.rationale)`, then `intent.declared` or `intent.missing`, before anything can refuse the call.
3. Feature flag (`flagsEnabledFor`), then scopes (`missingScopesFor`): a miss emits `tool.call.denied` and returns a tool error naming the flag or scope. The bearer gate in `mcp` already answered 403; this is defence in depth.
4. `entry.lenientInputSchema.safeParse(args)`: a mismatch is a tool error naming the path; a missing `rationale` never fails here.
5. The handler runs on `ToolCallContext` (`ToolContext` plus `tool`, `rationale`, `rationale_truncated`) with `rationale` stripped from `args`; any throw becomes `toolError(describeFailure(error, limits))`.
6. `classifier.observe(xs ?? grant_id, tool, rationale)`; a non-null inference emits `intent.inferred`.

## The seventeen handlers
| Tool | File | Behaviour |
|---|---|---|
| `load_accounts`, `load_cards`, `load_payees` | `handlers/load.ts` | Page the `BankCore` list to the end, drop `persona_id`, `scratch.load`, return `loadResultText`; never a row. `No data found` creates no table. `load_payees` defaults `is_active` to true. |
| `load_transactions`, `load_transfers`, `load_bills`, `load_statement_lines` | `handlers/load.ts` | Same, after `parseDateRange`: a malformed or inverted range is a tool error. |
| `process_data`, `clear_table` | `handlers/database.ts` | Empty `cols` refused with advice; `scratch.process` then `Table {name} created`; `scratch.clear` then `Table {name} cleared`. |
| `execute_query` | `handlers/database.ts` | `scratch.query` with `limits.maxQueryRows` and `queryTimeoutMs`; rows as compact JSON with `rowCapMessage` appended when capped (still a success); over `contentCharCap` is a tool error. |
| `get_bank_categories`, `get_currencies` | `handlers/reference.ts` | `bank.listCategories` / `listCurrencies` as JSON; no scope. |
| `get_current_user` | `handlers/meta.ts` | Persona, `login_id`, `grant_id`, scopes, `auth_level`, token expiry, `xs`, `boot_id` (A-15). |
| `get_tool_availability` | `handlers/meta.ts` | The availability table with `content_hash`; emits `catalog.availability`. |
| `lock_or_unlock_card` | `handlers/writes.ts` | `bank.lockOrUnlockCard` with the rationale; `changed: false` is a success; a failure reason is a tool error. |
| `create_transfer` | `handlers/writes.ts` | Without `confirm`: `bank.previewTransfer`, refuse a `blocked` outlook, remember the preview. With `confirm`: require `expected_total_amount` and a matching open preview, then `bank.confirmTransfer`; `repriced` re-remembers the new quote and returns a tool error; success forgets the preview. |
| `xray_get_session_link` | `handlers/xray.ts` | `pairing.createCode({login_id})`; a grant with `login_id: null` is refused. |

## The six public tools (`public.ts`, D-26)
The same sequence as above minus scopes, flags and the classifier (its workflows describe a customer's own data): `intent.declared` / `intent.missing` under the visitor's pseudo grant and `PUBLIC_LOGIN_ID`, the lenient schema, the handler, a throw turned into a tool error. `""` means no filter on every optional argument.
| Tool | Reads | Answer |
|---|---|---|
| `get_bank_profile` | `info.profile` | The profile plus `endpoints` (`public_mcp`, `signed_in_mcp`, `public_dashboard`) built from the request's host |
| `list_products` | `info.listProducts(family)` | Families with products, each `lowest_monthly_fee` as `formatMoney` |
| `get_product` | `info.getProduct` | Plans with `monthly_fee`; `next` names `search_prices` and the signed-in connector; an unknown id is a tool error listing the known ones |
| `search_prices` | `info.getProduct` (validates `product_id`), `info.searchPrices` | `count`, `prices` with `amount`; `max_amount` in cents (D-1); no match is a success whose `next` says which filter to drop |
| `find_branches` | `info.findBranches` | `cities` always, `branches`; no match names the cities served |
| `get_branch` | `info.getBranch` | Address, hours, services, ATMs; `next` points a banker or appointment at the signed-in connector |

## The intent classifier (`intent.ts`)
Scores five workflows (`spend_analysis`, `card_control`, `payment`, `balance_check`, `exploration`) from `TOOL_WEIGHTS` over the session's last `intentHistoryLength` tools (the current tool counts double) plus 1.5 per matched `RATIONALE_PATTERNS` family.
`confidence = 0.4 + 0.45 x margin`, clamped to `[0.4, 0.95]`; nothing scoring is `unknown` at 0.2; ties break on the fixed workflow order.
`observe` returns an inference only when the label changed, or when a closing tool (`clear_table`, `lock_or_unlock_card`, `create_transfer`) ran with a new history.
History is per `xs` (falling back to `grant_id`) in a `BoundedMap` of `maxIntentSessions`.

## Events owned
- `intent.declared` - `text` (<= 1024 chars), `source: 'rationale'`, `model_authored: true`, `tool`, `truncated`.
- `intent.missing` - `tool`, `reason` (`absent` | `empty` | `wrong_type`).
- `intent.inferred` - `workflow`, `confidence`, `source: 'classifier'`, `model_authored: false`, `tools`.
- `tool.call.denied` - `tool`, `denied_reason` (`insufficient_scope` | `feature_flag`), `required_scopes`, `missing_scopes`, `status: 403`.
- `catalog.availability` - `content_hash`, `availability`, `feature_flags`, `source: 'get_tool_availability'`.
Every event carries `correlationOf(auth, requestId)`: `xs`, `login_id`, `grant_id`, `persona_id`, `client`, `request_id`. `tool.call.started` / `completed` are emitted by `mcp` (payload fields from `describeToolCall`), `bank.op` by `bank-core`, `etl.*` / `sql.*` by `etl`.

## Invariants held here
- Invariant 9: a missing `rationale` runs the tool and emits `intent.missing`; every failure is `isError: true` with Ramp's wording, never a JSON-RPC code (A-08).
- Invariant 5: scope and flag are re-checked on every call and a miss emits `tool.call.denied`.
- Invariant 8: no SQL runs here; `execute_query` hands the statement to the injected `ScratchDb`.
- Invariant 16: `bankScopeOf` keys the overlay by `login_id`, deriving `lgn_g<grant suffix>` for a grant without one, so two login-less grants never share an overlay.
- Invariant 14: previews and classifier history are bounded; a load past `maxPagesPerLoad` fails with `TOO_MANY_PAGES_MESSAGE` rather than returning a partial table. The preview store is keyed by the transfer itself, so an approval cannot be spent on a different amount or payee.

## How to test
```
npx vitest run src/tools    # 136 tests, 10 files, about 0.6 s
```
`__tests__/fakes.ts` is a byte-for-byte copy of `src/testing/fakes.ts` (the import rules allow this block only `src/contracts`); `fakes-are-a-copy.test.ts` fails if they drift.

## Known gaps
- `memo` reaches `bank.previewTransfer` only; `bank-core` writes `memo: null` on the confirmed transfer, so a memo never lands on `Transfer.memo`.
- `src/testing/fakes.ts` `bankScopeOf` still maps a `login_id: null` grant to `lgn_anonymous`, unlike `scope.ts`; the `ANONYMOUS_LOGIN_ID` comment in `types.ts` describes that old rule.
- `intent.inferred` is emitted inside `call()`, so it precedes the `tool.call.completed` that `mcp` emits; `test/fixtures/events.jsonl` records the opposite order.
- Public calls emit `intent.declared` / `intent.missing` but never `intent.inferred`: the classifier's five workflows are about a customer's own data.
- The classifier is keyword-based and English-only; a rationale in another language (Codex sent Portuguese) contributes nothing and the label rests on the tool sequence.
