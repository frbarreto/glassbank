# bank-core

Status: done, contracts v0.5, wired in `src/composition.ts` (`createBankCore({ emitter, config })` is built first; `bankCore.personas` goes to `auth` and to `mcp`'s `lookupPersona`; the handle is `ToolContext.bank`; its emitter merges the ambient `AsyncLocalStorage` correlation so `bank.op` carries the call's `xs`).

## Purpose
The fictional bank: a deterministic seed dataset per persona, a copy-on-write overlay per login for every write, Ramp-style paged reads, and the card and transfer operations of `src/contracts/bank.ts`.
Pure TypeScript: no HTTP, MCP, SQL or tokens; everything time- or randomness-dependent is injected.

## Files
- `index.ts` - `createBankCore`: dataset cache, overlay store, reads, writes, `bank.op` emission.
- `seed.ts` - `generateDataset(persona, {asOf, historyDays?})`, the pure generator; `tokenFor`.
- `personas.ts` - `SHARED_PERSONAS`, `personaForSeed`, `createPersonaDirectory` (shared personas plus LRU-remembered `per_<seed>` ones).
- `overlays.ts` - `createOverlayStore`: the per-login overlay, LRU cap, idle reset for shared personas, audit and transfer caps.
- `transfers.ts` - `quoteTransfer`, `feeForRail`, `DAILY_LIMIT_MULTIPLIER`: pricing and policy for both halves of `create_transfer`.
- `queries.ts` - `paginate` (opaque base64url offset cursor), enum and name filters, `byAmountDescending`, `byDateDescending`.
- `categories.ts` - `BANK_CATEGORIES` (Ramp's 43-entry `SK_CATEGORIES`, verbatim), `BANK_CURRENCIES` (USD, EUR, GBP, CAD, JPY), `BASE_CURRENCY` USD.
- `names.ts` - merchant, recurring-charge, income, payee, employee and reason vocabularies; every merchant pinned to a category id.
- `config.ts` - `BankCoreConfig`, `DEFAULT_BANK_CORE_CONFIG`, `resolveBankCoreConfig`, `WIRE_FEE_CENTS` 2500.
- `lru.ts` - `BoundedLru` with `onEvict`.
- `dates.ts` - UTC-only date helpers; `withinDateRange` is inclusive on both ends.
- `random.ts` - mulberry32 over FNV-1a; `moneyCents` rounds to plausible prices.

## Public interface (`src/bank-core/index.ts`)
- `createBankCore(deps: BankCoreDeps): BankCoreHandle` - `deps = { emitter, config?, now?, personas?, randomSeed?, historyDays? }`.
- `BankCoreHandle` - the contract's `BankCore` plus `personas` (`BankPersonaDirectory`), `getBalances(scope)`, `lockCard`, `unlockCard`, `resetOverlays()`, `peekOverlay(personaId, loginId)`, `stats()`.
- Types `BalanceSummary`, `AccountBalance`, `BankCoreStats`, `BankCoreDeps`, `BankCoreConfig`; class `UnknownPersonaError`.
- `DEFAULT_BANK_CORE_CONFIG`, `WIRE_FEE_CENTS`, `generateDataset`, `HISTORY_DAYS`, `tokenFor`, `SHARED_PERSONAS`, `createPersonaDirectory`, `personaForSeed`, `BANK_CATEGORIES`, `BANK_CURRENCIES`, `BASE_CURRENCY`, `quoteTransfer`, `feeForRail`, `DAILY_LIMIT_MULTIPLIER`, `encodeCursor`, `decodeCursor`.

## Consumes
- `BankCoreDeps.emitter` (`XrayEmitter`) and `config`: `composition.ts` passes `MAX_MATERIALISED_PERSONAS` 200, `MAX_PERSONA_OVERLAYS` 1000, `PERSONA_OVERLAY_TTL_HOURS` 24; the rest are code defaults (`maxGeneratedPersonas` 200, `maxOpenPreviews` 200, `previewTtlMinutes` 15, `maxAuditEntriesPerOverlay` 200, `maxOverlayTransfers` 200, `defaultPageSize` 500, `maxPageSize` 1000).
- `src/contracts` only: `BankCore`, the entity and query types, `Page`, `DEFAULT_PAGE_SIZE`, `ID_PREFIXES`, `isId`, `XrayEmitter`; `node:crypto` for seed-derived names.

## Dataset shape (`seed.ts`; anchored on the current UTC day, 365 days of history)
| Entity | Retail | Business | Ids |
|---|---|---|---|
| Accounts | 4: checking, savings, credit card, closed legacy checking | 5: operating and payroll checking, savings, corporate card, closed legacy | `acc_<token>_001`.. |
| Cards | 5: 2 active, 1 locked, 1 `fraud_locked`, 1 on the closed account | 7: 4 active, 1 locked, 1 `fraud_locked`, 1 on the closed account | `card_<token>_001`.. |
| Transactions | 1,900-2,100: 12 months of recurring charges and deposits plus a weighted long tail; `pending` only in the last 3 days, about 1.5% `declined` | same | `txn_<token>_0001`.. |
| Transfers | 60, all rails and statuses, a few in the future | 120 | `tr_<token>_001`.. |
| Bills | 39 (3 payees x 13 months), `open` / `paid` / `overdue` | 65 (5 x 13) | `bill_<token>_001`.. |
| Payees | 8, one archived, ACH and wire rails | 14, two archived | `pay_<token>_001`.. |
`<token>` is the persona id without `per_`. Categories: 43, ids `1`..`44` without `22`. Write-time ids are process sequences: `aud_a000001`, `prv_p000001`, `tr_c000001`.
Shared personas: `per_ava_stone` (retail, limit 250,000), `per_noah_reid` (retail, 150,000), `per_harbor_supply` (business, 1,000,000); a generated `per_<seed>` persona is retail with limit 200,000 and is rebuilt from its id alone.
Balances are seeded numbers; `available_balance_cents` subtracts pending card holds. The full account number is never generated.

## Copy-on-write rule (ADR-15, ADR-16, invariant 16)
- `dataset(personaId)` is immutable, a pure function of `(seed, UTC day)`, LRU-capped and regenerated on eviction or day rollover.
- `overlay(personaId, loginId)` holds `card_status`, `balance_delta_cents`, `transfers`, `audit`; reads merge it over the dataset; writes touch it only.
- Keyed by `persona x login`: two logins on the same shared persona never see each other's writes.
- A shared persona's overlay resets after `PERSONA_OVERLAY_TTL_HOURS` idle; a generated persona's is only LRU-evicted.
- A write is one synchronous block after `contextFor`, so it is atomic on the single event loop.

## Operations and failure reasons (`src/contracts/bank.ts`)
- `listAccounts`, `listCards`, `listTransactions` (amount magnitude desc), `listTransfers`, `listBills`, `listPayees` (`is_active` default true, name substring), `listStatementLines` (transactions + transfers + bills, date desc), `listAuditEntries` - `Page<T>` with `page.next`; `""` on an enum filter means no filter; date bounds inclusive.
- `listCategories`, `listCurrencies` - no scope.
- `lockOrUnlockCard` -> `unknown_card`, `account_closed`, `fraud_locked` (unlock), `already_in_state` (lock on a `fraud_locked` card); a no-op is `ok: true, changed: false` and still appends an audit entry.
- `previewTransfer` -> `invalid_amount`, `unknown_account` (also a same-account destination), `account_closed`, `currency_not_supported` (USD only), `unknown_payee`, `payee_inactive`, `over_limit` (per-transfer limit, or the daily allowance of 3 x limit), `insufficient_funds`. `policy_outlook.status` is `ok` or `warning`, never `blocked`.
- `confirmTransfer` -> `unknown_preview` (unknown, another login or another persona), `expired_preview`, `repriced` (`expected_total_amount` mismatch, or a total that changed on re-quote; carries `preview`), plus any preview reason from the re-quote. Success debits the source, credits an internal destination, appends the transfer and an audit entry.

## Events owned
`bank.op` - one per operation, success or failure: `operation`, `account_id` / `card_id` (masked to `****` + last 4 chars), `pages` (1 on a read), `rows`, `latency_ms`, `ok`, `audit_id`, `preview_id` (only when well formed), `error` (the failure reason or the thrown message).
Operations: `accounts.list`, `cards.list`, `transactions.list`, `transfers.list`, `bills.list`, `payees.list`, `statement_lines.list`, `audit.list`, `categories.list`, `currencies.list`, `balances.get`, `persona.get`, `card.lock`, `card.unlock`, `transfer.preview`, `transfer.confirm`, `overlay.reset` (dataset eviction, overlay eviction, TTL reset; the cause is in `error`).
Correlation: `persona_id`, `login_id`, `grant_id` from the `BankScope`; `xs` is merged in by the composition root.

## Invariants held here
- Same seed, same dataset: `generateDataset` reads no clock, `Math.random` or environment; `seed.test.ts` pins a SHA-256 per shared persona.
- Invariant 16: the dataset is never mutated; every write lands on the caller's overlay.
- Invariant 14 / ADR-16: datasets, overlays, generated personas, open previews, audit entries and transfers per overlay are all capped.
- Invariant 11: account and payee numbers exist only as `*_last4` / `*_masked`.
- Invariant 13: every operation emits `bank.op`, evictions included.
- A `fraud_locked` card is never unlocked here; a preview is confirmable once, before expiry, by its login, with a matching total, and the price is recomputed at confirm time.
- D-1: integer USD cents; dates constructed and compared in UTC.

## How to test
```
npx vitest run src/bank-core   # 97 tests, 4 files, about 1 s
npx eslint src/bank-core
```
`__tests__/harness.ts` is a recording emitter that validates every event against `XrayEventSchema`. Changing the generator changes the golden digests in `seed.test.ts`; recompute them on purpose.

## Known gaps
- `confirmTransfer` writes `memo: null`: the memo given to `previewTransfer` is not kept on the preview, so a confirmed `Transfer` never carries one.
- `bank.op.card_id` / `account_id` mask the entity id (`****_003`), not a number, so the dashboard cannot join them to the tool arguments.
- A same-account transfer is rejected as `unknown_account`; the contract has no `same_account` reason.
- The "total changed on re-quote" branch of `confirmTransfer` is unreachable: the fee depends only on the rail, which cannot change under an open preview.
- Balances are seeded, not derived from the transaction history, so summing a year of transactions does not reproduce them.
- `getBalances` is on `BankCoreHandle` only, not on the `BankCore` contract; no tool calls it.
- `audit.append` is in `BANK_OPERATIONS` but never emitted; `audit.list`, `currencies.list` and `balances.get` are emitted but not listed (the schema enforces only `family.verb`).
- Overlay state is in memory only (A-15): a restart makes every locked card active again and forgets every confirmed transfer; `boot_id` in `get_current_user` is how a model explains it.
