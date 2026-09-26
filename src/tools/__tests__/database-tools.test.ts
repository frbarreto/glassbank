/**
 * `process_data`, `execute_query` and `clear_table` against the fake scratch database.
 *
 * The fake enforces the ADR-9 guard rules (deny-list, multi-statement, read-only, row cap)
 * without running SQL, which is exactly the boundary this block cares about: it must pass the
 * statement through, cap the result, and turn every refusal into a tool error the model can act
 * on - never a protocol error, and never a stack trace.
 */
import { describe, expect, it } from 'vitest';

import {
  ETL_OPERATION_LIMIT_MESSAGE,
  clearedTableText,
  processedTableText,
  rowCapMessage,
  type ToolResult,
} from '../../contracts/index.js';
import { createTools } from '../index.js';

import { createFakeToolContext, type FakeToolContext } from './fakes.js';

const registry = createTools();

function text(result: ToolResult): string {
  return result.content.map((part) => part.text).join('');
}

async function loadAccounts(context: FakeToolContext): Promise<string> {
  const result = await registry.call('load_accounts', { rationale: 'load them' }, context);
  return (result.structuredContent as { table_name: string }).table_name;
}

describe('the load -> process -> query -> clear protocol', () => {
  it('walks the whole cycle with Ramp exact strings', async () => {
    const context = createFakeToolContext();
    const table = await loadAccounts(context);

    const processed = await registry.call(
      'process_data',
      { table_name: table, cols: ['id', 'account_type', 'balance_cents'], rationale: 'build it' },
      context,
    );
    expect(text(processed)).toBe(processedTableText(table));
    expect(processed.structuredContent).toMatchObject({
      rows: 20,
      columns_selected: ['id', 'account_type', 'balance_cents'],
    });

    const queried = await registry.call(
      'execute_query',
      {
        table_name: table,
        query: `SELECT "account_type", SUM("balance_cents") AS total FROM "${table}" GROUP BY "account_type"`,
        rationale: 'total per type',
      },
      context,
    );
    expect(queried.isError).toBeUndefined();
    const rows = JSON.parse(text(queried)) as Record<string, unknown>[];
    expect(rows).toHaveLength(20);
    expect(Object.keys(rows[0] ?? {})).toEqual(['id', 'account_type', 'balance_cents']);
    expect(context.scratch.executedSql).toHaveLength(1);

    const cleared = await registry.call(
      'clear_table',
      { table_name: table, rationale: 'done with it' },
      context,
    );
    expect(text(cleared)).toBe(clearedTableText(table));
    expect(context.scratch.tableNames()).toEqual([]);
  });

  it('caps the result at MAX_QUERY_ROWS and says so, without failing the call', async () => {
    const context = createFakeToolContext({ limits: { maxQueryRows: 5 } });
    const table = await loadAccounts(context);
    await registry.call(
      'process_data',
      { table_name: table, cols: ['id'], rationale: 'ids' },
      context,
    );
    const queried = await registry.call(
      'execute_query',
      { table_name: table, query: `SELECT "id" FROM "${table}"`, rationale: 'all ids' },
      context,
    );
    expect(queried.isError).toBeUndefined();
    expect(text(queried).endsWith(rowCapMessage(5))).toBe(true);
    expect(JSON.parse(text(queried).split('\n')[0] as string)).toHaveLength(5);
    expect(queried.structuredContent).toMatchObject({ rows_returned: 5, capped: true });
  });

  it('refuses to return a result over the connection content cap', async () => {
    const context = createFakeToolContext({ limits: { contentCharCap: 40 } });
    const table = await loadAccounts(context);
    await registry.call(
      'process_data',
      { table_name: table, cols: ['id', 'name'], rationale: 'names' },
      context,
    );
    const queried = await registry.call(
      'execute_query',
      { table_name: table, query: `SELECT * FROM "${table}"`, rationale: 'everything' },
      context,
    );
    expect(queried.isError).toBe(true);
    expect(text(queried)).toContain('over this connection');
    expect(text(queried)).toContain('aggregate in SQL');
  });
});

describe('errors the model can act on', () => {
  it.each([
    ["ATTACH DATABASE '/tmp/leak.sqlite' AS leak", 'attach'],
    ['UPDATE "t" SET "x" = 1', 'update'],
    ['DROP TABLE "t"', 'drop'],
    ['PRAGMA query_only = 0', 'pragma'],
  ])('turns %s into a tool error naming the keyword', async (sql, keyword) => {
    const context = createFakeToolContext();
    const table = await loadAccounts(context);
    await registry.call(
      'process_data',
      { table_name: table, cols: ['id'], rationale: 'ids' },
      context,
    );
    const result = await registry.call(
      'execute_query',
      { table_name: table, query: sql, rationale: 'try it' },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Ran into an error: /);
    expect(text(result)).toContain(keyword);
    expect(text(result)).toContain('Communicate this to the user');
  });

  it('refuses multi-statement input', async () => {
    const context = createFakeToolContext();
    const table = await loadAccounts(context);
    await registry.call(
      'process_data',
      { table_name: table, cols: ['id'], rationale: 'ids' },
      context,
    );
    const result = await registry.call(
      'execute_query',
      { table_name: table, query: `SELECT 1; SELECT 2`, rationale: 'two' },
      context,
    );
    expect(text(result)).toContain('only one statement');
  });

  it('tells the model to reload after a query timeout tore the tables down', async () => {
    const context = createFakeToolContext();
    const table = await loadAccounts(context);
    await registry.call(
      'process_data',
      { table_name: table, cols: ['id'], rationale: 'ids' },
      context,
    );
    context.scratch.failNextWith('timeout', 'the runner was killed');
    const result = await registry.call(
      'execute_query',
      {
        table_name: table,
        query:
          'WITH RECURSIVE bomb(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM bomb) SELECT count(*) FROM bomb',
        rationale: 'count them',
      },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('2000 ms budget');
    expect(text(result)).toContain('load the data you need again');
  });

  it.each([
    ['ops_limit', ETL_OPERATION_LIMIT_MESSAGE],
    ['worker_crashed', 'stopped unexpectedly'],
    ['global_cap', 'load the data you need again'],
  ])('turns the %s failure into hosted-Ramp guidance', async (reason, expected) => {
    const context = createFakeToolContext();
    context.scratch.failNextWith(
      reason as 'ops_limit',
      'the scratch database was evicted to stay inside MAX_SCRATCH_DBS',
    );
    const result = await registry.call('load_accounts', { rationale: 'load them' }, context);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(expected);
  });

  it('explains an unknown table, an unprocessed table and an unknown column', async () => {
    const context = createFakeToolContext();
    const table = await loadAccounts(context);

    const unknownTable = await registry.call(
      'process_data',
      { table_name: 'load_accounts_99999999', cols: ['id'], rationale: 'oops' },
      context,
    );
    expect(text(unknownTable)).toContain('no table named');

    const unknownColumn = await registry.call(
      'process_data',
      { table_name: table, cols: ['nope'], rationale: 'oops' },
      context,
    );
    expect(text(unknownColumn)).toContain('not advertised');

    const unprocessed = await registry.call(
      'execute_query',
      { table_name: table, query: `SELECT * FROM "${table}"`, rationale: 'early' },
      context,
    );
    expect(text(unprocessed)).toContain('no processed table named');

    const cleared = await registry.call(
      'clear_table',
      { table_name: 'load_accounts_99999999', rationale: 'oops' },
      context,
    );
    expect(text(cleared)).toContain('no table named');
  });

  it('refuses an empty cols list at the schema and again in the handler', async () => {
    const context = createFakeToolContext();
    const table = await loadAccounts(context);
    const viaSchema = await registry.call(
      'process_data',
      { table_name: table, cols: [], rationale: 'nothing' },
      context,
    );
    expect(viaSchema.isError).toBe(true);
    expect(text(viaSchema)).toContain('did not match its schema');

    // Ramp OSS defect #10: an empty `cols` produced a SQL syntax error. The handler explains it
    // even when it is called directly, which is what makes the schema rule a second line and not
    // the only one.
    const handler = registry.handlers.process_data;
    expect(handler).toBeDefined();
    const direct = await handler!(
      { ...context, tool: 'process_data', rationale: null, rationale_truncated: false },
      { table_name: table, cols: [] },
    );
    expect(text(direct)).toContain('cols was empty');
  });
});
