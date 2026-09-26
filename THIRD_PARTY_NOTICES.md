# Third-party notices

This project is MIT (`LICENSE`, Decision D-8) and copies fragments from Ramp's open-source MCP server; the MIT License requires the notice below to accompany them. Add a row whenever a fragment is copied (CLAUDE.md "Do").

## ramp-public/ramp_mcp

Source: https://github.com/ramp-public/ramp_mcp (archived 2026-07-17), `LICENSE.txt`.

```
MIT License

Copyright (c) 2025 Ramp Business Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Copied or closely adapted fragments

| Fragment | Ramp source (file, function) | Where it lives here | Verdict |
|---|---|---|---|
| The 43-entry merchant category table (`SK_CATEGORIES`, ids 1-44 without 22) | `src/ramp_mcp/constants.py` | `BANK_CATEGORIES` in `src/bank-core/categories.ts`, served by `get_bank_categories` | copied verbatim |
| `AMOUNT_DESCRIPTION` ("The amount is an integer in smallest denomination to avoid precision loss. ...") | `src/ramp_mcp/constants.py` | `AMOUNT_DESCRIPTION` in `src/contracts/tools.ts` (example "1000 cents or $10.00", D-1) | copied, example adapted |
| Load-tool instruction string ("Stored data in memory database with table name: ... Call `process_data` ... Call `execute_query` ... Available columns are: ... Call `clear_table` ...") and "No data found" | `src/ramp_mcp/tools.py`, `handle_load_response` | `loadResultText`, `NO_DATA_FOUND`, `processedTableText`, `clearedTableText` in `src/contracts/tools.ts`; used by `src/tools/handlers/load.ts` | copied |
| Error wording "Ran into an error: {e}\nCommunicate this to the user and consider retrying if the error seems transient." | `src/ramp_mcp/tools.py`, `handle_response` | `toolErrorText` / `toolError` in `src/contracts/tools.ts`; `src/tools/errors.ts` | copied; `isError: true` added, newline replaced by a full stop |
| "Too many pages, try to filter more results out." | `src/ramp_mcp/tools.py` (`CLIENT_MAX_PAGES`) | `TOO_MANY_PAGES_MESSAGE` in `src/tools/errors.ts` | copied |
| "Always use this over load_transactions, load_reimbursements, load_bills, etc. when possible" | `src/ramp_mcp/tools.py`, `load_spend_export` | the `load_statement_lines` description in `src/contracts/tools.ts` | adapted (tool names) |
| Server `instructions` (load all data first, use window functions, keep calculations accurate) | `src/ramp_mcp/__init__.py`, `FastMCP(... instructions=...)` | `SERVER_INSTRUCTIONS` in `src/mcp/instructions.ts` | adapted and extended |
| In-memory ETL: `{tool}_{uuid4hex}` table names, `__` nested-key flattening, INTEGER/TEXT/REAL inference, lists as JSON text, missing keys NULL, `CREATE TABLE` + batched `INSERT` load, `DROP TABLE` | `src/ramp_mcp/memory_db.py` (`MemoryDatabase`), `src/ramp_mcp/utils.py` (`get_nested_keys`) | `src/etl/rows.ts`, `src/etl/scratch-db.ts`, `src/etl/sql-runner.ts` | ported with fixes (quoted identifiers, union of keys, guards) |
| Tool grammar: `load_<resource>` / `process_data` / `execute_query` / `clear_table` / `get_<reference>`, `""` means null, `YYYY-MM-DD` with a one-day inclusive end, `order_by_amount_desc` | `src/ramp_mcp/tools.py`, `types.py`, `utils.py` | `src/contracts/tools.ts`, `src/tools/handlers/load.ts`, `src/bank-core/queries.ts`, `src/bank-core/dates.ts` | adapted |
| Scope registry (`scope -> tools` map, multi-scope registration of the export tool) | `src/ramp_mcp/__init__.py`, `scope_to_tools_mapping` | `buildScopeToTools` in `src/contracts/scopes.ts` | adapted |

## Ramp hosted MCP (documentation, not code)

Reproduced as interface conventions from Ramp's published docs and the `agent-tool.json` in `ramp-public/ramp-cli` (MIT); no code from `ramp-cli` is copied: the `rationale` description ("Briefly explain why you are calling this tool: what goal or workflow it serves and what you intend to do with the result", `RATIONALE_DESCRIPTION` in `src/contracts/tools.ts`); the availability vocabulary `missing_scopes`, `authorization_level_not_allowed` and `disabled_for_business` renamed `disabled_for_deployment` (`src/contracts/scopes.ts`); the `x-read-only` / `x-destructive` / `x-gated-by` extension names; the 100-row query cap ("... add filters and retry"), "ETL operation limit reached" and "too many tables loaded" messages (`rowCapMessage`, `ETL_OPERATION_LIMIT_MESSAGE`, `TOO_MANY_TABLES_MESSAGE` in `src/contracts/tools.ts`); the 401 body `{"detail":"No access token provided"}` (`NO_ACCESS_TOKEN_BODY`) and the `ramp_user_tok_` prefix pattern (`ACCESS_TOKEN_PREFIX = 'mockbank_user_tok_'`) in `src/contracts/auth.ts`.
