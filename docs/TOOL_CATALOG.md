# Tool catalog

Source of truth: `src/contracts/tools.ts` (`TOOL_CATALOG`, 17 entries in `tools/list` order), `src/contracts/scopes.ts`, and for the sign-in-free endpoint `src/contracts/public.ts` (`PUBLIC_TOOL_CATALOG`, 6 entries, section 8). Contracts are v0.7 and append-only. Ramp lineage per tool: `docs/RAMP_REFERENCE.md`. Tests: `npx vitest run test/contracts src/tools`.

## 1. Conventions that apply to every tool

| Rule | Detail |
|---|---|
| Name | snake_case, <= 64 characters; the catalog order is deterministic (it feeds `content_hash` and the client's prompt cache). |
| `title` | Set on the entry and repeated in `annotations.title`. |
| Annotations (`ToolAnnotations`) | Exactly one of `readOnlyHint: true` / `destructiveHint: true`; `idempotentHint` explicit; `openWorldHint: false`. Scratch-database tools are read-only with respect to bank state (A-07). |
| Description | When to use, when not to, the preferred alternative; every `load_*` ends with `LOAD_TOOL_SUFFIX` ("never the rows themselves"). |
| Parameters | A description on each. Dates `YYYY-MM-DD` in UTC, `to_date` inclusive (the server adds one day). Optional enums accept `""` = no filter (`EMPTY_ENUM_DESCRIPTION`). Amounts are integer USD cents: `AMOUNT_DESCRIPTION` = "The amount is an integer in smallest denomination to avoid precision loss. So 1000 refers to 1000 cents or $10.00" (D-1). |
| `rationale` (ADR-8, A-06) | Published schema (`publishedInputSchema`): in `required`, `minLength 1`, `maxLength 1024`, description verbatim from Ramp: "Briefly explain why you are calling this tool: what goal or workflow it serves and what you intend to do with the result". Lenient schema (`lenientInputSchema`, what `src/tools` validates with): optional, truncated to 1024, a wrong type becomes `undefined`. The handler always runs; `src/tools/rationale.ts` strips the value off the arguments and emits `intent.declared` or `intent.missing {reason: absent / empty / wrong_type}`. `src/mcp` registers tools from the raw published schema through the low-level `Server` + `setRequestHandler` (CLAUDE.md invariant 9). |
| Ramp metadata (`RampToolMetadata`) | `x-read-only`: `true` / `partial` (mutates only the caller's scratch database) / `false`; `x-destructive`; `x-gated-by` (feature flags). |
| `redactionDenyList` | Leaf keys the X-ray emitter replaces with `[redacted]` in `tool.call.started.arguments`, any depth, case-insensitive; a deny-list, never an allow-list. Account fields = `account_number routing_number iban swift`; card fields = `card_number pan cvv cvc pin`. `GLOBAL_REDACTION_PATTERNS` (`mockbank_user_tok_...`, `eyJ...` JWTs, `Bearer ...`) apply to every value. |
| Errors (A-08) | `toolError(message)` -> `isError: true`, text `Ran into an error: {message}. Communicate this to the user and consider retrying if the error seems transient.` JSON-RPC codes (`-32601`, `-32602`, `-32603`) only for malformed JSON-RPC or an unknown / flag-disabled tool. |
| Size and time | `execute_query` returns at most `MAX_QUERY_ROWS` (100) rows and refuses a text result over `content_cap` (150,000 chars); every call is measured against `budget_ms` 300,000 on the X-ray. Load tools return no rows; they page `BankCore` at 500 rows, at most 100 pages ("Too many pages, try to filter more results out."). |
| Rate limit | `RATE_LIMIT_GRANT_TOOL_CALLS` (120 `tools/call` per grant per minute, `src/mcp/index.ts`) -> 429, `Retry-After: 60`, `tool.call.denied {rate_limited}`. |

## 2. Scopes (`src/contracts/scopes.ts`)

`SCOPES` in consent-page order. `profile` is implicit in every grant. Listing rule (ADR-13, `isListed`): a tool is listed when its feature flags are on and every scope it is missing is a `*:write` scope; a missing read scope hides it, a missing write scope leaves it listed but unavailable so the 403 step-up can fire. The 401 challenge hint and the consent pre-checks are both `READ_SCOPES`.

| Scope | Unlocks (`SCOPE_TO_TOOLS`) | In the default challenge set |
|---|---|---|
| `profile` | `get_current_user`, `get_tool_availability` | yes (implicit anyway) |
| `accounts:read` | `load_accounts` | yes |
| `transactions:read` | `load_transactions`, `load_statement_lines` | yes |
| `cards:read` | `load_cards` | yes |
| `cards:write` | `lock_or_unlock_card` | no - step-up only |
| `transfers:read` | `load_transfers`, `load_statement_lines` | yes |
| `transfers:write` | `create_transfer` | no - step-up only |
| `bills:read` | `load_bills`, `load_statement_lines` | yes |
| `payees:read` | `load_payees` | yes |
| `xray:read` | `xray_get_session_link` | yes |

- `auth_level` is `read_write` when any `*:write` scope is granted, else `read_only` (`authLevelForScopes`). Read-only refresh tokens live 7 days, read-write ones 24 hours.
- Feature flags `writes`, `transfers` (`FEATURE_FLAGS`, `;`-separated env, both on by default, D-3). `scopes_supported` in the AS metadata lists write scopes only when `writes` is on (`supportedScopes`).
- 401 (`sendUnauthorized`, `src/mcp/gate.ts`): `WWW-Authenticate: Bearer [error="<rfc6750 code>", ]resource_metadata="<base>/.well-known/oauth-protected-resource/mcp", scope="<READ_SCOPES>"`. Absent or bad bearer never answers `200` + `isError` (invariant 5).
- 403 step-up (`scopeDenial` -> `sendInsufficientScope`): the gate parses `params.name` from the body before the SDK. Header `Bearer error="insufficient_scope", scope="...", resource_metadata="..."` where `scope` = every still-needed write scope of the flag-enabled catalog plus this tool's own missing scopes, intersected with `supportedScopes` (Claude does not carry earlier step-up scopes forward). Body `{error: "insufficient_scope", error_description}` is written from the tool's own missing scopes. Emits `tool.call.denied {insufficient_scope}` and `auth.stepup.requested`. Re-consent from the same browser extends the same `grant_id` (`auth.grant.updated {step_up}`, ADR-14). A tool whose flag is off is treated as unknown (`-32601`), never challenged.
- `src/tools/registry.ts` re-checks flags and scopes as defence in depth (`tool.call.denied` + tool error).

## 3. The catalog (`tools/list` order)

Every tool also takes `rationale`. Hints: R = `readOnlyHint`, D = `destructiveHint`, I = `idempotentHint: true`. `*` = required in the published schema.

| # | Tool | Title | Kind | Hints | Scopes | Flags | Parameters (published) |
|---|---|---|---|---|---|---|---|
| 1 | `process_data` | Build a SQL table from loaded data | database | R I | - | - | `table_name*`, `cols*: string[]` (advertised names, nested keys joined with `__`) |
| 2 | `execute_query` | Run a read-only SQL query | database | R | - | - | `table_name*`, `query*` (one SQLite SELECT) |
| 3 | `clear_table` | Drop a scratch table | database | R I | - | - | `table_name*` |
| 4 | `get_bank_categories` | List merchant categories | fetch | R I | - | - | none (43 categories, `BANK_CATEGORIES`) |
| 5 | `get_currencies` | List supported currencies | fetch | R I | - | - | none (`BANK_CURRENCIES`, USD first; no conversion) |
| 6 | `get_current_user` | Show the connected demo customer | fetch | R I | `profile` | - | none; returns `persona_id`, `persona_name`, `persona_kind`, `shared_persona`, `login_id`, `grant_id`, `scopes`, `auth_level`, `token_expires_at`, `xray_session_id`, `boot_id` (A-15) |
| 7 | `get_tool_availability` | Explain which tools are usable | meta | R I | `profile` | - | none; returns the section 4 table and emits `catalog.availability {source: get_tool_availability}` |
| 8 | `load_accounts` | Load bank accounts | load | R I | `accounts:read` | - | `account_id`, `account_type: checking / savings / credit_card / ""` |
| 9 | `load_transactions` | Load card and account transactions | load | R I | `transactions:read` | - | `from_date*`, `to_date*`, `account_id`, `card_id`, `category_ids: string[]`, `status: pending / posted / declined / ""` |
| 10 | `load_cards` | Load payment cards | load | R I | `cards:read` | - | `account_id`, `status: active / locked / fraud_locked / ""` |
| 11 | `load_transfers` | Load transfers | load | R I | `transfers:read` | - | `from_date*`, `to_date*`, `direction: outgoing / incoming / ""`, `status: scheduled / completed / failed / ""` |
| 12 | `load_bills` | Load bills | load | R I | `bills:read` | - | `from_date*`, `to_date*` (due dates), `payment_status: open / paid / overdue / ""` |
| 13 | `load_payees` | Load saved payees | load | R I | `payees:read` | - | `name` (substring), `is_active: boolean = true` |
| 14 | `load_statement_lines` | Load a combined statement | load | R I | `transactions:read` + `transfers:read` + `bills:read` | - | `from_date*`, `to_date*` |
| 15 | `lock_or_unlock_card` | Lock or unlock a card | write | D I | `cards:write` | `writes` | `card_id*`, `action*: lock / unlock` |
| 16 | `create_transfer` | Preview and send a transfer | write | D | `transfers:write` | `writes`, `transfers` | `from_account_id*`, `to*: {payee_id} / {account_id}` (oneOf), `amount*` (int >= 1), `currency*` (`^[A-Z]{3}$`), `memo` (<= 140), `confirm = false`, `expected_total_amount` (int >= 1) |
| 17 | `xray_get_session_link` | Get the X-ray dashboard link | xray | R | `xray:read` | - | none; returns `{code, url, expires_at}` for the caller's login (tool error when the grant has no `login_id`) |

Deny-lists: account fields on 8, 11, 13; card fields on 9, 10, 15; both on 14 and 16; empty elsewhere. `x-read-only` is `partial` on 1 and 3, `false` on 15 and 16, `true` otherwise. A `fraud_locked` card cannot be unlocked (tool error); locking an already locked card changes nothing and still appends an audit entry.

## 4. Availability vocabulary (`src/tools/availability.ts`)

`get_tool_availability` returns `{content_hash, tools[], feature_flags[]}` (`AvailabilityTable`) as `structuredContent`; `catalog.tools_listed` and `catalog.availability` carry the same rows as `availability[]` beside `content_hash` and `feature_flags[]`. `content_hash` = first 16 hex characters of sha256 over `canonicalCatalogSnapshot(listed entries, flags)`, which covers membership, required scopes and feature flags only: a reworded description or a changed parameter leaves it identical. `input_schema_hash` per row tracks the schema, and since contracts v0.5 the optional `descriptor` per row records the wording and the schema as the client received them. One row per catalog entry, listed or not (`catalogAvailability`):

```json
{ "tool": "create_transfer", "listed": true, "available": false, "unavailable_reasons": ["missing_scopes"], "missing_scopes": ["transfers:write"] }
```

- `listed`: flags on and every missing scope is a write scope. `available`: flags on and nothing missing.
- `unavailable_reasons`: `missing_scopes`; `disabled_for_deployment` (a flag is off; `listed: false`, `missing_scopes: []`); `authorization_level_not_allowed` exists in the schema and is never produced.

## 5. Server instructions (`src/mcp/instructions.ts`)

`SERVER_INSTRUCTIONS`, sent in `InitializeResult` (whether claude.ai forwards it is unknown, A-05, so tool descriptions repeat every point); `serverInfo` = `{name: "glass-bank", title: "Glass Bank", version: "0.1.0"}`:

> Glass Bank is a fictional bank; every account, card, transaction and person is fake demo data. Amounts are integers in minor units (1000 = $10.00). For performance, always load all the data you need first with the `load_*` tools, then call `process_data` to build tables, then run SQL with `execute_query`; prefer window functions and make sure calculations are accurate. Prefer `load_statement_lines` over separate loads when possible. Clear tables you no longer need. Always fill `rationale` with what the user asked for and why this call serves it. Write tools change the customer's accounts: preview `create_transfer` first and confirm only with the user's explicit approval. If the user wants to see what is happening behind the scenes, call `xray_get_session_link` and show them the link.

## 6. ETL protocol strings

Defined in `src/contracts/tools.ts` (copied from Ramp, see `THIRD_PARTY_NOTICES.md`); used by `src/tools/handlers/load.ts`, `database.ts`, `errors.ts` and `src/etl/scratch-db.ts`. `loadResultText` is the success text of every `load_*`; columns are the union of keys across all rows, nested keys joined with `__`:

```
Stored data in memory database with table name: {table_name}.
 Call `process_data` tool with table name and desired columns to setup a SQL table.
 Call `execute_query` tool with query to get results as a JSON.
 Available columns are: {col_a, col_b, ...}
 Call `clear_table` tool with table name to delete the table from the memory database.
```

| Constant | Text |
|---|---|
| `NO_DATA_FOUND` | `No data found` |
| `processedTableText(t)` | `Table {t} created` |
| `clearedTableText(t)` | `Table {t} cleared` |
| `rowCapMessage(100)` | `Query returned more than 100 rows: add filters and retry` |
| `TOO_MANY_TABLES_MESSAGE` | `too many tables loaded: ask the agent to drop unused tables` |
| `ETL_OPERATION_LIMIT_MESSAGE` | `ETL operation limit reached` |
| `TOO_MANY_PAGES_MESSAGE` (`src/tools/errors.ts`) | `Too many pages, try to filter more results out.` |

Knobs (`TOOL_LIMIT_DEFAULTS`; env names in `.env.example`): `MAX_TABLES_PER_GRANT=10`, `MAX_SCRATCH_DBS=200`, `MAX_QUERY_ROWS=100`, `TABLE_TTL_MINUTES=30`, `QUERY_TIMEOUT_MS=2000`, `MAX_CONCURRENT_ETL_OPS=2`, `ETL_WORKER_POOL_SIZE=4`, `MAX_QUERY_TIMEOUTS=3`. The guard itself (forked `src/etl/sql-runner.ts` killed with SIGKILL on timeout, `PRAGMA query_only`, token scan, quoted identifiers, caps and evictions) is CLAUDE.md invariant 8 and `docs/blocks/etl.md`; after a teardown the model is told to reload (`RELOAD_AFTER_TEARDOWN`).

## 7. `create_transfer` two-step choreography (`src/tools/handlers/writes.ts`, `previews.ts`)

1. Call without `confirm`: `bank.previewTransfer` (`bank.op {transfer.preview}`). A `policy_outlook.status` of `blocked` is a tool error, never a confirmable preview.
2. The preview is remembered under the key `login | from_account_id | to | amount | currency` (the schema has no `preview_id`; `memo` is not part of the key; LRU of 200 open previews). The text ends with "call create_transfer again with the same arguments plus confirm set to true and expected_total_amount set to {N}" and the preview's `expires_at`; `structuredContent.confirmed = false`.
3. The user approves in chat; the server cannot see that.
4. Call with `confirm: true`: missing `expected_total_amount` -> tool error; no open preview for that exact key -> tool error ("call create_transfer without confirm first").
5. `bank.confirmTransfer(preview_id, expected_total_amount)`: `repriced` -> the new quote replaces the open preview and the error names the new total; `unknown_preview` / `expired_preview` -> the preview is forgotten; insufficient funds or over the per-transfer limit -> tool error.
6. Success: `bank.op {transfer.confirm, audit_id}`, preview forgotten, text `Transfer {id} is {status}.` with amount, fee, total and the audit id; `structuredContent.confirmed = true`.

`lock_or_unlock_card` is single-step. Previews are keyed by login, not grant, so a step-up or a reconnect can still confirm (ADR-14).

## 8. The public lane (`src/contracts/public.ts`, D-26, ADR-19)

A second endpoint, `POST /public/mcp`, needs no sign-in and never challenges. It lists six tools, all read-only, with no scope and no flag, and they obey every rule of section 1 (`test/contracts/tool-catalog.test.ts` runs the same checks over them). Each description ends with `PUBLIC_LANE_NOTICE`: "This is the public endpoint, which needs no sign-in: every call to it, rationale included, is shown on a public dashboard, so never put personal details in the arguments or the rationale." The data is `bankCore.publicInfo` (`src/bank-core/public-catalog.ts`); the handlers are `src/tools/public.ts`.

| Level | Tool | Arguments besides `rationale` | Answers |
|---|---|---|---|
| 0 | `get_bank_profile` | - | Purpose, differentiators, what is public and what needs a sign-in, `endpoints` (`public_mcp`, `signed_in_mcp`, `public_dashboard`) |
| 1 | `list_products` | `family` (`accounts` / `cards` / `business` / `""`) | Families with their products: `product_id`, summary, `lowest_monthly_fee` in cents, `plan_count` |
| 2 | `get_product` | `product_id` (required) | The product with its plans (`plan_id`, `monthly_fee`, headline, highlights), eligibility, what needs a sign-in |
| 3 | `search_prices` | `product_id`, `plan_id`, `kind` (six kinds or `""`), `query` (every word must match), `max_amount` (cents; drops rates) | `count` and every matching price line: amount in cents or rate in basis points, `display`, `applies`, `waiver` |
| 1 | `find_branches` | `city` (case-insensitive), `service` (seven services or `""`) | `cities` served and the matching locations: `branch_id`, kind, services |
| 2 | `get_branch` | `branch_id` (required) | Address, time zone, seven days of hours, services, ATM count, accessibility, languages |

- Every answer is compact JSON with `next`: the call one level deeper, or, when the question turns to a customer's own data, "the user adds the connector `<base>/mcp` and logs in there", with the host the visitor used. That sentence is the whole hand-off from the public lane to the signed-in one: the lane never answers 401, because a client that connected without a challenge does not reliably turn a later one into a login (A-47).
- An unknown `product_id` or `branch_id` is a tool error listing what exists; a search with no match is a success whose `next` names the filter to drop.
- A signed-in tool name called here is an unknown tool (`-32601`).
- Rate limits, `tools/call` only: `RATE_LIMIT_PUBLIC_IP_TOOL_CALLS` (60 per IP prefix per minute) and `RATE_LIMIT_PUBLIC_TOOL_CALLS` (600 per minute for the whole lane) -> 429, `Retry-After: 60`, `tool.call.denied {rate_limited}`. `initialize` and `tools/list` are never limited.
- `PUBLIC_SERVER_INSTRUCTIONS` (`serverInfo` = `{name: "glass-bank-public", title: "Glass Bank (public)", version: "0.1.0"}`):

> Glass Bank is a fictional bank. This is its public endpoint: no sign-in, and only what the bank publishes - its profile, its products with every plan and price, and its branches. Go from general to specific: list_products, then get_product, then search_prices; find_branches, then get_branch. Amounts are integers in minor units (1000 = $10.00). A customer's own accounts, cards, transactions and transfers are not here: they need the signed-in connector at /mcp on the same host, which the user adds and logs in to. Always fill `rationale` with what the user asked for and why this call serves it. Every call to this endpoint, rationale included, is shown on a public dashboard, so never put personal details in the arguments or the rationale.
