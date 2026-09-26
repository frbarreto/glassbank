/**
 * The seed generator: determinism, shape and the copied category table.
 *
 * "Same seed, same dataset" is the property the whole ADR-15 layering rests on - a dataset that is
 * evicted under memory pressure has to come back byte-identical - so it is asserted three ways
 * here: two independent generations are deeply equal, their JSON is byte-equal, and the SHA-256 of
 * that JSON matches a pinned digest. The digest is a deliberate tripwire: if you change the
 * generator on purpose, recompute it and say so in the commit; if it changes by accident, the
 * generator stopped being pure.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { idPattern } from '../../contracts/index.js';
import { BANK_CATEGORIES, BANK_CURRENCIES } from '../categories.js';
import { SHARED_PERSONAS, personaForSeed } from '../personas.js';
import { HISTORY_DAYS, MAX_TRANSACTIONS, MIN_TRANSACTIONS, generateDataset } from '../seed.js';

const AS_OF = new Date('2026-09-08T00:00:00.000Z');

/**
 * SHA-256 of `JSON.stringify(generateDataset(persona, {asOf: 2026-09-08}))`.
 * Recompute deliberately when the generator changes; never "fix" by pasting a new value blindly.
 */
const GOLDEN_DIGESTS: Readonly<Record<string, string>> = {
  per_ava_stone: 'b41f95c8ea2796966995dbd03155eeaf11551b7028dbae0ca278ad5933bcc405',
  per_noah_reid: 'ad467b7ba9354a9f3c658d8c8b710ab655b5e8276c1a71b88d843999551c4d47',
  per_harbor_supply: 'db89f8ba17d17f85c71c3a5b54ba16c9b5a2aa84c245ce8323776638f00027c0',
};

function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

describe("Ramp's category table, copied verbatim (THIRD_PARTY_NOTICES.md)", () => {
  it('has 43 entries with ids 1..44 and 22 missing', () => {
    expect(BANK_CATEGORIES).toHaveLength(43);
    const ids = BANK_CATEGORIES.map((category) => Number(category.id));
    const expected = Array.from({ length: 44 }, (_unused, index) => index + 1).filter(
      (id) => id !== 22,
    );
    expect(ids).toEqual(expected);
  });

  it("reproduces Ramp's SK_CATEGORIES names exactly", () => {
    const byId = new Map(BANK_CATEGORIES.map((category) => [category.id, category.name]));
    expect(byId.get('1')).toBe('Pet');
    expect(byId.get('9')).toBe('Freight, moving and delivery services');
    expect(byId.get('21')).toBe('Medical');
    expect(byId.get('23')).toBe('Fees and financial institutions');
    expect(byId.get('40')).toBe('SaaS / Software');
    expect(byId.get('44')).toBe('Insurance');
    expect(byId.has('22')).toBe(false);
  });

  it('lists USD first with two minor digits (Decision D-1)', () => {
    expect(BANK_CURRENCIES[0]).toEqual({
      code: 'USD',
      name: 'United States Dollar',
      symbol: '$',
      minor_unit_digits: 2,
    });
  });
});

describe('generateDataset is a pure function of the seed', () => {
  for (const persona of SHARED_PERSONAS) {
    it(`${persona.id} regenerates byte-identically`, () => {
      const first = generateDataset(persona, { asOf: AS_OF });
      const second = generateDataset(persona, { asOf: AS_OF });
      expect(second).toEqual(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(digestOf(first)).toBe(GOLDEN_DIGESTS[persona.id]);
    });
  }

  it('anchors on the UTC day, not the time of day', () => {
    const persona = SHARED_PERSONAS[0]!;
    const morning = generateDataset(persona, { asOf: new Date('2026-09-08T00:00:00.000Z') });
    const evening = generateDataset(persona, { asOf: new Date('2026-09-08T23:59:59.000Z') });
    expect(digestOf(evening)).toBe(digestOf(morning));
  });

  it('produces a different dataset for a different seed', () => {
    const one = generateDataset(personaForSeed('seed-one'), { asOf: AS_OF });
    const two = generateDataset(personaForSeed('seed-two'), { asOf: AS_OF });
    expect(digestOf(one)).not.toBe(digestOf(two));
  });

  it('rebuilds a generated persona from its id alone (A-15)', () => {
    const minted = personaForSeed('a1b2c3d4');
    const recovered = personaForSeed('a1b2c3d4');
    expect(recovered).toEqual(minted);
    expect(digestOf(generateDataset(recovered, { asOf: AS_OF }))).toBe(
      digestOf(generateDataset(minted, { asOf: AS_OF })),
    );
  });
});

describe('dataset shape (A-23: ~2,000 transactions over 12 months)', () => {
  for (const persona of SHARED_PERSONAS) {
    describe(persona.id, () => {
      const dataset = generateDataset(persona, { asOf: AS_OF });

      it('holds about 2,000 transactions spanning a full year', () => {
        expect(dataset.transactions.length).toBeGreaterThanOrEqual(MIN_TRANSACTIONS);
        expect(dataset.transactions.length).toBeLessThanOrEqual(MAX_TRANSACTIONS);
        const dates = dataset.transactions.map((transaction) => transaction.date);
        const earliest = dates.reduce((a, b) => (a < b ? a : b));
        const latest = dates.reduce((a, b) => (a > b ? a : b));
        expect(latest).toBe('2026-09-08');
        expect(earliest <= '2025-09-30').toBe(true);
        const months = new Set(dates.map((date) => date.slice(0, 7)));
        expect(months.size).toBeGreaterThanOrEqual(12);
      });

      it('has checking, savings and credit-card accounts with integer cent balances', () => {
        const types = new Set(dataset.accounts.map((account) => account.account_type));
        expect(types).toEqual(new Set(['checking', 'savings', 'credit_card']));
        for (const account of dataset.accounts) {
          expect(Number.isInteger(account.balance_cents)).toBe(true);
          expect(Number.isInteger(account.available_balance_cents)).toBe(true);
          expect(account.currency).toBe('USD');
          expect(account.account_number_last4).toMatch(/^\d{4}$/);
        }
        // A credit-card balance is what is owed, so it is negative.
        const credit = dataset.accounts.find((a) => a.account_type === 'credit_card')!;
        expect(credit.balance_cents).toBeLessThan(0);
        expect(credit.credit_limit_cents).toBeGreaterThan(0);
        // One closed account, so `account_closed` is reachable without inventing state.
        expect(dataset.accounts.some((account) => account.status === 'closed')).toBe(true);
      });

      it('has an active, a locked and a fraud-locked card, each with a last4', () => {
        const statuses = new Set(dataset.cards.map((card) => card.status));
        expect(statuses).toEqual(new Set(['active', 'locked', 'fraud_locked']));
        for (const card of dataset.cards) {
          expect(card.last4).toMatch(/^\d{4}$/);
          expect(card.expires_on).toMatch(/^\d{4}-\d{2}$/);
          expect(dataset.accounts.some((account) => account.id === card.account_id)).toBe(true);
        }
      });

      it('covers all three rails and all three transfer statuses', () => {
        expect(new Set(dataset.transfers.map((transfer) => transfer.rail))).toEqual(
          new Set(['ach', 'wire', 'internal']),
        );
        expect(new Set(dataset.transfers.map((transfer) => transfer.status))).toEqual(
          new Set(['scheduled', 'completed', 'failed']),
        );
        for (const transfer of dataset.transfers) {
          expect(transfer.amount_cents).toBeGreaterThan(0);
          expect(transfer.total_cents).toBe(transfer.amount_cents + transfer.fee_cents);
          expect(transfer.rail === 'wire' ? transfer.fee_cents : 0).toBeGreaterThanOrEqual(0);
        }
      });

      it('has open, paid and overdue bills with due dates', () => {
        expect(new Set(dataset.bills.map((bill) => bill.status))).toEqual(
          new Set(['open', 'paid', 'overdue']),
        );
        for (const bill of dataset.bills) {
          expect(bill.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(bill.issued_date < bill.due_date).toBe(true);
          expect(dataset.payees.some((payee) => payee.id === bill.payee_id)).toBe(true);
        }
      });

      it('masks every payee account number and keeps an inactive one', () => {
        expect(dataset.payees.length).toBeGreaterThanOrEqual(8);
        for (const payee of dataset.payees) {
          expect(payee.account_number_masked).toMatch(/^\*{4}\d{4}$/);
          expect(payee.routing_number_masked).toMatch(/^\*{4}\d{4}$/);
        }
        expect(dataset.payees.some((payee) => !payee.is_active)).toBe(true);
        expect(dataset.payees.some((payee) => payee.rail === 'wire')).toBe(true);
      });

      it('books every transaction against a real category, account and card', () => {
        const categoryIds = new Set(BANK_CATEGORIES.map((category) => category.id));
        const accountIds = new Set(dataset.accounts.map((account) => account.id));
        const cardIds = new Set(dataset.cards.map((card) => card.id));
        let incoming = 0;
        for (const transaction of dataset.transactions) {
          expect(categoryIds.has(transaction.category_id)).toBe(true);
          expect(accountIds.has(transaction.account_id)).toBe(true);
          if (transaction.card_id !== null) expect(cardIds.has(transaction.card_id)).toBe(true);
          expect(Number.isInteger(transaction.amount_cents)).toBe(true);
          expect(transaction.currency).toBe('USD');
          if (transaction.status === 'declined') {
            expect(transaction.decline_reason).not.toBeNull();
            expect(transaction.posted_at).toBeNull();
          }
          if (transaction.status === 'posted') expect(transaction.posted_at).not.toBeNull();
          if (transaction.amount_cents > 0) incoming += 1;
        }
        // Money has to come in as well as go out, or a balance question makes no sense.
        expect(incoming).toBeGreaterThanOrEqual(12);
        expect(new Set(dataset.transactions.map((t) => t.status))).toEqual(
          new Set(['posted', 'pending', 'declined']),
        );
      });

      it('gives every entity a contract-shaped id', () => {
        for (const account of dataset.accounts) expect(account.id).toMatch(idPattern('account'));
        for (const card of dataset.cards) expect(card.id).toMatch(idPattern('card'));
        for (const payee of dataset.payees) expect(payee.id).toMatch(idPattern('payee'));
        for (const bill of dataset.bills) expect(bill.id).toMatch(idPattern('bill'));
        for (const transfer of dataset.transfers) expect(transfer.id).toMatch(idPattern('transfer'));
        for (const transaction of dataset.transactions) {
          expect(transaction.id).toMatch(idPattern('transaction'));
        }
        const ids = dataset.transactions.map((transaction) => transaction.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('writes every label in English and every amount in USD cents (D-1)', () => {
        const text = [
          ...dataset.accounts.map((account) => account.name),
          ...dataset.cards.map((card) => `${card.brand} ${card.cardholder_name}`),
          ...dataset.payees.map((payee) => `${payee.name} ${payee.bank_name}`),
          ...dataset.transactions.map((t) => `${t.merchant_name} ${t.description}`),
        ].join(' ');
        // Latin letters, digits, spaces and a small set of punctuation; no accents, no other script.
        expect(text).toMatch(/^[A-Za-z0-9 .,'()/&-]+$/);
      });
    });
  }

  it('honours a shorter history window', () => {
    const dataset = generateDataset(SHARED_PERSONAS[0]!, { asOf: AS_OF, historyDays: 40 });
    const earliest = dataset.transactions
      .map((transaction) => transaction.date)
      .reduce((a, b) => (a < b ? a : b));
    expect(earliest >= '2026-07-30').toBe(true);
    expect(HISTORY_DAYS).toBe(365);
  });
});
