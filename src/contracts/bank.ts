/**
 * Bank domain types and the two runtime interfaces every tool handler is written against
 * (block: contracts).
 *
 * Implements docs/ARCHITECTURE.md section 7 (the domain model and the ADR-15 dataset/overlay
 * layering), Ramp's `{data, page: {next}}` envelope (docs/RAMP_REFERENCE.md section 6.3) and the
 * worker-backed `ScratchDb` of ADR-9.
 *
 * All money is an **integer number of USD cents** (Decision D-1): 1000 is $10.00. Entity fields
 * that carry money are suffixed `_cents` so a model reading a scratch-table column cannot
 * mistake them for dollars. `TransferPreview` is the one exception: its field names are fixed by
 * docs/TOOL_CATALOG.md section 3 and are reproduced verbatim.
 *
 * Pure types. No I/O, no business logic.
 */
import type { AuthLevel } from './events.js';
import type { Scope } from './scopes.js';

// ---------------------------------------------------------------------------
// Pagination (Ramp's envelope)
// ---------------------------------------------------------------------------

/** Ramp's list envelope: `page.next` is an opaque cursor, `null` on the last page. */
export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly next: string | null };
}

/** Cursor pagination shared by every list operation. */
export interface ListQuery {
  readonly cursor?: string | null;
  readonly limit?: number;
}

/** Ramp's `CLIENT_MAX_PAGES` analogue; a knob, not a hard rule (A-23). */
export const DEFAULT_PAGE_SIZE = 500;
export const CLIENT_MAX_PAGES = 100;

// ---------------------------------------------------------------------------
// Entities (docs/ARCHITECTURE.md section 7)
// ---------------------------------------------------------------------------

export type PersonaKind = 'retail' | 'business';

/** A login identity. Seeded personas are public demo identities shared by everyone (A-14). */
export interface Persona {
  /** `per_...` */
  readonly id: string;
  readonly name: string;
  readonly kind: PersonaKind;
  /** True for the three seeded personas; their datasets are shared, their writes are not. */
  readonly shared: boolean;
  /** The deterministic seed the dataset regenerates from after a restart (A-15). */
  readonly seed: string;
  readonly email: string;
  readonly created_at: string;
  /** Per-transfer ceiling enforced by `create_transfer`, in USD cents. */
  readonly transfer_limit_cents: number;
}

/** One browser, one human, up to 30 days (ADR-14). */
export interface Login {
  /** `lgn_...` */
  readonly id: string;
  readonly persona_id: string;
  readonly created_at: string;
  readonly expires_at: string;
}

/** One consent, or the extension of one. The correlation anchor of the whole system. */
export interface Grant {
  /** `grt_...` */
  readonly id: string;
  /** Set when the consent came from a browser already holding a login cookie (ADR-14). */
  readonly parent_grant_id: string | null;
  readonly login_id: string;
  readonly persona_id: string;
  /** Short hash of the OAuth client id; the raw value is never stored on events. */
  readonly client_id: string;
  readonly client_name: string | null;
  readonly scopes: readonly Scope[];
  readonly auth_level: AuthLevel;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
  readonly revoked: boolean;
}

export type AccountType = 'checking' | 'savings' | 'credit_card';
export type AccountStatus = 'open' | 'closed';

export interface Account {
  /** `acc_...` */
  readonly id: string;
  readonly persona_id: string;
  readonly name: string;
  readonly account_type: AccountType;
  readonly currency: string;
  /** Ledger balance in USD cents; negative on a credit card means money owed. */
  readonly balance_cents: number;
  /** Balance minus pending authorisations, in USD cents. */
  readonly available_balance_cents: number;
  /** Credit limit in USD cents; `null` for deposit accounts. */
  readonly credit_limit_cents: number | null;
  /** Last four digits only; the full number never leaves bank-core. */
  readonly account_number_last4: string;
  readonly routing_number_last4: string | null;
  readonly status: AccountStatus;
  readonly opened_at: string;
}

export type CardStatus = 'active' | 'locked' | 'fraud_locked';

export interface Card {
  /** `card_...` */
  readonly id: string;
  readonly account_id: string;
  readonly persona_id: string;
  readonly cardholder_name: string;
  readonly brand: string;
  readonly last4: string;
  readonly status: CardStatus;
  /** Monthly spending limit in USD cents. */
  readonly spending_limit_cents: number;
  /** `YYYY-MM`. */
  readonly expires_on: string;
  readonly issued_at: string;
}

export type TransactionStatus = 'pending' | 'posted' | 'declined';

export interface Transaction {
  /** `txn_...` */
  readonly id: string;
  readonly account_id: string;
  readonly card_id: string | null;
  readonly persona_id: string;
  /** `YYYY-MM-DD` in UTC. */
  readonly date: string;
  readonly posted_at: string | null;
  readonly merchant_name: string;
  readonly category_id: string;
  /** Signed amount in USD cents: negative is money out, positive is money in. */
  readonly amount_cents: number;
  readonly currency: string;
  readonly status: TransactionStatus;
  readonly decline_reason: string | null;
  readonly description: string;
}

export type TransferStatus = 'scheduled' | 'completed' | 'failed';
export type TransferDirection = 'outgoing' | 'incoming';
/** Decision D-1: USD rails. */
export type TransferRail = 'ach' | 'wire' | 'internal';

export interface Transfer {
  /** `tr_...` */
  readonly id: string;
  readonly persona_id: string;
  readonly from_account_id: string;
  /** Set for an internal transfer between the persona's own accounts. */
  readonly to_account_id: string | null;
  /** Set for a transfer to a saved beneficiary. */
  readonly payee_id: string | null;
  readonly direction: TransferDirection;
  readonly rail: TransferRail;
  /** Positive amount in USD cents. */
  readonly amount_cents: number;
  readonly fee_cents: number;
  readonly total_cents: number;
  readonly currency: string;
  readonly status: TransferStatus;
  readonly memo: string | null;
  readonly scheduled_for: string;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly failure_reason: string | null;
  /** The audit entry appended when the transfer was confirmed. */
  readonly audit_id: string | null;
}

export interface Payee {
  /** `pay_...` */
  readonly id: string;
  readonly persona_id: string;
  readonly name: string;
  readonly bank_name: string;
  /** Already masked: bank-core never returns the full number (redaction rules). */
  readonly account_number_masked: string;
  readonly routing_number_masked: string;
  readonly rail: TransferRail;
  readonly is_active: boolean;
  readonly created_at: string;
}

export type BillStatus = 'open' | 'paid' | 'overdue';

export interface Bill {
  /** `bill_...` */
  readonly id: string;
  readonly persona_id: string;
  readonly payee_id: string;
  readonly account_id: string;
  readonly amount_cents: number;
  readonly currency: string;
  /** `YYYY-MM-DD`. */
  readonly due_date: string;
  readonly issued_date: string;
  readonly status: BillStatus;
  readonly paid_at: string | null;
  readonly reference: string;
}

/** Ramp's 43-entry merchant category table, copied verbatim (ids 1-44 without 22). */
export interface Category {
  readonly id: string;
  readonly name: string;
}

/** `get_currencies`: USD first (Decision D-1). */
export interface CurrencyInfo {
  readonly code: string;
  readonly name: string;
  readonly symbol: string;
  /** Digits after the decimal point; 2 for USD, so the minor unit is the cent. */
  readonly minor_unit_digits: number;
}

/** Every write appends one (docs/RAMP_REFERENCE.md section 6.1). */
export interface AuditEntry {
  /** `aud_...` */
  readonly id: string;
  readonly persona_id: string;
  readonly login_id: string;
  readonly grant_id: string | null;
  /** `card.lock`, `card.unlock`, `transfer.confirm`, ... */
  readonly action: string;
  readonly target_type: 'card' | 'transfer' | 'account';
  readonly target_id: string;
  readonly summary: string;
  /** The model-authored rationale that accompanied the call, when there was one. */
  readonly rationale: string | null;
  readonly created_at: string;
}

/** The flat union `load_statement_lines` returns (Ramp's spend-export analogue). */
export interface StatementLine {
  readonly source: 'transaction' | 'transfer' | 'bill';
  readonly id: string;
  readonly account_id: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly description: string;
  readonly counterparty: string;
  /** Signed amount in USD cents: negative is money out. */
  readonly amount_cents: number;
  readonly currency: string;
  readonly status: string;
  readonly category_id: string | null;
  readonly reference: string | null;
}

// ---------------------------------------------------------------------------
// Query shapes (mirroring the tool parameters of docs/TOOL_CATALOG.md section 3)
// ---------------------------------------------------------------------------

/** `""` means "no filter" on every optional enum (Ramp convention). */
export type EnumFilter<T extends string> = T | '';

export interface AccountQuery extends ListQuery {
  readonly account_id?: string;
  readonly account_type?: EnumFilter<AccountType>;
}

export interface CardQuery extends ListQuery {
  readonly account_id?: string;
  readonly status?: EnumFilter<CardStatus>;
}

/** `to_date` is inclusive: the implementation adds one day, in UTC (Ramp convention). */
export interface DateRangeQuery extends ListQuery {
  readonly from_date: string;
  readonly to_date: string;
}

export interface TransactionQuery extends DateRangeQuery {
  readonly account_id?: string;
  readonly card_id?: string;
  readonly category_ids?: readonly string[];
  readonly status?: EnumFilter<TransactionStatus>;
}

export interface TransferQuery extends DateRangeQuery {
  readonly direction?: EnumFilter<TransferDirection>;
  readonly status?: EnumFilter<TransferStatus>;
}

export interface BillQuery extends DateRangeQuery {
  readonly payment_status?: EnumFilter<BillStatus>;
}

export interface PayeeQuery extends ListQuery {
  readonly name?: string;
  readonly is_active?: boolean;
}

export type StatementLineQuery = DateRangeQuery;

export interface AuditQuery extends ListQuery {
  readonly action?: string;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/** Which persona's data, on whose overlay (ADR-15). */
export interface BankScope {
  readonly persona_id: string;
  readonly login_id: string;
  readonly grant_id?: string | null;
}

export type CardAction = 'lock' | 'unlock';

export interface CardMutationInput {
  readonly card_id: string;
  readonly action: CardAction;
  readonly rationale?: string | null;
}

export type CardMutationFailureReason =
  'unknown_card' | 'fraud_locked' | 'already_in_state' | 'account_closed';

export type CardMutationResult =
  | { readonly ok: true; readonly card: Card; readonly audit_id: string; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly reason: CardMutationFailureReason;
      readonly message: string;
      readonly card?: Card;
    };

/** `{payee_id}` or `{account_id}`; the tool schema advertises the same one-of. */
export type TransferTarget = { readonly payee_id: string } | { readonly account_id: string };

export interface TransferPreviewInput {
  readonly from_account_id: string;
  readonly to: TransferTarget;
  /** Positive integer in USD cents. */
  readonly amount: number;
  readonly currency: string;
  readonly memo?: string | null;
  readonly rationale?: string | null;
}

/** How the persona's limits look after this transfer; rendered for the model. */
export interface PolicyOutlook {
  readonly status: 'ok' | 'warning' | 'blocked';
  readonly message: string;
  readonly per_transfer_limit_cents: number;
  readonly daily_remaining_cents: number;
}

/**
 * The preview a `create_transfer` call without `confirm` returns. Field names are fixed by
 * docs/TOOL_CATALOG.md section 3; `amount`, `fee`, `total`, `resulting_balance` and
 * `expected_total_amount` are integers in USD cents.
 */
export interface TransferPreview {
  /** `prv_...` */
  readonly preview_id: string;
  readonly from_account_id: string;
  readonly to: TransferTarget;
  readonly amount: number;
  readonly fee: number;
  readonly total: number;
  readonly resulting_balance: number;
  readonly currency: string;
  readonly rail: TransferRail;
  readonly policy_outlook: PolicyOutlook;
  /** Echoed back on the confirm call; a mismatch rejects the transfer (reprice guard). */
  readonly expected_total_amount: number;
  readonly expires_at: string;
}

export type TransferFailureReason =
  | 'unknown_account'
  | 'unknown_payee'
  | 'payee_inactive'
  | 'account_closed'
  | 'insufficient_funds'
  | 'over_limit'
  | 'currency_not_supported'
  | 'invalid_amount';

export type TransferPreviewResult =
  | { readonly ok: true; readonly preview: TransferPreview }
  | { readonly ok: false; readonly reason: TransferFailureReason; readonly message: string };

export interface TransferConfirmInput {
  readonly preview_id: string;
  readonly expected_total_amount: number;
  readonly rationale?: string | null;
}

export type TransferConfirmFailureReason =
  TransferFailureReason | 'unknown_preview' | 'expired_preview' | 'repriced';

export type TransferConfirmResult =
  | { readonly ok: true; readonly transfer: Transfer; readonly audit_id: string }
  | {
      readonly ok: false;
      readonly reason: TransferConfirmFailureReason;
      readonly message: string;
      /** Present on `repriced`, so the model can show the user the new total. */
      readonly preview?: TransferPreview;
    };

// ---------------------------------------------------------------------------
// The dataset / overlay layering (ADR-15)
// ---------------------------------------------------------------------------

/** The immutable seed view: a pure function of the persona's seed, regenerable on demand. */
export interface BankDataset {
  readonly persona: Persona;
  readonly accounts: readonly Account[];
  readonly cards: readonly Card[];
  readonly transactions: readonly Transaction[];
  readonly transfers: readonly Transfer[];
  readonly payees: readonly Payee[];
  readonly bills: readonly Bill[];
  readonly generated_at: string;
}

/** The mutable copy-on-write layer, keyed by `login_id`; reads merge it over the dataset. */
export interface BankOverlay {
  readonly persona_id: string;
  readonly login_id: string;
  /** Card id -> status, for cards whose status was changed on this login. */
  readonly card_status: Readonly<Record<string, CardStatus>>;
  /** Account id -> signed delta in USD cents applied by confirmed transfers. */
  readonly balance_delta_cents: Readonly<Record<string, number>>;
  readonly transfers: readonly Transfer[];
  readonly audit: readonly AuditEntry[];
  readonly created_at: string;
  readonly last_used_at: string;
}

/** Seeded personas plus "create a demo customer" (A-14). */
export interface PersonaDirectory {
  /** The seeded, shared demo identities, in a stable order. */
  list(): Promise<readonly Persona[]>;
  get(personaId: string): Promise<Persona | null>;
  /** Mints a fresh `per_<seed>` persona whose dataset regenerates after any restart. */
  createDemoPersona(input?: {
    readonly seed?: string;
    readonly name?: string;
    readonly kind?: PersonaKind;
  }): Promise<Persona>;
}

/**
 * Everything the bank can do. Reads merge the overlay over the dataset; writes touch the overlay
 * only and are atomic per call on the single event loop (docs/ARCHITECTURE.md section 4).
 */
export interface BankCore {
  readonly personas: PersonaDirectory;

  /** The immutable seed view (ADR-15). LRU-capped by `MAX_MATERIALISED_PERSONAS`. */
  dataset(personaId: string): Promise<BankDataset>;
  /** The per-login mutable layer (ADR-15). LRU-capped by `MAX_PERSONA_OVERLAYS`. */
  overlay(personaId: string, loginId: string): Promise<BankOverlay>;

  listAccounts(scope: BankScope, query?: AccountQuery): Promise<Page<Account>>;
  listCards(scope: BankScope, query?: CardQuery): Promise<Page<Card>>;
  listTransactions(scope: BankScope, query: TransactionQuery): Promise<Page<Transaction>>;
  listTransfers(scope: BankScope, query: TransferQuery): Promise<Page<Transfer>>;
  listBills(scope: BankScope, query: BillQuery): Promise<Page<Bill>>;
  listPayees(scope: BankScope, query?: PayeeQuery): Promise<Page<Payee>>;
  listStatementLines(scope: BankScope, query: StatementLineQuery): Promise<Page<StatementLine>>;
  listAuditEntries(scope: BankScope, query?: AuditQuery): Promise<Page<AuditEntry>>;

  /** Reference data; no persona and no scope needed. */
  listCategories(): Promise<readonly Category[]>;
  listCurrencies(): Promise<readonly CurrencyInfo[]>;

  lockOrUnlockCard(scope: BankScope, input: CardMutationInput): Promise<CardMutationResult>;
  previewTransfer(scope: BankScope, input: TransferPreviewInput): Promise<TransferPreviewResult>;
  confirmTransfer(scope: BankScope, input: TransferConfirmInput): Promise<TransferConfirmResult>;
}

// ---------------------------------------------------------------------------
// ScratchDb (ADR-9): the worker-backed per-grant `:memory:` database
// ---------------------------------------------------------------------------

/** One table living in a grant's scratch database. */
export interface ScratchTable {
  readonly table_name: string;
  readonly source_tool: string;
  readonly rows: number;
  /** Union of keys across all rows, nested keys joined with `__` (Ramp convention). */
  readonly columns_advertised: readonly string[];
  /** The subset `process_data` projected onto real SQL columns; empty until then. */
  readonly columns_selected: readonly string[];
  readonly processed: boolean;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface LoadTableInput {
  /** `{tool}_{uuid4hex}` (Ramp convention); generated by the caller or by the implementation. */
  readonly table_name?: string;
  readonly source_tool: string;
  readonly rows: readonly Record<string, unknown>[];
}

export interface LoadedTable {
  readonly table_name: string;
  readonly rows: number;
  readonly columns_advertised: readonly string[];
}

export interface ProcessTableInput {
  readonly table_name: string;
  readonly cols: readonly string[];
}

export interface ProcessedTable {
  readonly table_name: string;
  readonly rows: number;
  readonly columns_selected: readonly string[];
}

export interface ScratchQueryInput {
  readonly table_name: string;
  /** Model-authored SQL. Never executed on the main event loop (ADR-9). */
  readonly sql: string;
  /** Defaults to `MAX_QUERY_ROWS` (100). */
  readonly max_rows?: number;
  /** Defaults to `QUERY_TIMEOUT_MS` (2000). */
  readonly timeout_ms?: number;
}

export interface ScratchQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly columns: readonly string[];
  readonly rows_returned: number;
  /** True when the row cap trimmed the result: "add filters and retry". */
  readonly capped: boolean;
  readonly duration_ms: number;
}

/** Why a scratch-database call failed. `timeout` is the one ADR-9 exists for. */
export type ScratchDbFailureReason =
  | 'timeout'
  | 'not_readonly'
  | 'denylist'
  | 'multi_statement'
  | 'unknown_table'
  | 'unknown_column'
  | 'grant_cap'
  | 'ops_limit'
  | 'global_cap'
  | 'worker_crashed'
  | 'syntax_error';

/**
 * What `ScratchDb.query` rejects with. It is a class so `etl` can `throw` it and every consumer
 * can `instanceof` it; it carries no behaviour beyond the reason (contracts hold no logic).
 */
export class ScratchDbError extends Error {
  readonly reason: ScratchDbFailureReason;
  readonly sql: string | undefined;
  readonly duration_ms: number | undefined;

  constructor(
    reason: ScratchDbFailureReason,
    message: string,
    options?: { readonly sql?: string; readonly duration_ms?: number; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ScratchDbError';
    this.reason = reason;
    this.sql = options?.sql;
    this.duration_ms = options?.duration_ms;
  }
}

export function isScratchDbError(value: unknown): value is ScratchDbError {
  return value instanceof ScratchDbError;
}

/** Why a scratch database was torn down. */
export type ScratchTerminateReason = 'timeout' | 'ttl' | 'global_cap' | 'shutdown' | 'revoked';

/**
 * One grant's `:memory:` database. The interface is mechanism-agnostic; the shipped
 * implementation owns it from a forked SQL runner process (ADR-9). Every method may reject with a
 * `ScratchDbError`; `query` in particular rejects with `reason: "timeout"` when the statement
 * outlives `QUERY_TIMEOUT_MS`, and the implementation kills the runner, which loses the grant's
 * tables (the model is told to reload).
 */
export interface ScratchDb {
  readonly grantId: string;
  load(input: LoadTableInput): Promise<LoadedTable>;
  process(input: ProcessTableInput): Promise<ProcessedTable>;
  query(input: ScratchQueryInput): Promise<ScratchQueryResult>;
  clear(tableName: string): Promise<void>;
  listTables(): Promise<readonly ScratchTable[]>;
  /** Frees the worker and the `:memory:` database. Must finish inside the SIGTERM budget. */
  terminate(reason: ScratchTerminateReason): Promise<void>;
}
