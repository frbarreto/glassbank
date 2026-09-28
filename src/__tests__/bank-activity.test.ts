/**
 * The account view's sums (block: app, contracts v0.10, D-31): `buildBankActivity` over the real
 * seeded bank. Money in and out leave out what moved no money out of the persona (internal
 * transfers, declined payments, unpaid bills); the window bounds the statement and the categories;
 * a write made through the overlay shows up at once, with its rationale.
 */
import { describe, expect, it } from 'vitest';

import { createBankCore } from '../bank-core/index.js';
import { buildBankActivity } from '../composition.js';
import type { XrayBankSummary } from '../contracts/index.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const scope = { persona_id: 'per_ava_stone', login_id: 'lgn_test01', grant_id: 'grt_test01' };

async function setup() {
  const bank = createBankCore({ emitter: { emit: () => undefined }, now: () => NOW });
  const persona = await bank.personas.get(scope.persona_id);
  if (!persona) throw new Error('no seeded persona');
  const balances = await bank.getBalances(scope);
  const summary: XrayBankSummary = {
    persona: { id: persona.id, name: persona.name, kind: persona.kind, shared: persona.shared },
    currency: balances.currency,
    as_of: balances.as_of,
    accounts: balances.accounts.map((account) => ({ ...account })),
    total_cash_cents: balances.total_cash_cents,
    total_available_cents: balances.total_available_cents,
    total_credit_owed_cents: balances.total_credit_owed_cents,
    net_position_cents: balances.net_position_cents,
    cards: { total: 0, active: 0, locked: 0, fraud_locked: 0 },
    transfer_limit_cents: persona.transfer_limit_cents,
  };
  return { bank, summary };
}

describe('buildBankActivity', () => {
  it('bounds the statement and the categories by the window, and keeps twelve months of flow', async () => {
    const { bank, summary } = await setup();
    const activity = await buildBankActivity(bank, scope, summary, 3, NOW);
    expect(activity.months).toBe(3);
    expect(activity.from_date).toBe('2026-07-01');
    expect(activity.to_date).toBe('2026-09-08');
    expect(activity.by_month.map((month) => month.month)).toEqual([
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    expect(
      activity.lines.every((line) => line.date >= '2026-07-01' && line.date <= '2026-09-08'),
    ).toBe(true);
    expect(activity.lines_total).toBeGreaterThanOrEqual(activity.lines.length);
    const spent = activity.by_category.reduce((sum, entry) => sum + entry.spent_cents, 0);
    expect(spent).toBeGreaterThan(0);
    expect(activity.by_category).toEqual(
      [...activity.by_category].sort((a, b) => b.spent_cents - a.spent_cents),
    );
    // An unknown window falls back to three months rather than reading everything.
    expect((await buildBankActivity(bank, scope, summary, 7, NOW)).months).toBe(3);
  });

  it('leaves transfers between the persona’s own accounts out of money in and out', async () => {
    const { bank, summary } = await setup();
    const accounts = await bank.listAccounts(scope, {});
    const checking = accounts.data.find(
      (account) => account.account_type === 'checking' && account.status === 'open',
    );
    const savings = accounts.data.find((account) => account.account_type === 'savings');
    if (!checking || !savings) throw new Error('the seed lacks a checking or a savings account');
    const before = await buildBankActivity(bank, scope, summary, 1, NOW);
    const preview = await bank.previewTransfer(scope, {
      from_account_id: checking.id,
      to: { account_id: savings.id },
      amount: 12_345,
      currency: 'USD',
      rationale: 'test: move money between own accounts',
    });
    if (!preview.ok) throw new Error(preview.message);
    await bank.confirmTransfer(scope, {
      preview_id: preview.preview.preview_id,
      expected_total_amount: preview.preview.expected_total_amount,
      rationale: 'test: confirmed',
    });
    const after = await buildBankActivity(bank, scope, summary, 1, NOW);
    expect(after.month_to_date).toEqual(before.month_to_date);
    expect(after.lines.length).toBe(before.lines.length + 1);
    expect(after.transfers[0]).toMatchObject({ amount_cents: 12_345, status: 'completed' });
    expect(after.audit[0]).toMatchObject({
      action: 'transfer.confirm',
      rationale: 'test: confirmed',
    });
  });

  it('shows a card lock made through the overlay, with the card spend of the month', async () => {
    const { bank, summary } = await setup();
    const cards = await bank.listCards(scope, { limit: 100 });
    const card = cards.data.find((candidate) => candidate.status === 'active');
    if (!card) throw new Error('no active card');
    await bank.lockCard(scope, card.id, 'test: the user lost the card');
    const activity = await buildBankActivity(bank, scope, summary, 3, NOW);
    expect(activity.card_list.find((entry) => entry.id === card.id)?.status).toBe('locked');
    expect(activity.audit[0]).toMatchObject({
      action: 'card.lock',
      rationale: 'test: the user lost the card',
    });
    expect(activity.card_list.every((entry) => entry.spent_this_month_cents >= 0)).toBe(true);
    // Every bill is named after its payee, future ones included.
    expect(activity.bills.every((bill) => !bill.payee_name.startsWith('pay_'))).toBe(true);
  });
});
