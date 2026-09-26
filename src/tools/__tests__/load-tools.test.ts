/**
 * The seven `load_*` tools against the fakes.
 *
 * The rule under test everywhere here is the one that makes the whole ETL pattern work: a load
 * tool returns Ramp's instruction string and the advertised columns, and **never a row**.
 */
import { describe, expect, it } from 'vitest';

import {
  NO_DATA_FOUND,
  TOO_MANY_TABLES_MESSAGE,
  loadResultText,
  type ToolResult,
} from '../../contracts/index.js';
import { TOO_MANY_PAGES_MESSAGE, createTools } from '../index.js';

import { createFakeToolContext, type FakeToolContext } from './fakes.js';

const registry = createTools();
const WHOLE_YEAR = { from_date: '2026-01-01', to_date: '2026-12-31' };

function structured(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

function text(result: ToolResult): string {
  return result.content.map((part) => part.text).join('');
}

async function callLoad(
  context: FakeToolContext,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return registry.call(tool, { rationale: `load for ${tool}`, ...args }, context);
}

describe('load tools return a table, never rows', () => {
  it('load_accounts stores every account and answers with Ramp instruction string', async () => {
    const context = createFakeToolContext();
    const result = await callLoad(context, 'load_accounts');
    const data = structured(result);

    expect(data.rows).toBe(20);
    expect(data.table_name).toBe('load_accounts_00000001');
    expect(text(result)).toBe(
      loadResultText({
        table_name: 'load_accounts_00000001',
        columns: data.columns as string[],
      }),
    );
    expect(text(result)).toContain('Stored data in memory database with table name:');
    expect(text(result)).toContain('Call `process_data` tool');

    // The columns are the entity's, minus `persona_id`, which is the same value on every row.
    expect(data.columns).toContain('balance_cents');
    expect(data.columns).toContain('account_number_last4');
    expect(data.columns).not.toContain('persona_id');

    // Not one balance leaked into the text.
    const accounts = await context.bank.listAccounts({
      persona_id: context.auth.persona.id,
      login_id: 'lgn_demo01',
    });
    const firstBalance = String(accounts.data[0]?.balance_cents);
    expect(text(result)).not.toContain(firstBalance);
  });

  it.each([
    ['checking', 7],
    ['savings', 7],
    ['credit_card', 6],
  ])('load_accounts filters on account_type %s', async (accountType, expected) => {
    const context = createFakeToolContext();
    const result = await callLoad(context, 'load_accounts', { account_type: accountType });
    expect(structured(result).rows).toBe(expected);
  });

  it('load_accounts filters on one account id, and "" means no filter', async () => {
    const context = createFakeToolContext();
    expect(
      structured(await callLoad(context, 'load_accounts', { account_id: 'acc_ava01_03' })).rows,
    ).toBe(1);
    expect(structured(await callLoad(context, 'load_accounts', { account_type: '' })).rows).toBe(
      20,
    );
  });

  it('load_transactions loads a date range and keeps the amount fields', async () => {
    const context = createFakeToolContext();
    const data = structured(await callLoad(context, 'load_transactions', WHOLE_YEAR));
    expect(data.rows).toBe(20);
    expect(data.columns).toContain('amount_cents');
    expect(data.columns).toContain('merchant_name');
    expect(data.columns).toContain('decline_reason');
  });

  it('load_transactions filters on card, category and status', async () => {
    const context = createFakeToolContext();
    const byStatus = structured(
      await callLoad(context, 'load_transactions', { ...WHOLE_YEAR, status: 'declined' }),
    );
    expect(byStatus.rows).toBe(4);
    const byCategory = structured(
      await callLoad(context, 'load_transactions', { ...WHOLE_YEAR, category_ids: ['1', '2'] }),
    );
    expect(byCategory.rows).toBe(2);
  });

  it('load_cards, load_transfers, load_bills and load_payees each store their entity', async () => {
    const context = createFakeToolContext();
    expect(structured(await callLoad(context, 'load_cards')).rows).toBe(20);
    expect(structured(await callLoad(context, 'load_cards', { status: 'fraud_locked' })).rows).toBe(
      1,
    );
    expect(structured(await callLoad(context, 'load_transfers', WHOLE_YEAR)).rows).toBe(20);
    expect(
      structured(
        await callLoad(context, 'load_transfers', { ...WHOLE_YEAR, direction: 'incoming' }),
      ).rows,
    ).toBe(5);
    expect(structured(await callLoad(context, 'load_bills', WHOLE_YEAR)).rows).toBe(20);
    // Ramp's `load_vendors` default: active payees only unless the model asks for archived ones.
    expect(structured(await callLoad(context, 'load_payees')).rows).toBe(16);
    expect(structured(await callLoad(context, 'load_payees', { is_active: false })).rows).toBe(4);
    expect(structured(await callLoad(context, 'load_payees', { name: 'alder' })).rows).toBe(2);
  });

  it('load_statement_lines returns the union of the three sources in one table', async () => {
    const context = createFakeToolContext();
    const data = structured(await callLoad(context, 'load_statement_lines', WHOLE_YEAR));
    expect(data.rows).toBe(60);
    expect(data.columns).toContain('source');
    expect(data.columns).toContain('counterparty');
  });

  it('answers "No data found" and creates no table when nothing matches', async () => {
    const context = createFakeToolContext();
    const result = await callLoad(context, 'load_transactions', {
      from_date: '2020-01-01',
      to_date: '2020-01-31',
    });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(NO_DATA_FOUND);
    expect(context.scratch.tableNames()).toEqual([]);
  });
});

describe('load tool argument handling', () => {
  it('rejects a malformed date with an explanation instead of an empty table', async () => {
    const context = createFakeToolContext();
    const result = await callLoad(context, 'load_bills', {
      from_date: '01/02/2026',
      to_date: '2026-02-01',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('YYYY-MM-DD');
    expect(context.scratch.tableNames()).toEqual([]);
  });

  it('rejects an impossible date and an inverted range', async () => {
    const context = createFakeToolContext();
    expect(
      text(
        await callLoad(context, 'load_bills', { from_date: '2026-02-31', to_date: '2026-03-01' }),
      ),
    ).toContain('not a YYYY-MM-DD date');
    expect(
      text(
        await callLoad(context, 'load_bills', { from_date: '2026-03-01', to_date: '2026-02-01' }),
      ),
    ).toContain('is after to_date');
  });

  it('accepts a timestamp by taking its UTC day, because models send them', async () => {
    const context = createFakeToolContext();
    const data = structured(
      await callLoad(context, 'load_transactions', {
        from_date: '2026-01-01T00:00:00Z',
        to_date: '2026-12-31T23:59:59Z',
      }),
    );
    expect(data.rows).toBe(20);
  });
});

describe('paging and caps', () => {
  it('walks every page of the bank envelope', async () => {
    const paged = createTools({ limits: { loadPageSize: 5 } });
    const context = createFakeToolContext();
    const result = await paged.call('load_accounts', { rationale: 'all of them' }, context);
    const data = structured(result);
    expect(data.rows).toBe(20);
    expect(data.pages).toBe(4);
  });

  it('stops at CLIENT_MAX_PAGES with Ramp exact message', async () => {
    const tiny = createTools({ limits: { loadPageSize: 1, maxPagesPerLoad: 3 } });
    const context = createFakeToolContext();
    const result = await tiny.call('load_accounts', { rationale: 'all of them' }, context);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(TOO_MANY_PAGES_MESSAGE);
  });

  it('passes the per-grant table cap through as the hosted Ramp message', async () => {
    const context = createFakeToolContext();
    context.scratch.failNextWith('grant_cap', 'whatever the etl block said');
    const result = await callLoad(context, 'load_accounts');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(TOO_MANY_TABLES_MESSAGE);
  });
});
