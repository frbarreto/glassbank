/**
 * List operations: Ramp's `{data, page: {next}}` envelope, the filters the load tools pass, and
 * the orderings a paged walk depends on.
 *
 * The load tools page through these in a loop, so the two properties that actually matter are
 * "every row is seen exactly once" and "the cursor always advances". Both are asserted against the
 * full ~2,000-row year, not a toy fixture.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_SIZE } from '../../contracts/index.js';
import { BANK_CATEGORIES, BANK_CURRENCIES } from '../categories.js';
import { decodeCursor, encodeCursor } from '../queries.js';
import { AVA, HARBOR, LOGIN_A, createHarness, drain, scopeOf } from './harness.js';

const YEAR = { from_date: '2025-09-01', to_date: '2026-09-08' } as const;
const ava = scopeOf(AVA, LOGIN_A, 'grt_test01');

describe('pagination (Ramp envelope)', () => {
  it('walks the whole year without losing or repeating a transaction', async () => {
    const { bank } = createHarness();
    const dataset = await bank.dataset(AVA);
    const { rows, pages } = await drain((cursor) =>
      bank.listTransactions(ava, { ...YEAR, limit: 500, cursor }),
    );
    expect(pages).toBeGreaterThan(1);
    expect(rows).toHaveLength(dataset.transactions.length);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it('returns `page.next: null` on the last page and an opaque cursor before it', async () => {
    const { bank } = createHarness();
    const first = await bank.listTransactions(ava, { ...YEAR, limit: 100 });
    expect(first.data).toHaveLength(100);
    expect(first.page.next).not.toBeNull();
    // Opaque: not a bare offset the model could reason about.
    expect(first.page.next).not.toMatch(/^\d+$/);
    expect(decodeCursor(first.page.next)).toBe(100);

    const total = (await bank.dataset(AVA)).transactions.length;
    const last = await bank.listTransactions(ava, {
      ...YEAR,
      limit: 100,
      cursor: encodeCursor(total - 5),
    });
    expect(last.data).toHaveLength(5);
    expect(last.page.next).toBeNull();
  });

  it('defaults to DEFAULT_PAGE_SIZE and clamps an oversized limit', async () => {
    const { bank } = createHarness();
    const byDefault = await bank.listTransactions(ava, YEAR);
    expect(byDefault.data).toHaveLength(DEFAULT_PAGE_SIZE);
    const clamped = await bank.listTransactions(ava, { ...YEAR, limit: 999_999 });
    expect(clamped.data.length).toBeLessThanOrEqual(1000);
  });

  it('treats an unreadable cursor as the first page rather than an error', async () => {
    const { bank } = createHarness();
    const page = await bank.listTransactions(ava, { ...YEAR, limit: 10, cursor: 'not-a-cursor' });
    const first = await bank.listTransactions(ava, { ...YEAR, limit: 10 });
    expect(page.data).toEqual(first.data);
    expect(decodeCursor('')).toBe(0);
    expect(decodeCursor(null)).toBe(0);
    // A bare decimal offset still works, so a caller written against the fake keeps paging.
    expect(decodeCursor('40')).toBe(40);
    expect(decodeCursor(encodeCursor(40))).toBe(40);
  });
});

describe('transaction filters and ordering', () => {
  it("sorts by amount descending, like Ramp's order_by_amount_desc", async () => {
    const { bank } = createHarness();
    const page = await bank.listTransactions(ava, { ...YEAR, limit: 400 });
    const magnitudes = page.data.map((row) => Math.abs(row.amount_cents));
    const sorted = [...magnitudes].sort((left, right) => right - left);
    expect(magnitudes).toEqual(sorted);
  });

  it('filters by inclusive date range', async () => {
    const { bank } = createHarness();
    const { rows } = await drain((cursor) =>
      bank.listTransactions(ava, {
        from_date: '2026-08-01',
        to_date: '2026-08-31',
        limit: 500,
        cursor,
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.date >= '2026-08-01').toBe(true);
      expect(row.date <= '2026-08-31').toBe(true);
    }
    const single = await bank.listTransactions(ava, {
      from_date: '2026-08-15',
      to_date: '2026-08-15',
      limit: 500,
    });
    for (const row of single.data) expect(row.date).toBe('2026-08-15');
  });

  it('filters by account, card, category and status', async () => {
    const { bank } = createHarness();
    const dataset = await bank.dataset(AVA);
    const account = dataset.accounts[0]!;
    const card = dataset.cards.find((candidate) => candidate.status === 'active')!;

    const byAccount = await bank.listTransactions(ava, {
      ...YEAR,
      account_id: account.id,
      limit: 1000,
    });
    expect(byAccount.data.length).toBeGreaterThan(0);
    for (const row of byAccount.data) expect(row.account_id).toBe(account.id);

    const byCard = await bank.listTransactions(ava, { ...YEAR, card_id: card.id, limit: 1000 });
    expect(byCard.data.length).toBeGreaterThan(0);
    for (const row of byCard.data) expect(row.card_id).toBe(card.id);

    const byCategory = await bank.listTransactions(ava, {
      ...YEAR,
      category_ids: ['17', '19'],
      limit: 1000,
    });
    expect(byCategory.data.length).toBeGreaterThan(0);
    for (const row of byCategory.data) expect(['17', '19']).toContain(row.category_id);

    const declined = await bank.listTransactions(ava, { ...YEAR, status: 'declined', limit: 1000 });
    expect(declined.data.length).toBeGreaterThan(0);
    for (const row of declined.data) expect(row.status).toBe('declined');
  });

  it('treats "" as no filter (Ramp convention)', async () => {
    const { bank } = createHarness();
    const unfiltered = await bank.listTransactions(ava, { ...YEAR, limit: 20 });
    const empties = await bank.listTransactions(ava, {
      ...YEAR,
      status: '',
      account_id: '',
      card_id: '',
      category_ids: [],
      limit: 20,
    });
    expect(empties.data).toEqual(unfiltered.data);
  });
});

describe('the other list operations', () => {
  it('filters accounts by id and type', async () => {
    const { bank } = createHarness();
    const all = await bank.listAccounts(ava);
    expect(all.data.length).toBeGreaterThanOrEqual(4);
    const savings = await bank.listAccounts(ava, { account_type: 'savings' });
    expect(savings.data.length).toBeGreaterThan(0);
    for (const row of savings.data) expect(row.account_type).toBe('savings');
    const one = await bank.listAccounts(ava, { account_id: all.data[0]!.id });
    expect(one.data).toHaveLength(1);
    const noFilter = await bank.listAccounts(ava, { account_type: '' });
    expect(noFilter.data).toHaveLength(all.data.length);
  });

  it('filters cards by status and account', async () => {
    const { bank } = createHarness();
    const all = await bank.listCards(ava);
    const fraud = await bank.listCards(ava, { status: 'fraud_locked' });
    expect(fraud.data.length).toBe(1);
    expect(fraud.data[0]!.status).toBe('fraud_locked');
    const byAccount = await bank.listCards(ava, { account_id: all.data[0]!.account_id });
    expect(byAccount.data.length).toBeGreaterThan(0);
    for (const row of byAccount.data) expect(row.account_id).toBe(all.data[0]!.account_id);
  });

  it('filters transfers by direction and status, newest first', async () => {
    const { bank } = createHarness();
    const { rows } = await drain((cursor) =>
      bank.listTransfers(ava, { from_date: '2025-01-01', to_date: '2026-12-31', limit: 100, cursor }),
    );
    expect(rows.length).toBeGreaterThan(10);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1]!.scheduled_for >= rows[index]!.scheduled_for).toBe(true);
    }
    const incoming = await bank.listTransfers(ava, {
      from_date: '2025-01-01',
      to_date: '2026-12-31',
      direction: 'incoming',
      limit: 200,
    });
    expect(incoming.data.length).toBeGreaterThan(0);
    for (const row of incoming.data) expect(row.direction).toBe('incoming');
    const failed = await bank.listTransfers(ava, {
      from_date: '2025-01-01',
      to_date: '2026-12-31',
      status: 'failed',
      limit: 200,
    });
    expect(failed.data.length).toBeGreaterThan(0);
    for (const row of failed.data) expect(row.failure_reason).not.toBeNull();
  });

  it('filters bills by payment status, oldest due date first', async () => {
    const { bank } = createHarness();
    const range = { from_date: '2025-01-01', to_date: '2026-12-31' } as const;
    const all = await bank.listBills(ava, { ...range, limit: 500 });
    for (let index = 1; index < all.data.length; index += 1) {
      expect(all.data[index - 1]!.due_date <= all.data[index]!.due_date).toBe(true);
    }
    for (const status of ['open', 'paid', 'overdue'] as const) {
      const page = await bank.listBills(ava, { ...range, payment_status: status, limit: 500 });
      expect(page.data.length).toBeGreaterThan(0);
      for (const row of page.data) expect(row.status).toBe(status);
    }
  });

  it('defaults payees to active only and matches names case-insensitively', async () => {
    const { bank } = createHarness();
    const active = await bank.listPayees(ava);
    expect(active.data.length).toBeGreaterThan(0);
    for (const row of active.data) expect(row.is_active).toBe(true);

    const archived = await bank.listPayees(ava, { is_active: false });
    expect(archived.data.length).toBeGreaterThan(0);
    for (const row of archived.data) expect(row.is_active).toBe(false);

    const byName = await bank.listPayees(ava, { name: 'crestwood' });
    expect(byName.data.length).toBeGreaterThan(0);
    for (const row of byName.data) expect(row.name.toLowerCase()).toContain('crestwood');
  });

  it('unions transactions, transfers and bills into statement lines, newest first', async () => {
    const { bank } = createHarness();
    const { rows } = await drain((cursor) =>
      bank.listStatementLines(ava, { ...YEAR, limit: 1000, cursor }),
    );
    expect(new Set(rows.map((row) => row.source))).toEqual(
      new Set(['transaction', 'transfer', 'bill']),
    );
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1]!.date >= rows[index]!.date).toBe(true);
    }
    const bill = rows.find((row) => row.source === 'bill')!;
    expect(bill.amount_cents).toBeLessThan(0);
    expect(bill.reference).toMatch(/^INV-\d{6}$/);
    const transfer = rows.find((row) => row.source === 'transfer')!;
    expect(transfer.counterparty.length).toBeGreaterThan(0);
  });

  it('serves the reference tables without a persona', async () => {
    const { bank } = createHarness();
    expect(await bank.listCategories()).toBe(BANK_CATEGORIES);
    expect(await bank.listCurrencies()).toBe(BANK_CURRENCIES);
  });

  it('reports balances with cash, credit and the net position', async () => {
    const { bank } = createHarness();
    const summary = await bank.getBalances(scopeOf(HARBOR, LOGIN_A));
    expect(summary.persona_id).toBe(HARBOR);
    expect(summary.currency).toBe('USD');
    expect(summary.accounts.length).toBeGreaterThanOrEqual(5);
    expect(summary.total_cash_cents).toBeGreaterThan(0);
    expect(summary.total_credit_owed_cents).toBeGreaterThan(0);
    expect(summary.net_position_cents).toBe(
      summary.total_cash_cents - summary.total_credit_owed_cents,
    );
    // The closed account contributes nothing.
    const closed = summary.accounts.find((account) => account.status === 'closed')!;
    expect(closed.balance_cents).toBe(0);
  });

  it('rejects an unknown persona rather than inventing one', async () => {
    const { bank } = createHarness();
    await expect(bank.listAccounts(scopeOf('per_x', LOGIN_A))).rejects.toThrow(/unknown persona/);
  });
});
