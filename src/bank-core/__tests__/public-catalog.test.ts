/**
 * The published catalog behind the public lane (contracts v0.7, D-26): three levels of products,
 * two of locations, every read one `bank.op`, and every id an agent is told about resolvable.
 */
import { describe, expect, it } from 'vitest';

import { BRANCH_SERVICES, PRICE_KINDS, PRODUCT_FAMILIES } from '../../contracts/index.js';
import { BRANCH_CITIES } from '../public-catalog.js';

import { createHarness } from './harness.js';

describe('publicInfo (D-26)', () => {
  it('describes the bank as fictional and says what needs a sign-in', async () => {
    const { bank, emitter } = createHarness();
    const profile = await bank.publicInfo.profile();
    expect(profile.name).toBe('Glass Bank');
    expect(profile.fictional).toBe(true);
    expect(profile.differentiators.length).toBeGreaterThanOrEqual(3);
    expect(profile.needs_sign_in).toContain('accounts and balances');
    expect(emitter.operations()).toEqual(['public.profile']);
  });

  it('lists six products in three families, and filters by family', async () => {
    const { bank, emitter } = createHarness();
    const all = await bank.publicInfo.listProducts();
    expect(all.map((family) => family.family)).toEqual([...PRODUCT_FAMILIES]);
    expect(all.flatMap((family) => family.products)).toHaveLength(6);
    const cards = await bank.publicInfo.listProducts('cards');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.products.map((product) => product.product_id)).toEqual([
      'prism_debit',
      'lens_credit',
    ]);
    const ops = emitter.ofType('bank.op');
    expect(ops.map((event) => [event.data.operation, event.data.rows])).toEqual([
      ['public.products', 6],
      ['public.products', 2],
    ]);
  });

  it('resolves every listed product to its plans, and every plan to at least one price', async () => {
    const { bank } = createHarness();
    const products = (await bank.publicInfo.listProducts()).flatMap((family) => family.products);
    for (const summary of products) {
      const detail = await bank.publicInfo.getProduct(summary.product_id);
      expect(detail, summary.product_id).not.toBeNull();
      expect(detail?.plans.length).toBe(summary.plan_count);
      expect(summary.lowest_monthly_fee_cents).toBe(
        Math.min(...(detail?.plans ?? []).map((plan) => plan.monthly_fee_cents)),
      );
      for (const plan of detail?.plans ?? []) {
        const prices = await bank.publicInfo.searchPrices({ plan_id: plan.plan_id });
        expect(prices.length, plan.plan_id).toBeGreaterThan(0);
        expect(new Set(prices.map((price) => price.product_id))).toEqual(
          new Set([summary.product_id]),
        );
      }
    }
  });

  it('answers an unknown product or branch with null and a failed bank.op', async () => {
    const { bank, emitter } = createHarness();
    expect(await bank.publicInfo.getProduct('nope')).toBeNull();
    expect(await bank.publicInfo.getBranch('nope')).toBeNull();
    expect(emitter.ofType('bank.op').map((event) => [event.data.ok, event.data.error])).toEqual([
      [false, 'unknown_product'],
      [false, 'unknown_branch'],
    ]);
  });

  it('keeps every price either an amount in cents or a rate in basis points, never both', async () => {
    const { bank } = createHarness();
    const prices = await bank.publicInfo.searchPrices({});
    expect(prices.length).toBeGreaterThan(40);
    expect(new Set(prices.map((price) => price.price_id)).size).toBe(prices.length);
    for (const price of prices) {
      expect(PRICE_KINDS).toContain(price.kind);
      expect((price.amount_cents === null) !== (price.rate_bps === null), price.price_id).toBe(true);
      if (price.amount_cents !== null) expect(Number.isInteger(price.amount_cents)).toBe(true);
    }
  });

  it('narrows prices by kind, words and a ceiling in cents, dropping rates under a ceiling', async () => {
    const { bank } = createHarness();
    const wires = await bank.publicInfo.searchPrices({ text: 'domestic wire' });
    expect(wires.length).toBeGreaterThan(0);
    for (const line of wires) expect(line.name.toLowerCase()).toContain('wire');
    const cheap = await bank.publicInfo.searchPrices({ max_amount_cents: 0 });
    expect(cheap.every((line) => line.amount_cents === 0)).toBe(true);
    const rates = await bank.publicInfo.searchPrices({ kind: 'rate', product_id: 'glass_savings' });
    expect(rates.map((line) => line.display)).toContain('3.10% on the whole balance, variable');
    const plus = await bank.publicInfo.searchPrices({ plan_id: 'clear_checking_plus', kind: 'monthly_fee' });
    expect(plus).toHaveLength(1);
    expect(plus[0]?.display).toBe('$12.00 every month');
    expect(plus[0]?.waiver).toBe('Keep a daily balance of $1,500 or more');
  });

  it('finds branches by city, case-insensitively, and by service, and always lists the cities', async () => {
    const { bank } = createHarness();
    const everything = await bank.publicInfo.findBranches({});
    expect(everything.branches).toHaveLength(8);
    expect(everything.cities).toEqual(BRANCH_CITIES);
    const austin = await bank.publicInfo.findBranches({ city: ' austin ' });
    expect(austin.branches.map((branch) => branch.branch_id)).toEqual(['aus_south_congress', 'aus_north']);
    const coins = await bank.publicInfo.findBranches({ service: 'coin_counter' });
    expect(coins.branches.every((branch) => branch.services.includes('coin_counter'))).toBe(true);
    const nowhere = await bank.publicInfo.findBranches({ city: 'Boston' });
    expect(nowhere.branches).toEqual([]);
    expect(nowhere.cities.length).toBe(4);
  });

  it('gives every branch seven days of hours and only known services', async () => {
    const { bank } = createHarness();
    for (const summary of (await bank.publicInfo.findBranches({})).branches) {
      const branch = await bank.publicInfo.getBranch(summary.branch_id);
      expect(branch?.hours).toHaveLength(7);
      for (const service of branch?.services ?? []) expect(BRANCH_SERVICES).toContain(service);
      if (branch?.kind === 'atm_lobby') expect(branch.open_24_hours).toBe(true);
    }
    const studio = await bank.publicInfo.getBranch('chi_wicker_park');
    expect(studio?.hours.find((day) => day.day === 'sunday')).toEqual({
      day: 'sunday',
      opens: null,
      closes: null,
    });
  });
});
