# contracts

Status: v0.9, frozen and append-only - add event types, optional fields, enum members, tools, scopes and routes; never rename or remove a name in v1. Since v0.9 every event schema is open: a field nobody named is kept, not stripped (D-28).

## Purpose
The single source of truth every block codes against: the event envelope and catalogue, the 17-tool catalog and the 6-tool public catalog, scopes and the listing rule, the bank and scratch-database interfaces, auth shapes and constants, the X-ray HTTP API types.
Pure types, zod schemas and constants; no I/O.

## Files (`src/contracts`)
| File | What it defines |
|---|---|
| `events.ts` | `XrayEventSchema` (46 types in 12 families; every object `z.looseObject`, so unknown keys survive at any depth), `RawHeaderSchema` / `RawHttpRequestSchema` (the `raw` block of `http.request`), `CatalogToolSchema` with its optional `descriptor` and `CatalogToolDescriptorSchema`, the envelope (`id`, `ts`, `v`, `xs`, `seq`, `login_id`, `grant_id`, `persona_id`, `request_id`, `era`, `client`, ...), `XrayEnvelopeSchema` (any `type`), `parseXrayEvent` / `safeParseXrayEvent` / `parseXrayEnvelope` / `parseXrayEventLine`, `XRAY_EVENT_TYPES`, `XRAY_EVENT_FAMILIES`, `familyOf`, `dataKeysOf`, `ID_PREFIXES` / `idSchema` / `isId`, `XRAY_CONTRACT_VERSION` = 1, `CLAUDE_TOOL_BUDGET_MS` (300,000), `CLAUDE_CONTENT_CHAR_CAP` (150,000), `ANTHROPIC_EGRESS_CIDR`, `JSON_RPC_ERROR_CODES`, `BANK_OPERATIONS`, `XrayEmitter` (`emit` returns `number \| void`). |
| `scopes.ts` | The 10 `SCOPES` (`profile` implicit; `cards:write` and `transfers:write` the write pair; `xray:read`), `READ_SCOPES` / `WRITE_SCOPES`, `DEFAULT_CHALLENGE_SCOPES`, `FEATURE_FLAGS` (`writes`, `transfers`; on by default, D-3), `authLevelForScopes`, and ADR-13 as pure functions over the structural `ScopedTool`: `isListed`, `isAvailable`, `toolAvailability`, `catalogAvailability`, `listedToolNames`, `stepUpScopes`, `supportedScopes`, `buildScopeToTools`, `canonicalCatalogSnapshot`. |
| `tools.ts` | `ToolCatalogEntry` (published JSON schema with `rationale` required, lenient zod schema with it optional, annotations, `x-*` metadata, `redactionDenyList`, scopes, flag), the 17 entries, `TOOL_CATALOG` / `TOOL_NAMES` / `SCOPE_TO_TOOLS` / `WRITE_TOOL_NAMES` / `getTool`, `publishedToolDescriptor` (the `tools/list` entry, shared by the response and the `catalog.tools_listed` record), Ramp's verbatim strings (`RATIONALE_DESCRIPTION`, `AMOUNT_DESCRIPTION`, `LOAD_TOOL_SUFFIX`, the ETL messages), `LENIENT_RATIONALE` with `isRationaleMissing` / `isRationaleTruncated` / `rationaleMissingReason`, `GLOBAL_REDACTION_PATTERNS`, `TOOL_LIMIT_DEFAULTS`, `toolError` / `toolText` / `toolErrorText`, `ToolContext`, `ToolLimits`, `ToolResult`, `ToolHandler`, `ToolRegistry`. |
| `bank.ts` | The entities (`Persona`, `Login`, `Grant`, `Account`, `Card`, `Transaction`, `Transfer`, `Payee`, `Bill`, `Category`, `CurrencyInfo`, `AuditEntry`, `StatementLine`; money as `*_cents`), the query shapes, `Page<T>` (`{data, page: {next}}`), `BankScope`, `BankDataset` / `BankOverlay` / `PersonaDirectory`, `BankCore`, the card and transfer mutation inputs and results, `ScratchDb` with `ScratchDbError` / `isScratchDbError` (mechanism-agnostic: `query` may reject with `reason: "timeout"`). |
| `auth.ts` | `AuthContext`, `OAuthClient`, `OAUTH_ROUTES`, `COOKIE_NAMES` (`login_id`, `xray_viewer`, `gb_csrf`), `OAUTH_METADATA_CONSTANTS`, `TOKEN_LIFETIMES_SECONDS`, `ACCESS_TOKEN_PREFIX` (`mockbank_user_tok_`), `NO_ACCESS_TOKEN_BODY`, the callback allowlist and `isAllowedRedirectUri`, the `PUBLIC_HOSTS` rules (`isPublicHost`, `canonicalBaseUrl`, `canonicalMcpUrl`, `issuerUrl`, `resourceMetadataUrl`, `acceptableAudiences`), the two `WWW-Authenticate` builders, the six `JWT_TYPES` and their claim schemas, `JwtService`, `VerifyAccessToken`, `Pairing` and the code rules (`PAIRING_CODE_ALPHABET`, `PAIRING_CODE_PATTERN`, 50 bits, 24 h). |
| `xray-api.ts` | `XRAY_ROUTES`, the SSE constants (`SSE_EVENT_NAME`, `SSE_RETRY_MS`, `SSE_HEARTBEAT_MS`, `INITIAL_REPLAY`, `MAX_EVENTS_PAGE_LIMIT`, `RING_BUFFER_SIZE`, `RESULT_PREVIEW_BYTES`, `OBSERVER_RATIONALE_PREVIEW_CHARS`, `SSE_HEADERS`), `XRAY_EXPORT_CONTENT_TYPE`, `renderStreamFrame`, one type per route (`ViewerMeResponse`, `XraySessionsResponse`, `XraySessionDetailResponse`, `XraySessionEventsResponse`, `XrayCatalogSnapshot`, `PairRequest`, `AdminRequest`, `PairResponse`, `XrayErrorResponse`, `XrayViewerScope`, `XrayExportQuery`, `HealthzResponse`). |
| `public.ts` | v0.7, the public lane (D-26): `PUBLIC_MCP_PATH`, `PUBLIC_LOGIN_ID`, `PUBLIC_GRANT_PREFIX` / `isPublicGrantId`, `PUBLIC_LANE_NOTICE`; the published data types (`BankProfile`, `ProductFamilySummary`, `ProductDetail`, `PriceLine`, `BranchSummary`, `BranchDetail`, their queries) and `PublicBankInfo`; the six entries, `PUBLIC_TOOL_CATALOG`, `PUBLIC_TOOL_NAMES`, `getPublicTool`, `PublicToolContext`, `PublicToolRegistry`. |
| `raw-http.ts` | v0.9 (D-28): `keepRawBody` (the body-parser `verify` hook every parser uses), `rawBodyOf`, `captureRawRequest` (rawHeaders as ordered pairs, the kept bytes as UTF-8 or base64, the socket peer), `markHttpObserved` / `isHttpObserved` (`res.locals`), `HTTP_OBSERVED_LOCAL`. Pure; structural request types, no Express import. |
| `index.ts` | The barrel: `export *` of the eight files; the only `src/` path other blocks may import. |

## Public interface
Everything above, through `src/contracts/index.ts`. Test support outside the block: `src/testing/fakes.ts` (`createFakeBankCore`, `createFakeScratchDb`, `createFakeXrayEmitter`, `createFakeAuthContext`, `createFakePairing`, `createFakeToolContext`, the `FAKE_*` data, `paginate`, `flattenRow`, `advertisedColumns`, `bankScopeOf`, and for the public lane `createFakePublicBankInfo` / `createFakePublicToolContext` with `FAKE_PUBLIC_PRODUCT`, `FAKE_PUBLIC_PRICES`, `FAKE_PUBLIC_BRANCH`) and `test/fixtures/events.jsonl`, the truthful v0.5 recording (T7b): 200 events generated by `test/fixtures/build-events.ts`, limits under Known gaps.

## v0.9 changes (current; additive; `docs/contracts/CHANGES.md`)
1. Every schema in `events.ts` open (`z.looseObject`); `dataKeysOf` still lists only the named keys, the rest is the unmapped remainder (D-28).
2. `RawHeaderSchema`, `RawHttpRequestSchema`, the optional `HttpRequestData.raw`, and `raw-http.ts`.

## v0.8 changes (additive; `docs/contracts/CHANGES.md`)
1. `XRAY_ROUTES.export` (`GET /xray/api/export`), `XRAY_EXPORT_CONTENT_TYPE` and `XrayExportQuery` (D-27): the event log as JSONL.

## v0.7 changes (additive; `docs/contracts/CHANGES.md`)
1. `public.ts` as above; `buildPublishedInputSchema` / `buildLenientInputSchema` exported from `tools.ts`.
2. Six `public.*` members of `BANK_OPERATIONS`, the `public` member of `ViewerKindSchema`, `PUBLIC_LANE_QUERY` and `XrayStreamQuery.lane`.

## v0.5 changes (additive; `docs/contracts/CHANGES.md`)
1. `CatalogToolDescriptorSchema` and the optional `descriptor` on `CatalogToolSchema`: the `tools/list` entry as the client received it, minus `name` and `title`; filled by `catalogRowsOf` in `src/mcp/xray.ts`.
2. `publishedToolDescriptor(entry)` in `tools.ts`: the one source for the `tools/list` answer (`src/mcp/transport.ts`) and the recorded `descriptor`.

## v0.4 changes (additive; `docs/contracts/CHANGES.md`)
1. `XRAY_ROUTES.events`, the two `DELETE` routes and `XrayDeleteResponse`.
2. The `xray.events.deleted` event; the catalogue is 46 types.

## v0.3 changes (additive; `docs/contracts/CHANGES.md`)
1. `XRAY_ROUTES.sessionBank` (`GET /xray/api/sessions/:xs/bank`) and the `XrayBankAccount`, `XrayBankCardCounts`, `XrayBankSummary`, `XraySessionBankResponse` types for the dashboard's persona card.

## v0.2 changes (all additive; `docs/contracts/CHANGES.md`)
1. `XrayEmitter.emit` returns `number | void`, the id it assigned.
2. `unknown_column` and `syntax_error` on `SqlRejectedReasonSchema`.
3. `crash` on `EtlEvictionReasonSchema`.
4. `rate_limited` on `AuthRejectedData.reason`.

## Consumes
`zod` only. Imported by every block.

## Events owned
None; defines all 46.

## Invariants held here
- Append-only in v1; every fixture line validates against the envelope; the fakes satisfy the interfaces (`test/contracts/fakes.test.ts`).
- 9: every tool passes `test/contracts/tool-catalog.test.ts` - snake_case name <= 64, `title`, exactly one of `readOnlyHint` / `destructiveHint`, `openWorldHint: false`, a description per parameter, `rationale` required in the published schema and optional in the lenient one, a deny-list.
- ADR-13: a write tool stays listed without its write scope; a tool is hidden only for a missing read scope or a disabled flag, which reports `disabled_for_deployment` with empty `missing_scopes`.
- 8: `ScratchDb` names no mechanism; `src/etl` chooses the forked runner.

## How to test
```
npx vitest run test/contracts src/contracts test/import-boundaries.test.ts   # 455 tests, 9 files
npx vitest run src/testing                                                    # 30 tests: the fakes
npx tsx test/fixtures/build-events.ts                                         # regenerates events.jsonl, byte-identical
```

## Known gaps
- `test/fixtures/events.jsonl` is the truthful v0.5 recording (T7b, 2026-09-14), with three limits. `content_hash` is still the `sha256:1c9f4b6d2ae08357` stand-in. Every `structured_content` is `null`, although the handlers attach one. The capped query at id 57 lacks the `sql.rejected {rejected_reason: "row_cap"}` that `src/etl/scratch-db.ts` emits before its `sql.query`, because adding it would move every later id.
- Five types are absent from the fixture (`auth.client.reconstructed`, `auth.token.revoked`, `session.rejected`, `tool.call.cancelled`, `xray.events.deleted`); unit tests cover them.
- `content_hash` is not computed here (no `node:crypto`); `canonicalCatalogSnapshot` gives the string and `src/tools` hashes it.
- `XRAY_ROUTES.assets` names a `/xray/assets` path nothing serves.
- `?last_event_id=` on the stream is accepted by `src/xray/sse.ts` but not declared in `XrayStreamQuery`.
- `create_transfer.to` is a JSON Schema `oneOf`; no client has exercised it yet.
