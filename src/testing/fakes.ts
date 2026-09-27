/**
 * In-memory fakes for every contract interface (block: testing).
 *
 * A block under test wires these instead of another block's implementation, so the Phase 1 lanes
 * never depend on each other (docs/REPO_LAYOUT.md sections 3 and 7). Everything here is
 * deterministic: the same options always produce the same ids, amounts and dates, so a snapshot
 * test is stable.
 *
 * These are fakes, not simulators. In particular `createFakeScratchDb` enforces the ADR-9 guard
 * rules and the row cap for real, but it does not execute SQL: it returns the rows it holds. The
 * real SQLite engine lives in `src/etl`, which is the only block allowed to import
 * `better-sqlite3`.
 */
import type {
  Account,
  AccountQuery,
  AuditEntry,
  AuditQuery,
  AuthContext,
  Bill,
  BillQuery,
  BankCore,
  BankDataset,
  BankOverlay,
  BankScope,
  Card,
  CardMutationInput,
  CardMutationResult,
  CardQuery,
  CardStatus,
  Category,
  CurrencyInfo,
  FeatureFlag,
  ListQuery,
  LoadTableInput,
  LoadedTable,
  OAuthClient,
  Page,
  Pairing,
  PairingCode,
  PairingExchangeResult,
  Payee,
  PayeeQuery,
  Persona,
  PersonaDirectory,
  PersonaKind,
  ProcessTableInput,
  ProcessedTable,
  ScratchDb,
  ScratchDbFailureReason,
  ScratchQueryInput,
  ScratchQueryResult,
  ScratchTable,
  ScratchTerminateReason,
  Scope,
  StatementLine,
  StatementLineQuery,
  ToolContext,
  ToolLimits,
  Transaction,
  TransactionQuery,
  Transfer,
  TransferConfirmInput,
  TransferConfirmResult,
  TransferPreview,
  TransferPreviewInput,
  TransferPreviewResult,
  TransferQuery,
  XrayCorrelation,
  XrayEmitter,
  XrayEvent,
  XrayEventDataInput,
  XrayEventType,
  PublicBankInfo,
  PublicToolContext,
  PriceLine,
  ProductDetail,
  BranchDetail,
} from '../contracts/index.js';
import {
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_PAGE_SIZE,
  PAIRING_CODE_ALPHABET,
  ScratchDbError,
  TOOL_LIMIT_DEFAULTS,
  XrayEventSchema,
  authLevelForScopes,
  formatPairingCode,
  pairingUrl,
  CLAUDE_CONTENT_CHAR_CAP,
  CLAUDE_TOOL_BUDGET_MS,
} from '../contracts/index.js';

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/** FNV-1a, so a string seed becomes a 32-bit number. */
function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32: a tiny deterministic PRNG. Same seed, same dataset, every run. */
function makeRandom(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const index = Math.floor(random() * values.length) % values.length;
  return values[index] as T;
}

function integerBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DD` in UTC, `daysAgo` days before `reference`. */
function isoDate(reference: Date, daysAgo: number): string {
  const date = new Date(reference.getTime() - daysAgo * 86_400_000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function isoTimestamp(reference: Date, daysAgo: number): string {
  return new Date(reference.getTime() - daysAgo * 86_400_000).toISOString();
}

/** The fixed instant every fake uses when no clock is injected. */
export const FAKE_NOW = new Date('2026-09-08T12:00:00.000Z');

/** Ramp's `{data, page: {next}}` envelope over an array; the cursor is a numeric offset. */
export function paginate<T>(rows: readonly T[], query?: ListQuery): Page<T> {
  const limit = Math.max(1, Math.min(query?.limit ?? DEFAULT_PAGE_SIZE, 1000));
  const parsed = query?.cursor ? Number.parseInt(query.cursor, 10) : 0;
  const offset = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const data = rows.slice(offset, offset + limit);
  const consumed = offset + data.length;
  return { data, page: { next: consumed < rows.length ? String(consumed) : null } };
}

/** Inclusive on both ends, which is exactly the +1-day rule applied to `YYYY-MM-DD` strings. */
function withinRange(date: string, from: string | undefined, to: string | undefined): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/** `""` means "no filter" (Ramp convention). */
function matchesEnum<T extends string>(value: T, filter: T | '' | undefined): boolean {
  return filter === undefined || filter === '' || filter === value;
}

// ---------------------------------------------------------------------------
// The X-ray emitter
// ---------------------------------------------------------------------------

export interface FakeXrayEmitter extends XrayEmitter {
  /** Every event emitted so far, in order, after schema validation. */
  readonly events: XrayEvent[];
  /** Only the events of one type, correctly narrowed. */
  ofType<T extends XrayEventType>(type: T): Extract<XrayEvent, { type: T }>[];
  /** The `data` of the last event of one type, or `undefined`. */
  lastOfType<T extends XrayEventType>(type: T): Extract<XrayEvent, { type: T }> | undefined;
  types(): string[];
  clear(): void;
}

export interface FakeXrayEmitterOptions {
  /** First `id` handed out. Ids are process-monotonic (docs/XRAY_EVENT_MODEL.md section 2). */
  readonly firstId?: number;
  readonly now?: () => Date;
  /**
   * Validate every event against the catalogue and throw on a mismatch. On by default: in a
   * test a malformed event is a bug worth failing on, even though the real emitter never throws.
   */
  readonly validate?: boolean;
  /** Correlation applied to every event unless the caller overrides it. */
  readonly correlation?: XrayCorrelation;
}

/** Records what a block emitted, assigning `id`, `ts`, `v` and the per-`xs` `seq` like the real one. */
export function createFakeXrayEmitter(options: FakeXrayEmitterOptions = {}): FakeXrayEmitter {
  const now = options.now ?? (() => FAKE_NOW);
  const validate = options.validate ?? true;
  let nextId = options.firstId ?? 1;
  const seqByXs = new Map<string, number>();
  const events: XrayEvent[] = [];

  const emitter: FakeXrayEmitter = {
    events,
    emit(type, data, correlation) {
      const merged: XrayCorrelation = { ...options.correlation, ...correlation };
      const xs = merged.xs ?? null;
      let seq: number | null = null;
      if (xs) {
        seq = (seqByXs.get(xs) ?? 0) + 1;
        seqByXs.set(xs, seq);
      }
      const id = nextId;
      const candidate = {
        id,
        ts: now().toISOString(),
        v: 1,
        type,
        seq,
        ...merged,
        xs,
        data,
      };
      nextId += 1;
      if (validate) {
        events.push(XrayEventSchema.parse(candidate));
      } else {
        events.push(candidate as unknown as XrayEvent);
      }
      // v0.2 (P-5): report the id, like the real emitter, so a block under test can assert on
      // the value it will use for `snapshot_ref`.
      return id;
    },
    ofType(type) {
      return events.filter(
        (event): event is Extract<XrayEvent, { type: typeof type }> => event.type === type,
      );
    },
    lastOfType(type) {
      const matching = emitter.ofType(type);
      return matching.length > 0 ? matching[matching.length - 1] : undefined;
    },
    types() {
      return events.map((event) => event.type);
    },
    clear() {
      events.length = 0;
      seqByXs.clear();
    },
  };
  return emitter;
}

/** Convenience for a test that wants to build one event payload without an emitter. */
export function fakeEventData<T extends XrayEventType>(
  _type: T,
  data: XrayEventDataInput<T>,
): XrayEventDataInput<T> {
  return data;
}

// ---------------------------------------------------------------------------
// BankCore
// ---------------------------------------------------------------------------

/** The three seeded, shared demo identities. Neutral English names (Decision D-1). */
export const FAKE_PERSONAS: readonly Persona[] = [
  {
    id: 'per_ava01',
    name: 'Ava Bennett',
    kind: 'retail',
    shared: true,
    seed: 'ava01',
    email: 'ava.bennett@example.com',
    created_at: '2026-01-05T09:00:00.000Z',
    transfer_limit_cents: 500_000,
  },
  {
    id: 'per_noah2',
    name: 'Noah Carter',
    kind: 'retail',
    shared: true,
    seed: 'noah2',
    email: 'noah.carter@example.com',
    created_at: '2026-01-06T09:00:00.000Z',
    transfer_limit_cents: 250_000,
  },
  {
    id: 'per_iris3',
    name: 'Iris Delgado',
    kind: 'business',
    shared: true,
    seed: 'iris3',
    email: 'iris.delgado@example.com',
    created_at: '2026-01-07T09:00:00.000Z',
    transfer_limit_cents: 2_000_000,
  },
];

/**
 * A stand-in category list. `src/bank-core` replaces it with Ramp's 43-entry table copied
 * verbatim (ids 1-44 without 22, docs/RAMP_REFERENCE.md section 6.1).
 */
export const FAKE_CATEGORIES: readonly Category[] = [
  { id: '1', name: 'Advertising' },
  { id: '2', name: 'Air Travel' },
  { id: '3', name: 'Books and Education' },
  { id: '4', name: 'Car Rental' },
  { id: '5', name: 'Charitable Contributions' },
  { id: '6', name: 'Electronics' },
  { id: '7', name: 'Entertainment' },
  { id: '8', name: 'Fuel and Gas' },
  { id: '9', name: 'Ground Transportation' },
  { id: '10', name: 'Groceries' },
  { id: '11', name: 'Insurance' },
  { id: '12', name: 'Internet and Phone' },
  { id: '13', name: 'Lodging' },
  { id: '14', name: 'Meals and Entertainment' },
  { id: '15', name: 'Office Supplies' },
  { id: '16', name: 'Professional Services' },
  { id: '17', name: 'Rent' },
  { id: '18', name: 'Restaurants' },
  { id: '19', name: 'Software and Subscriptions' },
  { id: '20', name: 'Utilities' },
];

/** USD first (Decision D-1). */
export const FAKE_CURRENCIES: readonly CurrencyInfo[] = [
  { code: 'USD', name: 'United States Dollar', symbol: '$', minor_unit_digits: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', minor_unit_digits: 2 },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', minor_unit_digits: 2 },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', minor_unit_digits: 2 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', minor_unit_digits: 2 },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', minor_unit_digits: 0 },
];

const MERCHANTS = [
  'Northline Grocers',
  'Harbor Coffee House',
  'Cedar Street Pharmacy',
  'Bright Field Utilities',
  'Union Rail Transit',
  'Lakeside Hardware',
  'Meridian Airlines',
  'Copperleaf Restaurant',
  'Quarry Books',
  'Summit Fitness Club',
] as const;

const PAYEE_NAMES = [
  'Alder Property Management',
  'Bell Ridge Insurance',
  'Crestwood Utilities',
  'Delta Point Telecom',
  'Evergreen Landscaping',
  'Fairmont Dental Group',
  'Granite Auto Service',
  'Harborview Clinic',
  'Ironwood Contractors',
  'Juniper Cleaning Services',
] as const;

const BANK_NAMES = ['First Meridian Bank', 'Union Harbor Savings', 'Cedar Trust Bank'] as const;

export interface FakeBankOptions {
  readonly personas?: readonly Persona[];
  /** Rows generated per entity, per persona. About 20 by default. */
  readonly rowsPerEntity?: number;
  readonly now?: () => Date;
}

interface MutableOverlay {
  readonly persona_id: string;
  readonly login_id: string;
  card_status: Record<string, CardStatus>;
  balance_delta_cents: Record<string, number>;
  transfers: Transfer[];
  audit: AuditEntry[];
  created_at: string;
  last_used_at: string;
}

/** Extra handles a test needs but a production `BankCore` must not expose. */
export interface FakeBankCore extends BankCore {
  /** The seeded personas, synchronously. */
  readonly seededPersonas: readonly Persona[];
  /** Forces the next `confirmTransfer` to see a different total, exercising the reprice guard. */
  repriceNextConfirm(deltaCents: number): void;
  /** Drops every overlay, as a restart would (A-15). */
  resetOverlays(): void;
  /** The overlay as stored, for assertions about copy-on-write isolation (ADR-15). */
  peekOverlay(personaId: string, loginId: string): BankOverlay | undefined;
}

function buildDataset(persona: Persona, rows: number, reference: Date): BankDataset {
  const random = makeRandom(`dataset:${persona.seed}`);
  const short = persona.seed;

  const accountTypes = ['checking', 'savings', 'credit_card'] as const;
  const accounts: Account[] = Array.from({ length: rows }, (_unused, index) => {
    const accountType = accountTypes[index % accountTypes.length] as (typeof accountTypes)[number];
    const balance = integerBetween(random, 25_000, 4_500_000);
    return {
      id: `acc_${short}_${pad(index + 1)}`,
      persona_id: persona.id,
      name: `${accountType === 'credit_card' ? 'Card' : accountType === 'savings' ? 'Savings' : 'Everyday'} Account ${index + 1}`,
      account_type: accountType,
      currency: 'USD',
      balance_cents: accountType === 'credit_card' ? -balance : balance,
      available_balance_cents: accountType === 'credit_card' ? -balance : balance - 1500,
      credit_limit_cents: accountType === 'credit_card' ? 1_000_000 : null,
      account_number_last4: pad(integerBetween(random, 1000, 9999), 4),
      routing_number_last4: pad(integerBetween(random, 1000, 9999), 4),
      status: 'open',
      opened_at: isoTimestamp(reference, 900 - index),
    };
  });

  const cards: Card[] = Array.from({ length: rows }, (_unused, index) => {
    const account = accounts[index % accounts.length] as Account;
    const status: CardStatus =
      index === rows - 1 ? 'fraud_locked' : index === 1 ? 'locked' : 'active';
    return {
      id: `card_${short}_${pad(index + 1)}`,
      account_id: account.id,
      persona_id: persona.id,
      cardholder_name: persona.name,
      brand: index % 2 === 0 ? 'Meridian Debit' : 'Meridian Credit',
      last4: pad(integerBetween(random, 1000, 9999), 4),
      status,
      spending_limit_cents: integerBetween(random, 50_000, 1_500_000),
      expires_on: `202${7 + (index % 3)}-${pad((index % 12) + 1)}`,
      issued_at: isoTimestamp(reference, 700 - index * 5),
    };
  });

  const statuses = ['posted', 'posted', 'posted', 'pending', 'declined'] as const;
  const transactions: Transaction[] = Array.from({ length: rows }, (_unused, index) => {
    const account = accounts[index % accounts.length] as Account;
    const card = cards[index % cards.length] as Card;
    const status = statuses[index % statuses.length] as (typeof statuses)[number];
    const amount = integerBetween(random, 350, 240_000);
    return {
      id: `txn_${short}_${pad(index + 1)}`,
      account_id: account.id,
      card_id: index % 4 === 3 ? null : card.id,
      persona_id: persona.id,
      date: isoDate(reference, index * 3 + 1),
      posted_at: status === 'pending' ? null : isoTimestamp(reference, index * 3),
      merchant_name: pick(random, MERCHANTS),
      category_id: (FAKE_CATEGORIES[index % FAKE_CATEGORIES.length] as Category).id,
      amount_cents: index % 7 === 0 ? amount : -amount,
      currency: 'USD',
      status,
      decline_reason: status === 'declined' ? 'insufficient_funds' : null,
      description: `Purchase ${index + 1}`,
    };
  });

  const payees: Payee[] = Array.from({ length: rows }, (_unused, index) => ({
    id: `pay_${short}_${pad(index + 1)}`,
    persona_id: persona.id,
    name: PAYEE_NAMES[index % PAYEE_NAMES.length] as string,
    bank_name: BANK_NAMES[index % BANK_NAMES.length] as string,
    account_number_masked: `****${pad(integerBetween(random, 1000, 9999), 4)}`,
    routing_number_masked: `****${pad(integerBetween(random, 1000, 9999), 4)}`,
    rail: index % 3 === 0 ? 'wire' : 'ach',
    is_active: index % 5 !== 4,
    created_at: isoTimestamp(reference, 400 - index * 3),
  }));

  const transferStatuses = ['completed', 'completed', 'scheduled', 'failed'] as const;
  const transfers: Transfer[] = Array.from({ length: rows }, (_unused, index) => {
    const account = accounts[index % accounts.length] as Account;
    const payee = payees[index % payees.length] as Payee;
    const amount = integerBetween(random, 2_500, 350_000);
    const fee = index % 3 === 0 ? 1500 : 0;
    const status = transferStatuses[
      index % transferStatuses.length
    ] as (typeof transferStatuses)[number];
    return {
      id: `tr_${short}_${pad(index + 1)}`,
      persona_id: persona.id,
      from_account_id: account.id,
      to_account_id: null,
      payee_id: payee.id,
      direction: index % 4 === 1 ? 'incoming' : 'outgoing',
      rail: payee.rail,
      amount_cents: amount,
      fee_cents: fee,
      total_cents: amount + fee,
      currency: 'USD',
      status,
      memo: index % 2 === 0 ? `Transfer ${index + 1}` : null,
      scheduled_for: isoDate(reference, index * 5 + 2),
      created_at: isoTimestamp(reference, index * 5 + 2),
      completed_at: status === 'completed' ? isoTimestamp(reference, index * 5 + 1) : null,
      failure_reason: status === 'failed' ? 'payee_rejected' : null,
      audit_id: null,
    };
  });

  const billStatuses = ['open', 'paid', 'overdue'] as const;
  const bills: Bill[] = Array.from({ length: rows }, (_unused, index) => {
    const payee = payees[index % payees.length] as Payee;
    const account = accounts[index % accounts.length] as Account;
    const status = billStatuses[index % billStatuses.length] as (typeof billStatuses)[number];
    return {
      id: `bill_${short}_${pad(index + 1)}`,
      persona_id: persona.id,
      payee_id: payee.id,
      account_id: account.id,
      amount_cents: integerBetween(random, 1_500, 180_000),
      currency: 'USD',
      due_date: isoDate(reference, index * 4 - 10),
      issued_date: isoDate(reference, index * 4 + 20),
      status,
      paid_at: status === 'paid' ? isoTimestamp(reference, index * 4 + 1) : null,
      reference: `INV-${pad(index + 1, 4)}`,
    };
  });

  return {
    persona,
    accounts,
    cards,
    transactions,
    transfers,
    payees,
    bills,
    generated_at: reference.toISOString(),
  };
}

/** A complete, deterministic in-memory `BankCore` with the ADR-15 dataset/overlay layering. */
export function createFakeBankCore(options: FakeBankOptions = {}): FakeBankCore {
  const now = options.now ?? (() => FAKE_NOW);
  const rows = options.rowsPerEntity ?? 20;
  const personas = new Map<string, Persona>(
    (options.personas ?? FAKE_PERSONAS).map((persona) => [persona.id, persona]),
  );
  const datasets = new Map<string, BankDataset>();
  const overlays = new Map<string, MutableOverlay>();
  const previews = new Map<string, TransferPreview>();
  let repriceDelta = 0;
  let sequence = 0;

  function nextSuffix(): string {
    sequence += 1;
    return pad(sequence, 4);
  }

  function datasetFor(personaId: string): BankDataset {
    const cached = datasets.get(personaId);
    if (cached) return cached;
    const persona = personas.get(personaId);
    if (!persona) throw new Error(`unknown persona: ${personaId}`);
    const built = buildDataset(persona, rows, now());
    datasets.set(personaId, built);
    return built;
  }

  function overlayFor(personaId: string, loginId: string): MutableOverlay {
    const key = `${personaId}|${loginId}`;
    const existing = overlays.get(key);
    if (existing) {
      existing.last_used_at = now().toISOString();
      return existing;
    }
    const created: MutableOverlay = {
      persona_id: personaId,
      login_id: loginId,
      card_status: {},
      balance_delta_cents: {},
      transfers: [],
      audit: [],
      created_at: now().toISOString(),
      last_used_at: now().toISOString(),
    };
    overlays.set(key, created);
    return created;
  }

  /** Reads merge the overlay over the dataset (ADR-15). */
  function mergedAccounts(scope: BankScope): Account[] {
    const overlay = overlayFor(scope.persona_id, scope.login_id);
    return datasetFor(scope.persona_id).accounts.map((account) => {
      const delta = overlay.balance_delta_cents[account.id] ?? 0;
      return delta === 0
        ? account
        : {
            ...account,
            balance_cents: account.balance_cents + delta,
            available_balance_cents: account.available_balance_cents + delta,
          };
    });
  }

  function mergedCards(scope: BankScope): Card[] {
    const overlay = overlayFor(scope.persona_id, scope.login_id);
    return datasetFor(scope.persona_id).cards.map((card) => {
      const status = overlay.card_status[card.id];
      return status === undefined ? card : { ...card, status };
    });
  }

  function mergedTransfers(scope: BankScope): Transfer[] {
    const overlay = overlayFor(scope.persona_id, scope.login_id);
    return [...datasetFor(scope.persona_id).transfers, ...overlay.transfers];
  }

  function appendAudit(
    scope: BankScope,
    entry: Omit<AuditEntry, 'id' | 'persona_id' | 'login_id' | 'grant_id' | 'created_at'>,
  ): string {
    const overlay = overlayFor(scope.persona_id, scope.login_id);
    const id = `aud_${nextSuffix()}`;
    overlay.audit.push({
      id,
      persona_id: scope.persona_id,
      login_id: scope.login_id,
      grant_id: scope.grant_id ?? null,
      created_at: now().toISOString(),
      ...entry,
    });
    return id;
  }

  const directory: PersonaDirectory = {
    async list() {
      return [...personas.values()].filter((persona) => persona.shared);
    },
    async get(personaId) {
      return personas.get(personaId) ?? null;
    },
    async createDemoPersona(input) {
      const seed = input?.seed ?? `demo${pad(personas.size + 1)}`;
      const kind: PersonaKind = input?.kind ?? 'retail';
      const persona: Persona = {
        id: `per_${seed}`,
        name: input?.name ?? `Demo Customer ${personas.size + 1}`,
        kind,
        shared: false,
        seed,
        email: `demo${personas.size + 1}@example.com`,
        created_at: now().toISOString(),
        transfer_limit_cents: 500_000,
      };
      personas.set(persona.id, persona);
      return persona;
    },
  };

  const core: FakeBankCore = {
    personas: directory,
    seededPersonas: [...personas.values()],

    async dataset(personaId) {
      return datasetFor(personaId);
    },

    async overlay(personaId, loginId) {
      const overlay = overlayFor(personaId, loginId);
      return {
        persona_id: overlay.persona_id,
        login_id: overlay.login_id,
        card_status: { ...overlay.card_status },
        balance_delta_cents: { ...overlay.balance_delta_cents },
        transfers: [...overlay.transfers],
        audit: [...overlay.audit],
        created_at: overlay.created_at,
        last_used_at: overlay.last_used_at,
      };
    },

    async listAccounts(scope, query?: AccountQuery) {
      const filtered = mergedAccounts(scope).filter(
        (account) =>
          (query?.account_id === undefined || account.id === query.account_id) &&
          matchesEnum(account.account_type, query?.account_type),
      );
      return paginate(filtered, query);
    },

    async listCards(scope, query?: CardQuery) {
      const filtered = mergedCards(scope).filter(
        (card) =>
          (query?.account_id === undefined || card.account_id === query.account_id) &&
          matchesEnum(card.status, query?.status),
      );
      return paginate(filtered, query);
    },

    async listTransactions(scope, query: TransactionQuery) {
      const categories = new Set(query.category_ids ?? []);
      const filtered = datasetFor(scope.persona_id)
        .transactions.filter(
          (transaction) =>
            withinRange(transaction.date, query.from_date, query.to_date) &&
            (query.account_id === undefined || transaction.account_id === query.account_id) &&
            (query.card_id === undefined || transaction.card_id === query.card_id) &&
            (categories.size === 0 || categories.has(transaction.category_id)) &&
            matchesEnum(transaction.status, query.status),
        )
        // Ramp's `order_by_amount_desc`; our amounts are signed, so the magnitude orders them.
        .sort((left, right) => Math.abs(right.amount_cents) - Math.abs(left.amount_cents));
      return paginate(filtered, query);
    },

    async listTransfers(scope, query: TransferQuery) {
      const filtered = mergedTransfers(scope).filter(
        (transfer) =>
          withinRange(transfer.scheduled_for, query.from_date, query.to_date) &&
          matchesEnum(transfer.direction, query.direction) &&
          matchesEnum(transfer.status, query.status),
      );
      return paginate(filtered, query);
    },

    async listBills(scope, query: BillQuery) {
      const filtered = datasetFor(scope.persona_id).bills.filter(
        (bill) =>
          withinRange(bill.due_date, query.from_date, query.to_date) &&
          matchesEnum(bill.status, query.payment_status),
      );
      return paginate(filtered, query);
    },

    async listPayees(scope, query?: PayeeQuery) {
      const needle = query?.name?.toLowerCase();
      const wantActive = query?.is_active ?? true;
      const filtered = datasetFor(scope.persona_id).payees.filter(
        (payee) =>
          payee.is_active === wantActive &&
          (needle === undefined || payee.name.toLowerCase().includes(needle)),
      );
      return paginate(filtered, query);
    },

    async listStatementLines(scope, query: StatementLineQuery) {
      const dataset = datasetFor(scope.persona_id);
      const lines: StatementLine[] = [
        ...dataset.transactions.map<StatementLine>((transaction) => ({
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
        })),
        ...mergedTransfers(scope).map<StatementLine>((transfer) => ({
          source: 'transfer',
          id: transfer.id,
          account_id: transfer.from_account_id,
          date: transfer.scheduled_for,
          description: transfer.memo ?? 'Transfer',
          counterparty: transfer.payee_id ?? transfer.to_account_id ?? 'internal',
          amount_cents:
            transfer.direction === 'outgoing' ? -transfer.total_cents : transfer.total_cents,
          currency: transfer.currency,
          status: transfer.status,
          category_id: null,
          reference: null,
        })),
        ...dataset.bills.map<StatementLine>((bill) => ({
          source: 'bill',
          id: bill.id,
          account_id: bill.account_id,
          date: bill.due_date,
          description: `Bill ${bill.reference}`,
          counterparty: bill.payee_id,
          amount_cents: -bill.amount_cents,
          currency: bill.currency,
          status: bill.status,
          category_id: null,
          reference: bill.reference,
        })),
      ]
        .filter((line) => withinRange(line.date, query.from_date, query.to_date))
        .sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0));
      return paginate(lines, query);
    },

    async listAuditEntries(scope, query?: AuditQuery) {
      const overlay = overlayFor(scope.persona_id, scope.login_id);
      const filtered = overlay.audit.filter(
        (entry) => query?.action === undefined || entry.action === query.action,
      );
      return paginate(filtered, query);
    },

    async listCategories() {
      return FAKE_CATEGORIES;
    },

    async listCurrencies() {
      return FAKE_CURRENCIES;
    },

    async lockOrUnlockCard(scope, input: CardMutationInput): Promise<CardMutationResult> {
      const card = mergedCards(scope).find((candidate) => candidate.id === input.card_id);
      if (!card) {
        return {
          ok: false,
          reason: 'unknown_card',
          message: `no card with id ${input.card_id}`,
        };
      }
      if (card.status === 'fraud_locked') {
        return {
          ok: false,
          reason: 'fraud_locked',
          message:
            'this card was locked by the bank for suspected fraud and cannot be unlocked with this tool',
          card,
        };
      }
      const target: CardStatus = input.action === 'lock' ? 'locked' : 'active';
      const changed = card.status !== target;
      const overlay = overlayFor(scope.persona_id, scope.login_id);
      overlay.card_status[card.id] = target;
      const auditId = appendAudit(scope, {
        action: input.action === 'lock' ? 'card.lock' : 'card.unlock',
        target_type: 'card',
        target_id: card.id,
        summary: `card ending ${card.last4} ${input.action === 'lock' ? 'locked' : 'unlocked'}`,
        rationale: input.rationale ?? null,
      });
      return { ok: true, card: { ...card, status: target }, audit_id: auditId, changed };
    },

    async previewTransfer(scope, input: TransferPreviewInput): Promise<TransferPreviewResult> {
      const persona = personas.get(scope.persona_id);
      if (!persona) return { ok: false, reason: 'unknown_account', message: 'unknown persona' };
      if (!Number.isInteger(input.amount) || input.amount <= 0) {
        return {
          ok: false,
          reason: 'invalid_amount',
          message: 'amount must be a positive integer number of cents',
        };
      }
      const accounts = mergedAccounts(scope);
      const from = accounts.find((account) => account.id === input.from_account_id);
      if (!from) {
        return {
          ok: false,
          reason: 'unknown_account',
          message: `no account with id ${input.from_account_id}`,
        };
      }
      if (from.status === 'closed') {
        return { ok: false, reason: 'account_closed', message: 'the source account is closed' };
      }
      if (input.currency !== from.currency) {
        return {
          ok: false,
          reason: 'currency_not_supported',
          message: `this account is funded in ${from.currency}`,
        };
      }
      const target = input.to;
      let rail: Transfer['rail'] = 'internal';
      if ('payee_id' in target) {
        const payeeId = target.payee_id;
        const payee = datasetFor(scope.persona_id).payees.find(
          (candidate) => candidate.id === payeeId,
        );
        if (!payee) {
          return { ok: false, reason: 'unknown_payee', message: `no payee with id ${payeeId}` };
        }
        if (!payee.is_active) {
          return {
            ok: false,
            reason: 'payee_inactive',
            message: `payee ${payee.name} is archived and cannot receive a transfer`,
          };
        }
        rail = payee.rail;
      } else {
        const targetAccountId = target.account_id;
        if (!accounts.some((account) => account.id === targetAccountId)) {
          return {
            ok: false,
            reason: 'unknown_account',
            message: `no account with id ${targetAccountId}`,
          };
        }
      }
      if (input.amount > persona.transfer_limit_cents) {
        return {
          ok: false,
          reason: 'over_limit',
          message: `the per-transfer limit is ${persona.transfer_limit_cents} cents`,
        };
      }
      const fee = rail === 'wire' ? 2500 : 0;
      const total = input.amount + fee;
      if (total > from.available_balance_cents) {
        return {
          ok: false,
          reason: 'insufficient_funds',
          message: `the account has ${from.available_balance_cents} cents available`,
        };
      }
      const preview: TransferPreview = {
        preview_id: `prv_${nextSuffix()}`,
        from_account_id: from.id,
        to: input.to,
        amount: input.amount,
        fee,
        total,
        resulting_balance: from.balance_cents - total,
        currency: input.currency,
        rail,
        policy_outlook: {
          status: total > persona.transfer_limit_cents / 2 ? 'warning' : 'ok',
          message: `within the ${persona.transfer_limit_cents} cent per-transfer limit`,
          per_transfer_limit_cents: persona.transfer_limit_cents,
          daily_remaining_cents: persona.transfer_limit_cents - total,
        },
        expected_total_amount: total,
        expires_at: new Date(now().getTime() + 15 * 60_000).toISOString(),
      };
      previews.set(preview.preview_id, preview);
      return { ok: true, preview };
    },

    async confirmTransfer(scope, input: TransferConfirmInput): Promise<TransferConfirmResult> {
      const preview = previews.get(input.preview_id);
      if (!preview) {
        return {
          ok: false,
          reason: 'unknown_preview',
          message: `no preview with id ${input.preview_id}; call create_transfer without confirm first`,
        };
      }
      if (new Date(preview.expires_at).getTime() < now().getTime()) {
        previews.delete(input.preview_id);
        return {
          ok: false,
          reason: 'expired_preview',
          message: 'the preview expired; run the preview step again',
        };
      }
      const currentTotal = preview.total + repriceDelta;
      if (repriceDelta !== 0) {
        const repriced: TransferPreview = {
          ...preview,
          total: currentTotal,
          expected_total_amount: currentTotal,
        };
        previews.set(preview.preview_id, repriced);
        repriceDelta = 0;
        return {
          ok: false,
          reason: 'repriced',
          message: `the total changed from ${input.expected_total_amount} to ${currentTotal} cents; show the new total to the user`,
          preview: repriced,
        };
      }
      if (input.expected_total_amount !== preview.total) {
        return {
          ok: false,
          reason: 'repriced',
          message: `expected_total_amount ${input.expected_total_amount} does not match the preview total ${preview.total}`,
          preview,
        };
      }
      const overlay = overlayFor(scope.persona_id, scope.login_id);
      const auditId = appendAudit(scope, {
        action: 'transfer.confirm',
        target_type: 'transfer',
        target_id: preview.preview_id,
        summary: `transfer of ${preview.amount} cents confirmed`,
        rationale: input.rationale ?? null,
      });
      const transfer: Transfer = {
        id: `tr_${nextSuffix()}`,
        persona_id: scope.persona_id,
        from_account_id: preview.from_account_id,
        to_account_id: 'account_id' in preview.to ? preview.to.account_id : null,
        payee_id: 'payee_id' in preview.to ? preview.to.payee_id : null,
        direction: 'outgoing',
        rail: preview.rail,
        amount_cents: preview.amount,
        fee_cents: preview.fee,
        total_cents: preview.total,
        currency: preview.currency,
        status: 'completed',
        memo: null,
        scheduled_for: isoDate(now(), 0),
        created_at: now().toISOString(),
        completed_at: now().toISOString(),
        failure_reason: null,
        audit_id: auditId,
      };
      overlay.transfers.push(transfer);
      overlay.balance_delta_cents[preview.from_account_id] =
        (overlay.balance_delta_cents[preview.from_account_id] ?? 0) - preview.total;
      previews.delete(input.preview_id);
      return { ok: true, transfer, audit_id: auditId };
    },

    repriceNextConfirm(deltaCents) {
      repriceDelta = deltaCents;
    },

    resetOverlays() {
      overlays.clear();
      previews.clear();
    },

    peekOverlay(personaId, loginId) {
      const overlay = overlays.get(`${personaId}|${loginId}`);
      if (!overlay) return undefined;
      return {
        persona_id: overlay.persona_id,
        login_id: overlay.login_id,
        card_status: { ...overlay.card_status },
        balance_delta_cents: { ...overlay.balance_delta_cents },
        transfers: [...overlay.transfers],
        audit: [...overlay.audit],
        created_at: overlay.created_at,
        last_used_at: overlay.last_used_at,
      };
    },
  };
  return core;
}

// ---------------------------------------------------------------------------
// ScratchDb
// ---------------------------------------------------------------------------

/** The token deny-list of ADR-9; the primary ATTACH guard, because `readonly` is true for it. */
export const SQL_DENYLIST_TOKENS = [
  'attach',
  'detach',
  'pragma',
  'vacuum',
  'insert',
  'update',
  'delete',
  'drop',
  'create',
  'alter',
  'replace',
  'reindex',
  'analyze',
] as const;

/** Flattens nested keys with `__`, exactly as Ramp's `get_nested_keys` does. */
export function flattenRow(row: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const name = prefix === '' ? key : `${prefix}__${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flat, flattenRow(value as Record<string, unknown>, name));
    } else if (Array.isArray(value)) {
      flat[name] = JSON.stringify(value);
    } else {
      flat[name] = value;
    }
  }
  return flat;
}

/** The union of keys across all rows, in first-seen order (fixes Ramp OSS defect #1). */
export function advertisedColumns(rows: readonly Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(flattenRow(row))) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

interface FakeTable {
  readonly table_name: string;
  readonly source_tool: string;
  rows: Record<string, unknown>[];
  columns_advertised: string[];
  columns_selected: string[];
  processed: boolean;
  created_at: string;
  expires_at: string;
}

export interface FakeScratchDbOptions {
  readonly grantId?: string;
  readonly now?: () => Date;
  readonly maxQueryRows?: number;
  readonly maxTables?: number;
  readonly tableTtlMinutes?: number;
}

export interface FakeScratchDb extends ScratchDb {
  /** The next call of any method rejects with this reason, once. Drives the error-path tests. */
  failNextWith(reason: ScratchDbFailureReason, message?: string): void;
  /** Every SQL string the fake was asked to run, in order. */
  readonly executedSql: string[];
  /** `terminate` reasons seen so far; empty until the worker is torn down. */
  readonly terminations: ScratchTerminateReason[];
  tableNames(): string[];
}

/**
 * A per-grant scratch database that enforces the ADR-9 guard rules and the row cap without
 * running SQL: `query` returns the rows the table holds, projected onto the processed columns.
 * `failNextWith('timeout')` reproduces the `worker.terminate()` path that ADR-9 exists for.
 */
export function createFakeScratchDb(options: FakeScratchDbOptions = {}): FakeScratchDb {
  const now = options.now ?? (() => FAKE_NOW);
  const grantId = options.grantId ?? 'grt_fake01';
  const maxQueryRows = options.maxQueryRows ?? TOOL_LIMIT_DEFAULTS.maxQueryRows;
  const maxTables = options.maxTables ?? TOOL_LIMIT_DEFAULTS.maxTablesPerGrant;
  const ttlMinutes = options.tableTtlMinutes ?? TOOL_LIMIT_DEFAULTS.tableTtlMinutes;
  const tables = new Map<string, FakeTable>();
  const executedSql: string[] = [];
  const terminations: ScratchTerminateReason[] = [];
  let pendingFailure: { reason: ScratchDbFailureReason; message: string } | null = null;
  let counter = 0;

  function consumeFailure(sql?: string): void {
    if (!pendingFailure) return;
    const { reason, message } = pendingFailure;
    pendingFailure = null;
    throw new ScratchDbError(reason, message, sql === undefined ? {} : { sql });
  }

  function guard(sql: string): void {
    const trimmed = sql.trim();
    const withoutTrailing = trimmed.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
      throw new ScratchDbError('multi_statement', 'only one statement may be sent at a time', {
        sql,
      });
    }
    const lowered = ` ${withoutTrailing.toLowerCase().replace(/[^a-z0-9_]+/g, ' ')} `;
    for (const token of SQL_DENYLIST_TOKENS) {
      if (lowered.includes(` ${token} `)) {
        throw new ScratchDbError('denylist', `the statement keyword "${token}" is not allowed`, {
          sql,
        });
      }
    }
    if (!/^(select|with)\b/i.test(withoutTrailing)) {
      throw new ScratchDbError('not_readonly', 'only read-only SELECT statements are allowed', {
        sql,
      });
    }
  }

  const database: FakeScratchDb = {
    grantId,
    executedSql,
    terminations,

    failNextWith(reason, message) {
      pendingFailure = { reason, message: message ?? `forced ${reason}` };
    },

    tableNames() {
      return [...tables.keys()];
    },

    async load(input: LoadTableInput): Promise<LoadedTable> {
      consumeFailure();
      if (tables.size >= maxTables) {
        throw new ScratchDbError('grant_cap', `too many tables loaded (max ${maxTables})`);
      }
      counter += 1;
      const tableName = input.table_name ?? `${input.source_tool}_${pad(counter, 8)}`;
      const rows = input.rows.map((row) => flattenRow(row));
      const table: FakeTable = {
        table_name: tableName,
        source_tool: input.source_tool,
        rows,
        columns_advertised: advertisedColumns(input.rows),
        columns_selected: [],
        processed: false,
        created_at: now().toISOString(),
        expires_at: new Date(now().getTime() + ttlMinutes * 60_000).toISOString(),
      };
      tables.set(tableName, table);
      return {
        table_name: tableName,
        rows: rows.length,
        columns_advertised: table.columns_advertised,
      };
    },

    async process(input: ProcessTableInput): Promise<ProcessedTable> {
      consumeFailure();
      const table = tables.get(input.table_name);
      if (!table) {
        throw new ScratchDbError('unknown_table', `no table named ${input.table_name}`);
      }
      if (input.cols.length === 0) {
        throw new ScratchDbError('unknown_column', 'at least one column must be selected');
      }
      const unknown = input.cols.filter((col) => !table.columns_advertised.includes(col));
      if (unknown.length > 0) {
        throw new ScratchDbError(
          'unknown_column',
          `these columns were not advertised: ${unknown.join(', ')}`,
        );
      }
      table.columns_selected = [...input.cols];
      table.processed = true;
      return {
        table_name: table.table_name,
        rows: table.rows.length,
        columns_selected: table.columns_selected,
      };
    },

    async query(input: ScratchQueryInput): Promise<ScratchQueryResult> {
      executedSql.push(input.sql);
      consumeFailure(input.sql);
      guard(input.sql);
      const table = tables.get(input.table_name);
      if (!table || !table.processed) {
        throw new ScratchDbError('unknown_table', `no processed table named ${input.table_name}`, {
          sql: input.sql,
        });
      }
      const cap = input.max_rows ?? maxQueryRows;
      const projected = table.rows.map((row) =>
        Object.fromEntries(table.columns_selected.map((col) => [col, row[col] ?? null])),
      );
      const capped = projected.length > cap;
      return {
        rows: projected.slice(0, cap),
        columns: [...table.columns_selected],
        rows_returned: Math.min(projected.length, cap),
        capped,
        duration_ms: 1,
      };
    },

    async clear(tableName: string): Promise<void> {
      consumeFailure();
      if (!tables.delete(tableName)) {
        throw new ScratchDbError('unknown_table', `no table named ${tableName}`);
      }
    },

    async listTables(): Promise<readonly ScratchTable[]> {
      return [...tables.values()].map<ScratchTable>((table) => ({
        table_name: table.table_name,
        source_tool: table.source_tool,
        rows: table.rows.length,
        columns_advertised: [...table.columns_advertised],
        columns_selected: [...table.columns_selected],
        processed: table.processed,
        created_at: table.created_at,
        expires_at: table.expires_at,
      }));
    },

    async terminate(reason: ScratchTerminateReason): Promise<void> {
      terminations.push(reason);
      tables.clear();
    },
  };
  return database;
}

// ---------------------------------------------------------------------------
// AuthContext
// ---------------------------------------------------------------------------

export const FAKE_OAUTH_CLIENT: OAuthClient = {
  client_id: 'cli_5f3a9c21',
  client_name: 'Claude',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  token_endpoint_auth_method: 'none',
  reconstructed: false,
};

/** The read-only scope set a first consent grants (docs/TOOL_CATALOG.md section 2). */
export const FAKE_READ_ONLY_SCOPES: readonly Scope[] = [
  'profile',
  'accounts:read',
  'transactions:read',
  'cards:read',
  'transfers:read',
  'bills:read',
  'payees:read',
  'xray:read',
];

/** The same grant after a step-up extension (ADR-14). */
export const FAKE_READ_WRITE_SCOPES: readonly Scope[] = [
  ...FAKE_READ_ONLY_SCOPES,
  'cards:write',
  'transfers:write',
];

/** Builds an `AuthContext`; `auth_level` is derived from the scopes unless it is overridden. */
export function createFakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  const scopes = overrides.scopes ?? FAKE_READ_ONLY_SCOPES;
  const base: AuthContext = {
    persona: FAKE_PERSONAS[0] as Persona,
    login_id: 'lgn_demo01',
    grant_id: 'grt_demo01',
    parent_grant_id: null,
    scopes,
    auth_level: authLevelForScopes(scopes),
    client: { name: 'Anthropic', version: '1.0.0', title: null },
    oauth_client: FAKE_OAUTH_CLIENT,
    xs: 'xs_demo01',
    boot_id: 'boot_fake01',
    token_expires_at: new Date(FAKE_NOW.getTime() + 3_600_000).toISOString(),
    aud: 'https://bank.example.com/mcp',
  };
  return { ...base, ...overrides, scopes, auth_level: overrides.auth_level ?? base.auth_level };
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface FakePairingOptions {
  readonly now?: () => Date;
  readonly publicBaseUrl?: string;
  readonly adminToken?: string;
  /** Failed exchanges per IP prefix before `rate_limited` (docs/DEPLOYMENT.md section 3). */
  readonly maxFailures?: number;
}

export interface FakePairing extends Pairing {
  /** Codes minted so far, newest last. */
  readonly issued: PairingCode[];
  /** Forces the next `exchange` to look expired. */
  expireNext(): void;
}

/** Deterministic pairing codes: `BANK-AAAA-AAAB-AC`, then `...AD`, and so on. */
export function createFakePairing(options: FakePairingOptions = {}): FakePairing {
  const now = options.now ?? (() => FAKE_NOW);
  const baseUrl = options.publicBaseUrl ?? 'https://bank.example.com';
  const adminToken = options.adminToken ?? 'admin-token-for-tests';
  const maxFailures = options.maxFailures ?? 5;
  const codes = new Map<string, { login_id: string; expires_at: string }>();
  const issued: PairingCode[] = [];
  const failures = new Map<string, number>();
  let counter = 0;
  let expireNextExchange = false;

  function mintCode(): string {
    counter += 1;
    const characters = Array.from({ length: 10 }, (_unused, index) => {
      const position = (counter * 7 + index * 3) % PAIRING_CODE_ALPHABET.length;
      return PAIRING_CODE_ALPHABET[position] as string;
    }).join('');
    return formatPairingCode(characters);
  }

  const pairing: FakePairing = {
    issued,

    expireNext() {
      expireNextExchange = true;
    },

    async createCode(input) {
      const ttlHours = input.ttl_hours ?? 24;
      const code = mintCode();
      const expiresAt = new Date(now().getTime() + ttlHours * 3_600_000).toISOString();
      codes.set(code, { login_id: input.login_id, expires_at: expiresAt });
      const minted: PairingCode = { code, url: pairingUrl(baseUrl, code), expires_at: expiresAt };
      issued.push(minted);
      return minted;
    },

    async exchange(code, context): Promise<PairingExchangeResult> {
      const key = context?.remote_ip_prefix ?? 'unknown';
      const failed = failures.get(key) ?? 0;
      if (failed >= maxFailures) return { ok: false, reason: 'rate_limited' };
      const entry = codes.get(code);
      if (!entry) {
        failures.set(key, failed + 1);
        return { ok: false, reason: 'unknown_code' };
      }
      if (expireNextExchange || new Date(entry.expires_at).getTime() < now().getTime()) {
        expireNextExchange = false;
        failures.set(key, failed + 1);
        return { ok: false, reason: 'expired' };
      }
      return {
        ok: true,
        login_id: entry.login_id,
        viewer_kind: 'pairing',
        expires_at: entry.expires_at,
      };
    },

    async exchangeAdminToken(token): Promise<PairingExchangeResult> {
      if (token !== adminToken) return { ok: false, reason: 'unknown_code' };
      return {
        ok: true,
        login_id: '',
        viewer_kind: 'admin',
        expires_at: new Date(now().getTime() + 24 * 3_600_000).toISOString(),
      };
    },
  };
  return pairing;
}

// ---------------------------------------------------------------------------
// ToolContext: everything wired together
// ---------------------------------------------------------------------------

export const FAKE_TOOL_LIMITS: ToolLimits = {
  maxTablesPerGrant: TOOL_LIMIT_DEFAULTS.maxTablesPerGrant,
  maxQueryRows: TOOL_LIMIT_DEFAULTS.maxQueryRows,
  tableTtlMinutes: TOOL_LIMIT_DEFAULTS.tableTtlMinutes,
  queryTimeoutMs: TOOL_LIMIT_DEFAULTS.queryTimeoutMs,
  maxConcurrentEtlOps: TOOL_LIMIT_DEFAULTS.maxConcurrentEtlOps,
  contentCharCap: CLAUDE_CONTENT_CHAR_CAP,
  budgetMs: CLAUDE_TOOL_BUDGET_MS,
};

export interface FakeToolContext extends ToolContext {
  readonly bank: FakeBankCore;
  readonly scratch: FakeScratchDb;
  readonly xray: FakeXrayEmitter;
  readonly pairing: FakePairing;
}

export interface FakeToolContextOptions {
  readonly auth?: Partial<AuthContext>;
  readonly featureFlags?: readonly FeatureFlag[];
  readonly limits?: Partial<ToolLimits>;
  readonly now?: () => Date;
  readonly requestId?: string | null;
  readonly publicBaseUrl?: string;
}

/** One call gives a `tools` test everything a handler can reach. */
export function createFakeToolContext(options: FakeToolContextOptions = {}): FakeToolContext {
  const now = options.now ?? (() => FAKE_NOW);
  const auth = createFakeAuthContext(options.auth ?? {});
  const publicBaseUrl = options.publicBaseUrl ?? 'https://bank.example.com';
  return {
    auth,
    bank: createFakeBankCore({ now }),
    scratch: createFakeScratchDb({ grantId: auth.grant_id, now }),
    xray: createFakeXrayEmitter({
      now,
      correlation: {
        xs: auth.xs,
        login_id: auth.login_id,
        grant_id: auth.grant_id,
        persona_id: auth.persona.id,
        client: auth.client,
        era: 'legacy',
        protocol_version: '2025-11-25',
        request_id: options.requestId ?? null,
      },
    }),
    pairing: createFakePairing({ now, publicBaseUrl }),
    featureFlags: options.featureFlags ?? DEFAULT_FEATURE_FLAGS,
    limits: { ...FAKE_TOOL_LIMITS, ...options.limits },
    now,
    requestId: options.requestId ?? null,
    publicBaseUrl,
  };
}

/** The `BankScope` matching an `AuthContext`, so a test does not have to build it by hand. */
export function bankScopeOf(auth: AuthContext): BankScope {
  return {
    persona_id: auth.persona.id,
    login_id: auth.login_id ?? 'lgn_anonymous',
    grant_id: auth.grant_id,
  };
}

// ---------------------------------------------------------------------------
// The public lane (contracts v0.7, D-26)
// ---------------------------------------------------------------------------

/** One product with two plans and three prices, and two locations in one city. */
export const FAKE_PUBLIC_PRODUCT: ProductDetail = {
  product_id: 'fake_checking',
  family: 'accounts',
  name: 'Fake Checking',
  summary: 'A checking account for tests.',
  lowest_monthly_fee_cents: 0,
  plan_count: 2,
  description: 'A checking account that exists only in tests.',
  who_it_is_for: 'Tests.',
  why_different: 'It is fake.',
  eligibility: ['A test runner'],
  needs_sign_in: ['your balance'],
  plans: [
    {
      plan_id: 'fake_checking_free',
      name: 'Free',
      monthly_fee_cents: 0,
      headline: 'No monthly fee',
      highlights: ['Free'],
      best_for: 'Everyone',
    },
    {
      plan_id: 'fake_checking_plus',
      name: 'Plus',
      monthly_fee_cents: 1000,
      headline: '$10 a month',
      highlights: ['Free wires'],
      best_for: 'Wire senders',
    },
  ],
};

export const FAKE_PUBLIC_PRICES: readonly PriceLine[] = [
  {
    price_id: 'fake_checking_free_wire',
    product_id: 'fake_checking',
    product_name: 'Fake Checking',
    plan_id: 'fake_checking_free',
    plan_name: 'Free',
    kind: 'transaction_fee',
    name: 'Outgoing wire',
    amount_cents: 2500,
    rate_bps: null,
    display: '$25.00 per wire',
    applies: 'per wire',
    waiver: null,
  },
  {
    price_id: 'fake_checking_plus_monthly',
    product_id: 'fake_checking',
    product_name: 'Fake Checking',
    plan_id: 'fake_checking_plus',
    plan_name: 'Plus',
    kind: 'monthly_fee',
    name: 'Monthly maintenance',
    amount_cents: 1000,
    rate_bps: null,
    display: '$10.00 every month',
    applies: 'every month',
    waiver: 'Keep $1,000',
  },
  {
    price_id: 'fake_checking_plus_rate',
    product_id: 'fake_checking',
    product_name: 'Fake Checking',
    plan_id: 'fake_checking_plus',
    plan_name: 'Plus',
    kind: 'rate',
    name: 'Interest',
    amount_cents: null,
    rate_bps: 100,
    display: '1.00% on the balance',
    applies: 'on the balance',
    waiver: null,
  },
];

export const FAKE_PUBLIC_BRANCH: BranchDetail = {
  branch_id: 'spr_main',
  name: 'Main Street',
  city: 'Springfield',
  state: 'IL',
  kind: 'branch',
  services: ['tellers', 'atm_24h'],
  address: '1 Main Street, Springfield, IL 62701',
  time_zone: 'America/Chicago',
  open_24_hours: false,
  hours: [
    { day: 'monday', opens: '09:00', closes: '17:00' },
    { day: 'tuesday', opens: '09:00', closes: '17:00' },
    { day: 'wednesday', opens: '09:00', closes: '17:00' },
    { day: 'thursday', opens: '09:00', closes: '17:00' },
    { day: 'friday', opens: '09:00', closes: '17:00' },
    { day: 'saturday', opens: null, closes: null },
    { day: 'sunday', opens: null, closes: null },
  ],
  atm_count: 1,
  accessibility: 'Step-free.',
  languages: ['English'],
  notes: 'A test branch.',
};

/** `PublicBankInfo` over the three fixtures above; records every call it answers. */
export interface FakePublicBankInfo extends PublicBankInfo {
  readonly calls: string[];
}

export function createFakePublicBankInfo(): FakePublicBankInfo {
  const calls: string[] = [];
  const summary = {
    product_id: FAKE_PUBLIC_PRODUCT.product_id,
    family: FAKE_PUBLIC_PRODUCT.family,
    name: FAKE_PUBLIC_PRODUCT.name,
    summary: FAKE_PUBLIC_PRODUCT.summary,
    lowest_monthly_fee_cents: FAKE_PUBLIC_PRODUCT.lowest_monthly_fee_cents,
    plan_count: FAKE_PUBLIC_PRODUCT.plan_count,
  };
  const branchSummary = {
    branch_id: FAKE_PUBLIC_BRANCH.branch_id,
    name: FAKE_PUBLIC_BRANCH.name,
    city: FAKE_PUBLIC_BRANCH.city,
    state: FAKE_PUBLIC_BRANCH.state,
    kind: FAKE_PUBLIC_BRANCH.kind,
    services: FAKE_PUBLIC_BRANCH.services,
  };
  return {
    calls,
    async profile() {
      calls.push('profile');
      return {
        name: 'Glass Bank',
        tagline: 'A fake tagline.',
        purpose: 'Tests.',
        differentiators: [{ title: 'Fake', detail: 'It is fake.' }],
        headquarters: 'Springfield, Illinois',
        fictional: true,
        public_information: ['products'],
        needs_sign_in: ['accounts and balances'],
      };
    },
    async listProducts(family) {
      calls.push(`listProducts:${family ?? ''}`);
      if (family !== undefined && family !== 'accounts') {
        return [{ family, name: family, summary: 'Nothing yet.', products: [] }];
      }
      return [{ family: 'accounts', name: 'Everyday accounts', summary: 'Checking.', products: [summary] }];
    },
    async getProduct(productId) {
      calls.push(`getProduct:${productId}`);
      return productId === FAKE_PUBLIC_PRODUCT.product_id ? FAKE_PUBLIC_PRODUCT : null;
    },
    async searchPrices(query) {
      calls.push('searchPrices');
      const words = (query.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      return FAKE_PUBLIC_PRICES.filter(
        (line) =>
          (query.product_id === undefined || line.product_id === query.product_id) &&
          (query.plan_id === undefined || line.plan_id === query.plan_id) &&
          (query.kind === undefined || line.kind === query.kind) &&
          (query.max_amount_cents === undefined ||
            (line.amount_cents !== null && line.amount_cents <= query.max_amount_cents)) &&
          words.every((word) => line.name.toLowerCase().includes(word)),
      );
    },
    async findBranches(query) {
      calls.push('findBranches');
      const city = (query.city ?? '').trim().toLowerCase();
      const matches =
        (city === '' || city === 'springfield') &&
        (query.service === undefined || FAKE_PUBLIC_BRANCH.services.includes(query.service));
      return { cities: ['Springfield'], branches: matches ? [branchSummary] : [] };
    },
    async getBranch(branchId) {
      calls.push(`getBranch:${branchId}`);
      return branchId === FAKE_PUBLIC_BRANCH.branch_id ? FAKE_PUBLIC_BRANCH : null;
    },
  };
}

export interface FakePublicToolContext extends PublicToolContext {
  readonly info: FakePublicBankInfo;
  readonly xray: FakeXrayEmitter;
}

/** A `PublicToolContext` for a visitor's pseudo grant, over the fake catalog and a fake emitter. */
export function createFakePublicToolContext(
  overrides: Partial<Omit<PublicToolContext, 'info' | 'xray'>> = {},
): FakePublicToolContext {
  return {
    info: createFakePublicBankInfo(),
    xray: createFakeXrayEmitter(),
    now: () => FAKE_NOW,
    requestId: '7',
    publicBaseUrl: 'https://glassbank.example',
    grantId: 'grt_pub_0123456789ab',
    xs: 'xs_pub_1',
    ...overrides,
  };
}
