# Ramp reference: what we copy, what we adapt, what we assume

What Ramp's MCP work does (open-source and hosted), the captured Ramp catalogs, and the ledger mapping every
Ramp entity, tool and convention to its Glass Bank counterpart. Verdicts: **copied** = same name and semantics
with primary evidence; **adapted** = Ramp pattern with a bank rename or a fix; **assumed** = no Ramp evidence.
Copied fragments and their MIT notice are in `THIRD_PARTY_NOTICES.md`.

## 1. Sources

| Source | What it is |
|---|---|
| `github.com/ramp-public/ramp_mcp` | Ramp's open-source MCP server: Python FastMCP, stdio only, MIT, version 0.0.1, one commit (2025-03-20), no tests; archived read-only 2026-07-17 |
| `builders.ramp.com/post/ramp-mcp` (2025-03-25) | The design post behind the ETL-to-SQLite pattern |
| `mcp.ramp.com/mcp`, `demo-mcp.ramp.com/mcp` | The hosted remote server (Streamable HTTP, OAuth 2.1); `ramp-mcp-remote.ramp.com/mcp` is the legacy host |
| `docs.ramp.com/llms-guides/*.txt`, `agents.ramp.com` | Machine-readable docs for MCP, CLI, identity and limits |
| `ramp-public/ramp-cli` `src/ramp_cli/specs/agent-tool.json` | OpenAPI catalog of 133 "Agent Tools" with `x-platforms`, `x-gated-by`, `x-read-only`, `x-destructive`, `x-alias` and the universal `rationale` parameter |
| `claude.com/connectors/ramp`, a directory mirror (2026-01-16) | The connector listing and the last public snapshot of the hosted tool names |

Ramp publishes nothing about the hosted server's hosting, session storage or observability.

## 2. The open-source server

- Pattern: `load_*` pulls a Developer API list endpoint page by page, stores the raw JSON under `{tool}_{uuid4hex}` and returns only an instruction string; `process_data(table_name, cols)` flattens nested keys with `__`, infers INTEGER / TEXT / REAL (lists as JSON text, missing keys NULL) and creates the table; `execute_query(table_name, query)` runs arbitrary SQLite SQL and returns every row; `clear_table` drops it.
- Instruction string: "Stored data in memory database with table name: ... Call `process_data` ... Call `execute_query` ... Available columns are: ... Call `clear_table` ..."; empty result "No data found".
- Conventions: snake_case tool = function name; tools registered per granted `resource:read` scope (12 scopes), unknown scopes skipped; `load_spend_export` needs `transactions:read` + `reimbursements:read` + `bills:read`; dates `YYYY-MM-DD` with one day added to the end date; `AMOUNT_DESCRIPTION` ("integer in smallest denomination ... 1000 refers to 1000 cents or $10.00"); `""` means null; transactions always `order_by_amount_desc`; errors returned as a *successful* string "Ran into an error: ... Communicate this to the user and consider retrying if the error seems transient."; `CLIENT_MAX_PAGES = 100` -> "Too many pages, try to filter more results out."; a hard-coded 43-entry `SK_CATEGORIES` dict served without an API call; `get_currencies` from the `iso4217` enum.
- Server `instructions`: load all data first, use window functions, keep calculations accurate.
- Auth: client-credentials token fetched once at startup, no refresh; stdio only; no identity, sessions, logging or telemetry.

### 2.1 OSS defects and where each is avoided here

| # | Defect | Avoided by |
|---|---|---|
| 1 | Five tools use f-string docstrings, so their description is `None` | Explicit description strings in `src/contracts/tools.ts`; `test/contracts/tool-catalog.test.ts` requires > 200 characters and no `{template}` braces |
| 2 | No parameter descriptions | A `description` on every parameter at every depth, asserted in `src/tools/__tests__/catalog.test.ts` |
| 3 | `load_bills` parameter misspelled `acccounting_sync_ready` | Not carried over (`grep acccounting src` is empty) |
| 4 | `load_bank_accounts(bank_account_id)` required but treated as optional | `load_accounts.account_id` is `z.string().min(1).optional()` in `src/contracts/tools.ts` |
| 5 | Columns discovered from `data[0]` only | Union of keys across every row, `src/etl/rows.ts` |
| 6 | `INSERT INTO {table}` / `DROP TABLE {table}` interpolate model-supplied names unquoted | `quoteIdentifier` (`src/etl/sql-text.ts`) on every identifier in `src/etl/sql-runner.ts`; unknown tables refused by `src/etl/scratch-db.ts` |
| 7 | `execute_query` runs arbitrary SQL; `ATTACH DATABASE` + `CREATE TABLE ... AS SELECT` writes files to disk | `SQL_DENYLIST_TOKENS` (attach, detach, pragma, vacuum) and the single-statement rule in `src/etl/sql-text.ts`; `PRAGMA query_only = 1` and `Statement.readonly` in `src/etl/sql-runner.ts`; the forked runner is `SIGKILL`ed on timeout (`src/etl/runner-pool.ts`); tests `src/etl/__tests__/sql-text.test.ts`, `runner-guard.test.ts`, `timeout.test.ts` |
| 8 | No row cap on results | `MAX_QUERY_ROWS` (100) with `rowCapMessage` ("add filters and retry") in `src/contracts/tools.ts` |
| 9 | `_table_last_access` recorded but unused; no TTL, eviction or table cap | `TABLE_TTL_MINUTES`, `MAX_TABLES_PER_GRANT`, `MAX_SCRATCH_DBS` with LRU in `src/etl/scratch-db.ts`; `TOO_MANY_TABLES_MESSAGE`; `etl.table_evicted` |
| 10 | Misleading messages: unknown table "already processed" / "cleared", empty `cols` a SQL syntax error, unknown columns silently dropped | "no table named ..." from `src/etl/scratch-db.ts`; empty `cols` explained in `src/tools/handlers/database.ts`; `unknown_column` rejection in `src/etl/sql-runner.ts` |
| 11 | Naive `datetime.astimezone(utc)` shifts instants with the host timezone | `Date.UTC` only, `src/bank-core/dates.ts` |
| 12 | httpx's default 5 s timeout inherited silently | Not applicable: bank-core is in-process; the only budget is `QUERY_TIMEOUT_MS` |
| 13 | README lists a `qa` environment the code rejects and omits two tools | `docs/TOOL_CATALOG.md` and the dashboard copy are checked against `src/contracts/tools.ts` by `test/contracts/tool-catalog.test.ts` and `public/__tests__/contract-copy.test.mjs` |
| 14 | `/spend-export` and `/limits` no longer exist in Ramp's public API; `/bank_accounts` is now `/bank-accounts` | Irrelevant to a mock; nothing is validated against Ramp's live API (A-35) |

## 3. The hosted server

- Discovery: `POST /mcp` without a token -> `401 {"detail":"No access token provided"}` + `WWW-Authenticate: Bearer resource_metadata="https://mcp.ramp.com/.well-known/oauth-protected-resource/mcp"`; PRM with `resource`, `authorization_servers`, `bearer_methods_supported: ["header"]` and 53 scopes; AS metadata with `response_types ["code"]`, `grant_types ["authorization_code","refresh_token"]`, `token_endpoint_auth_methods_supported ["none"]`, `code_challenge_methods_supported ["S256"]`, a `registration_endpoint` and a `revocation_endpoint`; the initialize response reports protocol `2025-06-18` and issues an `mcp-session-id`.
- Identity: the agent acts as the user who completed browser OAuth, never above their role; every write lands in the audit log; read-only sessions expire 7 days after last use, read-write 24 hours; access tokens 1 h, codes 10 min, tokens prefixed `ramp_user_tok_`; custom clients need an exact-match redirect URI (https, localhost or 127.0.0.1); `https://mcp.ramp.com/<alias>/mcp` gives each client its own session.
- Tool surface: the ETL family survives ("Query result cap: 100 rows per MCP query", "ETL operation limit reached", "too many tables loaded"); the 2026-01 snapshot listed 17 MCP tools (`execute_query`, `clear_table`, `load_spend_export`, `load_spend_exports`, `load_purchase_orders`, `load_cards`, `load_limits`, `load_entities`, `load_departments`, `load_users`, `load_memos`, `load_locations`, `load_spend_programs`, `load_vendors`, `get_ramp_categories`, `submit_feedback`, `get_current_user`); beyond that 133 generated Agent Tools plus a read-only DuckDB "Analyst" layer gated on reading its docs first (`docs_required`).
- `rationale`: required (string, 1-1024) on every agent tool, description "Briefly explain why you are calling this tool: what goal or workflow it serves and what you intend to do with the result"; missing -> HTTP 422. Approval tools also require `thoughts` and pass the user's justification verbatim as `user_reason`.
- Availability: `GET /developer/v1/agent-tools/availability` returns `{operation_id, available, unavailable_reasons[], missing_scopes[]}` plus a `content_hash`; reasons `disabled_for_business`, `platform_not_allowed`, `authorization_level_not_allowed`, `missing_scopes`.
- Write safety: per-business feature flags (`x-gated-by`); `x-read-only` tri-state; `x-destructive` only on `submit-hotel-booking`, a two-step flow (preview, then `confirm=true` with the previewed `expected_total_amount`, rejected if repriced); explicit user consent before any mutation. Descriptions say when to use, when not to, list trigger phrases and point to the preferred alternative; prerequisite ordering is enforced server-side.

## 4. Captured Ramp catalogs

### 4.1 Open-source server (19 functions: 5 always registered, 14 scope-gated)

| Tool | Scope | Parameters |
|---|---|---|
| `clear_table`, `process_data`, `execute_query` | always | `table_name`; `table_name, cols[]`; `table_name, query` (arbitrary SQL, all rows) |
| `get_ramp_categories`, `get_currencies` | always | - (43 hard-coded categories; iso4217) |
| `load_transactions` | `transactions:read` | `from_date, to_date, user_id?, card_id?, ramp_category_ids=[], accounting_sync_ready?`; always amount-desc |
| `load_spend_export` | `transactions:read` + `reimbursements:read` + `bills:read` | `from_date, to_date`; "Always use this over load_transactions, load_reimbursements, load_bills, etc. when possible" |
| `load_receipts` | `receipts:read` | `from_date, to_date, transaction_id?, created_before?, created_after?` |
| `load_reimbursements` | `reimbursements:read` | `from_date, to_date, sync_ready?, direction: BUSINESS_TO_USER \| USER_TO_BUSINESS \| "", user_id?` |
| `load_bills` | `bills:read` | `from_date, to_date, payment_status: OPEN \| PAID \| "", user_id?, acccounting_sync_ready?` |
| `load_bank_accounts` | `bank_accounts:read` | `bank_account_id` (required by mistake) |
| `load_vendors`, `load_vendor_bank_accounts` | `vendors:read` | `ramp_category_ids=[], is_active=True, name?, from_created_at?, to_created_at?`; `vendor_id` |
| `load_locations`, `load_departments`, `load_entities`, `load_spend_programs`, `load_spend_limits` | `locations:read`, `departments:read`, `entities:read`, `spend_programs:read`, `limits:read` | `entity_id?`; -; `entity_name?`; -; `user_id?` |
| `load_users` | `users:read` | `email?, role: IT_ADMIN \| BUSINESS_ADMIN \| BUSINESS_OWNER \| BUSINESS_USER \| GUEST_USER \| ""` |

### 4.2 Hosted agent-tool families relevant to a bank

| Family | Representative operations | Scope | Pattern |
|---|---|---|---|
| Transactions | get-transactions (page_size 1-200; "Use analyst tools instead for aggregate spend analysis"), get-decline-explanation | `transactions:read` | read |
| Treasury | get-ramp-business-account-balance, get-account-balance-history, list-business-accounts, list-wallet-transfers | `treasury:read` | read |
| Cards | activate-card, lock-or-unlock-card, unlock-fraud-locked-card | `cards:write` | own cards unless admin; audit log |
| Limits / funds | update-transaction-amount-limit, limit-increase, issue-one-off-funds | `limits:write`, `funds:write` | role + gating |
| Approvals | approve-or-reject-transaction, approve-or-reject-request | `transactions:write`, `approvals:write` | `thoughts` required, verbatim `user_reason` |
| Bills / vendors | search-bills, get-bill-details, search-vendors, create-pending-payee | `bills:read`, `vendors:read/write` | read; gated write |
| Travel | search-hotel, get-hotel-rates (`x-read-only`), submit-hotel-booking (`x-destructive`) | `trips:write` | preview then confirm |
| Analyst | get-analyst-catalog, get-analyst-table-domain-docs, execute-analyst-query | `accounting:read` | read-only DuckDB, `docs_required` |
| Identity / meta | get-simplified-user-detail (= `get_current_user`), get-attention-feed, submit_feedback | `users:read`, `tasks:read`, none | read |

## 5. Mapping ledger

### 5.1 Entities

| Ramp | Glass Bank | Verdict |
|---|---|---|
| users (+ role enum) | `Persona` (`kind: retail \| business`, no role gating, A-33) | adapted |
| OAuth session (7 d / 24 h idle) | `Grant` (scopes, `auth_level`, client); expiry as refresh lifetime (A-26) | adapted |
| bank_accounts / entities / treasury accounts | `Account` (checking, savings, credit card; integer cents) | adapted |
| cards (`load_cards`, `lock-or-unlock-card`) | `Card` (`active \| locked \| fraud_locked`) | copied states |
| transactions (`order_by_amount_desc`, category ids, state, merchant, decline reason) | `Transaction` (`pending \| posted \| declined`) | adapted |
| reimbursements, bill payments | `Transfer` (internal or to a payee; preview then confirm) | assumed |
| vendors / vendor bank accounts | `Payee` (masked account) | adapted |
| bills (`OPEN \| PAID`) | `Bill` (`open \| paid \| overdue`) | adapted |
| spend-export | `statement_lines` (union of transactions, transfers, bills) | adapted |
| `SK_CATEGORIES` (43) | `BANK_CATEGORIES`, same ids and names | copied |
| iso4217 currencies | five-currency list, USD first | adapted |
| audit log | `AuditEntry` per write plus the X-ray event log | adapted |
| departments, locations, receipts, purchase orders, travel, procurement, memos, x402 | dropped | - |

### 5.2 Tools

| Ramp | Glass Bank | Verdict |
|---|---|---|
| `process_data`, `execute_query`, `clear_table` | same names | copied, fixed (defects 5-10) |
| `get_ramp_categories`, `get_currencies` | `get_bank_categories`, `get_currencies` | copied (one renamed) |
| `get_current_user` (hosted) | `get_current_user` (persona, scopes, `auth_level`, expiry, `xs`, `boot_id`) | adapted |
| `/agent-tools/availability` (REST) | `get_tool_availability` tool; same fields, also in `catalog.tools_listed` | adapted |
| `load_bank_accounts`, `load_cards` (hosted) | `load_accounts` (`account_id?`, `account_type?`), `load_cards` | adapted |
| `load_transactions` | `load_transactions` (same date rules, amount-desc) | adapted |
| `load_reimbursements` | `load_transfers` (`direction: outgoing \| incoming \| ""`) | adapted |
| `load_bills` | `load_bills` (typo fixed) | adapted |
| `load_vendors` | `load_payees` (`is_active` default true) | adapted |
| `load_spend_export` | `load_statement_lines` (three read scopes; "Always use this over load_transactions, load_transfers, load_bills when possible") | adapted |
| `lock-or-unlock-card` (hosted) | `lock_or_unlock_card` (`cards:write`, `destructiveHint`, `writes` flag) | adapted |
| `submit-hotel-booking` two-step | `create_transfer` (preview, then `confirm=true` + `expected_total_amount`) | adapted |
| `submit_feedback`, approvals, limits, attention feed, Analyst layer | not in v1 | - |
| - | `xray_get_session_link` | assumed |

### 5.3 Conventions

| Ramp | Glass Bank | Verdict |
|---|---|---|
| snake_case, `load_<resource>` / `get_<reference>` grammar; descriptions say when to use, when not, and the alternative | same, asserted by `test/contracts/tool-catalog.test.ts` | copied |
| load -> process -> query -> clear protocol and instruction strings | same strings (`loadResultText`, `NO_DATA_FOUND`), columns from all rows | copied, fixed |
| `{tool}_{uuid4hex}` tables, `__` flattening, INTEGER / TEXT / REAL inference, lists as JSON text, missing keys NULL | same, with sparse columns typed from observed values (`src/etl/rows.ts`) | copied, fixed |
| `AMOUNT_DESCRIPTION`; `""` means null; `YYYY-MM-DD` with inclusive end date; amount-desc order | same | copied |
| `resource:read \| write` scopes; multi-scope export tool; `auth_level=auto` | 9 scopes in `src/contracts/scopes.ts`; `load_statement_lines` on three; `auth_level` derived from granted write scopes | adapted |
| Server `instructions` style | same style plus `rationale` and X-ray guidance (`src/mcp/instructions.ts`) | adapted |
| "Ran into an error: ..." returned as success text | same wording with `isError: true` (`toolErrorText`) | adapted |
| Hosted OAuth shape: 401 + PRM, RFC 8414, PKCE S256, public client, DCR, refresh, revocation; `{"detail":"No access token provided"}`; `ramp_user_tok_` prefix | same on one origin; same body; `mockbank_user_tok_` | copied |
| Mandatory `rationale` (1-1024, exact description); 422 when missing | same on every tool; soft-fail with `intent.missing` (A-06) | adapted |
| `x-gated-by`, `x-read-only`, `x-destructive` | feature flags and `readOnlyHint` / `destructiveHint` | adapted |
| Availability reasons `missing_scopes`, `disabled_for_business`, `authorization_level_not_allowed`, `platform_not_allowed` | `missing_scopes`, `disabled_for_deployment`, `authorization_level_not_allowed` (reserved) | adapted |
| 100-row cap, "ETL operation limit reached", "too many tables loaded"; `CLIENT_MAX_PAGES` + "Too many pages, try to filter more results out." | same messages as env knobs; `{data, page: {next}}` walked to `maxPagesPerLoad` (`TOO_MANY_PAGES_MESSAGE`) | copied |
| Preview-then-confirm with reprice guard; per-deployment flag | `create_transfer` | copied |
| `/<alias>/mcp` multi-session paths; admin "Manage Access" allow-list | not copied | - |
