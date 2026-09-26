/**
 * The write operations: card lock/unlock and the two-step transfer, including every rejection the
 * contract names.
 *
 * `docs/TOOL_CATALOG.md` section 7 is the specification for the transfer choreography, and the
 * rules the tests pin down are the ones a public demo cannot get wrong: a `fraud_locked` card is
 * never unlocked here, money never moves without a matching `expected_total_amount`, a preview is
 * confirmable once and only by the login that made it, and every write leaves an audit entry.
 */
import { describe, expect, it } from 'vitest';

import type { Account, Card, Payee, Persona } from '../../contracts/index.js';
import { WIRE_FEE_CENTS } from '../config.js';
import { SHARED_PERSONAS } from '../personas.js';
import { DAILY_LIMIT_MULTIPLIER } from '../transfers.js';
import { AVA, LOGIN_A, LOGIN_B, createHarness, scopeOf } from './harness.js';

const ava = scopeOf(AVA, LOGIN_A, 'grt_ops001');

async function world(bank: {
  dataset: (id: string) => Promise<{
    accounts: readonly Account[];
    cards: readonly Card[];
    payees: readonly Payee[];
  }>;
}) {
  const dataset = await bank.dataset(AVA);
  return {
    checking: dataset.accounts.find((a) => a.account_type === 'checking' && a.status === 'open')!,
    savings: dataset.accounts.find((a) => a.account_type === 'savings')!,
    closed: dataset.accounts.find((a) => a.status === 'closed')!,
    activeCard: dataset.cards.find((c) => c.status === 'active' && c.account_id !== dataset.accounts.find((a) => a.status === 'closed')!.id)!,
    lockedCard: dataset.cards.find((c) => c.status === 'locked')!,
    fraudCard: dataset.cards.find((c) => c.status === 'fraud_locked')!,
    closedAccountCard: dataset.cards.find(
      (c) => c.account_id === dataset.accounts.find((a) => a.status === 'closed')!.id,
    )!,
    achPayee: dataset.payees.find((p) => p.is_active && p.rail === 'ach')!,
    wirePayee: dataset.payees.find((p) => p.is_active && p.rail === 'wire')!,
    inactivePayee: dataset.payees.find((p) => !p.is_active)!,
  };
}

describe('card lock and unlock', () => {
  it('locks an active card, records an audit entry and shows the new status on reads', async () => {
    const { bank } = createHarness();
    const { activeCard } = await world(bank);

    const locked = await bank.lockCard(ava, activeCard.id, 'the user reported the card missing');
    expect(locked.ok).toBe(true);
    if (!locked.ok) return;
    expect(locked.card.status).toBe('locked');
    expect(locked.changed).toBe(true);
    expect(locked.audit_id).toMatch(/^aud_/);

    const cards = await bank.listCards(ava, { account_id: activeCard.account_id });
    expect(cards.data.find((card) => card.id === activeCard.id)!.status).toBe('locked');

    const audit = await bank.listAuditEntries(ava);
    expect(audit.data[0]!.action).toBe('card.lock');
    expect(audit.data[0]!.target_id).toBe(activeCard.id);
    expect(audit.data[0]!.rationale).toBe('the user reported the card missing');
    expect(audit.data[0]!.grant_id).toBe('grt_ops001');
  });

  it('is idempotent: locking twice succeeds with changed=false', async () => {
    const { bank } = createHarness();
    const { activeCard } = await world(bank);
    await bank.lockCard(ava, activeCard.id);
    const again = await bank.lockCard(ava, activeCard.id);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.changed).toBe(false);
    expect(again.card.status).toBe('locked');
  });

  it('unlocks a card the user locked', async () => {
    const { bank } = createHarness();
    const { lockedCard } = await world(bank);
    const unlocked = await bank.unlockCard(ava, lockedCard.id, 'the user found the card');
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) return;
    expect(unlocked.card.status).toBe('active');
    expect(unlocked.changed).toBe(true);
  });

  it('refuses to unlock a fraud_locked card and says why', async () => {
    const { bank } = createHarness();
    const { fraudCard } = await world(bank);
    const result = await bank.unlockCard(ava, fraudCard.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('fraud_locked');
    expect(result.message).toContain('fraud');
    expect(result.message).toContain('cannot be unlocked');
    expect(result.card?.status).toBe('fraud_locked');
    // Nothing was written.
    const cards = await bank.listCards(ava, { status: 'fraud_locked' });
    expect(cards.data).toHaveLength(1);
  });

  it('reports a lock on a fraud_locked card as already_in_state', async () => {
    const { bank } = createHarness();
    const { fraudCard } = await world(bank);
    const result = await bank.lockCard(ava, fraudCard.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already_in_state');
  });

  it('rejects an unknown card and a card on a closed account', async () => {
    const { bank } = createHarness();
    const { closedAccountCard } = await world(bank);

    const unknown = await bank.lockCard(ava, 'card_does_not_exist');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe('unknown_card');

    const closed = await bank.lockCard(ava, closedAccountCard.id);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.reason).toBe('account_closed');
  });
});

describe('transfer preview', () => {
  it('quotes an ACH transfer with no fee and a resulting balance', async () => {
    const { bank } = createHarness();
    const { checking, achPayee } = await world(bank);
    const result = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { payee_id: achPayee.id },
      amount: 100_000,
      currency: 'USD',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const preview = result.preview;
    expect(preview.preview_id).toMatch(/^prv_/);
    expect(preview.rail).toBe('ach');
    expect(preview.fee).toBe(0);
    expect(preview.total).toBe(100_000);
    expect(preview.expected_total_amount).toBe(100_000);
    expect(preview.resulting_balance).toBe(checking.balance_cents - 100_000);
    expect(preview.policy_outlook.per_transfer_limit_cents).toBe(250_000);
    expect(preview.policy_outlook.status).not.toBe('blocked');
    expect(new Date(preview.expires_at).getTime()).toBeGreaterThan(Date.parse('2026-09-08T12:00:00.000Z'));
  });

  it('charges the wire fee on the wire rail', async () => {
    const { bank } = createHarness();
    const { checking, wirePayee } = await world(bank);
    const result = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { payee_id: wirePayee.id },
      amount: 50_000,
      currency: 'USD',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.rail).toBe('wire');
    expect(result.preview.fee).toBe(WIRE_FEE_CENTS);
    expect(result.preview.total).toBe(50_000 + WIRE_FEE_CENTS);
  });

  it('uses the internal rail between the persona own accounts', async () => {
    const { bank } = createHarness();
    const { checking, savings } = await world(bank);
    const result = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { account_id: savings.id },
      amount: 20_000,
      currency: 'USD',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.rail).toBe('internal');
    expect(result.preview.fee).toBe(0);
  });

  it.each([
    ['a zero amount', { amount: 0 }, 'invalid_amount'],
    ['a negative amount', { amount: -5_000 }, 'invalid_amount'],
    ['a fractional amount', { amount: 1_000.5 }, 'invalid_amount'],
    ['an unknown source account', { from_account_id: 'acc_nope' }, 'unknown_account'],
    ['a non-USD currency', { currency: 'EUR' }, 'currency_not_supported'],
    ['an amount over the per-transfer limit', { amount: 300_000 }, 'over_limit'],
  ])('rejects %s', async (_label, overrides, reason) => {
    const { bank } = createHarness();
    const { checking, achPayee } = await world(bank);
    const result = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { payee_id: achPayee.id },
      amount: 10_000,
      currency: 'USD',
      ...overrides,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      expect(result.message.length).toBeGreaterThan(10);
    }
  });

  it('rejects a closed source account, an unknown payee and an archived payee', async () => {
    const { bank } = createHarness();
    const { checking, closed, achPayee, inactivePayee } = await world(bank);

    const fromClosed = await bank.previewTransfer(ava, {
      from_account_id: closed.id,
      to: { payee_id: achPayee.id },
      amount: 1_000,
      currency: 'USD',
    });
    expect(fromClosed.ok).toBe(false);
    if (!fromClosed.ok) expect(fromClosed.reason).toBe('account_closed');

    const toClosed = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { account_id: closed.id },
      amount: 1_000,
      currency: 'USD',
    });
    expect(toClosed.ok).toBe(false);
    if (!toClosed.ok) expect(toClosed.reason).toBe('account_closed');

    const unknownPayee = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { payee_id: 'pay_nope' },
      amount: 1_000,
      currency: 'USD',
    });
    expect(unknownPayee.ok).toBe(false);
    if (!unknownPayee.ok) expect(unknownPayee.reason).toBe('unknown_payee');

    const archived = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { payee_id: inactivePayee.id },
      amount: 1_000,
      currency: 'USD',
    });
    expect(archived.ok).toBe(false);
    if (!archived.ok) expect(archived.reason).toBe('payee_inactive');

    const sameAccount = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { account_id: checking.id },
      amount: 1_000,
      currency: 'USD',
    });
    expect(sameAccount.ok).toBe(false);
    if (!sameAccount.ok) expect(sameAccount.message).toContain('different from the source');
  });

  it('rejects a transfer larger than the available balance', async () => {
    // A persona with a very high per-transfer limit, so `insufficient_funds` is reachable before
    // `over_limit`; the shared personas are limited well below their balances on purpose.
    const rich: Persona = {
      ...SHARED_PERSONAS[0]!,
      id: 'per_rich_test',
      seed: 'rich-test',
      shared: false,
      transfer_limit_cents: 50_000_000,
    };
    const { bank } = createHarness({ personas: [rich] });
    const dataset = await bank.dataset(rich.id);
    const checking = dataset.accounts.find(
      (account) => account.account_type === 'checking' && account.status === 'open',
    )!;
    const payee = dataset.payees.find((candidate) => candidate.is_active)!;
    const scope = scopeOf(rich.id, LOGIN_A);
    const result = await bank.previewTransfer(scope, {
      from_account_id: checking.id,
      to: { payee_id: payee.id },
      amount: checking.available_balance_cents + 1,
      currency: 'USD',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('insufficient_funds');
      expect(result.message).toContain('available');
    }
  });
});

describe('transfer confirm', () => {
  async function preview(bank: ReturnType<typeof createHarness>['bank'], amount = 100_000) {
    const { checking, achPayee } = await world(bank);
    const result = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { payee_id: achPayee.id },
      amount,
      currency: 'USD',
    });
    if (!result.ok) throw new Error(`preview failed: ${result.reason}`);
    return { preview: result.preview, checking, achPayee };
  }

  it('moves the money, appends an audit entry and shows up in transfers and balances', async () => {
    const { bank } = createHarness();
    const { preview: quote, checking } = await preview(bank);
    const before = await bank.getBalances(ava);

    const confirmed = await bank.confirmTransfer(ava, {
      preview_id: quote.preview_id,
      expected_total_amount: quote.expected_total_amount,
      rationale: 'the user approved paying the contractor',
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.transfer.status).toBe('completed');
    expect(confirmed.transfer.amount_cents).toBe(100_000);
    expect(confirmed.transfer.audit_id).toBe(confirmed.audit_id);
    expect(confirmed.transfer.rail).toBe('ach');

    const after = await bank.getBalances(ava);
    expect(after.total_cash_cents).toBe(before.total_cash_cents - quote.total);

    const listed = await bank.listTransfers(ava, {
      from_date: '2026-09-08',
      to_date: '2026-09-08',
      limit: 100,
    });
    expect(listed.data.some((transfer) => transfer.id === confirmed.transfer.id)).toBe(true);

    const audit = await bank.listAuditEntries(ava, { action: 'transfer.confirm' });
    expect(audit.data[0]!.id).toBe(confirmed.audit_id);
    expect(audit.data[0]!.rationale).toBe('the user approved paying the contractor');

    // The seed dataset itself never changed (ADR-15).
    const dataset = await bank.dataset(AVA);
    expect(dataset.accounts.find((a) => a.id === checking.id)!.balance_cents).toBe(
      checking.balance_cents,
    );
  });

  it('credits the destination on an internal transfer', async () => {
    const { bank } = createHarness();
    const { checking, savings } = await world(bank);
    const quote = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { account_id: savings.id },
      amount: 30_000,
      currency: 'USD',
    });
    if (!quote.ok) throw new Error(quote.reason);
    const done = await bank.confirmTransfer(ava, {
      preview_id: quote.preview.preview_id,
      expected_total_amount: quote.preview.expected_total_amount,
    });
    expect(done.ok).toBe(true);
    const accounts = await bank.listAccounts(ava);
    expect(accounts.data.find((a) => a.id === checking.id)!.balance_cents).toBe(
      checking.balance_cents - 30_000,
    );
    expect(accounts.data.find((a) => a.id === savings.id)!.balance_cents).toBe(
      savings.balance_cents + 30_000,
    );
  });

  it('refuses a total that does not match the quote (the reprice guard)', async () => {
    const { bank } = createHarness();
    const { preview: quote } = await preview(bank);
    const result = await bank.confirmTransfer(ava, {
      preview_id: quote.preview_id,
      expected_total_amount: quote.expected_total_amount - 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('repriced');
    expect(result.preview?.total).toBe(quote.total);
    // And nothing moved.
    const transfers = await bank.listTransfers(ava, {
      from_date: '2026-09-08',
      to_date: '2026-09-08',
    });
    expect(transfers.data).toHaveLength(0);
  });

  it('rejects an unknown preview and a preview that already moved money', async () => {
    const { bank } = createHarness();
    const { preview: quote } = await preview(bank);

    const unknown = await bank.confirmTransfer(ava, {
      preview_id: 'prv_nope',
      expected_total_amount: 1,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe('unknown_preview');

    const first = await bank.confirmTransfer(ava, {
      preview_id: quote.preview_id,
      expected_total_amount: quote.expected_total_amount,
    });
    expect(first.ok).toBe(true);
    const second = await bank.confirmTransfer(ava, {
      preview_id: quote.preview_id,
      expected_total_amount: quote.expected_total_amount,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('unknown_preview');
  });

  it('expires a preview the user took too long to approve', async () => {
    const { bank, clock } = createHarness();
    const { preview: quote } = await preview(bank);
    clock.advanceMinutes(16);
    const result = await bank.confirmTransfer(ava, {
      preview_id: quote.preview_id,
      expected_total_amount: quote.expected_total_amount,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired_preview');
      expect(result.message).toContain('preview step again');
    }
  });

  it('re-prices against the state at confirm time, not the state at preview time', async () => {
    // Two previews are taken while the account can still afford either, then the first is
    // confirmed. The second must not go through on the stale numbers.
    const rich: Persona = {
      ...SHARED_PERSONAS[0]!,
      id: 'per_reprice_test',
      seed: 'reprice-test',
      shared: false,
      transfer_limit_cents: 50_000_000,
    };
    const { bank } = createHarness({ personas: [rich] });
    const dataset = await bank.dataset(rich.id);
    const checking = dataset.accounts.find(
      (account) => account.account_type === 'checking' && account.status === 'open',
    )!;
    const payee = dataset.payees.find((candidate) => candidate.is_active)!;
    const scope = scopeOf(rich.id, LOGIN_A);
    const amount = Math.floor(checking.available_balance_cents * 0.7);

    const one = await bank.previewTransfer(scope, {
      from_account_id: checking.id,
      to: { payee_id: payee.id },
      amount,
      currency: 'USD',
    });
    const two = await bank.previewTransfer(scope, {
      from_account_id: checking.id,
      to: { payee_id: payee.id },
      amount,
      currency: 'USD',
    });
    if (!one.ok || !two.ok) throw new Error('both previews should quote');

    const first = await bank.confirmTransfer(scope, {
      preview_id: one.preview.preview_id,
      expected_total_amount: one.preview.expected_total_amount,
    });
    expect(first.ok).toBe(true);

    const second = await bank.confirmTransfer(scope, {
      preview_id: two.preview.preview_id,
      expected_total_amount: two.preview.expected_total_amount,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('insufficient_funds');
  });

  it('enforces the daily allowance across confirmed transfers', async () => {
    const { bank } = createHarness();
    const { checking, achPayee } = await world(bank);
    const persona = (await bank.personas.get(AVA))!;
    const perTransfer = persona.transfer_limit_cents;

    for (let index = 0; index < DAILY_LIMIT_MULTIPLIER; index += 1) {
      const quote = await bank.previewTransfer(ava, {
        from_account_id: checking.id,
        to: { payee_id: achPayee.id },
        amount: perTransfer,
        currency: 'USD',
      });
      if (!quote.ok) throw new Error(`preview ${index} failed: ${quote.reason}`);
      const done = await bank.confirmTransfer(ava, {
        preview_id: quote.preview.preview_id,
        expected_total_amount: quote.preview.expected_total_amount,
      });
      expect(done.ok).toBe(true);
    }

    const overDaily = await bank.previewTransfer(ava, {
      from_account_id: checking.id,
      to: { payee_id: achPayee.id },
      amount: 1_000,
      currency: 'USD',
    });
    expect(overDaily.ok).toBe(false);
    if (!overDaily.ok) {
      expect(overDaily.reason).toBe('over_limit');
      expect(overDaily.message).toContain('allowance');
    }
  });

  it('will not let another login confirm a preview it did not take', async () => {
    const { bank } = createHarness();
    const { preview: quote } = await preview(bank);
    const other = await bank.confirmTransfer(scopeOf(AVA, LOGIN_B), {
      preview_id: quote.preview_id,
      expected_total_amount: quote.expected_total_amount,
    });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toBe('unknown_preview');
  });
});
