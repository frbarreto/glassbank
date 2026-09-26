/**
 * The deterministic seed generator (block: bank-core): `persona seed -> dataset`.
 *
 * `generateDataset` is a pure function. Given the same `Persona` and the same `asOf` day it
 * returns a byte-identical `BankDataset` on every machine and every run, which is what lets
 * `dataset(personaId)` throw a dataset away under memory pressure and rebuild it later (ADR-15,
 * A-15). Nothing in here reads the clock, `Math.random`, the environment or the filesystem.
 *
 * Shape (A-23): about 2,000 transactions spread over the last 12 months, so a whole-year load is
 * a real multi-page load and a cross-account query still has something to filter. On top of the
 * random long tail sit twelve months of recurring charges and deposits, because "what do I pay
 * every month" and "how did my spending change" are the questions a demo actually gets asked.
 *
 * Money is an integer number of USD cents (Decision D-1); negative is money out. Dates are UTC.
 * Account and payee numbers exist here only as the last four digits and as masked strings: the
 * full number is never generated at all, so it cannot leak (invariant 11).
 */
import {
  ID_PREFIXES,
  type Account,
  type AccountType,
  type Bill,
  type BillStatus,
  type BankDataset,
  type Card,
  type CardStatus,
  type Payee,
  type Persona,
  type Transaction,
  type TransactionStatus,
  type Transfer,
  type TransferRail,
  type TransferStatus,
} from '../contracts/index.js';

import { BASE_CURRENCY } from './categories.js';
import {
  addDays,
  isoTimestampBefore,
  pad,
  startOfUtcDay,
  toIsoDate,
  toIsoMonth,
  utcDayInMonthBefore,
} from './dates.js';
import {
  DECLINE_REASONS,
  EMPLOYEE_NAMES,
  INCOME_SOURCES,
  MERCHANTS,
  PAYEE_BANK_NAMES,
  PAYEE_PROFILES,
  RECURRING_CHARGES,
  TRANSFER_FAILURE_REASONS,
  TRANSFER_MEMOS,
} from './names.js';
import { chance, integerBetween, makeRandom, moneyCents, pick, weightedPick } from './random.js';

/** Twelve months of history (A-23). */
export const HISTORY_DAYS = 365;

/** The transaction count is drawn from this band, so "about 2,000" is literally true (A-23). */
export const MIN_TRANSACTIONS = 1_900;
export const MAX_TRANSACTIONS = 2_100;

export interface GenerateDatasetOptions {
  /** The day the dataset is anchored to; truncated to midnight UTC. */
  readonly asOf: Date;
  /** Days of history to spread transactions over. Defaults to `HISTORY_DAYS`. */
  readonly historyDays?: number;
}

/** Array access that fails loudly instead of returning `undefined` (`noUncheckedIndexedAccess`). */
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`seed generator: index ${index} out of range`);
  return value;
}

/** The id-safe token every entity id of a persona is built from. */
export function tokenFor(persona: Persona): string {
  const raw = persona.id.startsWith(ID_PREFIXES.persona)
    ? persona.id.slice(ID_PREFIXES.persona.length)
    : persona.id;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return cleaned.length > 0 ? cleaned : 'persona';
}

function entityId(prefix: string, token: string, index: number, width = 3): string {
  return `${prefix}${token}_${pad(index, width)}`;
}

/** A four-digit string; the only part of an account or card number this bank ever holds. */
function digits4(random: () => number): string {
  return pad(integerBetween(random, 0, 9999), 4);
}

interface AccountPlan {
  readonly key: string;
  readonly name: string;
  readonly account_type: AccountType;
  readonly status: 'open' | 'closed';
  readonly min_cents: number;
  readonly max_cents: number;
  readonly credit_limit_cents: number | null;
}

const RETAIL_ACCOUNT_PLANS: readonly AccountPlan[] = [
  { key: 'checking', name: 'Everyday Checking', account_type: 'checking', status: 'open', min_cents: 180_000, max_cents: 1_400_000, credit_limit_cents: null },
  { key: 'savings', name: 'Reserve Savings', account_type: 'savings', status: 'open', min_cents: 400_000, max_cents: 6_500_000, credit_limit_cents: null },
  { key: 'credit', name: 'Everyday Rewards Card', account_type: 'credit_card', status: 'open', min_cents: 15_000, max_cents: 380_000, credit_limit_cents: 1_000_000 },
  { key: 'legacy', name: 'Legacy Checking (closed)', account_type: 'checking', status: 'closed', min_cents: 0, max_cents: 0, credit_limit_cents: null },
];

const BUSINESS_ACCOUNT_PLANS: readonly AccountPlan[] = [
  { key: 'checking', name: 'Operating Checking', account_type: 'checking', status: 'open', min_cents: 2_400_000, max_cents: 12_000_000, credit_limit_cents: null },
  { key: 'payroll', name: 'Payroll Checking', account_type: 'checking', status: 'open', min_cents: 600_000, max_cents: 3_200_000, credit_limit_cents: null },
  { key: 'savings', name: 'Reserve Savings', account_type: 'savings', status: 'open', min_cents: 4_000_000, max_cents: 40_000_000, credit_limit_cents: null },
  { key: 'credit', name: 'Corporate Card Account', account_type: 'credit_card', status: 'open', min_cents: 80_000, max_cents: 1_900_000, credit_limit_cents: 5_000_000 },
  { key: 'legacy', name: 'Legacy Checking (closed)', account_type: 'checking', status: 'closed', min_cents: 0, max_cents: 0, credit_limit_cents: null },
];

interface CardPlan {
  readonly account_key: string;
  readonly brand: string;
  readonly status: CardStatus;
}

/** Every persona gets all three card states, so the lock rules are always demonstrable. */
const RETAIL_CARD_PLANS: readonly CardPlan[] = [
  { account_key: 'checking', brand: 'Meridian Debit', status: 'active' },
  { account_key: 'credit', brand: 'Meridian Credit', status: 'active' },
  { account_key: 'credit', brand: 'Meridian Credit', status: 'locked' },
  { account_key: 'checking', brand: 'Meridian Debit', status: 'fraud_locked' },
  { account_key: 'legacy', brand: 'Meridian Debit', status: 'active' },
];

const BUSINESS_CARD_PLANS: readonly CardPlan[] = [
  { account_key: 'credit', brand: 'Meridian Credit', status: 'active' },
  { account_key: 'credit', brand: 'Meridian Credit', status: 'active' },
  { account_key: 'credit', brand: 'Meridian Credit', status: 'active' },
  { account_key: 'checking', brand: 'Meridian Debit', status: 'active' },
  { account_key: 'credit', brand: 'Meridian Credit', status: 'locked' },
  { account_key: 'payroll', brand: 'Meridian Debit', status: 'fraud_locked' },
  { account_key: 'legacy', brand: 'Meridian Debit', status: 'active' },
];

/** An account before its available balance is known (pending holds are computed last). */
interface AccountDraft extends Omit<Account, 'available_balance_cents'> {
  readonly key: string;
}

function buildAccounts(persona: Persona, token: string, asOf: Date): readonly AccountDraft[] {
  const random = makeRandom(`${persona.seed}:accounts`);
  const plans = persona.kind === 'business' ? BUSINESS_ACCOUNT_PLANS : RETAIL_ACCOUNT_PLANS;
  const routingLast4 = digits4(random);
  return plans.map((plan, index) => {
    const magnitude =
      plan.status === 'closed' ? 0 : integerBetween(random, plan.min_cents, plan.max_cents);
    const balance = plan.account_type === 'credit_card' ? -magnitude : magnitude;
    return {
      key: plan.key,
      id: entityId(ID_PREFIXES.account, token, index + 1),
      persona_id: persona.id,
      name: plan.name,
      account_type: plan.account_type,
      currency: BASE_CURRENCY,
      balance_cents: balance,
      credit_limit_cents: plan.credit_limit_cents,
      account_number_last4: digits4(random),
      routing_number_last4: plan.account_type === 'credit_card' ? null : routingLast4,
      status: plan.status,
      opened_at: isoTimestampBefore(asOf, 900 - index * 60, 9, 30),
    };
  });
}

function buildCards(
  persona: Persona,
  token: string,
  asOf: Date,
  accounts: readonly AccountDraft[],
): readonly Card[] {
  const random = makeRandom(`${persona.seed}:cards`);
  const plans = persona.kind === 'business' ? BUSINESS_CARD_PLANS : RETAIL_CARD_PLANS;
  const byKey = new Map(accounts.map((account) => [account.key, account]));
  return plans.map((plan, index) => {
    const account = byKey.get(plan.account_key) ?? at(accounts, 0);
    const cardholder =
      persona.kind === 'business'
        ? at(EMPLOYEE_NAMES, index % EMPLOYEE_NAMES.length)
        : persona.name;
    const expiry = addDays(asOf, 365 * (2 + (index % 3)) + 30 * (index % 12));
    return {
      id: entityId(ID_PREFIXES.card, token, index + 1),
      account_id: account.id,
      persona_id: persona.id,
      cardholder_name: cardholder,
      brand: plan.brand,
      last4: digits4(random),
      status: plan.status,
      spending_limit_cents:
        persona.kind === 'business'
          ? integerBetween(random, 250_000, 2_500_000)
          : integerBetween(random, 50_000, 800_000),
      expires_on: toIsoMonth(expiry),
      issued_at: isoTimestampBefore(asOf, 700 - index * 40, 11, 0),
    };
  });
}

function buildPayees(persona: Persona, token: string, asOf: Date): readonly Payee[] {
  const random = makeRandom(`${persona.seed}:payees`);
  const count = persona.kind === 'business' ? 14 : 8;
  return Array.from({ length: count }, (_unused, index) => {
    const profile = at(PAYEE_PROFILES, index % PAYEE_PROFILES.length);
    // Two archived payees per persona: `load_payees(is_active=false)` has to return something,
    // and `previewTransfer` needs a reachable `payee_inactive` rejection.
    const isActive = index !== 5 && index !== 11;
    return {
      id: entityId(ID_PREFIXES.payee, token, index + 1),
      persona_id: persona.id,
      name: profile.name,
      bank_name: at(PAYEE_BANK_NAMES, index % PAYEE_BANK_NAMES.length),
      account_number_masked: `****${digits4(random)}`,
      routing_number_masked: `****${digits4(random)}`,
      rail: profile.rail,
      is_active: isActive,
      created_at: isoTimestampBefore(asOf, 520 - index * 11, 14, 15),
    };
  });
}

/** One transaction before it is sorted and given its id. */
interface TransactionDraft {
  readonly date: string;
  readonly order: number;
  readonly account_id: string;
  readonly card_id: string | null;
  readonly merchant_name: string;
  readonly category_id: string;
  readonly amount_cents: number;
  readonly status: TransactionStatus;
  readonly decline_reason: string | null;
  readonly description: string;
  readonly posted_hour: number;
  readonly posted_minute: number;
  readonly days_before: number;
}

function statusFor(random: () => number, daysBefore: number): TransactionStatus {
  if (daysBefore <= 3 && chance(random, 0.45)) return 'pending';
  if (chance(random, 0.015)) return 'declined';
  return 'posted';
}

function buildTransactions(
  persona: Persona,
  token: string,
  asOf: Date,
  historyDays: number,
  accounts: readonly AccountDraft[],
  cards: readonly Card[],
): readonly Transaction[] {
  const random = makeRandom(`${persona.seed}:transactions`);
  const audience = persona.kind === 'business' ? 'business' : 'retail';
  const primary = accounts.find((account) => account.key === 'checking') ?? at(accounts, 0);
  const openCards = cards.filter((card) => {
    const account = accounts.find((candidate) => candidate.id === card.account_id);
    return account !== undefined && account.status === 'open';
  });
  const spendableCards = openCards.filter((card) => card.status === 'active');
  const lockedCards = openCards.filter((card) => card.status !== 'active');
  const eligibleMerchants = MERCHANTS.filter(
    (merchant) => merchant.audience === 'both' || merchant.audience === audience,
  );
  const drafts: TransactionDraft[] = [];
  let order = 0;

  /** A card posting lands on the card's account; everything else on the primary checking account. */
  const accountFor = (cardId: string | null): string => {
    if (cardId === null) return primary.id;
    return openCards.find((candidate) => candidate.id === cardId)?.account_id ?? primary.id;
  };

  const daysBeforeOf = (date: Date): number =>
    Math.round((startOfUtcDay(asOf).getTime() - startOfUtcDay(date).getTime()) / 86_400_000);

  // 1. Twelve months of recurring charges: the backbone of any "every month" question.
  for (const charge of RECURRING_CHARGES) {
    if (charge.audience !== 'both' && charge.audience !== audience) continue;
    for (let monthsBefore = 0; monthsBefore < 12; monthsBefore += 1) {
      const day = utcDayInMonthBefore(asOf, monthsBefore, charge.day_of_month);
      const daysBefore = daysBeforeOf(day);
      if (daysBefore < 0 || daysBefore >= historyDays) continue;
      const cardId =
        charge.channel === 'card' && spendableCards.length > 0
          ? at(spendableCards, integerBetween(random, 0, spendableCards.length - 1)).id
          : null;
      order += 1;
      drafts.push({
        date: toIsoDate(day),
        order,
        account_id: accountFor(cardId),
        card_id: cardId,
        merchant_name: charge.name,
        category_id: charge.category_id,
        amount_cents: -moneyCents(random, charge.min_cents, charge.max_cents),
        status: daysBefore <= 1 ? 'pending' : 'posted',
        decline_reason: null,
        description: charge.description,
        posted_hour: integerBetween(random, 6, 10),
        posted_minute: integerBetween(random, 0, 59),
        days_before: daysBefore,
      });
    }
  }

  // 2. Money in, so a balance and a cash-flow question both make sense.
  for (const income of INCOME_SOURCES) {
    if (income.audience !== audience) continue;
    for (let monthsBefore = 0; monthsBefore < 12; monthsBefore += 1) {
      for (const dayOfMonth of income.days_of_month) {
        const day = utcDayInMonthBefore(asOf, monthsBefore, dayOfMonth);
        const daysBefore = daysBeforeOf(day);
        if (daysBefore < 0 || daysBefore >= historyDays) continue;
        order += 1;
        drafts.push({
          date: toIsoDate(day),
          order,
          account_id: primary.id,
          card_id: null,
          merchant_name: income.name,
          // Ramp's table has no "income" id; deposits are booked to "Other" (2).
          category_id: '2',
          amount_cents: moneyCents(random, income.min_cents, income.max_cents),
          status: daysBefore <= 1 ? 'pending' : 'posted',
          decline_reason: null,
          description: income.description,
          posted_hour: integerBetween(random, 5, 8),
          posted_minute: integerBetween(random, 0, 59),
          days_before: daysBefore,
        });
      }
    }
  }

  // 3. The everyday long tail, filling the dataset up to ~2,000 rows.
  const target = integerBetween(random, MIN_TRANSACTIONS, MAX_TRANSACTIONS);
  while (drafts.length < target) {
    const merchant = weightedPick(random, eligibleMerchants);
    const daysBefore = integerBetween(random, 0, historyDays - 1);
    const status = statusFor(random, daysBefore);
    let cardId: string | null = null;
    if (merchant.channel === 'card') {
      const pool =
        status === 'declined' && lockedCards.length > 0 && chance(random, 0.4)
          ? lockedCards
          : spendableCards;
      cardId = pool.length > 0 ? at(pool, integerBetween(random, 0, pool.length - 1)).id : null;
    }
    order += 1;
    drafts.push({
      date: toIsoDate(addDays(asOf, -daysBefore)),
      order,
      account_id: accountFor(cardId),
      card_id: cardId,
      merchant_name: merchant.name,
      category_id: merchant.category_id,
      amount_cents: -moneyCents(random, merchant.min_cents, merchant.max_cents),
      status,
      decline_reason:
        status === 'declined'
          ? at(DECLINE_REASONS, integerBetween(random, 0, DECLINE_REASONS.length - 1))
          : null,
      description:
        merchant.channel === 'card'
          ? `Card purchase - ${merchant.name}`
          : `ACH debit - ${merchant.name}`,
      posted_hour: integerBetween(random, 7, 22),
      posted_minute: integerBetween(random, 0, 59),
      days_before: daysBefore,
    });
  }

  drafts.sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? -1 : 1;
    return left.order - right.order;
  });

  return drafts.map((draft, index) => ({
    id: entityId(ID_PREFIXES.transaction, token, index + 1, 4),
    account_id: draft.account_id,
    card_id: draft.card_id,
    persona_id: persona.id,
    date: draft.date,
    posted_at:
      draft.status === 'posted'
        ? isoTimestampBefore(asOf, draft.days_before, draft.posted_hour, draft.posted_minute)
        : null,
    merchant_name: draft.merchant_name,
    category_id: draft.category_id,
    amount_cents: draft.amount_cents,
    currency: BASE_CURRENCY,
    status: draft.status,
    decline_reason: draft.decline_reason,
    description: draft.description,
  }));
}

interface TransferDraft {
  readonly scheduled_for: string;
  readonly order: number;
  readonly from_account_id: string;
  readonly to_account_id: string | null;
  readonly payee_id: string | null;
  readonly direction: 'outgoing' | 'incoming';
  readonly rail: TransferRail;
  readonly amount_cents: number;
  readonly fee_cents: number;
  readonly status: TransferStatus;
  readonly memo: string | null;
  readonly failure_reason: string | null;
  readonly days_before: number;
}

function buildTransfers(
  persona: Persona,
  token: string,
  asOf: Date,
  historyDays: number,
  accounts: readonly AccountDraft[],
  payees: readonly Payee[],
): readonly Transfer[] {
  const random = makeRandom(`${persona.seed}:transfers`);
  const count = persona.kind === 'business' ? 120 : 60;
  const openAccounts = accounts.filter((account) => account.status === 'open');
  const primary = openAccounts.find((account) => account.key === 'checking') ?? at(accounts, 0);
  const savings = openAccounts.find((account) => account.account_type === 'savings') ?? primary;
  const activePayees = payees.filter((payee) => payee.is_active);
  const drafts: TransferDraft[] = [];

  for (let index = 0; index < count; index += 1) {
    // The last handful are dated around today, some of them in the future, so that
    // `load_transfers(status="scheduled")` is never empty on a freshly generated persona.
    const daysBefore =
      index >= count - 6 ? integerBetween(random, -14, 2) : integerBetween(random, 0, historyDays - 1);
    const roll = random();
    const status: TransferStatus =
      daysBefore <= 2 ? 'scheduled' : chance(random, 0.05) ? 'failed' : 'completed';
    let draft: Omit<TransferDraft, 'scheduled_for' | 'order' | 'status' | 'failure_reason' | 'days_before'>;

    if (roll < 0.3) {
      const toSavings = chance(random, 0.6);
      draft = {
        from_account_id: toSavings ? primary.id : savings.id,
        to_account_id: toSavings ? savings.id : primary.id,
        payee_id: null,
        direction: 'outgoing',
        rail: 'internal',
        amount_cents: moneyCents(random, 25_000, 900_000),
        fee_cents: 0,
        memo: toSavings ? 'Move to savings' : 'Move to checking',
      };
    } else if (roll < 0.85) {
      const payee = pick(random, activePayees);
      draft = {
        from_account_id: primary.id,
        to_account_id: null,
        payee_id: payee.id,
        direction: 'outgoing',
        rail: payee.rail,
        amount_cents: moneyCents(random, 12_000, persona.kind === 'business' ? 1_800_000 : 320_000),
        fee_cents: payee.rail === 'wire' ? 2_500 : 0,
        memo: pick(random, TRANSFER_MEMOS),
      };
    } else {
      const payee = pick(random, activePayees);
      draft = {
        from_account_id: primary.id,
        to_account_id: null,
        payee_id: payee.id,
        direction: 'incoming',
        rail: payee.rail,
        amount_cents: moneyCents(random, 30_000, persona.kind === 'business' ? 2_400_000 : 240_000),
        fee_cents: 0,
        memo: 'Incoming payment',
      };
    }

    drafts.push({
      ...draft,
      scheduled_for: toIsoDate(addDays(asOf, -daysBefore)),
      order: index,
      status,
      failure_reason:
        status === 'failed'
          ? at(
              TRANSFER_FAILURE_REASONS,
              integerBetween(random, 0, TRANSFER_FAILURE_REASONS.length - 1),
            )
          : null,
      days_before: daysBefore,
    });
  }

  drafts.sort((left, right) => {
    if (left.scheduled_for !== right.scheduled_for) {
      return left.scheduled_for < right.scheduled_for ? -1 : 1;
    }
    return left.order - right.order;
  });

  return drafts.map((draft, index) => ({
    id: entityId(ID_PREFIXES.transfer, token, index + 1),
    persona_id: persona.id,
    from_account_id: draft.from_account_id,
    to_account_id: draft.to_account_id,
    payee_id: draft.payee_id,
    direction: draft.direction,
    rail: draft.rail,
    amount_cents: draft.amount_cents,
    fee_cents: draft.fee_cents,
    total_cents: draft.amount_cents + draft.fee_cents,
    currency: BASE_CURRENCY,
    status: draft.status,
    memo: draft.memo,
    scheduled_for: draft.scheduled_for,
    created_at: isoTimestampBefore(
      asOf,
      Math.max(0, Math.min(historyDays, draft.days_before + 1)),
      16,
      5,
    ),
    completed_at:
      draft.status === 'completed' ? isoTimestampBefore(asOf, draft.days_before, 18, 40) : null,
    failure_reason: draft.failure_reason,
    // Seeded transfers were not made through this API, so no audit entry points at them.
    audit_id: null,
  }));
}

function buildBills(
  persona: Persona,
  token: string,
  asOf: Date,
  accounts: readonly AccountDraft[],
  payees: readonly Payee[],
): readonly Bill[] {
  const random = makeRandom(`${persona.seed}:bills`);
  const primary = accounts.find((account) => account.key === 'checking') ?? at(accounts, 0);
  const billingPayees = payees.filter((payee) => payee.is_active).slice(0, persona.kind === 'business' ? 5 : 3);
  const today = toIsoDate(asOf);
  const drafts: Array<{
    due: Date;
    payee_id: string;
    amount_cents: number;
    order: number;
  }> = [];
  let order = 0;

  for (const payee of billingPayees) {
    for (let monthsBefore = 11; monthsBefore >= -1; monthsBefore -= 1) {
      const due = utcDayInMonthBefore(asOf, monthsBefore, 10 + (order % 15));
      order += 1;
      drafts.push({
        due,
        payee_id: payee.id,
        amount_cents: moneyCents(random, 4_500, persona.kind === 'business' ? 620_000 : 180_000),
        order,
      });
    }
  }

  drafts.sort((left, right) => {
    const leftDate = toIsoDate(left.due);
    const rightDate = toIsoDate(right.due);
    if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1;
    return left.order - right.order;
  });

  return drafts.map((draft, index) => {
    const dueDate = toIsoDate(draft.due);
    const isFuture = dueDate > today;
    const paid = !isFuture && chance(random, 0.82);
    const status: BillStatus = isFuture ? 'open' : paid ? 'paid' : 'overdue';
    return {
      id: entityId(ID_PREFIXES.bill, token, index + 1),
      persona_id: persona.id,
      payee_id: draft.payee_id,
      account_id: primary.id,
      amount_cents: draft.amount_cents,
      currency: BASE_CURRENCY,
      due_date: dueDate,
      issued_date: toIsoDate(addDays(draft.due, -21)),
      status,
      paid_at: paid ? `${toIsoDate(addDays(draft.due, -2))}T13:20:00.000Z` : null,
      reference: `INV-${pad(integerBetween(random, 1, 999_999), 6)}`,
    };
  });
}

/**
 * `persona seed -> dataset`. Pure and total: the same `(persona, asOf day)` pair always produces
 * the same bytes, which is the property `dataset()` regeneration and the snapshot test rest on.
 */
export function generateDataset(persona: Persona, options: GenerateDatasetOptions): BankDataset {
  const asOf = startOfUtcDay(options.asOf);
  const historyDays = Math.max(31, Math.floor(options.historyDays ?? HISTORY_DAYS));
  const token = tokenFor(persona);

  const drafts = buildAccounts(persona, token, asOf);
  const cards = buildCards(persona, token, asOf, drafts);
  const transactions = buildTransactions(persona, token, asOf, historyDays, drafts, cards);
  const payees = buildPayees(persona, token, asOf);
  const transfers = buildTransfers(persona, token, asOf, historyDays, drafts, payees);
  const bills = buildBills(persona, token, asOf, drafts, payees);

  // Pending card authorisations are held against the account, which is what makes
  // `available_balance_cents` differ from `balance_cents` and what `previewTransfer` checks.
  const holds = new Map<string, number>();
  for (const transaction of transactions) {
    if (transaction.status !== 'pending' || transaction.amount_cents >= 0) continue;
    holds.set(
      transaction.account_id,
      (holds.get(transaction.account_id) ?? 0) + Math.abs(transaction.amount_cents),
    );
  }

  const accounts: Account[] = drafts.map((draft) => {
    const hold = holds.get(draft.id) ?? 0;
    const available =
      draft.account_type === 'credit_card'
        ? (draft.credit_limit_cents ?? 0) + draft.balance_cents - hold
        : draft.balance_cents - hold;
    return {
      id: draft.id,
      persona_id: draft.persona_id,
      name: draft.name,
      account_type: draft.account_type,
      currency: draft.currency,
      balance_cents: draft.balance_cents,
      available_balance_cents: draft.status === 'closed' ? 0 : Math.max(0, available),
      credit_limit_cents: draft.credit_limit_cents,
      account_number_last4: draft.account_number_last4,
      routing_number_last4: draft.routing_number_last4,
      status: draft.status,
      opened_at: draft.opened_at,
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
    generated_at: asOf.toISOString(),
  };
}
