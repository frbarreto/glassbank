/**
 * The six public tools (contracts v0.7, D-26): three levels of products, two of locations, the
 * pointer to the signed-in connector, and the intent events every call emits first.
 */
import { describe, expect, it } from 'vitest';

import { PUBLIC_LOGIN_ID, PUBLIC_TOOL_NAMES, XrayEventSchema } from '../../contracts/index.js';
import { createPublicTools } from '../public.js';

import { createFakePublicToolContext } from './fakes.js';

function textOf(result: { content: readonly { text: string }[] }): string {
  return result.content.map((part) => part.text).join('');
}

function jsonOf(result: { content: readonly { text: string }[] }): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

describe('createPublicTools (D-26)', () => {
  it('lists the six public tools to everybody, with one stable hash', () => {
    const tools = createPublicTools();
    const snapshot = tools.list();
    expect(snapshot.listed.map((entry) => entry.name)).toEqual(PUBLIC_TOOL_NAMES);
    expect(snapshot.availability.every((row) => row.listed && row.available)).toBe(true);
    expect(snapshot.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(tools.list().content_hash).toBe(snapshot.content_hash);
    expect(Object.keys(tools.handlers).sort()).toEqual([...PUBLIC_TOOL_NAMES].sort());
  });

  it('walks products three levels deep: list, product, prices', async () => {
    const tools = createPublicTools();
    const context = createFakePublicToolContext();

    const level1 = jsonOf(await tools.call('list_products', { rationale: 'what do they sell' }, context));
    const families = level1.families as { products: { product_id: string; lowest_monthly_fee: string }[] }[];
    expect(families[0]?.products[0]?.product_id).toBe('fake_checking');
    expect(families[0]?.products[0]?.lowest_monthly_fee).toBe('0 cents ($0.00)');

    const level2 = jsonOf(
      await tools.call('get_product', { product_id: 'fake_checking', rationale: 'plans' }, context),
    );
    expect((level2.plans as { monthly_fee: string }[])[1]?.monthly_fee).toBe('1000 cents ($10.00)');
    expect((level2.next as string[])[0]).toContain('search_prices');
    expect((level2.next as string[])[1]).toContain('https://glassbank.example/mcp');

    const level3 = jsonOf(
      await tools.call(
        'search_prices',
        { product_id: 'fake_checking', plan_id: 'fake_checking_plus', kind: '', query: '', rationale: 'fees' },
        context,
      ),
    );
    expect(level3.count).toBe(2);
    const prices = level3.prices as { amount: string | null; rate_bps: number | null }[];
    expect(prices.map((price) => price.amount)).toEqual(['1000 cents ($10.00)', null]);
    expect(context.info.calls).toEqual([
      'listProducts:',
      'getProduct:fake_checking',
      'getProduct:fake_checking',
      'searchPrices',
    ]);
  });

  it('treats empty strings as no filter and forwards a ceiling in cents', async () => {
    const tools = createPublicTools();
    const context = createFakePublicToolContext();
    const all = jsonOf(await tools.call('search_prices', { product_id: '', kind: '' }, context));
    expect(all.count).toBe(3);
    const cheap = jsonOf(await tools.call('search_prices', { max_amount: 1000 }, context));
    expect(cheap.count).toBe(1);
    const none = jsonOf(await tools.call('search_prices', { query: 'overdraft' }, context));
    expect(none.count).toBe(0);
    expect((none.next as string[])[0]).toMatch(/No price matched/);
  });

  it('refuses an unknown product with the known ids, as a tool error', async () => {
    const tools = createPublicTools();
    const context = createFakePublicToolContext();
    const result = await tools.call('get_product', { product_id: 'nope', rationale: 'x' }, context);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Ran into an error: there is no product "nope"\. Known product_ids: fake_checking\./);
    const prices = await tools.call('search_prices', { product_id: 'nope' }, context);
    expect(prices.isError).toBe(true);
  });

  it('walks locations two levels deep and names the cities when nothing matches', async () => {
    const tools = createPublicTools();
    const context = createFakePublicToolContext();
    const found = jsonOf(await tools.call('find_branches', { city: 'springfield', service: '' }, context));
    expect(found.count).toBe(1);
    const branch = jsonOf(await tools.call('get_branch', { branch_id: 'spr_main' }, context));
    expect(branch.address).toBe('1 Main Street, Springfield, IL 62701');
    const nowhere = jsonOf(await tools.call('find_branches', { city: 'Boston' }, context));
    expect((nowhere.next as string[])[0]).toBe('No location matched. Cities served: Springfield.');
    const unknown = await tools.call('get_branch', { branch_id: 'nope' }, context);
    expect(unknown.isError).toBe(true);
  });

  it('hands out the three endpoints on the profile', async () => {
    const tools = createPublicTools();
    const profile = jsonOf(await tools.call('get_bank_profile', { rationale: 'who are you' }, createFakePublicToolContext()));
    expect(profile.endpoints).toEqual({
      public_mcp: 'https://glassbank.example/public/mcp',
      signed_in_mcp: 'https://glassbank.example/mcp',
      public_dashboard: 'https://glassbank.example/xray/?lane=public',
    });
  });

  it('emits the intent under the public login and the pseudo grant, before validation', async () => {
    const tools = createPublicTools();
    const context = createFakePublicToolContext();
    await tools.call('list_products', { rationale: 'comparing banks' }, context);
    await tools.call('get_product', {}, context);
    const [declared, missing] = context.xray.events;
    expect(declared?.type).toBe('intent.declared');
    expect(declared?.login_id).toBe(PUBLIC_LOGIN_ID);
    expect(declared?.grant_id).toBe('grt_pub_0123456789ab');
    expect(declared?.request_id).toBe('7');
    expect(missing?.type).toBe('intent.missing');
    for (const event of context.xray.events) expect(XrayEventSchema.safeParse(event).success).toBe(true);
    expect(tools.stats()).toEqual({ calls: 2, errors: 1 });
  });

  it('turns schema mismatches and throws into tool errors, and rejects unknown names', async () => {
    const tools = createPublicTools();
    const context = createFakePublicToolContext();
    const bad = await tools.call('list_products', { family: 'loans' }, context);
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('the arguments for list_products did not match its schema');
    const throwing = createFakePublicToolContext({ publicBaseUrl: 'https://x.example' });
    const broken = { ...throwing, info: { ...throwing.info, profile: () => Promise.reject(new Error('boom')) } };
    const result = await tools.call('get_bank_profile', {}, broken);
    expect(textOf(result)).toContain('boom');
    await expect(tools.call('load_accounts', {}, context)).rejects.toThrow(/Unknown tool/);
  });
});
