/**
 * The fictional bank (block: bank-core).
 *
 * `createBankCore` is the only export that does anything: it returns the `BankCore` of
 * `src/contracts/bank.ts` plus a few handles the composition root and the tests need. There is no
 * HTTP, no MCP, no SQL and no token in this block - it is a pure in-memory domain model over a
 * deterministic seed, and everything it does is observable through the injected `XrayEmitter`
 * (invariant 13: a feature that does not emit its documented events is not finished).
 *
 * The layering is ADR-15 and invariant 16:
 *
 *   dataset(personaId)          immutable, a pure function of the persona seed, LRU-capped and
 *                               regenerated on demand after eviction
 *   overlay(personaId, loginId) mutable, copy-on-write per login, LRU-capped, TTL-reset for the
 *                               shared demo personas
 *   read                        overlay merged over dataset
 *   write                       overlay only, one straight-line mutation per call, so a call is
 *                               atomic on the single Node event loop
 *
 * The consequence that matters for a public demo: two strangers can both be "Ava Stone", and the
 * card one of them locks stays active for the other (A-14).
 */
import {
  DEFAULT_PAGE_SIZE,
  ID_PREFIXES,
  isId,
  type Account,
  type AccountQuery,
  type AccountStatus,
  type AccountType,
  type AuditEntry,
  type AuditQuery,
  type BankCore,
  type BankDataset,
  type BankOverlay,
  type BankScope,
  type Bill,
  type BillQuery,
  type Card,
  type CardMutationInput,
  type CardMutationResult,
  type CardQuery,
  type CardStatus,
  type Category,
  type CurrencyInfo,
  type Page,
  type Payee,
  type PayeeQuery,
  type Persona,
  type StatementLine,
  type StatementLineQuery,
  type Transaction,
  type TransactionQuery,
  type Transfer,
  type TransferConfirmInput,
  type TransferConfirmResult,
  type TransferPreview,
  type TransferPreviewInput,
  type TransferPreviewResult,
  type TransferQuery,
  type XrayCorrelation,
  type XrayEmitter,
} from '../contracts/index.js';

import { BANK_CATEGORIES, BANK_CURRENCIES, BASE_CURRENCY } from './categories.js';
import { resolveBankCoreConfig, type BankCoreConfig } from './config.js';
import { addMinutes, pad, startOfUtcDay, toIsoDate } from './dates.js';
import { BoundedLru } from './lru.js';
import { createOverlayStore, type MutableOverlay, type OverlayStore } from './overlays.js';
import {
  createPersonaDirectory,
  type BankPersonaDirectory,
  type PersonaDirectoryOptions,
} from './personas.js';
import {
  byAmountDescending,
  byDateDescending,
  matchesEnum,
  matchesName,
  paginate,
  withinDateRange,
  type PaginationLimits,
} from './queries.js';
import { generateDataset, HISTORY_DAYS } from './seed.js';
import { quoteTransfer } from './transfers.js';

export { BANK_CATEGORIES, BANK_CURRENCIES, BASE_CURRENCY } from './categories.js';
export { DEFAULT_BANK_CORE_CONFIG, WIRE_FEE_CENTS, type BankCoreConfig } from './config.js';
export { generateDataset, HISTORY_DAYS, tokenFor } from './seed.js';
export { SHARED_PERSONAS, createPersonaDirectory, personaForSeed } from './personas.js';
export { DAILY_LIMIT_MULTIPLIER, feeForRail, quoteTransfer } from './transfers.js';
export { decodeCursor, encodeCursor } from './queries.js';

/** Thrown when an operation names a persona the directory cannot produce. */
export class UnknownPersonaError extends Error {
  readonly persona_id: string;

  constructor(personaId: string) {
    super(`unknown persona: ${personaId}`);
    this.name = 'UnknownPersonaError';
    this.persona_id = personaId;
  }
}

/** One account's money, as `getBalances` reports it. */
export interface AccountBalance {
  readonly account_id: string;
  readonly name: string;
  readonly account_type: AccountType;
  readonly currency: string;
  readonly balance_cents: number;
  readonly available_balance_cents: number;
  readonly credit_limit_cents: number | null;
  readonly status: AccountStatus;
}

/** What the persona is worth right now, overlay included. Amounts are USD cents (D-1). */
export interface BalanceSummary {
  readonly persona_id: string;
  readonly currency: string;
  readonly as_of: string;
  readonly accounts: readonly AccountBalance[];
  /** Ledger balance of the open deposit accounts. */
  readonly total_cash_cents: number;
  /** Available balance of the open deposit accounts (pending authorisations removed). */
  readonly total_available_cents: number;
  /** What is owed on the open credit-card accounts, as a positive number. */
  readonly total_credit_owed_cents: number;
  /** `total_cash_cents - total_credit_owed_cents`. */
  readonly net_position_cents: number;
}

/** Counters the composition root and the tests can read; never part of a tool response. */
export interface BankCoreStats {
  readonly materialised_datasets: number;
  readonly overlays: number;
  readonly open_previews: number;
  readonly generated_personas: number;
}

/**
 * The contract plus the handles `src/app.ts` and the tests use. `BankCore` stays the interface
 * every other block codes against; nothing here widens it.
 */
export interface BankCoreHandle extends BankCore {
  readonly personas: BankPersonaDirectory;
  /** Balances across every account, overlay applied. */
  getBalances(scope: BankScope): Promise<BalanceSummary>;
  /** `lockOrUnlockCard` with `action: "lock"`. */
  lockCard(scope: BankScope, cardId: string, rationale?: string | null): Promise<CardMutationResult>;
  /** `lockOrUnlockCard` with `action: "unlock"`; a `fraud_locked` card is refused. */
  unlockCard(
    scope: BankScope,
    cardId: string,
    rationale?: string | null,
  ): Promise<CardMutationResult>;
  /** Drops every overlay and every open preview, as a restart would (A-15). */
  resetOverlays(): void;
  /** The stored overlay without creating one; for isolation assertions. */
  peekOverlay(personaId: string, loginId: string): BankOverlay | undefined;
  stats(): BankCoreStats;
}

export interface BankCoreDeps {
  /** Every operation emits `bank.op` through this (invariant 13). */
  readonly emitter: XrayEmitter;
  /** Injected by `src/app.ts` from the env knobs; defaults match `docs/DEPLOYMENT.md` section 3. */
  readonly config?: Partial<BankCoreConfig>;
  /** Injected clock. Everything time-dependent in this block goes through it. */
  readonly now?: () => Date;
  /** Overrides the three shared personas; used by tests that want a smaller world. */
  readonly personas?: readonly Persona[];
  /** Seed source for `createDemoPersona`. */
  readonly randomSeed?: () => string;
  /** Days of transaction history the seed generator produces. Defaults to `HISTORY_DAYS`. */
  readonly historyDays?: number;
}

/** A dataset together with the UTC day it was anchored to. */
interface MaterialisedDataset {
  readonly dataset: BankDataset;
  readonly anchor: string;
}

/** Everything one operation needs about a persona: seed data plus this login's overlay. */
interface BankContext {
  readonly persona: Persona;
  readonly dataset: BankDataset;
  readonly overlay: MutableOverlay;
}

interface StoredPreview {
  readonly preview: TransferPreview;
  readonly persona_id: string;
  readonly login_id: string;
}

/** `bank.op` masks ids to their last four characters; full numbers never leave this block. */
function maskId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  return `****${value.slice(-4)}`;
}

export function createBankCore(deps: BankCoreDeps): BankCoreHandle {
  const config = resolveBankCoreConfig(deps.config);
  const now = deps.now ?? (() => new Date());
  const historyDays = deps.historyDays ?? HISTORY_DAYS;
  const limits: PaginationLimits = {
    defaultPageSize: Math.min(config.defaultPageSize, DEFAULT_PAGE_SIZE),
    maxPageSize: config.maxPageSize,
  };

  const directoryOptions: PersonaDirectoryOptions = {
    maxGenerated: config.maxGeneratedPersonas,
    ...(deps.personas === undefined ? {} : { personas: deps.personas }),
    ...(deps.randomSeed === undefined ? {} : { randomSeed: deps.randomSeed }),
  };
  const directory = createPersonaDirectory(directoryOptions);

  let sequence = 0;
  const nextId = (prefix: string, marker: string): string => {
    sequence += 1;
    return `${prefix}${marker}${pad(sequence, 6)}`;
  };

  /** Correlation for a `bank.op`; every field is optional because a read may fail early. */
  interface OpCorrelation {
    readonly persona_id?: string | null;
    readonly login_id?: string | null;
    readonly grant_id?: string | null;
  }

  function emit(
    operation: string,
    scope: OpCorrelation | null,
    startedAt: number,
    fields: {
      ok: boolean;
      rows?: number | null;
      pages?: number | null;
      account_id?: string | null;
      card_id?: string | null;
      audit_id?: string | null;
      preview_id?: string | null;
      error?: string | null;
    },
  ): void {
    const correlation: XrayCorrelation = {
      persona_id: scope?.persona_id ?? null,
      login_id: scope?.login_id ?? null,
      grant_id: scope?.grant_id ?? null,
    };
    deps.emitter.emit(
      'bank.op',
      {
        operation,
        account_id: fields.account_id ?? null,
        card_id: fields.card_id ?? null,
        pages: fields.pages ?? null,
        rows: fields.rows ?? null,
        latency_ms: Math.max(0, performance.now() - startedAt),
        ok: fields.ok,
        audit_id: isId(fields.audit_id, 'audit') ? fields.audit_id : null,
        // A caller-supplied preview id may be anything; only a well-formed one is recorded.
        preview_id: isId(fields.preview_id, 'preview') ? fields.preview_id : null,
        error: fields.error ?? null,
      },
      correlation,
    );
  }

  // --- the dataset layer (immutable, LRU-capped, regenerated on demand) --------------------

  const datasets = new BoundedLru<string, MaterialisedDataset>({
    maxEntries: config.maxMaterialisedPersonas,
    onEvict: (personaId) => {
      const started = performance.now();
      emit('overlay.reset', { persona_id: personaId }, started, {
        ok: true,
        error:
          'dataset evicted by MAX_MATERIALISED_PERSONAS; it regenerates from the seed on next use',
      });
    },
  });

  /** The UTC day every dataset is anchored to; it rolls over at midnight and datasets rebuild. */
  function currentAnchor(): Date {
    return startOfUtcDay(now());
  }

  function datasetFor(persona: Persona): BankDataset {
    const anchor = currentAnchor();
    const anchorKey = toIsoDate(anchor);
    const cached = datasets.get(persona.id);
    if (cached !== undefined && cached.anchor === anchorKey) return cached.dataset;
    const built = generateDataset(persona, { asOf: anchor, historyDays });
    datasets.set(persona.id, { dataset: built, anchor: anchorKey });
    return built;
  }

  // --- the overlay layer (mutable, per login, copy-on-write) -------------------------------

  const overlays: OverlayStore = createOverlayStore({
    maxOverlays: config.maxPersonaOverlays,
    ttlHours: config.personaOverlayTtlHours,
    maxAuditEntries: config.maxAuditEntriesPerOverlay,
    maxTransfers: config.maxOverlayTransfers,
    now,
    onEvict: (overlay) => {
      const started = performance.now();
      emit(
        'overlay.reset',
        { persona_id: overlay.persona_id, login_id: overlay.login_id },
        started,
        { ok: true, error: 'overlay evicted by MAX_PERSONA_OVERLAYS' },
      );
    },
    onReset: (overlay, reason) => {
      const started = performance.now();
      emit(
        'overlay.reset',
        { persona_id: overlay.persona_id, login_id: overlay.login_id },
        started,
        { ok: true, error: `shared persona overlay reset after ${reason}` },
      );
    },
  });

  const previews = new BoundedLru<string, StoredPreview>({ maxEntries: config.maxOpenPreviews });

  async function contextFor(scope: BankScope): Promise<BankContext> {
    const persona = await directory.get(scope.persona_id);
    if (persona === null) throw new UnknownPersonaError(scope.persona_id);
    const dataset = datasetFor(persona);
    const overlay = overlays.acquire(persona.id, scope.login_id, persona.shared);
    return { persona, dataset, overlay };
  }

  /** Reads merge the overlay over the dataset (ADR-15). */
  function mergedAccounts(context: BankContext): Account[] {
    return context.dataset.accounts.map((account) => {
      const delta = context.overlay.balance_delta_cents[account.id] ?? 0;
      if (delta === 0) return account;
      return {
        ...account,
        balance_cents: account.balance_cents + delta,
        available_balance_cents: Math.max(0, account.available_balance_cents + delta),
      };
    });
  }

  function mergedCards(context: BankContext): Card[] {
    return context.dataset.cards.map((card) => {
      const status = context.overlay.card_status[card.id];
      return status === undefined ? card : { ...card, status };
    });
  }

  function mergedTransfers(context: BankContext): Transfer[] {
    return [...context.dataset.transfers, ...context.overlay.transfers];
  }

  function appendAudit(
    context: BankContext,
    scope: BankScope,
    entry: {
      action: string;
      target_type: AuditEntry['target_type'];
      target_id: string;
      summary: string;
      rationale: string | null;
    },
  ): AuditEntry {
    const audit: AuditEntry = {
      id: nextId(ID_PREFIXES.audit, 'a'),
      persona_id: context.persona.id,
      login_id: scope.login_id,
      grant_id: scope.grant_id ?? null,
      action: entry.action,
      target_type: entry.target_type,
      target_id: entry.target_id,
      summary: entry.summary,
      rationale: entry.rationale,
      created_at: now().toISOString(),
    };
    overlays.appendAudit(context.overlay, audit);
    return audit;
  }

  /** Cents already sent out today on this login; the daily allowance is measured against it. */
  function spentTodayCents(context: BankContext): number {
    const today = toIsoDate(now());
    let total = 0;
    for (const transfer of context.overlay.transfers) {
      if (transfer.direction !== 'outgoing') continue;
      if (transfer.status === 'failed') continue;
      if (transfer.scheduled_for !== today) continue;
      total += transfer.total_cents;
    }
    return total;
  }

  // --- list operations ----------------------------------------------------------------------

  /** Runs a read, emits `bank.op` for it either way, and lets the failure propagate. */
  async function read<T>(
    operation: string,
    scope: BankScope,
    fields: { account_id?: string | null; card_id?: string | null },
    run: (context: BankContext) => Page<T>,
  ): Promise<Page<T>> {
    const started = performance.now();
    try {
      const context = await contextFor(scope);
      const page = run(context);
      emit(operation, scope, started, {
        ok: true,
        rows: page.data.length,
        // One call returns one page; `tools` sums these across a paged load.
        pages: 1,
        account_id: maskId(fields.account_id),
        card_id: maskId(fields.card_id),
      });
      return page;
    } catch (error) {
      emit(operation, scope, started, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const core: BankCoreHandle = {
    personas: directory,

    async dataset(personaId: string): Promise<BankDataset> {
      const started = performance.now();
      const persona = await directory.get(personaId);
      if (persona === null) {
        emit('persona.get', { persona_id: personaId }, started, {
          ok: false,
          error: `unknown persona: ${personaId}`,
        });
        throw new UnknownPersonaError(personaId);
      }
      const built = datasetFor(persona);
      emit('persona.get', { persona_id: persona.id }, started, {
        ok: true,
        rows: built.transactions.length,
      });
      return built;
    },

    async overlay(personaId: string, loginId: string): Promise<BankOverlay> {
      const persona = await directory.get(personaId);
      if (persona === null) throw new UnknownPersonaError(personaId);
      return overlays.snapshot(overlays.acquire(persona.id, loginId, persona.shared));
    },

    async listAccounts(scope: BankScope, query?: AccountQuery): Promise<Page<Account>> {
      return read('accounts.list', scope, { account_id: query?.account_id }, (context) => {
        const rows = mergedAccounts(context).filter(
          (account) =>
            (query?.account_id === undefined || account.id === query.account_id) &&
            matchesEnum(account.account_type, query?.account_type),
        );
        return paginate(rows, query, limits);
      });
    },

    async listCards(scope: BankScope, query?: CardQuery): Promise<Page<Card>> {
      return read('cards.list', scope, { account_id: query?.account_id }, (context) => {
        const rows = mergedCards(context).filter(
          (card) =>
            (query?.account_id === undefined || card.account_id === query.account_id) &&
            matchesEnum(card.status, query?.status),
        );
        return paginate(rows, query, limits);
      });
    },

    async listTransactions(scope: BankScope, query: TransactionQuery): Promise<Page<Transaction>> {
      return read(
        'transactions.list',
        scope,
        { account_id: query.account_id, card_id: query.card_id },
        (context) => {
          const categories = new Set(query.category_ids ?? []);
          const rows = context.dataset.transactions
            .filter(
              (transaction) =>
                withinDateRange(transaction.date, query.from_date, query.to_date) &&
                (query.account_id === undefined ||
                  query.account_id === '' ||
                  transaction.account_id === query.account_id) &&
                (query.card_id === undefined ||
                  query.card_id === '' ||
                  transaction.card_id === query.card_id) &&
                (categories.size === 0 || categories.has(transaction.category_id)) &&
                matchesEnum(transaction.status, query.status),
            )
            // Ramp always sets `order_by_amount_desc` on transactions.
            .sort(byAmountDescending);
          return paginate(rows, query, limits);
        },
      );
    },

    async listTransfers(scope: BankScope, query: TransferQuery): Promise<Page<Transfer>> {
      return read('transfers.list', scope, {}, (context) => {
        const rows = mergedTransfers(context)
          .filter(
            (transfer) =>
              withinDateRange(transfer.scheduled_for, query.from_date, query.to_date) &&
              matchesEnum(transfer.direction, query.direction) &&
              matchesEnum(transfer.status, query.status),
          )
          .sort((left, right) => {
            if (left.scheduled_for !== right.scheduled_for) {
              return left.scheduled_for < right.scheduled_for ? 1 : -1;
            }
            return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
          });
        return paginate(rows, query, limits);
      });
    },

    async listBills(scope: BankScope, query: BillQuery): Promise<Page<Bill>> {
      return read('bills.list', scope, {}, (context) => {
        const rows = context.dataset.bills
          .filter(
            (bill) =>
              withinDateRange(bill.due_date, query.from_date, query.to_date) &&
              matchesEnum(bill.status, query.payment_status),
          )
          .sort((left, right) => {
            if (left.due_date !== right.due_date) return left.due_date < right.due_date ? -1 : 1;
            return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
          });
        return paginate(rows, query, limits);
      });
    },

    async listPayees(scope: BankScope, query?: PayeeQuery): Promise<Page<Payee>> {
      return read('payees.list', scope, {}, (context) => {
        // Ramp's `load_vendors` defaults to active only ("Usually search for only active vendors").
        const wantActive = query?.is_active ?? true;
        const rows = context.dataset.payees
          .filter((payee) => payee.is_active === wantActive && matchesName(payee.name, query?.name))
          .sort((left, right) => {
            if (left.name !== right.name) return left.name < right.name ? -1 : 1;
            return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
          });
        return paginate(rows, query, limits);
      });
    },

    async listStatementLines(
      scope: BankScope,
      query: StatementLineQuery,
    ): Promise<Page<StatementLine>> {
      return read('statement_lines.list', scope, {}, (context) => {
        const payeeNames = new Map(context.dataset.payees.map((payee) => [payee.id, payee.name]));
        const accountNames = new Map(
          context.dataset.accounts.map((account) => [account.id, account.name]),
        );
        const lines: StatementLine[] = [];

        for (const transaction of context.dataset.transactions) {
          lines.push({
            source: 'transaction',
            id: transaction.id,
            account_id: transaction.account_id,
            date: transaction.date,
            description: transaction.description,
            counterparty: transaction.merchant_name,
            amount_cents: transaction.amount_cents,
            currency: transaction.currency,
            status: transaction.status,
            category_id: transaction.category_id,
            reference: null,
          });
        }
        for (const transfer of mergedTransfers(context)) {
          const counterparty =
            transfer.payee_id === null
              ? (accountNames.get(transfer.to_account_id ?? '') ?? 'Internal transfer')
              : (payeeNames.get(transfer.payee_id) ?? transfer.payee_id);
          lines.push({
            source: 'transfer',
            id: transfer.id,
            account_id: transfer.from_account_id,
            date: transfer.scheduled_for,
            description: transfer.memo ?? `${transfer.rail.toUpperCase()} transfer`,
            counterparty,
            amount_cents:
              transfer.direction === 'outgoing' ? -transfer.total_cents : transfer.total_cents,
            currency: transfer.currency,
            status: transfer.status,
            category_id: null,
            reference: null,
          });
        }
        for (const bill of context.dataset.bills) {
          lines.push({
            source: 'bill',
            id: bill.id,
            account_id: bill.account_id,
            date: bill.due_date,
            description: `Bill ${bill.reference}`,
            counterparty: payeeNames.get(bill.payee_id) ?? bill.payee_id,
            amount_cents: -bill.amount_cents,
            currency: bill.currency,
            status: bill.status,
            category_id: null,
            reference: bill.reference,
          });
        }

        const rows = lines
          .filter((line) => withinDateRange(line.date, query.from_date, query.to_date))
          .sort(byDateDescending);
        return paginate(rows, query, limits);
      });
    },

    async listAuditEntries(scope: BankScope, query?: AuditQuery): Promise<Page<AuditEntry>> {
      return read('audit.list', scope, {}, (context) => {
        const rows = [...context.overlay.audit]
          .filter(
            (entry) =>
              query?.action === undefined || query.action === '' || entry.action === query.action,
          )
          .reverse();
        return paginate(rows, query, limits);
      });
    },

    async listCategories(): Promise<readonly Category[]> {
      const started = performance.now();
      emit('categories.list', null, started, { ok: true, rows: BANK_CATEGORIES.length });
      return BANK_CATEGORIES;
    },

    async listCurrencies(): Promise<readonly CurrencyInfo[]> {
      const started = performance.now();
      emit('currencies.list', null, started, { ok: true, rows: BANK_CURRENCIES.length });
      return BANK_CURRENCIES;
    },

    async getBalances(scope: BankScope): Promise<BalanceSummary> {
      const started = performance.now();
      try {
        const context = await contextFor(scope);
        const accounts = mergedAccounts(context);
        let cash = 0;
        let available = 0;
        let owed = 0;
        const rows: AccountBalance[] = accounts.map((account) => {
          if (account.status === 'open') {
            if (account.account_type === 'credit_card') {
              owed += Math.max(0, -account.balance_cents);
            } else {
              cash += account.balance_cents;
              available += account.available_balance_cents;
            }
          }
          return {
            account_id: account.id,
            name: account.name,
            account_type: account.account_type,
            currency: account.currency,
            balance_cents: account.balance_cents,
            available_balance_cents: account.available_balance_cents,
            credit_limit_cents: account.credit_limit_cents,
            status: account.status,
          };
        });
        emit('balances.get', scope, started, { ok: true, rows: rows.length, pages: 1 });
        return {
          persona_id: context.persona.id,
          currency: BASE_CURRENCY,
          as_of: now().toISOString(),
          accounts: rows,
          total_cash_cents: cash,
          total_available_cents: available,
          total_credit_owed_cents: owed,
          net_position_cents: cash - owed,
        };
      } catch (error) {
        emit('balances.get', scope, started, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    // --- writes -----------------------------------------------------------------------------

    async lockOrUnlockCard(
      scope: BankScope,
      input: CardMutationInput,
    ): Promise<CardMutationResult> {
      const started = performance.now();
      const operation = input.action === 'lock' ? 'card.lock' : 'card.unlock';
      const fail = (result: Extract<CardMutationResult, { ok: false }>): CardMutationResult => {
        emit(operation, scope, started, {
          ok: false,
          card_id: maskId(input.card_id),
          error: result.reason,
        });
        return result;
      };

      let context: BankContext;
      try {
        context = await contextFor(scope);
      } catch (error) {
        emit(operation, scope, started, {
          ok: false,
          card_id: maskId(input.card_id),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Everything from here on is synchronous: one call, one atomic mutation (invariant 16).
      const card = mergedCards(context).find((candidate) => candidate.id === input.card_id);
      if (card === undefined) {
        return fail({
          ok: false,
          reason: 'unknown_card',
          message: `no card with id ${input.card_id}`,
        });
      }
      const account = context.dataset.accounts.find(
        (candidate) => candidate.id === card.account_id,
      );
      if (account !== undefined && account.status === 'closed') {
        return fail({
          ok: false,
          reason: 'account_closed',
          message: `card ending ${card.last4} belongs to ${account.name}, which is closed; its status cannot be changed`,
          card,
        });
      }
      if (card.status === 'fraud_locked') {
        // The one rule this tool cannot override: a bank-initiated fraud lock (docs/TOOL_CATALOG.md
        // section 3, tool 15). Locking it further is a no-op, unlocking it is refused outright.
        return fail(
          input.action === 'unlock'
            ? {
                ok: false,
                reason: 'fraud_locked',
                message: `card ending ${card.last4} was locked by the bank for suspected fraud and cannot be unlocked with this tool; the customer has to call the fraud line`,
                card,
              }
            : {
                ok: false,
                reason: 'already_in_state',
                message: `card ending ${card.last4} is already locked by the bank for suspected fraud`,
                card,
              },
        );
      }

      const target: CardStatus = input.action === 'lock' ? 'locked' : 'active';
      const changed = card.status !== target;
      if (changed) context.overlay.card_status[card.id] = target;
      const audit = appendAudit(context, scope, {
        action: operation,
        target_type: 'card',
        target_id: card.id,
        summary: changed
          ? `card ending ${card.last4} ${input.action === 'lock' ? 'locked' : 'unlocked'}`
          : `card ending ${card.last4} was already ${target === 'locked' ? 'locked' : 'active'}; no change made`,
        rationale: input.rationale ?? null,
      });
      emit(operation, scope, started, {
        ok: true,
        card_id: maskId(card.id),
        audit_id: audit.id,
        rows: changed ? 1 : 0,
      });
      return { ok: true, card: { ...card, status: target }, audit_id: audit.id, changed };
    },

    async previewTransfer(
      scope: BankScope,
      input: TransferPreviewInput,
    ): Promise<TransferPreviewResult> {
      const started = performance.now();
      let context: BankContext;
      try {
        context = await contextFor(scope);
      } catch (error) {
        emit('transfer.preview', scope, started, {
          ok: false,
          account_id: maskId(input.from_account_id),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const quoted = quoteTransfer({
        persona: context.persona,
        accounts: mergedAccounts(context),
        payees: context.dataset.payees,
        from_account_id: input.from_account_id,
        to: input.to,
        amount: input.amount,
        currency: input.currency,
        spent_today_cents: spentTodayCents(context),
      });
      if (!quoted.ok) {
        emit('transfer.preview', scope, started, {
          ok: false,
          account_id: maskId(input.from_account_id),
          error: quoted.reason,
        });
        return { ok: false, reason: quoted.reason, message: quoted.message };
      }

      const preview: TransferPreview = {
        preview_id: nextId(ID_PREFIXES.preview, 'p'),
        from_account_id: quoted.quote.from.id,
        to: input.to,
        amount: quoted.quote.amount_cents,
        fee: quoted.quote.fee_cents,
        total: quoted.quote.total_cents,
        resulting_balance: quoted.quote.resulting_balance_cents,
        currency: input.currency,
        rail: quoted.quote.rail,
        policy_outlook: quoted.quote.policy_outlook,
        expected_total_amount: quoted.quote.total_cents,
        expires_at: addMinutes(now(), config.previewTtlMinutes).toISOString(),
      };
      previews.set(preview.preview_id, {
        preview,
        persona_id: context.persona.id,
        login_id: scope.login_id,
      });
      emit('transfer.preview', scope, started, {
        ok: true,
        account_id: maskId(preview.from_account_id),
        preview_id: preview.preview_id,
      });
      return { ok: true, preview };
    },

    async confirmTransfer(
      scope: BankScope,
      input: TransferConfirmInput,
    ): Promise<TransferConfirmResult> {
      const started = performance.now();
      const fail = (
        result: Extract<TransferConfirmResult, { ok: false }>,
      ): TransferConfirmResult => {
        emit('transfer.confirm', scope, started, {
          ok: false,
          preview_id: input.preview_id,
          error: result.reason,
        });
        return result;
      };

      let context: BankContext;
      try {
        context = await contextFor(scope);
      } catch (error) {
        emit('transfer.confirm', scope, started, {
          ok: false,
          preview_id: input.preview_id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const stored = previews.get(input.preview_id);
      // A preview belongs to the login that made it: another login on the same shared persona
      // must not be able to confirm someone else's money movement (ADR-15).
      if (
        stored === undefined ||
        stored.login_id !== scope.login_id ||
        stored.persona_id !== context.persona.id
      ) {
        return fail({
          ok: false,
          reason: 'unknown_preview',
          message: `no open preview with id ${input.preview_id}; call create_transfer without confirm first`,
        });
      }
      const preview = stored.preview;
      if (new Date(preview.expires_at).getTime() <= now().getTime()) {
        previews.delete(preview.preview_id);
        return fail({
          ok: false,
          reason: 'expired_preview',
          message: `preview ${preview.preview_id} expired at ${preview.expires_at}; run the preview step again and show the user the new total`,
        });
      }
      if (input.expected_total_amount !== preview.expected_total_amount) {
        return fail({
          ok: false,
          reason: 'repriced',
          message: `expected_total_amount ${input.expected_total_amount} does not match the quoted total ${preview.expected_total_amount} cents; show the user the quoted total and confirm again`,
          preview,
        });
      }

      // The reprice guard: the transfer is priced again against the state as it is now, never
      // taken from the preview, so a balance that moved between the two calls is caught here.
      const quoted = quoteTransfer({
        persona: context.persona,
        accounts: mergedAccounts(context),
        payees: context.dataset.payees,
        from_account_id: preview.from_account_id,
        to: preview.to,
        amount: preview.amount,
        currency: preview.currency,
        spent_today_cents: spentTodayCents(context),
      });
      if (!quoted.ok) {
        previews.delete(preview.preview_id);
        return fail({ ok: false, reason: quoted.reason, message: quoted.message });
      }
      if (quoted.quote.total_cents !== preview.total) {
        const repriced: TransferPreview = {
          ...preview,
          fee: quoted.quote.fee_cents,
          total: quoted.quote.total_cents,
          resulting_balance: quoted.quote.resulting_balance_cents,
          policy_outlook: quoted.quote.policy_outlook,
          expected_total_amount: quoted.quote.total_cents,
          expires_at: addMinutes(now(), config.previewTtlMinutes).toISOString(),
        };
        previews.set(preview.preview_id, { ...stored, preview: repriced });
        return fail({
          ok: false,
          reason: 'repriced',
          message: `the total changed from ${preview.total} to ${quoted.quote.total_cents} cents before the transfer was confirmed; show the user the new total and confirm again`,
          preview: repriced,
        });
      }

      // Committed from here: synchronous, so the whole write lands or none of it does.
      const nowIso = now().toISOString();
      const audit = appendAudit(context, scope, {
        action: 'transfer.confirm',
        target_type: 'transfer',
        target_id: preview.preview_id,
        summary: `transfer of ${preview.amount} cents (${preview.total} cents including fees) confirmed on the ${preview.rail} rail`,
        rationale: input.rationale ?? null,
      });
      const transfer: Transfer = {
        id: nextId(ID_PREFIXES.transfer, 'c'),
        persona_id: context.persona.id,
        from_account_id: preview.from_account_id,
        to_account_id: quoted.quote.to_account_id,
        payee_id: quoted.quote.payee_id,
        direction: 'outgoing',
        rail: preview.rail,
        amount_cents: preview.amount,
        fee_cents: preview.fee,
        total_cents: preview.total,
        currency: preview.currency,
        status: 'completed',
        memo: null,
        scheduled_for: toIsoDate(now()),
        created_at: nowIso,
        completed_at: nowIso,
        failure_reason: null,
        audit_id: audit.id,
      };
      overlays.appendTransfer(context.overlay, transfer);
      const deltas = context.overlay.balance_delta_cents;
      deltas[preview.from_account_id] = (deltas[preview.from_account_id] ?? 0) - preview.total;
      if (quoted.quote.to_account_id !== null) {
        const destination = quoted.quote.to_account_id;
        deltas[destination] = (deltas[destination] ?? 0) + preview.amount;
      }
      previews.delete(preview.preview_id);

      emit('transfer.confirm', scope, started, {
        ok: true,
        account_id: maskId(transfer.from_account_id),
        preview_id: preview.preview_id,
        audit_id: audit.id,
        rows: 1,
      });
      return { ok: true, transfer, audit_id: audit.id };
    },

    // --- convenience and diagnostics ---------------------------------------------------------

    async lockCard(scope, cardId, rationale) {
      return core.lockOrUnlockCard(scope, {
        card_id: cardId,
        action: 'lock',
        rationale: rationale ?? null,
      });
    },

    async unlockCard(scope, cardId, rationale) {
      return core.lockOrUnlockCard(scope, {
        card_id: cardId,
        action: 'unlock',
        rationale: rationale ?? null,
      });
    },

    resetOverlays() {
      overlays.clear();
      previews.clear();
    },

    peekOverlay(personaId, loginId) {
      const overlay = overlays.peek(personaId, loginId);
      return overlay === undefined ? undefined : overlays.snapshot(overlay);
    },

    stats() {
      return {
        materialised_datasets: datasets.size,
        overlays: overlays.size(),
        open_previews: previews.size,
        generated_personas: directory.generatedCount(),
      };
    },
  };

  return core;
}
